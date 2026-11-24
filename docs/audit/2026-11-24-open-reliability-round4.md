# 开放式全链路可靠性研究（第四轮，2026-11-24）

基线：`511ca77`（PR #92 merge 后的 `origin/main`）。本轮先按所有者明确授权合并 PR #92，再从更新后的 main 建立 `t3/open-research-round4` 分支开展研究。本文只记录本轮实际读取、复现、修改与执行的检查。

## 1. 范围与方法

8 个并行只读子代理覆盖完整闭环：启动/每实验 Canary、持久结论作用域与合并、异常/取消归因、Trial/收益、跨入口复用、长期状态与恢复、发现/规划/自主观察者、诊断与真实宿主。每个方向要求当前源码的 file:line、真实调用链、可运行复现和严重度，并显式排除前三轮已修复项。主代理对每条进入修复的发现独立复核，按「先让新用例在旧源码上失败、再让其在修复后通过」取证。所有复现只使用系统临时目录与临时 SQLite，未触碰正式 DSH_HOME、正式经验库或已安装插件，未发布版本。

## 2. 确认并修复的系统性根因

| # | 根因 | 影响 | 修复 |
| --- | --- | --- | --- |
| 1 | Canary 状态机把验证建模为「匿名计数 + `startupVerified` 布尔 + 不透明 evidence 袋」，没有每实验的功能验证义务；启动健康观测可作为第 2 条观测凑满窗口 | 被打断的 context-policy 任务在重启后由纯健康观测提交 stable、删除 journal、写 `benefit` 结论，等价于绕过 context-policy 的「安装≠生效」复验 | promote 时可选写入 `canary.verification` 义务（绑定摘要 + 必需功能观测数 + 观测窗口下限）；`observeCanaryJournal` 只认绑定一致且 `matched:true` 的 `verificationKind:'functional'` 观测；功能检查不匹配直接走 canary 回归；旧 journal 行为逐字节不变 |
| 2 | 每实验 canary 请求（1..5）被 Desktop host 忽略，内核窗口始终是进程级默认 2；测试固化了这一行为 | owner 要求的复验轮数被静默丢弃 | `evolution_promote` 接受 `canaryVerification.observations`，内核用 `max(默认窗口, 请求值)` 取窗口，**只允许收紧不允许放宽** |
| 3 | 重启后只把任务标为 `interrupted`，无人重放 functionalCheck；仅禁止启动观测会留下永久 canary 占位 | 候选挂载在 canary-observing 且无合法推进/回滚路径 | 任务状态保存计划的功能检查与内核绑定摘要；`recoverPreviousTasks` 对带义务的 canary 任务重放只读 functionalCheck 并提交带绑定的功能观测；失败仍保留现场 |
| 4 | canonical 合并让最新中性结论覆盖 `lastStatus`，而所有消费者把 `lastStatus` 当权威且不可逆的判定 | 实测 `no-benefit` / task 回归被 `insufficient-evidence` / `reverted-unconfirmed` 抹掉，已证伪策略在门禁与规划中重新变成新假设 | 读侧从不可变计数/REGRESSED 状态恢复否定 verdict（`findConclusions` 与 `knowledgeExperienceRecord` 共用同一纯函数）；写侧 `publishConclusion` 在中性结论会覆盖同身份否定结论时跳过写入；`adopted` 的正当降格不受影响 |
| 5 | 失败记忆投影把 `patternKey`（sha256 遥测哈希）当问题 scope | `evolution_plan` 输出 64 位十六进制伪候选，挤占真实问题；统一审查动作携带无意义目标 | 优先用声明的 `experiment.target`，只有可读的旧 pattern key 才回退；内容身份里对 scope 做 canonical 归一化使 raw/canonical 拼写合并 |
| 6 | `normalizeText` 把 `not found` 折叠成 `missing`，但 `failureOrigin()` 的 capability-gap 表未同步，`E_TOOL_NOT_FOUND` 落入宽泛的 `missing` → caller-input | 真实工具能力缺口被静默过滤，无法进入候选 | capability-gap 分支加入折叠后的 `tool/capability/plugin missing` 等形状；`edit missing` 仍是 caller-input |
| 7 | 官方宿主在 abort/error 轮不发 `agent/turn-stopping`，collector 的 pending 退化被后一轮无关成功结算为「已恢复」 | 伪造恢复工具与恢复成本，误导 owner 把真实模型会话消耗在不存在的恢复路径上 | `agent/error` 监听先 flush 该 agent 的 pending 退化（记录为未恢复）再写 agent 失败 |
| 8 | 退化事件 id 在 callId 存在时缺 per-exec 随机量，同 callId 的多个真实执行冲突后静默丢失 | 三次真实退化只落一条，恢复观测全丢，规划输入偏斜 | 与失败路径对称，无条件追加 `randomUUID()` |
| 9 | 取消的 `tools/result` 被写成持久失败事实，3 次即形成 `origin:environment` 幽灵候选；内核明确排除被取消的运行 | 取消噪声进入失败分母并制造候选 | 以 `exec.signal.aborted` 为主、`ABORTED`/`ABORTED_BEFORE_DISPATCH` 为辅，跳过采集与结算 |
| 10 | 重验证采纳后，`profileVerdict` 用 consumer 上次启动的 host 判断兼容性，把已过期的 `pending-revalidation` 判成再次重验证；混合 profile 的聚合动作又丢掉逐 profile 的后续动作 | runner 说「nothing to revalidate」而审查要求重验证，操作闭环空转；一个 profile 需要修源码时另一个 profile 的重启需求被吞掉 | 用 live review host 判断记录是否兼容：兼容时把过期行归为 `stale-revalidation` → restart；聚合动作不是 restart/revalidate 时仍输出逐 profile 的 restart，pending-revalidation 行仍输出绑定 consumerHosts 的重验证指令 |
| 11 | `run-revalidation` 只在目标筛选阶段处理全撤销，验证预期/证据组装/采纳后复验仍要求被撤销 profile 变成 active | 任一 profile 被 operator 撤销即卡死整条受支持的重验证采纳链 | 抽出 `profileIsRevalidationTarget`，三处统一跳过已撤销 profile |

### 独立反方复审（sol-loop 第 1 轮）

GPT-6.2 Sol（High）返回 `CHANGES`：4 blocker、6 should。逐条复核后全部按最小改动修复：

| id | 结论 | 处理 |
| --- | --- | --- |
| S1 blocker | 接受：重启重放创建新 Agent id，内核会把 canary 观测判给不同所有者（假内核跳过了这项校验） | 用原任务 session id 恢复同一所有者身份，并新增断言钉住 |
| S2 blocker | 接受：义务在 promote 后才写任务状态，崩溃窗口会留下无法重放的 canary | 在内核写入前持久化只读检查描述符与绑定；`promoting` 阶段也参与恢复重放；内核无 journal 时自然拒绝并回退 interrupted |
| S3 blocker | 接受：重放中的功能失败本地退出，候选继续挂载 | 失败经 `evolution_canary_observe` 的回归分支提交，由内核回滚后再结束任务 |
| S4 blocker | 接受：`context-policy` 实验缺义务仍可晋升，健康观测即可提交 stable | 内核在任何持久化前要求有效的 canaryVerification；工具型与历史实验保持原语义 |
| S5 should | 接受：工具型任务不传观测数，请求 5 次仍在 2 次提交 | 新增独立 `canaryWindow` 参数，内核取请求值与默认值较大者 |
| S6 should | 接受：重放直接用缓存摘要，且摘要经有损投影 | 抽出共享纯模块 `canary-verification.js`，重放前重新校验工具白名单/形状并无损重算绑定，与内核一致 |
| S7 should | 接受：`no-benefit → adopted → insufficient-evidence` 被计数恢复成 no-benefit，错误封杀已采纳策略 | 只有 canonical state 非 KNOWN 且末次结果非 success 时才恢复否定 verdict |
| S8 should | 接受：live host 兼容会掩盖已读当前索引但仍在旧宿主上的 consumer | 仅当 consumer 尚未观察到当前索引（重启会重新评估）时判 stale；否则保留按 profile 的 host-bound 重验证 |
| S9 should | 接受：官方取消分支不发 `agent/error`，只发带 aborted signal 的 tool result | 在 aborted 结果到达时按官方语义 flush 该 agent 的 pending 退化 |
| S10 should | 接受：规划器按原始 scope 分组，`tool:read` 与 `tool read` 产生两个候选 | 分组键统一 canonical 化，并补混合来源回归；同步更新既有断言 |

## 3. 验证

- 反证：新增 4 个回归文件与 2 个扩展文件；对每条核心修复先在旧源码上运行新用例：
  - 结论/规划：`review-fix-round4-conclusions.test.mjs` 5 项中 4 项在旧源码失败（对照组通过）；
  - 归因：`review-fix-round4-attribution.test.mjs` 3/3 在旧源码失败；
  - Canary：`review-fix-round4-canary-obligation.test.mjs` 2/3 在旧源码失败（兼容性对照组通过）；
  - 重启重放：新增 host 用例验证重启后实际重放只读检查、发送带绑定的功能观测并采纳 stable。
- 聚焦检查：`experience-*`、`shared-experience-conclusion`、`self-evolution-review`（43/43）、`revalidation-runner`（11/11）、`desktop-task-*`、`orchestrator-integrity-canary-*`、`promotion-*` 全部通过。
- 全量：`NODE_OPTIONS=--max-old-space-size=4096 npm test` —— 结果见提交后的日志与最终报告；始终使用 4096 MB 堆上限，未使用临时 Node 发行版。
- 打包：`npm run pack:check` —— 提交后重跑（提交前 `test/release-pin.test.mjs` 按既定语义会因未提交分发改动失败）。
- 真实宿主验收：见最终报告，使用隔离 runtime/home，不触碰正式 DSH_HOME。

## 4. 调查后决定不修改的项（根因/影响/未修原因）

- `measured` 门禁拒绝后的「修正测量」注释承诺了不存在的 API：只能 `revert` 重跑。修复需新增中间态并定义跨会话结论覆盖语义，本轮选择只记录为已知契约缺口，不放宽门禁也不新增晋升路径。
- PTC 重验证 harness 用宽松正则判定拒绝并直调 registry definition，而证据声称「经官方执行器调用」；生产插件路径不受影响，属于验收证据保真度，修复需统一 harness 与生产的传输协议，留待真实 Desktop 取证。
- `reclaim()` 的 `prefixEvidence()` 整份解码日志前缀，峰值内存随日志线性放大；修复需把行扫描改成有界字节块并补 A/B 数据与性能文档，按项目性能改动纪律另立研究。
- `recall()` 的 SQL 读取上限硬编码 2000（输出仍受调用方上限约束）、`autonomousCleanupOccupant()` 尾部死代码、未分类的可选宿主接口、陈旧文档：低收益或纯可观测性，不为产生改动而修改。
- `capability-usage` 的 callId 重用归因：逻辑错误确凿但生产触发条件未取证，作为加固项登记。
- 上一轮已登记的 journal 分类、claim 回收、retention floor、append lock、schema v1→v2 迁移、`__proto__` 投影、脱敏线性扫描、8 项门禁与 confirmation：本轮复核未发现新问题。

## 5. 边界

本轮未发布版本、未安装或重启正式 DSH、未执行 `revalidate --apply`、未读写正式 DSH_HOME 或正式经验库；所有修改只改变证据保真度、闭环一致性与恢复能力，不放宽授权或晋升门禁，不新建第二套运行时，不改变已有持久化格式。
