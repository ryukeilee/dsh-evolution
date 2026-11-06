# retention/compact 进程外采样基线（A/A 与 A/B）

生成时间：2026-11-06T15:26:43.504Z；总耗时 309.3 s。

本文件由 `scripts/benchmarks/retention-plan-streaming.mjs` 从同一份 JSON 自动生成；所有数值都是本轮实际测量，未引用历史数字。

## 0. 本轮用途

本轮包含不同代码树的两侧：A/A run 用于估计噪声，A/B run 用于候选对比。

**本轮说明**：本报告为最终树 C1+C2 + Sol Loop r1 S1 修复（lib/dockyard-domain/memory.js sha256=0fc7a14d32f1d56bca86e57b5abf6c5f166fb083a25c9bd14a7540d481d7dad7）；C3/C4 已按收益不足撤回，历史数据见 docs/performance/retention-plan-streaming-ab-with-c3.*、retention-plan-streaming-c3-ab.* 与 retention-plan-streaming-c3c4-ab.*。

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
| loadAverageAtStart | 1.38 / 1.597 / 1.799 |
| loadAverageAtEnd | 2.59 / 2.296 / 2.056 |

## 2. 复现命令

从仓库根目录执行：

```sh
node scripts/benchmarks/retention-plan-streaming.mjs --a git:origin/main --b worktree --runs aa,ab --scales 10000,40000,80000 --samples 3 --rounds 2 --phases dryRun,write --out docs/performance/retention-plan-streaming-baseline.json --md docs/performance/retention-plan-streaming-baseline.md
```

本轮实际命令行（含本机绝对路径，仅作记录）：

```
/opt/homebrew/Cellar/node/26.13.0_2/bin/node /Users/ryukeili/GitHub/dsh-evolution/.agents/worktrees/perf/retention-plan-streaming/scripts/benchmarks/retention-plan-streaming.mjs --a git:origin/main --b worktree --runs aa,ab --scales 10000,40000,80000 --samples 3 --rounds 2 --phases dryRun,write --out docs/performance/retention-plan-streaming-ab.json --md docs/performance/retention-plan-streaming-ab.md --note 本报告为最终树 C1+C2 + Sol Loop r1 S1 修复（lib/dockyard-domain/memory.js sha256=0fc7a14d32f1d56bca86e57b5abf6c5f166fb083a25c9bd14a7540d481d7dad7）；C3/C4 已按收益不足撤回，历史数据见 docs/performance/retention-plan-streaming-ab-with-c3.*、retention-plan-streaming-c3-ab.* 与 retention-plan-streaming-c3c4-ab.*。
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
| worktree | `worktree` | worktree | — | `bef0937e8eeca5e99e83a2865519e71b3b8f055dab505f3208c4c6c3de4d79d5` |

treesIdentical（A 与 B 的 lib 树哈希相同，此时 A/B 也是 A/A 复制）：aa=true，ab=false

模板 = `state.json`（canonical 指针 + 空 hot 集合）+ 每个 collection 一个 active archive 文件；由基线侧公开函数生成一次，每个样本由父进程复制。`state sha256` 是模板 state.json 的字节哈希，`archive sha256` 是归档树（文件名 + 每文件 sha256）的哈希。

| 规模（冷行） | 模板文件数 | 模板字节 | archive sha256 | state 字节 | state sha256 | observations | knowledge | cycles | outcomes | promotions | canonical |
| ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10000 | 5 | 5729370 | `8d96bd79d6f6e5e532451298660398d8922e97d43a5bd816c6dee42cfa8e5ee6` | 14493 | `cd0d2297258c907806985f45268d7f06bab34f6d686201fba8c3e9af44ece7bd` | 4000 | 2000 | 2000 | 1000 | 1000 | 63 |
| 40000 | 5 | 22967370 | `147a3f59e49071f865e52d79b1d6e4bd4e63475a68194140b84a62f3c8718521` | 58027 | `0e8b82993cbd93e5b3e15fbb3fc944902b6f2f78f408fdc4b5a0b17283e6e023` | 16000 | 8000 | 8000 | 4000 | 4000 | 250 |
| 80000 | 5 | 46005370 | `e5dded130f074ca2b1ae5b766bc71eef4633c4b4f13304f6eb01c9c370c7b63a` | 116277 | `fa398ca51eeb5fb2e2bfdf9b25d4bf4ee8a577836e52137aa56f34dffa524766` | 32000 | 16000 | 16000 | 8000 | 8000 | 500 |

## 5. 调度与测量窗口 loadavg

每个 (规模, 阶段) 内：2 轮，偶数轮 `[A,B]`，奇数轮 `[B,A]`；每侧每轮 `3` 个独立样本；AA 与 AB 两种 run 按轮交替先后。

每样本测量窗口的 1m loadavg：最小 1.380 / 中位 1.884 / 最大 3.411。1m 均值会吸收本基准自身的子进程 spawn 与 2 ms 外部采样进程，因此它不是外部负载的独立证据；同一 (规模, 阶段) 的 A/A 与 A/B 两侧按轮交替，噪声估计覆盖了这一漂移。

下表的 loadavg 是该 (规模, 阶段) 格开始/结束时的值（不是每轮值）；逐样本值在 JSON 的每一行里。

| run | 规模 | 阶段 | 轮 | order | 格起始 loadavg | 格结束 loadavg |
| --- | ---: | --- | ---: | --- | --- | --- |
| aa | 10000 | dryRun | 0 | origin-main#1 → origin-main#2 | 1.38 / 1.597 / 1.799 | 1.652 / 1.648 / 1.813 |
| aa | 10000 | dryRun | 1 | origin-main#2 → origin-main#1 | 1.38 / 1.597 / 1.799 | 1.652 / 1.648 / 1.813 |
| aa | 10000 | write | 0 | origin-main#1 → origin-main#2 | 1.652 / 1.648 / 1.813 | 1.809 / 1.681 / 1.822 |
| aa | 10000 | write | 1 | origin-main#2 → origin-main#1 | 1.652 / 1.648 / 1.813 | 1.809 / 1.681 / 1.822 |
| aa | 40000 | dryRun | 0 | origin-main#1 → origin-main#2 | 1.809 / 1.681 / 1.822 | 1.829 / 1.703 / 1.824 |
| aa | 40000 | dryRun | 1 | origin-main#2 → origin-main#1 | 1.809 / 1.681 / 1.822 | 1.829 / 1.703 / 1.824 |
| aa | 40000 | write | 0 | origin-main#1 → origin-main#2 | 1.829 / 1.703 / 1.824 | 2.283 / 1.844 / 1.868 |
| aa | 40000 | write | 1 | origin-main#2 → origin-main#1 | 1.829 / 1.703 / 1.824 | 2.283 / 1.844 / 1.868 |
| aa | 80000 | dryRun | 0 | origin-main#1 → origin-main#2 | 2.26 / 1.846 / 1.869 | 3.272 / 2.213 / 2.001 |
| aa | 80000 | dryRun | 1 | origin-main#2 → origin-main#1 | 2.26 / 1.846 / 1.869 | 3.272 / 2.213 / 2.001 |
| aa | 80000 | write | 0 | origin-main#1 → origin-main#2 | 3.272 / 2.213 / 2.001 | 2.59 / 2.296 / 2.056 |
| aa | 80000 | write | 1 | origin-main#2 → origin-main#1 | 3.272 / 2.213 / 2.001 | 2.59 / 2.296 / 2.056 |
| ab | 10000 | dryRun | 0 | origin-main → worktree | 1.38 / 1.597 / 1.799 | 1.652 / 1.648 / 1.813 |
| ab | 10000 | dryRun | 1 | worktree → origin-main | 1.38 / 1.597 / 1.799 | 1.652 / 1.648 / 1.813 |
| ab | 10000 | write | 0 | origin-main → worktree | 1.652 / 1.648 / 1.813 | 1.809 / 1.681 / 1.822 |
| ab | 10000 | write | 1 | worktree → origin-main | 1.652 / 1.648 / 1.813 | 1.809 / 1.681 / 1.822 |
| ab | 40000 | dryRun | 0 | origin-main → worktree | 1.809 / 1.681 / 1.822 | 1.829 / 1.703 / 1.824 |
| ab | 40000 | dryRun | 1 | worktree → origin-main | 1.809 / 1.681 / 1.822 | 1.829 / 1.703 / 1.824 |
| ab | 40000 | write | 0 | origin-main → worktree | 1.829 / 1.703 / 1.824 | 2.283 / 1.844 / 1.868 |
| ab | 40000 | write | 1 | worktree → origin-main | 1.829 / 1.703 / 1.824 | 2.283 / 1.844 / 1.868 |
| ab | 80000 | dryRun | 0 | origin-main → worktree | 2.26 / 1.846 / 1.869 | 3.272 / 2.213 / 2.001 |
| ab | 80000 | dryRun | 1 | worktree → origin-main | 2.26 / 1.846 / 1.869 | 3.272 / 2.213 / 2.001 |
| ab | 80000 | write | 0 | origin-main → worktree | 3.272 / 2.213 / 2.001 | 2.59 / 2.296 / 2.056 |
| ab | 80000 | write | 1 | worktree → origin-main | 3.272 / 2.213 / 2.001 | 2.59 / 2.296 / 2.056 |

## 6. 每格中位数

单位：时间 ms、内存 MiB（2^20 字节）、计数为个数。每格每侧 n = 轮数 × 每轮样本数。

### run=aa（origin-main#1 vs origin-main#2）

#### 规模 10000 冷行

阶段：dryRun；每侧样本 n = 6。

| 指标 | origin-main#1 | origin-main#2 | Δ（origin-main#2−origin-main#1） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 303.78 | 307.05 | +3.27 | +1.08% |
| CPU user+system | 421.73 | 424.22 | +2.49 | +0.59% |
| CPU user | 406.83 | 409.15 | +2.32 | +0.57% |
| CPU system | 14.77 | 15.07 | +0.30 | +2.03% |
| 外部采样峰值 RSS | 166.52 | 165.74 | −0.77 | −0.46% |
| 外部采样开始 RSS | 69.65 | 69.79 | +0.14 | +0.20% |
| 外部采样峰值−开始 | 96.99 | 95.84 | −1.15 | −1.18% |
| compact 结束时 RSS（进程内） | 138.90 | 138.13 | −0.77 | −0.56% |
| maxRSS 前（历史高水位） | 71.07 | 71.10 | +0.03 | +0.04% |
| maxRSS 后（历史高水位） | 166.52 | 165.74 | −0.77 | −0.46% |
| maxRSS 增量（高水位下界） | 95.50 | 94.59 | −0.91 | −0.95% |
| GC 后 heapUsed（开始） | 7.33 | 7.33 | +0.00 | +0.00% |
| compact 结束时 heapUsed | 42.34 | 32.64 | −9.70 | −22.91% |
| compact 后 GC heapUsed | 15.72 | 15.68 | −0.04 | −0.23% |
| heapUsed 增量（结束−开始） | 35.01 | 25.31 | −9.70 | −27.71% |
| archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| archive 字节（后） | 5.47 | 5.47 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 152 | 154 | +2 | +1.32% |
| 外部采样最大间隔 | 2.98 | 2.97 | −0.01 | −0.25% |

阶段：write；每侧样本 n = 6。

| 指标 | origin-main#1 | origin-main#2 | Δ（origin-main#2−origin-main#1） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 403.60 | 404.42 | +0.82 | +0.20% |
| CPU user+system | 576.16 | 574.40 | −1.75 | −0.30% |
| CPU user | 540.40 | 538.14 | −2.26 | −0.42% |
| CPU system | 35.60 | 34.90 | −0.69 | −1.94% |
| 外部采样峰值 RSS | 211.11 | 210.34 | −0.77 | −0.37% |
| 外部采样开始 RSS | 69.78 | 69.74 | −0.04 | −0.06% |
| 外部采样峰值−开始 | 141.27 | 140.59 | −0.67 | −0.48% |
| compact 结束时 RSS（进程内） | 185.15 | 184.46 | −0.69 | −0.37% |
| maxRSS 前（历史高水位） | 71.08 | 71.07 | −0.01 | −0.01% |
| maxRSS 后（历史高水位） | 211.22 | 210.34 | −0.88 | −0.42% |
| maxRSS 增量（高水位下界） | 140.13 | 139.16 | −0.96 | −0.69% |
| GC 后 heapUsed（开始） | 7.33 | 7.33 | 0.00 | +0.00% |
| compact 结束时 heapUsed | 37.87 | 37.69 | −0.18 | −0.46% |
| compact 后 GC heapUsed | 15.54 | 15.54 | −0.00 | −0.00% |
| heapUsed 增量（结束−开始） | 30.54 | 30.37 | −0.18 | −0.58% |
| archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| archive 字节（后） | 5.76 | 5.76 | 0.00 | +0.00% |
| 归档树文件数（后） | 27 | 27 | 0.00 | +0.00% |
| 外部采样样本数 | 202 | 202.50 | +0.50 | +0.25% |
| 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.15% |

#### 规模 40000 冷行

阶段：dryRun；每侧样本 n = 6。

| 指标 | origin-main#1 | origin-main#2 | Δ（origin-main#2−origin-main#1） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 1148.75 | 1143.93 | −4.82 | −0.42% |
| CPU user+system | 1488.79 | 1487.89 | −0.90 | −0.06% |
| CPU user | 1455.25 | 1453.85 | −1.40 | −0.10% |
| CPU system | 33.40 | 32.54 | −0.86 | −2.57% |
| 外部采样峰值 RSS | 303.25 | 292.88 | −10.38 | −3.42% |
| 外部采样开始 RSS | 122.69 | 108.39 | −14.30 | −11.65% |
| 外部采样峰值−开始 | 181.52 | 180.58 | −0.95 | −0.52% |
| compact 结束时 RSS（进程内） | 283.14 | 272.38 | −10.76 | −3.80% |
| maxRSS 前（历史高水位） | 122.89 | 109.69 | −13.20 | −10.74% |
| maxRSS 后（历史高水位） | 303.25 | 292.89 | −10.36 | −3.42% |
| maxRSS 增量（高水位下界） | 181.30 | 179.88 | −1.41 | −0.78% |
| GC 后 heapUsed（开始） | 10.39 | 10.39 | 0.00 | +0.00% |
| compact 结束时 heapUsed | 128.36 | 118.38 | −9.97 | −7.77% |
| compact 后 GC heapUsed | 23.70 | 23.67 | −0.03 | −0.13% |
| heapUsed 增量（结束−开始） | 117.97 | 107.99 | −9.97 | −8.46% |
| archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| archive 字节（后） | 21.91 | 21.91 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 574.50 | 572.50 | −2 | −0.35% |
| 外部采样最大间隔 | 2.98 | 2.98 | −0.00 | −0.10% |

阶段：write；每侧样本 n = 6。

| 指标 | origin-main#1 | origin-main#2 | Δ（origin-main#2−origin-main#1） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 1553.89 | 1549.98 | −3.92 | −0.25% |
| CPU user+system | 2244.27 | 2234.99 | −9.28 | −0.41% |
| CPU user | 2152.06 | 2136.94 | −15.13 | −0.70% |
| CPU system | 92.25 | 94.58 | +2.33 | +2.52% |
| 外部采样峰值 RSS | 342.07 | 354.98 | +12.91 | +3.78% |
| 外部采样开始 RSS | 109.55 | 114.08 | +4.52 | +4.13% |
| 外部采样峰值−开始 | 231.30 | 234.50 | +3.20 | +1.38% |
| compact 结束时 RSS（进程内） | 321.45 | 334.65 | +13.20 | +4.11% |
| maxRSS 前（历史高水位） | 111.20 | 114.89 | +3.70 | +3.32% |
| maxRSS 后（历史高水位） | 342.07 | 355.01 | +12.94 | +3.78% |
| maxRSS 增量（高水位下界） | 230.46 | 234.13 | +3.66 | +1.59% |
| GC 后 heapUsed（开始） | 10.39 | 10.39 | +0.00 | +0.00% |
| compact 结束时 heapUsed | 75.99 | 75.55 | −0.44 | −0.58% |
| compact 后 GC heapUsed | 20.14 | 20.15 | +0.00 | +0.02% |
| heapUsed 增量（结束−开始） | 65.60 | 65.16 | −0.44 | −0.68% |
| archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| archive 字节（后） | 24.30 | 24.30 | 0.00 | +0.00% |
| 归档树文件数（后） | 103 | 103 | 0.00 | +0.00% |
| 外部采样样本数 | 777.50 | 775.50 | −2 | −0.26% |
| 外部采样最大间隔 | 2.98 | 2.98 | +0.01 | +0.21% |

#### 规模 80000 冷行

阶段：dryRun；每侧样本 n = 6。

| 指标 | origin-main#1 | origin-main#2 | Δ（origin-main#2−origin-main#1） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 2250.21 | 2249.49 | −0.73 | −0.03% |
| CPU user+system | 2808.86 | 2804.39 | −4.47 | −0.16% |
| CPU user | 2754.61 | 2748.88 | −5.73 | −0.21% |
| CPU system | 54.23 | 54.54 | +0.30 | +0.56% |
| 外部采样峰值 RSS | 419.94 | 420.24 | +0.30 | +0.07% |
| 外部采样开始 RSS | 152.34 | 148.99 | −3.34 | −2.19% |
| 外部采样峰值−开始 | 267.54 | 273.48 | +5.95 | +2.22% |
| compact 结束时 RSS（进程内） | 406.23 | 406.90 | +0.66 | +0.16% |
| maxRSS 前（历史高水位） | 152.98 | 149.78 | −3.20 | −2.09% |
| maxRSS 后（历史高水位） | 419.94 | 420.24 | +0.30 | +0.07% |
| maxRSS 增量（高水位下界） | 266.80 | 272.79 | +5.99 | +2.25% |
| GC 后 heapUsed（开始） | 14.42 | 14.42 | 0.00 | +0.00% |
| compact 结束时 heapUsed | 184.24 | 184.53 | +0.29 | +0.16% |
| compact 后 GC heapUsed | 33.39 | 33.39 | +0.00 | +0.00% |
| heapUsed 增量（结束−开始） | 169.82 | 170.10 | +0.29 | +0.17% |
| archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| archive 字节（后） | 43.88 | 43.88 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 1125.50 | 1125 | −0.50 | −0.04% |
| 外部采样最大间隔 | 2.99 | 2.98 | −0.01 | −0.37% |

阶段：write；每侧样本 n = 6。

| 指标 | origin-main#1 | origin-main#2 | Δ（origin-main#2−origin-main#1） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 3124.44 | 3123.71 | −0.73 | −0.02% |
| CPU user+system | 4635.90 | 4645.09 | +9.19 | +0.20% |
| CPU user | 4459.95 | 4474.06 | +14.11 | +0.32% |
| CPU system | 173.63 | 173.99 | +0.36 | +0.21% |
| 外部采样峰值 RSS | 538.54 | 541.97 | +3.43 | +0.64% |
| 外部采样开始 RSS | 153.63 | 150.64 | −2.99 | −1.95% |
| 外部采样峰值−开始 | 387.62 | 390.09 | +2.47 | +0.64% |
| compact 结束时 RSS（进程内） | 524.18 | 525.05 | +0.87 | +0.17% |
| maxRSS 前（历史高水位） | 154.43 | 151.51 | −2.92 | −1.89% |
| maxRSS 后（历史高水位） | 538.54 | 541.97 | +3.43 | +0.64% |
| maxRSS 增量（高水位下界） | 386.97 | 389.38 | +2.41 | +0.62% |
| GC 后 heapUsed（开始） | 14.42 | 14.42 | −0.00 | −0.00% |
| compact 结束时 heapUsed | 141.38 | 141.56 | +0.17 | +0.12% |
| compact 后 GC heapUsed | 26.59 | 26.63 | +0.04 | +0.15% |
| heapUsed 增量（结束−开始） | 126.96 | 127.13 | +0.17 | +0.14% |
| archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| archive 字节（后） | 49.07 | 49.07 | 0.00 | +0.00% |
| 归档树文件数（后） | 201 | 201 | 0.00 | +0.00% |
| 外部采样样本数 | 1562.50 | 1562.50 | 0.00 | +0.00% |
| 外部采样最大间隔 | 2.99 | 2.98 | −0.01 | −0.26% |

### run=ab（origin-main vs worktree）

#### 规模 10000 冷行

阶段：dryRun；每侧样本 n = 6。

| 指标 | origin-main | worktree | Δ（worktree−origin-main） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 303.99 | 274.90 | −29.09 | −9.57% |
| CPU user+system | 421.66 | 398.23 | −23.43 | −5.56% |
| CPU user | 406.88 | 386.92 | −19.96 | −4.91% |
| CPU system | 14.77 | 11.11 | −3.66 | −24.79% |
| 外部采样峰值 RSS | 165.68 | 136.88 | −28.80 | −17.39% |
| 外部采样开始 RSS | 69.84 | 69.41 | −0.43 | −0.62% |
| 外部采样峰值−开始 | 95.84 | 67.38 | −28.47 | −29.70% |
| compact 结束时 RSS（进程内） | 138.16 | 105.92 | −32.24 | −23.34% |
| maxRSS 前（历史高水位） | 71.10 | 71.02 | −0.08 | −0.11% |
| maxRSS 后（历史高水位） | 165.68 | 136.88 | −28.80 | −17.39% |
| maxRSS 增量（高水位下界） | 94.58 | 65.82 | −28.76 | −30.41% |
| GC 后 heapUsed（开始） | 7.33 | 7.34 | +0.01 | +0.14% |
| compact 结束时 heapUsed | 32.40 | 36.88 | +4.48 | +13.84% |
| compact 后 GC heapUsed | 15.68 | 15.67 | −0.01 | −0.07% |
| heapUsed 增量（结束−开始） | 25.07 | 29.54 | +4.47 | +17.84% |
| archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| archive 字节（后） | 5.47 | 5.47 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 152 | 138 | −14 | −9.21% |
| 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.14% |

阶段：write；每侧样本 n = 6。

| 指标 | origin-main | worktree | Δ（worktree−origin-main） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 402.69 | 400.97 | −1.71 | −0.43% |
| CPU user+system | 575.06 | 582.87 | +7.82 | +1.36% |
| CPU user | 539.76 | 547.42 | +7.66 | +1.42% |
| CPU system | 35.28 | 35.36 | +0.08 | +0.22% |
| 外部采样峰值 RSS | 209.21 | 219.92 | +10.71 | +5.12% |
| 外部采样开始 RSS | 69.80 | 69.55 | −0.26 | −0.37% |
| 外部采样峰值−开始 | 139.46 | 150.31 | +10.85 | +7.78% |
| compact 结束时 RSS（进程内） | 183.32 | 194.55 | +11.23 | +6.12% |
| maxRSS 前（历史高水位） | 71.11 | 71.07 | −0.04 | −0.05% |
| maxRSS 后（历史高水位） | 209.23 | 219.92 | +10.69 | +5.11% |
| maxRSS 增量（高水位下界） | 138.21 | 148.73 | +10.52 | +7.61% |
| GC 后 heapUsed（开始） | 7.33 | 7.34 | +0.01 | +0.14% |
| compact 结束时 heapUsed | 38.04 | 37.85 | −0.20 | −0.52% |
| compact 后 GC heapUsed | 15.54 | 15.57 | +0.03 | +0.19% |
| heapUsed 增量（结束−开始） | 30.72 | 30.51 | −0.21 | −0.68% |
| archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| archive 字节（后） | 5.76 | 5.76 | 0.00 | +0.00% |
| 归档树文件数（后） | 27 | 27 | 0.00 | +0.00% |
| 外部采样样本数 | 201.50 | 201 | −0.50 | −0.25% |
| 外部采样最大间隔 | 2.99 | 2.98 | −0.01 | −0.26% |

#### 规模 40000 冷行

阶段：dryRun；每侧样本 n = 6。

| 指标 | origin-main | worktree | Δ（worktree−origin-main） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 1147.49 | 1003.53 | −143.96 | −12.55% |
| CPU user+system | 1499.79 | 1324.33 | −175.46 | −11.70% |
| CPU user | 1465.97 | 1295.19 | −170.78 | −11.65% |
| CPU system | 33.82 | 29.56 | −4.26 | −12.60% |
| 外部采样峰值 RSS | 294.88 | 272.54 | −22.34 | −7.58% |
| 外部采样开始 RSS | 113.05 | 114.85 | +1.80 | +1.60% |
| 外部采样峰值−开始 | 179.88 | 152.08 | −27.80 | −15.45% |
| compact 结束时 RSS（进程内） | 274.75 | 249.47 | −25.29 | −9.20% |
| maxRSS 前（历史高水位） | 113.77 | 115.84 | +2.06 | +1.81% |
| maxRSS 后（历史高水位） | 294.88 | 272.54 | −22.34 | −7.58% |
| maxRSS 增量（高水位下界） | 179.23 | 150.86 | −28.37 | −15.83% |
| GC 后 heapUsed（开始） | 10.39 | 10.40 | +0.01 | +0.10% |
| compact 结束时 heapUsed | 122.63 | 100.35 | −22.28 | −18.17% |
| compact 后 GC heapUsed | 23.70 | 23.51 | −0.19 | −0.81% |
| heapUsed 增量（结束−开始） | 112.24 | 89.95 | −22.30 | −19.87% |
| archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| archive 字节（后） | 21.91 | 21.91 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 574 | 502 | −72 | −12.54% |
| 外部采样最大间隔 | 2.97 | 2.98 | +0.00 | +0.15% |

阶段：write；每侧样本 n = 6。

| 指标 | origin-main | worktree | Δ（worktree−origin-main） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 1556.39 | 1452.16 | −104.23 | −6.70% |
| CPU user+system | 2258.66 | 2128.92 | −129.74 | −5.74% |
| CPU user | 2164.45 | 2034.08 | −130.36 | −6.02% |
| CPU system | 96.75 | 94.33 | −2.42 | −2.50% |
| 外部采样峰值 RSS | 352.04 | 329.68 | −22.36 | −6.35% |
| 外部采样开始 RSS | 120.48 | 115.98 | −4.49 | −3.73% |
| 外部采样峰值−开始 | 236.81 | 212.44 | −24.38 | −10.29% |
| compact 结束时 RSS（进程内） | 331.94 | 307.52 | −24.42 | −7.36% |
| maxRSS 前（历史高水位） | 120.84 | 117.01 | −3.84 | −3.17% |
| maxRSS 后（历史高水位） | 352.07 | 329.72 | −22.35 | −6.35% |
| maxRSS 增量（高水位下界） | 235.84 | 211.59 | −24.25 | −10.28% |
| GC 后 heapUsed（开始） | 10.39 | 10.40 | +0.01 | +0.10% |
| compact 结束时 heapUsed | 76.85 | 72.93 | −3.92 | −5.11% |
| compact 后 GC heapUsed | 20.14 | 20.16 | +0.01 | +0.06% |
| heapUsed 增量（结束−开始） | 66.46 | 62.53 | −3.94 | −5.92% |
| archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| archive 字节（后） | 24.30 | 24.30 | 0.00 | +0.00% |
| 归档树文件数（后） | 103 | 103 | 0.00 | +0.00% |
| 外部采样样本数 | 778.50 | 726.50 | −52 | −6.68% |
| 外部采样最大间隔 | 2.99 | 2.98 | −0.01 | −0.33% |

#### 规模 80000 冷行

阶段：dryRun；每侧样本 n = 6。

| 指标 | origin-main | worktree | Δ（worktree−origin-main） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 2255.40 | 1966.88 | −288.52 | −12.79% |
| CPU user+system | 2816.78 | 2430.59 | −386.19 | −13.71% |
| CPU user | 2761.93 | 2386.67 | −375.25 | −13.59% |
| CPU system | 55.40 | 44.91 | −10.48 | −18.92% |
| 外部采样峰值 RSS | 427.31 | 360.13 | −67.19 | −15.72% |
| 外部采样开始 RSS | 149.69 | 146.16 | −3.52 | −2.35% |
| 外部采样峰值−开始 | 278.47 | 213.51 | −64.96 | −23.33% |
| compact 结束时 RSS（进程内） | 413.78 | 340.76 | −73.02 | −17.65% |
| maxRSS 前（历史高水位） | 150.56 | 146.69 | −3.88 | −2.57% |
| maxRSS 后（历史高水位） | 427.31 | 360.13 | −67.19 | −15.72% |
| maxRSS 增量（高水位下界） | 277.73 | 212.81 | −64.91 | −23.37% |
| GC 后 heapUsed（开始） | 14.42 | 14.43 | +0.01 | +0.07% |
| compact 结束时 heapUsed | 185.42 | 133.40 | −52.02 | −28.06% |
| compact 后 GC heapUsed | 33.40 | 33.29 | −0.12 | −0.35% |
| heapUsed 增量（结束−开始） | 171.00 | 118.97 | −52.03 | −30.43% |
| archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| archive 字节（后） | 43.88 | 43.88 | 0.00 | +0.00% |
| 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 外部采样样本数 | 1128 | 984 | −144 | −12.77% |
| 外部采样最大间隔 | 2.98 | 2.98 | −0.00 | −0.11% |

阶段：write；每侧样本 n = 6。

| 指标 | origin-main | worktree | Δ（worktree−origin-main） | Δ% |
| --- | ---: | ---: | ---: | ---: |
| wall | 3125.00 | 2831.56 | −293.44 | −9.39% |
| CPU user+system | 4674.23 | 4195.00 | −479.23 | −10.25% |
| CPU user | 4500.24 | 4034.80 | −465.44 | −10.34% |
| CPU system | 176.83 | 162.09 | −14.75 | −8.34% |
| 外部采样峰值 RSS | 540.80 | 501.01 | −39.80 | −7.36% |
| 外部采样开始 RSS | 146.45 | 150.10 | +3.66 | +2.50% |
| 外部采样峰值−开始 | 392.67 | 348.07 | −44.60 | −11.36% |
| compact 结束时 RSS（进程内） | 526.09 | 482.51 | −43.58 | −8.28% |
| maxRSS 前（历史高水位） | 147.13 | 150.80 | +3.67 | +2.50% |
| maxRSS 后（历史高水位） | 540.84 | 501.03 | −39.80 | −7.36% |
| maxRSS 增量（高水位下界） | 392.18 | 347.31 | −44.87 | −11.44% |
| GC 后 heapUsed（开始） | 14.42 | 14.43 | +0.01 | +0.07% |
| compact 结束时 heapUsed | 143.66 | 138.79 | −4.87 | −3.39% |
| compact 后 GC heapUsed | 26.63 | 26.61 | −0.02 | −0.06% |
| heapUsed 增量（结束−开始） | 129.23 | 124.36 | −4.88 | −3.77% |
| archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| archive 字节（后） | 49.07 | 49.07 | 0.00 | +0.00% |
| 归档树文件数（后） | 201 | 201 | 0.00 | +0.00% |
| 外部采样样本数 | 1563 | 1416 | −147 | −9.40% |
| 外部采样最大间隔 | 2.99 | 2.99 | −0.00 | −0.15% |

### 测量敏感性自检（dryRun，模板协议）

自检目标：证实外部采样确实观察到了规划阶段，而不是只观察 setup 高水位。`峰值−开始` 必须与 `heapUsed 增量` 同量级（比值在 0.2–5），且两者随规模单调上升。

| 规模 | 起始 RSS（MiB） | 外部峰值（MiB） | 峰值−开始（MiB） | heapUsed 增量（MiB） | 比值（峰值−开始）/heapUsed | 外部采样数 | 最大间隔（ms） |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10000 | 69.84 | 165.68 | 95.84 | 25.07 | 3.82 | 152 | 2.98 |
| 40000 | 113.05 | 294.88 | 179.88 | 112.24 | 1.60 | 574 | 2.97 |
| 80000 | 149.69 | 427.31 | 278.47 | 171.00 | 1.63 | 1128 | 2.98 |

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
| 10000 | dryRun | wall | 303.78 | 307.05 | +3.27 | +1.08% |
| 10000 | dryRun | CPU user+system | 421.73 | 424.22 | +2.49 | +0.59% |
| 10000 | dryRun | CPU user | 406.83 | 409.15 | +2.32 | +0.57% |
| 10000 | dryRun | CPU system | 14.77 | 15.07 | +0.30 | +2.03% |
| 10000 | dryRun | 外部采样峰值 RSS | 166.52 | 165.74 | −0.77 | −0.46% |
| 10000 | dryRun | 外部采样开始 RSS | 69.65 | 69.79 | +0.14 | +0.20% |
| 10000 | dryRun | 外部采样峰值−开始 | 96.99 | 95.84 | −1.15 | −1.18% |
| 10000 | dryRun | compact 结束时 RSS（进程内） | 138.90 | 138.13 | −0.77 | −0.56% |
| 10000 | dryRun | maxRSS 前（历史高水位） | 71.07 | 71.10 | +0.03 | +0.04% |
| 10000 | dryRun | maxRSS 后（历史高水位） | 166.52 | 165.74 | −0.77 | −0.46% |
| 10000 | dryRun | maxRSS 增量（高水位下界） | 95.50 | 94.59 | −0.91 | −0.95% |
| 10000 | dryRun | GC 后 heapUsed（开始） | 7.33 | 7.33 | +0.00 | +0.00% |
| 10000 | dryRun | compact 结束时 heapUsed | 42.34 | 32.64 | −9.70 | −22.91% |
| 10000 | dryRun | compact 后 GC heapUsed | 15.72 | 15.68 | −0.04 | −0.23% |
| 10000 | dryRun | heapUsed 增量（结束−开始） | 35.01 | 25.31 | −9.70 | −27.71% |
| 10000 | dryRun | archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| 10000 | dryRun | archive 字节（后） | 5.47 | 5.47 | 0.00 | +0.00% |
| 10000 | dryRun | 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 10000 | dryRun | 外部采样样本数 | 152 | 154 | +2 | +1.32% |
| 10000 | dryRun | 外部采样最大间隔 | 2.98 | 2.97 | −0.01 | −0.25% |
| 10000 | write | wall | 403.60 | 404.42 | +0.82 | +0.20% |
| 10000 | write | CPU user+system | 576.16 | 574.40 | −1.75 | −0.30% |
| 10000 | write | CPU user | 540.40 | 538.14 | −2.26 | −0.42% |
| 10000 | write | CPU system | 35.60 | 34.90 | −0.69 | −1.94% |
| 10000 | write | 外部采样峰值 RSS | 211.11 | 210.34 | −0.77 | −0.37% |
| 10000 | write | 外部采样开始 RSS | 69.78 | 69.74 | −0.04 | −0.06% |
| 10000 | write | 外部采样峰值−开始 | 141.27 | 140.59 | −0.67 | −0.48% |
| 10000 | write | compact 结束时 RSS（进程内） | 185.15 | 184.46 | −0.69 | −0.37% |
| 10000 | write | maxRSS 前（历史高水位） | 71.08 | 71.07 | −0.01 | −0.01% |
| 10000 | write | maxRSS 后（历史高水位） | 211.22 | 210.34 | −0.88 | −0.42% |
| 10000 | write | maxRSS 增量（高水位下界） | 140.13 | 139.16 | −0.96 | −0.69% |
| 10000 | write | GC 后 heapUsed（开始） | 7.33 | 7.33 | 0.00 | +0.00% |
| 10000 | write | compact 结束时 heapUsed | 37.87 | 37.69 | −0.18 | −0.46% |
| 10000 | write | compact 后 GC heapUsed | 15.54 | 15.54 | −0.00 | −0.00% |
| 10000 | write | heapUsed 增量（结束−开始） | 30.54 | 30.37 | −0.18 | −0.58% |
| 10000 | write | archive 字节（前） | 5.47 | 5.47 | 0.00 | +0.00% |
| 10000 | write | archive 字节（后） | 5.76 | 5.76 | 0.00 | +0.00% |
| 10000 | write | 归档树文件数（后） | 27 | 27 | 0.00 | +0.00% |
| 10000 | write | 外部采样样本数 | 202 | 202.50 | +0.50 | +0.25% |
| 10000 | write | 外部采样最大间隔 | 2.98 | 2.98 | +0.00 | +0.15% |
| 40000 | dryRun | wall | 1148.75 | 1143.93 | −4.82 | −0.42% |
| 40000 | dryRun | CPU user+system | 1488.79 | 1487.89 | −0.90 | −0.06% |
| 40000 | dryRun | CPU user | 1455.25 | 1453.85 | −1.40 | −0.10% |
| 40000 | dryRun | CPU system | 33.40 | 32.54 | −0.86 | −2.57% |
| 40000 | dryRun | 外部采样峰值 RSS | 303.25 | 292.88 | −10.38 | −3.42% |
| 40000 | dryRun | 外部采样开始 RSS | 122.69 | 108.39 | −14.30 | −11.65% |
| 40000 | dryRun | 外部采样峰值−开始 | 181.52 | 180.58 | −0.95 | −0.52% |
| 40000 | dryRun | compact 结束时 RSS（进程内） | 283.14 | 272.38 | −10.76 | −3.80% |
| 40000 | dryRun | maxRSS 前（历史高水位） | 122.89 | 109.69 | −13.20 | −10.74% |
| 40000 | dryRun | maxRSS 后（历史高水位） | 303.25 | 292.89 | −10.36 | −3.42% |
| 40000 | dryRun | maxRSS 增量（高水位下界） | 181.30 | 179.88 | −1.41 | −0.78% |
| 40000 | dryRun | GC 后 heapUsed（开始） | 10.39 | 10.39 | 0.00 | +0.00% |
| 40000 | dryRun | compact 结束时 heapUsed | 128.36 | 118.38 | −9.97 | −7.77% |
| 40000 | dryRun | compact 后 GC heapUsed | 23.70 | 23.67 | −0.03 | −0.13% |
| 40000 | dryRun | heapUsed 增量（结束−开始） | 117.97 | 107.99 | −9.97 | −8.46% |
| 40000 | dryRun | archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| 40000 | dryRun | archive 字节（后） | 21.91 | 21.91 | 0.00 | +0.00% |
| 40000 | dryRun | 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 40000 | dryRun | 外部采样样本数 | 574.50 | 572.50 | −2 | −0.35% |
| 40000 | dryRun | 外部采样最大间隔 | 2.98 | 2.98 | −0.00 | −0.10% |
| 40000 | write | wall | 1553.89 | 1549.98 | −3.92 | −0.25% |
| 40000 | write | CPU user+system | 2244.27 | 2234.99 | −9.28 | −0.41% |
| 40000 | write | CPU user | 2152.06 | 2136.94 | −15.13 | −0.70% |
| 40000 | write | CPU system | 92.25 | 94.58 | +2.33 | +2.52% |
| 40000 | write | 外部采样峰值 RSS | 342.07 | 354.98 | +12.91 | +3.78% |
| 40000 | write | 外部采样开始 RSS | 109.55 | 114.08 | +4.52 | +4.13% |
| 40000 | write | 外部采样峰值−开始 | 231.30 | 234.50 | +3.20 | +1.38% |
| 40000 | write | compact 结束时 RSS（进程内） | 321.45 | 334.65 | +13.20 | +4.11% |
| 40000 | write | maxRSS 前（历史高水位） | 111.20 | 114.89 | +3.70 | +3.32% |
| 40000 | write | maxRSS 后（历史高水位） | 342.07 | 355.01 | +12.94 | +3.78% |
| 40000 | write | maxRSS 增量（高水位下界） | 230.46 | 234.13 | +3.66 | +1.59% |
| 40000 | write | GC 后 heapUsed（开始） | 10.39 | 10.39 | +0.00 | +0.00% |
| 40000 | write | compact 结束时 heapUsed | 75.99 | 75.55 | −0.44 | −0.58% |
| 40000 | write | compact 后 GC heapUsed | 20.14 | 20.15 | +0.00 | +0.02% |
| 40000 | write | heapUsed 增量（结束−开始） | 65.60 | 65.16 | −0.44 | −0.68% |
| 40000 | write | archive 字节（前） | 21.91 | 21.91 | 0.00 | +0.00% |
| 40000 | write | archive 字节（后） | 24.30 | 24.30 | 0.00 | +0.00% |
| 40000 | write | 归档树文件数（后） | 103 | 103 | 0.00 | +0.00% |
| 40000 | write | 外部采样样本数 | 777.50 | 775.50 | −2 | −0.26% |
| 40000 | write | 外部采样最大间隔 | 2.98 | 2.98 | +0.01 | +0.21% |
| 80000 | dryRun | wall | 2250.21 | 2249.49 | −0.73 | −0.03% |
| 80000 | dryRun | CPU user+system | 2808.86 | 2804.39 | −4.47 | −0.16% |
| 80000 | dryRun | CPU user | 2754.61 | 2748.88 | −5.73 | −0.21% |
| 80000 | dryRun | CPU system | 54.23 | 54.54 | +0.30 | +0.56% |
| 80000 | dryRun | 外部采样峰值 RSS | 419.94 | 420.24 | +0.30 | +0.07% |
| 80000 | dryRun | 外部采样开始 RSS | 152.34 | 148.99 | −3.34 | −2.19% |
| 80000 | dryRun | 外部采样峰值−开始 | 267.54 | 273.48 | +5.95 | +2.22% |
| 80000 | dryRun | compact 结束时 RSS（进程内） | 406.23 | 406.90 | +0.66 | +0.16% |
| 80000 | dryRun | maxRSS 前（历史高水位） | 152.98 | 149.78 | −3.20 | −2.09% |
| 80000 | dryRun | maxRSS 后（历史高水位） | 419.94 | 420.24 | +0.30 | +0.07% |
| 80000 | dryRun | maxRSS 增量（高水位下界） | 266.80 | 272.79 | +5.99 | +2.25% |
| 80000 | dryRun | GC 后 heapUsed（开始） | 14.42 | 14.42 | 0.00 | +0.00% |
| 80000 | dryRun | compact 结束时 heapUsed | 184.24 | 184.53 | +0.29 | +0.16% |
| 80000 | dryRun | compact 后 GC heapUsed | 33.39 | 33.39 | +0.00 | +0.00% |
| 80000 | dryRun | heapUsed 增量（结束−开始） | 169.82 | 170.10 | +0.29 | +0.17% |
| 80000 | dryRun | archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| 80000 | dryRun | archive 字节（后） | 43.88 | 43.88 | 0.00 | +0.00% |
| 80000 | dryRun | 归档树文件数（后） | 6 | 6 | 0.00 | +0.00% |
| 80000 | dryRun | 外部采样样本数 | 1125.50 | 1125 | −0.50 | −0.04% |
| 80000 | dryRun | 外部采样最大间隔 | 2.99 | 2.98 | −0.01 | −0.37% |
| 80000 | write | wall | 3124.44 | 3123.71 | −0.73 | −0.02% |
| 80000 | write | CPU user+system | 4635.90 | 4645.09 | +9.19 | +0.20% |
| 80000 | write | CPU user | 4459.95 | 4474.06 | +14.11 | +0.32% |
| 80000 | write | CPU system | 173.63 | 173.99 | +0.36 | +0.21% |
| 80000 | write | 外部采样峰值 RSS | 538.54 | 541.97 | +3.43 | +0.64% |
| 80000 | write | 外部采样开始 RSS | 153.63 | 150.64 | −2.99 | −1.95% |
| 80000 | write | 外部采样峰值−开始 | 387.62 | 390.09 | +2.47 | +0.64% |
| 80000 | write | compact 结束时 RSS（进程内） | 524.18 | 525.05 | +0.87 | +0.17% |
| 80000 | write | maxRSS 前（历史高水位） | 154.43 | 151.51 | −2.92 | −1.89% |
| 80000 | write | maxRSS 后（历史高水位） | 538.54 | 541.97 | +3.43 | +0.64% |
| 80000 | write | maxRSS 增量（高水位下界） | 386.97 | 389.38 | +2.41 | +0.62% |
| 80000 | write | GC 后 heapUsed（开始） | 14.42 | 14.42 | −0.00 | −0.00% |
| 80000 | write | compact 结束时 heapUsed | 141.38 | 141.56 | +0.17 | +0.12% |
| 80000 | write | compact 后 GC heapUsed | 26.59 | 26.63 | +0.04 | +0.15% |
| 80000 | write | heapUsed 增量（结束−开始） | 126.96 | 127.13 | +0.17 | +0.14% |
| 80000 | write | archive 字节（前） | 43.88 | 43.88 | 0.00 | +0.00% |
| 80000 | write | archive 字节（后） | 49.07 | 49.07 | 0.00 | +0.00% |
| 80000 | write | 归档树文件数（后） | 201 | 201 | 0.00 | +0.00% |
| 80000 | write | 外部采样样本数 | 1562.50 | 1562.50 | 0.00 | +0.00% |
| 80000 | write | 外部采样最大间隔 | 2.99 | 2.98 | −0.01 | −0.26% |

| 指标 | 跨格 |Δ%| 中位数 | 跨格 |Δ%| 最大值 |
| --- | ---: | ---: |
| wall | 0.23% | 1.08% |
| CPU user+system | 0.25% | 0.59% |
| CPU user | 0.37% | 0.70% |
| CPU system | 1.99% | 2.57% |
| 外部采样峰值 RSS | 0.55% | 3.78% |
| 外部采样开始 RSS | 2.07% | 11.65% |
| 外部采样峰值−开始 | 0.91% | 2.22% |
| compact 结束时 RSS（进程内） | 0.46% | 4.11% |
| maxRSS 前（历史高水位） | 1.99% | 10.74% |
| maxRSS 后（历史高水位） | 0.55% | 3.78% |
| maxRSS 增量（高水位下界） | 0.86% | 2.25% |
| GC 后 heapUsed（开始） | 0.00% | 0.00% |
| compact 结束时 heapUsed | 0.52% | 22.91% |
| compact 后 GC heapUsed | 0.08% | 0.23% |
| heapUsed 增量（结束−开始） | 0.63% | 27.71% |
| archive 字节（前） | 0.00% | 0.00% |
| archive 字节（后） | 0.00% | 0.00% |
| 归档树文件数（后） | 0.00% | 0.00% |
| 外部采样样本数 | 0.25% | 1.32% |
| 外部采样最大间隔 | 0.23% | 0.37% |

- 稳定指标（跨格 |Δ%| 中位数 < 2% 且最大值 < 5%）：wall、CPU user+system、CPU user、CPU system、外部采样峰值 RSS、外部采样峰值−开始、compact 结束时 RSS（进程内）、maxRSS 后（历史高水位）、maxRSS 增量（高水位下界）、GC 后 heapUsed（开始）、compact 后 GC heapUsed、archive 字节（前）、archive 字节（后）、归档树文件数（后）、外部采样样本数、外部采样最大间隔。
- 高噪声指标（跨格 |Δ%| 中位数 ≥ 5% 或最大值 ≥ 10%）：外部采样开始 RSS、maxRSS 前（历史高水位）、compact 结束时 heapUsed、heapUsed 增量（结束−开始）。它们不是本基线的主判据：RSS 用绝对外部峰值（其 Δ% 很小）而不是“峰值−开始”（开始基线本身有 ±1–2% 抖动）；heap 用 compact 后 GC 的 heapUsed 与 archive 字节（后者在多轮 A/A 中逐字节相同）。

## 10. 候选显著性判定

阈值（Lead 指定，依据同协议 A/A 基线噪声）：wall |Δ%| > 2%、CPU user+system |Δ%| > 2%、外部采样峰值 RSS |Δ%| > 2.2% 视为超出噪声。同时检查每轮中位数差值的符号是否一致：符号在轮间翻转的差异判为不稳定。

| run | 规模 | 阶段 | wall Δ% | CPU Δ% | 外部峰值 Δ% | 峰值−start Δ% | 轮间符号不一致 | 判定 |
| --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- |
| ab | 10000 | dryRun | −9.57% | −5.56% | −17.39% | −29.70% | 无 | 显著（wall −9.57%、CPU −5.56%、外部峰值 −17.39%） |
| ab | 10000 | write | −0.43% | +1.36% | +5.12% | +7.78% | wall | 显著（外部峰值 +5.12%） |
| ab | 40000 | dryRun | −12.55% | −11.70% | −7.58% | −15.45% | 无 | 显著（wall −12.55%、CPU −11.70%、外部峰值 −7.58%） |
| ab | 40000 | write | −6.70% | −5.74% | −6.35% | −10.29% | 无 | 显著（wall −6.70%、CPU −5.74%、外部峰值 −6.35%） |
| ab | 80000 | dryRun | −12.79% | −13.71% | −15.72% | −23.33% | 无 | 显著（wall −12.79%、CPU −13.71%、外部峰值 −15.72%） |
| ab | 80000 | write | −9.39% | −10.25% | −7.36% | −11.36% | 无 | 显著（wall −9.39%、CPU −10.25%、外部峰值 −7.36%） |

## 11. 未测量项与限制

- external RSS peak is a sampling lower bound; a peak shorter than the sampling interval can be missed
- maxRSS delta can be masked by the load-time archive scan high-water mark and is never used as the per-call peak
- synthetic fixed-time corpus (deterministic clock) generated once by the baseline side; not production user data
- no official host domain transaction, fsync, multi-process contention or startup archive-index reconciliation is timed
- OS page cache is not flushed; each sample copies the template fresh (copy is outside the measured window) and A/B/B/A round rotation balances ordering effects
- knowledge groups fit the bounded sourceRefs window; canonical protects outcomes, not terminal promotions
- the external sampler reads a lower bound of resident bytes and does not attribute them to V8 heap vs. native buffers
- 未测量项：per-3ms RSS trace is not persisted (only peak/baseline/delta/count/max gap are recorded)；native (malloc/mmap) vs. V8 heap attribution of the external RSS peak；write-phase OS peak under a pinned heap (unless --pinned-heap is passed)
- 历史数据单位更正：本修复（scripts/benchmarks/retention-rss-sampler.py 的 `firstSampleMs`/`lastSampleMs` 输出改为毫秒）之前生成的 `retention-plan-streaming-baseline.json`、`retention-plan-streaming-ab-with-c3.*`、`retention-plan-streaming-c3-ab.*`、`retention-plan-streaming-c3c4-ab.*` 中，`externalFirstSampleMs`/`externalLastSampleMs` 实际单位是**秒**（sampler bug，已修复；外部峰值、`externalRssDeltaBytes`、`externalMaxGapMs` 不受影响，它们本来就是毫秒或字节）。

