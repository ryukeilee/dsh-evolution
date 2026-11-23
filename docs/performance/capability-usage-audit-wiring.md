# 用量证据接入审计：入口 A/B 与开销

原始数据：[`capability-usage-audit-wiring.json`](capability-usage-audit-wiring.json)；
脚本：[`scripts/benchmarks/usage-audit-wiring.mjs`](../../scripts/benchmarks/usage-audit-wiring.mjs)。

本轮只改一条链路：显式自我进化审计读取操作者持久化的用量投影，并把值判定纳入 `nextActions`。
没有新增后台扫描、定时器、模型调用或普通回合的会话读取。

## 1. 方法与边界

- 基线：`git worktree` 于本轮开始提交 `7d72f35`（`v0.2.16` 已固定的树），
  `node_modules` 以符号链接指向当前安装；候选为本轮工作树。两侧各自导入自己的
  `lib/desktop-task-client.js` 与 `lib/self-evolution-review.js`，使用**同一份** fixture
  数据根（一条已发布记录、一条 active consumer 行、一份 usage 投影）。
- 入口 A/B 走真实的 `apply()` 与 `evolution_desktop { action: 'audit' }`，`spawn` 注入为
  直接抛错，因此不会启动 Desktop；`get` 返回 `null`（没有官方 package 服务的回退路径）。
  该回退在本机解析不到完整宿主身份，所以入口报告的 stable 状态是 `verify-host`；
  这不影响本轮要证明的字段（`usageEvidence` 与 `value`）。
- 直接 review A/B 显式传入固定宿主身份，以便观察完整的值判定与动作排序。
- 扫描开销使用 200 个合成会话 × 2,000 行（约 380,000 次工具调用、787 KB 压缩输入），
  内容是合成的 `evolution_probe` 窗口与 `widget_tool` / `bash` 调用；不读取任何真实会话。
- 环境：Node `v26.13.1` / darwin arm64。中位数取自 7 次（扫描 3 次）重复；采集时未并行
  运行测试或验收。

## 2. 入口 A/B（ACP `audit`）

| 场景 | 基线 | 候选 |
| --- | --- | --- |
| 无投影（`usage.json` 不存在） | `usageEvidence.status: absent`，`recordCount: 0`，tier `usage-unknown` | 同左（保持诚实） |
| 有投影，`workflowInvocations: 0` | `usageEvidence.status: absent`，`recordCount: 0`，tier `usage-unknown` | `status: ok`、`complete: true`、`stale: false`、`recordCount: 1`，`invoked: false` |
| 有投影，`workflowInvocations: 3` | `usageEvidence.status: absent`，tier `usage-unknown` | tier `in-use`，`workflowInvocations: 3` |
| 审计中位耗时 | 0.416 ms | 0.386 ms（有投影）；0.516 ms（零投影）；0.762 ms（无投影） |

基线在投影存在时也不读它：`reviewSelfEvolution()` 与 `audit()` 都调用
`readPublishedPluginReview({ paths, host })`，`usage` 始终为 `null`。候选多出的一次
`stat` + 读取（≤512 KiB 上限）与基线处在同一亚毫秒量级，差异小于单次调用的调度噪声；这是显式
审计路径，不是启动或普通回合。

## 3. 直接 review A/B（固定宿主）

| 场景 | 基线 | 候选 |
| --- | --- | --- |
| `workflowInvocations: 3` | tier `in-use`，`nextActions: []` | 同左 |
| `workflowInvocations: 0` + `self-contained` | tier `installed-only`，`retirementCandidates: 1`，**`nextActions: []`** | tier `installed-only`，`retirementCandidates: 1`，**`nextActions: ["review-retirement"]`** |

值判定本身在基线已经存在，但它没有进入有序决策：检索到的候选只留在
`retirementCandidates` 侧表里，模型读到的 `nextActions` 为空（该 fixture 没有 stable 故障时）。
候选把同一条有证据、可逆、需要所有者授权的建议放进 `nextActions`，并排在
`restart-consumer` 之后、`experience-candidate` 之前。

## 4. 离线扫描开销

| 输入 | 会话 | `tool/call` | 完整 | 中位耗时 | 峰值 RSS 增量 | 压缩字节 |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| 200 × 2,000 行 | 200 | 380,000 | 是 | 311.6 ms | +75.5 MiB | 787,567 |

- 扫描是**逐会话流式读取 + 逐行解析**，解压输出有 256 MiB/会话 上限，超过即记为失败而不是继续分配；
- 计数只保留每会话的打开集合与待定调用，聚合后释放；内存增量主要来自解压流与 zlib 内部缓冲；
- 运行时不调用这个扫描：它只读扫描产出的 ≤512 KiB 投影。

## 5. 结论边界

- 这里的入口耗时是单次 `audit` 的墙钟中位数，随数据根文件缓存与宿主状态变化；它证明的是
  “多读一个小文件”的量级，不是跨机器常数。
- 本机没有可解析的完整宿主身份，所以入口 fixture 的 stable 状态是 `verify-host`；直接 review
  使用显式宿主身份。两处结论不能互相替代。
- 扫描的 RSS 增量是过程观测，不是上界；真实数据规模与压缩率不同，数值会变。
