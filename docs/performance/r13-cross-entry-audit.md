# R13 跨入口 / 诊断 / 统一审查 / 用量 / 桌面任务通道：规模增长研究（NO CHANGE）

受理标识：**DSH-EVOLUTION-PERF-R13-01**。基线 `origin/main` =
`a0380e5cf2761297ecd8ffe1c79e34865ac6baee`；分支 `t3/r13-cross-entry-audit`
（本轮提交 SHA 见交付报告；仅研究材料，无生产代码改动）。
实际模型与档位：`opencode-go/hy4-flash-free`（High，TEAM.md 固定配置，运行标识 `Hy4 flash Free`）。

**结论：本轮不改生产代码。** 在本子系统可编辑范围内，所有可消除的重复工作已在 R12 处理
（`diagnoseSharing()` 的 O(N²)→O(N)），其余候选要么是任务明确列为"不要重提"的已否决方向，
要么是按不变量必须保留的认证 / 防篡改 / 兜底可靠性工作。本轮用 50 / 500 / 5,000 / 20,000
条已发布记录四个量级、交替 A/A 的逐轮原始数据和反证实验证明这一点，并把每个方向的
**固定开销 / 合理增长 / 可消除增长**分开量化。

## 0. 交付物与隔离

- 报告：本文。
- 原始逐轮数据：[r13-cross-entry-audit.json](r13-cross-entry-audit.json)（含 `method`、
  逐轮逐样本、噪声、并发、micro、rescan、反证），以及按档拆分的
  `r13-cross-entry-audit-aa-{50,500,5000,20000}.json`、`-micro-*`、`-concurrent-*`、`-rescan-*`。
- 复现脚本：[scripts/benchmarks/r13-cross-entry-audit.mjs](../../scripts/benchmarks/r13-cross-entry-audit.mjs)。
- 隔离：全部夹具建在 `mkdtemp` 临时路径（`r13-fixture-N` / `r13-inbox-N`）；**未**读取或写入
  正式 `DSH_HOME`、正式经验库、`event-bridge.key` 或任何用户数据；未改官方 DSH 源码。
  脚本遵循 R12-4 教训：`--fixture` 由调用方给出，脚本**从不删除它**，只写入不存在或空目录；
  实证：带 `keep.txt` 的目录在 `build` 被拒绝后内容原样保留。
- 未执行：全量 `npm test`（Lead 统一跑）、`pack:check`、宿主验收、发布。本文只报告实际跑过的检查。
- 附件里的夹具目录与 worktree 路径已替换为 `<tmp>` / `<worktree>` 占位符；测量数值、样本顺序与指纹未改。

## 1. 方法与口径

- 环境：Node `v26.13.1`、`darwin/arm64`、Apple M2、8 逻辑 CPU、16 GiB。
- 计时：A/B 交替（`A` = 当前树、`B` = 同一当前树，即 **A/A 噪声基线**），每（轮 × 侧 × 工作负载）
  起一个独立 `--max-old-space-size=4096 --expose-gc` 子进程；3 轮（20k 档 2 样本/侧、
  其余 3 样本/侧），预热 2 次（20k 档 1 次）。主指标 `process.cpuUsage()` 的 user+system；
  墙钟、堆增量、峰值 RSS 为辅。
- 正确性：每个工作负载返回确定性的可指纹结果，`measure` 在预热和每次测量后断言指纹相同，
  `run` 断言 A/B 两侧指纹全等；任何分歧先写出 JSON 再以非零码失败。本轮所有档
  `allFingerprintsEqual: true`。
- 每侧每轮独立进程，因此 A/A 的配对差反映噪声与顺序效应，而不是代码差异。20k 档
  `indexRead` / `reconcileIdle` / `sourceVerify` 的 B 侧一致偏低（−3.9% / −7.4% / −6.0%），
  而同档 `doctor` 的 B 侧偏高（+1.6%）：方向相反，判定为页缓存预热 / GC 时机的系统性偏移，
  **不作为任何收益**。50 档的噪声为 `indexRead` −1.9%、`reconcileIdle` +4.4%、
  `sourceVerify` −0.6%、`review` +1.5%、`doctor` −0.2%（`usageRead` 的 −18.1% 绝对值只有
  0.04 ms），同样按噪声处理。
- 工作负载：`indexRead`（`readSharedIndex()` 全量解析+逐记录校验+整文件 sha256）、
  `reconcileIdle`（稳态 `reconcileSharedIndex()`，所有 sidecar 已在索引中）、`sourceVerify`
  （`readPromotedPlugin()` 逐记录验证，doctor 的防篡改主成本）、`review`
  （`readPublishedPluginReview()`，50 条上限）、`doctor`（整次 `collectDiagnostics()`，
  含 `promotion.sharing`）、`usageRead`（`readUsageProjection()` 的 stat+parse）。

## 2. 规模趋势：固定开销与增长开销

原始逐轮、逐样本见 JSON。下表为每档 3 轮中位数的中位数（CPU ms），括号内为 A/A 配对相对差。

| 已发布记录（索引字节） | indexRead | reconcileIdle | sourceVerify | review | doctor | usageRead |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50（73,966 B） | 2.23（−1.9%） | 1.56（+4.4%） | 7.52（−0.6%） | 9.02（+1.5%） | 10.26（−0.2%） | 0.21（−18.1%，绝对值 0.04 ms） |
| 500（741,566 B） | 6.33（−1.3%） | 6.25（−2.1%） | 61.66（+1.1%） | 13.13（+1.0%） | 68.71（−0.4%） | 0.22（−5.4%） |
| 5,000（7,424,066 B） | 46.55（+1.2%） | 48.67（−0.5%） | 635.63（0.0%） | 68.62（+0.4%） | 672.06（+3.8%） | 0.22（+7.8%） |
| 20,000（29,729,066 B） | 225.56（−3.9%） | 254.57（−7.4%） | 2,856.67（−6.0%） | 277.46（−1.8%） | 2,837.75（+1.6%） | 0.24（+15.0%） |

`micro` 分解（把每次启动索引读取拆成 O(字节) 子步骤，CPU ms 中位数）：

| 记录数 | 读文件字节 | `JSON.parse` | `sha256(bytes)` | archive `readdir+filter+sort` |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 0.061 | 0.118 | 0.044 | 0.010 |
| 500 | 0.158 | 1.798 | 1.172 | 0.044 |
| 5,000 | 2.019 | 9.906 | 3.958 | 0.936 |
| 20,000 | 5.420 | 38.268 | 13.264 | 2.418 |

`micro` 的四行各自独立计时：`archiveSort` 的 `readdir+filter+sort` **不在** `indexRead` 的
计时窗口内，`indexRead` 只含读文件、`JSON.parse`、整文件 sha256 与逐记录校验。

**分类结论：**

- **固定开销**：`usageRead` 在四档均为 0.21–0.24 ms（一次 `stat` + 一次 `readFile` +
  一次 `JSON.parse` 的小投影，与记录数无关）；`review` 的 50 条上限使其从 9.02 ms 升到
  277 ms 主要来自索引全量 `readSharedIndex()` 与两份 consumer state 读取，而不是逐记录验证。
- **合理增长（完整性下界）**：`indexRead` 的 `JSON.parse` + 逐记录 `validateSharedRecord`
  + 整文件 `sha256` 都随索引字节线性增长；20k 档 sha256 13.26 ms 仅占 `indexRead` 约 6%，
  parse 38.27 ms，其余约 170 ms 是逐记录校验。这是每次启动都必须做的认证，不是可消除的重复。
- **合理增长（防篡改）**：`sourceVerify` 从 7.52 ms 升到 2,856.67 ms，是 doctor 每记录
  3 次 `lstat` + 2 次 `readFile` + 2 次 sha256 的直接代价。**但该工作负载每次先做一次完整的
  `readSharedIndex()`**，所以它的绝对值和整次 `doctor` 同量级（5k: 635.63 vs 672.06 ms；
  20k: 2,856.67 vs 2,837.75 ms），不能读成"doctor 内源码校验占 95%–100%"——两者都包含一次
  索引认证，而 doctor 还包含更多 check。可支持的结论是：doctor 的成本由索引读取与逐记录
  源码校验主导，且 R12 已把同一遍检查里重复六次的激活行投影和三处 O(N²) 查找消除，
  剩余的是每条记录恰好一次的源码校验，不能再减（`§6` 反证）。
- **可消除增长**：**本轮未发现**。同一调用内不存在第二次扫描：诊断的冷历史 JSONL 与事件桥
  分别只扫一次（`scanJsonLinesFile` 分块）、`dockyard/state.json` 在同一轮只读一次
  （R12 之前的修复）、`reconcileSharedIndex()` 稳态只读一次索引、`readPublishedPluginReview()`
  的 `consumerActivationRows()` 重复投影虽仍在但受 50 条上限约束且被任务列为已否决方向。

## 3. 多入口（Desktop / ACP / Web）并发启动

`concurrent` 模式用真实子进程，3 个入口同时在同一只读夹具上做
`indexRead + reconcileIdle + sourceVerify + review`。父进程测批量墙钟，子进程各自报 CPU。
**计时边界**：这是"每个入口各做一遍只读认证"的合成负载，不是完整的 Consumer 启动——
真实启动还会调用 `writeConsumerState()`，它获取同一把 SQLite 发布锁；本表不含这部分写入，
也不含 Include 挂载与 fiber 验证。

| 记录数 | 批量墙钟中位数 | Σ子进程 CPU（indexRead / reconcileIdle / sourceVerify / review） |
| ---: | ---: | --- |
| 5,000 | 1,173.5 ms | 286.6 / 240.4 / 2,543.6 / 299.6 ms |
| 20,000 | 4,144.2 ms | 990.6 / 861.7 / 10,216.2 / 943.7 ms |

ΣCPU 远大于批量墙钟，说明三个进程确实并行执行；每个入口独立读取并校验同一份索引与源码。
本表的只读路径没有共享写锁：启动期的 `publish.json` 读取路径只有 `readFile`，
`publishSharedRecord()` 的 SQLite 独占锁只在**确实有新记录要发布**（崩溃后补发）时才进入；
`writeConsumerState()` 也拿同一把锁，但它不在本表内（见上）。跨进程共享索引解析结果需要
新的"使用前证明文件未变"协议，而仅靠 size/mtime/inode 无法证明前缀未被原地改写，正是
`redundant-work.md` §4 两次撤回的理由；硬约束也禁止把成本转移到后台或第二套协议。
**结论：每个入口各自认证是必要的，NO CHANGE。**

## 4. 桌面任务通道 1500 ms 兜底重扫

`rescan` 逐步骤镜像 `pendingRequests()`：`readdir(inbox)` → 按 `TASK_ID_PATTERN` 过滤 →
对每项**读取、解析并按 `readState()` 的规则校验** state 文档（`schemaVersion` / `protocol` /
`taskId` 任一不符即视为无状态）→ 只为排序读取 request 的 `createdAt` → 排序。
下表为显式启用入口时的空闲成本（default `disabled`，不产生此开销）：

| inbox 任务数 | 每次重扫 CPU ms | 按 1500 ms 间隔推算的每分钟 CPU ms |
| ---: | ---: | ---: |
| 100 | 4.54 | 181.6 |
| 1,000 | 32.47 | 1,298.7 |
| 5,000 | 168.09 | 6,723.4 |

随 inbox 规模线性增长，但 watcher 为 `persistent:false`，这段重扫是它漏事件时的**唯一兜底**；
降频会推迟任务拾取，移除会削弱可靠性。任务明确禁止这两种做法，故 **NO CHANGE**。
本轮不主张任何内存或 IO 收益。

**计时边界（复审修复）**：第一版只做 `access(state)` 且夹具 state 只有 `phase`，因此
0.055 ms 级别的墙钟只代表文件存在性检查，不是生产路径的成本。现在的夹具写入完整 state
文档，`rescan` 也执行与 `readState()` 相同的读取/解析/校验；上表因此比第一版高约 2–4 倍，
并且仍是**下界**：真实入口还要 `writeConsumerState()` 等写入，不在本表内。

## 5. 诊断与统一审查的重复读取

- `collectDiagnostics()`（doctor）与 `readPublishedPluginReview()`（`evolution_plan`）是
  **两个独立工具**（`registration.js:287` 与 `:346`），没有同一工具调用同时进入两者；
  `desktop-task-host.js` 也不调用它们。因此"同一进程里对同一批记录的两次源码摘要读取"在
  当前调用图上不成立：源码摘要各自只被读一次。
- `review` 的 50 条上限（`SELF_EVOLUTION_REVIEW_LIMITS.maxRecords`）使逐记录
  `readPromotedPlugin()` 最多 50 次；20k 档 review 的 277 ms 主要来自索引全量读取与校验，
  不是 50 条源码验证。`consumerActivationRows()` 在 `:839/:1033/:1069/:1075` 的重复投影
  已在 R12 被明确暂缓，任务列为"不要重提"，本轮不重新提出。
- doctor 剩余 29 个 check 中随历史字节线性增长的两项（冷历史 JSONL、事件桥扫描）在
  `collectDiagnostics()` 中各自只进一次；`diagnoseArchives()` 与 `diagnoseEventBridge()` 不
  重复扫同一文件，`dockyard/state.json` 的两次读取已合并为一次（既有修复）。

## 6. 被否决候选与反证

对每个候选，给出"若按候选改坏会怎样"的可复现反证（这是本轮 NO CHANGE 的正确性差分）：

| 候选 | 上界收益 / 成本 | 反证（候选被改坏时差分失败） | 结论 |
| --- | --- | --- | --- |
| `readSharedIndex` 跳过 `sha256(bytes)` | 20k 档约 13.26 ms（占 indexRead ≈6%） | `index.digest` 当前严格等于 `sha256(published.json)`（实测 true），宿主验收 `run-host-acceptance.mjs:877`、`run-cross-entry.mjs:994`、`cross-entry-promotion-probe.mjs:516` 依赖该等式判断索引是否被篡改；跳过即让这些断言失效。 | **否决**：认证契约，非冗余 |
| `diagnoseSharing` 跳过逐记录 `readPromotedPlugin` | 20k 档最多省约 2,856 ms（doctor ≈99%） | 把 1 条已发布插件的源码尾部追加 `// tampered` 后：当前树 `promotion.sharing` = **blocked**，`problems=[source-digest-mismatch]`、`source=source-digest-mismatch`；临时补丁树（跳过源码校验）= **degraded**、`source=verified`，篡改不再被发现。两侧 doctor 指纹 `ce2fbac5…` vs `34e3289e…` 不同，`run` 会以"指纹不等"非零退出。 | **否决**：防篡改边界，属不变量 8/9 |
| `review` 复用 doctor 的产物 / 放开 50 上限 | 无同调用路径；放开上限反而增加成本 | `readPublishedPluginReview()` 与 `collectDiagnostics()` 无共享调用点；R12 已因上限暂缓重复投影，任务列为不要重提。 | **否决**：无机制、且被明确否决 |
| 跨入口缓存已解析索引 / 增量认证 | 每入口约 46 ms@5k、225 ms@20k | 需要"使用前证明文件未变"的第二协议；仅靠 dev/ino/size/mtime 无法检测同长原地改写（`redundant-work.md` §4.1）。 | **否决**：禁止引入 O(1) 信号证明 O(历史) 状态未变 |
| Desktop 1500 ms 重扫降频 / 移除 | 100–5,000 任务时 4.54–168.09 ms/次 | watcher `persistent:false`，重扫是唯一兜底；降频推迟拾取，移除漏任务。 | **否决**：削弱可靠性，任务明确禁止 |
| `registration.js` 每工具 finally flush 改频率 | 常数成本；`axis-steady-history.md` 给出 100k 历史 61.3 ms/次 | 改频率会改变事件认证/去重时机（不变量 8）；R12 已否决 agent/pre-step flush 频率。 | **否决**：已否决方向 |
| `lib/index.js` 启动顺序"去重" | `resolveEvolutionPaths()` 两次调用均为纯路径计算、无 I/O | `storageConfig()` 读 key 一次；不存在重复磁盘读取。 | **NO CHANGE**：无可消除工作 |

反证复现（临时补丁树，用完即弃；不修改本仓库源码）：

```sh
BASE=$(mktemp -d "${TMPDIR:-/tmp}/r13-counter-XXXXXX")
cp -R lib "$BASE/r13-counter-tree-tmp" && mkdir -p "$BASE/r13-counter-tree/lib"
cp -R lib/. "$BASE/r13-counter-tree/lib/"
ln -s "$PWD/node_modules" "$BASE/r13-counter-tree/node_modules"
# 把 diagnoseSharing 里的 readPromotedPlugin 换成直接信任记录里的摘要
node -e 'const fs=require("fs");const f=process.argv[1];let s=fs.readFileSync(f,"utf8");const n="      const plugin = await readPromotedPlugin(shared, { pluginName: record.pluginName, moduleUrl: record.moduleUrl, entry: record.entry });";if(!s.includes(n))throw new Error("needle");s=s.replace(n,"      const plugin = { sourceSha256: record.sourceSha256, manifestSha256: record.manifestSha256 };");fs.writeFileSync(f,s);' "$BASE/r13-counter-tree/lib/diagnostics.js"
node scripts/benchmarks/r13-cross-entry-audit.mjs build --fixture "$BASE/r13-counter-fixture" --records 1 --archive 1
printf '\n// tampered\n' >> "$BASE/r13-counter-fixture/storages/evolution/promoted/dsh-evolution-promoted-000000000000/lib/index.js"
# 两个源码树各跑一次 doctor：当前树 -> blocked / source-digest-mismatch，补丁树 -> degraded / verified
NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/r13-cross-entry-audit.mjs \
  measure --libroot . --fixture "$BASE/r13-counter-fixture" --workloads doctor \
  --samples 1 --warmup 1 --label current --out "$BASE/current.json"
NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/r13-cross-entry-audit.mjs \
  measure --libroot "$BASE/r13-counter-tree" --fixture "$BASE/r13-counter-fixture" --workloads doctor \
  --samples 1 --warmup 1 --label patched --out "$BASE/patched.json"
```

## 7. 验证

- 交替 A/A：50 / 500 / 5,000 / 20,000 四档全部 `allFingerprintsEqual: true`；逐轮逐样本、
  配对差、离群与 RSS 保存在 `r13-cross-entry-audit*.json`。
- **50 档重建（复审修复）**：独立复核发现原 `r13-fixture-50` 的索引实际是空的，
  `sourceVerify` 的指纹等于空集合（`sha256('{"count":0,"sample":[],"allVerified":true}')`，
  前缀 `21500f57`），因此旧的 50 档数字（`indexRead` 0.22 / `sourceVerify` 0.12 /
  `review` 1.11 / `doctor` 3.60 ms）测的是空索引。已用新夹具重建并重跑，
  `indexRead` / `sourceVerify` / `review` / `doctor` 分别变为
  2.23 / 7.52 / 9.02 / 10.26 ms；`micro` 的 50 档也一并重跑。
- **夹具非空断言（复审修复）**：`run` 新增 `--expect-records <n>`，在每一轮每一侧断言
  `indexRead` 与 `sourceVerify` 看到的记录数等于夹具记录数，空集合或残缺夹具会让基准
  直接失败，而不是把空索引当成一次“很便宜”的测量。
- 反证：篡改源码后当前树 `blocked`、补丁树 `degraded`，doctor 指纹不等；
  `index.digest === sha256(published.json)` 实测为真。
- 聚焦回归（改动前后均无生产代码改动，确认子系统基线健康）：
  `NODE_OPTIONS=--max-old-space-size=4096 node --test` 覆盖 `diagnostics.test.mjs`、
  `diagnostics-performance.test.mjs`、`diagnostics-archive-streaming.test.mjs`、
  `diagnostics-streaming-bridge-scan.test.mjs`、`diagnostics-retention-floor.test.mjs`、
  `promoted-sharing.test.mjs`、`promoted-sharing-diagnostics.test.mjs`、
  `promoted-consumer.test.mjs`、`promoted-consumer-paths.test.mjs`、
  `self-evolution-review.test.mjs`、`capability-usage-scan.test.mjs`、
  `desktop-task-host.test.mjs`、`shared-plugins-cli.test.mjs` →
  **328 项，328 通过 / 0 失败 / 0 跳过**。
- 未执行：全量 `npm test`、宿主验收、`pack:check`、发布；不把未执行的检查写成通过。

## 8. 复现命令

```sh
BASE=$(mktemp -d "${TMPDIR:-/tmp}/r13-fixtures-XXXXXX")
S=scripts/benchmarks/r13-cross-entry-audit.mjs

# 1) 生成四档只读夹具（脚本从不删除传入目录）
for N in 50 500 5000 20000; do
  node "$S" build --fixture "$BASE/r13-fixture-$N" --records "$N" --archive "$N"
done

# 2) 交替 A/A（当前树 vs 当前树），每档 3 轮、独立子进程。
#    20k 档按报告记录使用 2 样本/侧、预热 1 次（`r13-cross-entry-audit-aa-20000.json`
#    的 `samples: 2` / `warmup: 1`）；其余三档 3 样本/侧、预热 2 次。
for N in 50 500 5000; do
  NODE_OPTIONS=--max-old-space-size=4096 node "$S" run \
    --baseline . --candidate . --fixture "$BASE/r13-fixture-$N" \
    --workloads indexRead,reconcileIdle,sourceVerify,review,doctor,usageRead \
    --rounds 3 --samples 3 --warmup 2 --expect-records "$N" \
    --out "docs/performance/r13-cross-entry-audit-aa-$N.json"
done
NODE_OPTIONS=--max-old-space-size=4096 node "$S" run \
  --baseline . --candidate . --fixture "$BASE/r13-fixture-20000" \
  --workloads indexRead,reconcileIdle,sourceVerify,review,doctor,usageRead \
  --rounds 3 --samples 2 --warmup 1 --expect-records 20000 \
  --out "docs/performance/r13-cross-entry-audit-aa-20000.json"

# 3) O(字节) 子步骤分解
for N in 50 500 5000 20000; do
  NODE_OPTIONS=--max-old-space-size=4096 node --expose-gc "$S" micro \
    --fixture "$BASE/r13-fixture-$N" --samples 5 \
    --out "docs/performance/r13-cross-entry-audit-micro-$N.json"
done

# 4) 三入口同时启动（真实子进程）
for N in 5000 20000; do
  NODE_OPTIONS=--max-old-space-size=4096 node "$S" concurrent \
    --libroot . --fixture "$BASE/r13-fixture-$N" --entries 3 \
    --workloads indexRead,reconcileIdle,sourceVerify,review --rounds 3 \
    --out "docs/performance/r13-cross-entry-audit-concurrent-$N.json"
done

# 5) Desktop 兜底重扫空闲成本
for N in 100 1000 5000; do
  node "$S" build-inbox --fixture "$BASE/r13-inbox-$N" --tasks "$N"
  NODE_OPTIONS=--max-old-space-size=4096 node --expose-gc "$S" rescan \
    --fixture "$BASE/r13-inbox-$N" --samples 7 \
    --out "docs/performance/r13-cross-entry-audit-rescan-$N.json"
done
```

## 9. 适用范围与风险

- 数字只反映本机 Node 26 / darwin-arm64 / 热页缓存 / 合成夹具；不代表冷盘、生产真实分布、
  其它平台或更低 V8 堆上限。`maxRSS` 是整进程高水位，不用于主张内存收益。
- 20k 档的 A/A 顺序偏移（B 偏低 4%–7%）与 50 档离群已在 §1 标注；本轮没有声称任何
  生产改动，因此没有"候选收益"需要排除噪声。
- 剩余成本均有完整性理由：每入口独立的索引认证、doctor 的逐记录源码摘要、事件桥每观测
  全量验签、归档事务 fsync。在没有新的"可证明未变"协议前，不能安全削减。
- 本轮只新增研究材料（脚本、报告、原始数据），未改 `package.json#files` 覆盖的分发文件，
  不改变 `contentSha256` 或发布固定点。
