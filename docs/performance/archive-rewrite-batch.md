# `#rewriteArchives()` 批量写入：配对 A/B 证据

## 结果

基于 `956031d36c7eb558d1b6b2c504a7d0ffac753884` 的基线，将每条冷记录的临时文件 `appendFile()` 改为按现有归档段边界批量 `writeFile()`。本轮实际归档 **384、3,072、12,288 条冷记录**；`compact()` 与 `finalizeKnowledge()` 在每种规模上各做 5 轮交替配对。30 对样本的 wall 与进程 CPU 时间全部下降。

| 冷记录 | 操作 | wall ms：基线 → 候选 | 变化 | CPU ms：基线 → 候选 | 变化 | Node 文件 API 调用：基线 → 候选 |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 384 | `compact()` | 22.24 → 9.28 | −58.3% | 24.27 → 10.82 | −55.4% | 387 → 6 |
| 384 | `finalizeKnowledge()` | 22.27 → 9.15 | −58.9% | 24.09 → 9.60 | −60.1% | 387 → 6 |
| 3,072 | `compact()` | 130.68 → 30.80 | −76.4% | 147.25 → 41.69 | −71.7% | 3,075 → 6 |
| 3,072 | `finalizeKnowledge()` | 132.60 → 30.72 | −76.8% | 144.01 → 39.50 | −72.6% | 3,075 → 6 |
| 12,288 | `compact()` | 516.55 → 102.57 | −80.1% | 574.36 → 140.70 | −75.5% | 12,291 → 6 |
| 12,288 | `finalizeKnowledge()` | 526.98 → 102.41 | −80.6% | 609.31 → 132.13 | −78.3% | 12,291 → 6 |

API 列分别统计 `fs.promises.appendFile()` 与 `fs.promises.writeFile()` 对 `.compact-` 临时路径的调用总数。它们是 **Node 文件 API 调用计数**，不是内核 syscall 计数；本轮不采集或推断内核 syscall。CPU 为 `process.cpuUsage()` 的用户态与系统态增量，统计整个 Node 进程，可能因文件 I/O 线程池而高于 wall 时间。

## 等价性与故障覆盖

基准每轮在相同临时 home 路径重建独立 fixture，按 A/B、B/A 交替顺序运行；proposal fixture 额外预置 15 条，以抵消 housekeeping 的固定移除量。脚本在每次计时后断言实际归档行数精确等于目标值。候选与基线逐轮比较完整 `snapshot()` 与 `fullSnapshot()`、公开返回值、home 全文件树摘要、每个归档段的路径/字节数/摘要，以及第二次重复调用的结果、完整状态、段清单与文件树。原始配对时延、进程 CPU、API 调用、摘要与段清单保存在 [`archive-rewrite-batch.json`](archive-rewrite-batch.json)。

生产默认段上限下，这三个负载没有触发段轮转；另有一组相同冷行数的 32 KiB 段压力 A/B，实际生成 3、31、129 个段，并逐对比较段清单与字节。其证据见 [`archive-rewrite-batch-segment-stress.json`](archive-rewrite-batch-segment-stress.json)，用于覆盖实际轮转边界，不作为生产默认配置下的耗时数据。

故障注入分别覆盖两条公开操作：

- 临时文件数据写入前抛出 `EIO`：原有持久文件与内存状态保持一致；两侧都保留一个空 `.compact-*.tmp`。
- 文件 API 写入 37 字节前缀后抛出 `EIO`：原有持久文件与内存状态保持一致；两侧遗留的临时文件前缀摘要相同。当前实现没有清理尚未登记进 `staged` 的临时文件，本轮保留并验证该既有行为。
- state 保存失败：事务回滚恢复状态与归档文件；两侧均清除事务临时文件。新建 `EvolutionMemory` 实例重新读取后，各集合记录与完整状态一致。

这些是隔离临时 home 上的异常与重新打开验证，不模拟断电或进程被强杀。

## 方法与范围

基线源码从指定 git commit 读取；候选直接加载当前工作树 `memory.js`。计时覆盖单次公开 `compact()` 或非重复 `finalizeKnowledge()` 调用的端到端 wall/CPU 时间；夹具装载、摘要计算和重复调用不计入端点。每个端点的数据 API 计数在公开调用返回后立即截取。

运行环境：Node `v26.12.1`、`darwin/arm64`；`payloadBytes=256`，`archiveMaxBytes=8 MiB`、`absoluteMaxSegmentBytes=16 MiB` 与生产默认一致。为精确构造指定冷行数，合成夹具使用每个 collection 16 条热记录、`maxEntries=10,000`；覆盖 observations、proposals、cycles 三个归档集合。结果验证本机合成负载的端到端收益，不代表全部生产数据分布或宿主运行时性能。

复现命令：

```sh
BENCH_BASE_COMMIT=956031d36c7eb558d1b6b2c504a7d0ffac753884 \
BENCH_COLD_ROWS=384,3072,12288 BENCH_ROUNDS=5 \
BENCH_OUT=docs/performance/archive-rewrite-batch.json \
NODE_OPTIONS=--max-old-space-size=4096 \
node --expose-gc scripts/benchmarks/archive-rewrite-batch.mjs
```

段边界压力复现时，在同一命令中增加 `BENCH_ARCHIVE_MAX_BYTES=32768`、`BENCH_ABSOLUTE_MAX_SEGMENT_BYTES=2097152`，并把 `BENCH_OUT` 改为 `docs/performance/archive-rewrite-batch-segment-stress.json`。
