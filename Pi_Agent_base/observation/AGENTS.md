# 观测与报告规则

适用于 observation/。负责只读视图、HTTP 观测、报告和导出。

- 从冻结 Manifest 与已提交源构建一致视图，复用 campaign 权威投影；只读入口不派发任务、写控制事件或授予权限。
- 显示历史状态与当前有效性、pending 与 unresolved、已测量与 unknown 的区别；不可用/完整性错误显式展示。
- 构造字段白名单并保留必要权限策略和证据引用；不给出无限制原始会话/工具输出或机密。
- 所有 HTML/脚本嵌入内容正确转义；HTTP 参数校验，保持现有 loopback 绑定和只读路由。
- 截断/分页必须可见；时间、路径、digest 的覆盖口径保持已有契约，不能用旧报告替代真实重建。

验证入口：aegis-c4-report-export、aegis-c4-report-privacy、aegis-c4-report-rebuild、aegis-c4-report-validator、aegis-c4a-observation-http、aegis-c4a-observation-xss、aegis-c4a-observation-command、aegis-e1-observation-repair。启动见 [测试规则](../tests/AGENTS.md)。
