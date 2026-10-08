# 最终本地候选收口

`0.2.0-rc.4` 收敛当前 Checkout 的五轮成果。生产代码与第五轮提交
`c711f3b` 完全相同，仅更新候选版本、发布说明、固定产物和验收证据，以及
发布 workflow 的精确资产选择。未增加功能、缓存或更改认证、持久化、fsync、
恢复证明和回滚语义。没有修改官方 DSH，也没有外部发布。

包源码先提交为 `1ae5df0b519ed6c54c920cc7ff46b1a56e4dc652`，随后固定
产物与证据，避免 manifest 的 commit 哈希自引用。当前包内容摘要为
`b11a085ed330dc449e51e48017df8709b7691ed980f8cf6b55f0c5b0fce7741a`，
固定 tarball SHA256 为
`57f09a0f8ab1c0543d5bc1bf54aca5296960d2acf3edc61950f255580e99a4ff`。
源码提交、工作树、manifest、tarball 和两个宿主证据均一致。

## 性能复核

Node `v26.10.0` / `darwin-arm64`，沿用各轮冻结基线、相同合成工作负载和
原基准，不更改验证标准。各基准串行运行，CPU 与采样分配测量分开。
首份运行时检查结果与打包有时间重叠，原样保留为
`final-runtime-inspect-overlapped.json`，排除于最终结论；独立重新运行的
`final-runtime-inspect.json` 为有效结果。其余基准运行期间没有并行测试或
宿主验收。原五轮文档、冻结实现、原始数据、失败记录和双宿主证据全部保留。

- 领域查询元数据：100 条、每条 1 MiB、返回 50 条、15 次采样，一对进程
  复核 CPU 79.780 → 67.052 ms（减少 15.95%），延迟 67.300 → 60.290 ms
  （减少 10.42%），计时区间 heapUsed 增量减少 33.28%。本次是一对复核，
  原三轮数据继续以 `domain-query-metadata.md` 为准。
- 运行时检查：0/100/1000 候选、固定 20 条观察，三轮 CPU 中位数，
  `inspect()` CPU 减少 46.35–52.81%，注册工具路径减少 33.90–37.34%；
  采样分配分别减少 34.94–43.10% 和 50.81–60.17%。
- 签名：100–1000 条，三轮 CPU 中位数，`runtimeSignature` CPU 减少
  28.06–46.25%，`signatureEqual` 减少 29.39–44.09%；采样分配减少
  14.73–39.43%。20 条仍沿用原排序，微小差异只视为噪声。
- 冷历史诊断：2000 条、16 KiB payload，三轮中位数的中位数，CPU
  77.442 → 46.114 ms（减少 40.45%），延迟减少 35.27%，采样分配减少
  33.52%。heapUsed 瞬时增量不作为内存下降证明。
- 事件桥恢复：50,000 条已认证事件、8 个 writer、约 27 MiB 日志，
  三轮中位数的中位数，CPU 253.085 → 222.496 ms（减少 12.09%），
  延迟减少 12.15%，采样分配减少 16.82%；独立新进程 maxRSS 中位数
  291,568 → 110,640 KiB（减少 62.05%）。完整日志仍逐条认证。

上述负载没有观察到既有收益退化，生产实现与第五轮一致。收益不能相加，
也不代表所有生产规模、冷 I/O、平台或宿主启动的收益。采样分配不是峰值堆，
heapUsed 增量不是分配量，maxRSS 是包含 runtime/imports 的进程高水位。
有效原始数据为 `final-domain-query-{baseline,candidate}.json`、
`final-runtime-inspect.json`、`final-runtime-signature.json`、
`final-diagnostics.json` 和 `final-event-bridge-evidence.json`。

```sh
rtk proxy node --expose-gc scripts/benchmarks/runtime-inspect.mjs
rtk proxy node --expose-gc scripts/benchmarks/runtime-signature.mjs
rtk proxy node --expose-gc scripts/benchmarks/diagnostics.mjs
rtk proxy node --expose-gc scripts/benchmarks/event-bridge-evidence.mjs
rtk proxy env BENCH_RECORDS=100 BENCH_PAYLOAD_BYTES=1048576 BENCH_LIMIT=50 BENCH_SAMPLES=15 BENCH_LEGACY_WINDOW=1 node --expose-gc scripts/benchmarks/domain-query.mjs
rtk proxy env BENCH_RECORDS=100 BENCH_PAYLOAD_BYTES=1048576 BENCH_LIMIT=50 BENCH_SAMPLES=15 node --expose-gc scripts/benchmarks/domain-query.mjs
```

## 最终验收

- 完整 `npm test`：205/205，0 failed、0 skipped。
- `pack:check`：16/16；重复打包字节一致，50 条目，权限 0644/0755。
- `release:verify`、SHA256SUMS 和 `--require-source-commit` 来源校验通过。
- 官方 `0.2.0-rc.2` 和 `0.2.1-alpha.1` 各 21/21 步通过，最终 doctor
  `healthy`。复用已安装的精确官方 runtime，每次 home 为全新临时合成目录。
  证据为 `docs/evidence/dsh-<host>.json`，均安装 `release/` 中同一固定字节。
- workflow 改为从 manifest 精确选择上传、下载和验证文件。实际 bash 步骤
  通过本地 gh 替身执行，故意加入无效历史 tarball，确认仅处理三个指定资产，
  下载字节经过真实 artifact verifier 和校验文件比较。没有访问 GitHub 写接口。

首轮测试在宿主证据刷新期间启动，且 workflow 两条旧断言要求通配符，失败
未计为通过。第二轮 204/205，新增 gh 替身在 ESM package 内使用 require
失败，修正为 ESM imports；第三轮 205/205。失败原因与机器可读最终证据
见 `docs/evidence/rc4-final-candidate.json`，没有跳过测试或放宽安全条件。

旧 pin 的双宿主证据原样保存为 `docs/evidence/rc3-pinned-dsh-*.json`；
原有三个未跟踪 rc.3 发布审计文件原样纳入源码提交。旧 tarball 从当前
`release/` 移出，但仍完整保存在原 Git 历史和历史发布中。

```sh
rtk proxy npm test
rtk proxy env npm_config_cache=/tmp/dsh-final-npm-cache npm run pack:check
rtk proxy npm run release:verify
rtk proxy node scripts/release/verify-provenance.mjs --require-source-commit
rtk proxy node scripts/acceptance/run-host-acceptance.mjs --host 0.2.0-rc.2 --tarball release/dsh-evolution-0.2.0-rc.4.tgz
rtk proxy node scripts/acceptance/run-host-acceptance.mjs --host 0.2.1-alpha.1 --tarball release/dsh-evolution-0.2.0-rc.4.tgz
```

当前本地候选无未解决的 pin 或验收阻塞。既有产品边界仍见 `RELEASE.md`：
内部宿主 API、advisory evaluator、合作式代码执行、懒加载期 trial 基线竞态、
密钥无轮换流程、历史 rc.1 provenance 不一致，以及无供应链签名。
本次仅验证当前本地环境；未执行远端 CI、创建 tag 或发布后匿名下载。
正式发布时仍须按原流程验证 tag、远端 CI 与上传后字节，不将未执行步骤算作通过。
