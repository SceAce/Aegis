# Aegis：从 C5 到可用 Agent 与经验效果验证

状态：**规划基线，尚未授权执行全部后续阶段**。依据用户本轮“先规划后面的任务”要求制定。
起点 `f12c15c`，C1-C5 按已有记录范围交付。当前可委派任务仍为
[SDK_LAUNCHER_TASK.md](SDK_LAUNCHER_TASK.md)；本文 R1-R6 是后续工作编号，不改历史 C0-C5 编号。
只更新规划，不实现产品、不运行真实模型或外部目标。未来阶段开始时冻结该阶段具体契约和 required。

## 1. 最终要达到的用户效果

依据 THINK.md 当前架构、ARCHITECTURE_DECISIONS.md 的已确认决定与 MEMORY_SCHEMA.md：

1. 用户给出目标、工作目录、验收条件和预算，一次启动；Agent 在授权内观察、规划、行动和验证，
   显示任务分发/进度，支持暂停、取消与恢复。模型提出 Claim、Action 和受限动态任务，Host 决定接纳。
2. 长任务用短 Session 处理小目标，图板/已提交状态保存进度；换上下文不丢目标、授权、事实、
   unknown、未决效果与累计预算。本地小模型也能走同一条执行链。
3. 多次可信经历经可回放验证编译为 when/do/expect/scope 经验。下一任务先检查适用性：
   direct 复用确定路径、habit 只补参数、hint 指出待确认差异、deliberate 执行受控探索。
4. 条件未知先补观测；环境变化、冲突或后置条件异常退出旧捷径。工具失败/日志失败不编译成方法证伪。
5. 在未见过的任务变体上实测：相同预算和执行边界下，减少重复探索/模型请求/耗时，且任务正确性、
   误激活与负迁移可见。收益不成立也必须能报告并据此调整设计。
6. 再扩到代码工程、文档/课程学习等日常任务。理解型任务允许引用证据、human/delayed review 和 unknown；
   “文章写完/模型说懂了”不自动变成知识正确性或学习收益证明。

这是一条产品与实验路线。记录条数、active 数量、单次 direct 节省调用和文献推导均不足以证明
普遍学习提升。历史材料中“不同 Session 即独立”“workspace 即 sandbox”“六层新持久 schema”
等旧建议不覆盖现行契约；继续四对象链及已确定的写权限、独立 Episode 与监督工作区边界。

## 2. 实际起点与复用范围

| 当前材料/实现 | 已有能力 | 后续需要完成的接线 |
| --- | --- | --- |
| Campaign scheduler/Host/Broker/Oracle | 静态/动态调度、本地注册动作、独立判定、预算、控制与恢复 | 实际模型成为当前 Task Worker，不能把 defaultPlan 的预定动作说成模型规划 |
| c5-entry / C5 SDK suite | 离线配置入口、caller runtime、真实 SDK 换对象/同 Episode/共享日志 | CLI 自动创建 SDK、真实 Task binding、请求策略、常驻服务 |
| runtime state/board/RAM | 事件投影、事实/Claim 分开、逐请求 RAM、handoff | 当前 RAM 是字符估计；ROM/工具/历史/输出预留组成的总输入需要在运行入口计量和限制 |
| Compiler/Router/workflow/learning bridge/store | proof 门、direct/habit/hint/deliberate、可信命令、registered actions、隔离 replay、派生 store 校验 | 接入 Campaign 证据与跨运行学习范围，Host route-before-model、可追溯贡献与退出捷径 |
| C4/C4a | verified stream 的报告/观察，坏源不当成功，隐私/字节 bounds | 展示真实 SDK 请求/工具用量、实际经验使用/服务生命周期，按需增量字段 |
| fixture prototype | 受限 JSON 的 2+1、route-before-model；历史真实模型 smoke | 保留为回归，不能直接当第二任务族/统计迁移效果 |

本次规划核对代码并运行四个现有脚本，均 exit 0：aegis-learning-bridge-e、
aegis-observer-data-use-pi、aegis-learning-commands-pi、fixture-pi-orchestrator。
SDK 脚本采用 source resolver。具体 argv/exit/log 位于 ignored
`Pi_Agent_base/runtime/dev/roadmap-baseline/results.json`。
这是相关能力的当前基线，不是全仓库重新验收。

历史 OVERNIGHT_G/H 的 evidence_refs 未接入项已由当前 Observer artifact/data 记录及
数据使用测试的实际 resolver/Compiler 断言补齐。后续不照旧报告再次派同一修复；检查的是
Campaign 产出与该 resolver 的兼容、跨日志证据和真实 replay 是否完整。

## 3. 顺序、依赖与产品里程碑

```text
R1 离线 SDK 启动/生命周期
  → R2 模型 Worker 与一个可判定的任务族（先 faux）
  → R3 Campaign 内经验编译/复用闭环（先离线机制证明）
  → R4 用户指定 provider / 本地小模型受控运行
  → R5 经验与短上下文效果对照
  → R6 第二任务族及日常产品试用
```

- **里程碑 P1（R4 后）**：一个可用的受控模型 Agent。用户可一次启动实际任务，模型作数据化决策，
  工具走 Broker，独立 Oracle 验收，短 Session 连续，报告/UI 可用。此时不宣称经验提升已证明。
- **里程碑 P2（R5 后）**：在声明任务分布与预算内取得可审查的经验/上下文效果数据。
  若没有收益，记录负结果并针对实测原因修 R2/R3，不继续堆检索、并行和新平台。
- **里程碑 P3（R6 后）**：第二任务族可用且迁移/退场边界有实证，开始日常使用反馈循环。

R2 的任务族/Oracle/测量契约可在 R1 期间规划，已有模块基线可独立检查；共享 writer/Host/Observer
的实现按依赖串行。R5 的对照设计在 R3 前确定，以免实现决定正确答案；真实执行仍等待 R4。
不同时实施六轮，不因路线图存在自动授权 provider、网络、付费预算或目标实验。

## 4. 六轮任务与完成条件

### R1：离线 SDK launcher（下一次委派）

**效果**：一个命令管理真实 SDK/faux runtime，用户无需手工拼 factory/runtime/beforeRun。

复用已有任务书 L1-L8：initial/rotated Session 的同一 gate/writer；实际调度 Task/Episode 绑定；
安全阈值轮换和跨 Task/restart 账本；run 清理、observe 常驻、typed control、SIGTERM/SIGKILL 恢复。
动作仍由现有可信 Broker Worker 驱动，faux 请求验证生命周期；不把它说成通用模型规划。

**出口**：clean CLI 产品测试，无注入测试回调也能启动/轮换/观察/关闭；对象/context、完整链、
账本和真实效果满足既有任务书。一份内部交付，一次限定验收。

### R2：模型 Worker 与首个任务族（离线）

**效果**：当前 Task 的下一动作由 SDK 模型请求决定。Host 验证结构与范围，再经原 Broker 执行；
模型可以提出合法动态任务，不能扩大授权或自建 Oracle。

**建议首个任务族**：临时目录里的结构化数据修复/转换，例如识别输入格式/版本、修复声明字段、
转换并生成报告，由可信 parser/参考实现独立检查结果。提供参数和版本变体以及“看似相似但不能
直接用旧方法”的样本。这比 locked 布尔演示有更多真实决策，又能复用小型注册动作和快速 Oracle。
这里只是默认实验环境选择，R2 开始时冻结任务生成器/工具和标准，不提前造通用工具平台。

**必须工作**：

- SDK Worker 执行 observe → 结构化 action/proposal → Broker → Oracle → 有界继续/停止，
  替代该模式的硬编码 defaultPlan。优先复用已有 aegis_observe/aegis_execute/proposal primitives，
  按实际 Campaign gate/schema 映射；不能只 allow-list 一个名字而漏掉它的执行时授权/记账。
- worker 绑定可信当前 Task/Stage/Episode，动作携带最终参数/相关状态版本/refs。未知前置条件允许
  授权内有限探索，不要求先有 active Experience 才能行动。
- 实际 model_requests/tool_calls 在调用前准入并记录；SDK 内部自动 tool loop/继续请求也受限。
  task 总成本和 Campaign 总成本一致，不能沿用 synthetic 每 dispatch=1 冒充实耗。
- 总输入计量含 ROM、工具定义、RAM、近期 history 和输出预留。优先已有 tokenizer/后端计量；
  不可得时明确字符/保守估算及限制，不声称 token 精确硬门，R4 校准。必需约束装不下时停或缩任务。
- 首个 Oracle 有已知正确、已知错误与证据缺失/unsupported 样本，检验错误不放行、不可判定为 unknown。
  只对声明任务族声称覆盖，不据小探针集推导系统总体假阳性率。

**出口**：真实 SDK/faux 根据不同观测走不同动作；删/改变模型 tool decision，实际效果随之改变；
合法动态提案真正 dispatch；恶意/foreign/越权/假成功文本无效果或不完成；多 Session 正常与预算/
日志故障、中断恢复正确。faux 证明决策入口接线，不证明真实模型能解决任务。

### R3：Campaign 内经验闭环（离线）

**效果**：前两次有可信证据的经历，能够成为后续任务的已验证可执行路径；参数少量改变可以 habit，
不匹配或异常会进入补观测/探索。

**必须工作**：

- Campaign 的真实 action/Outcome/artifact/data records 进入现有 learning bridge/resolver。
  冻结跨 Task/跨运行证据引用的作用域、不可变 Manifest/adapter/action digest 与可信导入者。
  跨 stream 的 proof 不能只复制 Outcome ID 或导出一个未经核实的 active JSON。
- 首个任务族的隔离 replay 用真实 reset/受控临时副本/前后态/Oracle；独立性由真实 reset 记录证明，
  Session 和同 Episode 多次判定不计独立。缺 adapter/proof 留 candidate。
- Host 使用显式学习 policy 和明确 proof IDs 调用既有 Compiler/store；不因 task.completed 自动晋升，
  不改变现有 promote_experience:false 默认。若启用 trusted Host compile，配置和事件需显式登记。
- Host 在模型请求前 route；direct 不启动模型规划，habit 只提供缺参数绑定面且执行前重验；
  hint 仅来自可用 active 规则的待确认匹配，模型 candidate 不包装成指导。
- 冲突/环境变化保持暂停与拒绝诊断；在合法授权内的 fallback 遵守现有策略，
  “退出捷径”不等于绕过 guard 或重发结果不明的动作。
- 保存 considered/matched/rejected/selected、experience revision、实际 Action/Outcome、
  data→使用→阶段推进引用。selected 不是贡献，更不是因果收益。
- 删除派生 store/report 后能从已保存源记录与证据重建。若现有 compiled note 只保存 digest/refs，
  明确必要的 canonical rule/编译参数来源，不能假称读取不了的原 JSON 可重建。

**出口**：真实独立 Episode + Replay + 编译，再在第三 Task 走 direct/habit/异常退场；
跨运行重建不漏证据，篡改 store/foreign proof/版本变化/单 proof 不执行旧捷径。
机制测试允许 scripted faux，收益证明留 R5。

### R4：用户指定 provider / 本地小模型试运行

**效果**：P1 可用 Agent 从离线接线进入真实决策。优先用户已有本地模型；资源不适合时选择
已授权远端 provider，同一 Worker/工具/Oracle 路径，只更换明确的模型配置。

**必须工作**：用户确定 provider/model/endpoint、任务目录与作用域、单次和总预算；
可信 SDK 模型配置与凭据隔离，启动先校验。每次 provider 请求/嵌套继续都计量，
记录 model/Pi/ROM/tools/adapter/Oracle/经验版本与缺失测量；不可用或预算耗尽明确停止。
校准该后端有效上下文预算与估算误差，不把标称 contextWindow 当最佳运行窗口。

**出口**：从 clean layout 在首个任务族至少跑通无经验、多步有观测决策、轮换恢复与有经验路径的
有界 pilot；Oracle 独立判定，成本来自实测或明示 unknown。模型未能解决就报告失败/unknown，
不能替它写好结果再称模型完成。少量 smoke 只证明运行，不声称统计学习或本地模型提升。

这是第一处需要新增真实运行输入/授权的阶段；本路线图不读取凭据、不代表已批准调用。

### R5：经验与短上下文效果对照

**效果**：回答两个不同问题：“经验能否省探索而不误用？”和“短窗口+图板能否保持连续性？”

**设计先冻结，避免巨大组合实验**：

1. 经验实验固定模型、任务分布、预算、工具、Oracle、上下文策略和原始初态，比较 A 无经验、
   B 有界原始经历、C active 经验；D 注入过期/错误经验作为退场与负迁移压力组。
   C 内先记录 direct/habit/hint 实际分布，不默认把所有模式做全组合。candidate 不冒充 C。
2. 上下文实验固定经验策略，另比较长 Session、短 Session+机械图板 RAM。
   可选缺交接信息消融仅在可丢弃实验任务，不丢授权/guard/预算；该组仍遵守安全边界。
   不同时改变模型、经验和窗口后把效果归因给其中一项。
3. 编译训练集/留出评估集/环境变化集分开，评估期间冻结经验版本；失败与 unknown 全部保留。
   任务参数、表面形式、版本变化和相似不适用样本都覆盖；重置与组间隔离有证据。
4. 配对变体、随机/交错运行顺序、固定配置、记录所有 attempt；先少量 pilot 测方差/费用，
   再依据预算/最小有用差异确定重复数。样本不足标探索性，不预写统计显著性或固定“提升 X%”。

**测量**：可信任务成功率/失败/unknown，首次成功时间，总模型请求/tool 次数，重复探索，
输入峰值/累计 token/延迟与金额（不可得为 unknown），交接丢失/重复 effect、误激活与负迁移，
Oracle 对已知错误样本的放行情况。机械请求节省与真实跨任务效果分别报告。

**出口**：生成有界机器/人类报告与证据，可得到支持、不支持或证据不足的结论。
若“改进”来自跳过验证、降低权限门、忽略失败或过拟合训练题，结论无效；不靠关 guard 的基线
制造优势。不复制文献精度公式为本项目保证。
没有观察到有用收益时，定位识别/绑定/检索/验证成本/模型限制，只修已观察瓶颈，再做对应小对照；
不以新框架/缓存/模型投票掩盖负结果。

### R6：第二任务族与日常产品试用

**效果**：证明规则能在声明边界内迁移到第二类实际工作，再开始持续日常反馈。

**默认建议**：临时副本小型代码工程任务，允许既有受控 read/patch/test 动作；用固定任务标准与
外部保留测试/参考行为验收，Agent 不能修改验收测试来制造成功。增量能力来自已观察任务需要，
复用相同 scheduler/SDK/Broker/Compiler/Router，不新建第二 Agent。

**出口**：第一/第二任务族各有留出变体，合法复用有 real effect/Outcome，scope 不匹配拒绝；
训练经验冻结时能比较收益，新增经验按原门槛验证。声明可用范围和失败边界，提供一条启动/恢复/
导出流程，记录 human 决策次数与日常节省，不要求覆盖任意工程任务。

“陪我学习课程/WP/解释概念”作为同轮可规划的后续产品方向，独立冻结目标：
引用定位、原始内容与 Claim 分开、已知题/保留题理解检查、用户纠正与迟到反馈，
反馈不足保持 unknown。论文/WP 内容不自带授权、Fact 或 active 经验。
先选一个方向完成，不把代码工程与开放式辅导同时作为 R6 硬门槛。

## 5. 历史目标到阶段的映射

| 用户目标/历史承诺 | 已有基础 | 达成阶段与证据 |
| --- | --- | --- |
| 一次启动长任务、观察分发、控制恢复 | C1-C5 | R1 CLI/lifecycle → R2 model Task Worker → R4 实际 provider |
| 少量可验证观测带动行动，避免叙事假成功 | Observer/Broker/Oracle | R2 分支动作/独立结果/Oracle 正负探针 |
| 小模型、短会话、图板保进度 | RAM/C2/C5 | R1 自动绑定 → R2 总输入/调用门 → R4 后端校准 → R5 上下文对照 |
| 当条件 C 成立复用路径，不重新生成脚本 | Compiler/Router/Workflow | R3 route-before-model、direct/habit 与真实 action refs |
| 失败后改变行为、不把 unknown 编成禁令 | effective board/Outcome gates | R3 反例/退场/有限探索，R5 D 组负迁移 |
| 获得→使用→推进的数据贡献 | 现有 data-use/contribution | R2 实际引用，R3 经验动作关联；R5 才做因果比较 |
| 日常工作与陪伴学习 | 历史产品目标 | R6 第二任务族；理解型标准需单独定义，允许人类/迟到验证 |

## 6. 如何执行这份规划

- 一次只委派一轮。开始冻结目标、公共输入输出、owners 与少量 required 场景；
  内部实现小任务自主推进，最后交一次限定验收，不逐 helper 请示。
- 复用这份 roadmap 和该轮的一份 plan/matrix/report/runbook；不先为六轮生成所有源码/测试/prompt。
  下一轮沿用现有 launcher prompt；R2-R6 到启动时根据实际 R1 交付生成具体委派提示词。
- 已验收机制不重建。当前可达假成功、授权越界、重复 effect、预算错误、权威数据损坏才增加 blocker。
  性能/风格/未上线能力不无限扩大验收；核心 required 完成就推进。
- F16 与类型治理保持独立：修改旧库时修新增/触及诊断并记录该配置基线；不关闭检查。
  Campaign 当前 74 条、旧 learning scoped 配置的历史诊断数不同，不能混为同一条基线。
- Cache、向量检索、复杂知识图、经验任意组合、分布式、多模型投票、容器和权重训练不预先加入主线。
  它们只有因实测性能、范围或部署需求需要时才单列任务。高风险/无人值守能力上线时重新选择执行边界。
- Replay adapter 先保持可信人类登记、声明隔离能力；事件 source 在可信本地写者边界内使用，
  不把它说成签名认证。多用户/外部导入/恶意本机 writer 进入目标范围时再评估 attestation/signing。

当前无需回答所有未来架构问题。进入 R2 时冻结首个任务族；进入 R4 前确定模型/provider、授权与费用；
进入 R5 前冻结指标/有用差异/样本预算；进入 R6 前选第二任务族或陪学方向。
文档可被后续真实结果修订，但不能反向把未测假设写成已实现能力。
