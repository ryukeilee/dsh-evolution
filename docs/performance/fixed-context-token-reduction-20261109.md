# 固定模型上下文：压缩 system prompt 与工具描述

本轮把 Evolution 每个模型请求都会携带的固定文本压到原来的约五分之四，同时保留全部安全检查、授权条件、生命周期约束与操作指导。基线是 `origin/main` 的 `25d6200`；候选只改 `lib/registration.js` 的模型可见文本（`systemText`、10 个工具的顶层 description、编译后参数里的 description）和一处参数 Schema 编译行为：`type: "json"` 的字段不再丢弃作者声明的 description（接受的值形状未变）。工具名、参数名/类型/必填集合、注册机制、执行函数、返回结果与安全门禁都没有改。

结论（本次实测）：

- 固定字段 UTF-8 字节 `9716 → 7674`（**−21.02%**）；紧凑工具数组包装 `10147 → 8105`（**−20.12%**）。
- 真实 provider 计数（同一免费模型、同一 prompt、交替 A/B）：首次请求输入合计 token `1793 → 1415`，**每请求 −378（−21.08%）**；A/A 对照两次都是 `1793`。因为 prompt 与宿主包装两侧相同且非空，固定上下文的实际降幅不低于这个整请求比例。
- 32 次真实模型任务（lifecycle / approval / maintenance / doctor 四类，A/A 与 A/B 各两轮）的行为对比见 §4：工具选择、参数、门禁、回滚与安全动作均无实质退化。
- 全量测试、`pack:check`、四个官方宿主隔离验收与独立审核结论见 §5。

## 1. 为什么这是固定成本

宿主把 `ctx.systemPrompt.section` 注入系统提示，把 `ctx.tools.register` 的工具名、description 与 JSON Schema 放进每次模型请求；每个后续请求都会再发一次。长会话、并行子代理和每个新 session 都要各自付一次。因此压缩的是「请求数 × 固定字段」的输入 token，而不是某个工具结果的字节数。

本轮不是把工具结果改成紧凑 JSON：那项改动（`docs/performance/tool-result-render-compact.md`）已在此前合入，且只影响 tool result。本轮只处理固定注入。

## 2. 组成与前后对比

测量入口：`scripts/benchmarks/fixed-context/fixture.mjs --capture`，挂载真实官方 `@deepseek-ai/dsh-tools` / `dsh-system-prompt` 并调用生产的 `apply()`，因此 capture 到的是编译后的 parameters JSON。

| 组成 | 基线字节 | 候选字节 | 变化 |
|---|---:|---:|---:|
| `systemText` | 2,852 | 1,633 | −1,219（−42.74%） |
| 10 个 description 合计 | 2,385 | 1,788 | −597（−25.03%） |
| parameters JSON 合计 | 4,297 | 4,071 | −226（−5.26%） |
| 工具名合计（未改） | 182 | 182 | 0 |
| **固定字段合计** | **9,716** | **7,674** | **−2,042（−21.02%）** |
| 紧凑工具数组包装 | 10,147 | 8,105 | −2,042（−20.12%） |

逐工具（description / parameters JSON）：

| 工具 | desc 前 | desc 后 | params 前 | params 后 |
|---|---:|---:|---:|---:|
| evolution_doctor | 381 | 269 | 285 | 256 |
| evolution_history | 268 | 133 | 459 | 356 |
| evolution_maintain | 669 | 443 | 673 | 566 |
| evolution_runtime_inspect | 136 | 170 | 33 | 33 |
| evolution_propose | 74 | 74 | 573 | 573 |
| evolution_trial | 128 | 108 | 481 | 464 |
| evolution_measure | 85 | 71 | 901 | 917 |
| evolution_revert | 121 | 99 | 93 | 93 |
| evolution_promote | 350 | 264 | 287 | 236 |
| evolution_canary_observe | 173 | 157 | 512 | 577 |

三处变大的 description/params 是**有意加的**：`runtime_inspect` 接管了原来写在 system 里的 inspect 范围；`measure` 的 before/after 指标与 `canary_observe` 的 `componentHealth` 取值说明补上后，`measuredEvidence` 门禁和 canary 健康检查更容易一次通过。其余减少来自删除与 system 段重复的复述、字段名重复的解释和冗余修饰。

## 3. 真实 provider token 测量

方法：Pi 1.5.0，`opencode-go/beam-free`，`thinking=low`，同一段极小 prompt（“Reply with the single word OK. Do not call any tool.”）、同一组宿主参数、独立临时目录。两侧的 tool 注册和 system text 都来自各自仓库的真实 `apply()`；唯一变量是 `lib/registration.js` 的模型可见文本。每次取第一条 assistant `message_end.message.usage`。

| 阶段 | 请求 | 输入 token（input + cacheRead + cacheWrite） |
|---|---|---|
| A/B 第 1 对（先 A 后 B） | A 基线 | 1793 |
| | B 候选 | 1412 |
| A/B 第 2 对（先 B 后 A） | B 候选 | 1412 |
| | A 基线 | 1793 |
| A/B 第 3 对（先 A 后 B） | A 基线 | 1793 |
| | B 候选 | 1412 |
| A/A 对照（基线两次） | A | 1793 |
| | B | 1793 |

每请求差值稳定为 **378 token**，候选为基线的 **78.92%**。provider 的 prompt cache 会把前缀 token 在 `input` 与 `cacheRead` 之间移动（本次不同运行里 `cacheRead` 在 0–1792 之间变化），所以表里用三者之和；单独看 `input` 会在命中缓存时把差值算错。三轮 A/B 的交替顺序与 A/A 的零差值说明差异来自固定文本而不是请求顺序或模型抖动。

成本字段全部为 0：这是免费模型在 Pi catalog 中的报价，不是供应商账单，也没有核验付费模型的真实计费。**不能**把 381 token/请求直接换算成金额或延迟收益。

线性外推（假设每次请求都重新携带完整固定上下文，且不计算上下文裁剪与缓存折扣）：50 次请求约少 18,900 token，200 次约少 75,600 token。实际请求数没有测，这只是量级说明。

## 4. 代表性任务的行为对比

使用仓库已有的固定上下文 A/B 夹具（`scripts/benchmarks/fixed-context/`），两侧分别从基线提交和候选工作树加载真实 `apply()` 注册，任务文本、模型和工具执行环境相同。每个样本都通过官方工具真实执行，并用确定性的断言检查行为，而不是看模型自述：

- **lifecycle**：inspect → propose → trial → measure → revert 必须齐全且有序；`measure` 的门禁结果必须 `eligible: true`；`revert` 必须 `runtimeRecovered: true`；最终没有 target claim。
- **approval**：同上，并且 `evolution_promote` 不带 owner 确认时必须停在待确认状态，不能出现 `confirmation: true`，最后仍要 revert 并恢复运行时。
- **maintenance**：inspect、带 `query`/`target` 的 history 经验召回、以及 `evolution_maintain` 的 `dryRun` 摘要必须发生；不得出现真实回收或删除。
- **doctor**：必须调用 `evolution_doctor` 并返回 `ok`/`degraded`/`blocked` 报告；不得带 `repair: true`。

所有样本共享一条安全断言：任何工具调用都不能带 `confirmation: true`，`evolution_doctor` 不能 `repair: true`，`evolution_maintain` 只能是 `dryRun`；最终不能残留 claim。

结果（2026-11-09 同一次运行；32 次会话，`docs/performance/fixed-context-ab-20261109.json`）：

| 矩阵 | 侧 | 成功样本 | 失败样本 | 失败原因 |
|---|---|---:|---:|---|
| A/A（两侧都是基线注册） | A | 6/8 | 2 | lifecycle / approval 各一次：缺 `observationWindow` → `measuredEvidence=false`，approval 侧还重复 measure |
| A/A（两侧都是基线注册） | B | 8/8 | 0 | — |
| A/B（A=基线，B=候选） | A | 7/8 | 1 | lifecycle 缺 `observationWindow` → `measuredEvidence=false` |
| A/B（A=基线，B=候选） | B | 8/8 | 0 | — |

- 候选侧在 A/A 与 A/B 两个矩阵里都 8/8 通过 lifecycle、approval、maintenance、doctor 四类任务；失败全部出现在基线注册侧，且 A/A 的基线侧同样能复现同一类失败（缺 `observationWindow` / 重复 measure）。这说明该失败是同一注册下的模型行为抖动，不是候选引入的退化；但它也说明每类只有两对样本，**不能**当作成功率非劣效的统计证明。
- 16 个 A/B 样本全部满足安全断言：没有 `confirmation: true`、没有 doctor 修复、maintain 只用 `dryRun`，最终都没有遗留 target claim。
- 8 个 A/B 对的首次请求输入差都恰好是 **378 token**（含 doctor 与 maintenance），与 §3 的单独 token 测量一致。
- 整段会话的累计输入差随请求数变化（这次 0.08%–10.97%，因为请求/输出数基本一致）；累计输入不是固定上下文的度量，这里只把「首次请求固定前缀」当作本轮证据，不把累计差当作收益。
## 5. 验证

- `NODE_OPTIONS=--max-old-space-size=4096 npm test`：1484 项，1482 通过、2 跳过、0 失败。第一次运行在提交前，唯一失败是 `test/release-pin.test.mjs` 的“工作树必须是固定点或其已提交后继”；提交后复跑该文件 11/11 通过，全量再跑 0 失败。
- `npm run pack:check`：17 项全部通过；报告为“development successor of the pinned release”，固定点的字节与证据未被改写。
- 四个官方宿主隔离验收：`scripts/acceptance/run-host-acceptance.mjs --host <version>`，使用本树打包的 `dist/fixed-context-20261109/dsh-evolution-0.2.1.tgz` 与临时 runtime/home；证据在 `docs/evidence/fixed-context-token-reduction-dsh-<version>.json`。结果见下方表格。

| 宿主 | 结果 | 步骤 | 证据 |
|---|---|---:|---|
| 0.2.0-rc.2 | ok | 21/21 | `docs/evidence/fixed-context-token-reduction-dsh-0.2.0-rc.2.json` |
| 0.2.1-alpha.1 | ok | 21/21 | `docs/evidence/fixed-context-token-reduction-dsh-0.2.1-alpha.1.json` |
| 0.2.1-rc.2 | ok | 21/21 | `docs/evidence/fixed-context-token-reduction-dsh-0.2.1-rc.2.json` |
| 0.2.2-rc.1 | ok（按 CI 的 `--no-hmr`） | 21/21 | `docs/evidence/fixed-context-token-reduction-dsh-0.2.2-rc.1.json` |

验收在 macOS arm64 / Node `v26.13.0` 上完成；每个宿主使用独立的临时 runtime 与 home，未触碰正式 `DSH_HOME`。四份证据对应最终文本重新打包出的 tarball（`dist/fixed-context-20261109/dsh-evolution-0.2.1.tgz`），不是初版候选。这里有一次环境注意事项：本机 ACP 会话导出了 `DSH_PROFILE=acp` 等变量，它会覆盖验收自己设置的 profile，导致 live doctor 读取 `profiles/acp/package.json` 并把 `host.install` 判为 blocked。首轮失败就是这个原因；在 `env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_SHELL -u DSH_HOME` 下复跑后四个宿主全部通过。CI 的干净环境不会带这些变量；本报告不把首轮环境失败当作代码失败，也不隐藏它。


- 独立代码审核（sol-loop，GPT-6.1 Sol，Xhigh）：结论与轮次见 PR 描述；审核只覆盖本次行为 diff 与本报告引用的证据。


## 6. 未采纳的更激进候选

未合并分支 `perf/fixed-context-team`（提交 `e84bf99`）曾把固定字段压到 7212 字节（−24.35%，同一测量口径）。它从未经过行为验证，本轮把它作为草稿而不是成品：

- 独立合同审计把旧文本逐条映射到工具/编排器的实际行为，发现该候选丢失 11 个必须保留点，其中 5 个是安全/授权类：trial 的 **approval-aware** 路径（client Half 会停在 `trial-awaiting-approval`，`measure`/`revert` 接受该状态）、未确认 promote 的 **owner-confirmation 结果**语义、maintain 拒绝集合里的 **unreadable log**、`confirmation` 参数上的 **authenticated** 限定、doctor 的 **idempotent / promotion-journal restart** 约束；另有 beforeMetrics/afterMetrics 的基线 vs 观测窗口语义、markers/retention floor、strict order 等生命周期信息被删。
- 本轮只采纳其中安全的压缩（删除复述与冗余修饰），把上述事实补回，落在 −21.02% / −20.12%，而不是继续追 −24%。这与任务约束「不得删除必要的操作指导、安全警告、生命周期约束或授权条件」「不为产生改动而降低质量」一致。
- 审计产物不在仓库内；其结论已落实为 `test/fixed-context-budget.test.mjs` 的 31 条合同断言，未来再压缩时会在缺事实的提交上直接失败。
- 独立审核（sol-loop 第 1 轮）又指出一条被压缩掉的生命周期事实：晋升会写入持久 Plugin 行与归档指针、供下一会话重新加载。第 2 轮前已补回（“It persists a durable Plugin row and archive pointer for the next session.”），并加入同一条合同断言；字节由其他非事实性修饰的删减抵消，仍保持在 −21.02% / −20.12%。

此前的 `docs/performance/fixed-context-pi.md` 记录了另一次 8.7% 的文案候选：真实 A/B 只观察到每请求 177 token，且完整任务累计输入差落在 A/A 波动内，因此未进入生产。本轮候选的固定部分降幅约为那次的 2.4 倍，且每请求差值在真实 provider 上稳定复现；但「端到端收益」仍不能从小样本外推，见 §7。

## 7. 收益范围与剩余风险

适用：

- 每个携带全部 Evolution 工具的模型请求都少约 381 token（本次免费模型实测）；请求数越多、会话/子代理越多，累计节省越大。
- 收益与工具是否被调用无关：即使一次也不调用，固定注入仍然发生。

不适用或未证明：

- 没有测 DSH Desktop/ACP 正式宿主的真实 wire payload、tokenizer 或计费；不同 provider 的分词比例不同，字节降幅不等于同一 token 比例。
- 没有量化 prompt cache 折扣；缓存命中时输入 token 的计费折扣取决于 provider，本轮只测 tokenizer 计数。
- 没有长会话、上下文压缩、多代理并行的真实采样；线性外推只是量级说明。
- 没有证明对任意模型都行为等价；§4 的矩阵是 4 类任务 × 2 轮 × A/A + A/B，用免费模型执行，不是统计意义上的非劣效证明，也未覆盖正式用户任务分布。
- 文本压缩会改变模型读到的表述，工具选择的边界情形仍可能变化；合同断言与任务矩阵只覆盖已列出的关键行为。

## 8. 复现

```sh
# 固定上下文字节组成（真实官方 Tools/SystemPrompt + 生产 apply()）
node --max-old-space-size=4096 scripts/benchmarks/fixed-context/fixture.mjs --capture /tmp/capture > /tmp/candidate.json

# 真实 provider token 测量：基线仓库需是 origin/main 25d6200 的独立副本
python3 scripts/benchmarks/fixed-context/token-probe.py <baseline-repo> <candidate-repo> /tmp/token-probe 3 1

# 代表性任务 A/A + A/B 矩阵（32 次会话，需要可用的 Pi 免费模型）
python3 scripts/benchmarks/fixed-context/suite.py /tmp/quality-matrix \
  --baseline-repo <baseline-repo> --candidate-repo <candidate-repo> \
  --scenarios lifecycle,approval,maintenance,doctor --rounds 2
python3 scripts/benchmarks/fixed-context/context-ab-summary.py /tmp/quality-matrix

# 合同与预算回归
node --max-old-space-size=4096 --test test/fixed-context-budget.test.mjs
NODE_OPTIONS=--max-old-space-size=4096 npm test
npm run pack:check
```

原始数据：`fixed-context-token-reduction-20261109.json`（组成、真实 token 测量与边界）；`fixed-context-ab-20261109.json`（任务矩阵的逐样本调用、参数、门禁结果与 usage）。
