# 高频 observe 事务的持久提交成本：21.6 ms 是 fsync，不是可消除的重复工作（2026-11-09）

基线是 `main` 的 `b690fe0`（已合并 PR #35 的扫描备忘续证）。本轮的假设是：一次触发归档的
高频故障观测里，那 27–30 ms（本轮在 20,000 条测得 26.90 ms）的「领域文档写入 + 暂存同步 +
归档安装」成本中可能存在可以安全消除的重复工作。

**结论：不存在满足验收门槛的候选。** 那 27–30 ms 里 **21.6 ms（80%）是 9 次同步调用的等待**，
每一次都对应一个独立的崩溃恢复义务，没有同目标重复；其余约 5 ms 是安装前的内容校验
（2.43 ms）、原子替换的元数据操作（1.49 ms）与序列化/校验（约 1 ms），也都各自压在一个不变式
上。看起来可省的三处（安装二次读、写路径前缀证明、复用内存摘要）合计约 7.2 ms（9.1%），
但每一处都会削弱内容认证或改变失败行为，本轮**全部不采用**。

因此 **`lib/` 与 `b690fe0` 逐字节相同，生产代码、持久化格式、事务语义、fsync 次数、
恢复行为全部不变。** 本文件交付的是可复现的归因、拒绝理由与故障注入反例，供后续轮次不再
重试这些方向。

原始数据：[`observe-transaction-commit-cost-20261109.json`](observe-transaction-commit-cost-20261109.json)
（8k/20k/50k）与 [`…20261109.repeat.json`](observe-transaction-commit-cost-20261109.repeat.json)（20k 重复测量）。
脚本：[`scripts/benchmarks/observe-commit-cost.mjs`](../../scripts/benchmarks/observe-commit-cost.mjs)。
独立只读审计（另一个 agent 实例，只读、未跑基准）：[`observe-commit-redundancy-audit-20261109.md`](observe-commit-redundancy-audit-20261109.md)。
环境：Node `v26.13.0` / darwin-arm64 / 8 逻辑 CPU / 16 GiB；测量期开始与结束 load average
`1.30 1.46 1.72` → `1.55 1.62 1.70`（机器不是专用空闲环境）。

## 1. 调用链

`registration` 的两个 emit 监听器（`agent/error`、`tools/result`）→ `observeAutonomous()` →
`port.observe()` → `enqueue()` → `mutate()`。一次触发了归档写入的 `mutate()` 依次做：

1. `installPending()`（恢复检查，无 pending 时只读一次文档）；
2. `mirrorArchives()` 建硬链接镜像 + 暂存 `Memory` 加载；
3. `work()` → `EvolutionObservationStore.record()` → 内存追加、驱逐到活动档案；写路径
   `privatizeArchiveFile()` 先给活动档案一个私有副本；
4. `flushDeferredArchiveIndex()` 把归档索引写进暂存目录；
5. `changedArchiveFiles()` 对每个不再是 live 文件的暂存文件算出 `{bytes, sha256}`；
6. `syncStage()` 对每个 changed 文件与 stage 目录/staging 根做 fsync；
7. 发布 pending 记录（第一次整份领域文档写，`domain.global.set`）；
8. `installPending()` 校验整份文档与每个暂存文件的摘要，再 `link+rename` 原子安装、fsync 目的地
   目录，最后写收尾文档（第二次整份写）；
9. `publishArchiveScanSeeds()` + `hydrate()` 加载提交后的 live `Memory`；
10. 观察者在提交之后读回证据：`autonomousObservations()`，这是新 live 实例的**第一次**档案读取。

## 2. 测量方法

真实官方 `@deepseek-ai/dsh-storage-domain` 的 `DomainFacility` 与
`@deepseek-ai/dsh-storage-json` 的 `JsonStorageBackend`，每个样本一份新临时数据根。

- 夹具：先用真实路径写一条观测取真实行形状（约 1.07 KB/行），再按同一形状合成 8,000 /
  20,000 / 50,000 条，并由一次真实加载完成归档、索引与段轮转。不是用户数据。
- 归因：`--attribute` 把 `lib/` 复制到临时目录并插入表达式级计时器（`__A(key, ms, bytes)`）。
  每个锚点必须唯一匹配，移动过就失败而不是静默少报。同时给 `node:fs` 的同步与异步入口加了
  计时包装，按 fd→路径映射统计每个文件的读取次数与字节，并记录两次整份文档写的字节数。
- 每一步 = 一次 `port.observe()` + 提交后的一次 `autonomousObservations()`（与真实观察链顺序
  相同）；先做 3 次不计时预热，再取 10 步。`wall/step` 覆盖这两段。
- 断言：`mutate` 的直接子阶段之和与 `mutate.total` 相差 < 5%（实测 98.3–99.1% 覆盖），
  所以表里的阶段不是子集冒充整体。
- 噪声刻度：20,000 条上本脚本测得 `79.12 / 80.86 / 82.97 ms`（三次，极差 4.9%，即 ±2.4%），
  同步合计 `21.6–22.7 ms`（±2.5%），两次内容证明 `24.7–25.1 ms`。另有一次更密插桩（多 10 个
  锚点）的对照是 83.77 ms，绝对值不与前者直接比较。**因此小于约 2 ms（2.5%）的候选就落在
  本机重复测量噪声内。**

## 3. 归因：一次 observe 的钱花在哪

单位 ms/step（每步一次完整事务 + 一次提交后证据读取）。

| 阶段 | 8,000 条 | 20,000 条 | 50,000 条 |
| --- | ---: | ---: | ---: |
| **端到端 wall** | **50.68** | **79.12** | **130.67** |
| `mutate` 合计 | 44.59 | 65.68 | 95.86 |
| 提交后证据读取（新 live 实例的第一次读） | 5.79 | 13.35 | 34.62 |
| 两次实例级内容证明（`memory.inheritedReads`，2 次/步） | 10.44 | 24.67 | 62.69 |
| 其中：暂存实例（`#sourceMatches` 触发的 `#archiveRead`） | 5.50 | 13.68 | 33.96 |
| 暂存 `Memory` 加载（`createMemory` + `instance.load`） | 1.55 | 1.71 | 4.30 |
| `work()` 合计（含归档追加与知识匹配） | 10.42 | 28.56 | 56.34 |
| 其中：`memory.archiveEntries` | 2.62 | 11.08 | 14.97 |
| 其中：`#sourceMatches` 的键表扫描（不含读取） | 1.36 | 2.89 | 6.39 |
| 暂存同步 `syncStage` | 5.71 | 5.71 | 6.73 |
| staged 文件 fsync（2 次） | 3.12 | 3.50 | 3.87 |
| stage 目录 + staging 根 fsync（2 次） | 2.58 | 2.20 | 2.85 |
| pending 记录写（第一次整份领域文档写） | 8.40 | 7.10 | 6.31 |
| `installPending` 合计 | 12.89 | 15.14 | 14.74 |
| 其中：整份文档校验 `schema.parse`（2 次/步） | 0.50 | 0.49 | 0.56 |
| 其中：安装（`installArchiveFiles`） | 5.00 | 6.86 | 6.48 |
| 其中：收尾文档写（第二次整份写） | 6.78 | 7.24 | 7.16 |
| live `Memory` 加载（`hydrate`） | 2.17 | 1.90 | 2.02 |
| 私有化副本（`privatizeArchiveFile` 的 copy） | 0.36 | 3.46 | 2.57 |
| 变更清单（`changedArchiveFiles`，读+sha256） | 0.21 | 2.46 | 1.91 |
| 写路径前缀证明（`#archivePrefixDigest`） | 0.12 | 2.35 | 1.74 |
| 解析缓存扩展的整表复制（`memory.cacheCopy`） | 0.86 | 2.00 | 5.20 |
| 归档索引写（`flushDeferredArchiveIndex`） | 0.74 | 0.60 | 0.75 |
| 归档重扫（`memory.scanArchiveRead`，应≈0） | 0.02 | 0.02 | 0.03 |
| `mirrorArchives`（硬链接镜像） | 1.04 | 1.01 | 1.11 |
| 写 manifest + 快照 + 入口恢复检查 + CAS 检查等 | ≈1.39 | ≈1.39 | ≈1.51 |

同步调用与 I/O（每步）：

| 计数 | 8,000 条 | 20,000 条 | 50,000 条 |
| --- | ---: | ---: | ---: |
| `fsyncSync` | 5 次 / 8.87 ms | 5 次 / 8.47 ms | 5 次 / 9.77 ms |
| 后端 `handle.sync` | 4 次 / 13.98 ms | 4 次 / 13.14 ms | 4 次 / 12.18 ms |
| **同步合计** | **22.84 ms（45.1% wall）** | **21.61 ms（27.3%）** | **21.95 ms（16.8%）** |
| `readFileSync` | 11 次 / 0.32 MB | 11 次 / 9.33 MB | 11 次 / 6.67 MB |
| `readSync`（内容证明 + 前缀证明） | 31 次 / 17.6 MB | 61 次 / 56.9 MB | 130 次 / 117.3 MB |
| 领域文档字节（pending / 收尾） | 192.3 / 95.0 KB | 192.8 / 95.3 KB | 194.7 / 96.3 KB |
| 归档重扫 | ≈0 | ≈0 | ≈0 |

读法：

1. **持久提交成本是 fsync 成本。** 「pending 写 + 暂存同步 + 安装 + 收尾写」在 20,000 条时是
   `7.10 + 5.71 + 6.86 + 7.24 = 26.90 ms`，其中同步等待 21.61 ms（80%）。文档字节只有
   192.8 / 95.3 KB，序列化本身 0.36 ms，写数据 0.15 ms —— 慢的是 APFS 的每次 flush，
   单次 1.7–3.5 ms，与文件大小基本无关（数 KB 的索引文件 fsync 也要 2–3 ms）。
2. **同步次数随历史规模不变**（恒为 9 次），两次内容证明随冷档案字节线性增长：8,000 条时
   同步占 45.1%，50,000 条时只剩 16.8%，而两次证明升到 48.0%。所以「27–30 ms 的固定提交
   成本」只在中小历史是可感知的主要成本。
3. **两次内容证明各把整个冷档案读一遍并做一次 SHA-256**（20,000 条：`readSync` 56.9 MB/步，
   其中两次证明各约 21 MB）。这是恢复/隔离契约：每个继任实例必须亲自读它第一次扫描会读的
   文件（包括 EACCES/EIO），再用内容摘要证明继任解析可以复用。跳过它正是
   [`observe-transaction-digest-walk-20261107.md`](observe-transaction-digest-walk-20261107.md) §4
   用反例撤回的方向。
4. **没有发生归档重扫**（`memory.scanArchiveRead` ≈ 0.02 ms/步）：PR #35 的扫描备忘续证与
   `hydrate()` 的种子发布有效，20,000 条的重解析成本确实已被消除，本轮的分项里不再有它。
5. `readFileSync` 的 9.33 MB 恰好是同一份 4.66 MB 暂存 inode 被 `changedArchiveFiles` 与
   `installArchiveFiles` 各读一遍。

## 4. 九次同步各自的义务（没有同目标重复）

| # | 目标 | 关闭的崩溃窗口 |
| ---: | --- | --- |
| 1 | pending 文档数据 | 官方 JSON 后端的原子替换协议：临时文件 fsync 后 rename |
| 2 | `official/` 目录 | 让第 1 次 rename 的目录项持久 |
| 3 | 暂存活动档案数据 | pending 记录会引用这些字节；恢复时按记录里的摘要逐字节校验，未持久化只能是拒绝（永久 pending 拒绝）或被截断安装 |
| 4 | 暂存归档索引数据 | 同上；索引是 pending 安装列表里的一项 |
| 5 | stage 目录 | pending 记录以 `domain-staging/stage-<uuid>` 命名该目录，目录项不持久则恢复找不到它（`E_DOMAIN_PENDING_ARCHIVE_MISSING`），数据根会被卡住 |
| 6 | staging 根 | 让 stage 目录名本身持久 |
| 7 | live 归档根目录 | 安装用 `link+rename` 发布；目录项必须在收尾文档清掉 `pending` 之前持久，否则崩溃可能留下「聚合描述了记录、档案字节不在 live 树」 |
| 8 | 收尾文档数据 | 同 #1 |
| 9 | `official/` 目录 | 让第 8 次 rename 持久（第 2 次目录 fsync 覆盖不了它之后的 rename） |

两次整份写、四个后端同步、五个目录/文件同步都不是本插件可选的：`domain.global.set` 的
耐久性属于官方后端，其余五次各自对应上面的窗口。`domain-derived-fsync.md` 里真正可删的
两处派生 fsync 早已删除，本轮复核没有发现新的同目标重复。

## 5. 重复工作候选：逐条复核与拒绝理由

| 候选 | 每事务重复 | 实测可省（20,000 条） | 结论 |
| --- | --- | ---: | --- |
| A 去掉 `installArchiveFiles` 的二次 `readFileSync`+sha256 | 同一暂存 inode 读 2 次、哈希 2 次 | 2.43 ms（3.1%） | **不可采用**：见 §6 反例，会把与 committed 摘要不一致的字节装进 live 树 |
| B 把内存已证摘要传给 `changedArchiveFiles` | 活动档案内容证明 1 次 | 2.35–2.46 ms（3.1%） | **不可采用**：摘要形态是「解码文本 SHA-256」，pending 需要「原始字节 SHA-256」（`archive-digest-walk.test.mjs` 钉住非法 UTF-8 两者不同）；覆盖不到索引/新段/删除；摘要来自 append 时刻，落盘后若有漏掉的失效路径会让 pending 摘要不描述暂存字节，导致安装与恢复永久拒绝 |
| C 复用暂存实例子内容证明的结果，跳过写路径前缀证明 | 活动档案读 2 次 | 2.35 ms（3.0%） | **不可采用**：前缀证明要证明的是「私有化副本的字节 == 继任解析覆盖的字节」；两次内容证明之间隔着一次 `copyFileSync`，用 dev/ino/size/mtime 替代就是削弱内容认证（同 `observe-cache-read-fault.test.mjs` 的 utimes 反例） |
| D 只写一次领域文档（合并 pending 与收尾） | 2 次整份写 | CPU 约 1–1.5 ms；**fsync 不变** | **不可采用**：pending 记录必须在安装前成为提交点，收尾必须清掉它；合并需要新的提交协议与恢复证据视图，超出「最小改动、不新增持久化协议」 |
| E 跳过某次 fsync | — | 0 | **无可消除项**：见 §4 |
| F `schema.parse` / `stableJson` / `aggregateDigest` 复用 | 5 个 aggregate 投影 | 约 0.7 ms | **不可采用**：3 处校验各有独立失败边界（入口、发布前、安装前），`redundant-work.md` §4.2 与 2026-10-24 的 identity-skip 已否决同类；`stableJson`/`aggregateDigest` 在常规路径因 `latest.aggregate === baseline.aggregate` 短路，实际 0 次 |
| G 用 APFS clone 代替私有化副本 | 整份活动档案 copy | 3.46 ms（4.4%） | **本机不可得**：Node 的 `COPYFILE_FICLONE` 在 macOS 上不做 clone（`COPYFILE_FICLONE_FORCE` 返回 `ENOSYS`；200 MB 文件 FICLONE 318 ms、`cp -c` 3 ms），Node 没有 in-process clone API；Linux 上该调用本身就是 clone，这个成本主要只在本机平台存在。为它加原生依赖不属于最小改动 |
| H 去掉解析缓存扩展的整表复制 | 活动键表 O(n) 复制 | 2.00 ms（2.5%） | **不可采用**：前驱视图必须继续服务并发读（读者不经 `enqueue`），去复制需要结构共享；`observe-transaction-digest-walk-20261107.md` §4 已作为边界记录否决 |
| I 给知识键匹配加索引 | `#sourceMatches` 键表扫描 | 2.89 ms（3.7%） | **不可采用（已有反例）**：`knowledge-key-scan.md` 实测 Map 索引把 40,000 行保留堆从 24.33 MiB 抬到 60.39 MiB，排序位置索引在持续归档负载回退 3.67% |

上表说明的是同一件事：**这条事务路径上确实有成倍的文件读取与序列化，但每一处重复都压在一条
明确的不变式上，能安全去掉的已经被前几轮去掉了。** 合计「理论上可省」约 7.2 ms（9.1%），
分散在 4 个彼此独立、风险性质不同的改动里；没有一项单独达到验收门槛，合起来也不构成一次
可以只改一处的最小交付，而且 A/B/C 三项都会削弱内容认证。

## 6. 故障注入反例：安装二次读不是重复工作

`scripts/benchmarks/observe-commit-cost.mjs --counterexample` 在 `changedArchiveFiles()` 之后、
安装之前把一条已记录摘要的暂存文件原地改写（同 inode、同长度、只换内容；mtime 用 `utimes`
尽力恢复）。这是同一进程内 `domain/changed` 监听器可触达的窗口，不是外部攻击面假设。

| 实现 | `port.observe()` | live 活动档案含被篡改字节 | 遗留 pending 记录 | 再次打开 |
| --- | --- | --- | --- | --- |
| 现行树 | committed | 否 | 否 | committed |
| 现行树 + 注入 | `E_DOMAIN_PENDING_ARCHIVE_CORRUPT` | **否**（live 树未改动） | 是 | 拒绝打开（同一错误） |
| 候选（只删安装的 read+digest 校验） | committed | 否 | 否 | committed |
| 候选 + 注入 | committed | **是** | 否 | committed |

注入留下的证据：`bytesUnchanged: true`、`devSame/inoSame/sizeSame: true`、
`expectedDigest` 与 `actualDigest` 不同。也就是说**变更清单记录的摘要来自改写前，安装发布的
字节来自改写后**；现行树在安装点用内容读把两者绑在一起（宁可拒绝也不发布前缀），候选只信任
变更清单，于是把摘要描述不了的字节装进了 live 树。同一类「同长度、恢复时间戳的中段篡改」已由
`test/domain-storage/event-log-checkpoint.test.js`
（`every replay reads the full prefix and rejects same-size middle tampering with restored timestamps`）
与 `test/observe-cache-read-fault.test.mjs`
（`a successor observes changed bytes even when the full file identity is restored`）钉住，
所以用 dev/ino/size/mtime 围栏替代内容读不成立。

现行树的拒绝会留下一条已提交的 pending 记录与暂存目录（`E_DOMAIN_PENDING_ARCHIVE_CORRUPT`
没有 repair），这是既有失败行为；本轮只记录，不改变它。

## 7. 其它真实热点比较

按任务要求，若这条方向没有合格候选就重新比较其它热点。本轮核对到的其它成本中心：

- **两次实例级内容证明（20,000 条 24.67 ms，50,000 条 62.69 ms，占单步 31.2% / 48.0%）**：占比最大，
  但跳过它就是 20261107 §4 用反例撤回的「继任实例不再亲自读档案」。单独实现一次「同一进程内
  已证明」的信任握手需要新的恢复/隔离证据视图，属于协议级改动，不在本轮授权内。
- **知识键匹配扫描（2.89 / 6.39 ms）**：索引方向已有反例（内存 +36 MiB、持续归档回退），
  `knowledge-key-scan.md` 明确不保留运行时改动。
- **事件同步 / flush 稳态（每次 `agent/pre-step` 与工具调用都跑）**：`domain-flush-steady-cost.md`
  与 `redundant-work.md` §4.1 已用五组反例撤回摘要复用；`event-log-replay-memory.md` 撤回了
  读取侧物化候选。该路径本轮没有新的安全候选。
- **实例加载（`createMemory` 2 次/事务，20,000 条 3.21 ms，50,000 条 5.91 ms）**：每次加载都要
  `inspectArchiveIntegrity()`（20,000 条时 2 次共 1.06 ms，负责索引完整性与故障分类）与
  `#loadArchiveIndex()`（2 次共 0.20 ms）+ 逐集合协调索引。前者不是重复读而是完整性证据，
  后者读的是 5.3 KB 的索引文档；没有可安全删除的整段。
- **私有化副本（3.46 / 2.57 ms）**：平台相关，见 §5 G。
- **冷启动、doctor、迁移、经验检索**：不在高频 observe 事务路径上，本轮没有测量，也不据此
  声称任何结论。

## 8. 结论、收益边界与剩余风险

- **本轮不改生产代码。** 这条路径的 27–30 ms 不是「重复工作」，是 9 次耐久性等待加两处必需的
  内容校验；要达到 10% 级别的端到端收益，必须改提交协议（合并两次整份写、跳过继任读取或引入
  新的信任握手），那会改变恢复语义与证据视图，明确超出本轮「最小改动、保留架构、不新增持久化
  协议」的约束。
- **收益边界**：同步成本随历史规模基本不变（21.6–22.8 ms），内容证明随冷档案字节线性增长。因此在
  8,000 条时同步是 45.1% 的主要成本、没有可安全消除项；20,000–50,000 条时证明才是主要成本、
  而它被契约钉住。两个方向都不存在「改一处、收益过噪声、风险可控」的候选。
- **剩余风险**：(a) 所有数字来自单机 macOS APFS（上层文件系统与 CI 的 Linux 不同，fsync 延迟
  与 clone 行为都不同），不外推到 p99 或其它平台；(b) 夹具是合成行形状，历史规模只到 50,000
  条；(c) 归因依赖源码锚点插桩，锚点移动会让脚本失败而不是静默错报（这是刻意的）；
  (d) §6 的注入是进程内改写，不是真实断电或介质故障；真实崩溃恢复由既有回归与
  `domain-durability` 系列覆盖，本轮没有重跑。

## 9. 本轮实际执行的检查

| 检查 | 结果 |
| --- | --- |
| `node --max-old-space-size=4096 --expose-gc scripts/benchmarks/observe-commit-cost.mjs --attribute --histories 8000,20000,50000 --steps 10` | 通过；三档阶段覆盖 `mutate.total` 98.3% / 98.8% / 99.1% |
| 同上 `--counterexample` | 通过；见 §6 |
| `NODE_OPTIONS=--max-old-space-size=4096 npm test` | 1,471 项：1,469 通过、2 跳过、0 失败（Node v26.13.0，53 s） |
| `npm run pack:check` | 17 项全部通过；工作树仍是固定发布内容的开发后继，固定点与产物未变（本文件与 `docs/`、`scripts/benchmarks/` 不在分发内容内） |
| 真实宿主隔离验收 | **未重跑**：本轮没有运行时或分发改动，没有可验收的行为变化 |

## 复现

```sh
node --max-old-space-size=4096 --expose-gc scripts/benchmarks/observe-commit-cost.mjs \
  --attribute --histories 8000,20000,50000 --steps 10 \
  --out docs/performance/observe-transaction-commit-cost-20261109.json
node --max-old-space-size=4096 --expose-gc scripts/benchmarks/observe-commit-cost.mjs \
  --counterexample --out /tmp/observe-commit-counterexample.json
```
