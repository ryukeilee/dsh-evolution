# 事件桥积压事件的逐条事务开销

`registration.js` 在 `agent/pre-step` 与每个 Evolution 工具结束时调用
`domainStorage.flush()`，两者都进入同一条 `replay()`。这一轮先确认这条路径
在两类真实形状下的成本分布，再只改成本占主导的那一类。

环境：Node `v26.12.0`，`darwin/arm64`。原始 12 次运行见
[domain-replay-batch.json](domain-replay-batch.json)。

## 1. 路径与调用频率

- **无新事件（稳态）**：每个 Agent 步骤一次、每个 Evolution 工具结束一次。
  这一步只重新读取事件日志、按 keyed digest 认证已消费前缀、核对标记表摘要，
  不写任何东西。实测 200 条历史 0.18 ms、2,000 条 1.10 ms，且 `fsync` 为 0。
  历史 `domain-replay.md` 已把这条路径的逐记录解析与 DTO 构造删除干净，
  本轮复测没有发现新的重复工作。
- **有新事件（积压）**：一次工具调用可能连续写入 2–3 条记录（`experiment-rejected`
  与 `failure-learned` 成对发出、`revert`/`promote` 失败路径连续发多条），
  自主观察者在两步之间写入，进程停机期间的追加也会在下次启动或下一步集中到来。
  这类记录此前**逐条**触发一次完整的可变事务。

## 2. 归因

对单条事件的 `mutate()` 逐段计时（200 条历史，临时探针，未入库）：
阶段镜像 `mirrorArchives` 0.3–0.4 ms，`createMemory`+`load` 0.9–1.4 ms，
提交后重载 `hydrate` 0.9–1.4 ms，`syncStage`（暂存归档 fsync）6.3–6.5 ms，
提交点发布与安装合计 17 ms，其中两次整份文档写入各约 7–8 ms。
系统调用计数给出同样的结论：**每条记录固定 3 次 `fsync` + 2 次**（提交点的
`pending` 记录、安装后的关闭写入），即 k 条记录 3k+2 次 `fsync`、3k+1 次
`writeSync`、3k 次 `writeFileSync`、3k+1 次 `renameSync`。

这些写入是两阶段提交协议本身要求的（先持久化 `pending`，再安装归档并关闭），
不能删除。可以删除的是**同一条 flush 内把同一协议重复 k 次**：这些记录彼此独立、
顺序已由日志给定，去重与冲突判定只依赖标记表。

## 3. 改动

`replay()` 现在把一次 pass 认证过的记录作为**一个**事务提交：

- 每条记录仍各自 `JSON.parse`、MAC 验证、writer 校验、标记/冲突检查、
  `projectExecutionEvent` 投影，并在 `work()` 内按文件顺序逐条
  `applyExecutionEvent`（顺序、去重、`E_DOMAIN_EVENT_ID_CONFLICT` 全部保留）。
- 组内重复 id 由本 pass 的 `batchMarks` 承担，语义与逐条路径提交后查标记表一致：
  同 MAC 计为 duplicate，不同 MAC 拒绝。
- 交给 `mutate()` 的仍是**整份已提交标记表**加本组新记录，因此“恢复安装的标记
  与调用方标记冲突即拒绝”这条判定（`R6`）没有放宽。
- 认证失败时先提交已验证前缀再抛出，与逐条路径“读下一条之前已提交前一条”一致；
  组事务自身失败则整组不落盘，下一次 pass 按文件顺序重放，标记表保证不会重复应用。
- 检查点仍只在整次 pass 成功后推进；被拒绝的 pass 不写检查点。
- 没有新增缓存、缓存失效信号或新的持久字段；持久化格式、fsync 次数（每组一次
  协议）、跨进程锁、CAS 与恢复路径不变。

### 3.1 收口修复：组大于标记窗口时的同端口重试（独立审核发现）

独立对抗式审核在合并前复现了一个阻塞缺陷，它在逐条路径上不存在、在分组路径上
存在，因此属于本轮引入：

- **现象**：一次 flush 认证了 4097 条记录，提交点（`pending` 记录）成功、关闭写入
  失败；**不关闭端口**再调一次 `flush()`，第二次返回
  `{ applied: 4097, duplicates: 0 }`，`evolution.lineage` 多出第二代
  （`bridge:lineage:plugin:retry:1` + `…:2`）。逐条路径下中断的 `pending` 最多只
  涉及一条新事件，不会出现这个窗口。
- **原因**：`EvolutionMemory` 的桥标记窗口是滚动保留**最后 4096 条**
  （`#markBridgeApplied` 的 `applied.slice(-4096)`），恢复安装的标记里最早那条已经
  滑出窗口，于是它被再次应用；再次应用又推进窗口，连带后续记录级联重放。组事务
  自己是对的（`mergeEventLedger` 正确合并了恢复的完整 ledger），缺的是“应用前先
  问已提交 ledger”这一步。
- **修复**：`mutate()` 把恢复后的已提交标记表交给工作函数
  （`work(instance, store, { recovered })`），分组提交在应用每条记录前先看
  `recovered[eventId] === mac`，命中即计为 duplicate 并跳过。这条判定用的是
  **已提交的完整 ledger**，不是内存窗口；没有放宽冲突判定（同 id 不同 MAC 仍然在
  `mergeEventLedger` 里抛 `E_DOMAIN_EVENT_ID_CONFLICT`），没有改变重启路径
  （重启仍然读安装后的 aggregate，本来就不会重放）。
- **回归**：`test/domain-storage/replay-batch-commit.test.js` 新增“组大于
  4096 条窗口的同端口重试”用例，断言重试返回 `{ applied: 0, duplicates: 4097 }`、
  `applied` 标记表恰好是文件顺序、桥标记窗口只保留最后 4096 条且每条一次、
  `lineage` 只有一代。该用例在修复前的实现上实测失败
  （`applied: 4097, duplicates: 0`），修复后通过；代价是该用例需要 4097 条事件
  （每条一次整份 aggregate 投影），单机约 26 s。

## 4. 可复现性能

```sh
rtk proxy node scripts/benchmarks/domain-replay-batch.mjs
rtk proxy env BENCH_EVENTS=2000 BENCH_SAMPLES=9 node scripts/benchmarks/domain-replay-batch.mjs
```

脚本使用真实官方 `DomainFacility` + `JsonStorageBackend`，加载已签名、已提交的
合成历史，测量真实 `port.flush()`（读取、认证、去重、完整事务与重载），
不含 fixture 构建、进程启动与新记录签名；每个样本自检 `{applied, duplicates}`。

基线导出到临时目录，复制同一脚本并复用锁文件安装的依赖：

```sh
rtk proxy sh -c '
task_baseline_dir=$(mktemp -d /tmp/dsh-replay-batch-baseline.XXXXXX)
git archive HEAD | tar -x -C "$task_baseline_dir"
cp scripts/benchmarks/domain-replay-batch.mjs "$task_baseline_dir/scripts/benchmarks/"
ln -s "$PWD/node_modules" "$task_baseline_dir/node_modules"
cd "$task_baseline_dir" && node scripts/benchmarks/domain-replay-batch.mjs
'
```

三轮交替（第 1、3 轮基线先跑，第 2 轮候选先跑），每轮两侧独立进程、同参数、
预热 3 次、测量 9 次；下表是三轮中位数的中位数，占比为候选相对基线。
`domain-replay-batch.json` 每侧每场景只保留**每轮的中位数**（3 个值，即下表
“各轮耗时差”一列），没有保留每轮的 9 个原始样本；因此“轮内 9 个样本的中位数”
这一步只能由 `method.samples: 9` 的声明说明，无法仅凭该 JSON 复算。

历史 200 条（日志 182,842 字节）：

| 积压事件 | 基线耗时 | 优化耗时 | 变化 | 基线 CPU | 优化 CPU | 变化 | `fsync` 基线→优化 | 各轮耗时差 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 0 | 0.18 ms | 0.18 ms | −2.2% | 0.23 ms | 0.23 ms | −1.7% | 0 → 0 | −0.01 / −0.00 / −0.00 |
| 1 | 33.68 ms | 32.72 ms | −2.9% | 10.37 ms | 10.23 ms | −1.4% | 5 → 5 | +0.83 / −5.15 / −0.23 |
| 2 | 69.64 ms | 38.71 ms | **−44.4%** | 29.76 ms | 15.68 ms | −47.3% | 8 → 5 | −28.99 / −30.47 / −31.94 |
| 5 | 166.39 ms | 38.94 ms | **−76.6%** | 66.07 ms | 16.82 ms | −74.5% | 17 → 5 | −128.34 / −122.82 / −127.45 |
| 10 | 328.10 ms | 46.24 ms | **−85.9%** | 146.75 ms | 28.29 ms | −80.7% | 32 → 5 | −277.02 / −279.56 / −283.47 |

历史 2,000 条（日志 1,324,803 字节）：

| 积压事件 | 基线耗时 | 优化耗时 | 变化 | 基线 CPU | 优化 CPU | 变化 | `fsync` 基线→优化 | 各轮耗时差 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 0 | 1.10 ms | 1.11 ms | +0.6% | 1.17 ms | 1.16 ms | −0.6% | 0 → 0 | −0.01 / +0.02 / +0.01 |
| 1 | 40.84 ms | 40.83 ms | −0.0% | 16.92 ms | 16.63 ms | −1.7% | 5 → 5 | −0.40 / −0.02 / −0.63 |
| 2 | 76.78 ms | 41.73 ms | **−45.6%** | 32.86 ms | 18.66 ms | −43.2% | 8 → 5 | −35.05 / −35.98 / −36.05 |
| 5 | 177.53 ms | 41.64 ms | **−76.5%** | 76.78 ms | 19.56 ms | −74.5% | 17 → 5 | −135.96 / −139.70 / −128.87 |
| 10 | 352.32 ms | 47.58 ms | **−86.5%** | 169.28 ms | 27.90 ms | −83.5% | 32 → 5 | −312.69 / −301.89 / −298.24 |

同一批运行里的其它系统调用（历史 200 条，积压 10）：`writeSync` 31 → 4、
`writeFileSync` 30 → 3、`renameSync` 31 → 4、`readFileSync` 41 → 5。
这说明增益不是把 I/O 挪到别处的假象：一次 pass 的持久化写入确实从 3k+2 次
`fsync` 降到 5 次。

### 稳定收益与噪声

- **积压 ≥ 2**：两档历史、三轮、耗时与 CPU 全部同向，单轮差值彼此相差不超过
  约 5%，`fsync`/`rename`/`write` 计数是机制级证据，与负载和页缓存无关。
  积压 10 条时每次 flush 省约 280–313 ms。
- **积压 1**：结构上没有任何合并可做（1 条记录本来就是 1 次事务），实测差值
  落在 ±1–5 ms 噪声带内，**不声称收益**。
- **稳态（积压 0）**：差值在 ±0.02 ms，**不声称收益**；这条路径本轮没有改动。

## 5. 收益边界与代价

- 收益完全等于“同一次 flush 内积压记录数 − 1”个省下来的事务，因此只对
  多记录积压有意义；单条新事件、以及由 LLM 或磁盘提交主导的端到端流程收益更小。
- 组事务把 k 条记录的暂存、归档安装与文档写入合并，峰值内存略高（暂存目录与
  `files` 清单覆盖整组，另加每条待提交记录一份投影，量级为数百字节），
  不引入常驻缓存或新状态。
- 组事务失败时该组的记录一次都不落盘，而逐条路径会保留失败点之前的记录。
  两者在下一次 pass 收敛到同一状态（标记表 + 未推进的检查点），差别只在这一个
  失败的 pass 里已认证记录的落盘时机；这一差异由
  `test/domain-storage/replay-batch-commit.test.js` 的两个用例分别钉住
  （认证拒绝保留前缀、组事务失败整组回滚）。残留风险说清楚：若积压中某条记录
  永久失败（例如签名字正确但事件类型不被接受），两种实现都永远无法推进这条 pass
  （`flush()` 每次都抛错），且都需要操作者修日志；区别是逐条路径在这一状态下
  已把失败点之前的记录写入，合并路径没有。这个差别在有检查点之后的正常稳态
  不会出现，因为积压记录数由两步之间的写入量决定。
- 页缓存为热缓存；没有声称物理磁盘 I/O 总量下降的比例，只报告调用计数。

## 6. 验证

```sh
rtk proxy env NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/replay-batch-commit.test.js
rtk proxy env NODE_OPTIONS=--max-old-space-size=4096 npm test
rtk proxy npm run pack:check
rtk proxy npm run release:verify
```

新增 7 项回归（`test/domain-storage/replay-batch-commit.test.js`）。其中
“一次事务提交整段积压”和“组事务失败整组不落盘”在改动前的实现上失败，第 3.1 节
那条窗格用例在收口修复前也失败；其余各项
在两侧都通过，用于钉住不得改变的性质：组内重复 id 去重与同 id 不同 MAC 拒绝、
认证拒绝保留已验证前缀且不推进检查点、中断的组提交经 `pending` 记录恢复后每条
只应用一次、同一批记录一次提交与逐条提交产生相同持久状态。最后一项比较提交后的
**整份 durable global 文档**（含 aggregate）与每个归档文件摘要；它不会吞掉
`flush()`/`close()` 的异常。

该等价性用例现在会先种一个**已提交的冷档案**，因此 aggregate 里也带上了归档元数据
（路径在内）。此时唯一被归一化的字段是事务自己的暂存目录名：快照是在自己的 stage
里拍的，`coldArchives` 的 `file` / `activeFile` / `indexFile` 记录的是
`domain-staging/stage-<uuid>/…`，而加载时这些路径一律按实时路径重建
（`memory.js` 的 `#reconcileArchiveIndex` 用 `#archivePath(collection)` 覆盖它们）；
组事务分配的 stage 更少，所以两边这些标识符必然不同，其余字节必须相同。用例先断言
归一化后逐字节相同，再断言文档里确实出现了被归一化的字段，避免“因为没写归档元数据
所以比较通过”这种空转。因此本轮的字节等价声明范围是：**除事务暂存目录名之外**
逐字节相同；聚合语义、标记表与归档文件字节完全相同。

一次独立对抗式审核在真实官方 JSON 后端上复核了组内冲突、ledger 恢复合并、认证
拒绝保留前缀、`pending` 恢复与检查点计数，未发现阻塞性问题；它确认的唯一缺陷是
该等价性用例最初的实现把 `return` 放在 `finally` 里、并且只比较了部分字段，
因此注入异常或被清空的 `aggregate.evolution.experiments` 都会错误通过。该缺陷已
修复，并已用同样两种注入验证修复后的用例确实失败（注入异常与
`CORRUPTED_EXPERIMENTS 2 -> 0` 均使用例失败）。

`test/domain-storage/domain-storage-baseline.js` 的反向表新增一项，把
`replay()` 逐字节还原为 `release/dsh-evolution-0.2.0-rc.8.tgz` 的源码，
因此差分等价性测试（同一 workload 在冻结时钟与 UUID 下逐字节比较提交结果）
仍然锚定在已发布产物上。

本机实际结果与既有失败见提交说明；`pack:check` 的三项失败（旧验收证据内容、
`release/manifest.json` 固定点、工作树与固定制品不一致）在本轮改动之前就已存在，
本轮没有修改版本、固定点或 `release/`。
