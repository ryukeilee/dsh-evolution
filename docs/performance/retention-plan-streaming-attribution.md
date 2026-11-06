# 保留计划与压缩的流式归因：完整历史物化点、historyView 行所有权与候选安全性

本轮只做**只读归因**：不修改 `lib/`、`test/`、`release/` 与 `package.json`，不提交。目标是
用 `origin/main`（`a1db591`，即本 worktree 的 `HEAD`）的实际代码确定大历史下
`#retentionPlan()` / `#knowledgeRetentionPlan()` / `history()` / `#mergeArchived()` /
`#readArchiveSync()` / `#rewriteArchives()` / `compact()` 的真实内存热点，并给出可证明的
最小候选设计。候选本身尚未实现，本文所有"会省多少"的主张都标成待实现验证，实测只覆盖
**当前实现**。

复现脚本：[`scripts/benchmarks/retention-plan-attribution.mjs`](../../scripts/benchmarks/retention-plan-attribution.mjs)
（`--mode ownership|retention|all`，`--out` 写完整 JSON）。本轮原始输出未随仓库提交（本任务
写入范围只有脚本与本文件）；本文第 4 节的表格就是该次运行的数值，按第 8 节命令可逐项复算。
测量用的 `lib/` 树由 `git archive <ref> lib` 解出到临时目录，**不读工作树 `lib/`**；retention 模式再加一个临时副本，在列出的源码行旁插入 `globalThis.__attr?.(...)`
钩子——视觉上只是多了一次空属性读取，`__attr` 未安装时不保留任何引用。仓库的 `lib/` 保持
`origin/main` 字节不变（见第 8 节 `git status`）。

环境：Node `v26.13.0` / darwin arm64 / Apple M2，8 逻辑 CPU、16 GiB。基准负载与
[`retention-plan-cost.md`](retention-plan-cost.md) 同形：40% observations、20% knowledge
累加行、20% 观测 cycles、10% 终态 outcomes、10% rejected promotions，canonical 指针保护
一部分 outcomes；行数按**冷归档总行数**计。

## 1. 数据流：一次 compact() 里历史被完整物化几次

```
compact({dryRun})
└─ #compactUnlocked
   ├─ #archiveBytes()                      stat 每个归档文件，不解析
   ├─ #retentionPlan()                      ← 规划期（dryRun 与真实 compact 都走）
   │  ├─ #performHousekeeping()             就地整理热池、补 tombstone（既有行为）
   │  ├─ histories[c] = history(c)           ← 物化点 1（每个来源集合各一次）
   │  │  └─ #mergeArchived(c, hot, copy:true)
   │  │     ├─ #readArchiveSync(c)           ← 物化点 2（完整历史读）
   │  │     │  ├─ #archiveRead(c)            缓存命中：adopt 已有表；未命中：整档扫描
   │  │     │  │  └─ #scanArchiveFiles        逐行 JSON.parse 全部行；只保留键表 + 行窗口
   │  │     │  └─ #archiveRowsFrom              窗口行直接复用；窗口外逐行 open/read/JSON.parse
   │  │     ├─ Map 合并（archived 在前、hot 覆盖同 id）＋ rows 数组
   │  │     └─ rows.map(clone)               ← 深拷贝点 1：每个合并行一次 structuredClone
   │  ├─ allRecords = flatMap({collection,entry})   ← 包装数组：每行一个 {collection, entry}
   │  ├─ canonicalByKey：逐 #data.canonical 行 clone  ← 深拷贝点 2
   │  ├─ retiredByCanonical：strategies/lineage/promotions 行构造 canonical 候选（新对象，暂态）
   │  ├─ tombstoneMap = history("tombstones")  ← 物化点 3（再一次完整历史读 + clone）
   │  ├─ observationGroups：references 分组（指针数组）
   │  ├─ #knowledgeRetentionPlan(histories)
   │  │  ├─ knowledgeByKey 种子 = histories.knowledge 行（引用）
   │  │  ├─ 逐来源行 normalizeKnowledgeEvent（每行一个新事件对象）
   │  │  │  └─ mergeKnowledgeEntry → clone(effects)＋appendBounded 的若干次 clone ← 深拷贝点 3
   │  │  └─ sourceGroups：每行 {collection, entry, event}（暂态分组对象）
   │  └─ records：逐集合逐行
   │     ├─ 保留行 retained.push(clone(entry))       ← 深拷贝点 4：每个保留行再一次 clone
   │     ├─ 折叠行 compactObservation*/compactCycleRecord（safeRecord 深复制，新对象）
   │     └─ 退休行 tombstoneFor(...)（safeRecord 新对象，丢弃原行）
   ├─ oldData = clone(this.#data)           ← 深拷贝点 5：整份热状态（dryRun 也做，见候选 d）
   └─ dryRun ? return report : 进入写入路径
      ├─ #rewriteArchives(plan)
      │  ├─ inspectArchiveIntegrity()        ← 物化点 4：整份归档字节 + 逐行文本 + 逐行 JSON.parse
      │  ├─ 逐个冷行 boundedArchiveEntry().raw（序列化；pendingLines 有界）
      │  ├─ 安装后回读校验：archived = #readArchiveSync(c)  ← 物化点 5（第二次完整历史读）
      │  │  └─ #archiveRowsFrom 的 buffers：把该集合整份归档字节读进内存
      │  ├─ #writeArchiveIndex()            ← 物化点 6：再次整档逐行解析（用于索引事实）
      ├─ #data[c] = plan.records[c].slice(-hotLimit)   （引用移交，不拷贝）
      ├─ #data.canonical = plan.canonical.map(clone)  ← 深拷贝点 6
      ├─ #data.tombstones = (...).map(clone)          ← 深拷贝点 7
      ├─ await #save()
      │  └─ snapshot() = clone(#data)                  ← 深拷贝点 8（热状态；另有 #performHousekeeping）
      └─ archiveTransaction.commit()
```

要点：

- **规划期窗口外的每个冷行被解析两次、窗口内的行解析一次**：`#readArchiveSync` 的扫描一次（未命中缓存时）、
  `#archiveRowsFrom` 对窗口外行逐行再读一次；随后 `histories` 把它 clone 一次，`records`
  对保留行再 clone 一次。窗口内的行（每集合最多 `ARCHIVE_ROW_WINDOW_ROWS`=2048 行 /
  `ARCHIVE_ROW_WINDOW_BYTES`=4 MiB）第一次读只解析一次，因为扫描保留下来的窗口对象被复用。
- **写入期再完整读两到三遍归档**：`inspectArchiveIntegrity`（整文件字节 + split 行 +
  逐行 parse）、安装后的 `#readArchiveSync` 回读、`#writeArchiveIndex`（逐行 parse 后只留
  键集合与首末行）。这些读都不长时间保留行对象，但会显著抬高进程峰值与分配量。
- **窗口外的行永远只被"读"、不被缓存**：缓存条目只有键表 + 窗口（`#archiveReadCacheFor`
  注释、`#archiveRowWindow`）。这是候选 (b) 的所有权依据。
- `historyView()` 只跳过 `rows.map(clone)` 与 `records` 的二次 clone 中的前者；它不跳过
  任何解析——完整历史仍必须从文件读到内存才能做决策。

代码位置（本文引用的行为都在 `lib/dockyard-domain/memory.js`，行号以 `origin/main`=`a1db591` 为准）：

| 行为 | 位置 |
| --- | --- |
| `#mergeArchived`（合并 + `copy:true` 时 clone） | L2966 |
| `history()` / `historyView()` | L3003 / L3020 |
| `#scanArchiveFiles`（逐行 parse、只留键表+窗口） | L1853 |
| `#archiveRowAt`（窗口命中条件、窗口外逐行回读） | L1992 |
| `#archiveRowsFrom`（完整历史行：窗口复用+窗口外回读） | L2040 |
| `#readArchiveSync`（完整历史读、fallback `collectRows`） | L2061 |
| `#archiveRowWindow`（2048 行 / 4 MiB 窗口上限） | L1647 |
| `#archiveRead` / `#adoptArchiveRead`（缓存身份校验与 adoption） | L1681 / L1450 |
| `#knowledgeRetentionPlan` | L4888 |
| `#retentionPlan` | L4944 |
| `#rewriteArchives`（完整性门禁、回读校验、索引重写） | L5173 |
| `compact` / `#compactUnlocked` | L5353 / L5358 |
| `#writeArchiveIndex`（索引重建的逐行解析） | L2592 |

## 2. 一次计划里的对象数量级

以 40 000 冷行为例（observations 16 000 / knowledge 8 000 / cycles 8 000 / outcomes
4 000 / promotions 4 000；canonical 指针保护 outcomes 的 1/16），下列计数都是**行数**，
不是字节数；字节量见第 4 节实测：

| 结构 | 数量级 | 何时创建、活多久 |
| --- | ---: | --- |
| `histories[c]` 行对象（clone 后） | 40 000 | `#retentionPlan` 开始到返回；dryRun 返回后死亡 |
| `#readArchiveSync` 窗口外新解析行（暂态） | 40 000 − 窗口行 | 每个集合 `#mergeArchived` 内；该集合 clone 完成即可回收 |
| 缓存窗口行（常驻） | ≤2048/集合（大集合按 4 MiB 字节上限） | 读一次后常驻 `archiveReadCache`，跨调用存活 |
| `allRecords` 包装对象 | 40 000 | `#retentionPlan` 内，`{collection, entry}` 指针 |
| `knowledgeByKey` 条目 | 10,000（40k 语料实测；16,000 个有知识身份的来源行折叠成 2,000 组） | 计划期 |
| `sourceGroups` 分组对象 | 16,000 个（每个有知识身份的来源行 1 个 `{collection, entry, event}`） | 计划期；`event` 是完整规范化事件 |
| `retainedEntries` Set 条目 | 20,500（observations 11,000 / cycles 8,000 / promotions 1,000 / outcomes 500） | 计划期 |
| `records` 保留行 | 21,253（observations 3,001 / cycles 8,000 / knowledge 10,000 / outcomes 250；tombstone 2） | 计划到写入结束；知识行可能是计划内新对象 |
| `plan.canonical` | 250（本语料没有新 canonical 候选） | 计划到写入结束 |
| `records.tombstones` | 2（本语料） | 计划到写入结束 |
| `oldData` 克隆行 | 热状态（≤ hotLimit×集合 + canonical + marker 窗口） | 真实 compact 全程；dryRun 里创建后立即丢弃 |

## 3. historyView() 行的所有权判定

### 3.1 判定方法（只用对象身份，不用时间/内容启发）

对同一集合连续调用两次 `historyView(collection)`，再与两个已知所有者比对：

1. **热行**：`load()` 把 `stateStore.load()` 返回文档里的数组**原样**赋给 `#data[collection]`
   （见 `load()` 的 `observations: Array.isArray(stored.observations) ? stored.observations : []`），
   所以测试里保存第一次 `load()` 返回的文档，其行对象就是 `#data` 活行。探针用一个文件
   stateStore 并保留首份解析结果即可判定。
2. **缓存窗口行**：`memory.archiveReadCache` 是实例上的普通字段（构造函数会从传入
   `archiveReadCache` 复制条目，所以探针读实例自己的 Map，而不是传入的 Map），条目
   `entry.window` 里的行对象就是缓存持有的活对象。
3. **本次调用新解析行**：既不在上面两者中的行。

判定证据：`#readArchiveSync()` 对窗口内位置返回缓存对象，对窗口外位置调用
`#archiveRowAt()` 逐行 `open/read/JSON.parse` 出**新对象**。因此
**第二次调用里对象身份不变的行只能来自 store 或缓存窗口；身份变化的行一定是本次新解析**。
脚本同时用插桩计数交叉验证：`#archiveRowAt` 的窗口命中/未命中计数、`#mergeArchived` 的
`archived/hot/rows` 计数、`#readArchiveSync` 调用次数都被记录。

### 3.2 必须同时验证的四条规则

1. **同 id 覆盖**：`#mergeArchived` 先遍历 `[...archived, ...hot]` 写 Map，最后
   `[...merged.values(), ...anonymous]`。同 id 时返回的是**热对象**（位置停留在归档位置），
   探针把"热行对象出现在返回数组里"作为断言。
2. **无 id 行与热行多出的行追加在末尾**：无 id 的归档行进 `anonymous` 数组，追加在合并行
   之后；热集合里多出来的 id 也按 Map 首次插入顺序排在归档行之后。计划里的 `latestLineage`
   平局、tombstone 合并顺序依赖这个数组顺序，候选不得改变它。
3. **窗口命中条件是位置区间，不是 id**：`#archiveRowAt` 只检查
   `windowFrom <= position < keys.length` 且该槽位非空（tombstone 槽位是洞，由
   `#fillArchiveWindow` 用定位符补读）。因此"缓存所有权"= 行来自窗口，与内容、大小无关。
4. **`#readArchiveSync` 的 fallback 不把 rows 放进缓存**：
   ```
   const located = this.#archiveReadParts(collection);
   const { rows, ...entry } = this.#scanArchiveRead(..., { collectRows: true });
   if (located) this.archiveReadCache.set(collection, { ...entry, parts, identity, inherited: false });
   this.#adoptArchiveRead(collection, entry);
   return rows;
   ```
   `rows` 被解构掉，缓存条目只有 `entry`（键表 + 窗口）。fallback 扫描的 `window` 数组与
   `rows` 中窗口位置引用的**是同一批对象**：所以 fallback 返回数组同样是"窗口行=缓存持有、
   其余=本次新解析"，所有权规则不变。探针用插桩副本强制
   `#archiveRowsFrom` 抛错进入该分支，并对 `observations`（>2048 行，窗口外有行）与
   `knowledge`（大行、可能触字节上限）分别在冷/热缓存下各测一次。

### 3.3 结论（可直接实现的规则）

对 `historyView(collection)` 返回数组中的任一行 `row`：

```
owned(row) := !hotSet.has(row) && !cacheWindowSet.has(row)
hotSet       = 当前 #data[collection] 的行（用行对象身份）
cacheWindowSet = 当前 archiveReadCache.get(collection).window 中非空槽位的行
```

`owned(row) === true` 时，该行**只被本次读取持有**，调用方可以把所有权转移给计划输出
（写进 `records`、最终进 `#data`），不需要 clone。`owned(row) === false` 时必须 clone：
热行属于 `#data`（另一个所有者，且 `oldData` 回滚快照/后续 housekeeping 都可能有引用），
窗口行属于缓存（缓存必须永远是磁盘字节的忠实只读视图）。

这条规则依赖三个实现事实，改动时必须一起维护：

- `#readArchiveSync` / fallback 的解析行不进入任何缓存条目；
- 缓存条目只持有键表 + `window`；`rows` 从不进缓存；
- 窗口之外的行每次读取都重新 parse（`#archiveRowAt` 没有对象缓存）。

注意热行的 clone 成本有上界（每集合 `hotLimit` 行 + knowledge 200 + 一个 canonical 表 +
marker 窗口），窗口行每集合最多 2048 行 / 4 MiB，都不随历史增长。因此候选 (b) 的 clone
总量是 **有界的**，而可转移的新解析行是**无界的大部分**。

### 3.4 给实现方的所有权判定伪代码（C2 白名单，可直接照抄）

```js
// 只允许在 #retentionPlan() 内部使用；在 merged read 返回之后计算，
// 绝不能在读取之前或读取过程中计算（#archiveRowAt 重试会 delete + 重扫缓存，
// #fillArchiveWindow 也会在扫描中补洞，读取前的 window 集合可能是旧的）。
const { rows } = this.#historyViewForPlan(collection);   // rows 是本次调用自己的数组
const cache = this.#archiveReadCacheFor(collection);     // 读调用之后的缓存条目
const cacheWindow = new Set((cache?.window ?? []).filter((row) => row !== undefined));
const hot = new Set(this.#data[collection]);             // 本集合的 #data 活行对象
const owned = new WeakSet();
for (const row of rows) {
  // 无归档时 cache 为 null -> cacheWindow 为空；此时 rows 全是热行 -> owned 为空。
  // inherited 条目同样是缓存条目（window 行与 predecessor 共享），算 cache 所有。
  // 非对象行不能进 WeakSet；它们 clone 成本可忽略，一律按 clone 处理。
  if (row && typeof row === "object" && !hot.has(row) && !cacheWindow.has(row)) owned.add(row);
}
// ……计划内部只读 rows，进入任何输出时：
//   const out = owned.has(row) ? row : clone(row);
// 输出位置：非 knowledge 集合的 retained.push(...)、knowledge 输出的种子行、
// 以及任何其它会把 view 行放进 records/plan 的地方。
// #retentionPlan() 返回前必须丢弃 rows / owned / cacheWindow / hot：
// 它们只是判定用的短暂结构，绝不能进入 records、plan.canonical、plan.report，
// 也不能挂在实例字段上（否则等于把一次读音的缓存所有权带进持久状态）。
```

必须保持的边界：

- 无归档（`this.archiveFile === null`）时 `#mergeArchived(copy:false)` 返回的全是
  `#data` 行，`owned` 为空，行为退化为"全部 clone"，与今天一致。
- fallback（`collectRows`）路径返回的行同样按此规则分类：窗口区间行是调用后缓存的
  `window` 对象（实测 2048/2048 同一对象、0 例外），窗口外行是新解析对象（实测第二次
  调用身份全变）。不能因为"fallback 是异常路径"就跳过所有权判定。
- inherited 缓存：successor 的条目对象是新的浅拷贝，但 `window` 的行对象与 predecessor
  共享；它仍然是 cache 所有，必须 clone。
- `owned` 判定完成后，`#retentionPlan()` 内不得再调用任何会改变 `archiveReadCache` 的
  东西（当前没有：计划是同步只读的）；若将来加入，必须重新判定。

## 4. 实测：阶段存活量、保留量与被拷贝对象的数量

### 4.1 方法

每个（阶段 × pin）组合在**独立子进程**里跑一次：加载夹具 → `global.gc()` 两次 → 记起点 →
`compact(dryRun|write)`。阶段点在计划的固定位置强制 `global.gc()` 两次后读 `process.memoryUsage()`
与 `v8.getHeapSpaceStatistics()`，得到的是**该点的活对象集**（不是分配器高水位）。pin 在阶段点
抓住该阶段对象图，调用返回后再 GC 一次，比较"抓住/释放"两次的 `heapUsed`，得到**该阶段对象图的
增量保活量**（相对返回后仍可达的 store/缓存对象；多阶段对象图有重叠，不可相加）。每次运行都
复制一份夹具，写路径不会污染下一次。`JSON.parse` 与 `structuredClone` 在子进程里被计数包装，
按阶段差分归属；`load()` 期间的计数单独记录（`loadParse=40,001`：state 1 + 开放时索引重建
整档 40,000）。

夹具（40 000 冷行）：observations 16 000、knowledge 8 000、cycles 8 000、outcomes 4 000、
promotions 4 000；canonical 250 行；归档 22.97 MB。10 000 行版本同比例。

### 4.2 规划期阶段活集（40 000 行，dryRun）

`Δstart` 是相对调用前活堆（10.22 MiB）。`parse+`/`clone+` 是相对上一个阶段点的增量；相邻
阶段点之间可能夹着若干未单独打点的集合读取，所以逐集合的解析次数在 4.4 节按"行数 + 窗口"
分解。

| 阶段 | 活堆 MiB | Δstart | parse+ | clone+ | 该点主要内容 |
| --- | ---: | ---: | ---: | ---: | --- |
| 起点（load 后、GC） | 10.22 | — | — | — | 热状态 + 空缓存 |
| `rowsFrom:observations` | 17.39 | +7.17 | 29,952 | 1 | observations 整档读：扫描 16,000 + 窗口外回读 13,952 |
| `merge:observations` | 17.95 | +7.73 | 0 | 0 | archived(16,000)+hot(0)+rows 指针数组 |
| `rowsFrom:knowledge` | 48.16 | +37.94 | 39,808 | 32,000 | observations 之后 promotions/outcomes/cycles/knowledge 的读取；前四个集合的 clone（knowledge 的 clone 在下一阶段） |
| `merge:knowledge` | 48.43 | +38.21 | 0 | 0 | knowledge archived 8,000 |
| `histories`（全部 clone 完） | 55.98 | +45.76 | 0 | 8,000 | `histories[c]` 40,000 行私有副本 |
| `allRecords` | 57.91 | +47.69 | 0 | 0 | 40,000 个 `{collection, entry}` 包装 |
| `preKnowledge` | 57.83 | +47.61 | 0 | 250 | canonical 种子 clone 250 |
| `knowledgeInner`（累积遍完成） | 72.80 | **+62.58** | 0 | **120,000** | knowledgeByKey 10,000 + sourceGroups 16,000 项（含事件对象） |
| `knowledgeOutput` | 72.85 | **+62.63** | 0 | 0 | knowledge 输出数组 10,000 行（本计划峰值） |
| `knowledgePlan`（返回后） | 62.70 | +52.48 | 0 | 0 | 事件/sourceGroups 释放，histories+knowledge 输出仍在 |
| `preRecordsEnd` | 67.84 | +57.62 | 0 | 3,250 | records 物化完成（保留行 clone 3,250） |
| `plan`（`#retentionPlan` 返回） | 67.84 | +57.62 | 0 | 0 | records+canonical+tombstones |
| `planReturned`（compact 内） | 56.28 | +46.06 | 0 | 0 | histories/知识计划内部结构释放，只剩 plan |
| `oldData` | 56.39 | +46.17 | 0 | 1 | 冷夹具下 oldData ≈ 0.1 MiB |
| 返回后（GC） | 23.48 | +13.26 | — | — | 其中约 13.3 MiB 是档案缓存（5×2048 窗口行 + 4 万键表/定位符） |

写入阶段（真实 `compact()`）在 `oldData` 之后继续：

| 阶段 | 活堆 MiB | Δstart | parse+ | 该点主要内容 |
| --- | ---: | ---: | ---: | --- |
| `oldData`（承接规划峰值后） | 56.39 | +46.17 | 0 | plan + oldData |
| `rowsFrom:observations`（回读） | 55.51 | +45.29 | 43,855 | `inspectArchiveIntegrity` 整档 40,000 + 回读 observations 3,854 |
| `readback:outcomes` | 52.64 | +42.42 | 200 | 回读 200 行 |
| `readback:cycles` | 57.63 | +47.41 | 13,852 | 回读 7,950 行（窗口外 5,902） |
| `rowsFrom:knowledge`（回读） | **75.16** | **+64.94** | 17,552 | 回读 9,800 行 + **该集合 61 个归档文件的整份字节**驻留（`buffers`） |
| `readback:knowledge` | 70.90 | +60.68 | 0 | 行对象保留到校验结束 |
| `indexWritten` | 69.11 | +58.89 | 20,901 | `#writeArchiveIndex` 再次整档逐行解析 |
| 返回后（GC） | 20.09 | +9.87 | — | 缓存换成压缩后的新归档（4×2048+200 窗口行 + 新键表） |

### 4.3 保活量排行（pin，40 000 行）

单位 MiB；"retained" 是**只释放该阶段对象图**能回收的堆（重叠不可相加）。

| pin（对象图） | dryRun retained | write retained | 说明 |
| --- | ---: | ---: | --- |
| `histories`（40,000 行 clone） | **32.39** | 32.69 | 最大单一保留图；≈850 B/行（knowledge 行约占 2 KB） |
| `plan`（records+canonical+tombstones） | 32.80 | 32.46 | 与 histories 大量不共享（records 是二次 clone） |
| `histories+plan` | **43.71** | 43.55 | 两者的并集：records 相对 histories 只多 11.3 MiB |
| `records`（plan.records+canonical） | 32.80 | 32.46 | 与 `plan` 基本等同 |
| `oldData`（冷夹具） | 0.10 | 0.10 | 冷夹具热状态只有 canonical 250 |
| `oldData`（warm 夹具） | **2.10** | — | canonical 1,063 + 5 集合热行 + 4,096 marker |

10 000 行版本同一口径：histories 8.08、plan 8.25、histories+plan 10.99、records 8.25、
oldData 0.037 MiB——随行数近似线性（histories/records），oldData 不随冷行数变化。

规划峰值与外部 RSS 的关系：本探针 40k dryRun 活堆峰值 +62.63 MiB、write +64.94 MiB；
`retention-plan-rss/report.md` 的固定堆进程外规划峰值 C/M 为 241.25/239.77 MiB，相对阶段
开始 +81.64/+80.28 MiB。两者同一量级，差值（约 16–18 MiB）来自未回收垃圾、模块/代码与
1 MiB 分块读的分配器高水位——**峰值的主体是可解释的活对象图，不是采样噪声**；但本探针
也不能把 RSS 逐页归因到某个结构。

### 4.4 物化与深拷贝点归属（40 000 行）

**JSON.parse 次数（dryRun 69,760）**

| 来源 | 次数 | 分解 |
| --- | ---: | --- |
| 规划期完整历史读 | 69,760 | 扫描 40,000 + 窗口外逐行回读 29,760（40,000 − 5×2,048 窗口行） |

逐集合（规划期）：observations 16,000+13,952、knowledge 8,000+5,952、cycles 8,000+5,952、
outcomes 4,000+1,952、promotions 4,000+1,952。**窗口内的 10,240 行只解析一次；窗口外的
29,760 行解析两次**（扫描一次、回读一次）——这是规划期可以省掉的一半解析量，候选 (b)
只省 clone 不省它。

**JSON.parse 次数（write 166,121 = 规划 69,760 + 96,361）**

| 写入期新增来源 | 次数 | 说明 |
| --- | ---: | --- |
| `inspectArchiveIntegrity` | 40,000 | 整档字节 + split 文本 + 逐行 parse，只检查格式 |
| 回读 `#readArchiveSync` | 35,458 | 扫描（新归档 20,901 行）+ 窗口外回读 14,557 |
| `#writeArchiveIndex` | 20,901 | 再次逐行 parse 只为键集合/首末行事实 |
| state/index 读写 | ≈2 | — |

即**真实 compact 在大历史上把归档整档解析约 2.4 遍**（规划 1 + 完整性检查 1 + 回读 1 +
索引 1，其中回读的扫描与索引都含在写入期新增里）。

**structuredClone 次数（dryRun 163,502）**

| clone 点 | 次数 | 说明 |
| --- | ---: | --- |
| `#mergeArchived` 的 `rows.map(clone)` | 40,000 | 每个合并行一次 → `histories`，即 32.4 MiB 的保留图 |
| `#knowledgeRetentionPlan` 的合并 | **120,000** | 每个有知识身份来源行 ~7.5 次：`mergeKnowledgeEntry` 的 `clone(effects)` + `appendBounded` 对 `sourceRefs/lineageRefs/relationRefs/recentEvidence/recoveryRefs` 逐元素 clone。**次数最多**，但产物是暂态，只把峰值从 +47.6 推到 +62.6 MiB |
| `records` 保留行 `clone(entry)` | 3,250 | 保留行的第二次深拷贝 |
| canonical 种子 `clone` | 250 | `#data.canonical` 整表 |
| tombstone / oldData / 其它 | ≈3 | 本次语料 tombstone 2 行、oldData 1 次 |
| 合计 | 163,502 | — |

写入期只多 253 次 clone（canonical 表 `map(clone)` 250、tombstone 2、`#save()` 的整份 `snapshot()` 1），
**说明写入期的额外内存主要不是深拷贝，而是整档字节与解析对象**（4.2 表的 parse 增量）。

**堆空间归属**（`plan` 阶段，40k）：used heap 67.84 MiB 中 old_space 62.3 MiB、new_space
（young 半空间）62.7 MiB 容量的一部分、large_object_space 5.7 MiB；没有 single 巨对象，
说明峰值是"大量中等行对象"而不是少数大 Buffer。

### 4.5 dryRun 与真实 compact 的差异

- 规划部分完全相同（前 15 个阶段逐项相同），差异只在 `plan` 之后：真实 compact 多出
  `inspectArchiveIntegrity` 的整档字节/文本/行解析、逐行序列化、安装后回读（含 `buffers`
  持有的整集合归档字节）、`#writeArchiveIndex` 的第二次扫档，以及 `#save()` 的
  `snapshot()` clone。
- 峰值：40k 时 write（75.16 MiB）略高于 dryRun（72.85 MiB）；10k 时相反（write 24.27
  vs dryRun 27.86），因为 10k 压缩后新归档远小于规划时的完整历史，回读物化量也随之变小。
  **不能用 dryRun 峰值替代 write 峰值，反之亦然。**
- dryRun 的持久副作用是**档案缓存**：返回后约 13.26 MiB 常驻（40k）；真实 compact 返回后
  缓存换成压缩后的新归档，约 10.0 MiB。
- `oldData`：冷夹具 0.1 MiB、warm 夹具 2.10 MiB；真实 compact 需要它做回滚，dryRun 完全
  不读（候选 d1）。

### 4.6 无法从本探针得到的东西

- 分配器的 OS 级峰值、GC 后的 RSS 页回收、write 阶段进程外阶段峰值（本轮未做进程外采样）；
  与 RSS 报告的对应只是量级一致，不是逐项相加。
- pin 保活量是不可加的增量口径；要得到"某几类对象合计占多少"必须固定组合一起 pin。
- 合成语料不是生产数据：knowledge 行宽、canonical 表规模、tombstone 比例都会改变绝对值；
  本文的所有结论按"结构/次数"外推，绝对值只对本夹具成立。

## 5. 候选设计与安全性论证

记号：`P` = `#retentionPlan()` 的返回对象（`records/canonical/report`），`H` = `histories`，
`D` = `oldData`，`#data` = 实例热状态。

### 5.1 (a) dryRun 只计数、不物化 records/canonical/tombstones

**改动形态**：`#retentionPlan(materialize)` 增加一个参数（不要写第二份计划实现）。决策循环
保持逐行、同顺序、同分支；`materialize === false` 时：

- 非 knowledge 集合：`retained.push(...)` 换成 `report.after[collection] += 1`（折叠/聚合
  分支已经是 `+= group.length` 或 `+= 1`，这部分不变，只是不构造输出行）；
- knowledge 集合：`records.knowledge.length` 换成 `knowledgeByKey.size`；
- `canonicalByKey` 的值若只为 dryRun 使用，可改存 `{ id, recordId, fitnessScore }`
  （退休判定只需要 `current.fitnessScore`、`retiredByCanonical` 只需要 `candidate.id`、
  `candidate.supersedes` 只影响输出行）；
- `tombstoneMap` 可只保留 id 集合：`report.tombstones` 是合并后的 `size`，合并不会新增键；
- `plan.canonical`、`records.tombstones`、`records[c]` 的克隆全部跳过；
- `records` 用计数对象代替（或返回 `null`；调用方 dryRun 分支不读它）。

**必须保持的不变量**

1. **决策与报告计数逐字段不变**：`report.before/after/retired/consolidated/
   aggregatedObservations/tombstones/retainedCanonical/knowledgeBefore/knowledgeAfter/
   canonicalKnowledge/canonical`；`beforeBytes/afterBytes` 由 `#archiveBytes()` 读。
2. **时钟读取序列不变**：累积遍每来源行一次 `timestamp(this.clock)`；分类循环每行一次
   （值不再使用，但必须保留，见 `retention-plan-cost.md` §3.5 的反例）；canonical 候选的
   `updatedAt: entry.recordedAt ?? entry.promotedAt ?? timestamp(this.clock)` 的短路求值
   顺序；knowledge 种子 `entry?.knowledgeKey ?? canonicalKnowledgeKey(..., timestamp(this.clock))`
   的条件读取。计数版若把 `safeRecord({...updatedAt...})` 整体跳过，那次 `timestamp` 就会
   消失——必须显式在同样位置求值。
3. **dryRun 不产生新的持久写入**：现有 dryRun 已经会做 `#performHousekeeping()`（就地改热池）
   与缓存填充，这是既有行为；计数版不得额外写 `#data`/归档/索引。`report` 相等性在差分测试里
   对同一 fixture 比。
4. **fallback/异常语义**：计划过程中任何异常仍按原路径抛出；dryRun 不写盘因此没有回滚路径。

**风险与无法证明处**

- dryRun 与真实 compact 若分成两份计划实现，必然漂移；计数版必须是同一循环里的分支。
- 计数版仍要构造 `normalizeKnowledgeEvent`、`mergeKnowledgeEntry` 的完整事件/累加器
  （后续行要 merge），所以 (a) 只省"输出物化"：`records` 深拷贝、canonical/tombstone 输出、
  knowledge 输出数组；**不省**历史读取、事件规范化与聚合分组。收益有上限，不要宣称它解决
  主内存热点。
- 报告里 `after` 的语义依赖"哪些行被计入 retained"的每一处分支；任何分支漏计数都无法从
  其他字段反推（`before` 与 `retired+consolidated+after` 在 knowledge 集合上不等，因为
  knowledge 输出行是新键）。必须用现有差分语料逐字段比较。
- 时钟反例：同一知识身份混合时间戳行的组内排序依赖 `occurredAt`（无时间戳行来自读取时刻）。
  计数版任何对循环顺序/读取位置的调整都会改变保留结果——这不是理论风险，收口轮已复现过
  （见 `retention-plan-cost.md` §2）。

**针对性反例用例**：在 `retention-plan-equivalence.test.js` 增加 dryRun 报告差分（已有
`the dry-run report must be identical`），并补一个"每调用推进 1 秒的时钟 + 同身份单边带
时间戳 + 两次计划"的用例，断言 dryRun 与真实计划的报告/保留 ID/归档 sha256 一致；它会在
误删时钟读取或改动循环顺序时失败。

### 5.2 (b) 计划用 historyView 读取并按所有权转移/按需 clone

**改动形态**（计划私有，不改公开 `historyView()` 契约）：

1. 新增私有读 `#historyViewForPlan(collection)`，返回 `{ rows, owned }`：
   `rows` 与 `historyView()` 相同（`#mergeArchived(..., {copy:false})` 的副本数组）；
   `owned` 是一个 `WeakSet`/`Set`，在读取完成**之后**按第 3.3 节规则计算：
   `owned = rows \ (#data[collection] ∪ cacheEntry.window)`。
2. `#retentionPlan()` 用它建立 `histories` 与 `ownedByCollection`；`tombstones` 也走同一读法。
3. 输出边界按所有者决定：

   | 输出位置 | 当前行为 | 候选行为 |
   | --- | --- | --- |
   | `retained.push(clone(entry))`（非 knowledge 保留行） | 第二次深拷贝 | `owned.has(entry) ? entry : clone(entry)` |
   | `knowledgePlan.knowledge` 种子行 | 已是 `histories` 克隆 | 输出时 `owned.has(entry) ? entry : clone(entry)`（merge 产生的新对象本身 owned） |
   | `report.*` | 不变 | 不变 |
   | 决策用的引用（`retainedEntries`、`observationGroups`、`sourceGroups`） | 引用 | 引用；只在计划内暂存，不进入输出 |

   **必须 clone 的两类**：`#data` 热行（其它所有者，且违反 `historyView` 只读契约）；
   缓存窗口行（缓存必须是磁盘视图）。**可以转移的**：窗口外新解析行——除此之外没有所有者。

4. **不得改变合并顺序**：仍用 `#mergeArchived`，因此 archived 前缀、热覆盖、anonymous/
   热多出行的尾部顺序与今天一致。

**等价性论证**

- 行的**内容**不变：只是少了一次 `structuredClone`，输出 JSON 与归档字节逐字节相同
  （`boundedArchiveEntry` 只看字段值）。
- 决策只读不写：`#retentionPlan` / `#knowledgeRetentionPlan` 对行只做读；`mergeKnowledgeEntry`
  不改入参（其输出可能复用旧 `relationRefs`/`recovery` 子对象，但那些旧对象也属于本计划，
  且输出行若被转移只会在计划结束后成为 `#data`/归档内容，见下条风险）。
- 所有权闭环：转移的行只进入 `plan.records` → `#data` 热窗口（`slice(-hotLimit)`）与
  `#rewriteArchives` 的序列化；`oldData` 是深克隆，回滚不因身份变化而失败。
- `records` 的**数组**仍是新的；`plan.histories` 无读者。
- 时钟：`historyView` 与 `history` 都不读时钟，`#readArchiveSync` 的读取次数/顺序不变。

**必须保持的不变量**

1. `#data` 热行与缓存窗口行绝不进入输出（除非 clone）。
2. 合并顺序、同 id 覆盖、anonymous/热尾行顺序不变（沿用 `#mergeArchived`）。
3. `#readArchiveSync` 的解析次数、fallback 语义不变；`history()` 的 detached 契约不变
   （不在 `history()` 上暴露未克隆行）。
4. `plan.records` 中每个行对象只有一个所有者：`#data` 或计划；计划结束后只能是 `#data`。
5. 缓存不能被 `#data` 后续就地修改污染：候选只转移非缓存行；热行 clone，因此即使将来出现
   `#data` 行的原地写（当前只有 `#data.tombstones` 的 `Object.assign`），缓存也不受影响。

**风险与无法证明处**

- `historyView()` 的公开契约明说"不得保留/写回"；候选必须用私有读，并在 `PORTS.md` 里
  保持公开契约不变。若图省事复用公开方法，就等于让计划依赖一条给调用方的约束，无法证明。
- **子对象别名（范围比想象的小）**：`appendBounded()` 总是 `filter(...).map(clone)` 后返回
  **新数组**，元素也被 clone，所以 `sourceRefs/lineageRefs/relationRefs/recentEvidence/
  recoveryRefs` 不与输入行共享；`mergeEffects()` 也是新对象。**残留的唯一字段别名是
  `recovery: event.recovery ?? old?.recovery ?? null`**：当本次事件没有 `recovery` 而旧
  累加器有时，输出行的 `recovery` 子对象与旧行/旧 seed 行共享。旧行属于计划、且不会同时
  进入输出（同一知识键的旧累加器被新对象替换；`histories.knowledge` 的 seed 行对该键不再
  出现在 `records`），当前也没有任何代码原地修改 `recovery` 子对象。这属于"当前代码下可
  证明、但不是类型级保证"的点：实现时可以保守地对带 `recovery` 的输出行 clone 该子对象，
  或在评审时确认没有任何 `#data` 行原地写。
  （矩阵：`#data.knowledge` 热行只在 `#upsertKnowledgeUnlocked` / `observe` 路径被替换成
  新对象；`#data.tombstones` 有 `Object.assign(existing, ...)`，但 tombstone 输出不经 transfer。）
- **完整历史仍被物化一次**：`historyView` 仍会 `#archiveRowsFrom` 逐行 parse 窗口外行，
  候选只省一次 clone，不省读取与解析。4 万行的收益量级见第 4 节；如需再降必须把计划改成
  逐集合流式（不在本候选范围）。
- 若将来有调用方需要 `histories` 在计划返回后仍存活（今天没有），transfer 会让它指向
  `records`/`#data` 的对象——必须在那时重新评估。

**针对性反例用例**

- 差分：同一 fixture 上，候选与基线 dryRun 报告、真实 compact 后的 `fullSnapshot()`、
  归档/索引/state 字节 sha256 全部相同（复用 `retention-plan-equivalence.test.js` 的语料）。
- 所有权断言（脚本 `--mode ownership` 已提供）：连续两次 `historyView` 身份分类、同 id 热
  覆盖、尾行顺序、fallback 冷/热缓存路径。
- 边界：热行与归档同 id、热行多出 id、无 id 行、窗口内/外混合、缓存字节上限触发（大
  knowledge 行）、fallback 路径。
- 回归：`window` 行被写入输出后，再触发一次 `observe`/`query`，断言缓存窗口内容仍等于
  磁盘（即"输出从未写回缓存"）。

### 5.3 (c) compact 归档回读只比较有序键表，不物化全部行

**当前行为**（`#rewriteArchives` 安装后）：

```
cold     = plan.records[collection].slice(0, -hotLimit)
archived = #readArchiveSync(collection)          // 再次完整解析 + 物化
if (archived.length !== cold.length || archived.some((e, i) => #archiveKey(e) !== #archiveKey(cold[i]))) throw
```

`#readArchiveSync` = 缓存未命中扫描（整档逐行 parse，只留键表+窗口） + `#archiveRowsFrom`
（窗口外逐行再 parse，并把该集合整份归档字节读进 `buffers`）。回读唯一用到的信息是
"行数 + 有序键序列"。

**候选形态**：仍调用 `#archiveRead(collection)`（必须如此：它负责身份校验、扫描、adoption、
`archiveKnown`/`archiveTombstones` 与缓存刷新），然后从返回的 `state` 直接导出可见键序列并
比较：

```
keys   = state.keys.filter((key, i) => collection === "tombstones" || !state.tombstones.has(key))
coldKeys = cold.map((entry) => this.#archiveKey(entry))
if (keys.length !== coldKeys.length || keys.some((k, i) => k !== coldKeys[i])) throw
```

**等价性论证**

- 当前比较的 `archived` 来自同一份字节的扫描/定位符读回；扫描本身已经逐行 `JSON.parse` 并
  计算同一个 `#archiveKey`。`state.keys` 就是扫描得到的有序键表；tombstone 过滤条件与
  `#archiveRowsFrom` 的跳过条件相同（`collection !== "tombstones" && tombstones.has(key)`）。
- 因此"可见键序列"与"当前回读后逐行 `#archiveKey`"在**同一份已通过解析的字节**上必然相同；
  差异只可能来自 `#archiveRowAt` 的定位符读回失败（今天会触发 `#readArchiveSync` 的 fallback
  或抛错）。
- 计数语义不变：`keys.length !== coldKeys.length` 同时覆盖重复键被位置表折叠（当前用
  `archived.length` 也会发现）与写入缺失。

**必须保持的不变量**

1. 仍走 `#archiveRead` 的完整语义：身份不匹配必须重扫；`unreadable` 故障、digest 校验、
   adoption/cache 刷新、`#setArchiveMetadata` 使用的 `archiveKnown/archiveTombstones` 都保留。
2. 索引写出的 `#writeArchiveIndex` 仍独立跑一遍（它同时重建 active keys），不因 (c) 被跳过。
3. `E_ARCHIVE_REWRITE_UNSAFE` 的 9 类 finding 拒绝与 transition 检查不变。
4. 失败仍抛错 → 事务 catch 走归档回滚与 `#restoreArchiveIndex`。

**风险与无法证明处**

- **丢失"定位符可复现"这条校验**：当前 `#archiveRowsFrom` 会用每个位置的 file/byte-range
  重新读行并验证 key，等于在 compact 的提交点顺带验证了定位符（UTF-8 原始字节长度、文件
  边界、行边界）。键表比较不验证这一点。定位符的正确性仍被 `history()/fullSnapshot()` 的
  读取路径与既有差分用例覆盖，但"每次 compact 都自检"这条性质会消失。**不能声称完全等价**：
  它是"验证强度"的削减，必须显式接受或用别的手段补（例如保留 sampled readback：抽窗口外
  首/中/尾各若干行验证定位符，成本 O(1)）。
- 当前回读还顺带把 `plan.records` 行与磁盘字节做了一次内容往返；键表比较只比较键。不过
  `boundedArchiveEntry` 序列化发生在回读之前，序列化失败已经会抛错；内容正确性由键+后续
  `history()` 使用保证，不额外提供。
- fallback 分支在回读路径上的语义会改变：今天若定位符读不回，`#readArchiveSync` 会尝试一次
  `collectRows` 扫描并回答；候选不再触发该分支（因为根本不读行）。这是**行为差异**，需要
  确认没有测试/调用方依赖 compact 回读触发 fallback。

**针对性反例用例**

- 构造一个能通过扫描但定位符错误的归档（例如把某行改成含非法 UTF-8 字节、或让行内换行
  处理出现偏差），断言：基线 compact 抛错/走 fallback，候选必须至少被 sampled readback 或
  既有的 `history()` 差分用例捕获；若接受削减，用例要显式记录这个边界。
- 重复 id/重复值键、tombstone 行、空归档、只有窗口内行的归档，键表比较与旧回读结果比对。
- 归档在回读前被替换（identity 变化）仍必须重扫而不是用缓存键表。

### 5.4 (d) compact dryRun 跳过 oldData clone、plan-owned canonical/tombstone 直接移交

**当前行为**

- `oldData = clone(this.#data)` 在 `if (dryRun) return` **之前**执行，dryRun 分支从不读它：
  这是纯粹的死克隆。它的成本 = 热状态大小（hotLimit 行/集合 + knowledge 200 + canonical 表
  + marker 窗口 + coldArchives 元数据），与冷历史规模无关，但 warm 状态下可达数 MiB。
- 真实 compact 里 `oldData` 是回滚快照，`catch` 分支 `this.#data = oldData`，**不能删**。
- `#data.canonical = plan.canonical.map(clone)`：`plan.canonical` 的每个值都是计划拥有的
  对象（`clone(#data.canonical)` 或新 `safeRecord` 候选），计划返回后没有其他读者。
- `#data.tombstones = (plan.records.tombstones).slice(-hotLimit).map(clone)`：`records.tombstones`
  来自 `tombstoneMap`，值要么是 `clone(history tombstone)`、要么是 `tombstoneFor()` 的
  `safeRecord` 新对象，同样计划独占。

**候选形态**

1. dryRun 分支先返回报告，`oldData` 延后到 `if (!dryRun)` 之后创建（或只在写入路径创建）。
2. `#data.canonical = plan.canonical`（数组本身已是新的 `[...canonicalByKey.values()]`）。
3. `#data.tombstones = plan.records.tombstones.slice(-hotLimit)`（不 clone）。
   可选进一步：`canonicalByKey` 种子不再 `clone(#data.canonical)`，直接把旧表行放进计划，
   写入路径整体替换 `#data.canonical`——旧行没有其他所有者（`oldData` 是深克隆），可转移。

**等价性论证**

- dryRun 的返回对象与副作用不依赖 `oldData`；`#retentionPlan()` 已在此之前完成，dryRun
  返回路径没有 `catch`/回滚。把 clone 移到 `if (!dryRun)` 之后，dryRun 的堆少一份热状态副本。
- canonical/tombstone 输出的内容不变（clone 不改变 JSON）；唯一变化是输出行与计划内部对象
  同一身份，而计划在赋值后即不可达。
- 真实 compact 的错误路径：`oldData` 仍是**赋值前**捕获的深克隆，回滚语义不变；移交发生在
  `#rewriteArchives` 成功、赋值阶段，任何后续 `#save()` 失败仍由 `catch` 恢复 `oldData`。

**必须保持的不变量**

1. 真实 compact 的 `oldData` 必须在任何 `#data` 变更**之前**捕获（当前顺序：plan → oldData →
   rewrite（不改 `#data`）→ 赋值；注意 `#retentionPlan()` 自己会通过 housekeeping 改热池，
   这在 oldData 之前，属于既有行为，回滚不覆盖它，不要顺手"修"）。
2. `plan.canonical` / `plan.records.tombstones` 在赋值后不再被计划/调用方读取或修改。
3. `#data.canonical` 与 `#data.tombstones` 的行必须是"新快照"（不能被旧 `#data` 的其它引用
   别名）。移交时旧 `#data` 的数组只被 `oldData` 的深克隆描述，因此成立；若将来有别的持有者
   （例如 `data` getter 缓存、诊断快照），必须重新评估。
4. tombstone 行的 `Object.assign(existing, ...)` 路径（`finalizeKnowledge`）把 `#data.tombstones`
   的行当作可变对象：移交后这些行只属于 `#data`，可行；不得把 `plan.records.tombstones`
   再交给别的读者。

**风险与无法证明处**

- `plan.canonical` 里"未变化的现有 canonical"在今天来自 `clone(#data.canonical)`；直接移交
  会让 `#data.canonical` 与 `oldData` 的对应行**内容相同、身份不同**（oldData 是深克隆），
  回滚仍是正确的；但如果实现顺手把种子 clone 也去掉，则"计划输出行 === 赋值前 #data 行"，
  而 `oldData` 仍描述赋值前内容——两者不别名，安全。风险在于任何在 compact 之后、赋值之前
  读取 `#data.canonical` 的并发路径：`compact` 由 `#enqueueMutation` 串行化，且
  `#assertMutation` 在前，仓库内没有这样的并发读；跨进程场景本来就以文件为准。
- `records.tombstones` 的值若未来引入"复用一个历史 tombstone 对象"（现在是 clone），需重新
  评估独占性。
- dryRun 省掉的 oldData 量级取决于热状态，warm 夹具实测见第 4 节；冷夹具下几乎为 0，
  不能拿冷夹具的数字宣称收益。

**针对性反例用例**

- dryRun 前后 `fullSnapshot()` 与磁盘字节不变（已有 `dry-run-state-unchanged` /
  `dry-run-archive-unchanged` 断言）。
- 写入路径失败注入：让 `#save()` 或 `#writeArchiveIndex()` 抛错，断言 `#data` 恢复到
  oldData（含 canonical/tombstones 行内容与旧状态逐字段相等），并在恢复后继续一次成功的
  compact。
- 移交后立刻 `finalizeKnowledge`/退休路径写 tombstone（触发 `Object.assign`），断言不污染
  归档缓存与 oldData 语义。
- warm 状态（canonical 表 + marker 窗口 + hotLimit 行）下 dryRun 的堆快照对比：证明少的
  只是 oldData 那份。

### 5.5 (e) knowledge 合并的逐元素 clone（额外观察，不建议本轮做）

实测 `#knowledgeRetentionPlan` 在 40k 行上触发 **120,000 次 `structuredClone`**（占规划期
163,502 次 clone 的 73%），把活堆峰值从 `preKnowledge` 的 +47.61 MiB 推到 `knowledgeInner`
的 +62.58 MiB。逐次分解：

- `mergeKnowledgeEntry` 每个有知识身份的来源行调用一次（本语料 16,000 次），每次
  `clone(effects)` **1 次**；
- 每次合并还有 5 个 `appendBounded` 调用（`sourceRefs`/`lineageRefs`/`relationRefs`/
  `recentEvidence`/`recoveryRefs`），每个都把旧数组**逐元素 clone**；`MAX_REFS`=32、
  `MAX_RECENT`=8，同一知识键被反复合并时列表越长 clone 越多，平均约 6.5 次/合并。

能否减少：

1. **`effects: clone(effects)`**：`mergeEffects` 每次返回全新对象；`effects` 与
   `effectStats` 是同一份事实的两个键（`lib/` 内没有读者读 knowledge 行的 `.effects`，
   `experience-recall` 读的是 `effectStats`）。让两个键指向同一对象，序列化字节完全相同；
   但这改变了行内对象图（两个键共享一个可变对象），而写路径（`#upsertKnowledgeUnlocked`，
   L3891）也用同一个 merge。**可做，但只能作为显式选项**，并且要有"行内不原地修改"的
   契约测试。
2. **`appendBounded` 逐元素 clone**：只有当 `previous` 是**本次计划里上一次 merge 产生的
   累加器**时才可以退化成 `values.slice()`（新数组容器、共享元素）；不能用"计划独占"这个
   更宽的判断——`knowledgeByKey` 的**种子**来自 `histories.knowledge`（在当前实现里是
   clone，但在候选 (b) 下可能是一个缓存窗口/热行对象，且它在 merge 时仍然活着）。实现上
   应该用一个 `WeakSet` 记录本次计划 merge 出来的累加器：只有 `previous` 在该集合里时才
   跳过元素 clone；种子行一律走原 clone 路径。默认路径绝对不能改：写路径的 `previous`
   可能是 `#data.knowledge` 活行，也可能是 `#knowledgeEntryFor` 从缓存窗口/归档读回的行，
   元素共享会让输出与活状态/缓存互相污染。
   **反例风险**：若将来有代码原地修改 knowledge 行的 `sourceRefs`/`relationRefs` 等数组或
   元素（当前没有：`#data` 的原地写只有 tombstone 的 `Object.assign`），共享元素会静默
   改到旧行；另外 `mergeKnowledgeEntry` 是 `knowledge.js` 的协议函数，`knowledge.js` 不在
   `memory.js` 的反转表形状守卫里，差分基线两侧会同时用新实现，**只能靠
   `knowledge-identity-equivalence` 一类固定字节 pin 兜底**。

**结论：不建议本轮做。** 120,000 次 clone 的"次数"很大，但被 clone 的是小数组/小对象，
相对 `histories` 的 32.4 MiB 保留图是次要项；而它位于知识身份协议 + 写路径共享的函数里，
需要选项化 + 形状/字节 pin + 变异测试三件套。建议顺序是 (d1)/(d2) → (b) → 重新测一次
allocation profile，若 120k clone 仍是 CPU/分配主项，再单独做 (e)。若要立刻拿一点确定性
收益，最小形态是给 `mergeKnowledgeEntry` 加默认关闭的 `{ previousOwned: true }`，仅
`#knowledgeRetentionPlan` 传 true，并且只做 `effects` 共享 + `appendBounded` 容器复制不克隆
元素；必须同时补"计划输出行不与 `histories`/缓存共享可变数组元素"的断言与变异测试。

## 6. 建议的最小实施顺序

先给候选风险表（"等价性把握"是本文能证明到的程度，不是实施后的验证结论）：

| 候选 | 省什么（40k 量级） | 等价性把握 | 主要风险 | 建议 |
| --- | --- | --- | --- | --- |
| (d1) dryRun 跳过 oldData clone | dryRun 一份热状态克隆：冷夹具 0.10 MiB，warm 夹具 2.10 MiB | **高**：dryRun 分支不读 oldData，移动 clone 位置即可 | 无（真实 compact 仍必须在改 `#data` 前捕获） | **先做** |
| (d2) canonical/tombstone 移交 | 2 次全表 clone（本语料 252 行；生产随 canonical 表增大） | **高**：计划拥有、计划返回后无读者 | 未来出现其它持有者/原地写就失效，需要独占性断言 | **先做，可与 d1 同批** |
| (b) plan 私有 historyView + 所有权转移 | 40,000 行全历史 clone（32.4 MiB 保留图）+ 3,250 行 records 二次 clone 的大部分 | **中高**：所有权规则已由身份探针钉住；剩余风险是子对象别名（`recovery` 等）与契约私有化 | 必须 clone 热行/窗口行（含 inherited）；`PORTS.md` 公开契约不能变；任何缓存实现改动都会破坏前提 | **主收益，第二个做** |
| (a) dryRun 计数化 | dryRun 的 records/canonical/tombstone 输出物化（records 侧 32.8 MiB 的一部分） | **中**：计数分支必须逐条复刻决策与时钟读取序列 | 双实现漂移、时钟读取顺序、报告字段漏计 | **第三个做** |
| (c) 回读键表比较 | 回读的行物化 + 每集合整份归档字节（`buffers`，40k 时 knowledge 的 61 个文件全部驻留） | **中低**：比较语义等价，但丢失"定位符可复现"校验 | 验证强度削减，无法证明完全等价；需要 sampled readback 或显式接受 | **最后做或放弃** |
| (e) knowledge 合并少 clone | 120,000 次 clone 的大部分（峰值估计降几 MiB，未实测） | **低–中**：输出字节不变，但行内对象图别名变化，写路径共用函数 | 知识身份协议、写路径 previous 可能是活行/缓存行；`knowledge.js` 不在反转表守卫内 | **不建议本轮做** |

按"收益/风险比、可独立验证"排序；每一步都应单独提交并配差分数据，前一步不被后一步阻塞：

1. **(d1) dryRun 跳过 oldData clone** —— 最小、可证明、无行为变化（dryRun 分支不读它）。
   只影响 dryRun 路径，可直接用差分用例钉住报告与状态。
2. **(d2) canonical/tombstone 直接移交** —— 同样局部，减少两次全表 clone；需要"独占性"
   断言与失败回滚用例。可与 d1 同批。
3. **(b) 计划用私有 historyView + 所有权转移** —— 主收益（省一次全历史深拷贝 + 保留行的
   二次 clone），但需要新增私有读、所有权集合与规则测试；依赖第 3 节的判定不变。
4. **(a) dryRun 计数化** —— 只影响 dryRun 报告路径，收益低于 (b)，但把 dryRun 的物化成本
   压到接近"读取 + 决策"；必须用单一遍历 + materialize 标志实现，时钟契约测试是关键。
5. **(c) 回读键表比较** —— 收益在写入期的整档字节与行对象；会削减"定位符自检"这一验证
   强度。**建议最后做，或与 sampled readback 一起做**；若无法接受验证削减，应放弃 (c)
   并把回读成本写进收益边界，而不是默认实施。

不建议现在做的：

- 把计划改成真正的逐集合流式（在 `#knowledgeRetentionPlan` 需要跨集合全局 `references`/
  `latestLineage`/canonical 退休映射，重构面大，属于另一个项目）。
- 用 `historyView` 直接替换公开 `history()`：会破坏 detached 契约，影响 `fullSnapshot()`、
  `restore()`、经验检索等调用方。

每个候选的针对性反例（汇总，详见各小节）：

| 候选 | 必配反例/差分 |
| --- | --- |
| (d1) | dryRun 前后状态/字节不变；写入失败注入 → oldData 回滚；warm 状态堆对比 |
| (d2) | 回滚后 canonical/tombstone 逐字段相等；移交后 `Object.assign` tombstone 不污染缓存；失败在赋值之后仍能回滚 |
| (b) | dryRun 报告 + compact 后状态/归档字节差分；ownership 三分类（连续两次调用身份）；同 id 热覆盖/尾行顺序；窗口内/外/字节上限；fallback 冷/热缓存；输出行不写回缓存 |
| (a) | dryRun 报告逐字段差分；推进时钟 + 同身份混合时间戳的双计划用例（保留 ID 与归档 sha256）；异常路径 |
| (c) | 可解析但定位符不可复现的归档；重复键/tombstone/空归档；回读前替换归档仍重扫；sampled readback 或明确接受验证削减 |

## 7. 未决与风险

- 本文的"当前实现"数字只覆盖 Node v26.13.0 / darwin-arm64 与合成语料；不同 Node/平台、
  真实用户历史（行更宽、knowledge 行更大、collection 分布不同）未测量。
- `historyView` 所有权规则的三个实现事实（第 3.3 节）是**当前代码**的性质，不是类型约束；
  任何改动 `#readArchiveSync`/缓存窗口/`#archiveRowAt` 的补丁都必须同步跑
  `--mode ownership`，否则候选 (b) 的转移前提会静默失效。
- 候选 (a)(c) 对**报告/验证语义**的改动尚未实现，等价性只在本文论证层面；实施时必须用
  仓库的差分测试与固定字节断言证明，而不是引用本文。
- 计划期的"峰值 live heap"由阶段采样给出（每阶段强制 GC 后的 live set），不是分配器
  `maxRSS`；写入期的 OS 峰值另有基准（`retention-plan-cost.mjs` / `retention-reclaim`），
  本文不重复。

## 8. 复现

```sh
# 快速：ownership 分类 + 10k 归因
node --expose-gc scripts/benchmarks/retention-plan-attribution.mjs \
  --mode all --scales 10000 --pins none,histories,plan,histories+plan,oldData,records \
  --out /tmp/retention-plan-attribution.json

# 40k：与 retention-plan-cost 可比
node --expose-gc scripts/benchmarks/retention-plan-attribution.mjs \
  --mode all --scales 40000 --pins none,histories,plan,histories+plan,oldData,records \
  --out /tmp/retention-plan-attribution-40000.json

# warm 状态（canonical 表 + marker 窗口 + hotLimit 热行）下的 oldData 成本
node --expose-gc scripts/benchmarks/retention-plan-attribution.mjs \
  --mode retention --scales 10000 --pins none,oldData --hot-steps
```

脚本自检：所有所有权断言（连续调用身份稳定/变化、窗口位置规则、fallback 拆分、缓存不保存
`rows`）失败时退出码非 0；插桩锚点不匹配（源码形状漂移）时拒绝运行，而不是静默测错树。

### 8.1 本次交付的写入范围与 `lib/` 未被本任务改动的证明

本任务只新增两个文件（均在声明的写入范围内）：

```sh
$ git status --short -- scripts/benchmarks/retention-plan-attribution.mjs \
      docs/performance/retention-plan-streaming-attribution.md
?? docs/performance/retention-plan-streaming-attribution.md
?? scripts/benchmarks/retention-plan-attribution.mjs
```

测量源的证明（与工作树 `lib/` 无关）：

```sh
$ git archive a1db591 lib | tar -x -C /tmp/attr/frozen-check
$ # 对解出的树按脚本同一算法计算文件清单 sha256
$ node -e '...'   # => 70812c426da7a9511d3e02bcf51e0e9703c1515713e4fb509c1cf9102a3ee988
$ # 与本次 JSON 输出记录的 libTreeSha256 完全相同；refCommit = a1db591565110044d628de3027ca5e6c7affa6c2
```

注意：本 worktree 与其它 teammate 共享，测量的同一时刻 `implementer` 正在按 task-3 修改
`lib/dockyard-domain/memory.js`。因此**当前** `git status` 会显示该文件的实现方改动，它与本
任务无关；本任务的所有测量都来自 `git archive a1db591 lib` 的冻结副本，脚本本身也只写
临时目录（`mkdtemp`），不写仓库 `lib/`、`test/`、`release/` 或 `package.json`。本任务的
交付文件只有上面两个（`--out` 的 JSON 未提交，见第 8 节开头说明）。
