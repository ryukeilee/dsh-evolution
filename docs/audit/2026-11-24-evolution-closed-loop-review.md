# 端到端进化闭环开放式审查（2026-11-24）

基线：`main` / 工作树 `t3/evolution-loop-audit` = `176b655`，版本 `0.2.17`，分发固定点
`e4dd6ac`（`contentSha256 dbe4598f…`）。本文只陈述本轮实际读取、执行和测到的内容；不引用
未重跑的历史验收数字。

## 1. 范围与方法

目标是审查以下链路是否连通、可靠且能产生可验证收益：

```
经验采集 → 经验归纳 → 问题识别 → 候选生成 → 实验验证
→ 稳定晋升 → 跨入口自动复用 → 实际收益计量 → 后续修正与进化
```

方法：三个独立只读调查分别覆盖「采集→候选」「实验→晋升→结论」「复用→收益→反馈」；主代理逐条复核
每个发现，只接受能用源码、固定产物或可执行测试证明的问题。随后对确认的问题做根因修复、补回归测试、
跑全量组件回归，并在隔离环境做代表性端到端验收。没有为了产生改动而修改任何组件。

## 2. 已确认并修复的问题

### 2.1 带空格的问题身份使晋升/canary/失败学习事实被静默丢弃

- 根因：`lib/shared-experience.js` 的 `identifier()` 正则不接受空格；`recordEvolution()` 用它
  校验 `event.target`。但 `evolution_plan` 输出的 `problemKey` 是规范化 scope（`tool:read` →
  `tool read`），验收闭环把该字符串直接作为 `proposal.target` 传回。同一文件里
  `recordConclusion()` 明确允许空格，两个事实族对同一问题身份用了互斥的校验规则。
- 复现（临时隔离库）：

  ```text
  recordEvolution({target:'tool read'}) -> {"ignored":true}
  recordEvolution({target:'tool:read'}) -> {"committed":true,...}
  discover().records[0].problem == 'tool read'
  ```

  `orchestrator.publishSharedExperience()` 只对抛错发 warning，对 `{ignored:true}` 无日志，
  因此丢弃是静默的。
- 修复：`recordEvolution()` 改用与结论目标相同的有界投影 `conclusionText(…, 128)`。
  旧的标识符类输入（`tool:read`、`tool-read`）语义与归一化 scope 完全不变。
- 回归：`test/shared-experience.test.mjs` 新增用例，断言带空格的规范化身份被提交且可发现，
  空白目标仍被拒绝。

### 2.2 门禁拒绝把 measured regression 写成 insufficient-evidence

- 根因：`lib/orchestrator.js` 晋升门禁拒绝分支把结论硬编码为
  `decision.kind === 'no-benefit' ? 'no-benefit' : 'insufficient-evidence'`。而
  `regressionTest` 本身就是 8 项门禁之一：`comparison.regression === true` 时
  `classifyExperimentDecision()` 返回 `kind:'regression'`，却被写成中性事实。
  `insufficient-evidence` 不进入失败信号集合，因此同版本同策略可以被反复重新提议。
- 掩盖原因：现有回归用例在检查结论前先调用 `revert()`，由 revert 写入正确的 `regression`。
  所有者不 revert、进程在 canary 前终止时，regression 事实永久丢失。
- 复现：新增用例先跑通 probe regression + measure（`decision.kind === 'regression'`），
  再 `promote()`（reason `promotion-gate`），**不调用 revert**；修复前
  `findConclusions().best.decision === 'insufficient-evidence'`。
- 修复：门禁拒绝分支透传分类器已得出的 `regression` / `no-benefit`，其余保持
  `insufficient-evidence`。未使用 `conclusionKindFor()`，因为它的
  `benefit → reverted-unconfirmed` 分支会错误描述一次没有 revert 的拒绝。
- 回归：`test/experience-evolution-lifecycle.test.mjs` 新增上述「不 revert」用例。

### 2.3 README 指引的用量投影生成器不在分发包内

- 根因：`package.json#files` 不含 `docs/`，但 README 直接指引安装用户运行
  `node docs/audit/replay/capability-usage.mjs --assessments … --write`。
  用固定产物核对：`release/dsh-evolution-0.2.17.tgz` 只含 `lib/capability-usage.js`，
  不含该 CLI。读取端（`evolution_plan` / ACP `audit`）虽已接好，但标准安装下
  `usage.json` 永远不存在，所有记录停留在 `usage-unknown`，`review-retirement`
  在生产路径上不可达——「实际收益计量 → 后续修正」这一段被分发边界切断。
- 该 CLI 只依赖已在包内的 `lib/capability-usage.js`，相对导入在 tarball 内可直接解析。
- 修复：把 `docs/audit/replay/capability-usage.mjs` 加入 `files`。
  `npm pack --dry-run --json` 复验：72 个条目，同时含 CLI 与共享 scanner。
- 回归：`test/capability-usage-scan.test.mjs` 断言文献指引的生产者在分发清单内且导入可解析。

### 2.4 consumer 缺少宿主身份回退，可能把全部合法复用判成待重验证

- 根因：`lib/promoted-consumer.js` 的 `hostPackageReader()` 只从 `ctx.get('pluginPackages')`
  读取；打包的 Desktop/ACP/Web 入口可以没有 Node 可解析的官方包服务。此时
  `captureHostFacts()` 的 dsh/cordis/include 全为 null，`hostCompatible()` 返回
  `host-version-mismatch`，每条已发布记录都变成 `pending-revalidation` 而不挂载。
- 同仓库的 `captureReviewHost()` 与 `observedHostFacts()` 已有相同场景的回退，并有专门回归；
  consumer 是唯一遗漏的读取端。
- 修复：在 `promoted-sharing.js` 提取单一规则 `completeHostFacts()` / `hostFactsComplete()`，
  review 与 consumer 共用；consumer 用 `detectHostIdentity()` 只填充主读取器未证明的字段，
  并增加可注入的 `detectHost`（生产默认真实检测器）用于确定性测试。
- 回归：`test/promoted-consumer.test.mjs` 新增「没有 pluginPackages 服务」场景，
  断言合格记录仍挂载、工具仍注册。

### 2.5 发现窗口截断信号没有进入 Desktop 的只读审查

- 根因：`sharedExperience.discover()` 报告 `truncated`，ACP 路径把它写进
  `sources.truncated`；但 `orchestrator.plan()` 只取 `records`，`reviewSelfEvolution()`
  也没有把源信息传给 `composeSelfEvolutionReview()`，后者的 `incomplete` 只看 stable 侧。
  超过 500 行发现窗口后，旧证据静默消失，审查仍可能给出「完整」结论。
- 修复：`plan()` 透传 `sources.truncated`；`reviewSelfEvolution()` 把 `plan.sources`
  放进 experience；compose 把 `experience.sources.truncated` 计入 `incomplete`。
  不新增扫描、不改变窗口大小、不改变任何门禁。
- 回归：`test/experience-evolution-lifecycle.test.mjs` 用截断的 `discover()` 桩验证
  plan 与 review 都能报告；`test/self-evolution-review.test.mjs` 验证 compose 的
  `incomplete`。

## 3. 已验证正常的链路

| 环节 | 证据 |
| --- | --- |
| 采集与脱敏 | `experience-collector.js` 的同步 COMMIT 回执、`counted` 去重；`error-boundary.js` 的 64 KiB 有界线性脱敏；`test/experience-evolution-lifecycle.test.mjs` 等回归 |
| 候选生成与形态 | `experience-plan.js` 的逐模式 origin 归类、`loss.breakdown`、`shapeFor()`→`context-policy`；`test/experience-plan*.test.mjs` |
| 实验与门禁 | probe baseline/candidate 同场景摘要、白名单安全执行；`promotionGates()` 8 项 + `workflowBenefit`/`taskBenefit`；`test/experience-evolution-lifecycle.test.mjs` 55 项 |
| 恢复与 journal | `classifyPromotionJournal` 单一分类、`recoverInterruptedPromotion` 与 canary 共用拒绝；未证实清理可重试释放 claim |
| 跨入口共享 | 发布只从 durable stable 事实构造；原子索引/CAS；consumer 逐记录 fail-closed、live fiber 验证；`test/promoted-consumer.test.mjs` |
| 结论写读 | `recordConclusion`/`findConclusions` 同一 scope、指纹与适用版本；`priorIneffectiveConclusion` 拒绝同条件无效策略 |
| 发布一致性 | `npm run pack:check` 17 项；固定产物与 8 宿主验收证据绑定（改动后需本地提交才恢复“已提交后继”判定） |

## 4. 仍缺少证据或属于设计边界（本轮未改）

1. `taskBenefit` 的生产者是仓库内验收 harness，不在 tarball 中；这是明确记录的安全/授权边界，
   不是缺陷。安装用户不能自行晋升 workflow/context-policy 新插件；本轮没有放宽门禁或伪装 harness。
2. canary 观测字段由宿主显式提供，内核的真实探测只在 `agent/pre-step` 的 `verifyStartupCanary()`；
   这是「晋升是 Host-only 且不是安全沙箱」的既定信任模型。
3. 自主观察者不把共享经验里的 `no-benefit` 结论作为抑制输入；其抑制键是模式 + 策略声明指纹与
   持久失败记忆（AGENTS.md §6）。这是设计行为，本轮未改自主路径。
4. `run_code` 被排除在恢复工具集合外：PTC 的成功 run_code 可能只是原始 read 的信封，
   计入会把「假恢复」写进损失指标；这是刻意保守取舍。
5. `OUTPUT_CAPPED` 要求官方 footer 位于 `<content>` 信封末尾；已核对当前官方
   `dsh-tool-fs` 渲染器始终输出该信封。非信封形态只在 harness 直连路径出现，缺少生产证据，
   本轮不据此改动采集规则。
6. 失败码语义被压扁（无结构化码的失败统一为 `HOST_OPERATION_FAILED`）与历史审计文档的部分
   表述漂移属于已知诊断局限，修复需要改持久化契约或重写历史审计记录，本轮未做。

## 5. 复现与验证

```sh
NODE_OPTIONS=--max-old-space-size=4096 node --test \
  test/shared-experience.test.mjs \
  test/experience-evolution-lifecycle.test.mjs \
  test/self-evolution-review.test.mjs \
  test/capability-usage-scan.test.mjs \
  test/promoted-consumer.test.mjs
npm pack --dry-run --ignore-scripts --json
```

（全量结果与隔离宿主验收结果见本轮最终报告。）
