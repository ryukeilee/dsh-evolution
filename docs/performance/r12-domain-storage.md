# DSH-EVOLUTION-PERF-R12-01：领域存储 / 事件桥 / 冷档案子系统的开放性性能研究

执行者模型：`opencode-go/hy4-flash-free`（High，按 `TEAM.md` 固定配置；本线程路由）。
分支：`t3/domain-storage-performance`，基线提交 `719fcbb2a6405526f34ca14aa061f04220bcefec`（v0.2.21）。
环境：Node `v26.13.1`、`darwin/arm64`、8 逻辑 CPU；所有计时子进程带 `--max-old-space-size=4096`。

## 结论

**接受一项改动**：把 `lib/dockyard-domain/memory.js` 的纯函数 `isSensitiveKey(key)` 做成
有界 FIFO 记忆（512 项，仅缓存原始字符串键）。它位于脱敏边界 `redact()` 的每一字段
热路径上；当前代码的 CPU profile 显示 `isSensitiveKey` 及其 `.some` 回调合计约占
首次冷吸收采样的 9–12%。20,000 条已签名事件的交替 A/B（4 轮、每侧每轮独立进程、
`process.cpuUsage` 为主指标）显示冷吸收 CPU 中位数 **1245.1 → 1080.4 ms（−13.23%）**，
墙钟 **1099.8 → 931.5 ms（−15.31%）**；同码 A/A 为 CPU +3.21% / 墙钟 +3.18%（噪声）。
强制 GC 后的保留堆两侧完全相同（19.42 MiB），峰值 RSS 差异落在 A/A 散布内。
稳态 `flush()` 与 `observe()` 是不变的对照组，不声称收益。

其余调查方向均为 NO CHANGE，理由见「候选清单」。

## 1. 根因证据与复现

### 1.1 源码位置

- `lib/dockyard-domain/memory.js:73-109`（改动后）：`SENSITIVE_KEY_PARTS`（8 个敏感子串）、
  512 项 `sensitiveKeyCache`、`isSensitiveKey()`。
- 原实现（`lib/dockyard-domain/memory.js:77-80`，改动前）：

  ```js
  function isSensitiveKey(key) {
    const normalized = String(key).toLowerCase();
    return SENSITIVE_KEY_PARTS.some((needle) => normalized.includes(needle));
  }
  ```

- 调用者 `redact()`（`memory.js:111-134`）：对每个数组元素以 `""` 调用一次，对每个对象
  成员以 `Object.entries()` 的键调用一次；`safeRecord()`（`memory.js:134`）及
  `applyExecutionEvent()` / 各投影函数（`memory.js:4379,4508-4524,4782,4885-4960` 等）
  在每条事件的摄入路径上反复进入它。

原实现的每次调用做 1 次 `String()` + 1 次 `toLowerCase()` 分配 + 8 次 `includes()`。
同一个字段名（`""`、`"id"`、`"status"`、`"eventType"`、`"measurement"`、`"latency"`…）
在同一份文档乃至跨事件被重复判定；这是纯函数重复计算，不是对历史状态的 O(1) 近似。

### 1.2 CPU profile 归因（改动前，基线代码）

用真实 `openDomainStorage()` + 官方 `DomainFacility`/`JsonStorageBackend`，20,000 条
`signEventBridgeEnvelope()` 签名的合成事件，冷吸收 + 6 次稳态 flush + 6 次 observe，
`node --cpu-prof --cpu-prof-interval=200`（共采样 1695.4 ms）：

| 帧 | self ms | 占比 |
| --- | ---: | ---: |
| `isSensitiveKey @ memory.js:77` | 107.7 | 6.4% |
| `(anon) @ memory.js:79`（`.some` 回调） | 44.9 | 2.6% |
| `redact @ memory.js:82` | 44.6 | 2.6% |
| `assertStagedTransactionSave @ domain-storage.js:1708` | 108.3 | 6.4% |
| `structuredClone` | 93.6 | 5.5% |
| `(idle)` | 94.5 | 5.6% |

`isSensitiveKey` + 其回调 + `redact` 合计约 197 ms / 1695 ms ≈ 11.6%。前两项
（152.6 ms）是本次可删的工作；`redact` 自身的递归与 `Object.fromEntries` 保留。

隔离微基准（同一机器，200 万次调用，键集为真实事件里出现的 30 个字段名）：

| 实现 | CPU ms | 归一化 |
| --- | ---: | ---: |
| 原实现（每次 compute） | 107.9 | 1.00 |
| 有界记忆（本次） | 24.9 | 0.23 |
| 单条 alternation 正则 | 37.9 | 0.35 |

三种实现的布尔结果累加器完全相同（266664）。正则在长/恶意键上引入回溯面，比记忆慢，故不采用。

## 2. 改动

`lib/dockyard-domain/memory.js`：新增 `SENSITIVE_KEY_CACHE_MAX = 512` 与模块级
`sensitiveKeyCache = new Map()`；`isSensitiveKey()`：

- **仅** `typeof key === "string"` 时查缓存；命中直接返回布尔值；未命中计算后写入。
  非字符串键（可能带状态化 `toString`）走原计算路径，语义逐字节不变。
- 上限 512，满时删除 `Map` 插入序最旧项（FIFO）。键来自被脱敏载荷，不可假设有界，
  故必须设上限；512 远大于正常文档的字段种类数，命中率接近 100%。
- **只记住长度不超过 128 的键**（`SENSITIVE_KEY_CACHE_KEY_MAX`）。独立复审用 128 个
  约 512 KiB 的不同 `secret-` 字段名复现出：仅靠“512 条”并不能限制内存，因为 `Map`
  保存的是调用方的原始字符串（基线强制 GC 后堆增量约 0.65 MiB，首版约 63.63 MiB）。
  超长键现在只计算、不保留；真实字段名远低于 128，命中率不受影响，最坏保留字节上界是
  `512 × 128` 个字符。
- 用 `Map` 而非对象，`__proto__` 等键保持普通条目；缓存值恒为布尔，`!== undefined`
  即可判命中。

**没有削弱的边界**：`redact()` 的判定规则（`SENSITIVE_KEY_PARTS`、8 个子串、
`includes` 语义）逐字未改；缓存只替代同一纯函数的重复求值；脱敏决策、持久化字节、
去重、认证、事务、恢复、跨入口兼容均不变。

## 3. 交替 A/B

脚本：`scripts/benchmarks/sensitive-key-memo.mjs`（runner）与
`sensitive-key-memo-worker.mjs`（worker）。A = 在临时 `lib/` 副本里把记忆块反向还原成
原函数；B = 当前工作树。两侧同一份冻结夹具（每侧每轮由 `signEventBridgeEnvelope()`
以固定 key/sequence 生成，SHA-256 一致，脚本断言全轮唯一），每个样本一个全新子进程，
顺序 A,B → B,A → A,B → B,A，主指标 `process.cpuUsage()`（user+system），同时记录墙钟、
`maxRSS` 与强制 GC 后保留堆。A/A 用同一份代码跑同样 4 轮以界定噪声。

绝对值为每侧 4 轮的中位数；相对值 `(B−A)/A`。原始数据：
[`sensitive-key-memo.json`](sensitive-key-memo.json)、
[`sensitive-key-memo-aa.json`](sensitive-key-memo-aa.json)。

| 指标 | A（原） | B（记忆） | 相对 | A/A 噪声 |
| --- | ---: | ---: | ---: | ---: |
| 冷吸收 CPU ms（20k） | 1245.1 | 1080.4 | **−13.23%** | +3.21% |
| 冷吸收墙钟 ms（20k） | 1099.8 | 931.5 | **−15.31%** | +3.18% |
| 稳态 flush CPU ms | 12.58 | 12.02 | −4.4%（对照，无此路径） | A/A 亦摆动，不声称 |
| observe CPU ms | 48.10 | 47.65 | −0.93%（对照） | A/A +13.15%（噪声） |
| 强制 GC 后保留堆 MiB | 19.42 | 19.42 | 0 | 两侧恒等 |
| 峰值 RSS MiB | 286.6 | 289.5 | +2.9 | A/A 286.7 → 288.2（同量级）；Lead 复跑 285.7 → 294.9，见下 |

逐轮冷吸收 CPU（ms，配对顺序即当轮起跑位）：

| 轮 | 顺序 | A | B | B−A |
| ---: | --- | ---: | ---: | ---: |
| 1 | A→B | 1267 | 1092 | −175 |
| 2 | B→A | 1223 | 1055 | −168 |
| 3 | A→B | 1208 | 1069 | −139 |
| 4 | B→A | 1568（离群） | 1117 | −451 |

除第 4 轮 A 出现后台负载离群外，B 的每一轮都低于 A；B 的最大值 1117 仍小于 A 的
最小值 1208，分离干净。A/A 的同码散点（1433/1162/1141/1225 对 1374/1374/1142/1242）
说明本机背景负载确实存在，但不足以解释 A/B 的系统性差距。以 CPU 为主指标是因为
同一时刻可能有其他 Builder 在跑，墙钟只作参考。

Lead 在复审修复（超长键不保留）后用同一脚本独立复跑（`r12-lead-sensitive-key-memo.json`，
4 轮、机器上无其它基准）：冷吸收 CPU 1111.3 → 980.6 ms（**−11.76%**），墙钟 −13.89%；
强制 GC 后保留堆 20,360,900 对 20,367,760 B（差异 6.8 KB）；峰值 RSS 285.7 → 294.9 MiB。
两次 Lead 复跑都看到 B 侧 maxRSS 高约 3–9 MiB，而保留堆相同：512 条 ≤128 字符的字符串
不可能解释这个量级，判定为进程高水位/GC 时机的系统性偏移，不把它写成收益或回退，也不
据此声称内存下降。

磁盘与字节：该优化不读写文件；`FileHandle.sync()`、文档写入、读日志字节在两侧完全相同
（稳态 flush 的对照组也确认无 I/O 变化）。收益是纯 CPU/分配。

## 4. 正确性差分

1. **纯函数逐键差分**：`test/dockyard-domain/sensitive-key-memo.test.js` 从生产源码
   `memory.js` 抽取真实记忆块，写成临时模块并 import，与逐字复制的改动前实现比较：
   - 固定语料 52 项：普通字段名、8 个敏感子串的各种大小写/连字符形态、`__proto__`/
     `constructor`/`toString`、Unicode/emoji、500 字符长键、前后缀敏感词——逐项相等；
   - 先喂 2000 个不同键越过 512 上限触发 FIFO 淘汰，再重查上述全部键——仍相等；
   - 再喂 64 个约 256 KiB 的超长键：答案仍与重算实现相同，且缓存条目数不增加
     （超长键不保留）；
   - 非字符串输入（状态化 `toString`、`undefined`、`null`、数字）——走原路径且相等。
2. **反证（变异检验，证明差分有牙）**：把缓存键改成 `key.slice(0,1)`（不同键碰撞、
   返回陈旧值）后，同一语料立即与原实现分叉，用例断言该变异必须被抓到。
3. **持久字节差分锚点**：`test/domain-storage/load-projection-equivalence.test.js` 用
   `test/domain-storage/sensitive-key-memo-baseline.js` 的反向块把改动反转，重建出的
   `memory.js` SHA-256 仍等于既有 pin `2c1039ee…`；两侧在冻结时钟/确定性 UUID 下
   提交逐字节相同的状态。新增反向块是单点精确匹配，形状漂移会直接失败。
4. **功能回归**：`test/dockyard-domain/` 223/223、`test/domain-storage/` 213/213、
   脱敏相关聚焦 39/39 全绿（改动后实际执行）。

## 5. 适用范围与收益边界

- 收益来自“同一字段名的重复判定”，因此随摄取/脱敏的记录数线性增长；只在会走
  `redact()`/`safeRecord()` 的路径上有效（事件摄入、observe、各投影、召回、诊断）。
- 稳态 `flush()` 不调用 `redact()`，是无收益对照组（实测不变）。
- 收益随字段名重复度增长；若每条事件都带全新随机键（正常事件不会），缓存退化为
  compute + 一次 Map 写，仍是正确实现且上限有界。
- 峰值 RSS 比 A 高约 2–3 MiB，落在 A/A 散布内；保留堆完全相等，所以这不是缓存
  常驻增长（512 个字符串+布尔约数十 KiB），只能归因于 GC/JIT 时机差。不声称内存收益。
- 只测了 Node 26 / darwin-arm64 / 热页缓存 / 单进程；未测其它平台、冷盘、并发写者、
  生产真实事件分布。`maxRSS` 是整进程高水位，不是本函数的分配量。

## 6. 候选清单（含否决）

| 候选 | 结论 | 依据 |
| --- | --- | --- |
| 有界记忆 `isSensitiveKey` 纯函数 | **接受** | 本文 §1–§4；CPU −13.23%，差分等价，保留堆不变 |
| 单条 alternation 正则替代 8 次 `includes` | 否决 | 隔离微基准 37.9 ms vs 记忆 24.9 ms；且引入长键回溯面 |
| 无界 `Map` 缓存 | 否决 | 键来自被脱敏载荷，攻击者可制造无限不同键；必须 FIFO 上限 512 |
| 缓存非字符串键（按引用） | 否决 | `String(key)` 可能运行状态化代码；保留原 compute 路径 |
| 复用稳态 `flush()` 的 `appliedDigest` | 不重提（NO CHANGE） | `redundant-work.md` §4.1、`domain-flush-steady-cost.md` 三轮反例：O(1) 信号无法证明 O(历史) 标记表未变 |
| `installPending()` 只校验使用点 | 不重提（NO CHANGE） | `redundant-work.md` §4.2：被拒绝事务先改动实时归档树 |
| 合并 floor 检查与 replay 的重复读/HMAC | 不重提（NO CHANGE） | `axis-steady-history.md` §6：协议证明缺口，跨进程两次 open 可观察不同 inode |
| `#sourceMatches` 的 `knowledgeKeyOf` 兜底 | 不重提（当前已无该项） | 当前 `memory.js` 的 `derivedKeys` 在扫描时已 memo 派生键（`:1612-1636,:4297`），`archive-read-cost.md` 的 O(N) 兜底已被消除 |
| `stats()` 多次 `.filter().length` 合并为一次计数 | 不实现 | profile 仅 23.4 ms/1695 ms（1.4%）且在诊断路径，不在每事件热路径；收益不足以承担改动面 |
| 归档追加尾字节读取跳过 | 不重提（NO CHANGE） | `archive-append-window.md` §3.2：身份比较被两个反例击穿 |

## 7. 可复现命令

```sh
# A/B（4 轮交替；每侧每轮独立子进程，4096 MiB 堆上限）
NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/sensitive-key-memo.mjs \
  --records 20000 --rounds 4 --out docs/performance/sensitive-key-memo.json
# 同码 A/A 噪声
NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/sensitive-key-memo.mjs \
  --aa --records 20000 --rounds 4 --out docs/performance/sensitive-key-memo-aa.json
# 差分、反向锚点与功能回归
NODE_OPTIONS=--max-old-space-size=4096 node --test test/dockyard-domain/sensitive-key-memo.test.js
NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/load-projection-equivalence.test.js
NODE_OPTIONS=--max-old-space-size=4096 node --test test/dockyard-domain/ test/domain-storage/
```

原始逐轮数据：[A/B JSON](sensitive-key-memo.json)、[A/A JSON](sensitive-key-memo-aa.json)。
`scripts/benchmarks/`、`docs/performance/`、`test/` 都不在 `package.json#files` 白名单，
不进入分发字节；`lib/dockyard-domain/memory.js` 属于分发文件，按 `RELEASE.md` 需由
Lead 集成后统一重打包/验收，本文不执行 `pack:check --release` 或任何发布动作。

## 8. 未决风险

- 若将来有代码向既有 marker/窗口写入（当前唯一写者 `#markBridgeApplied` 只 push），
  与本缓存无关；但 `staged-save-check.md` 的冻结前提仍需保持。
- 缓存的正确性依赖“`isSensitiveKey` 对同一字符串恒返回同一布尔值”。这是当前实现的
  纯函数性质；`test/dockyard-domain/sensitive-key-memo.test.js` 从生产源码抽取并逐键
  对拍，形状漂移会显式失败。
- 只验证本机 Node 26；未跑 Node 22/24 的计时（功能回归在 CI 矩阵覆盖）。
- 全量 `npm test`、宿主验收、pack/release 门禁由 Lead 集成后统一执行；本文只报告
  实际跑过的聚焦测试与基准，不引用未重跑的历史数字。
