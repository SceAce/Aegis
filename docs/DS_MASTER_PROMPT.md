# Aegis 阶段入口：C5 收尾完成，下一轮离线 SDK launcher

状态：C1-C4a 保持已交付；**C5 accepted_with_recorded_limits**，最新记录
[`C5_EXTERNAL_REVIEW.md`](C5_EXTERNAL_REVIEW.md)。接受范围为离线配置入口与 caller-provided
真实 SDK/faux 接入；CLI 自动创建 SDK、任务绑定/自动策略、常驻观察尚待部署补齐。
本审查会话参与修复，不夸大第二团队独立验收，不重复委派 C5 审查。

下一轮任务书：[`SDK_LAUNCHER_TASK.md`](SDK_LAUNCHER_TASK.md)。
完整提示词：[`SDK_LAUNCHER_DS_PROMPT.md`](SDK_LAUNCHER_DS_PROMPT.md)。
用户将提示词交 DS 后实施；本轮只布置，不实现 launcher。

目标为真实 SDK + faux 的显式离线启动、同一 Host/gate/writer、实际 Task/Episode 绑定、
安全自动轮换/跨 Task 预算、生命周期/恢复和常驻只读观察。真实模型/目标/能力实验须之后
明确任务与授权，不因集成通过自动执行。F16/74 条旧类型诊断后置，遵守开发规范 §3.1。
明确路径暂存、审查、本地里程碑提交，不 push/rewrite、不改 Pi/凭据/锁文件、不自动验收模型。
