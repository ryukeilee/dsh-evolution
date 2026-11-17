# Desktop 工作流收益：最终隔离取证

行为代码版本：`9fd8710`。本地 tarball SHA-256：`93f16f3c37015ee9b5cb343d5dc90e5202a4011004f2a986c3c1c852f06faa99`；分发内容摘要：`797e799aa534484dff6457b50e415e947b447aeee4a5b02105bb6e6eac08f448`。后续证据/说明提交不改变分发内容。

## 实际收益与成本

任务是完整读取生成配置的第一行，含末尾 sentinel；发现阶段由真实 ACP 会话调用官方 `read`，实际遇到默认长行截断。完整行长 3135 字符。候选保留官方宿主和 read 配置，通过官方 fs 服务为小文件提供有界完整读取。另有普通源码行与短行 control；不是让 baseline 调用不存在的新工具。

| 指标 | 既有官方路径 | 候选路径 | 来源 |
| --- | ---: | ---: | --- |
| 正确验收 / 执行 | 10 / 15 | 15 / 15 | 三个用例 × 五轮，逐调用 expected digest |
| 验收失败 | 5 | 0 | 返回成功但截断也计为验收失败 |
| 每轮工作负载中位耗时 | 1 ms | 1 ms | 官方分派、执行及验收投影的墙钟时间 |
| 配对调用累计耗时 | 6 ms | 6 ms | 各路径十五次调用 |
| 序列化结果字节 | 16660 | 22960 | 结构化工具结果的 JSON UTF-8 字节；不是 token |

结论是**质量收益成立，效率收益未成立**（`quality=true / efficiency=false`）。补齐被截断的必要内容增加了返回字节；实测开销在明示预算内。Trial 前 baseline 额外验证耗时 8 ms，另行记录，未隐藏在候选收益中。没有测模型账单、安装/生成/审批的摊销回收期，也没有宣称生产吞吐提升。

原始记录和摘要在 [JSON 证据](desktop-workflow-benefit-20261117.json)：`desktopTask.workload.comparison`、`desktopRecovery.workflowObservation.samples`。比较指标取 Trial 内交替 A/B、B/A 的 reference/candidate；reference 的结果与 Trial 前 baseline 一致，三个原始样本集合及摘要分别保留。

## 闭环与反向

- 真实发现 → fixture 根据已知输入生成候选计划 → 共同参数/验收的真实双路径 → 主门禁 → 无确认不晋升 → 绑定 experimentId/sourceSha256 的明确隔离审批 → 两次 Canary 观测 → stable。
- stable 后由新 ACP 会话实际调用；新 Web、Desktop 会话通过官方 tools.execute 再执行同一完整长行任务，均成功。没有向生产安装或写生产数据。
- 无收益、明显正确性退化、仅一轮的证据不足，均在请求审批前拒绝，证明清理，且未写发布索引。完整实验身份、门禁、结论、回滚与原始样本见 JSON 的 negativeWorkloads。
- 这是模型传输为确定性 fixture 的真实宿主实验；未验证真实模型自主规划质量，也没有获得真实生产使用收益证据。现有三个 stable 插件未下线。

## 本次执行的验证

- 最终代码 `NODE_OPTIONS=--max-old-space-size=4096 npm test`：1858 项，1856 通过，0 失败，2 跳过。
- 最终代码 `npm run pack:check`：17 项通过；development successor，固定发布字节未更新。
- 最终构建 `verify-artifact ... --content-only --tree`：内容摘要、68 条目和模式与本树一致。
- 最终构建真实 Desktop/ACP/Web 隔离任务验收：本 JSON 的 ok=true，三个反向和三端新会话实际复用全部通过。
- 基础 + experience-evolution + cross-entry 真实宿主 0.2.2-rc.3：39 步通过，见 [宿主证据](workflow-host-0.2.2-rc.3-20261117.json)。此项取证是预算一致性修复前的 c53e6c0 构建，tarball 摘要与最终构建不同；后续修复仅调整内部已证实工作负载的成本投影，历史分支不变。没有把旧摘要冒充最终构建证据。
- 三轮独立 sol-loop：最终行为 9fd8710 APPROVE，S1/S1b 均解决，见 [审核台账](desktop-workflow-benefit-review-20261117.md)。

复现命令与固定成本预算见 [契约说明](../desktop-workflow-benefit.md)。源码、生产 profile、官方宿主、Skills、模型配置和固定 release 产物均未做范围外修改。
