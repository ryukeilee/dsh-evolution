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

## 3. 复评后决定不修改的项

| 项 | 结论 | 依据 |
| --- | --- | --- |
| 自主候选资源错误被误判为环境失败 | **NO-CHANGE**。代码级误分类确实存在，但默认入口无条件 `dailyAutonomousObservation=false`，且生产入口不配置 `autonomousStrategies`，`observeAutonomous()` 在 `no-approved-strategy` 提前返回；即便 opt-in 触发，后果有界（30s cooldown、每次最多一次重试、不写持久记忆、永远停在 `candidate-awaiting-confirmation`）。按来源粗粒度改会把观察者自身资源门错误误判，反而重新引入永久压制；逐个包裹回调侵入性大、收益低。 | `index.js:83-86`；`registration.js:567,601,643`；`orchestrator.js:5523,8398,8692-8713` |
| doctor 的 `fresh-unowned` 锁窗口 | **NO-CHANGE（前提不成立）**。锁在 journal **之前**以 `mkdir` + 原子 `writeAtomic(lock.json)` 获取；`mkdir` 与 `lock.json` 之间崩溃时尚无 journal，`recoverInterruptedPromotion()` 的首步 `promotionStateKnown()` 返回 false，doctor 也不提供 repair。有 prepared journal 时 writer 必已原子写完 lock.json，`active` 为 true，doctor 跳过修复。两边都不删锁，无行为分叉；唯一后果是 15min TTL 内 promotions 被保守阻塞，符合不变量 11。 | `orchestrator.js:4483-4489,4817-4850,4894-4928`；`diagnostics.js:2651-2658,3185-3192` |
| canary failureMode / 矛盾结论 / usage 投影 / 撤销回写等八轮已定项 | **NO-CHANGE**。本轮子代理与父代理复核其仍有效，未重复调查。 | 第八轮审计与既有测试 |

## 4. 验证

- 反证：floor 生成修复两项核心用例在旧源码失败，修复后 7/7（含真实领域存储集成）；sharing 诊断两项新用例在旧源码失败，修复后 10/10。
- 聚焦：回收锁定、归档删除、跨进程边界、领域存储、doctor floor、sharing 诊断共 **110/110** 通过（含新增 7 项）。
- 全量、打包与独立复审结果以本文件最终提交为准。

## 5. 剩余风险

- 仅靠 dev/ino 不能覆盖同一 inode 被原地覆盖成 prior 字节、或 inode 被复用等外部操作；这类操作不在受支持的跨进程协议内，floor 本身也会被破坏，需要操作者恢复数据根。
- 旧版（无 identity）的 ambiguous floor 仍保持历史字节摘要行为；下一次 reclaim 生成带 identity 的新 floor 后才获得代际保护。
- 共享经验结论仍是有界摘要；usage 投影仍是显式 operator CLI 的离线事实。
