# 稳态 flush()：一份测量，和一处被反例撤回的优化

基线/被测为本轮开始前的 `main` 提交 `01cf14e`。目标是无新事件的稳态 `flush()`——
`registration.js` 在每次 `agent/pre-step` 与每个 Evolution 工具结束时都会调用它，它只重新
证明检查点、不提交任何事务。

**本轮没有修改生产代码。** `lib/` 与 `01cf14e` 逐字节相同（JSON 的 `sources` 记录了
`lib/event-log-checkpoint.js` = `7242a96b…`、`lib/domain-storage.js` = `18f13f3a…`）。
本文件交付的是：稳态 flush 的可复现测量与分项归因、一处确实能省掉约三分之一稳态成本的
候选优化、该候选被五组反例击穿的过程，以及把反例固化成回归后撤回的记录。

原始数据：[`domain-flush-steady-cost.json`](domain-flush-steady-cost.json)，脚本
[`scripts/benchmarks/domain-flush-steady-cost.mjs`](../../scripts/benchmarks/domain-flush-steady-cost.mjs)。
环境：Node `v26.12.1` / `darwin/arm64`，8 逻辑 CPU；开始/结束 load average
`1.44/1.50/1.56` → `1.82/1.60/1.60`。

## 1. 路径与形状

`domainStorage.flush()` 是 `replay()` 的入队包装。稳态（无新事件）pass 的全部工作是
`planEventLogReplay()`：

1. 读检查点文件并解析（`readEventLogCheckpoint`）；
2. 打开事件日志、读取已消费前缀并把它喂给 HMAC（`readEventLog`）；
3. 用桥密钥验证检查点自己的 MAC（`checkpointMac`）；
4. 把**整张已提交标记表**序列化成 JSON 再 SHA-256，与检查点里的 `appliedDigest` 比对
   （`digestApplied`）；核对 writer、文件身份与首尾见证；
5. 前缀摘要与检查点摘要比对；
6. 尾部分行（稳态下为空）。

## 2. 归因：稳态 flush 的时间花在哪

真实官方 `DomainFacility` + `JsonStorageBackend`，按调用点在两侧插同样的表达式包装（补丁
找不到唯一调用点就报错），每次稳态 `flush()` 的分项，9 个样本的算术平均（脚本按
「累计/样本数」计算，不是中位数）：

| 阶段 | 200 条历史 | 2000 条 | 20000 条 |
| --- | ---: | ---: | ---: |
| `plan.readEventLog`（读日志 + 前缀 HMAC） | 0.104 | 0.639 | 5.545 |
| `plan.digestApplied`（标记表 JSON + SHA-256） | 0.050 | 0.432 | 5.111 |
| `plan.checkpointRead` | 0.024 | 0.022 | 0.044 |
| `plan.tail` | 0.001 | 0.001 | 0.001 |
| `plan.total` | 0.195 | 1.111 | 10.726 |

同档的端到端稳态 flush（5 轮 × 15 样本中位数，`wall` 与 `cpu` 在这条路径上相同）：

| 历史 | flush | 读日志字节 | `readSync` | 摘要字节 | 其中标记表 JSON | 文档写入 / `sync()` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 200 | 0.17 ms | 127,168 | 2 | 152,412 | 24,493 | 0 / 0 |
| 2000 | 1.07 ms | 1,279,572 | 3 | 1,527,220 | 246,894 | 0 / 0 |
| 20000 | 10.65 ms | 12,875,576 | 14 | 15,365,228 | 2,488,895 | 0 / 0 |

读法是：稳态 flush 的一半是把日志前缀读一遍并做 HMAC（字节级认证，见 §7），另一半是
`sha256(JSON.stringify(applied))`——**纯 JS 侧的序列化 + 哈希，不碰磁盘**，20000 条标记时
那段 JSON 有 2.49 MB。

## 3. 候选优化：复用未变标记表的摘要

### 3.1 候选实现

`digestApplied()` 加一处内容比较缓存（模块级 `WeakMap`，随标记表对象回收）：

```js
const cached = APPLIED_DIGEST_MEMO.get(applied);
if (cached !== undefined && appliedContentMatches(applied, cached)) return cached.digest;
const digest = crypto.createHash('sha256').update(JSON.stringify(applied)).digest('hex');
const snapshot = appliedSnapshot(applied);
if (snapshot !== null && appliedContentMatches(applied, snapshot)) cache(snapshot, digest);
else APPLIED_DIGEST_MEMO.delete(applied);
return digest;
```

命中路径用 `Object.keys()` 枚举活表，要求键数相同、逐位键相同、每个值为字符串且等于快照值。

### 3.2 它看起来成立的理由

`JSON.stringify` 对 own 可枚举字符串键的顺序与 `Object.keys` 相同，字符串转义是纯函数，所以
「键顺序相同 + 字符串值相同 ⇒ 文本逐字节相同 ⇒ SHA-256 相同」。而且它复用的是**一次 O(历史)
全量内容比较**的结论，不是对象身份、`domain/changed` 订阅之类的 O(1) 信号——后者正是
`redundant-work.md` §4.1 用两轮反例整体撤回的方向。

### 3.3 反例：五处不等价

反例都在真实代码上跑出来（脚本的 `probes` 段每次运行都会重跑一遍，见
`domain-flush-steady-cost.json`）：

| 输入 | 承诺行为（当前实现） | 候选实现 |
| --- | --- | --- |
| 表内 getter 首次返回 `A`、之后返回 `B` | 两次调用分别得到 `A`、`B` 的摘要 | 第二次仍返回 `A` 的摘要（**陈旧值**） |
| 根级 `toJSON`（自有不可枚举）输出从 `first` 变为 `second` | 摘要跟着变 | 摘要冻结（`Object.keys` 看不到它） |
| 数组形状的表，`length` 1→3（JSON 变 `["a",null,null]`） | 摘要跟着变 | 摘要冻结 |
| getter 第二次读取抛错 | 返回摘要（只读一次） | 抛 `second read`（**多读了一次**） |
| `digestApplied(null)` / `digestApplied('marker')` | 返回 `"null"` / `"\"marker\""` 的摘要 | 抛 `TypeError`（`WeakMap` 键必须是对象） |

其中第一条是最危险的：`JSON.stringify` 读到的是 `A`，而快照记录的是 `B`，两者被绑在同一个
条目上，于是后续每一次「内容比较」都通过，摘要长期偏离真实字节、直到键集或值再变一次才自愈。
在端口上，这把「下一趟会发现摘要不符、退回逐条校验并抛 `E_DOMAIN_EVENT_ID_CONFLICT`」变成
「继续信任检查点、报告全部已应用」。

## 4. 撤回决定

撤回，而不是把它收窄到「安全」的输入上：

- 要让「比较」与「序列化」等价，必须保证 `JSON.stringify` 不会通过别的东西改变输出——根级
  `toJSON`（自有或继承）和数组的 `length`/空洞就足以否证；要让「读到的值」与「哈希的字节」
  等价，必须保证活表的读取是纯的——这正是 getter 反例否证的。加一次「读两遍」的一致性检查
  也挡不住「首读一次固定、之后稳定」的形态（第 3.3 节第一条）；要真正拦住它，只能每次命中
  都对每个键做 `getOwnPropertyDescriptor`，把 20000 条表的命中成本推回与序列化同量级。
- 唯一能救它的论据是「端口 schema 只产出纯数据对象」（`evolutionDomainSpec.global.schema.parse`
  会剥掉非枚举 `toJSON` 与访问器、并拒绝数组）。但这是对**调用方**行为的假设，不是摘要本身
  的性质：`digestApplied()` 是导出的函数，`checkpointAuthenticates()` 的输入是
  `domain.global.get().applied` 这个活对象，而本次审查已用官方句柄构造出活对象形状变化的路径。
  用「输入应该长这样」来换取认证强度，正是 `redundant-work.md` §4.1 拒绝的那类论证。
- 顺带说明：`appliedDigest` 从来无法约束一个能控制自身序列化的对象——一个伪造的 `toJSON`
  在**当前实现**下同样能绕过它（审查中实测：让 `toJSON` 返回回滚前的副本、同时真的删掉
  marker，两侧都会被绕过）。但那是「输入本身在撒谎」的既有边界；候选实现新增的是**更宽**的
  一类：连「读到的值」都不需要稳定，也不再需要伪造序列化。

因此本轮不交付那 33%（§5），生产代码保持原样。

## 5. 可复现测量

```sh
node scripts/benchmarks/domain-flush-steady-cost.mjs --rounds 5 --samples 15 --warmup 3 \
  --variant-rounds 3 --attribution-samples 9 --out docs/performance/domain-flush-steady-cost.json
```

脚本在同一套 fixture、同一个真实官方后端上跑三侧：`committed`（本工作树）、`memo-content`
（§3.1 的候选）、`memo-identity`（只按对象身份缓存，作为「更糙的同一方向」对照）。两侧的
`lib/` 由精确子串补丁生成，补丁找不到 `digestApplied` 的唯一单行实现就失败；脚本还会断言
本工作树里**没有** `APPLIED_DIGEST_MEMO` / `appliedContentMatches` / `appliedSnapshot` 这些
撤回标记，避免把同一份代码比较两次。

稳态 `flush()`，3 轮 × 15 样本中位数：

| 历史 | `committed` | `memo-content` | Δ | `memo-identity` | Δ |
| --- | ---: | ---: | ---: | ---: | ---: |
| 200 | 0.170 ms | 0.122 ms | **-28.2%** | 0.117 ms | **-31.4%** |
| 2000 | 1.07 ms | 0.73 ms | **-31.6%** | 0.65 ms | **-38.6%** |
| 20000 | 10.65 ms | 7.15 ms | **-32.9%** | 5.46 ms | **-48.7%** |

逐轮数值（`committed` 20000 档）：`10.673 / 10.633 / 10.562 / 10.648 / 10.698`；
`memo-content`：`7.150 / 7.131 / 7.178`；`memo-identity`：`5.458 / 5.458 / 5.449`。
三档都分离，所以收益本身是确凿的——**被撤回的是它换来的语义，不是它的速度**。

提交形状（20000 历史 / 1 条新事件）只用于说明本轮没有别的改动：`59.06 ms` 墙钟 /
`50.80 ms` CPU，每 pass 1 次整份文档写入、2 次 `FileHandle.sync()`、37+37 次 `readdirSync`。

## 6. 机制计数

| 每次稳态 flush（20000 历史） | `committed` | `memo-content` |
| --- | ---: | ---: |
| 读日志字节 | 12,875,576 | 12,875,576 |
| `readSync` 次数 | 14 | 14 |
| 喂给 SHA-256/HMAC 的字节 | 15,365,228 | **12,876,333** |
| 其中标记表 JSON 字节 | 2,488,895 | **0** |
| 大于 4 KB 的 `JSON.stringify` 输出 | 2,488,895 | **0** |
| 整份文档写入 / `FileHandle.sync()` | 0 / 0 | 0 / 0 |

候选省掉的是 2.49 MB/次 的序列化与它的 SHA-256；I/O、fsync、文档字节都不变。也就是说这条
优化省的确实是 CPU 与分配，问题完全在语义侧。

## 7. 收益边界，以及剩余成本为什么保留

- 可省的份额 = 「标记表序列化 + 哈希」在稳态 flush 里的占比：20000 条时约 33%，2000 条约
  32%，200 条约 28%，随标记数与日志读取速度变化。
- 保留的份额是必要成本：`plan.readEventLog` 是已消费前缀的**字节级认证**（20000 条档占稳态
  的 52%）。检查点的全部意义是「这段字节仍是当初认证过的那段」，除重新读并重新哈希它以外
  没有别的证明方式；用文件 `size`/`mtime`/`ctime`/`dev`+`ino` 之类元数据替代就是把证明降级，
  已在 `redundant-work.md` §4.1 撤回。`plan.digestApplied` 是标记表绑定，同理不能靠信号替代。
- 也没有把它换成「前缀见证子集」这类更窄的绑定：那会缩小检查点对标记表增删的覆盖面，而
  `appliedDigest` 是当前唯一覆盖整张表的证据。
- 自建序列化替代 `JSON.stringify` 的方向也不成立：一次性微基准（20000 键，`node -e` 内联，
  未入库）——`JSON.stringify` 3.56 ms；`parts`+`join` 6.50 ms；字符串拼接 5.55 ms；手工
  `Buffer.write` 5.72 ms；而已备好的同长度字符串做 SHA-256 只要 0.88 ms。V8 的
  `JSON.stringify` 已经是最快的那条路径。
- 没有测量：冷页缓存、网络文件系统、其它平台、多进程竞争、真实生产标记分布、GC/峰值堆。

## 8. 本轮排除 / 复核后不做的方向

| 候选 | 结论 | 依据 |
| --- | --- | --- |
| 内容比较缓存复用标记表摘要 | 已实现、已测量、**已撤回** | §3.3 五组反例；`redundant-work.md` §4.1 同类先例 |
| 只按对象身份复用 | 不做 | §3.3 的第一条与端口回退场景直接击穿 |
| 只比键集 / 只比长度 | 不做 | 改 MAC 值就检测不到 |
| 用「端口 schema 只产出纯数据对象」作为安全前提 | 不做 | 那是对调用方行为的假设，`digestApplied` 是导出函数，活对象形状可被官方句柄改变 |
| 文件 `size`/`mtime`/`ctime` 备忘录跳过前缀哈希 | 不做 | 把字节级认证降级为元数据信号；§4.1 已撤回 |
| 自建序列化 / 逐键 `hash.update` | 不做 | §7 的微基准：都比 `JSON.stringify` + 一次 SHA-256 慢 |
| 让 `eventLogCheckpointDocument()` 复用 `checkpointAuthenticates()` 刚算的摘要 | 不做（已撤回） | 两次调用之间可能刚提交过事务、标记表已换 |

## 9. 验证

```sh
NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/
NODE_OPTIONS=--max-old-space-size=4096 npm test
node scripts/benchmarks/domain-flush-steady-cost.mjs --rounds 5 --samples 15 --warmup 3
npm run pack:check
npm run release:verify
```

结果见 §11。

## 10. 独立审核

见 §12。

## 11. 本轮实际执行的检查

（见文末。）

## 12. 独立审核记录

（见文末。）
