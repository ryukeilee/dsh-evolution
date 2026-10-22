# 归档事务 I/O：发布已持久化的暂存 inode，而不是再写一份

本轮基线为 `main` 的 `adcdb2f`。只改 `lib/archive-stage.js`：`installArchiveFiles()`
不再把已验证的暂存字节复制进一个新建文件、fsync 它、再改名覆盖 live 目标，而是用
`link` + `rename` 把**已经 fsync 过的暂存 inode** 挂到 live 名字上；`mirrorArchives()`
不再按归档文件数重复 `mkdir` 同一个目录。暂存目录在事务结束后仍然为空，恢复、重复
重放、原子替换、验证顺序、持久化顺序、锁与数据完整性校验一律未变。没有新增缓存、
没有第二套事务机制、没有修改官方 DSH、`release/`、版本号或已发布的 rc.17 固定点。

原始数据见 [`archive-stage-io.json`](archive-stage-io.json)，复现脚本见
[`scripts/benchmarks/archive-stage-io.mjs`](../../scripts/benchmarks/archive-stage-io.mjs)。

## 1. 一次写入里暂存、安装与清理的真实成本

`port.observe()` 的每一次写入都是
`installPending() → mirrorArchives() → createMemory(stage).load() → work → changedArchiveFiles()
→ writeStageManifest() → syncStage() → 提交 pending → installArchiveFiles() → rmSync(stage)
→ hydrate()`。用真实官方 JSON 后端（`DomainFacility` + `JsonStorageBackend`）逐次系统调用
计数，单次写入的归因（本机，instrumented，仅用于归因）：

| 场景 | 每笔事务（基线） |
| --- | ---: |
| 索引 + 1 个活动归档（典型，2 个改动文件/次） | 241 次系统调用：`linkSync` 2、`mkdirSync` 3、`fsync` 8、`rmSync` 1 |
| 同上 + 216 个密封段 | 1543 次系统调用：`linkSync` 218、`mkdirSync` 219、`fsync` 8、`rmSync` 1（218 条目）、`lstatSync` 661 |

插桩归因的耗时排序（216 段场景、基线、每次写入）：镜像 `linkSync` **66.8 ms**、
`fsync` 合计 **22.1 ms**、`rmSync` **9.7 ms**、`lstatSync` **3.5 ms**、`mkdirSync`
0.94 ms。镜像 `linkSync` 与清理 `rmSync` 合计 76.5 ms，是插桩归因里最大的两块，
而这条成本是结构性的（见第 6 节）；真正可以删掉的冗余只有两处：

1. **安装阶段对同一份字节的第二次写与第二次 fsync。** 暂存文件由 `syncStage()`
   在提交点之前已经 fsync 过，`installArchiveFiles()` 又把它复制进 live 树的新
   inode、再 fsync 这个新 inode、然后改名。每笔事务、每个改动文件各一次。本机新建
   文件的首次 fsync 约 3 ms（见第 5 节），所以这是安装阶段的主要成本。
2. **镜像阶段按文件重复创建同一个目录。** `mkdirSync(dirname, {recursive:true})`
   对每个归档文件调用一次，而 Node 的递归 mkdir 在目录已存在时是 `mkdir` + `stat`
   两次调用。216 段时每笔事务多出约 434 次调用。

## 2. 改动

`lib/archive-stage.js`，两处：

1. `installArchiveFiles()` 的发布步骤：`linkSync(staged, temporary)` 把已验证 inode
   挂到 live 目录的临时名，`renameSync(temporary, target)` 原子替换目标。
   - 验证仍是**整份清单先做完**：每个暂存文件都按 durable pending 记录里的
     `bytes`/`sha256` 完整读取并比对，任何一项不符仍在**第一个 live 条目移动之前**
     抛 `E_DOMAIN_PENDING_ARCHIVE_CORRUPT`/`E_DOMAIN_PENDING_ARCHIVE_MISSING`。
   - 被安装的字节就是被验证的那些字节（同一个 inode），验证与安装不可能分歧。
   - 暂存条目**不被消耗**（`link` 不移动它），所以 stage 仍是"每笔事务每个文件都有
     一份可重放的副本"，`pending.files` 的重放语义、以及无 manifest 的 legacy
     `copyArchives()` 全量路径都不变。
   - `linkSync` 失败（跨介质 `EXDEV`、文件系统不支持硬链接）时回退到原来的
     write + fsync + rename，行为与本轮之前完全一致。
   - 重复重放时 live 名字已经指向同一个 inode：POSIX 规定两个名字指向同一文件时
     `rename` 是**no-op**，会留下多余的名字，因此发布前用 `lstat` 判断"live 条目就是
     这个 inode"，若是则只登记目录同步、不再 link/rename。该判断只接受普通文件，
     符号链接/目录等其它形态仍然交给 `rename`，与改动前处理方式相同。
   - 临时名仍按每个清单条目抽取一次 `randomUUID()`，与发布路径无关；这是
     `test/observe-cache-handoff.test.mjs` 的 rc.16 差分锚点（冻结 UUID 序列）依赖的
     调用次数。
2. `mirrorArchives()`：用一个局部 `Set` 记住已经创建过的父目录，每个目录只 mkdir
   一次。`walkArchives` 先访问文件再递归子目录，递归 mkdir 会补齐缺失的祖先，所以
   任意深度的布局都成立；这个 Set 只活在一次事务内，不是跨事务缓存。

**没有动的部分**：`walkArchives` 的枚举与符号链接拒绝、`assertLiveTreeUnchanged()`
的全量身份比对、`changedArchiveFiles()` 的逐文件摘要、`syncStage()` 的 fsync 集合与
顺序、`privatizeArchiveFile()` 的写前私有化、`domain-staging` 在事务结束后为空、
`rmSync` 清理、pending 记录的内容与提交点、跨进程锁与 CAS。

## 3. 等价性

- **冻结时钟 + 确定性 UUID**：两侧跑同一 workload，`official/evolution_domain.json`、
  每个归档文件（含 216 个密封段）与归档索引文档**逐字节相同**（脚本内断言，失败即
  非零退出）。两个场景都通过（`equivalence[]`）。
- **调用次数不变的部分**：镜像 `linkSync` 每个文件 1 次、`changedArchiveFiles()` 每个
  改动文件 1 次完整读取 + SHA-256、`syncStage()` 的 fsync 集合、`assertLiveTreeUnchanged()`
  的每次 `lstat`，均与改动前一致。
- **唯一可观察差异**：发布到 live 的 inode 现在是暂存 inode，所以它在 live 树上的
  mode 就是该暂存文件的 mode（等于旧实现新建 inode 时按暂存 mode 申请的值），属主、
  扩展属性等元数据也随暂存 inode 保留，而不是"安装时刻新建"的 inode 的元数据；
  `mtime` 是写入时刻而不是安装时刻。这两点与旧实现不完全等价（不再把元数据重置为
  当前进程新建时的默认值）。归档索引条目只用 basename、`byteSize`
  与 `sha256`，不读 live 的 mtime，扫描备忘（`archiveScanMemo`）的键包含
  `dev/ino/size/mtimeNs`，其行为由"这个进程扫过哪些字节"决定，与 inode 来源无关；
  冻结时钟下的逐字节等价同时覆盖了这条路径。

## 4. 可复现 A/B

```sh
node scripts/benchmarks/archive-stage-io.mjs --rounds 3 --writes 15 --sealed 0
node scripts/benchmarks/archive-stage-io.mjs --rounds 3 --writes 12 --sealed 216
```

脚本把 `adcdb2f` 的 `lib/archive-stage.js` 还原进一份 `lib/` 副本作为基线（断言基线
按"写一份新文件 + fsync"发布、且不含候选的发布方式），两侧在同一进程、同一 fixture
上**交替先跑**，三轮。每轮先跑一次无插桩的测量（墙钟与 CPU 可信），再跑一次带 fs 包装
的计数（只用于次数与归因）。fixture 先写 40 行活动归档，预热 60 次写入把热窗口推过
上限，使每次被测量的写入都在追加活动归档——脚本会断言活动归档确实增长，并断言两侧
的发布形态（基线必须改写字节、候选必须 link 且不 fsync 第二份）。

环境：Node `v26.12.1` / `darwin/arm64`，8 逻辑 CPU。两次调用（典型场景 / 216 段场景）
开始与结束时的 load average（1/5/15 分钟）分别是 `1.82/1.83/1.71` → `1.81/1.82/1.71`
与 `1.75/1.80/1.70` → `2.98/2.25/1.90`。

### 典型归档（索引 + 1 个活动归档，每笔事务 2 个改动文件）

| 每次 `port.observe()` | 基线 | 优化后 | 变化 |
| --- | ---: | ---: | ---: |
| 墙钟（三轮中位数的中位数） | 64.07 ms | 56.67 ms | **−11.5%** |
| 墙钟（三轮各自） | 62.87 / 64.07 / 64.86 | 55.49 / 56.68 / 59.03 | 区间不重叠 |
| CPU | 33.10 ms | 32.60 ms | −1.5%（见下） |
| 文件系统调用 | 241 | 231 | −4.1% |
| `fsync`（插桩归因） | 8 次 / 20.6 ms | 6 次 / 12.5 ms | −2 次 / −8.1 ms |
| 安装阶段：新建并 fsync 的副本 | 2 个/写入 | **0** | −2 |
| 安装阶段：`link` 发布 | 0 | 2 个/写入 | +2 |
| `mkdirSync` | 3 | 1 | −2 |

### 216 个密封段

| 每次 `port.observe()` | 基线 | 优化后 | 变化 |
| --- | ---: | ---: | ---: |
| 墙钟 | 165.99 ms | 161.42 ms | −2.8% |
| 墙钟（三轮各自） | 165.99 / 166.67 / 164.97 | 162.34 / 161.42 / 161.13 | 区间不重叠 |
| CPU | 134.08 ms | 135.16 ms | +0.8%（噪声） |
| 文件系统调用 | 1543 | 1318 | **−14.6%** |
| `mkdirSync` | 219 | 2 | −217 |
| `fsync`（插桩归因） | 8 次 / 22.1 ms | 6 次 / 17.8 ms | −2 次 / −4.3 ms |
| 安装阶段：新建并 fsync 的副本 | 2 个/写入 | 0 | −2 |

段数越多，镜像与清理在单笔事务里的占比越大（基线 66.8 + 9.7 ms 固定成本），可删的安装
成本占比随之下降，所以这里只有 −2.8% 墙钟，但调用次数少 14.6%。

## 5. 收益边界

- **墙钟收益来自 fsync 等待，不是 CPU。** 删掉的是一次"新 inode 的首次 fsync"：
  本机微基准（见下）显示新建文件的首次 fsync 约 3 ms，而同一文件第二次 fsync 约
  0.02 ms；一批 fsync 之内的后续 fsync 也接近该值。两个场景的 CPU 差分别是 −1.5%
  与 +0.8%，都在噪声范围内，因此 CPU 不作为结论，本轮只报告墙钟与调用次数。
- **绝对毫秒数不可移植。** 本机 `linkSync` ≈ 0.3 ms、`fsyncSync`（新文件）≈ 3 ms，
  明显慢于常见主机（疑似宿主安全软件拦截创建类调用，与
  [`archive-index-churn.md`](archive-index-churn.md) 第 5 节同一现象）。机制是
  "每个改动文件少一次完整字节复制 + 一次 fsync"，在 fsync 便宜的主机上绝对收益会
  小得多；可移植的结论是**调用次数**与**被删除的字节复制量**。
- 收益随改动文件数与文件大小线性增长：每个改动归档文件都少一份完整复制与一次
  fsync。活跃归档达到 `archiveMaxBytes`（8 MiB）时，旧实现每笔事务都要为它多写
  8 MiB 并 fsync。
- 收益与密封段数关系不大（那些文件不改动，本来就不在安装清单里）；密封段只影响
  镜像的固定成本，本轮没有触碰它。
- 没有测量冷页缓存、网络文件系统、其它平台，也没有声称磁盘 I/O 的物理写入总量
  下降的比例。

复现"新文件首次 fsync"的量级（本机）：

```sh
node -e '
const fs=require("fs"),{performance}=require("perf_hooks");
const d=require("fs").mkdtempSync("/tmp/fsync-");
const sync=f=>{const fd=fs.openSync(f,"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}};
for(let r=0;r<3;r++){const files=[];for(let i=0;i<5;i++){const f=`${d}/r${r}-f${i}`;fs.writeFileSync(f,"x".repeat(100));files.push(f)}
const out=[];for(const f of files){const t=performance.now();sync(f);out.push((performance.now()-t).toFixed(3))}
console.log("round",r,out.join(" "))}'
```

## 6. 本轮同时排除的方向（附证据）

| 候选 | 结论 | 依据 |
| --- | --- | --- |
| 复用上一次事务的暂存目录，避免每笔事务按归档文件数重建/清理硬链接 | 不做（沿用上一轮的结论，本轮只补成本数据） | 机制上收益最大：216 段时基线镜像 `linkSync` 218 次 ≈ 66.8 ms、`rmSync` 218 条目 ≈ 9.7 ms，合计 76.5 ms，是插桩归因里最大的两块。但它要求 `domain-staging/` 在事务之间保留目录；`domain-orphan-staging` 修复项与 `archive-stage.test.js`、`storage-transaction-applied-ledger.test.mjs`、`review-fix-storage-ledger-conflict.test.mjs` 都要求事务结束后暂存目录为空，属于现有不变量（`archive-index-churn.md` §7 已记录同一结论）。 |
| 让暂存树只包含可写文件、密封段直接读 live | 不做 | 它需要把 Memory 的档案解析改成两根基（读写分离），否则暂存实例看不到密封段，`coldArchives` 会丢失记录；这是第二套解析/事务机制，超出最小改动。 |
| 去掉 `.archive-files.json` 的 fsync | 不做 | 该文件对恢复无权威性（`pending.files` 才是权威，运行时不读取它），但它的 fsync 是可测的：**手工运行的 3 轮交替 A/B**（保留 vs 去掉，原始输出未收录进本目录 JSON）墙钟 `54.08/56.23/54.20` vs `53.03/51.11/53.68` ms，约 1～2 ms（2～4%）。为 2～4% 放松一条已在注释中写明的暂存持久化属性不划算，本轮撤回该候选。 |
| 安装阶段跳过对暂存文件的完整读取与 SHA-256 校验 | 不做 | 那正是"staged 字节仍等于 durable pending 记录"的唯一证据；删掉它会把安装从"验证后发布"变成"信任暂存目录"。 |
| 安装时改成直接 `rename(staged, target)` 消耗暂存条目 | 不做 | 少一次 `link`，但阶段被消耗后，部分安装 + 崩溃的重放就只能靠"目标 digest 恰好匹配"来判断，恢复从"总能重放"退化为"可能拒绝启动"。`link` + `rename` 同时保留了"原子替换"与"暂存副本仍在"。 |
| 用 `copyArchives`/reflink 克隆代替硬链接镜像 | 不做 | 非 reflink 文件系统上会退化为按字节复制整棵归档树（密封段可达 MiB 级）；硬链接是这里唯一零拷贝且与文件大小无关的原语。 |
| 降低镜像的 `lstat`/`readdir` 次数（`assertLiveTreeUnchanged`、`changedArchiveFiles` 的全量枚举） | 不做 | 这些枚举就是隔离证明：少看一个文件就无法证明"live 树没有在事务中被人写过"，而 `E_DOMAIN_STAGE_ISOLATION` 的语义依赖它。 |

## 7. 验证

```sh
NODE_OPTIONS=--max-old-space-size=4096 node --test \
  test/storage-transaction-archive-publish.test.mjs \
  test/storage-transaction-archive-install.test.mjs \
  test/domain-storage/archive-stage.test.js \
  test/observe-cache-handoff.test.mjs
NODE_OPTIONS=--max-old-space-size=4096 npm test
```

新增 8 项回归（`test/storage-transaction-archive-publish.test.mjs`）：

1. 发布出去的是**被验证的那个 inode**，且暂存条目仍在（重放仍有一份副本）、mode 保留、
   live 未被写入、不留 `.tmp`；
2. 发布阶段**不写任何文件**，只剩目录 fsync；
3. `linkSync` 抛 `EXDEV` 时回退到写+fsync+rename，字节正确且不是暂存 inode；
4. 重复安装幂等：第二次不换 inode、不累加链接数、不留 `.tmp`；
5. 清单中后一项损坏时，前一项**不会**被发布（整份先验证的性质未被削弱）；
6. 镜像每个目录只 mkdir 一次（8 个密封段 + 活动文件 → 恰好 2 次）；
7. live 条目是符号链接时替换链接本身、绝不写穿；
8. 真实端口上"发布到一半就失败 → 重启恢复"：恢复只发布缺的那一项（用 `linkSync`
   调用列表断言），失败的项按暂存字节补上，暂存目录被移除。

既有差分锚点全部保持：`observe-cache-handoff.test.mjs` 的 rc.16 冻结 UUID/时钟差分
（包括 pending-install 崩溃恢复）通过——它正是把"每个清单条目消耗一次
`randomUUID()`"钉住的地方。提交前的全量套件 **670 项，669 通过**，唯一失败是
`test/release-pin.test.mjs` 的"工作树必须是固定产物或它的已提交后继"，它要求本轮
改动先提交；提交后该用例通过，`npm run pack:check` 的判定是本树为固定发布产物的
开发后继，与固定产物不同的分发文件只有 `lib/archive-stage.js`。`release/`、
`release/manifest.json`、版本号与历史发布记录未改动，rc.17 仍是已发布的固定点。

## 8. 剩余风险

- 真实断电未验证：`link` 与 `rename` 之间硬崩溃可能留下一个 `*.tmp` 硬链接（旧实现
  的同一窗口更长，它在这个窗口里还要写+fsync 一份字节）。重复崩溃理论上可以累加
  这样的临时名。`allowedArchive` 只在归档树根层过滤文件名，所以这类临时名不会有
  索引条目、也不会被安装清单选中；但如果它落在密封段目录里（嵌套条目的临时名
  就建在目标文件旁边），`walkArchives` 仍会递归枚举到它，下一次事务会把它当作共享
  inode 一并镜像。这一点与本轮之前相同，本轮既没有修复也没有加重。
- 硬链接保留了暂存 inode 的权限、属主与扩展属性，与"安装时刻新建 inode"取当前进程
  默认值与目录继承值并不相同；`mode` 的数值一致，其余属性以暂存 inode 为准。
- 隔离保证仍以"数据根独占"为前提：越过锁的原地写入会同时污染 live 与 stage，这是
  既有前提，本轮未改变也未加强。
- 本轮的墙钟数字强依赖本机 fsync 成本；换主机后百分比不可移植，只有调用次数与少一次
  全量复制的机制可移植。
