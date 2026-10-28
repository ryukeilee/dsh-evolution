# 稳态 flush 的历史轴曲线与显式日志回收价值

本次是只读生产调查，没有实现优化。只新增本报告、[原始数据](axis-steady-history.json) 与[复现脚本](../../scripts/benchmarks/axis-steady-history.mjs)。未提交、推送或读取正式用户数据；所有可变夹具在 `/tmp/axis-steady-*`。仓库原有未跟踪文件未改动。

## 实测方法与边界

- 被测提交 `5a728dd8edb0021d65bc8672bb81557abc1c5e36`；Node v26.12.1，darwin/arm64，8 逻辑 CPU。生产源码 SHA-256 见 JSON `sources`。官方 `dsh-storage-domain` / `dsh-storage-json` 都为 `0.2.0-rc.2`。
- 五档历史，每档每侧每轮都是独立进程和独立夹具，显式 `--max-old-space-size=4096`。3 轮 A/A，顺序 A,B → B,A → A,B，两侧同一份源码；每进程先验证已提交历史，热身 3 次，再测 15 次。表格取每进程 15 次的中位数，再取 6 个进程中位数的常规中位数；范围是这 6 个中位数的最小/最大值。wall/CPU 分别汇总；JSON 保留全部样本。
- 真实 `openDomainStorage()`、`DomainFacility`、`JsonStorageBackend`。日志全部由 `signEventBridgeEnvelope()` 认证；用官方 domain 的 `global.set()` 预置对应 ledger，aggregate 为空，首次 flush 验证全部事件并生成 checkpoint，然后测稳态。这复用旧调查隔离稳态的夹具形状，**不是历史摄取/完整真实业务 aggregate 的成本测量**。
- 未回收曲线事件形状与旧调查相同，前三档日志/marker 字节数也一致。回收实验仍为 20,000 条唯一 eventId，但它们属于同一 experiment，官方 `externalizeEventBridgeEvidence()` 实际持久化一份证据 sidecar。此形状隔离日志/ledger 因素，**不能代表每条事件都属于不同 experiment 的证据写入成本**。
- 日志回收调用 `reclaim({confirmation:true, archives:false, retainRecords})`；这是公开 maintain 允许的日志分支，未测默认 `archives:true` 下真实冷档案压缩。测量夹具本身无冷档案。时间包含证据持久化、领域事务、floor、截断及 checkpoint。完整工具还包括结果投影和 finally flush；下面将末尾 flush 成本计入推算，但未测工具序列化开销。
- 这里测的是热文件系统缓存，无并发写者、无冷盘、无真实用户数据；峰值子进程 maxRSS 为 509,168 KiB（包含构造与回收）。没有发生堆溢出、栈溢出或超时。

## 完整曲线（实测；最后一列为推算）

| 历史条数 | wall ms/flush | CPU ms/flush | 六进程 wall 范围 ms | 日志字节 | applied JSON 字节 | JSON 字节/marker | 200 次 pre-step 累计秒（推算） |
| ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 200 | 0.154 | 0.162 | 0.153–0.157 | 127,168 | 24,493 | 122.46500 | 0.031 |
| 2,000 | 1.073 | 1.082 | 1.050–1.100 | 1,279,572 | 246,894 | 123.44700 | 0.215 |
| 20,000 | 10.974 | 10.977 | 10.815–11.140 | 12,875,576 | 2,488,895 | 124.44475 | 2.195 |
| 50,000 | 27.571 | 27.697 | 27.240–27.740 | 32,255,576 | 6,238,895 | 124.77790 | 5.514 |
| 100,000 | 61.293 | 61.406 | 60.944–61.786 | 64,555,580 | 12,488,896 | 124.88896 | 12.259 |

用五档汇总 wall 做最小二乘直线，斜率 **0.6093 ms/1000 条事件**；这只是该区间的经验拟合，不能当作全历史范围的恒定系数。相邻区间斜率分别为 **0.5106 / 0.5500 / 0.5533 / 0.6744 ms/1000**；50,000→100,000 出现更高单位增量，未对其归因为 GC 或某种 V8 阈值（没有相关归因证据）。旧报告 200/2000/20000 的 0.181/1.062/10.765 ms，本轮为 0.154/1.073/10.974 ms；同形状复核支持随历史增长的结论，没有声称跨日期性能完全一致。

`registration.js:429–433` 每个 `agent/pre-step` 都 await flush；`registration.js:252` 每个注册工具 finally 也 await flush，工具失败时也尝试。没有以 session reset 为周期的限制，也没有合并普通 flush：`enqueue` 只串行排队，调用一个就排一个 replay。200 轮、每轮一次 pre-step 的公式是 `200 × 本档稳态 wall`，假设历史不再增长、每次都有可用 checkpoint、无锁等待、无新事件。若还调用 K 次 evolution 工具，仅这些稳态 flush 的推算变成 `(200+K) × wall`；携带新事件的 pass 还有认证/事务成本，本次没有测量。以上是频率语义与推算，**不是生产会话遥测**。

## 谁把 digestApplied 的输入写满

`memory.js:4036–4051` 的 `#markBridgeApplied` 只保留 `aggregate.evolution.eventBridge.applied` 最近 4096 条，是领域 memory 的执行效果去重窗口。另一张表 `domain.global.get().applied` 是整个事件桥的 eventId→MAC 权威 ledger。`domain-storage.js:884–895` 查该表去重/拒绝冲突；`:912–914` 合并新 marker，`:923–927` 明确解释：长于 4096 的批次不能依赖 memory 窗口。`digestApplied()` 绑定的是**全表**；有 floor 时还绑定 retention 的固定大小投影。

**除显式 reclaim 外，插件没有按数量、年龄、session 或 reset 自动裁剪这张全表的路径。** 普通 mutation 用 `mergeEventLedger()` 保留旧 marker，pending recovery 安装已经提交的完整表；正常重放只加入新的唯一 eventId。同 ID 同 MAC 的重复不会增加项数，同 ID 异 MAC 拒绝。唯一正常删除点是 `reclaimLog()` 中 `delete ledger[eventId]`（`:1074`），并与 retention floor 一起提交。新数据根/显式 domainSeed 是初始化，不是日常保留上限。

因此未 reclaim 时 **N（已接受的唯一 eventId 数）没有代码规定的长期数量上限**，仅受可用内存、JSON/后端和磁盘等实际资源限制；4096 不是上限。设平均 key UTF-8 字节数为 L，MAC 为 64 字节十六进制字符串，合法 ASCII key 无需 JSON 转义，则 N>0 时：

`applied JSON bytes = 1 + Σ(keyBytes + 70) = 1 + N × (L平均 + 70)`。

空表为 2 字节。以每项 JSON 摊销字节 b 表示，增长约 `Δbytes ≈ b × ΔN`。本夹具为上表 **122.465–124.889 字节/marker**，后缀序号变长使 b 轻微增加；100,000 项占 12,488,896 字节。按 b≈125 推算百万项约 125 MB（十进制），**不含 JS 对象内存、aggregate、pending 文档与日志**。运行时 `safeIdentifier` 接受最多 160 个 ASCII 字符，普通有效 marker 的序列化体积可用 `≤230N+1` 估算上界；这约束单项大小，仍不约束 N。

## 一次显式日志回收的收益

新回收事务只由 owner 显式 maintain/reclaim 发起；已提交 floor 后尚未完成的截断，启动或 flush 会自动幂等补完。这是完成既有事务，不是后台发起新的回收。

以下均从 20,000 条历史开始，每个 retain 档同样独立 A/A 三轮，前后在同一进程测量。日志在该夹具中每条约 647 字节；回收后最后的 eventId 都有五位序号，所以 marker JSON 约 125 字节/项。

| retain 参数 → 实际保留 | 回收前 wall ms | 回收后 wall / CPU ms | 回收后日志 / marker JSON 字节 | reclaim wall ms | 每次 flush 降幅 | 抵消回收+末尾 flush 所需 pre-step（推算） | 200 次净节省 ms（推算） |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 → 1024 | 10.945 | 0.891 / 0.891 | 662,528 / 128,001 | 356.43 | 91.9% | 36 | 1653.5 |
| 200 → 200 | 11.028 | 0.231 / 0.233 | 129,400 / 25,001 | 354.33 | 97.9% | 33 | 1804.7 |
| 2000 → 2000 | 11.018 | 1.726 / 1.730 | 1,294,000 / 250,001 | 361.34 | 84.3% | 40 | 1495.3 |
| 5000 → 5000 | 11.095 | 4.129 / 4.144 | 3,235,000 / 625,001 | 360.30 | 62.8% | 53 | 1028.8 |

盈亏平衡公式：`ceil((reclaim_wall + after_flush_wall)/(before_flush_wall-after_flush_wall))`。200 次净节省：`200×(before-after) - reclaim - after`。没有把历史回收成本隐藏为零，也没有把回收后某次 flush 单独看成“一次维护即可永久消除增长”。新事件会继续增长全表和日志，后续边际成本再次上升。

预跑实际发现并保留的边界：`retainRecords:0` 按 `Number(retainRecords) || DEFAULT_LOG_RETAIN_RECORDS` 回到默认 1024，最小 1；第一次预跑因基准误断言为 0 条而失败，修正断言后重跑。另一次预跑的 retain=10000 要保留 6,470,000 字节，触发 `E_DOMAIN_EVENT_LOG_RETAIN_UNBOUNDED`（4,194,304 字节上限），故正式运行改成 5000。两次失败均不是成功样本，不计入表格；正式 JSON 的 54 个子进程全部成功。不能向用户保证“任意 retainRecords 都能回收”。

文档引导的价值在本夹具中可量化：默认日志维护约 0.356 秒、后续 36 次 pre-step 抵消成本，200 次净省约 1.66 秒。真实每实验独立证据 sidecar、更大的 aggregate、冷档案完整性扫描与压缩都会改变维护耗时；应先看 dryRun，而不是按本表规定自动维护周期。这是解释显式 owner 操作价值，**没有提出改保留策略、添加定时器或自动触发维护**。

## 稳态是否还有第三项，是否写盘

每个子进程在计时外单独执行一次计数 pass，拦截同步 fs、promises fs、官方后端 FileHandle write/sync、`domain.global.set` 与 crypto 输入字节。54 个计数 pass 都未触发 domain.set、写文件、rename、mkdir/rm、fsync 或 handle.sync。`enqueue()` 自身只维护 Promise 链与 AsyncLocalStorage；稳态 `batch` 为空，`commit()` 立即返回，不进入 `mutate()`；`advance=false`，不重写 checkpoint。**没有写盘不等于没有同步 I/O**。

- 无 floor：只读一次 checkpoint、打开一次日志。100,000 档读取 64,555,580 个日志字节；哈希输入包括这份日志、12,488,896 字节 marker JSON、固定大小的 checkpoint MAC 与 HMAC padding。没有发现 readEventLog 和 digestApplied 之外第三个 O(总历史) 项。空 tail 分行、writer/identity/witness 检查、checkpoint JSON 校验都不随 N 增长；官方 `global.get()` 直接返回内存引用，不复制整表。
- 有 floor：`replay()` 在 plan 之前调用 `completeEventLogTruncation()`；即便截断早已完成，`inspectEventLogFloor()` 仍打开日志、读 retained tail 并 HMAC。之后 `readEventLog()` 再次打开并认证整个日志。这是**第三个 O(最后一次 floor 保留字节)** 项，不随已经丢弃的总历史增长，却随 retainRecords 增长。保留 2000 条的计数实测两次 open、5 次 readSync、2,588,000 日志读取字节（恰为 2×1,294,000），总哈希输入 2,839,133 字节。对应未回收的 2000 条稳态只读约 1.28 MB，解释了回收后同样项数仍较贵的结构性原因。

## 排除方向与等价改写判定

| 方向 | 是否信任 stat/mtime | 是否只是缓存 | 判断 |
| --- | --- | --- | --- |
| 只处理新增字节，凭 size/mtime/inode 判断旧前缀未变 | 是 | 是 | 排除：旧位置同长篡改会不再逐次被认证；元数据不能证明字节未改 |
| 保存前次 hash 状态或摘要，仅给新增字节 update | 若不重读必须另有不变证明 | 是 | 排除：仍依赖前缀不变假设；当前外部可写文件协议无此证明 |
| 换成增量/Merkle ledger，只更新新增 key | 否 | 可不是缓存 | 仍需每次证明当前活表没有其它变化；改变 JSON 整表摘要格式、持久化协议或写入权威边界，不是当前协议的等价改写 |
| WeakMap、内容缓存、受保护 digest 复用 | 不一定 | 是 | 按既有反例与本任务范围排除，未重测或重新提出 |
| whole-log 读取、1→4 MiB chunk | 不一定 | 不一定 | 已撤回方向，不重新实现或测量 |
| 将认证移到 worker / 改变 flush 频率 | 否 | 否 | 可能改主线程阻塞，但不消除 O(历史) 工作；改变活表读取时机、排队和失败传播，超出等价性能改写范围 |
| 合并 floor 检查与 replay 的重复读/HMAC | 不必信任元数据 | 可以不跨 pass 缓存 | **可研究但未证明等价**：当前先补完提交后未截断事务，再规划 replay；两次 open 可观察不同 inode/字节。合并不能跳过 deferred 补完、缺日志/损坏 floor 的拒绝或失败顺序，也需满足逐次 crypto 调用的可观察性。仅凭静态稳态相同字节，不能称全协议等价 |

固定现有协议与逐次认证承诺时，无新事件也必须 Ω(日志已消费字节 + marker 序列化字节)：若某个旧日志字节本次既不读也无更强不可变证明，同位置改写与未改写对算法不可区分；若活 marker 表某个值不再参与本次 JSON 摘要，其无信号变更也可能不被发现。将工作降到 O(新增字节) 必须引入新的不可变/存储信任合同或弱化检测，不是这里发现的等价改写。

**本轮没有发现“已证明等价且显著节省”的新候选，因此不提出实现。** floor 双认证是实际重复工作，但其去重仍有上述协议证明缺口，不能把它包装成确定收益方案。按同机曲线差异粗估，其潜在上限是消除一遍保留尾部读+HMAC，约 0.3 ms/1000 条、回收后约三成成本；这是推断，未实现候选、未做对拍或候选计时。无 floor 稳态的日志只读且哈希一次，空 tail 不做大 Buffer 拷贝；`digestApplied` 也只序列化/摘要一次。已有文档记录的 digest fork 微冗余不是新发现且量级极小，不作为候选重新提交。

## 复现与实际验证

```sh
node --max-old-space-size=4096 scripts/benchmarks/axis-steady-history.mjs \
  --out docs/performance/axis-steady-history.json
node --check scripts/benchmarks/axis-steady-history.mjs
```

复现会覆盖本调查 JSON；脚本不覆盖其它仓库文件，子进程硬带 4096 MiB V8 上限，单进程超时 300 秒。正式测量完成后只调整了偶数个样本的汇总中位数为两中值平均，并从已保存的全部原始样本重新汇总；子进程每次 15 样本的测量未改变。检查了全部 54 行 marker 数、认证重复计数、无写盘计数和源码 hash；本轮未跑全量单测、pack 检查或真实宿主验收，它们不验证本次纯新增研究材料的测量结论。
