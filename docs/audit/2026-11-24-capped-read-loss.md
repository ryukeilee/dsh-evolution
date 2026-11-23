# 被截断的输出尾部：第二个真实损失闭环（2026-11-24）

基线：`origin/main` = `480d744`（已合并 PR #84）。本文只陈述本轮实际读取、执行和测到的内容。

## 1. 结论

PR #84 让规划器把「已观测恢复路径」映射成 `context-policy`，但它验证的仍只是 `read` 的单行
截断（`line-truncated`）。本轮的只读生产统计显示同一工具的**另一种**真实损失仍在发生，而现有
已晋升插件不处理它：

- 578 个会话、19,939 次工具结果、428 次失败（`docs/audit/replay/session-evidence.mjs`）；
- `read` 输出被字节上限截断（官方 footer `Output capped. Showing lines X-Y. Use offset=Z`）
  **10 次 / 10 个会话**，紧随其后的调用是 `bash` 5 次、`read` 5 次；
- 单行截断同期 9 次 / 4 个会话（恢复：`read` 5、`bash` 3、其它 1）。

每条被截断输出都要求模型额外花一轮、一次工具调用去读它本来就要读的剩余内容。现有
`complete-read-line`（生产记录 `evolution-promoted-d1cb6b7c8b40`）只补齐被截断的**单行文本**，
不改变被字节上限切掉的**窗口尾部**。这是「已有插件未解决的真实问题」，不是重复验证旧示例。

本轮完成两件事：

1. **发现层不再丢证据。** 规划器过去把每个工具作用域的所有失败模式合并后只判一个
   `origin`；只要组里出现一条 caller-input（例如 `run code` 的 `invalid args`），整个工具
   作用域就被拒绝。生产库中 `tool run code` 的 167 次失败（111 次 host operation failure、
   54 次 code run failure、2 次 invalid args）因此不进入候选、也不出现在前 10 条拒绝里，
   带 `focus: "run code"` 查询也返回空。现在按模式分别判定：只有**全部**模式都是 caller-input
   才拒绝；混合组保留可行动模式并报告被排除的模式。同一工具的多个退化损失也按 kind 分开
   投影（次数、恢复成本、观测到的恢复工具、首末时间），使「已被现有能力覆盖的损失」与
   「仍在发生的损失」不再混成一个数字。
2. **为未覆盖的 `output-capped` 损失跑通第二个闭环。** 规划器从基线真实会话记录里发现该损失，
   模型按形态写一个新的 `tools/post-execute` 策略（只在小尾部范围内补齐，不注册工具），
   Trial 功能复验、真实模型配对会话、收益门禁、所有者确认、canary、stable、fresh consumer
   与重启后 `already-resolved` 全部由同一套既有机制完成。

## 2. 链路现状（按本轮实际代码）

| 环节 | 位置 | 本轮结论 |
| --- | --- | --- |
| 非错误损失采集 | `experience-collector.js` 的 `detectDegradation` / pending 恢复 | 已识别 `line-truncated` 与 `output-capped`，并记录同路径重读或成功 shell 恢复；生产 20 次读取损失可复现 |
| 发现与归因 | `experience-plan.js` | 损失可见，但同一工具的多个 kind 只输出一个合并数字；混合失败模式的组会被一条 caller-input 记录整体拒绝（已修） |
| 形态选择 | `shapeFor()` | 有恢复路径的工具损失 → `context-policy` + `tools/post-execute` + 成对会话验证；无恢复/非工具作用域保持 `tool`（PR #84） |
| 提案与 Desktop 执行 | `evolution_propose` → `desktop-task-host` | 正常工作；context-policy 的功能复验必须由计划显式声明并对已挂载策略重放 |
| 真实任务收益 | `task-benefit.mjs` + `taskBenefit` 门禁 | 正常工作；证据由验收 harness 在隔离 home 中生成，绑定候选源码与宿主版本 |
| 晋升与复用 | 8 项门禁、所有者确认、canary、`promoted-consumer` | 本轮由同一闭环验证，未改语义 |

仍然存在的端到端阻塞：`taskBenefit` 的生产者是仓库外的验收 harness，不是产品内可自动运行的路径。一次普通的
ACP/Desktop 会话在生成候选后可以完成 Trial 与度量，但无法自己产出成对真实会话证据，因此 workflow
声明会停在门禁之前（`E_DESKTOP_TASK_EVIDENCE_MISSING` 或 `taskBenefit: false`）。本轮没有放宽这个门禁，
也没有把验收 harness 伪装成产品内能力；这是下一轮要继续解决的阻塞。

## 3. 为什么是它

| 候选损失（生产计数） | 能否由官方 hook 安全改变既有结果 | 判断 |
| --- | --- | --- |
| `line-truncated` 9 | 是（已有 `complete-read-line`） | 已覆盖，重复实现没有收益 |
| `output-capped` 10 | 是：只补一个小的剩余窗口，只读、有界 | 本轮目标 |
| `program-syntax` 37（日志）/ `code run failure` 54（经验库） | 不能确定：语法/运行错误要改的是模型写的程序，自动改写不安全 | 不选；本轮只修复其被错误拒绝的发现路径 |
| patch 上下文失配 29 | 不能：需要新的文件上下文，不是结果变换 | 规划器继续按 caller-input 拒绝 |
| composition guard 43 | 不能：宿主 guard 判定，插件不应绕过 | host 作用域，不声明 workflow 收益 |

约束 3 明确要求不能因为「观察到恢复工具」就推断失败可由 post-execute 修复。`output-capped`
可以，因为官方 renderer 已经明确标注了截断和续读位置，剩余内容是同一份只读文件里模型马上要
读的字节；策略只做有界追加，不改变工具语义。`code run failure` 不满足这个条件，本轮没有为它
生成候选，也没有放宽任何门禁。

## 4. 改动

1. `lib/experience-plan.js`
   - 失败模式逐条归类后再决定组级 `origin`：全部 caller-input 才拒绝；混合组保留可行动模式，
     新增 `excludedModes` / `mixedOrigin`。归类用**按 origin 的计数**覆盖每一个读入的模式（不按
     模式身份设上限），排除 caller-input 后按既有优先级挑选 origin，因此第 25 个可行动模式或
     记录顺序都不会改变结论；展示列表仍只有 3 项。历史单模式组的输出与评分不变。
   - `loss.kinds` 与 `loss.breakdown` 共用一次有界 kind 选择，不再出现两套顺序。
   - 退化候选新增 `loss.breakdown`：每个 loss kind 的次数、恢复调用数、恢复工具与首末时间
     （最多 3 个 kind）。
2. `lib/self-evolution-review.js`
   - `experience-candidate` 动作携带同一份 `lossKinds` 与 `mixedOrigin`，让模型在同一个
     只读动作里看到「哪一类损失、花了多少恢复成本」，而不是一个合并后的标签。
3. `scripts/acceptance/fixtures/complete-capped-read.host`
   - 新的候选源码（不是已安装插件）：仅当官方 footer 证明是字节上限（或直接执行路径给出
     「显式 limit 未达到且未到 EOF」的结构证据）、剩余行数 ≤ 200 且剩余字节 ≤ 16 KiB、
     文件 ≤ 256 KiB 时，把缺失的尾部追加到既有 `read` 结果；逐行遵循官方行号，超长行或任何
     异常都放弃变换。footer 同时接受裸文本与 `<content>` 信封两种形态，因为不同宿主路径给
     waterfall 的内容形态不同。追加终点只使用调用方显式 `limit` 的请求窗口；没有显式
     `limit` 时 footer 无法证明宿主配置的行窗口，保留原结果而不猜测。追加行也遵守官方默认的
     单行 2,000 字符上限，超长行放弃变换。只有存在显式 `limit` 时才启用「未到行数且未到 EOF」
     的结构判定，避免把宿主较小的默认行窗口误判成字节上限。沙箱不提供 `Buffer`/`process`，
     UTF-8 字节数用 `TextEncoder` 计算。
4. `scripts/acceptance/task-benefit.mjs`
   - `exercised` 改为「**从第 1 行开始**的首次**请求**同一路径的结果就带有期望值」。按
     `tool_call` 顺序登记每条路径的第一次读取，再用 call ID 要求这次请求成功返回；失败的尾部
     首读、后续续读、无法识别路径的读取都不算机制运行。路径与期望值还可以按
     `task.reads: [{ path, token }]` 逐文件绑定：token 必须来自它自己路径的首读，不能被另一个
     文件的结果顶替；相对路径按会话 cwd 解析，两个不同的绝对路径不相等。模型决策数与
     `tool_call` 数不一致时，整段归因作废而不是按位置猜测。fresh consumer 复用同一判定，
     单行截断与字节上限两个场景都按文件断言。对单行截断场景语义不变（只有候选能让首读包含
     sentinel）。
   - producer 对**仅 pilot 传输失败**（`failedTurns > 0` 且 `toolFailures === 0`）的会话做一次
     整会话替换，并在 report/evidence 中保留两次尝试的 turns/tokens；产品工具失败不替换，
     artifact 仍要求三个最终会话全部 complete、correct、failures 0。
   - 新增可选 `maxToolText`，让被测模型看到宿主真实的 50 KiB 读取结果，而不是测试传输层的
     4 KiB 截断。
5. `scripts/acceptance/model-bridge.mjs`
   - 把 `maxToolText` 作为显式选项（默认仍为 4 KiB），不改变既有场景。
   - 新增 `isolatePilotTools`：在被测模型的 cwd 写入只对 `build` agent 生效的 native-tools
     deny 配置，并显式指定 `--agent build`；解析到任何自有 `tool_use` / `tool` 时把该轮判为
     `pilot-used-own-tools` 失败。`task-benefit.mjs`、`run-task-benefit-loop.mjs` 与
     `run-acp-desktop-control.mjs` 都启用它，防止 pilot 自己读取 fixture 后给出 0 宿主调用的
     正确答案。
   - 对同一个宿主请求做一次纠正性重试，只处理 pilot 的回复无法解析/决策结构无效；两次尝试的
     usage 相加并记录 `retries`。任何非零退出/信号（即使已有部分文本）或自有工具调用都不
     重试，直接保持失败轮。一次 `opencode run` 的多个 provider step 的 `step_finish` usage
     逐项相加；任一 step 缺少计费字段时该轮记为 unknown，而不是按最后一步的小计冒充总量。
     fresh consumer 与 ACP 对照在 `usage.unknownTurns > 0` 时把 token 总量标为未知，而不是
     把已知轮次的小计冒充总量。
6. `scripts/acceptance/run-task-benefit-loop.mjs`
   - 新增 `--scenario capped`：生成三个刚超过官方 50 KiB 字节上限、sentinel 在最后一行的文件；
     从规划器选择的 `output-capped` 损失构造提案；功能复验读取第 700 行；fresh consumer
     断言首次读取已包含 sentinel 且不再出现 `Output capped`。
   - 默认 `--scenario line` 保持上一轮的行为与断言。

没有修改晋升门禁、所有者确认、Trial 隔离、canary、回滚、跨入口共享、宿主源码或正式数据。

## 5. 发现层的前后对照（真实生产库的只读副本）

命令：把 `~/.dsh/storages/evolution-experience/experience.sqlite` 复制到临时目录后，用同一份
`discover()` 记录分别调用改动前（`git show HEAD:lib/experience-plan.js`）与改动后的纯规划器。
适用版本按当前树 `0.2.16` / DSH `0.2.2-rc.5` / Cordis `4.1.0` 传入。

| 查询 | 改动前 | 改动后 |
| --- | --- | --- |
| 默认 top 5 | read, wait agent, 3 个 MCP 工具 | 同左，但 `tool read` 的损失带 `line-truncated` 3 / `output-capped` 2 的独立分解 |
| `focus: "run code"` | 无候选、无该目标的拒绝理由 | `tool run code` 167 次，`origin: unknown`，`excludedModes: ["invalid args"]` |

这说明发现层的断点不是「候选数量不够」，而是**一条无关的 caller-input 记录可以让整个工具作用域
的证据消失**，且不同损失只能以一个合并数字出现。

## 6. 第二个闭环（隔离真实宿主 + 真实模型）

本树打包（`dist/dsh-evolution-0.2.16.tgz`，sha256 `83840b172c6a2ca4f0b5df96c085f688e199cd176ec46b9cf99cb77f5dd822cc`），
隔离 runtime/home，真实官方 Desktop `0.2.2-rc.5` + ACP，模型
`opencode-go/deepseek-v4.1-flash`：

```sh
node scripts/acceptance/run-task-benefit-loop.mjs dist/dsh-evolution-0.2.16.tgz \
  docs/evidence/task-benefit-0.2.16-capped-tail-20261124.json --runs 3 --scenario capped \
  --work <isolated-temp-dir> --approve "<owner confirmation text>"
```

任务：用官方 `read` 从第一行读取三个各约 65 KiB 的文本文件，回答最后一行的 sentinel。每个文件的
首窗口在 50 KiB 处停止，sentinel 在约 8–14 KiB 的尾部。提示词不给出候选形态或 hook。

结果：`docs/evidence/task-benefit-0.2.16-capped-tail-20261124.json`，`ok: true`，八个阶段全部通过
（安装 → 配对真实会话 → 真实损失发现 → 四类负向证据被拒 → 等待所有者确认 → 带功能复验的 stable
→ fresh consumer 真实复用 → 重启后 `already-resolved`）。

| 侧 | 会话 | 正确 | 失败工具结果 | turns | tool calls | tokens | 墙钟 | `exercised` | 模型选择 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 3 | 3/3 | 0 | 21 | 18 | 1,405,625 | 173.6 s | 0 | 0 |
| candidate | 3 | 3/3 | 0 | 12 | 9 | 769,969 | 148.3 s | 3 | 0 |

差值：turns −42.9%、tool calls −50.0%、tokens −45.2%、墙钟 −14.6%，正确率与失败工具结果不变。
墙钟在这一轮受一个较慢的候选会话影响（75.7 s），前几轮同代码路径的墙钟降幅更大；不把单轮
耗时当作稳定收益。

规划器从 baseline 会话写出的 9 次 `output-capped`（累计恢复 9 次，记录工具 `read`）生成
`problemKey: "tool read"`、`improvement: "context-policy"`、`hook: "tools/post-execute"`、
`verificationKind: "paired-real-session"`、`benefitModel: {kind: "workflow"}` 与
`loss.breakdown`（`output-capped` 9 次）。晋升门禁的全部 9 项（含 `workflowBenefit` 与
`taskBenefit`）为 `true`；`runtimeRecovered` 在度量响应中为 `false` 是设计使然（dispose 后由
晋升再证明），durable 记录为 `runtimeRecovered: true`。

fresh consumer 在同一任务上 4 turns / 3 calls / 256,333 tokens / 29.9 s（usage unknown turns 0），三个 sentinel 全部正确，
且首次 `read` 结果已包含全部 sentinel。重启后 `evolution_plan` 选中 `null`，`tool read` 进入
`already-resolved`（`candidateCount: 0`）。四种负向证据分别以
`E_DESKTOP_TASK_EVIDENCE_MISSING`、`E_DESKTOP_TASK_EVIDENCE_MISMATCH`、`E_DESKTOP_BENEFIT_UNPROVEN`
（no-benefit）、`E_DESKTOP_BENEFIT_UNPROVEN`（unadopted）在所有者确认前被拒绝。

本次方向不是一次通过。三次运行的真实状态都保留：

| 运行 | 产物 | 结果 |
| --- | --- | --- |
| run1 | `...-run1-incomplete.json` | 候选侧 1 个失败的模型决策轮，artifact `complete: false`，producer 拒绝继续；无产品侧工具失败 |
| run2 | `...-run2-functional-check.json` | 发现、配对会话与 `taskBenefit` 通过；负向 `missing` 控制被 `E_DESKTOP_FUNCTIONAL_CHECK` 提前拦下，未走到证据检查 |
| run3 | 无（中止） | 候选预览会话表现与基线相同（7 turns / 6 calls，`exercised: false`）；确认 footer 形态判断仍是错的，停止并修正，不写 artifact |
| run4 | `...-run4-trial-check.json` | 配对会话完成，但 Trial 功能复验仍失败；同时暴露 pilot 用自己的工具读 fixture（一个 baseline 会话 1 turn / 0 calls / 99,109 tokens） |
| run5 | `...-run5-pilot-turn.json` | 候选侧 3/3 干净（13 turns / 10 calls / 844,592 tokens / 114.6 s，3/3 `exercised`）；baseline 3 有 2 个格式不合法的 pilot 回复，artifact `complete: false` |
| run6 | 无（中止） | producer 干净，但负向 `missing` 仍在 Trial 功能复验处失败 |
| run7–run9 | 临时诊断（未保存 artifact） | 定位到根因：动态包 Host half 在 `node:vm` 沙箱里没有 `Buffer`/`process`，候选的 `Buffer.byteLength` 让 hook 抛错并被 catch 吞掉，结果原样返回 |
| run10 | `...-run10-debug-source.json` | 闭环通过，但候选源码仍带临时诊断（写 `/tmp`），不能作为发布证据 |
| run11 | `...-run11-pre-review.json` | 干净候选源码（`e6b9d63e…`）的闭环；评审指出归因、首读判定、limit 边界与重试的 4 处问题，修复后重建 |
| run12 | `...-run12-pilot-turn.json` | 新的首读判定下 producer 仍出现单轮 pilot 失败，artifact incomplete |
| run13 | 无（中止） | 启动时已有更新的 lib，重建前停止 |
| run14 | `...-run14-pilot-turn.json` | 两侧各 1 个会话的 pilot 轮失败；评审同时指出首读登记顺序、usage 未知与结构调整，修复后重建 |
| run15 | `...-20261124.json` | 最终闭环（tarball `83840b17…`，候选 `2aa925db…`）；见下表 |

run1 的失败模型轮不是产品侧工具失败（`toolFailures: 0`），也不是收益结论；按 producer 的既有
契约，失败的模型轮不能被当成零成本或可忽略，因此只能整轮重跑，而不是在 harness 里重试或改写
该轮。

run2 暴露的是候选实现自身的问题，值得记录：`tools/post-execute` 看到的工具内容形态随宿主路径
不同——Trial 路径给它 **render 出来的原始内容**，预览/consumer 路径给它带 `<path>/<content>`
信封的形态。候选第一版把官方 footer 正则写成以 `\n</content>` 结尾，Trial 的功能复验永远不匹配，
Desktop 在读取任务证据之前就以 `E_DESKTOP_FUNCTIONAL_CHECK` 拒绝
（`state.functionalCheck.baseline` 为 `present:false`）。第一次修复只匹配裸 footer，run3 的
候选预览又以 7 turns / 6 calls、`exercised: false` 表现为基线，说明预览路径看到的是带信封的
形态。最终实现同时接受两种结尾；`test/capped-read-candidate.test.mjs` 用两种内容形态各跑一遍。
这也说明负向控制与功能复验的顺序有效：一个从未生效的策略不会因为任务证据缺失而被放过，它先被
功能复验拦下。

run2 的配对结果（该次 product 阶段未完成）：baseline 21 turns / 18 calls / 1,405,888 tokens /
207.6 s，candidate 9 turns / 6 calls / 605,886 tokens / 155.7 s，两侧 3/3 正确，`sessionsExercised: 2`。
第三个候选会话只用了 1 turn、0 次宿主工具调用就给出了正确答案（93,246 tokens）；它没有执行
被测机制，因此不计入“机制运行”。把这一异常会话从两侧各去掉一个后，保守子集仍是
candidate 8 turns / 6 calls / 512,640 tokens 对 baseline 14 turns / 12 calls / 936,887 tokens。

run4 把这两个问题都暴露了出来，并各修一处：

1. **Trial 的直接执行路径没有 renderer 内容。** 功能复验走 `ctx.tools.execute`，waterfall 可能
   收到没有 `content` 的结果；只靠 footer 判断会永远不触发。修复是在有**显式** `limit` 且窗口
   既未达到该行数、也未到 EOF 时，把「提前停止」作为字节上限的结构证据；没有 `limit` 时仍只信
   footer，避免放宽部署默认的行窗口。单测覆盖了「无 content + 显式 limit」这一路径。
2. **pilot 可以绕过宿主自己读 fixture。** 真实模型是被 `opencode run` 启动的 coding agent；
   它在被要求「不要调用工具」时仍可能用自己的 `read` 读隔离 home 里的文件，然后给出 0 次宿主
   调用的正确答案。这样的会话不是被测机制的收益。修复是 `startModelBridge` 的
   `isolatePilotTools`：在被测模型的工作目录写入只对该 `build` agent 生效的 `permissions:
   deny *` 项目配置，并显式 `--agent build`；同时解析 `opencode` 的 `tool_use` 事件，任何
   一次自有工具调用都把该轮标记为 `pilot-used-own-tools` 失败，而不是接受它的答案。宿主工具
   仍以文本 schema 出现在 prompt 里，因此「模型选择哪个宿主工具」这一被测变量不变。

run5 的候选侧已经 3/3 干净，但 baseline 3 有 2 个格式不合法的 pilot 回复，整个 artifact 因此
`complete: false`。pilot 的格式失败不是产品的工具失败；`startModelBridge` 现在对**同一个宿主
请求**做一次纠正性重试（追加一条「只输出一个 JSON 决策」的传输提示），并把两次尝试的 usage
相加、在 turn 上记录 `retries`。如果第二次仍失败，该轮仍是失败轮，会话仍然是 incomplete；这只
降低单次格式抖动的代价，不把失败改成成功。

run6 的 producer 已经干净，但 Trial 功能复验仍在 `E_DESKTOP_FUNCTIONAL_CHECK` 失败；run7–run9
用临时诊断（只记录布尔/计数，不记录文件内容）定位到根因：动态包的 Host half 由
`dsh-cordis-host-runner` 在 `node:vm` 沙箱中执行，沙箱刻意不提供 `Buffer` 与 `process`，只提供
`TextEncoder`/`TextDecoder`/`btoa`/`atob`。候选的尾字节预算用了 `Buffer.byteLength`，于是 hook
在 append 前抛出、被自身的 `try/catch` 吞掉，功能复验拿到原样结果。修复是用沙箱提供的
`TextEncoder` 计算 UTF-8 字节；`test/capped-read-candidate.test.mjs` 现在用 `new Function(body)()`
（不注入 Buffer）挂载候选，和生产沙箱保持一致。这是「安装成功不等于生效」的又一个真实例子，
也说明功能复验是必要的。


## 7. 边界

- `output-capped` 的收益只属于「尾部足够小」的读取；尾部超过 200 行或 16 KiB 时策略放弃，
  由模型按原有 `offset` 路径继续。生产默认上限仍是 50 KiB，策略不会把任意大文件读进上下文。
- 测得的 turns/tokens 来自真实模型账单，不是 DSH 原生计量；单任务结果不外推到所有读取场景。
- 首次读取的判定提升了对「机制运行」的要求；它只改变候选侧 adoption 的计算，不改变门禁阈值。
- 规划器仍不能自动判断某个已发布插件覆盖了哪个 loss kind；本轮只把每类损失的独立证据
  暴露出来，选择未覆盖 kind 仍需所有者/模型依据证据决定。这是下一轮的候选改进，不在本轮伪造。

## 8. 本轮复审后的收紧（未重跑真实模型闭环）

最终证据（run15）生成之后，独立复审又发现了几处「判定比证据弱」的问题。修复只改验收 harness、
候选 Host 源码与规划器，不改晋升门禁、既有证据或正式环境；本轮没有重跑真实模型闭环。

1. **首次读取必须按文件与调用身份绑定。** `task.reads` 按绝对路径绑定 token，`exercised`
   要求每个文件自己的首读包含自己的值。ACP 的 `title` 决定实际执行的工具，`rawInput` 决定
   参数，结果 `<path>` 决定读取的文件；按位置贴上的模型决策只在 `title` 一致时作为参数回退。
   结果路径与请求路径不一致、或调用数与工具决策数不一致时，该调用/会话不作机制证据。
   记录的 candidate 行有 3 次 read、每次 3 个完整文件结果（`readResultCharacters` 206,610，
   fixtures 合计 195,840，其余是宿主信封），与逐文件判定一致；但本轮没有重跑真实模型来重新
   生成 artifact，报告不把「新判定已在真实会话上重跑」写成已执行事实。
2. **多 step 的 usage 必须相加。** 实测一次 `opencode run` 的两个 `step_finish` 分别报告
   input 9,621/output 39/cache.read 512 与 input 89/output 7/cache.read 10,112；旧实现只保留
   最后一步。现在按 step 相加，任一 step 缺计费字段或整个 `tokens` 对象则该轮 unknown。该修复
   只影响后续运行的计量，不改写已记录的 artifact。
3. **capped 尾部不能越过不可证明的窗口。** 字节上限 footer 只说明本次窗口停在哪一行，不揭示
   宿主配置的 `readLimit`。现在没有显式 `limit` 时保留原结果，只有调用方声明了 `limit` 才在
   该窗口内补齐；capped 验收提示词明确请求 `limit=2000`，功能复验也使用显式 `limit`。
   候选源码因此变为 `4d4b5798…`；验收文件只有 700 行，run15 的旧候选哈希在
   `docs/evidence/` 中只是历史记录，不声称覆盖新源码，本轮也没有重跑真实模型来重建 artifact。
4. **追加行遵守官方单行上限。** 追加行超过官方默认的 2,000 字符时策略放弃变换，不再把完整
   长行塞进结果而绕过 renderer 的单行截断。
5. **自有工具调用不能被重试洗掉。** 整会话替换只接受结构化 allowlist 中的 pilot 传输失败，
   并要求宿主工具零失败；`pilot-used-own-tools`（包括先调用自有工具再非零退出的轮次）留在
   失败行，artifact 保持不完整。持久化的失败原因只保留固定原因码，未知异常投影为
   `pilot-transport-error`，不写入原始异常文本。
6. **混合失败的证据门槛与评分只算可处理失败。** 100 次 `invalid args` 不能再把 1 次
   `code run failure` 抬过 `minOccurrences`，也不再进入可处理目标的失败率、时效、回归、
   证据引用和故障模式宽度；caller-input 模式保留在 `excludedModes` 中。新的 caller-input
   失败也不会重开已经由可行动证据解决的目标。

另外把候选测试的挂载方式从 `new Function` 改成 `node:vm`（只注入
`TextEncoder`/`TextDecoder`/`btoa`/`atob`），这样再次出现 `Buffer`/`process` 依赖时测试会先
失败，而不是等到 Trial 才被功能复验拦下。以上修改都有对应单测，未重新运行真实 Desktop /
ACP 配对会话。
