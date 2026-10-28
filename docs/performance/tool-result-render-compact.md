# 工具结果渲染：紧凑投影替代 2 空格缩进

本轮只改一处输出边界：`lib/registration.js` 的 `output.render` 从
`JSON.stringify(value, null, 2)` 改为 `JSON.stringify(value)`。这是**表示层改动**——同一个
JSON 文档，键、键序、值、字符串内部的空白与换行都不变，去掉的只是 token 之间的缩进；
`JSON.parse` 两种文本得到深相等的值。没有改工具名、工具数量、参数 schema、systemPrompt、
门禁、持久化、认证、事务、滚回或宿主范围。

理由是这个文本的去向。它**不是**只进模型：宿主保留结构化 `value` 给自身消费方，同时把
render 生成的文本写进会话的 `tool/result` 记录，从那里进入 UI 展示、可选 hook（如
`PostToolUse.tool_response`）以及模型的**每一个后续请求**。已读到的这条链上没有按缩进解析
该文本的逻辑，所以原先的两空格投影花的是「留在会话里的结果 × 后续请求数」的输入 token，
换来没有消费方读取的空白；代价接受范围是**人类在工具结果视图里看到的是单行 JSON**。

原始数据：[`tool-result-render-compact.json`](tool-result-render-compact.json)；脚本
[`scripts/benchmarks/tool-result-render-compact.mjs`](../../scripts/benchmarks/tool-result-render-compact.mjs)。

## 1. 方法与等价性边界

- 被测提交：基线 `5a728dd`（`git archive` 到 `/tmp` 的独立树），候选是本轮工作树的 `lib/`。
  两侧 `lib/registration.js` 的 SHA-256 见 JSON 的 `identity`。
- 两侧各起独立进程、各自跑同一套场景，逐轮交替先后顺序，共 3 轮。每侧都走真实
  `apply()` 注册路径，领域工具用真实官方 `@deepseek-ai/dsh-storage-domain` +
  `JsonStorageBackend`（`test/retention-boundary-worker.mjs` 的 `openFixture`），数据根在
  `/tmp`；`evolution_propose` → `evolution_trial` → `evolution_measure` → `evolution_revert`
  用 `test/trial-recovery-boundary.test.mjs` 同款假 runner，不执行任何动态宿主代码，不触碰
  正式 DSH、正式 home 或发布产物。
- **等价性在进程内对真实返回值判定**：对每个样本断言
  `JSON.stringify(JSON.parse(render文本)) === JSON.stringify(JSON.parse(JSON.stringify(value, null, 2)))`。
  跨进程只做一致性与结构交叉检查，因为 `propose` 会生成随机 experimentId、诊断报告带时间戳
  且内容取决于被诊断的树。
- 两侧只有一处功能差异，由父进程直接加载两侧模块并渲染同一个探针值证明（`onlyDiff`）：
  基线是 `JSON.stringify(value, null, 2)`、候选是 `JSON.stringify(value)`，探针依次含嵌套
  数组/对象、字符串内换行、自有 `__proto__`；两侧各注册 8 个工具（无领域存储时
  `evolution_history` / `evolution_maintain` 不注册），每次注册都共用同一个 renderer，探针
  解析深相等。
- **归因是受控的**：每个样本的两种投影都取自**同一个进程里同一个返回值**，所以字节差不会
  把两份不同的载荷相减；每侧还必须在它的每个真实返回值上渲染出自己声称的那一种投影。
  `crossSideSavingsAgree` 只表示另一侧的载荷结构碰巧相同，可作一致性交叉检查。
- 环境：Node `v26.12.1` / `darwin/arm64`，8 逻辑 CPU；采集开始/结束 load average
  `1.53 / 1.90 / 2.13` → `1.40 / 1.87 / 2.12`。每样本 200 次渲染取中位数；本轮没有并行跑
  测试、基准或验收。这些是采集时的观测，不是从 JSON 可以复核的条件。

## 2. 实测

`indented` 是 `JSON.stringify(value, null, 2)`，`compact` 是 `JSON.stringify(value)`；两者是
**同一个真实返回值**的两种投影。字节为 UTF-8 实测；渲染耗时是单个 `render()` 调用的中位数，
只衡量投影本身。

| 场景 | indented 字节 | compact 字节 | 节省 | 降幅 | 渲染 indented → compact |
| --- | ---: | ---: | ---: | ---: | --- |
| `inspect`（0 候选） | 1,089 | 751 | 338 | 31.04% | 1.67 → 0.75 µs |
| `inspect`（10 候选） | 8,813 | 4,739 | 4,074 | 46.23% | 11.50 → 3.88 µs |
| `inspect`（100 候选） | 36,803 | 22,019 | 14,784 | 40.17% | 45.21 → 16.54 µs |
| `history`（默认，无记录） | 129 | 112 | 17 | 13.18% | 0.25 → 0.17 µs |
| `history`（12 条已重放事件） | 129 | 112 | 17 | 13.18% | 0.29 → 0.17 µs |
| `history`（observations，10 条元数据） | 1,978 | 1,538 | 440 | 22.24% | 2.67 → 0.92 µs |
| `history`（query，有召回） | 3,788 | 2,885 | 903 | 23.84% | 5.58 → 5.63 µs |
| `doctor`（空 home） | 22,686 | 16,694 | 5,992 | 26.41% | 30.88 → 25.79 µs |
| `propose` | 4,816 | 3,431 | 1,385 | 28.76% | 6.29 → 6.17 µs |
| `measure` | 1,427 | 1,052 | 375 | 26.28% | 2.00 → 0.71 µs |
| `measure`（字符串化 JSON 证据 + 换行） | 1,942 | 1,567 | 375 | 19.31% | 2.63 → 1.58 µs |
| `revert` | 850 | 635 | 215 | 25.29% | 1.21 → 0.54 µs |

三轮的降幅完全一致（JSON 的 `rounds` 里逐样本给出），因为缩进量与载荷结构成正比、
与随机 id 无关。11 个样本的 `crossSideSavingsAgree` 为 true，即两侧各自的受控字节差相等。

`doctor` 的 `sameKeyStructure` 与 `crossSideSavingsAgree` 都是 false：诊断报告的内容取决于
被诊断的树与环境（两个不同的临时 home、以及基线树只归档了 `lib` 与 `package.json`，缺少
doctor 会检查的 `scripts/doctor.mjs`、`cordis.patch.yml`），两侧的载荷本来就不是同一份文档。
因此上表 `doctor` 一行**只读候选自己的受控比较**（同一份报告，两种投影，22,686 → 16,694），
不能与基线的载荷相减。两侧 render 差异由 `onlyDiff` 的探针证明只有那一行。

渲染耗时不是本轮的判据（微秒级，且本轮机器负载不为零）：12 个场景里 11 个更快，
`history-query` 反而慢 0.05 µs（5.58 → 5.63）。这里只报告观测值，不主张任意场景都不变慢。

## 3. 上下文模型（推算，非实测）

工具结果留在上下文里，被后续每个请求重传。下表假设该结果在此后 N 个请求中一直保留，
不包含上下文裁剪、provider 缓存或真实请求次数——**这些都没有测**。

| 条件 | 每请求节省 | 累计节省 | token（字节÷3.6 估算） |
| --- | ---: | ---: | ---: |
| `inspect`(10 候选) 保留 50 个请求 | 4,074 B | 203,700 B | 56,583 |
| `inspect`(100 候选) 保留 50 个请求 | 14,784 B | 739,200 B | 205,333 |
| `inspect`(10) + `propose` + `measure` 保留 50 个请求 | 5,834 B | 291,700 B | 81,028 |
| 同上，保留 200 个请求 | 5,834 B | 1,166,800 B | 324,111 |

token 数是字节÷3.6 的估算，不是 tokenizer 计数、不是供应商计费口径，也没有测延迟收益。

## 4. 未改动、未测量与剩余风险

- **每请求固定注入没有变化。** 本轮同一份审计实测：`systemText` 2,852 字节，10 个工具的
  name/description/parameters 共 6,864 字节，字段合计 9,716 字节/请求（估算约 2.7k token）。
  这部分只能靠删减说明文案降低，那会改变对 Agent 的行为指导，不是表示层等价改写，本轮不做；
  详细字节见 [`axis-token-audit.md`](axis-token-audit.md)。
- **未做 tokenizer 或真实 provider 测量**，也没有真实会话的上下文保留记录。第 3 节是模型。
- **文本的其他消费方已定位，但没有逐一做行为验证。** 已读到的路径：
  `@deepseek-ai/dsh-tools` 的 `createSuccessResult` 先快照/校验/冻结结构化 `value` 再调用
  `output.render`，不使用缩进；`dsh-agent-loop` 把 `result.content` 写进会话 `tool/result`
  事件；`dsh-client-ui-tool` 把该文本原样用于工具结果展示；`dsh-hooks-claude-code` 把它作为
  `PostToolUse.tool_response` 交给 hook。这三处都会看到「多行变单行」，都没有按缩进解析。
  仓库内没有依赖该缩进的逻辑。依赖**逐字**快照、行号或 Markdown 展示的外部消费者仍会观察到
  变化；数据层面等价由测试与基准断言，**模型读到紧凑 JSON 后是否更易误读未做测量**——
  可预见的失败模式是大型 `inspect` 里多层重复的 `status` / `runtimeRecovered` 被混淆，
  从而多一次会被门禁拒绝的 `promote`；门禁仍会拒绝错误晋升。
- 未改 `scripts/doctor.mjs` 的 `--json` 报告（仍是 `null, 2`），那是 CLI 的 stdout，不是模型
  上下文。
- 本轮没有实现、也没有重新测量已撤回的方向（`digestApplied` 缓存族、`READ_CHUNK_BYTES`、
  事件桥读路径缓存、事务保存投影）。稳态 `flush()` 的 O(历史) 成本与 floor 路径重复认证的
  调查见 [`axis-steady-history.md`](axis-steady-history.md)。

## 5. 回归覆盖

新增 `test/tool-result-render-compact.test.mjs`（5 项）：紧凑文本 == `JSON.stringify(value)`、
与缩进文本解析深相等、记录内不引入换行、全部已注册工具共用一个 renderer 且 schema 仍为
`{}`、字符串内换行与字符串化 JSON 保持原样、自有 `__proto__` 键仍是自有数据属性且不会
成为输出对象的原型、每个结构化载荷都更小。

本轮实际执行：Node `v22.23.4` / `v24.22.1` / `v26.12.1` 各自
`NODE_OPTIONS=--max-old-space-size=4096 npm test` 全量 **1223/1223 通过、0 失败**；
`npm run pack:check`（开发模式）16 项全部通过，报告本树是固定点的开发后继；
三个官方宿主 `0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-rc.2` 各 21/21 步通过，证据为
`docs/evidence/tool-result-render-compact-dsh-<host>.json`（包内容摘要
`3754a8a1e87bfd9957a2274992bafa81f0e748f32154248dd615807c345cca7e`）。这些验收使用
`/tmp` 下新建的隔离 runtime 与 home，不触碰正式 `DSH_HOME`，也不改写 `release/` 固定产物。

## 复现

```sh
node --max-old-space-size=4096 scripts/benchmarks/tool-result-render-compact.mjs \
  --baseline 5a728dd --rounds 3 --samples 200 \
  --out docs/performance/tool-result-render-compact.json
```

输出路径必须写在自己指定的位置；脚本会覆盖同名文件。两侧树在 `/tmp` 下构建并在结束时清理，
不读写正式数据。
