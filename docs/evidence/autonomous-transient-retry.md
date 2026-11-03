# 自治循环：一次环境冲突不再让假设停到重启

基线 `main` 的 `47fee8e`（`Merge pull request #22`）。本文件记录本轮修复的复现、改动与已执行的验证；
`docs/evidence/autonomous-pattern-evidence.md` 记录的是上一轮（证据窗口并集）的边界，它把这条限制列为
“本轮未改”，本轮单独处理它。

## 1. 修复前可复现的缺陷

自主观察者早就在持久层区分两类失败：说声明本身有问题的（测量无改善、门禁拒绝）写进失败记忆；说环境
有问题的（`E_EVOLUTION_RUNTIME_BUSY`、target claim 冲突、操作忙、权限/资源错误、被取消的运行）只留在
归档证据里。session 层没有这条区分：`observeAutonomous` 的 `catch` 对**所有**失败都调用
`suppressForSession(identity)`，而 `suppressedPatterns` 只随进程结束清除。于是一次环境冲突把该假设停到
重启，即使冲突在同一 session 内早已解除。

修复前在仓库内用同一份 orchestrator fixture 复现（`test/autonomous-transient-retry.test.mjs` 的
fixture；runner 只实现文档化的 define/run/stop/undefine 回执形状，A 的 `measure` 返回合格证据）：

```
A#1 pattern-observing
A#2 candidate-awaiting-confirmation                 # 运行时与 plugin:fix-a 的 claim 都在 A 手上
B#1 pattern-observing
B#2 experiment-deferred transient-failure
    another experiment occupies the runtime (... measured); revert or promote it before starting a new Trial
revert A: true                                      # 运行时空出，claim 已释放
B#3 suppressed duplicate-failure                    # ← 缺陷：环境冲突解除后仍被抑制
B#4 suppressed duplicate-failure
experiments: [ 'exp-...:reverted' ]
```

`B#3` 就是缺陷本身：A 已被 revert、`core.targetOwners` 与 `ownership/` 里都不再有 `plugin:fix-a`，B 的
下一步观测仍然只得到 `suppressed` / `duplicate-failure`。修复前唯一的出口是重启宿主。

## 2. 改动

环境类失败改为**推迟**，不是抑制：

- `deferForSession(identity)` 在 `deferredPatterns` 里写 `{ attempts, at }`；同一个身份的真实策略失败
  （`suppressForSession`）会删掉这条推迟，session 抑制与持久失败记忆仍是终局判定。
- `observeAutonomous` 在 `suppressedPatterns` 判定之后、持久失败记忆判定之前读取这条推迟：冷却期内的
  观测返回 `phase: experiment-deferred`、`reason: transient-retry-cooldown` 与 `retryAfterMs`，
  不 propose、不 acquire、不 define；冷却过后的一次观测消费这条记录，并按第一次尝试的完整路径重试。
- 冷却间隔是 `transientRetryCooldownMs`，默认 `AUTONOMOUS_TRANSIENT_RETRY_COOLDOWN_MS` = 30 s，`0`
  仅供测试。它和 `cleanupRecoveryCooldownMs` 同形：条件在观测到达时求值，没有定时器、没有轮询、空闲
  session 不重试；持续冲突每次冷却最多一次尝试，不是每个错误事件一次。
- 重试没有绕过任何门禁：`recoverAutonomousOccupancy`（未证实清理）、`pendingAutonomousCandidate`
  （同一假设已 `measured`）、`assertRuntimeAvailable`（同一进程一次只有一个 Trial）、target claim、
  同一身份上的持久失败记忆，依次照常判定；`this.observing` 仍保证并发观测同一假设只有一个 Trial。
- 推迟表与其它 session 表共用 `AUTONOMOUS_PATTERN_CAP`（200）上限，且只在内存里：重启后不做任何推测
  （下一次观测按既有语义重新尝试，环境失败仍然从不落盘）。

修复后同一 fixture（`transientRetryCooldownMs: 0`，即冷却一过就重试）：

```
A#1 pattern-observing
A#2 candidate-awaiting-confirmation
B#1 pattern-observing
B#2 experiment-deferred transient-failure (runtime busy)
revert A: true
B#3 candidate-awaiting-confirmation                 # ← B 在同一 session 内恢复并测出证据
B#4 candidate-awaiting-confirmation already-measured-awaiting-owner   # 不重复 Trial

experiments: [ 'exp-...:reverted', 'exp-...:measured' ]
```

保持默认 30 s 冷却时，`B#3` / `B#4` 得到 `experiment-deferred` / `transient-retry-cooldown`（带
`retryAfterMs`），既不 propose 也不 define；冷却过后的一次观测才重试。

未改动：晋升权威与 8 项门禁、风险分级、`confirm` / `deny` 策略、target claim 与跨进程协议、持久 schema、
工具名与参数 schema、失败记忆的容量与身份。模型不参与判定。

## 3. 已执行的验证

- 定向回归：`node --max-old-space-size=4096 --test test/autonomous-transient-retry.test.mjs
  test/autonomous-continuity.test.mjs test/autonomous-cleanup-recovery.test.mjs
  test/autonomous-durable-observations.test.mjs` → 52 pass。
- 相关集合：`node --max-old-space-size=4096 --test test/autonomous-*.test.mjs
  test/quality-consolidation-trial.test.mjs test/revert-unproven-cleanup-retry.test.mjs` → 84 pass。
- 全量：`NODE_OPTIONS=--max-old-space-size=4096 npm test` → 1386 项，1385 pass；唯一失败是提交前的
  `test/release-pin.test.mjs`（“工作树带有未提交的分发改动”），提交后同一命令全绿。
- 打包：`npm run pack:check` → 提交后 16/16 通过（`--release` 语义未跑，本轮不更新 `release/` 固定点）。
- 三宿主真实验收（同一份产物、隔离 runtime/home，串行）：

  | 宿主 | 结果 | 证据 |
  | --- | --- | --- |
  | `0.2.0-rc.2` | 21/21 ok | `docs/evidence/autonomous-transient-retry-0.2.0-rc.2.json` |
  | `0.2.1-alpha.1` | 21/21 ok | `docs/evidence/autonomous-transient-retry-0.2.1-alpha.1.json` |
  | `0.2.1-rc.2` | 21/21 ok | `docs/evidence/autonomous-transient-retry-0.2.1-rc.2.json` |

  产物 `dsh-evolution-0.2.0.tgz`：sha256
  `c013073e07c2bc0c442d2f3234f397a8cfe73cc6a6f1c6493b057833dd18d801`，内容摘要
  `5de24d11ed6ca741023d3fac65045274fb0912847bd5d71fa9ff9626760f4f94`（51 个条目），Node
  v26.13.0 / darwin-arm64。验收步骤覆盖安装、doctor、核心流程、disable/enable、卸载/重装、升级/回滚，
  以及 `promotion-restart-and-rollback`（重启恢复与回滚）。
- 独立审核：sol-loop 第 1 轮，GPT-6.1 Sol（`codex` / `gpt-6.1-sol` / `reasoningEffort: xhigh`），
  `VERDICT: APPROVE`，无 finding。

## 4. 边界与剩余风险

- **恢复需要一次新的观测。** 推迟在观测到达时求值，没有定时器：冲突解除后要等同一模式的下一条错误
  事件才会重试；默认最多多等一个冷却间隔（30 s），空闲 session 不会自行重试。这是有意保留的驱动方式。
- **推迟只在内存里。** 进程重启即清空；环境失败仍然从不写入失败记忆，所以重启后的第一次达到阈值的
  观测会直接尝试（与修复前一致）。
- **持续冲突仍会按冷却重试。** 每次尝试会 propose 后丢弃一条 `proposed` 记录（`cleanupAutonomousTrial`
  的既有路径），不拿 claim、不 define、不留终态记录；上界是“每个冷却一次尝试 + `AUTONOMOUS_PATTERN_CAP`
  个推迟项”，不是无限循环。
- **环境判定仍是既有的文本分类**（`TRANSIENT_AUTONOMOUS_FAILURES`，有界、无回溯正则）。被误判为环境的
  真实策略失败会按冷却重试而不是本 session 抑制；每次重试仍受同一组门禁约束，风险有界。本轮没有改动
  分类表。
- **没有更新发布固定点。** `release/` 不变，这是 `0.2.0` 固定点的开发后继；重新固定需要按 `RELEASE.md`
  重新打包、验收并发布。
