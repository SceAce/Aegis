# Aegis 阶段入口：C6 代码交付完成，待外部工程验收

状态：C1-C4a 保持已交付；C5 **accepted_with_recorded_limits**。
C6（模型 Agent 与经验闭环代码交付）已 **internally_verified / awaiting_external_review**。
验收材料见 [C6_AGENT_PRODUCT_IMPLEMENTATION_REPORT.md](C6_AGENT_PRODUCT_IMPLEMENTATION_REPORT.md)
与操作手册 [C6_AGENT_PRODUCT_RUNBOOK.md](C6_AGENT_PRODUCT_RUNBOOK.md)。
用户已确认：原 R1-R6 的代码工作统一归入 C6，实际模型运行及效果实验以后单独处理。

总任务书：[C6_AGENT_PRODUCT_TASK.md](C6_AGENT_PRODUCT_TASK.md)。
完整提示词：[C6_AGENT_PRODUCT_DS_PROMPT.md](C6_AGENT_PRODUCT_DS_PROMPT.md)。
产品与实验路线：[AEGIS_PRODUCT_ROADMAP.md](AEGIS_PRODUCT_ROADMAP.md)。
原 SDK launcher 纳入 C6-A，不再单独委派；本轮仅调整规划，未启动代码实现。

C6 一次总开发任务已按 A-F 完成 SDK/Task binding/轮换/服务生命周期、模型 Worker/实际账本/
总输入门、Campaign 经验闭环、provider 配置接口、测量与运行支撑、第二任务族 adapter 和 runbook。
开发验证为真实 SDK + faux、本地文件/子进程/隔离 Replay/loopback HTTP；provider 接口离线测试。
已完成一次 C6 限定工程验收材料，交回当前会话独立复核；不逐内部小任务请求批准。

真实模型 pilot、上下文校准、经验 A/B/C/D 收益、第二任务族迁移及日常试用另立实验任务。
C6 不调用真实模型/外部目标、不读取真实凭据、不自动验收；工程通过不等于学习效果成立。
F16/旧类型基线后置，修新增诊断、遵守范围冻结。明确路径暂存、审查与本地里程碑提交，
不 push/rewrite、不改 Pi 核心/用户凭据与模型设置/lockfile。
