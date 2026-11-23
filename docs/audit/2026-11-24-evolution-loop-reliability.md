# 2026-11-24 自我进化闭环可靠性集中审计

## 1. 范围与方法

本轮从仓库当前真实状态（`main` 的 `176b655` / 0.2.17 固定点）出发，用 8 个并行只读子代理覆盖完整闭环：

| 方向 | 主要代码 |
| --- | --- |
| 经验采集 / 去重 / 归因 / 持久化 | `experience-collector.js`, `shared-experience.js`, `experience-recall.js`, `capability-usage.js`, `verification-call.js` |
| 发现 / 规划 / 候选选择 / 统一检查 | `experience-plan.js`, `self-evolution-review.js`, `orchestrator.plan/reviewSelfEvolution` |
| Trial / 隔离 / 失败恢复 / 自主观察者 | `orchestrator.js` 生命周期、target claim、journal、canary |
| 测量 / 回归 / 晋升门禁 / 结论反馈 | `orchestrator.measure/promote/publishConclusion`, `evaluator.js` |
| 跨入口发布 / 消费 / 撤销 / 重验证 | `promoted-sharing.js`, `promoted-consumer.js`, `shared-plugins.mjs` |
| ACP → Desktop 任务通道 / PTC 传输 | `desktop-task-*.js`, `ptc-transport.js` |
| 长期状态 / 崩溃恢复 / 资源增长 | `domain-storage.js`, `memory.js`, `archive-stage.js`, `event-log-checkpoint.js`, 迁移 |
| 交叉不变量 | 脱敏边界、自有 `__proto__` 身份、journal 边界、guard 授权源、宿主身份 |

子代理只做只读分析；每个报告要求给出 file:line、真实调用链、可运行复现与严重度。父代理对进入修复的每个问题独立复核（重跑复现或先写失败用例），并统一归并实现，避免把相关故障模式在各个位置分别打补丁。已确认并由 PR #82 / #79–#85 / #86 解决的问题不作为本轮发现重复报告。

## 2. 已修复的系统性根因

| # | 根因 | 影响 | 修复 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | `promote()` 的包检查失败分支无条件写入终态 `promotion-failed`，但清理未证明恢复时保留 target claim；`promotion-failed` 不在 `REVERTABLE_STATES` | 一次检查 + disposer 双故障后，会话内所有 Trial 被 `E_EVOLUTION_RUNTIME_BUSY` 拒绝，而建议的 revert/promote 都不可用 | 恢复未证明时落到可重试的 `revert-failed`，保留 `promotion-inspection` 阶段与诚实的 `runtimeRecovered` | 独立复现显示修复前状态 `promotion-failed`、claim 仍在、revert 抛错、第二次 Trial 被拒；新增 `revert-unproven-cleanup-retry` 用例覆盖双故障 → 重试 → 释放 → 后续 Trial |
| 2 | advisory evaluator 的 `rollback` 被写成 `decision.kind = "regression"`；所有者随后 `revert()` 时 `conclusionKindFor()` 把它发布为持久 `regression` | 一个"非权威、可修正"的 advisory 否决变成跨会话不可撤销的策略封杀，违反不变量 4 与函数自身注释 | 决策 kind 改为 `insufficient-evidence` 并标记 `advisoryRegression: true`；保留门禁权威与 veto 可见性 | 新增 lifecycle 用例：promote 被 veto → revert → 共享经验中无 `regression` 结论 → 同一假设仍可提案 |
| 3 | `mergeMeasurement()` 逐键构造时漏掉 `probeDerived` | canary / 重启 / 归档合并抹掉"权威比较器已执行"标记；预算内耗时增长被读成回归，advisor 否决、晋升门禁失效 | 合并时单调保留该标记，旧测量仍保持原键集 | 新增 `benefit-provenance` 用例：先证明合并前通过，断言合并后仍 eligible 且 advisor 不 rollback；修复前该用例在 `probeDerived === undefined` 处失败 |
| 4 | `classifyExperimentDecision()` 只读 `experiment.probe`，重启后该字段不重建 | 无效配对（transport failure / unmeasured）的 `regressionPassed:false` 被误判成策略 `regression`，污染共享经验并阻止再提案 | 优先用内存 probe，回退到 `latestObservation.probe` 的持久比较 | 新增 lifecycle 用例：仅保留 durable observation 时断言 `insufficient-evidence`；修复前得到 `regression` |
| 5 | `findConclusions()` 只按 scope 过滤窗口，而失败行与结论行共享 scope | 同 target  accumulating 500+ 条较新失败即可把已证明无效的结论挤出窗口，提案门禁把同一策略当成新策略放行 | SQL 窗口只让 `experiment-conclusion` 行消耗，count 用同一谓词 | 复现修复前 `matches:0 / truncated:true`，修复后 `matches:1 / no-benefit`；新增 600 条同 scope 失败回归用例 |
| 6 | `setDisabledForProfile()` 的撤销表读-改-写没有跨进程锁 | 两个并发撤销互相覆盖，操作者已撤销的插件在新会话恢复 eligible 并被挂载 | 复用发布索引/consumer state 同一把 SQLite 独占锁 | 并发 8 个撤销用例：修复前丢失条目（实测失败），修复后 8/8 保留 |
| 7 | Desktop 任务的 PTC `run_code` 回退把参数写成 JS 对象字面量 | 自有 `__proto__` 数据键被原型 setter 吞掉，候选与基线收到的实参不同，且污染内核工具入参；违反不变量 12 | 抽出共享 `ptcKernelCallProgram()`，参数以 JSON 文本传入并在程序内 `JSON.parse`（与 probe 侧已修复路径一致） | 新增 `ptc-transport` 用例断言自有键保留且原型未被污染；原 PTC 集成用例的 program 解析同步更新 |
| 8 | `revert()` 在清理已证明恢复之后仍把 `releaseAutonomousDecision()` 的 I/O 异常算作清理失败 | 存储抖动被 autonomous observer 读成策略失败，写入 session 抑制与持久失败记忆 | 该后置簿记用非抛出警告边界，不再覆盖 `reverted` 状态 | 新增用例：注入 `releaseAutonomousDecision` 抛错，断言 `ok:true` / `state:reverted` / claim 已释放 / 无 failure |

## 3. 经过核查后判定为正确 / 已知边界的区域

- journal 阶段分类（`classifyPromotionJournal` / `recoverInterruptedPromotion` / `readCanaryJournal` / doctor）三处调用方一致，差分矩阵完整。
- target claim 回收（同主机 + 整数 pid + `ESRCH`）与按 `experimentId` 采纳的顺序符合不变量 11。
- 自主清理重试、环境类推迟、session 抑制与失败记忆的签名语义符合不变量 3/6。
- 8 项晋升门禁、`requireRuntimeRecovery` 双条件、Host-only 晋升、confirmation 门禁均保持权威；advisory evaluator 仍只有 veto 权限。
- 无效配对、PTC 传输失败 / 取消 / 抛出、taskBenefit 首行成功判定的数据契约在现有测试中成立。
- schema v1→v2 迁移、retention floor 顺序、archive staging/install、事件桥尾字节与 append lock、扫描 memo 失效、诊断与运行时一致性均未发现可复现缺陷。
- `apply()` 的"先恢复后加载"、guard 的授权来源、`runtime-versions` 的身份证明、`__proto__` 三投影、`redactJsonParseMessage` 线性扫描均保持正确。

## 4. 未修复的实质风险（分类登记）

1. **设计边界（宿主限制）**：`revalidate` 作为独立 operator CLI 不校验证据宿主是否与当前数据根一致，旧证据可把记录的宿主版本改回旧值，制造假不兼容。受支持的证据生产者 `run-revalidation.mjs` 已做宿主事实交叉校验；本轮不为 CLI 另造一套宿主身份判定，建议始终使用该 runner。
2. **证据不足 / 呈现层缺口**：`discover()` 返回 `truncated`，但 `plan()` 与 `reviewSelfEvolution()` 只取 `records`，规划无法区分"无失败信号"与"信号在 500 行窗口之外"。修复需把截断事实穿透过纯规划器与其所有调用方，测试面大；本轮只登记，不静默当作已解决。
3. **兼容性约束**：适用性未知时，已 `adopted` 的结论被 planner 过滤，同一假设会以"全新候选"重新出现。`unknown` 不等于任何版本是刻意安全取舍；呈现层暴露"适用性未知但已采纳"需要改 `experience-plan.js`，而该文件同时被未合并的 PR #82 修改，本轮避免交叉改动。
4. **兼容性约束**：缺少 `errorPatternDigest` 时，持久失败签名用原始消息文本；消息仅数字不同会导致跨会话重复实验。改为稳定 patternKey 签名会让历史失败记忆条目失配，需要一次性迁移或双签名写入，超出本轮最小改动范围。
5. **潜伏风险（当前内核路径不可达）**：`dockyard-domain/memory.js` 与 `observation.js` 各有一份较弱的脱敏实现；直接调用这些端口并传入非敏感键名下的 Error / 原始字符串时，文本可原样落盘。内核路径已先经 `safeErrorDto` / `projectObservation()` 前置脱敏。直接委托给唯一边界会改变差分测试的固定字节，需单独一轮处理。
6. **刻意边界**：`api_key2` 一类数字后缀凭据键不在唯一脱敏规则表的覆盖范围内，设计文档已声明键拼写不在表中不覆盖。
7. **低概率权衡**：retention 的保留字节上限在极端窗口内可能形成启动重试；事件桥 `seen` 为进程内无界 Set。事件频率低、触发条件不可达，未引入新上限或裁剪协议。

## 5. 本轮实际执行的验证

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 基线全量单测（改动前） | `NODE_OPTIONS=--max-old-space-size=4096 npm test` | 2088 项：2086 通过 / 2 skipped / 0 失败 |
| 聚焦回归 | 对每个改动测试文件单独 `node --test`（共 12 个文件） | 全绿；其中 6 条新增用例在修复前实测失败（promotion 双故障、probeDerived 合并、重启决策、advisory veto 结论、同 scope 失败挤占、并发撤销） |
| 修复前最小复现 | 独立脚本（系统临时目录，fake runner / 临时 SQLite） | promotion 双故障后 `state:promotion-failed` + claim 保留 + revert 抛错 + 第二次 Trial 被拒；修复后同脚本路径可重试并释放 |
| 全量单测（提交后） | `NODE_OPTIONS=--max-old-space-size=4096 npm test` | 2096 项：**2094 通过 / 2 skipped / 0 失败**（Node v26.13.1，堆上限 4096 MB） |
| 打包检查 | `npm run pack:check` | 17/17 通过；本树是固定点 0.2.17 的已提交后继，固定产物与证据未改 |
| 本地打包 | `npm run release:pack` | 两次打包字节一致；content digest `54a332ef…`（仅开发验证，未发布、未改固定点） |
| 隔离真实宿主验收 | `npm run acceptance:host -- --host 0.2.2-rc.5 --no-hmr --experience-evolution --cross-entry --out <temp>` | **`ok: true`，39/39 步通过**：安装/升级/回滚、晋升与 canary 回滚、真实失败→plan→invalid/restart/regression、发布→消费→重启→篡改→撤销→重验证→ACP 消费→统一检查→最终 doctor（隔离 runtime/home，未触碰正式 `DSH_HOME`） |

以上只列本轮实际执行的检查。对未修复项（第 4 节）没有伪造验收数字；advisory veto、probeDerived 合并、并发撤销等属于正确性修复，收益体现为故障从"可复现"变为"回归用例钉住"，不宣称量化性能提升。
