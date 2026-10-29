# 20k 冷吸收逐条应用成本审计（d9de6b2，2026-10-29）

这是测量与候选排序，**没有改生产代码，也没有证明一项新优化已经安全或有端到端收益**。继承
[`current-cold-d9de6b2-20261029.md`](current-cold-d9de6b2-20261029.md) 与
[`archive-append-window.md`](archive-append-window.md) 的排除结论：不重做日志前缀认证、全表
摘要、事务提交校验、归档索引合并，也不恢复已经被反例击穿的「文件身份相同就跳过尾字节」方案。

结论：20k 冷吸收约 **4.18 秒**，逐条应用约 **3.91 秒**。保存检查的真实同步墙钟约
**2.06 秒，占逐条应用约 53%**；旧 profile 的约 1.3 秒 self 不是这段工作的完整成本。
正文序列化约 0.70 秒；窗口重复判定访问 **73,529,344** 个 marker，约 1.10 秒。
归档路径约 1.43 秒，其中异步 append API 往返约 0.66 秒，尾部探测相关同步 open/read/close
约 0.34 秒。分配采样估计约 3.06 GiB，marker 的 push/slice 占约 1.27 GiB；这不是保留内存。

## 方法与扰动

源提交固定为 `d9de6b2671f185bb4ec7d538e842e8c1a070fb8e`，Node v26.12.1、darwin/arm64。
使用 `archive-append-window.mjs` 原有真实 `openDomainStorage()`、官方 DomainFacility /
JsonStorageBackend 和同一份 20k 合成签名夹具。每样本独立子进程、独立临时目录，堆上限
4096 MiB，串行执行，逐轮反转模式顺序。没有读取用户数据或正式 home。

新脚本只在 `git archive` 解出的临时 lib 中插桩，不修改工作树 lib。所有模式都在首次 open
结束时关测量窗口；附带的稳态 flush 和 warm observe 不进入 CPU / 分配 profile。
每轮原有 `flush()` 断言确认所有 20k 事件已被 checkpoint 覆盖。详细轮另外断言保存次数、
marker 访问数、首次 marker 序列化次数和 append 次数，锚点缺失或不唯一就中止。

| 测量组（各 3 次） | 冷吸收墙钟中位 ms | CPU ms | 墙钟范围 ms |
| --- | ---: | ---: | ---: |
| 未插桩 control | 4179.3 | 4420.4 | 4154.4–4189.2 |
| 详细阶段 / 内部 / I/O 插桩 | 4378.6 | 4641.1 | 4304.7–4407.5 |
| 仅冷吸收 CPU sampling | 4269.0 | 4564.4 | 4196.6–4270.1 |
| 仅冷吸收 allocation sampling | 4282.3 | 4520.5 | 4244.7–4297.3 |
| 独立补测 control | 4182.7 | 4419.2 | 4169.5–4183.6 |
| 只在检查函数调用外层计时 | 4188.9 | 4436.0 | 4187.8–4200.2 |

详细插桩较同组 control 增加 **4.77%**，CPU sampling 增加 2.14%，allocation sampling
增加 2.46%。这些差异是测量成本，不是候选收益。外层单独计时只增加 0.15%，因此用它判定
保存检查的总成本；内部拆分和 I/O 来自详细轮，不把它们冒充无扰动精确值。
后续 `exclusive` 组拆开真正 persist 与 marker 的 skip-persist 保存，以免重叠相加。

原始数据：
[`主测量`](cold-apply-cost-d9de6b2-20261029.json)、
[`主摘要`](cold-apply-cost-d9de6b2-20261029-summary.json)、
[`外层单独计时`](cold-apply-cost-saveonly-d9de6b2-20261029.json)、
[`互斥成本及线程 CPU 补测`](cold-apply-cost-exclusive-d9de6b2-20261029.json)、
[`互斥摘要`](cold-apply-cost-exclusive-d9de6b2-20261029-summary.json)。
CPU / heap 原始 profile 以 JSON 的 `profileFile` 指向同目录 `.gz`，无损压缩。

## 保存检查的真实成本

仅外层计时三次 `assertStagedTransactionSave()` 的累计同步墙钟为
**2064.7 / 2056.5 / 2053.7 ms**，均恰好 20,000 次；对应逐条应用
3923.6 / 3913.9 / 3910.6 ms。

另一次只在外层增加 `process.threadCpuUsage()` 的补测，检查累计墙钟
2031.5 / 2067.5 / 1994.4 ms，累计主线程 CPU 为 2068.0 / 2102.7 / 2031.5 ms。
CPU 包含逐次读取计数器的成本，约比被包围的墙钟多 35–37 ms，不能拿这个差值当生产成本。
它确认这里主要是同步 CPU 工作，而不是 0.8 秒的归档等待。

冷吸收 CPU profile 中，检查函数 inclusive sampling 只有
1228.8 / 1202.8 / 1202.1 ms；应用窗口里 sampler 标成 idle 的时间为
1737.4 / 1893.2 / 1887.6 ms。**采样归属与直接同步计时不一致；不能用 idle 数字反推 I/O 等待，
也不能把检查的 self 采样时间当完整预算。**本轮没有查明 V8 sampler 为什么这样归属。

下面取 exclusive 第 0 轮作为一个完整、可相加的代表样本，避免「各组件中位数相加不等于总量」：

| 逐条应用的互斥工作 | 墙钟 ms | 占应用 |
| --- | ---: | ---: |
| `#save` 真正 persist（含保存检查） | 2030.9 | 50.7% |
| `#archiveEntries`（含其同步调用与异步等待） | 1431.5 | 35.7% |
| `#markBridgeApplied`（含 skip-persist housekeeping） | 92.6 | 2.3% |
| 其余应用逻辑、DTO、clone、队列与调度 | 452.9 | 11.3% |
| **应用合计** | **4007.9** | **100%** |

同一样本的保存检查 2016.0 ms 内部为：正文重建 + stringify 695.7 ms，marker loop
1098.6 ms（其中新 marker stringify 7.3 ms），门控、正文 literal 搜索及其它剩余 221.6 ms。
这三块是嵌套预算：不能再把 marker stringify 加到 loop 上，也不能把整个保存检查再加到 persist 上。
三轮互斥残差为 452.9 / 451.3 / 451.2 ms，没有把未归属成本藏进 I/O。

机制计数三轮一致：

- 真正保存检查 20,000 次；marker skip-persist 保存另有 20,000 次。
- 正文减窗口 stringify 19,999 次、521,234,115 个字符；空窗口首次走原整体检查。
- marker loop 19,999 次，访问 `sum(min(i,4096), i=0..19999)` = **73,529,344** 项。
- 新 marker stringify 19,999 次、3,637,605 个字符；检查发生在新 marker 加入之前，所以最后一个
  marker 不在本次逐条检查中，最终发布仍校验完整文档。
- 总应用 stringify 59,949 次、534,803,230 个字符；structuredClone 40,000 次，约 76.7 ms。

JSON 计数字段 `bytes` 实际记 `text.length`（UTF-16 code units）；本合成夹具为 ASCII，才等于
UTF-8 字节数。这些生成过的字节不等于写盘流量。

## 归档 I/O 与其它阶段

exclusive 三轮中位：归档 1431.5 ms。内部可观察 API 往返包括：

| API | 调用次数 | 累计墙钟 ms |
| --- | ---: | ---: |
| `appendFile` | 19,950 | 663.6 |
| `statSync` | 43,020 | 131.7 |
| `openSync` | 19,950 | 301.3 |
| `readSync`（按 fd 跟踪） | 19,949 | 24.4 |
| `closeSync`（按 fd 跟踪） | 19,949 | 13.6 |

append payload 共 9,950,526 B；异步耗时包含 libuv 调度、open/write/close 和完成通知，
**不是物理盘等待测量**。同步 open 等调用含内核工作。归档总时间还包括序列化、索引元数据、
封段、缓存更新等约 0.29 秒；没有把全部归档时间都叫 I/O 等待。

代表样本整次 open 4310.8 ms 的其它阶段：打开/初始 hydrate 17.6，日志规划 9.7，解析认证
166.8，事务准备 2.6，应用 4007.9，最终 snapshot / deferred index / pending 发布安装 /
再次 hydrate 99.6，checkpoint 收尾 6.5 ms。阶段边界自身采样还有微小开销，不能要求小数末位相加
精确等于外层墙钟。发布阶段 stringify 约 15.1 ms / 9.24 MB，clone 约 4.1 ms；它不是逐条应用的
大项，也不是本轮要重做的全量提交校验。

## 分配与 GC

HeapProfiler samplingInterval = 32 KiB，开启 major/minor collected objects，使 profile 估计
累计分配，而不是仅存活对象。窗口从夹具生成后、首次 open 前开始，到 open 后立即停止；含少量 hook
启动/停止开销。三轮估计总量 **3061.1 / 3067.2 / 3054.4 MiB**，分组如下：

| 调用栈归属 | 分配估计中位 MiB |
| --- | ---: |
| `#markBridgeApplied` 子树 | 1461.3 |
| 其中 push builtin | 703.6 |
| 其中 slice builtin | 569.8 |
| 保存检查子树 | 585.3 |
| 其中检查函数自身（主要含生成正文字符串） | 507.7 |
| 认证 canonical JSON 子树 | 140.1 |
| 其余 | 875.1 |

marker 窗口每次 push 后 slice 到 4096，重复产生大数组及扩容，是可定位的分配源。
但整个 `#markBridgeApplied` 墙钟只有约 93 ms；未插桩冷吸收的 GC observer 累计 pause 中位
21.3 ms，约总墙钟 0.5%。因此减少这 1.27 GiB **不能直接声称会省 1.27 GiB RSS，也不能声称
有秒级提速**。未测分配栈对应的峰值可达对象，不用进程 maxRSS 推导它。

## 候选排序与安全边界

1. **首选研究 marker 窗口判定的增量维护，预算约 1.1 秒。** 已有 WeakMap 只避免同一个 marker
   重新序列化，仍对 4096 窗口反复 get。`#markBridgeApplied` 是本实例窗口写者，已维护 bridge
   id 索引；可以研究由该写者同时维护「本窗口是否全部持有可复用且不带 literal 的 verdict」的
   私有证明，再让 staged checker 使用。必须保留正文 stringify 与所有现有回退。**仅缓存数组身份
   不安全**：数组仍可变，push/slice 会换窗口，旧验证结果不能证明新成员。通用导出检查函数还接受
   非标准窗口，不能把测试夹具的冻结 marker 假设推广到它。需要显式内部证明通道、同一事务有效期、
   异常/原型/toJSON/稀疏窗口差分及持久字节等价后，才可称安全候选；本轮未实现。1.1 秒是可移除
   工作的上限，不是承诺收益。
2. **第二候选：仅在已私有化、独占的 staged 文件上复用本次事务写出的换行事实，预算约 0.34 秒。**
   当前每次尾部探测约 open 0.30 秒 + read/close 0.04 秒。第一次必须探测已提交文件并处理 torn
   tail；后续只有在文件已由 archiveWriteGuard 私有化、所有写入均经过本事务且没有第二写者的
   显式前提下，才可研究跳过重复读取。不能用 inode/size/mtime 相等代替独占证明，不能影响直接
   Memory 使用路径，也不能跳过首个坏尾部。这需要很小的受限合同及失败路径测试，当前没有验证
   它的安全性或真实收益。沿用旧身份缓存方案仍明确排除。
3. **若目标是分配流量，再研究 staged 窗口的有界原地维护。** 可能减少 push 扩容与 slice 的
   约 1.27 GiB 分配；必须证明旧数组引用不可观察，并同步修改 bridgeWindowShifted 的移出成员
   逻辑，不能只把 slice 删掉。通用 stateStore / 非 inline serialization 路径需要保留原行为。
   由于可计时工作只有约 0.1 秒，排在两个墙钟候选之后。

**没有把正文 stringify 列为可直接删除项**：它仍承载「该次 save 就拒绝不可序列化值」的行为，
已有研究已经固定反例。增加按行缓存需要另一个真实不可变性合同，不能因为本夹具行稳定就静默引入。
本轮提供了有依据的候选和收益上限；没有获得足以宣布安全生产优化的证据。

## 复现与校验范围

```sh
node --max-old-space-size=4096 scripts/benchmarks/archive-apply-cost-audit.mjs \
  --ref d9de6b2 --records 20000 --rounds 3 --modes control,detail,cpu,allocation \
  --out docs/performance/cold-apply-cost-d9de6b2-20261029.json
node --max-old-space-size=4096 scripts/benchmarks/archive-apply-cost-audit.mjs \
  --ref d9de6b2 --records 20000 --rounds 3 --modes control,saveonly \
  --out docs/performance/cold-apply-cost-saveonly-d9de6b2-20261029.json
node --max-old-space-size=4096 scripts/benchmarks/archive-apply-cost-audit.mjs \
  --ref d9de6b2 --records 20000 --rounds 3 --modes control,savecpu,detail \
  --out docs/performance/cold-apply-cost-exclusive-d9de6b2-20261029.json
node --max-old-space-size=4096 scripts/benchmarks/archive-apply-cost-summary.mjs \
  docs/performance/cold-apply-cost-d9de6b2-20261029.json
```

正式原始 profile 由脚本写为未压缩 JSON，本记录保存时额外 gzip 并更新 `profileFile`，摘要工具
两种格式都支持。源哈希记录测量时脚本；外层 CPU / 互斥模式是后续渐进增加，主组和补测组的脚本
哈希会不同，但生产源哈希相同。

初次 probe 因 housekeeping 锚点不唯一主动中止，改为更窄的唯一锚点后才继续。
[`pilot`](cold-apply-cost-d9de6b2-20261029-pilot.json) 与
[`calibration`](cold-apply-cost-d9de6b2-20261029-calibration.json) 保留早期诊断数据，不用于正式表格。
早期 marker stringify probe 使用捕获循环变量的 callback；初步怀疑它会放大循环分配，随后改为
直接时钟 probe。**后续外层单独计时仍约 2.06 秒，所以没有证据把这段两秒成本归因于那一个
callback，也没有用该猜测解释正式结果。**

已执行：上述 20k 三轮主组、外层组、互斥/线程 CPU 组；四个测量脚本 `node --check`；摘要重建。
只改基准脚本与新增证据，`package.json#files` 不包含这些路径；没有执行生产实现的优化、全量测试、
宿主验收、提交、推送、PR 或发布固定点更新。未测其它 Node、平台、冷页缓存和真实到达分布；未消除
采样归属异常，未完成任何候选的故障/持久字节等价或端到端 A/B。
