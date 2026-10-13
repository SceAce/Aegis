# C6-A 参考：离线 SDK 启动器与 Host 生命周期

状态：**纳入 C6，不再单独委派**。用户将原 R1-R6 代码合并为 C6，见
[C6_AGENT_PRODUCT_TASK.md](C6_AGENT_PRODUCT_TASK.md)。以下保留生命周期/L1-L8 要求，
作为 C6-A 子任务依据；其中 faux-only、非模型 Worker 等限制仅描述这个子任务，
整个 C6 的 provider 配置接口、模型 Worker 与学习交付以总任务书为准。
原独立分支/最终验收安排由 C6 分支和一次总工程验收替代，实验以后单独处理。
C5 限定审查见 `C5_EXTERNAL_REVIEW.md`，不重开旧阶段。

## 冻结目标

用户从干净临时目录运行一个 Aegis-owned 命令/可信配置，即可创建并管理真实 Pi SDK + faux
runtime，复用现有 Campaign Host/Broker/Oracle、gate、EventLog、Session supervisor、report 和
observation。用户不再自己拼 resource loader、bind/rebind、runtime 或 beforeRun 回调。

交付建议入口：`Pi_Agent_base/memory/campaign/sdk-entry.mjs`，对应服务模块由主 DS 选择。
实现前冻结真实 CLI、配置白名单、返回/退出语义。默认且唯一 provider 为离线 faux；
真实 provider、凭据加载与任意外部 endpoint 不在本任务中。SDK 启动命令使用实际 source resolver。

离线 scenario 的 provider 响应/有限 prompt 由可信 fixture 定义，不能从模型文本动态加载 JS。
本轮以 SDK 生命周期总装为目标；动作效果仍由既有 Broker Worker 执行，Oracle 独立读真实产物。
不新增任意模型规划 Worker；报告必须区分 SDK 请求与 Broker 动作，不能把 faux ready 文本算成功。

## 核心契约

| 接口/状态 | 必须行为与失败语义 |
| --- | --- |
| 配置/启动 | 先验证 Manifest、paths、adapter、预算及离线 SDK 配置；未知 provider/扩展/配置拒绝，不读取用户默认 auth/models/sessions |
| 资源与 writer | Host writer 在首次 Observer session_start/请求之前可借用；initial/rotated Session 使用同一个 EventLog 和 gate；避免旧实例/旧尾摘要或注册残留 |
| 任务绑定 | 真实当前 Campaign Task/attempt/Episode 来自 Host committed 状态；SDK 当前 Task 不能是脱离调度的测试标签；轮换保留该 Episode，切到下一 Task 按既有模型显式绑定 |
| 请求/轮换策略 | 有界请求由可信 launcher 驱动；max_requests_per_session/已声明边界策略实际执行，不仅存配置；安全 idle/settled/committed、预算允许才调用 C2；拒绝无 newSession/假 completion |
| 账本 | 冻结初始 Session 与 rotation 的成本定义、基础消耗覆盖位置、跨 Task/restart 增量与 reserved；一个明确 charge owner，不从多个快照重复累加，不增总限额 |
| 动作/结果 | SDK direct tools 在 Campaign 生命周期受同一 gate 拒绝；合法本地动作走原 Broker，任务成功只由匹配可信 Oracle/Outcome 决定 |
| 服务生命周期 | 执行模式完成/失败/暂停/取消后有界 cleanup；观察模式保持 loopback listener 到显式关闭/signal，能实际打开；服务 bind 失败不阻止执行 |
| 控制/恢复 | 控制复用 typed Host 命令；不旁路 writer；SIGTERM drain 与 SIGKILL 恢复区别记录，未决非幂等效果先 reconcile，不新 Session 盲重发 |
| 报告 | 从 Manifest/verified committed stream 导出，同源只读；未知成本为 null/unknown，Session 不算独立 Episode；不自动调用验收模型 |

不得用“预先开一个无关 SDK Episode，再在 beforeRun 手动 rotate”的路径代替本轮任务绑定
与自动策略证明。已有 helper 测试仍保留作为回归。真实 SDK 对象、上下文与 Session ID 都需观测。

## required 产品测试

共同矩阵在实现前生成，采用下列有界清单；不把全目录 wildcard 或 F16 加入 gate。

| case_id | 产品场景与证据 |
| --- | --- |
| SDK-L1 | 从 clean temp layout 用实际 CLI 启动两任务/一个受限动态任务；真实 SDK/faux 请求和原 Broker 本地效果，Task/Outcome 归属匹配，report/view 与源一致；无需 caller 注入 runtime/beforeRun |
| SDK-L2 | 小请求阈值触发 Host 自动轮换一次；真正新 AgentSession/新 context，无旧完整 transcript；同一当前 Task/Episode/授权/RAM，completion 与账本各一次；初始和轮换后 direct write/bash/edit 无效果 |
| SDK-L3 | 换 Task/重启后旧轮换耗用保留，耗尽拒绝创建；0/1 边界有合法控制；pending effect/未 settled 拒绝；创建/bind 失败不产生 completion，清理后可再次启动 |
| SDK-L4 | 首次 SDK 启动、rotation、Host actions、后续 SDK 请求/退出的整个 stream verifyChain；完成/故障后 registry、订阅、Session、listener 清理；重启不留下第二 writer |
| SDK-L5 | 常驻 observe 模式实际 HTTP 可访问、与导出同源且无写路由；source bytes 不变；占用端口执行仍完成；SIGTERM 后可重新绑定端口 |
| SDK-L6 | typed pause/cancel + restart 不复活；真实 child IPC barrier 后 SIGKILL，恢复核对真实产物，无重复 effect；有界 timeout/资源清理 |
| SDK-L7 | 未配置/未知 provider、未审查 extension、错误 grant/预算/paths 启动拒绝且无 SDK 创建/效果；使用临时/in-memory auth，证据不含真实凭据，正常合法配置通过 |
| SDK-L8 | documented commands 从干净目录可复制；明确 source resolver、配置生成、目录、退出码、run/observe 的生命周期、控制/恢复/关闭与导出步骤；由真实 subprocess 运行验证 |

按修改范围跑 C5 四个原 suite + external-boundaries，以及受影响的 C2 supervisor/SDK、
Observer 与 C3 gate/恢复、C4/C4a 回归；逐命令捕获 exit/log。Biome 修改范围，Campaign tsc
如实与当前 74 条基线比较；新增诊断修复，不关检查或扩大为全库清零。
已有不变量的回归测试不削弱。适量旧代码 red/关键 guard mutation，不能把 import 错误算行为证明。

## 内部里程碑与 owner

1. SDK-A：记录 parent/Pi HEAD/dirty；完整读规范、当前模块、实际 SDK/extension docs/examples/API。
   主 DS 冻结配置/CLI、资源顺序、Task/Episode mapping、ledger、服务状态和测试矩阵。
2. SDK-B：创建真实 SDK、固定 allowlist ResourceLoader、bind/rebind/dispose；单 writer 与 gate
   接入产品启动/退出，先完成 L1/L4/L7 合法和失败路径。
3. SDK-C：必要 Host 边界 hook、实际请求阈值轮换、跨 Task 绑定与账本；完成 L2/L3。
   hook 由主 DS 管理，不新建调度器或修改 Pi 核心。
4. SDK-D：常驻只读观察、typed control/cleanup/restart、report/runbook；完成 L5/L6/L8，
   聚焦回归和最终 diff 审查，提交内部交付。

共享 Host/entry/Observer/EventLog/config/index 由主 DS 管理；子 DS 只拥有不相交测试/模块。
无子 Agent 能力则串行并如实报告，不为此创建子 Agent 平台。
计划/矩阵/报告可使用 `SDK_LAUNCHER_WORK_PLAN.md`、`SDK_LAUNCHER_TEST_MATRIX.md`、
`SDK_LAUNCHER_IMPLEMENTATION_REPORT.md` 与 `SDK_LAUNCHER_RUNBOOK.md`，小修复复用，不造长审计链。

## 范围、停止与交付

F16/旧类型库治理、性能/样式、container/remote/multi-worker、任意模型规划/真实模型能力、
经验训练/自动晋升/统计学习对照继续后置。workspace 与 loopback 的已声明限制保持。
已有问题只有当前新上线路径可复现核心损害才新增阻塞，记录责任与重新评估条件。

本任务书不授权修改 embedded Pi、凭据/模型设置/lockfile、新依赖、真实 API/外部目标调用。
如必要 API 在现有 Pi 不可实现，指出真实签名、最小 Host seam 和受阻场景，其余独立工作继续，
不以假对象/随机标签冒充 Session。按已有授权自主完成小任务，不逐 helper 请示。

实施时建 `feat/sdk-launcher`，明确路径暂存并检查 staged diff，分里程碑本地提交，不 push/rewrite。
完成给出 exact command/exit、ignored logs、对象/context/效果/链/账本/服务生命周期证据、
required/deferred、commits/准确 status，标 `internally_verified / awaiting_external_review`。
交一次限定 launcher 验收；之后用户再选择具体任务、provider、授权和预算启动真实能力实验。
