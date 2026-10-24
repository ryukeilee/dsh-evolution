# 2026-10-24 可靠性验收记录

本记录区分当前开发候选与 `release/` 中已固定的 rc.17；本轮不修改版本或固定点。

## 初始状态与基线

- 初始 HEAD：`6b21130`，`git fetch origin` 后与 `origin/main` 无差异。
- 工作树已有暂存、未暂存发布脚本修复，以及未跟踪性能实验材料；本轮保留这些内容。
- 首轮 `NODE_OPTIONS=--max-old-space-size=4096 npm test`：888 项，887 通过、1 失败。唯一失败是 `test/release-pin.test.mjs` 对未提交分发文件的预期拒绝。
- 初始 `pack:check` 同样只因未提交分发内容失败，不放宽门禁。

## 当前候选的真实宿主验收

`npm run release:pack` 使用 Node v26.12.1 / npm 11.20.0 成功生成候选。

- tarball SHA-256：`2aac0a652c3c90383eeb7e8fa77afebe59cc14c6c7dfa82da38beda8057b7ab3`
- 内容 SHA-256：`25ef8dc3e0f69abb8471e94d0128977c7e4f3455170d6b48f1cb694444ac67e1`

三个官方宿主均使用脚本新建的隔离 runtime/home，21 个步骤全部通过；没有读取正式 DSH 数据。

这里的通过是验收脚本对安装、核心工具、生命周期和晋升恢复的判定；CLI doctor 的总体状态包含 `degraded`，实时 runtime capabilities、registration、internal API 为 `not-evaluated`，不据此声称所有实时诊断均已执行并通过。

- [0.2.0-rc.2](reliability-20261024-dsh-0.2.0-rc.2.json)
- [0.2.1-alpha.1](reliability-20261024-dsh-0.2.1-alpha.1.json)
- [0.2.1-rc.2](reliability-20261024-dsh-0.2.1-rc.2.json)

候选的 `release:verify --content-only` 与旧固定点比较失败，原因是内容摘要不同。这是开发后继与旧固定产物的区别，不能当作当前候选与旧包相同的证据。

## 已固定产物

`npm run release:verify` 退出 0；在 `release/` 执行 `shasum -a 256 -c SHA256SUMS` 通过。该结果仅证明旧固定产物字节、内容、条目和权限与其 manifest 一致。

## 最终收敛

最终修复、独立复审及隔离候选检查结果将在实际执行后补充；以上不是最终全绿声明。
