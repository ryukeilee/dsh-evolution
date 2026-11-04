# 自主观测跨重启累计：官方存储对照

2026-11-03，Node v26.13.0。基线为 main `9d91dc9`，候选为本分支。PR #18 的耗时归一化没有复制到此变更。

复现命令：

```sh
node --max-old-space-size=4096 --expose-gc scripts/benchmarks/autonomous-restart.mjs docs/performance/autonomous-restart/raw.json
node --max-old-space-size=4096 --test test/autonomous-durable-observations.test.mjs
```

脚本使用注册的 `agent/error` listener，真实官方 `DomainFacility`、`JsonStorageBackend`，临时数据根；每次重新构造存储 handle 和 orchestrator。每组两次观测后关闭，重开后追加一次，阈值为 3。四组交替 A/B，原始数据见 `raw.json`。这不是启动真实宿主进程或真实模型调用的耗时基准。

| 指标 | main | 候选 |
| --- | --- | --- |
| 重启后第三次同一故障 | 4/4 仍只认 1 次 | 4/4 累计 3 次 |
| 中风险确认候选 | 0/4 | 4/4 |
| 官方 aggregate 提交次数/组 | 3 | 3 |
| 临时根最终字节/组 | 10,709 | 10,648 |
| 三次观测及两次开关中位时间 | 52.85 ms | 49.60 ms |
| GC 后堆差中位数 | 250,756 B | 242,764 B |

收益是恢复正确识别和候选触发。四组轻负载不足以声称速度或内存优化，GC 后差值也不是峰值 RSS。低风险 Trial 额外有一次持久决策占位提交；已证实回滚或无运行对象的环境失败会释放占位并额外提交。没有新增轮询、计时器或模型请求。

根因链：自主窗口仅在进程 Map；adapter 丢弃真实故障摘要和目标；知识聚合的源样本不是发生次数。候选写入版本化精确 pattern identity，并明确保留发生样本，提交后才读取最近 200 个观测中的精确身份。旧记录没有该版本身份则跳过，不从泛化文本推断。故障身份使用已有摘要，缺少摘要的直接调用从原始错误生成摘要；工具失败增加结果摘要，以免同工具同 code 的不同错误合并。耗时变化是否同类仍由 PR #18 独立处理。

证据窗口限于最近 200 个观测；更久的发生不保证用于当前阈值。低风险决策按模式和策略声明指纹持久占位，沿用 200 项上限。中断后的占位只阻止重复 Trial，返回需所有者处理，不重建旧 plugin/owner/基线，也不提供晋升证据；此变更没有添加重启后继续操作旧 Trial 的协议。原有确认、风险、回滚、失败学习门禁仍是权威。

回归覆盖：相同故障与不同根因、并发阈值、等待确认、重启去重、旧记录、同 ID 重放、提交前故障、占位中断恢复及策略身份隔离。真实宿主完整安装/生命周期验收记录位于 `docs/evidence/autonomous-restart-*.json`，只有报告实际生成并通过时才算验证通过。

## 最终验证

实现提交 `abd1976`：带 4096 MiB 堆上限的全量测试 1353/1353，通过；`npm run pack:check` 16 项通过（开发后继语义，不是发布固定点）。独立审核两轮通过，记录见 `review.md`。

最终本地产物 SHA-256 为 `f5f069fd956920e5e4ba7ad7fb71a94dc9d21b3f0b5a6c37970424f0d05fde22`，内容摘要为 `1f295ac874e8b6dd67c33512a1fd25304b80fa62dc9abfcd844aee514c51bdcf`。三宿主 `0.2.0-rc.2 / 0.2.1-alpha.1 / 0.2.1-rc.2` 的最终验收均通过，每宿主 21 个步骤，使用隔离 runtime/home。

其中 alpha 在同时运行全量测试与三宿主验收时曾失败于既有 `lifecycle-disable` 探针：宿主回执 `restart-required` 与读取到的即时 live 状态不一致。原始失败记录保存在 `docs/evidence/autonomous-restart-0.2.1-alpha.1-failed.json`；其他负载结束后，在代码、产物和探针不变的情况下单独重试通过。

该不一致的根因已单独确认：宿主 `pluginManager` 把“实时应用能力”（`ctx.get('hmr')`）读两次——一次写进回执，一次在 profile 写入之后决定是否实时生效——而 `hmr` 在启动期是异步出现的，所以跨过这个转变的一次调用会报 `restart-required` 并照样实时生效。失败与通过的记录只是同一次启动竞态的两种落点，插件生产代码没有参与该判定，本轮也未改动。复现、证据与验收断言的修正见 `docs/evidence/lifecycle-live-apply-race.md`。

`verify-artifact --content-only` 与已固定的旧发布包比较会拒绝内容不一致，这与本次改变分发源码一致；没有更新 `release/`，没有发布新版本。

## 追加：耗时身份整合（PR #18 + 本 PR）

2026-11-03 追加。上面的持久窗口让同一故障跨重启累计，但模式身份里的 digest 仍是原始文本的摘要，
所以同一故障的 `after 100 ms` 与 `after 200 ms` 是两条模式：各自从 1 开始，到不了 `patternThreshold`。
这次把只归一化带标签耗时（`after N ms`）的 `errorPatternDigest` 接进模式身份，持久窗口因此对耗时
变化也有效。改动只在模式身份的 digest 成分与失败记忆的问题成分：消息成分保持原来的「数字折叠成
`#`」，这样不含 `after N ms` 的故障身份逐字不变（旧的持久观测与旧的失败记忆继续有效）。

差分验证（同一台机器、同一套测试文件）：

| 代码 | `test/autonomous-durable-observations.test.mjs` |
| --- | --- |
| 整合前 main（`35e737f`） | 15 项中 5 项失败：跨重启累计、根因隔离、`measured` 候选不重跑、失败抑制跨重启、并发变体 |
| 本分支 | 15 项全部通过 |

另有 1 项身份兼容用例（不带 `after N ms` 的旧身份继续计数）在“把消息成分也归一化”的中间实现上失败，
在最终实现上通过：那个中间实现会让带其它数字的故障身份漂移，属于不必要的兼容损失。

复现命令：

```sh
git worktree add /tmp/dsh-main-proof 35e737f
ln -s "$PWD/node_modules" /tmp/dsh-main-proof/node_modules
cp test/autonomous-durable-observations.test.mjs /tmp/dsh-main-proof/test/
(cd /tmp/dsh-main-proof && node --max-old-space-size=4096 --test test/autonomous-durable-observations.test.mjs)
node --max-old-space-size=4096 --test test/autonomous-durable-observations.test.mjs
```

边界：含 `after N ms` 的旧记录携带带耗时的旧身份，无法从新身份重建，因此升级后不参与计数（该模式从 1
重新累计），不做猜测性合并；旧失败记忆条目另按可重建的旧身份做一次只读精确匹配，不重写。只识别
`after <整数> ms` 这一种标签且区分大小写，其它耗时写法不归一化（保守方向：不合并而不是错合并）。

### 本轮的最终验证

实现提交 `b18ff05` + `b1d71b2`（文档 `9d1666d`）：带 4096 MiB 堆上限的全量测试 1366/1366 通过；
`npm run pack:check` 16 项通过（开发后继语义，不是发布固定点）。独立审核 1 轮通过（GPT-6.1 Sol，
Xhigh，无 blocker / should）。

本地产物 `dist/elapsed-identity/dsh-evolution-0.2.0.tgz` 的 SHA-256 为
`4bc6e670e9eaaf9761f24b88a984db9b38c475f914c19f8f3e6a5abb8a0e62d8`，内容摘要为
`3f5d9f77131dfd740f1baa9050dee78d9244ce0ef1c57125504f0d094548e05b`（51 个条目）。三宿主
`0.2.0-rc.2 / 0.2.1-alpha.1 / 0.2.1-rc.2` 使用同一份产物、隔离 runtime/home 串行验收，各自 21 个步骤
全部通过，证据为 `docs/evidence/elapsed-identity-<host>.json`。串行执行（不在验收同时跑全量测试）
是为了避开上面记录过的 alpha `lifecycle-disable` 抖动；本轮三次验收首次即通过，没有复现该不一致，
但这不等于已定位它的根因。

没有更新 `release/` 固定点，也没有发布新版本。
