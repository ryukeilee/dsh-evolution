# 最新 main 的端到端成本复核与同步追加候选撤回

本轮起点为远端最新 main `a2323eb1909bc62de40450cb27873bc387a45c5e`。
三路独立只读调查分别覆盖固定模型上下文、归档事务与批量吸收、其他领域热路径；
主代理核对实际调用链并试验一个候选。**没有保留生产代码优化，也没有新增资源节省成果。**
同步追加只带来小幅冷启动改善，在较大已有历史的增量场景没有收益，因此撤回。
原有未跟踪文件未修改、未纳入本轮提交，`release/` 未变化。

## 范围与排序

排序依据是每请求/每步/批量恢复/显式维护的调用频率、历史规模斜率、已知端到端占比、
实现成本和语义风险；没有生产到达分布或真实模型 usage，因此不是按虚构流量计算的金额排序。
表中历史数字仅作候选筛选，不能算本轮新增收益。

| 顺序 | 路径、成本归因 | 当前状态与决定 |
| --- | --- | --- |
| 1 | 每模型请求固定 system text 与工具 schema；大工具结果留在后续上下文 | 本轮重跑注册路径：字段合计 9,716 UTF-8 B，声明的紧凑包装口径 10,147 B。紧凑结果渲染已在 `45cdc08` 落地。进一步删说明、分页或摘要会改变指导/输出，需同任务请求级 usage 与成功率证据；本轮没有这份证据，不把字节估算冒充计费收益。 |
| 2 | pre-step / 工具 finally 的稳态 flush：日志与权威 marker 表随历史增长 | `axis-steady-history.md` 已证明每次读/HMAC 与整表摘要；显式 reclaim 已存在。digest 缓存、旧前缀 metadata 信任、whole-log/chunk 调整均有撤回证据。floor 双读是可研究重复工作，但两次 open 与已提交截断补完的观察/拒绝顺序未证明可合并；不再次实施已被反例击穿的缓存。 |
| 3 | 批量吸收逐条归档追加的线程池往返 | 已有 replay 单事务、measurement persist 合并、索引批末写、冻结 marker 判定复用。当前仍逐条 append。本轮仅试验 staged chunk 同步追加，真实端到端 A/A、A/B、故障注入与重启差分后撤回，见下文。 |
| 4 | 大量 sealed 段：每事务完整硬链接镜像与清理 | 当前 `archive-stage.js` 已是硬链接 + 写前私有化 + 按变更集安装，不是旧报告的完整字节复制/fsync。4096 段当前 observe 中位延迟 2,014.53 ms、CPU 2,015.86 ms（3 样本），确认大量文件仍昂贵；这不是新 A/B。只镜像可写文件需 overlay/双根解析及完整性证明，复用 stage 会改变事务生命周期；没有为这组数据引入新协议。 |
| 5 | 保存检查遍历最多 4096 个 marker，归档身份/来源检索 | `assertStagedTransactionSave()` 已消除每次整窗 stringify；旧“保存检查占七成”已过时。剩余遍历的 helper 历史 self 约 10%，不等于循环可删除成本。归档读窗口、流式扫描、键表、身份规范化均已落地；跳过成员检查或跨次缓存需要新的不可变证明，不按对象身份猜测。 |
| 6 | recall、doctor、retention | recall 已走 `historyScan()`，doctor 已分块扫描；retention clone 去除有语义反例、allRecords 数组候选无稳定收益，均不重做。retention 目前可由显式 reclaim 到达，但不是每步热路径。 |

主要证据索引（均在上级目录）：`axis-token-audit.md`、`tool-result-render-compact.md`、
`axis-steady-history.md`、`archive-append-roundtrips.md`、`staged-save-check.md`、
`first-startup-absorption-deferred-archive-index.md`、`archive-transaction-attribution-20261025.md`、
`archive-stage-io.md`、`archive-row-window.md`、`cold-archive-streaming-scan.md`、
`retention-plan-history-view.md`、`retention-plan-allrecords-candidate.md`。
其中部分既有研究材料在起点是本地未跟踪文件；它们仅辅助排除方向，未作为已提交实现的证明。
当前 `#archiveFiles()` 已用 Set；旧归因里尚未实施的 O(n²) indexOf 候选不能再次算新机会。

## 实际调用链

`registration.js` 的 pre-step / 工具 finally → `domainStorage.flush()` → `replay()` →
checkpoint、日志 MAC/writer/冲突校验 → `mutate()` → `mirrorArchives()` → staged memory load →
逐条 `applyExecutionEvent()` → record / 热窗逐出 → `#archiveEntries()` → tail 检查、追加、seal →
保存检查 → `flushDeferredArchiveIndex()` → snapshot、live 隔离校验、变更清单/摘要/fsync →
pending 提交 → 安装 → 清理 stage → hydrate → checkpoint。

一次 replay 已共享一次外层事务，不能把每批一次的镜像错误归因为每事件一次。
保存检查、索引写与追加路径的旧基线收益也不能累加为当前 headroom。

## 同步追加候选：真实链路筛选

候选仅将 `#archiveEntries()` chunk flush 中的 `await appendFile(...)` 在
`archiveWriteGuard !== null` 时改为 `appendFileSync(...)`；无 guard、补分隔符、超目标单行、
quarantine 路径均保留原调用。没有缓冲跨事件数据，没有跳过 tail、guard、缓存身份、seal、
索引、认证或 fsync。完整补丁保存在 [rejected.patch](rejected.patch)。

基线用 `git archive a2323eb lib package.json package-lock.json` 解出独立临时树，依赖链接到
仓库已安装的官方包；候选为同一提交加上述补丁。原脚本
`scripts/benchmarks/archive-append-roundtrips.mjs` 未修改。两侧 source identity 在测量前后校验。
每样本独立 Node 进程、独立临时合成 home，经真实 `openDomainStorage()`、官方
DomainFacility/JsonStorageBackend。Node v26.12.1 / darwin-arm64，V8 上限 4096 MiB。
性能测量串行，期间没有运行测试或宿主验收；没有测冷盘、慢盘、网络文件系统或生产并发。

cold 是无 checkpoint 首次吸收；incremental 是先真实吸收 N 条、关闭端口、追加 2000 条，
再测重新打开；不是存活端口的单条追加。2k、12k 两档，各三轮 A/A 与 A/B，逐轮交换先后顺序，
共 48 个进程。使用 `--instrument no`，没有 fs 包装计时干扰。

| 场景 | 基线→候选 wall 中位 ms | 变化 | CPU 中位 ms | 每轮 B−A wall ms | 同码配对最大绝对差 ms |
| --- | ---: | ---: | ---: | --- | ---: |
| cold 2k | 432.504 → 417.570 | −3.45% | 464.664 → 441.229 | −20.251 / −12.058 / −7.512 | 7.984 |
| cold 12k | 2946.741 → 2871.258 | −2.56% | 3074.314 → 2951.785 | −135.311 / −86.865 / −73.206 | 24.312 |
| incremental 2k+2k | 1525.848 → 1497.701 | −1.84% | 1578.175 → 1548.144 | −31.880 / −31.782 / −17.546 | 6.549 |
| incremental 12k+2k | 4663.539 → 4669.646 | +0.13% | 4827.517 → 4833.704 | +6.108 / +14.153 / +2.296 | 47.148 |

原始数据为 [sync-append.json](sync-append.json) 与逐样本
[sync-append.samples.jsonl](sync-append.samples.jsonl)。小规模 cold 第三对收益小于 A/A
最大差，不能声称所有轮次都超过噪声；12k cold 小幅改善，已有大归档增量三轮均略慢、幅度在
A/A 漂移范围。**不能声称确定回退，也不能声称增量改善。** 该结果不足以满足本任务的显著整体
收益目标，且同步追加会占主线程；事件循环 p99 未测，不能声称响应性不变。因此停止扩到20k、
更多分段与慢盘，不为已失去主候选价值的方案继续消耗测量成本。没有预注册数值保留阈值，
这里是按用户的“微小收益不作主要成果”作出的撤回判断，不是统计显著性检验。

进程 maxRSS 保留在原始数据中，包含 fixture、增量 seed、imports 与 backend，不是追加相位
内存；本轮不主张内存或物理磁盘字节下降。性能样本的真实审计时间不同，archiveByteDigestEqual
为 false，不能把它当作等价性通过；另用固定审计时钟执行完整差分如下。

## 故障与持久化语义

[rejected-test.mjs](rejected-test.mjs) 是候选专用聚焦测试的原样存档，复现时复制到
`test/archive-staged-sync-append.test.mjs` 后运行（其相对 import 按该位置编写）。
覆盖同步追加 EIO 后原字节/热行保留、deferred-write、恢复重试恰好一次归档、从实际磁盘重载，
无 guard 保持异步，以及 guard 拒绝时不得追加。首轮 2/3：成功清理故障后 `observations`
字段不存在，测试错误地直接 `.some()`；改为 `?? []` 后 3/3 通过。两份输出分别保留在
`rejected-test-initial.txt` 与 `rejected-test-final.txt`，未隐藏首次失败。

另用原脚本 `--validate --records 2000,12000` 跑 8 个进程：两种规模 × cold/incremental × A/B。
每侧吸收后 flush，再关闭/重开两次并各 flush，全部应用数为0；比较完整业务 state、ledger、
marker、query、原始归档 JSONL 与索引。只有明确的临时根与索引 updatedAt 被规范化；无参数
new Date 审计钟固定、Date.now 仍真实，保持锁超时语义。见 [equivalence.json](equivalence.json)
及 [equivalence.samples.jsonl](equivalence.samples.jsonl)。这不覆盖 seal/部分写/慢盘/并发边界，
也不是对候选所有调度语义的证明；候选已撤回，未投入这些进一步验证。

撤回后 `git diff -- lib/` 为空，测试不留在执行套件，补丁与反例材料作为研究档案保留。

## 复现

输出路径必须全新，不覆盖本次或既有证据。以下仅操作新建的临时源码和合成数据：

```sh
base=$(mktemp -d /tmp/dsh-e2e-base.XXXXXX)
git archive a2323eb lib package.json package-lock.json | tar -x -C "$base"
ln -s "$PWD/node_modules" "$base/node_modules"
# 在独立候选副本应用 rejected.patch，不要修改正式运行环境。
node --max-old-space-size=4096 scripts/benchmarks/archive-append-roundtrips.mjs \
  --a-root "$base" --b-root /path/to/candidate --records 2000,12000 --rounds 3 \
  --phases aa,ab --instrument no --out /tmp/new-sync-append.json
node --max-old-space-size=4096 scripts/benchmarks/archive-append-roundtrips.mjs \
  --validate --a-root "$base" --b-root /path/to/candidate --records 2000,12000 \
  --out /tmp/new-sync-append-equivalence.json
node --max-old-space-size=4096 scripts/benchmarks/axis-token-audit.mjs > /tmp/new-token-audit.json
BENCH_SEGMENTS=4096 BENCH_SAMPLES=3 node --max-old-space-size=4096 \
  scripts/benchmarks/domain-archive.mjs > /tmp/new-archive-4096.json
```

本轮 [token-audit.json](token-audit.json) 只记录合成夹具。计数是 UTF-8 字节；bytes/3.6 只是
估算，不是真实 tokenizer、provider wire、缓存 usage 或账单。没有访问模型凭据或发起模型请求。
[archive-4096.json](archive-4096.json) 是候选改动前当前 main 的3样本规模复核，没有 A/B，
不能从它推算改变镜像协议的收益，也没有测物理存储 I/O。

## 停止依据与剩余风险

本轮最接近低复杂度、保留逐次写边界的新增候选已测得收益不足。其他明显空间分别需要：
请求级成功率/usage 证据（提示词与输出裁剪），或新的存储/不可变性协议与崩溃证明（稳态认证、
lazy stage、跨事件批写）。继续做这些并不保证达到整体收益目标，因此本轮不凭推断扩建机制。
这不是“全仓库已最优”的证明；大历史稳态 O(历史)、sealed 段镜像 O(文件数)、模型固定上下文
仍是实质性长期成本，生产频率和慢盘/事件循环行为仍未知。没有新增后台维护或自动回收。

## 撤回后的交付验证

以下在生产代码恢复到 `a2323eb` 后实际执行；研究材料不在包内容白名单，发布固定点未更新：

- Node v26.12.1，`NODE_OPTIONS=--max-old-space-size=4096 npm test`：1223/1223，通过，无 skipped。
- `npm run pack:check`：16 项通过，报告为固定点的开发后继，不是发布固定内容。
- `npm run release:pack -- --dist /tmp/dsh-e2e-20261029-build`：51 entries，重复打包字节一致；
  `npm run release:verify` 验证原固定产物通过。
- 同一新建本地产物在三个新隔离 runtime/home 验收：官方 `0.2.0-rc.2`、`0.2.1-alpha.1`、
  `0.2.1-rc.2` 各21/21；证据位于 `docs/evidence/end-to-end-20261029-dsh-<host>.json`。
  没有读取正式 home、密钥或迁移数据，没有发布包或写 release 固定点。

本地完整套件本轮只跑 Node 26；Node 22/24 与远端结果由本 PR 的 CI 单独确认，不能引用旧轮次
代替本轮执行。审核与远端检查结果在实际完成后补记，不预写通过。

独立审核：sol-loop 第1轮，GPT-6.1 Sol，VERDICT APPROVE，0 blocker/should/nit。
审核只读核对48个性能样本、8个差分样本、源码与补丁摘要、三宿主及产物身份，未重跑昂贵检查。
请求和工具返回均为 `codex / gpt-6.1-sol / reasoningEffort=xhigh`；审核者运行时上下文也声明
同配置，但无独立 effective-options 或 usage 返回，不宣称独立验证 Xhigh 生效，不猜测用量。
审核未要求改动。审核前后生产 diff 均为空；新增研究材料不改变分发字节。
