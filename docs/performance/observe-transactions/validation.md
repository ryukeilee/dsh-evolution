# 验证记录

本次仅新增基准、失败边界回归和报告，生产源码没有修改。以下均为本轮实际执行，使用本机 Node v26.13.0；不借用历史验收结果。

| 检查 | 本轮结果 |
| --- | --- |
| `node --max-old-space-size=4096 --test test/domain-storage/observe-transaction-boundaries.test.mjs` | 4/4 通过 |
| `NODE_OPTIONS=--max-old-space-size=4096 npm test` | 1406/1406 通过，49.63 s，0 失败/跳过 |
| `npm run pack:check` | 开发模式 16 项通过；明确报告开发后继，并非发布固定点 |
| `npm run release:pack -- --dist dist/observe-transactions` | 两次本地打包字节相同；51 条目 |
| 官方宿主 `0.2.0-rc.2` 隔离验收 | 21 步通过，见 [原始证据](host-0.2.0-rc.2.json) |
| 官方宿主 `0.2.1-alpha.1` 隔离验收 | 21 步通过，见 [原始证据](host-0.2.1-alpha.1.json) |
| 官方宿主 `0.2.1-rc.2` 隔离验收 | 21 步通过，见 [原始证据](host-0.2.1-rc.2.json) |

三个宿主均运行：

```sh
NODE_OPTIONS=--max-old-space-size=4096 npm run acceptance:host -- \
  --host <version> \
  --tarball dist/observe-transactions/dsh-evolution-0.2.0.tgz \
  --out docs/performance/observe-transactions/host-<version>.json
```

验收脚本创建隔离 runtime/home，包括官方安装、工具流、禁用/启用、卸载重装、升级回滚、隔离晋升及重启恢复，不接触正式 DSH_HOME。这里的隔离晋升是既有验收探针，不是将本次性能原型晋升或发布。

本次验收包 SHA-256：`10f3ec979f67ef9803be66f079a6b72aff346b120f31a1d74aecaf3bbdc58f38`；内容摘要：`f5681a69d03345f92063aabe599b853fa6e17465fed5ccc46e2853b632eb3a0d`。这是当前 main 已提交内容的本地构建，与固定发布内容 `370465f01b2d43a9a655d8feb5e7d53b76ab06b22331a86d63ec91544994ec9a` 不同。未运行或宣称通过 `pack:check -- --release`，未更新 `release/`。

## 调查中纠正的问题

- 初次基准试跑因没有创建夹具根目录而 ENOENT；修正后重跑。
- 首次历史夹具复用可归一化的故障代码，被既有保留/去重行为压缩，100 条输入只留下较少记录；总数断言阻止该轮成为正式数据。改为不同字母故障身份并保留重启总数断言。
- 初版事务计数按 `mkdirSync(stage)` 次数计数，冷归档 sync 阶段会再次 mkdir 同一目录。改为按唯一 stage 名计数，正式数据重新执行，不手工修改原始数字。
- 默认 `release:pack` 被现有 `dist/` 的不同构建描述拒绝覆盖。随后使用新的 `dist/observe-transactions` 成功，没有删除旧产物。

## 剩余限制

没有生产性能改动，因此没有可交付的生产加速。基准候选被失败语义反例否决，没有继续为其构建复杂的拆批、重试或新恢复协议。正常路径的计数和重启检查不等于逐字节持久结果等价证明；被否决候选的完整断电矩阵和低风险 Trial 所有权差分未执行。真实生产负载中的并发规模、历史形状、硬件及完整宿主调度延迟可能不同。

## 独立审核

sol-loop 一轮，GPT-6.1 Sol：APPROVE，无 blocker / should。启动时按当时用户提供的 AGENTS.md 请求 Max；T3 返回 provider `codex`、model `gpt-6.1-sol`、`reasoningEffort=max`，审核者另据宿主注入的 runtime_info 确认实际模型与 Max，未提供 token 用量。后续用户已更新 AGENTS.md，后续审核遵循 skill 自身档位；本轮已完成，不重复审核。

审核者复算 108 样本、复跑四项新测试及小规模基准，核对三宿主证据与包摘要，没有声称重跑全量或验收。S1（nit）指出原测试不能单独检出 flush 越过前序写入：已在 flush 完成回调断言提交前缀仅有 `first`。修正后聚焦测试 4/4；临时将该 flush 调用替换为立即 resolved promise 的变异验证恰有一项失败，临时文件已移除。生产源码与基准未变化，无需再次全量或宿主验收。审核前 diff 为 10 文件、9785 行新增；审核修正仅增加上述断言和本记录。
