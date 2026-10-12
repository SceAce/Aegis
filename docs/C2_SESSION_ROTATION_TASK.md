# C2 Pi Session 轮换：F14 通过后进入

状态：**用户已同意按阶段主线推进；前置条件为 C1 F14 修复及限定验证通过**。
F14 尚未被确认通过，不在本次文档更新中声称 C2 已启动。

按开发规范 §3.1 冻结阶段目标，不能要求所有历史问题清零。F15 非阻塞、F16 后置，
不再作为进入 C2 的门槛；早先“F14-F16 全修、额外实施授权”的限制已被当前用户决定替代。
完成前置条件后可进入 C2，不重复请求已给出的同一授权，不自行冒充外部验收。

## C2 核心目标

依据 `CAMPAIGN_ARCHITECTURE.md` Phase C2 与 `CAMPAIGN_CONTRACT_BASELINE.md`：

- Host 管理真实 Pi SDK Session，在安全 idle/settled 边界轮换；
- 新 Session 对象/context 真实替换，Episode 与累计预算保持连续；
- 失败/取消不产生假完成，handoff 幂等；Observer 收集、Runtime 拥有状态。

正式实现前完整读实际 SDK 文档/API 与现有 `memory/runtime/handoff*.mjs`，
形成 C2 自身输入/输出/失败语义、required 测试清单与不实现范围。
不使用未经核对的默认两 Session 限额、强制无 pending Oracle 或新事件名作为冻结要求。
不在当前文档更新中编造 API 接线或宣称这些能力已经实现。

## 接收的已知限制

| 项目 | 责任与重新评估条件 |
| --- | --- |
| F15 缓存对象别名 | C2 恢复集成时检查是否重复复用 priorState；未修前每次新读/复制。若正常路径出现账本/副作用损害则重新判断阻塞性 |
| F16 缓存加速与后续接线 | 保留全量 EventLog 重放正确性，不夸大 used_checkpoint。C2 如依赖增量恢复再处理必要接线；其余效率优化留后续，不以 prefix 读取次数卡阶段 |

保留既有反例与真实结果，记录 deferred，不假定后续会自动解决。C2 不自动承担全部历史清理，
只处理与 Session 核心目标直接相关的部分。C3 Broker/Oracle adapters、C4 UI 等不提前纳入。
真实模型/目标/网络、Pi 核心和新增依赖仍受原有授权边界约束，进入 C2 不扩大这些权限。

当前 F14 实施提示词：`C1_BOUNDARY_FOLLOWUP_DS_PROMPT.md`。
