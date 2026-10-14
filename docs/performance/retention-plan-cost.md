# 保留计划：每行一次规范化、折叠重复遍历，并去掉备忘与冗余深拷贝

本轮针对 `lib/dockyard-domain/memory.js` 的 `#knowledgeRetentionPlan()` 与
`#retentionPlan()`：**同一条来源记录在一次计划里被规范化三遍**、**同一批记录被遍历两遍**、
**计划对自己已经拥有的知识行反复深拷贝**，以及上一轮为消除重复规范化而引入的
**按行备忘** —— 它只回答一个累积遍已经回答过的布尔问题。最终只删除重复计算、重复遍历、
冗余复制与这份备忘，不改保留决策、归档顺序、持久化与恢复语义，不改知识身份；
未修改官方 DSH 源码，也未触碰 `release/` 中的 rc.10 固定产物。

原始数据（本轮实际运行，未引用历史数字）：

- [`retention-plan-cost.json`](retention-plan-cost.json) —— 真实 `compact()` 链路，
  三个规模（2 000 / 10 000 / 40 000 冷行）、两个阶段（dryRun 规划 / 含档案重写的写入）、
  每侧每轮 3 样本 × 2 轮、A/B/B/A 轮换，含等价性断言结果；基线为显式
  `--baseline b7547f8`（本改动之前的提交）；
- [`retention-plan-memo-removal.json`](retention-plan-memo-removal.json) —— 同一链路、
  同一排程，基线为 `--baseline 194fc6a`（含备忘的上一版），用于单独量化**本轮改动自身**；
- [`retention-plan-domain-retention.json`](retention-plan-domain-retention.json) ——
  另一份语料（20 000 条终态 outcome）上的既有基准，两侧各自在自己的 checkout 里运行；
- `docs/evidence/retention-plan-dsh-0.2.0-rc.2.json` 与
  `docs/evidence/retention-plan-dsh-0.2.1-alpha.1.json` —— 本轮对两个官方宿主重跑的真实验收；
- 第 4.3 节的内存归因与第 4.5 节的历史归因是探针运行，不在上述 JSON 中。

环境：Node `v26.11.1` / `darwin 27.0.0` / `arm64`，Apple M2，8 逻辑 CPU、16 GiB 内存。
主测量开始时 load average 为 `1.29 / 1.85 / 1.87`，本轮改动自身的测量为
`2.21 / 2.01 / 1.92`；两次测量期间均未并行运行测试、验收或其它基准。
CPU 为 `process.cpuUsage()` 的 user+system 增量；内存口径见第 4.3 节。

## 1. 四个真实成本

### 1.1 同一条来源记录在一次计划里被 `normalizeKnowledgeEvent()` 三遍

`#retentionPlan()` 里 `collections` 覆盖除 `tombstones` 外的全部集合，而
`#knowledgeRetentionPlan(histories)` 对每个来源集合（除 `knowledge` / `tombstones`）
把每条记录规范化**两次**：

1. 累积遍（`for (const collection of sourceCollections)`）—— 真正需要完整事件：
   `knowledgeKey`、`occurredAt`（用于同组内排序）、`isKnowledgeCritical`、
   `sourceRetentionLimit`、以及 `mergeKnowledgeEntry` 的入参；
2. 保留遍（同一批 `sourceCollections` 的第二个循环）—— **只判断该行是否为假值**，
   即"这一行是否完全没有知识身份"。

随后 `#retentionPlan()` 的分类循环对同一批行**第三次**调用它，而且同样只使用
真值性。`normalizeKnowledgeEvent()` 每次都会构造完整事件对象：6 个维度的文本规范化 + 一次
hash，外加 `outcome`、`confidence`、`metrics`、`recovery`、`relations`、`sourceRef`
等全部字段。也就是说，一次计划里每条来源行有 **2/3 的规范化结果只被当作布尔值读过一次**。

### 1.2 计划对自己已经拥有的知识行反复深拷贝

`histories` 是 `this.history(collection)` 的产物，而 `#mergeArchived(collection, hot)`
在默认 `copy: true` 下**总是**返回新对象；因此 `histories` 里的每一行已经是与 `#data`
脱钩的计划私有副本。在这个前提下旧实现仍然对 knowledge 行深拷贝三次：种子行
`clone(entry)`、计划结果的 `.map(clone)`、以及出计划时的 `.map(clone)`。
`mergeKnowledgeEntry(previous, event, …)` 只读 `previous`，因此这些拷贝对正确性没有贡献。
冷档案里 knowledge 行最大（40 000 行负载中 knowledge 占 8 000 行），
`structuredClone` 的成本集中在它身上。

### 1.3 同一批来源记录被遍历两遍

1.1 中的"保留遍"与累积遍遍历的是完全相同的 `(collection, entry)` 对。它只是把
`normalizeKnowledgeEvent(...)` 为假值的行加进 `retainedEntries`，而 `retainedEntries`
在本文件内**只被 `.has()` 查询**，不暴露给任何调用方，也不依赖插入顺序。

### 1.4 上一轮引入的按行备忘

上一轮把"每条来源行规范化一次"做成了 `Map<collection, Map<entry, event|null>>`，
并把该 Map 的访问器随计划结果返回给分类循环。它的唯一读者是分类循环，而分类循环
问的正是 1.3 里那个已经被 `retainedEntries` 回答的问题。代价有两部分（实测见 4.3）：

- `Map` 结构本身：40 000 行负载下外层 4 个集合键、内层 32 000 个键，
  实测中位数保留 **0.91 MiB**（10 000 行 0.19 MiB）；
- 对象图的存活期：备忘录在 `#retentionPlan()` 返回前一直可达，把 16 000 个非 null 事件
  保活到分类循环结束。把 Map 与它独占可保留的整个事件对象图一起释放，实测中位数
  **9.32 MiB**（10 000 行 2.29 MiB）；两者之差即对象图本身，约 **8.41 MiB**
  （10 000 行 2.10 MiB）。

## 2. 改动

`lib/dockyard-domain/memory.js`，三组机制，均为最小有效修改：

1. **每行一次规范化。** 累积遍直接调用
   `normalizeKnowledgeEvent(entry, { sourceCollection: collection, now: timestamp(this.clock) })`，
   不再经过备忘；`#knowledgeRetentionPlan()` 不再创建、也不返回访问器。
2. **折叠保留遍，并让分类循环读取 `retainedEntries`。** `retainedEntries` 在累积遍之前
   创建；累积遍里 `if (!event) { retainedEntries.get(collection)?.add(entry); continue; }`；
   分类循环的守卫由 `normalizedKnowledge && !retainedEntries.get(collection)?.has(entry)`
   简化为 `!retainedEntries.get(collection)?.has(entry)`。等价性依据见 3.3。
3. **去掉计划内部的冗余拷贝。** 种子 `clone(entry)`、计划结果的 `.map(clone)`、
   以及 knowledge 集合出计划时的 `.map(clone)` 三处删除。

**保留的时钟读取**：分类循环仍按行求值一次 `timestamp(this.clock)`，尽管该值不再被使用。
它是原实现在这里做规范化时的读取，去掉它会让计划观察到的时钟序列更短，从而把同一次事务
里随后写入的索引文档戳记再前移（第 3.5 节给出契约与实测边界）。

**收口轮：撤回那次读取的删除，并给出反例。** 收口轮一度删除该读取，以接受更宽的索引时钟
偏差；独立对抗式复核给出了改变业务语义的反例。`#knowledgeRetentionPlan()` 按 `occurredAt`
对同一知识身份的组内行排序，而无时间戳行的 `occurredAt` 正是规范化它时读到的时钟值。当同一
知识身份既有带时间戳行、又有无时间戳行，且同一进程内先跑过一次计划时，后续计划的起始时钟
位置会因删除的读取而前移，足以翻转组内排序、保留不同的记录并写出不同的归档字节。复核用
每调用推进 1 秒的时钟、两行同身份记录（一行带时间戳、一行不带）与两次计划复现：改动前保留
`dated`，删除读取后保留 `timeless`；报告计数与知识身份相同，保留记录 ID 与归档 sha256 不同。
因此收口轮**撤回**了这次删除，保留该读取，并把读取次数断言作为回归用例（删掉它会让
`retention-plan-equivalence.test.js` 的时钟契约用例失败）。

**收口轮：删除 `plan.histories`。** `histories` 只作为计划内部变量被分类循环与报告使用，
仓库内没有任何读者；收口轮把它从返回对象里删除，内部变量保留。

**保留未动的边界**：其它集合的 `retained.push(clone(entry))`、以及
`this.#data.canonical = plan.canonical.map(clone)` 两处都保留 —— 上一轮的单改动归因
（第 4.5 节）显示删除它们在噪声内，属于"收益不明显"的候选，不做无谓改动。

## 3. 等价性依据

### 3.1 反转表：改动后的源码仍能逐字节重建 rc.7 固定产物

本仓库的差分基线不是复制一份旧实现，而是把工作树的 `memory.js` 按注册的
`[post, pre]` 片段**反向还原**成改动前的源码。收口轮**未修改既有片段**，只为 `plan.histories`
的删除新增了一个片段（合计 19 个）；`pre` 侧（即 rc.7 那一侧）不变。

验证方式（第 8 节有命令）：把重建结果与 `release/dsh-evolution-0.2.0-rc.7.tgz` 里的
`lib/dockyard-domain/memory.js` 直接比较，实测两者均为 **175 320 字节**、
SHA256 `58a75e35fc4f7aed780fc63314420adc2bfd9bfc13909252b26ca0f4e058f0d8`。

必须说明这条证据的边界：`archiveIndexBaseline()` 读取的是 `release/manifest.json`
当前固定的 **rc.10** 产物，而 rc.10 已经包含共享扫描改动，于是
`pinPredatesScan === false`，`baselineFromSources()` 里那句"重建 == 固定产物"的断言
**不会执行**（它只在 pin 早于共享扫描时生效）。因此上面的字节同一性来自第 8 节的
显式比较，而不是来自测试内的断言；测试内实际生效的是：

- 按表中顺序应用时，每个 `post` 片段在应用的那一刻恰好匹配一次
  （`assert.equal(source.split(after).length - 1, 1)`）。片段并非全部两两不相交：
  少数后面的片段要等前面的反转还原出它描述的形状才会出现，因此顺序是合同的一部分；
  形状漂移会让模块拒绝加载；
- 反向应用全部片段后，重建结果不含 `#scanArchiveRaw`，也不含 `knowledgeEventOf`；
- 重建结果被用作差分基线。

**该守卫只证明字符串形状**：改动已注册区域内任何一行会被拦截，但同步更新反转表、
或通过未注册区域/共享 helper 让基线与候选一起漂移，仍须靠行为测试发现
（第 3.6 节的注入实验正是这一点的实测）。

### 3.2 差分测试：真实冷档案上的报告、状态、字节与重复压缩

`test/dockyard-domain/retention-plan-equivalence.test.js` 把
`archiveIndexBaseline()` 还原出的改动前实现与本工作树**在同一份冷档案上跑同一条
`compact()` 链路**，要求逐项相同：

- dryRun 报告、首次压缩报告、第二次压缩报告；
- 压缩后的完整状态（`fullSnapshot()` 的 JSON 投影）；
- 磁盘上每个 state / 索引 / 活动档案 / 已封闭 segment 文件的 sha256；
- 第二次压缩后的状态与字节。

语料在比较之前先断言"确实做了决策"，避免空计划造成假等价。本轮四个用例的实际覆盖：

| 用例 | 覆盖的决策 | 实测 |
| --- | --- | --- |
| 冷档案差分 | 退役、折叠、观测聚合、累积器增长、tombstone、已封闭 segment | `retired 10`、`consolidated 27`、`aggregatedObservations 3`、`knowledge 6 → 16`、11 个文件 |
| 无档案层差分（`!archiveFile`） | 同一计划在内存分区上的另一半行为 | `retired 6`、`consolidated 27`、`knowledge 6 → 16` |
| 重复压缩收敛 | 第二轮稳定、第三轮不动 | `knowledge 19`、`retired 0`、`consolidated 0` |
| 时钟契约（新增） | 每次计划的时钟读取次数、每条知识记录的派生戳记、索引与档案字节 | 46 条来源行：dryRun 读取 `138 → 92`；索引戳记位移恰好 `46 000 ms`；除索引外全部文件逐字节相同；共享时钟用例下只有时钟派生戳记移动，位移等于前一次计划删除的读取数 |

语料本身还覆盖：累积器合并守卫的**两个方向**、可聚合的健康观测、带
`errorCode`/`problem` 的诊断观测、可折叠 cycle 与带 meaningful stage 的知识承载 cycle、
终态 outcome / promotion 的退役、最新 lineage 保护、完全没有知识身份的行（覆盖被折叠的
保留遍）、以及写在 state 文件里的热行。

**不在此处断言所有权**：所有公开读取都会逐行 clone，黑盒测试无法观测"是否借用了活动行对象"。
该主张改由第 3.4 节的推理与生产代码注释支撑，而不是一条永远为真的断言。

### 3.3 折叠遍历与 `retainedEntries` 的等价性

分类循环访问的集合是 `#collections()` 去掉 `tombstones` 再跳过 `knowledge`，
即恰好等于累积遍的 `sourceCollections`；两遍读的是同一批 `histories[collection]` 数组
（在 `#performHousekeeping()` 之后一次性建立，中间没有重建）。在这个集合上：

- 规范化事件为假值的行，累积遍已经 `retainedEntries.add(entry)`；
- 规范化为真值且被保留的行，折叠循环已经 `retainedEntries.add(item.entry)`；
- 规范化为真值且未被保留的行，不在集合里 —— 分类循环据此进入退役/折叠分支。

于是"假值事件且不在保留集"不可达，原守卫 `normalizedKnowledge && !has(entry)`
与 `!has(entry)` 在同一批行上取同一值。`retainedEntries` 在本文件内只被 `.has()` 查询，
插入顺序与插入时机不可观测；`retainedEntries` 一直是 `Set`，基本类型行按值比较的语义
与改动前相同。

这条推理已被独立复核以对抗方式实测：120 个场景（两种存储 × 60 组语料，覆盖全部集合、
原始值、重复相同值、`NaN`/`-0`、跨集合共享对象、cold/hot 同 id、存储 `knowledgeKey`
与规范化键不一致、各类 meaningful stage、空/覆盖/未覆盖的 `sourceRefs`）没有找到反例；
34 个提前报错的场景两侧报错阶段、类型与消息一致。这是行为探测，不是穷尽证明。

### 3.4 所有权

- `histories` 由 `#mergeArchived(..., { copy: true })` 深拷贝产生，与 `#data` 脱钩；
- `mergeKnowledgeEntry` 不改写入参；
- `plan.histories` 在本仓库内没有任何读者。
  因此 `records` 中的 knowledge 行只有 `#data` 一个所有者。
  需要注意 `mergeKnowledgeEntry` 的输出并非完全无别名（空 `relations` 会复用旧
  `relationRefs`，`recovery` 可复用旧值），但那些旧对象都属于本次计划，未发现逃逸到
  外部的可变 owner。

### 3.5 时钟契约

计划每个来源行读取时钟：累积遍一次（用于该行的规范化）、分类循环一次（值不再被使用）。
改动前还多第三遍（被折叠的保留遍历），所以**唯一消失的是每条来源行一次读取**。
在逐次推进的时钟下这条差异的全部可观察形式是：

| 量 | 是否移动 | 实测 |
| --- | --- | --- |
| 保留决策、知识身份、档案记录字节、写出的文件集合 | 不移动 | 见 3.2 与 4.1 |
| 同一次计划内导出的知识记录戳记（`firstSeen`/`lastSeen`/`occurredAt`/`recentEvidence[].at`/`trend.recent[].at`） | 不移动（从相同起始时钟位置起算） | 5 条自身不带时间戳的行各自得到 5 个互不相同的戳记，且与改动前逐字段相同 |
| 该计划之后写入的索引文档/索引条目的墙钟戳记 | 恰好前移所删除的读取次数 | `walked=46`，位移 `46 000 ms`，其余字段逐字段相同 |
| 同一进程内**后续计划**的时钟派生戳记 | 恰好前移前面各计划删除的累计读取次数 | 共享时钟用例：位移等于前一次 dryRun 删除的读取数，且只有时钟派生戳记移动 |

最后一行是第一轮复核发现的：旧文档写成"知识记录时间戳完全相同"，那只在**单次计划**
（或从同一时钟位置起算）时成立；在一个长生命周期进程里，前面的计划少做了工作，
后面的计划读到的时刻自然更早。真实时钟下这就是"少走一遍行所省下的时间"，
仅对按调用次数推进的测试时钟才可观察。既然它无法在不重新走一遍这些行的前提下消除
（那正是本轮删掉的成本），这里把它作为契约显式钉住：任何扩大它的改动都会让
`retention-plan-equivalence.test.js` 的时钟契约用例失败。

**同一次计划内的派生戳记为什么不变**：每条来源行的累积遍读取在同一位置、同一顺序发生，
只有被折叠的那一遍整段消失，因此行与行之间的相对顺序不变。

### 3.6 复核轮次与变异测试

- **第一轮复核**（上一轮，对抗式）确认了时钟折叠问题、测试覆盖缺口与基准复现缺口，
  并独立验证了反转表、折叠遍历的等价性、所有权与失败路径。
- **本轮复核**（对抗式，独立模型 gpt-6-luna）：结论为“修完指定问题后可发布”，未找到保留决策或持久化状态的反例。它指出的两点已在本轮修完：分类循环那句注释把“该行在本循环里被规范化过”写成了现在时（实际是改动前的行为），已改成平直叙述；共享时钟用例
  原先用投影丢掉部分字段，已改成“只位移时钟派生戳记、再比较整行”，于是每个字段都被比较。第三点（重新引入备忘会被反转表的形状守卫提前拦住，而不是被行为比较拦住）记录在下表里，未改。
- **确认轮**（第二个独立模型 gpt-6.1-sol，针对三个提交的最终状态）：结论同样是“修完指定文档问题后可发布”，未发现行为回归；确认上述两项修复真实有效、整行比较的位移方向正确，并独立复算了 4.1/4.2/4.4 的全部数字与 4.3 的原始样本（含 0 次定时器回调、进程外峰值、C−M 差）与 rc.7 逐字节重建。它指出的三个文档问题已在本轮修复：宿主验收证据绑定的是 `a3cd39a` 的内容摘要而不是最终树；把备忘的**总**释放量（含 Map）写成了对象图占用；反转表说明写成“每个片段在工作树恰好出现一次”（实际是“按顺序应用时各匹配一次”，源码注释一并修正）。它另外指出提交的 RSS 准备脚本在最终树上已无法复现（它从当前 `lib/` 取 C，再找已删除的 `normalizedByCollection`），已改为从 `194fc6a` 取 C、从工作树取 M，并补交了 `shipped.json` 与探针副本。
- **收口轮复核**（对抗式，独立模型 gpt-6.1-sol）：确认 `plan.histories` 的删除安全、反转表与
  读取次数断言正确、反转表重建与 rc.7 逐字节相同；同时给出“删掉分类循环那次时钟读取会
  改变保留记录 ID 与归档字节”的反例（见第 2 节），收口轮据此撤回了那次删除，仅保留
  `plan.histories` 的删除。
- **本轮变异测试**（测试敏感度实测）：

| 注入 | 结果 |
| --- | --- |
| 删掉分类循环那次时钟读取（并同步改反转表片段，绕过形状守卫） | 读取次数断言失败（`exactly the folded sweep's one clock read per source row may disappear`）；该删除还会改变同身份混合时间戳的组内保留结果（见第 2 节反例） |
| 把累积遍的时钟读取改成每个集合读一次（同步改反转表片段） | 同样先命中上面的读取次数断言；若两侧一起改（即比较对象失去差异），则 `each timeless row must be stamped by the clock read of its own row` 失败 |
| 只改已注册区域内的字面形状，不同步反转表 | `must occur exactly once` 守卫失败，模块拒绝加载 |
| 重新引入上一轮那份备忘（含逐行时钟读取） | 不同步反转表时被形状守卫拒绝；同步后 4/4。这支持文档的证据边界声明：那份备忘本身就保留了逐行读取与同样的知识时间戳，在现有语料上没有可检出的行为差异 |
| 只改基线一侧语义：保留每一条来源行 | 两个差分用例都以 `the dry-run report must be identical` 失败 |

## 4. 实测

### 4.1 真实压缩链路（三个规模，A/B/B/A，每侧每轮 3 样本 × 2 轮）

```sh
node --expose-gc scripts/benchmarks/retention-plan-cost.mjs \
  --baseline b7547f8 --samples 3 --rounds 2 --warmup 1
```

基线 = `b7547f8` 的 `lib/`（上一轮与本轮改动之前），变体 = 工作树 `lib/`。
语料由**基线模块自己的公开函数**生成一次后原样写给两侧。表内为中位数：

| 规模（冷行） | 阶段 | wall 基线 → 变体 | Δ | CPU 基线 → 变体 | Δ | 采样堆增量 基线 → 变体 | 调用边界采样 RSS 基线 → 变体 |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 000 | dryRun 规划 | 79.63 → 51.04 ms | −35.9% | 96.01 → 67.10 ms | −30.1% | 31.4 → 6.5 MiB | 123.5 → 123.6 MiB |
| 2 000 | 含档案重写 | 109.79 → 80.03 ms | −27.1% | 123.94 → 90.98 ms | −26.6% | 27.3 → 9.1 MiB | 133.4 → 133.0 MiB |
| 10 000 | dryRun 规划 | 383.51 → 238.51 ms | −37.8% | 429.15 → 269.22 ms | −37.3% | 48.6 → 31.0 MiB | 237.8 → 237.5 MiB |
| 10 000 | 含档案重写 | 580.05 → 440.09 ms | −24.1% | 677.71 → 517.06 ms | −23.7% | 47.1 → 41.6 MiB | 257.7 → 261.6 MiB |
| 40 000 | dryRun 规划 | 1 483.21 → 918.80 ms | −38.1% | 1 736.54 → 1 105.72 ms | −36.3% | 164.1 → 103.2 MiB | 666.3 → 703.9 MiB |
| 40 000 | 含档案重写 | 2 398.38 → 1 848.67 ms | −22.9% | 2 699.48 → 2 035.16 ms | −24.6% | 214.5 → 133.7 MiB | 789.4 → 815.9 MiB |

同一轮里每个规模、每个阶段都执行了等价性断言，全部 PASS：
报告（dryRun / 首次 / 第二次）、完整状态、档案字节 sha256、第二次压缩的状态与字节、
以及 dryRun 不改变状态与档案。

三点必须如实说明：

- **CPU 与 wall 同向**：规划阶段 CPU 下降 30–38%，说明收益来自真实计算减少；
- **“调用边界采样 RSS”不是规划峰值，两个方向都不用它下结论**：该列由基准内的 2 ms
  定时器采样，而规划是同步的，定时器无法插入（4.3 节实测回调次数为 0）。它实际只观察
  `max(调用前 RSS, 调用后 RSS)`，受共享进程此前分配与 GC 时机影响；本轮这一列在
  40 000 行规划阶段是 `666.3 → 703.9 MiB`（方向与堆增量相反），而 4.3 节的进程外测量
  给出相反结论（`317.36` 对 `241.25 MiB`）。两者都说明：这一列既不作为收益，
  也不作为回归，列名已据实改为“调用边界采样 RSS”；
- **写入阶段收益小于规划阶段**（−22.9% ~ −27.1% vs −35.9% ~ −38.1%）：写入阶段包含
  `#rewriteArchives()` 的逐行序列化、落盘、索引重写与 state 保存，这些成本不随本轮
  改动下降，因此被摊薄。

### 4.2 本轮改动自身的 A/B（删除备忘值不值）

同一排程，基线换成含备忘的 `194fc6a`，因此这一列**只**包含"删除备忘 + 用
`retainedEntries` 回答分类"：

| 规模（冷行） | 阶段 | wall 备忘 → 本树 | Δ | CPU 备忘 → 本树 | Δ | 采样堆增量 备忘 → 本树 |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 2 000 | dryRun 规划 | 52.70 → 51.56 ms | −2.2% | 69.37 → 68.76 ms | −0.9% | 7.0 → 6.6 MiB |
| 2 000 | 含档案重写 | 81.22 → 80.48 ms | −0.9% | 92.55 → 90.74 ms | −2.0% | 9.4 → 9.3 MiB |
| 10 000 | dryRun 规划 | 241.43 → 239.22 ms | −0.9% | 273.76 → 268.92 ms | −1.8% | 32.3 → 30.9 MiB |
| 10 000 | 含档案重写 | 442.28 → 438.20 ms | −0.9% | 535.78 → 514.41 ms | −4.0% | 41.8 → 41.9 MiB |
| 40 000 | dryRun 规划 | 931.92 → 921.60 ms | −1.1% | 1 098.55 → 1 120.96 ms | +2.0% | 96.0 → 109.8 MiB |
| 40 000 | 含档案重写 | 1 850.70 → 1 870.70 ms | +1.1% | 2 069.47 → 2 109.73 ms | +1.9% | 142.0 → 133.3 MiB |

结论：**备忘没有它独有的收益**。规划阶段 0.9–2.2% 更快，写入阶段在 ±2% 内（40 000 行
的两个 +1% ~ +2% 与 10 000 行的 −1% ~ −4% 同量级，属于批间波动）；40 000 行的采样堆增量
在这一轮反而更高（96.0 → 109.8 MiB），与该指标本身在同步规划期间不可用（4.3 节）一致，
不作为判据。删除它的依据不是这 1% 的耗时差，而是它删掉的**状态**：一条每计划一份、
按行保留的 Map，以及它所保活的对象图。

### 4.3 峰值 RSS：上一轮报告的 +65 MiB 没有复现，备忘的真实占用可以量化

本节全部数字的**未加工样本与探针**在 [`retention-plan-rss/`](retention-plan-rss/)
（`fresh.jsonl` 72 行、`external.jsonl` 36 行、`memo.jsonl` 12 行、`shipped.json`、
`report.md` 与 README）；下面两条关键事实可以只用这些样本复算：定时器回调次数全部为 0、
每格样本的 `fixtureSha256` 与 `report` 完全一致。

该目录的 `setup.py` 从 `b7547f8`、`194fc6a` 解出 B、C 并把当前工作树作为 M，探针读
`RSS_ROOT`（默认 `/tmp/dsh-rss-research`），因此在最终树上可以整卷重跑。
本报告定稿前重跑了一次 10 000 行（每侧 1 次）：三侧 fixture hash 与 report hash 完全相同、
回调次数 0，`maxRSS` 增量为 B 77.3 / C 58.61 / M 58.05 MiB，与 `fresh.jsonl` 该格中位数
（76.95 / 58.66 / 58.28）一致。

上一轮把 40 000 行 dryRun 的采样 RSS `666.1 → 731.1 MB` 记为“方向相反的待解释风险”。
本轮按独立探针重做后，结论是**该数字不是规划峰值，其差值也不是本改动的属性**：

- **采样口径无效（实测）**：基准的 `measure()` 用 `setInterval(..., 2)` 采样
  `process.memoryUsage()`，而 `#retentionPlan()` 完全同步。新进程探针 72 次调用与
  进程外采样实验 36 次 dryRun 中，**interval 回调次数全部为 0**；一次 965.38 ms 的
  代表性运行只有手动 `endpoint` 一次采样。因此该算法的 dryRun "peak RSS" 实际是
  `max(调用前 RSS, 调用后 RSS)`，不观察同步规划内部。
- **独立进程 maxRSS 增量（default 堆，每侧 6 次，MiB）**：40 000 行
  `b7547f8` 139.52 [139.20, 140.03]、含备忘版 58.02 [57.66, 58.14]、本树
  56.97 [56.86, 57.50]；10 000 行依次为 76.95 / 58.66 / 58.28。
  `maxRSS` 是进程历史高水位，会被加载阶段遮蔽，但方向清楚：优化后的两侧都**低于**改动前，
  不存在"优化使规划 RSS 上升"。
- **进程外阶段采样峰值（pinned 堆，`--max-semi-space-size=16 --max-old-space-size=1024`，
  父进程每 2 ms 读子进程 `proc_pidinfo`，每格 6 次）**：

| 冷行 | 侧 | 规划期采样峰值 RSS | 相对阶段开始 |
| ---: | --- | ---: | ---: |
| 10 000 | `b7547f8` | 154.76 MiB | +69.41 MiB |
| 10 000 | 含备忘版 | 135.37 MiB | +49.94 MiB |
| 10 000 | 本树 | 135.09 MiB | +49.80 MiB |
| 40 000 | `b7547f8` | 317.36 MiB | +157.69 MiB |
| 40 000 | 含备忘版 | 241.25 MiB | +81.64 MiB |
| 40 000 | 本树 | 239.77 MiB | +80.28 MiB |

  即改动前最高、两个优化版本接近，备忘的差值为 **+1.48 MiB**（40 000 行）。这些仍是
  采样下界（最大采样间隔 3.96 ms），不是精确 OS 阶段最大值。
- **备忘自身占用（保活探针，每格 3 次，`memo.jsonl`）**：40 000 行 Map 结构中位数
  0.91 MiB（`mode="maps"`），与它独占可保留的整个事件对象图一起释放 9.32 MiB
  （`mode="total"`，即前者 + 对象图 8.41 MiB）；10 000 行依次为 0.19 MiB / 2.29 MiB
  （对象图 2.10 MiB）。该图在真实计划中大部分与 `sourceGroups` 共享，因此进程外差值的
  量级只有 1.48 MiB。

因此本轮对"峰值 RSS 增长"的处理是：**定位为采样口径与共享进程历史的产物，明确撤回其作为
内存回归的解释**；备忘的内存成本改用可量化的"Map 结构 + 对象图存活期"表述，并据此决定删除它。

### 4.4 既有基准（另一份语料，独立复现）

`scripts/benchmarks/domain-retention.mjs` 驱动真实 `compact({ dryRun: true })`，
语料是 20 000 条终态 outcomes（按 canonical 表 0 / 3 000 两个规模），7 样本中位数；
两侧各自在自己的 checkout 里运行同一脚本：

| canonical 规模 | 改动前 `b7547f8` | 本树 | Δ |
| ---: | ---: | ---: | ---: |
| 0 | 1 122.98 ms | 883.31 ms | −21.3% |
| 3 000 | 1 129.39 ms | 893.15 ms | −20.9% |

该基准的语料以 outcomes 为主（knowledge 行少），因此收益小于第 4.1 节的知识密集负载，
但方向一致：同一改动在两种不同语料上都被复现。

### 4.5 上一轮的单改动归因（历史记录，本轮未重跑）

上一轮用知识密集负载（5 000 条 knowledge 累加行 + 5 000 条 observations）做了 7 变体
交替测量，结论是：折叠遍历 + 备忘 384.7 ms（相对改动前 434.2 ms）、再加上去掉计划内部
两处拷贝 297.0 ms、再加上去掉 knowledge 出计划拷贝 259.0 ms（−40.3%）；而删除
`retained.push(clone(entry))` 与 `plan.canonical.map(clone)` 在噪声内，因此未做。

这些变体的原始数据未随仓库固化，且其中的 V1（备忘 + 折叠遍历）描述的树本轮已不存在。
保留它的意义只有两条，均已由本轮数据替代：

- 折叠遍历与两处拷贝删除仍在最终树里，它们的收益由 4.1 节的冻结合并给出；
- 备忘被 `retainedEntries` 取代，这一替换本身由 4.2 节直接测量（±1%）。

## 5. 收益边界

- 收益与"每条来源行一次规范化"的成本成正比，因此**来源集合越大收益越大**；
  空计划或只有极少量来源行的计划收益接近 0。
- 收益只在 `compact()` / 知识定稿的保留计划路径上；写入路径的档案重写、索引与
  state 落盘成本不变（4.1 节写入阶段的 −22.9% ~ −27.1% 是规划部分的摊薄结果）。
- 删除备忘**不引入跨调用缓存**，因此没有长期内存增长、没有失效语义，
  也不改变并发或多进程行为。删掉的只是那份 normalization memo；计划内仍然有
  `knowledgeByKey`、`sourceGroups`、`retainedEntries`，它们都是改动前后都在的
  分类/合并结构（`retainedEntries` 本身是计划必需的分类结果）。
- 保留两次按行时钟读取（累积遍一次、分类循环一次而值不被使用）的代价包含在 4.1/4.2
  的数字里；换来的是同一次计划内的知识记录戳记与改动前一致（3.5 节）。
- 删除的深拷贝把计划输出的所有权交给调用方；`retained.push(clone(entry))` 与
  `plan.canonical.map(clone)` 两条边界仍然保留，其它集合与 canonical 表的
  输出仍与输入脱钩。

## 6. 验证

```sh
node --test test/dockyard-domain/retention-plan-equivalence.test.js            # 4/4
node --test test/dockyard-domain/archive-index-equivalence.test.js \
            test/dockyard-domain/housekeeping-equivalence.test.js              # 28/28
node --test test/restart-recovery.test.mjs test/dockyard-domain/failure-retention.test.js \
            test/failure-memory-integrity.test.js test/promotion-journal-boundary.test.mjs \
            test/dockyard-domain/evolution-archive-index.test.js \
            test/dockyard-domain/archive-scan-memo.test.js \
            test/dockyard-domain/knowledge-identity-equivalence.test.js        # 37/37
npm test                                                                      # 326 tests, 324 pass, 2 fail
npm run pack:check                                                            # 13 ok, 3 fail
```

- **`npm test` 的 2 个失败是预期的发布固定点守卫**
  （`the working tree still builds exactly the pinned content`、
  `every shipped file in the tree matches the artifact byte for byte`），不是回归：
  它们在**改动前的提交** `b7547f8` 上同样失败（在 `git archive b7547f8` 解出的树上
  `node --test test/release-pin.test.mjs` 得到相同失败项）；原因是 rc.10 固定点早于
  最近几次提交，本轮只让 `memory.js` 继续处于"与固定产物不同"的状态，
  没有触碰 `release/`、没有 bump 版本、没有发布、没有 tag。
- **`npm run pack:check`：13 项通过、3 项失败**，三项全部是内容固定点相关
  （`the committed acceptance evidence matches this exact package content`、
  `release/manifest.json pins this tree content`、`the working tree still builds the pinned content`）：
  本树构建内容 `ee4850d6c9debc7c6faaf364a439fca24f8457de4dd2158903ebaf7670a9a33e`，
  而 `release/manifest.json` 以及 `manifest.json` 自己列出的那两个验收证据文件
  （`docs/evidence/dsh-0.2.0-rc.2.json`、`docs/evidence/dsh-0.2.1-alpha.1.json`，
  与本轮重跑的是不同文件）固定的仍是
  `1749210691d2dfe4aa875a03ded2fa4eb318ec84eb21c4305b6a5b568b1d56ea`。
  打包稳定性、内容白名单、权限、锁文件、文档一致性、README/CHANGELOG 一致性等 13 项全部通过。
  按 `RELEASE.md`，重新固定必须“重跑两个宿主验收 → `release:publish`”，属于外部写入，本轮未执行。
- **真实宿主验收（本轮重跑）**：先 `npm run release:pack` 生成本地产物
  （`dist/dsh-evolution-0.2.0-rc.10.tgz`，tarball sha256 `90c8bb89…`），再跑两个宿主，
  各自 **21/21 通过**（`host-install`、`plugin-add`、`profile-lists-bundle`、`doctor-cli`、
  `core-flow`、lifecycle 六项、卸载/重装、升级/回滚、promotion 三项、`doctor-final`），
  证据记录的内容摘要为 `a4c4ac6e740d84c88164aeebeb796a620b63788b4595dd36e613a1013e35843f`
  （上一轮的工作树；收口轮后本树内容见下）：

  ```sh
  npm run release:pack
  node scripts/acceptance/run-host-acceptance.mjs --host 0.2.0-rc.2 \
    --out docs/evidence/retention-plan-dsh-0.2.0-rc.2.json
  node scripts/acceptance/run-host-acceptance.mjs --host 0.2.1-alpha.1 \
    --out docs/evidence/retention-plan-dsh-0.2.1-alpha.1.json
  ```

  脚本在 `mkdtemp` 下建隔离的 `runtime` 与 `home`，并以 `DSH_HOME` 指向该 home，
  未触碰正式 `DSH_HOME`；它继承 `process.env`，因此普通 `HOME` 与包管理器配置并未单独隔离。
  21 步里嵌套的 `evolution_promote` `phase:"awaiting-owner-confirmation"` 与 canary 的
  `phase:"rolled-back"` 是“生产晋升必须显式确认”的预期结果，不是验收失败；判定只看顶层步骤。
  上一轮的同名证据文件绑定的是上一版内容摘要 `a6ca153d…`，本轮先对 `a3cd39a`
  （内容 `529c2899…`）重跑了一次，又因为 `13c2a7e` 修改了 `memory.js` 的注释、
  内容摘要变为 `a4c4ac6e…`，再对当时的内容重跑一次。
  **收口轮未重跑宿主验收**：收口轮只删除了返回对象里无读者的 `histories` 字段（内部变量
  保留），并撤回了删除分类循环时钟读取的尝试（第 2 节反例）。保留决策、知识身份、归档
  记录字节与恢复行为仍由第 3.2 节的差分用例逐字节钉住，时钟契约仍由时钟契约用例钉住。
  因此宿主验收证据绑定的是 `a4c4ac6e…`，与本树当前内容
  `ee4850d6c9debc7c6faaf364a439fca24f8457de4dd2158903ebaf7670a9a33e` 不同；
  重新固定（重跑宿主验收 → `release:publish`）属于外部写入，本轮未执行。

## 7. 剩余风险

- **时钟契约**（第 3.5 节）：被折叠掉的那遍遍历不再读取时钟，因此一个在单次计划内推进的
  时钟会让该计划**之后**写入的索引文档/索引条目戳记前移所删除的读取次数，并让同一进程内
  后续计划的时钟派生戳记前移累计删除量。保留决策、知识身份、归档字节与文件集合不变。
  真实时钟下这只是"少走一遍行所省下的时间"。该行为已被用例钉住，但它是一个**已接受的
  偏差**，不是被消除的偏差。
- **分类循环里那次不再使用值的时钟读取**：它保留的是“这一行在改动前于本循环被规范化时
  消耗的那次读取”，作用是保持实测时钟的位移不扩大。**它不能删**：删除会改变业务语义，
  而不只是索引戳记。`#knowledgeRetentionPlan()` 按 `occurredAt` 对同一知识身份的组内行
  排序，而无时间戳行的 `occurredAt` 来自规范化时读到的时钟值；同一进程内先跑过一次计划后，
  后续计划的起始时钟位置会因删除而前移，足以翻转组内排序、保留不同记录并写出不同归档字节。
  收口轮用每调用推进 1 秒的时钟复现了这个反例（见第 2 节），并因此撤回了删除。
  若将来有人删掉它，契约用例的读取次数断言会失败并提示原因。
- **反转表的证明边界**（第 3.1 节）：当前 pin（rc.10）晚于共享扫描改动，导致测试内的
  “重建 == 固定产物”断言不生效；字节同一性靠显式比较 `release/dsh-evolution-0.2.0-rc.7.tgz`
  验证（定稿前已重跑，仍为 175 320 字节 / `58a75e35…`）。反转表只证明形状与还原字节，
  不证明语义；片段还要**按表中顺序**应用才会逐个匹配一次。
- **内存指标**：4.1 节的"调用边界采样 RSS"与"采样堆增量"都不能代表规划期峰值或总分配字节；
  可用的替代证据是 4.3 节的独立进程 `maxRSS`、进程外阶段采样与保活探针。写入阶段的
  进程外峰值未单独测量。
- **`plan.histories` 已删除**：删除 knowledge 出计划拷贝后，`records.knowledge` 曾与
  `plan.histories.knowledge` 是同一批对象；收口轮确认仓库内无读者后把该字段从返回对象里
  删除，`histories` 仅作为内部变量。若将来需要重新暴露它，必须同时评估与 `records` 的共享关系。
- **未覆盖的规模与平台**：最大规模为 40 000 冷行 / 8 000 knowledge 行，未测量
  `compactionTriggerBytes` 附近的更大档案；所有测量只在 Node `v26.11.1` / darwin-arm64 上完成，
  未覆盖 Node 22 与其它平台。
- **收敛性**：第 3.2 节的收敛结论在给定语料上成立（第三轮不动），不能证明任意历史数据
  都收敛；无界增长会被该用例捕获。

## 8. 复现

```sh
# 1) 真实压缩链路 A/B（基线 = 本改动之前的提交，变体 = 工作树）
node --expose-gc scripts/benchmarks/retention-plan-cost.mjs \
  --baseline b7547f8 --samples 3 --rounds 2 --warmup 1 \
  --out docs/performance/retention-plan-cost.json

# 2) 本轮改动自身的 A/B（基线 = 含备忘的上一版）
node --expose-gc scripts/benchmarks/retention-plan-cost.mjs \
  --baseline 194fc6a --samples 3 --rounds 2 --warmup 1 \
  --out docs/performance/retention-plan-memo-removal.json

# 更快冒烟： --scales 2000 --samples 1 --rounds 1 --warmup 1
# 任意一侧换成本地 lib/ 目录：--lib <dir>（可重复）
# 注意：--baseline 默认为 HEAD；在已提交的树上用默认值会变成"自己比自己"。

# 3) 既有基准（另一份语料）：改动前一侧用 git archive 解出的树
mkdir -p /tmp/dsh-retention/base && git archive b7547f8 | tar -x -C /tmp/dsh-retention/base
ln -s "$PWD/node_modules" /tmp/dsh-retention/base/node_modules
(cd /tmp/dsh-retention/base && BENCH_RECORDS=20000 BENCH_CANONICAL=0,3000 BENCH_SAMPLES=7 \
  node --expose-gc scripts/benchmarks/domain-retention.mjs)
BENCH_RECORDS=20000 BENCH_CANONICAL=0,3000 BENCH_SAMPLES=7 \
  node --expose-gc scripts/benchmarks/domain-retention.mjs

# 4) 等价性（含时钟契约用例）
node --test test/dockyard-domain/retention-plan-equivalence.test.js
node --test test/dockyard-domain/archive-index-equivalence.test.js test/dockyard-domain/housekeeping-equivalence.test.js

# 5) 峰值 RSS 归因的原始数据（第 4.3 节）
ls docs/performance/retention-plan-rss/   # fresh.jsonl / external.jsonl / memo.jsonl / report.md

# 6) 反转表自身的校验：还原结果必须与 rc.7 固定产物逐字节相同
node -e '
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const pin = execFileSync("tar", ["-xzOf", "release/dsh-evolution-0.2.0-rc.7.tgz",
  "package/lib/dockyard-domain/memory.js"], { maxBuffer: 64 * 1024 * 1024 });
import("./test/dockyard-domain/archive-index-baseline.js").then(async (m) => {
  const b = await m.archiveIndexBaseline();
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  console.log("pin bytes", pin.length, hash(pin));
  console.log("reconstruction bytes", Buffer.byteLength(b.reconstructed), hash(b.reconstructed));
  console.log("byte-identical:", hash(pin) === hash(b.reconstructed));
});'
```

第 3.6 节的变异测试复现方式：在 `lib/` 与
`test/dockyard-domain/archive-index-baseline.js` 的对应片段里成对改动（否则会先被形状守卫
拦截），跑第 4 步的第一个命令；例如把分类循环里的 `timestamp(this.clock);` 删掉、
同时删掉反转表片段里的 `"        timestamp(this.clock);\n" +` 一行，应当得到
`exactly the folded sweep's one clock read per source row may disappear`。
