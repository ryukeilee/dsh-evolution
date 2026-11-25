# 每会话 consumer composition 回收：本机基准与收益边界

采集日期：2026-11-26；本机 macOS，Node `v26.13.1`；实现基线为 R1 修复后的
`lib/promoted-consumer-gc.js`（以 `bf28213` 合入本分支）。基准脚本：
`scripts/benchmarks/consumer-gc.mjs`。本文只记录本机实际执行过的测量，**不是真实宿主轮次验证**。
本轮为复审 R1 后的重跑：下表中的数字全部来自修复后的脚本与实现，替换修复前的旧数字。

## 1. 测量方法

- `--clone <dir>`：先把请求的源路径 `realpath`，再只从解析后的目录用 `fs.cp` 读取到
  `os.tmpdir()` 下的临时目录；每轮复制后、回收前校验 `lstat(work).isDirectory() === true`、
  `realpath(work)` 位于临时根内且 `!== realpath(source)`，否则立即抛错，不对该目录运行回收。
  这排除了“把指向真实目录的符号链接当作 `--clone` 源、复制出链接后误删源文件”。
  源目录内的符号链接条目保持链接（`dereference: false`），清单统计用 `lstat`，不跟随、不计费。
- `--runs <k>` 每一轮都重新复制一份，避免上一轮删除影响下一轮。`preserveTimestamps: true`，
  24h 遗留窗口按原始 mtime 判定。源文件全程只读。
- `--synthetic <N>`：在临时目录生成 N 个孤儿 session（半数 dead-lease + composition，半数无 lease
  且 mtime 为 48h 前）以及固定的活文件（20 个本进程 lease、5 个 recent、5 个外地 hostname、
  5 个坏 JSON lease），再逐轮复制到工作目录。三种场景：`scan`（只 `readdir`，与实现中窗口外
  不做 stat 的扫描阶段一致）、`keep`（`dryRun: true`，有判定无删除）、`delete`（真实回收）。
- `medianMs` / `maxMs` 是包裹 `await collectConsumerSessionGarbage({...})` 的墙钟耗时
  （`performance.now()`）的中位数与单次最大值；`medianCollectorMs` 是回收函数内部
  `Date.now()` 差值的中位数（整数毫秒分辨率）。`apply()` 中 GC 正是这样一次 `await` 调用，
  因此这组数字是**启动耗时增量**，不是完整 `apply()` / 完整宿主启动耗时。夹具生成与复制时间不计入。
- 输出 JSON 顶层为 `filesBefore` / `filesAfter` / `bytesBefore` / `bytesAfter` / `medianMs` /
  计数 / `decisions` 汇总；`scenarios` 给出各场景逐轮样本，`sourceStats` 是源目录的只读清单。
- 本轮样本中 session 数（最多 635）小于 `maxEntries` 8192，因此没有触及轮换窗口；轮换语义由
  `docs/shared-plugins.md` §3.1 描述，本文不另测跨桶覆盖。

## 2. 真实目录的只读统计

目录：`~/.dsh/storages/evolution/shared-plugins/consumers/`（只读访问，未写入、未删除）。
该目录属于正在运行的宿主，采集时刻之间宿主自己会新增会话文件，因此本轮计数比上一轮文档
（520 项 / 334,799 字节）增加；这不是基准写入造成的。

| 指标 | 数值（2026-11-26，R1 重跑） |
| --- | --- |
| 目录项数 | 522（全部为普通文件；符号链接 0） |
| session composition 数 | 513（`acp` 511、`web` 2） |
| session lease 数 | 0（升级前遗留，全部无 lease） |
| `.consumer-*.tmp` / 稳定文件 | 5 / 4（`acp.json`、`acp.cordis.yml`、`web.json`、`web.cordis.yml`） |
| 逻辑字节数（`lstat.size` 求和） | 336,965 |
| 磁盘占用 `du -sk` | 2,088 KiB（约 2.0 MiB，本机 4 KiB 块） |
| 24h 分界（采集时刻） | 约 2026-11-24T20:06:56Z；455 个 session 文件早于分界，58 个晚于分界 |

## 3. 真实目录副本：回收前后

`--clone <上述目录> --profile acp --runs 3`，每轮独立副本。

| 指标 | 回收前 | 回收后 |
| --- | --- | --- |
| 目录项数 | 522 | 69 |
| 普通文件数 | 522 | 69 |
| 逻辑字节数 | 336,965 | 64,166 |

| 计数（中位数轮次） | 数值 |
| --- | --- |
| `removedCompositions` / `removedLeases` | 453 / 0 |
| `bytesReclaimed` | 272,799 |
| `kept.recent` / `kept.live` / `kept.unproven` / `kept.foreignHost` | 58 / 0 / 0 / 0 |
| `keptOtherProfile` / `ignored` | 2（`web.*` 未碰）/ 9（5 tmp + 4 稳定文件） |
| `failures` / `deferred` / `truncated` | 0 / 0 / false |
| `decisions` | `keep: 58`（`recent`）、`remove: 453`（`legacy-window`） |

**真实目录未被修改，数值来自副本**：基准开始时读到的源清单（522 项 / 336,965 字节 / 0 链接）
与运行后只读复查一致；回收只作用于通过 lstat/realpath 校验的临时副本，脚本从不写源目录。

耗时（3 次独立副本，`delete` 场景）：

| 指标 | 数值 |
| --- | --- |
| 单次样本（ms） | 41.240, 40.725, 39.013 |
| `medianMs` / `maxMs` | 40.725 / 41.240 |
| `medianCollectorMs` | 40 |

同一真实目录副本的 `--dry-run --runs 3`（只判定、不删除）：文件 522 → 522、字节不变，
`decisions` 仍为 453 个 `legacy-window` + 58 个 `recent`；单次样本 6.630, 5.876, 5.883 ms，
`medianMs` 5.883、`maxMs` 6.630、`medianCollectorMs` 6。本次样本中判定约 6 ms，其余是删除
453 个文件的开销。

## 4. 启动耗时增量与合成对照

必需命令 `--synthetic 200 --runs 3`（每轮重新复制，三种场景同一夹具）：

| 场景 | `medianMs` | `maxMs` | 单次样本（ms） |
| --- | --- | --- | --- |
| `scan`（只 readdir） | 0.279 | 0.321 | 0.321, 0.279, 0.272 |
| `keep`（dryRun 判定） | 7.605 | 8.312 | 8.312, 7.605, 7.333 |
| `delete`（真实回收） | 28.239 | 28.617 | 28.239, 28.617, 28.079 |

`delete` 场景：文件 369 → 69（删除 200 个 composition + 100 个 lease）、逻辑字节 50,053 →
9,453、`bytesReclaimed` 40,600；保留 `live: 20`、`recent: 5`、`unproven: 5`、`foreignHost: 5`，
`keptOtherProfile: 1`、`ignored: 3`、`failures: 5`（坏 JSON lease，闭集码 `SyntaxError`）、
`deferred: 0`、`truncated: false`；`decisions` 为 keep 35 / remove 200
（`stale-lease: 100`、`legacy-window: 100`）。

N=600 对照 `--synthetic 600 --runs 3`：

| 场景 | `medianMs` | `maxMs` |
| --- | --- | --- |
| `scan` | 0.692 | 0.751 |
| `keep` | 23.065 | 25.198 |
| `delete` | 107.573 | 112.523 |

`delete` 文件 969 → 69（600 个 composition + 300 个 lease）、逻辑字节 131,253 → 9,453、
`bytesReclaimed` 121,800；保留计数与 N=200 一致，`deferred: 0`、`truncated: false`，
`decisions` 为 keep 35 / remove 600（`legacy-window: 300`、`stale-lease: 300`）。

对比：真实副本 522 项的判定约 6 ms、完整回收中位 40.725 ms；合成 600 孤儿 + 35 活会话
（969 项）的判定约 23 ms、完整回收中位 107.573 ms。判定成本随扫描/stat 条目数增长，删除阶段
随待删文件数增长；两者均未触及 `maxEntries` 8192 / `maxRemovals` 1024。

## 5. R1-1 符号链接自检

目的：验证 `--clone` 指向符号链接时不会沿链接删除源目录中的文件；源目录里的符号链接条目也不
被跟随或统计为普通文件。在临时目录构造 fixture（1 个 48h 前的孤儿 composition、1 个稳定文件、
1 个 dangling symlink 形式的 lease），用指向 fixture 的符号链接作为 `--clone` 源运行一次回收。

命令（源 fixture 只读）：

```sh
T=$(mktemp -d); F="$T/fixture"; mkdir -p "$F"
O=$(node -e 'console.log(require("node:crypto").randomUUID())')
S=$(node -e 'console.log(require("node:crypto").randomUUID())')
printf '# orphan\n' > "$F/acp.$O.cordis.yml"; touch -t 202611010000 "$F/acp.$O.cordis.yml"
printf '{}\n' > "$F/acp.json"
ln -s "$T/dangling-target" "$F/acp.$S.lease.json"
ln -s "$F" "$T/link"
digest() { node -e 'const fs=require("fs"),path=require("path"),c=require("crypto"),h=c.createHash("sha256");for(const n of fs.readdirSync(process.argv[1]).sort()){const s=fs.lstatSync(path.join(process.argv[1],n));h.update(n+"|"+s.isSymbolicLink()+"|"+s.size+"|"+s.mtimeMs+"\n");}console.log(h.digest("hex"));' "$1"; }
before=$(digest "$F")
node --max-old-space-size=4096 scripts/benchmarks/consumer-gc.mjs --clone "$T/link" --profile acp --runs 1
after=$(digest "$F"); test "$before" = "$after" && echo 'fixture unchanged'
```

结果摘要（逐字来自该次 stdout）：

| 项 | 结果 |
| --- | --- |
| `requestedSource` / `source` | 指向 fixture 的符号链接 / 解析后的 fixture 目录 |
| `sourceStats` | 目录项 3、普通文件 2、符号链接 1、session composition 1、逻辑字节 12 |
| 副本 `filesBefore` → `filesAfter` | 2 → 1（孤儿 composition 只在副本上被删） |
| 副本 `symlinksBefore` → `symlinksAfter` | 1 → 1（符号链接条目仍在，未被跟随或删除） |
| `counts` | `removedCompositions: 1`、`kept.unproven: 1`、`ignored: 2`、`failures: 0` |
| `decisions` | `legacy-window: 1`、`unproven-lease: 1` |
| fixture lstat 清单摘要 | 运行前后同为 `324e02938e4325901e77dff48f35d75d4de5cd333829402e000dc52f1a20dd17`，目录项仍为 3 |

## 6. 边界与未验证项

- **本机文件数。** 样本是本机 2026-11-26 的 522 个目录项；其它机器、其它 profile 的文件数不同，
  数字不能外推。合成 N=600 只是规模对照，不是宿主现场。
- **24h 窗口。** 采集当天写入的无 lease 文件 mtime 未超过窗口，判为 `recent` 并保留：本次样本中
  58 个 `acp` 文件因此未被回收；“今天的文件不会被回收”是设计结果，不是遗漏。窗口只服务两类
  已结束会话的无 lease composition（升级前遗留、dispose 未证实释放后保留）。
- **文件系统缓存。** 各轮在同一台 macOS 本机、同一数据根的副本上连续执行，目录项与页缓存偏热；
  冷启动、外接盘、网络文件系统或其它文件系统可能明显不同。
- **口径。** `du -sk` 是本机 4 KiB 块的实际占用（2,088 KiB），逻辑字节（336,965）是
  `lstat.size` 求和；回收的磁盘块收益取决于块大小与文件布局。lease 的 `pid` 十进制位数会影响
  lease 文件的逻辑字节数（位数变化可带来每个文件约 1 字节的波动），这是非阻塞的测量噪声来源。
- **只测 macOS 本机（Node v26.13.1）。** 没有在 CI、Linux、Windows、其它 Node 版本或其它 DSH
  版本上跑；没有真实 Desktop / ACP / Web 入口的启动轮次与 `apply()` 全链路耗时拆分。
- **夹具 / 副本证据不等于宿主验收。** 以上只证明临时夹具、符号链接场景与真实目录**副本**上的
  回收行为与耗时；不宣称真实宿主轮次已验证。
- **未做项：** 全量 `npm test` 与 `npm run pack:check`（由 Lead 在集成分支执行）、真实宿主轮次
  验收、跨主机共享数据根场景、`.consumer-*.tmp` 残件回收、`maxEntries` 轮换窗口的计时基准
  （本轮样本量未触发轮换）。

## 7. 复现命令

在仓库根执行（`<仓库根>` 用实际路径替换；不要在正式 `DSH_HOME` 上做回收）：

```sh
cd <仓库根>
node --version

# 真实目录只读统计（不写入）
D="$HOME/.dsh/storages/evolution/shared-plugins/consumers"
find "$D" -mindepth 1 -maxdepth 1 | wc -l
find "$D" -mindepth 1 -maxdepth 1 -type f -exec stat -f%z {} + | awk '{s+=$1} END {print s}'
du -sk "$D"

# 真实目录副本，3 轮独立回收（源文件只读）
node --max-old-space-size=4096 scripts/benchmarks/consumer-gc.mjs --clone "$D" --profile acp --runs 3

# 判定-only 对照（不删除）
node --max-old-space-size=4096 scripts/benchmarks/consumer-gc.mjs --clone "$D" --profile acp --dry-run --runs 3

# 必需合成命令
node --max-old-space-size=4096 scripts/benchmarks/consumer-gc.mjs --synthetic 200 --runs 3

# 合成规模对照
node --max-old-space-size=4096 scripts/benchmarks/consumer-gc.mjs --synthetic 600 --runs 3
```

## 8. 原始结果摘要（脚本 stdout 的紧凑形式）

以下四段均为 R1 修复后重跑的输出（`source` / 临时路径从略）。

```json
{"mode":"clone","profile":"acp","runs":3,"sourceStats":{"directoryEntries":522,"files":522,"symlinks":0,"sessionCompositions":513,"sessionLeases":0,"logicalBytes":336965},"filesBefore":522,"filesAfter":69,"bytesBefore":336965,"bytesAfter":64166,"medianMs":40.725,"maxMs":41.24,"samplesMs":[41.24,40.725,39.013],"medianCollectorMs":40,"counts":{"status":"ok","scanned":522,"sessions":511,"removedCompositions":453,"removedLeases":0,"bytesReclaimed":272799,"kept":{"live":0,"recent":58,"unproven":0,"foreignHost":0},"keptOtherProfile":2,"ignored":9,"failures":0,"deferred":0,"truncated":false},"decisions":{"actions":{"keep":58,"remove":453},"reasons":{"legacy-window":453,"recent":58}}}
```

```json
{"mode":"clone","profile":"acp","dryRun":true,"runs":3,"filesBefore":522,"filesAfter":522,"bytesBefore":336965,"bytesAfter":336965,"medianMs":5.883,"maxMs":6.63,"samplesMs":[6.63,5.876,5.883],"medianCollectorMs":6,"counts":{"status":"ok","scanned":522,"sessions":511,"removedCompositions":0,"removedLeases":0,"bytesReclaimed":0,"kept":{"live":0,"recent":58,"unproven":0,"foreignHost":0},"keptOtherProfile":2,"ignored":9,"failures":0,"deferred":0,"truncated":false},"decisions":{"actions":{"keep":58,"remove":453},"reasons":{"legacy-window":453,"recent":58}}}
```

```json
{"mode":"synthetic","profile":"acp","runs":3,"filesBefore":369,"filesAfter":69,"symlinksBefore":0,"symlinksAfter":0,"bytesBefore":50053,"bytesAfter":9453,"medianMs":28.239,"maxMs":28.617,"scenarios":{"scan":{"medianMs":0.279,"maxMs":0.321,"samplesMs":[0.321,0.279,0.272]},"keep":{"medianMs":7.605,"maxMs":8.312,"samplesMs":[8.312,7.605,7.333],"medianCollectorMs":8},"delete":{"medianMs":28.239,"maxMs":28.617,"samplesMs":[28.239,28.617,28.079],"medianCollectorMs":28}},"counts":{"status":"ok","scanned":369,"sessions":235,"removedCompositions":200,"removedLeases":100,"bytesReclaimed":40600,"kept":{"live":20,"recent":5,"unproven":5,"foreignHost":5},"keptOtherProfile":1,"ignored":3,"failures":5,"deferred":0,"truncated":false},"decisions":{"actions":{"keep":35,"remove":200},"reasons":{"stale-lease":100,"legacy-window":100,"live-lease":20,"unproven-lease":5,"recent":5,"foreign-host":5}}}
```

```json
{"mode":"synthetic","profile":"acp","runs":3,"filesBefore":969,"filesAfter":69,"bytesBefore":131253,"bytesAfter":9453,"medianMs":107.573,"maxMs":112.523,"scenarios":{"scan":{"medianMs":0.692,"maxMs":0.751},"keep":{"medianMs":23.065,"maxMs":25.198},"delete":{"medianMs":107.573,"maxMs":112.523}},"counts":{"status":"ok","scanned":969,"sessions":635,"removedCompositions":600,"removedLeases":300,"bytesReclaimed":121800,"kept":{"live":20,"recent":5,"unproven":5,"foreignHost":5},"keptOtherProfile":1,"ignored":3,"failures":5,"deferred":0,"truncated":false},"decisions":{"actions":{"keep":35,"remove":600},"reasons":{"live-lease":20,"legacy-window":300,"stale-lease":300,"recent":5,"unproven-lease":5,"foreign-host":5}}}
```
