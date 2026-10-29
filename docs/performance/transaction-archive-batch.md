# 私有 replay 事务的归档淘汰合并

## 基线与问题

基线是 main `6b4dee948b4d86ba35c6736bb667a7a1bc10eb20`。本轮没有更改版本、发布固定点、官方宿主或依赖。已有 replay 批量提交、deferred index、marker 窗口校验、归档读缓存、目录与重复 stat 优化全部保留；整集合 LRU、同步 append 替换和凭文件身份信任尾部的旧方案不再尝试。历史约 3.8 秒及 782/310 ms 插桩数字仅用于定位，不当作本轮收益。

原调用链是 replay → 同一个 staged mutate → 每条 applyExecutionEvent → recordExperiment → #append → 每条淘汰各自 #archiveEntries。一个领域事务仍产生 19,950 次独立归档追加；每次重做尾部探测、文件追加和归档缓存携带工作。

## 候选与边界

`applyExecutionEvents()` 仍逐条走原事件应用、DTO 校验、save 校验与 marker 逻辑。只在私有 stage 的连续无知识 measurement 中，把 experiments 淘汰行暂存为有界批次（256 条、256 KiB；大单行立即排空）。热窗口始终维持原大小，不把整个历史塞进 hot。暂存行不提前写入 known、索引或 coldArchives；这些中间状态只在工作副本内存在，不对外返回。

知识语义、热/冷/待归档 id 重用与其他事件先排空；成功返回前再排空余数。排空调用原 #archiveEntries：新鲜尾部检查、损坏尾部隔离、完整无换行行补分隔、boundedArchiveEntry、原分段规则、写 guard、索引、读缓存更新全部保留。不缓存文件尾部事实，不引入同步 append 或新持久化格式。

收益来自减少实际工作：多条记录共用一次归档调用及 append；缓存的有序键表和 locator 容器也不必为每条归档行重新携带一次。普通 observe、单条 applyExecutionEvent 与非私有 Memory 保留原路径；含知识或频繁替换的负载会排空，不能外推为同样收益。

原归档写失败会保留热行并返回 false；批次已经把行移到私有 pending，因此排空 false 必须抛 `E_DOMAIN_ARCHIVE_BATCH_WRITE`，拒绝整个未发布事务，不能复用失败工作副本。写入失败（含部分成功与封段失败）只留下未提交 stage；live 树、aggregate、ledger、checkpoint 均不推进。pending 发布后的安装和崩溃恢复继续使用原 files 清单及摘要协议。

## 验证与测量方法

使用本机 Node v26.12.1（4096 MiB 堆上限）、macOS 27.2 / Apple M2、项目锁定的真实官方 DomainFacility / JsonStorageBackend。每个样本独立进程及临时根；“冷”指没有领域历史和 replay checkpoint，不表示清空 OS 文件缓存。历史增量先真实吸收 N 条、关闭、追加 2,000 条，再测重开。

主墙钟与 CPU 测量禁用 fs 包装；A/A 是同一基线根的交替标签，A/B 使用两份冻结 lib 副本，每种负载至少三轮交替 A/B、B/A、A/B。另开有插桩运行测 JS fs API 调用数，并校准包装扰动。API 次数不是内核 syscall/物理磁盘次数，嵌套计时不能相加。resourceUsage 的 fsRead/fsWrite 是 OS block 计数；RSS before/after 为瞬时值，maxRSS 是含 seed 的进程生命周期峰值。

确定性夹具固定无参 new Date 的审计时间，Date.now 保持真实。对照完整 aggregate、applied ledger、marker、query、JSONL 和原始索引摘要；状态、ledger、marker 和 query 以排序键的结构摘要比较，coldArchives 的路径只归一临时数据根前缀；JSONL 与原始索引则比较逐文件字节摘要。小阈值测试另比较未排序的完整持久文档（只替换根路径）。每侧还校验 flush 和两次重启后结果不变。小阈值差分测试覆盖相同行顺序、段名和分段字节，以及超出目标大小的单行。

故障测试包括部分追加、损坏尾部/完整无换行尾、quarantine 失败、segment 写/rename/active 清空失败、pending 发布失败、closing 写失败、drain 前和 pending 后 SIGKILL，随后恢复重放及重复应用。初版 17 项聚焦测试有界运行通过（修复 S1 后为 18 项），进程组峰值约 241 MiB。早期等价夹具误把 eager/batch 配成不同段阈值，失败断言打印大 Buffer 导致 RSS 增长，已停止；统一配置后改用逐文件摘要，未修改生产语义来迁就测试。

前两次筛选/等价运行期间主代理编辑源码，源码围栏拒绝最终报告；这些运行不计入验收数据。正式测量使用冻结副本，不能把筛选数字混入最终收益。

## 复现

基线可用 `git archive 6b4dee9 lib package.json` 解到临时目录，候选复制待测提交的 lib/package.json；两者 node_modules 指向同一套本项目依赖。下面的根变量分别指向这两份冻结源码，不指向正式用户数据。输出文件必须不存在。

```sh
node --max-old-space-size=4096 scripts/benchmarks/transaction-archive-batch.mjs \
  --a-root "$BASELINE_ROOT" --b-root "$CANDIDATE_ROOT" \
  --records 2000,12000,20000 --rounds 3 --delta 2000 \
  --phases aa,ab --instrument no --out /tmp/batch-timing.json
node --max-old-space-size=4096 scripts/benchmarks/transaction-archive-batch.mjs \
  --a-root "$BASELINE_ROOT" --b-root "$CANDIDATE_ROOT" \
  --records 2000,12000,20000 --rounds 3 --delta 2000 \
  --phases ab --instrument yes --out /tmp/batch-io.json
node --max-old-space-size=4096 scripts/benchmarks/transaction-archive-batch.mjs \
  --steady --a-root "$BASELINE_ROOT" --b-root "$CANDIDATE_ROOT" \
  --records 2000,12000,20000 --rounds 3 --phases aa,ab --instrument no \
  --operations 20 --batches 20 --batch-size 100 --out /tmp/batch-steady.json
node --max-old-space-size=4096 scripts/benchmarks/transaction-archive-batch.mjs \
  --validate --a-root "$BASELINE_ROOT" --b-root "$CANDIDATE_ROOT" \
  --records 2000,12000,20000 --out /tmp/batch-equivalence.json
```

真实验收通过本轮独立 `dist/transaction-archive-batch-final-20261029` 产物安装三个声明宿主；证据在 `docs/evidence/transaction-archive-batch-dsh-*.json`。发布固定点未更新，不能把本轮开发产物称为已发布版本。

## 最终源码的无插桩端到端结果

最终生产代码为 `a04de4f10ac865c32fa95666907411cfede71236`，后续只补不分发的证据文档。冻结源码摘要（基准的 lib/ 目录身份）：基线 `27f432b099dae105db3e37c18e1ecabed5a005a07f767465784a199fd5615ef8`；候选 `00157507dd4995dee4b365a1565a46ba1d3d439bd5028ff61d334c9b2bde6ccf`。

[完整汇总](transaction-archive-batch-final-timing-20261029.json)、[追加式原始样本](transaction-archive-batch-final-timing-20261029.samples.jsonl)：72 个独立进程，AA/AB 各三轮、三档 cold 与历史增量。每侧三轮中位数，ms；RSS 为含 seed 的生命周期峰值，MiB。

| 场景 | 历史/冷条数 | 基线墙钟 | 候选墙钟 | 绝对节省 | 耗时降低 | CPU 基线/候选 | RSS 基线/候选 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 冷吸收 | 2,000 | 380.9 | 240.0 | 140.9 | 37.0% | 411.2 / 255.3 | 106.7 / 95.7 |
| 冷吸收 | 12,000 | 2057.9 | 1265.3 | 792.6 | 38.5% | 2185.0 / 1347.0 | 215.9 / 221.7 |
| 冷吸收 | 20,000 | 3454.7 | 2091.5 | 1363.2 | 39.5% | 3796.7 / 2312.6 | 265.6 / 264.6 |
| 历史后增量 2,000 | 2,000 | 1412.6 | 308.2 | 1104.3 | 78.2% | 1466.4 / 337.0 | 176.4 / 189.5 |
| 历史后增量 2,000 | 12,000 | 4456.4 | 438.1 | 4018.3 | 90.2% | 4638.1 / 482.2 | 363.0 / 326.7 |
| 历史后增量 2,000 | 20,000 | 7279.3 | 502.6 | 6776.8 | 93.1% | 7561.5 / 552.3 | 411.8 / 351.4 |

20,000 冷吸收三对实际节省 1,359.0 / 1,395.8 / 1,345.1 ms；20,000 历史增量三对节省 6,739.7 / 6,787.5 / 6,778.3 ms。全部保留，未挑选或丢弃慢样本。

A/A 噪声也完整保留：2,000 / 12,000 / 20,000 冷吸收两侧中位数差为 +3.8 / +83.0 / -42.9 ms，其中 12,000 一对慢 +327.1 ms；历史增量为 +2.3 / -24.4 / +5.7 ms，20,000 的逐对差为 +115.8 / +33.4 / -236.9 ms。A/B 三对收益方向一致，CPU 同时下降，但中位数不是延迟上界。

RSS 并非全部下降：12,000 冷吸收峰值约增加 5.8 MiB，2,000 历史增量约增加 13.2 MiB；20,000 冷吸收约低 1 MiB，12,000 / 20,000 历史增量分别低约 36 / 60 MiB。它们是包含夹具、seed 与 GC 的进程峰值，不是 pending 缓冲严格上界；不能声称内存零回退。原始数据同时提供测量前后 RSS、heap、external、arrayBuffers 和 resourceUsage 差值。

## 独立审核与兼容性修复

sol-loop 共两轮，模型为 GPT-6.1 Sol。主代理的 T3 请求与返回均为 `codex / gpt-6.1-sol / reasoningEffort=xhigh`，两轮只读 reviewer 的实际会话 runtime_info 也报告相同模型与档位；未获得独立后端遥测，usage 未返回。第一轮对完整行为 diff 审核，第二轮只复核新增修复与 S1。没有降档或替换 reviewer。

| ID | 级别 | 结论与证据 |
| --- | --- | --- |
| S1 | should | 缺少 count 的旧冷元数据尚未建立 archiveKnown；首次淘汰被缓冲，后续冷 trial 的 measurement 更新可能绕过 drain，淘汰时被旧 id 去重跳过。真实复现得到 trial-completed 而非 measured。修复在首次缓冲前调用原 #archiveRead 建立 key 表，后续 cold id 先 drain，再走原 replacement；新增官方后端差分用例验证。第二轮判定 resolved，APPROVE，无 S2。 |

审核前范围内 diff 为 7 文件、946 行新增/15 行删除，修复后为 977 行新增/15 行删除（包含基准与回归夹具）。未接受额外重构，无 declined finding。原 17 项新测试扩为 18 项；最终完整测试入口 1,266 项通过。历史逆向夹具仍逐字节还原 6b4dee9，再走原 marker-window 与更早的固定基线；未修改任何旧摘要 pin。

`transaction-archive-batch-{timing,steady}-20261029` 文件属于 S1 修复前的候选，仅保留为探索证据；最终验收使用 `transaction-archive-batch-final-*`，以本页最终表格为准。

## 最终稳态与长寿命端口

[最终三轮 A/B 汇总](transaction-archive-batch-final-steady-20261029.json)、[原始样本](transaction-archive-batch-final-steady-20261029.samples.jsonl)。普通 observe 已预热 observations 档案，每样本计 20 次；空 flush 计 20 次；长寿命端口计 20 批 × 100 条事件，生产者 append 和 replay 一起计时，输入签名在计时前准备。表中都是整批操作的三轮中位数，不是单次延迟。

| 场景 | 初始历史 | 墙钟 基线/候选 ms | CPU 基线/候选 ms | 峰值 RSS 基线/候选 MiB |
| --- | ---: | ---: | ---: | ---: |
| 20 次 observe | 2,000 | 1105.5 / 1122.7 | 696.4 / 710.8 | 239.6 / 244.9 |
| 20 次 observe | 12,000 | 1844.9 / 1849.1 | 1502.3 / 1487.3 | 409.1 / 398.8 |
| 20 次 observe | 20,000 | 2242.3 / 2250.2 | 1871.5 / 1874.2 | 426.0 / 435.0 |
| 20 次空 flush | 2,000 | 22.8 / 22.9 | 23.2 / 23.3 | 137.1 / 122.6 |
| 20 次空 flush | 12,000 | 131.0 / 134.4 | 131.5 / 148.4 | 251.4 / 277.5 |
| 20 次空 flush | 20,000 | 221.8 / 220.9 | 222.9 / 222.1 | 296.0 / 296.7 |
| 20 × 100 条连续吸收 | 2,000 | 2809.1 / 1683.1 | 2573.5 / 1315.9 | 279.9 / 284.1 |
| 20 × 100 条连续吸收 | 12,000 | 7475.6 / 3459.8 | 7449.5 / 3286.3 | 454.2 / 419.8 |
| 20 × 100 条连续吸收 | 20,000 | 10832.5 / 4092.3 | 10911.7 / 4128.4 | 463.9 / 492.4 |

连续批次耗时降低约 40.1% / 53.7% / 62.2%。observe 的两侧中位数上升 0.2%–1.6%；空 flush 在 12,000 历史时上升约 3.4 ms（2.6%），其余差约 0.1 / -0.9 ms。observe 的逐对差为 2,000：+17.2/-17.6/+32.1 ms，12,000：+9.3/+74.6/+4.2 ms，20,000：+7.9/-30.7/+31.5 ms；12,000 空 flush 为 +1.8/-4.9/+4.1 ms。因此没有证明 observe 或空 flush 加速，也不声称零回退。修复前文件中的 A/A 部分仍然是同一 6b4dee9 基线的同码控制：observe 差值范围约 -51.5 至 +61.9 ms，空 flush -1.3 至 +7.5 ms；与主数据一并保留，不能把小差异当作确定性回归或收益。

稳态峰值 RSS 的代价比冷路径更大：20,000 历史连续吸收约增加 28.5 MiB，12,000 空 flush 约增加 26.1 MiB。进程峰值包含两侧不同的 seed 分配/GC 历史，未做保留堆的因果归因，也未用强制 GC 美化端到端数据。原始 operationSamples 提供每一步内存，不能把 20 批的有限观察外推为长期无泄漏证明。

成本没有拖到 close 再支付：applyExecutionEvents 返回前已经 drain，mutate 在返回前完成 index flush、stage fsync 与提交。确定性验证另在测量外核对空 flush 与两次重开不改变任何 archive/index 字节。封段沿用原规则，20,000 冷负载实际跨段，小阈值差分与三类 seal 故障测试另覆盖边界和失败后重放。

## 实际归档工作减少量

[有插桩三轮 A/B](transaction-archive-batch-final-io-20261029.json)、[原始样本](transaction-archive-batch-final-io-20261029.samples.jsonl)。下表每侧为三轮 API 调用次数中位数，计数窗口仅含待测 open；历史 seed 的 I/O 不在计数窗口内。openSync/readSync 是全部归档数据文件操作，包含尾部探测、缓存证明与扫描，不把它们全称为尾部探测。

| 场景 | 条数 | appendFile 基线/候选 | openSync 基线/候选 | readSync 基线/候选 | statSync 基线/候选 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 冷吸收 | 2,000 | 1950 / 8 | 1954 / 12 | 1953 / 11 | 4028 / 144 |
| 冷吸收 | 12,000 | 11950 / 47 | 11954 / 51 | 11959 / 56 | 24028 / 222 |
| 冷吸收 | 20,000 | 19950 / 79 | 19959 / 87 | 19957 / 85 | 44100 / 307 |
| 历史后增量 2,000 | 2,000 | 2000 / 8 | 2007 / 15 | 2009 / 18 | 6128 / 152 |
| 历史后增量 2,000 | 12,000 | 2000 / 8 | 2008 / 16 | 2028 / 36 | 6128 / 152 |
| 历史后增量 2,000 | 20,000 | 2000 / 8 | 2012 / 20 | 2026 / 34 | 8140 / 172 |

20,000 冷吸收减少 **19,871 次 appendFile（99.60%）**、19,872 次归档 openSync 和 43,793 次归档 statSync。每次 append 实际承载多条完整 JSONL 行；不是更换同步 API，也不是跳过原 writer。归档 writeFile 仍为 2 次、rename 仍为 1 次，跨段没有被推迟或取消。历史增量的 2,000 次 append 变为 8 次；可携带缓存的键表/locator 更新也由逐行变为逐批，不再重复复制大历史表。

小规模机制回归另精确断言：570 事件、520 条冷淘汰为 256/256/8 三次实际 append，非空尾部探测两次；普通非私有 Memory 的 60 事件仍是 10 次 append。主性能结果使用无 fs 包装的独立运行，以上计数不用于相加推算可节省时间。

## 包装扰动、字节等价与最终验收

[20,000 条包装校准](transaction-archive-batch-final-overhead-20261029.json)、[原始样本](transaction-archive-batch-final-overhead-20261029.samples.jsonl)：同码无包装/有包装三轮，冷路径两侧中位数 3,454.9 / 3,545.4 ms（约 +2.6%），逐对 +32.6/+119.8/+90.5 ms；历史增量中位数 7,229.1 / 7,238.3 ms，逐对 +32.0/-25.1/-16.9 ms。主收益来自独立无包装运行，未从插桩计时推算节省。

[最终确定性等价结果](transaction-archive-batch-final-equivalence-20261029.json)、[原始样本](transaction-archive-batch-final-equivalence-20261029.samples.jsonl)：三档 cold/历史增量共 12 个独立进程，每侧检查吸收后、空 flush 后、两次关闭重开并 flush 后的 4 个状态。完整状态内容、applied ledger、marker、query、原始索引 SHA-256 和逐文件 JSONL SHA-256 均 A/B 一致，重启也不改变结果。原始索引摘要同时参与严格比较，归一索引时间戳的辅助摘要不能掩盖它的差异。性能运行的实时 timestamp/path 树摘要不相等不作为字节等价结论。

最终验证针对生产源码 a04de4f：带 4096 MiB 堆上限的完整 npm test 1,266/1,266；pack:check 开发语义 16 项；新 tarball content-only against-tree；固定 release 字节校验；三个官方宿主各 21 步隔离验收，全部通过。最终本地产物 contentSha256 为 `2064c9c5f07e68a73491d977230b3c71df38c9d929c3cd5f52c8c6522b8750fc`，不是发布固定产物的 contentSha256。最终基准共 186 个独立 worker（72 主测量、54 稳态、36 I/O、12 包装校准、12 等价），全部完成源码前后围栏。

[交互图](transaction-archive-batch-chart.html) 可切换场景与墙钟/CPU；[验证记录](../evidence/transaction-archive-batch-validation.json) 记录命令、日志摘要、源码与证据身份。边界：证据只覆盖该合成事件尺寸、三个规模和有限 20 批运行；知识密集、频繁 id 替换、单条小流量以及更长运行时间不能外推相同收益。内存峰值有已报告的增加，普通 observe/空 flush 的小幅慢差未被隐藏。

提交的汇总 JSON 通过 samplesFile/sampleCount/samplesSha256 引用逐样本 JSONL，避免把同一批数据重复提交两份。整理时先断言原 report.samples 与 JSONL 每条解析值完全相等，再移除汇总里的重复数组；原始 JSONL 字节不变。基准脚本直接运行仍会生成含 samples 的原始完整报告和同一份逐样本 JSONL。
