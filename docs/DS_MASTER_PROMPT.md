# Aegis 阶段入口：C6 最终工程复验前仍 changes_required

C1-C5保持既有验收范围。C6当前基线22d075c：原15个C6脚本、22外部边界、学习closure与recheck既有13项通过，
类型196条旧诊断且Campaign0条新增；五组修复认可。但provider gate同路径仍有3个预算/持久窗口遗漏，
暂不进入真实环境测试。

当前审查：[C6_EXTERNAL_REVIEW.md](C6_EXTERNAL_REVIEW.md) 第5、6节；red测试提交85b1d1d。
当前修复提示词：[C6_RECHECK_REPAIR_DS_PROMPT.md](C6_RECHECK_REPAIR_DS_PROMPT.md)。
原冻结范围：[C6_AGENT_PRODUCT_TASK.md](C6_AGENT_PRODUCT_TASK.md)。
历史初轮修复提示词C6_REPAIR_DS_PROMPT.md保留，勿重复启动已通过的边界。

仅剩同一provider请求门三项：R12末次durable commit失败时不得放行决策；
R13 Task与Campaign调用前联合准入；R14实际provider transcript/tools/schema计入每请求窗口。
聚焦suite当前16例/13通过/3失败，exit1；已通过五组修复不再次整体委派。
主DS复用现C6材料、自主内部里程碑、本地提交，最后一次限定复验；无新增性能/缓存/容器要求。
不改Pi/真实凭据与模型设置/lockfile，不push/rewrite，不调用真实provider/外部目标/验收模型。
真实模型pilot、上下文校准、效果与迁移实验仍以后单独处理。
