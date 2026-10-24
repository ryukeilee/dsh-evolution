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

新增修复保持分发内容摘要不变，集中于发布脚本：修正 `..name` 路径包含判断；同一 Buffer 派生 tarball 字节与内容身份；安装前拒绝已换成符号链接的目标目录；区分暂存创建 errno；rename 失败时明确报告已替换数量。回归测试新增 5 项，覆盖第二次/第一次 rename 失败、暂存创建失败、链接目录与 `..name` 边界。

隔离 clone 的候选提交 `8f0b884` 实际执行：

- `NODE_OPTIONS=--max-old-space-size=4096 npm test`：893/893，通过，无跳过。
- `NODE_OPTIONS=--max-old-space-size=4096 npm run pack:check`：通过，判定为 `ahead`，明确固定点及其证据未覆盖当前开发后继。
- `npm run release:verify`：通过。

随后 `c054867` 仅删除未使用的私有 helper 并修改注释；不改变分发内容或运行路径。

真实强制中断实验：复制本轮完整 `dist/` 输出到临时目录，在子进程中调用真实 `installOutputSet`，包装 `fs.renameSync` 于第一次成功 rename 后对自身发送 `SIGKILL`。子进程确以信号结束，artifact 已替换，原 manifest 与 sums 保持旧字节，两个 staging 文件保留。再用真实 pack CLI 重试，退出 1 并报 `refusing to overwrite`；重试前后所有现场文件逐字节相同。该实验没有触碰仓库固定点。

首轮独立复审确认 `..name` 为唯一阻塞项，已修复。第二轮复审发现发布器校验旧固定包仍重读路径，已同样收敛为一次读取，并新增跨快照 pin 回归（2 项，已执行反例验证：恢复旧读取方式时确实失败）。第三轮定点独立复审确认该阻塞关闭，无未解决阻塞；实际执行新增测试 2/2 及相关守卫 4/4 通过。

保留的边界：多文件 rename 不是跨文件原子事务，混合集需人工检查；最后一次目录检查与写入之间仍有并发替换窗口，不提供对抗本地进程的安全沙箱；历史导入器未知 `.migration.lock` 不自动删除。未跟踪的原始性能材料含本机路径，原样保留且不纳入本轮提交。
