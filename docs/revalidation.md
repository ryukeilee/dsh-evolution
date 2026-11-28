# 宿主升级后的重验证

## 为什么需要它

发布索引里的每条 stable 记录都带着它**当时被真实验证过**的宿主身份
（`host.dsh` 精确匹配，Cordis / Include 匹配 `major.minor`，Node 匹配大版本）。
宿主升级（例如 `0.2.2-rc.2` → `0.2.2-rc.3`）后，ACP 与 Web 的消费入口会把记录分类为
`pending-revalidation` 并拒绝挂载——这是设计，不是 bug。

`dsh-evolution-shared revalidate --evidence <json>` 接受证据并追加一个
`revalidation` 世代，但**没有任何已发布脚本能为“已经处于 pending 的记录”产出这份证据**：
官方验收 runner（`run-cross-entry.mjs` / `run-host-acceptance.mjs --cross-entry`）都是
在全新隔离 home 里先发布自己的探针插件，再对那条新记录取证；它们不覆盖升级前就存在的记录。
结果是每次宿主升级都要人工构造证据，这既是自动化闭环缺口，也容易诱使操作者手写 JSON。

## 现在怎么做

### 1. 取证前快照与取证（不写正式发布索引）

每次取证使用新的、未占用的证据路径。示例路径如下；再次取证时必须同时更换证据、
快照与摘要文件名。启动 runner 前，先用既有只读命令保存撤销状态快照，并计算正式发布索引的 SHA-256：

```sh
node scripts/shared-plugins.mjs list --home ~/.dsh --json \
  > docs/evidence/revalidation-review.state-before.json
shasum -a 256 ~/.dsh/storages/evolution/shared-plugins/published.json \
  > docs/evidence/revalidation-review.index-before.sha256

node scripts/acceptance/run-revalidation.mjs --home ~/.dsh --out docs/evidence/revalidation-review.json
```

`state-before.json` 是 `shared-plugins/disabled.json` 的规范化快照：保留 `disableStatus`，
并按发布记录 ID 保存 `disabledProfiles`（即该记录在 ACP / Web 的撤销位）。`absent` 只表示
撤销表不存在；`invalid` / `unreadable` 不是“没有撤销”，必须停止。索引摘要绑定
`published.json` 的原始字节，不能用 `updatedAt` 代替。取证写出的证据里，
`source.indexDigestBefore` 必须等于这里的索引摘要。

### 2. 审阅证据并作出人工决定

把撤销状态快照、索引摘要与上一步写出的 `docs/evidence/revalidation-review.json`
作为同一组人工审阅对象，至少核对：

- 快照中的 `indexStatus` 为 `ok`、`disableStatus` 为 `ok` 或 `absent`，并逐记录核对 ID 与各 profile 撤销位；
- `source.indexDigestBefore` 与取证前保存的 `published.json` SHA-256 一致；
- `host` 是否为准备采纳到的当前宿主；
- `verification.targetIds` 与 `plugins[].id` 是否只包含本次决定采纳的记录；
- 每条 `plugins[]` 的 `sourceSha256`、`approvedProfiles` 和各 consumer profile 的验证结果。

用 `shasum -a 256 docs/evidence/revalidation-review.json` 记下证据摘要，之后不要编辑该文件。
再生成一份取证后的撤销状态快照与索引摘要，确认二者与取证前一致；若有变化，舍弃这份证据，
重新执行第 1 步并重新审阅。只有操作者审阅通过并明确决定采纳时，才进入下一步；不采纳就停在这里。
决定覆盖证据中 `plugins[]` 列出的全部记录；若目标范围超出本次批准，停止采纳。撤销或启用 profile
是独立的生产状态变更，必须另行明确决定，不得为了筛选证据而在此流程中提前执行，也不要手改证据。

### 3. 采纳前禁写窗口、重查与采纳已审阅的证据（写正式发布索引）

运行写入命令前，重新生成撤销状态快照与 `published.json` SHA-256。只比较快照中的
`indexStatus`、`disableStatus` 以及按记录 ID 归组的 `disabledProfiles`；`list` 中的 consumer
运行状态不属于撤销快照。逐项与第 1 步保存的值比较：

```sh
node scripts/shared-plugins.mjs list --home ~/.dsh --json \
  > docs/evidence/revalidation-review.state-before-adopt.json
shasum -a 256 ~/.dsh/storages/evolution/shared-plugins/published.json \
  > docs/evidence/revalidation-review.index-before-adopt.sha256
```

撤销状态或索引摘要任一不一致，立即中止，不调用采纳命令、不写入正式数据根；一致才继续。
同时重算证据 SHA-256 并与审阅时记下的值比对。

在最后一次比较完成前，操作者必须协调同一数据根的**人工禁写窗口**，并让它持续到
`revalidate` 命令返回：窗口内不得执行 `disable` / `enable` / `approve` / `supersede` /
`revoke-supersede` / 再次 `revalidate` / 重新发布等写入，也不得改动 promoted 源码；其他操作者、
进程或自动化也必须暂停对 `shared-plugins/` 的写入。撤销或启用只改 `disabled.json`，
`published.json` 的摘要可能保持不变，因此摘要一致不能证明窗口安全。索引发布锁只保护单次命令内部，
不会把上面的快照比较与撤销表状态变成一个跨命令原子事务，因此这道窗口是人工门禁，不能假定由 CLI 强制。
若无法确认窗口内没有其他写入者，或无法暂停相关写入，**不要运行采纳命令**；等待条件具备后重新
生成快照与摘要并重查，不能以“命令会加锁”为理由跳过。

全部一致且禁写窗口已确认后，直接把这个证据文件交给既有采纳命令，不重新运行验证 runner：

```sh
node scripts/shared-plugins.mjs revalidate --home ~/.dsh --evidence docs/evidence/revalidation-review.json
```

命令返回后立即重查撤销状态：它必须仍与已审阅快照一致。若发现或怀疑窗口内发生了撤销、启用、
索引写入、源码改动或证据替换，停止后续操作，不回滚、不补写，也不把该回执当作已审状态的采纳证明；
保留现场并报告不一致，按新状态重新取证、审阅和决定。

该命令只处理证据中 `plugins[]` 列出的记录，并在索引锁内重新校验发布字节、逐条核对记录的 `sourceSha256`。
它不会比较取证时的索引摘要或撤销状态，因此上面的快照、摘要与证据复核是采纳前必需的人工门禁。
采纳回执中的 `evidenceSha256` 也必须等于审阅时记下的值。

`run-revalidation.mjs --apply` 是既有的一步“验证并立即采纳”路径，这里仅说明其行为，
**不属于方案 A，也不得用于本流程采纳**。它会在一次运行内重读当时的索引与撤销状态、重新计算目标、
写出新证据，然后只复核索引摘要便立即调用 `revalidate`；中间没有暂停并交付本次撤销快照和新证据
供人工审阅的步骤。因此，即使调用前已重查，也不能把这次运行产生的新证据视为已审阅证据。
默认路径在同宿主、同一天还会覆盖先前证据。方案 A 只采纳上面已与撤销快照一并审阅、
且采纳前复核一致的证据，不重新运行验证 runner。

runner 做这些事：

1. 克隆 `$DSH_HOME`（APFS 上是 clonefile，秒级）并改写克隆索引里的 `moduleUrl` 指向克隆内的
   promoted 源码——记录路径必须落在自己的数据根内，这是正式校验规则。
2. 用**当前宿主**的 `dsh` 启动基线 ACP / Web 消费入口，读取它们自己记录在
   `shared-plugins/consumers/<profile>.json` 里的宿主事实（`dsh` / `cordis` / `include` / `node`），
   并要求两个入口的宿主一致；同时确认目标记录确实是 `pending-revalidation`（`host-version-mismatch`）。
3. 只把**克隆里**目标记录的 `host` 改成刚读到的当前宿主事实，重新启动两个入口：
   记录必须变成 `active`，且 `sourceSha256` 未变、行上的 `hostDigest` 等于当前宿主摘要。
4. 按 `scripts/acceptance/revalidation-plans.json` 对每条记录做一次确定性的真实工具调用
   （官方批量执行器；选择了 PTC `run_code` 程序型执行器的入口会改用同一 agent 下的注册定义，
   报告里写明用的是哪条路径）。计划里没有条目的记录只做挂载证明，不调用工具。
5. 写出 schema 1 的 `dsh-evolution-cross-entry-evidence`（`--out` 默认写到
   `docs/evidence/revalidation-<host>-<date>.json`）。
6. `--apply` 时：确认索引在验证期间没有变化，然后**只通过** `shared-plugins.mjs revalidate`
   采纳本次运行刚写出的证据，再克隆更新后的数据根、在**不做任何宿主改写**的前提下重启两个入口，
   证明“下一次真实启动就会挂载”，并断言 `storages/evolution`（除 `shared-plugins/` 外）与
   共享经验的已提交行数没有变化。这是既有一步路径的行为说明；它不交付本次新证据供人工审阅，
   不属于方案 A，不得用于本流程采纳。
7. 采纳结果写进旁文件 `<evidence>.report.json`（`dsh-evolution-revalidation-report`）：
   采纳回执（含索引记录的 `evidenceSha256`）、采纳后复验、保留证明。**证据本体自写出后不再改动**
   ——发布索引按 `evidenceSha256` 固定它，runner 在采纳前后各校验一次字节，命令回报的摘要与
   本地摘要不一致就失败。需要事后补证据时写新文件，不改旧文件。

## 安全边界（没有一条被放宽）

- 源码不动：每条记录在采纳前重新计算 `sourceSha256`，必须等于发布记录；不修改、不重新生成、不重新晋升。
- 正式数据根只在 `revalidate` 命令里被写一次（追加 `revalidation` 世代并更新记录宿主）。
- “当前宿主已验证”这个假设只存在于**一次性克隆**里；证据同时记录了这一步，以及每个入口真实的
  挂载结果、`hostDigest`、工具调用输出。任何人都能复核。
- 索引在验证期间被其它发布改动时，runner 的 `--apply` 路径拒绝采纳；直接采纳已审证据时，
  操作者必须在写入前完成索引摘要重查。
- 撤销状态快照与证据一起审阅，并在写入前重查；不一致即中止且不写入。
- 最后一次重查至采纳命令返回之间必须维持人工禁写窗口；无法确保没有其他写入者时不得采纳。
- 方案 A 只采纳已审阅证据；`run-revalidation.mjs --apply` 仅作既有行为说明，不得作为采纳路径。
- 证据不通过则什么都不写。

## 采纳之后

发布索引里的记录已经是 active eligibility，但**已经启动的**消费入口不会热加载：
ACP 需要新 session，Web 需要重启入口（沙箱里用同一条 `dsh --profile web` 启动、
`--port 0`、`--no-open` 即可）。`shared-plugins.mjs list` 的 `needsRestart` 和
`evolution_plan` 的 `restart-consumer` 会如实报告这一点。

## 下一次宿主升级

1. 审计（`evolution_desktop` / `evolution_plan` 的 `audit`）给出 `revalidate` 与记录 ID。
2. 按第 1 步保存撤销状态快照与 `published.json` SHA-256，再运行
   `node scripts/acceptance/run-revalidation.mjs --home ~/.dsh --out docs/evidence/revalidation-review.json`
   （不带 `--apply`）获取证据。
3. **完整执行上文「2. 审阅证据并作出人工决定」**，不得省略：把快照、索引摘要与证据一起审阅，
   核对宿主、`source.indexDigestBefore`、`verification.targetIds` / `plugins[]` 范围、源码摘要与各 profile
   结果，并记录证据 SHA-256。任一检查失败或目标范围超出批准，就停止采纳；撤销或启用 profile 必须另作
   独立决定，不得作为取证的前置步骤。
4. 操作者审阅通过并明确决定采纳后，按第 3 步协调人工禁写窗口，再重查撤销状态、索引摘要与证据
   SHA-256；不一致或无法确保窗口内没有其他写入者时中止且不写入。全部一致且窗口已确认才直接运行
   `node scripts/shared-plugins.mjs revalidate --home ~/.dsh --evidence docs/evidence/revalidation-review.json`，
   只采纳该证据列出的记录。命令返回后重查撤销状态；发现或怀疑窗口内发生变化时停止后续操作并报告。
   不要用再次运行 `run-revalidation.mjs --apply` 代替这一步，因为它会重新筛选目标并采纳新证据。
5. 重启 ACP / Web 消费入口（新 session 或重启 Web），审计应回到 `active`。

不需要再人工构造证据，也不需要改插件源码。若某条记录在验证阶段不是 `pending-revalidation`
（例如 `skipped-invalid` / `failed` / `skipped-incompatible`），runner 会失败并保留日志，
这时是真实的兼容性问题，应走审计给出的 `repair-stable` 路径。
