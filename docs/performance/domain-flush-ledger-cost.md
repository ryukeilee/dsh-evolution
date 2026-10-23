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
`1.41/1.80/1.79` → `2.16/1.94/1.85`（见 JSON 的 `environment`）。

## 1. 路径与形状

`domainStorage.flush()` 在 `agent/pre-step` 与每个 Evolution 工具结束时被调用，两次都进入
`replay()`。这条路径有两种形状：

| 形状 | 频率 | 本轮是否触及 |
| --- | --- | --- |
| 无新事件（稳态） | 每步骤 / 每次工具结束 | 否：只读日志、认证已消费前缀、核对标记摘要；不进入 `mutate()`。§5 的稳态行中位数差在 2% 以内、绝对量小于 0.05 ms（该档只作噪声参考） |
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

- `test/domain-storage/ledger-merge-differential.test.js`：23 个形状逐条与**逐字复制的旧
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
  rc.8 早于 `mergeEventLedger()` 本身，下面三条因此不能用它做差分，改为直接断言（注释里
  写明原因与阶段）：(a) 读一次会变值的活 accessor：测试断言的是**结局**——pass 以
  `E_DOMAIN_EVENT_ID_CONFLICT` 拒绝且不落任何持久字节（它依赖合并读冻结副本、而不是再读
  一次活表，但并没有断言具体读次数）；(b) 一条身份落在 `Object.prototype` 上的记录：拒绝
  发生在 `absorb()` 的标记检查（`applied[eventId]` 读到原型上的函数），还没有进入合并，
  测试断言该记录被拒绝且持久表没有该名字的标记；(c) **真正走到合并分歧**的场景——一份
  中断提交的 pending 记录，其标记表缺少活文档里自有的 `constructor`：恢复先安装 pending
  记录，随后合并读到 `merged['constructor']` 的原型值而不是自有标记，批次被拒绝，持久表
  只剩 pending 的内容（这一条已用插桩确认真实经过 `mergeEventLedger`）。
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
5 轮 × 11 样本取中位数（插桩轮每个场景只在第一轮跑一次）。每个样本都断言 `flush()` 返回的 `{applied, duplicates}`。

| 场景（历史 / 新事件） | 文档写入/次 | 基线墙钟 | 之后 | Δ墙钟 | 基线 CPU | 之后 | ΔCPU | 每轮墙钟（基线） |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 200 / 0 | 0.00 | 0.22 ms | 0.22 ms | +0.6% | 0.22 ms | 0.22 ms | -0.9% | 0.18 / 0.31 / 0.25 / 0.21 / 0.22 |
| 200 / 1 | 1.00 | 11.37 ms | 11.82 ms | +4.0% | 5.00 ms | 4.97 ms | -0.6% | 10.86 / 12.37 / 10.69 / 11.37 / 11.90 |
| 200 / 3 | 1.00 | 11.38 ms | 12.07 ms | +6.1% | 5.41 ms | 5.28 ms | -2.5% | 11.38 / 12.73 / 12.87 / 11.37 / 11.03 |
| 2000 / 0 | 0.00 | 1.04 ms | 1.07 ms | +2.6% | 1.04 ms | 1.06 ms | +2.5% | 1.20 / 1.04 / 1.04 / 1.04 / 1.07 |
| 2000 / 1 | 1.00 | 14.91 ms | 14.74 ms | -1.2% | 7.41 ms | 7.30 ms | -1.5% | 14.91 / 14.92 / 14.76 / 14.58 / 14.91 |
| 2000 / 3 | 1.00 | 14.83 ms | 14.90 ms | +0.5% | 7.97 ms | 7.79 ms | -2.2% | 14.92 / 13.90 / 14.95 / 14.74 / 14.83 |
| 20000 / 0 | 0.00 | 10.66 ms | 10.65 ms | -0.1% | 10.66 ms | 10.67 ms | +0.1% | 10.64 / 10.55 / 10.68 / 10.66 / 10.66 |
| 20000 / 1 | 1.00 | 58.07 ms | 55.95 ms | **-3.7%** | 50.37 ms | 48.23 ms | **-4.2%** | 58.40 / 57.98 / 58.07 / 57.30 / 58.21 |
| 20000 / 3 | 1.00 | 58.95 ms | 56.97 ms | -3.4% | 51.12 ms | 49.34 ms | -3.5% | 58.28 / 58.88 / 58.95 / 59.91 / 59.68 |
| 2000 / 1 / 非空 aggregate | 1.00 | 23.96 ms | 21.07 ms | **-12.1%** | 16.83 ms | 13.89 ms | **-17.5%** | 23.96 / 24.73 / 23.90 / 23.86 / 24.09 |
| 2000 / 3 / 非空 aggregate | 1.00 | 25.88 ms | 23.06 ms | **-10.9%** | 18.59 ms | 16.05 ms | **-13.7%** | 25.87 / 25.88 / 25.90 / 25.94 / 25.84 |
| 20000 / 1 / 非空 aggregate | 1.00 | 68.86 ms | 63.83 ms | **-7.3%** | 62.41 ms | 57.20 ms | **-8.4%** | 68.95 / 80.77 / 68.82 / 68.86 / 68.39 |
| 20000 / 3 / 非空 aggregate | 1.00 | 70.94 ms | 66.47 ms | **-6.3%** | 64.06 ms | 59.28 ms | **-7.5%** | 71.37 / 70.83 / 70.61 / 70.96 / 70.94 |
| 2000 / 1 / 非空聚合 + 非空归档 | 1.00 | 25.11 ms | 22.30 ms | **-11.2%** | 17.99 ms | 15.17 ms | **-15.7%** | 25.35 / 25.11 / 23.99 / 25.63 / 24.48 |
| 20000 / 1 / 非空聚合 + 非空归档 | 1.00 | 69.86 ms | 65.66 ms | **-6.0%** | 63.39 ms | 58.74 ms | **-7.3%** | 69.93 / 70.87 / 69.20 / 69.78 / 69.86 |
| 2000 / 1 / 每次归档（暂存双写） | 2.00 | 54.21 ms | 51.48 ms | -5.0% | 33.11 ms | 27.75 ms | -16.2% | 54.21 / 54.84 / 53.84 / 54.94 / 52.94 |
| 2000 / 3 / 每次归档（暂存双写） | 2.00 | 56.99 ms | 54.25 ms | **-4.8%** | 33.95 ms | 30.68 ms | **-9.7%** | 56.99 / 56.97 / 57.70 / 57.88 / 56.93 |

逐样本原始值（墙钟、CPU、每轮两侧的全部样本）在 JSON 的 `results[].rounds[]` 里；机制计数
在 `results[].summary` 里；`delta` 给出中位数差。

读法：

- **稳态没有收益也不该有**：20000/0 是 -0.1%（10.66 对 10.65 ms）；2000/0 是 +2.6%（1.04 对 1.07 ms）；200/0 是 +0.6%（0.22 对 0.22 ms）。稳态不进入事务，两处改动都不在它的路径上；
  这些数值是同一台机器上两个目录与后台负载带来的漂移量级，不是收益。
- 第一处改动与已提交标记数线性，20000 条历史那一档可以稳定分辨：20000/1 的每轮墙钟是
  `57.30–58.40`（基线）对 `55.39–56.18`（之后），
  CPU 是 `50.12–50.48` 对 `48.09–48.45`，两项都不重叠；
  20000/3 的 CPU 是 `50.88–52.10` 对 `49.02–50.75`
  （不重叠），墙钟 `58.28–59.91` 对 `56.47–61.23`
  有五轮里的一轮候选值（61.23）落进基线区间，因此这一行只把 CPU 当作分离证据。
  中位数差：20000/1 墙钟 -3.7% / CPU -4.2%，
  20000/3 墙钟 -3.4% / CPU -3.5%。
  200 与 2000 条历史时被删掉的是 0.02–0.2 ms 的分配；这两档的逐轮数值在本轮互相重叠、中位数
  甚至在 +6% 与 −1.2% 之间摆动（与另外几次独立重跑方向都不一致），机制上最多解释 0.2 ms，
  因此**不作为收益**，逐轮数值见 JSON。
- 第二处改动只与 aggregate 大小相关：空 aggregate 下不可测；lived-in 热窗口下每次事务少
  复制约 534 KB（§6）。
  7/8 个非空 aggregate/归档/每次归档场景的墙钟逐轮不重叠，中位数差在
  -12.1%…-4.8%；
  其中 2000/1 是 `23.86–24.73` → `20.94–21.92`，
  20000/1 是 `68.39–80.77` → `63.24–64.67`
  （基线有一轮 80.77 ms 的后台负载离群值；另外四轮是
  68.39, 68.82, 68.86, 68.95，分离结论不依赖离群值）。
  CPU 中位数差在 -17.5%…-7.3%。
- 暂存双写（每次归档）场景：墙钟 `52.94–54.94` → `50.31–52.97`（2000/1），
  `56.93–57.88` → `52.87–56.08`（2000/3）。
  非空归档的两个场景（2000/1、20000/1）与不带归档的同名场景同一量级，说明归档树只增加两侧
  共同的镜像/比较成本，不改变本轮的差值。


## 6. 机制计数（同一脚本的插桩轮，每次 flush）

| 每次 flush（20000 历史 / 1 新事件） | 基线 | 之后 |
| --- | ---: | ---: |
| 整份文档写入（官方单元 rename） | 1 | 1 |
| 文档写入的 `FileHandle.sync()`（文件 + 目录） | 2 | 2 |
| 读日志字节 | 12,761,336 | 12,761,336 |
| 喂给 SHA-256/HMAC 的字节 | 17,703,254 | 17,703,254 |
| `readSync` | 14 | 14 |
| `readdirSync`（live / stage） | 37 / 37 | 37 / 37 |
| 同步 rename（提交 token + 检查点；整份文档走 `official/rename.async`） | 2 | 2 |
| `structuredClone` 调用 | 7 | **5** |
| 被 `structuredClone` 复制的字节 | 32,217 | 19,676 |
| `structuredClone` 自身的墙钟（不含为计字节额外做的 `JSON.stringify`） | 0.157 ms | 0.102 ms |
| 起始时间落在测量区间内的 GC 条目 / GC 墙钟 | 0.73 / 0.49 ms | 0.73 / 0.42 ms |

聚合体非空的场景（20000 / 1 / 非空 aggregate）：`structuredClone` 55 → 53 次，
被复制字节 1,395,315 → 848,250（**每次 flush 少 534 KB**），克隆墙钟 6.29 → 3.72 ms；
整份文档写入 1.00 / `FileHandle.sync()` 2.00 / 读日志字节 / 摘要字节 / `readSync` / `readdirSync` 两侧完全相同。
两个非空归档场景的 `dockyard/` 树分别有 3 个文件参与逐字节比较，每次归档场景是 4 个。

因此本轮删的是 **CPU 与分配**，不是 I/O：写入次数、fsync 次数、读日志字节、摘要字节都
不变；认证强度与覆盖面也没有变。

## 7. 收益边界

- 第一处改动与**已提交标记数**线性：20000 条时 `merge` 分项是 -1.79 ms（空 aggregate）/
  -1.70 ms（非空 aggregate），端到端墙钟 -3.7%；2000 条时约 −0.2 ms，落在噪声里；
  200 条时不可测。历史越长收益越大。
- 第二处改动与**aggregate 大小**线性：空 aggregate 无收益；热窗口约 0.9 MB 时每次事务
  少复制 534 KB（两个 `createMemory()` 各一次），端到端
  -12.1%…-4.8%，比例取决于
  fsync 与文档写入占的份额。
- 对一份**固定的** CPU 节省，分母是单次 flush 的总时长：`fsync` 更快（flush 更短）时占比
  变大，I/O 更慢（flush 更长）时占比变小，绝对毫秒不变。aggregate 变大会同时增大克隆收益
  与文档写入成本，两者相抵后的比例无法由本轮数据外推。跨宿主的绝对值与比例都没有测量。
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
| 手工重写对象展开语义以加速三处复制（赋值而非 `defineProperty`） | 不做 | 一次性微基准（20,000 键，`node -e` 内联脚本，未入库）：`{...x}` 3.72 ms、逐键赋值 2.31 ms、逐键 `defineProperty` 4.15 ms。赋值版在原型被污染、自有 `__proto__` 键、proxy 的 trap 序列上不可证明与 `CreateDataProperty` 等价；而 `defineProperty` 版比展开更慢，所以这条方向要么不可证明、要么没有收益。 |
| 用逐键枚举替代 `Object.keys(right).length` 数右侧键数 | 不做 | 同一次微基准：`Object.keys` 1.28 ms、`for...in` + `Object.hasOwn` 1.58 ms（20,000 键）。计数方向没有收益，且 trap 序列不同。 |
| 复用上一次事务的暂存目录 / 预取 staging | 不做 | 与现有不变量冲突，见 `archive-index-churn.md` §7。 |

## 9. 验证

```sh
NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/
NODE_OPTIONS=--max-old-space-size=4096 npm test
npm run release:verify
npm run pack:check
node scripts/benchmarks/domain-flush-ledger-cost.mjs --rounds 5 --samples 11 --warmup 3
```

结果见 §11（每次实际执行后填写；未执行的项不写通过）。

## 10. 独立审核记录

见 §12。

## 11. 本轮实际执行的检查

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 领域存储全部单测 | `NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/` | **79 项全部通过**（含两个差分 harness 的固定产物断言） |
| 全量回归 | `NODE_OPTIONS=--max-old-space-size=4096 npm test` | **700 项全部通过**（提交前一次、提交后一次；提交前唯一失败是 `release-pin` 拒绝未提交的分发改动） |
| 固定产物 | `npm run release:verify` | 与 `release/manifest.json` 一致：`d0c119f0…` / content `fb4e77b5…`，未改动 |
| 分发内容 | `npm run pack:check` | 全部通过；判定本树是固定产物的**已提交**开发后继，固定点、产物与证据未变 |
| 本地产物重建 | `npm run release:pack` | 两次打包字节相同（`0cca22a4…`），content `b2d149c0…`，51 个条目全部在 `files` 白名单内；只写 `dist/`，不进入 `release/` |
| 真实宿主验收 | `npm run acceptance:host -- --host 0.2.0-rc.2 --out docs/evidence/flush-ledger-cost-0.2.0-rc.2.json` | **21 个步骤全部 ok**（安装、plugin add、doctor、core flow、禁用/启用、卸载/重装、升级/回滚、晋升、重启回滚、最终 doctor），证据在 `docs/evidence/` |

A/B 全量矩阵前后跑了五次（不含最早的两场景冒烟）。前四次分别用于发现并修正：`hot` 种子越过
热窗口、后台负载污染（两次全量数据被丢弃）、GC 计数按回调交付时间归属、以及插桩轮重复。
最终入库的是第五次（5 轮 × 11 样本，插桩轮只跑第一轮，load average `1.41/1.80/1.79` → `2.16/1.94/1.85`）。
**只有这一次的数据进入 §5/§6/§7 与 JSON**；前几次只用于发现脚本缺陷，不作为收益证据。
