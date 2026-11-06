# retention/compact 进程外采样基线（A/A 与 A/B）

生成时间：2026-11-06T14:17:26.356Z；总耗时 315.3 s。

本文件由 `scripts/benchmarks/retention-plan-streaming.mjs` 从同一份 JSON 自动生成；所有数值都是本轮实际测量，未引用历史数字。

## 0. 本轮用途

本轮所有 run 的两侧都解析为同一棵冻结的 lib 树（treeSha256 相同）：run=aa 的两侧是同一 ref 的两次独立解出，run=ab 同样只是第二次独立的 A/A 复制。因此**本文件只是基线与噪声，不含任何候选实现对比**；候选 A/B 将用同一脚本 `--b worktree`（或 `--b git:<ref>`）重跑并写到另一个文件（例如 `docs/performance/retention-plan-streaming-ab-<ref>.json`），不会覆盖本基线。第 9 节的 A/A 噪声就是判断候选差异是否超出噪声的下界。

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
| loadAverageAtStart | 1.809 / 1.806 / 1.81 |
| loadAverageAtEnd | 2.007 / 2.151 / 1.981 |

## 2. 复现命令

从仓库根目录执行：

```sh
node scripts/benchmarks/retention-plan-streaming.mjs --a git:origin/main --b git:origin/main --runs aa,ab --scales 10000,40000,80000 --samples 3 --rounds 2 --phases dryRun,write --out docs/performance/retention-plan-streaming-baseline.json --md docs/performance/retention-plan-streaming-baseline.md
```

本轮实际命令行（含本机绝对路径，仅作记录）：

```
/opt/homebrew/Cellar/node/26.13.0_2/bin/node /Users/ryukeili/GitHub/dsh-evolution/.agents/worktrees/perf/retention-plan-streaming/scripts/benchmarks/retention-plan-streaming.mjs --a git:origin/main --b git:origin/main --runs aa,ab --scales 10000,40000,80000 --samples 3 --rounds 2 --phases dryRun,write --out docs/performance/retention-plan-streaming-baseline.json --md docs/performance/retention-plan-streaming-baseline.md
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
| origin-main | `git:origin/main` | git | a1db591565110044d628de3027ca5e6c7affa6c2 | `70812c426da7a9511d3e02bcf51e0e9703c1515713e4fb509c1cf9102a3ee988` |
| origin-main#b | `git:origin/main` | git | a1db591565110044d628de3027ca5e6c7affa6c2 | `70812c426da7a9511d3e02bcf51e0e9703c1515713e4fb509c1cf9102a3ee988` |

treesIdentical（A 与 B 的 lib 树哈希相同，此时 A/B 也是 A/A 复制）：aa=true，ab=true

模板 = `state.json`（canonical 指针 + 空 hot 集合）+ 每个 collection 一个 active archive 文件；由基线侧公开函数生成一次，每个样本由父进程复制。`state sha256` 是模板 state.json 的字节哈希，`archive sha256` 是归档树（文件名 + 每文件 sha256）的哈希。

| 规模（冷行） | 模板文件数 | 模板字节 | archive sha256 | state 字节 | state sha256 | observations | knowledge | cycles | outcomes | promotions | canonical |
| ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10000 | 5 | 5729370 | `8d96bd79d6f6e5e532451298660398d8922e97d43a5bd816c6dee42cfa8e5ee6` | 14493 | `cd0d2297258c907806985f45268d7f06bab34f6d686201fba8c3e9af44ece7bd` | 4000 | 2000 | 2000 | 1000 | 1000 | 63 |
| 40000 | 5 | 22967370 | `147a3f59e49071f865e52d79b1d6e4bd4e63475a68194140b84a62f3c8718521` | 58027 | `0e8b82993cbd93e5b3e15fbb3fc944902b6f2f78f408fdc4b5a0b17283e6e023` | 16000 | 8000 | 8000 | 4000 | 4000 | 250 |
| 80000 | 5 | 46005370 | `e5dded130f074ca2b1ae5b766bc71eef4633c4b4f13304f6eb01c9c370c7b63a` | 116277 | `fa398ca51eeb5fb2e2bfdf9b25d4bf4ee8a577836e52137aa56f34dffa524766` | 32000 | 16000 | 16000 | 8000 | 8000 | 500 |

## 5. 调度与测量窗口 loadavg

每个 (规模, 阶段) 内：2 轮，偶数轮 `[A,B]`，奇数轮 `[B,A]`；每侧每轮 `3` 个独立样本；AA 与 AB 两种 run 按轮交替先后。

每样本测量窗口的 1m loadavg：最小 1.563 / 中位 2.113 / 最大 3.312。1m 均值会吸收本基准自身的子进程 spawn 与 2 ms 外部采样进程，因此它不是外部负载的独立证据；同一 (规模, 阶段) 的 A/A 与 A/B 两侧按轮交替，噪声估计覆盖了这一漂移。

下表的 loadavg 是该 (规模, 阶段) 格开始/结束时的值（不是每轮值）；逐样本值在 JSON 的每一行里。

| run | 规模 | 阶段 | 轮 | order | 格起始 loadavg | 格结束 loadavg |
| --- | ---: | --- | ---: | --- | --- | --- |
| aa | 10000 | dryRun | 0 | origin-main#1 → origin-main#2 | 1.809 / 1.806 / 1.81 | 1.684 / 1.779 / 1.8 |
| aa | 10000 | dryRun | 1 | origin-main#2 → origin-main#1 | 1.809 / 1.806 / 1.81 | 1.684 / 1.779 / 1.8 |
| aa | 10000 | write | 0 | origin-main#1 → origin-main#2 | 1.684 / 1.779 / 1.8 | 1.563 / 1.744 / 1.786 |
| aa | 10000 | write | 1 | origin-main#2 → origin-main#1 | 1.684 / 1.779 / 1.8 | 1.563 / 1.744 / 1.786 |
| aa | 40000 | dryRun | 0 | origin-main#1 → origin-main#2 | 1.563 / 1.744 / 1.786 | 2.18 / 1.882 / 1.835 |
| aa | 40000 | dryRun | 1 | origin-main#2 → origin-main#1 | 1.563 / 1.744 / 1.786 | 2.18 / 1.882 / 1.835 |
| aa | 40000 | write | 0 | origin-main#1 → origin-main#2 | 2.18 / 1.882 / 1.835 | 2.783 / 2.113 / 1.921 |
| aa | 40000 | write | 1 | origin-main#2 → origin-main#1 | 2.18 / 1.882 / 1.835 | 2.783 / 2.113 / 1.921 |
| aa | 80000 | dryRun | 0 | origin-main#1 → origin-main#2 | 2.72 / 2.111 / 1.921 | 2.836 / 2.252 / 1.987 |
| aa | 80000 | dryRun | 1 | origin-main#2 → origin-main#1 | 2.72 / 2.111 / 1.921 | 2.836 / 2.252 / 1.987 |
| aa | 80000 | write | 0 | origin-main#1 → origin-main#2 | 2.836 / 2.252 / 1.987 | 2.007 / 2.151 / 1.981 |
| aa | 80000 | write | 1 | origin-main#2 → origin-main#1 | 2.836 / 2.252 / 1.987 | 2.007 / 2.151 / 1.981 |
| ab | 10000 | dryRun | 0 | origin-main → origin-main#b | 1.809 / 1.806 / 1.81 | 1.684 / 1.779 / 1.8 |
| ab | 10000 | dryRun | 1 | origin-main#b → origin-main | 1.809 / 1.806 / 1.81 | 1.684 / 1.779 / 1.8 |
| ab | 10000 | write | 0 | origin-main → origin-main#b | 1.684 / 1.779 / 1.8 | 1.563 / 1.744 / 1.786 |
| ab | 10000 | write | 1 | origin-main#b → origin-main | 1.684 / 1.779 / 1.8 | 1.563 / 1.744 / 1.786 |
| ab | 40000 | dryRun | 0 | origin-main → origin-main#b | 1.563 / 1.744 / 1.786 | 2.18 / 1.882 / 1.835 |
| ab | 40000 | dryRun | 1 | origin-main#b → origin-main | 1.563 / 1.744 / 1.786 | 2.18 / 1.882 / 1.835 |
| ab | 40000 | write | 0 | origin-main → origin-main#b | 2.18 / 1.882 / 1.835 | 2.783 / 2.113 / 1.921 |
| ab | 40000 | write | 1 | origin-main#b → origin-main | 2.18 / 1.882 / 1.835 | 2.783 / 2.113 / 1.921 |
| ab | 80000 | dryRun | 0 | origin-main → origin-main#b | 2.72 / 2.111 / 1.921 | 2.836 / 2.252 / 1.987 |
| ab | 80000 | dryRun | 1 | origin-main#b → origin-main | 2.72 / 2.111 / 1.921 | 2.836 / 2.252 / 1.987 |
| ab | 80000 | write | 0 | origin-main → origin-main#b | 2.836 / 2.252 / 1.987 | 2.007 / 2.151 / 1.981 |
| ab | 80000 | write | 1 | origin-main#b → origin-main | 2.836 / 2.252 / 1.987 | 2.007 / 2.151 / 1.981 |

## 6. 每格中位数

单位：时间 ms、内存 MiB（2^20 字节）、计数为个数。每格每侧 n = 轮数 × 每轮样本数。

### run=aa（origin-main#1 vs origin-main#2）

#### 规模 10000 冷行

阶段：dryRun；每侧样本 n = 6。

| 指标 | origin-main#1 | origin-main#2 | Δ（origin-main#2−origin-main#1） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 307.13 | 305.84 | −1.29 | −0.42% |
| CPU user+system | 424.88 | 423.54 | −1.34 | −0.32% |
| CPU user | 411.13 | 410.16 | −0.97 | −0.24% |
| CPU system | 13.73 | 14.00 | +0.27 | +1.93% |
| 外部采样峰值 RSS | 167.56 | 165.63 | −1.94 | −1.16% |
| 外部采样开始 RSS | 69.59 | 69.79 | +0.20 | +0.28% |
| 外部采样峰值−开始 | 98.20 | 95.77 | −2.42 | −2.47% |
| compact 结束时 RSS（进程内） | 140.03 | 138.09 | −1.95 | −1.39% |
| maxRSS 前（历史高水位） | 71.09 | 71.08 | −0.01 | −0.01% |
| maxRSS 后（历史高水位） | 167.56 | 165.63 | −1.93 | −1.15% |
| maxRSS 增量（高水位下界） | 96.55 | 94.52 | −2.03 | −2.10% |
| GC 后 heapUsed（开始） | 7.32 | 7.32 | +0.00 | +0.00% |
| compact 结束时 heapUsed | 53.73 | 32.24 | −21.49 | −39.99% |
| compact 后 GC heapUsed | 15.75 | 15.67 | −0.07 | −0.45% |
| heapUsed 增量（结束−开始） | 46.41 | 24.92 | −21.49 | −46.30% |
| archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| archive 字节（后） | 5.47 | 5.47 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 154 | 153 | −1 | −0.65% |
| 外部采样最大间隔 | 2.98 | 2.98 | −0.00 | −0.14% |

阶段：write；每侧样本 n = 6。

| 指标 | origin-main#1 | origin-main#2 | Δ（origin-main#2−origin-main#1） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 404.95 | 403.40 | −1.56 | −0.38% |
| CPU user+system | 580.78 | 574.23 | −6.56 | −1.13% |
| CPU user | 546.69 | 540.09 | −6.60 | −1.21% |
| CPU system | 33.98 | 34.26 | +0.28 | +0.83% |
| 外部采样峰值 RSS | 210.59 | 209.60 | −0.98 | −0.47% |
| 外部采样开始 RSS | 69.76 | 69.73 | −0.02 | −0.03% |
| 外部采样峰值−开始 | 140.99 | 139.94 | −1.05 | −0.75% |
| compact 结束时 RSS（进程内） | 184.75 | 183.89 | −0.87 | −0.47% |
| maxRSS 前（历史高水位） | 71.14 | 71.09 | −0.05 | −0.08% |
| maxRSS 后（历史高水位） | 210.60 | 209.60 | −1.00 | −0.47% |
| maxRSS 增量（高水位下界） | 139.58 | 138.66 | −0.91 | −0.65% |
| GC 后 heapUsed（开始） | 7.32 | 7.32 | 0.00 | +0.00% |
| compact 结束时 heapUsed | 38.45 | 38.03 | −0.42 | −1.08% |
| compact 后 GC heapUsed | 15.54 | 15.54 | +0.00 | +0.00% |
| heapUsed 增量（结束−开始） | 31.13 | 30.71 | −0.42 | −1.34% |
| archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| archive 字节（后） | 5.76 | 5.76 | 0.00 | +0.00% |
| 归档树文件数（后） | 27 | 27 | 0.00 | +0.00% |
| 外部采样样本数 | 203 | 202 | −1 | −0.49% |
| 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.03% |

#### 规模 40000 冷行

阶段：dryRun；每侧样本 n = 6。

| 指标 | origin-main#1 | origin-main#2 | Δ（origin-main#2−origin-main#1） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 1151.58 | 1148.18 | −3.40 | −0.30% |
| CPU user+system | 1500.87 | 1500.69 | −0.18 | −0.01% |
| CPU user | 1467.71 | 1467.08 | −0.63 | −0.04% |
| CPU system | 32.83 | 33.55 | +0.73 | +2.22% |
| 外部采样峰值 RSS | 304.48 | 297.73 | −6.75 | −2.22% |
| 外部采样开始 RSS | 122.73 | 115.16 | −7.56 | −6.16% |
| 外部采样峰值−开始 | 183.04 | 179.73 | −3.31 | −1.81% |
| compact 结束时 RSS（进程内） | 284.32 | 277.16 | −7.16 | −2.52% |
| maxRSS 前（历史高水位） | 123.08 | 116.24 | −6.84 | −5.55% |
| maxRSS 后（历史高水位） | 304.48 | 297.73 | −6.75 | −2.22% |
| maxRSS 增量（高水位下界） | 182.81 | 179.27 | −3.54 | −1.94% |
| GC 后 heapUsed（开始） | 10.38 | 10.38 | 0.00 | +0.00% |
| compact 结束时 heapUsed | 121.52 | 117.77 | −3.75 | −3.09% |
| compact 后 GC heapUsed | 23.70 | 23.68 | −0.03 | −0.11% |
| heapUsed 增量（结束−开始） | 111.13 | 107.38 | −3.75 | −3.38% |
| archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| archive 字节（后） | 21.91 | 21.91 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 576.50 | 574.50 | −2 | −0.35% |
| 外部采样最大间隔 | 2.96 | 2.98 | +0.02 | +0.72% |

阶段：write；每侧样本 n = 6。

| 指标 | origin-main#1 | origin-main#2 | Δ（origin-main#2−origin-main#1） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 1558.48 | 1559.18 | +0.69 | +0.04% |
| CPU user+system | 2251.90 | 2236.65 | −15.25 | −0.68% |
| CPU user | 2155.27 | 2142.27 | −13.00 | −0.60% |
| CPU system | 97.76 | 94.05 | −3.71 | −3.80% |
| 外部采样峰值 RSS | 350.16 | 353.44 | +3.27 | +0.93% |
| 外部采样开始 RSS | 119.07 | 120.61 | +1.54 | +1.29% |
| 外部采样峰值−开始 | 233.73 | 232.98 | −0.76 | −0.32% |
| compact 结束时 RSS（进程内） | 329.45 | 333.35 | +3.90 | +1.18% |
| maxRSS 前（历史高水位） | 119.32 | 121.05 | +1.73 | +1.45% |
| maxRSS 后（历史高水位） | 350.16 | 353.44 | +3.27 | +0.93% |
| maxRSS 增量（高水位下界） | 233.26 | 232.38 | −0.88 | −0.38% |
| GC 后 heapUsed（开始） | 10.38 | 10.38 | 0.00 | +0.00% |
| compact 结束时 heapUsed | 74.67 | 77.12 | +2.46 | +3.29% |
| compact 后 GC heapUsed | 20.14 | 20.10 | −0.04 | −0.19% |
| heapUsed 增量（结束−开始） | 64.28 | 66.74 | +2.46 | +3.82% |
| archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| archive 字节（后） | 24.30 | 24.30 | 0.00 | +0.00% |
| 归档树文件数（后） | 103 | 103 | 0.00 | +0.00% |
| 外部采样样本数 | 779.50 | 780 | +0.50 | +0.06% |
| 外部采样最大间隔 | 2.98 | 2.99 | +0.01 | +0.40% |

#### 规模 80000 冷行

阶段：dryRun；每侧样本 n = 6。

| 指标 | origin-main#1 | origin-main#2 | Δ（origin-main#2−origin-main#1） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 2252.89 | 2258.35 | +5.47 | +0.24% |
| CPU user+system | 2811.01 | 2850.73 | +39.72 | +1.41% |
| CPU user | 2756.71 | 2796.27 | +39.56 | +1.44% |
| CPU system | 54.30 | 54.09 | −0.22 | −0.40% |
| 外部采样峰值 RSS | 421.36 | 422.93 | +1.57 | +0.37% |
| 外部采样开始 RSS | 149.27 | 150.42 | +1.15 | +0.77% |
| 外部采样峰值−开始 | 271.47 | 273.24 | +1.77 | +0.65% |
| compact 结束时 RSS（进程内） | 407.85 | 409.40 | +1.55 | +0.38% |
| maxRSS 前（历史高水位） | 150.02 | 151.13 | +1.11 | +0.74% |
| maxRSS 后（历史高水位） | 421.37 | 422.91 | +1.55 | +0.37% |
| maxRSS 增量（高水位下界） | 270.76 | 272.38 | +1.63 | +0.60% |
| GC 后 heapUsed（开始） | 14.42 | 14.42 | +0.00 | +0.00% |
| compact 结束时 heapUsed | 186.29 | 184.68 | −1.61 | −0.86% |
| compact 后 GC heapUsed | 33.39 | 33.40 | +0.01 | +0.04% |
| heapUsed 增量（结束−开始） | 171.87 | 170.26 | −1.61 | −0.94% |
| archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| archive 字节（后） | 43.88 | 43.88 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 1127 | 1130 | +3 | +0.27% |
| 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.14% |

阶段：write；每侧样本 n = 6。

| 指标 | origin-main#1 | origin-main#2 | Δ（origin-main#2−origin-main#1） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 3108.18 | 3106.23 | −1.95 | −0.06% |
| CPU user+system | 4570.88 | 4568.49 | −2.39 | −0.05% |
| CPU user | 4402.22 | 4406.08 | +3.86 | +0.09% |
| CPU system | 168.65 | 166.54 | −2.12 | −1.26% |
| 外部采样峰值 RSS | 538.47 | 537.81 | −0.66 | −0.12% |
| 外部采样开始 RSS | 148.49 | 154.00 | +5.51 | +3.71% |
| 外部采样峰值−开始 | 391.45 | 383.02 | −8.43 | −2.15% |
| compact 结束时 RSS（进程内） | 522.05 | 523.59 | +1.54 | +0.29% |
| maxRSS 前（历史高水位） | 149.19 | 154.84 | +5.66 | +3.79% |
| maxRSS 后（历史高水位） | 538.47 | 537.81 | −0.66 | −0.12% |
| maxRSS 增量（高水位下界） | 390.73 | 382.16 | −8.56 | −2.19% |
| GC 后 heapUsed（开始） | 14.42 | 14.42 | +0.00 | +0.00% |
| compact 结束时 heapUsed | 141.95 | 141.91 | −0.03 | −0.02% |
| compact 后 GC heapUsed | 26.57 | 26.59 | +0.02 | +0.06% |
| heapUsed 增量（结束−开始） | 127.53 | 127.50 | −0.03 | −0.03% |
| archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| archive 字节（后） | 49.07 | 49.07 | 0.00 | +0.00% |
| 归档树文件数（后） | 201 | 201 | 0.00 | +0.00% |
| 外部采样样本数 | 1554.50 | 1553 | −1.50 | −0.10% |
| 外部采样最大间隔 | 2.99 | 2.99 | +0.00 | +0.04% |

### run=ab（origin-main vs origin-main#b）

#### 规模 10000 冷行

阶段：dryRun；每侧样本 n = 6。

| 指标 | origin-main | origin-main#b | Δ（origin-main#b−origin-main） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 307.13 | 307.04 | −0.08 | −0.03% |
| CPU user+system | 425.49 | 426.35 | +0.86 | +0.20% |
| CPU user | 411.60 | 412.65 | +1.05 | +0.26% |
| CPU system | 13.26 | 13.67 | +0.41 | +3.09% |
| 外部采样峰值 RSS | 165.63 | 167.45 | +1.81 | +1.09% |
| 外部采样开始 RSS | 69.73 | 69.44 | −0.30 | −0.43% |
| 外部采样峰值−开始 | 95.89 | 98.09 | +2.20 | +2.29% |
| compact 结束时 RSS（进程内） | 138.15 | 139.70 | +1.55 | +1.12% |
| maxRSS 前（历史高水位） | 71.03 | 71.07 | +0.04 | +0.05% |
| maxRSS 后（历史高水位） | 165.64 | 167.45 | +1.80 | +1.09% |
| maxRSS 增量（高水位下界） | 94.60 | 96.45 | +1.84 | +1.95% |
| GC 后 heapUsed（开始） | 7.32 | 7.32 | +0.00 | +0.03% |
| compact 结束时 heapUsed | 32.37 | 52.92 | +20.54 | +63.45% |
| compact 后 GC heapUsed | 15.67 | 15.75 | +0.08 | +0.50% |
| heapUsed 增量（结束−开始） | 25.05 | 45.59 | +20.54 | +81.99% |
| archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| archive 字节（后） | 5.47 | 5.47 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 154 | 153.50 | −0.50 | −0.32% |
| 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.02% |

阶段：write；每侧样本 n = 6。

| 指标 | origin-main | origin-main#b | Δ（origin-main#b−origin-main） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 403.30 | 405.65 | +2.35 | +0.58% |
| CPU user+system | 574.90 | 579.32 | +4.41 | +0.77% |
| CPU user | 541.22 | 545.10 | +3.88 | +0.72% |
| CPU system | 34.26 | 34.19 | −0.07 | −0.21% |
| 外部采样峰值 RSS | 209.20 | 212.47 | +3.27 | +1.56% |
| 外部采样开始 RSS | 69.70 | 69.78 | +0.09 | +0.12% |
| 外部采样峰值−开始 | 139.46 | 142.48 | +3.02 | +2.16% |
| compact 结束时 RSS（进程内） | 183.31 | 186.68 | +3.37 | +1.84% |
| maxRSS 前（历史高水位） | 70.97 | 71.28 | +0.31 | +0.44% |
| maxRSS 后（历史高水位） | 209.23 | 212.50 | +3.27 | +1.56% |
| maxRSS 增量（高水位下界） | 138.21 | 141.07 | +2.86 | +2.07% |
| GC 后 heapUsed（开始） | 7.32 | 7.32 | +0.00 | +0.03% |
| compact 结束时 heapUsed | 37.69 | 40.81 | +3.12 | +8.27% |
| compact 后 GC heapUsed | 15.54 | 15.54 | +0.00 | +0.03% |
| heapUsed 增量（结束−开始） | 30.37 | 33.49 | +3.11 | +10.25% |
| archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| archive 字节（后） | 5.76 | 5.76 | 0.00 | +0.00% |
| 归档树文件数（后） | 27 | 27 | 0.00 | +0.00% |
| 外部采样样本数 | 202 | 203 | +1 | +0.50% |
| 外部采样最大间隔 | 2.99 | 2.99 | +0.00 | +0.00% |

#### 规模 40000 冷行

阶段：dryRun；每侧样本 n = 6。

| 指标 | origin-main | origin-main#b | Δ（origin-main#b−origin-main） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 1146.59 | 1148.47 | +1.88 | +0.16% |
| CPU user+system | 1489.63 | 1494.27 | +4.64 | +0.31% |
| CPU user | 1456.21 | 1460.77 | +4.55 | +0.31% |
| CPU system | 33.06 | 33.23 | +0.17 | +0.53% |
| 外部采样峰值 RSS | 303.63 | 300.41 | −3.23 | −1.06% |
| 外部采样开始 RSS | 120.52 | 121.05 | +0.54 | +0.45% |
| 外部采样峰值−开始 | 184.46 | 179.56 | −4.90 | −2.66% |
| compact 结束时 RSS（进程内） | 283.63 | 280.14 | −3.49 | −1.23% |
| maxRSS 前（历史高水位） | 120.74 | 121.44 | +0.70 | +0.58% |
| maxRSS 后（历史高水位） | 303.63 | 300.41 | −3.23 | −1.06% |
| maxRSS 增量（高水位下界） | 184.16 | 179.16 | −5.00 | −2.72% |
| GC 后 heapUsed（开始） | 10.38 | 10.39 | +0.00 | +0.02% |
| compact 结束时 heapUsed | 116.69 | 125.92 | +9.23 | +7.91% |
| compact 后 GC heapUsed | 23.69 | 23.69 | +0.01 | +0.03% |
| heapUsed 增量（结束−开始） | 106.31 | 115.54 | +9.23 | +8.68% |
| archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| archive 字节（后） | 21.91 | 21.91 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 573.50 | 574.50 | +1 | +0.17% |
| 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.03% |

阶段：write；每侧样本 n = 6。

| 指标 | origin-main | origin-main#b | Δ（origin-main#b−origin-main） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 1585.55 | 1575.06 | −10.49 | −0.66% |
| CPU user+system | 2272.85 | 2269.86 | −2.99 | −0.13% |
| CPU user | 2176.32 | 2175.92 | −0.39 | −0.02% |
| CPU system | 99.49 | 100.83 | +1.35 | +1.35% |
| 外部采样峰值 RSS | 346.02 | 351.09 | +5.07 | +1.47% |
| 外部采样开始 RSS | 109.55 | 107.77 | −1.78 | −1.63% |
| 外部采样峰值−开始 | 234.81 | 237.55 | +2.74 | +1.17% |
| compact 结束时 RSS（进程内） | 323.98 | 331.37 | +7.38 | +2.28% |
| maxRSS 前（历史高水位） | 111.41 | 109.20 | −2.22 | −1.99% |
| maxRSS 后（历史高水位） | 346.20 | 351.13 | +4.93 | +1.42% |
| maxRSS 增量（高水位下界） | 234.59 | 235.79 | +1.20 | +0.51% |
| GC 后 heapUsed（开始） | 10.38 | 10.39 | +0.00 | +0.02% |
| compact 结束时 heapUsed | 77.30 | 80.79 | +3.48 | +4.50% |
| compact 后 GC heapUsed | 20.11 | 20.12 | +0.01 | +0.03% |
| heapUsed 增量（结束−开始） | 66.92 | 70.40 | +3.48 | +5.20% |
| archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| archive 字节（后） | 24.30 | 24.30 | 0.00 | +0.00% |
| 归档树文件数（后） | 103 | 103 | 0.00 | +0.00% |
| 外部采样样本数 | 793 | 788 | −5 | −0.63% |
| 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.03% |

#### 规模 80000 冷行

阶段：dryRun；每侧样本 n = 6。

| 指标 | origin-main | origin-main#b | Δ（origin-main#b−origin-main） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 2251.78 | 2263.44 | +11.66 | +0.52% |
| CPU user+system | 2840.46 | 2855.00 | +14.54 | +0.51% |
| CPU user | 2787.64 | 2800.50 | +12.86 | +0.46% |
| CPU system | 53.95 | 54.06 | +0.11 | +0.21% |
| 外部采样峰值 RSS | 418.42 | 420.48 | +2.05 | +0.49% |
| 外部采样开始 RSS | 150.66 | 148.38 | −2.29 | −1.52% |
| 外部采样峰值−开始 | 268.84 | 271.67 | +2.83 | +1.05% |
| compact 结束时 RSS（进程内） | 404.66 | 406.95 | +2.29 | +0.57% |
| maxRSS 前（历史高水位） | 151.50 | 149.09 | −2.41 | −1.59% |
| maxRSS 后（历史高水位） | 418.42 | 420.48 | +2.06 | +0.49% |
| maxRSS 增量（高水位下界） | 268.12 | 270.98 | +2.86 | +1.07% |
| GC 后 heapUsed（开始） | 14.42 | 14.42 | +0.00 | +0.01% |
| compact 结束时 heapUsed | 184.76 | 184.15 | −0.61 | −0.33% |
| compact 后 GC heapUsed | 33.41 | 33.42 | +0.01 | +0.04% |
| heapUsed 增量（结束−开始） | 170.34 | 169.73 | −0.61 | −0.36% |
| archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| archive 字节（后） | 43.88 | 43.88 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 1126 | 1132 | +6 | +0.53% |
| 外部采样最大间隔 | 2.98 | 2.98 | −0.00 | −0.09% |

阶段：write；每侧样本 n = 6。

| 指标 | origin-main | origin-main#b | Δ（origin-main#b−origin-main） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 3112.37 | 3105.99 | −6.39 | −0.21% |
| CPU user+system | 4620.00 | 4578.61 | −41.39 | −0.90% |
| CPU user | 4454.56 | 4411.43 | −43.13 | −0.97% |
| CPU system | 165.44 | 164.11 | −1.33 | −0.81% |
| 外部采样峰值 RSS | 540.19 | 541.70 | +1.52 | +0.28% |
| 外部采样开始 RSS | 152.46 | 152.27 | −0.20 | −0.13% |
| 外部采样峰值−开始 | 387.08 | 386.98 | −0.09 | −0.02% |
| compact 结束时 RSS（进程内） | 524.30 | 525.08 | +0.78 | +0.15% |
| maxRSS 前（历史高水位） | 153.23 | 153.27 | +0.03 | +0.02% |
| maxRSS 后（历史高水位） | 540.19 | 541.70 | +1.52 | +0.28% |
| maxRSS 增量（高水位下界） | 386.26 | 386.17 | −0.09 | −0.02% |
| GC 后 heapUsed（开始） | 14.42 | 14.42 | +0.00 | +0.01% |
| compact 结束时 heapUsed | 145.26 | 142.67 | −2.60 | −1.79% |
| compact 后 GC heapUsed | 26.62 | 26.58 | −0.05 | −0.17% |
| heapUsed 增量（结束−开始） | 130.84 | 128.25 | −2.60 | −1.98% |
| archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| archive 字节（后） | 49.07 | 49.07 | 0.00 | +0.00% |
| 归档树文件数（后） | 201 | 201 | 0.00 | +0.00% |
| 外部采样样本数 | 1556.50 | 1553 | −3.50 | −0.22% |
| 外部采样最大间隔 | 2.98 | 2.99 | +0.01 | +0.26% |

### 测量敏感性自检（dryRun，模板协议）

自检目标：证实外部采样确实观察到了规划阶段，而不是只观察 setup 高水位。`峰值−开始` 必须与 `heapUsed 增量` 同量级（比值在 0.2–5），且两者随规模单调上升。

| 规模 | 起始 RSS（MiB） | 外部峰值（MiB） | 峰值−开始（MiB） | heapUsed 增量（MiB） | 比值（峰值−开始）/heapUsed | 外部采样数 | 最大间隔（ms） |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10000 | 69.73 | 165.63 | 95.89 | 25.05 | 3.83 | 154 | 2.98 |
| 40000 | 120.52 | 303.63 | 184.46 | 106.31 | 1.74 | 573.5 | 2.98 |
| 80000 | 150.66 | 418.42 | 268.84 | 170.34 | 1.58 | 1126 | 2.98 |

- 峰值−开始单调上升（按规模）：PASS；heapUsed 增量单调上升：PASS；每格比值在 0.2–5：PASS。

## 7. 报告摘要

每格报告在所有样本中完全一致时（见第 8 节等价性），取第一行代表：

| run | 规模 | 阶段 | retired | consolidated | aggregatedObservations | tombstones | canonical | knowledgeBefore→After | beforeBytes→afterBytes |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| aa | 10000 | dryRun | 1937 | 5250 | 1 | 2 | 63 | 2000→2500 | 5729370→5729370 |
| aa | 10000 | write | 1937 | 5250 | 1 | 2 | 63 | 2000→2500 | 5729370→6025071 |
| aa | 40000 | dryRun | 7750 | 21000 | 1 | 2 | 250 | 8000→10000 | 22967370→22967370 |
| aa | 40000 | write | 7750 | 21000 | 1 | 2 | 250 | 8000→10000 | 22967370→25431860 |
| aa | 80000 | dryRun | 15500 | 42000 | 1 | 2 | 500 | 16000→20000 | 46005370→46005370 |
| aa | 80000 | write | 15500 | 42000 | 1 | 2 | 500 | 16000→20000 | 46005370→51352213 |
| ab | 10000 | dryRun | 1937 | 5250 | 1 | 2 | 63 | 2000→2500 | 5729370→5729370 |
| ab | 10000 | write | 1937 | 5250 | 1 | 2 | 63 | 2000→2500 | 5729370→6025071 |
| ab | 40000 | dryRun | 7750 | 21000 | 1 | 2 | 250 | 8000→10000 | 22967370→22967370 |
| ab | 40000 | write | 7750 | 21000 | 1 | 2 | 250 | 8000→10000 | 22967370→25431860 |
| ab | 80000 | dryRun | 15500 | 42000 | 1 | 2 | 500 | 16000→20000 | 46005370→46005370 |
| ab | 80000 | write | 15500 | 42000 | 1 | 2 | 500 | 16000→20000 | 46005370→51352213 |

## 8. 等价性与固定点断言

| run | 规模 | 阶段 | report sha | state sha | archive before sha | archive after sha | 二次 compact report sha | dryRun 零写入 | 二次 compact 收敛 | 结论 |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| aa | 10000 | dryRun | 1 | 1 | 1 | 1 | 0 | true | — | PASS |
| aa | 10000 | write | 1 | 1 | 1 | 1 | 1 | — | true | PASS |
| aa | 40000 | dryRun | 1 | 1 | 1 | 1 | 0 | true | — | PASS |
| aa | 40000 | write | 1 | 1 | 1 | 1 | 1 | — | true | PASS |
| aa | 80000 | dryRun | 1 | 1 | 1 | 1 | 0 | true | — | PASS |
| aa | 80000 | write | 1 | 1 | 1 | 1 | 1 | — | true | PASS |
| ab | 10000 | dryRun | 1 | 1 | 1 | 1 | 0 | true | — | PASS |
| ab | 10000 | write | 1 | 1 | 1 | 1 | 1 | — | true | PASS |
| ab | 40000 | dryRun | 1 | 1 | 1 | 1 | 0 | true | — | PASS |
| ab | 40000 | write | 1 | 1 | 1 | 1 | 1 | — | true | PASS |
| ab | 80000 | dryRun | 1 | 1 | 1 | 1 | 0 | true | — | PASS |
| ab | 80000 | write | 1 | 1 | 1 | 1 | 1 | — | true | PASS |

## 9. A/A 噪声

A/A = 同一 ref 解出两次，两侧代码完全相同，差异即噪声。下表为每格中位数差值（绝对与相对）。

| 规模 | 阶段 | 指标 | 侧 1 | 侧 2 | Δ | Δ% |
| ---: | --- | --- | ---: | ---: | ---: | ---: |
| 10000 | dryRun | wall | 307.13 | 305.84 | −1.29 | −0.42% |
| 10000 | dryRun | CPU user+system | 424.88 | 423.54 | −1.34 | −0.32% |
| 10000 | dryRun | CPU user | 411.13 | 410.16 | −0.97 | −0.24% |
| 10000 | dryRun | CPU system | 13.73 | 14.00 | +0.27 | +1.93% |
| 10000 | dryRun | 外部采样峰值 RSS | 167.56 | 165.63 | −1.94 | −1.16% |
| 10000 | dryRun | 外部采样开始 RSS | 69.59 | 69.79 | +0.20 | +0.28% |
| 10000 | dryRun | 外部采样峰值−开始 | 98.20 | 95.77 | −2.42 | −2.47% |
| 10000 | dryRun | compact 结束时 RSS（进程内） | 140.03 | 138.09 | −1.95 | −1.39% |
| 10000 | dryRun | maxRSS 前（历史高水位） | 71.09 | 71.08 | −0.01 | −0.01% |
| 10000 | dryRun | maxRSS 后（历史高水位） | 167.56 | 165.63 | −1.93 | −1.15% |
| 10000 | dryRun | maxRSS 增量（高水位下界） | 96.55 | 94.52 | −2.03 | −2.10% |
| 10000 | dryRun | GC 后 heapUsed（开始） | 7.32 | 7.32 | +0.00 | +0.00% |
| 10000 | dryRun | compact 结束时 heapUsed | 53.73 | 32.24 | −21.49 | −39.99% |
| 10000 | dryRun | compact 后 GC heapUsed | 15.75 | 15.67 | −0.07 | −0.45% |
| 10000 | dryRun | heapUsed 增量（结束−开始） | 46.41 | 24.92 | −21.49 | −46.30% |
| 10000 | dryRun | archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| 10000 | dryRun | archive 字节（后） | 5.47 | 5.47 | 0.00 | +0.00% |
| 10000 | dryRun | 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 10000 | dryRun | 外部采样样本数 | 154 | 153 | −1 | −0.65% |
| 10000 | dryRun | 外部采样最大间隔 | 2.98 | 2.98 | −0.00 | −0.14% |
| 10000 | write | wall | 404.95 | 403.40 | −1.56 | −0.38% |
| 10000 | write | CPU user+system | 580.78 | 574.23 | −6.56 | −1.13% |
| 10000 | write | CPU user | 546.69 | 540.09 | −6.60 | −1.21% |
| 10000 | write | CPU system | 33.98 | 34.26 | +0.28 | +0.83% |
| 10000 | write | 外部采样峰值 RSS | 210.59 | 209.60 | −0.98 | −0.47% |
| 10000 | write | 外部采样开始 RSS | 69.76 | 69.73 | −0.02 | −0.03% |
| 10000 | write | 外部采样峰值−开始 | 140.99 | 139.94 | −1.05 | −0.75% |
| 10000 | write | compact 结束时 RSS（进程内） | 184.75 | 183.89 | −0.87 | −0.47% |
| 10000 | write | maxRSS 前（历史高水位） | 71.14 | 71.09 | −0.05 | −0.08% |
| 10000 | write | maxRSS 后（历史高水位） | 210.60 | 209.60 | −1.00 | −0.47% |
| 10000 | write | maxRSS 增量（高水位下界） | 139.58 | 138.66 | −0.91 | −0.65% |
| 10000 | write | GC 后 heapUsed（开始） | 7.32 | 7.32 | 0.00 | +0.00% |
| 10000 | write | compact 结束时 heapUsed | 38.45 | 38.03 | −0.42 | −1.08% |
| 10000 | write | compact 后 GC heapUsed | 15.54 | 15.54 | +0.00 | +0.00% |
| 10000 | write | heapUsed 增量（结束−开始） | 31.13 | 30.71 | −0.42 | −1.34% |
| 10000 | write | archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| 10000 | write | archive 字节（后） | 5.76 | 5.76 | 0.00 | +0.00% |
| 10000 | write | 归档树文件数（后） | 27 | 27 | 0.00 | +0.00% |
| 10000 | write | 外部采样样本数 | 203 | 202 | −1 | −0.49% |
| 10000 | write | 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.03% |
| 40000 | dryRun | wall | 1151.58 | 1148.18 | −3.40 | −0.30% |
| 40000 | dryRun | CPU user+system | 1500.87 | 1500.69 | −0.18 | −0.01% |
| 40000 | dryRun | CPU user | 1467.71 | 1467.08 | −0.63 | −0.04% |
| 40000 | dryRun | CPU system | 32.83 | 33.55 | +0.73 | +2.22% |
| 40000 | dryRun | 外部采样峰值 RSS | 304.48 | 297.73 | −6.75 | −2.22% |
| 40000 | dryRun | 外部采样开始 RSS | 122.73 | 115.16 | −7.56 | −6.16% |
| 40000 | dryRun | 外部采样峰值−开始 | 183.04 | 179.73 | −3.31 | −1.81% |
| 40000 | dryRun | compact 结束时 RSS（进程内） | 284.32 | 277.16 | −7.16 | −2.52% |
| 40000 | dryRun | maxRSS 前（历史高水位） | 123.08 | 116.24 | −6.84 | −5.55% |
| 40000 | dryRun | maxRSS 后（历史高水位） | 304.48 | 297.73 | −6.75 | −2.22% |
| 40000 | dryRun | maxRSS 增量（高水位下界） | 182.81 | 179.27 | −3.54 | −1.94% |
| 40000 | dryRun | GC 后 heapUsed（开始） | 10.38 | 10.38 | 0.00 | +0.00% |
| 40000 | dryRun | compact 结束时 heapUsed | 121.52 | 117.77 | −3.75 | −3.09% |
| 40000 | dryRun | compact 后 GC heapUsed | 23.70 | 23.68 | −0.03 | −0.11% |
| 40000 | dryRun | heapUsed 增量（结束−开始） | 111.13 | 107.38 | −3.75 | −3.38% |
| 40000 | dryRun | archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| 40000 | dryRun | archive 字节（后） | 21.91 | 21.91 | 0.00 | +0.00% |
| 40000 | dryRun | 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 40000 | dryRun | 外部采样样本数 | 576.50 | 574.50 | −2 | −0.35% |
| 40000 | dryRun | 外部采样最大间隔 | 2.96 | 2.98 | +0.02 | +0.72% |
| 40000 | write | wall | 1558.48 | 1559.18 | +0.69 | +0.04% |
| 40000 | write | CPU user+system | 2251.90 | 2236.65 | −15.25 | −0.68% |
| 40000 | write | CPU user | 2155.27 | 2142.27 | −13.00 | −0.60% |
| 40000 | write | CPU system | 97.76 | 94.05 | −3.71 | −3.80% |
| 40000 | write | 外部采样峰值 RSS | 350.16 | 353.44 | +3.27 | +0.93% |
| 40000 | write | 外部采样开始 RSS | 119.07 | 120.61 | +1.54 | +1.29% |
| 40000 | write | 外部采样峰值−开始 | 233.73 | 232.98 | −0.76 | −0.32% |
| 40000 | write | compact 结束时 RSS（进程内） | 329.45 | 333.35 | +3.90 | +1.18% |
| 40000 | write | maxRSS 前（历史高水位） | 119.32 | 121.05 | +1.73 | +1.45% |
| 40000 | write | maxRSS 后（历史高水位） | 350.16 | 353.44 | +3.27 | +0.93% |
| 40000 | write | maxRSS 增量（高水位下界） | 233.26 | 232.38 | −0.88 | −0.38% |
| 40000 | write | GC 后 heapUsed（开始） | 10.38 | 10.38 | 0.00 | +0.00% |
| 40000 | write | compact 结束时 heapUsed | 74.67 | 77.12 | +2.46 | +3.29% |
| 40000 | write | compact 后 GC heapUsed | 20.14 | 20.10 | −0.04 | −0.19% |
| 40000 | write | heapUsed 增量（结束−开始） | 64.28 | 66.74 | +2.46 | +3.82% |
| 40000 | write | archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| 40000 | write | archive 字节（后） | 24.30 | 24.30 | 0.00 | +0.00% |
| 40000 | write | 归档树文件数（后） | 103 | 103 | 0.00 | +0.00% |
| 40000 | write | 外部采样样本数 | 779.50 | 780 | +0.50 | +0.06% |
| 40000 | write | 外部采样最大间隔 | 2.98 | 2.99 | +0.01 | +0.40% |
| 80000 | dryRun | wall | 2252.89 | 2258.35 | +5.47 | +0.24% |
| 80000 | dryRun | CPU user+system | 2811.01 | 2850.73 | +39.72 | +1.41% |
| 80000 | dryRun | CPU user | 2756.71 | 2796.27 | +39.56 | +1.44% |
| 80000 | dryRun | CPU system | 54.30 | 54.09 | −0.22 | −0.40% |
| 80000 | dryRun | 外部采样峰值 RSS | 421.36 | 422.93 | +1.57 | +0.37% |
| 80000 | dryRun | 外部采样开始 RSS | 149.27 | 150.42 | +1.15 | +0.77% |
| 80000 | dryRun | 外部采样峰值−开始 | 271.47 | 273.24 | +1.77 | +0.65% |
| 80000 | dryRun | compact 结束时 RSS（进程内） | 407.85 | 409.40 | +1.55 | +0.38% |
| 80000 | dryRun | maxRSS 前（历史高水位） | 150.02 | 151.13 | +1.11 | +0.74% |
| 80000 | dryRun | maxRSS 后（历史高水位） | 421.37 | 422.91 | +1.55 | +0.37% |
| 80000 | dryRun | maxRSS 增量（高水位下界） | 270.76 | 272.38 | +1.63 | +0.60% |
| 80000 | dryRun | GC 后 heapUsed（开始） | 14.42 | 14.42 | +0.00 | +0.00% |
| 80000 | dryRun | compact 结束时 heapUsed | 186.29 | 184.68 | −1.61 | −0.86% |
| 80000 | dryRun | compact 后 GC heapUsed | 33.39 | 33.40 | +0.01 | +0.04% |
| 80000 | dryRun | heapUsed 增量（结束−开始） | 171.87 | 170.26 | −1.61 | −0.94% |
| 80000 | dryRun | archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| 80000 | dryRun | archive 字节（后） | 43.88 | 43.88 | 0.00 | +0.00% |
| 80000 | dryRun | 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 80000 | dryRun | 外部采样样本数 | 1127 | 1130 | +3 | +0.27% |
| 80000 | dryRun | 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.14% |
| 80000 | write | wall | 3108.18 | 3106.23 | −1.95 | −0.06% |
| 80000 | write | CPU user+system | 4570.88 | 4568.49 | −2.39 | −0.05% |
| 80000 | write | CPU user | 4402.22 | 4406.08 | +3.86 | +0.09% |
| 80000 | write | CPU system | 168.65 | 166.54 | −2.12 | −1.26% |
| 80000 | write | 外部采样峰值 RSS | 538.47 | 537.81 | −0.66 | −0.12% |
| 80000 | write | 外部采样开始 RSS | 148.49 | 154.00 | +5.51 | +3.71% |
| 80000 | write | 外部采样峰值−开始 | 391.45 | 383.02 | −8.43 | −2.15% |
| 80000 | write | compact 结束时 RSS（进程内） | 522.05 | 523.59 | +1.54 | +0.29% |
| 80000 | write | maxRSS 前（历史高水位） | 149.19 | 154.84 | +5.66 | +3.79% |
| 80000 | write | maxRSS 后（历史高水位） | 538.47 | 537.81 | −0.66 | −0.12% |
| 80000 | write | maxRSS 增量（高水位下界） | 390.73 | 382.16 | −8.56 | −2.19% |
| 80000 | write | GC 后 heapUsed（开始） | 14.42 | 14.42 | +0.00 | +0.00% |
| 80000 | write | compact 结束时 heapUsed | 141.95 | 141.91 | −0.03 | −0.02% |
| 80000 | write | compact 后 GC heapUsed | 26.57 | 26.59 | +0.02 | +0.06% |
| 80000 | write | heapUsed 增量（结束−开始） | 127.53 | 127.50 | −0.03 | −0.03% |
| 80000 | write | archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| 80000 | write | archive 字节（后） | 49.07 | 49.07 | 0.00 | +0.00% |
| 80000 | write | 归档树文件数（后） | 201 | 201 | 0.00 | +0.00% |
| 80000 | write | 外部采样样本数 | 1554.50 | 1553 | −1.50 | −0.10% |
| 80000 | write | 外部采样最大间隔 | 2.99 | 2.99 | +0.00 | +0.04% |

| 指标 | 跨格 |Δ%| 中位数 | 跨格 |Δ%| 最大值 |
| --- | ---: | ---: |
| wall | 0.27% | 0.42% |
| CPU user+system | 0.50% | 1.41% |
| CPU user | 0.42% | 1.44% |
| CPU system | 1.59% | 3.80% |
| 外部采样峰值 RSS | 0.70% | 2.22% |
| 外部采样开始 RSS | 1.03% | 6.16% |
| 外部采样峰值−开始 | 1.28% | 2.47% |
| compact 结束时 RSS（进程内） | 0.83% | 2.52% |
| maxRSS 前（历史高水位） | 1.10% | 5.55% |
| maxRSS 后（历史高水位） | 0.70% | 2.22% |
| maxRSS 增量（高水位下界） | 1.30% | 2.19% |
| GC 后 heapUsed（开始） | 0.00% | 0.00% |
| compact 结束时 heapUsed | 2.09% | 39.99% |
| compact 后 GC heapUsed | 0.09% | 0.45% |
| heapUsed 增量（结束−开始） | 2.36% | 46.30% |
| archive 字节（前） | 0.00% | 0.00% |
| archive 字节（后） | 0.00% | 0.00% |
| 归档树文件数（后） | 0.00% | 0.00% |
| 外部采样样本数 | 0.31% | 0.65% |
| 外部采样最大间隔 | 0.14% | 0.72% |

- 稳定指标（跨格 |Δ%| 中位数 < 2% 且最大值 < 5%）：wall、CPU user+system、CPU user、CPU system、外部采样峰值 RSS、外部采样峰值−开始、compact 结束时 RSS（进程内）、maxRSS 后（历史高水位）、maxRSS 增量（高水位下界）、GC 后 heapUsed（开始）、compact 后 GC heapUsed、archive 字节（前）、archive 字节（后）、归档树文件数（后）、外部采样样本数、外部采样最大间隔。
- 高噪声指标（跨格 |Δ%| 中位数 ≥ 5% 或最大值 ≥ 10%）：compact 结束时 heapUsed、heapUsed 增量（结束−开始）。它们不是本基线的主判据：RSS 用绝对外部峰值（其 Δ% 很小）而不是“峰值−开始”（开始基线本身有 ±1–2% 抖动）；heap 用 compact 后 GC 的 heapUsed 与 archive 字节（后者在多轮 A/A 中逐字节相同）。

## 10. 未测量项与限制

- external RSS peak is a sampling lower bound; a peak shorter than the sampling interval can be missed
- maxRSS delta can be masked by the load-time archive scan high-water mark and is never used as the per-call peak
- synthetic fixed-time corpus (deterministic clock) generated once by the baseline side; not production user data
- no official host domain transaction, fsync, multi-process contention or startup archive-index reconciliation is timed
- OS page cache is not flushed; each sample copies the template fresh (copy is outside the measured window) and A/B/B/A round rotation balances ordering effects
- knowledge groups fit the bounded sourceRefs window; canonical protects outcomes, not terminal promotions
- the external sampler reads a lower bound of resident bytes and does not attribute them to V8 heap vs. native buffers
- 未测量项：per-3ms RSS trace is not persisted (only peak/baseline/delta/count/max gap are recorded)；native (malloc/mmap) vs. V8 heap attribution of the external RSS peak；write-phase OS peak under a pinned heap (unless --pinned-heap is passed)
- 历史数据单位更正：本修复（scripts/benchmarks/retention-rss-sampler.py 的 `firstSampleMs`/`lastSampleMs` 输出改为毫秒）之前生成的 `retention-plan-streaming-baseline.json`、`retention-plan-streaming-ab-with-c3.*`、`retention-plan-streaming-c3-ab.*`、`retention-plan-streaming-c3c4-ab.*` 中，`externalFirstSampleMs`/`externalLastSampleMs` 实际单位是**秒**（sampler bug，已修复；外部峰值、`externalRssDeltaBytes`、`externalMaxGapMs` 不受影响，它们本来就是毫秒或字节）。

