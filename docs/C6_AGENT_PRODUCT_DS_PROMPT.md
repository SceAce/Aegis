# 给主 DS：实施 C6 模型 Agent 与经验闭环代码交付

用户已确认：原 R1-R6 的代码工作合并为一个 C6 开发任务，真实模型试运行、效果对照与
日常试用以后单独处理。当前只委派代码、工程测试与操作文档；不执行真实模型/外部目标实验。
完整范围以 [C6_AGENT_PRODUCT_TASK.md](C6_AGENT_PRODUCT_TASK.md) 为准，路线见
[AEGIS_PRODUCT_ROADMAP.md](AEGIS_PRODUCT_ROADMAP.md)。C1-C5 保持既有范围交付，最新审查 C5_EXTERNAL_REVIEW.md。

完整读 Pi_Agent_base/AGENTS.md、开发规范 §3.1、测试/Git/主 DS 流程、现行 schema/已确认架构、
C5 限制与实际模块。使用 SDK 时完整读实际 SDK/extension docs/examples/API，核对签名。
记录 parent/Pi HEAD/dirty，在 feat/c6-agent-product 冻结一份简洁 plan、共享契约和 required 矩阵，
先生成正负产品测试再实现。SDK_LAUNCHER_TASK.md 的 L1-L8 纳入 C6-A；旧 launcher-only/faux-only
限制不能缩减整个 C6 的 Worker、provider 配置接口与学习交付。

交付一条用户无需拼 runtime/beforeRun 的产品链：可信配置/Manifest → Host/SDK/当前 Task-Episode →
Router → 模型结构化 Claim/Action/动态任务 → 原 Broker/独立 Oracle → committed evidence/Replay/
Compiler/经验派生存储 → 短 Session/预算/控制/恢复 → 常驻只读观察/report/测量。
复用已有 Scheduler/Host/Broker/Observer/Oracle/Compiler/Router/learning bridge，不重建等价框架。
开发使用真实 Pi SDK + faux、真实本地临时 effects/subprocess/HTTP；faux 只证明接线/机制。

按任务书 C6-A 至 F 自主推进内部小任务：

- A：SDK initial/rotate/bind/rebind/dispose、实际 Task/Episode binding、同一 gate/writer、安全策略与
  跨 Task/restart 账本、typed control/signal cleanup、常驻 observation。
- B：实际 SDK 模型 tool decision 控制 Worker 动作和动态 proposal，有限 observe/execute/verify loop；
  首个结构化数据修复/转换任务族，独立 Oracle 正负/unknown 探针；request/tool 自动循环也调用前
  准入/记账，ROM/tools/RAM/history/输出预留的总上下文有明确门与估算/实测区别。
- C：实际 Campaign 证据接现 learning bridge/resolver，真实独立 reset/replay、显式 Host policy/proof IDs
  编译，跨运行 refs/可信导入与删除派生物重建；route-before-model、direct 零规划、habit 只补参数、
  candidate 不当 hint、变化/冲突/异常退出捷径，实际 action/outcome/data-use refs 可追溯。
- D：显式 SDK provider/model/local endpoint/私有凭据引用与创建接口、失败和 usage 适配；
  离线替身验证参数传递/拒绝与启动，不读取真实凭据、不请求真实模型。默认开发模式 faux。
- E：基于产品入口/report 的单次/有限清单 runner、固定配置/版本/seed/策略、逐 attempt 测量导出；
  所有失败/unknown 保留，不填零冒充成本，不造 benchmark 平台或统计收益结论。
- F：临时副本小型代码工程作为第二 adapter 测试族，受控 read/patch/registered tests，验收标准
  外部只读，模型不能改裁判；同一产品链 faux 证明接入。完成 clean runbook、集成回归与自审。

模型输出永远不能增加 grant、注册任意脚本、写可信 Outcome 或 active。动作包装层重验最终参数/
version/digest/状态，不能仅靠工具 allowlist。轮换不能制造独立 Episode、无假 completion；未决
非幂等效果先 reconcile，不换 ID 或新 Session 重发。promote_experience:false 默认保持；
有界机械 RAM 不丢必需约束，测不到 token/费用写 unknown，所有权/账本只有明确 charge owner。

按 C6-P1-P8 验收真实 CLI 全链、轮换/拒绝、自动 SDK 循环预算/总输入、完整 writer/故障恢复、
实际学习/跨运行重建、provider 离线接口、HTTP/测量/退出、第二任务族与复现。
不要把“实验后置”解释成不用工程测试；保留原断言，expected 来自独立标准，有限关键 mutation，
实际副作用/新对象/链/账本作为证据，不凭返回字符串/route 标签勾选。

共享 Host/entry/Observer/EventLog/config/resolver/index/report/runner 主 DS 管理；有子 Agent
能力才并行不相交文件，否则串行如实执行。内部里程碑审查后直接继续，不逐 helper/commit 请示。
相关回归用显式清单，SDK source resolver；日志逐命令捕获真实 exit。Biome 修改范围，类型检查
覆盖 C6 与实际 imports，记录每个配置基线、修新增诊断，不排除/关闭检查，也不全库清零。

不改 embedded Pi、真实 auth/models/settings、lockfile，不新增未授权依赖、不读取默认用户资源，
不运行真实 API/provider/外部目标、不自动调用验收模型、不 push/rewrite。未知 SDK blocker 指明
真实签名/受阻项，其他工作继续，不伪造 Session。F16/缓存优化/样式/复杂检索/多 Worker/容器/
任意经验组合/权重训练后置；只有当前可达核心损害新增 blocker，不无限扩大范围。

逐路径暂存、读 staged diff、按里程碑本地 commit，注明 Agent 协助。维护一份 C6 plan/matrix/
implementation report/runbook，交 actual commands/exit/private logs、effects/对象/context/verified chain/
ledger/经验源重建证据、required/deferred、provider 未实测限制与 commits/status。
完成 internally_verified / awaiting_external_review，交一次 C6 限定工程验收。
真实模型 pilot、经验 A/B/C/D 与长短 Session 效果、第二任务族迁移/日常试用另立实验任务，
不因代码全绿自行启动，也不把工程 direct 节省请求称作统计学习提升。
