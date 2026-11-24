# 自我进化主闭环第七轮开放性研究（2026-11-24）

## 1. 范围与方法

基线：`4441731974628bd9698855f07600bbd818aa746a`（`origin/main`，PR #96 合并点）。

- 第一层：6 个并行只读研究子代理，分别覆盖采集/检索/发现、规划/决策/收益评估、晋升/发布/跨入口、复用归因/反馈学习、持久化/恢复/诊断、自主观察者/端到端证据一致性。每个方向要求当前源码 file:line、真实调用链、可运行复现与严重度，并显式排除前六轮已修复项。
- 第二层：对进入评估的候选发现启动不同模型的独立交叉验证（codex / gpt-6.1-terra high、pi / deepseek-v4.1-flash max）。
- 第三层：sol-loop（codex / gpt-6.2-sol / reasoningEffort high）与 council 双模型独立复审。
- 全程只读研究，复现仅用 `os.tmpdir()` 与合成数据；未触碰正式 DSH_HOME、正式经验库或已安装插件；未发布版本、未创建 tag、未执行 `revalidate --apply`。

## 2. 总体结论

6 个方向的研究一致确认：主闭环的可用性、门禁、授权、崩溃恢复、发布字节固定与前六轮修复均保持有效，未发现新的主链断点、门禁绕过、数据丢失或跨进程状态不一致。

唯一具有实质影响的发现位于「证据与收益评估 → 反馈学习」接缝：**双证据结论的指标来源与判定依据错配**。已修复并有反证、差分与真实宿主验收支撑。

## 3. 确认并修复的问题

### 3.1 结论携带与判定矛盾的 probe 正向指标（should）

**根因**：`lib/orchestrator.js` 的 `conclusionMetrics()` 无条件用 `probeBasis ?? taskBasis` 选择指标来源。当 Desktop plan 同时声明 workload probe 与 task artifact 时，`measure()` 的 both-exist 分支（`:6716-6720`）只合并 `solvesProblem`/`repeatable`/`regressionPassed`，顶层 `beforeMetrics`/`afterMetrics` 仍是 probe 的数字；task artifact 的真实会话数字只在 `latestObservation.taskBenefit.baseline/candidate`。于是当 task artifact 确实运行机制却证明无收益（或成本回归）时，`classifyExperimentDecision()` 正确判定 `no-benefit`/`regression`，但写入共享经验的结论却带 probe 的 `successRateDelta: +0.5` / `errorsDelta: -5`。下一轮 `discover`/`plan`/`review`/`recall` 读到的是「已证伪」旁边挂着正向收益数字，可能诱导错误假设。

**真实可达路径**：`evolution_plan` → propose → trial → `probe baseline/candidate` → `task-benefit.mjs` 配对会话产物 → Desktop `measure()`（两证据并存）→ 决策 `no-benefit` → 晋升门禁拒绝 → `publishConclusion()` → 共享经验（round6 扩展的 recall 指标窗口会原样投影出来）。

**反证**：修复前运行合成复现得到 `decision.kind = no-benefit`、`conclusion.metrics = { successRateDelta: 0.5, errorsDelta: -5 }`；新增回归中 3 项在旧源码失败。

**修复**：仅当 (a) 存在 probe basis、(b) probe 自身未报告 regression、(c) 已验证 task artifact 的 `mechanismRan === true` 且其 `benefit === false || regression === true`、(d) 判定确为 `no-benefit`/`regression` 且 artifact 的 baseline/candidate 可读时，用 task artifact 的会话数字投影结论指标。其余组合保持原路径。

**不变量**：probe-only、task-only、probe 负/task 正、双正、probe 自身回归五种情形的结论指标逐字节不变；probe 数字仍完整保留在 observation、实验归档与证据 sidecar；`promotionGates`、owner confirmation、授权、状态机与持久化格式均未改动。

**证据**：`test/review-fix-conclusion-metric-source.test.mjs`（8 项，含反证与边界表驱动）；修复后复现输出 task deltas。

## 4. 调查后决定不修改的项

| 项 | 结论 | 依据 |
| --- | --- | --- |
| 撤销已发布记录不回写共享经验 | **NO-CHANGE（nit）**。状态可达，但撤销只取消跨入口激活资格，Desktop stable 晋升不受影响；`adopted` 是曾通过 canary 的真实历史事实。写负面结论/清除采纳事实会误述操作者意图。审计侧 `inactive`/`usage-unknown` 与符合条件的新失败重开候选均已覆盖。 | `orchestrator.js:7780`、`promoted-sharing.js:1028-1056`、`experience-plan.js:884,938-961`、`self-evolution-review.js:884`；docs/shared-plugins.md:140；交叉验证判定 nit |
| 随包入口强制关闭自主事件观察者 | **NO-CHANGE（已知安全取向）**。`index.js:83-86` 无条件 `dailyAutonomousObservation=false`，`registration.js:567` 因此不挂载观察器；这落实不变量 6「默认不会自己上生产」。README 配置描述的一致性是第三轮已登记的文档 nit，非主链断点。 | `docs/audit/2026-11-24-open-reliability-round3.md:101-102`；不变量 6 |
| revalidate 未校验证据 host 与当前数据根 host | **NO-CHANGE（round6 已登记）**。需操作者手工拿错宿主证据，runner 每次克隆后按当前宿主重检；非主链断点。 | `scripts/shared-plugins.mjs`、`run-revalidation.mjs` |
| host 不匹配时 usage 投影 `profiles` 为空 | **NO-CHANGE**。动作仍为 `revalidate`，`installed:false` 抑制停用建议，不改变决策。 | 复用/反馈代理报告 |
| capability-usage / recall 上限 / 清理尾段死代码 / functionalCheck 文案 | **NO-CHANGE**（低影响或前轮已登记）。 | 各代理报告与 AGENTS.md 不变量 |

## 5. 验证

- 反证：新增测试中 3 项在旧源码失败（probe 正向指标被写进负面结论）；修复后 8/8 通过。
- 聚焦：结论来源 + 生命周期 + 共享结论 + 反馈保真 + recall + plan + review 共 **203/203** 通过（补边界用例后最终 8 项新测试全绿）。
- 全量：`NODE_OPTIONS=--max-old-space-size=4096 npm test` 最终树 **2202 项，2200 通过 / 0 失败 / 2 跳过**（基线 2194 → +8）。
- 打包：`npm run pack:check` **17/17** 通过；工作树是 v0.2.19 固定点的已提交后继，固定点、产物与既有证据未改动；未执行 `--release` 或任何发布动作。
- 隔离真实宿主验收：`npm run release:pack` 后对 `0.2.2-rc.5` 运行 `npm run acceptance:host -- --no-hmr --experience-evolution --cross-entry`，**39/39 步骤 ok**（安装/lifecycle/升级回滚/真实晋升/经验驱动实验 seed-invalid-restart-regression/跨入口发布-消费-重启-撤销-重验证/最终 doctor）。证据写入 `docs/evidence/dsh-0.2.2-rc.5-round7-conclusion-source.json`，只使用隔离 runtime/home。
- 说明：宿主验收覆盖完整闭环在真实环境中的持续有效；双证据这条窄分支的直接证明来自复现脚本与差分单元测试，因为标准验收夹具不声明同时存在的 workload 与 task 证据。

## 6. 独立复审结果

- 交叉验证 A（codex / gpt-6.1-terra / reasoningEffort high）：VERDICT REAL、should；根因定位准确，指出更根本的结构性弱点是结论投影未记录「哪份证据产生了判定」，建议按判定来源选择数字、来源不明时宁可输出空 metrics，并要求保留单证据路径原样。
- 交叉验证 B（pi / deepseek-v4.1-flash / thinking max）：VERDICT REAL、should。该代理开始复核时 HEAD 仍为基线，亲测复现输出与报告完全一致；复核期间修复提交 `09aa0a6` 与边界测试 `71e1bb2` 落地，同一脚本随后输出 task deltas。它独立确认可达路径是文档化的 workflow 正路（`desktop-task-host` 允许 tool 形态同时声明 workload + task），朴素修复（`taskBasis ?? probeBasis`）仍会失败（both 场景的顶层 before/after 装的是 probe 数字），当前修复形态是最小正确解。差分实测：3 项新测试在旧源失败、HEAD 全绿；另跑相关测试 20/20 与 35/35。
- 交叉验证 C（codex / gpt-6.1-terra / high，针对撤销回写 F2）：状态可达但判定 nit、建议不改行为——撤销只取消跨入口资格，历史 `adopted` 仍是真实事实；写成负面结论会误述操作者意图，审计侧 `inactive` 与符合条件的新失败重开候选已覆盖。
- sol-loop（codex / gpt-6.2-sol / reasoningEffort high）：第 1 轮 **APPROVE**，仅 2 项 nit。已采纳其中 1 项（补 probe 自身回归与双正两种边界的表驱动用例，并让 task 回归夹具与验证器成本预算自洽），另 1 项（改走完整 `validateTaskBenefit()` 生成 artifact）因会给结论投影的单元测试引入大量绑定字段、收益低而 declined。按 sol-loop 规则，仅剩 nit 即停止。
- council（双模型独立反方复审）：
  - 第 1 轮：DeepSeek 4.1 Flash Max 7.5/10 CHANGES（T1 夹具形状、T2 场景判定两项 should；N1 措辞、N2 canary 既有边界两项 nit）；GPT-6.2 Sol High 9/10 APPROVE（1 should：真实 SQLite 贯通测试；1 nit）。
  - T1/T2 处置：双证据夹具顶层 before/after 改为 probe 数字（贴合 `measure()` 生产形状），补门禁字段使双正用例真正判 `benefit` 并断言；durable-only 变体不写顶层拷贝以固定"不依赖该拷贝"。两位复审者在第 2 轮各自用变异测试确认：读取顶层 before/after 的错误实现在修正后的夹具上 3/3 主用例失败（旧夹具仅 1/3），去掉门禁字段会使双正断言失败。
  - Decline：真实 SQLite 贯通测试（本次只改有界指标投影，store 去重/冲突语义未动且既有测试覆盖；交叉验证者已用真实 SQLite 验证）；为 N1 改行为（保持"task 证据驱动负判定即用 task 数字"这一更正确的语义，以本文 §3.1 的精确条件为准）；N2 记为既有剩余风险。
  - 第 2 轮：GPT-6.2 Sol High **9.5/10 APPROVE**，DeepSeek 4.1 Flash Max **9/10 APPROVE**，均无 blocker/should。后者另提一个低severity should：`mechanismRan:false` 守卫可达但未被固定；已补相应用例并用变异测试证明去掉该守卫即失败。前者 nit（注释只举 probe 正向情形）也已改为精确描述。

## 7. 剩余风险

- 共享经验结论仍是有界的摘要：probe 与 task 两套完整数字需回实验归档/observation 查，这是设计边界，不是缺陷。
- usage 投影仍是显式操作者 CLI 产出的离线事实；未扫描时 review 诚实报 `usage-unknown`（round6 已说明）。
- 撤销不回写共享经验是已知 nit（见 §4），本轮按证据与意图判断不改行为。
