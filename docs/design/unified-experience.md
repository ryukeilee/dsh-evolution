# 统一经验采集与共享：接入审计与实施边界

状态：已实现开发候选，尚未完成三入口全部验收及最终审核，不能据此声称已交付。用户后续确认：手动进化集中在 Desktop；本次只覆盖 Desktop、ACP、Web，CLI/TUI 暂不实施。

## 本次开发进度

- 新增独立 collector、SQLite 事务经验 adapter、单命令 profile 配置器。Desktop 继续独占原 core 领域/归档根；ACP/Web 禁用 core，只提供共享 history；不改变任何 storage-json route。
- 日常 listener 与自主 Trial 分开；默认 bundle 关闭 core 的日常自主监听。手动生命周期与 startup canary 保留。共享元数据复用 canonical 算法和有界 recall；提交完成点是同步 SQLite COMMIT，监听器没有待退出 drain 的异步写队列。
- 原生工具事件按宿主执行对象分配收据身份，同一执行对象的重复投递复用身份；新的实际执行即使复用模型 callId 也单独计数。原生事件不是跨进程重放日志。跨重启补投的结构化事实使用签名桥的来源 + eventId，持久去重不依赖 canonical 的 256 条窗口。曾把两次复用 callId 的执行当作重复事件的验收已纠正，不能沿用其计数结论。
- 针对性测试覆盖四进程并发、超出 canonical 256 窗口的永久去重、SIGKILL 后恢复、共享成功事实的回归降级、签名桥重启补投、无日常 Trial 监听、配置保留与幂等。尚需最终版本全量回归与审核。
- 真实 ACP stdio 初步通过：本地确定性 Anthropic 响应驱动官方 Agent/工具链，provider 实际失败、读文件实际失败及 history 查询均完成；没有模拟宿主事件，没有外部模型调用。五个预期模型传输响应，history schema 恰好一个。不是实际供应商 Token 计费测量，也不是 T3 UI 全程验收。
- 已对开发候选 tarball 执行 DSH 0.2.2-rc.1 隔离 Web 宿主 21 步验收（HMR 关闭），含手动 Trial/测量/恢复、真实晋升、重启与回滚。证据 `docs/evidence/shared-experience-host-0.2.2-rc.1.json` 绑定其 tarball 摘要；后续修改尚需重验受影响部分，不能称其覆盖最终 diff。
- Desktop 正式 profile 没有修改。全新隔离 home 的官方 Desktop 安装被 CLI 拒绝，要求先由 Desktop 应用初始化；尚未找到不接触正式 Electron userData/单实例状态的已验证启动方式。不能用 Web 验收替代 Desktop 真实入口验收。

## 基线与已观察事实

- 开发基线：`cb319da`，Evolution 0.2.3；本次 fetch 后与 `origin/main` 一致。
- 本机 Desktop 携带 DSH / ACP / storage-domain / storage-json 0.2.2-rc.1，Electron Node 24.21.0。
- 只读检查正式 profile 的插件与接入字段：Desktop 安装 Evolution 0.2.3；Web 安装 0.2.1；ACP 未安装 Evolution，并隔离 storage-json 与 session-persistence 根。没有读取用户经验、会话或密钥正文，没有修改这些配置。
- 官方 ACP 与 headless 模板含 tools、agent-loop、storage-domain，但不含 Web 模板中的 cordis-host-runner。`lib/index.js` 强制注入 dynamicCordisRunner，不能把完整 bundle 在这些入口的安装成功等同于运行成功。
- 当前官方安装包含 headless CLI，未找到可用的官方 TUI 模板；TUI 的 default-config 命令失败。CLI 验收以 headless 为对象，不声称支持未验证的 TUI。
- ACP 官方实现通过 `ctx.agents.create()` 创建 Agent，订阅 `agent/error`。tools pipeline 的 `notifyResult()` 对最终冻结结果发出 `tools/result`；execution 有 `callId` 和 `agent`。这是可复用事件合同，不需要解析会话文本。

## 真实 ACP 初步探测

使用新建临时 DSH_HOME，overlay 关闭 hmr，通过 Desktop 官方 CLI 启动真实 ACP stdio。JSON-RPC `initialize`、`session/new` 均成功；`session/prompt` 返回真实的缺少 provider API key 错误（-32603）。没有注入模拟 `agent/error` 或 `tools/result`。

随后用官方 `dsh plugin --profile acp add <release/0.2.3 tarball>` 在同一临时 home 安装成功。尚未证明安装后的 Evolution 有效挂载、错误入库或跨入口检索，不能将这次协议探测算作经验采集验收。测试没有使用正式凭据，也没有证明正常模型调用或有效策略知识产生。

## 存储边界

`storage-json` 使用进程内状态与整文件原子替换；官方注释明确其 last-write-wins 以一个进程内单写者为前提。`storage-domain` 的队列不能提供跨进程 read-modify-write 隔离。

Evolution 的 `openDomainStorage()` 在整个 port 生命周期持有 `domain-archive.lock`，阻止多个实例共享同一个归档根。不同 dataRoot 又不等于不同领域单元：`evolutionDomainSpec.name` 固定为 `evolution_domain`，其实际 JSON 路径由宿主 storage route 决定。因此只改 dataRoot 或只共用 storage-json 根都不是安全共享方案。

现有 `agent/error` / `tools/result` listener 调用 `observeAutonomous()`，它先提交观测，再在策略满足时启动隔离 Trial。日常采集不能通过增加策略或扩大这一入口来实现；采集必须与自主实验决策分开。

## 设计阶段提出的方案（以下不是完成证明）

1. 采集入口只依赖各官方入口实际具有的服务，与 runner / Include / Trial 解耦；沿用官方事件、现有脱敏 DTO、canonical knowledge 规范化/聚合与 experienceRecall。普通成功工具调用不等同于已验证策略，不批量把正文写成知识。
2. 共享范围仅为经验事实与 canonical 投影；完整 Evolution 的 journal、claim、canary、晋升和恢复协议不搬进共享层。正式历史原地保留，不自动迁移或删除。
3. 共享写入必须有实际的跨进程事务与持久事件去重，不能共写现有 JSON 快照。候选为专用经验 SQLite adapter，复用领域知识算法，使用事务提交事件身份与 canonical 更新；尚未选定或实现。必须验证受支持 Node / Electron、锁等待成本、异常退出恢复及旧历史如何参与检索，再定案。
4. 不增加定时器、Agent 回合或自动历史注入。跨入口检索只由显式查询/现有 proposal 动作触发。任何新增工具 schema 的上下文成本必须实测，不能把“无额外模型调用”声称为零 Token。
5. 一条安装命令统一登记三个支持的 profile，底层沿用官方 bundle/profile 管理。默认先显示计划，显式应用时才安装。不得覆盖用户其他插件、storage route、Skills 或 T3 工作流；HMR 关闭，本次不应用到正式环境。

## 未完成的验收

Desktop 实际入口、Web 轻量部署、正常子 Agent 的真实采集；三个入口间的双向检索；最终 tarball 与完整 diff 的针对性/全量回归、独立代码审核、PR 与 CI；真实供应商 Token 与 Desktop UI 的端到端耗时。已完成的初步证据不能替代这些项目。
