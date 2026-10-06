# Dockyard 领域模块与端口

本目录不依赖旧运行时，不自动读取 home，不创建 scheduler。导入与构造不会写文件；显式 `load()` 会重建 archive index、必要时归档超出 hot 窗口的记录，**不是只读打开**。只传入经授权的新数据根。

```js
import { EvolutionMemory, EvolutionObservationStore, EvolutionEvaluator } from './index.js';
const memory = new EvolutionMemory({
  stateStore,          // 显式插件持久化 adapter
  transaction,         // 可选 { persist(updater, options) }
  mutationAuthority,   // 必须 { assertMutation(operation) }；具体权限策略由宿主实现
});
await memory.load();
const observations = new EvolutionObservationStore({ memory });
```

## stateStore

- `load({ resolveSnapshot: false }) -> aggregate DTO`。
- `update(updater)` 或 `save(aggregate)`；无 update 时同时用 load/save。
- 可选 `filePath`：所有冷档案名称从此派生；没有 filePath 时保留旧 maxEntries 内存裁剪合同，**不等价于历史持久化迁移**。
- `*.cycles-archive.jsonl`、其他 `*.COLLECTION-archive.jsonl`、`.segments/segment-N.jsonl` 和 `*.evolution-archive-index.json` 同处新根；必须一同搬运。冷档案由 Memory 内置成熟文件后端管理，不能仅转换热 snapshot 到 JSON 后忽略档案。
- 可选 `inlineSerialization === true` 只有 transaction 在调用时同步捕获所有 payload 字节才能启用；否则不得标记 true。
- transaction 显式注入，无旧 getRuntimeTransaction/global state-store 自动发现。persist 选项 `includeSnapshot:false, generateSnapshot:false, metadata:{partition:key}` 保留旧合同，不要求 adapter 实现旧 runtime snapshot。
- adapter 必须提供串行更新、错误传播及独占数据根；多实例/多进程写同一个 archive 根没有额外锁保证。宿主负责 drain 写队列、关闭 domain handle 和跨 archive/desiredState 的 journal/补偿，不能把这个模块当跨媒介原子事务实现。

## authority

任何领域 mutation 缺少 assertMutation 将抛 `E_MUTATION_AUTHORITY_REQUIRED`，现有 setMutationAuthority 仍可绑定一次且不能替换。测试 no-op authority 仅用于测试，不是生产权限策略。显式 load 的维护写盘由创建 store 的宿主授权，authority 不使 load 变成只读。

## 读取与学习

- `snapshot()` 是 hot projection；`fullSnapshot()`、`history(collection)`、`knowledgeSnapshot()`、`findBlockingOutcomes(signature)` 使用 hot+cold。
- `restore(fullSnapshot)` 支持跨冷边界去重，不应传热 snapshot 冒充完整历史。
- `compact()` 保留失败 blocker、引用源、canonical/tombstone 语义；不生成 provenance 晋升事实。
- `EvolutionObservationStore` 必须显式共享这个 Memory，不能走简单 JSON 独立回退。保留健康信息 dedup、error 样本、forceRecord 和 >5% perf 转变。它只接收 DTO，不采集 process perf、不订阅运行时事件。
- evaluator 是纯建议：保留独立 goal/test/regression 门槛与反刷分指标，不能用它的 `evaluateLegacy` 兼容入口替代真实晋升证据。

## 非安全承诺

历史文本仍是历史用户数据；旧字段名 redaction 不保证普通文本完全脱敏。manifest 规范化只是历史 DTO 投影；虽然兼容历史 kind 字符串（含 provider），并不授权解析、加载或执行该类组件。旧 execution event 的确定性 eventId 不是新签名认证。需在官方 adapter 外层执行 allowlist、脱敏、签名验证和审批。
