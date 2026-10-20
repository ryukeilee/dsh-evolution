# 全量测试内存事件的定位：有界复测、归因与 CI 堆上限

本文记录 2026-10-20 全量测试内存事件的**有界**复测与结论，以及本轮把 CI 与
`AGENTS.md` §5 对齐的改动。原始数据见 [`oom-localization.json`](oom-localization.json)。
本轮没有重跑任何无堆上限的全量套件，也没有在测量中复现失控分配。

环境：Node `v26.12.0` / darwin-arm64，Apple M2，8 逻辑 CPU、16 GiB 内存。

## 1. 方法（有界）

对 `test/**/*.test.mjs` + `test/**/*.test.js` 的**每个文件**单独起一个子进程：

- 子进程独立进程组，`--max-old-space-size=4096`，`NODE_OPTIONS` 同样带上该上限；
- 每 120 ms 用 `ps` 采样整个进程组的 RSS，超过 **2,048 MiB** 立即 `SIGKILL` 该进程组；
- 300 s 墙钟超时。

这样任何单文件想要无界增长时，最坏结果是被上限杀掉并记录峰值，而不会让一次失控分配
影响整台机器（2026-10-20 事故记录描述的情形）。实际运行中**没有任何文件被杀**。

## 2. 结果

- 95 个测试文件全部通过（exit 0），顺序串行总墙钟 ≈ 64 s。
- 峰值 RSS 最高的是 `test/dockyard-domain/continuous/continuous.test.js`：
  **459 MiB / 4.7 s**；其余文件 ≤ 249 MiB。前 10 名见 json 的 `top10`。
- 全量套件（`NODE_OPTIONS=--max-old-space-size=4096 npm test`）在本轮改动后：
  632 个测试，630 通过，2 个失败（见第 5 节），耗时 ≈ 19.7 s。

也就是说：在带上限的前提下，当前的套件里**没有任何单文件接近历史事故的分配量级**。

## 3. 历史事件的归因

可直接核对的时间线（`git log --format='%h %ad %s'`）：

| 时间（+08:00） | 提交 | 内容 |
| --- | --- | --- |
| 2026-10-20 10:03 | `f3b27e1` | 记录 OOM 事故，要求全量测试带 `--max-old-space-size=4096` |
| 2026-10-20 11:43 | `41798ca` | 凭据边界收敛：引入 `REDACTION_TEXT_BOUND` 与 8 MiB 病态输入用例 |

事故记录点名的失败形态是：脱敏规则族在 8 MiB 病态输入上抛出
`RangeError: Maximum call stack size exceeded`，且当时该抛错发生在 `try/finally`
释放 Trial 目标锁之前。同一提交的测试文件
`test/orchestrator-integrity-bounded-redaction-cleanup.test.mjs` 构造的正是这段输入
（`token: VendorV3 a="` + 反复的 `\x`，共 8,388,608 字符）。

本轮复核（有界，见 json 的 `ruleCost`）：

- 把**当前**规则表从 `lib/orchestrator.js` 里原样取出，**绕过 64 KiB 上限**直接跑那条
  8 MiB 输入：27.1 ms 完成，RSS 只增加 9 MiB，不抛错。也就是说，**在本次环境（Node
  v26.12.0）与当前代码上，事故点名的"无界扫描 + 栈溢出"形态没有被复现**。这与代码史
  一致（`REDACTION_TEXT_BOUND` 会让超过 64 KiB 的文本直接变成定长标记），但它是
  "当前不存在可复现路径"的证据，不是对历史根因的定论。
- 在 64 KiB 上限内，本轮测的 9 种病态形状（反斜杠串、引号串、赋值串、Bearer、URL
  userinfo、混合前缀等）最坏 4.7 ms（纯反斜杠串），其余 ≤ 1.4 ms。这是本轮的实测
  最大值，**不是**对任意输入或任意规则的耗时上界。

**可以确定的**：事故当天跑全量套件时**没有**按项目要求设置显式的 4 GiB 堆上限（事故记录本身就是这条规则的原因），且事故点是单个 `node --test` 子进程从 `/tmp/nodedist/v24.9.0/bin/node` 启动。

**不能确定的**：事故报告里 `rpages × 16 KiB ≈ 203 GB` 的那个数字没有在现网复现。本轮
用的是另一个 Node（v26.12.0，而非事故时的 v24.9.0），事故时的工作树状态未被保存，
产生那次分配的中间规则表版本也没有留存；原始证据只有事件日志，没有历史进程的有效
堆限制或分配归因。因此本文**不把"根因已确定为某一条规则"当作结论**，也**不声称**
“没有上限就必然增长到内核清理”这条因果链已被验证。能说的是：当前代码在 4 GiB 堆上限
下，95 个文件逐个复测与整套复测都没有出现失控分配，事故点名的失败形态在当前代码上
不可复现。

## 4. CI 与项目规则的对齐

`AGENTS.md` §5 要求"全量回归用 `NODE_OPTIONS=--max-old-space-size=4096 npm test`"，
但 `.github/workflows/ci.yml` 的单元测试作业此前只跑 `npm test`，没有任何上限。本轮：

- 在 `test` 作业上加作业级 `env: NODE_OPTIONS: --max-old-space-size=4096`。选环境变量
  是因为它就是 `AGENTS.md` §5 指定的形式，而且一次设在作业级就覆盖安装步骤与测试
  runner 起的每一个子进程，不会出现“父进程带了限、某个子进程没带”的分叉；
- 在 `test/workflows.test.mjs` 增加断言，CI 的单元测试作业必须带这个上限。这条要求
  从此是测试而不是文档。

`ci.yml` 不属于 `package.json#files` 的分发内容，`test/` 同样不属于，因此这两处改动
不改变发布字节（`contentSha256` 只受第 5 节列出的三个 `lib/` 文件影响）。

## 5. 分发内容漂移（本轮不修，属于发布前置条件）

本轮改动让三个分发文件与固定产物不再逐字节相同（`npm run pack:check` 会因此失败）：

- `lib/dockyard-domain/memory.js`（新增 `historyView`、指标分支不再重复规范化）
- `lib/domain-storage.js`（`recall` 改用只读视图）
- `lib/dockyard-domain/PORTS.md`（记录上述只读视图的契约）

因此 `test/release-pin.test.mjs` 的 7 项里有 2 项失败（`the working tree still builds
exactly the pinned content`、`every shipped file in the tree matches the artifact byte
for byte`），`pack:check` 也在这两项及关联的验收证据上报错；其余检查（允许文件集、
权限、tarball 字节稳定、lockfile、文档一致性）均通过。

按 AGENTS.md §5，这是**发布前置条件**，不是可忽略的噪音：要消除它必须重新打包、
重跑各受支持宿主（当前 3 个）的隔离验收、再更新固定点。本轮任务边界明确不包含这些
动作（不改版本、不改固定产物、不发布），所以保留红色并在此报告，而不是伪造通过记录。
本轮在 CI 上实际会看到的失败就是这两项（加上 `pack:check` 的同类报错）；其余 630 项
通过。

## 6. 剩余风险

- 堆上限约束的是 V8 老生代；外部/原生内存（大 `Buffer`、超长字符串 rope 之外的
  原生分配）不在其内。若将来出现"按外部内存无界增长"的路径，4 GiB 上限挡不住，仍需
  RSS 级看门狗。本轮没有引入 CI 侧 RSS 监控（会增加作业复杂度，且当前没有证据需要）。
- 单文件串行复测覆盖了 `node --test` 的每个文件，但没有覆盖"多文件并发时的总 RSS"：
  并发度由 runner 决定，整体峰值 ≈ 并发数 × 单文件峰值，在 16 GiB runner 上仍是
  数量级安全，但这不是被断言的性质。
- 本轮改动使 `lib/dockyard-domain/memory.js`、`lib/domain-storage.js` 与固定产物不再
  逐字节相同，因此 `npm run pack:check` 与固定点相关测试会失败，直到按 `RELEASE.md`
  重新打包、重跑三宿主验收并更新固定点。这是发布流程的输入，不是代码缺陷。
