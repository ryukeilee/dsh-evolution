# Desktop 工作流对照证据

Desktop 任务沿用 `evolution_propose`、`evolution_probe`、Trial、measure、所有者批准、Canary、stable 与既有跨入口发布机制。没有独立执行引擎，也不修改官方宿主。旧任务的 `verification.samples` 仍是能力自测；它们不能证明工作流收益。

## 计划与执行

计划可以增加 `verification.workload`：

```json
{
  "kind": "workflow",
  "id": "complete-source-line",
  "repetitions": 5,
  "steps": [
    {
      "name": "read",
      "candidateName": "read_complete_line",
      "role": "target",
      "arguments": {"file_path": "/isolated/workspace/generated.json", "offset": 1, "limit": 1},
      "resultPath": ["lines", "0", "text"],
      "expected": "the complete known fixture line"
    },
    {
      "name": "read",
      "role": "control",
      "arguments": {"file_path": "/isolated/workspace/short.js", "offset": 1, "limit": 1},
      "resultPath": ["lines", "0", "text"],
      "expected": "export const answer = 42;"
    }
  ]
}
```

`name` 是已经存在的 baseline 工具；target 的 `candidateName` 是候选工具，control 保持既有工具。两侧**共用同一份参数、结果字段与期望 JSON**。只读单步任务是本契约支持的范围，不支持任意代码、结果变换或工具链 DAG。多个步骤代表多个验收用例，不是有数据依赖的多步程序。期望结果应来自任务验收标准与已知输入，而不能看完候选结果后改写。

Desktop 先通过官方 preset 的公开 `resolve` / `mount` API 配置 owner 的工具作用域，再在 Trial 前执行 baseline。Trial 内交替执行 A/B、B/A 五轮，并检查既有路径的结果与 Trial 前一致，避免把缓存预热或 baseline 行为变化归给候选。所有调用仍走官方 `tools.execute`，两侧都必须通过现有 concurrency-safe 检查。缺少官方 preset 时保留旧宿主的全局工具解析；缺工具或未知工具直接拒绝，不制造 baseline 失败。

场景摘要绑定工具、输入、期望摘要、结果字段、重复次数及宿主适用版本。运行时只持久化结果摘要、验收结果、错误分类、耗时和字节计数，不把读取的正文复制到 probe 证据中。工作负载不触发后台模型、经验扫描或自动批准。

## 第二种读取损失

`output-capped` 使用同一份 `context-policy` 契约，不新增证据类型：候选只允许在官方 footer 证明是字节上限、剩余行数 ≤ 200 且剩余字节 ≤ 16 KiB、文件 ≤ 256 KiB 时补齐尾部；无显式 `limit` 时以官方默认的 2,000 行窗口为边界，不会补到文件尾。验收入口是 `run-task-benefit-loop.mjs --scenario capped`，它把被测模型的工具结果渲染上限提高，使模型看到宿主真实的 50 KiB 结果而不是测试传输层的截断。尾部超过预算时策略放弃变换，仍走原有 `offset` 路径。两种场景的发现、提案、Trial 功能复验、taskBenefit 门禁、确认、canary、stable、fresh consumer 与重启判定完全共用。收益判定的首次读取按文件绑定（`task.reads`），一个文件的值不能被另一个文件的首读顶替；pilot 的多个 provider step 计费相加，缺字段时记为 unknown。

## 门槛与指标

- **正确性优先**：调用成功但结果不符也计为失败，错误码为 `E_EVOLUTION_PROBE_INCORRECT`。候选必须通过全部验收；baseline 已通过的步骤不允许退化。
- **证据充分性**：至少五轮、至少两个用例、一个始终通过的 control；每侧样本完整且各步骤重复结果一致；精确宿主适用版本已知。达不到时为 `insufficient-evidence`，不能晋升。五轮只是小型确定性任务的最低证据，不代表大规模生产成功率的统计置信区间。
- **质量收益**：baseline 有验收失败，而 candidate 全部正确。
- **效率收益**：两侧全部正确；至少四组配对的耗时下降达到 20% 且至少 2 ms，工作负载中位耗时也达到相同降幅。亚毫秒差异不认作收益。
- **执行开销约束**：候选的工作负载中位耗时最多增加 `max(25% × baseline, 5 ms)`；序列化返回字节最多为 baseline 的四倍再加 1024 字节。后者允许补齐原本截断的必要内容，但将大量无关输出挡在门外。这些是当前有界只读任务的固定预算，不是生产 SLO，也不能由候选计划放宽。
- **成本来源**：每次真实调用的墙钟时间包含官方分派、工具执行及结果验收投影；返回字节是原始结构化值的 JSON UTF-8 字节，**不是模型 token 或账单**。报告分别保留每轮耗时、总调用数、总耗时及输出字节。Trial 前 baseline 的额外验证成本另列；安装、模型生成和晋升成本没有被当作每次工作流耗时。

measure 使用 probe 的原始记录派生指标，丢弃调用方自报收益。证据不足、不获益或退化都停在批准之前，并尝试按既有规则证明清理。批准后，Canary 继续重放能力样本以及同一工作负载的 candidate/control 验收条件；失败走既有 kernel rollback。历史实验与旧 probe 的摘要、数据格式及门禁保持原语义。

## 三种证据不能混用

| 证据 | 证明什么 | 不证明什么 |
| --- | --- | --- |
| `capability-self-test` | 候选工具存在并满足自身样本 | 工作流改善 |
| `experimental-workflow` | 固定代表性输入上的真实双路径结果与执行成本 | 用户日常生产收益、模型推理质量或长期成功率 |
| 生产工作流观测 | 经用户授权部署后、真实使用中的效果 | 不能由隔离验收代填 |

复现入口是 `scripts/acceptance/run-acp-desktop-control.mjs`，它只使用临时 home 和隔离 Electron 数据目录，包含真实官方 `read` 的长行截断发现、计划 fixture、三类拒绝、审批绑定、Canary、stable，以及新 ACP/Web/Desktop 会话实际调用。模型传输是确定性 fixture，只选择真实工具和计划，不伪造工具返回；因此不宣称验证了真实模型自主提出方案的质量。它既不安装生产 profile，也不下线现有 stable 插件。
