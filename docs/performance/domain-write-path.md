# 默认写入路径：三项可证明冗余工作的删除（以及一项被独立复核击穿后撤回的候选）

本轮只改 `lib/domain-storage.js` 的默认配置写入路径。最终保留的是三项"同一份
数据在一次 `port.observe()` 事务里被重复遍历/深拷贝"的删除；第四项候选
（`hydrate()` 里那个从不被读取的 observation store）与前三项一起被测过，但被
独立对抗式复核击穿，已撤回并把反例固化为回归测试。不新增缓存、不改持久化格式、
认证、fsync、事务、恢复、回滚与跨进程锁语义，没有修改官方 DSH 源码。原始逐会话
数据见 [`domain-write-path-run.jsonl`](domain-write-path-run.jsonl)（保留变体）与
[`domain-write-path-run-withdrawn.jsonl`](domain-write-path-run-withdrawn.jsonl)
（含第四项的变体，已撤回）。

基线是**已固定的发布产物** `release/dsh-evolution-0.2.0-rc.8.tgz` 中的
`lib/domain-storage.js`：逆向重建必须与该产物逐字节相同（基准与等价测试都会
断言），候选是工作树。因此 A/B 比较的是"已发布实现"与"候选实现"。

## 1. 保留的三项改动与等价性依据

`port.observe()` 每次写入都会走
`mutate()`：`installPending()` → `mirrorArchives()` → `createMemory()` →
`work()` → `schema.parse()` 写入 pending → `installPending()` → `hydrate()`。

1. **恢复收尾的第二次文档校验**（`installPending`）。收尾写入的文档是
   `{ schema: 1, aggregate: current.pending.aggregate, applied:
   current.pending.applied, pending: null }`，而 `current` 正是上一步
   `schema.parse(domain.global.get())` 的结果：两个数据字段已经是该 schema
   校验并投影过的值，另外两个字段是固定字面量。因此第二个 `schema.parse`
   不可能拒绝任何第一个没有拒绝的文档（同一个值、同一个 schema，连递归深度
   行为都相同），它只是把整份 aggregate 再走一遍。**必须在安装暂存文件之前
   完成的整份文档校验没有移动**，仍由上面那次 parse 承担；这正是上一轮被撤回
   的"只校验使用到的字段"所破坏的边界，本轮不触碰。独立复核按递归深度
   `0/100/500/1000/1500/2000/3000` 逐点对照两版，未找到分歧（3000 层两版同
   报 `RangeError`）。
2. **`stateStore.update` 对入参的深拷贝**。原来的
   `aggregateSchema.parse(updater(structuredClone(aggregate)))` 先把整份
   aggregate 克隆一遍，而 `aggregateSchema` 的预处理
   `toJsonProjection`（`JSON.parse(JSON.stringify(...))`）本身就产生一份全新的
   深值。交给这个 store 的两个 updater 都是纯展开
   （`{ ...state, [key]: payload }`），从不改写收到的参数，因此这次克隆只会
   被再复制一次。
3. **`inlineSerialization`**。该 store 之前没有声明
   `inlineSerialization`，于是 `EvolutionMemory.#save()` 走
   `this.snapshot()`（整份 `#data` 深拷贝）再持久化。`PORTS.md` 允许声明
   `true` 的条件是"transaction 在调用时同步捕获所有 payload 字节"：这里的
   捕获就是 `update` 内联的同步 JSON 投影，它在 `persist()` 返回前已经完成，
   调用方之后的原地修改不可能进入已持久化的值。声明之后 `#save` 使用
   `{ ...this.#data }` 浅视图，同一次调用里第三份全量拷贝随之消失。独立复核
   未找到别名反例（updater 为纯展开、投影在首次异步让出前完成）。

第 2、3 项合起来意味着：一次保存从"浅视图/快照深拷贝 → 入参深拷贝 → JSON
投影深拷贝"变成"浅视图 → JSON 投影深拷贝"，落盘字节完全一致。

已知的、可观察的边界差异只有一处：`#data` 若含循环引用，基线在
`snapshot()` 的 `clone()` 回退里以 `RangeError`（栈溢出）失败，候选在投影的
`JSON.stringify` 里以 `TypeError` 失败；两者都显式失败、都不写盘。`#data`
只由 JSON 投影过的持久值构成，这条路径在真实端口上不可达。

## 2. 实测（严格交替 3 对 + 1 对预热）

```sh
node scripts/benchmarks/domain-write-commit.mjs --writes 400 --sessions 3 --warmup 1
```

同一进程内两个实现共用同一 fixture 路径，冻结时钟、把 `crypto.randomUUID`
换成每次运行重置的确定性序列，**每一对都断言持久化树、查询投影与重启后投影
逐字节相同（无掩码、无字段豁免）**；任何分歧都会让脚本非零退出。脚本串行
运行，测量期间不并行执行其他命令，输出不经过任何会缓冲的管道。

环境：Node `v26.11.1` / darwin-arm64，8 逻辑 CPU；保留变体这一轮运行前
load average `1.20 / 1.46 / 1.75`，运行后 `2.09 / 1.88 / 1.86`（1/5/15 分钟）。

保留变体（S1+S3+S4）：

| 对 | 顺序 | CPU 基线 (ms) | CPU 候选 (ms) | CPU Δ | 墙钟基线 (ms) | 墙钟候选 (ms) | 墙钟 Δ |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 预热 | baseline→after | 34531.714 | 31863.862 | −7.72% | 42321.951 | 40311.778 | −4.75% |
| 1 | after→baseline | 35277.426 | 31699.516 | −10.14% | 43069.056 | 40500.761 | −5.96% |
| 2 | baseline→after | 35441.692 | 31743.330 | −10.44% | 43211.486 | 40399.063 | −6.51% |
| 3 | after→baseline | 34867.568 | 31919.825 | −8.45% | 42993.785 | 40596.835 | −5.57% |

3 对计量的中位数：

| 指标 | 基线 | 候选 | 变化 |
| --- | ---: | ---: | ---: |
| **CPU 总计（主指标）** | 35277.426 ms | 31743.330 ms | **−10.02%** |
| 墙钟总计（辅助） | 43069.056 ms | 40500.761 ms | −5.96% |
| 单次写入墙钟中位数 | 108.980 ms | 103.891 ms | −4.67% |
| 会话内单次写入中位数 | 109.113 ms | 103.460 ms | −5.18% |
| 最后一个桶（第 351–400 次）中位数 | 166.035 ms | 150.632 ms | −9.28% |

波动范围：基线 CPU `34867.568 – 35441.692`（MAD 164.3），候选 CPU
`31699.516 – 31919.825`（MAD 43.8），**两侧完全不重叠**；墙钟基线
`42993.785 – 43211.486`、候选 `40399.063 – 40596.835`，同样不重叠。三对
CPU 收益为 −8.45% / −10.14% / −10.44%，没有反转，中位数正好落在 ≥10% 的
参考线附近。

作为对照，含已撤回第四项的变体在同一协议下测得 CPU 中位数
`35272.196 → 30693.587 ms`（−12.98%）、墙钟 −9.31%（数据见
`domain-write-path-run-withdrawn.jsonl`）。也就是说第四项确实带来约 3 个
百分点的 CPU 与约 3.4 个百分点的墙钟，但它换来的是一条被削弱的失败边界
（见第 4 节），因此被放弃；这里如实记录收益差，不把它算进保留变体。

## 3. 等价性与回归验证

- `node --test test/domain-storage/domain-storage-write-path-equivalence.test.js`：
  5 项全通过。逆向重建与 `release/dsh-evolution-0.2.0-rc.8.tgz` 逐字节相同；
  真实官方 `DomainFacility` + `JsonStorageBackend` 上 70 次写入 + 重启的持久化
  树、查询投影、重启投影逐字节相同；被注入的非法 `pending.aggregate` 在两个
  实现里都以 `ZodError` 拒绝、都不安装任何暂存文件、都保留可恢复的 pending
  记录；已提交的文档不会被后续写入原地改写（`inline` 契约）；以及第 4 节的
  `coldArchives` 反例在两个实现里都以同一个 `TypeError` 拒绝。
- `npm test`：完整套件通过（重新固定后的最终状态见 `CHANGELOG.md` 与
  `RELEASE.md`）。仓库原有的恢复边界用例
  （`a listener that rewrites the pending record cannot bypass its validation`、
  `a rejected commit does not install the staged archive`）在候选上通过，
  覆盖第 1 项改动必须保留的边界。
- 本轮没有逐项归因的结论：上一轮的单项快测设计（无交替、顺序固定）被证明
  无法区分漂移，因此这里只声明**保留变体整体**的收益，不声明某一项各自的
  百分比。

## 4. 被击穿并撤回的两项方案（记录，不再重试）

### 4.1 schema catchall 的非遍历替换

上一轮曾把 `aggregateSchema` 的 `catchall(z.json())` 换成不做遍历的
`catchall(z.unknown())`，理由是"`toJsonProjection` 的输出已经是 JSON 值，
递归校验不可能拒绝"。实测很快（400 次写入：墙钟 −27.6%、CPU −43.9%），但
独立对抗式复核用 **16,411** 个差分输入推翻了这个等价性主张（未修改仓库文件）：

- `JSON.parse('{"evolution":{"schema":4,"x":{"__proto__":0}}}')`：两版都接受，
  但 `z.json()` 的 record 分支会跳过 `__proto__`，新 catchall 会保留它，
  序列化字节不同（`{"x":{}}` vs `{"x":{"__proto__":0}}`）。
- `JSON.rawJSON("1e309")`：投影后得到 `Infinity`，旧版抛 `ZodError`
  （`invalid_union`），新版接受。
- 3000 层嵌套：旧版在 schema 处 `RangeError`（栈溢出），新版通过。
- 统计：441 个"旧拒绝/新接受"、1,125 个成功输出差异、27 个错误消息差异。

结论：该改动确实缩小了接受范围并改变了错误形状，`lib/domain-storage.js` 已
还原，生产代码不包含它。

### 4.2 `hydrate()` 里"死"的 observation store

第四项候选删除的是 `hydrate()` 里这两行：

```js
observations = new EvolutionObservationStore({ memory });
await observations.load();
```

局部变量 `observations` 在模块内确实没有任何读取点，但它**不是惰性的**：
`EvolutionObservationStore.load()` 末尾调用 `snapshot()`，而 `snapshot()` 读取
`memory.hasColdHistory`，该 getter 会对每个 `coldArchives` 条目执行
`Number(entry.count)`。一个形如下面的持久文档能通过真实的
`evolutionDomainSpec.global.schema.parse()`（它全是 JSON 值），但无法被
`Number()` 强转：

```js
{
  schema: 1,
  aggregate: { evolution: { schema: 4, coldArchives: { extra: { count: { toString: null, valueOf: null } } } } },
  applied: {}, pending: null,
}
```

独立复核给出的两个触发方式都在真实官方后端上复现（我也独立复现了一次）：

| 触发 | 基线（rc.8） | 删除该 store 的候选 |
| --- | --- | --- |
| 介质里已有该文档，打开端口 | `TypeError: Cannot convert object to primitive value` | 打开成功（`OPEN_OK`） |
| `domain/changed` 监听器在收尾写入后注入该条目 | 下一次 `observe()` 抛同一个 `TypeError` | **该次 `observe()` 提交成功**，再下一次才抛 |

差别不在"何时报错"，而在**被拒绝的提交不得落地**：删除调用后，损坏状态之后的
第一次提交会成功写入（observation 已提交、pending/stage 已清除），而基线在
写入前就拒绝。这正是本仓库前两轮已经撤回过的同一类"收窄失败边界"，因此该
候选整体撤回：两行按原样保留（附带说明它为何不是死代码），并在等价测试里固化
为回归用例（两侧都必须以同一个 `TypeError` 拒绝该状态）。

`test/domain-storage/domain-storage-baseline.js` 的逆向重建因此只覆盖保留的三
项，锚点仍是 rc.8；重建必须与该产物逐字节相同，任何漂移都会失败。

## 5. 收益边界与剩余风险

- 收益只来自默认配置的写入路径（`openDomainStorage` + `port.observe()`）；
  不含查询、诊断、promotion 与事件同步路径。事件同步路径的两项候选优化在
  `docs/performance/redundant-work.md` 第 4 节已撤回，本轮不涉及。
- 数据是 400 次写入、本机、热页缓存下的合成负载；写入路径仍有 fsync 等不可
  压缩成本，因此墙钟收益（−5.96%）明显小于 CPU 收益（−10.02%）。没有测量
  RSS、分配次数或其他平台，收益不可与 rc.6–rc.8 的优化相加。
- 第 3 项依赖 `PORTS.md` 的 `inlineSerialization` 契约：只要 `update` 保持
  "在 `persist()` 调用内同步完成 JSON 投影"，浅视图就是安全的。等价测试中
  "已提交的文档不会被后续写入原地改写" 这条断言会在契约被破坏时失败。
- 独立复核明确未覆盖：`restore()` 等不经真实端口暴露的路径、并发调度与资源
  耗尽的穷举、以及 S1 在所有递归临界值上的证明（只逐点对照了 8 个深度）。
- 其余发布风险（发布字节由 `release/` 人工固定、rc.1 的 tag/资产
  provenance 不一致、守卫是启发式策略检查等）见 `RELEASE.md` 第 6 节，本轮
  没有改变它们。
