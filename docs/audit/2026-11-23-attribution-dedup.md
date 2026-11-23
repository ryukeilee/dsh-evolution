# 跨来源失败归因去重（2026-11-23）

基线：PR #82 的提交 `a4b1255`（`t3/evolution-workflow-audit`）。本文只记录本轮实际读取、执行和测到的内容。

## 1. 结论

PR #82 新增的 `originCounts` 用一个共享的 `Map` 同时累加两个来源：

- 知识记录（`sources.knowledge`，来自共享经验库）；
- 本地失败记忆（`sources.failureMemory`，来自 `evolution-memory.json`）。

但同一个规划器早已按“两个来源描述的是同一批执行”来合并失败总数：知识行按 `knowledgeSum` 累加，失败记忆按 `memoryMax` 取最大，跨来源再取 `max(knowledgeSum, memoryMax, lossSum)`。归因计数没有沿用这条规则，于是：

1. 同一失败同时出现在两个来源时，`originCounts` 把它算两次，可能大于 `occurrences`；
2. 同一失败记忆在同一目标下有多个快照时，归因把各快照相加，而总数只取最大值；
3. 被重复计算的成因可能改变多数成因，把本来由 `unknown` 主导的目标误判成 `caller-input` 并拒绝，或反过来让真正的 `caller-input` 目标进入候选；
4. 拒绝项的 `detail` 用 `occurrences` 作分母，而分子来自未去重的计数，出现过“9 of 8”这类自相矛盾的说明。

本轮让归因计数沿用与失败总数相同的去重规则，不改变 `occurrences`、评分公式、候选上限、生命周期或任何门禁。

## 2. 修改内容

只改 `lib/experience-plan.js` 的归因聚合：

- `knowledgeOrigins` 与 `memoryOrigins` 分开记录；
- 知识行按成因累加（它们是不同的 canonical fact，和 `knowledgeSum` 一致）；
- 失败记忆的多个快照按成因取最大值（和 `memoryMax` 一致）；
- 跨来源按成因取最大值（和 `max(knowledgeSum, memoryMax)` 一致），不再相加；
- `dominantOriginOf()` 与 `originCountsOf()` 都读这份去重后的计数；
- `rejected: caller-input` 的 `detail` 分母改为去重后成因计数之和。单来源时它等于 `occurrences`；两个来源记录不同形状时，它可能大于保守的跨来源总数，这时它是各成因份额的真实分母，不再冒充失败总数。

没有调整权重，没有新增候选类型、工具或持久化字段，也没有改 `occurrences` 的算法。

## 3. 生产数据前后对照

数据源（只读）：`~/.dsh/storages/evolution-experience/experience.sqlite`（schema 1，49 条 canonical knowledge 行）与 `~/.dsh/storages/evolution/evolution-memory.json`（12 条失败记忆）。重放脚本先把 SQLite 复制到临时目录再读，不打开源库、不启动宿主、不写入数据根。

同一份数据、同一时钟（`--now 2026-11-23T00:00:00Z`），PR #82 修复前 / 本轮修复后：

| 目标 | `occurrences` | 修复前 `originCounts` | 修复后 `originCounts` | 说明 |
| --- | ---: | --- | --- | --- |
| `tool read` | 30 | `unknown 22`, `capability-gap 6`, `caller-input 3` | `unknown 21`, `capability-gap 6`, `caller-input 3` | 失败记忆里同一目标的 1 条 active `revert` 快照重复计入了 `unknown`；修复前成因合计 31 > 30 |
| `tool wait agent`（`--focus wait`） | 8 | `unknown 8`, `environment 1` | `unknown 7`, `environment 1` | 同样的 1 条 active 快照；修复前合计 9 > 8 |

- 知识库单独重放（不传 `--memory`）时，修复前后的完整计划文档逐字段相同（`diff` 为空），PR #82 的候选、排序和分数没有变化；
- 带失败记忆重放时，前 5 个候选、`selected`、分数、顺序、前 5 名覆盖的 255 条失败全部不变，只有上表的两处归因计数从“重复 +1”回到与 `occurrences` 一致；
- 修复前 / 后候选队列均为 `run code 167`（0.6558）、`read 30`（0.4564）、`apply patch 43`（0.3746）、`mcp pull request read 4`（0.3720）、`edit 11`（0.3289）；
- 对照 `origin/main`（`cbc1694`）的规划器：修复后的队列仍是 PR #82 的队列（`run code` / `apply patch` / `edit` 进入候选与拒绝报告），没有被本轮修复退回“最大的损失不可见”的旧行为。

生产数据里只有两个目标在两个来源中重叠（`tool read`、`tool wait agent`），且重复的那条记忆都是 `revert` 形状，因此本轮在该库上只修正了计数，没有翻转候选或排序。翻转判定由下面的合成边界用例证明。

## 4. 边界用例

新增到 `test/experience-attribution.test.mjs`：

1. 同一失败同时出现在知识记录与失败记忆：`occurrences` 仍为 5，`originCounts` 为 `{unknown: 5}`，不再是 `{unknown: 10}`；
2. 知识多数为 `unknown`（5）而 `caller-input` 为 3，失败记忆重复记录同一 `caller-input` 形状：目标保持候选，`originCounts` 为 `{unknown: 5, caller-input: 3}`，重复快照不能造出 6:5 的 `caller-input` 多数；
3. 知识多数为 `caller-input`（5）而 `unknown` 为 3，失败记忆重复记录同一 `unknown` 形状：目标仍以 `caller-input` 拒绝，计数为 `{caller-input: 5, unknown: 3}`，`detail` 为 “5 of 8”；
4. 两个来源记录不同形状（知识 `unknown` 6、失败记忆 `caller-input` 3）：两种形状都保留，`unknown` 仍是多数，`occurrences` 仍是 6；
5. 同一目标的两条失败记忆快照（9 与 4）只贡献最大值 9，拒绝说明为 “9 of 9”。

## 5. 复现

```sh
# 只读复制生产库（脚本会自己复制；这里只为展示输入位置）
cp ~/.dsh/storages/evolution-experience/experience.sqlite /tmp/experience.sqlite

# 本轮修复后，带本地失败记忆
node docs/audit/replay/plan-from-store.mjs \
  --store /tmp/experience.sqlite \
  --memory ~/.dsh/storages/evolution/evolution-memory.json \
  --now 2026-11-23T00:00:00Z \
  --versions 0.2.2-rc.5,4.1.0,0.2.16

# 修复前（PR #82 的规划器，同一份数据）
git show origin/t3/evolution-workflow-audit:lib/experience-plan.js \
  | sed "s#from \"./dockyard-domain/knowledge.js\"#from \"$PWD/lib/dockyard-domain/knowledge.js\"#" \
  > /tmp/pr82-before-plan.js
node docs/audit/replay/plan-from-store.mjs \
  --store /tmp/experience.sqlite \
  --memory ~/.dsh/storages/evolution/evolution-memory.json \
  --module /tmp/pr82-before-plan.js \
  --now 2026-11-23T00:00:00Z

# 只看一个目标（例如 wait agent），两种规划器输出可直接对比
node docs/audit/replay/plan-from-store.mjs \
  --store /tmp/experience.sqlite \
  --memory ~/.dsh/storages/evolution/evolution-memory.json \
  --focus wait --now 2026-11-23T00:00:00Z
```

`plan-from-store.mjs` 现在支持 `--memory`；`--home <dir>` 会在找到时自动投影 `<dir>/storages/evolution/evolution-memory.json`。

## 6. 实际执行的验证

| 检查 | 结果 |
| --- | --- |
| `node --test test/experience-plan.test.mjs test/experience-attribution.test.mjs test/experience-degradation.test.mjs test/experience-plan-real-capture.test.mjs` | 51 项通过，0 失败 |
| 生产库重放，知识与失败记忆两路来源 | §3 的前后对照；知识单源计划逐字段不变 |
| 全量 `NODE_OPTIONS=--max-old-space-size=4096 npm test` | 见 §7 |
| `npm run pack:check` | 见 §7 |
| 隔离真实宿主 `0.2.2-rc.5 --no-hmr --experience-evolution` | 25/25 步通过（`host-install` 至 `doctor-final` 全部 `ok`）；`seed` 阶段规划器选中 `tool probe healthcheck`，`originCounts: {"unknown": 4}`、`occurrences: 4`；完整的 propose → baseline 3/3 失败 → trial → candidate 3/3 成功 → measure → promote → restart → regression 流程通过 |

真实宿主证据：`/tmp/acceptance-attribution-rc5.json`（tarball `sha256 7b730a9c…`，`contentSha256 59269b6e…`）。最终 doctor 步骤为 `ok`；doctor 自身状态是 `degraded`，原因只有 CLI 模式无法观测的 `runtime.*`、尚未初始化的 `data.root`/`data.key`，以及既有的五个 `degradedCapabilities`，没有新的 finding。该运行使用本树构建的 tarball，不是 `release/` 固定产物。

## 7. 未证明与剩余风险

1. **归因仍依赖宿主发布结构化失败码。** 没有 `error.info.code` 的失败仍是 `unknown`；本轮只修正跨来源重复计数，不改善归因来源。
2. **不同来源记录不同形状时，成因计数之和可以大于保守的 `occurrences`。** 这是刻意保留的：`occurrences` 按来源取最大值，避免把同一执行算两次；不同形状是额外证据，不能为了凑总数而丢弃。拒绝说明使用去重后成因之和作份额分母。
3. **生产库只出现了两类重叠（`tool read`、`tool wait agent`）**，且没有因此翻转候选。候选翻转只在合成边界用例中有证据；本轮没有声称生产库会发生翻转。
4. **评分权重没有重新测量。** 本轮只修去重，不改变 §3 中 PR #82 已记录的排序收益，也不声称权重是最优的。
