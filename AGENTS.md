# dsh-evolution 项目指南

## 项目定位与依据

- 本仓库是 Evolution 插件的开发、测试与发布来源，不是 DSH 本体 fork。通过官方 bundle/profile 机制接入；不得 patch 官方源码或向宿主 `node_modules` 复制实现。
- 版本、Node engines、宿主兼容范围以 `package.json` 为准；安装与行为见 `README.md`，兼容限制见 `COMPATIBILITY.md`，发布流程见 `RELEASE.md`。不要用旧 dev tarball、历史验收次数或邻近备份仓库代替当前依据。
- 当前实现是 ESM JavaScript，`lib/` 是手写源码，不是可以删除后重建的编译产物；本仓库没有 TypeScript build/lint 脚本。

## 目录与验证

- `lib/orchestrator.js`：实验、trial、measurement、promotion 生命周期；`lib/promotion-include.js`：官方 Include 适配。
- `lib/dockyard-domain/`、`lib/domain-storage.js`：领域实现与存储；`lib/diagnostics.js`、`scripts/doctor.mjs`：运行时和 CLI 诊断。
- `test/`：Node 原生测试与 fixtures；`scripts/acceptance/`：真实隔离宿主验收；`scripts/release/`：产物及发布固定点校验。
- `release/` 保存固定产物、manifest 与校验和；`dist/` 是本地产物输出；`docs/evidence/` 是对应内容的验收记录。

从仓库根执行，按变更选择必要检查：

```sh
npm ci --ignore-scripts                     # 需要安装依赖时；与单测 CI 一致
node --test test/trial-recovery-boundary.test.mjs  # 聚焦测试示例
npm test                                   # 仓库回归入口
npm run pack:check                         # 分发内容、兼容声明及发布固定点校验
npm run release:verify                     # 校验已固定产物
```

- `pack:check` 校验当前分发内容与固定产物/验收证据一致。修改分发文件后失败不是可忽略噪音；按 `RELEASE.md` 重新构建、验收并更新固定点，不手工伪造通过记录。
- 真实宿主验收使用 `npm run acceptance:host -- --host <version> --out <evidence-path>`；会安装依赖并生成证据，须使用隔离 runtime/home，不碰正式 `DSH_HOME`。
- `npm run release:pack` 生成本地产物；`release:publish` 会更新发布产物/固定点，不属于普通只读检查。外部发布、tag、push 另需授权。
- 本机 npm 压缩字节不一定与已发布 tarball 相同；区分字节校验与 `release:verify -- <tarball> --content-only`。

## 必须保留的行为边界

- 修改 trial/teardown、跨进程锁、CAS、journal、canary 与重启恢复时补对应失败路径测试；未知或损坏持久状态不得猜测、静默合并或删除现场。
- 新宿主版本必须经过真实安装验收再扩展 peer 范围、CI 矩阵与兼容说明；不能用宽松范围绕过 doctor 的阻断。
- 领域 evaluator 的 advisory/veto、continuous/governance 尚未接入实时循环、host-only 与内部 introspection 风险以 `COMPATIBILITY.md` 为准，不把单测当作生产闭环证明。
- 不读取正式用户数据、密钥、`event-bridge.key` 或旧迁移目录来“补齐”测试。诊断 `--repair`、导入、启停、升级与卸载均须明确授权；测试优先临时 home。
- 保留用户修改；不提交运行日志、session、凭据、动态 promoted 源码或私有数据。只报告本次实际执行的检查。
