# Desktop 工作流收益闭环：独立审核台账

审核基线为 PR #67 最终提交 `de03a5b746a68d32df2c087773f87f0b85b9b083`。本次不重复调查 #67 已解决的真实分母、失败归因和收益来源；已核对其 CI run `44097726139` 与 Code Scanning run `44097726046` 均为 completed / success。

- 第 1 轮：版本 `c53e6c0`，GPT-6.1 Sol，CHANGES。
- 第 2 轮：版本 `eb9f23c`，GPT-6.1 Sol，APPROVE，确认主门禁 S1 已解决。
- 最终真实验收额外复现了同源 advisory veto（主门禁 eligible，但确认晋升返回 domain-evaluator-rollback），没有把失败记录算作成功。
- 第 3 轮：版本 `9fd8710`，GPT-6.1 Sol，APPROVE，确认 S1b 已解决，无未解决项。
- 请求及返回的 provider 为 `codex`、模型 `gpt-6.1-sol`、`reasoningEffort=high`；完成回执的 `executedModel` 为 `gpt-6.1-sol`。审核子线程的宿主运行时也声明 `high`，没有额外独立推理档位回执。usage 未提供，不推测 token 用量。
- 审核为只读，没有编辑、提交、推送、评论、部署或再委派。统一审查命令为 `git diff de03a5b`；后续两轮仅复查 S1/S1b 和首轮后的行为改动。

| 编号 | 严重性 | 问题与处理 | 结论 |
| --- | --- | --- | --- |
| S1b | should | 真实确认晋升时，advisory evaluator 对预算内原始耗时增加仍执行零容忍 veto。仅为内部派生且 benefit、durationAcceptable 都已通过的 workload，在 advisory 指标副本中去掉 durationMs；完整原始耗时留在 observation 和 probe，其他指标与未证明/超预算/历史路径保留 veto。聚焦回归直接验证 evaluator 结果。 | resolved；第 3 轮核对真实 promote 调用链并确认 |
| S1 | should | workflow 允许质量提升伴随少量延时增加，但旧通用数字门禁拒绝任何延时增加。仅对 measure 内部派生的 workload 使用其权威 comparison；调用方不能通过 measure 传入 probeDerived/probe。保留原始成本和旧指标规则。补充 1→2 ms 预算内通过、1→12 ms 超预算拒绝、无内部标记仍按旧规则拒绝的回归。 | resolved；第 2 轮确认 |

没有被拒绝的建议，也没有未解决的 blocker / should。后续 diff 增长仅为主门禁/advisory 的最小预算一致性修复、一个扩展聚焦回归及真实验收证据；没有增加新的运行时或理论边缘防护。

代码审核版本 `9fd8710` 之后仅补充验收记录和说明。实际测试及宿主取证结果以同目录的 `desktop-workflow-benefit-20261117.json`、`workflow-host-0.2.2-rc.3-20261117.json` 及交付报告为准；审核批准本身不替代执行证据。
