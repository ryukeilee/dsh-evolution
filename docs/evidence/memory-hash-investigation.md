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

### 1. 迭代验收证据（rc.3 – rc.6，两个宿主）

调查开始时 `docs/evidence/` 中有 22 份带 memory 哈希的 acceptance 证据
（`packageVersion` 均为 rc.3 – rc.6），全部呈现同一模式：
`memoryShaAfterCore == memoryShaBeforeUninstall`（脚本断言卸载不改数据），
`memoryEntriesAtUninstall == memoryEntriesAfterReinstall`（条目保留），
但 `memoryShaAfterReinstall != memoryShaBeforeUninstall`。
每份证据的 `core-flow-after-reinstall` 都记录
`memoryEntriesBefore == memoryEntriesAfter == 1` 且
`existingMemoryRetained: true`，即变化发生在条目内部而非条目集合。（其中代表 rc.6
两个宿主的两份最新证据在本候选验收后已被 rc.7 的对应文件覆盖，模式相同；其余 20 份
保持原样。）

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

隔离实验与代码审计发现失败记忆在十一个边界上违反仓库自身的恢复原则
（"未知或损坏持久状态不得猜测、静默合并或删除现场"）：

1. `entries` 含非对象记录（如 `[null]`）时，`load()` 的外层校验通过，
   `retainEntries()` 访问 `null.signature` 抛 `TypeError`，**插件启动失败**；
   而 doctor 只检查 `schema` 与 `Array.isArray(entries)`，会把同一文件报为 `ok`。
   修复：把"所有记录都是对象"纳入有效性判定，不满足时走既有 quarantine 路径
   （原字节保留、空 memory 继续、可查询 warning），doctor 同步报 `degraded`。
2. 缺少 `signature` 的记录在 `bySignature` 中以同一缺失键合并，不同记录被静默折叠，
   且 `compact()` 会把折叠结果写回磁盘。修复：为缺失身份的记录派生整条内容的
   SHA-256，在加载接受的范围内（严格 UTF-8、无重复键、JSON 可保真解析的数值、不超过 64 层）不同内容永不合并，完全相同的内容仍然去重；
   超出该范围的记录按损坏状态隔离，不参与去重。
3. 时钟回拨或异常 `lastSeenAt` 使新记录排到满仓之后时，`record()` 自己的保留过程会裁掉
   刚写入的记录并返回 `entry: undefined`，随后 `archive()` 读取 `memory.entry.signature`
   抛 `TypeError`。另外显式 `signature` 为非字符串（如 `42`）时，保留键与实际存储键
   不一致，同样会让新记录丢失。修复：`retainEntries({ keep })` 保证本次写入的条目一定保留
   （淘汰最旧记录），`record()` 只接受非空字符串签名、其余按 `signature()` 计算，
   返回值不再因自身的裁剪而缺失。
4. 记录嵌套超过克隆边界（`snapshot()` 的 `structuredClone` 在数千层时栈溢出）时，
   `load()` 直接抛 `RangeError`，**插件启动失败**，而 doctor 仍报 `ok`。修复：运行时与
   doctor 共用同一个迭代式判定（非对象、或超过 64 层即视为损坏状态），隔离并保留原字节。
5. JSON 字面量 `1e400`/`-1e400` 会被解析为 ±Infinity，`-0` 会被 `JSON.stringify` 折为 `0`；
   两条仅在这些值上不同的记录会共享序列化结果而被合并（实测 2 条变 1 条）。修复：加载
   谓词拒绝这类 JSON 无法保真表示的数值（隔离并保留原字节），`stableJson` 区分它们，
   写入路径把非有限数规范化为字符串、`-0` 规范化为 `0`，保证插件写出的记录能被自己读回。
6. `JSON.parse` 对超出 double 精度的字面量（`9007199254740993`、`1.0000000000000001`、`1e-400`）
   已经丢失原文差异：两条不同记录解析后相同，doctor 报 `ok` 而加载合并为一条。修复：扫描
   原文的数字字面量做精确十进制比较（最短往返表示或 double 精确十进制展开），命中即
   以 `number-failure` 隔离原文件；写入路径不受影响，因为它总是写最短往返表示。
7. 写入路径的 `undefined`：`experiment.a = [undefined]` 与 `[]` 得到同一序列化（数组空洞/
   `undefined` 元素在 `JSON.stringify` 下都是 `null`，对象属性则被删除）而被合并为一条，
   重载后又因落盘值为 `[null]` 而分裂为两条。修复：`compactValue` 在计算签名前就把
   `undefined` 规范化为落盘后的形状，`stableJson` 也不再让 `undefined`/空洞与缺失值同形。
8. 同一对象内重复键（`{"p":1,"p":2}` 与 `{"p":2}`）在 `JSON.parse` 中不可观察：后者
   覆盖前者，不同原文得到相同记录。修复：`inspectMemoryText` 在解析前跟踪每层对象的
   解码后键名，重复即以 `duplicate-key-failure` 隔离。
9. 非法 UTF-8 字节（`ff`/`fe`）曾被宽松解码替换为 `�`，不同文件字节因此变成相同字符串
   并被合并，保存后原字节丢失。修复：用 `TextDecoder("utf-8", { fatal: true })` 严格
   解码，失败即以 `encoding-failure` 隔离并保留原字节。
10. `compactValue` 向普通对象赋值时，`__proto__` 键会触发原型 setter 而不产生自有属性，
   该字段被静默丢弃且身份随之碰撞。修复：改用 `Object.fromEntries` 定义自有属性。
11. 带 UTF-8 BOM 的文件在严格解码下曾被 `TextDecoder` 默认吞掉 BOM：运行时接受而 doctor
   报 `degraded`，且下一次保存会静默去掉 BOM。修复：解码时保留 BOM（`ignoreBOM: true`），
   让解析失败并按 `parse-failure` 隔离，运行时与 doctor 一致且原字节保留。

十一个缺陷都有失败路径测试（`test/failure-memory-integrity.test.mjs`，
以及 `test/diagnostics.test.mjs` 的 doctor 一致性用例），并保持 schema 1 格式、
重复语义、`tmp`+`rename` 原子写入与隔离恢复不变。

## 0.2.0-rc.7 本地验证

对修复后的固定产物 `release/dsh-evolution-0.2.0-rc.7.tgz` 重跑同一实验：

- 双宿主真实安装验收：`0.2.0-rc.2` 与 `0.2.1-alpha.1` 各 21/21 步通过，证据
  `docs/evidence/dsh-0.2.0-rc.2.json` / `docs/evidence/dsh-0.2.1-alpha.1.json`
  （content `66afbe6b…`，字节 `6d3bbe64…`，与 `release/manifest.json` 一致）。
- alpha.1 上的快照复现得到同样的四个快照（1598 / 1598 / 3305 / 4996 字节），
  卸载到重装之间无写入；`beforeUninstall → afterReinstall` 的 diff 仍然只有
  `count`、`lastSeenAt`、`evidence.at`、`result.rollback.at` 四处，即修复没有改变
  正常路径的 memory 语义。
- 真实宿主端到端：在隔离 home 中写入 `{"schema":1,"entries":[null]}` 后，doctor 报
  `state.memory: degraded`；用 core probe 启动宿主成功（9 个工具、流程完整、
  `reverted: true`），损坏文件被隔离且字节完全保留，memory 以空内容继续并正常记录。
- `npm test` 245/245 通过（含十一个修复边界的失败路径测试，含加载边界与身份边界的一致性）；`npm run pack:check`
  16/16；`npm run release:verify` 针对固定产物通过。

## 剩余风险

- `EvolutionMemory.save()` 是 last-writer-wins 且不做 fsync：同一数据根下两个 host 实例
  同时 `archive()` 时后写者覆盖先写者的快照；断电可能丢失最后一次 `record()`。
  跨进程锁保护的是领域归档事务，不是这个文件。它是有界、advisory 的失败记忆
  （`promotionGates` 仍是生产权威），本次不引入锁或 fsync，记录为已知边界。
- 无 `signature` 的历史记录按整条内容去重，不参与后续的模式匹配。
