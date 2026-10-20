# 经验召回读取：不再复制窗口之外的 knowledge 行，指标分支每行只规范化一次

本轮只动两处**可证明等价**的重复工作，没有新增持久化格式、没有新增跨事务缓存、
没有改任何对外语义（新增的是一个只读视图方法），也没有动事务、锁、CAS、journal、
tombstone、去重与顺序语义。原始逐轮样本见
[`recall-view.json`](recall-view.json)。

环境：Node `v26.12.0` / darwin-arm64，Apple M2，8 逻辑 CPU、16 GiB 内存。
基线是**测量时**的固定点 `release/dsh-evolution-0.2.0-rc.15.tgz` 中的 `lib/`（该 tarball 作为历史固定产物保留在 `release/`，当前固定点已是 rc.16），基准脚本直接
解包该固定产物后 import，不靠人工重写基线；两侧在同一进程内交替轮换、按侧取中位数，
并且每轮都断言两侧落盘的档案树字节相同（召回场景还断言两次召回的输出 JSON 逐字节
相同）。测量期间没有并行跑测试或其它基准。

## 1. 热点

### 1.1 召回把整段 knowledge 历史深拷贝，然后只用其中 2,000 行

`port.recall()` 在 `lib/domain-storage.js` 里先取知识历史，再由
`collectKnowledgeExperience()` 投影。改动前它走 `memory.history("knowledge")`，而
`history()` 的契约是"返回 detached 记录"，所以它把冷热合并视图的**每一行**都
`structuredClone` 一遍；而收集器的 `maxConsidered` 是 2,000 行，窗口之外的行只被用来
判断 `knowledgeKey` 是否精确命中（`scanned` 计数需要完整长度，精确命中也必须在窗口
之外可见）。

隔离测量（同一台机器，同一份 knowledge 档案，读缓存已热；脚本
`scripts/benchmarks/knowledge-history-read-cost.mjs`，原始输出见
[`recall-view.json`](recall-view.json) 的 `readCostProbe`）：

| 档案行数 | `history("knowledge")` | `historyWindow("knowledge", 50)` | 纯 JSON 往返（量级参考） |
| --- | --- | --- | --- |
| 10,000（17.5 MiB） | 83.5 ms | 2.00 ms | 63.3 ms |
| 40,000（70.5 MiB） | 366.1 ms | 8.88 ms | 267.8 ms |

`historyWindow()` 的 limit 被实现限幅在 50 行，所以第二列是"同一次合并 + 50 行副本"。
两列之差主要是行副本：同一份档案下复制 10,000 行约需 63 ms（上表最后一列，仅作量级
参考，不是对 `structuredClone` 的分解）。而收集器的 `maxConsidered` 是 2,000 行，
10,000 行档案里窗口外的 8,000 行（80%）中只有精确命中 `knowledgeKey` 的几行会被投影
（`scanned` 计数需要完整长度，精确命中也必须在窗口之外可见），其余行的字段从未被投影。
收集器本身（投影 + 匹配）在 10,000 行时约 15 ms，与既有记录一致。

改动：`lib/dockyard-domain/memory.js` 增加 `historyView(collection)` —— 与 `history()`
同一个 `#mergeArchived(..., { copy: false })` 合并，返回同样的行、同样的顺序、同样的
latest-value 与 tombstone 结果，只是不复制行（返回的数组本身是本次调用自己的，避免
调用方 `push`/重排时改到 store 的数组）。注释明确写出契约：数组元素是热记录与
`archiveReadCache` 里的冷记录本身，调用方只能读、不能保留、不能修改。`history()` 仍是
detached 契约；`lib/domain-storage.js` 的 `recall` 改用它。

安全边界的依据：`knowledgeExperienceRecord()` 只读输入行，并把每个它保留的字段投影成
新对象；`match()` / `scoredCandidate()` / `finalizeExperienceRecall()` 同样只读输入并重建
副本。因此"调用方拿到的是收集器自己的有界记录"这一点由
`test/experience-recall.test.mjs` 的
`recall: a mutated answer cannot write back into the stored knowledge rows` 断言：
把召回结果深度改坏之后，下一次召回与 `port.query("knowledge")` 都必须是原值。

### 1.2 `#shouldRetainSource()` 的指标分支对同一行重复规范化

`#append()` 的每个 knowledge-bearing 写入都会进入该分支。它按"指标 × 匹配行"遍历，
每个被求值的 (指标, 行) 组合都调用一次 `normalizeKnowledgeEvent(entry, …)`，只为读
`.metrics[key]`；而 `.metrics` 与调用时的 `now` 无关（`now` 只影响 `occurredAt`）。
按代码形状，8 个指标的写入会为同一行重复做完整规范化。

改动：把规范化提到一个本次调用内有效的 `Map` 上，每个匹配行只规范化一次；比较的
表达式、短路顺序、`undefined`/`null` 先验与 5% 判定完全不变。

**时钟读取次数必须保持不变。** 第一次实现把 `timestamp(this.clock)` 也一起缓存了，
复核时用递增时钟复现出持久化差异：同一轮写入里后续记录的 `recordedAt` 因为少读一次
时钟而提前了一个 tick（`00:00:08` → `00:00:07`）。因此最终实现仍在**每次求值时**读
一次时钟，只复用规范化结果。`test/dockyard-domain/knowledge-identity-equivalence.test.js`
新增的 `the metric branch keeps the pinned clock read count and bytes` 以
`rc.15` 固定产物为基线、用每次读取都递增的时钟，断言持久化字节**与时钟读取次数**都
相同；把时钟读回去掉（即上述被否的写法）该测试立即失败（实测 14 ≠ 17）。

需要更正一个此前的估算：这一分支**并不是**最坏的 K×M 次。`.every()` 会在第一个
"非实质变化"的匹配行处停下，所以每个指标最多走到第一个不变化的行。本次改动把
"每指标每行一次规范化"变成"每行一次"，常见形态（M=1、8 个指标）是 8 次 → 1 次。

实测（小档案、重复的 measured 观测，8 个指标，保留时钟读取后的最终代码）：
0.500 → 0.447 ms，三轮重复的中位数 −10.6% wall（区间 −16.0%…−9.9%）、CPU −11.1%。

## 2. 数据

### 2.1 召回（`--op recall`，窗口查询 + 精确命中查询各一次）

命令：

```sh
node scripts/benchmarks/observe-cold-archive.mjs --op recall --rows 0 \
  --knowledge-rows <N> --hot-rows <H> --rounds 3 --samples 5 --json
```

| 冷 knowledge 行 | 热行 | 改动前 wall | 改动后 wall | wall | CPU |
| --- | --- | --- | --- | --- | --- |
| 2,000 | 0 | 60.96 ms | 27.48 ms | −54.92% | −56.31% |
| 2,000 | 1,000 | 79.03 ms | 28.71 ms | −63.67% | −63.84% |
| 10,000 | 0 | 203.88 ms | 29.97 ms | −85.30% | −87.35% |
| 10,000 | 200 | 209.28 ms | 29.69 ms | −85.81% | −87.87% |
| 10,000 | 1,000 | 221.66 ms | 30.11 ms | −86.42% | −88.63% |
| 40,000 | 0 | 723.92 ms | 41.70 ms | −94.24% | −94.72% |
| 40,000 | 200 | 724.77 ms | 40.53 ms | −94.41% | −95.38% |

收益边界：省掉的是"窗口之外的行被复制"这一部分，因此收益随 `总行数 / 2,000` 增长。
2,000 行（正好等于 `maxConsidered`）时仍有 −55%，因为窗口内的 2,000 行也被复制了一次，
而现在只复制收集器真正保留的记录。改动后剩余成本是每次召回一次 O(总行数) 的合并
（40,000 行约 7 ms）加窗口投影，**冷档案首次解析、合并和 latest-wins 仍完整保留**。

### 2.2 指标分支（`experience-recall-archive.mjs`，`--rows 1000 --rounds 5 --samples 9`）

三轮重复的中位数（每轮两侧交替）：

| 场景 | 改动前 | 改动后 | wall | CPU |
| --- | --- | --- | --- | --- |
| 重复 measured 观测写入（指标分支） | 0.500 ms | 0.447 ms | **−10.61%** | −11.13% |
| 冷 knowledge 档案上的写入 | 0.561 ms | 0.528 ms | −5.75% | +3.11% |
| 冷 source 档案（1,000 行）上的写入 | 4.133 ms | 4.107 ms | −0.57% | −1.72% |
| 召回控制（memory 层 `history()` 直读） | 13.144 ms | 13.074 ms | −0.49% | −0.11% |

第一行是改动目标的场景，三轮的 wall 差异为 −16.0% / −9.9% / −10.6%。其余三行是
"不该变化"的场景：wall 与 CPU 的中位数在 ±6% 内且方向不一致（例如冷 knowledge 场景
wall −5.75% 但 CPU +3.11%），属于运行间漂移，不作为收益。10,000 行冷 source 档案时该
分支的占比降到 1% 量级，被 O(R) 的身份扫描淹没，这与 1.2 的分析一致。

## 3. 等价性验证

- `observe-cold-archive.mjs` 在每一轮对每一侧都断言 `dockyard` 目录树逐字节相同；
  `--op recall` 另外断言 `port.recall()` 的输出 JSON（记录、顺序、`coverage`/`exact`/
  `score`、`considered`/`scanned`/`duplicates`/`dropped`）与基线逐字节相同，并断言
  档案头部那条"窗口之外的精确命中"仍然被召回（`exact === true`）。
- `experience-recall-archive.mjs` 在每一轮断言 `state.json` 与档案字节两侧相同，包括
  指标分支场景。
- `test/dockyard-domain/evolution-archive-index.test.js` 新增
  `history view is history()'s merge without its copies, and history() stays detached`：
  视图与 `history()` 的合并结果（含 latest-value 覆盖与 tombstone）逐字段相同、
  `history()` 每条仍是副本、而视图两次调用返回同一批行对象（证明行未被复制）。
- `test/experience-recall.test.mjs` 新增 1.1 所述的回写隔离断言。
- `test/dockyard-domain/knowledge-identity-equivalence.test.js` 新增 1.2 所述的时间戳/
  字节差分（基线 `rc.15`，递增时钟，断言时钟读取次数与持久化字节）。
- 两个把 `memory.js` / `domain-storage.js` 锚定到固定产物的差分测试
  （`housekeeping-equivalence`、`domain-storage-write-path-equivalence`）按既有约定
  增加了本轮改动的"反向片段"，因此仍然逐字节重建出固定产物里的旧实现，并继续跑
  新旧实现的 before/after 等价性。

## 4. 撤回项（测得收益不足或缺乏可摊销证据）

1. **给 `#sourceMatches()` 加持久 knowledge-key 索引。** 单次写入仍要处理"存储键可能
   过期"的重算语义，且 `domain-storage` 每次 mutation 都新建一个 `EvolutionMemory`，
   实例级缓存无法跨事务摊销；跨实例缓存需要新的失效协议。本轮的冷 source 档案写入仍
   是 38.7 ms / 10,000 行（≈3.9 µs/行），改进它属于另一类工作，不在本轮做。
2. **去掉 `#append()` / `#upsertKnowledgeUnlocked()` 对入参的第二次
   `normalizeKnowledgeEvent()`。** 本轮没有为它建立可复现的独立测量：移除它的收益没
   有与 2.2 里同一配置的运行间漂移区分开，且该调用同时消费一次时钟，把它合并会改变
   注入时钟的读取次数（与 1.2 被否的写法同类）。因为缺乏收益证据而撤回，而不是因为
   已测得无收益；不保留改动。
3. **让指标分支也缓存时钟读取**（把 `timestamp(this.clock)` 提出求值）：用同一套 A/B
   复测可把该场景从 −10.6% 推到 −16.9%，但它改变了递增时钟下的持久化 `recordedAt`，
   属于行为改动。已撤回，并固化为第 3 节的正向回归测试。

4. **把召回窗口/精确命中判定搬进 memory 层。** 会让 memory 认识 `maxConsidered` 与
   recall 的查询形状，属于分层泄漏；收益与 1.1 重叠。

## 5. 复现材料

两个隔离探针已固化为一个可运行脚本（只读真实实现，不模拟）：

```sh
node scripts/benchmarks/knowledge-history-read-cost.mjs --rows 10000 --samples 5 --json
```

它报告：(a) 同一份热缓存档案上 `history("knowledge")`（合并 + 每行复制）、
`historyWindow("knowledge", 50)`（同一次合并 + 50 行，实现把 limit 限幅在 50）与纯
JSON 往返的耗时；(b) 冷 observations 档案里 6 行同身份 8 指标的 measured 记录之下，
一次**带指标**与一次**不带指标**的 measured 观测写入之差。后者覆盖了指标触发的全部
工作（规范化、knowledge accumulator 的指标归并、额外的持久化字节），因此它是
"指标相关总成本"的**上界**，不是对指标分支单独的归因；分支本身的收益证据是第 2.2 节
同输入 A/B 的 −10.6%。

原始逐样本数据（含两侧每轮样本）见 [`recall-view.json`](recall-view.json)。

## 6. 剩余风险

- `historyView()` 是一个会暴露内部行的只读接口。它目前只有一个调用点，并且有针对性
  的回写隔离测试；但将来若有人把它用在会写回记录的路径上，就会破坏 store。方法注释、
  `PORTS.md` 与测试都写明了这条边界。
- 召回仍是 O(总行数) 的一次合并；`maxConsidered` 之外的精确命中必须完整扫描，这是
  现有语义，不是本轮能安全消除的成本。
- 指标分支的收益随匹配行数 M 增长，M 受 `sourceRetentionLimit()` 限制（observations
  failure 为 3），所以它的绝对收益是亚毫秒级：它是"删除重复计算"，不是数量级变化。
