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
没有并行运行测试或其它基准。三个基准脚本都在同一进程内轮换各侧、每侧每轮断言落盘
字节逐字节相同，任何保留决策或索引分歧都会让脚本非零退出。

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
rc.10 的一次事务里，"硬链接镜像的 `load()`" 61.8 ms + "提交后活树的 `load()`" 61.8 ms
= **123.6 ms**，而作为对照的"活树首次 `load()`"（本来就必须读字节）只有 65.2 ms。

### 1.2 `#sourceMatches()` 逐行重算身份，且折叠写法最贵

`#append()` 每次写入都要 `#sourceMatches()`：对来源集合的**完整历史**逐行判断
"这一行是不是同一主体"。行既可按**存储的** `knowledgeKey` 命中，也可按**从自身字段
重算出的** canonical key 命中，两者都不能省，因此每个冷行都要跑一次
`knowledgeKeyOf()`：6 个维度各一次文本规范化，再加一次 hash。10,000 行 observations
冷档案的重算是 **73.3 ms**（隔离基准，三轮 15 个样本中位数），10,000 行 knowledge
冷档案（行更大）是 **132.1 ms**。

`normalizeText()` 里的两处标识符折叠原来写作 `/\b[0-9a-f]{8,}\b/giu` 与
`/\b[0-9a-f]{4,}-[0-9a-f-]{4,}\b/giu`：`i` 与 `u` 同时开启是这两个类最贵的写法，
在改动前的采样里占逐行身份成本的 **24.1%**（`\b[0-9a-f]{8,}\b` 11.4% +
`\b[0-9a-f]{4,}-[0-9a-f-]{4,}\b` 12.7%，1,541 个样本）。

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
  `hasSignal` 的真值判断和"以 `knowledge:` 开头就返回它"的分支；现在六个维度只要有一个
  非空就直接返回 `hash(dimensions)`，只有**没有任何维度信号**时才规范化 explicit key
  并走原分支。逐行身份因此少一次完整的文本规范化。

## 3. 等价性依据

### 3.1 备忘只回答"本进程已经扫过的那一份字节"

- 扫描本身没有被删除：`#reconcileActiveArchive()` 对每个身份未记录的档案仍执行完整的
  读取、解析、索引重建与 `archiveActiveKeys` 重建，`#reconcileArchiveIndex()` 的
  `changed` 判定、索引文档写入、封闭段的 `sha256` + `byteSize` 早退都未改动。
- 备忘按 `(dev, ino)` 索引，但**只在 `size` 与 `mtimeNs` 都与记录一致时命中**。插件
  对档案的每一种改动都会改变这个身份：追加使 `size` 增长；seal、compaction 与
  `installArchiveFiles()` 都换 inode；compaction 回滚把原 inode 改名回来，其记录身份
  仍然描述它自己的字节。
- 命中时交给实例的是**新的 `Set`**，不是备忘里的那个对象；备忘里的条目对象也只被浅拷贝
  展开后使用（条目只含标量字段）。对象隔离与改动前一致。
- 恢复面语义未变：进程启动、索引文件丢失、档案被外部改动（`size`/`mtime` 变化）都会
  重新扫描；备忘随进程消失，崩溃恢复仍然从磁盘重建。

### 3.2 折叠等价：逐码点穷举

`[0-9a-f]` 配 `i` + `u` 接受的码点集合与 `[0-9a-fA-F]`（不带 `i`）完全相同——这不是
推理，而是穷举：`knowledge-identity-cost.mjs` 的折叠阶段对**全部 1,112,064 个非代理码
点**逐一比较两个类的成员关系，并对 `\b` 参与的两个完整模式比较整串 `replace` 结果，
外加 41,374 个由 `a f F g z 0 9 - : 空格 \t é Ａ ᴋ` 组成的 0–4 字符串与真实
标识符样本，共 **1,153,438 个字符串、0 处差异**。`\b` 在 `u` 与非 `u` 下都是 ASCII
词字符边界，模式里没有代理对，因此去掉 `u` 只影响已经消失的 `i` 折叠。

### 3.3 维度决定 canonical key；explicit key 只在没有维度信号时被读取

`normalizeText()` 的输出字符集是"字母、数字、`<`、`>`、`.`、`'`、`-`、空格"：最后两步
`[_\/\\|:]+ → " "` 与 `[^\p{L}\p{N}<>.'-]+ → " "` 会去掉 `:`，其后的短语替换、空白
折叠与截断都只会引入字母、连字符、空格与省略号。因此
`explicitKey.startsWith("knowledge:")` 恒为假，canonical key 恒为
`"knowledge:" + hash(dimensions)`；显式 key 唯一还能起作用的地方就是
`hasSignal` 的真值判断，而那六个维度里只要有一个非空就已经确定。改动只把这次规范化
挪到"确实需要它"的分支，返回值不变。

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
| 固定产物 rc.10 | 564.689 | — | 681.577 | — |
| `main`（上一轮收口） | 286.623 | −49.24% | 297.598 | −56.34% |
| `main` + 备忘 | 162.504 | −71.22% | 155.104 | −77.24% |
| `main` + 身份 | 262.283 | −53.55% | 271.609 | −60.15% |
| `main` + 备忘 + 身份（工作树） | **138.032** | **−75.56%** | **128.558** | **−81.14%** |

本轮两个改动的边际值（相对 `main`）：备忘 **−124.119 ms（−43.30%）**、
身份 **−24.340 ms（−8.49%）**、两者合计 **−148.591 ms（−51.84%）**；两个边际之和
（148.5 ms）与合测值一致，说明两者互不遮蔽。

逐轮中位数（每轮 5 个样本的中位数，顺序为轮换后的实际执行顺序）：

| 轮 | 固定产物 | `main` | `main`+备忘 | `main`+身份 | 工作树 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 567.966 | 286.623 | 162.504 | 264.885 | 138.533 |
| 2 | 564.689 | 287.398 | 163.372 | 262.283 | 136.280 |
| 3 | 560.967 | 285.458 | 161.069 | 262.078 | 138.032 |

### 4.2 隔离：一次事务内的两次 reconcile（备忘）

```sh
node scripts/benchmarks/archive-scan-memo.mjs --rows 10000 --knowledge-rows 10000 \
  --rounds 3 --warmup 1 --samples 5
```

被测单元就是 `mutate()` 自己的序列：`mirrorArchives()` 活树（硬链接，与 `mutate()`
一致）后对镜像建实例并 `load()`，再对提交后的活树建实例并 `load()`；另测"活树首次
`load()`"作为对照（它本来就必须读字节）。基线是固定产物 rc.10 的
`lib/dockyard-domain/memory.js`；已核对 rc.10 与 `ed4cbb6` 的 `#reconcileArchiveIndex()`
区块逐字节相同，因此该差值只归因于本轮备忘。

| 阶段 | rc.10 (ms) | 工作树 (ms) | 变化 |
| --- | ---: | ---: | ---: |
| 活树首次 `load()`（对照） | 65.243 | 62.706 | −3.9%（噪声内） |
| 硬链接镜像的 `load()` | 61.818 | 0.860 | **−98.61%** |
| 提交后活树的 `load()` | 61.788 | 0.754 | **−98.78%** |
| 一次事务的 reconcile 合计 | 123.606 | 1.614 | **−98.69%** |

确定性指标（与机器噪声无关）：两次 `load()` 各自被扫描助手解析的活动档案行数
**20,000 → 0**，三轮全部相同；同时断言两侧的索引文档、`archiveActiveKeys`、
档案字节逐字节相同。

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
| 10,000 行 observations 冷档案 | 73.307 | 50.175 | **−31.56%** | 73.362 | 50.228 | −31.53% |
| 10,000 行 knowledge 冷档案 | 132.088 | 89.604 | **−32.16%** | 132.186 | 89.699 | −32.14% |

折叠阶段：1,112,064 个码点 + 1,153,438 个字符串，**0 处差异**（见 3.2）。

## 5. 收益边界与取舍

**收益边界。**

- 备忘的收益与"一次事务里被重复扫描的活动档案字节数"成正比：档案为空、只有一个实例、
  或每次写入都改变档案（例如每次都要归档/轮转）时收益相应缩小——但即使档案被改写，
  也只会重扫**被改写的那一个文件**，其余文件仍命中。
- 备忘只在同一进程内生效：进程重启后的首次 `load()` 仍然完整扫描，这正是恢复面本身。
- 身份改动的收益与"每次写入被重算身份的冷行数"成正比，与行的字段数量成正比；档案为
  空或来源集合全在热层时没有收益。它同时降低了任何调用 `knowledgeKeyOf()` 的路径
  （含 `canonicalKnowledgeKey()` 的兜底分支）的逐行成本。

**内存。** 备忘上限 32 条，每条保存一个索引条目与一个活动键 `Set`（10,000 行约 0.8 MB），
最坏约 25 MB；命中时实例拿到的是 `Set` 的副本，因此实例之间不共享可变状态。作为对比，
改动前每次写入会同时持有两个实例各自的 `archiveActiveKeys`，备忘把这份状态在进程内
复用，而不是额外长期保留多份。

**本轮未消除、已实测的剩余成本。** 工作树上一次写入 138 ms 中，约 **56 ms** 是
`#readArchiveSync()`：解析 knowledge 冷档案找 canonical 行 45.2 ms + 解析 observations
冷档案找同主体行 11.0 ms（同一探针在 2 次写入上的两次读数 46.7 / 43.7 与 11.8 / 10.2）。
这不是一次事务内的重复，而是每次写入为回答"这个主体的 canonical 行是什么"和"有没有同
主体的来源行"必须做的读取；要消除它需要跨调用缓存整段解析结果（内存与对象别名风险都
更大），超出本轮范围。采样归因（工作树，20,000 + 20,000 行身份负载，596 个样本）：
`normalizeText` 自身 28.4%、两处折叠 6.6%、`stableStringify` + `compactValue` + hash
6.9%、GC 6.7%。

**被放弃的候选（都有实测或可判定的依据）。**

1. **按维度提前短路身份比较**（先比维度、只在全等时才验 hash）。它的上界可以量化：
   基准语料里前 4 个维度对所有行都相等、第 5 个维度才出现差异（用
   `normalizeKnowledgeEvent().dimensions` 逐维对照可复现），因此最多只能省下第 6 个维度
   （约 7%）加 hash（6.9%）≈ 身份成本的 14%、约 7 ms/万行，端到端低于噪声；而它把
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

**新增回归（备忘）。** `archive-index-equivalence.test.js` 新增
"the active-archive scan memo only answers for the bytes this process scanned"：
未变字节的第二次 reconcile 必须 **0 次**解析活动行、不得重写索引文档、且不得与备忘
共享 `Set`；档案在本进程持有备忘期间被追加后必须**全量重扫**（追加行必须成为活动键、
`physicalCount`/`logicalCount`/`byteSize` 与恢复保留的字节都要对）；同一路径换成新
inode 后必须重扫。**故障注入**（注入后已还原，每次只跑该用例）：

| 注入 | 结果 |
| --- | --- |
| 命中条件去掉 `size`/`mtimeNs`（只看 inode） | 用例失败（追加行未被扫描） |
| 备忘键忽略 inode（用 size + mtime 作键） | 用例失败（换 inode 的文件未重扫） |
| 备忘从不写入（每次重扫） | 用例失败（未变字节仍被解析） |
| 命中时直接把备忘的 `Set` 交给实例 | 用例失败（键经实例泄漏到下一个实例） |

**新增回归（身份）。** `knowledge-identity-equivalence.test.js` 新增
"a canonical-looking stored key never overrides the dimensions"，把
"存储 key 不覆盖维度"与"没有维度信号且显式 key 规范化后为空则不是知识"两条规则独立
钉住（不依赖固定产物）。把显式 key 兜底分支删除后该文件 3 项失败，证明用例覆盖了新
代码路径。折叠等价性由 4.3 的穷举证明承担：它是**值保持**的改动，因此测试不可能靠
行为差异发现它，只能靠穷举与固定产物差分共同锁定。

**全量测试**：`npm test` 316 项，**314 通过**，2 项失败，均为
`test/release-pin.test.mjs` 的固定点守卫（`the working tree still builds exactly the
pinned content`、`every shipped file in the tree matches the artifact byte for byte`）。
`lib/` 是分发路径，这两项对任何改动过它的提交都会失败，属于预期：
本轮不提升版本、不重新固定。`npm run release:verify` 仍通过（`release/` 中 rc.10 的
字节与内容摘要未改动）；`npm run pack:check` 为 13 ok / 3 FAIL，3 项分别是
`the committed acceptance evidence matches this exact package content`、
`release/manifest.json pins this tree content`、`the working tree still builds the
pinned content`——都是"`lib/` 已改而固定点未动"的预期结果，不是需要隐蔽的真失败。

**双官方宿主真实验收。** 用当前工作树打包出候选产物（
`node scripts/release/pack.mjs --dist <临时目录>`，51 项，两次打包字节一致：
`sha256 a9863e19…`、`contentSha256 3f2d9231…`）并对两个受支持宿主各跑完整 21 步
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
摘要，与固定点 rc.10 的 `1749210691d2…` 不同——**本轮没有覆盖 rc.10 的固定产物，也没有
执行 `release:publish` 或任何外部发布**。

## 7. 剩余风险

- 改动只在合成负载与本机沙箱中测量；真实宿主验收验证的是安装、生命周期、持久化与
  promotion 行为，不是性能数字。
- 备忘的正确性依赖"档案只会被本进程改写，或被改写时身份必然变化"。本插件在生命周期内
  持有 `domain-archive.lock`，且 `archive-stage.js` 已用同一组身份做等价判断；但如果
  未来出现**绕过该锁**的外部写者，且在同一个时间戳粒度内以**完全相同的字节数**改写同一
  inode，备忘会给出该 inode 上一次扫描的结果。`size` + `mtimeNs`（bigint 纳秒）+ inode
  三者同时不变才可能发生，仓库内没有这样的写者。
- 备忘是进程级的：同进程内多个 `EvolutionMemory` 实例共享它。它只按身份回答，命中时
  复制 `Set`，但不复制索引条目里的对象引用——条目只含标量字段，若将来有人把对象/数组
  放进索引条目，需要同时改这里的复制方式。
- 身份改动让 `normalizeText()` 的折叠去掉 `i`：等价性由逐码点穷举（1,112,064 个码点）
  与固定产物差分锁定。`normalizeText()` 的其余顺序敏感行为（见 5.3）未改动，也没有被
  本轮简化。
- 惰性 explicit key 改变的是**求值时机**：对一个"其他维度已有信号、且显式 key 会让
  `normalizeText()` 抛错"的非 JSON 输入（例如含 `BigInt` 的显式 key），工作树不再抛错。
  领域内的记录来自 `JSON.parse`，不可能包含这类值；`knowledgeKeyOf()` 的仓库内调用点
  只有 `#sourceMatches()`，它作用在已解析的档案行上。

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
node scripts/benchmarks/archive-scan-memo.mjs --rows 10000 --knowledge-rows 10000 \
  --rounds 3 --warmup 1 --samples 5
node scripts/benchmarks/knowledge-identity-cost.mjs --rows 10000 --knowledge-rows 10000 \
  --rounds 3 --warmup 1 --samples 5 --lib /tmp/dsh-round/variants/main-plus-memo
```

三个脚本都自带基线：`observe-cold-archive.mjs` 与 `archive-scan-memo.mjs` 从
`release/manifest.json` 指定的固定产物解包出 rc.10 的 `lib/` 并直接 import；
`knowledge-identity-cost.mjs` 用固定产物提供值锚，用 `--lib` 树提供成本对照。
`--json` 输出完整原始样本（本目录下三份 JSON 就是上表的原始输出，按上面的顺序原地收集）。
测量期间不要并行运行测试或其它基准。
