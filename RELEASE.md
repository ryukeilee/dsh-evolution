# 发布说明与剩余风险

本文件记录 `dsh-evolution` 当前发布候选（RC）的产物、验证入口、已执行验收的证据，以及**尚未消除**的发布风险。本仓库公开分发 GitHub Release 资产，不发布 npm 包。

当前候选版本：`0.2.0-rc.1`

## 1. 产物

| 路径 | 说明 |
| --- | --- |
| `release/dsh-evolution-0.2.0-rc.1.tgz` | **发布产物本体**：随仓库固定的那一次构建的字节 |
| `release/manifest.json` | 发布固定点：`sha256`（发布字节）、`contentSha256`（跨环境内容摘要）、条目数、权限、构建工具链、验收宿主与证据路径 |
| `release/SHA256SUMS` | 随 Release 附件一起提供的校验文件 |
| `dist/`（不入库） | 本机重新构建的产物与 `manifest.json`，仅用于验证与对比 |

公开 Release 页面与附件可匿名访问，无需仓库权限：<https://github.com/ryukeilee/dsh-evolution/releases/tag/v0.2.0-rc.1>。

发布的字节与 CI 重新构建的字节**允许不同**：`npm pack` 通过随 Node 附带的 zlib 压缩，npm 10（Node 22）与 npm 11（Node 26）对完全相同的文件会产生不同的压缩字节。实测：同一棵树在 npm 10.9.3 下得到 `46f6e4a4…`、在 npm 11.19.1 下得到 `040e0d9e…`，而解包后的文件逐字节相同、未压缩 tar 大小相同。

因此本仓库区分两个概念：

- **`sha256`（发布字节）**：只有一个正确值。它由 `release/` 中固定的 tarball 决定，Release 附件的就是它，用户校验的就是它。
- **`contentSha256`（内容摘要）**：与平台和工具链无关。对 `路径 + 权限 + 文件内容` 排序后计算，是“这个包的内容有没有变”的唯一权威判据。

`release.yml` **不重新构建产物**，只验证 `release/` 中固定的字节并把它附到草稿 Release 上——重建会得到不同的字节，那就不再是验收针对过的东西。

## 2. 校验命令

```sh
curl -fL https://github.com/ryukeilee/dsh-evolution/releases/download/v0.2.0-rc.1/dsh-evolution-0.2.0-rc.1.tgz -o dsh-evolution-0.2.0-rc.1.tgz
curl -fL https://github.com/ryukeilee/dsh-evolution/releases/download/v0.2.0-rc.1/SHA256SUMS -o SHA256SUMS
curl -fL https://github.com/ryukeilee/dsh-evolution/releases/download/v0.2.0-rc.1/manifest.json -o manifest.json
shasum -a 256 -c SHA256SUMS                    # Linux：sha256sum --check SHA256SUMS
npm run release:verify -- dsh-evolution-0.2.0-rc.1.tgz  # 在公开仓库 checkout 中校验下载的 tarball
npm run pack:check                              # 打包稳定性、内容白名单、权限、锁文件、文档一致性、固定点
npm run release:verify                          # 固定产物：字节 sha256 + 内容摘要 + 条目 + 权限
npm run release:verify -- <下载的.tgz>            # 从 Release 下载回来的文件，用同一条命令核对
npm run release:verify -- dist/<构建>.tgz --content-only   # 本机重建：只比内容（字节可不同）
```

## 3. 从全新 checkout 复现

```sh
git clone <this-repo> && cd dsh-evolution
npm ci                 # 严格按 package-lock.json 安装
npm test               # 139/139
npm run pack:check     # 16 项检查
npm run release:verify # 固定产物与发布固定点一致
node --version         # 需要 ^22.19.0 || >=24.0.0
```

`npm test` 使用显式 glob（`node --test "test/**/*.test.mjs" "test/**/*.test.js"`）。传目录名 `test/` 在 Node 22 上会被当作模块路径而失败——这正是首次在真实 runner 上暴露的缺陷之一。

## 4. 宿主验收（真实安装）

```sh
node scripts/acceptance/run-host-acceptance.mjs --host 0.2.0-rc.2
node scripts/acceptance/run-host-acceptance.mjs --host 0.2.1-alpha.1
```

脚本是自包含的：它在一个临时目录里用 pnpm 安装指定版本的官方 `@deepseek-ai/dsh`，在全新的 `$DSH_HOME` 里用官方 `dsh plugin --profile web add` 安装 tarball，然后驱动真实宿主完成 21 步：

1. 官方 CLI 只读诊断（`host.version` 必须是 `verified: true`，状态不得为 `blocked`）
2. 核心流程：`runtime_inspect → propose → trial → measure → revert`，要求 `runtimeRecovered: true`，以及 9 个工具全部注册
3. 官方 `pluginManager` 禁用 / 启用，断言 `applied` / `restart-required` 的实时与选中语义，且用户数据逐字节不变
4. 官方 CLI 卸载，官方宿主在插件缺席时仍能启动，再重新安装
5. 重装后核心流程再次通过，且原有 memory 条目全部保留
6. README 的升级与回滚流程：把同一棵树重打包成更高版本用官方 CLI 升级，再用当前 tarball 回滚；两步之后宿主仍注册 9 个工具且用户数据不变
7. 真实 promotion：`propose → trial → measure → 二次确认门 → promote → canary 观察`，监听器可被真实触发并跨进程重启存活
8. 重启后 startup canary 提交为 `stable`；新候选注入 `metricRegression` 触发 canary 回滚，且只回滚新候选、保留已提交候选
9. 再次重启后已提交候选仍存活、被回滚候选未复活，最终诊断 `healthy`

验收证据（每次运行由脚本重写，本地路径脱敏为 `<work>` / `$DSH_HOME`）：

- `docs/evidence/dsh-0.2.0-rc.2.json`
- `docs/evidence/dsh-0.2.1-alpha.1.json`

证据同时记录 `contentSha256`（内容）与 `tarballSha256`（实际安装的字节），`pack:check` 与 `test/release-pin.test.mjs` 都会核对它们与发布固定点一致：任何被发布文件的变化都会使 `pack:check` 失败，直到两个宿主的验收重新运行。

### 4.1 已执行的验收记录

| 宿主 | 宿主模块 | 结果 |
| --- | --- | --- |
| `0.2.0-rc.2` | cordis `4.0.4`、include `1.0.9`、loader `1.0.5` | 21/21 步通过；最终诊断 `healthy` |
| `0.2.1-alpha.1` | cordis `4.0.5-alpha.1`、include `1.0.10-alpha.1`、loader `1.0.6-alpha.1` | 21/21 步通过；最终诊断 `healthy` |

首次 CLI 诊断为 `degraded`（`data.root` 尚未初始化）属于预期：数据根在首次运行时创建，最终诊断恢复 `healthy`。

## 5. CI

- `.github/workflows/ci.yml`
  - `test`：Node `22.19.0` 与 `24.x`，`npm ci --ignore-scripts`，`npm test`
  - `package`：`pack:check`、对固定产物的 `release:verify`、本机重建的 `--content-only` 校验、从**发布 tarball** 解包后在没有任何 `node_modules` 的情况下启动 doctor、`sha256sum --check`
  - `host-acceptance`：矩阵 `0.2.0-rc.2` / `0.2.1-alpha.1`，用真实官方宿主执行第 4 节的全部步骤，并断言证据的内容摘要等于发布固定点
- `.github/workflows/release.yml`：tag push 时校验 tag 与版本一致、验证固定产物、把 `release/` 中的产物附到**草稿** GitHub Release（不重建、不自动发布、不发布 npm）
- `test/workflows.test.mjs` 解析两个 workflow 并锁定这些性质

## 6. 发布状态与剩余风险

仓库已设为 public，`v0.2.0-rc.1` 的 tarball、`SHA256SUMS` 与 `manifest.json` 可由无仓库权限的用户直接下载。此前“私有仓库导致 Release 资产无法匿名下载”的限制已解除。

以下风险仍未消除：

1. **发布字节由人工固定的 `release/` 决定，而不是由 CI 重新构建。** 这是刻意的（见第 1 节），但它意味着：如果 `release/` 里的 tarball 被替换而 `release/manifest.json` 未同步，两者会不一致——`pack:check`、`release:verify` 和 `test/release-pin.test.mjs` 都会失败，因此只可能被“同时改对”而无法静默漂移。
2. **验收覆盖不到手工 dispose 底层 bundle Fiber 的路径。** `disposeTrial` 走官方 runner 的 stop/undefine；直接 dispose bundle Fiber 的手工探针无法自我断言（会让探针自身注入的 `tools` 失活），因此不作为用户关闭流程，也未被 CI 覆盖。
3. **promotion 的领域 evaluator 仍是 advisory。** `promotionGates` 是生产权威，领域 evaluator 只提供记录在案的决策与 regression 硬 veto；尚未接入宿主提供的独立生产 baseline/test 指标。
4. **`continuous/` 与 `governance/` 领域模块未接入 orchestrator 实时循环。** 它们有单测覆盖，但不受宿主验收路径保护。
5. **内部/未文档化宿主接口仍被依赖。** `ctx.events._hooks` 与 `ctx.reflect._getImpl()` 回退路径是私有的；official loader / Include 的 `EntryTree.resolve`、`Entry.fiber/options/disabled` 是公开但未文档化的。`runtime.internal-api` 会逐项探测并在缺失时降级为 `degraded`，但升级 DSH 必须重新跑完整验收。
6. **`trial` 的基线在 `propose` 时抓取，宿主懒加载 fiber 会造成竞态。** 验收探针因此先等待运行时签名稳定再 propose；真实用户如果恰好在宿主懒加载期间 propose，仍可能看到 `revert-failed`。这是既有设计属性，本次未修改。
7. **事件签名密钥 `event-bridge.key` 无轮换/吊销流程。** 它只在该数据根首次创建，禁用与卸载都不会删除。
8. **未做的发布动作：** npm 发布、代码签名 / provenance（SLSA）、SBOM。本 RC 提供固定字节、校验信息和完整验收证据，但不提供供应链签名。
9. **`0.2.1-alpha.1` 的 npm dist-tag 会移动。** 验收记录的是该精确版本号；上游把 `alpha` 指向新版本后，本仓库声明的仍是 `0.2.1-alpha.1`。

## 7. 相关文档

- `README.md`：用户侧安装 / 诊断 / 升级 / 回滚 / 卸载
- `COMPATIBILITY.md`：宿主接口审计与分级、验证矩阵
- `CHANGELOG.md`：版本变更记录
