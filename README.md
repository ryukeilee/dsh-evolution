# dsh-evolution

**给 DSH 装上可验证、可回滚的自我进化能力。**

`dsh-evolution` 是一个独立的 DSH bundle：它让 Agent 能够在真实运行中的 Cordis Runtime 上做受控实验——提出改进、临时激活、测量收益、然后要么回滚、要么带着证据晋升为持久插件，并在升级出问题时自动退回上一个已知良好状态。

它不是 DSH 的 fork，也不是"自动改代码"的黑箱。DSH 主体保持官方原样，本插件通过官方 bundle / profile 机制加载，不修改官方源码、不向官方 `node_modules` 复制文件、不 patch 官方仓库。

- 包版本：**`0.2.0-rc.12`**（发布候选）
- 支持的 DSH 宿主：**`0.2.0-rc.2`** 与 **`0.2.1-alpha.1`**（精确列表，逐个通过真实安装验收）
- Node：`^22.19.0 || >=24.0.0`
- 分发形态：GitHub Release 上的 tarball，不发布 npm 包

---

## 1. 为什么需要它

让 Agent 改自己的运行时，通常会掉进三个坑：

1. **改了就回不去。** 一次实验性变更留在 composition 里，没人知道它是哪来的、为什么留下。
2. **没有证据就下结论。** "看起来更快了"被当成"确实更快了"，回归在下一个 session 才爆发。
3. **每次从零开始。** 同一个问题被反复提出、反复失败，历史经验从不参与决策。

`dsh-evolution` 把这三点变成机制：

| 问题 | 机制 |
| --- | --- |
| 变更无法撤销 | 实验先走 Trial：由官方 runner 动态激活临时 Cordis Package，回滚时 dispose 并**证明** Runtime 签名回到基线 |
| 结论没有证据 | 晋升必须同时满足 8 项门禁（真实收益、可测量证据、可重复、回归通过、可回滚、清理证据、无孤儿资源、运行时已恢复），缺一项即拒绝 |
| 无人把关就上生产 | `evolution_promote` 默认只返回"等待所有者确认"，必须显式传 `confirmation: true` 才会写入生产 |
| 晋升后突然崩 | 晋升后进入 canary 观察，跨重启验证启动、健康与依赖屏障；屏障上报告指标回归会触发自动回滚，且只回滚新候选 |
| 经验不留存 | 失败与观测在**无模型**参与下折叠为有界知识；提交 proposal 时可检索历史结论，避免重复踩坑 |
| 宿主 API 漂移 | 诊断逐项探测真实运行状态，缺什么报什么，绝不假装健康 |

## 2. 能力总览

### 2.1 受控进化生命周期

九个工具构成一条闭环，顺序由系统提示词强制：

```
evolution_runtime_inspect   读取真实 Cordis 运行时（组件/服务/工具/依赖/事件/动态 Plugin）
        ↓
evolution_propose           记录 why / target / impactScope / successMetrics / risk
        ↓                    返回附带的 experienceRecall（历史经验，见 2.3）
evolution_trial             通过 dynamicCordisRunner 定义并激活临时 Cordis Package
        ↓                    （Host half 必需；Client half 只在 Trial 中允许）
evolution_measure           记录观测（问题是否解决、副作用、性能、错误、可重复性、
        ↓                    回归、可回滚性、清理证据），并评估晋升门禁
evolution_revert            通过 Cordis dispose，验证 Runtime 签名回到基线
  或
evolution_promote           二次确认后写入持久 Plugin + archive 指针，进入 canary 观察期
        ↓
evolution_canary_observe    调用方在确定性屏障上报告启动/健康/依赖/指标结果并推进
        ↓                    canary；报告指标回归即自动回滚
（跨重启）启动屏障将候选提交为 stable，或回滚到上一个已知良好状态

evolution_history           读取有界领域历史；传 query 时返回同一套经验检索结果
evolution_doctor            无模型健康报告，分级给出结论与证据
```

设计约束：

- **不建第二套运行时。** 插件不创建自己的 registry、resolver、生命周期管理器或 effect tracker；Component / Service / Fiber / Effect / 事件监听 / Tool / Dispose 全部由 Cordis 拥有。
- **Trial 基线只捕获一次。** 恢复基线在 Trial 首次修改运行时**之前**同步捕获，且不在后续 inspect、measure 或清理时重建。因此 Trial 期间真实发生的并发漂移会让恢复校验失败：此时实验判为 `revert-failed`、目标锁保留、不会继续晋升。Trial 的 `define` / `run` 失败路径没有激活任何东西，会释放目标锁并丢弃该实验记录。
- **晋升写的是下一 session 的状态。** 提交先落 journal，再有备份、原子写入、reload/mount 校验；中断的事务在下次启动时按边界规则恢复或清理。

### 2.2 默认不会自己上生产

进化能力的真正闸门是**所有者确认**，不是模式开关：

- 生产晋升在任何模式下都要求 `evolution_promote` 的 `confirmation: true`；缺省或 `false` 只返回一次"等待所有者确认"的只读结果，不写任何生产状态。
- 自主观察者即使已经走完 propose → trial → measure，也**不会**把自己的观测变成生产批准：它返回的仍是 `candidate-awaiting-confirmation`，`automatic: false`。
- 自主观察者只在同时满足三条时才启动一次**隔离** Trial：配置了匹配的 `autonomousStrategies` 条目、同一失败模式的观测数达到 `patternThreshold`（默认 3）、且风险等级为 `low` 并保持 `autonomousPolicy.low === "experiment"`。风险分级在代码里是硬约束：`high` 一律阻止（`blocked-high-risk`）、`medium` 一律判定为等待确认，都与 `autonomousPolicy` 取值无关；自定义风险字符串只会得到"等待确认"或"策略阻止"，不会启动实验。所以默认值 `{ low: "experiment", medium: "confirm", high: "deny" }` 描述的是实际行为，而不是可通过配置放宽的旋钮。
- `mode` 默认 `advisory`（`mode: "autonomous"` 或历史写法 `autonomous: true` 会把 `evolution_runtime_inspect` 报告的策略标为 autonomous）；`unattended` 默认 `false`。这两个值会被记录在策略报告里，但**不是自主观察者的前置开关**——是否启动实验由策略表、`patternThreshold` 与风险等级决定。把它们读作"开关"会高估默认配置提供的保护；真正阻止自动上生产的是上面那条所有者确认。
- 每次实验都落在隔离路径里：Trial 由官方 runner 拥有生命周期，失败即 `revert` 并记录失败学习，不会直接改写生产 composition。
- 经验检索默认开启但只读，只由 `evolution_propose` / `evolution_history` 触发，`experienceRecall: false` 可整体关闭。

### 2.3 无模型的经验积累与按需检索

**日常积累不引入模型，也不轮询。** 插件通过官方事件把失败与观测折叠进 `EvolutionMemory` 和有界的 canonical knowledge（`state` / `lastOutcome` / `effectStats` / `trend` / evidence）：

- `agent/error` 与 `tools/result` 事件记录失败，并带上其适用的 target（scope），使同一 target 的失败可以跨会话检索。
- 事件桥写入带 MAC 的签名 JSONL；同 id 冲突 MAC、重复事件、截断尾行都会被诊断识别。
- 进入领域存储之前，原始错误文本会先被脱敏；领域 schema 在模块加载时按官方规则 fail-loud 校验。

**检索只由提交 proposal 的动作触发。** `evolution_propose` 在返回中附带 `experienceRecall`；`evolution_history` 传 `query` 时返回同一结果。`evolution_runtime_inspect`、measurement 与 canary 不触发检索，**任何定时器、轮询或后台模型回合也不会**。注意自主观察者新建提案时同样走 `evolution_propose`，因此那条路径也会检索——它不产生额外的、独立于提案的检索路径（单测直接断言检索调用次数）。

检索结果是三组有界事实：

| 组 | 含义 |
| --- | --- |
| `resolved` | 已解决的问题，优先复用其结论 |
| `failures` | 已失败的做法，换假设前不要重复 |
| `candidates` | 已测量成功且带策略的复用候选 |

此外 `duplicate` 报告同一 target 的精确历史重放及其结果，`advice` 只复述记录中已有的事实。三组结果按**同一个**相关性-证据评分排序：该评分由匹配覆盖度、记录成功率、实测 fitness 与证据量级四项加权得出（最高值为四项权重之和 **0.95**，不是 1），是「记录 + 它自己的匹配覆盖度」的纯函数——不读时钟、不读其它记录；单来源 `maxRecords` 保留与最终排序用的是同一个值，所以一个来源留下的就是它自己按同一比较器排出的前 `maxRecords` 条，与来源顺序无关。仅当评分相同时才按 `lastSeen` 降序、再按与 locale 无关的完整排序键排序——该键按固定顺序逐字段长度前缀地编码**除 `score` 与 `exact` 外的全部报告字段**（六字段描述、`key`、`coverage`、`source`、`state`、`lastOutcome`、`successCount`、`failureCount`、`successRate`、`fitnessMean`、`regressionCount`、`occurrences`、`firstSeen`、`lastSeen` 与有界的 `evidenceRefs`），`score` 与 `exact` 除外是因为 `compareCandidates` 在读到该键之前就已用它们分出先后，两者不会以平局身份到达该键，因此输出不同的两条记录绝不相等，排序不可能退回来源合并顺序。精确 `knowledgeKey` 重放排在普通文本匹配之前，因此在 `maxRecords` 内优先占位，但该上限仍适用于它：超过 `maxRecords` 条的精确重放同样会被截断。只有描述（`problem` / `scope` / `strategy` / `failureMode` / `rootCause` / `prevention` 归一化后）与**整组已记录的结果/测量**（`lastOutcome`、`occurrences`、`regressionCount`、`successCount`、`failureCount`、`successRate`、`fitnessMean`）都相同的事实才会合并成一条：任何结果或计数不同都是另一条观测，绝不被合并丢掉。来源内合并数记在每个 `sources[].duplicates`，来源内加跨来源的合计记在 `counts.duplicates`，`counts.matched` 是去重后进入最终阶段的候选数。`duplicate.occurrences` 是同一 `knowledgeKey` 各快照中的**最高**记录次数，不是求和（每条精确记录都是同一 key 的快照，求和会把同一批事件重复计数），`firstSeen` 取最早、`lastSeen` / `state` / `outcome` 取最新快照。`truncated` 同时覆盖两种情况：返回的三组小于去重后的集合，以及任一来源在进入最终阶段前丢掉过候选——后者记在每个 `sources[].dropped`（来源自身 `maxRecords` 保留所致）。全部上限硬编码在 `lib/experience-recall.js`，调用方只能收紧不能放宽：

| 上限 | 值 |
| --- | --- |
| 每组返回条数 | 3 |
| 每个来源贡献条数 | 12（精确重放优先占位，仍受同一上限约束） |
| 单字段长度 | 160 字符 |
| 证据引用数 | 2 |
| 文本匹配扫描范围 | 最近 2000 条 |
| 建议条数 / token 数 / 引用长度 | 3 / 48 / 96 |

精确重放按 `knowledgeKey` 等值判断，**不受扫描窗口限制**——很久以前探索过的同一 target 仍能被识别，也不会被高分普通匹配挤出 `maxRecords`；但该上限本身仍适用于精确重放，超过 12 条精确重放时同样截断。检索只读：`finalizeExperienceRecall` 把每个来源交来的记录按已知投影字段**重建**成副本并夹到已声明上限内（六字段夹到 `maxText`、`state` / `lastOutcome` 夹到 40、计数经 `integer()`、日期经 `isoOrNull()`、`evidenceRefs` 去重并限制在 `maxEvidenceRefs` 条且每条不超过 `maxRefLength`），因此第三方 `domainStorage.recall()` 不能加宽它重建的那些字段、带出未声明字段，也不能让单个来源贡献超过 `maxRecords` 条不同事实；身份字段 `source` 与字符串 `key` 按原样带过，其大小由提供它们的来源决定，而不是由本模块限制；调用方传入的记录本身从不被改写。领域存储缺失或读取失败时降级为本地失败记忆，并在 `unavailable` 中显式报告，而不是伪装成"没有历史"。

### 2.4 无模型的健康诊断

`evolution_doctor` 工具与 `dsh-evolution-doctor` CLI 使用同一套检查项与分级规则，不依赖模型推理、不联网、不上传任何 Evolution 数据。两者覆盖面不同：CLI 没有实时 context，`runtime.capabilities` / `runtime.registration` / `runtime.internal-api` 会报 `not-evaluated`；要判断具体哪个内部接口探针失效，必须用**会话内**的 `evolution_doctor`。所有结论都来自真实运行状态并附可定位的 `evidence`，不是"配置项是否存在"。

覆盖面：

| 分类 | 检查项 |
| --- | --- |
| 宿主 | `host.cli` / `host.version` / `host.modules`（按 `peerDependencies` 逐模块校验，DSH 版本必须落在经过真实验收的列表中）/ `host.install` / `host.composition`（调用官方 `--dump-config` 校验 bundle 层与两个 loader 入口） |
| 运行时 | `runtime.capabilities`、`runtime.registration`（逐个用官方注册表解析全部 9 个工具）、`runtime.internal-api`（逐探针报告内部 API 可用性） |
| 数据与状态 | `data.root`、`data.key`、`state.memory`、`state.memory-quarantine`、`state.archives`、`state.event-bridge`（逐行 MAC 验证）、`state.domain`（schema 校验、pending 事务、孤儿 staging、损坏锁）、`state.dockyard-legacy` |
| 迁移 | `migration.manifest`（`importId` 自洽性、不可变来源是否被改、目标缺失、残留 staging） |
| 晋升 | `promotion.journal`（区分 `not-executed` / `incomplete` / `canary-observing` / `committed-pending-cleanup` / `rollback-failed` / `state-unknown`）、`promotion.composition`、`promotion.pointer` |
| 包与已知限制 | `plugin.home`、`plugin.package`、`plugin.patch`、`plugin.support-matrix`、`compat.legacy-adapters`、`capabilities.known-limits` |

上表是分组概览，不是完整清单：报告始终以 `coverage` 与各检查项的 `id` 为准。

分级语义：

| level | 含义 |
| --- | --- |
| `ok` | 已验证健康 |
| `degraded` | 仍可用，但存在有界、被命名的限制，或存在可安全恢复的状态 |
| `blocked` | 关键保证无法满足，不要在该状态下执行破坏性流程 |
| `not-evaluated` | 当前模式无法观测该事实（例如 CLI 模式下无法观测实时注册），报告会显式列出，绝不静默略过 |

`coverage` 分别列出已评估/未评估项；`degradedCapabilities` 单独列出已知的非阻塞能力限制。

### 2.5 安全边界

- **Host-only。** 晋升的持久化代码只接受 Host half；Package 带 `client` 时直接拒绝。
- **合作式执行 gate，不是沙箱。** 持久化源码通过 `Function(hostCode)()` 加载，只接受同步、独立返回 Cordis Plugin 的函数体；任何 `harness` token 保守拒绝。这是兼容性 gate，不是安全隔离——晋升执行需要可信审批。
- **trust-root 守卫。** `dsh-evolution/guard` 拒绝直接修改 Cordis trust root 与绕过 Cordis 生命周期的明确不可逆操作；普通 composition、promoted plugin、guard 与 orchestrator 本身的演进不受影响。
- **迁移与恢复不猜。** 未知或损坏的持久状态绝不静默合并、重写或删除现场；能修的项修复是幂等的，不能修的项报 `blocked` 并保留原字节。晋升 journal 的阶段判定只有一份（`classifyPromotionJournal`）：未知或缺失阶段在 doctor 里是 `blocked` / `state-unknown` 且不提供 repair，启动恢复与 canary 读取也以同一判定拒绝，journal、备份、目标文件与 staging 一律保留——见 6.1 的恢复表。

## 3. 典型使用场景

**场景 A — "这个功能让 Agent 变慢了，能不能换个实现？"**

Agent 用 `evolution_runtime_inspect` 读出让时延变高的组件，`evolution_propose` 记录目标与成功指标，`evolution_trial` 临时换上替代实现，`evolution_measure` 记录前后指标。收益成立且回归通过 → `evolution_promote`（带确认）进入 canary；屏障上报告指标回归 → 自动回滚，Runtime 回到基线。

**场景 B — "同一类失败反复出现。"**

失败在无模型参与下已被折进失败记忆与 canonical knowledge。下一次 `evolution_propose` 时会附带 `experienceRecall`：`failures` 直接列出"这条路径已经失败过"，`resolved` 给出可复用的既有结论。如果确实要重试，需要新的假设和新的证据。

**场景 C — "升级 DSH 之后插件突然不工作了。"**

先跑只读诊断：

```sh
# 不需要模型，也不需要应用正在运行
dsh-evolution-doctor --home "$DSH_HOME"
```

`host.cli` / `host.version` / `host.modules` / `host.install` / `host.composition` 会指出是宿主版本越界、某个宿主模块越界，还是安装与 compose 有问题。诊断只报告，不改动现场；只有 `--repair` 会处理报告标记为 `recoverable=true` 且幂等的项。

CLI 没有实时 context，因此 `runtime.*` 三项在 CLI 模式下报 `not-evaluated`。要知道具体哪个内部接口探针失效，在会话里调 `evolution_doctor`。

**场景 D — "晋升之后重启，谁来保证它还能起来？"**

晋升写入的是**下一个 session** 的持久 Plugin 行与 archive 指针，随后停留在 canary 观察期。重启时启动屏障会校验插件健康与依赖，并把结果作为一次 `startup` 屏障提交给 canary（这条路径固定传入 `metricRegression: false`）。健康或依赖不成立则回滚到上一个已知良好状态，且只回滚新候选。指标回归需要由调用方在显式屏障上报告——canary 不会自己去比较指标数值。

## 4. 安装

### 4.1 安装 DSH

用官方推荐方式安装 DSH（任一即可）：

```sh
npx @deepseek-ai/dsh web            # 官方推荐
# 或源码：pnpm install && pnpm run build
```

### 4.2 安装插件

从 GitHub Release 下载产物与校验文件：

```sh
RELEASE_URL=https://github.com/ryukeilee/dsh-evolution/releases/download/v0.2.0-rc.12
curl -fL "$RELEASE_URL/dsh-evolution-0.2.0-rc.12.tgz" -o dsh-evolution-0.2.0-rc.12.tgz
curl -fL "$RELEASE_URL/SHA256SUMS" -o SHA256SUMS
curl -fL "$RELEASE_URL/manifest.json" -o manifest.json

# 也可使用 GitHub CLI（公开仓库无需先 gh auth login）
gh release download v0.2.0-rc.12 --repo ryukeilee/dsh-evolution \
  --pattern 'dsh-evolution-*.tgz' --pattern 'SHA256SUMS' --pattern 'manifest.json'

# 校验：必须与本次下载的 SHA256SUMS 一致
sha256sum --check SHA256SUMS          # macOS：shasum -a 256 -c SHA256SUMS
```

用官方 CLI 安装（同一条命令也用于升级）：

```sh
DSH_HOME=/isolated/home dsh plugin --profile web add ./dsh-evolution-0.2.0-rc.12.tgz
DSH_HOME=/isolated/home dsh web --no-open
```

安装后官方 profile 的 `package.json` 会把 `dsh-evolution` 列入 `dsh.profile.bundles`，插件随 profile 加载，**无需每个 session 手工挂载 preset**。

从源码构建（贡献者）：

```sh
npm ci
npm run release:pack     # 生成 dist/
npm run pack:check       # 校验分发内容、兼容声明与发布固定点
```

> 本机构建的压缩字节与发布产物**允许不同**：`npm pack` 走 Node 自带 zlib，npm 10 与 npm 11 对完全相同的内容会产生不同的压缩字节。跨环境可比的是内容摘要——用 `npm run release:verify -- dist/dsh-evolution-0.2.0-rc.12.tgz --content-only` 核对。

## 5. 配置

配置通过 profile patch 传入，全部可选。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `dataRoot` | `$DSH_HOME/storages/evolution` | Evolution 数据根 |
| `mode` | `"advisory"` | `manual` / `advisory` / `autonomous`；历史写法 `autonomous: true` 等价于 `"autonomous"`。它记录在策略报告中，不是自主观察者的前置开关 |
| `unattended` | `false` | 与 `mode` 一起记录在策略报告中；不构成自主观察者的前置开关 |
| `autonomousPolicy` | `{ low: "experiment", medium: "confirm", high: "deny" }` | 按风险等级的策略。`high` 与 `medium` 是硬约束，改配置不会放宽它们；只有 `low` 能走到隔离实验，自定义风险字符串永远不会启动实验 |
| `experienceRecall` | `true` | 设为 `false` 整体关闭按需经验检索 |
| `domainSeed` | `false` | 显式授权把已迁移的 `dockyard/state.json` 种子载入领域聚合 |
| `canaryWindow` | `2` | canary 观察需要的屏障数 |
| `patternThreshold` | `3` | 同一失败模式达到多少次观测才成为候选 |
| `promotionLockTtlMs` | 15 分钟 | 跨进程晋升锁 TTL |
| `autonomousStrategies` | 未配置 | 按失败模式提供 `target` / `composition` / `measure` / `risk` 的显式策略表；没有匹配条目时观察者只停留在 `candidate` |
| `memoryMaxEntries` / `memoryMaxText` / `memoryMaxItems` | `200` / `1200` / `8` | 有界失败记忆的容量上限 |

### 5.1 数据边界

- 数据根默认 `$DSH_HOME/storages/evolution`。
- 事件签名密钥 `event-bridge.key` 只在该目录首次创建（`0600`），**禁用与卸载都不会删除它**。
- 官方 `ctx.storageDomain`（`backend: json`，root `$DSH_HOME/storages`）承载领域聚合元数据；领域名 `evolution_domain`（官方 `UNIT_NAME_RE` 不允许连字符）。
- 冷档案与轮转文件仍由插件文件后端写入 `<dataRoot>/dockyard`。
- 原始错误内容只经脱敏 DTO 进入领域存储。

## 6. 使用方式

### 6.1 命令行诊断

安装到 profile 后提供 `dsh-evolution-doctor`：

```sh
# 只读诊断；默认自动识别"在 dsh.profile.bundles 中列出 dsh-evolution"的 profile
<profile>/node_modules/.bin/dsh-evolution-doctor \
  --home "$DSH_HOME" [--profile web] [--dsh-cli <.../@deepseek-ai/dsh/lib/bin.js>] [--json]

# 等价写法
node <profile>/node_modules/dsh-evolution/scripts/doctor.mjs --home "$DSH_HOME" [--json]

# 只应用报告判定为"安全且幂等"的修复，然后重新验证
<profile>/node_modules/.bin/dsh-evolution-doctor --home "$DSH_HOME" --repair [--json]
```

参数：`--home`、`--profile`、`--data-root`、`--dsh-cli`、`--json`、`--repair`、`--no-composition`、`--quiet`、`--help` / `-h`。

退出码：`0` 健康、`1` 存在可降级问题、`2` 存在阻塞问题；参数解析或诊断执行自身抛错时以 `3` 退出。报告写入 stdout，本地绝对路径只出现在本地输出中，不会被上传。

`--repair` 只处理报告中 `recoverable=true` 且带 repair 的项；`recoverable=false` 的状态永远不会被自动改动。全部恢复操作都是幂等的。

| 状态 | 处理 |
| --- | --- |
| 边界校验通过的 journal `prepared` / `committing` | 从 journal 备份回滚（CAS 保护，不覆盖并发修改）；`--repair` 或下次启动自动完成 |
| 边界校验通过的 journal `stable-committed` / `committed` | 只清理 journal 目录，不动 composition 与已提交插件 |
| journal `rollback-failed` / 无法解析 / 边界拒绝 | **不自动处理**：报 `blocked`、`recoverable=false`，保留现场 |
| journal 阶段未知或缺失（边界校验通过） | doctor 报 `blocked` / `state-unknown`、`recoverable=false`、**不提供 repair**；启动恢复与 canary 读取用同一判定拒绝，journal、备份、目标文件与 staging 保持不变，必须人工检查现场 |
| event bridge 未闭合尾行 | 只丢弃不构成记录的尾部字节 |
| domain 孤儿 staging | 仅在无活进程持有 archive 锁时清理；有活进程时报告并拒绝 |
| domain archive 锁无主（空内容或死 pid） | 运行时自动回收；`--repair` 可显式清理；有活主的锁永不抢占 |
| 损坏的 failure memory | 不删除：报 `degraded` 并说明下次启动会隔离（quarantine）保留原字节 |
| 损坏的 domain 聚合 / 事件 MAC / 不可变迁移证据 | 报 `blocked`，不重写、不猜测、不合并 |

### 6.2 会话内

在 Agent 会话里按生命周期顺序调用工具即可；系统提示词已经写入了顺序与纪律要求（"不得在没有根因实验的情况下把一次观测到的错误变成永久规则"）。

推荐的最短闭环：

```
evolution_runtime_inspect → evolution_propose → evolution_trial
→ evolution_measure → evolution_revert        （放弃）
                     → evolution_promote → evolution_canary_observe   （采纳）
```

任何时刻都可以用 `evolution_doctor` 查看真实状态。

### 6.3 旧数据迁移

用 `scripts/import-evolution-data.mjs` 把旧 preset 与 Dockyard 快照导入新数据根：

```sh
node scripts/import-evolution-data.mjs \
  <old-preset-root> \
  $NEW_HOME/storages/evolution \
  <dockyard-evolution-snapshot-dir>
```

- 先暂存、逐文件 SHA256 校验、再原子改名发布；`migration-manifest.json` 记录 `importId` 与不可变来源副本。
- 重复执行返回 `already-imported`，不重复追加、不覆盖运行后数据。
- 来源内容与已导入根不一致时拒绝，防止静默合并；源文件在导入期间变化会被检出。
- 导入含未完成的旧 promotion journal 时拒绝，要求先显式恢复。

### 6.4 升级、回滚与卸载

```sh
# 升级到新版本 tarball
DSH_HOME=/isolated/home dsh plugin --profile web add ./dsh-evolution-<new>.tgz

# 回滚到旧版本
DSH_HOME=/isolated/home dsh plugin --profile web add ./dsh-evolution-<old>.tgz

# 卸载（先停止应用）
dsh plugin --profile web remove dsh-evolution
```

升级只替换插件包；数据根、`promoted.cordis.yml`、promoted 子插件源码、archive 与 evidence 全部保留。

回滚旧插件包**不会自动回滚**已稳定提交的 promotion composition。残留 journal 在边界校验通过后按阶段处理：`prepared` / `committing` 回滚，`stable-committed` / `committed` 只清理 journal。若 composition 引用了新版本独有的实现，需按 promotion 边界人工移除对应条目后重启——stable commit 之后没有 journal 的自动回滚不受支持。

卸载**不删除用户数据**。官方 `pluginManager.setBundleEnabled` 支持热禁用（实测 `applied`，插件工具与服务立即下线）或 `restart-required`；禁用或卸载父 bundle 会 dispose promoted 子 Fiber，而 composition、源码与档案保留。

## 7. 已知限制

以下边界是显式记录在产品行为里的，不通过隐藏 patch 绕过。完整清单与剩余发布风险见 `COMPATIBILITY.md` 与 `RELEASE.md`。

1. **领域 evaluator 仍是 advisory。** `promotionGates` 是生产权威；领域 evaluator 提供记录在案的决策与"识别到 regression 即否决"的硬性 veto，但本插件尚未接入宿主提供的独立生产 baseline/test 指标。因此只有自定义指标时 evaluator 会返回 `reject`（不阻塞），真实独立指标接入待补。
2. **`continuous/` 与 `governance/` 领域模块已提取并单测通过，但未接入 orchestrator 实时循环。** 它们是纯领域实现，当前不启动第二套 Engine 或 scheduler；旧 `dockyard` 数据以文件形式完整保留，可用 `domainSeed` 载入。
3. **晋升是 Host-only，且不是安全沙箱。** 只有持久化晋升拒绝带 `client` 的 Package（`evolution_trial` 允许 Client half）；持久化源码走合作式 `Function(hostCode)()` gate，始终需要可信审批。
4. **依赖内部/未文档化宿主接口。** introspection 使用 `ctx.registry.values()`、`ctx.reflect.props/_getImpl()`、`ctx.events._hooks`、Fiber effect 元数据；Include adapter 使用公开但未文档化的 `root.data` / `store` / `Entry.fiber` / `Fiber.state` / `ctx.get()`。这些不是稳定跨版本公共契约，升级 DSH 前必须重新验收；`runtime.internal-api` 会逐探针报告可用性，缺失时降级为 `degraded` 而不是假装健康。
5. **手工 dispose 底层 bundle Fiber 的路径无法自我断言。** `disposeTrial` 走官方 runner 的 stop/undefine；直接 dispose bundle Fiber 会让探针自身注入的 `tools` 失活，因此不作为用户关闭流程。
6. **Trial 期间持续存在的外部漂移会拒绝恢复。** 恢复签名是前后可观察清单的比较，不重建基线，因此不能记录已自行恢复的瞬态漂移，也不能证明任意合作式代码或 disposer 的全部外部效果。
7. **事件签名密钥没有轮换/吊销流程。** `event-bridge.key` 只在该数据根首次创建，禁用与卸载都不会删除。
8. **file 后端的失败记忆是 last-writer-wins，`save()` 不做 fsync。** 同一数据根下两个 host 实例同时归档时后写者会覆盖整份快照；断电时最后一次 `record()` 可能丢失。跨进程锁保护的是领域归档事务，不是这个文件。它是有界、advisory 的失败记忆（`promotionGates` 仍是生产权威），单实例使用不触发。
9. **指标 ID 不是授权凭证。** 兜底 ID 使用 `crypto.randomUUID()`，同一记录只生成一次；调用方仍可提供 ID，不能把可猜测/不可猜测的 ID 当作权限控制。
10. **不提供供应链签名。** 未做 npm 发布、代码签名 / provenance（SLSA）或 SBOM；已启用 GitHub Code Scanning。
11. **宿主版本只在验收后扩展。** 列表之外的宿主由 `host.version` 报 `blocked`，不用宽松范围绕过诊断的阻断。
12. **`0.2.1-alpha.1` 的 npm dist-tag 会移动。** 验收记录的是该精确版本号；上游把 `alpha` 指向新版本后，本仓库声明的仍是 `0.2.1-alpha.1`。

## 8. 验证与证据

本仓库的验收**由本仓库的脚本执行，证据随仓库分发**：

```sh
npm ci                       # 严格按 package-lock.json 安装
npm test                     # 仓库回归入口（Node 原生测试）
npm run pack:check           # 分发内容、权限、锁文件、文档一致性、发布固定点
npm run release:verify       # 固定产物：字节 sha256 + 内容摘要 + 条目 + 权限

# 真实隔离宿主验收（自包含：自己安装官方 DSH，使用独立 DSH_HOME）
npm run acceptance:host -- --host 0.2.0-rc.2 --out <evidence-path>
npm run acceptance:host -- --host 0.2.1-alpha.1 --out <evidence-path>
```

宿主验收脚本在临时目录里安装指定版本的官方 `@deepseek-ai/dsh`，在全新 `$DSH_HOME` 里用官方 `dsh plugin --profile web add` 安装 tarball，然后驱动真实宿主完成 21 步，覆盖：

1. 官方 CLI 只读诊断（`host.version` 必须 `verified: true`、状态不得为 `blocked`）
2. 核心流程 `inspect → propose → trial → measure → revert`（要求 `runtimeRecovered: true` 与 9 个工具全部注册）
3. 官方 `pluginManager` 禁用/启用语义，且 `evolution-memory.json` 逐字节不变（同时确认 `event-bridge.key` 仍存在）
4. 官方 CLI 卸载、插件缺席时宿主仍能启动、再重新安装
5. 重装后核心流程再次通过且原有 memory 条目全部保留
6. 升级与回滚流程，两步之后宿主仍注册 9 个工具且 memory 哈希不变
7. 真实晋升到 canary 观察期，监听器可被真实触发并跨进程重启存活
8. 重启后 startup canary 提交为 `stable`；新候选注入 `metricRegression` 触发 canary 回滚，且只回滚新候选
9. 再次重启后已提交候选仍存活、被回滚候选未复活，最终诊断 `healthy`

已验证结论：

| 宿主 | 宿主模块 | 结果 |
| --- | --- | --- |
| `0.2.0-rc.2` | cordis `4.0.4`、include `1.0.9`、loader `1.0.5` | 21/21 步通过，最终诊断 `healthy` |
| `0.2.1-alpha.1` | cordis `4.0.5-alpha.2`、include `1.0.10-alpha.2`、loader `1.0.6-alpha.2` | 21/21 步通过，最终诊断 `healthy` |

证据文件 `docs/evidence/dsh-0.2.0-rc.2.json` 与 `docs/evidence/dsh-0.2.1-alpha.1.json` 同时记录 `contentSha256`（内容）与 `tarballSha256`（实际安装的字节）。`pack:check` 与 `test/release-pin.test.mjs` 都会核对它们与发布固定点一致：**任何被发布文件的变化都会使 `pack:check` 失败，直到两个宿主的验收重新运行**。

验收断言的"数据保留"范围需要说清楚：生命周期、升级与回滚步骤比较的是 `evolution-memory.json` 的 SHA256 并确认 `event-bridge.key` 仍存在，**不是对整个数据根逐文件比较**。

发布产物、复现步骤与**尚未消除的发布风险**见 `RELEASE.md`；发布固定点见 `release/manifest.json`；CI 见 `.github/workflows/ci.yml`（单测矩阵、可复现打包与内容白名单、两个宿主的真实安装验收）。

## 9. 相关文档

- `COMPATIBILITY.md` — 宿主接口审计与分级、兼容矩阵、阻塞依赖
- `RELEASE.md` — 产物、校验命令、复现步骤、剩余风险
- `CHANGELOG.md` — 版本变更记录
- `AGENTS.md` — 本仓库的开发约定与验证要求
