# 官方领域查询的窗口深拷贝优化

基线为最新干净代码 `fdb6c5d`，包含前两轮优化。环境为 Node
`v26.10.0`、`darwin/arm64`。原始 270 次计时见
[domain-query.json](domain-query.json)。

## 热点与改动

官方领域端口 `query()` 返回完整 count 和最多 50 条安全 DTO，但原先
`memory.history()` 先深拷贝完整历史，包括最终不会返回的 summary/evidence。
2,000 条、每条 16 KiB 合成历史的基线完整 benchmark 进程 CPU profile 中，`structuredClone`
有 52 个直接采样，GC 有 91 个；主要剩余成本是全量读取和 JSON 解析。
这是官方工具查询的真实运行路径，不代表生产用户负载分布。

新增 `historyWindow()`，复用同一私有历史合并实现，在确定 count 和窗口后
只深拷贝窗口记录。原有 `history()` / `fullSnapshot()` 行为不变。
原始引用不离开私有方法；返回记录仍为 detached 深拷贝。
完整读取、同 ID 最新值/首次位置、hot 覆盖、墓碑和损坏尾行处理均保持。
没有新增跨查询缓存，也没有修改目录枚举、事件解析、认证、写入、fsync、
pending/final 提交、恢复流程或官方 DSH 源码。

## 同负载三轮对比

脚本在全新临时目录构建固定时间的 cycles 历史，以真实官方
`DomainFacility` / `JsonStorageBackend` 打开端口，预热三次后测量十五次
`port.query('cycles', 10)`；计时包含读取、解析、合并、拷贝和安全 DTO。
fixture、启动、断言和关闭重开不计时。每次验证完整 count、尾部 ID、
负载不会进入 DTO，关闭重开后再次验证历史计数。

每个规模做三轮；第一/三轮基线先运行，第二轮候选先运行；两侧同脚本、
同参数、同依赖。以下汇总为三个进程中位数的中位数。

| 历史条数 / 每条 summary | 基线延迟 | 优化延迟 | 每轮延迟减少 | 基线 CPU | 优化 CPU | 每轮 CPU 减少 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 / 1 KiB | 2.081 ms | 1.102 ms | 44.87–48.45% | 2.138 ms | 1.158 ms | 45.66–49.44% |
| 2,000 / 16 KiB | 28.850 ms | 22.448 ms | 21.59–23.71% | 45.255 ms | 29.694 ms | 34.06–34.67% |
| 5,000 / 16 KiB | 73.576 ms | 55.482 ms | 24.06–25.27% | 115.482 ms | 80.213 ms | 30.01–30.94% |

九组均改善。历史远大于返回窗口、查询频繁时更有用；小历史或完整历史
API 不受益，LLM/事务写入占主导的端到端场景收益有限。
仍然全量读取和解析，复杂度为 O(历史条数/字节数)，不是恒定成本查询。
两侧目录枚举均为一次；没有声称减少磁盘 I/O 或量化峰值内存。
OS 文件缓存、GC 和机器负载影响绝对时间，故同时报告多轮 CPU 和延迟。

## 复现

```sh
rtk proxy node scripts/benchmarks/domain-query.mjs
rtk proxy env BENCH_RECORDS=5000 BENCH_PAYLOAD_BYTES=16384 node scripts/benchmarks/domain-query.mjs
```

默认 `BENCH_RECORDS=2000`、`BENCH_PAYLOAD_BYTES=16384`、`BENCH_SAMPLES=15`。
基线导出到独立临时目录，再复制同一脚本并复用当前锁文件依赖：

```sh
rtk proxy sh -c '
task_baseline_dir=$(mktemp -d /tmp/dsh-query-baseline.XXXXXX)
git archive fdb6c5d | tar -x -C "$task_baseline_dir"
cp scripts/benchmarks/domain-query.mjs "$task_baseline_dir/scripts/benchmarks/"
ln -s "$PWD/node_modules" "$task_baseline_dir/node_modules"
node "$task_baseline_dir/scripts/benchmarks/domain-query.mjs"
'
```

## 验收

新增回归对比既有 full-history 输出，覆盖窗口边界、重复 ID 更新、墓碑、
损坏尾行、返回值嵌套隔离与关闭重开。官方领域原有事务、认证及恢复回归保留。
最终完整 `npm test` 166/166 通过，`pack:check` 16 项通过，
`release:verify` 的 48 个条目、权限和全部字节/内容摘要通过。
官方 DSH `0.2.0-rc.2`、`0.2.1-alpha.1` 各 21/21 步通过，覆盖核心工具、
禁用启用、卸载重装与数据保留、升级回滚、promotion 跨重启和 canary 回滚。
原始证据见 [rc.2](../evidence/dsh-0.2.0-rc.2.json) 和
[alpha.1](../evidence/dsh-0.2.1-alpha.1.json)。

源码提交：`bda48237908ec194c2e246c5b811bb75e065a81b`。
本地候选：`release/dsh-evolution-0.2.0-rc.3.tgz`。
SHA-256：`b7e099946ed91345787bd130d80345fa56ab56166d5cd016c53c95b080ab5588`。
全部 fixture 和宿主 home 为临时合成数据；复用的仅为前轮官方依赖 runtime。
没有读取真实用户 Evolution 数据，没有修改官方源码或外部发布。
源码本地提交首次因沙箱 `.git/index.lock` 权限失败，获准后成功；
没有将失败记录算作通过。
