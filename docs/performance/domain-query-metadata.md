# evolution_history 元数据投影优化

基线为 `0944cc12e7fe7356125a38cd850becbd63bb1650`。该版本的
`historyWindow()` 已只深拷贝尾部窗口，但领域端口最终只使用
`id`、`status`、`eventType`、`recordedAt`，仍拷贝窗口中的大 payload。

领域端口现在使用内部 `metadataOnly` 选项，在深拷贝前提取这四个字段。
默认 `historyWindow()`、`history()`、`fullSnapshot()` 仍返回完整、隔离的记录。
投影自身仍深拷贝，以保留旧 JSON 数据中对象/数组型 `recordedAt` 的隔离语义。
`domain-storage.js` 中原有标识符和时间字段安全校验保持原样。
完整历史读取、排序/合并顺序、最新值覆盖、去重、墓碑、计数和损坏尾行处理
复用既有实现；没有跨查询缓存、持久化协议变化或官方 DSH 修改。

## 性能证据

Node `v26.10.0`，`darwin/arm64`，真实官方 `DomainFacility` 与
`JsonStorageBackend`，全新临时合成历史。100 条记录，每条 summary 1 MiB，
返回 50 条；每个进程预热 3 次，采样 15 次。三轮交替基线/候选先后顺序。
基线通过忽略内部第三参数复现原查询路径，两侧使用同一实现、依赖和 fixture。
每次验证完整计数、窗口 ID 和 payload 不进入输出，另验证关闭重开。
原始结果见 [domain-query-metadata.json](domain-query-metadata.json)。

三个进程中位数的中位数：CPU 从 86.618 ms 降到 73.884 ms，减少 14.70%；
延迟从 71.981 ms 降到 66.332 ms，减少 7.85%。三轮 CPU 降幅
13.91–19.79%，延迟降幅 7.85–14.03%。

每次查询仍有 50 次深拷贝，但送入深拷贝的 JSON 表示从 52,433,300 字节
降到 3,850 字节。这个计数在独立的非计时查询中采集，不把序列化计数成本
混入性能测量。启用 `--expose-gc`，每次计时前 GC；查询前后 `heapUsed`
差值中位数从 157,349,024 降到 104,978,288 字节，减少约 50 MiB / 33.28%。
该差值是查询后的瞬时堆增量，并非累计分配或峰值堆测量；GC、运行环境会
影响它。深拷贝输入减少与堆差值共同验证大 payload 复制已移除。

仍需全量读取与 JSON 解析，因此查询仍为 O(历史字节数)，没有减少磁盘 I/O。
此负载针对大记录和较大返回窗口；小记录、小窗口或写入主导场景收益较小。

## 复现

```sh
rtk proxy env BENCH_RECORDS=100 BENCH_PAYLOAD_BYTES=1048576 BENCH_LIMIT=50 BENCH_SAMPLES=15 BENCH_LEGACY_WINDOW=1 node --expose-gc scripts/benchmarks/domain-query.mjs
rtk proxy env BENCH_RECORDS=100 BENCH_PAYLOAD_BYTES=1048576 BENCH_LIMIT=50 BENCH_SAMPLES=15 node --expose-gc scripts/benchmarks/domain-query.mjs
```

新增回归覆盖全部八个领域集合、limit 边界、非法标识符、旧数据数组时间字段、
重复 ID、非时间排序记录、墓碑、匿名记录、损坏尾行、返回值隔离及 payload
未进入深拷贝。与原路径逐项 `deepEqual` 比较；完整历史回归继续保留。

## 验收状态

当前工作树 `npm test` 为 186/188：功能回归与新增回归全部通过，
两项失败均为 `test/release-pin.test.mjs` 的源码/已发布制品一致性断言。
`pack:check` 亦因既有 release pin 和验收证据仍指向旧制品而失败。
这些失败没有计作通过；本次没有改写仓库已发布制品、pin 或旧验收证据。

候选制品独立打包成功，重复打包字节一致、48 个条目及内容检查通过。
候选内容摘要为 `9fdf7c06b289c8ce2f9412325aa4accab25f64441a7b36e4c5a7f397cc55e140`。
官方宿主 `0.2.0-rc.2` 和 `0.2.1-alpha.1` 均为 21/21 步通过，
覆盖核心工具、禁用启用、卸载重装与数据保留、升级回滚、跨重启 promotion
以及 canary 回滚。制品源码逐字节确认与工作树一致。原始证据及首次安装失败
见 [domain-query-metadata-hosts.json](domain-query-metadata-hosts.json)。

首次沙箱内依赖安装与宿主插件安装因 registry.npmmirror.com 的
`ENOTFOUND` 失败；受控联网重试成功。打包首次因默认 npm 缓存写权限
`EPERM` 失败，改用临时缓存后成功。测试复用的官方依赖和宿主 runtime
来自此前临时验收目录，所有历史 fixture 与本次宿主 home 均为全新合成数据。
没有访问真实用户 Evolution 数据、修改官方 DSH 或进行外部发布。
