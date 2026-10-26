# 历史容量回收阻塞与收益上限

本记录用当前源码中的真实 API 复现三个阻塞机制，并测量一组可被 `EvolutionMemory#compact()` 淘汰的历史数据所能释放的字节数。没有改动运行时代码或测试目录，也没有交付自动回收机制。

所有夹具都由脚本创建在 `os.tmpdir()` 下，并在进程结束时递归清理；没有访问用户 home、正式 DSH 数据或网络。结果环境为 Node `v22.23.4`、`darwin/arm64`，每次 Node 调用都带 `--max-old-space-size=4096`。完整实测对象见 [retention-reclaim-blockers.json](./retention-reclaim-blockers.json)。

```sh
/opt/homebrew/opt/node@22/bin/node --max-old-space-size=4096 scripts/benchmarks/retention-reclaim-blockers.mjs --json
/opt/homebrew/opt/node@22/bin/node --max-old-space-size=4096 scripts/benchmarks/retention-reclaim-blockers.mjs --measure --json
```

默认命令运行 R1–R3；`--measure` 追加 R4。报告中的行数与字节数来自脚本对实际文件的计数；耗时来自 `performance.now()`。

## 汇总

| 项目 | 实测结论 |
| --- | --- |
| R1：stage 清单不能表达删除 | 成立：317 段压缩到 2 段，清单列 4 个文件但没有删除项；安装后 315 个旧段仍在 live，重启同时读到 315 条旧源记录与 4 条聚合记录 |
| R2：裁掉一个 applied marker | 成立：200 条可信前缀退化为 0 条可跳过、200 条需逐条处理 |
| R3：截掉 promotion 事实行 | 成立：promotion 时间、gate evidence、runtime recovery 与 durable 元数据丢失；measurement/canary 自身事实仍在 |
| R4：20,000 条失败实验 | 该样本的 compact 前冷档案为 9,961,788 字节、19 段、19,968 行；compact 后为 0 字节、0 段、0 行。耗时中位数 550.304 ms |

## R1：暂存事务不能表达删除，旧段因此复活

### 复现目的

检查真实 `mirrorArchives()`、`changedArchiveFiles()` 与 `installArchiveFiles()` 能否把 `compact()` 对 segment 目录的整目录替换完整发布。

### 最小复现步骤

1. 用测试中的 `JsonStateStore` 和真实 `EvolutionMemory` 装入 320 条低价值 observation，配置 `hotEntries=2`、`archiveMaxBytes=512`，让首次 load 形成大量冷段。
2. 用 `mirrorArchives(live, stage)` 镜像冷档案，在 stage 上创建另一个真实 `EvolutionMemory` 并调用 `compact()`。
3. 对 stage 调用 `changedArchiveFiles(stage, snapshot)`，将新 aggregate state 发布到 live state store，再调用 `installArchiveFiles(stage, live, files)`。
4. 比较安装前后的 live segment 目录与 archive index，然后从 live 重建 `EvolutionMemory`，检查 `history('observations')` 和 `verifyConsistency()`。

### 实测输出

- 初始 history：320 行；live 有 317 个封存段。
- stage compact：317 段变为 2 段；observation 从 320 行变为 4 个聚合行；`retired=0`、`consolidated=636`、`aggregatedObservations=4`。
- stage 移除了 315 个文件名，从 `segment-000000000003.jsonl` 到 `segment-000000000317.jsonl`。
- `changedArchiveFiles()` 只列 4 个文件：索引、active archive、`segment-000000000001.jsonl`、`segment-000000000002.jsonl`。它没有删除项，也没有列出那 315 个消失文件名。
- 安装之后、重启之前，live 仍有 317 段：目录名从 `segment-000000000001.jsonl` 连续到 `segment-000000000317.jsonl`。其中从 `segment-000000000003.jsonl` 到 `segment-000000000317.jsonl` 的 315 段不在新索引里，且就是 stage 已移除的段名。
- 重启后 `history()` 有 319 行：315 个旧 source ID 与 4 个 `AGGREGATED` 行同时可读；重复 ID 数为 0。
- `verifyConsistency()` 返回 `valid=false`、`reasons=["live_durable_memory_projection_mismatch"]`、`archiveValid=true`。它没有报 `duplicate_durable_ids`；此 fixture 下检测到的是 projection mismatch，而不是对“旧源记录和聚合记录语义重复”的专门判定。

### 结论

反例成立。段目录整替换只发生在 stage。提交清单是“存在且已改变的文件”列表，安装器逐项替换清单内文件；缺失的 315 个旧段没有对应的删除记录，所以安装后还留在 live。实际目录读取会看到这些旧段，导致旧 source rows 与 compact 生成的聚合行同时进入重启后的 history。

### 这个反例证明了什么、没有证明什么

它证明当前文件清单不能传递段删除，且当前读取路径确实会重新读到残留段。它没有证明所有 compact 运行都会复活记录，也没有证明 `verifyConsistency()` 会识别这种语义矛盾：本次没有重复 ID，诊断只返回 projection mismatch。复现依赖 compact 真正减少段数；本次通过 320 行、4 个 component 分组与 512 字节段目标得到 317→2 的变化。

## R2：一个 applied marker 的缺失使 checkpoint 不能信任前缀

### 复现目的

用真实 checkpoint API 和 HMAC 签名 envelope 检查 applied marker 表裁剪一项后的重放代价。

### 最小复现步骤

1. 写入 200 条真实 `signEventBridgeEnvelope()` 签名的 event bridge 行，并构造完整 `eventId → MAC` applied 表。
2. 用 `planEventLogReplay()` 处理完整日志，生成 checkpoint document，再通过 `writeEventLogCheckpoint()` 写入、`readEventLogCheckpoint()` 读回。
3. 用完整 applied 表重算；然后只删除一项 marker，再用同一个 checkpoint 重算。

### 实测输出

- 日志：200 条、73,660 字节；checkpoint 记录 200 条。
- 完整 applied 表：`trusted=true`、`prefixRecords=200`、需逐条处理 `0` 条。
- 删除一个 marker（200→199）：`trusted=false`、`prefixRecords=0`、需逐条处理 `200` 条。
- 单次恢复路径因此多做 200 条逐行处理；可跳过的已消费前缀从 200 条降到 0 条。

### 结论

反例成立。checkpoint 保存的是整张 applied 表的 digest；少一个 marker 就使 digest 不匹配，整段已消费日志降级为逐条验证。

### 这个反例证明了什么、没有证明什么

它证明 marker 表与 checkpoint 之间没有按行局部裁剪的可信路径。本次 `recordsToProcess` 计的是逐记录工作量：可信前缀仍会读取并对已消费字节做 keyed digest 校验；`0` 不代表完全不读日志，也不代表没有哈希成本。本次数据说明 200 条日志上的代价，不外推到其他日志规模。

## R3：截掉 promotion 行会失去其独占证据

### 复现目的

用真实 `readEventBridgeEvidence()` 验证 promotion 相关字段是否可从 bridge 重建，以及删除唯一承载行后的字段变化。

### 最小复现步骤

1. 创建含 `measurement-completed`、`promotion-succeeded`、`canary-passed` 的签名日志。
2. 调用 `readEventBridgeEvidence()` 保存基线结果。
3. 从日志删掉唯一的 `promotion-succeeded` 行，保留另外两行，再读取一次并逐字段比较。

### 实测输出

删除 `promotion-succeeded` 行后：

- `promotionTimestamp`：`2026-10-26T00:00:02.000Z` → `null`。
- 顶层 `gateEvidence`：含 `runtimeRecovered/testsPassed/goalPassed` 的对象 → `null`。
- 顶层 `runtimeRecovered`：`true` → `false`。
- `durable` promotion metadata：对象 → `null`。
- `recoveryProof.status`：`recovered` → `unknown`；其 `runtimeRecovered` 为 `true` → `false`，`gateEvidence` 对象 → `null`。
- `recoveryProof.capturedAt` 从 promotion 时间改用仍存在的 canary 行时间 `2026-10-26T00:00:03.000Z`。
- `canary.promotionTimestamp`：从 promotion 行补出的 `2026-10-26T00:00:02.000Z` → `null`；`canary.startupVerified=true` 与 canary observation 保留。
- `latestObservation` 仍是 measurement 行中的 `{latencyMs:14, observed:1}`，总 observation 数仍为 2；`capturedAt` 仍是 canary 行时间。
- `cleanupProof` 删除前后均为 `null`：这是 bridge 本来就不携带的字段，不是本次删行造成的丢失。

### 结论

反例成立。该日志中的门禁证据、promotion 时间和 durable metadata 只有 `promotion-succeeded` 行提供；删掉该行后 reader 不会从 measurement 或 canary 行重新造出这些字段。

### 这个反例证明了什么、没有证明什么

它证明只依赖这份 event bridge 的读取者无法在其唯一事实行被截断后恢复 promotion evidence。它没有证明其他持久来源（例如调用方另行提供的 journal 或 sidecar）也会丢失相同字段，也没有把本来不在 bridge 合同里的 `cleanupProof` 算作截断损失。

## R4：20,000 条冷层实验的收益上限样本

### 复现目的

用真实 `EvolutionMemory#recordExperiment()` 写入约 20,000 条可终结的实验记录，量出 `compact()` 对这一份 synthetic history 能减少的 archive 字节数。完整输入由真实写入路径产生；六次计时只是复制同一份生成结果，不手写 JSONL。

### 最小复现步骤

1. 在临时 home 创建 `EvolutionMemory`，`hotEntries=32`，顺序调用 `recordExperiment()` 20,000 次；每条仅含 synthetic ID、`FAILED` 状态、时间与无凭据的测试 payload。
2. 确认 history 为 20,000 行、冷档案含 19,968 行。
3. 将这份真实写入产生的临时目录复制六份；每份 load 后调用真实 `compact()`，统计所有 collection 的 active archive 与 sealed segments 的字节、段、非空 JSONL 行数。
4. 三轮顺序为 AB、BA、AB；A/B 是同一输入的独立副本，均执行同一 compact 路径，用于交替执行顺序。

### 实测输出

写入 20,000 条耗时 25,613.211 ms。冷层 compact 前有 19,968 条 experiment 行、9,961,788 字节、19 个封存段（另有一个 active archive 文件）。每次 compact 都报告 `retired=20,000`、`consolidated=0`，结束时冷 archive 为 0 字节、0 段、0 行。

| 轮次 | 顺序位 | Compact 前：字节 / 段 / 行 | Compact 后：字节 / 段 / 行 | retired / consolidated | compact 毫秒 |
| --- | --- | --- | --- | --- | ---: |
| 1A | 1 | 9,961,788 / 19 / 19,968 | 0 / 0 / 0 | 20,000 / 0 | 572.093 |
| 1B | 2 | 9,961,788 / 19 / 19,968 | 0 / 0 / 0 | 20,000 / 0 | 553.736 |
| 2B | 1 | 9,961,788 / 19 / 19,968 | 0 / 0 / 0 | 20,000 / 0 | 563.676 |
| 2A | 2 | 9,961,788 / 19 / 19,968 | 0 / 0 / 0 | 20,000 / 0 | 546.873 |
| 3A | 1 | 9,961,788 / 19 / 19,968 | 0 / 0 / 0 | 20,000 / 0 | 543.544 |
| 3B | 2 | 9,961,788 / 19 / 19,968 | 0 / 0 / 0 | 20,000 / 0 | 543.899 |
| 中位数 | — | 9,961,788 / 19 / 19,968 | 0 / 0 / 0 | 20,000 / 0 | 550.304 |

这组数据的净 archive 字节变化中位数是 `-9,961,788`，即本样本最多减少 `9,961,788` 字节。R4 的脚本完整记录每轮数据与分布环境。

### 结论

这是该 synthetic 终态数据的测量上限：当前显式调用 `compact()` 时，该组失败实验记录被判为 retired，冷档案体积降至 0。它不是自动路径当前实际拿到的收益。项目背景中已确认 `maintenance()`、`compact()`、`archiveDiagnostics()` 在 `lib/` 中没有生产调用者；不能把这个样本数字描述成生产回收结果。

### 这个反例证明了什么、没有证明什么

它证明真实写入的这批实验在 compact 判定为 retired 后，冷 archive 最多释放约 9.96 MB，且六次测量都重现了相同字节变化。它没有证明生产历史都能退休，也没有量化保留策略、引用关系、其他 collection、索引/日志、并发事务与进程调度对真实数据的净收益。该数字只适用于这份 synthetic history；本轮没有交付自动回收路径。
