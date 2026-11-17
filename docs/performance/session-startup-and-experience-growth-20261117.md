# ACP/Web 会话启动开销与共享经验结论查询的长期增长成本

本轮基于 `main` 的 `1bb5413`（"Merge pull request #64"），只做两类不改变
功能、持久化格式、去重与晋升语义的优化：

1. **经验入口的模块图**：`dsh-evolution/experience` 与
   `dsh-evolution/experience-history` 在 ACP / Web profile 中启用，而
   `evolution-orchestrator` 只在 Desktop 启用。两个轻量入口原先仍然静态导入
   `orchestrator.js`（`safeErrorDto`）、`diagnostics.js`
   （`resolveEvolutionPaths`）与 `registration.js`（`warnRedacted` /
   `redactedToolError`），因此每个 ACP/Web 会话都会解析并实例化整套
   kernel/doctor 图，只为了三个小 helper。本轮把凭据/错误投影边界拆到
   `lib/error-boundary.js`、路径解析拆到 `lib/evolution-paths.js`，两个入口
   的传递闭包不再包含 orchestrator / diagnostics / registration /
   domain-storage / archive-stage / event-log-checkpoint 等模块。
2. **`findConclusions()` 的知识增长成本**：`priorIneffectiveConclusion()`
   在每次带策略的 `evolution_propose` 上执行它。旧实现先用一次全表
   `instr(body, scope)` 计数，再用第二次同样的全表扫描读取窗口；当窗口没有
   被填满时，窗口本身就是全部作用域行，第二次计数是纯冗余。本轮只在窗口
   被填满（即可能还有窗口外的行）时才做那次计数，返回值逐字段不变。

环境：Node `v26.13.1`、`darwin-arm64`。两次基准都在没有其它测试/基准/验收
并行时运行。

## 1. ACP/Web 会话的入口模块图

基准：[experience-entry-load.mjs](../../scripts/benchmarks/experience-entry-load.mjs)，
原始数据：[experience-entry-load-20261117.json](experience-entry-load-20261117.json)。

方法：每次探针在**新进程**中执行（ESM 解析/实例化只能这样干净地计时），用
`node:module` 的 `registerHooks` 统计实际加载的模块与字节；`--baseline`
从 `1bb5413` 物化 `lib/` 到临时目录并软链 `node_modules`，候选始终是工作树。
每个探针都断言每个入口导出 `apply`，构建坏掉会失败而不是被计时。四个入口集
交替先后顺序各跑 7 轮，取中位数：

- `experience`：`experience-collector`
- `history`：`experience-history`
- `web`：`experience-collector` + `experience-history` + `promoted-consumer` + `guard`
- `acp`：`web` + `desktop-task-client`

| 入口集 | 墙钟 ms | CPU ms | `lib/` 字节 | 模块数 | RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| `experience` 基线 | 13.32 | 14.49 | 1,044,097 | 23 | 24.75 |
| `experience` 本轮 | **5.30（−60.2%）** | **6.08（−58.1%）** | **178,698（−82.9%）** | **9** | **17.86（−6.89）** |
| `history` 基线 | 13.39 | 14.56 | 1,044,363 | 24 | 24.83 |
| `history` 本轮 | **5.30（−60.4%）** | **6.04（−58.5%）** | **178,964（−82.9%）** | **10** | **17.86（−6.97）** |
| `web` 基线 | 17.65 | 19.67 | 1,136,092 | 31 | 26.57 |
| `web` 本轮 | **10.54（−40.3%）** | **12.12（−38.4%）** | **355,997（−68.7%）** | **21** | **20.58（−5.99）** |
| `acp` 基线 | 18.38 | 20.38 | 1,192,412 | 33 | 26.93 |
| `acp` 本轮 | **11.98（−34.8%）** | **13.64（−33.1%）** | **456,178（−61.7%）** | **25** | **21.13（−5.80）** |

归因与边界：

- 省下的是**经验入口自己的**模块图：orchestrator 416 KB、diagnostics 190 KB、
  archive-stage 57 KB、event-log-checkpoint 44 KB，以及经它们传递的
  `self-evolution-review` / `promoted-sharing` / 领域模块。Desktop profile
  仍启用 `evolution-orchestrator`，该 profile 的模块图不变；本轮没有删除
  任何代码，只是把共享边界移动到更小的模块并由原模块 re-export。
- `web` / `acp` 的余量主要来自 `promoted-consumer`（官方 Include +
  `js-yaml`）与 `guard`，这些是入口本身需要的功能，不在本轮范围内。
  惰性加载 `js-yaml` / `zod` 已在
  [host-startup-0.2.2.md](host-startup-0.2.2.md) 中以"收益不足且把失败窗口
  移入写入路径"为由拒绝，本轮不重复。
- 绝对时间仍只是会话启动的一小部分：同一台机器上完整宿主的冷启动在
  [host-startup-0.2.2.md](host-startup-0.2.2.md) 中约为 1.3–1.5 s（不同宿主
  版本，不能与本节相加）。本节只主张本插件在 ACP/Web 会话里的启动 CPU、
  常驻模块内存与需读取/解析的源码字节，不声称完整会话墙钟的同等降幅。
- 数字是热页缓存下的模块图成本，不是冷盘首次读取，也不是稳态运行内存。

## 2. `findConclusions()` 随 canonical knowledge 增长

基准：[shared-experience-conclusion-scan.mjs](../../scripts/benchmarks/shared-experience-conclusion-scan.mjs)，
原始数据：[10k](shared-experience-conclusion-scan-10k.json) /
[30k](shared-experience-conclusion-scan-30k.json)。

方法：每个 `--rows` 生成一个只有该表增长的隔离库，每个事件写入一个**不同**
`target`，因此 `knowledge` 恰好有 `rows` 行（普通运行里该表按不同问题身份
增长，结论随实验数增长，events 账本不影响本查询）。基线与候选在同一个
`DatabaseSync` 连接上、交替顺序执行；每对结果必须先
`deepEqual`，再把生产 `store.findConclusions()` 的答案与冻结的旧查询比较。
每次 5 个计时样本、7 轮取中位数；`window` 为默认的 500，被查询 target 只有
1 行作用域匹配（未截断，即普通路径）。

| knowledge 行数 | 基线 ms | 本轮 ms | 变化 |
| ---: | ---: | ---: | ---: |
| 10,000 | 52.37 | **26.96** | **−48.5%** |
| 30,000 | 159.89 | **81.99** | **−48.7%** |

余下的一次全表 `instr` 扫描是窗口读取本身：要判断"这个 target 有没有已记录
的无效策略"，就必须按 `revision` 倒序检查作用域匹配的 canonical body。把它
变成索引/列需要 schema 变更与迁移，本轮明确不做；把窗口改成"最近 N 行全局
扫描"会重新引入已修复的漏报（
[shared-experience-conclusion.test.mjs](../../test/shared-experience-conclusion.test.mjs)
的 "still found after unrelated knowledge exceeds the global scan window" 用例
钉住了该行为）。

边界：窗口被填满时（同一 target 的 canonical 结论 ≥ `window`，默认 500，
最多 2000）仍执行计数，成本与旧实现相同；`scanned` / `considered` /
`truncated` / `matches` 在所有情况下逐字段相等。未测 100k 行以上、慢盘、
并发写者或生产数据分布。

## 3. 明确未采用的候选

- **惰性加载 `js-yaml` / `zod`**：旧结论仍是 0.2% / 1.5% 上限且会把失败窗口
  移入晋升/写入路径，不重复。
- **给 `knowledge.scope` 加索引或生成列**：需要 schema 变更与数据迁移，违反
  本轮约束；pin 的 schema 2 形状检查也不允许。
- **裁剪 `events` 账本**：永久去重是跨进程、跨入口的已发布语义，不能删除。
- **缩短 recall 的 `maxConsidered` 窗口**：会改变发现/召回语义；`recall` 与
  `discover` 已经按窗口有界（30k 行时约 30 ms / 12 ms），不随 events 行数增长。
- **`stats()` 的 `count(*)`**：30k 行时约 0.8 ms，且 `evolution_history` 的
  无查询形态需要精确计数；不为它引入近似或缓存。
- **事件同步/归档事务**：已有独立基准与多轮撤回记录，见
  [redundant-work.md](redundant-work.md) 与 [closure.md](closure.md)，不重复。

## 4. 等价性与验证

- `test/experience-entry-lightweight.test.mjs` 以源码图钉住两个轻量入口的
  传递闭包**恰好**是 `shared-experience`、`experience-recall`、
  `experience-plan`、`knowledge`、`error-boundary`、`evolution-paths`，
  并禁止 orchestrator / diagnostics / registration / domain-storage 等模块
  重新变得可达。该用例在改动前的树上失败（闭包含 orchestrator/diagnostics/
  registration），改动后通过。
- `test/shared-experience-conclusion.test.mjs` 新增"窗口满 / 未满都给出精确
  总数"用例；基准每轮对基线与候选、以及生产实现做 `deepEqual`。
- 凭据/错误边界是移动而不是重写：行为用例（redaction 各轮、safe error DTO、
  日志站点、promoted-consumer 轻量入口等）全部保留并通过；
  "exactly one implementation" 的源码计数用例改为把
  `orchestrator.js` + `error-boundary.js` 当作同一面读取。
- 运行过的检查见 PR 描述（聚焦用例、全量 `npm test`、`npm run pack:check`），
  不把历史数字当作本轮结果。

## 5. 复现

```sh
node --max-old-space-size=4096 scripts/benchmarks/experience-entry-load.mjs \
  --baseline 1bb5413 --rounds 7 \
  --out docs/performance/experience-entry-load-20261117.json
node --max-old-space-size=4096 scripts/benchmarks/shared-experience-conclusion-scan.mjs \
  --rows 10000 --rounds 7 --samples 5 \
  --out docs/performance/shared-experience-conclusion-scan-10k.json
node --max-old-space-size=4096 scripts/benchmarks/shared-experience-conclusion-scan.mjs \
  --rows 30000 --rounds 7 --samples 5 \
  --out docs/performance/shared-experience-conclusion-scan-30k.json
```

两个脚本都会在输出路径写入原始逐轮样本；结论查询基准在任一轮结果不等价时
以非零码退出，入口基准在任一入口集的 `lib/` 字节没有下降时以非零码退出。
