# R12 共享经验写入路径：常量 SQL 语句句柄复用

受理标识：**DSH-EVOLUTION-PERF-R12-01**，子系统：共享经验 SQLite 与经验链路。
本文是本机实测的开发阶段数据，不是发布产物或宿主验收声明。

- 代码提交：`dfeb9b8`（`perf(shared-experience): prepare constant-SQL write statements once per store`）。
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
`51.7 → 46.4 ms`（约 −10%）；这就是下面被优化的具体工作。
更关键的是，R11 之后普通采集器对同一 `tools/result` 的重复投递会走完整回放分支，
使这条路径成为可测的稳态成本。

改动只把五个句柄移到 `openSharedExperience()` 内一次（当前
`lib/shared-experience.js:290-299`），`record()` 内改为使用句柄
（`:313,322,336-338`）。SQL 文本、绑定顺序、`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`
边界、schema 判定与持久化字节全部不变。事务性语句仍走 `db.exec()`，避免把
DDL/多语句执行路径混入这次等价改动。

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
- 每轮断言两侧 `stats()` 相同，落盘 `dbBytes` 相同。

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
两侧落盘字节相同（writes/readcontrol 98,304 B；duplicates 94,208 B），
maxRSS 中位数 68,720/66,032 KiB（进程高水位，含 imports，不作为内存下降证明）。

## 3. 正确性差分与反证

`test/shared-experience-prepared-equivalence.test.mjs`（3 项，全部通过）：

1. **逐字节/逐字段等价**：测试把当前源码反向变换回「每次 `db.prepare()`」的
   实现（变换断言所有五段句柄都能找到，防止未来悄悄变成自我比较），两个实现
   在同一组输入上各跑 12 轮，覆盖新事实、同 id 回放、`recordDegradation`、
   `recordToolRecovery`、`recordConclusion`、同 id 异内容的冲突拒绝。比较
   `events` 表全部 `hex(id)/hex(digest)`、`knowledge` 表全部 `key/revision/稳定 body
   投影`（去掉与运行时刻有关的 `firstSeen` 等字段）、`clock`、`stats()`、
   `findConclusions()` / `discover()` / `recall()` 的结构化答案——全部 `deepEqual`。
2. **反证（注入错误语句）**：把 `stmtUpsertKnowledge` 的 SQL 改成
   `revision=excluded.revision+1`（语法合法、prepare 成功），同一差分立即失败；
   证明比较确实覆盖被复用的句柄，而不是恒真断言。
3. **句柄作用域**：同时打开两个 store，交替写不同 target，两个库的 knowledge
   不同且各自正确——句柄属于单个 store，不会跨库串用。

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
| `detectDegradation()` 用索引循环替代 `value.lines.slice(0,2050)` | 探索性单进程微基准（400 次/样本）：2000 行时 CPU 0.0428 → 0.0295 ms（−31%），绝对节省约 13 µs/次；500 行时差异落到噪声内。收益微小且依赖结果大小，不值得单独维护。 | **NO-CHANGE**：绝对收益不足。 |
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
