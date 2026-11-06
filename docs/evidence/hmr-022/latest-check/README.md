# 最新官方版本与修复状态复核

核对时间：2026-11-06 00:27（Asia/Shanghai；精确 UTC 时间见 `result.json`）。本次复用父目录已经完成的真实复现、适配与独立审核；没有重新调查旧失败，没有运行新一轮全量测试或宿主验收。

## 当前结论

**升级仍阻塞，生产保持现状。** 官方 npm 的 DSH `latest`、`next` 都是 `0.2.2-rc.1`，该版本发布于 2026-11-04。GitHub 最新公开发布为 `dsh-v0.2.2-rc.1`，标记为 prerelease；没有观察到更新的已发布版本，不能把它称作稳定正式版。

本次从 npm Registry 重新下载官方 `dsh-plugin-manager@0.2.2-rc.1` 和 `dsh-hmr@0.2.2-rc.1` tarball，核对 SHA-512 integrity，然后只在内存读取源码。其 `lib/index.js` 与此前隔离复现使用的官方安装源码逐字节一致：

- PluginManager SHA-256：`6f0fdc6a6e4cd2bc9d969ba582636729ade450e415f0fc20bbef9da3f65823f3`
- HMR SHA-256：`d4990a34a9874f94fa1e045563e016526e4fefe5a72a4945532043188a65dfde`

没有修改或重新安装现有官方依赖。可用发布包仍包含已验证的启动事务缺口；因此不需要重复运行同一份受控复现来重新证明它。

此外检查了官方默认分支 master，固定到提交 [`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`](https://github.com/deepseek-ai/deepseek-harness/commit/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159)：

- `packages/boot/plugin-manager/src/index.ts:1210` 的 configure 仍在 HMR 缺失时直接调用 operation。
- 同文件 `:1247` 的 reload 仍再次读取 HMR 并直接调用 reconcileProfile。
- `packages/boot/hmr/src/index.ts:930` 仍要求当前实例 ALS 事务标记为 true。

以上没有给此前失败的交错建立一致的事务归属。检查 `release/dsh-0.2.2` 源码分支返回 HTTP 404，已如实记录；不对不存在、已删除或私有分支作结论。主分支源码与 npm 发布包是不同层次的证据，未将主分支视为可安装的已验证发布。

## 留存材料

- `dsh-registry.json`：DSH dist-tags、版本与发布时间。
- `releases.json`：GitHub 最新 5 条公开 Release 的 API 响应。
- `*-package.json`：官方精确版本的 npm 包元数据。
- `published-source-check.json`：发布 tarball integrity 与源码字节比较。
- `master-snapshot.json`：固定提交、官方源码 URL 与摘要。
- `master-plugin-manager.ts`、`master-hmr.ts`：本次只读下载的官方源码快照，仅用作调查证据，不是被修改或安装的依赖。
- `source-branch-check.json`、`*-commits.json`：源码分支查询及可见历史。
- `result.json`：本次机器可读结论。

## 当前交付与剩余门禁

继续保留 `/tmp/dsh-evolution-022` 中已有的两处最小适配、兼容测试、核心探针增强及诊断脚本；原基线 HEAD 为 `98f1b81aacf6e7365ae4fcfd4d8a70d9915573d5`，本次没有新增源码提交。既有测试与审核的适用范围、全量测试/pack:check 的未提交分发改动门禁失败，仍以父目录 README、checks.json 和日志为准；没有把历史结果改写为本次全绿。

没有扩大兼容矩阵，没有创建候选固定点，没有改动 v0.2.0 发布文件，也没有自动发布 GitHub Release。没有访问生产配置、会话、模型设置或密钥；没有执行备份、启停或升级。本次用户授权的生产步骤以“全部隔离门禁通过”为前提，该前提尚未成立。

后续需要可用的官方事务修复，或官方证明并经验证覆盖实际生产入口的安全就绪方案。取得该前提后，再完成分发源码提交、全量测试、pack:check、新旧宿主完整验收、重复启停与重启恢复、独立审核；全绿后才检查本机启动链、DSH_HOME、备份并按原架构升级。不得以验收延时、Evolution 包装器或直接改生产 node_modules 替代上游修复。

官方来源：[发布列表](https://github.com/deepseek-ai/deepseek-harness/releases)、[npm Registry](https://registry.npmjs.org/@deepseek-ai%2fdsh)、[固定提交源码](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/boot)。
