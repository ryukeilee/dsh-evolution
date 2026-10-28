# 首次历史吸收的事件日志读取与重放内存：测量与候选撤回

本轮目标：优化无可用 replay checkpoint 时首次吸收的事件日志读取与重放内存，先确认
`readEventLog()` / `planEventLogReplay()` / `domain-storage.js` 的 `replay()` 中完整 Buffer、UTF-8
字符串、`lines` 数组与事件暂存各自的实际开销，再按 profiling 选择候选。

**结论：生产代码不改，`lib/` 与基线 `c1e5e3d` 逐字节相同；唯一候选（去掉整份解码字符串与 lines
数组，改为按需从保留字节逐行解码）撤回。**

撤回的理由不是"读取侧没有可优化点"，而是**读取侧的物化不是这个调用链的内存峰值**，候选只能改到
它的形状与小幅重叠：

1. **读数**：plan 保留日志**一次**（要么是 ArrayBuffer，要么是解码后的字符串，二者都约 1.0× 日志
   字节）；构造瞬间二者同时在世，约 2.0×；`lines` 数组与逐行切片在 2 万条时 790,904 字节
   （0.06×）。事件暂存（`batch`）是逐条投影后的事件 DTO，必须保留到唯一的批量提交。
2. **峰值不在读取**：2 万条时 plan 阶段高水位 94,624 KiB，absorb 结束 141,504 KiB，`committed`
   段让进程峰值到 278,928 KiB——**提交内部增长 137,424 KiB（134.2 MiB）**。日志字节只有
   12.2 MiB，是提交内部增长的 9.1%、峰值的 4.5%。
3. **候选的实测效应**（三轮配对差，按 2,000 / 12,000 / 20,000 顺序）：plan 高水位的中位数是
   −1,680 / −1,984 / −5,776 KiB，提交前是 −1,200 / −7,296 / −11,360 KiB，每一轮都远超 A/A。
   进程峰值是 9/9 轮同向下降，但幅度不足以定论：2,000 条的三轮是 −288 / −608 / −96 KiB（A/A
   极值 496 KiB），12,000 条是 −26,304 / −9,984 / −24,592 KiB（A/A 一轮 17,376 KiB），20,000 条是
   −8,352 / −5,408 / −72,096 KiB（A/A 极值 29,728 KiB）——每个规模都至少有一轮的幅度落在同一份
   代码观察到的 A/A 范围内（2,000 的 −288/−96，12,000 的 −9,984，20,000 的 −8,352/−5,408），而
   12,000 / 20,000 的 A/A 本身是双峰的。保留量只减 790,904 字节（2 万条）。
   2,000 与 12,000 条的墙钟在噪声内；20,000 条有两轮墙钟（+91.3 / +158.3 ms，A/A 最大 79.1 ms）
   与一轮 CPU（+229.0 ms，A/A 最大 53.5 ms）超出噪声，方向是候选更慢。2,000 条 CPU 最大 +10.6 ms
   略高于 A/A 的 10.2 ms，幅度很小。样本量都不足以定论。

两条必须写清的边界：

- 采样 profile 默认丢弃已被 GC 回收的对象，所以它的 self size **既不是分配总量，也不是保留量**，
  只是"stop 时仍在的对象"按分配调用帧的归属。
- 基线在提交前仍以**解码字符串**持有日志，候选以 **ArrayBuffer** 持有。2 万条时两者的 `external`
  总量是 15,864,121 vs 15,697,561 字节，只差 166,560 字节：两边都驻留约 1× 日志，所以"去掉字符串"
  不等于"从峰值里去掉日志"，真实减少的驻留是 `lines` 的 790,904 字节。

原始数据：[`event-log-replay-memory.json`](event-log-replay-memory.json)、逐样本
[`event-log-replay-memory.jsonl`](event-log-replay-memory.jsonl)；被撤回的候选：
[`event-log-replay-memory-rejected.patch`](event-log-replay-memory-rejected.patch)（SHA-256
`85348ad9b8587411d5560b51a07b5ddfa8c82ade81e54f60d1634611a620d8f1`，`git apply --check` 在当前
树上通过，但**未应用**）。脚本：
[`scripts/benchmarks/event-log-replay-memory.mjs`](../../scripts/benchmarks/event-log-replay-memory.mjs)
（SHA-256 `bcca47da9952591be77ffe0ff44fe7958ff205056539ab54c09d0a8d6e7e281c`）。

环境：Node `v26.12.1` / `darwin/arm64`，父子进程都带 `--max-old-space-size=4096`。本轮没有在
采集开始/结束时记录 load average；噪声刻度用同一份基线代码的 A/A 控制（每个规模、每轮各一次）。

## 1. 测量口径

- 每个样本一个全新 Node 子进程、全新临时 home，经真实 `openDomainStorage()`、官方
  `DomainFacility` 与 `JsonStorageBackend`；事件由 `signEventBridgeEnvelope()` 签成真实 envelope；
  冷夹具明确没有 `event-log.checkpoint.json`，open 前断言其不存在，open 后断言存在，再 flush 一次
  断言 `{applied: 0, duplicates: N}`。
- 三个规模：2,000 / 12,000 / 20,000 条，日志 1,271,781 / 7,660,874 / 12,797,754 字节。每点 3 轮，
  每轮 A/B 顺序交替；每个规模另跑 3 轮 A/A（两侧都取基线树、同一份代码）。
- A/B：基线是 `/tmp/dsh-base-replay-memory`（`c1e5e3d` 的独立 worktree，`node_modules` 链到工作
  树），候选是同一提交加被撤回的 patch。两侧的基准脚本字节相同（脚本内断言 SHA-256）。
- 内存分三种口径，不混用（`process.resourceUsage()` 与 `process.memoryUsage()` 的数值按原始
  KiB / 字节引用；换算式标注 MiB = 1,024 KiB）：
  - **进程峰值**：`openDomainStorage()` 返回瞬间的 `process.resourceUsage().maxRSS`。它在读回
    持久文档、强制 GC 与第二次 `flush()` 之前采集；那三件事属于基准验证，不是首次吸收。
  - **阶段高水位**：由 `lib/domain-storage.js` 的临时插桩副本在 plan 之后、每 1024 条、提交前、
    提交后采样；采集完首次 pass 就冻结，第二次 pass 的样本不计入。
  - **保留量**：`--plan-worker` 不打开领域，只调用 `planEventLogReplay()`；前后各 `global.gc()`
    两次再相减。阶段采样里的 `heapUsed` 含未回收垃圾，是现场量，不是保留量。
- 采样分配来源：`HeapProfiler.start/stopSampling`（32 KiB 间隔）只包住 `openDomainStorage()` 或
  `planEventLogReplay()`，按调用帧 self size 聚合。默认选项下采样器会丢弃已被 GC 回收的对象，
  因此这张表既不是分配总量也不是保留量；`external` 字符串与 Buffer 的 ArrayBuffer 也不在其中。

## 2. 读取与重放的实际内存开销

### 2.1 plan 保留量（`--plan-worker`，GC 后差值）

`external` 已包含 Buffer 的 ArrayBuffer（Node 同时把它计入 `arrayBuffers`），所以保留量是
`external + heapUsed`，不能再加 `arrayBuffers`。

| 记录数 | 日志字节 | 基线 heapUsed / external / arrayBuffers | 候选 heapUsed / external / arrayBuffers | 合计 |
| ---: | ---: | --- | --- | --- |
| 2,000 | 1,271,781 | 129,912 / 1,271,821 / 0 | 57,288 / 1,271,821 / 1,271,781 | 1.402 MB → 1.329 MB |
| 12,000 | 7,660,874 | 530,160 / 7,660,914 / 0 | 59,256 / 7,660,914 / 7,660,874 | 8.191 MB → 7.720 MB |
| 20,000 | 12,797,754 | 850,160 / 12,797,794 / 0 | 59,256 / 12,797,794 / 12,797,754 | 13.648 MB → 12.857 MB |

读数：**plan 无论怎样都保留日志一次**（≈1.0× 日志字节）。区别只在于持有的是 ArrayBuffer 还是
解码后的字符串；多出来的 `heapUsed` 是 `lines` 数组与逐行切片（2 万条 790,904 字节，0.06×）。

### 2.2 阶段高水位（中位数，KiB）

| 规模 | 侧 | plan | absorb 结束（提交前） | committed | 进程峰值 |
| ---: | --- | ---: | ---: | ---: | ---: |
| 2,000 | 基线 | 70,816 | 82,976 | 150,272 | 150,512 |
| 2,000 | 候选 | 69,136 | 81,776 | 149,984 | 149,984 |
| 12,000 | 基线 | 84,464 | 122,928 | 223,952 | 223,952 |
| 12,000 | 候选 | 82,544 | 115,760 | 198,352 | 198,352 |
| 20,000 | 基线 | 94,624 | 141,504 | 278,928 | 278,928 |
| 20,000 | 候选 | 89,072 | 130,144 | 259,312 | 259,312 |

同一份基线代码的 A/A 绝对差（配对，KiB）：plan `≤784 / ≤256 / ≤512`，提交前 `≤256 / ≤1,248 /
≤496`，进程峰值 `≤496 / ≤17,376 / ≤29,728`（依次为 2,000 / 12,000 / 20,000）。

由此：plan 与提交前的高水位差**稳定、可重复**（每个规模每轮都远超 A/A）；进程峰值差没有这个性质
（见 §4.2 的逐轮配对）。

申报前必须说明的一点：20,000 条时提交前 `heapUsed` 基线 46,062,080 字节、候选 35,958,664 字节，
差约 10 MB 属于**未回收垃圾**，不是保留量；同一时刻两侧的 `external` 是 15,864,121 vs 15,697,561
字节，只差 166,560 字节——基线那一份是解码字符串，候选那一份是 ArrayBuffer，**两侧都驻留约 1×
日志**。所以"提交前高水位 −11,360 KiB（中位数）"里，可证明的驻留差只有 `lines` 的 790,904 字节；
剩余部分不能解释为已证实的保留量减少，可能主要来自 GC 时机差。

### 2.3 事件暂存（`batch`）

`replay()` 把每条 authenticate 过的记录投影成事件 DTO（`{eventId, mac, event}`）留在 `batch`，直到
唯一一次事务提交。采样里它是重放侧最大的一项：12,000 条时 `JSON.parse`（`absorb` 内）
6,690,424 字节（33.5%）、`projectExecutionEvent` 3,321,304 字节（16.6%）。2 万条时基线的提交前
`heapUsed` 是 46.1 MB（含未回收垃圾），而 open 结束后保留 21.76 MB。

这批暂存**不能缩小或提前提交**：一次吸收一次事务提交是已发布的语义（失败时机、崩溃恢复窗口、
`E_DOMAIN_EVENT_ID_CONFLICT` 的判定面都建立在"整组一起提交"上），把组切开就是语义改动。

## 3. 峰值在哪

20,000 条：提交前 141,504 KiB → `committed` 278,928 KiB，**提交内部增长 137,424 KiB（约
134.2 MiB）**，而日志读取的全部物化只有 2×12.2 MiB 的瞬间重叠、1× 的驻留。

采样（12,000 条，只包 `openDomainStorage()`，基线 self size 合计 19,997,032 字节）：

| 来源 | self size | 占比 | 归属 |
| --- | ---: | ---: | --- |
| `JSON.parse`（`absorb` 内） | 6,690,424 | 33.5% | 逐条认证；解析产物在 stop 时仍未回收 |
| `projectExecutionEvent` | 3,321,304 | 16.6% | 事件暂存，必需 |
| `structuredClone` | 1,967,592 | 9.8% | 事务内的聚合克隆 |
| `Set` | 1,310,800 | 6.6% | 事务与合并 |
| `toJsonProjection` | 885,504 | 4.4% | 保存时的整份文档投影 |
| `zod._parse` | 786,496 | 3.9% | 整份文档校验 |
| `mergeEventLedger` | 786,496 | 3.9% | ledger 合并 |
| `commit` | 786,496 | 3.9% | ledger 拷贝 |
| `add` | 688,272 | 3.4% | Map/Set 增长 |
| `fromEntries` / `has` | 1,115,072 | 5.6% | 事务与合并 |

plan 作用域的采样：12,000 条时基线 424,568 字节（`split` 391,096 = 92.1%），候选 32,984 字节
（`createHmac`，候选不再保留任何行字符串——它的保留物是 ArrayBuffer）。同一张表在两侧之间的
其它项有采样噪声（例如 `structuredClone` 1.97 MB vs 1.05 MB），不应当按单个调用帧比较两侧。

结论：读取侧的物化（字符串 + lines）能拿走的只有 1× 日志字节（2 万条 12.2 MiB），是提交内部
增长量的 9.1%、进程峰值的 4.5%。**它不在峰值路径上**。真正的峰值在整份文档的保存路径，而那里被
"不得通过延迟或跳过现有聚合保存校验换取性能"与既有不变量约束，且此前几轮已经做过合并保存、
延迟归档索引、投影替代递归校验等优化。

## 4. 被撤回的候选

### 4.1 内容

`planEventLogReplay()` 不再 `tail.toString('utf8')` 再 `split('\n')`，而是返回
`lines: () => eventLogLines(tail)`：一个从保留字节按 `\n` 边界逐行解码的生成器工厂。行数与
`remainder` 由一次字节扫描得到；"空行"判定仍用 `trim()`（每行解码一次后即丢）。字节切分与字符串
切分等价：`0x0A` 不可能是任何 UTF-8 多字节序列的一部分，非法序列在到达换行符前就已终止，解码器的
替换规则作用在同样的最大子部件上。该等价性由
[`scripts/benchmarks/event-log-line-split-equivalence.mjs`](../../scripts/benchmarks/event-log-line-split-equivalence.mjs)
钉住：默认语料 8,097 例（含截断序列、过长编码、代理对半、BOM、NUL、随机字节，并在每个位置插入
换行符）无差异，`--random 20000 --seed 7` 的 40,097 例同样无差异。

`domain-storage.replay()` 的循环相应变成 `for (const line of plan.lines())`。

同一份采样在候选侧给出的 `JSON.parse` 调用帧是 5,706,520 字节，低于基线的 6,690,424；这属于
采样噪声，不是候选减少了分配——它反而多出一次逐行 `trim()` 解码。2,000 / 12,000 条的耗时差在
噪声内，20,000 条有两条墙钟样本超出同码 A/A 最大值（§4.2）。

### 4.2 A/B（中位数；3 轮，顺序交替）

| 规模 | 墙钟 ms：基线 → 候选 | CPU ms：基线 → 候选 | 进程峰值 KiB：基线 → 候选 | 逐轮配对峰值差 | 逐轮配对 plan 差 |
| ---: | --- | --- | --- | --- | --- |
| 2,000 | 1,057.6 → 1,058.1 | 1,102.4 → 1,107.6 | 150,512 → 149,984 | −288 / −608 / −96 | −1,168 / −1,888 / −1,680 |
| 12,000 | 14,498.8 → 14,810.9 | 15,185.2 → 15,465.1 | 223,952 → 198,352 | −26,304 / −9,984 / −24,592 | −1,984 / −1,360 / −2,288 |
| 20,000 | 26,853.8 → 26,932.8 | 28,816.1 → 28,788.2 | 278,928 → 259,312 | −8,352 / −5,408 / −72,096 | −5,776 / −5,952 / −5,424 |

- 2,000 条：墙钟 A/A 最大 6.8 ms（A/B −4.0…+3.9 ms）在噪声内；CPU A/A 最大 10.2 ms，A/B 最大
  +10.6 ms，略超、幅度很小。12,000 条：墙钟 A/A 最大 972.7 ms（A/B −36.1…+394.4 ms）、CPU A/A
  最大 983.7 ms（A/B −64.3…+362.0 ms），都在噪声内。20,000 条：墙钟 A/A 最大 79.1 ms，而 A/B
  有两轮（+91.3 / +158.3 ms）超出；CPU A/A 最大 53.5 ms，A/B 有一轮 +229.0 ms 超出——方向是候选
  更慢，3 轮样本不足以定论。
- **进程峰值**：三个规模都是 3/3 轮同向下降，但每个规模都至少有一轮的幅度落在同一份代码的
  A/A 范围内（2,000：−288 / −96 在 A/A 极值 496 KiB 内，−608 超出；12,000：−9,984 在 A/A 一轮
  17,376 KiB 内；20,000：−8,352 / −5,408 在 A/A 极值 29,728 KiB 内）。没有规模满足"每一轮都超出
  已观察的同码噪声"。
- **plan / 提交前**：每个规模每轮都远超 A/A（plan ≤784 / ≤256 / ≤512 KiB，提交前 ≤256 / ≤1,248 /
  ≤496 KiB），但这两个量是 pass 内部的阶段高水位，不进入进程峰值。

### 4.3 撤回理由

判据（测量前写作"稳定可重复的端到端收益、且不使任何阶段变差"）：

1. **端到端峰值的方向一致，但幅度无法与同码噪声分开**：9/9 轮同向，可每个规模都至少有
   一轮的幅度落在同一份代码观察到的 A/A 范围内，且 12,000 / 20,000 的 A/A 是双峰的（一轮
   17,376 / 29,728 KiB）。
   3 轮/规模不足以把一个量级 10–20 MB 的效应当作结论；本轮没有追加轮次。
2. **读取侧的物化不能被"去掉"，只能被换形**：提交前两侧都驻留约 1× 日志——基线是解码字符串，
   候选是 ArrayBuffer——`external` 总量只差 166,560 字节（20,000 条）。真实减少的驻留只有 `lines`
   的 790,904 字节；阶段高水位差的其余部分不能解释为已证实的保留量减少（提交前 `heapUsed`
   46,062,080 vs 35,958,664 字节的差不是驻留，可能主要来自 GC 时机）。
3. **保留量只减 790,904 字节**（2 万条，0.06×）；`afterOpen` 保留堆两侧相同（21,757,976 vs
   21,731,736 字节）。
4. **代价不划算**：`planEventLogReplay()` 的返回形状变化、pinned 差分基线更新，以及 §4.4 的连锁。
   为不到 1 MB 的驻留差与一个未与噪声分开的峰值差去改一个安全敏感模块的 plan 契约，不符合
   "最小改动"。

因此保留原实现。

### 4.4 候选的直接代价：pinned 差分基线

`test/domain-storage/marker-table-special-keys.test.js` 会把 rc.8 固定的
`lib/domain-storage.js` 源码物化后与新模块一起运行。旧源码里的 `for (const line of plan.lines)`
对新的 `lines()` 工厂报 `TypeError: plan.lines is not iterable`。要让这条差分继续可跑，需要让固定
源码解析到与之配套的固定 `event-log-checkpoint.js`（即同时物化两个固定模块），或把 `plan.lines`
做成同时支持迭代与 `.length` 的 array-like 视图；两者都是本轮改动之外的额外夹具/抽象工作。为不到
1 MB 的驻留差与一个未与噪声分开的峰值差去做它，不划算。

## 5. 检查过但未采用的替代

- **流式读（分块读取 + 边读边认证 + 逐行产出，不保留整份日志）**：本轮**没有测过**它。按读数
  推算，它最多能把驻留里的 1× 日志（12.2 MiB）去掉，而 20,000 条的同码 A/A 峰值极差是 29,728 KiB，
  所以"能稳定降低峰值"只是一个尚未验证的假设。它还要重写"前缀一次性读取、单次摘要、在 checkpoint
  边界 fork"的结构；上一轮的 [`event-log-read-chunks.md`](event-log-read-chunks.md) 已经证明这个
  结构对并发截断敏感（4 MiB 块会认证一份 1 MiB 块明确拒绝的检查点），因此不采用。
- **缩小事件暂存 / 提前提交**：改变失败时机与崩溃恢复窗口，属于语义改动。
- **保存路径的整份文档投影、解析与写盘**：峰值确实在这里，但本轮授权明确禁止以延迟或跳过聚合
  保存校验换取性能；且不在本轮"事件日志读取与重放"范围内。这应作为下一轮单独的课题。

## 6. 已执行 / 未执行的验证

本轮最终交付不含生产代码改动。候选在撤回前已执行：

| 检查 | 结果 |
| --- | --- |
| `node --test test/domain-storage/event-log-checkpoint.test.js test/domain-storage/checkpoint-keyed-digest.test.js test/retention-log-floor.test.mjs` | 37/37 通过（两处 `plan.lines.length` 形状断言改为 `[...plan.lines()].length`） |
| `node --test "test/domain-storage/**/*.test.js"` | 更新 pinned 锚点后只剩 `marker-table-special-keys.test.js` 失败，原因即 §4.4 |
| `node scripts/benchmarks/event-log-line-split-equivalence.mjs` | 8,097 例，0 差异 |
| 同上 `--random 20000 --seed 7` | 40,097 例，0 差异 |
| A/B + A/A + plan 保留量 + 采样（本轮 JSON） | 见 §2、§3、§4 |

未执行（因为候选在进入交付流程前就被撤回）：Node 22/24/26 全量测试、`pack:check`、三个宿主验收、
独立审核、`release:publish`、任何 tag / 发布动作。

撤回后（当前树）执行：

| 检查 | 结果 |
| --- | --- |
| `git status --porcelain -- lib test` | 空；`lib/` 与 `test/` 逐字节等于 `c1e5e3d` |
| `git apply --check docs/performance/event-log-replay-memory-rejected.patch` | 通过（未应用） |
| `NODE_OPTIONS=--max-old-space-size=4096 npm test`（Node `26.12.1`） | 1,196 / 1,196 通过 |
| 同上（Node `24.22.1`） | 1,196 / 1,196 通过 |
| 同上（Node `22.23.4`） | 1,196 / 1,196 通过 |
| `npm run pack:check` | 16 项全部通过；本树是固定点的已提交后继，分发内容未变 |

## 7. 复现

顺序很重要：当前树就是基线，所以必须先准备两侧目录并应用 patch，再跑测量，否则 A/B 会退化成
A/A，并覆盖证据文件。

```sh
# 1. 基线侧：同一提交的独立检出 + 依赖 + 与本树同字节的基准脚本
git worktree add --detach /tmp/dsh-base-replay-memory c1e5e3d
ln -sfn "$PWD/node_modules" /tmp/dsh-base-replay-memory/node_modules
cp scripts/benchmarks/event-log-replay-memory.mjs /tmp/dsh-base-replay-memory/scripts/benchmarks/

# 2. 候选侧：把被撤回的 patch 应用到当前树（A 侧仍是不带 patch 的 worktree）
git apply docs/performance/event-log-replay-memory-rejected.patch

# 3. 测量（不要把输出指到已有证据文件上；先写到临时路径再比对）
NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/event-log-replay-memory.mjs \
  --records 2000,12000,20000 --rounds 3 --profile --profile-records 12000 \
  --baseline-root /tmp/dsh-base-replay-memory \
  --out /tmp/event-log-replay-memory.json --ledger /tmp/event-log-replay-memory.jsonl

# 4. 还原生产代码
git checkout -- lib test
```

脚本把 `/tmp/dsh-base-replay-memory` 当成 A 侧，候选侧是当前工作树；两侧脚本字节相同由脚本内断言。
所有夹具在 `os.tmpdir()` 下。除了 `--out` / `--ledger`，两侧的 worker 还会在各自的 `lib/` 里写一个
临时的插桩副本（`lib/.domain-storage-replay-memory-<pid>-<uuid>.mjs`，导入后立即删除），所以两侧的
`lib/` 必须在测量期间可写；没有其它仓库内写入。

## 8. 边界

- 只测了 Node `v26.12.1` / `darwin/arm64`；未测其它平台、冷页缓存、网络文件系统、多进程竞争。
- 规模上限 20,000 条 / 12.8 MB 日志；生产曾出现过的 73,525 条不在本轮。
- 进程峰值在同一份代码上的离散度很大（12,000 条 A/A 一轮 17,376 KiB，20,000 条最高 29,728 KiB）。
  3 轮/规模不足以把 10–20 MB 量级的效应当成结论；本轮没有追加轮次，也没有把离散度分解成"字符串
  是否活到峰值"的确定性实验。
- `heapUsed` 阶段采样含未回收垃圾；本轮的保留量结论只来自 `--plan-worker` 的 GC 后差值。
- 采样 profile 只覆盖堆，且默认丢弃已被 GC 回收的对象；`external` 字符串与 Buffer 的 ArrayBuffer
  不在采样里，所以"字符串占了 12.8 MB"是 §2.1 的差值读数，不是采样结果。
- 本轮没有把 20,000 条的峰值离散度分解成"字符串是否活到峰值"的确定性实验。
