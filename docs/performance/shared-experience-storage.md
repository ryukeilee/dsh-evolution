# 统一共享经验存储：v1/v2 体积与延迟对照

本文件是本机实测数据，不是理论估算。原始数据（全部样本、每轮 min/max、延迟原始值、迁移输出）保存在 
[`shared-experience-storage.json`](shared-experience-storage.json)。

以下所有体积与时间数字都来自本次运行的实际测量；没有用行宽或理论布局去推算收益，也没有把估算值写进表格。

## 复现命令

```sh
node scripts/benchmarks/shared-experience-v1-baseline.mjs --verify-baseline
node --max-old-space-size=4096 scripts/benchmarks/shared-experience-storage.mjs docs/performance/shared-experience-storage.json --rounds 3 --sizes 1000,10000 --report docs/performance/shared-experience-storage.md
```

## 变体

- **A**：`scripts/benchmarks/shared-experience-v1-baseline.mjs`，从 commit `48c8f2e`（v0.2.4）抽取并冻结的 v1 实现：`events(id TEXT PRIMARY KEY, digest TEXT NOT NULL)`、`user_version=1`、WAL + `synchronous=FULL`，id/digest 是 64 字符小写 hex。
- **B**：`lib/shared-experience.js` 的 `openSharedExperience`（当前工作树）：schema v2，`events(id BLOB PRIMARY KEY, digest BLOB NOT NULL) STRICT, WITHOUT ROWID`，每行两个 32 字节 BLOB，`user_version=2`。

## 方法

- 场景：`uniform-ledger`（N 个唯一 event id、payload 完全相同、knowledge 只有 1 个身份，纯去重账本增长）；`diverse-knowledge`（每个事件 target 为 `tool:target-<i>`，knowledge 随身份一起增长）；`replay-duplicates`（完成 uniform-ledger 的 N 条后按原顺序重放，断言全部 duplicate 且行/字节不增长）。
- 每个（场景, size, 变体）至少 3 轮，交替 A/B 与 B/A；每轮每个样本用独立 `fs.mkdtempSync(os.tmpdir())` 根目录。
- 写入时钟固定为 `CLOCK_BASE_MS + i*1000`，使 A/B 的 knowledge body 可逐字节比较；延迟仍用 `performance.now()`，不受影响。
- checkpoint 协议：写完后 `store.close()`（SQLite 最后一个连接会 checkpoint 并删除 WAL），确认 `-wal` 不存在或 0 字节；之后只用只读 `DatabaseSync({readOnly:true})` 读 `dbstat`、`PRAGMA page_count/freelist_count` 和知识行，再用 `fs.statSync` 统计文件。所有体积数字都来自同一份已 checkpoint 的主库文件。
- 表中“close 前 WAL”是关闭前最后一刻的 WAL 大小（WAL 自动 checkpoint 阈值 1000 页，通常约 4 MiB）；关闭后该文件被删除，因此“目录总计”不含 WAL，两列不是同一状态下的占用。
- dbstat 分类：events 表 / events 索引（v1 的 `sqlite_autoindex_events_1`，v2 无独立索引）/ knowledge 表 / knowledge 索引（PK autoindex + `knowledge_recent`）/ 其他（clock、sqlite_schema）。
- 延迟：逐条 `recordFailure` 的 `performance.now()` 差值；size=1000 保留原始样本，size=10000 只保留聚合（p50/p95/max/mean/总耗时）；批量耗时是整段写循环的墙钟时间。

## 环境

- Node `v26.13.0`，`darwin/arm64`，文件系统 `apfs`，8 逻辑 CPU，16 GiB 内存。
- 被测源码版本：git HEAD `aaf043b25426b17d74200e931e077b1d039e550a`；`lib/shared-experience.js` sha256 `d47722fd751682f5df77a80b6388ce79c25ce0d17e0591c8fcfe4fe04441f037`，各文件哈希与工作树状态见 JSON 的 `sources`。
- 数据库都建在 `fs.mkdtempSync(os.tmpdir())` 隔离目录并清理，未使用真实 `$DSH_HOME` 或正式数据。

## 体积结果（每轮中位数）

### uniform-ledger

| size | 变体 | events 表 | events 索引 | events 合计 | knowledge 表 | knowledge 索引 | knowledge 合计 | 其他 | dbstat 总计 | page_count | freelist | 主库 | close 前 WAL | 目录总计 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 | A | 147456 B (144.0 KiB) | 81920 B (80.0 KiB) | 229376 B (224.0 KiB) | 24576 B (24.0 KiB) | 8192 B (8.0 KiB) | 32768 B (32.0 KiB) | 8192 B (8.0 KiB) | 270336 B (264.0 KiB) | 71 | 5 | 290816 B (284.0 KiB) | 3.98 MiB | 323584 B (316.0 KiB) |
| 1000 | B | 86016 B (84.0 KiB) | 0 B (0 B) | 86016 B (84.0 KiB) | 24576 B (24.0 KiB) | 8192 B (8.0 KiB) | 32768 B (32.0 KiB) | 8192 B (8.0 KiB) | 126976 B (124.0 KiB) | 36 | 5 | 147456 B (144.0 KiB) | 3.97 MiB | 180224 B (176.0 KiB) |
| 10000 | A | 1417216 B (1.35 MiB) | 811008 B (792.0 KiB) | 2228224 B (2.13 MiB) | 24576 B (24.0 KiB) | 8192 B (8.0 KiB) | 32768 B (32.0 KiB) | 8192 B (8.0 KiB) | 2269184 B (2.16 MiB) | 559 | 5 | 2289664 B (2.18 MiB) | 3.99 MiB | 2322432 B (2.21 MiB) |
| 10000 | B | 782336 B (764.0 KiB) | 0 B (0 B) | 782336 B (764.0 KiB) | 24576 B (24.0 KiB) | 8192 B (8.0 KiB) | 32768 B (32.0 KiB) | 8192 B (8.0 KiB) | 823296 B (804.0 KiB) | 206 | 5 | 843776 B (824.0 KiB) | 3.98 MiB | 876544 B (856.0 KiB) |

### diverse-knowledge

| size | 变体 | events 表 | events 索引 | events 合计 | knowledge 表 | knowledge 索引 | knowledge 合计 | 其他 | dbstat 总计 | page_count | freelist | 主库 | close 前 WAL | 目录总计 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 | A | 147456 B (144.0 KiB) | 86016 B (84.0 KiB) | 233472 B (228.0 KiB) | 2052096 B (1.96 MiB) | 77824 B (76.0 KiB) | 2129920 B (2.03 MiB) | 8192 B (8.0 KiB) | 2371584 B (2.26 MiB) | 579 | 0 | 2371584 B (2.26 MiB) | 3.94 MiB | 2404352 B (2.29 MiB) |
| 1000 | B | 86016 B (84.0 KiB) | 0 B (0 B) | 86016 B (84.0 KiB) | 2052096 B (1.96 MiB) | 77824 B (76.0 KiB) | 2129920 B (2.03 MiB) | 8192 B (8.0 KiB) | 2224128 B (2.12 MiB) | 543 | 0 | 2224128 B (2.12 MiB) | 3.95 MiB | 2256896 B (2.15 MiB) |
| 10000 | A | 1417216 B (1.35 MiB) | 827392 B (808.0 KiB) | 2244608 B (2.14 MiB) | 20529152 B (19.58 MiB) | 684032 B (668.0 KiB) | 21213184 B (20.23 MiB) | 8192 B (8.0 KiB) | 23465984 B (22.38 MiB) | 5729 | 0 | 23465984 B (22.38 MiB) | 3.98 MiB | 23498752 B (22.41 MiB) |
| 10000 | B | 794624 B (776.0 KiB) | 0 B (0 B) | 794624 B (776.0 KiB) | 20529152 B (19.58 MiB) | 684032 B (668.0 KiB) | 21213184 B (20.23 MiB) | 8192 B (8.0 KiB) | 22016000 B (21.00 MiB) | 5375 | 0 | 22016000 B (21.00 MiB) | 3.98 MiB | 22048768 B (21.03 MiB) |

### replay-duplicates

| size | 变体 | events 表 | events 索引 | events 合计 | knowledge 表 | knowledge 索引 | knowledge 合计 | 其他 | dbstat 总计 | page_count | freelist | 主库 | close 前 WAL | 目录总计 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 | A | 147456 B (144.0 KiB) | 81920 B (80.0 KiB) | 229376 B (224.0 KiB) | 24576 B (24.0 KiB) | 8192 B (8.0 KiB) | 32768 B (32.0 KiB) | 8192 B (8.0 KiB) | 270336 B (264.0 KiB) | 71 | 5 | 290816 B (284.0 KiB) | 3.98 MiB | 323584 B (316.0 KiB) |
| 1000 | B | 86016 B (84.0 KiB) | 0 B (0 B) | 86016 B (84.0 KiB) | 24576 B (24.0 KiB) | 8192 B (8.0 KiB) | 32768 B (32.0 KiB) | 8192 B (8.0 KiB) | 126976 B (124.0 KiB) | 36 | 5 | 147456 B (144.0 KiB) | 3.97 MiB | 180224 B (176.0 KiB) |
| 10000 | A | 1417216 B (1.35 MiB) | 811008 B (792.0 KiB) | 2228224 B (2.13 MiB) | 24576 B (24.0 KiB) | 8192 B (8.0 KiB) | 32768 B (32.0 KiB) | 8192 B (8.0 KiB) | 2269184 B (2.16 MiB) | 559 | 5 | 2289664 B (2.18 MiB) | 3.99 MiB | 2322432 B (2.21 MiB) |
| 10000 | B | 782336 B (764.0 KiB) | 0 B (0 B) | 782336 B (764.0 KiB) | 24576 B (24.0 KiB) | 8192 B (8.0 KiB) | 32768 B (32.0 KiB) | 8192 B (8.0 KiB) | 823296 B (804.0 KiB) | 206 | 5 | 843776 B (824.0 KiB) | 3.98 MiB | 876544 B (856.0 KiB) |

## 每事件边际成本（events 表 + 索引，1k→10k 增长斜率）

| 场景 | 计算 | A 边际 | B 边际 | 每事件节省 | 节省比例 |
| --- | --- | --- | --- | --- | --- |
| uniform-ledger | (bytes(10000) - bytes(1000)) / 9000 | 222.094 B | 77.369 B | 144.725 B | 65.2% |
| diverse-knowledge | (bytes(10000) - bytes(1000)) / 9000 | 223.460 B | 78.734 B | 144.725 B | 64.8% |

### 1k / 10k 的 events 表+索引占用与节省

| 场景 | size | A events 合计 | B events 合计 | 节省字节 | 节省比例 |
| --- | --- | --- | --- | --- | --- |
| uniform-ledger | 1000 | 229376 B (224.0 KiB) | 86016 B (84.0 KiB) | 140.0 KiB | 62.5% |
| uniform-ledger | 10000 | 2228224 B (2.13 MiB) | 782336 B (764.0 KiB) | 1.38 MiB | 64.9% |
| diverse-knowledge | 1000 | 233472 B (228.0 KiB) | 86016 B (84.0 KiB) | 144.0 KiB | 63.2% |
| diverse-knowledge | 10000 | 2244608 B (2.14 MiB) | 794624 B (776.0 KiB) | 1.38 MiB | 64.6% |

## 延迟（每轮中位数）

| 场景 | size | 变体 | 写入 p50 | 写入 p95 | 写入 max | 写入 mean | 写入总耗时 | 批量耗时 | 重放 p50 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| uniform-ledger | 1000 | A | 0.222 ms | 0.247 ms | 0.716 ms | 0.229 ms | 228.9 ms | 229.6 ms | — |
| uniform-ledger | 1000 | B | 0.217 ms | 0.243 ms | 0.792 ms | 0.224 ms | 223.8 ms | 224.5 ms | — |
| uniform-ledger | 10000 | A | 0.224 ms | 0.251 ms | 3.542 ms | 0.238 ms | 2380.2 ms | 2387.0 ms | — |
| uniform-ledger | 10000 | B | 0.219 ms | 0.247 ms | 1.613 ms | 0.229 ms | 2288.7 ms | 2295.5 ms | — |
| diverse-knowledge | 1000 | A | 0.114 ms | 0.152 ms | 1.591 ms | 0.127 ms | 127.3 ms | 128.0 ms | — |
| diverse-knowledge | 1000 | B | 0.113 ms | 0.150 ms | 1.483 ms | 0.122 ms | 122.2 ms | 122.7 ms | — |
| diverse-knowledge | 10000 | A | 0.114 ms | 0.140 ms | 5.856 ms | 0.146 ms | 1456.7 ms | 1463.0 ms | — |
| diverse-knowledge | 10000 | B | 0.111 ms | 0.137 ms | 5.855 ms | 0.139 ms | 1389.5 ms | 1395.4 ms | — |
| replay-duplicates | 1000 | A | 0.222 ms | 0.249 ms | 1.469 ms | 0.230 ms | 230.1 ms | 230.8 ms | 0.008 ms |
| replay-duplicates | 1000 | B | 0.217 ms | 0.244 ms | 0.910 ms | 0.224 ms | 224.3 ms | 225.0 ms | 0.008 ms |
| replay-duplicates | 10000 | A | 0.225 ms | 0.253 ms | 3.242 ms | 0.238 ms | 2384.4 ms | 2390.9 ms | 0.008 ms |
| replay-duplicates | 10000 | B | 0.218 ms | 0.244 ms | 2.189 ms | 0.227 ms | 2272.2 ms | 2279.1 ms | 0.008 ms |

### B/A 延迟比与 open 成本

| 场景 | size | 写入 p50 B/A | 写入总耗时 B/A | 重放 p50 B/A |
| --- | --- | --- | --- | --- |
| uniform-ledger | 1000 | 98.0% | 97.7% | — |
| uniform-ledger | 10000 | 98.0% | 96.2% | — |
| diverse-knowledge | 1000 | 98.4% | 96.0% | — |
| diverse-knowledge | 10000 | 97.5% | 95.4% | — |
| replay-duplicates | 1000 | 97.8% | 97.5% | 105.2% |
| replay-duplicates | 10000 | 96.9% | 95.3% | 103.6% |

| open 场景 | A 中位数 | B 中位数 | B/A |
| --- | --- | --- | --- |
| 空根建库 open+close（20 次/轮/变体） | 0.850 ms | 0.798 ms | 93.8% |
| 已存在库 open（20 次/轮/变体，uniform-ledger 最大 size） | 0.307 ms | 0.307 ms | 100.2% |

重放命中路径（事件已存在，只做 SELECT + COMMIT）的 B−A 绝对差：size 1000: 0.0004 ms（105.2%）；size 10000: 0.0003 ms（103.6%）。这是亚微秒到一微秒量级的差异，且低于同一路径的轮次波动。

延迟回退判定容差（写入 p50/总耗时 B ≤ 1.25×A + 0.02 ms，open B ≤ 1.5×A + 1 ms）记录在 `selfChecks`。

## 正确性自检

| 检查 | 结果 |
| --- | --- |
| frozen-baseline-verification | 通过 |
| no-wal-after-close | 通过 |
| core-schema-version-2 | 通过 |
| conflict-raised-both-variants | 通过 |
| knowledge-identical-uniform-ledger-1000 | 通过 |
| knowledge-identical-diverse-knowledge-1000 | 通过 |
| replay-duplicates-A-1000-round-0 | 通过 |
| replay-duplicates-A-1000-round-1 | 通过 |
| replay-duplicates-A-1000-round-2 | 通过 |
| replay-duplicates-B-1000-round-0 | 通过 |
| replay-duplicates-B-1000-round-1 | 通过 |
| replay-duplicates-B-1000-round-2 | 通过 |
| knowledge-identical-uniform-ledger-10000 | 通过 |
| knowledge-identical-diverse-knowledge-10000 | 通过 |
| replay-duplicates-A-10000-round-0 | 通过 |
| replay-duplicates-A-10000-round-1 | 通过 |
| replay-duplicates-A-10000-round-2 | 通过 |
| replay-duplicates-B-10000-round-0 | 通过 |
| replay-duplicates-B-10000-round-1 | 通过 |
| replay-duplicates-B-10000-round-2 | 通过 |
| events-bytes-smaller-uniform-ledger-1000 | 通过 |
| events-bytes-smaller-uniform-ledger-10000 | 通过 |
| events-bytes-smaller-diverse-knowledge-1000 | 通过 |
| events-bytes-smaller-diverse-knowledge-10000 | 通过 |
| marginal-smaller-uniform-ledger | 通过 |
| marginal-smaller-diverse-knowledge | 通过 |
| write-latency-uniform-ledger-1000 | 通过 |
| write-latency-uniform-ledger-10000 | 通过 |
| write-latency-diverse-knowledge-1000 | 通过 |
| write-latency-diverse-knowledge-10000 | 通过 |
| write-latency-replay-duplicates-1000 | 通过 |
| write-latency-replay-duplicates-10000 | 通过 |
| open-latency | 通过 |
| migration-hex-equal | 通过 |
| migration-knowledge-equal | 通过 |
| migration-row-counts-equal | 通过 |
| migration-cli-exit-zero | 通过 |
| migration-v2-blob32 | 通过 |
| migration-dry-run-noop | 通过 |

冻结基线自检（`--verify-baseline`）：把 `git show 48c8f2e:lib/shared-experience.js` 写进临时目录、用独立 Node 进程动态 import 运行，比对两者创建的 sqlite_master SQL、`user_version`、`SELECT id,digest FROM events ORDER BY id` 和 `SELECT key,body FROM knowledge ORDER BY key`；本结果：
`完全一致`。

复放场景断言全部 duplicate=true、事件行数仍为 N、events 字节与同轮 uniform-ledger 相同；同 id 不同内容仍抛 `E_EXPERIENCE_EVENT_CONFLICT` 且不增加行。

迁移前先跑 `--dry-run`：主库文件 sha256、`user_version` 与全部事件行在 dry-run 前后完全不变，之后才执行真实迁移。

`knowledge` 对照同时比较两次摘要：写入时钟被钉住后的 `SELECT key, body` 全字节 sha256（因此逐字节一致），以及去掉 `firstSeen`/`lastSeen`/`updatedAt`/`recentEvidence`/`trend` 后的稳定投影 sha256。两版 `key`、revision 与 knowledge 行数也必须一致；体积测量仍使用真实 dbstat 字节，不因时钟钉住而改变。

## 迁移成本

用冻结基线生成 1000/10000 条的 v1 库（场景 1、场景 2 各一份），先跑 `--dry-run` 验证不改库，再跑真实迁移 CLI。

| 场景 | size | 迁移墙钟 | 主库迁移前 | 主库迁移后 | events 迁移前 | events 迁移后 | freelist 后 | 备份文件 | dry-run | hex 一致 | knowledge 一致 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| uniform-ledger | 1000 | 144.1 ms | 284.0 KiB | 112.0 KiB | 224.0 KiB | 72.0 KiB | 0 | 284.0 KiB | 0/114.5 ms | 是 | 是 |
| uniform-ledger | 10000 | 229.3 ms | 2.18 MiB | 740.0 KiB | 2.13 MiB | 700.0 KiB | 0 | 2.18 MiB | 0/115.5 ms | 是 | 是 |
| diverse-knowledge | 1000 | 159.4 ms | 2.26 MiB | 2.11 MiB | 228.0 KiB | 72.0 KiB | 0 | 2.26 MiB | 0/118.6 ms | 是 | 是 |
| diverse-knowledge | 10000 | 488.2 ms | 22.38 MiB | 20.86 MiB | 2.14 MiB | 700.0 KiB | 0 | 22.38 MiB | 0/123.5 ms | 是 | 是 |

迁移后 `SELECT hex(id), hex(digest)` 与迁移前 TEXT 逐行一致；`typeof(id)='blob' AND length(id)=32` 的行数等于原事件数。dry-run 输出与迁移 CLI 的 JSON 报告保存在原始数据 JSON 的 `migration.samples[].{dryRun,report}`。

## 结论

- events 账本每事件边际成本：uniform-ledger 从 222.094 B 降到 77.369 B（节省 65.2%）；diverse-knowledge 从 223.460 B 降到 78.734 B（节省 64.8%）。
- uniform-ledger @ 10000：events 表+索引 2.13 MiB → 764.0 KiB，主库 2.18 MiB → 824.0 KiB。
- diverse-knowledge @ 10000：events 表+索引 2.14 MiB → 776.0 KiB，主库 22.38 MiB → 21.00 MiB。
- knowledge 表+索引两版相同（同一 canonical 写入模块）：uniform-ledger @ 10000 均为 32.0 KiB，diverse-knowledge @ 10000 均为 20.23 MiB；体积收益全部来自 events 账本本身。
- 写入/open 延迟：所有场景在既定容差内，没有观察到明显回退。

## 未验证项与边界

- 单写者、本机 apfs 临时目录；未测慢盘、网络文件系统、高并发写、断电/SIGKILL 崩溃恢复。
- 未测 Desktop UI 端到端、未测真实 `$DSH_HOME` 数据、未测迁移真实用户库的极端形状。
- 延迟只反映本机 Node/V8 与 SQLite 组合；p50/p95 是 3 轮中位数，仍可能受 GC 与调度噪声影响，原始样本已保留在 JSON。写入 max 在 A/B 两侧都偶发 30–70 ms 长尾（不同轮次随机出现，p95 仍为 0.14–0.26 ms），因此回退判定用 p50 与总耗时，不拿单次 max 当结论。
- 体积数字都来自 `store.close()` 后的 checkpointed 主库；未做 VACUUM，因此包含 SQLite 空闲页的真实状态，不把理论行宽当作实测值。
- 迁移耗时只覆盖 CLI 墙钟，不包含操作者停机窗口或备份拷贝到别处的成本；迁移后主库字节受备份文件位置影响，备份文件单独统计。

