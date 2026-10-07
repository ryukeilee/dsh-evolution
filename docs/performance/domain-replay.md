# 日常事件同步的重复处理开销

基线为最新干净代码 `a59aa34`，已包含上一轮归档索引优化。
环境：Node `v26.10.0`，`darwin/arm64`。
原始 270 次计时见 [domain-replay.json](domain-replay.json)。

`registration.js` 在 `agent/pre-step` 和工具结束时调用 `domainStorage.flush()`。
它重新读取完整事件历史并验证 MAC。CPU profile 显示 replay、canonical
JSON 和 HMAC 为主要成本；基线还对每行解析两次，并为已提交事件构造完整
DTO（标识符、指标、failure、audit 等），随后立即丢弃。
本次只移除第二次解析，并把 DTO 构造移到已提交标记检查之后。
保留每条记录的 MAC、writer 验证和同 ID 不同 MAC 冲突拒绝。
没有缓存认证结果、跳过文件读取或改变事务、fsync、恢复和官方源码。

## 同负载对比

脚本使用真实官方 `DomainFacility` / `JsonStorageBackend`，生成固定时间、
有效签名的历史和已提交标记，通过官方 global.set 持久化 fixture。
它测量真实 `port.flush()`，包含读取、解析、认证、冲突检查和去重；
不含 fixture 构建、启动和新事件提交。重开后也验证相同去重结果。
这代表已积累历史的日常无新事件 agent step，非用户生产分布。

三个规模各做三轮；每轮先基线后候选，每个进程预热三次、测量十五次，
两侧运行同一脚本和参数、使用全新临时目录。下表为三个轮次中位数的中位数。

| 历史事件 | 基线耗时 | 优化耗时 | 各轮耗时减少 | 基线 CPU | 优化 CPU | 各轮 CPU 减少 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 7.75 ms | 6.08 ms | 18.47–24.17% | 8.10 ms | 6.37 ms | 17.07–24.14% |
| 10,000 | 74.85 ms | 58.73 ms | 18.31–23.03% | 75.61 ms | 59.59 ms | 17.95–23.09% |
| 50,000 | 372.88 ms | 298.46 ms | 18.96–20.66% | 402.82 ms | 329.28 ms | 17.17–18.81% |

九组对比均有改善，每次同步约节省 1.7 / 16.1 / 74.4 ms。
历史越多、无新事件同步越频繁，累计收益越大。新事件仍走原有 DTO 和
完整单事件事务；在新事件的磁盘提交或 LLM 延迟主导时，端到端收益更小。
全量 MAC 验证仍是主要剩余 CPU 成本；没有声称物理磁盘 I/O 降低。
文件缓存、机器负载和固定前后顺序可能影响耗时，CPU 数据及多轮结果一起报告。

## 复现

```sh
rtk proxy node scripts/benchmarks/domain-replay.mjs
rtk proxy env BENCH_EVENTS=50000 node scripts/benchmarks/domain-replay.mjs
```

基线导出到新临时目录，复制同一脚本并复用锁文件安装的依赖：

```sh
rtk proxy sh -c '
task_baseline_dir=$(mktemp -d /tmp/dsh-replay-baseline.XXXXXX)
git archive a59aa34 | tar -x -C "$task_baseline_dir"
cp scripts/benchmarks/domain-replay.mjs "$task_baseline_dir/scripts/benchmarks/"
ln -s "$PWD/node_modules" "$task_baseline_dir/node_modules"
node "$task_baseline_dir/scripts/benchmarks/domain-replay.mjs"
'
```

`BENCH_EVENTS` 默认 10000，`BENCH_SAMPLES` 默认 15；前后必须相同。

## 可靠性验收

新增官方领域回归覆盖已提交重复事件仍认证、篡改、错误 writer 和合法签名
同 ID 冲突拒绝。原有单事件提交、pending 恢复、重启去重和只读 DTO 测试保留。
最终完整测试、打包校验及双宿主验收结果随本地固定点更新记录。
所有负载和宿主 home 均为临时合成数据，未访问真实用户 Evolution 数据。
