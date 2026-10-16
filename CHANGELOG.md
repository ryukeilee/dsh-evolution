# Changelog

Versions here are development artifacts of the standalone `dsh-evolution`
bundle. They are not npm releases. The supported DSH versions are exact
alternatives in `peerDependencies`, and a version is only added there after it
passes the full install/boot/upgrade acceptance: read the entry for the version
you install before upgrading DSH.

## 0.2.0-rc.12 — 晋升 Journal 阶段判定的统一与安全阻断

本候选修复一处恢复安全缺陷：`promotion.journal` 的阶段判定此前分散在三条路径里。doctor（`lib/diagnostics.js` 的 `inspectPromotionJournal`）对无法识别的阶段报 `blocked` / `state-unknown` 且不提供 repair；`recoverInterruptedPromotion` 的默认分支却会对同一 journal 执行 rollback，并在成功后删除整个 state 目录（journal 与备份）；`readCanaryJournal` 还会把它当作“没有 journal”，让 `observeCanary` / `verifyStartupCanary` 从 durable sidecar 合成新 journal——未完成路径覆盖 `journal.json`，stable 与 regression 路径删除 state 目录。生产 delta 只涉及 `lib/orchestrator.js`、`lib/diagnostics.js` 与 `lib/experience-recall.js`；`guard` / `registration` / `promotion-include` / `archive-stage` 与领域模块未改，持久化格式、认证、fsync、事务与回滚、跨进程锁、promotion 门禁与授权边界一律未改。

- **单一判定**：`lib/orchestrator.js` 新增导出 `classifyPromotionJournal(journal, paths)`，边界校验（`checkJournalBoundary`）优先，随后是唯一的阶段表：`prepared` / `committing` → `incomplete`、`canary-observing` → `canary-observing`、`stable-committed` / `committed` → `committed-pending-cleanup`、`rollback-failed` → `rollback-failed`，其余（含缺失阶段）→ `state-unknown`。`lib/diagnostics.js` 直接消费该函数并删除自己的内联阶段映射；doctor 的 `state-unknown` 摘要现在带上真实阶段值，`blocked` / `recoverable: false` / 不提供 repair 的判定不变。
- **拒绝而不是猜测**：`recoverInterruptedPromotion` 与 `readCanaryJournal` 共用 `assertJournalRecoverable`。边界违规、`state-unknown` 与 `rollback-failed` 都抛出携带原因与现场路径的普通 `Error`（不再是未分类的默认回滚，也不是 `TypeError`），journal、备份、目标文件与 staging 逐字节保持不变；`applyRepairs` 按 id 直接调用 `promotion-journal-recover` 时也只记录 `failed`，不动现场。
- **合法阶段语义不变**：`prepared` / `committing` 仍按 CAS 回滚并清理（并发修改仍保留 `rollback-failed` 现场），`canary-observing` 仍返回 pending，`stable-committed` / `committed` 仍只清理 journal 目录，`rollback-failed` 仍阻断并保留。以 `release/` 固定产物对应的 HEAD 实现为基线逐项比对恢复返回值、错误文本与磁盘字节（另含 CAS 冲突注入），六条合法阶段路径完全一致；`readCanaryJournal` 对 `incomplete` / `committed-pending-cleanup` 仍返回 `null`。
- **回归测试**：新增 `test/promotion-journal-phase.test.mjs`：阶段矩阵（含 `null` 与数字阶段）证明 doctor 与恢复共用同一判定；未知/缺失阶段的故障注入断言重复启动、重复诊断与 `applyRepairs` 都拒绝且现场逐字节不变；“拒绝不会毒化状态”用例证明改回 `committing` 后仍能正常回滚；canary 读取用例用真实 `EvolutionOrchestrator` 覆盖 pending 覆盖、stable 删除、regression 回滚、缺失阶段与 `rollback-failed` 五种旧实现会破坏现场的分支。以 HEAD 恢复实现为反例验证过这些用例确实失败（旧实现覆盖 `journal.json` 或删除 state 目录）。
- **独立复核**：两轮对抗式复核均以真实 `EvolutionOrchestrator`、临时 home 与磁盘快照运行；第一轮发现并驱动修复了 canary 读取旁路，第二轮确认所有 journal 读取入口、合法阶段等价性与反例实验后无阻塞问题。
- **上游补丁漂移**：官方 `0.2.1-alpha.1` 宿主用 `~` 范围声明 cordis 与 include，上游随后发布 `4.0.5-alpha.2`、`1.0.10-alpha.2`（及 loader `1.0.6-alpha.2`），fresh install 会解析到它们，而 `peerDependencies` 只声明了 `alpha.1`，doctor 的 `host.modules` 因此阻断。逐一解包审计确认三个包只有 `package.json` 变化（版本与自身依赖范围），所有随包源码逐字节相同；据此把这两个补丁级别加入 `peerDependencies`，并用两个宿主的完整真实验收验证（具体见 `COMPATIBILITY.md` 的验证矩阵与接口差分表）。
- 文档：`README.md` 的恢复表与 `AGENTS.md` 的不变量删除“未识别阶段仍会被启动恢复回滚”的旧例外，并更新到本候选版本与上游补丁级别。
- **经验检索的排序**（`lib/experience-recall.js`）：原实现按来源数组顺序拼接已投影记录并直接填桶，每个来源又只在本来源的匹配集合内归一化新鲜度，因此同一份历史换个来源顺序给出不同答案（探针：一条精确 `knowledgeKey`、`failureCount` 9 且最新的 knowledge 失败，加三条 `count` 1 的旧失败记忆，`[knowledge, failure-memory]` 先给出 knowledge 失败，`[failure-memory, knowledge]` 直接把它挤出 `failures`）。现在只有一个确定性比较器：精确 `knowledgeKey` 优先 → 评分降序 → `lastSeen` 降序 → 与 locale 无关的完整排序键顺序。排序键 `orderingKey` 原先把裸字段用 NUL 拼接，`source` 与 `problem` 之间的分隔符可能被字段内容吸收（两条不同记录得到同一个键、比较结果为 0、稳定排序于是退回合并顺序，来源互换就换结果）；现在与 `contentIdentity` 一样逐字段长度前缀，注释也改为 NUL（原文误写为 ASCII unit separator）。
- **评分是纯函数**：`scoreOf(record, coverage)` 只保留 `SCORE_WEIGHTS` 里原有的四项质量权重（`coverage` / `success` / `fitness` / `evidence`，最高值为四者之和 0.95，未重新归一化），删除 `recency` / `basis` 机制与合并之后的二次重算：评分不读时钟、不读其它记录，单来源 `maxRecords` 保留与最终排序用的是同一个值，一个来源留下的就是它自己按同一比较器排出的前 `maxRecords` 条，`lastSeen` 只在其余项相同时平局。复核 F1 反例（12 条 `occurrences` 1 的普通失败加 `occurrences` 2 但更旧的 B，另一来源最新为 2026-01-01）在旧实现里先被来源内新鲜度截掉、最终答案里根本没有 B；现在 B 被 collector 保留并排在所有普通失败之前。
- **保留与去重**：`source()` 在扫描窗口外仍会投影精确 `knowledgeKey` 命中，但 `match()` 随后按评分 `slice(0, maxRecords)`，精确重放会在第二个截断点被丢弃（1 条精确行加 14 条高分普通匹配时精确行排名为 −1、`duplicate` 为 `null`）；现在保留策略先为精确匹配占位、再用剩余名额补最好的普通匹配，单来源仍不超过 `maxRecords`，该上限本身也适用于精确重放。内容去重改为在 `maxRecords` 截断**之前**执行，身份（`factIdentity`）要求分组（`kindOf`）、归一化六字段描述、`lastOutcome` 与证据量级（`occurrences` / `regressionCount`）全部相同（第二轮独立复核进一步把 `successCount` / `failureCount` / `successRate` / `fitnessMean` 补进身份，见下条），因此描述相同但结果或证据量级不同的两条失败绝不合并（复核 F6 反例：旧实现保留 `key=a`、丢掉 `occurrences=999` / `regressionCount=7` / 2 条引用那条，只报 `counts.duplicates=1`），重复项也不再占用名额（复核 F2 反例：12 条同事实加 1 条低分不同事实，旧实现留下 12 条重复、丢掉不同事实并报 `{ matched: 1, returned: 1, duplicates: 11 }`，现在两条都留下）。存活记录是组内比较器顺序的第一条，其 `evidenceRefs` 为组内引用并集（存活者在前、仍受 `maxEvidenceRefs` 约束）；来源内合并数记在每个 `sources[].duplicates`，`counts.duplicates` 为来源内加跨来源合计，`counts.matched` 为去重后进入最终阶段的候选数，`duplicate` 在最终跨来源合并**之前**从各来源保留后的记录计算（来源自身已经在自己的 collector 里合并过）。
- **只读保证**：`finalizeExperienceRecall` 不再把 `score` 写回调用方传入的记录（复核 F4：同一份 collector 输出二次 finalize 会改写已返回结果的评分，本机探针 `first_result_unchanged=false`；冻结记录直接抛 `TypeError: Cannot assign to read only property 'score'`），所有记录先按已知投影字段重建为副本、夹到已声明上限内，再补 `coverage` / `exact` / `score`；缺少 `coverage` 时用 `matchOf(copy, query)` 重算而不是当作 0（复核 F5：同一条记录缺 `coverage` 时上一版按 0 计分，本机探针得 0.1833，而它自己的文本匹配覆盖度为 0.9，应得 0.4933），缺少 `exact` 时按 `record.key === query.knowledgeKey` 推导，已带 `coverage` / `score` 的记录保留原值。检索仍只由显式动作触发：`evolution_propose`，或 `evolution_history` 带 `query`；自主观察者新建提案时走的也是 `evolution_propose`，定时器、轮询、measurement 与 canary 不触发。`EXPERIENCE_RECALL_LIMITS` 的全部上限、`buildExperienceQuery` / `experienceKnowledgeKey`、两个投影函数与两个 collector 的签名、`finalizeExperienceRecall` 的入参与既有输出字段（除新增的 `sources[].duplicates`、`sources[].dropped` 与 `counts.duplicates`）均未改，调用方仍只能收紧上限。
- **第二轮独立复核的五项修正**（`lib/experience-recall.js`）：① `orderingKey` 原先只编码 `key` / `source` / 六字段描述，共享这些字段、仅 `lastOutcome` / `regressionCount` 不同的两条事实会打平并退回来源顺序（本机探针：`{ maxEntries: 1 }` 下 `[A,B]` 返回 `failure/0`、`[B,A]` 返回 `regression/1`，`order independent: false`）；现在该键按固定顺序长度前缀编码全部报告字段（六字段、`source`、`key`、`state`、`lastOutcome`、`successCount`、`failureCount`、`successRate`、`fitnessMean`、`regressionCount`、`occurrences`、`firstSeen`、`lastSeen`、有界 `evidenceRefs`），探针两个方向都返回 `regression/1`。② `factIdentity` 补上 `successCount` / `failureCount` / `successRate` / `fitnessMean`：描述、`lastOutcome`、`occurrences`、`regressionCount` 全同但 `failureCount` 为 1 与 4 的两条记录，旧实现只留一条并报 `duplicates: 1`，现在两条都保留、`matched: 2` / `duplicates: 0`。③ `duplicateOf` 改为取同一 `knowledgeKey` 各快照的**最高** `occurrences` 而非求和（每条精确记录都是同一 key 的快照）：旧实现 `finalize([e])` 报 3、`finalize([e, e])` 报 6、快照 3 与 4 报 7，现在分别报 3 / 3 / 4。④ `match()` 统计并暴露被自身 `maxRecords` 丢掉的候选（`dropped = 去重后 − 保留`），`source()` 暴露 `dropped`，`finalize` 把 `integer(entry.dropped)` 与自身每来源丢弃相加进 `sources[].dropped`，任一来源有丢弃时 `truncated` 为真：13 条不同匹配、`maxRecords: 1, maxEntries: 1` 时旧实现 `truncated: false`、无 `sources[0].dropped`，现在 `truncated: true`、`sources[0].dropped: 12`。⑤ `scoredCandidate(record, query, limits)` 只从已知投影字段（`baseRecord` 形状 + `coverage` / `score` / `exact`）重建返回值，按 `limits` 夹六字段、`state` / `lastOutcome` 夹 40、计数经 `integer()`、日期经 `isoOrNull()`、`evidenceRefs` 去重并夹到 `maxEvidenceRefs` 条且每条不超过 `maxRefLength`，`finalize` 还对每个来源的集合排序、合并并按 `maxRecords` 截断（第三方 `domainStorage.recall()` 不受 collector 约束）：旧实现把默认 collector 输出用 `{ maxText: 4, maxEvidenceRefs: 1 }` finalize 仍返回长度 25 的 `problem` 与 2 条引用；一条 10,000 字符描述、100 条引用并带额外字段的记录返回 43,213 字符 JSON 且保留该字段；17 条不同记录的第三方来源 `matched: 17`；现在分别为长度 4 与 1 条引用、1,217 字符 JSON 且额外字段被丢弃、`matched: 12` 且 `sources[0].dropped: 5`。
- **第三轮独立复核的两项修正与两处文档校正**（`lib/experience-recall.js`）：① `orderingKey` 声称编码全部报告字段，却漏了 `coverage`，而 `compareCandidates` 在读到排序键之前只按 `score` 平局——两条除显式 `coverage`（0.9001 / 0.9002，`scoreOf` 把两者都取整到 0.7434）外完全相同的第三方记录得到相等的排序键、比较结果为 0，稳定排序与去重存活者于是退回来源合并顺序：`finalize` 传 `[A, B]` 报 `coverage` 0.9001、传 `[B, A]` 报 0.9002（本机探针 `order independent: false`）。现在该键在固定位置（`record.key` 之后）长度前缀编码 `coverage`，模块头与该函数注释同步列出该字段；`score` 与 `exact` 不加，因为比较器在查到排序键之前就已用它们分出先后，两者永远不会以平局身份到达该键。② `collapseFacts` 保留 `{ ...group[0] }`（按比较器顺序第一条，通常是最新快照）并只合并 `evidenceRefs`，组内更早的 `firstSeen` 在 `duplicateOf` 看到它之前就丢了：同一 `knowledgeKey`、其余身份字段相同的两个快照 `firstSeen` / `lastSeen` 为 2020-01-01 / 2024-01-01 与 2022-01-01 / 2025-01-01 时，`duplicate.firstSeen` 报 2022，与“`firstSeen` 取最早快照”的文档契约相反；经真实 `collectKnowledgeExperience`（同一来源内合并）在两种行序下都复现。现在合并分支把存活者的 `firstSeen` 取组内最早的非空值（组内全无时保留存活者自己的值），`evidenceRefs` 并集、重复计数与存活者选择未改。③ **有意的行为变更**：`finite()` 现在对 `null` / `undefined` / `""` 返回 `null`（旧实现对 `null` 与 `""` 经 `Number(null)` / `Number("")` 得到 0，`undefined` 本来就是 `null`），因此 `successRate: null` 或 `effectStats.fitnessMean: null` 的 knowledge 行投影为 `null`（“未知”）而不是 0（“0% 成功”），其评分随之变化；这是预期语义，未把 `finite()` 改回。④ **措辞校正（非新缺陷）**：模块头原称重建意味着第三方 `domainStorage.recall()` “cannot widen the answer”，但 `scoredCandidate` 原样携带 `record.source` 与字符串 `record.key`，第三方给出的超长 `source` / `key` 仍会产生大 JSON（一条 20,000 字符的 `source` 与 `key` 约 40 KB）——该暴露在 `HEAD` 上同样存在。现在模块头（以及 `finalizeExperienceRecall` 的说明）改述为：六字段、`state`、`lastOutcome`、计数、日期与证据引用会被重建并夹到声明上限，`source` 与 `key` 原样传递，其大小由提供它们的来源而非本模块决定；不新增截断（朴素截断会重新引入 ① 类碰撞）。回归测试新增 2 个用例：coverage 打平对在两种来源顺序下返回同一 `coverage` 且完整序列化相同（复用 `serializeRecall`），以及同一 key 的两个快照经真实 collector 与两种来源顺序都报最早的 `firstSeen`。实测（40 个用例）：本改动上一版（未提交）实现上 38 pass / 2 fail（正是这两个新用例），未改动的 `HEAD` 实现上 18 pass / 22 fail，修正后 40 pass / 0 fail。
- **回归测试**：`test/experience-recall.test.mjs` 共 40 个用例，原有 17 个未改，本改动累计新增或重写 23 个：来源顺序无关与重复调用逐字节一致、单来源保留与最终排序共用同一评分（同一记录旁边出现更新的来源时评分与所选失败不变）、F1 反例（更旧的 B 被保留且排在所有 `occurrences` 1 的普通失败之前）、F2 反例（同事实重复不占 `maxRecords` 名额，存活者的引用并集）、F3 反例（歧义排序键在来源互换下仍确定）、F4 反例（二次 finalize 不改写已返回结果、冻结记录不抛错）、F5 反例（无 `coverage` 的记录按自身文本匹配计分、自带 `coverage` 的记录保留原值）、F6 反例（结果或证据量级不同的记录不被合并）、跨来源合并的引用并集、精确重放扛过扫描窗口与单来源上限、跨来源同内容每组只留一条、同文本不同分组不合并、两来源下各组不超过 `maxEntries` 且每来源不超过 `maxRecords` 并在 `maxRecords + 1` 边界上 `truncated` 正确、缺来源仍进 `unavailable`、空输入各组为空且 `counts` 自洽，以及本轮五项修正各自的回归（仅 `lastOutcome` / `regressionCount` 不同的两条事实在 `maxEntries: 1` 下不随来源顺序翻转、计数不同的记录不合并、精确快照的 `occurrences` 取最高值、来源级保留丢弃计入 `truncated` / `sources[].dropped`、第三方记录被重建并夹到声明上限且输入不被改写）。实测：把这份测试文件跑在未改动的 `HEAD` 实现上（用 `git show HEAD:lib/experience-recall.js` 覆盖 `lib/`）得到 18 pass / 22 fail。本改动上一版实现未提交、只存在于本地，其上的对照运行不作为可复现的验证结果记录；本轮新增的 5 个回归用例各自对应的旧行为见上面五项修正中的探针输出。
- 文档（本轮）：`README.md` 的 2.3 节改为说明三组结果共用一个逐条记录的纯函数评分（四项权重，最高 0.95）、单来源保留与最终排序用同一个值、精确 `knowledgeKey` 重放优先占位但仍受 `maxRecords` 上限、完整排序键编码全部报告字段、合并只发生在描述与整组已记录结果/测量都相同时、`duplicate.occurrences` 取同一 key 的最高快照、`truncated` 也覆盖来源级丢弃（`sources[].dropped`），并说明来源交来的记录会按已知投影字段重建并夹到声明上限内；模块头同步更新触发入口（自主观察者经 `evolution_propose`）、`maxConsidered` 不是硬上界以及上述语义。
- **发布状态**：`release/` 里当前固定的 rc.12 产物，以及 `docs/evidence/` 里两个官方宿主的验收证据，针对的都是**本改动之前**的内容。因此 `npm run pack:check` 与 `test/release-pin.test.mjs` 现在必然失败，必须按 `RELEASE.md` 重新打包、重跑 `dsh-0.2.0-rc.2` 与 `dsh-0.2.1-alpha.1` 两个真实宿主验收并重新固定之后，本改动才算可发布；在此之前不得引用这两个验收数字，也不得手工改写固定点。
- 本候选的固定产物、两个官方宿主验收证据与校验和分别见 `release/manifest.json` 与 `docs/evidence/dsh-0.2.0-rc.2.json` / `docs/evidence/dsh-0.2.1-alpha.1.json`；`npm run pack:check` 与 `test/release-pin.test.mjs` 会核对“工作树内容 = 固定内容 = 两个宿主验收所针对的内容”。本轮未创建 tag、未进行外部发布；`0.2.0-rc.11` 及更早的 tag、发布附件与产物字节保持不变。

## 0.2.0-rc.11 — 写入路径与保留计划的重复工作（四轮，含撤回）

本候选在 `0.2.0-rc.10` 之上收束四轮“删除重复计算、重复复制与重复遍历”的改动。生产 delta 只涉及 `lib/dockyard-domain/memory.js`、`knowledge.js`、`observation.js` 与 `lib/domain-storage.js`；`orchestrator`、`guard`、`registration`、`promotion-include`、`archive-stage` 无源码改动，持久化格式、认证、fsync、事务与回滚、跨进程锁、promotion 门禁与授权边界一律未改。

- **冷档案记录路径**（`memory.js`、`knowledge.js`）：`#sourceMatches()` 以 `#mergeArchived(..., { copy: false })` 扫描来源集合的完整历史（先比存储 key，未命中才用新增的 `knowledgeKeyOf()` 重算身份），`#knowledgeEntryFor()` 只 clone 命中的那一行而不是为一次查找深拷贝整段冷 knowledge 档案，`#append()` 把已解析出的 `previousKnowledge` 直接交给 `#upsertKnowledgeUnlocked()`。10,000 行冷档案上 `recordObservation` 的 knowledge 路径按两半分别实测：265.656 → 133.932 ms（墙钟 −49.58%、CPU −52.23%），再 133.932 → 46.573 ms（边际 −65.23%），相对 rc.10 累计 −82.47%；双档案 `port.observe()` 累计 562.03 → 284.35 ms（−49.41%）。公开的 `history('knowledge')` 读取路径与 recall 未改动（对照组 +0.62% / −1.85%）。数据见 `docs/performance/experience-recall-archive.md` 与 `knowledge-lookup-copy.md`。
- **活动档案扫描与逐行身份**（`memory.js`、`knowledge.js`）：reconcile 对活动档案的扫描结果按 `collection + basename + dev + ino` 记入进程内备忘（命中还要求 size 与纳秒 mtime 相同，上限 32 条、LRU 淘汰），一次事务里对硬链接暂存镜像与提交后活树的两次扫描只在首次真正读盘（同一事务 reconcile 合计 123.399 → 1.805 ms，−98.54%）；`knowledge.js` 的两处十六进制折叠从 `giu` 改为显式 `a-fA-F` + `gu`，且只在没有任何维度信号时才做 explicit key 的完整文本规范化。相对 rc.10，双冷档案 `port.observe()` 573.434 → 136.830 ms（−76.14%）。数据见 `docs/performance/write-path-reconcile-and-identity.md`。
- **保留计划**（`memory.js`）：`#knowledgeRetentionPlan()` / `#retentionPlan()` 的每条来源记录只在累积遍规范化一次（无知识身份的行在同一次遍历写入 `retainedEntries`，折掉原来的第二次保留遍历），分类循环直接查同一个 Set；删除 knowledge 种子、knowledge 计划结果与出计划处的三处冗余深拷贝；删除只回答“累积遍已经回答过的布尔问题”的中间版本按行备忘。真实 `compact()` 链路 A/B/B/A（基线 `b7547f8`，2 000 / 10 000 / 40 000 冷行）：规划墙钟 −35.9% / −37.8% / −38.1%（CPU −30.1% / −37.3% / −36.3%），含档案重写 −27.1% / −24.1% / −22.9%。同一改动自身的边际（对比含备忘的上一版）是批间波动量级：规划阶段墙钟 −0.9% ~ −2.2%，写入阶段墙钟 −0.9% ~ +1.1%，CPU 为 −4.0% ~ +2.0%；删除备忘的依据是状态与内存（40 000 冷行下 Map 结构 0.91 MiB、含独占可保活对象图 9.32 MiB 的暂态），而不是这点时间。数据见 `docs/performance/retention-plan-cost.md`。
- **加载投影**（`memory.js`、`observation.js`、`domain-storage.js`）：两个加载器新增 `{ snapshot: false }`（默认行为不变），`createMemory()`、`hydrate()` 的观测 store 与 store 自己的 `record()` 四条“构建整份热投影后丢弃”的调用链不再付这次深拷贝；观测 store 改为按文档化的窄读从共享 Memory 取 `observations` 一列。整树 A/B（基线 `741b749`）：CPU 29 316.7 → 26 687.5 ms（−8.97%）、每写中位耗时 97.81 → 89.19 ms（−8.81%）、总墙钟 −7.02%，每写少构建 4 份 Memory 投影（可序列化体积 2 136 650 → 427 381 B）。数据见 `docs/performance/load-projection.md`。
- **独立对抗式复核发现并修正的真实分歧**：加载投影的第一版只在“真正执行了加载”的路径上做冷历史强转，而 `loaded` 在投影抛错前就已置位，于是 `load()` 失败后下一次 `record()` 会绕过冷历史检查成功落盘（基线两次 `TypeError`、落盘 0 条，缺陷版第二次成功落盘 1 条）——修正为 `#projection(snapshot)` 在每条返回路径上都执行该读取。活动扫描备忘的第一版让记录侧与备忘共享 `ActiveKeys` 的 `Set`，暂存追加会污染旧 inode 的备忘录（逻辑键计数少计）；逐行身份的字符串折叠只在 NFKC 管线内等价，差异码点恰为 `U+017F` / `U+212A`，生产锚与注入用例随之固定。保留计划的第一版折掉了分类循环中那次“值已不再使用”的时钟读取，删除它会把同一知识身份组内的保留行从 `dated` 翻成 `timeless` 并写出不同归档字节，因此该删除被撤回。
- **明确放弃的候选**：按维度提前短路身份比较（上界仅第 6 维约 7% 加 hash 6.9% ≈ 身份成本的 14%，且把行为换成“维度相等”）；跨调用缓存 `#readArchiveSync()` 的整段解析结果（每次写入约 56 ms 的机会，但要把 10,000 行对象长期留在进程内）；融合 `normalizeText()` 的顺序短语替换（`network error → network-error → network-failure`，一次替换会变值）；以及在“跳过投影”之外删除 `schema.parse` / `toJsonProjection` / `fsync` / 未接入实时循环的 `lineage.load()`。
- **等价性与历史锚点**：三处改动都以固定产物为基线做差分，`lib/` 是随包分发路径，因此差分基线只从 `release/` 中已提交的产物取。`test/domain-storage/load-projection-*.js` 新增整棵 `lib/` 树的 7 片段反转表（3 个文件）并覆盖持久化字节、失败路径与并发契约；`test/dockyard-domain/knowledge-identity-equivalence.test.js` 的基线由“当前固定点”改为显式锚定 `release/dsh-evolution-0.2.0-rc.10.tgz`，重新固定后不会再退化成自我比较；rc.7 与 rc.8 锚点（`housekeeping-baseline.js`、`archive-index-baseline.js`、`domain-storage-baseline.js`）仍逐字节成立。
- **收益边界与已记录的偏差**：备忘的收益与“一次事务里被重复扫描的活动档案字节数”成正比，跨进程重启后的首次 `load()` 仍完整扫描（恢复面本身）；它同时长期保留条目深拷贝（实测每 10,000 行活动键约 0.7 MiB，条目数上限 32）。身份改动的收益与每次写入被重算身份的冷行数成正比，无冷行时未证实可测收益。保留计划的等价性主张限于已测量语料与相同/冻结的起始时钟：被折叠的那次逐行时钟读取会让此后计划的时钟派生戳记前移已删除的读取次数（索引戳记，以及同一进程内后续计划的 `occurredAt` 排序输入），这一点由时钟契约用例钉住并作为已接受偏差记录。跳过整份投影会改变“不可投影值”的报错时机：纯领域调用晚到第一次真正投影时才报同一个 `RangeError`，而官方端口在 `openDomainStorage()` 之前就已用 schema 拒绝该文档。
- 文档：`docs/performance/` 新增 `knowledge-lookup-copy.md`、`experience-recall-archive.md`、`write-path-reconcile-and-identity.md`、`retention-plan-cost.md`、`load-projection.md` 与对应原始数据（含撤回记录、失败记录与复现命令）；同一轮校正了 rc.7 锚点产物 `lib/dockyard-domain/memory.js` 的字节数（`175,320`）、并发加载返回值的表述、以及若干把“未测得收益”写成“没有收益”的表述。
- 本候选的固定产物、两个官方宿主验收证据与校验和分别见 `release/manifest.json` 与 `docs/evidence/dsh-0.2.0-rc.2.json` / `docs/evidence/dsh-0.2.1-alpha.1.json`；`npm run pack:check` 与 `test/release-pin.test.mjs` 会核对“工作树内容 = 固定内容 = 两个宿主验收所针对的内容”。本轮未创建 tag、未进行外部发布；`0.2.0-rc.10` 及更早的 tag、发布附件与产物字节保持不变。

## 0.2.0-rc.10 — 按需经验检索（无模型、无轮询）

- **新增 `lib/experience-recall.js`**：显式进化动作触发、纯函数、全部上限制在模块内的只读经验检索。使用已有的 canonical knowledge（`state` / `lastOutcome` / `effectStats` / `trend` / evidence）与本地 durable failure memory，输出 `resolved` / `failures` / `candidates` 三组、`duplicate` 精确重放与 `advice`；默认每组最多 3 条、每来源最多 12 条、单字段 160 字符、2 条证据引用、扫描最近 2000 条，调用方只能收紧不能放宽。
- `evolution_propose` 在返回中附带 `experienceRecall`，`evolution_history` 新增可选 `query` / `target` / `impactScope` 返回同一结果；`inspect`、measurement、autonomous observer 与定时器不触发检索（单测断言 `recall` 调用次数）。`experienceRecall: false` 可整体关闭。
- 领域端口的 `recall` 是唯一新增读取方法；检索不写入、不改变数据格式、不改变 promotion 授权与门禁。domain 存储缺失或读取失败时降级为本地 failure memory，并在 `unavailable` 中显式报告，而不是当作“没有历史”。
- 负向证据现在带上它适用的 target（`#bridgeOutcome` 写入 `scope`），因此同一个 target 的历史失败可跨会话被检索；原始失败文本仍按既有边界在进入领域存储前脱敏。
- 因宿主的 `#bridgeOutcome` 与 `lib/domain-storage.js` 位于两个固定基线锚点之下，两处逆向重建各自新增了一条显式 reversal 记录（只读 `recall` 方法与被反向重建的同一段源码），锚点仍逐字节对应固定产物。
- 新增 `test/experience-recall.test.mjs`（17 个用例：分类、精确重放（含超出扫描窗口的旧记录）、上界、来源不可用时降级、`__proto__` 与损坏行、真实 `storageDomain` 端到端回读、未签名事件仍拒绝作答）。
- 文档：`README.md` 重写为面向用户的产品说明（定位、能力、场景、安装、配置、使用、限制），`AGENTS.md` 重写为与当前实现一致的开发约定。两者不改变任何运行时行为、API 或数据格式。

## 0.2.0-rc.9 — 默认写入路径的重复工作

- **恢复收尾的第二次文档校验**：`installPending()` 收尾写入的文档由上一步 `schema.parse(domain.global.get())` 的结果（已校验并投影的 `pending.aggregate` / `pending.applied`）与两个固定字面量（`schema: 1`、`pending: null`）组成，再解析一遍不可能拒绝第一个 parse 没有拒绝的文档，只是把整份 aggregate 又走一遍。必须在安装暂存文件之前完成的整份文档校验没有移动，仍由上面那次 parse 承担。
- **`stateStore.update` 的冗余深拷贝**：入参先被 `structuredClone` 克隆一遍，而 `aggregateSchema` 的 `toJsonProjection` 本身就产生全新深值；交给这个 store 的 updater 都是纯展开，从不改写参数。
- **`inlineSerialization`**：该 store 现声明 `inlineSerialization: true`，`EvolutionMemory.#save()` 不再先做一次 `snapshot()` 全量深拷贝。`PORTS.md` 要求的“transaction 在调用时同步捕获全部 payload 字节”由 `update` 内联的同步 JSON 投影满足，等价测试中有“已提交文档不被后续写入原地改写”的断言守护该契约。
- 三项合起来把一次保存的“浅视图/快照深拷贝 → 入参深拷贝 → JSON 投影深拷贝”减为“浅视图 → JSON 投影深拷贝”，落盘字节不变。可复现 3 对严格交替 A/B（CPU 中位数 35277.426 → 31743.330 ms，**−10.02%**，两侧范围不重叠；墙钟 −5.96%）、等价性依据、收益边界，以及两项**已被击穿并撤回**的方案（`catchall(z.json())` 的非遍历替换：16,411 个差分输入、441 个“旧拒绝/新接受”；删除 `hydrate()` 里“死”的 observation store：它读取的 `memory.hasColdHistory` 会强转 `coldArchives` 条目，删除后损坏状态之后的第一次提交会被静默接受）见 `docs/performance/domain-write-path.md`。
- 本候选已在本地固定（`release/dsh-evolution-0.2.0-rc.9.tgz`）并重跑两个官方宿主的完整验收；未创建 tag 或进行外部发布。`0.2.0-rc.8` 及更早的产物、校验和与固定点保持不变。

## 0.2.0-rc.8 — journal boundary、archive index 单次解析与 housekeeping 开销

- **Promotion journal 边界**：doctor 与恢复共用 `checkJournalBoundary`；仅接受 `file` / `path` 记录，目标限于 `pluginRoot` / `presetDir` / `archiveDir` 且不得指向 promotion 状态目录，不以 `dataRoot` 扩大范围。`symlink` 等不支持的记录形状现报 `blocked` / `state-unknown`、`recoverable=false`，不再提供恢复必然拒绝的 `promotion-journal-recover`；边界拒绝保留 journal，缺失 `stateDir` 或 `stageDir: 42` 等原先触发 `TypeError` 的非法值返回明确拒绝原因。修正 README / COMPATIBILITY 与 doctor 摘要的描述。

- **Archive index 单次解析**：reconcile 与 compact 重建共享一次 JSONL 分行/解析，保留索引字段、活动键、轮转字节与损坏行处理。等价测试使用固定产物中的完整旧实现，并以带形状断言的逆向重建证明字节一致；重新固定包含新实现的产物后仍保留基线，移除重复 vendored 源码。可复现性能数据与收益边界见 `docs/performance/archive-index-single-parse.md`。

- **Housekeeping 开销**：`#performHousekeeping()` 在每次保存时执行，此前为每条被退休记录线性扫描 tombstones，去重对每个被删条目各做一次 `indexOf`/`splice`，并在规则 4 与规则 5 中重复派生同一条目的指纹。现在每次 pass 只建一次 tombstone 索引（记录 id / fingerprint / candidate fingerprint，退休时增量维护），缺指纹的记录在同一次 pass 内只派生一次，去重改为一次性原地压缩。所有偏离常规形状的输入仍逐字节保留原语义：tombstones 出现假值或非对象元素时退回原来的线性扫描与真假判断，`fingerprint: null` 仍按 `candidateFingerprint ?? fingerprint ?? 派生` 继续派生，构造 tombstone 或转换字段抛错时保留中止前已完成的删除。两轮独立对抗式复核各自找到真实分歧（延迟删除、`null` 指纹短路、假值 tombstone、抛错时的部分删除），修复后都已固化为回归用例。多规模可复现 A/B、收益边界与默认配置未观察到收益的结论见 `docs/performance/housekeeping-save.md`。

- 本候选已在本地固定（`release/dsh-evolution-0.2.0-rc.8.tgz`）并重跑两个官方宿主的完整验收；未创建 tag 或进行外部发布。`0.2.0-rc.7` 的产物、校验和与固定点保持不变。

## 0.2.0-rc.7 — failure memory integrity

- 修复 file 后端失败记忆的损坏输入路径：`entries` 中出现非对象记录、或记录嵌套超过加载边界（64 层；`snapshot()` 克隆在这之前会因过深而栈溢出）时，插件不再在启动时崩溃，而是像解析失败 / 结构失效一样隔离原文件、以空 memory 继续并留下可查询 warning；doctor 与运行时使用同一个判定函数，不再出现“运行时拒绝、doctor 报 ok”。
- 从旧数据恢复、缺少 `signature` 的记录改为按整条内容派生身份（深度受限的稳定序列化）：不同记录不再因缺失键被静默合并（`compact()` 曾把合并结果写回磁盘），完全相同的记录仍会去重。
- 显式 `signature` 只接受非空字符串；其它值改按 `signature()` 计算，避免 `record()` 的保留键与实际存储键不一致。
- `record()` 的保留不再可能裁掉本次写入：时钟回拨或异常 `lastSeenAt` 使新记录排在满仓之后时，淘汰最旧记录而不是丢掉刚观察到的失败，返回值不再因自身的裁剪而缺失。
- 加载时拒绝 JSON 无法保真表示的值（±Infinity/NaN、-0）并按损坏状态隔离原文件；写入路径把非有限数规范化为字符串、-0 规范化为 0，避免插件自己写出下次启动会被拒绝或与其它记录共享身份的记录。
- 加载时检测 JSON 数字字面量的精度丢失（如 `9007199254740993`、`1.0000000000000001`、`1e-400`）：`JSON.parse` 之后原文差异已不可观察，因此对原文做精确十进制比较，命中即按损坏状态隔离原文件，doctor 同步报 `degraded`。
- 写入路径把 `undefined` 数组元素/空洞与 `undefined` 属性规范化为落盘后的形状（`null` / 删除），使身份在写入、重载、再写入之间保持一致。
- 解析前检查对象的重复键（含转义解码后的键名）：重复键在 `JSON.parse` 中后者覆盖前者，不同原文会得到相同记录；命中即隔离原文件。
- 严格 UTF-8 解码内存文件：非法字节不再被替换字符“修复”而与其它记录合并，命中即隔离并保留原字节。
- `compactValue` 改用 `Object.fromEntries` 写回对象属性，`__proto__` 自有属性不再被原型 setter 吞掉。
- 保持 BOM 文件的既有语义：UTF-8 BOM 不属于 JSON，严格解码保留它以便解析失败并按损坏状态隔离，运行时与 doctor 一致，不再出现“运行时接受、doctor 报 degraded、保存时静默去掉 BOM”的分歧。
- 保留 schema 1 格式、`record()` 的重复语义（`count` 递增、`firstSeenAt` 与模式身份不变）、`tmp`+`rename` 原子写入与隔离恢复语义。
- 本候选仅在本地固定与验收，未创建 tag 或进行外部发布。卸载/重装后 memory 文件哈希变化的调查结论（属预期的 `count`/`lastSeenAt` 更新，非持久化缺陷）见 `docs/evidence/memory-hash-investigation.md`。

## 0.2.0-rc.6 — redundant work removal

- 删除同一调用路径中重复执行的工作：语义 GC 不再为每条可退休记录线性扫描整张 canonical 表；失败记忆 `record()` 与加载不再为丢弃的返回值深拷贝整份记录；observation 过滤不再逐条规范化同一查询词；strategy 与 capability 快照不再为取计数重复生成整份列表。
- 保留持久化格式、认证、fsync、事务、恢复、回滚与跨进程锁语义，官方 DSH 零源码 patch；历史 tag 和发布附件不变。
- 事件同步路径的两项候选优化经三轮独立对抗式审查后**整体撤回**，生产代码恢复基线行为：标记表摘要复用被“端口存活期间经官方句柄回退标记”和“同一对象原地修改后写入失败”两处反例击穿；恢复安装的“只校验使用到的字段”被“被拒绝的提交已把暂存文件装进实时归档树”击穿。两项都在真实官方 JSON 后端复现，稳态与带新事件的 `flush()` 因此都没有收益。
- 可复现前后对比（3 轮交替、中位数）：canonical 3000 时语义 GC 94.475 → 67.519 ms（−28.53%）；`record()` 重复条目 1.1321 → 0.7594 ms（−32.92%）；带查询词的 observation 列表 1.3183 → 0.5106 ms（−61.27%）；`strategy.snapshot()` 3.0507 → 1.5348 ms（−49.69%）；`capability.snapshot()` 0.8837 → 0.4866 ms（−44.94%）。收益边界、撤回记录、反例与原始数据见 `docs/performance/redundant-work.md`。

## 0.2.0-rc.5 — reliability fixes

- 保留 proposal 快照，在 Trial 首次运行时修改前同步捕获恢复基线；正常 propose→trial 宿主加载不再误报恢复失败。基线不在后续 inspect、measure 或清理时重建，Trial 期间真实并发漂移仍拒绝恢复并保留目标锁。
- 服务清单读取异常标记为不可用，拒绝以两份空清单证明恢复；普通 service lookup 的容错行为与正常未绑定声明保持兼容。
- 保留 stop/undefine 回执、安全守卫、二次确认、Promotion、Canary、恢复和回滚语义；官方 DSH 零源码 patch，历史 tag 和发布附件不变。
- 七项边界回归及真实双宿主探针覆盖本次修复；发布链继续要求 Node 22/24、完整测试、固定产物、来源追溯、远端 CI、CodeQL 和发布后验收。结果与剩余风险见 `docs/evidence/rc5-release-audit.json` 与 `docs/core-reliability.md`。

## 0.2.0-rc.4 — final local performance candidate

- 收敛领域查询元数据投影、运行时检查投影、签名排序键复用、冷历史诊断、事件桥证据分块恢复五轮优化，保留全部历史基准、失败记录和差分回归。
- 统一源码、固定 tarball、校验和、manifest 与两个官方宿主的完整验收证据；未降低发布验证要求。
- 本候选仅在本地固定，未创建 tag 或进行外部发布。可复现结果与收益边界见 `docs/performance/final-candidate.md`。

## 0.2.0-rc.3 — performance candidate

- 官方领域查询保留完整历史读取、去重和计数，仅深拷贝最多 50 条返回记录；
  三轮同负载 CPU 减少 30–49%，数据和收益边界见 `docs/performance/domain-query.md`。

- 在每个 agent step / 工具结束的事件同步中，移除重复 JSON 解析，并仅为
  未提交事件构造 DTO；全部历史记录仍逐条验证 MAC、writer 和同 ID 冲突。
- 可复现多规模数据与适用范围见 `docs/performance/domain-replay.md`。
- Reuse archive directory lookups within one index load on the official domain
  observation path; retain fresh discovery on every subsequent load.
- Preserve archive reconciliation, checksums, MAC verification, fsync and
  pending/final transaction semantics; no official DSH source changes.
- On the reproducible 256-segment workload: median observation latency -42.61%,
  process CPU time -79.62%, directory enumeration calls -92.49%.
- 历史发布及发布后双宿主验收记录见 `docs/evidence/rc3-release-audit.json`；本轮不修改历史 tag 或公开资产。

## 0.2.0-rc.2 — release candidate

Supported hosts: DSH `0.2.0-rc.2` and `0.2.1-alpha.1` (exact alternatives),
Node `^22.19.0 || >=24.0.0`. Not published to npm.

本候选修复两条 CodeQL high：shell 守卫的多项式回溯，以及指标投影的弱随机兜底 ID。保持核心 Evolution 流程与显式指标身份，重新执行双宿主真实验收。发布链验证 sourceCommit 的实际包内容，确保 tag、源 commit、manifest 与产物内容一致。

### Added

- **A source-commit pin.** `npm run release:publish` now records `sourceCommit`
in `release/manifest.json`, and the release workflow requires it: a new release
cannot be published unless the pin names a commit in the tagged history. The
check is `scripts/release/verify-provenance.mjs`, covered by
`test/release-provenance.test.mjs`.
- **Code scanning.** `.github/workflows/codeql.yml` runs CodeQL for
`javascript-typescript` on `main`, on every pull request and weekly, and uploads
the SARIF results to GitHub code scanning.

### Changed

- **The release workflow can no longer overwrite a published asset.** It refuses
to touch a release that is already published or already has assets, uploads
without `--clobber`, and downloads the assets GitHub ends up serving to re-verify
them against the pin. `workflow_dispatch` gained a `dry_run` input that runs
every check and touches nothing.
- **The release workflow verifies tag, commit, manifest and checksums before
attaching anything.** It checks out full history (so the pinned source commit
can be walked) and fails when the tag does not match the version, the checked-out
commit, the pinned source commit or the pinned content.
- **GitHub Actions now run on Node 24.** `actions/checkout` and
`actions/setup-node` move to `v7`, `actions/upload-artifact` to `v7` and
`pnpm/action-setup` to `v6`, which removes the `Node.js 20 is deprecated`
runner warning the previous releases emitted.
- **`test/workflows.test.mjs`** now locks the release guarantees, the CodeQL job
and the action runtimes instead of only the job names.

### Notes

- `lib/guard.js` 使有序命令/写动词在互不重叠的候选区间内匹配，保留导出的 `RegExp` 接口并消除无界回溯，重定向去掉可重试的数字/空白前缀；保留 deny/allow 决策并增加带子进程硬期限的风险回归。
- 指标兜底身份使用 `crypto.randomUUID()`，同一投影的 `id` 与对应 `taskId` / `goalId` / `agentId` / `sessionId` 一致；调用方身份优先级不变。
- `sourceCommit` 必须来自已提交的包内容，且其 git 对象摘要等于 tag 树与 tarball，祖先关系不再是唯一来源校验。
- 原同名 rc.2 draft/tag 经维护者授权重建；旧记录保留，历史 rc.1 tag 和资产不变。
- The `v0.2.0-rc.1` tag points at a commit whose committed artifact differs from
the bytes that were published under that release. The hardened workflow now
fails on exactly that mismatch. It is recorded in `RELEASE.md` as a known risk of
the historical release; rewriting the tag or the release is out of scope.

## 0.2.0-rc.1 — release candidate

Supported hosts: DSH `0.2.0-rc.2` and `0.2.1-alpha.1` (exact alternatives),
Node `^22.19.0 || >=24.0.0`. Not published to npm.

This candidate contains **no runtime change**: the shipped `lib/` is exactly
`0.2.0-dev.6`, re-verified end to end on both hosts. It adds the release and
verification layer that turns that state into a reviewable artifact.

### Added

- **A release pin: `release/manifest.json` + the released tarball.** The bytes
  that get published are committed and verified rather than rebuilt. Packing is
  only byte-stable within one npm version (see *Fixed*), so one artifact is
  stored: `npm run release:publish` copies the build into `release/`, records
  its `sha256` and its environment-independent `contentSha256`, and
  `npm run release:verify [<tarball>]` checks either one. `--content-only`
  checks a locally rebuilt tarball, whose bytes may legitimately differ.
- **`npm run pack:check`** replaces the bare `npm pack --dry-run`: it fails on
  a pack that is not byte-stable in this environment, on an archive that is not
  exactly `package.json#files`, on a non-canonical file mode, on shipped text
  carrying a local home path or credential-shaped material, on
  `package-lock.json`/`package.json` drift, on a version that is not a
  pre-release, on a README that documents a superseded version, on a missing
  CHANGELOG entry, on missing install/doctor/upgrade/rollback/uninstall
  instructions — and on a `release/`, `docs/evidence/` or working tree that no
  longer describes the pinned artifact.
- **A content digest instead of a byte-only guarantee.** The archive is read
  with Node's `zlib` and a minimal ustar reader (no external `tar`), and
  `contentSha256` covers every entry's path, mode and content. This is what the
  acceptance evidence, the pin and the CI check across platforms.
- **A committed host-acceptance harness**
  (`scripts/acceptance/run-host-acceptance.mjs`). It installs the requested
  official DSH release into a throwaway runtime, installs the packed tarball
  through the official plugin CLI into a fresh `$DSH_HOME`, and drives the real
  host through the CLI doctor, the core
  `inspect→propose→trial→measure→revert` flow (requiring proven runtime
  recovery), the official pluginManager disable/enable semantics, CLI
  uninstall/reinstall with data retention, the README upgrade and rollback
  flows (a re-versioned build of the same tree, then the current tarball), real
  promotion with a second confirmation gate, startup-canary commit across a
  restart, and a canary rollback that removes only the new candidate. Its
  evidence records both the bytes it installed and the content digest, with
  local scratch paths redacted.
- **Committed acceptance evidence** for both supported hosts:
  `docs/evidence/dsh-0.2.0-rc.2.json` and
  `docs/evidence/dsh-0.2.1-alpha.1.json`.
- **GitHub CI** (`.github/workflows/ci.yml`): unit tests on Node `22.19.0` and
  `24.x`, a packaging job (byte stability, allow-list, canonical modes, the
  committed pin, a `--content-only` check of a locally rebuilt artifact, and a
  doctor start with no host packages present), and a per-host acceptance job
  that also asserts its evidence matches the pinned content.
  `test/workflows.test.mjs` parses both workflow files, pins the CI job set and
  the accepted host matrix to the declaration, and fails if the release
  workflow could publish anything other than a draft, rebuild the released
  bytes, or reach npm. `test/release-pin.test.mjs` checks the pin against the
  committed artifact and the working tree without running `npm pack`.
- **Tag-triggered release workflow** (`.github/workflows/release.yml`) that
  verifies the tag against the version, verifies the pinned artifact, and
  attaches exactly those bytes to a **draft** GitHub release. It deliberately
  does not rebuild: a rebuild on the runner would have different bytes from the
  artifact the acceptance ran against.
- **`RELEASE.md`** with the artifact list, the reproduction steps, what
  "reproducible" does and does not mean here, and the remaining release risks.

### Fixed

- **`npm test` did not run on Node 22 or 24.** `node --test test/` treats the
  argument as a module path on those versions and failed with
  `Cannot find module '.../test'`, so CI could never go green on the declared
  engine range. The suite now uses explicit globs
  (`node --test "test/**/*.test.mjs" "test/**/*.test.js"`), verified on Node
  `22.19.0` and `26.10.0`. As a side effect of the same fix,
  `test/full-cross-session.integration.mjs` — a real integration test that the
  old command silently never ran — is now discovered and passes (renamed to
  `*.integration.test.mjs`).
- **The tarball used to depend on the checkout's umask.** `npm pack` records the
  on-disk mode, so three files that happened to be `0600` in the development
  tree produced a different hash than the same commit in a fresh `git clone`
  (`0644`), while git tracked no such difference. Packaging now copies exactly
  the declared entries into a staging directory and normalises modes to
  `0644`/`0755`.
- **The "reproducible tarball" claim was wrong across npm versions.** The same
  tree packs to different bytes under npm 10 and npm 11 — the compression runs
  through the bundled zlib. Measured: `46f6e4a4…` with npm `10.9.3`, `040e0d9e…`
  with npm `11.19.1`, with byte-identical unpacked files and identical
  uncompressed tar size. The guarantee is now split honestly: byte identity
  within one environment, `contentSha256` everywhere, and one pinned artifact
  for what is actually published.
- **`lib/`-only runtime files no longer ship the release tooling.**
  `package.json#files` now names `scripts/doctor.mjs` and
  `scripts/import-evolution-data.mjs` instead of the whole `scripts/`
  directory, so the acceptance harness and release scripts stay out of the
  user-facing bundle (48 entries instead of 56).

### Notes

- The doctor still reports `degraded` immediately after a fresh install
  (`data.root` is created on first run); the post-boot diagnosis is `healthy`.
- Nothing was added to `peerDependencies`: `0.2.1-alpha.1` remains supported
  only because the full acceptance passes on it.

## 0.2.0-dev.6 — superseded by 0.2.0-rc.1

Supported hosts: DSH `0.2.0-rc.2` and `0.2.1-alpha.1` (exact alternatives),
Node `^22.19.0 || >=24.0.0`.

### Changed

- **The service inventory no longer depends on a private Cordis method.**
  `ctx.reflect._getImpl()` is replaced by the documented `ctx.reflect.store`
  ("service implementations, keyed by isolation label", with the exported `Impl`
  type) plus the documented `Context.isolate` key. The private method is kept
  only as a fallback for a host where `reflect.store` is unreachable, and the
  doctor records which path answered (`public: ctx.reflect.store +
  Context.isolate` on both verified hosts). Verified equivalent to
  `_getImpl(name, false)` for bound, unbound, isolated and disposed providers.
- **The promotion gate no longer trusts a numeric `FiberState`.** `FiberState`
  is a `const enum`, so it is erased from the published cordis runtime and
  `state !== 2` was an unverifiable literal. `fiberIsActive()` decides ACTIVE
  from the documented `uid`, `store` and `inertia` fields, asserted equal to
  `state === FiberState.ACTIVE` across every lifecycle transition
  (PENDING/LOADING/ACTIVE/FAILED/DISPOSED/UNLOADING) against the real package.
- **The mounted promoted row is resolved through the loader's public API.**
  `EntryTree.store[rowId]` is replaced by `EntryTree.resolve(rowId)`; the
  verify path awaits the row's fiber (`Fiber.await()`) so an in-flight
  transition is settled before the activity decision, and a failed activation is
  reported as inactive with its own cause.
- **`lib/cordis-compat.js` is the single source of truth for host-surface
  dependencies.** The runtime readers and the doctor consume the same classified
  table (public / undocumented / private, owning package, what is read, the
  public replacement, or the recorded reason why none exists).
- **`host.version` now reports whether the found host is one of the versions
  verified by a real acceptance run** (`verified`, `verifiedHosts`), derived from
  the declared alternatives so the answer cannot drift from the declaration.

### Added

- DSH `0.2.1-alpha.1` is a verified supported host. It was accepted only after
  the full acceptance run passed on it, against a fresh `$DSH_HOME`: install,
  boot, all 9 tool registrations, in-session and CLI doctor, core
  `inspect→propose→trial→measure→revert`, execution-bridge fault injection with
  an idempotent repair, restart recovery, promotion to `canary-observing`, stable
  commit, canary rollback, interrupted-promotion recovery, fail-safe on a
  `rollback-failed` journal, unsupported-host blocking, disable/enable,
  uninstall/reinstall with data retention, and a final doctor.
- `test/cordis-compat.test.mjs`: contract tests against the real installed
  cordis / loader / official Include packages — `serviceImpl` equivalence with
  `_getImpl`, the isolate-symbol identity assertion, `fiberIsActive`
  equivalence across all six lifecycle states, the recorded surface
  classification, a real promoted-Include mount with verify/health, and a torn
  composition failing closed.
- A regression test proving the doctor CLI starts with **no host package
  resolvable** (the bundle is copied without any `node_modules`), so a
  reintroduced host import in the doctor's import graph fails in CI instead of
  only in a real install.
- A regression test asserting no `lib/` file decides a fiber state from a
  numeric literal, and one asserting the declared support matrix equals the
  verified host list.

### Fixed

- **The service-inventory change must not put a host import into the doctor's
  import graph.** A first attempt imported `@deepseek-ai/cordis` inside
  `lib/cordis-compat.js`, which broke the doctor CLI in a real install
  (`ERR_MODULE_NOT_FOUND`) while the plugin itself still booted — the same
  constraint that makes `js-yaml` a bundle dependency. The module now imports
  nothing from the host: it takes the authoritative `Context.isolate` from the
  bundle entry at boot, falls back to the registered
  `Symbol.for('cordis.isolate')` key cordis itself builds, and the regression is
  pinned by a test that starts the doctor with no `node_modules` present.
- **`ctx.registry.values()`, `ctx.reflect.props`, `Fiber.getEffects()` and the
  `Fiber` lifecycle fields were misreported as non-public.** They are documented
  members of the exported cordis classes, so they are now classified as public
  and no longer counted as upgrade risk; only `ctx.events._hooks` and the
  `_getImpl` fallback remain private.

### Notes

- `scripts/import-evolution-data.mjs` is unchanged: staged, SHA256-verified,
  atomic, idempotent imports that refuse to merge differing source content.
- Known non-blocking limits are reported by every diagnostics run
  (`degradedCapabilities`): advisory domain evaluator, `continuous/` and
  `governance/` not wired into the live loop, host-only promotion through a
  cooperative (non-sandbox) gate, disabled legacy adapters, and the recorded
  private/undocumented surfaces listed in `COMPATIBILITY.md`.

## 0.2.0-dev.5 — unreleased

Supported host: DSH `0.2.0-rc.2` (exact), Node `^22.19.0 || >=24.0.0`.

### Added

- **Model-free diagnostics.** `lib/diagnostics.js` plus a
  `dsh-evolution-doctor` command (`scripts/doctor.mjs`, also runnable as
  `node <profile>/node_modules/dsh-evolution/scripts/doctor.mjs`). It reports
  `ok` / `degraded` / `blocked` / `not-evaluated` with per-check evidence over
  the installed package, the resolved DSH host and its module versions, the
  composed profile (official `dsh --dump-config`), live Cordis services, tool
  registration, internal-API probes, the Evolution data root, memory, cold
  archives, the signed execution event bridge, the domain aggregate and its
  archive lock, the legacy-import manifest, and promotion
  journal/composition/pointer. Exit codes: `0` healthy, `1` degraded,
  `2` blocked.
- **In-session diagnostics.** The `evolution_doctor` tool and
  `ctx.evolution.diagnose()` return the same report while checking the live
  registry (9 tools) and the mounted promotion Include adapter.
- **Safe, idempotent repairs** (`--repair`): boundary-valid interrupted promotion-journal
  rollback (backup + CAS), boundary-valid committed-journal cleanup, event-bridge
  partial-tail trimming, orphan domain staging removal, migration staging
  cleanup, and stale archive-lock removal. Every repair re-verifies and is a
  no-op on a second run. `rollback-failed`, unparsable or out-of-boundary
  journals (including unsupported record shapes under the shared rule in rc.8),
  unverifiable event MACs, conflicting event ids, missing pending
  archives and altered immutable migration evidence stay `blocked` with
  `recoverable=false` and are never modified.
- `CHANGELOG.md` and a `bin` entry so the doctor is discoverable by name.

### Fixed

- **Startup was permanently blocked by an interrupted archive-lock write.** An
  empty or unparsable `domain-archive.lock` used to throw
  `E_DOMAIN_ARCHIVE_LOCK` forever. The runtime now reclaims a lock whose owner
  is dead, and waits for an unparsable lock to settle before reclaiming it, so
  an in-flight writer is never displaced. A lock held by a live process is
  still never stolen.
- **The doctor CLI silently did nothing when its path contained a symlink**
  (for example macOS `/tmp` → `/private/tmp`). The entry-point check now
  compares real paths.
- **`js-yaml` was only a peer dependency**, so running the doctor from a
  plugin-only profile failed with `ERR_MODULE_NOT_FOUND`. It is now also a
  bundle dependency, and a missing parser degrades to an explicit
  `not-evaluated` YAML check instead of crashing.
- **In-session host detection could pick an unrelated global `dsh`** from
  `PATH`. The running process entry now wins, and conflicting host versions are
  recorded as evidence.
- **Migrated legacy durable pointers were misreported as stale.** A pointer
  that the migration manifest explicitly keeps inactive
  (`No legacy promoted code execution`) is now reported as intentionally
  unmounted.

### Notes

- `scripts/import-evolution-data.mjs` is unchanged: staged, SHA256-verified,
  atomic, idempotent imports that refuse to merge differing source content.
- Known non-blocking limits are reported by every diagnostics run
  (`degradedCapabilities`): advisory domain evaluator, `continuous/` and
  `governance/` not wired into the live loop, host-only promotion through a
  cooperative (non-sandbox) gate, disabled legacy adapters, and the internal
  Cordis surfaces listed in `COMPATIBILITY.md`.
