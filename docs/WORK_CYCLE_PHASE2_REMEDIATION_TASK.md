# Work-cycle 第二阶段收尾与限定验收任务

状态：**实现 DS 已完成 R1/R2/K1/G1 修复与限定复验；当前 `internally_verified / awaiting_external_review`，外部独立验收未发生。**

目标：在冻结的第二阶段范围内闭环 4 项已复现/未满足契约的问题，验证同 Task 跨 Session 完整链路仍成立，交付可独立复核的 `internally_verified / awaiting_external_review` 证据。此任务不要求真实模型解题实验，不扩展到普通入口自动 Host，不处理性能缓存或无关历史缺陷。

## 1. 权威依据与基线

先遵守根 `AGENTS.md`、[固定开发规则](DEVELOPMENT_RULES.md)、[开发规范](AGENT_DEVELOPMENT_STANDARD.md)、[测试规范](AGENT_TESTING_STANDARD.md)、[Git 规范](GIT_STANDARD.md)，及实现/测试目标目录沿途的 `AGENTS.md`。契约使用 [第二阶段实现任务书](WORK_CYCLE_PHASE2_IMPLEMENTATION_TASK.md)、[工作控制接口](STRUCTURED_RAM_AND_WORK_CONTROL.md) 和 [补测委派记录](WORK_CYCLE_PHASE2_TEST_HANDOFF.md)。

本任务只细化第二阶段剩余工作，不另建开发规范或权威状态。用户已认可：work unit 绑定有效 Intent event+scope；review 一次消费；累计/轮次计数分开；复核 hold 可在安全条件下跨 Session 携带；C6 是本阶段自动轮换入口。

测试委派报告基线：`feat/work-cycle-session-handoff` / `d84b692`，实现仍未提交；嵌套 Pi `2ba451d99` clean。开工必须重新核对真实 HEAD/status/diff，不得假定相同。已有未提交代码属于上一阶段实现，逐项保留。`Pi_Agent_base/UI/` 禁止读取、修改、暂存、删除或 reset。Pi 核心/依赖不改；无真实模型/网络/目标调用。

### 当前独立证据快照

补测脚本最近独立运行：5 scripts、4 failed、1 pass。日志在 ignored `Pi_Agent_base/runtime/dev/p2-audit-independent/`。阶段补测报告的 `p2-test-audit-final4` 与本次独立重跑应分开引用，不能混称同一次执行。

| ID | 复现事实 | 分类 | 本任务结果 |
| --- | --- | --- | --- |
| R1 | 替换 review 消费 Intent 后 `review_round_action_count` 1→0，consumption 从原 B 移到 C；累计 4 保持 | current_blocker | 先修 reducer/重放，再真 SDK 与 prefix 回归 |
| R2 | 两次运行 Session 预算都为 0：Run1 Supervisor 拒绝；Run2 initial Session bind 仍写旧 staged request 的 `handoff.completed`，Task 继续并执行第 4 个成功 effect；`rotation_attempts=[]` | current_blocker | 先修 Host/Observer/Supervisor completion authority，再拒绝/恢复正例 |
| K1 | readable empty knowledge corpus 的 C6 review 实际写 `ready` + selected=[] 并返回 ready，契约要求 no_match | current_blocker（契约一致性） | 修 retrieval→review 状态映射及工具响应，不改 expected |
| G1 | carried hold Session 能真实 rotate，effect 拒绝，knowledge/review 可用；授权 C6 工具 `aegis_read` 在 review gate 被归为 effect 并拒绝 | current_blocker（已承诺的最小 read 路径） | 复用现有可信工具分类，允许仅真正授权/只读的 read；不能用工具名任意 allow 或降低 Broker grant |
| E1 | 同一 context hold 的自动轮换、RAM、effect block、knowledge/review 已由真实 SDK+C6/faux 覆盖 | pass（该测试范围） | 保留并跑回归，补 workspace-read 正例 |
| M1 | request threshold + complete 同刻只发生一次 Supervisor rotation、两个理由、一个 Session 消费 | pass（该测试范围） | 保留回归 |

任务目标关闭 R1/R2/K1/G1，不以这些结果推出真实求解收益。若代码修复只掩盖测试表现、没有修复相应事件/预算不变量，不得通过。

## 2. 文件责任、任务分配与依赖

主 DS 管理共享状态/接口、集成和最终报告。子 DS 可并行设计/审阅互不重叠文件；**同一功能的测试者不负责修改该功能实现**。如只有单 DS，按下列阶段串行执行，不需要另造 Agent workflow。

| Task | 负责人/允许修改 | 输入 / 输出 | 依赖及退出条件 |
| --- | --- | --- | --- |
| T0 Baseline freeze | 主 DS；只更新本任务/矩阵，不碰产品 | 复核 HEAD/status/owner；复跑并保留 4 项 red 命令；列调用链、边界决策、测试文件表 | 首先完成；若发现新的授权/Outcome/schema 决策暂停相关点，其他可继续 |
| T1 R1 review-consumption 修复 | 实现 DS：`memory/work-cycle.mjs`，必要时 Board/evidence resolver；测试 DS：`tests/aegis-work-cycle-replace-consumed-sdk.mjs` + phase2纯测试 | 历史消费身份固定；替换/重复引用不能移窗；prefix/replay与真实工具路径 red→green | T0；先 green 才能合并到集成支线 |
| T2 R2 handoff-completion 修复 | 实现 DS：`extensions/aegis-observer.ts`、`session/handoff*.mjs`/Supervisor及必要 C6 Host；测试 DS：`tests/aegis-work-cycle-zero-budget-recovery.mjs` | 只有 Host/Supervisor 经预算/安全批准且真实新 Session 已绑定才完成特定 request；0→0 拒绝；纠正额度正例真实替换一次 | T0；不得靠 initial bind/JSON 自行完成。接口共享由主 DS冻结 |
| T3 K1 retrieval 状态一致 | 实现 DS：`memory/knowledge.mjs` 或最窄的 `aegis_work_review` adapter；测试 DS：`tests/aegis-work-cycle-knowledge-recovery-sdk.mjs` | readable empty→`no_match`、unreadable/missing→`unavailable`、命中→`ready`；选择事件、review payload、tool result 完全一致 | T0；按现有 runtime.note，不新事件/schema |
| T4 G1 read-only admission | 实现 DS：`memory/work-cycle.mjs` 工具分类与必要 Campaign/Observer permit 调用点；测试 DS：`tests/aegis-work-cycle-context-carry-sdk.mjs` | 授权 C6 `aegis_read` 在 hold 下真实成功读取当前 Task 授权 target；bash/write/direct effect 仍阻断；未授权路径仍拒绝 | T0；只允许共享分类中的真实只读工具，不凭名字放开未知控制/网络工具 |
| T5 Integrated verification | 主 DS 或独立测试 DS；允许只更新测试与报告，不改实现 | 五个补测 + 受影响回归，日志/退出码/关键 Event refs | T1–T4 green 后；发现新 red 回到对应 Task |
| T6 Limited review handoff | 主 DS + 未参与模块的审查 DS | 最终 diff、精确证据、遗留限制、状态与工作树 | 全部冻结 required green；再交独立验收，本任务不自授通过 |

文件分工可按实际调用点小幅调整，但主 DS须记录原因。共享 `memory/work-cycle.mjs` 同时被 R1/G1 修改时先冻结接口，避免并行覆盖。测试 DS 可以新增正式测试，不可改产品代码或生产配置。

## 3. T1：R1 review 消费身份必须历史不可移动

### 不变量

- 只有当时前缀中第一次通过既有 proposal/ref/effective Intent gate 的新 scope Intent，才能消费其所引用的当前 usable review/trigger。
- 消费是对既有事件的不可变历史投影；后续 Intent 被合法 `replace_event_id`、撤销出 effective view、改 scope 或再引用同一 review，都不能改写原消费 event ID、再次移动 `review_round_action_count` 或重新获得一个 review 回合。
- Board effective Intent 决定**当前 unit**，历史 committed prefix 决定**何时消费**。这两种用途不能共用最终 intent 列表。
- 累计 `action_count` 从可信 progress 起算，不被 review/Intent/replace/session 轮换清除。轮次计数仅由可信 progress 或当时合法且唯一的 current review 消费前移。
- 若 review 自身被后来 replacement supersede，仍须保留它曾否在当时合法消费的事实；但不能使它在当前 hold 中重新解锁。旧日志中不合法/错误引用不能升级为一次有效消费。

### 必须构造的对照

1. 正例：A stall→R review+selection→B(current有效新 Intent)引用 R；追加一次 action；投影 `consumption=(R,B)`、累计4、轮次1。
2. 替换反例：在同一 prefix 后追加 C 引用 R 且 `replace_event_id=B`；当前 unit=C，但 consumption 仍是 B，累计4、轮次1，不新增 consumption。
3. 重复替换：D 再替换 C 并仍引用 R，多轮重放仍只有 B 那条消费；不能用随机 event ID 多次续回合。
4. 相关性负例：C 不引用 R、foreign/future/bad ref、同 scope/rejected proposal 不消费；replace 仍服从现有 proposal replacement gate。
5. 新 stall：一次 R1 消费后，到合法 round 阈值形成 R2；R2 有新 trigger。R1 即使出现在 C/D refs 里不能消费 R2。
6. 新 review 正例：R2 被有效新 Intent E 消费一次；累计历史延续、round 窗口前移一次。
7. 同 prefix 多次纯 projection deterministically identical；删除 projections/RAM 后重放仍一致。

必须同时有纯 reducer 边界和真实 SDK `aegis_propose replace_event_id` 产品用例。不能只在 fixture 里直接构造最终 Board nodes 替代提交事件。

## 4. T2：R2 handoff request、attempt 与 completion 因果闭环

这是本轮最高风险边界，必须画出 before/after state table，并在真实 SDK/C6 路径检验。staged handoff JSON、`session_start`、`before_agent_start` 都不是预算批准，也不是成功创建 Session 的证据。

### 生命周期条件

1. Run1 中旧 Session 到达安全 settled，Host 从冻结 policy/request threshold 判断 boundary；Session 预算不足时 Supervisor refusal 必须保持 refusal。该次请求必须留下可区分的 blocked/recovery 状态，不能把它混为“待完成 handoff”，并且不能使新 Task effect 被重放。
2. Run2 首次创建的正常初始 Session 即使看到同一 staged file，也不得替 Run1 产生 `handoff.completed`。原因必须绑定真实 Host 授权 attempt 和明确目标 transition，而不是“该 PID 是新进程”或“Session id 与 staged source 不同”。
3. 额度仍为 0：同源恢复必须再次返回 budget refusal，无 completion、无 replacement Session charge、无下一 work-unit effect；原 action/pending responsibility保留。
4. owner 明确修正配置/可用预算后，恢复走已有 Host `recoverInterrupted`/Supervisor 许可，再执行同一个可恢复 boundary。`runtime.newSession` 确实创建不同对象/file/id、完成 bind/rebind 后才完成那一个 request/identity；新 Session 使用同 Episode/策略/预算，并重建 RAM。
5. completion 与有权执行的 replacement 必须可以一一对应并重放审计。拒绝 attempt 不占成功 rotation，不能出现同一 boundary 多个 completion/多次 Session 消费；unknown create/bind/fsync 仍保留责任。
6. 初始 SDK `session_start` 可绑定当前 task/session，但不得由此自行宣布历史 rotation 已完成。调用顺序和 authority owner 在最终代码/测试断言中显式可见。

实现可沿现有 C2 生命周期选择最小授权记录/回调调整；不得改 schema major、新增第二 EventLog/预算账本或由模型/JSON 授权。如果需要新的 Host→Observer handshake，字段必须由受信任 Host 生成、Durable/causation可核对、限定 request+episode+target boundary；重启不能把任意 handshake 文本当批准。

### 必须构造的对照

- 零预算 Run1 refusal→零预算 Run2 recovery: completion count 0、applied rotations 0、success effects 不增加、Task不完成、staged/recovery责任可见。
- 配额修复正例: Run2 一个 authorized Supervisor replacement；initial Session与replacement对象/ID/file不同；completion.to_session等于replacement；`rotation_attempts` applied一条；session consumption 正好 +1；charge/finish平衡；同一旧plan effect不重复执行。
- 注入 bind/continuation/completion append失败至少一个边界：无假 completion，不以 initial session替代，owner仍能解释并重试/恢复。优先复用 C2 fault helper；若此用例不能安全在本回合组合，记录为明确阶段风险，不伪造通过。
- 重复相同 recovery 调用：已完成request不二次rotate/charge；已拒绝request不变成complete，除非新的预算审批/authorized attempt 有 committed 依据。

## 5. T3：K1 知识结果的三态映射

review 对本地 `selectKnowledge` 做实际有界读取，定义边界映射：

| 实际 retrieval | Review selection 与 tool result |
| --- | --- |
| 存在有效且命中的 seed | `ready`，selected 非空，记录所选 IDs/digest/limits |
| 目录可读、读取成功、无相关/无有效命中 | `no_match`，selected=[]，不得说检索命中 |
| 根缺失、目录不可读、读失败、selection append 未 durable | `unavailable`，selected=[]或不完整记录但必须保留hold，不伪称 no_match |
| Host policy 明确关闭 | `disabled`，代表没有执行检索；不能伪称 checked |

当前真实产品观察为 readable empty→`ready`+empty。测试保持 red 并要求修复 adapter/review边界；不要通过将 `WORK_REVIEW_USABLE_STATUSES` 偷换、让不可用清门、或修改 expected 为 `ready` 解决。

分别用正常命中、空目录、无关 seed、seed格式无效/读取失败、缺根目录测试。用户可见 tool result、durable `knowledge.selected.status`、`work.review.retrieval.status` 必须一致；selection 必须早于 review、同 Episode/trigger、真实 status与实际 selected 内容对应。failed/unavailable review 保持 hold、允许恢复后同 trigger重试；`no_match` 是一次真实完成检索，不能把 empty变成 success/Fact，合法新Intent后可继续。

## 6. T4：G1 hold 下安全读取

当前 Gate 把 `aegis_read` 当 effect capability，虽然 C6 gate 明确 allowlisted该已注册只读工具；实现 T4前先核对这一 mismatch 的路径。契约要求**当前已授权的只读 workspace observation 可在 review hold 下使用**，不要求放开任意 file/network/control工具。

- 将 `aegis_read` 通过共享 work-cycle advisory/read-only classification 与 Campaign/Observer两层gate一致处理；不得只加一个 gate白名单而遗漏另一层。
- 真实调用 `aegis_read({path:"door.json"})` 必须成功返回 fixture 当前值；调用仍经过原 Task target/path grant和 C6 tool charge/finish。测试捕获 `tool_result`、value与EventLog identities。
- 未授权路径、`../` escape、symlink逃逸、未知/写工具、bash副作用、`aegis_execute` 等仍被原授权或 review gate拒绝；绝不因“read类”通配放行。
- 在 review active期间，workspace read只能作为观测，不自动清hold、不重置计数、不产生 trusted Outcome。后续合法 review/retrieval/intent照常。
- 同时继续证明 knowledge retrieval/review 可调用、effect仍真被拒。

若发现 `aegis_read` 本身没有经过安全授权或授权条件不可复用，停止扩充其权限并保留该项red；向 owner报告具体冲突，但可以先完成其他独立修复。

## 7. T5：TEST-09 和回归

已有 `aegis-work-cycle-reason-merge.mjs` 显示同刻合并通过。先审断言：必须从最终 staged handoff / committed boundary实际看两个理由，同一个真实 Supervisor applied rotation、completion与session budget增量各1；不能只因 config阈值等于常量或 boundaries两条都叫 review_turn就判过。报告 `committedRequests=8` 与 threshold边界时6之间的区别要解释（前缀/最终总量不同）。若真实产品结果满足契约，保留该用例即可，不因日志总数超过阈值误报失败。

T1–T4修复后，重跑5个正式新增补测：

```sh
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs \
  Pi_Agent_base/runtime/dev/<new-unique-task-log-dir> \
  aegis-work-cycle-knowledge-recovery-sdk \
  aegis-work-cycle-context-carry-sdk \
  aegis-work-cycle-replace-consumed-sdk \
  aegis-work-cycle-zero-budget-recovery \
  aegis-work-cycle-reason-merge
```

suite目录必须新建唯一 ignored 名称，不能覆盖 `p2-test-audit-final4` 或 `p2-audit-independent`。先运行四个确定性 red 确认预期失败，再修完运行上述完整命令；保存失败与通过结果分开。不得声称“test fixed”只因没有旧日志。

随后至少跑：既有 `aegis-work-cycle`、`-ram`、`-phase2`、`-sdk`、`-host-rotation`、`-checkpoint-campaign`、`-recovery`、`-policy`、C6 product-chain/lifecycle/SDK、C2 rotation、Observer failclosed/runtime handoff、knowledge campaign、RAM SDK。已知真实失败精确记录为red；不通过删测试/降低 expectation消除。

required 68、Biome、type baseline、module-layout：
- 只有业务实现有改动才按原第二阶段实现任务跑要求的完整产品门；当前测试委派报告中的旧结果不冒充本轮复跑。
- 新增/改测试跑对应Biome、`node Pi_Agent_base/tests/aegis-module-layout.mjs`；若只影响测试/文档且类型覆盖不变，不因测试委派伪造新type结果。
- 最终实现阶段由原实现委派执行 required/static/type，审查回合对关键实际路径做独立复跑，避免两个角色互相引用彼此结果形成循环证明。

## 8. 任务阶段、测试责任与完成条件

1. **T0 复核计划**：主DS核对现有脚本、四项red和源码边界；冻结事件引用与正负预期，完善矩阵。不得删除/覆盖本阶段五个脚本。
2. **T1–T4 实现+测试配对**：每一缺陷先在现有交付跑 red，再由不同角色各自实现/断言；共享 reducer/gate改动由主 DS统一合并。先达成最小单项 green，再做组合回归。
3. **T5 集成/恢复**：完整五脚本 suite + 受影响回归；修复和测试日志来自同一最终产品diff。
4. **T6 报告**：更新同一矩阵/报告的“补测 red→green”和新命令。原第二阶段自测 pass、补测初次 red、修复后复测不得覆盖或合并成一次执行。
5. **T7 限定审查交接**：所有本任务 blocker绿、实际运行证据充分后，标 `internally_verified / awaiting_external_review`；不自行标外部通过。若仍red，明确 `tested / changes_required` 和唯一剩余清单，交回修复。

## 9. 最终交付格式

逐项表格：`case_id | requirement | owner/commit state | exact command | exit | log | expected | observed | Event/Session/charge refs | status`。另报告文件清单、真实SDK/faux设置、代码是否修改、当前branch/HEAD/status、嵌套Pi状态、UI未触碰、未跑项、non-blocking/deferred、距离通过剩余项。

保留现有精确 red：R1消费迁移；R2零预算下 initial bind完成及预算修复后不走Supervisor；K1 empty→ready；G1授权 workspace read被effect gate拦。只有final tree逐项实际修复后绿才可关闭。无真实目标/真实模型对照，不声称求解率或学习效果提升。
