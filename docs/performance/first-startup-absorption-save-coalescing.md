# 首次吸收事件日志的 save 合并

## 结果

只合并了 staged domain transaction 中 `measurement-completed` 的重复 transaction persist。`coalesceMeasurementMarkerPersist` 默认为关闭，只有 `domain-storage` 创建带 archive write guard 的 staged replay 工作副本时开启；直接构造的 `EvolutionMemory` 即使同时传 transaction 与 archive guard，也保留原来的两个保存。每条记录仍在原来的 `recordExperiment()` 保存点执行 `assertTransactionSave()`；后续 marker 保存仍执行 housekeeping，但在可证明等价的普通 experiment ID 下跳过第二次 transaction persist。`experimentId === "__proto__"` 时保留第二次 persist 与校验。

基准环境：Node `v26.12.1`、`darwin/arm64`。基线为 `b13fe4cd797ff4f3d9be289b09e20e00469180ea`，其独立 worktree 位于 `/tmp/dsh-base-perf`；候选为该提交加本 worktree 的未提交改动。基线 worktree 使用当前 worktree 的 `node_modules` symlink。每个样本使用全新临时 home、官方 `DomainFacility` 与 `JsonStorageBackend`，通过 `openDomainStorage()` 首次吸收真实签名的事件；启动前没有 replay checkpoint。同一条 fixture 文件按 SHA-256 校验后复制给 A/B 两侧。每点三轮、每侧每轮一个样本，顺序逐轮交替；另在 2,000 条处用同一候选代码跑了三轮 A/A 控制。

`maxRSS` 是 `process.resourceUsage().maxRSS` 的原始值，是整个 worker 进程的高水位。表中保留 Node 返回的数值，不换算单位；它包含启动、fixture 读取和存储后端的峰值，不能单独归因于 replay。

| 记录数 | 墙钟 ms：基线 → 候选（差值） | CPU ms：基线 → 候选（差值） | maxRSS 原值：基线 → 候选（差值） | `assertTransactionSave` 调用：基线 → 候选 | 被 stringify 的 payload 字节：基线 → 候选 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 2,000 | 2,481.4 → 1,881.0（−600.3，−24.2%） | 2,557.6 → 1,955.2（−602.4，−23.6%） | 148,048 → 151,968（+3,920） | 4,000 → 2,000（每条 2 → 1） | 779,170,053 → 389,416,134（−50.02%） |
| 12,000 | 30,174.4 → 19,914.8（−10,259.5，−34.0%） | 31,077.6 → 20,567.8（−10,509.9，−33.8%） | 206,992 → 240,544（+33,552） | 24,000 → 12,000（每条 2 → 1） | 14,495,177,883 → 7,247,238,781（−50.00%） |
| 20,000 | 53,704.3 → 35,667.4（−18,036.9，−33.6%） | 55,142.8 → 36,782.3（−18,360.5，−33.3%） | 331,520 → 312,224（−19,296） | 40,000 → 20,000（每条 2 → 1） | 26,194,588,789 → 13,096,942,139（−50.00%） |

### A/A 噪声对照

2,000 条 A/A 三组墙钟绝对差为 `0.01 / 23.79 / 7.93 ms`，CPU 绝对差为 `0.40 / 20.50 / 8.71 ms`，`maxRSS` 原值绝对差为 `16 / 10,096 / 800`。以下用各项最大 A/A 差作为本次测得噪声上限。

- 三个点的墙钟中位数差分别为 `600.3 / 10,259.5 / 18,036.9 ms`，均超过 A/A 最大值 `23.8 ms`；每轮配对方向也都更快：2,000 条 `−616.0 / −612.1 / −561.5 ms`，12,000 条 `−11,020.1 / −10,259.5 / −9,634.4 ms`，20,000 条 `−17,665.7 / −19,673.7 / −18,036.9 ms`。
- CPU 中位数差分别为 `602.4 / 10,509.9 / 18,360.5 ms`，均超过 A/A 最大值 `20.5 ms`；三个点的每轮配对差也都为负。
- RSS 中位数差分别为 `+3,920 / +33,552 / −19,296`；2,000 条的差值落在 A/A 最大值 `10,096` 内，另外两个点超出该数值，但 A/A 只在 2,000 条运行，不能估计高规模噪声。同轮 RSS 也不是一致下降，因此不据此宣称内存收益。

三轮墙钟与 CPU 配对差均超过本轮 2,000 条 A/A 噪声上限。A/A 控制只在 2,000 条运行，不能估计高规模特有的噪声分布。

## 等价性依据与边界

`measurement-completed` 的调用顺序是 `recordExperiment()`，再追加桥接 marker。第一个保存点保持原样：它完成原有 housekeeping，并在原位置对整个 aggregate 执行 `assertTransactionSave()`。追加 marker 后仍调用 `#save()`，所以原第二次 housekeeping 也保留；只在带 archive write guard 的事务工作副本中跳过第二次 `transaction.persist()`。

该事务工作副本不会逐步发布。`openDomainStorage()` 在所有事件处理完成后，从同一 `EvolutionMemory` 取最终 snapshot，随后用官方 domain schema 写入；因此 marker 仍进入同一最终 durable 文档。skip 条件限于 `measurement-completed`、transaction 工作副本和非 `"__proto__"` experiment ID。

被追加的 marker 只有固定自有字段，值为 event ID、固定 event type、experiment ID 与 ISO 时间字符串。普通 experiment ID 不会令 JSON 文本新增精确的 `"__proto__"` 字面量；如果第一份 payload 本来含该字面量，原校验已在该 payload 上进入递归 strip 路径，marker 也不增加已有深层分支的递归深度。`experimentId === "__proto__"` 的保留分支**经端口当前不可达**：bridge 事件构造的 measurement 记录总会保留源行（`#shouldRetainSource` 在 event 为 null 时返回 true），因此该 id 已经出现在第一次保存的 payload 里，失败由那次保存抛出。独立复审以插桩实测确认：深度 1900、`experimentId="__proto__"` 时 `RangeError` 来自记录保存点，`#markBridgeApplied` 从未执行；移除该 gate 后三个 Node 版本上测试仍全部通过、抛错栈与 durable 字节不变。保留它是为了不让等价性论证依赖 `#shouldRetainSource` 的这条规则，而不是因为当前能观察到差别。

对应测试因此只断言可观察的事实：`experimentId="__proto__"` 的 measurement 仍在发布前以原 `RangeError` 拒绝，durable 文档与 commit token 字节不变、没有 stage manifest；不声称是第几次保存抛出的。

`inlineSerialization` 未改变：它仍只在 updater 同步执行 stringify 并捕获当次 payload 字节时启用。本改动没有改 durable schema、事件格式或 checkpoint 格式。

### 未采用的候选

- `canary-passed` 的 5–6 次保存同时穿插 promotion、strategy、lineage、canonical 与 tombstone 更新。housekeeping 在这些保存点间运行，archive 写入也可能成功、失败或改变冷档案；无法证明中间 payload 的异常和失败顺序等价，因此未合并。
- `#archiveEntries` 每次追加都会更新 active archive 的索引记录（计数、字节、摘要或时间字段），索引文档不是逐次相同的内容。事务内虽未发现读取磁盘索引的调用，但把索引写入延后会改变单次写失败的处理和崩溃窗口，因此未合并。
- 未采用 representability memo/cache，也没有把检查移到最终发布点。

## 复现文件

- [benchmark 脚本](../../scripts/benchmarks/first-startup-absorption.mjs)：`--records`、`--rounds`、`--samples`、交替 A/B、A/A、JSONL ledger 与 JSON 汇总。
- 本次命令：`NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/first-startup-absorption.mjs --records 2000,12000,20000 --rounds 3 --samples 1 --baseline-root /tmp/dsh-base-perf --out docs/performance/first-startup-absorption-save-coalescing.json --ledger docs/performance/first-startup-absorption-save-coalescing.jsonl`。
- [逐样本 ledger](first-startup-absorption-save-coalescing.jsonl)：18 个 A/B 样本和 6 个 A/A 样本。
- [JSON 汇总](first-startup-absorption-save-coalescing.json)：fixture 摘要、全部样本、逐轮配对和噪声统计。
- `npm pack --dry-run --json` 中 benchmark、性能文档和测试 fixture 均未出现在包文件清单内。
