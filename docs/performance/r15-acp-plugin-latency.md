# ACP 会话启动与工具调用后的插件延迟（R15）

受理标识：**DSH-EVOLUTION-PERF-R15-01**。本文只记录本机实际执行的测量与判定，
不是宿主发布验收。被测插件版本 `0.2.22`，由基线提交 `4a846b5` 打包
（tarball `a638cf28…`）；本分支只新增基准脚本与本文，`lib/`、`package.json`、
`cordis.patch.yml` 与基线逐字节未变。

## 0. 结论

| 项 | 判定阈值 | 实测 | 结论 |
| --- | ---: | ---: | --- |
| A. ACP 会话启动（`spawn → session/new`） | ≥ 200 ms | 配对中位 **+20.20 ms**（p25 18.27 / p75 24.88；A/A −2.96；9/9 同向） | **NO CHANGE** |
| A′. 同上，home 含 5 条已发布记录 | ≥ 200 ms | 配对中位 **+20.57 ms**（p25 16.67 / p75 30.88；A/A −1.28；9/9 同向） | **NO CHANGE** |
| B. 失败工具调用后的同步提交 | ≥ 50 ms | **p50 0.231 / p95 0.417 / p99 0.459 ms** | **NO CHANGE** |
| B′. 干净成功工具调用 | ≥ 50 ms | p50 0.0045 / p95 0.0086 ms（零写库，含正向控制） | **NO CHANGE** |
| B″. 真实 ACP 整轮（含一次失败提交） | ≥ 50 ms | 配对中位 **−3.95 ms**（4 正 5 负；A/A 绝对差中位 5.02） | **NO CHANGE** |

- 两处阈值都未达到，本轮**没有修改 `lib/`**，也没有为改而改。
- 可复跑脚本：[acp-startup-latency.mjs](../../scripts/benchmarks/acp-startup-latency.mjs)、
  [experience-commit-latency.mjs](../../scripts/benchmarks/experience-commit-latency.mjs)。
- 原始数据：[r15-acp-startup-latency.json](r15-acp-startup-latency.json)、
  [r15-acp-startup-latency-records5.json](r15-acp-startup-latency-records5.json)、
  [r15-experience-commit-latency.json](r15-experience-commit-latency.json)。

## 1. 口径

- 环境：Node `v26.13.1`、darwin-arm64。最终数据在机器静默时**串行**执行。
- 宿主：隔离安装的官方 `@deepseek-ai/dsh@0.2.2-rc.5`
  （`@deepseek-ai/cordis@4.1.0`、`cordis-plugin-include@1.1.0`）。
- home：隔离的 `$DSH_HOME`，acp profile 按真实安装形态配置——
  `evolution-experience` 开、`evolution-experience-history` 开、
  `evolution-orchestrator` 关、`evolution-promoted-consumer` 开、
  `evolution-desktop-task-host` 关、`evolution-desktop-task-client` 开、
  `hmr` 关。
- 隔离校验（两个脚本都在**任何写入、扫描或执行之前**进行，失败即非零退出）：
  - `--home`、`--runtime`、`--out` 在参数解析时**不做**字面归一化；原始字符串
    直接交给 realpath 语义的组件解析器（符号链接目标插入待处理队列、`..`
    从已解析输出弹出、`.` 跳过、缺失尾部保留、40 跳上限与环检测），之后
    **校验与使用都用同一个解析结果**。链接之后的 `..` 按文件系统真实语义
    判定。
  - 正式 DSH_HOME 来自「先解析 `os.homedir()`、再在其结果上拼 `.dsh` 并
    二次解析」，因此 `HOME` 自身带链接或 `..` 时保护的是真实目录。
  - 受保护关系按**文件系统身份**（`dev:ino`，逐级祖先比较）判定，不依赖
    路径拼写；字符串前缀只作快速路径。大小写别名（`.dsh` vs `.DSH`）不会
    被当成两个目录。
  - 源 home 在任何读取或复制之前做整树 preflight（`withFileTypes` + `lstat`，
    不跟随）：每个普通文件必须 `nlink === 1`（硬链接可能指向受保护文件），
    每个符号链接必须 `realpath` 成功且落在根内。本轮两份基准都检查
    1006 个文件、0 个硬链接、5 个链接、0 逃逸。
  - **所有目录枚举**（`.pnpm` 顶层、`.pnpm/<entry>/node_modules`、作用域
    目录、探针包装配、home 与副本扫描）都走同一个 `safeReaddir`：先解析、
    按身份拒绝受保护目录、限制在允许根内，然后**只用 resolved 枚举**；包
    目录在加入探针 `node_modules` 之前也逐个解析校验（启动 3811 次、提交
    3676 次枚举，0 次拒绝）。
  - `--runtime` 与**每一个会被读取或执行**的文件（CLI、dsh/cordis/include 的
    `package.json`、cordis entry、`.pnpm` 目录）在读取/枚举/执行前解析并校验：
    拒绝落在正式 home 或源 home 内、要求位于解析后的 runtime 内、文件
    `nlink === 1`。
  - `TMPDIR` 解析后**只用解析结果**创建 scratch；创建后按身份复查。每个子
    进程（ACP 宿主与归因探针）都显式把 `TMPDIR`/`TEMP`/`TMP` 设为已校验的
    scratch 子目录，宿主类子进程另把 `HOME` 设为其 home 副本；缺失文件路径
    也只用 scratch 构造。
  - `--out` 的每一段路径都逐组件解析；解析后若文件已存在，要求普通文件且
    `nlink === 1`；不得落在正式 home 或源 home 内（仓库内允许，本文与证据
    就写在 `docs/performance/`），报告写入解析后的同一路径。
  - 负向夹具（模拟正式 `~/.dsh`，全部以退出码 1 拒绝）：`HOME` 自身带
    `hop/..` 且 `--out` 指向真实 `.dsh`、链接后 `..` 指向 `.dsh` 的 `--out`、
    `TMPDIR` 的 `.DSH`/`hop/..` 变体、经中间链接与 `..` 指向真实目标的
    `$HOME/.dsh`、仓库内 `--home`、受保护目录内的 `--runtime`、硬链接 CLI、
    软链接 dsh/cordis/include manifest、顶层与子目录 `.pnpm` 软链、源 home
    硬链接文件、源 home 悬空链接、硬链接与三种悬空 `--out`。受保护目录无
    残留、mtime 不变；哨兵内容与 dev/ino 不变；假 CLI 未被读取或执行；
    受保护目录**一次都没有被枚举**（`readdirSync` 跟踪器确认）。
- 模型与网络：ACP 进程通过 `--patch` 装入回环确定性 Anthropic provider。
  provider 在**请求到达时立即**登记时间戳（读完 body 后再回填字节数与工具
  数量），因此「头在窗口内到达、体在窗口后完成」的慢请求不会漏计。启动基准
  以 `session/new` 完成时刻为界，断言整个 `[spawn, session/new]` 区间内到达的
  请求数为 0，并另外断言计时结束后的非计时 `session/prompt` 至少产生 1 个
  请求。启动样本中没有模型/网络成本。工具调用基准的整轮区间包含本机 IPC 与
  宿主调度，但不含真实模型推理（没有外部模型调用、没有凭据）。
- A/A 噪声底：每一轮除了 `on` / `off` 还跑一份与 `on` 完全相同的独立副本
  `on2`。`on−on2` 是噪声，用来判断 `on−off` 是否可复现。

## 2. A. ACP 会话启动

### 2.1 方法

- 三臂：`on`（bundle 在 `dsh.profile.bundles` 中）、`off`（同一份副本只把
  `dsh-evolution` 从 bundles 移除，包仍安装，因此只消失本插件自己的启动
  工作）、`on2`（与 `on` 相同的第二份副本）。
- 每轮三臂各自从 pristine home 复制全新副本，复制时间不计时；臂顺序按
  `on→off→on2 / off→on2→on / on2→on→off` 轮换；每臂先预热一次，正式 9 轮。
- 指标是父进程 `performance.now()`：`spawn` → `initialize` 响应、
  `spawn` → `session/new` 完成（可接受输入）。判定用后者。
- 每臂失败即非零退出；脚本断言 `initialize`/`session/new`/`prompt` 成功、
  各副本 bundle 选中状态与预期一致、计时窗内零请求（按到达时间戳）、计时后
  至少一个请求。

### 2.2 结果

三臂 `spawn → session/new`（9 轮，ms）：

| 臂 | 中位数 | p25 / p75 |
| --- | ---: | --- |
| `on` | 759.48 | 755.54 / 759.96 |
| `on2`（A/A） | 762.90 | 759.20 / 768.26 |
| `off` | 737.62 | 736.04 / 740.34 |

逐轮配对差（ms）：

| 轮 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 中位数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `on−off` | 17.20 | 20.20 | 24.88 | 29.20 | 19.23 | 8.59 | 18.27 | 26.75 | 23.62 | **20.20** |
| `on2−off` | 13.19 | 23.16 | 37.60 | 32.62 | 20.17 | 23.90 | 16.94 | 43.43 | 22.60 | **23.16** |
| `on−on2`（A/A） | 4.01 | −2.96 | −12.72 | −3.42 | −0.94 | −15.31 | 1.33 | −16.68 | 1.02 | **−2.96** |

- `spawn → initialize` 的 `on−off` 中位 **12.04 ms**（p25 9.05 / p75 13.84），
  9 轮全为正。
- `session/new` 的插件增量中位 **20.20 ms**，9/9 为正，A/A 中位 −2.96 ms，
  远低于 200 ms 阈值。
- home 含 5 条已发布记录的权威测量：`on−off` 中位 **20.57 ms**
  （p25 16.67 / p75 30.88；逐轮 20.20 / 25.34 / 44.03 / 11.11 / 12.79 /
  42.41 / 16.67 / 20.57 / 30.88，9/9 为正），A/A 中位 −1.28 ms（其中一轮
  `on2` 出现约 280 ms 的单臂离群，见原始 JSON）。同样 NO CHANGE。

### 2.3 归因（独立探针，**不是**总增量的拆账）

| 探针 | 测量边界 | 中位数（5 轮） |
| --- | --- | ---: |
| 模块加载（ACP 入口集） | 新进程 import `experience-collector` / `experience-history` / `promoted-consumer` / `guard` / `desktop-task-client`；断言导出 `apply()` | 20.15 ms / 663,546 B / 35 模块 |
| 模块加载（Web 入口集） | 同上，无 `desktop-task-client` | 17.09 ms / 469,811 B / 27 模块 |
| `openSharedExperience()` | 全新 root（建 schema）/ 已初始化 root | 1.91 ms / 0.48 ms |
| `published.json` 读取 | `readSharedIndex`，0 / 5 / 50 条 | 0.71 / 1.10 / 2.26 ms |
| 逐记录源码校验 | `validateSharedRecord` + `readPromotedPlugin`（读 entry 与 manifest、SHA-256）+ host/capability 判定 | 0 / 1.67 / 7.69 ms（0 条为 0） |

- 这些探针各自只测自己声明的那一步：模块探针不含 host composition 与插件
  `apply()`；store 探针不含 collector 订阅与工具注册；index 探针不含 Include
  挂载与被挂载插件的 `apply()`。因此**不能把 20.15 ms 说成 20.20 ms 总增量中
  的某个比例**，也不能把各探针相加当作总成本；它们只说明各项量级。
- 模块探针导入的是已安装 bundle `lib/` 的逐字节副本，`node_modules` 从宿主
  pnpm store 与 profile 顶层的已解析包重组；它与
  [R13](session-startup-and-experience-growth-20261117.md) 的
  `11.98 ms / 456,178 B / 25 模块` 不是同一套 harness（模块集、依赖布局、
  宿主版本都不同），只能作对照，不能相减。
- 「安装后首次启动」单列：把副本里的 `sessions/`、`storages/session_projcache/`、
  `storages/evolution-experience/`、`logs/`、`storages/evolution/shared-plugins/consumers/`
  与 `storages/evolution/shared-plugins/.publish.lock.sqlite` 移除后测 2 对
  配对，`on−off` 中位 **32.72 ms**（p25 30.62 / p75 34.82；5 条记录的副本为
  18.21 ms）。只有 2 对样本，只说明本机没有出现明显的一次性惩罚，不进入
  稳态判定。

## 3. B. 每次工具调用后的同步提交

### 3.1 真实写库边界（先读实现）

`lib/experience-collector.js` 的 `tools/result` listener 同步执行，但**不是每次
工具调用都写库**：

| 结果 | 是否写库 | 时机 |
| --- | --- | --- |
| 普通成功（`read` 完整返回） | 否 | 只更新内存计数器 |
| 失败（`result.isError === true`） | 是，1 个 `COMMIT` | 在 `tools/result` listener 内同步完成 |
| 非报错退化（行截断 / 输出封顶） | 是，1 个 `COMMIT` | 先挂起，随后在以下任一时刻结算：`tools/result` 里的同路径成功重读或 `bash`/`grep` 成功恢复、取消结果导致的轮末 flush、pending 超过每 agent/全局上限时的 flush；以及 `agent/turn-stopping` / `agent/disposed` / `agent/error` |
| 失败后连续第 5 次干净成功（恢复） | 是，1 个 `COMMIT` | 在 `tools/result` listener 内同步完成 |

官方 emit 不 await listener，所以 listener 的同步耗时就是它对宿主事件循环、
也就是对该轮回复的阻塞量。写库走 `lib/shared-experience.js` 的
`BEGIN IMMEDIATE` / `COMMIT`，`PRAGMA synchronous=FULL` + WAL，没有为性能
去掉 fsync 或放宽 WAL。

### 3.2 进程内分布（主证据）

真实 `new Context()` + 安装包里的真实 collector `apply()`，用真实 store 驱动
`ctx.emit('tools/result', …)` 与 `ctx.emit('agent/turn-stopping', …)`；每个样本
都要通过 `store.stats()` 增量断言才计入。harness 实测解析到被测宿主的
`@deepseek-ai/cordis@4.1.0` 与
`profiles/acp/node_modules/dsh-evolution/lib/experience-collector.js`
（bundle `0.2.22`，collector SHA-256 `1c6127c1…`），没有 fallback。

| 场景（50 samples） | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: |
| 失败 → `tools/result` 内同步提交（首个提交，含惰性语句编译） | 2.388 | 2.388 | 2.388 | 2.388 |
| 失败 → 稳态提交（49 samples） | **0.231** | **0.417** | **0.459** | 0.459 |
| 干净成功（零写库） | 0.0045 | 0.0086 | 0.0881 | 0.0881 |
| 退化：`tools/result` 只挂起 | 0.0078 | 0.0197 | 0.0399 | 0.0399 |
| 退化：`agent/turn-stopping` 单独计时（首个提交） | 0.383 | — | — | — |
| 退化：`agent/turn-stopping` 单独计时（49 samples） | 0.189 | 0.294 | 0.374 | 0.374 |
| 恢复（失败后第 5 次干净成功） | 0.218 | — | — | — |

- 干净成功批次有正向控制：批次前后各发一次已知失败 emit，必须各提交恰好
  1 个事件；两次都通过（`cleanPositiveControl: true`），证明同一个已挂载
  listener 确实在写，干净路径的「零写库」不是空 listener 造成的假象。
- 恢复样本已验证（`recoveryVerified: true`）；ACP 三臂事件增量为
  精确 1 / 0 / 1（`acpDeltaExact: true`）。
- 退化样本是无后续工具调用的夹具，因此提交确实落在 `turn-stopping`；表里
  已把 `tools/result` emit 与 `turn-stopping` emit 分开计时，不再混在一起。
- 首个提交 2.388 ms 包含 SQL 语句的惰性准备；从第二个提交起是稳态。
- 归因对照（同一事务形状的独立数据库，`FULL` vs `NORMAL`）：p50 0.081 vs
  0.041 ms，差 0.041 ms。两者都是亚毫秒，**NORMAL 削弱耐久性、不是候选方案**，
  该对照只说明 fsync 成本的量级。

### 3.3 真实 ACP 端到端 A/B（确认）

- 每轮 prompt 让模型发起一次 `read` 缺失文件（真实失败、一次真实提交），然后
  `end_turn`。三臂 `enabled`（真实安装形态）/ `disabled`（只把
  `evolution-experience` 与 `evolution-experience-history` 两行置为
  `disabled: true`）/ `enabled2`（A/A）。9 轮、臂顺序轮换、每轮全新副本。
- 每个样本都断言：2 次 provider 请求、观察到 `failed` 工具调用、`end_turn`；
  `enabled`/`enabled2` 的 store 事件增量必须**恰好为 1**、`disabled` 必须为 0；
  缺失文件路径解析后不在受保护目录。9 轮全部有效，无效样本 0。

两个区间（ms）：

| 区间 | `enabled` | `disabled` | `enabled2` | `disabled−enabled`（中位 / 绝对差中位 / 方向） | A/A（中位 / 绝对差中位 / 方向） |
| --- | ---: | ---: | ---: | ---: | ---: |
| 窄区间：父进程观测到 `tool_call_update(failed)` → 下一 provider 请求到达 | 12.327 | 12.021 | 13.351 | +0.298 / 1.337 / 5+ 4− | +0.374 / 0.974 / 6+ 3− |
| 整轮：`session/prompt` 请求 → 该轮响应 | 74.073 | 72.637 | 73.047 | **−3.950 / 4.005 / 4+ 5−** | +1.060 / 5.022 / 5+ 4− |

- 窄区间只是两个父进程观测点之间的距离：如果宿主在发布 `tool_call_update`
  之前就调用了 collector，这个区间不覆盖那次提交。它的方向不一致
  （5 正 4 负），因此只用来说明量级。
- 整轮区间无条件覆盖本轮任意位置发生的同步提交：宿主在工具管线返回前同步
  调用 collector，ACP 在本轮完成后才返回 prompt 响应。
- 整轮逐轮配对：+3.528 / −13.902 / −7.778 / −3.950 / +4.562 / −7.164 /
  +0.165 / −4.005 / +2.743 ms；有符号中位 **−3.950 ms**，方向混合
  （4 正 5 负），绝对差中位 4.005 ms；A/A 的中位仅 +1.060 ms，但逐轮绝对差
  中位 5.022 ms。也就是说，**本机的整轮差异落在噪声量级里，不能证明存在
  正向的 collector 开销**；9 轮全部低于 50 ms。
- commit 本身（进程内）只有 0.231 ms，因此即便把这 3.95 ms 全部当作真实差异，
  也不能归因到提交本身；它包含整轮内 collector 相关的一切（订阅、分类、一次
  提交、若干事件分发），本轮没有把各项拆开。

## 4. 为什么两项都 NO CHANGE

- A 的实测增量是 20.20 ms（5 条记录 20.57 ms）。独立探针显示模块加载
  20.15 ms、store 热打开 0.48 ms、index 读取与逐记录校验（5 条）约 2.8 ms；
  这些探针的边界互不重叠，**不能相加**，也不能据此说模块加载占了总增量的
  某个比例。要跨过 200 ms 阈值，需要这里出现一个数量级更大的项，本机没有
  观察到。把模块改成惰性加载最多只能省下十几到二十毫秒，却会把首次使用时
  的失败窗口引入数据写入路径，按本项目「微小收益不作主要成果」的判据不实施。
- B 的写路径只有失败、恢复边界与（延后结算的）退化会写库，普通成功为零；
  失败提交稳态 p95 0.417 ms。真实 ACP 整轮里启用 collector 的配对中位差异是
  −3.95 ms，方向混合且绝对差与 A/A 噪声同阶；无论取哪个方向，都远低于
  50 ms 阈值。因此没有修改提交语义、WAL 或 fsync 的动机。

## 5. 边界与未测

- **Desktop profile 没有在本轮测量**：用户日常的 Desktop 形态启用
  `evolution-orchestrator`（kernel），它有另外两条每轮路径——`agent/pre-step`
  里的 `domainStorage.flush()` 与失败时的 `tools/result` 自主观察者。这不属于
  本轮 A/B 的定义范围（B 只测 experience collector），因此不能把本文数字当作
  Desktop 全链路延迟的结论。ACP profile 关闭 kernel，正是为了把 collector 的
  成本单独隔离出来。
- 整轮 −3.95 ms 的机制没有拆到单项：commit 本身是 0.231 ms，其余部分（事件
  分发、分类、宿主侧差异）本轮没有单独探针；该轮差异方向混合，本机不能把它
  读成 collector 的正向开销。
- 没有测冷页缓存（样本共享系统缓存的热状态）、冷盘、真实模型推理与网络等待、
  多进程并发写同一经验库、或其它平台。
- 首次启动的 2 对样本只作旁证；home 的「首次」是脚本按显式移除清单合成的，
  不是真实新安装的时间线。
- A 的 home 没有真实用户发布记录；5 条与 50 条是按
  `validateSharedRecord` / `readPromotedPlugin` 契约构造的确定性夹具，用于规模
  归因，不代表真实 promoted 插件的 `apply()` 成本（那部分在 Include 挂载内，
  未单独拆解）。
- 模块加载数字来自已安装 bundle 的字节副本与重组依赖布局，不能与 R13 的历史
  数字逐项相减；两者只作对照。

## 6. 复跑

```sh
# 0) 从仓库根执行本段，先定义变量（不要指向正式安装环境）
REPO=$(pwd)
BASE=/path/to/isolated-base
mkdir -p "$BASE"

# 1) 隔离 runtime（在子 shell 里安装，不改变当前目录）
mkdir -p "$BASE/runtime"
(
  cd "$BASE/runtime"
  printf '%s\n' '{"name":"r15-runtime","private":true,"type":"module","dependencies":{"@deepseek-ai/dsh":"0.2.2-rc.5"}}' > package.json
  pnpm install --config.strict-dep-builds=false
)

# 2) 用本树打包（仍在仓库根）
npm run release:pack    # 产出 dist/dsh-evolution-0.2.22.tgz

# 3) 只对 acp profile 做官方安装。desktop profile 由 Electron 独占，
#    `setup-experience.mjs` 会在 desktop 处停下，所以这里不用它。
DSH_HOME="$BASE/home" "$BASE/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile acp add "$REPO/dist/dsh-evolution-0.2.22.tgz"

# 4) 写入该 profile 的托管 patch 块（与 setup-experience 的 acp 行一致）
DSH_HOME="$BASE/home" node --input-type=module -e "
import fs from 'node:fs';
import { managedPatch } from './scripts/setup-experience.mjs';
const f = process.env.DSH_HOME + '/profiles/acp/cordis.patch.yml';
fs.writeFileSync(f, managedPatch(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '', 'acp'));
"

# 5) 权威测量（0 条与 5 条已发布记录各一轮，再跑提交基准）
node --max-old-space-size=4096 scripts/benchmarks/acp-startup-latency.mjs \
  --runtime "$BASE/runtime" --home "$BASE/home" --rounds 9 --records 0 \
  --out docs/performance/r15-acp-startup-latency.json
node --max-old-space-size=4096 scripts/benchmarks/acp-startup-latency.mjs \
  --runtime "$BASE/runtime" --home "$BASE/home" --rounds 9 --records 5 \
  --out docs/performance/r15-acp-startup-latency-records5.json
node --max-old-space-size=4096 scripts/benchmarks/experience-commit-latency.mjs \
  --home "$BASE/home" --runtime "$BASE/runtime" --rounds 9 --samples 50 \
  --out docs/performance/r15-experience-commit-latency.json
```

两个脚本都拒绝正式 `~/.dsh` 与仓库内的 home；用户路径先解析、校验与使用同一
结果；源 home 使用前做 `nlink === 1` 整树 preflight；每一处目录枚举都经过
`safeReaddir`；`--runtime` 内被读取或执行的文件与 `.pnpm` 目录都在使用前校验；
`--out` 拒绝已有硬链接；`--smoke` 只跑 2 轮并标注 non-authoritative，不能替代
权威跑。
