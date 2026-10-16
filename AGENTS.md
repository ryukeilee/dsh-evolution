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
| `lib/registration.js` | 工具注册与系统提示词；`EVOLUTION_TOOLS` 列出工具面，`lib/diagnostics.js` 的 `EVOLUTION_TOOL_NAMES` 用它对照实时注册表，两份列表由测试断言一致 |
| `lib/orchestrator.js` | 实验 / trial / measurement / promotion 生命周期、journal 原子提交、CAS、跨进程锁、target claim、canary、失败学习、`promotionGates` |
| `lib/promotion-include.js` | 官方 `@deepseek-ai/cordis-plugin-include` 适配：不合成 loader entry、不写 profile `node_modules`，提交/回滚走公开 `refresh()` / `EntryTree.resolve` / `Entry.fiber` |

### 领域与存储

| 文件 | 职责 |
| --- | --- |
| `lib/domain-storage.js` | 领域存储 adapter：`AsyncLocalStorage` 作用域、事件桥重放、pending 协议、领域 schema 校验、显式 `domainSeed` |
| `lib/dockyard-domain/` | 纯领域实现：`memory.js`、`knowledge.js`、`observation.js`、`evaluator.js`、`metric-projection.js`、`manifest*.js`；`PORTS.md` 记录端口合同与非安全承诺 |
| `lib/dockyard-domain/continuous/`、`governance/` | 已提取并单测的纯领域模块，**未接入** orchestrator 实时循环 |
| `lib/archive-stage.js` | 冷档案树与进行中事务的隔离：staging、按变更集复制、逐字节校验、原子安装 |
| `lib/event-log-checkpoint.js` | 事件桥日志的持久重放检查点：已消费字节长度、记录数、keyed digest 与 MAC |
| `lib/experience-recall.js` | 只读、有界的按需经验检索；`EXPERIENCE_RECALL_LIMITS` 是全部上限的唯一来源 |

### 兼容与安全

| 文件 | 职责 |
| --- | --- |
| `lib/cordis-compat.js` | 本 bundle 触及的每一个 Cordis / 官方 Include 接口的分类与读取器；运行时与 doctor 共用同一张表 |
| `lib/compat/legacy-startup-drift.js` | legacy 适配器：默认读取 `~/.local/share/dsh-local/dsh-profiles-state.json`，只在找到该 state 与外部 engine 时才 import；默认禁用发生在 `lib/registration.js` 的调用层（传入 `startupDrift: false`），不是模块内部 |
| `lib/guard.js` | `dsh-evolution/guard`：只拒绝直接修改 Cordis trust root 与绕过 Cordis 生命周期的明确不可逆操作 |

### 诊断与工具脚本

| 路径 | 职责 |
| --- | --- |
| `lib/diagnostics.js`、`scripts/doctor.mjs` | 运行时与 CLI 诊断；共用同一份路径解析与判定函数，CLI 报告不得与运行时判断不一致 |
| `scripts/acceptance/` | 真实隔离宿主验收（自包含安装官方 DSH）与 probes |
| `scripts/release/` | 打包、发布固定点、产物与来源校验 |
| `scripts/benchmarks/` | 可复现性能基准 |
| `scripts/import-evolution-data.mjs` | 旧 preset / Dockyard 快照迁移 |

### 测试与发布数据

- `test/`：Node 原生测试与 fixtures（`.test.mjs` / `.test.js`），含差分等价性基线与故障注入。
- `release/`：随仓库固定的发布产物、`manifest.json`、`SHA256SUMS`。**不要手工编辑这些文件。**
- `docs/evidence/`：与固定产物对应的验收记录；`docs/performance/`：性能数据与收益边界。
- `dist/`：本地产物输出，不入库。

## 3. 开发约定

- 只做必要修改，不做与目标无关的重构；保持既有持久化格式、API、默认行为与授权边界。
- 性能改动必须能复现：给出交替 A/B 数据、收益边界，并把复现脚本与原始数据写入 `docs/performance/`。被反例击穿的方案要显式撤回并固化为回归用例，而不是悄悄删除。
- 修改 `lib/dockyard-domain/` 下的 `stateStore` / transaction 合同时，先读 `lib/dockyard-domain/PORTS.md`：`inlineSerialization: true` 只有在 transaction 同步捕获全部 payload 字节时才可标记。
- 新增宿主接口依赖时，必须在 `lib/cordis-compat.js` 分类，并让 `runtime.internal-api` 能探测到它。
- 注释与文档只描述代码实际做的事；不写"已完成"而未经执行的验证结论。

## 4. 必须保留的不变量

1. **不建第二套运行时。** 不创建自己的 registry、resolver、生命周期管理器或 effect tracker；一切经由官方 Cordis API 与官方 runner。
2. **先恢复、后加载。** 中断的磁盘事务必须在 Include 加载任何子项之前恢复。未知或损坏的持久状态**不得猜测、静默合并或删除现场**。晋升 journal 的阶段判定只有一份：`classifyPromotionJournal` 把 `prepared` / `committing` / `canary-observing` / `stable-committed` / `committed` / `rollback-failed` 映射到各自的恢复状态，其余（含缺失阶段）是 `state-unknown`；doctor 对它报 `blocked` 且不提供 repair，`recoverInterruptedPromotion` 与 canary 读取（`readCanaryJournal`，被 `observeCanary` / `verifyStartupCanary` 使用）共用同一拒绝，未知阶段、边界违规与 `rollback-failed` 都不得回滚或删除现场。改动判定时必须同时移动 doctor、启动恢复与 canary 读取，不要只改一边。
3. **Trial 基线只捕获一次。** 恢复基线在 Trial 首次修改运行时之前同步捕获，后续步骤不重建；因此 Trial 期间的真实并发漂移必须使恢复校验失败，并在 `revert` / `promote` 路径上保留目标锁。Trial 的 `define` / `run` 失败路径不激活任何东西，会释放目标锁并丢弃记录。
4. **晋升门禁是生产权威。** `promotionGates` 的 8 项证据缺一不可；领域 evaluator 只是 advisory + regression veto，不得用它替代门禁。
5. **生产晋升必须显式确认。** `confirmation: true` 之外的一切路径（包括 autonomous 观察者）都只能返回"等待所有者确认"。
6. **默认不会自己上生产。** `mode` 默认 `advisory`、`unattended` 默认 `false`，两者只记录在策略报告里；**它们不是自主观察者的前置开关**。观察者是否启动隔离 Trial 由 `autonomousStrategies`、`patternThreshold` 与风险等级决定（只有 `low` + `autonomousPolicy.low === "experiment"` 能走到实验，`medium` / `high` 是硬约束），且无论如何都停在 `candidate-awaiting-confirmation`。不要新增能让观察者自行批准生产的路径。
7. **经验检索只读，且只由提交 proposal 的动作触发。** 入口是 `evolution_propose` 与 `evolution_history`（带 `query`）；不得让定时器、轮询或 measurement 触发它。自主观察者经 `evolution_propose` 间接触发属于这条路径本身，不是例外。上限只能由调用方收紧，不能放宽。
8. **脱敏边界。** 原始错误文本在进入领域存储前必须经脱敏 DTO；不得把凭据、密钥或用户数据写入日志、证据或产物。
9. **晋升是 Host-only，且不是安全沙箱。** `evolution_promote` 只接受 Host half，带 `client` 的 Package 直接拒绝（`evolution_trial` 允许 client）。合作式 `Function(hostCode)()` gate **不是**安全沙箱，晋升执行需要可信审批。
10. **发布字节固定。** 发布附件永远是 `release/` 中固定的那个 tarball；发布 workflow 不重新构建，只验证并上传它。普通 CI 会重新打包，但那是为了验证内容一致性与跑验收，不会成为发布字节。

## 5. 验证要求

从仓库根执行，按变更选择必要检查：

```sh
npm ci --ignore-scripts                          # 需要安装依赖时；与单测 CI 一致
node --test test/trial-recovery-boundary.test.mjs  # 聚焦测试示例
npm test                                         # 仓库回归入口（Node 原生测试）
npm run pack:check                               # 分发内容、权限、锁文件、文档一致性、发布固定点
npm run release:verify                           # 固定产物：字节 + 内容摘要 + 条目 + 权限
npm run release:verify -- dist/<build>.tgz --content-only   # 本机重建只比内容
node scripts/release/verify-provenance.mjs --tag vX --require-source-commit
```

- 改动 **trial/teardown、跨进程锁、CAS、journal、canary 或重启恢复**时，必须补对应失败路径测试。
- 真实宿主验收：`npm run acceptance:host -- --host <version> --out <evidence-path>`。它会安装依赖并生成证据，**必须使用隔离 runtime/home**，不得触碰正式 `DSH_HOME`。
- 修改任何**分发文件**（`package.json#files` 覆盖的内容）都会改变 `contentSha256`，从而使 `pack:check` 失败。这不是可忽略的噪音：按 `RELEASE.md` 重新构建、重跑两个宿主的验收、再更新固定点，**不手工伪造通过记录**。
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
