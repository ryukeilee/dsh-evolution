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

- 摘要只按“已提交代次”计算一次。所有持久写入都经由新的 `commitGlobal()`
  包装，写入即让缓存失效；`openDomainStorage` 之后的第一次使用仍然从介质读回
  标记表再计算，因此**进程不在运行期间发生的回滚依旧会被发现**，而进程内只有
  本端口在持有归档锁时写这张表。
- `planEventLogReplay()` 与 `eventLogCheckpointDocument()` 接受可选的
  `appliedDigest`，省略时仍按原逻辑从 `applied` 计算，直接调用方（含既有测试）
  行为不变。
- `installPending()` 接受本端口刚校验并写出的文档：`domain.global.get()` 返回的
  正是该对象，因此不再为了校验自己刚验证过的字节而重新遍历整张标记表。

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
| 事件同步 50k 历史、无新事件（CPU） | 22.658 ms | 11.430 ms | **−49.55%** | 49.57 / 49.55 / 49.45% |
| 事件同步 50k 历史、无新事件（耗时） | 22.498 ms | 11.405 ms | −49.31% | 49.47 / 49.31 / 49.15% |
| 事件同步 20k 历史、1 条新事件（CPU） | 62.902 ms | 50.832 ms | **−19.19%** | 19.12 / 18.80 / 19.22% |
| 事件同步 20k 历史、1 条新事件（耗时） | 89.843 ms | 78.898 ms | −12.18% | 11.30 / 13.21 / 13.30% |
| 语义 GC 1000 记录、canonical 0 | 62.121 ms | 61.866 ms | +0.41% | −0.63 / 1.35 / 0.26% |
| 语义 GC 1000 记录、canonical 1000 | 72.642 ms | 62.962 ms | **−13.33%** | 12.02 / 12.65 / 14.41% |
| 语义 GC 1000 记录、canonical 3000 | 94.182 ms | 67.198 ms | **−28.65%** | 28.40 / 28.64 / 29.41% |
| `EvolutionMemory.record()` 重复条目 | 1.1432 ms | 0.7722 ms | **−32.45%** | 32.05 / 35.23 / 32.20% |
| `EvolutionMemory.record()` 新条目 | 1.0603 ms | 0.6936 ms | **−34.58%** | 36.80 / 32.56 / 34.58% |
| `observation.list({ patternKey })` 1000 条 | 1.3195 ms | 0.5097 ms | **−61.37%** | 62.45 / 61.10 / 61.37% |
| `strategy.snapshot()` 1000 条 | 3.0655 ms | 1.5458 ms | **−49.58%** | 51.45 / 49.20 / 49.03% |
| `capability.snapshot()` 1000 条 | 0.8878 ms | 0.4800 ms | **−45.94%** | 45.85 / 45.94 / 45.43% |

同脚本内的对照组（未改动的调用）用于确认没有系统性漂移：
`EvolutionMemory.snapshot()` −0.05%、`observation.list()` −0.38%、
`strategy.list()` −0.92%、`capability.list()` −0.14%，均在噪声范围内；
canonical 为 0 的语义 GC 场景 +0.41%，说明收益来自被删除的扫描而不是环境差异。

## 收益边界

- 事件同步的稳态收益随历史增长：摘要成本与已提交标记数成正比，收益上限是
  原 `flush()` CPU 的一半左右；日志字节仍需完整读取并做一次带密钥前缀摘要
  （“消费过的字节未被改写”这一证明没有削弱），新事件仍走完整单事件事务、
  两次持久写入与 fsync，因此**有**新事件的路径收益明显更小。
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
返回隔离（`test/dockyard-domain/projection-snapshot.test.js`）。
