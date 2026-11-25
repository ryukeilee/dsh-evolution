# R12 跨入口启动、诊断/审查与宿主侧开放性性能研究

受理标识：**DSH-EVOLUTION-PERF-R12-01**（本 Builder 负责的子系统部分）。

## 0. 结论与交付范围

- **实施 1 项**：`lib/diagnostics.js` 的 `diagnoseSharing()` 把同一遍只读检查里重复六次的消费者激活行投影、以及三处 O(记录数 × 行数) 的线性查找改成一次性构建的局部 Map/Set。相同输入的输出逐字节一致；5000 条已发布记录下 `promotion.sharing` 检查的 CPU 从 1321.490 ms 降到 679.387 ms（**−49.55%**），墙钟从 1355.224 ms 降到 605.736 ms（**−55.30%**）。
- **其余候选 NO CHANGE**：启动惰性化、空闲轮询、agent/pre-step flush 频率、`readPublishedPluginReview()` 的重复投影、canary 无损比较。本文给出每项的根因/成本与不实施理由。
- 未修改官方 DSH 源码，未触碰正式 `DSH_HOME`、正式经验库、`event-bridge.key` 或用户数据；未 push、未建 PR、未打 tag、未合并。
- 实际模型与档位：`opencode-go/hy4-flash-free` High（TEAM.md 固定配置）。基线提交 `719fcbb2a6405526f34ca14aa061f04220bcefec`（v0.2.21），分支 `t3/cross-entry-performance-audit`。

## 1. 方法与口径

- 环境：Node `v26.13.1`、`darwin/arm64`，8 逻辑 CPU。测量期间没有并行跑测试、宿主验收或其它重负载；同一机器上可能有其它 Builder，因此**以 `process.cpuUsage()` 为主指标**，墙钟、RSS、堆增量为辅，并做配对交替采样。
- 每个样本是独立子进程；同一档记录数用同一份合成 fixture（两种源码只读取它）。每轮顺序交替：偶数轮 baseline→candidate，奇数轮 candidate→baseline。表中"各轮"是每轮内的样本中位数；"汇总"取各轮中位数的中位数，配对差为同轮 candidate−baseline。
- 计时区间只覆盖被测函数调用（模块的动态 import、fixture 构造、预热全部在区间外），预热 2 次。每样本先 `global.gc()`，再取 CPU/墙钟/heapUsed；峰值 RSS 取 `process.resourceUsage().maxRSS`。
- baseline 树由 `git archive 719fcbb… | tar -x` 生成，并软链同一份 `node_modules`，保证两侧依赖可用形状完全一致。候选树就是本 worktree。
- 计时脚本内置输出指纹断言：同一侧每个样本的输出指纹必须相同，两侧指纹必须相同；任一处变化直接让基准失败（已全部通过）。
- 本轮测的是热页缓存、无并发写者、无真实用户数据；不代表冷盘、生产分布或其它平台。RSS 无下降主张。

## 2. 已实施：`diagnoseSharing()` 的 O(N²) → O(N)

### 2.1 根因证据

`lib/diagnostics.js` 的 `diagnoseSharing()`（基线行号 2932–3199）在一次只读诊断里对同一批数据反复做线性工作：

| 基线位置 | 重复工作 |
| --- | --- |
| `:2945/:2962`（索引缺失分支） | 每个 profile 调用 `sharingPluginRows()` 两次 |
| `:3038` | 每个 profile 再调用一次 `sharingPluginRows()` |
| `:3039` | 对每个消费者行执行 `index.records.find(...)`，O(记录 × 行) |
| `:3078` | 再次 `sharingPluginRows()` |
| `:3081` | 在"缺激活行"循环里，对每条记录执行 `rows.some(...)`，O(记录 × 行) |
| `:3090` | `rows.some(row ⇒ records.some(...))`，又一次 O(记录 × 行) |
| `:3094` | 每行扫描一次撤销表（`isDisabledForProfile`） |
| `:3108/:3189` | 各再调用一次 `sharingPluginRows()` |

`sharingPluginRows()` 就是 `consumerActivationRows()`（`lib/promoted-sharing.js:1092`），每次调用都 `filter` 出一个新数组；因此同一遍诊断里每个 profile 的激活行数组被物化 6 次。R11 §3 已明确 `published.json` 与 consumer `plugins` **没有记录数上限**：索引由 reconciler 追加并保存历史，review/usage 的 50/200 读取上限不会删数据，也没有自动删除路径；所以这不是只在病态规模出现的形状。

一次 5000 条记录的 CPU profile（`--cpu-prof`，1 次诊断）证实热点就在这些行：`diagnoseSharing` 自身 18.46%，`diagnostics.js:3038` 6.82%，`diagnostics.js:3080` 5.57%（另有 42.34% idle，主要是逐记录 `readPromotedPlugin()` 的 I/O 等待）。

### 2.2 改动

保持所有判定、顺序、证据字段与失败语义不变，只把重复工作收成局部快照（不跨调用缓存、不信任 mtime/size）：

- `lib/diagnostics.js:2938–2940`：本遍固定的撤销表成员集合 `disabledKeys` 与局部 `isDisabled(id, profile)`，替代重复线性扫描。
- `:2951`、`:2997`：每个 profile 的激活行只投影一次（`rowsByProfile`），所有后续读取同一快照；`:2998` 的 `rowIdsByProfile` 提供 O(1) 的"该行是否存在"判定。
- `:3033`：验证后的记录（id 唯一）构建 `recordById`，替代逐行 `find`。
- `:3054–3056`、`:3095–3107`、`:3125`、`:3206`：全部改为Map/Set 查找与已物化的 `rows`。
- 删除 `diagnostics.js` 中已不再使用的 `isDisabledForProfile` 静态 import。

这是**同一调用内的等价改写**：没有新的缓存层，没有把 O(历史) 派生值交给 O(1) 信号"证明未变"（redundant-work.md §4 的撤回理由不适用），没有减少任何认证、去重、恢复或证据工作。`readPromotedPlugin()` 的逐记录摘要校验、`readSharedIndex()` 的全量校验与 sha256 全部保留。

### 2.3 同负载交替 A/B

`promotion.sharing` 检查（`collectDiagnostics({ home: true, probe: { skipComposition: true } })`）的 CPU 中位数，ms：

| 记录数 | 轮次与顺序 | baseline CPU | candidate CPU | baseline 墙钟 | candidate 墙钟 |
| ---: | --- | ---: | ---: | ---: | ---: |
| 50 | 1 b→c / 2 c→b / 3 b→c | 11.28 / 10.65 / 10.93 | 10.64 / 10.69 / 10.69 | 9.21 / 8.67 / 8.90 | 8.64 / 8.62 / 8.60 |
| 500 | 1 b→c / 2 c→b / 3 b→c | 80.55 / 76.21 / 77.25 | 73.19 / 73.30 / 72.66 | 73.20 / 68.39 / 68.77 | 63.76 / 64.28 / 63.22 |
| 5000 | 1 b→c / 2 c→b / 3 b→c | 1204.20 / 1321.49 / 1383.97 | 727.50 / 666.74 / 679.39 | 1116.87 / 1462.68 / 1355.22 | 661.91 / 584.70 / 605.74 |

汇总（各轮中位数的中位数；配对差 = candidate − baseline）：

| 记录数 | baseline CPU | candidate CPU | 变化 | 逐轮 CPU 配对差 | baseline 墙钟 | candidate 墙钟 | 变化 |
| ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| 50 | 10.934 | 10.691 | −2.21% | −0.64 / +0.04 / −0.24 | 8.895 | 8.621 | −3.08% |
| 500 | 77.253 | 73.186 | **−5.94%** | −7.37 / −2.92 / −4.59 | 68.768 | 63.755 | **−7.29%** |
| 5000 | 1321.490 | 679.387 | **−49.55%** | −476.69 / −654.75 / −704.59 | 1355.224 | 605.736 | **−55.30%** |

5000 条三对配对差全部为负且远大于同配置离散度，方向不依赖采样顺序。索引文件在该档为 7,424,066 字节，两个 consumer 状态各含 5000 个激活行。

`readPublishedPluginReview()` 在同进程里紧接 doctor 之后测量（其代码**未改动**）：5000 条时 CPU 82.394 → 72.384 ms（−10.47%），配对差 −1.58 / −8.63 / −22.01。这个差异是候选 doctor 产生的临时数组更少、进程内堆压力更低带来的**间接效应**，不作为本改动的直接收益主张；50/500 档分别在 ±2% / ±1% 噪声内。

RSS：5000 档 baseline 185120/199280/196576 KiB，candidate 188816/188528/207216 KiB。本改动用少量短命 Map/Set 换取重复数组，**不声称内存下降**，也没有可测的常驻增长证据。

原始逐样本数据：`docs/performance/r12-sharing-scan-50.json`、`-500.json`、`-5000.json`。

### 2.4 正确性差分与反证

- 逐字节差分（同一 fixture 上分别加载两个源码树，比较完整 `promotion.sharing` check 与完整 `readPublishedPluginReview()` 输出的 JSON 字节）：50 / 500 / 5000 三档全部 `byteEqual: true`，SHA-256 一致。原始数据：`r12-sharing-diff-50.json`、`-500.json`、`-5000.json`。
- 确定性反证：脚本 `scripts/benchmarks/r12-sharing-counter.mjs` 在临时副本里给 `consumerActivationRows()` 加调用计数，跑一次真实 `collectDiagnostics()`。**同一断言 `--expect 2`**：修复前失败（`expected 2 activation-row projections, got 12`，退出码 1），修复后通过（`got 2`，退出码 0）。原始记录：`r12-sharing-counter-baseline.json`、`r12-sharing-counter-candidate.json`。
- 聚焦测试（安装依赖后）：`diagnostics.test.mjs` 68/68、`diagnostics-performance.test.mjs` 1/1、`promoted-sharing-diagnostics.test.mjs` 27/27、`promoted-sharing.test.mjs` 15/15、`self-evolution-review.test.mjs` 56/56，共 **167/167 通过、0 失败**。全量测试由 Lead 集成后统一跑。

### 2.5 适用范围与代价

- 收益随"已发布记录数 × 每 consumer 激活行数"增长；≤50 条时在噪声内，500 条约 6% CPU，5000 条约 50%。真实安装的收益取决于索引累积长度；R11 明确没有自动删除路径，所以长寿命安装会进入有效区间。
- 代价：每次诊断多构造两个 profile 的 Map/Set（与行数同阶，短命），没有跨调用状态；不改变持久化格式、API、授权、去重或失败顺序。
- 只改 `lib/diagnostics.js`，未触碰 `lib/domain-storage.js`、`lib/event-log-checkpoint.js`、`lib/dockyard-domain/*`、`lib/shared-experience.js`、`lib/experience-*.js`。

## 3. 调查后决定不修改的项

| 候选 | 证据 | 结论 |
| --- | --- | --- |
| 启动惰性化 `lib/diagnostics.js` | 静态 import 闭包：`main`(lib/index.js) 30 文件 / 1,785,526 字节；轻量经验入口 8 文件 / 245,735 字节；consumer 4 / 67,168；desktop host 6 / 131,043；ACP client 3 / 154,642（`r12-startup-graph.json`）。单独冷导入 diagnostics.js 约 19.8 ms CPU，但把它从 `lib/index.js` 静态图中摘掉后，**端到端冷导入 6 轮交替的中位数为 60.206 → 58.143 ms CPU（−2.063 ms，−3.43%）**；墙钟约 −2.4 ms，RSS 无一致方向（`r12-startup-import.json`，12 个样本）。一次 4 轮预跑的 lazy 样本出现 84.72 ms 的离群值，改用 6 轮中位数后消失；不把离群值当作收益。 | **NO CHANGE**。边际收益只有个位数毫秒，却要把 `evolution_doctor` 的执行改成异步并把模块加载失败窗口移到工具首次使用；与 `host-startup-0.2.2.md` 对 js-yaml/zod 惰性化的判断同向。 |
| `lib/desktop-task-host.js` 的 1500 ms 安全重扫 | `:1590–1592` 的 `setInterval(() => { retryCleanup(); kick(); })`；`kick()`→`pendingRequests()`（`:559–583`）枚举 inbox、读每个请求和状态文件。watcher 是 `persistent:false`（`:1585`），这段重扫是它漏事件时的唯一兜底。 | **NO CHANGE**。降低频率会推迟任务拾取，移除会削弱可靠性；与"不得靠减少必要工作量制造收益"冲突。桌面任务通道默认禁用，空闲开销只在该入口显式启用时存在。 |
| `registration.js:561` 每个 `agent/pre-step` 的 flush | `axis-steady-history.md` 已给出稳态曲线：200/2000/20000/50000/100000 条约 0.154/1.073/10.974/27.571/61.293 ms/次；未回收时 `applied` 全表无代码上限。 | **NO CHANGE**。降低频率会改变事件认证/去重时机，削弱数据完整性。 |
| `readPublishedPluginReview()` 中重复 `consumerActivationRows()` | `:1033/:1069/:1075` 在最多 50 条记录 × 2 profile 里重复投影全部行；5000 行时约 500k 次过滤。 | **NO CHANGE（本轮不实施）**。理论上限约几毫秒，且 review 已有 50/200 上限；在 50/500 档实测 ±1–2% 噪声。若将来 review 的读取上限被放开，应与本次 doctor 的快照方式一起改，避免再引入第二套判定。 |
| canary/Trial 宿主侧无损比较（`losslessEqual`/`sampleEvidence`） | R11 B-1/B-2/S5/S6 刚修复 `undefined` 折叠、正文进入证据与摘要伪造；`desktop-task-host.test.mjs` 与 `review-fix-host-lossless-value.test.mjs` 覆盖路径。 | **NO CHANGE**。任何去重/缓存都会把刚建立的无损判定改成"派生值 + 未变证明"，属于 redundant-work.md §4 撤回的类别；本轮没有新的可证明等价改写。 |

## 4. 复现命令

```sh
# 生成基线树（提交 SHA 固定，不依赖当前 HEAD）
BASE=/private/var/folders/1z/bw5lw7ds72ngrqfz9fmz48mh0000gn/T/opencode/r12-baseline
git archive 719fcbb2a6405526f34ca14aa061f04220bcefec | tar -x -C "$BASE"
ln -s "$PWD/node_modules" "$BASE/node_modules"

# A/B（每档独立 fixture、独立子进程、3 轮交替；记录数 50/500/5000）
node --max-old-space-size=4096 scripts/benchmarks/r12-sharing-scan.mjs run \
  --baseline "$BASE" --candidate . --records 50 --rounds 3 --samples 5 \
  --fixture /private/var/folders/1z/bw5lw7ds72ngrqfz9fmz48mh0000gn/T/opencode/r12-ab-fixture-50 \
  --out docs/performance/r12-sharing-scan-50.json
# 500 同上；5000 用 --samples 3

# 逐字节正确性差分
node --max-old-space-size=4096 scripts/benchmarks/r12-sharing-diff.mjs \
  --baseline "$BASE" --candidate . \
  --fixture /private/var/folders/1z/bw5lw7ds72ngrqfz9fmz48mh0000gn/T/opencode/r12-ab-fixture-5000 \
  --out docs/performance/r12-sharing-diff-5000.json

# 确定性反证（同一断言：修复前失败、修复后通过）
node --max-old-space-size=4096 scripts/benchmarks/r12-sharing-counter.mjs \
  --libroot "$BASE" --fixture .../r12-ab-fixture-50 --expect 2   # 退出 1：got 12
node --max-old-space-size=4096 scripts/benchmarks/r12-sharing-counter.mjs \
  --libroot . --fixture .../r12-ab-fixture-50 --expect 2         # 退出 0：got 2

# 启动惰性化的 NO-CHANGE 证据（6 轮交替冷导入）
node --max-old-space-size=4096 scripts/benchmarks/r12-startup-lazy.mjs \
  --baseline "$BASE" --rounds 6 --out docs/performance/r12-startup-import.json

# 聚焦测试
node --max-old-space-size=4096 --test test/diagnostics.test.mjs \
  test/diagnostics-performance.test.mjs test/promoted-sharing-diagnostics.test.mjs \
  test/promoted-sharing.test.mjs test/self-evolution-review.test.mjs
```

基准脚本本身在 `scripts/benchmarks/r12-sharing-{scan,diff,counter}.mjs` 与 `scripts/benchmarks/r12-startup-lazy.mjs`；原始 A/B、差分、计数、启动图与启动导入数据全部在 `docs/performance/r12-*.json`。

## 5. 剩余瓶颈与风险

- `diagnoseSharing()` 5000 档剩余约 679 ms CPU，主要来自逐记录 `readPromotedPlugin()` 的 3 次 lstat + 2 次 readFile + 2 次 sha256，以及索引 JSON 的读取、解析、sha256 与逐记录校验；这些是防篡改边界，不能省。
- 诊断整体（29 种 check）中冷历史 JSONL 与事件桥扫描仍按历史字节线性增长，沿用既有分块扫描；本轮未重测，数值以 `diagnostics.md` / `final-candidate.md` 为准。
- 启动侧：模块图仍有 30 文件 / 约 1.7 MB `lib/` 静态闭包；惰性化诊断只有约 2.3 ms 边际收益，未实施；其它入口的模块数/字节见 `r12-startup-graph.json`。
- 桌面任务通道的 1500 ms 重扫与 `agent/pre-step` 的 flush 频率保留，理由见 §3。
- 本轮没有跑真实宿主验收、全量 `npm test` 或 `pack:check`；按 Builder 约束由 Lead 集成后统一执行。未跑的检查不写成通过。
