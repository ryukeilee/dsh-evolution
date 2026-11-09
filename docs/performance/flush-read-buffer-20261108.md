# 高频 flush 的临时读取缓冲区：1 MiB → 64 KiB

基线为 2026-11-08 通过 `git fetch origin main` 和 GitHub branches API 双重核实的最新 main：
`c2c8d2e2d8abf986ee14b360a842a72f999ddae7`。本轮生产改动只有
`lib/event-log-checkpoint.js` 的 `READ_CHUNK_BYTES` 常量，不改变格式、认证覆盖、事务、恢复、
显式 reclaim 或宿主依赖，没有新增缓存、后台任务或自动删除。

原始样本：[主测量](flush-read-buffer-20261108.json)；
复现脚本：[flush-read-buffer.mjs](../../scripts/benchmarks/flush-read-buffer.mjs)。
两侧均为真实官方 `DomainFacility` / `JsonStorageBackend`（均 `0.2.0-rc.2`）。
环境 Node v26.13.0、darwin/arm64；堆上限 4096 MiB。临时数据根从零创建，不访问正式用户数据。

## 为什么选这一处

真实调用链为 `registration.js` 的 `agent/pre-step` 与工具 wrapper → `domainStorage.flush()`
→ 串行 `replay()` → `planEventLogReplay()`。有新事件时还进入官方领域事务、暂存归档、
完整持久化与 checkpoint 发布；无新事件时不提交事务，但每次仍重新认证整个已消费前缀及标记表。

已读的历史证据包括 `domain-flush-steady-cost.md`、`domain-flush-history-cost.md`、
`domain-flush-ledger-cost.md`、`event-log-replay-memory.md`、`redundant-work.md` 及相关回归。
历史中的重复前缀哈希、ledger entries 分配和事务 clone 已优化；摘要/文本缓存、按对象身份
跳过校验、手工 ledger 合并、首次重放惰性分行等方向已有撤回证据，不重复引入。
工作区原有的文本缓存实验文件与另一条分支的 archive digest walk 改动不纳入本 PR。

本轮现有 main 上的归因（只在独立插桩轮计时，单位 ms/稳态 flush）：

| 历史数 | 基线读取 + 前缀认证 | 完整 applied JSON + 摘要 | 候选读取 + 前缀认证 |
| ---: | ---: | ---: | ---: |
| 200 | 0.095 | 0.046 | 0.088 |
| 2,000 | 0.609 | 0.475 | 0.569 |
| 20,000 | 5.660 | 5.142 | 5.742 |

最大剩余热点仍是完整前缀认证与完整标记表序列化，二者均随历史增长。本轮不减少它们的认证工作量，
而是减少同一认证循环每次必分配的外部内存：不论日志大小，每趟原先都分配一个新的 1 MiB Buffer。
高频无写入调用会持续产生这个分配和 GC/分配器压力，64 KiB 临时缓冲区无需任何跨调用状态。

## 测量设计和口径

- 主测量：200 / 2,000 / 20,000 条历史 × 0 / 1 条新事件；每格 5 轮，每轮 A1/A2/B
  独立子进程、独立临时根，各 40 次 flush，预热 3 次，顺序每轮轮换。A1/A2 是完全相同的基线。
- 连续运行：2,000 条起点，0 / 1 新事件/flush，各 3 轮 A1/A2/B，每个进程同一端口连续 600 次。
  总计主测量 3,600 次、连续测量 10,800 次 flush，另有独立插桩、归因、故障与重启核对。
- 历史 fixture 是真实签名日志 + 完整已提交标记表，初始 aggregate 为空；有新事件的样本正常
  经官方事务增大 aggregate，连续写入组产生非空冷档案。它不能代表已有巨大冷档案树的所有生产负载。
- `wallMs` 为真实 `performance.now()` 包住 flush，CPU 为同一区间 `process.cpuUsage()` 的 user+system，
  累计值为各次 flush 的和。签名和追加、fixture 初始化、重启核对、内存采样均在这些区间外。
  这测的是端口 flush 端到端成本，不是整次 agent 工具或应用的总 CPU。
- fixture 的 DTO 时钟每次递增 1 ms，使持久化可对拍；性能计时不使用这个时钟。采样期不强制 GC，
  前后各一次 GC。每次 flush 结束采样内存，`measuredMaxRSS` 是这些样本及起点的最大值，
  **不是 flush 内部的瞬时峰值**。`processMaxRSS` 是完整子进程高水位，包含初始化和重启。
- I/O 和 Buffer 分配计数另起 trace 进程（每格 3 次），不把插桩后的速度混入 clean 测量。
  `logBytesRead` 是该 fixture 同步读取计数；`calls` 同时记录系统调用、官方文档替换及 `FileHandle.sync()`。
- 下表 A 为 A1/A2 轮结果合并后的中位数，B 为候选各轮中位数；每轮 `wallMs`/`cpuMs`
  为 40 个样本的上中位数，合并时偶数项使用中间两项均值。所有逐次原始值及轮换顺序均在 JSON。

校准中发现并修正过一次夹具不对称：最初候选额外加载基线签名模块，影响约 1 MiB 的模块内存。
该批中止数据未进入本报告；最终夹具使每个子进程的 signer、domain 和 orchestrator 都来自自己的源码根。

## 主测量

| 历史 / 新事件 | flush wall A → B (ms) | CPU A → B (ms) | 40 次累计 CPU A → B (ms) | 采样期 RSS 高值 A → B (MiB) |
| --- | ---: | ---: | ---: | ---: |
| 200 / 0 | 0.168 → 0.155 | 0.179 → 0.157 | 15.056 → 8.943 | 40.817 → 36.645 |
| 200 / 1 | 14.273 → 15.967 | 5.746 → 5.767 | 233.146 → 236.656 | 46.818 → 46.115 |
| 2,000 / 0 | 1.094 → 1.041 | 1.104 → 1.050 | 53.353 → 45.502 | 98.641 → 60.695 |
| 2,000 / 1 | 15.653 → 15.277 | 8.465 → 8.369 | 359.269 → 350.697 | 83.557 → 78.213 |
| 20,000 / 0 | 10.660 → 10.685 | 10.677 → 10.701 | 430.019 → 430.752 | 215.058 → 204.425 |
| 20,000 / 1 | 57.714 → 57.644 | 50.275 → 50.150 | 2131.675 → 2093.358 | 242.485 → 246.085 |

20,000 条稳态 wall 名义变化 +0.24%，A/A 每轮绝对差最大 0.072 ms，候选相对合并基线差
0.025 ms，不能判定为回退；20,000 条写入的速度差也在 A/A 内。200 / 2,000 条无新事件的
累计 CPU 降幅分别约 40.6% / 14.7%，但 40 次短区间的 CPU 结果受 GC 分布影响，应优先读下节连续运行。
200 条写入 wall 的原始轮次存在约 12 / 17 ms 两档漂移：名义中位数 +11.9%，对应 1.694 ms，
A/A 最大差 4.540 ms。不能据此宣布没有回退，故专门追加独立的 9 轮复测（下文）。

## 同一端口连续运行

| 每次新事件 | 600 次累计 wall A → B (ms) | 累计 CPU A → B (ms) | 采样期 RSS 高值 A → B (MiB) | 完整进程高水位 A → B (MiB) |
| --- | ---: | ---: | ---: | ---: |
| 0 | 642.592 → 596.249 | 755.542 → 609.116 | 136.799 → 60.351 | 167.469 → 93.672 |
| 1 | 26512.268 → 26577.854 | 15855.523 → 15781.462 | 140.265 → 136.295 | 168.391 → 164.641 |

无新事件的累计 wall −7.21%、CPU −19.38%、采样期 RSS 高值 −55.88%。三轮 A1/A2 的累计
CPU 为 753.437–773.965 ms，B 为 600.638–609.255 ms；每轮 A/A 差最大 17.844 ms，
每轮 B 相对该轮 A1/A2 均值的降低均超过 145 ms。RSS 的 A/A 差最大 0.375 MiB，
B 三轮 60.320–60.867 MiB，A 全部在 136.307–136.947 MiB，远超测量噪声。

持续写入组累计 wall +0.25%、CPU −0.47%，不能声称有速度收益。RSS 名义下降 2.83%，
A/A 差最大 3.548 MiB，B 相对合并基线约少 3.970 MiB，证据不足以推广为稳定的写入内存收益。
这组写入在预热及 600 次采样后有 2,603 个标记，日志从 1,279,572 增至 1,666,698 字节，
官方文档从 263,078 增至 548,341 字节，并有非空实验档案及其索引（2 个归档树文件）；A/A/B 的完整归一化文档摘要、
checkpoint 和档案哈希均一致。

历史增长仍会增加事务和归档成本：持续写入首轮的前 60 次与末 60 次 wall 中位数，
A1 15.850 → 48.918 ms，B 15.754 → 48.464 ms。候选没有改变这一增长曲线。
无新事件连续组 GC 后 heapUsed 的中位数约 A 11.467 MiB、B 12.643 MiB，候选并非所有内存指标都下降；
该项未形成线性增长证据，不能把 RSS 收益解释为 heapUsed 也同比下降。样本没有证明生产数日运行不泄漏。

## I/O、分配与完整性

每次 flush 临时 `Buffer.allocUnsafe` 字节 **1,048,576 → 65,536（−93.75%）**，每次仍分配一次。
它不减少落盘字节，也不减少读/认证字节；本轮只改变每次读的块大小。

| 历史数 / 无新事件 | 每次同步读取字节（两侧相同） | readSync A → B | 文档提交 / sync（两侧相同） |
| ---: | ---: | ---: | ---: |
| 200 | 127,168 | 2 → 3 | 0 / 0 |
| 2,000 | 1,279,572 | 3 → 21 | 0 / 0 |
| 20,000 | 12,875,576 | 14 → 198 | 0 / 0 |

有新事件时，三档每次均为 1 次官方文档替换 + 2 次 `FileHandle.sync()`，双方相同；
全部系统调用计数和摘要输入字节保留于原始 JSON。20k 时读取调用从 14 增至 198 是明确的代价，
本机墙钟与总 CPU 没有测出显著回退；其它文件系统、网络盘与平台不在结论范围内。

新差分回归覆盖 64 KiB 与原 1 MiB 两侧的 ±1 字节边界、完整/撕裂尾、无效 checkpoint、
701 字节短读、第二次 read 抛出 EIO 及 descriptor 关闭；全部 plan 字段及新 checkpoint 字节
与旧读块实现一致。基准故障组同时核对篡改前缀拒绝、checkpoint 丢失、官方句柄替换/原地回退
标记表、未终止记录及重启，无分歧。完整连续写入组另外核对非空档案与持久化结果。

## 复现

```sh
node --max-old-space-size=4096 scripts/benchmarks/flush-read-buffer.mjs \
  --rounds 5 --samples 40 --continuous 600 \
  --out /tmp/flush-read-buffer.json
node --max-old-space-size=4096 scripts/benchmarks/flush-read-buffer.mjs \
  --histories 200 --events 1 --rounds 9 --samples 60 \
  --out /tmp/flush-read-buffer-200-write-repeat.json
```

脚本从固定提交提取源码和已提交 fixture，在临时副本中只修改读块常量；不依赖工作区原有实验改动。
生产文件 SHA-256 必须等于主测量的 `sourceSHA256.candidate`：
`4ee025a658518acc374dfb7c466c3ffa9a7b9c75b8ad4a439424b947ba44f951`，本轮已实际核对。
原始测量后，在复现脚本末尾补上连续组持久化与非空档案断言；同样的断言已对本次完整 JSON 独立执行通过。

## 追加复测和交付验证

200 条写入的追加复测：[原始 9 轮 × 60 样本 A/A/B](flush-read-buffer-200-write-repeat-20261108.json)。
单次 wall 中位数 A 11.940 ms、B 12.494 ms（+4.64%），每轮 A/A 最大差 0.861 ms；
B 相对每轮 A1/A2 均值有 7 轮上升、2 轮下降，不能将其认定为稳定的速度改善，也不能排除小幅
单次中位数回退。但 60 次累计 wall A 1,054.220 ms、B 1,054.265 ms（+0.004%），
累计 CPU A 544.081 ms、B 543.956 ms（−0.023%）；配对 A/A 的累计 wall 最大差 65.178 ms、
累计 CPU 最大差 21.426 ms，累计指标没有显著回退。单次中位数与累计结果不同，反映同步等待
的长尾分布，不能挑其中一个指标宣称写入更快。本轮保留的收益只由连续无新事件组承担。

实际验证（已执行门禁）：

- 相关聚焦测试 65 项通过，含新差分 2 项。
- 首次全量 1,455 项通过、2 项跳过，唯一失败是 `release-pin` 拒绝未提交分发改动；提交后重新验证。
- 默认打包目录已有其他版本，脚本拒绝覆盖；改用全新的 `/tmp/dsh-evolution-flush-buffer-20261108`
  成功构建，未改写既有 `dist/` 或 `release/`。
- 提交后全量重新执行：1,456 项通过、2 项跳过、0 失败（本地工作区包含原有未提交的 4 项 serializer 回归，不纳入本 PR）。
- `npm run pack:check` 全部检查通过；本树是固定发布产物的已提交开发后继，不等于发布固定点。
- 17 项 `pack:check` 检查通过；开发后继与发布固定点的区别已由脚本明确报告。
- 四个声明支持的官方宿主均在全新隔离 runtime/home 中完成安装、诊断、工具生命周期、卸载重装、
  升级回滚与晋升重启验证：
  [0.2.0-rc.2](../evidence/flush-read-buffer-20261108-host-0.2.0-rc.2.json)、
  [0.2.1-alpha.1](../evidence/flush-read-buffer-20261108-host-0.2.1-alpha.1.json)、
  [0.2.1-rc.2](../evidence/flush-read-buffer-20261108-host-0.2.1-rc.2.json)、
  [0.2.2-rc.1](../evidence/flush-read-buffer-20261108-host-0.2.2-rc.1.json)。
  共同 tarball SHA-256 为 `88b9aeb11c694440f3f98d0f631e268a4c872b2f60df9cbfe5f5df82c3e7b182`，
  内容摘要为 `7f1730f0035f5a1e21c22deeb5e012a204ecb069fa65d95f59614b7277e69937`。
- 独立 sol-loop 审核 1 轮，GPT-6.1 Sol，APPROVE，无 blocker/should，ledger 为空。
  请求、返回及 Reviewer 自述的运行时证据均为 codex / gpt-6.1-sol / xhigh；未返回 usage，不估算。
  审核覆盖 `c2c8d2e → bd866d1`；额外独立执行 39 项定向测试和 24 个读取中追加差分场景，
  重算全部 135 组、16,020 个逐次样本，核验持久化、四宿主证据与 tarball 的 51 个分发条目。
  无需代码修正；审核后只补记本段，不改变行为或测量。

验证命令（均已实际运行，首次全量的未提交门禁失败和后续重跑分开记录）：

```sh
node --max-old-space-size=4096 --test test/domain-storage/checkpoint-read-chunks.test.js \
  test/domain-storage/checkpoint-keyed-digest.test.js test/domain-storage/event-log-checkpoint.test.js \
  test/domain-storage/replay-batch-commit.test.js test/domain-storage/transaction-commit-shape.test.js \
  test/domain-storage/storage.test.js test/domain-storage/domain-storage-write-path-equivalence.test.js \
  test/retention-log-floor.test.mjs test/domain-storage/marker-table-special-keys.test.js
NODE_OPTIONS=--max-old-space-size=4096 npm test
npm run pack:check
npm run release:pack -- --dist /tmp/dsh-evolution-flush-buffer-20261108
# 分别取上述四个宿主版本：
NODE_OPTIONS=--max-old-space-size=4096 node scripts/acceptance/run-host-acceptance.mjs \
  --host <version> --tarball /tmp/dsh-evolution-flush-buffer-20261108/dsh-evolution-0.2.1.tgz \
  --out <evidence-path>
```

## 收益边界

收益主要是高频、无新事件、日志约 0.1–1.3 MB 的重复 flush 的外部分配压力；不是把历史增长变为 O(1)。
20k 条、写入主导或大归档事务不承诺速度收益。完整日志认证、标记去重、并发冲突、恢复及 reclaim
仍走原路径；不修改 retention floor、持久化格式或授权要求。没有测冷页缓存、不同平台/Node 主版本、
网络文件系统或生产数日连续运行，不能把本机百分比推广到它们。本次不更新 release 固定点或发布。
