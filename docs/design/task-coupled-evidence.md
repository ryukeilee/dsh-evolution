# Task-coupled evidence（成对真实会话收益证据）

状态：契约与门禁已实现（2026-11-18）；**producer 尚未实现**，因此本文的端到端流程还没有
一次真实运行记录。本文是下一步实现的唯一契约来源，也是 `promotionGates.taskBenefit` 的说明。

## 1. 为什么需要它

确定性 probe 只能把“同一个工具、同一组参数”在 baseline 与 candidate 两边各跑一次。真实模型的
工作流不是这样：一次退化（例如 `read` 把长行截断到 2000 字符）之后，模型会走
`read` → `run_code`/`bash` → 继续。恢复路径落在 probe 的安全策略之外
（`assertProbeSafety` 只接受 `isConcurrencySafe(args) === true` 的官方工具，并拒绝 `run_code`、
写、shell、委派、后台、网络）。因此“候选优于模型实际走的完整路径”只能由真实配对会话证明。

## 2. 证据契约

`evolution_measure({ experimentId, taskId?, observation: { taskBenefit } })` 接受如下 JSON，
由 `validateTaskBenefit` 校验（`lib/orchestrator.js`）：

```json
{
  "schemaVersion": 1,
  "kind": "paired-real-session",
  "complete": true,
  "taskId": "<desktop task id>",
  "task": { "id": "<scenario id>", "promptSha256": "<64 hex>", "expectSha256": "<64 hex>" },
  "candidateHostSha256": "<sha256(composition.code.host)>",
  "model": "opencode-go/deepseek-v4.1-flash",
  "host": { "dsh": "0.2.2-rc.3", "cordis": "4.1.0" },
  "runs": { "baseline": 5, "candidate": 5 },
  "baseline":  { "sessions": 5, "correct": 5, "failures": 0, "turns": 20, "toolCalls": 30, "tokens": 100000, "durationMs": 60000 },
  "candidate": { "sessions": 5, "correct": 5, "failures": 0, "turns": 15, "toolCalls": 20, "tokens":  70000, "durationMs": 50000 },
  "adoption": { "sessionsUsingCandidate": 0, "sessionsExercised": 5 }
}
```

判定（全部为必要项）：

- 每个会话在两侧都必须正确（`correct === sessions`）；两侧会话数相同且 ≥3。
- 机制确实运行：`improvement: "tool"` 要求 `sessionsUsingCandidate >= 1`；
  `improvement: "context-policy"` 要求 `sessionsExercised >= 1`。
- `candidate.turns < baseline.turns` 或 `candidate.toolCalls < baseline.toolCalls`。
- 无实质回归：failures 不增加；tokens ≤ `max(baseline*1.05, baseline+2000)`；
  durationMs ≤ `max(baseline*1.25, baseline+60000)`。
- 绑定：`candidateHostSha256` 必须等于 Trial 记录的 `record.composition.hostSha256`；
  `host.dsh` 必须等于当前宿主；`taskId` 必须等于本次 Desktop 任务。

## 3. Producer 的职责（未实现）

一个只读的验收 harness（建议 `scripts/acceptance/task-benefit.mjs`）必须：

1. 在**隔离** runtime/home 中准备同一份 DSH 宿主与 ACP profile，绝不触碰正式 `DSH_HOME`。
2. 用与计划完全相同的`composition.code.host` 安装一个 preview 包（不经过 Trial，也尚未发布），
   并对同一自然语言任务跑 `runs` 个**候选侧**会话；每个会话由真实模型（`model-bridge.mjs`）
   驱动，工具由真实宿主执行。
3. 卸载 preview，对同一任务跑 `runs` 个**基线侧**会话；两侧的 cwd、model、host 版本必须一致。
4. 逐会话判定正确性（由任务声明的 `expect` 决定，而不是由模型自述），统计 turns、tool calls、
   token（bridge 报告的真实计费）、墙钟与失败数；对 `context-policy` 记录组件实际变换了几次
   步骤，对 `tool` 记录模型是否选择了候选工具。
5. 只有全部会话完成且正确性可判定时才写 `complete: true`；任何未完成都写 `complete: false`
   并让它被拒绝（缺失不能四舍五入成零）。
6. 把 artifact 写到 `$DSH_HOME/storages/evolution/desktop-tasks/task-evidence/<taskId>.json`
   （`0600`），再由 ACP 侧以同一 `taskId` 提交带 `verification.task` 的计划。宿主只按
   taskId 读这个固定名字，计划里不携带任意路径。

## 4. 信任边界

通道是同一 OS 用户可写的传输层，不是授权边界（与 `desktop-tasks` 其余文件相同）。
kernel 只验证结构、绑定与内部一致性，不能证明 harness 的诚实性；这与
`shared-plugins.mjs revalidate --evidence <file>` 处于同一信任级别。真正的晋升权威仍然是
8+ 项门禁与所有者显式确认；taskBenefit 只让“workflow 声明”不再能靠自测通过。

## 5. 尚未回答的问题

- preview 安装与 Trial 安装必须是同一份源码；用 `candidateHostSha256` 绑定，但 preview 的宿主
  与 Desktop Trial 的宿主是否为同一版本需要 harness 明确记录并校验。
- `context-policy` 的 canary 目前没有功能检查；producer 落地后应补一次任务复验，而不是只看
  运行时健康。
- 会话级 token 来自 bridge 的真实计费；宿主原生计量未暴露，不能用估算值替代。
