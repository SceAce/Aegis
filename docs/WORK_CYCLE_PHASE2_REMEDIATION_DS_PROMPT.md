# 交给 DS 的 Work-cycle 收尾总提示词

将下面代码块完整交给主实现 DS。主任务详情在 `docs/WORK_CYCLE_PHASE2_REMEDIATION_TASK.md`。

```text
请完整收尾 Aegis work-cycle 第二阶段，修复已复现的剩余问题并完成限定的 SDK/C6 产品复验。不是只写计划，也不能只重跑已通过的旧清单。

权威文档：
- docs/WORK_CYCLE_PHASE2_REMEDIATION_TASK.md（本轮逐项任务、文件分工、状态迁移和退出标准）
- docs/WORK_CYCLE_PHASE2_IMPLEMENTATION_TASK.md（阶段总体契约/冻结范围）
- docs/STRUCTURED_RAM_AND_WORK_CONTROL.md（用户认可的持久行为契约）
- docs/WORK_CYCLE_PHASE2_TEST_HANDOFF.md（补测报告、真实观察和最初 remaining list）
- docs/WORK_CYCLE_TEST_MATRIX.md、docs/WORK_CYCLE_IMPLEMENTATION_REPORT.md（历史和新增证据都追加在原文档）

严格遵守根 AGENTS.md 加载的固定开发规则、开发规范、测试规范、Git 规范和所有目标目录 AGENTS.md。契约遵循当前用户指令和已认可设计。测试要求是对产品契约的观测，不是新的一套开发规范。

一、授权和保护

1. 开始记录真实 branch/HEAD/status、嵌套 Pi HEAD/status、各改动的所有权。工作树有上一阶段 DS 未提交实现与补测测试；不得 reset/clean/stash、不可覆盖文件。先读实际 diff 和日志，不假定报告的 git 状态仍成立。
2. `Pi_Agent_base/UI/` 属于用户，禁止读取、修改、暂存、删除、移动或重置。
3. 只用真实 Pi SDK + faux + 临时本地 filesystem；不得触发真实模型、真实网络、目标、凭据、付费环境。无需用户提供真实 Session ID。
4. 不改 Pi 核心/升级Pi/装依赖，不改变 Outcome/Episode/授权/active Experience独立证据门，不新增 EventLog/Board/RAM/Session manager/账本。
5. 当前用户委派是完成整条剩余闭环；允许修复以下已批准契约。不得暂存、提交、push；交付未提交可审查最终树。

二、必须闭环的四项

R1：`aegis-work-cycle-replace-consumed-sdk.mjs` red 显示，review R 被 Intent B消费一次后，B 被 C 合法 replace 且 C 再引用 R，会将 round 1变0并把 consumption改绑C。修复事件前缀上的一次消费归属：current unit仍用Board有效视图，但不可用最终 effective Intent集合重写历史消费。累计/轮次分别保留。补 pure prefix、replace产品路径、多次replace/replay、新 stall阈值和新 review正例。

R2：`aegis-work-cycle-zero-budget-recovery.mjs` red 显示 Run1预算0拒绝后，Run2仍0却由初始 SDK Session的Observer bind/start读staged JSON写handoff.completed，并继续effect；额度纠正的正例也只有initial Session完成、没有Supervisor applied replacement/Session charge。
修复 handoff request/attempt/completion authority：initial bind不得替历史拒绝rotation完成；0→0无completion、不完成Task、不发下一单元effect；额度纠正后明确经Host/Supervisor recovery、newSession、rebind，验证对象/id/file不同、completion.to_session等于replacement、rotation/session预算只消费一次。staged file不能自授权限或写成功。补至少一个bind/completion持久化失败路径；沿用C2恢复协议。

K1：readable empty knowledge corpus实测 `selectKnowledge`/产品返回 `ready`+[]，违反review边界要求`no_match`+[]。在最窄的retrieval-to-work-review映射/工具payload层修正，保持ready命中、unavailable读取失败、disabled策略关闭各自含义；事件、review和模型工具结果一致。不得改expected为ready、不得把unavailable降级为no_match，也不得让empty selection产生success/Fact。

G1：context-carry test的hold/trigger/计数/消费/usage/Session/RAM/effect拒绝都通过，但授权的C6 `aegis_read(path=door.json)` 在review hold期间被`effect_capable_tool_blocked_until_review_and_scoped_intent`拒绝。核对Observer `WORK_READ_ONLY_TOOLS`、`memory/work-cycle.mjs`共享classification与C6 `executionPermit/isWorkCycleAdvisoryTool`。仅允许受现有Campaign/Task/path授权和charge/finish保护的真实只读`aegis_read`完成观察；不允许bash/write/edit/未知工具/`aegis_execute`绕过hold。测试在replacement Session内断言真实read结果/对应事件和账本，继续断言副作用仍被拒、read不清hold不重置计数。

三、实现顺序与禁止捷径

先逐项运行已有正式补测保存red（失败原因按上面确认），再按R1→R2→K1→G1修实现和测试。共享 `work-cycle.mjs`/Observer接口由主DS协调，别让子DS重叠覆盖。每个fix保持最小scope并更新对应正负用例。

R1不能用在重放时查最终Board有效Intent来决定“历史有没有消费”；保留已提交事件前缀的消费位置。R2不能靠让 initial session拥有更高权限、忽略0预算、删除staged、改request ID、直接调用write completion或数completion记录伪造rotation。K1不能全局改坏knowledge selection既有API。G1不能放行所有read/bare tool name；按真实注册工具、正式执行授权和实际path检查。

不得从断言中删除replacement、零额度、工具返回状态、newSession身份或文件效果。faux要驱动真实model/provider边界，生产Observer/Host/Broker/Supervisor正常运行；不要直接写权威成功事件或mock最终决策函数。

四、最终需要重跑的测试

从仓库根运行整组新增正式补测（日志目录使用新的唯一ignored名字，不覆盖final4或p2-audit-independent）：

node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs Pi_Agent_base/runtime/dev/<new-final-dir> aegis-work-cycle-knowledge-recovery-sdk aegis-work-cycle-context-carry-sdk aegis-work-cycle-replace-consumed-sdk aegis-work-cycle-zero-budget-recovery aegis-work-cycle-reason-merge

上面必须5 scripts, 0 failed，且每例实际exit/log可核对。随后跑受影响 pure/RAM/phase2/work-cycle SDK/Host/checkpoint/recovery/policy、C6 product/lifecycle、C2 rotation、Observer failclosed/runtime-handoff、knowledge-campaign、RAM SDK。全新失败独立分级，不能把red淹没在runner最后成功。

最终产品交付阶段按既有任务另跑 required清单一次、Biome、tsc对旧基线、module layout；本测试委派报告先前required 68/完整14/type未运行，不得写成本轮执行。如果主DS将上述检查在最终树重跑，记录真实命令/exit/log。

五、保持工作范围有界

不用真实模型解题，不评价solve-rate；普通run-aegis/run-experiment/run-pi自动Host、新UI、性能缓存和全局skill评分仍deferred。默认3/8/4/85是未校准候选，不借修复之机改生产默认。只有新的可复现事实破坏冻结的当前不变量时才增加blocker。

六、交付要求

更新已有 `WORK_CYCLE_TEST_MATRIX.md` 和 `WORK_CYCLE_IMPLEMENTATION_REPORT.md`，追加本轮red→green，不覆盖原两阶段记录。明确TEST-06A/06B、TEST-07、R1、R2负/正、TEST-09逐项status、真实命令退出码和日志、review/selection/trigger/consuming Intent/event IDs、initial/replacement Session对象/id/file、handoff request/completion identity、预算/账本前后、真实read内容断言与副作用拒绝证据。

报告里previous self-test、补测最初red、最终修复green必须是不同执行轮次。明确哪些回归是本轮独立运行、哪些引用旧报告。若仍有任何一个冻结case失败或产品端无法证明，状态继续`tested / changes_required`并只列剩余项，不自称passed。全required/聚焦通过后标`internally_verified / awaiting_external_review`，交给外部审查，不自行宣布外部验收。

最终报告附准确git status、branch/HEAD、嵌套Pi状态、改动文件范围，确认UI未触碰、未暂存/提交/push、无真实环境操作。
```
