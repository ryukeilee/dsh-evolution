# evolution_doctor 冷历史诊断优化

三轮既有优化完整提交为基线 `8e6bd29`：领域查询元数据投影、运行时检查投影、
runtimeSignature 排序键复用。原测试、冻结实现、基准、独立复测及双宿主证据均保留。
对应记录为 `domain-query-metadata.md`、`runtime-inspect.md`、`runtime-signature.md`。
基线源码内容摘要为 `1e70b88f30e370d01a33e62e73af9d7dbf19c33b8095bcb04e38cd37aada15d4`；
本次复核基线 `npm test` 为 195/197，两项失败均来自既有发布 pin 一致性要求。
三个原有未跟踪 `docs/evidence/rc3-*` 发布证据保持原样，未纳入性能提交。

## 改动范围

`dockyard/state.json` 原来在同一轮诊断中完整读取和解析两次，现在读取一次，
立即生成 legacy 计数检查，按原检查顺序加入报告。只保留小型检查摘要，不让
完整 aggregate 跨诊断步骤存活；两个检查观察同一次读取，没有跨调用缓存。
下一轮诊断及修复后复核均重新读取。并发改写文件时，诊断本来就不是原子快照，
现在这两个只读检查使用同一份内容；安全判断及修复没有复用这一摘要。

冷历史 JSONL 完整性检查改为逐行解析并累计错误数，不再生成全量行数组、
记录数组、错误数组，也不保留解析后的历史 payload。每一条非空行仍执行
`JSON.parse`，行数、空行、CRLF、错误计数和未终止尾行判定与原路径一致。
磁盘文件仍完整读取，不是流式 I/O；扫描复杂度仍为 O(历史字节数)。
公开 `inspectJsonLines()`、事件桥签名验证、领域 schema、安全边界、
修复前重新读取及修复后复核路径均保留。没有修改官方 DSH、依赖或功能。

## 可复现性能

```sh
rtk proxy node --expose-gc scripts/benchmarks/diagnostics.mjs
rtk proxy node --test test/diagnostics-performance.test.mjs test/diagnostics.test.mjs
rtk proxy npm test
```

冻结基线 `test/fixtures/diagnostics.mjs` 来自 `8e6bd29:lib/diagnostics.js`，仅调整
模块相对路径及 `PACKAGE_ROOT`；已验证与该提交在这些路径替换后逐字节一致。
基准先比较整个报告（仅去掉 `generatedAt`），再对完整 `collectDiagnostics()`
路径测量，宿主 dump-config 不执行。工具使用同一诊断实现；性能数字不包含
工具包装、宿主启动或 dump-config 子进程开销。

Node `v26.10.0` / `darwin/arm64`，全新临时合成 home，2000 条记录，
每条 payload 16 KiB；aggregate 和 JSONL 各约 31 MiB。
每路径预热 3 次、采样 9 次，三轮交替基线/候选次序，计时前 GC。
首个进程三轮中位数的中位数：CPU 76.605 → 45.414 ms（减少 40.72%），
延迟 59.703 → 38.574 ms（减少 35.39%）。
独立进程复测：CPU 76.546 → 45.212 ms（减少 40.93%），
延迟 59.491 → 38.324 ms（减少 35.58%）。
原始数据为 `diagnostics.json` 和 `diagnostics-repeat.json`。

独立于 CPU 计时的 V8 HeapProfiler 分配采样，间隔 32768 字节，包含 major/minor
GC 已回收对象；每轮每路径 5 次，三轮交替顺序。采样字节/次的中位数为
117,733,931 → 78,890,262（减少 32.99%）。这是分配量估计，不是峰值 RSS。
瞬时 `heapUsed` 增量反而约增加 10.6%–10.8%，受中途 GC 和对象存活时间影响，
不作为内存下降证据，也不声称峰值堆下降。实际收益主要面向含较大 legacy
aggregate 及冷历史的诊断；没有这些文件的小型安装收益有限。

## 回归、宿主与发布边界

专项测试 38/38 通过，差分覆盖缺失/损坏/null/无 evolution/正常 aggregate，
空文件、空行、CRLF、完整/损坏/未终止 JSONL、只读原文件不变、单轮读取次数、
下一轮改写与删除可见性。原有 MAC 错误、冲突 eventId、schema、安全边界、
修复幂等性、活锁拒绝修复、晋升恢复和 CLI 回归保留并通过。
完整 `npm test` 为 196/198：新增及已有功能回归全通过；仍只有
`test/release-pin.test.mjs:54` 和 `:62` 两项源码与旧发布制品一致性失败。

候选在 `/tmp/dsh-doctor-dist` 独立打包，两次字节一致，50 个条目、内容和模式检查通过。
`contentSha256: aeb42b4bb74b7cde2cfca9ea415974321ddce5630520608abf55f329c3af143f`；
`tarballSha256: ece1ae106d3dd9c1f43805cbd95f586b0702cdd071f92a8db07f04fb22416a85`。
官方 `0.2.0-rc.2` 和 `0.2.1-alpha.1` 各 21/21 步通过，均验证上述同一候选。
覆盖实际诊断、核心工具、禁用启用、卸载重装数据保留、升级回滚、跨重启晋升回滚。
证据为 `diagnostics-host-rc2.json` 和 `diagnostics-host-alpha.json`。
复用已准备的官方 runtime，每次 home 为全新临时合成目录。

```sh
rtk proxy env npm_config_cache=/tmp/dsh-doctor-npm-cache node scripts/release/pack.mjs --dist /tmp/dsh-doctor-dist
rtk proxy node scripts/acceptance/run-host-acceptance.mjs --host 0.2.0-rc.2 --runtime /tmp/dsh-evolution-rc3-accept-rc2/runtime --tarball /tmp/dsh-doctor-dist/dsh-evolution-0.2.0-rc.3.tgz --out /tmp/doctor-rc2.json
rtk proxy node scripts/acceptance/run-host-acceptance.mjs --host 0.2.1-alpha.1 --runtime /tmp/dsh-evolution-rc3-accept-alpha/runtime --tarball /tmp/dsh-doctor-dist/dsh-evolution-0.2.0-rc.3.tgz --out /tmp/doctor-alpha.json
```

首次沙箱内双宿主均在插件安装阶段 `fetch failed`，受控联网重试后通过；首次
失败完整保留于 `diagnostics-host-install-failures.json`，没有计作通过。
`pack:check` 仅剩基线已存在的三类发布一致性失败：旧宿主发布证据、旧 manifest pin、
源码与旧制品不一致。其他包检查通过。旧 pin 内容仍为
`d4bec3181f4addad50f32dfee278478134891da15f66626f7c9caa2544957358`。
没有更新发布 pin、固定制品或旧发布验收证据，没有外部发布或访问真实用户数据。
