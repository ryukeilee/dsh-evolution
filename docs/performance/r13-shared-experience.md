# R13 共享经验 SQLite 与经验链路：长期运行与规模增长

受理标识：**DSH-EVOLUTION-PERF-R13-01**。基线 `origin/main` =
`a0380e5cf2761297ecd8ffe1c79e34865ac6baee`。分支 `t3/shared-experience-performance-1`。
实际模型与档位：`opencode-go/hy4-flash-free` High（`TEAM.md` 固定配置）。

本文是本机开发阶段实测数据，不是发布产物或宿主验收声明。**没有**改持久化格式、schema、
索引、`synchronous` / `busy_timeout`、窗口上限或任何授权/证据边界；**没有**引入跨调用缓存
派生值；**没有**触碰正式 `DSH_HOME`、正式经验库、`event-bridge.key` 或用户数据。

## 1. 结论摘要

实施两项「同一调用内重复工作消除」，均为可证明等价的改写：

| 改动 | 路径 | 收益（CPU 中位数） | 性质 |
| --- | --- | --- | --- |
| `appendBounded()` 把纯 `stableStringify(value)` 提到窗口扫描之外 | 热 key 的 canonical merge / 所有 `record*` 写入 | 热 key 写入 **−6.02%** | 同一事务内重复序列化消除 |
| `sortCandidates()` 的**惰性**排序键缓存 | `recall()` / `finalizeExperienceRecall()` 候选排序 | `recall` **−9.35%** | 同一比较排序中重复建键消除 |

其余调查方向均为 NO CHANGE，其中 `findConclusions()` 无匹配查结论是固有 O(N) 增长
（10k/30k/100k 约 29/84/280 ms CPU；更早一轮为 33/93/313 ms，量级一致），无新增
索引/schema 的等价改写不可得，见 §8。

## 2. 方法与口径

- 每个（轮次 × 侧面 × 工作负载 × 样本）起一个**独立 Node 子进程**；主指标
  `process.cpuUsage()`（user+system），墙钟、`maxRSS`、SQLite 主库字节为辅。
- A/B 顺序交替：`A,B → B,A → A,B`（3 轮），每轮每侧每工作负载 2 个样本；
  A = 基线提交（`git archive` 解出 + 同一份 `node_modules`），B = 当前工作树。
- 读路径夹具**只构建一次**并由两侧共享（同一份 SQLite 文件），因此时钟派生的
  `firstSeen`/`lastSeen` 及其对排序的影响在两侧完全相同；逐轮断言两侧输出指纹与
  `stats()` 相同，不同即让基准失败。
- 写路径 `writes` / `hot` 每样本用全新 `mkdtemp` 根；所有夹具都在 `os.tmpdir()` 下，
  脚本只删除自己创建的临时根，从不删除调用方传入的目录。
- 环境：Node `v26.13.1`、`darwin/arm64`（Apple M2，8 逻辑 CPU、16 GiB）、apfs、热页缓存。
  测量时机器上无其它基准/验收进程；未做其它平台、冷盘、真实宿主或真实用户数据测量。
- A/A 噪声：两侧加载**同一份代码**（见 `r13-shared-experience-aa.json`），用同样的交替
  顺序与独立进程，差值即纯调度/GC/文件系统噪声。未改动路径 `conclusions-nomatch`、
  `discover` 也是事实上的同码对照。

## 3. 根因与等价改写

### 3.1 `appendBounded()` 的重复序列化

`lib/dockyard-domain/knowledge.js` 的 `mergeKnowledgeEntry()` 对每条事件把多个有界窗口
（`sourceRefs` ≤32、`recentEvidence` ≤8、`trend.recent` ≤8、`relationRefs` ≤32、
`lineageRefs` / `recoveryRefs` ≤32）追加新值。原实现：

```js
if (value != null && !list.some((item) => stableStringify(item) === stableStringify(value))) list.push(clone(value));
```

`list.some()` 每遍历一个已有元素就重新 `stableStringify(value)` 一次——而 `value` 在整个
判定中不变，`stableStringify()` 是纯函数。一个已填满窗口的 hot key 每次 merge 因此重复
序列化约 32+8+8 = 48 次。

改动把该值提到循环外算一次：

```js
const serialized = stableStringify(value);
if (!list.some((item) => stableStringify(item) === serialized)) list.push(clone(value));
```

`stableStringify()` / `compactValue()` 规则、窗口上限、`clone()`、去重判定、持久化字节
全部不变；省的是同一纯函数的重复求值，不是任何历史状态或证据。

### 3.2 `sortCandidates()` 的重复排序键构建

`lib/experience-recall.js` 的 `compareCandidates()` 最后一个平分判定用
`compareOrderingKeys(left, right)`，而后者每次调用都重建两侧的 `orderingKey()`。
`orderingKey()` 把记录的约 20 个字段做长度前缀拼接，是相当昂贵的纯投影。对 M 条
同分/同时间的候选，排序要做 O(M log M) 次比较，每次都重建两把键——这是同一排序内
的重复工作。

改动引入**惰性、单次排序内**的键缓存：

```js
function sortCandidates(records) {
  const keys = new Map();
  const keyOf = (record) => {
    let key = keys.get(record);
    if (key === undefined) { key = orderingKey(record); keys.set(record, key); }
    return key;
  };
  return records.sort((left, right) => compareCandidates(left, right, keyOf));
}
```

关键性质：

- `keyOf` 只在比较真正走到最后平分判定时才调用；**0 或 1 个候选时排序零比较，
  建键数恒为 0**（与基线逐调用相同）。差分测试对此有显式断言。
- 比较器仍只有一份定义（`compareCandidates` 的第四参数缺省时走原来的
  `compareOrderingKeys`），没有第二套排序规则。
- `Array.sort()` 不改动元素，`orderingKey()` 是纯函数；缓存随该次排序返回即释放，
  不跨调用存活，不属于「用 O(1) 信号证明 O(历史) 派生值未变」的缓存类别。

## 4. 规模趋势（候选侧单进程，CPU ms）

原始数据：`docs/performance/r13-shared-experience-scale.json` 的 `curves` 字段，
每个样本为独立进程，`writes` 与 `hot` 计时窗口只含写入/merge。

| 工作负载 \ 规模 | 10k | 30k | 100k | 判定 |
| --- | ---: | ---: | ---: | --- |
| `conclusions-nomatch`（无匹配查结论） | 29.42 | 84.45 | 280.42 | **随历史近似线性增长**（固有 O(N)） |
| `read-control`（查到新结论） | 30.18 | 87.37 | 295.56 | 随历史增长 |
| `discover(window=500)` | 6.65 | 6.92 | 7.17 | **固定开销**（covering index count + 有界窗口） |
| `recall(window=2000)` | 66.28 | 66.63 | 68.12 | **固定开销**（仅看 outer SQL 窗口，不看历史总行数） |
| `writes`（N 个不同 target 的新事实） | 868.25 | 2630.82 | 9347.84 | 随写入条数线性（必要工作） |
| hot-key 单 key 500 / 2000 / 5000 次修订 | 142.31 | 423.24 | 981.75 | 随**单 key 修订数**线性（有界窗口维护，与历史总行数无关） |

表中最后一行的三列依次对应 500 / 2,000 / 5,000 次修订，不是 10k / 30k / 100k 行；
前两列（`10k` / `30k`）与其修订数刻度无关，只表示同一张表在不同总行数下的测量点。

`EXPLAIN QUERY PLAN` 证据：`SELECT count(*) FROM knowledge` 走
`knowledge_recent` covering index；`SELECT key,body ... WHERE instr(body,?)
ORDER BY revision DESC LIMIT ?` 走 `knowledge_recent` 索引按 revision 顺序取行，
匹配满窗口即停；但没有 scope/issueType/fingerprint 索引，无匹配时 `instr()` 必须
把每张 canonical body 读一遍。这是 §6 中 NO CHANGE 的根据。

## 5. 交替 A/B（3 轮 × 每侧 2 样本，CPU 中位数）

| 工作负载 | A 基线 ms | B 候选 ms | 相对 | 三对配对差 (B−A) ms |
| --- | ---: | ---: | ---: | --- |
| `recall` | 73.732 | 66.836 | **−9.35%** | −6.768 / −6.916 / −6.858 |
| `recall-none`（零候选） | 33.299 | 33.597 | +0.89%（噪声） | +0.713 / −0.001 / +0.298 |
| `recall-one`（单候选） | 34.022 | 34.096 | +0.22%（噪声） | +0.084 / −0.023 / +0.222 |
| `hot`（热 key 写入） | 248.421 | 233.465 | **−6.02%** | −12.828 / −16.697 / −11.181 |
| `conclusions-nomatch`（未改动对照） | 30.163 | 30.115 | −0.16% | +0.128 / +0.197 / −0.308 |
| `discover`（未改动对照） | 6.807 | 6.812 | +0.07% | +0.091 / +0.017 / −0.057 |

零/单候选两行在加入 `records.length < 2` 早退后由
`scripts/benchmarks/r13-sparse-ab.mjs` 单独复测（同 worker、共享夹具、交替顺序），
结果已合并进主 JSON；原始记录见 `r13-sparse-ab.json`。两条路径在候选侧**零建键、
零 Map 分配**，与基线走同一段代码（仅多一次长度判断），因此「严格不劣于基线」
是代码路径层面的结论，而不是统计上的「没有显著变慢」。

`recall` 与 `hot` 三对配对差**全部为负**，且 B 的最大值低于 A 的最小值，方向不依赖
采样顺序。两个未改动对照落在噪声内，确认没有系统性漂移。

**并发写者**（每档 2/4 个真实子进程共享一个 store，每进程 250 次写入，
`recordFailure` / `recordDegradation` 混合）：A/B 两侧 2 写者均 500/500 committed、
4 写者均 1000/1000 committed，`busy=0`、`other=0`。没有降低 `synchronous` 或
`busy_timeout`，没有合并事务边界；本项只证明没有可消除的重复等待，不声称吞吐收益。

## 6. A/A 噪声与正确性

### 6.1 A/A

`docs/performance/r13-shared-experience-aa.json`：两侧加载同一份代码，交替顺序、
独立进程，3 轮 × 每侧 2 样本。

| 工作负载 | A CPU ms | B CPU ms | 相对 | 逐对差 ms |
| --- | ---: | ---: | ---: | --- |
| `recall` | 74.023 | 73.953 | −0.10% | +0.409 / −0.071 / −0.682 |
| `hot` | 231.555 | 232.190 | +0.27% | +0.168 / +1.714 / +0.636 |

A/A 的绝对噪声底约 ±0.7 ms（recall）/ ±1.7 ms（hot）。热 key 的 −6.02% ≈ −15 ms
与 recall 的 −9.35% ≈ −6.9 ms 都远大于噪声；零/单候选的 +0.89% / +0.22%
（约 +0.3 / +0.07 ms）落在噪声内，且建键计数相等。

### 6.2 差分与反证

`test/r13-shared-experience-equivalence.test.mjs`（2 项，全部通过）：

1. **A 项**：从生产源码把 `appendBounded()` 反向变换回原实现（锚点唯一性断言），
   两侧对 90 个事件逐条 merge 同一 canonical row（填满所有有界窗口、含 `__proto__`
   自有键、重复回放），每步 `JSON.stringify` 逐字节相等；插桩计数证明候选建键/序列化
   次数严格少于基线；把提升值替换成常量后差分立即失败（反证）。
2. **B 项**：把 `sortCandidates()` 反向变换回 `records.sort(compareCandidates)`，两侧
   `finalizeExperienceRecall()` 与 `collectKnowledgeExperience()` 完整输出逐字节相等
   （含平分、extended-year ISO、不同 exact/score/recency 分支）；平局语料下候选建键数
   严格少于基线；**0/1 候选两侧建键数均为 0**（惰性证明）；把 `keyOf` 换成恒返回
   `"stale"` 后差分立即失败（反证）。

聚焦测试：受影响套件共 **295 项全部通过**（214 + 81，0 失败 0 跳过），含
`shared-experience*` / `experience-recall` / `experience-plan` / `experience-degradation` /
`experience-attribution` / `knowledge-*` / 特殊键持久化 / 轻量经验入口等。
未跑全量 `npm test`（由 Lead 统一执行）；未跑真实宿主验收、`pack:check` 与发布。

## 7. 适用范围、负面取舍与收益边界

- **收益来源**：`appendBounded` 只在窗口已填充时有效，随单 key 的重复事件数增长；
  `sortCandidates` 只在候选同分/同时间走到最后平分判定时有效，随候选数增长。
  两者都不改 `synchronous`、WAL、busy timeout、schema、去重/冲突/授权语义。
- **成本/取舍**：`appendBounded` 的 `stableStringify(value)` 从每元素一次变成一次；
  对带状态化 getter 的敌意输入，getter 被调用次数会变（生产路径的值都由
  `normalizeKnowledgeEvent` 生成的普通字符串/对象，差分覆盖了该边界）。
  `sortCandidates` 每次排序多一个短命 `Map`（与走到平分的记录数同阶），不跨调用。
- **零/单候选严格不劣**：`sortCandidates()` 对 `records.length < 2` 直接早退，不分配
  `Map`、不建 `keyOf` 闭包、不调用 `orderingKey()`；差分断言两侧建键计数均为 0。
  A/B 为 +0.89% / +0.22%（约 +0.3 / +0.07 ms，落在 A/A 噪声内）。没有把键计算
  变成对所有候选的无条件预计算。
- **可测边界**：只测 Node 26 / darwin-arm64 / 热页缓存 / 合成夹具；`maxRSS` 是整进程
  高水位，不主张内存下降；并发只有 2/4 写者、短事务、无慢盘。
- **不削弱任何不变量**：没有缓存 O(历史) 派生值、没有跳过校验或缩短窗口、没有新增索引。

## 8. NO CHANGE 与被否决项

| 方向 | 证据 | 结论 |
| --- | --- | --- |
| `findConclusions()` 无匹配查结论的 `instr()` 全表扫描 | 29/84/280 ms @10k/30k/100k（更早一轮 33/93/313 ms），随历史近似线性；`EXPLAIN QUERY PLAN` 显示无 scope 索引，必须逐行读 body。加 JSON1 表达式索引需改 schema 并给既有库补建索引，且 `instr` 与 `json_extract` 对畸形 body 不等价。 | **NO CHANGE**：显式动作读路径；固有 O(N) 增长，无安全等价改写 |
| `PRAGMA synchronous=NORMAL` / 去掉 `busy_timeout` / 调 `cache_size` | 前者削弱崩溃恢复；2 s busy 是慢盘四进程饥饿的既有修复；调缓存无 A/B 证据 | **NO CHANGE**（硬约束） |
| 迁移 CLI 三次事件扫描合并 | 一次性离线命令；合并会改变备份验证与事务内自证顺序 | **NO CHANGE** |
| `detectDegradation()` 的 2050 行 slice 索引循环 | R12 实测绝对收益约 13 µs/次，低于可维护性门槛；本轮无新证据 | **NO CHANGE** |
| collector LRU / streak 重构 | `outcomes` 已是 O(1) touch、上限 256；`counted`/`executions` 是 WeakMap/WeakSet | **NO CHANGE**：无冗余工作 |
| 缩短 `recall` / `discover` 窗口、`stats()` 近似或缓存 | 违反硬约束且属于被撤回的「O(1) 信号证明 O(历史) 未变」类别 | **NO CHANGE** |

## 9. 复现命令

```sh
# 差分与反证（含零/单候选零建键断言）
NODE_OPTIONS=--max-old-space-size=4096 node --test test/r13-shared-experience-equivalence.test.mjs

# 完整 A/B + 规模曲线 + 并发（3 轮 × 2 样本，独立于基线提交）
NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/r13-shared-experience-scale.mjs \
  run --base-commit a0380e5cf2761297ecd8ffe1c79e34865ac6baee \
  --rounds 3 --samples 2 --out docs/performance/r13-shared-experience-scale.json

# A/A 噪声（两侧同一份代码）
NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/r13-aa-noise.mjs \
  --rounds 3 --samples 2 --out docs/performance/r13-shared-experience-aa.json

# 零/单候选稀疏路径复测（早退之后）
R13_BASE_LIB=<baseline-tree>/lib NODE_OPTIONS=--max-old-space-size=4096 \
  node scripts/benchmarks/r13-sparse-ab.mjs \
  --base-lib <baseline-tree>/lib --out docs/performance/r13-sparse-ab.json

# 受影响聚焦回归
NODE_OPTIONS=--max-old-space-size=4096 node --test \
  test/shared-experience.test.mjs test/shared-experience-schema-v2.test.mjs \
  test/shared-experience-migration.test.mjs test/shared-experience-prepared-equivalence.test.mjs \
  test/shared-experience-conclusion.test.mjs test/experience-recall.test.mjs \
  test/experience-plan.test.mjs test/experience-degradation.test.mjs \
  test/experience-attribution.test.mjs test/domain-input-knowledge-accumulator.test.mjs \
  test/domain-storage/knowledge-hot-window.test.mjs \
  test/dockyard-domain/knowledge-identity-equivalence.test.js \
  test/dockyard-domain/knowledge-proto-key-identity.test.js
```

基准脚本从不删除调用方通过 `--fixture` / `--base-tree` 传入的目录，只清理自己创建的
mkdtemp 根；原始逐轮逐样本数据（CPU/墙钟/maxRSS/落盘字节/stats/指纹）保存在上述 JSON。
