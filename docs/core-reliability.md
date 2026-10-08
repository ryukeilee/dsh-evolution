# rc.5 恢复边界修复与探索证据

以下为探索阶段原始记录（新版本固定前）。2026-10-08，本地与远端 HEAD 均为 `f40cb5ebb09a4eade6ad7cc0c21dc7ba9f25e40a`。
本次改动为未发布源码候选。`release/`、rc.4 tag、公开附件和原发布验收证据
均未修改；没有提交、推送或发布，也没有修改官方 DSH 源码。

## 可复现问题与收益

### Trial 恢复基线

原实现把 `propose()` 的快照用于 Trial 清理证明。正常宿主插件在
propose→trial 间完成加载后，即使 Trial 自身已完全移除，恢复比较仍失败。
新增回归测试在这个间隔加入一个组件；冻结 rc.4 得到
`runtimeRecovered: false`，候选得到 `true`。

真实官方 `0.2.0-rc.2` 也复现同一问题：探针通过官方 `ctx.plugin()` 在
proposal 后加载带监听器的宿主插件，随后 Trial、Measure、Revert。
原始 rc.4 返回 `revert-failed`，但清理后的运行时相对真正 pre-trial
清单的 `signatureDiff` 为 `{}`；候选正确返回 `reverted`。
失败证据原样保留在
[基线宿主证据](evidence/core-reliability-baseline-dsh-0.2.0-rc.2.json)。

候选保留 proposal 的 `baseline`，在 Trial 首次修改运行时前同步抓取
`trialBaseline`，比较与归档证明使用同一个 Trial 快照。抓取与 `define()`
之间没有 `await`。旧记录缺少新字段时仍回退到 `baseline`；持久化的
`recoveryProof` 字段和版本不变。没有用忽略额外组件或重试直到相等的方式
放宽恢复比较。Trial 期间增加的组件仍导致 `revert-failed`，目标锁仍保留；
stop 回执失败时，即使签名相等也不能证明恢复。

这项收益是纠正正常 pre-trial 加载造成的恢复误报，不是解决 Trial 执行期间
的并发漂移。它增加一次仅在 Trial 开始时发生的完整 inspect；未测量性能
变化，不宣称 CPU、延迟或吞吐收益。

### Service 清单不可读

原私有回退 `ctx.reflect._getImpl()` 抛错时，`serviceImpl()` 返回
`undefined`，inspect 把服务当成未绑定。前后两次均抛错时，两份空 service
清单可能使 `signatureEqual()` 返回 `true`，形成恢复假阳性。

同一个测试在冻结 rc.4 失败，在候选通过。候选让恢复证明调用显式传播
lookup 错误，inspect 将整份 service 清单标为 `service-registry` 不可用，
由既有签名规则拒绝恢复。普通两参数 service lookup 的行为保留；正常
未绑定声明仍返回空清单，不被误报为活动服务。公共清单读取错误同样进入
不可用分支；这条 public getter 故障路径本次未单独做动态故障注入。

## 验证与失败记录

- 冻结 rc.4 的同负载回归：4 项中 2 项通过、2 项失败，失败正是上述两个
  问题。它们与候选使用同一个测试文件，不修改冻结实现。
- 候选完整 `npm test`：209 项，207 通过、2 失败，0 skipped。新增 4 项
  回归全部通过，现有运行时、Promotion gate、证据恢复、安全、持久化和
  workflow 测试通过。
- 两项完整套件失败为 `test/release-pin.test.mjs` 的
  `the working tree still builds exactly the pinned content` 与
  `every shipped file in the tree matches the artifact byte for byte`。
  它们正确指出候选源码不等于不可变 rc.4；断言和 pin 未放宽。完整套件
  **没有全绿**，候选尚不是可发布固定点。后续发布须使用新版本并完成
  新的来源固定与验收，不能替换 rc.4。
- 临时打包重复两次字节一致，50 个声明条目；候选只写入 `/tmp/`。
- 官方 `0.2.0-rc.2` 与 `0.2.1-alpha.1` 各 21/21 步通过，最终 doctor
  `healthy`，包括数据保留、重装、升级/回滚、Promotion 跨重启稳定提交与
  Canary 回滚。新增 pre-trial 漂移探针通过，清理后 `signatureDiff: {}`。
  [rc.2 证据](evidence/core-reliability-dsh-0.2.0-rc.2.json) /
  [alpha.1 证据](evidence/core-reliability-dsh-0.2.1-alpha.1.json)。
- `verify-artifact.mjs` 对原 rc.4 通过；`release/` 与原发布验收证据无 diff。
- 一次独立窄范围静态审查未发现本次改动的阻塞问题；审查不替代上述测试。

探索阶段的首次测试还包含测试自身错误：把目标锁键写成 proposal target，
而实际锁来自 impactScope；假定普通 revert 会写 sidecar，而实际读取对象
应为 Markdown 归档中的证明。已修正探针，冻结基线结论以上述最终同负载
2/4 结果为准，不把测试错误当成产品问题。

候选 tarball SHA256：
`31ee71dbcefc10295942452b1ad574d2adc1bf59f928e3860b0f721a8cdd0c54`。
候选内容摘要：
`60646e809e81084aa66d8254d16b1c9ba545c99b51ecd4e3dadffbd7b46bc36f`。
临时构建保留当前 package version，仅用于验收，不得作为同名 rc.4 发布。
原 rc.4 SHA256 仍为
`57f09a0f8ab1c0543d5bc1bf54aca5296960d2acf3edc61950f255580e99a4ff`。

## 复现命令

所有工作负载仅使用合成数据和临时 home，不需要模型或凭证。

```sh
rtk proxy mkdir -p /tmp/dsh-core-reliability-baseline
rtk proxy tar -xzf release/dsh-evolution-0.2.0-rc.4.tgz -C /tmp/dsh-core-reliability-baseline
# 预期退出 1，2 pass / 2 fail：冻结基线复现
rtk proxy env EVOLUTION_TEST_BASELINE=file:///tmp/dsh-core-reliability-baseline/package/lib/orchestrator.js node --test test/trial-recovery-boundary.test.mjs
# 候选回归 4/4；完整 suite 保留两项 rc.4 pin 拒绝
rtk proxy node --test test/trial-recovery-boundary.test.mjs
rtk proxy npm test
rtk proxy env npm_config_cache=/tmp/dsh-core-reliability-npm-cache node scripts/release/pack.mjs --dist /tmp/dsh-core-reliability-dist
# 使用全新官方 runtime 时省略 --runtime，脚本自行安装
rtk proxy node scripts/acceptance/run-host-acceptance.mjs --host 0.2.0-rc.2 --tarball /tmp/dsh-core-reliability-dist/dsh-evolution-0.2.0-rc.4.tgz --out /tmp/core-reliability-rc2.json
rtk proxy node scripts/acceptance/run-host-acceptance.mjs --host 0.2.1-alpha.1 --tarball /tmp/dsh-core-reliability-dist/dsh-evolution-0.2.0-rc.4.tgz --out /tmp/core-reliability-alpha.json
# 同探针原始产物对照：预期 core-flow 拒绝，退出 1
rtk proxy node scripts/acceptance/run-host-acceptance.mjs --host 0.2.0-rc.2 --tarball release/dsh-evolution-0.2.0-rc.4.tgz --out /tmp/core-reliability-baseline.json
rtk proxy node scripts/release/verify-artifact.mjs
```

## 保留的边界与未验证项

独立 evaluator 已在缺少 goal/test/regression 结果时拒绝推荐 Promotion；
orchestrator 当前没有宿主提供的独立 baseline/test 指标，故领域 evaluator
仍是 advisory，只有实证 regression 提供硬 veto。没有把 observation 的
自报成功再复制成“独立测试成功”，也没有在没有证据的情况下新增评估运行时。
原有生产 `promotionGates`、二次用户确认、安全守卫和 Canary 保持原逻辑。

参考已有性能收口，不重复归档 fsync、全日志认证、查询缓存等缺少低风险
高收益方案的方向。本次没有性能优化声明。

Trial 执行期间的外部变化仍可能拒绝恢复；既有 trial 启动失败分支没有完整
恢复证明就释放目标锁的行为未修改。恢复签名仍是可观察注册/effect 清单，
不能证明任意合作式代码或 disposer 的全部外部效果。内部宿主 API 风险、
continuous/governance 未接入实时循环和签名密钥无轮换流程继续存在。

本次仅验证 Node `v26.10.0` / `darwin-arm64`。宿主复用已安装的精确官方
runtime，但每次 home 全新。未执行 Node 22/24、Linux、远端 CI、长期生产
负载、公开发布、新版本 pin/provenance，或新的独立生产指标采集。

## rc.5 收口

rc.5 使用新版本与新固定点，不覆盖探索时的 rc.4 产物或历史发布附件。
除探索阶段四项回归外，补充三项断言：`run()` 等待期间发生漂移、重复
Trial 调用和后续 inspect 均不能刷新 `trialBaseline`；公开 store getter
读取失败拒绝恢复，而未绑定声明保持空清单；普通两参数私有 lookup 保持
原有容错行为。新增七项回归全部通过。

窄范围独立静态审查未发现阻塞问题，审查没有运行测试，Root 负责动态验证。
Node 22/24、全量测试、双宿主真实验收、远端 CI / CodeQL、tag/provenance、
匿名下载及发布后验收的最终结果统一记录在
`docs/evidence/rc5-release-audit.json`，原始失败证据不改写为通过。

恢复基线仅在首次 Trial 同步入口捕获，`define()` 前没有 `await`；后续
inspect、measure、cleanup 和第二次 Trial 均不重建基线。持续存在的
试验期间漂移拒绝恢复，恢复失败保留目标锁。签名仍只比较前后终态，已
自行恢复的瞬态变化不可见；未扩展为合作式代码的完整效果追踪或安全沙箱。
探索记录中的 Node/Linux/发布验证缺口以最终审计补充，长期生产负载、
独立生产指标、启动失败分支释放锁的既有行为及其它产品边界仍未改变。
