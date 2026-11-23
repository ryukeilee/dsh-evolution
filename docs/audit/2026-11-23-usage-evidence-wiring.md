# 用量证据接入自我进化审计（2026-11-23）

基线：`main` = `7d72f35`（`v0.2.16`）。本文只记录本轮实际读取、执行和测到的内容。

## 1. 根因

`lib/self-evolution-review.js` 早已接受 `usage` 投影，并能据此给出
`production-benefit` / `experiment-benefit` / `in-use` / `installed-only` / `usage-unknown` 五级判定与
带证据的停用候选。两个真实入口都没有传它：

- `lib/orchestrator.js` 的 `reviewSelfEvolution()`（Desktop `evolution_plan`）：
  `readPublishedPluginReview({ paths: this.paths, host })`；
- `lib/desktop-task-client.js` 的 `audit()`（ACP `evolution_desktop { action: "audit" }`）：
  `readPublishedPluginReview({ paths: reviewPaths(), host })`。

而唯一的证据生产者 `docs/audit/replay/capability-usage.mjs` 只把投影打到 stdout 或 `--out` 指定的
任意文件，运行时没有任何约定位置可读。结果：正式审计里每条记录永远是 `usage-unknown`，
停用候选与“是否进入日常工作流”的判断在生产路径上不可达。2026-11-18 的审计记录里那三个插件的
`in-use 1 / installed-only 2 / retirementCandidates 2` 只能由一次性脚本复现，不能由运行时复现。

本轮把这个缺口补成一条链路，并同时修掉计数规则里两处会直接改变结论的错误（见 §3）。

## 2. 为什么不做其他候选

调查过、但本轮**没有**实施的方向及理由：

| 候选 | 结论 |
| --- | --- |
| 审计时顺手扫描会话日志 | 违反“普通回合/启动不增加会话扫描”；单次 380k 调用约 0.31 s 与 66 MiB，不适合放进交互路径 |
| 在 consumer 启动时把注册的工具名写进 consumer 状态 | 需要改持久化契约且会让每次启动多一次写；旧 consumer 不写，仍无法覆盖 CLI profile |
| 自动推断 `capabilityAssessment` | “输入是否由调用方自足”不是能从源码可靠判定的性质；猜错会直接制造停用建议 |
| 从会话调用数推导 `productionBenefit` | 调用次数不是收益；本轮仍要求显式证据，只把调用事实用于“是否进入工作流”这一级 |
| 新增第二套价值评分或第二个经验库 | 值判定、晋升证据与经验规划都已存在；本轮只接线并修正归因 |

## 3. 计数规则的修正

`docs/audit/replay/capability-usage.mjs` 原规则：“同一会话里出现过任一晋升生命周期工具，
该会话所有发布工具调用都记为验证”。两个方向都错：

1. **混合会话被整段算成验证。** 一个真实任务里只要先调用过 `evolution_probe`，之后所有日常调用都从
   “使用”变成“验证”，把在用的插件压成 0 次工作流调用——正好会生成错误的停用建议。
2. **日志截断时整段消失。** 生命周期调用没有结果行时，原先的会话级布尔仍会把后续调用算作验证，
   与“未知”混为一谈。

修正后的规则（`lib/capability-usage.js`）：

- 只有**生命周期调用尚未返回**时发生的发布工具调用才算 `verificationInvocations`；
- 生命周期调用从未返回（崩溃/截断）时，其下调用记为 `unattributedInvocations`，既不是使用也不是验证；
  评审把“0 使用 + 存在不可归因调用”当作未知，不产生停用建议；
- 工具名只从 `defineTool` / `registerTool` / `tools.register` 的定义处提取。旧规则接受源码里任意
  `name: "…"`，参数 schema 或配置字段都可能变成伪调用计数；
- 同一工具名属于多条发布记录时，对每条记录都记为不可归因，旧实现会静默归给最后一条；
- 会话不可读、解压失败、超过 256 MiB 解压上限、行无法解析时，受影响计数为 `null`，`complete: false`；
  插件源码不可读、工具名同名冲突或插件不注册工具只让**该行**为 `null`，`recordsComplete: false`，不牵连其他记录的
  实测零。运行时读到的投影若 `complete` 为 `false`、行无效或捕获时间超过 30 天，零调用按未知处理，正数调用仍是事实。

## 4. 接入方式

- 扫描实现与运行时读取放在同一个模块 `lib/capability-usage.js`；CLI 变成薄包装并新增 `--write`，
  写入 `<dataRoot>/shared-plugins/usage.json`（路径由 `sharingPaths().usagePath` 唯一定义，0600）。
- Desktop `reviewSelfEvolution()` 与 ACP `audit()` 只在显式调用时读取这份 ≤512 KiB 的投影，
  把 `usageEvidence.status/complete/stale/recordCount` 一并返回；投影损坏不会让审计失败。
- 值判定新增 `review-retirement` 动作：有证据、可逆、`requiresOwnerAuthorization: true`，
  排序在 `restart-consumer` 之后、`experience-candidate` 之前；检查本身从不执行停用。
- 不新增持久化类型、定时器、后台任务或模型调用；普通 `evolution_*` 回合不读投影。

## 5. 场景矩阵（均有自动化用例）

| 场景 | 期望 | 用例 |
| --- | --- | --- |
| 插件已安装但未被证明使用 | `usage-unknown`，无停用建议 | `test/self-evolution-review.test.mjs` “no usage projection is supplied” |
| 真实日常任务调用 | `in-use`，无停用建议 | `test/capability-usage-scan.test.mjs`、ACP/Desktop 接入用例 |
| 仅验证/诊断调用 | 验证计数，工作流 0；只有 `self-contained` 才出现停用候选 | 同上 |
| 混合会话（先验证、后日常使用） | 验证 1 / 工作流 1 | “a call is verification only while the promotion call that runs it is open” |
| 验证调用未返回（截断） | `unattributedInvocations: 1`，零使用不成立 | “unattributed, not zero” 与 review 用例 |
| 证据缺失 | `usage-unknown`，不产生候选 | 同上 |
| 扫描不完整 / 过期 | 计数 `null` 或 `stale`，零使用不成立；正数仍可用 | “unknown, not zero” 与 “stale projection” |
| 同名工具属于两条记录 | 两边都不可归因，扫描 `complete: false` | “tool name claimed by two records” |
| 配对任务证明工作流收益 | `experimentBenefit` + `paired-workflow`（既有逻辑，未改） | `test/self-evolution-review.test.mjs` provenance 用例 |

## 6. 实测收益与边界

入口 A/B、审计耗时与扫描开销见
[`docs/performance/capability-usage-audit-wiring.md`](../performance/capability-usage-audit-wiring.md)。要点：

- 基线入口即使投影存在也报 `usageEvidence.status: absent`、`usage-unknown`；候选读到投影后为
  `in-use` / `invoked: false`，且把停用候选放进 `nextActions`；
- 显式审计多读一个小文件，中位耗时与基线同处亚毫秒（有投影 0.34 ms、零投影 0.50 ms、无投影 0.71 ms，基线 0.45 ms）；
- 离线扫描 200 会话 × 2,000 行（380,000 调用）：中位 303.2 ms，RSS 增量 +53.3 MiB。

**未证明的部分**：本机没有可解析的完整宿主身份，入口 fixture 的 stable 状态是 `verify-host`；
真实生产投影的真实分布、真实会话的压缩率与 RSS 上界都没有在本轮重新采集。`capabilityAssessment`
仍由操作者显式给出，脚本不推断。没有执行任何停用、删除或发布记录变更。
