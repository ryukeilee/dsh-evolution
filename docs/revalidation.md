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

```sh
# 1. 只验证并写证据（不写正式数据根）
node scripts/acceptance/run-revalidation.mjs --home ~/.dsh

# 2. 验证 + 通过官方命令采纳（写正式发布索引）
node scripts/acceptance/run-revalidation.mjs --home ~/.dsh --apply
```

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
   采纳证据，再克隆更新后的数据根、在**不做任何宿主改写**的前提下重启两个入口，
   证明“下一次真实启动就会挂载”，并断言 `storages/evolution`（除 `shared-plugins/` 外）与
   共享经验的已提交行数没有变化。

## 安全边界（没有一条被放宽）

- 源码不动：每条记录在采纳前重新计算 `sourceSha256`，必须等于发布记录；不修改、不重新生成、不重新晋升。
- 正式数据根只在 `revalidate` 命令里被写一次（追加 `revalidation` 世代并更新记录宿主）。
- “当前宿主已验证”这个假设只存在于**一次性克隆**里；证据同时记录了这一步，以及每个入口真实的
  挂载结果、`hostDigest`、工具调用输出。任何人都能复核。
- 索引在验证期间被其它发布改动时，runner 拒绝采纳。
- 证据不通过则什么都不写。

## 采纳之后

发布索引里的记录已经是 active eligibility，但**已经启动的**消费入口不会热加载：
ACP 需要新 session，Web 需要重启入口（沙箱里用同一条 `dsh --profile web` 启动、
`--port 0`、`--no-open` 即可）。`shared-plugins.mjs list` 的 `needsRestart` 和
`evolution_plan` 的 `restart-consumer` 会如实报告这一点。

## 下一次宿主升级

1. 审计（`evolution_desktop` / `evolution_plan` 的 `audit`）给出 `revalidate` 与纪录 id。
2. 跑 `node scripts/acceptance/run-revalidation.mjs --home ~/.dsh --apply`。
3. 重启 ACP / Web 消费入口（新 session 或重启 Web），审计应回到 `active`。

不需要再人工构造证据，也不需要改插件源码。若某条记录在验证阶段不是 `pending-revalidation`
（例如 `skipped-invalid` / `failed` / `skipped-incompatible`），runner 会失败并保留日志，
这时是真实的兼容性问题，应走审计给出的 `repair-stable` 路径。
