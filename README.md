# dsh-evolution

**在 DSH 中以证据驱动的方式试验、回滚和晋升 Cordis Plugin。**

`dsh-evolution` 是独立的 DSH bundle：它让 Agent 在真实 Cordis Runtime 上提出改进、启动临时 Trial、测量结果，并在回滚或满足晋升条件后保存为插件。它通过官方 bundle / profile 机制接入，不是 DSH fork。

| 关键事实 | 当前值 |
| --- | --- |
| 版本 | `0.2.0-rc.19`（发布候选） |
| 已验收 DSH | `0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| 分发 | GitHub Release tarball；不发布 npm 包 |
| 许可证 | MIT |

## 30 秒了解

- 通过官方 Cordis runner 做隔离实验，保留首次修改运行时前捕获的基线。
- Trial 可以回滚；回滚路径比较运行时签名，恢复失败时拒绝继续晋升。
- 晋升需通过 8 项证据门禁，并由所有者显式传入 `confirmation: true`。
- 晋升后进入 canary；启动健康、依赖或屏障上报告的指标回归会按规则提交或回滚候选。
- 失败与观测可在无模型参与下保存；经验只在提交 proposal 或带查询的 history 时读取。
- CLI 和会话内 doctor 不依赖模型；CLI 无法观测的运行时项目会明确标为 `not-evaluated`。

## 它解决什么问题

| 常见问题 | 对应机制 |
| --- | --- |
| 临时改动留下后无法确认如何撤销 | 先用官方 runner 激活 Trial；回滚时 dispose 并验证 Runtime 签名恢复到基线 |
| “看起来更好”被当成“确实有效” | 晋升要求 8 项证据全部成立；领域 evaluator 不能代替生产门禁 |
| 同一失败反复尝试 | 无模型地记录失败与结果；新 proposal 可读取已有结论 |
| 晋升后突然崩 | 晋升后进入 canary 观察，跨重启校验启动、健康与依赖；屏障报告指标回归即自动回滚 |
| 宿主 API 漂移而无从判断 | doctor 逐项探测真实运行状态，缺什么报什么，并给出 `blocked` / `degraded` 分级 |

## 它是什么 / 不是什么

它是一个通过 DSH profile 加载的独立插件，所有组件、服务、Fiber、Effect、事件监听、工具和 dispose 生命周期仍由 Cordis 管理。

它不是 DSH fork，不修改官方源码，不向宿主 `node_modules` 复制实现，也不创建第二套 registry、resolver 或生命周期管理器。晋升代码经合作式执行 gate 加载；这不是安全沙箱，生产晋升需要可信审批。

`dsh-evolution/guard` 只拒绝直接修改 Cordis trust root、或绕过 Cordis 生命周期的明确不可逆操作；普通 composition、promoted plugin、guard 与 orchestrator 本身的演进不受影响。

## 工作原理

十个工具按系统提示词规定的生命周期顺序工作：

```text
evolution_runtime_inspect
        ↓
evolution_propose
        ↓
evolution_trial
        ↓
evolution_measure
        ↓
evolution_revert ───────────── 放弃：dispose 并校验恢复
        或
evolution_promote ──────────── 采纳：持久写入后进入 canary
        ↓
evolution_canary_observe ───── 报告屏障结果、推进 canary
        ↓
跨重启启动屏障 ────────────── 提交 stable 或回滚候选

evolution_history ──────────── 读取有界历史；传 query 时检索经验
evolution_maintain ─────────── 容量回收：dryRun 先看收益，确认后才删除
evolution_doctor ──────────── 无模型诊断
```

Trial 的恢复基线在首次修改运行时之前同步捕获一次，后续 inspect、measure 和清理不会重建基线。Trial 期间仍存在的外部漂移会使恢复校验失败，并保留目标锁；define / run 失败没有激活任何内容，会释放目标锁并丢弃实验记录（与失败学习写入是否成功无关）。

晋升的 8 项门禁缺一不可：

1. 真实收益（`realBenefit`）
2. 可测量证据（`measuredEvidence`）
3. 可重复（`repeatable`）
4. 回归测试通过（`regressionTest`）
5. 可回滚（`reversible`）
6. 清理证据（`cleanupEvidence`）
7. 无孤儿资源（`noOrphans`）
8. Runtime 已恢复（`runtimeRecovered`）

领域 evaluator 只提供 advisory 判断，并在识别到 regression 时否决；`promotionGates` 才是生产晋升权威。

晋升先一次性捕获三份计划文件与回滚基线，把备份持久写入，再以 `prepared` / `committing` 落 journal，然后原子写入并做 Include 校验。成功后持久 Plugin 行与 archive 指针供下一 session 加载。canary 必须由调用方在确定性屏障上报告结果；指标回归由调用方报告，插件不会自行比较指标数值。达到观察条件后提交 stable；启动健康或依赖不成立、或屏障报告指标回归时会自动回滚，而且只回滚新候选。已 stable 并清理 journal 的晋升不能从 evidence sidecar 或 archive 重新打开为 canary。

启动时先恢复中断的晋升事务，再让 Include 加载子项。启动 canary 屏障检查插件健康与依赖，并固定报告 `metricRegression: false`；canary 完成要求启动验证和所需观察屏障都满足。跨 session 推进要求存在活动 canary journal，所有者从持久状态读取；调用者自己的 Agent id 不是 fallback。同一进程内的并发 canary 观察会与 revert / promote 共用操作 claim 串行化，重复并发请求会被拒绝；该 claim 是进程内 Map，不是跨进程锁（跨进程的晋升提交由 `promotion.lock` 保护）。

## 默认安全姿态

- **所有者确认是生产晋升的显式批准条件。** 除 `confirmation: true` 外，`evolution_promote` 只返回等待确认，不写生产状态；自主观察者也只会停在 `candidate-awaiting-confirmation`。
- **自主 Trial 有硬约束。** 只有存在匹配的 `autonomousStrategies` 条目、同一失败模式达到 `patternThreshold`、且风险为 `low` 并配置为 `autonomousPolicy.low === "experiment"` 时，观察者才会启动隔离 Trial。`medium` 等待确认，`high` 阻止；修改策略不能放宽这两级，自定义风险字符串也不会启动实验。
- `mode`（默认 `advisory`；可用 `manual` / `advisory` / `autonomous`）和 `unattended`（默认 `false`）会记录在策略报告中，但**不是自主观察者的前置开关**。
- 任何模式都不能绕过晋升门禁或所有者确认；Trial 不直接改写生产 composition。

## 无模型的经验积累与按需检索

失败和观测由事件进入失败记忆与 canonical knowledge，不需要模型或轮询。`agent/error` 与 `tools/result` 事件可关联到 target；事件桥以带 MAC 的签名 JSONL 保存事实，诊断可识别同 id 冲突 MAC、重复事件和截断尾行。

原始错误文本不会写入领域存储或工具输出。失败记录、实验档案、事件桥与运行时报告使用 `errorCode`、`errorCategory`、`errorDigest`（`sha256:` 加 16 位十六进制）和脱敏短摘要 `errorSummary`（最多 240 字符，并记录原始长度）。

经验检索只由 `evolution_propose` 和带 `query` 的 `evolution_history` 触发；自主观察者提交 proposal 时走同一入口。inspect、measurement、canary、定时器、轮询和后台模型回合都不会单独触发检索。检索只读：结果由已知字段重建为副本并夹在上限内，不修改来源记录；读取失败会在 `unavailable` 中显式报告，不伪装成没有历史。

结果包含三类事实：

| 组 | 内容 |
| --- | --- |
| `resolved` | 已解决的问题与既有结论 |
| `failures` | 已失败的做法 |
| `candidates` | 已测量成功且带策略的候选 |
| 附加信息 | `duplicate` 报告同 target 的精确历史重放；`advice` 只复述记录事实 |

只有归一化描述和完整结果 / 测量集合相同的记录才合并；任何结果或计数不同仍是不同事实。精确 `knowledgeKey` 重放优先于普通文本匹配，且不受文本扫描窗口限制，但仍计入每来源条数上限。`duplicate.occurrences` 取同 key 快照的最高记录次数，不累加；`firstSeen` 取最早时间，`lastSeen` / `state` / `outcome` 取最新快照。来源内重复计入 `sources[].duplicates`，总重复数计入 `counts.duplicates`；`counts.matched` 是去重后进入最终阶段的候选数。排序按匹配覆盖度、成功率、实测 fitness 与证据量级加权评分（最高 0.95），评分是单条记录与匹配覆盖度的纯函数，不读时钟或其它记录；每来源保留与最终排序使用同一比较器，因此结果不受来源顺序影响。同分时按 `lastSeen` 降序，再按与 locale 无关的完整排序键排序。`truncated` 表示返回组未覆盖全部不同候选，或来源在最终合并前丢弃过候选（`sources[].dropped`）。

上限集中由 `lib/experience-recall.js` 管理；调用方只能收紧，不能放宽。

| 上限 | 值 |
| --- | ---: |
| 每组返回条数 | 3 |
| 每个来源贡献条数 | 12 |
| 单个内容字段长度 | 160 字符 |
| 证据引用数 | 2 |
| 普通文本匹配扫描范围 | 最近 2000 条 |
| 建议条数 / token 数 / 引用长度 | 3 / 48 / 96 |

来源标识 `source` 和字符串 `key` 按原值带过，其长度由来源决定；其他投影字段会被重建和限制。来源错误的摘要最多 64 字符，另以 `sourceErrors` 报告分类与指纹。

## 无模型诊断

`evolution_doctor` 会话工具与 `dsh-evolution-doctor` / `doctor.mjs` CLI 使用同一套检查和分级，不依赖模型推理、不联网、不上传 Evolution 数据。CLI 没有实时 Cordis context，`runtime.capabilities`、`runtime.registration` 和 `runtime.internal-api` 会标为 `not-evaluated`；具体接口探针须在会话内检查。

| 覆盖组 | 检查内容 |
| --- | --- |
| 宿主 | CLI、版本与模块、安装、官方 composition |
| 运行时 | 能力、10 个工具的注册、Cordis / Include 接口探针 |
| 数据与状态 | 数据根、key、target claim、memory、档案、事件桥 MAC、domain 聚合 / staging / 锁、旧 Dockyard 状态 |
| 迁移与晋升 | migration manifest；journal、composition、pointer |
| 插件与能力 | 插件目录、包、patch、支持矩阵、legacy adapter、已知限制 |

分级含义：

| level | 含义 |
| --- | --- |
| `ok` | 已验证健康 |
| `degraded` | 仍可用，但有已命名的有界限制或可安全恢复状态 |
| `blocked` | 关键保证无法满足；不要继续破坏性流程 |
| `not-evaluated` | 当前模式无法观测；会列入 coverage，不会静默跳过 |

表格是覆盖组概览；以报告 `coverage` 和每项检查的 `id` 为准。

CLI 退出码：`0` 健康、`1` 存在降级项、`2` 存在阻塞项、`3` 参数解析或诊断执行本身出错。报告写入 stdout；本地绝对路径只出现在本地报告中。

## 快速开始

从 GitHub Release 下载 tarball 和校验文件：

```sh
RELEASE_URL=https://github.com/ryukeilee/dsh-evolution/releases/download/v0.2.0-rc.19
curl -fL "$RELEASE_URL/dsh-evolution-0.2.0-rc.19.tgz" -o dsh-evolution-0.2.0-rc.19.tgz
curl -fL "$RELEASE_URL/SHA256SUMS" -o SHA256SUMS
sha256sum --check SHA256SUMS
```

macOS 可用 `shasum -a 256 -c SHA256SUMS` 校验。也可用 GitHub CLI 下载同一 Release 的 tarball、`SHA256SUMS` 与 `manifest.json`。校验通过后，用官方 CLI 安装：

```sh
DSH_HOME=/isolated/home dsh plugin --profile web add ./dsh-evolution-0.2.0-rc.19.tgz
DSH_HOME=/isolated/home dsh web --no-open
```

安装后 bundle 会登记在官方 profile 的 `dsh.profile.bundles`，随 profile 加载，无需每个 session 手工挂载 preset。下面用 `$DSH_HOME/profiles/web` 指代 `web` profile 的安装目录。首次诊断：

```sh
node "$DSH_HOME/profiles/web/node_modules/dsh-evolution/scripts/doctor.mjs" --home "$DSH_HOME" --profile web
```

最短会话闭环：

```text
evolution_runtime_inspect → evolution_propose → evolution_trial
→ evolution_measure → evolution_revert（放弃）
                     或 → evolution_promote → evolution_canary_observe（采纳）
```

## 配置

配置通过 profile patch 传入，均可选。默认值与约束如下：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `dataRoot` | `$DSH_HOME/storages/evolution` | Evolution 数据根 |
| `mode` | `"advisory"` | `manual` / `advisory` / `autonomous`；旧写法 `autonomous: true` 等价于 `autonomous`；只记录在策略报告 |
| `unattended` | `false` | 记录在策略报告，不是自主观察者的前置开关 |
| `autonomousPolicy` | `{ low: "experiment", medium: "confirm", high: "deny" }` | `medium` / `high` 为硬约束，不能经配置放宽 |
| `experienceRecall` | `true` | 仅 `false` 会整体关闭按需检索 |
| `domainSeed` | `false` | 显式授权载入已迁移的 `dockyard/state.json` 种子 |
| `canaryWindow` | `2` | canary 需要的屏障数 |
| `patternThreshold` | `3` | 相同失败模式成为候选的观测次数，下限 2 |
| `promotionLockTtlMs` | 15 分钟 | 晋升跨进程锁 TTL，下限 1000ms |
| `autonomousStrategies` | 未配置 | 显式策略表；提供失败模式对应的 `target` / `composition` / `measure` / `risk` |
| `memoryMaxEntries` / `memoryMaxText` / `memoryMaxItems` | `200` / `1200` / `8` | 有界失败记忆容量 |

## 使用

### CLI 诊断

```sh
# 只读诊断
node "$DSH_HOME/profiles/web/node_modules/dsh-evolution/scripts/doctor.mjs" --home "$DSH_HOME" --profile web

# 只应用报告标记为可恢复且幂等的修复，再重新验证
node "$DSH_HOME/profiles/web/node_modules/dsh-evolution/scripts/doctor.mjs" --home "$DSH_HOME" --profile web --repair
```

官方 CLI 安装的包也会在 profile 的 `node_modules/.bin/` 下生成 `dsh-evolution-doctor`，它与 `scripts/doctor.mjs` 是同一个入口；上表路径是验收脚本实际执行的那一条。

可选参数：`--home`、`--profile`、`--data-root`、`--dsh-cli`、`--json`、`--repair`、`--no-composition`、`--quiet`、`--help` / `-h`。`--repair` 只处理 `recoverable=true` 且有 repair 定义的项目；`recoverable=false` 项目不会自动修改。

所有 repair 都是幂等操作；损坏或未知状态不会通过 repair 猜测、合并或删除现场。

### 会话内

按上面的生命周期顺序调用工具；随时可调用 `evolution_doctor`。系统提示词要求不得在没有根因实验时把一次错误观测变成永久规则。

### 旧数据迁移

把旧 preset 和 Dockyard 快照导入新的数据根：

```sh
node scripts/import-evolution-data.mjs \
  <old-preset-root> \
  "$NEW_HOME/storages/evolution" \
  <dockyard-evolution-snapshot-dir>
```

迁移会先取得锁，再暂存和逐文件 SHA256 校验，最后原子发布；manifest 保存 `importId` 与不可变来源副本。锁内会重读完成态：另一导入仍持锁时直接失败；对方已完成时返回 `already-imported`，不会留下第二份 staging。重复执行不追加或覆盖运行后的数据；来源不一致或迁移期间发生变化会拒绝。含未完成 promotion journal 的来源必须先显式恢复。

已有 `*.migration.lock` 不会被替换；释放时只删除本次导入创建的锁，若锁被其他进程替换则保留并报告。

### 升级、回滚与卸载

```sh
# 升级到新版本 tarball
DSH_HOME=/isolated/home dsh plugin --profile web add ./dsh-evolution-<new>.tgz

# 回滚到旧版本 tarball
DSH_HOME=/isolated/home dsh plugin --profile web add ./dsh-evolution-<old>.tgz

# 卸载前停止应用
dsh plugin --profile web remove dsh-evolution
```

升级只替换插件包；Evolution 数据、`promoted.cordis.yml`、promoted 子插件源码、archive 和 evidence 保留。回滚旧插件包不会自动撤销已 stable 提交的 promotion。残留的 `prepared` / `committing` journal 会按边界校验回滚；`stable-committed` / `committed` 只清理 journal。stable commit 后若要移除 composition 引用，需人工处理后重启。卸载不删除用户数据；官方 pluginManager 禁用 / 启用可热切换或要求重启，dispose promoted 子 Fiber 时 composition、源码和档案仍保留。

## 数据根与状态处置

默认数据根为 `$DSH_HOME/storages/evolution`。主要文件包括 `event-bridge.key`、`execution-events.jsonl`、`evolution-memory.json`、`promoted.cordis.yml`、`EVOLUTION.md`、`promoted/`、`archive/experiments/`、`promotion/`、`promotion.lock`、`ownership/`、`dockyard/`、`domain-staging/`、`domain-archive.lock`、`migration-manifest.json` 和 `official-runtime-baseline.json`。领域聚合名为 `evolution_domain`，位于 `$DSH_HOME/storages/evolution_domain.json`。

`event-bridge.key` 仅当路径不存在时由运行时以 `wx` 创建（`0600`）；创建失败时只清理由本次创建且未写成的条目。已有非法密钥会拒绝启动，永不替换。禁用、卸载和 doctor 都不会删除或改写密钥。Doctor 只报告状态，不会修复 claim 或 key。

| 状态 | 处置 |
| --- | --- |
| journal `prepared` / `committing`，边界校验通过 | 从 journal 备份回滚，采用 CAS，不覆盖并发修改；doctor `--repair` 或下次启动处理 |
| journal `canary-observing` | doctor 报 `degraded`、`recoverable=false`，不提供 repair；保持观察状态，重启后继续推进屏障，或显式回滚 |
| journal `stable-committed` / `committed` | 只清理 journal，不改 composition 或已提交插件 |
| journal `rollback-failed`、无法解析或边界拒绝 | `blocked`，不自动处理，保留现场 |
| journal 阶段未知或缺失，边界校验通过 | `blocked` / `state-unknown`，不提供 repair；启动恢复和 canary 读取同样拒绝，保留 journal、备份、目标文件和 staging |
| 晋升因外部并发修改 EVOLUTION.md / 归档而拒绝覆盖 | 保留 journal；本实验 `exp-*.md` 不改写，脱敏失败证据写入同目录 `<experimentId>.failure.json` |
| promotion 目录存在但没有可读 `journal.json` | 启动被阻断；人工检查 composition 与 promoted 目录后决定保留或移走，插件不会删除目录 |
| event bridge 有未闭合尾行 | repair 只丢弃不构成记录的尾部字节；执行前重读并校验计划条件，准备期间变化则跳过。完整行都没有时不提供 repair；最后一次重读与 rename 之间的追加仍可能被丢弃，建议宿主停止时执行 |
| 活动档案文件末尾没有换行 | 下次追加前逐字节复制残片到同目录 `state.json.<collection>quarantine-archive.jsonl`，再原子重写活动档案，只留完整行。隔离文件 append-only、不由插件删除；其不可解析行会使 `state.archives` 报 `degraded`，由人处置 |
| 冷档案中段或 sealed 段有不可解析行 | `state.archives` 报 `degraded`，保留原字节；`archiveIntegrity()` 分类故障，`verifyConsistency()` 返回 `archive_bytes_unreadable`，`reconcile()` verifier 失败并回滚自身改动，需人工处置 |
| domain 孤儿 staging | 仅在聚合完整校验通过且无进程持有 archive 锁时清理；聚合、pending 记录或锁无法验证时拒绝 |
| domain archive 锁无主（不可读且超过 settle 窗口，或指向已死 pid） | 运行时按同一协议回收；repair 也使用设备号、inode、字节围栏和 rename 隔离。有活主不抢占；符号链接、目录等非普通条目只报告、不 repair |
| target claim | 同一 `experimentId` 的 claim 在分类前直接采纳；其余 0 字节、半截 JSON、外地主机或缺 hostname / pid 的 claim 只报告，不删除、不改写、不提供 repair。没有“创建时捕获身份、使用前再证明”协议，0 字节文件可能仍对应已取得独占句柄的进程；删除会造成两个实验同时持有同一 target |
| `event-bridge.key` 缺失、0 字节或不是 64 位小写十六进制 | doctor 只报告；路径缺失时下次启动创建，已有非法密钥永不替换。`data.key` 列出 `execution-events.jsonl`、domain `applied` / `pending.applied`、checkpoint 与临时文件；只有 ENOENT、0 字节普通文件或完整校验且 marker 为 0 的聚合可证明没有 MAC 产物。能证明没有 MAC 时由操作者按诊断指引处置空 / 坏文件；仍有 MAC 或无法证明时从备份恢复原密钥 |
| failure memory 损坏 | 不删除；报告 `degraded`，下次启动隔离并保留原字节 |
| domain 聚合、事件 MAC 或不可变迁移证据损坏 | 报 `blocked`，不重写、不猜测、不合并 |

未知或损坏的持久状态不会被猜测、静默合并或删除。journal 阶段的判定由启动恢复、canary 读取和 doctor 共用；见上表。

## 已知限制

以下边界是显式记录在产品行为里的，不通过隐藏 patch 绕过。完整清单与剩余发布风险见 `COMPATIBILITY.md` 与 `RELEASE.md`。

1. **领域 evaluator 仍是 advisory。** `promotionGates` 是生产权威；领域 evaluator 提供记录在案的决策与“识别到 regression 即否决”的硬性 veto，但本插件尚未接入宿主提供的独立生产 baseline/test 指标。因此只有自定义指标时 evaluator 会返回 `reject`（不阻塞），真实独立指标接入待补。
2. **`continuous/` 与 `governance/` 领域模块已提取并单测通过，但未接入 orchestrator 实时循环。** 它们是纯领域实现，当前不启动第二套 Engine 或 scheduler；旧 `dockyard` 数据以文件形式完整保留，可用 `domainSeed` 载入。
3. **晋升是 Host-only，且不是安全沙箱。** 只有持久化晋升拒绝带 `client` 的 Package（`evolution_trial` 允许 Client half）；持久化源码走合作式 `Function(hostCode)()` gate，始终需要可信审批。
4. **依赖内部 / 未文档化宿主接口。** introspection 使用 `ctx.registry.values()`、`ctx.reflect.props/_getImpl()`、`ctx.events._hooks`、Fiber effect 元数据；Include adapter 使用公开但未文档化的 `root.data` / `store` / `Entry.fiber` / `Fiber.state` / `ctx.get()`。这些不是稳定跨版本公共契约，升级 DSH 前必须重新验收；`runtime.internal-api` 会逐探针报告可用性，缺失时降级为 `degraded`。
5. **手工 dispose 底层 bundle Fiber 的路径无法自我断言。** `disposeTrial` 走官方 runner 的 stop/undefine；直接 dispose bundle Fiber 会让探针自身注入的 `tools` 失活，因此不作为用户关闭流程。
6. **Trial 期间持续存在的外部漂移会拒绝恢复。** 恢复签名比较前后可观察清单，不重建基线，因此不能记录已自行恢复的瞬态漂移，也不能证明任意合作式代码或 disposer 的全部外部效果。
7. **事件签名密钥没有轮换 / 吊销流程。** `event-bridge.key` 只在该数据根首次创建，禁用与卸载都不会删除。
8. **file 后端的失败记忆是 last-writer-wins，`save()` 不做 fsync。** 同一数据根下两个 host 实例同时归档时，后写者会覆盖整份快照；断电时最后一次 `record()` 可能丢失。跨进程锁保护领域归档事务，不保护这个文件。它是有界、advisory 的失败记忆（`promotionGates` 仍是生产权威），单实例使用不触发。
9. **指标 ID 不是授权凭证。** 兜底 ID 使用 `crypto.randomUUID()`，同一记录只生成一次；调用方仍可提供 ID，不能把可猜测或不可猜测的 ID 当作权限控制。
10. **不提供供应链签名。** 未做 npm 发布、代码签名 / provenance（SLSA）或 SBOM；已启用 GitHub Code Scanning。
11. **宿主版本只在验收后扩展。** 列表之外的宿主由 `host.version` 报 `blocked`，不使用宽松范围绕过诊断阻断。
12. **`0.2.1-alpha.1` 与 `0.2.1-rc.2` 的 npm dist-tag 会移动。** 验收记录精确版本号。这里的日期取自一次历史验收运行写下的 `startedAt`（2026-10-17，当时该证据记录的候选是 `0.2.0-rc.13`）；`docs/evidence/dsh-0.2.1-rc.2.json` 每次重新固定都会重跑重写，当前 `startedAt` 已不是该日期。该日期查询 npm registry 得到 `alpha` 指向 `0.2.1-alpha.5`、`latest` 指向 `0.2.0-rc.2`、`next` 指向 `0.2.1-rc.2`。这些 tag 值不在验收证据中，是该日期对 registry 的只读快照；tag 后续会移动，仓库声明的仍是三个精确版本号。
13. **冷档案读取缓存依赖文件系统的纳秒 mtime，并占用内存。** 解析结果按“设备 + inode + 字节数 + 纳秒 mtime”缓存；在 mtime 精度只有秒级的文件系统上，同尺寸原地重写可能读不到新内容（插件自己追加会改变字节数，不受影响）。常驻成本约 **0.7 MiB heap / MiB 冷档案**（例如 28 MiB 冷档案约 20 MiB）；`compact()` 后丢弃重建。数字、假设和复现脚本见 `RELEASE.md` 第 6 节第 20 条与 `docs/performance/archive-read-cost.md`。
14. **只带显式 `knowledgeKey`、没有任何身份维度的知识事件会塌缩到同一个身份。** 已知、本轮未修：六个维度全空时身份落在常量桶（`knowledge:a615…`），不同显式 key 会合并成一行。本插件所有生产写入路径都会同时给出维度，所以普通使用遇不到；只有外部代码直接调用 `EvolutionMemory.recordKnowledgeEvent()` 且只给 `knowledgeKey` 时会触发。修复会改变持久化身份语义（需要迁移决策）并改动冻结身份基线。
15. **UTF-16 长度超过 240 的身份维度会得到新身份。** 旧实现按 UTF-16 code unit 只保留前 239 个单位（还会切在代理对中间），因此后缀不同的事实会被合并。现在前缀按 code point 切，并附完整文本的 16 位摘要；这类事实会被区分，旧行保留到 retention 到期。归一化后 UTF-16 长度 ≤ 240 的维度逐字节不变、身份不变；长度 > 240 时身份改变：code point 数 ≤ 240 时整段保留，> 240 时保留前 222 个 code point 并附 `…#` 与 16 位十六进制摘要，结果总长 240 个 code point。因此既有记录的身份、命中与保留结果只在后一类维度上变化。
16. **执行事件日志与领域标记表随历史单调增长；回收是显式 owner 操作，不自动运行。** `execution-events.jsonl` 每个执行事件一行（含 measurement / promotion / canary 事实），领域文档的 `applied` 每个去重身份一个 64 位十六进制 MAC（上限 9 类事件 × experiment 数）。代价是：启动时按日志字节线性读取并逐条验签，`flush()` 每个 pass 读取并 HMAC 整份已提交前缀并对整张标记表重算摘要，领域文档随标记数增长。`evolution_maintain` 是唯一的回收入口：`dryRun` 只报告字节与记录数，`confirmation: true` 才执行。归档侧沿用既有语义压缩（终态记录折叠为聚合行），被替换的 sealed 段以 `pending.files` 的 `removed` 条目在同一事务里发布，**只有新文件全部安装成功之后才删除**；日志侧先把被丢弃记录携带的 promotion / measurement 事实写进 evidence sidecar（`*.evidence.json`，hydration 链中优先级高于事件桥），再提交裁剪后的 marker 与 `retention` floor（被裁 marker 的 keyed 链、累计的裁剪数与被丢弃字节/记录数、原文件摘要 `prior`、保留尾部摘要 `tail`），最后才截断那些已证明被吸收的字节。顺序是安全论证的一部分：**先提交 floor、后截断**。floor 记录计划时整份日志的摘要（`prior`）与截断后保留前缀的摘要（`tail`），所以“floor 已提交、截断未发生或被打断”是一个可以由下一次 replay 幂等完成的已提交事务（先核对 `prior` 再重写，再核对 `tail`），不会变成永久拒绝；反过来（先截断、后提交）会让 floor 描述已经不存在的字节，第二次回收崩溃后无法恢复。replay 只信任 floor 描述的字节：日志必须要么以保留尾部开头（`continuation`），要么**恰好**是 floor 记录的 `prior` 文件（此时先幂等完成那次已提交的截断）。两者都不是时以 `E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH` 拒绝吸收，而不是重放可能已裁剪 marker 的记录——空文件也一样：空日志不能证明保留字节没有丢，而接受它会让下一次追加造出永远对不上 floor 的头部，所以这里直接失败、把现场留给操作者（恢复那段保留字节，或换一个数据根）。

回收后的已知边界：领域文档带 `retention` 键，旧版本插件的严格 schema 会拒绝它，所以**回收后不要降级到旧版本**（先回滚再回收，或回收后不要回滚）；被裁 marker 的 eventId 不再参与重放冲突检测：同一身份重新发出时领域 ledger 以新 MAC 重新吸收，而内存 marker 窗口仍按 id 把它当重复，记录效果不会重复应用（不再抛冲突）；段目录里 `.tmp` 形状的 seal 残件会被保留、不进事务；doctor 的 `state.retention-floor` 与运行时共用只读分类，检查已提交（含 pending）的 floor：正常保留尾部为 ok、待截断原文件为 degraded，缺失或摘要不匹配为 blocked，不提供猜测式 repair；floor 自身不自洽（有被裁 marker 却没有链、链与零被裁数矛盾、累计丢弃字节小于最后一次丢弃、`prior` 与 `tail` 摘要相同）或 pending floor 落后于已提交 floor 时先报 `floor-inconsistent`（blocked，附 `floorProblems`），并在证据里给出 floor 计数器投影、floor 来源与仅报告不删除的回收临时残件。seal 临时残件由 `state.archives` 报告为 degraded 并保留。二次回收必须先补完上一轮已提交截断并验证保留尾部；**已补完的 floor 不需要 append lock**，所以无关的并发写者不会让启动重放或回收失败，只有确实需要补完时 append lock 竞争才以 `E_DOMAIN_EVENT_LOG_BUSY`（可重试）拒绝推进新 floor，dry run 则只读报告 `pending-truncation`；截断自身的其它失败保留原来的错误码，不会被伪装成锁竞争。没有任何定时器或后台任务调用回收；诊断仍由 `state.event-bridge` 报告 `bytes`、`lines`、`verifiedEvents`、`absorbedRecords`、`unabsorbedRecords`、`oldestRecordAt`、`newestRecordAt` 让操作者先看增长与“已吸收 / 未吸收”的分布。实测数字、修复前三个阻塞的复核与收益边界分别见 `docs/performance/capacity-reclaim-20261027.md`、`docs/performance/retention-reclaim-blockers.md` 与 `docs/performance/capacity-reclaim-evaluation.md`。

## 验证与证据

仓库验证入口：

```sh
NODE_OPTIONS=--max-old-space-size=4096 npm test
npm run pack:check
npm run release:verify

# 在隔离 runtime / DSH_HOME 中执行真实宿主验收
npm run acceptance:host -- --host 0.2.0-rc.2 --out <evidence-path>
npm run acceptance:host -- --host 0.2.1-alpha.1 --out <evidence-path>
npm run acceptance:host -- --host 0.2.1-rc.2 --out <evidence-path>
```

`scripts/acceptance/run-host-acceptance.mjs` 按实际记录路径生成 21 个步骤：每个宿主包含官方安装、CLI doctor、核心 Trial / revert、pluginManager 禁用 / 启用、卸载与重装、升级 / 回滚，以及真实 promotion、跨重启 canary 和最终 doctor。固定证据中的每个宿主均为 21/21 步通过，最终诊断为 `healthy`。

覆盖分为 9 组：官方 CLI 只读诊断；核心 `inspect → propose → trial → measure → revert`（要求 Runtime 恢复并注册 10 个工具）；pluginManager 禁用 / 启用并验证 memory 字节不变；卸载、无插件启动、重新安装；重装后核心流程和已有 memory 保留；升级与回滚并验证工具和 memory 哈希；真实晋升进入 canary 且监听器跨进程重启存活；startup 提交 stable 并验证指标回归只回滚新候选；再次重启验证候选状态并以最终 doctor 收尾。

| DSH 宿主 | Cordis | Include | Loader | 验收 | 最终诊断 |
| --- | --- | --- | --- | --- | --- |
| `0.2.0-rc.2` | `4.0.5` | `1.0.10` | `1.0.6` | 21/21 | `healthy` |
| `0.2.1-alpha.1` | `4.0.5` | `1.0.10` | `1.0.6` | 21/21 | `healthy` |
| `0.2.1-rc.2` | `4.0.5` | `1.0.10` | `1.0.6` | 21/21 | `healthy` |

对应证据为 `docs/evidence/dsh-0.2.0-rc.2.json`、`docs/evidence/dsh-0.2.1-alpha.1.json` 与 `docs/evidence/dsh-0.2.1-rc.2.json`。表中的 `healthy` 指最后一步 `doctor-final`（exit code `0`）；同一文件的顶层 `doctor` 是更早的 CLI 诊断（运行时尚未创建数据根与密钥），记为 `degraded` 是因 `data.root` 与 `data.key` 两项，而不是 `runtime.*`：那三项在 CLI 下是 `not-evaluated`，而 `not-evaluated` 不计入状态判定。文件记录 `contentSha256`（内容）和 `tarballSha256`（实际安装字节），验收和固定点检查核对的是 `release/` 固定产物，不会因后续工作树修改而改写历史证据。验收里的数据保留检查比较 `evolution-memory.json` 的 SHA256，不是整个数据根的逐文件比较。

`npm run pack:check` 两种模式都执行 16 项检查。开发模式允许工作树是固定点的**已提交**后继（脚本会逐条点名与固定产物不同的文件），但分发文件存在**未提交**改动时一律失败；`--release` 则把“固定点描述自己的提交 / 工作树是固定点或已提交后继”换成更严格的“固定点固定本树内容 / 工作树构建出固定内容”。

源码贡献者可运行 `npm ci`、`npm run release:pack` 和 `npm run pack:check`。不同 Node / npm 的 tarball 压缩字节可能不同；需要跨环境比较本机重建内容时使用 `npm run release:verify -- dist/dsh-evolution-0.2.0-rc.19.tgz --content-only`。

## 相关文档

- `COMPATIBILITY.md` — 宿主接口审计、兼容矩阵与阻塞依赖
- `RELEASE.md` — 固定产物、验证命令、复现步骤与发布风险
- `CHANGELOG.md` — 版本变更记录
- `AGENTS.md` — 仓库开发约定与验证要求
