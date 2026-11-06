# DSH 0.2.2-rc.1 兼容适配与 HMR 事务边界

隔离工作树 `/tmp/dsh-evolution-022`（起始 HEAD `98f1b81aacf6e7365ae4fcfd4d8a70d9915573d5`），
Node `v26.13.0`。**结论：0.2.2-rc.1 可以交付，条件是关闭宿主 `hmr` 行（profile 变更按重启生效）；
HMR 打开时存在一个属于上游的启动事务缺口，本仓库不修、不绕过，只把它的事实与复现留在本目录。**
生产 DSH、正式 `release/` 固定产物、其他插件与模型设置都未被修改；本轮也没有提交、推送、发布或升级生产。

## 上游缺口（未变）

`PluginManager.setBundleEnabled()` → `configure()` → `selectBundle()` → `publishAndReload()` →
`reload()` → `Hmr.reconcileProfile()`：

1. `configure()` 读 HMR；尚未可用时直接执行 operation，不进入 `runExclusive`。
2. `selectBundle()` 异步保存 profile，期间 HMR 的 init 可以完成并发布服务。
3. `reload()` 再读 HMR，看到新可用就调用 `reconcileProfile()`；该实例 `executing.getStore()` 不是
   `true`，官方保护正确拒绝，结果为 `changed: true` / `application: failed`。

源码位置（`0.2.2-rc.1` 安装包内）：`dsh-plugin-manager/lib/index.js:2688`、`:3048`、`:3093`、
`:3120`、`:3129`；`dsh-hmr/lib/index.js:735`、`:748`、`:1325`。`official-control.json` 是纯官方
（无 Evolution 条目或依赖）的受控复现：诊断包装器只在真实 `selectBundle()` 返回后等待真实 HMR 可见，
固定一种异步交错；**3/3 次复现该错误，另 3/3 次先等 HMR 再用同一启用动作则成功**。这是受控调度，
不是自然命中率：8 次常规插件开关与 10 次官方 bundle 启用都没有自然命中。

## 本轮交付路线：关闭宿主 HMR + 重启生效

官方 `@deepseek-ai/dsh-hmr` README 明确说明“Disabling or omitting HMR applies changes on restart”，
并给出 profile patch 里 `- id: hmr` / `disabled: false` 的同一 overlay 形态。把该行设为 `disabled: true`
后，`PluginManager.configure()` 直接执行 operation、`reload()` 只重组已保存的 profile 并用
`composeEntries()` 返回 `{warnings: []}`，`change()` 在操作开始前就把回执定为
`application: "restart-required"` / `restartReason: "no-hmr"`，**完全不调用 `reconcileProfile()`**。
没有延时、重试、清空 ALS、替换 HMR 实例或修改官方源码。

`hmr-route.json` 是本轮新增的配对证据，每个配对使用同一 `$DSH_HOME`，3/3 组全部符合预期：

- 第一次启动（`hmr` 关闭，profile 只选 `dsh-base`）：立即执行与受控复现**同一时刻、同一动作**的
  `setBundleEnabled('@deepseek-ai/dsh-web-app', true)`，得到 `changed: true` /
  `application: "restart-required"` / `restartReason: "no-hmr"`、无 `error`；`configure` 与 `reload`
  两个阶段都记录到 `hmr: false`，没有事务、没有 reconcile。
- 紧接着第二次启动同一个 home：`ctx.get('webStartup')` 为 `true`、选中的 bundle 包含
  `@deepseek-ai/dsh-web-app`，即第一次启动保存的选择确实在重启后生效。

该分组的 overlay 在运行后从磁盘复核：三个 no-HMR 引导的 patch 文件都以 `- id: hmr` / `disabled: true`
开头，barrier / stable 分组的没有这一行。第一版脚本把模式从父进程环境读取，导致 no-HMR 分组实际上仍
开着 HMR 却仍报 9/9；现在驱动把 `mode` 显式传给 overlay 生成、并在写盘后校验这一行，缺行直接抛错。
上面三组结论来自修正后的这次运行。

复现两个分组（受控失败 + 稳定对照 + no-HMR 配对）：

```sh
node --max-old-space-size=4096 scripts/acceptance/reproduce-hmr-startup.mjs \
  /tmp/dsh-022-runtime.mPpWYP docs/evidence/hmr-022/hmr-route.json
```

需要已安装的官方 0.2.2-rc.1 runtime；脚本自动创建临时 DSH_HOME 并保留，路径写在 JSON 里。诊断模块被
复制到临时根，避免被误识别为 Evolution 包内入口；不给任何包版本豁免。退出 0 只表示 9 个受控结果都符合
预期（3 barrier 失败 + 3 stable 成功 + 3 no-HMR 配对），**不表示宿主验收通过**。

## Evolution 在两种形态下的行为

Evolution 的晋升不经过宿主 HMR 队列：它写自己的 `promoted.cordis.yml`，用自己挂载的官方 Include
（`lib/promotion-include.js` 的 `refresh()` / `EntryTree.resolve` / `await`）应用与回收。因此
trial / measure / revert / promote / canary / 重启恢复在 HMR 打开或关闭时行为一致；关闭 HMR 影响的是
**宿主自己的 profile 变更**（安装、启用、禁用、更新），它们改为重启生效。

真实宿主验收（本轮，`--no-hmr`，21/21 步，最终 `doctor-final` 为 `healthy`，退出码 0）：
`docs/evidence/dsh-0.2.2-rc.1.json`（`hostLiveApply: "disabled"`）。同轮还用同一个候选包重跑了
`0.2.1-rc.2` 的完整验收（21/21，HMR 保持开启），确认没有把旧宿主拖坏。两项结果与命令记在
`checks.json`。

## 性能

关闭 HMR 同时是这条兼容路线上唯一可测的冷启动收益：隔离 0.2.2-rc.1 上 9 轮交替 A/B 中位数，
Evolution 已安装时墙钟 **−87.9 ms（−5.8%）**、CPU **−128.0 ms（−6.6%）**、RSS **−6.8 MiB（−2.0%）**；
不装 Evolution 时为 −122.8 ms（−8.4%）。原始样本、口径与未采纳的候选见
`docs/performance/host-startup-0.2.2.md`。本插件内部 JS 自耗时是毫秒级，没有为微小收益引入惰性加载或缓存。

## 记录边界

- `official-control.json`、`official-bundle-results.json`、`official-results.json`、
  `independent-control.json`、`inherited-failure.json`、`evolution-core.json`、
  `evolution-ready-cycles.json` 是上一轮（2026-11-06 早期）在同一个 runtime 上完成的既有证据，本轮
  没有重跑，也没有把它们的数字当作本轮结果。
- `hmr-route.json` 与本轮 `docs/evidence/dsh-0.2.2-rc.1.json` 是本轮实际执行的证据。
- `latest-check/` 是上一轮对 npm/GitHub 发布状态的只读核对，本轮没有重新查询 registry。
- 生产环境的升级、备份、启停未执行；`release/` 固定产物未改动，因此 `pack:check` 与
  `test/release-pin.test.mjs` 中“证据等于固定点”的两项仍需在重新固定时才会转绿（见
  `checks.json` 的 `knownFailures`）。
