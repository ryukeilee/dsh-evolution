# 保留计划的峰值 RSS 归因：原始数据与探针

`docs/performance/retention-plan-cost.md` 第 4.3 节的全部内存数字来自这里的探针运行。
这里是**未加工的样本**，便于独立复核；结论与解释在那一节。

## 被检验的问题

`docs/performance/retention-plan-cost.md` 的上一版记录：40 000 行 dryRun 的采样峰值 RSS
`666.1 → 731.1 MB`，方向与堆增量相反。问题是这个差值是不是优化本身的属性。

## 三方

- `B` = `b7547f8`（本改动之前的提交），`git archive b7547f8 lib` 解出到 `<root>/B/lib`；
- `C` = `194fc6a`（含按行备忘的上一版），解出到 `<root>/C/lib`；
- `M` = 当前工作树（已删除备忘），复制到 `<root>/M/lib`，保留下述时钟读取。

`<root>` 由 `RSS_ROOT` 给出，默认 `/tmp/dsh-rss-research`；`setup.py` 建好三侧并校验
它们确实各就各位（B 无备忘、C 有备忘、M 无备忘）。

三方使用**同一份 fixture 字节**：由 `B` 的公开函数生成一次，写入 `<root>/fixture-*.json`
（未随仓库提交，40 000 行那份 24.9 MB）。`fresh.jsonl` 每行的 `fixtureSha256` 与
`report` 可以用来确认这一点。

## 三组样本

| 文件 | 探针 | 每格样本 | 说明 |
| --- | --- | ---: | --- |
| `fresh.jsonl` | `probe.mjs`，由 `run.mjs` 每格起一个**新进程** | 6 | 记录 `resourceUsage().maxRSS` 增量、调用前后 `memoryUsage()`、进程内 2 ms 定时器回调次数 |
| `external.jsonl` | `external-child.mjs`，由 `external.py` 用 Darwin `proc_pidinfo(PROC_PIDTASKINFO)` 在**进程外**每 2 ms 采样 | 6 | 记录规划期外部采样峰值、样本数、最大采样间隔 |
| `memo.jsonl` | `memo.mjs`，保活计划其余结构、清引用后两次 GC | 3 | `mode="maps"` 只清备忘的 Map 表（`sourceGroups` 保活），`mode="total"` 先清 `sourceGroups` 再清整个备忘；两者之差即备忘独占可保留的事件对象图。`freedHeap` 单位为**字节** |

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
- 备忘独占（`freedHeap` 中位数）：40 000 行 `Map` 表 955 008 B、合计 9 774 848 B
  （对象图 8 819 840 B = 8.41 MiB）；10 000 行 200 504 B / 2 403 048 B
  （对象图 2 202 544 B = 2.10 MiB）。归因时不要把 `total` 总量当成对象图。

## 复现

从仓库根执行（`setup.py` 会把探针副本放到同一个根）：

```sh
RSS_ROOT=/tmp/dsh-rss-rerun python3 docs/performance/retention-plan-rss/setup.py
cd /tmp/dsh-rss-rerun
RSS_ROOT=/tmp/dsh-rss-rerun node -e 'import(`${process.env.RSS_ROOT}/helpers.mjs`).then(async (h) => {
  const { writeFile } = await import("node:fs/promises"); h.freezeClock();
  const k = await import(`${process.env.RSS_ROOT}/B/lib/dockyard-domain/knowledge.js`);
  await writeFile(`${process.env.RSS_ROOT}/fixture-10000.json`, JSON.stringify(h.corpus(10000, k)));
})'
RSS_ROOT=/tmp/dsh-rss-rerun node --expose-gc probe.mjs M 10000 /tmp/dsh-rss-rerun/fixture-10000.json
```

`setup.py` 建的三侧是 B = `b7547f8`、C = `194fc6a`（含备忘）、M = 当前工作树（无备忘），
并自带断言确保三侧确实各就各位。`run.mjs` 跑完 `fresh.jsonl`，`external.py` 跑完
`external.jsonl`，`run-memo.mjs` 跑完 `memo.jsonl`，`summarize.py` 重算统计表。
报告定稿前在最终树上重跑过一次 10 000 行：三侧 fixture/report hash 相同、回调 0、
`maxRSS` 增量 B 77.3 / C 58.61 / M 58.05 MiB。

## 已知限制

- 探针脚本读 `RSS_ROOT`（默认 `/tmp/dsh-rss-research`）；不设就落在默认目录。
- `external.py` 只在 macOS 上可用（`/usr/lib/libproc.dylib`）。
- 所有 RSS 数字都是采样下界，不是精确的 OS 阶段最大值；`maxRSS` 受进程历史影响。
  `pinned`/40 000 的 `maxRSS` 增量对 C、M 已测为 0（加载阶段的高水位遮蔽），该格不可用。
- `fresh.jsonl` 的 `sampledHeapDelta` 同样是下界，不是总分配字节；`default`/10 000 一格
  的方向与总分配相反，不能作为收益主张。
- `shipped.json` 是同一环境下 `retention-plan-cost.mjs` 的完整输出（基线 `b7547f8`，
  变体 C 与 M），供 `report.md` 的补充统计使用。
- 未测量写入阶段的进程外峰值；`B → M` 同时删除重复规范化、重复遍历与深拷贝，
  该探针无法把三者分开。
