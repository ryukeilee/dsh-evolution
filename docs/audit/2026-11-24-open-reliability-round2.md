# 开放式全链路可靠性研究（第二轮，2026-11-24）

基线：当前分支 `t3/evolution-reliability-research-1` = `origin/main` = `6774ac2`（v0.2.18，正式基线）。
本文只记录本轮实际读取、复现、修改与执行的检查，不引用未重跑的历史验收数字。

## 1. 范围与方法

以 8 个并行只读子代理覆盖完整闭环的独立方向：经验采集/归因、发现/规划/候选、Trial 生命周期与并发、
测量/晋升门禁/结论、发布/撤销/重验证、Desktop–ACP–Web 跨入口、持久化/锁/长期增长、doctor/review 契约。
每个方向要求当前源码的 file:line、真实调用链、可运行复现与严重度分类，并显式排除上一轮已修复的问题
（`docs/audit/2026-11-24-evolution-loop-reliability.md` 的 11 项）与本地 `main` 独有提交（22b58bc/d75e526）
中已实现的 5 项修复。主代理对每条进入修复的发现独立复核，并以「先让新用例在旧源码上失败，再让其在修复
后通过」的方式取证；临时复现均在系统临时目录与 fake host / 临时 SQLite 中完成，未触碰正式 DSH_HOME、
正式经验库、stable 插件或授权记录。

本轮确认并修复 10 项真实缺陷；其余候选按「低收益微优化、纯理论边缘、可信输入下的设计边界」登记不修改。

## 2. 已修复的系统级缺陷

| # | 根因 | 影响 | 修复 |
| --- | --- | --- | --- |
| 1 | `diagnoseComposition()` 无条件要求 `evolution-orchestrator` 启用；`setup-experience` 按设计在 acp/web 禁用它，而 `doctor` 不传 `--profile` 时取字母序第一个（acp） | 标准三 profile 安装被 doctor 误报 `blocked`、退出码 2 | 按 composed tree 的实际角色判定：kernel 被禁用且 promoted-consumer 启用时按 consumer 角色校验 consumer + guard，不再要求 kernel；角色写入 evidence 与摘要 |
| 2 | `diagnosePatch()` 只检查 7 个 loader 条目中的 orchestrator 与 guard | patch 丢掉 experience 提供者（或任一 consumer/task 行）时 doctor 仍报 `plugin.patch: ok`，而运行时会因缺少必需服务失败 | 新增 `REQUIRED_LOADER_ENTRIES`，逐条校验 id/name，摘要改为真实条目数 |
| 3 | `diagnoseSharing()` 只把 `failed`/`skipped-invalid` 当作失败 consumer | `skipped-incompatible` / `pending-revalidation` / `pending-restart` 的已批准记录被 doctor 判 ok，与统一 review 的 incompatible/pending-revalidation/restart-required 分类分叉 | 新增 `inactiveConsumers` 并计入 degraded、evidence 与摘要 |
| 4 | `packageVersionFromHostRoot()` 只按路径读取 manifest.version，不校验 `manifest.name` | 路径正确但包名错误的依赖可把伪版本号当成官方 dsh/cordis/include 身份，传导到适用性三元组、consumer 兼容判定与 doctor | `readPackageVersionFile(file, expectedName)` 在提供期望名时校验包名；三处官方包查找传入期望名，不匹配返回 null（unknown） |
| 5 | `allCallerInput` 只看被分类的 mode，忽略 `unclassifiedOccurrences` | 标准 `recordFailure` 产生的无 mode 通用失败，只要同 scope 有 1 条 caller-input 就被整组拒绝，高价值重复损失从候选中消失 | 只有无未分类失败时才拒绝；混合组产出 `unattributed` 候选，caller-input 进入 `excludedModes`/`mixedOrigin`，`occurrences` 不计 caller-input |
| 6 | `profileVerdict()` 对旧宿主 consumer 的 `failed` / `skipped-incompatible` 落到 `stale-*` → `restart-required` | 按评审动作反复重启仍无法挂载，稳定插件持续失效且给出无效动作 | 与 `pending-revalidation` 同规则：两个已知 DSH 身份不兼容时返回 `pending-revalidation`，走 revalidate 而非重启循环 |
| 7 | `mergeMeasurement()` 的 `preferArray` 用对象字段做去重键；纯字符串的 `sideEffects`/`orphanResources` 四字段全 undefined | 每次晋升稳定提交后归档、sidecar 与失败记忆里只保留第一条副作用/孤儿资源，证据与后续学习输入静默降级 | 对象按原字段键、基本类型按自身值键去重 |
| 8 | `mergeMeasurement()` 的 metrics 用 `preferObject`，candidate(durable) 在共享键上覆盖 current | 旧的持久指标反向覆盖当次实测值，与「durable 是地板」的契约相反 | 新增 `preferMetricObject`：durable 只补缺失键，current 的已知值优先 |
| 9 | `propose()` 无条件 `experiments.set()`，每条记录持有完整 `inspect()` 基线且 `proposed` 不在任何回收集合 | 反复调用 `evolution_propose` 可无界增长进程内存与事件桥日志 | 新增 `pruneProposedExperiments()`，超过 `AUTONOMOUS_PATTERN_CAP` 回收最旧的无主 explicit proposal；带 claim/operation/自主标记的记录不回收，避免占位 wedged |
| 10 | `cleanupAutonomousTrial()` 对 `reverted` 在 claim 释放重试之前直接返回 `recovered` | `revert` 后置簿记因跨进程锁竞争失败时，恢复证据误报「已回收」，残留 claim 在本进程剩余生命周期内不再重试 | `reverted` 分支先尝试 `releaseTargets`，成功才报 recovered，失败报 `not-recovered` 保留现场 |

配套反馈闭环修复：`PROMOTION_LIFECYCLE_TOOLS` 曾包含 `evolution_desktop`。它的 audit/status/confirm 只读、
delegate 只转发，候选在 Desktop 会话内由真实 `evolution_*` 生命周期调用标记；由于工具事件不含 action 参数，
与其重叠的已发布工具调用被误算成 verification，可解锁错误退役建议。现移除该条目并同步更新生产者注释。

## 3. 验证

- 基线：`NODE_OPTIONS=--max-old-space-size=4096 npm test` → 2116 通过 / 0 失败 / 2 skipped（Node v26.13.1）。
- 反证：临时 `git stash` 仅源码改动后，新增的 11 个回归用例在旧源码上 **11/11 失败**；
  恢复源码后同一批用例 **235/235 通过**（12 个相关测试文件）。
- 新增用例覆盖：多 profile 角色、缺失 loader 条目、consumer 非活动状态、伪包名、无 mode 通用失败、
  旧宿主 failure 的动作、字符串/指标合并、explicit proposal 上限、reverted+残留 claim、usage 归因。
- 未使用临时 Node 发行版；全量测试始终带 4096 MB 堆上限。

## 4. 调查后决定不修改的项

- `revalidate` 多证据逐条采纳非原子、重复采纳非幂等、host 输入校验过松：仅手拼/复用证据可达，
  支持的 `run-revalidation.mjs` 先校验全部 target 并使用真实 consumer host facts，不触发；
  CLI 缺乏可信的「当前宿主」来源，属于已登记设计边界。
- `findConclusions()` 的 `truncated` 未穿透 `priorIneffectiveConclusion` 门禁、缺 `errorPatternDigest`
  时用原始消息签名、发现门槛 `unknown` 适用性过滤、事件桥 `seen` 无界 Set、
  `writeUsageProjection` 同进程同毫秒临时名碰撞、客户端 state 文件名一致性校验：
  均为极端条件或当前生产入口不可达，按约束不增加复杂度。
- journal 分类三处一致、claim 回收、retention floor 顺序、append lock、扫描 memo、schema v1→v2 迁移、
  `__proto__` 投影、脱敏线性扫描、PTC 传输、functionalCheck 重放、8 项晋升门禁与 confirmation：
  复核未发现新问题，沿用现有回归，不重复改动。

## 5. 边界

本轮未发布版本、未安装正式环境、未执行 `revalidate --apply`、未读写正式 DSH_HOME。新增修复只改变
诊断正确性、证据保真度、归因与资源上限，不放宽任何授权或晋升门禁；不改变持久化格式或官方宿主机制。

## 6. 独立反方复审（sol-loop 第 1 轮）

GPT-6.2 Sol（High）对完整 diff 返回 `CHANGES`：3 blocker、4 should、1 nit。逐条复核后的处理：

| id | 结论 | 处理 |
| --- | --- | --- |
| S1 blocker | 接受：角色不能只看 composed flags；desktop/自定义 profile 禁用 kernel 时不会有 consumer 生效；kernel 角色还需要 experience 提供者 | 角色限定为 `SHARED_CONSUMER_PROFILES`（acp/web）；所有角色要求 `evolution-experience` 条目存在且启用 |
| S2 blocker | 接受：doctor 的 CLI 模块探测只读 version 不校验 manifest 名，与运行时 fail-closed 规则分叉 | `hostModules` 在 `found.name !== module.name` 时判为未解析、version=null、error=`PACKAGE_NAME_MISMATCH` |
| S3 blocker | 接受：`merged[key] = value` 会让自有 `__proto__` 指标键交给原型 setter，违反不变量 12 | 改用 `Object.defineProperty` 定义自有数据属性，并新增回归用例 |
| S4 should | 接受：无 mode 通用失败的时间、跨来源去重与评分证据此前与 caller-input 混在一起 | 新增 `trackUnclassified()` 独立汇总 knowledge 求和 / memory 取最大值、时间、窗口与评分证据；候选只消费通用证据 |
| S5 should | 接受：reverted+残留 claim 的冷却记录被立即删除，且建议的 `evolution_revert` 对该状态不可用 | 残留 claim 存在时保留冷却，并返回「稍后观测重试 claim 释放」的可执行提示 |
| S6 should | 接受：自主提案在 marker 写入前触发显式配额回收，会淘汰一条显式提案 | `propose()` 增加内部来源选项，自主提案不占用/不触发显式配额 |
| S7 should | 接受：撤销 profile 后历史 failed 行仍让 doctor degraded，与 review 的 disabled 分类分叉 | 统计前复用 `isDisabledForProfile()` 跳过已撤销 profile 的历史行 |
| S8 nit | 接受：Cordis/Include/Node 不兼容被统一写成 `host-version-mismatch` | 保留 `hostCompatible()` 的具体 reason，避免「DSH X 取代 DSH X」误导 |

本轮复审扩展至第 2 轮（blocker/should 涉及身份、数据丢失与状态并发）。所有复审发现均已修复并补针对性用例。

## 7. 独立反方复审（sol-loop 第 2 轮）

GPT-6.2 Sol（High）返回 `CHANGES`：1 blocker、7 should（S6 关闭）。逐条复核：

| id | 结论 | 处理 |
| --- | --- | --- |
| S1 blocker | 接受：非 consumer profile 停用 kernel 时此前无人报错；experience 条目只验存在未验模块名 | kernel 角色要求 orchestrator 启用；所有角色校验 experience 条目的 name |
| S2 blocker | 接受：宿主实际解析到异名包时，布局回退仍会采纳同级官方包版本，造成 doctor 与运行时两套身份 | `packageVersionFromHostRoot` 先走宿主 Node 解析并校验 name；解析失败才回退布局 |
| S3 should | 接受：`isMissing` 会丢掉自有空值键，包括 `__proto__` | 只跳过 `undefined`，current 的其它自有键全部以自有数据属性保留 |
| S4 should | 接受：通用失败与 caller-input 混合时 `rootCauses` 仍取全组，可能产生 classified 工作流候选 | 该分支只用通用证据，`rootCauses` 为空 |
| S5 should | 接受：revert 重试证明恢复但 claim 释放再次失败时仍报 recovered 并清冷却 | revert 后复查 claim；仍持有则 not-recovered 并保留冷却，提示按真实状态给出 |
| S7 should | 接受：撤销后没有可获准记录时，索引落后仍让 doctor degraded | 仅在该 profile 仍有可获准记录或活动挂载时计入 pendingRestart |
| S8 should | 接受：Cordis/Include/Node 不匹配仍生成“DSH X 取代 DSH X”的动作说明 | 用完整 host facts 描述 consumer 与已验证宿主，避免只写 DSH 版本 |
| S9 should | 接受：兼容 patch 差异导致 hostDigest 不同，真实 apply 失败被误报 stale-failure → restart | 复用 `hostCompatible` 判据：宿主族兼容时按 apply-failed/incompatible 处理，走 repair 而非重启 |

第 3 轮复审确认以上修复后收束；所有行为变更均有针对性回归用例，未放宽任何门禁。

## 8. 独立反方复审（sol-loop 第 3 轮）

GPT-6.2 Sol（High）返回 `CHANGES`：1 blocker、4 should。逐条复核并修复：

| id | 结论 | 处理 |
| --- | --- | --- |
| S1 should | 接受：composed profile 解析器把嵌套 `config.disabled` 当成条目自身停用 | `name`/`disabled` 只取与条目同缩进的直属键 |
| S2 blocker | 接受：包通过 `exports` 隐藏 `package.json` 时，运行时回退到同级官方包，与 doctor 的拒绝结论分叉 | 解析主入口后向上定位实际所属 manifest 并校验 name；只有无法定位依赖才回退布局 |
| S5 should | 接受：冷却期内的观测返回 cooling-down 后，Trial 检查又绕过同一冷却重试 claim 释放 | Trial 的终端 claim 释放复用 `cleanupRecoveryAttempts` 冷却门禁，显式路径不受影响 |
| S7 should | 接受：撤销只改 disabled.json，索引时间戳不变，已挂载记录未被标为待重启 | 单独检测「已撤销但仍 active」的挂载并计入 pendingRestart |
| S8 should | 接受：Cordis 不兼容的前置条件/证据说明仍只写 DSH 版本 | 前置条件与证据说明改用完整 host facts |

补充回归：嵌套 disabled 不停用条目、已撤销但仍挂载触发重启。

## 9. 独立反方复审（sol-loop 第 4 轮）

GPT-6.2 Sol（High）返回 `CHANGES`：1 blocker、4 should。逐条复核并修复：

| id | 结论 | 处理 |
| --- | --- | --- |
| S1 should | 接受：guard 条目只验存在与启用，未验模块名 | 与 experience/consumer 一致校验 guard 的 name |
| S2 blocker | 接受：包仅暴露 ESM 主入口时，布局回退可能采纳同级官方包，与 doctor 分叉 | 布局查找按「实际依赖位置优先」重排：命中的依赖 manifest 名不符即返回 unknown，不回退到其它位置 |
| S5 should | 接受：`trial-failed` 终态释放 claim 竞争后同样需要冷却 | 所有仍持 claim 的自主终态都保留冷却，提示改为可执行的「后续观测重试」 |
| S7 should | 接受：已撤销但仍 active 的记录，doctor 报待重启而 review 报 inactive | readPublishedPluginReview 检测 active-after-revocation 并给出 restart-consumer；无活动挂载仍为 inactive/no-action |
| S8 should | 接受：runner 只认 `host-version-mismatch`，Cordis/Include/Node 不匹配时无法生成证据 | runner 按 `pending-revalidation` 状态选取目标，保留源码摘要、激活证明与采纳门禁 |

新增回归：guard 模块名、撤销后仍挂载的 review 动作；现有一致性用例随语义更新。

## 10. 独立反方复审（sol-loop 第 5 轮，预算上限）

GPT-6.2 Sol（High）返回 `CHANGES`：2 should。复核后均接受并修复：

| id | 结论 | 处理 |
| --- | --- | --- |
| S1 should | 接受：只撤销单个 profile 时，该 consumer 仍 active，review 报 active 且无动作 | 逐 profile 检查撤销后的 active 行，产出 restart-consumer；已撤销且已卸载仍为 inactive |
| S2 should | 接受：全部获批 profile 均已撤销的记录仍因宿主不匹配中止 runner，阻塞同批真正待重验证的记录 | runner 依撤销表跳过全撤销记录并在证据中列出 skippedRevokedIds；其余源码摘要、真实挂载证明与采纳门禁不变 |

sol-loop 预算（5 轮）已用尽。第 5 轮的两项均已在预算内修复并有针对性用例；不再发起第 6 轮。
本轮没有未解决的高置信度 blocker/should；剩余候选为低收益边缘情况，按任务约束不继续扩大范围。
