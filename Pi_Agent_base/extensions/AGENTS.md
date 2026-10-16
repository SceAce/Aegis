# Pi 扩展接入规则

适用于 extensions/。扩展负责 Pi 事件、命令、工具与 Aegis 模块的接线。

- 业务状态机、授权、Oracle、记忆算法放对应模块，扩展不复制第二套权威实现。
- 改 hook/tool/session 行为前核对实际 SDK API 和必要文档；保持工具 allowlist、Campaign gate 与轮换后重绑定。
- 保留 tool_call/tool_result 的动作身份、因果与 transport；自记录完成的工具避免二次记账。
- 模型提案不获得 Fact、Outcome、授权或 active Experience 写权；事件收集不改变来源可信度。
- RAM 是按请求重建的临时上下文，保持固定系统前缀与会话持久化契约；隐私与有界摘要按模块契约处理。
- 保持用户隔离配置，注册资源不隐式读取默认用户扩展、凭据或真实 provider。

验证入口：observer-smoke、aegis-observer-failclosed-pi、aegis-observer-run-audit-failclosed-pi、aegis-observer-runtime-handoff、aegis-ram-cache-payload；Fixture/Contest 接线选对应集成脚本。启动见 [测试规则](../tests/AGENTS.md)。
