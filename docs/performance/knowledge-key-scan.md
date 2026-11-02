# 长期知识匹配：当前 main 的键表扫描实验

基线为 `265ef9a1250521b70b8597887212c2ae3d75f7e6`，不是旧发布包。
所有实验使用合成临时数据根、官方 `DomainFacility` / `JsonStorageBackend` 和公开
`openDomainStorage()` → `port.observe()`；没有访问正式 home 或密钥。

## 当前实现与历史成本

当前源码已经解决了为一次查找深拷贝完整 history、每次读取重新解析全部冷行、
逐冷行重新计算知识身份，以及一次 append 重复查找同一个 accumulator 等历史成本。
这些历史报告中的收益不能算作本轮收益。

真实剩余工作包括 `#knowledgeEntryFor()` 与 `#sourceMatches()` 每次遍历归档键表。
来源匹配仍必须接受 stored key 或 derived key 任一命中，canonical knowledge 只比较
stored key / id；热覆盖、墓碑及首次位置顺序不能改变。
`#archiveRead()` 命中后还会经 `#adoptArchiveRead()` 重建实例自己的 known / tombstone
集合；继承时的摘要读取、活动档案索引协调、事务 staging / commit / hydrate 也仍存在。
本实验没有绕过这些步骤，因此不是把全部 O(N) 成本都算成匹配扫描。

## 方法与边界

每个规模分别建立 N 条 observation 和 N 条 knowledge 冷记录。`repeat` 连续观察同一新主体，
预热 3 次；`evict` 连续观察不同新主体，预热 51 次以跨过热窗口。每侧每轮计时 20 次，
共 5 轮，三侧顺序逐轮旋转。A 与 A 是完全相同的当前源码，用作方法漂移对照；第三侧是实验。
报告中的 ms 是每轮样本中位数再取轮间中位数；百分比相对于 A。
每轮比较全部返回记录及归一化临时路径后的 durable aggregate 与 dockyard 文件树字节，
不一致就拒绝输出结果。每次 observe 都使用真实暂存、提交与 hydrate，未计入夹具建立和首次打开。

- `zero-scan oracle`：仅在临时源码副本中跳过两处冷键表循环。夹具的输入不匹配已有冷行，
  因而此次输出等价；它对一般冷命中是错误实现，绝不能用于生产。
  它只给出此负载中消除这两处循环的理想化节省，不是其它负载的严格上界。
- `parse-bound reverse index`：临时副本增加 key → 有序位置数组的 Map，合并双 key 与热覆盖位置，
  按原位置读取；无 id 行保留原扫描。索引附于既有 parse，按 keys 数组身份失效，追加后重建。
- `sorted-position index`：相同生命周期，改为已有 stored / derived 键表上的排序位置数组及二分查找，
  用更小的整数位置表示检验 Map 的内存代价能否被消除。更新后仍需重建排序。

内存是同一进程中每个 session 建立前、写入后显式 GC 的 heapUsed 差值（轮间中位数），
不是整个进程峰值；RSS 是 GC 后采样，不能宣称峰值或长期稳定内存上界。
原始样本保留全部 wall / CPU / heap / RSS 及源码摘要。使用 Node v26.13.0、4096 MiB 堆上限。
oracle 的 1,000 行探索阶段曾与一项约 1 秒的聚焦测试重叠，未记录精确时段；
该规模 oracle 结果不用于接受收益，后续索引实验期间没有并行跑测试或其它基准。

## 复现

```sh
node --max-old-space-size=4096 scripts/benchmarks/knowledge-key-scan-ceiling.mjs --out /tmp/ceiling.json
node --max-old-space-size=4096 scripts/benchmarks/knowledge-key-scan-ceiling.mjs --indexed --out /tmp/index.json
node --max-old-space-size=4096 scripts/benchmarks/knowledge-key-scan-ceiling.mjs --compact --out /tmp/sorted.json
```

脚本复制当前 `lib/`，从指定方法锚点生成临时实验源码；锚点不再唯一则失败。
子进程也固定堆上限，临时树退出时删除。`--sizes`、`--rounds`、`--samples` 可缩小探索负载。
它是诊断/反例工具，不是可部署实现，也不替代一般输入、冷命中和恢复语义的差分证明。

## 结果与决定

**不保留运行时改动。** 剩余扫描确实可测，但本次两个小方案均未同时满足速度、内存与
连续归档无关注回退的验收条件。不将 oracle 的收益宣称为已经实现的优化，也不声称所有
其它索引表示都不可能获益。进一步增量维护排序表将扩展更新/继承路径，本轮没有执行。

下表每个规模是 N 条 observation + N 条 knowledge；负号代表变快。

| N | 负载 | 零扫描 oracle | Map 索引 | 排序位置索引 | 排序实验 A/A |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1,000 | repeat | -1.14% | -1.67% | -4.08% | -1.11% |
| 1,000 | evict | -0.75% | -0.24% | +1.32% | +1.29% |
| 10,000 | repeat | -8.42% | -5.81% | -8.56% | -0.03% |
| 10,000 | evict | -1.44% | +1.16% | +1.36% | -1.47% |
| 40,000 | repeat | -16.84% | -16.97% | -19.14% | -1.28% |
| 40,000 | evict | -14.66% | -0.59% | +3.67% | +0.37% |

1,000 行 oracle 数据带上述污染标记，只作探索记录。10,000 / 40,000 行 oracle 的重复事件
改善约 8% / 17%，与 A/A 分开，证明存在真实剩余成本，而不是再次引用历史优化。
Map 索引在 40,000 行 repeat 中 121.64 → 101.00 ms，但 GC 后保留堆 24.33 → 60.39 MiB；
evict 则 160.43 → 159.48 ms（−0.59%），和 A/A +0.82% 同量级，未证明持续归档收益。
排序位置索引降低了表示成本，却把重排成本放到了变更后的读取：40,000 行 repeat
改善 19.14%，evict 汇总却回退 3.67%。逐轮 wall 中位数如下（与汇总用的上中位数不同，
本表 20 个样本采用常规两个中间数的平均；因此直接列出原始样本统计口径）：

| 轮 | A ms | 同源 A ms | 排序索引 ms | 索引相对 A |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 160.35 | 162.82 | 163.51 | +1.97% |
| 2 | 159.04 | 159.81 | 163.67 | +2.91% |
| 3 | 157.86 | 156.45 | 165.98 | +5.14% |
| 4 | 156.10 | 159.90 | 166.75 | +6.82% |
| 5 | 160.68 | 153.57 | 165.06 | +2.72% |

排序表的 typed array 底层字节不计入 heapUsed；不能拿其 heapUsed 接近 A 宣称没有内存开销。
本次未为被撤回的方案补充长期峰值内存证明或一般输入的全套差分测试，亦未宣称它通过验收。
当前运行时 `lib/` 与基线逐字节相同，知识身份、匹配、去重、持久化、恢复语义没有更改。

原始数据：
[零扫描对照](knowledge-key-scan-ceiling.json)、[Map 索引反例](knowledge-key-index-experiment.json)、
[排序位置索引反例](knowledge-key-sorted-experiment.json)。三组分别运行，各自带同源 A/A，
不能跨组相减来推断收益。夹具只覆盖新的冷不命中主体与其后续热命中；冷命中/旧格式/故障
边界由当前源码及既有差分测试核对，不能用这些性能夹具证明实验实现的一般正确性。

## 本轮验证

- 三个实验各 6 个规模/负载组合，每组合 5 轮、每侧每轮 20 次计时写入，均通过返回值和持久化树的字节比较；预热写入也纳入比较。
- `NODE_OPTIONS=--max-old-space-size=4096 npm test`：1,344 项全部通过，Node v26.13.0，约 38 秒。
  包含知识身份/历史差分、冷/热覆盖、归档追加继承、读取故障、键表失败回滚、重启和持久化的既有回归。
- `npm run pack:check`：16/16 通过，当前树仍是固定发布包的开发后继；这不表示当前树就是发布字节。
- `npm run release:verify`：固定发布包字节、内容、条目、权限均匹配 manifest。
- `git diff --exit-code origin/main -- lib release`：无差异；未改分发源码和固定产物。
  未重跑真实宿主验收，因为没有保留任何运行时/分发改动。
