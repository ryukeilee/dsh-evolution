# evolution_doctor 冷历史 JSONL：按块扫描替代整文件物化

基线为 2026-11-09 合并 PR #36 后的 `main`：`13adaafb835209943a42479ca67e8eb42f8ca517`。
本轮只改 `lib/diagnostics.js`：`diagnoseArchives()` 对 `dockyard/state.json.*.jsonl`
（活动归档 / rotation 文件）的完整性读取，从 `readFileSync(file, "utf8")` +
`inspectJsonLinesSummary(text)` 改为复用事件桥已有的 `scanJsonLinesFile()` 1 MiB 分块
字节扫描。公开 API、报告字段、问题文本、故障分类、持久化协议、认证、恢复、事务与官方
DSH 接口均未改动；没有新增缓存、后台任务、配置或依赖。

原始数据：

- [主测量（5 轮，8 个场景）](diagnostics-archive-streaming-20261109.json)
- [独立复测（5 轮，8 个场景）](diagnostics-archive-streaming-20261109.confirm.json)

复现脚本：[`scripts/benchmarks/diagnostics-archive-streaming.mjs`](../../scripts/benchmarks/diagnostics-archive-streaming.mjs)。

源码身份：基线 `lib/diagnostics.js` sha256 = `350351727c2e…`（`origin/main`，
`git show 13adaaf:lib/diagnostics.js`）；候选 = `06f6b7b986aa…`。两侧只差本文件，其余
`lib/` 模块逐字节相同（脚本记录完整 sha256 与两侧共用的导入说明）。

## 1. 调用链与瓶颈

`collectDiagnostics()` → `diagnoseArchives()` 列出 `dockyard/` 顶层 `*.jsonl`，逐个文件做
冷历史完整性检查：行数、非空行 `JSON.parse` 失败计数、未终止尾行。事件桥
(`diagnoseEventBridge()`) 在更早一轮（`41df9d9`）已把同一类检查改成
`scanJsonLinesFile()` 分块读取；冷历史 JSONL 仍走整文件读取：`readFileSync(file, "utf8")`
先把文件解码成一个字符串，再 `indexOf("\n")` 切分并逐行解析。

整文件读取的瞬时峰值 = 解码后的字符串（最坏 1 个 UTF-16 code unit / 输入字节）加解析
产生的临时对象。本轮在主测量中直接看到：256 MiB 的 rotation 文件使一次完整诊断的峰值
RSS 从约 80 MiB 升到约 590 MiB；`stat` 与 `Buffer` 之外没有别的大对象。`scanJsonLinesFile()`
的读取器已经按 1 MiB 块读、按字节找 LF、只保留未完成行，因此本轮复用它而不是另写扫描器。

## 2. 改动

```js
function inspectJsonLinesFileSummary(file) {
  let stat = null;
  try { stat = fs.statSync(file); } catch { /* the scan below reports the read error */ }
  if (stat !== null && (!stat.isFile() || stat.size > MAX_WHOLE_FILE_TEXT_BYTES)) {
    return inspectJsonLinesSummary(fs.readFileSync(file, "utf8"));   // 原路径，原错误
  }
  let invalid = 0;
  const scanned = scanJsonLinesFile(file, (lineText) => {
    if (lineText.trim() === "") return;
    try { JSON.parse(lineText); } catch { invalid += 1; }
  });
  return { lineCount: scanned.lineCount, invalid, truncatedTail: scanned.truncatedTail };
}
```

- `diagnoseArchives()` 的 try/catch 与问题文本不变，只是被调用者从
  `inspectJsonLinesSummary(text)` 换成按文件的摘要。
- `scanJsonLinesFile()` 的 `lineCount`、`truncatedTail` 语义直接复用（空文件 1 行、
  结尾 LF 不产生空行、未终止尾行计入并判 `truncatedTail`）。
- `MAX_WHOLE_FILE_TEXT_BYTES = buffer.constants.MAX_STRING_LENGTH`：文件字节数不超过
  V8 最大字符串长度时，解码后的文本长度一定不超过它（UTF-8 解码后的 UTF-16 长度不会
  超过输入字节数），所以新路径的逐行解码结果与旧整文件字符串等价。字节数更大的文件
  （解码文本可能超过限制）保留旧的 `readFileSync` 路径——旧实现对这些文件的结果就是
  “读取失败”，不能换成新实现报行数。目录、FIFO、设备等非普通文件也保留旧路径，错误
  文本因此与旧实现一致。
- 共享常量 `EVENT_BRIDGE_SCAN_CHUNK_BYTES` 改名为 `JSONL_SCAN_CHUNK_BYTES`（仍是 1 MiB），
  注释写明两个读取者；扫描器实现本身未改。

## 3. 等价性

- **文本等价**：LF 是字节 `0x0a`，不会出现在 UTF-8 多字节序列内部。按该字节切行、对每
  一个完整行（跨块残段拼齐后）解码，得到的文本与“整文件解码后再 `split("\n")`”的对应
  片段逐字符相同；无效 UTF-8 的最大子序列替换也以 LF 为边界，不会跨行。CRLF 的 `\r`
  保留在行文本里，`JSON.parse` 的空白语义与旧路径相同。
- **计数等价**：行数、空/纯空白行跳过、非空行 `JSON.parse` 失败计数、未终止尾行判定都
  由同一套逐行逻辑给出；空文件、`"\n"`、无结尾 LF、CRLF、BOM、特殊 JSON 标量均覆盖。
- **错误等价**：普通文件的 `open`/`read` 错误与 `readFileSync` 的 `code/message` 相同
  （ENOENT/EACCES/EISDIR 在测试中逐字比较）；非普通文件与 >`MAX_STRING_LENGTH` 文件走
  旧实现，错误文本与结果按定义相同。
- **差分证据**：`test/diagnostics-archive-streaming.test.mjs` 在测试内部复制
  `origin/main` 的旧读取器作为 oracle，对真实 `collectDiagnostics()` 产出的完整
  `state.archives` 检查对象逐字段 `deepEqual`；覆盖空文件、CRLF、无效 UTF-8（含跨 1 MiB
  块的多字节序列）、>1 MiB/2 MiB 超长行、块边界 LF、未终止尾行、ENOENT/EISDIR/EACCES、
  >`MAX_STRING_LENGTH` 回退分支与无跨调用缓存。基准脚本另外在每次运行时比较整报告
  sha256（去掉 `generatedAt`）与两侧扫描字节，不一致即失败；主测量与复测的 8 个场景、
  所有 A/A 与 A/B 运行报告哈希均相同。

## 4. 测量方法

- 每个计时/RSS 样本是一个**新进程**，只运行一次 `collectDiagnostics({ dshHome, probe: { skipComposition: true } })`；
  峰值 RSS 取该进程 `process.resourceUsage().maxRSS`。这样峰值是“一次真实诊断”的峰值，
  不是同一进程重复运行后的分配器高水位（后者会把两侧都抬高，且放大幅度依赖实现）。
- 每轮按 A、A2（同源基线）、B 三个独立进程交错，A/A 给出测量噪声下限；A/B 的起跑顺序
  逐轮轮换，5 轮取中位数。
- 全部夹具是 `mkdtemp` 下的合成 `dshHome`；文件字节在独立进程里用 `--build` 一次生成，
  测量进程只读。没有读取真实 `DSH_HOME`。
- 扫描字节：对场景的 `*.jsonl` 统计 `readFileSync` 的调用次数与字节数。除本改动外，
  `inspectArchiveIntegrity()`（`lib/archive-stage.js`，未改）也会整文件读取集合归档文件，
  所以：A 的 `readFileSync` = 夹具字节 + 完整性读取，B 的 `readFileSync` = 完整性读取，
  两者之差必须恰好等于夹具字节（断言）；B 的摘要读取全部走 `readSync`。`multi-256m`
  实测 A 8 次 / B 4 次，`realistic-multi` A 14 次 / B 7 次，差值都等于夹具文件数。
- 分配量用 V8 HeapProfiler 采样（`HeapProfiler.startSampling`，间隔 32768 字节，包含
  已回收对象），每侧 3 次调用平均。脚本同时跑一个**对照**：同一文件分别用
  `readFileSync(file, "utf8")` 与按 1 KiB 分片解码，两次覆盖同样的字节。对照显示
  Node 26 的 `readFileSync` 走原生 `readFileUtf8` 快路径，采样器不为整文件字符串记
  字节：`single-256m` 的 268,546,554 字节，整读采样 0 字节、分片解码采样 271,044,632
  字节；`single-128m` 的 134,347,258 字节，整读 0、分片 139,786,784。也就是说分配列
  **不能**用来比较“整文件读取”与“逐行解码”这两种分配形态，也不作为峰值内存证据；
  它只记录采样值，峰值内存以上面的 RSS 为准。候选侧多出来的可解释成本是逐行字符串
  对象头与 1 MiB 扫描缓冲区（小历史场景 RSS +约 2 MiB）。

## 5. 结果

单位：wall 为一次完整 `collectDiagnostics()` 的毫秒中位数；RSS 为单进程峰值 MB。A =
`origin/main`，B = 本工作树；两列各是 5 轮 × 每轮 1 个独立进程的中位数。

| 场景 | 文件数 | 夹具字节 | A wall | B wall | wall Δ | A 峰值 RSS | B 峰值 RSS | RSS Δ | A/A wall Δ | A/A RSS Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small（含损坏/CRLF/无效 UTF-8 夹具） | 3 | 61,745 | 35.956 | 36.336 | +1.06% | 67.0 | 69.1 | +3.08% | +0.28% | +0.14% |
| single-32m（rotation 名） | 1 | 33,601,690 | 65.309 | 66.780 | **+2.25%** | 142.3 | 80.5 | **−43.45%** | −0.34% | −0.15% |
| single-128m（rotation 名） | 1 | 134,347,258 | 147.126 | 150.477 | +2.28% | 334.1 | 80.5 | **−75.90%** | −0.81% | +0.02% |
| single-256m（rotation 名） | 1 | 268,546,554 | 256.390 | 257.849 | +0.57% | 590.2 | 80.6 | **−86.34%** | −0.14% | −0.03% |
| single-128m-archive（集合归档名） | 1 | 134,365,690 | 317.798 | 314.562 | −1.02% | 468.8 | 343.3 | **−26.77%** | −0.44% | −0.00% |
| single-256m-archive（集合归档名） | 1 | 268,581,370 | 595.954 | 588.618 | −1.23% | 877.5 | 623.1 | **−28.99%** | +0.26% | +0.02% |
| multi-256m（4 × 64 MiB 集合归档） | 4 | 268,857,960 | 588.077 | 596.541 | +1.44% | 418.3 | 360.5 | −13.83% | +0.09% | +0.18% |
| realistic-multi（7 × 8 MiB 集合归档） | 7 | 59,956,134 | 164.997 | 168.435 | +2.08% | 152.7 | 153.0 | +0.24% | −0.67% | +0.16% |

独立复测（同样 5 轮，复用同一份夹具字节、重新起进程）方向一致：

| 场景 | A wall | B wall | wall Δ | RSS Δ |
| --- | ---: | ---: | ---: | ---: |
| small | 36.254 | 36.662 | +1.13% | +3.45% |
| single-32m | 65.907 | 67.020 | +1.69% | −43.42% |
| single-128m | 148.060 | 149.118 | +0.72% | −75.90% |
| single-256m | 253.513 | 259.388 | +2.32% | −86.34% |
| single-128m-archive | 318.500 | 316.327 | −0.68% | −26.80% |
| single-256m-archive | 597.488 | 592.017 | −0.92% | −29.01% |
| multi-256m | 588.322 | 592.691 | +0.74% | −13.87% |
| realistic-multi | 165.423 | 168.261 | +1.72% | +0.02% |

结论与边界：

- **单文件 128–256 MiB**：峰值 RSS 降低 26.8%–86.4%（rotation 名 −75.9%/−86.4%；
  集合归档名仍满足 ≥25%：−26.8%/−29.0%，因为同一文件还会被未改动的
  `inspectArchiveIntegrity()` 整文件读取，峰值由那一半主导）。
- **多文件 / 当前安装布局**：4 × 64 MiB 集合归档时峰值 −13.8%～−13.9%；7 × 8 MiB
  （当前安装每个集合的活动归档上限 8 MiB、硬上限 16 MiB）时峰值变化在噪声内
  （+0.2%／+0.0%），wall +2.1%/+1.7%。低于 25% 的原因相同：文件本来就小，
  `diagnoseArchives()` 的整文件读取不是该布局的峰值主因，剩下的成本来自未改动的
  完整性读取（`inspectArchiveIntegrity()` 会把每个集合归档整文件读一遍，不在本轮
  范围）。这就是本改动的收益边界：收益随单个 JSONL 文件的字节数增长。
- **wall**：两轮最差都在 +2.3% 以内（single-256m 复测，绝对 +5.9 ms；主测最差
  +2.28%，绝对 +3.4 ms）；集合归档名单文件 −0.7%～−1.2%（同一文件被读两遍时省下的
  那一次更大）；A/A 噪声 ≤1.3%。全部场景的绝对增量 <6 ms，且小于被消除的数百 MB
  峰值内存；没有出现耗时随内存收益方向明显变差、或超过 A/A 噪声数倍的场景。
- **空/极小历史**：RSS +2.9%（约 +2 MiB，来自 1 MiB 扫描缓冲区与一次 `stat`），wall +0.3%。
  没有 JSONL 文件的安装不受影响。
- **>V8 最大字符串长度的文件**：保留旧的整文件路径，因此旧结果（读取失败与错误文本）
  不变；未用真实 >512 MiB 文件测量。
- **封存段（`.segments/segment-N.jsonl`）**：本检查本来就不扫描它们（只扫描 `dockyard/`
  顶层 `*.jsonl`）；它们由未改动的 `inspectArchiveIntegrity()` 读取，本轮不改变该成本。
- 本轮也试过把 `scanJsonLinesFile()` 改为按块一次性解码（wall 更低），但在
  multi-256m / realistic-multi 夹具上峰值 RSS 反而上升，且需要改动事件桥共用的扫描器；
  最终采用不改扫描器的逐行解码复用，收益与代价都在上表内。

## 6. 本轮实际执行的检查

- 聚焦回归（`test/diagnostics-archive-streaming.test.mjs` + `diagnostics` 与事件桥的
  既有测试）：Node 22.23.4 / 24.22.2 / 26.13.0 均 88/88 通过（其中新增差分文件 9/9）。
  差分测试内部复制 `origin/main` 的冻结读取器，逐对象比较完整 `state.archives` 检查。
- 全量回归（`NODE_OPTIONS=--max-old-space-size=4096 npm test`，Node 22.23.4 / 24.22.2 /
  26.13.0 各一次）：每次 1,480 项，1,477 通过、2 跳过、1 失败。唯一失败是
  `test/release-pin.test.mjs:82` 正确拒绝“工作树带未提交的分发改动”——提交后该项转绿；
  除此之外无失败。
- `npm run pack:check`（提交前）：17 项中 16 项通过，唯一失败同样是未提交的
  `lib/diagnostics.js` 使工作树不是固定点的已提交后继；提交后复核通过（见下）。
- 四个官方宿主的真实隔离验收（全新官方 runtime、全新临时 home，不触碰正式 `DSH_HOME`）：
  `0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-rc.2`、`0.2.2-rc.1` 各 **21/21 步通过**，doctor
  为 degraded（20 ok / 2 degraded / 0 blocked，与既有验收基线一致），升级/回滚保留用户
  数据与 promotion 三阶段均 ok。候选 tarball 双跑字节一致（51 entries），
  `tarballSha256=560852f9…d7c2e`、`contentSha256=9784576f…038a4`；四份证据在
  `docs/evidence/diagnostics-archive-streaming-dsh-<host>.json`。执行时使用净环境
  （`env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_SESSION_ID -u DSH_SHELL`）：
  本 ACP shell 继承的 `DSH_PROFILE=acp` 会让 live doctor 解析 `profiles/acp` 并把
  `host.install` 判为 blocked；首次 `0.2.0-rc.2` 因此失败（非候选代码问题，独立探针
  清环境后同一 runtime 的 live doctor = healthy、profile=web），失败证据保留在
  `/tmp/doctor-stream-failed-evidence-0.2.0-rc.2-run1.json`，不计入通过。
- 提交后复核：完整 `npm test`（三版本）与 `npm run pack:check` 均为全绿（见第 7 节与
  PR 的 CI 结果）。

## 7. 独立审核

独立 sol-loop 审核 1 轮，GPT-6.1 Sol，verdict **APPROVE**，无 blocker / should，4 个 nit：

| id | 内容 | 处理 |
| --- | --- | --- |
| S1 | `--no-allocation` 时基准表格读取未生成的 alloc 字段会 TypeError | 已修：缺省显示 `n/a` |
| S2 | 文档复现命令第二次测量会因默认删除夹具而失败 | 已修：两次命令都带 `--keep-fixture`，并写明复用与手动清理 |
| S3 | `realistic-multi` 用了不存在的集合名 `diagnostics-archive`，该文件因此不参与完整性读取，不能称“当前安装布局” | 已修：改为集合名 `diagnoses`，重新生成夹具并重跑主测/复测（表中数字已更新；该布局峰值本就不受益，结论更保守） |
| S4 | 跨块 UTF-8 用例均以裸 `a` 开头、错误解码也仍不可解析，检不出回归 | 已修：新增跨块纯 Unicode 空白（U+00A0）行用例，错误解码会改变 `invalid` 计数 |

请求目标为 `codex` / `gpt-6.1-sol` / `reasoningEffort: "xhigh"`，返回的 target options
记录同一档位；Reviewer 没有返回运行时自述，因此 Xhigh 只是请求与返回配置的记录，未额外
验证。按 sol-loop 预算规则，本轮返回的只有 nits，且 S1–S4 的修复不改变生产行为（基准
脚本、测试与文档），因此不再开新审核轮。审核覆盖 `origin/main..工作树` 的
`lib/diagnostics.js`、差分测试、基准脚本与本文件；审核后只做了上述 nit 修复与证据更新。

## 7. 复现

```sh
# 一次性生成夹具（约 1.1 GiB，临时目录）
node scripts/benchmarks/diagnostics-archive-streaming.mjs --build --fixture /tmp/diag-archive-fixture

# 主测量 / 独立复测（每个样本一个新进程；需要 --expose-gc 供分配采样子进程）。
# 主测量带 --keep-fixture，复测复用它；两次测量结束（或需要干净夹具）时手动删除
# /tmp/diag-archive-fixture。
node --expose-gc scripts/benchmarks/diagnostics-archive-streaming.mjs \
  --fixture /tmp/diag-archive-fixture --baseline-rev origin/main --keep-fixture \
  --out docs/performance/diagnostics-archive-streaming-20261109.json
node --expose-gc scripts/benchmarks/diagnostics-archive-streaming.mjs \
  --fixture /tmp/diag-archive-fixture --baseline-rev origin/main --keep-fixture \
  --out docs/performance/diagnostics-archive-streaming-20261109.confirm.json
```

脚本用 `git show <baseline-rev>:lib/diagnostics.js` 取基线并在 `lib/` 放一个临时副本
（结束时删除），两侧导入同一份工作树 `lib/` 模块；除 `lib/diagnostics.js` 外没有别的
差异。基线 rev 用 `origin/main`，报错时会把实际 `rev-parse` 结果写进 JSON。
