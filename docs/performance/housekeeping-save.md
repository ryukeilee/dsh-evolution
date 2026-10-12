# Housekeeping 单次 pass 开销

本轮只改 `lib/dockyard-domain/memory.js` 的 `#performHousekeeping()`：它由
`#save()` 在每次保存前调用，原来对每条被退休记录线性扫描 tombstones、对每个被删
重复条目各做一次 `indexOf`/`splice`、并在规则 4 与规则 5 中重复派生同一记录的
候选指纹。现在每次 pass 只建一次 tombstone 索引（record id / fingerprint /
candidate fingerprint，随后由退休路径增量维护），缺指纹记录只派生一次指纹，
去重改为一次性原地压缩。

基线是 `test/dockyard-domain/housekeeping-baseline.js` 从当前源码逆向重建的
改动前完整实现：6 组替换都带精确形状断言，重建出的 `#performHousekeeping` 块
（7064 字节）与固定产物 `release/dsh-evolution-0.2.0-rc.7.tgz` 中的同块逐字节
一致，再叠加 archive-index 变更的逆向重建后，整个 `memory.js` 与该产物逐字节
相同。该产物早于本次改动，因此是权威的改动前来源；锚点缺失时测试直接失败，
不会退化成只检查自身形状。两种实现使用同一棵树中的兄弟模块，所有数据位于
`os.tmpdir()`。原始逐次样本、源码哈希、环境与每轮统计见
[`housekeeping-save.json`](housekeeping-save.json)。

## 负载与环境

- `default-save`：插件生产默认构造（`maxEntries=1000`、`hotEntries=50`，file
  stateStore 使 `archiveFile` 生效）下 2000 次公开写入
  （`recordCandidate` / `recordProposal` / `recordPromotion` /
  `recordObservation` 轮换），每次写入都走 `save → housekeeping`；会话开始与
  结束各调用一次公开 `housekeeping()`。归档随写入有机增长，结束时会话内
  tombstones 500 条、candidates / proposals / observations 都停在 50 条热上限。
- `hot-200` / `hot-1000` / `hot-5000`：种子 `state.json` 中 candidates /
  proposals 各 N 条（每 4 条同指纹一组、每第 4 组两个指纹字段都缺失、含
  `REJECTED` / `NEEDS_EVIDENCE` 终态）、promotions / strategies /
  experimentRecords 各 N 条 `OBSOLETE`、tombstones N 条，且 candidates /
  proposals 各有非空归档文件。计时区间只含一次公开 `housekeeping()`；状态重建、
  `load()`、断言与快照都在计时外。这三个规模是构造器公开选项
  （`hotEntries` 被限制在 `maxEntries` 以内），不是生产插件的默认值。
- 每个规模 6 次成对执行（1 次预热 + 5 次正式），逐次交替 baseline / after 顺序。
- Node `v26.11.1`，`darwin/arm64`，Darwin `27.0.1`，Apple M2，8 个逻辑 CPU、
  16 GiB 内存。机器**不是**空闲机器：测量期间 load average 从
  `[2.12, 1.68, 1.73]` 到 `[1.88, 1.85, 1.81]`，随后台进程波动；没有并行测试或
  其它基准。下表只作为同机同轮的相对比较，不能当作安静机器的性能上限。

## 实测结果

中位数按每个实现 5 个正式样本计算，未混入预热。`default-save` 两行分别是会话
开始与结束时的公开 `housekeeping()`（同一进程内的单点样本）。

| 规模 | 路径 | before 中位数 (ms) | after 中位数 (ms) | 变化 |
| --- | --- | ---: | ---: | ---: |
| default-save | 2000 次公开写入总计 | 61607.553 | 61601.393 | 无可辨认变化 |
| default-save | 会话末 `housekeeping()`（T=500） | 0.1615 | 0.1304 | −19.3%（−0.0311 ms） |
| hot-200 | 单次 `housekeeping()` | 24.6678 | 16.9035 | −31.5%（−7.7643 ms） |
| hot-1000 | 单次 `housekeeping()` | 263.9822 | 79.7924 | −69.8%（−184.1898 ms） |
| hot-5000 | 单次 `housekeeping()` | 4885.5186 | 399.4117 | −91.8%（−4486.1069 ms） |

四个规模的离散程度（MAD / min–max，单位 ms）：`default-save` 会话末
before 0.0140 / 0.1471–0.1818、after 0.0084 / 0.1160–0.1411；`hot-200`
before 0.3302 / 23.7802–26.2895、after 0.5980 / 16.0606–17.5045；`hot-1000`
before 1.9626 / 260.7841–266.9095、after 0.7086 / 79.0837–83.0515；`hot-5000`
before 31.5630 / 4666.3293–4917.0816、after 1.1173 / 398.1032–411.9594。
会话开始（`beforeHousekeepingMs`）中位数 0.0200 → 0.0137。

default-save 的会话末 housekeeping：before 5 轮
`0.1615 / 0.1556 / 0.1818 / 0.1755 / 0.1471`（MAD 0.014），after 5 轮
`0.1411 / 0.1220 / 0.1304 / 0.1160 / 0.1346`（MAD 0.0084）：五轮 after 都低于
五轮 before（after 最大 0.1411 < before 最小 0.1471），中位数低 19.3%。样本量
只有每边 5 次、机器未受控，这里只报告本次运行观测到的差异，不外推为稳定收益。

写入总耗时逐轮为 baseline `61819.1529 / 61592.577 / 61613.2543 / 61545.9901 /
61607.5528` ms、after `61952.715 / 61775.7525 / 61601.3931 / 61340.6862 /
61436.007` ms；单次写入中位数 31.3289 → 31.2621 ms（MAD 各约 14.4 ms）。该路径
由归档索引重写、JSON 序列化与文件 I/O 主导，按实测墙钟比例 housekeeping 只占
写入均值的约 0.52%（before）与 0.42%（after），因此**在插件默认配置下端到端
写入没有可辨认的收益**；本节只主张 housekeeping 自身耗时的降低，且未做
profiling，不把墙钟耗时差分解为 CPU 时间或分配次数。

`pooledWrites`（每边 10,000 条逐次写入）的 median/MAD 直接由基准脚本计算并写入
JSON，但 24,000 条逐次原始样本约 5 MB，未入库，因此这两个分布数值无法被独立
重算；每个会话的 `writeTotalMs` 与逐轮样本则完整保留在 `invocationSamples`。

## 收益边界

- 收益只来自删除“每次 pass 重复做的工作”：tombstone 线性扫描、重复指纹派生与
  逐条 `indexOf`/`splice`。所以收益随热池规模与 tombstones 数量增长；在
  `hotEntries=50` 的生产默认配置下 housekeeping 只降到本次观测的约八成，端到端
  写入无可辨认变化。官方宿主、真实 agent 工作负载、内存峰值与冷/热归档比例不同
  的负载都不在本次测量范围内。
- tombstone 索引在每次 pass 重建，仍是 O(T)。本轮没有引入跨 save 的持久索引，
  因为 tombstones 还会被 `recordTombstone`、加载裁剪与归档 hydrate 改变，跨 save
  缓存需要新的失效协议；这是刻意留下的优化空间。
- 未覆盖：磁盘写入失败、并发写入、NaN 热池成员（JSON 无法表示，公开 API 也无法
  产生）、带 getter 的内存 store（自定义 store 可构造，JSON 落盘后不会保留
  getter），以及超大 `maxEntries` 下的内存占用变化。随机差分生成器里有约 5%
  的候选/提案是非对象成员，命中时 pass 会提前中止，因此那部分样本只覆盖中止前
  的规则；这一点由固定输入的逐条用例补齐。第二轮对抗式复核之后没有再做第三轮
  独立复核：修复的证据是每个反例对应的回归用例与同形随机差分，不是新一轮
  审查。

## 等价与回归

- `node --test test/dockyard-domain/housekeeping-equivalence.test.js`：22/22 通过。
  每次成对执行都断言 `fullSnapshot()` JSON sha256、tombstones 字节/顺序/条数、
  hot tombstones 字节、归档文件集合与字节与基线一致（24 条成对等价记录，全部
  一致），并覆盖规则 1 的 recordId OR fingerprint 命中、规则 4 的胜出者与并列
  规则、终态与归档边界、重启后（含 `.segments`）逐字节相同、形状漂移与锚点
  缺失必须报错。
- 其中一条固定种子随机差分用例生成 300 个状态（一半用 file store 并启用规则
  5/7 归档），比较完整快照、tombstones 与 state/archive 字节，0 处不一致。
  开发期间另有 4000 次同形随机差分（含 null 指纹、假值 tombstone、无法转换的
  字段），同样 0 处不一致。
- `node --test test/dockyard-domain/`：79/79 通过（含 archive-index 等价套件）。

### 两轮独立复核发现的真实分歧

第一轮由 codex `gpt-6.1-sol` 子代理独立编写上述等价套件时完成，第二轮由另一个
同模型子代理只读对抗式复核（独立构造 357 组输入）完成。两轮都**找到了真实分歧**，
说明“实现等价”不是靠现有测试默认成立的：

1. `tombstones` 含 `null`/`undefined` 时，基线在规则 4 里先 `splice` 掉失败者、
   再因异常 tombstone 中止。当时实现把删除推迟到 tombstone 检查之后，中止时数组
   尚未压缩，于是保留了本应删除的记录。最小输入
   `{ tombstones: [null], candidates: [{ id: "loser", fingerprint: "same" }, { id: "winner", fingerprint: "same", fitnessScore: 2 }] }`。
   修复：索引不可用时，规则 4 退回原来的逐条 `indexOf`/`splice` 加线性扫描循环。
2. `fingerprint: null` 会把指纹派生短路：基线继续走
   `candidateFingerprint ?? fingerprint ?? derived`，当时实现只判断了
   `!== undefined`，把 `null` 当有效指纹，导致两条不同记录共享同一指纹后被删掉
   一条。最小输入 `{ candidates: [{ id: "a", fingerprint: null, problem: "a" }, { id: "b", fingerprint: null, problem: "b" }] }`。
   修复：只有非 nullish 的显式值才允许短路。
3. 原实现取 `find()` 返回的**元素**并判断其真假，索引只返回存在性，于是
   tombstones 里的假值元素（`0`、空字符串、`false`；`null`/`undefined` 另有中止
   语义）命中时少建一条 tombstone。最小输入
   `{ tombstones: [0], promotions: [{ status: "obsolete" }] }`。修复：tombstone
   列表出现任何假值元素时退回首部线性扫描。
4. 规则 4 的原地压缩是延迟的：当 `tombstoneFor` 因字段无法转换而抛错时，基线已经
   删掉了失败者，当时实现把这次删除也丢了。最小输入
   `{ candidates: [{ id: "a", fingerprint: "x", problem: { toString: 0, valueOf: 0 } }, { id: "b", fingerprint: "x", fitnessScore: 1 }] }`。
   修复：索引路径用 `try`/`catch` 包住，出错时先回放已决定的删除再抛出。

上述四个反例都已作为回归用例固化为测试（null 指纹、`0`/空字符串/`false`
tombstone、构造抛错、后续分组中止），随机差分生成器也加入了对应形状。

复核同时指出性能文档问题，均已修正：初稿把 default-save 的 after 写入逐轮数字
写错（已改为 JSON 原值）；把默认配置下的 11% 写成稳定收益（当时 after MAD 大于
差值，属过度解读）；未标注 `pooledWrites` 逐次样本未入库；把基线描述为等于
`git HEAD`（事实是与 rc.7 产物逐字节一致）。复核还指出 `release pin` 跟随升级
后锚点会退化成自证，因此基线改为锚定 rc.7 产物并叠加 archive-index 变更的完整
逆向重建，锚点缺失直接失败。

## 复现

从仓库根执行；除命令本身外不并行运行测试或基准。脚本用
`housekeepingBaseline()` 生成基线源码到临时目录，再用 `--memory` 传入子进程，
不修改工作树、不 stash。

```sh
# 正式测量（4 个规模 ×（1 预热 + 5 次）× 2 个实现，约 13 分钟）
node scripts/benchmarks/housekeeping-save.mjs --scale all --rows 2000 --warmup 1 --runs 5

# 快速 smoke（单轮）
node scripts/benchmarks/housekeeping-save.mjs --scale default-save --rows 240 --warmup 0 --runs 1
node scripts/benchmarks/housekeeping-save.mjs --scale hot-1000 --warmup 0 --runs 1
```

脚本对每次成对执行断言等价性，并把逐次样本、摘要哈希与 summary 以 JSONL 打到
stdout；不等价或以非零退出码结束。等价回归：
`node --test test/dockyard-domain/housekeeping-equivalence.test.js`。
