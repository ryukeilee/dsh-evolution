# 2026-10-24 生产质量检查

基线：远端与本地 main 均为 `ae88447`；实现提交：`aa5ec94`。不修改版本、发布固定点或官方 DSH 源码，不访问正式用户数据。原有未跟踪性能材料保留，不纳入提交。

## 保留的修复及依据

1. `registration.js`：工具抛错后 `finally` 中 flush 再失败会覆盖主错误。现在按原身份传播主错误，次级失败通过共享的 `warnRedacted` 脱敏诊断；工具成功时 flush 失败仍拒绝。同步日志错误、异步拒绝与异常 thenable 不改变工具结果。
2. `index.js`：prepareRuntime 的 undefine 失败会覆盖 run/stop 的主错误。现在保持主错误、仍执行 undefine；单独清理失败仍拒绝并清空 preparation 缓存。独立布尔标记覆盖 `throw undefined/null/false/0/''`，不以异常值真假判定成功。
3. `domain-storage.js`：初始化失败后 close 再失败会覆盖初始化错误。现在保留初始化错误并脱敏报告清理失败；只有确认 close 成功才释放锁。close 失败保留锁，因为官方 facility 仍占用域，无法证明介质停止写入。锁释放自身失败也不覆盖初始化错误。

`index.js` 初始化失败清理经真实 Cordis/官方存储验证已由官方卸载负责，本轮只补回归，不添加第二套生命周期。领域存储 disposer 的关闭顺序不变。

## 可复现验证

```sh
node --max-old-space-size=4096 --test test/entry-failure-diagnostics.test.mjs
node --max-old-space-size=4096 --test test/storage-transaction-init-lock.test.mjs
node --max-old-space-size=4096 --test test/domain-storage/domain-storage-write-path-equivalence.test.js
PATH=/opt/homebrew/opt/node@22/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 npm test
PATH=/opt/homebrew/opt/node@24/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 npm test
npm run pack:check
npm run release:verify
npm run release:pack
node scripts/release/verify-artifact.mjs dist/dsh-evolution-0.2.0-rc.17.tgz --content-only --tree
```

入口 10 项、存储初始化/锁 11 项均通过；修复前入口反例 4 项失败、旧假值实现另有 2 项失败；旧存储实现反例 4 项失败。差分基线反转表仅同步工作树匹配文本，仍逐字节还原固定 rc.8 源码，差分测试 5/5 通过。

最终实现全量：Node **22.23.4：916/916**，Node **24.22.1：916/916**，均无跳过、无失败。打包开发检查通过；固定发布产物字节校验通过；本地重建包内容与当前树一致，`contentSha256=39467450944668a5e91b625e3668452a56517a508ba1bde585dce139bc563f50`。固定发布包与本地开发包有意不同，未执行发布固定点更新或 release gate。

独立复审发现并解决两项阻塞：假值异常误缓存成功、清理日志自身失败覆盖主错误。最终针对性复审无剩余阻塞，实测聚焦 19/19、额外日志边界反例 12/12、固定基线重建 1/1，`git diff --check` 通过。

## 检查范围与收益边界

另检查 orchestrator、promotion journal/恢复、Include adapter、archive staging、checkpoint、experience recall 的调用链与现有证据。没有证实的新问题不改动。未引入性能候选；历史已否定的摘要缓存和日志块尺寸优化未重启。本轮收益是失败原因不再丢失、清理失败可安全诊断，不声明性能提升。

大事件日志启动的内存占用仍随历史增长；本轮没有复现 OOM 或给出可证明等价的有收益优化。关闭拒绝后仍需进程退出，再由 dead-owner 回收锁；不承诺同进程自愈。disposer 同时遇到既有队列失败和 close 失败时仍以 close 失败返回；checkpoint 告警路径仍保留原有传播语义。这些边界不属于本轮成功路径或性能等价承诺。

宿主最终证据记录于同目录 `quality-20261024-dsh-*.json`：`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-rc.2` 均 `ok: true`，各 21 步通过，三个证据的内容摘要均与上述当前树摘要相同。使用 Node 24.22.1、4096 MiB 堆上限及脚本新建的隔离 runtime/home，覆盖安装、工具流、启停、卸载重装、升级回滚、晋升重启回滚与最终 doctor。补修前候选结果已作废。
