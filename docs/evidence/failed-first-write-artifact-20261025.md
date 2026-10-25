# 2026-10-25 首次写入失败留下的残件

基线：`origin/main` 的 `e7c0a30`；工作树除既有未跟踪性能材料外干净。实现提交：本目录证据记录的
`HEAD`。没有修改版本号、`release/` 固定点或官方 DSH 源码，没有读取正式用户数据，没有重启
`docs/performance/` 已撤回的性能方向。

## 1. 问题与根因

三个文件先用 `O_EXCL`（`wx`）创建、再写入，而同一份代码会永久拒绝读取只写了一半的残件，
于是一次可捕获的写入/关闭失败就变成永久故障：

| 站点 | 读取侧为什么拒绝 | 后果 |
| --- | --- | --- |
| `lib/orchestrator.js` `acquireTargets()` 的目标所有权 claim | 只接受完整 JSON claim，且按 AGENTS §4 不删除无法解释的现场 | 0 字节 claim 使该 target 永久报 `experiment ownership is unreadable for <target>`；端口无恢复路径，doctor 也没有这项检查 |
| `lib/index.js` `storageConfig()` 的 `data/event-bridge.key` | 必须是 64 位十六进制（必须如此：替换 key 会让已写入的 MAC 全部失效） | 0 字节 key 使 bundle 在之后每个会话都拒绝加载：`Evolution event bridge key is invalid; refusing to replace it` |
| `lib/domain-storage.js` `acquireArchiveLock()` 的 `domain-archive.lock` | `readLockOwner()` 只能把"解析不出 pid"当"没有具名 owner" | 空锁要付 `LOCK_SETTLE_MS` 结算窗口；被截断的 pid（`"1"` of `"1234"`）读成另一个可能存活的 pid，永久拒绝该归档 |

修复前的可复现输出（独立脚本，pre-fix 工作树）：

- claim：注入一次写入失败后留下 1 个 0 字节 claim；下一次 `evolution_trial` 报
  `experiment ownership is unreadable for plugin:claim`。
- key：注入一次"open 成功后写入失败"后留下 0 字节 key；下一次 `storageConfig()` 报
  `Evolution event bridge key is invalid; refusing to replace it`。

## 2. 修改

三处共用同一形状：用显式的 `fs.openSync(..., 'wx')` 证明"这个条目是本次调用创建的"，并在抛出
原始存储错误之前，只清理本次创建、且尚未写成的条目。`EEXIST` 是唯一能证明"什么都没创建"的
错误，因此别的进程或早先运行写入的 claim / key / lock 永不被触碰。

- **key / claim**：`created` 由 `openSync` 的返回证明，`wrote` 在写入返回后置真；只有
  `created && !wrote` 才删除。写入失败时先尽力 `close`，再抛原始写入错误——`close` 再失败也
  不覆盖它。
- **完整写入后 `close` 失败**：key 与 claim 保留。字节已完整，另一个会话可能已经读到该 key、
  或已按 experiment id 接管该 claim；把这些有效文件删掉会让那个会话继续用一个下一个会话不再
  存在的 key。`close` 错误仍如实报给调用方。
- **archive lock**：清理条件相同，但删除走模块既有的 identity fence
  `removeLockIfUnchanged()`（rename → 核对 inode → 恢复或 unlink），不再按路径 `rmSync`。因为
  空锁可被回收，一个在 open 与 write 之间停顿超过 `LOCK_SETTLE_MS` 的端口可能在清点时看到别人
  的锁，按路径删除会删掉它。acquire 失败时（含 `close` 失败）一律清理：没有返回 token 就没有
  owner，保留只会把本进程 pid 当成存活 owner，令该进程此后每次 `openDomainStorage()` 都被拒——
  这正是它与 key / claim 的不对称所在，key 与 claim 是"被消费"的产物，锁只在与 token 一起时才
  有意义。
- **锁 token 的 identity 改为 `fstat` 本次描述符得到的 inode**，不再回读路径。这是修复过程中由
  复审发现的既有隐患：停顿端口会把 pid 写进已被回收的游离 inode，而按路径读 identity 会把新
  owner 的 inode 当成自己的 token；同进程两个端口的 pid 字节相同，于是两边都能通过
  `assertArchiveLockHeld`，互相覆盖提交。改用 `fstat` identity 后，停顿端口无法证明拥有该路径，
  首个持久写入以 `E_DOMAIN_ARCHIVE_LOCK` 被拒，不会覆盖活着的 owner。

`test/domain-storage/domain-storage-baseline.js` 的差分锚点同步了新的 `acquireArchiveLock()`
文本；它仍逐字节重建 `release/dsh-evolution-0.2.0-rc.8.tgz` 的 `lib/domain-storage.js`，单次
出现保护与字节相等断言未变。

## 3. 验证

聚焦回归（全部实际执行）：

```sh
node --max-old-space-size=4096 --test test/failed-create-then-write-recovery.test.mjs          # 9/9
node --max-old-space-size=4096 --test test/domain-storage/*.test.js                            # 136/136
node --max-old-space-size=4096 --test test/storage-transaction-init-lock.test.mjs \
  test/review-fix-storage-lock-cas-overwrite.test.mjs test/review-fix-storage-lock-fencing.test.mjs \
  test/review-fix-storage-lock-reclaim.test.mjs                                                # 19/19
node --max-old-space-size=4096 --test test/orchestrator-durability-trial-failure-cleanup.test.mjs \
  test/orchestrator-integrity-bounded-redaction-cleanup.test.mjs \
  test/review-fix-redaction-coercion-cleanup.test.mjs test/trial-recovery-boundary.test.mjs \
  test/entry-failure-diagnostics.test.mjs                                                      # 35/35
```

`test/failed-create-then-write-recovery.test.mjs` 的九个用例分三组：三个覆盖写入失败（key /
claim / lock，断言残件已删、原始错误到达调用方、内存 claim 未泄漏、下一次尝试成功）；一个覆盖
lock 的"写入完整后 close 失败"（按创建 inode 删除，重试可立即取得归档）；五个断言"什么不能
被删除"：创建前失败不删别人的 key、key 与 claim 在完整写入后的 close 失败下保留、别人的锁在
失败清点时按 inode 保留、停顿端口不得声称拥有已被回收的锁。

差分与回归证据：把 `lib/` 临时回退到父提交后，key/claim/lock 三条残件用例与
"停顿端口"用例均失败（claim 与停顿两条给出具体断言失败，key/lock 两条在父提交上失败于注入点
不存在，见 §5）；`test/domain-storage` 的等价性用例在每次改动后都重新证明重建源码与固定产物
字节相同。

全量与打包：

| 检查 | 结果 |
| --- | --- |
| Node **22.23.4**，`NODE_OPTIONS=--max-old-space-size=4096 npm test` | **936/936**，0 失败，exit 0 |
| Node **24.22.1**，同上 | **936/936**，0 失败，exit 0 |
| `npm run pack:check` | 通过；判定为固定点的已提交后继，固定点仍描述它自己记录的 `sourceCommit` |
| `npm run release:verify` | 固定产物未变：sha256 `d0c119f0…`、contentSha256 `fb4e77b5…`，与 `release/manifest.json` 一致 |
| `node scripts/release/verify-artifact.mjs dist/… --content-only --tree` | contentSha256 `5eefc517…`，等于当前树声明的内容 |

宿主验收：`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-rc.2` 各 21 步、均 `ok: true`，证据为同目录
`create-then-write-20261025-dsh-<host>.json`，三者内容摘要均为 `5eefc517…`，与当前树相同。

## 4. 复审

六轮独立复审（必要时同步复现）。前四轮各发现一个阻塞项，均已修复：`storageConfig()` 无法证明
自己创建了 key（可能删掉别人刚建的 key）；成功写入后 close 失败仍被当成残件删除；锁清理按路径
删除、绕过 identity fence；锁 token 的 identity 回读路径（既有隐患，见 §2）。第五轮提出"close
失败不应清理锁"，经裁决为**不成立**：保留锁会让该进程此后每次 `openDomainStorage()` 都被自己
的 pid 拒绝，且没有端口持有它的 token；因此保留现有行为，并补一条固定该裁决的用例。第六轮
`accept with changes`，只要求更正测试注释里的分组计数，已改。

## 5. 检查范围与未采纳项

- **不为性能做改动，不声明性能收益。** `docs/performance/` 已撤回的方向（`appliedDigest` 复用、
  事件日志读块尺寸、retention `historyView`、入口 `schema.parse` 跳过）本轮未重启。
- `mutate()` 在提交成功后 `fs.rmSync(stage)` 失败仍向上传播，未改：仓库既有约定是"操作本身成功
  时收尾清理失败仍然让调用失败"（见 `lib/registration.js` 工具收尾 flush 的注释），本项与之
  矛盾，因此不视为缺陷。
- `lib/dockyard-domain/knowledge.js` 的 `compactValue()` 对 JSON 自有的 `__proto__` 键会静默改写
  原型，使两个仅在该键上不同的策略折叠成同一条 knowledge 身份（`count` 合并、`eventIds` 混合）。
  已复现未修改：它改动共享的身份投影，会改变既有持久化的去重结果，超出本次最小修复范围，记为
  后续独立议题。
- `lib/domain-storage.js` 的 `assertLiveTreeUnchanged()` 只校验快照内的路径；事务期间由外部写入者
  新建的合法归档文件不触发隔离错误。触发它需要外部写入者绕过归档锁，概率极低，本轮不扩范围。

## 6. 剩余风险

- **崩溃路径未覆盖。** 进程被 kill 或断电发生在 `wx` 创建之后、错误处理之前，仍会留下 0 字节
  残件，三个读取侧仍会永久拒绝。按 AGENTS §4，读取侧不得猜测、静默合并或删除无法解释的持久
  现场，因此崩溃恢复需要单独设计（诊断 + 显式授权修复），不在本次范围。本次只修复可捕获的
  写入/关闭失败。
- claim 在完整写入后 close 失败时保留自己；若同一 target 被另一个 experiment 提出，会读到
  `unsafe parallel experiment conflicts on <target>` 直到该 experiment 结束或进程退出。这是修改前
  既有行为，未新增，但它是本修复没有消除的边界。
- key / lock 两条残件用例在父提交上的失败原因是"注入点不存在"而不是"观察到残件"：Node 的按路径
  `writeFileSync` 使用模块内部 `openSync`，无法从外部拦截；父提交的实际行为由 §1 的独立脚本输出
  记录，未固化为仓库测试。
- 验证只在本机（darwin/arm64）与三个官方宿主上完成；没有覆盖网络文件系统、只读挂载、配额
  （`EDQUOT`）或真实磁盘满。
