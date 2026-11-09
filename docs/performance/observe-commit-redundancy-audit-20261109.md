# 高频 observe 持久事务路径的重复计算审计（2026-11-09）

基线：`main` 的 `b690fe0`（已合并 PR #35 的扫描备忘续证）。本文是**只读审计**：
没有运行基准脚本、没有运行测试、没有改 `lib/`。所有数字都取自仓库已发布的基准数据与
文档（不重跑），出处逐条注明；所有行号对 `b690fe0`。

审计对象是「一次触发归档的高频故障观测」走的持久事务：
`port.observe()` → `mutate()` → `installPending()`（恢复检查）→ `mirrorArchives()` →
暂存 `Memory` → `work()`（追加、驱逐、归档）→ `changedArchiveFiles()` →
`syncStage()` → 发布 pending 记录 → `installPending()`（校验＋安装）→ 收尾写 →
`publishArchiveScanSeeds()` → `hydrate()` → 观察者读 `autonomousObservations()`。

数字口径（数据文件均未重跑）：

| 记号 | 来源 | 说明 |
| --- | --- | --- |
| `attr:<phase>` | [`observe-transaction-digest-walk-20261107.attribution.json`](observe-transaction-digest-walk-20261107.attribution.json) | 基线 `c2c8d2e` 的 10 步阶段归因；`installPending/changedArchiveFiles/schema.parse` 等阶段不受之后两轮已接受改动影响，仍可作为量级参照。单位 ms/step。 |
| `io:` | [`observe-scan-memo-continuation-20261109.json`](observe-scan-memo-continuation-20261109.json) | 当前工作树的逐次系统调用计数（每 `port.observe()` 一次），含 `fsyncSync=5`、`handle.sync=4`、`handle.writeFile=2`。 |
| `wall:` | 同上 / [`observe-transaction-digest-walk-20261107.md`](observe-transaction-digest-walk-20261107.md) | 当前树 20,000 条时 `chain` 中位数 81.98 ms，`port` 65.52 ms（20261109 文档 §4）。 |

## 0. 结论摘要

| 方向 | 是否可证明的重复 | 每事务重复次数 | 约束下可消除？ | 预估量级（20,000 条） | 历史状态 |
| --- | --- | --- | --- | --- | --- |
| A 安装二次 read+sha256 | 是，同一 staged inode 读两遍哈希两遍 | 每个 changed 文件 2×；删除条目再 2× | **否**（元数据围栏＝削弱内容认证；同进程窗口无法排除） | ≤ `attr:installPending.installFiles` 7.58；读+哈希约 2.5–3 ms（≈3%） | 20261107 §4 边界记录，未采纳（当时未分别计时） |
| B 把 memory 已证摘要传给 changedArchiveFiles | 摘要存在但**形态不同** | 活动档案 1× | **否**（原始字节 vs 解码文本；跨模块信任通道；失败变成不可恢复的 pending 拒绝） | ≤ `attr:mutate.changedArchiveFiles` 2.63（≈2.5%） | 未见历史提案；不可采用 |
| C 两次实例级内容证明读同一批 inode/字节 | 是（跨实例读同一批 sealed inode/字节）；实例内活动档案再读一次 | sealed 文件 2×；活动文件共 4 次读同一新 inode | 跨实例：**否**（§4 已撤回）；实例内：**否**（复制后的内容证明不可换元数据） | 两次证明合计 32.51（≈39% mutate，≈32% 单步墙钟）；实例内重复约 2–2.5 ms | 跨实例＝20261107 §4 已撤回方向 |
| D pending 与收尾两次全量文档写 | 是：新 aggregate 内容序列化 2 次；committed 内容 1 次（并作为新 aggregate 的前缀再出现一次） | 2 次整份文档写 / 3 个 aggregate 等价序列化 | **否**（改成增量/省略＝pending 不再自足，削弱恢复语义） | `attr:pendingSet` 8.09 + `attr:installPending.finalSet` 7.14；可省 CPU 约 1–1.5 ms | 未尝试；与 `redundant-work.md` §4.2 同类风险 |
| E fsync 同目标重复同步 | **否** | — | 无可消除项（9 次同步各自对应独立耐久义务） | — | [`domain-derived-fsync.md`](domain-derived-fsync.md) 已删掉真正可删的两处派生 fsync |
| F `schema.parse` / `stableJson` / `aggregateDigest` | `schema.parse` 3 次调用＝5 个 aggregate 投影；`stableJson`/`aggregateDigest` 常规路径 0 次 | parse 5 投影；摘要仅 CAS 冲突路径 | **否**（三处 parse 各有独立失败边界与回归；identity-skip 已否决） | `attr:installPending.parse` 0.56（2 次/步）；合计约 1–1.5 ms | identity-skip 于 2026-10-24 否决；§4.1/§4.2 已撤回 |

一句话：**高频事务里确实存在成倍的文件读取与序列化，但每一处重复都压在一个明确的
不变式上；能证明可以安全去掉的只有已经被前几轮去掉的那些，本轮没有找到满足约束的新
消除项。** 逐项证据如下。

## 1. 一次 observe 事务实际读/写/同步了什么

以下计数由源码静态推导，并用已发布的 `io:` 计数交叉核对。活动档案 20,000 条时约
4.66 MB（由 `readFileSync` 9.32 MB ≈ 2 × 活动文件得出：`changedArchiveFiles` 与
`installArchiveFiles` 各读一遍同一 staged inode）；sealed 段的数量与总字节在本数据
里没有单独分解，只有「每个实例要把整个冷档案读一遍」这一事实（两次内容证明合计
32.5 ms）。`io:openSync=23` 同时包含内容证明的文件打开与 5 次 fsync 前的打开，不能
反推文件数。

| 文件 | 每事务读取 | 说明 |
| --- | --- | --- |
| 活动档案（privatize 前 inode X） | 1×，解码文本 SHA-256 | 暂存实例第一次 `#archiveRead()` 的内容证明（`memory.js:1741`，由 `#sourceMatches` `memory.js:4219`/`4223` 触发） |
| 活动档案（privatize 后 inode X′） | 4×：前缀证明 1、`changedArchiveFiles` 1、`installArchiveFiles` 1、live 实例内容证明 1 | 前缀证明 `#archivePrefixDigest`（`memory.js:1656`，由 `#extendArchiveReadCache` `memory.js:1564` 调用）只哈希前缀但读到文件尾；后两者只哈希、不物化；最后一个是提交后 live 实例的第一次 `#archiveRead`。live 读的是安装发布的 inode：`link+rename` 成功时就是 X′，copy fallback 时是另一 inode、同字节 |
| 每个 sealed 段 | 2×，解码文本 SHA-256 | 暂存实例与 live 实例各一次内容证明；两实例读的是**同一 dev/ino、同一批字节**（stage 通过 borrow 目录链接 live 段目录；数量未在本数据中分解） |
| 归档索引文档 | 4×：staged load、live load（`promises.readFile`）、`changedArchiveFiles`、`installArchiveFiles` | 前两次在 `#loadArchiveIndex`（`memory.js:2265`）；索引很小（`io:promises.writeFile` 1.7 KB @20k），但每事务 4 次读 + 2 次 `JSON.parse` |
| 领域文档 | 2 次整份写（pending、收尾），各带 1 次数据 fsync + 1 次父目录 fsync | `io:handle.writeFile=2`、`io:handle.sync=4` |
| commit token | 读 2 次、写 2 次、不 fsync | `domain-storage.js:706`、`:804`、`:571` |
| archive lock 文件 | 读 2 次（`assertArchiveLockHeld` `domain-storage.js:548`、`:779`） | 每次都是完整的 lock 文件读 |

`io:readFileSync` 在 20,000 条时是 **11 次 / 9,322,036 字节**。这 9.32 MB 的主体就是
**同一份 4.66 MB staged inode 被 `changedArchiveFiles` 与 `installArchiveFiles` 各读
一遍**（2 × 4.66 MB），与 20261109 文档 §1 给出的「20,000 条时活动文件 4.66 MB」一致。
两次内容证明走 `openSync/readSync`（`#walkArchiveLines`），不在 `readFileSync` 计数里，
所以该事务的真实读取量远大于 9.32 MB（估约 2×归档总量 + 5×活动文件 ≈ 55 MB 量级），
这点在第 9 节说明。

## 2. A：`installArchiveFiles` 对 staged 文件二次 read+sha256

### 位置与重复次数

- `changedArchiveFiles()`（`lib/archive-stage.js:379`）在 `:394` 对每个「不再是 live 文件」
  的 staged 文件做 `fs.readFileSync(absolute)` + `crypto sha256`，产出 pending 记录里的
  `{ bytes, sha256 }`。observe 事务里被改的文件是活动档案与归档索引（`mutate()` 的
  `flushDeferredArchiveIndex()` `domain-storage.js:739` 让索引在同一事务写一次）。
- `installArchiveFiles()`（`lib/archive-stage.js:600`）在 `:616-617` 对**同一个 staged
  inode** 再做一次 `readFileSync` + `sha256`，与待安装列表比对后才 `link+rename`（`:650`、
  `:655`）。删除条目同理：`changedArchiveFiles` 在 `:409-421` 读 live 文件并哈希，
  `verifyArchiveRemoval()`（`:686-700`）在安装时再读 live 文件哈希一遍。
- 因此每个 changed 文件每事务 **2 次读 + 2 次哈希**；每个删除条目 **2 次读 live + 2 次
  哈希**。20,000 条 observe 下是 2 个 changed 文件 → 4 次 `readFileSync` + 4 次 sha256，
  其中 2 次读/2 次哈希是同 inode 的完全重复。

### 现有测试实际钉住什么（不是猜）

- `test/domain-storage/archive-stage.test.js:126-131`：把 manifest 里的 `sha256` 改成
  `f`，断言 `installArchiveFiles(...)` 抛 `E_DOMAIN_PENDING_ARCHIVE_CORRUPT`；记录长度
  与文件不一致时同样抛错。
- `test/storage-transaction-archive-install.test.mjs:60-74`：第二个 staged 文件摘要不符
  时抛错，并断言 `the first live file must not be replaced when a later staged file
  cannot be installed`；staged 文件丢失时抛 `E_DOMAIN_PENDING_ARCHIVE_MISSING`，且
  `a missing staged file must not publish a prefix of the stage`。
- `test/storage-transaction-archive-publish.test.mjs:145-155`：`the whole change list is
  still verified before anything is published`——损坏一条即抛错、live 字节不变、
  `a refused install consumes nothing`。
- `test/retention-archive-deletion.test.mjs:263`：**恢复重放路径**——已提交 pending 记录
  的 live 字节在崩溃后变化，`openDomainStorage()` 以
  `E_DOMAIN_PENDING_ARCHIVE_CORRUPT` 拒绝，pending 记录保留。
- 元数据围栏不可替代字节检查，在仓库里**有直接反例测试**：
  `test/domain-storage/event-log-checkpoint.test.js:466`（`every replay reads the full
  prefix and rejects same-size middle tampering with restored timestamps`）用
  `fs.utimesSync` 恢复 mtime 后断言 `after.ino/size` 相同、`plan().trusted === false`，
  并抛 `E_DOMAIN_EVENT_AUTH`；它要求「即使重复且未变化的 pass 也必须检查每个已消费
  字节」。同一类反例在归档读取上由 `test/observe-cache-read-fault.test.mjs:106-121`
  固定：inode/size/mtime 全部恢复后，继任实例仍必须看到新内容。
- `test/storage-transaction-archive-publish.test.mjs:86-107`：安装**不得**把已验证字节
  再写一遍（`written` 必须为空，只剩目录 fsync），这同时钉住了 E 的一半。

### 「同进程提交路径 vs 恢复重放路径能否区分」

能区分调用路径：`installPending()` 只从三处调用——`mutate()` 开头的恢复检查
（`domain-storage.js:688`）、pending 记录发布后的提交（`:808`）、端口打开时的恢复
（`:1221`）。但**区分出来也不能安全跳过校验**，理由是可证明的：

1. 提交路径的窗口不是原子的。`changedArchiveFiles` 在 `:749` 算完摘要，随后
   `writeStageManifest`、`syncStage`（含 fsync）、`assertArchiveLockHeld`、`schema.parse`
   与 `domain.global.set(...)`（`:806`）都会执行；官方 `set` 在 `unit.setGlobal()`
   resolve 之后**同步**发出 `domain/changed`，进程内任意监听器都能在这个窗口里改
   staged 文件——`test/domain-storage/event-log-checkpoint.test.js:275` 与
   `domain-storage-write-path-equivalence.test.js:274` 正是用这种监听器改写 pending
   记录来证明校验必须发生在安装之前。把摘要改成「同一进程算过就信」的证明，正好绕过
   这个已被测试利用的窗口。
2. 元数据围栏（`dev/ino/size/mtimeNs`）**不等价于内容认证**。同长度原地改写 + `utimes`
   恢复 mtime 可以让四个字段全部相同；上引 `event-log-checkpoint.test.js:466` 与
   `observe-cache-read-fault.test.mjs:106` 是仓库自己对这一反例的固定；扫描备忘文档
   §5 也把它列为已知残余（备忘无法与「字节没变」区分）。
3. 恢复路径没有可复用的摘要。`pending.files` 来自持久文档，可能是另一个进程在崩溃前
   写的；恢复时只有重读 staged 字节才能证明列表与字节一致。

**结论：不可采用。** 用围栏替代就是削弱内容认证；若只对同进程路径开证明，则需要一个
新的「同一进程内自 changedArchiveFiles 起 staged 树未被任何代码触碰」的信任协议，而这
与官方 `set` 的监听器窗口矛盾。历史状态：20261107 §4 把它记为边界（「安装阶段复用同一
staged 文件的摘要」，因为没分别计时而没有提出候选）；本轮给出量级，但结论是即使有收益
也不满足内容认证约束。

**预估量级**：`attr:mutate.installPending.installFiles` 在 1k/8k/20k 为
5.13 / 5.42 / 7.58 ms，是该方向的硬上界；其中读+哈希与目录 fsync、`lstat`、rename 没有
分开计时。用 `changedArchiveFiles` 的实测交叉推断：20k 时它 2.63 ms 读完 4.66 MB + 索引
并哈希，因此 install 里重复的读+哈希约 **2.5–3 ms**（≈3.1% 的 `attr:mutate.total`
83.46，≈2.5–3% 的 chain 82 ms）。1,000 条时约 0.6 ms（活动文件约 1.03 MB）。

## 3. B：把 memory 已证明的摘要传给 `changedArchiveFiles`

### 摘要确实存在，但形态不同

写路径上 memory 已经算过同一份字节的摘要：

- `#extendArchiveReadCache()`（`memory.js:1546`）在 append 之后把前驱的滚动哈希继续更新
  （`:1626-1627`：`liveDigestHash.update(line, "utf8").update("\n", "utf8")`），并把整份
  文件的摘要放进 `digests` 表（`:1629`）。它就是 `#archiveReadsCarry()`（`:1784`）用来
  让下一位继任实例信任这份解析的摘要。20,000 条时活动文件的这份摘要随每次 append 增量
  维护，不再读文件。
- 但它的形态是**解码文本的 SHA-256**：`#walkArchiveLines`（`:1819`）对每个块
  `hash.update(text, "utf8")`（`:1846-1850`），无效 UTF-8 的块解码成带 U+FFFD 的文本后
  再编码。
- `changedArchiveFiles` 需要的是**原始字节的 SHA-256**（`archive-stage.js:394` 直接
  `hash.update(fs.readFileSync(...))`），因为 pending 记录里的 `sha256` 要由
  `installArchiveFiles` 用 `readFileSync` 的原始字节复算（`:616-617`），恢复重放也走
  同一个比较。

**两者只在文件是有效 UTF-8 时相等。** 这由测试直接钉住：

- `test/dockyard-domain/archive-digest-walk.test.mjs:60-63`：含无效 UTF-8 的归档，扫描
  发布的摘要必须等于 `sha256(Buffer.from(raw.toString("utf8"), "utf8"))`，断言注释写明
  `not the raw bytes`；`:76-87`：全有效 UTF-8 的归档摘要等于原始字节的 `sha256`。
- [`archive-digest-utf8-20261109.md`](archive-digest-utf8-20261109.md) §2/§4 记录了这个
  口径与「无效 UTF-8 明确走回退路径」。

### 代价与风险

1. **形态不兼容**：要把 `digests`/`liveDigest` 当 `pending.files[].sha256` 用，必须
   二选一：把持久化字段的含义改成「解码文本摘要」（则恢复/安装的校验也要解码，改变
   持久化格式与 `archive-stage.js` 的内容认证口径），或在 memory 里另维护一份原始字节
   摘要（等于把重复计算搬到写路径，只省一次读，不省哈希）。两者都不是「传一个已证
   摘要」这么简单。
2. **覆盖面不足**：memory 的摘要只覆盖**本实例追加过的活动档案**。归档索引是同事务由
   `#writeArchiveIndexDocument` 写的（memory 不计算它的内容摘要）；sealed 段、重置/密封
   产生的新段、删除条目都要另算。B 只能省 changed 文件里活动档案的那一份。
3. **绑定窗口**：`digests` 是 append 时刻的证明，`changedArchiveFiles` 读取发生在稍后；
   要让摘要描述「staged 路径此刻的字节」仍需身份围栏——又回到 A 的 utimes 反例。
4. **失败模式更差**：今天的 `sha256` 来自 `changedArchiveFiles` 对 staged 文件的**当场
   读取**，所以 pending 记录写下的摘要与 staged 字节在提交点是一致的；只有 pending 写
   之后的外部/监听器篡改才会让安装失败。若摘要来自 memory 的派生状态而出现任何漏掉
   的失效路径（尾部分隔符、quarantine 重写、seal、copy fallback 都在 `#archiveEntries`
   /`#extendArchiveReadCache` 里有专门的丢弃分支），pending 记录会带着错误摘要落盘，
   而 `installPending()` 与恢复都会以 `E_DOMAIN_PENDING_ARCHIVE_CORRUPT` 拒绝——那是
   **持久且需要人工修复的拒绝**，不是一次可重试的失败。
5. **跨模块信任通道**：`archive-stage.js` 现在是唯一的内容认证点（读字节、哈希、比对）；
   让 memory 把摘要传进来会引入第二条证明来源，破坏「安装只信 staged 字节」这一条
   简单边界。

测试钉住的边界（同上）：`test/storage-transaction-archive-install.test.mjs:60-74`、
`test/storage-transaction-archive-publish.test.mjs:145-155`、`test/retention-archive-deletion.test.mjs:263`
都要求安装/恢复自己读取并复算；`test/dockyard-domain/archive-digest-walk.test.mjs:60-63`
钉住两种摘要形态不同。

**结论：不可采用（在「不削弱内容认证、不新增不可恢复失败」约束下）。** 历史状态：不在
20261107 §4 的边界清单里，属本轮新评估；不属已撤回方向。

**预估量级**：B 最多省掉 `changedArchiveFiles` 的一次活动档案读+哈希。该阶段实测
`attr:mutate.changedArchiveFiles` 在 1k/8k/20k 为 0.675 / 0.190 / 2.632 ms（上界，含索引
与目录遍历），20k 时约 **2.0–2.6 ms**（≈2.5% chain），1,000 条时 < 0.1 ms。收益与风险
不成比例。

## 4. C：两次实例级内容证明之间读的是同一批字节；实例内部还有一次重复

### 两次证明读什么

- **暂存实例**：`work()` → `EvolutionObservationStore.record()` →
  `memory.recordObservation()` → `#append()`（`memory.js:4322`）→ `#sourceMatches()`
  （`:4344` 调用，`:4219` 定义）→ `#archiveRead("observations")`（`:4223`）。这是暂存
  实例的第一次归档读，`#archiveRead` 在 `inherited === true` 时读出**每个文件**的内容
  摘要（`:1762-1765`），再与缓存表比对（`:1769`）。实测
  `attr:memory.sourceMatches.read` = 1.02 / 7.10 / 16.71 ms。
- **live 实例**：提交后 `hydrate()` 新建实例（`domain-storage.js:828`），观察者读完提交
  证据时调用 `autonomousObservations()`（`domain-storage.js:1333`）→
  `memory.historyScan("observations")`（`memory.js:3333`）→ `#archiveRead` 再付一次
  内容证明。实测 `autonomousReadMs` = 1.20 / 7.42 / 18.07 ms。两次合计 32.51 ms @20k
  （≈39% 的 `attr:mutate.total` 83.46；按 20261107 文档口径约为单步墙钟的 33%）。

### 是否同一批 inode / 字节

- **sealed 段**：`mirrorArchives()`（`archive-stage.js:181`）对段目录只建立一个 borrow
  链接（`:266-271`），stage 里看到的就是 live 段目录；安装只替换 changed 文件，不碰段
  目录。所以两个实例的两次内容证明读的是**同一 dev/ino、同一批字节**，各读两遍。
- **活动档案**：暂存实例的内容证明读的是 privatize 前的 inode X（stage 里的硬链接，与
  live 同一 inode）；写前 `privatizeArchiveFile()`（`:289`）`copyFileSync` 成新 inode X′
  （`:309`），append 后安装用 `link+rename` 把**同一个 X′** 发布到 live（`:650`、`:655`；
  `test/storage-transaction-archive-publish.test.mjs:63` 断言 live 的 inode 就是被验证的
  staged inode）。因此事务里活动档案共出现 5 次读：X 一次（暂存内容证明），X′ 四次
  （前缀证明、`changedArchiveFiles`、`installArchiveFiles`、live 内容证明）。copy
  fallback（`:651-654`，换新 inode 写已验证字节）下 live 读的是另一个 inode、同样的
  字节。
- 跨实例的两次证明**不能共享**，这是 [`observe-transaction-digest-walk-20261107.md`](observe-transaction-digest-walk-20261107.md)
  §4 已撤回的方向：反例是现行实现 1 次读取尝试并报告 `EACCES`，撤回候选 0 次、多返回
  一行 `cold-1`。钉住它的测试：`test/observe-cache-read-fault.test.mjs:25-75`（继任
  实例必须亲自观察一次 EACCES/EIO、`attempts === 1`、故障路径是本实例绝对路径）、
  `:78`（身份检查与读取之间被改写时必须解析新内容）、`:106-121`（恢复 inode/size/mtime
  后仍必须看到新字节）；`test/observe-cache-handoff.test.mjs:167`、`:274`、`:340`。

### 实例内部的重复

- **暂存实例读活动档案两次**：内容证明读 X（解码文本哈希），随后的 `#extendArchiveReadCache()`
  因为 privatize 换了 inode、size 未变，走 `#archivePrefixDigest()`（`memory.js:1564`、
  `:1656`）再读一遍 X′（读到文件尾、只哈希前 `before.size` 字节）。同一次事务、同一个
  逻辑文件、同一段前缀字节，读两遍。
- **live 实例在 staged 提交路径上只读一次/文件**（这正是 20261109 那轮收益：
  `publishArchiveScanSeeds()`（`memory.js:2430`）让 `#reconcileActiveArchive()` 命中扫描
  备忘，不再逐行重解析）。但**回退路径仍有条件重复**：种子未发布（copy fallback、seal、
  回滚、stat 失败）或备忘被 LRU 逐出时，live load 会 fresh scan 活动档案（读+解析），
  紧接着 `autonomousObservations()` 的内容证明再读一遍——同一实例内同一文件两次。
  20261109 文档 §2.2/§5 记录了这些回退条件。
- **索引文档每事务读 4 次**（staged load、live load、changed、install）；前两次是
  `#loadArchiveIndex()` 的 `promises.readFile`。字节很小，但每事务多 2 次读 + 2 次
  `JSON.parse`。这是本次审计新列出的重复读，不在 A–F 之内。
- `#archiveReadParts()` 在每次内容证明里被调用两次（`memory.js:1742` 与 `:1769`），即
  每个文件的 `statSync` 两次；纯元数据，量级很小。

### 实例内重复能否消除

暂存实例的第二次读（前缀证明）证明的是**privatize 之后的副本**持有缓存解析覆盖的
前缀字节。去掉它就必须用别的证明替代：inode/size/mtime 围栏正是被
`test/observe-cache-read-fault.test.mjs:106` 与
`test/domain-storage/event-log-checkpoint.test.js:466` 否定的那类证明。或者改成「先用
已证字节重建私有文件再追加」，那要先把整份活动档案从解析结构重新序列化出来（解析并不
保留全部原始字节），是新的写路径与新的等价性证明。**结论：不可采用。** 值得指出：
目前**没有**测试直接钉住前缀证明的必要性（`test/memory-perf-archive-read-cache.test.mjs:188`
只钉住「carry 正确」，`test/dockyard-domain/archive-scan-memo-continuation.test.js`
钉住续算一致与回退；无效 UTF-8 口径不一致的回退只在文档 §2.1 里描述）。若要消除，前提
是新增一个能模拟「privatize 之后副本被改写」的对抗测试并给出新的内容证明；本轮不建议。

**预估量级**：实例内重复 = 前缀证明的一次 4.66 MB 读 + 前缀哈希，约 **2–2.5 ms**
（≈2.5–3%，与 A 的单次读+哈希同量级）；索引 4 读的字节成本可忽略；回退路径的 live
重解析是条件性的，20,000 条时约为 `attr:memory.reconcileActiveScan` 的 10.10 ms（该
阶段现在通常被种子消掉）。

## 5. D：`pendingSet` 与最终 `finalSet` 两次全量文档写

### 是否重复序列化同一对象

不是同一个对象：`pendingSet`（`domain-storage.js:806`）写的文档 = 顶层已提交
`aggregate`+`applied` + `pending.{ stage, aggregate(新), applied(新), files }`；最终
`installPending()` 的收尾写（`:577`）只写新状态 + `pending: null`。被重复的是**内容**：
新 aggregate 对象先作为 `pending.aggregate` 写一次，再作为顶层 `aggregate` 写一次；
已提交 aggregate 的绝大部分内容又作为新 aggregate 的前缀在 pending 文档里第二次出现。
所以每次 staged observe 事务落盘的 aggregate 内容约为 3 个等价份（pending 写 2 份 +
收尾写 1 份），`applied` 标记表同样 3 份。`io:handle.writeFile` 实测 2 次 / 285,984 B
（1k）、286,750 B（8k）、287,494 B（20k）、290,406 B（50k）；20261107 文档 §2 记为
「后端文档写入 272–274 KB（pending 记录同时承载已提交与新 aggregate/applied）」。
按结构估计 pending 写 ≈ 收尾写的 2 倍（≈191 KB / ≈96 KB @20k）；这是结构推断，没有
分别计时。

### 能否既保持恢复语义/文档自洽又变小

**不能**，逐条说明为什么只有削弱语义的选项：

1. **省略 pending 期间的顶层 aggregate/applied**：需要改持久 schema；顶层已提交状态
   正是「pending 已落盘但安装未完成」时唯一可读的已提交文档，也是下一次事务入口校验
   （`schema.parse(domain.global.get())`，`:543`）的输入。去掉它，entry 校验少了一半
   输入，且 pending 记录损坏时没有任何可读的已提交状态。
2. **把 `pending.aggregate` 改成相对顶层 aggregate 的增量/patch**：恢复不再「安装已
   存储的新状态」，而是「用已提交状态 + patch 重算新状态」——这正是项目反复拒绝的
   「恢复重算」方向：patch 无法应用时现场变成未知状态；收尾文档不再能从 pending 记录
   单独导出；`domain-storage-write-path-equivalence.test.js:228` 钉住的「提交前后逐字节
   相同」也不再可证。与 `redundant-work.md` §4.2 撤回的「把校验从安装前移到安装后」同类：
   把权威从「已存储的值」换成「由其它字段派生的值」。
3. **用 pending 写的字节直接产出收尾文档**：文档不同（`pending: null` vs pending 记录），
   无法复用字节。
4. **压缩/流式序列化**：是格式变更，不是重复计算消除。

### 钉住两次写与恢复语义的测试

- `test/domain-storage/transaction-commit-shape.test.js:111-132`：staged 事务必须
  `assert.deepEqual(counted, { commits: 1, closes: 1 })`，且收尾移除 stage；`:90-110`
  无归档变更时只允许一次收尾写（`{ commits: 0, closes: 1 }`）。
- `test/domain-storage/transaction-archive-batch.test.mjs:385`（pending 发布被拒 → 已提交
  字节不变、整组重放）、`:404`（收尾写失败 → 恢复且不二次应用）。
- `test/retention-archive-deletion.test.mjs:232`（已提交 pending 记录在打开时安装删除并
  「replays as a no-op」）、`:252`（pending 删除的字节不再匹配时拒绝并保留两侧）。
- `test/review-fix-storage-lock-fencing.test.mjs:164`（恢复拒绝在失去锁后安装已提交
  stage——与提交走同一安装路径）。
- `test/domain-storage/event-log-checkpoint.test.js:275`（监听器改写 pending 记录必须被
  拒绝）、`:314`（被拒提交不得安装 staged 归档）。

**结论：不可采用。** 历史状态：未见直接尝试；属于持久化格式与恢复协议变更，风险类别与
§4.2 相同。

**预估量级**：`attr:mutate.pendingSet` = 7.80 / 8.31 / 8.09 ms，
`attr:mutate.installPending.finalSet` = 7.29 / 6.63 / 7.14 ms（1k/8k/20k），合计约
15.2 ms 且**几乎不随历史变化**——说明墙钟由 4 次 `FileHandle#sync`（每写 1 次数据 +
1 次父目录）主导（`domain-derived-fsync.md` §2.2 实测单次约 3.4–3.5 ms）。减少重复
序列化只省 CPU（约 1–1.5 ms，2% 量级），不会省 fsync；而它要求改恢复协议。收益/风险
不成立。

## 6. E：`syncStage` / `installArchiveFiles` / 后端 `set` 的 fsync 是否重复

**没有同一目标被同步两次。**

当前 `io:` 实测每次 `observe()`：`fsyncSync = 5`、后端 `FileHandle#sync = 4`。按代码
分解：

| 同步点 | 次数 | 目标 | 是否重复 |
| --- | ---: | --- | --- |
| `syncFile()`（`archive-stage.js:525`）← `syncStage()`（`:570`） | 2 | staged 活动档案 + staged 归档索引，各 1 次 | 否，每个 changed staged 文件恰好一次 |
| `syncDirectory()`（`:530`）← `syncDirectories()`（`:537`）← `syncStage()`（`:573`） | 2 | stage 目录 + stagingRoot | 否，`Set` 去重并按深度降序，每个目录一次 |
| `syncDirectories()` ← `installArchiveFiles()`（`:672`） | 1 | 目的地目录（live 根；有段时再加段目录） | 否，安装只 fsync 目录项；**不**重新 fsync 文件字节（`test/storage-transaction-archive-publish.test.mjs:86-107`：`written` 必须为空，只剩目录 fsync） |
| `FileHandle#sync` ← 官方 `writeAtomic` ×2（pending 写、收尾写） | 4 | 各自临时数据文件 + `official/` 父目录 | 同一个**文件**被写两次是两阶段提交本身；同一个**目录**被 fsync 两次，但每次 `rename` 后都必须重新 fsync 该目录，两次都是独立的持久性义务 |

补充：

- commit token（`domain-storage.js:433`）刻意不 fsync（`:409-418` 注释）；它只用于同进程
  端口间的可见性。
- `hydrate()` 里可能补 `syncFile(index)` + `syncFile(root)`（`domain-storage.js:685`）：
  只在 live load 修复了归档索引 inode 时发生。实测计数 5 次 `fsyncSync` 说明正常路径不
  触发；它是条件路径，不是每事务重复。
- 历史：`domain-derived-fsync.md` §2–§3 已经删除过两处真正可删的派生 fsync（事件桥
  检查点、阶段清单），并保留了其余同步；那两处是「派生状态」，现在剩下的都是权威数据
  或提交协议本身。

**结论：无可消除的重复同步。** 唯一看起来「同一目标两次」的是领域文档的父目录，但它
是两次独立提交各自的 rename 耐久性，删掉就削弱崩溃恢复。约束下不可采用。

## 7. F：提交点的 `schema.parse`、`stableJson`、`aggregateDigest`

### `schema.parse`：每事务 3 次调用 / 5 个 aggregate 投影

提交路径上的调用点：

| 调用点 | 触发 | 解析的文档 | 作用 |
| --- | --- | --- | --- |
| `domain-storage.js:543`，由 `:688` 调用 | 每次 `mutate()` 开头（恢复检查） | 已提交文档（pending=null） | **入口校验**：同进程把手改坏文档时在创建 stage 之前拒绝 |
| `domain-storage.js:806` | pending 记录发布 | pending 文档（2 个 aggregate + 2 个 ledger） | **发布前校验**：非法内容不得成为持久 pending 记录 |
| `domain-storage.js:543`，由 `:808` 调用 | 安装前 | pending 文档（同上） | **安装前校验**：被拒绝的提交不得改动 live 归档树 |

每个 `aggregateSchema` 都带 `toJsonProjection`（`:67-72`）：`JSON.stringify` + `JSON.parse`
（+ 当序列化文本含 `"__proto__"` 字面量时的一次递归清理）。因此一次 staged observe 事务
的 aggregate 投影次数是 **1（入口）+ 2（发布）+ 2（安装前）= 5**；这正是
[`domain-transaction-save-projection.md`](domain-transaction-save-projection.md) §1 记录的
「固定 5 次」（该轮只删掉了每次 `#save()` 的额外投影，这 5 次保留）。实测
`attr:installPending.parse` = 0.584 / 0.480 / 0.557 ms（calls=20，即每步 2 次），发布点
那 2 次投影计入 `attr:mutate.pendingSet`。合计量级约 1–1.5 ms。

三处各自都对应一个被攻击过的失败场景，但测试覆盖强度不同（发布点只有间接覆盖，见下）：

- 入口（`:688`→`:543`）：`test/domain-storage/domain-hotpath-20261024-entry-validation.test.js:85`
  用四种「同进程原地改写 live 文档」的形状，断言下一次 `observe` 在创建 stage 之前以
  对应 `ZodError` 的 issue code/path 拒绝、durable 字节完全不变、`after.staged` 为空；
  `:134` 断言修好文档后同一记录恰好提交一次。该文件头 `:1-30` 记录了这个入口 parse
  不可替换成 identity 快路径的原因；`:169` 把被否决的 identity-skip 候选跑成差分测试。
- 发布前（`:806`）：`domain-hotpath-20261024-entry-validation.test.js:169` 的候选差分显示，
  保留发布点 parse 的被否决候选**仍会成功提交**三种「被 wash out」的形状，只有第四种
  （非法值落在事务重新生成的文档之外的 marker 形状）被发布点拒绝并留下 stage。因此发布点
  parse 不能替代入口 parse（它看不到重新生成文档时被丢掉的非法值），它的作用是让非法内容
  不成为持久 pending 记录；这条边界只由该差分的第四形状间接覆盖，**没有**单独的「发布点
  必须拒绝」回归。
- 安装前（`:808`→`:543`）：`test/domain-storage/event-log-checkpoint.test.js:275`
  （`a listener that rewrites the pending record cannot bypass its validation`，四种形态
  都必须 `ZodError`）、`:314`（`a rejected commit does not install the staged archive`，
  `archiveTree` 必须与提交前逐字节相同）；
  `test/domain-storage/domain-storage-write-path-equivalence.test.js:274`
  （`a rejected commit installs nothing in either implementation`，两侧差分）。
- 历史撤回：`redundant-work.md` §4.2「恢复安装只校验使用到的字段」已整体撤回（它把校验
  移到安装之后，削弱「被拒绝的提交不得改动实时树」）；2026-10-24 的 identity-skip 候选
  被否决（`domain-hotpath-20261024-entry-validation.test.js`）。

**结论：这 5 次投影不是可以合并的重复**。入口与安装前两处各有直接回归（上面的反例/
差分与监听器改写用例），发布点只有候选差分的第四形状间接覆盖；即便如此，删掉它会让非法
文档成为持久 pending 记录（第 4 节的「恢复后永久拒绝」），仍然不可采用。

### `stableJson` / `aggregateDigest`：常规路径不计算

`stableJson`（`domain-storage.js:378`）与 `aggregateDigest`（`:388`）只在
`mutate()` 的 CAS 比较里使用（`:800-803`）：

```js
const unchanged = latest.pending === null
  && sameEventLedger(latest.applied, baseline.applied)
  && (latest.aggregate === baseline.aggregate
    || aggregateDigest(latest.aggregate) === aggregateDigest(baseline.aggregate));
```

`baseline.aggregate` 是事务开始时的 `domain.global.get().aggregate`
（`:706`）；`latest` 是发布前的同一 handle（`:799`）。官方 `globalHandle.get()` 直接返回
`globalValue`（`node_modules/@deepseek-ai/dsh-storage-domain/lib/index.js:158-160`），
两者在普通路径上是**同一对象引用**，因此 `latest.aggregate === baseline.aggregate`
短路，`stableJson`/`aggregateDigest` 一次也不执行。只有同进程写者通过官方 handle 替换了
文档对象时才走到摘要比较；这条路径由
`test/review-fix-storage-lock-cas-overwrite.test.mjs:141`（`a writer that replaced this
port's own document is refused the same way`，注释写明 `the transaction's digest no
longer matches`）钉住，跨进程提交则由 commit token（`:804`）覆盖。

**结论：不是重复计算。** 若要消掉摘要，只能改成「对象身份相等就跳过」→ 正是被否决的
identity-skip 方向；或者改成跨次复用的派生摘要 → 正是 `redundant-work.md` §4.1 撤回的
方向（O(历史) 派生值无法用 O(1) 信号证明未变）。

### 附加观察（不在 A–F 列表内）

- `sameEventLedger`（`:392`）在 `:801` **每个事务**都执行，并按 `Object.keys` 走完整张
  已提交标记表；`baseline.applied = { ...recovered }`（`:706`）还先复制整表。20,000 条
  事件历史下这是两次 O(|markers|) 的遍历与一次整表分配。它不能只用 commit token 替代：
  同进程的 `handle.set()` **不会**推进 token，而同长度原地改写 `applied` 也不替换对象
  （`test/domain-storage/event-log-checkpoint.test.js:229` 钉住了「原地改写标记表」这类
  场景的存在）。消除它需要新的 O(1) 版本证明——属于 §4.1 已撤回的同一类。本轮只记录，
  不提出候选。
- 索引文档每事务 4 读 + 2 次 `JSON.parse`（见 §1/§4），是 A–F 之外唯一可证明的重复文件
  读取；但索引小（KB 级），只有系统调用与解析开销，收益远低于任何一项格式/协议风险。

## 8. 不可采用清单（按约束归类）

| 候选 | 违反的约束 | 证据 |
| --- | --- | --- |
| A：安装复用 changed 摘要 / 元数据围栏 | 内容认证；恢复重放正确性 | 安装测试四组；utimes 反例 `event-log-checkpoint.test.js:466`、`observe-cache-read-fault.test.mjs:106` |
| B：memory 摘要传给 changedArchiveFiles | 内容认证（摘要形态/来源）；失败行为（pending 永久拒绝） | `archive-digest-walk.test.mjs:60-63`；安装/恢复的自校验测试 |
| C：跨实例共享解析/证明 | 读取故障可见性、内容变化可见性 | 20261107 §4 反例（1→0 次读取、多一行、无故障）；`observe-cache-read-fault.test.mjs` |
| C：实例内去掉 privatize 前缀证明 | 内容认证（privatize 后副本未证） | 无直接回归；需新增对抗测试＋新证明，当前不可证 |
| D：pending 文档省略/增量顶层状态 | 恢复语义、文档自洽、逐字节等价 | `transaction-commit-shape.test.js`、`domain-storage-write-path-equivalence.test.js:228`、§4.2 同类风险 |
| E：去掉任一 fsync | 崩溃恢复（提交顺序/耐久性） | `domain-derived-fsync.md` 已删可删项；安装测试钉住只 fsync 目录 |
| F：identity-skip / 按使用点校验 | 失败原子性（被拒提交不得改 live 树） | `domain-hotpath-20261024-entry-validation.test.js`、`event-log-checkpoint.test.js:275`、§4.2 |
| F：复用 applied 派生摘要 | O(历史) 状态无法用 O(1) 信号证明 | `redundant-work.md` §4.1（真实后端上两轮反例） |

## 9. 未验证项与边界

- 本轮**没有运行任何基准或测试**。所有 ms/字节/调用数都来自仓库已发布的数据文件与
  文档，基线如上表；`attr:` 来自 `c2c8d2e`，`io:` 来自当前树（20261109），两者不是
  同一次测量，只用于量级。
- 每文件读取次数由源码静态推导；已发布的数据没有按文件/调用点分解 `readFileSync` 与
  `openSync/readSync`。9.32 MB 的 `readFileSync` 几乎全部是 changed+install 对同一
  staged 活动文件的两遍读（2×4.66 MB）；其余小读（token×2、lock×2 等）没有逐一定额。
  两次内容证明与前缀证明走 `openSync/readSync`，**不计入** 9.32 MB，所以该数字不是本
  事务的总读取量。
- sealed 段的数量与总字节没有在已发布数据中分解；`io:openSync=23` 同时包含内容证明的
  打开与 fsync 前的打开，不能反推文件数。两次内容证明的 32.5 ms 只说明「每个实例读了
  整个冷档案」。
- D 的 pending:收尾 ≈ 2:1 字节比是结构推断；`io:` 只给两次写合计字节。
- 条件性重复（扫描备忘 LRU 逐出、copy fallback、索引修复）没有测量；`io:` 数值对应
  备忘命中的正常路径。
- `sameEventLedger` 的 O(|markers|) 成本没有在已发布数据里单独计时；本文不给数字。
- 20,000 与 50,000 的墙钟受活动文件大小（轮转时机）影响（20261109 文档 §1），
  本文只用 20,000 的单次阶段数据做量级，不外推。

## 10. 引用

源码（行号对 `b690fe0`）：

- `lib/domain-storage.js:542-580`（`installPending`）、`:687-830`（`mutate`）、
  `:1221`（打开时恢复调用）、`:378-396`（`stableJson`/`aggregateDigest`）、
  `:1333-1344`（`autonomousObservations`）
- `lib/archive-stage.js:289-316`（privatize）、`:379-424`（`changedArchiveFiles`）、
  `:525-574`（`syncFile`/`syncDirectories`/`syncStage`）、`:600-673`（`installArchiveFiles`）、
  `:686-700`（`verifyArchiveRemoval`）
- `lib/dockyard-domain/memory.js:1432-1446`、`:1484-1521`、`:1546-1645`、
  `:1656-1675`、`:1741-1801`、`:1819-1889`、`:2430-2445`、`:2661-2704`、
  `:4219-4269`、`:4322-4404`
- `node_modules/@deepseek-ai/dsh-storage-domain/lib/index.js:158-160`（`global.get` 返回
  同一个 `globalValue` 引用）
- `node_modules/@deepseek-ai/dsh-storage-json/lib/index.js:25-49`（`writeAtomic`：临时文件
  fsync + rename + 父目录 fsync）

测试（断言语义见正文）：

- `test/domain-storage/archive-stage.test.js:112-149`
- `test/storage-transaction-archive-install.test.mjs:41-82`
- `test/storage-transaction-archive-publish.test.mjs:63-107`、`:145-155`
- `test/retention-archive-deletion.test.mjs:163-177`、`:232-266`
- `test/domain-storage/transaction-commit-shape.test.js:90-176`
- `test/domain-storage/transaction-archive-batch.test.mjs:385-428`
- `test/domain-storage/event-log-checkpoint.test.js:275-340`、`:466-505`
- `test/domain-storage/domain-storage-write-path-equivalence.test.js:228-322`
- `test/domain-storage/domain-hotpath-20261024-entry-validation.test.js:1-30`、`:85`、`:134`、`:169`
- `test/review-fix-storage-lock-cas-overwrite.test.mjs:96-170`
- `test/review-fix-storage-lock-fencing.test.mjs:164-224`
- `test/observe-cache-read-fault.test.mjs:25-121`
- `test/observe-cache-handoff.test.mjs:167-364`
- `test/memory-perf-archive-read-cache.test.mjs:167-232`
- `test/dockyard-domain/archive-digest-walk.test.mjs:40-88`
- `test/dockyard-domain/archive-scan-memo-continuation.test.js:111-250`
- `test/dockyard-domain/archive-scan-memo.test.js:152-200`（备忘身份边界）

文档与数据：

- [`observe-transaction-digest-walk-20261107.md`](observe-transaction-digest-walk-20261107.md) §2/§4
- [`observe-scan-memo-continuation-20261109.md`](observe-scan-memo-continuation-20261109.md)
- [`archive-digest-utf8-20261109.md`](archive-digest-utf8-20261109.md)
- [`redundant-work.md`](redundant-work.md) §4.1/§4.2
- [`domain-transaction-save-projection.md`](domain-transaction-save-projection.md) §1
- [`domain-derived-fsync.md`](domain-derived-fsync.md) §2
- `observe-transaction-digest-walk-20261107.attribution.json`
- `observe-scan-memo-continuation-20261109.json`
