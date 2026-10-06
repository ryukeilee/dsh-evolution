# dsh-evolution

自我进化（Evolution）能力作为独立 DSH bundle 分发。DSH 主体保持官方原样，本插件通过官方 bundle / profile 机制安装，不修改官方源码、不向官方 `node_modules` 复制文件、不 patch 官方仓库。

本仓库是 `dsh-evolution` 的**唯一开发、测试与发布来源**；旧的 DSH 环境与私有迁移工作目录只作为历史迁移源和回滚基线，不再维护插件源码。

- 包版本：`0.2.0-dev.5`
- 支持的 DSH 版本范围：**`0.2.0-rc.2`（精确）**。`package.json` 的 `peerDependencies` 对官方包做精确版本校验，不通过 exemption 伪装其它版本兼容。
- Node：`^22.19.0 || >=24.0.0`（在当前验证环境为 `v26.10.0`，pnpm `11.26.0`）。

> 状态：官方 `0.2.0-rc.2` 上的迁移验收已完成（干净安装 / 插件安装 / 启动 / 核心流程 / 重启恢复 / 禁用启用 / 卸载重装 / 数据迁移 / 官方主体完整性）。验收证据保存在私有迁移工作目录，见第 7 节。这不是生产发布声明；发布、push 仍需人工决定。

## 1. 安装 DSH 与插件

新版 DSH 使用官方推荐方式安装（任一即可）：

```sh
npx @deepseek-ai/dsh web            # 官方推荐
# 或源码：pnpm install && pnpm run build
```

在干净 profile 中通过官方 CLI 安装本插件：

```sh
# 从源码包构建
npm pack                             # 生成 dsh-evolution-0.2.0-dev.5.tgz

# 安装 / 升级（同一条命令；官方 CLI 负责 bundle 选择与依赖安装）
DSH_HOME=/isolated/home dsh plugin --profile web add ./dsh-evolution-0.2.0-dev.5.tgz

# 启动
DSH_HOME=/isolated/home dsh web --no-open
```

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

## 5. 核心能力

保留旧 orchestrator 的成熟语义：proposal / candidate 风险分级、trial 临时激活与 teardown 基线恢复、measurement、`promotionGates`、journal 原子提交、CAS、跨进程锁、target claim、单调 evidence hydration、canary/restart、metricRegression 自动 rollback 与失败学习；durable memory、失败抑制、知识去重、冷档案/轮转/index 重建、canonical/tombstone/provenance。

- Promotion 通过官方 `@deepseek-ai/cordis-plugin-include@1.0.9` 承载私有 promoted composition，不再创建 profile `node_modules` mount/symlink。禁用/卸载父 bundle 会 dispose promoted 子 Fiber，而 composition/源码/档案保留。
- 提交与回滚调用公开 `Include.refresh()` / `EntryTree.await()`，验证公开 `tree.store` / `entry.fiber` 的 active 状态。
- 领域层新增：`EvolutionMemory`（含冷档案/语义 GC）、`EvolutionObservationStore`、`EvolutionEvaluator`、`knowledge` 通过官方 `storageDomain` 接入。领域提交使用 staging + `domain.global.set` 的 pending 协议，重启后 `installPending` 重放。
- 迁移白名单/guard 收紧，禁止重写 Cordis、禁止账户/provider/OAuth/旧 Web 与宿主主体写入。

## 6. 已知限制（必须显式记录，不使用隐藏 patch 绕过）

- **Promotion 的领域 evaluator 仍是 advisory**：`promotionGates` 是生产权威；领域 evaluator 提供记录在案的决策与“识别到 regression 即否决”的硬性 veto。它要求 goal/test/regression/已识别指标全部通过才会给 `promote`，但本插件尚未接入宿主提供的独立生产 baseline/test 指标，因此只有自定义指标时 evaluator 会返回 `reject`（不阻塞），真实独立指标接入待补。
- **continuous / governance 领域模块已提取并单测通过，但未接入 orchestrator 实时循环**：`lib/dockyard-domain/continuous/`、`governance/` 是无旧运行时副作用的纯领域实现，当前未启动第二套 Engine/scheduler。旧 `dockyard` 数据以文件形式完整保留，可用 `domainSeed` 载入。
- **Host-only**：Client half 一律拒绝。持久化源码使用合作式 `Function(hostCode)()` 兼容 gate，只接受同步、独立返回 Cordis Plugin 的函数体；任何 `harness` token 保守拒绝。这不是安全沙箱。
- **内部 API 依赖**：introspection 仍依赖 `ctx.registry.values()`、`ctx.reflect.props/_getImpl()`、`ctx.events._hooks`、Fiber effect 元数据；Include adapter 使用源码中公开的 `root.data` / `store` / `Entry.fiber` / `Fiber.state` / `ctx.get()`。这些不是稳定跨版本公共契约，升级 DSH 前必须重新验证。
- 直接 dispose 底层 bundle Fiber 的手工 probe 仍无法自我断言（dispose 会使 probe 自身注入的 `tools` 失活）；官方 `pluginManager` 禁用/启用与 CLI 卸载/重装路径已独立验证。该底层路径不作为用户关闭流程。

## 7. 验收与官方参考

本仓库的真实迁移验收已完成（干净 DSH 启动、官方 CLI 安装、核心全流程、promotion/canary/rollback/跨进程重启、数据迁移幂等与重启恢复、官方 pluginManager 禁用/启用、CLI 卸载/重装、数据保留）。验收证据保存在私有迁移工作目录，不随包分发。本仓库自身的验证入口是 `npm test`。

官方参考：`packages/boot/plugin-manager/README.md`、`docs/user/develop/basic/publish.md`、`packages/storage/storage-domain/{README.md,src/spec.ts}`、`vendor/include/README.md`。
