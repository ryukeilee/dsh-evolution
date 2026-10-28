# 归档追加往返基准

本基准只调用真实 `openDomainStorage()` 与官方 `DomainFacility`、`JsonStorageBackend`，不改写运行时代码。所有事件与密钥均为合成夹具，数据根位于系统临时目录；不读取正式用户数据。每个样本单独进程，V8 堆限制固定为 4096 MiB。

## 复现

```sh
mkdir -p /tmp/archive-append-roundtrips-base
git archive 6b48609 lib package.json package-lock.json | tar -x -C /tmp/archive-append-roundtrips-base
ln -s "$PWD/node_modules" /tmp/archive-append-roundtrips-base/node_modules
node --max-old-space-size=4096 scripts/benchmarks/archive-append-roundtrips.mjs \
  --a-root /tmp/archive-append-roundtrips-base --b-root . \
  --records 2000,12000,20000 --rounds 3 --delta 2000 --phases aa,ab \
  --out /tmp/archive-append-roundtrips-new.json
```

输出路径必须不存在，避免覆盖先前记录。每个已完成样本立即写入同前缀 `.samples.jsonl`，最终 JSON 包含全部样本与中位数。`--phases aa` 测同一 A 源码三轮交替标签的噪声；`--phases ab` 在显式指定的两个源码树之间交替；`--phases overhead` 在同一 A 源码树比较不包装的 A 与包装的 B，衡量计数器干扰。源码树摘要在测量开始与结束校验，防止中途切换实现。

`cold` 从没有 checkpoint 的签名日志吸收 N 条事件。`incremental` 先通过真实存储路径吸收 N 条，关闭端口后追加 2000 条，再测重新打开的吸收；因此包含既有归档读取与全日志校验，不等同于存活端口单条追加延迟。两种场景在三个规模各跑三轮，每轮奇数 A/B、偶数 B/A，共 72 个独立子进程。

插桩只在被测 `openDomainStorage()` 期间开启，使用固定 map 计数与两次 `performance.now()`；不抓调用栈、不输出逐次调用日志、不改载荷。`fs` 同步 API、`fs/promises` API 及显式 `FileHandle` 方法分别统计调用次数和耗时。它们是 JavaScript API 调用，不是内核 syscall；`readFileSync` 等高层 API 可能包含低层 API，不能把所有耗时相加作为 I/O 总时间。异步耗时包含线程池排队与调度。文件类别来自路径，`other` 包含归档父目录 mkdir。

wall/CPU 覆盖打开端口；RSS 前后值分别记录，`maxRssBytes` 是整个子进程高水位，包含夹具与增量 seed，不能解释为打开操作净增量。完整文件树及 dockyard 都记录最终逐文件字节数和 SHA-256，取值在 close 前、计数器关闭后；索引中的真实更新时间会变化，因此不能期待整个原始树摘要跨进程相等。JSONL 单独比较。

## 本轮记录

正式结果写入 `archive-append-roundtrips-v1-measured.json` 与对应 `.samples.jsonl`。最初 2000 冷吸收 A/A 与其他测试负载短暂重叠，其波动必须单独说明，不能据此判断候选收益。结果补齐后在下文列出有效噪声控制与收益边界。

### 噪声与插桩开销

独立的无并发 `archive-append-roundtrips-controls.json` 在相同 6b48609 基线上补跑 2000 条冷吸收及已有 2000 条再增量 2000 条，均为三轮。冷 A/A 配对 wall 差的绝对最大值为 8.58 ms；增量为 26.47 ms。无包装/有包装冷路径中位数为 510.73 / 530.10 ms（包装约 +3.79%，各配对 +14.01～22.45 ms），增量为 1636.90 / 1640.87 ms（约 +0.24%，各配对 -6.70～21.24 ms）。这不是“零开销”计数器；最终收益必须以无包装 A/B 为准。

12000 冷路径 A/A 为 3467～3586 ms，各配对绝对差最大 109.20 ms；12000 增量为 4769～4819 ms，各配对绝对差最大 24.16 ms。最初 2000 冷路径受其他测试负载影响，样本保留但不用于噪声或收益判断。

### 解释边界

候选没有证明减少 syscall，也没有减少这些被检查的 I/O 动作；它将 tail `stat/open/read/close`、追加前 `mkdir` 与大小 `stat` 从 Promise 线程池调度改为同一位置的同步调用。计数归因描述的是 JavaScript fs API 次数与耗时；不能把“异步 API 次数下降”写成“文件系统调用减少”。这些检查仍逐次执行，没有跨追加的检查结果缓存。

同步 I/O 会占用 Node 主线程，慢盘或异常文件系统的单次调用延迟会直接阻塞事件循环。本基准是本地临时目录中的串行吸收，不包含慢盘、并行交互请求、网络文件系统或事件循环 p99 测量，因此不能外推响应性收益或无阻塞保证。已有大归档上的增量场景仍主要花时间于加载、校验、复制与持久化；冷吸收收益不能外推为所有写入同等比例提速。

## V2 最终无插桩结果

本轮环境为 v26.12.1、darwin/arm64；A 是 6b48609 的 lib，B 是工作树 V2。三个规模、冷吸收与已有归档增量各三轮交替，36 个独立样本；下表均为各侧中位数。wall 与 CPU 为 ms，RSS 为进程终身高水位 MiB（含 setup/seed）。

| 场景 | seed/冷事件数 | wall A / B | wall 降幅 | CPU A / B | RSS A / B |
| --- | ---: | ---: | ---: | ---: | ---: |
| 冷吸收 | 2000 | 510.12 / 435.06 | 14.71% | 554.09 / 460.87 | 109.03 / 107.38 |
| 冷吸收 | 12000 | 3433.95 / 2943.40 | 14.29% | 3637.30 / 3070.28 | 213.28 / 219.03 |
| 冷吸收 | 20000 | 5747.28 / 4939.07 | 14.06% | 6233.40 / 5283.61 | 265.78 / 265.88 |
| 已有归档 +2000 | 2000 | 1617.35 / 1530.39 | 5.38% | 1671.06 / 1583.89 | 180.28 / 181.06 |
| 已有归档 +2000 | 12000 | 4729.14 / 4651.12 | 1.65% | 4907.28 / 4827.31 | 356.41 / 365.36 |
| 已有归档 +2000 | 20000 | 7556.55 / 7394.15 | 2.15% | 7842.31 / 7667.43 | 412.92 / 411.55 |

原始记录见 `archive-append-roundtrips-v2-uninstrumented.json` 和对应 `.samples.jsonl`。冷吸收三轮每个配对均变快，三个规模约 14%～15%；已有归档增量只有 1.65%～5.38%，没有证据支持“所有写入约快 15%”。RSS 未显示稳定下降，12000 增量候选还略高；这不是内存优化结论。

### V1 / V2 插桩对照

| 场景 | 事件数 | V1 wall 降幅 | V2 wall 降幅 |
| --- | ---: | ---: | ---: |
| cold | 2000 | 9.02% | 15.52% |
| cold | 12000 | 5.45% | 11.34% |
| cold | 20000 | 7.58% | 16.57% |
| incremental | 2000 | 2.87% | 5.28% |
| incremental | 12000 | 0.98% | 2.22% |
| incremental | 20000 | 0.28% | 2.01% |

V1 仅同步 tail 检查，V2 再同步追加前 mkdir 与 activeBytes stat。两个批次都各自与同一个基线交替；这张表不是 V1/V2 直接交替实验，不能精确归因二者差额。V1 的 20000 增量只有 0.28%，落在该场景 A/A 噪声内，应视为没有可确认收益；V2 最终收益以无插桩表为准。

### 调用归因（2000 条冷吸收，中位数）

| JavaScript fs API / 类别 | A 次数 | V2 次数 | A / V2 耗时 ms |
| --- | ---: | ---: | ---: |
| promises.appendFile:archive-data | 1950 | 1950 | 70.63 / 72.86 |
| promises.mkdir:other | 1952 | 2 | 32.37 / 0.26 |
| mkdirSync:other | 3 | 1953 | 0.22 / 9.76 |
| promises.stat:archive-data | 3954 | 55 | 33.17 / 1.09 |
| statSync:archive-data | 2024 | 5923 | 7.66 / 15.51 |
| promises.open:archive-data | 1949 | 0 | 42.26 / 0.00 |
| handle.read:archive-data | 1949 | 0 | 14.00 / 0.00 |
| handle.close:archive-data | 1949 | 0 | 12.17 / 0.00 |
| openSync:archive-data | 5 | 1954 | 0.09 / 28.37 |
| readSync:archive-data | 4 | 1953 | 0.31 / 3.04 |
| closeSync:archive-data | 4 | 1953 | 0.00 / 1.69 |

1950 次 append 保持不变；每次 tail 的 stat/open/read/close 与每次追加前 mkdir/stat 仍逐次执行。表中异步与同步调用互换，stat 总次数 5978、mkdir 总次数 1955、显式归档 open/read/close 总次数分别 1954/1953/1953 在两侧一致。这里不计 fs.promises.appendFile 内部未暴露的方法，也不声称捕获全部系统调用。

### 无插桩复现

```sh
node --max-old-space-size=4096 scripts/benchmarks/archive-append-roundtrips.mjs \
  --a-root /tmp/archive-append-roundtrips-base --b-root . \
  --phases ab --instrument no --records 2000,12000,20000 --rounds 3 \
  --out docs/performance/archive-append-roundtrips-v2-uninstrumented.json
```

夹具是同一 target 的合成 measurement-completed 事件，包含 latency/throughput；主要产生 experiments 的冷归档，并经真实知识聚合路径。不代表混合错误事件、大型记录、sealed 段切换或故障恢复延迟。

## 等价性与失败记录

`archive-append-roundtrips-v2-equivalence-fixed-clock.json` 的 12 个样本全部通过：2000/12000/20000 各有冷吸收与已有归档增量，两侧各执行一次吸收后 flush，再关闭/重开两次并各 flush。每次 flush 的 `applied` 都是 0；`duplicates` 为该场景日志中的完整事件数。每个阶段的全局 ledger、完整业务 state、内存 marker 窗口、experiments 查询、归档 JSONL 与索引内容均保持一致；两侧逐阶段结果也一致。小规模 marker 分别为 2000（冷）/4000（增量），其余为既有 4096 条窗口。

验证不删除业务字段。两侧使用同一固定审计时钟：仅验证 worker 的无参数 `new Date()` 固定为 `2026-10-29T00:00:00.000Z`，有参数的 Date 构造和 `Date.now()` 保持真实语义，因此锁协议的 elapsed-time 时钟仍真实。业务 state 只把 `coldArchives` 中 `file`、`activeFile`、`indexFile`、`segments` 的临时根前缀替换为同一个占位，文件与 segment 后缀完整保留；JSON 对象仅排序键以比较语义。索引只规范化顶层及每条 segment 的 `updatedAt`，其他字段保留。所有 marker 字段（包括 `appliedAt`）保留并参与摘要。JSONL 比较原始字节长度和 SHA-256，不做规范化。

第一次等价性实验使用实时审计钟，在第一对 2000 冷吸收后被比较器拒绝：marker 的 `appliedAt` 是各自进程当时的时间，所以 marker 与整体 state 摘要不同；ledger、query、JSONL、索引规范化摘要一致，两侧各自三次 flush/两次重启也一致。两个失败样本完整保存在 `archive-append-roundtrips-v2-equivalence-live-clock-rejected.samples.jsonl`，不计入通过样本。随后改用上述明确的确定性夹具时钟，重新执行全部 12 个样本，最终通过。性能样本没有固定审计时钟。

全部 168 个性能样本形成的 84 对原始 JSONL 与签名日志夹具，也已逐对核对字节长度和 SHA-256，相等；结果见 `archive-append-roundtrips-byte-comparison.json`。完整原始树摘要包含锁 PID、临时路径、checkpoint 文件身份与真实更新时间，跨进程不同是预期；原始摘要仍保留，没有用规范化摘要冒充。

```sh
node --max-old-space-size=4096 scripts/benchmarks/archive-append-roundtrips.mjs \
  --validate --a-root /tmp/archive-append-roundtrips-base --b-root . \
  --records 2000,12000,20000 \
  --out docs/performance/archive-append-roundtrips-v2-equivalence-fixed-clock.json
```

本记录只报告上述实际执行的基准、数据对比和等价性验证；未重跑仓库全量测试或真实宿主验收。脚本为最终版本执行了 Node 语法检查及 `--help` 检查。所有执行均带 4096 MiB V8 堆上限。
