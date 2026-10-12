# Aegis 主 DS 当前委派入口

当前状态：**C1 changes_required；C2 blocked**。

完整执行提示词为 [`C1_EXTERNAL_BOUNDARY_DS_PROMPT.md`](C1_EXTERNAL_BOUNDARY_DS_PROMPT.md)，
任务书为 [`C1_EXTERNAL_BOUNDARY_FIX_TASK.md`](C1_EXTERNAL_BOUNDARY_FIX_TASK.md)，
最新外部审计为 [`C1_FINAL_EXTERNAL_AUDIT_3.md`](C1_FINAL_EXTERNAL_AUDIT_3.md)。
先完整阅读三者和其中指定的开发、测试、Git 规范，再开始执行。

此前 F7-F9 有有效修复，但新边界测试已复现 F10-F13：缺失当前 scope、Stage 证据绑定
不完整、checkpoint 恢复丢 Episode/幂等，以及 scheduler checkpoint/digest 接线遗漏。
21 个外部验收用例当前 2 pass / 19 fail；不得按旧报告“全绿”跳过这些行为反例。

主 DS一次接收总任务，先冻结契约和测试矩阵，再拆小任务实现/审查/集成。没有子 Agent
工具则串行完成并如实报告；自审不等于外部验收。遵守 GIT_STANDARD，任务分支、明确路径
暂存、本地 milestone commits；历史“不做 Git 提交”限制已经替代。不 push 或改写历史。

只完成 F10-F13 收尾，交付任务书规定的 C1_BOUNDARY 材料后停止。内部通过只写
`internally_verified / awaiting_external_review`，有未解阻塞发现写 changes_required。
不进入 C2/C3/C4a，不修改 Pi 核心、凭据或锁文件，不运行真实目标/模型/网络，不自动验收。
