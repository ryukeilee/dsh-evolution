# ACP 会话启动与工具调用后的插件延迟（R15）

受理标识：**DSH-EVOLUTION-PERF-R15-01**。本文只记录本机实际执行的测量与判定，
不是宿主发布验收。被测插件版本 `0.2.22`，由基线提交 `4a846b5` 打包
（tarball `a638cf28…`）；本分支只新增基准脚本与本文，`lib/`、`package.json`、
`cordis.patch.yml` 与基线逐字节未变。

## 0. 结论

| 项 | 判定阈值 | 实测（配对中位数） | 结论 |
| --- | ---: | ---: | --- |
| A. ACP 会话启动（`spawn → session/new`） | ≥ 200 ms | **+25.49 ms**（p25 22.46 / p75 31.94） | **NO CHANGE** |
| A′. 同上，home 含 5 条已发布记录 | ≥ 200 ms | **+21.84 ms**（p25 19.92 / p75 29.44） | **NO CHANGE** |
| B. 失败工具调用后的同步提交 | ≥ 50 ms | **p50 0.252 / p95 0.413 / p99 0.540 ms** | **NO CHANGE** |
| B′. 干净成功工具调用 | ≥ 50 ms | p50 0.0047 / p95 0.0093 ms（零写库） | **NO CHANGE** |
| B″. 真实 ACP 整轮（含一次失败提交） | ≥ 50 ms | 配对中位差 −2.83 ms，A/A 噪声 +1.21 ms | **NO CHANGE** |

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
  `hmr` 关。真实 `~/.dsh` 未被读取或写入；脚本在写任何副本之前用
  `realpath` 拒绝与正式 home 有包含关系或位于仓库内的路径。
- 模型与网络：ACP 进程通过 `--patch` 装入回环确定性 Anthropic provider。
  启动计时窗内断言**零** provider 请求；provider 只在计时结束后的非计时
  `session/prompt` 里证明自己生效。工具调用基准的整轮区间包含本机 IPC 与
  宿主调度，但不含真实模型推理（没有外部模型调用、没有凭据）。
- A/A 噪声底：每一轮除了 `on` / `off` 还跑一份与 `on` 完全相同的独立副本
  `on2`。`on−on2` 的配对中位数就是噪声底，用来判断 `on−off` 是否超出噪声。

## 2. A. ACP 会话启动

### 2.1 方法

- 三臂：`on`（bundle 在 `dsh.profile.bundles` 中）、`off`（同一份副本只把
  `dsh-evolution` 从 bundles 移除，包仍安装，因此只消失本插件自己的启动
  工作）、`on2`（与 `on` 相同的第二份副本）。
- 每轮三臂各自从 pristine home 复制全新副本，复制时间不计时；臂顺序按
  `on→off→on2 / off→on2→on / on2→on→off` 轮换；每臂先预热一次，正式 9 轮。
- 指标是父进程 `performance.now()`：`spawn` → `initialize` 响应、
  `spawn` → `session/new` 完成（可接受输入）。判定用后者。
- 每臂失败即非零退出，不跳过；脚本断言 `initialize`/`session/new`/`prompt`
  成功、各副本 bundle 选中状态与预期一致、计时窗内没有模型请求。

### 2.2 结果

三臂 `spawn → session/new` 中位数（9 轮）：

| 臂 | 中位数 ms | p25 / p75 |
| --- | ---: | --- |
| `on` | 766.55 | 754.78 / 767.75 |
| `on2`（A/A） | 758.59 | 756.87 / 766.67 |
| `off` | 738.60 | 731.78 / 741.06 |

逐轮配对差（ms，`on−off` 与 `on2−off` 同向时说明差异可复现）：

| 轮 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 中位数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `on−off` | 25.49 | 38.46 | 31.94 | 23.12 | 45.11 | 31.11 | 22.46 | 21.27 | 15.24 | **25.49** |
| `on2−off` | 27.50 | 29.55 | 34.38 | 21.58 | 10.74 | 27.43 | 34.89 | 23.92 | 18.27 | **27.43** |
| `on−on2`（A/A） | −2.01 | 8.91 | −2.44 | 1.54 | 34.37 | 3.68 | −12.43 | −2.65 | −3.03 | **−2.01** |

- `spawn → initialize` 的 `on−off` 中位数是 +16.56 ms（p25 14.57 / p75 18.31），
  9 轮全为正。
- `session/new` 的插件增量中位数 **25.49 ms**，远低于 200 ms 阈值；A/A 噪声
  −2.01 ms，且 `on−off` 9 轮方向一致，说明这是一个真实但很小的增量。
- 含 5 条已发布记录的第二轮权威测量：`on−off` **21.84 ms**
  （p25 19.92 / p75 29.44），A/A −4.34 ms，同样 NO CHANGE。

### 2.3 归因（独立探针，**不相加**）

| 组成 | 测量 | 中位数 | 样本 |
| --- | --- | ---: | ---: |
| 模块加载（ACP 入口集：experience / history / consumer / guard / desktop-task-client） | 新进程 import，`node:module` 统计 | 20.08 ms / 663,546 B / 35 模块 | 5 |
| 模块加载（Web 入口集：无 desktop-task-client） | 同上 | 17.17 ms / 469,811 B / 27 模块 | 5 |
| `openSharedExperience()` | 全新 root / 已初始化 root | 1.87 ms / 0.51 ms | 5 |
| `published.json` 读取 | 0 / 5 / 50 条记录 | 0.72 / 1.08 / 2.28 ms | 5 |
| 逐记录源码校验（`validateSharedRecord` + `readPromotedPlugin` 的读文件与 SHA-256 + host/capability 判定） | 5 / 50 条记录 | 1.72 / 7.76 ms（0 条为 0） | 5 |

- 这些探针各自只测自己声明的那一步：模块探针不含 host composition 与插件
  `apply()`；store 探针不含 collector 订阅与工具注册；index 探针不含 Include
  挂载与被挂载插件的 `apply()`。因此**不能与 25.49 ms 逐项相加**，只能说明
  各项量级。模块加载是其中最大的一项；按实现推断，余下约数毫秒分布在
  consumer 挂载的租约/状态/两处原子 composition 写入、GC 扫描与工具注册上，
  本轮没有为它们单独拆探针，因此这里只给量级，不给逐项数字。
- 模块探针导入的是已安装 bundle `lib/` 的逐字节副本，`node_modules` 从宿主
  pnpm store 与 profile 顶层的已解析包重组；它与
  [R13](session-startup-and-experience-growth-20261117.md) 的
  `11.98 ms / 456,178 B / 25 模块` 不是同一套 harness（模块集、依赖布局、
  宿主版本都不同），只能作对照，不能相减。
- 「安装后首次启动」单列：把副本里的 `sessions/`、`storages/session_projcache/`、
  `storages/evolution-experience/`、`logs/`、`storages/evolution/shared-plugins/consumers/`
  与 `storages/evolution/shared-plugins/.publish.lock.sqlite` 移除后测 2 对
  配对，`on−off` 中位 **20.07 ms**（p25 17.96 / p75 22.17）。样本只有 2 对，
  只说明本机没有出现明显的一次性惩罚，不进入稳态判定。

## 3. B. 每次工具调用后的同步提交

### 3.1 真实写库边界（先读实现）

`lib/experience-collector.js` 的 `tools/result` listener 同步执行，但**不是每次
工具调用都写库**：

| 结果 | 是否写库 | 时机 |
| --- | --- | --- |
| 普通成功（`read` 完整返回） | 否 | 只更新内存计数器 |
| 失败（`result.isError === true`） | 是，1 个 `COMMIT` | 在 `tools/result` listener 内同步完成 |
| 非报错退化（行截断 / 输出封顶） | 是，1 个 `COMMIT` | 先挂起，在 `agent/turn-stopping` / `agent/disposed` / `agent/error` 提交 |
| 失败后连续第 5 次干净成功（恢复） | 是，1 个 `COMMIT` | 在 `tools/result` listener 内同步完成 |

官方 emit 不 await listener，所以 listener 的同步耗时就是它对宿主事件循环、
也就是对该轮回复的阻塞量。写库走 `lib/shared-experience.js` 的
`BEGIN IMMEDIATE` / `COMMIT`，`PRAGMA synchronous=FULL` + WAL，没有为性能
去掉 fsync 或放宽 WAL。

### 3.2 进程内分布（主证据）

真实 `new Context()` + 安装包里的真实 collector `apply()`，用真实 store 驱动
`ctx.emit('tools/result', …)`；每个样本都要通过 `store.stats()` 增量断言才计入。
harness 实测解析到被测宿主的 `@deepseek-ai/cordis@4.1.0` 与
`profiles/acp/node_modules/dsh-evolution/lib/experience-collector.js`
（bundle `0.2.22`，collector SHA-256 `1c6127c1…`），没有 fallback。

| 场景（50 samples） | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: |
| 失败 → `tools/result` 内同步提交（首个提交，含惰性语句编译） | 2.667 | 2.667 | 2.667 | 2.667 |
| 失败 → 稳态提交（49 samples） | **0.252** | **0.413** | **0.540** | 0.540 |
| 干净成功（零写库） | 0.0047 | 0.0093 | 0.110 | 0.110 |
| 退化：`tools/result` 只挂起 | 0.0080 | 0.0163 | 0.0471 | 0.0471 |
| 退化：`agent/turn-stopping` 提交（49 samples） | 0.225 | 0.322 | 0.445 | 0.445 |
| 恢复（失败后第 5 次干净成功） | 0.228 | — | — | — |

- 首个提交 2.667 ms 包含 SQL 语句的惰性准备；从第二个提交起是稳态。
- 干净成功路径 p95 0.009 ms，确认普通工具调用没有同步 I/O。
- 退化路径的提交不在 `tools/result`，而是在轮末的 `turn-stopping`，因此它
  同样不在「工具结果返回后」的直接阻塞里。
- 归因对照（同一事务形状的独立数据库，`FULL` vs `NORMAL`）：p50 0.082 vs
  0.041 ms，差 0.041 ms。两者都是亚毫秒，**NORMAL 削弱耐久性、不是候选方案**，
  该对照只说明 fsync 成本的量级。

### 3.3 真实 ACP 端到端 A/B（确认）

- 每轮 prompt 让模型发起一次 `read` 缺失文件（真实失败、一次真实提交），然后
  `end_turn`。三臂 `enabled`（真实安装形态）/ `disabled`（只把
  `evolution-experience` 与 `evolution-experience-history` 两行置为
  `disabled: true`）/ `enabled2`（A/A）。9 轮、臂顺序轮换、每轮全新副本。
- 每个样本都断言：2 次 provider 请求、观察到 `failed` 工具调用、`end_turn`；
  `enabled`/`enabled2` 的 store 事件增量必须为 1、`disabled` 必须为 0。
  9 轮全部有效，无效样本 0。

| 区间 | `enabled` | `disabled` | `enabled2` | `disabled−enabled` | A/A 噪声 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `tool_call_update(failed) → 下一 provider 请求` | 12.261 | 11.849 | 12.490 | **+0.301** | +1.003 |
| 整轮：`session/prompt` 请求 → 该轮响应 | 78.63 | 77.98 | 80.56 | **−2.833** | +1.211 |

- 窄区间的逐轮 `disabled−enabled`：0.73 / −1.59 / 3.15 / −0.67 / 0.52 / −0.40 /
  1.48 / −1.62 / 0.30，方向不一致，中位数落在 A/A 噪声之内。
- 整轮区间的逐轮 `disabled−enabled`：−4.07 / −11.34 / 5.08 / −3.08 / 0.91 /
  −0.59 / 1.40 / −2.83 / −6.01，同样方向不一致，中位数绝对值小于 A/A 噪声。
- 结论：在真实 ACP 轮次里，collector 的同步提交没有可测出的用户级增量；这与
  进程内 p95 0.41 ms 的结论一致。

## 4. 为什么两项都 NO CHANGE

- A 的增量 25.49 ms 中，最大一项是模块加载 20.08 ms；其余是 store 打开
  （0.5–1.9 ms）、index 读取与逐记录校验（0 条 0.72 ms；5 条 1.08+1.72 ms）、
  consumer 挂载的少量原子写与 GC。要跨过 200 ms 阈值，需要这里出现一个数量级
  更大的项，本机没有观察到。把模块改成惰性加载最多只能省下十几到二十毫秒，
  却会把首次使用时的失败窗口引入数据写入路径，按本项目「微小收益不作主要
  成果」的判据不实施。
- B 的写路径只有失败与恢复边界会同步提交，稳态 p95 0.41 ms；普通成功为 0。
  要跨过 50 ms 阈值，需要每次工具调用都写库或出现秒级 fsync，实测都不成立。
  因此没有修改提交语义、WAL 或 fsync 的动机。

## 5. 边界与未测

- **Desktop profile 没有在本轮测量**：用户日常的 Desktop 形态启用
  `evolution-orchestrator`（kernel），它有另外两条每轮路径——`agent/pre-step`
  里的 `domainStorage.flush()` 与失败时的 `tools/result` 自主观察者。这不属于
  本轮 A/B 的定义范围（B 只测 experience collector），因此不能把本文数字当作
  Desktop 全链路延迟的结论。ACP profile 关闭 kernel，正是为了把 collector 的
  成本单独隔离出来。
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
# 准备隔离 runtime 与 home（示例：官方包 + 本树打包的 bundle + acp 真实安装形态）
pnpm --dir <runtime> add @deepseek-ai/dsh@0.2.2-rc.5
npm run release:pack
node scripts/setup-experience.mjs --tarball dist/dsh-evolution-0.2.22.tgz \
  --home <home> --cli <runtime>/node_modules/@deepseek-ai/dsh/lib/bin.js --apply
# 注意：setup-experience 会依次处理 desktop/acp/web；桌面 profile 由 Electron
# 独占，需按 README 的方式只对 acp 执行官方 `plugin --profile acp add` 并写入
# 托管 patch 块（本轮即如此），或使用已准备好的隔离 home。

node --max-old-space-size=4096 scripts/benchmarks/acp-startup-latency.mjs \
  --runtime <runtime> --home <home> --rounds 9 --records 0 \
  --out docs/performance/r15-acp-startup-latency.json

node --max-old-space-size=4096 scripts/benchmarks/experience-commit-latency.mjs \
  --home <home> --runtime <runtime> --rounds 9 --samples 50 \
  --out docs/performance/r15-experience-commit-latency.json
```

两个脚本都拒绝正式 `~/.dsh` 与仓库内的 home；`--smoke` 只跑 2 轮并标注
non-authoritative，不能替代上面的权威跑。
