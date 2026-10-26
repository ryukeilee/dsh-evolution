# Retention 关键边界补充验证（2026-10-27）

本任务仅新增 `test/retention-process-boundaries.test.mjs`、其子进程夹具
`test/retention-boundary-worker.mjs` 与本文；未修改生产 lib、既有测试、版本或 release，未提交。
执行时 HEAD 为 `758b04dedaead773b4a19480183b56fcbc007dd5`，Node 为
`v26.12.1`（`/opt/homebrew/bin/node`），darwin/arm64。共享工作树中其他任务同时修改了
`lib/diagnostics.js`、`lib/domain-storage.js`、`lib/event-log-checkpoint.js` 与
`test/retention-log-floor.test.mjs`；本结果针对执行时工作树，不是固定提交或发布产物验收。

## 选择与边界

先阅读 AGENTS.md、既有 retention-log-floor / retention-archive-deletion 测试，及
`docs/performance/capacity-reclaim-20261027.md`、`capacity-reclaim-evaluation.md`。
已有单进程 floor 补完、两轮累计回收、pending 删除重放不另行复制。
本次补充：

| 场景 | 有界规模与实际断言 |
| --- | --- |
| 两个真实并发追加进程 | 同时启动，每个 16 条；flush 吸收 32 条，回收 29 marker 后保留 3 条；连续三次无新增回收均不改变日志字节与 floor |
| 规划与提交之间追加 | externalizer 回调作为确定性交错点：回收读取 8 条旧日志后，等待两个子进程共追加 32 条再继续；只裁 6 个旧 marker，新 32 条全部保留并恰好吸收一次，最终 34 条日志与 marker |
| 活写者 append lock 与真实崩溃 | 子进程打开官方领域后端并持有 append lock，确认回收报告 deferred、日志未变；第二进程调用公开 append-lock API 被拒绝；父进程 SIGKILL 所有者，不调用 close，留下真实 dead-owner lock 与已提交 floor；追加一条新记录后，由全新进程打开后端完成截断，最后恰好保留 3 条；再次跨进程打开不重放、floor 不变 |
| promotion / knowledge 密集 | 24 个身份各写 rejection + promotion，共 48 条；确认 canonical knowledge 至少 24 条；回收 47 个 marker，验证全部 23 个已完全裁掉身份的 sidecar 中 runtimeRecovered 与插件身份；knowledge query 及热聚合中完整 canonical payload 前后相等 |
| 超大历史归档段 | 直接构造合法旧式 sealed 段，8 条记录各含 512 KiB 合成载荷，实际段至少 3 MiB；load、compact、重新 load 后归档索引有效且源 id 不复活。绕过正常写入的载荷压缩，只为覆盖历史大段读取/重写；总载荷约 4 MiB |

每个测试上限 30 秒，子进程消息上限 20 秒；并发追加遇锁最多 40 次、间隔 5 ms。
所有子进程明确使用 `--max-old-space-size=4096`。夹具只在 `os.tmpdir()` 新建目录，结束后清理；
没有读取正式 home、用户密钥、网络或发布文件。未跟踪文件保持原状。

## 本次实际结果

```sh
node --max-old-space-size=4096 --test \
  test/retention-process-boundaries.test.mjs \
  test/retention-log-floor.test.mjs \
  test/retention-archive-deletion.test.mjs
# 26 tests, 26 pass, 0 fail；20218.42825 ms

# 随后增加完整 canonical payload 相等断言，最终文件重新执行：
node --max-old-space-size=4096 --test test/retention-process-boundaries.test.mjs
# 5 tests, 5 pass, 0 fail；8841.480375 ms
```

首轮夹具有三处错误，已据实际合同修正：领域端口持有独占 archive lock，所以活进程追加锁的竞争
通过公开 append-lock API 检验；query 返回 `{ count, entries }` 而非数组；正常 load 写路径会压缩
大载荷，故大段测试改为直接构造历史 sealed 文件。这些失败不是生产缺陷。

本轮未发现新的真实缺陷。没有执行全量测试、宿主验收或性能 A/B，不声称性能收益。
崩溃只覆盖 floor 已提交、截断 deferred、进程被 SIGKILL 的窗口；不模拟物理掉电、任意字节 torn write、
所有 pending 安装中间点、跨 hostname/PID namespace 或无限规模。promotion/knowledge 的密集规模为
24 个身份，不代表真实部署分布。大段样本约 4 MiB，不代表任意大小归档均可安全处理。
