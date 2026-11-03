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

其中 alpha 在同时运行全量测试与三宿主验收时曾失败于既有 `lifecycle-disable` 探针：宿主回执 `restart-required` 与读取到的即时 live 状态不一致。原始失败记录保存在 `docs/evidence/autonomous-restart-0.2.1-alpha.1-failed.json`；其他负载结束后，在代码、产物和探针不变的情况下单独重试通过。未确定该不一致的根因，不能把单次重试通过解释为已修复此宿主生命周期问题。

`verify-artifact --content-only` 与已固定的旧发布包比较会拒绝内容不一致，这与本次改变分发源码一致；没有更新 `release/`，没有发布新版本。
