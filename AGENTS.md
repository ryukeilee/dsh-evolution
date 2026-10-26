# dsh-evolution 项目指南

面向在本仓库工作的开发代理。只描述当前实现；改动前先以 `package.json`、`lib/`、`test/`、`scripts/` 和 `.github/workflows/` 的实际内容为准。

## 1. 项目定位

- 本仓库是 `dsh-evolution` 插件的**唯一开发、测试与发布来源**，不是 DSH 本体 fork。
- 插件通过官方 bundle / profile 机制接入：不得 patch 官方源码、不得向宿主 `node_modules` 复制实现、不得在 profile 上合成 loader entry。
- 当前实现是 ESM JavaScript，`lib/` 是**手写源码**，不是可删除后重建的编译产物。本仓库没有 TypeScript build/lint 脚本。
- 版本、`engines`、宿主兼容范围以 `package.json` 为准；安装与行为见 `README.md`，接口审计与阻塞依赖见 `COMPATIBILITY.md`，发布流程见 `RELEASE.md`。

## 2. 目录与模块职责

### 入口与生命周期

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | bundle 入口：解析路径、初始化 `event-bridge.key`、打开领域存储、在 Include 加载任何子项**之前**恢复中断的晋升事务、挂载官方 Include adapter、构造诊断函数 |
| `lib/registration.js` | 工具注册与系统提示词；`EVOLUTION_TOOLS` 列出工具面（10 个，含唯一的回收入口 `evolution_maintain`），`lib/diagnostics.js` 的 `EVOLUTION_TOOL_NAMES` 用它对照实时注册表，两份列表由测试断言一致 |
| `lib/orchestrator.js` | 实验 / trial / measurement / promotion 生命周期、journal 原子提交、CAS、跨进程锁、target claim、canary、失败学习、`promotionGates` |
| `lib/promotion-include.js` | 官方 `@deepseek-ai/cordis-plugin-include` 适配：不合成 loader entry、不写 profile `node_modules`，提交/回滚走公开 `refresh()` / `EntryTree.resolve` / `Entry.fiber` |
| `cordis.patch.yml` | bundle patch：向 profile 的 loader 树 `insert` 两个条目（`evolution-orchestrator` → `dsh-evolution`、`evolution-trust-root-guard` → `dsh-evolution/guard`）。这是插件进入 composition 的唯一入口 |

`lib/index.js` 的 `inject` 是 `tools` / `dynamicCordisRunner` / `systemPrompt` / `loader` / `storageDomain`（doctor 的 `REQUIRED_RUNTIME_SERVICES` 与本列表一致）；`apply()` 的顺序固定为：解析路径与密钥 → 打开领域存储 → **恢复中断的晋升事务** → 挂载 Include adapter → 注册工具。

### 领域与存储

| 文件 | 职责 |
| --- | --- |
| `lib/domain-storage.js` | 领域存储 adapter：`AsyncLocalStorage` 作用域、事件桥重放、pending 协议、领域 schema 校验、显式 `domainSeed`，以及端口上的显式 `reclaim()`（容量回收；见不变量 16） |
| `lib/dockyard-domain/memory.js` | hot 聚合 + 冷档案：`*.COLLECTION-archive.jsonl`、`.segments/segment-N.jsonl`、`*.evolution-archive-index.json`、retention、`history()` / `historyView()`、执行事件去重 |
| `lib/dockyard-domain/knowledge.js` | canonical knowledge：`knowledgeKey` 身份、`compactValue()`、聚合与去重（键名脱敏的结构化判定也由它导出） |
| `lib/dockyard-domain/observation.js` | 观测存储：健康信息 dedup、error 样本、`forceRecord`、>5% perf 转变阈值；只接收 DTO，不采集进程 perf、不订阅运行时事件 |
| `lib/dockyard-domain/evaluator.js`、`metric-projection.js` | advisory evaluator（独立 goal / test / regression 门槛与反刷分指标）与指标投影 |
| `lib/dockyard-domain/manifest.js`、`manifest-contract.js`、`errors.js` | 组件 manifest 规范化与共享 `ValidationError`；只做历史 DTO 投影，**不授权**解析、加载或执行该类组件 |
| `lib/dockyard-domain/index.js` | 运行时唯一的领域门面导出（`EvolutionMemory`、knowledge、evaluator、`EvolutionObservationStore`、`projectEvolutionMetric`）；`continuous/` 与 `governance/` **不在此导出** |
| `lib/dockyard-domain/PORTS.md` | 端口合同（`stateStore` / `transaction` / `mutationAuthority`）与非安全承诺：导入与构造不写文件而显式 `load()` **会**写盘、`inlineSerialization: true` 的标记条件、`historyView()` 的结果不可写回 |
| `lib/dockyard-domain/continuous/` | 纯领域模块：`discovery-metrics`（指标归一）、`lineage`、`strategy`、`supervisor`、`trial-supervisor`、`reporting`、`ports`、`shared`，`facade` / `index` 保留历史导入路径。**未接入** orchestrator 实时循环，doctor 的 `continuous-and-governance-not-wired` 把它记为已知限制 |
| `lib/dockyard-domain/governance/` | 纯领域模块：`authority`（四级授权）、`capability-registry`（生命周期）、`fitness`（加权评分）、`generation-policy`、`retirement`（移除前置条件）、`canary`（流量与屏障）、`store`（分区校验）、`trust-root`（只把 Cordis 本身视为不可改写）、`mutation-authority`、`helpers`（钳制/克隆/时间戳）。同样**未接入**实时循环 |
| `lib/archive-stage.js` | 冷档案树与进行中事务的隔离：staging、按变更集复制、逐字节校验、原子安装；变更清单可表达 `removed` 条目，但只限 `<stateFile>.<collection>-archive.jsonl.segments/segment-N.jsonl`，且删除在新文件全部安装成功之后执行 |
| `lib/event-log-checkpoint.js` | 事件桥日志的持久重放检查点（已消费字节长度、记录数、keyed digest 与 MAC；schema 3 的 `appliedDigest` 同时绑定 `retention` floor）**以及回收 floor 的纯逻辑**：裁掉哪个已吸收前缀（`planLogPrune`）、已提交截断的幂等补完（`completeEventLogTruncation`）、floor 尾部校验（`verifyLogFloorTail`）、被裁 marker 的 keyed 链与 floor 合并（`advanceRetention`）、保留字节的 checkpoint 覆盖（`planRetainedCoverage`） |
| `lib/experience-recall.js` | 只读、有界的按需经验检索；`EXPERIENCE_RECALL_LIMITS` 是全部上限的唯一来源 |

### 兼容与安全

| 文件 | 职责 |
| --- | --- |
| `lib/cordis-compat.js` | 本 bundle 触及的每一个 Cordis / 官方 Include 接口的分类与读取器：`SURFACE_PUBLIC` / `SURFACE_UNDOCUMENTED` / `SURFACE_PRIVATE`、`SURFACES`、`probeSurfaces()`、`recordedSurfaces()`、`registerIsolateKey()`；运行时与 doctor 共用同一张表 |
| `lib/compat/legacy-startup-drift.js` | legacy 适配器：默认读取 `~/.local/share/dsh-local/dsh-profiles-state.json`，只在找到该 state 与外部 engine 时才 import；默认禁用发生在 `lib/registration.js` 的调用层（传入 `startupDrift: false`），不是模块内部 |
| `lib/guard.js` | `dsh-evolution/guard`：只拒绝直接修改 Cordis trust root 与绕过 Cordis 生命周期的明确不可逆操作。**授权字段只取自宿主注入的 `exec.operationContext` / `exec.context`**（`verified` / `transactionType` / `actor` / `ownership` / `operation`），绝不从 `exec.arguments` 读取；目标路径与命令体仍来自 `arguments`，但只作为**被检查的输入**，不能充当证明。路径按文件系统语义逐组件跟随符号链接（先跟随 `hop`，再处理其后的 `..`）；managed 豁免要求目标出现在命令体里，不接受 basename 匹配 |

### 诊断与工具脚本

| 路径 | 职责 |
| --- | --- |
| `lib/diagnostics.js`、`scripts/doctor.mjs` | 运行时与 CLI 诊断；`resolveEvolutionPaths()` 是路径解析的唯一来源（doctor 与运行时共用），`runDiagnostics()` 产出全部 check（当前 28 个 check `id`；另有 6 个 repair `id` 与 5 个 degradedCapability `id`，三者不要混算），`--repair` 只处理 `recoverable=true` 且带 repair 的项。CLI 报告不得与运行时判断不一致 |
| `scripts/acceptance/` | `run-host-acceptance.mjs` 真实隔离宿主验收（自包含安装官方 DSH），`probes/{core,lifecycle,body,promotion}-probe.mjs` 是它驱动的宿主内探针 |
| `scripts/release/` | `pack.mjs`（本地打包）、`verify-package.mjs`（`pack:check`，开发/发布两种语义）、`verify-artifact.mjs`（字节校验与 `--content-only`）、`verify-provenance.mjs`（tag 与来源）、`publish-artifact.mjs`（**写** `release/` 固定点）、`release-lib.mjs` 与 `pin-relation.mjs`（摘要、条目、固定点关系的共享实现） |
| `scripts/benchmarks/` | 可复现性能基准：domain 写路径/回放/retention、冷档案、事件桥、诊断、经验检索、启动内存等；对应数据与收益边界写在 `docs/performance/` |
| `scripts/import-evolution-data.mjs` | 旧 preset / Dockyard 快照迁移 |
| `.github/workflows/` | `ci.yml`（单测矩阵 22.19.0 / 24.x + package + 三宿主验收）、`codeql.yml`（Code Scanning）、`release.yml`（校验 tag 并创建 **draft** Release，不重建产物） |

### 测试与发布数据

- `test/`：Node 原生测试（`.test.mjs` / `.test.js`，当前 139 个文件）。根目录以 `review-fix-*` 命名保留各轮评审的回归，`test/domain-storage/`、`test/dockyard-domain/`（含 `continuous/`）按层分组，`test/fixtures/` 与各目录的 `*-baseline.js` 是差分等价性基线。
- `test/workflows.test.mjs` 断言 CI 形状（作业集合、作业级堆上限、验收矩阵），`test/release-pin.test.mjs` 判定工作树与固定点的关系。
- `release/`：随仓库固定的发布产物（每个候选一个 tarball，历史候选保留）、`manifest.json`、`SHA256SUMS`。**不要手工编辑这些文件。**
- `docs/evidence/`：与固定产物对应的验收记录；`docs/performance/`：性能数据与收益边界；`docs/core-reliability.md`：rc.5 时期的恢复边界探索记录，不是当前合同。
- `dist/`：本地产物输出，不入库。

## 3. 开发约定

- 只做必要修改，不做与目标无关的重构；保持既有持久化格式、API、默认行为与授权边界。
- 性能改动必须能复现：给出交替 A/B 数据、收益边界，并把复现脚本与原始数据写入 `docs/performance/`。被反例击穿的方案要显式撤回并固化为回归用例，而不是悄悄删除。
- 修改 `lib/dockyard-domain/` 下的 `stateStore` / transaction 合同时，先读 `lib/dockyard-domain/PORTS.md`：`inlineSerialization: true` 只有在 transaction 同步捕获全部 payload 字节时才可标记。
- 新增宿主接口依赖时，必须在 `lib/cordis-compat.js` 分类，并让 `runtime.internal-api` 能探测到它。
- 注释与文档只描述代码实际做的事；不写"已完成"而未经执行的验证结论。
- 文档也是被测对象：`scripts/release/verify-package.mjs` 断言 `README.md` 提到当前版本与每个受支持宿主版本，并保留安装 / 诊断 / 升级 / 回滚 / 卸载说明。改 `README.md` 或 `COMPATIBILITY.md` 后跑 `npm run pack:check`（它同时报告工作树与固定点的关系）。

## 4. 必须保留的不变量

1. **不建第二套运行时。** 不创建自己的 registry、resolver、生命周期管理器或 effect tracker；一切经由官方 Cordis API 与官方 runner。
2. **先恢复、后加载。** 中断的磁盘事务必须在 Include 加载任何子项之前恢复。未知或损坏的持久状态**不得猜测、静默合并或删除现场**。晋升 journal 的阶段判定只有一份：`classifyPromotionJournal` 把 `prepared` / `committing` / `canary-observing` / `stable-committed` / `committed` / `rollback-failed` 映射到各自的恢复状态，其余（含缺失阶段）是 `state-unknown`；doctor 对它报 `blocked` 且不提供 repair，`recoverInterruptedPromotion` 与 canary 读取（`readCanaryJournal`，被 `observeCanary` / `verifyStartupCanary` 使用）共用同一拒绝，未知阶段、边界违规与 `rollback-failed` 都不得回滚或删除现场。改动判定时必须同时移动 doctor、启动恢复与 canary 读取，不要只改一边。
3. **Trial 基线只捕获一次。** 恢复基线在 Trial 首次修改运行时之前同步捕获，后续步骤不重建；因此 Trial 期间的真实并发漂移必须使恢复校验失败，并在 `revert` / `promote` 路径上保留目标锁。Trial 的 `define` / `run` 失败路径不激活任何东西，会释放目标锁并丢弃记录。
4. **晋升门禁是生产权威。** `promotionGates` 的 8 项证据缺一不可；领域 evaluator 只是 advisory + regression veto，不得用它替代门禁。`requireRuntimeRecovery: false` 只用于"运行时尚未恢复"时给调用方看的只读证据视图（measure 响应、等待确认的响应、`domain-evaluator-rollback` 返回、dispose 之前的 `evidenceGates`，以及自主观察者在 revert 前判断候选是否成立）；晋升在 dispose 之后用默认判定（`requireRuntimeRecovery: true`），并同时要求 `disposed.recovered`，所以“运行时已恢复”被两道条件共同强制。
5. **生产晋升必须显式确认。** `confirmation: true` 之外的一切路径（包括 autonomous 观察者）都只能返回"等待所有者确认"。
6. **默认不会自己上生产。** `mode` 默认 `advisory`、`unattended` 默认 `false`，两者只记录在策略报告里；**它们不是自主观察者的前置开关**。观察者是否启动隔离 Trial 由 `autonomousStrategies`、`patternThreshold` 与风险等级决定（只有 `low` + `autonomousPolicy.low === "experiment"` 能走到实验，`medium` / `high` 是硬约束），且无论如何都停在 `candidate-awaiting-confirmation`。不要新增能让观察者自行批准生产的路径。
7. **经验检索只读，且只由提交 proposal 的动作触发。** 入口是 `evolution_propose` 与 `evolution_history`（带 `query`）；不得让定时器、轮询或 measurement 触发它。自主观察者经 `evolution_propose` 间接触发属于这条路径本身，不是例外。上限只能由调用方收紧，不能放宽。
8. **脱敏边界。** 原始错误文本在进入领域存储前必须经脱敏 DTO；不得把凭据、密钥或用户数据写入日志、证据或产物。
9. **晋升是 Host-only，且不是安全沙箱。** `evolution_promote` 只接受 Host half，带 `client` 的 Package 直接拒绝（`evolution_trial` 允许 client）。合作式 `Function(hostCode)()` gate **不是**安全沙箱，晋升执行需要可信审批。
10. **发布字节固定。** 发布附件永远是 `release/` 中固定的那个 tarball；发布 workflow 不重新构建，只验证并上传它。普通 CI 会重新打包，但那是为了验证内容一致性与跑验收，不会成为发布字节。
11. **崩溃残件的处理边界。** 运行时只自动回收两类残件：`domain-archive.lock`（按 `acquireArchiveLock` 的既有规则：命名且可证明已死的 owner，或过了 `LOCK_SETTLE_MS` 的无主条目，删除前必须有设备号 + inode + 字节围栏），以及 `ownership/<sha256>.json` 中**同主机、整数 pid、`process.kill` 返回 `ESRCH`** 的 claim（既有规则，每次获取只在首次尝试回收一次）。除此之外 claim 只有两条合法的删除路径：按 `experimentId` 采纳（**在分类之前**，所以同 experimentId 的 claim 无论 hostname/pid 如何都会被采纳而不会被探测或回收），以及所有者 `releaseTargets()` 释放 `experimentId` 与自己匹配的 claim。其余形状（不可读、外地 hostname、缺可用 hostname/pid）**只报告、不作为陈旧 claim 回收**：claim 没有“创建时捕获身份、使用前再证明”的协议，0 字节条目无法与“已取得独占句柄、尚未写入的进程”区分，回收会让两个实验同时持有同一 target。`event-bridge.key` 从不被 **doctor** 写入、读取后也不被任何运行时路径替换：仅在路径**不存在**时由 `storageConfig()` 以 `wx` 创建（并只删除自己本次未写成的条目），已存在的非法密钥永远拒绝启动而非替换。磁盘上无法证明“没有进程正拿旧密钥签名”，所以即使没有 MAC 也只能由操作者按 `data.key` 的指令处置。doctor 自身从不删除或改写 claim 与密钥；与残件相关的 repair 是 `domain-stale-lock`、`event-bridge-trim-partial-tail`、`domain-orphan-staging` 与 `migration-staging-cleanup`，各自只处理自己能证明的现场，其中 `domain-stale-lock` 只走运行时同一套 `withArchiveLock`。**同一路径只允许一套协议**：`ownership/` 的读取由运行时与 doctor 共用 `parseTargetClaim` + `classifyTargetClaim`（连步骤顺序都相同），archive 锁由 `inspectArchiveLock` 与 `withArchiveLock` 共用同一分类器；新增旁路解释就是第二条协议。（上面两条 reclaim 规则与整个跨进程协议一样，前提是同一个数据根、同一个 hostname 与 PID namespace；跨命名空间共享数据根不在支持范围内。）
12. **知识身份带 `__proto__` 的键不能折叠，且必须在整条链路上作为自有数据属性保留。** `knowledge.js` 的 `compactValue()`、`memory.js` 与 `observation.js` 各自那处 `redact()` 和聚合里的动态键写入都必须用 `Object.fromEntries()` / `Object.defineProperty()` 定义自有属性；赋值到 `{}` 会把 JSON 自有的 `__proto__` 交给原型 setter，静默丢键（对象值还会让输出把 payload 当成原型，后续字段读因此继承到 payload 从未自有的字段），使两个不同事实共享一个 `knowledgeKey`，或让内存身份与持久化重载身份漂移。`lib/domain-storage.js` 的聚合投影只对**去键副本**做结构校验（接受/拒绝与 issue 的 `code`/`path`/`message` 不变），返回并持久化的文档保留该键；删掉它就是删身份。摄取、聚合、保存、重载与冷档案必须给同一载荷同一个身份。不含自有 `__proto__` 的载荷必须逐字节保持旧身份（`test/dockyard-domain/knowledge-identity-equivalence.test.js` 的固定产物 pin 与 `knowledge-proto-key-identity.test.js` 的差分），已折叠的旧记录不迁移、不猜测。`constructor` / `toString` 等非访问器原型名是普通自有键，不能与 `__proto__` 混为一谈；事件 ledger / marker 对原型名 marker 的 fail-loud 拒绝是另一条刻意边界（`test/domain-storage/ledger-merge-differential.test.js`、`marker-table-special-keys.test.js`），不要顺手放宽。同一条要求适用于 `lib/orchestrator.js` 的三个对象投影/合并边界：`toLosslessJson()`、`safeErrorEvidence()`（`cleanupProof` / `recoveryProof` / `rollbackResult`）与 `mergeEvidenceSources()` 的 `mergeLatest` 也必须用 `Object.fromEntries()`（或 `Object.defineProperty()`）定义自有属性；赋值到 `{}` 会丢键、把 payload 换成输出对象的原型，让后续字段读继承到 payload 从未自有的值（证明里只写在自有 `__proto__` 下的 `status` 就能伪造 `runtimeRecovered`）。不含自有 `__proto__` 的输入必须逐字节保持旧输出（`test/review-fix-lossless-projection-and-evidence-special-keys.test.mjs` 的固定字节 pin 与 pre-fix 差分）。
13. **事件桥追加是跨进程互斥的，且不猜尾字节。** 锁是 `<log>.append.lock` 目录，内含 `{token,pid,hostname,acquiredAt}`：同主机且 pid 存活的所有者**永不**回收（一次慢 fsync 不能放进第二个写者）；`process.kill` 返回 `ESRCH` 的条目立刻回收；无主或外地主机条目才按 `EVENT_BRIDGE_LOCK_STALE_MS`（2000 ms）判定。回收必须先取得**同级** `<lock>.reclaim` 标记（`open(..., "wx")`），并在持有标记**之后**才读取 owner 与 age——标记不能放在锁目录内，否则创建标记会刷新用于判定陈旧的 mtime，且第二次回收者能用缓存的 age 删掉第一个回收者刚建好的新锁；崩溃留下的标记超过 `EVENT_BRIDGE_RECLAIM_STALE_MS`（10 s）可删。释放只删 token 仍匹配的锁。锁自身的簿记使用模块加载时捕获的 `fs.writeSync`，宿主或测试替换它不会卡住锁。追加前必须确认尾字节：若文件不以 `\n` 结尾，最后一行必须能被验签为完整信封才补分隔符，否则**拒绝追加**（绝不把两条记录粘成一行）；pending 追加只在按 `dev`+`ino` 复核身份、并逐字节比对已落盘前缀之后才继续，尾部扫描上限 `EVENT_BRIDGE_TAIL_SCAN`（1 MiB）。
14. **晋升 journal 的变更计划必须自证是本次事务写的。** `checkJournalBoundary` 在包含性之外还要求：计划非空、无重复目标、每个 file 记录命中三份计划文件之一（composition、`EVOLUTION.md`、`archive/experiments/<experimentId>.md`）、path 记录**恰好**是 `<pluginRoot>/dsh-evolution-promoted-<sha256(experimentId) 前 12 位>`、`experimentId` 匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`。只有包含性时，`records: []` 会删掉唯一证据后报 `rolled-back`，命名 `presetDir` / `dockyard` / `knowledge` 的记录会让恢复删掉全部持久知识。计划、CAS 基线与备份必须来自**同一次捕获**（旧顺序先建计划再读字节，中间的编辑会被静默覆盖），备份走持久写入而不是未 fsync 的 `copyFile`。
15. **脱敏投影必须是有界的线性扫描。** `redactJsonParseMessage()` 用一次前向游标代替正则：取**最后**一个 `is not valid JSON` 后缀、取**第一个**引号，若引号在后缀之前则保留引号前的内容、丢掉引号到后缀之间的片段（包括 V8 在片段前放的分隔符：逗号与空白）再拼回后缀；超长输入因此不会回溯也不会携带原字节。任何新增的"从错误文本里抠片段"的逻辑都不得引入在被控数据上回溯的正则。`REDACTION_TEXT_BOUND`（64 KiB）仍是唯一的有界输入开关：超过它的文本以 `withheldTextMarker` 代替而不是被截断。
16. **容量回收只走显式 `reclaim()`，顺序即安全论证。** 端口只有 `reclaim({ confirmation: true })` 会删除已知可回收的字节（`dryRun` 只读、无确认直接拒绝）。归档侧复用 `compact()` 的语义与完整性门禁（`#rewriteArchives` 的 9 类 finding 拒绝），被替换的 sealed 段以 `pending.files` 的 `removed` 条目发布：只允许段文件形状，条目携带提交时读到的 `bytes`+`sha256`，安装时先验证全部替换与全部删除再发布，删除排在新文件安装之后，重复重放是 no-op。日志侧顺序不可交换：先把被丢弃记录携带的 promotion/measurement 事实写进 evidence sidecar（写失败即中止），然后提交裁剪后的 `applied` 与 `retention` floor（`prior` = 计划时整份日志的 keyed digest 与字节数，`tail` = 截断后保留前缀的 keyed digest，`markers.chain` = 被裁 marker 的 keyed 链），**提交之后**才在 append lock 下原子截断。“floor 已提交、截断未发生或被打断”是下一次 replay 幂等完成的已提交事务（`completeEventLogTruncation`：先核对文件仍以 `prior` 开头，再重写并核对 `tail`），所以这个崩溃窗口不会变成永久拒绝；反过来（先截断、后提交）会让 floor 描述已经不存在的字节，而下一轮的保留尾部与上一轮 floor 的 `tail` 没有可证明的关系，第二次回收崩溃后即不可恢复。replay 在没有可信 checkpoint 时要求日志要么以 floor 尾部开头，要么**恰好**是 floor 记录的 `prior` 文件（后者由 `completeEventLogTruncation` 幂等补完那次已提交的截断）；两者都不是就以 `E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH` 拒绝吸收，空文件也不例外（空日志不能证明保留字节没丢，接受它会让下一次追加造出永远对不上 floor 的头部）——裁剪 marker 之后无法再把一条老记录与它的去重身份对上，宁可不吸收也不能重放；这个拒绝没有”猜测式修复“，操作者只能恢复那段被保留的字节或换一个数据根。没有可信外部化器时拒绝截断；证据身份不是安全文件名成分时整体拒绝（`E_DOMAIN_EVIDENCE_ID_UNSAFE`）；没有 floor 时 `digestApplied` 与 checkpoint 字节保持不变。已知边界（不修，写在这里以免误读）：(a) 回收后的领域文档带 `retention` 键，旧版本插件的 strict global schema 会拒绝它，所以**回收后不可降级**；(b) 被裁 marker 的 eventId 不再参与 `E_DOMAIN_EVENT_ID_CONFLICT`：同一身份重新发出时，领域 ledger 会以新 MAC 重新吸收它，而 memory 自己的 4096 条 marker 窗口仍按 id 认得它、于是把记录效果当重复跳过（`applied: 0, duplicates: n`）；两者都不再抛冲突，`test/retention-log-floor.test.mjs` 钉住了这个边界；(c) 段目录里 `.tmp` 形状的 seal 残件既不进变更清单也不被删除，回收照常进行，doctor 的 `state.archives` 报 degraded 并保留现场；(d) doctor 的 `state.retention-floor` 使用运行时同一只读分类器，按 pending 优先读取已提交 floor：保留尾部为 ok、待截断原文件为 degraded、缺失或不匹配为 blocked，不提供 repair；(e) 有 floor 且需要补完已提交截断时，如果另一个写者持有 append lock，`open`/`flush` 以 `E_DOMAIN_EVENT_LOG_BUSY` 失败（可重试，下一次 pass 会补完），不会静默跳过这一轮；(f) 二次日志回收先补完上一轮已提交截断，再验证保留尾部；append lock 竞争以 `E_DOMAIN_EVENT_LOG_BUSY` 拒绝新事务，dry run 只读报告 `pending-truncation`，不会把旧文件头的空行当作新 floor 的推进依据。回收没有定时器或后台调用者。

## 5. 验证要求

从仓库根执行，按变更选择必要检查：

```sh
npm ci --ignore-scripts                          # 需要安装依赖时；与单测 CI 一致
node --max-old-space-size=4096 --test test/trial-recovery-boundary.test.mjs  # 聚焦测试示例
NODE_OPTIONS=--max-old-space-size=4096 npm test  # 仓库回归入口；堆上限是硬要求，见下条
npm run pack:check                               # 开发阶段：分发内容、权限、锁文件、文档一致性 + 工作树/固定点关系
npm run pack:check -- --release                  # 发布阶段：额外要求工作树就是固定内容（漂移即失败）
npm run release:verify                           # 固定产物：字节 + 内容摘要 + 条目 + 权限
npm run release:verify -- dist/<build>.tgz --content-only   # 本机重建只比内容
node scripts/release/verify-provenance.mjs --tag vX --require-source-commit
```

- `npm test` 展开为 `node --test "test/**/*.test.mjs" "test/**/*.test.js"`。`pack:check` 两种模式都执行 16 项检查：开发模式包含“固定点描述自己的提交”与“工作树是固定点或已提交后继”，`--release` 把这两项换成“固定点固定本树内容”与“工作树构建出固定内容”。它把"工作树是固定点的已提交后继"作为独立结论打印，所以读结果时要区分"16 项通过"与"这棵树就是发布产物"；分发文件存在**未提交**改动时它一律失败。

- **全量测试必须带 V8 堆上限，不要裸跑 `npm test`。** 2026-10-20 的实际事故：用 `/tmp/nodedist/v24.9.0/bin/node` 跑全量套件时，单个 `node --test` 子进程累计分配约 200 GB 匿名内存（`JetsamEvent` 中 `rpages` = 13,002,874 × 16 KB ≈ 203 GB，`largestProcess` = `node`），被内核以 `memorystatus: killing ... due to low-swap` 强杀，连带弹出「应用程序内存不足」并清理 `cfprefsd` / `suggestd` / Dock 相关等系统进程。01:28–09:19 间共触发 4 次，峰值稳定在约 201,9xx MiB。事故记录把这归为确定性的无界分配；该归因本身没有被本轮验证，边界见 §5 最后一条与 `docs/performance/oom-localization.md`。
  - 全量回归用 `NODE_OPTIONS=--max-old-space-size=4096 npm test`；单文件用 `node --max-old-space-size=4096 --test <file>`。不得用 `--no-max-old-space-size` 或空 `NODE_OPTIONS` 覆盖该上限。
  - 不得用临时下载的 Node 发行版（如 `/tmp/nodedist/v*/bin/node`）跑全量套件 —— 那正是本次事故的触发方式。多版本验证走 `package.json#engines` 声明的范围，并保留堆上限。
  - 出现 `RangeError: Maximum call stack size exceeded`、正则回溯超时或 RSS 单调增长时立即中止、不要重试；先二分到单文件，并确认 `REDACTION_TEXT_BOUND`（`lib/orchestrator.js`）这类输入边界仍然生效。
  - 单文件二分**已完成（有界）**：`docs/performance/oom-localization.md` 记录了对 95 个测试文件逐个起独立进程组的复测（`--max-old-space-size=4096`、2 GiB RSS 上限、300 s 超时），全部通过，峰值最高为 `test/dockyard-domain/continuous/continuous.test.js` 的 459 MiB，没有任何文件被上限杀掉；与此同时，事故点名的 8 MiB 病态 `\x` 输入在当前规则表上（绕过 64 KiB `REDACTION_TEXT_BOUND`）只需 27 ms、RSS 增加 9 MiB、不再抛错。结论的边界要说清楚：在本次环境（Node v26.12.0）与当前代码上，那次无界分配与事故点名的 `RangeError` 都无法复现；事故时的 Node 发行版与工作树、以及产生它的中间规则表版本都没有留存，所以这不是对历史根因的定论。「`rpages` ≈ 203 GB」那个具体数值也**未复现**，不要把它当作已被验证的上界。CI 的单元测试作业现在通过作业级 `NODE_OPTIONS` 强制执行同一个上限（`test/workflows.test.mjs` 断言），定位与复测都必须继续在带堆上限的前提下进行。
- 改动 **trial/teardown、跨进程锁、CAS、journal、canary 或重启恢复**时，必须补对应失败路径测试。
- 真实宿主验收：`npm run acceptance:host -- --host <version> --out <evidence-path>`。它会安装依赖并生成证据，**必须使用隔离 runtime/home**，不得触碰正式 `DSH_HOME`。
- 修改任何**分发文件**（`package.json#files` 覆盖的内容）都会改变 `contentSha256`，于是工作树不再是固定点描述的那个包。`pack:check` 默认按开发阶段判定：固定点必须仍然描述它自己记录的 `sourceCommit`（该 commit 在历史中、是 HEAD 的祖先、且发布的内容等于固定内容），工作树要么就是固定点，要么是它的**已提交**后继（逐条点名差异）；未提交的分发改动、浅克隆（缺历史）与“固定点不再描述自己记录的 commit”仍然失败；`pack:check -- --release`（`release.yml` 使用）保持严格语义，工作树不等于固定内容即失败。把漂移转绿的唯一途径是按 `RELEASE.md` 重新构建、重跑宿主验收、再更新固定点，**不手工伪造通过记录**。
- `release:pack` 只生成本地产物；`release:publish` 会更新 `release/` 固定点，不属于只读检查。
- 本机 `npm pack` 压缩字节不一定与已发布 tarball 相同；始终区分字节校验与 `--content-only` 的内容校验。
- 性能或行为改动优先用差分测试（对照固定基线）证明等价，而不只依赖新增用例。
- 只报告本次实际执行的检查；不引用未重跑的历史验收数字。

## 6. 发布边界

- 发布流程与校验命令见 `RELEASE.md`；固定点语义见 `release/manifest.json` 的字段说明。
- 新宿主版本必须**先通过真实安装验收**，才能扩展 `peerDependencies`、CI 矩阵与兼容说明；不得用宽松范围绕过 doctor 的阻断。
- `release/manifest.json` 的 `sourceCommit` 必须是 tag 历史中的祖先，且 source commit、tag 树与 tarball 的 shipped 内容摘要三者相同。
- CI 的 release workflow 只创建 **draft** Release 并上传固定产物，不自动公开；已存在资产的 Release 一律拒绝覆盖，上传不使用 `--clobber`。
- 以下动作属于外部写入，**必须获得明确授权**后再执行：`git push`、创建/移动 tag、创建或公开 GitHub Release、`npm run release:publish`、任何 npm 发布。
- 不读取正式用户数据、密钥、`event-bridge.key` 或旧迁移目录来"补齐"测试；优先使用临时 home。诊断 `--repair`、导入、启停、升级与卸载同样需要明确授权。
- 不提交运行日志、session、凭据、动态 promoted 源码或私有数据。`docs/evidence/` 与 `docs/performance/` 不属于包内容白名单，可发布后写入而不改变发布字节。
