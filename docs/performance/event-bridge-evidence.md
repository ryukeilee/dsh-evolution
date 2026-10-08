# readEventBridgeEvidence 分块恢复

基线为第四轮已提交版本 `9af8ffd`（前三轮整合基线 `8e6bd29`）。本轮仅修改
`lib/orchestrator.js` 的事件桥证据读取路径，并新增回归、冻结基线、基准及证据；
领域查询、运行时检查、签名和 doctor 四轮优化及其原测试、性能证据全部保留。
冻结函数 `test/fixtures/event-bridge-evidence.mjs` 已逐字节核对来自
`9af8ffd:lib/orchestrator.js`，使用同一未修改的认证实现和相同 `isObject` 判断。

## 行为与资源边界

普通路径的日志改为最多 1 MiB 的分块读取，通过 `StringDecoder` 保留跨块 UTF-8
解码规则，再按换行逐条处理。只保留当前块、未完成行、writer 最新序号及最终
证据，不生成全日志字符串、`split` 行数组和 `filter` 数组。超长单行通过片段
数组在行结束时合并，避免每块重新复制整条未完成行；空间仍受最大单行和输出
证据大小影响，不能承诺任意输入下常量内存。仍认证整个日志，没有按 experimentId
提前跳过 MAC 校验，也没有减少必须读取的总字节数或增加跨调用缓存。

每个 writer 的已认证、受信事件序号严格递增：`sequence <= prior` 已拒绝所有
重复及回退，因此移除逐事件增长的 `replayed` Set。writer 检查、序号推进、
experimentId 过滤顺序保持原样；其他实验的有效事件仍推进同一 writer 序号，
无效 MAC 和不受信 writer 不推进。measurement、promotion、gate、canary 及
latestAt 的覆盖规则与完整返回投影保留；未修改认证函数、接口或持久化格式。

文件大小在打开后重新获取，普通文件只读取该范围，保持原路径对并发追加的边界；
这不提供日志的事务快照，原地改写/截断本来也可能与读取并发。
`ENOENT` 仍返回 null，其他读取错误仍抛出；无效 key 仍完成读取后返回 null。
选项或验证错误延迟到读取完成后抛出，保留读取错误优先级；文件句柄总被关闭，
读取和关闭双重失败保留原聚合顺序、message、code 和错误成员。
特殊文件、FileHandle 及原 readFile 拒绝的大小沿用原读取路径；caller-owned
FileHandle 不关闭。保留本运行时全字符串长度上限，不把优化扩展为新功能。

## 可复现性能

```sh
rtk proxy node --expose-gc scripts/benchmarks/event-bridge-evidence.mjs
rtk proxy node --test test/event-bridge-evidence.test.mjs test/event-bridge-authentication.test.mjs test/cross-session-hydration.test.mjs test/full-cross-session.integration.test.mjs
rtk proxy npm test
```

环境 Node `v26.10.0` / `darwin/arm64`；全新临时合成日志，50,000 条 measurement
及一条 promotion，8 个受信 writer，payload 256 字节，日志 27,148,012 字节。
大多数记录属于其他实验，但全部执行真实 MAC 验证。先 deepEqual 完整恢复结果，
各路径预热两次，三轮交替先后顺序，每轮采样 5 次，计时前 GC。
CPU 与分配采样分开，磁盘页缓存为热缓存；没有包括日志生成、签名写入或宿主启动。

最终源码的三轮中位数之中位数（`event-bridge-evidence-final.json`）：
CPU 246.739 → 221.981 ms，减少 **10.03%**；
延迟 231.603 → 206.479 ms，减少 **10.85%**。
V8 HeapProfiler 采样分配 407,298,707 → 335,029,653 字节/次，减少 **17.74%**。
采样间隔 32768 字节，每轮每路径 3 次，包含 major/minor GC 已回收对象；
这是分配量估计，不是峰值堆。

独立新进程各执行三次恢复，排除日志构建、包含相同 runtime/imports；
三轮峰值 RSS 中位数 284,160 → 117,456 KiB，减少 **58.67%**。
这是整个进程的高水位，不是仅该函数的存活堆或每次调用增量。
最早候选和关闭错误修复后的独立进程复测分别保留于
`event-bridge-evidence.json`、`event-bridge-evidence-repeat.json`；它们均有收益，
但最终数字以上述 final 文件为准。小日志、冷 I/O 或输出证据很大的场景收益会不同。

## 回归、审查及双宿主

新增七项回归通过，覆盖完整输出、受信多 writer、跨实验序号推进、重复/乱序/
坏 MAC、不受信 writer、损坏 JSON、CRLF/空行/无换行尾行、超过多块的超长行、
UTF-8 跨块及非法字节、路径/Buffer/URL/FileHandle、缺失/目录/非法输入、
无效选项、读失败优先级、句柄释放、双重错误成员顺序、初始大小追加边界、
FIFO 单次 reader rendezvous 及下一轮改写可见性。
完整 `npm test`：205 项，203 通过，2 失败，0 skipped；四轮既有功能回归均通过。
两项失败仍为 `test/release-pin.test.mjs:54` 和 `:62` 的既有发布一致性要求。

首次专项差分发现目录错误原文差异，已通过保留原特殊文件读取路径修复。
独立只读审查发现特殊文件二次打开和双重读/关闭错误覆盖问题；Root 修复并新增
FIFO 及聚合错误回归，针对性复查确认两项阻塞消除。最终全套已经比较 `.errors`
成员的顺序和详情，不仅比较外层错误。未隐藏首次发现的问题或计作通过。

最终候选重复打包字节一致，50 条目、内容和文件模式检查通过。
`contentSha256: 8070c9f2594210679247a1c11be6008eb56c580de1a433294b100fcfbcdd1b02`；
`tarballSha256: fe40c2c6b6cae957746b6bc81c6bc88915cc75d919d40b1594d45316e419156d`。
官方 `0.2.0-rc.2` 和 `0.2.1-alpha.1` 各 21/21 步通过，均核对上述同一最终内容。
证据为 `event-bridge-evidence-host-rc2.json` 和 `event-bridge-evidence-host-alpha.json`。
覆盖实际诊断、核心工具、禁用启用、卸载重装与数据保留、升级回滚、跨重启晋升回滚。
修复特殊文件问题前的中间候选也通过双宿主，证据另存
`event-bridge-evidence-hosts-intermediate.json`，不用于最终候选验收结论。

```sh
rtk proxy env npm_config_cache=/tmp/dsh-bridge-evidence-npm-cache node scripts/release/pack.mjs --dist /tmp/dsh-bridge-evidence-final-dist
rtk proxy node scripts/acceptance/run-host-acceptance.mjs --host 0.2.0-rc.2 --runtime /tmp/dsh-evolution-rc3-accept-rc2/runtime --tarball /tmp/dsh-bridge-evidence-final-dist/dsh-evolution-0.2.0-rc.3.tgz --out /tmp/bridge-evidence-rc2.json
rtk proxy node scripts/acceptance/run-host-acceptance.mjs --host 0.2.1-alpha.1 --runtime /tmp/dsh-evolution-rc3-accept-alpha/runtime --tarball /tmp/dsh-bridge-evidence-final-dist/dsh-evolution-0.2.0-rc.3.tgz --out /tmp/bridge-evidence-alpha.json
```

复用之前准备的官方 runtime，所有 home 为新临时合成目录；未访问真实用户数据，
未修改官方 DSH、发布 pin、固定制品或旧发布证据，没有外部发布。
`pack:check` 仍只有基线已有的三类失败：旧发布验收证据、manifest pin、源码与
旧制品不一致。旧发布摘要仍为
`d4bec3181f4addad50f32dfee278478134891da15f66626f7c9caa2544957358`；其余包检查通过。
