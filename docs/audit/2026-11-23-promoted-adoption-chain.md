# 已晋升能力的采用链条（2026-11-23）

基线：`origin/main` = `cbc1694`（`v0.2.16`）。本轮只处理一条链路：**已晋升能力在真实任务里到底
有没有被执行、它的收益能不能被系统看见**。候选发现与排序（`lib/experience-plan.js`）不在本轮范围内，
PR #82（`t3/evolution-workflow-audit`）当时仍为 OPEN，本轮的改动与它没有重叠文件。

本文只陈述本轮实际读取、执行和测到的内容。

## 1. 结论

1. **2026-11-18 的“0/6”不是加载失败，也不是发现失败，而是“采用”这个问题问错了。**
   当时被晋升的是**工具形态**的候选（`read_complete_line`），它的收益要求模型主动放弃已经会用的
   `read` / `bash` 兜底路径去选一个新工具；三次配对里模型 6 个会话一次都没选它（
   `docs/evidence/acp-desktop-real-model-0.2.2-rc.3-20261118.json` 的 `realModelReuse` 中
   `usedPromotedTool: false`），而 6 个会话全部答对。
2. **项目已经用“不需要选择”的形态解决了这个问题**：context-policy 插件监听官方
   `tools/post-execute`，改写既有 `read` 的结果，不注册任何工具。生产记录
   `evolution-promoted-d1cb6b7c8b40` 就是这样一条，它的持久证据写着
   `adoption: { sessionsUsingCandidate: 0, sessionsExercised: 3 }`——模型 0 次选择，机制 3/3 运行。
3. **但价值回路看不见这种采用。** 运行时可读的用量通道只有“按工具名的调用计数”，
   context-policy 能力没有工具名可数，于是这条唯一被证明过工作流收益的记录被报成
   `usage-unknown` / `experimentBenefit: 0`，整份投影还因为“有一条记录读不出工具名”而
   `recordsComplete: false`。这是本轮修掉的根因。
4. **生产上确实有两条“晋升成功但永远不可能有用”的记录**：`run_code_diagnose`、
   `run_code_preflight` 是纯换算器，输入全部由调用方给，收益证据原文就是
   “the target tool … was absent before the trial and every registered-tool sample matched its
   expected value”——能力自测，不是工作流前后对照。它们 0 次工作流调用是**正确**结果，不是采用失败。
   本轮不为此改晋升门禁（见 §7）。

## 2. “0/6”的来源、源码与运行路径

| 环节 | 位置 | 本轮观察 |
| --- | --- | --- |
| 能力暴露 | `lib/promoted-consumer.js` → 官方 Include `mountIncludeTree` | 生产 `shared-plugins/consumers/acp.json` 四条 `status: active`；`web.json` 一条 active、三条 `skipped-unapproved`。**加载成立** |
| 能力可发现 | 插件注册的工具进入 `tools` 注册表 | 工具形态候选的工具名与描述确实出现在模型请求的工具表里（2026-11-18 证据 `candidate.toolCalls` 含 `glob/read/bash`，工具表含候选） |
| 模型选择 | 模型自身 | **6/6 没选**；用 `bash` 兜底并答对 |
| 机制执行 | context-policy 形态：`ctx.on('tools/post-execute', …)` | 3/3 会话执行，模型 0 次选择 |
| 收益 | 配对真实会话 | 见 §5 |

所以四个候选原因里，前两个（未加载、不可发现）被证据排除；“未被选择”只对**工具形态**成立，
而工具形态的收益主张本身不成立——“任务不匹配”也不对，任务就是真实发生过长行截断的那一类。

**真正的根因表述**：配对工作负载证明的是“候选优于它所包装的那个 API 步骤”，而模型真实工作流
走的是另一条兜底路径（`read` 截断后补一次 `bash`）。当兜底路径同样正确时，一个需要被主动选择的
工具对会话收益为零。这与 2026-11-18 记录的 §4.1 判断一致，本轮用生产持久证据把它量化：
`adoption.sessionsUsingCandidate` 与 `adoption.sessionsExercised` 是同一个 artifact 里的两个不同事实。

## 3. 生产现状（只读）

`node docs/audit/replay/promoted-adoption.mjs`（复用运行时同一份扫描与评审实现）：

```
578 sessions, 19907 tool calls, scanComplete=true, recordsComplete=true
value: {"productionBenefit":0,"experimentBenefit":1,"inUse":1,"installedOnly":0,"unknown":2,"retirementCandidates":0}

record                                  tier                invoked  wf     provenance           mechanism
evolution-promoted-af973a3eea01         in-use              true     5      capability-self-test n/a
evolution-promoted-e82a216992bb         usage-unknown       false    0      capability-self-test n/a
evolution-promoted-2794ab16d2b3         usage-unknown       false    0      capability-self-test n/a
evolution-promoted-d1cb6b7c8b40         experiment-benefit  null     null   paired-workflow      ran in 3 session(s), selected in 0
```

四条记录的分类（每一步都能在证据里核对）：

| 记录 | 形态 | 生产工作流调用 | 持久收益证据 | 判定 |
| --- | --- | ---: | --- | --- |
| `af973a3eea01` `readonly_git_file` | 工具 | 5 | 能力自测 | 真的被用过；收益未被证明 |
| `e82a216992bb` `run_code_diagnose` | 工具（纯换算器） | 0 | 能力自测，无 `benefitModel` | 结构上不可能有工作流收益 |
| `2794ab16d2b3` `run_code_preflight` | 工具（纯预检） | 0 | 能力自测，无 `benefitModel` | 同上 |
| `d1cb6b7c8b40` `complete-read-line` | context-policy | 不适用 | 配对真实会话 | 唯一有量化工作流收益的记录 |

`d1cb6b7c8b40` 的配对证据（`archive/experiments/exp-mwoo4y6r-1-7eb28a22.evidence.json`）：
baseline 3 会话 10 turns / 7 calls / 300,695 tokens / 78.3 s，candidate 3 会话 6 turns / 3 calls /
179,205 tokens / 31.7 s，两侧 3/3 正确、0 失败，`improvement: "context-policy"`、
`mechanismRan: true`、`adoption.sessionsUsingCandidate: 0`。

## 4. 根因与修改

`lib/capability-usage.js` 把“读不出工具名”和“读不到源码”当成同一类失败（`unreadableSources`，
reason `no-registered-tool`），于是：

- 该记录的计数为 `null`（这是对的：不能把“数不到”写成 0）；
- 但整份投影的 `recordsComplete` 变成 `false`（这是错的：扫描读到了它要读的每一个源）；
- `lib/self-evolution-review.js` 只在“计数可用”时才让 tier 落到 `experiment-benefit`，于是
  已经证明过工作流收益的记录被压成 `usage-unknown`，`valueSummary.experimentBenefit` 计为 0。

改动（两处，无新增扫描、无新增持久化类型、无门禁变化）：

1. `lib/capability-usage.js`
   - 新增 `uncountableRecords`，与 `unreadableSources` 分开；`no-registered-tool` 不再计入失败。
   - 这类记录的行带 `measurement: "no-tool-surface"`，计数仍为 `null`。
   - `recordsComplete` 不再被“结构上无法计数”的能力拉低。
   - `readUsageProjection()` 保留 `measurement`，且不把它算成 `invalidRecords`。
2. `lib/self-evolution-review.js`
   - `benefitProvenanceOf()` 额外返回 `adoption`（`sessionsExercised` / `sessionsUsingCandidate` /
     `mechanismRan` / `improvement`）。`mechanismRan` 优先读 artifact 的顶层字段；老 sidecar 没有该字段时，
     按 writer 自己的规则重算（`context-policy` ⇒ `sessionsExercised ≥ 1`，工具形态 ⇒
     `sessionsUsingCandidate ≥ 1`），不做推测。
   - `valueOf()` 识别 `measurement: "no-tool-surface"`：`invoked` 保持 `null`（永不等于“实测 0”，
     因此永远不会产生停用建议），有配对工作流证据时 tier 落到 `experiment-benefit`，并把
     “机制在 N 个会话里运行、模型选择 0 次”写进 `reasons`。
   - 无配对证据时如实报 “mounted but its effect is unproven”，tier 保持 `installed-only`，仍然没有停用建议。

新增复现脚本 `docs/audit/replay/promoted-adoption.mjs`（只读；复用运行时同一实现，不是第二套扫描器）。

## 5. 真实宿主 + 真实任务（本轮实测）

本树打包（`dist/dsh-evolution-0.2.16.tgz`，sha256 `73c4a1720c142296…`），隔离 runtime/home，
真实官方宿主 `0.2.2-rc.5`、真实 Desktop、真实 ACP、真实模型（`opencode-go/deepseek-v4.1-flash`）：

```sh
node scripts/acceptance/run-task-benefit-loop.mjs dist/dsh-evolution-0.2.16.tgz \
  <evidence.json> --runs 3 --approve "<owner confirmation text>"
```

结果 `ok: true`，8 个阶段全部通过（安装 → 配对真实会话 → 真实损失发现 → 负证据被拒 →
等待所有者确认 → 带功能复验的 stable → **fresh consumer 真实复用** → 重启后保留并已被计划判定为
`already-resolved`）。证据：`docs/evidence/task-benefit-0.2.16-adoption-chain-20261123.json`。

任务：用官方 `read` 依次读取三个只有一行的配置，回答各自的 sentinel；每行约 3,147 字符，
官方 `read` 默认把单行截断到 2,000 字符，sentinel 在截断点之后。提示词不含任何工具名。

| 侧 | 会话 | 正确 | turns | tool calls | tokens | 墙钟 | `exercised` | `usedCandidate` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 3 | 3/3 | 15 | 12 | 507,077 | 189.5 s | 0 | 0 |
| candidate | 3 | 3/3 | 12 | 9 | 398,629 | 76.6 s | **3** | **0** |

差值：turns −20%、tool calls −25%、tokens −21.4%、墙钟 −59.6%，正确率不变。

baseline 的工具序列是 `read, read, bash, read`（截断后用 `bash` 补读），candidate 是
`read, read, read`。也就是说：**收益来自“模型不用做选择”的形态**，而不是来自模型学会了选择。

fresh consumer 在同一真实任务上复现了同一效果（4 turns / 3 calls / 132,840 tokens / 15.1 s，
正确且 sentinel 完整），证明能力能在**新进程的 ACP/consumer 路径**上被发现、挂载并执行。

标准真实宿主验收也在本树上通过：
`npm run acceptance:host -- --host 0.2.2-rc.5 --no-hmr --experience-evolution` → **25/25 steps**
（`docs/evidence/host-acceptance-0.2.16-adoption-chain-0.2.2-rc.5.json`），从同一 tarball
（sha256 `73c4a1720c142296…`）安装并覆盖安装、生命周期、晋升、doctor 与经验演化路径。

`evolution_plan` 的发现阶段也来自真实数据：baseline 会话写出 9 次 `line-truncated` 退化，
探针读回 `problemKey: "tool read"`、`occurrences: 9`、`recoveryTools: ["bash"]`、
`recoverable: true`、`score: 0.8222`。

### 5.1 修复的可测效果（同一份真实产物，前后对照）

对上面那次运行留下的隔离数据根（`promoted-adoption.mjs --home <isolated home>`），
分别用修复前后两个版本的 `lib/`：

| | 修复前 | 修复后 |
| --- | --- | --- |
| 扫描 | `recordsComplete=false` | `recordsComplete=true` |
| `valueSummary` | `experimentBenefit 0 / unknown 1` | `experimentBenefit 1 / unknown 0` |
| tier | `usage-unknown` | `experiment-benefit` |
| 机制事实 | `n/a` | `ran in 3 session(s), selected in 0` |

生产库上是同一个方向的差异：`experimentBenefit 0 → 1`、`recordsComplete false → true`，
而 `retirementCandidates` 始终为 0（没有把“数不到”变成停用建议）。

## 6. 没有改的东西

- `promotionGates` 的 8 项、`workflowBenefit` / `taskBenefit` 门、所有者确认、canary、回滚、
  跨入口撤销与信任根全部未改。
- 没有新增提示词注入、没有强制调用、没有第二套调度或评分。
- `lib/experience-plan.js` 未改（PR #82 的范围）。

## 7. 未证明与剩余风险

1. **两条纯换算器记录仍是“结构上无收益”。** 它们在无 `benefitModel` 时走历史 8 项门禁，
   于是 `decision: benefit` 只证明“工具能用”。把“无配对证据不得晋升”变成内核默认会改变历史实验的
   语义，本轮不改。当前能做的只是如实报告（`capabilityAssessment` 由操作者给出，给出后才可能成为
   可逆停用候选）。
2. **工具形态能力的选择问题没有解决，也不应该靠提示词解决。** `readonly_git_file` 在 578 个会话里
   有 5 次工作流调用，说明“描述清楚的真工具”会被选中；纯换算器不会。这是任务匹配问题，不是采用机制问题。
3. **真实模型只跑了 3+3 个会话。** 它证明的是方向（同一任务、同一模型、只差能力是否挂载），
   不是长期使用率；单会话仍有路径方差（tokens 来自模型账单，不是宿主原生计量）。
4. **`mechanismRan` 的兼容推断**只覆盖 writer 已有的两种形态；没有 `improvement` 字段的更老 artifact
   仍然是 `adoption: null`，此时只报“效果未证明”，不会升级成收益。
5. `measurement: "no-tool-surface"` 只说明“不能用工具调用计数”，**不**证明能力真的跑了；
   后者只能来自配对证据或操作者的观测，本轮不猜。
