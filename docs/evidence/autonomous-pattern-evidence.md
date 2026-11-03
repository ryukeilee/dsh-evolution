# 故障模式证据窗口被无关故障挤出：优化前后对照

本轮唯一保留的改动。目标是修掉自治循环**第一阶段**（故障识别）的一个静默失效：模式累计会被与它
无关的观测挤掉，于是缓慢复发的故障永远到不了 `patternThreshold`，策略、隔离 Trial 与测量整条链
根本不会启动。

## 问题

`observeAutonomous` 统计一个故障模式的出现次数，用的是 `autonomousObservations()`：一份**整张观测
集合**最近 200 行的尾部。每一行都是一次失败的工具调用或一个 provider 错误（无论属于哪个模式），因为
`projectObservation` 对自主观测总是 `forceRecord`，重复发生不会被去重。

改动前这段代码用这份尾部**替代**了本 session 自己的按模式窗口：

```js
let observations = this.patterns.get(patternKey) || [];
...
observations = this.domainStorage.autonomousObservations().filter(row => row.patternKey === patternKey);
```

后果是可判定的：一个已经持久提交过两次发生的故障，在有 200 行以上无关故障插在中间时，第三次观测
得到 `occurrences: 1`，`this.patterns` 里它自己的那两行同时被这份尾部覆盖掉。计数**倒退**，阈值永不
达成。受影响的恰好是“罕见但会复发”的故障——那也是自主循环最值得修的一类；密集复发的故障会用自己的
行填满尾部，所以旧行为在那种情况下看起来正常。

`patternKey` 只归一化带标签的耗时（`after N ms`），其它数字参与身份，因此不同根因、不同工具的失败
彼此是不同模式，它们的行共同争夺同一份 200 行尾部。

## 改动

两半是**并集**，不再是替代：

- 存储仍为这个精确身份保留的行（`autonomousObservations()`，跨重启的那一半）；
- 本 session 已经计入的该身份的行（`this.patterns`，内存里的那一半）。

按两半共享的 `observationId` 去重（`projectObservation` 就是用这个 id 落库），所以同一次发生在两半里
只算一次；行按 `at` 升序返回，因为任一半都可能缺对方有的一段。当前这次发生也显式放进并集：端口若回答
了过期尾部，本次调用也不会丢掉自己的事件。

未改动：每个模式仍只保留窗口内最近 `patternThreshold` 行（`this.patterns` 的内存占用不变，仍受
`AUTONOMOUS_PATTERN_CAP` 的模式数上限约束）；跨重启仍以存储保留的最近 200 个观测为界；观测仍然先提交
再计数；读取次数不变；没有新增持久 schema、定时器、后台读取或额外提交。阈值、策略选择、风险分级、
隔离 Trial、测量门禁、失败学习、所有者确认与晋升权威全部不变。

## 可复现的前后对照

新增的 `test/autonomous-pattern-evidence.test.mjs` 在两个代码版本上跑同一份文件（改动前的树是
`main` `47fee8e`）：

```sh
git worktree add /tmp/dsh-prefix 47fee8e
ln -s "$PWD/node_modules" /tmp/dsh-prefix/node_modules
cp test/autonomous-pattern-evidence.test.mjs /tmp/dsh-prefix/test/
(cd /tmp/dsh-prefix && node --max-old-space-size=4096 --test test/autonomous-pattern-evidence.test.mjs)
node --max-old-space-size=4096 --test test/autonomous-pattern-evidence.test.mjs
```

| 代码 | 结果 |
| --- | --- |
| `47fee8e`（改动前） | 4 项中 2 项失败：阈值用例与过期尾部用例都是 `actual: 'pattern-observing'` 而非 `'candidate-awaiting-confirmation'` |
| 本分支 | 4 项全部通过 |

两项通过的是“同一次发生在两半里只算一次”和“重启后仍由存储那一半回答”，即并集没有引入重复计数，
跨重启语义没有变化。

阈值用例的场景是真实 session 的形状：同一故障观测两次 → 120 个不同模式各观测两次（240 行，越过 200
行尾部，同时仍在 200 个模式的上限内）→ 第三次观测同一故障。改动前 `autonomousObservations()` 里这个
模式只剩 1 行（本次），改动后并集有 3 行，直接给出 `candidate-awaiting-confirmation` 与 3 个互不相同的
`observationIds`。用例同时钉住重启边界：重启后本 session 那一半不存在，只有存储仍保留的发生被计入
（`occurrences: 2`），掉出尾部的两次不重建、不猜测。

## 本轮验证

| 检查 | 结果 |
| --- | --- |
| `NODE_OPTIONS=--max-old-space-size=4096 npm test` | 1373 项中 1372 通过，唯一失败是提交前的 `release-pin`（工作树未提交）；提交后该文件 10/10 通过 |
| 聚焦套件（新用例 + 4 个既有自主套件 + 观测/失败记忆/质量整合） | 90/90 通过 |
| `npm run pack:check` | 16 项通过，判定为固定点的已提交后继 |
| 三宿主真实安装验收 | 每宿主 21/21 步通过（证据见下） |

本地产物 `dist/pattern-evidence/dsh-evolution-0.2.0.tgz`：sha256
`0cc7adadd9ec2828c6001130e8169ed4b9b789a1a045dfd59c40912cf3b69d16`，内容摘要
`dc9c90a5269fdcb039bb802213252db283089978093d496b98e01143f0fcc120`（51 个条目）。三宿主使用
同一份产物、隔离 runtime/home **串行**验收（避开历史上 alpha `lifecycle-disable` 的抖动）：

| 宿主 | 结果 | 证据 |
| --- | --- | --- |
| `0.2.0-rc.2` | 21/21 ok | `docs/evidence/pattern-evidence-0.2.0-rc.2.json` |
| `0.2.1-alpha.1` | 21/21 ok | `docs/evidence/pattern-evidence-0.2.1-alpha.1.json` |
| `0.2.1-rc.2` | 21/21 ok | `docs/evidence/pattern-evidence-0.2.1-rc.2.json` |

没有更新 `release/` 固定点、没有重新发布、没有改版本号：这是 `0.2.0` 固定点的开发后继。

## 边界与剩余风险

- **跨重启仍有 200 行界。** 一个模式的两次发生分别落在重启两侧、且中间写入了 200 行以上无关观测时，
  存储尾部已不含旧发生，该模式从仍保留的那些重新累计（用例明确钉住这一点）。这不是本轮引入的，也
  没有用猜测性合并去“补齐”：那会让不同根因共享计数。
- **模式表上限仍是 200 个模式。** 超过 200 个不同模式时 `pruneAutonomousPatterns` 会淘汰最老的窗口
  （既有行为，注释里写明“淘汰只意味着该模式重新计数”）。我用 210 个不同模式复现过：那种情况下并集
  同样救不回被淘汰的窗口。本轮没有改动这个上限，因为它同时是内存上界。
- **另一个已知的自治循环限制，本轮未改。** 运行时被其它实验占用时的失败（`E_EVOLUTION_RUNTIME_BUSY`、
  target claim 冲突、操作忙等）会 `suppressForSession` 该假设：一次环境类冲突之后，这个假设在本
  session 内不再被尝试，后续观测报 `suppressed` / `reason: "duplicate-failure"`，即使占用它的
  `measured` 候选随后被所有者 revert、运行时已经空出来。复现：同一 session 里让两个低风险模式都达到
  阈值，第一个到 `measured` 后 `revert` 它，第二个模式的后续观测仍是 `suppressed`。这是 README
  明确写下的策略（“环境失败不写持久判定，只在本 session 内抑制对应假设”），改动它属于放宽既有抑制
  策略，需要单独的取舍与验证，因此本轮只如实记录，不做。
- 本轮没有改 trial/teardown、跨进程锁、CAS、journal、canary 或启动恢复，所以没有为它们另写宿主机
  探针；三宿主 21 步验收（含 `core-flow` 与 `promotion-restart-and-rollback`）已覆盖这些路径的回归。
