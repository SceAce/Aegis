# Aegis 阶段入口：C5 收尾完成，下一轮 C6 代码交付

状态：C1-C4a 保持已交付；**C5 accepted_with_recorded_limits**，最新记录
[C5_EXTERNAL_REVIEW.md](C5_EXTERNAL_REVIEW.md)。离线配置入口与 caller-provided SDK 路径已验证。
用户已确认：原 R1-R6 的代码工作统一归入 C6，实际模型运行及效果实验以后单独处理。

总任务书：[C6_AGENT_PRODUCT_TASK.md](C6_AGENT_PRODUCT_TASK.md)。
完整提示词：[C6_AGENT_PRODUCT_DS_PROMPT.md](C6_AGENT_PRODUCT_DS_PROMPT.md)。
产品与实验路线：[AEGIS_PRODUCT_ROADMAP.md](AEGIS_PRODUCT_ROADMAP.md)。
原 SDK launcher 纳入 C6-A，不再单独委派；本轮仅调整规划，未启动代码实现。

C6 一次总开发任务，自主按 A-F 完成 SDK/Task binding/轮换/服务生命周期、模型 Worker/实际账本/
总输入门、Campaign 经验闭环、provider 配置接口、测量与运行支撑、第二任务族 adapter 和 runbook。
开发验证为真实 SDK + faux、本地文件/子进程/隔离 Replay/loopback HTTP；provider 接口离线测试。
完成后交一次限定工程验收，不逐内部小任务请求批准。

真实模型 pilot、上下文校准、经验 A/B/C/D 收益、第二任务族迁移及日常试用另立实验任务。
C6 不调用真实模型/外部目标、不读取真实凭据、不自动验收；工程通过不等于学习效果成立。
F16/旧类型基线后置，修新增诊断、遵守范围冻结。明确路径暂存、审查与本地里程碑提交，
不 push/rewrite、不改 Pi 核心/用户凭据与模型设置/lockfile。
