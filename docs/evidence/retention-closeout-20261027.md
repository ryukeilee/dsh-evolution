# 历史容量回收（retention floor）生产可靠性收口（2026-10-27）

本记录对应 `main` 上 3 个提交（`619a983`、`30bd433`、`30726f4`），基线 `9d57e79`。
任务给出的起点是 `758b04d`（引入 retention floor 的提交），它在 `main` 上已有两个后继：
`ebd6c06`（补完已提交截断后再回收）与 `9d57e79`（文档）。

执行环境：darwin/arm64；Node `v22.23.4`（`/opt/homebrew/opt/node@22`）、`v24.22.1`
（`/opt/homebrew/opt/node@24`）、`v26.12.1`（`/opt/homebrew/bin/node`）。每次全量运行都带
`NODE_OPTIONS=--max-old-space-size=4096`；没有读取正式 home、用户数据、`event-bridge.key`
或旧迁移目录；所有夹具都在 `os.tmpdir()` 下创建并清理。

## 1. 任务点名缺陷：deferred 截断后错误推进 floor

在 `758b04d` 上确实成立：一次回收提交了 floor 但截断被 append lock 挡住之后，**第二次**回收
会直接在未截断的文件上重新规划，日志头部那些已裁掉 marker 的字节（包括纯空行）可以推进一个新的
floor。把当前的 `test/retention-log-floor.test.mjs` 放到 `758b04d` 的源码树上运行：

```sh
git worktree add /tmp/dsh-758b04d 758b04d
cp test/retention-log-floor.test.mjs /tmp/dsh-758b04d/test/
cd /tmp/dsh-758b04d && node --max-old-space-size=4096 --test test/retention-log-floor.test.mjs
# tests 22, pass 20, fail 2
# ✖ a second reclaim cannot replace a deferred floor through a leading blank line
#   actual 'would-discard' / expected 'pending-truncation'
# ✖ reclaim refuses floor corruption before replacing the committed proof
#   Missing expected rejection: E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH
```

同一文件在当前 HEAD 上通过（见 §3 的全量结果）。也就是说，这个缺陷在 `9d57e79` 已经由
`ebd6c06` 修掉（`finishReclaimTruncation()` + `requireReclaimContinuation()`），本轮核对后确认
没有残留路径可以越过尚未安全回收的字节，也没有为此再加第二套判定。

## 2. 本轮发现并修复的真实缺陷

三条都由“同一探针在 `9d57e79`（pre-fix）与本工作树（post-fix）上的不同输出”证明；探针脚本
只在 `/tmp` 中运行，没有入库。

### 2.1 已补完的 floor 仍然需要 append lock

`completeEventLogTruncation()` 先拿 append lock 再分类，于是**任何**有过 floor 的数据根，
即使截断早已完成，也要等 500 ms 并最终以可重试的 `E_DOMAIN_EVENT_LOG_BUSY` 失败——只要另一个
写者正在追加一条记录。后果不需要任何损坏就能发生：新进程**打不开**（`replay()` 拒绝本 pass），
owner 的 `reclaim()` **跑不了**。

修复：先只读分类（`already-truncated`/`unknown`/`absent`/`no-floor` 直接返回），只有 `deferred`
分支才拿锁，并在锁内**重新分类**后才重写；`absent` 也不再顺手删掉可能是保留字节唯一副本的
`*.reclaim.tmp`。

```text
pre-fix : 1 reclaim over a completed floor with a live writer: THREW E_DOMAIN_EVENT_LOG_BUSY
pre-fix : 2 reopen  over a completed floor with a live writer: THREW E_DOMAIN_EVENT_LOG_BUSY
post-fix: 1 reclaim over a completed floor with a live writer: ok "nothing-absorbed"
post-fix: 2 reopen  over a completed floor with a live writer: ok "opened"  (floor unchanged: true)
post-fix: 4 absent completion: absent; temporary preserved: true   (pre-fix: preserved: false)
```

### 2.2 截断自身的永久失败被伪装成可重试的锁竞争

`E_DOMAIN_EVENT_LOG_BUSY` 原本包住 `completeEventLogTruncation()` 的**所有**异常，包括“临时文件
建不出来”“保留区超过上限”这类每次都一样失败的永久原因：`open`/`flush` 会提示操作者“等写者释放
再重试”，而重试永远不会成功。

修复：append lock 放弃获取的错误现在带 `E_EVENT_BRIDGE_APPEND_LOCK_BUSY`，只有它被映射成
`E_DOMAIN_EVENT_LOG_BUSY`；其余错误保留自己的码。重写路径内部的三处拒绝
（`E_DOMAIN_EVENT_LOG_TRUNCATION_FAILED`）也补上了 `.code`，否则它们会以无码错误的身份浮出，
并被回收报告成 `deferred`。

```text
pre-fix : 3 flush while the rewrite cannot create its temporary: THREW E_DOMAIN_EVENT_LOG_BUSY
post-fix: 3 flush while the rewrite cannot create its temporary: THREW EACCES
```

### 2.3 doctor 对“自相矛盾但摘要仍然对得上”的 floor 报 ok

floor 没有签名，它自己的连续性就是“被裁掉的 marker 真的存在过”的唯一证据。旧实现只要保留字节
还对得上 `tail.digest` 就报 `already-truncated`/ok，于是下面这些**本版本不可能写出**的文档都被
说成健康：被裁数与链矛盾（两种方向）、累计丢弃字节小于自己最后一次丢弃、`prior` 与 `tail` 摘要
相同，以及 pending floor 落后于它将要替换的已提交 floor（`installPending()` 会照此覆盖）。

修复：`inspectRetentionContinuity()`（只读、只报告、不参与是否加载）给出发现，
`state.retention-floor` 在分类文件之前先报 `floor-inconsistent`（blocked，附 `floorProblems`），
并在证据里给出 floor 计数器、floor 来源（pending/committed）与只列举、从不删除的回收临时残件。
`validRetentionDocument()` 保持宽松，所以运行时不会被一份文档缺陷卡住启动。

```text
pre-fix : 6 doctor cases -> status=already-truncated level=ok
post-fix: 6 doctor cases -> status=floor-inconsistent level=blocked（日志字节不变、无 repair）
```

## 3. 本轮实际执行的验证

```sh
# 全量（三个 Node，堆上限 4096 MiB）
PATH=/opt/homebrew/opt/node@22/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 npm test
# tests 1177 / pass 1177 / fail 0 / skipped 0   (v22.23.4)
PATH=/opt/homebrew/opt/node@24/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 npm test
# tests 1177 / pass 1177 / fail 0 / skipped 0   (v24.22.1)
NODE_OPTIONS=--max-old-space-size=4096 npm test
# tests 1177 / pass 1177 / fail 0 / skipped 0   (v26.12.1)

npm run pack:check        # 16 项全过；“this tree is a development successor of the pinned release”
npm run release:verify    # rc.18 固定产物匹配 release/manifest.json（contentSha256 0940a781…）
npm run release:pack && npm run acceptance:host -- --host <ver> --out /tmp/accept-final-<ver>.json
# 0.2.0-rc.2 / 0.2.1-alpha.1 / 0.2.1-rc.2：21 个步骤全部 ok
```

新增/扩展的回归：`test/retention-lock-contention.test.mjs`（5 例：已补完 floor 不需要锁、deferred
floor 仍只以锁竞争拒绝、永久失败保留自己的码、重写拒绝保留有界错误码、缺日志时保留唯一副本），
`test/diagnostics-retention-floor.test.mjs`（+11 例：4 条自洽性规则、pending 落后 3 条、计数器与
临时残件证据、pending-only 只按 pending 报一次）。`test/domain-storage/domain-storage-baseline.js`
把本轮改动作为**最先反转**的一组，rc.8 固定源仍逐字节重建。

## 4. 独立审核

`sol-loop`，DeepSeek（`pi` / `opencode-go/deepseek-v4.1-flash`，`thinking: max`；返回值确认
provider/model/options 与请求一致，运行时的生效档位没有单独证据，因此只声称“请求并返回 max”）。

- 第 1 轮：APPROVE，7 条 nit（S1–S7）。修 6 条（S1 pending 误占 committed 槽、S2 `log` 缺键、
  S3 清理注释、S4 无码拒绝、S5 测试注释与有界拒绝用例、S6 pending 落后两条规则无用例），
  S7（deferred 分支多做一次整份 `prior` HMAC）明确不改：这是“已补完不再拿锁”接受的代价。
- 第 2 轮：APPROVE，S1–S6 resolved、S7 保持，新增 4 条 nit（S8–S11）。修 3 条（S8 清理语义
  注释、S9 删掉可能与 committed 混淆的 `retention` 字段、S10 pending-only 只报一次的回归）；
  S11（只有 marker、没有 log 的 floor 仍用 `no-floor` 标签）明确不修：当前运行时写不出该形状，
  证据里已给出 marker 计数，改状态词表是为了理论边界扩大改动。

## 5. 有实质影响的剩余风险

- **回收后不可降级**（既有边界）：领域文档带 `retention` 键，旧版本的严格 schema 会拒绝。
- **S7 代价**：deferred 那一轮会对整份日志多做一次 `prior` 摘要（只读预分类 + 锁内再分类）；
  已补完的常见路径从“一次尾部摘要 + 拿锁”降到“一次尾部摘要、无锁”。只有超大日志反复补完失败时
  才值得用身份复核替代第二次全量哈希。
- **S11 标签**：外部写入的“只有 marker、没有 log”的 floor 仍报 `no-floor`/ok；本版本不产生该形状，
  `advanceRetention()` 在裁剪 marker 时总会带 log 条目。
- **回收临时残件**：只在“此后没有任何回收再走到 deferred 分支”时才长期存在（每份 ≤ 保留上限的
  一个文件），doctor 只列举不删除。
- **未覆盖**：物理掉电与任意字节 torn write、跨 hostname/PID namespace 共享数据根、无限规模；
  探针与夹具都是合成形状，不代表真实部署分布。
