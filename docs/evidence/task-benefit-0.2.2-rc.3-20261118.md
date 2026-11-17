# Task-coupled benefit：真实隔离验收（`0.2.2-rc.3`，2026-11-18）

行为代码：本树；打包产物 `dist/dsh-evolution-0.2.11.tgz`（内容摘要随验收记录）。
机器：macOS arm64；DSH `0.2.2-rc.3`；Cordis `4.1.0`；Node `24.21.0`（Desktop 进程）。
模型：`opencode-go/deepseek-v4.1-flash`，真实推理；工具由真实 ACP/Desktop 宿主执行。

这份取证回答一个问题：**producer 能否生成被现有 `taskBenefit` 门禁接受的真实成对会话证据，
并让一个来自真实开发损失的场景走完发现→改进→度量→晋升→跨端复用。** 结论是能，且第二轮
完整运行复现了同方向结果。

## 场景

生成的三个配置每个只有一行，长度约 3,147 字符；官方 `read` 默认把单行截断到 2,000 字符，
sentinel 位于截断点之后。任务只要求模型用 `read` 读取三个文件并回答三个随机 sentinel：

> 请依次用 read 工具读取 a.json、b.json、c.json 的第一行，然后告诉我这三个文件各自的
> sentinel 字段值。

候选是一个 context-policy Host 插件：监听官方 `tools/post-execute`，当 `read` 的结果含
截断行时，通过官方 `fs` 服务读回完整行并替换结果；上限 256 KiB 文件 / 16 KiB 单行。

## 逐会话（提交的证据，第二轮）

| 会话 | 侧 | 正确 | turns | calls | 工具序列 | token | 墙钟 |
| --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | baseline | 是 | 6 | 5 | read, read, read, grep, bash | 199,035 | 46.0s |
| 2 | baseline | 是 | 4 | 3 | read, read, bash | 128,033 | 35.5s |
| 3 | baseline | 是 | 5 | 4 | read, read, read, bash | 163,787 | 33.0s |
| 1 | candidate | 是 | 4 | 3 | read, read, read | 131,534 | 24.1s |
| 2 | candidate | 是 | 4 | 3 | read, read, read | 131,544 | 15.6s |
| 3 | candidate | 是 | 4 | 3 | read, read, read | 132,319 | 34.4s |

汇总：baseline 15 turns / 12 calls / 490,855 tokens / 114.4s；candidate 12 / 9 / 395,397 / 74.1s。
turns -20%、tool calls -25%、token -19.4%、墙钟 -35.2%；两侧 3/3 正确、0 失败，
candidate 的 `sessionsExercised = 3`。baseline 的 `read` 结果各 2,216 字符并带
`line truncated to 2000 chars`；candidate 的 `read` 结果各 3,329 字符且包含完整 sentinel。

token 是模型账单（input + output + cache.read），不是 DSH 原生计量；单侧会话仍有方差
（baseline-2 的直接 bash 路径 token 低于 candidate-2），聚合方向与 turns/calls 才是门禁
使用的指标。

## 发现

baseline 会话把 8 次 `line-truncated` 退化写入隔离共享经验库。Desktop 内的只读探针调用
生产 `evolution_plan`，得到：

```json
{
  "problemKey": "tool read",
  "loss": {
    "kinds": ["line-truncated"],
    "occurrences": 8,
    "recoveryCalls": 3,
    "averageRecoveryCalls": 0.38,
    "recoveryTools": ["bash"],
    "recoverable": true
  },
  "attribution": "classified",
  "benefitModel": { "kind": "workflow", "metric": "failureRate" },
  "score": 0.825
}
```

## 门禁与功能复验

- Trial 挂载候选后，`read` 返回完整首行（envelope 3,639 字符），`matched:true`。
- 门禁：`realBenefit` / `measuredEvidence` / `repeatable` / `regressionTest` /
  `reversible` / `cleanupEvidence` / `noOrphans` / `workflowBenefit` /
  `taskBenefit` / `runtimeRecovered` 全部 true；decision `benefit` / source
  `canary-passed`。
- 无确认时等待 5s 仍为 `awaiting-owner-confirmation`，发布索引不变；绑定
  `experimentId + sourceSha256` 的确认后，canary 两次功能复验都 `matched:true`，
  stable 并发布到 `acp`（`evolution-promoted-07403462c061`）。
- fresh ACP consumer：真实模型 4 turns / 3 calls / 132,574 tokens / 36.1s 正确完成；
  三个 `read` 结果都包含完整 sentinel，没有截断。
- 负证据：缺失 artifact → `E_DESKTOP_TASK_EVIDENCE_MISSING`；源码失配 →
  `E_DESKTOP_TASK_EVIDENCE_MISMATCH`；无收益与未采用 → `E_DESKTOP_BENEFIT_UNPROVEN`
  （`realBenefit` / `measuredEvidence` / `workflowBenefit` / `taskBenefit` 为 false）。
  四种都在批准前失败、Trial 回滚成功、没有发布。
- Desktop 重启后 terminal task 仍为 `stable`，发布索引字节不变。

## 复现

```sh
npm run release:pack
node scripts/acceptance/run-task-benefit-loop.mjs dist/dsh-evolution-0.2.11.tgz \
  /tmp/task-benefit-evidence.json --runs 3 \
  --approve "<owner confirmation text>"
```

完整 JSON：`docs/evidence/task-benefit-0.2.2-rc.3-20261118.json`。它只使用隔离
`DSH_HOME`，不含正式用户数据、会话正文、sentinel 明文或凭据；路径按 `$DSH_HOME` /
`<work>` / `<repo>` 脱敏。

## 边界

- 每侧 3 个会话不构成置信区间；两轮运行用于方向重复性，不是独立样本量。
- token 包含 provider 缓存命中状态；绝对值不可直接跨轮比较。
- 只验证 macOS Desktop `0.2.2-rc.3` / Cordis `4.1.0`。
- 隔离验收的 owner confirmation 是显式 `--approve` fixture；生产仍要求真实所有者确认。
- 候选只补全 ≤16 KiB 的单行；更大的行保持截断。
