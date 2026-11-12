# 主动“自我进化”请求的统一只读检查

基线：main `48d27e8`（dsh-evolution `0.2.7`）。本文描述本树新增的检查与路由，不代表已经发布。

## 1. 要解决的问题

在 Desktop / ACP 的「自我进化模式」里，用户直接用自然语言说“自我进化”时，旧流程只从共享经验发现新候选，
忽略了三类已经真实存在、而且优先级更高的事实：

1. 上一次 stable 晋升的插件在宿主升级后停在 `pending-revalidation`，消费入口因此不再挂载它；
2. 旧插件在当前宿主上被证明不兼容（缺少服务/能力、apply 失败），需要最小修复而不是重新发明；
3. 没有可执行的 stable 插件问题，也没有达到证据门槛的经验候选时，流程仍可能被推着生成一个没有收益的新插件。

本次整合把这三件事合并为一次显式、只读、可复核的检查，并复用既有机制：

| 事实 | 复用 |
| --- | --- |
| 发布索引、源码摘要、宿主身份、consumer 状态、撤销表 | `lib/promoted-sharing.js` 的既有读取器与 `hostCompatible` / `hostDigest` |
| 经验检索、评分、去重、proven-ineffective | `lib/shared-experience.js` 的 `discover()` 与纯函数 `lib/experience-plan.js` |
| Desktop 工具入口 | `evolution_plan`（新增 `stablePlugins` / `selfEvolution` 字段，工具名与参数结构不变） |
| ACP 入口 | 既有 `evolution_desktop` 新增只读 `audit` 动作，仍不运行 kernel |
| 宿主升级后的恢复 | 真实隔离宿主验收 + 既有 `dsh-evolution-shared revalidate --evidence <json>` |
| 不兼容修复 | 既有 `propose → probe(baseline) → trial → probe(candidate) → measure → promote/revert` |
| 新机会 | 既有 Propose–Probe–Compose，并沿用 strategy 指纹拒绝规则 |

检查本身不写发布索引、不创建任务、不启动 Trial、不调用模型、不使用定时器。

## 2. 数据流

```text
用户：“自我进化”
        |
        +-- Desktop: evolution_plan
        |     +-- plan()                        经验候选（既有）
        |     +-- readPublishedPluginReview()   已发布 stable 插件 x 当前宿主（只读）
        |     +-- composeSelfEvolutionReview()  有排序的 nextActions
        |
        +-- ACP: evolution_desktop { action: audit }
              +-- 同一个 review 模块（只读）
              +-- 不运行 kernel；真正的 Trial/Promotion 仍通过 delegate 交给 Desktop
```

Desktop 的 `evolution_plan` 仍是严格顺序的第一步；它的输出在原有经验计划之外增加：

- `stablePlugins`：发布索引、宿主身份、每条记录的 closed status、consumer 逐 profile 判定、reasons、nextActions；
- `selfEvolution`：`kind` / `primary` / `nextActions` / `hasBlockingStableIssue` / 经验摘要 / `readOnly: true`。

ACP 的 `audit` 返回同一组分类与决策，但明确标记 `readOnly: true` 且不持有 kernel。

## 3. stable 插件分类

每条发布记录只落入一个状态：

| 状态 | 含义 | 动作 |
| --- | --- | --- |
| `active` | 所有未被操作者撤销的已批准 profile 在当前宿主上 active，且索引未在 consumer 启动后变化 | `none` |
| `inactive` | 所有已批准 profile 都被操作者撤销；consumer 行里未批准的陈旧记录也归入此列 | `none` |
| `pending-revalidation` | 记录宿主与当前 DSH/Cordis/Include/Node 身份不一致 | `revalidate` |
| `incompatible` | 当前宿主上 consumer 报告缺少能力/服务或 plugin apply 失败 | `repair-stable` |
| `restart-required` | consumer 状态过期或不可读（索引变化、pending-restart、状态文件缺失/不可读、或宿主已匹配但记录仍是旧 pending-revalidation） | `restart-consumer` |
| `host-unavailable` | consumer 报告 `include-unavailable`（宿主可用性失败，不是插件结论） | `restart-consumer` |
| `verify-host` | 无法证明当前宿主身份 | `verify-host` |
| `source-unusable` | 源码缺失、符号链接、摘要不一致 | `operator-action` |
| `invalid` | 索引结构合法但某条记录未通过校验，或 consumer 报告 `skipped-invalid` | `operator-action` |
| `blocked` | 索引或撤销表本身不可读 | `operator-action` |

判定顺序是固定的：源码完整性 → 全部 approved profile 已被操作者撤销（inactive，不触发重验证）→ 宿主身份可证明性
→ 宿主一致性 → 撤销表可读性 → 每个 approved profile 的 consumer 行。
宿主不匹配时不会尝试判断“是否兼容”，因为只有真实隔离宿主验证才能回答这个问题。
索引结构合法但包含未通过 `validateSharedRecord` 的记录时，review 不会静默跳过：它计入 `summary.invalid`、把总状态标为
`blocked`，并为每条损坏记录给出 `operator-action`；consumer 对同一行实际会报 `skipped-invalid`。`skipped-unapproved`
只能来自与该记录批准范围不一致的陈旧 consumer 行（主循环只遍历记录自己的 `approvedProfiles`），因此按 stale 处理。

## 4. 动作排序

`composeSelfEvolutionReview()` 只做排序，不做执行：

1. `operator-action` / `verify-host`（数据完整性或宿主身份不可证明）；
2. `revalidate`（宿主升级，无需改源码）；
3. `repair-stable`（当前宿主已证明不兼容）；
4. `restart-consumer`（只是启动状态过期）；
5. `experience-candidate`（有证据的新机会；存在阻塞项时带 `blockedBy`）；
6. `no-action`。

同一 `(action, recordId/problemKey/profile)` 只出现一次，输出有界。stable 动作在截断前先按同一优先级排序，
因此 `operator-action` / `verify-host` / `revalidate` 不会被索引里靠后的低优先级记录挤掉；被截断的条数由
`nextActionsDropped` 报告，并令 `selfEvolution.incomplete=true`，模型不能把不完整的 review 当成完整结果。

## 5. revalidate 路径

`revalidate` 动作包含 `recordId`、受限的 `why`、所需证据说明、既有 CLI 命令与禁止项。
正确流程是：

1. 在真实隔离宿主（同一 DSH 版本、隔离 runtime/home）上运行既有的跨入口验收，产生
   `dsh-evolution-cross-entry-evidence` 报告；证据必须命名同一个插件 id 与 `sourceSha256`，并证明目标 profile 激活；
2. 运行 `dsh-evolution-shared revalidate --evidence <json>`，由既有实现追加一个 revalidation 代、更新记录宿主身份；
3. 重启 consumer 入口，使其重新读取索引并挂载。

禁止项：编辑 `promoted/` 源码、重新生成插件、重新走一次 promotion、或降低记录的宿主身份。
revalidate 不是新的晋升，也不改变八项门禁、所有者确认或授权范围。

## 6. 不兼容修复路径

`repair-stable` 只提供证据与方向，不生成代码。模型仍需：

1. 读取失败原因与 `evolution_propose` 附带的 experience recall，区分宿主环境失败、能力缺失与插件自身缺陷；
2. 写出最小修复候选（`strategy` + `rootCause`），走既有 baseline probe / Trial / candidate probe / measure；
3. 通过八项门禁后仍需所有者显式 `confirmation: true`；回归或证据不足时 revert，并写回结论。

原 stable 记录保持不变；修复是新的实验，不是对已验证字节的原地改写。

## 7. 明确结束

没有 stable 插件问题、没有达到证据门槛的经验候选时，`selfEvolution.kind` 为 `no-action`。
系统提示词要求模型报告这个结果并结束，不强行提出新插件；这与“只读、只由用户显式触发”的既有边界一致。

## 8. 边界与已知限制

- 检查只读：不修复索引、不重试 consumer、不 reset sticky failure；这些仍是显式操作者动作。
- consumer 的 `hostDigest` 是上一次启动时捕获的事实；索引在其后变化时只报告 `restart-required`，不推断当前运行状态。
- 当前宿主身份优先来自官方 `PluginPackages.packageOf`；ACP 等 profile 缺少该服务时回退到进程/包布局的精确解析（`lib/runtime-versions.js`），仍读不到时记录为 `verify-host`，绝不按“兼容”处理。
- ACP 的 `audit` 使用同机共享数据根与共享经验库；它不能替代真实隔离宿主验证，也不会在本机执行 revalidate。
- 检查不引入后台扫描、定时器或启动时自动修复；只有用户显式触发工具调用时运行。

## 9. 验证

- 单元：`test/self-evolution-review.test.mjs` 覆盖各状态、排序、只读性；
- 集成：`test/experience-evolution-lifecycle.test.mjs` 覆盖 `reviewSelfEvolution` 的空/有证据路径；
- 真实宿主：`scripts/acceptance/run-cross-entry.mjs` 在 stable 发布、宿主升级、revalidate 后断言 review 的分类；
- ACP：`scripts/acceptance/run-acp-desktop-control.mjs` 驱动真实 ACP 工具的 `audit` 路径；
- 固定上下文：`test/fixed-context-budget.test.mjs` 重新测量新增提示词与描述。
