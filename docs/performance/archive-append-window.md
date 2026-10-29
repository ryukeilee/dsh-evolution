# 冷吸收的逐条工作：不再重扫标记窗口，也不再重做一个必然成功的 `mkdir`

基线是改动前的 `main` 提交 `95cf0d0`（原始记录里的 `baselineSha`）。本轮只改
`lib/dockyard-domain/memory.js`，删掉两类**随吸收条数线性放大、且完全可由本实例已持有的
状态回答**的重复工作，并保持持久化格式、认证、事务边界、恢复与 fsync 语义不变。

| 改动 | 删除的重复工作 |
| --- | --- |
| 桥接标记窗口的成员判定改为增量索引 | 每条已应用事件对一个最多 4,096 项的窗口做 `String(entry?.eventId ?? entry) === eventId` 全扫 |
| 归档追加只取一次文件身份、`mkdir` 只做一次 | 每次追加都 `mkdirSync` 一个已存在的目录，并额外 `statSync` 同一个文件两次 |

端到端（真实 `openDomainStorage()` + 官方 `DomainFacility`/`JsonStorageBackend`，一次无
checkpoint 的首次吸收）：

| 历史条数 | 吸收墙钟 | 变化 | 吸收 CPU | 变化 |
| ---: | ---: | ---: | ---: | ---: |
| 2,000 | 415.6 → 390.7 ms | **−6.00%** | 445.3 → 417.6 ms | **−6.22%** |
| 12,000 | 2,862.5 → 2,404.4 ms | **−16.00%** | 3,029.0 → 2,560.1 ms | **−15.48%** |
| 20,000 | 4,887.8 → 4,179.2 ms | **−14.50%** | 5,117.6 → 4,397.2 ms | **−14.08%** |

同码 A/A 对照（两侧都跑本轮代码）在吸收上的漂移是 **−1.99% / +1.01% / +0.15%**，所以三个规模
的收益都不是噪声。稳态写入与稳态 pass **没有收益**，峰值 RSS **在 2,000 与 20,000 条上更高**
（见 §6，不声称内存回归已排除）。

原始数据：[`archive-append-window.json`](archive-append-window.json)（A/B）、
[`archive-append-window-aa.json`](archive-append-window-aa.json)（同码对照）、
[`archive-append-window-equivalence.json`](archive-append-window-equivalence.json)（逐字节等价）、
[`archive-append-window-trace.json`](archive-append-window-trace.json)（机制计数）。
复现脚本：`scripts/benchmarks/archive-append-window.mjs`。

## 1. 全仓库排序：本轮为什么选这一处

按“调用频率 × 随历史规模的斜率 × 是否存在等价改写”排序，本轮重新测过的形状如下。前两项是
更大的成本，但它们**已被既有反例证明不能在不削弱保证的前提下改写**，因此不作为本轮候选。

| 顺序 | 路径与成本归因 | 规模证据 | 本轮结论 |
| --- | --- | --- | --- |
| 1 | **每次 `agent/pre-step` 与每个工具 finally 的稳态 `flush()`**：重读并 HMAC 整份已消费日志 + `digestApplied()` 摘要整张标记表 | 2,000 / 12,000 / 20,000 条历史：1.09 / 6.61 / 11.06 ms；`axis-steady-history.md` 的曲线到 100,000 条约 61 ms（0.6 ms/1000 条） | 不动。整份前缀重认证与全表摘要是“已消费字节被原地改写”和“标记表被回退”的唯一检测手段；`redundant-work.md` §4.1 与 `axis-steady-history.md` 已各自复现出可达反例 |
| 2 | **每次领域事务写整份文档**：`applied` 标记表与 4,096 项窗口占 20,000 条时 3.79 MB 文档的 85%，每笔事务一次 `serialize` + 两次 `FileHandle.sync()` | 稳态 `observe()`：20.96 / 40.89 / 50.94 ms，其中约 35 ms 是本机写入与 fsync 的系统时间 | 不动。明文摘要、合并复制、提交前双重比较、整份 zod 校验各有独立不变量（`domain-flush-history-cost.md` §9、`redundant-work.md` §4.2）；容量侧的正规出口是显式 `reclaim()` |
| 3 | **首次吸收逐条保存的整份文档校验** | 20,000 条时约 1.0 s（吸收 profile 里最大的单帧） | 不动。上一轮已省掉可省的部分（`staged-save-check.md`）；剩下的仍在复现“不可序列化值在此处抛错”的边界 |
| 4 | **首次吸收的逐条摄入工作** | 20,000 条时 4.89 s（0.24 ms/条） | **本轮目标**：其中约 0.6 s 是对同一 4,096 项窗口的全扫，约 0.1 s 是每次追加重做一个必然成功的 `mkdir`，约 0.05–0.15 s 是同一文件被 stat 三次中的一次 |
| 5 | 稳态写入的归档追加（每次驱逐一行） | `observe()` 中约占 1–2 ms | 同一处改动顺带少两次系统调用，但相对 40–50 ms 的事务可以忽略（实测在噪声内） |
| 6 | 大量密封段的事务、归档读窗口、recall、doctor、retention | 上一轮已把 4,096 段事务从 2,021 ms 降到 125 ms | 不重做（`archive-mirror-lease.md`） |

**剩余最大的两项成本都无法在不削弱完整性/安全保证的前提下改写**，所以本轮的收益落在第 4 项。
这一点必须与结论一起读：本轮之后，一次 20,000 条历史的首次吸收仍需约 4.18 s，稳态每步仍需
约 11 ms。

## 2. 冷吸收到底在做什么

`openDomainStorage()` 在没有 replay checkpoint 时把日志逐条认证并应用：`replay()` →
每条 `absorb()`（parse、验签、MAC 对照 marker）→ 一次 `mutate()` 事务 → 事务里对每条记录
`applyExecutionEvent()` → 每次 `#append()` → `#save()` + 集合热窗口（每集合 50 条）驱逐 →
`#archiveEntries()` 把被驱逐的行追加到该集合的活动归档文件。

一次 20,000 条记录的吸收因此产生约 20,000 次归档行追加（每集合前 50 条之后每条都驱逐一条）。
每一次追加原本要做十次系统调用：

```
mkdirSync(dirname(path), { recursive: true })            // 目录已经存在，答案必然相同
statSync(path).size                                      // 活动文件当前长度
statSync(path).size                                      // #activeTailIsTorn 内部再取一次
openSync(path, "r") + readSync(1 byte) + closeSync()     // 读最后一个字节
statSync(path, { bigint: true })                         // 追加前的文件身份
appendFile(path, payload)                                // 真正的追加（open+write+close，3 次）
```

本轮删掉其中两次**答案已由本实例持有**的调用，变成八次（`mkdirSync` 递归实现自己的内部探测
不计）：

```
statSync(path, { bigint: true })                         // 一次身份：长度 + 追加前身份
openSync(path, "r") + readSync(1 byte) + closeSync()     // 读最后一个字节（保留，见 §3.2）
statSync(path, { bigint: true })                         // 追加前的文件身份
appendFile(path, payload)                                // 仍是 open+write+close
```

## 3. 改了什么

### 3.1 标记窗口：从全扫到增量索引（`#bridgeApplied`）

```js
#bridgeApplied(eventId) {
  return (this.#data.eventBridge?.applied ?? []).some((entry) => String(entry?.eventId ?? entry) === eventId);
}
```

窗口是“最近 4,096 条已应用记录”，`#markBridgeApplied()` 是唯一写入者：push 一个 marker，
再 `slice(-4096)` 丢掉头部。所以“这个 eventId 在窗口里吗”是一个集合成员问题，而窗口只有一个
写入者。新增的索引就是同一个问题的 O(1) 回答：

- `bridgeWindowId(entry)` 只在**答案由该条目自己的数据决定**时返回 id：条目是普通对象，且有
  自有的数据属性 `eventId`（不要求可枚举），其值是字符串。这正是窗口实际持有的形状（marker 由
  `#markBridgeApplied()` 用 `Object.freeze` 造出，重启后来自 JSON 的也是字符串）。
- 其他任何形状都返回 `null`，整个窗口退回**未改动的线性扫描**，所以读取次数、`String(...)`
  的兜底值和异常行为都与发布版一致。其中最容易漏掉的是**裸字符串**：发布表达式对
  `entry = 'abc'` 读的是 `entry.eventId`，而那是 `String.prototype.eventId`——一个在索引建立
  之后才被定义的原型属性会改变答案，所以含裸字符串的窗口一律不索引（回归用例用被污染的原型
  钉住这一点）。
- 索引按窗口数组身份缓存，`#markBridgeApplied()` 在 push+trim 之后用
  `#bridgeWindowShifted()` 原地更新它：减掉被 trim 掉的那几个 id，加上新 marker。duplicate id
  用计数表示，所以“同一 id 出现两次、只被挤出一个”仍然命中。窗口数组在本实例之外被替换
  （`restore()`/`reconcile()`）时，缓存的身份比对会让它按新窗口重建。

净效果：`applyExecutionEvent()` 的每事件成本从 O(4096) 变成 O(1)。

### 3.2 归档追加：一次身份 stat，目录只建一次（`#archiveEntries`）

- **一次身份 `stat`** 同时给出活动文件长度（原本的 `statSync(path).size`）和尾部探测需要的
  长度；`#activeTailIsTorn(path, size)` 因此不再自己 stat。这是同一个值读一次而不是两次。
- **`mkdir` 只做一次**：`#appendArchiveBytes()` 记住本实例已创建的目录。目录真的被删掉时
  追加会以 `ENOENT` 失败，此时遗忘记忆、重建目录并重试一次，与原本“每次追加前都 mkdir”
  的可观察行为一致。

**本轮没有跳过尾字节读取，这是刻意撤回的。** 第一版把“本实例追加后记录的文件身份”与下一次
观察到的身份逐字段比较，相等就认为最后一个字节仍是自己写的换行。独立审核复现了两个反例：
同长度改写再用 `os.utime` 恢复原 mtime 时四项身份完全相同；以及外部写者在本实例 append 完成、
post-stat 之前改坏末字节时，post-stat 会把坏尾部登记为可信身份。两种情况基线都会在下一次追加
前隔离残片，而跳过的实现会把新行拼进无效行，**该行同时离开热窗口与档案**。因此该分支整体撤回；
`#extendArchiveReadCache()` 与 `#recordActiveArchiveWrite()` 也回到发布版形状。

## 4. 等价性

`--validate` 让两侧在冻结时钟（`2026-10-29T00:00:00.000Z`）与确定性 UUID 序列下跑同一份
负载，然后逐字节比较（原始记录
[`archive-append-window-equivalence.json`](archive-append-window-equivalence.json)）：

- `dockyard/` 下整棵归档树（活动文件、隔离文件、密封段、派生索引）逐文件 sha256 相同；
- 提交的 `official/evolution_domain.json` 全文（含 `applied` 标记表）sha256 相同；
- replay checkpoint 的**内容字段**（`bytes`/`records`/`digest`/`writer`/`first`/`last`/
  `appliedDigest`）相同，且脚本断言 checkpoint 存在、`file.dev`/`file.ino` 是字符串、
  `mac` 是 64 位十六进制——所以“两侧都缺这些字段”不会与“两侧都有”被当成同一个结果；
- 每个集合的查询投影相同；
- 每条的 marker 数等于吸收条数，事务结束后暂存目录为空。

2,000 / 12,000 / 20,000 三档全部成立。

行为边界由两个新回归文件钉住：`test/dockyard-domain/bridge-window-index.test.mjs`（五项）与
`test/dockyard-domain/archive-append-probe.test.mjs`（六项）。关键保护都用“把实现改错必须让
用例失败”验证过：

| 把实现改错 | 失败的用例 |
| --- | --- |
| `bridgeWindowId()` 又把裸字符串索引成它自己 | `a bare string entry answers through String.prototype, so that window is not indexed` |
| 退回扫描时去掉 `String(...)` 强制转换 | `a window whose ids are not decided by data keeps the released scan` |
| `#appendArchiveBytes()` 去掉 `ENOENT` 重试 | `a directory removed anyway is re-created and the append retried` |

`test/domain-storage/load-projection-baseline.js` 的反转表补齐了本轮的 18 个 hunk，并新增
**重建源码的固定 SHA-256 校验**：只校验“每个 hunk 仍能找到自己的 post 形状”并不能证明留下的
就是改动前的源码（漏掉一段就会重建出第三棵树，而两侧随后跑同一份新代码——这正是该锚点要防的
失效）。重建结果现在等于 `2c1039ee…859c6a` / `d505692d…38ee1` / `886aad88…3af5c`
（与 `95cf0d0` 上的重建结果相同），漂移会直接失败。

`test/archive-append-tail-roundtrips.test.mjs` 的故障注入点从“尾部探测内部的 stat / 初始非
bigint stat”改成“追加路径的身份 stat”，并保留原有断言（注入的失败不得写入字节、不得驱逐
热行；身份取不到时按“没有证明的撕裂”处理）。

## 5. 机制计数

`--trace` 在吸收阶段按固定计数器统计归档路径的 API 调用（无栈采样、无载荷检查），12,000 条：

| 每次追加（每吸收一条记录） | 基线 | 本轮 |
| --- | ---: | ---: |
| `mkdirSync` | 0.996 | **0** |
| `statSync` | 2.998 | **2.002** |
| `openSync`（尾部探测的 open） | 0.997 | 0.997 |
| `appendFile` | 0.996 | 0.996 |

`readSync`/`closeSync` 的计数值恒为 0：包装器按首个参数是否为归档路径来判断，而这两个调用的
首个参数是文件描述符。它们的调用次数因此按代码推导：每次 `#activeTailIsTorn()` 一次
open、一次 1 字节 read、一次 close，两侧相同。系统调用总数（含 `mkdir` 内部与 `appendFile`
自身的 open/write/close）按代码是每次追加 10 → 8，不含 `mkdirSync` 递归实现自己的内部探测。

## 6. 没有收益、以及没有证明的部分

| 场景 | 基线 → 本轮 | 同码 A/A 漂移 |
| --- | ---: | ---: |
| 稳态 `flush()` 2,000 / 12,000 / 20,000 条 | +0.95% / −2.60% / +0.12% | −2.17% / +0.79% / −0.30% |
| 稳态 `observe()` 2,000 / 12,000 / 20,000 条 | +1.55% / −0.83% / +0.13% | +0.48% / +0.61% / −0.62% |
| 进程峰值 RSS 2,000 / 12,000 / 20,000 条 | **+9.1%**（154.4→168.4 MiB）/ −5.3%（321.3→304.1）/ **+3.6%**（400.6→415.2） | +0.06% / −0.40% / −0.08% |
| 强制回收后的保留堆 2,000 / 12,000 / 20,000 条 | 33.5→32.6 / 48.3→47.4 / 51.0→44.2 MiB | 不变 |

- 稳态两条路径**不声称收益**：差值方向不一致，且与 A/A 漂移同量级。
- **峰值 RSS 在 2,000 条（+9.1%）与 20,000 条（+3.6%）上升，超出同码漂移**，所以不声称“内存
  没有回归”。保留堆在三档上都持平或更低（2,000 条 −2.7%），方向与峰值相反；一个**未验证的
  可能解释**与 `archive-mirror-lease.md` §6 记录的现象相同（吸收更快 → 单位时间分配量更高 →
  V8 选择更大的堆高水位，而本机不把已回收的页还给系统），本轮没有测 GC 时间线或分配归因，
  所以只把它当作待验证的猜测。可以确定的是：该数字是整进程的峰值高水位，不是保留足迹，而保留
  足迹在三档上都持平或更低。
- 12,000 条的 −16.00% 与 20,000 条的 −14.50% 不是同一比例，与“收益随窗口规模增长”相符
  （2,000 条的窗口只填到 2,000 项），但没有对这条曲线做拟合。

## 7. 复现

```sh
# A/B（每样本独立子进程、独立临时数据根，逐轮交换先后顺序）
node --max-old-space-size=4096 scripts/benchmarks/archive-append-window.mjs \
  --baseline-ref 95cf0d0 --records 2000,12000,20000 --rounds 3 --observes 12 --flushes 12 \
  --out docs/performance/archive-append-window.json
# 同码对照
node --max-old-space-size=4096 scripts/benchmarks/archive-append-window.mjs --aa \
  --records 2000,12000,20000 --rounds 3 --observes 12 --flushes 12 \
  --out docs/performance/archive-append-window-aa.json
# 逐字节等价
node --max-old-space-size=4096 scripts/benchmarks/archive-append-window.mjs \
  --baseline-ref 95cf0d0 --records 2000,12000,20000 --validate \
  --out docs/performance/archive-append-window-equivalence.json
# 机制计数
node --max-old-space-size=4096 scripts/benchmarks/archive-append-window.mjs \
  --baseline-ref 95cf0d0 --records 12000 --rounds 1 --observes 2 --flushes 3 --trace \
  --out docs/performance/archive-append-window-trace.json
```

环境：Node `v26.12.1` / darwin-arm64，父进程与每个子进程都带 `--max-old-space-size=4096`。
基线不是转述：脚本用 `git archive 95cf0d0 lib package.json package-lock.json` 解出独立树，
`node_modules` 软链到工作树，并在 JSON 里同时记录 `baselineRef`、解析后的 `baselineSha`、
`candidateSha` 与两个候选源码的 sha256。两侧签名夹具由工作树的
`signEventBridgeEnvelope()` 生成，因此夹具字节不是变量。测量期间串行运行，没有并行测试或
宿主验收。`--trace` 轮的系统调用包装会拖慢稳态相位，所以计时只取非 trace 轮
（`archive-append-window-trace.json` 只用它的机制计数）。

## 8. 收益边界与剩余风险

- 收益来自“每条吸收记录上的固定成本”，所以**只在首次吸收/回填时显著**：2,000 条约 −6%，
  12,000 与 20,000 条约 −15%。
- 绝对值依赖本机系统调用成本；可移植的结论是**调用次数**（每次追加 10 → 8 次系统调用：同一文件
  少一次 stat，`mkdir` 从每条记录一次变成每个实例一次——12,000 条的 trace 轮里是 11,953 → 4）与被
  删除的工作，而不是百分比。
- 未测：冷页缓存、网络文件系统、其它平台、真实生产到达分布（一次工具调用产生几条事件、
  多久发生一次无 checkpoint 的首次吸收）、以及真实宿主上的端到端验收。
- **尾字节读取仍是每次追加一次**。它在“事务持有归档锁、文件已被私有化”的前提下是可省的
  （那时没有第二个写者能改这些字节），但那需要把“独占”作为新的显式前提引入这条路径，本轮
  没有做；按 §3.2 的身份比较不行，已被反例击穿。
- `archiveDirectoriesReady` 是实例内状态。端口路径上一个事务一个实例，所以跨事务仍会
  `mkdir` 一次；`memory.js` 被直接使用时实例活得更久，跳过条件只是“本实例建过这个目录”，
  目录消失时靠 `ENOENT` 重试保持行为。
