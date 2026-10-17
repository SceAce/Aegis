# Aegis 当前整体完善目标与实施方案

状态：目标与实施计划已整理，尚未实施本计划中的新代码；工程整体仍为 changes_required。

基线：主仓库 `00108c30891c5fb5f0c29e9377b2cdff6338fdcf`，分支 `feat/structured-ram-and-exploration-control`，整理开始时工作树干净。本文汇总截至本次会话可核对的已知问题，不宣称已经穷尽所有潜在缺陷。

当前用户要求已更新：先前指定 `maxapi/deepseek-v4.1-flash` 子 Agent 编码；该中转反复中断后，用户明确要求当前主 Agent 直接完成未完成代码和测试，**不再依赖 max/DeepSeek**。后续实现遵守同一项目规范。本文不以历史授权代替真实实验、新依赖、Pi 核心修改等具体范围的授权。

## 1. 整体目标和完成边界

完善已有 Aegis，使同一冻结任务在执行、暂停、候选等待、换 Session、崩溃恢复、独立验收和经验复用中，始终保持相同的身份、授权、预算责任、结果有效性与证据来源。

最终应能在已登记任务族内完成以下链路：

```text
用户目标 / 授权 / 预算
→ 冻结运行契约与任务定义
→ Router 选择复用或模型规划
→ Host 接纳计划 / 调度
→ 请求与工具准入、持久化和计量
→ 每次效果前检查最新许可
→ Broker / 已登记 Adapter
→ 原始产物与独立 Oracle
→ 一致的 Outcome / Board / RAM / 依赖 / 报告
→ 安全 Session 轮换与故障恢复
→ 隔离 replay / Compiler / Experience
→ 新任务中的受控复用与独立效果评估
```

沿用现有模块，不另建调度器、账本、权威数据库或学习框架。模型输出只产生提案；观察、声明、行动、独立结果分别保留。候选等待不等于 success，知识 seed 不等于 active Experience。

完成标准分开记录：

- 工程完成：冻结范围内的契约、正常链、故障边界、恢复及消费者一致性通过验证，无未解决的当前核心阻塞。
- 内部复验：主 Agent 检查实际 diff，并独立执行受影响集成清单；子 Agent 自测不算外部接受。
- 独立验收：保留可审查 bundle，未获独立审查前标记 awaiting_external_review。
- 效果完成：固定模型、工具、预算和数据后取得真实对照；收益可以为正、负或证据不足，不能预设正收益作为通过条件。

## 2. 依据与已有能力

当前准则来自 [固定开发规则](DEVELOPMENT_RULES.md)、[架构显式确认](ARCHITECTURE_DECISIONS.md)、[整体基线 B01–B14](SYSTEM_ARCHITECTURE_BASELINE_AUDIT_20261015.md)、[数据契约](MEMORY_SCHEMA.md)、[运行时补充](MEMORY_SCHEMA_NOTES.md)及相应冻结任务。旧报告保留原基线，不能用文件较新或测试总数覆盖原约束。

以下能力已有实现，应修复接缝并保留回归，而非重复开发：

| 已有能力 | 证据与限制 |
| --- | --- |
| Event / Episode / Outcome / Experience、六类 Board 节点 | 事件投影、证据解析、独立判断和学习模块已存在；部分共同 authority 消费仍未闭合 |
| Campaign Host / Scheduler / Broker / Oracle、动态计划 | 正常链可运行；现有 E1 边界审查仍失败 |
| 真实 SDK Session 替换和 Supervisor | 轮换、同 Episode 和预算保留有离线 SDK 证据；CTF runner 未开放轮换效果维度 |
| RAM v3、显式提案引用与替换、候选等待 | 已实现；采样不是完整产物，真实模型使用效果仍需测量 |
| 临时 user 尾部 RAM、固定 system 前缀 | 实际序列化验证存在；不能把公共前缀长度等同真实缓存收益 |
| 轮次 checkpoint 和近期工具历史限制 | 已实现；新增 checkpoint 尚未被 board-off 实验开关完全隔离 |
| 本地知识编译、自动召回、模型查询、Board/RAM 接线 | 已实现；真实检索相关性存在问题 |
| Compiler / Router / direct / habit / 跨运行 store 重建 | 已实现并有工程验证；不能描述成完全缺失，也不能据此宣称真实学习收益 |
| 候选等待 / 恢复 / 已登记最小验证 | 已实现；Campaign work-verify 当前明确 unsupported，旧 legacy 恢复保留 migration_required |

实现记录：[RAM ABC](RAM_ABC_IMPLEMENTATION.md)、[知识接线](KNOWLEDGE_RUNTIME_IMPLEMENTATION.md)、[缓存修复](RAM_CACHE_OPTIMIZATION.md)、[公开题先导](BOARD_SEED_CTF_PILOT_RESULT.md)。

## 3. 问题总表与处理范围

类型：契约缺口表示已定架构未贯穿实际调用链；缺失能力表示范围明确但产品接口尚未实现；行为缺陷表示已有实现违背当前行为；实验缺口表示缺执行条件或证据。优先级不等于自动重开全部历史阶段。

| ID | 问题 | 类型 / 当前分类 | 解决目标 |
| --- | --- | --- | --- |
| CORE-01 | 可编辑 config 影响冻结运行的规划/计量协议 | 契约缺口 / current_blocker | 冻结上下文统一支配 live、resume、status 和账本 |
| CORE-02 | authority 请求索引未完整采用双侧联合结清 | 契约缺口 / current_blocker | 联合结清前不给工具执行许可，保留逐侧责任 |
| CORE-03 | 消费重建与协议选择仍有弱日志扫描 | 契约缺口 / current_blocker | 固定协议、统一 accepted charge 集合与消费恢复 |
| CORE-04 | 收费去重没有闭合工具执行及结果复用 | 契约缺口 / current_blocker | 首次执行、结果复用、unknown hold 明确分离 |
| CORE-05 | 每步 Broker 效果出口缺少完整最新 Campaign permit | 契约缺口 / current_blocker | durable intent 后再次核对完整执行资格 |
| CORE-06 | 完成、依赖、计划激活未统一当前有效判断 | 契约缺口 / current_blocker | required criteria、冲突、修正与环境失效先聚合 |
| CORE-07 | exact admission retry 被过严拒绝、status 对冻结副本支持不足 | 行为缺陷 / non_blocking | 合法幂等重试不重复效果，状态诊断不依赖可变副本 |
| CORE-08 | 辅助 run-required.sh 可能吞失败退出码 | 验证缺陷 / non_blocking | 各层 runner 保留真实失败状态 |
| MEM-01 | board-off 仍注入 round checkpoint，guard 未覆盖 | 行为缺陷 / 实验阻塞 | 关闭全部图板反馈，保留任务/权限/预算/unknown |
| MEM-02 | 摘要被省略后缺通用、受控的原始产物读回 | 缺失能力 / 短窗口完善项 | 完整产物与有界摘要分离，支持授权分页 |
| MEM-03 | checkpoint、Claim、知识在有限 RAM 中竞争，修订/保留效果待核对 | 行为与验证缺口 / non_blocking | 保护核心状态，显式失效与省略，必要信息可读回 |
| KNOW-01 | 自动查询受 Python/CLI 等环境词误导，模型细化查询仍召回不适用资料 | 行为缺陷 / 效果阻塞 | 提升条件与段落匹配，低相关时允许无召回 |
| WEB-01 | Web 同步工具、HTTP/session、响应产物和平台结果未产品化 | 缺失能力 / 后续任务族 | 按已设计 W0–W4 接入同一 Broker/ledger/authority |
| ENTRY-01 | 交互 Observer、CTF fixture 和 Campaign 能力不同，入口承诺不清 | 集成缺口 / non_blocking | 登记各入口真实能力，按所选入口接线和验收 |
| OBS-01 | E1 图板/任务图详情、截断后继续浏览和自动刷新不完整 | 缺失能力 / non_blocking | 只读、有界、可继续获取的观察界面 |
| EXP-01 | CTF 正式重复矩阵未完成，工具/预算校准不足 | 实验缺口 | 先校准，再冻结并运行完整矩阵 |
| EXP-02 | 无现成长短 Session 真实效果 runner | 实验支撑缺失 | 同任务同预算比较长窗口与真实短窗口交接 |
| EXP-03 | CTF 未接 active Experience 复用对照 | 实验支撑缺失 | 区分 seed/经历/active，使用已有 Compiler/Router |
| EXP-04 | 未见变体、第二任务族迁移与日常收益证据不足 | 实验缺口 / E3 | 留出任务、独立 Oracle 和完整失败记录 |
| MAINT-01 | 类型/格式既有非零基线、历史入口过时 | 工程债 / non_blocking | 不新增诊断，单独收敛既有债，更新当前入口 |
| PERF-01 | 全量投影/落盘及检索的长运行开销缺基准 | 未证实性能风险 / deferred | 先测量再优化，不预称内存泄漏或延迟主因 |

CORE-01–08 对应 [Single Authority 复审](E1_SINGLE_AUTHORITY_EXTERNAL_REVIEW.md) R-S01–R-S09，其中六组核心阻塞尚未闭合。不能把旧 completion/history 报告中的所有发现重复计算为新根因；相关旧反例作为回归输入，按当前代码重新归属。

## 4. 核心执行与恢复完善方案

### 4.1 CORE-01：冻结上下文先于所有消费者

由 Host 装配统一加载接口，输出已核验的 Manifest revision/digest、运行身份、模板/规划绑定及工具计量协议。执行入口不能依据可编辑 `planning.enabled` 跳过冻结运行检查。缺失/冲突时允许有界只读诊断，禁止猜测权限和继续请求。

live、resume、request ledger、authority、status、观察和报告消费同一份上下文；旧协议保留原责任，不因出现某类日志自动切换。新格式/迁移需要明确版本与兼容策略，不覆盖旧日志。

验收：修改 config 不能关闭冻结 durable 协议；缺失、foreign、被拒 start 必须验证而非 raw find 默认接受；合法恢复正常；可变 Manifest 改变后仍可按冻结副本展示可信 status 和冲突诊断。覆盖 SA-12、R-S08 与该入口的正对照。

### 4.2 CORE-02/03：统一请求与工具账本

复用既有 side-aware request reducer，不新造弱版 committed 判断。显式区分 Task 消费责任、Campaign 消费责任、联合结清、provider termination 和 unresolved。authority 只消费冻结协议下被接受的 request/charge/finish。

ledger/status/rebuild 不再自行从原始日志推导另一套 accepted charges；非法 charge 留诊断但不计成合法工具消费。legacy/mixed 协议保留已确认历史消费，缺迁移条件时 hold，不清零、不退款、不换 ID 绕过。

验收：一侧 committed/另一侧 failed 时拒绝新工具；context_digest 不符 charge 不被 ledger 接纳；追加伪工具记录不能使 legacy 已消费 3 变成 0；Task/Campaign 额度恰好耗尽、部分结清和新进程恢复守恒。覆盖 SA-01–03 及 C6 原三事实回归。

### 4.3 CORE-04：把幂等落实到工具体

在完整 request/toolCall/unit/Task/Episode/参数摘要绑定下，工具执行适配器统一处理首次许可、可验证结果复用和已收费无可靠结果三种情况。duplicate 或 finished 不等于允许再入工具体。

首次执行保持 durable-before-effect；有已提交结果返回原结果；可能已执行但缺可验证结果时 duplicate_in_flight/unknown 并 hold。live cache 只作优化，恢复后不能凭缓存缺失重读、重交或再入动作队列。read、decision、submit、知识、候选及后续 Web 工具按各自实际协议审查，不只修一个工具。

验收：同绑定重复调用只有一次 charge、一次实际工具体/入队/效果；参数冲突拒绝；charge 后崩溃、效果后结果前崩溃不盲重发；已完成结果在新进程可验证复用或明确 hold。覆盖 SA-04 与各工具正负对照。

### 4.4 CORE-05：每次实际效果前检查完整 permit

向 BrokerWorker 注入来自最新 accepted prefix 的 Campaign executionPermit；每个 step 在 durable intent await 完成后、invoke 前检查身份、当前依赖、时间/控制状态、预算责任、授权和最终参数绑定。现有 grant/work-control 检查保留，不把它们当完整 authority permit。

model 与 direct/habit 路径共用该出口，不能缓存整批许可。拒绝时保留 intent 和已经发生效果，记录 hold 原因；不伪造业务 failure、不自动重试。

验收：intent await 期间超时零效果；第一步后前置事实失效时第二步零效果；候选等待/取消/审计失效阻断；正常两步仍产生两步效果。覆盖 SA-07/08 和真实 BrokerWorker、计数 adapter、确定性 barrier。

### 4.5 CORE-06：统一有效结果聚合

以合法 Campaign/Task/Episode/Stage/criterion/subject/scope 和可解析证据构建当前判定集合；先应用 accepted admission/start、supersedes、环境失效与未消解冲突，再聚合完整 required criteria。

completion、plan ready、依赖、执行 permit、Board Fact、RAM、观察/report 和学习支持适配消费同一结论。历史 completed 保留，但不能独立授予当前执行资格；矛盾且无合法 supersedes 时保守 unknown/invalid 并诊断。普通失败不能自动成为方法 Refuted。

验收：合法 failure 与旧 success 冲突不继续满足依赖；失效后的新 completion/ready 被拒；合法 unknown 修正退役旧 Fact；被拒 Outcome 不经学习 bridge 成为有效支持；正常完整 criteria 仍完成。覆盖 SA-06/10/11、旧 CA/HA 的受影响断言与跨消费者比较。

### 4.6 CORE-07/08：幂等命令、只读恢复与退出码

完全相同的 admission retry 可返回原 accepted 结果，但不能再次分配预算/激活/产生效果；新候选冲突仍拒绝。只读 status 基于冻结输入展示故障，不擅自修复日志。辅助 shell runner 显式累计子命令真实退出码，不用 tail/最后一条命令的成功制造通过。

验收：R-S07/R-S08 对应正负例；故意失败的测试能穿过 shell→runner→父进程保持非零；通过、失败、超时、signal 分开。

## 5. 工作记忆、知识和入口完善方案

### 5.1 MEM-01：修复实验开关

`context-policy.mjs` 的 board-off 分支同时移除派生 `round_checkpoints`；完整事件仍持久化。梳理所有新增反馈节及 experiment guard，显式列出哪些反馈关闭、哪些权限/任务/预算/未决责任必须保留。

扩展现有纯函数与真实 SDK/faux 测试：包含 checkpoint 的 A/B/C/D；跨 turn、重启/交接后的实际 provider payload；关闭知识同时禁自动召回和工具读回；输入 state 不被修改。生产 fixture 的污染检查纳入 checkpoints。私有 shim 不能成为正式代码的长期替代。

### 5.2 MEM-02：原始产物和分页读回

定义统一产物接口：不可变 ref、owner、来源 event/action、digest、长度和可用性；完整内容保存在 ignored 受控目录，RAM 只带有界摘要与引用。无法取得原文明确 unavailable，不把 digest 当可读全文。

新增受控 read 接口，接受已登记 ref、offset/limit/encoding，不接受任意文件路径；按 Task/Episode/授权解析，绑定真实字节、分页状态和计量。支持文本/二进制及明确 UTF-8 边界语义；脱敏展示偏移与原字节偏移不能混用。当前 workspace read 若增加分页，应保持现有授权及工具计费协议。

验收：中后部线索在换 Session 后可按 ref 获取；foreign/missing/corrupt/symlink/越界/超预算拒绝；读取不授予 Fact；大产物不全量注入 RAM；原文不存在时不伪造恢复。

### 5.3 MEM-03：状态选择与提案修订

保持事实、工具观察、模型 checkpoint、显式 proposal 和知识信任类别。核对 checkpoint 的生成/覆盖/失效与显式 replace_event_id：普通文本不是可信事实，checkpoint 也不自动替换有效 Claim。

在固定 RAM 预算内保护目标、授权、预算和 pending，明确 sections 的 total/shown/omitted 与 core overflow。结合当前任务引用和最近进展选择内容；工具结果继续正常进入原 Session。必要详情通过 MEM-02 读回，不靠无限放大 RAM。

用多轮、长输出、稀疏线索、旧 Claim 被替换、跨 Episode 与真实新 Session 验证。模型未调用替换工具属于行为观察；需要改 guidelines 时用中性规则，不写具体题技巧、不新增后台总结模型、不解析隐式推理。

### 5.4 KNOW-01：按任务条件检索，允许拒绝不相关内容

先建立固定离线查询集：症状查询、明确技法、相似错误方向、负例和多语言重复段。评估具体段落适用性，不仅算 RSA/SQL 大类命中。

候选方案：查询分离任务内容与工具/环境说明；保留关键条件与符号；分类/标题/段落结构加权；中繁重复去重；低相关阈值和空结果；模型根据实际工具观察自主细化查询。词法改进先形成可核对基线，是否需要语义重排另据结果决定，不默认引入向量库或额外模型。

自动召回、模型检索、进入 provider、后续实际采用与独立阶段贡献分开记录。知识省略可见并可重新选择；seed 永不因被选中升级为 Fact 或 active。

验收：Python/CLI 工作流词不压过密码条件；已有明确技术正例不退化；无关查询允许零召回；模型能查询重选且后续请求接收到；效果收益通过 EXP 系列判断。

### 5.5 ENTRY-01 / OBS-01：入口能力与只读观察

登记 run-pi、run-ram-test、CTF fixture、C6 Campaign 的模型工具、任务契约、Broker、计量、Oracle、候选/恢复、Session 管理和学习边界。产品提示与运行包明确当前能力；工具声明不是执行授权。

保留 Campaign 自动轮换和交互模型建议/Host 执行的区别。CTF 要测短窗口时接现有 Supervisor，不把同历史 fork 当新上下文；实际配置与 provider/model 选择穿过 handoff。

观察面补齐 E1 节点/边详情的有界继续读取、图与任务的分页/筛选和客户端刷新/停止刷新；已有一般任务/动作 API 分页不能当作 E1 全图已完成。所有接口只读、脱敏、基于同一 state revision；UI 不直接授权/恢复或调用模型，控制继续走类型化命令。

验收：大图截断可见且可继续浏览；foreign ref 不泄露；多次分页能识别版本变化；刷新不会产生写入或 provider 请求。静态查看与真实 UI 交互验证分别记录。

## 6. WEB-01：正式 Web 任务族

沿用 [Web 接入计划](CTF_WEB_TOOLING_PLAN.md)，新接口名称和 schema 在实现前最终冻结，不把计划名称当已注册工具。

| 步骤 | 交付与依赖 |
| --- | --- |
| W0 | 具体题目/实例、目标 origin、方法、预算、重置规则、Oracle 来源；固定运行包 |
| W1 | HTTP/session/cookie adapter、响应产物/分页、有限数据变换；本地可控服务验证 |
| W2 | Web family、SDK 同步反馈、同 Broker/authority/request/tool ledger；依赖 CORE 与 MEM-02 |
| W3 | 候选等待、平台/人审结果精确映射、prepare/status/export 和恢复入口 |
| W4 | 在有效授权和预算内做真实模型/实例测试及中断恢复 |

严格 origin/headers/redirect/proxy 授权，保留题目字节语义；4xx/5xx 属于真实响应，不等于 Outcome failure。intent 后最新 permit；一次调用只执行一次，不同时放入延迟 decision buffer。发送后结果未知不自动重发。候选由独立平台结果判定，绑定实例变化。

验收复用 WT-01–WT-12：请求实收字节、cookie 隔离、重定向不越界、大响应、SDK 实际 continuation、charge/intent/effect/result 单次、持久失败、子进程中断、失效与超时、foreign 结果拒绝和新 Session 恢复。未有具体靶机时先完成本地工程范围，不能捏造平台接受。

## 7. 实验与测量完善方案

### 7.1 当前真实测试记录的校正

本次 ignored 证据根：`Pi_Agent_base/runtime/dev/autonomous-evaluation/`；原题与新 runs 在 `~/Tmp/aegis-board-seed-pilot-20261017/`。子 Agent 报告存在统计与措辞错误，不能直接视为最终权威。

- RSA i A/B/C/D 各一次，四组均预算耗尽未解出。这是一套完整校准，全部失败不使对照自动无效。B/D 的 isolation=false 表示没有启用 board-off 专用 shim，符合 board-on 预期，不是隔离检查失败。
- 三行密码 A 组 20 请求预算停止；D 组第 19 请求 Connection error，随后停止，B/C 未执行。
- 按报告逐项表，主要运行是 1 个 probe + 4 个 RSA 校准 + 2 个三行密码校准，共 7 项，标记请求数合计 109；摘要的 6 项/95 请求遗漏 probe。另有早期 harness 调试尝试，需要从全部 experiment/result/assistant 原始记录重新核算，不能把 109 直接宣称包含所有开销。
- 真实请求尝试、未到 provider 的预算拦截、合成 error 消息、usage 缺失与失败请求分别统计。零 usage 不是零费用证据，SDK cost 不是平台账单。
- RSA i 失败不能证明必须 LLL 或 stdlib 无解；先独立校准合法工具条件，不将模型尝试过的路线当题目唯一解法。
- 当前 CTF runner 不支持 active 干预，不等于项目没有学习能力；`fixtures/real-model-ab.mjs` 和 C6 learning policy 已存在，适用范围各异。

先写确定性汇总脚本重建这些计数和状态，保留旧报告，不覆盖失败或调试记录。用于公开计划的结论限于“校准未解出、正式重复矩阵未执行、provider 曾传输失败”。

### 7.2 EXP-01：有效四组正式对照

先修 MEM-01 和 harness 停止分类，再独立校准题目/工具/请求数/单次计算时限。不能只增加 wall time 却不检查请求数先耗尽。选择有阶段进展、可独立验收、工具足够且可重置的任务；公开原题记忆污染写入限制，优先加入验证可解的变体。

固定 board×seed 四组 A/B/C/D，记录相同模型/endpoint/thinking/tools/初态/预算和知识快照，独立工作区、Session、任务状态；随机或交错组序。关闭反馈不关闭审计/授权/未决责任；真实 payload 自检。先一题四组校准，再按校准费用冻结正式样本量；原 2题×4组×3次仅为先导候选规模。

每次记录独立成功/阶段成功、首个可验证进展/候选时间、请求/工具/重复动作、累计与峰值输入、cacheRead、输出、耗时和已知费用。失败/unknown/超时全部保留；无独立时间点填 null。provider/harness 故障不算解题能力失败，也不删样本。预先固定停止与重试策略；恢复后新批次，不能暗改旧组条件。

### 7.3 EXP-02：短窗口 runner

复用现有 Host/Supervisor 和 RAM，增加可冻结的 session policy、工作窗口预算和轮换触发。保持同 Episode、累计消费和未决责任；记录实际 Session ID/新 provider 上下文/重新绑定，不用摘要宣称轮换成功。

比较长 Session 与短 Session+RAM，若增加缺交接消融仅在可丢弃任务中进行，权限/guard/预算不能丢。知识和经验策略固定。验收包含正常交接、工具未结清拒绝、重启续行、无重复效果及同 provider/model。工程离线通过后再测真实效果。

### 7.4 EXP-03/04：经验复用与迁移

复用现有 C6 learning policy、Compiler/Router、replay adapter 和 real-model-ab 基础，补目标任务族 runner，不新造 active 开关语义。冻结编译集/留出集/变化集、经验来源与 revision。

比较无经验、有界原始经历、合法 active Experience，错误/过期经验作退场压力组；记录 direct/habit/hint/deliberate 分布、绑定成本、误激活、负迁移和退出。candidate/seed 不当 active，对照不得放宽 Oracle。可信策略可以选择已有 proof IDs；自动发现/全自动晋升不是当前默认要求。

第二任务族优先已有受限 code/data adapter，扩多文件或日常陪学时先定义工具与独立验收，不能由单文件或 fixture 成功推断通用能力。

## 8. 工程债、性能和明确后置

| 项目 | 方案 / 重新评估条件 |
| --- | --- |
| 类型基线 | 既有 Batch 186 / Campaign 189 为历史参考；每阶段实跑同配置、比对规范化诊断内容，新增诊断修复。单独安排旧债，不缩检查范围 |
| Biome 基线 | 受影响文件通过；旧错误按文件列出，保持规则，不用 suppress 或更改忽略制造通过 |
| 入口文档 | 更新 docs/README、工程入口、runbook 对当前计划的链接；旧审查保留原基线，避免当前状态继续引用过时 C6/E1 结论 |
| 长日志/检索性能 | 测每事件投影耗时、请求准备延迟、RSS/heap、IO 与知识规模；明确模型延迟和本地成本。证实瓶颈后再做有来源的增量投影/索引，保留可重建与坏源拒绝 |
| legacy migration | 当前 migration_required 是明确限制。实际需要恢复旧流时定义独立迁移/验证方案，不静默改写消费或身份 |
| Campaign work-verify | 当前 unsupported 是记账上下文限制；确需支持时先定义请求之外的可信验证计量协议，不能借自由 shell 绕过 ledger |
| 增量重规划、任意经验组合、多 Worker、向量库、容器/远程平台、权重训练 | 保持 deferred；当前一次有效计划与单活动 Task 不是本轮缺陷。真实需求进入范围时另冻结接口与预算 |
| OS 隔离 | 当前显式 macOS workspace 监督模式保持，不冒充 sandbox；需要处理不可信代码或无人值守时另定并验证执行环境 |

## 9. 实施任务图与子 Agent 分工

执行方式按最新用户指令：主 Agent 直接完成代码、测试、集成和审查，不依赖 max/DeepSeek。以下子 Agent 分工是原计划的职责划分，当前可由主 Agent按同样边界执行；不伪称仍有子 Agent 委派或外部独立审查。

```text
P0 基线 / 证据校正 / 冻结接口与矩阵
├─ P1 CORE-01 → CORE-02/03 → CORE-06 → CORE-04/05 → CORE-07/08 → 核心集成复验
└─ P2 MEM-01 → MEM-02/03 与 KNOW-01 → ENTRY/OBS 接线
P1 + 相关 P2 → P3 WEB 工程与任务族运行包
P1 + P2 → P4 EXP runner / 离线故障测试 → 校准 → 有界真实对照
P4 → P5 留出变体/第二任务族与日常使用
MAINT/PERF 按影响分阶段，不阻塞无关任务，不无限扩大范围
```

共享 authority/projection/entry/observer/runner 文件按依赖串行，主 Agent 统一集成。纯测试与不相交模块可并行。每个阶段先冻结 required 清单与退出条件；当前核心阻塞未解决时不标整体工程完成，但其余独立任务继续。

| 角色 | 交付 |
| --- | --- |
| 测试子 Agent | 独立 expected、旧代码 red、正对照、故障与恢复用例、逐脚本命令/退出码 |
| 实现子 Agent | 指定文件内最小实现、契约/调用点同步、聚焦测试、实际 diff、残余限制 |
| 审查子 Agent | 对照 B01–B14 与冻结接口检查最终 diff，提供可复现发现；同模型自审不等于独立外部接受 |
| 主 Agent | 审查所有改动和 allowed_files、独立执行集成、核对证据与模型身份、维护矩阵、提交和交付 |

每份委派包含 task_id、目标/非目标、allowed/forbidden files、上下游、输入输出/信任/持久化、失败和恢复语义、必需 case/命令、预算、停止条件、产物路径。使用已有 Pi 子进程/SDK，不新建管理平台。agent 配置隔离、凭据只读引用，禁止打印 key；实际 assistant provider/model 必须核对。

## 10. 规范、验证与交付要求

编码前按根 AGENTS 加载 [固定开发规则](DEVELOPMENT_RULES.md)，再读 [工程入口](../Pi_Agent_base/AGENTS.md) 和目标路径全部 AGENTS。执行 [开发规范](AGENT_DEVELOPMENT_STANDARD.md)、[测试规范](AGENT_TESTING_STANDARD.md)、[委派流程](DS_ORCHESTRATION_WORKFLOW.md)、[Git 规范](GIT_STANDARD.md)。用户本次指定模型优先于旧委派默认；历史规范中的阶段状态不是新任务授权。

本计划作为当前问题与整体目标总入口。具体实施复用/更新 `CAMPAIGN_WORK_PLAN.md`、`CAMPAIGN_TEST_MATRIX.md`、`CAMPAIGN_REVIEW_REPORT.md` 的相关范围；不覆盖其中无关历史内容，不为每个 helper 新建一整套审计链。

验证必须覆盖：

- 需求→case→脚本→结果→证据引用可追溯；正常链不能被大量拒绝例替代。
- 纯函数、真实 EventLog、真实 SDK+faux、本地 adapter 效果与真实 provider 效果分开。
- durable-before-effect 使用 barrier/持久故障验证；故障前缀回放与真实子进程中断分别记录。
- 同一输入在 live/replay/queue/Board/RAM/report/learning 的判断一致；拒绝不能在下游复活。
- 工具幂等、参数冲突、结果未知、恢复、预算和 Session 身份贯通实际出口。
- required 与既有 red 都保留真实退出码；不得删、skip、放宽或以 expected failure 制造通过。
- 先聚焦，再跑受影响集成。类型、Biome、module-layout 按变更风险运行，旧基线与新增诊断分开。
- 真实实验单独记录模型、版本、冻结配置、provider payload、题目来源、所有 attempt 和停止原因；不提交 flag、私有会话、凭据或无限原始输出。

每阶段交付实际变更、子 Agent 身份、明确文件清单、精确命令与退出码、旧 red/新 green、残余阻塞和后置项、Git 分支/commit/工作树。显式暂存审查后本地提交，不自动 push。只有文档变更时检查链接/路径/一致性与 diff，不跑无关产品全套测试。

## 11. 当前执行状态与下一步

本文所有未完成项默认 planned；不将方案文字视为实现。已有能力保留，当前已确认的六组 E1 核心阻塞和 MEM-01 仍未修复。

后续开始编码时先完成 P0：核对当前代码与原始测试产物、纠正统计，生成核心接口表和阶段 required 矩阵；再委派指定 DeepSeek 子 Agent 实施 P1，并行安排不冲突的 MEM-01 测试/修复。真实实验在工程干预和 runner 自检通过后执行，不能靠继续付费跑题掩盖契约缺口。
