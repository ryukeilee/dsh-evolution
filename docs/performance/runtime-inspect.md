# 运行时检查与提案基线采集

`inspect()` 对普通观察记录和候选项直接完成一次隔离复制与 JSON
投影，避免先 `structuredClone()` 再投影。共享引用、访问器、循环、
特殊实例、稀疏数组及不可克隆值仍走原有转换路径。
`evolution_runtime_inspect` 对普通结果直接返回已隔离的投影结果。
对于原投影器保留的异常原型或 Error 元数据，仍保留旧的二次投影。
提案仍保存完整检查基线，恢复签名、数据保留范围和安全门不变。

可复现命令：

```sh
node --test test/runtime-inspect.test.mjs
node --expose-gc scripts/benchmarks/runtime-inspect.mjs
npm test
```

基准中的 `legacyInspect` 保留优化前实现；每个场景先逐字段比较输出。
固定 20 条观察记录，分别测量 0、100、1000 个候选项。
CPU 使用三轮交替顺序测量的 `process.cpuUsage()` 中位数。
内存使用独立的 V8 HeapProfiler 分配采样，采样间隔 1024 字节，
包含已被 major/minor GC 回收的对象；这是分配量估计，不是峰值 RSS。
CPU 测量不启用分配采样。原始数据见 `runtime-inspect.json`。

本机 Node v26.10.0 / darwin-arm64：`inspect()` CPU 降低 46.4%–52.2%，
采样分配量降低 34.5%–43.5%；注册检查路径 CPU 降低 34.1%–42.4%，
采样分配量降低 50.6%–60.1%。注册路径测量实际工具执行包装器；
所有路径均等待返回值，CPU 数据包括这项相同的等待开销。
结果仅代表这个合成负载和环境。
提案基线使用同一 `inspect()` 路径；基准没有将提案事件写盘成本计入。

差分回归覆盖完整输出、宿主数据与基线隔离、注册层单次投影、
共享引用、访问器、循环、类实例、Date、Error、Map、Set、TypedArray、
非有限数、负零、undefined、bigint、稀疏数组及 DataCloneError。
全套 192 项测试中 190 项通过，仅两项源码与发布产物 pin 一致性检查失败。
它们检查工作树必须等于已发布字节；本次修改了源码，按任务约束不更新 pin。

最终打包产物在官方 `0.2.0-rc.2` 和 `0.2.1-alpha.1` 两个宿主中均通过
完整 21 步验收，包含核心检查/提案/试验/测量/恢复、晋升和重启回滚。
证据见 `runtime-inspect-hosts.json`，两个宿主均验证同一最终产物
`contentSha256: bfff037e42183544fb89a0ec9dc122f52af966e3c1f5cc758dbbe2c615ac4521`。
仅在临时目录安装官方宿主和本地 tarball，没有修改官方 DSH 或发布 pin。

```sh
node scripts/release/pack.mjs --dist /tmp/dsh-runtime-inspect-dist
node scripts/acceptance/run-host-acceptance.mjs --host 0.2.0-rc.2 --tarball /tmp/dsh-runtime-inspect-dist/dsh-evolution-0.2.0-rc.3.tgz --out /tmp/runtime-inspect-rc.json
node scripts/acceptance/run-host-acceptance.mjs --host 0.2.1-alpha.1 --tarball /tmp/dsh-runtime-inspect-dist/dsh-evolution-0.2.0-rc.3.tgz --out /tmp/runtime-inspect-alpha.json
```
