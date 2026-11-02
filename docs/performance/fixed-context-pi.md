# 固定上下文候选：Pi 免费模型的请求级对照

结论：**未采纳生产文案改动**。候选减少了真实请求中的输入 token，但完整任务收益尚未证明明显超过 A/A 波动。`lib/`、10 个工具的名称/Schema/说明/执行函数、授权及发布产物均不变。交付的是可复现的测量入口、失败记录和审计夹具修复，不是已上线的成本优化。

环境：Node `v26.13.0`、Pi `1.4.0`、macOS arm64。修正授权采样期间同时执行过本地回归；本轮不以耗时作为判据，也不推断延迟收益。

基线是 `origin/main` 的 `a39b0889f6ef7f96378e25c2955812aafb065549`。复用已有 `axis-token-audit` 的固定字段口径及紧凑渲染结论，没有重做已落地的结果渲染优化。首轮重跑旧审计脚本因第一条 Trial 尚未清理就启动第二条而报 `E_EVOLUTION_RUNTIME_BUSY`；本次补上官方 disposer 的夹具回执及两次 revert 恢复断言，11 个原场景重新通过。

## 候选与固定内容

候选只存于 `scripts/benchmarks/fixed-context/candidate-system.txt`，不被生产入口加载。合并 systemText 与工具说明中重复的生命周期、召回、回收说明，保留独有的生命周期顺序、Cordis 所有权、实验先于永久规则、召回建议、owner 确认和回收不可替代门禁等指导。10 个工具的全部说明和编译后参数 Schema 保持逐项相同。`summary.json` 保存两份完整 system text、原始注册 Schema 和源文件摘要。

| 口径 | 原文 A | 候选 B |
| --- | ---: | ---: |
| systemText UTF-8 字节 | 2,852 | 2,009 |
| 固定字段内容字节 | 9,716 | 8,873 |
| 原审计声明的紧凑包装字节 | 10,147 | 9,304 |
| 同任务首次请求实测输入（生命周期示例） | 1,935 token | 1,758 token |

首次请求实测差在全部 6 对 A/B 中都是 **177 token**；6 对 A/A 差都是 0。请求 hook 校验了每次实际发送的 system text 前缀及完整工具名称、说明、Schema；Pi 另追加 `<cwd>`，已显式核对并计入实际用量。这个首请求数包含任务文本和 Pi 包装，**不是固定部分单独的绝对 token 数**。固定部分的绝对 tokenizer 计数未隔离；旧报告的 bytes/3.6 仍只是估算，不升级为实测或计费数。减少字节本身不证明 Agent 行为等价。

## 任务、A/A 和 A/B

通过 Pi `opencode-go/beam-free`，thinking=low，关闭内建工具、自动扩展、MCP、技能、提示模板、上下文文件和 session 保存。每次独立进程/临时工作目录/领域存储，通过 Pi 官方扩展透传**真实 Cordis ToolRuntime 已注册的工具定义及 execute**，Host 代码由官方 Host Runner 实际运行，持久领域存储使用官方 DomainFacility + JSON backend。不存在第二套生产注册机制。fixture 通过公开 define/run/stop/undefine 先初始化 runner 的惰性共享组，避免把其初始化错判为 Trial 漂移。

三种完整任务：

1. inspect → propose → trial → measure → revert，验证提供的合成观测和真实运行时恢复。
2. 相同候选测量后，promote 不带 owner 确认，检查 awaiting-owner-confirmation，随后 revert。
3. inspect + 带 query 的经验召回 + maintain dryRun，报告实际回收计数而不删除字节。

性能观测数值是任务提供的合成数据，不是本次真实性能收益。任务原文和工具参数见脚本/逐样本记录。每类两轮 A/A、两轮 A/B，第二轮交换先后顺序；A/A 两侧都使用原文。每次独立执行，不固定 UUID、采样时钟、模型输出或 provider 缓存，缓存读写 token 单独记录并计入累计输入。串行执行，无并行模型采样。

预跑时模型生成 Host 代码产生了 `ctx is not defined`、缺 return 和对已丢弃实验的重试；预跑完整调用/错误/usage 留在 summary 的 pilots 中，不计入正式矩阵。正式任务两侧都提供同一合法 Host 代码，聚焦固定上下文而非代码生成。首批 24 次的授权任务还暴露出 fixture 未挂 Include：8 次都被 adapter 前置条件拒绝，不能充当 owner 确认验证。保留该批数据，补上**真实官方 Include adapter** 后仅重跑受影响的 8 次；离线回归钉住了“能到达确认分支且 composition 不变、revert 恢复”。有效矩阵由原生命周期/容量任务 16 次及修正授权任务 8 次组成，未删除任何失败样本。

## 实际用量和结果

有效矩阵 24 次任务、122 次模型请求，累计输入含缓存 941,263 token，输出 27,203 token。逐请求原始 usage 来自 `message_end.message.usage`；payload 摘要、字节数、调用参数、错误、门禁、回收结果、最终回答和最终 claim 状态均保留。费用字段全部为 0：这是 **Pi 对免费模型上报的 catalog cost**，没有独立供应商账单核验，不能外推付费模型账单或声称节省了实际金额。

下表是各组两对任务累计输入（含 cacheRead/cacheWrite）的 `(A-B)/A`，不是请求数或工具结果字节降幅。

| 任务 | A/A 自身差异 | A/B 观察到的减少 |
| --- | ---: | ---: |
| 生命周期 | 13.75% | 5.56% |
| owner 确认（Include 修正后） | -2.85% | 4.47% |
| 召回与只读回收 | 26.21% | 5.57% |
| 全部按累计输入加权 | 5.99% | 4.93% |

A/A 单对变化范围 -4.38% 到 41.31%，包含额外请求、重复调用和输出差异。不能将加权 A/A 的 5.99% 当作噪声上界，也不能从小样本推断候选无效；这里只能说**尚未证明显著端到端收益**，因此不进入生产。

任务成功判定同时检查工具/顺序、合成观测的 before/after/sampleCount/window、measured gates eligible、禁止确认/删除、确认分支及恢复后无 claim。A/A 两侧各 5/6 通过：一次重复 measure 且原观测 gates 不全，一次遗漏观测字段。A/B 两侧各 6/6 通过。有效矩阵有 1 次工具错误；没有 confirmation:true、实际回收或生产写入，所有任务最终释放了 claim。未发现这组 A/B 的实质回归，但每类仅两对，**不是成功率非劣效或广泛决策质量的统计证明**。最终回答保留供审核，未用模型自评分冒充质量验证。

## 复现、验证和边界

```sh
# 需要已安装、可通过 Pi 正常使用的免费 Beam；不读取或导出凭据。
python3 scripts/benchmarks/fixed-context/suite.py /tmp/evolution-fixed-new-run
python3 scripts/benchmarks/fixed-context/summarize.py /tmp/evolution-fixed-new-run > /tmp/evolution-fixed-summary.json
node --max-old-space-size=4096 --test test/fixed-context-fixture.test.mjs
node --max-old-space-size=4096 scripts/benchmarks/axis-token-audit.mjs > /tmp/evolution-fixed-audit.json
NODE_OPTIONS=--max-old-space-size=4096 npm test
npm run pack:check
```

复现入口已包含修正后的 Include；不会重现原先 adapter 缺失的配置错误。固定文案和 Schema 可逐字复核，随机身份、日期、模型输出及缓存使累计用量不保证重现完全相同数字。诊断工具在这三种任务中未调用；早期夹具的诊断占位分支未进入任何模型结果，当前入口已改为只读取隔离 home 的真实诊断。`fixtures` 不是完整 DSH 进程：未覆盖 agent-loop、完整宿主提示词、正式用户任务分布、长会话压缩或 UI。真实宿主组件的集成不等于完整 DSH 宿主验收；本轮没有运行 `acceptance:host`，也没有为未采纳的生产文案声称通过该验收。

实际验证：`NODE_OPTIONS=--max-old-space-size=4096 npm test` 全量 1,345 项通过，`pack:check` 通过，旧审计 11 个场景通过，逐请求 wire/Schema 断言及 fixture 回归通过。固定点未更新。独立审核状态见交付记录，本报告不构成生产上线许可。

证据：`fixed-context-pi-summary.json`（汇总、完整文案/Schema、源身份、预跑），`fixed-context-pi-original.json`（首批 24 次，含 adapter 错误），`fixed-context-pi-approval-corrected.json`（8 次修正验证）。
