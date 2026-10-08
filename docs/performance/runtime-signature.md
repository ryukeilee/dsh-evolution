# runtimeSignature 排序键复用与优化整合

当前 Checkout：`fix/ci-pinned-artifact`，起点 `6ff1722210e5715c3b4c3d1a94a7eeaf3d0099c2`。
两个 T3 Worktree 均基于 `0944cc12e7fe7356125a38cd850becbd63bb1650`；该提交与当前起点的文件树相同。
两轮优化均为未提交改动，分别为领域查询元数据投影和运行时检查投影。共 16 个文件完整复制到当前 Checkout，无重叠文件冲突。
除 `lib/orchestrator.js` 添加本轮签名优化外，导入文件与来源逐字节相同；原 `snapshotJson()` 和 `inspect()` 优化保留。
原 Worktree、当前分支及 3 个已有未跟踪发布证据文件保持原样；所有整合修改尚未提交。备份位于 `/tmp/dsh-signature-integration-backup`。

本轮仅复用签名数组排序中的 JSON 键，不增加跨调用缓存。投影字段、排序稳定性、`localeCompare`、签名字节格式和恢复安全门保持原样。
32 条及以下沿用原排序；较大数组每行序列化一次，再按键排序。访问器、Proxy、循环、`toJSON`、特殊实例和不可序列化值退回原比较器，保留副作用与错误语义。

## 性能证据

环境：Node `v26.10.0` / `darwin-arm64`。固定种子的合成运行时，包含组件、服务、事件监听器、效果、动态插件和恢复证明。
基线为整合后、签名优化前的冻结实现 `test/fixtures/runtime-signature.mjs`。每个场景先比较结果，再预热，三轮交替先后顺序取 CPU 中位数。
CPU 和 V8 HeapProfiler 分配采样独立运行；采样间隔 1024 字节，包含已 GC 的对象。分配量为估计，不代表峰值内存或 RSS。

| 路径 | 条目规模 | 基线 CPU µs/次 | 优化 CPU µs/次 | CPU 减少 | 采样分配减少 |
| --- | ---: | ---: | ---: | ---: | ---: |
| runtimeSignature | 20 | 132.45 | 127.40 | 3.8% | 2.3% |
| signatureEqual | 20 | 274.09 | 272.49 | 0.6% | 0.8% |
| runtimeSignature | 100 | 991.89 | 758.59 | 23.5% | 15.6% |
| signatureEqual | 100 | 1568.85 | 1113.57 | 29.0% | 14.4% |
| runtimeSignature | 1000 | 9847.19 | 5252.59 | 46.7% | 39.6% |
| signatureEqual | 1000 | 22343.75 | 12814.58 | 42.6% | 37.8% |

小规模路径仍使用原排序，微小差异视为测量噪声；收益主要来自较大且无副作用的运行时注册表。未降低恢复证明要求。
独立进程复测中，100–1000 条规模 CPU 降幅为 27.6%–46.7%，采样分配降幅为 15.5%–39.4%，各大规模场景均保持收益。
原始数据：`runtime-signature.json`；独立复测：`runtime-signature-repeat.json`。

```sh
rtk proxy node --test test/runtime-signature.test.mjs
rtk proxy node --expose-gc scripts/benchmarks/runtime-signature.mjs
rtk proxy npm test
rtk proxy env npm_config_cache=/tmp/dsh-runtime-npm-cache node scripts/release/pack.mjs --dist /tmp/dsh-signature-integrated-final-dist
```

## 回归与验收

差分覆盖签名字节、恢复判断、原数据不变性、字段变化、未知/缺失注册表、监听器与包嵌套排序、稳定同键、访问器、Proxy、`toJSON`、循环、bigint、Date、undefined，以及调用后修改数据不复用旧键。
完整 `npm test`：197 项，195 通过，2 失败。功能回归全部通过；两项失败仅为 `test/release-pin.test.mjs` 的源码与旧发布制品一致性检查。
最终候选重复打包字节一致，50 个条目、内容与文件模式检查通过。
最终 `contentSha256: 1e70b88f30e370d01a33e62e73af9d7dbf19c33b8095bcb04e38cd37aada15d4`。
官方宿主 `0.2.0-rc.2` 和 `0.2.1-alpha.1` 各 21/21 步通过，均验证同一最终候选。复用此前准备的官方 runtime，home 为全新临时合成数据目录。
覆盖核心工具与恢复、禁用启用、卸载重装数据保留、升级回滚、晋升与重启回滚；证据见 `runtime-signature-hosts.json`。

## 剩余发布检查

`pack:check` 尚有三类失败：仓库既有宿主验收证据对应旧内容、`release/manifest.json` pin 对应旧内容、工作树不等于已发布制品。
旧内容摘要为 `d4bec3181f4addad50f32dfee278478134891da15f66626f7c9caa2544957358`。新候选验收证据另存于性能目录，未覆盖发布证据或发布 pin。
首次 `pack:check` 还因默认 npm 缓存 `EPERM` 失败；使用临时 npm 缓存重跑后该环境问题消失，仅剩上述发布一致性问题。
未修改官方 DSH、依赖版本、发布 pin 或外部发布状态；完整回归不能报告为全绿。
