# 事务提交形态：没有归档改动的写入只写一次文档

本轮基线为 `main` 的 `b943b21`。只改 `lib/domain-storage.js` 的 `mutate()`：一次事务
的归档变更清单为空时，它不再"发布 pending 记录 → 安装（装 0 个文件）→ 用第二份整份
文档清除 pending"，而是在同一个位置直接发布它最终停下的那份文档，并删掉暂存目录。
没有新增缓存、没有改变持久化格式、认证、去重、事务、提交点、恢复、回滚、跨进程锁与
数据完整性校验，也没有修改官方 DSH、版本号、`release/` 或已发布的 rc.17 固定产物。

原始数据：[`transaction-commit-shape.json`](transaction-commit-shape.json)、
[`transaction-commit-shape-recheck.json`](transaction-commit-shape-recheck.json)、
[`transaction-commit-shape-recheck2.json`](transaction-commit-shape-recheck2.json)
（三次独立会话，每次 3 轮 × 2 侧 × 4 场景，逐轮交替先后顺序，每场景每侧逐笔保留 9 个
未取整的墙钟与 CPU 样本、以及该轮的机械计数）。复现脚本：
[`scripts/benchmarks/transaction-write-path.mjs`](../../scripts/benchmarks/transaction-write-path.mjs)。
环境 Node `v26.12.1` / `darwin-arm64`，8 逻辑 CPU。

结论先行：

| 场景（每次 `port.observe()` / `port.flush()`） | 基线 | 候选 | 变化（三次会话） |
| --- | ---: | ---: | ---: |
| 无归档改动、1 条新记录（文档约 152 KB）墙钟 | 26.1 / 28.5 / 28.2 ms | 13.9 / 13.9 / 13.9 ms | **−46.8% / −51.2% / −50.6%** |
| 同上，CPU | 11.8 / 12.6 / 12.9 ms | 6.9 / 7.0 / 7.1 ms | **−42.0% / −44.6% / −45.2%** |
| 每笔 10 条记录、该笔无归档改动（5/8 笔）墙钟 | 30.2 / 29.1 / 30.4 ms | 15.0 / 15.1 / 15.4 ms | **−50.4% / −48.3% / −49.2%** |
| 同上，CPU | 14.5 / 14.5 / 14.4 ms | 8.9 / 8.9 / 9.1 ms | **−38.6% / −38.7% / −37.0%** |
| 归档增长稳态（每笔事务都追加归档，9/9）墙钟 | 42.8 / 44.0 / 43.8 ms | 42.0 / 43.7 / 44.9 ms | −2.1% / −0.7% / +2.6%（轮间区间重叠，无回退） |
| `flush()` 无新记录（每个 agent step） | 0.01 ms | 0.01 ms | 无变化（两侧都没有事务） |
| 每笔事务写整份官方文档的次数 | 2 | **1** | −1 次整份文档写入 |
| 每笔事务推进 commit token 的次数 | 2 | **1** | −1 |

四个场景在冻结时钟 + 确定性 UUID 序列下持久化树逐字节相同（三次会话都断言通过，且冻结那一趟还断言了各场景的归档形态）。

## 1. 归因：一次事务的两份整份文档写入

`registration.js` 只在三处跑这条路径：`agent/pre-step` 的 `flush()`（每个 agent
步骤一次）、每个 Evolution 工具 `finally` 里的 `flush()`（每次工具调用一次）、
`agent/error` 与工具结果的 `observe(dto)`（每次失败信号一次）。只有真正消费了记录
或写入一条观察时才会开事务，因此**事务次数 = 真实状态变更次数**，不是步骤数。

用真实官方 `DomainFacility` + `JsonStorageBackend`、真实 `port.flush()`、已签名已提交
的合成历史（1000 条已提交标记，官方文档 141 KB），在阶段边界打点（临时探针，未入库，
只读计时），一次**无归档改动**事务的墙钟分段（9 个样本中位数）：

| 阶段 | 每次事务 |
| --- | ---: |
| `installPending()`（事务入口的恢复检查：整份文档 `schema.parse`） | 0.49 ms |
| `mirrorArchives()`（硬链接镜像） | 0.79 ms |
| `createMemory()`（暂存实例与加载） | 0.82 ms |
| `work()` | 0.14 ms |
| `assertLiveTreeUnchanged()` + `changedArchiveFiles()` | 0.07 ms |
| `writeStageManifest()` | 0.22 ms |
| `syncStage()`（暂存目录与 staging 根各一次 fsync） | 2.96 ms |
| 发布前的双重比较 + `advanceCommitToken()` | 0.56 ms |
| **发布 pending 记录**（`schema.parse` + 整份文档写入 + 文件 fsync + rename + 目录 fsync） | **7.70 ms** |
| **收尾 `installPending()`**（装 0 个文件 + `writeCommitToken` + 整份文档写入 + `rmSync`） | **9.05 ms** |
| `hydrate()`（提交后重载） | 0.72 ms |
| **整个 `flush()`（含 pass 的认证与检查点）** | **25.40 ms** |

两份整份文档写入加上为它服务的系统调用就是这条路径的主体：`official/open.async`
每次事务 4 次（每份文档写入各 1 次临时文件 + 1 次目录 fsync），`other/fsyncSync` 2
次（`syncStage` 的两个目录 fsync），`other/writeFileSync` 3 次（两次 commit token
推进 + 一次暂存清单），`official/*` 的文档替换 2 次。

**为什么这两份写入在这里是多余的。** pending 记录的作用只有一个：把"暂存字节已经
durable"排在"描述它们的 aggregate durable"之前，好让恢复能在读取新 aggregate 之前
把暂存字节重放到实时树上。归档变更清单为空时没有暂存字节、安装也不做任何事，于是：

- 第一份写入（pending 记录）承诺的"稍后安装"永远装 0 个文件；
- `syncStage()` 的两个 fsync 保护的是一份没有任何持久记录会引用的暂存目录（它随即
  被删掉）；
- 第二份写入把第一份刚写的文档换成同一份文档、只差 `pending: null`。

因此这类事务可以在**同一个位置**直接发布它最终停下的文档：`schema.parse` 仍然对
将要写入的那份值做同样的投影与整份校验，`assertArchiveLockHeld()`、文档与 commit
token 的双重比较、`advanceCommitToken()` 全部保留，暂存目录在"安装会删除它"的同一
位置被删除。

### 1.1 哪些事务属于"无归档改动"

`EvolutionMemory` 的热窗口是每集合 50 条（`knowledge` 为 `maxEntries`）。一笔事务
只有在它自己的 `work()` 里把某条记录推进冷档案时才会产生归档变更，具体是：

- 该集合已经在热上限上，再追加一条（`#append` 的驱逐路径）；
- 加载时发现某集合超出热上限（这只会发生在提交后的 aggregate 未被裁剪的情形）；
- 更新一条**已经在冷档案里**的记录（`replaceExisting` 重写归档）。

反过来说，**无归档改动**的事务是：写入落到热上限以下的集合（一个新安装从空到每集合
50 条的全部写入）、知识去重/合并到已有行的写入（同一失败模式反复出现时的
`agent/error`）、以及只写 `knowledge`（上限 `maxEntries`）的写入。插件真实产生的记录
量很低（一次工具调用通常 1–3 条事件），所以这三类覆盖了从新安装到中等使用期的绝大
部分事务；只有某个集合长期超过 50 条之后，追加到它的写入才每笔都改归档（场景 3）。

本轮**实测**的分类（脚本按"这笔事务前后实时归档树的文件/大小是否变化"逐笔判定，
四个场景两侧判定必须一致）：`daily` 0/9 有归档改动、`bulk` 3/8、`archive` 9/9、
`steady` 0/9（没有事务）。脚本把前两者断言成 0 与"至少一笔"，把 `archive` 断言成
"每笔都改"，所以场景一旦漂移会直接失败而不是静默改口径。这里没有生产环境的
统计，因此不声称线上比例。

## 2. 改动

`lib/domain-storage.js`，`mutate()` 里两处：

```js
    writeStageManifest(dir, files);
    const staged = files.length > 0;
    if (staged) syncStage({ directory: dir, stagingRoot: staging, files });
    // …所有权 fence、文档/token 双重比较、advanceCommitToken（未改）
    if (staged) {
      await domain.global.set(schema.parse({ schema: 1, aggregate: latest.aggregate, applied: latest.applied, pending: { stage, aggregate, applied: ledger, files } }));
      await installPending();
    } else {
      await domain.global.set(schema.parse({ schema: 1, aggregate, applied: ledger, pending: null }));
      fs.rmSync(dir, { recursive: true });
    }
    await hydrate(current.instance.archiveReadCache);
```

**保留的**：

- 提交前的两条 fence（`assertArchiveLockHeld()`、文档与 commit token 比较）与
  `advanceCommitToken()` 的位置、语义都不变。
- `schema.parse` 仍然对**写入的那一份值**做完整投影与整份校验；要么是带 `pending`
  的文档（有暂存字节），要么是结束文档（没有）。写入路径上没有任何"跳过校验"的
  分支。
- `writeStageManifest()` 仍然写。它是那个暂存目录的可读诊断记录（崩溃后留下的
  orphan stage 里能看到这次事务的清单），代价约 0.2 ms，本轮不动它。
- 归档变更清单非空时一切都和之前一样：`syncStage()` → 发布 pending → 安装 →
  收尾 `installPending()` 清除 pending。

**改变的**：`files.length === 0` 时不再产生 `pending` 半状态，也就不再有"发布后
安装前"的窗口。这不是把边界挪走，而是这类事务不再有这个窗口：没有暂存字节需要
排序，安装清单为空，第二份写入的内容与第一份只差一个恒为 `null` 的字段。

**失败语义要说准，不能只说"什么都没发生"。** 单次写入失败分两侧：

- **介质替换完成之前失败**（`domain.global.set` 在写入/替换前抛错，或写入路径上的
  同步异常）：什么都没提交——没有标记、没有记录、没有 pending 记录；事件仍在
  仅追加的日志里，下一次 pass 重新认证并恰好应用一次。基线在同样的位置失败时也
  什么都没提交（它连 pending 记录都还没发布）。
- **介质替换完成之后失败**（官方 JSON 后端的 `writeAtomic` 先 `rename` 再 fsync 父
  目录，后一步失败）：这时新文档**已经在介质里可见，但它的断电持久性没有被确认**
  ——目录 fsync 正是让这次替换在崩溃后仍然成立的那一步。后端把内存状态回滚到旧文档，
  于是端口自己的 handle 也仍然读取旧文档、不发出 `domain/changed`，端口内存要到
  `hydrate()` 才更新（而它没有跑到），所以同一端口在重启前看不到这次提交，`query`
  仍是旧视图。调用报错，`close()` 把它重新抛出并释放锁，暂存目录留在磁盘上。
  如果这次替换在断电后幸存，事件已经提交、重启后不再应用；如果它丢失，旧文档仍是
  持久文档，事件留在日志里由下一次 pass 应用。两种情况都恰好应用一次。
  这不是本轮引入的窗口：基线对它的**每一份**文档写入都有同样的窗口（这类事务基线有
  两份写入，本轮只有一份），本轮既没有消除也没有扩大它。`fs.rmSync()` 位于提交之后，
  它失败是"提交已落定、调用报错"，且不经过后端，因此不存在内存回滚。

两条路径的最终持久化字节相同（见第 3 节），"恰好应用一次"在两种窗口下都成立。

## 3. 等价性

- **持久化字节**：脚本在冻结时钟 + 确定性 UUID 序列下跑两侧，比较整份官方文档与
  每个归档文件（含归档索引），四个场景 **逐字节相同**，三次独立会话都断言通过
  （`equivalence`）。冻结那一趟还**重新断言场景形态**：`daily` / `steady` 必须 0 笔
  改归档，`bulk` 至少 1 笔，`archive` 必须每笔都改且活动归档文件确实比预置的 40 行
  更大。没有这条断言，冻结时钟下一旦标识重复、记录被合并，"两侧相同"就会退化成
  "两侧都是空转"（本轮第一版脚本正是这样：等价性那一趟的 `archive` 只有 1 条热记录、
  归档没有增长，因此已修正并补上断言）。
- **确定性 UUID 的口径**：两侧写整份文档的次数不同，而官方后端给临时文件取名用
  同一条 `crypto.randomUUID()` 序列，因此脚本在**每笔事务前把序列重置到一个该事务
  独有的基数**（`1000, 2000, …`）：一笔事务生成的标识只取决于它自己生成了什么，
  同时跨事务保持互不相同——重置到 0 会让每笔事务生成同一批记录 id，记录被合并而
  不是累积。`test/domain-storage/domain-storage-write-path-equivalence.test.js` 的
  两个差分用例用同样的办法（`uuid.reset(i * 1000)`），并新增了这说明。
- **断言本身做过变异检验**：把脚本里的 `sequenceBase += 1000` 改成 `+= 0`（也就是
  回到本轮第一版的行为）后，脚本不产出任何数字，直接以
  `archive: the frozen run of baseline must append to the active archive on every transaction, saw 0/N`
  （N 为该次运行的样本数；实测变异时是 `saw 0/2`）
  失败退出（`archive` 场景要求**每一笔**都改归档，不是"至少一笔"）；改正后三次会话的
  冻结那一趟都是 `archive` 9/9、活动归档增长到 27,033 字节（预置 40 行之上），
  `bulk` 3/3、`daily` 与 `steady` 0/0。
- **公开结果**：同一批测试比较 `query` 投影、重启后的投影与 live 快照；重载路径
  （`hydrate()`）未改。
- **崩溃与恢复**：新用例
  `test/domain-storage/transaction-commit-shape.test.js` 的第三项在介质替换**之前**
  注入失败，断言"已提交标记、记录、pending 都为空"（被拒绝的事务什么都没发布），
  随后同一端口的下一次 pass 应用 1 条、再下一次是 1 条重复，重启后仍然只有一份；
  第四项在**真实后端的目录 fsync 处**注入失败（包装 `fs.promises.open`，对官方目录
  返回一个 `sync()` 立即抛错的 handle，也就是 `writeAtomic` 在 `rename` 之后打开的
  那个父目录），断言介质里已经是替换后的文档（标记与记录都在、`pending` 为 `null`）、
  而端口读取的 handle **仍是旧文档**（不发出 `domain/changed`）、`query` 仍是旧视图、
  锁仍被持有、暂存目录留在磁盘上、调用与 `close()` 都报错且 `close()` 仍释放锁，
  重启后 `flush()` 报 1 条重复——两种窗口下都恰好应用一次。
- **两阶段协议在有暂存字节时未被削弱**：同一文件的第二项断言归档变更事务仍然
  `{ commits: 1, closes: 1 }`、暂存目录被收尾删除、被驱逐的记录确实装进了实时
  归档树；`replay-batch-commit` 的"中断的组提交从 pending 记录恢复"、`storage` 的
  "pending 归档提交可续"、`event-log-checkpoint` 的"监听器改写 pending 记录不能
  绕过校验"、`review-fix-storage-lock-cas-overwrite` 的 C1 控制项都保留原断言，只是
  先把对应集合的热窗口填到上限，使被测事务真的有暂存字节可排序。
- **重建基线**：`test/domain-storage/domain-storage-baseline.js` 新增两段逆向替换，
  反向重建出的 `lib/domain-storage.js` 仍然与固定的 rc.8 源码逐字节相同（该文件开头
  的锚点校验通过），因此"工作树 vs 固定产物"的差分比较面没有被本轮改动。

## 4. 可复现 A/B

```sh
node scripts/benchmarks/transaction-write-path.mjs --rounds 3 --samples 9
```

脚本从 git 取出基线 `lib/domain-storage.js`（默认 `b943b21`）放进一份 `lib/` 副本，
并对两侧做形状自检：基线必须出现"发布 pending 记录 + 收尾"的形态、且不含候选的
`const staged = files.length > 0;`；候选两者都必须在。任何一侧形态不符就直接以非零
码退出，不会把同一份代码测两遍。每场景每侧有一趟干净采样（墙钟与 CPU）和一趟带 fs
包装的计数采样（机制，不用于计时），轮间交替先后顺序，`docs/performance/` 里的 JSON
逐笔保存每场景每侧每轮的样本（`daily` / `archive` / `steady` 各 9 笔，`bulk` 8 笔），
数值保存到三位小数。

四个场景都在真实官方 `DomainFacility` + `JsonStorageBackend` 上跑：

| 场景 | fixture 与负载 |
| --- | --- |
| `daily` | 1000 条已提交标记（官方文档约 152 KB，阶段归因里那份 141 KB 的同一形状），随后 9 笔事务各追加 1 条记录；集合在热上限以下，因此**每笔都不改归档** |
| `bulk` | 同上起点，8 笔事务各追加 10 条记录；运行中跨过热上限，5 笔不改归档、3 笔追加归档 |
| `archive` | 预置 40 行活动 observation 归档 + 60 次预热 observe 把热窗口推过上限，随后 9 笔 `observe()` 每笔都驱逐一条并追加归档 |
| `steady` | `flush()` 但没有新记录：每个 agent step 的路径，两侧都不开事务 |

### 4.1 三次独立会话

`bulk` 是**双峰**分布：每轮 5 笔无归档改动的事务约 15 ms、3 笔有归档改动的约 46 ms。
脚本取的是上中位数（`values[floor(n/2)]`），8 个样本时它等于**无归档组里最大的那个
样本**，因此这一组里只要有一笔异常样本，整场景中位数就跟着走——会话 2 的 `bulk` 整场景
CPU 中位数出现过 +26.3%，就是该轮无归档组里出现了一笔 22.4 ms 的样本（同组其余为
7.5–10.2 ms）。因此本轮**只报两个分组**，不报整场景中位数；分组展示没有掩盖整体趋势：
按逐笔样本求和，九轮的总墙钟全部下降 **23.7–32.7%**、总 CPU 全部下降 **18.0–34.9%**。
`archive` 与 `daily` 各只有一簇，直接报整场景中位数。

| 场景 | 会话 | 墙钟 | CPU |
| --- | ---: | --- | --- |
| `daily`（9 笔，0 笔改归档） | 1 | 26.12 → 13.89（**−46.8%**） | 11.84 → 6.87（**−42.0%**） |
| | 2 | 28.53 → 13.92（**−51.2%**） | 12.58 → 6.97（**−44.6%**） |
| | 3 | 28.22 → 13.93（**−50.6%**） | 12.89 → 7.07（**−45.2%**） |
| `bulk` 无归档改动（5/8 笔） | 1 | 30.18 → 14.98（**−50.4%**） | 14.48 → 8.88（**−38.6%**） |
| | 2 | 29.11 → 15.05（**−48.3%**） | 14.47 → 8.87（**−38.7%**） |
| | 3 | 30.35 → 15.42（**−49.2%**） | 14.42 → 9.08（**−37.0%**） |
| `bulk` 有归档改动（3/8 笔） | 1 | 46.98 → 45.91（−2.3%） | 25.80 → 23.55（−8.7%） |
| | 2 | 48.78 → 45.79（−6.1%） | 25.75 → 23.45（−9.0%） |
| | 3 | 47.77 → 47.09（−1.4%） | 25.80 → 23.68（−8.2%） |
| `archive`（9 笔，全部改归档） | 1 | 42.83 → 41.95（−2.1%） | 20.39 → 20.86（+2.3%） |
| | 2 | 44.02 → 43.71（−0.7%） | 20.01 → 20.40（+1.9%） |
| | 3 | 43.77 → 44.93（+2.6%） | 19.95 → 20.13（+0.9%） |
| `steady`（9 笔，无事务） | 1–3 | 0.01 → 0.01 ms（±0.01 ms 量级） | 同量级 |

会话的 load average（1/5/15 分钟）：会话 1 `1.56/3.43/2.82` → `1.95/3.33/2.81`，
会话 2 `1.95/3.33/2.81` → `1.97/3.18/2.78`，会话 3 `1.97/3.18/2.78` → `1.53/2.94/2.70`
（比本轮早期几次会话更繁忙）。每轮逐笔的原始样本与每轮的机械计数见三份 JSON 的
`scenarios[].rounds[]`；`bulk` 两组的 3/5 划分由脚本逐笔判定并断言两侧一致。

- **主结论**：`daily`（每笔事务都不改归档）在三次会话、九轮里全部同向，墙钟
  −47…−51%、CPU −42…−45%；`bulk` 里那 5 笔无归档改动的事务同样三次会话全部同向，
  墙钟 −48…−50%、CPU −37…−39%。这两组是唯一"被删掉的工作"与"场景"一一对应的路径。
- **`bulk` 有归档改动的那 3 笔**走的是**完全未改**的代码路径，机械计数逐项相同
  （文档替换 2、token 推进 2、`official/open.async` 4、`fsyncSync` 5）。九轮的**逐轮**
  墙钟变化是 −6.6%…+5.1%（七轮为负，会话 3 第 2、3 轮分别为 +5.1% 与 +0.1%），逐轮
  CPU 是 −14.9%…−3.7%。每组每轮只有 3 笔样本且代码相同，因此**既不作收益也不作回退
  证据**；会话级中位数（墙钟 −1.4…−6.1%、CPU −8.2…−9.0%）不作为"每轮都更快"的依据。
- **`archive` 是本次的不回退证明**：9 笔事务每笔都追加归档，机械计数与基线逐项相同，
  三次会话墙钟 −2.1/−0.7/+2.6%、CPU +2.3/+1.9/+0.9%。两侧逐轮区间分别是基线
  42.7–44.6 ms、候选 41.7–48.0 ms，区间重叠，差值落在轮间散布内——不声称收益，也没有
  可归因的回退。
- **`steady` 是空控制**：没有事务，两侧都不写任何东西。
- **异常样本**：九轮里出现过少数明显偏离同组其余样本的值（基线无归档改动组一笔
  31.1 ms CPU、候选两笔 22.4 ms，同组其余样本分别在 13–16 与 7.5–10 ms；`archive`
  候选一轮 48.04 ms，其余轮 41.7–45.3 ms）。这些样本使上中位数与个别轮次失真，分组
  中位数对这些单点不敏感，因此被本研究用的是分组中位数。测得的数据只能证明出现了
  这些异常样本，**不能确定其成因**（宿主负载、页缓存或调频都未单独测量）。

### 4.3 机制计数（每笔事务，带 fs 包装的一趟）

| 场景 | 侧 | 文档替换 | commit token 推进 | `official/open.async` | `other/fsyncSync`（`syncStage`） | `other/writeFileSync` | `other/renameSync` |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `daily` | 基线 | 2 | 2 | 4 | 2 | 3 | 3 |
| `daily` | 候选 | **1** | **1** | **2** | **0** | **2** | **2** |
| `bulk` | 基线 | 2 | 2 | 4 | 3.13 | 3 | 3 |
| `bulk` | 候选 | **1.38** | **1.38** | **2.75** | **1.88** | **2.38** | **2.38** |
| `archive` | 基线 | 2 | 2 | 4 | 5 | 2 | 2 |
| `archive` | 候选 | 2 | 2 | 4 | 5 | 2 | 2 |

`bulk` 的 1.38 = (5 × 1 + 3 × 2) / 8，正是"每笔无归档改动的事务少一份文档写入"。
`daily` 的 `other/fsyncSync` 从 2 降到 0 就是被删掉的 `syncStage()` 的两个目录
fsync；`other/writeFileSync`/`other/renameSync` 各少 1 次是少推进一次 commit token。

## 5. 收益边界

- **收益只在"归档变更清单为空"的事务上**。归档增长稳态（集合长期超过热上限）每笔
  事务都追加归档，走的仍是两阶段提交，本轮一次也没碰到它的代码路径。
- **收益随官方文档大小线性增长**：省掉的是一份整份文档的序列化、临时文件、文件
  fsync、rename 与目录 fsync。本轮的 `daily` 文档约 152 KB；`applied` 标记表随历史
  增长，因此长期安装的文档越大，这部分省得越多。反过来，文档很小时（例如 16 KB 的
  新安装）绝对毫秒很小，收益主要体现在系统调用次数上。
- **CPU 与 I/O 分开看**：本轮的 `daily` 是 CPU −42…−45%（序列化 + zod 校验 + 一次
  文件写入的 JS/内核两侧工作），墙钟 −47…−51%，多出来的那部分是一次"新 inode 首写
  fsync + 目录 fsync"的等待。
  绝对毫秒强依赖本机 fsync 成本（本机新建文件首次 fsync 约 3 ms），换主机后百分比
  不可移植；可移植的结论是**少一份整份文档写入与它为服务的两个系统调用**。
- **不声称内存占用下降**：本轮未测量 RSS 或分配量。被删掉的是同一份文档对象的
  一次投影与一次写入，常驻状态没有减少。
- **没有削弱的边界**：`schema.parse`、`assertArchiveLockHeld()`、文档与 commit token
  的双重比较、`advanceCommitToken()`、`assertLiveTreeUnchanged()`、`changedArchiveFiles()`
  的逐文件摘要、`syncStage()`（有暂存字节时）、`installArchiveFiles()` 的整份先验证、
  `pending` 记录的格式与恢复语义、`domain-staging` 事务后为空，全部保持。

### 5.1 本轮明确排除的方向（避免下一轮重复）

| 候选 | 结论 | 依据 |
| --- | --- | --- |
| 把收尾写入推迟到下一笔事务（下一笔提交点顺带清除 pending），从而对所有事务只写一份文档 | 不做 | 它要求暂存目录在事务之间存活，而 `domain-staging` 事务后为空、以及 `domain-orphan-staging` 的修复项都是既有不变量（`archive-stage-io.md` §6 已记录同一结论）；同时每时每刻的持久文档都会带着 pending 记录，doctor 会一直报"可重放的中断写入"。 |
| 把 pending 记录里的 aggregate 去掉（第一份写入只带新 aggregate + 文件清单），让第一份写入的字节减半 | 不做 | 那正是"暂存字节先于描述它们的 aggregate durable"这条排序的证据载体，去掉它等于让安装在 aggregate 之前落地，破坏恢复不变量；同时改变持久化文档形状。 |
| 让镜像只包含可写文件、密封段直接读 live | 不做 | 沿用 `archive-stage-io.md` §6 的结论：需要把 Memory 的档案解析改成两根基，属于第二套解析机制。 |
| 复用上一次事务的暂存目录 | 不做 | 同上，与"事务后暂存目录为空"冲突。 |
| 去掉 `writeStageManifest()`（无归档改动时它是纯诊断写） | 不做 | 只值 0.2 ms，但它是崩溃后 orphan stage 里唯一可读的事务清单，也是若干冻结 UUID 序列差分锚点的调用次数之一。 |
| 无归档改动时跳过 `schema.parse` 直接写入 | 不做 | 写入路径上的整份校验是边界；本轮只删掉了"写第二份完全相同的文档"，没有删掉任何一次校验。 |

## 6. 验证

```sh
NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/
NODE_OPTIONS=--max-old-space-size=4096 npm test
npm run pack:check
npm run release:verify
node scripts/benchmarks/transaction-write-path.mjs --rounds 3 --samples 9
```

全量套件 **681 项全部通过**（含 `pack:check` 的"工作树是固定产物的已提交后继"用例；
本轮改动只在提交后测过这一趟，提交前的失败是那条用例要求先提交）。

新增回归 `test/domain-storage/transaction-commit-shape.test.js` 4 项：

1. **无归档改动的事务只发布一次**：`domain/changed` 计数恰为
   `{ commits: 0, closes: 1 }`，持久文档 `pending` 为 `null`、标记与记录都在、暂存目录
   为空、下一次 pass 是纯重复；
2. **有暂存字节的事务仍是两阶段**：计数恰为 `{ commits: 1, closes: 1 }`，暂存目录被
   收尾删除，被驱逐的记录确实装进了实时归档树；
3. **替换之前的单次写入失败什么都不发布**：注入后持久文档里既没有标记也没有记录、
   没有 pending 记录，事务留下自己的暂存目录；清除注入后同一端口的下一次 pass 应用
   1 条、再下一次 1 条重复，重启后仍只有一份。
4. **替换之后、目录 fsync 失败**：在真实后端的目录 fsync 处注入失败，断言介质已是
   替换后的文档而 handle 仍是旧文档、`query` 未更新、锁与暂存目录的状态、调用与
   `close()` 都报错且 `close()` 释放锁，重启后 `flush()` 只报 1 条重复。

按新协议调整（断言强度不变，只是让被测事务真的有暂存字节，或按新形态精确化计数）：

- `test/domain-storage/replay-batch-commit.test.js`：组提交的发布计数改为
  `{ commits: 0, closes: 1 }`（该 burst 事务没有暂存字节，一次发布就是它唯一的一次
  写入，仍证明"整批一次事务"）；"中断的组提交从 pending 记录恢复"先把 experiment
  热窗口填到 50，使该事务驱逐一条实验记录并经 pending 记录提交，注入点与恢复断言
  全部保留，并新增"被打断的提交正是那个暂存了被驱逐记录的事务"。
- `test/domain-storage/storage.test.js`："pending 归档提交可续"同样先把 promotion
  热窗口填到 50。
- `test/domain-storage/event-log-checkpoint.test.js`："监听器改写 pending 记录不能
  绕过校验"的四种改写变体先把 experiment 热窗口填到 50，监听器只注册在填充之后，
  因此它看到的正是被测的那条 pending 记录。
- `test/review-fix-storage-lock-cas-overwrite.test.mjs`：C1 控制项把 observation 热
  窗口填到 50，使崩溃注入落在两阶段提交上，并新增"被打断的提交暂存了 observation
  归档"；计数随之从 6/7/8 变为 50/51/52。
- `test/domain-storage/domain-storage-write-path-equivalence.test.js`：`freezeUuid()`
  增加 `reset(base)`；两个逐字节差分用例在每笔写入前把标识序列重置到与写入序号绑定
  的基数，使"一笔写入生成的标识只取决于它自己"，两侧仍逐字节相同。理由是两侧整份
  文档写入次数不同，而官方后端给临时文件取名用同一条 UUID 序列。
- `test/domain-storage/domain-storage-baseline.js`：新增两段逆向替换，反向重建出的
  源码仍与固定的 rc.8 产物逐字节相同。

## 7. 剩余风险

- 真实断电未验证。无归档改动的事务现在只有"提交前"与"提交后"两种持久状态，崩溃
  不会留下 pending 半状态，只可能留下一个没有任何持久记录引用的暂存目录（与基线在
  发布前崩溃留下的状态相同）；该目录由 doctor 报为 `domain-orphan-staging` 的可选项，
  不阻塞启动。
- 有归档改动的事务的两阶段协议本轮未改，因此它原有的风险（"发布 pending 后、安装前"
  的窗口）不变。
- **介质替换之后才失败的窗口**：官方后端的 `rename` 与父目录 fsync 之间失败时，新
  文档可见但断电持久性未确认，调用报错、端口内存仍是旧文档。基线对它的两份文档写入
  各有一次这样的窗口，本轮的这类事务只有一份写入，因此窗口个数从 2 降到 1，但没有
  消除。第 3 节第四项在真实目录 fsync 处注入并钉住"重启后恰好一次"；本轮没有验证
  断电后 rename 真的丢失的那一半（需要真实断电或介质级故障注入），只验证了"替换
  幸存"的一半，另一半由其对称性（旧文档 + 日志重放）给出。
- 生产环境的"无归档改动事务占比"本轮没有统计，只有第 1.1 节的机制分类与脚本内
  逐笔判定（`daily` 0/9、`bulk` 3/8、`archive` 9/9）。若线上集合长期全部超过热上限，
  本轮收益会收敛到"没有收益"。这一条是本轮收益的主要不确定性。
- 本轮的绝对毫秒数依赖本机 fsync 成本；换主机后百分比不可移植，可移植的是文档写入
  次数与系统调用计数。
