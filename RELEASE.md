# 发布说明与剩余风险

本文件记录 `dsh-evolution` 当前发布候选（RC）的产物、验证入口、已执行验收的证据，以及**尚未消除**的发布风险。本仓库公开分发 GitHub Release 资产，不发布 npm 包。

当前本地候选版本：`0.2.0-rc.7`，修复 file 后端失败记忆在损坏记录（含嵌套过深与 JSON 不可保真数值）、缺失身份、非字符串显式签名与时钟回拨下的启动失败、静默合并与丢失；doctor 与运行时共用同一判定。源码、固定产物和两个官方宿主验收必须对应同一内容及字节。本候选仅在本地固定与验收，未创建 tag 或进行外部发布。最后公开 `v0.2.0-rc.6` 的发布状态、远端 CI / CodeQL、匿名下载与发布后双宿主证据见 `docs/evidence/rc6-release-audit.json` 及 `rc6-postpublish-*.json`；卸载/重装后 memory 文件哈希变化的调查结论见 `docs/evidence/memory-hash-investigation.md`；本轮不修改历史 tag 或发布附件。

## 1. 产物

| 路径 | 说明 |
| --- | --- |
| `release/dsh-evolution-0.2.0-rc.7.tgz` | **发布产物本体**：随仓库固定的那一次构建的字节 |
| `release/manifest.json` | 发布固定点：`sha256`（发布字节）、`contentSha256`（跨环境内容摘要）、`sourceCommit`（产物来自哪个 commit）、条目数、权限、构建工具链、验收宿主与证据路径 |
| `release/SHA256SUMS` | 随 Release 附件一起提供的校验文件 |
| `dist/`（不入库） | 本机重新构建的产物与 `manifest.json`，仅用于验证与对比 |

本候选尚无公开发布入口。历史公开 rc.6 的入口、资产与发布后验收记录见 `docs/evidence/rc6-release-audit.json`。流程先在 draft 上验证附件，再公开并重新匿名下载校验；没有通过全部验证的 draft 不会公开。

`release/manifest.json` 只固定当前版本。历史 tarball 可以共存，发布流程仅选择 manifest 指定的文件；历史固定点也保留在对应 tag / commit 与各自 Release 附件中。

发布的字节与 CI 重新构建的字节**允许不同**：`npm pack` 通过随 Node 附带的 zlib 压缩，npm 10（Node 22）与 npm 11（Node 26）对完全相同的文件会产生不同的压缩字节。实测：同一棵树在 npm 10.9.3 下得到 `46f6e4a4…`、在 npm 11.19.1 下得到 `040e0d9e…`，而解包后的文件逐字节相同、未压缩 tar 大小相同。

因此本仓库区分两个概念：

- **`sha256`（发布字节）**：只有一个正确值。它由 `release/` 中固定的 tarball 决定，Release 附件的就是它，用户校验的就是它。
- **`contentSha256`（内容摘要）**：与平台和工具链无关。对 `路径 + 权限 + 文件内容` 排序后计算，是“这个包的内容有没有变”的唯一权威判据。

`release.yml` **不重新构建产物**，只验证 `release/` 中固定的字节并把它附到草稿 Release 上——重建会得到不同的字节，那就不再是验收针对过的东西。

## 2. 校验命令

```sh
# 当前本地候选（0.2.0-rc.7，仓库内容）
npm run pack:check                              # 打包稳定性、内容白名单、权限、锁文件、文档一致性、固定点
npm run release:verify                          # 固定产物：字节 sha256 + 内容摘要 + 条目 + 权限
npm run release:verify -- dist/<构建>.tgz --content-only   # 本机重建：只比内容（字节可不同）
# 尚未创建 v0.2.0-rc.7 tag；发布前再验证 tag -> commit -> 固定点 -> 工作树

# 已公开的 v0.2.0-rc.1（用该 Release 自带的 SHA256SUMS 校验；
# 本仓库的 release/ 已改为固定 0.2.0-rc.7，不再覆盖旧版本）
BASE=https://github.com/ryukeilee/dsh-evolution/releases/download/v0.2.0-rc.1
curl -fL "$BASE/SHA256SUMS" -o SHA256SUMS
curl -fL "$BASE/dsh-evolution-0.2.0-rc.1.tgz" -o dsh-evolution-0.2.0-rc.1.tgz
shasum -a 256 -c SHA256SUMS                    # Linux：sha256sum --check SHA256SUMS
```

## 3. 从全新 checkout 复现

```sh
git clone <this-repo> && cd dsh-evolution
npm ci                 # 严格按 package-lock.json 安装
npm test               # 完整套件（含可靠性、安全、性能差分与发布 pin 回归）
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

## 5. CI 与发布链

- `.github/workflows/ci.yml`
  - `test`：Node `22.19.0` 与 `24.x`，`npm ci --ignore-scripts`，`npm test`
  - `package`：`pack:check`、对固定产物的 `release:verify`、本机重建的 `--content-only` 校验、从**发布 tarball** 解包后在没有任何 `node_modules` 的情况下启动 doctor、`sha256sum --check`
  - `host-acceptance`：矩阵 `0.2.0-rc.2` / `0.2.1-alpha.1`，用真实官方宿主执行第 4 节的全部步骤，并断言证据的内容摘要等于发布固定点
- `.github/workflows/codeql.yml`：对 `javascript-typescript` 在 `main`、pull request 与每周运行 CodeQL，并把 SARIF 上传到 GitHub code scanning（job 权限仅 `security-events: write` + 只读内容）
- `.github/workflows/release.yml`：tag push 或 `workflow_dispatch` 时
  1. 校验 tag 形如 `v*`，并核对 tag 版本、checkout 到的 commit、`release/manifest.json` 的 `sourceCommit`（新版本必须有，必须是 tag 历史中的祖先，并从 git 对象计算其实际包内容摘要）与工作树内容摘要（`scripts/release/verify-provenance.mjs`）
  2. 跑 `pack:check`、`release:verify` 与 `sha256sum --check SHA256SUMS`
  3. 在 **draft** Release 上附上 `release/` 中的产物；**不接受覆盖**：已发布或已有附件的 Release 直接失败，上传不带 `--clobber`
  4. 把 GitHub 实际提供的附件下载回来，再跑一次 `verify-artifact.mjs` 并与 `release/SHA256SUMS`、`release/manifest.json` 逐字节 `diff`
- 重复运行或误触发发布流程**无法**覆盖已有版本资产：对已发布的 `v0.2.0-rc.1` 触发 `release.yml` 会在第 1 步前失败（`refusing to overwrite`），附件保持逐字节不变（已实测）。
- `workflow_dispatch` 的 `dry_run=true` 会执行第 1、2 步的全部校验而不创建或上传任何 Release。对 `v0.2.0-rc.1`（tag 早于本工具链）实测通过，并在需要时从默认分支借用 `scripts/release`（这些文件不属于包内容，固定点与产物不受影响）。
- 所有 action 均运行在 Node 24 运行时（`actions/checkout@v7`、`actions/setup-node@v7`、`actions/upload-artifact@v7`、`pnpm/action-setup@v6`、`github/codeql-action/*@v4`），不再出现 `Node.js 20 is deprecated` 警告。
- `test/workflows.test.mjs` 解析全部 workflow，锁定 CI job 集、可接受宿主矩阵、发布不可覆盖与不可重建、action 运行时与 major 版本；`test/release-provenance.test.mjs` 覆盖 provenance 判定表。

## 6. 发布状态与剩余风险

仓库已设为 public，`v0.2.0-rc.1` 的 tarball、`SHA256SUMS` 与 `manifest.json` 可由无仓库权限的用户直接下载。此前“私有仓库导致 Release 资产无法匿名下载”的限制已解除。

以下风险仍未消除：

1. **发布字节由人工固定的 `release/` 决定，而不是由 CI 重新构建。** 这是刻意的（见第 1 节），但它意味着：如果 `release/` 里的 tarball 被替换而 `release/manifest.json` 未同步，两者会不一致——`pack:check`、`release:verify` 和 `test/release-pin.test.mjs` 都会失败，因此只可能被“同时改对”而无法静默漂移。
2. **`v0.2.0-rc.1` 的 tag 与同名 Release 的已发布字节不一致。** tag 指向 `98a6425`，该 commit 固定的产物是 `d24f5e52…`（内容 `5bf862ec…`）；而 Release 上实际可下载的是 `fc41f0e0…`（内容 `763707ab…`），来自后续的 `4c87c99`（`git show 4c87c99:release/manifest.json` 可复现该固定点）。加固后的 workflow 现在会在这种 tag/manifest/产物不一致时**明确失败**。要修复历史 Release 需要移动 tag 或覆盖附件，两者都被本次目标禁止，因此它作为已知风险记录在此，而不是被修复。这也是 `release/` 只固定当前候选、旧版本只能靠 tag/commit 历史或 Release 附件校验的原因。
3. **守卫仍是启发式策略检查，不是 shell/JavaScript 安全沙箱。** 本次修复工具输入可触发的多项式回溯，重定向直接从 `>` 匹配，有序程序/写动词按互不重叠的候选区间匹配，保留导出的 `RegExp` 接口；没有把守卫扩展为通用解析器。promotion 执行的宿主代码同样是合作式执行，需要可信审批。
4. **验收覆盖不到手工 dispose 底层 bundle Fiber 的路径。** `disposeTrial` 走官方 runner 的 stop/undefine；直接 dispose bundle Fiber 的手工探针无法自我断言（会让探针自身注入的 `tools` 失活），因此不作为用户关闭流程，也未被 CI 覆盖。
5. **promotion 的领域 evaluator 仍是 advisory。** `promotionGates` 是生产权威，领域 evaluator 只提供记录在案的决策与 regression 硬 veto；尚未接入宿主提供的独立生产 baseline/test 指标。
6. **`continuous/` 与 `governance/` 领域模块未接入 orchestrator 实时循环。** 它们有单测覆盖，但不受宿主验收路径保护。
7. **内部/未文档化宿主接口仍被依赖。** `ctx.events._hooks` 与 `ctx.reflect._getImpl()` 回退路径是私有的；official loader / Include 的 `EntryTree.resolve`、`Entry.fiber/options/disabled` 是公开但未文档化的。`runtime.internal-api` 会逐项探测并在缺失时降级为 `degraded`，但升级 DSH 必须重新跑完整验收。
8. **Trial 期间持续存在的外部漂移仍拒绝恢复。** rc.5 在 Trial 首次修改运行时前同步捕获基线，解决 propose→trial 正常宿主加载的误报；不会重建基线来接纳 Trial 期间的变化。签名仍是前后可观察清单比较，不能记录已自行恢复的瞬态漂移，也不能证明任意合作式代码或 disposer 的全部外部效果。
9. **事件签名密钥 `event-bridge.key` 无轮换/吊销流程。** 它只在该数据根首次创建，禁用与卸载都不会删除。
10. **未做的发布动作：** npm 发布、代码签名 / provenance（SLSA）、SBOM。Code scanning 现已启用，但本 RC 仍不提供供应链签名。
11. **`0.2.1-alpha.1` 的 npm dist-tag 会移动。** 验收记录的是该精确版本号；上游把 `alpha` 指向新版本后，本仓库声明的仍是 `0.2.1-alpha.1`。
12. **指标 ID 不是授权凭证。** 兜底 ID 改为 `crypto.randomUUID()`，同一记录只生成一次，显式 ID 的优先级不变；调用方仍可提供 ID，不能把可猜测/不可猜测的 ID 当作权限控制。
13. **file 后端的失败记忆仍是 last-writer-wins，`save()` 也不做 fsync。** 同一数据根下两个 host 实例同时执行 `archive()` 时，后写者覆盖先写者的整份快照（隔离实验中 100 条记录只剩 50 条）；断电时最后一次 `record()` 也可能丢失。`openDomainStorage` 在同一数据根上的跨进程锁保护的是领域归档事务，不是这个文件。它是有界、advisory 的失败记忆（`promotionGates` 仍是生产权威），因此本次不引入锁或 fsync，而是记录为已知边界；单实例使用不触发。另外，从旧数据恢复且缺少 `signature` 的记录只能按整条内容去重，不参与后续的模式匹配。

## 7. 本次安全修复与 provenance 语义

- CodeQL #1（`js/polynomial-redos`）：前置不可逆标记（如 `publish`）使未受控工具 command 进入旧 matcher；重复数字/空格、编辑器或解释器名可阻塞执行前守卫。本地旧实现 4,000 / 8,000 / 16,000 个 `0` 分别约 52 / 201 / 801 ms。回归测试在独立进程的 5 秒硬期限内检查百万字符、重复命令名和相应 deny/allow 对照。
- CodeQL #2（`js/insecure-randomness`）：`metric-projection.js` 的组件及 task/goal/agent/session 兜底 ID 改用 Node CSPRNG UUID。它们是 evaluator 投影记录身份，不是密码、签名或权限令牌；本次真实移除弱随机源，不通过 dismiss 隐藏告警。显式身份、指标、时钟与副本隔离均有回归。
- `sourceCommit` 指向先提交的包源代码；随后 release commit 只加入固定 tarball、manifest、校验和与验收证据。manifest 不能包含承载自身的 commit SHA（会形成哈希自引用），因此要求 sourceCommit 为祖先，且 **source commit、tag commit、工作树与 tarball 的 shipped 内容摘要完全相同**。只验证祖先不足以证明来源，本次补上 git 对象内容比较，并禁止把未提交的包内容固定为 HEAD 的产物。
- GitHub Code Scanning 的最终 `fixed` 状态、CI run、公开资产校验与发布后双宿主验收见 `docs/evidence/rc2-release-audit.json`；该记录不属于包内容，可在发布后写入而不改变发布字节。

## 8. 相关文档

- `README.md`：用户侧安装 / 诊断 / 升级 / 回滚 / 卸载
- `COMPATIBILITY.md`：宿主接口审计与分级、验证矩阵
- `CHANGELOG.md`：版本变更记录
