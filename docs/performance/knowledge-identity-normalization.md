# 冷档案身份路径：删除冗余规范化与六维投影重建

本轮删除 `lib/dockyard-domain/knowledge.js` 冷档案身份路径上五处**可证明等价**的多余
计算：`normalizeText()` 里被类折叠完全包含的控制字符折叠与分隔符折叠、它们之后不可能
生效的尾部空白折叠与内层 `trim()`、`knowledgeIdentity()` 为算 hash 重建的六键投影、
以及 `hash()` 的中间 `Hash` 对象。五处都是"删代码"级别的改写：没有新增缓存、没有新增
结构、没有改变任何计算值，也没有改动持久化格式、去重与 retention 决策、tombstone、
latest-wins、事务原子性、认证、恢复、回滚、跨进程锁与 promotion 边界；未修改官方 DSH
源码，未修改官方 DSH 源码。本文记录的性能测量在 `0.2.0-rc.14` 的固定点写入之前完成，
因此测量时 `release/` 仍固定着 `0.2.0-rc.13`；发布流程（重新打包、重新固定、三宿主验收、
提交、打 tag）的实际执行结果记在 `CHANGELOG.md` 的 rc.14 条目与 `docs/evidence/` 里。

这条路径的成本来自 `memory.js#append()` 每次写入都调用的 `#sourceMatches()`：它对来源
集合的**完整历史**逐行判断身份——先比存储的 `knowledgeKey`，再用 `knowledgeKeyOf(entry)`
从行自身字段重算（存储键可能过期，两者都必须保留）。冷行数越多、写入越频繁，重算总量
越大；本轮让**每一次重算**更便宜。

原始数据（本轮实际运行，未引用历史数字）：

- [`knowledge-identity-normalization.json`](knowledge-identity-normalization.json)
  —— 隔离：逐行身份成本（工作树，含折叠等价性的穷举阶段与固定产物值锚）；
- [`knowledge-identity-normalization-attribution.json`](knowledge-identity-normalization-attribution.json)
  —— 隔离：同一轮里测量改动前树 + 五个单改动树 + 工作树 + 两个已否决候选树；
- [`knowledge-identity-normalization-attribution-rejected.json`](knowledge-identity-normalization-attribution-rejected.json)
  —— 隔离：两个已否决候选树的专测（工作树 vs 引用合并 / 破折号守卫）；
- [`knowledge-identity-normalization-observe.json`](knowledge-identity-normalization-observe.json)
  —— 端到端 `port.observe()`，10,000 + 10,000 冷档案，固定产物 vs 工作树；
- [`knowledge-identity-normalization-observe-repeat2.json`](knowledge-identity-normalization-observe-repeat2.json)、
  [`knowledge-identity-normalization-observe-repeat3.json`](knowledge-identity-normalization-observe-repeat3.json)
  —— 同命令的两次重复运行（用于界定同一比较的运行间漂移）；
- [`knowledge-identity-normalization-observe-attribution.json`](knowledge-identity-normalization-observe-attribution.json)
  —— 端到端同负载，固定产物 + 五个单改动变体 + 工作树；
- [`knowledge-identity-normalization-observe-50.json`](knowledge-identity-normalization-observe-50.json)、
  [`knowledge-identity-normalization-observe-50-repeat2.json`](knowledge-identity-normalization-observe-50-repeat2.json)、
  [`knowledge-identity-normalization-observe-50-repeat3.json`](knowledge-identity-normalization-observe-50-repeat3.json)
  —— 端到端 50 + 50（默认小规模）及其两次重复；
- [`knowledge-identity-normalization-observe-empty.json`](knowledge-identity-normalization-observe-empty.json)、
  [`knowledge-identity-normalization-observe-empty-repeat2.json`](knowledge-identity-normalization-observe-empty-repeat2.json)、
  [`knowledge-identity-normalization-observe-empty-repeat3.json`](knowledge-identity-normalization-observe-empty-repeat3.json)
  —— 端到端空档案（0 + 0）及其两次重复。

环境：Node `v26.12.0` / `darwin/arm64`，Apple M2，8 逻辑 CPU、16 GiB 内存，
`lowpowermode 0`。本轮全部数字来自 E 纳入之后重跑的一轮（`2026-10-19T02:02:36Z` 开始，
`load averages: 1.91 1.69 1.57`），未沿用更早会话的数字。`ps` 里没有占 CPU 的进程，
测量期间没有并行运行测试或其它基准。各侧在同一进程内轮换、按侧取中位数；
`observe-cold-archive.mjs` 每轮断言所有侧落盘的档案树相同（比较范围见 5.6）；
`knowledge-identity-cost.mjs` 是纯函数测量（逐行 key、折叠穷举、生产锚定与固定产物值锚），
不涉及落盘。两个脚本都只保存 wall 的逐样本数据，CPU 只有中位数（脚本设计如此）。

## 1. 瓶颈与改动

### 1.1 每行身份的构成

`knowledgeIdentity()` 为 6 个维度各跑一次 `normalizeText()`（其中 `issueType`、
`rootCause`、`strategy`、`failureMode`、`semanticFact` 用 `dynamicNumbers: true`，
`scope` 用 `false`），然后 `hash(dimensions)`：`stableStringify()` =
`JSON.stringify(compactValue(...))`，再 sha256、截前 32 位 hex。隔离基准里 10,000 行
observations 冷档案的一次 `knowledgeKeyOf()` 扫描是 **49.88 ms**（改动前，本轮重测，
≈4.99 µs/行），10,000 行 knowledge 冷档案（行更大）是 **90.30 ms**。

### 1.2 五处改动（最小 diff）

1. **E — 删除控制字符折叠**（原管线第 3 个 pass）

   ```diff
   -  output = output.replace(/[\u0000-\u001f]+/g, " ");
   +  // The control-character collapse this line used to carry is a subset of the
   +  // class collapse below too: every code point in `\u0000-\u001f` is outside
   +  // `\p{L}`, `\p{N}` and the five kept characters. The three passes between them
   +  // cannot tell a control character from the space it would have become - the two
   +  // identifier collapses and the digit run match neither in their character
   +  // classes and treat both as a `\b` boundary - and a space inside a run of
   +  // disallowed characters does not split that run, so the class collapse sees the
   +  // same maximal run either way. The phrase replacements run after that collapse,
   +  // which is what still supplies the space `time\u0000out` needs to become
   +  // `timeout`.
   ```

2. **A — 删除被完全包含的分隔符折叠**

   ```diff
   -  output = output.replace(/[_\/\\|:]+/g, " ").replace(/[^\p{L}\p{N}<>.'-]+/gu, " ");
   +  // The separator collapse this line used to carry in front of the class
   +  // collapse is a subset of it: `_`, `/`, `\`, `|` and `:` are not `\p{L}` or
   +  // `\p{N}` and are outside the five kept characters, and both passes replace a
   +  // maximal run with one space, so the class collapse produces the same string
   +  // whether or not the separator pass ran first. Nothing between them can
   +  // observe the difference, and the phrase replacements below run after both.
   +  output = output.replace(/[^\p{L}\p{N}<>.'-]+/gu, " ");
   ```

3. **B — 删除不会生效的尾部空白折叠与内层 trim**

   ```diff
   -  return boundedText(output.replace(/\s+/g, " ").trim());
   +  // The class collapse above already replaced every maximal run of non-word
   +  // characters - whitespace included, since `\s` is neither `\p{L}` nor `\p{N}`
   +  // and is not one of the five kept characters - with a single space, so after
   +  // it no two whitespace characters are adjacent. The phrase replacements below
   +  // only remove spaces inside a match (none of their replacements contains
   +  // one), so they cannot place two side by side either, and `boundedText()`
   +  // trims before it truncates. Both the collapse and the inner trim are
   +  // therefore dead.
   +  return boundedText(output);
   ```

4. **C — 身份哈希不再重建六键投影**（新增 `identitySerialization()`，两处调用点）

   ```diff
   +function identitySerialization(dimensions) {
   +  return JSON.stringify({
   +    failureMode: dimensions.failureMode,
   +    issueType: dimensions.issueType,
   +    rootCause: dimensions.rootCause,
   +    scope: dimensions.scope,
   +    semanticFact: dimensions.semanticFact,
   +    strategy: dimensions.strategy,
   +  });
   +}
   ...
   -    return { knowledgeKey: "knowledge:" + hash(dimensions), dimensions };
   +    return { knowledgeKey: "knowledge:" + hash(identitySerialization(dimensions)), dimensions };
   ...
   -  return { knowledgeKey: explicitKey.startsWith("knowledge:") ? explicitKey : "knowledge:" + hash(dimensions), dimensions };
   +  return { knowledgeKey: explicitKey.startsWith("knowledge:") ? explicitKey : "knowledge:" + hash(identitySerialization(dimensions)), dimensions };
   ```

   返回给调用方的 `dimensions` 对象字面量的键顺序（`issueType, rootCause, strategy,
   failureMode, semanticFact, scope`）**保持不变**：它以 `knowledgeDimensions` 进入持久化
   字节，只有哈希的输入被换成等值字符串。

5. **D — `hash()` 用一次性 digest**

   ```diff
   -import { createHash } from "node:crypto";
   +import { hash as oneShotDigest } from "node:crypto";
   ...
   -function hash(value) { return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex").slice(0, 32); }
   +function hash(value) { return oneShotDigest("sha256", typeof value === "string" ? value : stableStringify(value), "hex").slice(0, 32); }
   ```

## 2. 等价性依据

### 2.1 E：控制字符折叠被类折叠包含，且中间三个 pass 分不出控制字符与空格

`\u0000-\u001f` 里的每个码点都不是 `\p{L}`、`\p{N}`，也不在保留的五个字符里，因此每个
控制字符都被 `[^\p{L}\p{N}<>.'-]+` 匹配（脚本对全部 1,112,064 个码点穷举：分隔符、
空白、控制字符落在类外 0 个）。它原本变成的那个空格不携带任何后续信息：

- **中间的三个 pass 分不出控制字符与空格。** 两个标识符折叠
  （`\b[0-9a-fA-F]{8,}\b`、`\b[0-9a-fA-F]{4,}-[0-9a-fA-F-]{4,}\b`）与数字折叠
  （`\d+(?:\.\d+)?`）的字符类既不匹配控制字符也不匹配空格；它们的 `\b` 判定只看
  `[A-Za-z0-9_]`，控制字符与空格同样都是非词字符，边界位置完全一致。
- **空格不会切断被折叠的极大 run。** 控制字符本身就在类折叠的匹配集合内，把它换成空格
  之后它仍是同一个极大段（空格也是类字符），类折叠把它压成一个空格；连续的控制字符
  run 同理。因此类折叠看到的是同一个极大 run。
- 短语替换排在类折叠**之后**，`time\u0000out` 需要的那个空格正是由类折叠提供的（第 1 轮
  曾把这条 pass 当作"不可删除"，那个论证方向是错的）。

脚本对这条论证做三层验证：全部 44 个控制/不可见空白码点（含 `0x00-0x1F` 全 32 个）
放在 20 种标识符/数字/短语主体与 9 种包裹下的结构位上，与固定产物逐字节比较；再把
**每一条含控制字符的生成字符串**整体映射成空格版本（23,034 条 × 8 个探针 × 2 个实现），
要求固定产物自己的输出等于两个实现对空格版本给出的输出。

### 2.2 A：分隔符类是被类折叠包含的子集

`{_, /, \, |, :}` 里的每个字符都不是 `\p{L}` 或 `\p{N}`，也不在保留的五个字符
`< > . ' -` 里，因此每个分隔符都被 `[^\p{L}\p{N}<>.'-]+` 匹配（脚本对**全部 1,112,064
个 Unicode 码点**穷举验证：分隔符在类外 0 个、分隔符同时是保留字符 0 个）。两个 pass
都把"极大连续段"替换成**一个**空格：把分隔符 run 换成空格不会切断它所在的类 run——
空格本身也是类字符——所以 `pass1(x)` 与 `x` 的极大类 run 位置与跨度完全相同，类折叠对
两者给出同一字符串。两者之间没有任何 pass（原代码里它们在同一条链式调用上相邻），
后面的短语替换只在这之后的文本上运行。

### 2.3 B：类折叠之后不存在相邻空白

类折叠把每个极大非词字符段压成一个 ASCII 空格，而**每个空白码点都在类里**（脚本穷举：
`\s` 命中但类不命中的码点 0 个；空白同时是保留字符 0 个），保留字符里也没有空白。
因此折叠之后不存在两个相邻空白：每个输出空格恰好来自一个极大类 run，两个类 run 之间
必然至少有一个保留字符。其后的六个短语替换的**替换文本都不含空格**
（`timeout`、`out-of-memory`、`rate-limit`、`network-error`、`missing`、`failure`），
它们只删除匹配片段内部（两侧都是非空格）的空格，不可能制造相邻空白。`boundedText()`
自己先 `String(value ?? "").trim()` 再截断，所以内层 `.trim()` 也是死代码。

### 2.4 C：`stableStringify(dimensions)` 与定序字面量

`stableStringify(value)` = `JSON.stringify(compactValue(value))`；`compactValue()`
对对象按键名 `sort()` 后遍历、丢弃 `VOLATILE_KEYS` 命中的键与 `undefined` 值，其余
（字符串、数字、布尔）原样返回。六个维度名 `failureMode`、`issueType`、`rootCause`、
`scope`、`semanticFact`、`strategy` **都不匹配** `VOLATILE_KEYS`，值都是 `dimension()`
返回的字符串，所以 `compactValue()` 对这份投影只做"按键名排序"，定序字面量
（`JSON.stringify` 保留字符串键的插入顺序）因此产生同一字符串，转义也由同一
`JSON.stringify` 完成。

这条假设由两个**不同**的检查分别钉住，各自覆盖不同变异（`identitySerialization()` 的
注释与 `test/dockyard-domain/knowledge-identity-equivalence.test.js` 的属性测试都按这个
分工描述）：

| 变异 | 抓它的检查 |
| --- | --- |
| 给工作树的 `dimensions` 加第七维，但不扩 `identitySerialization()` 的字面量 | 属性测试：工作树投影的键集合必须恰为六个名字（`Object.keys(...).sort()`），且 `knowledgeKeyOf(entry)` 必须等于工作树**自己** `dimensions` 的排序投影哈希 |
| 从字面量里删掉/改名一个键，使哈希输入与工作树自己的投影不一致 | 同上（工作侧自洽断言） |
| 给工作树的 `VOLATILE_KEYS` 加进某个维度名（如 `rootCause`） | 属性测试：六个名字里的每一个都必须被工作树**自己的**压缩规则保留（通过公开 API 探针读取，见 5.5） |
| 维度改名/改语义，导致已记录身份变化 | 冻结基线差分：`normalizeKnowledgeEvent()` 逐字段 deepEqual、`knowledgeKeyOf()` / `canonicalKnowledgeKey()` 必须与固定产物 rc.10 相等（语料让六个维度各自带信号） |

本轮用两个等价变异验证了前两类与第三类（退出码与失败信息见 5.5）：把第七维加进
`dimensions` 字面量、以及给 `VOLATILE_KEYS` 前缀加 `rootCause|`，属性测试都立即失败。

### 2.5 D：`crypto.hash` 与 `createHash().update().digest()` 文档等价

`crypto.hash(algorithm, data, outputEncoding)` 返回与
`createHash(algorithm).update(data).digest(outputEncoding)` 相同的摘要，且不需要中间的
`Hash` 对象；`data` 为字符串时两者的默认编码都是 utf8。本文件只在这一处用
`createHash`，调用点传入的都是字符串（`explicitKey`、序列化后的投影）或对象（先经
`stableStringify()` 转成字符串）。`crypto.hash` 自 Node 20.12 / 21.7 起提供，
`package.json` 的 `engines` 是 `^22.19.0 || >=24.0.0`，两者都在其后。

### 2.6 已否决、未实现的候选（本轮实测入库）

两个候选都实现为"工作树（A–E）+ 该候选"的独立 `lib` 树，先用同一套差分脚本确认与
rc.13 逐字节等价（各 659,872 次比较），再定价：

| 候选 | 实现 | observations | knowledge | 结论 |
| --- | --- | ---: | ---: | --- |
| 合并两个引号替换 | `replace(/[’‘“”]/g, (match) => match === "’" \|\| match === "‘" ? "'" : '"')` | +0.07%（专测）/ −0.32%（九侧轮换） | −0.16% / −0.15% | 噪声级，否决 |
| 破折号折叠加守卫 | `if (output.includes("-")) output = output.replace(/\b[0-9a-fA-F]{4,}-[0-9a-fA-F-]{4,}\b/gu, "<id>");` | +0.23% / +0.15% | −0.02% / −0.72% | 噪声级，否决 |

正号 = 该候选比工作树（A–E）更快；两个数值分别来自两次运行：**专测**
（`knowledge-identity-normalization-attribution-rejected.json`，candidate + 两个候选
= 3 侧）与**九侧轮换**（`knowledge-identity-normalization-attribution.json`，
candidate + 改动前树 + 五个单改动 + 两个候选 = 9 侧）。
前者把两次整体替换换成一次带回调的替换（每个引号多一次回调调用），后者加一次
`includes` 扫描换取"没有破折号时跳过正则"。两者都落在同侧样本极差（0.4%–1.1%）与
运行间漂移之内，收益不足以支付代码复杂度，因此不纳入；入库数据见
`knowledge-identity-normalization-attribution-rejected.json` 与
`knowledge-identity-normalization-attribution.json`。

## 3. 实测

### 3.1 隔离：逐行身份（10,000 + 10,000 行）

`knowledge-identity-cost.mjs --rows 10000 --knowledge-rows 10000 --rounds 3 --warmup 1
--samples 5`，每侧每场景 15 个样本，取中位数（单位 ms；同侧 CPU 与 wall 相差 < 0.1 ms）：

| 侧 | observations wall/cpu | knowledge wall/cpu | 样本极差 obs / know |
| --- | ---: | ---: | ---: |
| 改动前（rc.13 的 `lib/`，`--lib`） | 49.88 / 49.94 | 90.30 / 90.39 | 1.9% / 1.3% |
| A 单改动 | 47.51 / 47.57 | 84.93 / 85.02 | 0.6% / 0.5% |
| B 单改动 | 45.36 / 45.42 | 80.70 / 80.79 | 1.1% / 0.8% |
| C 单改动 | 45.83 / 45.88 | 85.80 / 85.89 | 1.0% / 0.5% |
| D 单改动 | 48.36 / 48.43 | 88.32 / 88.41 | 0.7% / 0.7% |
| E 单改动 | 48.81 / 48.88 | 87.71 / 87.80 | 0.7% / 0.5% |
| 工作树（A+B+C+D+E） | **36.38 / 36.42** | **67.18 / 67.24** | 1.4% / 0.5% |

相对改动前（正号 = 更快）：

| 侧 | observations | knowledge |
| --- | ---: | ---: |
| A | +4.74% / +4.74% | +5.95% / +5.94% |
| B | +9.06% / +9.05% | +10.63% / +10.62% |
| C | +8.10% / +8.13% | +4.98% / +4.98% |
| D | +3.03% / +3.03% | +2.19% / +2.19% |
| E | +2.13% / +2.13% | +2.87% / +2.87% |
| A+B+C+D+E | **+27.06% / +27.06%** | **+25.60% / +25.61%** |

五项之和（observations 27.06%、knowledge 26.62%）与合计值一致（27.06% / 25.60%）；
单项信号（2.1%–10.6%）大于同侧样本极差（0.5%–1.9%），所以逐项**隔离**收益可信。
仅测工作树的那一次运行得到 observations 36.59 ms（原始 36.39–36.91）、knowledge
67.22 ms（66.86–67.35），与上表一致。

该脚本的两层锚在本轮全部通过：折叠阶段穷举 1,112,064 个码点与 1,166,311 个生成字符串
（类差异 0、管线模式差异 0、`\b` 差异集恰为 `U+017F`+`U+212A`、NFKC 存活者 0），生产锚定
4 个 NFKC 敏感码点，值门禁是"每个被测侧的每一行都返回固定产物
`normalizeKnowledgeEvent()` 算出的 key"（20,000 行/侧）。

### 3.2 端到端：`port.observe()`（10,000 + 10,000 冷档案，约 22.16 MiB）

`observe-cold-archive.mjs --rows 10000 --knowledge-rows 10000 --rounds 3 --warmup 1
--samples 5`，固定产物 rc.13 为基线，每侧每轮 5 个样本：

| 运行（入库文件） | 基线 wall/cpu | 工作树 wall/cpu | 差值 wall/cpu |
| --- | ---: | ---: | ---: |
| `...-observe.json` | 136.73 / 120.90 | 120.12 / 110.59 | **−12.15% / −8.53%** |
| `...-observe-repeat2.json` | 134.65 / 120.74 | 120.14 / 108.51 | −10.77% / −10.13% |
| `...-observe-repeat3.json` | 134.07 / 119.86 | 120.00 / 108.15 | −10.50% / −9.77% |
| `...-observe-attribution.json`（七侧轮换） | 136.06 / 130.46 | 121.25 / 112.86 | −10.89% / −13.49% |

三次同命令运行落在 wall −10.50%…−12.15%、CPU −8.53%…−10.13%，中位数是
**−10.77% / −9.77%**。入库的那次（`...-observe.json`）在 wall 上取到三次里的最大降幅
（−12.15%），但在 CPU 上取到的是三次里**最小**的降幅（−8.53%；CPU 降幅最大的一次是
`...-observe-repeat2.json` 的 −10.13%），所以引用时应以中位数为准，不能引用单次运行的
任一端点。逐轮中位数（入库那次）：基线 wall `141.4 / 133.2 / 136.7`、工作树
`120.1 / 123.0 / 119.1`；基线 CPU 逐轮中位数 `136.2 / 121.2 / 119.8`（更早的一轮里
基线逐轮下降 10.0%）。差值只在**合计**上稳定可见。

### 3.3 端到端：单改动变体（10,000 + 10,000，七侧轮换）

| 侧 | wall | CPU |
| --- | ---: | ---: |
| 改动前 rc.13 | 136.06 | 130.46 |
| A 单改动 | −2.20% | −3.26% |
| B 单改动 | −0.44% | −1.65% |
| C 单改动 | −1.72% | −2.82% |
| D 单改动 | −3.20% | −5.65% |
| E 单改动 | −0.60% | −0.32% |
| 工作树（A+B+C+D+E） | −10.89% | −13.49% |

单看端到端时，单项信号落在运行间漂移之内：这一轮五项 wall 之和（−8.2%）低于同一次
运行的合计值（−10.9%），B（隔离 +9.1%，是第二大的单项）只测到 −0.44%，而 E
（隔离 +2.1%，最小的一项）的 CPU 只有 −0.32%——这些都不可能由代码本身解释，只能说明
端到端在这一负载上被 fsync/硬链接 I/O 与调度噪声主导。因此**逐项收益以 3.1 节的隔离
数据为准**，端到端只用来证明合计收益与整条写路径的持久化一致性（范围见 5.6）。

### 3.4 端到端：50 + 50 与空档案（无收益，噪声）

| 运行（入库文件） | 负载 | 基线 wall/cpu | 工作树 wall/cpu | 差值 wall/cpu |
| --- | --- | ---: | ---: | ---: |
| `...-observe-50.json` | 50 + 50 | 26.10 / 10.83 | 27.04 / 11.33 | +3.60% / +4.67% |
| `...-observe-50-repeat2.json` | 50 + 50 | 28.07 / 11.45 | 29.00 / 11.30 | +3.32% / −1.33% |
| `...-observe-50-repeat3.json` | 50 + 50 | 28.10 / 10.92 | 28.98 / 11.79 | +3.10% / +7.95% |
| `...-observe-empty.json` | 0 + 0 | 28.11 / 10.63 | 27.98 / 10.46 | −0.46% / −1.63% |
| `...-observe-empty-repeat2.json` | 0 + 0 | 27.20 / 10.59 | 28.35 / 10.23 | +4.22% / −3.39% |
| `...-observe-empty-repeat3.json` | 0 + 0 | 26.91 / 10.42 | 26.24 / 10.32 | −2.51% / −0.98% |

**这两档必须如实读作"无收益 / 噪声"。** 50 + 50 的收益上限是可计算的：改动前每行身份
≈4.99 µs，50 行冷档案的全部身份成本 ≈0.249 ms，本轮删掉其中 27.1% → **≤0.07 ms，约为
一次 `port.observe()`（26–30 ms）的 0.25%**。而三次运行测到的 wall 差值是 **+3.1%…+3.6%
（慢）**，即 ≈0.9 ms，是这个负载全部身份成本的 3.5 倍——不可能由"删掉计算"产生；三档的
CPU 差值同时变号（+4.67% / −1.33% / +7.95%），说明 wall 差值来自调度与 I/O 噪声。空档案
更极端：没有任何冷行，身份扫描根本不发生，理论收益为 0，三次运行的 wall 差值
−0.46% / +4.22% / −2.51% 同样变号。任何一档都不能包装成收益。

### 3.5 独立持久化场景（缺键 / 陈旧键 / 冷热同 id / 重复事件 / tombstone）

除 `test/dockyard-domain/knowledge-identity-equivalence.test.js` 里的专项用例外，本轮用
一个独立的持久化探针把五个场景串在一起跑：用同一份 fixture，rc.13 与工作树**各自**
创建一个临时 home 依次运行（两侧不复用同一个 home），比较前把各自的 home 路径归一化成
`<home>` 再逐字段比对。命令为 `node /tmp/kb-diff/persist.mjs`：

| 场景 | 构造 | 结果（两侧相同） |
| --- | --- | --- |
| 缺键冷行 | observations 冷档案里一行没有 `knowledgeKey`，字段与写入记录同主体 | 重算命中并把来源折叠进冷行；该主体知识行 `count = 2` |
| 陈旧键冷行 | 同一档案里一行带 `knowledgeKey: "knowledge:" + "9".repeat(32)`（与自身字段不符） | 存储键不命中、重算命中 |
| 冷热同 id | 热状态里的知识行与其档案副本**同一个 id**、同一主体，热行 `count = 5` | 3 次写入后 `count = 8`（热行胜出，档案副本不被计数） |
| 重复事件 | 同一主体连续写入两次（不同 id） | 第二次折叠进第一次的来源行，返回的仍是第一条来源 id |
| tombstone | 两条同 `fingerprint` 的 candidate + `housekeeping()` | 退休一条并写入 `{reason: "duplicate", fingerprint: "shared", recordId: "dup-low"}`；之后再写一次仍一致 |

捕获并逐字段比较的内容包括：返回的 id 序列、知识投影的 key 与计数、保留的 observation
id、tombstone 列表、`state.json` 字节（8437 B，路径已归一化）、两个冷档案字节
（769 B / 1869 B）。两个实现的输出 `equal: true`，进程退出码 0。

## 4. 收益边界

- 收益与"每次写入被重算身份的冷行数"成正比：本轮全部收益来自让**每次重算**更便宜
  （隔离 +27.1% / +25.6%），扫描的行数、去重与 retention 决策一个字节都没变。
- 无命中场景同样受益：`#sourceMatches()` 对每个冷行都要重算，与是否命中无关；端到端
  10k + 10k 这一档就是"写入需要扫描 10,000 行知识 + 22 MiB 冷档案但不命中"的场景。
- 行数少或档案为空时收益为 0（3.4 节给出了上限计算）：扫描量相对固定开销（fsync、
  硬链接、事务、固定解析）可以忽略。
- 收益不随维度数量或文本长度线性变化：E、A、B 去掉的是每次 `normalizeText()` 的固定
  代价（每行 6 次），C、D 去掉的是每次身份确定的固定代价（每行 1 次 hash 输入重建 + 1 次
  digest 对象）。
- 命中率、tombstone、retention 上限、`archiveMaxBytes`、跨进程锁等参数不影响结论：
  改动只在重算内部。

## 5. 验证

### 5.1 测试（本轮实际输出）

- `node --test test/dockyard-domain/knowledge-identity-equivalence.test.js` ——
  **10 tests / 10 pass**。
- `node --test test/dockyard-domain/` —— **98 tests / 98 pass**。
- `npm test` —— **382 tests / 380 pass / 2 fail**，两个失败都是
  `test/release-pin.test.mjs` 的发布固定点检查（`every shipped file in the tree matches
  the artifact byte for byte`、`the working tree still builds exactly the pinned
  content`），报错都是 `lib/dockyard-domain/knowledge.js differs between the working tree
  and the released artifact`。这是本改动的**预期**后果：固定点仍指向 rc.13 的字节，
  重新固定需要新的宿主验收与 `npm run release:publish`（本任务禁止）。
- `npm run pack:check` —— 失败项只有同类三项（`the committed acceptance evidence ...`、
  `release/manifest.json pins this tree content`、`the working tree still builds the
  pinned content`），树构建的 `contentSha256` 是
  `662e32542c51ff927147b90c3f7ff7407c6088bea1c4a2c55780d117db14979a`，
  `release/manifest.json` 固定的是
  `a274f2e160a1dd65da2c2628b30999307c702a3a6e85958879d84bf5bde55743`；其余 13 项检查
  （打包字节稳定、文件清单、权限、锁文件、无凭据/家目录路径、版本号、
  README/COMPATIBILITY/CHANGELOG 一致性、`bin` 入口存在）全部 `ok`。本轮新增的
  `docs/performance/` 文件不在 `package.json#files` 白名单内，因此不参与这个
  `contentSha256`。

新增/加强的测试覆盖：`CORPUS` 现有 105 条记录，其中本轮新增的是分隔符/类折叠重叠形状、
控制字符紧贴短语（`time\u0000out` 等）、控制字符 run 与分隔符/空白混排
（`"\u0000@\u0001 mixed_\t/ run"`）、空白与不可见空格、两种引号折叠、带破折号的标识符、
以及六个维度各自带信号各一条；另有六维投影再哈希属性测试与陈旧 stored key 冷行测试。

### 5.2 与固定产物的差分

独立差分脚本（不在仓库内，`/tmp/kb-diff/equivalence.mjs`）以 rc.13 的 `lib/` 为基线，
对 27 个代表性字符的全部单/双/三字符组合、短语×连接符×包裹组合、240 字截断边界组合、
全部 44 个控制/不可见空白码点（含 `0x00-0x1F` 全 32 个）落在标识符/数字/短语结构位上
的组合、25 条具名控制字符形状，以及 20,000 条带种子的随机字符串，比较整个
`normalizeKnowledgeEvent()` 投影（JSON）、`knowledgeKeyOf()`、`canonicalKnowledgeKey()`
与 `knowledgeDigest()`：**659,872 次探针比较全部逐字节相同**；另做全部 1,112,064 个
码点的类包含性穷举。额外的映射相位把每一条含控制字符的生成字符串（23,034 条）整体
替换成空格版本，要求固定产物自己的输出等于两个实现对空格版本给出的输出：
**368,544 次比较全部相同**。工作树、五个单改动树与两个已否决候选树都通过同一套差分
（各 659,872 次）。

### 5.3 变异牙齿（本轮实际复现）

| 变异 | 应用位置 | 结果 |
| --- | --- | --- |
| 给 `dimensions` 加第七维（`seventh: "signal"`），不动 `identitySerialization` | 工作树 `knowledgeIdentity()` | 属性测试 **exit 1**：`AssertionError: the working projection must expose exactly the six dimensions for {"problem":"real problem"}` |
| 给 `VOLATILE_KEYS` 前缀加 `rootCause|` | 工作树常量 | 属性测试 **exit 1**：`AssertionError: the working tree's own compaction must keep the dimension name rootCause: a name it drops would make the serialized projection disagree with the projection compactValue() defines`；整文件为 4 fail（该属性测试 + 三个受影响的持久化差分测试） |

两个变异都在验证后逐字节还原（`sha256sum -c` 通过、`git diff --check` 无输出）。
另有差分层面的牙齿：把投影的键顺序写错的变体会让差分脚本立即失败（见 2.4）。

### 5.4 属性测试声明的边界

属性测试**不**声称覆盖"值"：它只要求工作树自洽（key = 工作树自身 `dimensions` 的排序
投影哈希、投影恰为六个名字、六个名字都不被本树压缩规则丢弃）。已存储身份的**值**由
同一文件里的冻结基线差分（`normalizeKnowledgeEvent` 逐字段、`knowledgeKeyOf` /
`canonicalKnowledgeKey` 与 rc.10 相等）负责。2.4 节的表格按这个分工描述，不再声称
"属性测试单独覆盖三个方向"。

### 5.5 属性测试如何读取压缩规则

属性测试里的 `workingCompactionKeeps(name)` 通过公开 API 观察本树的压缩规则：对象值的
`strategy` 维度就是 `stableStringify()` 对该对象的输出，因此
`{ strategy: { [name]: "probe" }, rootCause: "anchor" }` 的 `dimensions.strategy` 是否等于
`JSON.stringify({ [name]: "probe" })`，就等于"本树压缩规则是否保留该名字"。这样测试不必
把 `VOLATILE_KEYS` 复制进测试文件，也不会因为正则改写而静默失配。

### 5.6 端到端等价性断言的**范围**（不要过度解读）

`observe-cold-archive.mjs` 的 `tree()` 是：`readdir(dockyard)` 列出的文件按名排序，
逐个以 UTF-8 读入、把临时根路径字符串替换成 `<root>`，拼成一个字符串。每轮把该轮**所有
样本跑完**后，才用这个字符串把每个侧与基线侧比较。因此它：

- 比较的是 `dockyard` 目录下的文件（本插件在该目录写入的 state 与档案/索引文档），
  **不是**官方 storage backend 的另一个目录；
- 是 UTF-8 文本比较 + 临时根路径归一化，**不是**逐字节摘要（JSON 里只记录侧顺序与计时
  样本，不保存任何字节摘要）；
- 是**每轮结束后**比较，**不是**每次写入后比较——单次写入级别的等价性由
  `test/dockyard-domain/knowledge-identity-equivalence.test.js` 的 append 场景（state /
  档案 / 投影逐字节）与 3.5 节的独立持久化探针负责。

缺键、陈旧键、冷热同 id、重复事件、tombstone 的等价性证据来自 5.1 的专项测试与 3.5 的
探针，不来自端到端脚本的 `tree()` 比较。

### 5.7 Node 22 与 Node 24 上的实际运行

本改动唯一新增的 Node 专属 API 是 `crypto.hash`（一次性 digest）。为了不靠“文档说它存在”
来支撑 `engines` 声明，完整单测套件在声明范围内的两端各实际跑了一遍：从 nodejs.org 下载
官方 darwin-arm64 二进制到 `/tmp`，在同一棵树（同一份源码、同一份 `node_modules`）上
用各自的 `node --test "test/**/*.test.mjs" "test/**/*.test.js"` 执行：

| Node | 结果 | 失败项 |
| --- | --- | --- |
| `v22.19.0` | `382 tests / 380 pass / 2 fail` | 均为 `test/release-pin.test.mjs` 的固定点检查 |
| `v24.9.0` | `382 tests / 380 pass / 2 fail` | 同上 |

两个失败都是**重新固定前的预期结果**（`the working tree still builds exactly the pinned
content` 与 `every shipped file in the tree matches the artifact byte for byte`，报错为
`lib/dockyard-domain/knowledge.js differs between the working tree and the released
artifact`）——固定点仍指向 rc.13 的字节。与 5.1 节在 Node `v26.12.0` 上的结果逐项相同，
因此 `crypto.hash` 在两端都真实可用，没有 `ERR_UNKNOWN_BUILTIN_MODULE` 或其他版本差异。
本节的断言只覆盖单测套件；基准数字仍只在 Node `v26.12.0` 上测得（见第 3 节），不跨版本
比较。

## 6. 复现

```sh
# 改动前的 lib：release/ 里的固定产物 rc.13，与 42fd842 的 lib/ 逐字节相同（已核对）
mkdir -p /tmp/kb-rc13 && tar -xzf release/dsh-evolution-0.2.0-rc.13.tgz -C /tmp/kb-rc13 package/lib
git show HEAD:lib/dockyard-domain/knowledge.js \
  | diff - /tmp/kb-rc13/package/lib/dockyard-domain/knowledge.js && echo "rc.13 == HEAD"

# 五个单改动树：每个都是 rc.13 的 lib/ 加上 §1.2 里的**一个**改动块。
# E/A/B/D 是单行替换（E/A/B 删折叠并写入注释，D 换 import 与 hash 调用），
# C 是插入 identitySerialization() 并把两处 hash(dimensions) 换成
# hash(identitySerialization(dimensions))。本轮用一个只在 /tmp 的脚本把工作树里对应
# 的行搬过去（本轮只允许修改三个文件，脚本不入库），它同时断言
# "rc.13 + A + B + C + D + E 与工作树逐字节相同"。两个已否决候选树由工作树 + §2.6 的
# 那一行改动生成。端到端脚本需要 zod 能从变体树解析到：
for name in A-separator-only B-tail-only C-serialization-only D-digest-only E-control-only; do
  cp -R /tmp/kb-rc13/package/lib "/tmp/kb-variants/$name"
done
ln -sfn "$PWD/node_modules" /tmp/kb-variants/node_modules

# 1) 隔离：工作树
node scripts/benchmarks/knowledge-identity-cost.mjs --rows 10000 --knowledge-rows 10000 \
  --rounds 3 --warmup 1 --samples 5 --json > docs/performance/knowledge-identity-normalization.json
# 2) 隔离：改动前 + 五个单改动 + 两个已否决候选
node scripts/benchmarks/knowledge-identity-cost.mjs --rows 10000 --knowledge-rows 10000 \
  --rounds 3 --warmup 1 --samples 5 --json \
  --lib /tmp/kb-rc13/package/lib \
  --lib /tmp/kb-variants/A-separator-only --lib /tmp/kb-variants/B-tail-only \
  --lib /tmp/kb-variants/C-serialization-only --lib /tmp/kb-variants/D-digest-only \
  --lib /tmp/kb-variants/E-control-only \
  --lib /tmp/kb-variants/rejected-quote-merge --lib /tmp/kb-variants/rejected-dash-guard \
  > docs/performance/knowledge-identity-normalization-attribution.json
# 3) 隔离：两个已否决候选的专测
node scripts/benchmarks/knowledge-identity-cost.mjs --rows 10000 --knowledge-rows 10000 \
  --rounds 3 --warmup 1 --samples 5 --json \
  --lib /tmp/kb-variants/rejected-quote-merge --lib /tmp/kb-variants/rejected-dash-guard \
  > docs/performance/knowledge-identity-normalization-attribution-rejected.json
# 4) 端到端 10k+10k：入库那次 + 两次重复 + 七侧归因
node scripts/benchmarks/observe-cold-archive.mjs --rows 10000 --knowledge-rows 10000 \
  --rounds 3 --warmup 1 --samples 5 --json > docs/performance/knowledge-identity-normalization-observe.json
node scripts/benchmarks/observe-cold-archive.mjs --rows 10000 --knowledge-rows 10000 \
  --rounds 3 --warmup 1 --samples 5 --json > docs/performance/knowledge-identity-normalization-observe-repeat2.json
node scripts/benchmarks/observe-cold-archive.mjs --rows 10000 --knowledge-rows 10000 \
  --rounds 3 --warmup 1 --samples 5 --json > docs/performance/knowledge-identity-normalization-observe-repeat3.json
node scripts/benchmarks/observe-cold-archive.mjs --rows 10000 --knowledge-rows 10000 \
  --rounds 3 --warmup 1 --samples 5 --json \
  --variant /tmp/kb-variants/A-separator-only --variant /tmp/kb-variants/B-tail-only \
  --variant /tmp/kb-variants/C-serialization-only --variant /tmp/kb-variants/D-digest-only \
  --variant /tmp/kb-variants/E-control-only \
  > docs/performance/knowledge-identity-normalization-observe-attribution.json
# 5) 50+50 与空档案，各一次入库 + 两次重复（-repeat2 / -repeat3 同参数）
for suffix in "" "-repeat2" "-repeat3"; do
  node scripts/benchmarks/observe-cold-archive.mjs --rows 50 --knowledge-rows 50 \
    --rounds 3 --warmup 1 --samples 5 --json \
    > "docs/performance/knowledge-identity-normalization-observe-50$suffix.json"
  node scripts/benchmarks/observe-cold-archive.mjs --rows 0 --knowledge-rows 0 \
    --rounds 3 --warmup 1 --samples 5 --json \
    > "docs/performance/knowledge-identity-normalization-observe-empty$suffix.json"
done

# 6) 独立持久化探针（缺键 / 陈旧键 / 冷热同 id / 重复事件 / tombstone）
node /tmp/kb-diff/persist.mjs     # 两个实现输出逐字段相同，打印 equal: true，退出码 0
# 7) 差分与穷举（工作树 / 单改动树 / 已否决候选树各跑一次）
node /tmp/kb-diff/equivalence.mjs "$PWD/lib" --fuzz 20000
```

第 5.3 节的变异复现方式：把两个变异分别应用到 `lib/dockyard-domain/knowledge.js`
（`dimensions` 字面量加 `seventh: "signal"`；`VOLATILE_KEYS` 前缀加 `rootCause|`），
运行 `node --test --test-name-pattern="sorted six-dimension projection"
test/dockyard-domain/knowledge-identity-equivalence.test.js`（两次都应 exit 1），
然后逐字节还原。

## 7. 剩余风险

- **C 的键名耦合**：定序字面量把六个维度名写死在代码里。2.4 节的表格给出实际分工：
  工作侧自洽断言抓"第七维 / 字面量漏键或改名 / 维度名落进本树压缩规则"，冻结基线差分抓
  "已记录身份的值变了"。两者都不是"一个测试覆盖全部方向"；如果将来把某一侧的语料删空
  （例如让所有记录都走 explicit-key 分支），工作侧断言会因为 `hashed >= 50` 直接失败，
  不会静默失效。
- **E 依赖 `\b` 与字符类的实现语义**：论证靠两点——`0x00-0x1F` 的每个码点都在类折叠的
  匹配集合内（对全部 1,112,064 个码点穷举验证），以及中间的三个 pass（两个标识符折叠、
  数字折叠）对控制字符与空格的行为完全一致（`\b` 只看 `[A-Za-z0-9_]`，字符类都不匹配
  二者）。后者是用差分脚本行为性验证的（全部 32 个 C0 控制字符 × 20 种结构位、23,034 条
  映射比较），不是从引擎实现里推导的；若将来把这三处折叠改写、移位或换成别的字节语义，
  需要重新跑这套比对。
- **`crypto.hash` 的运行时依赖**：`engines` 是 `^22.19.0 || >=24.0.0`，`crypto.hash`
  自 20.12 / 21.7 起提供。性能测量只在 Node `v26.12.0` 上运行（本文全部数字都是那一轮
  的）；单测套件已在 `v22.19.0` 与 `v24.9.0` 上完整执行过（见 5.7）。
- **性能数字的适用范围**：单机（Apple M2）、单一负载形状（`#sourceMatches()` 全扫）、
  测量时 load average 约 1.9。端到端同一比较在不同运行之间漂移约 1.7 个百分点
  （三次同命令：−10.50%…−12.15% wall），更早的会话里基线自身逐轮曾下降 10%，因此只有
  合计收益（wall 约 −10%…−12%、CPU 约 −9%…−10%）是稳定可见的；单项收益只在隔离基准里
  可信。
- **无行数下限之外的收益**：冷档案为空或只有几十行时没有可测收益（3.4 节给出了上限
  计算），这不是回归，而是收益结构的边界。
- 本文记录的性能与差分数据来自改动本身；发布流程（重新打包、重新固定产物、三宿主验收、
  提交、打 tag）在本文写完之后按 `RELEASE.md` 执行，结果记在 `CHANGELOG.md` 的 rc.14
  条目与 `docs/evidence/` 里，不回头改写本文的测量数字。
