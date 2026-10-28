# 首次历史吸收的事务保存路径：把桥接标记窗口判一次

## 结果

无可用 checkpoint 的首次历史吸收里，唯一的主项是**逐条保存校验**：一次吸收一次事务提交，
但事务里的每条记录都要保存一次（`#append` → `#save` → `transaction.persist`），而每次保存的
`assertTransactionSave()` 都把**整份文档**送进 `JSON.stringify`。20,000 条记录时它是 open 墙钟的
73.2%（CPU profile self time），累计序列化 13,268,295,143 字节；其中 96% 是同一份内容——内存自己
的**桥接标记窗口**（`evolution.eventBridge.applied`，4,096 条 marker，729,112 / 757,413 字节）。
第二项是归档条目的键表簿记：每次追加都完整复制一遍随记录数增长的 `archiveKnown` / `archiveTombstones`
集合（O(N²)），20,000 条时 1,918 ms。

本轮把这两项换成可证明等价的实现，**没有减少保存次数、没有改事务边界、没有改持久化格式**：

| 记录数 | 墙钟 ms | CPU ms | 进程峰值 RSS（KiB） |
| ---: | --- | --- | --- |
| 2,000 | 1,066.4 → 511.2（−52.1%） | 1,111.6 → 562.8（−49.4%） | 150,368 → 95,888 |
| 12,000 | 14,695.1 → 3,398.5（−76.9%） | 15,372.9 → 3,675.8（−76.1%） | 203,264 → 195,264 |
| 20,000 | 26,683.6 → 5,749.5（−78.5%） | 28,634.9 → 6,236.2（−78.2%） | 266,096 → 239,152 |

三个规模的每一轮配对差都远超同规模同码 A/A 噪声（墙钟配对 −544.5 / −11,369.3 / −20,934.1 ms，
A/A 极值 7.2 / 510.4 / 1,106.8 ms）。峰值 RSS 在 2,000 条超出同规模 A/A 极值（−54,736 vs 656 KiB）；
12,000 条（−13,312 / −8,000 / −7,264）与 20,000 条（−37,808 / −20,784 / −26,944）方向一致，但这两个
规模的同码 A/A 峰值极值分别是 21,600 / 8,672 KiB，幅度重叠，因此**不把这两个规模的 RSS 差当作收益**。

原始数据：[`staged-save-check.json`](staged-save-check.json)（A/B + A/A + 相位采样，逐样本
[`staged-save-check.jsonl`](staged-save-check.jsonl)）、[`staged-save-attribution.json`](staged-save-attribution.json)
（机制计数，冷启动）、[`staged-save-attribution-growth.json`](staged-save-attribution-growth.json)
（重启后增长）、[`staged-save-check-profiles.json`](staged-save-check-profiles.json)（两侧 CPU profile 的
自时间/包含时间摘要）。脚本：[`event-log-replay-memory.mjs`](../../scripts/benchmarks/event-log-replay-memory.mjs)
（既有 A/B 基准，本轮未改）与新增的 [`staged-save-attribution.mjs`](../../scripts/benchmarks/staged-save-attribution.mjs)。

环境：Node **v26.12.1** / darwin arm64，父子进程都带 `--max-old-space-size=4096`；每个样本一个全新
子进程、全新临时 home，经真实 `openDomainStorage()`、官方 `DomainFacility` 与 `JsonStorageBackend`。
基线是 `47331df` 的独立 worktree（`/tmp/dsh-base-save-check`，`node_modules` 链到工作树），两侧基准
脚本字节相同（脚本内断言）。被测源码：`lib/domain-storage.js` `cf8084f9…`、
`lib/dockyard-domain/memory.js` `1204d1c2…`，基线侧分别是 `dc75a956…` / `2d8f049e…`。

## 1. 成本在哪（基线实测）

同一份 20,000 条冷日志，基线 CPU profile（27,475 ms，`--cpu-prof-interval=400`）：

| 帧 | self 时间 | 占比 |
| --- | ---: | ---: |
| `assertTransactionSave` | 20,053 ms | **72.9%** |
| idle（等 fs / IO） | 4,249 ms | 15.4% |
| `#archiveEntries` 的内层 `run` | 887 ms | 3.2% |
| GC | 539 ms | 2.0% |

`assertTransactionSave` 的成本全部是 `JSON.stringify(整份文档)`。机制计数（20,000 条，3 样本中位数）：
**20,000 次调用、13,268,295,143 字节、14,723 ms**。payload 组成测量（同一夹具，末次保存）：
`eventBridge` 729,112 字节 / 整份 757,413 字节；其中 marker 每条 4 个字符串字段。

也就是说：整份文档里唯一随记录数增长到 4,096 条之后**不再变化**的那一大块（标记窗口），被每条记录
重新序列化一遍；日志读取（plan/absorb 阶段）只占 0.5%（`absorb` 139 ms）。

第二项：`#archiveEntries()` 每次追加都要 `new Set(archiveKnown)`、`new Set(archiveTombstones)`，再各
复制一次用于失败回滚。`archiveKnown` 随归档记录数增长（20,000 条时 19,950 个 key），每次追加以 O(size)
复制四份：机制计数 **19,950 次 / 1,936 ms**。

## 2. 改了什么

### 2.1 保存校验：冻结的标记窗口按 marker 判一次（`lib/domain-storage.js`）

`createMemory()` 的 staged store 从 `assertTransactionSave(next)` 改成
`assertStagedTransactionSave(next, markerVerdicts)`：

- 文档的其余部分**每次保存都照旧整体序列化**，只把 `evolution.eventBridge.applied` 换成一个空数组；
- 窗口里的每个 marker 只序列化一次，判一次（是否含 `"__proto__"` 字面量），结论记在 per-transaction
  的 `WeakMap` 里。此后每次保存只做一次 `WeakMap.get`；
- 任何它无法证明的情形都退回**未改动的** `assertTransactionSave(payload)`：没有
  `evolution.eventBridge.applied` 数组、这三个成员不是自有数据属性、带 `toJSON`、窗口里的值不是
  「冻结 + 自有字段全是原始值」的记录，以及**文档文本确实含 `"__proto__"` 字面量**时（递归复制会
  栈溢出，必须让它看见整份文档）。

等价性依据（判定函数是逐项可组合的）：

1. **可序列化性。** 被记忆的 marker 只含 `null`/字符串/布尔/数字，`JSON.stringify` 对它不可能抛；
   其余每个字节每次保存都按文档自己的键序重新序列化（只把窗口内容换成 `[]`，那也是一个合法的
   空数组文本）。因此「第一个让整份文档不可序列化的值」仍是原来那个，错误也仍是原来那个。
2. **自有 `__proto__` 字面量。** `JSON.stringify` 把每个值写成一个完整 JSON 值，两个值之间的字节
   （`{`、`}`、`[`、`]`、`,`、`:` 与键自身文本）不可能补全这个字面量，所以整份文本含它当且仅当某
   一部分含它；一旦含它就走回原路径。
3. **只读一次。** 被替换的三个成员（`payload.evolution`、`state.eventBridge`、`bridge.applied`）
   必须是自有数据属性：这样「先取值再重建」不会运行代码，也不会读到与整份序列化不同的值（有
   accessor 时逐项读取会多读一次）。`transaction-save-check` 的
   `an envelope member that answers differently per read keeps the whole-document check` 用一个
   「第一次读正常、第二次读抛错」的 accessor 钉住这一点。

`lib/dockyard-domain/memory.js` 只增加了一件事：**标记是不可变的**。`#markBridgeApplied()` 用
`Object.freeze` 创建 marker，`load()` 之后把从持久文档读入的 marker 也冻结（`#freezeBridgeMarkers()`）。
这是把「不会被改」从约定变成值的属性：`#bridgeApplied()` 只读它，`#markBridgeApplied()` 只 push 新
marker 并丢掉窗口头，没有任何写入既有 marker 的路径。冻结是**浅**的，所以 store 的判定还要求「自有
字段全是原始值」——嵌套 marker、数组、accessor、非冻结对象都不会被记忆，窗口整体回退到逐次全量
序列化（`markers-*` 用例与 `a marker with a nested object` 覆盖）。

`inlineSerialization: true` 的合同不变：其余字节仍在 `update` 内同步捕获；窗口的字节在 marker 创建
时就已固定（冻结 + 原始值），因此不会在检查之后改变。

### 2.2 归档键表：就地使用 + 增量回滚（`lib/dockyard-domain/memory.js`）

`#archiveEntries()` 不再复制两张表，而是就地使用 `archiveKnown` / `archiveTombstones`，记录本次
**新增的 key** 与**被翻转的 tombstone**；失败时按这两份增量撤回并重新发布同一对表对象。语义等价：

- 内容：成功路径留下的表与「复制后修改」逐 key 相同；失败路径恢复到的内容与原来「整体换回副本」
  相同（同样的 key 集合，同样的 tombstone 位）；表对象的身份从未被任何读者观察；
- 时机：原来就是「先 `set` 生效、失败再恢复」，现在同样在进入 `try` 之前把表发布出去；
- 期间不被替换：档案写入由实例内的 `archiveWriting` 链串行化，mutation 由 `#enqueueMutation` 串行化，
  调用等待期间没有其它路径替换这两张表（失败分支仍显式 `set` 回去，与原来的整体替换等价）。

`test/dockyard-domain/archive-key-table-rollback.test.js` 固化了可观察后果：一次失败的追加不能把 key
留在表里（否则下一次逐出会把它当「已归档」跳过，记录从热窗口与档案里同时消失），也不能发布一个
它没有写成的 tombstone 计数。

## 3. 端到端 A/B（3 轮，逐轮交替，每侧每轮 1 样本）

| 记录数 | 墙钟 ms：基线 → 候选 | CPU ms：基线 → 候选 | 逐轮配对墙钟差 | 逐轮配对 CPU 差 | 同规模 A/A 极值（墙钟 / CPU） |
| ---: | --- | --- | --- | --- | --- |
| 2,000 | 1,066.4 → 511.2 | 1,111.6 → 562.8 | −544.5 / −563.1 / −542.2 | −539.8 / −554.1 / −537.0 | 7.2 / 9.7 ms |
| 12,000 | 14,695.1 → 3,398.5 | 15,372.9 → 3,675.8 | −11,369.3 / −11,229.2 / −11,306.1 | −11,738.2 / −11,601.5 / −11,703.1 | 510.4 / 512.3 ms |
| 20,000 | 26,683.6 → 5,749.5 | 28,634.9 → 6,236.2 | −20,934.1 / −21,048.5 / −20,909.9 | −22,417.5 / −22,497.5 / −22,319.9 | 1,106.8 / 1,043.4 ms |

相位中位数（KiB，`process.memoryUsage()`/`maxRSS` 现场量）：plan 之后 70,304 → 69,872（2k）、
84,160 → 84,240（12k）、94,272 → 94,336（20k）；提交前 82,464 → 82,768、123,200 → 123,920、
141,216 → 141,360；提交后（`committed`）150,192 → 95,392、203,264 → 192,048、266,096 → 239,152。
**读取侧未改**：plan 保有的日志（`planRetention`）在三个规模上两侧相同（12,000 条：8.19 MB → 8.19 MB）。

进程峰值 RSS：逐轮配对差 2,000 条 −54,736 / −54,304 / −54,832（A/A 极值 656 KiB），12,000 条
−13,312 / −8,000 / −7,264（A/A 极值 21,600 KiB），20,000 条 −37,808 / −20,784 / −26,944（A/A 极值
8,672 KiB）。只有 2,000 条超出该规模的噪声；另两个规模的差值方向一致但幅度与同码 A/A 的峰值离散重叠
（20,000 条有一轮超出、两轮落在其中）。

## 4. 机制计数（20,000 条，3 样本中位数）

| 项 | 基线 | 候选 |
| --- | ---: | ---: |
| 整份文档检查调用 | 20,000 | 1（首次保存，窗口为空） |
| 整份文档检查序列化字节 | 13,268,295,143 | 978 |
| 整份文档检查耗时 | 14,723 ms | 0.01 ms |
| 分项检查（文档减窗口）调用 / 字节 / 耗时 | — | 19,999 / 565,188,660 / 686 ms |
| 一次性 marker 判定次数 | — | 19,999 |
| 归档键表调用 / 耗时 | 19,950 / 1,936 ms | 19,950 / 2.4 ms |
| 墙钟 / CPU | 25,821 / 26,627 ms | 5,750 / 6,138 ms |
| 进程峰值 RSS | 326,096 KiB | 272,144 KiB（配对 −116,048 / −40,832 / −52,064） |

候选侧 profile（同一夹具，6,102 ms）：`assertStagedTransactionSave` self 618 ms（10.1%）、idle
2,274 ms（37.3%）、`stat` 1,321 ms（21.6%）。**主项消失后剩下的是归档路径的文件系统往返
（`stat` / `open` / `read` / `appendFile`）与其等待**，本轮未改。

### 重启后增长（20,000 条已吸收 + 500 条新增）

第二次 open 没有可信 checkpoint 前缀之外的历史要重放，只吸收 500 条，但标记窗口已从持久文档载入
满 4,096 条——这正是「载入的 marker 是否也被冻结」的分水岭：

| 项 | 基线 | 候选 |
| --- | ---: | ---: |
| 暖启动墙钟 / CPU | 2,610 / 2,778 ms | 1,986 / 2,100 ms |
| 逐轮配对墙钟 / CPU | — | −611 / −620 / −634 ms；−686 / −648 / −690 ms |
| 整份文档检查 | 500 次 / 370,633,696 B / 417 ms | 0 次 |
| 分项检查 | — | 500 次 / 14,282,196 B / 21.9 ms |
| 一次性 marker 判定 | — | 4,595 次（载入的 4,096 + 新增 499） |
| 归档键表耗时 | 82 ms | 0.10 ms |
| 发布后的窗口长度 | 4,096 | 4,096（两侧相同） |
| `flush()` 结果 | `{applied: 0, duplicates: 20500}` | 同左 |

## 5. 等价性与验证

**保存校验的判定差分。** [`test/domain-storage/staged-save-check.test.js`](../../test/domain-storage/staged-save-check.test.js)
在 43 个 payload 上同时跑 `assertTransactionSave()` 与 `assertStagedTransactionSave()`，要求**同一个
结论**（是否抛、错误名、错误消息）与**预先写明的期望结论**：空窗口、满窗口、未冻结 marker、嵌套
marker、数组 marker、稀疏窗口、原始值/函数/`undefined` 值、`NaN`/`Infinity`、`__proto__` 作为**值**、
作为**自有键**、只在第二个 marker 里、在文档其余部分、被记录共享的 marker、BigInt（记录内 / marker
内）、循环、抛错的 getter / `toJSON`、三个成员上的 `toJSON` 与 accessor、4,000 层深的文档（含/不含
字面量）、`undefined` / `null` / 字符串 payload。另有一个计数 Proxy 用例证明**被记忆的 marker 在第二
次调用里一个属性都不再读**（这是整个收益所依赖的性质，单看结论看不出来）。

**接口与不变量。** [`test/dockyard-domain/bridge-marker-freeze.test.js`](../../test/dockyard-domain/bridge-marker-freeze.test.js)
钉住：新建 marker 冻结且只有 4 个原始字段；载入的 marker 在 `load()` 后冻结且投影逐值不变；本实例没
写过的窗口（嵌套/原始值）原样保留并可继续 replay。

**归档键表回滚。** [`test/dockyard-domain/archive-key-table-rollback.test.js`](../../test/dockyard-domain/archive-key-table-rollback.test.js)
用真实 `archiveWriteGuard` 注入失败：失败追加后记录仍在热窗口、档案没有新行、`coldArchives` 未发布；
随后成功的那次必须把被逐出的行**恰好一次**写进档案（若失败时把 key 留在表里，这一行会被静默跳过），
计数与 `history()` 也必须一致；tombstone 标记行同理（失败后不得发布它没写成的计数）。

**与历史实现的整树差分。** 既有的两个差分基线把「改动前的树」从工作树反向重建，再让两棵树跑同一
负载、逐字节比较持久化状态：`domain-storage-baseline.js` 重建 rc.8 的 pinned 源（本轮新增 3 组
reversal，新版检查的整段文本固定在
[`staged-save-check-text.js`](../../test/domain-storage/staged-save-check-text.js)），
`load-projection-baseline.js` 重建 load-projection 之前的三个文件（本轮新增 5 组 `memory.js` hunk，把
marker 冻结与键表就地化一起反转）。它们要求：重建结果与 `release/dsh-evolution-0.2.0-rc.8.tgz` 逐字节
相同；旧实现与工作树在观察（`observe` / 提交流程 / 归档逐出 / 重启投影）上提交**逐字节相同**的状态。

**已执行的检查**（最终源码）：

| 检查 | 结果 |
| --- | --- |
| `NODE_OPTIONS=--max-old-space-size=4096 npm test`（Node 26.12.1） | 1,208 / 1,209 通过；唯一失败是 `release-pin` 对**未提交**分发改动的拒绝（提交后 1,209 / 1,209） |
| 同上，Node 22.23.4 / 24.22.1 | 同为 1,208 / 1,209，唯一失败项相同 |
| CI（GitHub Actions，Node 22.19.0 / 24.x + package + 三宿主验收） | 见提交后的运行记录 |
| `test/domain-storage/staged-save-check.test.js` | 7 / 7 |
| `test/domain-storage/domain-storage-write-path-equivalence.test.js` | 5 / 5（含 pinned rc.8 逐字节重建） |
| `test/domain-storage/load-projection-equivalence.test.js` | 8 / 8 |
| `test/dockyard-domain/bridge-marker-freeze.test.js` | 3 / 3 |
| `test/dockyard-domain/archive-key-table-rollback.test.js` | 3 / 3 |

**变异检查**（确认上面的用例真的拦得住削弱）：把「整份文档检查」换成「字面量也不回落」（文档正文与窗口两处分别试）、把
`memoizableMarker()` 换成恒真、把窗口留在替代文档里、去掉三个成员的数据属性门、去掉窗口的
`toJSON`/原型门、去掉 marker 自有 `toJSON` 的排除——七个变异各自被对应用例捕获（有状态 accessor
用例捕获成员门，计数 Proxy 用例捕获「窗口留在替代文档里」，「不进 memo」断言捕获 marker 的排除，
「document carrying the literal」用例捕获两处字面量回落）。去掉空窗口快速分支**不**被捕获，因为它与等价实现不可区分（把空数组换成空数组，文本相同），
保留它只是省一次对象拷贝。

**独立审核（sol-loop，1 轮，`codex` / `gpt-6.1-sol` / `reasoningEffort: xhigh`，VERDICT APPROVE）**的
4 个 nit 已全部处理，并各自补了对应用例（除 S1 的撤销顺序外，把每一处改回去都会被对应用例击穿；
S1 的顺序在公开面不可观察，用例钉的是该路径必须产出的结果）：

| id | 结论 | 处理 |
| --- | --- | --- |
| S1 同一 key 在一次尝试里被翻转两次时，正序撤销不能回到入口状态 | 接受（代码正确性，公开面暂不可观察：每次档案读取都会用文件重建两张表） | 逆序撤销 + `restore()` 重复 key 的失败回归 |
| S2 非枚举自有 `toJSON` 的冻结 marker 会被误判为可记忆 | 接受 | `memoizableMarker()` 排除自有 `toJSON`，`JSON.stringify` 返回 `undefined` 时回落；一条「不进 memo」断言 + 一条有状态 `toJSON` 用例 |
| S3 窗口数组自身的 `toJSON` 被替换忽略 | 接受 | 窗口必须是 `Array.prototype` 的普通数组且无自有 `toJSON` |
| S4 spread 与回退会多读一次 getter，可能改变结论 | 接受 | 三个成员必须是「普通对象 + 自有可枚举数据属性」；有状态 accessor 用例覆盖兄弟字段 |

**真实宿主验收**（本地构建的同一 tarball：`release:pack --dist /tmp/diag/dist-staged-save2`，
`contentSha256` 三份证据同为 `6f162181…`，每份 21/21 步通过）：

| 宿主 | 证据 |
| --- | --- |
| 0.2.0-rc.2 | [`docs/evidence/staged-save-check-dsh-0.2.0-rc.2.json`](../evidence/staged-save-check-dsh-0.2.0-rc.2.json) |
| 0.2.1-alpha.1 | [`docs/evidence/staged-save-check-dsh-0.2.1-alpha.1.json`](../evidence/staged-save-check-dsh-0.2.1-alpha.1.json) |
| 0.2.1-rc.2 | [`docs/evidence/staged-save-check-dsh-0.2.1-rc.2.json`](../evidence/staged-save-check-dsh-0.2.1-rc.2.json) |

`npm run pack:check`（开发语义）16/16，并判定本树是固定点的**已提交后继**；`release/` 固定产物、
`package.json` 版本、`peerDependencies` 与宿主兼容范围都没有改，因此没有重新固定，也没有执行
`release:publish`。

## 6. 边界与未覆盖

- **只有 Node 26 的正式性能数据。** Node 22/24 只跑了功能套件，没有重跑基准；不把 26 的百分比外推到
  其它版本。
- **20,000 条的峰值 RSS 不宣称收益**：配对方向一致（每次 −17 至 −34 MB），但该规模同码 A/A 极值
  52,064 KiB 更大。2,000 / 12,000 条的 RSS 差超出同规模噪声。
- **`maxRSS` 是整个子进程的高水位**（含导入、夹具读取、backend 初始化），不是单个操作的分配量；
  相位采样用 `process.memoryUsage()`/`resourceUsage()`，不是分配计数器。
- **剩余的大项没有动**：候选里 `stat` 20.9% + idle 35.6% 主要是归档条目路径的逐条文件系统往返
  （`stat` → `#activeTailIsTorn` 的 open/read → `appendFile`）。要合批它需要「事务内可以延后写归档
  文件」的新合同，而且会改变 sealed 段的边界（逐条 append 与成批 flush 的封段时机不同，持久字节
  会变），本轮没有等价证据，保持原样。
- **保存校验的形状依赖 `EvolutionMemory` 的状态形状**：`evolution.eventBridge.applied` 的位置被
  `domain-storage.js` 认识。任何改动该字段位置/名字的改动都必须同步改这里，否则只会退化成「每次
  保存整体序列化」（正确、但丢掉收益），不会被静默放宽——判定本身仍由 `memoizableMarker()` 与
  回落条件决定。
- **记忆的前提是 `Object.freeze`**。若将来出现向既有 marker 写入的代码路径，它必须同时移除这份记忆，
  否则复用会把旧文本套到新值上。`bridge-marker-freeze.test.js` 与「只读一次」的计数用例把现状钉住，
  但这不是编译期保证。
- 只测了 darwin/arm64；未测冷页缓存、网络文件系统、多进程并发、更大日志（本轮上限 20,000 条 /
  12.8 MB）。

## 7. 复现

```sh
# 基线：同一提交的独立检出（测量期间不要修改它）
git worktree add --detach /tmp/dsh-base-save-check 47331df4883d9b06c098a29c21d3687ed45716ec
ln -sfn "$PWD/node_modules" /tmp/dsh-base-save-check/node_modules
cp scripts/benchmarks/staged-save-attribution.mjs /tmp/dsh-base-save-check/scripts/benchmarks/

# A/B + A/A（约 12 分钟；两侧脚本字节相同由脚本断言）
NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/event-log-replay-memory.mjs \
  --records 2000,12000,20000 --rounds 3 --baseline-root /tmp/dsh-base-save-check \
  --out docs/performance/staged-save-check.json --ledger docs/performance/staged-save-check.jsonl

# 机制计数（冷启动 / 重启后增长；各约 5 分钟）
NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/staged-save-attribution.mjs \
  --mode cold --records 20000 --samples 3 --baseline-root /tmp/dsh-base-save-check \
  --out docs/performance/staged-save-attribution.json
NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/staged-save-attribution.mjs \
  --mode growth --records 20000 --growth 500 --samples 3 --baseline-root /tmp/dsh-base-save-check \
  --out docs/performance/staged-save-attribution-growth.json

# CPU profile 摘要（两侧各一次 20,000 条 worker，再用摘要脚本聚合 self/inclusive 时间）
```

所有夹具都在 `os.tmpdir()` 下；除 `--out` / `--ledger` 外不写仓库内文件。`package.json#files` 不含
`scripts/benchmarks/` 与 `docs/performance/`，因此本轮新增的脚本与数据不改变分发字节。

`staged-save-check.json` 的 `method.candidateWorktreeChanges` 记录的是测量当时工作树的 `scripts/`、
`test/` 与 `lib/` 差异清单；其中除 `lib/domain-storage.js` 与 `lib/dockyard-domain/memory.js` 之外的
条目是此前各轮遗留的**未跟踪**基准/测试文件，不参与被测代码路径，两侧源码哈希以
`staged-save-attribution*.json` 的 `method.sources` 为准。
