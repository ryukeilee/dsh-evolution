# 每会话 consumer composition 回收：本机基准与收益边界

采集日期：2026-11-26；本机 macOS，Node `v26.13.1`；实现基线提交 `ea0d607`
（`lib/promoted-consumer-gc.js` 与 `lib/promoted-consumer.js` 的集成）。基准脚本：
`scripts/benchmarks/consumer-gc.mjs`。本文只记录本机实际执行过的测量，**不是真实宿主轮次验证**。

## 1. 测量方法

- `--clone <dir>`：把 `<dir>` 用 `fs.cp` 读到 `os.tmpdir()` 下的临时目录，所有回收只作用于副本；
  `--runs <k>` 每一轮都重新复制一份，避免上一轮删除影响下一轮。`preserveTimestamps: true`，
  因此 24h 遗留窗口按原始 mtime 判定。源文件全程只读。
- `--synthetic <N>`：在临时目录生成 N 个孤儿 session（半数 dead-lease + composition，半数无 lease
  且 mtime 为 48h 前）以及固定的活文件（20 个本进程 lease、5 个 recent、5 个外地 hostname、
  5 个坏 JSON lease），再逐轮复制到工作目录。测量三种场景：`scan`（只 `readdir` + `stat`）、
  `keep`（`dryRun: true`，有判定无删除）、`delete`（真实回收）。
- `medianMs` / `maxMs` 是包裹 `await collectConsumerSessionGarbage({...})` 的墙钟耗时
  （`performance.now()`）的中位数与单次最大值；`medianCollectorMs` 是回收函数内部
  `Date.now()` 差值的中位数（整数毫秒分辨率）。`apply()` 中 GC 正是这样一次 `await` 调用，
  所以这组数字是**启动耗时增量**，不是完整 `apply()` / 完整宿主启动耗时。
  夹具生成与复制的时间不计入耗时。
- 脚本的写目标一律经过 `~/.dsh` 拒绝检查；只读复制源允许落在 `~/.dsh` 内。临时目录在进程退出时清理。
- 输出 JSON 的顶层字段即 `filesBefore` / `filesAfter` / `bytesBefore` / `bytesAfter` /
  `medianMs` / 计数 / `decisions` 汇总；`scenarios` 给出各场景逐轮样本。

## 2. 真实目录的只读统计

目录：`~/.dsh/storages/evolution/shared-plugins/consumers/`（只读访问，未写入、未删除）。

| 指标 | 数值 |
| --- | --- |
| 目录项数（`find -mindepth 1 -maxdepth 1`） | 520（全部为普通文件） |
| session composition 数 | 511（`acp` 509、`web` 2） |
| session lease 数 | 0（升级前遗留，全部无 lease） |
| `.consumer-*.tmp` / 稳定文件 | 5 / 4（`acp.json`、`acp.cordis.yml`、`web.json`、`web.cordis.yml`） |
| 逻辑字节数（stat.size 求和） | 334,799 |
| 磁盘占用 `du -sk` | 2,080 KiB（约 2.0 MiB，本机 4 KiB 块） |
| 24h 分界（采集时刻） | 约 2026-11-24T19:50:10Z；452 个 session 文件早于分界，59 个晚于分界 |

## 3. 真实目录副本：回收前后

`--clone <上述目录> --profile acp --runs 5`，每一轮都是独立副本。

| 指标 | 回收前 | 回收后 |
| --- | --- | --- |
| 目录项数 | 520 | 70 |
| 逻辑字节数 | 334,799 | 64,709 |

| 计数（中位数轮次） | 数值 |
| --- | --- |
| `removedCompositions` / `removedLeases` | 450 / 0 |
| `bytesReclaimed` | 270,090 |
| `kept.recent` / `kept.live` / `kept.unproven` / `kept.foreignHost` | 59 / 0 / 0 / 0 |
| `keptOtherProfile` / `ignored` | 2（`web.*` 未碰）/ 9（5 tmp + 4 稳定文件） |
| `failures` / `deferred` / `truncated` | 0 / 0 / false |
| `decisions` | `keep: 59`（`recent`）、`remove: 450`（`legacy-window`） |

**真实目录未被修改，数值来自副本**：运行前后源目录的目录项数（520）、逻辑字节数（334,799）与
`du -sk`（2,080 KiB）一致；脚本不向源目录写入。

耗时（5 次独立副本，`delete` 场景）：

| 指标 | 数值 |
| --- | --- |
| 单次样本（ms） | 43.807, 40.559, 40.613, 38.512, 39.640 |
| `medianMs` / `maxMs` | 40.559 / 43.807 |
| `medianCollectorMs` | 41 |

同一真实目录副本的 `dry-run --runs 5`（只判定、不删除）：文件 520 → 520、字节不变，`decisions`
仍为 450 个 `legacy-window` + 59 个 `recent`；单次样本 6.334, 5.897, 5.767, 5.475, 5.786 ms，
`medianMs` 5.786、`maxMs` 6.334、`medianCollectorMs` 6。可见本次样本中判定本身约 6 ms，其余是
删除 450 个文件的开销。

## 4. 启动耗时增量与合成对照

必需命令 `--synthetic 200 --runs 3`（每轮重新生成副本，三种场景同一夹具）：

| 场景 | `medianMs` | `maxMs` | 单次样本（ms） |
| --- | --- | --- | --- |
| `scan`（readdir + stat） | 3.617 | 3.765 | 3.765, 3.617, 3.427 |
| `keep`（dryRun 判定） | 7.280 | 8.170 | 8.170, 7.280, 7.220 |
| `delete`（真实回收） | 29.246 | 29.299 | 29.299, 29.246, 28.931 |

该轮 `delete` 场景：文件 369 → 69（删除 200 个 composition + 100 个 lease）、逻辑字节 50,053 →
9,453、`bytesReclaimed` 40,600；保留 `live: 20`、`recent: 5`、`unproven: 5`、`foreignHost: 5`，
`keptOtherProfile: 1`、`ignored: 3`、`failures: 5`（坏 JSON lease，按有界错误码 `SyntaxError`
记录）、`deferred: 0`、`truncated: false`；`decisions` 为 keep 35 / remove 200
（`legacy-window: 100`、`stale-lease: 100`）。

N=600 对照 `--synthetic 600 --runs 5`：

| 场景 | `medianMs` | `maxMs` |
| --- | --- | --- |
| `scan` | 9.222 | 9.327 |
| `keep` | 20.434 | 21.193 |
| `delete` | 92.792 | 95.402 |

`delete` 单次样本：93.945, 92.357, 92.792, 95.402, 90.441 ms；`medianCollectorMs` 93。
文件 969 → 69（600 个 composition + 300 个 lease）、逻辑字节 131,253 → 9,453、
`bytesReclaimed` 121,800；保留计数与 N=200 相同，`deferred: 0`、`truncated: false`，
`decisions` 为 keep 35 / remove 600（`stale-lease: 300`、`legacy-window: 300`）。

对比：真实副本 520 项的判定约 6 ms、完整回收中位 40.559 ms；合成 600 孤儿 + 35 活会话
（969 项）的判定约 20 ms、完整回收中位 92.792 ms。删除阶段随待删文件数增长，判定阶段随扫描
条目数增长；两者都没有触及 `maxEntries` 8192 / `maxRemovals` 1024。

## 5. 边界与未验证项

- **本机文件数。** 样本是本机 2026-11-26 的 520 个目录项；其它机器、其它 profile 的文件数不同，
  数字不能外推。合成 N=600 只是规模对照，不是宿主现场。
- **24h 窗口。** 采集当天写入的无 lease 文件 mtime 未超过窗口，判为 `recent` 并保留：本次样本中
  59 个 `acp` 文件因此未被回收；“今天的文件不会被回收”是设计结果，不是遗漏。只有升级前遗留
  （无 lease 且 mtime 超过 24h）的 450 个文件进入 `legacy-window`。
- **文件系统缓存。** 5 轮在同一台 macOS 本机、同一数据根的副本上连续执行，目录项与页缓存处于
  热态；冷启动、外接盘、网络文件系统或其它文件系统的耗时可能明显不同。
- **口径。** `du -sk` 是本机 4 KiB 块的实际占用（2,080 KiB），逻辑字节（334,799）是 `stat.size`
  求和；回收的磁盘块收益取决于块大小与文件布局，不能把 270,090 逻辑字节直接等同于释放的块数。
- **只测 macOS 本机（Node v26.13.1）。** 没有在 CI、Linux、Windows、其它 Node 版本或其它 DSH
  版本上跑；没有真实 Desktop / ACP / Web 入口的启动轮次与 `apply()` 全链路耗时拆分。
- **夹具 / 副本证据不等于宿主验收。** 以上只证明临时夹具与真实目录**副本**上的回收行为与耗时；
  不宣称真实宿主轮次已验证。
- **未做项：** 全量 `npm test` 与 `npm run pack:check`（由 Lead 在集成分支执行）、真实宿主轮次
  验收、跨主机共享数据根场景、`.consumer-*.tmp` 残件回收（不在本任务范围）。

## 6. 复现命令

在仓库根执行（`<仓库根>` 用实际路径替换；不要在正式 `DSH_HOME` 上做回收）：

```sh
cd <仓库根>
node --version

# 真实目录只读统计（不写入）
D="$HOME/.dsh/storages/evolution/shared-plugins/consumers"
find "$D" -mindepth 1 -maxdepth 1 | wc -l
find "$D" -mindepth 1 -maxdepth 1 -type f -exec stat -f%z {} + | awk '{s+=$1} END {print s}'
du -sk "$D"

# 真实目录副本，5 轮独立回收（源文件只读）
node --max-old-space-size=4096 scripts/benchmarks/consumer-gc.mjs --clone "$D" --profile acp --runs 5

# 同一副本的判定-only 对照（不删除）
node --max-old-space-size=4096 scripts/benchmarks/consumer-gc.mjs --clone "$D" --profile acp --dry-run --runs 5

# 必需合成命令
node --max-old-space-size=4096 scripts/benchmarks/consumer-gc.mjs --synthetic 200 --runs 3

# 合成规模对照
node --max-old-space-size=4096 scripts/benchmarks/consumer-gc.mjs --synthetic 600 --runs 5
```

## 7. 原始结果摘要（脚本 stdout 的紧凑形式）

```json
{"mode":"clone","profile":"acp","runs":5,"sourceStats":{"directoryEntries":520,"files":520,"sessionCompositions":511,"sessionLeases":0,"logicalBytes":334799},"filesBefore":520,"filesAfter":70,"bytesBefore":334799,"bytesAfter":64709,"medianMs":40.559,"maxMs":43.807,"samplesMs":[43.807,40.559,40.613,38.512,39.64],"counts":{"status":"ok","scanned":520,"sessions":509,"removedCompositions":450,"removedLeases":0,"bytesReclaimed":270090,"kept":{"live":0,"recent":59,"unproven":0,"foreignHost":0},"keptOtherProfile":2,"ignored":9,"failures":0,"deferred":0,"truncated":false},"decisions":{"actions":{"keep":59,"remove":450},"reasons":{"legacy-window":450,"recent":59}}}
```

```json
{"mode":"clone","profile":"acp","dryRun":true,"runs":5,"filesBefore":520,"filesAfter":520,"bytesBefore":334799,"bytesAfter":334799,"medianMs":5.786,"maxMs":6.334,"samplesMs":[6.334,5.897,5.767,5.475,5.786],"counts":{"status":"ok","scanned":520,"sessions":509,"removedCompositions":0,"removedLeases":0,"bytesReclaimed":0,"kept":{"live":0,"recent":59,"unproven":0,"foreignHost":0},"keptOtherProfile":2,"ignored":9,"failures":0,"deferred":0,"truncated":false},"decisions":{"actions":{"keep":59,"remove":450},"reasons":{"legacy-window":450,"recent":59}}}
```

```json
{"mode":"synthetic","profile":"acp","runs":3,"filesBefore":369,"filesAfter":69,"bytesBefore":50053,"bytesAfter":9453,"medianMs":29.246,"maxMs":29.299,"scenarios":{"scan":{"medianMs":3.617,"maxMs":3.765,"samplesMs":[3.765,3.617,3.427]},"keep":{"medianMs":7.28,"maxMs":8.17,"samplesMs":[8.17,7.28,7.22]},"delete":{"medianMs":29.246,"maxMs":29.299,"samplesMs":[29.299,29.246,28.931],"medianCollectorMs":29}},"counts":{"status":"ok","scanned":369,"sessions":235,"removedCompositions":200,"removedLeases":100,"bytesReclaimed":40600,"kept":{"live":20,"recent":5,"unproven":5,"foreignHost":5},"keptOtherProfile":1,"ignored":3,"failures":5,"deferred":0,"truncated":false},"decisions":{"actions":{"keep":35,"remove":200},"reasons":{"legacy-window":100,"stale-lease":100,"live-lease":20,"recent":5,"foreign-host":5,"unproven-lease":5}}}
```

```json
{"mode":"synthetic","profile":"acp","runs":5,"filesBefore":969,"filesAfter":69,"bytesBefore":131253,"bytesAfter":9453,"medianMs":92.792,"maxMs":95.402,"scenarios":{"scan":{"medianMs":9.222,"maxMs":9.327},"keep":{"medianMs":20.434,"maxMs":21.193},"delete":{"medianMs":92.792,"maxMs":95.402,"samplesMs":[93.945,92.357,92.792,95.402,90.441],"medianCollectorMs":93}},"counts":{"status":"ok","scanned":969,"sessions":635,"removedCompositions":600,"removedLeases":300,"bytesReclaimed":121800,"kept":{"live":20,"recent":5,"unproven":5,"foreignHost":5},"keptOtherProfile":1,"ignored":3,"failures":5,"deferred":0,"truncated":false},"decisions":{"actions":{"keep":35,"remove":600},"reasons":{"stale-lease":300,"legacy-window":300,"live-lease":20,"recent":5,"foreign-host":5,"unproven-lease":5}}}
```
