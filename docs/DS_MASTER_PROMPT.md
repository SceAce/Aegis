# Aegis 主 DS 当前委派入口

当前决定：**C1 只收尾 F14；F15 非阻塞、F16 后置；F14 验证通过后进入 C2**。
这是用户确认的范围收敛，覆盖旧任务书“所有 F14-F16 全绿才放行”的要求。

完整提示词：[`C1_BOUNDARY_FOLLOWUP_DS_PROMPT.md`](C1_BOUNDARY_FOLLOWUP_DS_PROMPT.md)。
任务书：[`C1_BOUNDARY_FOLLOWUP_TASK.md`](C1_BOUNDARY_FOLLOWUP_TASK.md)。
历史复现证据：[`C1_BOUNDARY_EXTERNAL_REVIEW.md`](C1_BOUNDARY_EXTERNAL_REVIEW.md)，
其早先严重度/阻塞结论按当前任务书重新分类，原测试结果仍保留。

完整阅读 `Pi_Agent_base/AGENTS.md`、开发规范 §3.1、测试规范和 Git 规范。
实现者与审计者都必须冻结阶段目标：只把当前可达路径的核心正确性/授权损害作为阻塞；
缓存性能、后续能力与已有限制的非阻塞项记录责任阶段后继续主线，不要求系统完美。
不删失败证据或降低成功判定，只收敛当前必须完成的范围。

F14 做最小准入修复并跑聚焦组、原有相关回归；复用现有报告，不重复整套文档/广泛审计。
明确路径暂存和本地 commit，不 push、不改写历史。内部自审不是外部通过；
一次限定外部复核通过后进入已获用户同意的 C2，不因后置项重开 C1，也不重复索取同一授权。
C2 契约见 `C2_SESSION_ROTATION_TASK.md`；不提前实现 C3-C4a 或引入真实模型/目标网络。
