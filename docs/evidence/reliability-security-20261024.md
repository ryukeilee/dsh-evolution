# 2026-10-24 可靠性与依赖安全收口

本轮基于 `ac84e8b8f933d175f145987b9ec2383a8a09c92a`，不升级插件版本、不更新 `release/` 固定点。19 项既有未跟踪性能材料不纳入提交，交付前逐文件核对 SHA-256。

## 已读取的远端基线

- [CI 40048818467](https://github.com/ryukeilee/dsh-evolution/actions/runs/40048818467)：Node 22.19.0 单测失败，Node 24、package 和三个官方宿主验收成功。
- [CodeQL 40048818463](https://github.com/ryukeilee/dsh-evolution/actions/runs/40048818463)：成功；GitHub code-scanning API 返回历史告警 1、2 均为 `fixed`。

以上只描述原基线，不代替本轮候选验证。

## inode 失败根因与修复

失败比较得到 `expected: 9243584 / actual: 9243584`。测试在记录原索引 inode 后自行 rename 替换该文件，释放了原 inode；真实修复再次写入时可重用该编号。因此不同文件的非同时存活 inode 相等不能证明没有重写。

身份 helper 现在用硬链接保留被记录文件，直到下一次快照或测试目录清理；原有 inode、字节与内容断言均保留。新增确定性回归断言快照持有 inode（`nlink === 2`）、替换后身份不同、重新快照采纳新文件。它同时阻止“实际重写但 inode 重用”导致不必要写入测试假通过。

实现者实测：Node 22.23.4、24.22.1 各自该文件 8/8；Node 22 三个相关索引测试文件 22/22。300 轮真实存储探针中缺失 collection 修复均完成；该探针在本机未重现 CI 的 inode 重用，不把此探针说成 Linux 分配器复现。

## 中间候选验证（非最终验收）

- 工作区 Node 22 首轮全量 895/896，唯一失败为 `release-pin.test.mjs` 正确拒绝尚未提交的分发文件；无跳过。
- 临时独立 clone 的候选提交 `910f14e9ee9b94d021c7ae0650963befd226e758` 在 `npm ci --ignore-scripts` 后，Node 22.23.4 与 Node 24.22.1 全量各 896/896；`pack:check` 通过。所有全量均设 `NODE_OPTIONS=--max-old-space-size=4096`。
- 三个官方宿主在新建隔离 runtime/home 下各 21 步通过，使用 Node 22.23.4；中间候选内容摘要 `0b02a9f0b5ab2ed1c1e4ed19f4f6d0a6e1c433684cda4e96c030aae0655511e9`。随后发现新的 staging 问题，最终候选需要重新验收。
- 固定 rc.17 的 `release:verify` 与 `release/SHA256SUMS` 校验通过：发布字节摘要 `d0c119f0522122619440265f80234cc27987458cb5537fb9022b627ab0c4aa90`，内容摘要 `fb4e77b5593aa7111cc5bb164dd5581cce32d5d5c89bc7b41818c5380cf06f30`，51 条目、权限 `0o644/0o755`。

## staging 故障修复

实现者在临时数据上确定性复现：旧 doctor 在检查后夹入写入者时删除 pending 引用的 stage；aggregate 无法解析或锁路径是协议外目录项时也会清理。现在清理复用领域存储的同一 archive 锁协议，锁内重新读取 aggregate、pending 与 staging，无法判明状态时不删除，取锁失败时跳过。回收陈旧锁仍使用原协议与身份检查。

导入器旧实现在尝试取得已被占用的迁移锁之前建立了完整副本；现在取得锁后才开始暂存，冲突保留外来锁且不产生本次暂存副本。已有“校验失败保留 staging”语义不变，不清理历史未知迁移锁。

实现者聚焦验证：Node 22.23.4、24.22.1 的 diagnostics、import 与 write-path-equivalence 三文件各 66/66。差分基线只增加新 helper 的反向还原规则，保持历史基线字节校验。

## 第二轮候选执行结果（独立审核后仍有阻塞）

临时独立 clone 提交 `53c9c4416d2df7f73c12bc057d316fb3a1ae42c6`，再次从最终锁文件 `npm ci --ignore-scripts` 后：

- Node 22.23.4：898/898，0 失败、0 跳过。
- Node 24.22.1：898/898，0 失败、0 跳过。
- 全量均使用 4096 MiB V8 堆上限；没有使用临时下载的 Node 发行版。
- `pack:check` 通过，明确判定为固定点的开发后继。
- 候选重新打包两次字节相同：`5cb9dc7990014eed57447f51376a41b5e0fb412e6af675ca13bb523c13c210b7`；内容摘要 `7f6204879c103cce9d118ee55229443c716dedf8498a7e84e83d82e41144508e`。`release:verify --content-only --tree` 通过，51 条目、权限 `0o644/0o755`。
- 三个官方宿主各 21 步成功，并逐一核对内容摘要与该轮候选相同。后续修复改变内容，因此下文交付的同名宿主证据已由最终候选重新执行覆盖。CLI doctor 有 `degraded` 及未执行实时诊断项，不据此声称所有实时检查通过。

依赖依据与风险见 [依赖安全证据](dependency-security-20261024.md)。独立依赖审核核对了版本、Node 范围与官方 integrity；其三项安全覆盖/固定点文档修正已纳入。inode 独立审核无阻塞。

第二轮候选的 staging 独立审核仍发现三个确定性反例，不能凭以上通过结果交付：有效 JSON 但结构无效的 aggregate 被当成无 pending；importer 的 finally 删除被替换锁；锁外幂等检查过时后重复创建导入副本。三项均交回实现修复；以上通过数字不代表这些遗漏已解决。

## 三项审核反例修复与候选复测

- doctor 的 offer 与执行共用完整聚合校验（unit/version、global schema、applied MAC 与运行时 schema）；校验器不可用或抛错同样拒绝清理。锁内重新校验后才处理 orphan staging。
- 导入释放迁移锁时核对本次打开文件的 dev/ino，句柄保持打开；路径已被替换时保留替代锁。成功导入遇替换锁明确报错，原失败路径保留原始错误。
- 取得迁移锁后、创建 stage 之前再次检查完成态；重叠导入的后到者返回 `already-imported`，不生成重复副本。三个反例均已固化，修复前确定性失败、修复后通过。
- 实现者 Node 22/24 聚焦各 77/77；临时 clone 候选 `246d71c803816ae30fc8dff714f90f1f8e129532` 的 Node 22.23.4 / 24.22.1 全量各 **901/901**，0 失败、0 跳过，堆上限 4096 MiB。沿用第二轮 `npm ci` 安装的同一最终锁文件，依赖未再变更。
- 候选 `pack:check` 通过；打包两次字节相同：`ebc721171ca69f142249c5e36a38fec4628788f4004ecf57ab439b9e61718575`；内容摘要 `c2bd3a593a9dd1a6c5382440aba842a39e8ae5d743c67c506c42f6e18c26b9f9`。候选 `release:verify --content-only --tree` 通过，51 条目，权限 `0o644/0o755`。
- 三个官方宿主重新在隔离 runtime/home 下各 21 步通过，证据内容摘要逐一匹配本轮候选：[0.2.0-rc.2](security-closure-20261024-dsh-0.2.0-rc.2.json)、[0.2.1-alpha.1](security-closure-20261024-dsh-0.2.1-alpha.1.json)、[0.2.1-rc.2](security-closure-20261024-dsh-0.2.1-rc.2.json)。

针对性独立复审确认三个阻塞均关闭、无新阻塞。复审另以无宿主、无 `node_modules` 的临时副本运行 doctor：正常输出 JSON，预期 `degraded` 退出；validator 不可用时 `aggregateVerified: false`，不提供 staging 清理且保留 stage。未重复全量或宿主验收。

## 保留边界

- 多文件 rename 不构成跨文件原子事务；混合集拒绝自动接受并保留人工检查现场。
- 未知迁移锁不自动删除；锁协议与末端目录检查不提供对抗本地进程的安全沙箱，也不是介质级 CAS。
- 仓库根 override 修复仓库 npm/CI 单测依赖图；三个官方宿主仍声明 client `2.0.0 / 2.0.0 / 2.2.0`，均低于修复版 `2.3.0`。隔离宿主功能验收成功不代表宿主依赖漏洞已消除；需上游更新。
- Zod 4.6.6 提前执行已声明的容器上限检查，不替无上限数组新增容量边界；本轮不声称任意磁盘输入都具备资源耗尽防护。
