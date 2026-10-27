# 首次历史吸收：合并 staged 归档索引的整份重写

## 结果

无有效 checkpoint 的首次历史吸收里，每写入一条被逐出热窗口的归档记录，`#archiveEntries()` 都
立刻重写一次整份归档索引文档 `state.json.evolution-archive-index.json`：对每个集合
`readdirSync` 一次、对每个归档文件 `statSync` 两次、`JSON.stringify` 整份文档、写临时文件、
`rename`。这条路径在真实端口里只出现在 `domain-storage` 为一次领域事务创建的 staged 工作副本
上，而该副本在事务提交前从不发布，其间没有任何读者读那份文档——它只是被下一条记录覆盖。

候选把这一份文档改成"记账 + 事务结束前付一次"，只在 staged 工作副本上生效（`deferArchiveIndexWrites`，
由 `archiveWriteGuard !== null` 决定，与既有的 `coalesceMeasurementMarkerPersist` 同一个入口）。
实测 12,000 条记录：**墙钟 19,136 → 14,563 ms（−23.9%），CPU 19,807 → 15,048 ms（−24.0%）**；
2,000 条 −43.5%，20,000 条 −22.5%。`assertTransactionSave` 的调用次数与被 stringify 的
payload 字节完全不变，持久化内容不变，没有改发布格式、事件格式、检查点格式或 schema。

原始数据见 [`first-startup-absorption-deferred-archive-index.json`](first-startup-absorption-deferred-archive-index.json)
与逐样本 [`first-startup-absorption-deferred-archive-index.jsonl`](first-startup-absorption-deferred-archive-index.jsonl)。
复现脚本是本轮唯一改动过的基准：[`scripts/benchmarks/first-startup-absorption.mjs`](../../scripts/benchmarks/first-startup-absorption.mjs)。
研究过程中的相位探针、越界实验与 `size` 探针是临时文件，不在仓库内。

## 测量口径

- 基线是 `4e28cd71972b9565442724b6087a54bba06e05e9`（当前 `main`）的独立 worktree
  `/tmp/dsh-base-next`，`node_modules` 链到工作树；候选是同一提交加本工作树的改动。JSON 的
  `method.baselineCommit` / `method.candidateCommit` 由各自树里 `git rev-parse HEAD` 读出
  （本轮同时修掉了这两个字段此前硬编码成 `b13fe4c` 的问题），`method.candidateWorktreeChanges`
  列出候选树未提交的路径。
- 每个样本一个全新 Node 子进程、全新临时 home，经真实 `openDomainStorage()`、官方
  `DomainFacility` 与 `JsonStorageBackend`；事件由 `EvolutionEventBridge.project()` 生成并用
  独立 key 签成真实 envelope；冷夹具确认没有 `event-log.checkpoint.json`。每次 open 后断言全部
  N 个 marker 已提交、`pending: null`。
- 2,000 / 12,000 / 20,000 三个点，每点 3 轮、每侧每轮 1 个样本，顺序逐轮交替；2,000 条另跑
  3 组同码 A/A 作噪声对照。同一 fixture 文件生成一次后按 SHA-256 校验复制给两侧。
- `maxRSS` 是 `process.resourceUsage().maxRSS` 原始值，整个 worker 进程的高水位，包含启动、
  fixture 读取与后端初始化，不能归因于 replay 单独一段。
- 两侧都带 `--max-old-space-size=4096`。环境 Node `v26.12.1`、`darwin/arm64`。

## 端到端样本

| 记录数 | 墙钟 ms：基线 → 候选 | CPU ms：基线 → 候选 | maxRSS 原值：基线 → 候选 | 被 stringify 的 payload 字节 |
| ---: | ---: | ---: | ---: | ---: |
| 2,000 | 1,855.3 → 1,048.4（−807.0，−43.5%） | 1,920.1 → 1,091.3（−828.8，−43.2%） | 153,280 → 149,264（−4,016） | 389,416,134 → 389,416,134 |
| 12,000 | 19,135.8 → 14,563.2（−4,572.6，−23.9%） | 19,806.9 → 15,047.7（−4,759.2，−24.0%） | 243,664 → 237,408（−6,256） | 7,247,238,781 → 7,247,238,781 |
| 20,000 | 34,152.5 → 26,473.1（−7,679.4，−22.5%） | 35,181.1 → 27,244.9（−7,936.1，−22.6%） | 321,552 → 327,056（+5,504） | 13,096,942,139 → 13,096,942,139 |

2,000 条 A/A 三组墙钟绝对差 `47.9 / 7.1 / 2.2 ms`，CPU 绝对差 `51.1 / 2.3 / 2.7 ms`，
`maxRSS` 绝对差 `16 / 480 / 256`。三个点的每轮配对墙钟差全部为负且远大于该噪声上界：
2,000 条 `−823.0 / −797.3 / −802.6 ms`，12,000 条 `−4,565.7 / −4,546.5 / −4,637.2 ms`，
20,000 条 `−6,199.7 / −7,518.7 / −7,733.1 ms`。CPU 配对差同样全负。

`maxRSS` 差值在 2,000 与 12,000 条略降、20,000 条微升，且 A/A 只在 2,000 条运行、无法估计高
规模噪声，因此**不宣称内存收益**。这一点与上一轮 save 合并的结论一致。

## 归因：为什么是这一项

`4e28cd7` 上 12,000 条的 CPU profile（`--sampling-interval` 200 µs，只 profile `open` 段）
按"最近的项目帧"归属，墙钟 19,831 ms：

| 相位（inclusive） | ms | 占比 |
| --- | ---: | ---: |
| `#save`（其中 `assertTransactionSave` 自身 11,065 ms） | 11,471 | 57.9% |
| `#writeArchiveIndexDocument` | 2,574 | 13.0% |
| 归档段 `appendFile`（`#archiveEntries` 的 `run`） | 2,368 | 11.9% |
| `#archiveFiles`（每次索引写的 `readdirSync`） | 1,280 | 6.5% |
| `#bridgeApplied`（对 4,096 条 marker 线性扫描） | 483 | 2.4% |
| idle（等 fsync / IO） | 3,435 | 17.3% |

`#writeArchiveIndexDocument` + `#archiveFiles` = 3,854 ms（19.4%），再加上这部分写入贡献的
idle，越界实验（临时把 `#writeArchiveIndexIncremental()` 改成直接返回）测得 12,000 条
19,626 / 19,653 → 14,793 / 14,831 ms，即 −24.6%——与正式候选的 −23.9% 吻合，差额来自候选仍需
在事务末尾写一次。

候选实现后的 profile（同一夹具，墙钟 14,683 ms）：`#writeArchiveIndexDocument` 完全消失；
`#save` 变成 10,915 ms（74.3%）、idle 降到 1,295 ms（8.8%）、归档段 `run` 853 ms（5.8%）。
**剩余的主项就是 `assertTransactionSave` 对整份文档的逐条 stringify（payload 的 96% 是
`eventBridge.applied` 的 4,096 条 marker），本轮没有动它**，理由见下节。

## 等价性依据与边界

### 为什么可以合并

`deferArchiveIndexWrites` 只有一处来源：`createMemory()` 在 `archiveWriteGuard !== null` 时
传入，也就是 `mutate()` 为一次领域事务建的 staged 工作副本。`hydrate()` 建的 live 实例
（`archiveWriteGuard === null`）、直接构造的 `EvolutionMemory` 以及任何没有这两个选项的调用者
都保持原来的逐次写。这一点由
[`deferred-archive-index.test.mjs`](../../test/domain-storage/deferred-archive-index.test.mjs)
的第三个用例钉住。

索引文档的读者只有五处，一次 replay 批次都到不了：

| 读者 | 何时 |
| --- | --- |
| `#reconcileArchiveIndex()` | `load()`；`reconcile()` → `#adoptDurableProjection()` |
| `#loadArchiveIndex()` | `load()`；`#rewriteArchives()` 的回滚 |
| `archiveIntegrity()` 与 `#archiveConsistencyReport()` | 诊断、`verifyConsistency()` |
| `#writeArchiveIndex()`（整份重建） | `compact()` |
| `#rewriteArchives()` | `reclaim()` / retention |

`mutate()` 的 replay 分支在 `work()` 里只调 `applyExecutionEvent()`。`createMemory()` 自己那次
`load()` 发生在批次之前，`reconcile()` 在 `lib/` 里没有调用者。因此批次期间没有读者能看到陈旧
文档。

`flushDeferredArchiveIndex()` 在 `mutate()` 里排在 `work()` 之后、`const aggregate = ...` /
`assertLiveTreeUnchanged()` / `changedArchiveFiles()` 之前。这一步**对发布是必需的，而不只是
为了校验**：索引是 `ARCHIVE_NAME_RE` 里的归档名之一，`mirrorArchives` 会把它硬链接进 stage，
因此一份本实例没写过的索引与已提交的 inode 逐字节相同，`changedArchiveFiles()` 只是不会列出
它。越界探针（把 flush 改成 no-op）实测到的结果就是这个：事务照常发布，只安装归档文件、不安装
索引，随后 `hydrate()` 的 load-time `#reconcileArchiveIndex()` 在提交之后重新生成索引；两者之间
那段窗口里，已提交的树有归档字节却没有索引。付账之后，索引与归档文件一起进入
`pending.files`。

发布出来的字节是 `#writeArchiveIndexDocument()` 在同一次捕获上生成的那一份，与"最后一次逐条
写"相比只有 `updatedAt` 不同（该字段本来就每次取 `timestamp(this.clock)`）。

测试直接钉住这一点：同一个 clock、同一批事件、同样的文件名，把 deferred 与 eager 两个
staged 实例的索引文档**与归档文件**逐字节比较（第二个用例）。第一个用例则断言 deferred 实例在
60 条归档记录之间**一份索引都没写**（每次读到的都是 `null`），`flushDeferredArchiveIndex()`
第一次返回 `true`、之后返回 `false`，且发布的文档确实描述本次写入的字节数与行数。第四个用例
把索引路径占成目录让 `rename` 失败；第五个用例在端口上把 flush 替换成抛出，断言整个
`openDomainStorage()` 拒绝、`dockyard/` 里没有多出索引、durable 文档仍是 `pending === null`。

### 刻意改变的一处：索引写失败的处理

原来 `#writeArchiveIndexIncremental()` 的失败被 `#archiveEntries()` 的 `catch` 吃掉：该条记录
留在热窗口、记一个 `deferred-write` 故障、批次继续。现在账只记一次，付账失败会向上抛，整个
事务在发布前中止。

这是更严格的一侧——一份本进程写不出去的索引不会被当作写好了发布——而且它顺带消除了原来那个
自相矛盾的现场（字节已经 append 进归档，`archiveKnown` 却被回滚，下一条同 key 记录会再
append 一行）。下一个 replay pass 整体重试。第四个用例用一个空目录占住索引路径，让 `rename`
失败，断言 `flushDeferredArchiveIndex()` 拒绝而不是被吞掉。

### 顺带变得可见的两处差异（都不在被发布的字节里）

1. **被放弃的 stage 目录里那份索引文档更旧。** 事务在付账前失败时，stage 就被放弃了，里面留着
   它自己 `load()` 写的那份文档。这个目录没有任何读者：安装路径发布的是 `pending.files`（在
   付账之后才产生），而唯一会碰它的 doctor `domain-orphan-staging` 只删目录、不解释内容。
   `test/observe-cache-handoff.test.mjs` 的失败残件差分把这一份排除了，并在
   `withoutAbandonedStageIndex()` 里写明理由；stage 内的归档字节仍然逐字节比较。
2. **临时文件名少消耗了一次 `crypto.randomUUID()`。** 该测试的确定性桩用具名序列，因此记录
   id 的绝对序号会平移。`rebaseSerials()` 把每个序列值重写成它首次出现的秩，保留"哪些 id
   相同、哪些不同、出现顺序"这些比较真正关心的关系，只丢掉绝对偏移。

### 没有动的东西

- **`assertTransactionSave()` 仍然每条记录执行一次**，payload 字节数完全不变（表中逐点相等）。
  它是"保存的载荷能不能被 JSON 表示"的边界，而 payload 的 96% 是 `eventBridge.applied` 的
  4,096 条 marker；`safeIdentifier` 允许 `experimentId = "__proto__"` 作为**值**出现，序列化后
  会引入精确的 `"__proto__"` 字面量并触发递归 strip，这正是既有用例钉住的拒绝路径。把中间
  payload 的 marker 表排除、或把检查推迟到批次末尾，都会改变接受集合；上一轮的
  [归因报告 §候选设计](first-startup-absorption-attribution.md#候选设计与语义风险)已经把这
  一点列为不能称为严格等价。要动它必须先明确接受集合的变化。
- **归档段的逐条 `appendFile`**（候选里仍有 853 ms + 部分 idle）没有合并。它同样需要"事务内
  可以延后写归档文件"的新合同，而 `#archiveEntries()` 的 chunk/flush 语义、失败时的
  `deferred-write` 回退与 `#sealArchive` 的时机都在一条路径上；本轮没有证据说明能等价，因此
  不做。
- **`#bridgeApplied()` 对 4,096 条 marker 的线性扫描**（434 + 280 ms）没有加索引缓存。
  `#markBridgeApplied()` 每次都 `push` 到旧数组再 `slice(-4096)` 换成新数组，按数组身份缓存
  永远失效，按内容维护则需要 7 处 `this.#data` 赋值点全部失效正确——约 4.5% 的收益换一个
  隐蔽的身份错误不划算。
- **索引文档本身的大小与排序**没有变：`#writeArchiveIndexDocument()` 的集合枚举、`statSync`
  过滤与 `actual` 顺序原样保留，所以持久化字节与发布格式都不变。

## 验证

全部在已提交的树上执行（最终 HEAD）。

| 检查 | 结果 |
| --- | --- |
| `NODE_OPTIONS=--max-old-space-size=4096 npm test`，Node 22.23.4 | 1184 tests / 1184 pass / 0 fail，exit 0 |
| 同上，Node 24.22.1 | 1184 / 1184 / 0，exit 0 |
| 同上，Node 26.12.1 | 1184 / 1184 / 0，exit 0 |
| `npm run pack:check`（开发语义） | 16/16，并判定本树是固定点的已提交后继，逐条只点名 `lib/dockyard-domain/memory.js` 与 `lib/domain-storage.js` |
| `npm run release:pack` + `verify-artifact --content-only --tree` | 51 entries，contentSha256 `b85542f0…a286e`，与本树声明一致 |
| 真实宿主验收 0.2.0-rc.2 / 0.2.1-alpha.1 / 0.2.1-rc.2 | 各自 21/21 步通过，证据的 `contentSha256` 同为 `b85542f0…a286e` |

`release/` 固定产物、`package.json` 版本、`peerDependencies`、三个宿主的兼容范围都没有改；本树是
固定点的开发后继，发布字节保持不变，所以没有重新固定，也没有写入 `release/`。

独立审核（sol-loop，`pi` / `opencode-go/deepseek-v4.1-flash` / `thinking: max`，1 轮）：
VERDICT APPROVE，无 blocker、无 should，6 个 nit。已按其中 5 个修正：flush 注释里"会被当成
committed 索引被删掉"的错误说法、测试里 deferred/eager 比对应为此较字节、补上端口层的 abort
用例、本文读者表把 `compact()` 改正为 `reconcile()` / `#writeArchiveIndex()`、以及基准脚本被压
成一行的一处。第 6 个（本轮之前报告过的那次全套件 `1 fail` 是提交前工作树的旧结果）已在
上表按提交后的实测重报；那一项是 `release-pin.test.mjs` 对未提交分发改动的拒绝，本提交不留
下这个状态。

## 复现

```sh
git worktree add /tmp/dsh-base-next 4e28cd71972b9565442724b6087a54bba06e05e9
ln -s "$PWD/node_modules" /tmp/dsh-base-next/node_modules
NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/first-startup-absorption.mjs \
  --records 2000,12000,20000 --rounds 3 --samples 1 --baseline-root /tmp/dsh-base-next \
  --out docs/performance/first-startup-absorption-deferred-archive-index.json \
  --ledger docs/performance/first-startup-absorption-deferred-archive-index.jsonl
```

所有 fixture 都在 `os.tmpdir()` 下，脚本会拒绝别的 fixture 路径；JSONL 每样本追加后 fsync。
`package.json#files` 不含 `scripts/benchmarks/`，也不含 `docs/performance/`，因此本轮新增的
基准与文档不改变分发字节。
