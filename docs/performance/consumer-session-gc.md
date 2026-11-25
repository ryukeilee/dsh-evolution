# 每会话 consumer composition 回收：本机基准与收益边界

采集日期：2026-11-26；本机 macOS，Node `v26.13.1`；实现基线为交付分支提交 `a3862d7`
引入的持久游标版 `lib/promoted-consumer-gc.js`。
基准脚本：`scripts/benchmarks/consumer-gc.mjs`。本文只记录本机实际执行过的测量，
**不是真实宿主轮次验证**。下表数字全部来自 R2 修复后的重跑，替换上一轮（R1）数字。
R3 只改临时根创建前的拒绝检查（不改变回收路径与计时），本轮未重跑基准，数字仍是 R2 实测值。

## 1. 测量方法

- `--clone <dir>`：先把请求的源路径 `realpath`，再只从解析后的目录用 `fs.cp` 读取到
  `os.tmpdir()` 下的临时目录；每轮复制后、回收前校验 `lstat(work).isDirectory() === true`、
  `realpath(work)` 位于临时根内且 `!== realpath(source)`，否则立即抛错，不对该目录运行回收。
  源目录内的符号链接条目保持链接（`dereference: false`），清单统计用 `lstat`，不跟随、不计费。
- 临时根创建前先校验父路径、创建后再校验一次（含 `realpath`）；校验失败会删除已建目录再抛出，
  只有校验通过的临时根才登记退出清理。`TMPDIR` 落在 `~/.dsh` 内时在创建任何目录前就被拒绝。
- `--runs <k>` 每轮重新复制，避免上一轮删除影响下一轮；`preserveTimestamps: true`，24h 窗口按
  原始 mtime 判定。源文件全程只读。
- `--synthetic <N>`：临时目录生成 N 个孤儿 session（半数 dead-lease + composition，半数无 lease
  且 mtime 为 48h 前）及固定活文件（20 个本进程 lease、5 个 recent、5 个外地 hostname、
  5 个坏 JSON lease）。三种场景：`scan`（只 `readdir`，与实现中窗口外不 stat 的扫描阶段一致）、
  `keep`（`dryRun: true`，有判定无删除）、`delete`（真实回收）。
- `medianMs` / `maxMs` 是包裹 `await collectConsumerSessionGarbage({...})` 的墙钟耗时
  （`performance.now()`）的中位数与单次最大值；`medianCollectorMs` 是回收函数内部 `Date.now()`
  差值的中位数（整数毫秒分辨率）。`apply()` 中 GC 正是这样一次 `await` 调用，故为**启动耗时
  增量**，不是完整 `apply()` / 宿主启动耗时。夹具生成与复制时间不计入。
- 输出 JSON 顶层为 `filesBefore` / `filesAfter` / `bytesBefore` / `bytesAfter` / `medianMs` /
  计数 / `decisions` 汇总；`scenarios` 给出逐轮样本，`sourceStats` 是源目录只读清单。
- **本轮所有样本的 session 数（最多 635）都小于 `maxEntries` 8192，`truncated` 均为 false：
  持久游标既不被读取也不被写入，本轮没有测量游标推进 / 串行启动下覆盖全部 stem 的行为。**
  游标语义见 `docs/shared-plugins.md` §3.1，不在这里宣称已验证。

## 2. 真实目录的只读统计

目录：`~/.dsh/storages/evolution/shared-plugins/consumers/`（只读访问，未写入、未删除）。
本轮数值与上一轮采集一致（宿主在这段时间没有新增会话文件）。

| 指标 | 数值（2026-11-26，R2 重跑） |
| --- | --- |
| 目录项数 | 522（全部为普通文件；符号链接 0） |
| session composition 数 | 513（`acp` 511、`web` 2） |
| session lease 数 | 0（升级前遗留，全部无 lease） |
| `.consumer-*.tmp` / 稳定文件 | 5 / 4（`acp.json`、`acp.cordis.yml`、`web.json`、`web.cordis.yml`） |
| 逻辑字节数（`lstat.size` 求和） | 336,965 |
| 磁盘占用 `du -sk` | 2,088 KiB（约 2.0 MiB，本机 4 KiB 块） |
| 24h 分界 | 上一轮采集约为 2026-11-24T20:06:56Z；455 个 session 文件早于分界，58 个晚于分界 |

## 3. 真实目录副本：回收前后

`--clone <上述目录> --profile acp --runs 3`，每轮独立副本。

| 指标 | 回收前 | 回收后 |
| --- | --- | --- |
| 目录项数 / 普通文件数 | 522 | 69 |
| 逻辑字节数 | 336,965 | 64,166 |

| 计数（中位数轮次） | 数值 |
| --- | --- |
| `removedCompositions` / `removedLeases` | 453 / 0 |
| `bytesReclaimed` | 272,799 |
| `kept.recent` / `kept.live` / `kept.unproven` / `kept.foreignHost` | 58 / 0 / 0 / 0 |
| `keptOtherProfile` / `ignored` | 2（`web.*` 未碰）/ 9（5 tmp + 4 稳定文件） |
| `failures` / `deferred` / `truncated` | 0 / 0 / false |
| `decisions` | `keep: 58`（`recent`）、`remove: 453`（`legacy-window`） |

**真实目录未被修改，数值来自副本**：基准开始读到的源清单（522 项 / 336,965 字节 / 0 链接）
与运行后只读复查一致；回收只作用于通过 lstat/realpath 校验的临时副本。

耗时（3 次独立副本，`delete` 场景）：

| 指标 | 数值 |
| --- | --- |
| 单次样本（ms） | 43.198, 40.099, 38.985 |
| `medianMs` / `maxMs` | 40.099 / 43.198 |
| `medianCollectorMs` | 40 |

同一真实目录副本的 `--dry-run --runs 3`（只判定、不删除）：文件 522 → 522、字节不变，
`decisions` 仍为 453 个 `legacy-window` + 58 个 `recent`；单次样本 6.237, 5.504, 5.417 ms，
`medianMs` 5.504、`maxMs` 6.237、`medianCollectorMs` 5。判定约 5.5 ms，其余是删除 453 个文件的开销。

## 4. 启动耗时增量与合成对照

必需命令 `--synthetic 200 --runs 3`（每轮重新复制，三种场景同一夹具）：

| 场景 | `medianMs` | `maxMs` | 单次样本（ms） |
| --- | --- | --- | --- |
| `scan`（只 readdir） | 0.282 | 0.338 | 0.338, 0.282, 0.274 |
| `keep`（dryRun 判定） | 7.434 | 8.122 | 8.122, 7.434, 7.183 |
| `delete`（真实回收） | 39.150 | 39.303 | 31.206, 39.303, 39.150 |

`delete` 场景：文件 369 → 69（删除 200 个 composition + 100 个 lease）、逻辑字节 49,928 →
9,428、`bytesReclaimed` 40,500；保留 `live: 20`、`recent: 5`、`unproven: 5`、`foreignHost: 5`，
`keptOtherProfile: 1`、`ignored: 3`、`failures: 5`（坏 JSON lease，闭集码 `SyntaxError`）、
`deferred: 0`、`truncated: false`；`decisions` 为 keep 35 / remove 200
（`stale-lease: 100`、`legacy-window: 100`）。

N=600 对照 `--synthetic 600 --runs 3`：

| 场景 | `medianMs` | `maxMs` |
| --- | --- | --- |
| `scan` | 0.655 | 0.711 |
| `keep` | 21.718 | 22.357 |
| `delete` | 99.211 | 100.056 |

`delete` 文件 969 → 69（600 个 composition + 300 个 lease）、逻辑字节 130,928 → 9,428、
`bytesReclaimed` 121,500；保留计数与 N=200 一致，`deferred: 0`、`truncated: false`，
`decisions` 为 keep 35 / remove 600（`legacy-window: 300`、`stale-lease: 300`）。

对比：真实副本 522 项的判定约 5.5 ms、完整回收中位 40.099 ms；合成 600 孤儿 + 35 活会话
（969 项）的判定约 21.7 ms、完整回收中位 99.211 ms。判定成本随扫描 / stat 条目数增长，删除阶段
随待删文件数增长。与 R1 重跑相比数字有波动（同一台机器、缓存状态不同），未声称性能回归或收益。

## 5. 符号链接自检（`--clone` 源为链接）

在临时目录构造 fixture（1 个 48h 前孤儿 composition、1 个稳定文件、1 个 dangling symlink 形式的
lease），用指向 fixture 的符号链接作为 `--clone` 源运行一次回收；源 fixture 只读。

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

R2 重跑结果：`requestedSource` 是链接、`source` 解析为 fixture；`sourceStats` 为目录项 3 /
普通文件 2 / 符号链接 1 / 逻辑字节 12；副本 `filesBefore 2 → filesAfter 1`（孤儿只在副本上被删），
`symlinksBefore/After 1 → 1`（链接仍在、未被跟随或删除），`kept.unproven: 1`、`ignored: 2`、
`failures: 0`，decisions 为 `legacy-window: 1` + `unproven-lease: 1`；fixture 的 lstat 清单摘要
运行前后同为 `0bb1a0cacd4018271251228610f3525a6cdbe56ad636c539078e2fd591b12411`，目录项仍为 3。

## 6. TMPDIR 保护自检（R2-2 / R3-1）

把 `HOME` 与 `TMPDIR` 指向假 `~/.dsh`，`--synthetic 1` 必须在创建临时目录之前被拒绝，
且假目录前后都没有 `consumer-gc-*` 残留。

```sh
T=$(mktemp -d); mkdir -p "$T/home/.dsh/tmp"
count() { find "$T/home/.dsh" -maxdepth 1 -name 'consumer-gc-*' | wc -l | tr -d ' '; }
before=$(count)
HOME="$T/home" TMPDIR="$T/home/.dsh/tmp" node --max-old-space-size=4096 scripts/benchmarks/consumer-gc.mjs --synthetic 1 --runs 1; echo "exit=$?"
after=$(count); echo "residue before=$before after=$after"
```

实际结果：`os.tmpdir()` 在该环境下确实解析到 `$T/home/.dsh/tmp`；`before=0`；退出码 `1`；
stderr 为 `consumer-gc benchmark failed: Refusing to write inside <fake home>/.dsh: <fake home>/.dsh/tmp`；
stdout 为 0 字节；`after=0`，假 `~/.dsh/tmp` 下也没有新增目录项。同一脚本在普通 `TMPDIR` 下
`--synthetic 2 --runs 1` 正常完成（文件 72 → 69，`truncated: false`）。

### 6.1 符号链接 TMPDIR：写入前拒绝（R3-1）

外部符号链接 `TMPDIR -> <fake home>/.dsh/tmp` 的词法路径看起来无害，但 realpath 指向受保护目录。
必须在 `mkdtemp` **之前**拒绝，因此 `.dsh` 与 `tmp` 的 mtime 和目录清单摘要都不变。

```sh
T=$(mktemp -d); mkdir -p "$T/home/.dsh/tmp"; ln -s "$T/home/.dsh/tmp" "$T/tmplink"
digest() { node -e 'const fs=require("fs"),path=require("path"),c=require("crypto"),h=c.createHash("sha256");for(const n of fs.readdirSync(process.argv[1]).sort()){const s=fs.lstatSync(path.join(process.argv[1],n));h.update(n+"|"+s.isSymbolicLink()+"|"+s.isDirectory()+"|"+s.size+"|"+s.mtimeMs+"\n");}console.log(h.digest("hex"));' "$1"; }
dm0=$(stat -f %m "$T/home/.dsh"); tm0=$(stat -f %m "$T/home/.dsh/tmp")
dd0=$(digest "$T/home/.dsh"); td0=$(digest "$T/home/.dsh/tmp")
HOME="$T/home" TMPDIR="$T/tmplink" node --max-old-space-size=4096 scripts/benchmarks/consumer-gc.mjs --synthetic 1 --runs 1; echo "exit=$?"
echo "mtime $dm0 -> $(stat -f %m "$T/home/.dsh") / $tm0 -> $(stat -f %m "$T/home/.dsh/tmp")"
echo "digest $dd0 -> $(digest "$T/home/.dsh") / $td0 -> $(digest "$T/home/.dsh/tmp")"
```

实际结果（逐字）：退出码 `1`；stderr 同为 `consumer-gc benchmark failed: Refusing to write inside
<fake home>/.dsh: <fake home>/.dsh/tmp`；stdout 0 字节；
`.dsh` mtime `1795638103 → 1795638103`、`tmp` mtime `1795638103 → 1795638103`；
`.dsh` 清单摘要 `0fdc0399d66a4032b953d46c8b1d865ac7602c09c1c50dcdccdd55e32121de3c` 前后相同；
`tmp` 清单摘要 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` 前后相同；
`consumer-gc-*` 残留数 `0`。这是“写入前拒绝”的证据，不只是“无残留”。

## 7. 边界与未验证项

- **本机文件数。** 样本是本机 2026-11-26 的 522 个目录项；其它机器 / profile 不可外推。
  合成 N=600 只是规模对照，不是宿主现场。
- **24h 窗口。** 窗口作用于**任何**无 lease 的 composition：常见来源是已结束会话（升级前遗留、
  dispose 未证实释放后保留），但 lease 写失败且会话仍存活时也会落入窗口，这是已知残余风险；
  删除只影响该文件本身，已挂载行不受影响。今天写入的无 lease 文件 mtime 未超过窗口，判为
  `recent` 并保留（本次 58 个）。
- **持久游标未触发。** 所有样本 `truncated: false`，没有读写
  `.consumer-session-gc-cursor-<profile>.json`；本轮不提供游标推进 / 串行覆盖全部 stem 的计时证据。
- **文件系统缓存。** 各轮在同一台 macOS 本机连续执行，目录项与页缓存偏热；冷启动、外接盘、
  网络文件系统可能明显不同。R2 与 R1 数字的波动不解释为回归或改进。
- **口径。** `du -sk` 是本机 4 KiB 块的实际占用（2,088 KiB），逻辑字节（336,965）是
  `lstat.size` 求和；lease 的 `pid` 十进制位数会影响 lease 文件的逻辑字节数（位数变化带来
  每个文件约 1 字节的波动），是非阻塞的测量噪声来源。
- **只测 macOS 本机（Node v26.13.1）。** 未在 CI / Linux / Windows / 其它 Node 或 DSH 版本上跑；
  没有真实 Desktop / ACP / Web 入口启动轮次与 `apply()` 全链路耗时拆分。
- **夹具 / 副本证据不等于宿主验收。** 不宣称真实宿主轮次已验证。
- **未做项：** 全量 `npm test` / `npm run pack:check`（Lead 在集成分支执行）、真实宿主轮次、
  跨主机共享数据根、`.consumer-*.tmp` 残件回收、持久游标轮换的计时基准。

## 8. 复现命令

在仓库根执行（`<仓库根>` 用实际路径替换；不要在正式 `DSH_HOME` 上做回收）：

```sh
cd <仓库根>
node --version

D="$HOME/.dsh/storages/evolution/shared-plugins/consumers"
find "$D" -mindepth 1 -maxdepth 1 | wc -l
find "$D" -mindepth 1 -maxdepth 1 -type f -exec stat -f%z {} + | awk '{s+=$1} END {print s}'
du -sk "$D"

node --max-old-space-size=4096 scripts/benchmarks/consumer-gc.mjs --clone "$D" --profile acp --runs 3
node --max-old-space-size=4096 scripts/benchmarks/consumer-gc.mjs --clone "$D" --profile acp --dry-run --runs 3
node --max-old-space-size=4096 scripts/benchmarks/consumer-gc.mjs --synthetic 200 --runs 3
node --max-old-space-size=4096 scripts/benchmarks/consumer-gc.mjs --synthetic 600 --runs 3
```

符号链接自检见 §5，TMPDIR 保护自检见 §6。

## 9. 原始结果摘要（脚本 stdout 的紧凑形式）

以下四段均为 R2 修复后重跑（`source` / 临时路径从略）。

```json
{"mode":"clone","profile":"acp","runs":3,"sourceStats":{"directoryEntries":522,"files":522,"symlinks":0,"sessionCompositions":513,"sessionLeases":0,"logicalBytes":336965},"filesBefore":522,"filesAfter":69,"bytesBefore":336965,"bytesAfter":64166,"medianMs":40.099,"maxMs":43.198,"samplesMs":[43.198,40.099,38.985],"medianCollectorMs":40,"counts":{"status":"ok","scanned":522,"sessions":511,"removedCompositions":453,"removedLeases":0,"bytesReclaimed":272799,"kept":{"live":0,"recent":58,"unproven":0,"foreignHost":0},"keptOtherProfile":2,"ignored":9,"failures":0,"deferred":0,"truncated":false},"decisions":{"actions":{"keep":58,"remove":453},"reasons":{"legacy-window":453,"recent":58}}}
```

```json
{"mode":"clone","profile":"acp","dryRun":true,"runs":3,"filesBefore":522,"filesAfter":522,"bytesBefore":336965,"bytesAfter":336965,"medianMs":5.504,"maxMs":6.237,"samplesMs":[6.237,5.504,5.417],"medianCollectorMs":5,"counts":{"status":"ok","scanned":522,"sessions":511,"removedCompositions":0,"removedLeases":0,"bytesReclaimed":0,"kept":{"live":0,"recent":58,"unproven":0,"foreignHost":0},"keptOtherProfile":2,"ignored":9,"failures":0,"deferred":0,"truncated":false},"decisions":{"actions":{"keep":58,"remove":453},"reasons":{"legacy-window":453,"recent":58}}}
```

```json
{"mode":"synthetic","profile":"acp","runs":3,"filesBefore":369,"filesAfter":69,"bytesBefore":49928,"bytesAfter":9428,"medianMs":39.15,"maxMs":39.303,"scenarios":{"scan":{"medianMs":0.282,"maxMs":0.338,"samplesMs":[0.338,0.282,0.274]},"keep":{"medianMs":7.434,"maxMs":8.122,"samplesMs":[8.122,7.434,7.183]},"delete":{"medianMs":39.15,"maxMs":39.303,"samplesMs":[31.206,39.303,39.15]}},"limits":{"maxEntries":8192,"maxRemovals":1024,"maxLeaseBytes":4096,"maxCursorBytes":2048},"counts":{"status":"ok","scanned":369,"sessions":235,"removedCompositions":200,"removedLeases":100,"bytesReclaimed":40500,"kept":{"live":20,"recent":5,"unproven":5,"foreignHost":5},"keptOtherProfile":1,"ignored":3,"failures":5,"deferred":0,"truncated":false},"decisions":{"actions":{"keep":35,"remove":200},"reasons":{"stale-lease":100,"legacy-window":100,"live-lease":20,"foreign-host":5,"unproven-lease":5,"recent":5}}}
```

```json
{"mode":"synthetic","profile":"acp","runs":3,"filesBefore":969,"filesAfter":69,"bytesBefore":130928,"bytesAfter":9428,"medianMs":99.211,"maxMs":100.056,"scenarios":{"scan":{"medianMs":0.655,"maxMs":0.711},"keep":{"medianMs":21.718,"maxMs":22.357},"delete":{"medianMs":99.211,"maxMs":100.056}},"counts":{"status":"ok","scanned":969,"sessions":635,"removedCompositions":600,"removedLeases":300,"bytesReclaimed":121500,"kept":{"live":20,"recent":5,"unproven":5,"foreignHost":5},"keptOtherProfile":1,"ignored":3,"failures":5,"deferred":0,"truncated":false},"decisions":{"actions":{"keep":35,"remove":600},"reasons":{"legacy-window":300,"stale-lease":300,"live-lease":20,"recent":5,"foreign-host":5,"unproven-lease":5}}}
```
