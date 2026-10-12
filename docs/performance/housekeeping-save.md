# Housekeeping 单次 pass 开销

本轮只改 `lib/dockyard-domain/memory.js` 的 `#performHousekeeping()`：它由
`#save()` 在每次保存前调用，原来对每条被退休记录线性扫描 tombstones、对每个被删
重复条目各做一次 `indexOf`/`splice`、并在规则 4 与规则 5 中重复派生同一记录的
候选指纹。现在每次 pass 只建一次 tombstone 索引（record id / fingerprint /
candidate fingerprint，随后由退休路径增量维护），缺指纹记录只派生一次指纹，
去重改为一次性原地压缩。

基线是 `test/dockyard-domain/housekeeping-baseline.js` 从当前源码逆向重建的
改动前完整实现：6 组替换都带精确形状断言，重建结果与 `git HEAD` 的
`lib/dockyard-domain/memory.js` 逐字节相同，`#performHousekeeping` 块与固定产物
`release/dsh-evolution-0.2.0-rc.7.tgz` 中的同块逐字节一致（该产物尚未包含本轮
改动，因此仍是权威的改动前来源）。两种实现使用同一棵树中的兄弟模块，所有数据
位于 `os.tmpdir()`。原始逐次样本、源码哈希、环境与每轮统计见
[`housekeeping-save.json`](housekeeping-save.json)。

## 负载与环境

- `default-save`：插件生产默认构造（`maxEntries=1000`、`hotEntries=50`，file
  stateStore 使 `archiveFile` 生效）下 2000 次公开写入
  （`recordCandidate` / `recordProposal` / `recordPromotion` /
  `recordObservation` 轮换），每次写入都走 `save → housekeeping`；会话开始与
  结束各调用一次公开 `housekeeping()`。归档随写入有机增长，结束时会话内
  tombstones 约 500 条、各热池处于 50 条上限。
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
  `[1.31, 1.40, 1.61]` 到 `[1.90, 1.96, 1.81]`，随后台进程波动；没有并行测试或
  其它基准。因此下表只作为同机同轮的相对比较，不能当作安静机器的性能上限。

## 实测结果

中位数按每个实现 5 个正式样本计算，未混入预热。`default-save` 两列分别是会话
开始与结束时的公开 `housekeeping()`（同一进程内的单点样本）。

| 规模 | 路径 | before 中位数 (ms) | after 中位数 (ms) | 变化 |
| --- | --- | ---: | ---: | ---: |
| default-save | 会话末 `housekeeping()`（T≈500） | 0.1518 | 0.1351 | −11.0%（−0.0167 ms） |
| default-save | 2000 次公开写入总计 | 61987.800 | 61889.253 | −0.16%（在 noise 内） |
| hot-200 | 单次 `housekeeping()` | 23.9240 | 16.6043 | −30.6%（−7.32 ms） |
| hot-1000 | 单次 `housekeeping()` | 262.5184 | 79.9131 | −69.6%（−182.6 ms） |
| hot-5000 | 单次 `housekeeping()` | 4851.950 | 397.894 | −91.8%（−4454.1 ms） |

逐轮正式样本（每个数字是该轮单次测量，单位 ms；顺序为当轮的 baseline → after
或 after → baseline）：

| 轮次 | default-save before / after | hot-200 before / after | hot-1000 before / after | hot-5000 before / after |
| --- | --- | --- | --- | --- |
| 1 | 0.1608 / 0.1539 | 24.3899 / 16.6043 | 264.4832 / 81.8130 | 4851.950 / 395.8387 |
| 2 | 0.1793 / 0.1151 | 23.9240 / 17.0960 | 263.6271 / 80.6667 | 4978.3727 / 398.4209 |
| 3 | 0.1500 / 0.1887 | 23.8537 / 16.2186 | 261.8211 / 79.9131 | 4848.8093 / 397.8940 |
| 4 | 0.1518 / 0.1351 | 23.6998 / 16.9219 | 259.8945 / 78.5562 | 4926.1852 / 400.7866 |
| 5 | 0.1460 / 0.1330 | 24.0776 / 15.8256 | 262.5184 / 79.3014 | 3290.6877 / 397.7548 |

`default-save` 的写入总耗时逐轮为 62105.5 / 62102.3 / 61777.3 / 61858.7 /
61987.8 ms（baseline）与 61840.5 / 61889.3 / 63005.8 / 61946.0 / 61954.6 ms
（after）：单次写入中位数 31.596 → 31.4411 ms，MAD 约 14.4 ms。该路径由归档
索引重写、JSON 序列化与文件 I/O 主导，housekeeping 只占约 0.2–0.5%，因此
**在插件默认配置下端到端写入没有可辨认的收益**，本节只主张 housekeeping 自身
的 CPU 降低。

hot-5000 的 baseline 存在明显方差（min 3290.7、max 4978.4 ms），符合其平方级
退化随堆状态变化更剧烈；after 在该规模稳定在 395.8–400.8 ms。

## 等价与回归

- `node --test test/dockyard-domain/housekeeping-equivalence.test.js`：16/16 通过。
  每次成对执行都断言 `fullSnapshot()` JSON sha256、tombstones 字节/顺序/条数、
  hot tombstones 字节、归档文件集合与字节与基线一致（24 条成对等价记录，全部
  一致），并覆盖规则 1 的 recordId OR fingerprint 命中、规则 4 的胜出者与并列
  规则、终态与归档边界、重启后（含 `.segments`）逐字节相同，以及形状漂移注入
  必须报错。
- 其中一条固定种子随机差分用例生成 300 个状态（一半用 file store 并启用规则
  5/7 归档），比较完整快照、tombstones 与 state/archive 字节，0 处不一致。
  开发期间另有 4000 次同形随机差分，同样 0 处不一致。
- `node --test test/dockyard-domain/`：72/72 通过（含 archive-index 等价套件，
  其基线组合逆向重建后仍与固定产物逐字节相同）。

独立复核由 codex `gpt-6.1-sol` 子代理编写上述等价套件时完成，并**发现一处真实
分歧**：`tombstones` 含 `null`/`undefined` 时，基线在规则 4 中先 `splice` 掉
失败者、再因异常 tombstone 的线性扫描中止；当时实现把删除推迟到 tombstone 检查
之后，中止时尚未压缩数组，于是保留了本应被删除的记录。最小输入：

```js
{ tombstones: [null], candidates: [
  { id: "loser", fingerprint: "same" },
  { id: "winner", fingerprint: "same", fitnessScore: 2 } ] }
```

修复方式：规则 4 在 tombstone 索引不可用时退回原来的逐条 `indexOf`/`splice` 加
线性扫描循环，保留中止前的部分删除语义；索引可用时（所有正常记录）才使用原地
压缩。修复后该用例连跑两次 `housekeeping()` 与基线逐字节一致。

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

## 收益边界与剩余风险

- 收益只来自删除“每次 pass 重复做的工作”：tombstone 线性扫描、重复指纹派生与
  逐条 `indexOf`/`splice`。所以收益随热池规模与 tombstones 数量增长，在
  `hotEntries=50` 的生产默认配置下 housekeeping 本身只减少约 11%，端到端写入
  无可辨认变化；本次没有测量官方宿主、真实 agent 工作负载、内存峰值或冷/热
  归档比例不同的负载。
- tombstone 索引在每次 pass 重建，仍是 O(T)。本轮没有引入跨 save 的持久索引，
  因为 tombstones 还会被 `recordTombstone`、加载裁剪与归档 hydrate 改变，跨
  save 缓存需要新的失效协议；这是刻意留下的优化空间。
- `default-save` 与 hot 规模的写入路径都包含真实文件 I/O，机器负载未受控，
  表中绝对值不可跨机器比较；两次实现始终同机同轮交替测量，相对结论仅限
  本次运行。
- 未覆盖：磁盘写入失败、并发写入、NaN 热池成员（JSON 无法表示，公开 API 也
  无法产生）、以及超大 `maxEntries` 下的内存占用变化。
