# 自我进化链路端到端审计与价值闭环（2026-11-18）

本轮基于 `ryukeilee/dsh-evolution` 当前正式版 `v0.2.11`（`origin/main` = `83bb24c`，工作分支
`t3/evolution-value-audit`）的真实代码与生产证据。此前 2026-11-17 的三份审计已经落地了
真实失败码采集、成功/失败分母、失败归因和 Desktop 配对工作负载；本轮复 audit 时确认这些
修复都已在当前代码中，因此只处理仍然存在的、证据明确的缺口。本文只陈述本轮实际读取与
执行的内容，不引用未重跑的历史验收数字。

## 1. 完整调用链现状

| 环节 | 当前实现 | 本轮结论 |
| --- | --- | --- |
| 失败采集 | `lib/experience-collector.js` 的 `tools/result` / `agent/error`；同步 COMMIT 回执 | 有界、只写元数据。**自主观察入口读错字段**（已修，见 §2.1） |
| 经验归因 | `failureOrigin()` + `derivedFailureMode()`；`caller-input` 拒绝、`host` 标注不可修 | 归因链本身有效；但两个观察入口曾产出不同 code，已统一 |
| 候选排序 | `lib/experience-plan.js` 的 `scoreOf()` | 原先只按历史次数/时效排序，观测失败率只是输出字段（已修，见 §2.3） |
| 策略生成 | `plan()` 只读发现，`benefitModel` 为 `workflow` 时声明工作流目标 | 未发现需要改动的问题 |
| Desktop 对照 | `verification.workload` + `evolution_probe` baseline/candidate；`compareWorkflowProbeRuns()` | 真实对照有效；但调用方可声明 `capability` 覆盖强制模型（已修，见 §2.2） |
| 收益门禁 | `promotionGates()` 的 8 项 + `workflowBenefit`；`measure()` 只信任自身计算的 probe 比较 | 门禁本身不可被自报指标伪造；覆盖路径已修，历史实验兼容未变 |
| 审批 / Canary / 回滚 | 显式所有者确认、`canary`、原子 journal、目标锁 | 本轮未改动，保持原语义 |
| 三端复用 | `promoted-sharing` / `promoted-consumer`，按 profile 挂载 | 生产索引确认 3 条记录均为 `benefit`，ACP/Web 消费事实未变 |
| 生产效果反馈 | 结论写回共享经验；**没有持久化的工作流调用计数** | 结构性边界，见 §4；本轮未制造第二套持久化 |

关键判断：安全性（门禁、审批、回滚、隔离）没有被本轮发现的问题破坏；被破坏的是
**输入信号的一致性**（失败码）、**目标选择**（按次数而非失败率）和**收益声明的契约**
（workload 被降级），以及**成果价值的可见性**（审计无法区分安装/使用/收益）。

## 2. 已确认缺陷与修复

### 2.1 自主观察入口读错失败码（已修）

- 原代码：`lib/registration.js:578,592` 读 `result.code`；权威采集器 `lib/experience-collector.js:20`
  读 `result?.error?.info?.code ?? result?.error?.code ?? result?.code`，`lib/orchestrator.js:2894`
  的 probe 也读同样的嵌套字段。宿主的官方形状是 `ToolFailure { message, info? }`，顶层
  `result.code` 在官方路径上不存在。
- 后果：同一个失败在自主观察者里退化为 `TOOL_<name>` 或 `HOST_OPERATION_FAILED`，与经验库里
  的记录得到不同归因和不同模式识别；`observedFailureRate` 的社会分母也因此不稳定。
- 修复：把读取器下沉到纯边界 `lib/error-boundary.js:508 toolFailureCode()`，两个入口共用；
  `experience-collector.js` 保留同名 re-export，既有导入路径不变。修复位置：
  `lib/registration.js:583,598`。
- 证据：`test/observer-event-contract.test.mjs` 新增用官方 `error.info.code` 形状的用例，断言
  观察到 `CODE_RUN_FAILED` 而不是 `TOOL_BASH`；旧的顶层 `code` 形状仍兼容。

### 2.2 Desktop workload 的 workflow 门禁可被降级（已修）

- 原代码：`lib/desktop-task-host.js` 构造 `evolution_propose` 参数时连续两次展开 `benefitModel`。
  第二次无条件覆盖第一次：即使 `plan.verification.workload` 存在（真实配对工作负载），只要调用方
  声明 `plan.proposal.benefitModel.kind = 'capability'`，最终提案就变成 `capability`。
- 而 `lib/orchestrator.js:2665-2672` 只在 `proposal.benefitModel.kind === 'workflow'` 时才把
  `workflowBenefit` 计入晋升证据。于是真实工作负载实验可以用能力自测通过门禁——这正是
  2026-11-17 审计里"探针自指"问题在 Desktop 路径上的残留形式。
- 协议允许这种组合：`lib/desktop-task-protocol.js:199-201` 接受 `workflow|capability`，
  `:225` 独立接受 `verification.workload`，没有互斥校验。
- 修复：删除第二次展开；有 workload 时强制 `{kind:'workflow'}`，无 workload 时才透传调用方声明。
  门禁本身未改，历史实验（无 benefitModel）仍走原 8 项。
- 证据：`test/desktop-task-host.test.mjs` 的 workload 用例现在显式声明 `kind:'capability'`，
  并断言提案实际收到的仍是 `{kind:'workflow'}`。
- 补充说明：门禁本身不可被 `measure()` 调用方自报指标伪造——`observation.probe` 与
  `beforeMetrics/afterMetrics/solvesProblem` 由 `measure()` 从原始执行重算并覆盖
  （`lib/orchestrator.js:5904-5915`），`workflowBenefit` 只认 probe 比较的 `benefitKind`。

### 2.3 候选排序忽略观测失败率（已修）

- 原代码：`lib/experience-plan.js:312` 的 `scoreOf()` 只用出现次数（.35）、时效（.20）、广度（.15）、
  回归（.15）、证据（.15）；`observedFailureRate` 计算了却没有进入排序。
- 生产证据（本轮只读重放 `docs/audit/replay/session-evidence.mjs`）：489 个会话、17,146 次工具结果中
  `bash` 94/9,987（0.94%），`run_code` 122/3,039（4.01%）。两者失败数接近（94 vs 122），
  但失败率相差约 4 倍；按次数排序会把"几乎总是成功的高频工具"与"仍然频繁失败的工具"并列。
- 修复：当 `rateBasis === 'observed-window'` 且观测尝试数 ≥ 5 时，用观测失败率替换频率项；
  没有观测窗口的历史记录沿用原公式，分数逐字节不变。
- 证据：`test/experience-plan.test.mjs` 新增 A/B 用例（20 次失败但 1000/999 成功 vs 6 次失败但 8 中 2
  成功），断言高失败率候选排到第一；另用固定分数 `0.6683` 钉住历史公式未变。

### 2.4 稳定插件缺少价值维度（已修）

- 原代码：`lib/self-evolution-review.js` 只分类可用性与兼容性（active/incompatible/restart-required…），
  无法回答"是否进入日常工作流"或"是否产生过生产收益"。
- 修复：新增只读、有界的价值评估。`readPublishedPluginReview({ paths, host, usage })` 接受可选的
  外部证据投影（不启动扫描、不新增持久化），逐记录输出 `value`：
  `installed`（consumer 状态）、`invoked` / `workflowInvocations`、`experimentBenefit`（发布记录中的
  `stable.decision === 'benefit'`，无需新数据源）、`productionBenefit`（显式证据）、`tier` 与理由。
  没有 usage 输入时全部诚实标为 `usage-unknown`，不推断。
- 淘汰建议只在**两个独立事实**同时成立时给出：没有持久化的工作流调用，且能力被标注为
  `self-contained`（输入由调用方自填、没有独立数据源）；仅有零调用绝不判定无用。建议是
  `requiresOwnerAuthorization: true` + `reversible: true` 的有界条目，附带可复用的
  `shared-plugins.mjs disable` 命令；审计本身不执行停用、删记录或清历史。
- 证据：`test/self-evolution-review.test.mjs` 新增 3 个用例，覆盖 usage 缺失、可恢复淘汰建议、
  以及有工作流使用或生产收益证据时不给淘汰建议。

## 3. 三个 stable 插件的保留价值（只读证据，未改生产状态）

生产 `shared-plugins/published.json` 当前 3 条记录，均为 `stable.decision = benefit`：

| 插件 | 发布 id | 用户会话调用 | 验证调用 | 实验收益 | 生产收益 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| `readonly_git_file` | `evolution-promoted-af973a3eea01` | 5 | 有 | 有 | 未证明 | 保留：唯一被日常使用，解决宿主 guard 文本回退误杀 |
| `run_code_diagnose` | `evolution-promoted-e82a216992bb` | 0 | 有 | 有 | 未证明 | 下线候选：输入是调用方自填的整数，不读任何数据源 |
| `run_code_preflight` | `evolution-promoted-2794ab16d2b3` | 0 | 有 | 有 | 未证明 | 下线候选：人工前置工具；本轮重放 24 个语法形态程序仅 13 个被其规则标记 |

口径：调用数只统计持久化会话日志中的 `tool/call`（`docs/audit/replay/session-evidence.mjs`），
共享经验库的失败记录和晋升探针样本属于验证流量，不计入使用量。三者的源码形态与
2026-11-17 审计一致（诊断器是纯换算器、preflight 是 6 条正则、readonly git 走 `ctx.shell`）。
本轮**没有**执行 `shared-plugins disable`、没有改 profile、没有清除历史经验；下线需要所有者授权。

## 4. 设计边界与尚未验证的问题

1. **没有持久化的工作流调用计数。** 采集器只在进程内累计成功分母，重启即清零；所以运行时的
   `evolution_plan` 在缺少外部证据时会报告 `usage-unknown`。本轮没有为此新建第二套持久化或
   后台扫描；§3 的判断来自一次性只读脚本，没有被伪装成运行时数据。
2. **宿主 `dsh-composition-guard` 的误杀仍在仓库外。** 本轮不改宿主，也不靠包装工具制造收益。
3. **真实模型自主规划与工具选择未验证。** 三端挂载/调用不等于模型会在日常任务里主动选择这些
   成果；`readonly_git_file` 的 5 次调用是已观察到的使用事实，但不足以证明"自主规划"这一能力。
   本轮不以固定 fixture 替代生产证据。
4. **未执行真实隔离宿主验收。** 本轮改动都是纯逻辑（失败码读取、提案参数、排序、只读评估），
   没有新增宿主接口依赖，也没有改晋升/回滚/Canary 语义；相关行为由聚焦回归和全量单测覆盖。
   若后续需要重跑晋升/回滚端到端，必须使用隔离 runtime/home，本轮未触发。
5. **共享经验库仍为 schema 1**，本轮未迁移（显式离线操作，不在本任务范围）。

## 5. 复现

```sh
NODE_OPTIONS=--max-old-space-size=4096 node --test \
  test/observer-event-contract.test.mjs test/experience-attribution.test.mjs \
  test/desktop-task-host.test.mjs test/experience-plan.test.mjs \
  test/self-evolution-review.test.mjs
node docs/audit/replay/session-evidence.mjs
node docs/audit/replay/preflight-replay.mjs
```
