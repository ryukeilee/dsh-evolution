# retention/compact 进程外采样基线（A/A 与 A/B）

生成时间：2026-11-06T14:52:41.165Z；总耗时 308.7 s。

本文件由 `scripts/benchmarks/retention-plan-streaming.mjs` 从同一份 JSON 自动生成；所有数值都是本轮实际测量，未引用历史数字。

## 0. 本轮用途

本轮包含不同代码树的两侧：A/A run 用于估计噪声，A/B run 用于候选对比。

**本轮说明**：本报告为撤回 C4 后的最终树（C1–C3，lib/dockyard-domain/memory.js sha256=1f4f2cf514afc96c4532f5e1e97e0a3c5dd3ecce8e6d34f2cc9ae4c23cc08374）；C4 含入时的历史测量见 docs/performance/retention-plan-streaming-c3c4-ab.{json,md}，仅供历史参考、不属本树。

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
| loadAverageAtStart | 1.391 / 1.693 / 1.827 |
| loadAverageAtEnd | 1.788 / 1.893 / 1.888 |

## 2. 复现命令

从仓库根目录执行：

```sh
node scripts/benchmarks/retention-plan-streaming.mjs --a git:origin/main --b worktree --runs aa,ab --scales 10000,40000,80000 --samples 3 --rounds 2 --phases dryRun,write --out docs/performance/retention-plan-streaming-baseline.json --md docs/performance/retention-plan-streaming-baseline.md
```

本轮实际命令行（含本机绝对路径，仅作记录）：

```
/opt/homebrew/Cellar/node/26.13.0_2/bin/node /Users/ryukeili/GitHub/dsh-evolution/.agents/worktrees/perf/retention-plan-streaming/scripts/benchmarks/retention-plan-streaming.mjs --a git:origin/main --b worktree --runs aa,ab --scales 10000,40000,80000 --samples 3 --rounds 2 --phases dryRun,write --out docs/performance/retention-plan-streaming-ab.json --md docs/performance/retention-plan-streaming-ab.md --note 本报告为撤回 C4 后的最终树（C1–C3，lib/dockyard-domain/memory.js sha256=1f4f2cf514afc96c4532f5e1e97e0a3c5dd3ecce8e6d34f2cc9ae4c23cc08374）；C4 含入时的历史测量见 docs/performance/retention-plan-streaming-c3c4-ab.{json,md}，仅供历史参考、不属本树。
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
| worktree | `worktree` | worktree | — | `a42399f511f3085333ab0900675c2a0375a3f5109e551d4042ba1a00f49a8599` |

treesIdentical（A 与 B 的 lib 树哈希相同，此时 A/B 也是 A/A 复制）：aa=true，ab=false

模板 = `state.json`（canonical 指针 + 空 hot 集合）+ 每个 collection 一个 active archive 文件；由基线侧公开函数生成一次，每个样本由父进程复制。`state sha256` 是模板 state.json 的字节哈希，`archive sha256` 是归档树（文件名 + 每文件 sha256）的哈希。

| 规模（冷行） | 模板文件数 | 模板字节 | archive sha256 | state 字节 | state sha256 | observations | knowledge | cycles | outcomes | promotions | canonical |
| ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10000 | 5 | 5729370 | `8d96bd79d6f6e5e532451298660398d8922e97d43a5bd816c6dee42cfa8e5ee6` | 14493 | `cd0d2297258c907806985f45268d7f06bab34f6d686201fba8c3e9af44ece7bd` | 4000 | 2000 | 2000 | 1000 | 1000 | 63 |
| 40000 | 5 | 22967370 | `147a3f59e49071f865e52d79b1d6e4bd4e63475a68194140b84a62f3c8718521` | 58027 | `0e8b82993cbd93e5b3e15fbb3fc944902b6f2f78f408fdc4b5a0b17283e6e023` | 16000 | 8000 | 8000 | 4000 | 4000 | 250 |
| 80000 | 5 | 46005370 | `e5dded130f074ca2b1ae5b766bc71eef4633c4b4f13304f6eb01c9c370c7b63a` | 116277 | `fa398ca51eeb5fb2e2bfdf9b25d4bf4ee8a577836e52137aa56f34dffa524766` | 32000 | 16000 | 16000 | 8000 | 8000 | 500 |

## 5. 调度与测量窗口 loadavg

每个 (规模, 阶段) 内：2 轮，偶数轮 `[A,B]`，奇数轮 `[B,A]`；每侧每轮 `3` 个独立样本；AA 与 AB 两种 run 按轮交替先后。

每样本测量窗口的 1m loadavg：最小 1.359 / 中位 1.913 / 最大 2.385。1m 均值会吸收本基准自身的子进程 spawn 与 2 ms 外部采样进程，因此它不是外部负载的独立证据；同一 (规模, 阶段) 的 A/A 与 A/B 两侧按轮交替，噪声估计覆盖了这一漂移。

下表的 loadavg 是该 (规模, 阶段) 格开始/结束时的值（不是每轮值）；逐样本值在 JSON 的每一行里。

| run | 规模 | 阶段 | 轮 | order | 格起始 loadavg | 格结束 loadavg |
| --- | ---: | --- | ---: | --- | --- | --- |
| aa | 10000 | dryRun | 0 | origin-main#1 → origin-main#2 | 1.391 / 1.693 / 1.827 | 1.604 / 1.724 / 1.835 |
| aa | 10000 | dryRun | 1 | origin-main#2 → origin-main#1 | 1.391 / 1.693 / 1.827 | 1.604 / 1.724 / 1.835 |
| aa | 10000 | write | 0 | origin-main#1 → origin-main#2 | 1.604 / 1.724 / 1.835 | 1.691 / 1.737 / 1.837 |
| aa | 10000 | write | 1 | origin-main#2 → origin-main#1 | 1.604 / 1.724 / 1.835 | 1.691 / 1.737 / 1.837 |
| aa | 40000 | dryRun | 0 | origin-main#1 → origin-main#2 | 1.691 / 1.737 / 1.837 | 1.868 / 1.782 / 1.847 |
| aa | 40000 | dryRun | 1 | origin-main#2 → origin-main#1 | 1.691 / 1.737 / 1.837 | 1.868 / 1.782 / 1.847 |
| aa | 40000 | write | 0 | origin-main#1 → origin-main#2 | 1.868 / 1.782 / 1.847 | 2.385 / 1.927 / 1.893 |
| aa | 40000 | write | 1 | origin-main#2 → origin-main#1 | 1.868 / 1.782 / 1.847 | 2.385 / 1.927 / 1.893 |
| aa | 80000 | dryRun | 0 | origin-main#1 → origin-main#2 | 2.385 / 1.927 / 1.893 | 2.077 / 1.938 / 1.9 |
| aa | 80000 | dryRun | 1 | origin-main#2 → origin-main#1 | 2.385 / 1.927 / 1.893 | 2.077 / 1.938 / 1.9 |
| aa | 80000 | write | 0 | origin-main#1 → origin-main#2 | 2.077 / 1.938 / 1.9 | 1.788 / 1.893 / 1.888 |
| aa | 80000 | write | 1 | origin-main#2 → origin-main#1 | 2.077 / 1.938 / 1.9 | 1.788 / 1.893 / 1.888 |
| ab | 10000 | dryRun | 0 | origin-main → worktree | 1.391 / 1.693 / 1.827 | 1.604 / 1.724 / 1.835 |
| ab | 10000 | dryRun | 1 | worktree → origin-main | 1.391 / 1.693 / 1.827 | 1.604 / 1.724 / 1.835 |
| ab | 10000 | write | 0 | origin-main → worktree | 1.604 / 1.724 / 1.835 | 1.691 / 1.737 / 1.837 |
| ab | 10000 | write | 1 | worktree → origin-main | 1.604 / 1.724 / 1.835 | 1.691 / 1.737 / 1.837 |
| ab | 40000 | dryRun | 0 | origin-main → worktree | 1.691 / 1.737 / 1.837 | 1.868 / 1.782 / 1.847 |
| ab | 40000 | dryRun | 1 | worktree → origin-main | 1.691 / 1.737 / 1.837 | 1.868 / 1.782 / 1.847 |
| ab | 40000 | write | 0 | origin-main → worktree | 1.868 / 1.782 / 1.847 | 2.385 / 1.927 / 1.893 |
| ab | 40000 | write | 1 | worktree → origin-main | 1.868 / 1.782 / 1.847 | 2.385 / 1.927 / 1.893 |
| ab | 80000 | dryRun | 0 | origin-main → worktree | 2.385 / 1.927 / 1.893 | 2.077 / 1.938 / 1.9 |
| ab | 80000 | dryRun | 1 | worktree → origin-main | 2.385 / 1.927 / 1.893 | 2.077 / 1.938 / 1.9 |
| ab | 80000 | write | 0 | origin-main → worktree | 2.077 / 1.938 / 1.9 | 1.788 / 1.893 / 1.888 |
| ab | 80000 | write | 1 | worktree → origin-main | 2.077 / 1.938 / 1.9 | 1.788 / 1.893 / 1.888 |

## 6. 每格中位数

单位：时间 ms、内存 MiB（2^20 字节）、计数为个数。每格每侧 n = 轮数 × 每轮样本数。

### run=aa（origin-main#1 vs origin-main#2）

#### 规模 10000 冷行

阶段：dryRun；每侧样本 n = 6。

| 指标 | origin-main#1 | origin-main#2 | Δ（origin-main#2−origin-main#1） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 306.86 | 305.23 | −1.63 | −0.53% |
| CPU user+system | 424.64 | 423.34 | −1.31 | −0.31% |
| CPU user | 410.02 | 407.27 | −2.75 | −0.67% |
| CPU system | 14.92 | 15.11 | +0.20 | +1.31% |
| 外部采样峰值 RSS | 165.66 | 164.70 | −0.95 | −0.58% |
| 外部采样开始 RSS | 69.69 | 69.84 | +0.15 | +0.21% |
| 外部采样峰值−开始 | 95.86 | 94.84 | −1.02 | −1.07% |
| compact 结束时 RSS（进程内） | 138.07 | 137.03 | −1.04 | −0.75% |
| maxRSS 前（历史高水位） | 71.13 | 71.10 | −0.03 | −0.04% |
| maxRSS 后（历史高水位） | 165.66 | 164.70 | −0.95 | −0.58% |
| maxRSS 增量（高水位下界） | 94.59 | 93.58 | −1.02 | −1.07% |
| GC 后 heapUsed（开始） | 7.33 | 7.33 | +0.00 | +0.00% |
| compact 结束时 heapUsed | 32.05 | 32.30 | +0.24 | +0.75% |
| compact 后 GC heapUsed | 15.68 | 15.68 | +0.00 | +0.00% |
| heapUsed 增量（结束−开始） | 24.73 | 24.97 | +0.24 | +0.97% |
| archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| archive 字节（后） | 5.47 | 5.47 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 154 | 153 | −1 | −0.65% |
| 外部采样最大间隔 | 2.98 | 2.99 | +0.01 | +0.17% |

阶段：write；每侧样本 n = 6。

| 指标 | origin-main#1 | origin-main#2 | Δ（origin-main#2−origin-main#1） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 406.23 | 407.74 | +1.51 | +0.37% |
| CPU user+system | 575.87 | 578.17 | +2.30 | +0.40% |
| CPU user | 540.85 | 542.52 | +1.66 | +0.31% |
| CPU system | 35.32 | 35.44 | +0.12 | +0.33% |
| 外部采样峰值 RSS | 210.14 | 210.21 | +0.07 | +0.03% |
| 外部采样开始 RSS | 69.41 | 69.51 | +0.10 | +0.15% |
| 外部采样峰值−开始 | 141.01 | 140.84 | −0.17 | −0.12% |
| compact 结束时 RSS（进程内） | 184.26 | 184.32 | +0.05 | +0.03% |
| maxRSS 前（历史高水位） | 70.95 | 71.02 | +0.08 | +0.11% |
| maxRSS 后（历史高水位） | 210.23 | 210.25 | +0.02 | +0.01% |
| maxRSS 增量（高水位下界） | 139.48 | 139.27 | −0.20 | −0.15% |
| GC 后 heapUsed（开始） | 7.33 | 7.33 | −0.00 | −0.00% |
| compact 结束时 heapUsed | 38.47 | 38.05 | −0.42 | −1.09% |
| compact 后 GC heapUsed | 15.54 | 15.55 | +0.01 | +0.03% |
| heapUsed 增量（结束−开始） | 31.14 | 30.72 | −0.42 | −1.35% |
| archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| archive 字节（后） | 5.76 | 5.76 | 0.00 | +0.00% |
| 归档树文件数（后） | 27 | 27 | 0.00 | +0.00% |
| 外部采样样本数 | 203.50 | 204 | +0.50 | +0.25% |
| 外部采样最大间隔 | 2.98 | 2.98 | +0.01 | +0.17% |

#### 规模 40000 冷行

阶段：dryRun；每侧样本 n = 6。

| 指标 | origin-main#1 | origin-main#2 | Δ（origin-main#2−origin-main#1） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 1141.48 | 1146.26 | +4.78 | +0.42% |
| CPU user+system | 1486.32 | 1495.38 | +9.07 | +0.61% |
| CPU user | 1453.59 | 1462.85 | +9.27 | +0.64% |
| CPU system | 32.01 | 32.53 | +0.52 | +1.61% |
| 外部采样峰值 RSS | 302.59 | 291.41 | −11.17 | −3.69% |
| 外部采样开始 RSS | 122.29 | 107.41 | −14.88 | −12.17% |
| 外部采样峰值−开始 | 180.53 | 183.27 | +2.73 | +1.51% |
| compact 结束时 RSS（进程内） | 282.30 | 270.63 | −11.67 | −4.13% |
| maxRSS 前（历史高水位） | 122.87 | 109.16 | −13.71 | −11.16% |
| maxRSS 后（历史高水位） | 302.59 | 291.41 | −11.17 | −3.69% |
| maxRSS 增量（高水位下界） | 179.72 | 181.84 | +2.13 | +1.18% |
| GC 后 heapUsed（开始） | 10.39 | 10.39 | +0.00 | +0.00% |
| compact 结束时 heapUsed | 118.42 | 113.30 | −5.12 | −4.33% |
| compact 后 GC heapUsed | 23.67 | 23.66 | −0.01 | −0.04% |
| heapUsed 增量（结束−开始） | 108.04 | 102.91 | −5.12 | −4.74% |
| archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| archive 字节（后） | 21.91 | 21.91 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 571 | 573 | +2 | +0.35% |
| 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.08% |

阶段：write；每侧样本 n = 6。

| 指标 | origin-main#1 | origin-main#2 | Δ（origin-main#2−origin-main#1） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 1555.99 | 1554.38 | −1.61 | −0.10% |
| CPU user+system | 2244.64 | 2238.89 | −5.75 | −0.26% |
| CPU user | 2150.19 | 2143.14 | −7.05 | −0.33% |
| CPU system | 95.82 | 94.20 | −1.62 | −1.69% |
| 外部采样峰值 RSS | 349.20 | 344.98 | −4.22 | −1.21% |
| 外部采样开始 RSS | 120.72 | 114.92 | −5.80 | −4.80% |
| 外部采样峰值−开始 | 228.99 | 232.65 | +3.66 | +1.60% |
| compact 结束时 RSS（进程内） | 328.17 | 324.15 | −4.02 | −1.22% |
| maxRSS 前（历史高水位） | 121.11 | 116.15 | −4.96 | −4.10% |
| maxRSS 后（历史高水位） | 349.20 | 345.01 | −4.20 | −1.20% |
| maxRSS 增量（高水位下界） | 228.79 | 231.80 | +3.01 | +1.31% |
| GC 后 heapUsed（开始） | 10.39 | 10.39 | −0.00 | −0.00% |
| compact 结束时 heapUsed | 75.51 | 75.12 | −0.38 | −0.51% |
| compact 后 GC heapUsed | 20.12 | 20.14 | +0.01 | +0.06% |
| heapUsed 增量（结束−开始） | 65.12 | 64.74 | −0.38 | −0.59% |
| archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| archive 字节（后） | 24.30 | 24.30 | 0.00 | +0.00% |
| 归档树文件数（后） | 103 | 103 | 0.00 | +0.00% |
| 外部采样样本数 | 778.50 | 777.50 | −1 | −0.13% |
| 外部采样最大间隔 | 2.98 | 3.00 | +0.01 | +0.48% |

#### 规模 80000 冷行

阶段：dryRun；每侧样本 n = 6。

| 指标 | origin-main#1 | origin-main#2 | Δ（origin-main#2−origin-main#1） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 2254.88 | 2259.43 | +4.55 | +0.20% |
| CPU user+system | 2856.84 | 2853.75 | −3.09 | −0.11% |
| CPU user | 2797.11 | 2796.98 | −0.12 | −0.00% |
| CPU system | 55.90 | 56.17 | +0.27 | +0.48% |
| 外部采样峰值 RSS | 424.85 | 420.38 | −4.48 | −1.05% |
| 外部采样开始 RSS | 148.09 | 147.92 | −0.17 | −0.12% |
| 外部采样峰值−开始 | 277.63 | 270.76 | −6.88 | −2.48% |
| compact 结束时 RSS（进程内） | 411.30 | 406.88 | −4.41 | −1.07% |
| maxRSS 前（历史高水位） | 148.80 | 148.64 | −0.16 | −0.11% |
| maxRSS 后（历史高水位） | 424.85 | 420.38 | −4.47 | −1.05% |
| maxRSS 增量（高水位下界） | 276.97 | 270.06 | −6.91 | −2.49% |
| GC 后 heapUsed（开始） | 14.42 | 14.42 | 0.00 | +0.00% |
| compact 结束时 heapUsed | 187.25 | 184.22 | −3.03 | −1.62% |
| compact 后 GC heapUsed | 33.40 | 33.40 | +0.01 | +0.02% |
| heapUsed 增量（结束−开始） | 172.82 | 169.79 | −3.03 | −1.75% |
| archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| archive 字节（后） | 43.88 | 43.88 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 1127.50 | 1130 | +2.50 | +0.22% |
| 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.02% |

阶段：write；每侧样本 n = 6。

| 指标 | origin-main#1 | origin-main#2 | Δ（origin-main#2−origin-main#1） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 3123.81 | 3105.23 | −18.58 | −0.59% |
| CPU user+system | 4591.23 | 4530.26 | −60.96 | −1.33% |
| CPU user | 4418.92 | 4356.13 | −62.80 | −1.42% |
| CPU system | 172.40 | 173.05 | +0.65 | +0.38% |
| 外部采样峰值 RSS | 541.82 | 545.16 | +3.34 | +0.62% |
| 外部采样开始 RSS | 150.00 | 151.18 | +1.18 | +0.79% |
| 外部采样峰值−开始 | 393.52 | 395.77 | +2.26 | +0.57% |
| compact 结束时 RSS（进程内） | 524.49 | 528.38 | +3.88 | +0.74% |
| maxRSS 前（历史高水位） | 150.83 | 152.00 | +1.17 | +0.78% |
| maxRSS 后（历史高水位） | 541.82 | 545.16 | +3.34 | +0.62% |
| maxRSS 增量（高水位下界） | 392.69 | 395.14 | +2.45 | +0.62% |
| GC 后 heapUsed（开始） | 14.42 | 14.42 | −0.00 | −0.00% |
| compact 结束时 heapUsed | 142.48 | 143.83 | +1.35 | +0.95% |
| compact 后 GC heapUsed | 26.59 | 26.57 | −0.01 | −0.05% |
| heapUsed 增量（结束−开始） | 128.06 | 129.41 | +1.35 | +1.05% |
| archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| archive 字节（后） | 49.07 | 49.07 | 0.00 | +0.00% |
| 归档树文件数（后） | 201 | 201 | 0.00 | +0.00% |
| 外部采样样本数 | 1562 | 1553 | −9 | −0.58% |
| 外部采样最大间隔 | 3.02 | 2.99 | −0.03 | −1.04% |

### run=ab（origin-main vs worktree）

#### 规模 10000 冷行

阶段：dryRun；每侧样本 n = 6。

| 指标 | origin-main | worktree | Δ（worktree−origin-main） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 309.12 | 272.72 | −36.40 | −11.78% |
| CPU user+system | 427.55 | 385.31 | −42.23 | −9.88% |
| CPU user | 411.84 | 374.52 | −37.32 | −9.06% |
| CPU system | 14.93 | 10.80 | −4.14 | −27.71% |
| 外部采样峰值 RSS | 166.60 | 134.13 | −32.47 | −19.49% |
| 外部采样开始 RSS | 69.48 | 69.48 | 0.00 | +0.00% |
| 外部采样峰值−开始 | 97.20 | 64.73 | −32.46 | −33.40% |
| compact 结束时 RSS（进程内） | 139.12 | 103.11 | −36.01 | −25.88% |
| maxRSS 前（历史高水位） | 70.93 | 71.08 | +0.15 | +0.21% |
| maxRSS 后（历史高水位） | 166.60 | 134.13 | −32.47 | −19.49% |
| maxRSS 增量（高水位下界） | 95.77 | 63.12 | −32.65 | −34.09% |
| GC 后 heapUsed（开始） | 7.33 | 7.35 | +0.02 | +0.29% |
| compact 结束时 heapUsed | 42.25 | 32.28 | −9.97 | −23.59% |
| compact 后 GC heapUsed | 15.72 | 15.67 | −0.05 | −0.32% |
| heapUsed 增量（结束−开始） | 34.92 | 24.93 | −9.99 | −28.60% |
| archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| archive 字节（后） | 5.47 | 5.47 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 155 | 137 | −18 | −11.61% |
| 外部采样最大间隔 | 2.98 | 2.99 | +0.00 | +0.15% |

阶段：write；每侧样本 n = 6。

| 指标 | origin-main | worktree | Δ（worktree−origin-main） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 402.96 | 400.66 | −2.31 | −0.57% |
| CPU user+system | 576.33 | 578.84 | +2.52 | +0.44% |
| CPU user | 540.60 | 543.40 | +2.80 | +0.52% |
| CPU system | 35.27 | 35.44 | +0.17 | +0.49% |
| 外部采样峰值 RSS | 209.08 | 219.08 | +10.00 | +4.78% |
| 外部采样开始 RSS | 69.74 | 69.56 | −0.18 | −0.26% |
| 外部采样峰值−开始 | 139.11 | 149.81 | +10.70 | +7.69% |
| compact 结束时 RSS（进程内） | 183.01 | 193.77 | +10.76 | +5.88% |
| maxRSS 前（历史高水位） | 71.09 | 71.09 | +0.01 | +0.01% |
| maxRSS 后（历史高水位） | 209.08 | 219.12 | +10.04 | +4.80% |
| maxRSS 增量（高水位下界） | 137.85 | 148.27 | +10.41 | +7.55% |
| GC 后 heapUsed（开始） | 7.33 | 7.35 | +0.02 | +0.29% |
| compact 结束时 heapUsed | 38.46 | 37.51 | −0.95 | −2.47% |
| compact 后 GC heapUsed | 15.54 | 15.61 | +0.07 | +0.43% |
| heapUsed 增量（结束−开始） | 31.13 | 30.16 | −0.97 | −3.12% |
| archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| archive 字节（后） | 5.76 | 5.76 | 0.00 | +0.00% |
| 归档树文件数（后） | 27 | 27 | 0.00 | +0.00% |
| 外部采样样本数 | 202 | 200.50 | −1.50 | −0.74% |
| 外部采样最大间隔 | 2.99 | 2.98 | −0.01 | −0.23% |

#### 规模 40000 冷行

阶段：dryRun；每侧样本 n = 6。

| 指标 | origin-main | worktree | Δ（worktree−origin-main） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 1142.12 | 993.95 | −148.18 | −12.97% |
| CPU user+system | 1483.06 | 1313.92 | −169.14 | −11.40% |
| CPU user | 1450.99 | 1284.99 | −166.00 | −11.44% |
| CPU system | 31.95 | 28.51 | −3.44 | −10.77% |
| 外部采样峰值 RSS | 287.67 | 270.31 | −17.36 | −6.03% |
| 外部采样开始 RSS | 113.74 | 114.41 | +0.66 | +0.58% |
| 外部采样峰值−开始 | 178.92 | 154.05 | −24.87 | −13.90% |
| compact 结束时 RSS（进程内） | 266.75 | 247.13 | −19.62 | −7.36% |
| maxRSS 前（历史高水位） | 114.68 | 114.88 | +0.20 | +0.18% |
| maxRSS 后（历史高水位） | 287.67 | 270.32 | −17.35 | −6.03% |
| maxRSS 增量（高水位下界） | 177.98 | 152.90 | −25.08 | −14.09% |
| GC 后 heapUsed（开始） | 10.39 | 10.41 | +0.02 | +0.21% |
| compact 结束时 heapUsed | 122.40 | 86.40 | −36.00 | −29.41% |
| compact 后 GC heapUsed | 23.68 | 23.52 | −0.16 | −0.68% |
| heapUsed 增量（结束−开始） | 112.02 | 75.99 | −36.02 | −32.16% |
| archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| archive 字节（后） | 21.91 | 21.91 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 571.50 | 497 | −74.50 | −13.04% |
| 外部采样最大间隔 | 2.98 | 2.98 | −0.00 | −0.11% |

阶段：write；每侧样本 n = 6。

| 指标 | origin-main | worktree | Δ（worktree−origin-main） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 1553.88 | 1430.93 | −122.96 | −7.91% |
| CPU user+system | 2223.36 | 2061.41 | −161.95 | −7.28% |
| CPU user | 2128.45 | 1969.28 | −159.17 | −7.48% |
| CPU system | 91.45 | 91.00 | −0.44 | −0.49% |
| 外部采样峰值 RSS | 338.38 | 325.27 | −13.11 | −3.87% |
| 外部采样开始 RSS | 111.37 | 120.57 | +9.20 | +8.26% |
| 外部采样峰值−开始 | 228.03 | 205.70 | −22.34 | −9.80% |
| compact 结束时 RSS（进程内） | 316.93 | 303.00 | −13.92 | −4.39% |
| maxRSS 前（历史高水位） | 113.38 | 120.98 | +7.59 | +6.70% |
| maxRSS 后（历史高水位） | 338.45 | 325.30 | −13.14 | −3.88% |
| maxRSS 增量（高水位下界） | 226.66 | 205.31 | −21.35 | −9.42% |
| GC 后 heapUsed（开始） | 10.39 | 10.41 | +0.02 | +0.20% |
| compact 结束时 heapUsed | 75.39 | 66.80 | −8.59 | −11.39% |
| compact 后 GC heapUsed | 20.13 | 20.15 | +0.02 | +0.10% |
| heapUsed 增量（结束−开始） | 65.00 | 56.39 | −8.61 | −13.25% |
| archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| archive 字节（后） | 24.30 | 24.30 | 0.00 | +0.00% |
| 归档树文件数（后） | 103 | 103 | 0.00 | +0.00% |
| 外部采样样本数 | 777 | 716 | −61 | −7.85% |
| 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.09% |

#### 规模 80000 冷行

阶段：dryRun；每侧样本 n = 6。

| 指标 | origin-main | worktree | Δ（worktree−origin-main） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 2251.60 | 1954.10 | −297.50 | −13.21% |
| CPU user+system | 2822.42 | 2423.04 | −399.39 | −14.15% |
| CPU user | 2765.95 | 2378.99 | −386.95 | −13.99% |
| CPU system | 56.48 | 44.33 | −12.15 | −21.52% |
| 外部采样峰值 RSS | 422.94 | 356.76 | −66.18 | −15.65% |
| 外部采样开始 RSS | 153.41 | 147.38 | −6.04 | −3.94% |
| 外部采样峰值−开始 | 271.86 | 209.34 | −62.52 | −23.00% |
| compact 结束时 RSS（进程内） | 409.19 | 337.16 | −72.03 | −17.60% |
| maxRSS 前（历史高水位） | 154.19 | 148.12 | −6.07 | −3.94% |
| maxRSS 后（历史高水位） | 422.94 | 356.76 | −66.18 | −15.65% |
| maxRSS 增量（高水位下界） | 271.15 | 208.60 | −62.55 | −23.07% |
| GC 后 heapUsed（开始） | 14.42 | 14.44 | +0.02 | +0.15% |
| compact 结束时 heapUsed | 184.89 | 138.89 | −45.99 | −24.88% |
| compact 后 GC heapUsed | 33.40 | 33.33 | −0.08 | −0.22% |
| heapUsed 增量（结束−开始） | 170.46 | 124.45 | −46.02 | −26.99% |
| archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| archive 字节（后） | 43.88 | 43.88 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 1126 | 977.50 | −148.50 | −13.19% |
| 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.12% |

阶段：write；每侧样本 n = 6。

| 指标 | origin-main | worktree | Δ（worktree−origin-main） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 3107.81 | 2832.64 | −275.16 | −8.85% |
| CPU user+system | 4561.07 | 4078.15 | −482.92 | −10.59% |
| CPU user | 4386.72 | 3916.52 | −470.20 | −10.72% |
| CPU system | 173.35 | 161.03 | −12.32 | −7.11% |
| 外部采样峰值 RSS | 542.50 | 487.69 | −54.81 | −10.10% |
| 外部采样开始 RSS | 152.98 | 151.47 | −1.52 | −0.99% |
| 外部采样峰值−开始 | 389.94 | 338.84 | −51.09 | −13.10% |
| compact 结束时 RSS（进程内） | 526.93 | 466.02 | −60.91 | −11.56% |
| maxRSS 前（历史高水位） | 153.75 | 152.23 | −1.52 | −0.99% |
| maxRSS 后（历史高水位） | 542.50 | 487.69 | −54.81 | −10.10% |
| maxRSS 增量（高水位下界） | 389.18 | 338.27 | −50.91 | −13.08% |
| GC 后 heapUsed（开始） | 14.42 | 14.44 | +0.02 | +0.15% |
| compact 结束时 heapUsed | 139.99 | 101.61 | −38.39 | −27.42% |
| compact 后 GC heapUsed | 26.58 | 26.67 | +0.09 | +0.33% |
| heapUsed 增量（结束−开始） | 125.57 | 87.16 | −38.41 | −30.59% |
| archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| archive 字节（后） | 49.07 | 49.07 | 0.00 | +0.00% |
| 归档树文件数（后） | 201 | 201 | 0.00 | +0.00% |
| 外部采样样本数 | 1554 | 1416.50 | −137.50 | −8.85% |
| 外部采样最大间隔 | 2.98 | 2.99 | +0.00 | +0.07% |

### 测量敏感性自检（dryRun，模板协议）

自检目标：证实外部采样确实观察到了规划阶段，而不是只观察 setup 高水位。`峰值−开始` 必须与 `heapUsed 增量` 同量级（比值在 0.2–5），且两者随规模单调上升。

| 规模 | 起始 RSS（MiB） | 外部峰值（MiB） | 峰值−开始（MiB） | heapUsed 增量（MiB） | 比值（峰值−开始）/heapUsed | 外部采样数 | 最大间隔（ms） |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10000 | 69.48 | 166.60 | 97.20 | 34.92 | 2.78 | 155 | 2.98 |
| 40000 | 113.74 | 287.67 | 178.92 | 112.02 | 1.60 | 571.5 | 2.98 |
| 80000 | 153.41 | 422.94 | 271.86 | 170.46 | 1.59 | 1126 | 2.98 |

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
| 10000 | dryRun | wall | 306.86 | 305.23 | −1.63 | −0.53% |
| 10000 | dryRun | CPU user+system | 424.64 | 423.34 | −1.31 | −0.31% |
| 10000 | dryRun | CPU user | 410.02 | 407.27 | −2.75 | −0.67% |
| 10000 | dryRun | CPU system | 14.92 | 15.11 | +0.20 | +1.31% |
| 10000 | dryRun | 外部采样峰值 RSS | 165.66 | 164.70 | −0.95 | −0.58% |
| 10000 | dryRun | 外部采样开始 RSS | 69.69 | 69.84 | +0.15 | +0.21% |
| 10000 | dryRun | 外部采样峰值−开始 | 95.86 | 94.84 | −1.02 | −1.07% |
| 10000 | dryRun | compact 结束时 RSS（进程内） | 138.07 | 137.03 | −1.04 | −0.75% |
| 10000 | dryRun | maxRSS 前（历史高水位） | 71.13 | 71.10 | −0.03 | −0.04% |
| 10000 | dryRun | maxRSS 后（历史高水位） | 165.66 | 164.70 | −0.95 | −0.58% |
| 10000 | dryRun | maxRSS 增量（高水位下界） | 94.59 | 93.58 | −1.02 | −1.07% |
| 10000 | dryRun | GC 后 heapUsed（开始） | 7.33 | 7.33 | +0.00 | +0.00% |
| 10000 | dryRun | compact 结束时 heapUsed | 32.05 | 32.30 | +0.24 | +0.75% |
| 10000 | dryRun | compact 后 GC heapUsed | 15.68 | 15.68 | +0.00 | +0.00% |
| 10000 | dryRun | heapUsed 增量（结束−开始） | 24.73 | 24.97 | +0.24 | +0.97% |
| 10000 | dryRun | archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| 10000 | dryRun | archive 字节（后） | 5.47 | 5.47 | 0.00 | +0.00% |
| 10000 | dryRun | 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 10000 | dryRun | 外部采样样本数 | 154 | 153 | −1 | −0.65% |
| 10000 | dryRun | 外部采样最大间隔 | 2.98 | 2.99 | +0.01 | +0.17% |
| 10000 | write | wall | 406.23 | 407.74 | +1.51 | +0.37% |
| 10000 | write | CPU user+system | 575.87 | 578.17 | +2.30 | +0.40% |
| 10000 | write | CPU user | 540.85 | 542.52 | +1.66 | +0.31% |
| 10000 | write | CPU system | 35.32 | 35.44 | +0.12 | +0.33% |
| 10000 | write | 外部采样峰值 RSS | 210.14 | 210.21 | +0.07 | +0.03% |
| 10000 | write | 外部采样开始 RSS | 69.41 | 69.51 | +0.10 | +0.15% |
| 10000 | write | 外部采样峰值−开始 | 141.01 | 140.84 | −0.17 | −0.12% |
| 10000 | write | compact 结束时 RSS（进程内） | 184.26 | 184.32 | +0.05 | +0.03% |
| 10000 | write | maxRSS 前（历史高水位） | 70.95 | 71.02 | +0.08 | +0.11% |
| 10000 | write | maxRSS 后（历史高水位） | 210.23 | 210.25 | +0.02 | +0.01% |
| 10000 | write | maxRSS 增量（高水位下界） | 139.48 | 139.27 | −0.20 | −0.15% |
| 10000 | write | GC 后 heapUsed（开始） | 7.33 | 7.33 | −0.00 | −0.00% |
| 10000 | write | compact 结束时 heapUsed | 38.47 | 38.05 | −0.42 | −1.09% |
| 10000 | write | compact 后 GC heapUsed | 15.54 | 15.55 | +0.01 | +0.03% |
| 10000 | write | heapUsed 增量（结束−开始） | 31.14 | 30.72 | −0.42 | −1.35% |
| 10000 | write | archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| 10000 | write | archive 字节（后） | 5.76 | 5.76 | 0.00 | +0.00% |
| 10000 | write | 归档树文件数（后） | 27 | 27 | 0.00 | +0.00% |
| 10000 | write | 外部采样样本数 | 203.50 | 204 | +0.50 | +0.25% |
| 10000 | write | 外部采样最大间隔 | 2.98 | 2.98 | +0.01 | +0.17% |
| 40000 | dryRun | wall | 1141.48 | 1146.26 | +4.78 | +0.42% |
| 40000 | dryRun | CPU user+system | 1486.32 | 1495.38 | +9.07 | +0.61% |
| 40000 | dryRun | CPU user | 1453.59 | 1462.85 | +9.27 | +0.64% |
| 40000 | dryRun | CPU system | 32.01 | 32.53 | +0.52 | +1.61% |
| 40000 | dryRun | 外部采样峰值 RSS | 302.59 | 291.41 | −11.17 | −3.69% |
| 40000 | dryRun | 外部采样开始 RSS | 122.29 | 107.41 | −14.88 | −12.17% |
| 40000 | dryRun | 外部采样峰值−开始 | 180.53 | 183.27 | +2.73 | +1.51% |
| 40000 | dryRun | compact 结束时 RSS（进程内） | 282.30 | 270.63 | −11.67 | −4.13% |
| 40000 | dryRun | maxRSS 前（历史高水位） | 122.87 | 109.16 | −13.71 | −11.16% |
| 40000 | dryRun | maxRSS 后（历史高水位） | 302.59 | 291.41 | −11.17 | −3.69% |
| 40000 | dryRun | maxRSS 增量（高水位下界） | 179.72 | 181.84 | +2.13 | +1.18% |
| 40000 | dryRun | GC 后 heapUsed（开始） | 10.39 | 10.39 | +0.00 | +0.00% |
| 40000 | dryRun | compact 结束时 heapUsed | 118.42 | 113.30 | −5.12 | −4.33% |
| 40000 | dryRun | compact 后 GC heapUsed | 23.67 | 23.66 | −0.01 | −0.04% |
| 40000 | dryRun | heapUsed 增量（结束−开始） | 108.04 | 102.91 | −5.12 | −4.74% |
| 40000 | dryRun | archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| 40000 | dryRun | archive 字节（后） | 21.91 | 21.91 | 0.00 | +0.00% |
| 40000 | dryRun | 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 40000 | dryRun | 外部采样样本数 | 571 | 573 | +2 | +0.35% |
| 40000 | dryRun | 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.08% |
| 40000 | write | wall | 1555.99 | 1554.38 | −1.61 | −0.10% |
| 40000 | write | CPU user+system | 2244.64 | 2238.89 | −5.75 | −0.26% |
| 40000 | write | CPU user | 2150.19 | 2143.14 | −7.05 | −0.33% |
| 40000 | write | CPU system | 95.82 | 94.20 | −1.62 | −1.69% |
| 40000 | write | 外部采样峰值 RSS | 349.20 | 344.98 | −4.22 | −1.21% |
| 40000 | write | 外部采样开始 RSS | 120.72 | 114.92 | −5.80 | −4.80% |
| 40000 | write | 外部采样峰值−开始 | 228.99 | 232.65 | +3.66 | +1.60% |
| 40000 | write | compact 结束时 RSS（进程内） | 328.17 | 324.15 | −4.02 | −1.22% |
| 40000 | write | maxRSS 前（历史高水位） | 121.11 | 116.15 | −4.96 | −4.10% |
| 40000 | write | maxRSS 后（历史高水位） | 349.20 | 345.01 | −4.20 | −1.20% |
| 40000 | write | maxRSS 增量（高水位下界） | 228.79 | 231.80 | +3.01 | +1.31% |
| 40000 | write | GC 后 heapUsed（开始） | 10.39 | 10.39 | −0.00 | −0.00% |
| 40000 | write | compact 结束时 heapUsed | 75.51 | 75.12 | −0.38 | −0.51% |
| 40000 | write | compact 后 GC heapUsed | 20.12 | 20.14 | +0.01 | +0.06% |
| 40000 | write | heapUsed 增量（结束−开始） | 65.12 | 64.74 | −0.38 | −0.59% |
| 40000 | write | archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| 40000 | write | archive 字节（后） | 24.30 | 24.30 | 0.00 | +0.00% |
| 40000 | write | 归档树文件数（后） | 103 | 103 | 0.00 | +0.00% |
| 40000 | write | 外部采样样本数 | 778.50 | 777.50 | −1 | −0.13% |
| 40000 | write | 外部采样最大间隔 | 2.98 | 3.00 | +0.01 | +0.48% |
| 80000 | dryRun | wall | 2254.88 | 2259.43 | +4.55 | +0.20% |
| 80000 | dryRun | CPU user+system | 2856.84 | 2853.75 | −3.09 | −0.11% |
| 80000 | dryRun | CPU user | 2797.11 | 2796.98 | −0.12 | −0.00% |
| 80000 | dryRun | CPU system | 55.90 | 56.17 | +0.27 | +0.48% |
| 80000 | dryRun | 外部采样峰值 RSS | 424.85 | 420.38 | −4.48 | −1.05% |
| 80000 | dryRun | 外部采样开始 RSS | 148.09 | 147.92 | −0.17 | −0.12% |
| 80000 | dryRun | 外部采样峰值−开始 | 277.63 | 270.76 | −6.88 | −2.48% |
| 80000 | dryRun | compact 结束时 RSS（进程内） | 411.30 | 406.88 | −4.41 | −1.07% |
| 80000 | dryRun | maxRSS 前（历史高水位） | 148.80 | 148.64 | −0.16 | −0.11% |
| 80000 | dryRun | maxRSS 后（历史高水位） | 424.85 | 420.38 | −4.47 | −1.05% |
| 80000 | dryRun | maxRSS 增量（高水位下界） | 276.97 | 270.06 | −6.91 | −2.49% |
| 80000 | dryRun | GC 后 heapUsed（开始） | 14.42 | 14.42 | 0.00 | +0.00% |
| 80000 | dryRun | compact 结束时 heapUsed | 187.25 | 184.22 | −3.03 | −1.62% |
| 80000 | dryRun | compact 后 GC heapUsed | 33.40 | 33.40 | +0.01 | +0.02% |
| 80000 | dryRun | heapUsed 增量（结束−开始） | 172.82 | 169.79 | −3.03 | −1.75% |
| 80000 | dryRun | archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| 80000 | dryRun | archive 字节（后） | 43.88 | 43.88 | 0.00 | +0.00% |
| 80000 | dryRun | 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 80000 | dryRun | 外部采样样本数 | 1127.50 | 1130 | +2.50 | +0.22% |
| 80000 | dryRun | 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.02% |
| 80000 | write | wall | 3123.81 | 3105.23 | −18.58 | −0.59% |
| 80000 | write | CPU user+system | 4591.23 | 4530.26 | −60.96 | −1.33% |
| 80000 | write | CPU user | 4418.92 | 4356.13 | −62.80 | −1.42% |
| 80000 | write | CPU system | 172.40 | 173.05 | +0.65 | +0.38% |
| 80000 | write | 外部采样峰值 RSS | 541.82 | 545.16 | +3.34 | +0.62% |
| 80000 | write | 外部采样开始 RSS | 150.00 | 151.18 | +1.18 | +0.79% |
| 80000 | write | 外部采样峰值−开始 | 393.52 | 395.77 | +2.26 | +0.57% |
| 80000 | write | compact 结束时 RSS（进程内） | 524.49 | 528.38 | +3.88 | +0.74% |
| 80000 | write | maxRSS 前（历史高水位） | 150.83 | 152.00 | +1.17 | +0.78% |
| 80000 | write | maxRSS 后（历史高水位） | 541.82 | 545.16 | +3.34 | +0.62% |
| 80000 | write | maxRSS 增量（高水位下界） | 392.69 | 395.14 | +2.45 | +0.62% |
| 80000 | write | GC 后 heapUsed（开始） | 14.42 | 14.42 | −0.00 | −0.00% |
| 80000 | write | compact 结束时 heapUsed | 142.48 | 143.83 | +1.35 | +0.95% |
| 80000 | write | compact 后 GC heapUsed | 26.59 | 26.57 | −0.01 | −0.05% |
| 80000 | write | heapUsed 增量（结束−开始） | 128.06 | 129.41 | +1.35 | +1.05% |
| 80000 | write | archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| 80000 | write | archive 字节（后） | 49.07 | 49.07 | 0.00 | +0.00% |
| 80000 | write | 归档树文件数（后） | 201 | 201 | 0.00 | +0.00% |
| 80000 | write | 外部采样样本数 | 1562 | 1553 | −9 | −0.58% |
| 80000 | write | 外部采样最大间隔 | 3.02 | 2.99 | −0.03 | −1.04% |

| 指标 | 跨格 |Δ%| 中位数 | 跨格 |Δ%| 最大值 |
| --- | ---: | ---: |
| wall | 0.40% | 0.59% |
| CPU user+system | 0.35% | 1.33% |
| CPU user | 0.48% | 1.42% |
| CPU system | 0.90% | 1.69% |
| 外部采样峰值 RSS | 0.83% | 3.69% |
| 外部采样开始 RSS | 0.50% | 12.17% |
| 外部采样峰值−开始 | 1.29% | 2.48% |
| compact 结束时 RSS（进程内） | 0.91% | 4.13% |
| maxRSS 前（历史高水位） | 0.44% | 11.16% |
| maxRSS 后（历史高水位） | 0.83% | 3.69% |
| maxRSS 增量（高水位下界） | 1.13% | 2.49% |
| GC 后 heapUsed（开始） | 0.00% | 0.00% |
| compact 结束时 heapUsed | 1.02% | 4.33% |
| compact 后 GC heapUsed | 0.04% | 0.06% |
| heapUsed 增量（结束−开始） | 1.20% | 4.74% |
| archive 字节（前） | 0.00% | 0.00% |
| archive 字节（后） | 0.00% | 0.00% |
| 归档树文件数（后） | 0.00% | 0.00% |
| 外部采样样本数 | 0.30% | 0.65% |
| 外部采样最大间隔 | 0.17% | 1.04% |

- 稳定指标（跨格 |Δ%| 中位数 < 2% 且最大值 < 5%）：wall、CPU user+system、CPU user、CPU system、外部采样峰值 RSS、外部采样峰值−开始、compact 结束时 RSS（进程内）、maxRSS 后（历史高水位）、maxRSS 增量（高水位下界）、GC 后 heapUsed（开始）、compact 结束时 heapUsed、compact 后 GC heapUsed、heapUsed 增量（结束−开始）、archive 字节（前）、archive 字节（后）、归档树文件数（后）、外部采样样本数、外部采样最大间隔。
- 高噪声指标（跨格 |Δ%| 中位数 ≥ 5% 或最大值 ≥ 10%）：外部采样开始 RSS、maxRSS 前（历史高水位）。它们不是本基线的主判据：RSS 用绝对外部峰值（其 Δ% 很小）而不是“峰值−开始”（开始基线本身有 ±1–2% 抖动）；heap 用 compact 后 GC 的 heapUsed 与 archive 字节（后者在多轮 A/A 中逐字节相同）。

## 10. 候选显著性判定

阈值（Lead 指定，依据同协议 A/A 基线噪声）：wall |Δ%| > 2%、CPU user+system |Δ%| > 2%、外部采样峰值 RSS |Δ%| > 2.2% 视为超出噪声。同时检查每轮中位数差值的符号是否一致：符号在轮间翻转的差异判为不稳定。

| run | 规模 | 阶段 | wall Δ% | CPU Δ% | 外部峰值 Δ% | 峰值−start Δ% | 轮间符号不一致 | 判定 |
| --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- |
| ab | 10000 | dryRun | −11.78% | −9.88% | −19.49% | −33.40% | 无 | 显著（wall −11.78%、CPU −9.88%、外部峰值 −19.49%） |
| ab | 10000 | write | −0.57% | +0.44% | +4.78% | +7.69% | CPU user+system、外部采样峰值 RSS | 仅轮间不稳定（外部峰值 +4.78%） |
| ab | 40000 | dryRun | −12.97% | −11.40% | −6.03% | −13.90% | 无 | 显著（wall −12.97%、CPU −11.40%、外部峰值 −6.03%） |
| ab | 40000 | write | −7.91% | −7.28% | −3.87% | −9.80% | 无 | 显著（wall −7.91%、CPU −7.28%、外部峰值 −3.87%） |
| ab | 80000 | dryRun | −13.21% | −14.15% | −15.65% | −23.00% | 无 | 显著（wall −13.21%、CPU −14.15%、外部峰值 −15.65%） |
| ab | 80000 | write | −8.85% | −10.59% | −10.10% | −13.10% | 无 | 显著（wall −8.85%、CPU −10.59%、外部峰值 −10.10%） |

## 11. 未测量项与限制

- external RSS peak is a sampling lower bound; a peak shorter than the sampling interval can be missed
- maxRSS delta can be masked by the load-time archive scan high-water mark and is never used as the per-call peak
- synthetic fixed-time corpus (deterministic clock) generated once by the baseline side; not production user data
- no official host domain transaction, fsync, multi-process contention or startup archive-index reconciliation is timed
- OS page cache is not flushed; each sample copies the template fresh (copy is outside the measured window) and A/B/B/A round rotation balances ordering effects
- knowledge groups fit the bounded sourceRefs window; canonical protects outcomes, not terminal promotions
- the external sampler reads a lower bound of resident bytes and does not attribute them to V8 heap vs. native buffers
- 未测量项：per-3ms RSS trace is not persisted (only peak/baseline/delta/count/max gap are recorded)；native (malloc/mmap) vs. V8 heap attribution of the external RSS peak；write-phase OS peak under a pinned heap (unless --pinned-heap is passed)

