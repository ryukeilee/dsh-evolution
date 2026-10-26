# 无 checkpoint 首次历史吸收：实测归因与候选设计

## 结论

核心假设**部分成立，且在热标记窗口填满前有直接的二次项证据**：每条 measurement 事件触发两次 `assertTransactionSave()`；每次都把整个 `{ evolution: ... }` payload 送进 `JSON.stringify`，随后再对同一文本做 `"__proto__"` 子串扫描。12,000 条冷启动中，24,000 次断言实际 stringify 了 **15,210,789,991 UTF-8 字节**。临时相位探针测得 stringify 本身占 open 墙钟的 **53.2%**；包含子串扫描的整个 `assertTransactionSave()` 占 **73.1%**。

这不是整个 2k–20k 区间都服从同一个 `N²` 曲线。断言字节在 2k→4k 增长 3.72 倍；到 4k→8k 降为 2.97 倍，8k→12k 为 1.66 倍。代码中的 `eventBridge.applied` 在 4,096 个标记后截断，正好解释了主要累积尺寸为何先快增、后趋向按记录数增长。20k 点仍有每记录 payload 字节增加，来源未隔离，不能归给这个 4,096 窗口。

另有可见成本：12k 时 `#archiveEntries` 累计 7.20 秒（CPU 7.76 秒，11,950 次调用），约占 open 墙钟 22.6%；它在 2k 时是 1.07 秒 / 1,950 次调用。此组数据不足以证明它是二次项。日志读取、逐行 JSON parse、HMAC 验签和 event 投影远小于以上两项。

此前容量报告给出的 73,525 条 / 298.05 秒是历史测量，本轮没有重跑。若把此前对 12k 的 stringify 占比 50%–60% 折算到 298.05 秒，约为 **149.0–178.8 秒**；这是跨夹具外推，不是 73,525 条的本轮测量。按本轮相似工作负载的 53.2% 点估算是 158.5 秒，同样只是估算。[历史容量报告 §6](capacity-20261026.md#容量边界)

原始样本、相位探针、逐调用点 census 与拟合数据见同目录的 [first-startup-absorption-attribution.json](first-startup-absorption-attribution.json)。

## 测量口径

- 环境：Node `v26.12.1`、darwin/arm64；父子进程均带 `--max-old-space-size=4096`。没有读正式 `DSH_HOME`、正式密钥或迁移目录。
- 基线 worktree 是 `/tmp/dsh-base-abs`，由 HEAD `b13fe4cd797ff4f3d9be289b09e20e00469180ea` 创建，`node_modules` 链到工作树。比较树 source SHA-256 相同：`d8accf9f…2884751`；因此本次 A/B 是同代码噪声观察，没有候选生产改动。
- 主测量每个样本用全新 Node 子进程、全新临时 home，经过真实 `openDomainStorage()`、官方 `DomainFacility` 与 `JsonStorageBackend`。事件由 `EvolutionEventBridge.project()` 生成，并用独立随机 key 签成真实 envelope。冷夹具明确没有 `event-log.checkpoint.json`。每次 open 后确认全部 N 个 marker 已提交，再 flush 一次确认 `applied: 0, duplicates: N`。
- 主测量为 2 轮、每侧每轮 1 个样本；每轮交换 A/B 先后顺序。下表的 A/B 墙钟与 CPU 是两样本**算术平均**，raw JSON 保留每个独立样本。A、B 的源码哈希相同，差值不能解释成代码效果。
- `process.resourceUsage().maxRSS` 是**整个子进程生命周期**的高水位，包含导入和 backend 初始化，不是 open 阶段的独立分配量。
- `JSON.stringify` wrapper 在计时主路径上识别 payload 形状并用 `Buffer.byteLength` 统计输出 UTF-8 字节；这会增加测量开销。`payloadStringifyWallMs` 的计时只包原生 `JSON.stringify` 调用，不含形状检查或字节计数；open 的总 wall/CPU 则包含 wrapper 开销。相位时间来自临时拷贝中的探针包装；它们适合归因，不应当成无探针绝对延迟。内层相位互相包含，不能简单相加。
- 所有合成 JSON 内容是 ASCII；逐调用 census 仍以 `Buffer.byteLength(..., 'utf8')` 取实际 UTF-8 字节。相位表里没有字节流的纯对象操作明确写为“内存对象”，不把对象数换算成字节。

## 端到端样本

主 run ID 为 `e8067a12-afdb-4af9-94b8-2398eb783292`，基准脚本 SHA-256 为 `734f041f60215303c14950292fe16b823b1c53138353afbd23ad6b488db15561`。每个 worker 的 `maxRSS` 单位为 KiB。

| 记录数 | event log 字节 | A wall / CPU ms | B wall / CPU ms | 各侧 stringify 调用 / payload-shaped 调用 | payload-shaped 输出字节 | A/B 源码哈希 |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2,000 | 3,658,871 | 2,603 / 2,687 | 2,596 / 2,671 | 121,971 / 4,002 | 828,068,909 | 相同 |
| 4,000 | 7,319,971 | 7,491 / 7,663 | 7,692 / 7,875 | 243,971 / 8,002 | 3,081,524,909 | 相同 |
| 8,000 | 14,642,195 | 19,842 / 20,297 | 19,654 / 20,112 | 487,971 / 16,002 | 9,146,110,637 | 相同 |
| 12,000 | 21,968,420 | 33,123 / 33,652 | 32,728 / 33,483 | 731,971 / 24,002 | 15,212,306,541 | 相同 |
| 20,000 | 36,628,868 | 56,137 / 57,598 | 56,824 / 58,447 | 1,219,971 / 40,002 | 27,346,856,111 | 相同 |

20k 是额外单轮点；其 A/B 仍是同源码，墙钟差 1.2%、CPU 差 1.5%，只能作规模观察。20k 的 payload-shaped 字节 / 记录约 1.367 MB，12k 约 1.268 MB，增加约 7.8%。未对 20k 运行完整逐调用栈 census，因此这两个 payload-shaped 固定投影调用的字节不从 20k 总数中扣除。

同码 A/A 控制是另一个 2k run、2 轮：

| 轮次 / 顺序 | A wall / CPU ms | B wall / CPU ms | B−A wall 差 |
| --- | ---: | ---: | ---: |
| 1，A→B | 2,624.455 / 2,708.275 | 2,631.358 / 2,710.560 | +6.903 ms（+0.26%） |
| 2，B→A | 2,626.190 / 2,708.270 | 2,617.687 / 2,699.905 | −8.503 ms（−0.32%） |

主 A/B 样本的 12k 每侧单样本跨轮约为 32.1–34.0 秒；这说明单样本噪声会明显大于 A/A 2k 的偏差，不能用 A/B 小幅快慢作结论。A/A 控制只覆盖 2k，不能作为 12k/20k 的噪声上界。

## 阶段归因

相位表的 wall / CPU 均为 ms。2k 与 12k 相位数据来自临时探针拷贝，分别总计 2,630.8 / 2,717.8 ms 与 31,856.1 / 32,666.0 ms。读、split、parse 的“字节”是 event log 本身或逐行文本；verify / project 处理已 parse 对象，因此列出其对应的原始行字节总量，不能理解成函数重新读取了该字节流。

| 阶段（调用数） | 2k：wall / CPU；字节 | 12k：wall / CPU；字节 |
| --- | ---: | ---: |
| 日志 read（1） | 0.385 / 0.386；3,658,871 B | 2.398 / 2.399；21,968,420 B |
| `String.split('\n')`（1） | 0.193 / 0.277；3,658,871 chars | 0.766 / 0.767；21,968,420 chars |
| 每条 `JSON.parse`（2k / 12k） | 8.468 / 9.069；3,656,871 chars | 48.197 / 51.611；21,956,420 chars |
| `verifyEventBridgeEnvelope` | 36.278 / 49.384；2,000 行，3,656,871 B | 162.964 / 187.905；12,000 行，21,956,420 B |
| `projectExecutionEvent` | 5.150 / 5.882；2,000 个对象 | 21.315 / 22.946；12,000 个对象 |
| `#performHousekeeping`（4k / 24k） | 3.594 / 3.880；内存对象 | 33.512 / 33.845；内存对象 |
| `{ ...state, evolution: payload }` spread（4k / 24k） | 2.002 / 2.070；内存对象 | 11.438 / 11.574；内存对象 |
| `assertTransactionSave`（4k / 24k） | 1,331.230 / 1,349.538；精确断言序列化见下节 | 23,297.548 / 23,520.494；精确断言序列化见下节 |
| 其中 payload-shaped `JSON.stringify` wrapper 计时 | 979.646 / 992.555；总 payload-shaped 输出 828,068,909 B | 16,948.679 / 17,131.960；总 payload-shaped 输出 15,212,306,541 B |
| `#archiveEntries`（1,950 / 11,950） | 1,071.651 / 1,142.380；另见逐调用点输出字节 | 7,203.921 / 7,764.050；另见逐调用点输出字节 |
| `instance.snapshot()`（1） | 1.011 / 1.011；内存对象 | 2.000 / 2.001；内存对象 |
| `mirrorArchives`（1） | 0.226 / 0.225；夹具起始 archive 树为空 | 0.227 / 0.227；夹具起始 archive 树为空 |
| `changedArchiveFiles`（1） | 0.826 / 0.826；返回文件字节没有被探针保留 | 3.825 / 3.825；返回文件字节没有被探针保留 |
| `writeStageManifest`（1） | 0.248 / 0.248；JSON 文本 301 B | 0.376 / 0.375；JSON 文本 301 B |
| `syncStage`（1） | 10.475 / 0.250；fsync 字节数未单独捕获 | 9.028 / 0.220；fsync 字节数未单独捕获 |
| 两次 `domain.global.set` | 19.934 / 5.427；backend serializer 输出合计 1,704,329 B | 28.527 / 14.841；backend serializer 输出合计 5,452,939 B |

`#save` 总计 4,000 / 24,000 次，wall / CPU 为 1,346.342 / 1,364.932 ms 与 23,417.938 / 23,643.081 ms；其中包含 housekeeping、spread 与 assert。`#append`、`#markBridgeApplied`、`#save`、`assertTransactionSave` 是嵌套的 inclusive 相位，勿把其行相加。`#archiveEntries` 在 append 的 save 之前运行，其累计时间是另一段工作；归档单行与索引 JSON 的累计序列化字节不等于最后落盘文件大小，索引文件会被反复覆写。

## payload 字节的二次项证据

`payloadStringifyUtf8Bytes` 按参数形状匹配整个 `{ evolution: { schema >= 4 } }`；它包含两个 `toJsonProjection` 调用。逐调用栈 census 将其从 `assertTransactionSave` 精确分离后，断言本身的数据如下：

| N | `assertTransactionSave` 调用 | 断言 `JSON.stringify` 输入输出字节 | 每记录平均字节 | 比上一点 |
| ---: | ---: | ---: | ---: | ---: |
| 2,000 | 4,000 | 827,298,537 B | 413,649 B | — |
| 4,000 | 8,000 | 3,080,042,537 B | 770,011 B | 3.723× |
| 8,000 | 16,000 | 9,144,594,089 B | 1,143,074 B | 2.969× |
| 12,000 | 24,000 | 15,210,789,991 B | 1,267,566 B | 1.663× |

因此 2k→4k 近似翻倍记录、近四倍序列化字节，是本次最清晰的二次区间证据。区间往后偏离纯二次，与 `#markBridgeApplied()` 将 `eventBridge.applied` 截到最近 4,096 条相符：事件数先使每次 save 的聚合体变大，窗口填满后这一部分趋于固定，仍有其他状态使 12k→20k 的每记录字节轻微上升。

最小二乘的描述性拟合（B 为精确断言字节、N 为记录数）如下：

- `a + bN`：R² = 0.998026。
- `a + cN²`：R² = 0.975296。
- `a + bN + cN²`：`B = -1.76165e9 + 1.19456e6 N + 18.64358 N²`，R² = 0.999222。

全区间线性模型本身也有高 R²，全区间二次拟合不能证明纯 `N²`。结合调用点可得更准确的结论：**每次检查的 payload 大小随未封顶的 marker 窗口增长，保存次数又与事件数成正比；主要项在窗口填满前为二次，封顶后转为近似线性，并叠加 archive 与其他状态。**

## JSON.stringify 调用点

全局 wrapper 在 2k / 12k 分别量到 121,971 / 731,971 次，即 60.986 / 60.998 次/记录；未复现此前报告的约 95 次/记录。census 捕获的每条 event 主要调用点如下：

| 调用点 | 2k 调用 / 输出字节 | 12k 调用 / 输出字节 | 规模性质 |
| --- | ---: | ---: | --- |
| `canonicalBridgeJson`，`lib/orchestrator.js:73` | 114,000 / 1,472,871 B | 684,000 / 8,852,420 B | 固定 57 次/事件；验签规范化，O(N) 次调用 |
| `assertTransactionSave`，`lib/domain-storage.js:1015` | 4,000 / 827,298,537 B | 24,000 / 15,210,789,991 B | 两次/measurement；每次输入整份增长中的 aggregate，是主要二次项 |
| `boundedArchiveEntry`，`lib/dockyard-domain/memory.js:704` | 1,950 / 1,092,000 B | 11,950 / 6,692,000 B | 热窗外逐归档记录一次；调用数 O(N)，输出小 |
| `#writeArchiveIndexDocument`，`memory.js:1532` | 1,950 / 1,156,058 B | 11,950 / 7,109,960 B | 热窗外每条记录一次；调用数 O(N)，索引重复覆写 |

其余达到的调用点是低频/固定开销：Zod `esc` 15 次 / 133 B；`toJsonProjection` 7 次 / 770,382 B（12k 为 1,516,560 B，其中两个 payload-shaped 调用）；`bridgeJsonKey` 41 次 / 488 B；`writeStageManifest` 1 次 / 301 B；官方 JSON backend `serialize` 2 次 / 1,704,329 B（12k 为 5,452,939 B）；memory `comparable` 2 次 / 1,040 B（12k 为 1,044 B）；`digestApplied` 1 次 / 242,001 B（12k 为 1,452,001 B）；`checkpointMac` 1 次 / 567 B；`writeEventLogCheckpoint` 1 次 / 640 B。总数与 wrapper 的 121,971 / 731,971 完全相符。

## 候选设计与语义风险

### A. 把整份 representability 检查延迟到最终发布前

**精确改动形状：** `createMemory()` 的 `stateStore.update()` 不再对每次 `#save()` 调用 `assertTransactionSave(next)`；批处理结束、取出最终 `instance.snapshot()` 后，对将发布的 final aggregate 做一次检查。应在 `assertLiveTreeUnchanged`、`changedArchiveFiles`、manifest/fsync 与 commit token 推进之前尽早执行；若复用 `schema.parse()`，必须先构造并 parse 将发布的文档，再推进 token 并 set。

`mutate()` 有两种正常提交形状：无 archive 文件变化时，对 `{aggregate, applied, pending:null}` 调用一次 `domain.global.set(schema.parse(...))`；有 staged 文件变化时，先 set 带 `pending:{stage, aggregate, applied, files}` 的文档，再由 `installPending()` 安装 archive 文件并 set 关闭 pending 的文档。`mutate()` 入口还会先 `installPending()`，这可能恢复并发布前一次已提交的 pending 记录；它没有新的 memory save。启动时另有显式 `domainSeed` 发布路径，也不属于本次批次。正常 12k 样本的两次 set 对应 pending 写入和关闭。

**不能声称每个失败时机完全等价。** 目前 save 检查在对应的 `applyExecutionEvent()` 内立刻失败。延迟后，后续事件、archive staging 与 housekeeping 都会先运行；后续其他错误可能抢先出现。直接把每次断言删掉、保留 `inlineSerialization:true` 也不符合 [PORTS.md](../../lib/dockyard-domain/PORTS.md)：这个标记要求 transaction 同步捕获本次 payload 字节。可行原型必须把 replay 的 memory save 改成明确的事务内 batch/deferred-save API，只在 final flush 用 `inlineSerialization:true` 做一次最终 capture/校验；不能让未捕获的 live 浅视图继续冒充 inline serialization。

**有具体的 transient-failure 差异。** 已测得 4,000 层、末尾带字符串值 `"__proto__"` 的 payload 会在当前 `assertTransactionSave()` 中触发 `RangeError: Maximum call stack size exceeded`；同样深度但不含该字面量的 JSON stringify 成功。代码允许 `experimentId="__proto__"` 通过 `safeIdentifier`，它是字段值，不是动态对象键。若已加载的 evolution aggregate 含一个 schema 可接受、深约 4,000 层且不含该字面量的热 experiment row，批次先吸收这个 experiment ID，再吸收超过 4,096 条 marker 的后续事件：当前逐次断言会在该次 save 发现字面量并递归到深对象而失败；若后续记录把旧 row 推入 cold archive、marker 窗口也将首条移出，final aggregate 不再含深 row 或该字面量，单次 final 检查可能成功。这是依据已读代码与局部探针构造的**代码路径反例推论**，未运行端到端候选批次；它意味着延迟方案明确改变接受/拒绝结果，不能称为严格语义等价。

失败残件也需固定：当前 stage 在 `work()` 前创建；save 失败从 `mutate()` 抛出时，不会推进 commit token、写 pending global、写 stage manifest 或清理 stage。open 的 catch 关闭 domain 并释放锁，但 stage 目录作为 orphan 留下。延迟验证到 batch 尾会让失败前 stage 内已写入更多 archive 数据；应仍在 token/publication 前拒绝，并为残余现场、下次重放与 doctor 分类增加失败路径覆盖。

**当前 pin：** [transaction-save-validation.test.js](../../test/domain-storage/transaction-save-validation.test.js) 中 `a save still throws exactly where the whole-document projection threw`、`the only divergence is a verdict the port cannot hand this store` 与 `each save still stringifies its payload once, which is what the store checks`。延迟会直接改变第三项及第一项的时机；不能静默改测试期望。提交形状还受 [transaction-commit-shape.test.js](../../test/domain-storage/transaction-commit-shape.test.js) 的 pending/no-stage 与失败路径测试约束。

**复杂度/风险：** 若 batch API 保留原有中间 housekeeping、最终只做 O(N) capture，重复检查由“窗口填满前 O(N²)、之后 O(N)”变成一次 O(N)；收益上限参考本次 12k 的 23.30 秒断言 wall，不是已测候选速度。风险是上述失败时机/接受集合改变、`inlineSerialization` 合同、orphan stage 增大、错误优先级变化及未覆盖调用路径。

### B. 只增量验证新加入的数据

这类候选要靠一个强假设：前次检查成功的旧值此后深不可变、不会被 getter/`toJSON`/proxy 改变，且每次变更的 dirty paths 完整覆盖 append、merge、housekeeping、retention 与归档边界。当前 payload 是 `{...this.#data}` 的浅视图；数组和记录对象会被原地修改，housekeeping 会改行/删行，`#append` 会合并旧记录。没有可证明的 immutable prefix 或完整 dirty-path 协议。

此外不要复试已撤回的 identity/entry-parse skip：[domain-hotpath-20261024.md §1](domain-hotpath-20261024.md) 已用同进程 live domain holder 原地篡改复现候选发散；`domain-hotpath-20261024-entry-validation.test.js` 固化拒绝边界。该旧反例不等同于本候选的每种形式，但足以否定“对象身份未变就能跳过全量检查”的前提。

若能严格证明只新增不可变 JSON 值并覆盖所有可修改旧行，理想复杂度是 O(N)；当前代码不能满足该前提。风险是隐藏旧值变坏、清洗变化不入 dirty set、accessor 读取时序变化以及写出无法代表的 final aggregate。当前不推荐。

### C. replay 内减少 `#save()` 次数

replay 已经把一批 events 包在一个外层 `mutate()` / 一次 domain commit 内，但 `applyExecutionEvent()` 仍在业务 record `#append()` 后 save 一次，`#markBridgeApplied()` 再 save 一次。候选可只对 replay batch 增加 deferred save：保留两个原位置的 `#performHousekeeping()` 调用和每个 event 的 marker 修改，避免每条中间 store update；batch 结束做一次 inline final flush。非 replay 的 `observe()` / 普通 mutation 仍保留现有路径。

housekeeping **本身会改状态**，且在后续事件前发生；只把所有 housekeeping 移到最后会改变后续事件看见的集合与最终 snapshot。marker 的 4,096 窗口则由 `#markBridgeApplied()` 每事件 push + slice 控制，与 `#save()` 次数无关；保持每事件调用 marker method，窗口结果不变。

当前 pin 包括 replay 的 `a burst of records is committed by one transaction, in file order`、`a failure inside the group transaction publishes nothing and the retry applies each record once`、`a group longer than the bridge marker window is not re-applied by a same-port retry`、`the state a burst commits matches one record per transaction`（[replay-batch-commit.test.js](../../test/domain-storage/replay-batch-commit.test.js)），以及上文的每 save stringify 测试。候选保留 housekeeping 但减少 store capture，因此异常抛出点变化，必须改为对 final state、marker、archive 与失败重放的差分 pin。

**复杂度/风险：** 若只在 replay batch 做一次 inline flush/检查，可把重复整份序列化降为一次 O(N)，其它每事件验签与 archive 写入不变。风险是 `#save()` 的异常时机、replay batch 与单条 mutation 的调用边界、内存 store 在 batch 中是否有隐式读者，以及 inline capture 的新合同。无 batch API 前，不应只删除调用或把 `#performHousekeeping()` 一并删掉。

## 推荐候选与通过门槛

推荐只制作一个**replay 专用的 batch-save 原型**（C + A 的受控组合）：每个 event 继续按原位执行 housekeeping 与 `#markBridgeApplied()`；中间 memory store 更新不宣称已经 inline-serialize；batch 末尾构造 final snapshot，在 commit token 之前进行一次同步 capture/representability 检查，再走现有 staged/no-stage 发布协议。若无法接受“中间无效状态最终被清洗后可通过”的接受集合变化，就应拒绝候选、保持当前行为，不能用增量/identity cache 绕过。

评估时需与当前基线同夹具、按轮交替 A/B，并带同码 A/A：2k、4k、8k、12k、20k；至少 3 轮 × 2 样本。每个样本断言 applied N、重放后 duplicates N，并对比 aggregate、applied ledger、archive 文件与 index 的字节/摘要，以及成功事务后的 stage 清理。正确性 gate 需增加：

1. transient `__proto__` + 深旧 row + 超过 4,096 marker 的反例，明确决定接受变化是否允许；
2. work 中第二条记录失败、archive 写入失败、`schema.parse` 失败时，domain 文档不变、token 不误进、checkpoint 不前进，stage 残件形状明确；
3. no-stage 一次 set 与 staged pending → installPending 两次 set 的恢复/重启差分；
4. housekeeping 在每次原 save 位置运行后，final snapshot、热窗/cold 行、marker 窗口与原来逐条保存完全相同。

性能 gate 直接检查断言调用从 2N 降到 1 次/批次，final capture 字节是 O(N)，并报告完整 open wall/CPU/RSS；主测量必须保留 `--max-old-space-size=4096`。12k 本次重复断言约 23.3 秒给出候选 headroom 的实测上限量级，archive 与其它 per-record 工作不会消失；是否保留必须由候选 A/B 和上述失败路径测试决定。本研究未实现生产修复，也未跑测试套件。

## 复现与包边界

基线 worktree 与依赖链接：

```sh
git worktree add /tmp/dsh-base-abs b13fe4cd797ff4f3d9be289b09e20e00469180ea
ln -s "$PWD/node_modules" /tmp/dsh-base-abs/node_modules
```

主 A/B 与同码控制的命令形状：

```sh
node --max-old-space-size=4096 scripts/benchmarks/first-startup-absorption-attribution.mjs \
  --a-root . --b-root /tmp/dsh-base-abs \
  --records 2000,4000,8000,12000 --rounds 2 --samples 1 --aa \
  --out /tmp/first-startup.json --ledger /tmp/first-startup.samples.jsonl
```

另跑 `--records 20000 --rounds 2` 可补充封顶后趋势；本轮 20k 只做 1 轮。所有 fixtures 使用 `os.tmpdir()`，脚本会拒绝其它 fixture 路径。JSONL 每样本追加后 fsync；header 锁定 source roots、Node、fixture identities、脚本 SHA 与设置，恢复时拒绝混合身份。

`package.json#files` 显式只包含 `scripts/doctor.mjs` 与 `scripts/import-evolution-data.mjs`，不包含 `scripts/benchmarks/`。本轮另执行 `npm pack --dry-run --json`，共 51 个分发文件，未出现任何 `scripts/benchmarks/` 路径；没有生成或发布 tarball。
