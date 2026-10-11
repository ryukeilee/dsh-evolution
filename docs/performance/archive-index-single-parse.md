# Archive index 单次解析

本轮只让活动 archive 的索引字段和去重键共用一次分行 / JSON 解析。
基线为 `release/dsh-evolution-0.2.0-rc.7.tgz` 中的完整
`lib/dockyard-domain/memory.js`，SHA256
`58a75e35fc4f7aed780fc63314420adc2bfd9bfc13909252b26ca0f4e058f0d8`。
`test/dockyard-domain/archive-index-baseline.js` 对当前源码精确逆向重建，
并断言重建与固定产物逐字节一致；将来产物含共享解析时，仍使用带形状断言的重建。
两种实现使用当前树中同一组依赖，所有数据位于 `os.tmpdir()`。
原始逐次样本（含预热）、源码哈希、环境与每轮统计见
[`archive-index-single-parse.json`](archive-index-single-parse.json)。

## 负载与环境

- 20,000 条 journal 记录，每条有唯一 id、固定 recordedAt 和 64 字符 details；
  另有非法 JSON、纯空白和截断行，总计 3,228,913 字节。
- 每次先在计时外删除 state / index、重建相同 archive；计时 `load()`，
  再计时公开 `compact()`。后者包含 retention、归档读写、索引重建和 save；
  结束后断言活动索引有 19,999 条逻辑 / 物理记录。
- Node `v26.11.1`，`darwin/arm64`，Darwin `27.0.0`，Apple M2，
  8 个逻辑 CPU、16 GiB 内存。采样时间见 JSON 的 `measuredAt`。
- 三轮串行交替，顺序 `before, after, after, before, before, after`；
  每个进程预热 1 次，测量 5 次，每种实现共 15 个正式样本。
  测量期间没有并行测试或其它基准。机器并非完全空闲：开始时后台进程的
  CPU 快照有 5.7% / 12.6% 的活动；load average 从
  `[1.8262, 1.7295, 1.6509]` 到 `[2.0400, 1.7900, 1.6758]`。
  未控制桌面 / 应用的后台负载，不能将该结果视为安静机器的性能上限。

## 实测结果

中位数按每种实现的全部 15 个正式样本计算，未混入预热。

| 路径 | before 中位数 (ms) | after 中位数 (ms) | 变化 |
| --- | ---: | ---: | ---: |
| `load()` / reconcile | 19.077334 | 13.549209 | −28.98%（减少 5.528125 ms） |
| 公开 `compact()` | 877.201375 | 877.764708 | +0.064%（未观察到收益） |

| 轮次 / 顺序 | before load / compact (ms) | after load / compact (ms) |
| --- | ---: | ---: |
| 1 / before → after | 18.178458 / 879.768375 | 13.549209 / 864.007125 |
| 2 / after → before | 20.141625 / 876.515250 | 12.868667 / 886.388750 |
| 3 / before → after | 18.847125 / 878.457375 | 13.567708 / 873.057291 |

表中各轮值是该轮 5 次测量的中位数。解析次数的确定性回归给出混合 JSONL
reconcile `23 → 12`，compact 索引重建 `4 → 2`；纯空白仍计入
physicalCount，但解析失败，永远不会成为活动知识。该优化移除活动档案的重复
解析，没有改变磁盘格式、校验和、轮转或损坏行保留语义。

收益限定于本次 file 后端的大活动档案恢复负载。sealed segment 原来就无需重复
解析；本基准没有测量官方宿主、稳态追加、小档案、其它设备或峰值内存。
公开 compact 的其它工作占主导，本次总耗时没有可辨认的改善；不能把索引重建
解析次数减半等同于 compact 总耗时减半，也不能外推生产闭环延迟。

## 复现

从仓库根执行以下命令；除命令本身外不并行运行测试或基准。
它提取并核对基线，在临时目录运行同样的三轮顺序，输出每次原始 JSONL；
`--memory` 只重定位 imports，不修改工作树或固定产物。

```sh
rtk proxy node --input-type=module - <<'JS'
import { archiveIndexBaseline } from './test/dockyard-domain/archive-index-baseline.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const directory = mkdtempSync(join(tmpdir(), 'dsh-archive-performance-'));
try {
  const file = join(directory, 'memory-baseline.js');
  writeFileSync(file, (await archiveIndexBaseline()).source);
  for (const variant of ['before', 'after', 'after', 'before', 'before', 'after']) {
    const args = ['scripts/benchmarks/archive-index-reconcile.mjs',
      '--rows', '20000', '--runs', '5', '--warmup', '1'];
    if (variant === 'before') args.push('--memory', file);
    console.log(JSON.stringify({ variant }));
    process.stdout.write(execFileSync(process.execPath, args, { encoding: 'utf8' }));
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
JS
```

等价回归：`rtk proxy node --test test/dockyard-domain/archive-index-equivalence.test.js`。
独立复核为 6/6，通过完整旧实现对照、单行解析计数及重新固定产物后的来源守卫。
临时扰动重建形状，helper 抛出 `actual: 0, expected: 1`，没有静默跳过。
临时让当前 `#indexEntryFromRaw` 忽略传入 scan，并仅在反证期间同步对应的
逆向匹配串以保持旧产物来源校验通过，套件为 5/6；当前实现的计数断言收到
`actual: 2, expected: 1`。两处文件均逐字节恢复后重新通过 6/6，
未保留 bypass 或跳过断言。前一轮开发记录保留在 JSON 的 `baselineVerification`，
独立复核见 `independentReview`。

独立单轮 before → after 复测使用同样负载、每进程 1 次预热 / 5 次正式样本：
`load()` 中位数 18.992958 → 13.328416 ms（−29.82%），
公开 `compact()` 885.317958 → 888.590417 ms，仍未观察到收益。
机器环境与上述相同，没有并行测试或其它基准；load average 为
`[1.5283, 1.6226, 1.6255]` → `[1.6069, 1.6348, 1.6294]`，后台负载未控制。
这次抽查不替代三轮原始样本，原始输出与环境另存于 JSON 的 `independentReview`。

按文件内容字节求和（非磁盘占用），恢复冻结 diagnostics fixture 后，最终
`test/` 为 483,033 字节；不再把前一轮含 fixture 改写的快照当作最终总数。
固定产物中的完整 baseline 为 175,320 字节，重建 helper 为 5,789 字节，
避免存储 169,531 字节的重复源码。原开发过程中的未跟踪 fixture / README
目录已不存在，`HEAD` 也未跟踪该目录；不存在可提交的 git 删除记录。
运行时完整 baseline 仍是 175,320 字节，没有用缩小的算法模型替代真实实现。
`package.json#files` 不包含 `test`，该 helper 与基线输入均不进入 npm 分发。
