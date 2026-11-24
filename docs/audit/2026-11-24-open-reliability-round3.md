# 开放式全链路可靠性研究（第三轮，2026-11-24）

基线：`387891b`（PR #91 merge = `origin/main`）。本文只记录本轮实际读取、复现、修改与执行的检查。

## 1. 范围与方法

以 8 个并行只读子代理覆盖完整闭环的独立方向：经验采集/共享/检索、发现/规划/候选、Trial/证据/收益、
晋升/发布/重验证、跨入口加载与实际复用、效果反馈/持久学习、长期状态/恢复、跨阶段契约/真实宿主。
每个方向要求当前源码的 file:line、真实调用链、可运行复现与严重度，并显式排除上一轮已修复的问题
（`docs/audit/2026-11-24-evolution-loop-reliability.md` 的 11 项与 `2026-11-24-open-reliability-round2.md`
的 10 项 + 5 轮 sol-loop）。主代理对每条进入修复的发现独立复核，并以「先让新用例在旧源码上失败、
再让其在修复后通过」取证；临时复现均在系统临时目录与临时 SQLite 中完成，未触碰正式 DSH_HOME、
正式经验库、stable 插件或授权记录。

本轮确认并修复 8 类真实缺陷；其余候选按「修复需跨入口协议改造、改变共享知识合并语义、只影响
呈现层或属于已登记设计边界」登记不修改。

## 2. 已修复的系统级缺陷

| # | 根因 | 影响 | 修复 |
| --- | --- | --- | --- |
| 1 | `classifyExperimentDecision()` 不看 `taskBenefit.mechanismRan`：`regressionPassed:false` 被当成真实回归；纯任务配对又因缺 probe comparison 永远得不到 `no-benefit` | 模型未选候选工具时的成本波动写入持久 `regression`，错误封杀有效策略；有效但无收益的真实会话无法形成无效结论，同一假设反复消耗真实模型会话 | 机制未运行时回归判为证据不足；机制运行且完整无改善时产出 `no-benefit` 结论；机制运行且确有成本回归仍判 `regression` |
| 2 | Desktop 任务宿主把 `{phase:'promotion-failed', runtimeRecovered:true}` 压成普通错误；`revert` 拒绝该终态，`pendingCleanup` 永久保留 | 一次包检查失败即可卡死整个 Desktop 任务队列，后续任务全部跳过 | 保留结构化回执，把已证明恢复的结论转入终止路径；不再重试 revert、不再挂起队列 |
| 3 | `recordEvolution()` 把进入 canary 的 `promotion-succeeded` 与闭环自身的 `failure-learned` 写成成功/失败事实 | canary 尚未通过时 `evolution_plan` 已把目标判为 `already-resolved`；三次实验失败可从零造出候选并自我续命。复审还发现中性事实合并进旧成功行会刷新 `lastSeen`，且改变旧事件摘要会在升级重放时触发 `E_EXPERIENCE_EVENT_CONFLICT` | 只有终态 `canary-passed` / `canary-failed` / `promotion-reverted` 进入共享经验；两个生命周期事件仍留在事件桥，不写知识行，因此不改变旧事件摘要 |
| 4 | `kindOf()` 在检查回归之前过滤 success/failure 计数均为零的行 | 只有回归结论的行被 `evolution_history` / 召回静默丢弃，丢失唯一能阻止下一次实验的证据 | 先识别回归，再按计数分类 |
| 5 | `addRow()` 只看 `successCount>0` 判 resolution；canary-passed 与 canary-failed 合并进同一行 | 刚在 canary 回滚的目标被判 `already-resolved`，发现阶段静默放弃，直到下一次原始失败才恢复 | 以最新结果为准：`REGRESSED` / `lastOutcome:regression` 的行计入 `latestFailure`，不再算 resolution |
| 6 | `hostCompatible()` 把发布进程的 Node 大版本当等价字段 | Desktop（Electron Node 24）发布、ACP/Web（CLI Node 22/26）消费时同一条 stable 记录永远不兼容：consumer 不挂载、review 永久 `revalidate`、doctor 永久 degraded | Node 从等价判据移除，仍保留在 `host`/`hostDigest` 与重验证证据中；DSH/Cordis/Include 继续按原规则比对 |
| 7 | `observeAutonomous()` 调 `propose()` 不传 strategy，durable 无效结论门禁结构性不可达；`publishConclusion()` 回退到 composition 名，指纹与门禁不一致 | 已证伪的声明策略在失败记忆被淘汰或重启后可再次自动 Trial；规划器把失败显示为中性 prior attempt | 传稳定声明文本，使发布、门禁读同一指纹；门禁拒绝时释放决策占位并返回门禁自身理由，不写虚假策略失败 |

## 3. 验证

- 对每条修复先写/跑复现：8 条复现均在修复前得到错误结果（见各新增/更新的回归用例），修复后同一路径通过。
- 新增/更新回归：`test/benefit-provenance.test.mjs`、`test/desktop-task-host.test.mjs`、
  `test/shared-experience.test.mjs`、`test/promoted-sharing.test.mjs`、`test/autonomous-continuity.test.mjs`，
  新增 `test/review-fix-rollback-resolution.test.mjs`。
- 聚焦检查：shared-experience 19/19、promoted-sharing 相关 64/64、desktop-task-host 40/40、
  autonomous 方向 78/78 及相关回归全部通过。
- 全量：`NODE_OPTIONS=--max-old-space-size=4096 npm test`（结果见最终报告；未提交工作树上
  `test/release-pin.test.mjs` 按既定语义会因未提交改动失败，提交后重跑）。
- 未使用临时 Node 发行版；全量测试始终带 4096 MB 堆上限。

### 独立反方复审（sol-loop 第 1 轮）

GPT-6.2 Sol（High）对完整 diff 返回 `CHANGES`：4 blocker、1 should。逐条复核并修复：

| id | 结论 | 处理 |
| --- | --- | --- |
| S1 blocker | 接受：观察者用 `name:idPrefix` 作结论策略文本，仅改 Host 源码时旧 `no-benefit` 仍拒绝新声明 | 结论策略文本从完整声明指纹派生（含 Host 源码），源码变化即新身份 |
| S2 blocker | 接受：状态映射改变已持久化事件的摘要，升级重放旧 `promotion-succeeded` 触发 `E_EXPERIENCE_EVENT_CONFLICT` | 生命周期事件不再写共享经验，旧事件重放直接忽略，不产生新摘要 |
| S3 blocker | 接受：中性生命周期事实合并进旧成功行并刷新 `lastSeen`，可再次把候选误判为已解决 | 同上：生命周期事实与目标结果彻底分离 |
| S4 blocker | 接受：回滚时间只进入 plain 分支，mixed 证据分支仍可能报 `already-resolved` | 回滚 epoch 进入全部三条 `latestFailure` 分支 |
| S5 should | 接受：同时提交 workload 与 task 时 `evidenceKind` 变成 `comparative-workload`，分类器丢弃已验证任务证据 | 以 `taskBenefit` 构件本身而非 `evidenceKind` 标签判断任务结论，probe 自身回归仍独立保留 |

### 独立反方复审（sol-loop 第 2 轮）

GPT-6.2 Sol（High）返回 `CHANGES`：2 blocker、1 should。逐条复核并修复：

| id | 结论 | 处理 |
| --- | --- | --- |
| S1 blocker | 接受：拼入的插件名可能被凭据脱敏折叠（`token` → `[redacted]`），两份不同源码的声明得到同一策略文本 | 策略身份只用完整声明指纹加固定前缀，不含可脱敏字段 |
| S5 blocker | 接受：组合测量里 probe 证据不足/传输失败会先返回 `insufficient-evidence`，吞掉独立验证过的任务无收益结论 | 任务无收益判定移到 probe 证据分支之前；probe 自身的实测回归仍保持最高优先级 |
| S6 should | 部分接受：旧库里 `failure-learned` 行仍参与规划，可从零造出候选 | 规划器忽略归一化后的 `experiment-failure` 行；旧 `promotion-succeeded` 成功行与 `canary-passed` 在知识行上不可区分，按既有「不迁移历史记录」边界登记残留风险 |

### 独立反方复审（sol-loop 第 3 轮）

GPT-6.2 Sol（High）返回 `CHANGES`：1 blocker、1 should。逐条复核并修复：

| id | 结论 | 处理 |
| --- | --- | --- |
| S5 blocker | 接受：合并的 `regressionPassed` 不是回归证据本身；对照两侧都失败时误判回归，probe 传输失败时又吞掉任务回归 | 分别读取有效 probe 的 `regression` 与已运行机制的 `taskBenefit.regression`；`regressionPassed` 只在无任务构件的路径保留既有语义 |
| S6 should | 接受：旧写入链路把 `experiment-failed` 归一化为 `experiment-failure`，过滤条件漏掉实际存量 | 匹配归一化后的前缀，并用带 `failureCount` 的旧形状投影生成回归样本 |

### 独立反方复审（sol-loop 第 4 轮）

GPT-6.2 Sol（High）返回 `CHANGES`：1 blocker、1 should。逐条复核并修复：

| id | 结论 | 处理 |
| --- | --- | --- |
| S5 blocker | 接受：真实 probe 传输失败会同时设置 `transportFailed` 与 `measurementInvalid`，后者仍吞掉已验证的任务回归 | `measurementInvalid` 只约束 probe 派生的回归；已运行机制的任务回归独立保留 |
| S6 should | 接受：历史行 fixture 缺 `failureCount`，去掉过滤条件仍通过，无法证明过滤有效 | 用旧投影的真实字段（`failureCount: 3`）构造样本，并验证对照组会产生候选 |

### 独立反方复审（sol-loop 第 5 轮，预算上限）

GPT-6.2 Sol（High）返回 `APPROVE`，仅两项 nit，均已接受：任务回归的理由优先于 probe 传输错误；
历史行回归用例补上对照组断言。复审预算（5 轮）已用尽，本轮收束。剩余风险见第 4 节。

## 4. 调查后决定不修改的项

- **启动 canary 与任务 functionalCheck**：重启后 `verifyStartupCanary()` 只重放 Include 健康检查；
  被打断的 context-policy 任务若已在 canary 留一条带 functionalCheck 的观测，启动健康观测可补齐窗口并
  提交 stable。根因修复需把功能验证义务写进 journal 并让任务宿主在恢复时重放，涉及跨入口协议改造。
  仅阻止启动观测会留下永久 canary-observing 占位，故本轮登记不修改。
- **每实验 canary 窗口覆盖**：Desktop 计划接受 `observations:1..5`，但内核窗口取配置值（默认 2），
  任务请求的轮数实际只控制循环上限而非提交门槛；改成每实验覆盖需扩内核晋升 API 与 journal 格式。
- **PTC 重验证回退**：跨入口探针在官方传输拒绝时直调 registry definition，重验证只检查输出期望。
  位于验收 harness，不在生产插件路径。
- **结论粒度与合并语义**：结论只按工具级 scope 关闭同类退化；中性结论可覆盖同一身份的实测否定结论。
  修复要改共享知识的 canonical merge 语义，影响面超出本轮最小改动。
- **采集归因边缘**：异常/取消路径跳过 turn-stopping 导致退化误判已恢复；callId 在三个执行对象上重用触发
  事件冲突。依赖官方宿主异常路径的进一步取证，未在本轮确认可复现的生产影响。
- **观察者随包入口默认关闭**：`lib/index.js` 写死 `dailyAutonomousObservation=false`，README 仍把相关
  配置写成可经 profile patch 开启。方向偏安全（不自主上生产），属于文档与配置一致性问题，不改变行为。
- 上一轮已登记的 journal 分类、claim 回收、retention floor、append lock、schema v1→v2 迁移、
  `__proto__` 投影、脱敏线性扫描、functionalCheck 重放、8 项晋升门禁与 confirmation：本轮复核未发现新问题。

## 5. 边界

本轮未发布版本、未安装正式环境、未执行 `revalidate --apply`、未读写正式 DSH_HOME。所有修改只改变
诊断正确性、证据保真度、闭环反馈与兼容性判据，不放宽任何授权或晋升门禁；不改变持久化格式或官方宿主机制。
