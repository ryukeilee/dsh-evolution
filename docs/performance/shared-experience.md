# 统一经验存储的成本

本次开发阶段数据，不是已发布固定包的验收声明。

复现：`node --max-old-space-size=4096 scripts/benchmarks/shared-experience.mjs docs/performance/shared-experience.json`。
原始数据保留在同目录 JSON。6 轮交替 A/B、B/A，每组 200 个不同身份的同类失败；A 是现有领域 canonical 算法的内存执行，B 是同一算法加 SQLite WAL/FULL 持久事务与永久去重。每组使用独立临时根，没有模型或后台任务。它不是原有完整领域写路径的加速对比，而是新增持久采集的成本边界。

本机 Node 26.13.0 / macOS arm64：A 各组 p95 为 0.057–0.130 ms，B 为 0.241–0.334 ms，B 最大样本 1.064 ms。单写者结果不能推导高竞争或慢盘的上界。正常事务的 SQLite busy timeout 为 250 ms；首次启用 WAL 的已复现启动竞争单独在 1 s 内重试，首次创建 schema 的锁等待上限为 2 s，已初始化的打开不再获取 schema 写锁。超时报告采集失败，不假装提交成功。未收到提交回执的失败没有持久保证；COMMIT 后的事实由 SQLite 恢复，测试覆盖并发写、重复投递及 SIGKILL。

真实 ACP stdio 验收使用本地确定性的 Anthropic 响应驱动官方 Agent 与工具执行，没有模拟 agent/error 或 tools/result。一次 provider 失败、一次实际文件读取失败、两次 history 查询（失败与 Desktop 已验证晋升）共收到 7 个预期模型传输响应；采集没有增加响应轮次，也没有外部模型调用。实测每次请求的完整工具 schema 为 19,266 UTF-8 字节，其中唯一的 history schema 为 401 字节（含数组括号）。fixture 的 usage 是合成值，不能用于计费 Token 推断。

未测真实供应商 tokenizer/计费 Token，也未测 Desktop UI 的端到端延迟；不能据此声称三入口全部性能验收完成或零 Token。轻量入口的显式 history schema 会增加上下文，Desktop 复用已有 history schema。采集插件本身不注册采集工具、不写系统提示词、不向模型附加历史。经验只在用户请求检索时返回有界结果。
