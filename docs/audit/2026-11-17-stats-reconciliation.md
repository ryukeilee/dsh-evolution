# 统计口径核对与 stable 插件价值审查（2026-11-17）

本文回答两个具体问题，并给出三个 stable 插件的保留/下线依据。它只使用只读数据；
所有计数可由 `docs/audit/replay/session-evidence.mjs` 与共享经验库 SQL 复现。

## 1. 为什么两次审计的"插件调用次数"不一致

两次测量的是**不同总体**，不是同一指标的两个值：

| 口径 | 数据源 | 覆盖 | `run_code_preflight` | `run_code_diagnose` | `readonly_git_file` |
| --- | --- | --- | --- | --- | --- |
| 用户/工作流调用 | `$DSH_HOME/sessions/**/session.v4.jsonl.zstd`（482 个会话、16,817 次工具结果） | ACP/Web/CLI 持久化的会话 | **0** | **0** | **5** |
| 验证调用（共存于共享经验库） | 共享经验库的失败记录 + 晋升/黄化/重验证证据 | 任何写入同一经验库的宿主，包括隔离验收与 canary | 1 条失败 | 1 条失败 | 1 条失败 |

失败记录只能证明"某个运行时里调用过并失败过"，**不能**证明用户工作流调用过：
`$DSH_HOME/storages/evolution-experience` 中的
`tool run code preflight` / `tool run code diagnose` / `tool readonly git file`
三条失败记录都出现在对应插件发布后的验证窗口（2026-11-15 11:00:27 与 11:21:05），
与 `archive/experiments/*.evidence.json` 中的 probe/canary 样本吻合；这些运行不在
`$DSH_HOME/sessions` 的会话日志里。

**统一口径**：

- `workflowInvocations`：只数持久化会话日志里的 `tool/call`（排除 `evolution_*`）。
  用于判断"是否进入日常执行路径"。
- `recordedFailures`：共享经验库的失败事实。用于归因与分母，**不用于**判断使用量。
- `verificationInvocations`：晋升/黄化/重验证证据中的样本。用于验证链路，不用于使用量。

后续的成果保留/淘汰判断只使用 `workflowInvocations`，避免重验证流量污染使用量
（约束 7 的"避免历史调用数据污染后续判断"）。

## 2. 为什么 104 条失败分类合计只有 102

上一轮报告里把三类合并成一行（8 运行时 + 3 其他 + 2 非法输出 = 13），
却写成"运行时错误 / 其他 11"。合并行与总数不一致，合计 102。

正确、逐类展开的分布（总数 104，由脚本按固定规则生成）：

| 类别 | 数量 | 占比 |
| --- | --- | --- |
| `dsh-composition-guard` 拦截 | 32 | 30.8% |
| 嵌套工具失败（patch 不符、文件不存在、grep 参数等） | 19 | 18.3% |
| 程序语法错误 | 17 | 16.3% |
| `Patch rejected before any change` | 13 | 12.5% |
| 执行超时（120,000 ms） | 10 | 9.6% |
| 程序运行时错误 | 8 | 7.7% |
| 其他 | 3 | 2.9% |
| 非法输出（非 lossless JSON） | 2 | 1.9% |
| **合计** | **104** | 100% |

规则固定在 `docs/audit/replay/session-evidence.mjs` 的 `classify()`：先剥离
`code run failed (<kind>):` 前缀，再按 guard → timeout → invalid-output →
patch-rejected → syntax → runtime → nested-tool 的顺序归类，最后落入 other。
运行该脚本会同时打印总失败数、分类计数与每工具计数，合计可由输出直接核对。

## 3. 共享经验库口径（只读 SQL）

```sh
sqlite3 ~/.dsh/storages/evolution-experience/experience.sqlite \
  "SELECT json_extract(body,'$.issueType') AS t, count(*),
          sum(json_extract(body,'$.failureMode') IS NULL)
     FROM knowledge GROUP BY t;"
```

| issueType | 数量 | failureMode 为空 |
| --- | --- | --- |
| tool failure | 23 | 23 |
| experiment-conclusion | 5 | 5 |
| agent failure | 2 | 2 |

全部 23 条工具失败只有一种 `semanticFact`（`official operation failure host operation failure`），
因为采集器此前读 `result.code` 而宿主的失败码在 `error.info.code`。本次修复后新记录会带真实码；
历史记录不迁移、不猜测。

## 4. 三个 stable 插件的价值审查

判断依据分三层，逐层收紧：

1. **是否进入日常工作流**（`workflowInvocations`）：0 / 0 / 5。
2. **能力本身是否可被工作流使用**：只读确定性、无副作用；三个都满足。
3. **是否解决了一个真实的工作流问题**：
   - `readonly_git_file`：解决"按 git revision 读取文件"在宿主 guard 文本回退下被误拦的问题；
     5 次真实调用；保留。
   - `run_code_diagnose`：输入是调用方自填的 `occurrences`/`failures`，不读经验库、
     不读执行记录；无论调用多少次都无法改变任何工作流指标。0 次工作流调用。**下线候选**。
   - `run_code_preflight`：人工前置工具；对 19 个记录到的语法失败程序只覆盖 9 个（47%），
     且 0 次工作流调用。**下线候选**。

**为什么不下线 diagnose 的"历史调用数据"会造成误判**：它在共享经验库里确实有 1 条失败记录，
但那来自发布后的验证样本，不是工作流调用；若把该记录当使用量，会误以为它进入了日常路径。
本审查明确把这条记录归类为 `verificationInvocations`。

**下线方式与授权边界**：生产下线是外部写（consumer composition + 发布记录 + 重启），
需要所有者明确授权。可执行命令（本次未执行）：

```sh
node scripts/shared-plugins.mjs disable --profile acp --id evolution-promoted-e82a216992bb --id evolution-promoted-2794ab16d2b3
node scripts/shared-plugins.mjs disable --profile web  --id evolution-promoted-e82a216992bb --id evolution-promoted-2794ab16d2b3
```

执行后下一次新会话生效；已运行会话不重新挂载。`readonly_git_file`（`evolution-promoted-af973a3eea01`）
保留，ACP 与 Web 的批准范围不变。

## 5. 与本次代码改进的关系

- 采集器现在记录每个失败的真实 `error.info.code` 与**成功/尝试分母**
  （`attemptssincefailure` / `successessincefailure`，进程内有界 LRU，最多 256 个目标），
  规划器据此给出 `observedAttempts` / `observedSuccesses` / `observedFailureRate` / `rateBasis`。
- 规划器按失败模式区分 `caller-input` / `capability-gap` / `host` / `environment` / `unknown`；
  调用方错误不再生成候选，缺失能力仍可生成。
- 工具失败目标的候选带 `benefitModel.kind = "workflow"`；晋升门禁据此要求**工作流前后对照**，
  只证明"工具存在且返回期望值"的自指样本不能再满足该目标。
