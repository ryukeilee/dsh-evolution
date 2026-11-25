# DSH-EVOLUTION-PERF-R13-01：事件桥回收规划的重复解析消除

受理标识：**DSH-EVOLUTION-PERF-R13-01**（R13 长期运行与规模增长）。
子系统：**领域存储 / 事件桥 / 冷档案 / 数据生命周期**（`lib/event-log-checkpoint.js`）。

| 项 | 值 |
| --- | --- |
| 实际模型与档位 | `opencode-go/hy4-flash-free` High（TEAM.md 固定配置；运行标识 `hy4-flash Free`） |
| 分支 | `t3/r13-storage-lifecycle` |
| 基线 | `origin/main` = `a0380e5cf2761297ecd8ffe1c79e34865ac6baee`（本线程 HEAD） |
| 环境 | Node `v26.13.1`、`darwin/arm64`、8 逻辑 CPU、16 GiB；测量时机器上有其它 Builder 的轻量进程 |
| 夹具 | 全部由 `signEventBridgeEnvelope()` 在 `mkdtemp` 临时目录生成；未触碰正式 `DSH_HOME`、正式经验库、`event-bridge.key` 或用户数据；未改官方 DSH 源码 |

## 结论

**接受一项改动**：`planLogPrune()` 在认证已吸收前缀时已经逐行 `JSON.parse()` + HMAC 验签，原本在算出 `boundary` 后又对同一批待丢弃行做第二遍解码 + `JSON.parse()` 来投影 `prunable` 的 `{eventId, mac}`。现在把第一遍已经解析并认证的 envelope 直接投影进 `prunable`，同一字节只解析一次。计划输出（含 `prior`/`tail` 摘要、`prefixBytes`、`prunable`、`boundaryRecords`）逐字节不变，认证次数、floor、marker 剪裁与提交顺序均未改动。

隔离 A/B（交替、每轮每侧独立进程、`process.cpuUsage()` 为主指标）在 2k / 20k / 100k 条签名事件三档的 CPU 中位数分别为 **−7.16% / −11.26% / −13.74%**，三档全部轮次 B−A 为负，A/A 对照噪声 0.09% / 1.86% / 0.56%。收益随历史规模增长，因为消除的是 `O(待回收记录数)` 的重复解析，固定开销（逐字节扫描、三次整段 HMAC）不变。

## 1. 根因与源码位置

`planLogPrune()`（`lib/event-log-checkpoint.js`）在显式 `reclaim()` 里为事件桥日志计算回收 floor。基线（提交 `a0380e5`）在两处解析同一批行：

1. **认证循环**（`:466–477`）：对 `completeLineRanges()` 给出的每一行做
   `buffer.subarray(...).toString('utf8')` → `JSON.parse()` → `verifyEventBridgeEnvelope()`（canonical JSON 序列化 + HMAC-SHA256 + timingSafeEqual），再检查 writer、eventId 在 `applied` 中、MAC 相等；全部通过才 `absorbed += 1`。
2. **`prunable` 投影循环**（`:482–487`）：对前 `boundary` 行**再次**做 `subarray().toString('utf8')` + `JSON.parse()`，只取 `envelope.event.eventId` 与 `envelope.mac`。

`boundary = min(absorbed, ranges.length - keep)`，即这些行全部落在认证循环已经成功处理的连续前缀内；`verifyEventBridgeEnvelope()`（orchestrator.js:129–138）返回 `{ event: envelope.event, ... }`，其 `event` 就是传进去的同一个对象，所以两处拿到的 eventId / MAC 逐值相同。这是同一调用内的重复解析，不是可跨调用缓存的派生值：它不跨进程、不信任 mtime/size、不减少任何一次 HMAC 验签。

## 2. 改动

`lib/event-log-checkpoint.js` 的 `planLogPrune()`：

- 认证循环开始前计算 `maxBoundary = Math.max(0, ranges.length - keep)`，这是 `boundary` 的上界；只在这个上界内的行才把 `{ eventId, mac }` 存进临时的 `absorbedPairs[index]`。
- 认证通过后，原本只 `absorbed += 1`，现在同时保存该行已经解析/认证出的 eventId 与 envelope MAC。
- `prunable` 循环改为从 `absorbedPairs` 取值，不再解码、不再 `JSON.parse()`。

`absorbedPairs` 是调用内短命的稀疏数组（空行位置留空，投影时跳过），大小上界等于 `boundary`，与原本 `pairs` 的量级相同；没有跨调用状态、没有新协议。`keep`、`completeLineRanges()`、torn-tail 拒绝、`digestLogBytes()` 的三次摘要、`advanceRetention()` 与调用方的截断顺序全部未动。

## 3. 交替 A/B

脚本：`scripts/benchmarks/r13-log-prune.mjs`（runner）与 `r13-log-prune-worker.mjs`（worker）。

- **A** = `git archive a0380e5…` 物化的完整基线 `lib/` 树（软链同一份 `node_modules`）；**B** = 本工作树。
- 每个数据量级生成**一份**冻结夹具（N 条签名信封、全部 eventId 已吸收、`retainRecords: 1`，使 `boundary ≈ N−1` 以放大重复解析），A/B/A-control 读同一份 `log.jsonl` + `applied.json`。
- 每轮顺序按 `A,B,A2 → B,A,A2 → A,B,A2` 交替；每个（轮 × 侧 × 样本）起**一个独立子进程**，3 轮 × 每侧 5 样本，共 15 样本/侧/档。计时窗口只覆盖 `planLogPrune()` 调用（模块导入、夹具读取、指纹计算在区间外；2 次预热 + `global.gc()`；继承 `NODE_OPTIONS=--max-old-space-size=4096`）。
- 主指标 `process.cpuUsage()`（user+system）；墙钟、`maxRSS`、日志字节为辅助。A2 是同一基线的第二次运行，用于界定本机噪声。
- 脚本在两侧指纹不一致时仍写出 JSON 但以非零码退出；本次 `allFingerprintsEqual: true`。

逐轮 CPU 中位数（ms，每轮内为该侧 5 样本的中位数；顺序即当轮起跑位）：

| 事件数 | 轮 | 顺序 | A | B | A2 | B−A |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 2,000 | 0 | A→B→A2 | 273.1 | 253.0 | 271.7 | −20.1 |
| 2,000 | 1 | B→A→A2 | 273.8 | 251.6 | 273.9 | −22.2 |
| 2,000 | 2 | A→B→A2 | 270.9 | 252.4 | 272.1 | −18.5 |
| 20,000 | 0 | A→B→A2 | 860.5 | 758.3 | 951.0 | −102.2 |
| 20,000 | 1 | B→A→A2 | 858.0 | 786.0 | 864.7 | −72.0 |
| 20,000 | 2 | A→B→A2 | 860.7 | 737.8 | 867.0 | −122.9 |
| 100,000 | 0 | A→B→A2 | 1857.7 | 1617.3 | 1866.2 | −240.4 |
| 100,000 | 1 | B→A→A2 | 1868.3 | 1601.0 | 1866.3 | −267.3 |
| 100,000 | 2 | A→B→A2 | 1845.4 | 1486.9 | 1854.9 | −358.5 |

汇总（各侧 15 样本的 CPU 中位数；A/A 噪声 = (A2−A)/A）：

| 事件数 | 日志字节 | 迭代/子进程 | A CPU | B CPU | 相对 | A/A 噪声 | A 墙钟 | B 墙钟 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2,000 | 522,893 | 30 | 271.81 ms | 252.35 ms | **−7.16%** | +0.09% | 240.6 ms | 212.0 ms |
| 20,000 | 5,248,894 | 10 | 860.51 ms | 763.58 ms | **−11.26%** | +1.86% | 795.5 ms | 702.6 ms |
| 100,000 | 26,288,895 | 4 | 1855.87 ms | 1600.96 ms | **−13.74%** | +0.56% | 1737.7 ms | 1512.0 ms |

折算每次 `planLogPrune()`：2,000 档 9.06 → 8.41 ms；20,000 档 86.05 → 76.36 ms；100,000 档 463.97 → 400.24 ms。全部轮次 B−A 为负。**配对中位数**的分离在 2,000 / 20,000 档还伴随"B 的最大值低于 A 的最小值"（257.4 < 270.2、837.0 < 851.4），但 100,000 档两侧样本范围有重叠（A 最小 1,685.0 ms、B 最大 1,780.0 ms），所以该档只主张配对中位数，不主张样本区间完全分离。A2 与 A 接近，唯一明显离群是 20,000 档第 0 轮 A2=951.0 ms，按噪声处理、不计入收益。

**噪声与并行干扰**：测量时机器上有其它 Builder 的轻量进程，但 CPU 是配对交替的主指标，A/A 噪声均 <2%；墙钟与 CPU 同向，未被单独用来主张收益。`maxRSS` 是整进程高水位（含夹具构造/导入），三档差异不一致（2,000 档 B 高约 23 MiB，20,000/100,000 档 B 低约 3–4 MiB），不主张内存下降。

## 4. 规模趋势与成本分类

| 事件数 | A 每调用 CPU | B 每调用 CPU | 净省/调用 |
| ---: | ---: | ---: | ---: |
| 2,000 | 9.06 ms | 8.41 ms | 0.65 ms |
| 20,000 | 86.05 ms | 76.36 ms | 9.69 ms |
| 100,000 | 463.97 ms | 400.24 ms | 63.73 ms |

- **固定开销（未变）**：`completeLineRanges()` 的逐字节扫描、三次 `digestLogBytes()`（整段 prior / 尾段 tail / ambiguous 判定）、checkpoint 与事务 I/O — 改动前后一致。
- **合理增长（保留）**：认证循环对新前缀的逐行 HMAC 验签，是认证与证据保真下界，不可省。
- **可消除增长（本次消除）**：`prunable` 的第二遍逐行解码 + `JSON.parse()`，随待回收记录数线性增长；在 100,000 档约占 `planLogPrune()` 的 14%。

收益只在显式 `reclaim()` 的日志分支出现（owner 授权的低频操作），不是每次 `flush()` 的热路径；稳态 `flush()`、事件桥追加、归档事务、canary 读取均未改动，也没有把成本转移到其它阶段/入口/后台任务。

## 5. 正确性差分与反证

`test/domain-storage/log-prune-pair-reuse.test.js`（5/5 通过）：

1. **反向变换对拍**：从生产源码把候选块单点反向替回释放前的双解析实现（断言 POST 只出现一次，形状漂移即失败），在 5 种夹具形态上比较完整 `planLogPrune()` 计划的逐字段投影（含 `prior`/`tail` 摘要、`prefixBytes`、`boundaryRecords`、`prunable` 全部 pair）：全吸收、含空行、非默认 `keep`、认证在未吸收行处 break、break 前含空行 — 全部 `deepEqual`。
2. **调用计数反证**：用计数包装的 `JSON.parse` 分别对拍两侧，释放版比候选版多恰好 `prunable.length` 次解析；证明省掉的是同一批行的第二遍解析，而不是漏掉了某一行。
3. **候选被改坏时差分失败（反证）**：把候选的复用值改成陈旧 eventId（`corrupted-<index>`），同一差分立即失败并能在 `prunable[0]` 看到该值；证明比较不是恒真断言。
4. **torn tail 边界**：截断进最后一条记录时，两侧都以 `E_DOMAIN_EVENT_LOG_PARTIAL_TAIL` 拒绝，复用不绕过尾部证明。
5. **writer/key 身份**：换 writer 或篡改首个 MAC 时两侧都返回 `null`，没有跨身份复用。

功能回归（改动后实际执行）：`test/domain-storage/` **218/218**、`event-log-checkpoint` / `checkpoint-keyed-digest` / `checkpoint-read-chunks` **24/24**；聚焦差分 5/5。未跑全量 `npm test`（Lead 统一执行）；未跑宿主验收、`pack:check` 与任何发布动作。

## 6. 适用范围、负面取舍与不变量

- 不引入跨调用缓存、不信任 O(1) 元数据信号证明 O(历史) 状态未变（`redundant-work.md` §4 两次撤回的类别不适用）；复用发生在**同一次调用**、同一批已解析字节上。
- 不减少认证次数：`verifyEventBridgeEnvelope()`、writer 检查、MAC 相等检查、torn-tail 拒绝、三次整段摘要全部保留。floor 的提交顺序、marker 剪裁、证据外部化、截断幂等补完均不在本改动内。
- 代价：认证循环多一次稀疏数组写入与一个事件对象引用保留（与原本 `pairs` 的量级相同），并在循环里多了 `index < maxBoundary` 判断；净 CPU 在三档均为负，没有可测的常驻增长。
- 边界：只测 Node 26 / darwin-arm64 / 热页缓存 / 单进程 `planLogPrune`；未测冷盘、并发 `reclaim` 写者、其它 Node 版本或真实宿主分布。`maxRSS` 不是内存收益证据。
- 端到端 `reclaim()` 还包含 `prefixEvidence()` 的第二次验签、外部化、事务与 fsync；这些未改动，因此完整回收调用的绝对降幅会小于上表的函数级数字。本轮只对被改函数做隔离 A/B，不把函数级百分比外推为端到端收益。

## 7. 调查后决定不修改的方向（同子系统）

以下方向本轮以源码检查为主，未发现可证明等价且有净收益的改写；不重提已否决方向：

| 方向 | 结论 | 依据 |
| --- | --- | --- |
| 多入口并发写者（2/4 writer append/flush） | NO CHANGE | 事件桥追加由 `<log>.append.lock` 跨进程互斥，锁内只追加一条已签名信封，单批次内没有重复序列化/摘要可消；锁的陈旧owner回收规则属不变量 13，改动即第二套协议。本轮没有可证明等价的重复工作。 |
| 冷档案 `history()`/`historyView()`/retention plan | NO CHANGE | `#scanArchiveFiles`/`#archiveReadCache` 已在同一次调用内 memo 目录项、按 `dev+ino+size+mtimeNs` 复核，派生键 `derivedKeys` 也已 memo；`#historyPlanRows` 把热行/窗口行的复制边界收敛在一处。未发现同一次调用内重复扫描同一段字节。 |
| 启动回放：checkpoint / retention floor / pending 恢复 | NO CHANGE | `createEventLogKeyedDigest` 已在增长读里 fork HMAC，避免前缀重哈希；floor 检查与 replay 合并读的协议证明缺口见 `axis-steady-history.md` §6，不重提。 |
| 事件桥日志行扫描（1 MiB 分块、跨块长行） | NO CHANGE | `#walkArchiveLines`/`readEventLog` 已分块、digest-only 路径跳过切行；`whole-log 1→4 MiB chunk` 是已撤回方向，不重测。 |
| 知识身份与聚合（`__proto__` 自有键、单 key 多 revision） | NO CHANGE | `knowledgeIdentity` 已有 canonical 前缀短路；`isSensitiveKey` 有界记忆已在 R12 实施并通过差分；无新的重复工作。 |

## 8. 复现命令

```sh
# A/B（3 轮 × 每侧 5 样本；每（轮×侧×样本）独立子进程）
NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/r13-log-prune.mjs \
  --base a0380e5cf2761297ecd8ffe1c79e34865ac6baee \
  --rounds 3 --samples 5 --sizes 2000,20000,100000 \
  --out docs/performance/r13-event-log-prune.json

# 正确性差分（含反向对拍、调用计数反证、变异反证、边界）
NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/log-prune-pair-reuse.test.js

# 功能回归
NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/
NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/event-log-checkpoint.test.js \
  test/domain-storage/checkpoint-keyed-digest.test.js test/domain-storage/checkpoint-read-chunks.test.js
```

原始逐轮、逐样本数据（含 CPU/墙钟/maxRSS/日志字节/指纹）在
[`r13-event-log-prune.json`](r13-event-log-prune.json) 的 `scales[].rounds[].samples[]`。
`scripts/benchmarks/`、`docs/performance/`、`test/` 均不在 `package.json#files` 白名单，不进入分发字节；
`lib/event-log-checkpoint.js` 属分发文件，由 Lead 集成后统一重打包/验收。

## 9. 交付状态

- 允许本地 commit；**未** push、未建 PR、未合并、未打 tag、未安装正式环境、未改主工作区。
- 只报告实际执行的检查：差分 5/5、`test/domain-storage/` 218/218、checkpoint 相关 24/24、A/B 三档全部轮次 B−A 为负且 `allFingerprintsEqual: true`。
- 未执行全量 `npm test`、`pack:check`、宿主验收与发布流程，不写成通过。
