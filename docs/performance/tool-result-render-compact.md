# 工具结果渲染：紧凑投影替代 2 空格缩进

本轮只改一处输出边界：`lib/registration.js` 的 `output.render` 从
`JSON.stringify(value, null, 2)` 改为 `JSON.stringify(value)`。这是**表示层改动**——同一个
JSON 文档，键、键序、值、字符串内部的空白与换行都不变，去掉的只是 token 之间的缩进；
`JSON.parse` 两种文本得到深相等的值。没有改工具名、工具数量、参数 schema、systemPrompt、
门禁、持久化、认证、事务、滚回或宿主范围。

理由是这个文本的去向：宿主保留结构化 `value` 给自身消费方，把 render 生成的文本交给模型，
而模型在本次会话的**每一个后续请求**里都会重读它。原先的缩进因此按「留在上下文里的结果 ×
后续请求数」计费，而没有任何消费方读取这些空白。

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
  跨进程只比字节与结构，因为 `propose` 会生成随机 experimentId、诊断报告带时间戳。
- 两侧只有一处功能差异，由父进程直接加载两侧模块并渲染同一个探针值证明（`onlyDiff`）：
  基线是 `JSON.stringify(value, null, 2)`、候选是 `JSON.stringify(value)`，探针依次含嵌套
  数组/对象、字符串内换行、自有 `__proto__`；两侧各注册 8 个工具（无领域存储时
  `evolution_history` / `evolution_maintain` 不注册），每次注册都共用同一个 renderer，探针
  解析深相等。
- 环境：Node `v26.12.1` / `darwin/arm64`，8 逻辑 CPU；采集开始/结束 load average 均为
  `1.51 / 1.67 / 1.65`。每样本 200 次渲染取中位数；本轮没有并行跑测试、基准或验收。

## 2. 实测

`indented` 是基线（`null, 2`），`compact` 是候选；两者是同一批真实返回值的两种投影。
字节为 UTF-8 实测；渲染耗时是单个 `render()` 调用的中位数，只衡量投影本身。

| 场景 | indented 字节 | compact 字节 | 节省 | 降幅 | 渲染 indented → compact |
| --- | ---: | ---: | ---: | ---: | --- |
| `inspect`（0 候选） | 1,089 | 751 | 338 | 31.04% | 1.71 → 0.75 µs |
| `inspect`（10 候选） | 8,813 | 4,739 | 4,074 | 46.23% | 11.88 → 3.88 µs |
| `inspect`（100 候选） | 36,803 | 22,019 | 14,784 | 40.17% | 45.33 → 16.46 µs |
| `history`（默认，无记录） | 129 | 112 | 17 | 13.18% | 0.25 → 0.17 µs |
| `history`（12 条已重放事件） | 129 | 112 | 17 | 13.18% | 0.29 → 0.17 µs |
| `history`（observations，10 条元数据） | 1,978 | 1,538 | 440 | 22.24% | 2.83 → 0.92 µs |
| `history`（query，有召回） | 3,788 | 2,885 | 903 | 23.84% | 5.83 → 5.58 µs |
| `doctor`（空 home） | 23,181 | 16,694 | 6,487 | 27.98% | 30.92 → 25.79 µs |
| `propose` | 4,816 | 3,431 | 1,385 | 28.76% | 6.50 → 6.38 µs |
| `measure` | 1,427 | 1,052 | 375 | 26.28% | 2.08 → 0.71 µs |
| `measure`（字符串化 JSON 证据 + 换行） | 1,942 | 1,567 | 375 | 19.31% | 2.67 → 1.58 µs |
| `revert` | 850 | 635 | 215 | 25.29% | 1.21 → 1.50 µs |

三轮的降幅完全一致（JSON 的 `rounds` 里逐样本给出），因为缩进量与载荷结构成正比、
与随机 id 无关。`doctor` 的键结构在两侧不同（`sameKeyStructure: false`）：诊断报告的内容
取决于环境（两个不同的临时 home 会得出不同的检查集合），这不是渲染差异——两侧的
`register` 差异由 `onlyDiff` 证明只有那一行。

渲染耗时不是本轮的判据（微秒级），只说明紧凑投影不更慢：12 个场景里 10 个更快，
`revert` 与 `history-query` 的差异在微秒噪声内，不作为收益主张。

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
- **外部文本消费方未逐一验证。** 本机已读的宿主路径
  （`node_modules/@deepseek-ai/dsh-tools/lib/index.js` 的 `createSuccessResult`）先快照/校验/
  冻结结构化 `value`，再调用 `output.render`，没有按缩进解析返回文本；仓库内也没有依赖该
  缩进的消费逻辑。依赖逐字快照、行号或 Markdown 展示的外部消费者仍可能观察到变化。
  数据层面等价已由测试与基准断言。
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

三版本全量测试、`pack:check` 与三宿主验收的实际执行结果记录在提交说明与
`docs/evidence/` 中；本文不预写未执行的结果。

## 复现

```sh
node --max-old-space-size=4096 scripts/benchmarks/tool-result-render-compact.mjs \
  --baseline 5a728dd --rounds 3 --samples 200 \
  --out docs/performance/tool-result-render-compact.json
```

输出路径必须写在自己指定的位置；脚本会覆盖同名文件。两侧树在 `/tmp` 下构建并在结束时清理，
不读写正式数据。
