# 并发 npm pack 测试资源隔离实测

## 口径与环境

数据来自 `npm-pack-isolation.json`，由 `scripts/benchmarks/npm-pack-isolation.mjs --full --write` 本次实际运行生成。所有实验根目录均由 `os.tmpdir()` 创建，并检查在用户 home 之外；子进程的 `HOME`、npm user/global config、临时目录、cache 与 logs 均重定向到实验临时树。没有使用或写入用户的 `~/.npm`。

环境：Node `v22.23.4`、npm `10.9.9`、macOS Darwin `27.0.0`、Apple M2、arm64。Node 命令和子进程均设置 `--max-old-space-size=4096`（子进程通过 `NODE_OPTIONS` 继承）。未在本轮用 Node 24 采样。

A/B 使用同一组 12 个最小 npm 包 fixture，每包含 `package.json` 与 `index.js`；每轮每臂启动 12 个**独立 npm 子进程**并发执行 `npm pack --json --ignore-scripts`，共 3 轮。每轮两臂先后运行，臂顺序逐轮交替。计时从启动 12 个子进程前开始，到最后一个进程退出为止，不含目录扫描。目录统计覆盖 npm cache 与 logs 的普通文件总数、字节数，不含 fixture 和 `.tgz` 输出。`之前 → 之后` 展示累计值。

## A/B：共享状态与每进程私有状态

| 轮次 | 环境 | 成功/失败 | 墙钟 ms | cache + logs 文件数 | cache + logs 字节数 |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | 共用 cache/logs | 12/0 | 1285 | 0 → 35 | 0 → 25023 |
| 1 | 每进程私有 | 12/0 | 1697 | 0 → 36 | 0 → 28868 |
| 2 | 共用 cache/logs | 12/0 | 707 | 35 → 35 | 25023 → 31247 |
| 2 | 每进程私有 | 12/0 | 712 | 36 → 72 | 28868 → 57736 |
| 3 | 共用 cache/logs | 12/0 | 647 | 35 → 35 | 31247 → 33544 |
| 3 | 每进程私有 | 12/0 | 622 | 72 → 108 | 57736 → 86604 |

总计两臂各 36 次 pack，均为 36 成功、0 失败。共享臂三轮结束时为 35 个文件、33544 字节；私有臂为 108 个文件、86604 字节。私有臂每次启动都由 `createPrivateNpmEnv(fixtureRoot, inherited)` 创建新的 cache/logs 路径，所以它保留了每个 npm 进程的独立状态，也累积了更多重复 cache 数据。墙钟在轮次间有变化（共享 1285/707/647 ms，私有 1697/712/622 ms），本实验不支持速度收益结论。

## 污染位置证据

| 臂 | 实际传给 npm 的 cache/logs | 运行前后观察 | 结论 |
| --- | --- | --- | --- |
| 基线 | `临时根/shared-cache/shared/{cache,logs}`，12 个子进程共同使用 | 第 1 轮从 0 文件增长到 35；三轮末 35 文件、33544 字节 | 确认写入共享临时目录 |
| 候选 | `临时根/private-per-process/fixtures/fixture-*/.npm-private/<pid-uuid>/{cache,logs}`，每个子进程独有 | 第 1 轮 36 文件；三轮末 108 文件、86604 字节 | 确认写入 fixture 私有目录，所有 cache/logs 路径均位于对应 fixture 的 `.npm-private` 下 |

两臂所有子进程的 home 都被重定向；npm user/global config 指向临时空配置文件。污染统计针对 npm 的 cache 与 logs，pack 输出 tarball 单独放在临时输出目录。

## C：只读共享目录失败模式

对临时共享 cache 与 logs 执行 `chmod 555` 后，用其中同一个 fixture 再跑 `npm pack`。本机复现结果：npm 返回 `EACCES`、`syscall=mkdir`、目标 basename 为 `_cacache`，进程退出码 `243`。恢复目录权限后，同一个 fixture 使用 `createPrivateNpmEnv` 再跑成功，退出码为 `0`，其 cache/logs 都位于 fixture 私有目录。脚本在 `finally` 中恢复权限。

这证明只读共享状态是一个可复现失败模式；它不代表普通可写共享 cache 会失败。

## D：五文件并发回归

每次只调用一次 Node 22 `--test`，同时传入下列五个文件，并用 `--test-concurrency=5` 显式并发调度五个文件。重复 3 次，每次独立启动 Node 22 进程并带 4 GiB 堆上限。

| 轮次 | `# pass` | `# fail` | 墙钟 ms | 退出码 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 70 | 0 | 13206 | 0 |
| 2 | 70 | 0 | 11732 | 0 |
| 3 | 70 | 0 | 11705 | 0 |

文件列表：

- `test/release-archive-header-integrity.test.mjs`
- `test/release-build-boundary-regressions.test.mjs`
- `test/release-build-boundary-round6.test.mjs`
- `test/release-build-boundary-round7.test.mjs`
- `test/release-integrity-pack-dist-ownership.test.mjs`

## 复现命令

默认运行 A/B 小规模采样（12 个包、3 轮），JSON 输出到 stdout：

```sh
/opt/homebrew/opt/node@22/bin/node --max-old-space-size=4096 scripts/benchmarks/npm-pack-isolation.mjs
```

运行 A/B、C、D 全部实验，并把完整 JSON 写入本文件旁的 `npm-pack-isolation.json`，同时仍输出到 stdout：

```sh
/opt/homebrew/opt/node@22/bin/node --max-old-space-size=4096 scripts/benchmarks/npm-pack-isolation.mjs --full --write
```

## 收益与边界

- 本机在共享 cache 下也未复现失败：12 个并发 pack、3 轮全部成功。不能据此声称共享 cache 不稳定，也不能声称私有 cache 消除了普通并发下的不稳定性。
- 已验证的收益是测试资源位置可控：基线确实写入共享临时 cache/logs；候选确实把每个 npm 进程的 cache/logs 放进对应 fixture 的私有目录，便于随 fixture 清理，并避免不同 fixture 共用这些状态目录。
- 只读 cache/logs 的 `EACCES` 失败模式在本机复现，私有目录让同一 fixture 成功。这是具体故障边界的证据，不是对所有 npm 环境、文件系统或权限问题的保证。
- 私有目录有空间成本：本次 12 包、3 轮观察到 86604 字节，约为共享臂 33544 字节的 2.58 倍；其中包括每个子进程新建的独立 cache 与 logs。测得墙钟有波动，不能据此得出性能提升。
- 数据只覆盖本机 macOS、Node 22.23.4/npm 10.9.9、小型无依赖 fixture，以及指定的五文件测试集合；未覆盖 Node 24、其他平台、网络依赖或更大并发规模。
