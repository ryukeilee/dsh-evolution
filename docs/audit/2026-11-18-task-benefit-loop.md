# Task-coupled benefit loop（2026-11-18）

本轮把 PR #69/#70/#71 留下的最后一段补上：**producer 真正生成被 `taskBenefit` 门禁接受的
成对真实会话证据**，并用一个来自真实开发损失的场景走完
发现 → 改进 → 执行 → 度量 → 晋升候选 → 稳定 → 跨端复用。本文只写实际执行和读到的结果。

## 1. 结论

1. **producer 已实现并产出真实证据。** `scripts/acceptance/task-benefit.mjs` 在隔离
   `DSH_HOME` 中启动真实 ACP 宿主，模型请求经 `model-bridge.mjs` 转发给
   `opencode-go/deepseek-v4.1-flash`，工具由真实宿主执行。两侧各 3 个新会话，同一任务、
   同一模型、同一宿主版本；每侧全部正确。
2. **一个真实损失场景完成了闭环。** 官方 `read` 把生成配置的 3,147 字符首行截断到 2,000 字符，
   baseline 会话每次都额外调用 `bash` 恢复；候选 context-policy 在
   `tools/post-execute` 中补全该行。真实 paired 结果：
   turns 15→12（-20%）、tool calls 12→9（-25%）、token 490,855→395,397（-19.4%）、
   墙钟 114.4s→74.1s（-35.2%），两侧正确率 3/3。单侧会话仍有方差：第二轮 baseline-2
   直接走 read→read→bash，token 128,033，低于 candidate-2 的 131,544；聚合方向与
   turns/tool calls 仍由候选侧胜出。
3. **发现来自真实记录，不是预先写死的场景。** baseline 会话把 8 次 `line-truncated` 退化写入
   隔离共享经验库；Desktop 内的只读探针调用生产 `evolution_plan`，返回
   `tool read`、loss `line-truncated`、8 次损失、3 次恢复调用、平均 0.38 次、可恢复，
   score 0.825，并自动要求 workflow 证据。
4. **门禁、功能复验与负证据都按预期工作。** Trial 挂载后 `functionalCheck` 通过；
   `taskBenefit`/workflowBenefit 等门禁通过；无确认不晋升；绑定确认后 canary 的两次功能复验
   都通过并 stable、发布到 `acp`；新 ACP 进程自动挂载并用真实模型再次完成同一任务。
   缺失、源码失配、无收益、未采用四种证据都在批准前失败并证明 Trial 已回滚，没有发布。
5. **这是可重复的正收益，不是“工具存在”。** 同一 producer 在另一轮完整运行中给出同方向、
   同量级的结果（见 §6）；两轮都经过真实模型、真实宿主和真实门禁。

## 2. #71 最后一处并发修复的复核

PR #71 的最后修复位于 `lib/desktop-task-host.js` 的启动恢复与 claim：

- `recoverPreviousTasks()` 先按 `state.host.pid` 跳过仍存活的宿主；同进程另一个实例则以
  `claim.instanceId` + 存活 pid 识别并跳过。
- 决定恢复前先 `claim(taskId)`；只有抢占成功才**在持锁期间重读**状态，发现已被另一个宿主写成
  终态就保留现场并释放 claim。这关闭了“读到旧 running 快照 → 覆盖新 terminal 状态”的窗口。
- `claim()` 用临时文件写入并 `fsync` 后 `link()` 原子发布；同 pid 但不同 `instanceId` 的活
  claim 不再被当作陈旧锁回收。
- `runTask()` 同样先 claim 再读 state/request；终态检查发生在任何写之前。

复核结论：**未发现可复现的竞态，本轮没有改动这条协议。** 相关回归在
`node --max-old-space-size=4096 --test test/desktop-task-host.test.mjs` 中通过（32 项，含
live same-process claim、live foreign process、startup recovery re-read 三类用例）。
剩余的理论边界是仓库既有的“同 hostname + 同 PID namespace”假设；PID 复用无法由该协议证明，
不属于本轮修复引入的问题。

## 3. 本轮改动

| 缺口 | 改动 | 位置 |
| --- | --- | --- |
| 没有 producer | 新增真实配对会话 harness，绑定候选源码、宿主版本、任务摘要；不完整写 `complete:false`，正确性由外部 `expect` 判定 | `scripts/acceptance/task-benefit.mjs`、`test/task-benefit-producer.test.mjs` |
| 安装成功 ≠ 生效 | context-policy 计划必须声明 `verification.functionalCheck`（只允许 read/glob/grep）；Trial 后与每次 canary 重放，失败回滚 | `lib/desktop-task-protocol.js`、`lib/desktop-task-host.js`、client schema、`test/desktop-task-host.test.mjs` |
| 非报错退化不可见 | `recordDegradation` 中性事实族；collector 识别 `line-truncated`/`output-capped` 与每轮一次恢复调用；不改失败分母 | `lib/shared-experience.js`、`lib/experience-collector.js`、`lib/experience-recall.js` |
| 规划器只看错误数 | 退化候选按损失频率、恢复调用成本、可恢复性评分并输出 `loss`；历史失败候选评分逐字节不变 | `lib/experience-plan.js`、`test/experience-degradation.test.mjs` |
| 没有端到端闭环 | 新增隔离 runner：真实 Desktop + ACP + kernel + producer + 发现探针 + 负证据 + fresh consumer + 重启 | `scripts/acceptance/run-task-benefit-loop.mjs`、`probes/task-benefit-plan-probe.mjs`、`fixtures/complete-read-line.host.js` |

## 4. 逐会话结果（真实模型，每侧 3 个新会话）

任务（提示词不要求某个新工具，只要求用 `read` 依次读取三个文件）：
`请依次用 read 工具读取 a.json、b.json、c.json 的第一行，然后告诉我这三个文件各自的 sentinel 字段值。`

| 会话 | 侧 | 正确 | turns | tool calls | 工具序列 | token | 墙钟 |
| --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | baseline | 是 | 6 | 5 | read, read, read, grep, bash | 199,035 | 46.0s |
| 2 | baseline | 是 | 4 | 3 | read, read, bash | 128,033 | 35.5s |
| 3 | baseline | 是 | 5 | 4 | read, read, read, bash | 163,787 | 33.0s |
| 1 | candidate | 是 | 4 | 3 | read, read, read | 131,534 | 24.1s |
| 2 | candidate | 是 | 4 | 3 | read, read, read | 131,544 | 15.6s |
| 3 | candidate | 是 | 4 | 3 | read, read, read | 132,319 | 34.4s |

汇总：baseline 15 turns / 12 calls / 490,855 tokens / 114.4s；
candidate 12 turns / 9 calls / 395,397 tokens / 74.1s。两侧 failures 均为 0，
candidate 的 `sessionsExercised` 为 3/3。baseline 的三个 `read` 结果各为 2,216 字符并带
`line truncated to 2000 chars`；candidate 的三个结果各为 3,329 字符且包含完整 sentinel。
token 来自模型账单（input + output + cache.read），fixture 的 sentinel 每轮随机生成，
模型猜中不构成正确。

## 5. 发现、门禁与负证据

- **发现**：生产 `evolution_plan` 选中 `tool read`，loss `{kinds:['line-truncated'],
  occurrences:8, recoveryCalls:3, averageRecoveryCalls:0.38, recoveryTools:['bash'],
  recoverable:true}`，`attribution:classified`，`benefitModel:{kind:'workflow'}`。
  3 次恢复分别来自 baseline-1 的 `grep` 与 baseline-2/3 的 `bash`；投影保留最近一次
  观测到的恢复工具（`bash`），计数来自指标累加，说明恢复成本按真实路径计而不是按固定假设计。
- **Trial 功能复验**：`read` 在 Trial 内返回完整首行（3,639 字符的 envelope），
  `matched:true`；两个 canary 观测同样通过。
- **门禁**：stable 后 10 项全为 true（含 `runtimeRecovered`、`workflowBenefit`、
  `taskBenefit`），decision `benefit` / source `canary-passed`；发布记录
  `evolution-promoted-07403462c061`，仅 `acp`，源码摘要
  `b4d284e48ed56fce1fe7b3ef175dc7f950a7e20452d4c6f1ee4f359ef1c42940`。
- **无确认不晋升**：在 owner gate 等待 5s 后仍是 `awaiting-owner-confirmation`，发布索引字节不变。
- **fresh consumer**：新 ACP 进程自动挂载，同一真实模型任务 4 turns / 3 calls / 132,574 tokens /
  36.1s 正确完成；三个 `read` 结果都包含完整 sentinel，没有截断。
- **负证据**：

| 变体 | 结果 | 错误码 | Trial 回滚 | 发布 |
| --- | --- | --- | --- | --- |
| 缺失 artifact | 批准前失败 | `E_DESKTOP_TASK_EVIDENCE_MISSING` | 是 | 无 |
| 源码失配 | 批准前失败 | `E_DESKTOP_TASK_EVIDENCE_MISMATCH` | 是 | 无 |
| 无收益（turns/calls 与 baseline 相同） | 门禁拒绝 | `E_DESKTOP_BENEFIT_UNPROVEN`（taskBenefit/workflowBenefit/realBenefit/measuredEvidence=false） | 是 | 无 |
| 未采用（`sessionsExercised:0`） | 门禁拒绝 | 同上 | 是 | 无 |

- **重启**：Desktop 重启后 terminal task 仍为 `stable`，发布索引字节不变。

## 6. 重复性

同一 producer/runner 在第二次完整隔离运行中再次得到同方向结果。两轮运行都使用随机 sentinel，
来自真实模型与真实宿主；数字随 provider 缓存/路径方差变化，但 candidate 的 turns、tool calls、
token、墙钟均低于 baseline，且两侧全对。

| 运行 | baseline turns/calls/tokens/时间 | candidate turns/calls/tokens/时间 |
| --- | --- | --- |
| 第一轮 | 16 / 13 / 525,316 / 101.5s | 12 / 9 / 394,662 / 55.6s |
| 第二轮（提交的证据） | 15 / 12 / 490,855 / 114.4s | 12 / 9 / 395,397 / 74.1s |

两轮都通过同一组门禁、功能复验、fresh consumer 与四种负证据；第二轮证据包含 owner
confirmation 投影，写入 `docs/evidence/task-benefit-0.2.2-rc.3-20261118.json`。

## 7. 对日常工作价值的判断

这个场景的价值不在“新增一个工具”，而在**把官方 read 的既有损失修好**：模型不需要改变习惯去
选择一个新工具，只要继续用 read，就能直接拿到完整行，省掉一次 shell 兜底。真实会话里
`line-truncated` 是 12 次/8 个会话（PR #71 的只读统计），不是最高频的失败，但本轮先证明了
“真实任务上的净收益可以通过现有门禁”的完整路径；更高频的目标（patch 上下文失配、超时）
现在也有可复用的 producer、functionalCheck 与退化观测入口。

## 8. 复现

```sh
npm run release:pack
node scripts/acceptance/run-task-benefit-loop.mjs dist/dsh-evolution-0.2.11.tgz \
  /tmp/task-benefit-evidence.json --runs 3 \
  --approve "<owner confirmation text>"
```

证据：`docs/evidence/task-benefit-0.2.2-rc.3-20261118.json`（路径已按 `$DSH_HOME` / `<work>` /
`<repo>` 脱敏；不含 sentinel 明文、会话正文或凭据）。

## 9. 剩余边界

1. 每侧 3 个会话不构成统计置信区间；它证明的是“这组真实任务上可重复的成本方向”。第二轮运行
   用于重复性，不是独立样本量。
2. token 是模型账单，包含 provider 提示缓存；两轮的方向一致，但缓存命中状态会影响绝对值。
3. 只在 macOS Desktop `0.2.2-rc.3` / Cordis `4.1.0` 上验证；其他宿主必须重跑真实验收。
4. 隔离验收里的 owner confirmation 是显式 `--approve` fixture；生产晋升仍然要求真实所有者
   在对话中明确确认，且 Desktop 会拒绝身份不匹配的确认。
5. `functionalCheck` 只允许 read/glob/grep；纯 prompt 注入且无法用只读工具观察到效果的
   context policy 不能通过该契约晋升。
6. producer 是验收 harness，不是安全沙箱；kernel 只验证结构、绑定与内部一致性，不能证明
   harness 的诚实性。它与 `revalidate --evidence` 处于同一信任级别，真正的晋升权威仍是
   门禁 + 显式确认。
7. 候选把补全限制在 256 KiB 文件 / 16 KiB 单行；更大的行仍按原样截断。该上限是刻意的上下文
   成本边界，不是收益承诺。
