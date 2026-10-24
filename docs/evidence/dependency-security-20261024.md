# 2026-10-24 依赖安全证据（Dependabot 与 npm audit）

本记录只覆盖依赖面：`package.json` 与 `package-lock.json` 的改动、对应告警事实、风险判定与本次实际执行过的检查。
未修改版本号、未改动 `release/` 固定点、未提交或推送；包版本仍是 `0.2.0-rc.17`。

## 1. 快照与工具

| 项 | 值 |
| --- | --- |
| 仓库 / 分支 / HEAD | `/Users/ryukeili/GitHub/dsh-evolution`，`main`，`ac84e8b` |
| 本机 node / npm | v26.12.1 / 11.20.0 |
| 默认 registry | `https://registry.npmmirror.com` |
| audit 用 registry | `https://registry.npmjs.org/`（必须显式指定，见下） |

默认镜像没有实现安全公告端点，裸跑 `npm audit` 直接失败，不是"无漏洞"：

```
npm warn audit 404 Not Found - POST https://registry.npmmirror.com/-/npm/v1/security/advisories/bulk - [NOT_IMPLEMENTED] /-/npm/v1/security/* not implemented yet
npm error audit endpoint returned an error
```

因此本文件所有 audit 结论都来自 `npm audit --registry=https://registry.npmjs.org/`。

## 2. GitHub 实际 Dependabot 告警

`gh api "/repos/ryukeilee/dsh-evolution/dependabot/alerts?per_page=100"`（2026-10-24 查询）返回全库 3 条：

| # | 状态 | GHSA | 严重度 | 包 | 声明/范围 | 首个修复版本 |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | **open** | GHSA-6prh-2h8m-c8cw | medium | `@modelcontextprotocol/client` | 要求 `2.2.0`；漏洞 `>=2.0.0, <2.3.0` | `2.3.0` |
| 2 | fixed (`2026-10-07T03:51:34Z`) | GHSA-6qxp-vccf-f47h | high | `@modelcontextprotocol/client` | 要求 `2.0.0`；漏洞 `>=2.0.0, <2.2.0` | `2.2.0` |
| 1 | fixed (`2026-10-07T03:51:33Z`) | GHSA-px8p-9vwx-vf98 | medium | `fflate` | 要求 `0.8.2`；漏洞 `>=0.8.0, <0.8.3` | `0.8.3` |

唯一 open 的一条（本次任务目标）原始字段：

- `ghsa_id`: `GHSA-6prh-2h8m-c8cw`；`cve_id`: `CVE-2026-111769`；`severity`: `medium`
- `manifest_path`: `package-lock.json`；`relationship`: `transitive`；`scope`: `runtime`；`version_requirement`: `2.2.0`
- `created_at`: `2026-10-20T20:17:46Z`；`fixed_at`: `null`；`dismissed_at`: `null`
- advisory `published_at`: `2026-10-20T18:26:30Z`
- `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:L/A:N`（6.5），`CWE-200`
- 同一 advisory 覆盖 `@modelcontextprotocol/sdk < 1.32.0`，但本锁文件中不存在该包，只有 `client`。

截至查询时，下列 3 个包的 advisory 已发布，但 GitHub 上**没有对应告警**（全库仅 3 条，见上表）：
`zod`（advisory 发布于 2026-10-01）、`undici` 与 `fast-uri`（均发布于 2026-10-23）。它们由 npm audit 发现。

## 3. npm audit 基线（修复前）

`npm audit --registry=https://registry.npmjs.org/`：8 条（moderate 6 / high 2）。其中 4 条
`@deepseek-ai/dsh`、`@deepseek-ai/dsh-acp`、`@deepseek-ai/dsh-acp-app`、`@deepseek-ai/dsh-mcp-client`
的 `range` 为 `*` 且没有独立 advisory，是 client 告警沿 peer 树的传播项，不是独立缺陷。

独立根因 4 个：

| 包 | 严重度 | Advisory | 漏洞范围 | 首个修复版本 | 锁中版本 |
| --- | --- | --- | --- | --- | --- |
| `@modelcontextprotocol/client` | moderate (6.5) | GHSA-6prh-2h8m-c8cw / CVE-2026-111769 | `>=2.0.0, <2.3.0` | `2.3.0` | `2.2.0` |
| `zod` | high (7.5) | GHSA-mrhx-c7xc-m3w5 / CVE-2023-54404 | `<4.6.6` | `4.6.6` | `4.6.5` |
| `undici` | high (7.5) | GHSA-xjj6-f33q-929c / CVE-2026-109869 | `>=8.0.0, <8.12.2` | `8.12.2` | `8.11.2` |
| `fast-uri` | moderate (6.1) | GHSA-w74x-v6f9-j3xg / CVE-2026-110306 | `>=3.0.0, <3.1.9` | `3.1.9` | `3.1.8` |

`zod`、`undici`、`fast-uri` 的 ID 与版本范围均以 GitHub Advisory API 返回值为准（`gh api /advisories/<id>`）。
`fast-uri` 另有 3 条同包 advisory（`GHSA-wjr9-j795-jxcr` 4.8、`GHSA-xhq7-xmqj-769h` 3.7、`GHSA-333x-w4r6-6crp` 3.7），
`3.1.9` 同时覆盖这 4 条。

## 4. 传递路径（`npm explain` / `package-lock.json`）

- `@modelcontextprotocol/client`：根 `peerDependencies` 的 `@deepseek-ai/dsh@0.2.0-rc.2` →
  `@deepseek-ai/dsh-mcp-client@0.2.0-rc.2`（对 client 声明的是**精确** `2.0.0`）→ `@modelcontextprotocol/client`。
  同一路径也出现在 `dsh-acp-app → dsh-acp → dsh-mcp-client`。
- `@modelcontextprotocol/core`：只由 client 的精确依赖带出（`client` 2.3.0 声明 `core` `2.3.0`），没有别的请求方，
  所以升级 client 后 core 自动跟随，不需要第二条 override。
- `zod`：根 `dependencies` 精确 `4.6.5`（随包安装，见 `COMPATIBILITY.md` 的 runtime dependencies 一节）；
  宿主各包的 `^4.4.3` 全部 dedupe 到这一份。
- `undici`：`@deepseek-ai/dsh → dsh-http-proxy@0.2.0-rc.2`（`^8.10.0`）与
  `dsh → dsh-base → dsh-web-fetch-http`（`^8.10.0`），锁中只有一份提升副本。
- `fast-uri`：`dsh → dsh-app-boot → ajv@8.20.0`（`^3.0.1`），锁中只有一份提升副本。

本仓库代码不 import 这些包：`grep -rn "modelcontextprotocol|undici|fast-uri" lib/ scripts/ test/` 无命中；
`zod` 只被 `lib/domain-storage.js` 与 `test/domain-storage/aggregate-schema-equivalence.test.js`、
`test/domain-spec.test.mjs` 使用。

## 5. 实际风险

**`@modelcontextprotocol/client`（唯一 open 告警）。** HTTP client transport 与 OAuth 请求会跟随跨源重定向，
把自定义请求头（`requestInit.headers` 里的 `X-API-Key` 之类）与 `mcp-session-id` 交给另一源；`307`/`308`
还会重发请求体，包括带 `refresh_token` / `client_secret` 的 OAuth 请求。stdio client 不受影响。
本仓库不含该 transport 的使用点，暴露面在 DSH 宿主的 MCP 配置（HTTP/SSE server + 凭据）。
另外 npm `overrides` 只对**根**安装生效，不会随包传播到使用方的 profile，所以这条修改保护的是本仓库的
仓库 npm 安装与 CI 单测依赖树，不改变终端宿主实际解析到的 client 版本。验收脚本另建 runtime 根执行
`pnpm install`，随后通过 CLI 添加 bundle，不继承仓库根 override。官方 npm 元数据实查：
`dsh-mcp-client@0.2.0-rc.2`、`@0.2.1-alpha.1` 精确依赖 client `2.0.0`，`@0.2.1-rc.2` 精确依赖
`2.2.0`，三者均低于 `2.3.0`；终端侧仍需上游 DSH 更新依赖，本轮不修改官方包。

**`zod`（direct，high，随包安装）。** 校验超大受约束集合时可耗尽内存（CWE-770）。这是本组里唯一进入
分发清单引用的直接依赖，因此即使没有 GitHub 告警也按实质缺陷处理。4.6.6 将已声明的 `.max()` /
`.length()` / `.size()` 上限检查提前，避免先逐项校验全部元素；没有声明上限的容器仍逐项校验。
`archiveFilesSchema` 当前是没有 `.max()` 的数组，升级不为该路径新增容量边界，也不证明任意恶意磁盘输入
不会耗尽资源。本轮修复已知依赖漏洞，不把升级描述为通用内存沙箱，亦不将它归为历史 OOM 的已证实根因。

**`undici`（high，dev/peer 树）。** 处理过量 `content-encoding` 时未捕获错误导致 DoS（`CWE-248`/`CWE-459`），
另有 EventSource 无界内存与 SRI 大小写绕过两条 moderate。只存在于宿主的 http-proxy / web-fetch 链路，
插件自身不发起这些请求。

**`fast-uri`（moderate/low，dev/peer 树）。** URI scheme 欺骗、WHATWG host 规范化不一致等，需要恶意 schema
引用或输入才能触发；经由 `ajv` 的配置校验路径，不在插件的运行时路径上。

## 6. 修复（最终 package/lock，已固定）

`package.json` 两处：

```diff
   "dependencies": {
     "js-yaml": "^4.2.0",
-    "zod": "4.6.5"
+    "zod": "4.6.6"
   },
   "overrides": {
     "@deepseek-ai/dsh-mcp-client": {
-      "@modelcontextprotocol/client": "2.2.0"
+      "@modelcontextprotocol/client": "2.3.0"
     },
```

`package-lock.json` 只有 5 个条目变化（40 行 diff）：

| 包 | 版本 | integrity | 备注 |
| --- | --- | --- | --- |
| `@modelcontextprotocol/client` | `2.3.0` | `sha512-pbHtGj6EeFCHngFE8gtNPaKrsj8Mb1IMw45BLcaPML/m2WTxI7pyYmeNQvaux88Lw8BSO5r7nyRbUyIkICmGrg==` | license `MIT` → `Apache-2.0`；deps 变为 `core 2.3.0`、`eventsource-parser ^3.0.8` |
| `@modelcontextprotocol/core` | `2.3.0` | `sha512-09BHFaNVBe5pB2AhzCfLj0cqmsKLERvZQ4FblzP90UMGLaXVqdZPByFjURwsUYCmxonUW2yAwgTTvle+8O2/8w==` | license `MIT` → `Apache-2.0` |
| `zod` | `4.6.6` | `sha512-4UmzQUF5fxvfcYHlbjBmejU+w+hbDnWFx4aS8kBx7nPBHcO2SqPbpAG8snbdg+Xse4pRefR98hgjFgIMCI/UhA==` | 根 `dependencies` 同步 |
| `undici` | `8.12.2` | `sha512-XtuDWVdqTLr3NAxm2ly9/hU6kUsJOgGh1RASzMBbsw6aWCOaQzHdW+QQDfdERjfJ2V5vL5pRPa4RetO9UfivDg==` | `engines.node >=22.19.0` |
| `fast-uri` | `3.1.9` | `sha512-hS/0Wt3Ya043oKXs0sIxrMpKQITXhMLIrVAKKXi4gozGC9v7YRWVnXIZzjNPTO02M9BdxLCWqK1yRXgNziVyJQ==` | |

`eventsource-parser` 的请求范围从 `^3.0.0` 变为 `^3.0.8`，锁中已有的 `3.1.1` 已满足，条目未变。

来源与摘要核对：

- `resolved` 不变更来源主机。`client` / `core` 保持 `https://registry.npmjs.org/...`（与 HEAD 同一官方主机，只有版本号变化）；
  `zod` / `undici` / `fast-uri` 保持 HEAD 既有的 `https://registry.npmmirror.com/...`，本次没有把镜像来源变更混入安全修复。
- 上表 5 个 `integrity` 与官方 `dist.integrity` 逐一比对一致
  （`npm view <pkg>@<ver> dist.integrity --registry=https://registry.npmjs.org/`）：
  `client 2.3.0`、`core 2.3.0`、`zod 4.6.6`、`undici 8.12.2`、`fast-uri 3.1.9` 全部相同，无一项来自镜像的独立摘要。

## 7. 版本选择规则与官方约束

- 规则：取 advisory 指定的**首个修复版本**——`client 2.3.0`、`zod 4.6.6`、`undici 8.12.2`、`fast-uri 3.1.9`。
  没有升级到 `client 2.4.0`、`zod 4.6.7`（后者发布记录中只有版本提交，无代码变更）或 `undici 8.12.3`
  （advisory 之后的普通补丁），因为修复证据不要求。
- `@deepseek-ai/dsh-mcp-client@0.2.0-rc.2` 对 client 声明的是精确 `2.0.0`，不改宿主包就只能用 `overrides`
  才能落到修复版本；这与告警 #2（`2.0.0 → 2.2.0`）是同一先例，不是新增机制。
- 兼容性证据：
  - client `2.3.0` / core `2.3.0` 的 `engines.node` 为 `>=20`；undici `8.12.2` 为 `>=22.19.0`；
    `package.json#engines` 是 `^22.19.0 || >=24.0.0`，两者都覆盖。
  - 宿主包对 `zod` 声明 `^4.4.3`，`4.6.6` 在其中；升级后仍是单副本 dedupe。
  - 宿主对 `undici` 声明 `^8.10.0`，对 `fast-uri` 声明 `^3.0.1`，修复版本都在范围内，未新增 override。
  - `peerDependencies`、`devDependencies`、`engines`、`version` 均未改动；`@deepseek-ai/dsh` 宿主范围不变。
- 许可证：client/core 由 `MIT` 变为 `Apache-2.0`（dev/peer 树，不进入 tarball）。

## 8. 本次实际执行的验证

| 检查 | 结果 |
| --- | --- |
| `npm install --ignore-scripts`（应用改动） | `changed 3 packages`，无其余条目变化 |
| `npm ci --ignore-scripts`（最终 lock，权威安装） | `added 537 packages in 4s`，退出 0 |
| `npm ls @modelcontextprotocol/client @modelcontextprotocol/core` | `client@2.3.0 overridden` → `core@2.3.0`，无 `invalid`/`UNMET` |
| `npm ls ... zod undici fast-uri --all` | `zod@4.6.6` 全量 dedupe；`undici@8.12.2`；`fast-uri@3.1.9`（经 `ajv@8.20.0`） |
| 官方 `dist.integrity` 核对 | 5/5 一致（见 §6）；`client`/`core` 的 `resolved` 仍为 `registry.npmjs.org` |
| `npm audit --registry=https://registry.npmjs.org/` | `found 0 vulnerabilities`（修复前为 8 条） |
| `node --max-old-space-size=4096 --test test/domain-storage/*.test.js test/domain-spec.test.mjs test/domain-input-manifest-version.test.mjs` | 135 项，135 通过，0 失败，15.3 s（覆盖 `zod` 的使用点） |
| `npm run pack:check` | 除 "this tree is the pinned release, or a committed successor of it" 外全部 ok；该失败仅因本工作区的分发改动未提交（content `0b02a9f0b5ab2ed1c1e4ed19f4f6d0a6e1c433684cda4e96c030aae0655511e9` vs HEAD `25ef8dc3…`）。`package-lock.json matches package.json` 通过。 |

父协调在候选快照 `910f14e` 上另有：Node 22.23.4 / 24.22.1 全量各 896/896、`pack:check` 通过、三个隔离宿主各
21 步通过。那一轮的分发内容摘要同样是 `0b02a9f0…`（`package.json` 与本文件记录的最终状态一致），但其锁文件中
`undici` 解析为 `8.12.3`；本文件把最终 lock 固定为 advisory 指定的 `8.12.2`，因此该轮不是最终 lock 的验证，
最终候选仍需重跑（见 §9）。这些数字由父协调提供，不是本文件执行的结果。

## 9. 与固定点、发布的关系

- `package.json` 是分发包内容，依赖改动后的中间工作树内容摘要为 `0b02a9f0…`，`release/manifest.json` 仍固定
  rc.17 的 `fb4e77b5…`。默认 `pack:check` 允许已提交的固定点后继；严格的 `pack:check -- --release` 才要求
  内容等于固定点。更新固定点需要独立发布流程，不是本轮开发检查通过的前提；本轮不执行 `release:publish`。
- `test/release-pin.test.mjs` 的 "committed successor" 判定在未提交工作树里必然失败；提交后按同一判定通过
  （父协调的候选快照已验证）。

## 10. 残留

- npm audit：0 条。
- Dependabot：`#3` 在本工作区仍为 `open`；告警只会在锁文件落到默认分支、GitHub 重新解析依赖图后转 `fixed`
  （本轮未推送）。
- 未做：宿主验收、版本推进、固定点更新、提交与推送。
- 未把三个官方宿主的 client `2.0.0` / `2.0.0` / `2.2.0` 当作已修复：终端宿主的 client 版本仍由上游 DSH
  决定，本仓库只固定自己的 npm / CI 单测依赖树；隔离宿主验收成功不等于宿主依赖漏洞已消除。
