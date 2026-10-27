# 冷归档解析缓存：有序键表 + 有界行窗口

基线 `5b94ac6`（`0.2.0-rc.19` 固定点之后的开发后继）。本轮只改 `lib/dockyard-domain/memory.js` 的冷归档读取缓存与三个读路径
（`lib/domain-storage.js` 的 `recall`、`lib/experience-recall.js` 的窗口扫描入口），不新增持久化文件、不改版本、不改
`release/` 固定产物与宿主兼容范围。原始数据：[`archive-row-window.json`](archive-row-window.json)。

| 改动 | 结论 |
| --- | --- |
| 缓存改为**有序键表 + 最新 2048 行 / 4 MiB 行窗口**，其余行按行定位符按需重读 | **保留**：万级双档 31.66 → 10.20 MiB（−67.8%），四万级 126.64 → 23.67 MiB（−81.3%） |
| 写路径（`#sourceMatches`、`#knowledgeEntryFor`、`#archiveEntries` 替换分支）改为查表 | **保留**：不再为"这一条记录是否已归档/是否匹配"物化整份历史 |
| `historyWindow`/`recall` 改为表 + 尾部窗口读取 | **保留**：`query` 0.36 → 0.22 ms；`recall` +4%（0.5 ms，见 §5） |
| 追加时用滚动摘要延续内容凭证（`liveDigest`），并在私有化后按前缀摘要复核 | **保留**：追加型 observe 60.0 → 51.0 ms（−15.1%），CPU 42.7 → 32.5 ms（−23.9%） |
| 整集合预算 / LRU 准入 | **不重做**：已在本目录 [cold-archive-budget-rejected.md](cold-archive-budget-rejected.md) 撤回，本轮不重复 |
| 把表格移入持久化索引文档、或改 `compactionTriggerBytes` 自动压缩 | **不做**：前者是新的持久化协议，后者已在 [capacity-20261026.md](capacity-20261026.md) 撤回 |

## 1. 缓存为什么会长、长在哪

旧缓存每个集合保存**整个冷归档的解析行**（`records`）加 `positions`。用真实 `EvolutionMemory` 在 1 万 + 1 万行
（22.16 MB 冷归档）上测量，逐集合删除条目并 GC 后归因：

| 集合 | 旧实现保留 | 行窗口实现保留 | 说明 |
| --- | ---: | ---: | --- |
| `knowledge` | 22.85 MiB | 5.74 MiB | 每行约 2.34 KiB，其中约 0.55 KiB 是解析后的对象开销 |
| `observations` | 7.52 MiB | 3.11 MiB | 每行约 0.77 KiB |
| 合计 | **30.35 MiB** | **8.85 MiB** | 约 1.37 MiB 堆 / MiB 冷归档 |

即"缓存占用"里约 **75% 是行对象本身，25% 是键表**（`positions`、`archiveKnown`、规范化知识键）。因此只把行对象
换成更省的容器（原始 JSON 文本、列式数组）最多省 20–25%，而把整份行留在缓存里就不可能降低随历史增长的部分。
冷归档本身不受 `compactionTriggerBytes` 约束（`maintenance()` 仍未接线，见 capacity 文档），所以这份增长没有上限。

## 2. 改了什么

缓存条目现在是一次解析的**只读索引**：

- `positions`（键 → 位置，最新值覆盖、首位置稳定）、`keys`（位置 → 键）、`storedKeys`/`derivedKeys`（位置 → 行自带的
  知识键与它六维哈希出的键）、`tombstones`、`faults`、`digests`，以及每个位置的 `locators`（文件序号 + 字节区间）。
- `windowFrom`/`window`：只保留最新位置的解析行，同时受 **2048 行**与 **4 MiB 行字节**两个上限约束。这两个上限对应
  领域实际的尾部读：端口 `query` 至多返回 50 行，`experience-recall` 的普通扫描由它自己的 `maxConsidered`（2000）约束。
- 不在窗口内的行由 `#archiveRowAt()` 用定位符读回：一次 `open/read/close` + 一次 `JSON.parse`，并校验解析出的键仍是该
  位置的键；读不出（文件在已校验身份下被替换）就丢弃条目重扫，绝不用旧偏移猜一行。
- 完整历史读（`history`、`fullSnapshot`、`restore`、`retentionPlan`、`compact` 回读）仍返回与扫描完全一致的全部行，
  只是它们来自文件而不是来自常驻缓存；每个文件只打开一次。

写路径不再物化整份历史：

- `#sourceMatches()`：逐位置比较 `storedKeys`/`derivedKeys`，只把命中的行读回来；热覆盖行按 `id` 命中，行的先后顺序与
  `#mergeArchived()` 逐项相同（id 行在前、无 id 行在后，归档行在热行之前）。
- `#knowledgeEntryFor()`：查表定位知识累积行，只读这一行。
- `#archiveEntries()` 的替换分支：只读回真正要替换的那些行的旧值，不再整份读一遍。
- `historyWindow()`/`historyScan()`：从尾部走一遍合并顺序，只物化被返回的行；`port.recall` 改为把窗口扫描交给
  `collectKnowledgeExperience`，`scanned`/`considered`/`duplicates`/`records` 与原实现逐字段相同（新测试断言）。

内容凭证没有被放宽：

- 跨实例继承仍要求逐文件读取 + SHA-256 比对（原样保留）；新增的只是"本条实例刚追加过"的延续凭证
  `liveDigest`：追加时把它 `copy()` 后喂进本次写入的字节，得到的新摘要描述的就是磁盘上的字节，所以继任事务
  可以正常验证而不是整份重扫。
- 追加前如果文件身份变了（分阶段事务会用硬链接镜像 + 写前私有化，同一份字节换了 inode），只有**前缀字节的
  SHA-256 与缓存记录的摘要相同**才接受，否则丢弃条目。大小与设备相同不足以作为证据。

## 3. 真实端到端 A/B

环境：Node v26.12.1、darwin/arm64、Apple M2、8 逻辑 CPU、16 GiB。机器不是专用空闲环境；每份原始 JSON 记录
开始时的 load average。基准与全量测试没有并行运行。两侧使用同一份夹具字节、同一脚本、同一参数，每条命令一个
独立进程；三轮中两侧的先后顺序逐轮交换，表中为三个轮内中位数的中位数。

夹具与真实长期运行的主机同形：75% 的历史在 sealed 段里，最新 25% 在活动文件里（单一超大活动文件会让第一次追加
触发轮转，从而因为与缓存表示无关的原因失效，那种形状单独测过，见 §5）。

### 3.1 保留内存（cache 模式，一次带知识的写入）

| 规模 | 冷归档 | 基线保留 | 候选保留 | 变化 | 基线峰值 RSS | 候选峰值 RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10k + 10k 行 | 23.2 MB | 31.66 MiB | **10.20 MiB** | **−67.8%** | 232.3 MB | 225.1 MB（−3.1%） |
| 40k + 40k 行 | 92.8 MB | 126.64 MiB | **23.67 MiB** | **−81.3%** | 539.1 MB | 533.0 MB（−1.1%） |

逐集合归因：10k 规模 30.35 → 8.85 MiB（−70.8%），40k 规模 122.08 → 19.08 MiB（−84.4%）。保留量现在由
"每个集合的记录数 × 每行键表开销 + 窗口上限"决定，而不再由"每一行的解析对象"决定。

### 3.2 官方存储端到端（10k + 10k 行，`port.observe()`）

| 负载 | 基线 wall | 候选 wall | 基线 CPU | 候选 CPU | 基线 `recall` | 候选 `recall` | 基线 `query` | 候选 `query` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `repeat`（归档不变） | 17.01 ms | 16.14 ms（−5.1%） | 10.77 ms | 10.04 ms（−6.8%） | 12.05 ms | 12.39 ms（+2.9%） | 0.297 ms | 0.209 ms（−29.6%） |
| `evict`（每次追加） | 60.04 ms | **50.96 ms（−15.1%）** | 42.66 ms | **32.47 ms（−23.9%）** | 12.63 ms | 13.11 ms（+3.8%） | 0.361 ms | 0.219 ms（−39.3%） |

峰值 RSS：`repeat` 261.2 → 247.0 MB（−5.4%），`evict` 261.1 → 257.8 MB（−1.3%）；GC 时间 `repeat` 31.3 → 26.4 ms
（−15.7%），`evict` 23.8 → 24.6 ms（同一噪声区间）。

每次 observe 实际解析的归档行数：`evict` 基线 5000 → 候选 2500（省掉的是读缓存整份重解析；剩下的 2500 是
`#reconcileArchiveIndex()` 对活动文件的派生索引重建，属另一条路径）。`repeat` 两侧都是 0。

## 4. 语义边界

- 读回的每一行都与一次完整扫描逐字段相同：行窗口内的行被共享，窗口外的行从自己的行读回，`latest-wins`、首次位置、
  tombstone、无 `id` 行、`Error` 实例行、损坏行/半截尾行的故障计数都沿用同一套判定。
- 完整历史读仍精确：`history()`/`fullSnapshot()`/`retentionPlan`/`compact` 回读与原实现逐字节一致（既有的
  [`retention-plan-equivalence.test.js`](../../test/dockyard-domain/retention-plan-equivalence.test.js)、
  [`archive-index-equivalence.test.js`](../../test/dockyard-domain/archive-index-equivalence.test.js)、
  [`housekeeping-equivalence.test.js`](../../test/dockyard-domain/housekeeping-equivalence.test.js) 差分继续通过）。
- 继承、失效与故障路径未放宽：逐文件摘要比对保留；追加只延续本次写入的字节；私有化后按前缀摘要复核；读不出就重扫；
  重扫仍不一致就 `ValidationError` 而不是猜。
- 没有新增持久化文件，没有改变 state、归档、索引文档、事件日志或事务/journal/锁/恢复顺序。

## 5. 已知边界与剩余风险

1. **键表仍随记录数线性增长。** 每条归档记录约 200–230 B 键表（键 + 知识键 + 位置 + 定位符）。1 万行约 2.1 MiB，
   10 万行约 21 MiB：斜率比原来（每行约 1.5 KiB 对象）低约 7 倍，但不是常数。要真正封顶需要"键也不再常驻"，那会
   让"这一条是否已归档/是否匹配"退回整份扫描，正是已撤回的整集合预算方案的失效模式。
2. **整份历史读不再有缓存加速**：`history`/`fullSnapshot`/维护计划现在按需读文件（每个文件一次打开）。生产端口
   不调用它们；`continuous/` 仍未接线。`port.recall` 走窗口扫描，`port.query` 走尾部窗口。
3. **`recall` 小幅变慢（+0.4 ms，+3.8%）。** 它现在做一遍合并清点 + 一遍精确键扫描 + 尾部窗口物化；基线直接过滤
   已常驻的数组。绝对值小于机器漂移，但方向一致，记在这里而不宣称零开销。
4. **活动文件的派生索引重建仍每次解析。** `#reconcileArchiveIndex()` 对活动文件的扫描不在本轮范围；它是 `evict`
   负载里剩下的 2500 行解析来源。
5. **跨进程等长原地改写仍是既有边界。** 同一实例内、大小与 mtime 都被还原的原地改写无法靠 stat 发现；继承路径用
   内容摘要兜住（原有行为），本轮没有放宽也没有收紧。
6. **单一超大活动文件的形状**会因第一次追加的轮转而失效（与缓存表示无关）。§3 的夹具是分段的；单文件形状在
   `archive-row-window.json` 之外单独观察过，两侧同样受影响。

## 6. 复现

`/tmp/dsh-main` 是本轮开始时的基线 worktree（`git worktree add /tmp/dsh-main 5b94ac6`，`node_modules` 指向本树）。
两侧都用 4096 MiB 堆上限，且只使用临时数据根：

```sh
# 保留内存：每条命令一个独立进程；三轮，两侧顺序逐轮交换
node --expose-gc scripts/benchmarks/archive-row-window.mjs --side baseline  --lib /tmp/dsh-main/lib --mode cache --rows 10000 --knowledge-rows 10000 --json
node --expose-gc scripts/benchmarks/archive-row-window.mjs --side candidate --lib lib            --mode cache --rows 10000 --knowledge-rows 10000 --json
# 四万级把 --rows/--knowledge-rows 改成 40000

# 官方存储端到端：repeat 与 evict，各 5 个样本，--reads 另外计时 recall/query
node --expose-gc scripts/benchmarks/archive-row-window.mjs --side candidate --lib lib --mode port --workload evict --rows 10000 --knowledge-rows 10000 --warmup 51 --samples 5 --reads --json

# 每次 observe 实际解析多少行（归因计数）
node scripts/benchmarks/observe-cold-archive.mjs --rows 10000 --knowledge-rows 10000 --workload evict --warmup 51 --samples 3 --rounds 1 --baseline /tmp/dsh-main/lib --attribute --json
```

`archive-row-window.json` 的 `protocol` 记录了轮数、顺序、两侧源码 SHA-256、Node 版本、负载与夹具口径，
`runs` 是逐次采样（含每个样本的 wall/CPU/解析行数/读字节、每次读取的样本、GC 计数与峰值 RSS）。

## 7. 本轮执行的验证

（见 §7 表格，随提交后的实际命令结果填写。）
