# Aegis 主 DS 当前委派入口：C2

状态：**C1 externally_accepted（冻结范围内）；C2 approved_to_start**。
限定外部记录：[`C1_F14_EXTERNAL_ACCEPTANCE.md`](C1_F14_EXTERNAL_ACCEPTANCE.md)。
用户已同意 C2，无需重复请求阶段授权。

完整提示词：[`C2_SESSION_ROTATION_DS_PROMPT.md`](C2_SESSION_ROTATION_DS_PROMPT.md)。
当前任务书：[`C2_SESSION_ROTATION_TASK.md`](C2_SESSION_ROTATION_TASK.md)。
先完整阅读二者、`Pi_Agent_base/AGENTS.md`、开发/测试/Git 规范，再实施。

C2 只交付真实 Host 级 Session 轮换：真实 SDK 新对象/context、安全边界、同 Episode/累计预算
连续、失败/取消无假完成、handoff 幂等及必要恢复。实际 API 由完整 SDK 文档/源码核对。
先冻结简洁契约/required 矩阵，再实现、聚焦验证、自审、分任务本地提交。

F15 已局部修复；F16 后置，保留全量 EventLog 重放正确性，不以缓存优化门槛重开 C1。
遵守开发规范 §3.1，新增阻塞须证明当前可达核心损害，非阻塞/后置记录责任后继续推进。

不修改 Pi 核心、凭据/模型设置/lockfile，不触发真实模型/目标网络，不 push/改写历史。
C2 内部通过后交回限定外部验收，不自动调用验收模型，不自行进入 C3-C4a。
