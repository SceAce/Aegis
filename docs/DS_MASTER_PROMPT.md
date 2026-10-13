# Aegis 阶段入口：C4 收尾完成，下一轮 C4a

状态：C1-C3 保持已验收；**C4 accepted_with_recorded_limits**，见
[`C4_EXTERNAL_REVIEW.md`](C4_EXTERNAL_REVIEW.md)。当前授权审查已集中补测试并修复只读/完整性/
隐私/计数/validator/界限问题，不再委派重复的 C4 修复轮次。

下一轮任务书：[`C4A_OBSERVATION_TASK.md`](C4A_OBSERVATION_TASK.md)。
完整 DS 提示词：[`C4A_OBSERVATION_DS_PROMPT.md`](C4A_OBSERVATION_DS_PROMPT.md)。
用户将该提示词交 DS 后实施；本次只布置，不实现 UI。

C4a 只做 loopback 只读观察面与 Pi 查看命令，复用同一 committed 投影/脱敏白名单。
C5 整体集成和真实能力实验仍在后面，不把它们提前变成本阶段门槛。
遵守开发规范 §3.1：冻结 required，非阻塞/后置记录责任后继续主线。
F16 cache/旧类型导入诊断继续后置，不重开已完成阶段。

按 Git 规范明确路径暂存、审查、本地里程碑提交，不 push/改写历史、不改 Pi 核心/凭据/
模型/锁文件，不用真实模型或目标网络、不自动调用验收模型。内部完成后一次限定 C4a 验收。
