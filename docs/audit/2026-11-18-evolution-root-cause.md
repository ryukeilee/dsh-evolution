# 自我进化路线的根因复核与修复（2026-11-18）

本轮以论文原文（arXiv:2608.25512v1）、本仓库 v0.2.11 代码、PR #69/#70、三个已发布 stable
记录的真实证据、以及 495 个持久会话日志的只读统计为依据，回答一个问题：**为什么当前 Evolution
能完成实验、晋升与共享，却主要产出与原生工具重叠、无法改善真实开发工作的插件。** 本文只陈述
实际读取、执行和测到的内容；没有执行过的验证不写成结论。

## 1. 结论

1. **论文提供的是组合机制与安全性质，不提供进化策略。** revertible effects（`ctx.effect`、
   `fiber.dispose`）、reactive coeffects（`inject`/`provide`、`ctx.get/set/isolate/intercept`）、
   context paradigm 与 loader/HMR 都有定义与定理支撑（§3、§4、§5 表 2）；但“自我修改是否算改进”
   ——fitness、reward、gate、canary、回滚策略、试验设计——论文没有定义。§1.2.2 只给动机，
   §8 把 self-evolving agent harness 明确列为 **future validation**，§5.3 的 Koishi 验证是
   观察性的、没有定量对照。把这些当作“论文已证明自进化有效”是过度解读。
2. **DSH 侧真正缺的不是组合能力，而是“改进”的证据链。** 仓库已经把论文的时间/空间两类能力
   用满了：Trial 用官方 `define/run/stop/undefine` 并比较运行时基线（时间可组合），晋升走官方
   Include `insert/refresh/EntryTree.resolve`（空间可组合），8 项门禁 + 显式确认 + canary +
   回滚 + 跨端共享都保留。断点在**观测、目标选择与收益验证**这三处，不在组合执行。
3. **生产证据表明三个 stable 成果的“收益”全部由构造保证，没有一条来自真实工作流。**
   `af973a3eea01` 的 probe 只有 1 个 target、**0 个 control**，baseline 两次执行都是
   `E_EVOLUTION_PROBE_CAPABILITY_ABSENT`；`e82a216992bb` 与 `2794ab16d2b3` **没有 probe**，
   before/after 是调用方自报；三份计划里 `samples[*].tool === targetTool` 是 5/5，整个 evolution
   存储中 `workload`、`benefitKind`、`workflowBenefit`、`benefitModel` 均 **0 次**出现。
4. **真实模型不会替我们补上这一步。** PR #70 在隔离真实 Desktop + ACP + 真实模型上跑了三对
   自然语言会话：模型 **0 次**选择已晋升能力，六次都走 shell 兜底并正确完成。工作负载级
   10/15 → 15/15 是真的，会话级收益为零。根因是配对工作负载只能表达“同一参数、同一结果字段的
   工具替换”，证明的是候选优于它包装的 `read`，而模型真实走的是 `read` → shell 兜底序列。
5. **兜底路径无法用现有 probe 复现。** 本会话对 495 个会话、17,125 次工具调用的只读统计里，
   `read` 长行截断 12 次 / 8 个会话，恢复工具是 `run_code`（6 次）与 `bash`（1 次）等；
   `assertProbeSafety` 只接受官方 `isConcurrencySafe(args) === true` 的工具，并显式拒绝
   `run_code` 与写/shell/委派入口。因此“候选优于真实完整路径”不可能由确定性 probe 证明，
   只能由真实配对会话证明。
6. **本轮修复**：把 workflow 收益从“探针自证”改为“**成对真实会话证据**”。新增
   `verification.task`/`context-policy` 改进形式与 `taskBenefit` 证据（绑定候选源码与宿主版本，
   要求两侧全部正确、机制确实运行、轮次/调用数下降且 token/耗时无实质回归），并把它变成
   `promotionGates` 的必需项；单个工具替换或能力自测不再能晋升 workflow 声明。

## 2. 论文机制 ↔ DSH 实现 ↔ 缺口

| 论文机制 | Cordis 载体（论文表 2） | 本仓库的使用 | 真实缺口 |
| --- | --- | --- | --- |
| revertible effect / effect iterator | `ctx.effect(callback)`、`fiber.dispose` | Trial 的 `define/run/stop/undefine` + 捕获 baseline 后比较签名 | 无：这一层已被正确使用 |
| reactive coeffect / 依赖解析 | `fiber.inject`/`provide`、`ctx.get/set/isolate/intercept` | loader 条目的 `inject`；consumer 只挂载依赖满足的记录 | **改进本身从不使用 coeffect 形式**：候选永远是“注册一个新工具”，没有任何“观察上下文变化→变换下一步”的组件 |
| context paradigm / mediated context | 单一 context 类型、`systemPrompt`、`tools/result`、`agent/pre-step` | 只读订阅 `tools/result`/`agent/error` 写失败计数 | 观测只在“失败”这一侧，且目标身份是工具名；非错误损失（截断、capped、兜底恢复）完全不可见 |
| loader reconciliation / HMR | `cordis.patch.yml` + 官方 Include | 晋升/消费/回滚均走官方接口 | 无：这一层已被正确使用 |
| 观察等价 / 独立性 | 定理 43/68/70/71/80 | trial 串行化（`E_EVOLUTION_RUNTIME_BUSY`）、单一 baseline | 无：论文结论不覆盖“两个 Trial 并存”，仓库已自行串行化 |

论文明确没有回答、必须由本仓库自己回答的问题（对应论文 §5.3/§6.1/§8）：逆的正确性由作者负责
（runtime 不验证 witness）；emission 类副作用不可回滚；跨进程/跨 profile 组合没有定理；
“改进”的判据与端到端收益都未验证。本轮修复的正是最后一项。

## 3. 生产证据

### 3.1 三个 stable 记录（只读）

数据源：`~/.dsh/storages/evolution/shared-plugins/published.json`、`promoted/*/lib/index.js`、
`archive/experiments/*.evidence.json`。

| 记录 | 工具 | 证据形态 | 收益实际来源 |
| --- | --- | --- | --- |
| `evolution-promoted-af973a3eea01` | `readonly_git_file` | 有 probe：1 个 target、**0 个 control** | baseline 两次均为 `E_EVOLUTION_PROBE_CAPABILITY_ABSENT`；“收益”= 工具从不存在变成存在 |
| `evolution-promoted-e82a216992bb` | `run_code_diagnose` | 无 probe（`decision.probe = null`） | 调用方自报 `beforeMetrics {errors:1}` → `afterMetrics {errors:0}` + 文本 “absent before the trial” |
| `evolution-promoted-2794ab16d2b3` | `run_code_preflight` | 无 probe | 同上；canary 只是复读候选自己的输出 |

三份记录的 `sourceSha256` 与候选源码哈希一致（审批哈希是候选自己的源码哈希，属自指），
`stable.decision` 都是 `benefit`。PR #70 的 `benefitProvenance` 已把这层区分开：只有
`paired-workflow` 才算实验收益，这三条都是 `capability-self-test`；生产用量为 4/0/0，其中
`readonly_git_file` 的 4 次还包含验证流量。

### 3.2 真实模型的自主复用（PR #70，隔离真实宿主）

同一自然语言任务、同一模型、同一宿主，只差能力是否挂载，各跑一次：

| 轮次 | 候选侧工具序列 | 基线侧工具序列 | 用到晋升能力 |
| --- | --- | --- | --- |
| 1 | `read` → `bash` | `read` → `bash` | 否 |
| 2 | `bash` | `read` → `bash` | 否 |
| 3 | `glob` → `read` → `bash` | `bash` | 否 |

模型 0/6 次选择已晋升能力，全部用 shell 兜底且回答正确。这不是“插件坏了”，而是验证基线选错：
候选只被证明优于它包装的 `read`，而模型真实路径包含 shell 兜底。

### 3.3 本会话对真实会话日志的只读统计

脚本只读 `~/.dsh/sessions/**/session.v4.jsonl.zstd`，只输出计数，不输出正文：

- 495 个会话、17,125 次工具调用、353 次失败（失败结果 `message.isError === true`）。
- 失败类：guard 121、其他 77、超时 57、patch 上下文 53、语法 21、运行时 14、非法输出 4。
- 失败后的恢复成本（同工具下次成功前的跨工具调用数）：`run_code` 135、`bash` 100、
  `cordis_inspect_query` 48、`apply_patch` 27。
- `read` 长行截断（输出含 `line truncated to 2000 chars`）12 次 / 8 个会话；紧随其后的
  工具是 `run_code` 6 次、`read`/ `bash` 各 1 次。截断不产生 error，因此共享经验库里
  **没有对应记录**；规划器选中的最高频问题是 `tool run code`（107 次、unattributed、0 次观测尝试）。

这组数字同时说明两件事：(a) 真实损失大量发生在“非错误”的退化与兜底路径上；
(b) 现有 probe 无法重放这些路径（`run_code`/`bash` 被安全策略拒绝）。

## 4. 根因

R1. **观测只记失败，目标身份是工具名。** `lib/experience-collector.js` 只订阅
`tools/result` 的失败分支与 `agent/error`；规划器按 `tool <name>` 分组。于是“该改什么”
被定义成“哪个工具报错多”，而不是“哪条真实任务路径损失了什么”。
R2. **验证基线是候选自己。** `normalizeProbeScenario` 的 workflow target 用
`candidateName` 对 `name`；baseline 要么是“能力缺失”（`absentInBaseline`），要么是候选包装的
单次调用。`compareWorkflowProbeRuns` 的 quality 只看“baseline 失败、candidate 成功”，于是
“存在即收益”。
R3. **计划契约只表达“新增工具”。** `validateTaskRequest` 要求
`sample.tool === targetTool`，宿主在 trial 前以 `E_DESKTOP_TARGET_EXISTS` 拒绝已存在的名字。
没有“改现有组件行为/上下文处理”的形式，也没有任何 adoption 度量。
R4. **晋升后没有真实路径的收益判定。** 审计只能看到 installed/used；PR #70 把收益来源与用量
做成可读投影，但没有把“真实路径收益”变成晋升门禁。
R5. **工具面本身把端到端收益挤出了证据边界。** probe 只接受并发安全的官方工具，显式拒绝
`run_code`、写、shell、委派、后台、网络。即使 R2/R3 修好，只要真实兜底经过这些工具，
确定性 probe 仍无法证明“优于完整路径”。

## 5. 本轮修复

### 5.1 成对真实会话证据（taskBenefit）

- 契约：`lib/orchestrator.js` 的 `validateTaskBenefit`（2026-11-18）。证据必须声明
  `kind: "paired-real-session"`、`complete: true`、候选 Host 源码 sha256、Desktop taskId、
  host/model、任务与 prompt/expect 摘要，以及两侧各 ≥3 个会话的
  `{sessions, correct, failures, turns, toolCalls, tokens, durationMs}`。
- 判定：两侧每个会话都正确；机制确实运行（tool 形式要求模型至少选择一次，context-policy 形式
  要求至少一次真实变换步骤）；候选侧 turns 或 toolCalls 严格下降；failures/tokens/耗时不超过
  预算（tokens +5% 或 +2000，耗时 +25% 或 +60s）。任何契约违例都使 `benefit = false`。
- 绑定：Trial 在 `record.composition.hostSha256` 记录候选源码哈希；`measure` 拒绝不匹配的
  证据，并把归一化结果写入 observation 与证据 sidecar。宿主版本不一致同样拒绝。
- 门禁：`promotionGates` 对 `benefitModel.kind === "workflow"` 或
  `improvement === "context-policy"` 增加 `taskBenefit` 项；`workflowBenefit` 可以由
  probe 比较或 taskBenefit 满足，但 workflow 声明必须有 taskBenefit。
  历史记录不被重新判定：没有 declaration 的旧实验保持原 8 项门禁形状。

### 5.2 新的改进形式：context-policy

- `propose` 接受 `improvement: "tool" | "context-policy"`；`context-policy` 必须声明
  `benefitModel.kind = "workflow"`，因为它没有可自测的能力。
- Desktop 计划协议允许 `verification.task: { id, prompt, expect, runs? }`；context-policy
  计划禁止 `targetTool`、samples 与 workload，必须声明 task。宿主按 taskId 只读
  `desktop-tasks/task-evidence/<taskId>.json`（不接受计划里的任意路径），在 measure 时作为
  `observation.taskBenefit` 提交；缺失或不可读直接失败。
- 这样“改现有执行路径/上下文处理”的候选第一次有了可表达的契约，而且它的收益不依赖模型是否
  选择一个新工具。

### 5.3 工具面

`evolution_propose.improvement`、`evolution_measure.taskId`、
`evolution_measure.observation.taskBenefit`。固定上下文预算测试按同一公式重新测量并上调
allowance（text 不变，fields 12,427 B / wire 12,944 B）。

## 6. 验证

实际执行（本树，提交前）：

- `node --test test/task-benefit.test.mjs test/benefit-provenance.test.mjs test/desktop-task-host.test.mjs`
  — 43 项通过，0 失败。
- 追加 `test/experience-evolution-lifecycle.test.mjs`、`test/fixed-context-budget.test.mjs`、
  `test/experience-attribution.test.mjs`、`test/self-evolution-review.test.mjs` —
  131 项通过，0 失败。
- 新增用例覆盖：证据绑定/完整性/正确性、turns 未下降、token 回归、机制未运行、tool 形式未
  adopted、context-policy 不得用 capability samples、历史 8 项门禁形状不变。
- 全量回归与打包检查见 PR 描述（提交后执行；本文不预写未执行的数字）。

## 7. 未达成与剩余障碍

1. **尚未完成端到端正向收益的实测。** 生产方（接受验收 harness）需要在隔离 ACP 宿主里用真实
   模型跑同一任务的两侧，并把上述 artifact 写到 channel；本轮只完成了 kernel/protocol/host 的
   契约与门禁，没有跑通 producer。因此“至少一个代表性开发场景获得可重复正收益”**未达成**，
   不以测试通过或门禁变绿代替。
2. **发现侧仍未修。** 观测仍然只记录失败；截断这类非错误损失不可见。“记录 degradation +
   recovery 工具”需要新的知识事实族（现有 `recordFailure` 会把任何类型归一成 `tool/error`），
   属于独立设计，本轮不强行改造。
3. **context-policy 的 canary 没有功能检查。** 它没有 tool 与 workload，canary 只验证运行时
   健康与启动；真实收益由 taskBenefit 承担。这是刻意的边界，应在 producer 落地时补一次性任务
   复验。
4. **证据信任边界。** taskBenefit 是操作者/harness 产出的证据（与 `revalidate --evidence`
   同一级别），channel 不是授权边界；kernel 只做结构、绑定与一致性校验，不能证明证据的诚实性。
5. **tool 形式默认仍会被拒绝。** 这是有意的：模型不选的能力不再能凭自测晋升。
