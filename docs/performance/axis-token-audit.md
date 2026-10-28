# Evolution 上下文与工具渲染字节调查

本次源提交：`5a728dd8edb0021d65bc8672bb81557abc1c5e36`；Node `v26.12.1`。只读调查，未修改运行实现、测试、发布文件，未提交或推送。所有执行状态来自 `/tmp/axis-token-*` 合成夹具，运行结束清理。原有工作树未跟踪文件未动。

所有字节均为本次实际执行得到的 UTF-8 字节数。所有 token 都是 **字节 ÷ 3.6 的估算**，没有调用 tokenizer 或供应商计费接口；英文、中文、数字、空白的真实 token 比率会不同。这里测量工具返回文本的 token 等价值，不能据此认定供应商把它计为模型 completion 输出；工具结果通常进入后续模型请求。

## 每请求固定部分

通过真实 `apply()` 捕获 `systemPrompt.section` 与 10 次 `tools.register`，使用编译后的 parameters JSON Schema；不是手工重抄 author spec。parameters 按紧凑 `JSON.stringify` 计字节，包含字段内 description。下表 description 为独立的工具顶层说明。

| 注入项 | name 字节 | description 字节 | description token 估算 | parameters JSON 字节 | parameters token 估算 |
|---|---:|---:|---:|---:|---:|
| evolution_doctor | 16 | 381 | 105.83 | 285 | 79.17 |
| evolution_history | 17 | 268 | 74.44 | 459 | 127.50 |
| evolution_maintain | 18 | 669 | 185.83 | 673 | 186.94 |
| evolution_runtime_inspect | 25 | 136 | 37.78 | 33 | 9.17 |
| evolution_propose | 17 | 74 | 20.56 | 573 | 159.17 |
| evolution_trial | 15 | 128 | 35.56 | 481 | 133.61 |
| evolution_measure | 17 | 85 | 23.61 | 901 | 250.28 |
| evolution_revert | 16 | 121 | 33.61 | 93 | 25.83 |
| evolution_promote | 17 | 350 | 97.22 | 287 | 79.72 |
| evolution_canary_observe | 24 | 173 | 48.06 | 512 | 142.22 |
| 合计 | 182 | 2385 | 662.50 | 4297 | 1193.61 |

`systemText`（含模板首尾换行）实测 **2852 字节**，估算 **792.22 token**。字段内容合计 `2852 + 182 + 2385 + 4297 = 9716` 字节，估算 2698.89 token。

另给一个明确的计量包装：`systemText + JSON.stringify([{name,description,parameters}, ...])`。工具数组 7295 字节（比工具字段内容多 431 字节，包含键名、括号、引号、分隔符及字符串转义），总计 **10147 字节，估算 2818.61 token/请求**。未抓取正式 provider 请求；宿主 system section 的标题/分隔符、function 包装、消息 role、provider 转换、缓存折扣均不包含在这个口径内，不能把该数称为真实网络请求总量。

## 每调用结果：实测

降幅 = `(pretty - compact) / pretty`，即 pretty 总文本中可去除的格式空白占比，包含换行、缩进与冒号后空格。键数累计所有对象的自有键，不含数组索引；深度从根 0 起算，包含叶值。

| 场景 | pretty 字节 | compact 字节 | 减少字节 | 降幅 | token 估算 pretty → compact | 键数 | 最大深度 |
|---|---:|---:|---:|---:|---:|---:|---:|
| inspect-candidates-0 | 1089 | 751 | 338 | 31.04% | 302.50 → 208.61 | 41 | 6 |
| inspect-candidates-10 | 8813 | 4739 | 4074 | 46.23% | 2448.06 → 1316.39 | 261 | 6 |
| inspect-candidates-100 | 36803 | 22019 | 14784 | 40.17% | 10223.06 → 6116.39 | 981 | 6 |
| history-empty-default | 129 | 112 | 17 | 13.18% | 35.83 → 31.11 | 4 | 1 |
| history-default-seeded | 129 | 112 | 17 | 13.18% | 35.83 → 31.11 | 4 | 1 |
| history-observations-10 | 1978 | 1538 | 440 | 22.24% | 549.44 → 427.22 | 44 | 3 |
| history-query | 3766 | 2863 | 903 | 23.98% | 1046.11 → 795.28 | 103 | 4 |
| doctor-empty-home | 21726 | 15734 | 5992 | 27.58% | 6035.00 → 4370.56 | 442 | 7 |
| propose | 4790 | 3405 | 1385 | 28.91% | 1330.56 → 945.83 | 129 | 5 |
| measure | 1427 | 1052 | 375 | 26.28% | 396.39 → 292.22 | 49 | 4 |
| measure-json-string-evidence | 1942 | 1567 | 375 | 19.31% | 539.44 → 435.28 | 49 | 4 |

生成依据与边界：

- inspect：复用 `test/runtime-inspect.test.mjs:61` 与 `test/fixtures/runtime-inspect.mjs` 的 context/populate。实际执行已注册 inspect；分别为空状态、20 条 observations + 10 candidates、20 条 observations + 100 candidates。工具注册表沿用原夹具，只有 fixture schema，并非完整正式宿主注册表；100 candidates 是已有测试的压力形状，不能认定为生产常态。
- history：复用 `test/retention-boundary-worker.mjs:16` 的官方 DomainFacility + JsonStorageBackend；先生成 12 条签名 measurement 事件并 replay。默认 collection 是 cycles，因没有 cycle，empty/default-seeded 都返回 count=0。随后经真实 port.observe 写入 12 种不同错误 DTO（未读取真实日志），observations 查询 count=12、返回 10 条元数据。query 路径通过真实知识聚合与 recall，返回 3 条 failure，limit=5 被现有 maxEntries=3 收紧。没有用空结果冒充有记录的查询。
- doctor：`test/diagnostics.test.mjs:186` baseOptions 模式，真实 `collectDiagnostics` 经注册工具调用。临时空 home，缺宿主/未安装状态；不是 healthy production 的分布。清空该进程 PATH/DSH_CLI 搜索，关闭 composition probe，不调用修复。诊断只读取仓库包元数据及临时 home。
- propose：真实注册调用，包含运行时签名与上述知识召回。measure：真实 propose → trial → measure；runner 模拟 define/run 成功，模式参考 `test/trial-recovery-boundary.test.mjs:18`，没有实际运行动态宿主代码或晋升。
- 每个表行是一次返回的结构分布，不是生产采样的分位数或均值。UUID、日期及 /tmp 随机路径可能使重跑字节轻微变化；本 JSON 保留了这次完整合成 DTO，可对原值重新计算。

字符串证据形状：`measure-json-string-evidence` 的 benefitEvidence 是包含 6 个采样对象的 pretty JSON 字符串，cleanupEvidence 含换行；返回有 2 个含真实换行的字符串、1 个可解析 JSON 字符串。外层序列化会把其中换行转为 `\n`，两种渲染均原样保留字符串内的空格和换行。它与普通 measure 均只减少 375 字节，但总分母增大，降幅从 26.28% 降至 19.31%。没有递归压缩字符串化 JSON，因为那会改字符串值。

## 重复内容核查

下列行号均指 `lib/registration.js`。未发现完整生命周期段落逐字写两遍；发现生命周期事实的复述，以及较短的逐字重合片段。语义重复没有唯一的可相加字节定义，故下面给出两侧实际块大小，**不把整块字节认定为可去掉的重复字节**，也不建议删改文案。

| 共同内容 | systemText 行与块字节 | description 行与块字节 |
|---|---|---|
| inspect → propose → trial → measure → revert/promote，canary 屏障与回滚 | 70–84，1028 字节 | inspect 306（136）、propose 317（74）、trial 341（128）、measure 348（85）、revert 378（121）、promote 385（350）；六项合计 894 字节；canary 395（173）另有相同屏障事实 |
| 按需召回已解决问题、失败方法、候选策略 | 91–98，619 字节 | history 274，268 字节 |
| 容量回收、确认、证据外置、遇冲突拒绝 | 100–109，754 字节 | maintain 287，669 字节 |

为避免语义“重复量”任意化，脚本还扫描原始文本两侧所有 ≥24 字符的最大连续逐字重合片段（不消除换行、不忽略大小写；可从词中间起止）。本次得到以下 8 段，两侧均不相交，合计 **272 字节/侧**；这是该阈值下的字面结果，不是全部语义冗余量。

| 工具 | 逐字片段（包括边界空格） | 字节 | system 行 | description 行 |
|---|---|---:|---|---|
| evolution_history | `already-resolved problems, approaches` | 37 | 94 | 274 |
| evolution_history | ` measured candidate strategies` | 30 | 95 | 274 |
| evolution_maintain | ` real call requires confirmation: true` | 38 | 102 | 287 |
| evolution_maintain | `ed prefix of the authenticated event log` | 40 | 104 | 287 |
| evolution_maintain | `: unreadable or conflicting archive` | 35 | 106 | 287 |
| evolution_maintain | `evidence, a pending transaction` | 31 | 107 | 287 |
| evolution_maintain | ` without discarding anything. ` | 30 | 108 | 287 |
| evolution_trial | `efine and activate a temporary ` | 31 | 74 | 341 |

## 会话量级：条件估算

固定注入按模型请求次数 R 线性累计：字段口径 `9716 × R` 字节；上述标准包装口径 `10147 × R` 字节。单次工具调用不必对应单次请求（一个回复可并行调用多个工具），一次用户轮次也可能触发多个模型请求。

| 条件假设 | 固定字段字节 | 标准包装字节 | 标准包装 token 估算 |
|---|---:|---:|---:|
| 50 次工具调用，每次对应 1 次带全部工具的模型请求，即 R=50 | 485800 | 507350 | 140930.56 |
| 200 轮对话，每轮恰好 1 次带全部工具的模型请求，即 R=200 | 1943200 | 2029400 | 563722.22 |

50 次顺序调用若还需一次最终总结请求，则 R=51：标准包装 517497 字节、估算 143749.17 token。实际 R 未测，不能从“50 次工具调用”推出唯一累计账单。这里未累计历史工具结果在后续上下文中的重复输入；这需要实际上下文保留/裁剪记录，也未估计价格或延迟收益。

## 信息等价与消费方

每个样本均执行三项断言：现有 render 等于 pretty stringify；两者 JSON.parse 后 deepEqual；pretty 解析后再紧凑序列化与 compact 逐字相等。所有断言通过，改变仅发生在 JSON 字符串外的格式空白。未更改字段、键顺序或字符串内空白。

本机已安装 `node_modules/@deepseek-ai/dsh-tools/lib/index.js:3541–3573` 的 createSuccessResult 先 snapshot/validate/freeze structured value，再调用 output.render，随后分别保留 value 与 content；该路径没有按缩进解析返回文本。仓库 lib/test/验收脚本检索也未发现依赖此 renderer 缩进的消费逻辑。**这只是所读路径的证据**：未对所有宿主版本/UI/外部文本消费者做集成验证，依赖逐字快照、行号或 Markdown 展示的外部消费者仍可能观察到变化。JSON 数据等价已验证，所有消费方行为等价未证明。

## 三条结论

1. **(a) 紧凑渲染的实测字节降幅**：inspect 31.04%–46.23%；history 无 query 空结果 13.18%、有 10 条元数据 22.24%，query 有召回 23.98%；doctor 空 home 27.58%；propose 28.91%；measure 普通证据 26.28%、JSON 字符串证据 19.31%。多数非空样本减少约两至四成，值得作为具体收益证据；不能外推为正式会话统一比例，也未测 tokenizer、耗时或费用。
2. **(b) 固定开销量级**：字段实测 9716 字节/请求；声明的标准包装 10147 字节/请求，约 2.82k token（估算）。R=50 约 141k、R=200 约 564k token（估算）。紧凑结果渲染不改变这部分固定注入。
3. **(c) 等价性风险**：所有样本 JSON 信息完全等价，包括字符串内换行和字符串化 JSON；本机 registry 路径未见缩进依赖。外部按文本格式消费的行为未验证，不能宣称零兼容风险。

## 复现与产物

```sh
node --max-old-space-size=4096 scripts/benchmarks/axis-token-audit.mjs > /tmp/axis-token-audit.json
```

脚本只在 /tmp 创建并清理夹具，stdout 输出 JSON；不会自动覆盖本次证据。内部断言即本次必要验证；没有运行全量测试、真实宿主验收或发布校验，也未声称这些检查通过。

- `scripts/benchmarks/axis-token-audit.mjs`：复现脚本。
- `docs/performance/axis-token-audit.json`：本次逐项统计、完整注册字段、完整合成返回值、重复文本行号。
- `docs/performance/axis-token-audit.md`：本简报。
