# 高频故障观测：有效 UTF-8 的档案摘要直接哈希字节

基线为 2026-11-09 合并 PR #32 后的 `main`：`b0a560280aa1946d654851247c84785be96f5dca`。
本轮只改 `lib/dockyard-domain/memory.js` 的摘要专用档案走行：当一段已解码文本是**有效 UTF-8**
时，直接把它对应的 `Buffer` 交给同一个 SHA-256 对象；无效 UTF-8 仍走原来的“解码成文本再按
UTF-8 编码”的路径。读取、行长/尾行处理、读取异常、行解析、解析缓存采用条件和持久化格式都没有
变化。没有新增缓存、后台任务、宿主依赖或发布固定点改动。

原始数据：

- [主测量（20,000 条，5 轮）](archive-digest-utf8-20261109.json)
- [独立复测（20,000 条，3 轮）](archive-digest-utf8-20261109.confirm.json)
- [边界测量（1,000 / 8,000 条，3 轮）](archive-digest-utf8-20261109.sizes.json)

复现脚本：[`scripts/benchmarks/observe-transaction-cost.mjs`](../../scripts/benchmarks/observe-transaction-cost.mjs)。

源码身份：基线 `lib/dockyard-domain/memory.js` = `53b69f25894de91f61f54d16c0f347a2d785132bfeb9e973bd464043433aa454`；
候选 = `b341b796515e8e64d1efc80da4e2203aeb406926288fd21d19a383a38f6187fa`。其余 `lib/` 文件与基线逐字节相同。

## 1. 调用链与为什么选这里

宿主两个 emit 监听器（`agent/error`、`tools/result`）→ `orchestrator.observeAutonomous()` →
`domainStorage.observe()` → `enqueue()` → `mutate()` → `hydrate()`。一次触发归档的观测事务会由
staged 实例和提交后的 live 实例各做一次“内容证明”：读取冷档案的每个文件、计算内容 SHA-256，
并与前驱解析的摘要表比较。20,000 条历史下，一次 `port.observe()` 的 `readFileSync` 合计约
9.31 MB（主测量 `port` 组），内容证明是这条高频失败观测路径里随历史线性增长的部分。

PR #32 已经删掉了摘要专用走行里无人消费的逐行切分；剩下的每次块处理仍然执行
`buffer.toString("utf8")`，把整段文本交给 `hash.update(text, "utf8")`，由 OpenSSL 再编码回
UTF-8。对有效 UTF-8，这两步是恒等变换：解码后再编码得到的字节与原 `Buffer` 完全相同，所以摘要
也完全相同。直接哈希原字节可以省掉一次字符串分配和一次重新编码，而不改变摘要、读取或错误行为。

## 2. 改动

```js
const bytes = buffer.subarray(0, lastBreak + 1);
const text = onLine || !hash || !isUtf8(bytes) ? bytes.toString("utf8") : null;
if (hash) {
  if (text === null) hash.update(bytes);
  else hash.update(text, "utf8");
}
```

- 有行消费者（`#scanArchiveRead`/索引构建）时，仍保留原来的解码文本，供逐行解析使用。
- 没有行消费者（`#archiveFileDigest`）且该块有效 UTF-8 时，直接把字节交给哈希。
- 无效 UTF-8 仍按原实现解码成带 U+FFFD 的文本再编码；该文本正是历史摘要覆盖的字节，因此继任
  实例的摘要仍与扫描摘要相同，不会因为一条无效行而退回重扫。
- `isUtf8` 来自 `node:buffer`，是 Node 内置 API；`package.json#engines` 的 22.19.0 / 24.x 均提供。
  没有新增 Cordis/官方宿主接口依赖。
- `#walkArchiveLines` 的读取、`carry`、尾行、`line` 计数、`onLine` 调用与异常路径未改。

## 3. 测量

脚本对每个格用三个独立进程：A1/A2 是从 `b0a5602` 重建的同一基线，B 是本工作树；每轮轮换起跑
顺序，先做 2 次不计时预热，再连续 16 次 `observe`。`chain` 从 `agent/error` 监听器起测到观察者
完成；`port` 只包住 `port.observe()`。每个样本独立临时根、独立进程，使用真实官方
`DomainFacility` / `JsonStorageBackend`。计时为真实 `performance.now()` 与
`process.cpuUsage()`，GC 只在预热后和采样后发生。

环境：Node `v26.13.0`、`darwin/arm64`、8 逻辑 CPU。测量期间未同时运行测试或其它基准；load
average 没有逐轮记录，不把绝对值外推到其它机器。

### 3.1 20,000 条历史，主测量（5 轮）

单位 ms；A 列为 A1/A2 两个同源基线，B 为候选；每格是各轮中位数的中位数。

| 形态 | A1 | A2 | B | wall 相对 A 均值 | CPU A1/A2 | CPU B | CPU 相对 A 均值 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| chain | 96.274 | 96.163 | 93.095 | **−3.25%** | 138.582 / 139.116 | 108.696 | **−21.72%** |
| port | 78.827 | 78.681 | 77.732 | −1.30% | 94.246 / 98.277 | 71.686 | −25.53% |

chain 的 A/A 差为 0.12%；port 的 A/A 差为 0.19%。I/O 计数两侧相同（chain 每次 11 次
`readFileSync`、9,330,628 字节；port 9,314,518 字节），没有减少落盘字节或认证字节。

### 3.2 独立复测（20,000 条，3 轮）

| 形态 | A1 | A2 | B | wall 相对 A 均值 | CPU A1/A2 | CPU B | CPU 相对 A 均值 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| chain | 96.071 | 96.112 | 93.953 | **−2.23%** | 138.366 / 140.144 | 123.649 | **−11.21%** |
| port | 78.311 | 79.689 | 77.272 | −2.19% | 98.818 / 99.094 | 70.087 | −29.17% |

chain 的 A/A 差为 0.04%。两次 20,000 条测量的 chain 方向一致，wall 收益 2.2%–3.3%，CPU
收益 11%–22%；port 的 A/A 差异本身更大（1.8%），因此只把 port 的方向作为辅助证据，不单独
声称其 wall 收益。

### 3.3 1,000 / 8,000 条边界（3 轮）

| 历史 | 形态 | A1 | A2 | B | wall 变化 | CPU 变化 |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 | chain | 45.215 | 45.381 | 46.913 | 方向不一致，不声明收益 | +2.19% |
| 1,000 | port | 44.461 | 44.156 | 42.206 | −4.74% | −3.00% |
| 8,000 | chain | 52.160 | 52.152 | 50.714 | **−2.76%** | −3.79% |
| 8,000 | port | 45.379 | 43.441 | 43.241 | −2.63%（A/A 本身 4.4%） | +0.45% |

1,000 条的 chain 只用了 3 轮，方向与 5 轮控制不一致；随后用 5 轮重测 1,000 条：A1 45.284、
A2 46.123、B 45.696，B 相对 A 均值 −0.02%，没有可测收益也没有稳定回退。因此不声称 1,000 条
有收益，也不把 3 轮的 +3.7% 当作回退。8,000 条 chain 的 A/A 差为 0.02%，−2.76% 高于它，
但只有 3 轮，仍按方向性证据看；8,000 条 port 的 A/A 差为 4.4%，其 −2.63% 落在噪声内，不声明收益。

## 4. 等价性与回归

新增/加强的回归：

- `test/dockyard-domain/archive-digest-walk.test.mjs`：对含无效 UTF-8、超长行、未终止尾行的
  文件，要求扫描发布的摘要等于“整段解码文本再编码”的历史摘要，并要求继任实例复用它而不是
  重扫；新增有效 UTF-8 文件（BOM、汉字、假名、emoji）用例，要求摘要等于原字节的 SHA-256，
  且继任实例复用摘要表。
- `test/domain-storage/archive-digest-utf8-baseline.js`：
  把本轮改动反向还原到 PR #32 的源码，再交给上一轮的 reversal 链；
  `test/domain-storage/load-projection-equivalence.test.js` 的既有差分继续通过。
- 既有 `test/observe-cache-read-fault.test.mjs`、`test/observe-cache-handoff.test.mjs`、
  `test/domain-storage/observe-transaction-boundaries.test.mjs` 继续覆盖 EACCES/EIO、继任解析
  采用/重扫和事务边界。

摘要等价论证：对有效 UTF-8，`Buffer.toString("utf8")` 的逆过程就是原字节；JSON 档案中的
换行是单字节 0x0A，不会落在多字节序列内部，因此按块取到最后一个换行后再直接哈希该块，与
“解码整段文本、再编码”得到完全相同的字节。无效 UTF-8 明确落入原路径，历史摘要不变。

## 5. 收益边界与代价

- 收益只来自 **有效 UTF-8 的摘要专用块**，随冷档案字节数增长；没有行消费者时才有。
- 20,000 条、一次 `observe` 约 9.3 MB 档案：chain wall −2.2%～−3.3%，CPU −11%～−22%。
  这是端到端端口调用，不是整次 agent 工具或应用总 CPU。
- 代价是每块多一次 `isUtf8` 扫描；命中后省掉字符串分配和一次 UTF-8 重新编码。没有新增跨调用
  状态、缓存或常驻内存。未测峰值 RSS、GC 分配字节和多平台；不声称内存下降。
- 1,000 条没有可测收益；8,000 条只有方向性证据。无效 UTF-8 档案走回退路径，性能与基线相同。
- 不改读取、认证、持久化、事务、恢复、回滚、锁或官方宿主兼容性。

## 6. 本轮实际执行的检查

- `NODE_OPTIONS=--max-old-space-size=4096 npm test`：1,456 项，1,453 通过、2 跳过、1 失败；
  唯一失败是提交前 `release-pin` 正确拒绝未提交的分发改动。提交后重跑该项应转为通过。
- 聚焦：`test/dockyard-domain/archive-digest-walk.test.mjs`、
  `test/domain-storage/load-projection-equivalence.test.js`、`test/observe-cache-read-fault.test.mjs`、
  `test/observe-cache-handoff.test.mjs` 全部通过。
- `npm run pack:check`：提交前除“工作树是固定点或已提交后继”外全部通过；该失败同样是未提交
  分发改动，提交后重跑。
- 四个官方宿主的真实安装验收由本 PR 的 CI 矩阵执行；本文件不引用未重跑的历史宿主数字。

复现：

```sh
node --max-old-space-size=4096 --expose-gc scripts/benchmarks/observe-transaction-cost.mjs \
  --compare --baseline b0a560280aa1946d654851247c84785be96f5dca \
  --histories 20000 --rounds 5 --burst 16 \
  --out docs/performance/archive-digest-utf8-20261109.json
```

## 7. 独立审核

待独立 sol-loop 审核后补记。审核只应检查本轮 `memory.js` 改动、测试与测量；没有行为改动时
不需要重开审核。
