# R12 开放性性能研究：三项等价改写与长期增长边界（2026-11-25）

受理标识：**DSH-EVOLUTION-PERF-R12-01**。基线 `origin/main` =
`719fcbb2a6405526f34ca14aa061f04220bcefec`（v0.2.21）。本轮是开放性的全仓库性能研究，
结论按子系统分别记录在：

| 子系统 | 文档 | 结论 |
| --- | --- | --- |
| 共享经验 SQLite 与经验链路 | [r12-shared-experience.md](r12-shared-experience.md) | 实施 1 项（常量 SQL 句柄复用） |
| 领域存储 / 事件桥 / 冷档案 | [r12-domain-storage.md](r12-domain-storage.md) | 实施 1 项（`isSensitiveKey` 有界记忆） |
| 跨入口启动 / 诊断 / 用量扫描 | [r12-cross-entry-startup-and-audit.md](r12-cross-entry-startup-and-audit.md) | 实施 1 项（`diagnoseSharing()` O(N²)→O(N)） |
| 完整进化链路（proposal→promotion） | [r12-evolution-lifecycle.md](r12-evolution-lifecycle.md) | **NO CHANGE**（11 个候选全部实测否决） |

本文只做跨子系统汇总、Lead 独立复跑与方法边界说明；各项的根因、逐轮数据、正确性差分与
复现命令以对应子系统文档为准，不在此重复。

环境：Node `v26.13.1`、`darwin/arm64`、8 逻辑 CPU、16 GiB。所有基准使用隔离临时目录与
合成数据根；未触碰正式 `DSH_HOME`、正式经验库、`event-bridge.key` 或用户数据，未修改官方
DSH 源码。

## 1. 方法

- 计时按 `TEAM.md` 与任务约束：A/B 交替、同负载、每轮独立进程、至少 3 轮；主指标是
  `process.cpuUsage()`（user+system），墙钟、峰值/常驻 RSS、落盘字节作为辅助，不作为
  主张收益的唯一依据。
- 四个子系统的研究并行进行，机器 load average 在 1.5–2.4 之间，因此所有报告都显式区分
  “配对交替的 CPU 差”与“受邻居影响的墙钟抖动”，离群轮次按噪声处理而不计入收益。
- 为排除并发噪声，Lead 在全部 Builder 结束后于同一台机器上按顺序**独立复跑**了三项
  已实施改动的 A/B（机器上无其它基准、测试或验收进程）。复跑数字与 Builder 原始数字
  方向一致、量级相符；下表同时列出两者，不做加权、不相加。
- 正确性一律用差分证明，而不是只加新用例：A 用“反向变换 + 同输入逐字节/逐字段对拍”，
  B 用“抽取生产函数 + 52 键语料 + FIFO 淘汰后重查 + 固定字节锚点”，C 用“两侧完整输出
  逐字节相同 + 调用计数反证”。

## 2. 已实施的三项改动

### 2.1 共享经验写入路径：常量 SQL 语句句柄复用

**根因**：`openSharedExperience()` 的私有 `record()` 是全部经验事实的唯一写入口；基线每次
调用都重新 `db.prepare()` 五条 SQL 文本完全相同的语句（`node:sqlite` 每次都重新编译 SQL）。
重复回放（at-least-once 的同一 event id）只做一次 SELECT + COMMIT，编译成本占比最高。

**改动**：五个 `StatementSync` 句柄在 `openSharedExperience()` 内准备一次；SQL 文本、绑定
顺序、`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` 边界、schema 判定与落盘字节全部不变
（`lib/shared-experience.js`）。语句句柄由 `run()` 自动 reset，不是派生值缓存。

| 工作负载（400 条/样本） | Builder CPU | Lead 复跑 CPU | 逐轮方向 |
| --- | ---: | ---: | --- |
| 新事实写入 | 87.581 → 79.946 ms（−8.72%） | 87.272 → 78.798 ms（**−9.71%**） | 5/5 轮为负 |
| 重复回放（全部 duplicate） | 3.662 → 2.263 ms（−38.20%） | 3.510 → 2.270 ms（**−35.33%**） | 5/5 轮为负 |
| `findConclusions` 对照（未改路径） | 0.300 → 0.283 ms（−5.7%，噪声） | 0.287 → 0.278 ms（−3.1%，噪声） | 3/5 轮为负 |

两侧落盘字节相同（98,304 B / 94,208 B），`stats()` 相同。收益随写入次数线性增长、与历史
长度无关；每个 store 多持有 5 个语句对象直到 `close()`，`open()` 无可测变化。

### 2.2 脱敏热点：`isSensitiveKey()` 的有界纯函数记忆

**根因**：`redact()` 在每条事件的摄入路径上对每个字段名调用 `isSensitiveKey()`；原实现每次
都做 `String()` + `toLowerCase()` 分配与 8 个 `includes()`。基线 CPU profile（20k 事件冷
吸收）里 `isSensitiveKey` + `.some` 回调约占 9–12%。这是纯函数的重复求值，不是对历史状态的
近似。

**改动**：512 项 FIFO `Map`，只缓存原始字符串键；非字符串键（可能带状态化 `toString`）走原
计算路径。判定规则、敏感子串集合、脱敏决策、持久化字节均逐字未变（`lib/dockyard-domain/memory.js`）。

| 工作负载 | Builder CPU | Lead 复跑 CPU | 辅助 |
| --- | ---: | ---: | --- |
| 20k 已签名事件冷吸收 | 1245.1 → 1080.4 ms（−13.23%） | 1113.8 → 978.3 ms（**−12.16%**） | 墙钟 −15.31% / −14.10% |
| 稳态 `flush()` 对照（未改路径） | 12.58 → 12.02 ms | 9.748 → 9.743 ms | 无可测收益 |
| `observe()` 对照（未改路径） | 48.10 → 47.65 ms | 41.61 → 41.37 ms | 无可测收益 |

强制 GC 后保留堆两侧相同（Builder 19.42 MiB；Lead 20.36 MiB 对 20.37 MiB）。峰值 RSS
Lead 复跑 A 285.5 / B 293.0 MiB，落在进程高水位随 GC 时机的散布内；512 项字符串键不可能
解释这个差值，因此不主张内存下降，也不把它当作回退证据。

### 2.3 共享插件诊断：`diagnoseSharing()` 的 O(记录×行) 消除

**根因**：一次只读诊断里，每个 consumer 的激活行数组被物化 6 次，并且三处以
`index.records.find(...)` / `rows.some(...)` / `records.some(...)` 做线性查找；R11 §3 已确认
`published.json` 与 consumer `plugins` **没有记录数上限**，长寿命安装会进入有效区间。

**改动**：在**同一遍**检查内构建局部快照（撤销表成员 Set、每 profile 的 `rowsByProfile` /
`rowIdsByProfile`、`recordById`），所有判定、顺序、证据字段与失败语义不变；不跨调用缓存、
不信任 mtime/size、不减任何认证/摘要/索引校验（`lib/diagnostics.js`）。

| `promotion.sharing` 记录数 | Builder CPU | Lead 复跑 CPU |
| --- | ---: | ---: |
| 5,000 | 1321.490 → 679.387 ms（−49.55%） | 1129.689 → 686.055 ms（**−39.27%**） |
| 500 | 77.253 → 73.186 ms（−5.94%） | 未复跑（同量级） |
| 50 | 10.934 → 10.691 ms（−2.21%，噪声） | 未复跑 |

5,000 档三对配对差在两次运行中全部为负（Builder −476.7 / −654.8 / −704.6 ms；Lead
−452.9 / −443.6 / −433.5 ms），方向不依赖采样顺序。未改动的 `readPublishedPluginReview()`
在同进程内基本不变（Lead +0.16%，噪声），说明收益来自被改的诊断路径而非环境漂移。

## 3. NO CHANGE 的方向与依据

以下方向都有实测或源码级证据，本轮不实施；详细数字见各子系统文档的“否决/NO CHANGE”表。

| 方向 | 依据 |
| --- | --- |
| 稳态 `flush()` 复用 `appliedDigest`、跳过日志前缀校验 | 既有反例已证明 O(1) 信号无法证明 O(历史) 派生值未变（`redundant-work.md` §4、`domain-flush-steady-cost.md`）；日志字节仍需完整读取并做一次带密钥前缀摘要。 |
| `synchronous`/`busy_timeout`/`cache_size` 调参 | 分别削弱崩溃恢复、四进程饥饿修复与无 A/B 证据的启发式调参。 |
| `findConclusions()`/`discover()` 的 `instr` 全表扫描加索引 | 需改 schema、既有库补建索引，且 `json_extract` 与 `instr` 对畸形 body 不完全等价；显式动作读路径，风险与收益不匹配。 |
| 迁移 CLI 的三次 events 扫描 | 一次性离线命令；合并扫描会改变备份验证与事务内自证的顺序。 |
| 启动时惰性加载 `diagnostics.js` | 端到端冷导入仅 −2.063 ms CPU（−3.43%），却把失败窗口移到首次工具使用并改异步契约。 |
| `agent/pre-step` 每次 flush 改频率 | 改变事件认证/去重时机；`axis-steady-history.md` 已给出 100k 历史 61.3 ms/次的增长曲线。 |
| 桌面任务通道 1500 ms 兜底重扫降频 | 是该 watcher 漏事件时的唯一兜底；桌面任务通道默认禁用。 |
| canary 每次观测跳过事件桥全量验签 | 它是唯一能覆盖旧晋升的事实来源并携带 `source` 溯源串；7.756 ms/2000 事件，改动即属于被撤回的“O(1) 缓存 O(历史)”。 |
| 晋升链路的两次 `refresh()`/两次门禁/两次证据读取 | 绝对收益 0.066 ms/会话启动或常数级对象读取，且会去掉整棵树一致性证明或改变返回契约。 |
| 其他微项（PTC 正则、canary 描述符二次序列化、观察者表剪枝、`detectDegradation` 索引循环、collector LRU） | 微秒级或有界摊还 O(1)；`detectDegradation` 2000 行实测仅约 13–35 µs/次，低于可维护性门槛。 |

## 4. 剩余瓶颈（本轮未消除，属完整性/协议下界）

- **稳态事件同步**：每次 `flush()` 完整读取日志前缀并做带密钥 HMAC，同时把整张已提交标记表
  序列化后 SHA-256；`axis-steady-history.md` 实测 100k 事件约 61 ms/次。这是认证与检查点
  绑定的下界，不靠减弱校验换取。
- **canary 证据**：每次观测全量读 + 验签事件桥，约 7.8 ms/2000 事件；同样属证据保真要求。
- **归档事务**：256 段负载中约 84% 延迟是 `fsync`，复制约 7.6%；`closure.md` 已论证没有
  低风险高收益的替代实现。
- **共享经验读路径**：`findConclusions()`/`discover()` 仍是 O(history) 的 `instr`/全表扫描
  （既有 10k/30k 数据 82 ms@30k），受 schema 与语义等价约束本轮不动。
- **诊断防篡改**：5,000 条记录下剩余的约 679 ms 主要是逐记录 `lstat` + `readFile` + `sha256`
  与索引全量校验。
- **启动模块图**：orchestrator 入口仍静态拉入 30 个文件 / 约 1.79 MB `lib/`；经验入口的
  `lib/` 闭包为 8 文件 / 约 246 KB（`r12-startup-graph.json`）。

## 5. 验证

- 正确性差分：
  `test/shared-experience-prepared-equivalence.test.mjs`（含注入错误 SQL 的反证）、
  `test/dockyard-domain/sensitive-key-memo.test.js`（含 FIFO 淘汰与变异反证）、
  `test/domain-storage/load-projection-equivalence.test.js`（固定字节锚点），以及 C 的
  50/500/5000 三档完整输出逐字节相同与“修复前 12 次投影 / 修复后 2 次”的调用计数反证。
- 聚焦：各子系统文档列出的套件全部通过（355/355、223/223、213/213、167/167、148/148 等，
  详见分文档）。
- 全量（集成后的树）：`NODE_OPTIONS=--max-old-space-size=4096 npm test` ——
  **2346 项，2344 通过 / 0 失败 / 2 跳过**（基线 R11 为 2342 项；本轮新增 4 项差分/反证用例）。
- 打包：`npm run pack:check`（开发阶段）的结果见 §6；不发版、不打 tag、不合并。
- 未执行：真实宿主验收、`pack:check --release`、发布。本轮只产生开发阶段证据，不把未执行
  的检查写成通过。

## 6. 交付状态

- 分支 `t3/performance-research`，基线 `719fcbb`；三项生产改动 + 各子系统的基准脚本、
  原始数据与证据文档。
- `npm run pack:check`（开发阶段）：17/17 通过；工作树是 `0.2.21` 固定点的已提交后继，
  `release/` 固定产物与既有验收证据未改动。
- 独立复核（`gpt-6.2-sol` High）与 CI 结果在 PR 交付说明中记录；本文件不预设未取得的结论。
