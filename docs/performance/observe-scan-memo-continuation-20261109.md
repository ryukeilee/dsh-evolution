# 高频故障观测：提交后的活动档案不再重解析（2026-11-09）

基线是 `main` 的 `bf38283`。本轮只改两处：

- `lib/dockyard-domain/memory.js`：把本进程事务自己追加到活动档案的索引事实
  精确续算，并在事务提交、安装后的文件身份仍等于写后身份时发布给进程级扫描备忘；
- `lib/domain-storage.js`：在 `installPending()`（或单写提交）成功之后、
  `hydrate()` 之前调用一次发布。

没有改持久化格式、认证、事务边界、fsync 次数、恢复/回滚、跨进程锁或官方宿主
接口；没有新增第二套运行时。直接（非事务）写路径保持发布版行为，索引仍由下一次
加载重扫修偏。

原始逐样本数据：[`observe-scan-memo-continuation-20261109.json`](observe-scan-memo-continuation-20261109.json)。
复现脚本：[`observe-transaction-cost.mjs`](../../scripts/benchmarks/observe-transaction-cost.mjs)
（本轮扩展了 `--compare`，允许基线树与工作树在 `memory.js` 与
`domain-storage.js` 两个测量文件上不同；A1/A2 是同一基线的 A/A 对照）。

## 1. 根因：事务自己的 append 让提交后的 live load 必然 miss

一次高频故障观测会走 `port.observe()` → `mutate()`：先 `mirrorArchives()` 建
硬链接镜像，`createMemory(dir, …)` 加载暂存实例，`work()` 追加并驱逐一行到活动
档案，提交安装，最后 `hydrate()` 加载提交后的 live 实例。

活动档案的扫描备忘（`archiveScanMemo`）按
`(collection, basename, dev, ino) + (size, mtimeNs)` 命中。暂存实例加载时命中的是
**镜像/活树原来的 inode**；写前 `privatizeArchiveFile()` 复制成新 inode，append
再改变 size 与 mtime，安装时 `link+rename` 把同一新 inode 发布到活树。因此：

- 暂存加载：命中备忘（`reconcileActiveArchive.staged` 约 0.04–0.11 ms）；
- 提交后 live 加载：身份已变，备忘必然 miss，**全量读取并逐行解析活动档案**
  （`reconcileActiveArchive.live`），然后再把同一批字节的摘要读证明留给紧随其后的
  `autonomousObservations()`。

基线归因（同一 `observe-transaction-cost.mjs --attribute` 口径）：

| 历史 | live 活动档案重解析 | 观测链中占比 |
| ---: | ---: | ---: |
| 1,000 | 2.8 ms | 6.3% |
| 8,000 | 0.5 ms | 1.0% |
| 20,000 | 10.8 ms | 11.9% |
| 50,000 | 7.4 ms | 5.4% |

成本绑定的是**活动文件字节数**（约 2.2–2.9 ms/MB），不是记录总数：8 MB 轮转目标
下每次事务的活动文件大小在 0–8 MB 之间波动，所以 20k 的 4.66 MB 活动文件反而比
50k 的 3.33 MB 更贵。它同时省略了逐行 JSON 解析产生的大量临时对象，因此 CPU 降幅
大于墙钟降幅。

这不是 #32/#33/#34 的切行/分配/UTF-8 摘要优化，也不是 `observe-transaction-digest-walk`
§4 撤回的“跳过继任读取”：这里仍然保留每一次内容摘要读证明，只去掉**本进程已经
精确折叠过的同一批活动档案字节的重复逐行解析**。

## 2. 改动

### 2.1 精确续算，而不是把增量条目塞进备忘

基线里 `#recordActiveArchiveWrite()` 的增量条目与 fresh scan 之间有 6 类可达偏差
（首行无时间戳、`endedAt` 字段、超限 `EXTERNALIZED`、tombstone、`CANONICAL`、
完整但缺尾换行）。今天提交后的重扫正是这些偏差的纠偏步骤；直接把增量条目发布进
备忘会把偏差固化。因此本轮：

- `#reconcileActiveArchive()` 在 fresh scan 或备忘命中时记录
  `{ identity, parsed }` 基座；
- `#recordActiveArchiveWrite()` 只在“基座身份 == 读缓存最后一份身份，且
  `#extendArchiveReadCache()` 的私有前缀证明/身份相等成立”时，用与
  `#foldArchiveFacts()` 同一套规则续算：
  - `firstTimestamp`/`createdAt` 只在 `parsed === 0` 时取第一条 append 行；
  - `lastTimestamp` 取最后一条 append 行的 `recordedAt ?? observedAt ?? endedAt`；
  - `logicalCount` 只对不在活动键集里的 key 加一；
  - `physicalCount` 加追加行数；
  - `byteSize` 直接取写完后的文件身份 size（包含完整缺尾换行补上的分隔符）；
  - 折叠 `winnerCount` / `loserSummaryCount` / `compactedCount`，并重算
    `retentionClass`。
- 续算失败（缓存缺失、前缀证明不成立、非法 UTF-8 摘要口径不一致、部分写）时退回
  发布版增量条目，并丢弃基座/种子；下一次加载仍全扫修偏。

### 2.2 只在提交后发布，并重新证明 live 身份

暂存实例把精确条目、活动键与 `parsed` 放在实例私有的种子里；
`publishArchiveScanSeeds(liveStateFile)` 在 `mutate()` 的提交点之后调用：

1. 对每个集合 `stat(live)`；
2. 只有 `dev`/`ino`/`size`/`mtimeNs` 与 append 写后身份逐字段相等才
   `rememberArchiveScan()`；
3. 安装回退为 copy（换 inode）、seal/truncate、compaction/rollback、文件不存在
   或 stat 失败都丢弃种子；
4. 方法不抛错；发布失败只退化成下一次全扫。

事务失败、CAS 拒绝、`assertLiveTreeUnchanged` 失败、索引 flush 失败、install 失败
都不会发布。备忘保持进程内、非持久、启动为空；启动/新进程恢复面仍是全扫。

### 2.3 直接写路径与缺尾换行

- 直接（非 staged）Memory 的 append 不发布种子，仍用发布版增量条目；差分锚点
  `observe-cache-handoff` 等不改变。
- 完整但缺尾换行的活动文件先补一个 `\n` 再追加时，缓存身份已变，续算不成立；
  本轮用实例内的一次性分隔符计数把它计入增量条目的 `byteSize`，修掉 D6 的 1 字节
  偏差。

## 3. 等价性

新增 `test/dockyard-domain/archive-scan-memo-continuation.test.js`（14 项）：

- 10 个精确续算形状：空文件、primitive/非法/空白基线、首行无时间戳、
  `endedAt`、`startedAt`、超限 `EXTERNALIZED`、tombstone、`CANONICAL`、
  完整缺尾换行、非法-only 基线。每项把 append 后的内存条目与持久索引 entries
  和“把同一份字节复制到新 inode 后 fresh scan”的实例逐字段比较（忽略
  `updatedAt`）。
- 提交后种子命中：下一次 load 对活动行 **0 次** indexing parse，且条目等于
  fresh scan。
- copy 回退换 inode：不发布，下一次 load 全扫。
- 发布后外部 append：size 改变，下一次 load 全扫并看到外部行。
- seal 后活动文件为空：不为旧身份发布种子。

既有差分与边界全部保持：

```sh
node --max-old-space-size=4096 --test \
  test/dockyard-domain/archive-scan-memo-continuation.test.js \
  test/dockyard-domain/archive-scan-memo.test.js \
  test/dockyard-domain/archive-index-equivalence.test.js \
  test/dockyard-domain/archive-index-write-avoidance.test.js \
  test/dockyard-domain/housekeeping-equivalence.test.js \
  test/observe-cache-handoff.test.mjs \
  test/observe-cache-read-fault.test.mjs \
  test/memory-perf-archive-read-cache.test.mjs \
  test/domain-storage/load-projection-equivalence.test.js \
  test/domain-storage/domain-storage-write-path-equivalence.test.js \
  test/domain-storage/deferred-archive-index.test.mjs \
  test/domain-storage/transaction-archive-batch.test.mjs
```

`load-projection-baseline.js` 与 `domain-storage-baseline.js` 在最早的位置调用
`reverseArchiveScanMemoContinuationRound()`，把本轮改动的每个连续区域逐字节还原到
`bf38283`，再交给既有反向链；`PRE_CHANGE_TREE` 的 SHA-256 守卫仍通过。

## 4. 端到端 A/A 与 A/B

```sh
node --max-old-space-size=4096 --expose-gc \
  scripts/benchmarks/observe-transaction-cost.mjs \
  --compare --baseline bf38283 \
  --histories 1000,8000,20000,50000 --rounds 3 --burst 8 \
  --out docs/performance/observe-scan-memo-continuation-20261109.json
```

每格是 3 轮各自中位数再取中位数；A1/A2 是同一 `bf38283` 基线的两个独立臂
（A/A 噪声），B 是本轮工作树。`chain` 是 `agent/error` 监听链到观察者完成，
`port` 只测 `port.observe()`。环境 Node `v26.13.0` / darwin-arm64 / Apple M2；
测量期间串行，无其它基准或测试。

| 历史 | 形态 | A1 / A2 | B | B 相对 A 均值 | A/A 差 |
| ---: | --- | ---: | ---: | ---: | ---: |
| 20,000 | chain | 95.033 / 96.529 | **81.981** | **−14.4%** | 1.6% |
| 20,000 | port | 76.611 / 76.074 | **65.516** | **−14.2%** | 0.7% |
| 50,000 | chain | 141.277 / 140.641 | **133.380** | **−5.4%** | 0.5% |
| 50,000 | port | 107.810 / 99.517 | **94.288** | **−7.7%**（A/A 8.3%） | 8.3% |
| 8,000 | chain | 52.036 / 51.136 | 50.964 | −1.2%（噪声内） | 1.8% |
| 8,000 | port | 43.939 / 42.093 | 44.792 | +4.2%（噪声内） | 4.2% |
| 1,000 | chain | 45.328 / 45.727 | 40.953 | −10.0% | 0.9% |
| 1,000 | port | 42.148 / 43.481 | 42.351 | −0.9%（噪声内） | 3.1% |

稳定性判断：

- **20,000 是主要可重复证据**：chain 与 port 的 A1/A2 差均 ≤1.6%，B 同时低于
  两个基线臂 13.6–15.5 ms，且 CPU 从 129.6/128.4 ms 降到 91.9 ms（−29.1%）。
- **50,000 chain 方向一致但幅度小**（−5.4%，A/A 0.5%）；port 的 A/A 本身有
  8.3% 波动，不把 port 的 −7.7% 当作稳定结论。
- **8,000 没有收益**：该相位活动文件只有约 164 KB，重解析本来只有约 0.5 ms。
- **1,000 port 没有收益**，chain 的 −10.0% 只有 4.4 ms，A/A 0.9%，但
  port 同期无收益，方向不一致，不作为交付收益。
- 每次事务仍保留两次继任内容证明（每步 2× 冷档案字节的读取+SHA-256）与约
  27–30 ms 的持久提交固定成本；本轮没有碰它们。

CPU（chain / port 中位数，ms）：

| 历史 | chain A 均 | chain B | port A 均 | port B |
| ---: | ---: | ---: | ---: | ---: |
| 20,000 | 129.607 | **91.942** | 68.262 | **49.652** |
| 50,000 | 247.042 | 241.703 | 159.035 | 147.712 |
| 8,000 | 48.814 | 47.981 | 25.967 | 25.242 |
| 1,000 | 34.785 | 31.402 | 20.565 | 17.506 |

内存：`sample()` 在窗口两端各 GC 一次后读 `heapUsed`，是窗口内的保留差分，不是
峰值。20,000 chain 的 A1/A2 为 1.200/1.158 MiB、B 为 1.204 MiB（无额外保留）；
50,000 chain 的 A 为 −0.054/−0.089 MiB、B 为 **+1.181 MiB**。该差值来自备忘保留的
活动档案条目与键集，量级与既有的 0.7 MiB/万活动键备忘一致；本轮没有测峰值 RSS、
GC 时间线或 32 条备忘满负荷。

## 5. 收益边界与残余风险

- 收益只来自“提交后 live 加载对**活动**档案的逐行 facts 重解析”，因此随活动文件
  字节数增长，不随 sealed 段数增长；sealed 段本来只做 `byteSize` 早退。
- 暂存实例、启动/新进程、直接 Memory 写路径、sealed 段、pending 恢复安装都不使用
  本轮种子；内容摘要读证明与 `#reconcileArchiveIndex()` 的 `changed`、sealed
  size/digest 早退、`assertLiveTreeUnchanged` 均未弱化。
- 已知残余（与既有备忘同源）：同 inode、同 size、用 `utimes` 恢复 mtime 的外部
  原地改写，备忘无法与“字节没变”区分。`history()` 的内容由
  `archiveReadCache` 的摘要证明兜底；索引文档不会因此重算。粗 mtime 文件系统、
  非 APFS、强制 inode 复用未实测。
- 发布后的种子在进程内最多保留 32 条（LRU）；inode 复用面由“只在提交后发布 +
  发布前 stat live”收窄，但没有消除。
- 直接写路径仍可能先落一份与 fresh scan 有 D1–D6 偏差的索引，再由下一次加载修偏；
  本轮只修了 staged 提交路径与缺尾换行的 1 字节，不声称直接路径的瞬时文档等价。

## 6. 验证

本轮实际执行（结果见交付说明与提交记录）：

```sh
NODE_OPTIONS=--max-old-space-size=4096 npm test
npm run pack:check
npm run acceptance:host -- --host <每个 peerDependencies 宿主> --out <隔离证据路径>
```

官方宿主验收使用隔离 runtime/home，不触碰正式 `DSH_HOME`；`release/`、版本号与
发布产物未改动。
