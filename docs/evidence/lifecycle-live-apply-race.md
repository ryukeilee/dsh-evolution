# 宿主实时应用能力的竞态：`lifecycle-disable` 偶发失败与验收断言修正

基线 `main` 的 `36eec4f`。本文件处理 `docs/performance/autonomous-restart/report.md` 里那句
“未确定该不一致的根因”：它记录了 `docs/evidence/autonomous-restart-0.2.1-alpha.1-failed.json`
的唯一失败步骤

```
lifecycle-disable: Error: disable: application=restart-required but live state violates restart semantics
```

同时说明为什么同一份产物、同一份探针、同一个宿主在其他记录里通过。结论：**这是宿主
`pluginManager` 把“实时应用能力”读了两次（一次用来写回执、一次用来决定是否实时生效）造成的时间窗，
不是插件缺陷**；插件生产代码本轮未改，改的是验收探针里那条把回执当成原子承诺的断言。

## 1. 根因

### 1.1 宿主用一次能力快照当回执

`@deepseek-ai/dsh-plugin-manager@0.2.1-alpha.1` 的 `PluginManager`（`lib/index.js`）：

```js
async change(operation, request, reason) {
  return withFileLock(join(this.profile.dir, "package.json"), async () => {
    ...
    const result = {
      ...request,
      changed: false,
      application: this.ownerContext.get("hmr") !== void 0 ? "applied" : "restart-required"  // 读 #1：回执
    };
    try { result.application = await operation(result) ?? result.application; } ...
```

`setBundleEnabled()` 的操作体经 `configure()` 再读一次，`reload()` 又读一次：

```js
configure(operation) {
  const hmr = this.ownerContext.get("hmr");                       // 读 #2：选择应用路径
  return hmr === void 0 ? apply() : hmr.runExclusive(apply);
}
async reload(requiredIds = []) {
  if (this.ownerContext.get("hmr") === void 0) return [];         // 读 #3：是否真的重建 live 树
  return reconcileProfilePatches(this.ownerContext.root, readProfilePatches("dsh", this.profile), "dsh", requiredIds);
}
```

三次读取之间隔着 `withFileLock` 的获取、`selectBundle()` 的 manifest 写入与（启用时）
`refreshPackages()`。`application` 是**读 #1** 的快照，live 效果由**读 #2/#3** 决定：两者不一致时，
宿主会报 `restart-required` 并把改动实时生效。`0.2.0-rc.2` 的同一实现（`lib/index.js` 的
`change()` / `configure()`）形状完全相同，所以这不是某个 alpha 版本的特例。

### 1.2 `hmr` 在启动期是异步出现的

`ctx.get(name)` 默认 `strict`，Cordis 4.0.5 的 `reflect.get()` 会过滤掉非 ACTIVE 的提供者：

```js
_getImpl(name, strict = true) {
  ...
  if (strict && impl.fiber.state !== 2) return;   // 2 = ACTIVE
  return impl;
}
```

`dsh-hmr` 在构造函数里 `super(ctx, "hmr")` 注册服务，但它的 `[Service.init]` 异步生成器要先
`await watchConfig(...)`（profile 的 patch/package 三处 watcher）再 `await loadDependencies(mainJob)`，
Cordis 的 `_reload()` 只有在 `await this._execute(this._runner)` 之后才把 fiber 置为 ACTIVE。因此在
宿主启动期存在一段时间：**Evolution 条目已经 live，`hmr` 还查不到**。这段时间的长度取决于模块与文件
系统负载，不受插件控制。

### 1.3 失败与成功记录的差别只是落点

`scripts/acceptance/probes/lifecycle-probe.mjs` 在动作前等待“启动状态符合预期”：

- `disable`：等 `ctx.get('evolution')` 已挂载且注册 10 个工具 → 等待结束时 `hmr` **通常**已可见；
- `enable`：期望的启动状态本来就是“未挂载”，循环第一轮立即满足 → 动作在启动早期就发出。

于是同一次竞态有三种落点，验收记录里两种都出现过：

| 读 #1（回执快照） | 读 #2/#3（live 决定） | 回执 | live 树 | 旧断言 |
| --- | --- | --- | --- | --- |
| `hmr` 已可见 | 已可见 | `applied` | 已切换 | 通过 |
| 尚不可见 | 尚不可见 | `restart-required` | 未变 | 通过（`autonomous-restart-0.2.1-alpha.1.json` 的 `lifecycle-enable`） |
| 尚不可见 | 已可见 | `restart-required` | **已切换** | 失败（`autonomous-restart-0.2.1-alpha.1-failed.json`） |

旧断言把第三行判成“live 状态违反 restart 语义”。宿主并没有这样承诺：它报告的是一个比决策更早的
快照。第三行要求的是一次原子读取，而宿主提供的不是。

## 2. 复现

`scripts/acceptance/probes/live-apply-race-probe.mjs` 是这条竞态的复现探针（不属于验收流程）：

```sh
# 隔离 runtime/home，官方 0.2.1-alpha.1，同一个已安装的 tarball
node scripts/acceptance/run-host-acceptance.mjs --host 0.2.1-alpha.1 --runtime <prepared-runtime> \
  --work <work> --keep          # 准备 profile 与用户数据（任何一步即可）
DSH_HOME=<work>/home EVOLUTION_RACE_MODE=order  node <cli> --profile web --patch <probe-patch> -- --no-open --host 127.0.0.1 --port 0
DSH_HOME=<work>/home EVOLUTION_RACE_MODE=switch node <cli> --profile web --patch <probe-patch> -- --no-open --host 127.0.0.1 --port 0
```

`--patch` 覆盖层把探针作为一个条目 `insert` 进 loader 树（与 `run-host-acceptance.mjs` 的
`bootProbe()` 相同），探针收到 `run` 后回 `result`。

**启动顺序不是固定的。** `order` 模式（本机 Node v26.13.0 / darwin-arm64，8 核，隔离 runtime）：

```
# 空载，3 次
{"mode":"order","evolutionLiveAtMs":130,"liveApplyAvailableAtMs":103,"first":"live-apply","gapMs":-27}
{"mode":"order","evolutionLiveAtMs":122,"liveApplyAvailableAtMs":97, "first":"live-apply","gapMs":-25}
{"mode":"order","evolutionLiveAtMs":129,"liveApplyAvailableAtMs":102,"first":"live-apply","gapMs":-27}
# 24 个 CPU 占满进程，6 次
gapMs: -117, 0, -159, -184, -158, 0
```

`switch` 模式直接测“Evolution 已 live 的那一刻能力是否可见”，因此不受采样偏差影响。24 个 CPU 占满
进程下 12 次：

```
{"mode":"switch","application":"applied",          "liveApplyBefore":false,"liveApplyAfter":true,"mountedBefore":true,"mountedAfter":false,"toolsAfter":0,"preFixConsistent":true}
{"mode":"switch","application":"applied",          "liveApplyBefore":true, "liveApplyAfter":true,"mountedBefore":true,"mountedAfter":false,"toolsAfter":0,"preFixConsistent":true}
{"mode":"switch","application":"applied",          "liveApplyBefore":true, "liveApplyAfter":true,...}
{"mode":"switch","application":"applied",          "liveApplyBefore":true, "liveApplyAfter":true,...}
{"mode":"switch","application":"restart-required", "liveApplyBefore":false,"liveApplyAfter":true,"mountedBefore":true,"mountedAfter":false,"toolsAfter":0,"preFixConsistent":false}
{"mode":"switch","application":"applied",          "liveApplyBefore":false,"liveApplyAfter":true,...}
{"mode":"switch","application":"applied",          "liveApplyBefore":true, "liveApplyAfter":true,...}
{"mode":"switch","application":"applied",          "liveApplyBefore":false,"liveApplyAfter":true,...}
{"mode":"switch","application":"applied",          "liveApplyBefore":false,"liveApplyAfter":true,...}
{"mode":"switch","application":"applied",          "liveApplyBefore":false,"liveApplyAfter":true,...}
{"mode":"switch","application":"applied",          "liveApplyBefore":true, "liveApplyAfter":true,...}
{"mode":"switch","application":"applied",          "liveApplyBefore":true, "liveApplyAfter":true,...}
```

12 次里有 6 次在 Evolution 已 live 时还查不到 `hmr`，其中 1 次得到与失败记录完全相同的形状：
`application=restart-required`、`liveApplyBefore=false → liveApplyAfter=true`、live 树已卸载
（`preFixConsistent=false` 就是旧断言的那条拒绝）。这是本机可重复的复现；失败记录里那次是这个窗口的
同一落点，只是当时的负载（全量测试与三宿主验收同时运行）把窗口拉得更宽。

## 3. 改动（只改验收探针）

`scripts/acceptance/probes/lifecycle-probe.mjs` 不再用回执推断 live 树，而是记录能力在调用前后的
取值（`liveApplyBefore` / `liveApplyAfter`），并按**reload 决策实际看到的能力**断言。歧义只有一个方向
——回执是更早的那次读取：

- 能力在调用前后**未变**：回执必须与该能力一致（`hmr` 可见 ⇒ `applied`，不可见 ⇒
  `restart-required`），live 树必须跟随回执；
- 能力在调用期间**出现**（`false → true`）且回执是 `restart-required`：快照早于出现，reload 可能已经
  看到能力，两种 live 结果都可解释；
- 能力在调用期间**消失**（`true → false`）且回执是 `applied`：快照早于消失，reload 可能没看到能力，
  两种 live 结果都可解释；
- 其余组合都没有歧义：回执 `applied` 说明快照已经看到能力，而 reload 的读取在快照之后，所以**必须**
  到达 live 树（`false → true` 也不例外）；回执 `restart-required` 而能力从未出现时 live 树**必须**
  不动。

两种“可解释”情形仍然要求切换是原子的（服务与工具面同时处于“调用前”或“选中后”之一），并把这次
转变写进证据。`applied` 但 live 树没变（除上面的消失情形）、`restart-required` 但 live 树处于第三种
状态、回执与稳定能力矛盾、用户数据被改写——一律仍然失败。

没有新增重试、没有新增延迟、动作仍只发出一次。用户数据逐字节不变、`event-bridge.key` 存在、工具数
`10`/`0` 的断言原样保留。

fake host 按宿主的三次读取（快照 → `configure()` → `reload()`）复现：`configure()` 只决定是否走
`runExclusive()`，操作体（含 `reload()`）**总会**执行，所以三次读取都会发生。改前/改后对同一批观察的
差分：

```
## stable capability (disable)
pre-fix : ok application=applied mountedAfter=false tools=0
current : ok application=applied mountedAfter=false tools=0 liveApply=true->true

## stable capability absent (enable)
pre-fix : ok application=restart-required mountedAfter=false tools=0
current : ok application=restart-required mountedAfter=false tools=0 liveApply=false->false

## capability appears before the snapshot, unmount works (disable)
pre-fix : ok application=applied mountedAfter=false tools=0
current : ok application=applied mountedAfter=false tools=0 liveApply=false->true

## capability appears before the snapshot, unmount fails (disable)
pre-fix : FAILED Error: disable: application=applied but live state violates restart semantics
current : FAILED Error: disable: application=applied but live state is mounted=true, tools=10, expected mounted=false, tools=0

## capability appears between the snapshot and configure (disable)
pre-fix : FAILED Error: disable: application=restart-required but live state violates restart semantics
current : ok application=restart-required mountedAfter=false tools=0 liveApply=false->true

## capability appears between configure and reload (disable)
pre-fix : FAILED Error: disable: application=restart-required but live state violates restart semantics
current : ok application=restart-required mountedAfter=false tools=0 liveApply=false->true

## capability vanishes after the snapshot (disable)
pre-fix : FAILED Error: disable: application=applied but live state violates restart semantics
current : ok application=applied mountedAfter=true tools=10 liveApply=true->false
```

中间两组就是失败记录里的形状（旧断言误报，`restart-required` + live 已切换）；最后一组是反方向的
误报（`applied` + live 未切换，旧断言没有记录，因为三宿主验收里 `hmr` 没有在调用中消失）。第四组证明
“回执 `applied` 就必须到达 live 树”这条守卫没有因为修误报而放宽。单元测试把这些都固定下来：同一批
观察必须被冻结的改前判定拒绝（返回的就是失败记录里的那句话），被改后的探针接受；而“回执 `applied`
但没卸载”“服务消失但工具面留着”“回执与稳定能力矛盾”“能力转变期间 live 树既不等于调用前也不等于选中
后”“用户数据被改写”仍然全部被拒绝。

真实宿主上（0.2.1-alpha.1，隔离 runtime/home，改后探针）：

```
verify  OK applied           selected=true  mountedAfter=true  tools=10 liveApply=true  -> true
disable OK applied           selected=false mountedAfter=false tools=0  liveApply=true  -> true
enable  OK restart-required  selected=true  mountedAfter=false tools=0  liveApply=false -> false
verify  OK applied           selected=true  mountedAfter=true  tools=10 liveApply=true  -> true
```

24 个 CPU 占满进程下 `disable` 10 次全部 `applied` / `liveApply=true -> true` / live 已卸载。

## 4. 已执行的验证

- 定向：`node --max-old-space-size=4096 --test test/lifecycle-probe-live-vs-selected.test.mjs` → 11 pass。
- 全量：`NODE_OPTIONS=--max-old-space-size=4096 npm test` → 1402 项全部通过（提交后重跑）。
- 打包：`npm run pack:check` → 16 项通过（开发后继语义：“工作树是固定点的已提交后继”）；
  `pack:check -- --release` 未跑，本轮不更新 `release/` 固定点。
- 本地产物：`npm run release:pack -- --dist dist/lifecycle-live-apply` →
  `dsh-evolution-0.2.0.tgz`，sha256 `10f3ec979f67ef9803be66f079a6b72aff346b120f31a1d74aecaf3bbdc58f38`，
  内容摘要 `f5681a69d03345f92063aabe599b853fa6e17465fed5ccc46e2853b632eb3a0d`（51 个条目），
  Node v26.13.0 / npm 11.20.0 / darwin-arm64。
- 三宿主真实验收：见第 5 节。
- 独立审核：见第 6 节。

## 5. 三宿主验收

同一份产物、隔离 runtime/home，串行（每宿主全新安装官方 DSH，21 步）：

| 宿主 | 结果 | 证据 |
| --- | --- | --- |
| `0.2.0-rc.2` | 21/21 ok | `docs/evidence/lifecycle-live-apply-race-0.2.0-rc.2.json` |
| `0.2.1-alpha.1` | 21/21 ok | `docs/evidence/lifecycle-live-apply-race-0.2.1-alpha.1.json` |
| `0.2.1-rc.2` | 21/21 ok | `docs/evidence/lifecycle-live-apply-race-0.2.1-rc.2.json` |

三个宿主都记录了同一条能力轨迹（`liveApplyBefore -> liveApplyAfter`），也就是“回执与能力一致”的那一
支断言真正被执行：

```
lifecycle-verify   applied           selected=true  mountedAfter=true  tools=10  true  -> true
lifecycle-disable  applied           selected=false mountedAfter=false tools=0   true  -> true
lifecycle-enable   restart-required  selected=true  mountedAfter=false tools=0   false -> false
lifecycle-verify   applied           selected=true  mountedAfter=true  tools=10  true  -> true
```

这些文件记录的是**本轮树**的产物内容摘要，不是 `release/` 固定点；`docs/evidence/dsh-<host>.json`
仍然描述固定点，未被改写。

## 6. 边界与剩余风险

- **上游未修。** 宿主仍可能在一次调用里报 `restart-required` 并把改动实时生效；插件侧无法改变这一点，
  也不应该去改（那是宿主自己的回执语义）。本轮只让验收不再把它判成缺陷，并把它记进证据
  （`liveApplyBefore` / `liveApplyAfter`）。
- **能力转变期间只断言原子性。** 那一瞬间无法区分“reload 读到 false”与“卸载失败”，所以只要求 live 树
  是两种状态之一。这条边界在改动前同样存在（旧断言在该落点也会放过“没卸载”的情形）。
- **`enable` 仍在启动早期发出。** 它因此继续覆盖 `restart-required` 语义（保存的选中项变化、live 树
  不动）。若上游把快照与决策合并成一次读取，这条分支会变成死代码——仍然正确，只是不再被触发。
- **竞态与宿主版本无关。** `0.2.0-rc.2` 与 `0.2.1-alpha.1` 的实现形状相同，差异只在启动时序；因此本轮
  没有把“某个宿主版本不安全”写进兼容矩阵。
- **没有更新发布固定点。** `release/` 不变；重新固定需要按 `RELEASE.md` 重新打包、跑三宿主验收并发布。
