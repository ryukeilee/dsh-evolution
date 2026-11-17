# 已晋升能力的价值与自主复用（2026-11-18）

本轮基于 `ryukeilee/dsh-evolution` `v0.2.11`（`origin/main` = `83bb24c`）与 PR #69
（`t3/evolution-value-audit`，`a44c799`）的修复成果，只处理一条链路：**晋升出来的能力有没有真实价值、
模型会不会自己用它、以及系统能不能看出两者的差别**。此前 2026-11-17 与 #69 两轮审计已经证明了
安全机制（隔离 Trial、审批、Canary、回滚）有效，本轮不再重复它们。

本文只陈述本轮实际读取、执行和测到的内容；没有重跑的历史数字不引用。

## 1. 结论

1. **生产证据：三个 stable 插件从来没有用"工作流前后对照"证明过收益。** 三个晋升证据 sidecar 的
   `latestObservation` 里 `probeDerived` 全为 `null`、`probe.comparison.benefitKind` 全为 `null`，
   而 `decision.kind` 都是 `benefit`；其中两条的 `benefitEvidence` 原文就是
   "the target tool … was absent before the trial and every registered-tool sample matched its
   expected value"——那是能力自测，不是工作流收益。
2. **统一审计此前无法区分这两件事。** `readPublishedPluginReview` 直接把
   `stable.decision === 'benefit'` 读成 `experimentBenefit`，于是"工具能用"与"工作流变好"在
   `evolution_plan` 的结论里是同一个事实。这是"插件成功晋升但从不被使用"的直接原因之一：
   晋升本身从未要求过一个能被超越的既有路径。
3. **"模型不用它"此前无法被测量。** 运行时不扫描会话日志，审计的调用数来自未入库的一次性脚本
   （#69 §3 记的是 5 次"用户会话调用"）。没有可复现的输入，评审只能永远报 `usage-unknown`，
   无效成果也就无法被识别。
4. **真实模型是否自主选择从未被验证。** 此前所有跨端复用证据都由确定性 fixture 驱动，
   fixture 被直接告知工具名（见 `docs/evidence/desktop-workflow-benefit-20261117.md` 的边界说明）。
5. **本轮用真实模型验证后，结果是负的。** 三次独立配对里模型 0 次选择已晋升能力，全部用 shell
   兜底并正确完成；工作负载级收益（10/15 → 15/15）是真的，但会话级收益为零。见 §3。

对应的最小改动：

| 缺口 | 改动 | 位置 |
| --- | --- | --- |
| 收益来源不可分辨 | 从**持久晋升证据**派生 `benefitProvenance`（`paired-workflow` / `capability-self-test` / `unproven` / `unknown`）；自测不成立时不再报 `experiment-benefit` | `lib/self-evolution-review.js` |
| 用量不可复现 | 只读投影脚本，按固定规则把会话日志折算成评审接受的 `usage` | `docs/audit/replay/capability-usage.mjs` |
| 自主复用没有真实证据 | 真实模型 + 真实 ACP 宿主的配对会话，自然语言任务，提示词不出现工具名 | `scripts/acceptance/model-bridge.mjs`、`scripts/acceptance/run-acp-desktop-control.mjs` |

**验收结论：闭环已跑通，但"可重复的端到端正收益"本轮未达成。** 工作负载级的配对收益成立，
会话级收益为零，原因是选择阶段比较错了基线（见 §3 与 §4.1）。本轮不通过放宽门禁或制造调用
来弥补这一点。

### 1.1 场景频率的诚实说明

长行截断在真实会话里的规模是 **14 次工具结果 / 8 个会话**（`truncated: true` 为 40 次 / 21 个
会话）。它不是样本里最高频的失败类：同一批数据里 patch 上下文失配（`Patch rejected before any
change` / `old_string was not found`）是 59 次 / 24 个会话，run_code 语法错误 20 次，
超时 12 次。选这个场景的原因是它**已有可复现的配对工作负载契约**（#68），能先把"闭环是否真的
带来收益"这件事测清楚；它不代表最高价值目标，后续目标选择应优先考虑 §4.1 给出的判据。

## 2. 生产证据（只读）

### 2.1 会话与调用（`docs/audit/replay/capability-usage.mjs`）

```
node docs/audit/replay/capability-usage.mjs
```

493 个会话、17,114 次工具调用：

| 记录 | 工作流调用 | 验证调用 | 说明 |
| --- | ---: | ---: | --- |
| `evolution-promoted-af973a3eea01`（`readonly_git_file`） | 4 | 1 | 唯一被真实会话用过的能力 |
| `evolution-promoted-e82a216992bb`（`run_code_diagnose`） | 0 | 0 | 纯换算器，输入由调用方自填 |
| `evolution-promoted-2794ab16d2b3`（`run_code_preflight`） | 0 | 0 | 人工前置检查，规则集与真实语法失败只部分重合 |

分类规则是固定的：同一会话里还调用过晋升生命周期工具（`evolution_probe` / `evolution_trial` /
`evolution_measure` / `evolution_promote` / `evolution_canary_observe` / `evolution_desktop`）的
调用记为验证流量，其余才算使用。这与 #69 §3 的"5 次用户会话调用"不同：按这条规则，5 次里有 1 次
发生在 `evolution_desktop` 会话中，属于验证。**两个口径都在本文里给出，不把较大的那个当收益。**

### 2.2 统一审计的实际结论

用真实的 `published.json`、consumer 状态、撤销表与上面的 usage 投影运行
`readPublishedPluginReview` + `composeSelfEvolutionReview`（宿主 `0.2.2-rc.3`）：

| 记录 | tier | benefitProvenance | 工作流调用 | 结论 |
| --- | --- | --- | ---: | --- |
| `af973a3eea01` | `in-use` | `capability-self-test` | 4 | 保留：唯一被日常使用 |
| `e82a216992bb` | `installed-only` | `capability-self-test` | 0 | 可恢复停用候选 |
| `2794ab16d2b3` | `installed-only` | `capability-self-test` | 0 | 可恢复停用候选 |

`valueSummary` 为 `productionBenefit 0 / experimentBenefit 0 / inUse 1 / installedOnly 2 /
retirementCandidates 2`。两条停用建议都带 `requiresOwnerAuthorization: true`、`reversible: true`
与可直接复制的 `shared-plugins.mjs disable --profile acp --plugin <id>` 命令；本轮**没有执行**停用，
没有改 profile、没有删发布记录、没有清经验库。

`capabilityAssessment` 由操作者给出，不由脚本猜测：`readonly_git_file` 读取 git 数据源，
记为 `workflow-relevant`；另外两条输入完全是调用方填的标量，记为 `self-contained`。没有这份映射时
三条都是 `unknown`，而 `unknown` 不会产生停用建议。

## 3. 真实模型 + 真实宿主的自主复用

隔离宿主中的完整链路（真实官方 Desktop、真实 Evolution kernel、真实 ACP、真实模型）：

1. 真实 ACP 会话用官方 `read` 读生成配置，实际遇到默认长行截断（3,135 字符的第一行不可见）。
2. 计划用既有 Propose–Probe–Compose 契约提交：target 步骤是**既有** `read`，候选是同参数的
   `read_complete_line`，另有短行 control。
3. Trial 内交替 A/B、B/A 五轮，真实双路径执行：baseline 15 次执行 10 次验收通过，
   candidate 15/15（`benefitKind: workflow`、`controlStable: true`、`regression: false`），
   8 项门禁 + `workflowBenefit` 全部通过，随后进入所有者确认门禁。
4. 没有确认文件时 Desktop 不会自行晋升（等待 5 秒后仍是 `awaiting-owner-confirmation`）；
   随后用绑定 `experimentId + sourceSha256` 的确认完成晋升、两次 Canary 观测、stable 与发布到
   `acp`/`web`（记录 `evolution-promoted-c438996d4493`）。
5. 新起的 ACP 进程自动挂载该能力，模型请求的工具表里确实包含 `read_complete_line`。
6. **同一自然语言任务、同一模型、同一宿主、只差这个能力是否挂载**，各跑一次真实 ACP 会话。
   提示词只有 `读取 workflow-generated.json 的第一行，告诉我该文件 sentinel 字段的值。`，
   没有出现任何工具名、参数或"请使用某工具"的指令；模型请求由
   `scripts/acceptance/model-bridge.mjs` 转发给真实推理（`opencode-go/deepseek-v4.1-flash`，
   与生产 ACP profile 同 provider/model），工具结果由真实宿主执行。

三次独立配对（前两次用于验证"名称/描述是否影响选择"，第三次是修正了 harness 计划重名后的
完整通过运行）：

| 轮次 | 条件 | 模型轮数 | 工具序列 | 用到晋升能力 | 正确回答 | 提示 token（input + cache.read） | 墙钟 |
| --- | --- | ---: | --- | --- | --- | ---: | ---: |
| 1 | 候选（挂载，工具名带哈希后缀、描述只说明能力） | 3 | `read` → `bash` | 否 | 是 | 85,821 + 8,832 | 18.1 s |
| 1 | baseline（撤销挂载） | 3 | `read` → `bash` | 否 | 是 | 11,697 + 82,688 | 20.0 s |
| 2 | 候选（干净名称 + 触发条件描述） | 2 | `bash` | 否 | 是 | 35,673 + 27,392 | 8.2 s |
| 2 | baseline | 3 | `read` → `bash` | 否 | 是 | 62,511 + 31,872 | 21.5 s |
| 3 | 候选（干净名称 + 触发条件描述） | 4 | `glob` → `read` → `bash` | 否 | 是 | 36,103 + 89,984 | 33.4 s |
| 3 | baseline | 2 | `bash` | 否 | 是 | 2,531 + 60,416 | 12.3 s |

结论（这是本轮最重要的结果，且是**负结果**）：

- **模型在整个实验里 0 次选择已晋升能力**，尽管它就在工具表里、名字与描述都指向这个场景，
  而且模型上一轮刚刚被同一个工具截断。6 个会话全部用 shell 兜底并给出正确答案。
- 配对差异全部是模型自身的路径方差（第 2 轮候选更快、第 3 轮基线更快），不能归给能力；
  两侧 token 差异来自命中缓存与工具路径不同，方向不稳定。
- 因此这个场景**没有端到端收益**，尽管工作负载级收益是真的（10/15 → 15/15）。
- 根因由此可以精确表述：**配对工作负载证明的是"候选优于它所包装的那个 API 步骤"，
  而模型真实工作流走的是另一条兜底路径（shell）。当兜底路径同样正确时，这个能力对会话
  收益为零。** 现有的 workload 契约要求两侧共用同一参数与结果字段，因此它只能表达
  "工具替换"，无法表达"替换模型实际执行的多步兜底路径"。

证据：`docs/evidence/acp-desktop-real-model-0.2.2-rc.3-20261118.json`
（`desktopTask.workload.comparison`、`negativeWorkloads`、`freshConsumer`、`realModelReuse`）。
第三次运行 `ok=true`；前两次分别是 harness 计划重名与本轮修复前的记录，只用于上面的名称/描述对照。


## 4. 未知与剩余风险

1. **选择阶段的基线错了，这是本轮定位到的真正断点。** 配对工作负载只能表达"同一参数、同一结果字段
   的工具替换"，所以它能证明候选优于被包装的 `read`，却无法表达模型实际执行的 `read` → `bash`
   兜底序列。判据应当改为：**候选必须优于真实会话在该失败上实际走的路径**，否则不构成目标。
   这需要 workload 契约支持"序列基线"（或允许 baseline 步骤是观测到的兜底命令），属于下一轮设计，
   本轮不实现，以免在没有证据前扩大范围。
2. **真实模型只跑了三对会话。** 每侧一次，不构成成功率置信区间；它证明的是"能力在位时模型会不会
   自己选它"（结论：这三次里不会），不是长期使用率。三次的方向也不一致，说明会话级差异主要是
   模型路径方差。
3. **token 数来自模型账单，不是 DSH 原生计量。** 传输层（`model-bridge.mjs`）调用
   `opencode run`，同一 provider/model，报告的 `input`/`output` 是该次决策的真实计费；
   宿主的原生 token 计量没有暴露，本文不给估算值。第 1 轮的 token 差异还包含 provider
   提示缓存的命中状态，不能当作收益或退化。
4. **直接工具路径仍可在没有配对工作负载时晋升。** `propose` / `measure` 的历史契约（无
   `benefitModel` 时走原 8 项）按项目约定保留；本轮只保证模型驱动的 Desktop 任务通道与审计结论
   不再把能力自测说成收益。要把"无配对证据不得晋升"变成内核默认，需要先决定历史实验的语义，
   不在本轮范围。
5. **`capabilityAssessment` 仍是操作者判断。** 脚本不推断"是否自包含"，因此没有人工映射时不会
   产生停用建议（宁可不建议，也不误停）。
6. **宿主 `dsh-composition-guard` 的误杀归因已于 2026-11-17 修正**（`lib/guard.js`，重放
   40 个历史程序：拒绝 18 → 7），本轮未再改动 guard；剩余 7 个中含 4 个静态分析不区分代码与
   字符串内容的已知限制。

## 5. 复现

```sh
# 收益来源与价值结论（只读；需要真实 ~/.dsh）
node docs/audit/replay/capability-usage.mjs
NODE_OPTIONS=--max-old-space-size=4096 node --test test/self-evolution-review.test.mjs

# 真实模型 + 真实 Desktop/ACP 的隔离配对（需要已打包的本树）
npm run release:pack
node scripts/acceptance/run-acp-desktop-control.mjs dist/dsh-evolution-0.2.11.tgz \
  <evidence.json> --approve "<owner confirmation text>"
```
