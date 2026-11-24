# 完整自我进化主链最终收敛研究（2026-11-24）

## 1. 范围与方法

基线：`8995597`（PR #93 合并后的 `origin/main`）。本轮先按所有者授权审查并合并 PR #93（合并前 13/13 检查通过、无未解决评审线程、与 main 无落后），再从该基线开展收敛研究。

- 5 个独立只读子代理并行覆盖：measured 门禁重测契约缺口、PTC 重验证 harness 证据保真度、第四轮最后两项未经复审修复、四轮修复跨阶段交互、完整主链路健康度。
- 主代理对每条进入修复的发现独立复核（含真实模块复现），对每项 NO-CHANGE 结论核对源码 file:line 与既有证据。
- 独立反方复审用 sol-loop（codex / gpt-6.2-sol / reasoningEffort high，已校验实际生效），共 2 轮：第 1 轮发现 blocker，修复后第 2 轮 APPROVE。
- 全程使用临时目录，未触碰正式 DSH_HOME、正式经验库或已安装插件；未发布版本、未创建 tag、未执行 `revalidate --apply`。

## 2. 遗留项结论

| 遗留项 | 结论 | 依据 |
| --- | --- | --- |
| measured 门禁拒绝后重测路径 | **NO-CHANGE（行为层）**。恢复链完整：记录停在 `measured`，`revert` 可达并释放 claim，结论为 `insufficient-evidence` 不进封锁集合，archive/事件均在；无数据丢失、无卡死、无错误学习。仅注释/提示文案承诺了不存在的 re-measure API（nit）。不新增中间态或晋升路径。 | `lib/orchestrator.js:6505-6684, 6928-7046, 1294`；`lib/registration.js:99`；`test/experience-evolution-lifecycle.test.mjs:652-674` |
| PTC 重验证 harness 证据保真度 | **NO-CHANGE**。第四轮「证据声称经官方执行器」的前提被证据文件自身否定：`docs/evidence/revalidation-0.2.2-rc.5-20261119*.json` 如实记录 `path: registry-definition / batch-executor`；生产采纳链不消费 toolCalls，PTC 传输另有独立覆盖。仅两处注释措辞不严谨（nit）。 | `scripts/acceptance/probes/cross-entry-consumer-probe.mjs:308-359`；`scripts/acceptance/run-revalidation.mjs:508,567`；`test/ptc-transport.test.mjs` |
| 第四轮 S3（确定缺失回执判定） | **正确，无需修改**。两条观测提交分支共用 `isDefinitiveNoCanary()`；新增回归在旧源码失败、修复后通过；`-0` 绑定修复同样有效。 | `lib/desktop-task-host.js:321-323,382,409`；`test/desktop-task-host.test.mjs:1023,1058` |
| 第四轮 S11（晋升清理异常信号） | **发现实质缺陷并修复**，见第 3 节。 | 见下 |
| 主链路健康度与五项非阻塞遗留 | **NO-CHANGE**。采集→存储→检索→规划→提案→Trial→probe/measure→canary→晋升→发布→复用→反馈→恢复全链契约一致；`reclaim` 前缀解码、recall 2000 上限、清理尾段死代码、可选宿主接口分类、callId 归因五项均确认为低影响/非阻塞。105 项聚焦测试通过。 | 见完整主链映射：`lib/experience-collector.js`、`lib/shared-experience.js`、`lib/experience-recall.js`、`lib/orchestrator.js`、`lib/desktop-task-host.js`、`lib/index.js:94-95` |

## 3. 实际修复：pre-canary 清理拒绝无法穿越工具边界（blocker）

**根因**：第四轮 S11 在确认晋升的 `disposeTrial()` 抛普通异常时，给原异常附加 `promotionCleanupFailed` / `promotionPhase`，期望宿主走 `evolution_revert`。但 `lib/registration.js` 把每个工具抛错投影为 `redactedToolError`（只保留 code/name/分类/摘要），而官方宿主工具管线对普通 `Error` 的结构化字段同样不保真（sol-loop 第 1 轮用真实管线复现：只有 `HarnessError` 保留 code）。于是宿主在任务仍为 `promoting` 且带 `canaryVerification` 时，把错误判为可重放而跳过 revert，target claim 在本 session 持续占用，后续 Trial 全部 `E_EVOLUTION_RUNTIME_BUSY`。

**修复**（最小、单一路径）：只在注册的 `evolution_promote` 适配层把这一已知拒绝转成普通回执 `{ ok:false, phase:<内核记录的阶段>, reason:"promotion-cleanup-failed", runtimeRecovered:false }`。宿主既有的非 canary 分支会据此设置 `promotionRefused` 并走 revert/重试。内核直接调用者仍收到原异常；门禁、状态机、晋升路径、脱敏边界与持久化格式均未改动。

**证据**：
- 反证：父源码上适配层回归抛出 `redactedToolError`（宿主拿不到回执）；修复后返回拒绝回执。
- 宿主级回归使用带 functionalCheck 义务的 context-policy 计划，确认任务进入 `promoting` + `canaryVerification`，并断言 `evolution_revert` 被调用而非重放 canary。
- 聚焦 59/59 通过；全量 2179 通过 / 0 失败 / 2 跳过；`pack:check` 17/17 通过。

## 4. 主动拒绝的改动（均有理由）

- **functionalCheck 失败原因文案**：`lib/orchestrator.js:7599-7608` 会把功能检查不匹配持久化为 "metric regression"。verdict、回滚与学习判定均正确，仅原因文案偏差，不影响门禁或恢复链；修正需改动结论文本并可能影响既有断言，低收益，列为后续项。
- **sol-loop 第 2 轮 Y1（flush 与清理拒绝同时失败）**：双重故障边缘，修则需复杂化通用工具包装器；此时目标 claim 随进程退出释放，影响有界，不修。
- **sol-loop 第 2 轮 Y2（硬编码 phase）**：直接写死 `revert-failed` 会丢失内核记录的实际阶段，降低证据保真度；保留读取异常阶段字段。

## 5. 剩余风险与发布条件

- 剩余风险：上述文案偏差与两项 nit 为已知非阻塞项；第四轮之前的既有已知限制（见 `docs/audit/2026-11-24-open-reliability-round4.md` §4）保持有效。
- 本轮未验证项：未新增隔离真实宿主验收——修复位于「工具适配层把异常转为既有回执」这一窄失败路径，正常宿主流程不走该分支；其直接证据是针对性回归与全量测试，PR #93 的 39/39 宿主验收覆盖的是合并基线。
- 结论：完整进化主链路未发现未解决的实质性缺陷，正常运行、异常中断、重启恢复、证据判定、稳定晋升、跨入口复用与反馈学习形成一致闭环。**达到正式发布条件**；按本轮约束不发布版本、不打 tag、不修改本机正式 DSH 环境，PR 保持未合并且不启用自动合并。
