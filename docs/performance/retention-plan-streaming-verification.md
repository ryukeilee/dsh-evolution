# retention / compaction 流式化：独立差分验证（固定点 0.2.1 基线）

本文件记录对 `lib/dockyard-domain/memory.js` retention/compact 性能改动（task-3）的**独立**验证基架与结果。验证目标是证明候选实现与改动前实现**行为等价**，而不是复述实现者新增的用例。分两阶段：

- **阶段 4a（本文已记录）**：差分基架 + 反例测试可运行；在此阶段工作树 `lib/` 尚未改动，同一份语料会得到 A/A（两侧逐字节相同）。
- **阶段 4b（待候选实现完成后追加）**：对候选跑全部差分与反例，并独立执行聚焦测试、全量 `npm test`、`npm run pack:check`；结果、预期失败与真实回归的区分写在文末“阶段 4b”一节。

## 1. 基线锚点

| 项 | 值 |
| --- | --- |
| 基线产物 | `release/dsh-evolution-0.2.1.tgz` |
| `release/manifest.json` 记录的 sha256 | `b06f61d5a08fe4d6cd4da7b5203800ad393d92fc087b0a396b1b726655600764` |
| manifest `sourceCommit` | `97a240e6075c8ca9dc7adc93d635190ea68e4c35` |
| 本 worktree HEAD / origin-main | `a1db591` |
| 固定产物中的 `package/lib/dockyard-domain/memory.js` sha256 | `4c9be3c39ea203a73ff949db2d2a1188c5034c1f5e9098dc288aa0081684f8f8` |
| 固定产物中的 `package/lib/dockyard-domain/knowledge.js` sha256 | `9b9cebaf5a647e063163db577a151f9ca6da6d3146ca61547ca54b3a6c1652b2` |
| 2026-11-06 时工作树的上述两个文件 | 与固定产物**逐字节相同**（因此 4a 的首次运行是真正的 A/A） |
| 4b 最终候选（C1+C2 + Sol Loop r1 S1） | `lib/dockyard-domain/memory.js` sha256 `0fc7a14d32f1d56bca86e57b5abf6c5f166fb083a25c9bd14a7540d481d7dad7`（diff +178/−85；含 Sol Loop 第 1 轮 S1 的 tombstone 合并统一求值修复）；`knowledge.js` sha256 `9b9cebaf5a647e063163db577a151f9ca6da6d3146ca61547ca54b3a6c1652b2`（与固定产物相同，未改） |

基线侧不是手写副本：测试在运行时读取 tarball、用 `scripts/release/release-lib.mjs` 的 `readTarEntries()` 解包到 `mkdtemp`，再 `import()` 解出的 `package/lib/dockyard-domain/memory.js`。解包前断言：

1. manifest 的 `version` 是 `0.2.1`、`filename` 是 `dsh-evolution-0.2.1.tgz`；
2. tarball 文件的 sha256 等于 manifest 记录的 `sha256`（即“固定产物还是那个字节”）；
3. 解出的模块仍导出 `EvolutionMemory`，`knowledge.js` 仍导出 `mergeKnowledgeEntry`。

语料构造使用**固定产物里的** `knowledge.js`（`mergeKnowledgeEntry` / `normalizeKnowledgeEvent`）生成 accumulator 行；两侧在规划时仍各自运行自己的 `knowledge.js` 归一化同一份 JSON 输入，所以如果候选改变了知识身份语义，差分同样会暴露。

## 2. 交付文件

| 文件 | 作用 |
| --- | --- |
| `test/dockyard-domain/retention-plan-streaming-support.mjs` | 固定产物解包/import、确定性时钟、语料、种子写入、磁盘摘要、读面投影、可注入 state store、标准差分运行器 |
| `test/dockyard-domain/retention-plan-equivalence-v021.test.mjs` | 等价性差分：标准语料、无 archive tier、递增时钟契约、损坏输入、写失败回滚、并发/重入、负向对照 |
| `test/dockyard-domain/retention-plan-streaming-safety.test.mjs` | 针对性反例：dryRun 零写入；plan 输出不得借用 `#data` / `archiveReadCache` 活行；cache 预热不改变任何可观察结果；非 JSON window 行边界 |
| `test/dockyard-domain/retention-plan-streaming-safety-large.test.mjs` | 40,000 冷行的规模检查（dryRun 零写入、所有权/借用、继承缓存 successor），见第 11 节 |
| `test/domain-storage/retention-plan-streaming-baseline.js` | load-projection 差分链的本轮 guarded reversal（25 个 hunk），见 9.2 |
| `test/domain-storage/load-projection-baseline.js`（修改） | 重建链首调用上面的 reversal（`PRE_CHANGE_TREE` 未改） |

这些文件只写 `test/` 与本文档；没有修改 `lib/`、`release/`、`package.json`、`scripts/benchmarks/`，也没有 commit/push。

## 3. 差分对比的可观察面

两侧在**同一个 home 路径**上顺序运行（每侧开始前清空并重新写入同一份语料），因此产物里的绝对路径、inode 派生信息不会造成无关差异。每次运行记录并跨侧比较：

1. `compact({dryRun:true})` 的 report 逐字段（含 `beforeBytes`/`afterBytes`/`dryRun`）；
2. dryRun 前后的**全树逐文件 sha256**（dryRun 不得写入）；
3. 三次真实 `compact()` 的 report；
4. 每次 compact 后的 `JSON.stringify(fullSnapshot())` 全量状态投影（字段增减、顺序、时间戳都在比较范围内）；
5. 每次 compact 后的全树逐文件 sha256（state、索引、活动 archive、`.segments/*`）；
6. 每一阶段的时钟读取次数（load / dryRun / compact1 / compact2 / compact3 / 重启 load）；
7. 重启恢复：新实例 `load()` 后的 `fullSnapshot()`、全部 collection 的 `history()` 与 hot-only `history()`、`historyWindow()`、`historyScan()`（`total`/`exact`/窗口行）、`findSimilar()`、`findSimilarStrategies()`、`canonicalSnapshot()`、`stats()`，以及重启是否改写字节；
8. 第三次 compact 与第二次的 state/字节固定点（accumulator 收敛）。

递增时钟场景使用“每读一次前进 1 秒”的时钟：如果候选折叠、重排或多读了一次时钟，写出的 index `updatedAt` 与无自带时间戳知识行的 `firstSeen` 会移动，差分直接失败。时钟读取次数按阶段**要求完全相等**（task-3 的硬约束：`#retentionPlan` 的行时钟读取次数必须与改动前一致），不是“允许少读”。

## 4. 语料与决策覆盖

生成语料后，测试先断言**基线侧真的做了这些决策**，再比较两侧——否则一个退化成 no-op 的 plan 会因为“都没做事”而相等。

标准语料（约 50 条源行，`hotEntries: 3`、`hotCycles: 2`、`archiveMaxBytes: 4096`）覆盖：

- 冷档案行与热行混合：observations / knowledge / outcomes / strategies 各有一部分在 state 文件里，其余在 `<state>.<collection>-archive.jsonl`；
- 知识 accumulator：一个有 `sourceRefs` 覆盖重放的种子（merge guard 双向：覆盖时不合并、无 `sourceRefs` 时不合并），一个有 `eventId` 窗口的种子，重放会同时扩展 `sourceRefs` 与 `eventIds`；
- 重复/聚合：12 条同形状 info observation 形成 3 个聚合组；4 条 error observation 保持可寻址；
- cycles：6 条普通 observed cycle（consolidate）+ 1 条 knowledge-bearing meaningful cycle（保留）；
- 终止记录：6 条 rejected outcome、4 条 rolled_back promotion、重复的 rejected candidate（tombstone 合并）；
- canonical：持久 canonical 表指向一条 terminal opaque 行（保护其不被退休），两条同 canonical key 的 strategy 由 plan 派生 winner 并让旧者以 `replacedBy` 被退休；
- 引用保护：一条 terminal opaque 行被另一行的 `sourceRefs` 引用；
- lineage：同 lineage 的旧代（SUPERSEDED，被退休）与最新代（REJECTED，被最新代规则保护）；
- 无知识身份行：两条 opaque observation 行；
- 无自带时间戳的 knowledge 行 3 条：其派生时间戳必须来自“自己那一行”的时钟读取。

A/A 实测（2026-11-06，Node v26.13.0 / darwin-arm64）：

```text
retired 15, consolidated 27, aggregatedObservations 3, tombstones 9,
knowledge 7 -> 22, canonical 2 (persisted + derived), retainedCanonical 2
compaction report: beforeBytes 24134 -> afterBytes 13106（15 files，至少 seal 一个 segment）
clock reads: load 11, dryRun 106, first 120, second 70, third 70, restartLoad 11
```

无 archive tier（纯内存 store）场景：`retired 10, consolidated 27, knowledge 7 -> 22`，两侧 report/state/读面/时钟读取相等。

## 5. 针对性反例

1. **dryRun 零写入**：断言 `stateStore.update`/`save` 调用数不增加、全树文件 sha256 不变、文件清单不变（没有新建/删除临时文件）。注意：dryRun 仍会执行既有 `#performHousekeeping()` 的内存清理，这是改动前就存在的行为，所以这里只断言“持久层零写入”，不断言内存投影不变。
2. **plan 输出不得借用活行**：
   - 先通过 `history()`/`historyView()`/`fullSnapshot()` 填满 `archiveReadCache`，记录 compact 前 `#data` 热行（经 `historyView()` 取得活对象）与 cache window 行（`archiveReadCache` 是公开实例字段）的对象身份；
   - compact 后检查三类违规：`#data` 热行在 compact 后仍是同一对象（plan 把 store 自己的行交回来了）、compact 前的 cache 行变成 hot store 行、hot 行与 cache 行是同一对象。基线侧三者都为空；候选若“转移所有权”时没有对 `#data` 热行和 cache 行 clone，会在这里失败。
   - 检查本身不能是空集比较：A/A 实测 compact 前捕获 5 条热行对象、60 条 cache 行对象，compact 后 37 条热行、23 条 cache 行；数量不足会让测试失败（覆盖度断言）。
   - dryRun 前后 cache window 行的 JSON 投影必须一致（读计划不得原地修改缓存行）。
   - 随后执行一次真实写入 + 公开 `housekeeping()` + 第二次 compact，并要求“预热 cache 的运行”和“未预热 cache 的运行”在 report、state、读面、字节上完全一致；再要求两侧预热运行一致。
3. **负向对照**：在解包出的固定产物副本里把 report 初始值 `retired: 0,` 改成 `retired: 2,`（精确单次匹配，改动只发生在临时副本，绝不改工作树），用同一个比较函数运行，要求差分**拒绝**该差异（实测 `dryRun.retired` 15 vs 17）。这证明基架不是“比较空集也通过”。
4. **records 字节差异**：由第 3 节的逐文件 sha256 覆盖；plan 输出被篡改会先改变 archive 行字节。
5. **时钟读取次数/知识时间戳**：由第 3 节的递增时钟测试覆盖。
6. **dryRun 与写路径的异常传播一致（Sol Loop r1 S1）**：持久化 tombstone 的 `recordIds` 为对象、且一条 terminal 行会生成同 id tombstone 时，两侧 dryRun 与真实 compact 必须抛同类 TypeError，dryRun 前后字节不变。见 9.6；修复前该用例会抓住“候选 dryRun 吞掉合并异常”的差异。

## 6. 失败、损坏与并发边界

- **损坏输入**（每一类都要求两侧 outcome 逐字段相同，且失败后全树字节等于 `load()` 留下的字节）：
  - archive 中出现非法 JSON 行 → `load` 成功、dryRun 成功、compact 以 `E_ARCHIVE_REWRITE_UNSAFE` 拒绝；
  - archive 尾部被截断（torn tail）→ 同上；
  - archive 文件不可读（`chmod 000`）→ `load` 以 `EACCES` 失败；
  - 索引文档不可分类 → `load` 以 `E_ARCHIVE_INDEX_STATE_UNKNOWN` 失败；
  - `.segments` 目录不可读 → `load` 以 `EACCES` 失败。
  - 权限相关用例在 root 下不成立，会显式 skip（本机与 CI runner 均非 root）。
- **写失败回滚**：
  - state 端口 `update` 在 archive 安装之后抛错：要求异常原样传播、磁盘恢复到“load/plan 之后”的字节、内存状态恢复到 plan 留下的状态（= dryRun 后的状态，因为 plan 的 housekeeping 是计划的一部分）、随后重试成功并最终收敛。
  - archive 目录被 `chmod 500`（staging 阶段写入失败）：要求 `EACCES` 传播、树上字节不变、重试成功。
  - 错误消息中的随机 UUID（浓度临时文件名）在比较前归一化为 `<uuid>`。
- **并发/锁边界**：
  - 在 `archiveWriting` 上挂一个未兑现的 promise 让 compact 停住：要求停住期间尚未写盘、尚未 plan；此时 `maintenance({force:true})` 返回 `skipped: "already-compacting"`；排队的 dryRun 仍按队列执行且看到 compact 后的树。
  - 把 `archiveWriting` 换成 rejected promise：要求 compact 以注入错误 reject、state/字节不变；恢复后 compact 成功。
  - 覆盖的是**同进程 mutation 队列与 archiveWriting 等待**，不是跨进程 append lock（`memory.js` 的 compact 路径不持有跨进程锁；跨进程互斥属于 orchestrator/event bridge 的范围）。

## 7. 明确未覆盖 / 未能证明的边界

- **行级所有权的观测边界**：公共读接口都会 clone，`historyView()` 明确返回活行，所以“plan 内部临时对象”是否被复用无法从外部观测。第 5 节用对象身份 + 后续写入/housekeeping/二次 compact 的可观察行为覆盖“借用会活过 plan”的情形；一个只在 plan 内部短暂共享、从未进入 `#data` 或 cache 的对象不在覆盖范围内（也没有可观察面）。
- **写失败注入点**：覆盖“archive 重写前 staging 失败”和“archive 安装后 state 保存失败”两个点。未覆盖：install/rename 序列中途进程崩溃、commit 阶段 `rm` 备份失败（实现本身 `.catch` 忽略）、index 文档单独写失败（发生在安装之后、state 保存之前的窗口没有可注入钩子）、`kill -9` 后的重启恢复（需要构造真实中断现场，本基架用 dryRun/失败回滚近似，未做进程级崩溃）。
- **损坏形态**：未覆盖 sealed segment 摘要/大小不匹配、index 声明缺失 segment、quarantine 残件；这些属于 archive 完整性路径而非本次流式化改动的主要接触面。
- **跨进程并发**：只验证同进程重入与等待；未验证两个进程同时 compact 同一 home。
- **大语料**：本基架故意用小语料（~50 行）保证快速、可确定性；10k/40k/80k 行的性能与内存由 task-1/task-2 的基准与归因负责，本基架不替代性能证明。
- **重启恢复**只覆盖“正常 compact 后新实例读面一致”；崩溃残留（staging、`*.compact-*.tmp`、pending transition）不在覆盖内。

## 8. 复现命令

```sh
# 差分基架（基线 = release/dsh-evolution-0.2.1.tgz 解包 import；候选 = 工作树 lib/）
node --max-old-space-size=4096 --test test/dockyard-domain/retention-plan-equivalence-v021.test.mjs

# 针对性反例
node --max-old-space-size=4096 --test test/dockyard-domain/retention-plan-streaming-safety.test.mjs

# 大语料 40,000 冷行（约 10 s / 峰值 ~0.7 GiB）
node --max-old-space-size=4096 --test test/dockyard-domain/retention-plan-streaming-safety-large.test.mjs

# load-projection 差分（含本轮 guarded reversal；PRE_CHANGE_TREE 不变）
node --max-old-space-size=4096 --test test/domain-storage/load-projection-equivalence.test.js

# 全量与分发检查
NODE_OPTIONS=--max-old-space-size=4096 npm test
npm run pack:check
```

2026-11-06 的 A/A 实测（4a，工作树 lib/ 与固定产物逐字节相同）：差分 14 个测试（含负向对照）全部通过，约 1.2 s；反例/边界 2 个测试通过，约 0.6 s；单进程、约 50 行语料。4b 最终结果见 9.4。

## 9. 阶段 4b：最终候选 C1+C2

### 9.0 最终候选、C3/C4 撤回与 Sol Loop r1 S1 修复

最终候选只保留 C1（`compact({dryRun:true})` 不再物化 plan 的输出数组与副本）与 C2（`#retentionPlan()` 用 `historyView()` 读取、只对非本次调用独占的行 clone；`#historyPlanRows()` 负责 hot 行 clone 与 cache-window 行延迟 clone）。**C3（compact 归档读回轻量化）与 C4（compact 去重复克隆）撤回**，Lead 决策依据验收标准 #11：C3 的稳定收益只有 80k write CPU 约 −3%，峰值 RSS 无稳定收益，而新增约 70 行流式读回与异常回退，复杂度与收益不匹配；C4 未建立稳定、可归因的独立收益。撤回后没有留下针对 C3/C4 的测试断言。

**Sol Loop 第 1 轮 S1（should，已修复）**：dryRun 把 tombstone 表换成 id 集合后跳过了既有 tombstone 的合并求值。合并不只是输出物化——它要展开前一条 tombstone 的 `recordIds`；持久化 JSON 允许该字段是对象，展开会抛 TypeError。于是 dryRun 会报告一个写路径根本执行不了的 plan，并吞掉真实 compact 仍会抛出的异常。修复方式（Lead 方案）：dryRun 与 materialize 共用同一条 tombstone 合并求值，只省略输出物化。独立差分回归用例见 9.6。

冻结（最终）：`lib/dockyard-domain/memory.js` sha256 = `0fc7a14d32f1d56bca86e57b5abf6c5f166fb083a25c9bd14a7540d481d7dad7`（diff +178/−85）；`lib/dockyard-domain/knowledge.js` sha256 = `9b9cebaf5a647e063163db577a151f9ca6da6d3146ca61547ca54b3a6c1652b2`（与 0.2.1 固定产物相同，未改）。全程未改 `lib/`、未 commit。

### 9.1 冻结输入

核对上述两个 sha256。任何一个不同，说明冻结后又被改动，本节的结论不能作为该冻结版本的结论。

### 9.2 load-projection reversal 修复（本轮新增，test 侧）

全量回归曾暴露 5 个真实红灯：`test/domain-storage/load-projection-equivalence.test.js`（8 个测试中 5 个）因为 `load-projection-baseline.js` 的 newest-first reversal 链仍从工作树重建 pre-change 树，而本轮没有配套 reversal round，钉住摘要失败（`reversed source must equal 6b4dee9`）。这只是差分基架约定缺失，不是行为不等价（独立 0.2.1 差分已逐字节证明等价）。

修复（两处，均在 test 侧，`PRE_CHANGE_TREE` 摘要未改）：

- 新增 `test/domain-storage/retention-plan-streaming-baseline.js`：25 个 `[post, pre]` guarded hunk，由 `git diff origin/main -- lib/dockyard-domain/memory.js` 机械逆生成、按补丁逆序应用；S1 修复后已按新 diff 重新生成（header 注明 C1+C2 + S1），导出 `reverseRetentionPlanStreamingRound()`，对 memory.js 应用逆向 hunk 后委托 `reverseKnowledgeHotWindowRound()` 继续旧链。
- `test/domain-storage/load-projection-baseline.js`：`loadProjectionBaseline()` 的重建链首改为调用新函数（早于 knowledge-hot-window 轮），并删除不再直接使用的旧 import。

静态验证（不跑测试）：`node --check` 通过；直接调用 `loadProjectionBaseline()` 重建三个文件，sha256 与 `PRE_CHANGE_TREE` 逐值相等：memory.js `2c1039ee…`、observation.js `d505692d…`、domain-storage.js `886aad88…`。窗口恢复后跑该文件应为 8/8。

### 9.3 中间运行（C4 版，sha `ebbc9790…`，已废弃，仅作历史证据）

| 检查 | 结果 | 耗时 | maxRSS |
| --- | --- | --- | --- |
| 大语料 40k | PASS 1/1 | 9.5 s（全量内 12.6 s） | 687 MiB |
| 差分 + 反例 | PASS 17/17 | 1.17 s | 106 MiB |
| 聚焦集 | PASS 75/75 | 1.9 s | 124 MiB |
| 全量 `NODE_OPTIONS=--max-old-space-size=4096 npm test` | 1451 tests / 1443 pass / 6 fail / 2 skipped | 52.0 s | 720 MiB |
| `npm run pack:check` | 16 ok + 1 预期 FAIL | 1.7 s | 106 MiB |

该轮六个 fail 的归类（历史结论，修复与最终数据见 9.4）：1 个是 `release-pin` 的未提交分发改动预期失败（同 pack:check）；5 个是上述 load-projection reversal 缺失（已在 9.2 修复）。40k 语料实测（C4 版）：retired 8000、consolidated 30200、aggregatedObservations 200、tombstones 4001、knowledge 8000→11401；ownership 覆盖 hot 3 / cache 10240 → postHot 208 / postCache 8192；14 个文件。

### 9.4 最终运行结果（最终 C1+C2 + Sol Loop r1 S1，2026-11-06）

冻结输入核对：`lib/memory.js` sha256 = `0fc7a14d32f1d56bca86e57b5abf6c5f166fb083a25c9bd14a7540d481d7dad7`（diff +178/−85，含 S1 修复），`lib/knowledge.js` sha256 = `9b9cebaf…`（与固定产物相同）。全程未改 `lib/`、未 commit。

reversal 静态确认：`loadProjectionBaseline()` 重建出的 `lib/dockyard-domain/memory.js` sha256 = `2c1039ee225ef14817031e70fb9a9683ca1bc8ded0aef93ba0aa949c95859c6a`（=`PRE_CHANGE_TREE`）；observation.js `d505692d…`、domain-storage.js `886aad88…` 同样相等（25 个 guarded hunk）。

| 步骤 | 命令 | 结果 | 耗时 | maxRSS |
| --- | --- | --- | --- | --- |
| 1 load-projection | `node --max-old-space-size=4096 --test test/domain-storage/load-projection-equivalence.test.js` | **PASS 8/8** | 4.60 s | — |
| 2a 差分 + 反例 | `--test retention-plan-equivalence-v021.test.mjs retention-plan-streaming-safety.test.mjs` | **PASS 18/18**（含 S1 用例） | 1.20 s | 105 MiB |
| 2b 大语料 40k | `--test retention-plan-streaming-safety-large.test.mjs` | **PASS 1/1** | 9.66 s | 675 MiB |
| 3 聚焦集 | 9 个文件（含 implementer 的 `retention-plan-streaming.test.mjs` 7 tests） | **PASS 75/75** | 1.94 s | 113 MiB |
| 4 全量回归 | `NODE_OPTIONS=--max-old-space-size=4096 npm test` | **1452 tests / 1449 pass / 1 fail / 2 skipped** | 54.9 s | 734 MiB |
| 5 分发检查 | `npm run pack:check` | **16 ok + 1 预期 FAIL** | 1.72 s | 103 MiB |

S1 用例实测：固定点与候选的 dryRun 与真实 compact 都抛 `TypeError: (previous.recordIds ?? []) is not iterable`（name/message 相同），失败的 dryRun 与 compact 前后全树字节不变、两侧一致——即 dryRun 不再报告写路径执行不了的 plan、也不再吞掉真实 compact 的异常。

全量唯一的 fail 与 pack:check 唯一的 FAIL 是同一项、同一原因（设计内预期）：`this tree is the pinned release, or a committed successor of it`，`this tree ships uncommitted changes`（tree content `857b64293703ac16cb2bf115efec5c6707c911395a7fd1433c84fdda8734f048`，HEAD/pin `bed2dd8b529e9c2270ab57c051e9ac118c57ea0d1c0533496e60d1b96d12d382`，点名 `lib/dockyard-domain/memory.js`）。除此之外全量为 **0 real fail**；2 个 skipped 是既有 Cordis 4.1 模块未安装的 skip。pack:check 其余 16 项全过（tarball 二次打包字节一致、条目集合、模式、无 home/凭据、lockfile、验收证据、新增宿主、固定点自述、固定产物字节、版本语法、无 publishConfig、README/COMPATIBILITY、README 版本、CHANGELOG、安装/诊断/升级/回滚/卸载、bin 入口）。

40k 语料实测（C1+C2+S1）：retired 8000、consolidated 30200、aggregatedObservations 200、tombstones 4001、knowledge 8000→11401；ownership 覆盖 hot 3 / cache 10240 → postHot 208 / postCache 8192；14 个文件。dryRun 零写入（state 端口 0 次 update/save + 全树 sha256 不变）、plan 无借用活行、后续写入+housekeeping+二次 compact、继承 `archiveReadCache` 的 successor 全部与固定点 0.2.1 基线一致。

**不提交说明**：本轮任务约束是只改文件、不 commit/push/合并/发布，因此不执行本地 commit；`release-pin` 与 `pack:check` 的同名检查保留为设计内预期失败（未提交分发文件），其余检查全部通过。按 `RELEASE.md` 重新固定属于外部写入，本轮不执行。

未覆盖边界不变，见第 7、10、11 节；其中第 10 节是“非 JSON 缓存窗口行”的越界注入边界（不可由生产路径到达），第 11 节是 40k 规模检查。

### 9.5 pack:check 明细

16 项 ok：tarball 二次打包字节一致、归档条目集合、权限、无 home 路径/凭据、lockfile、验收证据与固定内容、新增宿主、固定点自述、固定产物字节、版本语法、无 publishConfig、README/COMPATIBILITY 宿主、README 当前版本、CHANGELOG、README 安装/诊断/升级/回滚/卸载、bin 入口。

1 项预期 FAIL：`this tree is the pinned release, or a committed successor of it`，消息为 `this tree ships uncommitted changes`，并点名 `lib/dockyard-domain/memory.js: differs from the pinned artifact`。`npm test` 中的同名断言属于同一类（未提交分发文件），最终跑分时逐项确认。

### 9.6 Sol Loop r1 S1 差分回归用例

新增用例（`retention-plan-equivalence-v021.test.mjs` 的 “a tombstone merge that throws is evaluated identically by a dry run and a write”）：

- 语料 = 标准语料 + 一条带受控 `fingerprint: "fp:s1-tombstone-merge"` 的 terminal 行（会被退休）+ 一条持久化 tombstone，其 id 与前者将生成的 tombstone 相同、`recordIds` 为 JSON 对象（合法持久化值、不可迭代）；
- 固定点 0.2.1 与工作树分别在 dryRun 和真实 compact 上运行：要求两侧 **都抛同类 TypeError**（name/message 相同），dryRun 失败前后全树字节不变，compact 失败后字节也不变，且两侧语料字节一致；
- 该用例在 S1 修复前会抓住“候选 dryRun 不抛错、基线抛错”的差异；修复后 18/18（差分 15 + 反例 3）通过。最终运行结果见 9.4。

## 10. 非 JSON 缓存窗口行边界（C2 复核记录）

C2 的 `#historyPlanRows()` 对 archive 读缓存 window 行的所有权判断基于一条明确假设：该行是 `JSON.parse` 输出（注释原文：*Such a row is JSON.parse output, so reading it and reading its copy decide the same thing*）。按 Lead 要求用公开 `archiveReadCache` 注入越界行做了复核，结论如下。

### 10.1 热行的既有 clone-shape 契约没有移动

在无 archive tier 的内存 store 里放入携带嵌套 `Error`（自有可枚举属性 `recordId`）、`Date`、`Map` 的热行，再跑 dryRun + compact：

- 固定点基线与候选的 dryRun report、compact report、`fullSnapshot()` 摘要**完全相等**；
- 基线 `history()` 的 clone 会经 `structuredClone` 丢掉 `Error` 的自有属性，候选的 `#historyPlanRows()` 显式对 hot 行做同一份 clone，因此两边看到同一份“被削平”的 DTO。

也就是说 C2 对 hot 行的处理保持了既有 clone-shape 契约，不是越界注入问题。

### 10.2 注入非 JSON 的 cache window 行会让两侧分歧（越界用法）

对一个已预热 `gaps` 读缓存的实例，把 window 中 `ref-holder` 行替换为带嵌套 `Error`（自有可枚举 `recordId: "terminal-opaque"`）、`Date`、`Map`、`Set` 的对象，再跑 dryRun + compact：

| 侧 | dryRun `retired` | `terminal-opaque` 去向 |
| --- | --- | --- |
| 固定点 0.2.1（windows 行被 `history()` clone） | 15 | 退休，产生 tombstone |
| 候选（windows 行被 plan 直接读） | 14 | 因嵌套 `Error.recordId` 进入 references 而被保护、保留 |

两侧的 report、`fullSnapshot()` 摘要与 state/index/tombstone 字节因此不同。原因是 `structuredClone(Error)` 只保留 `name`/`message`/`cause`，丢掉自有可枚举属性；候选的 live read 看得到它，基线的 clone 看不到。`Date`/`Map`/`Set` 本身不改变决策（`structuredClone` 保留它们，JSON 序列化投影也一致）。

### 10.3 生产可达性判断

**结论：不可由生产路径到达，属于外部注入越界用法。** 依据：

1. window 行只由 `#scanArchiveRead` / `#archiveRowAt` 的 `JSON.parse` 产生（`#fillArchiveWindow` 对缺失位置的补读同样来自 archive 行）；
2. 状态文件经 `stateStore.load()` 的 `JSON.parse` 进入 `#data`，不会是 `Error` 实例；
3. `archiveReadCache` 构造参数在文档中的用途是 domain-storage 把前一个实例“已解析字节”的缓存交给 staged successor；前一个实例的 window 行同样来自 parse，因此继承链上仍是 JSON 形状；
4. 把同一注入行做 `JSON.parse(JSON.stringify(...))`（即 parse 能产生的形状，`Error` 的自有 `recordId` 变成普通自有属性）后，两侧 dryRun report、compact report、state 摘要、逐文件字节**完全一致**，且该行仍按 JSON 语义保护 `terminal-opaque`。

因此该分歧证明的是假设“load-bearing”（非 JSON 行会被 live read 看见），而不是候选破坏了 JSON 行上的 clone-shape 契约。风险边界：如果将来出现把非 JSON 值放入读缓存 window 的生产路径（例如直接缓存内存行而不是 parse 结果），这条假设就不再成立；本测试文件会把该分歧显式钉住（`test/dockyard-domain/retention-plan-streaming-safety.test.mjs` 的 “a non-JSON cache-window row is outside the documented archive-row contract”），届时需要重新评估 `#historyPlanRows()` 的 `windowRows` 判定。
## 11. 大规模所有权 / dryRun 检查（40,000 冷行）

文件：`test/dockyard-domain/retention-plan-streaming-safety-large.test.mjs`。语料是精确 40,000 条冷档案记录：observations 16,000（11,200 条可聚合 info + 3,200 条 knowledge-bearing error + 1,600 条无知识身份行）、knowledge 8,000、cycles 8,000、outcomes 4,000、promotions 4,000；state 文件只放少量与冷行同 id 的热行，所以热/cold 合并路径仍然参与，但冷行总数仍是 40,000（测试内断言）。固定时钟、两侧同一 home 顺序执行。

该文件 `archiveMaxBytes` 设为 4 MiB（小语料测试已经覆盖 4 KiB 目标下的 segment seal 行为）；否则 4 KiB 目标会在 40k 行上产生数千个 segment 文件，让测试时间被文件系统 I/O 而不是数据流支配。

每一步都跨侧比较：

1. `compact({dryRun:true})`：state 端口 `update`/`save` 调用增量为 0，全树逐文件 sha256 在 dryRun 前后不变；
2. 预热全部 collection 的 `archiveReadCache`，记录 compact 前 `#data` 热行与 cache window 行的对象身份，compact 后检查三类借用（热行对象被交回、cache 行变成热行、热行与 cache 行同一对象），并断言覆盖度非空（热行、cache 行、compact 后热行、compact 后 cache 行都 > 0）；
3. compact 后执行公开 `recordObservation` + `housekeeping()` + 第二次 compact，比较两次 report、state 摘要、逐文件字节；
4. 重启实例的 `historyWindow("observations",5)`、`historyScan("knowledge"/"cycles")`、`stats()`；
5. 用 `archiveReadCache: memory.archiveReadCache` 构造 successor 实例（模拟 domain-storage 的 staged working copy 继承缓存），`load()` 后跑 dryRun，要求其 report、读面与字节和固定点基线一致，且该 dryRun 零写入。

结果（耗时、峰值内存、是否通过）在 4b 回填。


## 12. 2026-11-07 隔离宿主补验

本轮执行 `NODE_OPTIONS=--max-old-space-size=4096 npm run acceptance:host -- --host <version> --out <evidence> --keep`，0.2.1-rc.2 与 0.2.2-rc.1 均 21 步通过（含 core-flow、重装、晋升、重启回滚、最终 doctor）。证据为 `docs/evidence/retention-plan-streaming-live-doctor-dsh-<version>.json`。每次使用 runner 新建的临时 runtime/home；未访问正式 DSH_HOME。tarball 内 memory.js 与工作树 SHA256 同为 `0fc7a14d32f1d56bca86e57b5abf6c5f166fb083a25c9bd14a7540d481d7dad7`。临时仅增强失败诊断，未触发失败，已撤回；未修改官方宿主或生产协议。旧 blocked 未复现，根因未知，旧失败证据仍保留，不能把这次通过解释为已修复历史根因。
