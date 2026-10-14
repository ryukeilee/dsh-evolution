# 写入路径：重复的活动档案 reconcile 扫描，与逐行身份重算

本轮删除上一轮收口时记录的两个真实成本：**每条公开写操作把同一份活动档案 reconcile
两遍**（`lib/dockyard-domain/memory.js` 的 `#reconcileArchiveIndex()`），以及
**`#sourceMatches()` 逐行重算身份时使用最贵的正则写法**（`lib/dockyard-domain/knowledge.js`
的两处标识符折叠）。两处都是最小有效修改：不新增缓存层以外的结构，不改持久化格式、
认证、fsync、事务、恢复、回滚、跨进程锁与 promotion 边界，未修改官方 DSH 源码，也未
触碰 `release/` 中的固定产物。

原始数据（本轮实际运行，未引用历史数字）：

- [`observe-cold-archive-attribution.json`](observe-cold-archive-attribution.json)
  —— 端到端 `port.observe()`，固定产物 + 三个单改动变体；
- [`archive-scan-memo.json`](archive-scan-memo.json)
  —— 隔离：一次事务内的两次 reconcile 成本（含确定性的解析行数）；
- [`knowledge-identity-cost.json`](knowledge-identity-cost.json)
  —— 隔离：逐行身份成本 + 折叠等价性的穷举证明。

环境：Node `v26.11.1` / `darwin/arm64`（Darwin 27.0.1），Apple M2，8 逻辑 CPU、
16 GiB 内存。测量期间机器并不空闲（开始前 load average `1.48 / 1.52 / 1.59`），
没有并行运行测试或其它基准。`observe-cold-archive.mjs` 与 `archive-scan-memo.mjs` 都在
同一进程内轮换各侧、每侧每轮断言落盘字节（索引文档、档案字节、`archiveActiveKeys`）
逐字节相同，任何保留决策或索引分歧都会让脚本非零退出；`knowledge-identity-cost.mjs` 是
纯函数测量（逐行 key、折叠等式、生产锚定等式与固定产物值锚），不涉及落盘。

## 1. 两个瓶颈与实测成本

### 1.1 每条公开写操作把同一份活动档案 reconcile 两遍

`lib/domain-storage.js` 的 `mutate()` 为一次写入建两个 memory 实例：先为暂存阶段
`createMemory(dir, …)`（`dir` 是 `mirrorArchives()` 生成的**硬链接镜像**），提交后再
`hydrate()` → `createMemory(root, …)`。两个新实例的 `load()` 都会执行
`#reconcileArchiveIndex()`，而它的活动档案分支必须完整读取并逐行解析该文件（只有封闭段
能按 `sha256` + `byteSize` 早退）。暂存镜像与活树是同一批 inode，因此这遍扫描读的是
刚刚读过的字节。

在被测量的负载下（10,000 行 observations + 10,000 行 knowledge 冷档案，22.1 MiB），
一次写入因此发生 4 次全量读取/解析，实测：

| 位置 | 文件 | 字节 | inode | 读+解析 |
| --- | --- | ---: | ---: | ---: |
| 提交前暂存镜像 | observations | 4,703,340 | 250464016 | 9.5 ms |
| 提交前暂存镜像 | knowledge | 18,532,794 | 250464017 | 44.9 ms |
| 提交后活树 | observations | 4,703,340 | 250464016 | 9.5 ms |
| 提交后活树 | knowledge | 18,532,794 | 250464017 | 44.5 ms |

隔离基准（`archive-scan-memo.mjs`，三轮、每轮 5 个样本）给出同样的量级：固定产物
rc.10 的一次事务里，"硬链接镜像的 `load()`" 61.7 ms + "提交后活树的 `load()`" 61.7 ms
= **123.4 ms**，而作为对照的"活树首次 `load()`"（本来就必须读字节）只有 63.2 ms。

这两组归因来自独立的探针运行（命令见第 8 节），不在三份基准 JSON 中；下面第 4 节的
三个基准才是可复现的 A/B 证据。

### 1.2 `#sourceMatches()` 逐行重算身份，且折叠写法最贵

`#append()` 每次写入都要 `#sourceMatches()`：对来源集合的**完整历史**逐行判断
"这一行是不是同一主体"。行既可按**存储的** `knowledgeKey` 命中，也可按**从自身字段
重算出的** canonical key 命中，两者都不能省，因此每个冷行都要跑一次
`knowledgeKeyOf()`：6 个维度各一次文本规范化，再加一次 hash。10,000 行 observations
冷档案的重算是 **73.9 ms**（隔离基准，三轮 15 个样本中位数），10,000 行 knowledge
冷档案（行更大）是 **133.2 ms**。

`normalizeText()` 里的两处标识符折叠原来写作 `/\b[0-9a-f]{8,}\b/giu` 与
`/\b[0-9a-f]{4,}-[0-9a-f-]{4,}\b/giu`：`i` 与 `u` 同时开启是这两个类最贵的写法，
在改动前（`ed4cbb6`）的采样里占逐行身份成本的 **24.0%**（`\b[0-9a-f]{8,}\b` 12.1% +
`\b[0-9a-f]{4,}-[0-9a-f-]{4,}\b` 12.0%，本轮用 `--cpu-prof` 在 20,000 + 20,000 行身份
负载上重测，783 个样本；同一负载下改动后这两项合计 6.6%）。

## 2. 改动

### 2.1 `memory.js`：以文件身份为键的进程内扫描备忘

`#reconcileArchiveIndex()` 的活动档案分支抽成 `#reconcileActiveArchive()`，先按
`stat(file, { bigint: true })` 的 `(dev, ino)` 查一个模块级备忘；命中条件是
`size` 与 `mtimeNs` 与该次扫描记录的一致，命中时只重建条目对象（`updatedAt` 取当前
时钟，与一次新鲜扫描完全相同）并把 `activeKeys` **复制**给实例，未命中时照原样读取、
解析、建条目，并把结果记入备忘。备忘上限 32 条（LRU 淘汰，淘汰只损失一次重扫）。

`archive-stage.js` 已经用同一组身份（`dev` / `ino` / `size` / `mtimeNs`）判断两个目录
项是否同一个文件；本备忘沿用该身份，且本插件在生命周期内持有 `domain-archive.lock`，
所有档案写入都发生在自己进程内。

### 2.2 `knowledge.js`：折叠类显式写出大小写范围，并让 explicit key 只在需要时规范化

- 两处折叠改为 `/\b[0-9a-fA-F]{8,}\b/gu` 与
  `/\b[0-9a-fA-F]{4,}-[0-9a-fA-F-]{4,}\b/gu`（去掉 `i`，把范围写进类）。
- `knowledgeIdentity()` 原来无条件先算
  `explicitKey = normalizeText(explicit, { dynamicNumbers: false })`，但该值只用于
  `hasSignal` 的真值判断和"以 `knowledge:` 开头就返回它"的分支；现在的判定条件就是原来
  `hasSignal` 里那几项本身——`rootCause || strategy || failureMode || semanticFact ||
  (hasUsefulType && scope)`——成立时直接返回 `hash(dimensions)`，不成立时才规范化
  explicit key 并走原分支。注意这不是"任一维度非空"：只有 `issueType`（无 scope 时）或
  只有 `scope`（`issueType` 是通用类型时）都仍然走兜底分支，
  `knowledgeKeyOf({ issueType: "timeout" })` 与 `knowledgeKeyOf({ scope: "plugin:x" })`
  都返回 `null`。逐行身份因此少一次完整的文本规范化。

## 3. 等价性依据

### 3.1 备忘只回答"本进程已经扫过的那一份字节"

- 扫描本身没有被删除：`#reconcileActiveArchive()` 对每个身份未记录的档案仍执行完整的
  读取、解析、索引重建与 `archiveActiveKeys` 重建，`#reconcileArchiveIndex()` 的
  `changed` 判定、索引文档写入、封闭段的 `sha256` + `byteSize` 早退都未改动。
- 备忘的键是 `(collection, 文件名, dev, ino)`，并**只在 `size` 与 `mtimeNs` 都与记录
  一致时命中**。插件对档案的每一种改动都会改变这个身份：追加使 `size` 增长；原地改写使
  `mtimeNs` 变化；seal、compaction 与 `installArchiveFiles()` 都换 inode；compaction
  回滚把原 inode 改名回来，其记录身份仍然描述它自己的字节。第一轮复核曾认为 inode 分量
  在可构造场景里不可区分，第二轮复核给出了反例：把两个文件的 mtime 先统一 pin 到整秒
  （`utimes` 能精确复现整秒），就能让 `size` 与 `mtimeNs` 相同而 inode 不同。用例因此
  为四个分量各加了一条场景（inode / size / mtime / 文件名），对应的四个注入现在都会
  失败（见第 6 节）；`(collection, 文件名)` 两个分量是第二轮复核发现"跨 basename 硬链接
  会返回错的 `file`"后补进键的。
- 备忘与实例之间不共享可变状态：记录扫描结果时备忘持有活动键集合的**自己的副本**（产生
  该记录的实例随后会继续往自己的集合里追加新键），命中时又把副本交给实例；条目对象只被
  深拷贝后使用。两个方向都不共享，用例逐条断言（见第 6 节）。
- 恢复面语义未变：进程启动时备忘为空，每个活动档案都会被完整扫描（隔离基准里
  "活树首次 `load()`" 两侧都是 20,000 次解析）；索引文件丢失会由备忘重建索引文档，
  落盘字节与一次重扫相同（独立复核实测该场景 0 次档案行解析，本文件据此修正了原先
  "索引丢失必重扫"的表述）；档案被外部改动（`size`/`mtime` 变化）会重新扫描；备忘随
  进程消失，崩溃恢复仍然从磁盘重建。
- 备忘保存的条目是**深拷贝**（档案行的时间戳字段可以是对象，浅拷贝不足以隔离），键集在
  记录侧与命中侧都是副本；备忘的键除 `(dev, ino)` 外还包含 collection，因此即使两个
  collection 的活动档案被外部硬链接到同一 inode，条目里的 `segmentId`/`recordType`/
  `file` 仍然描述各自的 collection。

### 3.2 折叠等价：逐码点穷举 + `\b` 差异集 + NFKC 管线

先把等价性说准：**两个完整模式在任意字符串上并不等价**。`\b` 在 `i` + `u` 下会把
"大小写折叠后是 ASCII 词字符"的码点也当作词字符，因此
`/\b[0-9a-f]{8,}\b/giu` 与 `/\b[0-9a-fA-F]{8,}\b/gu` 对
`"ſdeadbeef"`（U+017F）给出不同结果：旧写法保持原样，新写法折叠成 `"ſ<id>"`。
本轮改动能成立，是因为它作用在 `normalizeText()` 的管线里，而不是任意字符串上：

1. **字符类逐码点穷举**：对全部 1,112,064 个非代理码点比较两个类的成员关系，0 处差异。
2. **`\b` 差异集**：对全部 1,112,064 个码点，各取 4 个探针串
   （`c+"deadbeef"`、`"deadbeef"+c`、`c+"abcdef12-3456"`、`"abcdef12-3456"+c`），
   直接比较两个写法对它们的整串 `replace` 结果，差异集恰好是 **{U+017F, U+212A}**
   两个码点（`/\w/iu` 与 `/\w/` 的代理比较给出同一集合）。
3. **它们到不了这两处折叠**：`normalizeText()` 先执行 `.normalize("NFKC")`，而对全部
   码点的检查显示没有任何码点的 NFKC 形式包含这两个字符（它们只有向外的兼容映射，
   没有可供组合步骤产出它们的规范分解），`toLowerCase()` 也不会产出它们（U+017F 已是
   小写，U+212A 的小写是 `k`）。
4. **管线输入上的整模式等价**：对 1,166,311 个字符串（全部码点 + 由
   `a f F g z 0 9 - : 空格 \t é Ａ K ſ` 组成的 0–4 字符串 + 真实标识符样本）比较
   两侧在 `s.normalize("NFKC").toLowerCase()` 上的 `replace` 结果，0 处差异。
5. **生产锚**：以上 1–4 步验证的是脚本里复制出来的模式与管线；脚本另外对生产
   `knowledge.js` 做行为锚定——对 U+017F / U+212A / Ａ / ① 四个码点断言"含该码点的记录与
   含其 NFKC 形式的记录返回完全相同的 key 与规范化事件"。把生产代码里的 `NFKC` 改成
   `NFC`（U+017F 不再被折叠）会让这一阶段立即失败。

第 5 条同时把上面那个一般性反例**钉住**：脚本要求 `"ſdeadbeef"` 在两写法下确实不同
（`boundaryExampleDiffers: true`），将来若引擎改变了 `iu` 下的 `\b` 行为，脚本会直接
失败，而不是让这条论证悄悄失效。

### 3.3 维度决定 canonical key；explicit key 只在没有维度信号时被读取

`normalizeText()` 的输出字符集是"字母、数字、`<`、`>`、`.`、`'`、`-`、空格"：最后两步
`[_\/\\|:]+ → " "` 与 `[^\p{L}\p{N}<>.'-]+ → " "` 会去掉 `:`，其后的短语替换、空白
折叠与截断都只会引入字母、连字符、空格与省略号。因此
`explicitKey.startsWith("knowledge:")` 恒为假，canonical key 恒为
`"knowledge:" + hash(dimensions)`；显式 key 唯一还能起作用的地方就是
`hasSignal` 的真值判断，而那个判断在维度一侧的全部输入就是上面那四项。改动只把这次
规范化挪到"确实需要它"的分支，返回值不变。

差异测试对这一点是双向锚定的：
`test/dockyard-domain/knowledge-identity-equivalence.test.js` 的语料新增了
"存储 key 形如 canonical 却仍由维度决定"、"只有显式 key 有信号"、"显式 key 规范化后
为空"等形状，与固定产物 rc.10 的 `normalizeKnowledgeEvent()` / `canonicalKnowledgeKey()`
逐字段比较；`knowledge-identity-cost.mjs` 在测量前要求**每个被测量的一侧对每一行都
返回固定产物算出的 key**，否则直接失败。

## 4. 实测

### 4.1 端到端：公开 `port.observe()`（固定产物 + 单改动变体）

```sh
node scripts/benchmarks/observe-cold-archive.mjs --rows 10000 --knowledge-rows 10000 \
  --rounds 3 --warmup 1 --samples 5 \
  --variant <main> --variant <main+备忘> --variant <main+身份>
```

`main` 是 `ed4cbb6`（本轮开始前的 `main`，上一轮收口提交）的 `lib/`；两个变体
分别是"工作树 + `ed4cbb6` 的 `memory.js`"（只含身份改动）与"工作树 + `ed4cbb6` 的
`knowledge.js`"（只含备忘改动），都由 `git show ed4cbb6:lib/...` 生成，脚本只读取、
不替换工作树文件。固定产物是 rc.10，
因此它也同时给出"上一轮改动 + 本轮改动"的累计值。每轮 5 侧轮换顺序，5 侧落盘树
逐字节相同。

| 侧 | 墙钟中位数 (ms) | 对固定产物 | CPU 中位数 (ms) | 对固定产物 |
| --- | ---: | ---: | ---: | ---: |
| 固定产物 rc.10 | 573.434 | — | 690.797 | — |
| `main`（上一轮收口） | 285.890 | −50.14% | 290.000 | −58.02% |
| `main` + 备忘 | 163.874 | −71.42% | 157.250 | −77.24% |
| `main` + 身份 | 261.484 | −54.40% | 261.812 | −62.10% |
| `main` + 备忘 + 身份（工作树） | **136.830** | **−76.14%** | **126.290** | **−81.72%** |

本轮两个改动的边际值（相对 `main`）：备忘 **−122.016 ms（−42.68%）**、
身份 **−24.406 ms（−8.54%）**、两者合计 **−149.060 ms（−52.14%）**；两个边际之和
（146.4 ms）与合测值（149.1 ms）相差 1.8%，落在上表逐轮中位数的波动范围内，因此没有
观察到两者互相遮蔽。

逐轮中位数（每轮 5 个样本的中位数，顺序为轮换后的实际执行顺序）：

| 轮 | 固定产物 | `main` | `main`+备忘 | `main`+身份 | 工作树 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 578.949 | 288.403 | 161.479 | 263.343 | 138.583 |
| 2 | 562.936 | 285.890 | 164.483 | 260.943 | 136.830 |
| 3 | 573.434 | 283.494 | 163.874 | 261.484 | 134.978 |

### 4.2 隔离：一次事务内的两次 reconcile（备忘）

```sh
node --expose-gc scripts/benchmarks/archive-scan-memo.mjs --rows 10000 --knowledge-rows 10000 \
  --rounds 3 --warmup 1 --samples 5 --retained
```

被测单元就是 `mutate()` 自己的序列：`mirrorArchives()` 活树（硬链接，与 `mutate()`
一致）后对镜像建实例并 `load()`，再对提交后的活树建实例并 `load()`；另测"活树首次
`load()`"作为对照（它本来就必须读字节）。基线是固定产物 rc.10 的
`lib/dockyard-domain/memory.js`；已核对 rc.10 与 `ed4cbb6` 的 `#reconcileArchiveIndex()`
区块逐字节相同，因此该差值只归因于本轮备忘。

| 阶段 | rc.10 (ms) | 工作树 (ms) | 变化 |
| --- | ---: | ---: | ---: |
| 活树首次 `load()`（对照） | 63.190 | 64.900 | +2.7%（噪声内） |
| 硬链接镜像的 `load()` | 61.748 | 0.956 | **−98.45%** |
| 提交后活树的 `load()` | 61.651 | 0.849 | **−98.62%** |
| 一次事务的 reconcile 合计 | 123.399 | 1.805 | **−98.54%** |

确定性指标（与机器噪声无关，且**由脚本断言**而不是只报告）：首次 `load()` 两侧都解析
**20,000** 行（对照确实读了全部字节），镜像与提交后的 `load()` 各 **20,000 → 0**，三轮
全部相同；同时断言两侧的索引文档、`archiveActiveKeys`、档案字节逐字节相同。

### 4.3 隔离：逐行身份（身份改动）

```sh
node scripts/benchmarks/knowledge-identity-cost.mjs --rows 10000 --knowledge-rows 10000 \
  --rounds 3 --warmup 1 --samples 5 --lib <main+备忘>
```

被测单元是 `#sourceMatches()` 对每个冷行做的同一件事（一次 `knowledgeKeyOf()`）；
"基线"一侧是 `ed4cbb6` 的 `knowledge.js`（只差本轮的折叠写法与惰性 explicit key），
固定产物 rc.10 提供**值**的锚：两侧的每一行都必须返回 rc.10 的
`normalizeKnowledgeEvent()` 算出的 key。

| 语料 | `ed4cbb6` 墙钟 (ms) | 工作树墙钟 (ms) | 墙钟 Δ | `ed4cbb6` CPU (ms) | 工作树 CPU (ms) | CPU Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 行 observations 冷档案 | 73.914 | 50.421 | **−31.78%** | 73.987 | 50.502 | −31.74% |
| 10,000 行 knowledge 冷档案 | 133.207 | 90.056 | **−32.39%** | 133.322 | 90.154 | −32.38% |

折叠阶段：1,112,064 个码点 + 1,166,311 个字符串，类差异 0、管线内整模式差异 0、
`\b` 差异集恰好 {U+017F, U+212A}、NFKC 存活者 0；每个码点都用 4 个边界探针
（标识符前缀/后缀 × 两个模式）直接比较两个写法，而不是用 `\w` 代理或无法匹配标识符的
短语料。另有"生产锚"：对 U+017F / U+212A / Ａ / ① 断言含该码点的记录与含其 NFKC 形式的
记录身份完全相同（见 3.2、3.3）。

## 5. 收益边界与取舍

**收益边界。**

- 备忘的收益与"一次事务里被重复扫描的活动档案字节数"成正比：档案为空、只有一个实例、
  或每次写入都改变档案（例如每次都要归档/轮转）时收益相应缩小——但即使档案被改写，
  也只会重扫**被改写的那一个文件**，其余文件仍命中。
- 备忘只在同一进程内生效：进程重启后的首次 `load()` 仍然完整扫描，这正是恢复面本身。
- 身份改动的收益与"每次写入被重算身份的冷行数"成正比，与行的字段数量成正比；档案为
  空或来源集合全在热层时没有收益。它同时降低了任何调用 `knowledgeKeyOf()` 的路径
  （含 `canonicalKnowledgeKey()` 的兜底分支）的逐行成本。

**内存。** `archive-scan-memo.mjs --retained --expose-gc` 实测（两个活动档案共
20,000 个活动键，其中 knowledge 档案 18,532,794 B ≈ 17.674 MiB）：在产生这些记录的
实例被回收之后，
备忘仍保留 **1,428,240 B ≈ 1.36 MiB**（≈71 B/键，含索引条目），即每 10,000 行活动键
约 0.7 MiB；该数字随基准 JSON 一并保存。备忘上限 32 条，按同尺寸推导的最坏情形约
22 MiB（**推导值**，本轮没有在 32 条满负荷下测量）。备忘与实例在记录侧与命中侧都各自
持有 `Set` 副本、条目也是深拷贝，不共享可变状态；作为对比，改动前每次写入会同时持有
两个实例各自的 `archiveActiveKeys`，备忘把这份状态在进程内复用，而不是额外长期保留
多份。

**本轮未消除、已实测的剩余成本。** 工作树上一次写入 134.6 ms 中，约 **56 ms** 是
`#readArchiveSync()`：解析 knowledge 冷档案找 canonical 行 45.2 ms + 解析 observations
冷档案找同主体行 11.0 ms（同一探针在 2 次写入上的两次读数 46.7 / 43.7 与 11.8 / 10.2）。
这不是一次事务内的重复，而是每次写入为回答"这个主体的 canonical 行是什么"和"有没有同
主体的来源行"必须做的读取；要消除它需要跨调用缓存整段解析结果（内存与对象别名风险都
更大），超出本轮范围。采样归因（工作树，20,000 + 20,000 行身份负载，596 个样本，同样是探针运行）：
`normalizeText` 自身 28.4%、两处折叠 6.6%、`stableStringify` + `compactValue` + hash
6.9%、GC 6.7%。

**被放弃的候选（都有实测或可判定的依据）。**

1. **按维度提前短路身份比较**（先比维度、只在全等时才验 hash）。它的上界可以量化：
   基准语料里前 4 个维度对所有行都相等、第 5 个维度才出现差异（用
   `normalizeKnowledgeEvent().dimensions` 逐维对照可复现），因此最多只能省下第 6 个维度
   （约 7%）加 hash（6.9%）≈ 身份成本的 14%、约 10 ms/万行（相当于端到端 7%），而它把
   `hash(dims) === targetHash` 换成 `dims === targetDims`，在 sha256 前缀碰撞时与现行
   行为不同——本仓库要求这一路径的行为等价，因此放弃。
2. **跨调用缓存整段解析结果（`#readArchiveSync` 备忘）**。收益大（每次写入 56 ms），
   但要把 10,000 行解析后的对象长期留在进程内，并把同一批行对象交给多个实例的保留
   决策与返回路径使用；对象隔离与内存边界都需要单独设计与证据，超出本轮"最小有效
   修改"，留作下一轮候选。
3. **融合 `normalizeText()` 的短语替换**。六次 `\b(?:…)\b` 替换是顺序执行的，后一次会
   命中前一次产生的新文本：`normalizeText("network error")` 先变成 `network-error`，
   随后被 `\b(?:failed|failure|errors?)\b` 改成 `network-failure`（已实测）。
   融合成一次替换会改变这个结果，除非逐条证明顺序无关，本轮不做。
4. **跨调用身份缓存**。`knowledgeKeyOf()` 是纯函数，但 memo 键必须覆盖约 50 个字段的
   读取顺序与 `first()` 的空对象/空数组语义，键的计算成本已接近被省下的工作，且需要
   一个无法自然失效的进程级表，放弃。

## 6. 验证

```sh
node --test test/dockyard-domain/archive-index-equivalence.test.js
node --test test/dockyard-domain/knowledge-identity-equivalence.test.js
node --test test/dockyard-domain/housekeeping-equivalence.test.js
npm test
npm run pack:check
npm run release:verify
```

**差分等价。** 两处改动都有以固定产物为基线的差分测试：
`archive-index-equivalence.test.js` 的"每个 archive 形状逐字节一致"用例在
"fresh reconcile, then a restart against the written index"等四个场景里比较索引文档、
档案字节、封闭段与 `archiveActiveKeys`；`knowledge-identity-equivalence.test.js`
比较 `normalizeKnowledgeEvent()`、`knowledgeKeyOf()`、`canonicalKnowledgeKey()` 与整条
append 路径的落盘字节，语料本轮扩充了折叠类与显式 key 的形状。
`archive-index-baseline.js` 的逆变换表新增了本轮备忘区块，rc.7 → 工作树的组合重建仍与
rc.7 固定产物逐字节相同（175,312 字节）。

**新增回归（备忘）。** 独立的
`test/dockyard-domain/archive-scan-memo.test.js` 里有
"the active-archive scan memo only answers for the bytes this process scanned"：
未变字节的第二次 reconcile 必须 **0 次**解析活动行、不得重写索引文档；档案在本进程
持有备忘期间被追加后必须**全量重扫**（追加行必须成为活动键、
`physicalCount`/`logicalCount`/`byteSize` 与恢复保留的字节都要对）；同一路径换成新
inode 后必须重扫；活动键集合在**记录侧与命中侧**都不得与备忘共享——独立复核正是用
"记录侧共享"这一条复现出一个真实缺陷（首次扫描的 `Set` 被暂存追加污染后，旧 inode
的备忘条目会声称磁盘上不存在的键，后续追加会少计 `logicalCount`），已改为两侧都持有
副本。**故障注入**（注入后已还原，每次只跑该用例）：

用例单独成文件是有意的：`archive-index-equivalence.test.js` 在导入时就要求"当前源码与
逆向重建逐字节一致"，对源码做故障注入会先触发那个形状守卫，行为断言根本不会执行——那样
的注入只会证明形状守卫有效，而不是证明行为用例有效。单独的文件不依赖任何基线，注入后
执行的是真正的行为断言。**故障注入**（注入后已还原，每次只跑该文件）：

| 注入 | 结果 |
| --- | --- |
| 命中条件去掉 `size`/`mtimeNs`（只看 inode） | 失败：`an appended line must be scanned, not served from the memo` |
| 备忘从不写入（每次重扫） | 失败：`unchanged bytes must not be rescanned` |
| 命中时直接把备忘的 `Set` 交给实例 | 失败：`a reusing instance must not share its key set with the memo` |
| 记录扫描结果时直接存入调用方的 `Set` | 失败：`the instance that produced the memo entry must not share its key set with the memo` |
| 记录扫描结果时直接存入调用方的条目对象 | 失败：`an instance must not share its index entry with the memo` |
| 命中时直接交出备忘的条目（不拷贝） | 失败：`a reusing instance must not share its index entry with the memo` |
| 备忘键丢掉 collection | 失败：条目里的 `segmentId`/`collection` 变成了另一个 collection |
| 备忘键忽略 inode（用 `size` + `mtimeNs` 作键） | 失败：`a new inode with the same size and mtime must be scanned` |
| 命中条件去掉 `size`（保留 `mtimeNs`） | 失败：`a grown file with a restored mtime must be scanned` |
| 命中条件去掉 `mtimeNs`（保留 `size`） | 失败：`an in-place rewrite with the same size must be scanned` |
| 备忘键丢掉文件名（保留 collection + inode） | 失败：`an entry must keep the name it was scanned under` |

**新增回归（身份）。** `knowledge-identity-equivalence.test.js` 新增
"a canonical-looking stored key never overrides the dimensions"，把
"存储 key 不覆盖维度"与"没有维度信号且显式 key 规范化后为空则不是知识"两条规则独立
钉住（不依赖固定产物）。把显式 key 兜底分支删除后该文件 3 项失败，证明用例覆盖了新
代码路径。折叠等价性由 4.3 的穷举证明承担：它是**值保持**的改动，因此测试不可能靠
行为差异发现它，只能靠穷举与固定产物差分共同锁定。

**全量测试**：`npm test` 322 项，**320 通过**，2 项失败，均为
`test/release-pin.test.mjs` 的固定点守卫（`the working tree still builds exactly the
pinned content`、`every shipped file in the tree matches the artifact byte for byte`）。
`lib/` 是分发路径，这两项对任何改动过它的提交都会失败，属于预期：
本轮不提升版本、不重新固定。`npm run release:verify` 仍通过（`release/` 中 rc.10 的
字节与内容摘要未改动）；`npm run pack:check` 为 13 ok / 3 FAIL，3 项分别是
`the committed acceptance evidence matches this exact package content`、
`release/manifest.json pins this tree content`、`the working tree still builds the
pinned content`——都是"`lib/` 已改而固定点未动"的预期结果，不是需要隐蔽的真失败。

**独立对抗式复核。** 本轮改动经一轮独立对抗式复核（另一个模型、独立 worktree、
只读授权），它复现了两个真实问题，都已修复并重新验证：

1. **记录侧共享 `Set`（真实缺陷）。** 首次扫描时 `rememberArchiveScan()` 直接把实例的
   活动键集合存进备忘：暂存实例随后把新键写进自己的集合，也就同时写进了**活树 inode**
   的备忘条目；该 inode 的字节并未改变，所以身份仍然有效，命中它的实例会拿到磁盘上
   不存在的键，后续追加还会少计 `logicalCount`。修复：备忘在记录侧持有自己的副本
   （`new Set(activeKeys)`），命中侧继续复制；用例新增"记录侧"方向断言，注入该缺陷
   立即失败。
2. **折叠等价性被表述得过强。** 两个完整模式在任意字符串上并不等价
   （`"ſdeadbeef"`：`iu` 的 `\b` 把 U+017F 当词字符），原证明只覆盖了字符类与一个不含
   该字符的语料。修复：把命题收窄为"在 `normalizeText()` 的 NFKC 管线内等价"，并把验证
   脚本扩成四步（字符类逐码点、`\b` 差异集、NFKC 存活者、管线输入上的整模式比较），
   同时把一般性反例钉住（见 3.2）。

复核还纠正了三处表述：本文件的测试计数（316/314 已过时，现为 322/320）、故障注入的
方法（源码注入会先触发基线形状守卫，行为断言不会执行，因此备忘用例已拆成独立文件并
按实际触发的断言记录）、以及备忘内存的"最坏约 25 MB"（现为实测 1,428,240 B / 20,000 键，
外加明确标注的推导上限）。它同时确认惰性 explicit key 的差异范围比本文原先披露的更宽
（带副作用 getter 可改变返回的 key 而不只是抛错），第 7 节已更新。

第二轮定向复核（对象为第一轮修复后的提交）确认上述修复成立——键集与条目在两侧都已隔离、
collection 已入键、getter 差异已披露、恢复措辞已纠正——同时提出四项新问题，都已修掉：

1. **REAL：同 collection、不同文件名的硬链接仍返回错的 `entry.file`。** 条目里的 `file`
   是扫描路径的 basename，而键里没有它；把 `a.json.observations-archive.jsonl` 硬链接成
   `b.json.observations-archive.jsonl` 后，第二个实例拿到的是 `a.json…`。落盘函数会重填
   `file`，所以持久索引仍正确，偏差限于内存条目（以及由此产生的一次多余索引重写）。
   修复：文件名进键；用例新增"条目保留它被扫描时的文件名"。
2. **CAVEAT：inode 分量其实可区分。** 把两个文件的 mtime 先 pin 到整秒即可构造
   size 与 `mtimeNs` 相同、inode 不同的反例（见 3.1）。修复：为 inode / size / mtime /
   文件名四个分量各加一条场景，四个注入现在都失败；备忘用例共五项。
3. **CAVEAT：首次加载的解析数只记录、未断言。** 修复：脚本断言它必须等于活动行总数
   （20,000），把该计数改成 0 会直接失败。
4. **CAVEAT：折叠验证没有锚定生产代码的预处理。** 脚本复制了模式与 NFKC 管线，把生产
   `knowledge.js` 的 `NFKC` 改成 `NFC` 时脚本仍会通过。修复：新增"生产锚"阶段，对
   U+017F / U+212A / Ａ / ① 四个码点断言"含该码点的记录与含其 NFKC 形式的记录身份相同"，
   注入 `NFC` 立即失败。

复核还纠正了几处文档表述（旧数字、单位、"条目只含标量"、"任一维度非空即有信号"、
`knowledge.js` 里关于 `\b` 的注释、内存数字与探针数据的出处），都已按本轮实测更新。

修复后重新执行：全量测试、两个隔离基准与端到端基准（本文表格均为修复后的数字）、备忘
用例的十一项注入，以及两个宿主的完整验收。

**双官方宿主真实验收。** 用当前工作树打包出候选产物（
`node scripts/release/pack.mjs --dist <临时目录>`，51 项，两次打包字节一致：
`sha256 6371e8f5…`、`contentSha256 07188a51…`）并对两个受支持宿主各跑完整 21 步
验收（安装官方 DSH → 官方插件 CLI 安装 → doctor → 核心流程 → 生命周期禁用/启用 →
卸载/重装 → 升级/回滚 → promotion → 最终 doctor），两个宿主 **21/21 步全部
`ok: true`**（含 `promotion-promote` / `promotion-restart-and-rollback` / `promotion-verify`
与 `cli-upgrade` / `cli-rollback`），证据见
[`docs/evidence/write-path-reconcile-identity-dsh-0.2.0-rc.2.json`](../evidence/write-path-reconcile-identity-dsh-0.2.0-rc.2.json)
与
[`docs/evidence/write-path-reconcile-identity-dsh-0.2.1-alpha.1.json`](../evidence/write-path-reconcile-identity-dsh-0.2.1-alpha.1.json)。
两份证据里的 `doctor` 区块与上一轮验收记录逐字节相同（`status: degraded`，即
`evaluator-advisory` / `continuous-and-governance-not-wired` / `host-only-promotion`
等已声明的能力边界，不是回归）。证据里记录的 `contentSha256` 是当前工作树的候选内容
摘要（`07188a51…`，即两轮复核修复后的字节），与固定点 rc.10 的 `1749210691d2…` 不同——**本轮没有覆盖 rc.10 的固定产物，也没有
执行 `release:publish` 或任何外部发布**。

## 7. 剩余风险

- 改动只在合成负载与本机沙箱中测量；真实宿主验收验证的是安装、生命周期、持久化与
  promotion 行为，不是性能数字。
- 备忘的正确性依赖"档案只会被本进程改写，或被改写时身份必然变化"。本插件在生命周期内
  持有 `domain-archive.lock`，且 `archive-stage.js` 已用同一组身份做等价判断；但如果
  未来出现**绕过该锁**的外部写者，且在同一个时间戳粒度内以**完全相同的字节数**改写同一
  inode，备忘会给出该 inode 上一次扫描的结果。`size` + `mtimeNs`（bigint 纳秒）+ inode
  三者同时不变才可能发生，仓库内没有这样的写者。**本轮没有在粗时间戳粒度文件系统上
  验证**（例如 1 秒粒度的 HFS+），也**没有强制制造真实的 inode 复用**；两者的风险都是
  "外部写者 + 时间戳无法区分"，但在这些平台上没有实测证据。
- 备忘是进程级的：同进程内多个 `EvolutionMemory` 实例共享它。它只按身份回答，并在记录
  与命中两侧都复制活动键集合、并对索引条目做深拷贝；条目里可以有对象值（档案行的
  `recordedAt` 就是），深拷贝对它们同样成立。
- 身份改动的等价性只成立于 `normalizeText()` 的管线内（NFKC 之后的文本里不可能出现
  U+017F/U+212A）：两个完整模式在任意字符串上不等价（反例 `"ſdeadbeef"`，已由脚本
  钉住）。若将来有人把这两处折叠移到 NFKC 之前、或复用到别的管线里，这条论证不再适用。
  `normalizeText()` 的其余顺序敏感行为（见 5.3）未改动，也没有被本轮简化。
- 惰性 explicit key 改变的是**求值时机**，因此对带副作用 getter（或会在读取过程中被改
  写）的非 JSON 输入，可观察差异不止"抛不抛错"：显式 key 的规范化从维度读取之前移到
  之后，一个在维度读取时改写显式 key 的 getter 可以让 `hasSignal` 从假变真（返回 key 而
  不是 `null`），也可以让参与 hash 的维度值不同（返回不同的 key）。独立复核给出了这类
  反例；领域内的记录来自 `JSON.parse`，不可能带 getter，`knowledgeKeyOf()` 的仓库内
  调用点只有 `#sourceMatches()`，它作用在已解析的档案行上。

## 8. 复现

```sh
# 单改动变体（main = ed4cbb6 的 lib/；另两个 = 工作树 + ed4cbb6 的单文件）
# ed4cbb6 是本轮开始前的 main；换成任何"本轮改动之前的提交"都可复现同一比较。
mkdir -p /tmp/dsh-round/variants && cd /tmp/dsh-round/variants
for name in main main-plus-memo main-plus-identity; do cp -R "$OLDPWD/lib" "$name"; done
git -C "$OLDPWD" show ed4cbb6:lib/dockyard-domain/knowledge.js > main/dockyard-domain/knowledge.js
git -C "$OLDPWD" show ed4cbb6:lib/dockyard-domain/memory.js    > main/dockyard-domain/memory.js
cp main/dockyard-domain/knowledge.js main-plus-memo/dockyard-domain/knowledge.js
cp main/dockyard-domain/memory.js    main-plus-identity/dockyard-domain/memory.js
ln -sfn "$OLDPWD/node_modules" /tmp/dsh-round/node_modules

cd "$OLDPWD"
node scripts/benchmarks/observe-cold-archive.mjs --rows 10000 --knowledge-rows 10000 \
  --rounds 3 --warmup 1 --samples 5 \
  --variant /tmp/dsh-round/variants/main \
  --variant /tmp/dsh-round/variants/main-plus-memo \
  --variant /tmp/dsh-round/variants/main-plus-identity
node --expose-gc scripts/benchmarks/archive-scan-memo.mjs --rows 10000 --knowledge-rows 10000 \
  --rounds 3 --warmup 1 --samples 5 --retained
node scripts/benchmarks/knowledge-identity-cost.mjs --rows 10000 --knowledge-rows 10000 \
  --rounds 3 --warmup 1 --samples 5 --lib /tmp/dsh-round/variants/main-plus-memo
```

第 1 节的两组归因来自探针运行（不在三份基准 JSON 中），复现方式：

```sh
# 每个活动档案的读取/解析耗时（在 mutate() 的两次 load 里打印）
node --cpu-prof --cpu-prof-dir=<目录> scripts/benchmarks/observe-cold-archive.mjs \
  --rows 10000 --knowledge-rows 10000 --rounds 1 --warmup 0 --samples 2
# 身份路径的 CPU 归因（改动前一侧用 --lib 指向 main-plus-memo，改动后一侧用工作树）
node --cpu-prof --cpu-prof-dir=<目录> <身份探针> --lib /tmp/dsh-round/variants/main-plus-memo
```

`--cpu-prof` 的样本按 URL 分侧读取自帧名；`scripts/benchmarks/knowledge-identity-cost.mjs`
本身就是身份负载的可复现入口。

三个脚本都自带基线：`observe-cold-archive.mjs` 与 `archive-scan-memo.mjs` 从
`release/manifest.json` 指定的固定产物解包出 rc.10 的 `lib/` 并直接 import；
`knowledge-identity-cost.mjs` 用固定产物提供值锚，用 `--lib` 树提供成本对照。
`--json` 输出完整原始样本（本目录下三份 JSON 就是上表的原始输出，按上面的顺序原地收集）。
测量期间不要并行运行测试或其它基准。
