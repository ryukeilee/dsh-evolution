# 投影跳过：四次"构建完又丢弃"的整份热投影

本轮只改生产代码里**构建后被丢弃的返回值**：`lib/domain-storage.js` 的两次
`load()`、`lib/dockyard-domain/observation.js` 的 `record()` 内部加载，以及该
store 读取共享 Memory 观测窗口的方式。改动给两个加载器加了一个显式的
`{ snapshot: false }`（默认行为不变），把"整份热投影深拷贝"从四条真实调用链上移除。
**没有任何校验或持久化语义被删除**：加载本身（状态读取、archive index
重建、淘汰与归档、冷历史强转）全部保留，跳过的只是加载末尾那次
`clone(this.#data)`。唯一的可观察差异是**“不可投影值”的报错时机**（见 3.3 第 2 条）：
跳过投影的纯领域调用会等到第一次真正投影时才报同一个 `RangeError`；官方端口在
`openDomainStorage()` 之前的 schema 读取里就已经拒绝这种文档，因此端口路径上的
接受范围不变。未修改官方 DSH 源码，未触碰 `release/` 固定产物。

原始数据（本轮实际运行，未引用历史数字）：

- [`load-projection.json`](load-projection.json) —— 整树 A/B 的完整 JSONL：
  等价性事件、每条实测样本、汇总与两侧的分配归因；
- 复现命令（`--baseline <commit>` 与 `--attribute` 是本轮为整树对比新增的加法选项，
  既有 `--memory` 单文件锚定路径不变）：

  ```sh
  node scripts/benchmarks/domain-write-commit.mjs \
    --writes 400 --sessions 3 --warmup 1 --baseline 741b749 --attribute
  ```

环境：Node `v26.11.1` / `darwin/arm64`，Apple M2，8 逻辑 CPU、16 GiB 内存。
两次 A/B 启动时的 load average 分别为 `2.99 / 2.34 / 1.93`（第一次，紧接前一轮
探针之后）与 `2.07 / 2.30 / 2.30`（第二次，紧接一轮已结束的完整 `npm test` 之后），
运行中抽样为 `1.89 / 2.15 / 2.24`；两次测量期间除该基准自身外没有运行其它基准、
测试、探针或验收，也没有并行编辑源码。CPU 为 `process.cpuUsage()`
的 user+system 增量。

## 1. 四个真实成本

运行时入口是 agent 错误/工具结果观察器：`lib/registration.js:343-372`
（`ctx.on(...)` 回调）→ `config.domainStorage.observe(projectObservation(dto))`
→ `lib/domain-storage.js:280`（`enqueue`）→ `lib/domain-storage.js:172`（`mutate`）。
每次 `mutate` 都是"重建 Memory → 工作 → 提交 → 再重建 Memory"，其中构建后立即
被丢弃的热投影有四处：

1. `lib/domain-storage.js:152` `await instance.load();` —— `createMemory()` 需要的是
   加载本身的副作用（恢复状态、重建 archive index、淘汰与归档），返回值无人读；
2. `lib/domain-storage.js:167` `await observations.load();` —— `hydrate()` 保留这次
   调用是为了它**不是惰性的**（见 `domain-write-path.md` 第 4.2 节的反例），返回值同样无人读；
3. `lib/dockyard-domain/observation.js:237` `await this.load();` —— `record()` 只用
   `this.entries`，不用返回值；
4. `lib/dockyard-domain/observation.js:210` `await this.memory.load()` —— 只取
   `state.observations` 一个数组，却先深拷贝整份 Memory（`knowledge` 可达
   `maxEntries` = 1000 行，另有十余个集合）。

`EvolutionMemory.snapshot()` 是 `clone(this.#data)`，`clone()` 是
`structuredClone()` 加手工回退；它对 `#data` 只读，因此"跳过构建"与"构建后丢弃"
在被丢弃的那条路径上等价（第 3 节给出差分证据；唯一例外是投影本身会抛出
`RangeError` 的极端输入，见第 3.3 节第 2 条）。

实测归因（400 次 `observe()`，`--attribute` 的无计时通道，每写计数）：

| 每次写入 | 基线 | 本轮 | 变化 |
| --- | --- | --- | --- |
| `EvolutionMemory.load` 调用 | 4.01 | 4.01 | 0 |
| `EvolutionMemory.snapshot` **构建次数** | 5.01 | 1.00 | **−80.0%** |
| 其可序列化体积 | 2 136 650 B | 427 381 B | **−80.0%** |
| `EvolutionObservationStore.load` 调用 | 2.005 | 2.005 | 0 |
| `EvolutionObservationStore.snapshot` 构建次数 | 2.005 | 0 | −100% |
| `structuredClone` 调用次数 | 302.9 | 203.0 | **−33.0%** |
| 上述两类投影合计体积 | 2 436 708 B | 427 381 B | **−82.5%** |

即每次写入少构建 **4 次整份 Memory 热投影**（2.32 MiB → 0.41 MiB 的深拷贝量），
以及观测 store 自己那份投影（401 行负载下，两段合计约 300 KB；每份由
`observations` / `hot` / `warm` 三段克隆组成）。

## 2. 改动

1. **`EvolutionMemory.load({ snapshot = true } = {})`**：整段加载逻辑不变，仅把
   末尾 `return this.snapshot()` 换成按参数决定是否构建。并发路径保持原有语义：
   第一个调用者把它的投影随 `this.loading` 交给并发调用者（`shared ?? this.snapshot()`），
   失败仍会清空 `this.loading` 以便重试。
2. **`EvolutionObservationStore.load({ snapshot = true } = {})`**：
   - 记忆端口分支先 `await this.memory.load({ snapshot: false })`，再用文档化的
     `history("observations", { includeArchived: false })` 只取这一集合的热窗口——
     与原来 `snapshot().observations` 是同一批行（同一顺序、同一深拷贝语义），
     只是不再连带克隆其它集合。只声明最小端口的调用方仍走原来的
     `(await this.memory.load()).observations` 分支。
   - 新增私有 `#projection(snapshot)`：`{ snapshot: false }` 只跳过**返回值**，
     不跳过**冷历史读取**。该 getter 会对每个 `coldArchives` 条目做
     `Number(count)`，是 `hydrate()` 依赖的强失败点；它在每一条路径上（包括
     `loaded` 直接返回与并发共享路径）都执行。第一版实现只在"真正加载过"的
     那条路径上读它，独立复核给出了真实分歧（见第 3.3 节第 1 条）。
   - `record()` 内部改为 `await this.load({ snapshot: false })`。
3. **`lib/domain-storage.js`**：`createMemory()` 与 `hydrate()` 的两处调用传入
   `{ snapshot: false }`，注释同步更新为"丢弃的是返回值，不是加载本身"。

**明确未动**：

- `installPending()` 的整份文档 `schema.parse`（每次 `mutate` 三次）与
  `aggregateSchema` 的 `toJsonProjection`。这三处校验是恢复边界的权威
  （`domain-write-path.md` 第 4.1 节的删减尝试被 16 411 个差分输入击穿），
  本轮的 profile 里 zod 约占总 CPU 的 22.7%、`toJsonProjection` 约 5.0%，
  属"风险高于收益"的候选，整体放弃；
- archive 镜像/`fsync`（约 22.7%）与官方 JSON 后端序列化（约 2.5%）：前者是持久化
  承诺，后者不在本仓库；
- `lineage.load()` 的同形读取：该模块尚未接入实时循环，不在热路径上，不做无谓改动。

## 3. 等价性依据

### 3.1 整树差分（本轮新增）

`test/domain-storage/domain-storage-baseline.js` 的单文件锚定只还原
`lib/domain-storage.js`，其兄弟模块**故意**指向工作树，因此看不到本轮对
`memory.js` / `observation.js` 的改动。本轮另建
[`test/domain-storage/load-projection-baseline.js`](../../test/domain-storage/load-projection-baseline.js)：
7 个 `[改动后文本, 改动前文本]` 片段（每个都带"必须恰好出现一次"的守卫）把三份源码
**反向还原成改动前的整棵 `lib/` 树**，并在测试时以真实模块导入；两棵树共用同一份
`node_modules`（符号链接），所以差别只有实现本身。

`test/domain-storage/load-projection-equivalence.test.js` 的七个用例：

1. 反转必须真的改变三份文件、且还原后的源码里不再出现 `snapshot: false`；
2. 整树差分：冻结时钟 + 确定性 `randomUUID`，同一 fixture 路径上跑 80 次
   `observe()`，要求**实时查询投影、重启后投影、持久化树的每个字节**逐一相同，
   并断言该负载确实产生了冷档案段（否则比较不到淘汰与归档路径）；
3. 观测 store 自身路径的差分：两段 session（第二段重建 Memory 以触发淘汰/归档）
   覆盖 dedup 刷新、>5% 性能变化、`deferStablePersistence`、`forceRecord`、
   窗口内重复与窗口外重复，比较 `record()` 每次返回值、`store.snapshot()`、
   `store.list()`、`store.entries`、`memory.snapshot()`、`memory.fullSnapshot()`
   与归档文件字节；
4. 契约：`load({ snapshot: false })` 返回 `undefined`、仍置 `loaded`、随后 `load()`
   返回等价快照、未加载实例的两个并发 `load()` 仍共享同一份投影；
5. `domain-write-path.md` 第 4.2 节那个不可强转的 `coldArchives` 条目，在
   `load()` 与 `load({ snapshot: false })` 两条路径上都必须继续以同一个 `TypeError`
   拒绝（并给出健康状态下 `{ snapshot: false }` 仍然填充 `entries` 的正例）；
6. 同一实例上"先失败、后写入"必须继续被拒：加载失败后 `loaded` 已被置位，
   下一次 `record()` 不得因为跳过了投影而静默落盘（既有实现同样拒绝，两侧逐个断言
   失败类型与介质是否被写入）；
7. 深到无法投影的文档（8 000 层）仍被真实端口以同一种错误拒绝：这是本轮唯一的
   接受范围差异的**可达性上限**，见第 3.3 节第 2 条。

### 3.2 既有守卫的移动

- `test/domain-storage/domain-storage-baseline.js`：新增两条反转片段，使 rc.8 固定
  产物的重建仍然逐字节成立；`…-equivalence.test.js` 里"被撤回的第四项必须保留"
  的断言改为匹配新的 `await observations.load({ snapshot: false });` 并额外断言旧的
  裸 `load()` 形式**不再存在**——检查的是同一件事（store 仍在构造并加载），
  而冷历史强转由行为用例固定，不再依赖字面文本；
- `test/dockyard-domain/archive-index-baseline.js`：新增两条片段，使 rc.7 锚点的
  重建（`retention-plan-equivalence.test.js` 等的基线）继续逐字节成立。

### 3.3 独立对抗式复核：一个真实分歧与两个边界

本轮提交前请独立复核（另一个 provider 的 agent，给出与被审代码不同的推理路径）
逐条审查了"跳过投影"的等价性主张，并为每条主张寻找反例。结论如下。

**（1）已修正：加载失败后的 `record()` 曾能绕过冷历史检查。**
第一版只在"真正执行了加载"的那条路径上执行冷历史强转；`this.loaded = true` 是在
投影抛错**之前**设置的（这一点本仓库与已发布实现相同），因此一个状态损坏的实例在
`load()` 失败后，`record()` 里的 `load({ snapshot: false })` 会走 `loaded` 直接返回
分支、不读冷历史而成功落盘。复核给出的复现：不可强转的 `coldArchives` 条目下，
基线两次都是 `TypeError`、持久化记录数为 0，第一版第二次返回成功并写入 1 条记录。
这是与 `domain-write-path.md` 第 4.2 节同一类的"静默放宽失败边界"，因此**修正**为
`#projection(snapshot)` 在包括该路径在内的每一条返回路径上执行冷历史读取。
新测试（`load-projection-equivalence.test.js` 的失败后重试用例）以改动前的整棵树为
对照，两侧都必须是 `{ first: TypeError, second: TypeError, persisted: false }`。
该守卫的**敏感性已实测**：把第一版的两处 early-return 还原成缺陷形状后，同一用例在
该变体上得到 `{ first: TypeError, second: "resolved", persisted: true }`（即复核
报告的分歧），修正后的工作树返回 `TypeError`。

**（2）已记录：跳过整份投影会改变"不可投影值"的报错时机。**
`clone()` 是 `structuredClone()` 加递归回退，对约 3 000 层以上嵌套的值会以
`RangeError` 拒绝。改动前，Memory 加载末尾的整份投影会先碰到该值而抛出；改动后，
如果调用方不要投影，加载不再遍历它，于是同一份状态被接受，直到某次真正的投影
（`snapshot()` / `fullSnapshot()` / `compact()`）才会以同一错误拒绝。
**可达性上限已固定为回归用例**：官方 domain facility 在读取存储的 global 时会用插件
声明的 schema 校验它，并先把递归校验的 `RangeError` 转成
`DomainError: domain 'evolution_domain': stored global does not match its schema`
（`@deepseek-ai/dsh-storage-domain` 的读取路径），该步发生在 `openDomainStorage()`
创建任何 Memory **之前**；单独调用同一 schema 也直接得到 `RangeError`。因此这种文档
根本进不了端口，两棵树必须以同一种错误拒绝（新用例第 7 条，用 8 000 层文档同时验证
拒绝结果与错误类型相同）。差异只在宿主直接驱动 `EvolutionMemory`（纯领域端口）
且只调用不要投影的加载时可见：变宽的接受范围不是数据本身，而是"何时报错"——
该值仍会在第一次投影时被拒，没有任何校验被删除。

**（3）已记录：混合模式下并发调用者不再共享同一个投影对象。**
改动前唯一可能的并发是"两个默认 `load()` 共享第一个调用者的投影对象"；这一点
逐字节保持不变（新用例断言 `left === right`）。当**第一个**调用者要求跳过投影时，
同时到达的默认调用者不再拿到共享对象，而是各自构建一份内容相等的投影。这个组合在
改动前无法表达（`load()` 没有选项），仓内也没有任何调用点这样并发加载，因此它不是
回归，而是新 API 组合的已固定语义。两个加载器的返回规则并不相同：`EvolutionMemory`
在并发分支上按本次调用的 flag 筛选，跳过者得到 `undefined`，默认调用者**一定**拿到
一份投影（可能是自己构建的那份）；`EvolutionObservationStore` 保留已发布实现的
`return this.loading` 语义，把**首方的返回值原样交给后来者**，因此“跳过者一定得到
`undefined`”在这个 store 上只在该次加载由跳过者发起时成立——默认调用者先发起时，随后
到达的跳过者会收到那个投影对象（它不读返回值，所以不影响结果）。两个 store 的这两种
顺序都由用例钉住（`load-projection-equivalence.test.js` 的
“load({ snapshot: false }) loads the state and skips only the projection”与
“the observation store hands a concurrent caller the first load value, skip or not”）。

复核同时逐字节验证了两个反转表仍能重建 rc.8 / rc.7 锚点、新增差分测试确实加载了
不同的三份实现、且负载确实触发 dedup、归档与冷层；失败后清空 `loading` 并可重试的
行为与改动前一致。其中第 1 条修正后，又以同一命令重跑了完整的整树 A/B（第 4 节）。

## 4. 实测

整树 A/B，400 次 `observe()`，3 个计时 session + 1 个预热，逐轮交替
baseline/after 顺序，取中位数（`load-projection.json` 即本表数据；命令见文首）：

| 指标 | 改动前 | 改动后 | 变化 |
| --- | --- | --- | --- |
| CPU（user+system） | 29 316.7 ms | 26 687.5 ms | **−8.97%** |
| 每写 CPU | 73.29 ms | 66.72 ms | −8.97% |
| 每写中位耗时 | 97.81 ms | 89.19 ms | **−8.81%** |
| 每 session 中位耗时 | 96.51 ms | 90.01 ms | −6.74% |
| 稳态末桶中位耗时 | 141.31 ms | 129.88 ms | −8.09% |
| 总墙钟 | 37 825.6 ms | 35 170.7 ms | −7.02% |

三个计时 session 的每写 CPU 分别为 74.11 / 72.92 / 73.29 ms（改动前）与
66.35 / 66.72 / 67.01 ms（改动后）：**改动后的每一个样本都低于改动前的每一个样本**，
区间不重叠。持久化形状两侧相同（`globalBytes` 1 419 231、archive 1 个段
373 488 B、hot 观测 401、knowledge 401），四次等价性事件全部通过，否则脚本以
非零码退出。

本节数据在复核修正之前跑过一次（同一命令、同一脚本，仅 metadata 中被报告的基线
源码路径字符串不同），结论一致：CPU −7.46%、每写中位耗时 −9.43%、
`memorySnapshot` 5.01 → 1.00、`structuredClone` 302.9 → 203.0。两次的分配归因
数字逐位相同。

内存证据取"构建的投影体积"而非 RSS：被删除的是**转瞬即逝**的深拷贝，
它们不改变稳态可达堆，RSS 对本轮不是干净信号（与
`retention-plan-cost.md` 第 4.3 节的结论一致），因此只报告可直接归因的
`structuredClone` 调用数与投影字节数（第 1 节表），不宣称 RSS 收益。

## 5. 边界与剩余风险

- **本轮确认的两处非等价边界**（复核发现，见第 3.3 节）：
  （1）纯领域层上"深到无法投影的值"不再在加载时报错，而改在第一次真正的投影时报错
  （变宽的是报错时机，不是接受的数据；官方 domain facility 在读取存储的 global 时
  就拒绝这种文档，已固定为回归用例）；
  （2）混合模式下并发默认调用者各自构建一份内容相等的投影而不是共享同一个对象
  （改动前无法表达该组合，两个默认调用者的共享语义逐字不变）。
  除这两点外，仓内调用方、持久化字节、恢复与 failure 边界均未改变。
- **发布固定点**：本轮让与 rc.10 固定产物不同的分发文件从 2 个
  （`knowledge.js`、`memory.js`，在 `origin/main` 上已如此）增加到 4 个
  （新增 `lib/dockyard-domain/observation.js` 与 `lib/domain-storage.js`），
  `contentSha256` 相应变化；`npm test` 的两条 release-pin 守卫在本轮之前就已
  因为相同原因失败，本轮不引入新的失败类别；`npm run pack:check` 报出的就是这
  4 个文件与 `docs/evidence` 的旧内容摘要不匹配。按 `RELEASE.md` 重新固定需要
  版本号、重跑两个宿主验收并更新 `release/`，本轮约束明确禁止，因此保持不动，
  并在此显式记录该验证债务。`npm run release:verify` 仍通过（固定产物未被触碰）；
- 剩余 CPU 中占比最大的是 `fsync`（22.7%）与 zod 校验（22.7%），前者是持久化
  承诺，后者已被独立对抗式复核否决，均不在本轮范围；
- `history("observations", { includeArchived: false })` 的等价性依赖
  `#data.observations` 在加载后已是数组（`load()` 自身归一化，`restore()` 与
  `#adoptDurableProjection()` 也只写数组）。只暴露最小端口的自有 Memory 端口走
  原分支，不受影响。
