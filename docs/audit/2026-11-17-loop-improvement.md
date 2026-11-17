# 自我进化闭环改进（第二轮，2026-11-17）

本文件记录在上一轮 Guard 精确化 / 失败归因 / 兼容性修复之上的闭环改进、真实隔离宿主
演练结果与仍然阻塞的部分。上游统计口径与 stable 插件审查见
[统计口径核对](./2026-11-17-stats-reconciliation.md)；第一轮审计见
[端到端审计](./2026-11-17-self-evolution-audit.md)。

## 1. 改动范围

不变的边界：共享经验 schema/身份、stable 身份、宿主兼容、三端消费、重验证与回滚。
没有新增插件、没有后台轮询、没有新表、没有改 Desktop/ACP/Web 的授权边界。

### 1.1 有界的成功/失败分母

- `lib/experience-collector.js`：进程内按目标累计 `attempts`/`successes`（最多 256 个目标，
  LRU 淘汰；每次触及重新插入）。失败写入时附带
  `metrics: { attemptsSinceFailure, successesSinceFailure }` 并清零。
  因此每个失败自带"距离上一次失败"的真实分母，而**不**为每次成功写一行：
  存储增量与失败数同级，内存上限是 256 个目标的两个整数。
- `lib/shared-experience.js`：`recordFailure` 接受 `metrics` 并随事件写入。
  指标键不属于知识身份，冻结 schema-1 opener 的 `knowledgeKey` 不变。
- `lib/experience-recall.js`：把 `effectStats.metrics` 的有界标量
  （`sum`/`count`/`last`，最多 6 个）投影到记录上，供规划器读取。
- `lib/experience-plan.js`：候选带 `observedAttempts`、`observedSuccesses`、
  `observedFailureRate`、`rateBasis: "observed-window" | "failure-count-only"`。

### 1.2 归属分类

`failureOrigin()` 按记录到的失败模式把目标分为：

| origin | 含义 | 是否生成候选 |
| --- | --- | --- |
| `caller-input` | 参数、编辑上下文、陈旧 revision 等调用方错误 | 否（`rejected: caller-input`） |
| `capability-gap` | 调用了未安装的能力（UNKNOWN_TOOL 等） | 是 |
| `host` | 宿主 guard / trust root 拒绝 | 是（但明确标注不可由本仓库直接修） |
| `environment` | 超时、取消、忙、限流 | 是 |
| `unknown` | 无足够信息 | 是，但标 `attribution: unattributed` |

`attribution: "unattributed"` 的候选**不会**声明 `benefitModel.kind = "workflow"`，
因此不能进入需要工作流收益的晋升路径；它仍然保留在计划里，让所有者看到并修复信号，
而不是把历史计数静默丢掉。

### 1.3 收益来源与门禁

- `compareProbeRuns` 新增 `benefitKind`、`workflowBenefit`、`improvedAbsentTargets`、
  `improvedMeasuredTargets`：
  - 目标步骤在 baseline 中是 `E_EVOLUTION_PROBE_CAPABILITY_ABSENT` 的声明缺失记录 →
    `capability-self-test`；
  - 目标步骤在 baseline 中真实执行并失败 → `workflow`。
- `measure()` 的探针派生指标新增 `probeWorkflowBenefit`，`deriveProbeObservation`
  保留 `benefitKind`。
- `promotionGates` 新增**按声明生效**的 `workflowBenefit` 门禁：只有当
  `proposal.benefitModel.kind === "workflow"` 时才要求
  `probe.comparison.benefitKind === "workflow"` 或 `evidenceKind === "comparative-workload"`。
  历史实验/未声明收益模型的实验保持原 8 项门禁，门禁对象形状不变。
- `propose`/`desktop-task-protocol`/`desktop-task-host` 透传可选的
  `benefitModel: { kind: "workflow" | "capability", metric? }`（有界，两值）。
- 规划器为**有归属的工具失败目标**生成 `benefitModel: { kind: "workflow", metric: "failureRate" }`。

### 1.4 Desktop 宿主不再虚构收益

`lib/desktop-task-host.js` 之前把
`solvesProblem: true`、`beforeMetrics: { errors: 1 }`、`afterMetrics: { errors: 0 }`、
`repeatable/regressionPassed: true` **硬编码**进 `evolution_measure`，而样本只验证
"候选工具返回期望值"。现有 `exp-mwhq9zod-1-398ad801` 的
`benefitEvidence` 原文即 "the target tool run_code_preflight was absent before the trial
and every registered-tool sample matched its expected value"。

现在宿主只报告它真正测到的东西：`solvesProblem: false`、
`evidenceKind: "capability-self-test"`、`metrics: { capabilitySamples }`、
`repeatable/regressionPassed: false`、不含 before/after。若门禁不通过，宿主在请求
所有者批准**之前**以 `E_DESKTOP_BENEFIT_UNPROVEN` 停止，并记录缺失门禁。
能力自测不再被描述成工作流收益。

## 2. 真实隔离宿主演练（0.2.2-rc.3）

命令（隔离 runtime/home，不触碰正式 `DSH_HOME`）：

```sh
npm run release:pack
node scripts/acceptance/run-host-acceptance.mjs --host 0.2.2-rc.3 --no-hmr \
  --experience-evolution --out /tmp/acceptance-experience-20261117b.json
```

结果：`ok: true`，25 个步骤全部通过，其中实验链路 4 个阶段：

| 阶段 | 结果 | 证据 |
| --- | --- | --- |
| `experiment-seed`（有效改进） | 晋升 stable | `exp-mwkqbz8z-1-b2f3fdd5`；问题 `tool probe healthcheck`（4 次）→ 基线/候选探针 `benefitKind: workflow`、`workflowBenefit: true` → 8 项门禁 eligible → 所有者确认 → canary-observing → stable |
| `experiment-invalid`（无效改进） | 拒绝 | `exp-mwkqc1u0-1-0f5d61fd`；`realBenefit: false`、`measuredEvidence: false`、`eligible: false`、决策 `no-benefit`，拒绝原因 `promotion-gate` |
| `experiment-restart`（重启后的复用） | 通过 | 同一 `experimentId` 的 stable 事实在新进程中可读 |
| `experiment-regression`（退化改进） | 拒绝 | `exp-mwkqc58t-1-ac50b69f`；决策 `regression`，拒绝原因 `domain-evaluator-rollback` |

另外 `promotion-promote` / `promotion-restart-and-rollback` / `promotion-verify` /
`doctor-final` 全部通过，覆盖晋升、重启恢复、回滚与健康检查。

证据文件：[docs/evidence/experience-evolution-0.2.2-rc.3-20261117.json](/Users/ryukeili/.t3/worktrees/dsh-evolution/t3-eab7f545-2c7396175bf7c292/docs/evidence/experience-evolution-0.2.2-rc.3-20261117.json)
（tarball 来自未提交工作树的内容构建；它不是 `release/` 固定点，不在发布字节内）。

**这次演练证明的是**：在真实隔离宿主里，发现问题 → 归因 → 生成候选 → 前后对照 →
判断 → 晋升/拒绝 → canary → 重启复用 → 回滚的链路可用；无效与退化候选会被拒绝；
有效候选的 `benefitKind` 是 `workflow`（目标步骤在 baseline 中真实执行并失败），
不是声明缺失的自指样本。

**这次演练没有覆盖的**：`benefitModel.kind = "workflow"` 的新门禁（该探针的 proposal
没有声明收益模型，走的是历史 8 项门禁），以及 Desktop 宿主的
`E_DESKTOP_BENEFIT_UNPROVEN` 路径（隔离验收不启动 Desktop 任务通道）。
这两条由单元/回归测试覆盖：`test/benefit-provenance.test.mjs`、
`test/desktop-task-host.test.mjs` 与 `test/experience-evolution-lifecycle.test.mjs`。

## 3. 仍未解决 / 阻塞

1. **Desktop 计划契约没有"代表性工作负载"字段。** Desktop 宿主只能跑
   `verification.samples`（每个样本都被协议强制为 `sample.tool === targetTool`）。
   因此经由 Desktop 的新能力晋升，证据必然是能力自测；本次修复让宿主诚实标注并
   在门禁不通过时停止，但没有伪造工作流收益。要恢复 Desktop 的正向晋升，需要给
   计划契约增加"baseline 用既有官方路径、candidate 用新工具"的对照工作负载，
   并由门禁比较任务成功率/失败率/耗时。这是下一步的结构性工作，本次未做。
2. **生产下线未执行。** 三个 stable 插件的保留/下线结论见统计口径核对文档；
   `run_code_diagnose` 与 `run_code_preflight` 建议下线，但生产下线需要所有者授权，
   本次只给出命令与依据。
3. **成功分母是进程内窗口。** `successesSinceFailure` 在进程重启时清零；它是
   "距离上一次失败"的真实区间，不是全生命周期总量。规划器用
   `rateBasis: "observed-window"` 明确标注，不把窗口速率冒充全量速率。
4. **历史记录不迁移。** 23 条通用失败行仍是 `HOST_OPERATION_FAILED`；新记录才带真实码。
   不做猜测式回填。
5. **宿主 composition guard 的误杀仍在仓库外**，本次不改宿主。

## 4. 复核命令

```sh
NODE_OPTIONS=--max-old-space-size=4096 npm test
npm run pack:check
node scripts/acceptance/run-host-acceptance.mjs --host 0.2.2-rc.3 --no-hmr --experience-evolution --out <path>
```
