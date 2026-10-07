# 事件认证规范化的分配优化

基线为最新干净代码 `66809bd`，已包含归档索引目录枚举、事件同步重复 JSON
解析、领域查询窗口深拷贝三轮优化。候选源码提交为
`b856fea`。环境：Node `v26.10.0`，`darwin/arm64`。
原始 270 次计时见 [domain-authentication.json](domain-authentication.json)。

## 热点与实现

检查写入 housekeeping 后发现官方领域端口默认热池只有 50 条，其积压去重
收益边界较窄，因此没有修改这条路径。对当前官方领域端口的 10,000 条已提交
事件同步进行 CPU profile：完整 benchmark 进程中 `canonicalBridgeJson` 有
304 个直接采样，其对象映射回调有 97 个，`Hmac` 157 个，`digest` 99 个，
GC 37 个。这包含 fixture 签名、启动与测量，不是生产用户负载占比。
规范化是每条 HMAC 必须经过的真实路径，也是前三轮优化后仍在执行的工作。

改动仅在插件 `lib/orchestrator.js`：用循环拼接代替递归容器的 `map/join`，
减少临时数组；对重复属性名的 JSON 转义做有界 memoization，最多 128 项、
每个原始键最多 64 个 UTF-16 单元。缓存不保存事件值、签名、密钥或认证结果，
不因缓存命中跳过任何验证。未知/超长键仍使用 `JSON.stringify`。
字典键仍逐对象按原有词典顺序排序，数组位置、holes 和 undefined 的旧编码保留。
HMAC、恒定时间比较、writer 校验、冲突判断、事务、fsync、pending/final 提交、
恢复与官方 DSH 源码均未修改。

## 同负载三轮对比

脚本使用真实官方 `DomainFacility` / `JsonStorageBackend`，在临时目录创建
固定事件、有效签名与已提交标记；预热 3 次，每轮测量 15 次 `port.flush()`。
两侧复用相同脚本和锁文件依赖，第一/三轮基线先运行、第二轮候选先运行。
计时包含文件读取、JSON 解析、完整认证和标记查询；fixture、启动及断言不计时。
每次断言全部事件被识别为已提交，关闭重开后再次验证。
嵌套证据模拟每条事件中 8 组组件 before/after 指标与 recovery stages，
用于量化容器较多的负载边界，不声称它是生产分布。

以下为三个进程中位数的中位数；改善区间来自各轮配对中位数。

| 事件数 / 嵌套证据组数 | 基线延迟 | 候选延迟 | 各轮延迟下降 | 基线 CPU | 候选 CPU | 各轮 CPU 下降 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 / 0 | 6.212 ms | 5.332 ms | 12.64–15.34% | 6.461 ms | 5.571 ms | 11.97–16.75% |
| 10,000 / 0 | 58.613 ms | 51.594 ms | 11.97–12.66% | 59.436 ms | 52.350 ms | 11.92–12.51% |
| 10,000 / 8 | 238.550 ms | 192.457 ms | 18.48–19.34% | 240.827 ms | 193.537 ms | 18.52–19.64% |

所有九组配对均改善。历史事件多、每个 agent step 同步历史、证据嵌套容器多时
更有用；少量事件、LLM 等待或事务写入主导时端到端收益有限。
仍逐条读取、解析、认证全部历史，复杂度仍为 O(总历史字节)，不改变文件读取
字节数，不减少 fsync/提交次数；没有量化峰值内存或声称磁盘 I/O 改善。
OS cache、GC 和机器负载会影响绝对时间，因此同时记录多轮 CPU 与延迟。

## 复现

```sh
rtk proxy node scripts/benchmarks/domain-authentication.mjs
rtk proxy env BENCH_EVENTS=1000 node scripts/benchmarks/domain-authentication.mjs
rtk proxy env BENCH_EVENTS=10000 BENCH_EVIDENCE_ROWS=8 node scripts/benchmarks/domain-authentication.mjs
```

默认 `BENCH_EVENTS=10000`、`BENCH_EVIDENCE_ROWS=0`、`BENCH_SAMPLES=15`。
导出基线后复制同一脚本并使用同一依赖：

```sh
rtk proxy sh -c '
task_baseline_dir=$(mktemp -d /tmp/dsh-auth-baseline.XXXXXX)
git archive 66809bd | tar -x -C "$task_baseline_dir"
cp scripts/benchmarks/domain-authentication.mjs "$task_baseline_dir/scripts/benchmarks/"
ln -s "$PWD/node_modules" "$task_baseline_dir/node_modules"
node "$task_baseline_dir/scripts/benchmarks/domain-authentication.mjs"
'
```

## 正确性与验收

新增回归使用冻结的旧编码器独立计算 HMAC，比较实际签名字节并验证旧签名，
覆盖词典/整数键顺序、特殊键、Unicode/孤立代理项、嵌套容器、holes、undefined、
特殊数值和缓存容量之外的 400 个不同键；每个样例均检查篡改后拒绝。
独立审查额外比较 10,000 个嵌套样例，并验证错误密钥与缓存预热后的篡改拒绝。
所有数据均为临时合成数据，不读取真实用户 Evolution 数据。

完整 `npm test` 168/168 通过（无 skipped），`pack:check` 16 项通过；
`release:verify` 的 48 个条目、权限和字节/内容摘要通过。
官方 DSH `0.2.0-rc.2`、`0.2.1-alpha.1` 各 21/21 步通过，覆盖核心工具、
禁用启用、卸载重装与数据保留、升级回滚、promotion 跨重启和 canary 回滚。
原始验收证据见 [rc.2](../evidence/dsh-0.2.0-rc.2.json) 和
[alpha.1](../evidence/dsh-0.2.1-alpha.1.json)。仅复用前轮安装的官方依赖 runtime，
两个验收 home 均全新且使用当前 tarball，不修改宿主源码。

本地候选：`release/dsh-evolution-0.2.0-rc.3.tgz`。
SHA-256：`9476968d070e7c7fcca746b85d28ac505b303f63053ca89484a5e9c86bcce07f`。
源码完整提交：`b856fea4070791de8182d8ea94775692e145f230`。
更新的只是本地候选固定点，没有外部发布。

初次本地提交因 `.git/index.lock` 沙箱权限失败，获准后完成；初次打包因默认
npm cache 写权限失败，改用临时 cache 后成功。初次两个宿主安装均因沙箱网络
`fetch failed` 失败，保留在
[安装失败记录](domain-authentication-host-install-failures.json)；放开验收命令网络
权限后在另两个全新 home 完整通过，没有将失败当作通过。

CPU profile 复现（fixture/启动也在 profile 中）：

```sh
rtk proxy env BENCH_EVENTS=10000 BENCH_SAMPLES=20 node --cpu-prof --cpu-prof-dir=/tmp scripts/benchmarks/domain-authentication.mjs
```
