# 历史容量回收：本轮评估结论与阻塞（2026-10-26）

## 1. 结论

**本轮不交付任何历史容量回收机制。** 冷档案总量、`execution-events.jsonl` 与领域 `applied` 表继续随历史单调增长，与
`README.md` 第 16 条已知限制一致。

本轮实际推进的是**回收的前置安全条件**，不是回收本身：

| 项目 | 本轮结果 |
| --- | --- |
| 归档重写不得洗掉损坏证据 | **已关闭并有回归**。`#rewriteArchives()` 在任何文件被改动前拒绝 9 类 finding（`archive-invalid-line` / `archive-torn-tail` / `archive-unusable-line` / `archive-file-unreadable` / `archive-segment-directory-unreadable` / `archive-sealed-size-mismatch` / `archive-sealed-digest-mismatch` / `archive-index-target-missing` / `archive-loss-evidence`），抛 `E_ARCHIVE_REWRITE_UNSAFE` 且不改动归档字节。这是上一轮 `maintenance()` 接线被撤回的第 2 个阻塞（"坏字节被成功 GC 洗掉"），现已关闭。 |
| 归档重写的回滚必须同时还原索引 | **已修复并有回归**。`#rewriteArchives()` 的 `rollback` 现在按字节还原索引文档（原本不存在则删除），并从磁盘重新加载索引；索引还原失败时挂在 `error.rollbackError` 上，不替换主错误。 |
| 索引状态不可分类时不得重写 | **已修复并有回归**。索引在 `load()` 之后变为不可读/不可解析时，`#rewriteArchives()` 与启动路径用同一判据抛 `E_ARCHIVE_INDEX_STATE_UNKNOWN`，不再用当前字节重建索引。修复前的实测后果见 §4.1。 |
| 归档段删除语义 | **仍阻塞**。变更清单只能表达"存在且已改变"，不能表达删除；拒绝复现见 §4.2。 |
| `applied` 裁剪与日志截断 | **仍阻塞**。checkpoint 保存整张 `applied` 表摘要，裁剪一个 marker 就让已消费前缀完全失去可信性；截断日志会丢失老 promotion 的取数来源。见 §4.3、§4.4。 |
| 收益上限 | 已测（§4.5），但**该上限不可安全拿到**，不作为已交付收益。 |

细节与证据：

- 密封归档"预期摘要不被覆盖"的缺陷、修复与修复前后回归：[archive-sealed-expectation.md](archive-sealed-expectation.md)。
- 三个阻塞的复现脚本与实测输出：[retention-reclaim-blockers.md](retention-reclaim-blockers.md)、[retention-reclaim-blockers.json](retention-reclaim-blockers.json)。
- 上一轮撤回的 `maintenance()` 接线与事件日志/标记回收：[capacity-20261026.md](capacity-20261026.md) §4。

## 2. 四个持久对象之间的真实关系

以下全部来自当前源码，函数名为准，行号会随改动漂移。

### 2.1 冷档案

| 角色 | 实现 |
| --- | --- |
| 路径 | `<stateFile>.<collection>-archive.jsonl`（活动文件）、`<活动文件>.segments/segment-N.jsonl`（封存段）、`<stateFile>.evolution-archive-index.json`（索引）。由 `EvolutionMemory` 构造器确定。 |
| 写入者 | `EvolutionMemory#archiveEntries()`（追加活动文件并按 `archiveMaxBytes` 封存）、`#sealArchive()`、`#rewriteArchives()`（整目录替换某 collection 的段目录）。domain 事务额外经 `mirrorArchives()` / `changedArchiveFiles()` / `installArchiveFiles()`（`lib/archive-stage.js`）。 |
| 读取者 | `#readArchiveSync()`；`history()` / `fullSnapshot()` / `historyWindow()` 经 `#mergeArchived()`；`inspectArchiveIntegrity()`（`lib/archive-stage.js`，runtime 与 doctor 共用）；`verifyConsistency()` 经 `#archiveConsistencyReport()`。 |
| 集合权威 | **实际目录内容**，不是索引白名单：`#archiveFiles()` 枚举 `.segments/` 的真实目录项再拼上活动文件路径。因此"索引里不列某个段"不等于"不会读到它" —— 这正是 §4.2 反例的机制。 |
| 索引字段 | `sealed` / `checksumState`（`final` 仅封存段）/ `byteSize` / `sha256`（封存段为 64 位小写 hex，活动文件为 `null`）。由 `#indexEntryFromRaw()` 生成。 |
| 校验入口 | `load()` 经 `#reconcileArchiveIndex()` 比较索引与实际文件；`verifyConsistency()` 重算全部摘要；`archiveIntegrity()` 故意传 `scanContents: false`，不重算摘要；doctor 的 `inspectArchiveIntegrity()` 默认 `scanContents: true`。 |

### 2.2 `execution-events.jsonl`

| 角色 | 实现 |
| --- | --- |
| 路径 | `<dataRoot>/execution-events.jsonl`，由 `resolveEvolutionPaths()` 给出（`lib/diagnostics.js`），doctor 与运行时共用。 |
| 追加者 | `EvolutionEventBridge.persistPending()`（`lib/orchestrator.js`）。envelope 为 schema 2，MAC 覆盖规范化 `{schema, writer, sequence, event}`。 |
| 追加互斥 | `<log>.append.lock` 目录 + 同级 `<lock>.reclaim` 标记；同主机存活 pid 永不回收。 |
| 尾边界 | 追加前必须证明尾字节：文件不以 `\n` 结尾时，末行必须是完整且验签通过的 envelope 才补分隔符，否则拒绝追加。尾扫描上限 `EVENT_BRIDGE_TAIL_SCAN`（1 MiB）。 |
| 读取者 | `lib/domain-storage.js` 的 `replay()`（经 `planEventLogReplay()`）、`readEventBridgeEvidence()`、`EvolutionEventBridge` 构造函数、doctor。 |
| 可信前缀 | `lib/event-log-checkpoint.js` 的 checkpoint 只有在以下全部成立时才允许跳过已消费前缀：checkpoint 的 MAC、**整张 `applied` 表的 digest**、writer、文件 `dev`/`ino`、当前字节数下界、first/last witness 对应的 applied MAC、以及已消费前缀的 keyed digest。 |

### 2.3 领域 `applied` 表

`lib/domain-storage.js` 的 domain global schema 中，`applied` 是 `eventId -> MAC` 的字符串表，不含事件 payload。它是
domain replay 的持久去重权威之一，但不是唯一状态：同一 pass 内还有未提交批次的 `batchMarks`，以及从已提交 `pending` 恢复出的
ledger。`mergeEventLedger()` 在同一个 eventId 出现不同 MAC 时抛 `E_DOMAIN_EVENT_ID_CONFLICT`。

注意两处**同名不同物**，不要混：

- domain global 的 `applied`：持久、无界、是去重权威、被 checkpoint 的 `appliedDigest` 整体覆盖。
- `aggregate.eventBridge.applied`（`EvolutionMemory.applyExecutionEvent()`）：滚动保留最近 4096 条，**不是**权威，跨端口的长批次不能靠它判定。

### 2.4 老 promotion 的证据来源

`readEventBridgeEvidence()` 只从三类行取值：`measurement-completed`（measurement）、`promotion-succeeded`（gates / promotion /
备用 measurement）、`canary-passed`（canary）。它明确不携带 `cleanupProof`（恒为 `null`）。`archive()` 与 canary 恢复把
journal `evidenceSnapshot`、sidecar `*.evidence.json`、实验 Markdown 与 event bridge 合并使用，因此"日志少一行"不等于"所有字段同时丢失"，
但那一条行承载的事实无法从别处重建。

## 3. 任何回收机制必须同时保持的不变量

1. **不复活旧记录。** 冷档案的读取集合由实际目录决定，所以"让某个段退出历史"必须同时让它退出目录枚举；只从索引删条目不够。
2. **不洗掉损坏证据。** 任何重写/删除都必须先证明它不是在把不可解析行、摘要冲突或缺失段"变成成功状态"。本轮已把这条做进
   `#rewriteArchives()`；回收路径必须复用它，不得另写判断。
3. **不丢审计历史。** 被移出热/冷读取集合的行必须仍可被证明存在过，否则"老 promotion 唯一幸存证据"会消失。
4. **原子提交。** 归档字节与描述它们的 domain aggregate 属于**同一次**提交；当前协议用 `pending` 记录 + 安装后写 aggregate 实现，恢复只能重放到同一状态。
5. **重放去重不受影响。** 任何标记裁剪必须与日志 floor 同时生效，否则仍在日志里的老事件会被再执行一次。
6. **跨实例一致。** `applied` 或归档集合变化必须让其他存活端口的陈旧视图失败而不是静默覆盖；现有机制是 `sameEventLedger()`
   比较 + commit token。
7. **崩溃后可分类。** 任一步骤中断后，磁盘状态必须能被 `inspectArchiveIntegrity()` 或启动恢复**分类**，而不是被猜成正常。
8. **不改变对外行为。** 回收会改变 `history()` / `historyWindow()` 的可读集合，属于对外可观察变化，需要所有者决策而不是默认开启。

## 4. 反例（全部为当前源码实测）

实测环境：Node `v22.23.4`，darwin/arm64，每次 Node 调用带 `--max-old-space-size=4096`；夹具全部在 `os.tmpdir()` 下并递归清理，
未访问用户 home 或正式 DSH 数据。完整输出见 [retention-reclaim-blockers.json](retention-reclaim-blockers.json)。

### 4.1 索引状态不可分类时，重写会洗掉等长篡改的证据（本轮已修）

修复前实测：`load()` 之后把某个 sealed 段做**等长**篡改（保持可解析），再把索引文件写成不可解析内容，然后
`await memory.compact()` → **成功**；随后 `verifyConsistency()` 返回 `valid: true`、`mismatched: []`。被篡改字节的摘要成了新的
"预期"。

这与启动路径相矛盾：同一份不可读索引在 `load()` 时会让 `#reconcileArchiveIndex()` 抛 `E_ARCHIVE_INDEX_STATE_UNKNOWN`。
现在 `#rewriteArchives()` 在任何文件被改动前用同一判据拒绝，并有用例钉住"拒绝前后索引字节与段字节都不变、重新加载仍抛同一错误码"。

### 4.2 暂存事务不能表达删除 → 旧段复活（阻塞）

复现步骤与输出（`scripts/benchmarks/retention-reclaim-blockers.mjs` 的 R1）：

1. 320 条低价值 observation，`hotEntries=2`、`archiveMaxBytes=512`，`load()` 后形成 317 个封存段。
2. `mirrorArchives(live, stage)` 建 stage，在 stage 上 `compact()`：317 段 → 2 段，行数 320 → 4 个聚合行。
3. `changedArchiveFiles(stage, snapshot)` 只列 4 个文件（索引、活动文件、`segment-000000000001`、`segment-000000000002`）；**没有删除项**，也不列那 315 个消失的段名。
4. `installArchiveFiles(stage, live, files)` 之后，live 仍是 317 段；其中 315 段不在新索引里。
5. 从 live 重建实例：`history('observations')` 有 **319** 行 —— 315 个旧 source id 与 4 个 `AGGREGATED` 行同时可读。重复 id 数为 0；`verifyConsistency()` 报
   `live_durable_memory_projection_mismatch`，而 `archiveValid` 仍为 `true`。

原因不是"某处忘了删除"，而是协议本身：`archiveFilesSchema` 是 `.strict()` 的 `{file, bytes, sha256}`，`installPending()`
只替换清单内文件；清单没有任何"删除"表示法。要修必须同时改持久 schema、安装器、恢复重放与旧版本读取行为——这就是
上一轮判定"需要新的持久化协议"的具体位置，本轮仍未做。

**这个反例证明**：段目录整替换只在 stage 内生效，当前清单无法把删除传递到 live，而读取路径确实会重新读到残留段。
**它没有证明**：所有 `compact()` 运行都会复活记录，或者 `verifyConsistency()` 有专门的"旧源行与聚合行语义重复"判定（本次没有，只有 projection mismatch）。

### 4.3 裁剪一个 `applied` marker 就让 checkpoint 完全失去可信性（阻塞）

200 条真实签名的日志行、73,660 字节、checkpoint 记录 200 条：

| `applied` 表 | `trusted` | `prefixRecords` | 需逐条处理的记录 |
| --- | --- | ---: | ---: |
| 完整（200 项） | `true` | 200 | 0 |
| 删掉 1 项（199 项） | `false` | 0 | 200 |

即：**不是"少一个 marker 就多处理一条"，而是整段已消费前缀降级为逐条验签。** 上一轮已实测首次吸收（无有效 checkpoint）的成本是超线性的
（3,000 条 3.57 s、12,000 条 24.84 s、73,525 条 298.05 s，见 [capacity-20261026.md](capacity-20261026.md) §6），所以"顺手裁一点老 marker"会把这类成本重新引入。

### 4.4 截断日志会丢失老 promotion 的取数来源（阻塞）

删掉唯一的 `promotion-succeeded` 行后，`readEventBridgeEvidence()` 的 gate evidence、promotion 时间、runtime recovery 状态与 durable
元数据全部丢失；`measurement-completed` 与 `canary-passed` 承载的事实仍在（因为那是别的行）。`cleanupProof` 前后都为 `null`，因为
bridge 本来就不携带它——这一项**不是**截断造成的。

### 4.5 收益上限（不是已交付收益）

20,000 条真实 `recordExperiment()` 历史的合成样本，`compact()` 前后：

| 指标 | compact 前 | compact 后 |
| --- | ---: | ---: |
| 冷档案字节 | 9,961,788 | 0 |
| 封存段数 | 19 | 0 |
| 冷档案行数 | 19,968 | 0 |
| `retired` / `consolidated` | — | 20,000 / 0 |
| `compact()` 墙钟中位数（6 次 AB/BA 交替） | — | 550.304 ms |

这是"若回收能安全执行，这个样本最多能释放多少"的上限，**不是**收益结论：该样本的行全部满足 terminal retirement，真实历史的
retired 比例由 retention 规则决定；且 §4.2 表明这条路径今天无法把删除发布到 live。

本轮没有对任何候选实现做候选 vs 基线的 A/B，因为没有候选进入实现。

## 5. 未采用的方向与理由

- **自动接通 `maintenance()` / `compact()`。** 仍然缺删除语义（§4.2），而且 `compact()` 会改变 `history()` 的可读集合——那是对外可观察行为变化，不是纯缓存。
- **裁剪 `applied` 标记。** 与 checkpoint 的 `appliedDigest` 结构性冲突（§4.3）。
- **截断 `execution-events.jsonl`。** 丢失老 promotion 取数来源（§4.4），且当前没有能让日志换 inode、marker 裁剪、replay 下限三者保持原子的协议。
- **给 `archiveReadCache` 加容量上限。** 这是内存容量、不是磁盘回收，且它的成本已作为已知限制记录在 `README.md` 第 13 条（约 0.7 MiB heap / MiB 冷档案）。
  `#rememberArchiveRead()` 的注释声称"`compactionTriggerBytes` 已经约束了它"，但那条约束只有在 `maintenance()` 被调用时才成立，而
  `maintenance()` 在 `lib/` 内没有生产调用者。因此**该注释与实际不符**，这里显式更正：缓存当前无界，与冷层字节线性增长。加界需要淘汰策略、
  重读代价的 A/B 与可能的语义差异（缓存值被调用方共享可变对象），本轮没有证据支持一个更优的界，所以不做。
- **跳过启动 `syncTree()` 的全树 fsync、降低首次吸收时每次 save 的整份 payload 校验。** 理由同上一轮，见 [capacity-20261026.md](capacity-20261026.md) §4.3。

## 6. 复现

```sh
# 三个阻塞的复现（R1–R3）
/opt/homebrew/opt/node@22/bin/node --max-old-space-size=4096 \
  scripts/benchmarks/retention-reclaim-blockers.mjs --json

# 追加收益上限测量（R4，20,000 条历史的 compact）
/opt/homebrew/opt/node@22/bin/node --max-old-space-size=4096 \
  scripts/benchmarks/retention-reclaim-blockers.mjs --measure --json

# 本轮已关闭的门禁：修复前失败 / 修复后通过
/opt/homebrew/opt/node@22/bin/node --max-old-space-size=4096 --test \
  test/archive-persistence-defects.test.mjs \
  test/dockyard-domain/archive-index-write-avoidance.test.js \
  test/dockyard-domain/archive-rewrite-batch.test.mjs \
  test/dockyard-domain/evolution-archive-index.test.js
```

脚本只在 `os.tmpdir()` 下创建夹具并自行清理，不访问网络，不写 `release/`、`dist/` 或用户 home。

## 7. 边界

- 反例都在单进程内复现。§4.2 的删除问题与"整目录替换"有关，跨实例只会更差，但本轮没有做多进程并发测量。
- §4.5 是单一合成样本的上限，不代表真实部署的回收量。
- 门禁把"无法分类的状态一律拒绝"，代价是这些状态需要人工处置：双故障（状态保存失败 + 索引还原失败）后 `compact()` 会持续拒绝，
  恢复途径是按 `data.key` / 诊断提示人工处置，而不是让运行时猜。这一取舍与 `AGENTS.md` §4 第 2 条一致。
- 本轮没有改动 `#reconcileArchiveIndex()` 的语义、持久 schema、公开 API、默认行为或发布固定产物。
