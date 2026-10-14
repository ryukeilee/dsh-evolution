# 保留计划：每行一次知识规范化，并去掉重复遍历与冗余深拷贝

本轮针对 `lib/dockyard-domain/memory.js` 的 `#knowledgeRetentionPlan()` 与 `#retentionPlan()`：
**同一条来源记录在一次计划里被规范化三遍**、**同一批记录被遍历两遍**，以及
**计划对自己已经拥有的知识行反复深拷贝**。改动只删重复计算与冗余复制，不改保留决策、
归档顺序、知识记录时间戳、异常行为与恢复语义；未修改官方 DSH 源码，也未触碰
`release/` 中的 rc.10 固定产物。

原始数据（本轮实际运行，未引用历史数字）：

- [`retention-plan-cost.json`](retention-plan-cost.json) —— 真实 `compact()` 链路，
  三个规模（2 000 / 10 000 / 40 000 冷行）、两个阶段（dryRun 规划 / 含档案重写的写入）、
  每侧每轮 3 样本 × 2 轮、A/B/B/A 轮换，含等价性断言结果；基线为显式 `--baseline b7547f8`；
- `docs/evidence/retention-plan-dsh-0.2.0-rc.2.json` 与
  `docs/evidence/retention-plan-dsh-0.2.1-alpha.1.json` —— 两个官方宿主的验收证据；
- 第 4.2 节的单改动归因与第 4.3 节的既有基准是探针运行，不在上述 JSON 中。

环境：Node `v26.11.1` / `darwin 27.0.0` / `arm64`，Apple M2，8 逻辑 CPU、16 GiB 内存。
测量开始时 load average 为 `1.57 / 1.80 / 1.80`；测量期间未并行运行测试、验收或其它基准。
CPU 为 `process.cpuUsage()` 的 user+system 增量，内存为采样下界（见第 4.1 节说明）。

## 1. 三个真实成本

### 1.1 同一条来源记录在一次计划里被 `normalizeKnowledgeEvent()` 三遍

`#retentionPlan()` 里 `collections` 覆盖除 `tombstones` 外的全部集合，而
`#knowledgeRetentionPlan(histories)` 对每个来源集合（除 `knowledge` / `tombstones`）
把每条记录规范化**两次**：

1. 累积遍（`for (const collection of sourceCollections)`）——真正需要完整事件：
   `knowledgeKey`、`occurredAt`（用于同组内排序）、`isKnowledgeCritical`、
   `sourceRetentionLimit`、以及 `mergeKnowledgeEntry` 的入参；
2. 保留遍（同一批 `sourceCollections` 的第二个循环）——**只判断该行是否为假值**，
   即"这一行是否完全没有知识身份"。

随后 `#retentionPlan()` 的分类循环对同一批行**第三次**调用它，而且同样只使用
真值性（`if (normalizedKnowledge && !retainedEntries.has(entry))`）。

`normalizeKnowledgeEvent()` 每次都会构造完整事件对象：6 个维度的文本规范化 + 一次
hash，外加 `outcome`、`confidence`、`metrics`、`recovery`、`relations`、`sourceRef`
等全部字段。也就是说，一次计划里每条来源行有 **2/3 的规范化结果只被当作布尔值读过一次**。

### 1.2 计划对自己已经拥有的知识行反复深拷贝

`histories` 是 `this.history(collection)` 的产物，而 `#mergeArchived(collection, hot)`
在默认 `copy: true` 下**总是**返回新对象（`hot.map(clone)` 或 `rows.map(clone)`）；
因此 `histories` 里的每一行已经是与 `#data` 脱钩的计划私有副本。在这个前提下，
`#knowledgeRetentionPlan()` 仍然：

- `knowledgeByKey.set(key, clone(entry))` —— 对已是副本的种子行再深拷贝一次；
- `return { knowledge: [...knowledgeByKey.values()].map(clone), … }` —— 对计划自己的
  结果再深拷贝一次；
- `#retentionPlan()` 的 `records[collection] = knowledgePlan.knowledge.map(clone)` ——
  出计划时再深拷贝一次。

`mergeKnowledgeEntry(previous, event, …)` 只读 `previous`（对象字面量里逐字段读取，
辅助函数 `appendBounded` / `mergeEffects` / `trendFor` 都不写回入参），因此这些拷贝
对正确性没有贡献。冷档案里 knowledge 行最大（本轮 40 000 行负载中 knowledge 占 8 000 行），
`structuredClone` 的成本集中在它身上。

### 1.3 同一批来源记录被遍历两遍

1.1 中的"保留遍"与累积遍遍历的是完全相同的 `(collection, entry)` 对
（同一 `sourceCollections`、同一 `histories[collection]` 数组）。它只是把
`normalizeKnowledgeEvent(...)` 为假值的行加进 `retainedEntries`，而 `retainedEntries`
在本文件内**只被 `.has()` 查询**（`knowledgePlan.retainedEntries.get(collection)?.has(entry)`），
不暴露给任何调用方，也不依赖插入顺序。

## 2. 改动

`lib/dockyard-domain/memory.js`，三组机制（备忘、折叠遍历、去掉冗余拷贝），均为最小有效修改：

1. **每行一次规范化。** `#knowledgeRetentionPlan()` 内新增
   `Map<collection, Map<entry, event|null>>` 备忘与
   `knowledgeEventOf(collection, entry, now)` 访问器；累积遍使用它，并把该访问器随计划
   结果返回，供 `#retentionPlan()` 的分类循环读取同一值。备忘键含集合与行对象本身，
   生命周期仅限本次调用，不跨调用、不长期增长。集合参与键，因此同一个对象出现在两个
   集合下时不会互相复用（各集合的 `sourceCollection` 字段不同）。
2. **备忘跳过规范化，但从不跳过时钟读取。** 每个读取方仍按行求值一次
   `timestamp(this.clock)` 并把该值传入；非对象行（值相等即 Map 键相等）**不进入备忘**，
   每次出现各自规范化。原因与实测见第 3.4 节。
3. **折叠保留遍。** `retainedEntries` 提前到累积遍之前创建；累积遍里
   `if (!event) { retainedEntries.get(collection)?.add(entry); continue; }`。
   原第二个循环访问的正是同一批行，结果集合只按成员判定，故插入顺序不可观测。
4. **去掉计划内部的冗余拷贝。** 种子 `clone(entry)`、计划结果的 `.map(clone)`、
   以及 knowledge 集合出计划时的 `.map(clone)` 三处删除。计划结果因此可能与它的
   `histories` 入参共享同一批对象，二者都在计划返回后被丢弃，`records` 的所有权交给
   调用方（`#compactUnlocked` 与知识定稿路径都只用 `plan.records` / `plan.report` /
   `plan.canonical`，`plan.histories` 在本仓库内没有任何读者）。

**保留未动的边界**：其它集合的 `retained.push(clone(entry))`、以及
`this.#data.canonical = plan.canonical.map(clone)` 两处都保留 —— 第 4.2 节显示删除它们
在噪声内，属于"收益不明显"的候选，不做无谓改动。

## 3. 等价性依据

### 3.1 反转表：改动后的源码仍能逐字节重建 rc.7 固定产物

本仓库的差分基线不是复制一份旧实现，而是把工作树的 `memory.js` 按注册的
`[post, pre]` 片段**反向还原**成改动前的源码，并要求它与 `release/dsh-evolution-0.2.0-rc.7.tgz`
里的 `lib/dockyard-domain/memory.js` **逐字节相同**（`test/dockyard-domain/archive-index-baseline.js`
的 `reconstructPreSharedScan()`，由 `archiveIndexBaseline()` 断言）。本轮在 `reversals`
表中新增 5 个片段（现共 18 个，覆盖本改动触及的全部区域）：

- 每个 `after` 片段在工作树中出现且仅出现一次（`assert.equal(source.split(after).length - 1, 1)`）；
- 每个 `before` 片段存在于 pin 中；
- 反向应用全部片段后与 pin 逐字节相同（生成脚本自带该校验，测试中再次断言）；
- 新增守卫 `assert.doesNotMatch(source, /knowledgeEventOf/)`，确保还原结果确实早于本备忘。

独立复核（第 3.5 节）自写脚本核对过：新增片段在工作树中命中 1 次、在 rc.7 pin 中命中 1 次，
全部片段反向应用后与 pin 的 SHA256 一致（`58a75e35…`，175 320 字节）；删掉或重复锚点分别
得到 `0 !== 1`、`2 !== 1`，不会静默 no-op。**该守卫只证明字符串形状**：改动已注册区域内任何
一行会被拦截，但同步更新反转表、或通过未注册区域/共享 helper 让基线与候选一起漂移，仍须靠
行为测试发现。

### 3.2 差分测试：真实冷档案上的报告、状态、字节与重复压缩

`test/dockyard-domain/retention-plan-equivalence.test.js` 把 `archiveIndexBaseline()`
还原出的改动前实现与本工作树**在同一份冷档案上跑同一条 `compact()` 链路**，要求逐项相同：

- dryRun 报告、首次压缩报告、第二次压缩报告；
- 压缩后的完整状态（`fullSnapshot()` 的 JSON 投影）；
- 磁盘上每个 state / 索引 / 活动档案 / 已封闭 segment 文件的 sha256；
- 第二次压缩后的状态与字节。

语料在比较之前先断言"确实做了决策"，避免空计划造成假等价。本轮三个用例的实际覆盖：

| 用例 | 覆盖的决策 | 实测 |
| --- | --- | --- |
| 冷档案差分 | 退役、折叠、观测聚合、累积器增长、tombstone、已封闭 segment | `retired 10`、`consolidated 27`、`aggregatedObservations 3`、`knowledge 6 → 16`、11 个文件 |
| 无档案层差分（`!archiveFile`） | 同一计划在内存分区上的另一半行为 | `retired 6`、`consolidated 27`、`knowledge 6 → 16` |
| 重复压缩收敛 | 第二轮稳定、第三轮不动 | `knowledge 19`、`retired 0`、`consolidated 0` |

语料本身还覆盖：累积器合并守卫的**两个方向**（`seed-0` 的 replay 被吸收、count 2；
`seed-1` 的累积器 `sourceRefs` 为空，replay 不被吸收、count 1）、可聚合的健康观测、
带 `errorCode`/`problem` 的诊断观测、可折叠 cycle 与带 meaningful stage 的知识承载 cycle
（进入 `cycles` 的无限保留分支）、终态 outcome / promotion 的退役、最新 lineage 保护、
完全没有知识身份的行（覆盖被折叠的保留遍）、以及写在 state 文件里的热行（覆盖
`#mergeArchived` 的热半区）。

累积器行的语料由真实维度生成：**存储的 `knowledgeKey` 永远不会被原样返回**
（`normalizeText` 会把 `:` 折成空格，于是显式键落到 `"knowledge:" + hash(dimensions)`），
所以合成键无法匹配任何来源行；这一点是第一轮复核用变异测试发现覆盖率为 0 的原因。

第二个用例断言重复压缩**收敛**而非一次到位：聚合后的观测行本身也是知识承载行
（`representativeSamples` 取代了顶层 `message`，身份因此与原始行不同），所以累积器会在
聚合行写出的**下一遍**才稳定。测试要求第三遍的状态与字节与第二遍完全相同、且
`knowledgeAfter === knowledgeBefore`，即不存在无界增长。

**不在此处断言所有权**：`history` / `snapshot` / `fullSnapshot` 等所有公开读取都会逐行
clone，黑盒测试无法观测"是否借用了活动行对象"。该主张改由第 3.3 节的推理、生产代码注释
与复核轮的探针（归档/非归档 × compact/finalize 四种组合）支撑，而不是一条永远为真的断言。

### 3.3 归属推理（为什么这三处删除是等价的）

- **备忘的精确性**：备忘值就是**累积遍**（原第一次调用）的结果，而原第二、三次调用
  只读真值性。`occurredAt` 只在累积遍被使用（`occurredAt` 排序、`mergeKnowledgeEntry`），
  因此"同一次调用内后续读取复用第一次结果"不改变任何被读取的字段。
- **折叠遍历的等价性**：两遍遍历的集合、数组与判断完全相同；`retainedEntries` 只被
  `.has()` 查询，故插入顺序与插入时机不可观测。
- **所有权**：`histories` 由 `#mergeArchived(..., { copy: true })` 深拷贝产生，
  与 `#data` 脱钩；`mergeKnowledgeEntry` 不改写入参；`plan.histories` 无读者。
  因此 `records` 中的 knowledge 行只有 `#data` 一个所有者。
  需要注意 `mergeKnowledgeEntry` 的输出并非完全无别名（空 `relations` 会复用旧
  `relationRefs`，`recovery` 可复用旧值），但那些旧对象都属于本次计划，未发现逃逸到
  外部的可变 owner。

### 3.4 时钟语义：备忘跳过规范化，不跳过时钟读取

原实现每个读取方按行求值一次 `timestamp(this.clock)`。第一轮复核用公开 `restore()`
构造了两条相同的**基本类型**行（`[1, 1, {…}]`）与逐次递增的时钟，证明第一版备忘把
时钟读取也一并合并了：父版把后续有效行的 `firstSeen`/`lastSeen`/`recentEvidence[].at`
定在 `.003Z`，第一版候选定在 `.002Z`。修复后：

| 侧 | clock 调用 | 知识行 firstSeen / lastSeen / recentAt |
| --- | ---: | --- |
| 改动前 `b7547f8` | 9 | `.003Z` / `.003Z` / `.003Z` |
| 第一版候选（修复前） | 2 | `.002Z` / `.002Z` / `.002Z` |
| 本工作树 | 6 | `.003Z` / `.003Z` / `.003Z` |

剩余差异是**被折叠掉的那遍遍历自身的时钟读取**（9 → 6）。它是"不再遍历"的直接后果，
无法在不保留空转读取的前提下消除。文件存储探针实测其可见形式：知识记录时间戳完全相同
（`1 / 3 / 4 ms`），而计划之后写入的**索引文档写时刻**由 `.015Z` 变为 `.011Z`
（15 → 11 次读取）。也就是说，一个在单次计划内推进的时钟会让"这次写入发生在何时"的
戳记前移所删除的读取次数，而知识身份、保留决策、归档顺序与知识记录时间戳不变。

### 3.5 复核轮次与变异测试

第一轮独立复核（对抗式，未参与实现）确认了上述时钟问题、测试覆盖缺口与基准复现缺口，
并独立验证了反转表、折叠遍历的等价性、所有权与失败路径（未触及 trial/teardown、跨进程锁、
CAS、journal、canary、重启恢复）。测试敏感度用三次注入实测：

| 注入 | 结果 |
| --- | --- |
| 改动已注册区域内的字面形状 | "must occur exactly once" 守卫失败，模块拒绝加载 |
| 只改基线一侧语义：保留每一条来源行 | 两个差分用例都以 `the dry-run report must be identical` 失败 |
| 只改基线一侧语义但**不改变任何决策**（早前一次尝试） | 通过 —— 说明"注入未改变决策"不构成敏感度证据，故采用上一行 |

## 4. 实测

### 4.1 真实压缩链路（三个规模，A/B/B/A，每侧每轮 3 样本 × 2 轮）

```sh
node --expose-gc scripts/benchmarks/retention-plan-cost.mjs \
  --baseline b7547f8 --samples 3 --rounds 2 --warmup 1
```

基线 = `b7547f8` 的 `lib/`（本改动之前的提交），变体 = 工作树 `lib/`。语料由**基线模块
自己的公开函数**（`normalizeKnowledgeEvent` + `mergeKnowledgeEntry`）生成一次后原样写给
两侧，因此变体无法定义自己的夹具。表内为中位数：

| 规模（冷行） | 阶段 | wall 基线 → 变体 | Δ | CPU 基线 → 变体 | 采样堆增量 基线 → 变体 | 采样峰值 RSS 基线 → 变体 |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 2 000 | dryRun 规划 | 81.06 → 51.22 ms | −36.8% | 97.22 → 68.88 ms | 31.3 → 7.0 MB | 123.0 → 123.0 MB |
| 2 000 | 含档案重写 | 111.63 → 81.00 ms | −27.4% | 125.40 → 91.74 ms | 27.4 → 9.3 MB | 133.0 → 132.2 MB |
| 10 000 | dryRun 规划 | 386.48 → 239.87 ms | −37.9% | 433.05 → 270.64 ms | 48.6 → 31.8 MB | 235.7 → 236.0 MB |
| 10 000 | 含档案重写 | 580.84 → 437.49 ms | −24.7% | 676.39 → 518.58 ms | 47.1 → 41.8 MB | 259.8 → 261.2 MB |
| 40 000 | dryRun 规划 | 1 484.89 → 923.65 ms | −37.8% | 1 709.03 → 1 101.80 ms | 164.7 → 104.7 MB | 666.1 → 731.1 MB |
| 40 000 | 含档案重写 | 2 392.87 → 1 834.52 ms | −23.3% | 2 668.83 → 2 041.00 ms | 215.1 → 134.6 MB | 818.3 → 863.0 MB |

同一轮里每个规模、每个阶段都执行了等价性断言，全部 PASS：
报告（dryRun / 首次 / 第二次）、完整状态、档案字节 sha256、第二次压缩的状态与字节、
以及 dryRun 不改变状态与档案。独立复核把基线固定在 `b7547f8` 后，对**第一轮候选**（尚未包含第 3.4 节的时钟修复）复测
10 000 行，得到 dry-run `388.26 → 235.55 ms`（−39.3%）、write `576.33 → 430.48 ms`
（−25.3%），与本表同量级。

三点必须如实说明：

- **CPU 与 wall 同向**：规划阶段 CPU 时间下降约 30–36%，说明收益来自真实计算减少，
  不是调度或 I/O 抖动；
- **采样峰值 RSS 不是收益**：40 000 行规划阶段基线 666.1 MB、变体 731.1 MB，
  写入阶段 818.3 → 863.0 MB，方向与堆增量的下降**相反**。该数字是 2 ms 采样下界
  （同步规划期间计时器无法插入），受 GC 时机影响，本轮**不作为收益主张**；
- **写入阶段收益小于规划阶段**（−23.3% ~ −27.4% vs −36.8% ~ −37.9%）：写入阶段包含
  `#rewriteArchives()` 的逐行序列化、落盘、索引重写与 state 保存，这些成本不随本轮
  改动下降，因此被摊薄。

### 4.2 单改动归因（哪一处删除值得保留）

知识密集负载（5 000 条 knowledge 累加行 + 5 000 条 observations），同一批次内
7 个变体交替、5 轮 × 每轮 9 样本取中位数，再取 5 轮中位数：

| 变体 | 内容 | 规划中位耗时 | 相对 `b7547f8` |
| --- | --- | ---: | ---: |
| V0 | 改动前（`b7547f8`） | 434.2 ms | — |
| V1 | 仅备忘 + 折叠遍历 | 384.7 ms | −11.4% |
| V2 | V1 + 删除种子拷贝与计划结果拷贝 | 297.0 ms | −31.6% |
| V3 | V2 + 删除 `retained.push(clone(entry))` | 297.2 ms | −31.5%（无增益） |
| V6 | V2 + 删除 `plan.canonical.map(clone)` 两处 | 297.0 ms | −31.6%（无增益） |
| V5 | V2 + 删除 knowledge 出计划拷贝（**本轮采用**） | 259.0 ms | −40.3% |
| V4 | V5 + V3 + V6 全部删除 | 257.6 ms | −40.7%（与 V5 差异在噪声内） |

结论：删除 knowledge 出计划拷贝值得做（相对 V2 −12.8%）；删除
`retained.push(clone(entry))` 与 `plan.canonical.map(clone)` 在噪声内，**明确放弃**。
V4 与 V5 的差（257.6 vs 259.0 ms）说明这两个被放弃的删除即使在最有利的读法下也小于
批间波动，不值得为它们承担 canonical 表与其它集合的所有权变更。

### 4.3 既有基准（另一份语料，独立复现）

本仓库已有的 `scripts/benchmarks/domain-retention.mjs` 驱动真实 `compact({ dryRun: true })`，
语料是 20 000 条终态 outcomes（按 canonical 表 0 / 3 000 两个规模），7 样本中位数：

| canonical 规模 | 改动前 | 本轮 | Δ |
| ---: | ---: | ---: | ---: |
| 0 | 1 129.47 ms | 880.15 ms | −22.1% |
| 3 000 | 1 130.69 ms | 882.89 ms | −21.9% |

该基准的语料以 outcomes 为主（knowledge 行少），因此收益小于第 4.1 节的知识密集负载，
但方向一致：同一改动在两种不同语料上都被复现。

## 5. 收益边界

- 收益与"每条来源行一次规范化"的成本成正比，因此**来源集合越大收益越大**；
  空计划或只有极少量来源行的计划收益接近 0。
- 收益只在 `compact()` / 知识定稿的保留计划路径上；写入路径的档案重写、索引与
  state 落盘成本不变（第 4.1 节写入阶段的 −23.3% ~ −27.4% 是规划部分的摊薄结果）。
- 备忘只活在单次计划内，**不引入跨调用缓存**，因此没有长期内存增长、没有失效语义、
  也不改变并发或多进程行为。
- 保留"每行一次时钟读取"的代价包含在 4.1/4.2 的数字里（第一版备忘的规划耗时在
  10 000 行负载上为 235.34 ms，修复后 239.87 ms，约 +1.9%），换来的是知识记录时间戳
  与改动前一致（第 3.4 节）。
- 删除的深拷贝把计划输出的所有权交给调用方；`retained.push(clone(entry))` 与
  `plan.canonical.map(clone)` 两条边界仍然保留，其它集合与 canonical 表的
  输出仍与输入脱钩。

## 6. 验证

```sh
node --test test/dockyard-domain/retention-plan-equivalence.test.js   # 3/3
node --test test/dockyard-domain/archive-index-equivalence.test.js \
            test/dockyard-domain/housekeeping-equivalence.test.js     # 28/28
npm test                                                             # 325 tests, 323 pass, 2 fail
npm run release:pack                                                 # 本地产物（dist/，不入库）
node scripts/acceptance/run-host-acceptance.mjs --host 0.2.0-rc.2 \
  --out docs/evidence/retention-plan-dsh-0.2.0-rc.2.json             # 21/21 ok
node scripts/acceptance/run-host-acceptance.mjs --host 0.2.1-alpha.1 \
  --out docs/evidence/retention-plan-dsh-0.2.1-alpha.1.json         # 21/21 ok
```

- **官方宿主验收**：两个宿主各自 21/21 通过（`host-install`、`plugin-add`、
  `profile-lists-bundle`、`doctor-cli`、`core-flow`、lifecycle 六项、卸载/重装、
  升级/回滚、promotion 三项、`doctor-final`），证据记录的内容摘要为
  `a6ca153d3e309fc89a9c5cbb681af95efd8d82beec280373fe3d996bfd6e8ca1`，
  与本工作树当前构建的内容一致。脚本在 `mkdtemp` 下建隔离的 `runtime` 与 `home`，
  并以 `DSH_HOME` 指向该 home，未触碰正式 `DSH_HOME`；它继承 `process.env`，
  因此普通 `HOME` 与包管理器配置并未单独隔离。
- **`npm test` 的 2 个失败是预期的发布固定点守卫**
  （`the working tree still builds exactly the pinned content`、
  `every shipped file in the tree matches the artifact byte for byte`），不是回归：
  它们在**改动前的提交** `b7547f8` 上同样失败（在 `git archive b7547f8` 解出的树上
  `node --test test/release-pin.test.mjs` 得到 5 pass / 2 fail，失败项相同，且都首先报告
  `lib/dockyard-domain/knowledge.js` 与产物不同）；原因是 rc.10 固定点早于最后几次提交，
  本轮只让 `memory.js` 继续处于"与固定产物不同"的状态，没有触碰 `release/`、没有 bump
  版本、没有发布、没有 tag。
- **`npm run pack:check`** 因此只报固定点相关的 3 项失败（`release/manifest.json` 固定
  内容 `1749210…`，本树构建 `a6ca153d…`，以及 manifest 声明的验收证据仍是旧内容），
  其余检查（打包稳定性、内容白名单、权限、锁文件、文档一致性、README/CHANGELOG 一致性）
  全部通过。按 `RELEASE.md`，重新固定必须"重跑两个宿主验收 → `release:publish`"，
  属于外部写入，本轮未执行。

## 7. 剩余风险

- **时钟读取次数**（第 3.4 节）：被折叠掉的那遍遍历不再读取时钟，因此一个在单次计划内
  推进的时钟会让计划**之后**写入的索引文档/档案元数据时间戳前移所删除的读取次数
  （实测 15 → 11 次读取，`.015Z` → `.011Z`）。知识记录时间戳、保留决策与归档顺序不变。
  生产时钟按真实时间推进，该差异是"这次写入发生在何时"的戳记，不改变任何保留判断。
- **采样内存**：峰值 RSS 为下界，且本轮方向与堆增量相反，不作为收益主张（第 4.1 节）。
- **未覆盖的规模与平台**：最大规模为 40 000 冷行 / 8 000 knowledge 行，未测量
  `compactionTriggerBytes` 附近的更大档案；只在 Node `v26.11.1` / darwin-arm64 上测量，
  未覆盖 Node 22 与其它平台。
- **`plan.histories` 成为死字段**：删除 knowledge 出计划拷贝后，
  `records.knowledge` 与 `plan.histories.knowledge` 是同一批对象。当前仓库内没有任何读者，
  但若将来有人消费 `plan.histories` 并原地修改，就会看到与 `records` 共享的对象。
  这是本次改动引入的、需要在注释中保留的不变量（`#knowledgeRetentionPlan()` 的文档注释
  已写明所有权）。
- **反转表的证明边界**（第 3.1 节）：它证明形状与还原字节，不证明语义；语义等价靠
  第 3.2/3.5 节的差分与注入。
- **收敛性**：第 3.2 节的收敛结论在给定语料上成立（第三轮不动），不能证明任意历史数据
  都收敛；无界增长会被该用例捕获。

## 8. 复现

```sh
# 1) 真实压缩链路 A/B（基线 = 本改动之前的提交，变体 = 工作树）
node --expose-gc scripts/benchmarks/retention-plan-cost.mjs \
  --baseline b7547f8 --samples 3 --rounds 2 --warmup 1 \
  --out docs/performance/retention-plan-cost.json
# 更快的冒烟： --scales 2000 --samples 1 --rounds 1 --warmup 1
# 任意一侧换成本地 lib/ 目录：--lib <dir>（可重复）
# 注意：--baseline 默认为 HEAD；在已提交的树上用默认值会变成"自己比自己"。

# 2) 既有基准（另一份语料）：改动前一侧用 git archive 解出的树
mkdir -p /tmp/dsh-retention/base && git archive b7547f8 | tar -x -C /tmp/dsh-retention/base
ln -s "$PWD/node_modules" /tmp/dsh-retention/base/node_modules
(cd /tmp/dsh-retention/base && BENCH_RECORDS=20000 BENCH_CANONICAL=0,3000 BENCH_SAMPLES=7 \
  node --expose-gc scripts/benchmarks/domain-retention.mjs)
BENCH_RECORDS=20000 BENCH_CANONICAL=0,3000 BENCH_SAMPLES=7 \
  node --expose-gc scripts/benchmarks/domain-retention.mjs

# 3) 等价性
node --test test/dockyard-domain/retention-plan-equivalence.test.js
node --test test/dockyard-domain/archive-index-equivalence.test.js test/dockyard-domain/housekeeping-equivalence.test.js

# 4) 反转表自身的校验（还原后必须与 rc.7 固定产物逐字节相同）
node -e 'import("./test/dockyard-domain/archive-index-baseline.js").then(async (m) => {
  const b = await m.archiveIndexBaseline();
  console.log("pinPredatesScan:", b.pinPredatesScan, "| source === reconstructed:", b.source === b.reconstructed);
})'

# 5) 时钟语义探针（第 3.4 节）：逐次递增的时钟 + 两条相同基本类型行
#    改动前 / 本工作树两侧的 firstSeen/lastSeen/recentEvidence[].at 必须相同
```

第 4.2 节的单改动变体复现方式：把工作树 `lib/` 复制到 `/tmp` 若干份，按表内说明分别对
副本应用对应改动（把 `knowledgeByKey.set(key, entry)` 改回 `clone(entry)`、把计划结果
`.map(clone)` 加回、把 `records[collection] = knowledgePlan.knowledge` 改回
`.map(clone)`、把 `retained.push(clone(entry))` 改成 `retained.push(entry)`、把
`plan.canonical.map(clone)` 改成 `plan.canonical`），再用
`retention-plan-cost.mjs --lib <副本>` 或在副本内跑 `domain-retention.mjs` 对比。
