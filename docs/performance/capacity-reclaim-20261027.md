# 容量回收实测（2026-10-27）

## 测量口径

完整命令：

```sh
/opt/homebrew/opt/node@22/bin/node --max-old-space-size=4096 scripts/benchmarks/capacity-reclaim.mjs --all --json > docs/performance/capacity-reclaim-20261027.json
```

小规模验收命令：

```sh
/opt/homebrew/opt/node@22/bin/node --max-old-space-size=4096 scripts/benchmarks/capacity-reclaim.mjs --sizes 200 --json
```

环境为 Node `v22.23.4`、`darwin/arm64`。每个规模只测一轮，依次为 200、2,000、20,000 条拒绝实验事件；这不是统计分布。每轮都在 `os.tmpdir()` 下创建独立临时 home，使用官方 `DomainFacility` 与 `JsonStorageBackend`，并在结束时清理。

每条拒绝事件都带合成 `failureFingerprint`、`measurement.latencyMs` 与 `evidence.latencyMs`。每个 home 还追加 `bench-promotion` 的一条 `measurement-completed`、一条 `promotion-succeeded` 和一条 `canary-passed` 事件。回收固定保留 1 条日志记录，以便 200 条的小规模也实际截断日志，并让 promotion 证据行进入丢弃前缀；这组保留值用于验证路径，不代表生产策略建议。

字节数是递归文件长度之和，不是文件系统分配块。`official` 统计官方 JSON backend 文件；其中的 `official/evolution_domain.json` 字节数由 JSON 的 `officialDomainJsonBytes` 单独记录。当前夹具没有 `dockyard/state.json` 实体文件，该字段 `dockyardStateJsonBytes` 因此为 0。`maxRSS` 取每轮回收后读取的进程高水位；三个规模在同一进程内顺序执行，所以它包含此前准备工作的峰值，不是回收函数独占的峰值。

## 实测汇总

各分类列为“回收前 → 回收后”，单位为字节。RSS 使用 MiB（1 MiB = 1,048,576 B）；CPU 与墙钟使用毫秒。

| 规模 | dockyard B | event log B | official B | checkpoint B | other B | 删除归档段 | 日志丢弃 B / 条 | 裁剪 marker | reclaim ms | CPU user / system ms | RSS 前 → 后 MiB | maxRSS KB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 200 | 77,112 → 517 | 150,497 → 933 | 136,148 → 77,442 | 623 → 610 | 38 → 946 | 0 | 149,564 / 202 | 202 | 72.698 | 41.753 / 10.799 | 47.94 → 51.45 | 76,032 |
| 2,000 | 1,002,632 → 517 | 1,494,926 → 936 | 789,337 → 518,757 | 625 → 610 | 38 → 948 | 0 | 1,493,990 / 2,002 | 2,002 | 193.929 | 178.215 / 15.312 | 106.17 → 110.12 | 125,136 |
| 20,000 | 10,368,933 → 517 | 15,064,955 → 939 | 3,449,245 → 1,044,157 | 627 → 610 | 38 → 950 | 1 | 15,064,016 / 20,002 | 20,002 | 1176.679 | 1223.778 / 41.470 | 318.44 → 312.21 | 361,968 |

回收报告中的归档结果：200 档 `retired` 200、`consolidated` 0、归档 `beforeBytes → afterBytes` 为 `76,521 → 0`、JSONL 行 `151 → 0`；2,000 档 `retired` 2,000、`consolidated` 0、归档 `beforeBytes → afterBytes` 为 `1,002,037 → 0`、JSONL 行 `1,951 → 0`；20,000 档 `retired` 20,000、`consolidated` 0、归档 `beforeBytes → afterBytes` 为 `10,367,753 → 0`、JSONL 行 `19,951 → 0`。20,000 档报告删除 1 个段、共 `8,388,198` 字节，路径为 `dockyard/state.json.experiments-archive.jsonl.segments/segment-000000000001.jsonl`，脚本确认它在回收及重开后均不存在；前两档的冷档案本来就只有一个 active 文件，因此没有段可删，只有 active 文件被重写为 0 字节。

每档 dry run 前后的 home 总字节完全相同（`364,418`、`3,287,558`、`28,883,798`），`zeroWrite: true`。回收后的 home 总字节分别为 `80,448`、`521,768`、`1,047,173`。`other` 增加的 908 / 910 / 912 字节包含外置的 promotion evidence sidecar；所以总量变化同时包含保留证据的新增字节。

## 恢复与证据检查

三个规模都通过脚本内的断言：重开领域存储成功；重开后 `applied` 为 1，且 retention floor 的 `markers.pruned` 与回收报告的裁剪数一致；显式 `flush()` 返回 `{ "applied": 0, "duplicates": 1 }`。归档索引存在且 `inspectArchiveIntegrity()` 返回 `valid: true`、`missingIndexTargets: 0`。

三个 sidecar 都包含 `gateEvidence.runtimeRecovered: true` 和 `durable.pluginName: "bench-plugin"`。截短后的 bridge reader 仍能返回只含保留 canary 行的结果，但其中没有 `runtimeRecovered: true` 或 `pluginName: "bench-plugin"`；对应证据来自 sidecar。20,000 档删除的段文件与事务报告数量相符；三档 `dockyard/**` 回收后字节数均未增加。

## 这证明了什么 / 没证明什么

这次测量证明：在这三个 synthetic event 历史和真实官方后端上，归档树、event log 与 applied marker 表都实际变小；dry run 没有改写 home 字节；promotion 证据在 bridge 前缀被截断后仍可从 sidecar 读取；重启不会重放已丢弃记录，保留记录作为重复项被识别，且归档索引完整。

这没有证明其他规模或数据形状的收益，尤其没有测 promotion 密集、knowledge 密集或并发写者；也没有证明自动维护行为。生产回收仍是需要 owner 确认的显式动作，`evolution_maintain` 不会因为这组结果自行运行。

一个必须说清的操作边界：回收之后，日志的“起点”由 floor 的保留尾部摘要定义。日志要么以那些字节开头，要么**恰好**是 floor 记录的 `prior` 文件（此时下一次 replay 会幂等补完那次已提交的截断——这也是“提交后、截断前崩溃”的恢复路径）；否则一律以
`E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH` 拒绝，而不是被重新吸收，因为那些记录的去重身份已随 marker 一起裁剪，无法再与日志对账。这个拒绝没有猜测式修复，
操作者只能恢复那段保留字节或换一个数据根；**空日志同样被拒绝**（空文件不能证明保留字节没丢，接受它会让下一次追加造出永远对不上 floor 的头部）。本轮没有测试并发写者与外部替换日志时的行为。

修复前的 R1–R4 阻塞记录见 [`retention-reclaim-blockers.md`](retention-reclaim-blockers.md)。该文档只作为旧问题类别的对照；其中的旧测量数字不是本次结果，也未重复引用。

## 三个阻塞的回归：修复前失败、修复后通过

新增的两个测试文件只用公开 API，可在修复前的 `lib/` 上直接运行。做法：在 `git worktree add --detach <dir> <parent-commit>` 的
独立工作树里软链本仓库 `node_modules`，把两个测试文件原样覆盖进去，用同一条命令跑两侧
（`node --max-old-space-size=4096 --test test/retention-archive-deletion.test.mjs test/retention-log-floor.test.mjs`）。

| 文件 | 修复前（父提交的 `lib/`） | 修复后（本次提交） |
| --- | --- | --- |
| `test/retention-archive-deletion.test.mjs` | 0/6 通过；第一个失败是 R1 本身：stage 丢掉若干段后 `changedArchiveFiles()` 的 `removed` 列表为 `[]` | 6/6 通过 |
| `test/retention-log-floor.test.mjs` | 文件级失败：修复前 `lib/orchestrator.js` 不导出 `externalizeEventBridgeEvidence`（`event-log-checkpoint.js` 同样没有 floor API） | 11/11 通过 |

R1 是断言级反例（同一份断言在修复前直接指向“清单不表达删除”）。R2/R3 的修复前证据分两层：本文件里的回归在修复前
连 API 都不存在；可观测的代价与证据丢失则用**修复前的公开 API** 在
[`retention-reclaim-blockers.md`](./retention-reclaim-blockers.md) 的 R2/R3 里实测过——裁掉一个 marker 后
`planEventLogReplay()` 的 `trusted` 从 `true` 变为 `false`、可跳过前缀从 200 条降为 0 条；删掉唯一的
`promotion-succeeded` 行后 `readEventBridgeEvidence()` 的 `gateEvidence` 与 `durable` 变为 `null`。本轮没有
重跑那两项测量，只引用了它已记录的事实。
