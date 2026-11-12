# 0.2.6 消费启动可靠性修复与 ACP 驱动 Desktop 隔离验收

基线：`origin/main` / `150be593a41b9c585403a0fce5dab39c3acd597c`。本次未修改版本号、发布固定点、正式 home、官方源码或正式 profile；没有发布正式版本。

## 实际修复

- `include-unavailable` 发生在空 Include 建立阶段、尚未执行发布源码，属于宿主可用性诊断，不再成为每个插件的永久 sticky 失败。旧格式的这类记录也按同一规则处理，所有源码、批准、版本、能力及撤销门禁仍重新执行。
- 只有官方 `INACTIVE_EFFECT` 且 child 清理已证明（或请求 context 已失活、未创建 child）时，空 Include 启动最多尝试三次，间隔 100 / 200 ms；其他失败不在启动内重试。真实插件 apply 失败、refresh 失败和未知失败仍 sticky。
- 每个启动会话独立 composition；状态会话在读取索引前取得，复用既有 SQLite 跨进程互斥协议执行短 CAS。旧 host 的迟到启动/退出报告不能覆盖新 host。正常退出在证明清理后删除本会话 composition；崩溃残件保留。
- dispose 加入尚未完成的 mount，并共享同一完成结果；取消评估也保留已有真实失败，宿主 Include 失败不会覆盖它们。

## 真实调用链与证据

[完整隔离链路](acp-desktop-loop-20261112.json)：

1. 官方 ACP stdio 建立真实 Agent；确认没有 `evolution_trial` / `evolution_promote` kernel 工具。loopback Anthropic 响应仅选择真实 `bash` 工具，不伪造其执行结果。
2. ACP 的真实 `bash` 工具启动 `run-desktop-task.mjs`。该脚本通过已验证的临时 Desktop profile probe + 隔离 Electron user-data 方式启动本机官方 Desktop；外层驱动不事先生成晋升成果。
3. Desktop Electron 44.7.0 / Node 24.21.0 内，通过官方 tools registry 执行 propose → trial → 两次真实工具调用和渲染校验 → measure → 无确认 promote，停在 `awaiting-owner-confirmation`。
4. 用户在本会话明确批准实验 `exp-mwd75lwx-1-b5c1106e`、Host 源码摘要 `413bb1d96204489acd527f70687c87e20d62b0735ee4c43bf2f2f775df65c3c0`，仅在临时 home 向 ACP 发布。approval receipt 精确绑定上述身份；没有用前一个候选的批准替代它。
5. Desktop confirmed promote 实际清理 Trial 并通过运行时恢复门禁；两次工具执行后的 canary 屏障提交 stable，发布索引由 Desktop 写出。没有由 ACP 合成 stable 或修改索引。
6. 结束原 ACP，显式注入旧格式 `include-unavailable` 消费诊断（这是故障注入，非真实插件失败；没有修改 stable/index），再启动全新的 ACP。consumer 自动校验并加载插件；真实 Agent 工具调用返回 `{"characters":11,"lines":2}`，输入为 `ACP\nDesktop`。发布索引字节保持不变，三个 profile 的 patch 均保持不变。

完整链路打包字节 SHA-256：`7db8d37a5d9c741bcf2ffd97158cd7a3d733a6eb5471f2acfedbbc6242302c23`。随后新增的取消评估失败记录保留仅影响 consumer，最终打包字节为 `a30e3ed181675fd58fd3ccfd10b1d6803f69d76f8a037906867fd897414bfdbd`，内容摘要 `f127d047a25106fe6e6e68e253b35630fd6b63a08d8af57a743ae7c4de20fc42`。通过官方安装器更新隔离 profiles 后，只重跑受影响的全新 ACP 消费阶段，没有重复 Desktop 晋升或取得额外晋升授权。

[最终补丁消费证据](acp-desktop-consumer-final-20261112.json) 同时读取 Desktop 原始持久 evidence sidecar，记录其字节摘要、清理证明、恢复前后指纹和生产 `gateEvidence.gates`：八项及 eligible 全为 true、恢复指纹相同。measure 阶段的 `runtimeRecovered: false` 是 dispose 前的只读视图，不能替代该生产证据。

## 失败及修正记录

- 第一轮 fixture 没传真实 bash 必填的 description，真实管线拒绝；修正测试请求后继续，未宣称通过。
- ACP shell 沙箱下 Electron 实际报 EPERM，无法初始化子进程。仅停止本轮自己启动的测试进程后，通过宿主单次命令升权和 allow-once 审批重试；授权来源是本任务/full-stop 对必要测试的授权，没有修改全局沙箱策略。
- 初始测试候选使用错误的官方 schema DSL，被真实 runner 拒绝，见[初始失败](acp-desktop-loop-initial-failure-20261112.json)。
- 第一份获批候选的 execute 正确，但 renderer 用错 `(args, value)` 签名，真实 ACP 返回输入参数而非统计值；该轮明确失败，见[renderer 失败](acp-desktop-loop-renderer-failure-20261112.json)。修正候选重新 Trial/Measure，并取得用户对新源码摘要的明确批准后，才完成后续晋升。旧候选只保留在临时验收 home，没有迁移到正式环境。

## 必要验证

- 最终 `node --max-old-space-size=4096 --test test/promoted-consumer.test.mjs test/promoted-consumer-process-state.test.mjs`：25/25。覆盖真实 Cordis Fiber 保留启动错误、有限重试、真实失败保留、两种迟到 mount、跨进程 CAS、并发停止和取消评估。
- 实施阶段 consumer/sharing/diagnostics/paths/packaging 43/43；consumer/official-include/publish-safety/operator-CLI 36/36（包含重复用例，不相加）。最终涉及变更的用例按上述 25 项重跑。
- `release:pack` 双打包字节一致；未调用 `release:publish`。
- `pack:check` 在未提交分发修改时按预期拒绝“已提交后继”检查，其余 16 项通过；提交后开发模式 17/17 通过，确认本树是发布固定点的已提交后继；固定产物、固定点及其验收证据保持原样，不等于本树已成为正式发布包。
- 本机没有重复执行已通过的四宿主全量验收或全量单测；PR CI 仍按仓库既有要求执行。

## 明确未实现的自动化

本次证明的是**真实 ACP 工具发起的隔离新 Desktop 启动、真实 Evolution 和新 ACP 自动消费**。测试使用临时 probe 来执行候选，模型输出是确定性 fixture，不是开放式模型自主设计候选的验收。

仓库没有现成的、向已运行正式 Desktop 发现并提交任意任务的 ACP 控制入口。官方 Desktop 的认证连接地址通过 Electron 私有 IPC 交给界面；本次没有读取正式会话凭据，也没有增加新的远程控制服务、认证凭据发布机制或第二套 kernel。因此“用户在任意日常 ACP 会话提出任务，自动复用已运行正式 Desktop”仍未实现，不能把本次隔离验收宣称成该日常工作流已交付。`run-desktop-task.mjs` 只接受临时 home，不是正式环境安装/协调命令。

## 独立审核记录

两轮只读审核请求与返回均指定 Codex / `gpt-6.1-sol`、`reasoningEffort=xhigh`；工具没有提供实际执行模型/档位的独立运行证据或 usage，故不宣称 Xhigh 已验证，不估算 token 数。

- S1（blocker）：真实 Fiber 清理后 `await()` 仍抛原启动错误，重试许可未生效。已修复并由第二轮复核确认解决。
- S2（blocker）：旧 mount 延迟读取索引后重新 claim，可覆盖新 host。已前移 claim，并由第二轮复核确认解决。
- S3（should）：验收复用旧 home 时可能把旧包执行结果标记为新 tarball。已删除跳过安装的条件，每轮先经官方安装器安装指定包；最终消费阶段实跑 `ok:true`，另核对 Desktop / ACP / Web 各 61 个分发文件均与指定 tarball 字节相同。该最小修正由主 Agent 完成并验证，按当前编排规则未再委派复核；末轮原始结论是 CHANGES，不能改写成最终独立 APPROVE。

变更规模以最终 PR diff 为准。没有拒绝的审核发现；没有为了审核增加新运行时或正式控制接口。
