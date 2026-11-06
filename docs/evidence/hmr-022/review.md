VERDICT: APPROVE（第 2 轮）

第 1 轮 CHANGES 的三项已全部修复并复核：

- S1 blocker `scripts/acceptance/reproduce-hmr-startup.mjs`：模式改为显式传入 overlay 生成，写盘后回读校验
  `- id: hmr` / `disabled: true`，缺行抛错；保留的临时根里三个 no-HMR overlay 都含该行，对照组不含。
  reviewer 独立确认 63/63 聚焦测试通过、无跳过。
- S2 should `scripts/benchmarks/host-startup.mjs`：超时样本排除出统计并非零退出；reviewer 用正常、单次超时、
  全部超时三种注入验证。
- S3 nit `scripts/benchmarks/host-startup.mjs`：CPU 改为按样本总量取中位数；提交的原始数据与统计一致。

第 2 轮只留一项 nit（README 写 7 轮，实际 9 轮），已修正；因 README 是分发文件，改后重新打包并对新
构建重跑 0.2.2-rc.1 验收（21/21，`contentSha256` bec5d91a…）。

本轮未发现新增 blocker 或 should。审核范围是 0.2.2-rc.1 适配、验收/基准脚本与文档；不覆盖
`release/` 重新固定（本变更刻意不做），也不覆盖生产环境升级。
