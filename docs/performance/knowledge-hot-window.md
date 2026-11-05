# 知识热区上限：把 canonical knowledge 的持久化窗口从 `maxEntries` 收到 200

基线是 `70cb2d3`（已核实，工作树的 `lib/` 与该提交只差本轮两处）。本轮只改
`lib/dockyard-domain/memory.js` 的两处：新增一个知识热区上限常量，并让
`#hotLimit("knowledge")` 返回 `min(maxEntries, 200)`。持久化格式、归档目录、
事务/恢复协议、`applied` 账本、事件桥、跨进程锁、授权与 `release/` 均未改动，
版本号未改。

原始数据：

- 主 A/B/A-control：[`knowledge-hot-window.json`](knowledge-hot-window.json)
- 过渡区间补充：[`knowledge-hot-window-crossover.json`](knowledge-hot-window-crossover.json)
- 组成归因：[`knowledge-hot-window-attribution.json`](knowledge-hot-window-attribution.json)
- 脚本：[`scripts/benchmarks/knowledge-hot-window.mjs`](../../scripts/benchmarks/knowledge-hot-window.mjs)
- 回归：[`test/domain-storage/knowledge-hot-window.test.mjs`](../../test/domain-storage/knowledge-hot-window.test.mjs)

环境：Node `v26.13.0` / `darwin/arm64`，8 逻辑 CPU；主测量开始/结束的 1/5/15 分钟
load average 为 `1.91/1.95/1.85` → `1.91/1.95/1.85`。机器不是空闲机器，因此三侧
每轮交替运行，并保留 A/A-control 作为噪声对照；下文所有数字都是三轮的
中位数（每个场景在子进程内先取 3 个样本的中位数，再取三轮中位数）。

## 1. 瓶颈归因

在真实官方 `DomainFacility` / `JsonStorageBackend` 上，先用冻结基线跑一次
只读组成测量（`knowledge-hot-window-attribution.json`，1000 / 20000 条历史，
每个规模 A/B 各一个子进程）。文档是后端写盘的整份 aggregate；下表是它去掉
缩进后的字节，数值取该子进程结束后的提交文档：

| 组成（字节） | 1,000 基线 | 1,000 本轮 | 20,000 基线 | 20,000 本轮 |
| --- | ---: | ---: | ---: | ---: |
| 整份文档（aggregate + applied） | 1,802,517 | 382,911 | 1,811,107 | 385,107 |
| aggregate | 1,802,490 | 382,884 | 1,811,080 | 385,080 |
| 其中 `knowledge` | **1,777,669** | 358,061 | **1,785,237** | 359,237 |
| `observations` | 23,115 | 23,115 | 23,330 | 23,330 |
| `coldArchives` 元数据 | 1,276 | 1,278 | 2,083 | 2,083 |
| `eventBridge` | 25 | 25 | 25 | 25 |
| `autonomous` | 36 | 36 | 36 | 36 |
| `applied`（文档另一字段） | 2 | 2 | 2 | 2 |
| knowledge 占 aggregate | **98.6%** | 93.5% | **98.6%** | 93.3% |
| `dockyard/` 归档树（全部集合 + 索引） | 2,485,128 | 3,904,745 | 83,902,694 | 85,328,695 |

读法：

- 在这条 observe 路径上，**canonical knowledge 热区几乎就是整份文档**：
  1000 / 20000 条历史时都占 aggregate 的 98.6%，观测集合只剩 50 条热记录
  （约 23 KB），`coldArchives` 元数据只有 1–2 KB，`eventBridge` 与
  `autonomous` 合计 61 B。
- `applied` 在观察负载里是空表（2 B = `{}`）：observe 不经过事件桥，也不写
  标记。事件回放/稳态 flush 的标记表与日志成本是另一条路径，本轮没有改动它，
  也没有把它算进这里的收益。
- 一次 archive-changing 事务写**两次**文档：pending 记录里 `aggregate` 与
  `pending.aggregate` 各一份，随后提交文档再写一份；后端又把整份文档按两空格
  缩进写出。1000 条历史时实测后端写入约 10.4 MB/次 observe（§4 的
  `9,971,101 B`），其中约 3.6 MB 是同一份 knowledge 热区在 pending 记录里的
  第二次出现，缩进又把它放大到约两倍。20,000 条历史时 knowledge 热区仍被
  `maxEntries` 顶在 1000 条（1.79 MB 紧凑 / 约 3.28 MB 文件），所以文档大小
  不随历史增长，但每次 observe 仍是约 10 MB 写入。
- 归档元数据不是瓶颈：1000 / 20000 条历史时 `coldArchives` 仅 1.3 / 2.1 KB；
  归档树字节随历史线性增长，但那条路径本来就有，且不是本轮的改动对象。

热区大小与事务成本的关系也直接量到：1000→20000 条历史时本轮之前的新主体
observe 从 115.72 ms 升到 200.07 ms，而文档组成几乎不变（1,802,517 →
1,811,107 B）；增加的是冷键表/归档扫描，但文档写入始终是主导项。把 knowledge
热区从 1000 收到 200 后，文档从 1.80 MB 降到 0.38 MB（紧凑），后端写入从约
10.4 MB 降到约 2.1 MB（每次 observe）。

## 2. 改动

`lib/dockyard-domain/memory.js`，两处：

1. 新增常量 `KNOWLEDGE_HOT_ENTRIES = 200`，注释写明它为什么小于
   `maxEntries`。
2. `#hotLimit("knowledge")` 从 `this.maxEntries` 改为
   `Math.min(this.maxEntries, KNOWLEDGE_HOT_ENTRIES)`。

`maxEntries` 仍然是上限：把 `maxEntries` 配成更小的值（测试里的 3 / 4 / 32）
时热区仍按该值收缩；没有归档的内存存储（`!this.archiveFile`）仍按
`maxEntries` 截断，这条路径不变。归档、身份、去重、累计、顺序、公开查询与恢复
都复用既有实现：`#mergeArchived()`、`historyScan()`、`knowledgeEntryFor()`、
`#sourceMatches()` 本来就按 archive+hot 合并，`load()` 本来就会把超限记录
归档。本轮只改变“哪些行留在热窗口”，没有新增存储、缓存、后台任务或索引。

## 3. 测量方法

脚本用 `git archive 70cb2d3 lib` 解出两份**逐字节相同**的基线（A 与 A-control），
再复制工作树 `lib/` 作为 B；三份源码的 sha256 写在 JSON 的 `sources` 里
（A 与 A-control 相同，B 不同）。每个（侧、规模、轮次）都起独立子进程，并使用
复制出来的同一份夹具，因此模块级缓存、GC 与进程峰值不会跨侧污染。

夹具：每个历史条目一条 observation + 一条 canonical knowledge 行，行内容用
**冻结基线**的 `projectObservation()`、`normalizeKnowledgeEvent()`、
`mergeKnowledgeEntry()` 生成，时钟固定、UUID 序列固定；写入 `dockyard/state.json`
后通过官方 `domainSeed` 打开。这个夹具刻意把超过新上限的 knowledge 行全部留在
旧文档的热区，模拟“旧版本已经写到 1000 条热知识”的现场；两侧的第一次 mutation
都会在自己的事务里完成迁移。

场景：

| 场景 | 内容 |
| --- | --- |
| `firstWrite` | 打开旧文档后第一次新主体 observe（迁移 + 提交） |
| `newSubject` | 重启后连续 5 次不同新主体 observe（每个事务都提交，不合并） |
| `coldRepeat` | 更新一个已经进入冷归档的主体（5 次） |
| `hotRepeat` | 更新一个刚创建、仍在热区的主体（5 次） |
| `concurrent` | 32 个不同主体 `Promise.all` 并发 observe（32 个独立事务） |
| `restartOpen` | 关闭并重新打开（含 hydrate 与冷归档索引对账） |
| `recall` | `port.recall({ problem, target })`，5 次取中位数 |
| `query` | `port.query('knowledge', 50)`，5 次取中位数 |

字节数是官方 JSON 后端的 `FileHandle.writeFile` 输入（整份文档），不是磁盘物理
写入；sync 计数是后端 `FileHandle.sync` 加同步 `fsyncSync`；事务数按创建的
`stage-*` 目录计数。RSS 是子进程 `maxRSS`（包含夹具解析与迁移），表中另给每个
场景窗口内的 RSS 差值。

## 4. 端到端结果

主表：墙钟中位数，ms；括号是相对 A 的变化。A/A-control 的噪声一并给出。

| 历史条数 | 场景 | A | A-control | B（本轮） | B 相对 A | A/A 噪声 |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 0 | firstWrite | 15.88 | 16.12 | 15.90 | +0.1% | +1.5% |
| 0 | newSubject | 10.44 | 10.07 | 10.26 | −1.7% | −3.6% |
| 0 | coldRepeat | 11.93 | 11.92 | 12.01 | +0.7% | −0.1% |
| 0 | hotRepeat | 11.93 | 11.96 | 11.94 | +0.1% | +0.2% |
| 0 | concurrent | 379.50 | 377.10 | 356.96 | −5.9% | −0.6% |
| 200 | firstWrite | 55.77 | 55.66 | 67.49 | **+21.0%** | −0.2% |
| 200 | newSubject | 50.63 | 50.67 | 52.09 | +2.9% | +0.1% |
| 200 | coldRepeat | 49.26 | 48.47 | 54.31 | +10.2% | −1.6% |
| 200 | hotRepeat | 22.83 | 21.37 | 23.75 | +4.1% | −6.4% |
| 200 | concurrent | 742.86 | 756.35 | 761.76 | +2.5% | +1.8% |
| 300 | firstWrite | 65.92 | 64.79 | 71.67 | +8.7% | −1.7% |
| 300 | newSubject | 53.85 | 57.11 | 51.32 | −4.7% | +6.0% |
| 300 | coldRepeat | 57.91 | 56.04 | 52.52 | −9.3% | −3.2% |
| 300 | hotRepeat | 25.86 | 25.93 | 22.96 | −11.2% | +0.3% |
| 300 | concurrent | 879.76 | 886.35 | 766.21 | −12.9% | +0.8% |
| 400 | firstWrite | 72.43 | 73.82 | 78.88 | +8.9% | +1.9% |
| 400 | newSubject | 64.10 | 66.96 | 54.01 | −15.7% | +4.5% |
| 400 | coldRepeat | 64.08 | 66.66 | 50.47 | −21.2% | +4.0% |
| 400 | hotRepeat | 28.26 | 29.93 | 22.73 | −19.6% | +5.9% |
| 400 | concurrent | 1032.03 | 1019.37 | 779.87 | −24.4% | −1.2% |
| 500 | firstWrite | 86.18 | 85.24 | 82.55 | −4.2% | −1.1% |
| 500 | newSubject | 72.07 | 71.25 | 50.98 | −29.3% | −1.1% |
| 500 | coldRepeat | 70.53 | 71.70 | 52.13 | −26.1% | +1.7% |
| 500 | hotRepeat | 35.09 | 34.10 | 22.89 | −34.8% | −2.8% |
| 500 | concurrent | 1179.96 | 1189.89 | 776.12 | −34.2% | +0.8% |
| 750 | firstWrite | 111.23 | 111.05 | 101.88 | −8.4% | −0.2% |
| 750 | newSubject | 94.98 | 96.43 | 50.00 | −47.4% | +1.5% |
| 750 | coldRepeat | 93.47 | 91.77 | 53.70 | −42.5% | −1.8% |
| 750 | hotRepeat | 45.83 | 44.90 | 24.62 | −46.3% | −2.0% |
| 750 | concurrent | 1571.81 | 1568.93 | 800.92 | −49.0% | −0.2% |
| 1000 | firstWrite | 142.46 | 139.31 | 117.50 | −17.5% | −2.2% |
| 1000 | newSubject | 115.72 | 115.24 | 53.43 | **−53.8%** | −0.4% |
| 1000 | coldRepeat | 116.56 | 114.52 | 53.63 | −54.0% | −1.8% |
| 1000 | hotRepeat | 58.15 | 57.07 | 24.40 | −58.0% | −1.8% |
| 1000 | concurrent | 2004.28 | 1972.96 | 836.00 | **−58.3%** | −1.6% |
| 5000 | firstWrite | 393.36 | 392.70 | 383.57 | −2.5% | −0.2% |
| 5000 | newSubject | 132.61 | 134.28 | 75.95 | −42.7% | +1.3% |
| 5000 | coldRepeat | 132.91 | 130.18 | 72.40 | −45.5% | −2.1% |
| 5000 | hotRepeat | 65.44 | 66.24 | 32.91 | −49.7% | +1.2% |
| 5000 | concurrent | 2325.42 | 2324.35 | 1135.37 | −51.2% | −0.0% |
| 20000 | firstWrite | 1324.22 | 1331.58 | 1305.36 | −1.4% | +0.6% |
| 20000 | newSubject | 200.07 | 205.05 | 142.57 | −28.7% | +2.5% |
| 20000 | coldRepeat | 198.61 | 196.17 | 137.47 | −30.8% | −1.2% |
| 20000 | hotRepeat | 103.45 | 103.42 | 67.40 | −34.8% | −0.0% |
| 20000 | concurrent | 3530.57 | 3543.41 | 2334.45 | −33.9% | +0.4% |

（300/400/500/750 来自过渡区间补充运行；1000/5000/20000 的 firstWrite 与并发
来自主运行。firstWrite 在主运行里包含旧文档迁移，所以 20,000 条时两侧都超过
1.3 s，差异被迁移本身吸收，只有 −1.4%。0 档 `concurrent` 的 −5.9% 与 A/A 的
−0.6% 不同，但该档两侧的代码路径、文档字节、写入字节与 sync 次数完全相同；
这里不把它当作收益，原因未定位。）

CPU 与写入：

| 历史 | 场景 | CPU A → B | 后端写入 A → B | sync 次数 A / B | 事务 A / B |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1000 | newSubject | 98.76 → 35.21 ms（−64.3%） | 9,971,101 → 2,078,731 B（−79.2%） | 9 / 9 | 1 / 1 |
| 1000 | concurrent | 1897.81 → 624.84 ms（−67.1%） | 124,805,013 → 26,319,196 B（−78.9%） | 88 / 88 | 32 / 32 |
| 5000 | newSubject | 134.15 → 76.49 ms（−43.0%） | 9,982,068 → 2,080,747 B（−79.2%） | 9 / 9 | 1 / 1 |
| 5000 | concurrent | 2260.26 → 1147.57 ms（−49.2%） | 124,942,905 → 26,344,266 B（−78.9%） | 88 / 88 | 32 / 32 |
| 20000 | newSubject | 221.74 → 174.15 ms（−21.5%） | 9,997,250 → 2,085,650 B（−79.1%） | 9 / 9 | 1 / 1 |
| 20000 | concurrent | 4215.50 → 2855.33 ms（−32.3%） | 125,133,746 → 26,404,947 B（−78.9%） | 88 / 88 | 32 / 32 |

事务数、每事务两次文档写入、每次写文档的 sync 都没有减少；收益来自每次写的
字节数。归档追加仍是同步写，不进入这里的 `writeBytes`，只体现在 `dockyard/`
归档树字节与 sync 计数上。

文档与重启：

| 历史 | 提交文档 A → B | 归档树 A → B | 热/冷 knowledge A → B | 重启打开 A → B |
| ---: | ---: | ---: | ---: | ---: |
| 1000 | 3,270,933 → 691,327 B（−78.9%） | 2.49 → 3.90 MB | 1000/4 → 200/804 | 28.81 → 9.94 ms（−65.5%） |
| 5000 | 3,274,561 → 691,986 B（−78.9%） | 19.61 → 21.03 MB | 1000/4004 → 200/4804 | 27.78 → 10.76 ms（−61.2%） |
| 20000 | 3,279,581 → 693,581 B（−78.9%） | 83.90 → 85.33 MB | 1000/19004 → 200/19804 | 30.91 → 15.23 ms（−50.7%） |

归档树变大是分区改变的直接结果：800 条 knowledge 行从热区进入冷档案；更新冷行
仍按原有实现追加一行（不是本轮新增行为）。20,000 条时增量约 1.4 MB，占归档树
的 1.7%。

读路径（同一批已提交状态）：

| 历史 | recall A → B | query A → B |
| ---: | ---: | ---: |
| 200 | 1.73 → 1.51 ms（−12.8%，A/A −14.4%） | 0.08 → 0.13 ms |
| 300 | 2.20 → 2.27 ms（+3.4%） | 0.085 → 0.118 ms |
| 400 | 2.71 → 3.86 ms（+42.4%） | 0.082 → 0.129 ms |
| 500 | 3.18 → 3.56 ms（+12.0%） | 0.083 → 0.160 ms |
| 750 | 4.21 → 4.78 ms（+13.5%） | 0.082 → 0.201 ms |
| 1000 | 7.43 → 6.31 ms（−15.1%） | 0.24 → 0.22 ms |
| 5000 | 12.24 → 12.45 ms（+1.7%，A/A −0.7%） | 0.40 → 0.33 ms |
| 20000 | 24.36 → 23.23 ms（−4.6%） | 1.45 → 1.31 ms |

`recall` 是有界的 owner 触发读（最多 2000 条 considered），`query` 只取尾部
50 条；它们在这条负载上都是亚毫秒到几毫秒级。过渡区间里冷行变多会让它们相对
变慢（`recall` 最大 +1.15 ms、`query` 最大 +0.12 ms），但绝对量很小；1000 及以上
时两者中性或更快。

峰值内存（子进程 `maxRSS`，包含夹具解析与迁移，不是稳态上界）：

| 历史 | A | B | 变化 |
| ---: | ---: | ---: | ---: |
| 0 | 80.7 MiB | 80.7 MiB | 0 |
| 1000 | 353.0 MiB | 249.3 MiB | −103.7 MiB |
| 5000 | 523.2 MiB | 526.9 MiB | +3.7 MiB |
| 20000 | 1270.4 MiB | 1302.9 MiB | +32.5 MiB |

20,000 档的峰值由“旧文档 20,000 条热知识 + 首次迁移”决定，两侧都在同一量级；
本轮没有把峰值内存作为收益声称。1000 档的下降来自热区副本、快照与 pending 文档
变小。

## 5. 等价性

每个（规模、轮次）都在三侧之间比较以下**逻辑**状态，全部相等：

- 18 个集合的完整历史：把该集合的活跃档案、全部分段和提交文档里的热记录，按
  `#mergeArchived()` 的顺序与 latest-wins 语义合并后逐字节比较；
- 8 个公开 `query()` 集合的 `count` 与窗口条目；
- `recall()` 的 records、`scanned`、`considered`；
- `autonomousObservations()`；
- 关闭并重新打开后的上述 query / recall / 历史。

两侧的持久化分区（文档热区 vs 归档）按设计不同，因此只报告、不参与相等断言。
观测记录 id 由进程级 UUID 流生成，三侧消耗的 UUID 数量因归档/临时文件数量不同
而不同；比较时把已知 observation id 投影成它在完整历史中的位置，剩余 36 位
UUID 按确定遍历的首次出现编号。除此之外没有任何字段被归一化——知识 key、
dimensions、计数、时间、来源、顺序、`sourceRefs`、`recentEvidence` 都按原字节
比较。A/A-control 在全部规模、全部轮次的**逻辑状态**也都相等，证明上述归一化没有
掩盖噪声。

回归测试另外钉住了：热区不超过 200、完整历史与顺序跨重启保持、冷行更新保持在
原位置且只累计一次、重复身份只保留一行、失败/重启后的累计值不变。既有
`load-projection-equivalence` 的 80 次观测工作负载（81 条 knowledge）仍在
200 以下，因此它与冻结的重建树逐字节相同；测试里的旧源码重建链已加入本轮的
反向 hunk。

## 6. 失败与恢复

`test/domain-storage/knowledge-hot-window.test.mjs` 覆盖：

1. 热区上界 + 完整历史 + 重启顺序；
2. 冷 knowledge 行更新：位置不变、只累计一次、重启后计数不变；
3. 归档淘汰写失败：失败行留在热区、不丢记录、报告 `deferred-write`，下一次
   append 重试并成功淘汰；
4. 冷行更新写失败：整个记录以 `E_ARCHIVE_WRITE_FAILED` 拒绝，累计值与归档字节
   不变；恢复后重试只应用一次；
5. 知识档案尾部损坏：不完整片段进入 quarantine，不被当成记录；
6. 旧文档（1000 条热知识）第一次事务：提交被拒绝时 live 归档树不出现，提交文档
   不动；重试后 1001 条全部可读，热区 200，其余 801 条在本次事务内进入归档；
7. 重复身份：热/冷两种位置都只累计到一行，重启后不变。

通用的事务 pending 安装、部分提交、分段/密封失败、SIGKILL 恢复、跨进程锁与
归档索引一致性由既有套件覆盖；本轮没有改这些路径，完整回归见下文。

## 7. 过渡区间与取舍

把上限从 1000 收到 200 后，`knowledge` 在 200 条左右刚好跨过“没有归档”到
“每次新主体写一次归档”的边界，因此存在一个**窄过渡带**：

- 0–199 条：没有变化（文档字节、写入字节与 sync 次数相同；主表 0 档的差异都在
  A/A 噪声内）。夹具 200 条的那一次新主体写入正好跨过边界。
- 200–450 条：第一次跨级写入多一个归档文件、一次索引对账/fsync，`firstWrite`
  在 200 档 +21.0%（+11.7 ms）、400 档 +8.9%（+6.5 ms）；稳态新主体在 200 档
  +2.9%，400 档已经转为 −15.7%。`coldRepeat` 在 200 档 +10.2%（+5.05 ms），
  因为这一档里被更新的行刚好处在冷区；300 档起转为 −9% 以下。
- 450–500 条起 `firstWrite` 也转正（500 档 −4.2%，750 档 −8.4%），之后随文档
  变大迅速拉开（1000 档 −17.5%，20,000 档稳态 −29% 到 −35%）。

这是本轮唯一明确接受的回退：它只出现在知识行数刚好越过新上限的窄区间，且以
每个事务几毫秒的绝对量换取了 1000 条以上历史约 30%–58% 的稳态墙钟与约 79% 的
后端写入下降。没有用“热区不超过上限 + 允许额外 slack”的方案去摊薄它：那会让
`#hotLimit` 不再等于实际热窗口，而 `#applyReconciliationChanges()` 等路径会
把超出部分直接切片丢弃（不进归档），属于新的数据丢失风险；本轮不引入。

## 8. 复现

```sh
BASE=$(mktemp -d)
git archive 70cb2d3 lib | tar -x -C "$BASE"
ln -s "$PWD/node_modules" "$BASE/node_modules"
printf '{"type":"module"}\n' > "$BASE/package.json"

node --max-old-space-size=4096 scripts/benchmarks/knowledge-hot-window.mjs \
  --sizes 0,200,1000,5000,20000 --rounds 3 --samples 3 \
  --out /tmp/knowledge-hot-window.json

node --max-old-space-size=4096 scripts/benchmarks/knowledge-hot-window.mjs \
  --sizes 300,400,500,750 --rounds 3 --samples 3 \
  --out /tmp/knowledge-hot-window-crossover.json

node --max-old-space-size=4096 scripts/benchmarks/knowledge-hot-window.mjs \
  --sizes 1000,20000 --rounds 1 --samples 1 \
  --out /tmp/knowledge-hot-window-attribution.json

node --max-old-space-size=4096 --test test/domain-storage/knowledge-hot-window.test.mjs
NODE_OPTIONS=--max-old-space-size=4096 npm test
npm run pack:check
```

脚本内部会用 `git archive` 自己解出基线，上面的 `BASE` 只是复现说明；不需要
网络、不需要正式 `DSH_HOME`，所有夹具都在新临时目录，退出时删除。

## 9. 未声称的内容

- 没有把 0–199 条的微小差异当收益；该档字节与事务形状不变。
- 没有声称峰值内存全部下降：20,000 档的旧文档迁移峰值高约 32.5 MiB（+2.6%）。
- 没有声称读路径全部变快：过渡区间的 `recall`/`query` 有绝对量很小的回退，
  见 §4。
- 没有引入合批、后台任务、新的索引/缓存/存储、新的持久字段或新依赖；事务仍然
  逐条提交、逐条可见、逐条失败隔离。
- 没有修改版本号、`release/` 固定产物或任何发布字节。
