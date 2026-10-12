# 给主 DS：C4 报告与验收包

下一轮任务只做 C4，不重开已验收 C1/C2/C3，不进入 UI/C5/真实能力实验。
先完整读 Agent 入口、开发规范 §3.1、测试/Git 规范、`docs/C3_EXTERNAL_REVIEW.md`、
`docs/C4_REPORT_TASK.md`，以及架构的 reporting/bundle 章节。
再完整读实际 report/aggregate/resolver/projection/EventLog 与 C3 入口和关联测试。

在干净起点建 feat/c4-report，记录分支/HEAD/status。先冻结简洁接口、字段白名单、
digest 覆盖、条目/字节界限与 required 测试矩阵，再按依赖完成任务，一次阶段验收。
有子 Agent 工具则按文件所有权委派，无则串行如实报告。

交付一个可运行的只读导出入口，从 immutable Manifest + verified committed events +
有界可信 evidence 索引重建：campaign-report.json、campaign-report.md、acceptance-bundle.json、
reviewer-prompt.md。复用 report.mjs 和既有判断逻辑，不造新 Oracle/执行框架。

冻结核心要求：
- Task/Stage/Outcome、动态队列、unknown/冲突/更正/拒绝/故障与授权证据可追溯；
- 动作/Session/预算来自去重的 committed 记录，不拿 Host 内存 counters/summary/checkpoint
  的零值冒充实测，不把 Session 次数当独立 Episode；无法观测的值写 null/unknown；
- 删除派生产物后可同源重建同 semantic/report/bundle digest，bundle 覆盖 report_digest；
- 字段白名单与脱敏，无凭据/flag/Bearer/私钥/无限 raw tool transcript；超限显式处理；
- 导出不改源、不跑 Worker/Broker/真实模型/网络；本地 validator 识别缺字段/ref/digest，
  reviewer prompt 要求 accepted/rejected/inconclusive/needs_more_evidence，不自动调用验收模型。

按任务书 8 项 required 做正常/负例/重建/隐私/计数产品测试，expected 来自规格而非
同一被测聚合器输出。先 red 再实现，有限 mutation 与风险相称；相关回归一次完成，
新修改/失败才复跑，不扩大到全仓库完美。F16、旧 65 个类型导入诊断按基线如实报告。

复用既有模块和简洁 C4 plan/matrix/report，按小任务明确路径暂存、审查、本地 commit，
不 push/rewrite，不改 Pi/凭据/模型/lockfile，不安装未授权依赖。
报告实际命令、exit、ignored log、产物与证据、required/deferred、commits/status 和限制。
完成后 internally_verified / awaiting_external_review，交回一次限定 C4 外部验收；
不启动 C4a UI，不自动调用任何验收模型。
