# retention/compact 进程外采样基线（A/A 与 A/B）

生成时间：2026-11-06T14:38:53.444Z；总耗时 100.1 s。

本文件由 `scripts/benchmarks/retention-plan-streaming.mjs` 从同一份 JSON 自动生成；所有数值都是本轮实际测量，未引用历史数字。

## 0. 本轮用途

本轮只运行 A/B（`--runs` 不含 aa），两侧是不同代码树；本文件**没有本轮内的 A/A 噪声**。显著性判定采用同一协议、同一机器基线 `docs/performance/retention-plan-streaming-baseline.md` 第 9 节的 A/A 噪声作为参考下界（见第 10 节）。

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
| loadAverageAtStart | 2.087 / 1.9 / 1.792 |
| loadAverageAtEnd | 1.98 / 1.935 / 1.817 |

## 2. 复现命令

从仓库根目录执行：

```sh
node scripts/benchmarks/retention-plan-streaming.mjs --a dir:/tmp/dsh-stage-c1c2/lib --b worktree --runs ab --scales 10000,40000,80000 --samples 2 --rounds 2 --phases dryRun,write --out docs/performance/retention-plan-streaming-baseline.json --md docs/performance/retention-plan-streaming-baseline.md
```

本轮实际命令行（含本机绝对路径，仅作记录）：

```
/opt/homebrew/Cellar/node/26.13.0_2/bin/node /Users/ryukeili/GitHub/dsh-evolution/.agents/worktrees/perf/retention-plan-streaming/scripts/benchmarks/retention-plan-streaming.mjs --a dir:/tmp/dsh-stage-c1c2/lib --b worktree --runs ab --scales 10000,40000,80000 --samples 2 --rounds 2 --phases dryRun,write --out docs/performance/retention-plan-streaming-c3c4-ab.json --md docs/performance/retention-plan-streaming-c3c4-ab.md
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
| worktree | `worktree` | worktree | — | `2948ae49705ae9d66654f6be64b4a867d23e0b0e658cdfd2cb9c54dde33726bc` |

treesIdentical（A 与 B 的 lib 树哈希相同，此时 A/B 也是 A/A 复制）：ab=false

模板 = `state.json`（canonical 指针 + 空 hot 集合）+ 每个 collection 一个 active archive 文件；由基线侧公开函数生成一次，每个样本由父进程复制。`state sha256` 是模板 state.json 的字节哈希，`archive sha256` 是归档树（文件名 + 每文件 sha256）的哈希。

| 规模（冷行） | 模板文件数 | 模板字节 | archive sha256 | state 字节 | state sha256 | observations | knowledge | cycles | outcomes | promotions | canonical |
| ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10000 | 5 | 5729370 | `8d96bd79d6f6e5e532451298660398d8922e97d43a5bd816c6dee42cfa8e5ee6` | 14493 | `cd0d2297258c907806985f45268d7f06bab34f6d686201fba8c3e9af44ece7bd` | 4000 | 2000 | 2000 | 1000 | 1000 | 63 |
| 40000 | 5 | 22967370 | `147a3f59e49071f865e52d79b1d6e4bd4e63475a68194140b84a62f3c8718521` | 58027 | `0e8b82993cbd93e5b3e15fbb3fc944902b6f2f78f408fdc4b5a0b17283e6e023` | 16000 | 8000 | 8000 | 4000 | 4000 | 250 |
| 80000 | 5 | 46005370 | `e5dded130f074ca2b1ae5b766bc71eef4633c4b4f13304f6eb01c9c370c7b63a` | 116277 | `fa398ca51eeb5fb2e2bfdf9b25d4bf4ee8a577836e52137aa56f34dffa524766` | 32000 | 16000 | 16000 | 8000 | 8000 | 500 |

## 5. 调度与测量窗口 loadavg

每个 (规模, 阶段) 内：2 轮，偶数轮 `[A,B]`，奇数轮 `[B,A]`；每侧每轮 `2` 个独立样本；AA 与 AB 两种 run 按轮交替先后。

每样本测量窗口的 1m loadavg：最小 1.979 / 中位 2.080 / 最大 2.287。1m 均值会吸收本基准自身的子进程 spawn 与 2 ms 外部采样进程，因此它不是外部负载的独立证据；同一 (规模, 阶段) 的 A/A 与 A/B 两侧按轮交替，噪声估计覆盖了这一漂移。

下表的 loadavg 是该 (规模, 阶段) 格开始/结束时的值（不是每轮值）；逐样本值在 JSON 的每一行里。

| run | 规模 | 阶段 | 轮 | order | 格起始 loadavg | 格结束 loadavg |
| --- | ---: | --- | ---: | --- | --- | --- |
| ab | 10000 | dryRun | 0 | dir-lib → worktree | 2.087 / 1.9 / 1.792 | 2.08 / 1.901 / 1.792 |
| ab | 10000 | dryRun | 1 | worktree → dir-lib | 2.087 / 1.9 / 1.792 | 2.08 / 1.901 / 1.792 |
| ab | 10000 | write | 0 | dir-lib → worktree | 2.08 / 1.901 / 1.792 | 2.073 / 1.903 / 1.793 |
| ab | 10000 | write | 1 | worktree → dir-lib | 2.08 / 1.901 / 1.792 | 2.073 / 1.903 / 1.793 |
| ab | 40000 | dryRun | 0 | dir-lib → worktree | 2.073 / 1.903 / 1.793 | 2.062 / 1.906 / 1.795 |
| ab | 40000 | dryRun | 1 | worktree → dir-lib | 2.073 / 1.903 / 1.793 | 2.062 / 1.906 / 1.795 |
| ab | 40000 | write | 0 | dir-lib → worktree | 2.062 / 1.906 / 1.795 | 2.264 / 1.96 / 1.817 |
| ab | 40000 | write | 1 | worktree → dir-lib | 2.062 / 1.906 / 1.795 | 2.264 / 1.96 / 1.817 |
| ab | 80000 | dryRun | 0 | dir-lib → worktree | 2.264 / 1.96 / 1.817 | 2.037 / 1.93 / 1.81 |
| ab | 80000 | dryRun | 1 | worktree → dir-lib | 2.264 / 1.96 / 1.817 | 2.037 / 1.93 / 1.81 |
| ab | 80000 | write | 0 | dir-lib → worktree | 2.037 / 1.93 / 1.81 | 1.98 / 1.935 / 1.817 |
| ab | 80000 | write | 1 | worktree → dir-lib | 2.037 / 1.93 / 1.81 | 1.98 / 1.935 / 1.817 |

## 6. 每格中位数

单位：时间 ms、内存 MiB（2^20 字节）、计数为个数。每格每侧 n = 轮数 × 每轮样本数。

### run=ab（dir-lib vs worktree）

#### 规模 10000 冷行

阶段：dryRun；每侧样本 n = 4。

| 指标 | dir-lib | worktree | Δ（worktree−dir-lib） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 265.42 | 274.78 | +9.36 | +3.53% |
| CPU user+system | 368.45 | 386.78 | +18.33 | +4.97% |
| CPU user | 359.16 | 376.25 | +17.08 | +4.76% |
| CPU system | 9.30 | 10.49 | +1.19 | +12.83% |
| 外部采样峰值 RSS | 124.05 | 134.23 | +10.18 | +8.21% |
| 外部采样开始 RSS | 70.84 | 69.36 | −1.48 | −2.10% |
| 外部采样峰值−开始 | 53.37 | 64.83 | +11.46 | +21.48% |
| compact 结束时 RSS（进程内） | 92.25 | 103.36 | +11.10 | +12.04% |
| maxRSS 前（历史高水位） | 72.27 | 70.88 | −1.38 | −1.91% |
| maxRSS 后（历史高水位） | 124.05 | 134.23 | +10.18 | +8.21% |
| maxRSS 增量（高水位下界） | 52.02 | 63.32 | +11.30 | +21.71% |
| GC 后 heapUsed（开始） | 7.34 | 7.34 | +0.01 | +0.12% |
| compact 结束时 heapUsed | 32.54 | 32.02 | −0.52 | −1.61% |
| compact 后 GC heapUsed | 15.64 | 15.67 | +0.03 | +0.19% |
| heapUsed 增量（结束−开始） | 25.20 | 24.67 | −0.53 | −2.11% |
| archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| archive 字节（后） | 5.47 | 5.47 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 133 | 137.50 | +4.50 | +3.38% |
| 外部采样最大间隔 | 2.98 | 2.98 | +0.01 | +0.26% |

阶段：write；每侧样本 n = 4。

| 指标 | dir-lib | worktree | Δ（worktree−dir-lib） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 392.15 | 401.58 | +9.42 | +2.40% |
| CPU user+system | 563.48 | 575.08 | +11.61 | +2.06% |
| CPU user | 529.46 | 540.55 | +11.10 | +2.10% |
| CPU system | 34.19 | 34.71 | +0.52 | +1.51% |
| 外部采样峰值 RSS | 207.33 | 211.01 | +3.68 | +1.77% |
| 外部采样开始 RSS | 70.75 | 69.76 | −0.99 | −1.40% |
| 外部采样峰值−开始 | 136.69 | 141.24 | +4.55 | +3.33% |
| compact 结束时 RSS（进程内） | 181.00 | 185.37 | +4.37 | +2.41% |
| maxRSS 前（历史高水位） | 72.11 | 71.12 | −0.99 | −1.38% |
| maxRSS 后（历史高水位） | 207.43 | 211.01 | +3.58 | +1.72% |
| maxRSS 增量（高水位下界） | 135.39 | 139.85 | +4.46 | +3.29% |
| GC 后 heapUsed（开始） | 7.34 | 7.34 | +0.01 | +0.12% |
| compact 结束时 heapUsed | 37.84 | 37.27 | −0.57 | −1.50% |
| compact 后 GC heapUsed | 15.56 | 15.60 | +0.04 | +0.25% |
| heapUsed 增量（结束−开始） | 30.50 | 29.92 | −0.58 | −1.89% |
| archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| archive 字节（后） | 5.76 | 5.76 | 0.00 | +0.00% |
| 归档树文件数（后） | 27 | 27 | 0.00 | +0.00% |
| 外部采样样本数 | 196.50 | 201 | +4.50 | +2.29% |
| 外部采样最大间隔 | 2.97 | 2.98 | +0.01 | +0.28% |

#### 规模 40000 冷行

阶段：dryRun；每侧样本 n = 4。

| 指标 | dir-lib | worktree | Δ（worktree−dir-lib） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 990.68 | 992.25 | +1.57 | +0.16% |
| CPU user+system | 1294.51 | 1306.81 | +12.30 | +0.95% |
| CPU user | 1268.54 | 1279.21 | +10.67 | +0.84% |
| CPU system | 26.11 | 28.99 | +2.88 | +11.02% |
| 外部采样峰值 RSS | 258.45 | 272.86 | +14.41 | +5.58% |
| 外部采样开始 RSS | 116.16 | 108.37 | −7.80 | −6.71% |
| 外部采样峰值−开始 | 142.28 | 163.13 | +20.85 | +14.66% |
| compact 结束时 RSS（进程内） | 234.37 | 249.76 | +15.38 | +6.56% |
| maxRSS 前（历史高水位） | 118.58 | 109.63 | −8.95 | −7.54% |
| maxRSS 后（历史高水位） | 258.45 | 272.86 | +14.41 | +5.58% |
| maxRSS 增量（高水位下界） | 139.87 | 161.77 | +21.91 | +15.66% |
| GC 后 heapUsed（开始） | 10.40 | 10.41 | +0.01 | +0.09% |
| compact 结束时 heapUsed | 82.36 | 86.17 | +3.81 | +4.63% |
| compact 后 GC heapUsed | 23.55 | 23.51 | −0.04 | −0.15% |
| heapUsed 增量（结束−开始） | 71.97 | 75.77 | +3.80 | +5.29% |
| archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| archive 字节（后） | 21.91 | 21.91 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 495.50 | 496.50 | +1 | +0.20% |
| 外部采样最大间隔 | 2.98 | 2.97 | −0.01 | −0.19% |

阶段：write；每侧样本 n = 4。

| 指标 | dir-lib | worktree | Δ（worktree−dir-lib） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 1439.45 | 1442.34 | +2.89 | +0.20% |
| CPU user+system | 2085.60 | 2087.54 | +1.93 | +0.09% |
| CPU user | 1996.53 | 1994.08 | −2.45 | −0.12% |
| CPU system | 89.07 | 90.89 | +1.81 | +2.04% |
| 外部采样峰值 RSS | 334.79 | 333.77 | −1.02 | −0.31% |
| 外部采样开始 RSS | 122.59 | 103.33 | −19.26 | −15.71% |
| 外部采样峰值−开始 | 212.20 | 230.44 | +18.23 | +8.59% |
| compact 结束时 RSS（进程内） | 312.07 | 310.54 | −1.53 | −0.49% |
| maxRSS 前（历史高水位） | 124.34 | 104.52 | −19.81 | −15.93% |
| maxRSS 后（历史高水位） | 334.81 | 333.80 | −1.02 | −0.30% |
| maxRSS 增量（高水位下界） | 210.48 | 229.27 | +18.80 | +8.93% |
| GC 后 heapUsed（开始） | 10.40 | 10.41 | +0.01 | +0.08% |
| compact 结束时 heapUsed | 72.17 | 66.62 | −5.55 | −7.69% |
| compact 后 GC heapUsed | 20.17 | 20.18 | +0.01 | +0.04% |
| heapUsed 增量（结束−开始） | 61.77 | 56.22 | −5.56 | −8.99% |
| archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| archive 字节（后） | 24.30 | 24.30 | 0.00 | +0.00% |
| 归档树文件数（后） | 103 | 103 | 0.00 | +0.00% |
| 外部采样样本数 | 719.50 | 721.50 | +2 | +0.28% |
| 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.09% |

#### 规模 80000 冷行

阶段：dryRun；每侧样本 n = 4。

| 指标 | dir-lib | worktree | Δ（worktree−dir-lib） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 1949.75 | 1959.03 | +9.27 | +0.48% |
| CPU user+system | 2413.54 | 2406.74 | −6.80 | −0.28% |
| CPU user | 2364.40 | 2361.49 | −2.91 | −0.12% |
| CPU system | 46.02 | 44.67 | −1.36 | −2.95% |
| 外部采样峰值 RSS | 361.60 | 358.34 | −3.27 | −0.90% |
| 外部采样开始 RSS | 155.87 | 150.83 | −5.04 | −3.23% |
| 外部采样峰值−开始 | 210.19 | 209.34 | −0.85 | −0.41% |
| compact 结束时 RSS（进程内） | 342.52 | 339.07 | −3.45 | −1.01% |
| maxRSS 前（历史高水位） | 156.66 | 151.65 | −5.02 | −3.20% |
| maxRSS 后（历史高水位） | 361.61 | 358.34 | −3.27 | −0.91% |
| maxRSS 增量（高水位下界） | 209.39 | 208.61 | −0.78 | −0.37% |
| GC 后 heapUsed（开始） | 14.43 | 14.44 | +0.01 | +0.06% |
| compact 结束时 heapUsed | 130.17 | 140.93 | +10.76 | +8.27% |
| compact 后 GC heapUsed | 33.27 | 33.25 | −0.02 | −0.05% |
| heapUsed 增量（结束−开始） | 115.74 | 126.49 | +10.75 | +9.29% |
| archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| archive 字节（后） | 43.88 | 43.88 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 975 | 980 | +5 | +0.51% |
| 外部采样最大间隔 | 2.98 | 2.98 | −0.00 | −0.07% |

阶段：write；每侧样本 n = 4。

| 指标 | dir-lib | worktree | Δ（worktree−dir-lib） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 2877.94 | 2820.72 | −57.23 | −1.99% |
| CPU user+system | 4293.51 | 4048.88 | −244.63 | −5.70% |
| CPU user | 4128.45 | 3888.55 | −239.90 | −5.81% |
| CPU system | 167.15 | 160.69 | −6.46 | −3.86% |
| 外部采样峰值 RSS | 509.31 | 484.66 | −24.66 | −4.84% |
| 外部采样开始 RSS | 155.82 | 149.12 | −6.70 | −4.30% |
| 外部采样峰值−开始 | 349.60 | 333.05 | −16.55 | −4.74% |
| compact 结束时 RSS（进程内） | 489.45 | 463.67 | −25.78 | −5.27% |
| maxRSS 前（历史高水位） | 156.62 | 149.94 | −6.68 | −4.26% |
| maxRSS 后（历史高水位） | 509.31 | 484.66 | −24.66 | −4.84% |
| maxRSS 增量（高水位下界） | 348.87 | 332.13 | −16.74 | −4.80% |
| GC 后 heapUsed（开始） | 14.43 | 14.44 | +0.01 | +0.06% |
| compact 结束时 heapUsed | 134.04 | 101.61 | −32.43 | −24.19% |
| compact 后 GC heapUsed | 26.60 | 26.68 | +0.08 | +0.29% |
| heapUsed 增量（结束−开始） | 119.61 | 87.17 | −32.44 | −27.12% |
| archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| archive 字节（后） | 49.07 | 49.07 | 0.00 | +0.00% |
| 归档树文件数（后） | 201 | 201 | 0.00 | +0.00% |
| 外部采样样本数 | 1439 | 1410.50 | −28.50 | −1.98% |
| 外部采样最大间隔 | 2.98 | 2.99 | +0.01 | +0.24% |

### 测量敏感性自检（dryRun，模板协议）

自检目标：证实外部采样确实观察到了规划阶段，而不是只观察 setup 高水位。`峰值−开始` 必须与 `heapUsed 增量` 同量级（比值在 0.2–5），且两者随规模单调上升。

| 规模 | 起始 RSS（MiB） | 外部峰值（MiB） | 峰值−开始（MiB） | heapUsed 增量（MiB） | 比值（峰值−开始）/heapUsed | 外部采样数 | 最大间隔（ms） |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10000 | 70.84 | 124.05 | 53.37 | 25.20 | 2.12 | 133 | 2.98 |
| 40000 | 116.16 | 258.45 | 142.28 | 71.97 | 1.98 | 495.5 | 2.98 |
| 80000 | 155.87 | 361.60 | 210.19 | 115.74 | 1.82 | 975 | 2.98 |

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
| ab | 10000 | dryRun | +3.53% | +4.97% | +8.21% | +21.48% | 无 | 显著（wall +3.53%、CPU +4.97%、外部峰值 +8.21%） |
| ab | 10000 | write | +2.40% | +2.06% | +1.77% | +3.33% | 无 | 显著（wall +2.40%、CPU +2.06%） |
| ab | 40000 | dryRun | +0.16% | +0.95% | +5.58% | +14.66% | wall | 显著（外部峰值 +5.58%） |
| ab | 40000 | write | +0.20% | +0.09% | −0.31% | +8.59% | wall、CPU user+system | 未超出噪声阈值 |
| ab | 80000 | dryRun | +0.48% | −0.28% | −0.90% | −0.41% | wall、CPU user+system | 未超出噪声阈值 |
| ab | 80000 | write | −1.99% | −5.70% | −4.84% | −4.74% | 无 | 显著（CPU −5.70%、外部峰值 −4.84%） |

## 11. 未测量项与限制

- external RSS peak is a sampling lower bound; a peak shorter than the sampling interval can be missed
- maxRSS delta can be masked by the load-time archive scan high-water mark and is never used as the per-call peak
- synthetic fixed-time corpus (deterministic clock) generated once by the baseline side; not production user data
- no official host domain transaction, fsync, multi-process contention or startup archive-index reconciliation is timed
- OS page cache is not flushed; each sample copies the template fresh (copy is outside the measured window) and A/B/B/A round rotation balances ordering effects
- knowledge groups fit the bounded sourceRefs window; canonical protects outcomes, not terminal promotions
- the external sampler reads a lower bound of resident bytes and does not attribute them to V8 heap vs. native buffers
- 未测量项：per-3ms RSS trace is not persisted (only peak/baseline/delta/count/max gap are recorded)；native (malloc/mmap) vs. V8 heap attribution of the external RSS peak；write-phase OS peak under a pinned heap (unless --pinned-heap is passed)

