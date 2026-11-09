# 高频故障观测：内容证明的成本与摘要专用走行的收益（2026-11-07）

基线是 `origin/main` 的 `c2c8d2e2d8abf986ee14b360a842a72f999ddae7`（工作开始与结束都 fetch 核对，
远端未移动）。本轮只改一处：`#walkArchiveLines()` 在没有行消费者时不再把已经哈希过的字节重新切成行。
它保留全部读取、摘要输入与读取故障行为，因此继任实例仍然亲自观察 EACCES/EIO、仍以内容摘要证明继任解析。
本轮没有改持久化格式、事务边界、事件顺序、授权或依赖。

原始数据：

- [`observe-transaction-digest-walk-20261107.compare.json`](observe-transaction-digest-walk-20261107.compare.json)：A / A-control / B，3 个历史档 × 2 种形态 × 5 轮 × 3 臂共 90 个样本的逐次 wall/CPU/I/O 计数与内存窗口差分；
- [`observe-transaction-digest-walk-20261107.attribution.json`](observe-transaction-digest-walk-20261107.attribution.json)：阶段归因（改动前的基线口径）；
- [`observe-transaction-digest-walk-20261107.counterexample.json`](observe-transaction-digest-walk-20261107.counterexample.json)：更大候选为何不可交付。

脚本：[`observe-transaction-cost.mjs`](../../scripts/benchmarks/observe-transaction-cost.mjs)。

## 1. 调用链与测量方法

宿主两个独立 emit 监听器（`agent/error`、`tools/result`）→ `orchestrator.observeAutonomous()` →
`domainStorage.observe()` → `enqueue()` → `mutate()` → `hydrate()`，随后 `observeAutonomous()` 读
`autonomousObservations()` 的已提交证据。观测触发归档时，一次事务会：镜像归档树、加载暂存 Memory、
`store.record()`（追加、逐出到活动档案、归档索引）、落 pending 记录、校验并安装 staged 文件、落最终文档、
再加载 live Memory。新实例第一次读档案时，`#archiveRead()` 的继任分支会读取全部档案文件、计算内容摘要并与
前驱解析比较，一致才复用解析（`test/observe-cache-read-fault.test.mjs` 钉住了这一读取故障边界）。

测量使用真实官方 `DomainFacility` + `JsonStorageBackend`，每个样本一份从同一夹具复制出的独立临时根。
历史夹具由真实路径先写一条观测取得真实行形状（约 1.07 KB/行），再按同一形状合成，并由一次真实加载完成
归档、索引与段轮转；不是真实用户数据根。历史档为 1,000 / 8,000 / 20,000 条；`chain` 从 `agent/error`
监听器起测到观察者完成，`port` 只测 `port.observe()`，单发与连续 16 次都测。`--compare` 的三臂是：
A1/A-control 由 `--baseline` 重建（默认 `c2c8d2e`），B 是本工作树；脚本断言两树只在
`lib/dockyard-domain/memory.js` 上不同。每轮按不同排列轮换启动顺序（`armOrder()` 先按轮次轮转、再按奇偶反转；实际顺序是 A1→A2→B、A1→B→A2、B→A1→A2、B→A2→A1、A2→B→A1，不是每个臂各领跑一次后才重复），
先做 2 次不计时预热，内存窗口从预热之后开始。A/A-control 的差异用于显示噪声；**不声称统计显著性**。

环境：Node `v26.13.0`、darwin/arm64、8 逻辑 CPU、16 GiB；测量开始/结束时 load average
`1.80 1.36 1.27`（机器不是专用空闲环境）。归因在无并行任务的时段采集：各阶段是 10 步总耗时除以
步数（平均值），`autonomousObservations` 那一列是 10 次首次读取耗时的中位数。

## 2. 成本归因（改动前基线，单次 `port.observe()`）

| 阶段 | 1,000 条 | 8,000 条 | 20,000 条 |
| --- | ---: | ---: | ---: |
| `mutate` 合计 | 44.57 | 46.56 | 83.46 |
| 两次实例级内容证明（`memory.inheritedReads`，两次/步） | 1.93 | 13.62 | 32.51 |
| 其中：staged 实例的 `#sourceMatches` 读 | 1.02 | 7.10 | 16.71 |
| 其中：新 live 实例的 `autonomousObservations` 读 | 1.20 | 7.42 | 18.07 |
| `pendingSet` + `installPending.finalSet`（两次领域写） | 7.80 + 7.29 | 8.31 + 6.63 | 8.09 + 7.14 |
| `syncStage`（staged 文件与目录 fsync） | 8.63 | 6.15 | 6.72 |
| `installPending.installFiles`（校验并安装 staged 文件） | 5.13 | 5.42 | 7.58 |
| `mutate.work`（追加、逐出、归档、索引） | 4.82 | 12.10 | 31.22 |
| 其中：`archiveEntries`（整体：私有化、追加、缓存扩展、索引） | 2.33 | 2.76 | 10.94 |
| `hydrate.createMemory`（新 live 实例加载） | 4.60 | 1.84 | 11.60 |
| 其中：活动档案重扫（`reconcileActiveScan`） | 2.88 | 0.44 | 10.10 |
| 其余（镜像、变更摘要、manifest、隔离校验、索引写） | ≤ 3.0 | ≤ 3.0 | ≤ 5.0 |

读法：

1. **唯一随历史线性增长、且单次收益最大的部分是每个实例都要重新读一遍整个冷档案。** `mutate()` 的
   staged Memory 与 `hydrate()` 的 live Memory 各付一次内容证明，20,000 条时合计 32.5 ms（约 33%）。
   这是恢复/隔离契约（每个继任实例亲自观察读取故障并证明字节）；跳过它的候选见 §4。
2. **持久化边界是固定成本。** 每次观测触发归档要落两次领域文档、追加活动档案、写归档索引，并对 staged
   文件/目录与安装目录分别 fsync。I/O 计数固定为每个 `port.observe()` **5 次 `fsyncSync` + 4 次后端
   `handle.sync`**，后端文档写入 272–274 KB（pending 记录同时承载已提交与新 `aggregate`/`applied`）。
   含 fsync 的四个阶段（`pendingSet` + `finalSet` + `syncStage` + `installFiles`）在 1,000 档合计
   **28.85 ms**、20,000 档合计 **29.53 ms**；这些阶段还包含序列化、校验与文件读取，所以它是这些阶段
   的上界，不是 fsync 的独占计时，本轮也没有单独计时单次 fsync。
3. `archiveEntries` 是整体计时：活动档案私有化与追加、为并发读保留前驱视图的解析缓存扩展、以及索引写都在
   里面。本轮没有把它们分别计时，因此不据此估算任何单项收益。
4. 序列化与结构校验（`installPending.parse` 约 0.6 ms、聚合投影、`structuredClone`）在有大型事件 marker
   表时才会显著；本夹具没有 marker，20,000 条观测时它们仍小于 2 ms。

## 3. 接受的改动：摘要专用走行不再切行

`#archiveFileDigest()` 只要求哈希，不消费行：`#walkArchiveLines(file, hash, null)`。改动前它仍把每个
已哈希的块切成行，为每行计算行号、`slice` 与 `Buffer.byteLength`（或 `buffer.indexOf` 的原始字节边界），
而 `onLine` 是 `null`，这些值无人读取。改动只在 `onLine` 存在时执行切行循环；`buffer.toString`、哈希输入、
读取分块、`carry`/未终止尾行以及所有读取异常路径不变。

一个块内的哈希输入本来就是“整段已解码文本”，切行不会改变它；因此**摘要、继任解析的采用/重扫判定、
返回行与故障报告都不变**。新增回归
[`archive-digest-walk.test.mjs`](../../test/dockyard-domain/archive-digest-walk.test.mjs) 用非 UTF-8
字节、超过一个扫描分块的长行和未终止尾行断言：继任实例必须复用前驱的摘要表（而不是因摘要不同回退重扫），
并返回同一组行。既有 `test/observe-cache-read-fault.test.mjs`、`test/observe-cache-handoff.test.mjs`
继续覆盖继任读取故障与差异等价。

### 交替 A / A-control / B

每格是 5 轮的轮中位数再取中位数（A 列给出 A1/A-control 两个同源基线臂）。单位 ms，括号内为 B 相对两个
基线臂均值的 wall 变化。

| 历史 | 形态 | A1 / A-control | B | wall | CPU（A 均 / B） |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1,000 | chain | 45.05 / 45.01 | 45.40 | +0.8% | 35.37 / 35.56 |
| 1,000 | port | 41.52 / 42.27 | 40.87 | −2.4% | 20.24 / 19.73 |
| 8,000 | chain | 53.72 / 54.70 | 51.85 | −4.4% | 51.74 / 49.65 |
| 8,000 | port | 45.82 / 46.67 | 45.14 | −2.4% | 29.29 / 28.14 |
| 20,000 | chain | 101.39 / 101.20 | 95.14 | −6.1% | 147.29 / 141.72 |
| 20,000 | port | 81.76 / 80.89 | 78.65 | −3.3% | 105.75 / 102.78 |

逐轮方向用于判断可重复性：8,000 档 chain 的 5 轮全部为负（−1.5% … −7.5%），20,000 档 chain 的 5 轮
全部为负（−5.2% … −6.8%）。汇总中位数上 A1 与 A-control 相差 0.1%（1,000）、1.8%（8,000）、
0.2%（20,000），但逐轮比较的 A/A 差异更大（chain 最多 4.91% / 3.29% / 1.97%，port 最多
5.98% / 7.07% / 3.16%）。因此 **20,000 档是主要可重复证据**（B 的 −5.2% … −6.8% 超出该档 chain 的
1.97% 逐轮 A/A 差异，且五轮同向）；8,000 档的 −4.4% 方向一致但只略高于 3.29% 的逐轮 A/A 差异，
按方向性结果看待。1,000 档 chain 方向混合（−2.7% … +6.4%），因为该档内容证明只有约 1.9 ms；
**不宣称 1,000 档有收益**。port 形态的逐轮噪声更大（20,000 档有一轮 +5.1%），因此收益以 chain 与
CPU 的一致方向为准，不把任何单个样本当结论。

内存窗口差分（预热与测量后各 GC 一次，heapUsed/RSS 差值）在 8,000/20,000 档为负，说明窗口内已有对象被
回收；它不是峰值或泄漏判定，也不能推出稳定内存收益。收益边界：只来自“每个实例的内容证明”里被哈希过
却没人消费的切行工作，因此随冷档案字节数增长、随该证明占比变化；1,000 条、活动段很小或没有归档时
没有可测收益。单机、单进程、合成真实行形状；wall 受本机 fsync 延迟影响，不外推 p99。

## 4. 撤回的更大候选：跳过继任读取

最诱人的方向是让 live 实例直接采用 staged 实例已证明的解析，不再亲自读取档案。20,000 条时省去第二次
内容证明约 18.2 ms（约 18%），两端都省约 32.6 ms。它不成立：既有回归
[`test/observe-cache-read-fault.test.mjs`](../../test/observe-cache-read-fault.test.mjs) 要求继任实例
亲自观察一次新的读取故障（EACCES/EIO）、报告故障、并且只返回可证明的完整行。`--counterexample` 在不改动
仓库的前提下物化该候选并复现同一次注入：

| 实现 | 读取尝试次数 | 返回行 | 报告故障 |
| --- | ---: | --- | --- |
| 现行实现 | 1 | `cold-0` | `EACCES` |
| 撤回候选 | 0 | `cold-0`, `cold-1` | — |

候选不是“更快地得到同一答案”，而是不再观察读取失败，并会返回一次失败读取本不该确认的行。同一契约的
另一条回归（`a successor observes changed bytes even when the full file identity is restored`）
还要求继任实例能在 inode/size/mtime 被恢复后看到内容变化。因此这个方向需要新的“同一进程内已证明”信任
握手协议并重新论证恢复/隔离语义，不属于最小改动，本轮撤回。

其余方向没有达到“收益覆盖复杂度”的门槛，也没有单独计时，因此只能作为边界记录：安装阶段复用同一
staged 文件的摘要（该阶段只按整体计时，20,000 条时 7.58 ms，其中读取/哈希与目录 fsync 没有分别测量，
因此给不出可省收益，不据此提出候选）；
进程内追加后延续活动档案扫描备忘（最多约 10 ms，但既有回归要求“增长过的文件必须重扫”，需要新的续证协议）；
避免解析缓存扩展的整表复制（前驱视图必须继续服务并发读，去复制要引入结构共享）；校验快速路径（只在
事件 marker 表很大时明显，改的是持久化校验契约）；调整观测热窗口（PR #28 的同类方案，且会把更多 1 KB
行放进每次事务要写两次的领域文档）。

## 5. 验证

- `NODE_OPTIONS=--max-old-space-size=4096 npm test`：1,457 项，1,455 通过，2 跳过，0 失败。
- 新增 `test/dockyard-domain/archive-digest-walk.test.mjs`：摘要专用走行必须复现扫描摘要并返回同一组行。
- 既有 `test/observe-cache-read-fault.test.mjs`、`test/observe-cache-handoff.test.mjs`、
  `test/domain-storage/observe-transaction-boundaries.test.mjs`。
- `npm run pack:check`：开发阶段 17 项检查全部通过；工作树是固定发布内容的开发后继。
- 官方宿主验收：由 PR 的 CI 矩阵执行（分发内容变化，需要真实宿主安装）。
- `--counterexample`：现行实现 1 次读取尝试并报告 `EACCES`；撤回候选 0 次、多返回一行。

复现：

```sh
node --max-old-space-size=4096 --expose-gc scripts/benchmarks/observe-transaction-cost.mjs \
  --compare --histories 1000,8000,20000 --rounds 5 --burst 16 \
  --out docs/performance/observe-transaction-digest-walk-20261107.compare.json
node --max-old-space-size=4096 scripts/benchmarks/observe-transaction-cost.mjs \
  --attribute --attribute-baseline c2c8d2e2d8abf986ee14b360a842a72f999ddae7 \
  --histories 1000,8000,20000 --steps 10 \
  --out docs/performance/observe-transaction-digest-walk-20261107.attribution.json
node --max-old-space-size=4096 scripts/benchmarks/observe-transaction-cost.mjs \
  --counterexample --out docs/performance/observe-transaction-digest-walk-20261107.counterexample.json
```
