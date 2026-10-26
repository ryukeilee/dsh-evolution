# 密封归档预期摘要保真：缺陷、修复与回归证据

## 1. 结论

`EvolutionMemory` 的冷档案索引把 `sealed` / `checksumState` / `byteSize` / `sha256` 当作**已经记录下来的预期**。修复前，
`#reconcileArchiveIndex()` 在"记录的字节大小与文件实际大小不符"时会重新读取文件、重算 sha256，并用当前字节的摘要**覆盖**索引里的预期。
于是篡改、损坏或异常恢复都会被静默接受：证据被"当前字节的哈希"替换，之后 `verifyConsistency()` 再也报不出冲突。

本轮修复把预期变成真正的证据，并补齐了三条会把证据洗掉的路径：

| 缺陷 | 修复 |
| --- | --- |
| 加载时重哈希覆盖既有预期 | 形状完整可信的预期（`sealed===true`、`checksumState==="final"`、64 位小写 hex `sha256`、非负安全整数 `byteSize`）一律保留；大小不符时**不读不写**，只留给完整性检查报告 |
| `compact()` / `finalizeKnowledge()` 在有冲突或缺失证据时仍改写归档 | `#rewriteArchives()` 在任何文件被改动前拒绝 9 类 finding，抛 `E_ARCHIVE_REWRITE_UNSAFE` |
| 索引在 `load()` 之后变得不可读时，重写会用当前字节重建索引 | `#rewriteArchives()` 与启动路径共用同一判据，抛 `E_ARCHIVE_INDEX_STATE_UNKNOWN` |
| 归档重写的回滚只还原归档字节、不还原它写过的索引 | `#restoreArchiveIndex()` 按字节还原索引（原本不存在则删除）并从磁盘重新加载；索引还原失败挂到 `error.rollbackError`，不替换主错误 |
| `inspectArchiveIntegrity()` 返回的 `mismatched[].expected` / `.actual` 含义颠倒 | 交换为 `expected` = 索引记录值、`actual` = 实测值，与 `addFinding` 侧一致。**这是对已有输出字段含义的修正，不只是新增拒绝**：按旧方向解读 `mismatched[]` 的外部消费方会读到互换的值。仓库内没有这样的消费方（`lib/` 只读 `finding.code`），测试侧只有本轮新用例按新语义断言。 |

不含可用预期的密封文件（无条目、`checksumState` 非 `final`、非法摘要、非法 `byteSize`）**仍走**既有的"重算并索引"恢复边界——
这是"没有已记录预期可洗"的情形，不是本次修复的目标。

回归证据：同一组测试文件，**修复前 38 项中 26 通过、12 失败；修复后 38/38 通过**。

## 2. 修复的位置

| 位置 | 作用 |
| --- | --- |
| `lib/dockyard-domain/memory.js` `#reconcileArchiveIndex()` | `hasUsableExpected` 的两条分支；`restoredExpectations`（由持久故障证明的原始字节恢复后重新采纳原预期） |
| `lib/dockyard-domain/memory.js` `#assertArchiveIndexClassifiable()` | 索引状态是否可分类的唯一判据，`#reconcileArchiveIndex()` 与 `#rewriteArchives()` 共用 |
| `lib/dockyard-domain/memory.js` `#rewriteArchives()` | 9 类 unsafe finding 门禁、索引状态门禁、索引快照与 `#restoreArchiveIndex()` |
| `lib/dockyard-domain/memory.js` `#restoreArchiveIndex()` | 索引字节 + 内存 map + 就绪状态 + 重新加载，事务 `rollback` 与内层 catch 共用 |
| `lib/archive-stage.js` `inspectArchiveIntegrity()` | `mismatched[]` 的 `expected` / `actual` 语义 |

`#rewriteArchives()` 拒绝的 9 类 finding：`archive-invalid-line`、`archive-torn-tail`、`archive-unusable-line`、`archive-file-unreadable`、
`archive-segment-directory-unreadable`、`archive-sealed-size-mismatch`、`archive-sealed-digest-mismatch`、`archive-index-target-missing`、
`archive-loss-evidence`。它调用 `inspectArchiveIntegrity()` 时使用默认 `scanContents: true`，因此**等长**篡改（只有摘要变化）也会被发现；
若改成 `scanContents: false`，`actual.sha256` 为 `null`，等长篡改会完全绕过门禁——这一点由新用例钉住。

## 3. 修复前失败（可复现）

做法：把 `HEAD` 的 `lib/` 放进一个 detached worktree（`git worktree add --detach <dir> HEAD`，`node_modules` 软链到主工作树），
把**当前工作树的 4 个测试文件**覆盖进去（不覆盖 `archive-index-baseline.js` 与 `housekeeping-equivalence.test.js`，它们属于另一处
基线反转），然后用同一命令跑两侧。

```sh
/opt/homebrew/opt/node@22/bin/node --max-old-space-size=4096 --test \
  test/archive-persistence-defects.test.mjs \
  test/dockyard-domain/archive-index-write-avoidance.test.js \
  test/dockyard-domain/archive-rewrite-batch.test.mjs \
  test/dockyard-domain/evolution-archive-index.test.js
```

| 结果 | 修复前（HEAD 的 lib） | 修复后（本工作树） |
| --- | ---: | ---: |
| tests | 38 | 38 |
| pass | 26 | **38** |
| fail | **12** | 0 |

修复前失败的 12 项与它们证明的缺陷：

| 用例 | 关键报错（实测） | 证明 |
| --- | --- | --- |
| `compact rejects a lengthened sealed digest conflict without rewriting either source, then succeeds after trusted restoration` | `345 !== 218` | 完整性报告里 `expected`/`actual` 颠倒，且冲突时没有拒绝压缩 |
| `compact rejects an equal-length sealed digest conflict without rewriting its bytes or index` | `Missing expected rejection.` | 只有摘要变化（大小不变）时门禁不成立 |
| `compact preserves an index that becomes unreadable after load` | `Missing expected rejection.` | 索引在加载后损坏时仍会用当前字节重建索引 |
| `finalizeKnowledge rejects a sealed digest conflict without rewriting archive history` | `Missing expected rejection.` | 知识定稿路径同样会改写冲突现场 |
| `compact refuses a missing sealed target and preserves its loss evidence` | `Missing expected rejection.` | 缺失段证据不阻止重写 |
| `a changed sealed segment keeps its original expectation through repeated loads` | `116 !== 58` | 重新加载把已变更文件的大小写回索引 |
| `an unparseable lengthened sealed segment keeps its original expectation` | 摘要 `87afe450… ≠ 676195c7…` | 重新加载重哈希并覆盖原摘要 |
| `an index document failure restores archive bytes and the in-memory index before later writes` | `observations/segment-000000000001.jsonl keeps its restored index entry instead of the discarded staged layout` | 索引文档写失败后，内存索引仍描述被丢弃的暂存布局 |
| `state-save rollback restores archive bytes and removes transaction temporaries` | 索引摘要 `d192c3c5… ≠ 673610fe…` | 回滚没有恢复原索引字节 |
| `state-save rollback removes an index created by a transaction when none existed before` | 多出一个 `.evolution-archive-index.json` | 事务失败后没有移除原本不存在的索引 |
| `an index-restore failure is attached without replacing the primary state-save error` | 校验函数返回 `false` | 索引还原错误没有挂到主错误上 |
| `a valid-shaped wrong digest on a lengthened sealed segment remains the durable expectation` | 摘要 `dc3d2f50… ≠ aaaa…` | 长度正确的既有摘要被重哈希覆盖 |

**修复前也通过的用例（必须读清楚它们证明了什么）**：

- `sealed files without a usable expectation retain the established hash-recovery path`（四个变体 `missing-entry` / `non-final-checksum` /
  `invalid-digest` / `unsafe-byte-size`）与 `an invalid 72-character digest stays in the recovery boundary…`：它们钉的是**需求 4 的排除项**
  （没有可用预期时仍可恢复），不是原缺陷。变异验证：去掉 `hasUsableExpected` 里任一项守卫（`/^[0-9a-f]{64}$/`、`Number.isSafeInteger`、
  `checksumState === "final"`），这些用例会失败。
- `an index document failure restores archive bytes and the in-memory index before later writes`：第二轮复审指出它最初**修复前也通过**——当时的夹具里
  重写后的段布局与还原后的布局恰好逐字节相同，所以"没有还原的内存索引"碰巧描述的是正确的字节。已按复审给的配方修正：在注入失败前把
  `archiveMaxBytes` 调大，让重写把冷行打包成**不同**的段布局，于是陈旧的内存索引不可能再"碰巧正确"，并增加"磁盘上每个封存段都仍在索引里"
  的断言。现在它在修复前失败（实测 `observations/segment-000000000001.jsonl keeps its restored index entry instead of the discarded
  staged layout`），修复后通过。

## 4. 修复后仍然成立的行为

- **恢复路径不会死锁。** 缺失段被**原始字节**恢复后，`#reconcileArchiveIndex()` 通过持久故障记录采纳原预期，`verifyConsistency()` 的
  `archive-index-target-missing` / `archive-loss-evidence` 消失，随后 `compact()` 成功。这条由 `missing segment evidence survives restart,
  append, and filename reuse until original bytes return` 与 `compact refuses a missing sealed target…` 的后半段钉住；删掉 `restoredExpectations`
  / `proven` 分支会让它们失败。
- **拒绝不改动现场。** 每个拒绝用例都比对拒绝前后的归档树字节（活动文件、全部封存段、索引文档），要求逐字节相同。
- **重复加载不会改写预期。** 同一份被篡改的密封段连续加载两次，索引文档保持首次记录的摘要与大小。

## 5. 反转基线

`lib/` 是随包分发路径，`test/dockyard-domain/archive-index-baseline.js` 的反转表必须能把当前 `lib/dockyard-domain/memory.js`
逐条还原成 `release/dsh-evolution-0.2.0-rc.7.tgz` 里的那一份。本轮为该文件的全部改动补齐了反转对（它们都必须恰好出现一次）：

```sh
/opt/homebrew/opt/node@22/bin/node --max-old-space-size=4096 --test test/dockyard-domain/housekeeping-equivalence.test.js
```

结果：22/22 通过；重建结果 175,320 字节，与 rc.7 的 `lib/dockyard-domain/memory.js` 逐字节相同
（SHA-256 `58a75e35fc4f7aed780fc63314420adc2bfd9bfc13909252b26ca0f4e058f0d8`）。

## 6. 内层 catch 的后果（修复前后实测）

`#rewriteArchives()` 内层 catch 现在也调用 `#restoreArchiveIndex()`。它的可观测后果需要"`#writeArchiveIndex()` 的文档写入失败"
**且**"随后有一次不重建 map 的增量索引写入（`#writeArchiveIndexIncremental()`）"同时发生，并且重写后的段布局与磁盘上的不同。

第二轮复审用 `/tmp` 复现给出了实测：修复前，一次索引文档写失败加一次普通追加会持久化 7 条指向已不存在文件的条目，并让 11 个真实封存段
没有索引，磁盘上因此出现 **7 条假的 `archive-sealed-digest-mismatch` 与 7 条假的 `archive-sealed-size-mismatch`**（两者都又落在
`#rewriteArchives()` 的 unsafe 列表里，会让之后的压缩一直被拒绝）。下一次 `load()` 会自愈，所以危害有界，但这正是本任务要禁止的
"制造故障证据"。

现在这条由 `an index document failure restores archive bytes and the in-memory index before later writes` 钉住（见第 3 节）。

保留这一改动的理由不是"多一层防御"：事务 `rollback` 与内层 catch 是同一种失败语义（把已改动的归档还原），两条路径共用
`#restoreArchiveIndex()` 比保留一处只还原一半的实现更容易论证。
未经本轮验证的残余：`#restoreArchiveIndex()` 不还原 `this.archiveActiveKeys`，所以失败重写后 active 条目的 `logicalCount`
可能暂时偏大；`archiveKnown`（决定去重与保留）不受影响，下一次 `load()` 重新扫描即自愈，本轮未观察到记录丢失路径。

## 7. 边界

- 等长篡改的保护完全依赖 `#rewriteArchives()` 使用默认的 `scanContents: true`。本轮已加对应用例；但 `archiveIntegrity()`
  这条公开只读面**故意**不重算摘要，它不会报告等长篡改——`verifyConsistency()` 才是重算入口。
- 门禁让"无法分类的状态必须人工处置"成为规则：双故障（状态保存失败 + 索引还原失败）后 `compact()` 会持续拒绝，
  恢复途径是按诊断提示人工处置索引文件，而不是让运行时猜。这与 `AGENTS.md` §4 第 2 条一致。
- `compact()` / `finalizeKnowledge()` 在 `lib/` 内没有生产调用者（`lib/orchestrator.js` 的 `this.compact()` 是另一个类的方法）。
  本轮门禁因此是"让未来接线安全"的前置条件，而不是当前生产热路径的行为变化。相关容量结论见
  [capacity-reclaim-evaluation.md](capacity-reclaim-evaluation.md)。
- 本轮没有改动 `#reconcileArchiveIndex()` 的语义、持久 schema、公开 API、默认行为或发布固定产物。
