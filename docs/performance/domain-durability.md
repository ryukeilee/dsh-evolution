# 事件 checkpoint 与 archive 增量安装候选

本次以 `1abf08e`（当前 HEAD）为 baseline，保留工作区已有候选并补强安全与恢复协议。
真实官方 `DomainFacility` / `JsonStorageBackend` 路径在三轮独立计时中均有收益。
最终收口：事件认证仍有完整历史字节扫描及完整 applied 摘要，这是当前安全语义下
的必要边界；不再沿此方向修改实现。两项旧候选固定点失配已通过正式发布脚本修复，
没有降低测试要求。源码 commit 为 `4809b40`；本地候选已重新绑定双宿主证据。

## 分别评估的性能数据

环境：Node `v26.10.0`，`darwin/arm64`。全部数据来自临时合成 fixture，
没有读取用户事件或归档。原始逐次结果、调用计数、profile 摘要及验证信息见
[domain-durability.json](domain-durability.json)。历史前后工作负载与脚本完全相同。
每个进程先预热，计时排除 fixture、首次打开和重开断言。三轮顺序执行；
第一、三轮 baseline 在前，第二轮 candidate 在前；没有与测试并行。
表中为三个进程样本中位数的中位数，单位 ms。

| 工作负载 | baseline 延迟 | candidate 延迟 | 减少 | baseline CPU | candidate CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10k 已提交历史，无新事件 | 50.950 | 4.165 | 91.83% | 51.840 | 4.166 |
| 50k 已提交历史，无新事件 | 264.793 | 22.985 | 91.32% | 291.413 | 23.027 |
| 10k 历史，每次新增 1 条事件 | 97.271 | 60.337 | 37.97% | 87.062 | 35.297 |
| 观察提交，无封存分段 | 30.056 | 26.032 | 13.39% | 8.892 | 8.130 |
| 观察提交，256 × 1 KiB summary 分段 | 1492.593 | 156.851 | 89.49% | 267.935 | 142.052 |
| 观察提交，16 × 1 MiB summary 分段 | 168.999 | 34.292 | 79.71% | 48.703 | 16.540 |

无新事件的 flush 不触发 archive 事务，单独评估 checkpoint 方向；
观察 benchmark 没有事件文件，单独评估 archive 方向。
新增事件的整合结果不用于单独归因：另在临时 event-only 候选中恢复 baseline 的
`installPending`、`createMemory`、`hydrate`、`mutate`，仅保留新 replay，
三轮延迟为 60.956 / 61.878 / 56.884 ms，CPU 为 35.444 / 36.641 / 34.668 ms。
因此新增事件负载中的收益主要来自历史认证路径；不将整合收益归为 archive 独立收益。
这个临时隔离候选不是最终生产实现。

三轮无新事件 flush 的延迟减少均为 91.32–91.88%；256 段提交减少
89.41–90.06%。较大的改善在每轮均成立，同时有操作计数佐证，不依赖单次最低值。
无分段的较小收益不推断为所有工作负载均可得到相同百分比。

## 目标路径归因

另外执行带计数的 benchmark，仍执行全部原始操作；它们不混入上表延迟数据。

- 50k 历史每次 flush：baseline `createHmac` / `JSON.parse` 各 50,000 次，
  candidate 分别为 2 / 1 次。剩余两个 HMAC 是 checkpoint metadata 与历史前缀。
  已验证前缀不再逐条解析、canonicalize、做事件 MAC 和 marker 查找。
- 256 段每次观察提交：顶层 `cpSync` 从 4 次到 0 次，`fsyncSync` 从 518 次到 3 次；
  candidate 创建 257 个硬链接，没有 `copyFileSync` 调用。
  三个 fsync 对应 diagnostic manifest、stage 目录与 staging 根。
  官方 backend 自身的异步持久化仍执行，不在这个同步调用计数内。
- CPU profile 的完整进程包括启动、预热、测量和清理，仅辅助归因。
  replay baseline 的 `canonicalBridgeJson` self time 为 1664 ms，candidate 为
  162 ms（仍包括冷启动完整验证和 fixture 签名）；archive baseline 的原生
  `fsync` 为 9836 ms、`cpSyncCopyDir` 为 679 ms，candidate 分别为 82 ms / 0 ms，
  主要新热点是 `link`（777 ms）。不把完整进程 profile 当作计时区间生产占比。

本次没有测物理磁盘写入字节、峰值内存、生产事件分布或非本机文件系统。
较大 archive fixture 代表 16 个大记录分段，不能当作所有真实多记录归档的分布。
观察 fixture 的重复观察主要保留在热池；真实冷档追加和轮转由回归测试覆盖，
尚未单独给出大量冷档追加或 compaction 的性能承诺。

## 安全与恢复协议

Checkpoint schema 2 的 metadata 由域分离 HMAC 认证，覆盖 bytes、records、
writer、文件身份、前缀 digest、witnesses 和完整 applied 状态的 digest。
每次重新读取并 HMAC 校验已消费前缀，同时比较完整 applied digest。
任何前缀改变、marker 变化（包含中间条目）、metadata 伪造、换 key/writer、
文件替换、截断、未知 schema 或缺失 checkpoint 均回到完整逐条验证。
新事件始终保留事件 MAC、writer 和同 ID/MAC 冲突检查。
Checkpoint 仅在领域提交成功后发布，写入失败仅损失缓存，不丢事件。
未以 LF 结束的尾行仍按原行为处理，不能进入 checkpoint。

这能大幅减少重复认证 CPU，但**不是次线性认证**：在当前可被原地改写的普通文件
模型下，若要每次检测任意历史字节篡改，就必须检查这些字节。
mtime/size/inode 或文件监视通知不能作为安全证明。本候选没有采用这些捷径。
若必须满足次线性成本，需要另行明确可信的不可变存储或更改历史校验时机；
这会超出本次保持安全与现有接口的约束，故没有擅自扩张。

Archive staging 仍枚举整树并创建硬链接，尚未消除 O(文件数) 的目录工作；
但共享已经 durable 的冷档 inode，避免复制和逐文件重复 fsync。
对 active 文件的 append/truncate 前先复制到私有 inode；索引通过原子替换隔离。
安装仅验证并替换 changed files，保留 fsync-file → rename → fsync-directory 顺序。
变更列表和文件摘要写入 durable pending 的可选 `files` 字段；恢复直接使用该记录，
不依赖 staging 中的 diagnostic manifest。manifest 自身也 fsync。
旧 pending 没有 files 时保留原 full-copy 恢复。启动一次全树 fsync，保证旧版或
显式 seed 的文件可安全共享；load 修复索引时也同步 index 与父目录。
这些启动成本被明确移出日常事务，不声称首次打开免费。

当前版本可读取旧 pending；旧版严格 schema 不认识带 files 的新 pending，
应在 pending 已完成、端口关闭后再降级。domain 端口不暴露 compaction，
本次没有改变原 full-copy 不删除 live 额外文件的既有行为。

## 最终验收与边界

- 安全补强后领域测试 21/21 通过；新增 append/rotation 私有化回归也通过。
- 收口前完整测试复现 184/186，两项失败为工作树内容与旧候选产物失配。
  旧产物只有 48 条目，缺少新增模块，且已有模块字节改变；不是功能回归。
  保留原断言，提交源码后通过 `publish-artifact.mjs --force` 更新本地候选固定点。
- 最终完整 `npm test`：187/187 通过，0 skipped。新增一条回归验证每次读取完整前缀，
  并拒绝 inode/size 不变、mtime 恢复的中间记录篡改，拒绝后 checkpoint 不前移。
  checkpoint、pending archive、安装中断恢复、旧 pending、append/rotation 隔离均通过。
- 新候选重复打包字节一致，50 个内容白名单条目及权限通过。
  `release/manifest.json` 的 `sourceCommit` 为真实源码 commit，产物和 provenance 校验通过。
  tarball SHA256：`da8444725d32ba5d37dbb6f2442fbba62a3094d5108772ad91a68c91e1b0e68a`；
  content SHA256：`d4bec3181f4addad50f32dfee278478134891da15f66626f7c9caa2544957358`。
- `pack:check` 16/16 通过。首次默认 npm cache 在沙箱中写入报 `EPERM`；
  使用 `npm_config_cache=/tmp/dsh-perf-npm-cache` 后通过，没有修改用户 cache 权限。
- 官方 DSH `0.2.0-rc.2` / `0.2.1-alpha.1` 候选宿主验收均为 21/21 步通过，
  覆盖卸载重装、升级回滚、promotion 跨重启和 canary 回滚。证据为
  [rc.2](../evidence/durability-dsh-0.2.0-rc.2.json) 与
  [alpha.1](../evidence/durability-dsh-0.2.1-alpha.1.json)。首次沙箱 plugin-add
  均因 `fetch failed` 失败；允许网络后在全新 home 重试成功，首次失败也保存在原始 JSON 中。
- 领域 MAC/故障安全改动经一次独立审查和修复后的定向复查，未发现剩余阻塞项。
  这不替代断电硬件实验或对所有文件系统的证明。

最终两个官方宿主各 21/21 步通过，并写入固定点规定的
[rc.2](../evidence/dsh-0.2.0-rc.2.json) 与 [alpha.1](../evidence/dsh-0.2.1-alpha.1.json)。
重用已安装的官方 runtime，但每次使用全新临时 home。首次沙箱安装因 `fetch failed`
失败，原始失败保存在 [domain-closure.json](domain-closure.json)，允许网络后重跑通过。

同一环境中再执行两轮交替顺序计时，未与其他验证并行：10k flush candidate
4.164 / 4.214 ms，baseline 51.620 / 52.273 ms；50k 为 22.349 / 22.587 ms，
baseline 263.301 / 266.000 ms；256 段 archive 为 158.687 / 157.625 ms，
baseline 1666.025 / 1665.175 ms。原始逐次结果在 `domain-closure.json`。
重复 flush 仍减少约 91–92%，archive 约 90%，无明显回退。

下界依据：若一次验证不读取前缀中的某个字节，攻击者可只改变该字节，同时保持
所有被读取字节和可伪造 metadata 不变；验证器的观察无法区分两份文件。
因此要对任意位置的篡改保持原有检测能力，每次至少读取全部历史字节，成本为
Ω(前缀字节数)。分块哈希或 Merkle tree 若没有可信的写入约束及根更新机制，
仍需读取每块才能证明当前文件没变，不能消除此成本。完整 applied 摘要另有
O(marker 数量) 成本；只检查端点会漏掉中间 marker 回滚，故保留。

当前目标是 `darwin/arm64` 上 Node 普通文件路径；代码及配置没有可信不可变历史、
由可信宿主维护的认证根或不可绕过的写入代际机制。锁仅约束合作写入，硬链接用于
archive 事务隔离，不证明事件历史不可篡改。未找到满足约束的更优实现，故该方向
已达到合理边界；不引入新存储系统或更高维护成本。

结论：候选已通过本地最终验收，适合提交固定点与证据并进入发布流程。
未推送、创建 tag 或对外发布；公开发布仍需 tag/CI 按现有流程验收。

## 复现

将 HEAD 导出到独立临时目录，使用同一当前 benchmark 和锁文件依赖：

```sh
rtk proxy sh -c '
task_baseline_dir=$(mktemp -d /tmp/dsh-durability-baseline.XXXXXX)
git archive 1abf08e | tar -x -C "$task_baseline_dir"
cp scripts/benchmarks/domain-{replay,archive}.mjs "$task_baseline_dir/scripts/benchmarks/"
ln -s "$PWD/node_modules" "$task_baseline_dir/node_modules"
printf "%s\n" "$task_baseline_dir"
'
```

对 baseline 和当前候选分别执行下列参数，独立执行三轮并交替先后顺序。
baseline 命令只需把脚本路径替换为上一步临时目录中的同名文件：

```sh
rtk proxy env BENCH_EVENTS=10000 node scripts/benchmarks/domain-replay.mjs
rtk proxy env BENCH_EVENTS=50000 node scripts/benchmarks/domain-replay.mjs
rtk proxy env BENCH_EVENTS=10000 BENCH_NEW_EVENTS=1 BENCH_SAMPLES=7 node scripts/benchmarks/domain-replay.mjs
rtk proxy env BENCH_SEGMENTS=0 node scripts/benchmarks/domain-archive.mjs
rtk proxy env BENCH_SEGMENTS=256 node scripts/benchmarks/domain-archive.mjs
rtk proxy env BENCH_SEGMENTS=16 BENCH_SEGMENT_BYTES=1048576 node scripts/benchmarks/domain-archive.mjs
```

默认 replay 15 次测量 / 3 次预热，archive 7 次测量 / 1 次预热。
调用归因增加 `BENCH_TRACE_AUTH=1` 或 `BENCH_TRACE_IO=1`，两侧参数相同。
Profile 独立于正常计时：

```sh
rtk proxy env BENCH_EVENTS=50000 node --cpu-prof --cpu-prof-dir=/tmp scripts/benchmarks/domain-replay.mjs
rtk proxy env BENCH_SEGMENTS=256 node --cpu-prof --cpu-prof-dir=/tmp scripts/benchmarks/domain-archive.mjs
rtk npm test
rtk proxy env npm_config_cache=/tmp/dsh-perf-npm-cache node scripts/release/pack.mjs --dist /tmp/dsh-perf-dist
```
