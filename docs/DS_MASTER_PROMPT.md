# Aegis 阶段入口：C3 本轮审查修复完成，下一轮 C4

状态：**C1/C2 保持已验收；C3 accepted_with_recorded_limits；C4 下一轮待委派**。
本轮审查和直接授权修复见 [`C3_EXTERNAL_REVIEW.md`](C3_EXTERNAL_REVIEW.md)。
原 C3 交付有有效产品链，但当前核心反例已由本会话集中修复，不再让 DS 反复补同一轮。

下一任务书：[`C4_REPORT_TASK.md`](C4_REPORT_TASK.md)。
给 DS 的提示词：[`C4_REPORT_DS_PROMPT.md`](C4_REPORT_DS_PROMPT.md)。
C4 只做基于权威事件的确定性 report/bundle/validator/reviewer prompt，UI 留 C4a。
本轮已布置文档，不在当前会话实施 C4；用户将提示词交 DS 后开始。

遵守开发规范 §3.1，冻结阶段核心目标与 required/deferred，不重开已完成阶段。
F16 cache、旧类型导入诊断、任意平台/多 Worker/真实模型或目标网络后置。
C3 CLI 默认为离线 fixture，可信脚本/Oracle/Session 使用 programmatic Host 装配；
下一阶段报告要如实显示这些限制，不能夸大 CLI 自动调度/模型能力。

按 Git 规范本地任务分支、明确路径暂存、审查、逐里程碑提交，不 push/改写历史。
不修改 Pi 核心/凭据/模型/锁文件、不自动调用验收模型。
C4 内部通过后一次限定验收，不自动进入 C4a/C5。
