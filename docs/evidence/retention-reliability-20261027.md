# 历史容量回收可靠性收口（2026-10-27）

实现提交：`ebd6c06b625e409cb923236c84556e36e3f127cc`，基线：`758b04dedaead773b4a19480183b56fcbc007dd5`。
未修改版本、`release/` 固定产物、官方宿主源码或既有未跟踪证据。

## 修复与可观察反例

- 新一轮日志回收先完成上一轮已提交截断，再检查保留尾部。不能获取 append lock 时返回
  `E_DOMAIN_EVENT_LOG_BUSY`，不提交新 floor；dry run 只读返回 `pending-truncation`。
- `test/retention-log-floor.test.mjs` 的 leading-blank 回归在修改生产代码前执行失败：原实现返回
  `would-discard`，而非 `pending-truncation`。修复后同一测试通过，并继续断言锁竞争时 floor/日志不变、
  解锁后二次回收不推进 floor、不回流 marker、flush 只报告两个保留重复项。
- 另一回归证明：在已回收日志前插入空行后，dry run 与确认回收都拒绝 floor 不匹配，领域文档和故障字节不变。
- doctor 新增 `state.retention-floor`；与截断恢复共享只读 descriptor 分类，分块验证保留前缀、
  或原文件前缀及其中保留后缀的 keyed 摘要。合法 deferred（含后续追加）为 degraded，正常为 ok，
  缺失/空/变更/自相矛盾摘要为 blocked；不提供 repair。
- doctor 报告 seal 临时残件为 degraded，不删除、不推断丢失；既有事件桥检查继续负责 JSON、MAC、
  writer 与同身份冲突。未新增第二套重放协议。
- 独立首轮审核复现 doctor 忽略 `pending.retention`。已按运行时的
  `pending.retention ?? global.retention` 优先级修复，新增 pending 的正常、deferred、空、损坏、缺失日志回归。

## 本次实际验证

所有全量及子进程测试保留 `--max-old-space-size=4096`。Node 使用已安装的 Homebrew 版本，
不是临时下载发行版。结构化摘要见同名 JSON；宿主证据为 `retention-reliability-dsh-*.json`。

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 npm test
# v22.23.4: 1163/1163, 0 fail, 75498.845708 ms
PATH=/opt/homebrew/opt/node@24/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 npm test
# v24.22.1: 1163/1163, 0 fail, 74360.037334 ms
npm run pack:check
# all package checks passed; development successor of pinned release
npm run release:verify
# unchanged pinned artifact bytes/content/entries/modes passed
```

首轮全量各有 8 个失败：新增诊断字段尚未在历史差分测试中命名、源码重建反向替换尚未覆盖新改动，
以及分发改动未提交触发既有 release-pin 拒绝。补齐反向替换与新增字段断言、保留固定产物字节锚点，
提交后才得到上面的最终全量结果；没有放宽固定点门禁。

本地 `release:pack` 只写 `dist/`，三宿主安装同一内容摘要
`716d7122d0b7f1cfdaf87a04a4623ff7ab45235faf932704a220b89bb53cfbd2`，tarball 字节摘要
`04c47cf75917ce5808096e5df0e83402c577a4a1481b343c9b346506bc291206`。

```sh
# 三次均 PATH=/opt/homebrew/opt/node@22/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096
npm run acceptance:host -- --host 0.2.0-rc.2 --out docs/evidence/retention-reliability-dsh-0.2.0-rc.2.json
npm run acceptance:host -- --host 0.2.1-alpha.1 --out docs/evidence/retention-reliability-dsh-0.2.1-alpha.1.json
npm run acceptance:host -- --host 0.2.1-rc.2 --out docs/evidence/retention-reliability-dsh-0.2.1-rc.2.json
# 每个宿主 21/21 步通过，临时 runtime/home，包含安装/卸载/重装/升级/回滚/晋升重启回滚。
```

子进程并发、规划期间追加、活锁竞争与 SIGKILL 跨进程恢复、重复回收、24 个 promotion/knowledge
身份及约 4 MiB 历史段的具体断言和规模边界见 `retention-process-boundaries-20261027.md`。
这些测试也包含在上述两版最终全量结果中。

## 保留边界

回收仍要求显式确认，没有后台调用者；回收后仍不可降级到不认识 retention 的旧插件。
被裁 eventId 的冲突检测边界保持不变，不声称拥有无限历史的去重记忆。
SIGKILL 验证覆盖进程崩溃，不等同物理掉电或所有介质故障；并发协议仍要求同数据根、hostname 与 PID namespace。
密集数据为 24 个身份，大段约 4 MiB，不宣称无限规模或性能收益。doctor 为只读观察，活跃写入期间的跨文件快照
不具备事务原子性；不通过重写原始证据掩盖不一致。
