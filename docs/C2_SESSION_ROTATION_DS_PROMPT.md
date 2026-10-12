# 给主 DS：开始 C2 Session 轮换

历史初始实施提示词。当前实现 `702c63c` 已交付，限定外部复核只要求收尾 E1/E2，
请执行 `C2_SESSION_ROTATION_FIX_PROMPT.md`，不重复从头实施或扩大范围。

C1 已在冻结范围内通过外部验收，记录为 docs/C1_F14_EXTERNAL_ACCEPTANCE.md。
用户已同意 C2，直接开始，不重复请求阶段授权，不再因后置 F16 重开 C1。

先完整阅读：
- Pi_Agent_base/AGENTS.md
- docs/AGENT_DEVELOPMENT_STANDARD.md，重点 §3.1
- docs/AGENT_TESTING_STANDARD.md
- docs/GIT_STANDARD.md
- docs/C2_SESSION_ROTATION_TASK.md
- docs/CAMPAIGN_ARCHITECTURE.md 的 §3.3 和 Phase C2
- docs/CAMPAIGN_CONTRACT_BASELINE.md 中 Session/Episode/预算/证据约束
再完整读实际使用的 Pi SDK 文档/例子/API 类型、现有 handoff 与关联调用者/测试。
不能凭记忆编造 newSession/createSession 参数；按真实内嵌 Pi 版本核对，记录 HEAD/dirty 状态。

在干净起点创建 feat/c2-session-rotation 任务分支，先记录 Git 状态与检查基线，
形成简洁 C2 计划和测试矩阵，冻结契约/安全边界/required 清单后实现。
有子 Agent 工具则按独立文件范围委派；无则串行切换测试/实现/审查角色并如实报告。

实现目标严格按任务书：Host/scheduler 通过真实 Pi SDK 在安全 idle/settled 边界轮换，
真正创建新 Session/Runtime/context；保留同一 Episode、授权、Stage、有效事实、unknown、
pending recovery 与累计预算，用 committed state 有界 RAM，不复制整个旧 transcript。
settle→checkpoint→create→bind 成功后才记录一次 handoff.completed；失败/取消/重放不假完成、
不双记账、不重跑未确认副作用。复用已有 handoff/runtime，不再造平行框架。

测试使用真实 SDK + faux provider，至少一个 Host/scheduler 产品入口用例证明对象/context
真实替换与正确绑定，不能只看 ID 或返回 text。覆盖正常连续性、安全/预算拒绝、失败/取消、
幂等和必要恢复。先 red，再实现，再聚焦验证与相关回归；使用 source-resolver 正确入口。
根据实际 diff 运行 Biome/类型检查，诚实报告已有 tsc 导入错误；mutation 与风险相称。

范围纪律：F15 已局部修复；F16 缓存加速后置，保留全量 EventLog 重放正确性即可。
不要将 prefix 读取次数、性能优化或后续阶段能力变成 C2 门槛。若实际 Session 恢复依赖
接线则仅实现必要部分。新阻塞须证明当前核心损害并说明不能后置原因。
保留后置反例与真实结果，required/deferred 分开报告，不删除断言或宣称全量绿色。

只做 C2，不实现 C3 Broker/Oracle adapters 或 C4/C4a UI，不运行真实模型/目标/网络，
不修改 embedded Pi 核心/凭据/模型设置/lockfile，不新增未授权依赖。
遵守 Git 规范逐任务明确路径暂存、审查并本地 commit，不 push、不改写历史。

维护任务书指定的简洁计划/矩阵/实现报告，写实际命令、退出码、日志引用、产品入口证据、
分支/commits/status、required/deferred 结果和限制，不重复生成无关长文档。
完成后标 internally_verified / awaiting_external_review，交回一次限定 C2 外部验收。
不自动调用验收模型，不自行标外部通过或进入 C3。
