# 保留计划的峰值 RSS 归因：原始数据与探针

`docs/performance/retention-plan-cost.md` 第 4.3 节的全部内存数字来自这里的探针运行。
这里是**未加工的样本**，便于独立复核；结论与解释在那一节。

## 被检验的问题

`docs/performance/retention-plan-cost.md` 的上一版记录：40 000 行 dryRun 的采样峰值 RSS
`666.1 → 731.1 MB`，方向与堆增量相反。问题是这个差值是不是优化本身的属性。

## 三方

- `B` = `b7547f8`（本改动之前的提交），`git archive b7547f8 lib` 解出到 `/tmp/dsh-rss-research/B/lib`；
- `C` = `194fc6a`（含按行备忘的上一版），解出到 `.../C/lib`；
- `M` = 本树删除备忘后的副本（`.../M/lib`，保留下述时钟读取）。

三方使用**同一份 fixture 字节**：由 `b7547f8` 的公开函数生成一次，写入
`fixture-10000.json` / `fixture-40000.json`（未随仓库提交，24.9 MB）。
`fresh.jsonl` 每行的 `fixtureSha256` 与 `report` 可以用来确认这一点。

## 三组样本

| 文件 | 探针 | 每格样本 | 说明 |
| --- | --- | ---: | --- |
| `fresh.jsonl` | `probe.mjs`，由 `run.mjs` 每格起一个**新进程** | 6 | 记录 `resourceUsage().maxRSS` 增量、调用前后 `memoryUsage()`、进程内 2 ms 定时器回调次数 |
| `external.jsonl` | `external-child.mjs`，由 `external.py` 用 Darwin `proc_pidinfo(PROC_PIDTASKINFO)` 在**进程外**每 2 ms 采样 | 6 | 记录规划期外部采样峰值、样本数、最大采样间隔 |
| `memo.jsonl` | `memo.mjs`，保活计划其余结构、清引用后两次 GC | 3 | 记录备忘的 `Map` 表与它独占可保留的对象图（`freedHeap`，**字节**） |

排程（`fresh`/`external`）：每个 geometry × 每个规模跑 6 轮，每轮顺序为
`BCM → MCB → CMB → BMC → MBC → CBM`。`pinned` geometry 的 Node 参数为
`--expose-gc --max-semi-space-size=16 --max-old-space-size=1024`。

## 关键事实（可从样本直接复算）

- `fresh.jsonl` 72 行与 `external.jsonl` 36 行的定时器回调次数**全部为 0**：
  同步规划期间 `setInterval` 无法插入，因此基准里的 dryRun "peak RSS" 实际是
  `max(调用前 RSS, 调用后 RSS)`。
- `maxRSS` 是进程历史高水位：`pinned`/40 000 下 C、M 的增量被加载阶段遮蔽为 0，
  该格不可用。
- 进程外采样：40 000 行规划期峰值 `B 317.36 / C 241.25 / M 239.77 MiB`，
  10 000 行 `154.76 / 135.37 / 135.09 MiB`；样本数 89–545，最大采样间隔 3.96 ms。
- 备忘独占：40 000 行 `Map` 表 955 008 B、对象图 9 774 080 B；
  10 000 行 200 504 B / 2 403 176 B。

## 已知限制

- 探针脚本把暂存根目录硬编码为 `/tmp/dsh-rss-research`，复跑需要先把 `B/`、`C/`、`M/`
  与 fixture 放到那里（`setup.py` 生成，`prepare-memo.py` 生成 `M/`）。
- `external.py` 只在 macOS 上可用（`/usr/lib/libproc.dylib`）。
- 所有 RSS 数字都是采样下界，不是精确的 OS 阶段最大值；`maxRSS` 受进程历史影响。
- `fresh.jsonl` 的 `sampledHeapDelta` 同样是下界，不是总分配字节；`default`/10 000 一格
  的方向与总分配相反，不能作为收益主张。
- 未测量写入阶段的进程外峰值；`B → M` 同时删除重复规范化、重复遍历与深拷贝，
  该探针无法把三者分开。
