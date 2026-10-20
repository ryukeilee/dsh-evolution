# commit token 的写入代价（同协议 A/B，当前实现重测）

本文只报实测数字：`lib/domain-storage.js` 的持久 commit token
（`presetDir/domain-commit.token`）在默认配置写入路径上多出的成本。

- **本次测量的源码**：`lib/domain-storage.js` sha256
  **`9fb610c2edbb86af56b414abb2012ce8da0705434e442e8a14ab5bba211ee38b`**
  （token-on 侧是该文件的逐字节副本，脚本在测量前断言两侧摘要一致；
  token-off 侧 `5e8fe80a1de046adf5a3b350383c4bd95fd7f8a9d08cda29e0ff10a051f22a5f`）。
- 数据：[`domain-write-path-commit-token.json`](domain-write-path-commit-token.json)
  （两次有效运行的逐对数据 + 原始会话样本 + 等价性断言结果；第三次运行因宿主机
  被无关负载打断而保留、标记为丢弃，不参与任何结论）。
- 复现脚本：[`domain-write-path-commit-token.mjs`](domain-write-path-commit-token.mjs)
  （一条命令，自行从 `lib/` 派生出两侧）。

`docs/performance/domain-write-path.md` 里的数字是**加 token 之前**测的，
不能与本文件相加（见第 6 节）。

> **与上一版证据的关系。** 本文件此前记录的是
> `lib/domain-storage.js` = `abbc8df8c65e8f5ab5dc312575adb8c60bef91473bc83308aaa5c2d37f5d582e`
> 的那一代实现（token 熵取自 `crypto.randomUUID()`）。当前实现改为
> `commitTokenEntropy()`（`randomBytes(16).toString('hex')`）后，那一版的脚本
> 自检直接拒绝运行，旧数字也不再对应任何现存源码。本轮把脚本对齐到当前实现并
> 重测，旧记录整体作废（保留在第 1 节作为历史说明）。数据文件 schema 由 `@1`
> 升到 `@2`：被测量的源码摘要已不同，且新增 `measuredSource`、
> `tokenOperationsPerCommit`、`combined`（含两轮区间与重叠判定）三块。
> 旧 `@1` 文件已不可由任何现存源码复现。

## 1. 为什么不能直接用既有的 A/B 基准

`scripts/benchmarks/domain-write-commit.mjs` 的基线固定为
`release/dsh-evolution-0.2.0-rc.8.tgz`，并对每一对运行断言"持久化树、查询投影、
重启后投影逐字节相同（无掩码、无字段豁免）"。加 token 之后这条断言不再可能成立：
token 是 `presetDir` 下新增的 `domain-commit.token`，而脚本的 `readTree()` 只排除
`domain-archive-lock`。因此本文件的 A/B 只能是**同一棵工作树 ± token I/O**。

以下是**历史事实**（对应 `abbc8df8…` 那一代实现，不是现状）：

- 当时的 token 熵取自 `crypto.randomUUID()`。因为差分 harness 把 `randomUUID`
  换成每次运行重置的确定性序列，token 会从同一条序列里取走 4 个值，使两侧的记录
  id 整体偏移：实测每次提交从 5 次 `randomUUID()` 增至 9 次，已提交记录的 id 从
  `…000000000007 / …012 / …017` 变为 `…000000000011 / …020 / …029`，
  `official/evolution_domain.json` 与归档段的字节随之不同。
- 同一原因也解释了 `test/domain-storage/domain-storage-write-path-equivalence.test.js`
  当时（`abbc8df8…` 一代）的两个失败用例：`the real port commits byte-identical
  state before and after the change`（比较树里多出 `domain-commit.token`）与
  `the committed value is never aliased to the live partition`（每提交多 4 个 UUID，
  记录 id 偏移）。

现状（当前实现，本轮实测）：

- `commitTokenEntropy()` 不来自被 stub 的 `randomUUID()` 序列，因此 token 的两次
  写**不再**消耗记录 id，两侧记录 id 完全相同；每轮的 4 个配对（含预热）都满足“除
  `domain-commit.token` 外逐字节相同”的等价性断言，覆盖 `official/evolution_domain.json`、
  归档段、归档索引、查询投影与重启后投影。
- 上面那两个用例已不再失败：该测试文件已把 `domain-commit.token` 与
  `domain-archive-lock` 一并从比较树中排除（只排除这两个运行期协调文件，域数据
  仍逐字节比较）。本轮实跑：

  ```sh
  node --test test/domain-storage/domain-storage-write-path-equivalence.test.js
  # tests 5 / pass 5 / fail 0 / duration_ms 10602
  ```

因此本节不再声称任何用例当前失败；那两个用例的状态是"在 `abbc8df8…` 一代失败，
现在通过"。

## 2. 测量协议

除以下两点外，与 `domain-write-path.md` 第 2 节一致：同一 fixture（真实官方
`DomainFacility` + `JsonStorageBackend`，同一 `presetDir`）、同一 workload
（公开 `port.observe()`：stage mirror / memory load / work / commit / archive
install / hydrate）、冻结时钟、每次运行重置的确定性 UUID 序列、8 个等分延迟桶、
`cpuUsage` 计量、1 次预热 + 3 次计量、逐对交替先后顺序、串行执行且测量期间不
并行其它命令、每会话 400 次写入。

两点差异（数据文件里的 `protocol.deviationFromPinnedHarness`）：

1. 两侧是**同一棵工作树**加减 token I/O，而不是 rc.8 与工作树（原因见第 1 节）。
2. 树摘要排除 `domain-commit.token` 本身（它是被测量的对象）；其余每个文件仍逐
   字节比较，查询投影与重启后投影也逐字节比较。两轮共 8 个配对（含预热）全部
   `equalOutsideToken: true`；token-off 侧不产生 token 文件，token-on 侧为 32 字节。

token-off 变体只改一个函数（`writeCommitToken`），保留两次 `commitTokenEntropy()`
求值，因此两侧执行同一串表达式，只有两次文件操作不同：

```diff
-  const temporary = `${file}.${commitTokenEntropy()}.tmp`;
-  fs.writeFileSync(temporary, `${commitTokenEntropy()}\n`, { mode: 0o600 });
-  try { fs.renameSync(temporary, file); }
-  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
+  void `${file}.${commitTokenEntropy()}.tmp`;
+  void `${commitTokenEntropy()}\n`;
```

脚本把这四行的**唯一一次**出现作为自检：匹配次数不等于 1 就直接以非零码退出，
不产出任何样本（实测：给 `writeCommitToken()` 加一行 `fs.appendFileSync` 后，
`node … --writes 1 --sessions 1 --warmup 0` 退出码 1，报
`writeCommitToken() no longer has the shape this variant reverts; update the stub`，
stdout 0 字节）。这样源码漂移不会被静默测成"token 开 vs 形态略不同的 token 开"。

**每次提交实际的 token 操作**（用按路径打补丁的 `node:fs` 围绕一次真实
`port.observe()` 实测，不是推断）：先 `readFileSync` 2 次、`writeFileSync` 2 次、
`renameSync` 2 次、`unlinkSync` 0 次；`openDomainStorage()` 打开时 0 次。
五次采样全部相同，即从第一次写入起就是稳态。4 次 `commitTokenEntropy()` 求值
（每次原子替换 2 次）。token 文件 32 字节（16 字节 hex）。

> 上一版本文写的是"每次提交 1 次读 + 2 次原子替换"，低估了读的次数：基线读取
> （`mutate()` 里的 `baseline.token`）与 `advanceCommitToken()` 内的比较读各一次。

环境：Node `v26.12.0` / darwin-arm64 / APFS，8 逻辑 CPU。

| 运行 | 时间窗（UTC） | 耗时 | load average 前 → 后 | 结论 |
| --- | --- | ---: | --- | --- |
| run-1 | 17:18:03 – 17:22:45 | 282.60 s | `1.60/1.55/1.57` → `2.56/2.03/1.77` | 有效 |
| run-2 | 17:22:59 – 17:27:47 | 287.75 s | `2.37/2.01/1.77` → `2.87/2.28/1.93` | 有效 |
| run-3（JSON 标签 `run-3-discarded`） | 17:28:20 – 17:34:02 | 342.47 s | `3.46/2.50/2.02` → `20.34/53.00/31.95` | **丢弃** |

run-3 在运行中途被宿主机上的无关工作占满（load average 1 分钟值跑到 20–53，会话
墙钟 35.8–56.2 s，而 run-1/run-2 是 33.8–36.9 s）。它的第 2–4 个会话受影响、第
5–8 个恢复正常，等于把不同负载下的会话互相比较，摘要因此反号（−0.974% CPU）。
它的原始数据仍留在 JSON 里（`valid: false` + `invalidReason`），但不参与任何结论。

## 3. 实测

### 3.1 run-1

| 对 | 顺序 | CPU token-off (ms) | CPU token-on (ms) | CPU Δ | 墙钟 off (ms) | 墙钟 on (ms) | 墙钟 Δ |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | on→off | 26685.198 | 26832.085 | +0.550% | 35105.731 | 35310.107 | +0.582% |
| 3 | off→on | 26641.051 | 27073.347 | +1.623% | 35090.670 | 35495.878 | +1.155% |
| 4 | on→off | 26479.613 | 28129.892 | +6.232% | 34604.783 | 36879.914 | +6.575% |

3 对计量的中位数：

| 指标 | token-off | token-on | 变化 |
| --- | ---: | ---: | ---: |
| **CPU 总计（主指标）** | 26641.051 ms | 27073.347 ms | **+1.623%** |
| 墙钟总计（辅助） | 35090.670 ms | 35495.878 ms | +1.155% |
| 单次写入墙钟中位数 | 87.957 ms | 88.495 ms | +0.613% |
| 会话内单次写入中位数 | 87.590 ms | 88.841 ms | +1.428% |
| 最后一个桶（第 351–400 次）中位数 | 128.028 ms | 130.899 ms | +2.242% |
| 单次写入 CPU | 66.603 ms | 67.683 ms | +1.623% |

波动范围：token-off CPU `26479.613 – 26685.198`（MAD 44.147），token-on CPU
`26832.085 – 28129.892`（MAD 241.262），**不重叠**；墙钟 off
`34604.783 – 35105.731`（MAD 15.061）、on `35310.107 – 36879.914`（MAD 185.771），
同样不重叠。三对方向一致（全为正）。

摊到每次提交：CPU **+1.081 ms**、墙钟 **+1.013 ms**（中位数差 ÷ 400），约为单次
写入（88 ms）的 1.2%。

注意第 4 对的 token-on 会话是这一轮的离群值（CPU 28129.892，比本轮 token-on 中位数
高 3.9%；墙钟 36879.914，高 3.9%），它把两侧的差距放大到 +6.2%。中位数结论
（+1.623%）不受它主导，但这一轮的最坏值不可当真值。

### 3.2 run-2（独立重复）

| 对 | 顺序 | CPU off (ms) | CPU on (ms) | CPU Δ | 墙钟 off (ms) | 墙钟 on (ms) | 墙钟 Δ |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | on→off | 26960.482 | 26997.907 | +0.139% | 35496.925 | 35507.115 | +0.029% |
| 3 | off→on | 26789.348 | 27320.157 | +1.981% | 35308.939 | 36278.511 | +2.746% |
| 4 | on→off | 29223.342 | 27129.831 | **−7.164%** | 39227.909 | 35580.784 | **−9.297%** |

中位数：CPU `26960.482 → 27129.831 ms`（**+0.628%**，MAD 171.134 / 131.924）、
墙钟 `35496.925 → 35580.784 ms`（+0.236%，MAD 187.986 / 73.670）；单次写入墙钟
中位数 `87.961 → 89.911 ms`（+2.217%）、会话内单次写入中位数
`87.978 → 88.760 ms`（+0.890%）、最后一个桶 `131.281 → 131.064 ms`（−0.165%）。
摊到每次提交：CPU **+0.423 ms**、墙钟 **+0.210 ms**。

**范围重叠**：token-off CPU `26789.348 – 29223.342` 与 token-on
`26997.907 – 27320.157` 相交；墙钟 `35308.939 – 39227.909` 与
`35507.115 – 36278.511` 相交。原因是第 4 对的 token-off 会话跑成 29223.342 ms /
39227.909 ms（该轮 token-off 中位数是 26960.482 ms / 35496.925 ms，即 CPU +8.4%、
墙钟 +10.5%），而同对的 token-on 完全正常——这一对因此反号到 −7.164%。

### 3.3 两轮合并（6 对 / 每侧 6 个会话）

| 指标 | token-off | token-on | 变化 |
| --- | ---: | ---: | ---: |
| 会话 CPU 中位数 | 26737.273 ms | 27101.589 ms | **+1.363%** |
| 会话墙钟中位数 | 35207.335 ms | 35543.950 ms | +0.956% |
| 单次写入墙钟中位数（6 会话池化） | 87.784 ms | 88.801 ms | +1.158% |
| 逐对 CPU Δ 中位数（6 对） | — | — | **+1.087%** |
| 逐对墙钟 Δ 中位数（6 对） | — | — | +0.869% |

逐对 CPU Δ 全部取值：`−7.164 / +0.139 / +0.550 / +1.623 / +1.981 / +6.232`（5 正
1 负）；逐对墙钟 Δ：`−9.297 / +0.029 / +0.582 / +1.155 / +2.746 / +6.575`。
摊到每次提交：CPU **+0.911 ms**、墙钟 **+0.842 ms**。

两轮一致的部分：**每个有效轮的 CPU 与墙钟中位数都为正**，5/6 对为正，
代价量级 0.4–1.1 ms CPU / 0.2–1.0 ms 墙钟每提交（约单次写入的 0.2–1.2%）。

两轮不一致的部分（必须如实记录）：**run-1 两侧区间不重叠，run-2 重叠**；两轮各有
一个明显被扰动的会话，且落在相反的一侧（run-1 第 4 对的 token-on、
run-2 第 4 对的 token-off）。因此：

- 上一版证据（`abbc8df8…`，两轮都不重叠）里"两侧区间不重叠"这句话**不能作为
  一般结论**，本轮撤回；能保留下来的只有"中位数为正、量级约 1 ms / 提交"。
- 每侧只有 6 个会话样本（每会话 400 次写入只产生 1 个 CPU 值、1 个墙钟值），
  样本粒度太粗，不支持更细的区间或置信区间。

## 4. 孤立测量：两次 token 操作本身

把 `commitTokenEntropy()` / `readCommitToken()` / `writeCommitToken()` 三个块按
当前 `lib/domain-storage.js`（同一 sha256）原样抽取到内存执行（抽取失败即抛错），
对同一个 token 文件交替执行 5 × 400 次：原子替换（写临时文件 + `rename`，
**无 fsync**）中位数 **0.155 ms**（min 0.144 / max 0.796），读取中位数
**0.016 ms**（min 0.016 / max 0.271），按第 2 节实测的"2 次读 + 2 次原子替换"
合计 **0.342 ms / 提交**。

这与第 3 节的 0.42–1.08 ms CPU / 0.21–1.01 ms 墙钟每提交**不是一组可相减的
数**：孤立测量没有端口内其它 I/O 竞争，token-off 侧的读取每次都走 `ENOENT`
抛错分支（抛错本身不是零成本），token-on 侧还多出 4 次 `randomBytes(16)`。
本文件不做归因：只声明端到端逐轮中位数 +0.6–1.6% CPU（合并池化 +1.36%），
以及两次原子替换 + 两次读取在本机约 0.34 ms / 提交，其余差异没有分解。

## 5. 收益/代价边界

- 代价随**提交次数**线性增长：每次提交 2 次读 + 2 次原子替换 + 4 次
  `randomBytes(16)`，端到端约 **+0.9 ms CPU / +0.8 ms 墙钟**，即单次写入（约
  88 ms）的 **1% 左右**。与写入无关的路径（查询、诊断、promotion 审核）不受影响。
  token 不 fsync，因此它不承担持久性代价。
- **这不是"无性能影响"。** 5/6 对为正、两轮中位数都为正；虽然差距小到单轮内会
  被宿主机噪声（±10% 的离群会话）淹没，方向上仍是净成本。
- 收益本文件不量化，也无法用当前基准量化：让"另一个端口已经提交"在跨端口场景下
  可见，并把窗口从"整个事务"缩到"一次后端写入"（语义与残余窗口见 `RELEASE.md`
  第 6 节第 27、28 条）。
- 数据是 400 次写入、本机、热页缓存、单一文件系统（APFS）下的合成负载。没有测
  冷缓存、网络文件系统、其它平台，也没有测崩溃/断电路径上的 token 状态。

## 6. 与 `domain-write-path.md` 数字的关系

`domain-write-path.md` 的 −10.02% CPU / −5.96% 墙钟是**加 token 之前**、
rc.8 与当时工作树之间那次保留变体的收益。本轮测的是当前工作树加减 token I/O
的代价，两者基线不同、轮次不同、测的源码摘要不同，**不能相加**，也不能据此声称
"净收益约 −8.9%"。能说的只有：token 的端到端代价（逐轮 +0.6–1.6% CPU）小于那轮写入
路径变体的收益（−10.0% CPU），方向相反。

## 7. 复现

```sh
node docs/performance/domain-write-path-commit-token.mjs --writes 400 --sessions 3 --warmup 1
```

- 一条命令跑完，本机无争用时约 **283–288 s**（8 个会话 × 400 次写入；run-1/run-2
  实测 282.60 / 287.75 s，宿主机被占用的 run-3 用了 342.47 s）；输出 JSONL
  （metadata / equivalence / sample / summary），与
  `domain-write-path-commit-token.json` 中的 `runs[].*` 对应。
- metadata 与 summary 都带 `repoSourceSha256`，并在测量前断言 token-on 侧确为
  `lib/domain-storage.js` 的逐字节副本；token-off 侧的全文件摘要单独列出。
- `writeCommitToken()` 形态漂移 → 退出码 1、无样本（第 2 节）。
- 任一配对不满足"除 token 外逐字节相同"（树、查询投影、重启后投影、持久化
  shape）→ 进程非零退出。
- 冒烟（不产数据，只验证两侧可跑通与等价性）：`--writes 1 --sessions 1 --warmup 0`。

JSON 里刻意**不保留**派生树所在的宿主机临时路径（`/var/folders/<每用户哈希>/…`）：
`runs[].sources[].path` 只写 `<temp>/lib-tokenoff/domain-storage.js`。保留的是摘要、
窗口、load average、逐对与逐会话数字、等价性断言结果——脱敏不删可复现所需的字段。
fixture 是 `/tmp` 下的合成数据（`eventBridgeKey` 为脚本内写死的
`"b".repeat(64)`），不含任何真实 `DSH_HOME`、用户数据或凭据。

## 8. 未覆盖

- 只在 macOS / APFS 上测过；两次 token 操作是 `writeFileSync` + `renameSync`，
  其它文件系统上的代价未测。
- 没有测崩溃/断电时 token 与文档的不同步比例（那是 `RELEASE.md` 第 28 条的失效
  语义，不是性能问题）。
- 没有测多进程真实并发下的成本（`lib/dockyard-domain/PORTS.md` 要求独占数据根，
  跨进程锁只是误并发启动的安全网）。
- 没有把端到端 +0.6–1.6% 的差异分解到具体系统调用；只有 token 两次读写单独
  0.342 ms / 提交这一项组件测量。
- 每侧只有 6 个会话样本，且两轮各含 1 个被宿主机噪声扰动的会话（分处两侧）；
  没有第三轮有效数据去交叉验证，run-3 因环境失效被丢弃（第 2 节）。
- 未测 400 以外的写入规模，未测冷页缓存、未测并发端口之间的真实竞争
  （`domain-commit.token` 的跨端口语义只在单端口顺序写入下被间接覆盖）。
