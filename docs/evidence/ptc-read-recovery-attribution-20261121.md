# PTC 读取退化的恢复成本

## 本机只读取证

以 PR #79 合并提交 `86f8f90` 为基线。只读检查了 578 个 DSH 会话存档的工具事件和一个有 439 个事件、49 条聚合记录的共享经验快照。取证只输出事件类型、计数、匹配结果和时间关系。四条 stable 发布记录和正式数据均保留。

该快照的 `tool read` 有 30 次失败、5 次非错误退化，5 次都记作恢复，最近的恢复工具为 `run_code`。使用 DSH 0.2.2-rc.5、Cordis 4.1.0、Evolution 0.2.15 的版本三元组，基线规划器把 `tool read` 排在首位。两条退化聚合记录各自最近的一次可与会话事件按类型、时间顺序对照，间隔分别为 20 ms 和 22 ms。两次都只有成功的外层 `run_code` 回执，根调用内没有后续回退子调用。同轮之后第一次成功的 shell 子调用分别属于别的 PTC 根，命令也未引用原读取文件。

存档中还有补丁上下文不匹配、守卫拒绝、等待超时和缺少细分类别的工具错误。这些计数涉及不同根因，未用来给新候选许诺实际收益。`tool read` 的已采纳结论对应 Evolution 0.2.13，不能作为 0.2.15 的同版本去重证据。服务端结论也不足以把普通分页和真实任务损失全部分开。

## 官方宿主配对执行

两个独立临时 home 使用同一个官方 DSH 0.2.2-rc.5 Web runtime 和同一个 `self-evolution` PTC 预设，分别安装基线和候选包。两边执行相同的真实工具调用。3 次读取均返回截断行，随后各执行一个只打印控制字符串的独立 PTC shell 调用。第 4 次读取也截断，但这次在同一根调用内通过官方 `bash` 读取了缺失的后缀。

| 检查项 | 基线 | 候选 |
| --- | ---: | ---: |
| 前三次截断记录 | 3 | 3 |
| 误记的恢复调用 | 3 | 0 |
| 四次读取的截断记录 | 4 | 4 |
| 加入同根真实回退后的累计恢复调用 | 4 | 1 |
| 每次退化的平均恢复调用 | 1.00 | 0.25 |
| `evolution_plan` 的 `tool read` 得分 | 0.7167 | 0.6667 |

两侧 17 条工具结果的事件顺序、根调用关系和成功状态一致。四次读取均确认了截断，三个独立 shell 调用都返回了控制字符串，唯一一次实际回退完整读到了预期后缀。对照测量的是经验归因与排序输入，未调用真实模型，未测量生产调用量、轮次、Token 或耗时。已有生产经验未重算。同根 `bash`／`grep` 仍是启发式信号，跨根的真实回退或程序内部直接完成的回退可能少计。

## 复现

1. 对 `86f8f90` 和候选各运行一次 `npm run release:pack`，用官方 CLI 将两份包分别装入不同的临时 DSH home。Web 启动时禁用 HMR，并使用 [self-evolution 预设](../../scripts/acceptance/fixtures/self-evolution-preset.cordis.patch.yml)。
2. 通过 `ctx.agents.create` 的 `setup` 回调调用 `ctx.agentPresets.mount(agentCtx, 'self-evolution')`。用 `ctx.tools.execute` 调用官方 `run_code`。每次用 `tools.read` 读取由 3500 个 ASCII 字符加 `END\n` 构成的文件首行，检查返回行看不到 `END`。前三次分别在独立根调用中执行 `tools.bash` 打印控制字符串。发出实验 Agent 的 `agent/turn-stopping`，读取 `store.discover()` 中 `tool read` 的 `metrics.recoverycalls.sum`。
3. 第四次在同一个 `run_code` 内先用 `tools.read` 读取长行，再用 `tools.bash` 执行 `tail -c 4 long.txt`，确认标准输出恰为 `END\n`。结束本轮后再次读取经验计数，并调用 `evolution_plan` 聚焦 `tool read`。
4. 回归用例可运行 `node --max-old-space-size=4096 --test --test-name-pattern='PTC envelopes' test/experience-degradation.test.mjs`。同一用例在基线记录外层回执时失败。隔离宿主全链路可运行 `npm run acceptance:host -- --host 0.2.2-rc.5 --no-hmr --experience-evolution --cross-entry --out <临时报告>`，候选 39 项通过。
