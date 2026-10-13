# Aegis：C6 代码交付与独立实验路线

状态：**用户确认的任务划分**。原 R1-R6 混合了代码和实验，用户明确要求：
代码编写统一归入 C6，实验在 C6 工程验收后单独处理。
C1-C5 保持已有交付范围；R1-R6 退为历史规划来源，不再作为六次独立委派。
本轮只调整规划，未启动 C6 实现或真实模型/外部目标实验。

当前总开发任务：[C6_AGENT_PRODUCT_TASK.md](C6_AGENT_PRODUCT_TASK.md)。
完整提示词：[C6_AGENT_PRODUCT_DS_PROMPT.md](C6_AGENT_PRODUCT_DS_PROMPT.md)。
原 SDK launcher 要求纳入 C6-A，不再单独作为阶段终点。

## 1. 最终用户效果与两种验收

历史目标沿用 THINK.md 当前架构、ARCHITECTURE_DECISIONS.md 已确认决定、MEMORY_SCHEMA.md：

- 给目标、目录、验收条件和预算，一次启动；模型观察、提出结构化决策和受限动态任务，
  Host 准入，Broker 执行，Oracle 验证；可观察、暂停、取消、恢复。
- 图板/已提交状态保存进度，短 Session 处理局部目标；保留授权、事实、unknown、未决效果与预算，
  可接用户指定模型/本地小模型。
- 可信独立经历通过隔离 Replay/Compiler 成为 when/do/expect/scope 经验；direct 复用路径，
  habit 只补参数，hint 指出待确认差异，deliberate 做有界探索；环境变化/冲突/异常退出捷径。
- 在新任务变体上测量重复探索、成本和正确性，再扩到代码工程及日常学习。

**C6 验收代码与机制**：运行接口、工具与证据链、实际计量、学习/恢复/服务生命周期正确。
**实验验收效果**：特定模型能否完成任务、经验是否提效、短窗口是否有效、能否迁移到新任务。
工程通过不代替效果数据；实验无收益也不反向抹掉已验证机制，但可反馈具体产品缺陷。

## 2. 现有基础与复用原则

| 当前实现 | 已有基础 | C6 接线 |
| --- | --- | --- |
| Campaign Scheduler/Host/Broker/Oracle | 静态/动态任务、本地效果、独立判定、预算、控制恢复 | SDK 模型 Worker 的决策真实控制动作，替代该模式硬编码 defaultPlan |
| c5-entry/C5 SDK suite | 离线配置、caller runtime、真实轮换/共享写链 | 自动 SDK 创建、实际 Task/Episode binding、策略与常驻服务 |
| State/Board/RAM | 事实/Claim 分开、逐请求 RAM、handoff | 总输入包含 ROM/tools/history/输出预留，实际请求/tool 账本与测量 |
| Compiler/Router/Workflow/learning bridge/store | proof 门、四模式、可信命令、隔离 Replay、派生 store 校验 | Campaign 证据、跨运行学习范围、route-before-model、显式编译和可重建源 |
| C4/C4a | 只读同源报告/观察、隐私、坏源拒绝成功 | 实际 SDK/经验/usage 展示、常驻监听/退出和实验可用导出 |
| fixture prototype | 受限 JSON 2+1、route-before-model | 保留回归，不替代新任务族/迁移效果证据 |

前一规划提交 `942a0c8` 形成时复跑四个现有脚本均 exit 0：learning-bridge-e、
observer-data-use-pi、learning-commands-pi、fixture-pi-orchestrator（SDK 使用 source resolver）。
argv/exit/log 在 ignored runtime/dev/roadmap-baseline/results.json；本次文档调整未重复执行。
历史 G/H evidence_refs 缺口已由当前 Observer artifact/data 记录及 resolver/Compiler 测试补齐；
C6 检查 Campaign 来源/跨日志证据/replay，不再次派旧修复，不推倒重写已有学习模块。

继续 Event→Episode→Outcome→Experience，Session 不是独立 Episode，workspace 不是 OS sandbox。
原始记录、模型文本、工具退出码、active 数量都不能直接证明可靠经验或学习收益。

## 3. 原 R1-R6 如何归入新安排

| 原工作 | C6 的代码交付 | 独立实验工作 |
| --- | --- | --- |
| R1 SDK launcher | C6-A：SDK/任务绑定/轮换/共享 gate-writer/服务/控制恢复 | 后续实际模型生命周期运行数据 |
| R2 模型 Worker/任务族 | C6-B：模型决策入口、动态提案、实际调用预算/总输入、首族 adapter/Oracle | 模型在未脚本化任务上的能力 |
| R3 Campaign 经验闭环 | C6-C：证据/隔离 Replay/编译/跨运行存储/路由/退场 | 经验是否减少探索及误激活 |
| R4 provider/本地模型 | C6-D：SDK 已支持 provider 的显式配置/创建/隔离引用/usage/错误接口，离线验证 | 用户选模型/endpoint/预算，真实 pilot 与上下文校准 |
| R5 效果对照 | C6-E：固定配置/版本/seed/策略、单次或有限清单 runner、逐 attempt 测量/report | 数据集、分组、样本量、随机顺序、统计/解释与实际对照 |
| R6 第二任务族/日常试用 | C6-F：小型代码工程 adapter/只读验收标准/同链 faux 产品测试与 runbook | 泛化、留出变体、实际使用节省；陪学方向另选任务标准 |

第二任务族的 adapter/Oracle 和复现入口属于代码交付；实际迁移收益属于实验。
C6 不同时实现开放式课程辅导、任意 shell、复杂通用 benchmark 平台或权重训练。

## 4. C6 执行顺序与完成边界

```text
冻结 plan/契约/共同矩阵
  → C6-A SDK/Host 生命周期
  → C6-B 模型 Worker/预算/首个任务族
  → C6-C Campaign 学习闭环
  → C6-D provider 配置接口 + C6-E 测量与运行支撑
  → C6-F 第二任务族/完整集成/操作文档
  → 一次 C6 限定工程验收
  → 单独布置实验
```

这是**一次总开发任务**。主 DS 自行拆分、测试、实现、审查、集成与本地提交；
正常内部里程碑完成后继续依赖任务，不逐 helper/子任务请求授权或外部验收。
共享 Host/entry/Observer/EventLog/config/resolver/report/runner 由主 DS 管理，
独立配置/测试可并行；没有子 Agent 就串行如实执行。

C6 required 使用真实 SDK + faux、本地文件/进程、真实隔离 replay、loopback HTTP、
实际 CLI 与中断恢复，覆盖任务书 C6-P1-P8。provider 创建接口用离线替身检查，
不能因为实验后置跳过调用前预算门、Oracle 正负/unknown 样本、学习重建或模型决策测试。
开发中不实际加载用户凭据或调用真实 provider，默认 faux；具体模型未实测限制列明。

C6 完成后有可供实验使用的产品代码和操作接口，状态为工程验证完成，
不称“真实模型已完成任务”或“经验提升成立”。文档仅提供模式/测量接口，
不提前固化样本量、统计显著性或必然正收益。

## 5. 后续独立实验（以后单独委派）

### E1：实际模型试运行与上下文校准

用户指定 provider/model/endpoint、目录与授权、请求/时间/费用预算。
从干净目录运行首个任务族无经验/多步决策/有经验/轮换恢复的小规模 pilot。
测后端实际 usage、输入峰值/估算误差、有效工作窗口、成功/失败/unknown 与停止条件。
实际失败如实记录；不替模型执行好结果再称成功。只证明指定范围运行，不据 smoke 宣称学习收益。

### E2：经验及短上下文效果对照

在运行前冻结数据集、编译集/留出集/变化集、经验版本、比较指标、最小有用差异和样本预算。

- 经验实验固定模型/工具/Oracle/预算/初态/上下文策略：A 无经验、B 有界原始经历、
  C active 经验；D 错误/过期经验做退场和负迁移压力组。C 内记录实际 direct/habit/hint 分布，
  不默认做巨大模式全组合，不把 candidate 冒充 active。
- 上下文实验固定经验策略，另比较长 Session 与短 Session+机械图板 RAM；
  缺交接信息消融仅限可丢弃任务，授权/guard/预算仍保留，不同时改多个变量再做单因素归因。
- 使用配对变体/随机或交错顺序，记录每个 attempt，先 pilot 估方差与费用再定重复数；
  样本不足标探索性，保留失败/unknown，不筛掉不利结果。

指标：可信任务成功率、首次成功时间、模型请求/tool 次数、重复探索、累计/峰值输入、
后端 token/延迟/金额（不可得 unknown）、交接丢失/重复 effect、误激活/负迁移、Oracle 探针结果。
两次独立验证是工程门槛，不等于统计可靠性或跨任务泛化。
得到支持、不支持或证据不足的报告；无收益时定位识别/绑定/验证成本/模型限制并反馈具体问题，
不靠关 guard、少验证、隐藏失败或新平台制造提升。

### E3：第二任务族迁移与日常试用

用 C6 的代码工程 adapter 在未见变体上测实际模型与经验适用性，验收标准独立只读；
不匹配 scope 明确拒绝，经验版本在评估期间冻结。记录用户决策次数与实际节省。
需要陪学时再冻结课程/WP 的引用定位、理解保留题、人类纠正与迟到结果标准，
反馈不足保留 unknown。论文/WP 文本不自动授予 Fact/active 状态。

这些实验不会在 C6 内执行。本次划分不决定实验模型、预算、样本规模或效果结论。

## 6. 持续执行规则

- 已验收机制复用；只修当前可达假成功、授权越界、重复 effect、预算错误或权威数据损坏。
  风格/性能/未来功能不无限扩大阶段，主 DS 按开发规范 §3.1 分类。
- C6 只维护一份 plan/matrix/report/runbook；小修复更新证据和提交，不为每个里程碑造长审计链。
- 类型基线按实际配置分别记录，新增诊断修复，不关闭检查；F16、缓存/向量检索、多 Worker、
  容器/远程平台、任意经验组合、权重训练保持 deferred，实测需要时另列任务。
- 可信本地 writer、显式人类登记 Replay adapter 的限制保持，不宣称签名认证/对抗恶意本机进程。
  多用户/不可信导入或高风险无人值守上线时重新评估适当边界。
- 遵守 Git 明确路径暂存/审查/本地里程碑提交，不 push/rewrite、不改 Pi/真实配置/lockfile。
  一次总开发委派允许主 DS自主完成 C6-A-F；工程验收后单独启动实验。
