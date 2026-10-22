# 写路径：为两处派生状态付的 fsync，与一次重复的整份文档校验

本轮基线为 `main` 的 `4202f39`。改动只有三处，都在写路径上：

1. `lib/event-log-checkpoint.js` 的 `writeEventLogCheckpoint()` 不再 fsync 文件与父目录，
   只保留同目录临时文件 + 原子 `rename`。
2. `lib/archive-stage.js` 的 `syncStage()` 不再 fsync 暂存目录里的
   `.archive-files.json`（阶段清单）。
3. `lib/domain-storage.js` 的 `aggregateSchema` 不再对已经由 `toJsonProjection`
   投影过的每个值递归跑一遍 `z.json()`（`catchall(json)` → `passthrough()`）。

前两处删掉的是**派生状态**的耐久性开销：这些字节在损坏、缺失或过期时的最坏结果都是
"回到全量工作"，从来不会改变已提交的数据。第三处删掉的是**已经由投影保证必然成立**的
校验：`JSON.parse(JSON.stringify(value))` 的输出只可能是 JSON，递归的 `z.json()` 没有
任何东西可以拒绝它，却在每次 `#save()` 里把整份文档再走一遍。

版本、`release/`、rc.17 固定产物、既有验收与性能证据、官方 DSH 均未修改。原始数据见
[`domain-derived-fsync.json`](domain-derived-fsync.json)，复现脚本见
[`scripts/benchmarks/domain-derived-fsync.mjs`](../../scripts/benchmarks/domain-derived-fsync.mjs)。

## 1. 路径与调用频率

`lib/registration.js` 里只有两个入口会跑这条路径：

| 触发点 | 频率 | 走到的代码 |
| --- | --- | --- |
| `agent/pre-step` 的 `domainStorage.flush()` | 每个 Agent 步骤一次 | `replay()` |
| 每个 Evolution 工具结束的 `finally` 里的 `flush()` | 每次工具调用一次 | `replay()` |
| `agent/error` / 工具结果的 `domainStorage.observe(dto)` | 每次失败信号一次 | `mutate()` → 一次事务 |

`replay()` 在**没有新事件**时只读日志、核对检查点与标记表，不写任何东西（本轮未改这条
路径）。只有真正消费了新记录，它才会跑事务，并在 pass 成功后**推进检查点**；一次工具
调用通常发出 2–3 条记录（`experiment-rejected` + `failure-learned`、`revert`/`promote`
失败路径连续多条），进程停机期间的追加也会在下次启动或下一步集中到来。

一次事务（无论来自 `observe()` 还是 `replay()` 的批量提交）都经过同一串步骤：
`installPending → mirrorArchives → createMemory(暂存) → work → syncStage → 发布 pending
记录 → installPending → hydrate`。本轮删掉的两个 fsync 正好落在其中的 `syncStage` 和
`replay()` 的检查点写入上：**每一次事务、每一次推进检查点的 pass 都要付一次**。

## 2. 归因

### 2.1 一次事务的墙钟分段（临时探针，未入库）

真实官方 `JsonStorageBackend` + 真实端口，200 条历史，9 个样本取中位数，在每个阶段
边界打点（探针只读计时，不改行为）：

| 阶段 | `flush()` 积压 1 条 | `flush()` 积压 10 条 |
| --- | ---: | ---: |
| `installPending()`（事务开始时的恢复检查） | 0.20 ms | 0.33 ms |
| `mirrorArchives()`（硬链接镜像） | 0.42 ms | 0.36 ms |
| `createMemory()`（暂存实例与加载） | 1.09 ms | 1.10 ms |
| `work()`（逐条 `applyExecutionEvent`） | 0.42 ms | 7.43 ms |
| `changedArchiveFiles()` | 0.09 ms | 0.20 ms |
| `syncStage()`（清单写入 + fsync） | 5.64 ms | 7.29 ms |
| 发布 `pending` 记录（`schema.parse` + 整份文档写入） | 8.34 ms | 8.33 ms |
| 安装 + 关闭写入 `installPending()` | 7.48 ms | 7.56 ms |
| `hydrate()`（提交后重载） | 1.13 ms | 0.99 ms |
| **整个 `flush()`（含 pass 的读取、认证、检查点）** | **33.07 ms** | **41.32 ms** |

墙钟由两段 I/O 主导：协议本身的两次整份文档写入（各自 fsync 文件与目录），以及暂存阶段
与检查点的 fsync。CPU 只在积压量上来后才成为主项（积压 10 条时 `work()` 的 7.43 ms）。

### 2.2 fsync 调用点（临时探针，未入库）

同时挂 `fs.fsyncSync` 与官方后端用的 `FileHandle#sync`，按调用栈归组；同一操作 9 个样本，
下表是"每次操作调用次数"与"单次调用中位数"。基线 `4202f39`：

| 操作 | 调用点 | 次数/操作 | 单次中位数 |
| --- | --- | ---: | ---: |
| `observe()` | `syncFile` ← `syncStage`（阶段清单） | 1 | 3.27 ms |
| | `syncDirectory` ← `syncDirectories` ← `syncStage` | 2 | 2.10 ms |
| | `FileHandle#sync` ← `writeAtomic`（pending 记录） | 1 | 3.44 ms |
| | `FileHandle#sync` ← `fsyncDirectory` ← `writeAtomic` | 1 | 3.54 ms |
| | `FileHandle#sync` ← `writeAtomic`（关闭记录） | 1 | 3.44 ms |
| | `FileHandle#sync` ← `fsyncDirectory` ← `writeAtomic` | 1 | 3.54 ms |
| | **合计** | **7** | **19.33 ms / 29.45 ms 墙钟** |
| `flush()`（积压 1 条） | 上面 7 次 | 7 | — |
| | `fsyncSync` ← `writeEventLogCheckpoint`（文件） | 1 | 3.14 ms |
| | `fsyncSync` ← `writeEventLogCheckpoint`（父目录） | 1 | 3.14 ms |
| | **合计** | **9** | **24.09 ms / 33.55 ms 墙钟** |

两处被删的 fsync 在这张表里的地位很清楚：

- **检查点**（`event-log-checkpoint.js`）：每次推进检查点的 pass 付两次（文件 + 父目录，
  本机约 3 ms 上下）。这份文档是**派生**的：读取侧 `planEventLogReplay()` 只有在 keyed
  digest 匹配磁盘上这段日志、且 `appliedDigest` / 首末 witness / writer / 文件身份都仍然
  描述已提交的标记表时才相信它；缺失、过期、被截断成零字节、rename 被崩溃丢掉，全部退回
  "逐条重新认证"——那正是没有检查点时的行为，也正是它存在的意义。它描述的数据（域文档）
  由官方后端在此之前 fsync 完，所以它不可能比它所描述的提交更权威，也不存在"它先落地、
  数据没落地"的顺序危险：那种情况会被 `appliedDigest`/witness 判为非候选。
- **阶段清单**（`archive-stage.js` 的 `.archive-files.json`）：恢复路径读的是已提交文档里的
  `pending.files`，从来不读这份清单。`test/domain-storage/archive-stage.test.js` 的
  "recovery installs a staged archive when the install is interrupted" 本来就在 pending
  记录提交之后把清单写成 `torn manifest`，再断言恢复照样按 `pending.files` 安装；本轮
  只是让"清单内容可能撕裂"从测试里的注入变成崩溃后的正常可能。清单本身仍然会被写出来
  （它是可读的诊断记录），它的目录项也仍然随其他目录一起 fsync。

### 2.3 CPU 归因：一次事务里的"整份文档校验"

对基线跑 `--cpu-prof`（真实端口 + 官方后端，积压 10 条 × 40 次），自耗时排序前几项：

| 自耗时（40 次 pass） | 每次 pass | 归属 |
| --- | ---: | --- |
| `fsync`（原生） | 20.9 ms | 上面 2.2 的 I/O 等待 |
| `(idle)` | 18.1 ms | 等官方后端 `writeAtomic` 的线程池/fsync |
| `zod inst._zod.parse` + `memoizer` | 8.2 ms | 整份文档的 schema 校验 |
| `toJsonProjection`（`JSON.stringify` + `parse`） | 2.8 ms | 整份文档的 JSON 投影 |
| `structuredClone` | 1.4 ms | `createMemory()` 的两次深拷贝 |
| 其余 `lib/` 函数合计 | < 1 ms | `mirrorArchives`/`readdir`/`mergeEventLedger` 等 |

`zod` 是这些 pass 里最大的 JS 成本，来源是 `createMemory()` 的
`stateStore.update`：

```js
update: async updater => { aggregate = aggregateSchema.parse(updater(aggregate)); }
```

`EvolutionMemory.#save()` 在**每个**写步骤之后调用 `transaction.persist`，一次事务里
调用多少次取决于事件类型：

| 操作 | 每次操作的 `transaction.persist` 次数 |
| --- | ---: |
| `observe()`（一条 observation） | 1 |
| `flush()`，积压 k 条 `measurement-completed` | 2k（`#append` 一次、`#markBridgeApplied` 一次） |
| `flush()`，一条 `experiment-rejected` 或 `failure-learned`（带失败指纹） | 3 |
| `flush()`，一条 `canary-passed` | 5 |

（后两行是把对应类型的已签名事件逐条送进真实端口测得的：`measurement-completed` /
`promotion-succeeded` 2 次，`experiment-rejected` / `failure-learned` 3 次，`canary-passed`
5 次，分别对应 `#append` 次数加一次 `#markBridgeApplied`。）

而每一次 `aggregateSchema.parse` 都是对**整份文档**（本节探针的跑批里约 98–102 KB）
做一次 JSON 投影 + 一次递归 schema 校验。临时探针统计 `stateStore.update` 内
`updater()` 与 `aggregateSchema.parse` 的累计耗时（7 个样本中位数）：

| 操作 | 持久化次数 | 基线 `parse` 累计 | 改动后 `parse` 累计 |
| --- | ---: | ---: | ---: |
| `observe()` | 1 | 0.20 ms | 0.06 ms |
| `flush()` 积压 1 条 | 2 | 0.23 ms | 0.06 ms |
| `flush()` 积压 10 条 | 20 | 5.47 ms | 1.81 ms |
| `flush()` 积压 25 条 | 50 | 17.04 ms | 7.23 ms |

剩下的 1.81 / 7.23 ms 是**还留着**的 JSON 投影（`toJsonProjection`）：事务存储的
`load()` 返回的必须是"最后一次 `#save` 那一刻"的深拷贝，投影是它唯一的来源（见第 5 节）。
它比只做投影的多一点：投影在序列化文本里再查一次 `"__proto__"` 字面量（见第 3.3 节），
本机在积压 25 条时约多 1 ms。

### 2.4 根因

- **两处 fsync 是"为派生状态买耐久性"**：检查点与阶段清单都不是权威数据，两者损坏的
  后果都是"多做一遍已证明正确的工作"，而不是数据错误。它们却都在每次写入路径上阻塞一次
  到两次 fsync，属于纯等待成本。
- **整份文档校验是"对刚投影出来的值再校验一遍"**：`aggregateSchema` 用
  `z.preprocess(toJsonProjection, …)` 把输入规约成 JSON，随后 `catchall(z.json())` 又对
  每个值递归确认"它是不是 JSON"。前者保证后者必然通过，后者只是在每次 `#save` 里重走
  整份文档。

## 3. 改动

### 3.1 检查点不再 fsync

```js
export function writeEventLogCheckpoint(file, checkpoint) {
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const descriptor = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeSync(descriptor, `${JSON.stringify(checkpoint)}\n`); } finally { fs.closeSync(descriptor); }
  try { fs.renameSync(temporary, file); } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
}
```

写出的字节与之前完全相同（同一份 JSON、同一个换行、同一个 `0o600`），只是去掉了
`fs.fsyncSync(descriptor)` 与末尾的"打开父目录再 fsync"。原子替换保留：并发读者看到的
要么是旧检查点，要么是新检查点，不会看到半份文件。

### 3.2 阶段清单不再 fsync

`syncStage()` 删掉 `syncFile(path.join(directory, STAGE_MANIFEST))` 一行；其余
（每个被改动文件、暂存目录、staging root 及其祖先目录）一律保留。恢复仍只信
`pending.files`，清单仍被写出，只是不再保证其内容在崩溃后完好。

### 3.3 不再对已投影的文档做递归 JSON 校验

```js
const aggregateSchema = z.preprocess(toJsonProjection,
  z.object({ evolution: z.object({ schema: z.number().int().min(4) }).passthrough().optional() }).strict());
```

`passthrough()` 保留未知的 evolution 字段（`catchall` 的语义是"保留并继续校验"，
`strip` 会删掉它们），因此投影结果、`evolution.schema` 的整数下限、顶层 `.strict()`
全部不变；变的只是"每个值还要再被判一次是不是 JSON"。这条判定不可能失败：
`JSON.parse(JSON.stringify(...))` 的输出只可能是 `null`、布尔、字符串、有限数字、数组与
普通对象（内存里的 `NaN`/`Infinity` 在投影内部就变成了 `null`，只以 `1e999` 形式解析
出来的 `Infinity` 同样会在投影里被归一化为 `null`），所以 `z.json()` 在这条路径上没有
任何可以拒绝的输入。删掉它不改变任何接受/拒绝决定，只删掉一次整份文档遍历。

**但那趟深走并非完全没有副作用，这点由独立审核发现并已修掉。** `z.json()` 的
`z.record` 用普通属性赋值构造结果，而 `JSON.parse` 可以创建**自有**的 `__proto__` 键：
赋值这个名字只会改原型、不会建自有键，于是旧实现会把它**丢掉**。`passthrough()` 会保留
它，所以只换成 `passthrough()` 时，"嵌套对象里带自有 `__proto__` 键"的文档在两版下
落盘字节不同（审核用真实 `pending.aggregate` + 官方后端复现过）。修法是让投影自己执行
同一件事：

```js
const PROTO_KEY = '__proto__';
function stripOwnProtoKeys(value) { /* 递归删除每个对象上的自有 __proto__ 键 */ }
const toJsonProjection = value => {
  const text = JSON.stringify(value);
  const projected = JSON.parse(text);
  if (text.includes(`"${PROTO_KEY}"`)) stripOwnProtoKeys(projected);
  return projected;
};
```

于是"接受/拒绝"和"校验后的值"都与旧实现一致，包括嵌套深度、数组元素、metric map 之类
的键（`constructor` / `prototype` 这类普通键照旧保留）。代价只在文本里出现该字面量时
才发生：`JSON.stringify` 必须逐字写出自有键名，所以本插件自己写的文档只付一次子串
搜索；一个恰好取值为 `__proto__` 的字符串只会让这次遍历跑一遍并什么也不删。

## 4. 真实 A/B

同机、真实官方 `DomainFacility` + `JsonStorageBackend`、临时隔离根；每侧独立进程、
预填 200 条已签名历史并做 3 次预热；每个场景 9 个样本；三轮交替（第 1 轮
baseline→fsync-only→both，第 2 轮倒序，第 3 轮旋转），下表是"三轮各自中位数的中位数"。
两侧的 `flush()` 都自检 `applied` 与已提交记录的重复计数。

`fsync-only` = 只删两处 fsync；`both` = 再加上第 3.3 节的 schema 改动（即最终候选）。
`fsync` 列是 `fs.fsyncSync` + 官方后端的 `FileHandle#sync` 之和（即真实 fsync 次数）。
一份 200 条历史的文档在预热后约 98–102 KB；整轮跑完（积压 0/1/2/10/25/50 的事件加 9 次
`observe()`）后为 392,669 字节，文档越大，第 3.3 节的收益越明显。

| 负载 | 墙钟 baseline | fsync-only | both | CPU baseline | fsync-only | both | fsync |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `observe()`（典型写入） | 27.65 ms | 23.08 ms（−16.5%） | **23.82 ms（−13.8%）** | 9.60 ms | 8.22 ms | **7.32 ms（−23.8%）** | 7 → 6 |
| `flush()` 无新事件 | 0.35 ms | 0.30 ms | 0.35 ms | 0.48 ms | 0.38 ms | 0.47 ms | 0 → 0 |
| `flush()` 少量积压 1 条 | 39.75 ms | 25.92 ms（−34.8%） | **26.51 ms（−33.3%）** | 15.27 ms | 11.44 ms | **11.27 ms（−26.2%）** | 9 → 6 |
| `flush()` 少量积压 2 条 | 40.70 ms | 28.78 ms（−29.3%） | **27.84 ms（−31.6%）** | 17.19 ms | 12.29 ms | **11.98 ms（−30.3%）** | 9 → 6 |
| `flush()` 批量积压 10 条 | 61.45 ms | 50.34 ms（−18.1%） | **46.80 ms（−23.8%）** | 34.97 ms | 31.89 ms | **26.37 ms（−24.6%）** | 12 → 9 |
| `flush()` 批量积压 25 条 | 92.06 ms | 82.20 ms（−10.7%） | **63.08 ms（−31.5%）** | 68.46 ms | 66.94 ms | **44.51 ms（−35.0%）** | 12 → 9 |
| `flush()` 批量积压 50 条 | 181.82 ms | 170.19 ms（−6.4%） | **112.12 ms（−38.3%）** | 167.95 ms | 165.71 ms | **102.08 ms（−39.2%）** | 12 → 9 |

逐轮的原始中位数（3 轮 × 每场景 9 样本的中位数）都在
[`domain-derived-fsync.json`](domain-derived-fsync.json) 的 `rounds` 里。墙钟的逐轮离散：

| 负载 | 墙钟三轮 baseline | 墙钟三轮 both |
| --- | --- | --- |
| `observe()` | 26.00 / 27.65 / 27.96 ms | 22.13 / 23.82 / 24.24 ms |
| `flush()` 积压 1 | 38.79 / 39.75 / 39.82 ms | 25.14 / 26.51 / 27.75 ms |
| `flush()` 积压 10 | 59.40 / 61.45 / 63.66 ms | 44.49 / 46.80 / 48.20 ms |
| `flush()` 积压 50 | 181.47 / 181.82 / 182.16 ms | 109.29 / 112.12 / 112.93 ms |

改动没有改变任何写操作的次数：`observe()` 与 `flush()` 下 `writeSync` 3→3 / 4→4、
`writeFileSync` 3→3、`renameSync` 3→3 / 4→4（积压 10 条时 7→7）、`readFileSync` 4→4 /
5→5（积压 10 条时 9→9）、`linkSync`、`mkdirSync` 全部不变。**fsync 次数是唯一变化的
调用计数**（`fsyncSync` 3→2 / 5→2 / 8→5，官方后端的 `syncFileHandle` 4→4），这正是本轮
的目标。

### 4.1 收益拆分

- **删除的两处 fsync** 只降低等待（以及系统 CPU）：`observe()` 少 1 次、`flush()` 少 3 次，
  本机一次 fsync 约 2–3.5 ms，与 fsync-only 一侧的墙钟差（`observe()` −4.57 ms、积压 1 条
  −13.83 ms）一致；积压 25/50 条时这一点等待被 `work()` 的 CPU 淹没，所以 fsync-only 一侧
  只有 −10.7% / −6.4%。
- **schema 改动** 只降低 CPU，因此在积压小的时候看不出来（积压 1/2 条时 both 与
  fsync-only 差别落在噪声内），在积压 10/25/50 条时是主要收益
  （CPU −24.6% / −35.0% / −39.2%，墙钟因为原来就是 CPU-bound 而同步下降）。
  fsync-only 一侧在积压 50 条时 CPU 是 −1.3%，正好说明这一侧的 CPU 变化落在噪声内。

## 5. 收益边界与代价

- **稳态（无新事件）没有任何改动**：那条路径本来就不写东西，实测 0.33 → 0.31 ms 属于噪声，
  **不声称收益**。
- **fsync 的绝对耗时完全取决于主机**。本轮机器（Apple M2 / APFS，非空闲，load average
  1.3–1.9）上一次 fsync 约 2–3.5 ms，属于偏慢；在 fsync 更快的主机上，这两处改动的收益
  按比例缩小。收益的机制证据是 fsync 次数（7→6、9→6、12→9），不是某个固定的毫秒数。
- **页缓存是热的**，本轮不声称物理磁盘 I/O 总量下降，只报告调用次数与墙钟。
- **最坏情况从"检查点/清单完好"变成"多跑一次全量认证"**：崩溃后检查点可能丢失、过期或
  被截断成零字节，阶段清单可能撕裂。前者由 `planEventLogReplay()` 判为非候选，退回逐条
  认证；后者根本不在恢复路径上。两者都不改变任何已提交字节，也不改变"先恢复、后加载"的
  顺序。代价是：如果进程恰好在写检查点后崩溃，下一次启动（或下一次 pass）要多认证一次
  已消费前缀——这正是引入检查点之前的行为。
- **schema 改动影响的失败语义**：`aggregateSchema` 仍然会在每次 `schema.parse` 里校验
  文档形状、`evolution.schema` 的整数下限、`applied` 的字符串映射与 `pending` 结构，
  这些是唯一能拒绝的地方；被删掉的递归 JSON 判定不可能拒绝投影后的值（第 3.3 节）。
  差分测试见 `test/domain-storage/aggregate-schema-equivalence.test.js`，它用同一份
  语料（含 `undefined` 字段、`NaN`/`Infinity`、只解析出 `Infinity` 的 `1e999`、顶层与
  嵌套/数组内/metric map 内的自有 `__proto__` 键、`constructor`/`prototype` 普通键、
  `Date`、schema 越界、多余顶层字段、非对象 aggregate 等 32 种形状）要求新旧两个 schema
  的接受/拒绝决定与校验结果的逐字节投影完全一致；另一项直接断言校验后的文档在任何深度
  都不再带自有 `__proto__` 键（把 `stripOwnProtoKeys` 去掉时该项与差分项都失败）。
- **没有采纳的候选**（逐个说明为什么不做）：
  - *把 `#save()` 的整份投影也去掉*（`update` 只存引用，`load()` 时再投影）。剩下的
    1.81–7.23 ms 就来自这里，但它承载了"`load()` 返回最后一次 `#save` 那一刻的深拷贝"
    这一语义：`reconcile()` 与 `verifyConsistency()` 都通过 `stateStore.load()` 读取
    暂存分区，改成惰性投影会让它们看到"加载时的实时状态"而不再是"最后一次保存的状态"。
    现有端口不会在保存之后 `load()`，但那属于未写进合同的巧合，不足以拿语义换 1.81 ms。
  - *`installPending()` 在 `pending === null` 时跳过整份 `schema.parse`*：`flush()` 与
    `observe()` 每次事务都要为此多走一次整份投影+校验（本机约 0.2–0.3 ms）。跳过就要
    先读未经校验的 `pending` 字段，等于让损坏的文档"看起来没有待恢复记录"，与"未知或
    损坏状态不得猜测"的不变量冲突，收益也不成比例。
  - *提交时的 `snapshot()` 换成实时视图*：`mutate()` 立刻把 `{ evolution: snapshot() }`
    交给 `schema.parse`，理论上可省一次 `structuredClone`（本机约 0.5–1 ms），但两者之间
    只隔着同步代码，一旦将来插入 `await` 就会把活数据写进持久化字节。不值得。
  - *整份删掉阶段清单的写入*：能再省一次 write + rename，但清单是文档里写明的可读诊断
    记录，`readStageManifest()` 与相关测试都依赖它。本轮只删它不必要的耐久性。
  - *复用整个 `Memory` 实例代替"暂存实例 + 提交后重载"*：`observe-cache-handoff.md` 已
    经以"热状态、失败事务、维护与加载副作用"为由拒绝，本轮不重试。

## 6. 验证

```sh
NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/aggregate-schema-equivalence.test.js
NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/archive-stage.test.js \
  test/domain-storage/event-log-checkpoint.test.js test/domain-storage/replay-batch-commit.test.js \
  test/domain-storage/storage.test.js test/domain-storage/domain-storage-write-path-equivalence.test.js
NODE_OPTIONS=--max-old-space-size=4096 npm test
npm run pack:check
npm run release:verify
```

- **新增差分测试** `test/domain-storage/aggregate-schema-equivalence.test.js`（3 项）：
  32 种文档形状下新旧 schema 的接受/拒绝与投影结果逐字节一致（含顶层、嵌套、数组元素与
  metric map 里的自有 `__proto__` 键）；一项断言校验后的文档在任何深度都不再带自有
  `__proto__` 键、而 `constructor`/`prototype` 这类普通键照旧保留；一项逐值检查投影后的
  值"只可能是 JSON 标量或容器、数字必然有限、投影是不动点"——这就是"递归 `z.json()` 无可
  拒绝"这条论证本身。把 `passthrough()` 换回默认 `strip`、或去掉 `stripOwnProtoKeys`
  时该文件都失败，说明它不是空转。
- **新增崩溃形状回归** `test/domain-storage/event-log-checkpoint.test.js` 的
  "a torn checkpoint left by an unfsynced rename is treated as absent and costs one cold
  pass"：把一份已提交的检查点整份写成零字节（未 fsync 的 rename 崩溃后可能留下的形状），
  断言它被当作缺席、下一次 pass 仍是 `{applied: 0, duplicates: 3}`（不重复应用任何记录）、
  并重写出内容完全相同的检查点。
- **阶段清单的回归本来就在**：`archive-stage.test.js` 的 "recovery installs a staged
  archive when the install is interrupted" 在 pending 记录提交后把清单写成
  `torn manifest`，断言恢复按 `pending.files` 完成安装、stage 被清空、每个记录文件都到位。
- **字节等价**：`domain-derived-fsync.mjs` 用冻结时钟 + 确定性 `randomUUID` 让两侧执行
  同一份工作负载，并在结束时对**整份官方文档 + 整个归档树**取摘要（只把本次运行自己的
  临时根目录替换成占位符；该路径是提交时写入 `coldArchives` 的暂存目录名）。九次运行
  （3 轮 × 3 侧）的摘要完全相同：
  `e4626a226dc2e4f3c4e633a110bef927e0192662c5cdf70040d1f885889367ac`；检查点内容摘要
  （排除 `file.dev`/`file.ino` 及其 MAC 覆盖）也完全相同
  （`a8ef089a6e5e9fc9b850c11963e4c2d30cdf9ad608545a206d164785c56941dd`，992 条记录）。
  这一比较证明的是**该固定工作负载**的等价，不是所有输入的等价；"所有输入"那部分由
  `aggregate-schema-equivalence.test.js` 的语料承担。差分等价性测试
  `domain-storage-write-path-equivalence.test.js` 另外把 `lib/domain-storage.js` 逆向
  还原到 `release/dsh-evolution-0.2.0-rc.8.tgz` 的源码，要求逐字节一致（本轮为该 schema
  改动新增了一条反向片段，并断言工作树确实不再有 `catchall(json)`、固定产物确实还有），
  并在真实端口上比较两边提交后的持久化字节。
- **故障注入**：`storage.test.js` 的"被拒绝的提交不安装暂存归档"、`replay-batch-commit`
  的"组事务失败整组不落盘""认证拒绝保留前缀"、`event-log-checkpoint` 的"监听者改写
  pending 记录无法绕过校验"仍然全绿；本轮没有改动事务、锁、CAS、journal、canary、
  恢复顺序或任何持久化字段。

**独立审核**（Codex `gpt-6.1-sol`，只读，自己跑了两组聚焦测试共 44 项与一次完整参数基准）
的结论与处理：

1. **阻断项：`passthrough()` 改变了持久化字节。** 它复现了嵌套自有 `__proto__` 键在旧
   schema 下被 `z.record` 的属性赋值丢掉、在新 schema 下被保留，并用真实 `pending.aggregate`
   + 官方后端确认落盘字节不同。上面第 3.3 节的 `stripOwnProtoKeys` 是据此加入的修复，差分
   测试补上了嵌套/数组/metric map 三种位置，并已用"去掉该函数即失败"验证过。
2. 它另外独立验证了：两版 `writeEventLogCheckpoint()` 写出的字节完全一致；检查点缺失、
   空文件、零填充、截断、未知 schema、合法 JSON 但 digest 错误、旧检查点、以及检查点领先
   或落后于已提交标记表等各种组合都退回逐条认证；`lib/`、`scripts/`（含 doctor）没有
   任何恢复路径读 `.archive-files.json`；投影仍然深度隔离输入，没有把活状态别名写进持久化
   字节。
3. 它指出的文档问题已全部修正：逐轮数据表与 JSON 不一致、`98–131 KB` 的逐场景文档大小
   没有脚本支持（已删除该列，只保留脚本真正测到的结束大小 392,669 字节）、`warmup` 字段
   的描述与脚本不符（现在如实说明只有开头的 flush 与 observe 预热，积压场景不单独预热）。

本机实际结果（在提交后的干净工作树上复核）：聚焦 6 个文件 45 项全绿；全量 `npm test` 674 项
全绿；`npm run pack:check` 按开发阶段判定为"固定点的已提交后继"，逐条点名差异的分发文件；
`npm run release:verify` 通过（rc.17 固定产物的字节与 51 个条目未变）。本轮没有修改版本、
`release/`、`release/manifest.json` 或任何既有验收证据，因此这些开发字节仍是**未发布**的。

## 7. 复现

```sh
# 主 A/B（两侧各自独立进程；--lib 指向另一侧 lib 目录）
node --max-old-space-size=4096 scripts/benchmarks/domain-derived-fsync.mjs
node --max-old-space-size=4096 scripts/benchmarks/domain-derived-fsync.mjs --lib /tmp/baseline/lib

# 基线导出（与既有轮次相同的做法）
task_baseline_dir=$(mktemp -d /tmp/dsh-derived-fsync-baseline.XXXXXX)
git archive 4202f39 | tar -x -C "$task_baseline_dir"
ln -s "$PWD/node_modules" "$task_baseline_dir/node_modules"

# 参数：BENCH_EVENTS（历史条数，默认 200）、BENCH_SAMPLES（默认 9）、BENCH_WARMUP（默认 3）、
# BENCH_BACKLOG（默认 0,1,2,5,10）
BENCH_EVENTS=200 BENCH_SAMPLES=9 BENCH_WARMUP=3 BENCH_BACKLOG=0,1,2,10,25,50 \
  node --max-old-space-size=4096 scripts/benchmarks/domain-derived-fsync.mjs --lib /tmp/baseline/lib
```

第 2.1、2.2、2.3 节的分段计时、fsync 调用点与 `stateStore.update` 计时来自临时探针
（不入库，遵循 `domain-replay-batch.md` 的同样做法）：分别是在 `mutate()` 各阶段边界打点、
同时挂 `fs.fsyncSync` 与 `FileHandle#sync` 并按调用栈归组、以及在 `createMemory()` 的
`update` 里累计 `aggregateSchema.parse` 的耗时。它们只读计时，不改变被测代码的行为。
