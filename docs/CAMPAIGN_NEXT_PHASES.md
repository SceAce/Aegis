# C2 之后的推进计划

当前状态：**C5 本轮审查与授权修复完成，下一轮离线 SDK launcher**。
当前证据见 `C5_EXTERNAL_REVIEW.md`，后续任务/提示词为 `SDK_LAUNCHER_TASK.md` 与
`SDK_LAUNCHER_DS_PROMPT.md`。C1-C5 按记录范围交付；C5 CLI 已支持离线总装，SDK runtime
仍由 caller 提供。F16/74 条旧类型诊断后置，不重开已完成阶段。

下一轮补齐自动 SDK 启动、当前 Task/Episode 绑定、实际请求阈值轮换和常驻观察/退出/恢复。
这是离线部署任务，不启用付费模型/目标。之后用户选择任务、provider、授权、预算和对照，
再启动真实能力实验。历史 C3 里程碑保留为已完成记录，不再次委派。

## 当前能力与下一缺口

- C1：持久队列、动态任务准入、预算与恢复已按冻结范围验收。
- C2：真实 Pi SDK Host 可调用 Session 轮换及限定预算/完成验证已验收。
- C3：Manifest → Worker → Broker → 实际本地效果 → Oracle → Task 的链已验证，支持动态任务与恢复。
- C4/C4a：报告/只读观察从同一 verified committed stream 重建，坏源不显示成功。
- C5：配置入口接上述模块；SDK 注入路径验证真实轮换、完整写链及跨 Episode 预算，
  CLI 的自动 SDK 创建/Task 绑定/轮换策略仍需 launcher，观察服务目前随 entry 调用结束。

下一步部署上述离线 SDK 生命周期，复用现有报告与观察模块。

## 阶段路线

| 阶段 | 用户可见交付 | 核心验收 / 出口 | 明确后置 |
| --- | --- | --- | --- |
| C3 执行闭环 | 一个 Host 入口运行 Manifest；受限动作经现有 Broker，确定性 Oracle 验证，支持 delayed 与恢复 | 正常两任务/动态任务有真实本地效果与绑定结果；拒绝/日志故障不执行，未决效果不盲重发；C2 调用/账本归属有接线证据 | 远程目标、任意 shell、通用平台 adapter、容器、并行 Worker |
| C4 汇总与验收产物 | 从 committed stream 生成 JSON/Markdown report、bounded acceptance bundle | 删除派生产物可重建同 digest；缺证据/unknown/故障可见；不含机密；不自动调用验收模型 | 美化、搜索、复杂统计、缓存加速 |
| C4a 观察界面 | localhost 只读白板/队列/动作与 Pi 查看命令 | UI/命令读同一 committed 投影；不授予权限、不成为调度依赖 | 远程共享、多用户、复杂控制面 |
| C5 整体集成 | 单一入口串起静态/动态任务、动作、Session、Oracle、恢复、报告 | SDK/faux + 本地文件/进程实证，正常与关键中断路径；用户可按文档复现 | 未授权真实目标/模型/网络、跨主机 exactly-once |
| 能力实验（可选称 C6） | 用户选定任务上的经验复用对照，测探索成本、完成时间和成功证据 | 先定义任务/授权/预算/对照与独立 Episode；保留失败和 unknown，不把单次演示称学习提升 | 权重训练、任意经验组合、规模化自动攻击 |

现有架构正式编号到 C5（并含 C4a），未定义独立 C6；表中“能力实验/C6”只是建议名称，
不改旧契约、不自动授权真实实验。C5 的真实 capability 部分也必须由用户启动并明确作用域。

## C3 内部里程碑（一次总委派，一次阶段验收）

1. **C3-A**：冻结共同契约，建立 Campaign 执行入口和单 writer/预算/注册表所有权。
2. **C3-B**：接现有 Broker + 隔离本地 fixture + 确定性 Stage/Task Oracle，跑通实际效果。
3. **C3-C**：复用注册脚本形成受监督 workspace adapter，加入 delayed/reconcile 与 C2 安全轮换接线。
4. **C3-D**：产品入口正负例、必要中断恢复、相关回归，交一次限定外部验收。

里程碑由主 DS按依赖自主完成并分任务提交，不为每个 helper 请求批准或外部审计。
以现有模块接线为主，不新增通用调度/插件/Oracle 平台。
实施任务书：`C3_EXECUTION_TASK.md`；可交给 DS 的提示词：`C3_EXECUTION_DS_PROMPT.md`。
上述 C3 里程碑已由 DS 实施并经审查集中修复，当前不再委派同一任务。
C4/C4a/C5 均已按限定范围交付；上文为历史里程碑。当前下一任务以 SDK launcher 任务书为准。

## 遗留项归属

| 项目 | 处理 |
| --- | --- |
| F16 缓存增量效率 | 继续 deferred；全量权威重放正确即可，只在实际恢复依赖处做必要接线 |
| 旧 tsc 导入诊断 | 记录实际 exit 与差异，不清库、不降低检查，也不因此阻塞无关里程碑 |
| C2 预算基础消耗/轮换增量 | C3 Host 明确唯一记账来源与基线覆盖位置，不能把 budget_after 再当不含增量的基础账本 |
| C2 自动轮换入口 | Host 可调用入口已验证；实际 SDK Task 绑定/阈值策略由下一轮 launcher 补齐，不回头重审 C2 helper |
| 工作区隔离 | 显式 workspace_is_sandbox=false；本地测试只操作临时授权目录，不声称进程/网络强隔离 |

阶段开始冻结 required/non_blocking/deferred，新增阻塞必须证明当前可达核心损害。
性能、实现风格和后续功能不得扩为当前门槛；后置不等于自动修复，进入责任阶段时显式检查。
复用简洁计划/矩阵/实现报告和 Git 记录，不反复生成长审计链。
