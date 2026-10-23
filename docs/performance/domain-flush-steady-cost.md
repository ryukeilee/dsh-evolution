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
环境：Node `v26.12.1` / `darwin/arm64`，8 逻辑 CPU；最终一轮数据采集的开始/结束 load average
`1.27/1.59/1.79` → `1.63/1.65/1.80`。

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
| `plan.readEventLog`（读日志 + 前缀 HMAC） | 0.100 | 0.620 | 5.562 |
| `plan.digestApplied`（标记表 JSON + SHA-256） | 0.045 | 0.431 | 5.158 |
| `plan.checkpointRead` | 0.023 | 0.024 | 0.044 |
| `plan.tail` | 0.001 | 0.001 | 0.001 |
| `plan.total` | 0.182 | 1.090 | 10.790 |

同档的端到端稳态 flush（5 轮 × 15 样本中位数；`wall` 与 `cpu` 在这条单线程路径上非常接近，20000 档为 `10.765` / `10.772 ms`，下表取 `wall`）：

| 历史 | flush | 读日志字节 | `readSync` | 摘要字节 | 其中标记表 JSON | 文档写入 / `sync()` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 200 | 0.181 ms | 127,168 | 2 | 152,412 | 24,493 | 0 / 0 |
| 2000 | 1.062 ms | 1,279,572 | 3 | 1,527,220 | 246,894 | 0 / 0 |
| 20000 | 10.765 ms | 12,875,576 | 14 | 15,365,228 | 2,488,895 | 0 / 0 |

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
| `digestApplied(null)` / `digestApplied('marker')` | 返回 `"null"` / `"\"marker\""` 的摘要 | 抛 `TypeError`（`Object.keys(null)` / `WeakMap` 键必须是对象） |

其中第一条是最危险的：`JSON.stringify` 读到的是 `A`，而快照记录的是 `B`，两者被绑在同一个
条目上，于是后续每一次「内容比较」都通过，摘要长期偏离真实字节、直到键集或值再变一次才自愈。
在端口上，这把「下一趟会发现摘要不符、退回逐条校验并抛 `E_DOMAIN_EVENT_ID_CONFLICT`」变成
「继续信任检查点、报告全部已应用」。

## 4. 撤回决定

撤回，而不是把它收窄到「安全」的输入上：

- 要让「比较」与「序列化」等价，必须保证 `JSON.stringify` 不会通过别的东西改变输出——根级
  `toJSON`（自有或继承）和数组的 `length`/空洞就足以否证；要让「读到的值」与「哈希的字节」
  等价，必须保证活表的读取是纯的——这正是 getter 反例否证的。加一次「读两遍」的一致性检查
  也挡不住「首读一次固定、之后稳定」的形态（第 3.3 节第一条），所以任何收窄方案都得在**每次
  命中**证明「这张表现在是纯数据表 + 没有根级序列化入口」，那是一次逐键
  `getOwnPropertyDescriptor` 加 Proxy/原型链判断，并且要单独证明这套判断本身等价、还要单独
  测量它的成本。那是另一个改动、另一个审查轮次（§8、§12.3），不是本轮能顺手带上的东西。
- 「端口 schema 只产出纯数据对象」（`evolutionDomainSpec.global.schema.parse` 会剥掉非枚举
  `toJSON` 与访问器、并拒绝数组）确实是这次反例的一条可达性边界，本轮把它记在 §12.2。但它
  是对**调用方**行为的假设，不是摘要本身的性质：`digestApplied()` 是导出的函数，
  `checkpointAuthenticates()` 的输入是 `domain.global.get().applied` 这个活对象。用「输入
  应该长这样」换取认证强度，正是 `redundant-work.md` §4.1 拒绝的那类论证。
- 顺带说明：`appliedDigest` 从来无法约束一个能控制自身序列化的对象——一个伪造的 `toJSON`
  在**当前实现**下同样能绕过它（审查中实测：让 `toJSON` 返回回滚前的副本、同时真的删掉
  marker，两侧都会被绕过）。但那是「输入本身在撒谎」的既有边界；候选实现新增的是**更宽**的
  一类：连「读到的值」都不需要稳定，也不再需要伪造序列化。

因此本轮不交付那 33%（§5），生产代码保持原样。

## 5. 可复现测量

```sh
NODE_OPTIONS=--max-old-space-size=4096 node scripts/benchmarks/domain-flush-steady-cost.mjs \
  --rounds 5 --samples 15 --warmup 3 --attribution-samples 9 \
  --out docs/performance/domain-flush-steady-cost.json
```

脚本在同一套 fixture、同一个真实官方后端上跑三侧：`committed`（本工作树）、`memo-content`
（§3.1 的候选）、`memo-identity`（只按对象身份缓存，作为「更糙的同一方向」对照）。三侧在
**同一组轮次里交替先后**（每轮把起跑位往后挪一位，`measured[].order` / `withdrawn[].order` 记录每轮的实际顺序），
所以三档数字不来自「先测完一侧再测另一侧」。两侧的 `lib/` 由精确子串补丁生成，补丁找不到
`digestApplied` 的唯一单行实现就失败；脚本还会断言本工作树里**没有**
`APPLIED_DIGEST_MEMO` / `appliedContentMatches` / `appliedSnapshot` 这些撤回标记，避免把同一份
代码比较两次。`--rounds`/`--samples`/`--attribution-samples`/`--behavior-history` 都要求正整数，
`--scenario` 过滤为空会直接失败（否则测量段会静默跳过）。

稳态 `flush()`，5 轮 × 15 样本中位数：

| 历史 | `committed` | `memo-content` | Δ | `memo-identity` | Δ |
| --- | ---: | ---: | ---: | ---: | ---: |
| 200 | 0.181 ms | 0.137 ms | **-24.4%** | 0.127 ms | **-30.2%** |
| 2000 | 1.062 ms | 0.737 ms | **-30.6%** | 0.652 ms | **-38.6%** |
| 20000 | 10.765 ms | 7.209 ms | **-33.0%** | 5.463 ms | **-49.2%** |

逐轮墙钟（20000 档）：`committed` `10.752 / 10.733 / 11.876 / 10.765 / 10.782`（第 3 轮是一个
较高的样本，中位数与另四轮一致）；`memo-content` `7.209 / 7.177 / 7.225 / 7.247 / 7.207`；
`memo-identity` `5.463 / 5.461 / 5.461 / 5.516 / 5.502`。三档的逐轮区间都不重叠
（200 档 `0.160–0.190` 对 `0.119–0.144`、`0.119–0.138`；2000 档 `1.049–1.078` 对
`0.710–0.741`、`0.647–0.655`），所以收益本身是确凿的——**被撤回的是它换来的语义，不是它的速度**。

提交形状（20000 历史 / 1 条新事件）只用于说明本轮没有别的改动：`59.74 ms` 墙钟 /
`51.42 ms` CPU，每 pass 1 次整份文档写入、2 次 `FileHandle.sync()`、37+37 次 `readdirSync`、
4 次 `readFileSync`。

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

- 要区分两个数：「标记表序列化 + 哈希」这一阶段在稳态 flush 里的**占比**是
  `5.158 / 10.790 = 47.8%`（20000 条档）；而**净收益**只有 33%，因为命中路径仍要用
  `Object.keys()` 加逐键比较把「未变」证明出来（审查另测的收窄版命中成本是 1.935 ms，
  见 §12.3），那部分要从中扣掉。2000 条档占比 39.5%、净收益 30.6%；200 条档占比 24.7%、
  净收益 24.4%。
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
| 「逐键 `getOwnPropertyDescriptor` + 排除 Proxy/数组/根级 `toJSON`」的收窄缓存 | **下一轮候选，本轮不实现** | §12.3：第二轮审查在 `/tmp` 实测稳态 `10.726 → 7.579 ms`（-29.3%），并给出了等价性论证的骨架；但它是新的认证语义改动，需要独立的对抗性审查与专门回归，本轮交付窗口内不引入 |
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

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 领域存储全部单测 | `NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/` | **86 项全部通过**（含新增的 7 项读形状回归） |
| 全量回归 | `NODE_OPTIONS=--max-old-space-size=4096 npm test` | **707 项全部通过** |
| 分发内容 | `npm run pack:check` | 全部通过；本树仍是固定产物的开发后继 |
| 固定产物 | `npm run release:verify` | 与 `release/manifest.json` 一致：`d0c119f0…` / content `fb4e77b5…`，51 个条目 |
| 本树未改生产代码 | `shasum -a 256 lib/event-log-checkpoint.js lib/domain-storage.js` | `7242a96b…` / `18f13f3a…`，与 `git show 01cf14e:lib/…` 相同（JSON 的 `sources` 记录同一对值） |
| 回归的鉴别力（注入验证） | 把 §3.1 的缓存与「仅对象身份」缓存分别注入 `lib/` 的 `/tmp` 副本后跑新回归 | `committed` 7/7 通过；两种注入各 **6/7 失败**（失败集合不同） |
| 测量 | `node scripts/benchmarks/domain-flush-steady-cost.mjs --rounds 5 --samples 15 --warmup 3 --attribution-samples 9` | 见 §2/§5/§6 与 JSON；三侧交替轮次、5 个探针、6 个行为场景、4 个冻结时钟持久字节场景全部按断言通过 |

最终一轮数据采集期间 load average `1.27/1.59/1.79` → `1.63/1.65/1.80`；全程
`--max-old-space-size=4096`，没有用临时下载的 Node 发行版。

## 12. 独立审核记录

### 12.1 第一轮 Review（阻塞，直接导致撤回）

独立 Review（另一模型、medium 推理档）对**当时已实现**的缓存给出「阻塞交付」，三条 blocking：

1. 未命中路径「先序列化、再取快照、再比较」不能证明快照与哈希字节一致（一次性 getter
   反例），并给出端口级复现：基线第二趟抛 `E_DOMAIN_EVENT_ID_CONFLICT`，候选第二趟报告
   `{applied: 0, duplicates: 3}`；
2. 缓存覆盖面与 `JSON.stringify` 不一致：根级 `toJSON`（自有不可枚举 / 继承）与数组
   `length` 都被 `Object.keys` 漏掉，却改变字节；
3. 未命中路径比基线多读，可能抛错（本轮实测：`digestApplied(null)` 从返回摘要变成
   `TypeError`）。

non-blocking：文档把归因均值写成中位数、未命中枚举次数描述不准、200/3 的逐轮区间描述不准、
候选源码哈希未绑定最终文件、行为对拍缺少独立预期断言。

处置：撤回生产改动；把反例固化为 `test/domain-storage/applied-digest-read-shape.test.js`；
重写基准为「测量 + 变体 + 探针 + 显式断言的拒绝/恢复」；文档改为「测量 + 撤回」，并把归因
口径、区间、源码哈希与断言都改为上文的形式。

### 12.2 第一轮 Test（对抗性复核）

独立 Test（另一模型、high 推理档）在**已实现缓存的版本**上做了差分模糊测试（其报告列举的
11 次运行、每次 1,494–2,104 条断言，合计约 1.96 万条，0 失败；覆盖整数样键、自有 `__proto__`、
孤立代理项、3000 键表、`toJSON` 值、非字符串值、逐键删除/回填/改值），并独立复现了 5 处不等价（根级 `toJSON`、数组 `length`、一次性 getter
长期偏离真值、非对象入参抛错、端口级「活对象读取不稳定时仍信任检查点」）。它同时给出两条
对撤回决定重要的边界：

- 端口自身的写入路径（`evolutionDomainSpec.global.schema.parse`）会剥掉非枚举 `toJSON` 与
  访问器、并拒绝数组，所以这些形状只能经由直接 `global.set(恶意文档)` 或就地
  `defineProperty` 注入；
- 一个能控制自身序列化的伪造 `toJSON` 在**当前实现**下同样能绕过 `appliedDigest`——那是输入
  本身撒谎的既有边界，不是缓存引入的。

这两条也解释了为什么 §3.3 的第一条反例（一次性 getter）是撤回的核心依据：它不需要伪造
序列化，只需要读取不稳定。

### 12.3 第二轮 Review

第二轮 Review（同一角色，对 `e6c57ad`）确认上一轮三条 blocking 都已解除、回撤彻底
（`git diff 01cf14e HEAD -- lib` 为空，`lib` tree ID 两侧同为 `e4327ddf…`，两个源码 SHA-256
与 JSON 一致），但就**证据口径**给出 1 条 blocking 与 4 条 non-blocking，全部已处理：

| 发现 | 处置 |
| --- | --- |
| blocking：脚本与 JSON 的 `protocol.order` 声称轮次交替，实际按实现分组运行 | 重写为「同一组轮次里三侧按轮换顺序交替」，每轮顺序记录到 `measured[].order` / `withdrawn[].order`；重新采集全部数据（§5 的数字与 §2 的归因都来自这一轮） |
| non-blocking：把「逐键 `getOwnPropertyDescriptor` 成本足以否定收窄方案」当成结论，但没测 | 该判断从 §4 撤回；收窄方案改为 §8/§12.3 的「下一轮候选」，并记录审查实测的 `-29.3%` 与仍需解决的 Proxy 等价性问题 |
| non-blocking：`md` 写「3 轮」（committed 实为 5 轮）、200 档三个数值不精确、把阶段占比 47.8% 写成 33%、非对象错误统一归因于 `WeakMap` | 全部按 JSON 与实测改写（§5、§7、§3.3） |
| non-blocking：回归说明的「前五条 / 失败四条」与实际不符；缺「首读一次固定」的用例；端口级用例的鉴别力描述不准 | 补上一次性 getter 用例（现在两条注入实现各失败 6/7、失败集合不同），并按实测改写文件头与端口级用例的定位 |
| non-blocking：`durable` 没记录文档哈希、没有独立重算检查点里的标记摘要 | `durable` 现在记录整份文档的 sha256，并**独立重算** `sha256(JSON.stringify(文档里的 applied))` 与检查点里的 `appliedDigest` 比对断言 |

第三轮 Review（对 `f216bc3`）确认 blocking 已解除、可以交付，另给 4 条 non-blocking，均已处理：
§4 里「逐键 descriptor 检查成本足以否定收窄」这类排他判断已删除，统一为「下一轮候选、性能已有
审查样本、等价性需独立验证」；`--scenario` 现在逐项校验（未知名称、缺值、空列表都失败，实测
`history-200-new-0,unknown` 会报错）；200 档净收益按 JSON 改为 `-24.4%`，`wall`/`cpu` 的表述改为
「非常接近」并给出两者数值，离群轮次只称「较高样本」；§5 的复现命令删掉脚本不读的
`--variant-rounds`、补上堆上限、字段路径改为 `measured[].order` / `withdrawn[].order`。
第三轮同时复算了本 JSON 的中位数、百分比、轮换顺序与源码摘要，并独立重算持久文档哈希与
`appliedDigest`，与提交数据一致。

第二轮 Review 还提出一处**尚未测量、本轮不做**的等价冗余：`readEventLog()` 在
`grown === false` 时仍复制一次哈希状态（`digest.copy()`），审查实测约 0.0002–0.0003 ms/次。
它与本轮的主要成本差两个数量级，且需要重新论证「读期间文件被追加」的竞争路径，故留待后续。
