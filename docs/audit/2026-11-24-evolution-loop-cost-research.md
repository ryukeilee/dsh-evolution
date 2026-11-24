# 完整自我进化闭环耗时与成本研究（2026-11-24）

本轮为开放性研究。目标不是复述设计意图，而是用本机真实记录与仓库代码还原“配对会话约 406.5 秒、完整闭环却耗时数小时”的原因，并只修复有充分证据、具备实质收益的问题。所有结论均标注证据来源；无法从代码或记录证明的部分明确标为推断。

## 1. 证据来源

- 本轮正式证据：`~/.dsh/storages/evolution/archive/experiments/exp-mwutxr2n-2-7f8201f6.evidence.json`（只读）、`~/.dsh/storages/evolution/desktop-tasks/task-evidence/desktop-task-readbudget-r1.json`。
- 本机隔离复现目录：`/tmp/dsh-evo-readbudget/`（`model.yml` / `model-nokey.yml` / `host.txt` / `candidate.yml` / 六份会话 jsonl / `metrics.py`）。
- 仓库代码与历史证据：`scripts/acceptance/run-task-benefit-loop.mjs`、`scripts/acceptance/task-benefit.mjs`、`scripts/acceptance/model-bridge.mjs`、`lib/orchestrator.js`、`lib/promoted-sharing.js`、`lib/promoted-consumer.js`、`lib/self-evolution-review.js`、`docs/evidence/task-benefit-*.json`、`docs/audit/2026-11-24-capped-read-loss.md`。

本轮实验的身份与绑定事实：

| 字段 | 值 |
| --- | --- |
| `taskBenefit.kind` | `paired-real-session`，`complete: true` |
| `task` | `read-large-file-sentinel` |
| 候选源码摘要 | `5c9a5580309dae5426ada75154d79e832845a95e0943e04ef191a39fb672a56c` |
| 模型 | `opencode-go/deepseek-v4.1-flash` |
| 宿主 | DSH `0.2.2-rc.5`、Cordis `4.1.0` |
| baseline | 3 次、16 次工具调用、155682 tokens、290584 ms |
| candidate | 3 次、9 次工具调用、99273 tokens、115940 ms |
| 收益判定 | `improved: true`、`benefit: true`、`sessionsExercised: 3` |
| 发布范围 | `shareTargets: ["acp"]` |
| 内核时间线 | `proposal.createdAt` 15:08:33 → `stableCommittedAt` 15:14:26（约 6 分钟） |

## 2. 数小时耗时的真实归因

**生产进化内核不调用模型，也不产生配对会话。** `plan` 是 model-free 的有界发现（`lib/orchestrator.js:5956-5963`），`probe` / `measure` / `promote` / `canary` 全是本地状态机与文件/SQLite 操作（`lib/orchestrator.js:6328`、`6582-6623`、`6715`、`7123`、`7659`）。因此 406.5 秒与数小时都不属于“生产进化执行成本”。

数小时来自**开发验收 harness 被整段反复重跑**：

- `docs/audit/2026-11-24-capped-read-loss.md:179-195` 逐次记录 run1…run15（含多次中止与临时诊断），原因包括候选失败轮、功能复验提前拦下、pilot 自读夹具、沙箱缺 `Buffer`、复审再修等。
- 已固化证据的时间戳跨度：`task-benefit-0.2.16-plan-driven-form-final-20261124.json` 为 02:57:25Z→03:00:46Z，`...run1-incomplete` 03:38:45Z→03:47:30Z，……，`task-benefit-0.2.16-capped-tail-20261124.json` 05:12:02Z→05:18:23Z。仅这一场景的已保存证据就跨约 2h21m。正式数据根里的五次完整实验散布在 05:09、07:39、11:05、15:08、20:32（UTC），全日跨度超过 15 小时。
- **单次闭环的固定成本**（`run-task-benefit-loop.mjs`）：Desktop App 进程 ×3（`:501`、`:552`、`:900`，每处等待上限 180 s）；ACP 进程 ×13（配对 6、负向 4、delegate 1、confirm 1、fresh consumer 1）；model bridge ×2；4 个完整负向委托闭环；5 s 硬编码 sleep（`:656-661`）。
- 配对会话完全串行（`task-benefit.mjs:1423-1425`），每会话一个新 ACP；每个模型 turn 通过 `spawn('opencode', ['run', ...])` 起**一个新 CLI 进程**（`model-bridge.mjs:164`），单 turn 上限 180 s，格式失败最多重试 2 次（`:340-373`），会话级失败还会整段重跑一次（`task-benefit.mjs:1436-1449`）。
- 每轮 `buildDecisionPrompt` 把完整 system + 工具 schema + 全部历史消息重新渲染给模型（`model-bridge.mjs:93-115`），所以本轮 3 turn/会话的 token 达到约 52K/会话（baseline 155682 / 3）。这是 token 成本的主要来源，而不是候选 capability 本身。
- fresh consumer 阶段又起第二个 bridge 与一批真实推理（`run-task-benefit-loop.mjs:725-739`），历史证据约 4 turn / 29.9 s。

**额外 API Key 的来源（推断）**：仓库内没有字面量 `OPENCODE_GO_API_KEY`；`model-bridge.mjs:38` 固定 provider/model 为 `opencode-go/deepseek-v4.1-flash`，`runOpencodeTurn` 以 `env = process.env` 透传给子进程（`:155`、`:165`），因此该 provider 的本地凭据必须由环境提供。本机隔离目录的 `model.yml` 还显式写了 `apiKeyEnv: OPENCODE_GO_API_KEY`，`model-nokey.yml` 删掉该行后可退化为使用已有环境配置。另有 `EVOLUTION_ACCEPTANCE_KEY`（`run-task-benefit-loop.mjs:251`）只是夹具占位值，不是模型凭据。结论：额外 key 是**开发验收 harness 的外部 `opencode run` 传输**带来的，不是产品运行链路的依赖。

## 3. 已修复的两个真实产品缺口

### 3.1 已 stable 记录无法新增 profile

`promote()` 要求 `state === "measured"`（`lib/orchestrator.js:7138`），不能对已 stable 的记录再次晋升；`enable`/`disable` 只作用于 `approvedProfiles` 中已有的 profile（`scripts/shared-plugins.mjs:148-157`），`revalidate` 保留原 `approvedProfiles`（`:214-218`）。因此“先发布到 ACP，后来想加 Web”只能重做完整实验，尽管收益证据绑定的是源码摘要 + 任务 + 模型 + 宿主版本，与 profile 无关。

新增 `dsh-evolution-shared approve --plugin <id> --profile <p> --approval <原文>`：重新校验记录结构并逐字节重哈希源码，只扩宽 `approvedProfiles`，同时写入脱敏、有界的审批注释（原文只留 SHA256 与摘要）。`publishedAt`、`stable`、源码/manifest 摘要、host 与 revalidation 代均不变。缺少明确批准、源码被改动、非消费 profile 一律拒绝；重复批准是 no-op。

### 3.2 迭代候选与既有 stable 插件能力重叠

`complete-read-line-budget` 与 `complete-read-line` 逐行对照后，唯一语义差异是放宽 `MAX_FILE_BYTES`（256 KiB→4 MiB）、`MAX_LINE_CHARS`（16 KiB→32 KiB）、改名，并增加 abort 守卫。候选提案本身承认是对既有插件的扩展（`exp-mwutxr2n-2-7f8201f6.evidence.json` 的 `proposal.strategy/rootCause`）。但发布记录没有能力身份、没有 `supersedes` 接线（`lib/promoted-sharing.js:797-842`、`671-706`），两条记录都批准给 acp 且都 `active`（`~/.dsh/storages/evolution/shared-plugins/consumers/acp.json`），于是同一 `read` 结果被两个 `tools/post-execute` 监听器重复处理。

新增 `supersede --old <id> --new <id> --profile <p> --approval <原文>` 与 `revoke-supersede`：
- 双方必须都是已发布、结构有效、字节未被改动的记录，且都已在该 profile 获批；
- `supersededBy` 按 profile 分别保存，精确绑定新记录 id、源码摘要、批准原文 SHA256 与索引摘要，写在同一次索引锁/原子写内；同一 profile 的链式替换被 CLI 明确拒绝；
- consumer 在**同一次快照内完成全部资格判定后**才应用条目并沿链走到最终仍合格的版本（`lib/promoted-sharing.js` 的 `applySupersession`、`lib/promoted-consumer.js`）：终点 `eligible` 且每跳字节匹配时，旧记录才报 `disabled` / `superseded-by`；替换方进入 `pending-revalidation`、字节变化或资格失败时旧记录保持 `active`；替换方在官方 Include 挂载后 `apply()` 失败时，同一次启动即恢复旧记录；
- `revoke-supersede` 在**同一把锁**内禁用替换方并清除该 profile 的条目，避免与 `enable` 交错成两条同时启用；`enable` 可单独恢复替换方；
- 所有注释都经过 closed-shape 校验（`lib/promoted-sharing.js` 的 `validApprovalExtension` / `validSupersededBy`），批准原文只留 SHA256，不进入索引或撤销原因。

## 4. 量化对照（隔离 fixture，未触碰正式数据根）

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| 已 stable 记录新增一个 profile | 必须重新走完整闭环（Desktop ×3、ACP ×13、配对会话 ×6、模型 turn ×34–46） | `approve` 一条本地 CLI 写；重哈希 + 一次索引原子写，0 次宿主启动、0 次模型调用 |
| 改进版候选替换既有 stable | 两条同时挂载，重复 `tools/post-execute` | `supersede` 后一次 consumer 启动只挂替换方；替换方失效时旧方自动保持启用 |
| 撤回替换 | 无受支持路径，需手工改索引 | `revoke-supersede` 一次写 + 既有 disable 机制；下一次启动恢复旧方 |
| 未触碰的边界 | — | 八项门禁、`confirmation: true`、canary、stable 证明、源码字节、崩溃恢复与逐入口安全检查全部不变 |

“数小时”的绝对值因 15 次重跑的失败原因各不相同，无法给出单一可复现的 A/B 对照；上表只列可隔离复现的部分。没有声称模型调用次数或 Token 消耗被本轮代码修复降低。

## 5. 未修改事项与剩余限制

1. **外部模型桥与额外 API Key 未改。** `model-bridge.mjs` 每个 turn 新建 `opencode run` 进程并重送完整 transcript，这是开发验收 harness 的成本；把它改为复用原生宿主会话会改变证据的上下文语义，且本机不能在不使用额外凭据的前提下取得真实模型对照。按“不伪造收益、不降低证据质量”的约束，本轮只把它和正式链路的边界写清楚，不做无证据的性能声明。
2. **验收脚本的固定成本未改。** 三次 Desktop 启动、四次负向控制、fresh consumer 与重启都是既有验收的证据独立性要求；本轮不通过删减验证换取耗时。
3. **不自动下线任何 stable 记录。** `supersede` 只由显式授权 CLI 写入；review 仍保持只读。
4. **不扩大授权。** `approve` 不能替代 `confirmation: true`，`revalidate --evidence` 不能扩大 `approvedProfiles`，两者边界未变。
5. **正式数据根未修改。** 本轮只读本机证据；所有新增测试都运行在 `os.tmpdir()` 下的隔离数据根。

## 6. 验证

新增 `test/shared-supersession.test.mjs`（纯标记校验与索引身份保持）、`test/promoted-consumer.test.mjs` 的消费者集成用例（一次启动只挂替换方、撤销后只挂旧方），以及 `test/shared-plugins-cli.test.mjs` 的 CLI 用例（批准扩权、重复批准 no-op、被篡改字节拒绝、supersede/revoke 往返）。聚焦测试与全量回归、打包检查的实际结果以提交时的 CI/本地执行输出为准，不在此处引用未重跑的历史数字。
