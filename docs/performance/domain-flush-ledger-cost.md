# 事件同步：新事件提交路径上的两处重复构造

基线为本轮开始前的 `main` 提交 `c85dfa7`（已核实）。本轮只删除**每次有新事件时那个事务里
两处重复构造的中间值**：标记表合并时按 pair 数组展开的一次整表物化，以及工作存储
`load()` 里对同一份 aggregate 的第二次深拷贝。不改持久化格式、认证、摘要覆盖面、事务、
恢复、回滚、跨进程锁与任何拒绝语义，也没有修改官方 DSH 源码；没有新增缓存或持久字段。

原始数据：

- A/B：[`domain-flush-ledger-cost.json`](domain-flush-ledger-cost.json)，脚本
  [`scripts/benchmarks/domain-flush-ledger-cost.mjs`](../../scripts/benchmarks/domain-flush-ledger-cost.mjs)
- 分项归因：[`domain-flush-ledger-attribution.json`](domain-flush-ledger-attribution.json)，脚本
  [`scripts/benchmarks/domain-flush-ledger-attribution.mjs`](../../scripts/benchmarks/domain-flush-ledger-attribution.mjs)

环境：Node `v26.12.1` / `darwin/arm64`，8 逻辑 CPU。A/B 开始/结束的 load average 为
`2.22/2.03/1.84` → `1.84/1.97/1.84`。

## 1. 路径与形状

`domainStorage.flush()` 在 `agent/pre-step` 与每个 Evolution 工具结束时被调用，两次都进入
`replay()`。这条路径有两种形状：

| 形状 | 频率 | 本轮是否触及 |
| --- | --- | --- |
| 无新事件（稳态） | 每步骤 / 每次工具结束 | 否：只读日志、认证已消费前缀、核对标记摘要；不进入 `mutate()`。两侧实测差在噪声内（§5 前 3 行与第 4/7 行） |
| 有新事件（积压） | 一次工具调用可连发 2–3 条记录；两步骤之间观察者写入；停机期间的追加在下次启动集中到来 | 是：一次 `mutate()` 事务，本轮只动它内部两处构造 |

一次有新事件的事务（非暂存路径）依次做：`installPending()` 校验持久文档并安装中断的
pending 记录 → 冻结比较基线 → 合并调用方标记表 → 硬链接镜像归档树 → 建工作存储 →
应用记录 → 取 aggregate 快照 → 比较「我读到的文档是否仍是已提交的那个」→ 推进提交
token → 写整份文档 → 重新加载。暂存路径多一次 pending 记录写入与安装。

## 2. 归因：哪些是必要的完整性成本，哪些是重复工作

在真实官方后端上按阶段打点（`domain-flush-ledger-attribution.mjs`；两侧各自用同样的
patch 包住同一批调用点，patch 找不到唯一调用点就报错），20000 条历史、1 条新事件、
7 个样本，每次 flush 的墙钟分项（ms，阶段嵌套：`memory.create`/`hydrate` 内部各含一次
`memory.cloneLoad`）：

| 阶段 | 基线 | 本轮之后 | 变化 |
| --- | ---: | ---: | ---: |
| `set.final`（整份文档投影 + 后端串行化 + 写入 + 两次 fsync） | 17.39 | 17.22 | 噪声（未触及） |
| `plan`（读检查点 + 标记摘要 + 读并哈希日志 12.76 MB） | 9.85 | 9.81 | 噪声（未触及） |
| `merge`（`mergeEventLedger()`） | **7.82** | **5.78** | **−2.04** |
| `checkpoint.write`（第二次标记摘要 + 写检查点） | 5.08 | 5.03 | 噪声（未触及） |
| `copy.baseline`（冻结比较基线 `{ ...recovered }`） | 4.00 | 3.96 | 噪声（未触及） |
| `copy.replayLedger`（调用方自己的冻结表 `{ ...applied }`） | 3.83 | 3.90 | 噪声（未触及） |
| `memory.create`（`createMemory()`，含 `memory.cloneLoad`） | 0.94 | 0.90 | 空 aggregate 下无可测差异 |
| `hydrate`（提交后重新加载，含 `memory.cloneLoad`） | 0.64 | 0.62 | 同上 |
| 合计 CPU | 50.73 | 48.07 | **−2.66** |

同一套打点，聚合体非空（lived-in 热窗口，持久文档 3.19 MB）：

| 阶段 | 基线 | 本轮之后 | 变化 |
| --- | ---: | ---: | ---: |
| `set.final` | 18.57 | 18.96 | 噪声（未触及） |
| `plan` | 9.83 | 9.91 | 噪声（未触及） |
| `merge` | 7.60 | **5.97** | **−1.63** |
| `checkpoint.write` | 5.02 | 5.06 | 噪声（未触及） |
| `copy.baseline` | 3.87 | 3.91 | 噪声（未触及） |
| `copy.replayLedger` | 3.82 | 3.96 | 噪声（未触及） |
| `memory.create`（含其 `memory.cloneLoad`） | 3.58 | **2.05** | **−1.53** |
| `hydrate`（含其 `memory.cloneLoad`） | 3.52 | **2.06** | **−1.46** |
| `memory.cloneLoad`（嵌套在上面两项里） | **2.84** | **0.001** | **−2.84** |
| `snapshot` | 1.41 | 1.43 | 噪声（未触及） |
| 合计 CPU | 61.58 | 58.52 | **−3.06** |

分项表只用来说明 A/B 的差值落在哪一帧；端到端结论由 §5 的 A/B 承担。单帧在两次运行之间
可漂移约 ±1 ms，因此只把被删除的两帧当作结论。

**哪些是必要完整性成本（本轮不碰，并且已说明理由）：**

- `copy.replayLedger`：`replay()` 必须在不含 `await` 的同步段里冻结「本组记录校验时所看到
  的已提交标记表」，因为 `mutate()` 里 `installPending()` 会把中断提交的标记表装回来；
  冻结之后再合并，才能对**任何**两侧不一致的 eventId 抛 `E_DOMAIN_EVENT_ID_CONFLICT`，
  而不是只对本组记录判断。少一次复制就要么在 `await` 之后读已被替换的活对象，要么把
  「整表冲突」降级成「本组冲突」。
- `copy.baseline` + `sameEventLedger`：发布前必须证明「我读到的文档仍是已提交的那个」。
  引用相等不能用（同进程可以原地改写同一个 map），摘要也不能替代（这是此前
  `appliedDigest` 复用被撤回的原因：O(1) 信号无法证明 O(历史) 状态未变，
  `redundant-work.md` §4.1）。全表比较必须对一个**冻结副本**做，所以副本与比较都是它
  的语义。
- `merge` 里的 `{ ...recovered }`：并集必须按 `recovered` 的键序发布（新键按调用方顺序
  追加），否则持久化字节与 `appliedDigest` 都会变。删掉这次复制正是此前被四项反例撤回的
  方向（`domain-flush-history-cost.md` §9）。
- `digestApplied()` ×2、读日志并哈希、整份文档写入、zod 校验、`installPending()` 的整份
  文档校验：认证/原子性边界，本轮不改（前两项的复用方向已撤回，见 §8）。
- `snapshot()`、`copy.baseline` 之外的 `structuredClone(initial)`：事务必须与共享文档
  脱钩，且要让介质无法存储的活值在改动任何字节之前失败（§4）。

**哪些是可删除的重复工作（本轮改掉）：**

1. `mergeEventLedger()` 用 `Object.entries(applied)` 展开调用方表：为 20000 个标记各分配一个
   `[eventId, mac]` 二元数组，只为立刻读回这两个值丢掉数组。改成 `Object.keys()` 加一次
   索引读取后，访问的键集合、顺序、每个值的读取次数都不变（§3.1）。
2. `createMemory()` 的 store 在 `load()` 里对 `aggregate` 再做一次 `structuredClone`：同一
   调用里、同一份值、中间对象没有任何读者（§3.2）。

## 3. 改动

两处都在 `lib/domain-storage.js`，共 2 个逻辑行加注释。

### 3.1 `mergeEventLedger()`：按 key 走一遍，不物化 pair 数组

```js
const merged = { ...recovered };
for (const eventId of Object.keys(applied)) {
  const mac = applied[eventId];
  const known = merged[eventId];
  if (known !== undefined && known !== mac) throw new Error('E_DOMAIN_EVENT_ID_CONFLICT');
  merged[eventId] = mac;
}
```

等价性：`Object.entries(x)` 的语义是「取一次 own keys、逐键读描述符取可枚举者、再逐键 Get」，
`Object.keys(x)` 是同一个键集合与顺序、不 Get，随后我们的索引读取补上**同一次** Get。两者
对同一个 own enumerable string key 集合访同样的键、同序、每个值读一次；差别只是
`Object.entries` 额外分配 `2N` 个数组元素。这个断言对任何「own 属性全是数据属性」的表都
成立，而本函数的唯一调用方 `replay()` 的 `commit()` 就是：

```js
const ledger = { ...domain.global.get().applied };
for (const entry of entries) ledger[entry.eventId] = entry.mac;
```

即先展开、再逐条赋字符串 MAC——所有 own 属性都是 spread/赋值写出的数据属性，任何数量的
`await` 都不会把它变成别的东西（它是事务私有对象，不在共享文档里）。symbol 键、不可枚举
属性、整数样键、顺序、`__proto__`/`constructor`/`toString`/`valueOf`/`hasOwnProperty` 的
原型语义、`undefined` 值的行为全部由差分钉住（§4）。唯一的形状差异是「带 accessor 的表」：
那时 `Object.entries` 会交错读描述符与值，可能对「读一个键的 getter 会删掉另一个键」的
表产生不同结果；端口没有任何路径能构造这样的调用方表（活表在 `replay()` 里被 spread 成
数据属性），这一点也由真实端口的 accessor 测试单独钉住读次数（§4）。

### 3.2 工作存储的 `load()`：不再第二次克隆

```js
const stateStore = { filePath: ..., inlineSerialization: true, load: async () => aggregate,
  update: async updater => { const next = updater(aggregate); assertTransactionSave(next); aggregate = next; } };
```

`aggregate` 是 `createMemory()` 一开始就 `structuredClone(initial)` 出来的那份值（这次 eager
克隆保留：它是事务与共享文档脱钩的地方，也是介质无法存储的活值失败的地方）。`load()` 的唯一
读者是紧接着创建的 `EvolutionMemory`，它自己的 `load()` 被 `loaded` 守卫、只会读一次，并且
把值 spread 进自己的状态（保留 collection 数组），不持有、也不改写 store 的对象。store 之后
唯一读这个值的地方是 `update` 的 `{ ...aggregate, evolution: payload }`：它把 aggregate 唯一
的键 `evolution`（`aggregateSchema` 只承认这一个键）整体替换成 payload 后才保留结果，所以
第二次克隆出来的那份值没有任何读者。`test/domain-storage/transaction-detachment.test.js`
从端口外面钉住两侧仍然成立的两条边界：活值 `structuredClone` 无法复制时事务在写任何持久
字节前失败，以及活文档的原地改写不会被提交后的文档反向暴露。

审查记录（非阻断，已知边界）：store 的 `load()` 现在返回自己的状态对象而不是每次克隆一份。
端口路径只读它一次（`EvolutionMemory.load()` 的 `loaded` 守卫），而 `reconcile()`/
`verifyConsistency()`（同样会读 `stateStore.load()`）没有任何端口路径会走到——这一点在
`createMemory` 的既有注释里已经写明。第一次 `update` 之后 store 保存的本来就是
`{ ...payload }` 这种共享 collection 数组的浅视图，因此「第二次读到的不是一份独立快照」
并不是本轮新引入的性质。

## 4. 等价性

### 4.1 冻结时钟 + 确定性 UUID 的持久字节对拍

A/B 脚本的 equivalence 轮（`docs/performance/domain-flush-ledger-cost.json` 的
`equivalence` 字段）对全部 17 个场景，在冻结时钟与确定性 UUID 序列下要求两侧：

- 官方持久文档（`official/evolution_domain.json`）**逐字节相同**；
- 检查点内容字段（`schema/bytes/records/digest/writer/first/last/appliedDigest`）相同，
  文件身份字段仍然存在（它们本按 fixture 不同）；
- `dockyard/` 归档树每个文件的 sha256 相同；种子非空归档的场景断言比较的文件数 ≥ 2
  （实测 2–4 个文件）；
- 重启后持久文档与检查点**字节不变**（证明启动 replay 没有重做任何事），且没有遗留
  暂存目录；
- 持久文档的 `pending` 为 `null`，标记数正好等于 `历史 + 新事件 × (warmup + samples)`；
- 非空 aggregate 的场景确实比较了非空 aggregate（非空集合数 > 0）。

### 4.2 新增回归

- `test/domain-storage/ledger-merge-differential.test.js`：22 个形状逐条与**逐字复制的旧
  实现**比较（JSON 文本含键序，或同样的拒绝）：覆盖 `__proto__`（自有键）、`constructor`、
  `toString`、`valueOf`、`hasOwnProperty`、`undefined` 值、两表顺序不同、整数样键、symbol
  键、不可枚举属性、5000 条大表，以及 `replay()` 实际交进来的「spread + 赋值」形状。用历史
  上被撤回的 `mergeEventLedger` 免复制短路替换实现后，该文件的「每个形状」与「原型名拒绝」
  两项会失败（本轮实测过），说明它不是自证。
- `test/domain-storage/marker-table-special-keys.test.js`：真实端口 + 真实官方后端，把同一
  工作负载分别喂给 `release/dsh-evolution-0.2.0-rc.8.tgz` 里固定的旧实现与本轮工作树，要求
  结局、持久文档、检查点内容、归档树全部逐字节相同。场景：自有 `__proto__` 标记、活表上的
  accessor（值稳定）、不可排序的标记顺序 + 两条记录的批次、`undefined` 值被调用方覆盖、
  原型名标记回退后重放；另有两个直接断言：读一次会变值的 accessor 在「合并读冻结副本」时
  触发冲突码且不落任何持久字节，以及「记录名落在 `Object.prototype` 上」的 pass 被拒绝、
  不发布该名字的标记。
- `test/domain-storage/transaction-detachment.test.js`：活 aggregate 携带 `structuredClone`
  无法复制的值时，事务在写任何持久字节之前失败（拒绝后文档/检查点/归档字节完全不变、
  无 pending 记录、暂存目录没有被任何持久记录命名），之后同一条记录恰好被应用一次；以及
  活文档的原地改写只会影响下一次事务读到的起点，不会被已提交的文档反向暴露。
- 既有差分锚点：`domain-storage-write-path-equivalence.test.js` 仍要求
  `reconstructPreMerge()` 的重建结果与固定 rc.8 产物**逐字节相同**（本轮文本变化后该断言
  仍通过，说明两个 harness 的锚点更新没有改变它们重建出来的基线）。
- 既有失败路径覆盖未改且全部通过：同 ID 不同 MAC 冲突、端口存活期间经官方句柄回退标记表
  （替换对象与原地改写两种形态）、跨重启回退、介质替换后目录 `fsync` 失败、并发覆盖、
  pending 恢复、组大于 4096 条标记窗口时的同端口重试、`domain-storage-write-path-equivalence`
  对 rc.8 的差分。

## 5. 可复现 A/B

```sh
node scripts/benchmarks/domain-flush-ledger-cost.mjs --rounds 3 --samples 9 --warmup 3 \
  --out docs/performance/domain-flush-ledger-cost.json
```

基线侧用 `git show c85dfa7:lib/domain-storage.js` 还原到一份 `lib/` 副本（`node_modules`
软链到本仓库），候选侧就是工作树；脚本对两侧源码做形状断言（基线必须仍是
`Object.entries(applied)` 与 `structuredClone(aggregate)`，候选必须已经是 `Object.keys`
与 `aggregate`），任一侧不匹配就直接失败，不会把同一份代码比较两次。每轮交替先后顺序；
3 轮 × 9 样本取中位数。每个样本都断言 `flush()` 返回的 `{applied, duplicates}`。

| 场景（历史 / 新事件） | 文档写入/次 | 基线墙钟 | 之后 | Δ墙钟 | 基线 CPU | 之后 | ΔCPU | 每轮墙钟（基线） |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 200 / 0 | 0 | 0.19 ms | 0.17 ms | −8.7% | 0.18 ms | 0.17 ms | −7.6% | 0.188 / 0.171 / 0.185 |
| 200 / 1 | 1 | 11.72 | 11.86 | +1.2% | 5.36 | 4.87 | −9.0% | 12.611 / 10.748 / 11.725 |
| 200 / 3 | 1 | 11.58 | 11.61 | +0.2% | 4.95 | 4.91 | −0.8% | 11.585 / 11.936 / 10.459 |
| 2000 / 0 | 0 | 1.05 | 1.04 | −0.9% | 1.05 | 1.04 | −0.9% | 1.158 / 1.05 / 1.029 |
| 2000 / 1 | 1 | 14.54 | 13.95 | −4.1% | 7.30 | 7.08 | −3.1% | 14.539 / 13.92 / 14.864 |
| 2000 / 3 | 1 | 14.81 | 14.75 | −0.4% | 7.82 | 7.51 | −3.9% | 14.82 / 14.81 / 13.663 |
| 20000 / 0 | 0 | 10.69 | 10.61 | −0.8% | 10.69 | 10.61 | −0.8% | 10.678 / 10.699 / 10.692 |
| 20000 / 1 | 1 | 58.67 | 56.90 | **−3.0%** | 50.97 | 48.81 | **−4.2%** | 58.781 / 58.674 / 58.137 |
| 20000 / 3 | 1 | 59.56 | 58.27 | **−2.2%** | 52.04 | 50.36 | **−3.2%** | 59.667 / 59.56 / 59.457 |
| 2000 / 1 / 非空 aggregate | 1.22 | 25.94 | 22.99 | **−11.4%** | 21.58 | 15.67 | **−27.4%** | 25.937 / 26.031 / 25.833 |
| 2000 / 3 / 非空 aggregate | 2.00 | 58.43 | 54.88 | **−6.1%** | 36.80 | 31.56 | **−14.2%** | 58.431 / 59.168 / 58.04 |
| 20000 / 1 / 非空 aggregate | 1.22 | 71.97 | 66.83 | **−7.1%** | 65.65 | 59.94 | **−8.7%** | 71.965 / 71.113 / 72.196 |
| 20000 / 3 / 非空 aggregate | 2.00 | 129.08 | 124.52 | **−3.5%** | 101.38 | 97.34 | **−4.0%** | 128.718 / 130.671 / 129.08 |
| 2000 / 1 / 非空聚合 + 非空归档 | 1.22 | 27.15 | 24.16 | **−11.0%** | 22.34 | 16.69 | **−25.3%** | 26.719 / 27.152 / 28.075 |
| 20000 / 1 / 非空聚合 + 非空归档 | 1.22 | 73.66 | 68.49 | **−7.0%** | 66.65 | 61.80 | **−7.3%** | 73.829 / 72.843 / 73.656 |
| 2000 / 1 / 每次归档（暂存双写） | 2.00 | 57.87 | 53.86 | **−6.9%** | 31.87 | 31.63 | −0.7% | 55.872 / 57.865 / 57.921 |
| 2000 / 3 / 每次归档（暂存双写） | 2.00 | 60.25 | 57.94 | **−3.8%** | 39.22 | 32.77 | **−16.5%** | 60.251 / 60.889 / 58.153 |

逐样本原始值（墙钟、CPU、每轮两侧的全部样本）在 JSON 的 `results[].rounds[]` 里；机制计数
在 `results[].summary` 里；`delta` 给出中位数差。

读法：

- **稳态没有收益也不该有**（20000/0：−0.8%，2000/0：−0.9%，200/0 的绝对量是 0.02 ms）。
- 收益随历史长度增长，因为第一处改动删掉的是与标记数成正比的 `2N` 分配：200/2000 的
  绝对量在 0.02–0.2 ms，落在噪声里；20000 条历史时是每次 flush −2.04 ms（分项表），
  端到端 −3.0%/−4.2%。
- 第二处改动只与 aggregate 大小相关：空 aggregate 下不可测；lived-in 热窗口下每次事务少
  克隆约 0.6 MB（§6），端到端 −7.0%…−11.4%（20000 与 2000 历史）。
- 2000 历史 + 非空 aggregate 的 CPU 百分比（−27.4%）大于分项表能解释的 clone + merge
  差（约 −4.6 ms），其余部分归因于少一次 0.6 MB 分配带来的 GC/分配器差异，本轮没有单独
  分离，因此不作为结论，只报告数值。

## 6. 机制计数（同一脚本的插桩轮，每次 flush）

| 每次 flush（20000 历史 / 1 新事件） | 基线 | 之后 |
| --- | ---: | ---: |
| 整份文档写入（官方单元 rename） | 1 | 1 |
| 文档写入的 `FileHandle.sync()`（文件 + 目录） | 2 | 2 |
| 读日志字节 | 12 760 696 | 12 760 696 |
| 喂给 SHA-256/HMAC 的字节 | 17 702 932 | 17 702 932 |
| `readSync` | 14 | 14 |
| `readdirSync`（live / stage） | 37 / 37 | 37 / 37 |
| `linkSync`（live / stage） | 0 / 0 | 0 / 0 |
| `structuredClone` 调用 | 7 | **5** |
| 被 `structuredClone` 复制的字节 | 28 792 | 17 621 |
| `structuredClone` 墙钟（含插桩时的度量串行化） | 0.15 ms | 0.10 ms |
| GC 条目 / GC 墙钟 | 0.78 / 0.44 ms | 0.67 / 0.50 ms |

聚合体非空的场景（20000 / 1 / 非空 aggregate）：`structuredClone` 55.3 → 53.3 次，
被复制字节 1 561 054 → 947 752（**每次 flush 少 613 KB**），克隆墙钟 7.15 → 4.23 ms；
整份文档写入 1.22 / `FileHandle.sync()` 2.44 / 读日志字节 / 摘要字节 / `readSync` /
`readdirSync` / `linkSync` 两侧完全相同（该场景 9 个样本里有 2 次因内存自身的保留策略
走了暂存双写，两侧次数一致）。

因此本轮删的是 **CPU 与分配**，不是 I/O：写入次数、fsync 次数、读日志字节、摘要字节都
不变；认证强度与覆盖面也没有变。

## 7. 收益边界

- 第一处改动与**已提交标记数**线性：20000 条时每次 flush 约 −2 ms；2000 条时约 −0.2 ms
  （噪声）；200 条时不可测。历史越长收益越大。
- 第二处改动与**aggregate 大小**线性：空 aggregate 无收益；热窗口约 0.6 MB 时每次事务
  少复制 0.6 MB（两个 `createMemory()` 各一次），端到端 3%–11%，取决于 fsync 与文档
  写入占的比例。
- 百分比会在更快 `fsync` 的宿主或更大的文档上变小（同一份 CPU 收益被更大的 I/O 摊薄），
  在更慢的存储上变大。
- 没有测量冷页缓存、网络文件系统、其它平台、多进程竞争、真实生产 aggregate 分布，也没有
  测量 `--expose-gc` 下的峰值堆；GC 只报告了 `PerformanceObserver` 的条目数与时长。

## 8. 本轮排除 / 复核后不做的方向

| 候选 | 结论 | 依据 |
| --- | --- | --- |
| 去掉 `copy.baseline`，用 `latest.applied` 与发布表 `ledger` 比较 | 不做 | 这会接受「同进程写入方恰好写出本事务的目标表」的情形，删掉一次基线承诺的拒绝（`E_COMMIT_OVERWRITTEN`）。 |
| 用引用相等 / `appliedDigest` 摘要替代 `sameEventLedger()` 全表比较 | 不做 | 引用相等看不见原地改写；摘要复用已在 `redundant-work.md` §4.1 被两轮反例撤回（O(1) 信号无法证明 O(历史) 状态未变）。 |
| `mergeEventLedger()` 免复制（「并集已成立」短路） | 已撤回，不复用 | `domain-flush-history-cost.md` §9 的四项反例（原型名、`undefined` 值、键序、accessor 读两次）；本轮只改**读取方式**，复制与拒绝都不变。 |
| 复用检查点里的 `appliedDigest` | 已撤回，不复用 | 同上。 |
| 跳过 `installPending()` 对整份文档的校验（只校验使用点） | 已撤回，不复用 | `redundant-work.md` §4.2：让被拒绝的事务先改动实时归档树。 |
| 手工重写对象展开语义以加速三处复制（赋值而非 `defineProperty`） | 不做 | 实测本机 20000 键：`{...x}` 3.72 ms、逐键赋值 2.31 ms、逐键 `defineProperty` 4.15 ms。赋值版在原型被污染、`__proto__` 自有键、proxy trap 次数上不可证明等价；`defineProperty` 版更慢。 |
| 用 `Object.keys(right).length` 之外的写法数右侧键数（`for...in` + `hasOwn`） | 不做 | 实测更慢（1.58 ms vs 1.28 ms / 20000 键），且对 proxy 的 trap 序列不同。 |
| 复用上一次事务的暂存目录 / 预取 staging | 不做 | 与现有不变量冲突，见 `archive-index-churn.md` §7。 |

## 9. 验证

```sh
NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/
NODE_OPTIONS=--max-old-space-size=4096 npm test
npm run release:verify
npm run pack:check
node scripts/benchmarks/domain-flush-ledger-cost.mjs --rounds 3 --samples 9 --warmup 3
```

结果见 §11（每次实际执行后填写；未执行的项不写通过）。

## 10. 独立审核记录

见 §12。

## 11. 本轮实际执行的检查

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 领域存储全部单测 | `NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/` | 75 项全部通过（含两个差分 harness 的固定产物断言） |
| 全量回归 | `NODE_OPTIONS=--max-old-space-size=4096 npm test` | 699 项：698 通过，1 项 `release-pin` 因「分发文件尚未提交」失败（提交后重跑，见下） |
| 固定产物 | `npm run release:verify` | 与 `release/manifest.json` 一致：`d0c119f0…` / content `fb4e77b5…`，未改动 |
| 分发内容 | `npm run pack:check` | 见下（需要先提交） |
| 真实宿主验收 | `npm run acceptance:host -- --host …` | 见下 |

## 12. 独立审核

（待填：轮次、阻塞项与否决/修复。）
