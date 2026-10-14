# 经验读取路径：记录写入时对冷档案的重复读取与重复投影

本轮只删除 `lib/dockyard-domain/` 记录路径上"同一份字节被读两次 / 同一行被投影两次"
的重复工作，不新增缓存层，不改变持久化格式、认证、fsync、事务、恢复、回滚与
promotion 边界，也没有修改官方 DSH 源码与任何已发布的固定产物。基线是当前固定点
`release/dsh-evolution-0.2.0-rc.10.tgz` 中的 `lib/`（`sourceCommit 3e29cd3`，
其 `lib/` 与 `HEAD 0f866c0` 逐字节相同），基准直接解包该固定产物后 import，不靠
人工重写基线。原始逐轮样本见
[`experience-recall-archive.json`](experience-recall-archive.json) 与
[`observe-cold-archive.json`](observe-cold-archive.json)。

环境：Node `v26.11.1` / darwin-arm64（Darwin 27.0.1），Apple M2，8 逻辑 CPU、
16 GiB 内存。机器并非空闲：首次测量时内存基准运行前 load average
`1.54 / 1.71 / 1.74`、运行后 `1.73 / 1.75 / 1.75`，端到端基准运行前
`1.64 / 1.71 / 1.73`、运行后 `1.59 / 1.70 / 1.73`（1/5/15 分钟）；本文第 2 节
引用的收口重跑在 load average `1.80 / 1.73 / 1.78` 至 `2.11 / 1.80 / 1.80` 之间
完成。测量期间没有并行运行测试或其它基准。

## 1. 瓶颈与改动

`experience-recall` 只读路径本身（`collectKnowledgeExperience` 的投影与匹配）
经测量不是瓶颈：10,000 条 cold knowledge 行的端到端 recall 为 143.5 ms，其中
把 `memory.history("knowledge")` 读出来（读文件 + JSON 解析 + 合并 + 深拷贝）占
约 130 ms，投影与 token 匹配只占约 15 ms。而同一批档案在**记录写入**路径上被
读取的次数才是真正的冗余，且这些档案与 recall 读的是同一份数据：

1. **一次 append 读两遍 knowledge 冷档案。** `#append()` 先算
   `previousKnowledge = this.#knowledgeEntryFor(event)`，随后
   `#upsertKnowledgeUnlocked()` 内部又用同一个 `event` 再调一次
   `#knowledgeEntryFor()`。两次之间没有任何会影响 knowledge 历史的操作，输入与
   结果都相同，但每次调用都是 `history("knowledge")`：完整读取、JSON 解析、按
   id 合并、再深拷贝所有行。改为把 `#append()` 已经解析出的结果作为可选参数传入，
   未传入时行为不变（另外三个调用点仍然自己解析）。
2. **源集合扫描把整段历史深拷贝并完整投影。** `#sourceMatches()` 用
   `this.history(collection)` 取完整历史再 `filter`，而它只读取、从不把行本身交
   给调用方（延迟返回的分支会 `clone()`，`#shouldRetainSource()` 只读），因此那次
   全量 `structuredClone` 是纯浪费；同时它对每一行调用
   `normalizeKnowledgeEvent(entry, …)` 只为取 `knowledgeKey`，却顺带计算了
   `occurredAt`（每行一次 `new Date()`/`Date.parse`/`toISOString`）、metrics、
   recovery、relations、confidence 与各种引用字段，并且每行都要调一次
   `timestamp(this.clock)`。

第 2 项的改动分两处，且都是"只算调用方真正读的部分"：

- `lib/dockyard-domain/memory.js`：`#sourceMatches()` 改为用 `#mergeArchived(…,
  { copy: false })`（类内已有的无拷贝合并视图，`historyWindow()` 已在用），并用
  `knowledgeKeyOf(entry)` 取代完整的 `normalizeKnowledgeEvent()`。
- `lib/dockyard-domain/knowledge.js`：把 `normalizeKnowledgeEvent()` 的身份前缀
  （explicit key + 六个语义维度 + `hasSignal`）原样提取为内部
  `knowledgeIdentity()`；`normalizeKnowledgeEvent()` 继续从它开始构造完整事件，
  新增导出的 `knowledgeKeyOf()` 只返回该前缀算出的 key，
  `canonicalKnowledgeKey()` 的兜底分支也改用它。

**等价性**：`knowledgeKeyOf(x)` 就是
`normalizeKnowledgeEvent(x, …)?.knowledgeKey ?? null`（key 只由六个维度哈希得到，
`sourceCollection` 与 `now` 不影响它），所以 `#sourceMatches()` 的判断输入与
结果完全不变；`copy: false` 不改变行的顺序、身份或内容，只去掉调用方丢弃的副本。

## 2. 实测（严格交替 3 轮，每进程 1 次预热 / 7 或 5 次正式样本）

收口时对同一份代码做了两组 A/B，每组都从固定产物 rc.10 出发、在同一时段交替运行，
两组只差一处：

- **A 组**：rc.10 → 只含本文改动（上一轮的扫描/身份改动）的树；
- **B 组**：rc.10 → 当前工作树（本文改动 + 随后一轮的查找拷贝改动，见
  [`knowledge-lookup-copy.md`](knowledge-lookup-copy.md)）。

本节表格只引用 A 组；B 组与两步的绝对中位数同一个 JSON 里，见
[`experience-recall-archive.json`](experience-recall-archive.json) 与
[`observe-cold-archive.json`](observe-cold-archive.json) 的 `stages`。

```sh
node scripts/benchmarks/experience-recall-archive.mjs --rows 10000 --rounds 3 --warmup 1 --samples 7
node scripts/benchmarks/observe-cold-archive.mjs   --rows 10000 --rounds 3 --warmup 1 --samples 5
```

两个脚本都在同一进程内轮流跑两侧，基线由固定产物解包得到；每一轮都断言两侧
`state.json`、冷档案 JSONL（以及端到端场景的整棵 `dockyard/` 树）逐字节相同，
任何保留决策分歧都会让脚本直接失败。下表是三轮中位数的中位数，未混入预热。

| 路径（10,000 行 cold 档案） | 基线 wall | 优化 wall | wall Δ | 基线 CPU | 优化 CPU | CPU Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `recordObservation`，knowledge 档案 | 265.656 ms | 133.932 ms | **−49.58%** | 359.408 ms | 171.702 ms | **−52.23%** |
| `recordObservation`，observations 档案 | 140.692 ms | 85.668 ms | **−39.11%** | 148.134 ms | 88.658 ms | **−40.15%** |
| recall + 投影（对照组，未改动的路径） | 142.553 ms | 142.098 ms | −0.32% | 183.997 ms | 179.733 ms | −2.32% |
| `port.observe()`（真实端口 + 官方 JSON 后端） | 187.45 ms | 132.61 ms | **−29.26%** | 181.55 ms | 121.40 ms | **−33.13%** |

逐轮值（每轮 7/5 次测量的中位数；端到端为 wall / CPU）：

| 路径 | 轮次 / 顺序 | 基线 | 优化 |
| --- | --- | ---: | ---: |
| knowledge 档案 append | 1 / baseline→candidate | 265.656 ms | 133.526 ms |
| | 2 / candidate→baseline | 265.083 ms | 134.429 ms |
| | 3 / baseline→candidate | 269.307 ms | 133.932 ms |
| observations 档案 append | 1 / baseline→candidate | 140.957 ms | 86.761 ms |
| | 2 / candidate→baseline | 140.692 ms | 85.257 ms |
| | 3 / baseline→candidate | 139.902 ms | 85.668 ms |
| recall 对照 | 1 / baseline→candidate | 144.009 ms | 142.803 ms |
| | 2 / candidate→baseline | 142.553 ms | 141.364 ms |
| | 3 / baseline→candidate | 141.582 ms | 142.098 ms |
| `port.observe()` | 1 / baseline→candidate | 187.5 / 181.5 ms | 132.6 / 128.1 ms |
| | 2 / candidate→baseline | 187.7 / 182.2 ms | 134.6 / 121.4 ms |
| | 3 / baseline→candidate | 183.4 / 173.9 ms | 132.2 / 116.5 ms |

两个对照组的 −0.32% / −2.32%（recall 路径未改动）表明交替顺序与机器漂移没有
系统性偏向某一侧；recall 对照组在 B 组里为 +0.62% / −1.85%。

## 3. 收益边界

- 收益随**冷档案规模**增长：没有 cold 档案时，`history()` 只克隆热层
  （knowledge 上限 1,000 行、observations 上限 50 行），两条改动都测不到差异
  （约 0.25 ms 对 0.23 ms，在噪声内）。档案越大，省下的解析/拷贝/投影越多。
- 第 1 项的收益是删掉 10,000 行 knowledge 档案的整整一次读取 + 解析 + 合并 +
  深拷贝，因此近似与档案大小成正比；第 2 项删掉的是每行一次深拷贝和每行一次
  完整事件投影。
- recall 本身的成本结构没有改变：其中约九成是把 knowledge 冷档案读出来。
  只读投影与匹配（10,000 行约 15 ms）本轮没有优化，因为把档案读取限定在
  `maxConsidered` 需要跳过 JSONL 的 latest-wins / tombstone 语义，属于改变行为，
  不在本轮范围内。
- 全部数字都是本机、合成负载、热页缓存；没有测量峰值内存、磁盘物理 I/O、
  小档案、其它平台或真实生产分布，也没有声称端到端 LLM 延迟下降。
- 同一路径上的随后一轮改动（见 [`knowledge-lookup-copy.md`](knowledge-lookup-copy.md)）
  又去掉了 `#knowledgeEntryFor()` 的整段深拷贝，因此上面"读取 + 解析 + 合并 +
  深拷贝"里的最后一项现在也不再发生；本文第 2 节的表格只覆盖本文改动本身。

## 4. 验证

```sh
node --test test/dockyard-domain/knowledge-identity-equivalence.test.js
node --test test/dockyard-domain/housekeeping-equivalence.test.js test/dockyard-domain/archive-index-equivalence.test.js
node --test test/domain-storage/domain-storage-write-path-equivalence.test.js
npm test
```

本节记录的是**当前工作树**的验证状态：本文改动与随后一轮针对同一路径的改动
（见 [`knowledge-lookup-copy.md`](knowledge-lookup-copy.md)）都落在
`test/dockyard-domain/knowledge-identity-equivalence.test.js` 里，各自对固定产物
基线做差分，因此下面的测试计数是两处改动合在一起的计数。

新增差分回归 `test/dockyard-domain/knowledge-identity-equivalence.test.js` 把固定
产物解包后直接 import 成基线（不重写实现），断言：

- 24 组输入（含显式 key、`dimensions` + 陈旧 key、嵌套 diagnosis/failure、CJK、
  Date、超长文本、数字/十六进制、类名等）上 `normalizeKnowledgeEvent()` 与基线
  逐字段相同，`knowledgeKeyOf()` 恰好等于基线重算出的 key，`canonicalKnowledgeKey()`
  两边一致；
- 在一个冷 observations 档案（含一条**没有** `knowledgeKey`、只能靠重算命中的
  历史行）上跑相同的 `recordObservation()` 序列，两侧的 `state.json`、档案字节、
  `snapshot()` JSON 逐字节相同，且返回记录被改写后不影响已存状态；
- 一条冷行仍然按重算出的 key 命中：匹配的来源行被折叠、无关主体保留，两侧结论
  相同（该断言在删掉重算兜底时会失败，证明兜底路径确实被测到）。

基线锚定：`test/dockyard-domain/archive-index-baseline.js` 的逆变换表新增了本轮
4 处改动区域，使 rc.7 → 当前工作树的组合重建仍与 rc.7 固定产物逐字节相同
（`housekeeping-equivalence` / `archive-index-equivalence` 28/28 通过）。
`test/dockyard-domain/knowledge-identity-equivalence.test.js` 另有一条守卫：一旦
下一次 re-pin 把 `knowledgeKeyOf` 带进产物，该测试会明确失败，提示重新锚定，
而不是静默变成自我比较。

`npm test` 316 项：314 通过，2 项失败，均为
`test/release-pin.test.mjs` 的固定点守卫（`the working tree still builds exactly
the pinned content`、`every shipped file in the tree matches the artifact byte for
byte`）。这两项对任何改动过 `package.json#files` 内容的提交都会失败，属于预期：
`lib/` 是分发路径，改它就必须走"新版本 + 两个宿主重跑验收 + 重新固定"。
`npm run release:verify` 仍通过（`release/` 中 rc.10 的字节与内容摘要未被改动），
`npm run pack:check` 为 13 ok / 3 FAIL，3 项失败分别是
`the committed acceptance evidence matches this exact package content`、
`release/manifest.json pins this tree content`、
`the working tree still builds the pinned content`——都是"`lib/` 已改而固定点未动"的
预期结果。

**故障注入。** 上面的用例不是自我比较：对本文两处改动分别注入故障后，它们都会
失败（注入后已还原，每个用例只跑 `knowledge-identity-equivalence.test.js`）：

| 注入 | 失败用例 |
| --- | --- |
| `#append()` 不再复用已解析的 knowledge 行（`previous: null`） | `the append path stays byte-identical to the pinned implementation`、`a cold knowledge row is resolved into the same detached accumulator as before` |
| `#sourceMatches()` 只看热层、丢掉冷档案 | `a cold row without a stored key still matches by its recomputed key` |
| `knowledgeKeyOf()` 改为直接返回已存的 key、不再重算 | `the key-only projection returns exactly the recomputed key` |
| `knowledgeIdentity()` 丢掉 `scope` 维度 | 5 项失败（包括全部逐字段相等断言） |

**双官方宿主真实验收。** 在本文改动与随后一轮记录路径改动之上打包候选产物
（`contentSha256 5598a64b…`）后，两个受支持宿主各跑完整 21 步验收，**21/21 全部
通过**：

- [`docs/evidence/cold-archive-write-path-dsh-0.2.0-rc.2.json`](../evidence/cold-archive-write-path-dsh-0.2.0-rc.2.json)
- [`docs/evidence/cold-archive-write-path-dsh-0.2.1-alpha.1.json`](../evidence/cold-archive-write-path-dsh-0.2.1-alpha.1.json)

候选产物的 `contentSha256` 与固定点 rc.10 的 `1749210691d2…` 不同——**仍然没有覆盖
rc.10 的固定产物，也没有执行 `release:publish` 或任何外部发布**；
`release/manifest.json` 与 `release/*.tgz` 逐字节未变。

后续一轮对同一路径的进一步优化与其实测数据见
[`knowledge-lookup-copy.md`](knowledge-lookup-copy.md)；
`archive-index-baseline.js` 的逆变换表现在同时包含两轮的改动区域。

## 5. 复现

```sh
git stash list                     # 工作树含本轮改动即可，不需要基线 checkout
node scripts/benchmarks/experience-recall-archive.mjs --rows 10000 --rounds 3 --warmup 1 --samples 7
node scripts/benchmarks/observe-cold-archive.mjs      --rows 10000 --rounds 3 --warmup 1 --samples 5
```

两个脚本都自己从 `release/manifest.json` 指定的固定产物解包出基线，因此不需要
额外检出；`--rows` 用于标定收益边界，`--json` 输出完整原始样本。端到端脚本把
`--rows` 行写成冷 observations 档案后用真实 `openDomainStorage()` + 官方
`DomainFacility` / `JsonStorageBackend` 测量公开 `port.observe()`，冻结时钟并把
临时根路径归一化后再比较两侧持久化树。

## 6. 剩余风险

- 改动只在合成负载与本机沙箱中测量；真实宿主验收（两个宿主 21/21 通过）验证的是
  安装、生命周期、持久化与 promotion 行为，不是性能数字。若要发布，仍需按
  `RELEASE.md` 提升版本、重跑两个宿主验收并重新固定产物（本轮不提升版本，因此
  `release/` 中的固定点仍是 rc.10）。
- `copy: false` 的读取视图是类内私有用法：`#sourceMatches()` 的返回值只在
  `#shouldRetainSource()` 内被读取，且在两条返回路径上先 `clone()`；
  `#knowledgeEntryFor()` 同样在命中后 `clone()`。仓库内没有其它调用点，但未来
  若有人把该视图直接交给调用方，就会暴露内部行对象。
- `knowledgeIdentity()` 与 `normalizeKnowledgeEvent()` 共享同一段前缀代码，语义
  由差分测试对固定产物锁定；若将来再次调整维度集合，必须让两者一起变。
- 本轮未消除的记录路径成本（多个 memory 实例重复 `load()`/reconcile、
  `#sourceMatches()` 的逐行身份重算）与它们的数据见
  [`knowledge-lookup-copy.md`](knowledge-lookup-copy.md) 第 6 节。
