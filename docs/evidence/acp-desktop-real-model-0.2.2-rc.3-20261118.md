# 真实模型自主复用：隔离取证（2026-11-18）

行为代码版本：本树 `t3/self-evolution-value-loop`；本地 tarball SHA-256
`917c905034b03e820d7e31d818a15f88e7eb29f8a29b4a61dbf18147748b835f`（`dist/dsh-evolution-0.2.11.tgz`）。

这份取证回答一个问题：**当真实模型在一个真实任务里遇到它自己的能力应该解决的失败时，
它会不会自己选择那个已晋升的能力，以及这样做是否真的带来收益。**

## 方法与边界

- 真实官方 Desktop 应用（隔离 `--user-data-dir` 与隔离 `DSH_HOME`）、真实 Evolution kernel、
  真实 ACP 宿主、真实晋升门禁与 Canary；未触碰正式 `$DSH_HOME`，未发布 release。
- 模型是真实推理：ACP 的模型请求经 `scripts/acceptance/model-bridge.mjs` 转发给
  `opencode-go/deepseek-v4.1-flash`（与生产 ACP profile 同 provider/model），工具执行全部由真实宿主完成。
  这不是宿主自带的 LLM 客户端，token 数是该次决策的真实计费，不是 DSH 原生计量。
- 计划编写与门禁驱动仍是确定性 fixture（与 #68 相同）；`realModelReuse` 一节之外的
  "模型请求"由脚本给出工具名。只有 §"自主复用" 的三对会话是真实模型决策。
- 自然语言任务只有一句：`读取 workflow-generated.json 的第一行，告诉我该文件 sentinel 字段的值。`
  提示词不包含工具名、参数或"请调用某工具"。

## 工作负载级收益（真实双路径）

Trial 内交替 A/B、B/A 五轮，target 步骤是**既有** `read`，候选是同参数的 `read_complete_line`，
另有两个 target 与一个短行 control：

| 指标 | baseline | candidate |
| --- | ---: | ---: |
| 验收通过 / 执行 | 10 / 15 | 15 / 15 |
| 失败步骤 | 第 1 个 target 5/5 被长行截断 | 0 |
| control 稳定 | 是 | 是 |
| 回归 | 否 | 否 |

`benefitKind: workflow`、`workflowBenefit: true`，8 项门禁 + workflow 门禁全部通过；
无收益、退化、证据不足三个反向工作负载都在批准前被拒绝（`no-benefit` / `regression` /
`insufficient-evidence`）。没有确认文件时 Desktop 等待 5 秒仍未自行晋升；随后以绑定
`experimentId + sourceSha256` 的所有者确认完成晋升、两次 Canary 观测、stable 与发布
（`evolution-promoted-c438996d4493`，`approvedProfiles: ['acp','web']`）。

## 自主复用（真实模型，配对）

同一任务、同一模型、同一宿主，只差能力是否挂载。候选侧由新起的 ACP 进程自动挂载并确认工具表里
包含 `read_complete_line`（`freshConsumer`）。

| 轮次 | 条件 | 模型轮数 | 工具序列 | 用到能力 | 正确 | 提示 token（input + cache.read） | 墙钟 |
| --- | --- | ---: | --- | --- | --- | ---: | ---: |
| 1 | 候选（哈希后缀名、描述只说明能力） | 3 | `read` → `bash` | 否 | 是 | 85,821 + 8,832 | 18.1 s |
| 1 | baseline（撤销挂载） | 3 | `read` → `bash` | 否 | 是 | 11,697 + 82,688 | 20.0 s |
| 2 | 候选（干净名称 + 触发条件描述） | 2 | `bash` | 否 | 是 | 35,673 + 27,392 | 8.2 s |
| 2 | baseline | 3 | `read` → `bash` | 否 | 是 | 62,511 + 31,872 | 21.5 s |
| 3 | 候选（干净名称 + 触发条件描述） | 4 | `glob` → `read` → `bash` | 否 | 是 | 36,103 + 89,984 | 33.4 s |
| 3 | baseline | 2 | `bash` | 否 | 是 | 2,531 + 60,416 | 12.3 s |

结论：**6 个真实会话里模型 0 次选择已晋升能力**，全部用 shell 兜底并给出正确答案；
配对差异方向不一致，属于模型路径方差。会话级收益为零，尽管工作负载级收益成立。

根因：配对工作负载只能证明"候选优于它包装的那个 API 步骤"，而模型的实际兜底路径（`bash`）
同样正确，因此该能力对会话没有价值。判据应改为"候选必须优于真实会话实际走的路径"。

## 与生产的关系

本取证只使用隔离 home，没有向生产安装、发布或停用任何东西；生产侧三个 stable 插件的只读结论见
[审计文档](../audit/2026-11-18-promoted-reuse-loop.md) §2。第 2 轮运行的 `ok=false` 来自
harness 自身在后续 auto-launch 步骤复用了同名计划（随后已修）；它的真实模型数据仍然有效，
但只有第 3 轮是完整通过的验收记录。
