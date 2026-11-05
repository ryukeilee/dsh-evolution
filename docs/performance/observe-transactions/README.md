# 高频故障观测事务评估

基线：`02a91adcf47c3d0f3911cc40b6795cd5a1fccc9c`。本次保留生产代码，不采用合批原型。原型能够减少事务，但改变有效观测在邻居失败时的持久结果，并改变自治候选形成时可见的证据前缀。它没有通过语义等价门槛，不能把测得的速度差当作已交付收益。

## 可复现方法

```sh
node --max-old-space-size=4096 --expose-gc scripts/benchmarks/observe-transactions.mjs \
  --out docs/performance/observe-transactions/raw.json
node --max-old-space-size=4096 scripts/benchmarks/archive-observe-attribution.mjs \
  --segments 0 --samples 3 --warm-writes 60 \
  > docs/performance/observe-transactions/attribution.json
node --max-old-space-size=4096 --test test/domain-storage/observe-transaction-boundaries.test.mjs
```

基准从 Git 导出三份固定基线：A、A-control 完全相同，B 只在临时副本的 `observe` 入口收集相邻调用，在已有 promise 队列与 `mutate()` 中逐条 `record()` 后共同提交。最多 32 条；其他入队操作和开始执行都会封闭批次，没有 timer 或后台循环。原型保留在基准脚本中以复现反例，不属于分发文件。

使用真实 `@deepseek-ai/dsh-storage-domain` 的 `DomainFacility` 和 `@deepseek-ai/dsh-storage-json` 的 `JsonStorageBackend`；所有存储位于新建临时目录。通过 `registration.apply()` 注册的 `agent/error` 和 `tools/result` 监听器交替产生并发观测。宿主的 emit 调度由夹具调用监听器替代，未计入真实模型、网络或完整宿主启动时间。阈值为 3，策略风险为 medium，所以测量终点是等待确认的候选，不是 Trial 或生产晋升。

历史规模为 0、100、1000 条不同故障身份，经真实逐条写入构造；每个样本复制同一关闭后的夹具。测量 1、8、32 条观测；每种规模先暖机，随后四轮交替 `A → A-control → B` / `B → A-control → A`。端到端计时从调用监听器到全部观察者完成；另记首个候选耗时。初始化、历史构造、关闭与重启验证不计时。每个样本都重启检查观测总数和自治证据数。

三个分支使用相同的轻量 I/O 计数器，覆盖同步文件操作和官方后端 `FileHandle.writeFile/sync`、异步 rename。`transactions` 数实际创建的 `stage-*`，`domainSets` 数领域提交调用；冷归档事务可能有 pending 与最终文档两次 set，不能把 set 数当作事务数。`async.writeBytes` 是官方 JSON 后端写入字节，不是全部磁盘物理写入量；同步归档写入只报告调用数。CPU 为 `process.cpuUsage()`，内存是计时窗口两端 RSS / heap 差值，不是峰值或泄漏判定。各实现同进程、依次运行，不能将这些样本当作独立机器统计或稳定的长时服务分布。

## 调用链归因

`registration` 两个独立 listener → `observeAutonomous()` → `await port.observe()` → `enqueue()` → `mutate()` → `store.record(projectObservation(dto))`。

每次 `mutate()` 都恢复 pending、读取提交基线、镜像归档、构造并加载工作 Memory、写入观测、排空归档索引、校验活树与 CAS、提交领域文档、重载 live Memory。无归档变更时已有单次领域提交快速路径；有变更则复用 pending 安装协议。B 保留 record 的逐条领域工作，消除同批后续条目的整套事务外壳，因此事务数与后端写入数下降能归因于合并提交，而不是再次优化事件桥重放、冷扫描或归档镜像。

`attribution.json` 单独捕获同步 I/O 调用栈，显示镜像/校验/清理位于 `archive-stage.js`，Memory 加载的文件探测位于 `memory.js`。其堆栈捕获开销显著，不作为延迟基线；嵌套 `writeFileSync → openSync` 会重复计时，不能相加当 CPU 百分比。该夹具的重复故障会被既有保留规则压缩，`warm-writes 60` 不代表 60 条独立历史，也不声称覆盖冷观测归档写入；真实历史规模由主基准独立验证。

## 否决证据与成本边界

1. 同时提交 A、坏 DTO、C：原实现的结果是成功/失败/成功，重启仍有 A、C；B 三条全部失败，重启为空。坏 DTO 用抛错 getter 注入。虽然官方 listener 通常生成普通 DTO，这个反例只证明端口边界；下面的提交失败反例直接覆盖普通 DTO。
2. 三条合法 DTO，第一次领域提交在写入前拒绝一次：原实现失败/成功/成功，重启保留后两条；B 三条全部失败，重启为空。错误不是因为三条输入无效，而是一个提交故障扩大到了所有调用。
3. 八条正常并发、两种故障交替：原实现前四次仍为 `pattern-observing`，B 的第一条返回时就能看到已提交的同模式四条证据，八次都返回候选。这没有在提交前决策，但改变了阈值跨越时调用者、证据集合和返回阶段。低风险情况下可能进一步改变取得 Trial 所有权的 agent；本次未用基准执行低风险 Trial，不把这一推论写成实测结果。
4. 新增回归还注入“领域 set 已成功后抛错”：原实现仍会继续提交后续条目，并在重启时看到全部三条。它说明 rejected 不意味着没有持久化；这是端口层注入，不冒充真实断电或文件系统故障测试。已有 pending 安装中断和跨进程恢复用例由回归套件覆盖。

在 work 失败后提交前缀、跳过坏项并重建余下工作副本，或在提交失败后逐条重试，都会增加错误分类与恢复分支。尤其 pending 已发布、目录 fsync 或 hydrate 失败时，不能猜测整个批次未提交。仅按顺序 resolve 各 promise 也不能隐藏已共同提交的后缀。保持原有逐条可见性和失败域，需要继续保留逐条持久边界，或增加与当前架构不符的证据视图/协议。

因此本次拒绝这个最小合批候选，不增加上述机制。结论只覆盖该原型，不声称所有事务内优化都不可能。生产路径、持久格式、授权、兼容范围、版本与 `release/` 均不改动；生产收益为零。

## 回归范围

新增 `test/domain-storage/observe-transaction-boundaries.test.mjs` 固化：坏邻居不吞有效观测、提交前/后拒绝的差异、跨重启保留、flush 与决策占位的前缀、关闭排空及重复身份。主基准每次运行必须重现被撤回原型的失败差异，不能以“最终没采用”悄悄删除反例。

既有 `autonomous-durable-observations`、`autonomous-decision-recovery`、`autonomous-continuity` 与领域 storage/archive-stage 用例覆盖并发阈值、不同模式、跨重启累计、不提前 Trial、pending 安装恢复。最终执行结果与原始性能数字记录在本目录的验证记录中。
