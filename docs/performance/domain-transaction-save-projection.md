# 事务内每次保存不再保留它构建的投影

本轮基线为 `main` 的 `2ff472a`。只改 `lib/domain-storage.js` 里那个**事务工作副本**
的 `stateStore.update`：它此前对每次保存执行 `aggregateSchema.parse(...)`，并把结果
存进一个没有任何读者的变量。现在它执行同一个 `JSON.stringify`（该 schema 的预处理
第一步就是这个 stringify），不再保留随后解析出来的深拷贝。没有新增缓存、没有改动
持久化格式、认证、去重、事务、提交点、恢复、回滚、跨进程锁与 fsync 次数，也没有修改
官方 DSH 源码。

原始数据见 [`domain-transaction-save-projection.json`](domain-transaction-save-projection.json)
（3 轮 × 2 侧 × 2 历史 × 2 事件形状，每行保留该轮 9 个**未取整**的原始墙钟与 CPU 样本、
该轮中位数与系统调用计数；文件里的 `derivation` 说明第 3、4 节每个数字如何由它算出——
先取每侧每轮 9 个样本的中位数，再算候选/基线的比值，最后取三轮比值的中位数），
复现脚本是仓库自带的
[`scripts/benchmarks/domain-replay-batch.mjs`](../../scripts/benchmarks/domain-replay-batch.mjs)
（本轮给它加了 JSON 计数与 `BENCH_MIX`，见第 4 节）。

## 1. 归因：一次 flush 里被重复处理的整份状态

真实官方 `DomainFacility` + `JsonStorageBackend`、真实 `port.flush()`、已签名已提交的
合成历史。一次 flush 的整份 aggregate 投影次数是 **5 + `#save()` 次数**：

- 固定 5 次：`installPending()` 入口 1 次 + 提交点发布 2 次（`aggregate` 与
  `pending.aggregate` 各一次）+ 提交后 `installPending()` 2 次。
- `#save()` 每记录 **2 次**（`measurement-completed`：`#append("experiments")` +
  `#markBridgeApplied`）、**3 次**（`experiment-rejected`、`failure-learned`：
  追加 + `#bridgeOutcome` + 标记）、**5–6 次**（`canary-passed`：promotion + strategy
  + lineage + canonical(+superseded tombstone) + 标记）。

这些中间投影的**返回值**没有读者：唯一的提交路径是 `mutate()` 在 `work()` 之后自己
重拍的 `{ evolution: current.instance.snapshot() }`；下一个 updater 是
`{ ...state, evolution: ... }`，只保留并**整体替换** `evolution`；这个 store 自己的
`load()` 只有 `reconcile()` 与 `verifyConsistency()` 两个调用者，端口里没有任何路径
调用它们（`createMemory` 自己在记录产生之前就 `load` 过了）。

成本因此是**二次**的：第 i 次保存要投影前 i−1 条记录已经写进 aggregate 的内容。实测
（`mixed`，33 条记录 = 118 次保存）单次 flush 累计重新解析 **13.0 MB** 文档字节，候选
侧为 **0.60 MB**。

## 2. 改动

```js
// 之前
update: async updater => { aggregate = aggregateSchema.parse(updater(aggregate)); }
// 现在
update: async updater => {
  const next = updater(aggregate);
  assertTransactionSave(next);   // JSON.stringify(next)
  aggregate = next;
}
```

**保留的**：每次保存的异常边界。被删掉的调用是三步：`toJsonProjection` 的
`JSON.stringify`、对 stringify 输出的 `JSON.parse`、以及只在序列化文本含
`"__proto__"` 字面量时才跑的递归清理。`assertTransactionSave` **按同样的顺序做同样
三步，只是丢掉结果**：

```js
const text = JSON.stringify(payload);
if (text === undefined) JSON.parse(text);                       // 原来在这一步抛 SyntaxError
else if (text.includes(`"${PROTO_KEY}"`)) stripOwnProtoKeys(JSON.parse(text));  // 原来是这一步
```

因此**每次保存仍然在它原本抛错的同一处、以同一个错误抛错**，包括 `JSON.parse` 对
`undefined` 的 `SyntaxError`，以及嵌套深到把递归清理的栈打爆时的 `RangeError`。常见
路径上唯一被跳过的是 `JSON.parse`——也就是构建那份没人读的深拷贝的那一步；`"__proto__"`
字面量子串搜索是原来那次预处理本来就要付的成本。

新回归 `test/domain-storage/transaction-save-validation.test.js` 用差分语料（BigInt、
循环引用、抛错的 getter 与 `toJSON`、`NaN`、`Date`、`undefined`、函数、纯文档、
`"__proto__"` 字面量、以及 12,000 层嵌套的 `"__proto__"` 文档）逐条断言两侧的抛/不抛与
错误 `name`/`message` 完全一致：实测 `undefined` 两侧同为
`SyntaxError: "undefined" is not valid JSON`，12,000 层文档两侧同为
`RangeError: Maximum call stack size exceeded`。

**删掉的**：那个没人读的返回值（`JSON.parse` 建出的整棵对象图，以及 zod 对它的遍历）。
schema 的**裁决**对这个 store 接收的 payload 是恒定的：payload 唯一的顶层自有键是
`evolution`（store 只可能持有已提交 aggregate 或同形状 payload，持久 schema 不容许别的
顶层键），schema 在 `evolution` 里只看 `schema` 是否为 `>= 4` 的整数，而端口只从**已
校验的 durable 文档**加载它（`memory.js` 的 `schema: Math.max(4, Number(...) || ...)`
在 load 与 reconcile 处维持这一点；直接 `restore()` 能塞进 `4.5`，但那不在端口路径上）。
两个把值写进这个 store 的端口事件（`projectExecutionEvent`、`safeRecord`、
`projectObservation`）在进入它之前都已经过 JSON 投影。

`inlineSerialization` 仍然诚实：`update` 在返回前用同步 `JSON.stringify` 捕获了它收到
的 payload 的字节，调用方之后的原地修改进不了这次检查；它不保留那份字节，也没有读者
需要它保留。

## 3. 可复现性能

```sh
# 3 轮交替：第 1、3 轮基线先跑，第 2 轮候选先跑；每侧独立进程、预热 3 次、测量 9 次
BASE=$(mktemp -d /tmp/dsh-ab-base.XXXXXX)
git archive 2ff472a | tar -x -C "$BASE"
cp scripts/benchmarks/domain-replay-batch.mjs "$BASE/scripts/benchmarks/"
ln -s "$PWD/node_modules" "$BASE/node_modules"
run() { # side dir history mix backlog
  ( cd "$2" && BENCH_EVENTS="$3" BENCH_MIX="$4" BENCH_BACKLOG="$5" BENCH_SAMPLES=9 \
      node scripts/benchmarks/domain-replay-batch.mjs )
}
for round in 1 2 3; do
  for history in 200 2000; do
    for mix in measurement mixed; do
      if [ "$mix" = "mixed" ]; then backlog=2,5,10,25; else backlog=0,1,2,5,10; fi
      if [ "$round" = "2" ]; then
        run cand "$PWD"  "$history" "$mix" "$backlog"; run base "$BASE" "$history" "$mix" "$backlog"
      else
        run base "$BASE" "$history" "$mix" "$backlog"; run cand "$PWD"  "$history" "$mix" "$backlog"
      fi
    done
  done
done
```

`mixed` 按真实 `project()` 的形状循环 `measurement-completed` /
`experiment-rejected` + `failure-learned` / `canary-passed`，成对记录不会被拆开。下表
每一格是**三轮各自的中位数**（该轮 9 个样本的中位数），`中位数` 列是三轮差值的中位数；
`k` 是积压形状槽位数，`记录` 是实际追加的记录数，`保存次数` 是 `JSON.parse` 次数差
（等于保存次数，见第 4 节）。

历史 200 条：

| 形状 | k | 记录 | 保存次数 | 基线墙钟 | 候选墙钟 | 中位数 | 各轮 | 基线 CPU | 候选 CPU | 中位数 |
| --- | ---: | ---: | ---: | --- | --- | ---: | --- | --- | --- | ---: |
| measurement | 10 | 10 | 20 | 29.4/28.2/31.9 | 31.9/30.3/28.2 | +7.5% | +8.4/+7.5/-11.8 | 14.0/14.2/15.7 | 13.3/12.8/13.0 | -9.5% |
| measurement | 5 | 5 | 10 | 26.7/27.5/26.0 | 26.6/27.1/25.9 | -0.3% | -0.2/-1.1/-0.3 | 10.6/11.2/11.5 | 10.7/11.1/11.2 | -1.2% |
| measurement | 2 | 2 | 4 | 23.1/20.4/25.1 | 24.0/24.7/26.5 | +5.5% | +4.1/+20.9/+5.5 | 9.4/7.4/9.6 | 9.0/9.9/10.3 | +7.2% |
| measurement | 1 | 1 | 2 | 21.6/23.8/22.4 | 21.9/22.9/24.0 | +1.4% | +1.4/-4.1/+7.1 | 7.1/7.7/8.0 | 7.3/7.2/7.2 | -6.7% |
| mixed | 25 | 33 | 118 | 108.1/106.6/112.6 | 83.0/78.9/81.6 | -26.1% | -23.3/-26.1/-27.5 | 103.4/99.2/102.0 | 66.0/60.6/61.1 | -39.0% |
| mixed | 10 | 13 | 48 | 47.1/51.7/48.5 | 44.3/46.2/47.2 | -6.1% | -6.1/-10.8/-2.8 | 30.6/31.1/30.9 | 26.5/27.0/27.3 | -13.3% |
| mixed | 5 | 7 | 22 | 34.6/31.9/31.6 | 28.6/29.3/27.7 | -12.3% | -17.5/-8.1/-12.3 | 19.9/18.2/15.2 | 15.2/14.6/13.6 | -19.7% |
| mixed | 2 | 3 | 8 | 27.3/26.0/26.2 | 26.8/24.9/25.7 | -1.9% | -1.9/-4.3/-1.6 | 11.8/11.0/12.1 | 10.6/10.1/9.7 | -10.4% |
| — | 0 | 0 | 0 | 0.18/0.18/0.20 | 0.18/0.18/0.29 | -0.6% | -0.7/-0.6/+42.7 | 0.23/0.22/0.34 | 0.22/0.23/0.46 | +4.6% |

历史 2,000 条：

| 形状 | k | 记录 | 保存次数 | 基线墙钟 | 候选墙钟 | 中位数 | 各轮 | 基线 CPU | 候选 CPU | 中位数 |
| --- | ---: | ---: | ---: | --- | --- | ---: | --- | --- | --- | ---: |
| measurement | 10 | 10 | 20 | 34.5/34.1/32.5 | 29.7/31.7/31.6 | -7.2% | -13.8/-7.2/-2.8 | 19.0/20.8/24.9 | 24.3/14.5/22.3 | -10.2% |
| measurement | 5 | 5 | 10 | 28.7/30.7/30.7 | 30.7/29.7/28.8 | -3.4% | +6.8/-3.4/-6.3 | 14.9/15.0/14.0 | 14.4/14.7/14.6 | -2.5% |
| measurement | 2 | 2 | 4 | 27.0/30.0/29.7 | 28.9/27.7/29.1 | -2.3% | +6.9/-7.5/-2.3 | 13.3/13.8/13.3 | 13.9/13.6/13.2 | -0.5% |
| measurement | 1 | 1 | 2 | 29.2/28.9/27.9 | 29.0/27.0/28.9 | -0.9% | -0.9/-6.5/+3.5 | 13.4/13.5/13.8 | 14.2/13.2/13.2 | -2.1% |
| mixed | 25 | 33 | 118 | 112.2/114.9/112.2 | 87.9/90.3/86.6 | -21.7% | -21.7/-21.4/-22.9 | 106.8/111.1/105.6 | 65.9/70.3/63.8 | -38.3% |
| mixed | 10 | 13 | 48 | 56.2/54.1/57.2 | 47.1/48.3/48.4 | -15.4% | -16.1/-10.7/-15.4 | 37.2/39.3/39.1 | 31.3/28.0/30.2 | -22.8% |
| mixed | 5 | 7 | 22 | 37.6/34.7/36.7 | 34.6/31.9/37.7 | -7.9% | -7.9/-8.0/+2.8 | 22.7/21.2/21.4 | 18.5/18.7/20.9 | -12.0% |
| mixed | 2 | 3 | 8 | 31.1/31.9/32.8 | 31.8/30.7/31.0 | -3.8% | +2.5/-3.8/-5.4 | 19.1/18.1/18.0 | 16.1/16.4/16.5 | -9.4% |
| — | 0 | 0 | 0 | 1.11/1.15/1.12 | 1.16/1.08/1.14 | +1.6% | +4.5/-6.3/+1.6 | 1.17/1.23/1.20 | 1.19/1.16/1.23 | +1.7% |

### 稳定收益与噪声

- **`mixed`，k ≥ 10**（真实形状混合，13–33 条记录、48–118 次保存）：墙钟与 CPU 两档
  历史、三轮全部同向。k = 25 时墙钟 −21…−28%、CPU −36…−40%，三轮差值彼此相差不超过
  约 4 个百分点；k = 10 时墙钟 −3…−16%、CPU −12…−29%。这是本轮的主结论。
- **`mixed`，k = 5**：墙钟五轮为负、一轮 +2.8%，CPU 六轮全负（−2.5%…−23.5%）。
- **纯 `measurement`，k = 10**：CPU 历史 200 三轮全负（−5…−17%），历史 2000 两负一正
  （+27.5%）；墙钟历史 200 两正一负（中位数 +7.5%）、历史 2000 三轮全负。因此纯
  measurement 只声称 **CPU**，并且如实标注历史 200 的墙钟中位数是**正**的：那一档的
  `fsync` 等待（约 19 ms 恒定）盖住了被删掉的 0.6 ms CPU 工作，两侧差异由系统负载决定。
- **k ≤ 2**：两侧差值落在观测到的轮间散布内，方向不一（−7.5% … +20.9%），**不声称
  收益**。机制计数说明这里可省的工作是 7.4 KB（measurement 1 条）到 179 KB
  （mixed 2 槽位 / 3 条记录）的重新解析；按本轮 mixed/25 这一档自己的比率（少解析
  12.4 MB ↔ CPU 少 41 ms，约 3.3 µs/KB）折算是约 0.02–0.6 ms，所以那些正负值都不是
  本轮可归因的效果。这个换算是估算，量级用来解释「为什么墙钟上测不出来」，不是独立测量。
- **k = 0**：这条路径一次 `#save()` 都不发生，**没有改动**；观测到的差值（含一轮
  +42.7%，绝对量 0.18 → 0.29 ms）是 0.2–1.2 ms 量级上的噪声。

## 4. 机制证据：删掉的是重新解析，而不是序列化

`domain-replay-batch.mjs` 现在在**被测量的一次 flush 内**包装 `JSON.parse` /
`JSON.stringify`，统计调用次数与字符数（与已有的 fsync/write 计数同一性质：与负载、
页缓存、CPU 速度无关）。每次 flush 的中位数：

| 历史 | 形状 | k | 记录 | 保存次数 | `JSON.parse` 次数 | 重新解析的字符数 | `JSON.stringify` 次数 / 字符数 |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| 200 | measurement | 1 | 1 | 2 | 9 → 7 | 25,764 → 18,318 | 32 → 32 / 173,934 → 173,934 |
| 200 | measurement | 10 | 10 | 20 | 36 → 16 | 776,841 → 157,251 | 203 → 203 / 1,081,755 → 1,081,755 |
| 200 | mixed | 10 | 13 | 48 | 70 → 22 | 3,404,390 → 324,644 | 2,039 → 2,039 / 3,968,006 → 3,968,006 |
| 200 | mixed | 25 | 33 | 118 | 286 → 168 | 13,004,873 → 603,612 | 5,922 → 5,922 / 13,946,491 → 13,946,491 |
| 2000 | mixed | 25 | 33 | 118 | 286 → 168 | 13,140,508 → 609,772 | 5,922 → 5,922 / 15,240,078 → 15,240,078 |

- 消失的 `JSON.parse` 次数**恰好等于保存次数**，与形状无关。
- `JSON.stringify` 的次数与**字符数两侧完全相同**：本轮保留的正是 stringify 这个异常
  边界，没有把它挪到别处，也没有减少序列化字节（因此也不声称分配总量按同比例下降）。
- `fsync`/`rename`/`write` 计数两侧完全相同（见证据 JSON）。

## 5. 收益边界与代价

- 收益 = 「一次 flush 内保存次数」× 那一份文档的 `JSON.parse` 成本，并且因为批内文档
  随已追加记录增长而**随 k 二次增长**；所以只对多记录 / 高保存密度事件
  （`canary-passed` 5–6 次、失败成对 3 次）有意义。单条 `measurement-completed`
  （2 次保存）可省 0.03 ms 量级，落在噪声里。
- **含 `"__proto__"` 字面量的 payload 没有收益**：这种文本会命中本节保留的递归清理分支，
  于是每次保存仍然 `JSON.parse` 一次。把基准事件的 `target` 改成 `"__proto__"`、在真实
  端口上跑 `history=200 / mixed / k=25 / 9 样本`：两侧的 9 样本中位数都是 286 次 parse、
  12,954,581 字符，逐样本计数也完全相同，削减为零（自检全部通过，两侧持久文档与归档
  字节相同）。这个边界来自被保留的
  抛错语义，不是额外代价。
- 一次 flush 的墙钟下限没有变：官方后端两次整份文档写入（提交点 + 提交后安装）与
  `syncStage()` 的目录 fsync 仍是主体——本轮同机、同夹具的相位归因测得
  `publication.set` 约 8.5–9.5 ms、提交后 `installPending` 约 7.3–10 ms、`syncStage`
  约 3.3–4 ms——字节与系统调用计数两侧相同，所以小积压时被删掉的这部分 CPU 工作在墙钟
  上基本看不见。
- 没有新增常驻状态。被丢弃的就是每次保存原本也会丢弃的那份对象图；本轮**没有测量
  RSS**，因此不声称内存占用下降。
- **未改动、且已实测确认不可删**的部分（避免下一轮重复调查）：固定 5 次投影里剩下的
  几次都发生在 `installPending()` 与提交点发布上，属于「安装之前完整校验整份文档」这条
  边界；`#save()` 的 housekeeping 不是投影而是后续事件的输入状态；
  `#markBridgeApplied` 的保存写的是桥标记窗口。

### 5.1 已撤回的候选：把整组保存的投影合并成提交前一次

先把这一条记录清楚，避免下一轮重复：既然中间投影的值没有读者，**把一次事务里所有
`#save()` 的投影推迟到 `work()` 结束、只校验最后那份状态**显然更划算。临时副本上的
测量支持这个判断：积压 100 条记录（2,000 条历史）时，200 次保存的投影合计
31.0 ms，而整次 flush 的墙钟是 135.0 ms、CPU 130.2 ms；按这个候选改掉之后，
CPU profile 的采样数从 2,235 降到 1,237（−45%），`toJsonProjection` 从 33.56% 降到
1.29%。

它被**撤回**，原因是等价性无法证明：这样改会把「每次保存都在它原本抛错的地方抛错」
换成「只有最终状态会被校验」。可构造的反例属于**保存之间状态不可表示、但最终状态可
表示**这一类——例如某个 `record*` 调用带进一个 JSON 无法表示的值（BigInt、循环引用、
抛错的 `toJSON`），随后同一事务里的 housekeeping 又把那条记录合并/退休掉：当前实现
在这次保存处拒绝整组，候选实现会提交它。中间投影的值虽然没人读，**它的抛错是边界**，
所以这一条不成立；本轮只删掉结果、保留全部三步抛错（第 2 节）。这条记录同时是
`transaction-save-validation.test.js` 里差分语料的来源。

## 6. 验证

```sh
NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/transaction-save-validation.test.js
NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/
NODE_OPTIONS=--max-old-space-size=4096 npm test
npm run pack:check
npm run release:verify
```

- **持久化字节等价**：`domain-storage-write-path-equivalence.test.js` 的
  「the real port commits byte-identical state before and after the change」在真实端口
  上对比 `release/dsh-evolution-0.2.0-rc.8.tgz` 的反向重建实现与工作树，整份 durable
  文档与每个归档文件逐字节相同；`load-projection-equivalence.test.js` 的
  「the whole pre-change tree and the working tree commit byte-identical state」在另一棵
  完整反向树上做同样比较（80 次写入、含冷档案分段）。两处基线表都已加入本轮的反向项：
  `domain-storage-baseline.js` 的反向结果仍逐字节等于已固定的 rc.8 源码；
  `load-projection-baseline.js` 反向出的 `lib/domain-storage.js` 与本轮改动前那棵树逐字节
  相同（比较脚本逐行确认，含被恢复的旧注释），因此该基线的比较面没有被本轮改动。
- **公开结果等价**：同一批测试比较 `query` 投影、重启后的投影与 live 快照。
- **崩溃恢复与事务边界**：`replay-batch-commit.test.js` 7 项全过，包含「中断的组提交经
  `pending` 记录恢复后每条只应用一次」「组事务失败整组不落盘」「一批记录与逐条事务提交
  出相同持久状态」。
- **失败注入**：`domain-storage-write-path-equivalence.test.js` 的
  「a rejected commit installs nothing in either implementation」。
- **保存异常边界**：新用例 `transaction-save-validation.test.js` 3 项——差分语料的抛错
  等价（含 `undefined` 与 12,000 层 `"__proto__"` 文档）、唯一分歧（schema 会拒绝但 JSON
  能表示的 payload，端口进不来）、以及
  「每次保存仍然 stringify 恰好一次」：它比较 2 条与 5 条积压（4 次与 10 次保存，差 6 次）
  的 payload stringify 次数，固定部分相消，差值必须正好是 6。把 store 里的
  `assertTransactionSave(next)` 删掉后这条用例实测失败（另两条仍通过，它们只覆盖 helper
  本身）；把 `aggregate = next` 删掉则只有源码形状锚点失败——这正是「存下来的值没有
  读者」的实证。
- **「没有读者」也是实测的**：在 /tmp 副本里把那个 store 的 `load()` 改成「本次事务已经
  保存过就抛 `STORE_LOAD_AFTER_SAVE`」，再跑 `BENCH_BACKLOG=0,1,2,5,10`、
  `BENCH_MIX=mixed BENCH_BACKLOG=2,10,25`（全部 `flush()` 自检通过、未触发该错误），
  以及 `test/domain-storage/{replay-batch-commit,storage,archive-stage}.test.js` +
  `test/review-fix-storage-ledger-conflict.test.mjs`（25/25 通过，含 pending 恢复、组事务
  失败、ledger 冲突与锁回收路径）。该副本未入库。

## 7. 已知残差

1. store 里存的不再是投影，而是 updater 产出的值本身（浅视图，嵌套值仍指向 live 状态）。
   端口内没有任何读者（`load()` 只被 `reconcile()` / `verifyConsistency()` 使用，端口不
   调用它们）；上一节的变异实验确认：不更新这个值时，只有源码形状锚点失败，行为测试
   全过。但如果将来有调用方在事务内 `load()`，它拿到的会是未归一化的值。
2. 「schema 会拒绝、但 JSON 能表示」的 payload 不再在保存处被拒绝，而在提交点的
   `schema.parse` 被拒绝（同一个事务仍然被拒，错误路径前缀不同）。该形状进不了这个
   store：官方 domain 读回全局文档时校验，端口每次事务入口再校验一次，两者都有用例。
3. 第 2 节那两处曾只停留在口头论证上的差异（`undefined` 与递归清理溢出）已改为**复现**
   旧调用的同一步：不再需要「这种 payload 进不来」的论证，两侧抛错完全相同，并由差分
   用例逐条钉住。因此除了第 1、2 条，没有其它残差。
