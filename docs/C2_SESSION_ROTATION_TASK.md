# C2 Pi Session 轮换：暂缓计划

状态：**blocked / 未授权启动实施**。

本文件替换本会话过早写出的 approved 草稿。最新外部审计
`C1_FINAL_EXTERNAL_AUDIT_3.md` 已复现 F10-F13，当前只执行
`C1_EXTERNAL_BOUNDARY_FIX_TASK.md`；修复后还须外部验收。
不得因旧草稿或第一批测试全绿启动 C2。

C2 的已确认目标仍以 `CAMPAIGN_ARCHITECTURE.md` 的 Phase C2 / §Session Supervisor
及 `CAMPAIGN_CONTRACT_BASELINE.md` 为准：Host 所有权、安全 idle/settled 边界、
真实 Pi SDK 创建新 Session、Episode 与预算连续、失败/取消无假完成、handoff 幂等。
Observer 负责收集，Runtime 负责状态。

前一版草稿自行提出默认每 Task 两个 Session、要求无未决 Oracle 才能轮换、
`campaign.session.rotated` 新事件等，未经完整 SDK/既定 handoff 契约核对，均不作为
冻结要求。C2 正式启动前须读取完整 Pi SDK 文档及实际 API、现有
`memory/runtime/handoff*.mjs`、冻结 Host 状态与事件契约并形成测试矩阵。
仅记录随机 Session ID 变化不足以验收，必须验证对象/context 真实替换及错误恢复。

本次不写 C2 实现提示词；交给 DS 的当前提示词是
`C1_EXTERNAL_BOUNDARY_DS_PROMPT.md`。
