# retention/compact 进程外采样基线（A/A 与 A/B）

生成时间：2026-11-06T14:57:59.576Z；总耗时 100.1 s。

本文件由 `scripts/benchmarks/retention-plan-streaming.mjs` 从同一份 JSON 自动生成；所有数值都是本轮实际测量，未引用历史数字。

## 0. 本轮用途

本轮只运行 A/B（`--runs` 不含 aa），两侧是不同代码树；本文件**没有本轮内的 A/A 噪声**。显著性判定采用同一协议、同一机器基线 `docs/performance/retention-plan-streaming-baseline.md` 第 9 节的 A/A 噪声作为参考下界（见第 10 节）。

**本轮说明**：本报告是纯 C3 边际：C1+C2 冻结快照（/tmp/dsh-stage-c1c2/lib）vs 最终树（C1–C3，C4 已撤回）。C4 含入时的历史边际测量见 docs/performance/retention-plan-streaming-c3c4-ab.{json,md}，仅供历史参考。

## 1. 环境

| 项 | 值 |
| --- | --- |
| node | v26.13.0 |
| platform | darwin |
| kernel | 27.2.0 |
| arch | arm64 |
| cpuModel | Apple M2 |
| logicalCpuCount | 8 |
| totalMemoryBytes | 17179869184 |
| python | python3 Python 3.15.2 |
| parentExecArgv |  |
| samplerMethod | darwin-libproc-proc_pidinfo |
| loadAverageAtStart | 1.724 / 1.877 / 1.882 |
| loadAverageAtEnd | 2.665 / 2.18 / 1.997 |

## 2. 复现命令

从仓库根目录执行：

```sh
node scripts/benchmarks/retention-plan-streaming.mjs --a dir:/tmp/dsh-stage-c1c2/lib --b worktree --runs ab --scales 10000,40000,80000 --samples 2 --rounds 2 --phases dryRun,write --out docs/performance/retention-plan-streaming-baseline.json --md docs/performance/retention-plan-streaming-baseline.md
```

本轮实际命令行（含本机绝对路径，仅作记录）：

```
/opt/homebrew/Cellar/node/26.13.0_2/bin/node /Users/ryukeili/GitHub/dsh-evolution/.agents/worktrees/perf/retention-plan-streaming/scripts/benchmarks/retention-plan-streaming.mjs --a dir:/tmp/dsh-stage-c1c2/lib --b worktree --runs ab --scales 10000,40000,80000 --samples 2 --rounds 2 --phases dryRun,write --out docs/performance/retention-plan-streaming-c3-ab.json --md docs/performance/retention-plan-streaming-c3-ab.md --note 本报告是纯 C3 边际：C1+C2 冻结快照（/tmp/dsh-stage-c1c2/lib）vs 最终树（C1–C3，C4 已撤回）。C4 含入时的历史边际测量见 docs/performance/retention-plan-streaming-c3c4-ab.{json,md}，仅供历史参考。
```

原始逐样本行、每格中位数与等价性哈希都在 `docs/performance/retention-plan-streaming-baseline.json`；本 Markdown 只汇总。

## 3. 口径与边界

- 测量范围：public EvolutionMemory compact({dryRun}) planning and compact() including durable archive rewrite/readback/index/state save; the template copy, load(), parent-side pre-compact hashing, snapshots and the optional second compact are outside the measured window. No official host transaction, fsync, multi-process work or startup #reconcileArchiveIndex timing.
- 协议：template-copy v2: the parent copies a pre-built on-disk session template into a private root per sample; the measured child only calls EvolutionMemory.load() on that small state file and then one compact(). The corpus JSON is never parsed inside a measured child, so the external start RSS is not inflated by the fixture representation. Template copy, load and the parent-side pre-compact hash are outside the go-to-END window. v1 (which parsed a 6-52 MB fixture JSON in the child) is superseded; its start RSS reached 155-553 MiB and hid the planning peak.
- 每个样本是独立子进程：父进程把模板目录复制到私有 root → 子进程 load lib → `EvolutionMemory.load()`（只读小 state.json 与归档索引）→ 两次 GC → 发 START 并阻塞等待父进程 go → 只执行一次 compact → 发 END。模板复制、`load()` 与父进程在 START 之后、go 之前对副本做的 pre-compact 哈希都不在 go→END 窗口内。进程外 RSS 采样由 `scripts/benchmarks/retention-rss-sampler.py` 完成（macOS `libproc.proc_pidinfo`，Linux `/proc/<pid>/statm`，默认 2 ms），采样峰值仍是下界，样本数与最大间隔随每个样本记录。
- 起始 RSS 是 START 之后、go 之前由采样器读到的第一个值：它包含 `load()` 对 active archive 做的恢复扫描留下的常驻页（那是 load 的契约，不属于 compact）。因此本报告同时给“外部采样峰值”“峰值−开始”两列；判断峰值内存回归时以绝对峰值为准，峰值−开始用于看 compact 期间的新增足迹。
- `maxRSS` 是进程历史高水位：它可能被 `load()` 的归档扫描建立的更高水位遮蔽，因此只作为下界报告，绝不当作单次调用的峰值；主峰值口径是外部采样。
- 外部采样（`darwin-libproc-proc_pidinfo`）读的是内核 resident 计数，它包含 V8 用 MADV_FREE_REUSABLE 标记过、尚未归还的页面；因此同一时刻它通常高于 `process.memoryUsage().rss`（后者不计这些页面）并接近 `resourceUsage().maxRSS`。所以本报告同时给绝对峰值与“峰值−阶段开始”的增量，不能把绝对峰值直接等同于单次调用新增的字节数。
- heapUsed 为 GC 后读数（`--expose-gc`）；`heapUsed 增量`是结束时读数减开始读数，不是总分配字节。
- 每个样本的 archive 前后字节、归档树文件数与 sha256 都记录在 JSON 原始行里；dryRun 要求状态与归档字节完全不变，write 阶段另做一次 compact 收敛检查（`--idempotency`）。
- external RSS peak is a sampling lower bound; a peak shorter than the sampling interval can be missed
- maxRSS delta can be masked by the load-time archive scan high-water mark and is never used as the per-call peak
- synthetic fixed-time corpus (deterministic clock) generated once by the baseline side; not production user data
- no official host domain transaction, fsync, multi-process contention or startup archive-index reconciliation is timed
- OS page cache is not flushed; each sample copies the template fresh (copy is outside the measured window) and A/B/B/A round rotation balances ordering effects
- knowledge groups fit the bounded sourceRefs window; canonical protects outcomes, not terminal promotions
- the external sampler reads a lower bound of resident bytes and does not attribute them to V8 heap vs. native buffers

## 4. 侧与模板

| 侧 | spec | 类型 | commit | lib tree sha256 |
| --- | --- | --- | --- | --- |
| dir-lib | `dir:/tmp/dsh-stage-c1c2/lib` | directory | — | `bad2a1ed6e6f46c7eee7f52d4bb8d3914898e0e5f53e58824030ad2e2028d101` |
| worktree | `worktree` | worktree | — | `a42399f511f3085333ab0900675c2a0375a3f5109e551d4042ba1a00f49a8599` |

treesIdentical（A 与 B 的 lib 树哈希相同，此时 A/B 也是 A/A 复制）：ab=false

模板 = `state.json`（canonical 指针 + 空 hot 集合）+ 每个 collection 一个 active archive 文件；由基线侧公开函数生成一次，每个样本由父进程复制。`state sha256` 是模板 state.json 的字节哈希，`archive sha256` 是归档树（文件名 + 每文件 sha256）的哈希。

| 规模（冷行） | 模板文件数 | 模板字节 | archive sha256 | state 字节 | state sha256 | observations | knowledge | cycles | outcomes | promotions | canonical |
| ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10000 | 5 | 5729370 | `8d96bd79d6f6e5e532451298660398d8922e97d43a5bd816c6dee42cfa8e5ee6` | 14493 | `cd0d2297258c907806985f45268d7f06bab34f6d686201fba8c3e9af44ece7bd` | 4000 | 2000 | 2000 | 1000 | 1000 | 63 |
| 40000 | 5 | 22967370 | `147a3f59e49071f865e52d79b1d6e4bd4e63475a68194140b84a62f3c8718521` | 58027 | `0e8b82993cbd93e5b3e15fbb3fc944902b6f2f78f408fdc4b5a0b17283e6e023` | 16000 | 8000 | 8000 | 4000 | 4000 | 250 |
| 80000 | 5 | 46005370 | `e5dded130f074ca2b1ae5b766bc71eef4633c4b4f13304f6eb01c9c370c7b63a` | 116277 | `fa398ca51eeb5fb2e2bfdf9b25d4bf4ee8a577836e52137aa56f34dffa524766` | 32000 | 16000 | 16000 | 8000 | 8000 | 500 |

## 5. 调度与测量窗口 loadavg

每个 (规模, 阶段) 内：2 轮，偶数轮 `[A,B]`，奇数轮 `[B,A]`；每侧每轮 `2` 个独立样本；AA 与 AB 两种 run 按轮交替先后。

每样本测量窗口的 1m loadavg：最小 1.666 / 中位 1.896 / 最大 3.251。1m 均值会吸收本基准自身的子进程 spawn 与 2 ms 外部采样进程，因此它不是外部负载的独立证据；同一 (规模, 阶段) 的 A/A 与 A/B 两侧按轮交替，噪声估计覆盖了这一漂移。

下表的 loadavg 是该 (规模, 阶段) 格开始/结束时的值（不是每轮值）；逐样本值在 JSON 的每一行里。

| run | 规模 | 阶段 | 轮 | order | 格起始 loadavg | 格结束 loadavg |
| --- | ---: | --- | ---: | --- | --- | --- |
| ab | 10000 | dryRun | 0 | dir-lib → worktree | 1.724 / 1.877 / 1.882 | 1.666 / 1.863 / 1.877 |
| ab | 10000 | dryRun | 1 | worktree → dir-lib | 1.724 / 1.877 / 1.882 | 1.666 / 1.863 / 1.877 |
| ab | 10000 | write | 0 | dir-lib → worktree | 1.666 / 1.863 / 1.877 | 1.772 / 1.881 / 1.883 |
| ab | 10000 | write | 1 | worktree → dir-lib | 1.666 / 1.863 / 1.877 | 1.772 / 1.881 / 1.883 |
| ab | 40000 | dryRun | 0 | dir-lib → worktree | 1.791 / 1.883 / 1.884 | 1.896 / 1.903 / 1.891 |
| ab | 40000 | dryRun | 1 | worktree → dir-lib | 1.791 / 1.883 / 1.884 | 1.896 / 1.903 / 1.891 |
| ab | 40000 | write | 0 | dir-lib → worktree | 1.896 / 1.903 / 1.891 | 2.214 / 1.973 / 1.916 |
| ab | 40000 | write | 1 | worktree → dir-lib | 1.896 / 1.903 / 1.891 | 2.214 / 1.973 / 1.916 |
| ab | 80000 | dryRun | 0 | dir-lib → worktree | 2.214 / 1.973 / 1.916 | 3.014 / 2.155 / 1.981 |
| ab | 80000 | dryRun | 1 | worktree → dir-lib | 2.214 / 1.973 / 1.916 | 3.014 / 2.155 / 1.981 |
| ab | 80000 | write | 0 | dir-lib → worktree | 3.014 / 2.155 / 1.981 | 2.665 / 2.18 / 1.997 |
| ab | 80000 | write | 1 | worktree → dir-lib | 3.014 / 2.155 / 1.981 | 2.665 / 2.18 / 1.997 |

## 6. 每格中位数

单位：时间 ms、内存 MiB（2^20 字节）、计数为个数。每格每侧 n = 轮数 × 每轮样本数。

### run=ab（dir-lib vs worktree）

#### 规模 10000 冷行

阶段：dryRun；每侧样本 n = 4。

| 指标 | dir-lib | worktree | Δ（worktree−dir-lib） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 266.58 | 274.14 | +7.56 | +2.84% |
| CPU user+system | 369.73 | 385.30 | +15.57 | +4.21% |
| CPU user | 360.16 | 374.25 | +14.08 | +3.91% |
| CPU system | 9.56 | 10.86 | +1.29 | +13.54% |
| 外部采样峰值 RSS | 123.91 | 134.09 | +10.17 | +8.21% |
| 外部采样开始 RSS | 70.61 | 69.34 | −1.27 | −1.80% |
| 外部采样峰值−开始 | 53.32 | 64.67 | +11.35 | +21.29% |
| compact 结束时 RSS（进程内） | 92.03 | 102.98 | +10.95 | +11.89% |
| maxRSS 前（历史高水位） | 72.03 | 70.93 | −1.10 | −1.53% |
| maxRSS 后（历史高水位） | 123.91 | 134.09 | +10.18 | +8.22% |
| maxRSS 增量（高水位下界） | 51.91 | 63.08 | +11.17 | +21.52% |
| GC 后 heapUsed（开始） | 7.34 | 7.35 | +0.01 | +0.10% |
| compact 结束时 heapUsed | 32.99 | 31.98 | −1.01 | −3.06% |
| compact 后 GC heapUsed | 15.64 | 15.68 | +0.03 | +0.22% |
| heapUsed 增量（结束−开始） | 25.64 | 24.63 | −1.02 | −3.96% |
| archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| archive 字节（后） | 5.47 | 5.47 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 133.50 | 137 | +3.50 | +2.62% |
| 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.14% |

阶段：write；每侧样本 n = 4。

| 指标 | dir-lib | worktree | Δ（worktree−dir-lib） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 394.44 | 395.38 | +0.94 | +0.24% |
| CPU user+system | 566.89 | 571.55 | +4.65 | +0.82% |
| CPU user | 532.34 | 536.57 | +4.23 | +0.79% |
| CPU system | 34.67 | 34.97 | +0.30 | +0.86% |
| 外部采样峰值 RSS | 207.41 | 208.32 | +0.91 | +0.44% |
| 外部采样开始 RSS | 70.56 | 69.84 | −0.72 | −1.02% |
| 外部采样峰值−开始 | 136.73 | 138.48 | +1.75 | +1.28% |
| compact 结束时 RSS（进程内） | 181.50 | 182.08 | +0.58 | +0.32% |
| maxRSS 前（历史高水位） | 71.98 | 71.11 | −0.87 | −1.20% |
| maxRSS 后（历史高水位） | 207.61 | 208.32 | +0.71 | +0.34% |
| maxRSS 增量（高水位下界） | 135.48 | 137.21 | +1.73 | +1.28% |
| GC 后 heapUsed（开始） | 7.34 | 7.35 | +0.01 | +0.10% |
| compact 结束时 heapUsed | 38.32 | 43.59 | +5.27 | +13.75% |
| compact 后 GC heapUsed | 15.57 | 15.62 | +0.05 | +0.30% |
| heapUsed 增量（结束−开始） | 30.98 | 36.24 | +5.26 | +16.98% |
| archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| archive 字节（后） | 5.76 | 5.76 | 0.00 | +0.00% |
| 归档树文件数（后） | 27 | 27 | 0.00 | +0.00% |
| 外部采样样本数 | 197.50 | 198 | +0.50 | +0.25% |
| 外部采样最大间隔 | 2.98 | 2.99 | +0.01 | +0.19% |

#### 规模 40000 冷行

阶段：dryRun；每侧样本 n = 4。

| 指标 | dir-lib | worktree | Δ（worktree−dir-lib） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 991.38 | 999.39 | +8.01 | +0.81% |
| CPU user+system | 1301.40 | 1337.88 | +36.48 | +2.80% |
| CPU user | 1274.12 | 1309.37 | +35.25 | +2.77% |
| CPU system | 26.12 | 29.20 | +3.07 | +11.77% |
| 外部采样峰值 RSS | 263.20 | 271.09 | +7.89 | +3.00% |
| 外部采样开始 RSS | 122.59 | 109.52 | −13.07 | −10.66% |
| 外部采样峰值−开始 | 140.91 | 157.11 | +16.20 | +11.50% |
| compact 结束时 RSS（进程内） | 239.34 | 247.74 | +8.40 | +3.51% |
| maxRSS 前（历史高水位） | 124.27 | 111.56 | −12.71 | −10.23% |
| maxRSS 后（历史高水位） | 263.20 | 271.09 | +7.88 | +2.99% |
| maxRSS 增量（高水位下界） | 138.94 | 155.20 | +16.26 | +11.70% |
| GC 后 heapUsed（开始） | 10.40 | 10.41 | +0.01 | +0.07% |
| compact 结束时 heapUsed | 72.62 | 81.98 | +9.36 | +12.89% |
| compact 后 GC heapUsed | 23.53 | 23.52 | −0.01 | −0.05% |
| heapUsed 增量（结束−开始） | 62.22 | 71.57 | +9.35 | +15.03% |
| archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| archive 字节（后） | 21.91 | 21.91 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 496 | 500 | +4 | +0.81% |
| 外部采样最大间隔 | 2.98 | 2.98 | −0.00 | −0.15% |

阶段：write；每侧样本 n = 4。

| 指标 | dir-lib | worktree | Δ（worktree−dir-lib） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 1433.67 | 1433.97 | +0.30 | +0.02% |
| CPU user+system | 2089.70 | 2083.13 | −6.57 | −0.31% |
| CPU user | 1998.73 | 1991.32 | −7.40 | −0.37% |
| CPU system | 90.97 | 92.25 | +1.27 | +1.40% |
| 外部采样峰值 RSS | 327.06 | 331.77 | +4.70 | +1.44% |
| 外部采样开始 RSS | 116.92 | 117.99 | +1.07 | +0.92% |
| 外部采样峰值−开始 | 213.48 | 213.62 | +0.14 | +0.07% |
| compact 结束时 RSS（进程内） | 304.93 | 308.87 | +3.94 | +1.29% |
| maxRSS 前（历史高水位） | 118.78 | 119.19 | +0.41 | +0.34% |
| maxRSS 后（历史高水位） | 327.06 | 331.77 | +4.70 | +1.44% |
| maxRSS 增量（高水位下界） | 211.62 | 212.51 | +0.89 | +0.42% |
| GC 后 heapUsed（开始） | 10.40 | 10.41 | +0.01 | +0.07% |
| compact 结束时 heapUsed | 72.32 | 65.74 | −6.59 | −9.11% |
| compact 后 GC heapUsed | 20.18 | 20.18 | +0.00 | +0.01% |
| heapUsed 增量（结束−开始） | 61.92 | 55.33 | −6.59 | −10.65% |
| archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| archive 字节（后） | 24.30 | 24.30 | 0.00 | +0.00% |
| 归档树文件数（后） | 103 | 103 | 0.00 | +0.00% |
| 外部采样样本数 | 717 | 717.50 | +0.50 | +0.07% |
| 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.16% |

#### 规模 80000 冷行

阶段：dryRun；每侧样本 n = 4。

| 指标 | dir-lib | worktree | Δ（worktree−dir-lib） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 1955.14 | 1954.52 | −0.62 | −0.03% |
| CPU user+system | 2428.78 | 2413.82 | −14.97 | −0.62% |
| CPU user | 2384.14 | 2368.90 | −15.25 | −0.64% |
| CPU system | 44.64 | 46.01 | +1.37 | +3.08% |
| 外部采样峰值 RSS | 363.27 | 359.55 | −3.73 | −1.03% |
| 外部采样开始 RSS | 156.38 | 148.05 | −8.32 | −5.32% |
| 外部采样峰值−开始 | 207.18 | 209.94 | +2.76 | +1.33% |
| compact 结束时 RSS（进程内） | 344.16 | 340.26 | −3.90 | −1.13% |
| maxRSS 前（历史高水位） | 157.14 | 148.77 | −8.38 | −5.33% |
| maxRSS 后（历史高水位） | 363.27 | 359.55 | −3.73 | −1.03% |
| maxRSS 增量（高水位下界） | 206.44 | 209.22 | +2.78 | +1.35% |
| GC 后 heapUsed（开始） | 14.44 | 14.44 | +0.01 | +0.05% |
| compact 结束时 heapUsed | 139.05 | 141.02 | +1.97 | +1.42% |
| compact 后 GC heapUsed | 33.24 | 33.28 | +0.04 | +0.11% |
| heapUsed 增量（结束−开始） | 124.61 | 126.58 | +1.97 | +1.58% |
| archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| archive 字节（后） | 43.88 | 43.88 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 978 | 977.50 | −0.50 | −0.05% |
| 外部采样最大间隔 | 2.98 | 2.98 | +0.01 | +0.19% |

阶段：write；每侧样本 n = 4。

| 指标 | dir-lib | worktree | Δ（worktree−dir-lib） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 2844.36 | 2835.83 | −8.53 | −0.30% |
| CPU user+system | 4214.70 | 4084.88 | −129.82 | −3.08% |
| CPU user | 4049.58 | 3921.57 | −128.01 | −3.16% |
| CPU system | 165.12 | 162.15 | −2.97 | −1.80% |
| 外部采样峰值 RSS | 486.86 | 497.69 | +10.83 | +2.22% |
| 外部采样开始 RSS | 156.27 | 151.09 | −5.17 | −3.31% |
| 外部采样峰值−开始 | 335.78 | 345.12 | +9.34 | +2.78% |
| compact 结束时 RSS（进程内） | 467.48 | 476.48 | +9.00 | +1.93% |
| maxRSS 前（历史高水位） | 157.05 | 151.80 | −5.24 | −3.34% |
| maxRSS 后（历史高水位） | 486.86 | 497.71 | +10.85 | +2.23% |
| maxRSS 增量（高水位下界） | 334.96 | 344.59 | +9.63 | +2.88% |
| GC 后 heapUsed（开始） | 14.44 | 14.44 | +0.01 | +0.05% |
| compact 结束时 heapUsed | 139.24 | 97.88 | −41.36 | −29.71% |
| compact 后 GC heapUsed | 26.60 | 26.69 | +0.09 | +0.34% |
| heapUsed 增量（结束−开始） | 124.80 | 83.43 | −41.37 | −33.15% |
| archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| archive 字节（后） | 49.07 | 49.07 | 0.00 | +0.00% |
| 归档树文件数（后） | 201 | 201 | 0.00 | +0.00% |
| 外部采样样本数 | 1422.50 | 1418 | −4.50 | −0.32% |
| 外部采样最大间隔 | 2.99 | 2.99 | +0.00 | +0.17% |

### 测量敏感性自检（dryRun，模板协议）

自检目标：证实外部采样确实观察到了规划阶段，而不是只观察 setup 高水位。`峰值−开始` 必须与 `heapUsed 增量` 同量级（比值在 0.2–5），且两者随规模单调上升。

| 规模 | 起始 RSS（MiB） | 外部峰值（MiB） | 峰值−开始（MiB） | heapUsed 增量（MiB） | 比值（峰值−开始）/heapUsed | 外部采样数 | 最大间隔（ms） |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10000 | 70.61 | 123.91 | 53.32 | 25.64 | 2.08 | 133.5 | 2.98 |
| 40000 | 122.59 | 263.20 | 140.91 | 62.22 | 2.26 | 496 | 2.98 |
| 80000 | 156.38 | 363.27 | 207.18 | 124.61 | 1.66 | 978 | 2.98 |

- 峰值−开始单调上升（按规模）：PASS；heapUsed 增量单调上升：PASS；每格比值在 0.2–5：PASS。

## 7. 报告摘要

每格报告在所有样本中完全一致时（见第 8 节等价性），取第一行代表：

| run | 规模 | 阶段 | retired | consolidated | aggregatedObservations | tombstones | canonical | knowledgeBefore→After | beforeBytes→afterBytes |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| ab | 10000 | dryRun | 1937 | 5250 | 1 | 2 | 63 | 2000→2500 | 5729370→5729370 |
| ab | 10000 | write | 1937 | 5250 | 1 | 2 | 63 | 2000→2500 | 5729370→6025071 |
| ab | 40000 | dryRun | 7750 | 21000 | 1 | 2 | 250 | 8000→10000 | 22967370→22967370 |
| ab | 40000 | write | 7750 | 21000 | 1 | 2 | 250 | 8000→10000 | 22967370→25431860 |
| ab | 80000 | dryRun | 15500 | 42000 | 1 | 2 | 500 | 16000→20000 | 46005370→46005370 |
| ab | 80000 | write | 15500 | 42000 | 1 | 2 | 500 | 16000→20000 | 46005370→51352213 |

## 8. 等价性与固定点断言

| run | 规模 | 阶段 | report sha | state sha | archive before sha | archive after sha | 二次 compact report sha | dryRun 零写入 | 二次 compact 收敛 | 结论 |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| ab | 10000 | dryRun | 1 | 1 | 1 | 1 | 0 | true | — | PASS |
| ab | 10000 | write | 1 | 1 | 1 | 1 | 1 | — | true | PASS |
| ab | 40000 | dryRun | 1 | 1 | 1 | 1 | 0 | true | — | PASS |
| ab | 40000 | write | 1 | 1 | 1 | 1 | 1 | — | true | PASS |
| ab | 80000 | dryRun | 1 | 1 | 1 | 1 | 0 | true | — | PASS |
| ab | 80000 | write | 1 | 1 | 1 | 1 | 1 | — | true | PASS |

## 9. A/A 噪声

本次未运行 A/A（`--runs` 不含 aa）。

## 10. 候选显著性判定

阈值（Lead 指定，依据同协议 A/A 基线噪声）：wall |Δ%| > 2%、CPU user+system |Δ%| > 2%、外部采样峰值 RSS |Δ%| > 2.2% 视为超出噪声。同时检查每轮中位数差值的符号是否一致：符号在轮间翻转的差异判为不稳定。

| run | 规模 | 阶段 | wall Δ% | CPU Δ% | 外部峰值 Δ% | 峰值−start Δ% | 轮间符号不一致 | 判定 |
| --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- |
| ab | 10000 | dryRun | +2.84% | +4.21% | +8.21% | +21.29% | 无 | 显著（wall +2.84%、CPU +4.21%、外部峰值 +8.21%） |
| ab | 10000 | write | +0.24% | +0.82% | +0.44% | +1.28% | wall、外部采样峰值 RSS | 未超出噪声阈值 |
| ab | 40000 | dryRun | +0.81% | +2.80% | +3.00% | +11.50% | 外部采样峰值 RSS | 显著（CPU +2.80%） |
| ab | 40000 | write | +0.02% | −0.31% | +1.44% | +0.07% | wall、CPU user+system | 未超出噪声阈值 |
| ab | 80000 | dryRun | −0.03% | −0.62% | −1.03% | +1.33% | wall | 未超出噪声阈值 |
| ab | 80000 | write | −0.30% | −3.08% | +2.22% | +2.78% | 外部采样峰值 RSS | 显著（CPU −3.08%） |

## 11. 未测量项与限制

- external RSS peak is a sampling lower bound; a peak shorter than the sampling interval can be missed
- maxRSS delta can be masked by the load-time archive scan high-water mark and is never used as the per-call peak
- synthetic fixed-time corpus (deterministic clock) generated once by the baseline side; not production user data
- no official host domain transaction, fsync, multi-process contention or startup archive-index reconciliation is timed
- OS page cache is not flushed; each sample copies the template fresh (copy is outside the measured window) and A/B/B/A round rotation balances ordering effects
- knowledge groups fit the bounded sourceRefs window; canonical protects outcomes, not terminal promotions
- the external sampler reads a lower bound of resident bytes and does not attribute them to V8 heap vs. native buffers
- 未测量项：per-3ms RSS trace is not persisted (only peak/baseline/delta/count/max gap are recorded)；native (malloc/mmap) vs. V8 heap attribution of the external RSS peak；write-phase OS peak under a pinned heap (unless --pinned-heap is passed)

