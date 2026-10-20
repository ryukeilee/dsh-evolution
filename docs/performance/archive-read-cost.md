# 冷档案读取与索引成本

本轮只处理审计报告的 P2-13（冷档案追加路径累计 O(n²)）、P3-3（sealed 段只比较
`byteSize`）、P3-5（归档索引只在 reconcile 时写盘）三项，全部改动限于
`lib/dockyard-domain/memory.js`，未触碰 `package.json`、`release/`、
`docs/evidence/` 与其它 `lib/` 文件。以下每个数字都是本轮实际运行的结果，
未引用历史记录。

结论先行：

| 项 | 审查结论在当前代码上成立吗 | 本轮做了什么 |
| --- | --- | --- |
| P2-13 | **成立**。rc.11–rc.14 只消除了这条路径上的**复制**成本（`copy: false` 扫描、scan memo），**读取与解析**仍是每条 mutation 一次全量冷档案 | 实施最小改进：按文件身份校验的扫描缓存。交替 A/B 交错 3 轮，每 16 次追加的读取字节下降 **19.9–20.0×**，单条 mutation 墙钟下降 **0.51–0.59×** |
| P3-3 | 成立，但代价不划算 | **保留现状**。启动时对全部 sealed 段重算 sha256 等于把启动路径上唯一被索引跳过的字节全部读回；在 40 000 规模上从 22.9 ms 涨到约 36.0 ms（+57%），48 MB 压缩上限附近约 +28 ms 纯哈希 + 全部 sealed 字节的 I/O。改为在代码注释里写明「只比 byteSize」这条真实边界，并用回归用例把它钉成已知边界 |
| P3-5 | **不成立**。索引文档本来就是每次 append 后增量写盘（`#archiveEntries` 末尾的 `#writeArchiveIndexIncremental`），不是只在 `reconcile()` 时写 | **保留现状**。补齐测量：append 后索引确实前进；restart 只读 active 文件（冷档案的 25%）；缺失索引回退全量扫描慢 2.4–3.5×。新增回归用例把「索引由 append 持久化」「缺索引回退扫描」钉住 |

## 1. 方法与口径

复现脚本：[`scripts/benchmarks/archive-read-cost.mjs`](../../scripts/benchmarks/archive-read-cost.mjs)。
原始数据：[`archive-read-cost.json`](archive-read-cost.json)（本文件所有表格的数字
都取自它，含每个样本、每侧每一轮、每次读取落在哪个文件上）。

```sh
# 两侧交替 A/B（A = 本轮改动前的 memory.js，B = 工作树）
node --expose-gc scripts/benchmarks/archive-read-cost.mjs \
  --memory <A/memory.js> --memory lib/dockyard-domain/memory.js \
  --scales 2000,10000,40000 --samples 2 --rounds 3 --warmup 1 --batch 16 \
  --out docs/performance/archive-read-cost.json
```

- **只走公开路径**：`load({ snapshot: false })` 与 `recordObservation()`，不直接调用
  任何私有方法，也不复制生产实现。
- **读取字节数是实测，不是推算**：脚本在实例化 memory 模块**之前**把
  `node:fs` / `node:fs/promises` 的 `readFileSync` / `readFile` 补在 CommonJS
  exports 上，因此计到的是这段代码真正向文件系统要的字节，并按文件名归属。
  `memory.js` 读取冷档案只用这两个函数。
- **一次追加 ≠ 一次测量的正确口径**。每条 mutation 都在新实例上测量时，第一个读
  必然是全量扫描（缓存里还没有这些字节），于是 A/B 都等于未优化。稳态是同一实例上
  的连续追加，所以主指标是 `mutation-batch`：`load` 一次，再连续追加 16 次，热窗口设为 8，
  于是第 9 次之后的每次追加都会把一条记录驱逐进 active 档案文件——既覆盖"命中缓存"，
  也覆盖"自己写出的行如何并入缓存"。`mutation`（单条，新实例）单独保留，用于说明
  **不获益的边界**。
- 每次采样都从**同一份冻结的 fixture 字节**恢复（`state.json`、active 文件、sealed 段、
  已生成的索引文档），因此没有任何一次采样继承上一次的归档行。
- 每个（侧，规模）组合导入自己的模块副本，进程级 scan memo 不会跨规模复用。
- fixture：临时根目录；每个集合 3 个 sealed 段 + 1 个 active 文件（sealed : active = 3 : 1）；
  冷行 50% 是带知识身份的 observations，50% 是它们对应的 knowledge 累积行；
  observation 的 scope 只有 64 个重复值，所以 40 000 规模上被测量的追加确实能匹配到
  已归档的同 key 行；每行带 96 字节 summary，单行约 300 字节，和真实行同一量级。
  临时根之外不读不写，不触碰真实 `DSH_HOME`。
- 时间单位 ms，取每侧每项 6 个有效样本的中位数（3 轮 × 2 样本，每轮先 1 次预热；
  轮间顺序 A/B 与 B/A 交替）。

环境：Node `v26.12.0` / `darwin` / `arm64`，Apple M2，8 逻辑 CPU、16 GiB 内存；
测量期间 load average `1.32 / 1.56 / 1.75`，未并行运行测试、验收或其它基准。

两侧源码（脚本记录在 JSON 的 `sides` 里）：

| 侧 | 文件 | sha256 | 字节 |
| --- | --- | --- | --- |
| A | 本轮改动前的工作树 `memory.js` | `c9acba243630bd47aa67ca320997ea6c0519d8ac0218963433cb898ff9dfd026` | 202 751 |
| B | 本轮改动后的工作树 `memory.js` | `5fdff3077e4aaa8a94e7dc6c333b96b85316839be3543890efaf9ef053bd7393` | 210 751 |

A 是工作树在本轮编辑前的字节（由本轮改动反向还原得到，见第 5 节的反转区域）。

## 2. P2-13：读取确实随冷档案增长，已实施最小改进

### 2.1 改动前的真实读取点

在当前代码上，一次带知识身份的追加（`recordObservation`）会走：

1. `#knowledgeEntryFor(event)` → `#mergeArchived("knowledge", …)` → `#readArchiveSync("knowledge")`：
   把 knowledge 冷档案的**每个文件整体读入并逐行 `JSON.parse`**；
2. `#sourceMatches(collection, event)` → `#mergeArchived(collection, …)` → `#readArchiveSync(collection)`：
   同样把来源集合的冷档案整体读入解析；
3. 当该 key 的累积行只存在于冷档案时，`#upsertKnowledgeUnlocked` 再走一次
   `#archiveEntries("knowledge", …, { replaceExisting: true })`，于是 knowledge 冷档案
   在**同一条 mutation 内被读第二次**。

rc.11–rc.14 的改动（`#sourceMatches` 不再复制历史、`#mergeArchived(…, { copy: false })`、
`#archiveEntries(…, { copy: false })`、archive-index、scan memo）去掉了这条路上的**复制**，
`#readArchiveSync` 本身的读取与解析一步都没少：`archiveScanMemo` 只服务
`#reconcileActiveArchive`（启动重建索引），不服务读路径。

改动前 A 侧的实测（每侧 6 个样本中位数）：

| 冷档案（N observations + N knowledge） | 冷档案字节 | 单条 mutation | 读取字节 | 每 MiB 冷档案 |
| --- | --- | --- | --- | --- |
| 4 000 行 | 1.41 MiB | 8.91 ms | 1.41 MiB | 6.3 ms |
| 20 000 行 | 7.08 MiB | 41.40 ms | 7.08 MiB | 5.9 ms |
| 80 000 行 | 28.38 MiB | 175.82 ms | 28.38 MiB | 6.2 ms |

读取字节 = 整个冷档案、每次 mutation 一次，这条曲线是线性的；因此 N 次追加的累计成本
是二次的。这就是审计说的 O(n²)，在**当前代码上成立**。

### 2.2 改动：按文件身份校验的扫描缓存

`#readArchiveSync` 在自己的扫描之上加了一层只回答"这些字节我已经解析过"的缓存
（`#archiveReadCache`，按集合保存一次扫描结果：`records`、`positions`、`tombstones`、
扫描期间报告的 faults、以及产生它的文件身份）：

- **身份 = 设备 + inode + 字节数 + 纳秒 mtime**，逐个文件按读取顺序拼接，与
  `archive-stage.js` 和 `archiveScanMemo` 判定"两个目录项是不是同一份字节"用的是同一组字段。
  插件改动档案的每条路径都会改到其中一个字段：追加改变字节数；封段、压缩、torn-tail
  修复都 rename 出新 inode；进程外的写入至少改变 mtime。
- **命中**：直接复用那份解析结果（返回浅拷贝数组），并按缓存里的 faults 重新记录一次
  fault——重复读取对 fault 的描述与重新扫描完全一致（同样的去重键，当前时钟戳）。
- **自己写出的行**：`#recordActiveArchiveWrite` 在 append 落盘之后把这几行并入缓存
  （`#extendArchiveReadCache`）。这只在两件事同时成立时发生并可验证：active 文件是读取
  顺序里的**最后一个**文件（于是追加只会在已有记录之后新增，"首次位置"和"最新值获胜"
  与重新扫描一致），且缓存记录的身份正好增长了本次追加的字节数、inode 未变。任何一条不
  成立就丢弃该集合的缓存，下次读取重新扫描。
- **未命中**：走原来那条扫描，并把结果登记为缓存。身份无法构造（stat 失败、不是普通文件）
  时**不登记**，于是行为与改动前完全一致。
- **绝不成为权威**：这是"文件的解析缓存"，不是索引。日志里没有任何来自它的判断；
  档案的字节仍然是唯一真相，缓存只决定"要不要再解析一遍同样的字节"。
- **内存有界**：一条归档记录对应一个已解析行，上限就是冷档案本身，而冷档案总量已被
  `compactionTriggerBytes`（默认 48 MB）约束。实测保留成本见 2.5。

新增的私有方法集中在 `#readArchiveSync` 之前的一个连续块里：
`#archiveReadParts`、`#archiveReadIdentity`、`#archiveKnownFrom`、`#archiveReadCacheFor`、
`#rememberArchiveRead`、`#replayArchiveRead`、`#extendArchiveReadCache`；
`#readArchiveSync` 本身改为"先 stat、命中即复用、否则扫描"。

### 2.3 交替 A/B 数据

每侧 6 个有效样本，A/B 与 B/A 交替 3 轮：

| 冷档案 | 每 16 次追加的读取字节 | 单条 mutation | 比值 |
| --- | --- | --- | --- |
| 1.41 MiB（4 000 行） | A 28.35 MiB → B 1.41 MiB（**20.0×**） | 8.91 → 5.26 ms | **0.59** |
| 7.08 MiB（20 000 行） | A 141.26 MiB → B 7.08 MiB（**20.0×**） | 41.40 → 22.71 ms | **0.55** |
| 28.38 MiB（80 000 行） | A 565.83 MiB → B 28.38 MiB（**19.9×**） | 175.82 → 89.41 ms | **0.51** |

读取次数同样从每次追加 8 次（2 个集合 × 3 个 sealed 段 + 1 个 active 文件）降到**每 16 次
追加共 8 次**：整个 batch 只把冷档案读了一遍。

留下了多少：B 侧单条 mutation 仍有约 89 ms（40 000 规模），其中约 76 ms 是
`#sourceMatches` 对每条冷来源行的 `knowledgeKeyOf` 兜底（脚本的 `key-fallback` 项在同一
fixture、同一台机器上直接测量：3.78 / 19.03 / 77.07 ms，规模对应 2 000 / 10 000 / 40 000）。
这一项**本轮没动**：它不是读取成本，而是"某行的存量 key 与事件 key 不相等时，必须用该行
自己的字段重算规范 key"这条语义。改它等于改哪些来源行算匹配，进而改保留决策与落盘内容，
超出"最小改进"的范围，留作独立一项。

### 2.4 收益边界

- **进程内每个集合的第一次读不获益**：单条 mutation（新实例）A 163.68 ms / B 157.63 ms
  （40 000 规模），比值 0.96；2 000 规模 8.67 / 8.73 ms（1.01）。也就是说，每次 `load()` 之后的
  第一条带知识身份的追加仍付一次全量扫描——这是缓存不可省的部分，不付它就只能相信没读过的字节。
- **收益随冷档案线性增长**：40 000 规模单条省约 86 ms；2 000 规模只省 3.7 ms，已经被
  进程噪声淹没（该规模 `hash-sealed` 这项两侧做完全相同的工作，比值在 0.99–1.01 之间波动，
  可作为噪声带参考）。
- **追加频率决定累计收益**：热窗口满之后每次追加都会驱逐记录、写 active 文件，B 侧这些
  追加被并入缓存，不需要重扫（`mutation-batch` 就是这种稳态）。冷档案越大、追加越频繁，
  收益越接近上表的 2×。
- 未单独测量但同源的收益：`history()` / `fullSnapshot()` 走同一个读取函数，同一次
  `verifyConsistency()`、`compact()`、`restore()` 里对同一集合的重复读取也会命中缓存。
  本节只报告上表实测的两条路径。

### 2.5 等价性证据

1. **既有差分基线**：`node --test test/dockyard-domain/`（本轮实际执行，改动前后各至少一次）
   结果逐项相同——4 个改动前就已失败的用例保持不变（1 个是
   `the baseline block is anchored to the frozen pre-change artifact`，因 rc.7 冻结产物尚未
   随工作树改动重新登记；另外 3 个是 `knowledge-identity-equivalence` 的失败，来自并行子代理
   对 `knowledge.js` 的改动，与本轮无关）。**没有新增失败**。
   其中 `archive-index-equivalence` 与 `retention-plan-equivalence` 两项依赖
   `test/dockyard-domain/*-baseline.js` 里已登记的反转锚点逐条匹配工作树：本轮把
   `#reconcileArchiveIndex()` 里那句 `// Active files are the bounded recovery surface …`
   **原样保留**，新解释写在它前面，因此这两项仍然通过。
2. **持久化路径**：`node --test test/memory-integrity-cold-archive.test.mjs
   test/failure-memory-integrity.test.mjs test/cross-session-hydration.test.mjs
   test/storage-transaction-archive-install.test.mjs
   test/storage-transaction-load-archive-writes.test.mjs test/restart-recovery.test.mjs`
   共 32 项全部通过（torn tail、写入失败、冷行更新、无法解析的字节、刷新失败重写、
   `deferLoadArchiveWrites`、staged 安装、重启恢复）。
3. **新增回归用例** `test/memory-perf-archive-read-cache.test.mjs`（9 项）。其中 2 项是这条改动的
   成本断言，**在改动前的实现上失败、改动后通过**（已用 A 侧源码跑同一份文件确认）：
   - `a repeated append does not re-read archive bytes this process already parsed`
   - `an append this instance performed is carried without a rescan`
   另外 7 项在两侧都通过，它们是这个缓存必须保持的行为不变量：
   - 进程外追加（只改字节数）、同长度原地重写（只改 mtime）、torn tail 都要被下一次读取观察到，
     且与全新实例读同一份文件的视图逐字节相同；
   - 轮转（封段）与 `compact()` 之后，缓存视图仍等于文件；
   - `load()` 接受同尺寸的 sealed 段被改写、`verifyConsistency()` 报告 `checksum`（P3-3 的边界）；
   - append 后索引文档确实前进、restart 不读 sealed 段（P3-5）；
   - 缺失索引时回退全量扫描，而不是把空索引当成"内容是空的"。

### 2.6 保留成本（内存）

`mutation-batch` 在每次采样前后各做一次显式 gc 并读 `heapUsed`，两侧用同一 fixture：

| 冷档案 | A 侧 batch 前后 heap 增量 | B 侧 batch 前后 heap 增量 | 差值（保留的解析结果） |
| --- | --- | --- | --- |
| 1.41 MiB | +0.3 MiB | +1.3 MiB | ≈ 1.0 MiB |
| 7.08 MiB | +0.7 MiB | +5.7 MiB | ≈ 5.0 MiB |
| 28.38 MiB | +2.5 MiB | +22.3 MiB | ≈ 19.8 MiB |

约 0.7 MiB heap / MiB 冷档案；按 `compactionTriggerBytes` 的 48 MB 上限推算约 34 MiB。
这是**上界**而不是稳态占用：`compact()` 重写档案后文件身份改变，缓存随之丢弃并在下次读取时重建。

## 3. P3-3：sealed 段只比 `byteSize` —— 测量后保留现状

### 3.1 现状（改动前后一致）

`#reconcileArchiveIndex()` 对 sealed 段的判据是

```js
const valid = current?.sealed === true
  && current.checksumState === "final"
  && typeof current.sha256 === "string"
  && Number(current.byteSize) === size;   // 只有目录项 stat 出来的 size
```

成立就 `continue`，**不读、不重算摘要**。同尺寸的内容篡改因此在 `load()` 时不可见；
只有 `verifyConsistency()` → `#archiveConsistencyReport()` 会读回并重算 sha256，报告
`reason: "checksum"`。`test/memory-perf-archive-read-cache.test.mjs` 里的
`load() accepts a same-size sealed segment; verifyConsistency() reports it` 就是把这条边界
钉住的用例：伪造一次同长度改写后，`load()` 不读任何 sealed 段、`archiveIntegrity()` 为空，
而 `verifyConsistency()` 返回 `valid: false`、`reasons` 含 `archive_index_inconsistent`、
`archive.mismatched` 恰为 `[{ reason: "checksum" }]`。

### 3.2 在 load 路径上重算摘要的成本

`hash-sealed` 项在同 fixture 上读回并 sha256 每一个 sealed 段（这正是"启动时校验全部
sealed 段"要多做的工作）：

| 冷档案 | sealed 字节 | `load()`（现状） | 重算 sealed 摘要 | 占 `load()` | `load()` 无索引（对照） |
| --- | --- | --- | --- | --- | --- |
| 1.41 MiB | 1.06 MiB | 2.69 ms | 0.69 ms | 26% | 6.55 ms |
| 7.08 MiB | 5.31 MiB | 7.01 ms | 3.18 ms | 45% | 22.92 ms |
| 28.38 MiB | 21.28 MiB | 22.92 ms | 13.11 ms | 57% | 81.22 ms |

按 48 MB 压缩上限线性外推约 +28 ms 纯哈希（实测 0.6 ms / MiB sealed 字节、约 1.7 GB/s，硬件 SHA 已启用），另加这些字节的**真实磁盘 I/O**——它们在今天
的启动路径上完全不被触碰（`load()` 只读 active 文件，见 4.2）。这是把启动路径上唯一
被索引跳过的部分重新读回来的代价。

### 3.3 为什么没实施

- 成本相对量随档案增长到 57%，且是"每次启动都付"，而它多覆盖的只有"内容被改成同样大小"
  这一种情况；截断、零填、写坏这些更常见的损坏都会同时改变大小，已经被现有判据覆盖。
- 平台侧代价更重：`load()` 发现摘要不符时没有可用的修复动作（字节已坏，无法重建），
  只能报告成 degraded。要报告就得新增一种 archive fault kind，而消费方
  `lib/diagnostics.js`、`COMPATIBILITY.md` 不在本轮可改文件范围内；另一条路是让
  `load()` 抛错，那等于让一个控制面插件因冷档案摘要不符而无法启动。
- 因此按任务允许的第二种结果处理：**保留现状 + 把边界写进代码注释 + 用回归用例固化**。
  注释写在 `#reconcileArchiveIndex()` 的 sealed 判据之前，只描述代码实际做的事：
  它因为 sealed 段"写入临时名、rename 就位、此后不再追加"而信任索引里的 size，
  不读不重算；同尺寸改动在 load 上不可见；`verifyConsistency()` 才是重算摘要并报告
  `checksum` 的那条路径。

## 4. P3-5：索引持久化 —— 审查结论不成立，补测量并保留现状

### 4.1 增量持久化本来就有

`#archiveEntries()` 每次成功写入后都会 `await this.#writeArchiveIndexIncremental()`
（原子 rename 写 `*.evolution-archive-index.json`），`#recordActiveArchiveWrite()` 同时把
active 条目在内存索引里前移；`#setArchiveMetadata()` 只更新 `#data.coldArchives`，由
mutation 自己的 `#save()` 落盘。也就是说"只在 reconcile 时写盘"在当前代码上不成立。
实测（`--scales` 三档，fixture 里每档都是 6 个 sealed 段 + 2 个 active 条目）：
索引文档 4 576 / 4 588 / 4 608 字节、8 个条目——**与冷档案大小无关**，因为它按文件记账，
不按记录记账。

回归用例 `an append persists the index document, and load() reads only the active files`
把这条钉住：一次驱逐型追加之后，索引里 active 条目的 `physicalCount` 前进、
`byteSize` 等于文件的真实大小（说明索引是在 append 之后被写的，而不是等下一次 reconcile）。

### 4.2 restart 读的是哪一部分

| 冷档案 | `load()` 读取 | 占冷档案 | `load()` 无索引 | 差值 |
| --- | --- | --- | --- | --- |
| 1.41 MiB | 0.36 MiB | 25% | 1.41 MiB / 6.55 ms | 2.4× |
| 7.08 MiB | 1.77 MiB | 25% | 7.08 MiB / 22.92 ms | 3.3× |
| 28.38 MiB | 7.10 MiB | 25% | 28.38 MiB / 81.22 ms | 3.5× |

（2.69 / 7.01 / 22.92 ms 对 6.55 / 22.92 / 81.22 ms。读取字节等于 active 文件之和加
`state.json`。三档的 sealed : active 都是 fixture 设计的 3 : 1，所以"25%"是构造结果，
可复用的结论是：restart 只读 active 部分，与 sealed 段的数量和大小无关。）

### 4.3 剩下的部分是有意保留的恢复面

`load()` 仍然逐个解析 active 文件，注释里写明理由：追加先落盘、索引后写盘，崩溃可以让
文件领先于索引，因此 active 文件是"append/index 崩溃后的有界恢复面"。跳过它就必须让索引
对"它之后写入的字节"具有权威性——任务本身也明确禁止把派生索引当成数据完整性的权威来源。
本轮因此**不做**这项改动，只把测量与不变量补上：`load()` 读到的归档字节 100% 是 active
文件（另有 `state.json`），缺失索引时回退全量扫描并重建，行为由
`a missing index falls back to a full scan instead of trusting nothing` 钉住。

## 5. 改动位置与反转区域（供基线重新登记）

`lib/dockyard-domain/memory.js` 的改动都是**连续文本块**，不含跨区域的穿插修改；
`test/dockyard-domain/archive-index-baseline.js` 与 `housekeeping-baseline.js` 未修改。
主代理 regenerate 时需要登记的区域如下（按文件内顺序，锚点为改动后的文本）：

| # | 类型 | 起始锚点（含） | 结束锚点（含） | 内容 |
| --- | --- | --- | --- | --- |
| 1 | 插入 | `   * The identity of every file \`#readArchiveSync\` reads for one collection, in`（其上新增了 `  /**`，紧接 `#resolveArchiveStale` 的收尾大括号） | `  #readArchiveSync(collection) {` 之前的那一行空行 | 7 个新私有方法：`#archiveReadParts` / `#archiveReadIdentity` / `#archiveKnownFrom` / `#archiveReadCacheFor` / `#rememberArchiveRead` / `#replayArchiveRead` / `#extendArchiveReadCache` |
| 2 | 替换 | `  #readArchiveSync(collection) {` | 该函数结尾的 `  }`（下一个空行之前） | 改为"先 stat → 命中即复用 → 否则扫描"，扫描分支内 `note()` 收集 faults 并在末尾登记缓存 |
| 3 | 插入 | `    // The appended lines are on disk now, so the cached parse of these files can` | `    this.#extendArchiveReadCache(collection, file, records);` | `#recordActiveArchiveWrite()` 末尾 3 行 |
| 4 | 插入 | `          // An append lands before the index document that describes it, so a` | `          // Active files are the bounded recovery surface after an append/index crash.` 之前的一行 | `#reconcileArchiveIndex()` 里 active 分支之前新增的 5 行注释（P3-5 边界）。**原有那句注释保持逐字节不变**，因为它本身是已登记的反转锚点 |
| 5 | 插入 | `        // A sealed segment is written under a temporary name, renamed into place` | `        const valid = current?.sealed === true` 之前的注释块 | `#reconcileArchiveIndex()` 里 sealed 判据前的注释（P3-3 边界） |

区域 2 与本轮之前已有的反转片段相邻但不嵌套（旧片段覆盖 `#readArchiveSync` 的函数体，
本轮把整个函数体换成了新实现，重新登记时天然合并）。区域 1、3、4、5 各自独立。
需要注意：区域 2 内部把两处 `this.#noteArchiveFault(collection, { … })` 改成了局部的
`note({ … })`（同一个调用，外加把这条 fault 收进缓存），而这两行出现在
`/tmp/dsh-evolution-memory-integrity/fragments.json` 里**尚未登记**的片段中；登记那批片段时
这两行的 `post` 文本需要按现状重新取，不能沿用旧片段。
用 `diff -u <改动前的 memory.js> lib/dockyard-domain/memory.js` 机械展开时，这 5 个区域
一共产生 **7 个 hunk**（`@@ -1145,16 +1145,144 @@`、`@@ -1163,7 +1291,7 @@`、
`@@ -1193,7 +1321,7 @@`、`@@ -1201,11 +1329,11 @@`、`@@ -1375,7 +1503,12 @@`、
`@@ -1383,6 +1516,13 @@`、`@@ -1451,6 +1591,9 @@`；其中 `-1375` 那个 hunk 是新增的 5 行注释），前 4 个都落在
`#readArchiveSync` 这一个区域里（中间被未改动的扫描行隔开），后 3 个分别对应上表的
区域 4、5、3。

新增/修改的其它文件（不属于 `memory.js` 反转区域）：

- 新增 `scripts/benchmarks/archive-read-cost.mjs`
- 新增 `docs/performance/archive-read-cost.md`、`docs/performance/archive-read-cost.json`
- 新增 `test/memory-perf-archive-read-cache.test.mjs`

## 6. 残留风险

1. **缓存身份依赖 mtime 的纳秒精度**。`dev + ino + size + mtimeNs` 这组字段与
   `archive-stage.js`、`archiveScanMemo` 的既有假设一致，`PORTS.md` 也要求 adapter 提供
   **独占数据根**（"多实例/多进程写同一个 archive 根没有额外锁保证"），因此进程外写入不在
   契约内；确实发生时会改变 mtime。退化情况是文件系统 mtime 精度只有秒级时，"同尺寸原地
   重写"可能读不到新内容——`test/memory-perf-archive-read-cache.test.mjs` 的同长度重写用例
   在这种情况下会 `diagnostic` 跳过而不是假装通过。
2. **缓存的 records 与返回数组共享对象**。这是命中之所以便宜的原因（克隆会把收益还回去），
   依赖的是既有约定：`history()` / `fullSnapshot()` / `historyWindow()` 总是克隆返回，
   `#sourceMatches` / `#knowledgeEntryFor` 只读。回归用例用"与全新实例逐字节相同"覆盖了
   这一点，但如果将来有调用方直接改写 `#mergeArchived(…, { copy: false })` 的返回值，
   会污染缓存。这是本轮引入的**新约束**，需要 review 时确认。
3. **保留内存约 0.7 MiB / MiB 冷档案**（48 MB 上限附近约 34 MiB heap）。这是把冷档案
   换成"解析态常驻"的代价，本轮选择的是"有界 + 可丢弃"，而不是无限增长。
4. **`#sourceMatches` 的 `knowledgeKeyOf` 兜底仍然是 O(冷档案)**（40 000 规模约 76 ms/次
   mutation，等于 B 侧剩余成本的主项）。因此这条路径的累计成本**仍不是线性的**，
   只把常数降了约一半。要真正消除它需要改"哪些来源行算同一个知识先例"的语义，
   本轮未做，也没有验证过等价性。
5. **分发字节已改变**：`lib/dockyard-domain/memory.js` 属于分发内容，`contentSha256`
   与 `release/` 固定点需要按 `RELEASE.md` 重新构建与重跑验收，本轮未执行（禁止项）。
   `npm run pack:check` / `release:verify` 预期失败，直到重新 pin。
