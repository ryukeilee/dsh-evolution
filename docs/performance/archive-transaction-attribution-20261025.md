# 归档事务的重新归因（2026-10-25，第二遍：最终树）：没有合格候选，生产代码保持原样

## 0. 裁决

**本轮不改生产代码。** 本文件记录的是**第二遍**测量：第一遍在 20:51 冻结了 `lib/`，
那时另外两个 worker 还在改 `lib/`，所以第一遍记录的
`libTreeSha256 = 9392a800…` 描述的不是任何一棵能签出的树。本遍在**最终工作树**上把
第一遍用到的全部 harness 原样重跑了一遍，记录换成最终树；第一遍保留为
「前一次观测」，没有被静默覆盖。

- 最终树：`libTreeSha256 = b2ec5c63522097fe491916bb698481d19f9930b0392633611c05edd85b1eff15`
  （41 个 `lib/**/*.js` 的排序摘要清单，逐文件哈希见 §1）。
- `git rev-parse HEAD` = `9994ab4b98997737d68bbbe614b02aba85ccc62f`（`main`）。
  **被测的是一棵工作树，不是一个提交**：HEAD 之上还有四个未提交的改动
  （`lib/diagnostics.js`、`lib/dockyard-domain/knowledge.js`、`lib/domain-storage.js`、`lib/orchestrator.js`，
  都是另外两个 worker 的）。只签出该提交无法复现这里的数字。
- 两棵树之间只有 `lib/diagnostics.js` 与 `lib/orchestrator.js` 变了；
  `lib/archive-stage.js`、`lib/dockyard-domain/memory.js`、`lib/domain-storage.js`、
  `lib/event-log-checkpoint.js`、`lib/index.js` **逐字节相同**，所以两遍测的是同一条被测代码路径。
- 生产代码未改动：`git diff -- lib/` 的 SHA-256 在本遍开始与结束时都是
  `05ee32e9b83bb8d3fd5e9bbe50cb26328bac273684c0ecb5737ca148ba472fb8`，41 个 `lib/**/*.js` 摘要逐个不变。

`closure.md` 的归档写入归因（4 次 `cpSync` + 518 次 `fsyncSync`）描述的是 `378f535` 的复制式
安装路径，`cbeee84`（`link`+`rename` 发布暂存 inode）与 `f89221f`（停掉检查点与暂存清单的
fsync）之后已经不成立。**结论没有变，两遍一致：**

| 负载 | 中位墙钟（最终树 / 前一次） | 达到 5% 的项（最终树） | 状态 |
| --- | --- | --- | --- |
| 一次 `port.observe()`，0 段 | 10.961 / 10.970 ms | 只有一族：`readdirSync` 合计 5.32%（前一次 5.5%） | 去掉这族只能靠缓存段目录列表，而缓存必须被事务自身的轮转失效，漏一次就静默少一个冷段；不采用（§5.1 第 2 项） |
| 一次 `port.observe()`，256 段 | 130.917 / 130.159 ms | 镜像 `linkSync` 60.10%、`rmSync` 8.37% | 都是 `archive-stage-io.md` §6 已关闭的「跨事务复用暂存目录 / 密封段直接读 live」 |
| `flush()`，20k 历史、追加 1 条 | 56.034 / 54.169 ms | `set.final` 30.74%、`plan` 17.80%、`merge` 10.55%、`checkpoint.write` 9.13%、`copy.baseline` 7.32%、`copy.replayLedger` 7.06% | 分别落在「文档格式 + 发布校验 + 官方 backend」「日志读取/摘要/每次 crypto」「标记表读取顺序被测试钉住」 |
| `flush()`，20k 历史、无新事件 | 8.804 / 8.829 ms | `plan` ≈ 100% | 同上（读取块尺寸、摘要缓存、每次 crypto 均已关闭） |

**没有 ≥5% 项在两遍之间出现或消失**（详见 §4.1）。仅有的两处跨线是框架层聚合与一个 profile 帧，
两者都被解释清楚且不改变裁决。最大的未关闭项仍然是 `EvolutionMemory#archiveFiles()` 的 O(n²) 去重
（最终树 256 段负载的 **2.8%**，前一次 2.9%）。按任务要求，本遍同样在此停止，不为了"有东西可交"而发明候选。

原始数据见 [`archive-transaction-attribution-20261025.json`](archive-transaction-attribution-20261025.json)：
本遍与前一观测的每一次采样原始数组、完整 profile 汇总（含 `positionTicks`）都在里面。
新增的归因脚本：[`scripts/benchmarks/archive-observe-attribution.mjs`](../../scripts/benchmarks/archive-observe-attribution.mjs)。

## 1. 源身份：最终树

`libTreeSha256` 的算法：把 `lib/` 下每个 `*.js` 的 SHA-256 按相对路径排序，拼成
`<digest>  ./<path>` 每行一条，再取整串的 SHA-256。它就是
`archive-observe-attribution.mjs` 打印的 `libTreeSha256`；本遍的两次归因运行（0 段与 256 段）
全部带 `--expect-lib-sha256 b2ec5c63…` 并通过（错误的哈希会以
`lib/ tree is b2ec5c63…, expected one of deadbeef` 失败退出）。

- 记录值：`b2ec5c63522097fe491916bb698481d19f9930b0392633611c05edd85b1eff15`
- `git rev-parse HEAD`：`9994ab4b98997737d68bbbe614b02aba85ccc62f`，分支 `main`
- 树的性质：**HEAD + 未提交改动**（不是提交）。未提交的四个文件是
  `lib/diagnostics.js`、`lib/dockyard-domain/knowledge.js`、`lib/domain-storage.js`、`lib/orchestrator.js`。
- `git diff -- lib/` 的 SHA-256（本遍开始 = 结束）：
  `05ee32e9b83bb8d3fd5e9bbe50cb26328bac273684c0ecb5737ca148ba472fb8`

逐文件（41 项）：

```
27a5675de6de320349dd800cf74c73702677b29ac65a964cee8959d4b1663c08  lib/archive-stage.js
e19ee2493841ae487bb343a974ad49389a6d72d308508a9cefdefffc9f32f5f4  lib/compat/legacy-startup-drift.js
c0712ec17f4cc21b5e84e13cb42b5cbd42049c8fcab3edfa6e0562ae1ba669c9  lib/cordis-compat.js
7995c9e1f570aa804e2a2ab83d97575e98ed9c4f1390dd9b1317fb5e8a9ce72b  lib/diagnostics.js
cd2474bd442f586e19b1383a1bbb70d19579e0e38a4aaaf065fe243ea51ec9e5  lib/dockyard-domain/continuous/discovery-metrics.js
7566758588276cda7e7fee67cae38af53be2c5f0ef8ceaf67cd3c985652cd76e  lib/dockyard-domain/continuous/facade.js
d388fff2a0e0a851110439934285a3e8da0728804d16bd81fe3d3a3379a8a527  lib/dockyard-domain/continuous/index.js
543babbf01ca0ddb1d8e7890ba7c090bfc2f487c6a462cee90fbc9efcbad413f  lib/dockyard-domain/continuous/lineage.js
914cd82056d0affd84f56020457f1206060db483345897c4ff492792e4ce6d22  lib/dockyard-domain/continuous/ports.js
e066c5247eb0324d0ee235cd9cd2aa1d915f433e34f493d5bd6c1b59c13e3240  lib/dockyard-domain/continuous/reporting.js
c361dd2e2b2583d146392a5097630b3cf88bd9e62384fa9aa85244b1756fedab  lib/dockyard-domain/continuous/shared.js
91918a6df0caefbc4f98d684e149b7113251bd110f5d92258ae25246d4b4462c  lib/dockyard-domain/continuous/strategy.js
8c77f38b958e55fc15973e716ce15bacafdd608c74b4161c27c70488dfb6f09f  lib/dockyard-domain/continuous/supervisor.js
b92d0b082c91efb176ef46ba85d2b9a47356c380abca45145aa2651be8bea72e  lib/dockyard-domain/continuous/trial-supervisor.js
271ad50af9a39c40d51c61519d515711e9a13f39bead2cbff854a06f1449d312  lib/dockyard-domain/errors.js
e368c22e6cf5ef6b5c0686a9c2fd8930b232feb5e62c4d57938cd69819dfe5cd  lib/dockyard-domain/evaluator.js
446459fc3ae89026a2de1dd07b452f78f4817f7ad4d0b9d0329c906b6dda6742  lib/dockyard-domain/governance/authority.js
2c07664e4b163274792276885f160afa31b62d89918b16a9b52d83db39056ea8  lib/dockyard-domain/governance/canary.js
ab96ccf0280c5166ae7bb77b8c19767c936219af845fa47efdfcf2a5e35f231b  lib/dockyard-domain/governance/capability-registry.js
95838f766a067256a26a40755eaf35840bf4fefb62b147711c13ff3365ac5103  lib/dockyard-domain/governance/fitness.js
7873ba0f77189319fd3eff6d25cb028aacf9499ef0679cded4b2d463ba894f2c  lib/dockyard-domain/governance/generation-policy.js
259a8eb978667c0fd72e1f99c2f9e87f3472404f67e3aaa0e38782becc651c68  lib/dockyard-domain/governance/helpers.js
98a8601d9efa7a4751412d3dfe68a541299844c548b0b8dc5476c3a035238a8b  lib/dockyard-domain/governance/mutation-authority.js
54aabaa2ed08eaaa31718280a41e1d0e8cd51bba63e03001d38f51838a72e9db  lib/dockyard-domain/governance/retirement.js
bcfea9a5856a781cd334aec6ff6d90af356628fa03e0404c8451fb2910cd173f  lib/dockyard-domain/governance/store.js
c7be96b09e2a13152c19d166061f49c216fbecbb81af76e93f4542cb920c599b  lib/dockyard-domain/governance/trust-root.js
d5f8b41af34509e75e6b581f2a2ba54d2cfc9a9f3d72647a876c8f17f4264201  lib/dockyard-domain/index.js
829f6b0a43c66cc7289ce13d7a8d31d6cf2a7a5caf396fa8b36ef720adf2fef8  lib/dockyard-domain/knowledge.js
d68d20965613eac39f052479876ffc394da5ba9b377d8e71e3654cb75b63bc8a  lib/dockyard-domain/manifest-contract.js
b45939cf06740ca4a5e0800dea0c3b89fc865f107cffbc5abac663c0850ebebb  lib/dockyard-domain/manifest.js
8f88860bbba6985ac1a76f4cc896efb1c79a408b157eafa7a3223bd9bdbd2033  lib/dockyard-domain/memory.js
7248de9e4253d635b2ec341e112dbd13895f9d03a061b933bc16d7570a3d71d1  lib/dockyard-domain/metric-projection.js
8ea4d2deac99e26d4bae0ce7f4ac4e890f073b753bdfff8563beb322f837b1e5  lib/dockyard-domain/observation.js
a987c3960700531686e1a72d252a1bbc3d7a88c7c54c470fa6ab6b9af713df51  lib/domain-storage.js
7242a96be25f36f9256a7c77965c47ea125391ceca7a0ddcb266b9ab56bfa91c  lib/event-log-checkpoint.js
12f711b8b8fe3dc1463eafb61765f1bbe4370bb692f08d00210ca317c06a5db3  lib/experience-recall.js
06bbb5c516f909b712dfa14aa0e7e1266696909e8a069af90c5742acf81a2dd9  lib/guard.js
961f9764efe3472f30a48d90ff89f67440210381c3ecaaa6af2d5ef1b13e4945  lib/index.js
8c878fc3da98aebbc07eed9b1862c7c7969d269c21a0e339f7d1fba607c6a4e6  lib/orchestrator.js
d4584016c3d696359a28748093a3be7b7211ca860999d48d966683f565280057  lib/promotion-include.js
96a4d458daa24ab19a11b848b0af45f74a17602a480e6854e4ee249dd5022a12  lib/registration.js
```

两棵树的差异只有 `lib/diagnostics.js`（前一次 `ecc59642…` → 最终 `7995c9e1…`）与
`lib/orchestrator.js`（前一次 `8cff41a9…` → 最终 `8c878fc3…`）：
`lib/diagnostics.js` 只被 `lib/index.js` 引用，本轮没有任何 harness 会加载它；
`lib/orchestrator.js` 只被两个 flush harness 用来在**fixture 构造阶段**调用
`signEventBridgeEnvelope`（计时区之外）。因此两遍计时区的代码逐字节相同。

### 1.1 前一次观测（保留，不覆盖）

第一遍冻结于 2026-10-25 20:51:27，`libTreeSha256 = 9392a80040e289875dd6685e99e2d10f81397b46e38f9349c9ff633a06536488`，
已不再描述仓库里的任何树，只作为对照数据留在 JSON 的
`sourcePin.previousObservation` 与 `raw.previousObservation`（含全部 41 个逐文件哈希）。

## 2. 环境与机器状态

Node `v26.12.1`、`darwin/arm64`、8 逻辑 CPU。所有子进程都带
`--max-old-space-size=4096`，父进程带 `NODE_OPTIONS=--max-old-space-size=4096`。
真后端：官方 `DomainFacility` + `JsonStorageBackend`，经 `openDomainStorage()`，
全部 fixture 是 `mkdtempSync` 里的合成数据。

**机器状态要说清楚：本遍的负载基线比第一遍高。** 采集期间没有任何其它基准或测试进程
（`ps` 里没有本仓库的 node 进程），但系统空闲负载本身更高：harness 序列开始/结束为
`1.97 2.15 1.78` → `1.89 2.13 1.78`，整遍前后为 `2.41 2.23 1.79` → `1.73 2.01 1.77`；
第一遍对应的起点是 `1.08 1.57 2.04`。高出来的是常驻守护进程（`mds_stores`、`loginwindow`、
T3 Code 渲染进程），不是竞争测量。逐步 load average 记录在 JSON 的 `runBoundaries.steps`。
因此**两遍的绝对毫秒只在量级层面可比**（见 §3.2 的 +3.4%），份额才是本文件要交付的东西。

## 3. 归因

### 3.1 `port.observe()`：0 与 256 个密封段

```sh
BENCH_SEGMENTS=0   BENCH_TRACE_IO=1 node --max-old-space-size=4096 scripts/benchmarks/domain-archive.mjs
BENCH_SEGMENTS=256 BENCH_TRACE_IO=1 node --max-old-space-size=4096 scripts/benchmarks/domain-archive.mjs
node --max-old-space-size=4096 scripts/benchmarks/archive-observe-attribution.mjs --segments 0   --samples 7 --expect-lib-sha256 b2ec5c63…
node --max-old-space-size=4096 scripts/benchmarks/archive-observe-attribution.mjs --segments 256 --samples 7 --expect-lib-sha256 b2ec5c63…
```

**两个负载里插件自己一次 `fsyncSync` 都没有调用，两遍都一样。**
`BENCH_TRACE_IO=1` 在 0 段与 256 段每样本都记到 `fsyncSync` 0 次、`cpSync` 0 次、
`copyFileSync` 0 次；归因脚本同样 0 次。原因是这两个 fixture 的 `observe` 不修改任何归档文件：
`changedArchiveFiles()` 返回空 → `staged = false` → `syncStage()` 不运行 →
`installArchiveFiles()` 什么都不发布。「每事务 8 → 3 次 fsync」只属于真的往活动归档追加的事务，
这两个被指定测量的负载碰不到它（§8）。

#### 256 个密封段

逐调用方归因（插桩；插桩因每次 fs 调用抓一次调用栈而使墙钟涨到 141.534 ms，
比未插桩的 130.917 ms 高约 8%，所以**份额按未插桩中位数计算，绝对毫秒只用于排序**）：

| 调用点 | 每事务调用次数 | 每事务耗时（最终树） | 占未插桩中位数（最终 / 前一次） |
| --- | ---: | ---: | ---: |
| `linkSync@lib/archive-stage.js:95`（`mirrorArchives` 把每个归档文件硬链接进暂存树） | 257 | 78.684 ms | **60.10% / 60.5%** |
| `rmSync@lib/domain-storage.js:695`（事务结束删掉整棵暂存树） | 1 | 10.957 ms | **8.37% / 8.7%** |
| `lstatSync@lib/archive-stage.js:49`（镜像 statOf 257 + `assertLiveTreeUnchanged` 257 + `changedArchiveFiles` 257 + 目录） | 773 | 5.165 ms | 3.95% / 3.9% |
| `readdirSync@lib/dockyard-domain/memory.js:1094`（`#archiveFiles()`，每事务 78 次） | 78 | 1.705 ms | 1.30% / 1.7% |
| `readdirSync@lib/archive-stage.js:63`（`walkArchives`） | 4 | 0.409 ms | 0.31% / — |
| `statSync@lib/dockyard-domain/memory.js:1027` | 36 | 0.264 ms | 0.20% / — |
| `writeFileSync@lib/archive-stage.js:165`（暂存清单） | 1 | 0.218 ms | 0.17% / — |
| 其余（`writeFileSync`、`renameSync`、`mkdirSync`、`readFileSync`、`closeSync` 等） | — | 0.683 ms | 0.52% / — |
| 同步系统调用合计 | — | 98.264 ms | 75.06% / 75.8% |
| JS + I/O 等待（含官方 backend 自己的持久化） | — | — | 24.94% / 24.2% |

80 次采样的 `--cpu-prof`（观测窗口 80 × 130.917 = 10473.4 ms，profile 总计 10800.9 ms）
按模块聚合同向印证：`link` 60.17%、`(idle)` 12.39%、`rmSync` 8.06%、
`lib/dockyard-domain/memory.js` 全部 JS 合计 4.99%、`lstat` 2.49%、`stat` 1.93%、
`readdir` 1.45%、`node:path` 1.14%、`lib/archive-stage.js` 自身 0.34%。
其中 `memory.js` 最大的一块是 `memory.js:1096` 的 O(n²) 去重（302.28 ms = 2.8%）与
`#reconcileArchiveIndex`（155.84 ms = 1.44%）。

#### 0 个密封段

| 项 | 每事务（最终树） | 占未插桩中位数（最终 / 前一次） |
| --- | ---: | ---: |
| `readdirSync` 全族 | 0.583 ms | 5.32% / 5.5% |
| 其中 `memory.js:1094` 的 76 次重复列表 | 0.502 ms | 4.58% / 4.7% |
| `linkSync` 1、`writeFileSync` 2、`statSync` 39、`rmSync` 1、`renameSync` 2、`openSync` 2、`readFileSync` 5、`mkdirSync` 1、`lstatSync` 5、`closeSync` 2 | 1.541 ms | 14.06% / — |
| 同步系统调用合计 | 2.124 ms | 19.38% / 19.6% |
| JS + I/O 等待 | — | **80.62% / 80.4%** |

200 次采样的 profile 里 `(idle)` 占 59.56%（前一次 61.3%）：这个负载大部分墙钟是等官方 backend
的写入落盘，不是 CPU。CPU 侧最贵的原生项是 `rename` 6.0% 与 `readdir` 6.0%
（前一次 3.8% / 6.2%；见 §4.1 对 `rename` 跨线的解释）。

### 3.2 20,000 条历史上的稳态 `flush()`

```sh
BENCH_EVENTS=20000 BENCH_SAMPLES=15 node --max-old-space-size=4096 scripts/benchmarks/domain-authentication.mjs
node --max-old-space-size=4096 scripts/benchmarks/domain-flush-ledger-attribution.mjs --side candidate --history 20000 --new-events 0 --samples 9
node --max-old-space-size=4096 scripts/benchmarks/domain-flush-ledger-attribution.mjs --side candidate --history 20000 --new-events 1 --samples 9
node --max-old-space-size=4096 scripts/benchmarks/domain-flush-history-cost.mjs --profile candidate --profile-scenario history-20000-new-1 --profile-out /tmp/flush20k-new1.cpuprofile
```

#### 无新事件（中位 8.804 ms / 15 次；前一次 8.829 ms）

阶段归因只有一个阶段非零：**`plan` = 10.12 ms，等于全部**（它比同一轮的墙钟中位数 9.99 ms 高
1.3%，那是 `performance.now()` 包夹本身的计时开销，不是另一个阶段）。
`planEventLogReplay()` 在这里做的是：`readEventLog()` 为验证存储的检查点把已消费的
10.5 MiB 前缀整个读一遍并做一次带 key 的 HMAC，然后 `checkpointAuthenticates()` 比对，
再加 `digestApplied()` 对 20,000 条标记表做序列化 + SHA-256。没有提交、没有文档写入、没有暂存树。

#### 追加 1 条新事件（中位 56.034 ms / 9 次，CPU 49.427 ms；前一次 54.169 ms）

| 阶段（插桩，嵌套计时） | 每 pass（最终树） | 占中位数（最终 / 前一次） |
| --- | ---: | ---: |
| `set.final`（`schema.parse(document)` + 官方 `global.set`） | 17.227 ms | 30.74% / 30.4% |
| `plan`（检查点读 + 全前缀 HMAC + `digestApplied`） | 9.973 ms | 17.80% / 18.2% |
| `merge`（`mergeEventLedger`） | 5.909 ms | 10.55% / 10.9% |
| `checkpoint.write`（`digestApplied` + `checkpointMac` + 写 + rename） | 5.117 ms | 9.13% / 9.3% |
| `copy.baseline`（`{ ...recovered }`） | 4.101 ms | 7.32% / 7.4% |
| `copy.replayLedger`（`{ ...domain.global.get().applied }`） | 3.956 ms | 7.06% / 7.2% |
| `memory.create` | 0.850 ms | 1.52% |
| `hydrate` | 0.637 ms | 1.14% |
| `snapshot` | 0.029 ms | 0.05% |
| 插桩区间之外（锁、`sameEventLedger`、commit token 等） | 8.235 ms | 14.69% / 13.8% |

**这一个负载的绝对值比前一次高 3.4%（54.169 → 56.034 ms），但被测代码逐字节相同**
（`lib/domain-storage.js`、`lib/event-log-checkpoint.js` 在两棵树上一样），
同期 load average 从 `1.48 1.51 1.93` 升到 `1.89 2.13 1.78`，且 CPU 只从 49.094 到 49.427 ms（+0.7%）。
所以这 3.4% 是运行间/机器差异，不是代码差异；两遍的份额几乎一样（见上表两列）。

6 次 pass 的 CPU profile 自时间前几名（最终树 / 前一次）：
`digestApplied` 12.69% / 13.7%、`hash.update` 11.35% / 12.8%、
`inst._zod.parse`（zod）11.77% / 12.5%、`mergeEventLedger` 8.75% / 8.9%、
`mutate` 7.15% / 6.4%、`commit` 6.76% / 4.8%、官方 JSON backend 的 `serialize` 6.36% / 7.2%、
`post`（inspector）6.27% / 6.4%、`sameEventLedger` 4.73% / 4.8%、`toJsonProjection` 0.8%。

本遍用 profile 的 `positionTicks` 把两个帧钉到了具体行，这对 §4 的映射是补强而不是改判：

| 帧 | 自时间 | 命中行 | 该行 |
| --- | ---: | ---: | --- |
| `mutate`（`domain-storage.js:595`） | 27.09 ms | 614 | `const baseline = { applied: { ...recovered }, ... }` = 阶段表里的 `copy.baseline` |
| `commit`（`domain-storage.js:750`） | 25.61 ms | 760 | `const ledger = { ...domain.global.get().applied };` = 阶段表里的 `copy.replayLedger` |

也就是说 profile 里的 `mutate`/`commit` 与阶段表里的两次整表复制是同一件事的两种测法，
不存在"未被映射的 ≥5% 项"。

## 4. 每个 ≥5% 的项对应哪条已关闭方向

| 被测项 | 最终树占 | 为什么它不是本轮的新候选 |
| --- | --- | --- |
| 镜像 `linkSync` 60.10%、阶段 `rmSync` 8.37% | observe-256 的 68.47% | `archive-stage-io.md` §6 第 1 行「复用上一笔事务的暂存目录」与第 2 行「暂存树只放可写文件、密封段直接读 live」。前者要求 `domain-staging/` 在事务之间保留目录，而「事务结束后暂存为空」是既有不变量（`test/domain-storage/archive-stage.test.js`、`test/storage-transaction-applied-ledger.test.mjs`、doctor 的 `domain-orphan-staging` 都依赖它）；后者要在 `EvolutionMemory` 里加第二根基解析，等于第二套解析/事务机制。 |
| `set.final` 30.74% | flush-20k-1new | 标记表本来就是文档的一部分（改它就是改持久化格式）；`inst._zod.parse` 是对外发布前的校验，`domain-hotpath-20261024.md` §1 用四种"原地改坏 live 文档"的反例证明入口/发布校验不能跳；`serialize` 是官方 `JsonStorageBackend` 的行为。 |
| `plan` 17.80%，以及无新事件负载的 ≈100% | flush 两侧 | `event-log-read-chunks.md`（块尺寸 1 MiB→4 MiB 已被跨块读取反例击穿）、`domain-flush-digest-cache.md` 与 `domain-flush-digest-protected-reuse-gate.md`（任何每次调用都发生的 crypto 操作都不可省）。 |
| `merge` 10.55% + `copy.baseline` 7.32% + `copy.replayLedger` 7.06% | flush-20k-1new 的 24.93% | `domain-hotpath-20261024.md` §2：`marker-table-special-keys` 钉住了"入口 parse 读一次、baseline 独立副本读一次、调用方表再读一次"的 A,A,B 顺序，以及 merge 对冲突 / prototype 名 / accessor 的判定；baseline 副本不能与 merge 目标合并。（profile 里的 `mutate` 7.15% / `commit` 6.76% 就是这两次复制，见 §3.2 的 `positionTicks` 表。） |
| `checkpoint.write` 9.13% | flush-20k-1new | 内容是一次 `digestApplied` + 一次 `checkpointMac`，属于已关闭的「每次调用的 crypto」；它的 fsync 已经在 `f89221f` 里去掉。 |
| `sameEventLedger` 4.73% | flush-20k-1new | 未达门槛，而且它就是决定"能否发布这次提交"的 CAS 比较；削弱它是授权边界改动。 |

`closure.md` 点名的另外两块（长事件历史逐步认证、启动内存）本轮没有重新归因：
它们在 `closure.md` 里已被判定需要协议变更，而 §3.2 的第一段（无新事件的 pass 100% 花在 `plan` 上、
规模随历史字节线性增长）独立复现了同一结论，任何省掉那次全量 HMAC 的方案都属于已关闭的
增量认证协议方向。

### 4.1 两遍之间 ≥5% 项的出现与消失

**观察表与阶段表里没有出现或消失任何 ≥5% 项。** 逐项对比：

- 保持 ≥5%：observe-256 `linkSync` 60.5 → 60.10、`rmSync` 8.7 → 8.37；
  observe-0 `readdirSync` 全族 5.5 → 5.32；flush `set.final` 30.4 → 30.74、`plan` 18.2 → 17.80、
  `merge` 10.9 → 10.55、`checkpoint.write` 9.3 → 9.13、`copy.baseline` 7.4 → 7.32、
  `copy.replayLedger` 7.2 → 7.06；flush-0new `plan` 100 → ≈100。
- 保持 <5%：observe-256 `lstatSync` 3.9 → 3.95；observe-0 那 76 次重复列表 4.7 → 4.58；
  flush `sameEventLedger` 4.8 → 4.73。
- **向下跨线一处**：`lib/dockyard-domain/memory.js` 的**整个模块 JS 合计**从 5.2% 落到 4.99%。
  这是一个多帧聚合，不是一处改动；它最大的成员（`memory.js:1096` 的 O(n²) 去重）只从 2.9% 到 2.8%。
  没有可执行的含义。
- **向上跨线两处，都不改变裁决**：
  1. observe-0 profile 的 `native:fs:rename` 3.8% → 6.0%。它是官方 `JsonStorageBackend` 的
     promise 式原子替换，不是插件代码——插件的同步 `fs.renameSync` 每 pass 只有 0.188 ms
     （10.961 ms 墙钟的 1.72%）。在一个只有 1588 个采样、总长 10.961 ms 的窗口里，
     原生份额在运行间本来就会漂 1–2 个点。不可改：官方 backend + 承载持久性的替换。
  2. flush profile 的 `commit` 帧 4.8% → 6.76%。`positionTicks` 显示全部命中在
     `lib/domain-storage.js:760`，也就是 `copy.replayLedger`（7.06%），本来就在 §4 的
     A,A,B 映射里，因此这次跨线不带来任何新方向。
- **结构对照**：两棵树的函数调用次数完全一致——256 段 257 `linkSync` / 1 `rmSync` /
  773 `lstatSync` / 82 `readdirSync`，0 段 76 次列表，两遍都是 0 次 `fsyncSync` 与 0 次 `cpSync`。
  这是"两遍测的是同一台机器上的同一机制"的检查。

## 5. 候选筛选：为什么一个都没有

筛选门槛（任务给定）：不改变持久化格式、锁/事务协议、承载持久性的 fsync、官方宿主 API、
任何认证/校验步骤，并且在一份**本轮可以测量**的负载上有至少 5% 的端到端影响。

对照 §3：256 段 observe 只有镜像与清理两个 ≥5% 项（都是已关闭方向）；
0 段 observe 最大的是一族 `readdirSync` 5.32%（去掉它必须缓存段目录列表，
而缓存必须被事务自身的段轮转失效，漏一次就静默丢一个冷段）；
flush 两侧所有 ≥5% 项都落在 §4 的已关闭方向里。**因此两遍都不存在合格候选。**

### 5.1 最近但不足的三项（记录数值，明确不上生产）

1. **`#archiveFiles()` 的 O(n²) 去重**（`lib/dockyard-domain/memory.js:1096`：
   `[...names.map((name) => join(directory, name)), path].filter((file, index, files) => index === files.indexOf(file))`）。
   最终树 256 段时 302.28 ms / 80 次采样 = 3.78 ms/pass，占 **2.8%**（前一次 2.9%）；0 段时 0%。
   它与 `[...new Set(list)]` 完全等价（元素是字符串，SameValueZero 与 `===` 对字符串一致，
   首次出现顺序也一样）。**不做的原因**：2.8% 单独达不到 5%。
2. **每事务 76–78 次重复 `readdirSync` 段目录**（最终树 0 段 0.502 ms = 4.58%，256 段 1.30%）。
   要省掉重复就得在一个 `EvolutionMemory` 实例内缓存列表，而这个事务自己会**轮转出新的段文件**；
   漏一次失效就会让冷历史扫描静默少一个段（丢记录）。把整族（列表 + O(n²) 去重 + `statSync`）
   加起来也只有最便宜那个负载的约 6.5%、256 段负载的 4% 出头，达不到"在真正重要的负载上 5%"。
3. **`sameEventLedger`** 4.73%：未达门槛，且是 CAS 授权判断。

三项都没有实现、没有测量 A/B、没有进 `lib/`。写出数值是为了让下一轮不必重新归因。

## 6. 预注册的验收规则（本轮未被使用）

本轮没有任何候选进入测量阶段，所以下面这条规则没有被任何数字使用过。它的写入时间晚于
§3.1 与 §3.2 的归因（第一遍），早于任何候选选择，之后在重跑本遍时没有被修改：

> 只有在下列条件**全部**成立时才保留改动，且在真实官方 backend 上用同一负载交替 A/B、
> 基线侧通过在工作副本上施加补丁的逐字节逆补丁重建：
> （1）端到端墙钟收益 ≥3%，且各轮区间不重叠；
> （2）A/B 差值大于同一会话内测得的同码 A/A 对照漂移；
> （3）峰值 RSS 与堆不变差；
> （4）语义等价由逐字节差分比较证明，并至少有一个本人设计的、以击穿该候选为目标的对抗反例。
> 否则把 `lib/` 还原成逐字节相同的基线，并在文档里连同反例一起记录撤回。

**裁决：仍未触发**（第一遍与本遍都没有候选进入测量阶段）。没有候选通过 §5 的门槛，因此没有 A/B、没有 A/A 对照、没有内存结论；
生产代码不变。本轮也**没有**声称任何收益数字。

## 7. 验证

```sh
# 本遍开始前
git diff -- lib/ | shasum -a 256
# 05ee32e9b83bb8d3fd5e9bbe50cb26328bac273684c0ecb5737ca148ba472fb8
git status --porcelain -- lib/
#  M lib/diagnostics.js
#  M lib/dockyard-domain/knowledge.js
#  M lib/domain-storage.js
#  M lib/orchestrator.js     ← 只有另外两个 worker 的四个文件
cd lib && find . -type f -name '*.js' | sort | xargs shasum -a 256 > /tmp/final-lib-pre.sha256
shasum -a 256 /tmp/final-lib-pre.sha256
# b2ec5c63522097fe491916bb698481d19f9930b0392633611c05edd85b1eff15

# 本遍结束后（同样三条命令重跑）
# git diff -- lib/ 的 SHA-256 仍是 05ee32e9…
# /tmp/final-lib-post.sha256 的 SHA-256 仍是 b2ec5c63…，与 pre 逐行 diff 为空
# git status --porcelain -- lib/ 仍是同样的四行
```

本遍新增/修改的文件只有：
`docs/performance/archive-transaction-attribution-20261025.md`、
`docs/performance/archive-transaction-attribution-20261025.json`。
归因脚本 `scripts/benchmarks/archive-observe-attribution.mjs` 与第一遍完全相同，未改。
没有动 `release/`、`package.json`、`scripts/release/`、`docs/evidence/`，没有删改任何既有未跟踪文件，
没有改任何测试，没有提交或推送。
没有跑 `npm test`（本遍不涉及产品代码与测试改动，且 `lib/` 是四个文件的未提交工作树状态，
全量套件的 `release-pin` 用例本来就会因未提交的分发内容失败）。没跑宿主验收。

## 8. 真正没测到的部分

- **真的往活动归档追加的事务**（`files.length > 0`，会跑 `syncStage()` + `installArchiveFiles()`
  + 3 次 fsync）两遍都没有覆盖：被指定的两个 observe 负载都产生空变更单。
  `archive-stage-io.md` 测的是 `f89221f` 之前的形态（当时每事务 8 次 fsync），
  所以这条写入路径在**当前代码**上的每事务成本仍然只有旧归因，没有重新推导。
- 官方 `JsonStorageBackend` 自己的持久化调用（`fs.promises` 的 handle sync）算在墙钟里，
  在 profile 里表现为原生 `rename`/`open`/`fsync`，但没有逐项归因。
- 物理磁盘字节数、冷页缓存、非 APFS 文件系统、其它平台都没有测。
- 生产到达分布没测：真实 agent step 里"0 条 / 1 条 / N 条新事件"各占多少、
  真实归档事务多久才改一次文件，全都未知。本文件所有份额都以 fixture 为条件。
- 峰值内存两遍都没有测；因为什么都没改，也没有内存结论要下。
- 被测的是一棵**工作树**（HEAD + 四个未提交改动），不是一个提交。
