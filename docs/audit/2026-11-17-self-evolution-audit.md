# DSH Evolution 端到端审计与优化（2026-11-17）

本文件记录一次基于真实仓库、真实宿主、真实执行记录与真实共享经验库的审计，
以及据此实施的最小改动与可复现验证。它只陈述本次实际读取和执行的内容。

- 审计对象：`ryukeilee/dsh-evolution` @ 分支 `t3/improve-evolution-workflow`（基线 `4abb8ca`）
- 宿主：DSH `0.2.2-rc.3` / Cordis `4.1.0` / Include `1.1.0` / Node `v24.21.0`；Evolution `0.2.10`
- 运行 profile：`acp`（另有 `web`、`desktop`、`headless` 的发布与消费记录可比对）
- 数据根：`$DSH_HOME/storages/evolution`、`$DSH_HOME/storages/evolution-experience`、`$DSH_HOME/sessions`

## 1. 结论摘要

1. **三个 stable 插件确实"正常运行"，但其中两个在设计上就不可能产生工作流收益。**
   `run_code_diagnose` 是纯算术换算器（输入是调用方自己填的 `occurrences`/`failures`），
   没有数据源；`run_code_preflight` 是人工前置检查工具，482 个会话 16,817 次工具结果中调用
   **0 次**，而且它的规则集只覆盖 19 个语法失败程序中的 9 个；`readonly_git_file` 是
   唯一被使用过的（5 次），它本质上是绕过宿主 composition guard 误杀的窄口子。
2. **`tool run code` 的高频"失败"不是一个仓库内可修的缺陷，而是四类不同事实被同一口径混合：**
   宿主 `dsh-composition-guard` 误杀（32/104，30.8%，**在仓库外**）、嵌套工具的正常失败
   （19）、提交前不可发现的语法错误（17，另有 1 条同形态）、以及 patch 冲突/超时/程序 bug
   （13/10/8）。本仓库的 guard 在重放同一批历史程序时也会误杀（18/34），若部署会复现同类问题。
3. **真正在仓库内的根因是"失败归因与问题发现"这条管道。** 共享经验库 23 条工具失败记录
   **全部** `failureMode = null`、只有一种 `semanticFact`；原因是采集器读 `result.code`，
   而宿主的失败码在 `result.error.info.code`。于是规划器看到的是"tool X 失败了 N 次"，
   既没有原因也没有分母（成功次数从未记录），任何确定性的新工具都能在自指的探针里"证明收益"。
4. **本次修复**：采集器读取真实失败码；规划器从语义事实还原失败模式，并**拒绝**没有任何
   失败模式/根因的裸工具计数；修正仓库 guard 的目标判定（去掉数据误杀、补上 bash/run_code
   转发到凭证目标的漏拦、按实际规则给出拒绝理由）。
5. **未修复且如实报告**：宿主 guard 的误杀（仓库外，不改宿主）、成功分母缺失、
   探针"能力存在即收益"的自指结构、三个 stable 插件的下线（需要所有者授权的外部写）。

## 2. 证据与方法

### 2.1 会话执行记录（只读）

```
docs/audit/replay/session-evidence.mjs   # 统计工具结果、错误分类、晋升工具调用次数
```

482 个会话日志（`~/.dsh/sessions/**/session.v4.jsonl.zstd`，全部 profile）：

| 指标 | 数值 |
| --- | --- |
| 工具结果 | 16,817（快照；当前会话仍在追加，重跑会小幅变化） |
| 失败结果（`message.isError` 或 `data.error`） | 336 |
| `run_code` 失败 / 总数 | **104 / 2,703（3.85%）** |
| `bash` 失败 / 总数 | 94 / 9,987（0.94%） |
| `run_code_preflight` 调用 | **0** |
| `run_code_diagnose` 调用 | **0** |
| `readonly_git_file` 调用 | 5 |

**口径问题（关键）**：`bash` 与 `run_code` 的失败次数只差 10，但分母相差 3.7 倍。
共享经验库只记录失败、不记录尝试，因此它看到的 `tool bash`（95）与 `tool run code`（97）
在数量级上无法区分；任何"按次数排序"的候选都会在两者之间摇摆，而真实失败率是 0.94% 与 3.85%。

### 2.2 `run_code` 失败分类（104 条）

```
docs/audit/replay/session-evidence.mjs 的 run_code error classes 输出
```

| 类别 | 数量 | 占比 | 是否仓库可修 |
| --- | --- | --- | --- |
| `dsh-composition-guard` 拦截 | 32 | 30.8% | 否：宿主内置守卫；本仓库 guard 未在该 profile 加载 |
| 嵌套工具正常失败（patch 不符、文件不存在、grep 参数等） | 19 | 18.3% | 否：任务本身的中间失败 |
| 程序语法错误（`Expected a semicolon`、`Unterminated regexp literal` 等） | 17 | 16.3% | 否：模型提交前即可避免；前置工具未被调用 |
| `Patch rejected before any change` | 13 | 12.5% | 否：编辑上下文漂移 |
| 执行超时（120,000 ms） | 10 | 9.6% | 部分：调用方应显式设置 `timeoutMs` |
| 程序运行时错误（TypeError/ReferenceError） | 8 | 7.7% | 否：程序 bug |
| 其他 / 非法输出 | 5 | 4.8% | 否 |

`dsh-composition-guard` 的 32 次拦截中，历史样本包含：临时 Chrome profile
（`--user-data-dir=/tmp/...`）、只读 SQLite 备份后的 `UPDATE credential`、`echo "=== secret scan ==="`、
`git ls-files cordis.patch.yml`、以及目标表达式里只出现 `cordis.patch.yml` 的测试文件写入。
它们都不是对 Cordis trust root 的修改。

**promoted preflight 的实际覆盖**（`docs/audit/replay/preflight-replay.mjs`）：
19 个语法形态失败程序中，按该插件的 6 条规则只会有 9 个被标记（47%）；其余 10 个是
通用解析错误（`Expected a semicolon`、`Expected ',', got ...`），不在其规则集内。

### 2.3 共享经验库（只读 SQLite）

```
sqlite3 ~/.dsh/storages/evolution-experience/experience.sqlite   "SELECT json_extract(body,'$.issueType'), count(*), sum(json_extract(body,'$.failureMode') IS NULL) FROM knowledge GROUP BY 1;"
```

| 事实 | 数量 | `failureMode` 为空 |
| --- | --- | --- |
| tool failure | 23 | **23** |
| experiment-conclusion | 5 | 5（结论本身用 strategy 承载） |
| agent failure | 2 | 2 |

失败事实的 `semanticFact` 只有一种取值：`official operation failure host operation failure`。
事件账本 304 条，`user_version = 1`（未迁移，符合"普通启动不迁移"的约定）。

### 2.4 晋升与发布事实

```
docs/audit/replay/ 之外的数据直接读取：
$DSH_HOME/storages/evolution/{promoted.cordis.yml,archive/experiments,execution-events.jsonl}
```

| 项 | 数值 |
| --- | --- |
| 事件日志 | 40 条：proposal 11、experiment-rejected 6、failure-learned 6、trial 5、measurement 4、promotion 3、canary 3、revert 2 |
| stable 插件 | 3（全部 `active`，源码摘要与宿主兼容性均可验证） |
| ACP consumer | 3/3 active |
| Web consumer | 1 active，2 `skipped-unapproved`（`profile-not-approved`） |

三个插件的实际形态（见 `$DSH_HOME/storages/evolution/promoted/*/lib/index.js`）：

1. `dsh-evolution-promoted-af973a3eea01`（exp-mwd39c0i-2-8da498be，2026-11-12）：
   `readonly_git_file`，经 `ctx.shell` 执行 `git -C <dir> show <rev>:<path>`。设计动机是
   绕过宿主 guard 对 `git show|grep` 的误杀；只读、正确，但只覆盖"按 revision 读文件"。
2. `dsh-evolution-promoted-e82a216992bb`（exp-mwe07k7f-4-d95e11ad，2026-11-12）：
   `run_code_diagnose`，把调用方提供的两个整数换算成 `failureRate` 与 `status`。
   它**不读取**共享经验库、不读取任何执行记录；调用方必须先知道计数才能调用它。
   `successRate` 与 `errorCount` 的"验收指标"因此与真实工作流无关。
3. `dsh-evolution-promoted-2794ab16d2b3`（exp-mwhq9zod-1-398ad801，2026-11-15）：
   `run_code_preflight`，对程序体做 6 条正则检查。它是人工前置工具，0 次调用；
   且规则集与最常见失败（通用语法错误）只重合 44%。

## 3. 第一性原理检查：闭环断在哪一环

| 环节 | 现状 | 断点 |
| --- | --- | --- |
| 问题发现 | 按工具名聚合失败次数 | 无分母、无原因；`tool bash`/`tool run code` 只差 2 次 |
| 根因分析 | 从失败文本人工推断 | 采集器只存 code，且读错字段 → 全部 `HOST_OPERATION_FAILED` |
| 候选生成 | 由问题名生成"补一个工具" | 问题名是工具名，不是缺陷；候选天然是"再包一层" |
| 隔离实验 | Trial + baseline/candidate 探针 | 探针的 target 步骤就是候选自己的工具（baseline 中必然缺失），
"收益"由构造保证 |
| 效果评估 | `successRate`/`errorCount` + `probeControlStable` | 指标测的是候选工具自身，不是被声称修复的工作流问题 |
| 安全晋升 | 8 项门禁 + 显式确认 + canary + 回滚 | **保持有效**，本次未改动门禁语义 |
| 自动复用 | promoted-consumer 按 profile 挂载 | **有效**：ACP 3/3、Web 1/1；但挂载的是"需要模型主动调用"的工具 |
| 持续反馈 | 结论写回共享经验、`already-resolved`/版本比对 | 结论的 target 是工具名，无法表达"这类失败已解决" |

因此：安全性没有被破坏，破坏的是**输入信号**与**收益定义**。这解释了两个零收益插件为何
能通过全部 8 项门禁：门禁证明"工具存在且确定"，而问题从来没有被证明过。

## 4. 本次改动

### 4.1 `lib/guard.js`：目标判定精确化（安全 + 误杀）

改动点：

- 把"凭证/密钥/`user-data`"这类**名词**从不可逆**操作**正则移到不可逆**目标**正则
  （`IRREVERSIBLE_PATH_RE`，新增 `secrets?`、`user[-_ ]?data`）。
  `--user-data-dir=/tmp/x`、`echo "=== secret scan ==="`、临时库上的 `UPDATE credential`
  不再被当成不可逆操作。
- 目标判定统一为 `targetMutationVerdict`：trust root → `cordis`，凭证/密钥/`.env` 目标
  → `irreversible`。**bash、重定向、`run_code` 里的工具调用与 fs 写入 API 现在都走同一判定**：
  旧实现只检查 `edit`/`write`，`rm -rf ~/.env`、`echo x > ~/.env`、
  `tools.write({file_path:'/tmp/.env'})` 都能绕过。
- 动态目标只在**目标表达式本身**命中 trust root 时拦截（`dynamicTargetIsSuspicious`
  改用 `touchesProtectedSurface`），不再因为目标里出现 `cordis` 字样就拒绝
  ——本仓库自己的 `cordis.patch.yml` 就属于这一类。
- 未解析目标的保守回退只测试**目标表达式**，不再扫描整条命令正文（注释早已如此声明）。
- 拒绝理由按实际命中的规则返回：trust root 用"直接修改 Cordis trust root"，
  不可逆操作/目标用"凭证/API key/Keychain/.env 等不可逆风险目标"。

**前后对照**（`docs/audit/replay/guard-replay.mjs`，重放 40 个历史被宿主 guard 拒绝的唯一程序，
含本次审计会话；排除它时是 34 个，结论相同）：

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| 仓库 guard 会拒绝的历史程序 | 18 / 40 | **7 / 40** |
| 误杀类别（数据里的 `secret`/`user-data`/`credential`、`cordis.patch.yml` 动态目标） | 存在 | 消除 |
| `rm -rf ~/.env` / `echo x > ~/.env` / `tools.write({file_path:'/tmp/.env'})` | 允许（漏拦） | 拒绝 |
| `git reset --hard` 链、`release:publish` 链 | 拒绝 | 拒绝（不变） |

剩余 7 个拒绝中，3 个是刻意的不可逆操作（`git reset --hard`、`release:publish`、
amend/rebuild 链），4 个是"程序写在字符串里的测试内容包含对 Cordis 路径的 `writeFileSync`"
——静态分析不区分代码与字符串内容，这是已知限制（见 §7）。

### 4.2 `lib/experience-collector.js`：读取真实失败码

宿主的 `ToolFailure` 是 `{ message, info?: { name, code, reason? } }`；
旧代码读 `result.code`，恒为 `undefined`，于是 `failureCode()` 一律回退为
`HOST_OPERATION_FAILED`。现在改为 `toolFailureCode()`：

```js
result?.error?.info?.code ?? result?.error?.code ?? result?.code
```

仍然只读标识符，不读消息、参数或正文。会话日志里可观测到的真实码包括
`CODE_RUN_FAILED`、`FS_PATCH_MISMATCH`、`INVALID_ARGS`、`FS_NOT_FOUND`、
`TEAM_INVALID_WRITE_SCOPE` 等（336 次失败中 143 次带码，42.9%）。

**没有改变存储身份**：`recordFailure` 的事件形状保持原样（不新增 `failureMode` 字段），
因为 schema 1 冻结 opener 必须与新版本对同一事件算出同一个 `knowledgeKey`
（`test/shared-experience-v2-verification.test.mjs` 钉住）。代码只能通过
它本来就产生的那条 `semanticFact`（`official operation failure code run failure`）进入存储。

### 4.3 `lib/experience-plan.js`：把归因变成候选的前置条件

- 新增 `derivedFailureMode()`：从 `semanticFact` 的 `official operation failure <detail>`
  还原失败模式；通用占位符 `host operation failure` 不算模式。
- 结论（conclusion）的 `failureMode`/`rootCause` 也进入分组的归因集合
  （此前只看失败行，导致只有结论的目标被误判为"无归因"）。
- 候选新增 `attribution: "classified" | "unattributed"`。
- **裸工具计数不再生成候选**：`^tool[ :]` 目标且既无失败模式也无根因时，
  以 `reason: "unattributed"` 显式拒绝，而不是继续产出"补一个工具"的实验。

这条规则的直接效果：在当前真实经验库（23 条全部无模式）上，`tool run code` 不再是
`experience-candidate`；在采集器记录了真实码之后，目标重新以具体模式进入候选。

## 5. 验证

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 全量单测 | `NODE_OPTIONS=--max-old-space-size=4096 npm test` | 1,835 项：1,832 通过、2 skipped、**1 失败**——`release-pin` 的"工作树未提交"，属预期（提交后复验） |
| guard 回归 | `node --test test/guard-*.test.mjs test/security-regression.test.mjs` | 34/34 通过 |
| 归因回归 | `node --test test/experience-attribution.test.mjs` | 通过 |
| 经验身份兼容 | `node --test test/shared-experience-v2-verification.test.mjs test/shared-experience.test.mjs` | 通过（冻结 v1 opener 身份不变） |
| 历史重放 | `docs/audit/replay/guard-replay.mjs` | 40 个历史程序：18 → 7 |
| preflight 覆盖 | `docs/audit/replay/preflight-replay.mjs` | 19 个语法程序：9 个会被标记 |

## 6. 修复后工作流仍存在的问题（如实报告）

1. **宿主 composition guard 的误杀仍在生产发生。** 它不在本仓库内，本任务不改宿主。
   本次只保证本仓库的 guard 不会复现同类误杀，并把误杀从"无法归因的 `tool run code` 失败"
   变成带真实码的可归因事实。
2. **成功分母缺失。** 共享经验库只记录失败；`successRate = 0` 是记录口径的产物，不是真实成功率。
   修复需要一条有界的成功/尝试计数通道（本次未做，避免在未验证写放大前改动存储）。
3. **探针收益自指。** `compareProbeRuns` 的"改进"是候选目标步骤在 baseline 中缺失、
   在 candidate 中成功；`after.errors < before.errors` 也由构造保证。任何确定性只读工具
   都能通过。要真正关联工作流收益，需要让探针的 target 是**既有工作流步骤**，
   而不是候选自己的工具；这需要同时改 Desktop 侧的 plan 契约，本次未做。
4. **两个零收益 stable 插件仍在 ACP/Web 挂载。** 下线是外部写（profile + 发布记录 + 重启），
   需要所有者明确授权；建议用 `dsh-evolution-shared disable` 关闭
   `run_code_diagnose` 与 `run_code_preflight`，保留 `readonly_git_file`。
5. **静态分析不区分代码与字符串内容。** 写入"内容里含有对 Cordis 路径 `writeFileSync` 的测试文件"
   仍可能被仓库 guard 拒绝；需要 JS 解析器才能根治，已知限制。
6. **共享经验库仍是 schema 1。** 迁移是显式离线操作（`npm run` 之外的 CLI），本次未执行。

## 7. 复现

```sh
# 单测（仓库根）
NODE_OPTIONS=--max-old-space-size=4096 npm test

# 历史执行记录统计（只读；需要 ~/.dsh/sessions）
node docs/audit/replay/session-evidence.mjs

# guard 前后对照（基线取自父提交）
git show HEAD~1:lib/guard.js > /tmp/guard-before.mjs
node docs/audit/replay/guard-replay.mjs /tmp/guard-before.mjs

# promoted preflight 覆盖率
node docs/audit/replay/preflight-replay.mjs
```

以上脚本只读取本机 `~/.dsh` 下的会话日志，输出计数与分类，不打印会话正文。
