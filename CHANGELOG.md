# Changelog

Versions here are development artifacts of the standalone `dsh-evolution`
bundle. They are not npm releases. The supported DSH versions are exact
alternatives in `peerDependencies`, and a version is only added there after it
passes the full install/boot/upgrade acceptance: read the entry for the version
you install before upgrading DSH.

## Unreleased — 事件桥尾记录、晋升 journal 计划与守卫证明的根因修复

本轮修复来自四路独立只读审查：修复 2 项 P1、4 项 P2 与 6 项 P3，每一项都是根因修复，
没有新增持久字段、事件信封字段、公开工具参数或授权路径；另有 1 项 P2 与 2 项 P3 经复核
不成立或不应改动（见文末）。未改版本号、`peerDependencies`、
`engines`、依赖、发布固定点与官方 DSH 源码。

### 事件桥：不完整尾记录不再与下一条记录粘连

`EvolutionEventBridge.persistPending()` 追加前检查文件尾字节：尾部是不带换行的**完整且已签名**
记录时，先补分隔符再追加（重放接受这种 remainder，直接追加会把两条记录拼成一行非法 JSON，
下一次启动在 `openDomainStorage()` 拒绝整个日志）；尾部是残缺记录时拒绝追加并保留现场，
让 doctor 的 `event-bridge-trim-partial-tail` 仍能识别唯一一条未闭合尾行。正常追加与
pending 续写路径不变。整个“验证尾部 + 多段写入”现在由日志旁带 owner token 的目录锁串行化（同一进程与跨进程
一致）：`O_APPEND` 只保证单次写入的位置，两个 writer 交错续写会让同一条记录被拆到另一条
记录两边。活着的 writer 在 500 ms 内释放；崩溃留下的锁在 2 s 后通过原子 rename 隔离并复核
mtime 才删除，释放也只删除 token 仍属于本次调用的锁——按路径判断后直接删除会让回收者误删
刚建立的新锁，或让慢 writer 删掉接管者的锁。

### 晋升 journal：计划必须就是本事务写过的目标

`checkJournalBoundary()` 不再只判断“目标在某个 root 之内”。`records` 必须是 writer 写出的
**完整计划**：composition、EVOLUTION.md 与本实验的 `archive/<id>.md` 三条 file 记录，加一条由
experiment ID 推导的 promoted plugin 目录；同一目标不能出现两次，file 记录必须有
`existed` / `beforeDigest` / `expectedAfter` 的一致关系。`experimentId` 必须是可作文件名的形状。
此前空计划会被当作“成功回滚”并删除 journal，部分计划只会恢复一半目标后删除唯一证据，
而指向 `presetDir` / `dockyard` / `knowledge` 或另一个实验目录的 `path` 记录会让恢复删除
超出本事务的现场——它们都需要一份正常代码从不写出的 journal，但都属于“不得猜测并删除现场”
的边界缺失；doctor 对这类 journal 报 `blocked` 且不提供 repair。

### 晋升事务：同一份捕获、持久备份、可回收锁

计划、CAS 基线与备份改为来自同一次读取（此前计划用旧字节生成、基线却哈希之后读到的字节，
中间的外部编辑会被静默覆盖）；备份用 durable 原子写替代 `copyFile`，journal 提交前备份字节与
目录项已 fsync；lock 元数据写入失败时删除本次创建的锁，清理失败后同一进程的残留锁可按
“本进程未持有的 token”回收，不再被误判为活跃持有者。

### 成功路径的资源释放与跨进程唯一 ID

`promotion-succeeded` / `canary-passed` 以及 canary 回滚事件改为安全发射，`releaseTargets()`
与 `releaseOperation()` 在状态已提交后保证执行：事件桥或归档写入失败不再让一个已 `stable`
的实验永久占用 target，也不再让记录一直 “busy with promote”。实验 ID 追加 8 位随机后缀，
同一毫秒内两个进程不再生成同一 ID（claim 按 ID 采纳、归档按 ID 命名）。

### canary 所有者校验、守卫证明与解析错误脱敏

`startupTransition` 不再是工具参数：启动屏障通过模块私有 symbol 调用，工具调用无法伪造；
guard 的 managed-transaction 证明只接受宿主注入的 `operationContext`，tool arguments 里的同名
对象被忽略；`write`/`edit`、bash 重定向与 `run_code` 的文件写入目标都按真实路径解析：已存在的目标用
`realpath`，尚不存在的目标按文件系统的顺序逐分量解析（先跟随符号链接，再处理其后的 `..`，
父目录缺失时继续向下），因此 `alias/..` 这类词法折叠无法再把写入藏到 trust-root 里。`JSON.parse` 的原生报错会引用被解析字节的截断片段（用户数据，V8 形如
`"sk-live-TO"... is not valid JSON`），晋升 journal、内存隔离警告与 doctor evidence 统一经
`redactJsonParseMessage()`（`lib/orchestrator.js` 导出的边界投影）处理后才会输出。
迁移脚本的源/目标隔离改为文件系统身份比较（仍保留词法快路径），符号链接源根不再能把
导入写回源快照。

### 未改动

`dsh-evolution/core` 的 `writeDurablePromotion()` 仍是宿主级集成原语（已补文档说明它不承担
确认与门禁）；Cordis peer 范围与验收矩阵的关系维持现状；`maintenance()` 仍无生产调用者，
因为冷档案的 retention 与 segment 封存已在 `finalizeKnowledge` 写入路径上执行。

## 0.2.0-rc.17 — 继任复用已解析的冷档案行，事件桥积压合并为一次事务

本候选在 `0.2.0-rc.16` 之上做三件事：`port.observe()` 在 live → stage → hydrate 的 Memory
继任之间复用已解析的冷档案行（`e185525`）；一次 `flush()` 里认证过的积压事件作为**一个**
事务提交（`5381299`），并修掉分组路径上“组大于桥标记窗口时同端口重试重复应用”的缺陷
（`84cbe3a`）；发布门禁把“开发阶段”与“发布阶段”的固定点判定拆成两段并共用一张判定表
（`b71fb06`、`6cb2f82`、`8bd0a73`，只动 `scripts/release/` 与随包分发的 `README.md` /
`RELEASE.md`）。生产 delta 因此只有两个 `lib/` 文件——`lib/dockyard-domain/memory.js` 与
`lib/domain-storage.js`——加上版本号与随包分发的文档；宿主支持范围、`peerDependencies`、
`engines`、依赖、领域存储的持久化格式与 schema 一律未动。

**未改的不变量**：`promotionGates` 的八项门禁、晋升的二次显式确认、Trial 基线的单次同步
捕获、journal 阶段判定（`classifyPromotionJournal`）、跨进程锁、CAS、tombstone、latest-wins、
去重与 retention 决策、事件信封与签名算法、经验检索的只读性与触发路径、脱敏边界与守卫。
两处性能改动都是删除重复工作，没有新增持久字段、缓存失效信号或安全授权路径。

### `port.observe()`：跨 Memory 继任复用解析结果与冷行身份

- **改的是什么。** 公开写入的路径是 `observe → enqueue → mutate → mirrorArchives →
  createMemory(stage).load → store.record → recordObservation → #append → installPending →
  hydrate → createMemory(live).load`。每次写入都会新建两个 Memory 实例，实例内的
  `archiveReadCache` 随继任丢失，来源行的 canonical key 又在 `#sourceMatches()` 里逐条重算。
  现在 `lib/domain-storage.js` 在**同一个 port 的** live → stage → hydrate 之间传递既有的
  解析缓存：每个实例仍拥有独立 Map 与条目包装，不共享热状态、`archiveKnown`、stale 标记、
  事务或权限。
- **继承的判据不是 stat，是内容。** 继任首次读取仍列举全部文件、核对 basename、有序文件
  列表、`dev`、`ino`、`size`、`mtimeNs`，实际读取所有文件，比较该解析对应的 SHA-256，再核对
  读取后的文件身份；缺证据、内容不同或身份变化就直接解析本次读取结果。读取错误沿原
  scanner 报告（保留单次读取的 raw/error），带 fault 的解析不继承。append 扩展前复制 records、
  positions、tombstones，既有冷行与其身份备忘只读共享；增量扩展没有新的完整文件指纹，标记
  `digests: null`，下一实例不继承它。
- **收益**（`--rows 10000 --knowledge-rows 10000`，同机交替、按侧取中位数）：公开
  `port.observe()` 的 wall **127.033 → 47.030 ms（−62.98%）**、CPU **128.641 → 29.366 ms
  （−77.17%）**；每次 observe 实际读取冷档案字节 **23,236,134 → 23,236,134（未变）**、解析
  fixture 冷行 **20,000 → 0**、六维身份哈希 **10,002 → 2**。读取没有减少，收益来自省掉 JSON
  解析、冷行规范化与身份哈希。冷 knowledge 命中 −23.59%、持续归档 −16.17%；空档案
  wall +4.01%（约 +1.08 ms）、50 + 50 冷行 −0.57%，逐轮方向反转，**不宣称稳定收益，也不
  承诺零开销**。
- **代价**：留存 heap 增量中位数 **3.985 → 34.266 MiB**，缓存随冷档案大小增长，缓存每集合
  只保留当前视图。单实例边界基准里，没有可复用身份的单次 `recordObservation()` 为
  40.980 → 47.253 ms（+15.3%），同实例 16 次追加合计 377.507 → 100.345 ms（−73.4%）；
  `load()` 为 7.021 → 6.895 ms，不宣称启动收益。
- **被撤回的原型**：只按 stat 继承并跳过首次读取（会隐藏新发生的 EACCES/EIO）；实际读取但
  只比 stat（等长原地改写后恢复 mtime，rc.16 返回 NEW 而原型错误返回 OLD）。两者都固化为
  `test/observe-cache-read-fault.test.mjs` 的反例。
- **等价性**：`test/observe-cache-handoff.test.mjs` 直接 import SHA 固定的 rc.16 包做差分，
  覆盖缺键、陈旧键、存储键短路、热覆盖、容器隔离、匿名/数组顺序、tombstone、文件失效、
  fault、提交前失败、已提交 pending 安装失败与重启恢复；`#sourceMatches()` 仍先匹配存储 key
  再按字段重算 canonical key，只有当前位置仍由该缓存持有的冷对象才能备忘，同 id 热覆盖始终
  重算，返回值、latest-wins、首次位置、匿名行、数组行、tombstone 与复活顺序不变。
- 数据、归因、内存协议、被撤回的候选与边界见 `docs/performance/observe-cache-handoff.md`
  及同目录的 `observe-cache-*.json`。

### `flush()`：一次 pass 的积压事件合并为一个事务

- **改的是什么。** `replay()` 现在把一次 pass 认证过的记录作为**一个**事务提交。每条记录仍
  各自 `JSON.parse`、MAC 验证、writer 校验、标记/冲突检查、`projectExecutionEvent` 投影，并在
  `work()` 内按文件顺序逐条 `applyExecutionEvent`（顺序、去重、`E_DOMAIN_EVENT_ID_CONFLICT`
  全部保留）；组内重复 id 由本 pass 的 `batchMarks` 承担，交给 `mutate()` 的仍是**整份已提交
  标记表**加本组新记录。认证失败时先提交已验证前缀再抛出；组事务自身失败则整组不落盘，下一
  次 pass 按文件顺序重放。检查点仍只在整次 pass 成功后推进，被拒绝的 pass 不写检查点。
- **收益**（真实官方 `DomainFacility` + `JsonStorageBackend`，历史 200 条与 2,000 条各一轮）：
  积压 2 条 −44.4% / −45.6%，5 条 −76.6% / −76.5%，10 条 −85.9% / −86.5%（CPU 同向
  −43%…−84%）；同一批运行里 `fsync` **3k+2 → 5**、`renameSync` 31 → 4、`readFileSync` 41 → 5，
  因此增益不是把 I/O 挪到别处。积压 1 条与积压 0 条（稳态）落在噪声带内，**不声称收益**，
  稳态路径本轮没有改动。
- **收口修复（独立审核发现，`84cbe3a`）。** 分组路径上，一次 flush 认证了 4097 条记录、提交点
  成功而关闭写入失败时，不关闭端口直接再 `flush()` 会得到 `{ applied: 4097, duplicates: 0 }`
  并多出第二代 lineage：`EvolutionMemory` 的桥标记窗口只滚动保留最后 4096 条，恢复安装的标记
  里最早那条已滑出窗口。修复是让 `mutate()` 把恢复后的**已提交**标记表交给工作函数，分组提交
  在应用每条记录前先看 `recovered[eventId] === mac`，命中即计为 duplicate 并跳过。判定用的是
  已提交的完整 ledger 而不是内存窗口，同 id 不同 MAC 仍在 `mergeEventLedger` 里抛
  `E_DOMAIN_EVENT_ID_CONFLICT`，重启路径不变。回归用例断言重试返回
  `{ applied: 0, duplicates: 4097 }`、标记表恰好是文件顺序、桥标记窗口每条一次、lineage 只有
  一代；该用例在修复前的实现上实测失败，代价是它需要 4097 条事件（单机约 26 s）。
- **等价性范围**：除事务暂存目录名之外，公开返回值、官方持久化文档与完整 `dockyard` 树逐字节
  相同；组事务失败时该组一条都不落盘（逐条路径会保留失败点之前的记录），两者在下一次 pass
  收敛到同一状态，这一差异由两个用例分别钉住。
- 数据、归因、被撤回的候选与收益边界见 `docs/performance/domain-replay-batch.md` 与
  `domain-replay-batch.json`。

### 发布门禁：开发阶段与发布阶段的固定点判定分开

- `npm run pack:check` 的默认行为（CI 在 `main` 与 pull request 上跑）先证明**固定点自身仍然
  成立**（`sourceCommit` 在历史中，且它的分发内容摘要等于固定点的 `contentSha256`），再如实
  报告工作树与固定点的关系：`pinned` 或 `ahead`（已提交后继，逐条点名不同的分发文件）。分发
  文件有**未提交**改动、或固定点已不能描述它自己记录的 commit 仍然失败。
- `npm run pack:check -- --release`（`release.yml` 用这一条）保持严格语义：工作树不等于固定内容
  即失败并点名文件。`verify-provenance.mjs` 独立拒绝“tag 的工作树内容 ≠ 固定点”，因此漂移的
  树即使去掉 `--release` 也发布不了；`test/release-pin.test.mjs` 与 `pack:check` 共用同一张判定
  表（`scripts/release/pin-relation.mjs`），并断言 `--release` 在 `ahead` 树上**必须**失败。
- 这条改动只影响 `scripts/release/`（不属于包内容）与随包分发的 `README.md` / `RELEASE.md`；
  `release/` 固定产物、`release/manifest.json` 与三份宿主验收证据的语义没有变化。

### 固定点与验收

- 上面两个 `lib/` 文件与随包分发的文档都属于分发内容，因此本轮改动改变了 `contentSha256`；
  `release/` 固定产物、`release/SHA256SUMS` 与三个宿主的验收证据按 `RELEASE.md` 第 2 节重新
  生成（`npm run release:pack` → `npm run release:publish` → 针对固定 tarball 重跑三宿主验收），
  重新固定后的内容摘要与这棵树一致。三条固定点检查就是这条约束的报错方式（`RELEASE.md`
  第 6 节第 16 条）。`0.2.0-rc.16` 及更早的 tarball、校验和与 tag 字节保持不变，也未被覆盖；
  rc.16 已是公开 tag 与公开 Release，其发布后资产校验见 `docs/evidence/rc16-release-audit.json`。

## 0.2.0-rc.16 — 召回窗口不再复制它从不读取的行，指标分支每行只规范化一次

本候选在 `0.2.0-rc.15` 之上只做两处可证明等价的重复计算删除（召回读取与指标规范化）、把全量套件的 4 GiB 堆上限从文档要求变成 CI 的断言，并把 2026-10-20 全量测试内存事件做成一次有界定位。生产 delta 只有三个随包分发文件——`lib/dockyard-domain/memory.js`（新增 `historyView`、指标分支每行只规范化一次）、`lib/domain-storage.js`（`recall` 改用它）、`lib/dockyard-domain/PORTS.md`（记录只读视图的契约）——加上版本号与随包分发的文档；宿主支持范围、`peerDependencies`、`engines`、依赖、领域存储的持久化格式与 schema 一律未动。

**未改的不变量**：`promotionGates` 的八项门禁、晋升的二次显式确认、Trial 基线的单次同步捕获、journal 阶段判定（`classifyPromotionJournal`）、跨进程锁、CAS、tombstone、latest-wins、去重与 retention 决策、事件信封与签名算法、经验检索的只读性与触发路径。`history()` 仍是 detached 契约：新增的只读视图是**另一个**方法，没有把既有契约改宽。

### 召回读取：窗口之外的行不再复制

- **`EvolutionMemory.historyView(collection)` 是 `history()` 那次合并的无副本版本。** 同一份 `#mergeArchived(..., { copy: false })`、同样的行、同样的顺序、同样的 latest-value 与 tombstone 结果，只是不逐行复制；返回的**数组**属于本次调用（调用方 `push` 或重排不会改到 store 的数组），而数组里的元素是热记录与档案读缓存里的冷记录本身，因此契约是**只读**，`history()` 保持不变。`port.recall()` 是唯一调用方：它把保留的字段投影成 `collectKnowledgeExperience()` 自己的有界记录，所以下游拿到的仍是新对象；`test/experience-recall.test.mjs` 的 `recall: a mutated answer cannot write back into the stored knowledge rows` 断言把召回结果深度改坏之后，下一次召回与 `port.query("knowledge")` 都是原值。
- **为什么改**：`port.recall()` 原先经 `history()` 取整段冷热合并的 knowledge 历史，然后最多只用最新的 2,000 行（`maxConsidered`）加上窗口之外精确命中 `knowledgeKey` 的几行；窗口外的其余行被复制了一遍却从未被投影。同一份热缓存档案上的隔离测量（`docs/performance/recall-view.md` 第 1.1 节）：10,000 行（17.5 MiB）的 `history("knowledge")` 是 83.5 ms，其中复制约 63 ms（纯 JSON 往返 63.3 ms 只作量级参考），收集器本身约 15 ms。
- **收益**（`--op recall`，窗口查询与精确命中查询各一次，同机交替、按侧取中位数）：2,000 行 60.96 → 27.48 ms（wall −54.92%）；10,000 行 203.88 → 29.97 ms（−85.30%）；40,000 行 723.92 → 41.70 ms（−94.24%）。收益边界就是省掉的“窗口之外的行被复制”这一部分，因此随 `总行数 / 2,000` 增长；2,000 行正好等于窗口时仍有 −55%，因为窗口内的行原先也被整体复制了一次，而现在只复制收集器真正保留的记录。改动后每次召回仍是 O(总行数) 的一次合并（40,000 行约 7 ms）加窗口投影，**冷档案首次解析、合并与 latest-wins 完整保留**。
- **等价性**：基准脚本每一轮都断言两侧落盘的 `dockyard` 档案树逐字节相同，`--op recall` 另外断言两侧 `port.recall()` 的输出 JSON（记录、顺序、`coverage` / `exact` / `score`、`considered` / `scanned` / `duplicates` / `dropped`）逐字节相同，并断言档案头部那条“窗口之外的精确命中”仍然被召回；`test/dockyard-domain/evolution-archive-index.test.js` 的 `history view is history()'s merge without its copies, and history() stays detached` 断言视图与 `history()` 的合并结果（含 latest-value 覆盖与 tombstone）逐字段相同、`history()` 每条仍是副本、而视图两次调用返回同一批行对象。

### 指标分支：每行只规范化一次

- **`#shouldRetainSource()` 的观测指标分支不再为每个指标规范化同一行一次。** 该分支原来按“指标 × 匹配行”遍历，每个（指标，行）组合都调用一次 `normalizeKnowledgeEvent()` 只为读 `.metrics[key]`，而 `.metrics` 与调用时的 `now` 无关（`now` 只影响 `occurredAt`）；现在每个匹配行在一次调用内只规范化一次，比较的表达式、短路顺序、`undefined` / `null` 先验与 5% 判定完全不变。顺带更正一个此前的估算：`.every()` 会在第一个“非实质变化”的匹配行处停下，所以这一分支从来不是最坏的 K×M 次，每个指标最多走到第一个不变化的行。
- **实测**（小档案、重复的 measured 观测、8 个指标，最终代码保留时钟读取）：0.500 → 0.447 ms，三轮重复的中位数 wall −10.61%（区间 −16.0%…−9.9%）、CPU −11.13%。同一配置里“不该变化”的另外三个场景 wall 与 CPU 变化都在 ±6% 内，且没有同号的一致信号（例如冷 knowledge 场景 wall −5.75% 而 CPU +3.11%），不读作收益。数据与复现命令见 `docs/performance/recall-view.md` 第 2.2 与第 5 节。
- **被撤回的变体：连时钟读取一起缓存。** 把 `timestamp(this.clock)` 也提到求值之外能把该场景推到 −16.9%，但用递增时钟复现出持久化差异——同一轮写入里后续记录的 `recordedAt` 因为少读一次时钟而提前了一个 tick（`00:00:08` → `00:00:07`）。这属于行为改动而不是删除重复计算，因此撤回；最终实现仍在**每次求值时**读一次时钟，只复用规范化结果。
- **回归测试同时钉住持久化字节与读取次数**：`test/dockyard-domain/knowledge-identity-equivalence.test.js` 的 `the metric branch keeps the pinned clock read count and bytes` 以 `rc.15` 固定产物为基线、用每次读取都递增的时钟，断言持久化字节**与时钟读取次数**都与基线相同；把时钟读取也缓存起来（即上面被否的写法）该用例立即失败（实测 14 ≠ 17）。

### CI 与事故定位

- **全量套件的堆上限成为断言。** `.github/workflows/ci.yml` 的单元测试作业此前没有任何堆上限，正是 `AGENTS.md` 第 5 节禁止、也是 2026-10-20 事故被记录时的状态；现在它在作业级设 `env: NODE_OPTIONS: --max-old-space-size=4096`，`test/workflows.test.mjs` 断言这个取值。设在作业级是为了让安装步骤与测试 runner 起的每个子进程都带同一个上限，不会出现“父进程带了限、某个子进程没带”的分叉。
- **2026-10-20 全量测试内存事件做了有界定位，但没有定论成“根因”。** 95 个测试文件各起一个独立进程组复测（4096 MiB 堆上限、2 GiB RSS 上限、300 s 超时）全部通过，峰值最高 459 MiB，没有任何文件被杀；事故点名的 8 MiB 病态输入在绕过 64 KiB `REDACTION_TEXT_BOUND` 之后只需 27 ms、RSS +9 MiB、不再抛错。**不能**由此推出的是：历史根因已经确定、事故时的有效堆上限已被证明、报告里 `rpages × 16 KiB ≈ 203 GB` 那个数值已被复现——这三条都没有成立，事故时的 Node 发行版、工作树与产生那次分配的中间规则表版本都没有留存。能说的是：当前代码在 4 GiB 上限下的逐文件复测与整套复测都没有出现失控分配。方法与边界见 `docs/performance/oom-localization.md` 第 3 与第 6 节。
- **固定点与验收**：上面三个 `lib/` 文件与随包分发的文档都属于分发内容，因此本轮改动改变了 `contentSha256`；`release/` 固定产物、`release/SHA256SUMS` 与三个宿主的验收证据按 `RELEASE.md` 第 2 节重新生成（`npm run release:pack` → `npm run release:publish` → 针对固定 tarball 重跑三宿主验收），重新固定后的内容摘要与这棵树一致。三条固定点检查就是这条约束的报错方式（`RELEASE.md` 第 6 节第 16 条）。`0.2.0-rc.15` 及更早的 tarball、校验和与 tag 字节保持不变，也未被覆盖；rc.15 已是公开 tag 与公开 Release，其发布后资产校验见 `docs/evidence/rc15-release-audit.json`。
- 性能数据、等价性依据、被撤回的候选与剩余风险见 `docs/performance/recall-view.md`（`docs/performance/` 不在包内容白名单内，不改变发布字节）。它的第 6 节记着这条改动留下的边界：`historyView()` 是一个会暴露内部行的只读接口，目前只有一个调用点并有针对性的回写隔离测试，但将来若有调用方把它用在会写回记录的路径上，就会同时破坏 store 与读缓存。

## 0.2.0-rc.15 — 凭据边界的结构性收敛与全仓库缺陷修复

本候选把上面这一整轮修复固定下来，并在最终安全验收中把凭据边界从「按形状枚举、逐段截断」收敛为「命中凭据键即丢弃剩余文本」。

**为什么带到 rc.15：** 这一轮改动跨 `lib/` 下 12 个分发文件与四份分发文档，`contentSha256` 因此改变；按 `RELEASE.md` 第 2 节重新构建、重跑三宿主验收并重新固定之前，工作树的内容不等于任何固定点。`npm run pack:check` 的三条固定点检查（`the committed acceptance evidence matches this exact package content`、`release/manifest.json pins this tree content`、`the working tree still builds the pinned content`）正是这条约束的报错方式：它们必须在重新固定后转绿，而不是被绕过。本节只记录实现做了什么与为什么；每条注明的测试文件是仓库里已有的对应回归用例，本轮执行过的检查见 `RELEASE.md` 第 4.1 节与 `docs/evidence/`。

本节只记录实现做了什么与为什么；每条注明的测试文件是仓库里已有的对应回归用例，不代表本轮已重跑过它们。

### 数据完整性与安全

- **原始错误文本不再越过持久化边界。** `lib/orchestrator.js` 新增 `safeErrorDto(error, phase)`，它是唯一的 error → 安全 DTO 边界：只给出错误码、失败类别、不可逆摘要（`sha256:` + 前 16 位）与去凭据后的短摘要（≤240 字符，另附原始长度），原始 message 不离开这个函数。失败学习、实验档案（`renderExperimentArchive` 与归档重放两条路径）、事件桥的 `failure` 字段、observation 流与 `evolution_runtime_inspect` 全部改为从这里取字段，不再复制 `error.message`；`safeFailureForPersistence()` 会把从旧记录/旧快照读回的 `error` 重新过边界，避免旧文本被再写一遍。原因是原文以前只在领域存储那一层被替换掉，失败记忆、档案、事件桥与 inspect 输出各自还留着原文。回归用例见 `test/orchestrator-integrity-safe-error.test.mjs`。
- **凭据形状的脱敏范围扩大。** `redactCredentialShapes()` 取代 `compactValue()` 里原来只认 `sk-`/`gh[pousr]_` 与 `Bearer` 的两条正则：现在按结构去掉 URL userinfo（`scheme://user:secret@host`）、`password|passwd|pwd|secret|token|api_key|access_key|private_key|authorization|credential|session_id` 后的取值、`sk-`/`gh[pousr]_`/`xox[abprs]-` 前缀、AWS 访问密钥 ID 与 `Bearer` 令牌。原因是逐家厂商匹配永远落后，而这些形状的泄漏点是一致的。
- **回滚证据也过同一道门。** `safeErrorEvidence()` 对 `rollbackResult` 这类嵌套证据逐层处理：`error` / `errors` / `message` / `reason` / `detail` 里的字符串走 `safeErrorDto().errorSummary`，`raw` / `fullOutput` / `stdout` / `stderr` / `logs` / `transcript` 直接不写入，其余字符串只做限长与脱敏。原因是失败实验的 cleanup 证据里最容易出现宿主原文。
- **领域 observation 的脱敏按值保留位置。** `lib/dockyard-domain/observation.js` 的 `redact()` 对识别为凭据的键名写回 `<redacted>` 而不是删掉字段（记录仍然说明哪个字段装过凭据），`Error` 对象自己的 `message` 也走文本脱敏；敏感键名先去掉非字母数字再比较，所以 `api_key`、`api-key`、`apiKey` 是同一个键名；文本侧新增带分隔符/引号/驼峰写法的 `api[\s_-]?key`、`access token`、`client secret` 等与单独的 `bearer`。被脱敏的占位符不再当成 metrics 的取值，patternKey 也改成从**脱敏后**的 message 派生，避免凭据经 pattern key 回流。回归用例见 `test/domain-input-observation-redaction.test.mjs`。
- **`agent/error` 观察者只交安全 DTO。** `lib/registration.js` 的事件监听器现在把 `safeErrorDto(error, "observation")` 交给观察者（message 换成脱敏摘要，另附 `errorCategory` / `errorDigest`），并把启动 canary 的校验改成"并发 pre-step 共享一次"。前者是因为原文到这里已经没有必要保留；后者是因为旧实现先把 `startupChecked` 置为 `true` 再 await，第二个并发 pre-step 会直接跳过而不等那次校验。
- **事件桥的短写会被补齐。** `EvolutionEventBridge.emit()` 现在循环 `writeSync` 直到整条记录写完，只有完整写入并 `fsync` 之后才把 `eventId` 记入 `seen`；写入没有进展时抛错，而不是把半条记录当成已持久化（旧实现只写一次，短写会留下残行，而 `seen` 又阻止了唯一的重试）。跨崩溃的残尾仍由 doctor 的 partial-tail repair 负责，本轮没有改它。回归用例见 `test/orchestrator-durability-lock-and-log.test.mjs`。
- **认证头里“续接的凭据材料”不再泄漏（删掉 scheme 文法层）。** `lib/orchestrator.js` 的 `redactCredentialShapes()` 里有一层按认证 scheme 名字枚举的规则（`AUTH_SCHEME` / `AUTH_PARAM` / `AUTH_OPAQUE` / `AUTH_SCHEME_BODY` / `CREDENTIAL_SCHEME_PATTERN`），它只替换该 scheme 自己文法声明的部分（`Bearer` 之后一个 opaque token，`Digest` 之后一个 `name=value` 参数表），而紧随其后的凭据赋值规则又刻意不重匹配已经写成 `[redacted]` 的值，于是该边界之后的材料原样落盘。修复前实测（`safeErrorDto(new Error(msg), "probe").errorSummary`）：`Authorization: Bearer aa Z7r6Secret9` → `Authorization: [redacted] Z7r6Secret9`；`Authorization: Bearer aa\"Z7r6Secret9\"bb` → `Authorization: [redacted]\"Z7r6Secret9\"bb`；`Authorization: AWS4-HMAC-SHA256 …\nSignature=deadbeef` → `Authorization: [redacted]\nSignature=deadbeef`；`X-Auth-Token: Bearer aa Z7r6Secret9` → `X-Auth-Token: [redacted] Z7r6Secret9`。修复是**删除该层**而不是扩展它：现在每个凭据键（`Authorization`、`Proxy-Authorization`、`X-Auth-Token`、`X-Api-Key`、`token` …）都只走同一条整值规则，与早已如此的 `token: X-Custom-Scheme <material>` 一致，因此不再有可枚举的 scheme 名单要追。**接受的代价（已用测试钉住，不再宣称“诊断详细度不变”）：认证头之后的散文会随值一起被脱敏**，例如 `Authorization: Bearer abc123 and the host was unreachable` 从“保留句子”变为 `Authorization: [redacted]`；保留诊断细节不能以凭据为代价，保留下来的是键名、失败类别与摘要。被这次改动放宽的断言都是"散文保留" → "散文一并隐去"（收紧），没有删除用例、没有放宽任何上限。其它性质未变：仍是单一入口 `redactCredentialShapes()`、仍以 `REDACTION_TEXT_BOUND` 为界（超限写入 `withheldTextMarker` 而不是扫描）、任何规则抛错仍返回同一个标记、JSON 嵌入与多层转义行为不变（引号闭合这条子规则在第十五轮被整值规则取代，见“凭据赋值的值改为”一条）。回归用例：新增 `test/review-fix-redaction-auth-continuation.test.mjs`（四条实测探针、四层 `JSON.stringify` 续接、`Proxy-Authorization` / `X-Api-Key` / `token` / `api_key=`、以及“没有凭据键的普通句子不被脱敏”的反向用例；前四条对应的用例在还原 scheme 层的旧实现上均失败），并更新 `test/review-fix-redaction-scheme-key-anchored.test.mjs`、`test/review-fix-redaction-escape-unknown-scheme.test.mjs`、`test/review-fix-redaction-parameter-prefix.test.mjs` 中三处"散文保留"断言。仍未关闭的边界见 `RELEASE.md` 第 7 节末条。
- **结构化键值对不再绕开脱敏边界，档案与测量字段也改在落盘前过边界。** `redactCredentialShapes()` 只看一段文本自己的字节，所以键与值已经作为对象属性分开时（`{ access_token: "…" }`）**任何文本规则都匹配不到**：这类形状此前原样落盘（修复前实测：`{access_token:<secret>}` → `{"access_token":"<secret>"}`、`{apiKey:…}`、`{password:"hunter2"}`、`{body:{access_token:…}}`、`{items:[{api_key:…}]}` 全部保留明文）。现在 `compactValue()` 在遍历对象时先按**键名**判定：键名小写化并去掉非字母数字后，整名或其中任一个词命中既有的 `CREDENTIAL_KEY`（判定用的 `CREDENTIAL_KEY_NAME` 直接由同一个 `CREDENTIAL_KEY` 列表派生，**没有第二份手写拼写表**），该键的值就整体替换成 `[redacted]`——不看值的类型或形状（字符串、数字、布尔、对象、数组一致），在任意深度与对象数组内都生效；键名去掉非字母数字后为空（如 `"___"`）时同样按 fail-closed 处理。原有的 `raw|fullOutput|stdout|stderr|logs?|transcript` 丢弃、`depth >= 4 → "[compacted]"` 边界、`maxText` 截断与 `__proto__` own-property 语义均未改。**晋升锁不受影响**：`writeDurablePromotion()` 的 `lock.json` 仍用 `JSON.stringify` 直写、不经过 `compactValue`，所以 `token` 字段仍是真实 UUID（改为经过 `compactValue` 会让 `finally` 里的 `current.token === token` 永远不成立、锁无法释放；`test/review-fix-redaction-structural-keys.test.mjs` 用一次真实提交观察锁文件钉住这一点）。同时补上"从未到达任何脱敏函数"的字段：`propose()` 的 `why` / `target` / `impactScope` / `successMetrics`，`measure()` 的 `benefitEvidence` / `cleanupEvidence` / `performanceChange` / `errorChange` / `observationWindow`（`metrics` / `beforeMetrics` / `afterMetrics` 是**有界**遥测行，见下一条，不在此列），以及 `renderExperimentArchive()` 渲染的 proposal 与 `## Observations` / `## Latest measurement` 两个 JSON 块（重放与读取旧记录也要经过它）。这些字段以前只经过 `optionalText()`，脱敏只在文本规则命中时才发生，于是 `why: Authorization: Bearer aa <secret>`、`impactScope: ["api_key: <secret>"]`、`observations[].benefitEvidence` 都原样写进 `exp-*.md`。投影边界用 `EVIDENCE_PROJECTION`（规则不变、把 `maxText` / `maxItems` / `maxDepth` 的取值上限放开），因为档案自由文本与两个 JSON 文档块不是有界遥测行：**不含凭据、且每个字段都在 `REDACTION_TEXT_BOUND`（65,536 字符）以内的记录**，渲染与存储的字节与改动前完全一致（用例里钉住了完整 markdown 与 proposal 为空时的两种字节）。超过该长度的字段按既有规则换成 withheld 标记（`[redacted] [message withheld: N characters]`），所以“字节一致”不能读作“任意长度都一致”——那是脱敏上界本身的代价，不是本轮引入的。另外两处残余也一并收口：(a) 裸值的 "逗号 + 引号片段" 终点收紧为只有"逗号 + 引号片段 + 可选空白 + `:`"（即 JSON 键）才算终点，`Authorization: Bearer aa, "<secret>"` 从 `Authorization: [redacted], "<secret>"` 变为 `Authorization: [redacted]`，当时仍保留 `{"token":"k=v","x":"y"}` 与 `token: k=v,"x":"y"` 的第二个字段；(b) 新增 fail-closed 的未闭合引号分支：值以引号开头且没有闭合引号时（截断消息）整段到文本末尾都算值并脱敏，`password="unterminated <secret>` 当时从原样保留变为 `password="[redacted]"`，代价是这段文本自己的尾部标点被一并吞掉。**这两条都在第十五轮被同一条规则吸收**：不再有终点，所以 `{"token":"k=v","x":"y"}` / `token: k=v,"x":"y"` 现在是 `{"token":[redacted]` / `token: [redacted]`（第二个字段不再保留），未闭合引号也没有专用分支，同一输入是 `password=[redacted]`。分隔符类从 `[-_]?` 扩到 `[._-]?`，因此 `api.key` / `client.secret` / `access.token` / `db.password` 与下划线、连字符写法一致（`api.key: <secret>` 修复前原样保留）。**新增的过度脱敏（刻意、已用用例钉住）**：键名里含族内单词的长名也被判为凭据，例如 `{ maxTokens: 512 }` 的值变成 `[redacted]`（归一化抹掉了分隔符，`maxTokens` 与 `db_password` 无法在同一条规则下区分），保留一个指标还是保留一个凭据，本边界选择后者。**本轮未关闭的形态**：无标签高熵值仍不被识别（`provider rejected <23 位随机串>` 无键名、无厂商前缀、无 scheme，要识别它需要新增高熵检测家族，本轮没有加；`test/review-fix-redaction-structural-keys.test.mjs` 把它作为残余显式断言，而不是留白）。回归用例：新增 `test/review-fix-redaction-structural-keys.test.mjs`（12 项：结构键的 16 种形状与嵌套/数组/数值/数组值、普通证据不被脱敏、丢弃列表、fail-closed 键名、`maxTokens` 的过度脱敏、`exp-*.md` 的每个字段、不含凭据时的两种字节一致性、两处残余、点号拼写、`measure()` 端到端与事件桥、晋升锁 token，以及一条显式记录的残余；其中 10 项在还原到本轮改动前的工作树上失败），并给 `test/review-fix-redaction-scheme-key-anchored.test.mjs` 的"只有一份实现"断言补上 `CREDENTIAL_KEY` 唯一性与键名判定派生自它的三条断言。

- **测量行仍是有界遥测行：`measure()` 的 `metrics` / `beforeMetrics` / `afterMetrics` 回到行上限。** 上一轮把这三个字段一并接进 `EVIDENCE_PROJECTION`（放开 `maxText` / `maxItems` / `maxDepth`），但它们从来不是档案文档：改动前它们走的是 `compactValue()` 的默认上限（1,200 字符 / 8 项 / 深度 4）。后果是工具调用方能按任意倍数放大落盘的观测记录：同一份输入实测（第 2 轮工作树 → 本次修复后），200 项数组落盘 13,410 字节 → 546 字节（只剩前 8 项，24.6×），5,000 字符字符串 5,011 字节 → 1,225 字节（1,200 字符加标记，4.1×）。被放大的正是 journal、evidence sidecar、`exp-*.md` 与事件桥 payload 共用的那条观测值。现在这三个字段恢复为 `compactValue(input.metrics)` 的默认上限：**数组只保留前 8 项**（多出的直接丢弃，不写省略号），**字符串保留前 1,200 字符加 `…[truncated]`**，与上一轮之前的存储形状逐字节一致（1,200 字符以内的字段；超过 `REDACTION_TEXT_BOUND` 的字段按既有规则换成 withheld 标记，与这一条无关）。**脱敏不受影响**：键名判定（`token` / `api_key` / `password` 等，任意深度、任意值类型）就写在 `compactValue()` 的对象分支里，所以 `{ token: <secret> }`、`{ nested: { api_key: <secret> } }`、`{ rows: [{ password: <secret> }] }` 依然整体替换成 `[redacted]`；恢复上限只改长度，不改任何脱敏判定。其余 evidence 字段（`propose()` 的自由文本、`measure()` 的 `benefitEvidence` / `cleanupEvidence` / `performanceChange` / `errorChange` / `observationWindow`、`renderExperimentArchive()` 的 proposal 与两个 JSON 块）保持**各自改动前原有的无上限语义**：它们在同一位置本来就是原样落盘/整段渲染的，收紧会改变大输入下已存储的字节，因此本轮不动。回归用例：`test/review-fix-redaction-structural-keys.test.mjs` 第 6 节三项——有界性钉住精确形状（前 8 项、1,200 字符 + `…[truncated]`、1,770 字节）且断言数组尾部既不到达事件桥也不到达 `exp-*.md`，脱敏钉住三种嵌套形状仍为 `[redacted]`，第三项钉住同一份对象在遥测行路径上的既有上限（说明这三个字段本来就该有界）。两个方向都做了失效验证：把这三个字段改回 `EVIDENCE_PROJECTION` 时第一项失败，去掉键名判定时第二项失败。
- **回滚证据（`rollbackResult` / `cleanupProof` / `recoveryProof`）也拿到键名判定，三处 logger 不再插值原始错误文本。** 本轮修两个仍然存在的明文出口，都不改任何上限。(1) **`safeErrorEvidence()` 少了键名判定。** 结构化键名那一轮只改了 `compactValue()`：键与值已经是两个对象属性时任何文本规则都匹配不到；`lib/orchestrator.js` 的 `safeErrorEvidence()` 是**第二个**结构化遍历者，也是 `rollbackResult`、`cleanupProof`、`recoveryProof` 的唯一边界，而它只保留了自己的丢弃列表（`raw|fullOutput|stdout|stderr|logs?|transcript`）与 `ERROR_TEXT_KEY`，于是结构化凭据键原样穿过：修复前实测 `snapshotEvidenceFromRecord({ cleanupProof: { evidence: { access_token: <secret> } } })` → `{"evidence":{"access_token":"<secret>"}}`、`{ error: { password: "hunter2" } }` → 明文、`{ records: [{ token: <secret> }] }` → 明文、`{ a: { b: { apiKey: <secret> } } }` → 明文，而同一串以**文本**形式出现（`password=<secret>`）早已被脱敏。端到端同样可复现：`revert` 里 `stop()` 返回 `{ ok: false, access_token: <secret> }` 时，`failure.rollbackResult.stop` 带着明文进入 `exp-*.md`。现在 `safeErrorEvidence()` 的对象循环按**同一个判定顺序**处理每个键：丢弃列表 → 凭据键名 → `ERROR_TEXT_KEY` → 递归；命中键名时该键的值**整体**换成 `[redacted]`（字符串、数字、布尔、对象、数组一致，任意深度、对象数组内、`PROOF_EVIDENCE_BOUNDS` 覆盖到的第 5 层都生效，`credential` / `credentials` 这类容器也整体替换）。判定用的是**同一个** `isCredentialKeyName()`（由唯一的 `CREDENTIAL_KEY` 列表派生），**没有**第二份拼写表、没有新正则族、没有收窄 fail-closed 方向；上限保持原样：`safeErrorEvidence()` 自己的默认 `maxDepth 4 / maxItems 8`、证明路径的 `PROOF_EVIDENCE_BOUNDS { maxDepth: 8, maxItems: 512 }`、字符串分支的 `redactCredentialShapes(value).slice(0, ERROR_SUMMARY_MAX)` 一律未改，超过深度仍是既有的 `[compacted]`。(2) **三处 logger 插值原文。** `lib/registration.js` 的启动漂移检查失败与 `agent/error` 观察者失败、`lib/domain-storage.js` 的事件日志检查点未写入，原先都写 `` `${error?.message || error}` ``；日志本身就是一条边界，现在三处都改用既有的 `safeErrorDto(error, "<阶段>").errorSummary`（另附 `errorCategory` 与 `errorDigest`，保留"哪个阶段失败"与"两次失败是否相同"），没有新增辅助模块、没有循环 import（两个文件本来就从 `./orchestrator.js` 取边界）。回归用例：新增 `test/review-fix-plaintext-proof-keys-and-log-sites.test.mjs`（10 项，其中 7 项在只还原本轮改动的旧实现上失败）——证明路径的四条审计形状 × `cleanupProof`/`recoveryProof`、任意值类型与 `credential` 容器、`PROOF_EVIDENCE_BOUNDS` 第 5 层与超限 `[compacted]`、普通证据逐字节不变且 `ERROR_TEXT_KEY` 与丢弃列表行为不变、`revert` 端到端的 `failure.rollbackResult` + `exp-*.md` + evidence sidecar + 事件桥均无明文、不含凭据的回滚回执与完整证明投影后逐字段（含 JSON 字节）与本轮前一致；三个 logger 站点**全部**用行为路径驱动（漂移：让被 import 的 drift engine 模块在 import 时抛错；观察者：让 `observeAutonomous` 拒绝；检查点：在 `openDomainStorage` 的重放里对检查点文件注入 `renameSync` 失败），断言日志行仍带阶段名、带 `[redacted]` 与摘要、不含带标签的密钥。并给 `test/review-fix-redaction-scheme-key-anchored.test.mjs` 的"只有一份实现"断言补两条：`isCredentialKeyName()` 只有一个定义，且结构化边界恰好是 `compactValue()` 与 `safeErrorEvidence()` 两处（`if (isCredentialKeyName(key)) {` 出现 2 次）。**本轮未关闭、如实记录的两处剩余出口**：(a) `lib/dockyard-domain/observation.js` 的 `SENSITIVE_KEY_PARTS` 不含 `authorization` / `cookie` / `session*`，但它在仓库内唯一的调用方是 `lib/domain-storage.js` 的 `projectObservation()`，后者返回固定形状且没有 `evidence` 字段，因此生产路径不可达——这是导出领域 API 的残余，不在本轮修；(b) `lib/diagnostics.js` 在行不可解析时会把 `String(parsed.error.message)` 的前约 10 个字符写进诊断输出，同样保留。此外 `propose.why` 与档案 `observations` 的既有无上限语义本轮**没有**收紧（不是本轮目标，改动会改变大输入下的已存字节）。
- **容器值分支的标记守卫被删除（它自己就是一条泄漏路径），且数组代理不再让 `safeErrorEvidence()` 抛错。** 两处外科手术式修复，不改任何上限、键表、正则族或持久化格式。(1) `lib/orchestrator.js` 的 `CONTAINER_VALUE` 原来是 `[\[{](?!\[redacted\])[\s\S]*`：守卫写在开括号**之后**，测到的是开括号后面的文本而不是值，因此唯一会让它失败的输入恰好是“值自身以 `[redacted]` 开头”那种；一旦失败就由更短的备选分支接管，值在第一个 `]` 处结束。修复前实测（`safeErrorDto(new Error(msg), "probe").errorSummary`）：`credentials=[[redacted],"<secret>"]` → `credentials=[redacted]],"<secret>"]`、`password=[[redacted],"<secret>"]` → `password=[redacted]],"<secret>"]`、`payload={"credentials":[[redacted],"<secret>"]}` → `payload={"credentials":[redacted]],"<secret>"]}`；经完整 propose → trial → measure → archive → promote 路径可复现，明文出现在 evidence sidecar 与晋升 journal 里（该端到端复现来自独立复核，本轮自己只重跑了 `safeErrorDto` 与证据投影两层）。修复是**删除**守卫而不是移动它：它想换取的“第二次投影稳定”从来不成立（重新脱敏本身就是幂等的，`password=[redacted]` 一次、两次后都是 `password=[redacted]`），而把它移到开括号前、只在剩余文本恰好是 `[redacted]` 时跳过，会让 `password=[redacted]` 落到裸值分支（在结构终点 `]` 处停下）并输出 `password=[redacted]]`，反而破坏幂等。容器的既定代价在该轮**未变**：`{"password":{"a":1},"retry":3}` 与 `{"password":[redacted],"retry":3}` 仍渲染为 `{"password":[redacted]`；当时引号标量值还保留 JSON 邻居（`{"password":"x","retry":3}` 不变），第十五轮起这一点不再成立，见下一条。(2) `safeErrorEvidence()` 的数组分支只把 `slice()` 包进了守卫，随后的 `items.map(...)` 在守卫外：一个 `slice` 被覆盖为返回非数组（例如 `{}`）的数组 Proxy 因此抛出 `TypeError: items.map is not a function`，越过一条“non-throwing”声明。现在 `Array.isArray(items)`、`items.length` 与每个下标读取都在守卫内，失败时只把**该节点**降级为既有的 `[compacted]`，单个不可读元素也单独降级，同层可读元素与记录的其他字段照常保留（`{ status: 'failed', errors: <proxy>, stopOk: true }` → `{ status: 'failed', errors: '[compacted]', stopOk: true }`）。回归用例：新增 `test/review-fix-redaction-round6-container-marker-and-array-proxy.test.mjs`（6 项：标记容器在顶层与嵌在 JSON payload 里的两种形态、一次/两次投影的逐字不动点、容器代价与引号标量的非回归、数组 Proxy 的三种失效形态与同层字段保留），其中 5 项在只还原本轮两处改动的旧实现上失败。`RELEASE.md` 第 6 节第 21 / 29 条与第 7 节同步改写：容器分支现在描述为“认领到文本末尾且无标记例外”加既定代价，`orphanLockEntry()` 的说明补上“连 `.orphan` 改名也失败时副本留在 `<lock>.<uuid>.released` 私有名上”这一层。

- **凭据赋值的值改为“文本剩余全部内容”（收敛简化，不是又一层补丁）。** `lib/orchestrator.js` 的 `CREDENTIAL_ASSIGNMENT` 一旦命中（`CREDENTIAL_KEY` 里的键 + `:`/`=` + 可选逻辑空白），值就是**到文本末尾的全部内容**：没有结构终点、没有引号配对、没有括号配平、没有首字符限制；替换结果是“赋值前缀 + `[redacted]`”，值的字节一个都不保留。原因是连续三轮对抗性复核各自找到了“值提前结束”的**另一种**形态——先 scheme 文法边界、再容器/引号/分号、再标记形态——而它们来自同一个概念：“给值找一个结构终点，好让兄弟字段留下来”。本轮删除这个概念本身，并一并删除只为它存在的 `QUOTED_RUN` / `STRUCTURAL_VALUE_END` / `VALUE_TAIL` / `BARE_VALUE` / `DOUBLE_QUOTED_VALUE` / `SINGLE_QUOTED_VALUE` / `UNTERMINATED_QUOTED_VALUE` / `CONTAINER_VALUE` 与重发开引号的捕获组：值规则现在只剩 `${CREDENTIAL_ASSIGNMENT}[\s\S]*`、替换为 `$1[redacted]`，模式表面比修复前**更小**。修复前实测（`safeErrorDto(new Error(msg), "p").errorSummary`）：`password=x]Q7v9ThirdPassSecret3` → `password=[redacted]]Q7v9ThirdPassSecret3`、`password=x}"Q7v9ThirdPassSecret3"` → `password=[redacted]}"Q7v9ThirdPassSecret3"`、`password=x];"Q7v9ThirdPassSecret3"` → `password=[redacted]];"Q7v9ThirdPassSecret3"`；修复后三者都是 `password=[redacted]`。**接受的代价（已用测试钉住，不读作无损）**：`{"password":"x","retry":3}` 渲染为 `{"password":[redacted]`——凭据键之后的闭合引号、逗号与全部兄弟字段一起消失，该片段单独不是合法 JSON（作为嵌入字符串仍安全）；凭据赋值之后任何后续行上的文本也一并消失。这是刻意用诊断细节换一个无法截断的边界；保留下来的是键名、失败类别与摘要。`REDACTION_TEXT_BOUND`（65,536）与超限 withheld 行为、non-throwing 入口、URL userinfo / 厂商前缀 / AWS key id / 独立 `Bearer` 四族、以及按键名的 `isCredentialKeyName()` 结构化判定全部未改；幂等性由测试显式断言（`password=[redacted]` 与 `{"password":[redacted]` 一次、两次投影后逐字不变）。回归用例：新增 `test/review-fix-redaction-round7-whole-remainder-value.test.mjs`（7 项：本轮四条探针、结构终点字符在其后与在首字节两组形态、容器与标记形态、1–4 层 JSON 转义、代价与不动点、以及“规则只剩一条且旧常量已删除”的源码断言；这 7 项在只还原本轮改动的工作树上全部失败），并把 `test/review-fix-redaction-{escape-unknown-scheme,quoted-value-closing,round5-value-and-key-boundaries,round6-container-marker-and-array-proxy,scheme-key-anchored,structural-keys}.test.mjs` 里所有“凭据赋值之后保留兄弟字段/闭合引号/结构终点”的断言逐条改成 fail-closed 期望（11 项用例更新，均为收紧；没有删除、跳过或放宽任何断言）。
### 恢复与晋升状态机

- **`<dataRoot>/promotion/` 目录存在但没有 `journal.json` 时拒绝，而不是当成"无事务"。** 新增 `promotionStateKnown()` 作为唯一的目录存在性规则（阶段性判定仍在 `classifyPromotionJournal` 里），`recoverInterruptedPromotion()` 与 `readCanaryJournal()` 共用它：目录不存在才是没有事务，目录存在而 journal 缺失则抛出携带现场路径的错误并保留目录。`writeDurablePromotionUnlocked()` 同步取消原来的"准备阶段递归删除状态目录"，改为发现目录仍在就直接报错。原因是旧行为会把一个未知现场当作空白状态清掉。回归用例见 `test/orchestrator-integrity-orphan-promotion-state.test.mjs`。
- **canary 不再从 durable 证据重建状态机。** 没有活的 journal 时 `evolution_canary_observe` 直接拒绝（不再物化一条 in-memory 记录、也不再合出一个 in-memory journal），已 stable 提交的晋升因此不能被重新打开为 `canary-observing`；晋升所有者只从 durable 状态读取（journal → evidence sidecar → 本 session 的记录），调用方的 agent id 不再是 fallback；journal 属于别的 experiment 时直接拒绝。原因是旧的 fallback 让任何会话都能接管一个 journal 已清理的晋升。回归用例见 `test/orchestrator-integrity-canary-owner.test.mjs`。
- **stable-committed 恢复在删 journal 前把 canary 屏障落到 sidecar 与 archive。** 新增 `persistCommittedCanaryEvidence()` 与 `mergeCanaryEvidence()`（按 `barrierId` 取并集、`startupVerified` 只升不降），在清理状态目录之前写入证据快照与 `exp-*.md`；写失败就抛错并保留 journal。原因是 `committed-pending-cleanup` 的 journal 是那批屏障最后的 durable 副本，旧实现直接删目录会连同证据一起丢掉。回归用例见 `test/orchestrator-durability-stable-commit-evidence.test.mjs`。
- **`Include.refresh()` 等被移除 entry 的异步 dispose。** 加载器的 `EntryGroup.remove()` 调 `entry.fiber?.dispose()` 后立刻删 store 槽位，`EntryTree.await()` 已经看不到那个 entry；现在 refresh 先用 `tree.root.data` 记下活动行与其 fiber，刷新后对不再是同一 fiber 的 entry 逐个 `await fiber.await()`。确认不了（没有可 await 的 fiber，或 dispose 抛错）时 refresh 抛错，回滚因此保留 journal 并报 `rollback-failed`，而不是在 dispose 结果未知时声明完成。回归用例见 `test/orchestrator-durability-refresh-dispose.test.mjs`。
- **terminal evidence 写入不再卡住清理。** 新增 `archiveTerminal()` 与 `emitEventSafely()`：归档或事件写入失败只记一条 warning（`record.archiveWarning` / `record.eventBridgeWarning` 加 logger），清理放在 `finally` 里执行。Trial 的 `define` / `run` 失败、`revert`、晋升门禁拒绝、Package inspection 失败、运行时未恢复、晋升写入失败六条路径统一按这个形状改写；其中 `runtime-not-recovered` 仍**故意**保留目标锁（不变量 3）。原因是一次证据写失败不应该让目标锁与实验记录永久留在内存里。回归用例见 `test/orchestrator-durability-trial-failure-cleanup.test.mjs`。
- **晋升提交对每个计划目标都做 CAS。** `writeDurablePromotionUnlocked()` 改为在写之前逐个比较 `records` 里每个 `file` 目标与 prepare 时记下的 `beforeDigest`（旧实现只比较 composition），因此 `EVOLUTION.md` 或 archive 被外部改动也会被拒绝而不是覆盖。回归用例见 `test/orchestrator-durability-promotion-transaction.test.mjs`。
- **归档与重放保留 canary 证据。** `renderExperimentArchive()` 在存在屏障时写出 `## Canary` 段，`replayExperimentEvidence()` 接受调用方传入的额外 durable 来源（`sources`）并透传 `canary`。原因同上：屏障的证据不能只活在将被删除的 journal 里。

### 并发与原子性

- **晋升事务的写入是 durable 的。** `writeAtomic(file, content, { durable })`：durable 路径先 `fsync` 临时文件再 `rename`，随后 `fsync` 所在目录，目标目录是本次新建时再 `fsync` 它的父目录；`writeJournal()`、晋升写入的三个目标、晋升的 `package.json` 与生成的模块、以及 `persistEvidenceSnapshot()` 都走这条路径。只有晋升事务与它不能丢的证据 opt-in，普通实验档案写入的 fsync 次数仍然是 0。原因是崩溃后恢复能依赖 journal 的前提是 journal 与它记录的目标先落到盘上。回归用例见 `test/orchestrator-durability-promotion-transaction.test.mjs` 的 `P2-8` 两项。
- **领域锁的回收与释放都按身份校验。** `lib/domain-storage.js` 把"判定锁过期"与"删除锁"拆开：先 `rename` 到私有名，再用 `dev`/`ino` 与内容复核它确实是刚才判定的那一份，不一致就放回原位并返回 `lock-replaced`，只有一致才删除。获取与释放都记下自己的 `{ identity, raw }`，`close()` 因此不会删掉另一个 owner 的锁。残余竞态已记入 `RELEASE.md` 第 6 节第 21 条。回归用例见 `test/storage-transaction-init-lock.test.mjs`。
- **初始化失败不再把锁留给自己。** `ctx.storageDomain.open()`、`root`/`staging` 目录创建与 `replay()` 全部收进同一个 try：失败时关闭已打开的 storageDomain 并且只释放本次写入的锁，同一进程可以立刻重试（旧实现把 `mkdir` 放在 try 外面，失败一次就让后续重试撞到自己的 pid）。回归用例同上。
- **applied ledger 在恢复之后才读。** `mutate()` 改为在 `installPending()`（它会安装已提交 pending 记录的 ledger）之后读取当前 ledger，并把调用方传入的集合合并到恢复出来的集合之上。原因是旧实现用恢复前的快照写 pending，会把刚恢复的 marker 又从记录里抹掉，下一次重放就会重复应用已经应用过的事件。回归用例见 `test/storage-transaction-applied-ledger.test.mjs`。
- **`installArchiveFiles()` 先整体校验再安装。** 现在先把变更集里每个文件都验完（合法相对路径、中间目录逐级不是符号链接、是普通文件、字节数与 sha256 与提交时一致），全部通过之后才开始写；中途任一项不符则一个 live 字节都不动。新增 `archiveDirectories()` 逐级检查并在 `create` 时逐级创建，避免 `mkdir -p`/`rename` 跟随中途出现的符号链接走出数据根；符号链接被拒绝时错误带上 `E_DOMAIN_ARCHIVE_SYMLINK`。原因是旧实现是边校验边安装，失败会留下一个"已发布一半"的树。回归用例见 `test/storage-transaction-archive-install.test.mjs`。
- **canary 观察串行化。** `observeCanary()` 用 revert/promote 同一套 in-process claim 按 experiment id 串行化，第二个并发调用收到 `experiment <id> is busy with canary`。原因是 journal 是读-改-写文件，两个并发观察都会读到同一批屏障，后写者会静默丢掉先写者的 barrier。回归用例见 `test/orchestrator-durability-stable-commit-evidence.test.mjs` 的并发/顺序两项。
- **冷档案写入失败不再让热副本与档案分叉。** `EvolutionMemory` 新增 `archiveStale`：归档写失败时把该 key 标为"档案里的副本已陈旧"，从 `archiveKnown` 里移除，下一次驱逐或重新归档必须写它；同时记一条 `deferred-write` 故障。hot 命中且档案也持有该 key 时不再原地改写档案，改为标陈旧，由驱逐时的那次追加落盘。冷-only 知识行的更新（`replaceExisting`）失败时整个 mutation 抛 `E_ARCHIVE_WRITE_FAILED`，因为那一次追加**就是**更新本身，忽略失败等于把调用方拿到的合并结果丢掉。回归用例见 `test/memory-integrity-cold-archive.test.mjs` 的 `P2-5`、`P3-4` 与写入失败项。
- **`load()` 不再向 live 冷档案追加。** 新增 `deferLoadArchiveWrites`，`lib/domain-storage.js` 的 live 视图加载时打开它：超限记录先留在本实例的热投影里，由下一次 mutation 自己的 staged 事务归档。原因是旧实现的 load 期驱逐会在任何 staged 事务之外直接追加 live 档案文件，崩在那里就会留下没人能修的残片。回归用例见 `test/storage-transaction-load-archive-writes.test.mjs` 与 `test/memory-integrity-cold-archive.test.mjs` 的对应用例。

### 输入与边界

- **`satisfiesRange()` 按 semver 比较并实现 comparator 集合的 prerelease 资格规则。** `lib/diagnostics.js` 的版本解析与比较重写（数字标识符按值、数字低于字母数字、字母数字按 ASCII、更长标识符集更大、无 prerelease 高于带 prerelease、拒绝前导零）；prerelease 版本只有在同一 `major.minor.patch` 被该集合内某个带 prerelease 的比较符点名时才满足该集合。改动前后对当前已声明范围与已验收宿主的判定完全一致（旧边界与结论见 `RELEASE.md` 第 6 节第 15 条）。回归用例见 `test/release-integrity-version-range.test.mjs`。
- **领域 manifest 的版本要求也按真实 semver 处理。** `lib/dockyard-domain/manifest-contract.js` 的 `satisfiesVersionRequirement()` 改为解析全部组件与 prerelease，`^`/`~` 用真实上界（`^0.2.3` 的上界从 `1.0.0` 变成 `0.3.0`，单段 `~1` 的上界从 `1.1.0` 变成 `2.0.0`），`*` 单独处理，非法范围不再静默当成匹配；依赖匹配改成先把 `provides`/`capabilities` 与组件 id 归一成一个名字集合，再用依赖的 `id`/`capability` 精确比较（旧实现对数组是精确匹配，但对写成单个字符串的 `provides` 会退化成子串匹配——`provides: "toolbox"` 满足了依赖 `tool`，而且两边都不 trim）。回归用例见 `test/domain-input-manifest-version.test.mjs`。
- **指标投影不再把 `"false"` 读成 true。** `lib/dockyard-domain/metric-projection.js` 新增 `booleanish()`：真正的布尔值、有限数字（0 为 false）与一组已知拼写（`true`/`1`/`yes`/`on`/`ok`/`success`/`passed` 与它们的反面）分别读取，认不出来就退回 `status` 判定而不是 `Boolean(text)`；component 的 `regressionPassed` 也走同一解析。原因是旧实现对非布尔值直接 `Boolean()`，字符串 `"false"` 因此是 true，指标和回归标记同时被读反。回归用例见 `test/domain-input-metric-boolean.test.mjs`。
- **知识累积器不再写出 `null`。** `lib/dockyard-domain/knowledge.js` 的 count/sum/fitness 累积改为饱和（`±Infinity` 饱和到 `MAX_SAFE_INTEGER`，`NaN` 读作 0，合并时修复存量非有限值），`delta` 也走同一饱和；事件 id 窗口从 64 改为 256，并把被挤出的条数记在 `eventIdsDropped` 上。原因是 JSON 会把非有限数字写成 `null`，而旧实现直接在存量值上相加：计数一旦溢出就永久变成“没有计数”（下次从 `Number(null) || 0` 重新开始），`eventIds` 窗口静默丢弃后记录又看起来仍然完整。回归用例见 `test/domain-input-knowledge-accumulator.test.mjs`。
- **长身份维度不再相互碰撞。** 身份维度超过 240 个 UTF-16 单元时，旧实现只保留前缀（`slice` 按 UTF-16 单元切，还可能切开代理对），于是前 239 个单元相同的两个事实共享一个身份。现在 `boundedIdentityText()` 按 code point 保留前缀并附上完整文本的 16 位摘要。归一化后 **UTF-16 长度** ≤ 240 的维度值逐字节不变（旧 key 不变）；UTF-16 长度 > 240 的维度值会改变：code point 数 ≤ 240 时整段保留，> 240 时截断到 240 code point 并附 16 位摘要——两类都是一次性的、可解释的漂移（见 `RELEASE.md` 第 6 节第 24 条）。回归用例见 `test/domain-input-knowledge-truncation.test.mjs`。
- **守卫覆盖更多目标无歧义的直接写入。** `lib/guard.js` 新增：`cp`/`mv`/`install`/`ln` 的 `-t`/`--target-directory`、`dd` 的 `of=`、`sh`/`bash -c` 与 `xargs` 的内层命令（递归解析，最多 4 层，到上限后退回"内层同时出现写动词与受保护字样"的保守判定）、`node`/`deno`/`bun` 的 `-e`/`--eval`/`-p` 内联代码、`git -C`/`--git-dir`/`--work-tree`；子 shell 的分组括号不再当成命令词或操作数，`Deno` 写入家族的 `Sync` 变体不再因前缀匹配漏判。判定依据仍然只是"真正会被写到哪"。它仍然不是沙箱，未覆盖的形态与理由见 `RELEASE.md` 第 6 节第 3 条。回归用例见 `test/guard-coverage-trust-root-direct-writes.test.mjs`。
- **冷档案的不可解析字节变得可观测。** `#readArchiveSync()` 不再静默跳过解析失败的行：活动文件未终止的最后一行记为 `torn-tail`，其余记为 `invalid-line`，读不出的文件记为 `unreadable`；新增公开的 `archiveIntegrity()` 返回按集合分类的故障，`verifyConsistency()` 把 `invalid-line`/`unreadable` 判为 `valid:false`（reason `archive_bytes_unreadable`），因此 `reconcile()` 在这种档案上会拒绝执行。活动文件不以换行结尾时，下一次追加先把残片**逐字节**追加进 `state.json.<collection>quarantine-archive.jsonl` 再原子重写活动文件（append-only、插件不自动删除）。回归用例见 `test/memory-integrity-cold-archive.test.mjs` 的 `P1-1` 与 `P3-2`。

### 发布与供应链

- **`readTarEntries()` 对非普通文件条目 fail-closed。** 旧实现跳过任何非普通文件的 tar 条目，而 `contentDigestOf` 只算它见过的文件，因此"字节不同但 `contentSha256` 相同"是可能的。现在硬链接、符号链接、目录、字符/块设备、FIFO、GNU sparse、pax 扩展头与 GNU 长名全部直接报错并带上类型名。已实测当前 `release/` 下 11 个产物共 555 个条目全部是普通文件条目，因此既有摘要全部不变；这也意味着未来某个 npm 版本写出目录/pax 头时打包校验会直接失败，需要拿真实产物依据扩展白名单。回归用例见 `test/release-integrity-tar-entry-types.test.mjs`。
- **provenance 只认真正的 release tag。** `scripts/release/verify-provenance.mjs` 改用 `git rev-parse --verify --quiet refs/tags/<tag>^{commit}`，不再用裸 `<tag>`（后者会把同名分支或其它 ref 当成发布 tag），失败信息也改成 `does not resolve to refs/tags/<tag>`。回归用例见 `test/release-integrity-release-workflow.test.mjs`。
- **发布 workflow 不再把外部输入拼进 shell 脚本。** `.github/workflows/release.yml` 的 tag 改为先做 `vMAJOR.MINOR.PATCH[-prerelease]` 正则校验，再通过 `env:`（`RELEASE_TAG` / `REQUESTED_TAG` / `DEFAULT_BRANCH`）传给后续步骤；`gh release create` 加上 `--verify-tag`，避免 `gh` 在 tag 不存在时从默认分支偷偷建一个。原因是 `${{ github.event.inputs.* }}` 与 `github.ref_name` 都是调用方可控文本，直接拼进 `run:` 就是命令注入面。回归用例见 `test/release-integrity-release-workflow.test.mjs` 与 `test/workflows.test.mjs`。
- **`write-all` 的 workflow 守卫变得真的能失败。** `test/workflows.test.mjs` 原来在已序列化的 YAML 文本里找 `permissions: write-all`，但序列化形式永远是 `"permissions":"write-all"`，所以这条断言从未可能失败。现在改为解析后的文档上直接比较 `workflow.permissions` 与每个 job 的 `permissions`，并新增一条"该守卫确实会拒绝"的自我验证用例。

### 性能

- **冷档案读取按文件身份缓存。** `#readArchiveSync()` 先对每个档案文件做一次 `stat`，用 `dev + ino + size + mtimeNs` 拼出文件身份，命中就复用上一次的解析结果；自己追加的行只在"active 文件是读取顺序里最后一个、且身份正好增长本次追加的字节数"时并入缓存，其它情况一律丢弃重扫。没有它，一条带知识身份的 mutation 会整份读取冷档案两次（knowledge 与来源集合），累计成本随档案增长呈二次。实测（`docs/performance/archive-read-cost.md`，交替 A/B 各 6 样本）：每 16 次追加的读取字节下降 19.9–20.0×（1.41 / 7.08 / 28.38 MiB 三档），单条 mutation 壁钟 0.59 / 0.55 / 0.51×；进程内第一次读不获益（0.96–1.01×）。代价约 0.7 MiB heap / MiB 冷档案（48 MB 上限附近约 34 MiB），`compact()` 后丢弃重建；身份依赖纳秒 mtime，与 `archive-stage.js` 和 scan memo 同一假设，秒级 mtime 文件系统上同尺寸原地重写可能读不到（见 `RELEASE.md` 第 6 节第 20 条）。回归用例见 `test/memory-perf-archive-read-cache.test.mjs`。
- **明确没做的性能改动。** sealed 段不在 `load()` 重算 sha256（全量重算占 `load()` 的 26% / 45% / 57%，见 `RELEASE.md` 第 6 节第 19 条）；`#sourceMatches` 对每条冷来源行重算兜底 key 的 O(冷档案) 成本未动（40 000 行规模约 76 ms/次 mutation，是剩余成本的主项）。两者都只记录为边界，收益/等价性没有可分离的证据前不改语义。

### 独立审核追加修复（第二至第七轮）

上面各项落地后，另做了七轮独立对抗性审核。审核在**本轮的改动本身**里又找出并已修复以下缺陷（每条都先有失败复现、后有回归用例）：

- **身份归一化丢掉了 `trim()`。** `boundedIdentityText()` 直接返回原文，而它取代的 `boundedText()` 会先 `trim()`；于是短记录里前导/尾随空白的身份也被改变（实测语料里 9 条记录漂移）。修正为先 `trim()` 再按 code point 界定，长度不超过 UTF-16 长度上限的维度重新逐字节等于冻结产物。
- **完整 JSON 缺尾换行被当成残片隔离。** 活动档案最后一行若是完整可解析的记录、只是少了结尾换行（外部写入造成），旧逻辑会把它整行搬进隔离文件并从活动档案删除，记录因此从 `history()` 消失（字节未丢）。现在先判断该行是否可解析：可解析就只补一个分隔字节，不可解析才隔离。
- **doctor 对「有 `promotion/` 目录但没有 `journal.json`」报 `degraded`，而运行时会拒绝启动。** 两处判定不一致会把「插件起不来」报成「插件仍在工作」。doctor 改为 `blocked` + `state-unknown`，并新增断言「doctor 既不移动也不删除无法分类的现场」。
- **`Fiber.await()` 未纳入接口审计。** 它在 `verify()` 里早已使用，本轮又扩到回滚的 `refresh()`，但 `lib/cordis-compat.js` 的 `SURFACES` 没有探测它，doctor 因此无法报出宿主丢了这个方法。新增一条 `required: false` 的探测（缺失进 `advisoryUnavailable`，不会把健康报告变 degraded）。
- **归档读取缓存的追加快路径会掩盖同长度外部改写。** 旧实现只比对 inode 与「增长字节数正好等于追加字节数」，且是在**追加之后**才取身份，于是同长度原地改写的文件被当成「缓存 + 追加行」接受，随后 `compact()` 把陈旧值写回磁盘。现在在 `appendFile` **之前**取身份，与缓存身份逐字段全等（含 `mtimeNs`）才允许并入，任一不等即丢弃缓存。
- **领域锁的「放回」会覆盖期间的第三方锁。** 复核失败后原来用 `renameSync(moved, lock)` 放回，而 POSIX `rename` 会静默覆盖已存在的目标；隔离窗口里第三方新建的锁因此被摧毁。改为 `linkSync`（`EEXIST` 即被占用）+ 成功才 `unlink`，不支持硬链接的文件系统回退 `copyFileSync(..., COPYFILE_EXCL)`；目标被占用时把私有副本留成 `${lock}.<uuid>.orphan` 并返回失败。
- **pending 恢复后调用方账本可以覆盖已提交的不同 MAC。** `replay()` 在安装 pending **之前**查账本，安装后 `{ ...recovered, ...applied }` 又让调用方的 MAC 覆盖刚恢复的；这绕过了既有的 `E_DOMAIN_EVENT_ID_CONFLICT`。新增 `mergeEventLedger()`，同 id 不同 MAC 即抛该错误且不发布 pending。
- **锁 fence 之后失锁仍能写入有效 pending。** 原来的 fence 是「写前检查」，检查与整文档无条件替换之间若锁被夺走，失败方仍会用自己的 aggregate 覆盖对方**已提交**的文档。新增持久 commit token（`<dataRoot>/domain-commit.token`）与发布前的文档级 CAS（`applied` 逐键、aggregate 确定性摘要），冲突时不写 pending、不写本端 aggregate。介质本身没有 CAS，残余窗口见 `RELEASE.md` 第 6 节第 27 条。
- **CAS 拒绝覆盖之后，失败归档又把刚保留的外部编辑覆盖掉。** 三目标 CAS 正确拒绝并把 journal 留在 `rollback-failed`，但 `promote()` 的 catch 随后经 `archiveTerminal()` 重写了同一个 `exp-*.md`。现在冲突路径**完全不写**该档案，失败证据写到同目录的 `<experimentId>.failure.json`（含脱敏后的失败摘要与 digest）。
- **`safeErrorDto` 的字符串转换仍可抛异常。** `safeString()` 在进入脱敏边界之前就被调用，因此恶意 `toString` / 抛错的 getter 会让 DTO 构造抛错；`revert()` 的 `disposeTrial()` 又在该分支的 `try/finally` 之外，异常使 `undefine()` 未执行、操作占用与目标锁一起遗留。现在属性读取与字符串转换都在保护内（只读 `message` 与 `code`），不可读即返回**同键集**的降级 DTO（`errorDigest: "sha256:unavailable"`，不含原文），`phase` 非字符串回落；`disposeTrial()` 的两个 disposer 与 `revert()` / `promote()` 的清理都进受保护区域，`promotion-cleanup` 仍**故意**保留目标锁。
- **commit token 消耗了 `crypto.randomUUID()`。** 差分测试用确定性 UUID 序列比较两棵树，token 每提交多取 4 个 UUID 会让记录 id 整体错位。改用独立的 `randomBytes(16)` 熵源；token 语义不变（不透明、只做相等比较、0600、原子 rename、不 fsync）。
- **一个自造的脆弱测试已被删除。** 曾加过一条「源码级顺序不变量」，用正则匹配 `try`/`finally` 文本；实测把 DTO 挪到 `try` 之外它仍通过。已删除并改为 10 个**行为级**异常注入用例（覆盖 `trial()` / `revert()` / `promote()` 的转换抛错与清理自身抛错），其中 6 个在未修复实现上会失败。
- **性能复现脚本一度与实现脱节。** 改熵源后 `docs/performance/domain-write-path-commit-token.mjs` 的 stub 不再匹配，导致「当前开销」失去可复现证据。脚本已更新并保留「stub 不匹配即退出」的自检，另加「token-on 侧必须是仓库 `lib/domain-storage.js` 的逐字节副本」断言；重测两次有效运行后**撤回**了此前「两侧区间不重叠」的说法（其中一轮出现一对负值），只保留「约 +0.9 ms/提交、约 1%」的量级。
- **脱敏边界经五轮枚举逐步收敛。** 依次被击穿的形态：JSON / 带引号赋值、scheme 被赋值规则吃掉（`X-Auth-Token: Bearer …`）、`Digest` 参数列表、未知 vendor scheme 的参数前缀、`JSON.stringify` 之后的转义空白与多层转义引号，以及第五轮（最后一轮）的三处：容器值在第一个内层 `}`/`]` 处截断、裸值首字符类拒绝 `,;"'{}[]\`、已闭合的引号值在闭合处结束。现在改为「命中凭据键即整值脱敏（第十五轮起，值就是文本剩余的全部内容）+ 有界失败关闭」：超过 64 KiB 的单字段不再进正则族，直接换成不含原文的 withheld 标记；任何异常降级为同一标记，绝不回退原文或截断原文。五个阶段合计枚举规模从数千扩到 17.6 万组，最终残余见下。
- **值规则自身的三个边界缺陷（容器截断、裸值首字符、闭合引号后续接）与结构化键名的前缀容忍。** 第五轮（最后一轮）对抗性审核确认并复现了四个仍然泄漏的形态，它们都在“命中凭据键”本应整值脱敏的前提下发生：
  - `credentials={"a":{},"value":"<secret>"}` → `credentials=[redacted],"value":"<secret>"`：容器分支 `[\[{][^\]}]{0,512}[\]}]` 停在**第一个内层** `}`，看不见嵌套。现在值以 `{`/`[` 开头就认领到文本末尾（`CONTAINER_VALUE`），**不做括号配平**——配平会把值规则变成 JSON 解析器，还要它决定外层文档从哪里接回来，正是这条规则存在的理由。**代价（已用测试钉死，逐字记录）**：`{"password":{"a":1},"retry":3}` 渲染为 `{"password":[redacted]`，连 `,"retry":3}` 和外层闭合括号一起丢掉。**这一条描述的 `CONTAINER_VALUE` 分支与“引号标量值仍保留兄弟字段”的结论都已被后续收敛取代**：现在命中凭据键后整个剩余文本一律丢弃，`{"password":"x","retry":3}` 同样渲染为 `{"password":[redacted]`，八个别名常量（含 `CONTAINER_VALUE`）已删除，见本节末的整值规则条目。
  - `password=;<secret>` → 原样保留（**完全不匹配**）：`BARE_VALUE` 的首字符类排除了 `,;"'{}[]\`，所以值以 `;` 开头时整条规则没有落点。当时改成裸值接受任何不是结构终点的首字符，结构终点（`"`/`'`/`}`/`]`，或“逗号 + 引号片段 + `:`”即 JSON 字段分隔符）不变；第十五轮删除了结构终点这个概念，同一输入 `password=;<secret>` 现在是 `password=[redacted]`。
  - `Authorization: "Bearer aa" <secret>` → `Authorization: "[redacted]" <secret>`：引号分支匹配到闭合引号就结束，其后的材料没人认领。当时改成三段（裸值/双引号/单引号）共用同一个 `VALUE_TAIL`，闭合引号之后继续吞到结构终点；第十五轮把这三个分支连同 `VALUE_TAIL` 一起删除，值认领到文本末尾，因此不存在“结束方式”这回事了。
  - `{db_api_key: …}`、`{service_access_key: …}`、`{X-Goog-Api-Key: …}`、`{vendor_private_key: …}` → 修复前原样落盘：`db_api_key` 归一化成 `dbapikey`，既不是整名也不是整词，于是文本侧能命中（`api[-_]?key` 出现在 `db_api_key` 内部）而结构侧命中不了——结构化谓词比文本谓词弱。现在由同一个 `CREDENTIAL_KEY` 派生的 `CREDENTIAL_KEY_SUFFIX` 允许归一化键名以族内拼写**结尾**（前缀任意），四处形状与文本侧一致地为 `[redacted]`；`note`、`value`、`reason`、`status`、`latency`、`errors`、`successRate`、`tokenizer` 仍原样保留（`tokenizer` 不以 `token` 结尾）。代价是前缀容忍带来的更多误伤：任何以 `…token` / `…secret` / `…apikey` / `…privatekey` 等结尾的普通键名也会整值丢失。
  - **另两个从未过边界的测量字段与两条绕过固定渲染器的写路径。** `measure()` 的 `sideEffects` / `orphanResources` 只经过 `stringList()` 校验，所以 `sideEffects: ["password=<secret>"]` 原样进入 `exp-*.md`、evidence sidecar、晋升 journal 与事件桥，`orphanResources` 还进入回滚路径；现在两者逐元素过 `compactValue()`（行上限 1,200 字符，与 `metrics` 一致），不含凭据的列表逐字节不变。`EvolutionEventBridge.project()` 的显式 `payload.measurement` 与 `archive()` / `writeDurablePromotionUnlocked()` 两个自建 Markdown 的渲染器也不再假设捕获侧已经投影：桥边界对 `payload.measurement` 投影，两个渲染器对它们插值的 proposal 文本、observations 与 latest measurement 投影（`archive()` 还把同一个投影后的 proposal `why` 交给失败记忆）。
  - **两处“by construction 不抛异常”的声明原来是假的。** `lib/registration.js` 的 `agent/error` 监听器在拿到降级 DTO 之后又读了一次 `error.code`，一个抛错的 getter 会同步中断监听器（现在只用 DTO 的 `errorCode`）；`safeErrorEvidence()` 的 `Object.entries(value)` 在 Proxy / getter 上会抛（`Array.isArray` 在 revoked Proxy 上也会），现在读取单独包在保护里，读不出来就按 fail-closed 换成既有的 `[compacted]`，且嵌套节点自己失败不会带走可读的兄弟字段。
  - 回归用例：新增 `test/review-fix-redaction-round5-value-and-key-boundaries.test.mjs`（12 项：三条实测形状 + 必须保持干净的 `password=<secret>`、容器分支的接受代价与被换来的 JSON 不回归、既有 JSON/转义/多字段形状的钉住、四处前缀容忍键名与文本侧一致性、必须保留的 8 个键、`measure()` 端到端（记录/`exp-*.md`/sidecar/事件桥）与不含凭据列表不变、显式 `payload.measurement`、`archive()` 与晋升渲染器、抛错 getter 的监听器、Proxy/getter/revoked Proxy 的证明记录与普通证明不变）。其中 9 项在只还原本轮改动的实现上失败，剩下 3 项是刻意的“不得回归/不得变宽”钉住（它们在改动前就成立）。

**已知边界（均已写入 `RELEASE.md` 第 6 节第 29 条、第 7 节与代码注释，此处只做索引）**：脱敏上界 >64 KiB 会丢弃原先保留的前 240/1,200 单位；`errorCategory` 只读前 4 KiB（精度损失，实测 `regression` 落在 4,200 字符之后即漏分类）；**已识别** scheme 的材料越过其自身文法声明后仍可能保留这一条**已在第一轮关闭**（删除 scheme 文法层后 `Authorization: Bearer aa <material>` → `Authorization: [redacted]`，续接段落见上文与 `RELEASE.md` 第 6 节第 29 条）；值认领到文本末尾的代价（`{"password":{"a":1},"retry":3}` 与 `{"password":"x","retry":3}` 都 → `{"password":[redacted]`，闭合引号、逗号与兄弟字段一并消失）；结构化键名的前缀容忍带来的过度脱敏（以族内拼写结尾的普通键名整值丢失）；`measure()` 的 `sideEffects` / `orphanResources` 逐元素只保留 1,200 字符；`compactValue()` 自己的 `Object.entries()` 仍可能在 Proxy/getter 上抛错（它在证据与遥测路径上被调用，本轮只把 `safeErrorEvidence()` 的读取包进保护）；错误对象任一必要字段不可读时整份 DTO 降级（已可读的信息也丢失、不同错误共享同一占位摘要）；清理失败或结果未知时目标锁故意保留，代价是该 target 无法立即复用；领域文档提交在介质层没有 CAS，残余窗口需要同根多写者 + 陈旧锁误回收 + 写入窗口三重前置（违反 `PORTS.md` 的独占数据根契约）。

## 0.2.0-rc.14 — 冷档案身份路径的冗余规范化与六维投影重建

本候选在 `0.2.0-rc.13` 之上只做一件事：删除 `lib/dockyard-domain/knowledge.js` 冷档案身份路径上五处**可证明等价**的多余计算（文档中记作 A–E），并把版本推进到 `0.2.0-rc.14`。生产 delta 只有这一个文件（加上验证它的测试文件）；`lib/` 的其余文件、`release/` 之外的分发白名单、宿主支持范围与 `peerDependencies` 一律未动。

**未改的不变量**：`promotionGates` 的八项门禁、晋升二次确认、Trial 基线的单次同步捕获、journal 阶段判定、跨进程锁、CAS、领域存储持久化格式与 schema、授权边界、事件信封与签名算法、`knowledgeDimensions` 的键顺序（它进入持久化字节）、去重与 retention 决策、tombstone、latest-wins。**已存储身份的值不变**：`normalizeKnowledgeEvent()` 的逐字段投影、`knowledgeKeyOf()` / `canonicalKnowledgeKey()` 与固定产物逐字节相同，因此既有记录的身份、命中与保留结果不变。

- **A — 删除被完全包含的分隔符折叠**（`normalizeText()`）：`{_, /, \, |, :}` 里每个字符都不是 `\p{L}` / `\p{N}`，也不在保留的五个字符 `< > . ' -` 里，因此都被后一条类折叠 `[^\p{L}\p{N}<>.'-]+` 匹配；两个 pass 都把极大连续段替换成**一个**空格，而空格本身也是类字符，所以分隔符 run 不会切断它所在的类 run。对全部 1,112,064 个 Unicode 码点穷举确认：分隔符在类外 0 个、分隔符同时是保留字符 0 个。
- **B — 删除不会生效的尾部空白折叠与内层 `trim()`**：类折叠把每个极大非词字符段压成一个 ASCII 空格，而**每个空白码点都在类里**（穷举：`\s` 命中但类不命中的码点 0 个），保留字符里也没有空白，所以折叠之后不存在两个相邻空白；其后的六个短语替换的替换文本都不含空格（`timeout`、`out-of-memory`、`rate-limit`、`network-error`、`missing`、`failure`），不可能制造相邻空白。`boundedText()` 自己先 `trim()` 再截断，内层 `.trim()` 因此是死代码。
- **C — 身份哈希不再重建六键投影**：新增 `identitySerialization(dimensions)` 按 `JSON.stringify` 需要的排序顺序写出六维字面量，替换 `hash(dimensions)` 内部的 `stableStringify()` + `compactValue()` 遍历。六个维度名都不匹配 `VOLATILE_KEYS`，值都是 `dimension()` 返回的字符串，所以原路径只做了“按键名排序”；定序字面量产生同一字符串，转义也由同一 `JSON.stringify` 完成。返回给调用方的 `dimensions` 对象字面量键顺序**未改**，只有哈希的输入被换成等值字符串。
- **D — `hash()` 改用一次性 digest**：`createHash("sha256").update(data).digest("hex")` → `crypto.hash("sha256", data, "hex")`，省掉中间 `Hash` 对象；两者文档等价，字符串默认编码都是 utf8。`crypto.hash` 自 Node 20.12 / 21.7 起提供，`engines` 是 `^22.19.0 || >=24.0.0`，两端都在其后。
- **E — 删除控制字符折叠**：`\u0000-\u001f` 的每个码点都在类折叠的匹配集合内，且中间的三个 pass（两个标识符折叠、数字折叠）的字符类既不匹配控制字符也不匹配空格、`\b` 只看 `[A-Za-z0-9_]`，因此控制字符与它变成的那个空格在边界判定上完全一致；空格也不会切断被折叠的极大 run。短语替换排在类折叠**之后**，`time\u0000out` 需要的那个空格正是由类折叠提供的。
- **收益（隔离基准，`scripts/benchmarks/knowledge-identity-cost.mjs`，10,000 + 10,000 行）**：逐行身份 observations `49.88 → 36.38 ms`（**+27.06%**）、knowledge `90.30 → 67.18 ms`（**+25.60%**），每侧每场景 15 个样本取中位数。五个单项各自的隔离信号是 2.13%–10.63%，均大于同侧样本极差（0.5%–1.9%）。
- **收益（端到端 `port.observe()`，10,000 + 10,000 冷档案）**：三次同命令运行落在 wall −10.50%…−12.15%、CPU −8.53%…−10.13%，中位数 **−10.77% / −9.77%**（入库那次的 wall 是三次最大降幅、CPU 是三次最小降幅，因此引用中位数而非任一端点）。端到端的**单项**信号落在运行间漂移之内（五项 wall 之和 −8.2% 低于同次合计 −10.9%，E 的 CPU 只有 −0.32%），因此逐项收益只以隔离数据为准。
- **收益边界（如实记录为无收益）**：50 + 50 与空档案两档**必须读作噪声**。50 行冷档案的全部身份成本 ≈0.249 ms，本轮删掉其中 27.1% → ≤0.07 ms，约为一次 `port.observe()`（26–30 ms）的 0.25%；而三次运行测到的 wall 差值是 **+3.1%…+3.6%（慢）**，即 ≈0.9 ms——这是该负载**全部**身份成本（≈0.249 ms）的 3.6 倍，也是理论节省上限（≤0.07 ms）的 12 倍以上，不可能由“删掉计算”产生，CPU 差值同时变号。空档案没有冷行、身份扫描根本不发生，理论收益为 0，三次 wall 差值同样变号（−0.46% / +4.22% / −2.51%）。
- **已否决、未实现的候选（实测入库）**：合并两个引号替换（+0.07% / −0.32% observations、−0.16% / −0.15% knowledge）与破折号折叠加守卫（+0.23% / +0.15%、−0.02% / −0.72%）都落在同侧样本极差与运行间漂移之内，收益不足以支付代码复杂度，因此不纳入；两个候选树的专测与九侧轮换数据在 `docs/performance/knowledge-identity-normalization-attribution-rejected.json` 与 `...-attribution.json`。
- **回归测试**（`test/dockyard-domain/knowledge-identity-equivalence.test.js`，10 个用例）：`CORPUS` 增到 105 条记录，新增分隔符/类折叠重叠形状、控制字符紧贴短语（`time\u0000out` 等）、控制字符 run 与分隔符/空白混排、空白与不可见空格、两种引号折叠、带破折号的标识符，以及六个维度各自带信号各一条。新增六维投影再哈希属性测试：工作树的 key 必须是**工作树自身** `dimensions` 的排序投影哈希、该投影必须恰为六个名字、六个名字都必须被本树压缩规则保留（通过公开 API 探针读取，不复制 `VOLATILE_KEYS`），并用 `hashed >= 50` 防止语料退化后静默失效；另新增陈旧 stored key 冷行测试（存储键不命中、重算命中，折叠与落盘字节与固定产物一致）。属性测试**不**声称覆盖“值”，已存储身份的值由同一文件里的冻结基线差分（对照 rc.10 固定产物）负责。
- **变异牙齿（本轮实际复现）**：给 `dimensions` 加第七维而不扩 `identitySerialization()` 的字面量 → 属性测试 exit 1（`the working projection must expose exactly the six dimensions`）；给 `VOLATILE_KEYS` 前缀加 `rootCause|` → 属性测试 exit 1（`the working tree's own compaction must keep the dimension name rootCause`），整文件 4 fail。两个变异都在验证后逐字节还原。
- **等价性差分**：独立差分脚本以 rc.13 的 `lib/` 为基线，对 27 个代表性字符的单/双/三字符组合、短语×连接符×包裹组合、240 字截断边界组合、全部 44 个控制/不可见空白码点落在结构位上的组合、25 条具名控制字符形状，以及 20,000 条带种子随机字符串，比较整个 `normalizeKnowledgeEvent()` 投影、`knowledgeKeyOf()`、`canonicalKnowledgeKey()` 与 `knowledgeDigest()`：**659,872 次探针比较全部逐字节相同**；额外的映射相位把每一条含控制字符的生成字符串（23,034 条）整体替换成空格版本，要求固定产物自己的输出等于两个实现对空格版本给出的输出：**368,544 次比较全部相同**。该脚本本身不入库（仓库只保存它的结果数据，见 `docs/performance/`）；独立复核另行用自己写的脚本重做了 1,234,144 次完整输出比较（覆盖全部 0–0x10FFFF 码点与 120,032 个结构组合），同样**零差异**。另有独立持久化探针把缺键 / 陈旧键 / 冷热同 id / 重复事件 / tombstone 五个场景串起来跑，两个实现的返回 id 序列、知识投影计数、保留 observation id、tombstone 列表、`state.json` 与两个冷档案字节逐字段相同（`equal: true`）。
- **Node 22 / 24 兼容**：本候选唯一新增的 Node 专属 API 是 `crypto.hash`，已在声明的最低版本 `22.19.0` 与 `24.9.0` 上实际执行完整单测套件（`382 tests / 380 pass / 2 fail`，两个失败都是重新固定前的 `test/release-pin.test.mjs` 固定点检查，与本改动无关）。
- **固定点与验收**：`lib/dockyard-domain/knowledge.js` 是随包分发文件，因此本次改动改变了 `contentSha256`；`release/` 固定产物、`SHA256SUMS` 与三个宿主的验收证据按 `RELEASE.md` 重新生成（`npm run release:pack` → `npm run release:publish` → 针对固定 tarball 重跑三宿主验收），三者与工作树内容一致。`0.2.0-rc.13` 及更早的 tarball、校验和与 tag 字节保持不变，也未被覆盖。
- 性能分析、等价性论证、已否决候选、变异牙齿与复现命令的完整记录见 `docs/performance/knowledge-identity-normalization.md`（`docs/performance/` 不在包内容白名单内，不改变发布字节）。

## 0.2.0-rc.13 — 宿主支持面扩展与六处诊断/信任边界修复

本候选在 `0.2.0-rc.12` 之上做两件事：把官方 DSH `0.2.1-rc.2` 纳入已验证宿主并把候选版本推进到 `0.2.0-rc.13`；同时修复**六处**同源的“doctor / 运行时 / 磁盘事实不一致”缺陷。前三处是：诊断的 `host.version` 判定、诊断的事件桥 writer 判定、运行时事件桥去重集被外来 writer 记录污染；独立审核又确认了三处：doctor 的 writer 期望值来源与运行时不同、过期的 partial-tail repair 计划仍会执行、`--dump-config` 因 profile patch 把同一 bundle 拆成两个 section 而 doctor 按整行标题查找。因此 `lib/` 的 delta 是：`lib/diagnostics.js`（`diagnoseHostCli` 改为 `satisfies && verified`；`diagnoseEventBridge` 增加 writer 判定与 `untrustedWriters` 证据；`parseComposedProfile` 按基础名归并 section 并读取 `evolution-orchestrator.config.eventBridgeWriter`；`applyRepairs` 在截断 partial tail 前重新验证；`collectDiagnostics` 按 config → composition → bundle 默认解析期望 writer）、`lib/orchestrator.js`（新增导出 `EVENT_BRIDGE_DEFAULT_WRITER` 与 `eventBridgeWriterTrusted()`；`EvolutionEventBridge` 构造函数把 sequence 推进与去重占位放进同一可信判定；裸字面量改为常量）、`lib/domain-storage.js`（重放路径与 `E_DOMAIN_EVENT_AUTH` 判定改用同一谓词，锁语义注释与常量同步）、以及 `lib/compat/legacy-startup-drift.js` 的模块注释（只描述实际触发条件，无逻辑改动）。其余 `lib/` 文件与 `0.2.0-rc.12` 逐字节相同。

**未改的不变量**：`promotionGates` 的八项门禁、晋升的二次确认、Trial 基线的单次同步捕获、journal 阶段判定（`classifyPromotionJournal` 及其共用的两处拒绝）、跨进程锁、CAS、领域存储持久化格式与 schema、授权边界、事件信封格式与签名算法，以及事件桥的落盘格式——这些修复只改变“哪些记录算可信”、section 如何归并，以及修复执行前是否重新确认现场，不改变可信记录写出的字节。

- **为什么宿主面本身不需要改**：把 `0.2.1-alpha.1` 与 `0.2.1-rc.2` 两个宿主从 registry 解包后逐字节比对，本插件实际读取的宿主面（`lib/cordis-compat.js` 的 `SURFACES`：`ctx.registry.values()`、`ctx.reflect.props` / `store`、`Context.isolate`、`Fiber.getEffects()` 与 `state` / `uid` / `inject` / `store` / `inertia`、`ctx.reflect._getImpl()`、`ctx.events._hooks`、Include 的 `root.data` / `resolve()` / `await()`、Entry 的 `fiber` / `options` / `disabled`、`ctx.tools.schemas()`、`dynamicCordisRunner.*`、可选 `cordisInspect.list()`，以及 `lib/index.js` 的 `Service` / `Context` 与 `lib/promotion-include.js` 的 Include 默认导出 + `entryListSchema`）全部落在**零源码差异**或**纯增量**的包上。没有拿到任何真实失败证据，因此不做“看起来更像做了兼容修复”的改动。
- **上游差分（`0.2.1-alpha.1` → `0.2.1-rc.2`，逐字节比对，不靠推断）**：`@deepseek-ai/cordis` `4.0.5-alpha.2` → `4.0.5` 与 `@deepseek-ai/cordis-plugin-include` `1.0.10-alpha.2` → `1.0.10` 都是**零代码差异**（只有 `package.json` 的自身版本与自身依赖范围变，include 的 `src/index.ts` 与 `lib/index.js` 逐字节相同）；`@deepseek-ai/dsh-storage-domain` `0.2.0-rc.2` → `0.2.1-rc.2` 只有**两处 JSDoc 措辞**（`lib/index.js` 与 `types/index.d.ts` 各一处），`@deepseek-ai/dsh-storage-json` 的 `lib/` **完全一致**；`@deepseek-ai/dsh-cordis-host-runner` 只**重命名内部品牌函数**（`CordisDynamicPluginId` → `brandCordisDynamicPluginId` 等），导出名与签名不变；`@deepseek-ai/dsh-tools` 删除 `lib/invariant.js`、新增 `lib/ptc-calls.js`、`PtcDispatchEventData` 新增可选 `meta?: JsonValue`，是**纯增量**，`ToolsService.schemas()` / `get()` 未变；官方 `@deepseek-ai/dsh` 本体则把 `profile-boot` 的 `initializeProfileFromDefault` 从“初始化缺失的 profile”改为“**替换**已有 profile”（staging 目录 + 原子 rename），`prepareProfile` 的 `fromDefaultProfile` 随之从“一次性初始化”变为“启动前替换”——这条不落在本插件读取的宿主面上；验收走的是普通 CLI 安装 / 升级 / 回滚路径，全程不传 `--from-default-profile`，因此上游新引入的 profile **替换**分支本身**没有**被本仓库的验收覆盖。差额明细见 `COMPATIBILITY.md` 的第二个接口差分表。
- **版本声明变更**（宿主面声明 delta，全部在 `package.json#peerDependencies`）：`@deepseek-ai/dsh`、`@deepseek-ai/dsh-cordis-host-runner`、`@deepseek-ai/dsh-tools` 各追加 `|| 0.2.1-rc.2`；`@deepseek-ai/cordis-plugin-include` 追加精确的 `|| 1.0.10`（原声明里的 `1.0.9` 是精确匹配，**不覆盖** `1.0.10`）；`@deepseek-ai/cordis` **未改**（`^4.0.1` 已覆盖稳定版 `4.0.5`）、`js-yaml` **未改**（`^4.2.0` 已覆盖宿主要求的 `4.3.2`）。`dependencies`、`overrides`、`scripts`、`files`、`engines` 与两个 `devDependencies`（保持 `0.2.0-rc.2` 旧基线做差分）均未动。`lib/diagnostics.js` 的 `SUPPORTED_DSH_VERSIONS` 从 `peerDependencies` 派生，因此声明一变它就跟着变，doctor 不会与声明漂移。
- **CI 与测试**：`.github/workflows/ci.yml` 的 `host-acceptance` 矩阵追加 `0.2.1-rc.2`（`test/workflows.test.mjs` 断言矩阵与 `peerDependencies` 的宿主集合**相等**，因此两边必须同时改），`test/diagnostics.test.mjs` 的声明快照同步更新。
- **修复 A：`host.version` 曾把“仅满足范围声明”的宿主当作已验证。（`lib/diagnostics.js`）** 根因是判定只取 `satisfiesRange(selected.version, supported)`，而 `satisfiesRange` 按 semver 语义忽略构建元数据、也接受带 `v` 前缀的写法，于是任何满足范围的字符串都等价于“已验证”，与本仓库“声明只列经过真实安装验收的精确版本”这一契约不符；`verified` / `verifiedHosts` 证据字段虽然已经算出，却不参与判定。修复前实测（探针：临时宿主 `package.json` 把 `version` 写成 `0.2.0-rc.2+unverified`，`cliPath` 指向它的 `lib/bin.js`）：`host.version` 报 `ok`，而同一 `evidence` 里是 `verified: false`，`report.status` 为 `healthy`、退出码 0——一个从未验收过的宿主被放行。修复后判定改为 `satisfies && verified`，证据里保留的是 `verified` 与 `verifiedHosts`（判定用的 `satisfies` 只是本次运行的局部量，不在 `evidence` 里），摘要区分“不满足范围”与“满足范围但不是已验收版本”两种拒绝，`recoverable: false` 与 remediation 不变。回归用例：`test/diagnostics.test.mjs` 的 `a host version that only satisfies the range by build metadata is blocked, not accepted`（断言 `satisfiesRange` 为 `true`、`verified` 为 `false`、级别 `blocked`、退出码 2）。
- **修复 B：doctor 的事件桥判定曾只看 MAC，不看 writer。（`lib/diagnostics.js`、`lib/domain-storage.js`、`lib/orchestrator.js`）** 事件桥信封携带 `writer` 身份，运行时重放（`lib/domain-storage.js` 的 `absorb`）一直要求 MAC 通过**且** `writer === config.eventBridgeWriter`，否则抛 `E_DOMAIN_EVENT_AUTH`；doctor 的 `diagnoseEventBridge` 却只调 `verifyEventBridgeEnvelope()`，MAC 一过就记入 `verifiedEvents` 并把 `writer` 丢掉——同一条记录运行时会拒绝、doctor 报 `ok`。修复前实测（探针：用该安装的 key 写一条 `writer: 'other-writer'`、MAC 有效的记录）：`report.status = healthy`、`state.event-bridge` 为 `ok`、`evidence.verifiedEvents: 1`，而把同一个文件交给运行时重放会抛 `E_DOMAIN_EVENT_AUTH`。修复后 doctor 与运行时调用同一个 `eventBridgeWriterTrusted(verified, writer)`（`lib/orchestrator.js` 新增导出），外来 writer 的记录进 `evidence.untrustedWriters`、摘要点名该 writer、`state.event-bridge` 报 `blocked`、`recoverable: false`，且**不提供** `event-bridge-trim-partial-tail`（该 repair 现在只在“最后一行未终止”且**恰好 1 条** malformed 记录、无 MAC 失败、无冲突、无外来 writer 时才出现）。writer 的期望值在运行时来自插件解析后的 `config.eventBridgeWriter`（默认 `dsh-evolution-orchestrator`，即新增的 `EVENT_BRIDGE_DEFAULT_WRITER`）；doctor 侧的期望值来源在独立审核后统一为 config → 组合 profile → bundle 默认（见修复 D 的 B1 段）。回归用例：`test/diagnostics.test.mjs` 的 `event bridge: a MAC-valid record naming another writer is blocked, not verified`，以及原有的 `test/domain-storage/storage.test.js` 的 `writer` 反例（运行时抛 `E_DOMAIN_EVENT_AUTH`）。
- **修复 C（同一信任边界的第三处，只在运行时）：外来 writer 的记录曾占住事件桥去重集并吞掉可信事件。（`lib/orchestrator.js`）** `EvolutionEventBridge` 构造函数加载既有日志时，`sequence` 推进已受 writer 判定保护，`seen.add(eventId)` 却没有：只要 MAC 有效，任何 writer 的 `eventId` 都会被塞进去重集。此后本安装用同一 `eventId` 调 `emit()` 就会命中 `this.seen.has(event.eventId)` 而直接 `return`——**不落盘、不报错**，可信事件被静默跳过。（`sequence` 只由可信记录推进，外来记录在修复前后都不推进它，因此这里没有“下一次可信写入会复用一个被占用的 sequence 号”这回事。）修复前实测（探针：先写一条 `writer: 'other-writer'`、`eventId: 'evolution:trial-completed:exp-dedup'` 的记录，再构造默认 writer 的 bridge 并 `emit()` 同一 `eventId`）：`seen has foreign id = true`、`sequence after load = 0`、`bridge file line count after trusted emit = 1`（应为 2）。修复后 `sequence` 推进与 `seen.add()` 共用 `eventBridgeWriterTrusted(verified, this.writer)` 这一道门，同一探针得 `seen has foreign id = false`、`sequence after load = 0`、`bridge file line count after trusted emit = 2`；malformed 行仍静默跳过，写入格式、`emit()` 对外行为、`project()`、签名与信封格式均未改。回归用例：`test/event-bridge-authentication.test.mjs` 的 `a foreign writer record cannot occupy a dedup slot or advance the trusted sequence`（对照断言：可信事件写入后重复 `emit()` 不重复落盘，且从该文件重建 bridge 时会读回可信记录的去重位与 sequence；把该段逻辑临时回退成旧写法时该用例失败，断言消息为 `a valid-MAC foreign writer record does not take a dedup slot`）。
- **修复 D（独立审核确认的另外三处同源缺陷）。** 三处都与“诊断/修复看到的不是运行时看到的事实”同源，逐条如下。
  - **B3 — profile patch 把同一 bundle 拆成两个 section，doctor 按整行标题查找。** `dsh --dump-config` 在用户 patch 命中该 bundle 时输出 `# == dsh-evolution, patched by <path>`（含 `evolution-orchestrator`）与 `# == dsh-evolution`（含 `evolution-trust-root-guard`）两个 section，而 `parseComposedProfile` 用整行标题作 section key、`diagnoseComposition` 用 `sections.get('dsh-evolution')` 精确查找，于是命中了 patch 的安装（profile 实际完全正常）被报 `host.composition` = `blocked`（“missing 1 required bundle entry/entries”）。修复前实测（探针：`runDumpConfig` 返回上述两段 dump）：`host.composition` 为 `blocked`，`problems` 为 `['evolution-orchestrator entry is absent']`。修复后 `parseComposedProfile` 按基础名（标题中第一个 `,` 之前的部分）归并同名 section，`entries` 按 dump 顺序拼接，`titles` 仍是原始标题数组，section 上另记 `rawTitles` 与 `patched` 供证据使用；同一探针得 `ok`、`problems` 为空。确实缺条目时仍是 `blocked`，且既有消息文本不变。回归用例：`test/diagnostics.test.mjs` 的 `a profile patched by the user keeps one merged dsh-evolution layer and stays ok`、`a patched profile that still lacks an entry is blocked with the unchanged message`、`an undetermined composed writer is unknown, never guessed`。
  - **B1 — CLI doctor 与运行时对“可信 writer”的期望值来源不同。** 运行时用插件解析后的 `config.eventBridgeWriter`（`lib/domain-storage.js` 的 `replay()` 与 `absorb`），而 CLI doctor 用 `options.config?.eventBridgeWriter || EVENT_BRIDGE_DEFAULT_WRITER`，`scripts/doctor.mjs` 又从不传 `config`，于是同一份日志在两边得到相反判定。修复前实测（探针：组合 profile 把 `evolution-orchestrator.config.eventBridgeWriter` 设为 `custom-writer`；日志由默认 writer 签名）：doctor `state.event-bridge` = `ok`，而运行时会抛 `E_DOMAIN_EVENT_AUTH`；反方向（日志由 `custom-writer` 签名）：doctor 报 `blocked`，运行时接受。修复后 `collectDiagnostics` 按 in-session `config.eventBridgeWriter` → 组合 profile 解析出的 writer → `EVENT_BRIDGE_DEFAULT_WRITER` 的优先级解析，并把来源（`config` / `composition` / `bundle-default`）与值写进 `evidence.writerSource` / `evidence.trustedWriter`，`ok` 摘要写明验证的是哪个 writer，`blocked` 的 remediation 说明“跳过组合探针或未解析到 DSH CLI 时 doctor 的期望值就是 bundle 默认值”。第二轮独立审核进一步收紧了两端：组合读取只在“唯一一个 `evolution-orchestrator` 条目 + 块形式 `config:` + 直接子键恰好出现一次 + 标量可逐字恢复”时才给值，嵌套键（如 `other.eventBridgeWriter`）**完全忽略**——只有直接键参与判定，存在直接键就读直接键，没有直接键才是“未声明”（走 bundle 默认）；非规范键写法（带引号或冒号前有空格，如 `"eventBridgeWriter"`、`'eventBridgeWriter'`、`eventBridgeWriter :`）会解析成同一个 YAML 键，因此归为 `unreadable`；内联 `config:`、YAML 标签/锚点/块标量/flow 集合、模板表达式、注释歧义、非字符串标量与重复键同样归为 `unreadable`，不再按任意深度取第一条匹配；in-session `config.eventBridgeWriter` 则逐字照搬运行时表达式 `config.eventBridgeWriter || EVENT_BRIDGE_DEFAULT_WRITER`（不 trim、不回落组合），因此空串落到 bundle 默认、带空格的值按原样比较、非字符串值同样按原样比较。对能精确读出的配置，同一探针两个方向都与运行时一致（默认 writer 日志 → `blocked`；`custom-writer` 日志 → `ok`）。未新增 check id、未削弱 `untrustedWriters` 阻断；但确实改变了一处 level：组合 profile 无法精确读出 writer 时，`state.event-bridge` 从原来的“默认回落到 bundle 默认并据此判定”改为 `degraded`（`writerSource: 'unknown'`、`trustedWriter: null`，附 `writerExpectationReason` 与日志里实际出现的 `writersSeen` 供人工判断），不再按一个没读出来的 writer 验证；MAC 层面的 malformed / unverifiable / conflicts 判定与既有 blocked 条件未动，同时存在时仍报 `blocked`。回归用例：`test/diagnostics.test.mjs` 的 `the doctor expects the writer the composed profile configures, matching the runtime`、`without a composed writer the doctor uses the bundle default, and an explicit config wins`。
  - **B2 — `event-bridge-trim-partial-tail` 会执行过期计划，删掉已变成可信事件的那一行。** 该分支只做 `text.lastIndexOf('\n')` 后截断覆盖，没有在执行时重新确认尾行仍然是“未终止且解析失败”，而 `COMPATIBILITY.md` 当时把那句 safe repair 描述成了并发安全的 “re-verify before acting”。修复前实测（探针：先对含 partial tail 的文件取得 repair 计划，再把尾部换成**完整、MAC 有效、默认 writer 签名但没有末尾换行**的信封，然后执行原计划）：`status: applied`，文件由 401 字节变为 201 字节，`trustedEventSurvived: false`——一条可信事件被删除。修复后该分支（`applyRepairs`）在执行前重读并重建计划条件：只有“恰好 1 条 malformed 记录，且它就是最后一条未终止行”时才准备替换；由该快照算出要保留的完整前缀、写临时文件并 `fsync`，`rename` 之前再读一次，两次字节不等就删除临时文件并 `skipped`；只有相等才 `rename`。同一探针得 `skipped`、`trustedEventSurvived: true`、字节数不变。第二轮审核又用受控调度（在 `fsyncSync` 处追加一条完整可信事件，即落在“快照之后、重读之前”）证明旧实现会丢掉该事件：修复前 `status: applied`、`trustedEventSurvived: false`，修复后 `skipped`、字节不变。这些都不构成并发安全：桥文件的写入方不持锁，落在“最后一次重读”与 `rename` 之间的追加仍可能被丢弃，因此建议在宿主停止时执行这个 repair（`README.md` 恢复表、`COMPATIBILITY.md` 与 `RELEASE.md` 风险 14）。另外，整份文件只有一条未终止记录、没有任何完整行可保留时，该 repair 不再提供（`recoverable: false`），remediation 说明没有经过验证的前缀可保留、必须人工处理。回归用例：`test/diagnostics.test.mjs` 的 `an expired partial-tail repair is skipped instead of deleting a trusted event`、`a partial-tail repair that still matches is applied and keeps the trusted prefix`。
- **三宿主验收记录：**内容冻结后，本机按 `RELEASE.md` 第 4 节对**固定产物**（`release/dsh-evolution-0.2.0-rc.13.tgz`，由 `npm run release:publish` 写入）顺序重跑了三个官方宿主的完整验收：`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-rc.2` 各自 **21/21 步通过，最终诊断 `healthy`（exit 0），每次注册 9 个工具**（隔离 `$DSH_HOME`，证据由脚本写回 `docs/evidence/dsh-<host>.json`），首次 CLI 诊断均为 `degraded`（`data.root` 在首次运行前尚未初始化），属预期。三个宿主当前都解析到 `@deepseek-ai/cordis` `4.0.5`、`cordis-plugin-include` `1.0.10`、`cordis-plugin-loader` `1.0.6`、`js-yaml` `4.3.2`（上游 patch 漂移：宿主自身是 `~` 范围，稳定补丁版一发布就被解析到；明细见 `COMPATIBILITY.md` 与 `README.md` 的兼容矩阵）。
- **固定点**：`release/dsh-evolution-0.2.0-rc.13.tgz` 与对应的 `manifest.json` / `SHA256SUMS`（`verifiedHosts` 与 `evidence` 各有三项）由 `npm run release:publish` 从冻结内容生成，不是手工编辑；`npm run pack:check`、`npm run release:verify` 与 `test/release-pin.test.mjs` 会核对“工作树内容 = 固定内容 = 三个宿主验收所针对的内容”。`0.2.0-rc.12` 及更早的 tarball、校验和与 tag 字节保持不变，也未被覆盖。
- **发布状态**：本候选的固定产物、三个官方宿主验收证据与校验和分别见 `release/manifest.json` 与 `docs/evidence/dsh-<host>.json`。写入固定点时本轮尚未创建 tag、未执行 `git push`、未创建或公开 GitHub Release、未 npm publish；`release:publish` 只是仓库内的固定点写入。本仓库的发布记录（tag、公开资产校验与发布后验收）保存在 `docs/evidence/` 下的审计文件里，不属于包内容。

## 0.2.0-rc.12 — 晋升 Journal 阶段判定的统一与安全阻断

本候选修复一处恢复安全缺陷：`promotion.journal` 的阶段判定此前分散在三条路径里。doctor（`lib/diagnostics.js` 的 `inspectPromotionJournal`）对无法识别的阶段报 `blocked` / `state-unknown` 且不提供 repair；`recoverInterruptedPromotion` 的默认分支却会对同一 journal 执行 rollback，并在成功后删除整个 state 目录（journal 与备份）；`readCanaryJournal` 还会把它当作“没有 journal”，让 `observeCanary` / `verifyStartupCanary` 从 durable sidecar 合成新 journal——未完成路径覆盖 `journal.json`，stable 与 regression 路径删除 state 目录。生产 delta 只涉及 `lib/orchestrator.js`、`lib/diagnostics.js` 与 `lib/experience-recall.js`；`guard` / `registration` / `promotion-include` / `archive-stage` 与领域模块未改，持久化格式、认证、fsync、事务与回滚、跨进程锁、promotion 门禁与授权边界一律未改。

- **单一判定**：`lib/orchestrator.js` 新增导出 `classifyPromotionJournal(journal, paths)`，边界校验（`checkJournalBoundary`）优先，随后是唯一的阶段表：`prepared` / `committing` → `incomplete`、`canary-observing` → `canary-observing`、`stable-committed` / `committed` → `committed-pending-cleanup`、`rollback-failed` → `rollback-failed`，其余（含缺失阶段）→ `state-unknown`。`lib/diagnostics.js` 直接消费该函数并删除自己的内联阶段映射；doctor 的 `state-unknown` 摘要现在带上真实阶段值，`blocked` / `recoverable: false` / 不提供 repair 的判定不变。
- **拒绝而不是猜测**：`recoverInterruptedPromotion` 与 `readCanaryJournal` 共用 `assertJournalRecoverable`。边界违规、`state-unknown` 与 `rollback-failed` 都抛出携带原因与现场路径的普通 `Error`（不再是未分类的默认回滚，也不是 `TypeError`），journal、备份、目标文件与 staging 逐字节保持不变；`applyRepairs` 按 id 直接调用 `promotion-journal-recover` 时也只记录 `failed`，不动现场。
- **合法阶段语义不变**：`prepared` / `committing` 仍按 CAS 回滚并清理（并发修改仍保留 `rollback-failed` 现场），`canary-observing` 仍返回 pending，`stable-committed` / `committed` 仍只清理 journal 目录，`rollback-failed` 仍阻断并保留。以 `release/` 固定产物对应的 HEAD 实现为基线逐项比对恢复返回值、错误文本与磁盘字节（另含 CAS 冲突注入），六条合法阶段路径完全一致；`readCanaryJournal` 对 `incomplete` / `committed-pending-cleanup` 仍返回 `null`。
- **回归测试**：新增 `test/promotion-journal-phase.test.mjs`：阶段矩阵（含 `null` 与数字阶段）证明 doctor 与恢复共用同一判定；未知/缺失阶段的故障注入断言重复启动、重复诊断与 `applyRepairs` 都拒绝且现场逐字节不变；“拒绝不会毒化状态”用例证明改回 `committing` 后仍能正常回滚；canary 读取用例用真实 `EvolutionOrchestrator` 覆盖 pending 覆盖、stable 删除、regression 回滚、缺失阶段与 `rollback-failed` 五种旧实现会破坏现场的分支。以 HEAD 恢复实现为反例验证过这些用例确实失败（旧实现覆盖 `journal.json` 或删除 state 目录）。
- **独立复核**：两轮对抗式复核均以真实 `EvolutionOrchestrator`、临时 home 与磁盘快照运行；第一轮发现并驱动修复了 canary 读取旁路，第二轮确认所有 journal 读取入口、合法阶段等价性与反例实验后无阻塞问题。
- **上游补丁漂移**：官方 `0.2.1-alpha.1` 宿主用 `~` 范围声明 cordis 与 include，上游随后发布 `4.0.5-alpha.2`、`1.0.10-alpha.2`（及 loader `1.0.6-alpha.2`），fresh install 会解析到它们，而 `peerDependencies` 只声明了 `alpha.1`，doctor 的 `host.modules` 因此阻断。逐一解包审计确认三个包只有 `package.json` 变化（版本与自身依赖范围），所有随包源码逐字节相同；据此把这两个补丁级别加入 `peerDependencies`，并用两个宿主的完整真实验收验证（具体见 `COMPATIBILITY.md` 的验证矩阵与接口差分表）。
- 文档：`README.md` 的恢复表与 `AGENTS.md` 的不变量删除“未识别阶段仍会被启动恢复回滚”的旧例外，并更新到本候选版本与上游补丁级别。
- **经验检索的排序**（`lib/experience-recall.js`）：原实现按来源数组顺序拼接已投影记录并直接填桶，每个来源又只在本来源的匹配集合内归一化新鲜度，因此同一份历史换个来源顺序给出不同答案（探针：一条精确 `knowledgeKey`、`failureCount` 9 且最新的 knowledge 失败，加三条 `count` 1 的旧失败记忆，`[knowledge, failure-memory]` 先给出 knowledge 失败，`[failure-memory, knowledge]` 直接把它挤出 `failures`）。现在只有一个确定性比较器：精确 `knowledgeKey` 优先 → 评分降序 → `lastSeen` 降序 → 与 locale 无关的完整排序键顺序。排序键 `orderingKey` 原先把裸字段用 NUL 拼接，`source` 与 `problem` 之间的分隔符可能被字段内容吸收（两条不同记录得到同一个键、比较结果为 0、稳定排序于是退回合并顺序，来源互换就换结果）；现在与 `contentIdentity` 一样逐字段长度前缀，注释也改为 NUL（原文误写为 ASCII unit separator）。
- **评分是纯函数**：`scoreOf(record, coverage)` 只保留 `SCORE_WEIGHTS` 里原有的四项质量权重（`coverage` / `success` / `fitness` / `evidence`，最高值为四者之和 0.95，未重新归一化），删除 `recency` / `basis` 机制与合并之后的二次重算：评分不读时钟、不读其它记录，单来源 `maxRecords` 保留与最终排序用的是同一个值，一个来源留下的就是它自己按同一比较器排出的前 `maxRecords` 条，`lastSeen` 只在其余项相同时平局。复核 F1 反例（12 条 `occurrences` 1 的普通失败加 `occurrences` 2 但更旧的 B，另一来源最新为 2026-01-01）在旧实现里先被来源内新鲜度截掉、最终答案里根本没有 B；现在 B 被 collector 保留并排在所有普通失败之前。
- **保留与去重**：`source()` 在扫描窗口外仍会投影精确 `knowledgeKey` 命中，但 `match()` 随后按评分 `slice(0, maxRecords)`，精确重放会在第二个截断点被丢弃（1 条精确行加 14 条高分普通匹配时精确行排名为 −1、`duplicate` 为 `null`）；现在保留策略先为精确匹配占位、再用剩余名额补最好的普通匹配，单来源仍不超过 `maxRecords`，该上限本身也适用于精确重放。内容去重改为在 `maxRecords` 截断**之前**执行，身份（`factIdentity`）要求分组（`kindOf`）、归一化六字段描述、`lastOutcome` 与证据量级（`occurrences` / `regressionCount`）全部相同（第二轮独立复核进一步把 `successCount` / `failureCount` / `successRate` / `fitnessMean` 补进身份，见下条），因此描述相同但结果或证据量级不同的两条失败绝不合并（复核 F6 反例：旧实现保留 `key=a`、丢掉 `occurrences=999` / `regressionCount=7` / 2 条引用那条，只报 `counts.duplicates=1`），重复项也不再占用名额（复核 F2 反例：12 条同事实加 1 条低分不同事实，旧实现留下 12 条重复、丢掉不同事实并报 `{ matched: 1, returned: 1, duplicates: 11 }`，现在两条都留下）。存活记录是组内比较器顺序的第一条，其 `evidenceRefs` 为组内引用并集（存活者在前、仍受 `maxEvidenceRefs` 约束）；来源内合并数记在每个 `sources[].duplicates`，`counts.duplicates` 为来源内加跨来源合计，`counts.matched` 为去重后进入最终阶段的候选数，`duplicate` 在最终跨来源合并**之前**从各来源保留后的记录计算（来源自身已经在自己的 collector 里合并过）。
- **只读保证**：`finalizeExperienceRecall` 不再把 `score` 写回调用方传入的记录（复核 F4：同一份 collector 输出二次 finalize 会改写已返回结果的评分，本机探针 `first_result_unchanged=false`；冻结记录直接抛 `TypeError: Cannot assign to read only property 'score'`），所有记录先按已知投影字段重建为副本、夹到已声明上限内，再补 `coverage` / `exact` / `score`；缺少 `coverage` 时用 `matchOf(copy, query)` 重算而不是当作 0（复核 F5：同一条记录缺 `coverage` 时上一版按 0 计分，本机探针得 0.1833，而它自己的文本匹配覆盖度为 0.9，应得 0.4933），缺少 `exact` 时按 `record.key === query.knowledgeKey` 推导，已带 `coverage` / `score` 的记录保留原值。检索仍只由显式动作触发：`evolution_propose`，或 `evolution_history` 带 `query`；自主观察者新建提案时走的也是 `evolution_propose`，定时器、轮询、measurement 与 canary 不触发。`EXPERIENCE_RECALL_LIMITS` 的全部上限、`buildExperienceQuery` / `experienceKnowledgeKey`、两个投影函数与两个 collector 的签名、`finalizeExperienceRecall` 的入参与既有输出字段（除新增的 `sources[].duplicates`、`sources[].dropped` 与 `counts.duplicates`）均未改，调用方仍只能收紧上限。
- **第二轮独立复核的五项修正**（`lib/experience-recall.js`）：① `orderingKey` 原先只编码 `key` / `source` / 六字段描述，共享这些字段、仅 `lastOutcome` / `regressionCount` 不同的两条事实会打平并退回来源顺序（本机探针：`{ maxEntries: 1 }` 下 `[A,B]` 返回 `failure/0`、`[B,A]` 返回 `regression/1`，`order independent: false`）；现在该键按固定顺序长度前缀编码全部报告字段（六字段、`source`、`key`、`state`、`lastOutcome`、`successCount`、`failureCount`、`successRate`、`fitnessMean`、`regressionCount`、`occurrences`、`firstSeen`、`lastSeen`、有界 `evidenceRefs`），探针两个方向都返回 `regression/1`。② `factIdentity` 补上 `successCount` / `failureCount` / `successRate` / `fitnessMean`：描述、`lastOutcome`、`occurrences`、`regressionCount` 全同但 `failureCount` 为 1 与 4 的两条记录，旧实现只留一条并报 `duplicates: 1`，现在两条都保留、`matched: 2` / `duplicates: 0`。③ `duplicateOf` 改为取同一 `knowledgeKey` 各快照的**最高** `occurrences` 而非求和（每条精确记录都是同一 key 的快照）：旧实现 `finalize([e])` 报 3、`finalize([e, e])` 报 6、快照 3 与 4 报 7，现在分别报 3 / 3 / 4。④ `match()` 统计并暴露被自身 `maxRecords` 丢掉的候选（`dropped = 去重后 − 保留`），`source()` 暴露 `dropped`，`finalize` 把 `integer(entry.dropped)` 与自身每来源丢弃相加进 `sources[].dropped`，任一来源有丢弃时 `truncated` 为真：13 条不同匹配、`maxRecords: 1, maxEntries: 1` 时旧实现 `truncated: false`、无 `sources[0].dropped`，现在 `truncated: true`、`sources[0].dropped: 12`。⑤ `scoredCandidate(record, query, limits)` 只从已知投影字段（`baseRecord` 形状 + `coverage` / `score` / `exact`）重建返回值，按 `limits` 夹六字段、`state` / `lastOutcome` 夹 40、计数经 `integer()`、日期经 `isoOrNull()`、`evidenceRefs` 去重并夹到 `maxEvidenceRefs` 条且每条不超过 `maxRefLength`，`finalize` 还对每个来源的集合排序、合并并按 `maxRecords` 截断（第三方 `domainStorage.recall()` 不受 collector 约束）：旧实现把默认 collector 输出用 `{ maxText: 4, maxEvidenceRefs: 1 }` finalize 仍返回长度 25 的 `problem` 与 2 条引用；一条 10,000 字符描述、100 条引用并带额外字段的记录返回 43,213 字符 JSON 且保留该字段；17 条不同记录的第三方来源 `matched: 17`；现在分别为长度 4 与 1 条引用、1,217 字符 JSON 且额外字段被丢弃、`matched: 12` 且 `sources[0].dropped: 5`。
- **第三轮独立复核的两项修正与两处文档校正、第四轮独立复核的扩展年份修正**（`lib/experience-recall.js`、`README.md`）：① `orderingKey` 声称编码全部报告字段，却漏了 `coverage`，而 `compareCandidates` 在读到排序键之前只按 `score` 平局——两条除显式 `coverage`（0.9001 / 0.9002，`scoreOf` 把两者都取整到 0.7434）外完全相同的第三方记录得到相等的排序键、比较结果为 0，稳定排序与去重存活者于是退回来源合并顺序：`finalize` 传 `[A, B]` 报 `coverage` 0.9001、传 `[B, A]` 报 0.9002（本机探针 `order independent: false`）。现在该键在固定位置（`record.key` 之后）长度前缀编码 `coverage`，模块头与该函数注释同步列出该字段；`score` 与 `exact` 不加，因为比较器在查到排序键之前就已用它们分出先后，两者永远不会以平局身份到达该键。② `collapseFacts` 保留 `{ ...group[0] }`（按比较器顺序第一条，通常是最新快照）并只合并 `evidenceRefs`，组内更早的 `firstSeen` 在 `duplicateOf` 看到它之前就丢了：同一 `knowledgeKey`、其余身份字段相同的两个快照 `firstSeen` / `lastSeen` 为 2020-01-01 / 2024-01-01 与 2022-01-01 / 2025-01-01 时，`duplicate.firstSeen` 报 2022，与“`firstSeen` 取最早快照”的文档契约相反；经真实 `collectKnowledgeExperience`（同一来源内合并）在两种行序下都复现。现在合并分支把存活者的 `firstSeen` 取组内最早的非空值（组内全无时保留存活者自己的值），`evidenceRefs` 并集、重复计数与存活者选择未改。③ **有意的行为变更**：`finite()` 现在对 `null` / `undefined` / `""` 返回 `null`（旧实现对 `null` 与 `""` 经 `Number(null)` / `Number("")` 得到 0，`undefined` 本来就是 `null`），因此 `successRate: null` 或 `effectStats.fitnessMean: null` 的 knowledge 行投影为 `null`（“未知”）而不是 0（“0% 成功”），其评分随之变化；这是预期语义，未把 `finite()` 改回。④ **措辞校正（非新缺陷）**：模块头原称重建意味着第三方 `domainStorage.recall()` “cannot widen the answer”，但 `scoredCandidate` 原样携带 `record.source` 与字符串 `record.key`，第三方给出的超长 `source` / `key` 仍会产生大 JSON（一条 20,000 字符的 `source` 与 `key` 约 40 KB）——该暴露在 `HEAD` 上同样存在。现在模块头（以及 `finalizeExperienceRecall` 的说明）改述为：六字段、`state`、`lastOutcome`、计数、日期与证据引用会被重建并夹到声明上限，`source` 与 `key` 原样传递，其大小由提供它们的来源而非本模块决定；不新增截断（朴素截断会重新引入 ① 类碰撞）。回归测试新增 2 个用例：coverage 打平对在两种来源顺序下返回同一 `coverage` 且完整序列化相同（复用 `serializeRecall`），以及同一 key 的两个快照经真实 collector 与两种来源顺序都报最早的 `firstSeen`。⑤ **扩展年份反例**（`lib/experience-recall.js`）：② 引入的 `collapseFacts` 选择，以及 `duplicateOf` 里早就存在的同样选择，都用 `Array.prototype.sort()` 的默认字符串序。`isoOrNull` 返回 `toISOString()`，扩展年份会把它变宽——`isoOrNull("+010000-01-01T00:00:00.000Z")` 是 27 个字符而普通值是 24 个，按码元序 `+`（0x2B）排在 `2`（0x32）之前，于是 +010000 那条被选成“最早”。最小复现：同一条事实的两个快照 `firstSeen` 为 `2020-01-01T00:00:00.000Z` 与 `+010000-01-01T00:00:00.000Z` 时，真实 `collectKnowledgeExperience` 的两种行序与跨来源的两种来源顺序都报 `firstSeen: "+010000-01-01T00:00:00.000Z"`，而契约是最早快照。现在两处都改按文件里已有的 `epoch()`（`Date.parse` 包装）取最早，不做字符串比较；到达这两处的非空值都已过 `isoOrNull`，因此 `epoch > 0`。`duplicateOf`（`exact.map((record) => record.firstSeen).filter(Boolean).sort()[0]`）早有同一假设，一并修正；存活者选择、`evidenceRefs` 并集、重复计数与 `lastSeen` / `state` / `outcome` / `occurrences` 取最新快照都未改，`collapseFacts` 在组内全无 `firstSeen` 时仍保留存活者自己的值、`duplicateOf` 在保留的精确记录都无 `firstSeen` 时仍报 `null`。同时把 `README.md` 里“排序键编码**全部报告字段**”的说法补上限定：`score` 与 `exact` 也是报告字段但不进该键，因为 `compareCandidates` 在查到排序键之前就已用它们分出先后。实测（当前 41 个用例文件）：修正后 41 pass / 0 fail；逐字节等同于当前 `HEAD` 的实现（`git show HEAD:lib/experience-recall.js` 覆盖 `lib/`）40 pass / 1 fail，唯一失败者就是 ⑤ 的扩展年份用例。上面记录的“38 pass / 2 fail”与“18 pass / 22 fail”对应的是当时的 40 用例文件与当时尚未包含第三轮修正的 `HEAD`，已被后续提交取代，不作为当前结果。
- **回归测试**：`test/experience-recall.test.mjs` 共 41 个用例，原有 17 个未改，第三轮累计新增或重写 23 个、第四轮新增 1 个：来源顺序无关与重复调用逐字节一致、单来源保留与最终排序共用同一评分（同一记录旁边出现更新的来源时评分与所选失败不变）、F1 反例（更旧的 B 被保留且排在所有 `occurrences` 1 的普通失败之前）、F2 反例（同事实重复不占 `maxRecords` 名额，存活者的引用并集）、F3 反例（歧义排序键在来源互换下仍确定）、F4 反例（二次 finalize 不改写已返回结果、冻结记录不抛错）、F5 反例（无 `coverage` 的记录按自身文本匹配计分、自带 `coverage` 的记录保留原值）、F6 反例（结果或证据量级不同的记录不被合并）、跨来源合并的引用并集、精确重放扛过扫描窗口与单来源上限、跨来源同内容每组只留一条、同文本不同分组不合并、两来源下各组不超过 `maxEntries` 且每来源不超过 `maxRecords` 并在 `maxRecords + 1` 边界上 `truncated` 正确、缺来源仍进 `unavailable`、空输入各组为空且 `counts` 自洽，以及第三轮五项修正各自的回归（仅 `lastOutcome` / `regressionCount` 不同的两条事实在 `maxEntries: 1` 下不随来源顺序翻转、计数不同的记录不合并、精确快照的 `occurrences` 取最高值、来源级保留丢弃计入 `truncated` / `sources[].dropped`、第三方记录被重建并夹到声明上限且输入不被改写）。第四轮又新增 1 个用例：扩展年份反例——同一条事实的 `2020-01-01T00:00:00.000Z` 与 `+010000-01-01T00:00:00.000Z` 两个快照，经真实 `collectKnowledgeExperience` 的两种行序与跨来源的两种来源顺序都必须报 `firstSeen: "2020-01-01T00:00:00.000Z"`，且 `lastSeen` / `state` / `occurrences` 仍取最新快照；把该用例分别只修 `collapseFacts` 或只修 `duplicateOf` 也各自失败，证明两处都被覆盖。实测（当前 41 个用例文件）：修正后 41 pass / 0 fail；逐字节等同于当前 `HEAD` 的未修正实现（`git show HEAD:lib/experience-recall.js` 覆盖 `lib/`）40 pass / 1 fail（唯一失败者即该扩展年份用例）。第三轮记录的“18 pass / 22 fail”对应的是当时的 40 用例文件与当时尚未包含第三轮修正的 `HEAD`，已被后续提交取代，不作为当前结果；第三轮上一版实现未提交、只存在于本地，其上的对照运行同样不作为可复现的验证结果记录；第三轮新增的 5 个回归用例各自对应的旧行为见上面五项修正中的探针输出。
- 文档（本轮）：`README.md` 的 2.3 节改为说明三组结果共用一个逐条记录的纯函数评分（四项权重，最高 0.95）、单来源保留与最终排序用同一个值、精确 `knowledgeKey` 重放优先占位但仍受 `maxRecords` 上限、完整排序键编码全部报告字段、合并只发生在描述与整组已记录结果/测量都相同时、`duplicate.occurrences` 取同一 key 的最高快照、`truncated` 也覆盖来源级丢弃（`sources[].dropped`），并说明来源交来的记录会按已知投影字段重建并夹到声明上限内；模块头同步更新触发入口（自主观察者经 `evolution_propose`）、`maxConsidered` 不是硬上界以及上述语义。
- **发布状态**：`release/` 里当前固定的 rc.12 产物，以及 `docs/evidence/` 里两个官方宿主的验收证据，针对的都是**本改动之前**的内容。因此 `npm run pack:check` 与 `test/release-pin.test.mjs` 现在必然失败，必须按 `RELEASE.md` 重新打包、重跑 `dsh-0.2.0-rc.2` 与 `dsh-0.2.1-alpha.1` 两个真实宿主验收并重新固定之后，本改动才算可发布；在此之前不得引用这两个验收数字，也不得手工改写固定点。
- 本候选的固定产物、两个官方宿主验收证据与校验和分别见 `release/manifest.json` 与 `docs/evidence/dsh-0.2.0-rc.2.json` / `docs/evidence/dsh-0.2.1-alpha.1.json`；`npm run pack:check` 与 `test/release-pin.test.mjs` 会核对“工作树内容 = 固定内容 = 两个宿主验收所针对的内容”。本轮未创建 tag、未进行外部发布；`0.2.0-rc.11` 及更早的 tag、发布附件与产物字节保持不变。

## 0.2.0-rc.11 — 写入路径与保留计划的重复工作（四轮，含撤回）

本候选在 `0.2.0-rc.10` 之上收束四轮“删除重复计算、重复复制与重复遍历”的改动。生产 delta 只涉及 `lib/dockyard-domain/memory.js`、`knowledge.js`、`observation.js` 与 `lib/domain-storage.js`；`orchestrator`、`guard`、`registration`、`promotion-include`、`archive-stage` 无源码改动，持久化格式、认证、fsync、事务与回滚、跨进程锁、promotion 门禁与授权边界一律未改。

- **冷档案记录路径**（`memory.js`、`knowledge.js`）：`#sourceMatches()` 以 `#mergeArchived(..., { copy: false })` 扫描来源集合的完整历史（先比存储 key，未命中才用新增的 `knowledgeKeyOf()` 重算身份），`#knowledgeEntryFor()` 只 clone 命中的那一行而不是为一次查找深拷贝整段冷 knowledge 档案，`#append()` 把已解析出的 `previousKnowledge` 直接交给 `#upsertKnowledgeUnlocked()`。10,000 行冷档案上 `recordObservation` 的 knowledge 路径按两半分别实测：265.656 → 133.932 ms（墙钟 −49.58%、CPU −52.23%），再 133.932 → 46.573 ms（边际 −65.23%），相对 rc.10 累计 −82.47%；双档案 `port.observe()` 累计 562.03 → 284.35 ms（−49.41%）。公开的 `history('knowledge')` 读取路径与 recall 未改动（对照组 +0.62% / −1.85%）。数据见 `docs/performance/experience-recall-archive.md` 与 `knowledge-lookup-copy.md`。
- **活动档案扫描与逐行身份**（`memory.js`、`knowledge.js`）：reconcile 对活动档案的扫描结果按 `collection + basename + dev + ino` 记入进程内备忘（命中还要求 size 与纳秒 mtime 相同，上限 32 条、LRU 淘汰），一次事务里对硬链接暂存镜像与提交后活树的两次扫描只在首次真正读盘（同一事务 reconcile 合计 123.399 → 1.805 ms，−98.54%）；`knowledge.js` 的两处十六进制折叠从 `giu` 改为显式 `a-fA-F` + `gu`，且只在没有任何维度信号时才做 explicit key 的完整文本规范化。相对 rc.10，双冷档案 `port.observe()` 573.434 → 136.830 ms（−76.14%）。数据见 `docs/performance/write-path-reconcile-and-identity.md`。
- **保留计划**（`memory.js`）：`#knowledgeRetentionPlan()` / `#retentionPlan()` 的每条来源记录只在累积遍规范化一次（无知识身份的行在同一次遍历写入 `retainedEntries`，折掉原来的第二次保留遍历），分类循环直接查同一个 Set；删除 knowledge 种子、knowledge 计划结果与出计划处的三处冗余深拷贝；删除只回答“累积遍已经回答过的布尔问题”的中间版本按行备忘。真实 `compact()` 链路 A/B/B/A（基线 `b7547f8`，2 000 / 10 000 / 40 000 冷行）：规划墙钟 −35.9% / −37.8% / −38.1%（CPU −30.1% / −37.3% / −36.3%），含档案重写 −27.1% / −24.1% / −22.9%。同一改动自身的边际（对比含备忘的上一版）是批间波动量级：规划阶段墙钟 −0.9% ~ −2.2%，写入阶段墙钟 −0.9% ~ +1.1%，CPU 为 −4.0% ~ +2.0%；删除备忘的依据是状态与内存（40 000 冷行下 Map 结构 0.91 MiB、含独占可保活对象图 9.32 MiB 的暂态），而不是这点时间。数据见 `docs/performance/retention-plan-cost.md`。
- **加载投影**（`memory.js`、`observation.js`、`domain-storage.js`）：两个加载器新增 `{ snapshot: false }`（默认行为不变），`createMemory()`、`hydrate()` 的观测 store 与 store 自己的 `record()` 四条“构建整份热投影后丢弃”的调用链不再付这次深拷贝；观测 store 改为按文档化的窄读从共享 Memory 取 `observations` 一列。整树 A/B（基线 `741b749`）：CPU 29 316.7 → 26 687.5 ms（−8.97%）、每写中位耗时 97.81 → 89.19 ms（−8.81%）、总墙钟 −7.02%，每写少构建 4 份 Memory 投影（可序列化体积 2 136 650 → 427 381 B）。数据见 `docs/performance/load-projection.md`。
- **独立对抗式复核发现并修正的真实分歧**：加载投影的第一版只在“真正执行了加载”的路径上做冷历史强转，而 `loaded` 在投影抛错前就已置位，于是 `load()` 失败后下一次 `record()` 会绕过冷历史检查成功落盘（基线两次 `TypeError`、落盘 0 条，缺陷版第二次成功落盘 1 条）——修正为 `#projection(snapshot)` 在每条返回路径上都执行该读取。活动扫描备忘的第一版让记录侧与备忘共享 `ActiveKeys` 的 `Set`，暂存追加会污染旧 inode 的备忘录（逻辑键计数少计）；逐行身份的字符串折叠只在 NFKC 管线内等价，差异码点恰为 `U+017F` / `U+212A`，生产锚与注入用例随之固定。保留计划的第一版折掉了分类循环中那次“值已不再使用”的时钟读取，删除它会把同一知识身份组内的保留行从 `dated` 翻成 `timeless` 并写出不同归档字节，因此该删除被撤回。
- **明确放弃的候选**：按维度提前短路身份比较（上界仅第 6 维约 7% 加 hash 6.9% ≈ 身份成本的 14%，且把行为换成“维度相等”）；跨调用缓存 `#readArchiveSync()` 的整段解析结果（每次写入约 56 ms 的机会，但要把 10,000 行对象长期留在进程内）；融合 `normalizeText()` 的顺序短语替换（`network error → network-error → network-failure`，一次替换会变值）；以及在“跳过投影”之外删除 `schema.parse` / `toJsonProjection` / `fsync` / 未接入实时循环的 `lineage.load()`。
- **等价性与历史锚点**：三处改动都以固定产物为基线做差分，`lib/` 是随包分发路径，因此差分基线只从 `release/` 中已提交的产物取。`test/domain-storage/load-projection-*.js` 新增整棵 `lib/` 树的 7 片段反转表（3 个文件）并覆盖持久化字节、失败路径与并发契约；`test/dockyard-domain/knowledge-identity-equivalence.test.js` 的基线由“当前固定点”改为显式锚定 `release/dsh-evolution-0.2.0-rc.10.tgz`，重新固定后不会再退化成自我比较；rc.7 与 rc.8 锚点（`housekeeping-baseline.js`、`archive-index-baseline.js`、`domain-storage-baseline.js`）仍逐字节成立。
- **收益边界与已记录的偏差**：备忘的收益与“一次事务里被重复扫描的活动档案字节数”成正比，跨进程重启后的首次 `load()` 仍完整扫描（恢复面本身）；它同时长期保留条目深拷贝（实测每 10,000 行活动键约 0.7 MiB，条目数上限 32）。身份改动的收益与每次写入被重算身份的冷行数成正比，无冷行时未证实可测收益。保留计划的等价性主张限于已测量语料与相同/冻结的起始时钟：被折叠的那次逐行时钟读取会让此后计划的时钟派生戳记前移已删除的读取次数（索引戳记，以及同一进程内后续计划的 `occurredAt` 排序输入），这一点由时钟契约用例钉住并作为已接受偏差记录。跳过整份投影会改变“不可投影值”的报错时机：纯领域调用晚到第一次真正投影时才报同一个 `RangeError`，而官方端口在 `openDomainStorage()` 之前就已用 schema 拒绝该文档。
- 文档：`docs/performance/` 新增 `knowledge-lookup-copy.md`、`experience-recall-archive.md`、`write-path-reconcile-and-identity.md`、`retention-plan-cost.md`、`load-projection.md` 与对应原始数据（含撤回记录、失败记录与复现命令）；同一轮校正了 rc.7 锚点产物 `lib/dockyard-domain/memory.js` 的字节数（`175,320`）、并发加载返回值的表述、以及若干把“未测得收益”写成“没有收益”的表述。
- 本候选的固定产物、两个官方宿主验收证据与校验和分别见 `release/manifest.json` 与 `docs/evidence/dsh-0.2.0-rc.2.json` / `docs/evidence/dsh-0.2.1-alpha.1.json`；`npm run pack:check` 与 `test/release-pin.test.mjs` 会核对“工作树内容 = 固定内容 = 两个宿主验收所针对的内容”。本轮未创建 tag、未进行外部发布；`0.2.0-rc.10` 及更早的 tag、发布附件与产物字节保持不变。

## 0.2.0-rc.10 — 按需经验检索（无模型、无轮询）

- **新增 `lib/experience-recall.js`**：显式进化动作触发、纯函数、全部上限制在模块内的只读经验检索。使用已有的 canonical knowledge（`state` / `lastOutcome` / `effectStats` / `trend` / evidence）与本地 durable failure memory，输出 `resolved` / `failures` / `candidates` 三组、`duplicate` 精确重放与 `advice`；默认每组最多 3 条、每来源最多 12 条、单字段 160 字符、2 条证据引用、扫描最近 2000 条，调用方只能收紧不能放宽。
- `evolution_propose` 在返回中附带 `experienceRecall`，`evolution_history` 新增可选 `query` / `target` / `impactScope` 返回同一结果；`inspect`、measurement、autonomous observer 与定时器不触发检索（单测断言 `recall` 调用次数）。`experienceRecall: false` 可整体关闭。
- 领域端口的 `recall` 是唯一新增读取方法；检索不写入、不改变数据格式、不改变 promotion 授权与门禁。domain 存储缺失或读取失败时降级为本地 failure memory，并在 `unavailable` 中显式报告，而不是当作“没有历史”。
- 负向证据现在带上它适用的 target（`#bridgeOutcome` 写入 `scope`），因此同一个 target 的历史失败可跨会话被检索；原始失败文本仍按既有边界在进入领域存储前脱敏。
- 因宿主的 `#bridgeOutcome` 与 `lib/domain-storage.js` 位于两个固定基线锚点之下，两处逆向重建各自新增了一条显式 reversal 记录（只读 `recall` 方法与被反向重建的同一段源码），锚点仍逐字节对应固定产物。
- 新增 `test/experience-recall.test.mjs`（17 个用例：分类、精确重放（含超出扫描窗口的旧记录）、上界、来源不可用时降级、`__proto__` 与损坏行、真实 `storageDomain` 端到端回读、未签名事件仍拒绝作答）。
- 文档：`README.md` 重写为面向用户的产品说明（定位、能力、场景、安装、配置、使用、限制），`AGENTS.md` 重写为与当前实现一致的开发约定。两者不改变任何运行时行为、API 或数据格式。

## 0.2.0-rc.9 — 默认写入路径的重复工作

- **恢复收尾的第二次文档校验**：`installPending()` 收尾写入的文档由上一步 `schema.parse(domain.global.get())` 的结果（已校验并投影的 `pending.aggregate` / `pending.applied`）与两个固定字面量（`schema: 1`、`pending: null`）组成，再解析一遍不可能拒绝第一个 parse 没有拒绝的文档，只是把整份 aggregate 又走一遍。必须在安装暂存文件之前完成的整份文档校验没有移动，仍由上面那次 parse 承担。
- **`stateStore.update` 的冗余深拷贝**：入参先被 `structuredClone` 克隆一遍，而 `aggregateSchema` 的 `toJsonProjection` 本身就产生全新深值；交给这个 store 的 updater 都是纯展开，从不改写参数。
- **`inlineSerialization`**：该 store 现声明 `inlineSerialization: true`，`EvolutionMemory.#save()` 不再先做一次 `snapshot()` 全量深拷贝。`PORTS.md` 要求的“transaction 在调用时同步捕获全部 payload 字节”由 `update` 内联的同步 JSON 投影满足，等价测试中有“已提交文档不被后续写入原地改写”的断言守护该契约。
- 三项合起来把一次保存的“浅视图/快照深拷贝 → 入参深拷贝 → JSON 投影深拷贝”减为“浅视图 → JSON 投影深拷贝”，落盘字节不变。可复现 3 对严格交替 A/B（CPU 中位数 35277.426 → 31743.330 ms，**−10.02%**，两侧范围不重叠；墙钟 −5.96%）、等价性依据、收益边界，以及两项**已被击穿并撤回**的方案（`catchall(z.json())` 的非遍历替换：16,411 个差分输入、441 个“旧拒绝/新接受”；删除 `hydrate()` 里“死”的 observation store：它读取的 `memory.hasColdHistory` 会强转 `coldArchives` 条目，删除后损坏状态之后的第一次提交会被静默接受）见 `docs/performance/domain-write-path.md`。
- 本候选已在本地固定（`release/dsh-evolution-0.2.0-rc.9.tgz`）并重跑两个官方宿主的完整验收；未创建 tag 或进行外部发布。`0.2.0-rc.8` 及更早的产物、校验和与固定点保持不变。

## 0.2.0-rc.8 — journal boundary、archive index 单次解析与 housekeeping 开销

- **Promotion journal 边界**：doctor 与恢复共用 `checkJournalBoundary`；仅接受 `file` / `path` 记录，目标限于 `pluginRoot` / `presetDir` / `archiveDir` 且不得指向 promotion 状态目录，不以 `dataRoot` 扩大范围。`symlink` 等不支持的记录形状现报 `blocked` / `state-unknown`、`recoverable=false`，不再提供恢复必然拒绝的 `promotion-journal-recover`；边界拒绝保留 journal，缺失 `stateDir` 或 `stageDir: 42` 等原先触发 `TypeError` 的非法值返回明确拒绝原因。修正 README / COMPATIBILITY 与 doctor 摘要的描述。

- **Archive index 单次解析**：reconcile 与 compact 重建共享一次 JSONL 分行/解析，保留索引字段、活动键、轮转字节与损坏行处理。等价测试使用固定产物中的完整旧实现，并以带形状断言的逆向重建证明字节一致；重新固定包含新实现的产物后仍保留基线，移除重复 vendored 源码。可复现性能数据与收益边界见 `docs/performance/archive-index-single-parse.md`。

- **Housekeeping 开销**：`#performHousekeeping()` 在每次保存时执行，此前为每条被退休记录线性扫描 tombstones，去重对每个被删条目各做一次 `indexOf`/`splice`，并在规则 4 与规则 5 中重复派生同一条目的指纹。现在每次 pass 只建一次 tombstone 索引（记录 id / fingerprint / candidate fingerprint，退休时增量维护），缺指纹的记录在同一次 pass 内只派生一次，去重改为一次性原地压缩。所有偏离常规形状的输入仍逐字节保留原语义：tombstones 出现假值或非对象元素时退回原来的线性扫描与真假判断，`fingerprint: null` 仍按 `candidateFingerprint ?? fingerprint ?? 派生` 继续派生，构造 tombstone 或转换字段抛错时保留中止前已完成的删除。两轮独立对抗式复核各自找到真实分歧（延迟删除、`null` 指纹短路、假值 tombstone、抛错时的部分删除），修复后都已固化为回归用例。多规模可复现 A/B、收益边界与默认配置未观察到收益的结论见 `docs/performance/housekeeping-save.md`。

- 本候选已在本地固定（`release/dsh-evolution-0.2.0-rc.8.tgz`）并重跑两个官方宿主的完整验收；未创建 tag 或进行外部发布。`0.2.0-rc.7` 的产物、校验和与固定点保持不变。

## 0.2.0-rc.7 — failure memory integrity

- 修复 file 后端失败记忆的损坏输入路径：`entries` 中出现非对象记录、或记录嵌套超过加载边界（64 层；`snapshot()` 克隆在这之前会因过深而栈溢出）时，插件不再在启动时崩溃，而是像解析失败 / 结构失效一样隔离原文件、以空 memory 继续并留下可查询 warning；doctor 与运行时使用同一个判定函数，不再出现“运行时拒绝、doctor 报 ok”。
- 从旧数据恢复、缺少 `signature` 的记录改为按整条内容派生身份（深度受限的稳定序列化）：不同记录不再因缺失键被静默合并（`compact()` 曾把合并结果写回磁盘），完全相同的记录仍会去重。
- 显式 `signature` 只接受非空字符串；其它值改按 `signature()` 计算，避免 `record()` 的保留键与实际存储键不一致。
- `record()` 的保留不再可能裁掉本次写入：时钟回拨或异常 `lastSeenAt` 使新记录排在满仓之后时，淘汰最旧记录而不是丢掉刚观察到的失败，返回值不再因自身的裁剪而缺失。
- 加载时拒绝 JSON 无法保真表示的值（±Infinity/NaN、-0）并按损坏状态隔离原文件；写入路径把非有限数规范化为字符串、-0 规范化为 0，避免插件自己写出下次启动会被拒绝或与其它记录共享身份的记录。
- 加载时检测 JSON 数字字面量的精度丢失（如 `9007199254740993`、`1.0000000000000001`、`1e-400`）：`JSON.parse` 之后原文差异已不可观察，因此对原文做精确十进制比较，命中即按损坏状态隔离原文件，doctor 同步报 `degraded`。
- 写入路径把 `undefined` 数组元素/空洞与 `undefined` 属性规范化为落盘后的形状（`null` / 删除），使身份在写入、重载、再写入之间保持一致。
- 解析前检查对象的重复键（含转义解码后的键名）：重复键在 `JSON.parse` 中后者覆盖前者，不同原文会得到相同记录；命中即隔离原文件。
- 严格 UTF-8 解码内存文件：非法字节不再被替换字符“修复”而与其它记录合并，命中即隔离并保留原字节。
- `compactValue` 改用 `Object.fromEntries` 写回对象属性，`__proto__` 自有属性不再被原型 setter 吞掉。
- 保持 BOM 文件的既有语义：UTF-8 BOM 不属于 JSON，严格解码保留它以便解析失败并按损坏状态隔离，运行时与 doctor 一致，不再出现“运行时接受、doctor 报 degraded、保存时静默去掉 BOM”的分歧。
- 保留 schema 1 格式、`record()` 的重复语义（`count` 递增、`firstSeenAt` 与模式身份不变）、`tmp`+`rename` 原子写入与隔离恢复语义。
- 本候选仅在本地固定与验收，未创建 tag 或进行外部发布。卸载/重装后 memory 文件哈希变化的调查结论（属预期的 `count`/`lastSeenAt` 更新，非持久化缺陷）见 `docs/evidence/memory-hash-investigation.md`。

## 0.2.0-rc.6 — redundant work removal

- 删除同一调用路径中重复执行的工作：语义 GC 不再为每条可退休记录线性扫描整张 canonical 表；失败记忆 `record()` 与加载不再为丢弃的返回值深拷贝整份记录；observation 过滤不再逐条规范化同一查询词；strategy 与 capability 快照不再为取计数重复生成整份列表。
- 保留持久化格式、认证、fsync、事务、恢复、回滚与跨进程锁语义，官方 DSH 零源码 patch；历史 tag 和发布附件不变。
- 事件同步路径的两项候选优化经三轮独立对抗式审查后**整体撤回**，生产代码恢复基线行为：标记表摘要复用被“端口存活期间经官方句柄回退标记”和“同一对象原地修改后写入失败”两处反例击穿；恢复安装的“只校验使用到的字段”被“被拒绝的提交已把暂存文件装进实时归档树”击穿。两项都在真实官方 JSON 后端复现，稳态与带新事件的 `flush()` 因此都没有收益。
- 可复现前后对比（3 轮交替、中位数）：canonical 3000 时语义 GC 94.475 → 67.519 ms（−28.53%）；`record()` 重复条目 1.1321 → 0.7594 ms（−32.92%）；带查询词的 observation 列表 1.3183 → 0.5106 ms（−61.27%）；`strategy.snapshot()` 3.0507 → 1.5348 ms（−49.69%）；`capability.snapshot()` 0.8837 → 0.4866 ms（−44.94%）。收益边界、撤回记录、反例与原始数据见 `docs/performance/redundant-work.md`。

## 0.2.0-rc.5 — reliability fixes

- 保留 proposal 快照，在 Trial 首次运行时修改前同步捕获恢复基线；正常 propose→trial 宿主加载不再误报恢复失败。基线不在后续 inspect、measure 或清理时重建，Trial 期间真实并发漂移仍拒绝恢复并保留目标锁。
- 服务清单读取异常标记为不可用，拒绝以两份空清单证明恢复；普通 service lookup 的容错行为与正常未绑定声明保持兼容。
- 保留 stop/undefine 回执、安全守卫、二次确认、Promotion、Canary、恢复和回滚语义；官方 DSH 零源码 patch，历史 tag 和发布附件不变。
- 七项边界回归及真实双宿主探针覆盖本次修复；发布链继续要求 Node 22/24、完整测试、固定产物、来源追溯、远端 CI、CodeQL 和发布后验收。结果与剩余风险见 `docs/evidence/rc5-release-audit.json` 与 `docs/core-reliability.md`。

## 0.2.0-rc.4 — final local performance candidate

- 收敛领域查询元数据投影、运行时检查投影、签名排序键复用、冷历史诊断、事件桥证据分块恢复五轮优化，保留全部历史基准、失败记录和差分回归。
- 统一源码、固定 tarball、校验和、manifest 与两个官方宿主的完整验收证据；未降低发布验证要求。
- 本候选仅在本地固定，未创建 tag 或进行外部发布。可复现结果与收益边界见 `docs/performance/final-candidate.md`。

## 0.2.0-rc.3 — performance candidate

- 官方领域查询保留完整历史读取、去重和计数，仅深拷贝最多 50 条返回记录；
  三轮同负载 CPU 减少 30–49%，数据和收益边界见 `docs/performance/domain-query.md`。

- 在每个 agent step / 工具结束的事件同步中，移除重复 JSON 解析，并仅为
  未提交事件构造 DTO；全部历史记录仍逐条验证 MAC、writer 和同 ID 冲突。
- 可复现多规模数据与适用范围见 `docs/performance/domain-replay.md`。
- Reuse archive directory lookups within one index load on the official domain
  observation path; retain fresh discovery on every subsequent load.
- Preserve archive reconciliation, checksums, MAC verification, fsync and
  pending/final transaction semantics; no official DSH source changes.
- On the reproducible 256-segment workload: median observation latency -42.61%,
  process CPU time -79.62%, directory enumeration calls -92.49%.
- 历史发布及发布后双宿主验收记录见 `docs/evidence/rc3-release-audit.json`；本轮不修改历史 tag 或公开资产。

## 0.2.0-rc.2 — release candidate

Supported hosts: DSH `0.2.0-rc.2` and `0.2.1-alpha.1` (exact alternatives),
Node `^22.19.0 || >=24.0.0`. Not published to npm.

本候选修复两条 CodeQL high：shell 守卫的多项式回溯，以及指标投影的弱随机兜底 ID。保持核心 Evolution 流程与显式指标身份，重新执行双宿主真实验收。发布链验证 sourceCommit 的实际包内容，确保 tag、源 commit、manifest 与产物内容一致。

### Added

- **A source-commit pin.** `npm run release:publish` now records `sourceCommit`
in `release/manifest.json`, and the release workflow requires it: a new release
cannot be published unless the pin names a commit in the tagged history. The
check is `scripts/release/verify-provenance.mjs`, covered by
`test/release-provenance.test.mjs`.
- **Code scanning.** `.github/workflows/codeql.yml` runs CodeQL for
`javascript-typescript` on `main`, on every pull request and weekly, and uploads
the SARIF results to GitHub code scanning.

### Changed

- **The release workflow can no longer overwrite a published asset.** It refuses
to touch a release that is already published or already has assets, uploads
without `--clobber`, and downloads the assets GitHub ends up serving to re-verify
them against the pin. `workflow_dispatch` gained a `dry_run` input that runs
every check and touches nothing.
- **The release workflow verifies tag, commit, manifest and checksums before
attaching anything.** It checks out full history (so the pinned source commit
can be walked) and fails when the tag does not match the version, the checked-out
commit, the pinned source commit or the pinned content.
- **GitHub Actions now run on Node 24.** `actions/checkout` and
`actions/setup-node` move to `v7`, `actions/upload-artifact` to `v7` and
`pnpm/action-setup` to `v6`, which removes the `Node.js 20 is deprecated`
runner warning the previous releases emitted.
- **`test/workflows.test.mjs`** now locks the release guarantees, the CodeQL job
and the action runtimes instead of only the job names.

### Notes

- `lib/guard.js` 使有序命令/写动词在互不重叠的候选区间内匹配，保留导出的 `RegExp` 接口并消除无界回溯，重定向去掉可重试的数字/空白前缀；保留 deny/allow 决策并增加带子进程硬期限的风险回归。
- 指标兜底身份使用 `crypto.randomUUID()`，同一投影的 `id` 与对应 `taskId` / `goalId` / `agentId` / `sessionId` 一致；调用方身份优先级不变。
- `sourceCommit` 必须来自已提交的包内容，且其 git 对象摘要等于 tag 树与 tarball，祖先关系不再是唯一来源校验。
- 原同名 rc.2 draft/tag 经维护者授权重建；旧记录保留，历史 rc.1 tag 和资产不变。
- The `v0.2.0-rc.1` tag points at a commit whose committed artifact differs from
the bytes that were published under that release. The hardened workflow now
fails on exactly that mismatch. It is recorded in `RELEASE.md` as a known risk of
the historical release; rewriting the tag or the release is out of scope.

## 0.2.0-rc.1 — release candidate

Supported hosts: DSH `0.2.0-rc.2` and `0.2.1-alpha.1` (exact alternatives),
Node `^22.19.0 || >=24.0.0`. Not published to npm.

This candidate contains **no runtime change**: the shipped `lib/` is exactly
`0.2.0-dev.6`, re-verified end to end on both hosts. It adds the release and
verification layer that turns that state into a reviewable artifact.

### Added

- **A release pin: `release/manifest.json` + the released tarball.** The bytes
  that get published are committed and verified rather than rebuilt. Packing is
  only byte-stable within one npm version (see *Fixed*), so one artifact is
  stored: `npm run release:publish` copies the build into `release/`, records
  its `sha256` and its environment-independent `contentSha256`, and
  `npm run release:verify [<tarball>]` checks either one. `--content-only`
  checks a locally rebuilt tarball, whose bytes may legitimately differ.
- **`npm run pack:check`** replaces the bare `npm pack --dry-run`: it fails on
  a pack that is not byte-stable in this environment, on an archive that is not
  exactly `package.json#files`, on a non-canonical file mode, on shipped text
  carrying a local home path or credential-shaped material, on
  `package-lock.json`/`package.json` drift, on a version that is not a
  pre-release, on a README that documents a superseded version, on a missing
  CHANGELOG entry, on missing install/doctor/upgrade/rollback/uninstall
  instructions — and on a `release/`, `docs/evidence/` or working tree that no
  longer describes the pinned artifact.
- **A content digest instead of a byte-only guarantee.** The archive is read
  with Node's `zlib` and a minimal ustar reader (no external `tar`), and
  `contentSha256` covers every entry's path, mode and content. This is what the
  acceptance evidence, the pin and the CI check across platforms.
- **A committed host-acceptance harness**
  (`scripts/acceptance/run-host-acceptance.mjs`). It installs the requested
  official DSH release into a throwaway runtime, installs the packed tarball
  through the official plugin CLI into a fresh `$DSH_HOME`, and drives the real
  host through the CLI doctor, the core
  `inspect→propose→trial→measure→revert` flow (requiring proven runtime
  recovery), the official pluginManager disable/enable semantics, CLI
  uninstall/reinstall with data retention, the README upgrade and rollback
  flows (a re-versioned build of the same tree, then the current tarball), real
  promotion with a second confirmation gate, startup-canary commit across a
  restart, and a canary rollback that removes only the new candidate. Its
  evidence records both the bytes it installed and the content digest, with
  local scratch paths redacted.
- **Committed acceptance evidence** for both supported hosts:
  `docs/evidence/dsh-0.2.0-rc.2.json` and
  `docs/evidence/dsh-0.2.1-alpha.1.json`.
- **GitHub CI** (`.github/workflows/ci.yml`): unit tests on Node `22.19.0` and
  `24.x`, a packaging job (byte stability, allow-list, canonical modes, the
  committed pin, a `--content-only` check of a locally rebuilt artifact, and a
  doctor start with no host packages present), and a per-host acceptance job
  that also asserts its evidence matches the pinned content.
  `test/workflows.test.mjs` parses both workflow files, pins the CI job set and
  the accepted host matrix to the declaration, and fails if the release
  workflow could publish anything other than a draft, rebuild the released
  bytes, or reach npm. `test/release-pin.test.mjs` checks the pin against the
  committed artifact and the working tree without running `npm pack`.
- **Tag-triggered release workflow** (`.github/workflows/release.yml`) that
  verifies the tag against the version, verifies the pinned artifact, and
  attaches exactly those bytes to a **draft** GitHub release. It deliberately
  does not rebuild: a rebuild on the runner would have different bytes from the
  artifact the acceptance ran against.
- **`RELEASE.md`** with the artifact list, the reproduction steps, what
  "reproducible" does and does not mean here, and the remaining release risks.

### Fixed

- **`npm test` did not run on Node 22 or 24.** `node --test test/` treats the
  argument as a module path on those versions and failed with
  `Cannot find module '.../test'`, so CI could never go green on the declared
  engine range. The suite now uses explicit globs
  (`node --test "test/**/*.test.mjs" "test/**/*.test.js"`), verified on Node
  `22.19.0` and `26.10.0`. As a side effect of the same fix,
  `test/full-cross-session.integration.mjs` — a real integration test that the
  old command silently never ran — is now discovered and passes (renamed to
  `*.integration.test.mjs`).
- **The tarball used to depend on the checkout's umask.** `npm pack` records the
  on-disk mode, so three files that happened to be `0600` in the development
  tree produced a different hash than the same commit in a fresh `git clone`
  (`0644`), while git tracked no such difference. Packaging now copies exactly
  the declared entries into a staging directory and normalises modes to
  `0644`/`0755`.
- **The "reproducible tarball" claim was wrong across npm versions.** The same
  tree packs to different bytes under npm 10 and npm 11 — the compression runs
  through the bundled zlib. Measured: `46f6e4a4…` with npm `10.9.3`, `040e0d9e…`
  with npm `11.19.1`, with byte-identical unpacked files and identical
  uncompressed tar size. The guarantee is now split honestly: byte identity
  within one environment, `contentSha256` everywhere, and one pinned artifact
  for what is actually published.
- **`lib/`-only runtime files no longer ship the release tooling.**
  `package.json#files` now names `scripts/doctor.mjs` and
  `scripts/import-evolution-data.mjs` instead of the whole `scripts/`
  directory, so the acceptance harness and release scripts stay out of the
  user-facing bundle (48 entries instead of 56).

### Notes

- The doctor still reports `degraded` immediately after a fresh install
  (`data.root` is created on first run); the post-boot diagnosis is `healthy`.
- Nothing was added to `peerDependencies`: `0.2.1-alpha.1` remains supported
  only because the full acceptance passes on it.

## 0.2.0-dev.6 — superseded by 0.2.0-rc.1

Supported hosts: DSH `0.2.0-rc.2` and `0.2.1-alpha.1` (exact alternatives),
Node `^22.19.0 || >=24.0.0`.

### Changed

- **The service inventory no longer depends on a private Cordis method.**
  `ctx.reflect._getImpl()` is replaced by the documented `ctx.reflect.store`
  ("service implementations, keyed by isolation label", with the exported `Impl`
  type) plus the documented `Context.isolate` key. The private method is kept
  only as a fallback for a host where `reflect.store` is unreachable, and the
  doctor records which path answered (`public: ctx.reflect.store +
  Context.isolate` on both verified hosts). Verified equivalent to
  `_getImpl(name, false)` for bound, unbound, isolated and disposed providers.
- **The promotion gate no longer trusts a numeric `FiberState`.** `FiberState`
  is a `const enum`, so it is erased from the published cordis runtime and
  `state !== 2` was an unverifiable literal. `fiberIsActive()` decides ACTIVE
  from the documented `uid`, `store` and `inertia` fields, asserted equal to
  `state === FiberState.ACTIVE` across every lifecycle transition
  (PENDING/LOADING/ACTIVE/FAILED/DISPOSED/UNLOADING) against the real package.
- **The mounted promoted row is resolved through the loader's public API.**
  `EntryTree.store[rowId]` is replaced by `EntryTree.resolve(rowId)`; the
  verify path awaits the row's fiber (`Fiber.await()`) so an in-flight
  transition is settled before the activity decision, and a failed activation is
  reported as inactive with its own cause.
- **`lib/cordis-compat.js` is the single source of truth for host-surface
  dependencies.** The runtime readers and the doctor consume the same classified
  table (public / undocumented / private, owning package, what is read, the
  public replacement, or the recorded reason why none exists).
- **`host.version` now reports whether the found host is one of the versions
  verified by a real acceptance run** (`verified`, `verifiedHosts`), derived from
  the declared alternatives so the answer cannot drift from the declaration.

### Added

- DSH `0.2.1-alpha.1` is a verified supported host. It was accepted only after
  the full acceptance run passed on it, against a fresh `$DSH_HOME`: install,
  boot, all 9 tool registrations, in-session and CLI doctor, core
  `inspect→propose→trial→measure→revert`, execution-bridge fault injection with
  an idempotent repair, restart recovery, promotion to `canary-observing`, stable
  commit, canary rollback, interrupted-promotion recovery, fail-safe on a
  `rollback-failed` journal, unsupported-host blocking, disable/enable,
  uninstall/reinstall with data retention, and a final doctor.
- `test/cordis-compat.test.mjs`: contract tests against the real installed
  cordis / loader / official Include packages — `serviceImpl` equivalence with
  `_getImpl`, the isolate-symbol identity assertion, `fiberIsActive`
  equivalence across all six lifecycle states, the recorded surface
  classification, a real promoted-Include mount with verify/health, and a torn
  composition failing closed.
- A regression test proving the doctor CLI starts with **no host package
  resolvable** (the bundle is copied without any `node_modules`), so a
  reintroduced host import in the doctor's import graph fails in CI instead of
  only in a real install.
- A regression test asserting no `lib/` file decides a fiber state from a
  numeric literal, and one asserting the declared support matrix equals the
  verified host list.

### Fixed

- **The service-inventory change must not put a host import into the doctor's
  import graph.** A first attempt imported `@deepseek-ai/cordis` inside
  `lib/cordis-compat.js`, which broke the doctor CLI in a real install
  (`ERR_MODULE_NOT_FOUND`) while the plugin itself still booted — the same
  constraint that makes `js-yaml` a bundle dependency. The module now imports
  nothing from the host: it takes the authoritative `Context.isolate` from the
  bundle entry at boot, falls back to the registered
  `Symbol.for('cordis.isolate')` key cordis itself builds, and the regression is
  pinned by a test that starts the doctor with no `node_modules` present.
- **`ctx.registry.values()`, `ctx.reflect.props`, `Fiber.getEffects()` and the
  `Fiber` lifecycle fields were misreported as non-public.** They are documented
  members of the exported cordis classes, so they are now classified as public
  and no longer counted as upgrade risk; only `ctx.events._hooks` and the
  `_getImpl` fallback remain private.

### Notes

- `scripts/import-evolution-data.mjs` is unchanged: staged, SHA256-verified,
  atomic, idempotent imports that refuse to merge differing source content.
- Known non-blocking limits are reported by every diagnostics run
  (`degradedCapabilities`): advisory domain evaluator, `continuous/` and
  `governance/` not wired into the live loop, host-only promotion through a
  cooperative (non-sandbox) gate, disabled legacy adapters, and the recorded
  private/undocumented surfaces listed in `COMPATIBILITY.md`.

## 0.2.0-dev.5 — unreleased

Supported host: DSH `0.2.0-rc.2` (exact), Node `^22.19.0 || >=24.0.0`.

### Added

- **Model-free diagnostics.** `lib/diagnostics.js` plus a
  `dsh-evolution-doctor` command (`scripts/doctor.mjs`, also runnable as
  `node <profile>/node_modules/dsh-evolution/scripts/doctor.mjs`). It reports
  `ok` / `degraded` / `blocked` / `not-evaluated` with per-check evidence over
  the installed package, the resolved DSH host and its module versions, the
  composed profile (official `dsh --dump-config`), live Cordis services, tool
  registration, internal-API probes, the Evolution data root, memory, cold
  archives, the signed execution event bridge, the domain aggregate and its
  archive lock, the legacy-import manifest, and promotion
  journal/composition/pointer. Exit codes: `0` healthy, `1` degraded,
  `2` blocked.
- **In-session diagnostics.** The `evolution_doctor` tool and
  `ctx.evolution.diagnose()` return the same report while checking the live
  registry (9 tools) and the mounted promotion Include adapter.
- **Safe, idempotent repairs** (`--repair`): boundary-valid interrupted promotion-journal
  rollback (backup + CAS), boundary-valid committed-journal cleanup, event-bridge
  partial-tail trimming, orphan domain staging removal, migration staging
  cleanup, and stale archive-lock removal. Every repair re-verifies and is a
  no-op on a second run. `rollback-failed`, unparsable or out-of-boundary
  journals (including unsupported record shapes under the shared rule in rc.8),
  unverifiable event MACs, records whose MAC verifies but whose writer is not
  this installation's trusted writer, conflicting event ids, missing pending
  archives and altered immutable migration evidence stay `blocked` with
  `recoverable=false` and are never modified.
- `CHANGELOG.md` and a `bin` entry so the doctor is discoverable by name.

### Fixed

- **Startup was permanently blocked by an interrupted archive-lock write.** An
  empty or unparsable `domain-archive.lock` used to throw
  `E_DOMAIN_ARCHIVE_LOCK` forever. A lock whose readable content names a live
  pid is now always refused, never stolen; a lock the runtime cannot read or
  parse is reclaimed only once the file has not been modified for 1s, retrying
  within a 5s budget and then throwing `E_DOMAIN_ARCHIVE_LOCK`.
- **The doctor CLI silently did nothing when its path contained a symlink**
  (for example macOS `/tmp` → `/private/tmp`). The entry-point check now
  compares real paths.
- **`js-yaml` was only a peer dependency**, so running the doctor from a
  plugin-only profile failed with `ERR_MODULE_NOT_FOUND`. It is now also a
  bundle dependency, and a missing parser degrades to an explicit
  `not-evaluated` YAML check instead of crashing.
- **In-session host detection could pick an unrelated global `dsh`** from
  `PATH`. The running process entry now wins, and conflicting host versions are
  recorded as evidence.
- **Migrated legacy durable pointers were misreported as stale.** A pointer
  that the migration manifest explicitly keeps inactive
  (`No legacy promoted code execution`) is now reported as intentionally
  unmounted.

### Notes

- `scripts/import-evolution-data.mjs` is unchanged: staged, SHA256-verified,
  atomic, idempotent imports that refuse to merge differing source content.
- Known non-blocking limits are reported by every diagnostics run
  (`degradedCapabilities`): advisory domain evaluator, `continuous/` and
  `governance/` not wired into the live loop, host-only promotion through a
  cooperative (non-sandbox) gate, disabled legacy adapters, and the internal
  Cordis surfaces listed in `COMPATIBILITY.md`.
