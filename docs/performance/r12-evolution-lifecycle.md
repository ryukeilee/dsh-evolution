# R12 完整进化链路性能研究：NO CHANGE

受理标识：**DSH-EVOLUTION-PERF-R12-01**。结论：**没有找到同时具备实质净收益、可证明正确性与低长期维护成本的改动**，本轮不改生产代码。

## 1. 范围、基线与模型

| 项 | 值 |
| --- | --- |
| 分支 / 基线 | `t3/evolution-lifecycle-performance` / `719fcbb2a6405526f34ca14aa061f04220bcefec`（v0.2.21） |
| 实际模型与档位 | `opencode-go/hy4-flash-free` High（TEAM.md 固定配置；运行标识 `hy4-flash Free`） |
| 调查文件 | `lib/orchestrator.js`、`lib/promotion-include.js`、`lib/canary-verification.js`、`lib/verification-call.js`、`lib/ptc-transport.js` |
| 未改文件 | 其余 `lib/*`、`release/*`、宿主源码、正式 `DSH_HOME`、正式经验库 |

链路：`propose → trial → probe → measure → promotionGates → canary → stable → revalidation / 跨入口消费`。

## 2. 方法与隔离

- 计时：每个工作负载按 `A B A B A B` 交替，每个测量起一个**独立进程**，每进程 5 次预热 + 60 次测量。
- 主指标 `process.cpuUsage()` 的 user+system（每进程取中位数），附 `process.hrtime.bigint()` 墙钟。
- 所有夹具建在 `node:fs.mkdtemp()` 的全新临时目录；没有触碰正式 `DSH_HOME`、正式经验库、`event-bridge.key` 或用户数据。
- 同一时刻机器上可能有其他 Builder 运行。`refresh` 工作负载的 B 第 6 轮为 `0.122 ms`，而第 2/4 轮为 `0.067/0.071 ms`，属于可见的并行噪声；因此下面只把它作为量级说明，不把相对百分比当作可靠收益。
- 原始数据：[r12-evolution-lifecycle-ab.json](r12-evolution-lifecycle-ab.json)。

## 3. 候选清单

| # | 候选（源码位置） | 结论 | 理由 |
| --- | --- | --- | --- |
| C1 | `plan()` 三次取 `applicability()`（`lib/orchestrator.js:6008,6092-6093`），`reviewSelfEvolution()` 再取一次（6172） | 否决 | `runtimeVersions()` 已在 5745-5749 缓存 `detectedVersions`；`applicabilityFromVersions()` 只做三个字段的存在性判断。收益在噪声以下。 |
| C2 | `plan()` 把 `memory.data.entries` 投影一次（6026-6028），随后 `recallExperience()` 又调用 `collectFailureMemoryExperience()` 投影同一批 raw entries（5928） | 否决 | 两处上限/过滤不同：`plan` 用 `EXPERIENCE_PLAN_LIMITS`，recall 用 `EXPERIENCE_RECALL_LIMITS` 与查询过滤。复用需要改 `lib/experience-recall.js`（不在本次范围），并会改变证据投影，违反证据保真。 |
| C3 | workflow candidate 的 `probe()` 连续调用两次 `assertProbeSafety`（6757-6758） | 否决 | 两次检查的是不同步骤名：candidate 传 `candidateName`，baseline 传 `name`（6687）。合并会漏检其中一侧，属于削弱校验。 |
| C4 | `measure()` 内 `classifyExperimentDecision()` 已算过 `promotionGates`（3933），返回体又算一次（7056） | 否决 | `decision.gates` 是 8 字段投影，返回体还含 `eligible` / `workflowBenefit` / `taskBenefit`；复用需要改纯函数返回契约。两次计算都是常数级对象读取。 |
| C5 | `observeCanaryJournal()` 在 stable 提交时重读 sidecar / archive-md（8038-8040），开头已读过（7867-7868） | 否决 | 两次之间只有 `writeJournal`，可复用原始 source；但这只是每晋升一次的 ≤2 个小文件读取，且 `stableDurableSnapshot` 必须保留原始 source 优先级形状，复用会引入额外状态与分叉风险。收益低于维护成本。 |
| C6 | canary 每次观测都全量读 + 验签事件桥（7869 → 2342-2387） | **实测后否决** | 2000 条签名事件、678 KB 的日志单次 CPU 中位数 **7.756 ms**。但这是 4 级 hydration 中唯一能覆盖旧晋升的事实来源；跳过会丢掉 `source` 溯源串（`mergeEvidenceSources` 2488、`finalSnapshot.source` 8069）并改变持久化字节。以 O(1) 信号缓存 O(历史) 派生值正是 `redundant-work.md §4` 与 AGENTS 不变量 16 撤回的两项方案，不重新引入。 |
| C7 | `verifyStartupCanary()` 先 `verifyDurablePromotion()`（内部 `promotionRuntime.verify()` → `refresh()`），紧接着 `health()` 又 `verify()` → `refresh()`（8135、8142；`promotion-include.js:132-150`） | **A/B 实测后否决** | 见 §4。绝对收益 0.066 ms/会话启动，且跳过第二次 refresh 会去掉整棵 live tree 与 composition 的一致性证明。 |
| C8 | `ptcDirectCallRefusal()` 每次调用现编 `RegExp`（`ptc-transport.js:37-43,56-72`） | 否决 | 单次正则编译为微秒级；probe 最多 8 步 × 5 重复 × 2 相位。缓存需新增有界表与失效策略，净收益为负。 |
| C9 | `normalizeCanaryVerification()` 把 args/expected 各序列化两次（大小检查 + `canaryVerificationDigest()`，`canary-verification.js:57-67`） | 否决 | 输入被 8 KiB / 32 KiB 显式封顶，每次晋升只做一次；合并遍历需要重写无损验证与 `-0`/深度/环判定，风险高于收益。 |
| C10 | 观察者表、`patternThreshold`、`AUTONOMOUS_PATTERN_CAP`、terminal 记录剪枝（8514-8624） | 否决 | 全部为 `while` 删除最旧项的摊还 O(1)，上限 200；`pruneTerminalExperiments()` 只在 `size > 200` 时遍历。`inspect()` 会快照候选表（5780），但那是基线捕获的一部分。没有无界滞留或重复扫描。 |
| C11 | 在进程内维护事件桥增量证据索引，避免 C6 的全量重读 | 否决 | 其他进程/经验入口也会追加同一日志；没有“使用前再证明前缀未变”的协议。仅靠 dev/ino/长度无法证明前缀未被原地改写，正是 `redundant-work.md §4.1` 的撤回理由。 |

### 根因证据（可复现）

- C7：`lib/orchestrator.js:8135-8142` → `verifyDurablePromotion()` 的 4732 行 `promotionRuntime.verify()` → `lib/promotion-include.js:132-134` 的 `verify()` 内 `await refresh()`；`health()`（149-150）再次 `this.verify()` → 第二次 `refresh()`。两次调用之间没有 awaits 以外的写操作。
- C6：`lib/orchestrator.js:7865-7870` 把 `readEventBridgeEvidence()` 作为第 4 优先级源；`readEventBridgeEvidence()` 在 2356-2377 对每一行调用 `createEventBridgeEvidenceIndex.consume()`，后者在 2251-2256 做 `JSON.parse` + `verifyEventBridgeEnvelope()` 的 HMAC-SHA256 验签。`mergeEvidenceSources()` 2488 会把各源 `source` 串连接，`finalSnapshot.source`（8069）把它带进 durable sidecar。

## 4. 交替 A/B（每轮独立进程，CPU 主指标）

### C7：include refresh 去重

| 轮 | 顺序 | A = 现状（verify+health，两次 refresh）CPU / 墙钟 | B = 跳过第二次 refresh CPU / 墙钟 |
| --- | --- | --- | --- |
| 1 | A | 0.138 / 0.120417 ms | — |
| 2 | B | — | 0.067 / 0.061458 ms |
| 3 | A | 0.137 / 0.125750 ms | — |
| 4 | B | — | 0.071 / 0.061709 ms |
| 5 | A | 0.134 / 0.121792 ms | — |
| 6 | B | — | 0.122 / 0.116417 ms |
| **中位数** | | **0.137 / 0.121792 ms** | **0.071 / 0.061709 ms** |

绝对差 **0.066 ms CPU/次**，相对该子操作约 48%，但每会话启动只发生一次，端到端不可测；第 6 轮 B 明显受并行噪声影响，不能把 48% 当成稳定收益。

### C6：事件桥重读

| 轮 | 顺序 | A = 现状（读+验签 2000 条）CPU / 墙钟 | B = 不读（仅上界，非正确实现）CPU / 墙钟 |
| --- | --- | --- | --- |
| 1 | A | 8.527 / 9.225375 ms | — |
| 2 | B | — | 0.001 / 0.000875 ms |
| 3 | A | 7.756 / 7.904083 ms | — |
| 4 | B | — | 0.001 / 0.000834 ms |
| 5 | A | 7.628 / 7.397125 ms | — |
| 6 | B | — | 0.001 / 0.000875 ms |
| **中位数** | | **7.756 / 7.904083 ms** | **0.001 / 0.000875 ms** |

相对降幅接近 100%，但 B 不是可采纳实现：它把唯一的旧晋升事实来源与溯源串一起删掉。若要减少这部分 CPU，只能改变认证/持久化协议，超出本轮的“不得削弱证据保真”边界。

单进程微基准（20 次热身后取中位数）：`verify()` 0.099 ms CPU、`health()` 0.101 ms、纯 resolve 0.002 ms；2000 条事件桥 7.337 ms CPU / 6.811 ms 墙钟。

## 5. 正确性差分与反证

本轮没有生产代码改动，因此不存在“修复前失败/修复后通过”的改动差分。对已否决候选的反证如下：

- C7：把 B 当作候选时，`health()` 不再执行 `refresh()` 内的 `isDeepStrictEqual(tree.root.data, entries)`（promotion-include.js:112-114）。构造一处 out-of-band 的 composition 行改动，A 会拒绝、B 会把已失效行仍判 active —— 这是**削弱验证**，不是等价优化。
- C6：把 B 当作候选时，`mergeEvidenceSources()` 的 `source` 少一段 `event-bridge`，`finalSnapshot.source` 与最终 sidecar 字节改变；对于 journal/sidecar 都不存在的旧晋升，A 能恢复证据而 B 返回“无证据”。这与 AGENTS 不变量 2/8/16 直接冲突。
- C3/C4/C9：候选要么改变校验覆盖面，要么改变纯函数返回契约；没有做到“同输入逐字段/逐字节一致”。

基线健康：148 项聚焦测试全部通过（见下）。

## 6. 适用范围、负面取舍与剩余瓶颈

- 适用结论只针对本工作树、Node v26.13.1、合成夹具与上述负载；不代表真实宿主长时间运行的最优。
- 没有做真实模型配对会话、真实宿主升级重验证或正式经验库采样；这些路径的 token/等待成本仍未量化。
- 剩余成本主要是事件桥每观测一次的全量认证（随历史线性增长）、每次晋升的证据摘要与 journal fsync，以及 `inspect()` 对整份运行时的无损快照。每项都有完整性理由，当前没有可证明安全的削减方式。
- 负面取舍：选择不引入任何新缓存、不跳过任何校验、不改纯函数契约；放弃的收益上限分别为 0.066 ms/启动与 7.756 ms/观测（后者不可安全实现）。

## 7. 复现

```sh
# 基线与 A/B（脚本在临时目录，夹具用 mkdtemp；需要 node_modules）
for w in refresh bridge; do
  for seq in A B A B A B; do
    R12_REPO="$PWD" R12_MODE="${seq:0:1}" R12_WORKLOAD="$w" R12_ITER=60 \
      NODE_OPTIONS=--max-old-space-size=4096 node <bench2.mjs>
  done
done

# 聚焦回归
NODE_OPTIONS=--max-old-space-size=4096 node --test \
  test/runtime-inspect.test.mjs \
  test/experience-evolution-lifecycle.test.mjs \
  test/review-fix-canary-conclusion-metrics.test.mjs \
  test/orchestrator-durability-stable-commit-evidence.test.mjs \
  test/promoted-consumer.test.mjs \
  test/capability-usage-scan.test.mjs
```

聚焦测试结果：`148 tests / 148 pass / 0 fail / 0 skipped`。未跑全量 `npm test`（由 Lead 统一执行）；未跑 `pack:check` 与任何发布验收。

## 8. 产物

- `docs/performance/r12-evolution-lifecycle.md`：本报告。
- `docs/performance/r12-evolution-lifecycle-ab.json`：逐轮 CPU/墙钟、微基准与测试计数。
- 基准脚本为研究用临时文件，不入库；复现步骤与参数已完整记录在本节与 JSON 的 `method` 字段。
