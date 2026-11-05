# canonical knowledge 热窗口上限

`lib/dockyard-domain/memory.js` 将有归档的 canonical knowledge 热窗口限制为 `min(maxEntries, 200)`。冷档案、查询和恢复沿用原有路径；较小的 `maxEntries` 仍然生效。数据分区改变，完整历史的逻辑内容应保持不变。

## 测量

修正身份归一化与冷行夹具后的原始数据见 [knowledge-hot-window.json](knowledge-hot-window.json)，脚本见 [knowledge-hot-window.mjs](../../scripts/benchmarks/knowledge-hot-window.mjs)。Node v26.13.0，darwin/arm64；各规模一轮、每个重复场景两个样本，结果仅供此环境下参考。脚本从 `70cb2d3` 分别提取相同的 A 和 A-control，B 使用工作树源码；各侧使用独立子进程和复制的合成夹具。A/A-control 的差异用于显示测量噪声。

| 历史 | 场景 | A（ms） | B（ms） | B 相对 A | A-control 相对 A |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1000 | firstWrite | 138.66 | 117.84 | −15.0% | +0.5% |
| 1000 | newSubject | 122.86 | 71.88 | −41.5% | +6.9% |
| 1000 | coldRepeat | 119.99 | 67.75 | −43.5% | +2.7% |
| 1000 | concurrent（32 个不同主体） | 3774.28 | 2288.79 | −39.4% | +2.5% |
| 1000 | restartOpen | 33.34 | 12.16 | −63.5% | −11.2% |
| 5000 | newSubject | 192.35 | 102.77 | −46.6% | +0.5% |
| 5000 | coldRepeat | 173.20 | 78.62 | −54.6% | −1.4% |
| 5000 | concurrent（32 个不同主体） | 5516.29 | 2528.79 | −54.2% | −0.5% |
| 5000 | restartOpen | 28.17 | 9.13 | −67.6% | −0.4% |

1000 条历史时，提交文档从 3,293,623 降至 721,436 字节；5000 条时从 3,296,979 降至 722,004 字节。两档的知识热区均从 1000 条降至 200 条。32 个并发事务的后端文档写入分别从 320,567,973 降至 68,730,688 字节、从 320,902,608 降至 68,789,904 字节，均下降约 78.6%。事务数、每次事务的两次文档写入和 sync 次数未减少；收益来自每次写入的字节减少。这里的写入字节是后端接收的文档字节，不含归档追加。

主 JSON 的 `partition.composition` 给出紧凑文档组成：1000 档 knowledge 从 1,769,246 降至 357,058 字节，5000 档从 1,772,588 降至 357,388 字节。子进程峰值 RSS（含夹具解析和迁移）分别为 355.9 → 268.6 MiB、569.0 → 557.3 MiB，不代表稳态内存上界。

夹具模拟旧文档的热知识迁移。脚本断言新主体各新增一条知识，重复主体不新增身份，冷行更新保持原位置且计数递增；三侧比较完整合并历史、公开查询和重启后的逻辑结果。持久化分区本身按设计不同。回归测试见 [knowledge-hot-window.test.mjs](../../test/domain-storage/knowledge-hot-window.test.mjs)。

200 条附近首次跨越热窗口时会增加归档写入及相关同步成本。修正夹具后未重测 200–750 的各档，也未重测 20000 档，因此不能确定这些规模的收益或回退。更多冷行会使归档树增大；读取性能及迁移成本应按实际工作负载评估。

复现：

```sh
node --max-old-space-size=4096 scripts/benchmarks/knowledge-hot-window.mjs \
  --sizes 1000,5000 --rounds 1 --samples 2 \
  --out /tmp/knowledge-hot-window.json
```
