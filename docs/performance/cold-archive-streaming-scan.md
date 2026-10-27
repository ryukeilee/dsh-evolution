# 冷归档首次扫描：按块读取，不再整文件物化

基线 `162855e`（`main`，其上是已完成并验证的"有序键表 + 行窗口"实现）。本轮只改冷归档**读取路径**：
`lib/dockyard-domain/memory.js` 的 `#scanArchiveRead()` 及其同文件内的两条同类扫描（索引重建/活动文件索引），
外加它们在 `domain-storage` 端口上的调用链。不新增持久化文件、不改索引文档字段、不改版本、不改 `release/`
固定产物与宿主兼容范围。原始数据：[`cold-archive-streaming-scan.json`](cold-archive-streaming-scan.json)。

| 改动 | 结论 |
| --- | --- |
| `#scanArchiveRead()` 改为按 1 MiB 块读取、按行折叠，不再 `readFileSync(utf8)` + `split("\n")` | **保留**：80k 峰值 RSS 724.7 → 305.7 MB（−57.8%），200k 1833.3 → 418.0 MB（−77.2%） |
| 扫描不再保留 `allRows`（每个位置一个解析对象），只留最新位置的有界行环，窗口里的洞按定位符补读 | **保留**：200k 冷启动所需 `--max-old-space-size` 从 768 MiB 降到 128 MiB |
| 索引重建扫描（`#scanArchiveRaw()` / `#indexEntryFromRaw()` / `#activeKeysFromRaw()`）改为一遍折叠 `#archiveFacts*` | **保留**：open 阶段 CPU −9.8%（80k）/−15.8%（200k），峰值 RSS 490.1 → 231.9 MB（80k，open only） |
| 追加时的前缀摘要证明（`#extendArchiveReadCache()`）不再读整份活动文件 Buffer | **保留**：分块哈希同一段前缀，长度判定改用读到的字节数 |
| 20k 规模的 open CPU | **持平/轻微回退**：中位数 +9%（约 18 ms），同规模轮间波动 ±10%，不宣称收益也不当作回退 |
| observations 单集合扫描 | **持平**：80k/−0.4% wall，200k/+1.6% wall（+3.7% CPU），在轮间波动内 |
| 把键表移出常驻内存 / 整集合预算 / 新持久化协议 | **不做**：前者已在本目录 `cold-archive-budget-rejected.md` 撤回，后者与本轮目标无关 |

## 1. 瓶颈：不是"扫描本身"，而是两条整文件读取

冷启动在端口上分为两段：`openDomainStorage()`（加载、事件重放、索引重建）与第一次真正读归档的
`port.query()` / `port.observe()`（键表扫描）。用真实官方 `DomainFacility` + `JsonStorageBackend`
路径在 80k + 80k 行（187 MB 归档）上分段测量，基线峰值 724.7 MB 中 **open 阶段单独就占 490.1 MB**：

| 阶段 | 基线峰值 RSS | 基线 open CPU / 扫描 CPU | 读法 |
| --- | ---: | --- | --- |
| open（索引重建） | 490.1 MB | 834.7 ms | `readFile(file,"utf8")` + `split("\n")` + 每行 `JSON.parse` 进 `records` 数组 |
| `query("observations")` | — | 568.6 ms | `readFileSync(file,"utf8")` + `split` + `allRows`（每个位置一个解析对象） |
| `query("knowledge")` | — | 853.1 ms | 同上；行更大（约 1.86 KiB/行），`allRows` 与整文件字符串同时驻留 |

即：两处都是"整文件字符串 + 完整行数组 + 全量解析对象"。`allRows` 在键表化的缓存里已经不再是缓存条目的一部分
（上一轮已改为键表 + 行窗口），但它仍被扫描**构造并保留到扫描结束**——只有 `#readArchiveSync()` 的恢复分支会用到。
基线 80k 规模下一次 knowledge 扫描的瞬时堆里，整文件字符串约 149 MB、`allRows` 约 150 MB。

## 2. 改了什么

### 2.1 一个有界的行遍历器

`#walkArchiveLines(file, hash, onLine)` 以 1 MiB 为单位 `readSync` 读入，用**字节级**换行定位切行：换行字节不可能
出现在多字节 UTF-8 序列内部，所以按块解码得到的文本与"整份解码后 `split("\n")`"逐字符相同；跨块的行把残段留到下一次
读，再由 `Buffer.concat` 补齐（跨块时下一次读的块大小跟着残段增长，避免长行退化成 O(n²) 拷贝）。每个块的完整行文本
**解码一次、摘要一次**，逐行只从这段文本 `slice()`（V8 的 sliced string，不复制）；这与"把整份文件哈希一次"的摘要
字节序列完全相同，因为块边界都落在换行上。

摘要语义没有变：仍然是**解码后文本**的 SHA-256，不是原始字节，无效 UTF-8 文件上的替换字符行为与整文件读一致
（`test/cold-archive-streaming-scan.test.mjs` 用非法字节夹具钉住这一点）。

### 2.2 键表扫描不再构造 `allRows`

`#scanArchiveRead()` 只保留一次扫描的**结果**：有序键表、故障、摘要、行定位符，加上最新位置的有界行环
（沿用上一轮的 2048 行 / 4 MiB 上限）。行环在扫描过程中就按同样两个上限裁剪，所以保留量有界；最终窗口仍然由
`#archiveRowWindow()` 从整张表算出，窗口内扫描没有留住的位置（字节上限导致的前移，或尾部 tombstone 挤掉可见行）
由 `#fillArchiveWindow()` 用定位符补读——读不出就留一个洞，由读者自己的恢复路径处理，绝不在这里拼两次读的结果。

定位符记录的是**文件自己的字节区间**，不是解码后文本的长度：一行若含非法 UTF-8 字节，解码后的文本比原字节长
（一个替换字符三字节），按解码长度记录会读到另一段字节。行环裁剪会把窗口需要的行挤出保留区，所以这一点从
"只影响窗口外的行"变成了窗口内也会走到；本轮按原始字节记录（`#walkArchiveLines` 把每行的原始字节长度一并交出）
并补了回归用例（见 §4 第 4 条）。窗口的字节上限也用同一个原始长度，即按归档实际占用的字节计。

完整历史读（`history`、`fullSnapshot`、restore、retentionPlan、compact 回读）仍走 `#archiveRowsFrom()`：窗口内的行
共享，窗口外的行按定位符从自己的行读回。恢复分支（表格无法从自己的行重现某一行时）改为一次带 `collectRows` 的
扫描，用刚解析出的行回答，不再依赖已被删除的 `allRows`。

行读取失败一半的语义也保持：分块读到的前半部分行**不会**留在表里。`#scanArchiveRead()` 遇到中途读失败就记录该文件的
`unreadable` 故障，并**跳过该文件重扫一次**，于是结果与"整文件读取失败"完全一致（无该文件的行、一条故障），故障仍按
读取顺序出现在原来的位置。

### 2.3 索引重建扫描同样一遍折叠

`#scanArchiveRaw()`（整文件读 + `split` + `records` 数组）与 `#indexEntryFromRaw()` / `#activeKeysFromRaw()`
（各扫一遍 `records`）合并为一个折叠器：`#archiveFacts()` 收集索引条目需要的全部事实（首个/末个记录、键集合、
物理行数、`byteSize`、封存段摘要、`compactedCount` / `loserSummaryCount` / `winnerCount`、活动文件的键集合），
`#foldArchiveFacts()` 逐行更新，`#indexEntryFromFacts()` 由事实生成条目。`byteSize` 仍按**解码后文本**累加
（每行 `Buffer.byteLength(text)` + 换行 1 字节），与原来 `Buffer.byteLength(raw)` 完全相等；摘要仍只在封存段计算。

索引文档的字节没有变：既有的差分
[`archive-index-equivalence.test.js`](../..//test/dockyard-domain/archive-index-equivalence.test.js) 对冻结的
整文件实现逐字节比较索引文档、活动归档、封存段与活动键集合，本轮继续通过，并且"每行只解析一次"的计数不变
（reconcile 23 → 12 parses，compact 4 → 2，与基线同值）。

### 2.4 追加时的前缀证明不再整文件读

`#extendArchiveReadCache()` 在分阶段事务私有化活动文件后，需要证明"同一份字节换了 inode"。原来读整份文件 Buffer
再哈希前缀；现在 `#archivePrefixDigest()` 分块哈希同一段前缀，只读到"期望长度 + 1 字节"为止，长度判定仍来自实际
读到的字节数（不是 stat）。

## 3. 真实端到端 A/B

环境：Node v26.12.1、darwin/arm64、Apple M2、8 逻辑 CPU、16 GiB。机器不是专用空闲环境，每份原始 JSON 记录开始时
的 load average；基准与全量测试没有并行运行。两侧使用同一份夹具**字节**（夹具由 `--build` 在另一个进程里生成，
测量进程只打开端口并读），每条命令一个独立进程，三轮或五轮中两侧顺序逐轮交换，表中为轮内中位数。夹具与真实长期
运行的主机同形：75% 历史在 3 个封存段里，最新 25% 在活动文件里。

`open` = `openDomainStorage()`；`观测扫描` / `知识扫描` = 第一次 `port.query()` 触发的键表扫描；峰值 RSS 是进程
`maxRSS`。**注意**：本表的峰值包含 1 MiB 分块读留下的分配器高水位，它不是"V8 堆"；保留堆（GC 后 `heapUsed` 增量）
与堆上限门槛见 §3.2–§3.3。

### 3.1 三个规模（`--max-old-space-size=4096`，5 / 5 / 3 轮）

| 规模 | 归档字节 | 峰值 RSS | open wall | open CPU | 观测扫描 wall | 知识扫描 wall | 知识扫描 CPU | GC 时间 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 20k + 20k 基线 | 46.7 MB | 279.4 MB | 195.9 ms | 190.1 ms | 120.6 ms | 123.4 ms | 150.6 ms | 8.6 ms |
| 20k + 20k 候选 | 46.7 MB | **228.0 MB**（−18.4%） | 196.4 ms | 208.0 ms（+9.4%） | 120.4 ms | 122.9 ms | 151.7 ms | 8.1 ms |
| 80k + 80k 基线 | 187.2 MB | 724.7 MB | 683.8 ms | 832.2 ms | 471.6 ms | 564.6 ms | 853.1 ms | 57.2 ms |
| 80k + 80k 候选 | 187.2 MB | **305.7 MB**（−57.8%） | 629.6 ms | 750.7 ms（−9.8%） | 469.6 ms | 529.7 ms | 718.0 ms（−15.8%） | 23.8 ms |
| 200k + 200k 基线 | 470.0 MB | 1833.3 MB | 1653.6 ms | 2113.9 ms | 1156.2 ms | 1427.8 ms | 2368.9 ms | 143.3 ms |
| 200k + 200k 候选 | 470.0 MB | **418.0 MB**（−77.2%） | 1475.5 ms | 1779.2 ms（−15.8%） | 1174.9 ms | 1415.7 ms | 2098.5 ms（−11.4%） | 61.4 ms |

open-only（不触发两次键表扫描，只看加载/索引重建的峰值与成本）：

| 规模 | open-only 峰值 | open wall | open CPU | GC 时间 |
| --- | ---: | ---: | ---: | ---: |
| 20k 基线 → 候选 | 194.6 → **179.9 MB**（−7.6%） | 200.2 → 194.6 ms | 205.4 → 206.3 ms | 8.6 → 8.3 ms |
| 80k 基线 → 候选 | 490.1 → **231.9 MB**（−52.7%） | 687.0 → 615.3 ms | 834.7 → 733.5 ms（−12.1%） | 56.0 → 21.8 ms |
| 200k 基线 → 候选 | 1175.7 → **231.5 MB**（−80.3%） | 1674.0 → 1481.4 ms | 2100.7 → 1798.2 ms（−14.4%） | 148.6 → 64.7 ms |

保留堆（一次带知识的写入后 GC 两次的 `heapUsed` 增量）两侧相同：20k 15.9 → 16.0 MiB，80k 44.9 → 44.9 MiB，
200k 98.0 → 98.5 MiB。也就是说**常驻量没有被改动**（键表与行窗口本来就已封顶），本轮改的是扫描期间的瞬时分配；
峰值 RSS 的下降因此必须来自扫描本身，而不是缓存表示的变化。

### 3.2 冷启动需要多少 V8 堆：本轮最直接的证据

同一夹具、同一命令，只改 `--max-old-space-size` 的上限。表里给出"能完成 open + 两次键表扫描"的最小上限：

| 规模 | 基线需要 | 候选需要 |
| --- | ---: | ---: |
| 80k + 80k | 224 MiB 失败，**240 MiB 成功** | 56 MiB 失败，**64 MiB 成功** |
| 200k + 200k | 512 MiB 失败，**768 MiB 成功** | **128 MiB 成功**（更低的 96 MiB 未测到失败边界） |

这条测量把"整文件字符串 + 行数组 + 全量解析对象"从堆里移除的效果与 GC 时机分开：上限足够小时，基线的瞬时对象
放不进堆，进程直接失败；候选在 1/3.75（80k）与 ≤1/6（200k）的堆上限下完成同样的工作。候选的 RSS 下限（约
230 MB / 380 MB）已经不由 V8 堆决定，而是分块读之后的分配器与运行时基线。

### 3.3 扫描里剩下的 CPU 去哪了

80k 规模对**扫描阶段**单独做 V8 CPU profile（`--profile`，只包住两次 `port.query()`）：`JSON.parse` 39.3%、
GC 9.3%、摘要 `update` 8.4%、知识键归一化 `normalizeText` / `identitySerialization` / `knowledgeIdentity` 与相关
正则约 17%、折叠回调（键表/墓碑写入）5.6%、字节读取 2.4%、`#walkArchiveLines` 2.1%。即剩下的都是键表语义本身
要求的每记录工作（解析、`#archiveKey`、规范化知识键、摘要），不再有整文件字符串、行数组与 `allRows` 的分配。
基线同阶段的 GC 占比约 13.4%。

## 4. 语义等价证据

- 新增 `test/cold-archive-streaming-scan.test.mjs`，对**冻结的整文件实现**（`test/fixtures/memory-pre-archive-row-window.js`，
  `raw.split("\n")` 的那一版）做差分，覆盖本轮特有的风险：
  1. **跨块多字节字符**：把一个四字节字符放在第一块结束前 2 字节，且该行本身长于一个块；同时用三条 1.5 MB 的行把
     它挤出保留窗口，于是它只能经定位符读回。行文本、`history`/`historyWindow`/`fullSnapshot`/`archiveIntegrity`/
     索引文档/活动键集合全部与整文件实现逐字段相同。
  2. **非法 UTF-8**：一条含截断多字节序列的行 + 非 ASCII 行写入封存段，断言两侧的解码文本、摘要、`byteSize`、
     `physicalCount`、定位符偏移与故障完全相同；封存段摘要仍等于"解码后文本"的 SHA-256。
  3. **中途读失败**：两块封存段，第一块读到第二块时注入 `EIO`；断言失败文件的行**一条都没留下**、故障文件/路径/
     错误码与整文件读失败一致、另一块封存段的记录仍在，且与整文件实现逐字段相同。
  4. **窗口内被行环挤掉的可见行**（审核 S1 的回归）：一条含 `0x80` 的行 + 一条正常行，后面跟 2049 条墓碑把两条
     可见行挤出保留区，而窗口因为跳过墓碑仍需要它们；断言 `historyWindow` 仍返回这两行（含非法字节那行的解码文本）、
     窗口起点仍为 0，并与整文件实现逐字段相同。该用例在修复前失败（`ValidationError: Cold archive no longer holds a
     cached row`），修复后通过。
- 既有差分继续通过：`archive-index-equivalence.test.js`（索引文档逐字节、活动键集合、每行解析一次）、
  `archive-row-window.test.mjs`（行窗口、摘要、缓存继承与失效）、`observe-cache-handoff.test.mjs`（rc.16 差分）、
  `memory-perf-archive-read-cache.test.mjs`、`review-fix-storage-archive-cache.test.mjs`（等长原地改写不被携带）、
  `retention-plan-equivalence.test.js`、`housekeeping-equivalence.test.js`、`archive-rewrite-batch.test.mjs`。
- 读路径的三个探针从 `readFileSync` 扩到 `openSync`/`readSync`：故障注入点跟随实现改到字节级读，**断言不变**
  （同样的行、同样的故障、同样的路径、同样"只尝试一次"）；字节计数同样把两种读法都算进去。这条改动只动测试的
  注入接缝，不是把断言改松。

## 5. 审核后修正

独立审核（GPT-6.1 Sol，xhigh；请求、返回值与运行证据见
[`docs/evidence/cold-archive-streaming-scan-review.json`](../evidence/cold-archive-streaming-scan-review.json)）。

**S1 [should] 窗口补读破坏非法 UTF-8 的既有语义。** 审核给出可复现场景：含 `0x80` 的 JSON 行、正常行，后面接 2049
条墓碑，行环淘汰两条可见行而最终窗口仍需要它们；定位符用解码长度记录，补读失败留洞，`historyWindow("outcomes", 10)`
在旧实现返回两行、在本轮改动后抛 `ValidationError`。已按最小改动修复：**定位符改为记录文件自己的字节区间**
（`#walkArchiveLines` 把每行的原始字节长度一并交出，扫描按它累加偏移与长度；故障记录里的 `bytes` 仍是解码长度，
不变），并新增上述第 4 条差分回归用例（修复前失败、修复后通过）。没有新增"补读失败再流式扫描"的兜底：把定位符
记录成它唯一能读回的那段字节，比在读者路径上加第二条取行协议更小、更接近根因。

修复后重跑：聚焦 12 个测试文件 114 项全过；80k 端到端复测峰值 RSS 286–306 MB（基线 725 MB）、knowledge 扫描
532–541 ms（基线 575–577 ms），与修复前的候选一致（原始字节长度不改变成本）。

## 6. 已知边界与剩余风险

1. **峰值 RSS 不再由 V8 堆决定。** 候选 200k 规模即使给 128 MiB 堆上限，进程峰值仍约 350 MB：分块读、分配器保留
   与运行时基线构成下限。本轮的收益是"堆里不再放整份历史"，不是"进程只占几百 MB 以下"。
2. **`#readArchiveSync()` 仍按文件整读 Buffer。** `history`/`fullSnapshot`/restore/维护计划需要的完整历史走定位符
   回读，`#archiveRowsFrom()` 为每个文件保留一份 `Buffer`（`readFileSync(file)`）以省掉一次性打开的 syscall。
   这条路径本轮未改：它不在冷启动路径上（端口不调用），改动它会同时改变"每个文件只打开一次"的实现理由。
3. **键表仍随记录数线性增长**（上一轮已记录）：约 200–230 B/记录，200k 行约 98 MiB 保留堆。
4. **观测集合的扫描持平，不是更快**：其行文本小，整文件字符串与 `allRows` 的占比本来就低，剩下的每记录工作
   （`JSON.parse` + 知识键规范化）占主导；200k 上 wall +1.6%、CPU +3.7%，在轮间波动内。
5. **20k 规模的 open CPU 轻微回退**（+9%，约 18 ms）：索引折叠对每行多做一次 `Buffer.byteLength`，而旧实现只有一次
   整文件 `Buffer.byteLength`；40k 行以上该差异被省下的字符串与数组分配抵消（80k −9.8%，200k −15.8%）。
6. **继承校验失配会多读一次文件**：摘要不匹配时扫描重新分块读该文件（旧实现复用已读字符串）。只有"已校验身份下
   字节被改写"的情形会走到这里，那里本来就要整份重新解析。
7. **超长单行**只受"块大小随残段增长、上限 16 MiB"约束；比这更长的单行仍是 O(n) 内存（与整文件读同阶），
   但不会再退化成逐次小块拷贝。
8. **跨进程等长原地改写**仍是既有边界（继承路径用内容摘要兜住），本轮没有放宽也没有收紧。

## 7. 复现

两侧都用 4096 MiB 堆上限，只使用临时数据根：

```sh
# 夹具（只生成一次，两侧读同一份字节）
node --expose-gc scripts/benchmarks/cold-archive-scan.mjs --build --dir /tmp/fx-80k --rows 80000 --knowledge-rows 80000 --json

# 一次测量：open + 两次键表扫描；--skip-scans 只看 open；--profile 只 profile 扫描阶段
node --expose-gc --max-old-space-size=4096 scripts/benchmarks/cold-archive-scan.mjs \
  --measure --dir /tmp/fx-80k --lib /tmp/dsh-scan-base/lib --side base --json
node --expose-gc --max-old-space-size=4096 scripts/benchmarks/cold-archive-scan.mjs \
  --measure --dir /tmp/fx-80k --lib lib --side cand --json

# 堆上限门槛：只改 --max-old-space-size，其余不变
for cap in 56 64 96; do node --expose-gc --max-old-space-size=$cap \
  scripts/benchmarks/cold-archive-scan.mjs --measure --dir /tmp/fx-80k --lib lib --json >/dev/null && echo "$cap ok"; done
```

`/tmp/dsh-scan-base` 是本轮开始时的基线 worktree（`git worktree add /tmp/dsh-scan-base 162855e`，
`node_modules` 指向本树）。夹具的规模与字节数、逐轮样本、堆上限扫描结果与 profile 摘要都在
[`cold-archive-streaming-scan.json`](cold-archive-streaming-scan.json)。
