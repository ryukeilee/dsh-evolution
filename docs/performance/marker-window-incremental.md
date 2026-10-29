# 私有 staged marker 窗口的增量保存判定

基线是 `d9de6b2671f185bb4ec7d538e842e8c1a070fb8e`。沿用
[`cold-apply-cost-d9de6b2-20261029.md`](cold-apply-cost-d9de6b2-20261029.md) 的成本归因，本轮只实现
marker 窗口判定的增量维护，没有转向归档读取、日志认证或提交校验。

20,000 条首次冷吸收的三轮交替 A/B：墙钟中位 **4166.9 → 3366.9 ms（−19.20%）**，
CPU **4405.7 → 3604.3 ms（−18.19%）**。同码 A/A 墙钟漂移 +0.42%，CPU +0.12%。
保存检查内访问 marker 的次数由 **73,529,344 → 19,999**；正文仍每次保存同步 stringify，
最终发布仍校验完整文档。归档树、领域文档、checkpoint 内容与查询投影逐字节等价。

**候选没有提交、推送或更新固定发布产物。** 全量测试 1247/1248，唯一失败是未提交分发改动触发的
release-pin 门禁；`pack:check` 15/16，同一原因。本地打包成功，三个支持宿主隔离验收全部 21/21。

## 为什么这个增量判定可以复用

旧实现已经用 WeakMap 记住冻结 marker 的判定，但仍在每次保存遍历整个最多 4096 项的窗口。
可变数组不能按身份缓存：「同一个数组」并不证明里面没有换入 BigInt、toJSON 或可变嵌套对象。

本轮只在 `createMemory()` 有 archiveWriteGuard 的私有 staged 工作副本中启用
`transaction.bridgeWindowChanged`：

1. staged 初始聚合本来就先经 `structuredClone(initial)` 脱离已提交文档；它不交给外部调用者。
   load 冻结 marker 后，再冻结**这个副本自己的窗口数组**，通知 seed；普通 Memory 不提供 hook，
   保持原来的可变数组。
2. 私有 Memory 后续创建原生、密集、有界的新数组，保留最后至多 4095 个旧 marker，并加一个
   新 marker，然后冻结其成员关系。旧窗口不再被 push 改写，所以对旧窗口的判定始终描述同一组成员。
3. 通知只记录新窗口与旧窗口、新 marker 的谱系，**不 stringify、不提前判定**。
   前一窗口成功验证过时，下一次 save 只判新增 marker；尚未成功验证的窗口仍完整扫描。
4. 每次 save 先做原来的 envelope 门控、正文 stringify 与 literal 检查，再查窗口证书。
   BigInt、循环或正文 toJSON 仍在该次 save 抛错；新增 marker 仍到该次 save 才判定。
   非标准/可变/未报告窗口、嵌套 marker、marker 自有 toJSON、正文或 marker 含 literal 等情况仍走
   原来的完整检查；fallback 或抛错不会把窗口标成 verified。
5. WeakMap 只属于该 staged 工作副本，随事务释放；每个新事务、重启或未报告的替换窗口需要重新建立判定。
   这不是给普通调用方的数组身份缓存，也不是安全沙箱。私有通知的前提写入 `PORTS.md`。

首次保存空窗口仍走旧整体检查；新 marker 在下一条事件保存时被检查，所以 20k 负载里正好检查
19,999 个新 marker。最后一个 marker 仍由最终发布的完整文档校验覆盖，与原实现一致。

## 撤回的首版

首版对冻结数组使用 `slice/concat` 生成后继，20k 单轮墙钟
4182.8 → 5086.5 ms（**+21.60%**），CPU +20.77%，因此撤回；原始数据保存在
[`marker-window-incremental-pilot.json`](marker-window-incremental-pilot.json)。
冻结数组上的该复制路径代价抵消了省下的窗口判定，不把逻辑等价当作性能成立。

最终实现对至多 4095 个旧槽位做一次有界复制到预分配数组，再写入新 marker 并冻结。
先导结果见 [`marker-window-incremental-copy-pilot.json`](marker-window-incremental-copy-pilot.json)，
正式结论只取下面三轮 A/B 和 A/A。没有修改普通 Memory 的 push/slice 路径。

## 正式端到端数据

Node v26.12.1、darwin/arm64；父/子进程均带 4096 MiB V8 堆上限。真实 openDomainStorage、官方
DomainFacility / JsonStorageBackend，原有 archive-append-window 合成夹具、每样本独立临时根、
没有 checkpoint。各性能实验串行，三轮交换先后顺序，后续各测 12 次 observe / flush。
基线由 git archive d9de6b2 解出；候选未提交，因此两侧 HEAD 相同，实际代码以原始 JSON 记录的
`candidateSources`（现在同时含 domain-storage.js 与 memory.js）哈希区分。

| 项目 | 基线 | 候选 | 同码 A/A 漂移 |
| --- | ---: | ---: | ---: |
| 冷吸收墙钟 ms | 4166.9 | 3366.9 | +0.42% |
| 冷吸收 CPU ms | 4405.7 | 3604.3 | +0.12% |
| 稳态 observe 墙钟 ms | 50.99 | 51.07 | −0.84% |
| 稳态 flush 墙钟 ms | 10.82 | 10.74 | −0.59% |
| 整进程峰值 RSS MiB | 414.2 | 393.1 | 409.8 → 409.9 |
| 强制 GC 后 heap+external MiB | 45.1 | 47.2 | 50.2 → 47.2 |

A/B 逐轮配对墙钟差 −778.4 / −849.7 / −800.1 ms，CPU 差 −781.6 / −837.4 / −791.4 ms；
A/A 对应最大绝对差仅 19.0 / 15.2 ms。冷吸收收益明显超出同码噪声。

**不声称稳态收益或内存收益。** A/B 峰值 RSS 配对差 −21.1 / −9.1 / −2.2 MiB，而同码 A/A
配对差 −11.8 / +0.1 / +19.7 MiB，两轮 A/B 落在 A/A 离散范围内。保留堆中位反而增加约 2.0 MiB，
A/A 两侧自身差约 3.0 MiB。maxRSS 含夹具和后续稳态操作，不是吸收阶段可达对象的精确峰值；
本轮没有重做分配 profile，不从前一研究的分配流量推导候选 RSS。

数据：[`A/B`](marker-window-incremental.json)、[`A/A`](marker-window-incremental-aa.json)。

## 等价、故障与机制证据

[`marker-window-incremental-equivalence.json`](marker-window-incremental-equivalence.json) 冻结时间与 UUID，
跑同一 20k 负载，确认：整棵归档树（3 文件）、领域文档、checkpoint 内容、查询投影相同，marker
数 20,000，staged 残留 0，checkpoint 文件身份字段与 MAC 形状存在。这里比较的是固定输入下的
实际持久字节，不拿非冻结计时样本中不同临时根/时间的文件长度当等价证据。

[`marker-window-incremental-mechanism.json`](marker-window-incremental-mechanism.json) 在候选真实
冷吸收中记录：markerVisits = 19,999、markerSerializations = 19,999。该计数轮时间不进入 A/B。
计数 hook 在 stop 返回 detached 计数，避免后续 warm observe 再建立的 4096 项 seed 污染冷窗口统计。

新增 `test/domain-storage/staged-window-incremental.test.js` 的五项覆盖：

- 已验证后继只判新增 marker；旧/新数组均不可改写成员。
- 可变窗口被替换为 BigInt 后仍拒绝；未报告的冻结替换窗口也完整检查。
- 通知时不调用新增 marker 的 toJSON；到 save 才抛错，失败后重试仍拒绝，不缓存成功。
- 已有窗口证书不能跳过正文 BigInt / 循环 / toJSON / literal；嵌套 marker 后续变化仍在 save 拒绝。
- 真实 Memory 的 seed / 后继有界且冻结，4096 项 seed 后只增加两次 marker 判定；普通 store 的
  窗口仍可变，最终 eventId 序列相同。

[`marker-window-incremental-mutations.json`](marker-window-incremental-mutations.json) 记录四项变异，
均被新测试拒绝：漏判新增 marker、缓存命中时跳过正文、检查失败前先认证窗口、后继数组不冻结。

旧 staged-save-check 的 43 类载荷差分继续运行。两套历史重建先精确反转本轮，再执行原有反转表；
本轮反转对 d9de6b2 的 domain-storage.js / memory.js 固定 SHA-256，旧 rc.8 字节锚点和旧整树
固定摘要保持原值，避免把候选逻辑带入对照后误报等价。

## 验证与交付状态

结构化记录：[`marker-window-incremental-validation.json`](marker-window-incremental-validation.json)。

| 检查 | 本次结果 |
| --- | --- |
| 25 项保存检查 / 新机制 / 两套持久字节差分聚焦测试 | 25/25 |
| NODE_OPTIONS=--max-old-space-size=4096 npm test | 1247/1248；唯一失败 release-pin 拒绝未提交分发改动 |
| npm run pack:check | 15/16；同一个未提交分发改动门禁 |
| npm run release:pack -- --dist /tmp/dsh-marker-window-build-20261029 | 成功；51 条目，两次打包字节相同 |
| 0.2.0-rc.2 隔离真实安装验收 | [21/21](../evidence/marker-window-incremental-dsh-0.2.0-rc.2.json) |
| 0.2.1-alpha.1 隔离真实安装验收 | [21/21](../evidence/marker-window-incremental-dsh-0.2.1-alpha.1.json) |
| 0.2.1-rc.2 隔离真实安装验收 | [21/21](../evidence/marker-window-incremental-dsh-0.2.1-rc.2.json) |

三份宿主证据的 contentSha256 都是
`bf2a18c50a118aaaefecdcd9aed106e988d26305cfca777386765fe1d7a859e7`，与同一候选 tarball 一致。
候选 tarball SHA-256 是 `7029ad803fd80db5c5d4819f4ccfc50ce4831dc25ee9e1ca0808a0118f4ffd83`。
宿主 runtime / DSH_HOME 均是脚本新建的隔离临时目录。最初将 npm 的 user/global config 同时
设为 /dev/null 被 npm 的 double-loading 检查拒绝，尚未启动宿主验收；改用两份独立空配置后，
三次正式安装及全部 probe 成功，没有绕过验收步骤。

两项固定点门禁的失败保留原样：任务禁止提交，也没有授权重固定发布产物，不能伪造绿色结果。
release/ 没有变动，未创建代理、未运行独立审核、未提交、未推送。候选及证据留在工作树等待主任务接收。

## 复现

```sh
node --max-old-space-size=4096 scripts/benchmarks/archive-append-window.mjs \
  --baseline-ref d9de6b2 --records 20000 --rounds 3 --observes 12 --flushes 12 \
  --out docs/performance/marker-window-incremental.json
node --max-old-space-size=4096 scripts/benchmarks/archive-append-window.mjs \
  --aa --records 20000 --rounds 3 --observes 12 --flushes 12 \
  --out docs/performance/marker-window-incremental-aa.json
node --max-old-space-size=4096 scripts/benchmarks/archive-append-window.mjs \
  --baseline-ref d9de6b2 --records 20000 --validate --observes 2 --flushes 2 \
  --out docs/performance/marker-window-incremental-equivalence.json
node --max-old-space-size=4096 scripts/benchmarks/marker-window-mechanism.mjs \
  --records 20000 --out docs/performance/marker-window-incremental-mechanism.json
NODE_OPTIONS=--max-old-space-size=4096 npm test
npm run pack:check
npm run release:pack -- --dist /tmp/<fresh-output>
# 对 package.json 声明的三个宿主逐一执行，使用上一步同一个 tarball：
NODE_OPTIONS=--max-old-space-size=4096 npm run acceptance:host -- \
  --host <declared-version> --tarball /tmp/<fresh-output>/dsh-evolution-0.2.0-rc.19.tgz \
  --out docs/evidence/<fresh-evidence>.json
```

收益边界：只证明本机 Node 26 的 20k 首次吸收；未测其它 Node / OS、冷页缓存或真实事件混合分布。
其它事件类型由现有完整回归和三宿主核心/生命周期/晋升重启探针覆盖行为，没有为它们声称性能收益。
