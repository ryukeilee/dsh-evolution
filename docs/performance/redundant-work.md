# 重复计算消除：语义 GC、失败记忆记录与投影快照

基线为本轮开始前的 `main` 提交
`034c3a463b822aed2e1fa437dfac9b6b45b2b01e`（已含前五轮优化）。本轮只删除
同一调用路径中重复执行的工作，不新增缓存层、不改变持久化格式、认证、fsync、
事务、恢复、回滚与跨进程锁语义，也没有修改官方 DSH 源码。原始逐轮数据见
[`redundant-work-manifest.json`](redundant-work-manifest.json) 与各基准同名
JSON；环境 Node `v26.11.1` / `darwin-arm64`。

本轮对事件同步路径（`lib/domain-storage.js`、`lib/event-log-checkpoint.js`）
提出的两项优化都在三轮独立对抗式审查后被**撤回**，见第 4 节；该路径因此
没有收益，生产代码与该路径相关的改动只剩把原有 `digestApplied()` 导出以便
回归直接断言检查点里存的值。其余四项与事件同步无关，收益如下表。

## 1. 语义 GC：每条可退休记录都线性扫描整张 canonical 表

`lib/dockyard-domain/memory.js` 的 `#retentionPlan()` 对每条可退休记录执行
`this.#data.canonical.some(...)`，在 1000 条待退休记录上退化为
O(记录 × canonical)。改为在规划开始时一次构造 canonical `recordId` 集合，
两处判断共用；比较规则（`String(canonical.recordId ?? "")`）与退休结果一致。

## 2. 失败记忆：记录时丢弃整份深拷贝

`lib/orchestrator.js` 的 `EvolutionMemory.record()` 调用
`this.compact({ save: false })` 并丢弃返回值，而 `compact()` 末尾会
`return this.snapshot()`，即 `structuredClone(this.data)`；同一路径在
`load()` 也发生一次。改为把去重与截断抽成 `retainEntries()`：`compact()`
仍然返回快照（公开契约不变），`record()`/`load()` 只做保留工作。

## 3. 投影快照重复生成整份列表

- `lib/dockyard-domain/observation.js`：`list({ patternKey })` 在过滤谓词里对
  每条记录重新规范化同一个查询词。原始类型查询改为规范化一次；非原始类型
  （带自定义 `toString`）保持逐条调用，副作用次数不变。
- `lib/dockyard-domain/continuous/strategy.js` 与
  `lib/dockyard-domain/governance/capability-registry.js`：`snapshot()` 为取计数
  把同一份列表生成（并 clone）两次，改为只生成一次。

## 4. 已撤回：事件同步路径的两项优化

### 4.1 已提交标记表摘要的跨次复用

`flush()` 每次都要用 `appliedDigest = sha256(JSON.stringify(applied))` 把已提交
标记表绑定到检查点上，该摘要与历史长度成正比（50000 条时单次约 5–12 ms）。
复用能把稳态 `flush()` 的 CPU 从 22.5 ms 降到 11.5 ms（−49%）。

两轮审查各构造出一处**本次改动新引入**的边界收窄，都在真实官方 JSON 后端上
复现：

- 第一轮：端口存活期间，同进程内官方句柄
  `storageDomain.get('evolution_domain').global.set(...)` 可以回退标记表，而
  归档锁不拦截它。复现（回退三条标记中的中间一条、追加事件、重启）：
  `middlePresent false`（基线 `true`）。
- 第二轮：即使加上 `domain/changed` 订阅与对象身份检查，**同一对象原地修改后
  再 `set`，而 `set` 在介质已替换、通知尚未发出时失败**（真实存在的情形是
  目录 `fsync` 失败）时两种信号都缺席，摘要仍会认证缺失标记。

结论：缓存的是 O(历史) 状态的派生值，而 O(1) 信号无法证明该状态未变。
因此复用**整体撤回**。

### 4.2 恢复安装：只校验“使用到的字段”

`installPending()` 在基线里用 `schema.parse(domain.global.get())` 校验整份持久
文档，但它只读取 `pending.stage`、`pending.files`（决定安装哪些文件）以及
`pending.aggregate`、`pending.applied`（交给收尾写入）；顶层 `applied` 标记表
**从未被使用**。改为在使用点校验 `pending`、`stage`、`files`，把
`aggregate`/`applied` 交给收尾的写入校验，实测把带新事件的 20000 条历史
`flush()` CPU 从 62.8 ms 降到 54.5 ms（−13.2%）。

第三轮审查指出这**改变了失败原子性**：收尾校验发生在归档安装之后，因此
`pending.aggregate` 非法时，被拒绝的调用已经把暂存文件装进了实时归档树，
而基线在安装前就拒绝、实时树保持原样。复现（在 `domain/changed` 监听器里把
`pending.aggregate` 改成 `{ evolution: { schema: 3 } }`）：

| | 抛错位置 | 本次调用改动实时归档 |
| --- | --- | --- |
| 基线 `034c3a4` | `ZodError: pending.aggregate.evolution.schema`（安装前） | `[]` |
| 仅按使用点校验 | `ZodError: aggregate.evolution.schema`（安装后） | `state.json.evolution-archive-index.json`、`state.json.observations-archive.jsonl` |

暂存记录仍在、恢复仍可重放，因此不是不可恢复的数据损坏；但“被拒绝的提交
不得改动实时树”这一边界被削弱，而把它做回可证明的形式（安装前校验整条
`pending`）只剩约 4% 收益。**因此这一项也整体撤回**，`lib/domain-storage.js`
恢复基线行为。

### 4.3 审查确认并保留的不阻断差异

- `#retentionPlan()` 一次构造 canonical id 集合，因此当 `canonical.recordId`
  存在不可 `String()` 强转的异常值时，会比基线更早、更确定地失败（基线只在
  某条记录真的走到该判断时才失败）。失败是显式的，没有静默合并或丢弃现场。
- `strategy.snapshot()` 与 `capability.snapshot()` 现在各调用一次 `list()`，
  因此若有人覆写 `list()` 使其带副作用，可观察的调用次数与计数会与基线不同；
  仓库内没有这样的覆写，`list()` 是纯投影。
- `record()`/`load()` 现在直接调用 `retainEntries()`，不再经过公开的
  `compact()`；若外部子类覆写 `compact()` 以改变保留行为，该覆写不再生效。
  仓库内没有这样的子类。

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
| 事件同步 50k 历史、无新事件（CPU） | 22.638 ms | 22.549 ms | +0.39%（无收益） | 0.69 / 0.65 / 0.04% |
| 事件同步 20k 历史、1 条新事件（CPU） | 62.668 ms | 62.558 ms | +0.18%（无收益） | −0.15 / 1.72 / 0.60% |
| 语义 GC 1000 记录、canonical 0 | 62.343 ms | 62.384 ms | +0.07%（无收益） | −2.28 / 0.40 / −0.07% |
| 语义 GC 1000 记录、canonical 1000 | 72.732 ms | 64.224 ms | **−11.70%** | 8.79 / 12.75 / 11.70% |
| 语义 GC 1000 记录、canonical 3000 | 94.475 ms | 67.519 ms | **−28.53%** | 26.87 / 28.53 / 28.85% |
| `EvolutionMemory.record()` 重复条目 | 1.1321 ms | 0.7594 ms | **−32.92%** | 32.83 / 33.29 / 32.83% |
| `EvolutionMemory.record()` 新条目 | 1.0766 ms | 0.6856 ms | **−36.32%** | 35.73 / 36.73 / 37.63% |
| `observation.list({ patternKey })` 1000 条 | 1.3183 ms | 0.5106 ms | **−61.27%** | 61.21 / 61.27 / 61.76% |
| `strategy.snapshot()` 1000 条 | 3.0507 ms | 1.5348 ms | **−49.69%** | 49.56 / 49.67 / 51.16% |
| `capability.snapshot()` 1000 条 | 0.8837 ms | 0.4866 ms | **−44.94%** | 44.94 / 44.46 / 46.77% |

同脚本内的对照组（未改动的调用）用于确认没有系统性漂移：
`EvolutionMemory.snapshot()` −0.04%、`observation.list()` −0.23%、
`strategy.list()` −0.89%、`capability.list()` −0.06%，均在噪声范围内。

## 收益边界

- 语义 GC 的收益只随 canonical 表增大而增大；canonical 为空时没有可测收益。
- `record()` 的收益来自删除被丢弃的 `structuredClone`；磁盘写入成本不在本次
  优化范围内。
- 投影快照的收益只在“列表非空且查询非空”时出现；空列表、空查询调用没有收益。
- 事件同步**没有**收益：日志字节仍需完整读取并做一次带密钥前缀摘要，标记表
  摘要仍需每次从介质读回的标记表重新计算，暂存归档仍需在安装前完成整份校验
  （这正是撤回两项优化后保留的完整性边界）。
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
回退中间标记（替换标记表对象与原地改写同一对象两种形态）、以及跨进程重启后的
同类回退，都必须被修复；通知监听器改写 `pending` 记录的四种方式（越界的
`stage`、非数组 `files`、缺 `sha256` 的条目、整体移除 `pending`）都必须失败
退出；被拒绝的提交不得把暂存文件装进实时归档树——最后一项在“安装后校验”的
实现上失败、在当前源码上通过；退休判定在 canonical 表非空时仍拒绝被引用的
记录、退休未被引用的记录（`test/dockyard-domain/failure-retention.test.js`）；
投影与快照的取值、计数、返回隔离
（`test/dockyard-domain/projection-snapshot.test.js`）。
