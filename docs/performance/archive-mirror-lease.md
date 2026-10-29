# 归档事务：把密封段目录从「每个文件一个硬链接」换成一次借用

## 0. 结论

本轮改动三处源码（`lib/archive-stage.js`、`lib/domain-storage.js`、`lib/dockyard-domain/memory.js`），
把普通归档事务里与**历史规模成正比**的重复工作去掉：

| 历史规模（`cycles` 的密封段数） | 基线每次 `port.observe()` | 本轮 | 变化 |
| ---: | ---: | ---: | ---: |
| 0 | 12.427 ms | 12.543 ms | +0.93%（同码 A/A 漂移 ±2.9%，见 §5） |
| 64 | 44.077 ms | 14.400 ms | **−67.33%** |
| 256 | 138.676 ms | 19.786 ms | **−85.73%** |
| 1024 | 514.209 ms | 39.995 ms | **−92.22%** |
| 4096 | 2021.425 ms | 125.440 ms | **−93.79%** |

同一组采样里 CPU 中位数分别变化 −2.42% / −74.98% / −88.31% / −92.88% / −93.55%，
保留堆（`heapUsed + external`，强制回收后）在每个 ≥64 段的规模上都更低或持平。
一次 4096 段事务的系统调用归因：

| 每笔事务 | 基线 | 本轮 |
| --- | ---: | ---: |
| `linkSync` | 4097 次 / 1286.0 ms | **1 次 / 0.36 ms** |
| `rmSync`（暂存树清理） | 1 次 / 166.5 ms | **1 次 / 0.27 ms** |
| `lstatSync` | 20600 次 / 105.3 ms | 16510 次 / 42.3 ms |
| `readdirSync` | 88 次 / 31.9 ms | 10 次 / 12.3 ms |
| 异步 `stat`（线程池往返） | 16420 次 / 233.5 ms | **36 次 / 1.4 ms** |

三类改动分别对应任务里的「重复镜像」「重复遍历」「重复清理」：暂存树不再为每个密封段写一个
硬链接，`#archiveFiles()` 不再为每个不存在的段目录做一次 `readdir`，索引核对不再把同一棵
目录树用线程池 `stat` 再走一遍。

## 1. 为什么可以不用逐文件镜像

`archive-stage.js` 的暂存树必须满足三件事：事务读到的归档与已提交的完全一致；事务写入的
每个字节都属于暂存树；提交后只安装真正改动过的文件。旧实现用「每个归档文件一个硬链接」
同时满足三者，于是每笔事务都要为**所有**密封段付一次 `link`（本机 ≈ 0.31 ms/次，4096 段
≈ 1.29 s）和一次 `rm`。

密封段按协议是不可变的：它由 `rename` 产生，之后只被读取、被整体目录替换，绝不会原地追加。
因此这个目录的**条目集合**不需要逐条镜像，只需要一个「指向 live 目录的借用」：

- 根层归档文件（活动归档、quarantine、索引文档）仍然写一个硬链接：它们可能被原地写，
  写前由 guard 私有化。
- 每层嵌套目录在暂存树里是一个指向 live 目录的符号链接（借用），事务透过它读到已提交的
  字节；读路径与原实现读到的是同一个 inode，读取成本与文件数无关。
- 快照仍然记录**每个**归档文件的 `dev/ino/size/mtimeNs`，无论暂存树是否为它建了条目。
  删除协议、隔离证明都写在快照上，因此不受影响。

借用是只读的，而且不是靠约定保证：

1. 事务第一次要往借用目录里写之前，`privatizeArchiveFile()` 先把借用换成一份真实目录，
   其中每个文件是 live 文件的硬链接——视图不变、身份不变，但新目录归本事务所有。
   `#sealArchive()` 在写 `temporary` 之前调用同一个 guard，所以轮转产生的段落在暂存树里。
2. `assertLiveTreeUnchanged()` 除了逐个文件比对，现在还比对**借用的目录本身**：
   同一 inode、同一 mtime。目录的 mtime 只在条目被创建/改名/删除时改变，读不会改变它，
   所以这证明「借用仍然展示已提交的段集合」。有写入穿透借用时会在这里响亮失败，而不是
   被当成事务自己的改动安装出去。
3. `removeStage()` 在递归删除之前先把指向目录外部的条目 unlink 掉，所以清理从不跟随借用。

暂存树因此仍然是「已提交归档的完整视图」，`changedArchiveFiles()` 的删除推导一字未改：
某个段之所以是删除，仍然因为它出现在快照里、却不在暂存树里（压实整目录替换的结果）。

借用记录（`<stage>/.archive-borrowed.json`，与既有的 `.archive-files.json` 同层）是自我声明的，
不是外部开关：`inspectArchiveIntegrity()` 只跟随**被这份记录点名**的段目录链接，没有记录的
链接（以及 live 树上任何链接）仍然报 `archive-segment-directory-unreadable`。记录里的路径相对
暂存根，所以它与数据根位置无关；没有借用时（绝大多数事务）根本不写这个文件。

## 2. 另外两处重复工作

**索引核对重走同一棵树。** `#reconcileArchiveIndex()` 先调用 `inspectArchiveIntegrity()` 把每个
归档文件 `lstat` 一遍并记下 `byteSize`，随后又对同一批文件做两次线程池 `stat`（判 `isFile()`、
取 `size`）。后者 100% 是前者已经付过的账：现在直接复用分类结果里的记录，只有分类阶段没能
`stat` 的文件才单独探一次，因此「缺失/不可读归档」的报错行为不变。4096 段时这一项从
16420 次异步 `stat` 降到 36 次。

**段目录列表在一个实例内被反复枚举。** 一笔事务里 `#archiveFiles()` 会被调用几十次
（索引加载、索引核对、`hasColdHistory`、字节统计），每次都是 `readdir` + 全量排序。现在按
集合缓存列表，校验条件是**目录自身的身份**（`dev/ino/mtimeNs`：条目增删改名都会改 mtime，
整目录替换会改 inode），并且本实例自己轮转或替换目录时立即丢弃缓存——所以即使目录时间戳
粒度很粗，也看不见自己的轮转会立即失效的那条边界并不存在。目录不存在（多数集合从没密封过）
同样是缓存答案，不再每次做一次必然失败的 `readdir`。

## 3. 变更位置

| 文件 | 变更 |
| --- | --- |
| `lib/archive-stage.js` | `mirrorArchives()` 返回带 `files`/`directories` 的镜像快照；嵌套目录建借用、根层文件建硬链接；新增 `materializeLinkedDirectory()`（写前私有化）、`recordBorrows()`、`STAGE_BORROWS`、`removeStage()`（按镜像决定是否先扫一遍 unlink）；`walkArchives()` 增加 `directories`/`linked` 两个选项（默认行为不变）；`assertLiveTreeUnchanged()` 增加目录身份比对；`changedArchiveFiles()` 不再把借用下的文件当删除；`inspectArchiveIntegrity()` 只跟随记录在案的借用 |
| `lib/domain-storage.js` | `mutate()` 用新的镜像快照；guard 传 `live`；stage 清理走 `removeStage(path, mirror)`；恢复路径（阶段没有镜像）走 `removeStage(path)`（扫描） |
| `lib/dockyard-domain/memory.js` | `#sealArchive()` 在写段临时文件前调用 guard（并丢弃该集合的列表缓存）；`#rewriteArchives()` 丢弃被替换集合的缓存；`#archiveFiles()` 按目录身份缓存列表；`#reconcileArchiveIndex()` 复用分类结果 |

公开 API 只增不改：`mirrorArchives()` 的返回值从 `Map` 变成镜像快照对象，因此
`privatizeArchiveFile({ directory, snapshot, privatized, file })` 这个**发布版的调用形状仍然可用**
（`snapshot` 就是镜像快照，`live` 从 `snapshot.live` 取得）。这一点是必须的：
`test/domain-storage/domain-storage-baseline.js` 会把 rc.8 的 `domain-storage.js` 还原出来，
和当前的 `archive-stage.js` 一起加载做差分。

## 4. 等价性

`--validate` 让两侧各跑同一份合成工作负载（冻结 `Date`、冻结 `crypto.randomUUID` 序列，只把
各自数据根路径归一化成 `<root>`，因为聚合里记录的绝对暂存路径本来就属于夹具而不是事务），
然后逐字节比较：`dockyard/` 下每个归档文件、提交的 `evolution_domain.json`、四个集合的
查询投影、以及密封段文件名集合。

```sh
node --max-old-space-size=4096 scripts/benchmarks/archive-mirror-lease.mjs \
  --baseline-ref 62a6eb6 --segments 0,64,1024,4096 --validate \
  --out docs/performance/archive-mirror-lease-equivalence.json
# 同码对照（两侧都跑当前树）
node --max-old-space-size=4096 scripts/benchmarks/archive-mirror-lease.mjs --aa \
  --segments 0,64,256,1024,4096 --samples 7 --rounds 3 \
  --out docs/performance/archive-mirror-lease-aa.json
```

结果：0 / 64 / 1024 / 4096 段四档全部逐字节一致（原始记录见
[`archive-mirror-lease-equivalence.json`](archive-mirror-lease-equivalence.json)）。

行为层面的等价由既有测试继续钉住，另外新增了两组回归：

- `test/dockyard-domain/archive-listing-memo.test.mjs`（3 项）：外部新增的段必须被看到；
  本实例自己轮转出的段即使目录时间戳显示不出来也必须被列出；整目录替换后必须从新目录读。
- `test/storage-transaction-archive-publish.test.mjs` 新增/改写 4 项：借用只占一个条目、
  借用下 64 个段仍然全部可见且不是变更、`assertLiveTreeUnchanged()` 拒绝借用下新增的条目、
  `removeStage()` 不会删掉 live 目录、没有记录的链接不被 inspector 跟随。

`test/domain-storage/archive-stage.test.js` 的「共享 live inode」用例改成按可见 inode 断言
（借用的路径仍然解析到同一个 inode），轮转用例新增「live 段目录没有新增条目、mtime 未变、
暂存目录已被私有化、只有本事务产生的段进入变更清单」。

## 5. A/B 数据与噪声地板

同一脚本、同一负载，两侧各自 checkout、独立进程、独立临时数据根，逐轮交换先后顺序，
3 轮 × 7 样本取中位数（原始数据 [`archive-mirror-lease.json`](archive-mirror-lease.json)）。
基线是改动前的 `main` 提交 `62a6eb6`（下面的命令在测量时写的是 `--baseline-ref HEAD`，
JSON 里也记为 `HEAD`；该提交就是当时的 HEAD）：

```sh
git log --oneline -1 62a6eb6      # 62a6eb6 Merge pull request #7 ...
node --max-old-space-size=4096 scripts/benchmarks/archive-mirror-lease.mjs \
  --baseline-ref 62a6eb6 --segments 0,64,256,1024,4096 --samples 7 --rounds 3 \
  --out docs/performance/archive-mirror-lease.json
```

同码 A/A 对照（两侧都跑本轮代码，测的是方法本身的分辨率，
[`archive-mirror-lease-aa.json`](archive-mirror-lease-aa.json)）：0 段 −2.94%、64 段 +3.77%、
256 段 −0.30%、1024 段 −1.43%、4096 段 −0.65%。换成 9 轮 × 15 样本时 0 段 +0.26%、64 段 −1.51%。
所以：**0 段那一档的变化在噪声之内，不能说有收益，也不能说有回退**；64 段起的收益远超噪声。

只看空档案（0 段）这一档，本轮最初确实慢 5.7%（每笔事务多两次目录扫描、`stat` 与一次
失败的 `unlink`）。定位后按三处消掉：`removeStage()` 在没有借用时跳过预扫、
`#archiveFiles()` 缓存「没有段目录」这个答案、`recordBorrows()` 不再写空记录。改完即为上表
的 +0.93%（且在 A/A 噪声内）。

**轮转（封段）事务。** 0 段负载测不到封段。另跑一档：1024 个已有密封段 + 9 MB 活动归档
（超过 8 MiB 轮转目标），先跑 60 笔事务把热窗推过上限，再测 7 笔
（[`archive-mirror-lease-rotation.json`](archive-mirror-lease-rotation.json)）：

| | 基线 | 本轮 |
| --- | ---: | ---: |
| 稳态每笔（60 笔热事务中位数） | 517.1 / 517.6 / 519.0 ms | 44.3 / 45.2 / 44.8 ms |
| 第 50 笔（发生封段） | 653.1 / 649.7 / 651.2 ms | 153.6 / 155.4 / 151.5 ms |
| 封段后是否产生新段 | 1 | 1 |

封段那一笔要先把借用目录物化（该集合一次 `link` 镜像），所以它比同侧稳态贵约 108 ms；
基线同一笔贵约 131 ms。即便付出这次物化，本轮封段事务仍比基线的**普通**事务快约 4.2 倍。
封段每次只物化一次（之后该目录已属于本事务），而基线每笔事务都为全部密封段付一次镜像。

## 6. 收益边界

- 收益来自「每笔事务按文件数付的固定成本」被去掉，因此只在**已经积累了大量密封段**时显著；
  64 段约 −67%，4096 段约 −94%。没有密封段时没有可测收益（变化在噪声内）。
- 绝对值依赖本机系统调用成本（本机 `link` ≈ 0.31 ms、`lstat` ≈ 4 µs，明显慢于常见主机）。
  可移植的结论是**调用次数**与**被删除的工作**：每笔事务少 4096 次 `link`、1 次 4096 条目的
  递归删除、8192 次异步 `stat`、76 次目录枚举。
- 段数越多、单笔事务越快，收益占比越大；当事务被其它成本（例如 9 MB 活动归档的解析）主导时，
  比例会下降，但绝对值仍按文件数下降。
- 未测：冷页缓存、网络文件系统、其它平台、真实生产到达分布（每次 step 有几条新事件、
  多久封一次段）、以及真实宿主上的端到端验收。物理磁盘写入总量本轮也没有测。
- 峰值 RSS：强制回收后本轮的保留堆在每个 ≥64 段规模都更低或持平；**不强制**回收时，
  由于事务快了十几倍、单位时间分配量更高，V8 会选择更大的堆高水位，而本机（macOS）不会把
  已回收的页还给系统，于是 `maxRSS` 可能更高（4096 段一次 25 样本观察到 133 → 228 MiB）。
  同一次运行里强制回收后两者都是 15–21 MiB，堆快照总量 23.6 vs 23.7 MiB，所以这不是保留内存
  的差异，是 GC 调度与平台行为。原始数据保留了两种读数。

## 7. 验证

```sh
NODE_OPTIONS=--max-old-space-size=4096 npm test        # 1230 项
npm run pack:check                                     # 分发内容与固定点关系
node --max-old-space-size=4096 scripts/benchmarks/archive-mirror-lease.mjs --baseline-ref 62a6eb6 --validate
```

本轮实际执行（都带 4 GiB 堆上限）：

| 检查 | 结果 |
| --- | --- |
| `npm test`，Node `v26.12.1` | 1230 / 1230，0 skipped |
| `npm test`，Node `v22.23.4`（`node@22`） | 1230 / 1230 |
| `npm test`，Node `v24.22.1`（`node@24`） | 1230 / 1230 |
| `npm run pack:check` | 16 项通过，报告本树是固定产物的**已提交后继** |
| `--validate`（0/64/1024/4096 段） | 四档逐字节一致 |
| A/B、A/A、轮转 | §5 各项 |

没有跑真实宿主验收：本轮不改宿主接口、不扩展 `peerDependencies`、不更新发布固定点。
`release/`、版本号、`README.md`、`CHANGELOG.md` 未改动。

## 8. 剩余风险

- **借用目录的只读性靠两道检查，不是内核保证。** 写穿借用会改 live；目录身份检查会在提交前
  抓住它（新增条目看 mtime，原地改写看文件 `mtimeNs`），但它是在事务**结束时**才报错，不是
  阻止。真正阻止写入的是 guard：`#sealArchive()` 与所有原地写都在写前调用它。若将来有人新增
  一条不经过 guard、直接往段目录里写的路径，第二道检查会响亮失败而不是静默安装。
- **借用记录是新的暂存形态。** 崩溃留下的暂存目录里可能有一个符号链接。恢复只安装
  `pending.files` 里列出的文件（文件永远不在借用中，因为写前已物化），所以恢复不读借用；
  `removeStage()` 与 doctor 的 `domain-orphan-staging` 都会把它连同目录一起删掉。既有用例
  「事务结束后暂存目录为空」仍然成立。
- **`#archiveFiles()` 的一个窗口收窄了：** 段目录在某个实例存活期间被**外部**创建时，该实例
  在下一次从目录变化（本实例自己的封段/压实）之前不会看到它。数据根独占本来就是显式前提
  （跨进程锁），而本插件创建段目录只有 `#sealArchive()` 与 `#rewriteArchives()` 两条路径，
  两者都会丢弃缓存。外部**修好**已有目录（条目增删）仍然被目录身份立即发现。
- **`inspectArchiveIntegrity()` 现在会跟随「被记录点名的」段目录链接。** live 树上没有这种记录，
  所以 live 的诊断行为不变；但一个手工伪造了 `.archive-borrowed.json` 的暂存目录会被跟随。
  伪造者需要能写暂存目录（0700，事务私有），代价与直接写 live 数据根相当。
- **封段事务的物化成本按该集合的密封段数线性增长**（每笔封段一次）。段数极多时这一笔会变慢，
  但它仍然远低于基线同一笔的成本，且不影响其它事务。
- `test/domain-storage/domain-storage-baseline.js` 的反转表为本次三处 `domain-storage.js`
  改动补了 6 对，仍然把工作树还原成 rc.8 的发布源码逐字节一致。`lib/dockyard-domain/memory.js`
  的差分锚点是冻结夹具 `test/fixtures/memory-pre-archive-row-window.js`，本轮改动不进入那张表。
- 本轮没有提交或推送任何远端内容，没有更新 `release/`、版本号或发布固定点。
