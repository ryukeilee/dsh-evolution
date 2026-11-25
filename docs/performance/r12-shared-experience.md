# R12 共享经验写入路径：常量 SQL 语句句柄复用

受理标识：**DSH-EVOLUTION-PERF-R12-01**，子系统：共享经验 SQLite 与经验链路。
本文是本机实测的开发阶段数据，不是发布产物或宿主验收声明。

- 代码提交：`dfeb9b8`（首版），复审修复后为复用句柄按需准备（见 §3 第 4 项）；基准脚本与原始数据随本轮提交。
- 基线：`719fcbb2`（该提交的父提交 / v0.2.21 起点）。
- 原始逐轮、逐样本数据：[`r12-shared-experience-prepared.json`](r12-shared-experience-prepared.json)。
- 环境：Node `v26.13.1`，`darwin-arm64`，Apple M2，8 逻辑 CPU、16 GiB；测量开始时
  `load averages: 2.25 1.97 1.69`，机器上同时有其他 Builder 的进程。因为墙钟会被
  邻居任务与 SQLite `fsync` 抖动影响，**主指标是 `process.cpuUsage()`**，并且每个
  （轮次、侧面、工作负载）都起一个独立进程、交替顺序、同负载同 id；不把邻居的
  墙钟抖动算成收益。所有数据库都建在 `os.tmpdir()` 下独立目录并清理，未触碰正式
  `DSH_HOME`、正式经验库、`event-bridge.key` 或任何用户数据。

## 1. 根因与复现

`openSharedExperience()` 返回的私有 `record()` 是 `recordFailure` / `recordDegradation` /
`recordToolRecovery` / `recordEvolution` / `recordConclusion` 的唯一写入口。基线
`719fcbb2:lib/shared-experience.js:303,312,326-329` 每次调用都重新 `db.prepare()` 五条
**SQL 文本完全相同**的语句：

| 基线行号 | SQL | 调用频率 |
| --- | --- | --- |
| 303 | `SELECT digest FROM events WHERE id=?` | 每条事实一次（含重复回放） |
| 312 | `SELECT body FROM knowledge WHERE key=?` | 每条新事实一次 |
| 326 | `INSERT INTO events VALUES (?,?)` | 每条新事实一次 |
| 327 | `UPDATE clock SET value=value+1` | 每条新事实一次（`db.exec`） |
| 328-329 | `INSERT INTO knowledge ... ON CONFLICT(key) DO UPDATE ...` | 每条新事实一次 |

`node:sqlite` 的 `DatabaseSync.prepare()` 每次都调用 `sqlite3_prepare_v2` 重新编译
SQL；同一条 SQL 重复 prepare 的结果对象并未跨调用复用。回放（at-least-once 的
重复投递）路径只做 `303` 的 SELECT 与 COMMIT，因此 prepare 在该路径上占的比例最高。

复现用的探针（只测 prepare，不写任何插件文件）把 `INSERT` 放进 `BEGIN IMMEDIATE`：
每轮 2000 次调用，`prepare()` 每条一次 vs 复用同一句柄，CPU 中位数
`52.09 → 46.70 ms`（约 −10%）；这就是下面被优化的具体工作。
重复事实（不同执行对象但同一 event id，例如持久化事件回放）会进入
`prior` 命中分支，只做一次 SELECT 与 COMMIT，因此 prepare 在该分支占比最高。

改动把五个句柄按 **首次使用** 缓存（当前 `lib/shared-experience.js:304-314`），
`record()` 内改为使用句柄（`:326,335,349-352`）。SQL 文本、绑定顺序、
`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` 边界、schema 判定与持久化字节全部不变。
事务性语句仍走 `db.exec()`，避免把 DDL/多语句执行路径混入这次等价改动。

**为什么不是在 open 时一次性准备**：第一版把五条 `prepare()` 放在
`openSharedExperience()` 里，独立复审构造出一个真实分歧——schema 1 数据库若有
`AFTER UPDATE ON clock` 触发器引用缺失表，SQLite 直到准备 `UPDATE clock` 才报错。
基线只在真正写入时失败并回滚，数据库仍可被本进程打开、读取 `stats()` 并正常关闭；
open 时准备则让整个 store 打不开，而且该路径在 open 的关闭清理边界之外。现在准备
仍发生在基线编译该语句的同一位置（写入事务内），复现与反证见 §3 第 4 项。

## 2. 同负载交替 A/B

脚本 `scripts/benchmarks/shared-experience-prepared.mjs` 对
（轮次 × 侧面 × 工作负载）逐个起独立 Node 进程：

- **A**：`git show 719fcbb2:lib/shared-experience.js` 放进临时 `lib/` 树；
  **B**：工作树当前 `lib/`。
- 每轮顺序 `A,B → B,A → A,B → B,A → A,B`（5 轮），每轮每侧每工作负载 5 个样本，
  每个样本用全新临时根、8 条预热事实，正式窗口只计时被测调用；`open`/`close`
  单独报告为 harness 开销。
- `writes`：400 条不同 id 的 `recordFailure`（同 target，触发 knowledge 合并）。
  `duplicates`：先写 400 条，再原样回放同一批 id（全部命中 duplicate 分支）。
  `readcontrol`：写 400 条后连续 3 次 `findConclusions()`（未改动的读路径对照）。
- 每轮断言两侧 `stats()` 相同；`dbBytes` 是 `close()` 前读到的 SQLite 主文件大小，脚本
  逐样本记录。它只在**中位数**上相同（98,304 B / 94,208 B）：Lead 复跑的新写入第 2 轮、
  第 2 个样本记录到 90,112 B 对 98,304 B。WAL 模式下主文件大小本来就不是内容证明，
  逻辑内容的逐字段对拍见 §3。

### 2.1 `recordFailure` 新事实（400 条/样本）

| 轮次 / 顺序 | A CPU ms | B CPU ms | CPU Δ | A 墙钟 ms | B 墙钟 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 / A,B | 87.38 | 79.77 | −8.7% | 95.47 | 86.88 |
| 1 / B,A | 87.47 | 84.56 | −3.3% | 94.73 | 95.71 |
| 2 / A,B | 88.34 | 80.42 | −9.0% | 110.20 | 87.62 |
| 3 / B,A | 87.58 | 79.95 | −8.7% | 95.44 | 86.53 |
| 4 / A,B | 88.51 | 78.71 | −11.1% | 108.58 | 86.57 |

中位数：**CPU 87.581 → 79.946 ms（−8.72%）**，墙钟
95.465 → 86.881 ms（−8.99%）。CPU 五轮全部为负，墙钟第 1 轮 +1.0% 是邻居抖动。

### 2.2 重复回放（400 条/样本，全部 duplicate）

| 轮次 / 顺序 | A CPU ms | B CPU ms | CPU Δ |
| --- | ---: | ---: | ---: |
| 0 / A,B | 3.66 | 2.24 | −38.8% |
| 1 / B,A | 3.71 | 2.29 | −38.2% |
| 2 / A,B | 3.80 | 2.46 | −35.3% |
| 3 / B,A | 3.62 | 2.26 | −37.5% |
| 4 / A,B | 3.56 | 2.25 | −36.9% |

中位数：**CPU 3.662 → 2.263 ms（−38.20%）**，墙钟 3.538 → 2.183 ms（−38.30%）。
这是收益最大的路径：重复事实只做一次 SELECT + COMMIT，prepare 的编译成本占比最高。

### 2.3 未改动的读路径对照（`findConclusions` ×3）

CPU 中位数 0.300 → 0.283 ms（−5.7%），墙钟 0.2386 → 0.2346 ms（−1.7%）。
绝对差 0.017 ms，且该路径的 SQL 没有改动；视为噪声，不作为收益。
`open()` 中位数 A/B = 1.064/1.079 ms（writes）、1.116/1.118 ms（duplicates），
`close()` 约 0.6–0.7 ms——这些是 harness，不计入上表的工作窗口。
两侧 `stats()` 相同；脚本在 `close()` 前读取的 SQLite 主文件大小相同
（writes/readcontrol 98,304 B；duplicates 94,208 B）——这是文件大小，不是
“落盘内容逐字节相同”的证明，逻辑内容的逐字段对拍见 §3。maxRSS 中位数
68,720/66,032 KiB（进程高水位，含 imports，不作为内存下降证明）。

Lead 在复审修复后用同一脚本独立复跑（`r12-lead-shared-experience.json`，机器上
无其它基准）：新事实 86.890 → 78.676 ms CPU（**−9.45%**，5/5 轮为负）、重复回放
3.532 → 2.251 ms（**−36.27%**，5/5 轮为负）、未改动的读对照 0.275 → 0.278 ms
（+1.09%，逐轮方向不一致，视为噪声）。

## 3. 正确性差分与反证

`test/shared-experience-prepared-equivalence.test.mjs`（4 项，全部通过）：

1. **逐字节/逐字段等价**：测试把当前源码反向变换回「每次 `db.prepare()`」的
   实现（变换断言所有五段句柄都能找到，防止未来悄悄变成自我比较），两个实现
   在同一组输入上各跑 12 轮，覆盖新事实、同 id 回放、`recordDegradation`、
   `recordToolRecovery`、`recordConclusion`、同 id 异内容的冲突拒绝。比较
   `events` 表全部 `hex(id)/hex(digest)`、`knowledge` 表全部 `key/revision/稳定 body
   投影`（去掉与运行时刻有关的 `firstSeen` 等字段）、`clock`、`stats()`、
   `findConclusions()` / `discover()` / `recall()` 的结构化答案——全部 `deepEqual`。
2. **反证（注入错误语句）**：把 knowledge upsert 的 SQL 改成
   `revision=excluded.revision+1`（语法合法、prepare 成功），同一差分立即失败；
   证明比较确实覆盖被复用的句柄，而不是恒真断言。
3. **句柄作用域**：同时打开两个 store，交替写不同 target，两个库的 knowledge
   不同且各自正确——句柄属于单个 store，不会跨库串用。
4. **准备失败的时机**（复审新增，`test/shared-experience-prepared-equivalence.test.mjs`
   第 4 项）：测试用 `openSharedExperience()` 新建的库（schema 2）建一个引用缺失表的
   `AFTER UPDATE ON clock` 触发器，基线与候选都必须能打开并读到 `{events:0,knowledge:0}`；
   写入以同一错误失败、回滚后仍可读。用首版 open 时准备复现：open 直接抛
   `no such table: main.r12_missing`；当前实现 open 成功、写入失败、`stats()` 不变。
   复审另用 schema 1 库验证了同一行为（同样可打开、失败写入回滚、修复触发器后同一连接
   可重试）；该 schema 1 变体未固化成用例。

额外验证：`NODE_OPTIONS=--max-old-space-size=4096 node --test
test/shared-experience.test.mjs test/shared-experience-schema-v2.test.mjs
test/shared-experience-migration.test.mjs test/review-fix-tool-recovery.test.mjs
test/experience-recall.test.mjs test/experience-degradation.test.mjs
test/experience-plan.test.mjs test/experience-attribution.test.mjs` → **159/159 通过**。

## 4. 适用范围与负面取舍

- **收益来源**：省掉的是 SQLite SQL 编译，不是 `fsync`、不是 digest、不是
  knowledge 合并；`synchronous=FULL`、WAL、busy timeout、schema 1/2 兼容、跨进程
  互斥、去重与冲突语义都未改动。收益随写入次数线性增长，与历史长度无关。
- **代价转移**：每个打开的 store 多持有 5 个 `StatementSync` 对象，直到
  `close()` 释放；`open()` 成本没有可测变化（见上）。失败/异常路径仍然
  `ROLLBACK`，复用句柄由 `run()` 自动 reset，不改变事务状态。
- **可测边界**：只在 `record()` 的写入路径；`findConclusions()` / `discover()` /
  `recall()` 的动态 SQL（谓词数量随 scopeParts 变化）未动，它们的增长成本仍是
  O(history)。高并发写、慢盘、跨进程竞争未测；CPU 数字只反映本机 Node/V8 +
  SQLite 组合。
- **不削弱任何不变量**：没有引入缓存派生值、没有用 O(1) 信号证明 O(history)
  状态未变、没有改持久化格式或授权边界。

## 5. 调查后决定不修改的项（同子系统）

| 候选 | 证据 | 结论 |
| --- | --- | --- |
| `findConclusions()` 的 scope `instr()` 全表扫描 | 现有 `shared-experience-conclusion-scan.mjs` 的 10k/30k 数据（本改动前已实现「窗口优先、仅在填满时计数」）：82.0 ms @30k，仍随历史线性增长。加 JSON1 表达式索引会改 schema、要求既有库补建索引，且 `instr` 与 `json_extract` 的匹配语义对畸形 body 不完全等价。 | **NO-CHANGE**：显式动作读路径，索引/schema 风险与收益不匹配；R10 §3 已登记同类窗口残余。 |
| `PRAGMA synchronous=NORMAL` / 去掉 busy_timeout | 现有 `shared-experience.md` 记录 2 s 等待是慢盘四进程饥饿后的修复；降低同步级别会削弱崩溃恢复。 | **NO-CHANGE**：硬约束禁止削弱持久化/崩溃恢复。 |
| 调大 `PRAGMA cache_size` | 当前未设置（SQLite 默认 −2000，约 2 MiB）。现有规模下 events 账本约 0.8 MiB、knowledge 随身份增长；改缓存大小只影响读页命中且会增加常驻内存，没有可复现的 A/B 收益。 | **NO-CHANGE**：无证据的启发式调参，不引入。 |
| `detectDegradation()` 用索引循环替代 `value.lines.slice(0,2050)` | 探索性单进程微基准（400 次/样本）：2000 行时 CPU 0.0428 → 0.0295 ms（−31%），绝对节省约 13 µs/次；500 行时差异落到噪声内。收益微小且依赖结果大小，不值得单独维护。 | **NO-CHANGE**：绝对收益不足。 |
| collector 的 LRU / streak 数据结构 | `experience-collector.js:99-151` 的 `outcomes` 用 delete+set 做 O(1) touch，上限 256；`counted`/`executions` 是 WeakMap/WeakSet； streak 是常数运算。没有重复序列化或深拷贝。 | **NO-CHANGE**：无冗余工作。 |
| R11 新增 `recordToolRecovery` 的写入 | 每个 episode 5 次干净成功才写一条，且同一 episode 只写一次；经同一 `record()`，已随本次句柄复用受益。 | **NO-CHANGE**：无需额外机制。 |
| 迁移 CLI 的多次流式校验 | `lib/shared-experience-migration.js:480/505/520` 对 events 做三次指纹/复制扫描，`knowledgeFingerprint` 两次；但这是**一次性离线命令**，现有 10k 迁移耗时 229–488 ms（`shared-experience-storage.md`）。合并扫描会改变备份验证与事务内自证的顺序。 | **NO-CHANGE**：低频操作，不为约 1/3 的一次性耗时扩大安全边界。 |

## 6. 复现命令

```sh
# 聚焦测试（含差分与反证）
NODE_OPTIONS=--max-old-space-size=4096 node --test \
  test/shared-experience-prepared-equivalence.test.mjs \
  test/shared-experience.test.mjs test/shared-experience-schema-v2.test.mjs \
  test/shared-experience-migration.test.mjs test/review-fix-tool-recovery.test.mjs \
  test/experience-recall.test.mjs test/experience-degradation.test.mjs \
  test/experience-plan.test.mjs test/experience-attribution.test.mjs

# 交替 A/B（基线 = 代码提交的父提交）
NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/shared-experience-prepared.mjs \
  --base-commit 719fcbb2a6405526f34ca14aa061f04220bcefec \
  --rounds 5 --samples 5 --writes 400 \
  --out docs/performance/r12-shared-experience-prepared.json
```

脚本自己从 `git show` 解出基线、生成两份临时 `lib/` 树、逐轮起独立进程，
不依赖人工重写基线；完成后删除临时树。原始逐轮、逐样本数据（含 wall/CPU/
open/close/maxRSS/dbBytes/stats）保存在上述 JSON。
