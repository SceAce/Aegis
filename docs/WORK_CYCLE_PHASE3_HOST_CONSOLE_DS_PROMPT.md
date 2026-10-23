# DS 委派：Work-cycle 第三阶段 Host Console

将下面提示词整体交给主实现 DS。它的范围和验收以 `docs/WORK_CYCLE_PHASE3_HOST_CONSOLE_IMPLEMENTATION_TASK.md` 为准。

```text
请在 Aegis 实现 Work-cycle 第三阶段：让 run-experiment 用户启动一次 Aegis Console Host，由 Host 管理同 Task/Episode 下的多个短 Pi Sessions；复核 hold settle 后可在安全边界有界轮换，replacement 继续处理相同 hold，而不是把复核或任务状态清空。

这是完整端到端产品任务，不是只改测试/任务书，也不能只把当前一次性 Pi run 包个 while-loop。首先通读：
- docs/WORK_CYCLE_PHASE3_HOST_CONSOLE_IMPLEMENTATION_TASK.md
- docs/STRUCTURED_RAM_AND_WORK_CONTROL.md
- docs/WORK_CYCLE_PHASE2_REMEDIATION_TASK.md
- docs/WORK_CYCLE_TEST_MATRIX.md 与 docs/WORK_CYCLE_IMPLEMENTATION_REPORT.md
- 根 AGENTS.md、docs/DEVELOPMENT_RULES.md、开发/测试/Git规范、目标文件所有 AGENTS.md
- 嵌套 Pi 实际 `docs/sdk.md`、`docs/extensions.md`、Session runtime 示例与真实类型签名

用户已明确批准的设计，不再要求重复确认：
1. 人启动常驻 Aegis Console Host；Pi Session 是 Host 管理的短工作窗口，不是 Episode。
2. 首个副作用必须等待 scoped Intent durable 提交；没有 work unit 的旧/迁移 Episode 有明确 bootstrap review→首个 Intent 引用解锁规则。
3. work-cycle hold 可触发有限 Session rotation；新 Session 继承 hold，不因 rotate 清 gate。只有真实 committed review + 被接受的新 scoped Intent 才能解除对应 hold。
4. Observer不拥有 Session lifecycle；由 Host/Supervisor在真实 settled、安全、请求/工具结清和预算允许时创建 replacement。`agent_end` 不是最终安全边界。
5. RAM 每个 provider request 从同一 EventLog重建；不重放整份 transcript。verified checkpoint+tail可优化，但不授予权限/状态。
6. 使用现有 EventLog/Board/RAM/Experience/Broker/session Supervisor，不建并行权威状态、账本或 Session manager。

一、开工基线和保护

- 记录当前 branch/HEAD/status、嵌套 Pi HEAD/status，逐项确认 owner；当前预计 phase2未提交树，但不得假设。保留所有其他改动。
- `Pi_Agent_base/UI/` 属用户目录：禁止读取、修改、暂存、删除、移动或重置。
- 不改Pi核心、不升级/安装依赖、不访问凭据、不调用真实模型/网络/目标。SDK/faux使用source resolver，event/workspace/session目录全在临时隔离区。
- 用户尚未授权代码提交/暂存/push：只留最终可审查 diff，不做Git写操作。
- 先整理P0入口调用图、测试矩阵、状态转换与责任边界；紧接着编码推进，不停在计划阶段。

二、分阶段实现

P0：核实 `run-experiment.sh` 的 label、新建/`--resume`、workspace、共享agent config、EventLog、Pi进程执行方式。选定常驻Host入口与TTY/交互生命周期；明确谁读 stdin、谁持有Pi runtime、谁保持EventLog写锁。不能启动run-experiment后再另开Pi CLI并让双方并发写同一状态。先记录`rceme-001`复现为成对事件：首个intent之前已有bash effect、3条无unit review、0条proposal.submitted intent、所有Intent tool call被complete_work_review_first挡、Session settled后无handoff completion。

P1：补 scoped Intent 启动门。
- 新Episode/unscoped时，只读workspace观察、知识/工具目录查询、`aegis_propose kind=intent`可用；最后执行permit拒绝任何effect，直到一个非空scope、同Episode、引用有效且被实际accepted的Intent已durable提交。
- 同一assistant response 并发/批处理Intent+effect也必须串行地在effect最终边界重新读取新committed prefix；不得因先生成的决策或工具顺序绕过写前门。
- 迁移的老Episode已有stall、没有当时unit：允许显式bootstrap/no-unit review绑定当前trigger/evidence/真实knowledge selection；新的合法scoped Intent引用review/selection后，仅消费一次并成为第一个work unit。不伪造work_unit_event_id，不让无unit review无来源解锁。
- 保持已有R1事件前缀消费语义，不因替换intent移动消费；review/checkpoint/RAM和Board身份一致。

P2：实现常驻Console Host生命周期。
- Host自身进入一个长生命周期，创建/持有真实Pi `AgentSessionRuntime`与Observer；每个输入只dispatch给现Task/Episode，session settle返回Host继续管理。
- 正常有进展时允许同Session继续；明确暂停/stop/quit返回控制台而不是默认建Session。
- Host只能读已验证的EventLog prefix/现有Owner/预算状态。一个Task/Episode一个有效writer。process/agent谁panic/exit时清理、锁如何释放、下一次启动如何恢复须有确定设计与故障用例。
- 显示清楚Host状态和实际Session id/文件/rotation次数、Task/Episode、hold/reason、预算/blocked原因；复用现有输出/CLI能力，不建UI truth。

P3：settled decision + 有界rotation。
- 从最后真实settled/committed prefix读取review hold、completed work checkpoint、真实context usage/source Session、max requests和budget。
- hold可作为rotation reason但仅在没有pending/unknown effect、EventLog健康、tool/request accounting settled且Supervisor预算允许。轮换完成不消费review/不清hold/不重置两个action counters。
- 同一个unit-complete、source-session-context snapshot、trigger/handoff boundary只能实际rotate一次。被拒绝的attempt不能计成完成；context高水位随新的Session使用情况重新计算，不链式旋转。
- 无unit Intent时不得effect；review-required的Session每次settled可按现有有限rotation policy转到fresh Session，但全局最大轮换/continuation用trusted Host冻结配置绑定，不可由模型设值；达到限制后Host `blocked`或paused，返回有针对性原因，不重启、不伪结清。
- paused/cancelled/waiting_external/terminal/request-budget exhausted和无效authorization不自动resume/rotate。

P4：修复并复用R2 handoff grant/attempt。
- 真正的旧Session idle→begin attempt→durable staged request→Supervisor检查最新scope/pending/预算→runtime.newSession实际replacement→rebind同一Observer/Host gates→replacement first prompt completion绑定request/attempt/from/to/episode/boundary→Host校验唯一completion和session charge。
- process initial bind/普通新进程看见staged file不能完成旧的拒绝request。
- 失败/取消/rebind失败/completion durability失败/出现不同staged request/attempt冲突时不得伪完成或静默删除恢复责任。
- 不可仅靠process.env随机token而忽略文件并发/幂等：基于EventLog/Host ownership保证同一EventLog单写；清理attempt时必须确认仍是自己打开的attempt，不能删掉并发/更新request的grant文件。

P5：EventLog projection性能。
- 复用现有verified checkpoint/cursor设施（若有）；先说明现有文件/offset/hash contract。
- checkpoint必须绑定hash chain prefix、task/episode、policy/config digest和projection version；续用时完整验证prefix与tail顺序。
- full replay与checkpoint+tail覆盖Board/currentIntent、R1 consumptions、review hold、双计数、预算、pending, handoff request/completion和Task状态，精确相等。
- invalid/stale/foreign/tampered/missing/checkpoint-version unknown -> full replay或fail-closed。删除snapshot/cache必须由authoritative EventLog重建同一判断。cache不授予、释放权限，不变更预算，不影响实际permit。
- 不能为追求速度自创第二权威状态机。性能测试只报告大历史上的重放证据与观测成本，不用脆弱毫秒门槛阻塞功能。

P6：集成验收与报告。
- `aegis-work-cycle-console-sdk.mjs` (或职责等同脚本) 用真实SDK/faux走普通run-experiment调用图，而不是只直接调helper。证明Host长驻控制、同Task/Episode多个Session、bootstrap Intent gate、stall review、hold-carried rotation、Intent消费、后续effect、Outcome/unknown边界与shutdown/restart恢复。
- 两个明确进程/运行命令：新label启动；已有同label通过--resume进入同一EventLog并先解决所有recovery/hold。README或run-experiment `--help` 说明Console控制和退出方式。未实现的TUI不宣称已有。
- 继续跑第三阶段任务书HC-01..HC-16及已有R1/R2/K1/G1、phase2 5补测、C2/Observer/knowledge/ledger受影响回归。required清单仅按冻结范围跑一次；Biome/type baseline/module-layout按实际diff执行并报告真实exit。日志新建unique ignored目录。
- 更新phase3任务书的状态/矩阵与既有WORK_CYCLE矩阵/报告的phase3章节，不覆盖早先执行证据。

三、不可接受的实现捷径

- 启动脚本退出后让单独的Pi CLI继续，同时Host也操作相同EventLog。
- 将每个prompt/每个tool/每次review强制新建Session；或每次Session重复扫描同一历史/知识/复核。
- hold本身解锁effect，rotation/Intent/exit=0/knowledge hit/selected Experience当trusted progress。
- 无Intent时允许第一个bash/effect，然后才要求创建unit。
- 为让Run2通过而 initial bind自行完成handoff或提升budget；以Session ID变化代替Supervisor授权消费。
- 将review状态、预算、consumption或trigger只写进mutable latest.json/handoff file；EventLog重放不一致。
- checkpoint缓存不验证EventLog前缀、授权/策略digest或scope。
- 用已有会话 transcript、faux provider回答、event counts代替真实SDK对象替换/实际授权动作/预算/文件效果断言。
- 真实任务失败时伪造Oracle failure；无法安全恢复的unknown effect立即停止并留责任。

四、停止条件

采用既定接口推进，不因命名/普通实现选择停问。只有确实需要Pi core变更、新依赖、扩大授权/网络范围、改Outcome/Episode/Experience独立门、或现有可信EventLog/Session预算契约无法支持时，暂停该具体部分并报告冲突/调用链/最小证据；其他互不依赖任务继续。

五、交付

最终列：实际run-experiment命令与Host生命周期、修改文件/实际调用链、bootstrap行为、状态/恢复/lock方案、full-replay vs checkpoint-tail等价证据、各HC case command/exit/log、C6与普通入口支持差异、stop/resume使用方式、剩余deferred、真实budget/Session charge/事件身份、Git branch/HEAD/status和UI未触碰声明。状态为`internally_verified / awaiting_external_review`，不自称外部通过；没有真实对照实验不得宣称解题率或知识效果提升。
```
