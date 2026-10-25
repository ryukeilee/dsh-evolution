# checkpoint 告警隔离：聚焦验证（2026-10-25）

本轮接续未提交实现，只补充测试和证据；没有再修改 `lib/domain-storage.js`，没有提交、发布、修改版本或固定产物，也没有改动其他预存未跟踪文件。环境为 macOS、本机 Node **v26.12.1**（`/opt/homebrew/bin/node`）。以下均为本轮实际执行结果，不引用前一代理未报告的运行。

交接时 `lib/domain-storage.js` 的 SHA-256 为 `93abf5367d379d57cd152bd93ec93677dbaa7e90749517e7b16df4264036f831`（`shasum -a 256 lib/domain-storage.js` 实测）；这是单文件摘要，不是分发包的 contentSha256。

## 修复与验证范围

现有生产改动仅将 checkpoint 写入失败后的告警交给 `warnRedacted()`，隔离日志同步抛错、属性读取抛错及返回 Promise/thenable 的拒绝。认证、事件冲突、领域提交失败仍应拒绝 flush；失败队列的 close 仍报告真实失败。检查点本身只是重放优化，丢失它不能把已经提交的 pass 变成失败。

`test/domain-storage/flush-checkpoint-diagnostics.test.js` 使用现有 `materializeDomainStorage()`，从当前源码精确反转告警块及 `safeErrorDto` 导入，生成临时旧模块。其他依赖不变，使用真实官方 `DomainFacility`、`JsonStorageBackend`，并单独验证真实 Cordis logger/exporter。所有数据、事件密钥和故障均为临时目录内的合成 fixture，不访问正式用户数据。

接续时已核对：review 指出的 `closeError` 文本断言和启动重放加显式 flush 的两条告警计数已修正；当时的 8 项测试实跑通过。此后补齐以下测试，总计 11 项：

- 正常路径及正常 logger 下的 checkpoint 写失败：旧/新模块输出一致，告警只归一化临时路径、随机文件后缀和摘要后比较。
- 同步抛错、`warn` getter 抛错、thenable 抛错，以及返回 rejected Promise：新模块 flush/close 正常，无未处理拒绝；旧模块的同步抛错会污染 flush 和 close。
- 真实 Cordis exporter 抛错：旧模块拒绝 flush，新模块返回 `{ applied: 1, duplicates: 0 }`。
- 启动重放、两个并发 flush、修复 checkpoint 路径后的重试及重开：新模块在异常 logger 下的输出与旧模块正常 logger 下的输出一致；已提交事件只作为重复记录识别。启动重放和紧随的显式 flush 各产生一次 checkpoint 告警。
- 实际 `apply()` 注册的全部 9 个 `evolution_*` 工具经过 execute/finally 到真实 `port.flush()`：同步抛错和拒绝 Promise 的 logger 均不改变工具成功结果；首次 flush 应用 1 条，后续 8 次各识别 1 条重复。仅工具业务体使用桩，避免执行真实 trial 或生产变更；注册包装和持久化 flush 不使用桩。
- 工具本身的主错误保留同一 Error 对象；真实认证错误仍让成功工具调用失败，也仍由 close 报告。
- 额外注入真实 `domain.global.set()` 拒绝：旧/新模块均报告 `INJECTED_DOMAIN_COMMIT`，没有提交事件标记，也不进入 checkpoint 告警路径。

此文件的场景比较的是 flush/close 结果、已应用事件 ID、checkpoint 是否为文件及其 records，以及重开后的相同观测；**不声称比较 checkpoint 字节或完整 aggregate 字节**。本轮同时执行的既有 write-path 差分测试另有完整持久状态字节一致性断言，其固定旧基线重建校验也通过。

## 修复前失败：本轮重新复现

下面的命令复制测试到临时文件，只让被测 post 槽加载精确反转所得的旧模块；生产文件不变。退出码检查确认子进程确实因回归断言失败，临时测试文件随后删除。

```sh
NODE_OPTIONS=--max-old-space-size=4096 python3 - <<'PY'
from pathlib import Path
import os, subprocess, tempfile
source = Path('test/domain-storage/flush-checkpoint-diagnostics.test.js').read_text()
old = "post: await materializeDomainStorage(working, home, 'post-fix'),"
new = "post: await materializeDomainStorage(preFixSource, home, 'post-fix'),"
assert source.count(old) == 1
fd, name = tempfile.mkstemp(prefix='.flush-checkpoint-pre-fix-', suffix='.mjs', dir='test/domain-storage')
try:
    with os.fdopen(fd, 'w') as f:
        f.write(source.replace(old, new))
    result = subprocess.run(['node', '--test', '--test-name-pattern=the REAL Cordis exporter chain', name])
    print(f'PRE_FIX_EXIT={result.returncode}', flush=True)
    if result.returncode != 1:
        raise SystemExit('expected the old checkpoint catch to fail this regression')
finally:
    Path(name).unlink()
PY
```

实际结果：选中 **1 项，0 通过、1 失败**，`PRE_FIX_EXIT=1`。失败断言期待 fulfilled / `{ applied: 1, duplicates: 0 }`，实际为 rejected / exporter 错误。外层 Python 退出 0 表示成功捕获预期回归失败，并非旧模块测试通过。

## 修复后通过

```sh
NODE_OPTIONS=--max-old-space-size=4096 node --test test/domain-storage/flush-checkpoint-diagnostics.test.js
```

实际结果：**11/11 通过**，0 失败、0 跳过，约 716 ms。

```sh
NODE_OPTIONS=--max-old-space-size=4096 node --test \
  test/domain-storage/flush-checkpoint-diagnostics.test.js \
  test/domain-storage/event-log-checkpoint.test.js \
  test/domain-storage/replay-batch-commit.test.js \
  test/domain-storage/domain-storage-write-path-equivalence.test.js \
  test/entry-failure-diagnostics.test.mjs
```

实际结果：**48/48 通过**，0 失败、0 取消、0 跳过，约 11,735 ms，退出码 0。包括固定旧基线重建、持久状态字节差分、认证/冲突/篡改拒绝、批量提交失败与重试、pending 中断恢复，以及工具/初始化主错误保留。

## 边界

本轮未执行全量套件、多 Node 版本验证、真实宿主验收或打包/发布检查。其他轮次的宿主验收和 Node 22/24 全量结果不作为本文证据。生产分发改动仍处于未提交状态；本轮不更新 release 固定点。实现需由 Coordinator 接续独立复审。

## Coordinator 验证

最终独立复审通过，无阻塞项；复审实跑固定基线复原检查，与 rc.8 源码逐字节一致（17,037 字节），`git diff --check` 通过。

使用本机 Node 24.22.1、4096 MiB 堆上限执行：

```sh
npm run release:pack -- --dist /tmp/dsh-evolution-flush-checkpoint-20261025-build
node scripts/release/verify-artifact.mjs /tmp/dsh-evolution-flush-checkpoint-20261025-build/dsh-evolution-0.2.0-rc.17.tgz --content-only --tree
npm run release:verify
```

本地包两次构建字节一致，51 个条目，`contentSha256=6279015b442f5d8d4abbb606e74767667175c4cd5ed352f0d026e45b2ae90e6c`，tarball SHA-256 为 `a8f5a356c9a248e9f47fa99a23243e5b950f09fb7fd7457ac3b433c6176f2c9f`，内容与当前树一致。固定发布包字节和内容校验通过；固定点未改动。

三个官方宿主 `0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-rc.2` 均使用上述本地包、Node 24.22.1 和 4096 MiB 堆上限，在验收脚本新建的隔离 runtime/home 中各通过 21 步。证据为同目录 `flush-checkpoint-20261025-dsh-<host>.json`，均 `ok: true` 且内容摘要与上述包相同。每次显式指定 `--tarball` 和独立 `--out`，未覆盖发布固定点证据。

提交前 Node 22.23.4（npm 10.9.9）与 Node 24.22.1（npm 11.19.1）全量均为 926/927 通过，0 跳过，唯一失败为 `release-pin.test.mjs:70` 拒绝未提交分发改动；未出现功能测试失败。运行前后 243 个源码、测试和配置文件的 SHA 清单一致。提交后须重新执行全量与开发阶段打包门禁，不能将此结果记为全绿。

实现提交 `800cf4221014a4304830b18444bffdab8181b7e3` 后，重新执行以下检查：

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 npm test
PATH=/opt/homebrew/opt/node@24/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 npm test
PATH=/opt/homebrew/opt/node@24/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 npm run pack:check
```

Node **22.23.4：927/927**、Node **24.22.1：927/927**，均退出 0，0 失败、0 跳过。运行前后没有已跟踪改动；日志分别为 `/tmp/dsh-evolution-final-node22-24.huOEM0/node22.log` 和 `node24.log`（临时本机证据，不承诺长期保存）。Node 24 有一个子进程三次 RSS 采样约 115→131→144 MiB，执行停止检查时套件已正常结束；没有据此展开内存调查或重试。开发阶段 `pack:check` 全部 16 项通过，内容摘要仍为上述 `6279015b…`；没有执行要求工作树等于固定发布内容的 release gate，也没有更新固定点。

本次交付是可靠性修复，没有性能候选或 A/B 耗时收益声明。检查点仍须重新验证完整日志前缀，真实存储、认证与恢复失败仍会拒绝；日志设施本身故障时该条诊断可能不可达。不承诺处理官方 logger 内部丢弃的异步 exporter Promise。
