# 经验发现侧的损失排序修正（2026-11-23）

基线：`origin/main` = `cbc1694`（PR #81 合并后的 `v0.2.16` 工作树）。本文只记录本轮实际读取、执行和测到的内容。

## 1. 结论

生产经验库里最大的三类真实损失**从未进入候选队列**，而计划把它们报告成“证据不足”：

| 目标 | 记录失败数 | 修改前在计划里的位置 |
| --- | ---: | --- |
| `tool run code` | 167 | 既不在 `candidates`，也不在 `rejected`（被 10 条上限按字母序截掉） |
| `tool bash` | 102 | 同上 |
| `tool apply patch` | 43 | `rejected: caller-input`（43 条里只有 9 条是 caller input，另有 34 条无归因） |
| `tool edit` | 11 | `rejected: caller-input`（11 条里只有 3 条是 caller input） |

根因是两处结构性判定，不是数据不足：

1. **成因判定按“目标全部模式的并集”做**。`failureOrigin()` 把目标里所有失败模式拼成一个字符串再做正则判断，于是任意一条 `invalid args` / `fs patch mismatch` / `fs edit missing` 就把整个目标判成 `caller-input` 并拒绝。`tool run code` 因为 2 条 `invalid args` 丢掉了另外 165 条；`tool apply patch` 因为 9 条 `fs patch mismatch` 丢掉了另外 34 条。
2. **两种候选在同一把 0..1 尺子上用两套公式排序**。工具错误用 5 项公式，非错误退化用另一套（频率 .45、成本 .20、可恢复性 .10），而“有观测窗口”与“没有窗口”又分别落到失败率与“6 次即饱和”的历史计数上。结果是：5 次读取截断得 0.779，167 次工具失败得 0.443；一次观测尝试的 `tool wait agent`（8 条）得 0.7314，4 条的 MCP 工具得 0.6137，而 167 条的 `tool run code` 排在第 6 位之外。

本轮把这两处合并成一条修复：**按每个失败形状判定成因并取多数，用一套公式按记录到的损失排序两种候选**。修改后同一份生产数据的候选队列从“30 / 8 / 10 / 18 / 4 条”变成“167（窗口内 60）/ 30（+5 次恢复调用）/ 43（窗口内 11）/ 4 / 11”。

## 2. 生产证据（只读）

数据源：`~/.dsh/storages/evolution-experience/experience.sqlite`（schema 1，439 个事件、49 条 canonical 行）。脚本先把 SQLite 文件复制到临时目录再读，不打开源库、不启动宿主、不写入数据根。

26 个工具目标有失败证据；其中 13 个达到证据门槛（≥3），合计 408 条记录。修改前：

- `candidates`（上限 5）合计覆盖 **70** 条记录（17%）；
- **6 个目标（284 条，70%）在 `candidates` 与 `rejected` 里都完全不出现**：`tool run code` 167、`tool bash` 102、`tool job output` 6、`tool grep` 3、`tool team task create` 3、`tool cordis inspect query` 3；
- `rejected` 按 `problemKey` 字母序截断到 10 条，所以 167 条那条被 1 条的目标挤掉；
- `evolution_plan {focus: "run code"}` 的回答是 `none.reason: "insufficient-evidence"`（`detail`：*no evidence-ranked candidate matched focus*）——对一个有 167 条失败的目标，这是错误陈述。

修改后：

- `candidates` 合计覆盖 **255** 条（63%），`selected` 是最重的 `tool run code`；
- `tool apply patch`（43）与 `tool edit`（11）成为候选，因为它们的多数成因是“无归因”而不是 caller input；`tool edit` 的 `originCounts` 是 `{ unknown: 8, caller-input: 3 }`；
- 真正的 caller-input 目标仍然被拒绝，但 `detail` 会写明「caller input is the largest recorded cause (N of M)」并列出来源分布；
- `focus: "run code"` 返回 `tool run code`（167）。

两份完整计划文档：`plan-before.json` / `plan-after.json`（见 §5 复现命令），逐字段对比如下。

| 目标 | 修改前 | 修改后 |
| --- | --- | --- |
| `tool run code` | 不出现 | 候选 #1，0.6558，167 条 / 窗口内 60 |
| `tool read` | 候选 #1，0.779（退化公式） | 候选 #2，0.4564，30 条 + 5 次恢复调用 |
| `tool apply patch` | `rejected: caller-input` | 候选 #3，0.3746，43 条 / 窗口内 11 |
| `tool mcp t3-code pull request read` | 候选 #5，0.6137 | 候选 #4，0.3720 |
| `tool edit` | `rejected: caller-input` | 候选 #5，0.3289，11 条 / 窗口内 4 |
| `tool wait agent` | 候选 #2，0.7314（窗口只有 1 次尝试） | 候选队列之后（0.2706） |
| `tool bash` | 不出现 | 队列第 6（0.3085），不再被截断隐藏 |

## 3. 修改机制

`lib/experience-plan.js`（纯逻辑，无 I/O、无模型、无时钟）：

- **按形状归因**（`tallyOrigin` / `dominantOriginOf`）：每个失败行按自己的模式归类，按出现次数累加；目标的成因取**多数**，平票时 `caller-input` 优先落败（并列不是多数）。只有 `caller-input` 是最大成因时才拒绝目标。
- **`originCounts`**：候选与被拒绝项都带上各成因的条数，操作者能看出“这个目标 165 条无归因”，从而去修观测，而不是被错误理由挡住。
- **一套评分**（`scoreOf`）：六项权重之和为 1 —— 记录损失量 .35、失败率 .20、时效 .20、广度 .10、回归 .10、证据 .05。`volumeUnits` = 观测窗口内的失败数（没有窗口时用历史失败数）+ 退化实际付出的恢复调用数；分母是本计划里最大的损失量（下限为证据门槛的两倍）。失败率只在窗口有 ≥5 次尝试时计入，并按样本量向中性值收缩（5 次尝试只提供 25% 的权重，20 次才全量），没有窗口时计 0 —— “没有观测”不等于“一直在失败”。
- **`rejected` 按记录损失降序**，有界截断不会藏掉最大的一条。
- **`none.reason` 说真话**：证据达标但全部被拒绝时给出 `already-resolved` 或 `caller-input`；`none` 同时带 `rejected` 的按原因计数。

分数只用于排序（`candidates.sort` 与 `selected`），不写库、不参与门禁；归一化分母是同一计划内的最大损失，所以**跨计划的分数不可比**，这是刻意的。

## 4. 实际执行的验证

| 检查 | 结果 |
| --- | --- |
| `node --test test/experience-plan.test.mjs test/experience-attribution.test.mjs test/experience-degradation.test.mjs test/experience-plan-real-capture.test.mjs` | 46 项通过，0 失败 |
| 新增用例 | 一条 caller-input 不再否决被其他成因主导的目标；caller-input 占多数时仍拒绝并写明计数；`none.reason` 为 `caller-input`；`rejected` 按损失排序；60 条窗口内失败压过 4/5 的小样本；退化损失与错误损失同尺比较 |
| 全量 `NODE_OPTIONS=--max-old-space-size=4096 npm test` | 仅 `test/release-pin.test.mjs` 因工作树未提交而失败（预期，提交前不能作为判据） |
| 真实宿主（隔离 home，`0.2.2-rc.5`，`--no-hmr --experience-evolution`） | 见 §4.1 |
| 生产库重放（修改前/后同一份数据） | §2 的数字；脚本见 §5 |

### 4.1 真实宿主

在隔离 runtime/home 上用本树打出的 tarball（`contentSha256` 前缀 `b9d020f6`）运行 `npm run acceptance:host -- --host 0.2.2-rc.5 --no-hmr --experience-evolution`：25/25 步通过，最终 doctor `healthy`。其中与本次改动直接相关的证据：

- 12 个工具注册；`seed` 阶段用真实失败产生 4 条记录，`evolution_plan` 选中 `tool probe healthcheck`（`occurrences: 4`、`observedAttempts: 4`、`observedFailureRate: 1`、`originCounts: {"unknown": 4}`），随后 propose → baseline（3/3 目标失败）→ trial → candidate（3/3 成功）→ measure → promote → canary 全部通过；
- `restart` 阶段：新进程启动 canary 结算、晋升工具真实执行、结论从共享经验回读、`evolution_plan` 对已解决问题返回 `settled`；`invalid` / `regression` 阶段按既有门禁拒绝并恢复运行时。

该运行使用的是本树构建的 tarball，不是 `release/` 固定产物；它证明修改后的规划器在真实宿主链路上不改变生命周期与门禁，**不**证明排序修正带来的收益（收益证据是 §2 的生产库前后对照）。

## 5. 复现

```sh
# 只读复制生产库（源库不会被打开）
cp ~/.dsh/storages/evolution-experience/experience.sqlite /tmp/experience.sqlite

# 修改后
node docs/audit/replay/plan-from-store.mjs --store /tmp/experience.sqlite \
  --now 2026-11-23T00:00:00Z --versions 0.2.2-rc.5,4.1.0,0.2.16

# 修改前（同一份数据，取基线的规划器）
git show origin/main:lib/experience-plan.js \
  | sed "s#from \"./dockyard-domain/knowledge.js\"#from \"$PWD/lib/dockyard-domain/knowledge.js\"#" \
  > /tmp/baseline-plan.js
node docs/audit/replay/plan-from-store.mjs --store /tmp/experience.sqlite \
  --module /tmp/baseline-plan.js --now 2026-11-23T00:00:00Z --versions 0.2.2-rc.5,4.1.0,0.2.16
```

## 6. 未证明与剩余风险

1. **这不证明 `tool run code` 是最好的目标。** 它的窗口失败率只有 2.7%（2188 次尝试里 60 次失败），排序修正只保证“队列反映记录到的损失”；可达成性仍由模型的假设负责。真正决定收益的是下一轮的候选策略，本文不改变它。
2. **“模型不使用已晋升能力”未解决。** 2026-11-18 的负结果（6 个真实会话 0 次选择已晋升工具）依然成立；本次修改没有增加任何提示、注入或选择机制。
3. **归因依赖宿主发布的 code。** 没有 `error.info.code` 的失败仍然是 `unknown`（生产库里 34 条 `apply patch`、95 条 `bash` 属于这一类）。本轮只让它们不再被单条模式否决，并把这个事实显式报告出来；要真正归因仍需宿主侧的结构化失败码。
4. **退化观测仍只覆盖 `read`。** `line-truncated` / `output-capped` 之外的非错误损失（例如 `apply_patch` 的上下文失配重读）仍只能作为错误计数进入队列。
5. **排序权重是判断，不是测量。** 六项权重换一组数字会得到另一份顺序；本轮能证明的是：修改前的顺序存在两类可复现的错误（整类目标被静默丢弃、两套公式不可比），修改后同一份数据上最大损失排在最前。ffprobe 式的“最优权重”没有证据，不做。
