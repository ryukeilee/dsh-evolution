# 发布说明与剩余风险

本文件记录 `dsh-evolution` 当前发布候选（RC）的产物、验证入口、已执行验收的证据，以及**尚未消除**的发布风险。它不是发布声明：本仓库不发布 npm 包，push / tag / GitHub Release 必须由人工决定。

当前候选版本：`0.2.0-rc.1`

## 1. 产物

| 文件 | 说明 |
| --- | --- |
| `dist/dsh-evolution-0.2.0-rc.1.tgz` | 发布包（bundle） |
| `dist/SHA256SUMS` | tarball 的 SHA256，随产物生成 |
| `SHA256SUMS`（仓库根目录） | 同一校验和的入库副本，评审提交即可确认制品 |

`dist/` 不入库（在 `.gitignore` 中）；根目录 `SHA256SUMS` 入库。每次发布由 `npm run release:pack` 重新生成，内容与校验和可复现；`npm run pack:check` 会校验入库的 `SHA256SUMS` 与 `docs/evidence/` 记录的 tarball 哈希都与当前工作树一致。

## 2. 从全新 checkout 复现

```sh
git clone <this-repo> && cd dsh-evolution
npm ci                 # 严格按 package-lock.json 安装
npm test               # 131/131（含对 .github/workflows 的解析与发布约束校验）
npm run pack:check     # 可复现性 + 内容白名单 + 便携性 + 声明一致性
npm run release:pack   # 生成 dist/*.tgz 与 dist/SHA256SUMS
node --version         # 需要 ^22.19.0 || >=24.0.0
```

`npm run pack:check` 会拒绝以下情况：两次打包不是逐字节一致、出现 `files` 白名单之外的文件（`test/`、`node_modules/`、`.git`、日志、`.env`、`dist/`、`SHA256SUMS`）、tarball 内含本机绝对家目录或凭据形态文本、`package-lock.json` 与 `package.json` 漂移、README/CHANGELOG 与当前版本不一致、README 缺少安装/诊断/升级/回滚/卸载步骤、根目录 `SHA256SUMS` 或 `docs/evidence/` 与当前工作树的打包哈希不一致。

最后一条是刻意的：任何被发布文件的变化（包括 `README.md`、`RELEASE.md`、`scripts/`）都会改变 tarball 哈希，因此 `pack:check` 会失败，直到两个宿主的验收重新运行并重写 `docs/evidence/`。不会出现“包变了、证据还是旧的”这种状态。

打包时会把声明的文件复制到临时暂存目录并把权限归一到 `0644`/`0755`（保留可执行位），因此产物只由 git 追踪的内容与可执行位决定：同一提交在全新 `git clone` 中会得到与开发工作树逐字节相同的 tarball，不受本地 umask 影响。

## 3. 宿主验收（真实安装）

```sh
node scripts/acceptance/run-host-acceptance.mjs --host 0.2.0-rc.2
node scripts/acceptance/run-host-acceptance.mjs --host 0.2.1-alpha.1
```

脚本是自包含的：它在一个临时目录里用 pnpm 安装指定版本的官方 `@deepseek-ai/dsh`，在全新的 `$DSH_HOME` 里用官方 `dsh plugin --profile web add` 安装 `dist/*.tgz`，然后驱动真实宿主完成：

1. 官方 CLI 只读诊断（`host.version` 必须是 `verified: true`，状态不得为 `blocked`）
2. 核心流程：`runtime_inspect → propose → trial → measure → revert`，并要求 `runtimeRecovered: true`（trial 的 disposer 真正恢复基线），以及 9 个工具全部注册
3. 官方 `pluginManager` 禁用 / 启用，断言 `applied` / `restart-required` 的实时与选中语义，且用户数据逐字节不变
4. 官方 CLI 卸载，官方宿主在插件缺席时仍能启动，再重新安装
5. 重装后核心流程再次通过，且原有 memory 条目全部保留
6. README 的升级与回滚流程：把同一棵树重打包成更高版本（`<version>.upgrade`）用官方 CLI 升级，再用当前 tarball 回滚；两步之后宿主仍注册 9 个工具，且用户数据逐字节不变
7. 真实 promotion：`propose → trial → measure → 二次确认门 → promote → canary 观察`，监听器可被真实触发并跨进程重启存活
8. 重启后 startup canary 提交为 `stable`；新候选注入 `metricRegression` 触发 canary 回滚，且只回滚新候选、保留已提交候选
9. 再次重启后已提交候选仍存活、被回滚候选未复活，最终诊断 `healthy`

验收证据（每次运行由脚本重写，路径已脱敏为 `<work>` / `$DSH_HOME`）：

- `docs/evidence/dsh-0.2.0-rc.2.json`
- `docs/evidence/dsh-0.2.1-alpha.1.json`

### 3.1 已执行的本地验收记录（2026-10-06，macOS arm64，Node v26.10.0）

| 宿主 | 宿主模块 | 结果 |
| --- | --- | --- |
| `0.2.0-rc.2` | cordis `4.0.4`、include `1.0.9`、loader `1.0.5` | 全流程通过；最终诊断 `healthy` |
| `0.2.1-alpha.1` | cordis `4.0.5-alpha.1`、include `1.0.10-alpha.1`、loader `1.0.6-alpha.1` | 全流程通过；最终诊断 `healthy` |

两个宿主各重复运行多次（含一次完全从零安装 runtime 的运行），结果一致。首次 CLI 诊断为 `degraded`（`data.root` 尚未初始化）属于预期：数据根在首次运行时创建，最终诊断恢复 `healthy`。

## 4. CI

- `.github/workflows/ci.yml`
  - `test`：Node `22.19.0` 与 `24.x`，`npm ci --ignore-scripts`，锁文件漂移检查，`npm test`
  - `package`：`npm run pack:check`、`npm run release:pack`、`sha256sum --check`、把 tarball 解到空目录并在**没有任何 `node_modules`** 的情况下启动 doctor
  - `host-acceptance`：矩阵 `0.2.0-rc.2` / `0.2.1-alpha.1`，用真实官方宿主执行第 3 节的全部步骤并上传证据
- `.github/workflows/release.yml`：tag push 时校验 tag 与 `package.json` 版本一致、构建产物，并附到**草稿** GitHub Release（不自动发布，不发布 npm）

## 5. 剩余发布风险（未消除）

1. **验收只在 macOS arm64 上做过真实运行。** CI 会在 `ubuntu-latest` 上重复同一套验收；在 CI 首次通过之前，Linux 上的真实安装仍是未验证项。Node 24 上只跑单测，不跑宿主验收（CI 的 `host-acceptance` 固定 Node 22.19）。
2. **验收覆盖不到手工 dispose 底层 bundle Fiber 的路径。** `lib/orchestrator.js` 的 `disposeTrial` 走官方 runner 的 stop/undefine；直接 dispose bundle Fiber 的手工探针无法自我断言（dispose 会让探针自身注入的 `tools` 失活），因此不作为用户关闭流程，也未被 CI 覆盖（README 第 7 节已记录）。
3. **promotion 的领域 evaluator 仍是 advisory。** `promotionGates` 是生产权威，领域 evaluator 只提供记录在案的决策与 regression 硬 veto；尚未接入宿主提供的独立生产 baseline/test 指标。
4. **`continuous/` 与 `governance/` 领域模块未接入 orchestrator 实时循环。** 它们有单测覆盖，但不受本验收路径保护。
5. **内部/未文档化宿主接口仍被依赖。** `ctx.events._hooks` 与 `ctx.reflect._getImpl()` 回退路径是私有的；official loader / Include 的 `EntryTree.resolve`、`Entry.fiber/options/disabled` 是公开但未文档化的。`runtime.internal-api` 会逐项探测并在缺失时降级为 `degraded`，但升级 DSH 必须重新跑完整验收，不能只靠版本号。
6. **`trial` 的基线在 `propose` 时抓取，宿主懒加载 fiber 会造成竞态。** 验收探针因此会先等待运行时签名稳定再 propose。真实用户如果恰好在宿主懒加载（例如 `cordis-dynamic`）期间 propose，仍可能看到 `revert-failed`；这是既有设计属性，本次未修改（保持现有 promotion/rollback 门槛）。
7. **事件签名密钥 `event-bridge.key` 无轮换/吊销流程。** 它只在该数据根首次创建，禁用与卸载都不会删除。
8. **未做的发布动作：** npm 发布、git push、tag、GitHub Release 发布、代码签名 / provenance（SLSA）。本 RC 只提供本地 tarball 与校验和。
9. **`0.2.1-alpha.1` 的 npm dist-tag 会移动。** 验收记录的是该精确版本号；上游把 `alpha` 指向新版本后，本仓库声明的仍是 `0.2.1-alpha.1`，重新安装可能拿到的是同一版本号的不同内容（npm 不应允许，但无法在本仓库内强制）。

## 6. 相关文档

- `README.md`：用户侧安装 / 诊断 / 升级 / 回滚 / 卸载
- `COMPATIBILITY.md`：宿主接口审计与分级、验证矩阵
- `CHANGELOG.md`：版本变更记录
