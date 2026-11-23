# 进化目标形态与真实恢复路径的匹配（2026-11-24）

基线：`origin/main` = `ac10504`（已合并 PR #83）。本文只陈述本轮实际读取、修改和执行的内容。

## 1. 实际瓶颈

`docs/audit/2026-11-18-promoted-reuse-loop.md` 的真实模型配对里，工具形态候选被模型 **0/6** 选择；
`docs/audit/2026-11-23-promoted-adoption-chain.md` 则证明唯一有工作流收益的已晋升能力是
`context-policy`（不注册工具，经官方 `tools/post-execute` 变换既有结果），配对会话中机制运行 3/3、
模型主动选择 0 次。

但 `lib/experience-plan.js` 在修复前只输出自由文本 `whyCordisPlugin`。对带恢复路径的
`line-truncated` 退化，它写着“通过官方 tools/post-execute 或 agent/pre-step 改造既有执行路径”，
却没有机器可读的改进形态、钩子和**模型实际走过的恢复基线**。于是：

- `evolution_plan` 的消费者拿不到可直接用于 `evolution_propose` / Desktop 计划的 `improvement`；
- `composeSelfEvolutionReview()` 的 `experience-candidate` 动作也没有形态信息；
- 证明闭环的 `scripts/acceptance/run-task-benefit-loop.mjs` 只能把 `improvement: 'context-policy'`
  硬编码进计划，规划器的判断与候选形态之间没有可验证的约束。

这是“能发现损失、但选出的能力形态仍可能是模型不会选的新工具”的具体断点，不是晋升门禁或插件加载问题。

## 2. 为什么选这个目标

既有审计的生产会话统计（495 个会话 / 17,125 次调用）里，patch 上下文失配约 53 次、run_code 语法错误
21 次、`read` 长行截断 12 次 / 8 个会话，恢复多经 `run_code` / `bash`。前两类没有已证明的自动修复机制，
patch 类还被规划器按 `caller-input` 拒绝；把它们改成候选会制造更多需要模型主动选择的新工具，且需要新的
安全边界与配对证据。本轮不预设它们必须被解决。

截断退化则同时满足：有真实发生频率、有观测到的恢复调用（`recoveryTools`/`recoveryCalls` 已由
`experience-collector` 以中性事实写入）、已有官方 hook 可在不要求模型选择的前提下生效，并已有配对
真实会话证据。故本轮只修复“从证据到形态”的匹配，不改晋升条件、canary、回滚或跨入口共享。

## 3. 改动

1. `lib/experience-plan.js`：候选新增 `improvement`（`tool` / `context-policy`）、`hook`、
   `baselinePath`（观测到的恢复工具、累计调用数及其口径）、`verificationKind` 与 `improvementReason`。
   只有达到证据门槛、属于工具作用域、**已有 `workflow` 收益声明**、有观测恢复调用且恢复原因带有
   `tool:` 前缀、`observed` 状态与合法工具名的退化才推荐 `context-policy`；普通能力缺失仍是 `tool`；
   无恢复路径、失败状态、自由文本原因或非工具作用域的退化不会被升级成策略钩子。累计恢复调用数与知识行
   记录的恢复工具分别标注，不把累计数归给某一个工具。`verificationKind` 从既有 `benefitModel` 派生，
   `whyCordisPlugin` 从已选形态派生，避免同一候选的行动指引互相矛盾。
   保留旧字段与评分，不改变已发布记录或历史数据。
2. `lib/self-evolution-review.js`：`experience-candidate` 动作携带同一形态、验证契约与恢复基线；未知形态
   不进入提案契约。
3. `scripts/acceptance/run-task-benefit-loop.mjs`：计划由 `evolution_plan` 选出的 `improvementReason`、
   `baselinePath` 与 `improvement` 构造，并断言形态、hook、验证契约与 bash 恢复路径都存在；不再在
   harness 里写死候选形态。

## 4. 验证

聚焦测试：`test/experience-degradation.test.mjs`、`test/experience-plan.test.mjs`、
`test/experience-plan-real-capture.test.mjs`、`test/self-evolution-review.test.mjs`（73 项通过）。
新增用例覆盖：有恢复的退化→context-policy、能力缺失→tool、无恢复退化→tool、累计恢复次数与单个工具
分开归因、非工具作用域/非法恢复工具名/失败状态/自由文本原因→tool、行动指引与已选形态一致、评审动作
透传与未知形态拒绝。

隔离真实宿主 + 真实模型 + 自然语言任务：本树打包（`dist/dsh-evolution-0.2.16.tgz`，sha256
`236a304439a260ce3fe7a1243f1313a3ff96eefbc765557fcd2e879fc17e03f1`），官方 Desktop `0.2.2-rc.5`
+ ACP，隔离 runtime/home，模型 `opencode-go/deepseek-v4.1-flash`：

```sh
node scripts/acceptance/run-task-benefit-loop.mjs dist/dsh-evolution-0.2.16.tgz \
  docs/evidence/task-benefit-0.2.16-plan-driven-form-final-20261124.json --runs 3 \
  --approve "<owner confirmation for the isolated plan-driven context-policy validation>"
```

证据：`docs/evidence/task-benefit-0.2.16-plan-driven-form-final-20261124.json`，`ok: true`。规划器从 baseline
会话写出的 9 次 `line-truncated`（累计恢复 3 次、记录工具 `bash`）生成 `improvement: "context-policy"`、
`hook: "tools/post-execute"`、`verificationKind: "paired-real-session"` 与上述 `baselinePath`。

| 侧 | 会话 | 正确 | 失败工具结果 | turns | tool calls | tokens | 墙钟 | 机制运行 | 模型选择 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 3 | 3/3 | 0 | 15 | 12 | 489,261 | 85.7 s | 0 | 0 |
| candidate | 3 | 3/3 | 0 | 12 | 9 | 398,462 | 72.8 s | 3 | 0 |

差值：turns −20%、tool calls −25%、tokens −18.6%、墙钟 −15.0%，正确率与失败工具结果均不变。机制运行
3/3 而模型主动选择 0 次，再次区分了“自动生效”与“被模型选中”。8 项门禁 + `workflowBenefit`
+ `taskBenefit` 均为 `true`；四种负向证据（缺失、哈希不匹配、无收益、机制未运行）仍分别在所有者确认前
被拒绝；新的 ACP consumer 在同一任务上正确完成（4 turns / 3 calls，读结果包含全部 sentinel）；重启后该
问题被判定为 `already-resolved`。

## 5. 边界

- 收益只属于这条三文件长行任务与这次模型/宿主组合，不是所有工作流的普遍收益；token 来自模型账单而非
  DSH 原生计量，单会话仍有路径方差。
- `baselinePath.recoveryTools` 来自知识行的 canonical 投影，可能只保留最近一次记录的恢复工具；
  `recoveryCalls` 是跨观测累计值，两者口径分别标注，不构成完整恢复序列。
- 规划器只能根据已记录的事实推荐形态，不能证明任意失败可自动修复；patch 上下文、run_code 语法等仍需
  各自的证据与风险评估，本轮没有为它们生成候选或放宽门禁。
- 没有修改晋升门禁、确认、canary、回滚、跨入口共享或历史数据；没有发布正式版本、没有安装生产环境。
