# ACP promoted consumer 启动中退出：状态覆盖缺陷复现与修复回归（2026-11-13）

## 结论

在隔离的真实 ACP 宿主里，修复前的 dsh-evolution 0.2.8 consumer 会在“启动过程中被关闭”的会话上发布失败报告，覆盖另一个会话已写下的 active 报告；修复后同一操作只在该失败会话的 disposal 字段上留下事实，基线 active 报告保持不变。

| 阶段 | 被测 lib/promoted-consumer.js | tarball sha256 | 尝试 | 结果 |
| --- | --- | --- | --- | --- |
| pre-fix（git HEAD 601870d） | 31b1f017f9db3b02906652a2a506b89f8cc544b313b88b28254ea990d874e48a（来源 HEAD） | 7b266374c3eaae5a711c085c86e599945b723147923dfc7ea1f69ee8d69b8cc3 | 8 | 8/8 覆盖 active 报告；8/8 review 判 host-unavailable + restart-consumer |
| fixed（当前工作树） | b0eda9092fcfe03068832bede61491a4172d8be3e9fd998789931e607e93d511（来源 working-tree） | f287d049d168857d5e9c8d18d80b559a85ad49ca48d583cce656f03657622f71 | 8 | 8/8 保留 active 报告与基线 sessionId；8/8 review 仍 active、无 restart-consumer |

证据 JSON：

- pre-fix：docs/evidence/promoted-consumer-shutdown-state-20261113.json（退出码 0，sha256 dd91694cfc2af7dd07ee8c2673f545f90ea73ba8f08115943a2d83afc8e18b27）
- fixed：docs/evidence/promoted-consumer-shutdown-state-20261113-fixed.json（退出码 0，sha256 4d362f6272f4a5257eaed3f1efea66d24914490d19261cbca579b2920679c0ee）
- 复现/回归 runner：scripts/acceptance/reproduce-consumer-shutdown-state.mjs
- 注入探针：scripts/acceptance/probes/consumer-abort-probe.mjs

## 实际命令

pre-fix（tarball 从 HEAD 导出树打包，因为工作树此时已包含未提交修复）：

    git archive HEAD | tar -x -C /tmp/dsh-evolution-head-69293/tree
    (cd /tmp/dsh-evolution-head-69293/tree && npm run release:pack)
    node scripts/acceptance/reproduce-consumer-shutdown-state.mjs \
      --tarball /tmp/dsh-evolution-head-69293/tree/dist/dsh-evolution-0.2.8.tgz \
      --out /tmp/consumer-prefix-final.json \
      --phase pre-fix --attempts 8 \
      --work /tmp/consumer-repro-final-prefix --keep

fixed（主代理从当前工作树打包）：

    node scripts/acceptance/reproduce-consumer-shutdown-state.mjs \
      --tarball dist/dsh-evolution-0.2.8.tgz \
      --out /tmp/consumer-fixed-final.json \
      --phase fixed --attempts 8 \
      --work /tmp/consumer-repro-final-fixed --keep

两个阶段的证据 JSON 随后按字节发布到 docs/evidence/（未改动 pre-fix 证据）。

## 隔离环境与安装路径

- 每次运行创建独立临时 DSH_HOME（os.tmpdir 下）；runner 断言 home 不是正式 ~/.dsh、不在 ~/.dsh 内、不包含 ~/.dsh，也不在仓库工作树内。
- 子进程环境从驱动会话中剥离全部 DSH_* 与 EVOLUTION_*，只显式设置隔离 DSH_HOME；官方 CLI 与探针只看到该隔离 home。
- 用 Desktop runtime 的官方 CLI（0.2.2-rc.2）在隔离 acp profile 执行 plugin --profile acp add <缓存 tarball>；随后按 scripts/setup-experience.mjs 导出的 managedPatch 写入该 profile 的 cordis.patch.yml。
- 未启动 Desktop 应用，不读写 ~/.dsh，未发布 npm 包，未改动 release/ 固定点，也未在正式 profile 安装任何版本。
- 每次 ACP 启动都通过 --patch 插入探针 entry，stdin 保持打开并发送 ACP initialize 握手；未使用 Desktop 应用。
- 宿主环境：CLI/DSH 0.2.2-rc.2；ACP 宿主 Node v24.21.0，Cordis 4.1.0，Include 1.1.0；runner Node v26.13.0（darwin-arm64）。

## 基线校验（两个阶段都通过）

- consumer state 行 status=active，observedIndexUpdatedAt 等于 publication index 的 updatedAt。
- 探针 receipt 证明 promoted 工具真实注册：found=true；模型的 schemas() 在本宿主不暴露 execute，探针经 ctx.tools.get() 取得真实定义并调用一次成功，返回 {"ok":true,"tool":"consumer_abort_probe_..."}。
- promoted 插件的事件 marker 在基线中恰好注册 1 个 listener 并执行 1 次（listeners=1, hits=1），证明是真实 mount 而不是只读索引。
- 基线 review（readPublishedPluginReview）在 pre-fix 与 fixed 证据中都是 active、无 nextAction。

## pre-fix：8 次启动中退出的结果

- 8/8 次都在 consumer claim 新 sessionId 后立即 SIGTERM（observedAfterMs 约 495–509 ms），0 次漏观察。
- 8/8 次最终 acp.json 的 plugins 行变成 failed/include-unavailable，errorCode=INACTIVE_EFFECT；final sessionId 均不等于基线 sessionId（8/8），changedKeys 为 compositionPath/disposal/disposedAt/host/plugins/sessionId/updatedAt。
- 8/8 次 review 判 host-unavailable，nextAction 为 restart-consumer（每个尝试 1 条）。
- 失败写出的 host 事实不稳定：8 次中 6 次 host.dsh=null（另 2 次仍为 0.2.2-rc.2），与正式 ~/.dsh 的 acp.json 历史证据（host.dsh=null、disposedAt 存在、disposal.entries=0）一致；review 因此按任务约定在最终 host 不完整时使用完整基线 host，仍得到 host-unavailable/restart-consumer。
- 8/8 次 disposal.entries=0：该失败会话没有挂载任何条目。

## fixed：8 次启动中退出的结果

- 8/8 次同样在 claim 后立即 SIGTERM（约 495–509 ms 后），0 次漏观察。
- 8/8 次最终 acp.json 的 sessionId 恢复为基线 sessionId；active 行逐字段与基线一致（activatedAt 不变），observedIndexUpdatedAt 不变。
- 8/8 次仅新增该失败会话的 disposedAt 与 disposal（disposal.entries=0），changedKeys 严格为 disposal/disposedAt。
- 8/8 次 review 仍为 active、action=null、restart-consumer 0 条。

## 实现切换与被替换文件摘要

runner 只修改隔离 home 内 profiles/acp/node_modules/dsh-evolution 的 lib/*.js，用 git diff --name-only HEAD -- lib/ 列出与 HEAD 不同的文件；工作树本身从未被修改。两阶段都只涉及一个文件：

| 阶段 | 文件 | 来源 | 写入后 sha256 | 安装包 lib 内容摘要 |
| --- | --- | --- | --- | --- |
| pre-fix | lib/promoted-consumer.js | git show HEAD:<rel> | 31b1f017f9db3b02906652a2a506b89f8cc544b313b88b28254ea990d874e48a | acd42a0f4e48d690b04c6a50d93a1d11523233905da686c218769357d8050932（53 个 lib 文件） |
| fixed | lib/promoted-consumer.js | 当前工作树 | b0eda9092fcfe03068832bede61491a4172d8be3e9fd998789931e607e93d511 | aa14b507fd5da2783e43d99611b72285e24de32aed03a5f1c82c915957bce799（53 个 lib 文件） |

证据 JSON 中 implementation.replacements 同时记录 replacement 前后的 beforeSha256/afterSha256 与 contentChanged（两阶段均为 false，因为安装 tarball 已与该阶段实现一致）。

## 边界与未验证项

- 每阶段固定 8 次尝试、单一 promoted fixture（一个工具 + 一个 event marker）；不覆盖多插件、多 profile 或索引并发变化。
- 未运行仓库全量测试；未进行真实发布、未更新 release/ 固定点、未 commit/push/PR。
- pre-fix 证据文件保持原样；本报告只新增三个文件（两个 evidence JSON 与本 Markdown）。
