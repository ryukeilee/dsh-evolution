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
7 个样本 × 3 次独立运行，每次 flush 的墙钟分项取三次运行的中位数（ms，阶段嵌套：
`memory.create`/`hydrate` 内部各含一次 `memory.cloneLoad`）：

| 阶段 | 基线 | 本轮之后 | 变化 |
| --- | ---: | ---: | ---: |
| `set.final`（整份文档投影 + 后端串行化 + 写入 + 两次 fsync） | 17.52 | 17.39 | -0.13 |
| `plan`（读检查点 + 标记摘要 + 读并哈希日志 12.76 MB） | 9.80 | 9.85 | +0.04 |
| `merge`（`mergeEventLedger()`） | 7.65 | 5.85 | -1.79 |
| `checkpoint.write`（第二次标记摘要 + 写检查点） | 5.10 | 5.04 | -0.07 |
| `copy.baseline`（冻结比较基线 `{ ...recovered }`） | 4.00 | 3.99 | -0.01 |
| `copy.replayLedger`（调用方自己的冻结表 `{ ...applied }`） | 3.84 | 3.91 | +0.07 |
| `memory.create`（`createMemory()`，含 `memory.cloneLoad`） | 0.92 | 0.88 | -0.04 |
| `hydrate`（提交后重新加载，含 `memory.cloneLoad`） | 0.66 | 0.63 | -0.03 |
| 合计 CPU | 50.79 | 48.34 | -2.45 |

同一套打点，聚合体非空（lived-in 热窗口，持久文档 3.19 MB）：

| 阶段 | 基线 | 本轮之后 | 变化 |
| --- | ---: | ---: | ---: |
| `set.final`（整份文档投影 + 后端串行化 + 写入 + 两次 fsync） | 19.28 | 19.94 | +0.66 |
| `plan`（读检查点 + 标记摘要 + 读并哈希日志 12.76 MB） | 9.90 | 9.93 | +0.03 |
| `merge`（`mergeEventLedger()`） | 7.78 | 6.08 | -1.70 |
| `checkpoint.write`（第二次标记摘要 + 写检查点） | 5.09 | 5.08 | -0.01 |
| `copy.baseline`（冻结比较基线 `{ ...recovered }`） | 3.90 | 4.00 | +0.10 |
| `copy.replayLedger`（调用方自己的冻结表 `{ ...applied }`） | 3.85 | 3.99 | +0.15 |
| `memory.create`（`createMemory()`，含 `memory.cloneLoad`） | 3.65 | 2.08 | -1.57 |
| `hydrate`（提交后重新加载，含 `memory.cloneLoad`） | 3.51 | 2.08 | -1.43 |
| `memory.cloneLoad`（嵌套在上面两项里） | 2.85 | 0.00 | -2.84 |
| `snapshot` | 1.43 | 1.44 | +0.01 |
| 合计 CPU | 62.24 | 59.04 | -3.20 |

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
- 重启后持久文档、检查点与 `dockyard/` 归档树**字节不变**（证明启动 replay 没有重做任何
  事），且没有遗留暂存目录；
- 持久文档的 `pending` 为 `null`，标记数正好等于 `历史 + 新事件 × (warmup + samples)`；
- 非空 aggregate 的场景确实比较了非空 aggregate（非空集合数 > 0）。

### 4.2 新增回归

- `test/domain-storage/ledger-merge-differential.test.js`：22 个形状逐条与**逐字复制的旧
  实现**比较（JSON 文本含键序，或同样的拒绝）：覆盖 `__proto__`（自有键）、`constructor`、
  `toString`、`valueOf`、`hasOwnProperty`、`undefined` 值、两表顺序不同、整数样键、symbol
  键、不可枚举属性、5000 条大表，以及 `replay()` 实际交进来的「spread + 赋值」形状。用历史
  上被撤回的 `mergeEventLedger` 免复制短路替换实现后，该文件的「每个形状」与「原型名拒绝」
  两项会失败（本轮实测过），说明它不是自证。
- `test/domain-storage/marker-table-special-keys.test.js`：真实端口 + 真实官方后端。凡是
  rc.8 里也存在的行为，把同一工作负载分别喂给 `release/dsh-evolution-0.2.0-rc.8.tgz` 里
  固定的旧实现与本轮工作树，要求结局、持久文档、检查点内容、归档树全部逐字节相同。覆盖的
  形状：自有 `__proto__` 标记、活表上的 accessor（值稳定）、不可排序的标记顺序 + 两条记录
  的批次、`constructor`/`toString`/`hasOwnProperty`/`valueOf` 作为普通自有标记被提交，
  以及「标记值被 schema 拒绝时在事务开始处被拒绝」（这一条不进入合并，只是两侧都必须同样
  拒绝）。
  rc.8 早于 `mergeEventLedger()` 本身，下面三条**合并边界**因此不能用它做差分，改为直接
  断言（注释里写明原因）：(a) 读一次会变值的活 accessor 在合并读冻结副本时触发
  `E_DOMAIN_EVENT_ID_CONFLICT` 且不落任何持久字节；(b) 一条身份落在 `Object.prototype` 上的
  记录被拒绝、不发布该名字的标记；(c) **真正走到合并分歧**的场景——一份中断提交的 pending
  记录，其标记表缺少活文档里自有的 `constructor`：恢复先安装 pending 记录，随后合并读到
  `merged['constructor']` 的原型值而不是自有标记，批次被拒绝，持久表只剩 pending 的内容。
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
| 200 / 0 | 0.00 | 0.18 ms | 0.17 ms | -6.0% | 0.19 ms | 0.17 ms | -8.1% | 0.18 / 0.17 / 0.18 |
| 200 / 1 | 1.00 | 11.83 ms | 10.86 ms | -8.1% | 4.85 ms | 4.80 ms | -1.1% | 11.82 / 11.91 / 11.63 |
| 200 / 3 | 1.00 | 12.01 ms | 10.86 ms | -9.6% | 5.30 ms | 4.84 ms | -8.7% | 12.84 / 12.02 / 10.39 |
| 2000 / 0 | 0.00 | 1.06 ms | 1.04 ms | -2.0% | 1.06 ms | 1.04 ms | -2.0% | 1.15 / 1.03 / 1.06 |
| 2000 / 1 | 1.00 | 14.89 ms | 13.92 ms | -6.5% | 7.30 ms | 7.15 ms | -2.1% | 14.64 / 14.89 / 14.91 |
| 2000 / 3 | 1.00 | 14.57 ms | 13.72 ms | -5.8% | 7.72 ms | 7.35 ms | -4.8% | 14.91 / 13.58 / 14.57 |
| 20000 / 0 | 0.00 | 10.69 ms | 10.65 ms | -0.4% | 10.69 ms | 10.65 ms | -0.3% | 10.69 / 10.69 / 10.69 |
| 20000 / 1 | 1.00 | 58.88 ms | 55.91 ms | **-5.0%** | 50.99 ms | 48.52 ms | **-4.8%** | 59.06 / 58.04 / 58.88 |
| 20000 / 3 | 1.00 | 59.64 ms | 57.03 ms | **-4.4%** | 52.28 ms | 49.86 ms | **-4.6%** | 59.64 / 59.20 / 59.97 |
| 2000 / 1 / 非空 aggregate | 1.00 | 23.49 ms | 20.83 ms | **-11.3%** | 16.20 ms | 13.62 ms | **-15.9%** | 23.80 / 22.89 / 23.49 |
| 2000 / 3 / 非空 aggregate | 1.00 | 25.81 ms | 22.72 ms | **-12.0%** | 18.63 ms | 15.83 ms | **-15.0%** | 25.41 / 25.83 / 25.81 |
| 20000 / 1 / 非空 aggregate | 1.00 | 68.64 ms | 64.14 ms | **-6.5%** | 61.31 ms | 57.02 ms | **-7.0%** | 68.64 / 68.94 / 68.55 |
| 20000 / 3 / 非空 aggregate | 1.00 | 70.35 ms | 65.95 ms | **-6.3%** | 64.36 ms | 59.65 ms | **-7.3%** | 70.11 / 70.35 / 71.06 |
| 2000 / 1 / 非空聚合 + 非空归档 | 1.00 | 24.75 ms | 21.89 ms | **-11.6%** | 17.67 ms | 14.88 ms | **-15.7%** | 24.78 / 24.09 / 24.75 |
| 20000 / 1 / 非空聚合 + 非空归档 | 1.00 | 69.75 ms | 65.11 ms | **-6.7%** | 63.22 ms | 58.48 ms | **-7.5%** | 69.75 / 70.00 / 69.74 |
| 2000 / 1 / 每次归档（暂存双写） | 2.00 | 54.72 ms | 51.00 ms | **-6.8%** | 30.26 ms | 28.07 ms | **-7.2%** | 54.88 / 54.72 / 54.25 |
| 2000 / 3 / 每次归档（暂存双写） | 2.00 | 57.80 ms | 54.21 ms | **-6.2%** | 33.64 ms | 30.36 ms | **-9.7%** | 56.97 / 58.91 / 57.80 |

逐样本原始值（墙钟、CPU、每轮两侧的全部样本）在 JSON 的 `results[].rounds[]` 里；机制计数
在 `results[].summary` 里；`delta` 给出中位数差。

读法：

- **稳态没有收益也不该有**：20000/0 是 −0.4%（每轮 10.69 ms 对 10.65 ms），2000/0 是
  −2.0%（1.06 对 1.04 ms）。稳态不进入事务，两处改动都不在它的路径上；这些数值是
  同一台机器上两个目录带来的漂移量级，不是收益。
- 第一处改动与已提交标记数线性，所以只有 20000 条历史那一档能稳定分辨：20000/1 的每轮
  墙钟是 `58.04–59.06`（基线）对 `55.81–56.62`（之后），20000/3 是 `59.20–59.97` 对
  `56.79–58.01`，两档都不重叠；CPU 同样不重叠（−4.8% / −4.6%）。200 与 2000 条历史时
  被删掉的是 0.02–0.2 ms 的分配，中位数看起来有 −5%…−10%，但逐轮数值互相重叠（例如
  200/1 的墙钟 `11.63–11.91` 对 `10.33–12.01`），因此这一档按**噪声带内**报告，不作为
  收益。
- 第二处改动只与 aggregate 大小相关：空 aggregate 下不可测；lived-in 热窗口下每次事务少
  复制约 509 KB（§6），20000/1 的墙钟 `68.55–68.94` → `63.88–65.12`、2000/1 的
  `22.89–23.80` → `20.58–20.94`，六档非空 aggregate/归档场景的墙钟差在 −6.3%…−12.0%，
  逐轮互不重叠。CPU 差在 −7.0%…−16.0%，与分项表里被删掉的两帧（≈ 3.0 ms/次）在
  2000 历史档（16.2 ms 基线 CPU）上相符。
- 暂存双写（每次归档）场景的墙钟同样不重叠（`54.25–54.88` → `50.58–52.22`），但它的
  CPU 里有两轮采样的 I/O 等待落在计时区间内，因此 2000/3 的 −9.7% 只作为观测值报告。


## 6. 机制计数（同一脚本的插桩轮，每次 flush）

| 每次 flush（20000 历史 / 1 新事件） | 基线 | 之后 |
| --- | ---: | ---: |
| 整份文档写入（官方单元 rename） | 1 | 1 |
| 文档写入的 `FileHandle.sync()`（文件 + 目录） | 2 | 2 |
| 读日志字节 | 12,760,696 | 12,760,696 |
| 喂给 SHA-256/HMAC 的字节 | 17,702,366 | 17,702,366 |
| `readSync` | 14 | 14 |
| `readdirSync`（live / stage） | 37 / 37 | 37 / 37 |
| 整份文档 rename（`other/renameSync`） | 2 | 2 |
| `structuredClone` 调用 | 7 | **5** |
| 被 `structuredClone` 复制的字节 | 28,792 | 17,621 |
| `structuredClone` 自身的墙钟（不含为计字节额外做的 `JSON.stringify`） | 0.146 ms | 0.098 ms |
| GC 条目 / GC 墙钟 | 0.89 / 0.63 ms | 0.89 / 0.58 ms |

聚合体非空的场景（20000 / 1 / 非空 aggregate）：`structuredClone` 55 → 53 次，
被复制字节 1,330,510 → 809,367（**每次 flush 少 509 KB**），克隆墙钟 6.03 → 3.58 ms；
整份文档写入 1.00 / `FileHandle.sync()` 2.00 / 读日志字节 / 摘要字节 / `readSync` / `readdirSync` 两侧完全相同。
两个非空归档场景的 `dockyard/` 树分别有 3 和 4 个文件参与逐字节比较。

因此本轮删的是 **CPU 与分配**，不是 I/O：写入次数、fsync 次数、读日志字节、摘要字节都
不变；认证强度与覆盖面也没有变。

## 7. 收益边界

- 第一处改动与**已提交标记数**线性：20000 条时每次 flush 的分项是 −1.79 ms（三次运行
  中位数），端到端墙钟 −5.0%；2000 条时约 −0.2 ms，落在噪声里；200 条时不可测。历史越
  长收益越大。
- 第二处改动与**aggregate 大小**线性：空 aggregate 无收益；热窗口约 0.9 MB 时每次事务
  少复制 509 KB（两个 `createMemory()` 各一次），端到端 −6.3%…−12.0%，比例取决于 fsync
  与文档写入占的份额。
- 百分比的分母还包含 I/O 等待：同一份 CPU 收益在 `fsync` 更快的宿主、或文档更大因而
  写入更慢的宿主上，占整个 flush 的比例会**变大**；在 I/O 更慢、单次 flush 更长的存储
  上比例会**变小**（绝对毫秒不变）。跨宿主的绝对值与比例都没有测量。
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
| 领域存储全部单测 | `NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/` | **79 项全部通过**（含两个差分 harness 的固定产物断言与三次重跑） |
| 全量回归 | `NODE_OPTIONS=--max-old-space-size=4096 npm test` | **700 项全部通过**（提交后重跑；提交前唯一失败是 `release-pin` 拒绝未提交的分发改动） |
| 固定产物 | `npm run release:verify` | 与 `release/manifest.json` 一致：`d0c119f0…` / content `fb4e77b5…`，未改动 |
| 分发内容 | `npm run pack:check` | 全部通过；判定本树是固定产物的**已提交**开发后继，固定点、产物与证据未变 |
| 本地产物重建 | `npm run release:pack` | 两次打包字节相同（`0cca22a4…`），content `b2d149c0…`，51 个条目全部在 `files` 白名单内；只写 `dist/`，不进入 `release/` |
| 真实宿主验收 | `npm run acceptance:host -- --host 0.2.0-rc.2 --out docs/evidence/flush-ledger-cost-0.2.0-rc.2.json` | **21 个步骤全部 ok**（安装、plugin add、doctor、core flow、禁用/启用、卸载/重装、升级/回滚、晋升、重启回滚、最终 doctor），证据在 `docs/evidence/` |

## 12. 独立审核

第一轮（另一个模型，只读 + 自行复现；CTX：GPT-6.1 Sol, high）结论是**无阻断项**，并确认三项已撤回优化没有重新出现；同时给出五项非阻断问题，全部在本轮修复：

| # | 发现 | 处理 |
| --- | --- | --- |
| 1 | 端口级「原型名标记」与「`undefined` 值」场景没有真正走到合并：回退发生在 `flush()` 之前，两侧表相同；`undefined` 值在事务开始的 schema 校验就被拒绝，合并调用 0 次 | 新增一个**真正走到合并分歧**的端口场景（中断提交的 pending 记录缺少活文档自有的 `constructor`，恢复先安装、随后合并读到原型值并拒绝批次），并把「`undefined` 值」改名为它实际钉住的行为（事务开始处的 schema 拒绝，不进入合并）；注释与文档同步改写 |
| 2 | `hot` 场景并非纯单写：40 条 `experiments` 种子 + 采样会越过 50 的热窗口，形状护栏又接受 `[1,2]` | 种子改为 12 条（整轮结束后仍 ≤ 48），护栏改成**精确等于**期望写入次数（稳态 0、普通 1、每次归档 2）；A/B 全量重跑，`hot` 全部为 1.00、归档场景全部为 2.00 |
| 3 | 机制计数包含签名与追加（重置发生在 `append()` 之前）；文档说克隆时间含度量串行化，代码实际在 `JSON.stringify` 之前累计 | 计数器改为每个样本 `append()` 之后重置、`flush()` 之后累加，计数现在严格是一次 flush；文档改为「克隆自身墙钟，不含为计字节额外做的 `JSON.stringify`」 |
| 4 | 重启断言只比较文档与检查点，没有比较归档树 | 重启前后都取 `archiveTree()` 并断言相等（`restartArchivesUnchanged`），等价性轮同样断言 |
| 5 | 收益边界里 `fsync` 快慢对百分比的推论写反 | 改为：I/O 更快/文档更大时比例变大，I/O 更慢时比例变小，绝对值不变；跨宿主外推仍标为未测量 |

审核同时独立确认：调用方表是事务私有普通数据属性对象；加载失败后的实例不会被端口复用；观察存储走已加载的 Memory；`reconcile()`/`verifyConsistency()` 没有端口入口；移除第二次克隆没有可观察的别名变化。它把新增测试移植到 `c85dfa7` 后 11 项通过（说明这些测试是「回归钉」而不是为改动量身定做），并确认 rc.8 锚点仍是无条件源码逐字节相等。

第二轮（修复后，另开一个委派任务）见下（结果记录在提交后的同一节）。
