# 经验驱动进化的成本与收益边界

测量对象：本工作树（Evolution 0.2.3 + Propose–Probe–Compose 增强），基线 `8effd86`。所有数字都是本轮实际执行得到的；没有测 formatter、tokenizer、prompt cache 折扣、供应商计费或长时间多会话负载。

## 1. 固定模型上下文（每个请求都付）

用 `scripts/benchmarks/fixed-context/fixture.mjs` 捕获当前注册面（12 工具，含 probe 安全说明）与 `origin/main` 前的 10 工具面：

| 项 | 10 工具（HEAD） | 12 工具（本树） | 增量 |
| --- | --- | --- | --- |
| `systemText` | 1,633 B | 2,388 B | +755 B |
| fields（text + 每工具 name/description/紧凑 parameters） | 7,674 B | 9,835 B | +2,161 B |
| wire（text + 紧凑工具数组 JSON） | 8,105 B | 10,352 B | +2,247 B |

结论：新增 `evolution_plan` / `evolution_probe`、相应系统提示词与 probe 安全说明，使模型可见固定上下文增加约 2.2 KB/请求（按 UTF-8 字节计，**不是**计费 token，也没有做真实 provider 计费测量）。`test/fixed-context-budget.test.mjs` 用“原基线 + 已批准的 2,600 B / 2,800 B 工具与安全说明增量”的 80% 预算继续守住这条成本，仍拒绝无预算增长。

## 2. 真实宿主验收

命令（隔离 home、`--host 0.2.2-rc.1 --no-hmr --experience-evolution --runtime <prepared>`）：

- 25/25 步通过（原 21 步 + seed / invalid / restart / regression 四个独立进程 phase），本机 warm runtime 连跑 6 次稳定 **28–34 s**；原 21 步历史证据为 24–28 s，新增 4 次 boot 的增量为约 **4–8 s**。
- 每个 phase 的真实执行：`probe` baseline/candidate 各 2 步 × 3 次重复（共 12 次官方工具管线调用），4 个 phase 共 4 次宿主启动、1 次真实 promotion + canary、2 次真实 revert、1 次重启验证。
- 这些调用发生在 **用户显式要求进化** 的验收/使用路径上；日常 Desktop/ACP/Web 没有新增回合、没有后台任务。

## 3. 日常与显式路径的运行时成本

- `evolution_plan`：一次有界扫描（默认窗口 500 行 canonical knowledge，上限 2,000；`discover` 只读 SQLite 事务），加上本地失败记忆（≤200 条）的纯投影与评分。没有模型调用、没有定时器。
- `evolution_probe`：每次调用执行声明的场景（≤8 步 × ≤5 重复，分 baseline/candidate 两次），每步一次官方 `ctx.tools.execute`，单步超时 30 s；样本只保留工具名/role/isError/错误分类码/value digest/耗时，不保留返回值正文。
- `evolution_probe` 的安全预检：每个步骤一次官方 `ctx.tools.get()` 与 `isConcurrencySafe(args)` 判定，发生在任何执行之前；没有 opt-in 的工具、未知工具、`run_code` 与 `evolution_*` 直接拒绝。它不新增执行器或沙箱，成本是每个场景步骤一次同步注册表读取。
- `evolution_measure`：纯内存计算，无额外 I/O；`recordConclusion` 是每次终态转换一次同步 SQLite 事务（BEGIN IMMEDIATE，2 s busy timeout，与现有采集器同一语义）。
- 结论写回失败只记 warning，不改变 Revert/Promotion 结果；共享 SQLite schema 仍为 v1，旧库可直接打开。

## 4. 未测量与残余风险

- 没有测量真实模型在 `plan → probe → measure` 流程中的 token 成本或回合数；这些取决于模型是否使用新工具与场景大小。
- 没有做长时间多会话并发下 `findConclusions`/`discover` 的吞吐基准；它们的扫描窗口有上限，但 SQLite 读事务仍会与采集器写入竞争（沿用同一 busy_timeout 语义）。
- 没有测量 `probe` 场景执行本身对宿主事件循环的阻塞——它逐条 await 官方管线，等待期间不持有同步 CPU。
