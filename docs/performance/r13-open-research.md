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
| 共享经验 SQLite 与经验链路 | [r13-shared-experience.md](r13-shared-experience.md) | **接受 1 项**（`sortCandidates` 惰性键缓存）；`appendBounded` 候选经审核撤回 | `e4913e8` + 撤回提交 |
| 跨入口 / 诊断 / 统一审查 / 用量 / 桌面任务通道 | [r13-cross-entry-audit.md](r13-cross-entry-audit.md) | **NO CHANGE**（无可消除增长） | `a549110` |
| 完整进化闭环的插件侧耗时构成 | [r13-loop-composition.md](r13-loop-composition.md) | **NO CHANGE**（构成量化，无新候选） | `30b25b8` |

本文只做跨子系统汇总，不重复各文档的完整论证；根因源码位置、逐样本原始数据与复现细节以
对应子系统文档为准。环境：Node `v26.13.1`、`darwin/arm64`（Apple M2）、8 逻辑 CPU、16 GiB、
APFS、热页缓存；全部夹具在隔离临时目录与合成数据根中生成，未触碰正式 `DSH_HOME`、正式
经验库、`event-bridge.key` 或用户数据，未改官方 DSH 源码。

实际模型与档位：本文由 Copywriter（`opencode-go/deepseek-v4.1-flash` Low）汇总；
Lead 与各 Builder 的实际模型与档位记录在 PR 交付说明与各子系统文档中。

## 1. 两项接受改动与一项撤回

接受的两项都是「同一调用内、同一批字节/同一纯函数」的重复工作消除，不改持久化格式、
协议、窗口上限或认证次数。另一项候选在独立审核中被否决并撤回，理由见 §1.2。

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
| 2,000 | 273.1 / 253.0 / 271.7 | 273.8 / 251.6 / 273.9 | 270.9 / 252.4 / 272.1 |
| 20,000 | 860.5 / 758.3 / 951.0 | 858.0 / 786.0 / 864.7 | 860.7 / 737.8 / 867.0 |
| 100,000 | 1857.7 / 1617.3 / 1866.2 | 1868.3 / 1601.0 / 1866.3 | 1845.4 / 1486.9 / 1854.9 |

| 事件数 | A CPU | B CPU | 相对 | A/A 噪声 | 每次调用 A → B | 净省/调用 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2,000 | 271.81 ms | 252.35 ms | **−7.16%** | +0.09% | 9.06 → 8.41 ms | 0.65 ms |
| 20,000 | 860.51 ms | 763.58 ms | **−11.26%** | +1.86% | 86.05 → 76.36 ms | 9.69 ms |
| 100,000 | 1855.87 ms | 1600.96 ms | **−13.74%** | +0.56% | 463.97 → 400.24 ms | 63.73 ms |

三档全部轮次 B−A 为负。配对中位数在 2,000 / 20,000 档还伴随"B 的最大值低于 A 的最小值"，
但 100,000 档两侧样本范围有重叠（A 最小 1,685.0 ms、B 最大 1,780.0 ms），该档只主张配对
中位数。唯一明显离群是 20,000 档第 0 轮 A2 = 951.0 ms，按噪声处理、不计入收益。墙钟与 CPU 同向（2,000: 240.6 → 212.0 ms；
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

### 1.2 已撤回：`appendBounded()` 的重复序列化

**原候选**：把 `list.some((item) => stableStringify(item) === stableStringify(value))`
里的 `stableStringify(value)` 提到循环外算一次；热 key 写入实测 248.421 → 233.465 ms
（−6.02%，A/A +0.27%）。

**为何撤回**：独立审核用 `git archive` 物化基线后直接调用 `mergeKnowledgeEntry()`
构造出两个真实分歧：

- 空窗口 + 带状态化 accessor 的 `value`：基线从不序列化 `value`，走 `clone()` 的兜底
  路径返回 `[{a:42}]`；候选提前序列化，在 getter 第一次读取时抛错。
- 已填窗口 + 状态化 getter：基线每个已有元素比较时各读一次 `value`，保留
  `[{a:1},{a:2}]`；候选只读一次，追加了第二个 `{a:2}`。

`appendBounded()` 是通用入口，不能假定 `value` 已是数据 DTO；延迟到首次比较只能修复
空窗口。项目要求对所有输入保持失败顺序与去重结果不变（R12 的 `isSensitiveKey` 对状态化
`toString` 也走原路径），因此整体撤回，`lib/dockyard-domain/knowledge.js` 恢复基线实现，
配套差分的 A 项同步删除（其反证原先把 40 次合并与 90 次合并相比，长度差异就能让它“通过”，
对 `APPEND_BROKEN` 没有牙）。代价是放弃约 6% 的热 key 写入收益。

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

**范围与代价**：收益随「同分候选数」增长，不发生在零/单候选或窗口未满时；不改
`synchronous`、WAL、`busy_timeout`、schema、去重/冲突/授权语义。
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
| 0 | 4.71 ms | 0.47 (9.9%) | 0.48 (10.2%) | 0.27 (5.7%) | 0.51 (10.8%) | 0.16 (3.4%) | 0.15 (3.2%) | 0.03 (0.6%) | 2.64 (56.0%) |
| 200 | 15.58 ms | 7.89 (50.7%) | 3.59 (23.1%) | 0.27 (1.7%) | 0.64 (4.1%) | 0.16 (1.0%) | 0.12 (0.8%) | 0.02 (0.1%) | 3.20 (20.5%) |
| 2,000 | 79.85 ms | 37.05 (46.4%) | 29.33 (36.7%) | 0.41 (0.5%) | 0.80 (1.0%) | 0.16 (0.2%) | 0.25 (0.3%) | 0.06 (0.1%) | 10.38 (13.0%) |
| 5,000 | 103.44 ms | 36.18 (35.0%) | 39.92 (38.6%) | 0.41 (0.4%) | 0.95 (0.9%) | 0.16 (0.2%) | 0.32 (0.3%) | 0.03 (0.0%) | 21.23 (20.5%) |

**固定开销**：`probe` 两侧合计约 0.2–0.6 ms、`trial` 0.5–1.0 ms、`measure` 0.1–0.3 ms、
`promote` 的只读门禁 0.03 ms，均不随历史变化；`revert` 中约 2.5–4.6 ms 的归档渲染 +
事件桥写入 + fsync 也是固定成本（5,000 档 `revert` 减去两次存储调用后余约 4.6 ms）。

**有界增长**：`plan` 的两个读窗口（`discover` 500、`recall` 2,000 行）填满后不再随总行数
增长，2,000 → 5,000 档从 37.05 降到 36.18 ms（噪声内）；另有约 5–7 ms 是对 500 条候选
规范化、分组与评分的有界纯计算。

**无界增长**：`findConclusions()` 是无 scope 列可用的 `instr(body, ?)` 全表扫描，每次闭环
调用两次（`propose` 的重复假设拦截、`revert` 的结论发布前查询），从 0.6 ms（200 行）线性
增长到 16.5 ms（5,000 行），5,000 档两次合计 32.9 ms、约占整次闭环 32%。

**序列化与深拷贝**（2,000 档，3 个插桩样本，阶段与子调用同用 CPU）：整次闭环 9 次
`structuredClone` 合计 0.05 ms、`JSON.stringify` 780 次合计 0.59 ms、`JSON.parse`
5,006 次合计 23.48 ms（27.3%）。解析几乎全部来自 `recall` 的 2,000 行窗口与 `discover`
的 500 行窗口 + 计划器投影，属按窗口读取正文的固有成本；插桩样本闭环 85.94 ms 略高于
非插桩的 79.85 ms，差额来自包装本身。

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
| 共享经验 | 10k / 30k / 100k 行 | `discover(window=500)` | 6.65 / 6.92 / 7.17 ms | 有界窗口 + 每次 `count(*)` 的 covering-index scan |
| 共享经验 | 10k / 30k / 100k 行 | `recall(window=2000)` | 66.28 / 66.63 / 68.12 ms | **固定夹具对照**（三档夹具均为 ≤2,500 行，不是规模曲线） |
| 共享经验 | 10k / 30k / 100k 行 | `writes`（N 条新事实） | 868.25 / 2630.82 / 9347.84 ms | 随写入条数线性（必要工作） |
| 共享经验 | 500 / 2000 / 5000 次修订 | 单热 key merge | 142.31 / 423.24 / 981.75 ms | 随单 key 修订数线性（有界窗口维护） |
| 跨入口索引 | 50 / 500 / 5k / 20k 记录 | `indexRead` | 2.23 / 6.33 / 46.55 / 225.56 ms | 合理增长（parse + 逐记录校验 + 整文件 sha256） |
| 跨入口索引 | 50 / 500 / 5k / 20k 记录 | `sourceVerify` | 7.52 / 61.66 / 635.63 / 2856.67 ms | 合理增长（防篡改，每记录恰好一次） |
| 跨入口索引 | 50 / 500 / 5k / 20k 记录 | `usageRead` | 0.21 / 0.22 / 0.22 / 0.24 ms | **固定开销**（stat + readFile + parse 小投影） |
| 桌面兜底重扫 | 100 / 1000 / 5000 任务 | 每次 `rescan`（含 state 读取/解析/校验） | 4.54 / 32.47 / 168.09 ms | 随 inbox 线性（唯一兜底） |
| 完整闭环 | 0 / 200 / 2k / 5k 行 | 闭环总计 | 4.71 / 15.58 / 79.85 / 103.44 ms | 前段有界 + `findConclusions` 无界 |

`indexRead` 的 O(字节) 分解（CPU ms 中位数，50 / 500 / 5k / 20k）：读文件
0.061 / 0.158 / 2.019 / 5.420、`JSON.parse` 0.118 / 1.798 / 9.906 / 38.268、
`sha256(bytes)` 0.044 / 1.172 / 3.958 / 13.264、archive `readdir+filter+sort`
0.010 / 0.044 / 0.936 / 2.418。20k 档 sha256 仅占 `indexRead` 约 6%，parse 约 38 ms，
其余约 170 ms 是逐记录校验；50 档则相反，O(字节) 子步骤合计约 0.22 ms，整次
`indexRead` 2.23 ms 里约 2.0 ms 是逐记录校验的固定成本。

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
| Desktop 1500 ms 重扫降频 / 移除 | 4.54–168.09 ms/次 | watcher `persistent:false`，重扫是漏事件唯一兜底；降频推迟拾取、移除漏任务 | **否决**：削弱可靠性 |
| `registration.js` 每工具 finally flush 改频率 | 常数成本 | 改变事件认证/去重时机；R12 已否决 agent/pre-step flush 频率 | **否决**（R12 已否决） |
| `propose` 与 `revert` 共用一次 `findConclusions` | 5k 档约 16 ms/闭环 | 两次调用之间隔着真实 `trial`/`probe`/`revert` 写入，另一入口可能追加同一 target；复用会用旧快照决定是否发布结论 | **否决**：O(1) 缓存近似 O(历史) |
| 给 `findConclusions` 的 scope 加 JSON1 表达式索引/列 | 100k 档约 280 ms | 需 schema 变更与既有库迁移；`json_extract` 与 `instr` 对畸形 body 不完全等价 | **否决**（边界禁止） |
| `plan` 复用 `discover` 的 500 行替代 `recall` 的 2,000 行 | 2k 档约 19 ms | 两个窗口上限与过滤条件不同，复用会改变证据投影；R12 C2 已否决同类 | **否决** |
| 缩短 `recall` / `discover` 窗口 | 与窗口成正比 | 直接缩小检索范围，可能漏掉窗口外历史 | **否决**：任务禁止 |
| 惰性 / 分批 `plan` 评分 | 约 5–7 ms（有界） | 有界开销；改动会破坏 `evolution_plan` 同步返回契约 | **NO CHANGE** |

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
  约 29/84/280 ms；完整闭环里每次调用两次，5k 档已占闭环约 32%。它是显式动作路径
  （`evolution_propose` / 结论发布），不在 `agent/pre-step` 热路径；真实安装在 10k 行以上
  会先感知到它。`discover()` 的 `count(*)` covering-index 全索引计数也随库增长，但量级小
  得多（5k 档约 1 ms），本轮未单独分解。
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
- **桌面兜底重扫**：显式启用时随 inbox 线性（5,000 任务 168.09 ms/次，按 1500 ms 间隔约
  6,723.4 ms CPU/分钟，且不含真实入口的 `writeConsumerState()`）；这是 watcher 漏事件时的
  唯一兜底。

## 6. 验证状态

只列本次实际执行过的检查。

| 子系统 | 已执行 | 结果 |
| --- | --- | --- |
| 事件桥回收规划 | 差分（反向对拍 + 调用计数 + 变异 + 边界） | 5/5 通过 |
| | `test/domain-storage/` | 218/218 通过 |
| | checkpoint / keyed-digest / read-chunks | 24/24 通过 |
| | 三档 A/B | 全部轮次 B−A 为负，`allFingerprintsEqual: true` |
| 共享经验 | `test/r13-shared-experience-equivalence.test.mjs` | 1 项通过（`appendBounded` 项已随撤回删除） |
| | 受影响聚焦套件（214 + 81） | 295 项全部通过，0 失败 0 跳过 |
| | A/B 与 A/A | 两侧输出指纹与 `stats()` 相同 |
| | 2/4 写者并发 | 500/500 与 1000/1000 committed，`busy=0`、`other=0` |
| 跨入口 / 诊断 / 桌面 | 四档交替 A/A | 全部 `allFingerprintsEqual: true`；50 档在复审发现空索引后已重建重跑 |
| | 篡改反证 | 当前树 `blocked`、补丁树 `degraded`，指纹不等 |
| | 13 个聚焦套件 | 328/328 通过，0 失败 0 跳过 |
| 完整闭环 | 四档阶段构成 + 2,000 档插桩副本 | 已测，样本数与插图见 JSON |
| 全量回归 | `NODE_OPTIONS=--max-old-space-size=4096 npm test` | **2354 项 / 2352 通过 / 0 失败 / 2 跳过**（R12 基线 2348；新增 6 项差分用例：事件桥 5 + 召回 1） |
| 打包检查 | `npm run pack:check`（开发阶段） | **17/17 通过**；工作树是 `0.2.21` 固定点的已提交后继，`release/` 与既有验收证据未改动 |

### 6.1 Lead 独立复跑（静默机器）

各子系统收工后，Lead 在没有其它基准/测试运行时按同一脚本独立复跑接受的改动：

| 改动 | 负载 | Builder 数据 | Lead 复跑 | 方向 |
| --- | --- | ---: | ---: | --- |
| `planLogPrune` | 2k / 20k / 100k 事件 | −7.16% / −11.26% / −13.74% | **−8.09% / −13.70% / −12.39%** | 三档均负 |
| `sortCandidates` | `recall` | −9.35% | **−8.45%** | 同向同量级 |

（已撤回的 `appendBounded` 当时也复跑为 −6.07%，但该改动不再交付，故不列入。）

Lead 复跑的 A/A 噪声：事件桥 +0.81 / −0.01 / +0.03%（三档）；共享经验未改动对照
`conclusions-nomatch` −0.13%、`discover` −0.30%、`recall-none` +0.94%、`recall-one` +0.12%；
2/4 写者并发两侧分别 500/500 与 1000/1000 committed，`busy=0`、`other=0`。
两次运行的绝对基线略有差异，百分比因此不完全相同；方向、配对差符号与量级一致。
原始数据：`r13-lead-event-log-prune.json`、`r13-lead-shared-experience.json`。

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
BASE=$(mktemp -d "${TMPDIR:-/tmp}/r13-fixtures-XXXXXX")
S=scripts/benchmarks/r13-cross-entry-audit.mjs
for N in 50 500 5000 20000; do
  node "$S" build --fixture "$BASE/r13-fixture-$N" --records "$N" --archive "$N"
done
# 50/500/5000：3 样本/侧、预热 2；20k：2 样本/侧、预热 1（与记录一致）
for N in 50 500 5000; do
  NODE_OPTIONS=--max-old-space-size=4096 node --expose-gc "$S" run \
    --baseline . --candidate . --fixture "$BASE/r13-fixture-$N" \
    --workloads indexRead,reconcileIdle,sourceVerify,review,doctor,usageRead \
    --rounds 3 --samples 3 --warmup 2 --expect-records "$N" \
    --out "docs/performance/r13-cross-entry-audit-aa-$N.json"
done
NODE_OPTIONS=--max-old-space-size=4096 node --expose-gc "$S" run \
  --baseline . --candidate . --fixture "$BASE/r13-fixture-20000" \
  --workloads indexRead,reconcileIdle,sourceVerify,review,doctor,usageRead \
  --rounds 3 --samples 2 --warmup 1 --expect-records 20000 \
  --out docs/performance/r13-cross-entry-audit-aa-20000.json

# 完整闭环：四档阶段构成（0/200 用 7 个样本，2k/5k 用 5 个，与记录一致）
node --max-old-space-size=4096 scripts/benchmarks/r13-loop-composition.mjs --history 0 --runs 7 --no-instrument --out docs/performance/r13-loop-composition-0.json
node --max-old-space-size=4096 scripts/benchmarks/r13-loop-composition.mjs --history 200 --runs 7 --no-instrument --out docs/performance/r13-loop-composition-200.json
node --max-old-space-size=4096 scripts/benchmarks/r13-loop-composition.mjs --history 2000 --runs 5 --no-instrument --out docs/performance/r13-loop-composition-2000.json
node --max-old-space-size=4096 scripts/benchmarks/r13-loop-composition.mjs --history 5000 --runs 5 --no-instrument --out docs/performance/r13-loop-composition-5000.json
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
| Lead 独立复跑 | `docs/performance/r13-lead-event-log-prune.json`、`r13-lead-shared-experience.json` |

`docs/performance/`、`scripts/benchmarks/`、`test/` 均不在 `package.json#files` 白名单，
不进入分发字节。分发文件改动只有 `lib/event-log-checkpoint.js` 与
`lib/experience-recall.js`（`knowledge.js` 已恢复到基线），由 Lead 集成后统一重打包与验收。

## 8. 交付状态

- 本文件只新增跨子系统汇总；未改 `lib/`、`test/`、`scripts/` 或其它文档。
- 允许本地 commit；**未** push、未建 PR、未合并、未打 tag、未安装正式环境、未改主工作区。
- 全量 `npm test` 与 `npm run pack:check` 已由 Lead 在集成后执行，结果见 §6；
  真实宿主验收、`pack:check --release` 与发布仍未执行，也不在本文主张范围内。

## 9. 审核与汇总阶段发现并已修正的问题

独立复核（`codex/gpt-6.2-sol` High）对 `9b18505` 返回 CHANGES；下面每项都已在同一分支
修复并复测。没有一项是通过调整措辞绕过的：

1. **`appendBounded` 候选被否决并撤回**：状态化 accessor 的输入会让失败路径与去重结果
   偏离基线（空窗口基线返回 `[{a:42}]`、候选抛错；已填窗口基线保留两条、候选追加
   `{a:2}`）。`lib/dockyard-domain/knowledge.js` 恢复基线；对应差分 A 项删除
   （其反证原先把 40 次合并与 90 次合并相比，长度差异就能让它通过）。放弃约 6% 的
   热 key 写入收益。详见 [r13-shared-experience.md](r13-shared-experience.md) §3.1。
2. **跨入口 50 档夹具是空索引**：`sourceVerify` 的指纹等于空集合
   （`sha256('{"count":0,"sample":[],"allVerified":true}')`，前缀 `21500f57`），旧的
   `indexRead` 0.22 / `sourceVerify` 0.12 / `review` 1.11 / `doctor` 3.60 ms 都测的是
   空索引。已用新夹具重建重跑：2.23 / 7.52 / 9.02 / 10.26 ms；`micro` 50 档一并重跑。
   `run` 新增 `--expect-records`，空集合或残缺夹具会让基准直接失败。
3. **闭环归因混用了墙钟与 CPU**：阶段总计用 `process.cpuUsage()`，子调用包装器原先用
   `hrtime`，所以 21.6% 之类的占比不成立。包装器已改为 `process.cpuUsage()` 并重跑
   4 档与插桩副本；新占比（`JSON.parse` 27.3% 等）是 CPU / CPU。
4. **事件桥逐轮表与原始样本不符**：按 `scales[].rounds[].samples[].cpuMicros` 重算后，
   20,000 档第 0 轮是 860.5 / 758.3 / 951.0（原写 864.3 / 771.3 / 971.1）；
   100,000 档样本范围有重叠（A 最小 1,685.0、B 最大 1,780.0），因此分离结论只针对
   配对中位数。
5. **规模表与复现命令超出证据**：`recall` 三档夹具都是 `Math.min(n, 2500)` 行，
   已标为"固定夹具对照"而非规模曲线；`discover` 已分开"有界窗口"与"每次 `count(*)` 的
   covering-index scan"；跨入口与夹具命令改用 `mktemp`，20k 档样本数/预热与闭环
   0/200 档样本数按记录更正。

汇总阶段另发现三处"文档命令/表头与记录不符"，也已修正（未改任何测量数字）：
完整闭环复现命令改为逐档 `--runs 7 / 7 / 5 / 5`；跨入口 §8 拆成 50/500/5000 与 20k
两段命令；共享经验 §4 的 `hot-key` 行补注"三列是 500 / 2,000 / 5,000 次修订"。

## 10. 第二轮复核（`f03d991`）的修复

第二轮独立复核返回 CHANGES，5 个 blocker 均属交付证据与计时边界，已修复：

1. **汇总附件残留旧 50 档**：`docs/performance/r13-cross-entry-audit.json` 的
   `runs["50"]` / `micro["50"]` 已用重跑后的分档数据替换（`sourceVerify` 7.523 ms、
   `parseIndex` 0.118 ms），与 `-aa-50.json` / `-micro-50.json` 一致；备份口径见 §6。
2. **桌面重扫测的不是生产路径**：夹具改为完整 state 文档，`rescan` 执行与 `readState()`
   相同的读取/解析/`schemaVersion`+`protocol`+`taskId` 校验；数字更新为
   4.54 / 32.47 / 168.09 ms（100/1,000/5,000）。第一版只做 `access(state)`，已在
   §4 标注作废。**NO CHANGE 不变**。
3. **并发启动的计时边界**：明确 `concurrent` 是只读合成负载，不含 `writeConsumerState()`
   的 SQLite 发布锁与 Include 挂载；`sourceVerify` 每次先做一次完整 `readSharedIndex()`，
   因此不能当作 doctor 内源码校验的占比。**NO CHANGE 不变**。
4. **“唯一无界项”口径**：`discover()` 的 `count(*)` 也是 covering-index 全索引计数，
   闭环、共享经验与本文三处口径已统一，并注明未单独分解该计数。
5. **附件路径与复现命令**：18 份 R13 JSON 的临时目录/worktree 路径已替换为
   `<tmp>` / `<worktree>` 占位符（数值未改）；跨入口 A/A 命令补 `--expect-records`，
   篡改反证补上两棵树的 `measure --workloads doctor`。

另按建议注明闭环 27.3% 的聚合口径（阶段解析中位数之和 ÷ 闭环中位数；逐样本先算占比
再取中位数为 26.1%），并统一了事件桥逐轮表的 `B−A` 舍入。
