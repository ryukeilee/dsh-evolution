# 经验驱动的 Cordis 插件自我进化（Propose–Probe–Compose）

基线：main `8effd86`（含 PR #45 统一经验采集与共享存储），Evolution 0.2.3。本设计只增强 Evolution 自身的进化能力；不改 DSH 官方源码，不建第二套运行时、经验库、调度器或晋升系统。

## 目标与边界

日常 Desktop / ACP / Web 继续只积累经验（PR #45 的采集与检索不变）。用户主动要求进化时，一次显式流程完成：

```
经验检索 → 候选发现（plan）→ Proposal → 基线 probe → Cordis Trial
→ 候选 probe → 测量（orchestrator 派生指标）→ 决策（采纳/无效/回归/证据不足）
→ Revert 或 Promotion 候选 → 结构化结论写回共享经验 → 下一轮复用
```

仍由具备官方 Runner 的 Desktop 承担完整 Trial / Promotion；ACP / Web 只采集与检索。没有定时器、后台模型回合或常驻服务：`evolution_plan`、`evolution_probe`、`evolution_measure` 都只由显式工具调用触发。

## 复用而非重建

| 能力 | 复用的现有实现 | 本次只加的接缝 |
| --- | --- | --- |
| 经验检索 / 评分 / 去重 / 有界输出 | `lib/experience-recall.js` | 记录投影增加 `decision`（来自 `lastStatus`） |
| 共享经验 SQLite、并发、隐私、去重 | `lib/shared-experience.js`（PR #45，schema v1 不变） | `discover()` 有界发现、`recordConclusion()` 结论写回、`findConclusions()` 同条件查询 |
| 经验发现与排序（纯逻辑） | 新 `lib/experience-plan.js` | 只做分组、证据汇总、确定性评分与拒绝理由，无 I/O、无模型 |
| Trial / Measure / Revert / Promotion / Canary / 恢复 | `lib/orchestrator.js` | `probe` 阶段、measure 派生指标、决策分类、结论发布 |
| 指标比较与回归判断 | `lib/dockyard-domain/evaluator.js` 的 `measuredMetricBenefit` / metric rules | probe 派生的 before/after 走同一套指标规则 |
| 事件桥 / 归档 / 证据 sidecar / 失败学习 | `lib/orchestrator.js` 既有持久化链 | `observation.probe` 与 `record.decision` 的条件字段 |

新增的 `lib/experience-plan.js` 是纯函数模块，不保存状态、不调度、不执行；它把已有的知识行变成一份有界、可复核的候选清单，不构成第二个决策引擎。

## Propose：经验驱动的目标选择

`evolution_plan`（只读，owner 触发）读取两处已有事实：

- `sharedExperience.discover()`：统一共享经验里最近的 canonical knowledge 行（失败事实、已解决事实、实验结论），有界窗口并如实报告 `truncated`；
- 本地 durable failure memory（`collectFailureMemoryExperience` 同源投影）。

`planEvolutionCandidates()` 按问题身份（`scope`，即 target）分组：反复出现且未被更新解决覆盖的失败才是候选；已解决目标进入 `rejected: already-resolved`；证据不足进入 `rejected: insufficient-evidence`。候选按频率、时效、失败面广度、回归计数、证据引用五个归一化项确定性评分，并给出：

- 问题与证据（occurrences、first/last seen、failureModes、evidenceRefs）；
- 已知根因或“需要新假设”标记（同条件下的 `no-benefit` / `regression` 结论进入 `provenIneffective` / `requiresNewHypothesis`）；
- 为什么 Cordis 插件能解决（按 target 类型给出官方注册路径）；
- 预期改善与可观察验收指标（`successRate` / `errorCount` 等 + `probeControlStable` 正确性对照）；
- 失败与回滚条件、维护风险。

没有可靠候选时返回 `none` 与原因，不创建实验。`focus` 只收紧范围，`minOccurrences` 只能提高，`limit` 只能收紧。模型仍负责把候选写成具体插件方案（`evolution_propose` 的 `strategy` / `rootCause`）。

## Probe：真实对照实验

`evolution_probe` 由 Evolution 自己执行固定场景，不需要模型或外部脚本提供指标：

1. `baseline` 只允许在 `proposed` 状态调用，即 Trial 首次修改运行时之前；
2. `candidate` 只允许在 `trial` / `trial-awaiting-approval` 状态调用；
3. 两个阶段都通过官方 `ctx.tools.execute({calls})` 真正调用目标/对照工具；场景 digest（步骤、参数、repetitions、DSH/Cordis/Evolution 版本）必须逐字一致；
4. 记录每条真实执行的 `isError`、分类错误码、返回值 digest（不保存返回值正文），并自行聚合与比较。

比较规则：目标步骤必须从失败变为成功（`benefit`），任一阶段成功数下降即 `regression`；对照步骤必须在候选阶段仍成功且 value digest 不变（`controlStable`）。重复执行结果全一致才算 `repeatable`。对照实验固定同进程、同 profile、同版本、同场景；跨环境的等价性不被假设。

### 执行安全边界

probe 不复刻工具执行器、沙箱或权限系统，只复用官方工具定义里已有的 truthful 信号：`isConcurrencySafe(args) === true` 表示该工具加入官方并行调度契约，其文档要求不修改父级拥有的状态，共享状态必须容忍并发或 fail closed。据此：

- 默认只允许**显式 opt-in 且按本次参数判定安全**的工具步骤；`write`、`edit`、`apply_patch`、`bash`、`terminal` 等没有该声明的工具一律在执行前拒绝（`E_EVOLUTION_PROBE_UNSAFE_STEP`）；
- 未注册的工具、保留的 `run_code` 传输与 `evolution_*` 生命周期工具一律拒绝——它们的行为无法在 probe 前被证明；
- 委派/后台执行入口（真实注册名 `subagent`、`subagent_fork`、`workflow`、`send_message`、`job_*`、`schedule_*`、`list_*`、`interrupt_agent`）、`plugin_manager`、`present`、`ask_user_question`、goal 工具与 `working_directory`、网络工具（`web_*`）、session/transcript 读取（`session_*`）同样拒绝。`isConcurrencySafe` 只是官方并行调度契约，不保证调用在返回前完成：真实 `subagent` 声明它并立即返回 activation，后台工作仍可执行 shell/write，所以不能只信这个标志；
- baseline 和 candidate 使用同一份场景与同一套安全检查，任何阶段都不会因为“已挂载 Trial”而放宽；
- 拒绝发生在任何官方调用之前，因此不会产生目标副作用；超时取消、未结算保留 claim、单 Trial 与恢复校验保持原语义。

代价是 probe 不能直接观察“Trial 新注册的工具”：目标能力必须通过 probe 自己的、已 opt-in 的安全 dispatcher 工具暴露（真实宿主验收就是这样做的）。这是有意的保守边界，而不是新增的权限系统。

## Measure：只接受派生的证据

`evolution_measure` 在 `record.probe` 成对存在时，用 probe 的原始样本派生 `beforeMetrics` / `afterMetrics` / `sampleCount` / `observationWindow` / `solvesProblem` / `repeatable` / `regressionPassed`，并覆盖调用方填写的同名字段；调用方仍提供 probe 无法观察的进程事实（reversible、cleanupEvidence、orphanResources、风险文本）。`observation.probe` 保存场景、版本、双方聚合、逐步对照与样本 digest，进入 latest observation / archive / evidence sidecar。

8 项 `promotionGates` 与 `domain evaluator` 的语义完全不变：probe 只是给已有门禁提供由运行时计算而非自报的证据。没有 probe 的旧路径保持原有的宽松行为，不因本次改动变 strict。

## Compose：四类决策

`classifyExperimentDecision()` 产生 `benefit` / `no-benefit` / `regression` / `insufficient-evidence`：

- 回归优先（probe 回归或 `regressionPassed === false`）；
- 有完整派生证据且正确性对照通过才是 `benefit`，但仍须 8 门禁 eligible（否则降为证据不足）；
- probe 证明无改善是 `no-benefit`；只有 baseline、没有候选证据是 `insufficient-evidence`；
- 决策只记录，不参与任何门禁判定；`promotionGates` 仍是生产权威。

决策写入点：measure、promotion 门禁拒绝、domain evaluator 回滚否决、canary 回滚、stable commit、revert。等待 owner 确认的返回也带决策，不写生产。

## 长期学习与版本适用性

一次实验结束（revert 证明恢复、promotion 门禁拒绝、canary 回滚或 stable commit）时，把结构化结论写回统一共享经验：

```
{ experimentId, target(问题身份), strategy, strategyFingerprint, rootCause,
  failureMode, decision, metrics(实测 delta), applicability:{dsh,cordis,evolution}, occurredAt }
```

结论作为 canonical knowledge 的一行（`type: experiment-conclusion`，`sourceCollection: learnings`），复用现有身份、去重、状态机与 `REGRESSED` 降级：同一（问题、策略、根因、版本）的新 `no-benefit` / `regression` 会把旧 `adopted` 降级；不同版本是不同身份，互不降级；`reverted-unconfirmed` / `insufficient-evidence` 不伪造成功也不否定旧成功。`strategy` 以对象形式保存，版本数字不会被知识身份归一化抹掉；版本缺失写 `unknown`，`unknown` 永不等于任何版本，因此不会被当作“同条件”。

`findConclusions()` 按 target + 三项版本 + strategy 指纹做有界查询；`evolution_propose` 对“同 target、同适用条件、同 strategy 指纹且已证明无效”的提案返回 `reason: "strategy-already-proven-ineffective"` 并附旧证据。换了假设（不同 strategy 文本）或换了适用版本即可继续，不需要降低门禁。

## Desktop / 打包宿主的版本身份

版本只从官方包清单读取，不从命令行参数、环境变量或相邻包猜：

- **Evolution**：本 bundle 自己的 `package.json`；
- **DSH**：精确匹配 `name === "@deepseek-ai/dsh"` 的包清单。Desktop 的 Electron argv 指向 `@deepseek-ai/dsh-desktop-host/lib/cli.js`，真实 host 是该 entry 的**同级** `@deepseek-ai/dsh`；只按 `@deepseek-ai/dsh` 前缀匹配会把 desktop-host/tools 的版本误当成 DSH 版本；
- **Cordis**：host 包同级或嵌套的官方 `@deepseek-ai/cordis`；pnpm store 布局逐级向上查找；
- Electron 打包布局下，argv 不暴露模块入口时使用 Electron 官方的 `process.resourcesPath`，在 `app.asar/dsh/node_modules/@deepseek-ai/dsh` 与 `app.asar.unpacked` 中查找精确包；仍找不到就保持 `null`/`unknown`，绝不猜测或降低匹配门槛。

`evolution_plan`、`evolution_probe`、`recordConclusion` 与 `findConclusions` 全部调用同一个 `applicability()`，因此同一轮实验、结论检索和下一轮提案共享同一个 `{dsh, cordis, evolution}` 三元组。真实 Desktop Electron 环境（Electron 44.7.0 / Node 24.21.0，DSH 0.2.2-rc.1 / Cordis 4.1.0 / Evolution 0.2.3）的只读验证记录在 `docs/evidence/desktop-version-detection-0.2.2-rc.1.json`。

## 运行期与安全不变量

- 仍是“单进程单 Trial、基线只捕获一次、未证实清理保留 claim 且可重试”；probe 不改变 Trial/Revert/Promotion 的状态机，只在 `proposed` 与 `trial` 两个既有状态上增加只读执行证据。
- 8 项 Promotion 门禁、owner confirmation、官方 Include、canary、跨重启恢复与回滚不变；没有新增自动批准路径。
- probe 只保存工具名、role、`isError`、分类码、value digest 与耗时，不保存工具返回值或错误正文，遵守脱敏边界。
- 结论写回失败只记 warning，不改变已经发生的 Revert / Promotion 结果。
- 不修改 DSH 官方源码、安装目录或 `node_modules`；进化产物仍是 Cordis 插件（唯一恢复路径是官方 disposer）。
- 持久化目录不变：`~/.dsh/storages/evolution` 与 `~/.dsh/storages/evolution-experience`；共享 SQLite schema 仍为 v1，旧库可直接打开。

## 已知限制

- 结论身份包含 strategy 对象与 rootCause：同 target/strategy 但 hypothesis 文本不同会被视为不同假设而分流；这是刻意行为，避免把新证据合并到旧结论。
- 共享 store 没有 retention：版本对与假设增多会累积知识行；容量回收仍只走显式 `evolution_maintain` 的既有语义。
- probe 的对照是同一进程内的配对执行，能证明当前环境下的行为差异；它不能证明跨机器、跨版本或长时间负载下的等价性，这些需要新的实验。
- `results` 只保留结论与实测 delta；完整逐样本证据在实验归档的 observation / sidecar 中，跨会话不重放为新的证据。
- 本机/CI 的验收只在声明的宿主版本上执行；未声明的宿主版本仍按 doctor 的既有策略阻断。
