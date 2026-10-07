# 四轮优化后的性能收口

## 结论

以干净的 `378f535` 为当前生产代码 baseline，保留前四轮成果。本轮没有修改
`lib/`、官方 DSH 源码或发布产物，也没有声称新增性能收益。
剩余可测成本主要是归档事务的完整复制与持久化、每次事件同步的全量认证、
完整历史查询的读取与解析。检查后未找到同时具有明确高收益和低风险的下一项，
因此停止生产代码优化。这个判断针对当前实现及已测工作负载，不意味着性能
已达到理论最优，也不意味着历史增长后的成本已经变成常数。

新增内容只有可选 benchmark I/O 归因、三轮 baseline 原始数据和本次验收证据。
前四轮同负载前后数据继续以原文档为准，不用跨轮、不同 fixture 的绝对值计算
累计百分比。

## 当前 baseline

环境：Node `v26.10.0`、`darwin/arm64`。使用已有真实官方
`DomainFacility` / `JsonStorageBackend` benchmark，每个进程创建独立临时合成
数据，计时排除 fixture、启动和恢复断言。原始记录见 [closure.json](closure.json)。
各工作负载顺序运行三轮；下列延迟/CPU 均为每个进程的样本中位数：

- 无归档分段的观察写入，7 次/进程：延迟 31.145 / 27.928 / 27.930 ms；
  CPU 8.624 / 8.208 / 8.734 ms。
- 256 个封存分段的观察写入，每段一条 1 KiB summary，7 次/进程：
  延迟 1459.194 / 1337.099 / 1478.435 ms；CPU 263.390 / 231.543 / 266.212 ms。
- 10,000 条已提交事件、无新事件的 `flush()`，15 次/进程：
  延迟 52.753 / 50.872 / 50.684 ms；CPU 53.317 / 51.582 / 51.434 ms。
- 50,000 条相同结构的已提交事件，15 次/进程：
  延迟 260.188 / 261.692 / 262.173 ms；CPU 287.231 / 288.757 / 289.478 ms。
- 5,000 条历史、每条 16 KiB summary，`query('cycles', 10)`，15 次/进程：
  延迟 55.918 / 55.762 / 55.609 ms；CPU 81.017 / 80.126 / 80.616 ms。

观察写入沿用原有一次预热；flush/query 沿用三次预热。全部脚本都检查返回内容
和关闭重开后的恢复结果。最初第一轮归档计时与验证命令重叠，已丢弃并在无其他
任务命令运行时补测；保留的数据没有这种重叠。没有把本轮 baseline 当作优化前后
对比，也没有测量生产分布、物理磁盘字节或峰值内存。

## 剩余瓶颈与停止依据

### 归档写入

对现有 `domain-archive.mjs` 增加 `BENCH_TRACE_IO=1`：仅用计时包装
`fs.cpSync` / `fs.fsyncSync`，仍执行每个原始操作；预热后逐样本重置计数。
计时本身有少量开销，因此归因数据只用于理解成本。

256 段负载每次有 4 次顶层 `cpSync` 和 518 次 `fsyncSync`。
三轮 fsync 耗时中位数为 1222.707 / 1129.155 / 1267.594 ms，约为对应
总延迟中位数的 83.8% / 84.4% / 85.7%；复制为
110.439 / 104.541 / 112.203 ms，约为 7.6% / 7.8% / 7.6%。
这些是阶段中位数与总中位数的比值，不是逐样本比例的中位数，也不包含官方
backend 内部其他持久化调用。无分段时仅有 6 次被计数的 fsync。

一次完整 benchmark 的 CPU profile 同样主要落在原生 `fsync`，其次为
`cpSyncCopyDir`；profile 包含启动/预热/断言/清理，不作为测量区间的生产占比。
实现已使用 `COPYFILE_FICLONE`，复制路径没有逐记录 JSON 处理。
即使完全消除现有复制阶段也只有约 8% 的延迟上限；没有证据证明替换原生复制
实现能获得接近这个上限的稳定收益，不引入新的手写文件复制实现。

大幅减少成本需要改为仅安装变更文件、共享不可变分段或新的归档 journal。
当前 pending 恢复按完整 staging 树重放；轮转、追加、修复和 compaction 也会
改变归档及索引。硬链接或跳过同步不能直接保持文件隔离与故障恢复语义。
这些是潜在高收益的协议设计方向，但当前没有经过验证的低风险方案，本轮不改。

### 频繁 agent step 的同步

`agent/pre-step` 和工具结束仍调用 `flush()`；每次读取完整文件、解析并逐条
执行 MAC、writer、同 ID/MAC 冲突检查。50,000 条负载已达约 262 ms/step，
仍随总历史字节线性增长。现有 applied 标记只证明领域提交，不能证明当前文件
未被篡改，因此不能用已提交状态、文件大小或 mtime 来免除历史认证。
增量读取/认证缓存需要证明原前缀未变化及跨进程/重启正确性；只检查 metadata
不足以维持现有安全边界。事件截断/归档则需要设计事件审计保留及重启 sequence
与去重协议。本轮没有这样的证据，保留全量验证。

### 查询与其他日常路径

窗口深拷贝已解决；剩余成本是全量文件读取、JSON 解析和最新值/墓碑合并。
仅缓存 count/尾部不能直接保持重复 ID 更新、hot 覆盖、损坏尾行与墓碑语义，
跨查询缓存还需处理恢复、轮转、修复和数据新鲜性。5,000 条大 payload 的查询
约 56 ms，当前缺少生产频率和其他可复现高收益证据，不为它新增缓存协议。

写入 housekeeping、普通 source observation 和 supervisor history 都已有
有界热池/历史限制；官方端口的 memory 热池默认 50 条。完整 snapshot、
retention/compaction 仍可能随历史增长变慢，但它们并非已测的每 step 主热点；
没有用假设的大 payload 宣称日常流程收益，也未重复前四轮的优化方向。

## 已完成收益

- [归档索引](domain-archive.md)：256 段观察写入延迟下降 42.61%，CPU 下降
  79.62%，目录枚举下降 92.49%。
- [事件同步](domain-replay.md)：1,000–50,000 条事件同负载三轮延迟下降
  18.31–24.17%，CPU 下降 17.07–24.14%。
- [查询窗口](domain-query.md)：三种负载同负载三轮延迟下降
  21.59–48.45%，CPU 下降 30.01–49.44%。
- [认证分配](domain-authentication.md)：三种负载同负载三轮延迟下降
  11.97–19.34%，CPU 下降 11.92–19.64%。

这些收益不相加：各轮 baseline、规模与被测路径不同。

## 复现

将下列每项独立执行三次；不要与其他测试或宿主验收并行：

```sh
rtk proxy env BENCH_SEGMENTS=0 BENCH_TRACE_IO=1 node scripts/benchmarks/domain-archive.mjs
rtk proxy env BENCH_SEGMENTS=256 BENCH_TRACE_IO=1 node scripts/benchmarks/domain-archive.mjs
rtk proxy env BENCH_EVENTS=10000 node scripts/benchmarks/domain-authentication.mjs
rtk proxy env BENCH_EVENTS=50000 node scripts/benchmarks/domain-authentication.mjs
rtk proxy env BENCH_RECORDS=5000 BENCH_PAYLOAD_BYTES=16384 node scripts/benchmarks/domain-query.mjs
```

归档 profile：

```sh
rtk proxy node --cpu-prof --cpu-prof-dir=/tmp scripts/benchmarks/domain-archive.mjs
```

## 验收

完整 `npm test` 168/168 通过，无 skipped；`pack:check` 16 项全部通过；
`release:verify` 校验 48 个条目、权限、字节摘要和内容摘要通过。
包装检查首次因默认 npm cache 的 `EPERM` 失败，使用全新临时 cache 后通过，
未修改原 cache 或降低断言。

官方 DSH `0.2.0-rc.2`、`0.2.1-alpha.1` 均为 21/21 步通过，包括数据保留、
卸载重装、升级回滚、promotion 跨重启和 canary 回滚；本轮独立证据见
[rc.2](../evidence/closure-dsh-0.2.0-rc.2.json) 与
[alpha.1](../evidence/closure-dsh-0.2.1-alpha.1.json)。
首次两次验收在沙箱内官方 CLI 安装插件时 `fetch failed`，尚未进入功能验收；
失败记录保存在 [closure-host-install-failures.json](closure-host-install-failures.json)。
允许验收命令网络访问后，在另外两个全新 home 完整通过，没有把失败当作通过。
复用的仅是先前临时目录的官方依赖
runtime，验收 home 与所有 Evolution 数据均全新；使用现有固定产物
`release/dsh-evolution-0.2.0-rc.3.tgz`，不覆盖前四轮原始证据。
产物 SHA-256 为 `9476968d070e7c7fcca746b85d28ac505b303f63053ca89484a5e9c86bcce07f`。
本轮未进行外部发布。
