# 归档索引：无变化也重写整份文档

本轮基线为 `main` 的 `445830b`（rc.17 固定点）。只改
`lib/dockyard-domain/memory.js` 的一处比较：`#reconcileArchiveIndex()` 判断
“重建出来的活动归档索引条目是否与已加载的一致”时，不再把
`#reconcileActiveArchive()` 每次都按时钟重写的 `updatedAt` 算作变化。没有新增
缓存、没有跳过任何读取或校验、没有改变持久化格式、事务、恢复、回滚、fsync 次数
（除了本应省下的那些）与宿主兼容行为，也没有修改官方 DSH 源码。

原始数据见 [`archive-index-churn.json`](archive-index-churn.json)，复现脚本见
[`scripts/benchmarks/archive-index-churn.mjs`](../../scripts/benchmarks/archive-index-churn.mjs)。

## 1. 现象与调用频率

`EvolutionMemory.load()` 在每次加载时都会跑 `#reconcileArchiveIndex()`：对每个
集合的每个归档文件重建一条索引条目，再与持久化的索引文档比较，决定是否重写。
对活动归档文件，`#reconcileActiveArchive()` 的备忘命中路径（
[`archive-scan-memo.md`](archive-scan-memo.md)）会把 `updatedAt` 设成
`timestamp(this.clock)`：

```js
const entry = clone(memo.entry);
entry.updatedAt = timestamp(this.clock);   // 每次加载都是新值
```

而比较是 `JSON.stringify(current) !== JSON.stringify(rebuilt)`，于是**字节没变、
只是时钟走了**也被判成“变了”，整份索引文档被重写。

`load()` 出现在哪些热路径上：

| 调用方 | 频率 | 每次 `observe()` 里的次数 |
| --- | --- | --- |
| `domain-storage.js` 的 `createMemory()`（暂存树） | 每次领域写入 | 1 |
| `domain-storage.js` 的 `hydrate()`（提交后重载） | 每次领域写入 | 1 |
| `agent/error` / `tools/result` 的观察写入 | 每次失败信号 | 经上面两条 |

即：**只要这台机器上已经存在任意一个归档文件，每次领域写入就会白写两次索引
文档**，每次写入因此多出 2 次整份索引写、5 次 `fsyncSync`（可确认的来源是暂存
索引被 `syncStage` 落盘、以及 `hydrate()` 对换过 inode 的索引做 `syncFile(index)`
+ `syncFile(root)`；其余来自被这次重写连带改动的安装/目录同步）、以及两次额外的
全集合归档枚举与 `stat`。

写入路径上的直接归因（真实端口 + 真实官方 JSON 后端，种子化一个活动归档，逐次
系统调用计数，12 次 `port.observe()` 取每次平均；这是机制计数，不是计时样本）：

| 每次 `port.observe()` | 优化前 | 优化后 |
| --- | ---: | ---: |
| 索引文档被替换（inode 变化） | 2 | 0 |
| `fsyncSync` 调用 | 8 | 3 |
| `readdirSync` | 116 | 80 |
| `statSync` | 75 | 39 |
| `linkSync(index)` | 1 | 0 |

（本机 `fsyncSync` 约 1.3 ms、`linkSync` 约 0.27 ms，见第 5 节的边界说明。）

## 2. 改动

1. 新增模块级 `sameIndexEntry(left, right)`：按排序后的字段名逐字段比较，跳过
   `updatedAt`。排序同时修掉一个潜在误判——旧实现用 `JSON.stringify` 比较，
   字段顺序不同的等价条目也会被判成变化。
2. `#reconcileArchiveIndex()` 用它替换原来的 `JSON.stringify` 比较。
3. `#loadArchiveIndex()` 现在保留条目**被读入时的形状**（`entries.set(file, item)`，
   不再补 `collection`）。这样“旧版本文档缺 `collection`”与“集合已不存在”这类
   需要修复的条目，仍然会通过同一个比较/丢弃路径触发重写——修复由**条目内容**
   决定，而不是由时钟决定。

**没有动的部分**：`#reconcileActiveArchive()` 的扫描与备忘、活动归档每次加载
仍被完整读取与扫描（这是 append/index 崩溃后的恢复面）、密封段仍按大小校验、
索引缺失/损坏/大小不符/条目缺失时仍然重写。

## 3. 等价性与可观察差异

- **等价性（冻结时钟）**：两侧在冻结时钟下跑同一 workload，内存层的状态文档、
  归档文件与索引文档，以及真实端口的 `official/evolution_domain.json`、每个
  归档文件与索引文档**逐字节相同**（脚本内断言，失败即非零退出）。
- **唯一可观察差异**：索引条目与索引文档里的 `updatedAt` 不再因为“加载过”而
  前进，只在该条目的内容真的变化（追加、轮转、密封、修复）或文档被重写时更新。
  该字段没有被任何判定读取（`lib/diagnostics.js` 只校验索引是合法 JSON）。
- **未改变的既有行为（需如实记录）**：索引里指向已删除文件、未知集合或形状非法
  的条目，在加载时**不会进入**内存索引（`#loadArchiveIndex()` 只保留能归属到
  现存集合与文件的条目），因此内存态与 `verifyConsistency()` / 
  `#archiveConsistencyReport()` 的判定不受影响；但**持久化文档**里的这些残留
  条目，只有在别的理由触发重写时才会被顺手清掉（旧版本缺字段的条目、密封段大小
  不符、追加/轮转/密封）。已发布的 rc.16/rc.17 在**冻结时钟**下也是这个行为
  （`test/observe-cache-handoff.test.mjs` 的“密封段文件列表”差分正锁着它）；
  在推进时钟下 rc.16/rc.17 会因时钟戳而每次都重写、从而顺手清理——这是本轮
  唯一被放弃的副作用，换取的是每次加载不再写整份文档。没有新增“每次加载都
  重写”的修复路径，也没有让残留条目变成可见数据。
- **不变量保持**：冻结时钟下两侧字节相同这一点同时说明事务、恢复、安装与
  `pending` 行为没有变化；推进时钟下唯一的差异是省掉的写入。

## 4. 可复现 A/B

```sh
NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/archive-index-churn.mjs \
  --rounds 3 --loads 15 --writes 15
```

脚本默认把本轮起点 `445830b`（改动前）的 `lib/dockyard-domain/memory.js` 还原进
一份 `lib/` 副本作为基线（断言基线里存在旧比较、不含新比较；`--baseline <rev>`
可换锚点，但换了就没有旧比较），两侧在同一进程、同一 fixture 上交替先跑，三轮；
测量轮用“每次读取前进 1 ms”的确定性时钟（生产条件，且可复现），等价轮冻结时钟
并逐字节比较。内存层等价比较的是该 fixture 最终的状态文档、归档文件与索引文档，
真实端口比较的是官方持久化文档、每个归档文件与索引文档。

环境：Node `v26.12.1` / `darwin/arm64`，8 逻辑 CPU；三轮开始/结束的 load
average 为 `1.46/1.88/1.79` → `1.58/1.90/1.79`。下表是三轮各自中位数的中位数。

| 负载 | 基线 | 优化后 | 变化 |
| --- | ---: | ---: | ---: |
| `load()`（内存层，每次） | 1.159 ms | 0.682 ms | **−41.2%** |
| `load()` CPU | 1.308 ms | 0.785 ms | −40.0% |
| `port.observe()`（真实端口，每次） | 46.941 ms | 26.407 ms | **−43.7%** |
| `port.observe()` CPU | 12.222 ms | 9.132 ms | −25.3% |
| `fsyncSync`/写入 | 8 | 3 | −5 |
| 索引替换次数/样本 | 15/15 | 0/15 | 0 |

三轮方向一致：基线端口耗时 `54.043 / 46.906 / 46.941`，优化后
`26.407 / 25.936 / 30.961` ms，区间不重叠；内存层 `1.159 / 1.120 / 1.291` 对
`0.682 / 0.617 / 0.736` ms。CPU 侧基线为 `18.592 / 10.080 / 12.222`、优化后
`9.132 / 9.112 / 11.115` ms：第 2 轮基线 CPU（10.080）与优化后（9.112）差距很小，
**CPU 区间有重叠**，因此本轮只把墙钟、`fsyncSync` 次数与索引替换次数当作稳定
结论；CPU 只作为方向一致的辅助数据。

## 5. 收益边界

- 收益只在**已经存在归档文件**（至少一个活动归档或密封段）的库上出现。全新库
  还没有索引文档，这条路径本来就不写；空归档时两侧完全一致。
- 收益随 `load()` 次数线性放大：每次领域写入 2 次 `load()`，`agent/pre-step`、
  工具结束的 `flush()` 不加载内存，因此不受影响。
- 本机系统调用偏慢（`linkSync` ≈ 0.27 ms、`fsyncSync` ≈ 1.3 ms，疑似宿主安全
  软件拦截创建类调用），因此省下的 5 次 `fsync` 在绝对时间上很明显。换到系统
  调用更便宜的主机，机制相同（少 2 次整份索引写、5 次 `fsync`、2 次全集合
  枚举），但**绝对毫秒数会小得多**；不声称在别的主机上有同样的百分比。
- 索引文档越大（密封段越多），每次重写的成本越高，因此收益随归档段数增长。
- 没有测量冷页缓存、网络文件系统、其它平台，也没有声称磁盘 I/O 总量下降的
  物理比例——只报告调用次数与同机耗时。

## 6. 验证

```sh
NODE_OPTIONS=--max-old-space-size=4096 node --test \
  test/dockyard-domain/archive-index-write-avoidance.test.js \
  test/dockyard-domain/evolution-archive-index.test.js \
  test/dockyard-domain/archive-index-equivalence.test.js \
  test/dockyard-domain/housekeeping-equivalence.test.js \
  test/observe-cache-handoff.test.mjs
NODE_OPTIONS=--max-old-space-size=4096 npm test
```

新增 7 项回归（`test/dockyard-domain/archive-index-write-avoidance.test.js`）：

1. 字节未变的连续加载**不**替换索引文档（在改动前的 `445830b` 上失败，已实测）；
2. 活动归档追加后仍然重写，且计数/字节数跟随新文件；
3. 密封段字节变化后仍然被重读、重新哈希并更新 `sha256`/`byteSize`；
4. 密封条目只写了文件名（缺 `collection`）时，仍在不重读字节的前提下被规范化，
   且 `sha256` 不变（在“只改比较”的中间实现上失败——独立复核发现的缺陷）；
5. 损坏的索引条目（错误计数）仍在下一次加载被修复；
6. 字段顺序不同但内容相同的索引**不**被视为变化（在 `445830b` 上失败，已实测）；
7. 索引缺失时首次加载仍然写入。

既有差分锚点全部保持：`test/dockyard-domain/archive-index-baseline.js` 增加 4 条
反向片段，使 rc.7 固定产物的逐字节重建仍然成立（`housekeeping-equivalence` 的
整文件锚点通过）；`observe-cache-handoff.test.mjs` 的 rc.16 差分（冻结时钟）通过，
包括“密封段文件列表变化”这一条。

提交后本机全量：**662 项全部通过**（提交前同一次套件为 661/662，唯一失败是
`test/release-pin.test.mjs` 的“工作树必须是固定产物或它的已提交后继”，它要求
本轮改动先提交）。`npm run pack:check` 的判定是“本树是固定发布产物的开发后继；
固定点、产物与验收证据未变”，并点名 `lib/dockyard-domain/memory.js` 是唯一
与固定产物不同的分发文件；`release/` 产物、`release/manifest.json`、版本号与
历史发布记录均未改动，rc.17 仍是已发布的固定点。

## 7. 本轮同时排除的方向（附证据）

按“收益潜力最大”逐个量过之后放弃的候选，避免后续重复：

| 候选 | 结论 | 依据 |
| --- | --- | --- |
| 复用检查点的 `applied` 摘要（`flush()` 稳态 CPU 的约 37%） | 不做 | `redundant-work.md` §4.1 已用“同进程官方句柄回退标记表”击穿并整体撤回；本轮复测稳态 `flush()` 仍为读取全量历史 + 前缀 HMAC（本机 20000 条、10.5 MB 日志：每次 11.6 ms CPU，其中 HMAC 5.4 ms、`JSON.stringify(applied)`+SHA 4.0 ms、读取 0.8 ms），两项都是 `domain-durability.md` 记录的完整性边界。 |
| 把 `digestApplied` 改成流式编码以省掉整串分配 | 不做 | 实测更慢：`sha256(JSON.stringify(map))` 4.00 ms，按条 `hash.update` 5.71 ms、按条 `JSON.stringify` 拼接 6.00 ms（20000 条），因为 V8 的 `JSON.stringify` 是原生实现。 |
| 复用上一次事务的暂存目录，避免每次写入按归档文件数重建硬链接 | 不做 | 机制上收益很大（216 个归档段时 `link` 占一次写入 CPU 的 60%、`rmSync` 再占 11%），但它要求 `domain-staging/` 在事务之间保留目录；仓库的 `domain-orphan-staging` 修复项与三个测试都要求事务结束后暂存目录为空，属于现有不变量，不在本轮范围。 |
| 跳过“工作没有产生变化”的事务 | 不可达 | 重复的 `agent/error`/`tool/error` 不会被去重（只有 `info` 级组件观察才去重），且去重路径本身仍会写 canonical 计数，因此不存在“整笔事务无变化”的常规情形。 |
| 省掉提交后 `installPending()` 对刚写入文档的再次校验 | 不做 | 只在“`domain.global.get()` 返回的正是刚 `set` 的对象”时才能省，而这正是 `redundant-work.md` §4.1 记录的同进程原地改写窗口；且实测 zod 在校验总成本中的占比远小于本轮的索引重写。 |
| 守卫（`tools.guard`，每次工具调用） | 已测，无问题 | 每次调用解析工具参数：6 KB bash 命令 0.145 ms、10 KB 代码 0.296 ms，线性且与工具自身耗时相比可忽略。 |
