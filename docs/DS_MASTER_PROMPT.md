# Aegis 主 DS 当前委派入口

状态：**C1 changes_required / C2 blocked**。

当前完整提示词：[`C1_BOUNDARY_FOLLOWUP_DS_PROMPT.md`](C1_BOUNDARY_FOLLOWUP_DS_PROMPT.md)。
任务书：[`C1_BOUNDARY_FOLLOWUP_TASK.md`](C1_BOUNDARY_FOLLOWUP_TASK.md)。
最新外部复核：[`C1_BOUNDARY_EXTERNAL_REVIEW.md`](C1_BOUNDARY_EXTERNAL_REVIEW.md)。

先完整阅读这些文件、`Pi_Agent_base/AGENTS.md`、开发/测试/Git 规范，再开始。
此前 F10-F13 原 21 用例独立复跑通过，但新增 12 个用例为 2 pass / 10 fail：
Stage 缺 provenance/foreign 内部 Stage ID 仍假完成，恢复改写调用方 reservation，
有效 cache+tail 仍未驱动后续 Scheduler 流程。只收尾 F14-F16，不重做已修部分。

主 DS先冻结计划/契约/测试矩阵，再按依赖拆任务、实现、审查和集成。有子 Agent 工具则
限定文件委派，无则串行并如实报告。遵守 GIT_STANDARD，逐路径暂存、审查、本地分任务
commit，不 push、不改写历史。提交失败外部测试基线允许，删除/弱化它们不允许。

完成后只写 internally_verified / awaiting_external_review，更新任务书指定交付物，
交回本会话外部验收。不进入 C2/C3/C4a、不修改 Pi/凭据/模型设置/lockfile、不调用真实
模型/目标网络、不自动调用验收模型。
