# 事件同步：一次读取只哈希一遍日志前缀

基线为本轮开始前的 `main` 提交 `f469d57`（已核实）。本轮只删一处**同一次调用里
对同一段字节重复做的哈希**，不改持久化格式、认证强度、标记表判定、事务、恢复与
锁语义，也没有修改官方 DSH 源码；没有新增缓存，没有新增持久字段。

原始数据见 [`domain-flush-history-cost.json`](domain-flush-history-cost.json)，复现
脚本见 [`scripts/benchmarks/domain-flush-history-cost.mjs`](../../scripts/benchmarks/domain-flush-history-cost.mjs)。
环境：Node `v26.12.1` / `darwin/arm64`，8 逻辑 CPU；三轮开始/结束的 load average
为 `1.41/1.64/1.94` → `1.74/1.71/1.96`。

同一轮还量过标记表合并（`mergeEventLedger()`）里的一次全表复制，**已撤回**，
反例与代价见 §9。

## 1. 路径

`domainStorage.flush()` 在 `agent/pre-step` 与每个 Evolution 工具结束时被调用，
两次都进入 `replay()`。这条路径有两种形状：

| 形状 | 频率 | 本轮是否触及 |
| --- | --- | --- |
| 无新事件（稳态） | 每步骤 / 每次工具结束 | 否：只读日志、认证已消费前缀、核对标记摘要，不写任何东西，两侧一致（§6 第 7 行） |
| 有新事件（积压） | 一次工具调用可连发 2–3 条记录；两步骤之间观察者写入；停机期间的追加在下次启动集中到来 | 是：一次 `mutate()` 事务 |

## 2. 归因（真实调用栈）

本节的数据有三个来源，结论只由第一个承担：

- **A/B 样本**（§5 的表格、每轮数值、机制计数）：脚本产出，原始数据在本文件的同名
  JSON 里，逐样本可复算；
- **CPU profile 表**：一次性探针，命令见下，原始 `.cpuprofile`（几十 MB 的二进制）
  不入库；它用来说明“删掉的到底是哪一帧”，量级与 A/B 的 CPU 差一致；
- **直接对拍**（§6 的三种日志长度）：一次性探针，同一 buffer、同一 key，比较
  “两实例实现”与“分叉实现”各自的耗时，用来划收益边界。

在一次 `flush()` 上开 V8 CPU profile
（`--profile baseline|candidate --profile-scenario history-20000-new-1`）：profiler
只在测量样本循环内开启，fixture 构建与历史签名都在区间之外；区间内仍包含每个样本
对新事件的一次签名与追加（1 条记录、约 330 B），两侧相同。6 个样本、20000 条历史、
1 条新事件、日志 12.76 MB。下表是**每次 flush** 的自耗时，取每帧最近的 `lib/`
调用者：

| 帧 | 基线 `f469d57` | 优化后 | 变化 |
| --- | ---: | ---: | ---: |
| `readEventLog()` 交给 SHA-256/HMAC 的字节 | 9.30 ms | 4.99 ms | **−4.31 ms** |
| `mergeEventLedger()`（未改动） | 7.78 ms | 7.53 ms | 噪声 |
| `digestApplied()` ×2（`checkpointAuthenticates` + `eventLogCheckpointDocument`） | 8.52 ms | 8.52 ms | 0 |
| `sameEventLedger()` | 3.00 ms | 2.95 ms | 噪声 |
| `replay()` 的 `commit()`（`{ ...applied }` + 本组标记） | 4.27 ms | 3.64 ms | 噪声 |
| `mutate()` 自耗（含提交基线 `{ ...recovered }`） | 4.02 ms | 3.48 ms | 噪声 |
| `lib/index.js` 的 `serialize()`（JSON 后端的整份文档） | 4.28 ms | 3.45 ms | 噪声 |
| zod `inst._zod.parse` | 7.78 ms | 5.11 ms | 噪声（归因在 `zod` 与匿名 `preprocess` 帧之间漂移） |
| 6 次 flush 的 profile 总量（含约 4 ms/次的 profiler 开销） | 419.3 ms | 378.6 ms | −9.7% |

单帧在两次 profile 之间的漂移可达 ±2 ms，因此只把被删除的那一帧当作结论：它解释
每次 flush 约 4.3 ms，与 A/B 的 CPU 差（−4.7 ms）一致，其余帧在两轮之间都在噪声里。

机制计数（同一脚本的插桩轮，每次 `flush()`，20000 条历史 + 1 条新事件）：

| 每次 `flush()` | 基线 | 优化后 |
| --- | ---: | ---: |
| 喂给 SHA-256/HMAC 的字节 | 29.05 MiB | **16.88 MiB** |
| 其中读日志字节 | 12.17 MiB | 12.17 MiB |
| 整份文档写入（`official` 单元 rename） | 1 | 1 |
| 文档写入的 `FileHandle.sync()`（文件 + 目录） | 2 | 2 |
| `readSync` | 14 | 14 |
| 全部被计数的系统调用 | 完全相同 | 完全相同 |

（`fsyncSync` 在这个路径上是 0：本路径的文档写入由官方 JSON 后端通过它打开的
文件句柄落盘，因此插桩数的是 `official/sync`，不是 `fsyncSync`。稳态 pass 两者
都是 0。）

**为什么这一处是冗余，而不是边界**：一次推进检查点的 pass 需要两个摘要——已消费
前缀的摘要（用来认证本次开始时的检查点）和当前整份日志的摘要（写进本次的检查
点）。两者是**嵌套**字节区间，旧实现为每个摘要各建一个 `crypto.createHmac()` 并
各自更新一遍，于是 `[0, consumed)` 被哈希两次，即日志增长时每次 pass 哈希
`2 × consumed` 字节（§2 表中 29.05 MiB − 16.88 MiB = 12.17 MiB，正好一份日志）。
认证的东西没有减少：仍然读完整份日志、仍然验证已消费前缀的 keyed digest、仍然为
整份日志生成 keyed digest。

## 3. 改动：前缀摘要从同一遍读取里分叉（`lib/event-log-checkpoint.js`）

`crypto.createHmac()` 的状态不可复制，`crypto.createHash()` 可以。HMAC(K, m) =
H((K ^ opad) ‖ H((K ^ ipad) ‖ m))，因此新增 `createEventLogKeyedDigest(key)`，用
`createHash` 复用同一套填充：读取循环把已消费那段喂进同一个实例，在
`consumed` 边界用 `fork()`（`state.copy()`）取出前缀摘要，再继续喂后续字节得到整份
摘要。**一次读取、一遍哈希、两个摘要。**

- 摘要值与 `crypto.createHmac('sha256', key)` **逐字节相同**：填充、64 字节块长、
  key 的 utf8 编码、以及“超过一个块的 key 先哈希”这三步与 OpenSSL 相同。测试
  `test/domain-storage/checkpoint-keyed-digest.test.js` 在 key 长度 {1, 63, 64, 65,
  200, 多字节, Buffer} × 消息长度 {0, 1, 63, 64, 65, 4096, 1 MiB, 1 MiB+7} 上逐个
  比对，并且分块喂入（1 B … 整块）也一致；分叉语义单独测（分叉点在 0、块边界、
  末尾，同一实例多次分叉）。
- **两种实现并存**：整份读取（`consumed <= 0`，即没有检查点或检查点被拒绝后回退）
  仍然走 `digestEventLogPrefix()` → `crypto.createHmac`，只有“日志增长”的路径用
  分叉。两者算的是同一个值。交叉验证只发生在“全量读取 → 分叉推进”和“分叉回退 →
  全量读取”这两种切换上（第一个检查点由 `createHmac` 写下、下一次增长由分叉读出
  来验证，此后两边都是分叉实现），等价性主要由测试钉住。
- 拒绝语义不变：分叉点没到达（日志被截断）时，报出的前缀摘要覆盖实际存在的
  字节，与旧实现一致，`checkpointAuthenticates()` 仍然拒绝它；日志增长时
  `boundaryDigest` 覆盖 `[0, offset)`，`stat.size === consumed` 时仍按旧规则置
  `null`（不推进）；读取过程中才到达的字节仍然不进入摘要、也不推进检查点。
- 检查点 MAC、witness、`appliedDigest`、文件身份、`advance` 的换行条件全部照旧。

## 4. 等价性

同一 fixture、冻结时钟（`2026-11-03T00:00:00.000Z`）+ 确定性 UUID 序列，两侧跑同一
workload，逐字节比较：

- `official/evolution_domain.json`（整份持久文档，含 `applied` 标记表）**相同**；
- `event-log.checkpoint.json` 的内容字段（`bytes` / `records` / `digest` /
  `writer` / `first` / `last` / `appliedDigest`）**相同**——其中 `digest` 就是本轮
  重新计算的摘要；`file.dev` / `file.ino` / `mac` 由 fixture 自身的日志文件身份
  决定，按构造每次运行不同，故不参与比较（脚本仍断言 `file` 身份存在）；
- `dockyard/` 归档树逐文件 sha256 **相同**。这一轮等价性 pass 会先种一个非空的活动
  归档（24 行 observations），所以比较的是“种下的归档文件 + 派生索引”两个文件，
  而不是两个空目录（脚本断言条目数 ≥ 2）；
- 9 个场景（200/2000/20000 条历史 × 0/1/3 条新事件）全部成立；
- 每个场景同时断言：事务结束后 `domain-staging/` 为空、**重启
  （`openDomainStorage()` 内部的启动 replay）不改写持久文档、也不推进检查点**、
  重启后的 `flush()` 返回 `{applied: 0, duplicates: N}`、`applied` 标记数等于
  “历史 + 已提交的新记录”。重启断言比较的是重启前后的文档与检查点字节：启动
  replay 在 `openDomainStorage()` 里就执行完了，只看重启后的返回值无法证明它没做
  事（注入“重启前删掉一个持久标记”后该断言实测失败）。

仓库既有的差分锚点保持不变：
`test/domain-storage/domain-storage-write-path-equivalence.test.js`（对
`release/dsh-evolution-0.2.0-rc.8.tgz` 的 rc.8 实现逐条差分，含“真实端口提交
字节相同”）通过；`lib/domain-storage.js` 与 `test/domain-storage/domain-storage-baseline.js`
与本轮基线 `f469d57` 逐字节相同（`domain-flush-history-cost.json` 的 `sources`
里两者 sha256 一致）。

另外对 `readEventLog()` 单独做过一次不随仓库提交的差分：把旧实现拷进一份模块副本，
对 20 种日志/检查点状态（无检查点、MAC/摘要/writer/文件身份/字节数/记录数被改、
前缀内改一个字节、日志增长一条、增长一条+残行、检查点落在记录中间、日志被截断、
日志变短为空、日志被等长替换、空检查点增长）逐一比较
`plan.{trusted, prefixRecords, lines, remainder, completeRecords, next, advance, bytes}`，
全部相同；“`stat.size === consumed` 但读取过程中又到达一条记录”这一状态用
`fs.readSync` 钩子单独比对，也相同（该状态现已作为回归用例入库）。

## 5. 可复现 A/B

```sh
NODE_OPTIONS=--max-old-space-size=4096 node \
  scripts/benchmarks/domain-flush-history-cost.mjs --rounds 3 --samples 9 --warmup 3
```

脚本用 `git show f469d57:` 把 `lib/event-log-checkpoint.js`（与 `lib/domain-storage.js`，
本轮它没有差异）还原进一份 `lib/` 副本作为基线，并断言基线含旧形状、不含新形状，
反之亦然——两侧不会悄悄变成同一份代码；两侧在同一进程、同一 fixture 上交替先跑，
三轮；每轮每侧先跑一次干净测量（墙钟/CPU），再跑一次插桩测量（系统调用与摘要
字节）。真实官方 `DomainFacility` + `JsonStorageBackend`；历史是已签名的日志 +
已提交的 `applied` 标记表，aggregate 从空开始（本轮不碰 aggregate，空 aggregate 让
这条边界在数字里可见）。

每侧每场景 3 轮、每轮 9 个样本，取“轮内中位数的中位数”：

| 场景 | 墙钟 基线 → 优化 | 变化 | CPU 基线 → 优化 | 变化 | 摘要字节/次 | 各轮墙钟差 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 200 条、0 新 | 0.17 → 0.17 ms | +3.9% | 0.17 → 0.18 ms | +10.8% | 0.14 → 0.14 MiB | 0.00 / 0.00 / +0.02 |
| 200 条、1 新 | 11.48 → 11.77 ms | +2.5% | 4.86 → 4.78 ms | −1.5% | 0.30 → 0.18 MiB | −1.15 / −0.10 / +2.24 |
| 200 条、3 新 | 12.49 → 11.89 ms | −4.8% | 5.68 → 5.30 ms | −6.8% | 0.32 → 0.19 MiB | −1.46 / −1.46 / +0.11 |
| 2000 条、0 新 | 1.05 → 1.05 ms | +0.4% | 1.05 → 1.05 ms | +0.4% | 1.44 → 1.44 MiB | −0.10 / +0.01 / 0.00 |
| 2000 条、1 新 | 14.51 → 14.59 ms | +0.6% | 7.71 → 7.49 ms | −2.8% | 2.90 → 1.69 MiB | −0.03 / −0.64 / +0.44 |
| 2000 条、3 新 | 15.60 → 13.86 ms | −11.2% | 8.31 → 7.84 ms | **−5.7%** | 2.92 → 1.70 MiB | −1.74 / −0.06 / −1.06 |
| 20000 条、0 新 | 10.65 → 10.65 ms | 0.0% | 10.65 → 10.65 ms | 0.0% | 14.52 → 14.52 MiB | +0.05 / −0.02 / −0.05 |
| 20000 条、1 新 | 62.97 → 57.80 ms | **−8.2%** | 55.17 → 50.45 ms | **−8.6%** | 29.05 → 16.88 MiB | −5.74 / −5.12 / −4.32 |
| 20000 条、3 新 | 63.74 → 58.00 ms | **−9.0%** | 55.77 → 51.00 ms | **−8.5%** | 29.08 → 16.90 MiB | −5.78 / −5.29 / −4.84 |

- **稳定结论在 20000 条**：墙钟各轮 `63.3 / 63.0 / 62.1` 对 `57.6 / 57.8 / 57.8` ms
  （burst 场景 `63.7 / 64.0 / 62.8` 对 `58.0 / 58.7 / 58.0`），三轮区间不重叠；
  CPU 同样不重叠（`55.18 / 55.38 / 55.07` 对 `50.46 / 50.68 / 50.41` ms；burst
  `55.69 / 55.85 / 55.77` 对 `50.95 / 51.00 / 51.05`）。
- **2000 条也成立，但只有 CPU 可判**：burst 的 CPU `8.44 / 8.21 / 8.31` 对
  `7.84 / 7.75 / 7.95` ms，`1 新` 的 CPU `7.71 / 7.70 / 7.75` 对
  `7.49 / 7.03 / 7.54` ms，两组区间都不重叠（后者的基线最小值 7.700 高于优化后
  最大值 7.539）。墙钟在这个规模被每次事务的 2 次 `FileHandle.sync()`（本机约
  1.3 ms/次）与整份文档写入主导：`1 新` 的三轮墙钟差 `−0.03 / −0.64 / +0.44` ms
  方向不一致。
- **200 条不声称收益，也不声称回归**：日志 126 KB，两实例实现与分叉实现的直接
  对拍是 0.098 ms 对 0.054 ms（每次 flush 省 0.04 ms），而一次 flush 约 11–12 ms
  墙钟、syscall 时间占大头。`200 条、1 新` 三轮墙钟差 `−1.15 / −0.10 / +2.24` ms
  方向不一致；`200 条、3 新` 方向一致但区间重叠。
- **稳态（0 条新事件）两侧相同**，这是本轮的设计边界：日志没有增长时本来就只有
  一遍哈希。差值 `+0.05 / −0.02 / −0.05` ms 是噪声。

系统调用、整份文档写入次数在两轮之间**完全相同**（§2 机制计数表）：本轮删的是
CPU 与一次整份日志的摘要计算，不是 I/O。

## 6. 收益边界

- 收益**与日志字节线性相关**：每次有新事件的 pass 少哈希一份日志。可复算的结论是
  A/B 的 CPU 差 **4.72 ms**/次 flush（§5，20000 条、1 新，原始样本在 JSON）；
  profile 的 4.31 ms 帧差只用来解释这 4.72 ms 落在哪一帧。
  一次性对拍（同一 buffer、同一 key，仅用于说明线性）给出：123 KiB 时两实例
  0.098 ms、分叉 0.054 ms；1.24 MiB 时 0.948 对 0.485 ms；12.46 MiB 时 9.52 对
  4.75 ms。
- 没有新事件的 pass 没有收益；空日志或首次（无检查点）读取没有收益，那一遍本来就
  只哈希一次。
- 本轮没有降低 I/O：`FileHandle.sync()` 次数、整份文档写入次数、读日志字节都不变。
  因此在一个 `sync` 更便宜、或文档更大的宿主上，百分比会与本机不同。
- 没有测量冷页缓存、网络文件系统、其它平台、多进程竞争，也没有测量生产规模的
  aggregate（本基准的 aggregate 是空的）：文档写入与 zod 校验那部分成本在本轮
  数字里偏低，但它们本轮没有被改动。
- `digestApplied()`（每次 pass 两次：认证旧检查点、写新检查点）仍是 O(历史)，占
  20k 场景约 8.5 ms/次 flush，本轮未优化（§9）。`mergeEventLedger()` 仍占约
  7.8 ms/次 flush，本轮尝试过并撤回（§9）。
- 本轮**未单独测量**分配量与 maxRSS，因此不声称内存指标下降。

## 7. 验证

```sh
NODE_OPTIONS=--max-old-space-size=4096 node --test \
  test/domain-storage/checkpoint-keyed-digest.test.js \
  test/domain-storage/event-log-checkpoint.test.js \
  test/domain-storage/replay-batch-commit.test.js \
  test/domain-storage/transaction-commit-shape.test.js \
  test/domain-storage/storage.test.js \
  test/domain-storage/domain-storage-write-path-equivalence.test.js
NODE_OPTIONS=--max-old-space-size=4096 npm test
```

新增 7 项回归（`test/domain-storage/checkpoint-keyed-digest.test.js`）：

1. `createEventLogKeyedDigest()` 在 key 长度 {1, 63, 64, 65, 200, 多字节, Buffer} ×
   消息长度 {0, 1, 63, 64, 65, 4096, 1 MiB, 1 MiB+7} 上与
   `crypto.createHmac('sha256', key)` 逐字节相同；
2. 同一份消息按 1 B / 63 B / 64 B / 65 B / 4 KiB / 100 KB / 整块分块喂入，摘要相同；
3. 分叉取出的前缀摘要等于该前缀的独立 HMAC，且分叉不改变原实例（含同一实例两次
   分叉、分叉点在 0 与末尾）；
4. `digestEventLogPrefix()` 仍然等于前缀的原生 HMAC（整份读取路径没有被替换）；
5. 真实端口：整份读取写下的检查点被“日志增长”路径以分叉摘要认证通过
   （`plan.trusted === true`），增长后写下的检查点 `digest` 等于整份日志字节的原生
   HMAC，稳态 pass 复用它；
6. 消耗前缀内改一个字节（长度不变）仍然使检查点不被信任，且整份日志被交回逐条验证；
7. 读取过程中才追加的记录不推进检查点（`advance: false`、`next.digest: null`），该
   记录被交回逐条验证，并被下一次真实 pass 恰好应用一次。

既有覆盖（未改，全部通过）：重复事件、同 ID 不同 MAC、端口存活期间经官方句柄回退
标记表（替换对象与原地改写两种形态）、跨重启回退、事务失败注入（介质替换后目录
`fsync` 失败）、并发修改（`E_COMMIT_OVERWRITTEN`）、跨重启恢复与最终持久化、
组大于 4096 条标记窗口时的同端口重试。`domain-storage-write-path-equivalence.test.js`
对 rc.8 的差分锚点全部保持。

本轮本机全量：**688 项全部通过**（`NODE_OPTIONS=--max-old-space-size=4096 npm test`）。
`release/` 产物、`release/manifest.json`、版本号与历史发布记录均未改动：
`npm run release:verify` 仍报固定产物 `d0c119f0…` / content `fb4e77b5…` 与 manifest
一致；`npm run pack:check` 在提交后判定本树是固定发布产物的开发后继（与固定产物
不同的分发文件是本轮的 `lib/event-log-checkpoint.js`，以及此前几轮已提交的
`lib/domain-storage.js`、`lib/archive-stage.js`、`lib/dockyard-domain/memory.js`）。

## 8. 本轮排除的方向

| 候选 | 结论 | 依据 |
| --- | --- | --- |
| 标记表合并不再复制（`mergeEventLedger()` 的“并集已成立”判定） | **已撤回** | 见 §9：两轮独立审核在真实后端各复现出可达分歧，做回可证明等价的形式后收益只剩约 4.7 ms 且要手工重写对象展开语义。 |
| 复用检查点里上次的 `appliedDigest` | 不做 | `redundant-work.md` §4.1：同进程官方句柄可原地回退标记表，O(1) 信号无法证明 O(历史) 状态未变，已整体撤回。本轮两次 `digestApplied` 的输入本来也不同。 |
| 跳过 `installPending()` 对整份文档的校验 | 不做 | `redundant-work.md` §4.2：把校验挪到安装之后会让被拒绝的事务已经改动实时归档树；本轮实测它占 20k 场景约 1.8 ms/次 flush。 |
| 改变检查点摘要的覆盖面（分段链、只哈希增量） | 不做 | 把“消耗前缀任意一个字节变化都会改变摘要”降级为“只认证最后一段”，是削弱完整性边界换取一次哈希。分叉保住同一个值，所以不需要那种取舍。 |
| 复用上一次事务的暂存目录 | 不做 | 机制上收益更大（216 个归档段时 `link` 占一次写入 CPU 的 60%），但它要求事务之间保留 `domain-staging/`，与现有不变量冲突，见 `archive-index-churn.md` §7。 |

## 9. 已撤回：标记表合并的那次整表复制

`mergeEventLedger(recovered, applied)` 的语义是“并集 + 冲突拒绝”，实现是“复制
`recovered`，再把调用方 `applied` 的每一条写进副本”。`replay()` 交进来的是
**整份已提交标记表 + 本组新标记**，所以副本的内容与顺序常常与调用方那张表完全
相同，复制与逐条写回（20000 项：展开 3.86 ms + `Object.entries` 3.29 ms）不产生
新内容。第一版实现“只遍历 `recovered` 判是否已覆盖”，在 20k 场景上把
`mergeEventLedger()` 从 7.78 ms 降到 1.26 ms，端到端 CPU −19.7%。

两轮独立对抗式审核各自复现出**真实端口可达**的分歧。当时为了修复它们写过一份
19 种形状的差分（与逐字复制的旧实现比较 `JSON.stringify` 的结果含顺序、或抛出的
错误），它随改动一起撤回、没有入库；这一函数留在树里的保证仍然是既有的 rc.8 差分
（`test/domain-storage/domain-storage-write-path-equivalence.test.js`）。四项反例：

| 缺陷 | 第一版 | 基线 |
| --- | --- | --- |
| 调用方新增的键名落在 `Object.prototype` 上（`__proto__`、`constructor`、`toString`…） | 判“已覆盖”，发布成功 | 副本上读到非 `undefined`，抛 `E_DOMAIN_EVENT_ID_CONFLICT` |
| `recovered` 里的标记值是 `undefined`、调用方是字符串 | 判冲突 | `known === undefined` 不冲突，写入调用方的值 |
| 两表覆盖同样的键但顺序不同 | 按调用方顺序发布 | 副本按 `recovered` 顺序再追加新键（持久化字节与 `appliedDigest` 都不同） |
| `recovered` 的属性是 accessor，且返回值随读取次数变化（官方句柄安装 getter） | 判定时读一次、退回旧循环再读一次，得到不同的判定 | 只读一次 |

把第四项也做对，就必须先读一次 `recovered` 的值、再用这批值手工构造副本（不能再
`{ ...recovered }`），也就是手工重写对象展开的语义：自有 `__proto__` 键必须用
`Object.defineProperty` 而不能走赋值（否则改原型）、symbol 键、以及 `applied`
一侧的读取顺序。实测这条可证明等价的路子仍要付 3.27 ms（两张键数组 + 两批值缓存），
收益从 5.0 ms 降到约 4.7 ms，却把一块对象语义的实现留在事务的完整性判定里。

按“被反例击穿的方案显式撤回”的既有做法（`redundant-work.md` §4.1/§4.2 同样处理），
本轮**整体撤回**该项，`lib/domain-storage.js` 与基线 `f469d57` 逐字节相同——包括
`mergeEventLedger()` 的原文、它的私有可见性与 `domain-storage-baseline.js` 的
`reversals` 锚点。留下的 12.17 MiB/次 重复哈希是**可证明等价**的那一半：它不读任何
调用方对象、不改变判定与顺序，只把同一段字节算一遍而不是两遍。

## 10. 独立审核记录

两轮独立对抗式审核（另一个模型，只读 + 自行复现）对最终保留的摘要改动做过：350 组
原生 HMAC 对照，以及两轮合计 1483 组 `planEventLogReplay` 分支差分（截断、读取期间
增长、空文件、不可用文件、检查点各种被改），未发现摘要缺陷；对已撤回的合并优化给出
§9 表里四项阻塞问题（其中 accessor/getter 一类是第二轮才发现的，另有两万余组普通
对象差分用于确认该优化的其余行为）。它同时指出并已修正的证据问题：

| # | 问题 | 处理 |
| --- | --- | --- |
| 1 | 基准的重启断言只看重启后的 `flush()`，而启动 replay 已经执行完，无法证明它没做事 | 改为比较重启前后持久文档与检查点的字节；注入“重启前删掉一个持久标记”后该断言实测失败 |
| 2 | 等价性轮的归档比较在 JSON 里全是 `archiveFiles: 0`，实际比较的是空树 | 等价性轮种入非空归档并断言条目数 ≥ 2 |
| 3 | 文档写的 `fsyncSync = 3` 在原始计数里不存在（官方后端用 `FileHandle.sync()`） | 插桩补上 `FileHandle.sync()`，按实测写 `official/sync = 2` |
| 4 | 文档称“每次推进都交叉校验两种摘要实现” | 改为只在与全量读取切换时交叉（§3） |
| 5 | profile 区间含新事件签名与追加 | 文档与脚本注释都如实写明 |
