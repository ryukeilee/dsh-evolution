# 首次重放：staged save 检查按记录记忆

## 结果

基线 `main` 的 `9c7c103`，候选是在它之上的一次改动：staged replay 工作副本的
save 检查把每个集合数组元素（热窗记录）**每事务判定一次并深冻结**，之后每次
save 只序列化窗口外的少量成员，而不是把整份非窗口文档重新序列化。

真实官方 `DomainFacility` / `JsonStorageBackend`，无 replay checkpoint 的首次吸收，
每样本独立进程与临时数据根，交替 A/B 各三轮（中位数）：

| 记录数 | 墙钟 ms：基线 → 候选 | CPU ms：基线 → 候选 | 稳态 observe | 稳态 flush |
| ---: | --- | --- | --- | --- |
| 2,000 | 234.1 → 166.0（**−29.06%**） | 251.0 → 185.2（**−26.21%**） | +0.47% | −1.00% |
| 12,000 | 1,237.1 → 827.2（**−33.14%**） | 1,320.8 → 919.8（**−30.36%**） | −1.32% | +0.24% |
| 20,000 | 2,062.1 → 1,372.9（**−33.42%**） | 2,196.3 → 1,512.9（**−31.12%**） | +0.34% | +0.14% |
| 50,000 | 5,048.7 → 3,314.6（**−34.35%**） | 5,318.5 → 3,621.5（**−31.91%**） | +0.83% | −0.98% |

同码 A/A 控制（两侧都跑候选树，同夹具、同参数、交替三轮）：

| 记录数 | 墙钟差 | CPU 差 | 峰值 RSS 差 | 保留堆差 |
| ---: | ---: | ---: | ---: | ---: |
| 2,000 | −2.38% | −0.25% | −0.1 MiB | 0.0 MiB |
| 12,000 | +0.14% | −0.41% | +21.9 MiB | −6.0 MiB |
| 20,000 | +0.95% | +0.31% | −0.3 MiB | 0.0 MiB |
| 50,000 | −1.06% | −0.05% | 0.0 MiB | 0.0 MiB |

每个规模的 A/B 收益都远超同码漂移；稳态路径（无积压事件）不受影响。

**不声称峰值内存收益。** A/B 的峰值 RSS 差（2k/12k/20k/50k：−0.7 / +0.1 / −8.2 /
−9.6 MiB）落在同码 A/A 漂移内（12k 一轮 A/A 就有 +21.9 MiB），保留堆差同样在
同码漂移内。为什么这轮优化不改峰值，见下文“成本与边界”。

源码、测试、基准与证据：

- 源码提交：`db812f0`（本文件与基准证据随后单独提交，不改变分发内容）。
- 候选源哈希：`lib/domain-storage.js` `848ba8c92a4185856db6bbc925cc5eae3e816c846e7a859dcfae83040ff07fb8`；
  `lib/dockyard-domain/memory.js` `99e0870a3a0f5e68f067d4e75e040c541c033c0d332339e7eb55e9f57f03d44e`。
- 原始数据：[A/B](replay-staged-element-save-check.json)、
  [A/A](replay-staged-element-save-check-aa.json)、
  [50k A/B](replay-staged-element-save-check-50k.json)、
  [50k A/A](replay-staged-element-save-check-aa-50k.json)、
  [持久字节等价](replay-staged-element-save-check-equivalence.json)、
  [50k 持久字节等价](replay-staged-element-save-check-equivalence-50k.json)、
  [I/O 计数](replay-staged-element-save-check-io.json)、
  [阶段 heap（event-log-replay-memory A/B）](replay-staged-element-save-check-heap.json)
  与其 [逐样本 ledger](replay-staged-element-save-check-heap.jsonl)。

环境：Node `v26.13.0` / `darwin-arm64` / 8 逻辑 CPU。测量期间机器为共享状态，
采集开始/结束 load average 约 `4.8/3.9/2.5`；A/A 控制与逐轮顺序交替用于约束这个
噪声，超过同码漂移的结论只来自 A/B。

## 成本与改动

`registration.js` 在 `agent/pre-step` 与每个工具结束时调用 `flush()`；无检查点时一次
首次吸收会把日志里的每条记录认证、投影，最后由**一次** `mutate()` 事务应用并提交。
那条事务里的 `EvolutionMemory` 每次 append 都保存一次，每次保存都经过
`assertStagedTransactionSave()`：它只替换 marker 窗口，随后序列化**整份非窗口文档**来
证明文档仍可被 JSON 表示且不含 own-`__proto__` 字面量。

20,000 条时每次保存的壳有 27.1 KB，其中 `evolution.experiments` 热窗（50 条）占
26.0 KB ≈ 95.8%；20,000 次保存合计约 322.7 MB 字符，是当前首次吸收 CPU 的第一大项
（既有的[分项归因](staged-save-check.md)与[首次吸收归因](first-startup-absorption-attribution.md)
已记录该形状，本轮复测一致）。窗口复制（每条一次 4095 指针复制 + 冻结）是第二大项。

本轮只改检查的实现，不改它判定的东西：

- `createStagedWindowChecks({ elementChecks: true })` 在 replay 的私有工作副本上额外
  打开一个每事务的 `WeakMap`；其他任何事务（observe、reclaim、compact、hydrate、
  直接构造的 `EvolutionMemory`）完全走原来的检查。
- 每次 save 先把文档里每个非空、原生、稠密、无 own `toJSON` 的集合数组替换成
  `EMPTY_WINDOW`，按文档键序得到壳；壳仍按原来的顺序与方式序列化。
- 每个数组元素（热窗记录）第一次出现时：迭代审计它只由 JSON 可表示的值、普通对象/
  数组、数据属性组成（拒绝函数、symbol、bigint、accessor、class 实例、稀疏数组、
  环）；序列化它一次并检查 own-`__proto__` 字面量；通过则**深冻结**整棵值并把
  `false` 判定记进 `WeakMap`。已有判定的元素不再序列化。
- 任何元素无法审计、文本含字面量、或元素不是对象，都回退到原来的
  `assertTransactionSave(payload)`（整份、未改动文档）；元素先于壳判定，所以回退时
  第一个抛错的值与错误和原来相同。深冻结只发生在事务私有的 `structuredClone` 工作
  副本上（发布的是 store 自己的 `structuredClone`，不带冻结状态）。

## 等价性

检查只决定两件事：文档能否被 `JSON.stringify` 表示（第一个不可表示的值在哪里抛），
以及文档文本是否含 own-`__proto__` 字面量。两件事都可以按“壳 + 每个元素”组合：

- 表示性：被审计的元素只含 JSON 可表示的值且已冻结，`JSON.stringify` 对它不可能抛；
  壳按原文档键序串行化其余成员，所以第一个不可表示的值仍按原顺序抛出同一错误。元素
  审计失败时整份回退，抛错位置与错误就是原实现的。
- 字面量：`JSON.stringify` 把每个值写成完整 JSON，值之间的分隔符不可能拼出这 11
  字节字面量，所以整份含它 ⇔ 壳含它或某个元素含它。任一命中都回退整份检查（包括
  递归去键拷贝可能溢出的情形）。
- 冻结：判定只有在值不可变时才能复用；冻结由检查器自己施加，不是假设。任何不能
  证明的值都回退，不发布判定。
- 门控：只有 replay 的 `mutate()` 请求这一模式；其他事务的 payload、失败时机、
  stage/pending/commit token 路径不变。

持久字节由 benchmark 的 `--validate`（冻结时钟与 UUID）逐字节核对：2,000 / 12,000 /
20,000 / 50,000 四个规模的 archive 树（2/2/3/4 个文件）、领域文档摘要
（`e2123704…` / `0496b014…` / `4a233c8…` / `5ac64f28…`）、checkpoint 内容与
query 投影全部相同，marker 数等于记录数，staged 残留为 0。

新增回归：

- `test/domain-storage/staged-save-elements.test.js`：21 类载荷上元素路径与
  `assertTransactionSave()` 的抛出结果逐项相同；每个元素只序列化一次；新元素在自己
  的 save 上判定；字面量/不可审计元素回退且不冻结；判定不跨事务复用；未开启时行为与
  原先一致；窗口证书与元素证书共存。
- `test/domain-storage/staged-element-memo-baseline.js`：把本轮改动从工作树精确反向，
  使既有的 rc.8 与 load-projection 差分基线继续逐字节重建（反向链里作为最新一轮）。
- 既有 `staged-save-check.test.js` 的 43 类载荷差分、`staged-window-incremental.test.js`
  的证书/失效/计数、`transaction-save-validation.test.js` 的抛点等价与“每记录恰好一次
  payload stringify”、`replay-batch-commit.test.js` 的组提交/恢复/4096 窗口，以及
  `execution-event-save-coalescing.test.mjs` 对 9 种事件类型的 durable base64 pin
  都继续通过；它们现在同时覆盖元素路径。

验证：`NODE_OPTIONS=--max-old-space-size=4096 npm test` 1490/1492 通过、0 失败、
2 跳过（既有跳过）；官方宿主验收见下方交付记录。

## 测量方法

- 脚本：[archive-append-window.mjs](../../scripts/benchmarks/archive-append-window.mjs)。
  基线由 `git archive 9c7c103 lib package.json package-lock.json` 解到临时树，
  `node_modules` 链接本仓库依赖；两侧各跑独立进程、独立夹具根，顺序逐轮交替。
  吸收阶段单独计时；稳态 observe/flush 也一起报告，用于确认没有把成本挪到别处。
- 字节等价：`--validate` 冻结 `Date` 与 `randomUUID()`，导出 durable 文档、整棵归档
  树、checkpoint 内容与 query 投影后逐项比较。
- I/O：`BENCH_AUDIT_MODULE=scripts/benchmarks/replay-io-audit.mjs` 在吸收窗口内包裹
  `node:fs` / `node:fs/promises` 入口，按调用点计调用数与字节。它是 JS API 计数，
  不是内核 syscall 或物理磁盘流量。20,000 条时两侧完全相同：`readFileSync` 10 次 /
  32.7 MB、`readSync` 88 次 / 34.2 MB、`openSync` 101 次、`appendFile` 79 次 /
  9.95 MB、`writeFile` 3 次 / 8.39 MB、`fsyncSync` 10 次、`statSync` 181 次；2,000 /
  12,000 档同样逐项相同。这符合改动只影响内存中的序列化、不影响读写调用的预期。
- 阶段 heap：另用 [event-log-replay-memory.mjs](../../scripts/benchmarks/event-log-replay-memory.mjs)
  在基线 worktree 与候选树之间做同样的三轮 A/B（`--baseline-root`）。12k/20k 的
  `preCommit` 与 `committed` 阶段 heapUsed/arrayBuffers 在噪声内；20k 的进程
  maxRSS 中位数 255.9 → 250.0 MiB，但 12k 是同码上下的反向偏移，因此不据此宣称
  内存下降。

复现：

```sh
node --max-old-space-size=4096 scripts/benchmarks/archive-append-window.mjs \
  --baseline-ref 9c7c103 --records 2000,12000,20000 --rounds 3 \
  --out docs/performance/replay-staged-element-save-check.json
node --max-old-space-size=4096 scripts/benchmarks/archive-append-window.mjs \
  --aa --records 2000,12000,20000 --rounds 3 \
  --out docs/performance/replay-staged-element-save-check-aa.json
node --max-old-space-size=4096 scripts/benchmarks/archive-append-window.mjs \
  --baseline-ref 9c7c103 --validate --records 2000,12000,20000 \
  --out docs/performance/replay-staged-element-save-check-equivalence.json
BENCH_AUDIT_MODULE="$PWD/scripts/benchmarks/replay-io-audit.mjs" \
  node --max-old-space-size=4096 scripts/benchmarks/archive-append-window.mjs \
  --baseline-ref 9c7c103 --records 2000,12000,20000 --rounds 3 \
  --out docs/performance/replay-staged-element-save-check-io.json
node --max-old-space-size=4096 --expose-gc scripts/benchmarks/event-log-replay-memory.mjs \
  --records 2000,12000,20000 --rounds 3 --baseline-root /tmp/dsh-base-replay-memory \
  --out docs/performance/replay-staged-element-save-check-heap.json \
  --ledger docs/performance/replay-staged-element-save-check-heap.jsonl
```

比例结论只适用于本机 Node 26 / darwin-arm64、热页缓存的合成 measurement 事件负载。
收益来自“每条记录一次完整事务保存”的形状；积压只有 1 条、或由 LLM/磁盘提交主导的
路径收益更小；稳态 observe/flush 不变。2,000 与 12,000 的稳态 observe 差值
（+0.47% / −1.32%）与 A/A 控制同量级，不当作回归或收益。

## 交付记录

- 全量回归：`NODE_OPTIONS=--max-old-space-size=4096 npm test` → 1490 pass / 0 fail /
  2 skip（既有 skip）。
- `npm run pack:check`（开发语义）：17/17；工作树是固定点的已提交后继，未改
  `release/`。
- 官方宿主验收：用本轮 `release:pack` 产物（content sha256
  `be1ba287…`、tarball sha256 `ce827a3d…`）在隔离临时 runtime/home 中各跑一次完整
  21 步，四个声明宿主全部通过、最终 doctor `degraded`（已知的 5 项
  degradedCapabilities，无 blocked）：`docs/evidence/replay-staged-element-save-check-dsh-0.2.0-rc.2.json`、
  `…-0.2.1-alpha.1.json`、`…-0.2.1-rc.2.json`、`…-0.2.2-rc.1.json`（最后一份带
  `--no-hmr`，与 CI 的该宿主行一致）。第一次重跑时当前会话的 `DSH_PROFILE` /
  `DSH_PROFILE_DIR` 环境变量泄漏进宿主子进程导致 4 个宿主都在 core-flow 的 live
  doctor 上失败；用未修改的基线产物可复现同一失败，清掉这些变量后同一产物 21/21
  通过，因此该失败是采集环境问题，不是本改动。失败的原始记录未保留为证据。
- 未合并、未发布；`release/` 固定产物未变。
