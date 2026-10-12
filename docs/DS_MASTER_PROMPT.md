# Aegis 主 DS 当前委派入口：C2 两项最小收尾

状态：**C1 保持已验收；C2 changes_required，仅 C2-E1/E2**。
C2 原真实 SDK 产品套件与相关回归通过，但当前累计预算门与完成记录时机有可复现核心缺陷。

完整执行提示词：[`C2_SESSION_ROTATION_FIX_PROMPT.md`](C2_SESSION_ROTATION_FIX_PROMPT.md)。
最新限定外部复核：[`C2_EXTERNAL_REVIEW.md`](C2_EXTERNAL_REVIEW.md)。
冻结范围依据：[`C2_SESSION_ROTATION_TASK.md`](C2_SESSION_ROTATION_TASK.md)。

先读 Agent 入口及开发规范 §3.1、测试/Git 规范，只修：

- E1 已完成轮换进入下一次预算准入，初始累计 usage 非零也正确扣一次，Host 重建不绕限额；
- E2 create/bind 成功且结果持久后才完成，缺 committed 确认不得返回已验证成功，rebind 失败不留假完成。

保留新外部反例，复用现有计划/矩阵/实现报告，做最小接线改动及受影响回归，不再新建整套报告。
F16 继续后置，不重开 C1，不扩大性能/缓存/UI/Broker 要求。入口接线与限制如实报告。
显式暂存、分任务本地提交，不 push/改写历史、不改 Pi 核心/凭据/锁文件、不触发真实模型/网络。
内部通过后交回一次限定 E1/E2 验收，不自行宣称外部通过或进入 C3-C4a。
