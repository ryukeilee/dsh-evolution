# ACP 会话启动与工具调用后的插件延迟（R15）

受理标识：**DSH-EVOLUTION-PERF-R15-01**。本文只记录本机实际执行的测量与判定，
不是宿主发布验收。被测插件版本 `0.2.22`，由基线提交 `4a846b5` 打包
（tarball `a638cf28…`）；本分支只新增基准脚本与本文，`lib/`、`package.json`、
`cordis.patch.yml` 与基线逐字节未变。

## 0. 结论

| 项 | 判定阈值 | 实测 | 结论 |
| --- | ---: | ---: | --- |
| A. ACP 会话启动（`spawn → session/new`） | ≥ 200 ms | 配对中位 **+20.98 ms**（p25 20.57 / p75 22.59；A/A −3.92；9/9 同向） | **NO CHANGE** |
| A′. 同上，home 含 5 条已发布记录 | ≥ 200 ms | 配对中位 **+25.76 ms**（p25 21.97 / p75 33.34；A/A +2.70） | **NO CHANGE** |
| B. 失败工具调用后的同步提交 | ≥ 50 ms | **p50 0.249 / p95 0.448 / p99 0.547 ms** | **NO CHANGE** |
| B′. 干净成功工具调用 | ≥ 50 ms | p50 0.0047 / p95 0.0084 ms（零写库，含正向控制） | **NO CHANGE** |
| B″. 真实 ACP 整轮（含一次失败提交） | ≥ 50 ms | 配对中位 **−4.35 ms**（8/9 同向；A/A 绝对差中位 1.42） | **NO CHANGE** |

- 两处阈值都未达到，本轮**没有修改 `lib/`**，也没有为改而改。
- 可复跑脚本：[acp-startup-latency.mjs](../../scripts/benchmarks/acp-startup-latency.mjs)、
  [experience-commit-latency.mjs](../../scripts/benchmarks/experience-commit-latency.mjs)。
- 原始数据：[r15-acp-startup-latency.json](r15-acp-startup-latency.json)、
  [r15-acp-startup-latency-records5.json](r15-acp-startup-latency-records5.json)、
  [r15-experience-commit-latency.json](r15-experience-commit-latency.json)。

## 1. 口径

- 环境：Node `v26.13.1`、darwin-arm64。测量期间串行执行，没有并行的测试、
  验收或其它基准。
- 宿主：隔离安装的官方 `@deepseek-ai/dsh@0.2.2-rc.5`
  （`@deepseek-ai/cordis@4.1.0`、`cordis-plugin-include@1.1.0`）。
- home：隔离的 `$DSH_HOME`，acp profile 按真实安装形态配置——
  `evolution-experience` 开、`evolution-experience-history` 开、
  `evolution-orchestrator` 关、`evolution-promoted-consumer` 开、
  `evolution-desktop-task-host` 关、`evolution-desktop-task-client` 开、
  `hmr` 关。
- 隔离校验（两个脚本都在**任何写入或扫描之前**执行，失败即非零退出）：
  - 正式 DSH_HOME 用逐组件 `lstat`+`readlink` 解析（包括 `$HOME/.dsh` 本身是
    符号链接或悬空链接的情况），再与解析后的 `--home` 做双向包含判断；
  - `TMPDIR` 同样解析；`mkdtemp` 之后立即解析 work 目录，断言它仍在解析后的
    `TMPDIR` 内、且不在受保护目录内，否则删除该目录并以非零退出；
  - `--out` 的每一段路径都逐组件解析，**不依赖目标是否存在**；解析后若文件
    已存在，还要求它是普通文件且 `nlink === 1`（硬链接会共享 inode，直接拒绝）；
    `--out` 也不得落在正式 home 或源 home 内；
  - 源 home 与每个 scratch 副本里的**每一个**符号链接都用 `realpath` 解析，
    必须留在自己的根内；悬空链接与逃逸链接直接拒绝。本轮启动基准检查
    175 条链接 / 0 逃逸，提交基准检查 155 条 / 0 逃逸；
  - `homeCopy`、overlay、`entryRoot` 都断言解析后位于 scratch 根内。
  - 负向夹具（模拟正式 `~/.dsh`，全部以退出码 1 拒绝）：`TMPDIR` 指向受保护
    目录（受保护目录内无临时目录残留）、`$HOME/.dsh` 为链接且 `--home` 传其
    目标（在任何读取前拒绝）、`--out` 为受保护文件的硬链接（哨兵内容与
    dev/ino 不变）、三种悬空 `--out` 链接（目标未创建）。
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
| `on` | 765.41 | 763.51 / 765.86 |
| `on2`（A/A） | 769.96 | 766.58 / 770.72 |
| `off` | 744.28 | 741.80 / 745.21 |

逐轮配对差（ms）：

| 轮 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 中位数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `on−off` | 18.02 | 22.59 | 9.71 | 20.57 | 20.98 | 26.03 | 40.01 | 20.60 | 22.32 | **20.98** |
| `on2−off` | 47.45 | 27.63 | 21.66 | 15.06 | 22.15 | 15.56 | 28.92 | 24.52 | 37.52 | **24.52** |
| `on−on2`（A/A） | −29.43 | −5.04 | −11.95 | 5.51 | −1.17 | 10.47 | 11.09 | −3.92 | −15.20 | **−3.92** |

- `spawn → initialize` 的 `on−off` 中位 **11.80 ms**（p25 10.52 / p75 14.47），
  9 轮全为正。
- `session/new` 的插件增量中位 **20.98 ms**，9/9 为正，A/A 中位 −3.92 ms，
  远低于 200 ms 阈值。
- home 含 5 条已发布记录的权威测量：`on−off` 中位 **25.76 ms**
  （p25 21.97 / p75 33.34；逐轮 19.44 / 24.65 / 35.88 / 25.76 / 21.97 /
  31.52 / 35.81 / 20.86 / 33.34），A/A +2.70 ms，同样 NO CHANGE。

### 2.3 归因（独立探针，**不是**总增量的拆账）

| 探针 | 测量边界 | 中位数（5 轮） |
| --- | --- | ---: |
| 模块加载（ACP 入口集） | 新进程 import `experience-collector` / `experience-history` / `promoted-consumer` / `guard` / `desktop-task-client`；断言导出 `apply()` | 20.07 ms / 663,546 B / 35 模块 |
| 模块加载（Web 入口集） | 同上，无 `desktop-task-client` | 17.06 ms / 469,811 B / 27 模块 |
| `openSharedExperience()` | 全新 root（建 schema）/ 已初始化 root | 1.89 ms / 0.49 ms |
| `published.json` 读取 | `readSharedIndex`，0 / 5 / 50 条 | 0.72 / 1.06 / 2.24 ms |
| 逐记录源码校验 | `validateSharedRecord` + `readPromotedPlugin`（读 entry 与 manifest、SHA-256）+ host/capability 判定 | 0 / 1.68 / 7.73 ms（0 条为 0） |

- 这些探针各自只测自己声明的那一步：模块探针不含 host composition 与插件
  `apply()`；store 探针不含 collector 订阅与工具注册；index 探针不含 Include
  挂载与被挂载插件的 `apply()`。因此**不能把 20.07 ms 说成 20.98 ms 总增量中
  的某个比例**，也不能把各探针相加当作总成本；它们只说明各项量级。
- 模块探针导入的是已安装 bundle `lib/` 的逐字节副本，`node_modules` 从宿主
  pnpm store 与 profile 顶层的已解析包重组；它与
  [R13](session-startup-and-experience-growth-20261117.md) 的
  `11.98 ms / 456,178 B / 25 模块` 不是同一套 harness（模块集、依赖布局、
  宿主版本都不同），只能作对照，不能相减。
- 「安装后首次启动」单列：把副本里的 `sessions/`、`storages/session_projcache/`、
  `storages/evolution-experience/`、`logs/`、`storages/evolution/shared-plugins/consumers/`
  与 `storages/evolution/shared-plugins/.publish.lock.sqlite` 移除后测 2 对
  配对，`on−off` 中位 **29.79 ms**（p25 27.48 / p75 32.11；5 条记录的副本为
  25.20 ms）。只有 2 对样本，只说明本机没有出现明显的一次性惩罚，不进入
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
| 失败 → `tools/result` 内同步提交（首个提交，含惰性语句编译） | 2.328 | 2.328 | 2.328 | 2.328 |
| 失败 → 稳态提交（49 samples） | **0.249** | **0.448** | **0.547** | 0.547 |
| 干净成功（零写库） | 0.0047 | 0.0084 | 0.0857 | 0.0857 |
| 退化：`tools/result` 只挂起 | 0.0082 | 0.0187 | 0.0390 | 0.0390 |
| 退化：`agent/turn-stopping` 单独计时（首个提交） | 0.347 | — | — | — |
| 退化：`agent/turn-stopping` 单独计时（49 samples） | 0.216 | 0.297 | 0.465 | 0.465 |
| 恢复（失败后第 5 次干净成功） | 0.254 | — | — | — |

- 干净成功批次有正向控制：批次前后各发一次已知失败 emit，必须各提交恰好
  1 个事件；两次都通过（`cleanPositiveControl: true`），证明同一个已挂载
  listener 确实在写，干净路径的「零写库」不是空 listener 造成的假象。
- 恢复样本已验证（`recoveryVerified: true`）；ACP 三臂事件增量为
  精确 1 / 0 / 1（`acpDeltaExact: true`）。
- 退化样本是无后续工具调用的夹具，因此提交确实落在 `turn-stopping`；表里
  已把 `tools/result` emit 与 `turn-stopping` emit 分开计时，不再混在一起。
- 首个提交 2.328 ms 包含 SQL 语句的惰性准备；从第二个提交起是稳态。
- 归因对照（同一事务形状的独立数据库，`FULL` vs `NORMAL`）：p50 0.084 vs
  0.039 ms，差 0.045 ms。两者都是亚毫秒，**NORMAL 削弱耐久性、不是候选方案**，
  该对照只说明 fsync 成本的量级。

### 3.3 真实 ACP 端到端 A/B（确认）

- 每轮 prompt 让模型发起一次 `read` 缺失文件（真实失败、一次真实提交），然后
  `end_turn`。三臂 `enabled`（真实安装形态）/ `disabled`（只把
  `evolution-experience` 与 `evolution-experience-history` 两行置为
  `disabled: true`）/ `enabled2`（A/A）。9 轮、臂顺序轮换、每轮全新副本。
- 每个样本都断言：2 次 provider 请求、观察到 `failed` 工具调用、`end_turn`；
  `enabled`/`enabled2` 的 store 事件增量必须**恰好为 1**、`disabled` 必须为 0。
  9 轮全部有效，无效样本 0。

两个区间（ms）：

| 区间 | `enabled` | `disabled` | `enabled2` | `disabled−enabled`（中位 / 绝对差中位 / 方向） | A/A（中位 / 绝对差中位 / 方向） |
| --- | ---: | ---: | ---: | ---: | ---: |
| 窄区间：父进程观测到 `tool_call_update(failed)` → 下一 provider 请求到达 | 12.476 | 11.026 | 12.447 | −1.450 / 1.778 / 2+ 7− | −0.007 / 0.655 / 4+ 5− |
| 整轮：`session/prompt` 请求 → 该轮响应 | 78.969 | 75.593 | 79.082 | **−4.346 / 4.346 / 1+ 8−** | −0.014 / 1.415 / 4+ 5− |

- 窄区间只是两个父进程观测点之间的距离：如果宿主在发布 `tool_call_update`
  之前就调用了 collector，这个区间不覆盖那次提交。它的方向不一致
  （2 正 7 负），因此只用来说明量级。
- 整轮区间无条件覆盖本轮任意位置发生的同步提交：宿主在工具管线返回前同步
  调用 collector，ACP 在本轮完成后才返回 prompt 响应。
- 整轮逐轮配对：−1.780 / −1.205 / −6.145 / −12.623 / −8.742 / −7.480 /
  −4.346 / +1.541 / −0.576 ms；有符号中位 **−4.346 ms**，绝对差中位
  4.346 ms，单轮绝对差 0.576–12.623 ms，8/9 同向。A/A 绝对差中位 1.415 ms。
- 4.35 ms 是**配对中位差**，不是单轮上界；本机这 9 轮里最大单轮绝对差是
  12.623 ms，仍低于 50 ms 阈值。
- commit 本身（进程内）只有 0.249 ms，因此这 4.35 ms 的配对差异不能被全部
  归因到提交；它包含整轮内 collector 相关的一切（订阅、分类、一次提交、
  若干事件分发），本轮没有把各项拆开。

## 4. 为什么两项都 NO CHANGE

- A 的实测增量是 20.98 ms（5 条记录 25.76 ms）。独立探针显示模块加载
  20.07 ms、store 热打开 0.49 ms、index 读取与逐记录校验（5 条）约 2.7 ms；
  这些探针的边界互不重叠，**不能相加**，也不能据此说模块加载占了总增量的
  某个比例。要跨过 200 ms 阈值，需要这里出现一个数量级更大的项，本机没有
  观察到。把模块改成惰性加载最多只能省下十几到二十毫秒，却会把首次使用时
  的失败窗口引入数据写入路径，按本项目「微小收益不作主要成果」的判据不实施。
- B 的写路径只有失败、恢复边界与（延后结算的）退化会写库，普通成功为零；
  失败提交稳态 p95 0.448 ms。真实 ACP 整轮里启用 collector 的配对中位差异是
  4.35 ms（8/9 同向），单轮绝对差最大 12.62 ms；两者都低于 50 ms 阈值。
  因此没有修改提交语义、WAL 或 fsync 的动机。

## 5. 边界与未测

- **Desktop profile 没有在本轮测量**：用户日常的 Desktop 形态启用
  `evolution-orchestrator`（kernel），它有另外两条每轮路径——`agent/pre-step`
  里的 `domainStorage.flush()` 与失败时的 `tools/result` 自主观察者。这不属于
  本轮 A/B 的定义范围（B 只测 experience collector），因此不能把本文数字当作
  Desktop 全链路延迟的结论。ACP profile 关闭 kernel，正是为了把 collector 的
  成本单独隔离出来。
- 整轮 4.35 ms 的机制没有拆到单项：commit 本身是 0.249 ms，其余部分（事件
  分发、分类、宿主侧差异）本轮没有单独探针。
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
# 0) 先在一个可写的临时根下定义变量（不要指向正式安装环境）
BASE=/path/to/isolated-base
mkdir -p "$BASE"

# 1) 隔离 runtime（示例版本）
mkdir -p "$BASE/runtime" && cd "$BASE/runtime"
printf '%s\n' '{"name":"r15-runtime","private":true,"type":"module","dependencies":{"@deepseek-ai/dsh":"0.2.2-rc.5"}}' > package.json
pnpm install --config.strict-dep-builds=false

# 2) 用本树打包（回到仓库根）
npm run release:pack    # 产出 dist/dsh-evolution-0.2.22.tgz

# 3) 只对 acp profile 做官方安装。desktop profile 由 Electron 独占，
#    `setup-experience.mjs` 会在 desktop 处停下，所以这里不用它。
DSH_HOME="$BASE/home" "$BASE/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile acp add "$PWD/dist/dsh-evolution-0.2.22.tgz"

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

两个脚本都拒绝正式 `~/.dsh` 与仓库内的 home，并在写入前逐组件解析所有
符号链接（包括悬空链接）与 `TMPDIR`、拒绝已有硬链接的 `--out`；`--smoke`
只跑 2 轮并标注 non-authoritative，不能替代上面的权威跑。
