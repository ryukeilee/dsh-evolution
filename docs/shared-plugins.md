# 跨入口共享已验证的晋升插件

基线：本开发树（Evolution `0.2.3` 之后的开发候选）。`release/` 中的 0.2.3 固定产物不包含该能力。
本文只描述本树 `lib/promoted-sharing.js`、`lib/promoted-consumer.js`、`lib/orchestrator.js`、
`lib/diagnostics.js` 与 `scripts/shared-plugins.mjs` 的实际行为；没有实际执行过的验证不写成已验证。

## 1. 架构

- **一个晋升权威：Desktop。** Trial、measure、promotion、canary、rollback 与 restart recovery 仍只由
  Desktop 的 Evolution kernel 拥有。`lib/promoted-sharing.js` 本身不判断 stable，只从 kernel 已经提交的
  durable stable 事实（promotion evidence sidecar、promoted composition 记录与 `promoted/` 中的插件源码）
  构造发布记录。
- **一个发布索引。** 所有入口通过同一个 `$DSH_HOME` 看到
  `$DSH_HOME/storages/evolution/shared-plugins/published.json`。插件源码不复制，仍引用
  `$DSH_HOME/storages/evolution/promoted/dsh-evolution-promoted-<12 位十六进制>/`；发布与每次激活前都会
  按记录里的摘要重新哈希该源码。
- **各入口独立消费。** bundle entry `dsh-evolution/promoted-consumer`（`lib/promoted-consumer.js`，
  由 `scripts/setup-experience.mjs` 的托管块在 `acp` / `web` 启用、在 `desktop` 禁用）在
  `acp` 与 `web` 启动时读取索引，逐条做兼容性判定，只把 eligible 的记录通过官方 Cordis Include 生命周期
  挂载进该 profile 自己的 composition `shared-plugins/consumers/<profile>.cordis.yml`，并把本次启动结果
  写入 `shared-plugins/consumers/<profile>.json`。它不运行 Evolution kernel（无 orchestrator、无
  Trial/Canary 状态机、无领域存储、无工具注册、无模型调用），也不写发布索引、晋升 journal、canary 状态、
  Desktop composition 或领域存储。
- **数据布局**：发布索引 `published.json`、逐 profile 撤销表 `disabled.json`、消费状态
  `consumers/<profile>.json`、消费 composition `consumers/<profile>.cordis.yml` 与发布锁 `.publish.lock`
  都在 `$DSH_HOME/storages/evolution/shared-plugins/` 下；插件源码与 Desktop 的 `promoted/` 是同一份。
- **没有后台同步。** consumer 只在启动时读索引，没有定时器、watcher 或轮询。发布发生在 consumer 已经
  启动之后时，需要重启该入口才生效（部署形态保持宿主 HMR 关闭，见 `README.md`）。

## 2. 发布记录与保证

记录 schemaVersion 为 `1`，字段与保证：

| 字段 | 含义与保证 |
| --- | --- |
| `id` / `pluginName` | `evolution-promoted-<12 位十六进制>`；插件目录名固定为 `dsh-<id>`，两者必须互相吻合 |
| `experimentId` | 产生该 stable 事实的实验身份，`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `moduleUrl` / `entry` | 被引用的源码位置；只允许 `promoted/<pluginName>/lib/index.js`，任何符号链接、越界路径或 URL 不匹配都被拒绝 |
| `sourceSha256` / `manifestSha256` | 发布时对源码与 `package.json` 的摘要；激活前重新计算，不一致即 `skipped-invalid` |
| `publisherProfile` | 发布者入口（当前为 `desktop`）；带 kernel 的同名入口不会再挂载自己发布的记录 |
| `approvedProfiles` | 所有者的显式跨入口批准，非空且只含 `acp` / `web`；`confirmation: true` 不隐含该列表 |
| `stable` | 必须同时有 `committedAt`、`decision: "benefit"` 与满足窗口的 canary（`startupVerified: true`、`healthObservationWindow >= 1`、`observations >= healthObservationWindow`） |
| `requiredServices` / `serviceMembers` | 从插件模块命名空间读取的 `inject` 服务与 `requires.services` 成员声明（只 import 模块读声明，不执行 `apply`） |
| `requiredCapabilities` | consumer 必须在自己的 live context 上真实证明的官方能力：`fiberLifecycle`、`fiberAwait`、`include`；插件 inject `tools` 时才要求 `toolsRegistry` |
| `host` | 发布/上次验证时从官方 `pluginPackages.packageOf` 读取的精确宿主身份（DSH、Cordis、Include 版本与 Node 版本） |
| `revalidation` | 每次采用真实隔离宿主证据时追加的 revalidation 代（含证据摘要），发布身份与首次 `publishedAt` 不变 |
| `hostOnly: true` | consumer 只接受 Host-only 记录 |

只有 durable stable 事实能生成记录：缺少 stable commit 时间、未满足的 canary 窗口、非 `benefit` 决策、
canary 未通过启动验证，或没有任何显式批准，都会被拒绝。**历史 Desktop-only 晋升不会自动出现在索引里。**

## 3. 兼容性判定与状态

consumer 先做静态判定（不执行插件），再挂载并验证 live 行；顺序如下：

1. 记录结构 / schema / 摘要 / URL / Host-only 校验 → 不通过 `skipped-invalid`；
2. 本 profile 的 Evolution kernel 若启用，且记录由本 profile 发布 → `disabled`；
3. 该模块 URL 已被本 profile 的 loader 挂载（检查 `loader.entries()`，跳过 disabled 行）→ `disabled`
   （`already-mounted`，不会出现第二个实例）；
4. 操作者对这一 profile 的撤销 → `disabled`；
5. profile 不在 `approvedProfiles` → `skipped-unapproved`；
6. 源码不可用或摘要不匹配 → `skipped-invalid`；
7. 宿主身份不匹配 → `pending-revalidation`（不挂载）；
8. 缺少必需能力、服务或服务成员 → `skipped-incompatible`；
9. 上一次启动对同一源码摘要 + 同一宿主身份的失败是 sticky 的 → 保持 `failed`，直到操作者 `reset`。

通过后，consumer 只把 eligible 行写入自己的 composition 并 `refresh()`，再逐行验证：公开 resolver 能取到
该行、`entry.options.name` 等于记录中的模块 URL、行未被禁用、`Fiber.await()` 已 settle、Fiber 处于活动
状态、`inject` 的服务都绑定在该 entry 自己的 scope 里。任一行验证失败只把该行标为 `failed`，不影响其他行。

状态词表（consumer 启动时写入 `consumers/<profile>.json` 的 `plugins[].status`）：

| 状态 | 含义 |
| --- | --- |
| `active` | 本次启动已通过官方 Include 挂载并通过 live 行验证 |
| `disabled` | 由发布入口自身（kernel 已启用，reason `publisher-profile`）、已挂载重复实例（`already-mounted`）或操作者撤销（`operator-disabled`）而跳过 |
| `skipped-unapproved` | 该 profile 不在 `approvedProfiles` |
| `skipped-incompatible` | 缺少记录要求的能力 / 服务 / 服务成员 |
| `skipped-invalid` | 记录或源码摘要 / manifest 不合法（含索引里的非法记录） |
| `pending-revalidation` | 宿主身份（DSH 精确版本、Cordis/Include `major.minor`、Node major）不匹配；等操作者重验证 |
| `failed` | 评估、Include 不可用、refresh 或插件 `apply` 失败；同源码 + 同宿主的失败会 sticky，直到 `reset` |

`pending-restart` 不是启动时产生的状态：`reset` 会把目标行改写成 `pending-restart`（操作标记）以清除
sticky 失败并让下一次启动重试一次。诊断另有一个派生标记 `pendingRestart`（按 profile）：consumer 状态的
`observedIndexUpdatedAt` 与当前 `published.json` 的 `updatedAt` 不同，表示上次启动后索引已更新、需要重启
该入口才生效；它不是 consumer 状态文件里的字段。

索引本身缺失是正常的 Desktop-only 安装；索引不可读或格式错误时视为「没有任何记录被授权」，所有记录都不能
挂载（doctor 报 `blocked`）。单个记录非法不会丢弃其它合法记录。

## 4. 发布是原子且幂等的

- 索引与 consumer 状态都通过「同目录临时文件 + fsync + rename」原子替换，因此读者只会看到上一份完整文件或
  下一份完整文件，不会看到半写。
- 发布索引的 read-modify-write 在索引旁的 `.publish.lock` 跨进程独占锁下进行：锁文件以 `wx` 创建并记录
  token / pid / hostname；只在同主机且 pid 可证明已消失、或超过 10 s 陈旧窗口时通过 rename 回收（只会有一个
  回收者成功），无法解释的锁宁可直接等待也不删除；2.5 s 内拿不到锁以 `E_SHARED_PUBLISH_BUSY`（可重试）
  报告。写入后再回读索引确认该记录确实落盘，未落盘则重试（最多 3 次）。
- 同一 stable 事实重复发布是逐字节 no-op；已有记录若源码摘要冲突则拒绝（**不会**用不同字节静默
  替换已验证源码）；重发布保留发布身份与首次发布时间，只追加 revalidation 代（`revalidate` 采用新宿主
  证据时同时更新该记录的 host 身份）。
- 发布失败只是诊断：晋升本身已经 durable，失败不会撤销晋升，也不会让 canary 结果看起来失败。下一次启动的
  reconciliation 会从同一份 durable stable 证据重试。
- **崩溃 reconciliation**：kernel 启动时（在恢复中断的晋升事务、挂载 promoted Include 之后）调用
  `reconcileSharedPromotions()`（`lib/orchestrator.js`）扫描
  `archive/experiments/<experimentId>.evidence.json`，只采纳同时具备 `stableCommittedAt`、
  committed `durable` 身份与非空 `shareTargets` 的快照，为索引中缺失的记录补发布。它从不重新打开 canary、
  不推断批准、不删除记录；重复执行是幂等的。覆盖的崩溃窗口包括 stable journal 阶段写出后、journal 清理前，
  以及 stable 提交与索引写入之间。

## 5. 操作流程

操作命令是 `dsh-evolution-shared`（即 `scripts/shared-plugins.mjs`）。子命令如下：

```sh
# 只读报告：索引、每条记录的源码摘要状态、撤销表与各 consumer 上次启动结果
dsh-evolution-shared list [--home <DSH_HOME>] [--data-root <dir>] [--json]

# 撤销 / 恢复某一 profile 的激活资格（只改变该 profile 的资格；Desktop stable 晋升不受影响）
dsh-evolution-shared disable --plugin <evolution-promoted-...> --profile acp|web [--reason <text>]
dsh-evolution-shared enable  --plugin <evolution-promoted-...> --profile acp|web

# 清除某条记录的 sticky 失败，让下一次启动重试一次
dsh-evolution-shared reset --plugin <evolution-promoted-...> --profile acp|web

# 采用真实隔离宿主验证证据，追加 revalidation 代并采用该宿主身份（用于 DSH 升级后）
dsh-evolution-shared revalidate --evidence <evidence.json>
```

`revalidate` 的证据格式为：

```json
{
  "schemaVersion": 1,
  "kind": "dsh-evolution-cross-entry-evidence",
  "host": { "dsh": "...", "cordis": "...", "include": "...", "node": "..." },
  "plugins": [
    { "id": "evolution-promoted-...", "sourceSha256": "<64 hex>", "profiles": { "acp": { "active": true }, "web": { "active": true } } }
  ]
}
```

它要求证据里的插件 id 是已发布记录、源码摘要与索引一致、至少有一个 consumer profile 被证明
`active: true`；证据文件的 SHA256 会写入新 revalidation 代。任何条件不满足即拒绝，不会只凭证据里的版本号
放宽兼容性。命令**不会**晋升、回滚或删除记录、journal、canary 状态或经验数据。退出码：`0` 成功，
`1` 拒绝 / 参数错误，`2` 状态不可读。

## 6. 升级与重验证策略

- DSH 版本按**精确版本**比较；Cordis 与官方 Include 只要求 `major.minor` 相同（patch 按 semver 兼容，
  但记录的能力仍必须在 live context 上逐项证明）；Node 只比较 major。
- 任何不匹配都会让记录停在 `pending-revalidation`：不挂载、不删除、不改写插件源码，其它记录不受影响。
  operator 在真实隔离宿主上重跑对应入口的验证后，用 `revalidate` 追加一代新证据。
- 源码摘要与记录不一致（插件被编辑、移动或篡改）是 `skipped-invalid`：consumer 拒绝该行，其它记录照常。
  doctor 的 `promotion.sharing` 检查对这种情况报 `blocked`，建议重新晋升或人工移除该记录；它不提供 repair，
  也不会自动删除任何文件。
- 没有自动删除路径：索引、撤销表、consumer 状态与 `promoted/` 源码都由操作者处置。

## 7. 诊断

`dsh-evolution-doctor` 与会话内 `evolution_doctor` 共用同一个只读检查 `promotion.sharing`：

- 索引缺失 → `ok`（全部 Desktop-only）；
- 所有记录源码摘要匹配且 consumer 无失败、无派生的 `pendingRestart` → `ok`；
- 存在兼容性问题、失败激活或需要重启 → `degraded`；
- 索引不可读 / 格式错误，或某条记录与其源码摘要不一致 → `blocked`。

检查只报告，不激活、不撤销、不修复。

## 8. 明确的非目标

- **不做跨机器同步。** 只支持同一台机器、同一 OS 用户、同一本地文件系统与同一个 `DSH_HOME`。
- **不是插件市场。** 没有远端 registry、下载、发布或版本解析；共享的只有本机 Desktop 已 stable 的晋升。
- **不是第二个晋升 / canary 引擎。** consumer 不决定 stable、不重试失败插件、不写 journal / canary /
  领域存储，也不提供第二套 registry、生命周期管理器或调度器。
- **没有后台同步或轮询。** 新发布在入口下次启动时生效；没有定时器或后台任务。
- **不是安全沙箱。** 记录校验与摘要只保证字节与批准范围；被晋升的插件代码仍来自 Desktop 的合作式
  `Function(hostCode)()` 晋升路径，需要可信审批。

## 9. 验收

隔离真实宿主验收记录在 `docs/evidence/cross-entry-0.2.2-rc.1.json`：官方 `0.2.2-rc.1` runtime、
隔离 `$DSH_HOME`、HMR 关闭，31/31 步通过，最终 live doctor `healthy`。该运行证明：

- 晋升发布路径：`confirmation: true` 但不带 `targetProfiles` 时没有发布；带 `['acp','web']` 的晋升在 canary
  窗口完成前不发布，stable 提交后索引里恰好出现带 stable 证明、批准范围与源码摘要的记录；Desktop-only
  对照晋升从不进入索引。
- Web consumer（kernel 关闭，`evolution_*` 工具数为 0）：合格记录 `active`，marker 监听器每次启动恰好执行
  一次；第二次启动仍只有一次挂载且 `activatedAt` 前移；完整 kernel 同时启用的入口里 consumer 对这些记录报
  `disabled`（`publisher-profile`），marker 仍只执行一次；缺少必需服务的记录 `skipped-incompatible`；
  源码被篡改后 `skipped-invalid`（`source-digest-mismatch`），恢复源码后重新 `active`；逐 profile 撤销后
  `disabled`（`operator-disabled`），`enable` 后恢复 `active`；模拟宿主升级后 `pending-revalidation`，
  恢复索引后 `active`。
- 真实 ACP consumer：安装到 acp profile 后同样在没有 Evolution kernel 的情况下挂载并执行一次。
- 数据保留：`promoted/` 源码、archive sidecar、共享经验库与 `evolution-memory.json` 在流程后仍在且摘要不变。

边界：该验收环境没有 Desktop 二进制，因此由带完整 kernel 的 Web profile 充当 publisher
（证据记录 `publisherProfile: "web"`）；生产安装形态仍只在 Desktop 运行完整 kernel。它不是 Desktop UI /
Desktop 布局验收，也不覆盖真实的 Desktop Electron 入口。`scripts/acceptance/run-cross-entry.mjs` 另提供
在本机用真实 Desktop 二进制执行的三入口流程，其证据文件只在该流程真实通过后才会作为验收记录引用。
