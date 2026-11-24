# 完整自我进化主链开放性研究（第六轮，2026-11-24）

## 1. 范围与方法

基线：`098e3c60cf344ad9d81d136801eda52380aba356`（`origin/main`，v0.2.19 固定点 + 最终收敛审查）。

- 6 个独立只读子代理并行覆盖完整闭环：经验输入侧、决策与收益测量、Trial→晋升→发布、跨入口实际复用、长期运行/容量/恢复、端到端接缝与遗留项重估。每个方向都要求当前源码的 file:line、真实调用链、可运行复现与严重度，并显式排除前五轮已修复项。
- 主代理对每条进入修复的发现独立复核根因，并按「先让新用例在旧源码上失败、再让其在修复后通过」取证；所有复现只用 `os.tmpdir()` 与合成数据，未触碰正式 DSH_HOME、正式经验库或已安装插件。
- 独立复审通过 sol-loop（codex / gpt-6.2-sol / reasoningEffort high）与双模型 council 完成；结论见第 5 节。
- 本轮不发布版本、不创建 tag、不修改本机正式 DSH 安装与持久化进化成果。

## 2. 研究覆盖与总体结论

覆盖：采集 → 共享经验存储 → 有界检索 → 发现/规划 → 提案 → probe → measure → 结论 → canary → 晋升 → 发布 → 跨入口消费 → 实际调用归因 → 任务收益 → 反馈学习 → 重验证 → 容量回收 → 重启恢复 → 诊断一致性。

主链的可用性、门禁、授权、崩溃恢复与发布字节固定在前五轮已充分收敛；本轮六个方向的独立研究**未发现新的主链断点、门禁绕过或数据丢失路径**。所有具有实质影响的发现集中在**反馈学习与复用证据保真度**：一个模块记录的「事实」在跨阶段传递时被降级、丢弃或误读，使系统「能跑/能加载」被当成「被实际复用/任务真受益」。

## 3. 确认并修复的跨阶段缺陷

| # | 根因 | 影响 | 修复 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | `capability-usage.js` 用 `callId` 做全会话单调去重，但官方宿主在 PTC envelope 的不同执行对象间复用 `callId`（`experience-collector.js:192-196` 的真实退化丢失已证实） | 真实的发布工具调用被判 `duplicate` 丢弃；复用 `callId` 的生命周期调用不进 `open`，其下调用被误记为 workflow 而非 verification，usage 投影与 in-use 判定失真 | 每条 `tool/call` 行独立计数；生命周期调用改为本地实例 token 跟踪，按 `callId` FIFO 关闭，不再全局去重 | 新增 `test/review-fix-feedback-fidelity.test.mjs` 两例：旧源码返回 `duplicate` / workflow=1，修复后 `pending` / workflow=2、verification=1 |
| 2 | `conclusionMetrics()` 与 `failureMode` 只读 `record.probe.comparison`；context-policy / taskBenefit-only 实验没有 probe，真实 before/after 数值只写在 `latestObservation` | 下一轮 discover/plan 与统一审查看到 `adopted`/`regression` 却没有度量，无法量化真实任务受益；成本回归也丢失失败原因 | 无 probe 时改从 `latestObservation.beforeMetrics/afterMetrics` 投影有界任务增量；`taskBenefit.regression` 写入 `failureMode`。probe 路径输出逐字节不变 | 新增两例：旧源码 `metrics:{}` / `failureMode:''`，修复后含 `turnsDelta:-3`/`toolCallsDelta:-3` 与 `failureMode:'regression'` |
| 3 | `self-evolution-review.js` 的 value tier 只看 invocation 计数，不看记录是否已被撤销 | 全 profile 已撤销的记录仍被报为 `in-use`/`production-benefit`，历史调用被当作当前复用，虚高 valueSummary 并掩盖 restart 动作 | 仅在「所有 profile 已撤销且带 operator-disabled / active-after-revocation 证据」时降为 `usage-unknown`；仅缺活跃 consumer 行、无撤销证据的记录保持原 tier | 新增一例：旧源码 tier=`in-use`，修复后 `usage-unknown`；既有 127 项聚焦用例保持通过 |
| 4 | `plan()` 与 `reviewExperience()` 把被截断的 discover 窗口报成 `no-failure-signal` | 长期运行库超过 500 条时，窗口外的低频真实问题永不进候选，owner 与模型误判「无失败信号」而停止进化 | 无候选且 `sources.truncated` 时改报 `discovery-window-truncated`，附 considered 数与收窄提示；review 的 `incomplete:true` 保持 | 既有生命周期用例新增断言：旧源码 `no-failure-signal`，修复后 `discovery-window-truncated` |

## 4. 调查后决定不修改的项（真实影响 / 收益 / 成本）

| 项 | 结论 | 依据 |
| --- | --- | --- |
| `reclaim()` 的 `prefixEvidence()` 整份解码 | **NO-CHANGE**。唯一调用者是显式 `evolution_maintain`，且 replay 路径已有同型 A/B 撤回记录、可复用基准；属低收益微优化，不重写安全敏感回收路径 | `domain-storage.js:1001-1015`；`docs/performance/event-log-replay-memory.md:140-206`；`scripts/benchmarks/event-log-replay-memory.mjs` |
| 自主观察者收益证据自报 | **NO-CHANGE**。策略由宿主注入、可信扩展代码；仍停在 `candidate-awaiting-confirmation`，owner 确认门禁未变；要求其跑官方 probe 属新增机制，不是本轮缺陷 | `orchestrator.js:8495-8503,8560-8589`；不变量 6 |
| `revalidate` 采纳未校验证据 host 与数据根当前 host | **NO-CHANGE（本轮）**。需 operator 手动拿错宿主证据才能触发，非主链断点；runner 本身每次克隆后按当前宿主重新检测。列为后续加固候选 | `scripts/shared-plugins.mjs:190-216`；`run-revalidation.mjs:411-437` |
| plan→propose 的 target 靠模型回填 `problemKey` | **NO-CHANGE**。契约提示可改进，但 `conclusionScopeOf()` 已对 scope 做 canonical 归一化，且无证据表明真实提案因措辞漂移被重复证伪；改提示属低收益文案 | `shared-experience.js:174-176,516`；`registration.js:353-357` |
| functionalCheck 失败原因写成 "metric regression" | **NO-CHANGE**。verdict、回滚、学习判定均正确，仅 archive/理由文案偏差；前轮已登记，修复收益低 | `orchestrator.js:7592-7611`；final-convergence §4 |
| `recall()` 2000 上限、死代码、可选宿主接口分类等 | **NO-CHANGE**。输出仍受调用方上限约束；无行为影响或已有可选分类 | 见各代理报告与 `AGENTS.md` 不变量 |

## 5. 验证

- 反证：8 个新用例（含既有生命周期用例的新断言）在旧源码全部按预期失败；修复后全部通过。
- 聚焦：最终 183/183 通过（`review-fix-feedback-fidelity`、`experience-evolution-lifecycle`、`self-evolution-review`、`capability-usage-scan`、`shared-experience-conclusion`、`experience-attribution`）。
- 全量：`NODE_OPTIONS=--max-old-space-size=4096 npm test` —— **2192 项，2190 通过 / 0 失败 / 2 跳过**。
- 打包：`npm run pack:check` 17/17 通过；工作树是 v0.2.19 固定点的已提交后继，固定点、产物与证据未改动；未执行 `--release` 或任何发布动作。
- 隔离真实宿主验收：在最终树重新 `npm run release:pack` 后，对 `0.2.2-rc.5` 运行 `npm run acceptance:host -- --no-hmr --experience-evolution`，**26/26 步骤 ok**（含安装、lifecycle、升级/回滚、真实晋升、经验驱动实验、重启与回归、最终 doctor），证据写入 `docs/evidence/dsh-0.2.2-rc.5-round6-feedback.json`。只使用隔离 runtime/home，未触碰正式 DSH_HOME。

## 5.1 独立复审

- sol-loop（codex / gpt-6.2-sol / reasoningEffort high）：第 1 轮返回 5 项（3 blocker、2 should），第 2 轮返回 1 项仍开放的 blocker；逐条复核后全部按最小改动修复并有回归证明。第 3 轮因 codex 提供方额度限制未能启动（提示 14:27 可重试），不构成未解决的实质问题； council 在最终变更上完成了独立反方复审。
- council（双模型独立反方复审）：GPT-6.2 Sol High 对最终变更返回 4 项（2 P1、2 P2），均已修复：用官方 envelope 的 `seq` / `sourceEventSeqs` 精确关闭复用 callId 的生命周期；撤销任务专属 `failureMode`（它是知识身份维度）；任务指标要求 `mechanismRan`；召回投影窗口覆盖第七项 `durationMsDelta`。DeepSeek 4.1 Flash Max 结果见 PR 描述。

## 6. 剩余风险

- usage 投影仍是显式 operator CLI 产出的离线证据，运行时不扫描会话；未扫描时 review 诚实报 `usage-unknown`，不会伪造零或受益。
- 撤销记录仍保留在发布索引中（这是撤销表的语义）；本轮修复只纠正其价值分层，不删除历史事实。
- 长期增长的事实表仍依赖显式 `reclaim()` 容量治理；本轮未改变该契约。
