# 统一经验采集与共享

基线：main cb319da / Evolution 0.2.3。用户确认只覆盖 Desktop、ACP、Web；手动 Trial、测量、晋升、回滚集中在 Desktop，CLI/TUI 不在本次范围。当前为开发候选，release/ 固定产物不变。独立审核首轮（codex / gpt-6.1-sol / xhigh）提出 5 项 CHANGES（C1–C5），已修复并由第二轮（pi / opencode-go/deepseek-v4.1-flash，thinking max）复核通过；PR 与 CI 状态以 GitHub PR 为准。

## 实际缺口

只读检查正式 profile 的接入字段发现：Desktop 安装 Evolution 0.2.3，Web 为 0.2.1，ACP 未安装 Evolution，并隔离 storage-json 与 session 根。没有读取正式经验、会话或密钥正文，没有修改正式配置。

官方 ACP 0.2.2-rc.1 有 Agent、tools 和 storage-domain，没有完整 core 要求的 dynamicCordisRunner。安装 bundle 不等于 core 有效挂载。原错误监听器调用 observeAutonomous，observe:false 也不足以关闭它，不能直接用于只采集的路径。

storage-json 整文件替换以进程内单写者为前提。Evolution 在 port 生命周期持有 domain-archive.lock；领域名固定为 evolution_domain，物理路径取决于宿主 storage route。共用归档根会被锁拒绝，只拆 dataRoot 仍可能覆盖同一领域 JSON。

## 实现与权威边界

- 独立 collector 只依赖 tools，订阅官方 agent/error、tools/result。不采集正文、参数、会话选项或完整错误文本，只保存有界类型、错误码、目标元数据。
- SQLite WAL/FULL 事务同时提交事件身份和 canonical 更新，复用现有知识算法及 experienceRecall。只支持同机、同 OS 用户、本地文件系统与同一 DSH_HOME。没有新进化决策引擎。
- 监听器同步 COMMIT 后返回，没有脱离宿主的写队列。未提交的尝试没有持久保证，失败经现有脱敏 warning 边界报告。
- 同一宿主执行对象的重复收据复用随机身份；新的实际执行即使复用模型 callId 也单独计数。原生事件不是跨进程重放日志。签名桥补投按来源 + eventId 持久去重，不依赖 canonical 的 256 条窗口。
- 普通工具成功不构成解决方案。Desktop 已完成的晋升/canary/失败学习事实只共享结构化元数据；重启补投先验签并核对 writer。回滚与 canary 回归降级同目标旧 KNOWN 事实。
- Desktop 保留原领域存储、手动门禁及 startup canary；新增共享发布、共享 recall 和关闭日常自主 listener 的窄接缝。ACP/Web 禁用完整 core，不改 storage route，不共享 journal、claim 或晋升权威。
- 旧自由文本与冷档案原地保留，Desktop 原查询继续可用；ACP/Web 不自动获得旧自由文本。共享查询只提供建议，不授权执行。
- 单命令安装器先显示三个 profile 的计划，--apply 才调用官方 CLI。只维护自己的标记块，保留其他插件、T3 工作流、Skills 与 storage route；HMR 关闭。内容寻址缓存避免同路径重建被包管理器误认为已安装。多 profile 安装不是原子事务，失败逐项报告。

## 本次证明

原始结果在 docs/evidence/unified-experience-entries.json，含候选包摘要和关键运行文件 SHA256；安装后核对三个 profile 的字节与候选 tar 逐文件一致（含新增 lib/experience-history.js）。

Desktop 官方应用使用隔离 DSH_HOME 和 Electron user-data-dir，用户数据目录及单实例锁独立。真实根 Agent、按官方 preset 继承的子 Agent 通过官方 pipeline 触发读文件失败并入库。日常失败没有启动实验。Desktop 显式执行真实 propose/trial/measure，先证明无确认时拒绝，再以测试确认晋升（本次新目标 promotion_probe_r2，经 EVOLUTION_ENTRY_PROBE_PROMOTION_SUFFIX 避免与既有 stable 重名），并执行晋升后的监听器；共享事实在之后启动的 Web/ACP 进程中被读到。

Web 真实 profile 中 core 缺席、evolution-experience-history 独立条目启用，根/子 Agent 均能采集，history 能读取 Desktop 新晋升事实（promotion_probe_r2）和此前累计失败。ACP 同样经该独立条目使用真实 stdio/session/prompt 与官方工具链；本地确定性 Anthropic 响应驱动 provider 失败、真实读取失败及 history 查询，没有模拟宿主事件。ACP 检索到 Desktop 晋升事实，并保留 Desktop/Web 累积失败次数。7 个预期传输响应，没有采集附加回合；history schema 恰好一个、401 字节。

针对性测试覆盖四进程并发、超出 256 窗口的持久去重、冲突拒绝、SIGKILL/事务恢复、回归降级、签名桥补投与序号有序性、原生重复收据、配置保留及幂等；修复后的定向套件 110/110 通过。本次带 4096 MiB 堆上限的全量回归：1,518 通过、2 跳过（共 1,520）；开发态 pack:check 通过。docs/evidence/shared-experience-host-0.2.2-rc.1.json 绑定本候选（sha256 a730a6ac…、content 8e9a620e…）的 21 步隔离宿主验收，含完整手动生命周期、重启、回滚、升级及卸载，HMR 关闭。

## 已纠正的问题与限制

初始化压力下的写锁争用已复现并修复：已有 schema 的打开不取 schema 写锁，首次 schema 等待上限 2 s，WAL 切换有界重试。旧固定包的文件集合对照自己的 sourceCommit 校验，开发树新增文件仍须是已提交后继；发布态严格门禁和 release/ 不变。

早期重复验收把再次执行相同 callId 当作重复投递，已纠正；当前真实入口会增加两次计数，重复收据另由明确标注的 unit event fixture 验证。早期同路径 tarball 安装曾留下旧字节，已由内容寻址安装与磁盘字节核对排除，不能沿用其结果作为最终候选证明。

独立审核发现的五项问题已修复：安装器只切换条目 enabled 标记、配置经官方 composer 保留；REGRESSED 知识不再进入 resolved/复用建议；仅 durable official-include 回滚降级生产事实；签名桥按 writer+sequence 判定补投次序，旧事实不覆盖最新结果；setup 入口按 realpath 识别符号链接。第二轮审核确认五项均消除，仅剩非阻塞 nit（日志重建后的序号回绕、project() 重建 durable 不带 adapter、日常监听默认值写法、传递安装的测试依赖等），已记录为后续项。

在 ACP 会话内直接运行宿主验收时，宿主动态注入的 DSH_PROFILE 会让 live doctor 检查错误的 profile（宿主 CLI 的 profile 选择只认 --profile），验收需清除该变量；清除后 21 步全绿。

没有自动化 Desktop GUI/Web 点击，没有使用正式 T3 会话或外部真实模型服务；证明覆盖实际宿主/ACP 协议与工具链。供应商计费 Token 未测量，不能称零 Token；实际 schema 字节、回合数与 adapter A/B 成本见 docs/performance/shared-experience.md。旧自由文本不自动迁移，去重账本随事件增长，Windows 入口未验收。正式环境未安装、启停、升级或迁移。
