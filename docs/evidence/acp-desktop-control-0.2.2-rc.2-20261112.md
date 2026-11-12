# ACP → Desktop 自我进化控制链路：DSH 0.2.2-rc.2 隔离真实宿主验收

基线：`main`（含 PR #55 / #56）之上的 `0.2.7` 候选。本次没有修改正式 `$DSH_HOME`、没有发布正式版本、
没有更新 `release/` 固定点，也没有改动官方 Desktop 源码或 `app.asar`。实际运行的是本机已安装的
DeepSeek Harness `0.2.2-rc.2`（Electron 44.7.0 / Node 24.21.0）。

## 执行的链路

验收脚本：`scripts/acceptance/run-acp-desktop-control.mjs`。使用临时 `DSH_HOME` 与独立 Electron
user-data 目录；模型传输是确定性 loopback fixture，ACP 传输、官方 Desktop 应用、Evolution kernel、
八项门禁、canary/stable、任务通道和 fresh ACP 消费都是真实的。

1. 官方 Desktop 应用初始化临时 home 的 `desktop` profile。
2. 官方安装器（`scripts/setup-experience.mjs --apply`，底层是官方 CLI `dsh plugin add`）安装 `0.2.7`
   tarball，并只在 `desktop` 启用 `evolution-desktop-task-host`、只在 `acp` 启用
   `evolution-desktop-task-client`。
3. 启动正式 DeepSeek Harness 应用（真实 Electron，isolated home），`desktop-task-host` 写出
   `host.json`；用同一 user-data 目录再启动一次，Electron 单实例锁生效。
4. 真实 ACP 进程在自然语言任务里调用 `evolution_desktop`：delegate → status。任务在 Desktop 内执行
   propose → trial → 真实工具样本 → measure → 无 confirmation 的 promote，停在
   `awaiting-owner-confirmation`；返回的 `experimentId` / 候选源码摘要与任务一致。
5. 没有任何 approval 时等待 5 秒并再次读取 Desktop 状态：仍是 `awaiting-owner-confirmation`，共享
   发布索引未变化。
6. 第二个真实 ACP 进程按所有者明确给出的确认调用 `evolution_desktop` 的 confirm；Desktop 校验
   `experimentId + sourceSha256` 绑定后执行 confirmed promote 与两次 canary observation，提交 stable。
7. 第三个全新的 ACP 进程启动时，既有 `promoted-consumer` 自动通过官方 Include 挂载该插件；fixture
   模型调用晋升出的 `acp_stats_*` 工具，真实返回 `{"characters":11,"lines":2}`，consumer 状态
   `active`，ACP 没有修改 Desktop 的发布索引。
8. 重启 Desktop：新的 host instanceId 生效，已 stable 的任务状态与发布索引保持不变。
9. 自动启动：完全停掉 Desktop 后，另一个真实 ACP 会话的 delegate 由客户端自动启动官方应用，新 host
   就绪并把候选带到 `awaiting-owner-confirmation`；验收实例随后被精确停止。

## 关键证据（完整 JSON 见同目录 `acp-desktop-control-0.2.2-rc.2-20261112.json`）

- 验收结果 `ok: true`；tarball SHA-256
  `e90d731faf0fdb29befb11f9b9b7ceaa49a1b12c5207faf27abb03eb24931b9b`，内容摘要
  `122b42526187bf0d76d2222621715f530fb672c654915f99be19f9baa532a8fc`。
- `desktopRecovery`：durable evidence `runtimeRecovered: true`，`recoveryProof.status: "recovered"`，
  恢复前后指纹摘要相同（`f1357a77…`），八项门禁全为 true。
- `publication`：`publisherProfile: "desktop"`、`sourceSha256: "974b7f2e…"`、
  `approvedProfiles: ["acp"]`、stable committedAt 存在。
- `freshConsumer`：工具 `acp_stats_3825c04f` 的真实输出 `{"characters":11,"lines":2}`，consumer
  `active`。
- `noAutoApproval`：等待 5000 ms 后 phase 仍为 `awaiting-owner-confirmation`。
- `restart`：instanceId 从 `063194f5…` 变为 `b1fc2974…`，terminal 任务与发布索引保持不变。
- 单实例：第二次启动 Desktop 后 live host 的 instanceId/pid 不变。
- `autoLaunch`：Desktop 未运行时由 ACP 客户端启动官方应用，新 host instanceId `7a017321…`、
  profile 为 `desktop`、phase 为 `awaiting-owner-confirmation`，验收实例已停止。

## 验收脚本的一处竞态修复

第一次在同一 `0.2.7` 产物上运行时，fresh ACP 的 `session/new` 在 consumer 的启动 effect 完成之前
返回，fixture 第一次取样工具表时 `acp_stats_*` 尚未出现；consumer 状态随后写为 `active`，说明挂载
本身成功。修复只加在验收 runner：`createAcp(..., { waitForPromoted: true })` 等 durable consumer
状态出现 active 后再发第一个 prompt，并让出一个调度回合；随后重跑通过。产品代码、安装器与发布产物
没有为该竞态改动。

## 边界

- 这是隔离 home 的验收，不是正式环境的一次晋升。正式环境只验证“新的 ACP 进程能加载并调用已批准
  插件”与工具可见性，不代替所有者对某个具体新候选的确认。
- 模型是确定性 fixture：它证明“真实工具调用、真实 kernel、真实 ACP 传输”，不证明开放式模型
  自主设计候选的质量。
- 只支持同一机器、同一 OS 用户、同一 `DSH_HOME` 与 macOS 官方 Desktop；任务通道是同一用户可写的
  传输层，不是安全边界。没有使用 Electron 私有认证凭据、调试注入或 `app.asar` 修改。
