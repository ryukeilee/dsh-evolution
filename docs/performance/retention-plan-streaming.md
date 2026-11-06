# retention/compact 大历史规划：去掉完整历史深拷贝与 dryRun 无读者物化

本轮针对 `lib/dockyard-domain/memory.js` 的 retention/compact 路径：**同一次计划把完整历史深拷贝两遍**
（`history()` 的 `structuredClone` 一份 + `records` 对保留行再 clone 一份），**并为只读的 dryRun
物化了整套会被丢弃的输出**（`records`/`canonical`/`tombstones` 及其副本）。最终保留两个候选：

- **C1：dryRun 只算计数，不物化输出**（`#retentionPlan({ materialize })`）；
- **C2：计划用 `historyView` 读取 + 按行所有权转移/按需 clone**（`#historyPlanRows`），不再
  `history()` 全量深拷贝，也不再构造 `{collection, entry}` 包装数组。

C3（compact 归档回读流式校验）与 C4（dryRun 跳过 `oldData` clone、plan-owned canonical/tombstone
直接移交）实现并测量后**撤回**：C3 的稳定收益只有 80k write CPU 约 −3%、峰值 RSS 无稳定收益，
约 70 行复杂度与收益不匹配；C4 未建立稳定、可归因的独立收益。撤回记录与历史数据见第 8 节。

最终树：`lib/dockyard-domain/memory.js` +178/−85（相对 `origin/main` = `a1db591`），
新增 7 个候选测试 + 独立差分/基架测试。未改 `history()`/`historyView()` 方法体、未新增持久化
格式/索引/缓存/后台任务、未改 `release/` 固定产物、未 push/合并/发布。

## 1. 结论

最终树：`lib/dockyard-domain/memory.js` sha256 = `0fc7a14d32f1d56bca86e57b5abf6c5f166fb083a25c9bd14a7540d481d7dad7`
（相对 `a1db591` +178/−85，含 Sol Loop 第 1 轮 S1 修复）。

在 40 000 / 80 000 冷行（原 main 的 retention 规划与写入是秒级同步操作）上，最终树相对
`origin/main`（同协议、同 fixture、A/B 交替、每侧 n=6）：

| 规模/阶段 | wall | CPU user+system | 外部采样峰值 RSS | 峰值−start |
| --- | ---: | ---: | ---: | ---: |
| 10k dryRun | −9.57% | −5.56% | 165.7→136.9 MiB（−17.39%） | −29.70% |
| 40k dryRun | −12.55% | −11.70% | 294.9→272.5 MiB（−7.58%） | −15.45% |
| 80k dryRun | −12.79% | −13.71% | 427.3→360.1 MiB（−15.72%） | −23.33% |
| 40k write | −6.70% | −5.74% | 352.0→329.7 MiB（−6.35%） | −10.29% |
| 80k write | −9.39% | −10.25% | 540.8→501.0 MiB（−7.36%） | −11.36% |
| 10k write | −0.43%（噪声） | +1.36%（噪声） | 209.2→219.9 MiB（**+5.12%**） | +7.78% |

- 10k/40k/80k dryRun 与 40k/80k write 的 wall/CPU/峰值收益均超过同协议 A/A 噪声
  （wall/CPU 中位 0.23%/0.25%、峰值 0.55%；阈值 2% / 2.2%）且两轮同向。
- **唯一显著负项**：10k write 外部峰值 RSS +10.7 MiB（+5.12%，两轮同向 +5.64%/+4.59%）。同格 wall/CPU/GC 后 heapUsed/
  archive 字节均无显著差异；**原因尚未直接归因**——可能来自写路径分配/GC 时点或分配器驻留
  差异，但本轮没有 GC 时序或 native/V8 分配归因证据证明这一点，不作为结论。它只出现在
  最小规模 write，已如实保留为上表负项，不包装为收益。
- 收益随规模增大：40k/80k write 的 wall −6.7%/−9.4%，峰值 −6.4%/−7.4%；dryRun 峰值 −7.6%/−15.7%。
- archive 字节两侧逐格完全相同（write：10k 5.47→5.76 MiB、40k 21.91→24.30 MiB、
  80k 43.88→49.07 MiB），report/state/archive 的 sha 与二次 compact 收敛断言全部 PASS。

“减少的是真实对象”的直接证据来自归因探针（origin/main，40k 冷行）：一次 dryRun 的 live heap
峰值 +62.63 MiB，其中 **`histories` 深拷贝保活 32.39 MiB、`records` 输出保活 32.46–32.80 MiB**
（`histories+plan` 同时保活 43.71 MiB）；本轮删掉的正是这两层完整历史副本与 dryRun 的整份输出。
80k dryRun 的 `compact 结束时 heapUsed` 从 195.37 降到 140.03 MiB（−28.33%）。

## 2. 基线方法与口径

旧的 `scripts/benchmarks/retention-plan-cost.mjs` 用事件循环内 `setInterval` 采样内存，但
`#retentionPlan()`/`#rewriteArchives()` 是同步的，已有证据（`docs/performance/retention-plan-rss/report.md`）
是同步规划期间定时器回调次数为 0，端点值不能当峰值。本轮新基线因此使用**进程外采样**：

- `scripts/benchmarks/retention-plan-streaming.mjs` + `scripts/benchmarks/retention-rss-sampler.py`；
- 每个样本是独立子进程：父进程把语料模板目录复制到样本私有 root（模板复制/哈希不在测量窗口内），
  子进程只 `EvolutionMemory.load()` 小 state → 双 GC → 发 `START` 并阻塞 → 父进程回 `go` →
  执行一次 `compact({ dryRun:true })` 或 `compact()` → 发 `END`；
- 父进程在 `START`/`END` 之间用进程外读取子进程 RSS（macOS `libproc.proc_pidinfo`，
  Linux `/proc/<pid>/statm`，约 2 ms；样本数与最大间隔随行记录）；
- 独立记录 wall、CPU user+system、GC 后 heapUsed、compact 结束时 heapUsed、archive 字节前后、
  归档树文件数、`resourceUsage().maxRSS` 增量（历史高水位下界，不是单次峰值）；
- 12 格 × A/A 与 A/B 各 2 轮 × 每轮每侧 3 样本 = 144 个独立子进程；A/B/B/A 轮换。

**口径敏感性自检**（模板协议，dryRun，10k/40k/80k）：`峰值−start` = 95.9 / 184.5 / 268.8 MiB，
`heapUsed 增量` = 25.1 / 106.3 / 170.3 MiB，两者随规模单调上升且比值 1.58–3.83，说明外部采样
观察到了规划阶段而不是 setup 高水位。A/A 噪声（跨 6 格，中位/最大）：wall 0.32%/0.64%、
CPU 0.25%/0.59%、外部峰值 0.55%/3.78%、峰值−start 0.91%/2.22%、GC 后 heapUsed 0.08%/0.23%、
archive 字节 0.00%。逐样本 1m loadavg 中位约 1.9、最大 3.4；外部采样典型最大间隔约 3 ms
（个别离群行 9–15 ms）。采样器的 `firstSampleMs`/`lastSampleMs` 曾把秒当毫秒输出
（Sol Loop 第 1 轮 N3），已修为毫秒；峰值与 `maxGapMs` 不受影响，历史基线文件的单位
已在其中注明。外部峰值仍是采样下界；`start RSS` 包含 `load()` 对 active archive 的
恢复扫描足迹，因此同时给出绝对峰值与“峰值−start”。

原始数据与完整口径：`docs/performance/retention-plan-streaming-baseline.{json,md}`
（144 条样本 + 每格中位数 + A/A 噪声 + 模板 sha256），环境为 Node v26.13.0 / darwin-arm64 /
8 CPU / 16 GiB。

## 3. 真实内存热点（origin/main，40k 冷行 / archive 22.97 MB）

归因探针：`scripts/benchmarks/retention-plan-attribution.mjs`，结果与分析见
`docs/performance/retention-plan-streaming-attribution.md`。一次 dryRun：

1. `histories[c] = this.history(c)` → `#mergeArchived(copy:true)`：先逐行 `JSON.parse` 出完整历史，
   再对每个合并行 `structuredClone` 一份（**40 000 次 clone**，最大保留图）；
2. `allRecords`：每行再包一个 `{collection, entry}` 对象；
3. `canonicalByKey`：对 canonical 表逐行 clone；`tombstoneMap = history("tombstones")` 再来一次
   完整历史读 + clone；
4. `#knowledgeRetentionPlan()`：每个来源行 `normalizeKnowledgeEvent`，`mergeKnowledgeEntry`
   累计合并（含 `clone(effects)` 与 `appendBounded` 的逐元素 clone，暂态约 120 000 次）；
5. `records`：保留行再 `clone(entry)`（**第二次完整保留行拷贝**）；聚合/压缩记录再构造新对象；
6. dryRun 返回前还 `clone(this.#data)`（那次 clone 在最终树里保留，见第 8 节 C4）。

实测：dryRun `structuredClone` 163 502 次、`JSON.parse` 69 760 次；live heap 峰值 +62.63 MiB；
保活量（pin，返回后只释放该对象图）`histories` 32.39 MiB、`plan/records` 32.46–32.80 MiB。
结论：规划期峰值主体是**真实的完整历史对象图**（`histories` + `records` 两层），不是采样噪声；
write 阶段另有归档回读/索引重建的整档解析（本轮未改）。

## 4. 改动

### 4.1 C1：dryRun 只算计数，不物化输出

`#retentionPlan({ materialize = true })`（`lib/dockyard-domain/memory.js:5003`）：

- `compact({ dryRun:true })` 传 `materialize:false`（`:5458`）；非 dryRun 的 `compact()` 与
  `finalizeKnowledge()`（`:5699`）保持默认 `true`，仍拿到完整 `records`/`canonical`/`tombstones`；
- dryRun 不建 `records` 数组、不 `push` 保留行、不 clone canonical 种子、不物化 tombstones 输出；
  用 `retainedCount` 与 tombstone 表的 `size` 回答报告需要的计数；
- **tombstone 合并求值在两种模式下是同一条路径**（Sol Loop 第 1 轮 S1 修复）：dryRun 也执行
  `tombstoneFor()`、previous 查找与同一个 `recordIds` 合并表达式，只省略最终数组物化。因此
  损坏/遗留的 tombstone（例如 `recordIds` 为 JSON 对象）在 dryRun 与真实 compact 上抛同样的
  `TypeError`，不会出现“dryRun 成功、写入失败”的分歧；
- 每个决策分支、每行 classification 的时钟读取、聚合/压缩记录与 `tombstoneFor()` 的构造**仍然执行**
  （保留 `id()` 的 `Date.now()`/`randomUUID()` 副作用序列与异常传播位置），只是不再保留对象；
- report 各字段来源与构造顺序不变，dryRun 仍零写入。

### 4.2 C2：计划读取去全量深拷贝 + 按所有权转移

`#historyPlanRows(collection)`（`:3048`）用 `historyView()`（只复制数组、不复制行）构建计划视图，
并按**对象身份**把行分三类：

| 类别 | 判定 | 决策如何读 | 输出所有权 |
| --- | --- | --- | --- |
| hot 行 | 是当前 `#data[collection]` 的元素 | 读取时 `clone()`（保持 `history()` 的 clone 形状，含 Error DTO 场景） | 可进入输出（plan-owned clone） |
| archive cache window 行 | 是 `archiveReadCache.get(c).window` 的非空槽位（含 inherited 缓存） | 直接用（它本来就是 archive `JSON.parse` 的值）；顶层非 plain object/array 的注入形状在读取时 clone | **必须 clone**（缓存仍持有该对象） |
| 新解析行 | 不在 hot、也不在 window | 直接用 | 可直接转移给输出（本次调用独占） |

- `#retentionPlan()` 删除 `allRecords` 包装数组，references/canonical 两遍改为同序的嵌套
  collection/row 循环；`histories` 由 `#historyPlanRows` 构建；
- knowledge 种子、非 knowledge 保留行、tombstone 种子统一经 `materializeRow` 在**输出边界**
  对 window 行 clone，其余（hot clone / fresh）直接复用；
  `#knowledgeRetentionPlan(histories, references, materializeRow)`（`:4933`）只对 seed 应用该规则；
- 所有身份 Set（`hot`/`windowRows`/`owned`）都是 plan-local，在 `#retentionPlan` 返回前丢弃，
  不进入 `records`、report 或实例字段；
- `history()`/`historyView()` 方法体未改（既有 housekeeping reversal 片段仍匹配）。

所有权依据来自实测：window 行只来自 `#scanArchiveRead`/`#archiveRowAt` 的 `JSON.parse`；
`#readArchiveSync` 的 `collectRows` fallback 中窗口行与 `cache.window` 是同一批对象
（40k 观测 2048/2048 同一对象、窗口外 1952 行第二次读取全部换身份）；inherited cache 的
window 行与 predecessor 共享（2048/2048），因此仍算缓存所有、不可转移。生产路径上不存在
非 JSON 形状的 window 行；外部向 `archiveReadCache` 注入非 JSON 值的用法已在测试中钉住为
“越界注入可分歧、JSON round-trip 必须一致”。

### 4.3 保持的语义边界

- 保留/退休/聚合/tombstone 决策、canonical knowledge 身份与 `sourceRefs`、行顺序/去重/时间戳
  全部不变；每行时钟读取次数与顺序不变（既有时钟契约用例）；
- dryRun 零写入；`records` 的所有权转移只发生在本次调用独占的行上；
- transaction/lock/回滚/异常传播未改；未新增持久化格式、索引协议、全局缓存或后台任务。

## 5. 等价性与正确性验证

- **固定点差分**：`test/dockyard-domain/retention-plan-equivalence-v021.test.mjs` 从
  `release/dsh-evolution-0.2.1.tgz`（= `origin/main` 发布的固定产物，`memory.js` 与
  `a1db591` 逐字节相同）解出基线侧，确定性/递增时钟下对比 dryRun report、三次 compact report、
  `fullSnapshot()` 投影、每个 state/索引/活动档案/segment 的 sha256、dryRun 前后字节不变、
  二次 compact 收敛、重启后 `history/fullSnapshot/historyWindow/historyScan/findSimilar/
  canonicalSnapshot/stats`；18 个测试全部 PASS（语料含 cold+hot、引用/canonical 保护/lineage、
  重复 knowledge/聚合、cycles、terminal retirement、tombstone 合并、无知识身份行、
  `sourceRefs`/`eventIds` 扩展、损坏输入、写失败回滚、重入/并发、负向对照，以及 Sol Loop S1 的
  “dryRun 与真实 compact 对损坏 tombstone 抛同一错误”用例）。
- **S1 异常等价回归**（`retention-plan-streaming.test.mjs` 第 7 个用例）：持久化 JSON 的
  `tombstones[].recordIds` 为对象 + 一条可退休 `gaps` 行时，`compact({dryRun:true})` 与
  `compact()` 都抛 `TypeError`（消息含 `not iterable`），且 dryRun 前后磁盘字节与
  `fullSnapshot()` 不变。
- **大语料安全测试**：`test/dockyard-domain/retention-plan-streaming-safety-large.test.mjs`
  在精确 40 000 冷行上验证 dryRun 零写入（state 端口 0 次 update/save + 全树 sha256 不变）、
  plan 不借用 `#data`/cache 活行（对象身份 + 覆盖度断言）、后续写入 + housekeeping + 二次 compact
  与基线一致、继承 `archiveReadCache` 的 successor 行为一致。
- **既有差分/回归**：`retention-plan-equivalence`、`archive-index-equivalence`、
  `housekeeping-equivalence`、`retention-history-view-clone-shape`、`archive-rewrite-batch`、
  `restart-recovery`、`failure-retention`、`promotion-journal-boundary` 与新测试文件共
  75 tests PASS；`archiveIndexBaseline().source` 仍为 rc.7 源（`58a75e35…`，175 320 B），
  差分仍是非平凡的。
- **测试基础设施适配**：`test/domain-storage/load-projection-baseline.js` 的 reversal 链从工作树
  重建 pre-change 源；本轮没有为 memory.js 新增 reversal 时，chain 的钉住摘要失败。修复方式是按
  本轮 diff 新增 `test/domain-storage/retention-plan-streaming-baseline.js`（25 个 guarded
  `[post, pre]` hunk，链首调用），`PRE_CHANGE_TREE` 摘要未改；重建出的三个文件 sha256 仍逐值等于
  原钉住值（memory.js `2c1039ee…`）。这是测试基线的适配，不是生产代码改动。
- 全量 `NODE_OPTIONS=--max-old-space-size=4096 npm test` 与 `npm run pack:check` 结果见第 7 节。

## 6. 实测（最终树 C1+C2 vs origin/main）

最终树 A/B（tree sha `bef0937e…` vs origin-main `70812c42…`）命令与原始数据：

```sh
node scripts/benchmarks/retention-plan-streaming.mjs \
  --a git:origin/main --b worktree --runs aa,ab \
  --scales 10000,40000,80000 --samples 3 --rounds 2 \
  --phases dryRun,write \
  --out docs/performance/retention-plan-streaming-ab.json \
  --md docs/performance/retention-plan-streaming-ab.md
```

每侧 n=6/格；数值为 origin-main → 最终树：

| 规模/阶段 | wall ms | CPU ms | 外部峰值 MiB | 峰值−start MiB | 结束时 heapUsed MiB |
| --- | --- | --- | --- | --- | --- |
| 10k dryRun | 304.0→274.9（−9.57%） | 421.7→398.2（−5.56%） | 165.7→136.9（−17.39%） | 95.8→67.4（−29.70%） | 32.48→32.17 |
| 10k write | 402.7→401.0（−0.43%） | 575.1→582.9（+1.36%） | 209.2→219.9（+5.12%） | 139.5→150.3（+7.78%） | 38.03→37.67 |
| 40k dryRun | 1147.5→1003.5（−12.55%） | 1499.8→1324.3（−11.70%） | 294.9→272.5（−7.58%） | 179.9→152.1（−15.45%） | 113.49→85.37（−24.78%） |
| 40k write | 1556.4→1452.2（−6.70%） | 2258.7→2128.9（−5.74%） | 352.0→329.7（−6.35%） | 236.8→212.4（−10.29%） | 75.65→80.23 |
| 80k dryRun | 2255.4→1966.9（−12.79%） | 2816.8→2430.6（−13.71%） | 427.3→360.1（−15.72%） | 278.5→213.5（−23.33%） | 195.37→140.03（−28.33%） |
| 80k write | 3125.0→2831.6（−9.39%） | 4674.2→4195.0（−10.25%） | 540.8→501.0（−7.36%） | 392.7→348.1（−11.36%） | 145.95→134.25（−8.02%） |

A/A 噪声与显著性判定见 `retention-plan-streaming-ab.md` §10；等价性断言 12/12 格、
144/144 行 PASS（dryRun 全部零写入、write 全部二次 compact 收敛、archive 字节两侧逐格相同）。

## 7. 验证与门禁（最终树）

未提交状态下的最终验证（工作树 `lib/memory.js` = `0fc7a14d…`，`knowledge.js` 未改）：

| 检查 | 结果 |
| --- | --- |
| `test/domain-storage/load-projection-equivalence.test.js` | 8/8 PASS，4.60 s；reversal 重建 memory.js sha256 = `2c1039ee…`（= `PRE_CHANGE_TREE`） |
| 固定点差分/反例（0.2.1 tarball vs 工作树，含 S1 用例） | 18/18 PASS，1.20 s，maxRSS 105 MiB |
| 大语料 40k 安全测试 | 1/1 PASS，9.66 s，maxRSS 675 MiB |
| 聚焦集（9 文件，含新文件 7 tests） | 75/75 PASS，1.94 s，maxRSS 113 MiB |
| `NODE_OPTIONS=--max-old-space-size=4096 npm test` | 1452 tests / 1449 pass / 1 fail / 2 skipped，54.9 s，maxRSS 734 MiB |
| `npm run pack:check` | 16 ok + 1 预期 FAIL，1.72 s，maxRSS 103 MiB |

唯一失败项在设计内：`release-pin` 的 “the working tree is the pinned release, or a committed
successor of it” 报 `unverified`/`this tree ships uncommitted changes`（`lib/dockyard-domain/memory.js`
是分发文件且有未提交改动）；`pack:check` 的同一项失败同源，其余 16 项全过（tree content `857b6429…` vs pin `bed2dd8b…`）。按 `RELEASE.md` 的
语义，这不是回归、也不能靠改断言绕过。按本轮任务约束（只改文件，不 commit/push/合并/发布），
**不执行本地 commit**，因此全量与 `pack:check` 各保留这 1 项设计内固定点失败；按 `RELEASE.md`
重新固定属于外部写入，本轮不执行。其余检查全部通过（见上表）。

### 7.1 真实官方宿主验收（本轮尝试，环境阻塞）

按“隔离 runtime/home、不触碰正式 DSH_HOME”的既有方式，用 `npm run release:pack` 产物
（content digest `857b6429…`）在隔离目录安装官方宿主执行验收。两个宿主都在 `core-flow`
步骤失败：`live doctor is blocked or unavailable`（前 4 步 `host-install` / `plugin-add` /
`profile-lists-bundle` / `doctor-cli` 均通过）。

为区分“本改动引起”与“环境/宿主侧问题”，用**未修改的 `a1db591` 树**（`release-021` worktree，
pin content digest `bed2dd8b…`）在同一台机器、同一隔离流程重跑同一宿主，**同样在同一 `core-flow`
步骤以同一错误失败**：

| 宿主 | 本改动产物 content | 结果 | 对照产物 content | 对照结果 |
| --- | --- | --- | --- | --- |
| 0.2.1-rc.2 | `857b6429…` | core-flow FAILED（live doctor） | `bed2dd8b…` | core-flow FAILED（同一错误） |
| 0.2.2-rc.1（`--no-hmr`） | `857b6429…` | core-flow FAILED（live doctor） | `bed2dd8b…` | core-flow FAILED（同一错误） |

两侧 `hostModules`、Node 版本（v26.13.0）、CLI doctor 结果（degraded、无 blocked check）与失败
步骤完全一致；官方 host 依赖版本也与固定证据记录一致（0.2.1-rc.2：cordis 4.0.5；0.2.2-rc.1：
cordis 4.1.0）。因此该失败**不是本改动的回归**，而是本机当前环境/宿主侧的可复现阻塞；本轮
**未能完成**宿主验收。失败与对照证据保留在
`docs/evidence/retention-plan-streaming-dsh-*.json` 与
`docs/evidence/retention-plan-streaming-control-a1db591-dsh-*.json`。既有 `release/` 固定点
`0.2.1` 的四宿主验收证据（`docs/evidence/dsh-*.json`）保持不变，但本轮没有重跑成功，不能引用
为“本轮通过”。

## 8. 撤回的候选（有数据，不进入最终树）

### 8.1 C3：compact 归档回读流式逐行校验（撤回）

动机：`#rewriteArchives()` 安装后用 `#readArchiveSync()` 再整体物化一遍新归档（全部行对象 +
全部文件字节）再逐行比较。C3 实现为 `#archiveRead` 取键表 → 窗口行比 key、窗口外按 file ordinal
分组、每文件 `readFileSync` 一次、slice+parse+key 后立即丢弃；异常回退旧全路径。约 70 行。

实测（`retention-plan-streaming-c3-ab.*`，C1+C2 快照 → C1+C2+C3，同一次 invocation）：
稳定收益只有 80k write CPU −3.08%（两轮 −3.08%/−4.43%，超 A/A CPU 最大 1.33%）；外部峰值 RSS
无稳定收益（轮间符号翻转）；40k/10k write 中性；10k/40k dryRun 的“+8.2%/+3.0%”不能归因于
C3：两棵树的 dryRun 执行代码完全相同（C3 只改 write 路径），该差异只能来自模块体积/堆布局/
GC 时机这类非行为因素，且在同一次 invocation 内可复现。结论：以约 70 行流式读回 + 异常回退
换取 80k write CPU 约 −3%，维护成本与收益不匹配，**撤回**。

### 8.2 C4：dryRun 跳过 oldData clone、plan-owned canonical/tombstone 直接移交（撤回）

实测：C4 没有受控 A/B（含 C4 的树 `2948ae49…` 与无 C4 的 C1–C3 树 `a42399f5…` 是两次
独立 invocation；候选侧中位数多数差异在 ±1% 内，但个别格超出，例如 40k dryRun CPU −2.32%、
80k write 峰值 RSS −2.62%，跨 invocation 的差异不能作为 C4 的受控归因）。C4 可量化的直接
成本只有 warm 状态下 dryRun 的 `oldData` clone 约 2.1 MiB（归因 pin）与 canonical/tombstone
的少量副本，**现有数据没有建立稳定、可归因的独立收益**。按验收标准“收益低于测量噪声则不修改
生产代码”，**撤回**，最终树保留原有的 `oldData`/`canonical`/`tombstone` clone 行为。

历史数据文件保留：`retention-plan-streaming-ab-with-c3.{json,md}`（C1–C3 最终 A/B）、
`retention-plan-streaming-c3-ab.{json,md}`（纯 C3 边际）、
`retention-plan-streaming-c3c4-ab.{json,md}`（含 C4 的边际）。它们只作撤回证据，不是最终树结论。

### 8.3 评估后未做的其他候选

- **knowledge 合并的 clone 缩减**（`mergeKnowledgeEntry` 的 `clone(effects)`、`appendBounded`
  逐元素 clone，40k 下约 120 000 次 clone）：只能作为显式选项并需 knowledge 行内别名契约测试，
  knowledge.js 同时服务写路径，收益相对 histories 副本次要，**不做**（归因文档 §5.5）。
- **`#readArchiveSync` 冷缓存一次解析**（用 `collectRows` 避免窗口外行二次解析）：会改动
  `history`/`fullSnapshot` 共用的完整历史读，收益主要是 CPU、不是本轮优先的完整历史副本，**不做**。
- **key-table-only 回读比较**（不逐行验证 locator）：丢失“定位符可复现”校验强度，**不做**。

## 9. 收益边界、复杂度与维护成本

- **适用规模**：收益与“计划读取的完整历史行数”成正比。plan 路径（dryRun 与 compact 的规划阶段）
  收益最稳定；write 阶段还有归档序列化/索引重建等不随本轮下降的固定成本，因此被摊薄
  （40k/80k write wall −7%/−9% 对 dryRun −13%）。
- **不适用/接近零收益**：空计划或只有很少来源行；没有冷档案的小 store（此时所有行都是 hot，
  C2 仍需 clone，收益主要来自 C1 的 dryRun 输出物化）。10k write 的 wall/CPU 在噪声内，
  峰值 RSS 有小幅回退（+10.8 MiB），不宣称 write 小规模收益。
- **复杂度**：生产代码 +178/−85，集中在两个私有方法与它们的所有权注释；没有新持久化格式、
  索引、缓存或后台任务。测试侧新增 7 个用例 + 固定点差分/基架，并修复了 load-projection
  reversal 链的测试基础设施适配（只改 test/）。
- **是否值得保留**：是。两个候选都直接删除“完整历史深拷贝”与“dryRun 无读者物化”，
  40k/80k dryRun 峰值 −7.6%/−15.7%、wall −12.6%/−12.8%，write 峰值 −6.4%/−7.4%、
  wall −6.7%/−9.4%，且 144/144 行等价断言与固定点差分逐字节通过。C3/C4 因收益不足已撤回，
  没有用复杂度换取微小加速。

## 10. 剩余风险与未覆盖边界

- **外部 RSS 是采样下界**：2 ms 采样可能漏掉更短的瞬时峰值；未持久化逐 2 ms 轨迹，
  未做 native(malloc/mmap) vs V8 heap 归因，未在 `--pinned-heap` 下测 write 阶段 OS 峰值，
  未 flush OS page cache。
- **合成语料**：确定性时钟 + 一次生成的 fixture（40% observations / 20% knowledge / 20% cycles /
  10% outcomes / 10% promotions + canonical 指针），不含宿主事务/fsync/多进程争用/启动
  archive-index reconciliation；真实部署的分布可能不同。
- **C2 的 window 行形状假设是 load-bearing**：生产 window 行只来自 archive `JSON.parse`；
  外部通过构造参数向 `archiveReadCache` 注入非 JSON 值不在契约内（测试钉住“越界注入可分歧、
  JSON round-trip 必须一致”）。若未来出现把非 JSON 值放进读缓存 window 的生产路径，
  该假设失效，必须改为读取时全量 clone window 行。
- **10k write 峰值 +5.12%**：见第 1 节；规模小、绝对 +10.7 MiB，同格 wall/CPU/结束堆/归档字节
  无显著差异，未定位到单一分配点。若未来把它当作必须消除的回归，应针对 write 路径单独做
  分配归因（本轮未做）。
- **未覆盖的失败点**：进程 kill/真实崩溃与 install/rename 中途失败、跨进程并发、sealed segment
  摘要/缺失 segment/quarantine 残件、>80k 规模与 Node 22/其它平台。
- **性能数字只在本机**：Node v26.13.0 / darwin-arm64 / 8 CPU / 16 GiB；不同 Node/分配器/页缓存
  状态下绝对峰值可能不同，方向与相对收益以同协议 A/A 噪声为界。
- **真实宿主验收未完成**：两个受支持宿主在本机隔离验收的 `core-flow` 步骤失败；同一失败在
  未修改的 `a1db591` 对照产物上原样复现（见 §7.1），因此不归因于本改动，但也不能声称本轮
  通过宿主验收。固定点 `0.2.1` 的既有四宿主证据未被本轮重跑。
- **测量窗口的边界不确定性**（Sol Loop 第 1 轮指出，未证明会改变结果）：子进程在发 `END`
  后立即 `GC`，没有等待父进程采样器停止；若 GC 恰在采样间隔内发生，外部峰值可能受端点选择
  影响。本轮该窗口小于 2 ms 采样间隔，未观察到它对峰值结论的影响，但没有专门实验证明。
- **归因原始数据**：`scripts/benchmarks/retention-plan-attribution.mjs` 的 40k 原始 JSON
  已固化在 `docs/performance/retention-plan-attribution.json`，可复算保活量/解析与 clone 计数。

## 11. 复现

```sh
# 1) 基线（两侧都是 origin/main 冻结副本）
node scripts/benchmarks/retention-plan-streaming.mjs \
  --a git:origin/main --b git:origin/main --runs aa,ab \
  --scales 10000,40000,80000 --samples 3 --rounds 2 --phases dryRun,write \
  --out docs/performance/retention-plan-streaming-baseline.json \
  --md docs/performance/retention-plan-streaming-baseline.md

# 2) 最终树 A/B（--b worktree）
node scripts/benchmarks/retention-plan-streaming.mjs \
  --a git:origin/main --b worktree --runs aa,ab \
  --scales 10000,40000,80000 --samples 3 --rounds 2 --phases dryRun,write \
  --out docs/performance/retention-plan-streaming-ab.json \
  --md docs/performance/retention-plan-streaming-ab.md

# 3) 归因（40k，所有权 + 保活 + 解析/clone 计数）
node --expose-gc scripts/benchmarks/retention-plan-attribution.mjs \
  --mode all --scales 10000,40000

# 4) 等价性/安全
node --max-old-space-size=4096 --test test/dockyard-domain/retention-plan-equivalence.test.js
node --max-old-space-size=4096 --test test/dockyard-domain/retention-plan-equivalence-v021.test.mjs
node --max-old-space-size=4096 --test test/dockyard-domain/retention-plan-streaming-safety-large.test.mjs
node --max-old-space-size=4096 --test test/domain-storage/load-projection-equivalence.test.js

# 5) 回归/门禁
NODE_OPTIONS=--max-old-space-size=4096 npm test
npm run pack:check
```

## 12. 审核记录

### 12.1 Sol Loop 第 1 轮（独立只读审核）

- 时间与配置：2026-11-06 23:16:14–23:21:12（Asia/Shanghai，4 分 58 秒）；请求
  `codex` / `gpt-6.1-sol` / `reasoningEffort: xhigh`，工具返回的配置与请求一致；未获得独立
  后端遥测，因此只声称“请求并返回 xhigh”。Token 用量：工具未返回。
- 审核范围：工作树相对 `a1db591` 的 diff（生产 `lib/dockyard-domain/memory.js`、测试基线适配
  `test/domain-storage/load-projection-baseline.js`）、新增测试/基准/文档。
- 结论：**VERDICT: CHANGES**，1 个 should、3 个 nit，无 blocker。
- 有效问题与修复：
  - **S1 [should，阻止批准]** dryRun 跳过既有 tombstone 合并求值，改变异常传播：损坏的持久化
    `tombstones[].recordIds`（JSON 对象）下，固定 0.2.1 的 dryRun 与真实 compact 都抛
    `TypeError`，而候选 dryRun 成功报告。**已修复**（统一两种模式的 tombstone 合并求值，
    只省略输出物化；新增实现侧回归与 verifier 的固定点差分用例）。
  - **N1 [nit]** 主报告 C4 撤回段的数字/归因过强（跨 invocation 对照并非“全部 ≤1%”）。
    **已修正**：改为“现有数据未建立稳定、可归因的独立收益”，并复算列入 40k dryRun CPU
    −2.32%、80k write 峰值 RSS −2.62% 等超出项。
  - **N2 [nit]** 10k write 峰值 +5.18%（初版树）的 GC 因果解释未经证明。**已修正**：改为“原因尚未
    直接归因”，只保留可观察事实。
  - **N3 [nit]** `retention-rss-sampler.py` 的 `firstSampleMs`/`lastSampleMs` 单位错误
    （秒当毫秒）。**已修复**（输出 ×1000），历史数据在 `retention-plan-streaming-baseline.md`
    的未测量项里注明单位，峰值/maxGapMs 不受影响。
- 复核材料：审核者独立执行 38 项聚焦测试（10.29 s）、单独应用 25 个 reversal hunk 并与
  `a1db591` 的 `memory.js` 逐字节比对、复算五份基准 JSON 的每格中位数、核对最终 A/B 记录的
  42 个 `lib/` 文件摘要；未执行全量/宿主验收/长基准。

### 12.2 Sol Loop 第 2–3 轮（复核修复、确认 nit）

#### 第 2 轮（复核 S1 修复与文档修正）

- 时间与配置：2026-11-06 23:37:06–23:40:53（3 分 47 秒）；`codex` / `gpt-6.1-sol` /
  `reasoningEffort: xhigh`（请求与回传一致，未获独立遥测）。Token 用量：未返回。
- 结论：**VERDICT: APPROVE**，没有未解决的 blocker/should；保留 2 个文档 nit（N1/N2 的
  残留概括）与 1 个流程 nit（N4：文档中的本地 commit 计划与“只改文件”约束不符）。
- 独立复核证据：解包固定 0.2.1 tarball，在 4 个独立临时 store 上运行基线/候选 × dryRun/真实
  compact，四组都抛同一条 `TypeError`；在临时副本中注入“dryRun 跳过合并”的回退后，两处
  新增测试都按预期失败（证明不是同义反复）；33/33 相关测试通过、40k 安全测试 1/1 通过、
  `pack:check` 16 ok + 1 预期失败、25 个 reversal hunk 重建摘要 `2c1039ee…` 吻合。
- 本轮返工：按 N1/N2 修正两处残留概括、按 N4 把“审核后本地 commit”计划改为“按任务约束
  不 commit、保留设计内固定点失败”。均为文档改动，不触及生产代码；生产代码在 S1 修复后
  未再改动（sha 全程 `0fc7a14d…`）。

#### 第 3 轮（确认轮）

- 时间：2026-11-06 23:43:07–23:44:40（1 分 33 秒），同一 `codex/gpt-6.1-sol` / xhigh。
- 结论：**VERDICT: APPROVE**；N1/N2/N4 全部 RESOLVED，无新 blocker/should。
- 复核：生产代码 sha 仍 `0fc7a14d…`、diff +178/−85；33/33 相关聚焦测试通过；文档旧断言无残留。

### 12.3 DSH 团队耗时

- `bench-baseline`：task-1 基线（144 样本 315 s 测量 + 脚本/协议调试）、task-5/6/7 三轮 A/B
  （308.7 s / 308.7 s / 308.4 s 测量）与 task-8 最终重跑、sampler 单位修复。
- `analyst`：task-2 归因（40k 探针 32 s wall / 54 s CPU + 文档）与所有权证明。
- `implementer`：task-3 的 C1–C4 实现、撤回与 S1 修复（分阶段聚焦测试）。
- `verifier`：task-4 差分基架、固定点差分/反例/大语料/全量/pack:check，以及 load-projection
  reversal 测试基线修复。
- 团队总墙钟：2026-11-06 21:52–23:45 左右（并行执行；各成员实际耗时以任务报告为准）。
- Sol Loop：3 轮（23:16:14–23:21:12、23:37:06–23:40:53、23:43:07–23:44:40，共约
  10 分 18 秒），模型 `codex/gpt-6.1-sol`、请求 `reasoningEffort: xhigh`；有效问题
  1 个 should + 4 个 nit；返工 2 次（S1 生产修复 + 文档/量测口径修正）；第 2 轮 APPROVE、
  第 3 轮确认 nit 全部解决。
- Token 成本：`spawn_teammate`/`delegate_task` 未返回 token 用量，本会话无法可靠获取；
  不编造数字。

## 13. 交付文件

- 生产：`lib/dockyard-domain/memory.js`（+178/−85）
- 测试：`test/dockyard-domain/retention-plan-streaming.test.mjs`（7 tests）、
  `test/dockyard-domain/retention-plan-equivalence-v021.test.mjs`、
  `test/dockyard-domain/retention-plan-streaming-support.mjs`、
  `test/dockyard-domain/retention-plan-streaming-safety.test.mjs`、
  `test/dockyard-domain/retention-plan-streaming-safety-large.test.mjs`、
  `test/domain-storage/retention-plan-streaming-baseline.js`、
  `test/domain-storage/load-projection-baseline.js`（测试基线适配）
- 基准/归因：`scripts/benchmarks/retention-plan-streaming.mjs`、
  `scripts/benchmarks/retention-rss-sampler.py`、
  `scripts/benchmarks/retention-plan-attribution.mjs`
- 宿主验收尝试与对照：`docs/evidence/retention-plan-streaming-dsh-*.json`、
  `docs/evidence/retention-plan-streaming-control-a1db591-dsh-*.json`（环境阻塞证据，非通过证据）
- 数据/报告：`docs/performance/retention-plan-streaming-baseline.{json,md}`、
  `retention-plan-streaming-ab.{json,md}`、`retention-plan-streaming-attribution.md`、
  `retention-plan-streaming-verification.md`、`retention-plan-streaming.md`（本文）；
  撤回证据 `retention-plan-streaming-ab-with-c3.{json,md}`、`-c3-ab.{json,md}`、
  `-c3c4-ab.{json,md}`
