# 验证调用与日常经验隔离

基线为 `main` 的 `3da3a32` 和仓库固定的 0.2.15 包。两侧各用独立临时 DSH home，在官方 DSH 0.2.2-rc.5 上执行。Desktop 使用正式应用二进制和独立 Electron user-data，ACP 使用确定性模型响应调用真实工具。数据来自隔离工作负载，两侧均未连接生产经验库。

| 验证项 | 基线 | 修正后 |
| --- | ---: | ---: |
| 官方 CLI 经验验收保留的普通失败 | 4 | 4 |
| 官方 CLI 单次基线探针写入日常经验的验证失败 | 3 | 0 |
| Desktop PTC 工作负载写入的验证失败 | 148 | 0 |
| Desktop PTC 工作负载写入的验证长行截断 | 12 | 0 |
| Desktop PTC 工作负载记给验证退化的恢复调用 | 12 | 0 |
| 同一对照中 ACP 普通会话保留的长行截断 | 1 | 1 |
| Desktop context-policy 功能复验写入的 `read` 验证失败 | 2 | 0 |
| Desktop context-policy 功能复验写入的 `read` 验证长行截断 | 1 | 0 |

Desktop PTC 工作负载基线把 `tool read` 排在首位，候选有 112 次失败、13 次退化，其中 12 次退化来自验证。修正后共享经验里的 `tool read` 只剩普通 ACP 会话的 1 次长行截断，低于 3 次门槛，规划器未选出候选。CLI 对照两侧各有 3 次实际失败的探针样本，修正后的 `evolution_plan` 在探针前后均报告 4 次普通失败。候选对照和真实收益门禁仍读取自己的验证样本。

CLI 基线 25 项通过，修正包含 ACP/Web 跨入口覆盖共 39 项通过。Desktop 的四组 PTC 工作负载均完成，收益存在的一组仅因缺少 `taskBenefit` 被拒绝，回滚成功。独立的 Desktop 功能复验两侧均在 Trial 前读到截断结果，Trial 后精确匹配完整行，随后因缺少成对真实会话证据以 `E_DESKTOP_TASK_EVIDENCE_MISSING` 停止并成功回滚。两种 Desktop 对照没有执行晋升确认。

## 复现

1. 运行 `npm run release:pack`。分别对 `release/dsh-evolution-0.2.15.tgz` 与 `dist/dsh-evolution-0.2.15.tgz` 运行 `node scripts/acceptance/run-host-acceptance.mjs --host 0.2.2-rc.5 --no-hmr --experience-evolution --tarball <包> --out <临时报告>`。`experienceEvolution.seed.store` 给出普通失败与探针新增事件。新增验收条件会在基线包上拒绝污染，仍会写出该阶段报告。候选侧可同时加 `--cross-entry`。
2. 分别对两份包运行 `node scripts/acceptance/run-acp-desktop-control.mjs <包> <临时报告> --work <独立临时目录> --ptc`。`TASK_BENEFIT_REQUIRED` 是预期终点，`workloadOnlyPromotion.transport.groups` 给出各组路由。此 runner 先执行一次普通 ACP 长行读取，后续发出的都是验证任务。
3. 对两侧隔离 home 的 `storages/evolution-experience/experience.sqlite` 以 SQLite 只读模式读取 `SELECT body FROM knowledge ORDER BY revision`。用 `knowledgeExperienceRecord` 投影，按 `issueType` 汇总 `tool failure`、`tool degradation` 的 `occurrences` 和 `metrics.recoverycalls.sum`，再将同一批行传给 `planEvolutionCandidates`，宿主版本使用 DSH `0.2.2-rc.5`、Cordis `4.1.0` 和 Evolution `0.2.15`。
4. 在各自隔离 Desktop 的任务通道提交 context-policy 请求。使用 [完整长行策略 fixture](../../scripts/acceptance/fixtures/complete-read-line.host)，功能复验调用 `read` 读取约 3.4 KiB JSON 首行，并将完整行作为 `lines[0].text` 期望。省略成对证据和审批文件。比较任务前后 `tool read` 的 SQLite 计数，并核对任务状态的 `functionalCheck.baseline`、`functionalCheck.trial`、错误码和回滚结果。

修正覆盖由 Desktop 任务宿主或 `evolution_probe` 发出的验证工具调用。普通工具入口发出的手工诊断调用仍按宿主身份采集。现有历史记录保留。该实验测量经验和排序准确性，未测量生产任务的失败率、模型轮次、Token 或耗时。
