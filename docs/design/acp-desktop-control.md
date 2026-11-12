# ACP → Desktop 自我进化控制链路（生产方案）

基线：`main` + PR #55 的消费启动可靠性修复。本文只描述本树新增的机制，不代表已经发布。

## 1. 为什么不是“连到正在运行的 Desktop”

官方 Desktop 运行时（`@deepseek-ai/dsh-desktop-host` + Electron 主进程）把 Web 应用的启动令牌通过
Electron 子进程 IPC 交给窗口；该令牌不落盘、没有公开的读取入口。官方 CLI 明确拒绝在 Electron 之外
boot `desktop` profile（`@deepseek-ai/dsh/lib/bin.js` 的 `rejectElectronProfile`）。因此“读取正在运行
Desktop 的认证地址并提交任务”没有受支持、可维护的入口，本方案不实现它，也不使用 Electron 私有
凭据、调试注入或修改 `app.asar`。

本方案选择的官方机制：

1. **Desktop 侧插件**：`dsh-evolution/desktop-task-host` 由官方 bundle patch 装入 `desktop` profile。
   它只使用官方 Host 服务和官方 tools registry（`ctx.agents.create` 取得实验所有者身份，
   `ctx.tools.get(...).execute(...)` 走真实工具管线），不实现第二个 Evolution kernel，也不做模型调用。
2. **ACP 侧插件**：`dsh-evolution/desktop-task-client` 由安装器只在 `acp` profile 启用。它登记一个
   `evolution_desktop` 工具（delegate/status/confirm），负责发现或启动官方 Desktop、写入任务、读取
   状态与结果、把用户明确确认过的晋升授权写回 Desktop。
3. **跨进程任务通道**：`$DSH_HOME/storages/evolution/desktop-tasks/` 下的原子 JSON 文件。与仓库既有的
   发布索引、撤销表、claim 一样，只支持同一台机器、同一 OS 用户、同一 `DSH_HOME`；所有文件 0600，
   原子写（临时文件 + fsync + rename），不是第二个服务、没有网络监听、没有定时轮询驱动生命周期。
4. **启动方式**：Desktop 未运行时，ACP 侧按官方 macOS 应用路径启动正式 DeepSeek Harness 应用
   （Electron 自己的单实例锁保证不会出现第二个 Desktop）。Desktop 已运行但没有本插件时，明确报错并
   要求重启 Desktop 让新 profile 生效。

## 2. 职责边界

- **Desktop 保持唯一 Evolution kernel 与晋升权威**：propose / trial / measure / promote / canary /
  revert 全部由 Desktop 进程里的真实 `evolution_*` 工具执行；ACP profile 的 orchestrator 保持禁用。
- **ACP 负责发起、协调、接收结果**：ACP 会话里的模型把自然语言任务整理为一份受校验的进化计划
  （proposal 字段、候选 Host 组合、验证样本），通过 `evolution_desktop` 交给 Desktop。候选由 ACP
  模型提出，但**是否实验、是否满足门禁、是否 stable、是否回滚**都由 Desktop kernel 判定。
- **共享插件消费不变**：stable canary 提交后由 Desktop 写出发布索引；新的 ACP 进程启动时由既有的
  `dsh-evolution/promoted-consumer` 通过官方 Include 挂载。本方案不新增消费路径。

## 3. 任务通道布局

```
$DSH_HOME/storages/evolution/desktop-tasks/
  host.json                     Desktop host 启动时原子写入；dispose 时尽力删除
  inbox/<taskId>.json           ACP 写入的任务请求
  state/<taskId>.json           Desktop 拥有的任务状态（客户端只读）
  approvals/<taskId>.json       ACP 写入的、绑定 experimentId + sourceSha256 的所有者确认
  claims/<taskId>.lock          Desktop 任务占用锁（same-machine pid 证明）
```

`host.json`：`{schemaVersion, protocol, instanceId, pid, startedAt, host:{dsh, cordis, node}, profile:"desktop"}`。

任务请求（schemaVersion 1）由 `lib/desktop-task-protocol.js` 校验：

```json
{
  "schemaVersion": 1, "protocol": 1, "taskId": "desktop-task-...",
  "createdAt": "...", "requester": { "profile": "acp", "sessionId": "..." },
  "plan": {
    "proposal": { "why": "...", "target": "...", "impactScope": ["..."], "successMetrics": ["..."] },
    "composition": { "name": "...", "purpose": "...", "code": { "host": "..." } },
    "verification": {
      "targetTool": "tool_name", "observations": 2,
      "samples": [{ "label": "...", "tool": "tool_name", "arguments": {}, "expected": {} }]
    },
    "requestedTargetProfiles": ["acp"]
  },
  "cwd": "/absolute/path"
}
```

状态文件（Desktop 写）phase 词表：

`accepted → running → awaiting-owner-confirmation → promoting → canary-observing → stable`
终态：`stable` / `failed` / `interrupted` / `cancelled`。`failed` 记录有界、脱敏的错误摘要与
revert 结果；`interrupted` 用于宿主重启或进程消失后的遗留任务，**不会被自动重跑**。

确认文件（ACP 写）：

```json
{
  "schemaVersion": 1, "protocol": 1, "taskId": "...",
  "experimentId": "...", "sourceSha256": "64 hex",
  "confirmation": true, "confirmationText": "用户明确确认的原文（有界）",
  "targetProfiles": ["acp"], "confirmedAt": "..."
}
```

Desktop host 只在以下全部成立时把该确认转成 `evolution_promote({ confirmation: true, targetProfiles })`：
状态正停在 `awaiting-owner-confirmation`；`experimentId` 与 `sourceSha256` 和内存中待确认候选完全
一致；`confirmation === true`。任何不匹配都保留现场、写 `failed` 并回滚 Trial，绝不猜测或复用旧确认。

## 4. Desktop 任务执行

`desktop-task-host` 对每个任务：

1. 校验任务文件；`claims/` 取得占用锁（pid 证明）；创建官方 Agent 身份（只作为实验 owner，不触发模型调用）。
2. 等运行时稳定：`evolution_runtime_inspect` 连续 4 次指纹相同。
3. `evolution_propose` → `evolution_trial`（任务里的 host 组合）→ 按 `verification.samples` 调用真实工具
   管线，逐条比较期望值 → `evolution_measure`（样本来自真实调用）。
4. `evolution_promote`（不带 confirmation）必须返回 `awaiting-owner-confirmation`；写状态
   `awaiting-owner-confirmation`，暴露 `experimentId` 与候选源码摘要 `sha256(host code)`。
5. 等待绑定确认；过期、身份不匹配或宿主停止都停在现场并回滚。
6. `evolution_promote({ confirmation: true, targetProfiles })` → `evolution_canary_observe` 按任务
   `observations` 次数，每次先执行验证样本再用真实结果作 barrier 证据；回归时按 kernel 规则回滚。
7. 从 durable evidence / 发布索引读取 stable 事实，写终态结果；任何 Trial 之后的失败路径都尝试
   `evolution_revert`，清理失败如实记录但不覆盖原始错误。

任务执行是确定性的（不调用模型），因此可测试、可复现；新插件的“是否值得晋升”仍由八项门禁、
真实测量与 canary 决定。

## 5. 生命周期、并发与恢复

- **单实例**：Desktop 由 Electron 单实例锁保证唯一；host.json 的 pid + instanceId 用于客户端判断
  “已就绪 / 已消失”，不用于抢占。
- **并发任务**：host 一次只执行一个任务，其余任务按 `createdAt` 排队；占用锁带 pid 证明，死亡进程的
  锁可被同一台机器的下一个 host 回收，活着的 owner 永不回收。
- **宿主重启**：非终态任务在下次 host 启动时标记 `interrupted`，不会自动重跑；已经 durable 的
  stable 事实不会被撤销。
- **ACP 侧失败**：客户端超时只报告真实状态，不合成结果；任务与状态文件保留供下一次会话查询。
- **Desktop 未运行**：客户端启动正式应用；启动失败或版本不含本插件时给出可操作的错误，不伪造成功。
- **不破坏既有数据**：任务通道只写 `storages/evolution/desktop-tasks/`；不修改 Desktop 会话、配置或
  正在执行的任务。

## 6. 安全与信任边界

- 仅同一机器、同一 OS 用户、同一 `DSH_HOME`；目录 0700、文件 0600。
- 任务通道是“同一用户可写”的通道，不是安全边界；与发布索引、claim、共享经验库的前提一致。
- 推广仍需真实所有者确认：ACP 工具要求 `confirmation: true` 与用户确认原文；Desktop host 用
  `experimentId + sourceSha256` 绑定本次候选，绝不自动批准，也不把旧确认复用到新候选。
- 不使用 Electron 私有认证凭据、调试注入、签名绕过或修改 `app.asar`。
