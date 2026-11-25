# 完整自我进化主链第十一轮开放性研究（2026-11-25）

受理标识：**DSH-EVOLUTION-R11-OPEN-RESEARCH-01**。

## 1. 范围与方法

基线：`origin/main` = `f0e8e1c`（2026-11-25 最新）。任务在独立 Worktree 分支
`t3/dsh-evolution-r11-open-research` 上开展，未使用本地 `main`。R10/PR #102 仍为 OPEN，
本轮把它的分支 `b7cc36f` 合入 R11 分支作为前提（合并提交 `6a7a2bd`），因为两轮修复落在
`lib/shared-experience.js`、`lib/self-evolution-review.js`、`lib/diagnostics.js`、
`lib/desktop-task-host.js` 等同一批文件。**合并顺序：先 PR #102，再本 PR**；本 PR 的 R11
提交是 `6a7a2bd..HEAD`，R10 的 25 个文件只作为依赖基线，不重复计入本轮修复。

团队与路由（按 `TEAM.md` 固定配置，创建后由 Lead 回读）：

| 角色 | 模型与档位 | 线程（T3） | 交付 |
| --- | --- | --- | --- |
| Lead / Ship | `opencode-go/deepseek-v4.1-flash` High | 本线程 | 集成、验证、交付 |
| Research A（经验链路） | `opencode-go/hy4-flash-free` High | `thread:delegated-task:...:26d7631d-...` | 只读报告，确认 A1 |
| Research B（实验生命周期） | `opencode-go/hy4-flash-free` High | `thread:delegated-task:...:d96289f0-...` | 只读报告，确认 B-1/B-2 |
| Research C（跨入口复用） | `opencode-go/hy4-flash-free` High | `thread:delegated-task:...:9f0c21af-...` | 只读报告，确认 C-1 |
| Builder A1 | `opencode-go/hy4-flash-free` High | `thread:delegated-task:...:b5a1c8d2-...` | `bf632d5` → 集成 `74e9276` |
| Builder C-1 | `opencode-go/hy4-flash-free` High | `thread:delegated-task:...:d71b1852-...` | `af648df` → 集成 `8f76d1c` |
| Builder B-1/B-2 | `opencode-go/hy4-flash-free` High | `thread:delegated-task:...:bfe5797a-...` | `a5a1cdd` → 集成 `47495b0` |
| Playtester | `gpt-6.2-sol` High | 见 §4 | 独立反方复审 |
| Copywriter | `opencode-go/deepseek-v4.1-flash` Low | 见 §4 | 文档同步 |

方法：

- 三个只读研究 Builder 分别覆盖「经验采集→共享持久化→检索→发现→规划」「Trial/probe/measure/
  晋升/canary/恢复」「跨入口发布→consumer→用量→审查」；Lead 对每条进入修复的发现独立复核根因
  与复现，只接受能用当前源码、真实临时 SQLite/合成事件或宿主 harness 证明的问题。
- 三个实现 Builder 在各自独立 Worktree 中完成互不重叠的修复并提交；Lead 按依赖顺序 cherry-pick
  到 R11 分支，重跑聚焦与全量测试。
- 全程只读研究 + 隔离临时目录；未触碰正式 `DSH_HOME`、正式经验库、`event-bridge.key` 或已安装
  插件；未打 tag、未发布、未合并、未开启自动合并。

## 2. 确认并修复的问题

### 2.1 已恢复的工具目标仍以 100% 失败率留在候选（A1，should）

**根因**：`lib/experience-collector.js` 只在**失败发生**时把 `attemptsSinceFailure` /
`successesSinceFailure` 写进共享经验；失败之后的成功只累加在进程内 LRU。失败之后的 200 次
成功从未落盘，`knowledge` 保持 `attempts sum=5 / successes sum=0`，`lib/experience-plan.js`
因此以 `rateBasis: observed-window` 输出 `observedFailureRate: 1`，已恢复的目标继续占据候选，
直到 30 天 recency 衰减。

**复现**（临时目录；Context + 真实共享 SQLite；5 次失败 + 200 次成功）：

```text
failureCount: 5, successCount: 0
metrics.attemptssincefailure: { sum: 5 }
metrics.successessincefailure: { sum: 0 }
plan.selected: { problemKey: 'tool read', observedFailureRate: 1,
                rateBasis: 'observed-window', attempts: 5, successes: 0 }
```

**修复**：

- `lib/shared-experience.js` 新增 `recordToolRecovery({ id, target })`，写入独立的
  `tool/recovery` 成功事实（`status: 'success'`, `success: true`）；不写 `failureMode` /
  `rootCause` / `semanticFact`，因此其 knowledge 身份与同 target 的 `tool/error` 行分开，
  不会把失败行降格或把失败分母放大。重复 episode 在 knowledge 层合并，事件层按 episode 各自
  保留 id。
- `lib/experience-collector.js` 增加 `RECOVERY_SUCCESS_THRESHOLD = 5`（与 planner 的
  `MIN_RATE_SAMPLES` 对齐）；outcome row 记录 `lastFailure` / `recoverySuccesses` /
  `recoveryRecorded`。失败提交成功后开启新 episode；同一 episode 内 5 次**连续干净成功**
  （`isError !== true`、`detectDegradation() === null`，且 `bash` 必须复用
  `recoverySucceeded()`：`exitCode === 0`、非 timeout/abort/signal）后写一条 recovery，写成功后
  不再重复；新失败重置 episode。截断/降级成功与 bash 非零退出都打断 streak，但仍按既有语义计入
  `successesSinceFailure`，不计入 recovery 阈值。
- planner 不把 `tool/recovery` 当作普通 resolution：`lib/experience-plan.js` 记录独立的
  `recoveryEpoch`；只有该 group 的 `lossSum < minOccurrences`（没有达到门槛的 actionable
  degradation）且 recovery **严格晚于** `latestFailure` 时，recovery 才能判 `already-resolved`。
  存在 qualifying loss 时损失证据保留、目标仍是候选；同一毫秒的 failure 与 recovery 不算
  “失败已消失”。普通 success / adopted / canary 行仍保持 `>=` 语义。
- 写 recovery 失败仍由既有 `warnRedacted` 兜底，不改变工具结果或采集路径。

**回归**：`test/review-fix-tool-recovery.test.mjs` 9 项：

- 5 失败 + 5 干净成功 → `tool recovery` 行可发现，planner 将 `tool read` 判为
  `already-resolved`，`selected` 为空；
- 4 成功不写 recovery，目标仍是候选；
- 4 干净成功 + 1 次截断成功不写 recovery；
- 5 次 bash `exitCode:1` 不写 recovery（真实失败）；
- 截断成功打断 streak，之后的单次干净成功不写 recovery；
- 5 次失败 + 5 次截断 + 5 次干净 + 4 次截断：recovery 仍写入，但 qualifying loss 保留，
  目标仍是候选；
- 新失败重开目标；第二 episode 写第二条事件，knowledge 合并 `successCount=2`；
- 同一 episode 的 200 次成功不重复写事件；
- 同毫秒 recovery 不 resolve；晚 1ms 才 resolve。

反证：修复前的同一测试 3 项失败（无 recovery 行、planner 仍选目标）；S1/S2/S3 的 4 项在 R1 修复前失败。修复后聚焦 72/72。

**边界**：recovery 需要同一 collector 进程观察到失败与后续 5 次干净成功。进程在失败后重启、
且之后只成功不再失败时，仍不会有 recovery 行；目标继续按 recency 衰减（见 §5）。

### 2.2 索引仍在但记录被删除/未批准时，doctor 与统一审查报健康（C-1，should）

**根因**：`lib/diagnostics.js` 的 `diagnoseSharing()` 在索引 `ok` 时只遍历索引中的记录；
consumer 状态里仍为 `active`、但对应记录已被删除或 `approvedProfiles` 收窄的行被
`if (!record || !record.approvedProfiles.includes(profile)) continue;` 直接跳过。
`lib/self-evolution-review.js` 同样只遍历 `record.approvedProfiles`。R9 只修了“整个
`published.json` 缺失”的分支；R10 只修了撤销表损坏，未覆盖“索引在、单条记录不在/未批准”。

**复现**（临时目录；发布一条 `acp`+`web` 记录，写 `acp` 的 active consumer 状态，然后把
`published.json` 的 `plugins` 清空但保留 `updatedAt`）：

```text
doctor: level=ok, orphanMounts=undefined, pendingRestart=[]
review: status=inactive, records=[], nextActions=[]
compose: kind=no-action
```

插件仍在 consumer 中运行，但两个只读检查都给出“健康/无动作”。

**修复**：

- `diagnoseSharing()` 在记录缺失或 profile 未批准、且 `row.status === 'active'` 时记入
  `orphanMounts`（`reason: record-missing` / `profile-not-approved`），写入 `evidence`，
  使 level 至少 `DEGRADED`；summary 与 remediation 明确“删除记录/收窄批准范围不会卸载已运行
  插件，必须重启对应 consumer”。索引 `absent` 分支的既有 `{profile,id}` 形状与修复保持不变；
  不新增 repair。
- `readPublishedPluginReview()` 从 bounded consumer 投影推导同一 `orphanMounts`，为每个孤儿
  产出有界的 `restart-consumer` 动作（`recordId`、`profiles`、`profile`、
  `code: 'orphan-active-mount'`）；索引 `ok` 时最终 status 至少 `restart-required`，但不覆盖
  `blocked` / `pending-revalidation` / `incompatible`。索引 `absent` 且有 active 孤儿时返回
  `restart-required` + `reason: 'orphan-active-mount'`；无孤儿时保持原有 `absent/no-action`。
  既有动作排序与封顶逻辑抽成 `boundedReviewActions()`，行为不变。

**回归**：`test/promoted-sharing-diagnostics.test.mjs` 与
`test/self-evolution-review.test.mjs` 新增 7 项，覆盖记录删除、profile 收窄、正常场景无孤儿、
更高优先级不被覆盖、`composeSelfEvolutionReview` 的 primary 动作、`absent + active` 重启，
并验证无孤儿时 `absent` 仍为 no-action。反证：修复前 7 项全部失败。修复后 67/67。

**边界**：统一审查只读取前 50 条 consumer 行（`SELF_EVOLUTION_REVIEW_LIMITS.maxRecords`），
超过上限的孤儿由 doctor 的全量 consumer 状态报告；review 的 `orphanMounts` 是有界投影。

### 2.3 Desktop 宿主把 `undefined` 与 `null` 折叠为同一证据（B-1，should）

**根因**：`lib/desktop-task-host.js` 的 `canonical()` 使用 `JSON.stringify(value) ?? 'null'`，
`canonical(undefined) === canonical(null)`，因此 `sameValue(undefined, null) === true`。
Round9 S2 只修了内核 `probeLosslessSnapshot()` 的同类折叠，宿主侧未同步。可达路径：
`runSamples()` 的 Trial 能力样本（`sample.expected: null`，候选工具返回 `undefined`）与 canary
workload 的 `resultPath`（字段缺失被选成 `undefined`，期望 `null`）。

**复现**：临时 Desktop 宿主 + fake kernel；workload step 期望 `{payload:{summary:null}}` 并
在 `resultPath: ['payload','summary']` 取值，候选在 Trial 后返回 `{payload:{}}`；宿主没有抛
`E_DESKTOP_WORKLOAD_REGRESSION`，最终 `phase=stable`。能力样本路径同样把
`undefined` 判为匹配 `null`。

**修复**：`sameValue()` 改为无损结构相等（`losslessEqual`），导出供测试；`canonical()` 保留
仅用于 `waitForRuntime` 的稳定性指纹，并注释其不得用于证据判定。新判定：

- `undefined` 不等于 `null`；数组空洞不等于 `null`；稀疏数组按自有下标比较；
- `NaN` / `Infinity` / `-0` 不与普通 JSON 值相等；
- 只接受 plain object（`Object.prototype` / `null` 原型）与 dense array；Date/Map/Set/类实例
  不与 plain 对象相等；访问器属性与循环引用返回 false，不抛栈溢出；
- 普通 JSON 相等语义不变：对象键顺序无关，数组顺序有关。

**回归**：`test/review-fix-host-lossless-value.test.mjs` 覆盖纯函数与两条端到端路径（Trial
样本期望 `null` + 工具返回 `undefined`；canary workload `resultPath` 缺字段 + 期望 `null` 走
`E_DESKTOP_WORKLOAD_REGRESSION`/内核回滚）。反证：修复前 2 项失败；修复后 55/55。

### 2.4 canary evidence 持久化真实工具输出正文（B-2，should）

**根因**：`lib/desktop-task-host.js` 的 canary 观测把
`actualToolOutput: sampleResults.map((sample) => sample.actual)` 交给
`evolution_canary_observe`。内核的 `compactValue()` 只做有界/凭据投影，仍保留正文；这段正文随
`journal.canary.observations` 写入 promotion journal，并在 stable 提交时进入最终
`*.evidence.json` sidecar。设计只允许 label/tool/matched/结果 sha256/长度，AGENTS 不变量 8
要求不把用户数据写入证据；真实工具输出（例如 `read` 的文件内容）可能包含用户数据。

**复现**：合成 `canary-observing` journal 与 evidence sidecar，发送带
`R11_USER_DATA_LINE_...` 的 `evidence`；`journal.canary.observations` 与 stable sidecar 都
包含该正文前缀（超过 1200 字符才截断）。

**修复**：宿主不再发送原始 `actual`，改为 `sampleEvidence(sample)`：
`{ label, resultSha256, resultCharacters }`。摘要来自无损 canonical 文本（`undefined`、空洞、
`-0`、非有限值、循环、类实例均有独立/固定标记），正文不跨宿主边界。S6 复审后改为带类型前缀的
编码（null=`n`、undefined=`u`、string=`s…`、boolean=`b…`、number=`d…`、array=`a…`、
object=`o…`、unsupported=`x`），普通字符串无法伪造 nullish/占位标记；无法计算时用固定 `x`
标记，诊断失败不改变任务结果。内核的通用 `evidence` 契约不变。

**回归**：`test/desktop-task-host.test.mjs` 新增稳定路径断言：canary 观测的 evidence 不含原始
sentinel 正文，含 64 位 hex 摘要与非负长度；仍能推进 stable 与回归路径。修复前 2 项失败；
修复后 55/55。

### 2.5 consumer 状态不可读或缺少 activation 行时 doctor 报 ok（B4，should）

**根因**：`lib/diagnostics.js` 的 `diagnoseSharing()` 只在 consumer 状态 `ok` 且 `state.state`
存在时派发 `pendingRestart`。当索引有记录、但某个 consumer 状态文件不可读（`readConsumerState`
返回 `invalid`/`unreadable`，`state.state` 为 null），或状态为 `ok`、`observedIndexUpdatedAt`
等于当前索引、却缺少某条已批准且未撤销记录的 activation 行时，doctor 仍报 `ok`。统一审查的
`profileVerdict()` 对这两种情况都返回 `unverified` → `restart-required`，于是两个只读面再次分叉。

**复现**（临时目录；发布一条有效记录）：
- 把 `consumers/acp.json` 写成非法 JSON：doctor `level=ok`、`consumers.acp.status=invalid`，
  review `restart-required`；
- 写合法的 `acp` 状态但 `observedIndexUpdatedAt` 等于当前索引且 `plugins: []`（缺 activation 行）：
  doctor `level=ok`，review `restart-required`。

**修复**：doctor 在 `index.records.length > 0` 时收集：
- `unverifiedConsumers`：`status` 不是 `ok`/`absent` 的 profile；
- `missingConsumerRows`：状态 `ok`、已观察当前索引、且缺少已批准未撤销记录的 activation 行的
  `{profile, id}`。

两者都进入 `evidence`，使 `promotion.sharing` 至少 `DEGRADED`，summary/remediation 明确
“无法证明激活 → 重启 consumer”。索引 `absent` 分支保持既有 `{profile,id}` 形状与级别；未启动的
consumer（`absent`）不被当作缺行，避免把正常的首次使用当成损坏。不新增 repair，不改持久化/API。

**回归**：`test/promoted-sharing-diagnostics.test.mjs` 新增 4 项（两类分歧、absent 不回归、
正常 active 行不报告），修复前 3 项失败；聚焦 71/71。

### 2.6 独立复审 R1 发现并修复

Playtester（`gpt-6.2-sol` High）在 `6a7a2bd..f5b4799` 上独立复现四个主场景后返回 **CHANGES**，
确认以下问题；全部修复后由同一路由复审。

| # | 根因 | 修复 | 回归 |
| --- | --- | --- | --- |
| S1 | collector 把官方 `bash` 的 `isError:false` + `exitCode:1` 当作干净成功，5 次失败后写入 recovery | 干净成功复用 `recoverySucceeded()`（bash 必须 `exitCode === 0`，非 timeout/abort/signal）；非干净成功重置 streak | 5 次 bash 非零退出不写 recovery，目标仍是候选 |
| S2 | recovery 按 scope 把仍在发生的 `read` 截断一并判 `already-resolved` | collector 在退化成功时重置 streak；planner 把 `tool/recovery` 与普通 resolution 分开，只有 `lossSum < minOccurrences` 且 recovery 严格晚于 latestFailure 时才 resolve；qualifying loss 保留为候选 | 5 失败 + 5 截断 + 5 干净 + 4 截断：recovery 写入但目标仍是带 loss 的候选 |
| S3 | 同一毫秒内 recovery 与后续 failure 的 `lastSeen` 相等，`>=` 让 recovery 覆盖更晚提交的失败 | recovery resolution 使用严格 `>`；普通 success/adopted/canary 保持 `>=` | 同毫秒仍是候选，晚 1ms 才 resolved |
| S4 | review 只读每个 consumer 前 50 行；第 51 行孤儿被静默遗漏，仍报 active/no-action | consumer 投影保留真实 `rowCount`/`rowsTruncated`；超过上限产出 `consumer-rows-truncated` operator-action，指向 doctor 全量读取，并令 compose `incomplete=true`；截断提示保留既有 `review-record-cap` 槽位 | 50 记录 + 51 active、仅第 51 条孤儿 → review 不再 no-action，compose operator-action + incomplete |
| S5 | Trial 样本失败消息用 `JSON.stringify(actual)`，任务 `state/*.json` 与宿主 warn 保留工具正文 | 消息只写 label + actual/expected 的 `resultSha256`/`resultCharacters`；内存 `error.sample` 仍供 canary 回归使用 | 含 sentinel 的样本失败后 state/warn 均不含 sentinel，含摘要/长度；canary 回归仍请求内核回滚 |
| S6 | canonical 摘要的 `"[undefined]"`/`"[unavailable]"` 标记可被普通字符串伪造 | 改为类型前缀编码（null=`n`、undefined=`u`、string=`s…`、boolean=`b…`、number=`d…`、array=`a…`、object=`o…`、unsupported=`x`） | undefined vs `"[undefined]"`、null vs `"null"`、hole vs `"[unavailable]"`、NaN/-0 摘要均不同 |

Lead 复核 S4 修复时又发现 `boundedReviewActions()` 在同时存在 `review-record-cap` 与
`consumer-rows-truncated` 时会丢掉已有 cap 提示；同一 Builder 在 `b5acc6e` 中修正为保留全部
notice（room 只压缩普通动作），并补双 notice 测试；集成提交 `4a51016`。

### 2.7 独立复审 R2 发现并修复

Playtester 在 `5f7dd70` 上复验 S1–S6 与四个主场景（309 项聚焦通过）后返回 **CHANGES**：

| # | 根因 | 修复 |
| --- | --- | --- |
| R2-1 blocker | 同一毫秒提交 5 次失败 + 5 次干净成功时，collector 写入同毫秒 recovery 并置 `recoveryRecorded=true`；S3 的 planner 正确拒绝同毫秒证据，但该 episode 已耗尽，后续 195 次成功不再补写更晚的 recovery，目标持续以 100% 失败率入选 | outcome row 记录失败提交后的 `lastFailure.at`；只有 `Date.now() > at` 时才写 recovery 并置完成；同毫秒只累计 streak、不写不置完成，后续毫秒的干净成功再写一次；保持 S3 严格比较与单 episode 单事件。`f2d1031` → 集成 `7ea53fd` |
| R2-2 should | 已批准 ACP 状态自称观察当前索引但 activation 行只有 `{id}`（缺 status）时 doctor ok、review restart；仅 Web 批准且 active、ACP 状态非法 JSON 时 doctor 要求重启 ACP、review active/no-action | doctor 对已批准且未撤销记录的 activation 行：status 缺失/未知或 `skipped-unapproved`/非 already-mounted·publisher 的 `disabled`/`missing` 记入 `unverifiedActivationRows`/`inactiveConsumers`；`unverifiedConsumers` 只针对至少有一条已批准未撤销记录的 profile；未批准 profile 的损坏状态不影响重启建议。`bba81d0` → 集成 `dc79d74` |
| R2-3 blocker | 新设计文档把 `resultPath` 写成 Trial 能力样本支持的字段；`validateTaskRequest()` 实际拒绝 | 文档拆分为：Trial 能力样本比较完整返回值、不支持 `resultPath`；只有 workload steps 与 context-policy 的 functionalCheck 支持。`dd2a53f` → 集成 `8e99245` |

R2-1/R2-2 的修复回归：A1 聚焦 73/73（含 mock timers 同毫秒→1s 后恢复、单 episode 只写一次）；
review/doctor 聚焦 80/80（含缺 status 行、未批准 profile 损坏状态、`skipped-unapproved` 对齐）。

### 2.8 独立复审 R3 发现并修复

Playtester 在 `843f75f` 上确认 R2-1/R2-2/R2-3 的原始反例关闭（314 项聚焦通过），但返回
**CHANGES** 一项 should：

| # | 根因 | 修复 |
| --- | --- | --- |
| R3-1 | consumer 状态是合法 JSON、状态头正确，但 `plugins` 含 `null`。`readConsumerState()` 只校验 `plugins` 是数组；统一审查的 `base.consumers` 映射直接访问 `row.id`，抛 TypeError，`evolution_desktop audit` 返回 `E_DESKTOP_AUDIT_FAILED`。仅 Web 批准且 active、ACP 状态 `plugins:[null]` 时 doctor ok 但 audit 整体失败；已批准 ACP 的 `plugins:[null]` 时 doctor 能报缺行、review 仍抛错 | 在 `lib/promoted-sharing.js` 提供共享的 `consumerActivationRows()`：只保留普通对象、非数组、id 非空字符串的 rows；doctor 与 review 共用，丢弃空/畸形行但保留有效行。review 的 `rowCount`/`rowsTruncated`/`rows` 与其余直接读 `state.plugins` 的站点基于有效行；已批准 profile 没有有效 activation 行时落到现有 missing/unverified/restart 结论，不伪造 active、不再抛错。`61b1b5b` → 集成；随后 `347c235` 把同一判定用于 consumer 继承状态（`promoted-consumer` 的 previous rows 与 `evaluateSharedRecord` 的 previous 查找），避免畸形继承状态使 consumer 启动变 inert |

R3-1 的修复回归与 R4 复审结论见 §4。

## 3. 调查后决定不修改的项

| 项 | 结论与依据 |
| --- | --- |
| `read` 字节上限 footer 的裸文本形态（A 线索 1） | **NO-CHANGE（不可达采集路径）**。`detectDegradation()` 只处理普通会话结果；Trial/probe 执行被 collector 的 `isVerificationCall()` 跳过，普通 Desktop/ACP 会话的 renderer 形态带 `<content>` 信封。capped-read 候选本身同时接受裸 footer 与信封（`docs/audit/2026-11-24-capped-read-loss.md`）。 |
| `reconcileStableConclusions()` 按 evidence 文件名排序（A 线索 2） | **NO-CHANGE（长期 nit）**。`exp-<base36 时间>` 的位数在 2059 年前固定；届时字典序才可能与时间序分叉，且只影响最新 20 条窗口。本轮不为一千年边界改事件身份。 |
| `recordConclusion()` 事件 id 不含 target/strategy/rootCause（A 线索 3） | **NO-CHANGE（无真实路径）**。源码明确锁定 identity 字段；未找到同一 experimentId+decision+version 内容变化的可达写入。 |
| 同 profile 并发 consumer 的“每次启动挂一次”（C 线索 1） | **NO-CHANGE（设计边界）**。`lib/promoted-consumer.js` 的 `already-mounted` 只基于本会话 loader；设计承诺是每次启动挂一次，不是跨会话全局唯一。 |
| `summarizeCapabilityUsage()` 直接 `stat`/`read` promoted 源码（C 线索 2） | **NO-CHANGE（影响方向安全）**。扫描器可能读到符号链接目标，但 consumer/review 的 `readPromotedPlugin()` 会拒绝符号链接并把记录判 `source-unusable`；停用建议不会因此产生。 |
| `published.json` / consumer `plugins` 无记录数上限（C 线索 3） | **NO-CHANGE（设计边界）**。索引由 Desktop reconciler 追加、保存历史；review/usage 有 50/200 的读取上限，reconciler 会补回被删记录。没有自动删除路径。 |
| `revalidate` CLI 不核对证据 host / 数据根（C 线索 4） | **NO-CHANGE（round7/R10 已定）**。采纳是操作者显式 `--evidence` 动作；受支持 runner 每次克隆后按当前宿主取证。 |
| canary 回滚后、结论写入前的崩溃窗口（C 线索 5） | **已知残余**。回滚路径删除 journal；没有等价 durable sidecar 可重建。R10 §3 已登记。 |
| 内核级 `targetProfiles` 与 owner-gate 返回值的交叉绑定（B 线索 1） | **NO-CHANGE（通道双重校验）**。ACP `confirm` 与 Desktop `waitForApproval` 都按 plan 声明的 profile 范围校验；内核级绑定属于新增机制，不是本轮缺陷。 |
| `canary-verification.js` 不拒绝非 plain 对象（B 线索 2） | **NO-CHANGE（生产入口只产生 JSON）**。协议校验、工具参数与磁盘 JSON 回放都只产生普通对象；没有可达调用链。 |
| consumer 从未启动（状态 `absent`）时 review 报 `restart-required`、doctor 报 `ok` | **NO-CHANGE（语义差异）**。doctor 的健康定义是“没有失败、孤儿或不可读状态”，首次启动本身不是健康问题；review 的 restart 是激活提示。B4 只把不可读状态与“自称已观察当前索引却缺行”纳入 degraded，不把正常的 absent 首次使用误报为损坏。 |
| R10 的 `priorIneffectiveConclusion()` 窗口、canary 失败无 conclusion 行、failure/degradation target 回退、usage 离线投影等 NO-CHANGE 项 | **保持登记**。本轮子代理与 Lead 复核未发现新证据；不为边缘规模扩大机制。 |

## 4. 验证

- 反证：A1 主用例在修复前 3/5 失败（无 recovery、planner 仍选目标）；C-1 的 7 项在修复前全部
  失败；B-1 的端到端 2 项在修复前失败；B-2 的 evidence 断言在修复前失败（`actualToolOutput`
  含正文）；R1 的 S1/S2/S3 在修复前 4 项失败，S4 的 consumer 行截断在修复前 no-action，S5 的
  state/warn 在修复前含 sentinel，S6 的摘要标记可被字符串伪造。
- 聚焦：`test/review-fix-tool-recovery.test.mjs`、`test/experience-degradation.test.mjs`、
  `test/experience-plan.test.mjs`、`test/experience-attribution.test.mjs` → 73/73（含 R2-1 mock timers）；
  `test/promoted-sharing-diagnostics.test.mjs`、`test/self-evolution-review.test.mjs`、
  `test/desktop-task-client.test.mjs` → 103/103（含 R2-2 缺 status/未批准 profile/skipped-unapproved、
  R3-1 空行与 audit 路径）；
  `test/promoted-sharing.test.mjs`、`test/promoted-consumer.test.mjs` 与上述 review/doctor →
  149/149（含 `consumerActivationRows` 与继承状态）；
  `test/review-fix-host-lossless-value.test.mjs`、`test/desktop-task-host.test.mjs` → 59/59；
  以及 shared-experience / recall / diagnostics / release-pin 等相关套件。
- 全量：最终树 `NODE_OPTIONS=--max-old-space-size=4096 npm test` —— **2342 项，2340 通过 / 0 失败 / 2 跳过**（含 R10 的基线为 2297）。
- 打包：`npm run pack:check`（开发阶段）→ **17/17 通过**；工作树是 `0.2.20` 固定点的已提交
  后继，固定产物与既有证据未改动；未执行 `--release` 或任何发布动作。
- 独立复审：R1（`gpt-6.2-sol` High）CHANGES（S1–S6，已修复）；R2 同一路由 CHANGES
  （R2-1/R2-2/R2-3，已修复）；R3 同一路由 CHANGES（R3-1，已修复）；R4 对最终 HEAD 的复验结论
  见交付回复。未取得 APPROVE 前不写成通过。
- CI：`843f75f`（R3-1 修复前）13/13 全绿；R3-1 修复后的最终 HEAD 推送后重新运行，结果见交付回复。

## 5. 实际收益与剩余风险

**收益**

- 已恢复的工具目标在 5 次连续干净成功后写入可复核的恢复事实，planner 不再以 100% 失败率反复推荐
  已恢复目标；截断/降级成功、bash 非零退出不会伪造恢复；存在 qualifying loss 时恢复事实不会压掉
  独立的退化证据。
- 索引存在但记录被删除/未批准、consumer 状态不可读、或状态自称已观察当前索引却缺少 activation
  行时，doctor 与统一审查不再报健康；两个只读面都给出一致的重启结论，操作者能看到仍在运行的
  孤儿挂载或无法证明的激活。
- Desktop 宿主的样本/workload 判定不再把 `undefined` 当作 `null`；Trial 样本失败消息与 canary
  evidence 只保留摘要/长度，不保留工具正文；摘要编码带类型前缀，普通字符串不能伪造 nullish/
  占位标记；canary 不会因字段缺失被误判通过。
- review 的 consumer 行超过 50 条时不再静默：给出有界 operator notice、指向 doctor 全量读取，
  并令 review 显式 incomplete。
- consumer 状态里的空/畸形 activation 行由共享 `consumerActivationRows()` 丢弃、有效行保留；
  已批准 profile 没有任何有效行时落到 missing/unverified/restart，未批准 profile 的空行不影响；
  consumer 的继承状态与 `evaluateSharedRecord` 的 previous 查找使用同一判定，不再因 `plugins:[null]`
  让 review/audit 或 consumer 启动整体失败。

**剩余风险**

- A1 的 recovery 需要同一 collector 进程观察失败与后续 5 次连续干净成功；失败后重启且不再失败的
  目标仍按 recency 衰减，直到出现新失败或新恢复证据。这是有意的有界行为，未新增启动时历史扫描。
- recovery 只在没有 qualifying loss 时 resolve；存在损失时目标保持候选，即使最近有干净成功 streak。
  这是保守取舍，宁可多留一轮候选，也不让恢复事实压掉独立损失。
- 同一毫秒的 failure 与 recovery 不算已恢复（严格 `>`）；collector 会推迟到后续毫秒的干净成功
  再写 recovery，不会耗尽 episode；若失败后所有干净成功都停在同一毫秒，目标保持候选（保守，
  不会隐藏更晚提交的失败）。
- C-1 的 review 只读取前 50 条 consumer 行；超过上限时给出 consumer-rows-truncated operator
  notice 并指向 doctor 全量读取，但 review 本身不逐行评估未读尾部。
- B-1 的 `losslessCanonicalText()` 对极深非循环值可能栈溢出；`sampleEvidence()` 捕获后使用固定
  `x` marker，不改变任务结果，但该极端场景未做专门压测。
- B-2 只修生产宿主；内核的通用 `evidence` 仍接受直接调用方传入的任意有界证据（同用户传输层，
  不是授权边界）。`scripts/acceptance` 的 probe 不属于生产路径，未改。
- R10 的最终独立 APPROVE 仍缺失（Codex 用量限制）。R11 的 Playtester 复审覆盖合并树；如果
  R11 复审取得 APPROVE，可作为 R10 已修项的补充复核，但 PR #102 仍是本 PR 的合并前提。
- 既有 NO-CHANGE 项与 R10 §5 的残余风险保持有效。
