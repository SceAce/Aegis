# 会话生命周期规则

适用于 session/。负责交接安全判断、Host 应用交接和 Session 监督。

- Session 与 Episode 是不同对象；轮换不生成独立尝试、成功证据或预算重置。
- 交接使用当前 Task/Episode 的有效状态和记忆；全部交接字段维持同一作用域，保留未决行动与责任。
- 等待实际安全边界再替换 Session；记录真实新 session id/file，成功后才完成/退休交接请求。
- 使用现有 Pi runtime 的真实 API，并在新 Session 重新绑定原有 gate/扩展。API 变更时按需读实际 SDK 文档与签名。
- 恢复不能重发未知副作用，不能把新 Session 或继续提示当作旧工具结果已保存。

验证入口：aegis-c2-supervisor-boundaries、aegis-c2-budget-sdk、aegis-c2-session-rotation、aegis-observer-runtime-handoff；记忆内容交接加 aegis-ram-reaudit-sdk。SDK 启动见 [测试规则](../tests/AGENTS.md)。
