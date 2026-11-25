# R13 完整进化闭环的插件侧耗时构成

受理标识：**DSH-EVOLUTION-PERF-R13-01**。子系统：完整进化链路
（`plan → propose → probe baseline → trial → probe candidate → measure → promote → revert`）的
**插件侧耗时构成**，以及历史规模对每一阶段的影响。

本文是测量研究，不改生产代码（结论 NO CHANGE，理由见 §5）。它回答任务里
"重复计算、重复验证、等待、序列化与深拷贝各占多少"这一问题，并把固定开销、
有界增长与无界增长分开量化。

## 0. 口径：测到了什么，没测到什么

| 项 | 是否测量 | 说明 |
| --- | --- | --- |
| 插件 CPU | **是** | `lib/orchestrator.js`、`lib/shared-experience.js`、`lib/dockyard-domain/knowledge.js` 与归档写入，`process.cpuUsage()` user+system |
| 宿主开销 | 否 | `ctx.tools.execute` 与 `dynamicCordisRunner` 是仓库测试用的 fake pipeline；真实宿主的工具执行、Include 挂载不在样本内 |
| 模型推理 / 等待 | 否 | 没有模型、没有网络、没有 API Key；`probe` 的样本由 fake 管道即时返回，因此"模型等待"在本表里恒为 0，不能当作真实会话的比例 |
| 开发 harness | 仅记录 | 夹具种子写入、`mkdtemp`、模块导入全部在计时窗口之外；每个样本起独立进程 |

所以这里的百分比是**插件在闭环里自己花的 CPU 如何分配**，不是真实会话墙钟构成。
真实会话里模型推理通常远大于本文任何一项；本表只用于判断"插件侧还有没有可消除的重复工作"。

## 1. 方法

- 脚本：[scripts/benchmarks/r13-loop-composition.mjs](../../scripts/benchmarks/r13-loop-composition.mjs)。
- 驱动真实的 `EvolutionOrchestrator` 控制流：`plan` → `propose` → `probe(baseline)` →
  `trial` → `probe(candidate)` → `measure` → `promote`（不带 `confirmation`，停在
  `awaiting-owner-confirmation`）→ `revert`。fake 工具管道与 fake runner 复用
  `test/orchestrator-durability-fixtures.mjs` 的既有形状，不引入第二套运行时。
- 每个样本一个全新 `mkdtemp` 根与一份新的共享经验库；`--history N` 在**不属于当前 target**
  的其他问题上预置 N 条结论，使读路径看到的是增长后的表，而当前 target 仍是未知的。
- 每个阶段用 `process.cpuUsage()` 差值计时，同时记录墙钟；`--no-instrument` 关闭
  `structuredClone` / `JSON.stringify` / `JSON.parse` 的包装（阶段数据用这一档），
  另跑一档带包装的副本来归因复制/序列化（§4）。
- scale：`--history 0 / 200 / 2000 / 5000`，分别 7 / 7 / 5 / 5 个样本，取中位数。
- 环境：Node `v26.13.1`、`darwin/arm64`、8 逻辑 CPU、16 GiB；测量时机器无其它基准/测试进程。
- 全部夹具在临时目录，未触碰正式 `DSH_HOME`、正式经验库、`event-bridge.key` 或用户数据。

## 2. 阶段构成

每格是样本中位数的 CPU ms；百分比是该阶段占整次闭环的比例。

| 历史结论数 | 闭环总计 | plan | propose | probe baseline | trial | probe candidate | measure | promote（待确认） | revert |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 4.54 ms | 0.51 (11.2%) | 0.46 (10.2%) | 0.27 (6.0%) | 0.56 (12.4%) | 0.16 (3.6%) | 0.14 (3.2%) | 0.02 (0.5%) | 2.57 (56.6%) |
| 200 | 15.23 ms | 7.77 (51.0%) | 3.69 (24.2%) | 0.27 (1.7%) | 0.66 (4.3%) | 0.16 (1.1%) | 0.12 (0.8%) | 0.02 (0.2%) | 2.81 (18.5%) |
| 2,000 | 83.37 ms | 38.48 (46.2%) | 28.00 (33.6%) | 0.40 (0.5%) | 1.12 (1.3%) | 0.16 (0.2%) | 0.29 (0.3%) | 0.03 (0.0%) | 11.81 (14.2%) |
| 5,000 | 95.91 ms | 35.64 (37.2%) | 39.97 (41.7%) | 0.41 (0.4%) | 1.23 (1.3%) | 0.18 (0.2%) | 0.22 (0.2%) | 0.03 (0.0%) | 20.24 (21.1%) |

**固定开销**：`probe`（两侧合计约 0.2–0.6 ms）、`trial`（0.6–1.2 ms）、
`measure`（0.1–0.3 ms）、`promote` 的只读门禁（0.03 ms）不随历史变化。
`revert` 里约 2.5 ms（历史为 0 时）到约 4 ms 的归档渲染 + 事件桥写入 + fsync 也是固定成本：
从 5,000 档的 `revert` 减去它自己的两次存储调用后余约 3.6 ms。

**有界增长**：`plan` 在 2,000 → 5,000 行时从 38.48 降到 35.64 ms（在噪声内、没有继续增长），
因为它的两个读窗口都已填满（`discover` 窗口 500、`recall` 窗口 2,000 行）。
`plan` 里另有一块约 13–16 ms 是对这 500 条候选做规范化、分组与评分的纯计算，同样有界。

**无界增长**：`findConclusions()` 是无 scope 列可用的 `instr(body, ?)` 全表扫描，随
knowledge 行数线性增长。本闭环每次调用它两次（`propose` 的重复假设拦截、`revert` 的结论发布前查询）。

## 3. 存储调用归因

表内是各阶段中共享经验库调用自身的 CPU（同一进程内用 `hrtime` 计时），
用来确认增长来自哪一次查询，而不是阶段名的直觉。

| 历史结论数 | plan 总计 | `discover` | `recall` | propose 总计 | `findConclusions` | `recall` | revert 总计 | `findConclusions` | `recordConclusion` | revert 其余 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 0.51 | 0.05 | 0.09 | 0.46 | 0.05 | 0.09 | 2.57 | 0.07 | 0.25 | 2.25 |
| 200 | 7.77 | 1.33 | 1.90 | 3.69 | 0.62 | 1.91 | 2.81 | 0.62 | 0.18 | 2.01 |
| 2,000 | 38.48 | 3.61 | 19.25 | 28.00 | 6.77 | 19.39 | 11.81 | 6.69 | 0.24 | 4.88 |
| 5,000 | 35.64 | 3.22 | 19.62 | 39.97 | 16.37 | 19.73 | 20.24 | 16.34 | 0.26 | 3.64 |

- `recall` 在 2,000 → 5,000 之间稳定在约 19.6 ms：它读的是固定的 2,000 行窗口，
  与总行数无关（窗口之外的行不会被解析）。
- `discover` 稳定在约 3.2–3.6 ms：500 行窗口。
- `findConclusions` 从 0.6 ms（200 行）到 16.4 ms（5,000 行）线性增长，是本闭环唯一
  随历史无界增长的项；在 5,000 档它已占整次闭环约 34%（两次调用合计 32.7 ms）。
  独立子系统报告给出同一函数在 10k/30k/100k 行为 29/84/280 ms
  （[r13-shared-experience.md](r13-shared-experience.md)），按此推算 100k 档单次闭环里
  仅这两次扫描就约 0.56 s，会取代 `plan`/`propose` 成为主要成本。

## 4. 序列化与深拷贝归因

在 2,000 行档另跑 3 个带包装的样本（`--history 2000`，默认插桩）：

| 阶段 | 阶段 CPU | `JSON.parse` | `JSON.stringify` | `structuredClone` |
| --- | ---: | ---: | ---: | ---: |
| plan | 39.16 ms | 2,999 次 / 10.50 ms | 507 次 / 0.21 ms | 0 |
| propose | 31.82 ms | 2,000 次 / 7.57 ms | 10 次 / 0.01 ms | 0 |
| probe baseline | 0.49 ms | 2 / 0.002 ms | 27 / 0.004 ms | 2 / 0.008 ms |
| trial | 0.98 ms | 1 / 0.002 ms | 2 / 0.003 ms | 0 |
| probe candidate | 0.17 ms | 2 / 0.001 ms | 201 / 0.014 ms | 2 / 0.004 ms |
| measure | 0.74 ms | 0 | 0 | 0 |
| promote（待确认） | 0.03 ms | 0 | 0 | 0 |
| revert | 12.55 ms | 2 / 0.003 ms | 36 / 0.064 ms | 5 / 0.029 ms |
| **合计** | **83.56 ms** | **5,006 次 / 18.07 ms（21.6%）** | **783 次 / 0.30 ms（0.4%）** | **9 次 / 0.04 ms（0.05%）** |

- **深拷贝不是瓶颈**：整次闭环只有 9 次 `structuredClone`，合计 0.04 ms。
- **序列化不是瓶颈**：`JSON.stringify` 合计 0.30 ms。
- **解析是**：18.07 ms、占整次闭环 21.6%，几乎全部来自 `recall` 的 2,000 行窗口
  （`propose` 的 2,000 次）与 `discover` 的 500 行窗口 + 计划器投影（`plan` 的 2,999 次）。
  这是"按窗口读取并解析记录正文"的固有成本：窗口本身是有界语义
  （[experience-recall.js](../../lib/experience-recall.js) 的 `maxConsidered`），
  减少解析次数等于缩小检索窗口，属于任务禁止的"缩小检索范围换性能"。
- 插桩样本的闭环总计 83.56 ms 与非插桩的 83.37 ms 基本一致，说明包装本身没有明显扭曲阶段数据；
  上表的 parse/stringify/clone 耗时仍只作归因，不用于主张收益。

## 5. 结论：NO CHANGE

| 候选 | 量化 | 不实施的理由 |
| --- | --- | --- |
| `propose` 与 `revert` 共用一次 `findConclusions` 结果 | 5,000 档可省约 16 ms/闭环 | 两次调用在本夹具里入参相同，但中间隔着真实的 `trial` / `probe` / `revert` 写入，且另一个入口可以在这段时间向同一经验库追加同一 target 的结论。`revert` 那次是"中性终态不得抹掉已证负结论"的跳过门禁，必须看到此刻已提交的库；复用会让它按旧快照决定是否发布结论。属于用 O(1) 缓存近似 O(历史) 状态，`redundant-work.md` §4 已两次撤回。 |
| 给 `findConclusions` 的 scope 加 JSON1 表达式索引或列 | 100k 档单次约 280 ms | 需要 schema 变更与既有库迁移，且 `json_extract` 与 `instr` 对畸形 body 的匹配语义不完全等价（[r13-shared-experience.md](r13-shared-experience.md) 给出 `EXPLAIN QUERY PLAN` 与等价性分析）。本轮边界禁止。 |
| `plan` 复用 `discover` 的 500 行去替代 `recall` 的 2,000 行 | 2,000 档可省约 19 ms | 两个窗口上限与过滤条件不同（500 vs 2,000，查询词不同），复用会改变证据投影；R12 C2 已就同类"复用两处投影"给出否决。 |
| 缩短 `recall` / `discover` 窗口 | 与窗口成正比 | 直接缩小检索范围，可能漏掉窗口外的历史，任务明确禁止。 |
| 惰性/分批 `plan` 评分 | 约 13–16 ms 有界 | 有界开销，且改动会改变 `evolution_plan` 的同步返回契约。 |

因此本闭环没有"已证明等价且显著"的新候选；本轮只把构成与增长边界量化。
`findConclusions()` 的 O(历史) 扫描作为**剩余瓶颈**登记：它是显式动作路径
（`evolution_propose` / 结论发布），不在每次 `agent/pre-step` 热路径上，当前规模下
低于可维护性门槛；一旦真实安装的 knowledge 行数进入 10k 以上，单次 `propose` 会先感知到它。

## 6. 复现

```sh
# 阶段构成（非插桩，4 个历史档，与报告相同的样本数；每档独立进程与独立夹具）
node --max-old-space-size=4096 scripts/benchmarks/r13-loop-composition.mjs \
  --history 0 --runs 7 --no-instrument \
  --out docs/performance/r13-loop-composition-0.json
node --max-old-space-size=4096 scripts/benchmarks/r13-loop-composition.mjs \
  --history 200 --runs 7 --no-instrument \
  --out docs/performance/r13-loop-composition-200.json
node --max-old-space-size=4096 scripts/benchmarks/r13-loop-composition.mjs \
  --history 2000 --runs 5 --no-instrument \
  --out docs/performance/r13-loop-composition-2000.json
node --max-old-space-size=4096 scripts/benchmarks/r13-loop-composition.mjs \
  --history 5000 --runs 5 --no-instrument \
  --out docs/performance/r13-loop-composition-5000.json

# 序列化/深拷贝归因（插桩副本，2,000 行档）
node --max-old-space-size=4096 scripts/benchmarks/r13-loop-composition.mjs \
  --history 2000 --runs 3 --out docs/performance/r13-loop-composition-copies.json
```

脚本每次运行都新建 `mkdtemp` 根并在结束时删除；它不读也不写任何正式数据根。
本文件与 `docs/performance/` 不在 `package.json#files` 白名单，不进入分发字节。
