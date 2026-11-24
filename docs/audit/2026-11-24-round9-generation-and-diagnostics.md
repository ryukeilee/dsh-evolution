# 完整自我进化主链第九轮开放性研究（2026-11-24）

## 1. 范围与方法

基线：`efedef9`（PR #98 head）。说明：开题时用户以「合并 PR #98 后的 main」为前提，但实测 `origin/main` 仍为 `443d467`、PR #98 仍为 OPEN，本轮不擅自合并，改以 #98 交付的代码状态 `efedef9` 为基线；本轮新分支包含 #98 的 canary 结论修复。

- 多个并行子代理分别复评上一轮登记的三项问题、独立调查完整主链的新缺陷，并对文件代际修复做反方交叉验证。
- 主代理对进入修复的发现独立复核根因，按「旧源码复现失败 → 新源码通过」取证。
- 全程只读研究；复现仅用 `os.tmpdir()` 与合成数据；未触碰正式 DSH_HOME、正式经验库或已安装插件；未发布版本、未创建 tag。

## 2. 确认并修复的问题

### 2.1 回收 floor 无法区分内容相同但生命周期不同的文件（high）

**根因**：`planLogPrune()` 只把 prior/tail 写成 `{bytes, digest}`。事件桥是 at-least-once，被裁记录与保留记录逐字节相同时，prior 文件开头恰好就是 tail 字节。`classifyLogFloorDescriptor()` 若先看 tail 会把未截断的 prior 误判 `already-truncated`，截断永不执行、被裁 marker 可能复活；上一轮曾试的「prior 优先」又在截断后追加重建原前缀时二次截断，丢掉追加记录。仅靠字节摘要无法区分这两个状态。

**修复**：只在 ambiguous（prior 前缀 == tail）时，floor 的 `prior` 额外记录当时的 dev/ino（`(ambiguousPrefix: true, identity: {dev, ino})`），并在 zod schema 中作为可选字段接纳；旧 floor 无这两个字段时保持历史字节摘要行为。分类器据此分流：

- 同代（dev/ino 与 floor 相同）且完整 prior 摘要匹配 → `deferred`（截断待执行），即使字节前缀等于 tail；
- 异代（截断的 rename 产生新 inode，后续追加保留该 inode）→ 永不按 prior 判定，只按 tail 前缀判 `already-truncated`/`unknown`；
- 其余保持历史判定。

`reclaimLog()` 与 dry-run 路径都向 `planLogPrune()` 传入当前文件身份；dry-run 的 `requireReclaimContinuation()` 把共享分类器的 `pending-truncation` 判定提前到 tail 字节快捷路径之前（上一轮 S2）。

**反证**：还原基线源码后 `test/review-fix-retention-floor-generation.test.mjs` 中「待截断 prior 被误判 already-truncated」「追加重建前缀后旧源码不截断」两项失败；修复后 7/7 通过。包含真实领域存储的集成用例：重复投递 → reclaim 截断 → 再次追加相同字节 → flush → 重启 replay，追加字节完整保留。

### 2.2 doctor 的 promotion.sharing 与统一审查口径不一致（should）

**根因**：`diagnoseSharing()` 在 `index.status === 'ok'` 但存在逐条 `index.invalid` 时只把它放进 evidence，不进 `problems`/`blocking`，报 OK；统一审查 `self-evolution-review.js` 因 `summary.invalid > 0` 报 blocked。索引缺失时提前 return，完全不扫描 consumer，把「索引已删但仍 ACTIVE 挂载」报成 OK。remediation 建议从 `published.json` 删除记录，而启动 `reconcileSharedIndex()` 会从 stable sidecar 重新发布，操作无效。

**修复**（只改诊断侧，不动 reconciler）：把 `index.invalid` 计入 blocking 与 problems，level 与统一审查一致；索引缺失时仍扫描 consumer，有 ACTIVE 行则报 DEGRADED 并给出重启建议；把无效 remediation 换成 re-promote 或 `dsh-evolution-shared disable` 这类持久动作。

**反证**：旧源码上两项新测试失败（`blocked` 实为 `ok`、`degraded` 实为 `ok`）；修复后 `test/promoted-sharing-diagnostics.test.mjs` 10/10 通过。

### 2.3 本轮全链独立调查新增的实质问题

| # | 根因 | 修复 | 反证 |
| --- | --- | --- | --- |
| F1 | 自主观察者 transient 失败后，只有部分 cleanup 状态释放决策占位；`not-recovered`/`failed` 时占位永久滞留，后续观测永远返回 `prior-decision-requires-owner`（opt-in 路径） | 所有 cleanup 状态都释放占位（失败进 `pendingDecisionReleases` 兜底）；占位仍被继承时保留冷却而非给出终局式回答。runtime claim 与实验记录仍独立门禁新 Trial | 新用例在旧源码失败（占位滞留、后续 3 次均 `prior-decision-requires-owner`），修复后 10/10 |
| F2 | workflow probe 的 `expected` 只查字节长度；`stableJson()` 在深度折叠后把不同叶子映射为同一 `"[max-depth]"`，两个期望值共用 `expectedDigest`/`scenarioDigest`，错误结果可被判正确并驱动假 benefit | 复用无损深度/循环/非有限值校验，折叠输入直接拒绝，digest 算法不变 | 旧源码上两个仅深层不同的期望摘要相同；修复后拒绝，6/6 |
| F3 | Desktop 任务把 `plan.requestedTargetProfiles` 只用于无确认预检；带确认的 promote 用客户端 `confirm` 默认值 `['acp']`，可静默收窄或扩大发布范围 | owner 确认前比对两组 profile（顺序无关），不一致以 `E_DESKTOP_APPROVAL_MISMATCH` 拒绝；状态持久化 requested 值；提示词要求原样传回 | 旧源码完成确认并发布；修复后 0 次确认，49/49 |
| F4 | `recall()` 外层 `LIMIT 2000` 之外的知识不进入统计，返回 `truncated:false` 的空结果，而同一 store 的 `discover()` 如实报截断 | 读一次知识总数作为 `scanned`，`truncated` 纳入外层窗口截断 | 旧源码两项用例失败；修复后 2/2 |
| F5 | guard 的非阻断诊断出口直接 emit 原始 `error.message`，并从 catch 中读取可能抛异常的 `exec.arguments.file_path` | 只 emit `safeErrorDto` 的有界摘要，`filePath` 有界投影且读取置于保护范围 | 旧源码泄漏 `SECRET_token=abc123` 且抛错；修复后已脱敏、不抛错 |

反方交叉验证对 floor 与 doctor 修复给出 SOUND、无 blocker，并提出两项 should：缺 SIGKILL 落在 ambiguous commit→truncate 窗口的专项测试（逻辑分析仍正确）、doctor 注释引用统一审查的 `restart-required` 与 `index.status:'absent'` 时提前 return 的事实不符。后者已改为如实描述；前者登记为验证缺口。

### 2.4 sol-loop 独立复审发现并修复的问题

| 项 | 根因 | 修复 |
| --- | --- | --- |
| S1 blocker | doctor 的 `event-bridge-trim-partial-tail` 用 rename 更换日志 inode；待补完的 ambiguous floor 下裁剪残尾会让代际分类器认为截断已完成，已裁 marker 可复活 | 裁剪前用共享分类器检查已提交 floor，仍 `deferred` 时跳过并提示先补完截断；新增 doctor 回归 |
| S2 blocker | workflow probe 只校验期望值；观测值中的真实 `undefined` 与期望里的 `"[undefined]"` 在 `stableJson()` 下同摘要，可伪造正确性 | 选中结果同样走无损校验，稀疏数组/非有限值/循环/深度折叠一律拒绝；新增公开 `probe()` 回归 |
| S3 blocker | `finalizeExperienceRecall()` 丢弃来源的 `truncated:true`，两个公开检索入口仍报完整 | 来源摘要携带 truncated 并纳入最终判定；`evolution_history`/`recall` 共用该结论 |
| S4 should | guard 诊断虽脱敏错误文本，但 `file_path` 原样发出前 200 字符 | 成功与异常分支都用 `redactCredentialShapes()` 后限长 |
| S5 should | ACP `confirm` 把缺省 `['acp']` 写盘，Desktop 后才拒绝并回退 Trial；状态投影缺 `requestedTargetProfiles` | ACP 写盘前比对计划范围并拒绝；状态投影返回请求范围；Desktop 最终校验保留 |
| S6 should | doctor 建议对畸形发布记录执行 `dsh-evolution-shared disable`，但 CLI 只能选择通过校验的记录 | 畸形行只提示 re-promote，明确 CLI 不可定位 |
| S7 nit | consumer 状态 `plugins:[null]` 让 doctor 抛 TypeError，整份报告失败 | 投影前校验行形状，畸形行不计入诊断 |

sol-loop 第 2 轮再发现 3 blocker、1 should、1 nit，均已修复并反证：S8 医生只看 committed floor、漏掉 `pending.retention`（改为与启动恢复相同的 pending 优先）；S9 已完成 floor 的 tail 覆盖残行时裁剪会破坏 replay 前缀证明（裁剪前校验保留字节仍含完整 tail）；S10 非普通对象（如 `new Date(0)`）序列化成 `{}` 可满足空记录预期（无损校验拒绝非普通对象/稀疏数组）；S11 先截 200 字符再脱敏会让跨边界凭据泄漏（改为先脱敏再截短）；S12 每次 recall 全表计数（改为多读一行判断外层窗口，`scanned` 为实际读取数）。

## 3. 复评后决定不修改的项

| 项 | 结论 | 依据 |
| --- | --- | --- |
| 自主候选资源错误被误判为环境失败 | **NO-CHANGE**。代码级误分类确实存在，但默认入口无条件 `dailyAutonomousObservation=false`，且生产入口不配置 `autonomousStrategies`，`observeAutonomous()` 在 `no-approved-strategy` 提前返回；即便 opt-in 触发，后果有界（30s cooldown、每次最多一次重试、不写持久记忆、永远停在 `candidate-awaiting-confirmation`）。按来源粗粒度改会把观察者自身资源门错误误判，反而重新引入永久压制；逐个包裹回调侵入性大、收益低。 | `index.js:83-86`；`registration.js:567,601,643`；`orchestrator.js:5523,8398,8692-8713` |
| doctor 的 `fresh-unowned` 锁窗口 | **NO-CHANGE（前提不成立）**。锁在 journal **之前**以 `mkdir` + 原子 `writeAtomic(lock.json)` 获取；`mkdir` 与 `lock.json` 之间崩溃时尚无 journal，`recoverInterruptedPromotion()` 的首步 `promotionStateKnown()` 返回 false，doctor 也不提供 repair。有 prepared journal 时 writer 必已原子写完 lock.json，`active` 为 true，doctor 跳过修复。两边都不删锁，无行为分叉；唯一后果是 15min TTL 内 promotions 被保守阻塞，符合不变量 11。 | `orchestrator.js:4483-4489,4817-4850,4894-4928`；`diagnostics.js:2651-2658,3185-3192` |
| 发布索引 `updatedAt` 毫秒精度且非单调（F6） | **NO-CHANGE（窄窗口残余风险）**。同一毫秒内两次发布时，严格不等比较会让已启动 consumer 认为无需重启；需要两次发布落在同一毫秒且 consumer 已观察旧值。改为单调 revision 涉及发布索引格式与所有 consumer 比较逻辑，收益与风险不匹配。 | `promoted-sharing.js:329-331,938,1404-1409` |
| `recall()` 2000 上限本身 | **NO-CHANGE（既有定论）**。上限保持；本轮只修截断信号语义，不扩大窗口。 | 第六轮审计；本文件 §2.3 F4 |
| canary failureMode / 矛盾结论 / usage 投影 / 撤销回写等八轮已定项 | **NO-CHANGE**。本轮子代理与父代理复核其仍有效，未重复调查。 | 第八轮审计与既有测试 |


sol-loop 第 3 轮再发现 2 blocker、1 should，均已修复并反证：S13 回收会认证无法验签的未终止末行，让日志既不能裁剪也不能追加（改为在提交 floor 前拒绝，交 doctor 先修残尾）；S14 校验按自有下标、摘要却按迭代器读取数组，自定义迭代器可让反向数组被判为符合预期（两者统一按自有下标生成普通快照，普通数组摘要不变）；S15 精确键补回唯一窗口外记录仍报 truncated（改为只在该行不是被补回的精确键时报告）。

## 4. 验证

- 反证：floor 生成修复两项核心用例在旧源码失败，修复后 7/7（含真实领域存储集成）；sharing 诊断两项新用例在旧源码失败，修复后 10/10。
- 聚焦：回收锁定、归档删除、跨进程边界、领域存储、doctor floor、sharing 诊断、自主重试、Desktop 任务、probe 场景、guard 脱敏、recall 窗口共 100+ 项分批全绿；新增 7+10+1+6+2+2 项均通过，反证在旧源码上分别失败。
- 领域差分基线：本轮把 `domain-storage.js` 的改动登记为新的逆向 round（`test/domain-storage/floor-generation-baseline.js`），`domain-storage-write-path-equivalence` 与 `load-projection` 恢复为等价通过。
- 全量：最终树 `NODE_OPTIONS=--max-old-space-size=4096 npm test` —— **2240 项，2238 通过 / 0 失败 / 2 跳过**（基线含 PR #98 为 2218）。
- 打包：`npm run pack:check` **17/17** 通过；工作树是 v0.2.19 固定点的已提交后继，固定点、产物与既有证据未改动；未执行 `--release` 或任何发布动作。
- 独立复审：反方子代理对 floor/doctor 修复给出 SOUND、无 blocker；sol-loop（codex / gpt-6.2-sol / high）共 5 轮：第 1 轮 CHANGES（3 blocker、3 should、1 nit），第 2 轮 CHANGES（3 blocker、1 should、1 nit），第 3 轮 CHANGES（2 blocker、1 should），第 4 轮 CHANGES（1 blocker、1 should），均逐条复核修复并用旧源码反证；第 5 轮为预算最后一轮，结论以 PR 描述为准。

## 5. 剩余风险

- ambiguous floor 的 commit→truncate 窗口没有专项 SIGKILL 用例（反方 should-1）：逻辑上崩溃在 rename 前后分别落 `deferred` / `already-truncated`，但未实测；只有通过外部 SIGKILL 注入才能完全覆盖。
- 仅靠 dev/ino 不能覆盖同一 inode 被原地覆盖成 prior 字节、或 inode 被复用等外部操作；这类操作不在受支持的跨进程协议内，floor 本身也会被破坏，需要操作者恢复数据根。
- 旧版（无 identity）的 ambiguous floor 仍保持历史字节摘要行为；下一次 reclaim 生成带 identity 的新 floor 后才获得代际保护。
- 共享经验结论仍是有界摘要；usage 投影仍是显式 operator CLI 的离线事实。
