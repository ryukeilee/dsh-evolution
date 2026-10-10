# 重复计算消除：语义 GC、失败记忆记录、投影快照与恢复安装

基线为本轮开始前的 `main` 提交
`034c3a463b822aed2e1fa437dfac9b6b45b2b01e`（已含前五轮优化）。本轮只删除
同一调用路径中重复执行或**根本未被使用**的工作，不新增缓存层、不改变
持久化格式、认证、fsync、事务、恢复、回滚与跨进程锁语义，也没有修改官方
DSH 源码。原始逐轮数据见 [`redundant-work-manifest.json`](redundant-work-manifest.json)
与各基准同名 JSON；环境 Node `v26.11.1` / `darwin-arm64`。

## 1. 恢复安装：校验了整份文档，却只用到两个小字段

`lib/domain-storage.js` 的 `installPending()` 在基线里用
`schema.parse(domain.global.get())` 校验整份持久文档，但它实际只读取
`pending.stage`、`pending.files`（用来决定安装哪些文件）以及
`pending.aggregate`、`pending.applied`（交给收尾写入）。其中顶层 `applied`
标记表**从未被使用**，而它与 `pending.applied` 都是 O(历史) 的；一次
`mutate()` 因此要把整张标记表校验多次。

改动：`mutate()` 把它刚刚校验并写出的文档传给 `installPending(known)`，安装
路径改为**在使用点校验它使用的字段**——`pending` 本身与 `stage`、`files`
用同一组字段 schema（`pendingInstallSchema`，与文档 schema 共用
`stageNameSchema` / `pendingFilesSchema`，不是第二套规则）重新校验，
`aggregate` 与标记表由收尾的 `schema.parse` 在写入前校验。因此
“先使用后校验”没有出现：官方会把写出的同一个对象交给所有
`domain/changed` 监听器，改写后的记录依旧失败退出，而不是被当作旧格式
执行整树复制，也不会把 `stage` 当路径使用。没有 `known` 的调用方（启动恢复）
仍走完整读取校验。

## 2. 语义 GC：每条可退休记录都线性扫描整张 canonical 表

`lib/dockyard-domain/memory.js` 的 `#retentionPlan()` 对每条可退休记录执行
`this.#data.canonical.some(...)`，在 1000 条待退休记录上退化为
O(记录 × canonical)。改为在规划开始时一次构造 canonical `recordId` 集合，
两处判断共用；比较规则（`String(canonical.recordId ?? "")`）与退休结果一致。

## 3. 失败记忆：记录时丢弃整份深拷贝

`lib/orchestrator.js` 的 `EvolutionMemory.record()` 调用
`this.compact({ save: false })` 并丢弃返回值，而 `compact()` 末尾会
`return this.snapshot()`，即 `structuredClone(this.data)`；同一路径在
`load()` 也发生一次。改为把去重与截断抽成 `retainEntries()`：`compact()`
仍然返回快照（公开契约不变），`record()`/`load()` 只做保留工作。

## 4. 投影快照重复生成整份列表

- `lib/dockyard-domain/observation.js`：`list({ patternKey })` 在过滤谓词里对
  每条记录重新规范化同一个查询词。原始类型查询改为规范化一次；非原始类型
  （带自定义 `toString`）保持逐条调用，副作用次数不变。
- `lib/dockyard-domain/continuous/strategy.js` 与
  `lib/dockyard-domain/governance/capability-registry.js`：`snapshot()` 为取计数
  把同一份列表生成（并 clone）两次，改为只生成一次。

## 5. 已撤回：事件同步的已提交标记摘要复用

本轮最初还让每次 `flush()` 复用“已提交标记表摘要”（`sha256(JSON.stringify(applied))`，
O(历史)，50000 条时单次约 5–12 ms）。基线在一次稳态 `flush()` 里算一次、
在带新事件时算两次，复用能把稳态 CPU 从 22.5 ms 降到 11.5 ms（−49%）。

两轮独立对抗式审查各自构造出**本次改动新引入**的边界收窄，都已在真实官方
JSON 后端上复现：

- 第一轮：端口存活期间，同进程内官方句柄
  `storageDomain.get('evolution_domain').global.set(...)` 可以回退标记表，
  而归档锁不拦截它。复现（回退三条标记中的中间一条、追加事件、重启）：
  `middlePresent false`（基线 `true`）。
- 第二轮：即使加上 `domain/changed` 订阅与对象身份检查，**同一对象原地修改后
  再 `set`，而 `set` 在介质已替换、通知尚未发出时失败**（真实存在的情形是
  目录 `fsync` 失败）时两种信号都缺席，摘要仍会认证缺失标记。

结论是：复用缓存的是 O(历史) 状态的派生值，而 O(1) 信号无法证明该状态未变。
因此该优化**整体撤回**，`lib/domain-storage.js` 与
`lib/event-log-checkpoint.js` 恢复基线行为（摘要每次从介质读回的标记表重新
计算，`installPending()` 无 `known` 时仍完整校验）。下面表格里稳态事件同步
因此没有收益；第 1 节的收益与它无关，仍然成立。

两轮审查同时确认并保留了以下**不阻断**差异：

- `#retentionPlan()` 一次构造 canonical id 集合，因此当 `canonical.recordId`
  存在不可 `String()` 强转的异常值时，会比基线更早、更确定地失败（基线只在
  某条记录真的走到该判断时才失败）。失败是显式的，没有静默合并或丢弃现场。
- `strategy.snapshot()` 与 `capability.snapshot()` 现在各调用一次 `list()`，
  因此若有人覆写 `list()` 使其带副作用，可观察的调用次数与计数会与基线不同；
  仓库内没有这样的覆写，`list()` 是纯投影。
- `mutate()` 的默认参数在 `installPending()` 之前读取 `applied`，这一顺序在
  基线已存在，不是本轮引入。

## 可复现对比

同一脚本、同一参数、两侧各自 checkout，每轮交替先后顺序，3 轮取中位数。
基线目录由 `git archive 034c3a4 | tar -x -C <dir>` 加 `node_modules` 软链和
同名脚本构成。基准脚本带行为断言（退休条数、快照计数、过滤结果、保留条数、
`flush()` 返回值），更快的实现若改变结果会直接失败。

```sh
node --expose-gc scripts/benchmarks/domain-retention.mjs
node --expose-gc scripts/benchmarks/orchestrator-record.mjs
node --expose-gc scripts/benchmarks/domain-projections.mjs
BENCH_EVENTS=50000 BENCH_NEW_EVENTS=0 BENCH_SAMPLES=15 node --expose-gc scripts/benchmarks/domain-replay.mjs
BENCH_EVENTS=20000 BENCH_NEW_EVENTS=1 BENCH_SAMPLES=15 node --expose-gc scripts/benchmarks/domain-replay.mjs
```

| 路径 | 基线 | 优化后 | 变化 | 各轮 |
| --- | ---: | ---: | ---: | --- |
| 事件同步 50k 历史、无新事件（CPU） | 22.566 ms | 22.631 ms | +0.29%（无收益） | 0.47 / 0.66 / −0.75% |
| 事件同步 20k 历史、1 条新事件（CPU） | 62.751 ms | 54.455 ms | **−13.22%** | 12.95 / 14.14 / 13.07% |
| 事件同步 20k 历史、1 条新事件（耗时） | 90.886 ms | 81.903 ms | −9.88% | 9.88 / 10.83 / 10.02% |
| 语义 GC 1000 记录、canonical 0 | 61.936 ms | 62.041 ms | +0.17%（无收益） | −0.14 / −0.17 / −0.42% |
| 语义 GC 1000 记录、canonical 1000 | 72.720 ms | 62.199 ms | **−14.47%** | 14.42 / 15.43 / 11.41% |
| 语义 GC 1000 记录、canonical 3000 | 94.406 ms | 67.492 ms | **−28.51%** | 28.51 / 28.98 / 28.09% |
| `EvolutionMemory.record()` 重复条目 | 1.1506 ms | 0.7619 ms | **−33.78%** | 32.97 / 34.21 / 33.80% |
| `EvolutionMemory.record()` 新条目 | 1.0679 ms | 0.6824 ms | **−36.10%** | 35.94 / 35.10 / 37.39% |
| `observation.list({ patternKey })` 1000 条 | 1.3108 ms | 0.5110 ms | **−61.02%** | 60.63 / 61.14 / 61.26% |
| `strategy.snapshot()` 1000 条 | 3.0581 ms | 1.5529 ms | **−49.22%** | 49.56 / 48.79 / 49.22% |
| `capability.snapshot()` 1000 条 | 0.8785 ms | 0.4849 ms | **−44.81%** | 45.63 / 44.81 / 45.48% |

同脚本内的对照组（未改动的调用）用于确认没有系统性漂移：
`EvolutionMemory.snapshot()` −0.04%、`observation.list()` −1.19%、
`strategy.list()` −1.28%、`capability.list()` −0.27%，均在噪声范围内。

## 收益边界

- 第 1 节的收益只出现在**有**新事件（或启动恢复有 pending 记录）的路径上，
  绝对值随已提交标记数增长；它不减少任何持久写入、fsync 或日志读取。
- 语义 GC 的收益只随 canonical 表增大而增大；canonical 为空时没有可测收益。
- `record()` 的收益来自删除被丢弃的 `structuredClone`；磁盘写入成本不在本次
  优化范围内。
- 投影快照的收益只在“列表非空且查询非空”时出现；空列表、空查询调用没有收益。
- 稳态事件同步**没有**收益：日志字节仍需完整读取并做一次带密钥前缀摘要，
  标记表摘要仍需每次从介质读回的标记表重新计算（这正是撤回复用后保留的
  完整性边界）。
- 所有数字都是本机、合成负载、热页缓存；采样分配与 maxRSS 本轮未测量，因此
  不声称内存占用下降。收益不可相加，也不代表其他平台或生产规模。

## 验证

```sh
node --test test/domain-storage/event-log-checkpoint.test.js test/dockyard-domain/failure-retention.test.js
node --test test/dockyard-domain/projection-snapshot.test.js
npm test
```

新增回归：检查点存储的标记摘要必须始终描述已提交的标记表
（`test/domain-storage/event-log-checkpoint.test.js`）；端口存活期间经官方句柄
回退中间标记、以及跨进程重启后的同类回退，都必须被修复；通知监听器改写
`pending` 记录的四种方式（越界的 `stage`、非数组 `files`、缺 `sha256` 的条目、
整体移除 `pending`）都必须失败退出——这一项在 `40d0e08` 上失败、在撤回复用后
的源码上通过；退休判定在 canonical 表非空时仍拒绝被引用的记录、退休未被引用
的记录（`test/dockyard-domain/failure-retention.test.js`）；投影与快照的取值、
计数、返回隔离（`test/dockyard-domain/projection-snapshot.test.js`）。
