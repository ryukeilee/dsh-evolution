# R13 开放性性能研究：长期运行与规模增长（2026-11-25）

受理标识：**DSH-EVOLUTION-PERF-R13-01**。基线 `origin/main` = `a0380e5`
（R12 合并后的 `a0380e5cf2761297ecd8ffe1c79e34865ac6baee`）。集成分支
`t3/long-run-performance-study`。

本轮主题是**长期运行下的规模增长**：在四个子系统里寻找「同一次调用内可证明等价的重复工作」，
并量化固定开销、合理增长与可消除增长的分界。约束沿用 R12 与仓库规则：不引入跨调用缓存、
不用 O(1) 元数据信号证明 O(历史) 状态未变、不缩小检索窗口、不削弱认证/防篡改/证据边界。

结论按子系统分别记录：

| 子系统 | 文档 | 结论 | 集成提交 |
| --- | --- | --- | --- |
| 领域存储 / 事件桥 / 冷档案 / 数据生命周期 | [r13-event-log-prune.md](r13-event-log-prune.md) | **接受 1 项**（`planLogPrune` 复用已认证 envelope） | `c47a17e` |
| 共享经验 SQLite 与经验链路 | [r13-shared-experience.md](r13-shared-experience.md) | **接受 2 项**（`appendBounded` 提纯函数、`sortCandidates` 惰性键缓存） | `e4913e8` |
| 跨入口 / 诊断 / 统一审查 / 用量 / 桌面任务通道 | [r13-cross-entry-audit.md](r13-cross-entry-audit.md) | **NO CHANGE**（无可消除增长） | `a549110` |
| 完整进化闭环的插件侧耗时构成 | [r13-loop-composition.md](r13-loop-composition.md) | **NO CHANGE**（构成量化，无新候选） | `30b25b8` |

本文只做跨子系统汇总，不重复各文档的完整论证；根因源码位置、逐样本原始数据与复现细节以
对应子系统文档为准。环境：Node `v26.13.1`、`darwin/arm64`（Apple M2）、8 逻辑 CPU、16 GiB、
APFS、热页缓存；全部夹具在隔离临时目录与合成数据根中生成，未触碰正式 `DSH_HOME`、正式
经验库、`event-bridge.key` 或用户数据，未改官方 DSH 源码。

实际模型与档位：`opencode-go/deepseek-v4.1-flash` Low（`TEAM.md` 固定配置）。

## 1. 三项接受改动

三项都是「同一调用内、同一批字节/同一纯函数」的重复工作消除，不改持久化格式、协议、
窗口上限或认证次数。

### 1.1 事件桥回收规划：`planLogPrune()` 的重复解析（`c47a17e`）

**根因**：`lib/event-log-checkpoint.js` 的 `planLogPrune()` 先在认证循环里对每一行做
`toString('utf8')` → `JSON.parse()` → HMAC 验签，算出 `boundary` 后又对前 `boundary` 行
**再次**解码 + `JSON.parse()`，只为投影 `prunable` 的 `{eventId, mac}`。这两批行全部落在
认证循环已成功处理的连续前缀内，同一字节被解析两遍。

**改动**：在认证循环里保存已通过的 `{eventId, mac}`（`absorbedPairs`，上界为 `boundary`），
`prunable` 直接取用；计划输出（`prior` / `tail` 摘要、`prefixBytes`、`prunable`、
`boundaryRecords`）逐字节不变，认证次数、floor、marker 剪裁与提交顺序均未改动。

**A/B（3 轮 × 每侧 5 样本，CPU ms 中位数，A→B→A2 交替）**：

| 事件数 | 轮 0 A / B / A2 | 轮 1 A / B / A2 | 轮 2 A / B / A2 |
| ---: | --- | --- | --- |
| 2,000 | 307.2 / 253.1 / 271.7 | 274.1 / 253.2 / 274.7 | 271.0 / 252.8 / 272.3 |
| 20,000 | 864.3 / 771.3 / 971.1 | 862.4 / 787.3 / 866.0 | 864.0 / 745.1 / 873.2 |
| 100,000 | 1859.0 / 1623.2 / 1870.9 | 1874.8 / 1606.2 / 1874.1 | 1848.9 / 1493.2 / 1863.3 |

| 事件数 | A CPU | B CPU | 相对 | A/A 噪声 | 每次调用 A → B | 净省/调用 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2,000 | 271.81 ms | 252.35 ms | **−7.16%** | +0.09% | 9.06 → 8.41 ms | 0.65 ms |
| 20,000 | 860.51 ms | 763.58 ms | **−11.26%** | +1.86% | 86.05 → 76.36 ms | 9.69 ms |
| 100,000 | 1855.87 ms | 1600.96 ms | **−13.74%** | +0.56% | 463.97 → 400.24 ms | 63.73 ms |

三档全部轮次 B−A 为负，B 的最大值在各档都低于 A 的最小值；唯一明显离群是 20,000 档第 0 轮
A2 = 971.1 ms（+12%），按噪声处理、不计入收益。墙钟与 CPU 同向（2,000: 240.6 → 212.0 ms；
20,000: 795.5 → 702.6 ms；100,000: 1737.7 → 1512.0 ms），但未单独用来主张收益。`maxRSS`
是整进程高水位且三档方向不一致，不主张内存下降。

**差分与反证**：`test/domain-storage/log-prune-pair-reuse.test.js` 5/5 通过，含反向变换
逐字段对拍、`JSON.parse` 调用计数反证（释放版恰好多 `prunable.length` 次）、把复用值改成
陈旧 eventId 后差分立即失败、torn tail 与 writer/key 身份边界。功能回归
`test/domain-storage/` 218/218、checkpoint 相关 24/24。

**范围与代价**：收益只在显式 `reclaim()` 的日志分支（低频、owner 授权）出现，不是
`flush()` 热路径；固定开销（逐字节扫描、三次整段摘要、checkpoint 与事务 I/O）与认证下界
不变。代价是认证循环多一次稀疏数组写入与事件对象引用保留，量级与原本 `pairs` 相同。
只测 Node 26 / darwin-arm64 / 热页缓存 / 单进程 `planLogPrune`；端到端回收还包含
`prefixEvidence()` 第二次验签、外部化、事务与 fsync，故函数级百分比不外推为端到端收益。

### 1.2 经验写入：`appendBounded()` 的重复序列化（`e4913e8`）

**根因**：`lib/dockyard-domain/knowledge.js` 的 `mergeKnowledgeEntry()` 对每个有界窗口
（`sourceRefs` ≤32、`recentEvidence` ≤8、`trend.recent` ≤8、`relationRefs` ≤32、
`lineageRefs` / `recoveryRefs` ≤32）做去重：
`list.some((item) => stableStringify(item) === stableStringify(value))`。`value` 在整个
判定中不变，`stableStringify()` 是纯函数，已填满窗口的热 key 每次 merge 重复序列化约
32+8+8 = 48 次。

**改动**：把 `stableStringify(value)` 提到循环外算一次。序列化规则、窗口上限、`clone()`、
去重判定与持久化字节全部不变。

**A/B（3 轮 × 每侧 2 样本）**：热 key 写入 248.421 → 233.465 ms（**−6.02%**），三对配对差
−12.828 / −16.697 / −11.181 ms，全部为负；A/A 对照 +0.27%（231.555 → 232.190 ms），
绝对噪声底约 ±1.7 ms。

**差分与反证**：`test/r13-shared-experience-equivalence.test.mjs` A 项对 90 个事件逐步
merge 同一 canonical row（填满所有窗口、含 `__proto__` 自有键、重复回放），每步
`JSON.stringify` 逐字节相等；插桩证明建键/序列化次数严格减少；把提升值替换成常量后差分
立即失败。

### 1.3 经验召回：`sortCandidates()` 的重复排序键（`e4913e8`）

**根因**：`lib/experience-recall.js` 的 `compareCandidates()` 在最后平分判定调用
`compareOrderingKeys()`，后者每次比较都重建两侧约 20 字段拼接的 `orderingKey()`。对 M 条
同分候选，排序的 O(M log M) 次比较反复重建同一批键。

**改动**：`sortCandidates()` 引入**单次排序内**的惰性 `Map` 键缓存；比较器仍只有一份定义
（`compareCandidates` 缺省第四参数时走原路径）。`records.length < 2` 直接早退，不分配
`Map`、不建闭包、不调用 `orderingKey()`。

**A/B（3 轮 × 每侧 2 样本）**：`recall` 73.732 → 66.836 ms（**−9.35%**），三对配对差
−6.768 / −6.916 / −6.858 ms，全部为负；A/A 对照 −0.10%（74.023 → 73.953 ms），绝对噪声底
约 ±0.7 ms。未改动对照落在噪声内：`recall-none` +0.89%、`recall-one` +0.22%、
`conclusions-nomatch` −0.16%、`discover` +0.07%。

**差分与反证**：同一测试 B 项把 `sortCandidates()` 反向变换回
`records.sort(compareCandidates)`，两侧 `finalizeExperienceRecall()` 与
`collectKnowledgeExperience()` 完整输出逐字节相等（含平分、extended-year ISO、不同
exact/score/recency 分支）；平局语料下候选建键数严格少于基线，0/1 候选两侧建键数均为 0；
把 `keyOf` 换成恒返回 `"stale"` 后差分立即失败。

**范围与代价**：两项收益分别随「单 key 重复事件数」与「同分候选数」增长，不发生在零/单
候选或窗口未满时；不改 `synchronous`、WAL、`busy_timeout`、schema、去重/冲突/授权语义。
代价是每次排序一个短命 `Map`（与走到平分的记录数同阶），不跨调用。

**并发对照**：2/4 个真实子进程共享同一 store 时，A/B 两侧 2 写者均 500/500 committed、
4 写者均 1000/1000 committed，`busy=0`、`other=0`；只证明没有可消除的重复等待，不主张
吞吐收益。

## 2. 完整闭环的插件侧耗时构成（`30b25b8`）

测的是 `plan → propose → probe baseline → trial → probe candidate → measure → promote
（停在待确认）→ revert` 中**插件自己花的 CPU**，不是真实会话墙钟：宿主工具执行、Include
挂载、模型推理与网络等待均不在样本内（`probe` 由 fake 管道即时返回）。因此本文百分比只
用于判断插件侧是否还有可消除的重复工作。

每格为样本中位数 CPU ms（占整次闭环比例）：

| 历史结论数 | 闭环总计 | plan | propose | probe baseline | trial | probe candidate | measure | promote（待确认） | revert |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 4.54 ms | 0.51 (11.2%) | 0.46 (10.2%) | 0.27 (6.0%) | 0.56 (12.4%) | 0.16 (3.6%) | 0.14 (3.2%) | 0.02 (0.5%) | 2.57 (56.6%) |
| 200 | 15.23 ms | 7.77 (51.0%) | 3.69 (24.2%) | 0.27 (1.7%) | 0.66 (4.3%) | 0.16 (1.1%) | 0.12 (0.8%) | 0.02 (0.2%) | 2.81 (18.5%) |
| 2,000 | 83.37 ms | 38.48 (46.2%) | 28.00 (33.6%) | 0.40 (0.5%) | 1.12 (1.3%) | 0.16 (0.2%) | 0.29 (0.3%) | 0.03 (0.0%) | 11.81 (14.2%) |
| 5,000 | 95.91 ms | 35.64 (37.2%) | 39.97 (41.7%) | 0.41 (0.4%) | 1.23 (1.3%) | 0.18 (0.2%) | 0.22 (0.2%) | 0.03 (0.0%) | 20.24 (21.1%) |

**固定开销**：`probe` 两侧合计约 0.2–0.6 ms、`trial` 0.6–1.2 ms、`measure` 0.1–0.3 ms、
`promote` 的只读门禁 0.03 ms，均不随历史变化；`revert` 中约 2.5–4 ms 的归档渲染 +
事件桥写入 + fsync 也是固定成本（5,000 档 `revert` 减去两次存储调用后余约 3.6 ms）。

**有界增长**：`plan` 的两个读窗口（`discover` 500、`recall` 2,000 行）填满后不再随总行数
增长，2,000 → 5,000 档从 38.48 降到 35.64 ms（噪声内）；另有约 13–16 ms 是对 500 条候选
规范化、分组与评分的有界纯计算。

**无界增长**：`findConclusions()` 是无 scope 列可用的 `instr(body, ?)` 全表扫描，每次闭环
调用两次（`propose` 的重复假设拦截、`revert` 的结论发布前查询），从 0.6 ms（200 行）线性
增长到 16.4 ms（5,000 行），5,000 档两次合计 32.7 ms、约占整次闭环 34%。

**序列化与深拷贝**（2,000 档，3 个插桩样本）：整次闭环 9 次 `structuredClone` 合计
0.04 ms、`JSON.stringify` 783 次合计 0.30 ms、`JSON.parse` 5,006 次合计 18.07 ms
（21.6%）。解析几乎全部来自 `recall` 的 2,000 行窗口与 `discover` 的 500 行窗口 + 计划器
投影，属按窗口读取正文的固有成本；插桩样本闭环 83.56 ms 与非插桩 83.37 ms 基本一致。

**结论 NO CHANGE 的依据**：`propose` 与 `revert` 共用 `findConclusions` 结果、给 scope 加
JSON1 表达式索引、`plan` 复用 `discover` 的 500 行替代 `recall` 的 2,000 行、缩短窗口、
惰性/分批 `plan` 评分，五项均被否决（理由见 §4）。

## 3. 规模趋势汇总

三档以上量级的观察，按「固定开销 / 合理增长 / 可消除增长」分类。所有数字来自各子系统
报告的实测表；不同子系统的计量单位不同，横向数值不可直接比较。

| 子系统 | 量级 | 指标 | 数值 | 分类 |
| --- | --- | --- | ---: | --- |
| 事件桥回收规划 | 2k / 20k / 100k 事件 | 每次 `planLogPrune` CPU（B） | 8.41 / 76.36 / 400.24 ms | 合理增长（认证下界）；重复解析已消除 |
| 共享经验 | 10k / 30k / 100k 行 | `conclusions-nomatch` | 29.42 / 84.45 / 280.42 ms | **无界增长**（固有 `instr` 全表扫描） |
| 共享经验 | 10k / 30k / 100k 行 | `read-control` | 30.18 / 87.37 / 295.56 ms | 随历史增长（同一扫描路径） |
| 共享经验 | 10k / 30k / 100k 行 | `discover(window=500)` | 6.65 / 6.92 / 7.17 ms | **固定开销**（covering index + 有界窗口） |
| 共享经验 | 10k / 30k / 100k 行 | `recall(window=2000)` | 66.28 / 66.63 / 68.12 ms | **固定开销**（只看窗口，不看总行数） |
| 共享经验 | 10k / 30k / 100k 行 | `writes`（N 条新事实） | 868.25 / 2630.82 / 9347.84 ms | 随写入条数线性（必要工作） |
| 共享经验 | 500 / 2000 / 5000 次修订 | 单热 key merge | 142.31 / 423.24 / 981.75 ms | 随单 key 修订数线性（有界窗口维护） |
| 跨入口索引 | 50 / 500 / 5k / 20k 记录 | `indexRead` | 0.22 / 6.33 / 46.55 / 225.56 ms | 合理增长（parse + 逐记录校验 + 整文件 sha256） |
| 跨入口索引 | 50 / 500 / 5k / 20k 记录 | `sourceVerify` | 0.12 / 61.66 / 635.63 / 2856.67 ms | 合理增长（防篡改，每记录恰好一次） |
| 跨入口索引 | 50 / 500 / 5k / 20k 记录 | `usageRead` | 0.21 / 0.22 / 0.22 / 0.24 ms | **固定开销**（stat + readFile + parse 小投影） |
| 桌面兜底重扫 | 100 / 1000 / 5000 任务 | 每次 `rescan` | 2.24 / 10.54 / 45.54 ms | 随 inbox 线性（唯一兜底） |
| 完整闭环 | 0 / 200 / 2k / 5k 行 | 闭环总计 | 4.54 / 15.23 / 83.37 / 95.91 ms | 前段有界 + `findConclusions` 无界 |

`indexRead` 的 O(字节) 分解（CPU ms 中位数，50 / 500 / 5k / 20k）：读文件
0.056 / 0.158 / 2.019 / 5.420、`JSON.parse` 0.113 / 1.798 / 9.906 / 38.268、
`sha256(bytes)` 0.051 / 1.172 / 3.958 / 13.264、archive `readdir+filter+sort`
0.008 / 0.044 / 0.936 / 2.418。20k 档 sha256 仅占 `indexRead` 约 6%，parse 约 38 ms，
其余约 170 ms 是逐记录校验。

**可消除增长**：本轮只在两个函数内找到并消除了 O(待处理记录数) 的重复解析/序列化
（§1.1、§1.2/§1.3）；跨入口子系统四档均未发现同一调用内的第二次扫描。

## 4. 被否决方向与依据

### 4.1 本轮否决 / NO CHANGE

| 方向 | 上界收益 | 依据 | 结论 |
| --- | ---: | --- | --- |
| `readSharedIndex` 跳过 `sha256(bytes)` | 20k 档约 13.26 ms（`indexRead` ≈6%） | `index.digest` 严格等于 `sha256(published.json)`；宿主验收与跨入口探针依赖该等式判断索引篡改 | **否决**：认证契约 |
| `diagnoseSharing` 跳过逐记录 `readPromotedPlugin` | 20k 档最多约 2,856 ms（doctor ≈99%） | 追加 `// tampered` 后当前树 `blocked`/`source-digest-mismatch`，跳过校验的补丁树 `degraded`/`source=verified`，doctor 指纹不等 | **否决**：防篡改边界 |
| `review` 复用 doctor 产物 / 放开 50 条上限 | 无同调用路径 | 两个独立工具无共享调用点；放开上限只增成本 | **否决** |
| 跨入口缓存已解析索引 / 增量认证 | 每入口约 46 ms@5k、225 ms@20k | 需「使用前证明文件未变」的第二协议；dev/ino/size/mtime 无法检测同长原地改写 | **否决**：O(1) 信号证明 O(历史) |
| Desktop 1500 ms 重扫降频 / 移除 | 2.24–45.54 ms/次 | watcher `persistent:false`，重扫是漏事件唯一兜底；降频推迟拾取、移除漏任务 | **否决**：削弱可靠性 |
| `registration.js` 每工具 finally flush 改频率 | 常数成本 | 改变事件认证/去重时机；R12 已否决 agent/pre-step flush 频率 | **否决**（R12 已否决） |
| `propose` 与 `revert` 共用一次 `findConclusions` | 5k 档约 16 ms/闭环 | 两次调用之间隔着真实 `trial`/`probe`/`revert` 写入，另一入口可能追加同一 target；复用会用旧快照决定是否发布结论 | **否决**：O(1) 缓存近似 O(历史) |
| 给 `findConclusions` 的 scope 加 JSON1 表达式索引/列 | 100k 档约 280 ms | 需 schema 变更与既有库迁移；`json_extract` 与 `instr` 对畸形 body 不完全等价 | **否决**（边界禁止） |
| `plan` 复用 `discover` 的 500 行替代 `recall` 的 2,000 行 | 2k 档约 19 ms | 两个窗口上限与过滤条件不同，复用会改变证据投影；R12 C2 已否决同类 | **否决** |
| 缩短 `recall` / `discover` 窗口 | 与窗口成正比 | 直接缩小检索范围，可能漏掉窗口外历史 | **否决**：任务禁止 |
| 惰性 / 分批 `plan` 评分 | 约 13–16 ms（有界） | 有界开销；改动会破坏 `evolution_plan` 同步返回契约 | **NO CHANGE** |

### 4.2 子系统内 NO CHANGE（源码检查为主）

| 方向 | 结论 | 依据 |
| --- | --- | --- |
| 事件桥多入口并发写者（2/4 writer） | NO CHANGE | `<log>.append.lock` 跨进程互斥，锁内只追加一条已签名信封，无可消重复序列化；陈旧 owner 回收属不变量 13 |
| 冷档案 `history()` / `historyView()` / retention plan | NO CHANGE | 目录项按 `dev+ino+size+mtimeNs` 复核、派生键已 memo，同一次调用内无重复扫描同段字节 |
| 启动回放 checkpoint / floor / pending 恢复 | NO CHANGE | 增长读里已 fork HMAC 避免前缀重哈希；floor 与 replay 的协议证明缺口见 `axis-steady-history.md` §6 |
| 事件桥日志行 1 MiB 分块扫描 | NO CHANGE | 已分块、digest-only 路径跳过切行；`whole-log 1→4 MiB chunk` 是已撤回方向 |
| 知识身份与聚合（`__proto__` 自有键） | NO CHANGE | `knowledgeIdentity` 已有 canonical 前缀短路；`isSensitiveKey` 有界记忆已在 R12 实施 |
| `PRAGMA synchronous` / `busy_timeout` / `cache_size` | NO CHANGE（硬约束） | 分别削弱崩溃恢复、四进程饥饿修复与无 A/B 证据的启发式调参 |
| 迁移 CLI 三次事件扫描合并 | NO CHANGE | 一次性离线命令；合并会改变备份验证与事务内自证顺序 |
| `detectDegradation()` 2050 行 slice 索引循环 | NO CHANGE | R12 实测约 13 µs/次，低于可维护性门槛 |
| collector LRU / streak 重构 | NO CHANGE | `outcomes` 已 O(1) touch、上限 256；`counted`/`executions` 为 WeakMap/WeakSet |
| `lib/index.js` 启动顺序「去重」 | NO CHANGE | `resolveEvolutionPaths()` 为纯路径计算、无 I/O；不存在重复磁盘读取 |

### 4.3 R12 已否决、本轮不重提

稳态 `flush()` 复用 `appliedDigest` 并跳过日志前缀校验；`synchronous`/`busy_timeout`/
`cache_size` 调参；`findConclusions`/`discover` 加索引；迁移 CLI 三次扫描合并；启动惰性
加载 `diagnostics.js`；`agent/pre-step` flush 改频率；桌面 1500 ms 重扫降频；canary 每次
观测跳过事件桥全量验签；晋升链路两次 `refresh()`/两次门禁/两次证据读取；以及 PTC 正则、
canary 描述符二次序列化、观察者表剪枝、`detectDegradation` 索引循环、collector LRU 等
微项。本轮未重新提出这些方向，也未重测已撤回的 `whole-log 4 MiB chunk`。

## 5. 剩余瓶颈（完整性与协议下界）

- **`findConclusions()` 的 O(历史) 扫描**：`instr(body, ?)` 无 scope 索引，10k/30k/100k
  约 29/84/280 ms；完整闭环里每次调用两次，5k 档已占闭环约 34%。它是显式动作路径
  （`evolution_propose` / 结论发布），不在 `agent/pre-step` 热路径；真实安装在 10k 行以上
  会先感知到它。
- **事件桥稳态同步**：每次 `flush()` 完整读取日志前缀并做带密钥 HMAC，同时序列化整张已
  提交标记表后 SHA-256；R12 实测 100k 历史约 61 ms/次（`axis-steady-history.md`）。认证与
  检查点绑定的下界。
- **canary 证据**：每次观测全量读 + 验签事件桥，R12 实测约 7.8 ms/2,000 事件；证据保真
  要求。
- **跨入口启动认证**：每个入口独立读取并校验同一份索引与源码（`indexRead` 225.56 ms@20k、
  `sourceVerify` 2,856.67 ms@20k）；跨进程共享解析结果需要新的「使用前证明未变」协议。
- **诊断防篡改**：doctor 在 20k 档约 2,838 ms，几乎全部是逐记录 `lstat` + `readFile` +
  sha256。
- **归档事务**：R12 记录 256 段负载中约 84% 延迟是 `fsync`，复制约 7.6%。
- **桌面兜底重扫**：显式启用时随 inbox 线性（5,000 任务 45.54 ms/次，按 1500 ms 间隔约
  1,821.7 ms CPU/分钟）；这是 watcher 漏事件时的唯一兜底。

## 6. 验证状态

只列本次实际执行过的检查。

| 子系统 | 已执行 | 结果 |
| --- | --- | --- |
| 事件桥回收规划 | 差分（反向对拍 + 调用计数 + 变异 + 边界） | 5/5 通过 |
| | `test/domain-storage/` | 218/218 通过 |
| | checkpoint / keyed-digest / read-chunks | 24/24 通过 |
| | 三档 A/B | 全部轮次 B−A 为负，`allFingerprintsEqual: true` |
| 共享经验 | `test/r13-shared-experience-equivalence.test.mjs` | 2 项全部通过 |
| | 受影响聚焦套件（214 + 81） | 295 项全部通过，0 失败 0 跳过 |
| | A/B 与 A/A | 两侧输出指纹与 `stats()` 相同 |
| | 2/4 写者并发 | 500/500 与 1000/1000 committed，`busy=0`、`other=0` |
| 跨入口 / 诊断 / 桌面 | 四档交替 A/A | 全部 `allFingerprintsEqual: true` |
| | 篡改反证 | 当前树 `blocked`、补丁树 `degraded`，指纹不等 |
| | 13 个聚焦套件 | 328/328 通过，0 失败 0 跳过 |
| 完整闭环 | 四档阶段构成 + 2,000 档插桩副本 | 已测，样本数与插图见 JSON |
| 全量回归 | `NODE_OPTIONS=--max-old-space-size=4096 npm test` | **由 Lead 在集成后执行，结果记录在 PR 交付说明** |
| 打包检查 | `npm run pack:check` | **由 Lead 在集成后执行，结果记录在 PR 交付说明** |

未执行、因而不在本文主张范围：真实宿主验收、`pack:check --release`、发布、Desktop 正式
环境、真实模型推理、冷盘、其它平台或其它 Node 版本。

## 7. 复现命令与产物路径

命令与各子系统文档一致；临时根统一用 `$TMPDIR` 代替报告中的绝对临时路径。产物路径均为
仓库相对路径。

```sh
# 事件桥回收规划：A/B（3 轮 × 每侧 5 样本）
NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/r13-log-prune.mjs \
  --base a0380e5cf2761297ecd8ffe1c79e34865ac6baee \
  --rounds 3 --samples 5 --sizes 2000,20000,100000 \
  --out docs/performance/r13-event-log-prune.json
NODE_OPTIONS=--max-old-space-size=4096 node --test \
  test/domain-storage/log-prune-pair-reuse.test.js
NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/

# 共享经验：A/B + 规模曲线、A/A、稀疏路径、差分
NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/r13-shared-experience-scale.mjs \
  run --base-commit a0380e5cf2761297ecd8ffe1c79e34865ac6baee \
  --rounds 3 --samples 2 --out docs/performance/r13-shared-experience-scale.json
NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/r13-aa-noise.mjs \
  --rounds 3 --samples 2 --out docs/performance/r13-shared-experience-aa.json
NODE_OPTIONS=--max-old-space-size=4096 node --test \
  test/r13-shared-experience-equivalence.test.mjs

# 跨入口 / 诊断 / 桌面：四档夹具 + A/A + micro + concurrent + rescan
BASE="${TMPDIR:-/tmp}/r13-fixtures"
S=scripts/benchmarks/r13-cross-entry-audit.mjs
for N in 50 500 5000 20000; do
  node "$S" build --fixture "$BASE/r13-fixture-$N" --records "$N" --archive "$N"
  NODE_OPTIONS=--max-old-space-size=4096 node "$S" run \
    --baseline . --candidate . --fixture "$BASE/r13-fixture-$N" \
    --workloads indexRead,reconcileIdle,sourceVerify,review,doctor,usageRead \
    --rounds 3 --samples 3 --warmup 2 \
    --out "docs/performance/r13-cross-entry-audit-aa-$N.json"
done

# 完整闭环：四档阶段构成 + 2,000 档插桩副本
for H in 0 200 2000 5000; do
  node --max-old-space-size=4096 scripts/benchmarks/r13-loop-composition.mjs \
    --history "$H" --runs 5 --no-instrument \
    --out "docs/performance/r13-loop-composition-$H.json"
done
node --max-old-space-size=4096 scripts/benchmarks/r13-loop-composition.mjs \
  --history 2000 --runs 3 --out docs/performance/r13-loop-composition-copies.json
```

原始数据：

| 子系统 | JSON |
| --- | --- |
| 事件桥回收规划 | `docs/performance/r13-event-log-prune.json` |
| 共享经验 | `docs/performance/r13-shared-experience-scale.json`、`r13-shared-experience-aa.json`、`r13-sparse-ab.json` |
| 跨入口 / 诊断 / 桌面 | `docs/performance/r13-cross-entry-audit.json` 及 `r13-cross-entry-audit-{aa,micro,concurrent,rescan}-*.json` |
| 完整闭环 | `docs/performance/r13-loop-composition-{0,200,2000,5000}.json`、`r13-loop-composition-copies.json` |

`docs/performance/`、`scripts/benchmarks/`、`test/` 均不在 `package.json#files` 白名单，
不进入分发字节。分发文件改动只有 `lib/event-log-checkpoint.js`、
`lib/dockyard-domain/knowledge.js`、`lib/experience-recall.js`，由 Lead 集成后统一重打包
与验收。

## 8. 交付状态

- 本文件只新增跨子系统汇总；未改 `lib/`、`test/`、`scripts/` 或其它文档。
- 允许本地 commit；**未** push、未建 PR、未合并、未打 tag、未安装正式环境、未改主工作区。
- 全量 `npm test` 与 `npm run pack:check` 由 Lead 在集成后执行，本文不预设其结论。

## 9. 汇总时发现的不一致（仅报告，未改他文档）

1. **完整闭环复现命令的样本数**：[r13-loop-composition.md](r13-loop-composition.md) §1 与
   JSON 记录 `--history 0 / 200` 为 7 个样本、`2,000 / 5,000` 为 5 个样本，但 §6 的命令对
   四档统一使用 `--runs 5`。按该命令重跑 0 / 200 档会得到 5 个样本，不一定复现报告中的
   中位数。
2. **跨入口 20k 档的样本数**：[r13-cross-entry-audit.md](r13-cross-entry-audit.md) §1
   明确「20k 档 2 样本/侧、预热 1 次」，`r13-cross-entry-audit-aa-20000.json` 也记录
   `samples: 2`、`warmup: 1`；但 §8 的循环命令对四档统一使用 `--samples 3 --warmup 2`。
   该命令不能逐字复现 20k 档的记录。
3. **共享经验规模表的表头**：[r13-shared-experience.md](r13-shared-experience.md) §4 的列
   头是 `10k / 30k / 100k`，但最后一行 `hot-key` 的数值对应 500 / 2,000 / 5,000 次修订
   （该行首列已注明）。数值与 JSON 的 `hot-500/2000/5000` 一致，只是列头不适用于该行。
