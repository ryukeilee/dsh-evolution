# dsh-evolution

自我进化（Evolution）能力作为独立 DSH bundle 分发。DSH 主体保持官方原样，本插件通过官方 bundle / profile 机制安装，不修改官方源码、不向官方 `node_modules` 复制文件、不 patch 官方仓库。

本仓库是 `dsh-evolution` 的**唯一开发、测试与发布来源**；旧的 DSH 环境只作为历史迁移源和回滚基线，不再维护插件源码。

- 包版本：`0.2.0-rc.7`（本地候选，未发布）
- 支持的 DSH 版本范围：**`0.2.0-rc.2` / `0.2.1-alpha.1`**（精确列表）。`package.json` 的 `peerDependencies` 逐一列出经过真实安装验收的宿主版本，不通过 exemption 伪装其它版本兼容；列表之外的宿主由 `host.version` 报 `blocked`。
- Node：`^22.19.0 || >=24.0.0`（在当前验证环境为 `v26.11.1`，pnpm `11.26.0`）。

> 状态：官方 `0.2.0-rc.2` 与 `0.2.1-alpha.1` 上的完整验收均已完成并通过（干净 runtime 安装 / 官方 CLI 插件安装 / 启动 / 9 个工具注册 / 核心流程 inspect→propose→trial→measure→revert 且 disposer 恢复基线 / CLI 与最终 doctor / promotion 到 canary 并跨重启存活 / startup canary 提交 / canary regression 回滚 / 禁用启用 / 卸载重装 / 数据保留 / 不可兼容宿主阻断）。验收由本仓库的脚本执行，证据已入库：`docs/evidence/dsh-0.2.0-rc.2.json` 与 `docs/evidence/dsh-0.2.1-alpha.1.json`；复现方式、产物与**尚未消除的发布风险**见 `RELEASE.md`。本仓库的验证入口是 `npm test`，用户侧的可复现验证入口是 `scripts/doctor.mjs`（见第 5 节）。最后公开版本 `v0.2.0-rc.6` 的发布状态、CI 与发布后验收以 GitHub Release 及 `docs/evidence/rc6-release-audit.json` 为准；当前 `0.2.0-rc.7` 仅在本地构建与验收，未创建 tag 或公开发布。

## 1. 安装 DSH 与插件

新版 DSH 使用官方推荐方式安装（任一即可）：

```sh
npx @deepseek-ai/dsh web            # 官方推荐
# 或源码：pnpm install && pnpm run build
```

本插件的发布产物与其校验信息发布在 GitHub Release 上，并随仓库固定在 `release/`（见 `RELEASE.md`）。本仓库固定的本地候选版本是 `0.2.0-rc.7`，尚未公开发布；它修复失败记忆在损坏记录（含嵌套过深与 JSON 不可保真数值）、缺失身份、非字符串显式签名与时钟回拨下的启动失败、静默合并与丢失，保留此前的可靠性修复、性能、安全、恢复与回滚语义。发布前验证 tag、sourceCommit 的实际包内容、固定产物与校验和，发布后重新匿名下载并执行双宿主验收。最后公开 `v0.2.0-rc.6` 的审计保留在 `docs/evidence/rc6-release-audit.json`；卸载/重装后 memory 哈希变化的调查结论见 `docs/evidence/memory-hash-investigation.md`。

### 1.1 从公开 Release 安装（用户）

```sh
# 公开下载：无需 GitHub 仓库权限或登录
RELEASE_URL=https://github.com/ryukeilee/dsh-evolution/releases/download/v0.2.0-rc.6
curl -fL "$RELEASE_URL/dsh-evolution-0.2.0-rc.6.tgz" -o dsh-evolution-0.2.0-rc.6.tgz
curl -fL "$RELEASE_URL/SHA256SUMS" -o SHA256SUMS
curl -fL "$RELEASE_URL/manifest.json" -o manifest.json

# 也可使用 GitHub CLI；公开仓库无需先运行 gh auth login
gh release download v0.2.0-rc.6 --repo ryukeilee/dsh-evolution \
  --pattern 'dsh-evolution-*.tgz' --pattern 'SHA256SUMS' --pattern 'manifest.json'

# 校验：必须与本次下载的 SHA256SUMS 一致
sha256sum --check SHA256SUMS          # macOS：shasum -a 256 -c SHA256SUMS

# 安装 / 升级（同一条命令；官方 CLI 负责 bundle 选择与依赖安装）
DSH_HOME=/isolated/home dsh plugin --profile web add ./dsh-evolution-0.2.0-rc.6.tgz

# 启动
DSH_HOME=/isolated/home dsh web --no-open
```

> 历史 `v0.2.0-rc.1` 的 tag 与发布资产存在 provenance 不一致；原 tag 和附件保留，详情见 `RELEASE.md`。请使用当前通过验收的 `v0.2.0-rc.6`。

### 1.2 从源码构建（贡献者）

本地候选可用 `release/dsh-evolution-0.2.0-rc.7.tgz` 安装，校验信息见仓库的 `release/SHA256SUMS`；它与历史公开版本的下载校验信息不同。

```sh
npm ci
npm run release:pack     # 生成 dist/；本机构建的压缩字节受 npm 版本影响
npm run pack:check       # 校验内容白名单、权限、发布固定点（pin）
```

本机构建的字节**不保证**与发布产物相同（`npm pack` 的 gzip 输出随 npm 版本变化）；保证一致的是内容：用 `npm run release:verify -- dist/dsh-evolution-0.2.0-rc.7.tgz --content-only` 核对内容摘要。

安装后官方 profile 的 `package.json` 会把 `dsh-evolution` 列入 `dsh.profile.bundles`，插件随 profile 加载，无需每 session 手工挂载 preset。

## 2. 数据边界与配置

- 默认数据根：`$DSH_HOME/storages/evolution`，可用 profile patch 的 `dataRoot` 覆盖。
- 事件签名密钥 `event-bridge.key` 仅在该目录首次创建，不会被禁用/卸载删除。
- 官方 `ctx.storageDomain`（`backend: json`，root `$DSH_HOME/storages`）承载领域聚合元数据；领域名 `evolution_domain`（官方 `UNIT_NAME_RE` 不允许连字符）。冷档案/轮转文件仍由插件文件后端写入 `<dataRoot>/dockyard`。
- 领域 schema 在模块加载时按官方 `defineDomain` 规则 fail-loud 校验（名称、表名、禁止 nullable global）。原始错误内容只经脱敏 DTO 进入领域存储。
- `domainSeed`（默认 `false`）：显式授权把已迁移的 `<dataRoot>/dockyard/state.json` 种子载入领域聚合。默认关闭，避免误读旧环境。

## 3. 旧数据迁移

使用 `scripts/import-evolution-data.mjs` 把旧 preset 与 Dockyard 快照导入新数据根：

```sh
node scripts/import-evolution-data.mjs \
  <old-preset-root> \
  $NEW_HOME/storages/evolution \
  <dockyard-evolution-snapshot-dir>
```

- 先暂存、逐文件 SHA256 校验、再原子改名发布；`migration-manifest.json` 记录 importId 与不可变来源副本。
- 重复执行返回 `already-imported`，不重复追加、不覆盖运行后数据。
- 来源内容与已导入根不一致时拒绝，防止静默合并；源文件在导入期间变化会被检出。
- 导入含未完成的旧 promotion journal 时拒绝，要求先显式恢复。

## 4. 升级与回滚

```sh
# 升级到新版本 tarball
DSH_HOME=/isolated/home dsh plugin --profile web add ./dsh-evolution-<new>.tgz

# 回滚到旧版本
DSH_HOME=/isolated/home dsh plugin --profile web add ./dsh-evolution-<old>.tgz
```

- 升级只替换插件包；数据根、`promoted.cordis.yml`、promoted 子插件源码、archive/evidence 全部保留。
- 回滚旧插件包后，已提交的 promotion composition 会在启动时按 journal 恢复；若 composition 引用了新版本独有实现，需按“promotion”边界人工移除对应条目后重启（stable commit 后没有 journal 的自动回滚不受支持）。
- 官方 `pluginManager.setBundleEnabled` 支持热禁用（当前实测 `applied`，插件工具/服务立即下线）或 `restart-required`；两种语义都由官方决定，插件不假设。
- 卸载：停止应用后 `dsh plugin --profile web remove dsh-evolution`。卸载不删除用户数据。

## 5. 统一诊断入口（不需要 LLM）

插件提供一个不依赖模型推理、不联网、不上传任何 Evolution 数据的诊断入口；所有结论都来自真实运行状态，并带可定位的 `evidence`，不是“配置是否存在”。

### 5.1 命令行（应用未运行也可用）

安装到 profile 后会提供 `dsh-evolution-doctor` 命令；也可以直接用 node 运行脚本：

```sh
# 只读诊断；默认自动识别“在 dsh.profile.bundles 中列出 dsh-evolution”的 profile
<profile>/node_modules/.bin/dsh-evolution-doctor \
  --home "$DSH_HOME" [--profile web] [--dsh-cli <.../@deepseek-ai/dsh/lib/bin.js>] [--json]

# 等价写法
node <profile>/node_modules/dsh-evolution/scripts/doctor.mjs --home "$DSH_HOME" [--json]

# 只应用报告判定为“安全且幂等”的修复，然后重新验证
<profile>/node_modules/.bin/dsh-evolution-doctor --home "$DSH_HOME" --repair [--json]
```

- 退出码：`0` 健康、`1` 存在可降级问题、`2` 存在阻塞问题。
- 报告写入 stdout，本地绝对路径只出现在本地输出中，不会被上传。
- `--repair` 只处理报告里 `recoverable=true` 且带 `repair` 的项；`recoverable=false` 的状态永远不会被自动改动。

### 5.2 会话内（真实运行时）

`evolution_doctor` 工具返回同一份报告，并在真实宿主中核对：必需服务（`tools` / `storageDomain` / `dynamicCordisRunner` / `systemPrompt` / `loader`）、全部 9 个工具的注册状态（逐个用官方注册表解析）、内部/实验性 introspection API 的可用性、promotion Include 适配器方法、数据根与跨进程锁。

### 5.3 分级与覆盖

| level | 含义 |
| --- | --- |
| `ok` | 已验证健康 |
| `degraded` | 仍可用，但存在有界且被命名的限制，或存在可安全恢复的状态 |
| `blocked` | 关键保证无法满足；不要在该状态下执行破坏性流程 |
| `not-evaluated` | 当前模式无法观测该事实（例如 CLI 模式下无法观测实时注册），报告会显式列出，绝不静默略过 |

`coverage` 分别列出已评估/未评估项；`degradedCapabilities` 单独列出已知的非阻塞能力限制（advisory evaluator、continuous/governance 未接入实时循环、host-only promotion、legacy 适配器、internal API 依赖）。

### 5.4 能识别的故障范围

- **宿主不兼容**：`host.cli` / `host.version` / `host.modules`（按 `peerDependencies` 校验 DSH 与各宿主模块版本，指出是哪个模块越界；DSH 版本必须落在经过真实验收的版本列表内，否则报 `blocked` 并给出 `verified: false`）。
- **profile 与注册**：`host.install`（未安装 / 未列入 bundles / 已安装版本与本诊断包版本漂移）、`host.composition`（调用官方 `dsh --dump-config`，校验 bundle 层与两个 loader 入口是否存在且启用）。
- **运行时能力**：`runtime.capabilities`、`runtime.registration`、`runtime.internal-api`（缺哪个服务/方法/探针就点出哪个）。
- **数据与状态**：`data.root`、`data.key`、`state.memory`（含隔离文件）、`state.archives`、`state.event-bridge`（逐行 MAC 验证、重复事件、同 id 冲突 MAC、截断尾行）、`state.domain`（官方 schema 校验、pending 事务、孤儿 staging、损坏的 archive 锁）。
- **迁移**：`migration.manifest`（`importId` 是否与文件清单自洽、不可变来源是否被改、目标文件是否缺失、未发布的 staging 是否残留）。
- **promotion**：`promotion.journal` 明确区分 `not-executed` / `incomplete` / `canary-observing` / `committed-pending-cleanup` / `rollback-failed` / `state-unknown`，并做 journal 目标边界校验；`promotion.composition` 校验行是否越界、悬空或残留孤儿目录；`promotion.pointer` 校验 `EVOLUTION.md` 指针与 composition 是否一致。

### 5.5 恢复语义（全部幂等）

| 状态 | 处理 |
| --- | --- |
| journal `prepared` / `committing` | 从 journal 备份回滚（CAS 保护，不覆盖并发修改）；`--repair` 或下次启动自动完成；重复执行无副作用 |
| journal `stable-committed` / `committed` | 只清理 journal 目录，不动 composition 与已提交插件 |
| journal `rollback-failed` | **不自动处理**：保留 journal 并报 `blocked` |
| journal 无法解析 / 阶段未知 / 目标越界 | **不自动处理**：报 `blocked`，保留现场 |
| event bridge 未闭合尾行 | 只丢弃不构成记录的尾部字节；重复执行不改变文件 |
| domain 孤儿 staging | 仅在无活进程持有 archive 锁时清理；有活进程时报告并拒绝 |
| domain archive 锁无主（空内容或死 pid） | 运行时会自动回收；`--repair` 可显式清理；有活主的锁永不抢占 |
| `EVOLUTION.md` 指向迁移前 legacy 能力 | 依据 migration manifest 的“No legacy promoted code execution”边界，报告为“有意不挂载”，不计为故障 |
| 损坏的 failure memory | 不删除：报 `degraded` 并说明下次启动会隔离（quarantine）保留原字节 |
| 损坏的 domain 聚合 / 事件 MAC / 不可变迁移证据 | 报 `blocked`，不重写、不猜测、不合并 |

## 6. 核心能力

保留旧 orchestrator 的成熟语义：proposal / candidate 风险分级、trial 临时激活与 teardown 基线恢复、measurement、`promotionGates`、journal 原子提交、CAS、跨进程锁、target claim、单调 evidence hydration、canary/restart、metricRegression 自动 rollback 与失败学习；durable memory、失败抑制、知识去重、冷档案/轮转/index 重建、canonical/tombstone/provenance。

- Promotion 通过官方 `@deepseek-ai/cordis-plugin-include@1.0.9` 承载私有 promoted composition，不再创建 profile `node_modules` mount/symlink。禁用/卸载父 bundle 会 dispose promoted 子 Fiber，而 composition/源码/档案保留。
- 提交与回滚调用公开 `Include.refresh()` / `EntryTree.await()`，验证公开 `tree.store` / `entry.fiber` 的 active 状态。
- 领域层新增：`EvolutionMemory`（含冷档案/语义 GC）、`EvolutionObservationStore`、`EvolutionEvaluator`、`knowledge` 通过官方 `storageDomain` 接入。领域提交使用 staging + `domain.global.set` 的 pending 协议，重启后 `installPending` 重放。
- 迁移白名单/guard 收紧，禁止重写 Cordis、禁止账户/provider/OAuth/旧 Web 与宿主主体写入。

## 7. 已知限制（必须显式记录，不使用隐藏 patch 绕过）

- **Promotion 的领域 evaluator 仍是 advisory**：`promotionGates` 是生产权威；领域 evaluator 提供记录在案的决策与“识别到 regression 即否决”的硬性 veto。它要求 goal/test/regression/已识别指标全部通过才会给 `promote`，但本插件尚未接入宿主提供的独立生产 baseline/test 指标，因此只有自定义指标时 evaluator 会返回 `reject`（不阻塞），真实独立指标接入待补。
- **continuous / governance 领域模块已提取并单测通过，但未接入 orchestrator 实时循环**：`lib/dockyard-domain/continuous/`、`governance/` 是无旧运行时副作用的纯领域实现，当前未启动第二套 Engine/scheduler。旧 `dockyard` 数据以文件形式完整保留，可用 `domainSeed` 载入。
- **Host-only**：Client half 一律拒绝。持久化源码使用合作式 `Function(hostCode)()` 兼容 gate，只接受同步、独立返回 Cordis Plugin 的函数体；任何 `harness` token 保守拒绝。这不是安全沙箱。
- **内部 API 依赖**：introspection 仍依赖 `ctx.registry.values()`、`ctx.reflect.props/_getImpl()`、`ctx.events._hooks`、Fiber effect 元数据；Include adapter 使用源码中公开的 `root.data` / `store` / `Entry.fiber` / `Fiber.state` / `ctx.get()`。这些不是稳定跨版本公共契约，升级 DSH 前必须重新验证——`runtime.internal-api` 会逐个探针报告可用性，缺失时降级为 `degraded` 而不是假装健康。
- 直接 dispose 底层 bundle Fiber 的手工 probe 仍无法自我断言（dispose 会使 probe 自身注入的 `tools` 失活）；官方 `pluginManager` 禁用/启用与 CLI 卸载/重装路径已独立验证。该底层路径不作为用户关闭流程。

## 8. 验收与官方参考

本仓库的真实验收已完成，并且**由本仓库的脚本执行、证据随仓库分发**：

- 单元/集成测试：`npm test`（139 个用例，含故障注入、CI 工作流校验与发布固定点校验）。
- 宿主真实验收：`node scripts/acceptance/run-host-acceptance.mjs --host <version>`，自包含安装官方宿主与 tarball，覆盖安装、诊断、核心流程、升级与回滚、promotion/canary 回滚与跨重启存活、禁用启用、卸载重装与数据保留。
- 用户侧可复现验证入口：`scripts/doctor.mjs`，不依赖模型，对安装、状态、迁移、promotion 给出分级结论与证据。
- 发布产物、复现步骤与剩余风险：`RELEASE.md`；验收证据：`docs/evidence/`；发布固定点：`release/manifest.json`。
- 从 Release 重新下载后用 `npm run release:verify -- <tarball>` 核对字节与内容摘要。

CI 见 `.github/workflows/ci.yml`（单测矩阵、可复现打包与内容白名单、两个宿主的真实安装验收）。

官方参考：`packages/boot/plugin-manager/README.md`、`docs/user/develop/basic/publish.md`、`packages/storage/storage-domain/{README.md,src/spec.ts}`、`vendor/include/README.md`。
