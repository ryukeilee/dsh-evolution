# DSH 0.2.2-rc.1 冷启动：关闭宿主 HMR 的端到端收益与 Evolution 自身开销

## 结论

隔离的官方 `0.2.2-rc.1` runtime 上，用本仓库提交的
[`scripts/benchmarks/host-startup.mjs`](../../scripts/benchmarks/host-startup.mjs) 交替测四种配置各 9 轮：
Evolution 已安装时，把宿主 `hmr` 行关掉（本版本在 0.2.2-rc.1 上的验收形态）让冷启动
**墙钟 −87.9 ms（−5.8%）、就绪时间 −88.0 ms（−6.2%）、CPU −128.0 ms（−6.6%）、RSS −6.8 MiB（−2.0%）**；
不装 Evolution 的同一 profile 上是 **−122.8 ms（−8.4%）/ CPU −193.3 ms（−10.3%）/ RSS −11.1 MiB（−3.4%）**。
9 轮配对方向全部一致，逐轮差值的绝对值远大于同配置噪声。

Evolution 自己在同一冷启动里增加 **+85.9 ms（+6.4%）、CPU +121.7 ms、RSS +13.2 MiB**（`hmr` 关闭时），
其中仓库自身 JS 的自耗时可以忽略，主要是模块图加载。**本轮没有为这部分引入任何代码改动**：
可得的收益量级只有个位数毫秒到约 20 ms（见“归因与未采纳的候选”），而惰性加载会把首次使用时才发生的
失败窗口引入到数据写入路径，按本项目“微小收益不作主要成果”的判据不值得实施。

本轮唯一与性能有关的交付是**部署形态**：关闭宿主 HMR 既是 0.2.2-rc.1 的兼容路线，也是该宿主上可测的
冷启动收益来源。运行时热路径、持久化语义、提交顺序、门禁与授权边界都没有改动。

## 口径

- 环境：Node `v26.13.0`、darwin-arm64；父子进程都带 `--max-old-space-size=4096`。测量期间没有并发运行
  测试或验收。
- runtime：隔离安装的官方 `@deepseek-ai/dsh@0.2.2-rc.1`（`@deepseek-ai/cordis@4.1.0`、
  `cordis-plugin-include@1.1.0`、`cordis-plugin-loader@1.1.0`）。
- home：本仓库本轮 `run-host-acceptance.mjs --host 0.2.2-rc.1 --no-hmr` 的 `--work` 目录（该验收装的就是
  本轮候选包），完成验收后**只读复制两份**用于测量；测量不写回验收目录。该 home 由
  `contentSha256` `d43c7e81…` 的构建产出；此后本树只改了 README / CHANGELOG / COMPATIBILITY / RELEASE
  四个 markdown 文件，`lib/`、`package.json`、`cordis.patch.yml` 与两份 `scripts/` 入口逐字节未变，所以
  表中的数字描述的就是本版分发代码。重跑会得到量级相同的数字；离散度见上面的分位数与逐轮配对差。
- 四种配置都通过官方 `--patch` overlay 引导：`evolution-*` 复制件保留
  `dsh.profile.bundles` 中的 `dsh-evolution`；`host-*` 复制件只把该条目从 `dsh.profile.bundles` 里去掉
  （包仍安装），因此两者只差本 bundle 自己的启动工作。`*-hmr-off` 在 overlay 里多一行
  `- id: hmr` / `disabled: true`，与 README 给操作者的形态完全相同。
- 就绪定义：`evolution-*` 等到 `ctx.get('evolution')` 可用**且**官方 registry 里 10 个 `evolution_*` 工具
  可见；`hmr-on` 还要等到 `ctx.get('hmr')` 可用（否则测的是宿主更早的阶段，不是可比的就绪点）。
  `readyMs` 是 `performance.now()`，`wallMs` 是父进程 fork→子进程报告的时间，两者差值主要是引导与 IPC。
- 每轮都切换配置顺序（偶数轮正序、奇数轮倒序），表中取 9 个样本的**中位数**；CPU 是每个样本
  `user + system` 之后再取中位数（不是两个分量的中位数之和）；任何样本没达到目标就绪状态都会记为失败、
  不进中位数并让命令以非零退出。原始样本见
  [host-startup-0.2.2.json](host-startup-0.2.2.json)（含每轮每配置的 wall / ready / RSS / heap / CPU）。
- 没有测：冷页缓存（全部样本共用系统缓存的热状态）、真实模型请求延迟、稳态空闲 CPU、promotion 提交
  延迟、大历史冷启动。最后一项属于领域侧吸收成本，仓库已有独立基准与记录（见“相关材料”），本轮没有
  重新测量，也不把旧数字当作本轮结果。

## 结果

9 轮中位数（p25/p75 用同一批样本的分位数，括号内是相对 `hmr-on` 的变化）：

| 配置 | wall ms | ready ms | CPU ms | RSS MiB | heapUsed MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| `evolution-hmr-on` | 1521.0（1520.2/1521.8） | 1430.7 | 1940.5 | 332.8 | 186.7 |
| `evolution-hmr-off` | **1433.2**（1432.2/1435.6）**−87.9（−5.8%）** | **1342.7 −88.0（−6.2%）** | **1812.5 −128.0（−6.6%）** | **326.0 −6.8（−2.0%）** | 197.1 |
| `host-hmr-on` | 1470.0（1468.5/1471.1） | 1380.3 | 1884.1 | 323.9 | 198.5 |
| `host-hmr-off` | **1347.2**（1346.4/1347.7）**−122.8（−8.4%）** | **1256.7 −123.6（−9.0%）** | **1690.8 −193.3（−10.3%）** | **312.8 −11.1（−3.4%）** | 191.4 |

逐轮配对差（同一轮内 B−A，9 个值全部同号）：

| 比较 | 逐轮 wall 差 ms |
| --- | --- |
| `evolution-hmr-off` − `evolution-hmr-on` | −121.2、−86.6、−93.3、−85.6、−87.6、−89.6、−87.0、−83.1、−77.2（全部为负，中位 −87.0） |
| `host-hmr-off` − `host-hmr-on` | −119.6、−114.8、−130.9、−121.9、−124.7、−120.9、−128.2、−121.4、−124.5（全部为负，中位 −121.9） |
| `evolution-hmr-off` − `host-hmr-off` | +78.5、+80.3、+81.8、+85.4、+87.5、+84.6、+91.3、+89.0、+96.3（全部为正，中位 +85.4） |

同配置内的离散度很小（wall 极差：`evolution-hmr-on` 28.8 ms、`evolution-hmr-off` 17.2 ms、`host-hmr-on` 9.5 ms、
`host-hmr-off` 14.3 ms），配对差也全部超过该离散度，因此这些差不是顺序或机器漂移。`heapUsed` 的方向不稳定（`evolution-hmr-off` 197.1 MiB，`evolution-hmr-on` 186.7 MiB，`host-hmr-on` 198.5 MiB，`host-hmr-off`
191.4 MiB）：关掉 HMR 少了一整套 watcher 图，RSS 下降，但堆使用取决于同一批模块的布局，这组数字不足以支撑
“堆使用变化”的结论，本报告只主张 RSS 与 CPU。

## 归因与未采纳的候选

HMR 的代价是**模块图 + watcher 初始化**：`dsh-hmr` 在宿主启动时加载 `chokidar`、`picomatch`、
`@babel/code-frame`、`node-addon-require-builtin` 等，并在 init 中建立配置与模块 watch。因此关掉它省下的
是启动阶段的加载与初始化，而不是稳态热路径。`host-hmr-on` 与 `host-hmr-off` 只差这一行，两者之差就是
该成本的上界（−122.8 ms wall / −193.3 ms CPU）。

Evolution 自身 +85.9 ms / +13.2 MiB 的来源也主要是模块图：对一次冷启动做 `--cpu-prof` 采样，
`lib/` 下的函数自耗时合计约 6 ms（存储打开、注册、Include 挂载各不到 1 ms），其余是 ESM 解析/编译与
第三方包加载。该采样是一次性观测，不是本基准的组成部分；能复现的是上面的四种配置对比。
按此归因，只有两个可测的候选，且都未采纳：

1. **惰性加载 `js-yaml`**（只在 composition 解析路径使用）。独立进程内 `import('js-yaml')` 冷启动约
   **2.5 ms**，上限收益约 0.2%，而把它移到首次 refresh 会把“解析器不可用”变成晋升期间的失败窗口。
2. **惰性加载 `zod`**（`lib/domain-storage.js` 的领域 schema 校验）。独立进程内 `import('zod')` 冷启动约
   **20 ms**，上限收益约 1.5%；但 schema 在模块作用域构造，延后它要么把校验降级、要么让首次写入才暴露
   加载失败——这是用持久化正确性换 1.5%，不采纳。

两个候选都远低于“显著端到端收益”的门槛，且都需要改动稳定路径的结构，因此本轮**没有性能代码改动**。
`0.2.2-rc.1` 适配本身只改两处字段读取（`Fiber.committed`、`impl.ctx.fiber`），没有新增 I/O、缓存或状态，
不改变本仓库任何既有性能结论；`hmr-off` 与 `hmr-on` 两种形态下 Evolution 的工具路径、提交次数与持久化
内容完全相同。

## 复现

```sh
# 1. 建候选包并完成真实宿主验收（同时留下可复用的隔离 home）
npm run release:pack
node --max-old-space-size=4096 scripts/acceptance/run-host-acceptance.mjs \
  --host 0.2.2-rc.1 --runtime <installed-0.2.2-rc.1-runtime> --no-hmr \
  --work /tmp/accept-022 --out docs/evidence/dsh-0.2.2-rc.1.json

# 2. 用同一个 home 测冷启动（9 轮交替 A/B，原始样本写入 --out）
node --max-old-space-size=4096 scripts/benchmarks/host-startup.mjs \
  --runtime <installed-0.2.2-rc.1-runtime> --home /tmp/accept-022/home \
  --rounds 9 --out docs/performance/host-startup-0.2.2.json
```

基准只读给定 home 的副本（`fs.cpSync` 到临时目录），不会写入它；`--keep` 保留临时目录供检查。
它要求给定 home 的 `web` profile 已选中 `dsh-evolution`，并且 checkout 的
`peerDependencies` 覆盖该 runtime 版本（probe 由 checkout 内的文件加载，官方兼容检查按 checkout 的
`package.json` 判定）。

## 相关材料

- 领域侧吸收与稳态成本：`first-startup-absorption-attribution.md`、
  `first-startup-absorption-save-coalescing.md`、`first-startup-absorption-deferred-archive-index.md`、
  `axis-steady-history.md`（不同宿主与不同夹具，数值不能与本报告的冷启动相加或对比）。
- 兼容与上游阻塞：仓库根 `COMPATIBILITY.md` 的 “The upstream HMR transaction gap on 0.2.2-rc.1”。
- 上游复现与本轮适配证据：`docs/evidence/hmr-022/`。
