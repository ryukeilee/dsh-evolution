# 记录路径：为一次查找深拷贝整段冷 knowledge 档案

本轮只删除 `lib/dockyard-domain/memory.js` 记录路径上一次"整段冷档案深拷贝只为取
其中一行"的重复工作。不新增缓存层，不改变持久化格式、认证、fsync、事务、恢复、
回滚与 promotion 边界，也未修改官方 DSH 源码与任何已发布的固定产物。基线是当前
固定点 `release/dsh-evolution-0.2.0-rc.10.tgz` 中的 `lib/`（`sourceCommit 3e29cd3`，
其 `lib/` 与 `HEAD 0f866c0` 逐字节相同），基准直接解包该固定产物后 import，不靠
人工重写基线。原始逐轮样本见 [`experience-recall-archive.json`](experience-recall-archive.json)
与 [`observe-cold-archive.json`](observe-cold-archive.json)。

本轮与上一轮（`#sourceMatches` 的无拷贝扫描 + 身份重算）属同一条路径、同一主题，
两者的实测数据在本文与 [`experience-recall-archive.md`](experience-recall-archive.md)
中分别给出，互不重复。

环境：Node `v26.11.1` / darwin-arm64（Darwin 27.0.1），Apple M2，8 逻辑 CPU、
16 GiB 内存。机器并非空闲：本文引用的两组 A/B 在 load average
`1.80 / 1.73 / 1.78` 至 `2.11 / 1.80 / 1.80`（1/5/15 分钟）之间完成，两组交替
进行；测量期间没有并行运行测试或其它基准。

## 1. 瓶颈与改动

`#append()` 在写入前要回答一个问题："这个主体的 canonical knowledge 行是什么？"
`#knowledgeEntryFor(event)` 的实现是
`this.history("knowledge").find((entry) => entry?.knowledgeKey === event.knowledgeKey || entry?.id === event.knowledgeKey)`。
`history()` 的公开契约是"返回与内部状态脱离的记录"，因此它走
`#mergeArchived()` 的默认 `copy: true`：读取、JSON 解析、按 id 完成 latest-wins
合并，然后对**每一行**执行 `structuredClone`。也就是说，为了读取一行，它先把
整段冷档案完整复制一遍，再把其中 9,999 行丢掉。

单进程内 5 次中位数的归因（10,000 行 cold knowledge 档案，行内容与
`experience-recall-archive.mjs` 的 `knowledgeRow` 逐字段一致；只用公开方法
`history()` / `historyWindow()`，不依赖类内私有路径）：

| 子操作 | 中位数 |
| --- | ---: |
| `history('knowledge')`（读取 + 解析 + 合并 + 全量深拷贝） | 131.0 ms |
| `historyWindow('knowledge', 1)`（同一读取 + 解析 + 合并，`copy: false`） | 47.4 ms |
| `structuredClone` 命中那一行 | 0.002 ms |

即约 84 ms（**约 64%**）的深拷贝完全没有被读取。改动只有一处：

```js
#knowledgeEntryFor(event) {
  if (!event?.knowledgeKey) return null;
  const entry = this.#mergeArchived("knowledge", this.#data.knowledge, { copy: false })
    .find((candidate) => candidate?.knowledgeKey === event.knowledgeKey || candidate?.id === event.knowledgeKey);
  return entry === undefined || entry === null ? null : clone(entry);
}
```

**等价性**：`history(collection)` 的定义就是
`this.#mergeArchived(collection, this.#data[collection])`，而它在无冷档案时是
`hot.map(clone)`、有冷档案时是 `merged.map(clone)`；即"同一份 `#mergeArchived`
视图逐行深拷贝"。新实现扫描同一份视图（同一函数、同一顺序、同一 latest-wins
语义、同一 tombstone 过滤），谓词因此作用在逐字段相同的行上，取到同一行；命中后
仍然 `clone()` 它，所以调用方拿到的仍然是完全脱离的深拷贝——对象隔离契约与
`history()` 一致，`#upsertKnowledgeUnlocked` 里 `mergeKnowledgeEntry(previous, …)`
的输入也仍然是脱离副本，不会与内部行建立引用关系。唯一的差异是未被选中的行不再
被复制，而它们本来也不会被返回。

## 2. 实测（严格交替 3 轮，每进程 1 次预热 / 7 或 5 次正式样本）

收口时对同一份代码做了两组 A/B，每组都从固定产物 rc.10 出发、在同一时段交替运行，
两组只差一处：

- **A 组**：rc.10 → 只含上一轮改动的树（无拷贝源扫描 + 身份重算 + 一次查找）；
- **B 组**：rc.10 → 当前工作树（在 A 组基础上再加本轮查找拷贝改动）。

本节表格引用 B 组并给出两步的边际值；A 组与两步的完整逐轮样本在
[`experience-recall-archive.json`](experience-recall-archive.json) 与
[`observe-cold-archive.json`](observe-cold-archive.json) 的 `stages` 中。

```sh
node scripts/benchmarks/experience-recall-archive.mjs --rows 10000 --rounds 3 --warmup 1 --samples 7
node scripts/benchmarks/observe-cold-archive.mjs --rows 10000 --knowledge-rows 10000 --rounds 3 --warmup 1 --samples 5
node scripts/benchmarks/observe-cold-archive.mjs --rows 10000 --rounds 3 --warmup 1 --samples 5
```

两个脚本都在同一进程内轮流跑两侧，基线由固定产物解包得到；每一轮都断言两侧
落盘字节（以及端到端场景的整棵 `dockyard/` 树）逐字节相同，任何保留决策分歧都会
让脚本直接失败。下表是三轮中位数的中位数，未混入预热。

| 路径（10,000 行 cold 档案） | rc.10 wall | 当前工作树 wall | wall Δ | rc.10 CPU | 当前工作树 CPU | CPU Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `recordObservation`，knowledge 档案 | 268.634 ms | 46.573 ms | **−82.66%** | 358.967 ms | 51.431 ms | **−85.67%** |
| `port.observe()`，observations + knowledge 档案 | 562.03 ms | 284.35 ms | **−49.41%** | 685.24 ms | 293.69 ms | **−57.14%** |
| `recordObservation`，observations 档案（对照组） | 140.203 ms | 86.740 ms | −38.13% | 146.573 ms | 90.296 ms | −38.40% |
| `port.observe()`，仅 observations 档案（对照组） | 187.57 ms | 133.40 ms | −28.88% | 182.44 ms | 123.69 ms | −32.20% |
| recall + 投影（对照组，公开读取路径未改动） | 142.987 ms | 143.869 ms | +0.62% | 183.808 ms | 180.402 ms | −1.85% |

两步的绝对中位数（同一时段；两轮各自测得的固定点基线为 265.656 / 268.634 ms 与
560.76 / 562.03 ms，相差 1.1% / 0.2%，属机器漂移）：

| 路径 | rc.10 | A：上一轮改动 | 本轮边际（A → B） | 累计（rc.10 → B） |
| --- | ---: | ---: | ---: | ---: |
| `recordObservation`，knowledge 档案 | 265.656 ms | 133.932 ms | **−65.23%**（→ 46.573 ms） | −82.47% |
| `port.observe()`，双档案 | 560.76 ms | 377.12 ms | **−24.60%**（→ 284.35 ms） | −49.29% |
| `recordObservation`，observations 档案（对照） | 140.692 ms | 85.668 ms | +1.25%（→ 86.740 ms） | −38.34% |
| `port.observe()`，仅 observations（对照） | 187.45 ms | 132.61 ms | +0.59%（→ 133.40 ms） | −28.83% |
| recall + 投影（对照） | 142.553 ms | 142.098 ms | +1.25%（→ 143.869 ms） | +0.92% |

三个对照路径的 +0.59%…+1.25% 就是两轮之间的机器漂移量级，而受影响的两条路径
分别再降低 65% 与 25%：收益远超漂移，且每一轮两侧的样本范围不重叠。

逐轮值（每轮 7 或 5 次测量的中位数）：

| 路径 | 轮次 / 顺序 | rc.10 | 当前工作树 |
| --- | --- | ---: | ---: |
| knowledge 档案 append | 1 / baseline→candidate | 268.634 ms | 50.488 ms |
| | 2 / candidate→baseline | 268.983 ms | 46.573 ms |
| | 3 / baseline→candidate | 265.993 ms | 45.810 ms |
| `port.observe()`（双档案） | 1 / baseline→candidate | 562.0 ms | 282.7 ms |
| | 2 / candidate→baseline | 568.5 ms | 288.9 ms |
| | 3 / baseline→candidate | 561.5 ms | 284.3 ms |
| `port.observe()`（仅 observations，对照组） | 1 / baseline→candidate | 188.0 ms | 137.1 ms |
| | 2 / candidate→baseline | 187.6 ms | 133.4 ms |
| | 3 / baseline→candidate | 186.4 ms | 132.6 ms |

## 3. 收益边界

- 收益与**冷 knowledge 档案的规模**成正比：本改动省掉的是对该档案的一次全量
  `structuredClone`，每行成本与行的嵌套深度、字段数量成正比（本 fixture 的
  canonical knowledge 行含 `effectStats` / `effects` / `trend.recent` /
  `recentEvidence` / `sourceCounts` 等嵌套结构）。
- 没有 cold knowledge 档案时**未证实可测收益**：此时 `#mergeArchived` 只返回热层
  （`maxEntries` 上限 1000 行），且命中通常落在热层，复制量本来就很小。代码在热层
  分支上同样只 clone 命中行而不是整个热窗口，方向性上仍少复制，但本轮语料下两侧都在
  噪声内（前半轮约 0.25 ms 对 0.23 ms），因此不声称收益，也不断言“代码未省工作”。
- **收益不要求命中**：即使目标不在档案里（管线里最常见的情况），改动仍然省掉
  整段深拷贝——这正是上表 knowledge append 场景的情形。
- recall / 只读投影路径**未**改动。它经公开 `memory.history('knowledge')` 读取，
  仍然按契约返回脱离副本；因此该路径约九成的成本（读取 + 解析 + 合并 + 深拷贝）
  与本轮无关，对照组 +0.62% / −1.85%（两轮边际 +1.25% / +0.37%）也确认了这一点。
- 本轮没有涉及峰值内存、磁盘物理 I/O、小档案、其它平台或真实生产分布，也没有
  声称端到端 LLM 延迟下降。内存方面只能给出方向性结论：少一次 10,000 行的完整
  深拷贝意味着更少的瞬时分配与更少的 GC 压力（第 5 节的可复现 profile 中 GC 是
  可观的自身采样，但本文没有测量峰值 RSS）。

## 4. 验证

```sh
node --test test/dockyard-domain/knowledge-identity-equivalence.test.js
node --test test/dockyard-domain/housekeeping-equivalence.test.js test/dockyard-domain/archive-index-equivalence.test.js
node --test test/domain-storage/domain-storage-write-path-equivalence.test.js
npm test
npm run release:verify
```

**差分等价**。`test/dockyard-domain/knowledge-identity-equivalence.test.js` 新增一条
用例，把固定产物解包后直接 import 成基线（不重写实现），在一个同时包含
"只在冷档案里"与"冷档案 + 同 id 热层覆盖"两种主体的 cold knowledge 档案上跑两次
`recordObservation()`，断言：

- `state.json`、冷档案字节、`fullSnapshot()` 逐字节与基线相同；
- 两次 append 返回的记录 id 序列与基线相同（返回的是被记录的来源行，不是
  knowledge 累积行——这条断言防止"查找结果变了"被返回值的形状变化掩盖）；
- canonical 行集合与顺序相同；
- 只存在于冷档案的主体被**累积**到那一行（`count` 1 → 2），而热层覆盖的 id 仍然
  胜过档案副本（`count` 5 → 6，而不是 1 → 2）。这两个数字正是"查到了同一行"的
  证据；若查找漏掉冷档案或漏掉热层，`count` 会变成 1 或 2。
- 把返回记录（含嵌套字段）改写后，落盘字节与投影不变 → 对象隔离仍然成立。

**故障注入**。同一用例对两处注入敏感，证明它确实覆盖了新代码而非自我比较：
把查找改为只看热层（丢掉冷档案）→ 用例失败；把查找改为只看档案（丢掉热层覆盖）
→ 该用例与既有 `the append path stays byte-identical to the pinned implementation`
同时失败。注入后已还原。

**基线锚定**。`test/dockyard-domain/archive-index-baseline.js` 的逆变换表新增了本处
改动区域，使 rc.7 → 当前工作树的组合重建仍与 rc.7 固定产物逐字节相同
（`housekeeping-equivalence` / `archive-index-equivalence` 28/28 通过）。
`knowledge-identity-equivalence` 的 `the pinned baseline predates this change`
守卫仍有效：一旦下一次 re-pin 把 `knowledgeKeyOf` 带进产物，该测试会明确失败，
提示重新锚定。

**全量测试**：`npm test` 316 项，**314 通过**，2 项失败，均为
`test/release-pin.test.mjs` 的固定点守卫（`the working tree still builds exactly
the pinned content`、`every shipped file in the tree matches the artifact byte for
byte`）。这两项对任何改动过 `package.json#files` 内容的提交都会失败，属于预期：
`lib/` 是分发路径，改它就必须走"新版本 + 两个宿主重跑验收 + 重新固定"。
`npm run release:verify` 仍通过（`release/` 中 rc.10 的字节与内容摘要未被改动）；
`npm run pack:check` 为 13 ok / 3 FAIL，3 项失败分别是
`the committed acceptance evidence matches this exact package content`、
`release/manifest.json pins this tree content`、
`the working tree still builds the pinned content`——都是"`lib/` 已改而固定点未动"的
预期结果，不是需要隐蔽的真失败。

**双官方宿主真实验收**。用当前工作树打包出候选产物
（`node scripts/release/pack.mjs --dist <临时目录>`，`sha256 a14a6be7…`、
`contentSha256 5598a64b…`，51 项、两次打包字节一致），对两个受支持宿主各跑完整
21 步验收（安装官方 DSH → 官方插件 CLI 安装 → doctor → 核心流程 → 生命周期
禁用/启用 → 卸载/重装 → 升级/回滚 → promotion → 最终 doctor）：

```sh
node scripts/acceptance/run-host-acceptance.mjs --host 0.2.0-rc.2 \
  --tarball <临时目录>/dsh-evolution-0.2.0-rc.10.tgz \
  --out docs/evidence/cold-archive-write-path-dsh-0.2.0-rc.2.json
node scripts/acceptance/run-host-acceptance.mjs --host 0.2.1-alpha.1 \
  --tarball <临时目录>/dsh-evolution-0.2.0-rc.10.tgz \
  --out docs/evidence/cold-archive-write-path-dsh-0.2.1-alpha.1.json
```

两个宿主的 21/21 步全部通过，证据见
[`docs/evidence/cold-archive-write-path-dsh-0.2.0-rc.2.json`](../evidence/cold-archive-write-path-dsh-0.2.0-rc.2.json)
与
[`docs/evidence/cold-archive-write-path-dsh-0.2.1-alpha.1.json`](../evidence/cold-archive-write-path-dsh-0.2.1-alpha.1.json)。
证据里记录的 `contentSha256` 即当前工作树的候选内容摘要，与固定点 rc.10 的
`1749210691d2…` 不同——**本轮没有覆盖 rc.10 的固定产物，也没有执行
`release:publish` 或任何外部发布**；`release/manifest.json` 与 `release/*.tgz`
逐字节未变。

## 5. 复现

```sh
git status                    # 工作树含本轮改动即可，不需要基线 checkout
node scripts/benchmarks/experience-recall-archive.mjs --rows 10000 --rounds 3 --warmup 1 --samples 7
node scripts/benchmarks/observe-cold-archive.mjs --rows 10000 --knowledge-rows 10000 --rounds 3 --warmup 1 --samples 5
node --test test/dockyard-domain/knowledge-identity-equivalence.test.js
```

两个基准脚本都自己从 `release/manifest.json` 指定的固定产物解包出基线，因此不需要
额外检出；`--rows` / `--knowledge-rows` 用于标定收益边界，`--json` 输出完整原始样本
（两份 `docs/performance/*.json` 的 `stages` 就是收口时两组 A/B 的 `--json` 输出，
按上面的顺序原地收集）。端到端脚本把两份档案写成冷档案后用真实
`openDomainStorage()` + 官方 `DomainFacility` / `JsonStorageBackend` 测量公开
`port.observe()`，冻结时钟并把临时根路径归一化后再比较两侧持久化树。

CPU 归因可复现：

```sh
node --cpu-prof --cpu-prof-dir=<目录> scripts/benchmarks/observe-cold-archive.mjs \
  --rows 10000 --knowledge-rows 10000 --rounds 1 --warmup 0 --samples 2
```

该 profile 同时包含两侧，仅用于定位剩余成本。可按采样 URL 区分两侧的帧中，工作树
一侧 `#scanArchiveRaw` 11.0%、`#readArchiveSync` 4.3%、`normalizeText` 2.1%
（固定产物一侧分别为 10.8% / 8.3% / 3.2%）；`structuredClone`（14.0%）与 GC
（6.7%）不携带工作树/固定产物的 URL，无法分侧归因。共 1,541 个样本。

## 6. 剩余风险

- 改动只在合成负载与本机沙箱中测量；真实宿主验收验证的是功能与生命周期行为，
  不是性能数字。
- `copy: false` 的读取视图是类内私有用法：`#knowledgeEntryFor()` 只把命中行
  `clone()` 后交给调用方，仓库内没有其它调用点。未来若有人把该视图直接交给调用方，
  就会暴露内部行对象。
- 本轮没有消除记录路径上的另外两处成本，都是真实且已测量的，但都需要超出"最小
  有效修改"的改动，因此留作下一轮候选：
  1. **每条公开写操作会重复建立并 `load()` 多个 memory 实例。**
     `lib/domain-storage.js` 的 `mutate()` 先为暂存阶段调用一次 `createMemory()`
     （内部 `await instance.load()`），提交后再调用 `hydrate()` → `createMemory()`
     建第二个实例，两个新实例的 `load()` 都执行 `#reconcileArchiveIndex()`；后者的
     **主动档案**分支会完整读取并重新扫描每个 collection 的活动档案（只有封闭段
     能按 `sha256` + `byteSize` 早退）。上节 profile 中可归因于工作树一侧的最大
     单帧就是 `#scanArchiveRaw`（11.0%），它只出现在这条 load/reconcile 路径上。
     该扫描同时负责重建
     `archiveActiveKeys`（增量写入的索引元数据依赖它）与"崩溃后活动档案是恢复面"
     的校验，删除或按 size 信任它都会动到持久化恢复语义，需要单独设计与证据。
  2. **`#sourceMatches()` 对每个冷行重算一次身份。** 10,000 行约 71.3 ms（单进程
     5 次中位数；其中 `normalizeText` 与两个十六进制正则占大部分，sha256 约 4 ms）。
     该重算是语义要求：一行既可按**存储的** `knowledgeKey` 命中，也可按**从自身
     字段重算出的** key 命中，两者都不能省（上一轮已为此加了差分用例）。可行的降低
     手段只有跨调用缓存（需要可证的内容失效规则）或按维度提前短路（需要把
     `knowledgeIdentity()` 拆成逐维度函数），两者都超出本轮范围。
- `knowledgeKeyOf()` / `normalizeKnowledgeEvent()` 的身份实现由固定产物差分锁定；
  上面第 2 项若要实现，必须先补齐"存储 key 与重算 key 不一致"的差分用例。
