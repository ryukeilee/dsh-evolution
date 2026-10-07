# 官方 domain 观察写入性能

基线：`main` 的 `e64874f3781f4ecfb27a445d462a8ce865a02f6b`，初始工作树干净。
环境：Node `v26.10.0`、`darwin/arm64`。原始逐次结果保存在
[`domain-archive.json`](domain-archive.json)。

## 工作负载与结果

`scripts/benchmarks/domain-archive.mjs` 在临时目录生成 256 个已封存的
cycles 分段，每段一条带 1024 字节 summary 的记录，以及有效索引。
使用真实官方 `DomainFacility` 和 `JsonStorageBackend` 打开
`openDomainStorage`，预热一次后顺序执行七次 `port.observe()`。
计时包含归档复制、两次 memory 加载、schema 验证、fsync 和官方 domain
pending/final 提交；不包含 fixture 构建、首次启动和查询。
两侧使用完全相同的脚本和输入，各自创建全新临时目录。
脚本验证完整 cycles 历史、观察存在，以及关闭重开后的历史和观察恢复。

| 单次观察写入，中位数 | 优化前 | 优化后 | 减少 |
| --- | ---: | ---: | ---: |
| 耗时 | 2581.44 ms | 1481.53 ms | 42.61% |
| 进程 user + system CPU 时间 | 1273.93 ms | 259.68 ms | 79.62% |
| `readdirSync` 调用 | 1105 | 83 | 92.49% |

这是确定性合成归档上的真实运行路径测量，不是生产用户分布。
目录枚举计数包含事务复制和 fsync 遍历；它代表减少的文件系统元数据操作，
没有测量磁盘读写字节或物理 I/O。已有文件缓存和机器负载会影响耗时。
归档分段少时收益会更小；剩余复制、fsync 和事务成本仍然存在。

## 改动边界

`EvolutionMemory.#loadArchiveIndex()` 原先对每条索引记录至少重新枚举
同一 collection 的目录两次，并在线性文件列表中查找文件名。
现在每次加载只枚举每个相关 collection 一次，再按 basename 查找。
lookup 仅存活于本次加载；下一次加载仍从文件系统发现新增、轮转或修复后的分段。
保留无 collection 的旧索引推断顺序、未知 collection 的忽略行为，
以及后续 reconciliation 的 stat、校验和重建和失效条目清理。

没有修改官方 DSH 源码、事件处理、MAC 验证、持久化写入、fsync、
pending/final 提交、恢复流程或 mutation authority。

## 复现

在改动工作树运行：

```sh
rtk proxy node scripts/benchmarks/domain-archive.mjs
```

基线复现可导出该 commit 并复制同一 benchmark（依赖使用当前锁文件安装结果）：

```sh
rtk proxy sh -c '
task_baseline_dir=$(mktemp -d /tmp/dsh-evolution-baseline.XXXXXX)
git archive e64874f3781f4ecfb27a445d462a8ce865a02f6b | tar -x -C "$task_baseline_dir"
mkdir -p "$task_baseline_dir/scripts/benchmarks"
cp scripts/benchmarks/domain-archive.mjs "$task_baseline_dir/scripts/benchmarks/"
ln -s "$PWD/node_modules" "$task_baseline_dir/node_modules"
cd "$task_baseline_dir"
node scripts/benchmarks/domain-archive.mjs
'
```

可用 `BENCH_SEGMENTS` 和 `BENCH_SAMPLES` 调整规模；前后必须使用相同值。

## 回归验证

完整 `npm test`：164 项，162 通过，2 项发布固定点检查失败。
全部功能、安全、官方存储事务、故障恢复及新增归档索引回归均通过。
新增回归覆盖旧索引的 collection 推断、未知 collection 清理和下一次加载
发现后来创建的分段。

失败来自 `test/release-pin.test.mjs:54` 和 `:62`：修改后的源码内容与
已经发布并固定的 `0.2.0-rc.2` tarball 不再相同。这是发布一致性门禁，
不能通过改断言、跳过检查或伪造验收消除。现有发布产物与证据保持原样；
完整发布验收需要建立新候选、重跑两个官方宿主验收并更新固定点。
