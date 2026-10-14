# retention-plan RSS 研究报告

## 1. 判定

文档中约 +65 MiB 的 dryRun RSS 差值，不能认定为本次优化的真实单次规划峰值回归。独立新进程中未复现；证据支持共享进程历史与采样口径混合造成的观测差异（b/c），无法把历史差值精确归因到某一块分配。

memo 有小幅、真实的暂态成本：固定堆参数、40 000 行的进程外规划 RSS 采样峰值 C−M 中位数之差为 +1.48 MiB；10 000 行为 +0.28 MiB。Map 表本身约 0.91 / 0.19 MiB；sourceGroups 消失后，memo 可独占保留的对象图合计约 9.32 / 2.29 MiB。没有证据表明删除三次深拷贝造成 +65 MiB 回归；本研究也没有把它们的单独 RSS 效应与其它删除操作分开。

先读了 shipped benchmark。其 measure() 在 GC 后取基线、启动 2 ms interval，并在 await compact() 结束后手动取样。独立进程的 72 次、进程外实验的 36 次 dryRun，interval 回调全部为 0。因此本次 dryRun 的所谓 peakSampledRssBytes 实际等于 max(调用前 RSS, 调用后 RSS)，不是同步规划峰值。代表性 C/default/40000 样本：wall=965.376292 ms，ticks=0，唯一采样为 endpoint（rss=294086312，heapUsed=107531776 字节）；调用前 rss=160445184。不是只依据“同步代码会阻塞定时器”推断。

## 2. 精确实验命令与设计

工作目录为用户指定 worktree；Node v26.11.1，Darwin 27.0.0 arm64，Apple M2。没有安装依赖，也未运行宿主验收或 release 命令。

```sh
rtk proxy python3 /tmp/dsh-rss-research/setup.py
rtk proxy node /tmp/dsh-rss-research/run.mjs
rtk proxy node --expose-gc scripts/benchmarks/retention-plan-cost.mjs --baseline b7547f8 --lib /tmp/dsh-rss-research/C/lib --lib /tmp/dsh-rss-research/M/lib --scales 10000,40000 --samples 2 --rounds 2 --warmup 0 --out /tmp/dsh-rss-research/shipped.json
rtk proxy python3 /tmp/dsh-rss-research/external.py
rtk proxy python3 /tmp/dsh-rss-research/prepare-memo.py
rtk proxy node /tmp/dsh-rss-research/run-memo.mjs
rtk proxy python3 /tmp/dsh-rss-research/summarize.py
rtk proxy git status --short
```

setup.py 固化最初以内联 Python 执行的准备步骤，完成测量后也执行了该文件以确认可重建相同树；prepare-memo.py 同理。B 用 git archive b7547f8 lib 解到 /tmp；C 拷贝当前 lib；M 只应用题目指定的 memo 删除与 classification 替换，保留两处 reader 的 clock read，没有其它代码改动。最终 git status --short 无输出。

run.mjs 为每侧每规模每种堆设置启动 6 个独立子进程；每个子进程只 load 一次、GC、测量一次 compact({dryRun:true})、GC，再退出。每一规模的六轮顺序：BCM、MCB、CMB、BMC、MBC、CBM。先 default 的 10000/40000，再 pinned 的 10000/40000，总计 72 个子进程。无 warmup。子进程命令为：

```sh
node --expose-gc /tmp/dsh-rss-research/probe.mjs B 10000 /tmp/dsh-rss-research/fixture-10000.json
node --expose-gc --max-semi-space-size=16 --max-old-space-size=1024 /tmp/dsh-rss-research/probe.mjs B 10000 /tmp/dsh-rss-research/fixture-10000.json
```

其余子进程将 B/10000 替换为对应侧和规模。default/pinned 的 V8 heap_size_limit 分别是 4395630592 / 1124073472 字节。

fixture 由 shipped corpus() + B 的公开 knowledge 函数生成一次，所有侧读取相同文件；fixture JSON 的 SHA256：
- 10000：073fdfd78fa313d08abee335090bffef7f8af2ae2a3644bebc5ec0f920cdd54a
- 40000：95fad5f603285e29816f84a8db9becd7c83736477ffd54c1521148ab0b0e1dd7

各规模 36 个 fresh 样本的 report 全部相同。原始 benchmark 每侧每阶段每规模 4 样本，先 B/C 后 B/M，各 pair 按 B/V、B/V、V/B、V/B 顺序；每一阶段的报告、状态、档案及固定点断言全部通过。B 在两个 pair 中不是同一组观测，不能混合当作同一个基线。

external.py 额外启动 36 个独立 pinned 子进程，同样六种顺序，每侧每规模 6 次。子进程加载及 GC 后发 START 并等待父进程确认，再开始 compact；结束立刻发 END。父进程通过 Darwin proc_pidinfo(PROC_PIDTASKINFO).pti_resident_size 每 2 ms 读取子进程 RSS，不依赖子进程事件循环。每次实际获得 89–545 个样本，最大观测间隔 3.96 ms。它仍是采样下界，但确实覆盖同步规划内部。

memo 诊断只修改 /tmp/D 的一个 hook，放在 #knowledgeRetentionPlan 返回前；每规模、每模式 3 个 fresh pinned 进程，顺序 maps/total、total/maps、maps/total。maps 模式保留 sourceGroups 再清空 memo；total 模式先清空 sourceGroups，再测清空 memo 能释放多少 heapUsed。每次读数前各执行两次 GC，histories、knowledgeByKey、retainedEntries 明确保活。该 hook 实验不用于耗时或 RSS 比较。

## 3. 原始观测汇总

全部以 MiB（2^20 字节）表示，格式为中位数 [最小值, 最大值]。原文 MB 数字实际也按 2^20 换算。第一表每格 n=6；“同 shipped 算法的堆增量”使用相同 start/timer/endpoint 算法，但运行上下文是新进程。第二表才是未修改 shipped benchmark 的实际输出，每格 n=4。

maxRSS 增量 = compact 后 process.resourceUsage().maxRSS − 调用前 maxRSS。它是进程高水位的新增长量，不是“峰值 RSS − 调用前当前 RSS”。pinned/40000 的 C、M 为 0，是 setup 已建立更高历史高水位造成的遮蔽，不能解释成没有规划内存成本；因此第三表补充进程外的阶段采样峰值。

|堆设置|冷行|侧|maxRSS 增量|GC 后 RSS|GC 后 heapUsed|同 shipped 算法的堆增量|
|---|---:|---|---:|---:|---:|---:|
|default|10000|B|76.95 [76.81, 77.11]|159.07 [158.75, 159.35]|7.72 [7.72, 7.72]|34.52 [31.84, 34.69]|
|default|10000|C|58.66 [58.34, 58.91]|139.19 [138.77, 139.50]|7.72 [7.72, 7.72]|42.24 [42.03, 42.47]|
|default|10000|M|58.28 [57.92, 58.55]|138.84 [138.55, 139.06]|7.72 [7.72, 7.72]|41.56 [41.31, 41.73]|
|default|40000|B|139.52 [139.20, 140.03]|338.36 [337.97, 339.21]|11.37 [11.37, 11.38]|172.41 [172.32, 172.56]|
|default|40000|C|58.02 [57.66, 58.14]|249.04 [248.63, 249.15]|11.36 [11.36, 11.36]|92.90 [92.81, 93.86]|
|default|40000|M|56.97 [56.86, 57.50]|248.59 [248.51, 249.26]|11.35 [11.35, 11.35]|90.96 [89.89, 91.39]|
|pinned|10000|B|46.48 [45.94, 46.95]|125.49 [125.15, 125.70]|7.72 [7.72, 7.72]|43.29 [42.92, 43.72]|
|pinned|10000|C|27.13 [26.80, 27.28]|104.25 [103.98, 104.54]|7.72 [7.72, 7.72]|30.21 [30.10, 30.29]|
|pinned|10000|M|26.69 [26.33, 26.72]|103.83 [103.70, 104.06]|7.72 [7.72, 7.72]|29.63 [29.47, 29.87]|
|pinned|40000|B|55.71 [29.72, 56.17]|299.18 [270.14, 299.55]|10.32 [10.32, 10.33]|161.11 [103.63, 161.52]|
|pinned|40000|C|0.00 [0.00, 0.00]|212.53 [212.36, 212.77]|11.36 [11.36, 11.36]|83.42 [81.87, 84.12]|
|pinned|40000|M|0.00 [0.00, 0.00]|212.20 [211.77, 212.55]|11.35 [11.35, 11.36]|81.52 [80.92, 83.69]|

|冷行|比较|阶段|B 堆增量|变体堆增量|B 采样 RSS|变体采样 RSS|
|---:|---|---|---:|---:|---:|---:|
|10000|B/C|dryRun|51.74 [49.14, 52.75]|36.98 [31.46, 41.31]|207.38 [176.77, 216.54]|214.77 [196.30, 216.37]|
|10000|B/C|write|46.92 [46.57, 50.65]|41.52 [41.24, 43.48]|237.74 [232.02, 245.04]|245.18 [244.01, 247.56]|
|10000|B/M|dryRun|45.63 [36.78, 48.35]|35.08 [31.01, 35.81]|260.82 [256.20, 263.89]|260.30 [255.62, 263.89]|
|10000|B/M|write|46.81 [46.54, 50.93]|41.43 [41.25, 41.87]|268.36 [265.01, 276.08]|268.58 [267.36, 277.76]|
|40000|B/C|dryRun|165.77 [154.93, 166.49]|107.89 [86.69, 112.16]|587.14 [429.35, 671.24]|639.86 [538.14, 674.42]|
|40000|B/C|write|215.05 [210.51, 225.03]|136.45 [125.54, 140.24]|813.55 [729.30, 836.68]|842.29 [766.73, 874.20]|
|40000|B/M|dryRun|163.30 [154.59, 165.84]|95.91 [83.66, 103.54]|710.34 [682.02, 813.59]|710.78 [703.63, 714.80]|
|40000|B/M|write|215.12 [175.68, 216.33]|135.06 [124.04, 143.61]|795.68 [745.91, 825.22]|828.75 [753.51, 887.75]|

|冷行|侧|进程外规划 RSS 峰值|相对开始的增量|
|---:|---|---:|---:|
|10000|B|154.76 [154.39, 155.02]|69.41 [69.14, 69.83]|
|10000|C|135.37 [135.30, 135.61]|49.94 [49.73, 50.22]|
|10000|M|135.09 [134.95, 135.25]|49.80 [49.42, 49.91]|
|40000|B|317.36 [292.62, 318.05]|157.69 [132.92, 158.83]|
|40000|C|241.25 [241.02, 241.44]|81.64 [81.47, 81.91]|
|40000|M|239.77 [239.70, 240.20]|80.28 [79.77, 80.52]|

|冷行|释放内容|释放 heapUsed|
|---:|---|---:|
|10000|maps|0.19 [0.19, 0.19]|
|10000|total|2.29 [2.29, 2.29]|
|40000|maps|0.91 [0.91, 0.91]|
|40000|total|9.32 [9.32, 9.32]|

第三表每格 n=6，第四表每格 n=3。外部峰值的 C−B 中位数之差为 −19.39 MiB（10000）与 −76.11 MiB（40000），仅描述此次固定 fixture/Node/heap 条件，不外推生产负载。

40000 行 memo 含外层 4 个 collection 键、内层 32000 个键（observations 16000、cycles 8000、outcomes 4000、promotions 4000），其中 16000 个非 null event、16000 个 null。10000 行对应 8000 个键、4000 个非 null event。knowledge 行本身不进入 memo。Map 的 key 复用 histories 行；非 null value 与 sourceGroups.item.event 是同一个对象。不能把二者相加算成两套事件。40000 行独占可保留的 9.32 MiB 中，约 0.91 MiB 为 Map 元数据，余下约 8.41 MiB 为在 sourceGroups 消失后可由 memo 延长存活的 event 图。它们是暂态保留量，不是内存泄漏，也不能直接换算成 RSS 页数。

负面/空结果：fresh/default/10000 的 endpoint 堆增量 C=42.24、B=34.52，方向反转；因此 sampled heap-allocation delta 也不是总分配字节。pinned/40000 的 GC 后 heapUsed，B=10.32、C=11.36、M=11.35；没有证明所有内存指标都改善，C/M 差异约 0.01 MiB。shared benchmark 的 B/C/40000 dryRun RSS 又得到 +52.72 MiB，说明原式观测可以重现，但其“单次规划峰值回归”解释不能重现。

## 4. 未能确定的事

- 没有复现历史进程的完整 GC/allocator 状态，无法逐页解释原来的 +65 MiB，或把它精确分摊到 anchor 快照、fixture、模块、V8 堆页及 OS 回收。shared benchmark 保留 anchor/fullSnapshot、跨阶段执行且共享 allocator；这是可直接从代码确认的测量上下文，具体分摊仍属未知。
- maxRSS 的 setup 遮蔽不能靠增量本身排除；外部 2 ms 采样也可能漏掉短于采样间隔的峰值，不能冒称精确 OS 阶段最大值。
- B→M 同时含折叠循环、少一次 classification normalize 和三次 deep copy 删除，不足以单独量化每次删除的 RSS 效应。可隔离的是 C→M 的 memo 成本。
- pinned/40000 的 B 比 C/M 少约 1.04 MiB post-GC heapUsed 的原因未归因。也没有得到生产负载、不同 Node 版本或独立 write-phase OS 峰值的结论。

## 5. 探针与原始文件

目录：/tmp/dsh-rss-research/
- setup.py、helpers.mjs、probe.mjs、run.mjs：B/C/M 与新进程探针。
- external.py、external-child.mjs：进程外 RSS 采样。
- prepare-memo.py、memo.mjs、run-memo.mjs：Map/event 图保留量诊断。
- fresh.jsonl、external.jsonl、memo.jsonl：逐样本原始数值。
- shipped.json：未修改 shipped benchmark 的完整结果。
- manifest.json：三侧 lib 文件摘要及 fixture SHA256；summarize.py、tables.md：表格生成器与结果。

仓库跟踪文件保持不变；未触碰 parent checkout 或 release/，未提交，未外部写入。

## 6. 对文档 4.1 的处理建议

666.1→731.1 的记录作为历史采样观测值可以保留；把列叫作 dryRun 的“采样峰值 RSS”仍容易造成错误解释。现有“timer 无法打断同步规划、下界、不主张收益”提示方向正确，但不足以使 +65 MiB 成为优化导致的峰值回归证据。

建议改名为“共享进程调用边界 RSS 较大值（dryRun）/可观测时点 RSS 最大值（write）”，并写明：

> dryRun 的 interval 回调在本次独立探针 108 次调用中全部为 0；原算法只观察调用前后 RSS，无法测量同步规划内部峰值。表中的 RSS 含同一进程此前 fixture、快照、模块和 GC/allocator 状态，不支持将两侧差值归因为规划的额外内存。约 +65 MiB 未在独立进程中复现。固定堆参数、40000 冷行、每侧 6 个独立进程的进程外规划 RSS 采样峰值为 B 317.36 [292.62,318.05]、C 241.25 [241.02,241.44]、M 239.77 [239.70,240.20] MiB；采样仍为下界。memo 的 Map 表实测约 0.91 MiB，连同可延长存活的独占事件图约 9.32 MiB。

有效替代指标应同时报告独立进程的 before/after maxRSS 与其增量（注明 setup 遮蔽）、进程外同步阶段 RSS 采样峰值、post-GC RSS/heapUsed。write 应另做独立进程阶段测量后再作峰值归因，不能用本报告 dryRun 结果替代。
