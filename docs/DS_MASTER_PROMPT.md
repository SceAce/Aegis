# Aegis 阶段入口：C6 工程审查 changes_required

C1-C5 保持既有范围交付。C6 DS 内部交付后，本次限定审查复跑原11套件均通过，
但新增21个边界用例为2 pass/19 fail，当前不能进入实际环境实验。
审查依据：[C6_EXTERNAL_REVIEW.md](C6_EXTERNAL_REVIEW.md)。

当前任务提示词：[C6_REPAIR_DS_PROMPT.md](C6_REPAIR_DS_PROMPT.md)。
原冻结总范围：[C6_AGENT_PRODUCT_TASK.md](C6_AGENT_PRODUCT_TASK.md)。
产品与实验划分：[AEGIS_PRODUCT_ROADMAP.md](AEGIS_PRODUCT_ROADMAP.md)。

修复限定于原C6承诺：调用前真实SDK循环/工具预算与持久测量、总输入门、实际Task/Episode/
shared writer、可观察Worker、代码Oracle无假成功、active/replay/direct/habit经验工程链、
provider配置接口、runner实际attempt隔离、常驻observe与错误清理。复用C6计划/矩阵/报告，
主DS自主内部推进、明确路径审查本地提交，最后交一次限定复验，不重复审计已完成阶段。

“稳定编译active/真实Replay”是工程required，不能移交E2实验；收益/真实模型pilot另立任务。
当前SHA256/UUID控制通过，禁止依据无证据crypto全零归因弱化测试；修新增类型诊断，旧库/F16后置。
不改Pi核心/真实凭据与模型设置/lockfile、不push/rewrite、不调用真实provider/外部目标/验收模型。
