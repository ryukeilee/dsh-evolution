# ACP → Desktop 自我进化控制链路：隔离真实宿主验收

基线：`main`（含 PR #55 的消费启动可靠性修复）+ 本树未发布改动。本次没有修改正式 `$DSH_HOME`、
没有发布正式版本、没有更新 `release/` 固定点，也没有改动官方 Desktop 源码或 `app.asar`。

## 执行的链路

验收脚本：`scripts/acceptance/run-acp-desktop-control.mjs`。使用临时 `DSH_HOME` 与独立
Electron user-data 目录；模型传输是确定性 loopback fixture，ACP 传输、官方 Desktop 应用、
Evolution kernel、八项门禁、canary/stable、任务通道和 fresh ACP 消费都是真实的。

1. 官方 Desktop 应用初始化临时 home 的 `desktop` profile。
2. 官方安装器（`scripts/setup-experience.mjs --apply`，底层是官方 CLI `dsh plugin add`）安装本树
   打出的 tarball，并只在 `desktop` 启用 `evolution-desktop-task-host`、只在 `acp` 启用
   `evolution-desktop-task-client`；三个 profile 的托管块按预期为 host/client 选择角色。
3. 启动正式 DeepSeek Harness 应用（真实 Electron，isolated home），`desktop-task-host` 写出
   `host.json`（pid/instanceId/protocol/profile=desktop）。用同一 Electron user-data 目录再启动一次，
   Electron 单实例锁生效，live host 的 instanceId/pid 不变。
4. 真实 ACP 进程（`dsh --profile acp` + loopback 模型 fixture）在自然语言任务里调用
   `evolution_desktop`：delegate → status。工具自动发现已就绪的 Desktop host（未就绪时会启动官方
   应用），任务在 Desktop 内执行 propose → trial → 真实工具样本 → measure → 无 confirmation 的
   promote，停在 `awaiting-owner-confirmation`；返回的 `experimentId` / 候选源码摘要与任务一致。
5. 在没有任何 approval 的情况下等待 5 秒并再次读取 Desktop 状态：仍是
   `awaiting-owner-confirmation`，共享发布索引未变化 —— **Desktop 不会自行批准**。
6. 第二个真实 ACP 进程按所有者明确给出的确认调用 `evolution_desktop` 的 confirm；Desktop 校验
   `experimentId + sourceSha256` 绑定后执行 confirmed promote 与两次 canary observation，
   每次都用真实晋升后工具输出作为 barrier 证据，提交 stable。
7. 第三个全新的 ACP 进程启动时，既有 `promoted-consumer` 自动通过官方 Include 挂载该插件；fixture
   模型调用晋升出的 `acp_stats_*` 工具，真实返回 `{"characters":11,"lines":2}`（输入 `ACP\nDesktop`），
   consumer 状态 `active`，ACP 没有修改 Desktop 的发布索引。
8. 重启 Desktop：新的 host instanceId 生效，已 stable 的任务状态与发布索引保持不变，没有被重跑。
9. 自动启动：完全停掉 Desktop 后，另一个真实 ACP 会话的 `evolution_desktop` delegate 由客户端自动
   启动正式 DeepSeek Harness 应用（隔离 user-data 目录的 wrapper，通过 `DSH_DESKTOP_APP_BINARY`），
   新的 host instanceId 就绪并把候选带到 `awaiting-owner-confirmation`；该验收实例随后被精确停止。

## 关键证据（完整 JSON 见同目录 `acp-desktop-control-20261112.json`）

- 验收结果 `ok: true`；tarball SHA-256
  `cb6a96f9d64b842ab9d3ed21cdbdb26eccb1b64e57e829accde8242cdc2845fd`。
- `desktopRecovery`：durable evidence `runtimeRecovered: true`，`recoveryProof.status: "recovered"`，
  恢复前后指纹摘要相同（`2a04c301…`），八项门禁全为 true（`runtimeRecovered` 为 true）。
- `publication`：`publisherProfile: "desktop"`、`sourceSha256: "1a8a2e1e…"`、`approvedProfiles: ["acp"]`、
  stable committedAt 存在。
- `freshConsumer`：工具 `acp_stats_566d…` 的真实输出 `{"characters":11,"lines":2}`；
  `consumer.status: "active"`。
- `noAutoApproval`：等待 5000 ms 后 phase 仍为 `awaiting-owner-confirmation`。
- `restart`：instanceId 从 `b84ca1bc…` 变为 `dcda3dab…`，terminal 任务与发布索引保持不变。
- 单实例：第二次启动 Desktop 后 live host 的 instanceId/pid 不变。
- `autoLaunch`：Desktop 未运行时由 ACP 客户端启动官方应用，新 host instanceId
  `2604248f…`、profile 为 `desktop`、phase 为 `awaiting-owner-confirmation`，验收实例已停止。

## 边界

- 这是隔离 home 的验收，不是正式环境的一次晋升。正式环境只验证“新的 ACP 进程能加载并调用
  已批准插件”与工具可见性，不代替所有者对某个具体新候选的确认。
- 模型是确定性 fixture：它证明“真实工具调用、真实 kernel、真实 ACP 传输”，不证明开放式模型
  自主设计候选的质量。
- 只支持同一机器、同一 OS 用户、同一 `DSH_HOME` 与 macOS 官方 Desktop；任务通道是同一用户
  可写的传输层，不是安全边界。没有使用 Electron 私有认证凭据、调试注入或 `app.asar` 修改。
- 失败恢复、并发排队、claim 回收与 approval 绑定由 `test/desktop-task-host.test.mjs`、
  `test/desktop-task-client.test.mjs`、`test/desktop-task-integration.test.mjs` 覆盖；本验收覆盖
  真实宿主上的 start/attach/single-instance/approval-gate/stable/fresh-consume/restart 主路径。
