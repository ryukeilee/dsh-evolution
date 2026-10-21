# port.observe：跨 Memory 继任复用解析与冷行身份

本轮基于远端最新 main `a193205848135f81bcca58097f81a2fcad78915b`。工作开始与提交前均 fetch 核对，远端 main 未移动；rc.16 固定包的 `memory.js` 与本轮精确逆变换的结果逐字节一致。候选是取数时的未提交工作树，具体字节以各 JSON 的 `sources` SHA-256 为准，不能把 `observe-cache-sources.json.sourceCommit` 当作候选已提交源码。

最终万级双冷档案的公开 `port.observe()`：wall **127.033 → 47.030 ms（−62.98%）**，CPU **128.641 → 29.366 ms（−77.17%）**。这是保留真实读取、内容指纹、完整加载与事务后的结果，替代分析期间更快但边界不等价的原型数字。版本、`release/`、固定验收证据、官方 DSH 均未修改。

## 调用路径与成本归因

`observe → enqueue → mutate → mirrorArchives → createMemory(stage).load → store.record → recordObservation → #append → installPending → hydrate → createMemory(live).load`。

main 已有活动档案 reconcile 扫描备忘、实例内解析缓存、无复制合并、轻量身份投影和规范化优化。历史上考虑过跨实例身份缓存，但因失效、隔离和内存证据不足而暂缓，见 [write-path-reconcile-and-identity.md](write-path-reconcile-and-identity.md)、[archive-read-cost.md](archive-read-cost.md)、[recall-view.md](recall-view.md)。本轮没有重做已落地的正则、投影与扫描优化，也没有重试已撤回的 schema 收窄、ledger 摘要缓存、删除 hydrate observation load、删除第二次事件规范化等方案。

真正未摊销的成本是：每次公开写入创建暂存 Memory，提交后再创建 live Memory。实例内 `archiveReadCache` 随继任丢失；来源行的 canonical key 又在 `#sourceMatches()` 中逐条重算。构造 Map 本身很便宜，昂贵的是丢失解析结果后重复建立它们。直接复用整个 Memory 会牵涉热状态、失败事务、维护与加载副作用，因此仍保留原有实例和完整 load。

[独立归因运行](observe-cache-attribution.json) 中，每个测量样本的确定性计数都相同：

| 每次 observe | main / rc.16 | 最终候选 |
| --- | ---: | ---: |
| 实际读取冷档案字节 | 23,236,134 | 23,236,134 |
| 解析 fixture 冷行 | 20,000 | 0 |
| 六维身份哈希 | 10,002 | 2 |

读取字节没有减少。收益来自省掉 JSON 解析、冷行规范化和身份哈希。计数运行使用 `--attribute`，不是主时间数据：包装实际 fs 读取；`JSON.parse` 结果按 fixture 的冷行 id 计数；身份哈希按生产六维序列化输入计数，不包含新增的文件内容指纹哈希。

同次 [三侧归因](observe-cache-large.json) 比较真实 rc.16、只继承解析结果的变体、最终候选：

| 实现 | wall ms | CPU ms |
| --- | ---: | ---: |
| main / rc.16 | 127.033 | 128.641 |
| 解析继任，保留原 sourceMatches | 82.119 | 69.496 |
| 解析继任 + 冷行身份备忘 | 47.030 | 29.366 |

变体由 [observe-cache-variants.mjs](../../scripts/benchmarks/observe-cache-variants.mjs) 复制真实模块树生成，只把 `#sourceMatches()` 换回固定包的方法；没有重写性能基线。

## 最小改动与等价边界

- `domain-storage.js` 在同一个 port 的 live → stage → hydrate 之间传递既有解析缓存。每个实例拥有独立 Map 与条目包装；不共享热状态、`archiveKnown`、stale 标记、事务或权限。
- 继任首次读取仍列举全部文件，核对 basename、有序文件列表、dev、ino、size、mtimeNs，实际读取所有文件，并比较该解析对应的 SHA-256，再核对读取后的文件身份。缺证据、内容不同或身份变化就直接解析本次读取结果。
- 读取错误沿原 scanner 报告；保留单次读取的 raw/error，避免一次 EIO 被重试成功掩盖。带 fault 的解析不继承，故障路径与时间由新实例重新观察。
- append 扩展前复制 records、positions、tombstones；既有冷行与其身份备忘只读共享。增量扩展没有新的完整文件指纹，标记 `digests: null`，下一实例不继承它；同实例既有增量缓存仍有效。
- `#sourceMatches()` 仍先匹配存储 key，再按字段重算 canonical key。只有当前位置仍由该缓存持有的冷对象才能备忘；同 id 热覆盖始终重算。返回值、latest-wins、首次位置、匿名行、数组行、tombstone 与复活顺序不变。
- 删除从未被消费的 `getAggregate` 返回闭包，以及缓存统一初始化后两处冗余的惰性 Map 初始化。未删除加载、校验、时钟读取、fsync、锁 fencing、commit token/CAS、pending/journal 或恢复步骤。

这沿用 `historyView()` 的只读调用合同；当前 port 只把该视图交给只读 recall collector。缓存没有新增持久化文件，也不参与事务决策或安全授权。

## 真实端到端 A/B

环境：Node v26.12.0、darwin/arm64、Apple M2、8 逻辑 CPU、16 GiB。机器不是专用空闲环境；每份原始 JSON 记录开始时 load average。基准与全量测试没有并行运行。使用真实官方 `DomainFacility` + `JsonStorageBackend`，临时隔离根；不读取正式 DSH_HOME 或用户数据。

每轮从同样 fixture 开始，两侧轮换顺序；三侧运行轮换三个位置。固定时钟，并在每个 session 重置确定性 UUID。预热、造数、最终读取与比对不计入 wall/CPU。汇总为“三轮各自样本中位数的中位数”。默认每轮预热 1 次；大档案 5 个样本，空/小档案 15 个样本。每轮都断言公开返回值、官方持久化文档及完整 dockyard 树字节相同，只将不同的临时根替换为同一占位符。

| 负载 | main wall ms | 候选 wall ms | wall 变化 | main CPU ms | 候选 CPU ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| [空档案](observe-cache-empty.json) | 26.984 | 28.066 | +4.01% | 9.238 | 10.474 |
| [50 + 50 冷行](observe-cache-small.json) | 29.954 | 29.785 | −0.57% | 11.389 | 11.482 |
| [10k + 10k 冷行](observe-cache-large.json) | 127.033 | 47.030 | −62.98% | 128.641 | 29.366 |
| [每次更新冷 knowledge](observe-cache-cold-hit.json) | 154.834 | 118.314 | −23.59% | 136.561 | 102.387 |
| [每次归档来源行](observe-cache-evict.json) | 188.830 | 158.290 | −16.17% | 179.886 | 128.482 |

空档案仅约 +1.08 ms，小档案约 −0.17 ms；逐轮方向反转、fsync 与机器漂移明显，**均不宣称稳定收益，也不承诺零开销**。大档案三侧的逐轮 wall 中位数为 main 138.46/126.58/127.03，候选 47.03/47.61/46.03，解析变体 82.18/81.65/82.12 ms，差距远大于轮间漂移。

冷 knowledge 命中负载额外种入真实公开观察规范化所得的 key，脚本断言归档累积行实际增长；会触发 seal、内容更新与安装换 inode。evict 使用不同字母目标，预热 51 次使热窗口满，测量的每次观察都触发来源归档。两者都保留失效后的重新解析，收益小于静态冷档案。

## 内存与不获益的范围

[内存原始数据](observe-cache-memory.json) 每侧各 3 个全新 Node 进程，执行顺序 A/B/B/A/A/B。`--expose-gc`，造 fixture 前和写入后各 GC 一次。留存 heap 增量中位数 **3.985 → 34.266 MiB（增加 30.281 MiB）**；写入后 GC 的 RSS 采样中位数 **371.896 → 312.340 MiB**。RSS 下降与少分配/少 GC 一致，但这不是峰值 RSS 测量，不能据此声称降低内存峰值。

候选延长了已解析知识冷行和身份字符串的生存期。缓存每集合仅保留当前视图，活动事务还可能持有前一代容器；没有模块级跨 port 档案仓库。留存随冷档案大小增长，compaction trigger 不是进程内存硬上限。对冷档案频繁改写、极短 session 或内存非常紧张的使用方式，不承诺本轮的最大收益。

[单实例边界基准](observe-cache-instance-boundary.json) 另外测得，首次、没有可复用身份的单次 `recordObservation()` 为 **40.980 → 47.253 ms（+15.3%）**，是建指纹与身份备忘的成本；同实例 16 次追加合计 **377.507 → 100.345 ms（−73.4%）**。这不是公开 port 的端到端数字，不与上表混算。load 为 7.021 → 6.895 ms，缺索引 load 23.040 → 23.033 ms，不宣称启动收益。

当相关集合每次都被重写、没有重复利用已解析的冷行时，备忘无法摊销。没有新增逐文件解析索引、跳过读取或复用整个 Memory 来追求更大的数字。

## 已撤回的原型与审核

1. 只按 stat 继承、跳过首次读取：新发生的 EACCES/EIO 会被隐藏，撤回。
2. 实际读取但只比 stat：等长原地改写后恢复 mtime，rc.16 返回 NEW，原型错误返回 OLD，撤回。最终版增加内容指纹，并让 mismatch 直接解析本次 raw。回归测试还覆盖读取期间改写。
3. [同进程多侧的留存内存协议](observe-cache-memory-withdrawn.json)：前一侧巨大比对字符串的生存期污染 GC 差值，出现负留存量；**废弃这些内存结论**，改用上述独立进程协议。该文件不是最终实现的性能证据。

两项代码反例均固化在 [observe-cache-read-fault.test.mjs](../../test/observe-cache-read-fault.test.mjs)。独立审核三轮：前两轮确认上述问题及旧差分基线失效；Root 修复后，第三轮未发现新的可复现缺陷，独立执行 13 项聚焦测试全部通过。审核未验证最终性能数字或运行全量套件；那些由 Root 实际执行并记录。

## 验证与发布限制

机器可读的实际结果见 [observe-cache-validation.json](observe-cache-validation.json)。

- [13 项新聚焦差分](../../test/observe-cache-handoff.test.mjs) 与读取故障测试通过，直接导入 SHA 固定的 rc.16 包；覆盖缺键、陈旧键、存储键短路、热覆盖、容器隔离、匿名/数组顺序、tombstone、文件失效、fault、提交前失败、已提交 pending 安装失败及重启恢复。stage 使用真实硬链接并断言写前私有化，失败后旧实例和实时字节不见未提交数据。
- 精确逆变换保持原有差分基线的单次匹配守卫和固定包字节锚。第二轮既有聚焦 53 项全通过；内容指纹修复后最终完整套件 **645 项，643 通过，2 失败**。
- 两项失败均为 `test/release-pin.test.mjs` 的“工作树必须与固定产物相同”断言；**完整套件未全绿**。最终 `pack:check` 13 项通过、3 项固定内容/验收证据门禁失败。实际变更只有两个分发源码文件，当前内容摘要为 `491c143334e71b17c53a9200027646eb1e497e4b281e610e191df425fd402097`，rc.16 固定摘要仍为 `aeae8ffe342abfc5332a6e161b6972f736c01bd4440ca9fd7f15540ada39a006`。
- `release:verify` 通过：既有 tarball SHA-256 `1d4a40a73a5f3f7331ca66ebcc8dcf7a82f6e50b00238b7618b4c04dd80c0ad6`，51 entries、权限与 manifest 一致。`git diff --check` 通过。
- 用户明确要求本轮不改版本、Release 或固定产物，所以保留发布断言与失败，不伪造新宿主验收，不执行 `release:publish`。本轮未运行完整真实宿主安装验收；这些开发字节尚未成为已验收的发布固定点。推送到独立性能分支，保留 main 的发布状态。

本轮没有改动宿主接口、晋升门禁、confirmation、journal、锁、CAS 或加载顺序；全量回归覆盖现有对应失败用例。不能将官方存储端到端收益直接解释为完整 DSH/LLM 任务延迟收益。

## 复现

所有 Node 命令保留 4096 MiB 堆上限；以下脚本只使用临时数据与仓库固定包：

```sh
rtk proxy env NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/observe-cache-variants.mjs /tmp/observe-cache-variants-new
rtk proxy env NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/observe-cold-archive.mjs --rows 10000 --knowledge-rows 10000 --rounds 3 --warmup 1 --samples 5 --variant /tmp/observe-cache-variants-new/parse-only/lib --json
# 空/小规模：分别改为 --rows 0 --knowledge-rows 0，以及 50/50；--samples 15
# 内容更新：追加 --workload cold-hit
# 持续归档：追加 --workload evict --warmup 51
# 确定性计数：追加 --attribute，计时数据单独看主运行

# 内存：每条命令单独启动新进程，按 baseline/candidate/candidate/baseline/baseline/candidate 执行
rtk proxy env NODE_OPTIONS=--max-old-space-size=4096 node --expose-gc scripts/benchmarks/observe-cold-archive.mjs --rows 10000 --knowledge-rows 10000 --rounds 1 --warmup 1 --samples 5 --retained --memory-side baseline --json
rtk proxy env NODE_OPTIONS=--max-old-space-size=4096 node --expose-gc scripts/benchmarks/observe-cold-archive.mjs --rows 10000 --knowledge-rows 10000 --rounds 1 --warmup 1 --samples 5 --retained --memory-side candidate --json

rtk proxy env NODE_OPTIONS=--max-old-space-size=4096 node --expose-gc scripts/benchmarks/archive-read-cost.mjs --memory /tmp/observe-cache-variants-new/package/lib/dockyard-domain/memory.js --memory lib/dockyard-domain/memory.js --scales 10000 --samples 2 --rounds 3 --warmup 1 --batch 16 --out /tmp/observe-cache-instance.json
rtk proxy env NODE_OPTIONS=--max-old-space-size=4096 node --test test/observe-cache-handoff.test.mjs test/observe-cache-read-fault.test.mjs
rtk proxy env NODE_OPTIONS=--max-old-space-size=4096 npm test
rtk npm run pack:check
rtk npm run release:verify
```
