# 完整自我进化主链第八轮开放性研究（2026-11-24）

## 1. 范围与方法

基线：`443d46752f65402e7c225bcb0045d23d8d110440`（`origin/main`，PR #97 合并点）。

- 6 个并行只读研究子代理分别覆盖：采集→存储→检索→发现、规划→Trial→收益评估、决策→晋升→发布→跨入口、复用归因→反馈学习、持久化/恢复/诊断/长期运行、自主观察者→端到端证据一致性。每个方向要求当前源码 `file:line`、真实调用链、可运行复现与严重度，并显式排除前七轮已修复项。
- 对进入修复的发现启动独立交叉验证子代理，并用 sol-loop 做独立复审。
- 研究全程只读；复现只用 `os.tmpdir()` 与合成数据；未触碰正式 DSH_HOME、正式经验库或已安装插件；未发布版本、未创建 tag。

## 2. 确认并修复的问题

### 2.1 Canary 回归结论携带 probe/task 的正向指标（should）

**根因**：`lib/orchestrator.js` 的 `conclusionMetrics()` 在第七轮修复中只处理了 task artifact 驱动的负判定（`taskDroveNegative`），未按判定来源分流。canary 回归在 `:7677-7689` 写 `record.decision = { kind: "regression", source: "canary" }`，并在 `:7699` 调用 `publishConclusion(record, "regression", "canary")`；判定来自最后一道生产屏障（startup/component/dependency/functional check），与 measure 阶段的 probe comparison 是不同证据。旧代码仍用 `probeBasis ?? taskBasis` 投影，把正向 `successRateDelta:+0.5 / errorsDelta:-5` 写在 `regression` 结论旁，下一轮 discover/plan/recall 读到「已证伪 +  apparent gains」的误导性摘要。

**真实可达路径**：`evolution_promote(confirmed)` → `promote()` → canary-observing → `evolution_canary_observe`（Desktop `functionalCheck.matched:false` 或 `metricRegression:true`）→ `observeCanaryJournal()` 判 regression → 回滚 → `publishConclusion(..., "canary")` → 共享经验 → 下一轮发现。官方路径所有 canary 观测调用点（`desktop-task-host.js` 五处、验收探针、`verifyStartupCanary()`）都不传 `metrics`，且 `conclusionMetrics()` 从不读该参数，因此返回空指标不会吞掉 canary 自己的数字。

**修复**：仅当 `record.decision.source === "canary" && kind === "regression"` 时 `conclusionMetrics()` 返回 `{}`。probe/task 完整数字仍在 observation、归档与证据 sidecar；canary-passed（`source:"canary-passed"`）与 measure 出口的所有投影（probe-only、task-only、task-driven no-benefit、probe regression）逐字节不变。

**反证**：旧源码上 4 条 canary 回归用例失败（写入正向 delta）；修复后 7 项全绿。

### 2.2 回收 floor 分类器在「prior 前缀等于 tail」时永不截断（high）

**根因**：`lib/event-log-checkpoint.js` 的 `classifyLogFloorDescriptor()` 先用 `tail.bytes/tail.digest` 判定 `already-truncated`，再用完整 prior 判定 `deferred`。事件桥是 at-least-once，重复记录是有意的（`orchestrator.js:5152-5153`）；当被裁记录与保留记录逐字节相同时，`planLogPrune()` 产出的 prior 文件开头恰好就是 tail 字节，于是「仍是 prior 文件」被误判为「已经截断」。`completeEventLogTruncation()` 对该状态早返回，截断永不执行；`reclaim()` 每轮重复裁掉同一段但文件字节不变，floor 累计计数持续增长，被裁 marker 在下次 replay 中复活；doctor 同样报 ok。

**真实可达路径**：两条逐字节重复且被吸收的 envelope → `planLogPrune(retainRecords:1)` → prior=两行、tail=一行且两者头部相同 → 分类器误判。

**复现**：旧代码 `inspect=already-truncated`、`complete=already-truncated`、文件保持 384 字节；三轮后 floor 累计丢弃字节 187→374→561 而文件不变。修复后 `inspect=deferred`、`complete=truncated`、文件缩到 192 字节，第二轮 `planLogPrune` 返回 null。

**修复**：先判完整 prior 文件（命中则按后缀一致性返回 `deferred`/`unknown`），排除后再判 tail 前缀。启动 replay 与 `reclaim()` 都在 `planEventLogReplay`/`requireReclaimContinuation` 之前调用 `completeEventLogTruncation()`，因此该修复同时补上两处崩溃窗口。

**反证**：旧源码上新增回归 1/3 失败（误判 `already-truncated`）；修复后 3/3 通过。

## 3. 调查后决定不修改的项

| 项 | 结论 | 依据 |
| --- | --- | --- |
| canary 回归 `failureMode=""` 使规划报 `unattributed` | **NO-CHANGE（round6 已定设计边界）**。`failureMode` 是知识身份维度；task/canary 回归刻意写空值，以便后续 adopted 在同一规范行合并、正当取代旧负面。写入 `"regression"` 会劈开身份，既有测试 `test/review-fix-feedback-fidelity.test.mjs:135` 钉住该语义。本次尝试扩大改动后全量测试拒绝，已回退。 | `orchestrator.js:6073`；`knowledge.js` 身份序列化；`test/review-fix-feedback-fidelity.test.mjs` |
| 同一指纹下旧负面与新 adopted 分裂为两规范行，硬门禁与 plan 结论相反 | **NO-CHANGE（保守阻断为既定语义）**。身份分裂需要同一策略下显式传入不同 rootCause 或 failureMode；自主观察者的 `propose()`（`orchestrator.js:8592-8600`）不传 rootCause，自主闭环中不可达。显式矛盾输入按不可游戏化设计保守阻断；版本变更即放行（`sameApplicability`）。两组子代理对此分歧，按「不把合理设计边界误判为缺陷」处理。 | `shared-experience.js:178-195,588-605`；`orchestrator.js:6023-6044,8592-8600` |
| 候选 `measure()` 抛资源类错误（如 EACCES）被判环境失败并无限期推迟 | **NO-CHANGE（剩余风险）**。真实可达且会造成停滞，但修复需按错误来源重写观察者分类（候选回调 vs 观察者自身资源门），属机制调整；默认入口关闭自主事件观察者，仅在显式启用时相关。 | `orchestrator.js:8703-8761`；`index.js:83-86` |
| doctor 的 `promotion-journal-recover` 在 writer 的 `fresh-unowned` 锁窗口仍执行回滚 | **NO-CHANGE（窄窗口残余风险）**。需要进程崩溃在 `mkdir` 与 `lock.json` 落盘之间且 journal 已存在；修复需统一 doctor 与 runtime 的锁分类器，超出本次两处根因修复范围。 | `diagnostics.js:3185-3192`；`orchestrator.js:4817-4850` |
| `promotion.sharing` 不把 `index.invalid` 与孤儿 ACTIVE 消费行计入诊断 | **NO-CHANGE（诊断 nit）**。统一审查已报 blocked 与对应 operator action；doctor 报 ok 属诊断不一致，不影响晋升/发布事实。 | `diagnostics.js:2942,3001-3025`；`self-evolution-review.js:829-855` |
| 前七轮已修复项、schema 2 迁移、event-bridge 互斥、usage 离线投影、撤销不回写、默认关闭观察者 | **NO-CHANGE**。本轮六个方向独立复核均确认保持有效，未重复报告。 | 各子代理报告；`AGENTS.md` 不变量 |

## 4. 验证

- 反证：canary 指标测试在旧源码 4/7 失败；floor 分类测试在旧源码 1/3 失败；恢复修复版本后全绿。
- 聚焦：结论来源、生命周期、feedback 保真、recall、plan、review、round4 结论、canary 义务等 **148/148** 通过；新增 7+3 项全绿。
- 全量：`NODE_OPTIONS=--max-old-space-size=4096 npm test` 最终树 **2213 项，2211 通过 / 0 失败 / 2 跳过**（基线 2203）。
- 打包：`npm run pack:check` **17/17** 通过；工作树是 v0.2.19 固定点的已提交后继，固定点、产物与既有证据未改动；未执行 `--release` 或任何发布动作。
- 独立复审：sol-loop（codex / gpt-6.2-sol / reasoningEffort high）结论见 PR 描述；最终收敛后创建 PR 并保持未合并、未开启自动合并。

## 5. 剩余风险

- 共享经验结论仍是有界摘要：probe 与 task 两套完整数字需回实验归档/observation 查，这是设计边界。
- 上述 §3 的 NO-CHANGE 项保持登记；本轮不为边缘场景扩大机制改动。
- 未在本轮新增隔离真实宿主验收：两处修复分别位于共享结论的有界指标投影与回收 floor 的纯分类逻辑，标准宿主验收夹具不构造 canary 回归/逐字节重复日志形状；直接证据来自复现脚本、反证与差分单元测试。
