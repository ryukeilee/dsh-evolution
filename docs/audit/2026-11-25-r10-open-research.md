# 完整自我进化主链第十轮开放性研究（2026-11-25）

受理标识：**DSH-EVOLUTION-R10-OPEN-RESEARCH-01**。

## 1. 范围与方法

基线：本任务 Worktree 分支 `t3/dsh-evolution-r10-open-research`，起点
`bc267ce4167b3f5fd8afdc4db5552761c43d002e`（比 `origin/main` `1d97337` 多 15 个有意保留的
DSH-TEAM-ACCEPTANCE 文档与 closed-loop 修复提交；本轮没有重写或丢弃它们）。版本仍为 `0.2.20`。

团队规则：`/Users/ryukeili/.t3/scratch/2026-11-24-goal-t3-code-orchestrator-v2-14b55e71/TEAM.md`，
SHA-256 `40034454984eb7b38fc93e7f73ef42e6b591eea1855f5734fb049d5d0c6cdb55`，读取时 46 行。
路由与档位：Lead 为 OpenCode `opencode-go/deepseek-v4.1-flash` variant max；Builders 为
OpenCode `opencode-go/hy4-flash-free` variant high；独立审核为 T3 Codex `gpt-6.2-sol`
reasoningEffort high；文档同步为 OpenCode `opencode-go/deepseek-v4.1-flash` variant high。

方法：

- 复用 `docs/audit/` 前九轮结论与 `docs/evidence/` 既有真实宿主证据，按本轮实际改动选择验证范围；
  没有重复真实模型配对实验，没有触碰正式 `DSH_HOME`、正式经验库或已安装插件。
- 三个只读研究子代理分别覆盖「重启/跨会话证据身份」「跨入口发布/消费/用量/审计」「经验存储/检索/规划」，
  主代理对每条进入修复的发现独立复核根因并用临时目录复现。
- 三个 Builder 在独立 T3 Worktree 中实现相互独立的修复并提交；Lead 在本线程集成、复核、补测并跑全量回归。
- 独立 Reviewer 在单独 Worktree 上检查 SPEC、实际 diff、运行证据与契约，不修改文件。

## 2. 已确认并修复的问题

### 2.1 用量扫描器把 PTC 调用与明文会话日志读成“完整、可信的 0 次”

**根因（两个独立入口，同一个后果）**

1. 官方 PTC（`run_code`）路由把嵌套的模型工具调用写成
   `tool/ptc-dispatch-start` / `tool/ptc-dispatch`，而不是 `tool/call`
   （`node_modules/@deepseek-ai/dsh-tools/lib/index.js` 的 `agent.session.append("tool/ptc-dispatch", …)`；
   官方事件表 `node_modules/@deepseek-ai/dsh-session/lib/index.js:131-132`）。
   `lib/capability-usage.js` 的 `callIdentity()` 只识别 `tool/call` / `tool/result`，因此 PTC 用量完全不可见。
2. 会话持久化的文件名由 generation + compression 决定
   （`node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` 的
   `generationLogFilename()`；`SESSION_FORMAT_VERSION = 4`）。默认 `dsh-base` 使用 zstd，
   但官方 `dsh-sdk-minimal/cordis.patch.yml` 配置 `compression: none`，实际文件是
   **明文** `session.v4.jsonl`。扫描器只收集 `session.v4.jsonl.zstd`。

两处都会得到 `scannedSessions: 0`、`complete: true`、`recordsComplete: true`，并把每个发布记录写成
`workflowInvocations: 0`。评审把这种 0 当作“实测零”，配合操作者给出的 `self-contained` 标注就会产生
`review-retirement` 建议。升级本身还会留下旧的 `usage.json`：它在 `schemaVersion: 1` 里同样是
`complete: true` 的零，读端无法仅凭版本区分。修复同时给投影加 `coverage` 标记；没有该标记的旧投影保留正数
事实，但零调用按未知处理，直到操作者显式重跑扫描。复现（临时目录，合成记录与真实文件名）：

```text
session.v4.jsonl 中一次真实 tool/call（压缩配置 none）
-> complete: true, recordsComplete: true, scannedSessions: 0,
   workflowInvocations: 0, capabilityAssessment: 'self-contained'
```

PTC 的复现：一次模型 `run_code` 程序内的 `tool/ptc-dispatch` 在修复前完全不产生计数。

**修复**

- `callIdentity()`/`createSessionCounter()` 识别两种 PTC 行；一个 completed `tool/ptc-dispatch` 只计一次，
  与 `tool/ptc-dispatch-start` 配对，不重复计数。
- 归因顺序与原生调用一致：有 **native** 晋升生命周期调用尚未返回 → `pending`（全部返回后为 verification，
  否则 unattributed）。PTC 内调用的生命周期 start 不能作为可靠窗口：官方执行器异步追加结果行，后续正常调用
  可能先于该结果落盘，因此这段窗口内的发布调用记为 unattributed，而不是验证流量（避免把真实使用读成 0）。
  否则若 `parentCallId` 是同一会话中**恰好一个尚未返回**的 `run_code` 实例 → workflow；历史非 `run_code` 调用、
  已返回或复用 ID、以及宿主驱动的执行都归 unattributed（日志无法证明模型选择）。`sourceEventSeqs` 关闭具体
  run_code 实例；该实例结束时收束其未完成的 PTC 生命周期窗口。日志结束仍无 final dispatch 的 start 记
  unattributed，不会被当成 0。
- `sessionFiles()` 同时扫描当前 generation 的两种编码（`session.v4.jsonl.zstd` 与明文 `session.v4.jsonl`），
  共享 256 MiB 解压/读取上限与错误分类。同一 session 目录同时存在两种编码时，日志无法证明哪一份是当前写入，
  两份都不计数并列入 `ambiguousSessionEncoding`，令 `complete: false`、计数为 `null`，而不是重复计数。
  其他 canonical 形状（`session.jsonl`、`session.vN.jsonl[.zstd]`）在没有当前文件时列入
  `unsupportedSessionFormats`，同样使投影不完整；同一目录内与当前文件并存的旧 generation 视为该会话的迁移副本，
  不重复计数，也不制造额外的 incomplete。本轮不尝试解析历史 generation 的事件。
- 投影新增 `coverage` 标记（`native+ptc+current-encodings-v1`）。读端只在该标记存在、投影完整且未过期时才信任
  “零调用”；旧 `usage.json`（没有该标记）的正数事实仍可用，零值回到 unknown，直到操作者显式重新扫描。这样
  刚安装本版本的既有用户不会因为修复前的假零被建议停用。

**回归**：`test/capability-usage-scan.test.mjs` 新增 PTC 的 workflow / verification / 未返回 lifecycle /
宿主驱动无父调用 / dangling start / 非发布工具 / 原生路径不变，以及明文 v4 与历史 generation 的用例；
直接对 `createSessionCounter` 的返回值和 CLI 投影都做了断言。反证：修复前的同一 PTC 日志返回 `[]`。

### 2.2 跨重启 canary 把结论写到未测量过的宿主版本下

**根因**：`propose()` 把 `applicability` 写入 proposal（journal / sidecar 会持久化），`probe()` 也把它写入
`probe.versions`；但 `publishConclusion()` 使用发布进程当时的 `this.applicability()`。promotion canary 明确
支持跨进程重启（`verifyStartupCanary()` → `observeCanaryJournal()`），因此宿主在 canary 期间升级后，
`adopted` / `regression` 结论会被记到新版本三元组下。下一轮 `findConclusions()` 会把它当作“同条件”的
已证伪/已采纳事实：要么错误阻断一个在新版本上从未测过的策略，要么把目标错误标为 `already-resolved`。
设计文档明确要求同一轮实验、probe 与结论共享同一个三元组。

**复现（修复前，直接调用 `publishConclusion`，真实临时 SQLite）**：

```text
proposal.applicability = 0.2.2-rc.5/4.1.0/0.2.20
live (upgraded)       = 0.2.3-rc.1/4.2.0/0.2.20
written applicability = 0.2.3-rc.1/4.2.0/0.2.20
```

**修复**：`publishConclusion()` 按 `record.probe.versions`（同一进程的原始测量）→
`record.latestObservation.probe.versions`（重启后从 durable observation 恢复的同一测量）→
`record.proposal.applicability`（journal/sidecar 恢复的提案条件）→ `this.applicability()`（仅历史记录兜底）
选择三元组；同一个变量同时用于 neutral-verdict 的 `findConclusions()` 跳过门禁和 `recordConclusion()` 写入，
两者不再可能指向不同条件。恢复器也采用同一顺序，避免“重启后完成的 canary”与“启动补写”在同一实验上写出
两组不同版本的第二条 adopted 记录。不改变 promotion gates、状态机、结论身份规则或持久化 schema。

**回归**：`test/review-fix-conclusion-applicability-identity.test.mjs` 覆盖重启后旧 triple 写入、neutral
跳过门禁、probe 优先、非法字段回退、同进程 live 行为不变；`test/review-fix-stable-conclusion-recovery.test.mjs`
额外验证恢复路径也保留测量时的 triple。

### 2.3 stable commit 与结论写入之间的崩溃窗口永久丢失“已采纳”事实

**根因**：`observeCanaryJournal()` 的 stable 路径先持久化 evidence sidecar，再删除 journal，然后才
`archive()`、`publishConclusion(adopted)` 与 `emit canary-passed`。进程在 sidecar 之后、结论之前崩溃时，
durable stable 插件已经存在，但共享经验既没有 adopted conclusion，也没有 `canary-passed` 成功事实。
下一次启动的 `recoverInterruptedPromotion()` 只补 canary 证据并清理 journal；`reconcileSharedPromotions()`
只重建跨入口发布索引。`evolution_plan` 因而继续把已解决目标列为候选，直到出现新的失败/成功事实，甚至反复
生成无法执行的 Trial。

**修复**：

- `snapshotEvidenceFromRecord()` 额外持久化 **经脱敏且有界的 composition name**，而不是调用方传入的整个
  composition 对象（`purpose` 等不进入 sidecar/journal；名称走 `compactValue` 的凭据边界与 200 字符上限）。
  `mergeEvidenceSources()` / `hydrateRecordFromSnapshot()` 单调恢复它，使无 `proposal.strategy` 的实验在重启后
  仍使用同一个 composition-name 回退身份，而不是哨兵 `unnamed-cordis-plugin`；实时结论与启动补写使用同一个
  `compositionStrategyName()` 投影，因此脱敏后的身份不会分叉。旧 sidecar 不增加键。stable 最终快照在写入
  sidecar 前再次投影（R1 格式的旧 journal 即使带着原始 composition，重启续跑也不会把它写回最终 sidecar）；
  正式 replay 路径同样只写投影名称。
- 新增 `reconcileStableConclusions()`：启动时只读最新 `maxRecords`（默认 20）个 evidence sidecar，
  对 `stableCommittedAt` + `decision.kind === "benefit"` + 已捕获适用条件（`latestObservation.probe.versions`
或 `proposal.applicability`）的记录，用同一
  `publishConclusion()` 逻辑补写 `adopted`（`source: "stable-recovery"`）。结论 event id 由 origin /
  experimentId / decision / applicability 决定，所以重复恢复是 duplicate，不会产生第二条知识。
  单文件 2 MiB、不可读/不可解析/非稳定/无 applicability 的记录只记 bounded skip，不阻断启动。
- `lib/index.js` 在 orchestrator 构造后调用一次；失败只发脱敏 warning，不拒绝已经提交的 stable 插件。

**回归**：真实临时 SQLite；覆盖首次补写、第二次启动 duplicate 且字节不变、宿主升级后仍写旧 triple、
无 applicability 不被重新标注、非 benefit/非 stable 不采纳、composition 跨 snapshot/merge/hydrate 保留。
反证：去掉 applicability 选择后，2.2 与 2.3 的宿主升级用例均失败。

### 2.4 doctor 与统一审查对“撤销表损坏”给出相反结论

**根因**：`disabled.json` 损坏/不可读时，consumer 的 `evaluateSharedRecord()` fail-closed，拒绝每一条发布记录；
统一审查报 `blocked` + `operator-action`。但 `diagnoseSharing()` 只把 `disableUnreadable` 放进 `degraded`，
于是 doctor 报 DEGRADED，同一份报告的文字却承认“consumers refuse every record”。按 doctor 分诊的操作者会把
整个跨入口复用失效当成可延后的降级项。

**修复**：doctor 把该状态计入 `blocking`，level 为 BLOCKED，summary/remediation 与 review 同口径；
证据里增加 `blockingReason: "disable-state-<status>"`。不新增 repair，也不改写表。统一审查把撤销表检查
提前到宿主版本检查之前：consumer 在读取记录 host 之前就因撤销表 fail-closed，因此一条同时宿主不匹配的记录
也必须报 blocked/operator，而不是给出无法修复前置条件的 revalidate。

**回归**：`test/promoted-sharing-diagnostics.test.mjs` 同时断言 doctor 的 BLOCKED 与 review 的
`blocked` / `operator-action`，并新增“宿主不匹配 + 撤销表损坏”仍为 blocked、不产生 revalidate 动作的用例。

### 2.5 审查 50 条上限之后记录的动作被静默丢弃

**根因**：`readPublishedPluginReview()` 只评估 `index.records.slice(0, 50)`；`base.truncated` 只是布尔值，
compose 把它映射成 `incomplete: true`，但没有为第 51 条之后的 `revalidate` / `repair-stable` /
`restart-consumer` / `review-retirement` 产生任何动作。索引与 reconciler 都按 200 条设计，50+ stable 记录
是预期规模；位置靠后的损坏记录会看起来“没有待办”。

**修复**：当 `index.records.length > maxRecords` 时，产生一个 bounded、owner-facing 的 blocking
`operator-action`（`code: "review-record-cap"`），写明被省略的记录数与最多 5 个 id 样本，明确这些记录
**没有被评估**；不伪造逐记录状态。该动作有独立的去重身份，不会与 `recordId: null` 的 invalid-record 动作
合并；原文审查的动作上限为它保留一个名额，`nextActionsDropped` 继续报告被截断的动作数。compose 的排序
仍让 operator-action 先于新实验。

**回归**：`test/self-evolution-review.test.mjs` 构造 51 条真实发布记录，篡改第 51 条的源码，断言它没有
per-record 状态、截断动作存在且排第一、动作上限与 `nextActionsDropped` 仍生效、compose 的 `kind` 为
`operator-action` 且 `incomplete: true`。

### 2.6 独立复审 R1 发现并修复的边界

R1（T3 Codex `gpt-6.2-sol` high）审查的是本轮中间提交 `3ec6d8d`。它确认 4 个 blocker、4 个 should；
Lead 逐条复核后在其后提交中修复，并由 R2 在新 HEAD 上复验。

| # | R1 结论 | 修复 |
| --- | --- | --- |
| S1 | 新增 sidecar 字段把调用方 `composition.name` / `purpose` 原样写入 journal/sidecar；R1 格式的旧 journal 续跑时最终快照仍展开原始对象 | `compositionStrategyName()` 只持久化经凭据规则投影、200 字符上限的名称；`purpose` 及 composition 的其余字段不进入任何 durable evidence；实时发布、启动恢复、正式 replay 与 stable 最终 sidecar 共用同一投影（`64d9ab5`、后续 S1 修复）。 |
| S2 | 重启后 `record.probe` 不在内存，发布只看 `record.probe.versions`，补写会与重启后的 canary 写出两条不同版本的 adopted | 解析顺序扩展为 `record.probe.versions` → `latestObservation.probe.versions` → `proposal.applicability` → live；三个字段必须是字符串，损坏的 probe 版本对象不参与回退（显式全 `unknown` 仍可用）；恢复器遇到损坏的 probe 版本直接跳过，避免用 proposal 补出第二条不同版本的 adopted（`e91a7fb`、`7990ba0`、后续 S2 修复）。 |
| S3 | `replayExperimentEvidence()` 重写 sidecar 时丢掉 composition | 正式 replay 路径写入同一个投影名称（`7990ba0`）。 |
| S4 | 同一 session 目录的双编码被计两次 | 按目录分组；双当前编码 → `ambiguousSessionEncoding`、`complete:false`、计数 null；旧 generation 与当前文件并存视为迁移副本（`1da7323`）。 |
| S5 | PTC 把任意历史同 ID 调用当成模型 `run_code`；PTC 生命周期结果日志异步追加会让后续正常调用被误记为验证 | 只有**恰好一个 open** 的 native `run_code` 实例能证明 workflow；历史/已返回/复用 ID 归 unattributed；按 `sourceEventSeqs` 关闭具体实例并在父程序结束时收束未完成的 PTC 生命周期窗口；PTC 生命周期窗口内无法证明的调用归 unattributed，而不是 verification（`7990ba0`、后续 S5 修复）。 |
| S6 | 修复前生成的旧 `usage.json` 仍是 `complete:true` 的假零 | 投影新增 `coverage` 标记；旧投影零值为 unknown，正数仍是事实，直到显式重扫（`7990ba0`）。 |
| S7 | 宿主不匹配 / 宿主未知 / 空索引时 doctor 与 review 对损坏撤销表仍分叉 | review 把撤销表检查提前到宿主检查之前；空索引 + 损坏表单独返回 blocked/operator；doctor 与 review 同判（`e91a7fb`、`7990ba0`）。 |
| S8 | 截断说明与 nameless invalid-record 动作共用去重键，且可能被动作上限裁掉 | 截断动作带 `code: "review-record-cap"` 的独立身份，原文审查为它保留一个名额（`7990ba0`）。 |

R1 的 8 个 doctor 用例因其工作树缺少可发布宿主身份而失败；本轮在 `test/promoted-sharing-diagnostics.test.mjs`
用固定宿主事实与临时目录覆盖等价场景，修复后 13/13 通过。

## 3. 明确不修改的项

| 项 | 结论 | 依据 |
| --- | --- | --- |
| `priorIneffectiveConclusion()` 忽略 `findConclusions().truncated` | **本轮不修（低概率残余）**。需要同一 `(scope, fingerprint)` 下超过 500 条结论（rootCause/版本不同但指纹相同）才能把旧负面挤出窗口；这是 500 次以上同策略实验的极端规模。`findConclusions()` 已把指纹放入 SQL 窗口谓词，消除了更常见的“其他策略挤占”路径。为绝对存在性增加无界查询，收益与长期成本不匹配。 | `lib/shared-experience.js:555-617`、`lib/orchestrator.js:6148-6168` |
| 仅有 canary 回归事实、没有 conclusion 行时 occurrences 为 0 | **本轮不修（需要语义决定）**。正常 canary 回滚会先写 `regression` conclusion；只有共享库写入失败或历史数据才可能只剩 `canary-failed` 行。把 evolution 行的 `regressionCount` 直接加入 occurrences 会与 conclusion 行重复计数（一次回滚合并 `canary-failed` + `promotion-reverted` 两行），需要重新定义该计数语义；本轮不为该边缘路径扩大状态机。 | `lib/experience-plan.js:804-816,945-971`；`lib/orchestrator.js:7831-7836` |
| failure/degradation writer 对带空格/Unicode/超长 target 回退 `host` | **NO-CHANGE（生产不可达）**。官方工具名由 `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$` 约束，collector 的 target 是 `tool:<name>` 或 `agent`；非法 target 只来自自定义宿主。失败与结论族使用不同的 target 规则是已知不一致，但修复需要改持久化身份并迁移，收益不成立。 | `lib/shared-experience.js:14,345-365`、`lib/registration.js` |
| `revalidate` CLI 未核对证据 host 与当前 data root / 未现场复算源码摘要 | **NO-CHANGE（2026-11-24 round7 已定边界）**。采纳是操作者显式 `--evidence` 动作；runner 在隔离数据根上用当前宿主取证并绑定字节。本轮没有新增证据表明该边界可被普通进化流程触发。 | round7 §4；`scripts/shared-plugins.mjs`、`scripts/acceptance/run-revalidation.mjs` |
| canary 回滚后、结论写入前的崩溃窗口 | **已知残余**。回滚路径会删除 journal；若进程在 `publishConclusion("regression")` 前崩溃，回归结论可能缺失。与 2.3 的 stable 窗口不同，回滚窗口没有等价的 durable sidecar 可独立重建；修复需要新的回滚证据持久化协议，超出本轮有界修复范围。 | `lib/orchestrator.js` 的 canary regression 分支 |

## 4. 验证

- 反证：2.1 的 PTC 日志在修复前返回空计数；2.2 的宿主升级复现修复前写入 live triple；2.3 的
  `a record without a captured applicability` 与升级用例在缺少 applicability 选择时失败；2.4/2.5 的旧行为
  分别由原测试期望（degraded / 无截断动作）反证。
- 聚焦：`test/capability-usage-scan.test.mjs`、`test/self-evolution-review.test.mjs`、
  `test/promoted-sharing-diagnostics.test.mjs`、`test/review-fix-conclusion-applicability-identity.test.mjs`、
  `test/review-fix-stable-conclusion-recovery.test.mjs`、`test/shared-experience-conclusion.test.mjs`、
  `test/experience-evolution-lifecycle.test.mjs`、`test/promotion-share-targets.test.mjs`、
  `test/full-cross-session.integration.test.mjs` 全绿。
- 全量：`NODE_OPTIONS=--max-old-space-size=4096 npm test`（最终集成 HEAD，含 B1/B2/B3/B4、R1 修复与测试修复）——
  **2290 项，2288 通过 / 0 失败 / 2 跳过**；基线 `bc267ce` 为 2254 项（2252 通过 / 0 失败 / 2 跳过）。
- 打包：`npm run pack:check`（开发阶段）**17/17 通过**；工作树是 `0.2.20` 固定点的已提交后继，
  固定产物、固定点内容摘要与既有验收证据未改动。未执行 `release:publish`、未打 tag、未推送。
- 独立审核：R1（T3 Codex `gpt-6.2-sol` reasoningEffort high）返回 CHANGES，4 blocker / 4 should；本轮逐条
  修复并由 R2 在同一分支的新 HEAD 上复验，结论待填。
- 未重跑真实宿主验收：本轮改动集中在离线用量读取、共享结论身份、启动补写和有界审查动作；既有
  `docs/evidence/` 的 0.2.2-rc.5 39/39 隔离验收覆盖安装/晋升/跨入口/恢复，未覆盖本轮新增的崩溃补写与
  PTC 用量扫描；这两条的直接证明是真实临时 SQLite/合成官方事件行与反证。真实宿主 CI 仍会运行。

## 5. 实际收益与剩余风险

**收益**

- 一个 PTC（`run_code`）会话或 `compression: none` 的官方 minimal SDK 会话，从“完整可信的 0 次使用”
  变为真实计数或诚实的 `complete: false` / `null`；避免把在用插件推荐下线。
- canary 跨宿主升级后的结论重新与测量条件对齐；不再产生跨版本的假“已证伪”或假“已解决”。
- stable 崩溃窗口不再永久丢失 adopted 结论；最多延迟到下一次启动，且重复执行无副作用。
- doctor 与 review 对撤销表损坏给出同一个 BLOCKED 判断；50 条以上索引不再静默隐藏动作。

**剩余风险**

- PTC 计数按“调用”而非“结果”计：PTC preset 下模型先直调被拒绝、再在 `run_code` 中成功调用同一工具时，
  会得到两次调用计数；这是既有“调用即计数”规则的延伸，不改变停用建议的安全方向（正数仍然阻止停用）。
- 同一 session 目录同时存在 `session.v4.jsonl` 与 `.zstd` 时按编码二义性处理（unknown，不是重复计数）；
  只有旧 generation 文件、没有当前文件的目录仍使投影 incomplete，直到操作者处理/migrate。
- 启动补写只覆盖最新 20 个 stable sidecar；更早的崩溃窗口不会被自动修复。无 `proposal.applicability` 的
  旧记录不会被重新标注（保守跳过）。
- 2.4 的空索引 + 损坏撤销表场景中，doctor 会保守报 BLOCKED，而 review 可能报 inactive；本轮以“消费者
  无法读取撤销表”为安全优先，不为此新增逐记录动作。
- 2.3 只补写 adopted conclusion，不重放 `canary-passed` 事件；`evolution_plan` 的 `adoptedConclusion`
  足以判为已解决，但事件桥里仍可能缺一条成功事实。跨入口发布由既有 reconciler 从 sidecar 重建。
- 上述 §3 的残余项保持登记；不为极端规模或历史数据扩大机制改动。
