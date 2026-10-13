# 历史子任务提示词：离线 SDK launcher

**已由 C6 总任务替代，不再单独使用此 prompt 委派。**
请使用 [C6_AGENT_PRODUCT_DS_PROMPT.md](C6_AGENT_PRODUCT_DS_PROMPT.md)。
以下保留 C6-A 生命周期参考；旧 launcher-only 范围/分支/验收要求不能覆盖整个 C6。

C1-C5 已按已记录范围交付，最新依据 docs/C5_EXTERNAL_REVIEW.md。当前只实施
**离线 SDK 启动器与 Host 生命周期**，完整范围和 required L1-L8 见
[SDK_LAUNCHER_TASK.md](SDK_LAUNCHER_TASK.md)。不重复审计已完成阶段，不启动真实能力实验。

先完整读 Pi_Agent_base/AGENTS.md、开发规范 §3.1、测试/Git 规范、当前阶段入口与 C5
审查限制；读实际 SDK/extension 文档、例子和 API，以及当前 Host/entry/supervisor/
Observer/EventLog/gate/report/observation 的调用链。记录 parent/Pi HEAD 与 dirty。
在任务分支 feat/sdk-launcher 冻结简洁计划、共同矩阵、配置白名单、真实 CLI、资源顺序、
Task/Episode/Session 映射、预算基础覆盖位置、服务生命周期与失败/退出语义，先测试后实现。

目标：用户从干净目录运行一个命令和可信配置，由 Aegis 自动创建真实 Pi SDK + faux runtime、
显式 ResourceLoader allowlist、bind/rebind 与 dispose；复用现有 Campaign Host/Broker/Oracle、
C2 supervisor、gate、单 EventLog writer、报告与只读观察。用户不手工注入 runtime/beforeRun。
provider 默认且仅 faux，不加载用户真实 auth/models、未审查扩展或网络 endpoint。
有限 SDK 请求由可信离线 scenario 驱动；实际动作走原 Broker Worker、结果由 Oracle
独立验证，faux 文本不算任务成功。本轮不实现任意模型规划 Worker或第二套调度/插件平台。

把 SDK 实际绑定到当前 Host Task/attempt/Episode；Host 在安全 idle/settled/committed 边界
执行真正的请求阈值/声明策略轮换。新对象/新 context、同 Episode/授权/有界 RAM；跨 Task/
restart 不重置账本，耗尽/未决 effect/创建或 bind 失败无假 completion。冻结初始 Session
与 rotation 费用定义和唯一 charge owner，不把 budget_after 再当基础重复叠加。
首次 Observer session_start 前已有明确 writer，initial/rotated Session 共用同 gate/日志，
退出解除借用；verify 整个链，不能只看 completion 数量。必要 Host seam 由主 DS 集成，不改 Pi 核心。

run 有界结束并清理 Session/订阅/registry/listener；observe 模式明确常驻到关闭或 signal，
实际 HTTP 可访问，typed controls 复用 Host，bind 失败不阻塞执行；source/report/view 同源。
SIGTERM drain 与 SIGKILL restart 使用真实 child IPC barrier 验证，未决非幂等效果先 reconcile，
不在新 Session 盲重发。report 保留 unknown，不自动调用验收模型。

按任务书 L1-L8 验证 clean CLI 全链、实际自动轮换、跨 Task 预算/拒绝与失败、完整 writer
生命周期、常驻观察/关闭、控制与真实中断恢复、配置拒绝、可复制 runbook。SDK 真实、provider
faux、EventLog/本地 effects/subprocess 真实；保留全部原断言，expected 来自契约，red 记录
行为失败，不能从实现倒推成功或靠 beforeRun 测试 seam 假装自动策略。
有可用子 Agent 才分不相交文件，否则串行如实执行；主 DS 拥有 shared files/最终审查。

相关回归按修改范围一次完成，逐命令保存真实 exit/log；Biome 六类修改范围，Campaign tsc
与当前 74 条基线比较，修新增诊断，不关闭 checkJs/排除代码、不全库清零。F16、性能、样式、
容器/远程/多 Worker、真实模型/网络/目标、任意规划、训练/自动晋升继续 deferred。
新 blocker 仅限当前可达核心损害，不为未知未来功能无限扩大阶段门。

禁止改 Pi 核心、真实凭据/模型设置/lockfile，禁止新增未授权依赖、真实模型/目标/API、
自动验收调用、push/rewrite。现有 SDK seam 确实不可用时记录签名与最小 blocker，继续不受阻工作；
不伪造 Session、签名或输出。例行实现无需逐项批准。

自主按 SDK-A/B/C/D 完成内部里程碑：明确路径暂存、读 staged diff、本地分任务 commit，
Agent 协助注明。维护简洁 plan/matrix/implementation report/runbook，交 exact commands/exit/
私有 logs/对象与上下文/实际 effects/verified chain/ledger/服务关闭证据、required/deferred、
commits/status。完成 internally_verified / awaiting_external_review，交一次限定验收，
不自动进入下一实验阶段。
