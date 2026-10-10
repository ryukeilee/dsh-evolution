# 重复计算消除：flush 前缀摘要、语义 GC 与投影快照

基线为本轮开始前的 `main` 提交
`034c3a463b822aed2e1fa437dfac9b6b45b2b01e`（已含前五轮优化）。本轮只删除
同一调用路径中重复执行的工作，不新增缓存层、不改变持久化格式、认证、
fsync、恢复、回滚与跨进程锁语义，也没有修改官方 DSH 源码。原始逐轮数据见
[`redundant-work-manifest.json`](redundant-work-manifest.json) 与各基准同名
JSON；环境 Node `v26.11.1` / `darwin-arm64`。

## 1. 领域事件同步：已提交标记摘要重复计算

`lib/domain-storage.js` 的每次 `flush()` 都会重放事件日志前缀。检查点
（`lib/event-log-checkpoint.js`）用 `appliedDigest = sha256(JSON.stringify(applied))`
把已提交标记表绑定到检查点上；该摘要与历史长度成正比，基线在**一次** `flush()`
里算两次：一次用于验证存储的检查点，一次用于写出新检查点。50000 条历史时
单次约 7–12 ms，占稳态 `flush()` CPU 的一半以上。

改动：

- 摘要只按“仍描述当前持久标记表”这一条件复用。失效来源有三个：本端口自己的
  每次提交；**任何**通过官方 domain 句柄的写入（官方在 `domain/changed` 上通知，
  本端口订阅并按域名过滤）；以及标记表对象被替换时（`global.get()` 返回的正是
  被写入的那个对象，因此即使通知没到也能识别）。`openDomainStorage` 之后的第一次
  使用仍然从介质读回标记表再计算，因此进程不在运行期间发生的回滚依旧会被发现。
- `planEventLogReplay()` 与 `eventLogCheckpointDocument()` 接受可选的
  `appliedDigest`，省略时仍按原逻辑从 `applied` 计算，直接调用方（含既有测试）
  行为不变。
- `installPending()` 接受本端口刚校验并写出的文档，但**只**把它当作已通过
  `schema` 结构校验的对象，并且仍然在**使用前**重新校验它真正读取的字段
  （`stage` 与 `files`，复用同一组字段 schema，不是第二套规则）。`aggregate` 与
  标记表由收尾的 `commitGlobal()` 重新校验，因此“先使用后校验”没有出现：
  官方会把同一个对象交给所有 `domain/changed` 监听器，改写后的 pending 记录
  依旧会失败退出，而不是被当作旧格式执行整树复制，也不会把 `stage` 当路径使用。

## 2. 语义 GC：每个记录线性扫描整张 canonical 表

`lib/dockyard-domain/memory.js` 的 `#retentionPlan()` 对每条可退休记录都执行
`this.#data.canonical.some(...)`，在 1000 条待退休记录上退化为 O(记录 × canonical)。
改为在规划开始时一次构造 canonical `recordId` 集合，两处判断共用；
比较规则（`String(canonical.recordId ?? "")`）与退休结果完全一致。

## 3. 失败记忆：记录时丢弃整份深拷贝

`lib/orchestrator.js` 的 `EvolutionMemory.record()` 调用
`this.compact({ save: false })` 并丢弃返回值，而 `compact()` 末尾会
`return this.snapshot()`，即 `structuredClone(this.data)`。同一路径在 `load()`
也发生一次。改为把去重与截断抽成 `retainEntries()`：`compact()` 仍然返回快照
（公开契约不变），`record()`/`load()` 只做保留工作。

## 4. 投影快照重复生成整份列表

- `lib/dockyard-domain/observation.js`：`list({ patternKey })` 在过滤谓词里对
  每条记录重新规范化同一个查询词。原始类型查询改为规范化一次；非原始类型
  （带自定义 `toString`）保持逐条调用，副作用次数不变。
- `lib/dockyard-domain/continuous/strategy.js` 与
  `lib/dockyard-domain/governance/capability-registry.js`：`snapshot()` 为取计数
  把同一份列表生成（并 clone）两次，改为只生成一次。

## 独立审查与修复

本轮的性能改动在固定前经过一次独立对抗式审查。审查用真实代码构造了两个
反例，都在本仓库的官方 JSON 后端上复现；两处都是**本次改动新引入**的边界收窄，
已修复并补回归（新回归在修复前失败、修复后通过）：

1. **摘要复用曾在端口存活期间被第三方写入绕过。** 归档锁不拦截同一进程内
   `ctx.storageDomain.get('evolution_domain').global.set(...)` 这个官方句柄。
   复现（回退三条标记中的中间一条、再追加一条事件、重启）：修复前
   `markers 3 middlePresent false`，基线 `markers 4 middlePresent true`；新检查点
   因此认证了已经缺一条标记的状态，缺失标记跨重启不再被修复。修复后与基线
   一致。回归：`test/domain-storage/event-log-checkpoint.test.js`
   “a marker rewound through the official handle while the port is alive is repaired”。
2. **已校验的 pending 文档可在写入后被通知回调就地改写。** 官方把写出的对象
   交给每个 `domain/changed` 监听器。复现：监听器把 `pending.stage` 改成
   `../../escape`，修复前该字符串被直接用于拼路径
   （`E_DOMAIN_PENDING_ARCHIVE_MISSING`，即已越过校验到达文件系统），基线为
   `ZodError`；把 `pending.files` 改成 `null`，修复前静默按“旧版本无文件清单”
   执行整树复制，基线为 `ZodError`。修复后两者都失败退出。回归：同文件
   “a listener that rewrites the pending record cannot bypass its validation”。

审查同时给出两项**不阻断**的差异，保留并记录：

- `#retentionPlan()` 现在在规划开始时一次构造 canonical id 集合，因此当
  `canonical.recordId` 存在不可 `String()` 强转的异常值时，会比基线更早、
  更确定地失败（基线只在某条记录真的走到该判断时才失败）。失败是显式的，
  没有静默合并或丢弃现场。
- `strategy.snapshot()` 与 `capability.snapshot()` 现在各调用一次 `list()`，
  因此若有人覆写 `list()` 使其带副作用，可观察的调用次数与计数会与基线不同；
  仓库内没有这样的覆写，`list()` 是纯投影。

审查未覆盖的部分（本轮末次固定时另行执行）：性能数字与原始 JSON 的复核、
README/RELEASE/CHANGELOG 措辞、完整 `npm test`、发布固定点与双宿主真实验收。

## 可复现对比

同一脚本、同一参数、两侧各自 checkout，每轮交替先后顺序，3 轮取中位数。
基线目录由 `git archive 034c3a4 | tar -x -C <dir>` 加 `node_modules` 软链和
同名脚本构成。基准脚本带行为断言（退休条数、快照计数、过滤结果、保留条数），
更快的实现若改变结果会直接失败。

```sh
node --expose-gc scripts/benchmarks/domain-retention.mjs
node --expose-gc scripts/benchmarks/orchestrator-record.mjs
node --expose-gc scripts/benchmarks/domain-projections.mjs
BENCH_EVENTS=50000 BENCH_NEW_EVENTS=0 BENCH_SAMPLES=15 node --expose-gc scripts/benchmarks/domain-replay.mjs
BENCH_EVENTS=20000 BENCH_NEW_EVENTS=1 BENCH_SAMPLES=15 node --expose-gc scripts/benchmarks/domain-replay.mjs
```

| 路径 | 基线 | 优化后 | 变化 | 各轮 |
| --- | ---: | ---: | ---: | --- |
| 事件同步 50k 历史、无新事件（CPU） | 22.543 ms | 11.472 ms | **−49.11%** | 49.27 / 48.96 / 49.62% |
| 事件同步 50k 历史、无新事件（耗时） | 22.407 ms | 11.397 ms | −49.14% | 49.11 / 49.14 / 49.56% |
| 事件同步 20k 历史、1 条新事件（CPU） | 62.836 ms | 50.413 ms | **−19.77%** | 19.77 / 20.52 / 19.33% |
| 事件同步 20k 历史、1 条新事件（耗时） | 90.906 ms | 77.929 ms | −14.28% | 14.29 / 13.23 / 15.09% |
| 语义 GC 1000 记录、canonical 0 | 61.955 ms | 61.374 ms | +0.94% | −0.24 / 1.04 / −0.15% |
| 语义 GC 1000 记录、canonical 1000 | 72.248 ms | 62.647 ms | **−13.29%** | 13.24 / 13.29 / 11.04% |
| 语义 GC 1000 记录、canonical 3000 | 94.119 ms | 67.051 ms | **−28.76%** | 28.86 / 28.76 / 27.77% |
| `EvolutionMemory.record()` 重复条目 | 1.1395 ms | 0.7644 ms | **−32.92%** | 31.82 / 32.00 / 33.00% |
| `EvolutionMemory.record()` 新条目 | 1.0408 ms | 0.6708 ms | **−35.55%** | 35.91 / 33.92 / 35.55% |
| `observation.list({ patternKey })` 1000 条 | 1.3211 ms | 0.5087 ms | **−61.49%** | 58.63 / 61.72 / 61.49% |
| `strategy.snapshot()` 1000 条 | 3.0577 ms | 1.5476 ms | **−49.39%** | 48.77 / 49.39 / 49.77% |
| `capability.snapshot()` 1000 条 | 0.8850 ms | 0.4800 ms | **−45.77%** | 45.02 / 45.95 / 46.37% |

同脚本内的对照组（未改动的调用）用于确认没有系统性漂移：
`EvolutionMemory.snapshot()` +0.13%、`observation.list()` +0.56%、
`strategy.list()` −1.65%、`capability.list()` +0.14%，均在噪声范围内；
canonical 为 0 的语义 GC 场景 +0.94%，说明收益来自被删除的扫描而不是环境差异。
上表是修复审查发现后重新采集的最终源码数据，与修复前相比各路径无退化。

## 收益边界

- 事件同步的稳态收益随历史增长：摘要成本与已提交标记数成正比，收益上限是
  原 `flush()` CPU 的一半左右；日志字节仍需完整读取并做一次带密钥前缀摘要
  （“消费过的字节未被改写”这一证明没有削弱），新事件仍走完整单事件事务、
  两次持久写入与 fsync，因此**有**新事件的路径收益明显更小。摘要复用依赖
  “域名下的任何持久写入都会让它失效”，因此比“只信任本端口”多一次订阅与
  一次对象身份比较，两者都是 O(1)。
- 语义 GC 的收益只随 canonical 表增大而增大；canonical 为空时没有可测收益。
- `record()` 的收益来自删除被丢弃的 `structuredClone`；其绝对值随条目数和
  单条大小增长，磁盘写入成本不在本次优化范围内。
- 投影快照的收益只在“列表非空且查询非空”时出现；空列表、空查询调用没有收益。
- 所有数字都是本机、合成负载、热页缓存；采样分配与 maxRSS 本轮未测量，因此
  不声称内存占用下降。收益不可相加，也不代表其他平台或生产规模。

## 验证

```sh
node --test test/domain-storage/event-log-checkpoint.test.js test/dockyard-domain/failure-retention.test.js
node --test test/dockyard-domain/projection-snapshot.test.js
npm test
```

新增回归：检查点存储的标记摘要必须始终描述已提交的标记表（含稳态复用与
提交后推进两个方向，见 `test/domain-storage/event-log-checkpoint.test.js`）；
退休判定在 canonical 表非空时仍拒绝被引用的记录、退休未被引用的记录
（`test/dockyard-domain/failure-retention.test.js`）；投影与快照的取值、计数、
返回隔离（`test/dockyard-domain/projection-snapshot.test.js`）；以及独立审查
发现的两个反例：端口存活期间经官方句柄回退中间标记、通知监听器改写 pending
记录（均在 `test/domain-storage/event-log-checkpoint.test.js`）。
