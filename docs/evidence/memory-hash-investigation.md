# `evolution-memory.json` 哈希变化调查（0.2.0-rc.6 / rc.7）

## 结论

官方 CLI 卸载、重装后 `$DSH_HOME/storages/evolution/evolution-memory.json` 的
SHA-256 变化，**不是卸载或重装改写了用户数据，也不是持久化不一致**。变化发生在
重装后重新执行 core flow（`inspect → propose → trial → measure → revert`）时：
`EvolutionMemory.record()` 按 `signature` 命中同一条模式记录，就地更新

- `count`（1 → 2）、
- `lastSeenAt`、
- `evidence.at` 与 `result.rollback.at`（最新一次观测的时间戳），

而 `signature`、`firstSeenAt`、`experiment`（含模式首次出现的 `experiment.id`）、
`problem`、`status`、条目数、文件大小与键集全部不变。这是**真实的状态变化**
（同一失败模式被第二次观察到），语义正确，不是无害的字节噪音，也不是状态损坏；
无需为哈希变化本身修改代码。

## 可复现证据

### 1. 历史上 22 份验收证据（rc.3 – rc.6，两个宿主）

`docs/evidence/` 中 22 份 acceptance 证据全部呈现同一模式：
`memoryShaAfterCore == memoryShaBeforeUninstall`（脚本断言卸载不改数据），
`memoryEntriesAtUninstall == memoryEntriesAfterReinstall`（条目保留），
但 `memoryShaAfterReinstall != memoryShaBeforeUninstall`。
每份证据的 `core-flow-after-reinstall` 都记录
`memoryEntriesBefore == memoryEntriesAfter == 1` 且
`existingMemoryRetained: true`，即变化发生在条目内部而非条目集合。

### 2. 双宿主实测（rc.6 固定产物 + rc.7 源码）

对 `release/dsh-evolution-0.2.0-rc.6.tgz` 在隔离 runtime / `$DSH_HOME` 下用
`scripts/acceptance/run-host-acceptance.mjs` 复跑，并用一个 50 ms 轮询的
watcher 快照每次写入的 `evolution-memory.json`：

| 宿主 | `memoryShaBeforeUninstall` | `memoryShaAfterReinstall` | 条目 |
| --- | --- | --- | --- |
| `0.2.1-alpha.1` | `26c06faf9f2e38cd…` | `3470d25a5a868f29…` | 1 → 1 |
| `0.2.0-rc.2` | `be5bfdf5092544c0…` | `8429477bd6377c3b…` | 1 → 1 |

两次运行的 21 个验收步骤全部通过。快照时间线与 acceptance 步骤时间戳逐点对齐
（alpha.1 实测）：

| 快照 | sha256（前 16 位） | 大小 | 时间 | 对应步骤 |
| --- | --- | --- | --- | --- |
| v001 | `26c06faf9f2e38cd` | 1598 | 18:24:43.278 | `core-flow`（18:24:43.304） |
| v002 | `3470d25a5a868f29` | 1598 | 18:24:52.096 | `core-flow-after-reinstall`（18:24:52.098） |
| v003 | `1d449357277751a8` | 3305 | 18:24:58.532 | `promotion-promote`（18:24:57.610） |
| v004 | `9527045f704152fd` | 4996 | 18:24:59.877 | `promotion-restart-and-rollback` |

`plugin-remove`（18:24:47.798）→ `body-after-uninstall`（18:24:49.068）→
`plugin-reinstall`（18:24:49.749）之间**没有任何快照**，证明卸载与重装本身不写该文件；
v003/v004 的条目增长来自随后的 promotion 实验，属于不同模式的新记录。

### 3. 精确 diff（`memoryShaBeforeUninstall` → `memoryShaAfterReinstall`）

```diff
-            "count": 1,
+            "count": 2,
-            "lastSeenAt": "2026-10-10T18:24:43.258Z",
+            "lastSeenAt": "2026-10-10T18:24:52.050Z",
-                "at": "2026-10-10T18:24:43.194Z",     # evidence.at
+                "at": "2026-10-10T18:24:51.980Z",
-                    "at": "2026-10-10T18:24:43.250Z"  # result.rollback.at
+                    "at": "2026-10-10T18:24:52.040Z"
```

两个宿主上差异集合完全相同，只有上述 4 个字段。

### 4. 幂等性与语义

- 重复运行同一流程（第三次 core flow，实测）：条目数保持 3 → 3，
  `count` 2 → 3，`firstSeenAt` 不变；条目按 `lastSeenAt` 升序排列，更新的条目移到末尾。
- 多次 host 启停（`lifecycle-verify/disable/enable/verify`）不改文件
  （`memoryUnchanged: true`，脚本断言），说明启动路径不重写 memory。
- `signature()` 有意排除 `experiment.id`/`at` 等字段，因此同一模式的不同实验会合并计数；
  `experiment` 字段保持首次出现时的上下文，`evidence`/`result` 更新为最新观测。

## 调查中发现并修复的真实缺陷（0.2.0-rc.7）

隔离实验与代码审计发现失败记忆在三个边界上违反仓库自身的恢复原则
（"未知或损坏持久状态不得猜测、静默合并或删除现场"）：

1. `entries` 含非对象记录（如 `[null]`）时，`load()` 的外层校验通过，
   `retainEntries()` 访问 `null.signature` 抛 `TypeError`，**插件启动失败**；
   而 doctor 只检查 `schema` 与 `Array.isArray(entries)`，会把同一文件报为 `ok`。
   修复：把"所有记录都是对象"纳入有效性判定，不满足时走既有 quarantine 路径
   （原字节保留、空 memory 继续、可查询 warning），doctor 同步报 `degraded`。
2. 缺少 `signature` 的记录在 `bySignature` 中以同一缺失键合并，不同记录被静默折叠，
   且 `compact()` 会把折叠结果写回磁盘。修复：为缺失身份的记录派生整条内容的
   SHA-256，不同内容永不合并，完全相同的内容仍然去重。
3. 时钟回拨或异常 `lastSeenAt` 使新记录排到满仓之后时，`record()` 自己的保留过程会裁掉
   刚写入的记录并返回 `entry: undefined`，随后 `archive()` 读取 `memory.entry.signature`
   抛 `TypeError`。修复：`retainEntries({ keep })` 保证本次写入的条目一定保留
   （淘汰最旧记录），`record()` 始终返回它写下的条目。

三个缺陷都有失败路径测试（`test/failure-memory-integrity.test.mjs`，
以及 `test/diagnostics.test.mjs` 的 doctor 一致性用例），并保持 schema 1 格式、
重复语义、`tmp`+`rename` 原子写入与隔离恢复不变。

## 剩余风险

- `EvolutionMemory.save()` 是 last-writer-wins 且不做 fsync：同一数据根下两个 host 实例
  同时 `archive()` 时后写者覆盖先写者的快照；断电可能丢失最后一次 `record()`。
  跨进程锁保护的是领域归档事务，不是这个文件。它是有界、advisory 的失败记忆
  （`promotionGates` 仍是生产权威），本次不引入锁或 fsync，记录为已知边界。
- 无 `signature` 的历史记录按整条内容去重，不参与后续的模式匹配。
