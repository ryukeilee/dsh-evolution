# 遗弃的自主决策占位：优化前后对照

本轮唯一保留的改动。目的是修掉一个**永久性**的自治循环失效，不是性能收益。

## 问题：进程结束后遗留的决策占位会永久退休一个假设

`reserveAutonomousDecision` 在 Trial 触碰 runner **之前** 就持久占位，这是正确的：晋升绝不能用旧
Trial 的证据。释放它只有两条路径——已证实的 `revert`，或一次干净丢弃的环境类失败。**进程先结束时
没有任何路径释放它**：崩溃，或者一个 `measured` 候选还在等所有者确认时正常退出（`measured` 的
Trial 是本进程的运行时事实，重启后既不能晋升也不能 revert）。

于是占位比它描述的 Trial 与其记录活得更久，之后的每个 session 都用 `prior-decision-requires-owner`
回答这个假设——一个**没人能做的决定**。占位表只保留最近 200 项，所以实际上就是永久。这与
`cleanupAutonomousTrial` 和清理重试要防的是同一类失效（一次暂时性故障不该结束循环），只是那种
失效还能在后续观测里被看到，这种不能。

## 改动

`openDomainStorage` 在打开端口时（`replay()` 之后、本进程还不可能占位之前）记录当时已存在的占位，
经只读的 `autonomousDecisions()` 暴露。`observeAutonomous` 遇到一个本进程不存在的决定时先问这份
快照：占位是本进程继承的、且本进程内**没有任何记录**回答该身份，就释放并重新占位，然后照常建立一次
隔离 Trial；响应里的 `decisionRecovery`（`reason: previous-session-decision`）如实报告这次释放。

两道边界，都不放松：

- 本进程自己取得的占位永不当成遗弃（快照只包含打开时的状态）。
- 只要本进程内仍有记录回答该身份（`measured` 待确认、宿主尚未批准的 Trial、未证实的清理）就不释放。

晋升授权、门禁、二次确认与所有所有者动作未改动。自主决策从不晋升，`promote` 仍要求本进程内有活动
记录（`requireOwned`），这次释放既不能创建、批准也不能回滚任何实验。代价上限是一个假设多跑一次
隔离 Trial，而那次 Trial 仍然停在 `candidate-awaiting-confirmation`；一个 session 内仍只有一个
Trial。

## 可复现的前后对照

三个进程、同一个数据根：先只占位不 Trial（模拟“取下决定后进程结束”），再各观测两次同一故障。
每次 session 都是新进程，所以上一个进程的 target claim 由 `process.kill(pid, 0)` 证明已死，而不是
假设已死。

```sh
ROOT=$(mktemp -d)
S=test/fixtures/autonomous-decision-session.mjs
node "$S" "{\"root\":\"$ROOT\",\"seed\":true,\"rounds\":0}"
node "$S" "{\"root\":\"$ROOT\",\"rounds\":2}"
node "$S" "{\"root\":\"$ROOT\",\"rounds\":2}"
rm -rf "$ROOT"
```

`0.2.0` 之后 `main`（改动前，`48bde593`）的输出，`inherited` 恒为 0，因为端口没有这个读：

```
{"pid_role":"seeded",  "inherited":0,"phases":[],"experiments":[],"suppressed":0}
{"pid_role":"session", "inherited":0,"phases":[
   {"phase":"pattern-observing","reason":null},
   {"phase":"candidate-awaiting-confirmation","reason":"prior-decision-requires-owner"}],
 "experiments":[],"suppressed":0}
{"pid_role":"session", "inherited":0,"phases":[
   {"phase":"candidate-awaiting-confirmation","reason":"prior-decision-requires-owner"},
   {"phase":"candidate-awaiting-confirmation","reason":"prior-decision-requires-owner"}],
 "experiments":[],"suppressed":0}
```

本轮的输出：

```
{"pid_role":"seeded",  "inherited":0,"phases":[],"experiments":[],"suppressed":0}
{"pid_role":"session", "inherited":1,"phases":[
   {"phase":"pattern-observing","reason":null},
   {"phase":"candidate-awaiting-confirmation","reason":null,"recovered":true}],
 "experiments":["measured"],"suppressed":0}
{"pid_role":"session", "inherited":1,"phases":[
   {"phase":"candidate-awaiting-confirmation","reason":null,"recovered":true},
   {"phase":"candidate-awaiting-confirmation","reason":"already-measured-awaiting-owner"}],
 "experiments":["measured"],"suppressed":0}
```

差别是可判定的：改动前两个 session 都永远拿不到实验（`experiments: []`）；改动后每个 session 放出
一次隔离 Trial 到 `measured`，第二个 session 的第一条观测报告了一次 `decisionRecovery`，其余观测
报同一个候选（`already-measured-awaiting-owner`），`suppressed` 始终为 0，即没有任何东西被记成
“这个策略不行”。

`test/autonomous-decision-recovery.test.mjs` 把这三段流水线钉成 3 项回归；它们在改动前的实现上
2 失败 1 通过（通过的那项是本 session 自己的占位仍然生效），所以放宽的只有“遗弃占位”这一条。

## 边界与未验证项

- 占位表仍只保留最近 200 项（`slice(-200)`）。第 201 个占位会让最早的被静默丢弃，那一项本来就
  重新可试；本轮没有改动这个上限。
- 一个假设在**同一 session 内**仍然只跑一次 Trial。跨 session 的重复只发生在“重启后同一故障再次
  达到 `patternThreshold`”时，且每个 session 仍只跑一次。
- 本轮没有改 Trial 基线、跨进程锁、CAS、journal、canary 与启动恢复，因此没有重跑三宿主安装验收
  之外的针对性探针；真实宿主的 21 步验收由 CI 的三个作业（`0.2.0-rc.2` / `0.2.1-alpha.1` /
  `0.2.1-rc.2`）执行，本轮只在本机跑了完整单测与 `pack:check`。
- `release/`、`release/manifest.json`、版本号与三份已提交宿主验收证据一律未改：本轮是
  `0.2.0` 固定点的**开发后继**，不是新的发布固定点。
