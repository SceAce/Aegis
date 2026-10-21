# 固定 Agent 指令规则

适用于 agent/。ROM.md 是运行时固定指令资源，不是开发进度或当前任务提示的存放位置。

- 保持长期角色、信任和行动边界；动态 Board/RAM、会话状态、临时任务和经验选择不写入 ROM。
- ROM 按 Layer 0–5 分层：身份/边界、证据/判断、硬题方法、记忆/检索、工具/执行、交付。具体 CVE/技法细节写入 `$AEGIS_HOME/knowledge` 的卡片或文档，不写入 ROM。
- 修改 ROM 会影响模型输入与缓存前缀，需说明行为目的，核对实际加载入口、请求预算与缓存序列化。
- 不在指令中加入凭据、私有轨迹、临时路径或未经用户确认的权限。

验证按影响选择 aegis-ram-cache-payload、aegis-c6-provider、aegis-c6-runbook 与相关 Observer 集成；开发检查使用 faux provider。
