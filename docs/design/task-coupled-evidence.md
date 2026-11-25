# Task-coupled evidence（成对真实会话收益证据）

状态：契约、门禁与 **producer** 已实现（2026-11-18）；端到端隔离验收由
`scripts/acceptance/run-task-benefit-loop.mjs` 执行，证据见
`docs/evidence/task-benefit-0.2.2-rc.3-20261118.json`。本文是 `promotionGates.taskBenefit`
与 producer 的契约来源。

## 1. 为什么需要它

确定性 probe 只能把“同一个工具、同一组参数”在 baseline 与 candidate 两边各跑一次。真实模型的
工作流不是这样：一次退化（例如 `read` 把长行截断到 2000 字符）之后，模型会走
`read` → `run_code`/`bash` → 继续。恢复路径落在 probe 的安全策略之外
（`assertProbeSafety` 只接受 `isConcurrencySafe(args) === true` 的官方工具，并拒绝 `run_code`、
写、shell、委派、后台、网络）。因此“候选优于模型实际走的完整路径”只能由真实配对会话证明。

## 2. 证据契约

`evolution_measure({ experimentId, taskId?, observation: { taskBenefit } })` 接受如下 JSON，
由 `validateTaskBenefit` 校验（`lib/orchestrator.js`）：

```json
{
  "schemaVersion": 1,
  "kind": "paired-real-session",
  "complete": true,
  "taskId": "<desktop task id>",
  "task": { "id": "<scenario id>", "promptSha256": "<64 hex>", "expectSha256": "<64 hex>" },
  "candidateHostSha256": "<sha256(composition.code.host)>",
  "model": "opencode-go/deepseek-v4.1-flash",
  "host": { "dsh": "0.2.2-rc.3", "cordis": "4.1.0" },
  "runs": { "baseline": 3, "candidate": 3 },
  "baseline":  { "sessions": 3, "correct": 3, "failures": 0, "turns": 16, "toolCalls": 13, "tokens": 514935, "durationMs": 122492 },
  "candidate": { "sessions": 3, "correct": 3, "failures": 0, "turns": 12, "toolCalls": 9,  "tokens": 390933, "durationMs": 47572 },
  "adoption": { "sessionsUsingCandidate": 0, "sessionsExercised": 3 }
}
```

判定（全部为必要项）：

- 每个会话在两侧都必须正确（`correct === sessions`）；两侧会话数相同且 ≥3。
- 机制确实运行：`improvement: "tool"` 要求 `sessionsUsingCandidate >= 1`；
  `improvement: "context-policy"` 要求 `sessionsExercised >= 1`。
- `candidate.turns < baseline.turns` 或 `candidate.toolCalls < baseline.toolCalls`。
- 无实质回归：failures 不增加；tokens ≤ `max(baseline*1.05, baseline+2000)`；
  durationMs ≤ `max(baseline*1.25, baseline+60000)`。
- 绑定：`candidateHostSha256` 必须等于 Trial 记录的 `record.composition.hostSha256`；
  `host.dsh`/`host.cordis` 必须等于当前宿主；`taskId` 必须等于本次 Desktop 任务。

`tokens` 是模型账单，不是 DSH 原生计量：producer 把每个决策轮的
`input + output + cache.read` 相加（`model-bridge.mjs` 转发给 `opencode run`，模型与生产 ACP
profile 相同）。artifact 里的 `tokenBasis` 记录这一点，校验器忽略该只读字段。

## 3. Producer

`scripts/acceptance/task-benefit.mjs` 实现生产方：

1. 只在 `$TMPDIR`（含 `/tmp`）下的隔离 home 运行，拒绝正式 `~/.dsh`。
2. 把计划里的 `composition.code.host` 原样写成 preview 插件（不经过 Trial），在隔离 ACP
   profile 中通过 `--patch` overlay 挂载；baseline 侧使用同一 overlay 但不插入该条目，并禁用
   promoted consumer，保证唯一差异是候选。
3. 每侧跑 `runs` 个新 ACP 进程；每个会话由真实模型（`model-bridge.mjs`）驱动，工具由真实宿主执行。
   candidate-first / baseline-first 交替，避免 provider 缓存把差异归给一侧。
4. 正确性由任务声明的 `expect` 外部判定：`expect` 是 JSON 字符串数组（或单个字符串），每个值都必须
   出现在最终 assistant 文本里。fixture 的 sentinel 每轮随机生成，猜中不构成正确。
5. 逐会话记录 turns、tool calls、token、墙钟、失败数与 adoption。context-policy 的
   `sessionsExercised` 只在某次 `read` 结果确实包含期望值时记 1；tool 形式只在模型选择候选工具时记 1。
6. 任何模型轮失败、无法解析的回复或空会话都令 `complete=false`，不把未知四舍五入成零。
7. 把 artifact 原子写到
   `$DSH_HOME/storages/evolution/desktop-tasks/task-evidence/<taskId>.json`（`0600`）。默认写入
   隔离 home 自身；操作者可以用 `--channel-home <dir>` 指定“读取该证据的 profile 的 home”，此时
   会话仍然只在隔离 home 运行，**只有最后一次 artifact 写入**跨到那个 channel。宿主只按 taskId 读
   固定名字，计划不携带任意路径。

### 3.1 为已存在的 profile 生成证据（`--channel-home`）

正式/长期 profile 的 Desktop 宿主只从自己的 channel 读证据，而 producer 拒绝把会话跑在正式 home。
`--channel-home` 是显式的操作者选择：会话继续在隔离 home 中真实运行（候选对 baseline 的唯一差异
不变），artifact 直接原子写进 `<channel-home>/storages/evolution/desktop-tasks/task-evidence/<taskId>.json`。

- 通道根必须是**已存在的目录**，且不能是、也不能位于隔离 home 内；`--out` 与该选项互斥（两个
  artifact 权威）。通道内的 `storages/...` 若解析到通道根之外则拒绝写入。
- 操作顺序：先取一个桌面任务 id，用同一 `taskId` 与同一 `composition.code.host` 跑 producer
  （`--channel-home` 指向目标 profile 的 home），再把带同一 `taskId`、同一 `verification.task`
  （`id`/`prompt`/`expect`/`runs`）与同一候选源码的计划交给该 profile 的 Desktop 宿主。
- 绑定不变：内核仍逐项校验 `taskId`、`candidateHostSha256`、`task.id`、prompt/expect 摘要、
  `runs`、宿主版本与两侧正确性。会话隔离被保住，操作者为“这次运行就是它声明的运行”负责——这与
  `revalidate --evidence` 处于同一信任级别，见 §5。
- 只有能缩短真实路径（轮次或工具调用下降）的能力才可能通过 `taskBenefit`；纯粹的“预防一次非法
  调用”在没有减少轮次/调用时不构成收益。producer 只写入测量事实，收益判定由校验器
  （`validateTaskBenefit`）给出。

## 4. context-policy 的功能复验

`verification.task` 证明收益来自真实会话，但“插件被安装”不等于“它真的生效”。context-policy
计划因此还必须声明 `verification.functionalCheck`：

```json
{
  "tool": "read",
  "arguments": { "file_path": "a.json", "offset": 1, "limit": 1 },
  "resultPath": ["lines", "0", "text"],
  "expected": "<the complete line>"
}
```

- 只允许 `read` / `glob` / `grep`，参数与期望值都是有界、无损 JSON；工具面不允许 `evolution_*`、写、
  shell 或 `run_code`。
- 宿主在 Trial 挂载候选之后执行一次；不一致就以 `E_DESKTOP_FUNCTIONAL_CHECK` 失败并回滚 Trial。
- 每次 canary 观测都重放；失败按 `metricRegression` 交给内核 rollback。
- 状态投影只保留 label/tool/matched/结果 sha256/长度，不保留工具输出正文。

### 4.1 宿主侧的期望比较与 canary 证据

两类样本的取值方式不同，`resultPath` 只属于后两类：

- Trial 能力样本（`verification.samples[]`）只能声明 `label` / `tool` / `arguments` / `expected`，宿主把目标工具的**完整返回值**与 `expected` 做无损比较；它不支持 `resultPath`，带该字段的计划会被 `validateTaskRequest()` 以 `plan.verification.samples[N] has unexpected field: resultPath` 拒绝；
- `verification.workload.steps[]` 与 context-policy 的 `verification.functionalCheck` 支持 `resultPath`：宿主先按声明的键路径从真实返回值取值，再与该 step / check 的 `expected` 比较。

比较发生在宿主，宿主必须用与内核一致的无损判定：

- 宿主用无损结构相等（`lib/desktop-task-host.js` 的 `sameValue()`）而不是 JSON 文本比较：`undefined` 不等于 `null`，
  数组空洞不等于 `null`，稀疏数组按自有下标比较，`NaN` / `Infinity` / `-0` 不等于普通 JSON 数值；
- 只接受 plain object（`Object.prototype` / `null` 原型）与 dense array：`Date`、`Map`、`Set`、类实例不与 plain 对象相等，
  访问器属性与循环引用判为不相等并返回 `false`，不抛栈溢出；
- 普通 JSON 语义不变：对象键顺序无关、数组顺序有关。`canonical()` 只保留给运行时稳定指纹（比较连续两次轮询），
  它会把 `undefined`/空洞折叠成 `null`、把 `-0` 折叠成 `0`，因此不得用于证据判定。

canary 观测写入晋升 journal 与 stable sidecar 的 `evidence.actualToolOutput` 只有
`{ label, resultSha256, resultCharacters }`：摘要取自无损 canonical 文本，长度是该文本的字符数，真实工具输出正文
不跨宿主边界（它可能包含用户文件或会话数据）。Trial 与 canary 的样本不匹配同样不携带正文：`E_DESKTOP_SAMPLE_MISMATCH`
的消息只含 label（截断到 8 字符）与 actual / expected 各自的 `resultSha256`、`resultCharacters`（错误消息会落进
`state/*.json` 并进入 `logger.warn`，所以必须无正文又有界），内存中的 `error.sample` 仍保留 actual / expected 本身，
供 canary 回归路径生成上面那份摘要证据。无损文本无法计算的形状（循环、访问器、类实例）使用固定的类型化
`x` 标记，记录仍可写、诊断异常不改变任务结果。内核的通用 `evidence` 契约没有变化：它仍接受调用方提交的有界证据，
只由生产宿主负责不把正文放进去。

canonical 文本带类型前缀，使不同形状不会共用同一摘要：`null` → `n`，`undefined` → `u`，字符串 →
`s` + JSON 文本，布尔 → `b` + `true`/`false`，数字 → `d` + 字面量（含 `d-0`、`dNaN`），数组 → `a[...]`，
plain object → `o{...}`，不支持或不可计算的形状 → `x`。这取代了旧版 `"[undefined]"` / `"[unavailable]"` 这类
可被普通字符串拼出的标记，因此一份包含字面量 `"[unavailable]"` 的工具输出不会与一个缺失值共享摘要。它只影响
证据摘要的 canonical 文本，`sameValue()` 的无损相等判定不变。

## 5. 信任边界

通道是同一 OS 用户可写的传输层，不是授权边界（与 `desktop-tasks` 其余文件相同）。
kernel 只验证结构、绑定与内部一致性，不能证明 harness 的诚实性；这与
`shared-plugins.mjs revalidate --evidence <file>` 处于同一信任级别。真正的晋升权威仍然是
8+ 项门禁与所有者显式确认；taskBenefit 只让“workflow 声明”不再能靠自测通过。

## 6. 仍然未知

- 三个或五个会话仍不构成统计置信区间；它证明的是“在这组真实任务上可重复的成本方向”，不是长期使用率。
- token 差异包含 provider 提示缓存命中状态；producer 记录的是真实账单，不是因果分解。
- `functionalCheck` 只能检查可观察的输出变换；纯 prompt 注入型 context policy 若无法用只读工具
  观察到效果，就不能通过该契约晋升（这是有意的边界）。
- 真实宿主验收只覆盖本机 macOS Desktop 0.2.2-rc.3；其他宿主需要各自重跑。
