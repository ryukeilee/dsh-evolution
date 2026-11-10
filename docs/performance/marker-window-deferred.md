# 首次重放：staged 标记窗口原地增长，不再逐条重建冻结窗口

## 结果

基线 `main` 的 `20e2cf0`，候选是在它之上的改动：私有 staged replay 的桥接标记窗口
改为**一个可增长的原生数组原地追加**，每次 append 仍向端口报告它刚产生的准确长度与
尾元素，save 仍只判定新增 marker；窗口每 4,096 次 append 缩减一次，发布时由
`snapshot()` 归约为最后 4,096 条。逐条重建冻结后继（最多复制 4,095 个引用 + `Object.freeze`）
的工作被移除。

真实官方 `DomainFacility` / `JsonStorageBackend`，无 replay checkpoint 的首次吸收，
每样本独立子进程与临时数据根，交替 A/B 各三轮（中位数）：

| 记录数 | 墙钟 ms：基线 → 候选 | CPU ms：基线 → 候选 | GC ms：基线 → 候选 | 稳态 observe | 稳态 flush |
| ---: | --- | --- | --- | --- | --- |
| 12,000 | 847.0 → 625.7（**−26.12%**） | 954.2 → 717.5（**−24.81%**） | 9.8 → 9.5 | −0.24% | −0.25% |
| 20,000 | 1395.3 → 999.4（**−28.37%**） | 1544.5 → 1131.8（**−26.72%**） | 18.2 → 15.1 | +1.78% | +0.64% |
| 50,000 | 3367.9 → 2340.8（**−30.50%**） | 3659.1 → 2616.0（**−28.51%**） | 41.0 → 36.9 | +0.48% | +0.72% |

逐轮配对差（候选 − 基线）墙钟 −200.1 / −215.6 / −223.9 ms（12k）、
−388.3 / −484.1 / −393.9 ms（20k）、−1053.0 / −1031.9 / −1019.8 ms（50k）；
CPU 同向，−215.6…−258.5 ms、−406.7…−484.5 ms、−1043.0…−1071.5 ms。收益远超同码漂移。

同码 A/A 控制（两侧都跑候选树，同夹具、同参数、交替三轮）：

| 记录数 | 墙钟差（逐轮） | CPU 差（逐轮） | 最大绝对墙钟差 |
| ---: | --- | --- | ---: |
| 12,000 | −12.3 / +6.2 / +32.7 ms | +0.8 / −4.7 / +11.6 ms | 32.7 ms |
| 20,000 | +2.0 / +4.4 / +3.1 ms | −1.5 / −1.1 / +5.9 ms | 4.4 ms |
| 50,000 | −11.6 / −8.7 / +16.2 ms | −8.3 / −1.1 / +20.2 ms | 16.2 ms |

**不声称峰值内存收益。** 峰值 RSS 配对差在 A/B 中为 −38.1 / −0.1 / +0.1 MiB（12k）、
+27.2 / −15.9 / +18.0 MiB（20k）、−65.9 / −18.8 / −26.8 MiB（50k）；同码 A/A 的同项差
在 −19.7…+113.6 MiB 之间同样离散。两者都含夹具与吸收后的稳态操作，不是吸收阶段可达
对象的精确峰值。GC 时间与次数在三个规模上都下降（12k：9.8 → 9.5 ms、35 → 25 次；
20k：18.2 → 15.1 ms、55 → 36 次；50k：41.0 → 36.9 ms、139 → 90 次），但 GC 是吸收
窗口内的 `PerformanceObserver` 计数，不是分配流量归因。

**稳态路径不变。** 三个规模的 observe / flush 中位差为 −0.24% / −0.25%（12k）、
+1.78% / +0.64%（20k）、+0.48% / +0.72%（50k），最大绝对量不到 1 ms；同码 A/A 的对应
项为 0.00% / −0.13%、+0.73% / −0.24%、+0.77% / −0.11%。该模式只在 replay 的私有工作
副本开启，稳态写路径完全走原分支。

## 成本与改动

本轮之前的基线与归因（[`marker-window-deferred-cost-frozen-50k.json`](marker-window-deferred-cost-frozen-50k.json)，
插桩提取树，仅作分项归因，不作 A/B 证据）：50,000 条首次吸收 3,384 ms 中，
**窗口重建（复制 + 冻结）1,021.0 ms ≈ 30.2%**，逐条 save 检查 468.1 ms，GC 43.0 ms；
窗口复制在整轮吸收里累计复制 **196,363,440** 个数组引用。20,000 条对应
383.5 ms / 1,400.1 ms ≈ 27.4%，save 检查 187.2 ms。窗口冻结本身很便宜（3.0 ms /
50k），主要成本是每条记录重新分配并复制 4,096 项数组。

改动只在 `lib/dockyard-domain/memory.js` 与 `lib/domain-storage.js`：

1. **只有 replay 的私有 staged 工作副本**把 `transaction` 的
   `bridgeWindowChanged` 与新的 `deferBridgeWindowRebuild` 选项一起打开
   （`createMemory(..., elementSaveChecks: true)` 的 `mutate()` 路径）。普通 Memory、
   observe / reclaim / compact / hydrate 及直接构造的 `EvolutionMemory` 完全走原路径。
2. load 仍冻结窗口里的每个 marker；该副本把窗口换成自己的可增长原生数组，
   并报一次 seed。之后每次 append：`push(marker)`（O(1)），更新增量 id 索引，
   通过同一 hook 报告**这一次 append 产生的准确长度与尾元素**。
3. 窗口长度超过 8,192 时，用 `slice(-4096)` 缩减一次（每 4,096 次 append 一次）；
   `snapshot()` / `fullSnapshot()` 在发布前把窗口归约为最后 4,096 条（一次复制），
   键序、顺序与内容与逐条冻结后继完全相同。
4. `assertStagedTransactionSave()` 对 deferred 形态只信任**与报告值逐项相符**的证书：
   `window.length === 报告长度` 且 `window[length-1] === 报告尾元素`；不匹配就删除该证书、
   走原来的整份检查。前缀 marker 与新增 marker 分别由既有 WeakMap 判定一次；
   一次 save 失败不会把证书置为已验证。第一次 save 的窗口为空、或任何
   `bridgeWindowId` 无法索引的窗口，仍走原来的整份/逐 marker 检查。
5. 非标准窗口（loaded 数组不是原生 `Array.prototype`、带 own `toJSON`、稀疏、含
   非 marker 项）在第一次 append 前就退回原来形态；长于 4,096 的 loaded 窗口在第一次
   append 时把索引重建为最后 4,096 项，成员关系与逐条冻结后继一致。

保存时机、拒绝时机、异常行为、持久化字节、事务原子性与崩溃恢复未改：每次 record
仍触发同样的保存，measurement 的 marker 保存仍按 `coalesceMeasurementMarkerPersist`
合并，失败仍发生在 `transaction.persist` 的 `assertStagedTransactionSave()` 内。

## 等价性

证书的判定对象没有变，仍是文档的“可 JSON 表示”与“不含 own-`__proto__` 字面量”：

- 窗口中最老的条目只是被滚出逻辑窗口；仍在窗口里的条目要么在事务开始时被完整判定，
  要么在其 append 后的第一次 save 被判定。每次 save 只判定自上次成功 save 以来
  报告过的 marker；上报长度与尾元素是“自上次报告后没有别的变化”的可核对证据，
  对不上就不复用。
- 发布前归约只是把同一批 marker 按事件顺序取最后 4,096 条；未变更的 marker 对象与
  id 顺序使发布窗口与逐条冻结后继逐字节相同。
- 运行时的失败路径（`whole()`）看到的 payload 仍包含当前数组里的全部条目；
  marker 都是内部生成的冻结定形对象，前缀条目已判定为可表示且不含 own 字面量，
  因此回退时第一个抛错的值与错误不变。

`--validate`（冻结时钟与 UUID）在 12k / 20k / 50k 上逐字节核对：整棵归档树
（2 / 3 / 4 个文件）、领域文档摘要（`0496b014…` / `4a233c8…` / `5ac64f28…`）、
checkpoint 内容与 query 投影全部相同；marker 数等于记录数，staged 残留为 0。这些相等由脚本断言后写出摘要；JSON 记录的是断言通过
后的摘要，而非逐文件证据表。
数据见 [`marker-window-deferred-equivalence.json`](marker-window-deferred-equivalence.json)。

新增回归 [`test/domain-storage/staged-window-deferred.test.js`](../../test/domain-storage/staged-window-deferred.test.js)
（11 项）：

- 已验证窗口的原地 append 只判定新增 marker；长度或尾元素被未报告地改变时删除证书并
  退回整份检查；失败 save 不认证，后续 save 仍拒绝。
- 正文 BigInt / 循环 / `toJSON` / own-`__proto__` 字面量仍在证书之前决定；缩减后的
  新数组按身份重新报告，未报告的数组没有证书；非 deferred 的可变窗口保持原检查。
- 真实内存的 4,300 条 measurement 重放：发布窗口与逐条冻结路径逐值相同、最后
  4,096 条顺序相同、`stats().bridgeEventsApplied` 相同，窗口内 dedupe 命中、滚出后
  不再命中；8,200 条经一次缩减后仍是有序的 4,096 条，报告长度从不超过 8,193。
- loaded 的特殊窗口、长于 4,096 的窗口退回/重建后与逐条冻结路径结果相同。

既有差分继续通过：`staged-window-incremental.test.js`、`staged-save-check.test.js`
（43 类载荷）、`staged-save-elements.test.js`、`transaction-save-validation.test.js`、
`replay-batch-commit.test.js`（组提交、4096 窗口、拒绝前缀、崩溃恢复），以及两套历史
树重建（新增 [`staged-window-deferred-baseline.js`](../../test/domain-storage/staged-window-deferred-baseline.js)
把本轮精确反向回 `20e2cf0` 的固定 SHA-256，再交给旧基线链）。

## 测量方法

- 端到端 A/B/A/A：[`archive-append-window.mjs`](../../scripts/benchmarks/archive-append-window.mjs)。
  基线由 `git archive 20e2cf0 lib package.json package-lock.json` 解到临时树，
  `node_modules` 链接本仓库依赖；两侧各跑独立进程、独立夹具根，逐轮交替顺序。
  吸收阶段单独计时，稳态 observe / flush 各 12 个样本；本次给吸收窗口加了
  `PerformanceObserver({ entryTypes: ['gc'] })` 计数（两侧使用同一脚本，对称）。
- 分项成本：[`marker-window-write-cost.mjs`](../../scripts/benchmarks/marker-window-write-cost.mjs)
  把源码抽取到临时树并插入计时探针，再跑同一个 child 工作负载；它只用于说明成本
  去了哪里，插桩后的墙上时间不作为 A/B 证据。
- 原始数据：[A/B](marker-window-deferred.json)、[A/A](marker-window-deferred-aa.json)、
  [字节等价](marker-window-deferred-equivalence.json)、
  [分项 20k 冻结](marker-window-deferred-cost-frozen-20k.json) /
  [20k 候选](marker-window-deferred-cost-deferred-20k.json) /
  [50k 冻结](marker-window-deferred-cost-frozen-50k.json) /
  [50k 候选](marker-window-deferred-cost-deferred-50k.json)。
- A/B 记录里的 `candidateSha` 是测量时的 HEAD（`7dd9c6d`，最终树）；真实候选另由
  `candidateSources` 中 `lib/domain-storage.js` / `lib/dockyard-domain/memory.js` /
  `scripts/benchmarks/archive-append-window.mjs` 的 SHA-256 钉住。基线由
  `baselineSha` `20e2cf0` 与 `git archive` 解出的树确定。

环境：Node `v26.13.0` / `darwin/arm64` / 8 逻辑 CPU。测量期间机器为共享状态
  （load average 在 2–4 之间波动），A/A 与逐轮交替用于约束噪声；超过同码漂移的结论
  只来自 A/B 配对差。

复现（工作树包含候选；基线固定为 `20e2cf0`）：

```sh
node --max-old-space-size=4096 scripts/benchmarks/archive-append-window.mjs \
  --baseline-ref 20e2cf0 --records 12000,20000,50000 --rounds 3 \
  --out docs/performance/marker-window-deferred.json
node --max-old-space-size=4096 scripts/benchmarks/archive-append-window.mjs \
  --aa --records 12000,20000,50000 --rounds 3 \
  --out docs/performance/marker-window-deferred-aa.json
node --max-old-space-size=4096 scripts/benchmarks/archive-append-window.mjs \
  --baseline-ref 20e2cf0 --validate --records 12000,20000,50000 \
  --out docs/performance/marker-window-deferred-equivalence.json
node --max-old-space-size=4096 scripts/benchmarks/marker-window-write-cost.mjs \
  --ref 20e2cf0 --records 50000 --repetitions 3 \
  --out docs/performance/marker-window-deferred-cost-frozen-50k.json
node --max-old-space-size=4096 scripts/benchmarks/marker-window-write-cost.mjs \
  --working --records 50000 --repetitions 3 \
  --out docs/performance/marker-window-deferred-cost-deferred-50k.json
```

比例结论只适用于本机 Node 26 / darwin-arm64、热页缓存的合成 measurement 事件负载，
以及“同一 replay 事务内每条记录一次 save”的形状；积压只有 1 条、或由磁盘提交主导的路径收益更小。
2,000 条规模没有单独跑：窗口尚未填满，复制量本来就小，收益上限低于本报告的三个规模。

## 边界

- 该模式只对 `openDomainStorage()` 的 replay 私有工作副本开启；普通 `EvolutionMemory`、
  observe / reclaim / compact / hydrate、直接构造的 store 不进入此路径，窗口仍是原形态。
- 证书不声称数组不可变；它声称**这次 append 的长度与尾元素与报告一致**。不匹配的
  窗口一律整份检查，未报告的替换窗口没有证书。marker 仍是冻结的定形数据属性。
- 不改变 4,096 的窗口语义：首次 append 之后，发布窗口、`#bridgeApplied()` 的集合判定与
  `stats()` 都只看最后 4,096 条；内部数组在两次缩减之间最多保留 8,193 条。本事务没有
  append 时，loaded 窗口按原样发布与计数（与 released 路径一致）。
- 不改变正常 Memory 路径、官方 DSH、发布固定产物；未引入定时器、后台任务或跨进程协议。

## 交付记录

- 全量回归（提交后）：`NODE_OPTIONS=--max-old-space-size=4096 npm test` →
  1504 tests / 1502 pass / 0 fail / 2 skip（既有 skip）。
- `npm run pack:check`（开发语义）：17/17；工作树是固定点的已提交后继，`release/`
  未改动。
- 四个声明宿主的隔离真实安装验收（本树 `release:pack` 产物，content sha256
  `d839a484…`、tarball sha256 `1cfcbdb7…`），每个完整 21 步全部通过，最终 doctor
  均为 `degraded`（既有 5 项 degradedCapabilities，无 blocked）：
  [`0.2.0-rc.2`](../evidence/marker-window-deferred-dsh-0.2.0-rc.2.json)、
  [`0.2.1-alpha.1`](../evidence/marker-window-deferred-dsh-0.2.1-alpha.1.json)、
  [`0.2.1-rc.2`](../evidence/marker-window-deferred-dsh-0.2.1-rc.2.json)、
  [`0.2.2-rc.1`](../evidence/marker-window-deferred-dsh-0.2.2-rc.1.json)
  （最后一份带 `--no-hmr`，与 CI 的该宿主行一致）。
- 独立只读评审：未发现阻断性问题。评审提出的取整/措辞/证据说明已修正；其列出的
  “loaded >4,096 且本事务零 append”边界已由 `7dd9c6d` 修复并新增回归（发布与计数保持
  loaded 原样）。残留风险只剩证书所依赖的私有数组契约：该数组只 append 或整体替换，
  从不原地改内部元素（`lib/dockyard-domain/memory.js` 的 `#bridgeDeferredWindow`
  注释写明）。
- PR：[#41 perf: grow the staged replay marker window in place](https://github.com/ryukeilee/dsh-evolution/pull/41)
  （未合并、未发布；`release/` 固定产物未变）。
