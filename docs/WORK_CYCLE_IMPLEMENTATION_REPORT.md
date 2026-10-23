# Work-cycle / 跨 Session 连续性实现报告

状态：**第一阶段内部自测记录；随后独立审查结论为 changes_required，尚未外部通过。**
独立反例复现 F1（旧 review 重复清零）、F2（checkpoint 无 Campaign 记账）、F3（旧单元完成串入新单元）。
复现序列与后续工作见 [第二阶段任务书](WORK_CYCLE_PHASE2_IMPLEMENTATION_TASK.md) §2。
下文保留当时实现/命令结果；第二阶段设计获认可不等于这些缺陷已修复或自动轮换已完成。
任务书：[WORK_CYCLE_AND_SESSION_HANDOFF_IMPLEMENTATION_TASK.md](WORK_CYCLE_AND_SESSION_HANDOFF_IMPLEMENTATION_TASK.md)。
契约冻结：[WORK_CYCLE_T0_BASELINE.md](WORK_CYCLE_T0_BASELINE.md)。
用例与命令：[WORK_CYCLE_TEST_MATRIX.md](WORK_CYCLE_TEST_MATRIX.md)。

## 1. 完成范围（诚实边界）

已实现：

- 纯函数 work-cycle 投影：重复路线、多路线无进展、trusted progress 重置、review/awaiting-scoped-Intent、
  确定性 trigger id、同 Episode/已提交 evidence 校验、trusted host policy。
- `runtime.note kind=work.checkpoint` / `kind=work.review` 的 Runtime 结构记录（schema 1.1，无新 event type），
  Board 投影为 **Artifact**，RuntimeState 增加 `work_checkpoints`/`work_reviews`（均为未验证规划元数据）。
- RAM `task.work_cycle` 核心 frame：状态/原因/证据别名/最近 review/检索状态/advisory handoff/context usage unknown。
- `aegis_work_review`：真实有界本地检索 + durable selection + review 关联；`disabled`/`no_match`/`unavailable`
  显式记录；同一 trigger 幂等。
- `aegis_work_checkpoint`：`continue|blocked|complete` 未验证规划记录。
- tool 门控：review 期间 effect-capable 工具阻断并终止同批；只读/检索/review/checkpoint/handoff 控制放行；
  `aegis_propose kind=intent` 必须是引用当前 review 的新 scope，且通过既有 proposal ref gate。
- 现有 Session Supervisor 接线：handoff payload 携带 bounded work unit/review refs；未决副作用拒绝轮换；
  真实 SDK 新 Session 同 Episode、预算连续、无 transcript 重放。
- C6 Campaign 控制工具 allowlist / 默认工具列表加入 review/checkpoint；EventLog/Board/RAM/Experience gate/
  Supervisor 均复用，无并行权威。

明确未实现 / 保持 advisory：

- **未**实现“work unit 完成/context 阈值自动轮换”。`recommendWorkHandoff` 只产生 advisory；真实轮换仍由
  现有 Host/Supervisor 或 `/aegis switch` 在安全边界执行。C6 现有自动轮换仍只由
  `config.session.max_requests_per_session` 触发（本轮未改其语义）。
- **未**改变 Experience 证据门、预算/授权、Episode/Outcome 语义，未新增持久 schema major、依赖或 Pi 核心修改。
- **未**运行真实模型/网络/目标实验（无授权）。EXP-01 四臂对照只有计划（§6）。
- 未新增 `aegis_run`/Broker 的轮换自动化；普通 `run-aegis`/`run-experiment` 入口仍需人工 `/aegis switch`。

## 2. 改动文件与关键调用链

| 文件 | 变更 |
| --- | --- |
| `Pi_Agent_base/memory/work-cycle.mjs` | 新纯模块：`projectWorkCycle`、`evaluateWorkCycleGate`、`validateWorkEvidence`、`readWorkReview/Checkpoint`、`resolveWorkCyclePolicy`、`recommendWorkHandoff`、工具分类 |
| `Pi_Agent_base/memory/state.mjs` | 投影 `work_reviews`/`work_checkpoints`；`work_review` knowledge 模式；CONTROL_TOOLS |
| `Pi_Agent_base/memory/board.mjs` | `work.checkpoint`/`work.review` → Artifact（仅 runtime 来源）+ 文本 |
| `Pi_Agent_base/memory/ram.mjs` | 核心 `task.work_cycle` frame、review 知识优先级、refs、budget 行为 |
| `Pi_Agent_base/extensions/aegis-observer.ts` | policy/context usage/投影接线；tool_call 门控；`aegis_work_review`（重写）、`aegis_work_checkpoint`；propose 复核 gate；settle advisory；handoff 传参 |
| `Pi_Agent_base/session/handoff.mjs` | bounded `work_cycle` 连续性字段（无授权/状态提升） |
| `Pi_Agent_base/session/handoff-host.mjs`、`session-supervisor.mjs` | 轮换前重建 work-cycle 并传入 handoff/RAM；同 Episode 预算逻辑不变 |
| `Pi_Agent_base/campaign/campaign-mode.mjs`、`c6-sdk-runtime.mjs`、`c6-entry.mjs` | Campaign control allowlist/默认工具；Host 发起 handoff 时携带 work-cycle |
| `Pi_Agent_base/tests/aegis-work-cycle*.mjs` | 新增 3 个脚本（pure/RAM+board/SDK+faux） |
| `docs/*` | T0 基线、测试矩阵、本报告、RAM/知识/README/模块规则同步 |

主要调用链：

```text
tool_call(bash/…) ──> projectWorkCycle(committed rows, host policy)
                   ──> evaluateWorkCycleGate ──block+terminate──> effect 不执行
                   ──allow──> 既有 inspectWorkPermit/action.requested

aegis_work_review ──> validateWorkEvidence ──> selectKnowledge(local)
                  ──> emit knowledge.selected(mode=work_review)
                  ──> emit work.review(retrieval.selection_event_id)
                  ──> RuntimeState.work_reviews / Board Artifact / 下一次 RAM

aegis_propose(intent) ──> work-cycle gate(新 scope + 引用 review/selection)
                      ──> validateProposal + inspectProposalRefs
                      ──> proposal.submitted ──> projectWorkCycle 清除 hold

context_with_system ──> projectWorkCycle + normalizeContextUsage
                    ──> recommendWorkHandoff(advisory)
                    ──> buildRamProjection(task.work_cycle) ──> provider request

aegis_work_checkpoint ──> validateWorkEvidence ──> emit work.checkpoint
                      ──> Board Artifact + RuntimeState（无 Fact/Outcome/Experience）

Host/Supervisor.rotate ──> projectState/projectBoard/projectWorkCycle
                       ──> evaluateHandoff(pending/unknown 拒绝)
                       ──> applyStagedHandoff ──> runtime.newSession
                       ──> 新 Session 首次 before_agent_start 写 handoff.completed
```

## 3. T0 冻结接口与阈值依据

详见 T0 文档 §3–§5。要点：

- 只复用 `runtime.note`（1.1）与 `proposal.submitted`；不新增 event type/schema major。
- `work.checkpoint`/`work.review` 字段、长度上限、evidence 与 selection 顺序校验、幂等 trigger、fail-closed 规则已冻结。
- trusted progress 复用 Board `permittedNodeType === Fact`，不另写规则。
- 阈值默认 `repeat_limit=3 / action_window=8 / min_distinct_routes=4 / context_pressure_percent=85`，
  仅从 `AEGIS_WORK_CYCLE_*` host env 读取；非法值回落默认并报告 `invalid`。模型不能提供阈值。
  这些是 T0 候选默认值，**owner 尚未确认为正式生产策略**；若用于自动生产副作用/轮换，需 owner 明确批准。
- 边界测试覆盖 limit−1/limit/limit+1；`min_distinct_routes` 与窗口关系、只读排除、unknown 结果、foreign/future refs。
- 复核门清除条件：review 绑定当前 trigger + 之后的新 scope Intent 引用 review（或 selection）。Intent/checkpoint/
  模型文本/exit code 均不清门。

## 4. 验收命令与结果（本轮最终工作树）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node Pi_Agent_base/tests/aegis-work-cycle.mjs` | 0 | pass |
| `node Pi_Agent_base/tests/aegis-work-cycle-ram.mjs` | 0 | pass |
| `node --import …/source-resolver.ts Pi_Agent_base/tests/aegis-work-cycle-sdk.mjs` | 0 | pass（真实 SDK+faux） |
| 8 个聚焦 SDK/回归脚本（c6-suite-runner） | 0 | 8 scripts, 0 failed |
| `run-required.sh`（显式 68 清单） | 0 | 68 scripts, 0 failed |
| Biome（14 个改动文件） | 0 | 0 error；1 个 HEAD 既有 warning |
| `tsc -p tsconfig.aegis-extensions.json` | 1 | 116 条，与 HEAD 逐条一致 |
| `tsc -p tsconfig.aegis-campaign.json` | 1 | 193 条，与 HEAD 逐条一致 |
| `tsc -p tsconfig.aegis.json` | 1 | 190 条，与 HEAD 逐条一致 |

逐用例结果、命令原文与日志路径见测试矩阵。日志在 ignored
`Pi_Agent_base/runtime/dev/work-cycle-final/`、`work-cycle-required-final/`；未纳入 Git。

基线对照：在干净 HEAD `d84b692` worktree 复跑 `aegis-ram-overflow-boundary`，第 3 用例已失败
（本轮未改该用例，且不在 required 清单）；`agentConfigDir` 未使用 warning 也是 HEAD 既有。
本轮没有新增 Biome error 或 tsc 诊断（按文件/行内容逐条 diff）。

## 5. 已知失败、剩余风险与限制

1. **阈值未经 owner 确认**：默认值只用于本任务可反驳的 stall 检测；不能称已校准生产参数。
2. **自动轮换未扩大**：work-unit/context 只是 advisory；普通入口仍需 `/aegis switch`；C6 自动轮换仍按既有
   `max_requests_per_session`。
3. **WC-08 `unavailable` 端到端未单独演练**：SDK 用例覆盖 `ready` 与 `disabled`；`no_match`/`unavailable`
   由 `selectKnowledge` 既有测试与 reducer 校验覆盖，产品路径未逐一触发。
4. **WC-13 的 cancel/bind/fsync 故障**：复用并通过既有 `aegis-c2-session-rotation`；本任务新用例覆盖
   “未决副作用拒绝轮换 + 真实恢复 + 一次轮换”，未重复 C2 的全部故障矩阵。
5. **性能**：每次 tool_call/请求重放 committed events 计算 work-cycle（O(n)）。长 Episode 有成本，未做缓存；
   correctness 不受影响，属后置优化。
6. **RAM 知识选择**：work_review selection 与 model_query 同优先级，合并上限沿用 8；review 记录内 selected IDs
   限制 8。极端情况需要模型重新检索。
7. **context usage**：只在 `ctx.getContextUsage()` 返回真实 tokens 时 known；SDK print 路径下通常 unknown，
   本地未用 faux 伪造 token 数。
8. **UI/报告**：Board 多出 work Artifact；现有 TUI/Inspector 读取同一投影，无新写路径；未新增 UI 真相。
9. **失败测试诚实性**：原型已被重构，未保留旧实现可执行 red 日志；测试矩阵中只把“旧实现会失败”作为设计依据，
   不声称为已留证。

## 6. EXP-01 四臂对照计划（未运行）

固定 task/model/tools/授权预算/reset，仅改变上下文组织：

1. 现有长 Session；
2. 短 Session + 现有 board；
3. 短 Session + work-unit frame；
4. 短 Session + frame + stall review/retrieval。

分别报告：独立成功/失败、路线重复次数、review 触发/检索命中/实际引用、tool/request/token/时间成本、
Session 数与轮换次数。真实模型与目标环境运行需要单独授权；本轮不声称 solve-rate 或 recall 提升。

## 7. Git 状态

- 分支：`feat/work-cycle-session-handoff`（起点 `d84b692`）。
- 嵌套 Pi：HEAD `2ba451d99`，未修改；本轮只读取其 SDK/文档。
- 未提交、未暂存（按用户指令）。`Pi_Agent_base/UI/` 保持未跟踪，未读取/修改/暂存/删除。
- 最终 `git status --short` 见交付回复。

---

# 第二阶段实现报告（internally_verified / awaiting_external_review）

状态：**本地实现与自测通过；独立复核后交回审查。不是外部验收。** 第一阶段记录与独立审查
`changes_required` 历史保留在前文/审查目录，不改写旧结果。

## 8. 修复与新增（F1/F2/F3 + P1–P5）

| 项 | 修复 | 证据 |
| --- | --- | --- |
| F1 | 复核消费改为因果前缀的“一次消费”；两个计数分离；trigger 由最早形成证据前缀固定，后续 action 不再改变已形成 trigger | `aegis-work-cycle-phase2`（旧 review 再引用累计 4/轮次 1，不归零；新 stall 新 trigger） |
| F2 | checkpoint/review 全部路径走 `workToolAccount.admit/finish`；内容复用与调用预算分离；拒绝路径也结清已 charge 单元 | `aegis-work-cycle-checkpoint-campaign`（2 次真实调用 2 charged+2 finished；0 额度无记录/无 charge） |
| F3 | 当前单元绑定 effective Intent `event_id + scope`；checkpoint/review 增补 `work_unit_event_id`；旧 complete 不跟随新单元，同 scope 新 Intent 也不继承 | `aegis-work-cycle-phase2` + RAM/SDK |
| P2-06 | `unavailable` 不可用但同 trigger 可重试；`ready/no_match/disabled` 显式 | phase2 + sdk |
| P3/P4 | C6 显式 `work_cycle` 配置、policy 冻结、complete/context 自动轮换、同 Task 非终态继续、Broker 最新 gate、恢复边界 | `work-cycle-host-rotation`、`work-cycle-recovery`、`work-cycle-policy` |
| P5 | selection → Intent 声明 → action 显式 refs → 独立 Fact 的 bounded usage 投影 | phase2 + RAM |

## 9. 改动文件与调用链

新增/修改（本阶段；第一阶段文件继续保留）：

- `memory/work-cycle.mjs`：effective Intent 绑定、checkpoint/review 单元事件、一次消费、两个计数、稳定的 trigger 形成、
  可用/失败 review、冻结 policy、rotation boundary/identities、`projectKnowledgeUsage`、`readWorkCycleRunState`。
- `memory/state.mjs` / `memory/board.mjs` / `memory/ram.mjs`：work review/checkpoint 投影、usage refs、核心 work frame。
- `extensions/aegis-observer.ts`：checkpoint/review 账本与 `work_unit_event_id`、review 重试、settle session id、handoff
  identity 复制、proposal gate、RAM 建议。
- `campaign/campaign-config.mjs`：additive `work_cycle` 校验（默认 disabled）。
- `campaign/c6-entry.mjs`：policy 冻结/冲突、Observer env、`executionPermit` work-cycle gate、Composite hold/review-turn、
  同 Task 自动轮换/继续循环、pre-rotation boundary、plan generation。
- `campaign/c6-model-worker.mjs`：decision action `source_refs`、plan generation。
- `campaign/scheduler.mjs`：hold/boundary/continued 记录、resume、非终态 review turn。
- `execution/broker-worker.mjs`：逐 effect 最新 gate + `work_review_required` 分类、action `source_refs`。
- `session/work-cycle-rotation.mjs`：纯 Host 轮换判定；`session/handoff*.mjs` 携带 identity/continuity。
- 新增测试：`aegis-work-cycle-phase2`、`-checkpoint-campaign`、`-host-rotation`、`-recovery`、`-policy`。

关键链：

```text
C6 Host loop (after host.run settles)
  → projectQueue + readWorkCycleRunState + latestSessionUsage
  → evaluateHostWorkCycleRotation (pure, frozen policy)
  → pre-rotation boundary (durable)
  → host.rotateSession → stageHostHandoff → SessionSupervisor → real SDK newSession
  → Observer post-bind handoff.completed (carries work_cycle_identity)
  → scheduler reconcile pending boundary → campaign.work_cycle.continued
  → dispatchOne same Task → model re-plans (fresh decision buffer/generation)
  → Broker per-effect executionPermit reads latest work-cycle
```

## 10. 策略启用与旧日志兼容

- `campaign-config-1.1` 新增 `work_cycle`；未出现 = `enabled:false`，不新增自动轮换（旧配置行为兼容）。阈值默认 3/8/4/85
  仅在显式启用时生效，仍是未校准候选。
- 首次执行写入一条 `campaign.work_cycle.policy`（policy + digest + enabled/limits）；恢复沿该绑定。配置不同 →
  `work_cycle_policy_conflict`，不写新事件；env 不改变已绑定策略。
- 旧 checkpoint/review 无 `work_unit_event_id`：仅在更早前缀能唯一解析出匹配 effective Intent 时派生绑定；否则保留历史、
  不触发完成轮换。旧事件不改写、不迁移。
- 旧 log 若第一阶段错误解锁：重放按新规则可恢复 hold；不自动重发已发生动作。
- `handoff.completed` 无 `work_cycle_identity`（旧完成记录）不被当作任何 boundary 的已完成身份；升级后可能允许一次新的
  合法 boundary 轮换，属于可解释迁移，不重复旧 request。

## 11. 验收命令（本阶段最终工作树）

| 命令 | exit | 结果 |
| --- | --- | --- |
| `node Pi_Agent_base/tests/aegis-work-cycle.mjs` | 0 | pass |
| `node Pi_Agent_base/tests/aegis-work-cycle-ram.mjs` | 0 | pass |
| `node Pi_Agent_base/tests/aegis-work-cycle-phase2.mjs` | 0 | pass |
| `node --import …/source-resolver.ts Pi_Agent_base/tests/aegis-work-cycle-sdk.mjs` | 0 | pass |
| `node --import …/source-resolver.ts Pi_Agent_base/tests/aegis-work-cycle-host-rotation.mjs` | 0 | pass（providers=16） |
| `node --import …/source-resolver.ts Pi_Agent_base/tests/aegis-work-cycle-checkpoint-campaign.mjs` | 0 | pass |
| `node --import …/source-resolver.ts Pi_Agent_base/tests/aegis-work-cycle-recovery.mjs` | 0 | pass |
| `node --import …/source-resolver.ts Pi_Agent_base/tests/aegis-work-cycle-policy.mjs` | 0 | pass |
| 14 个聚焦 SDK/C6/C2/Observer/RAM 回归（`c6-suite-runner`） | 0 | 14 scripts, 0 failed |
| `run-required.sh`（68 清单） | 0 | 68 scripts, 0 failed |
| Biome（本阶段改动文件） | 0 | 0 error；1 既有 warning |
| `tsc` extensions / campaign / aegis | 1 / 1 / 1 | 116 / 193 / 190，与 HEAD 逐条一致（无新增） |
| `aegis-module-layout.mjs` | 0 | 320 files / 963 refs |

日志：`Pi_Agent_base/runtime/dev/p2-final3/`、`p2-required/`（ignored）。

## 12. 两轮自动化与一次恢复的事件/账本证据

`aegis-work-cycle-host-rotation`（同一 Task `task-hard` / Episode `ep-task-hard`）：

- 3 个 Session：初始 + 2 次 supervisor 真实 `newSession`，`handoff.completed` 2 条、不同 `to_session`、不同
  `work_cycle_identity`；`episode.started` 仅 1 条；>=3 个 work-unit Intent。
- 2 个不同 trigger：2 条 `work.review`，均带 committed `knowledge.selected(mode=work_review)`。
- 每轮一次 4-action batch：前 3 个 effect 完成，第 4 个 `action.completed.status=rejected` 且
  `rejection_reason=work_review_required`（共 2 条）；无 `campaign.task.unknown`；最终独立 fixture Oracle 完成 Task。
- 7 个成功 effect（3+3+1）；无重复 step/action id；`c6.tool` charged/finished 平衡。

`aegis-work-cycle-recovery`：

- Run 1：`session_count=0` 使真实 Supervisor 拒绝轮换；Task 保持 running，review/checkpoint 各 1，boundary 与 staged
  handoff 保留，无 `handoff.completed`。
- 独立审查脚本复跑：`stale-checkpoint` exit 0、`checkpoint-campaign` exit 0；`old-review-sdk` 仍 exit 1，原因是其断言保留旧单计数
  “action_count=1”，而新契约要求累计 4 + 轮次 1（旧 review 不再消费）。正式 phase2 回归按新契约断言，不修改审查脚本历史。
- Run 2：同一 committed 源恢复；pending boundary 续接；一次轮换（1 条 `handoff.completed`）、1 个最终成功 effect；
  charged 无重复 key、无未结清 unit；旧 review consumption 仍为 1；无 plan replay、无 Task unknown/failure。

## 13. 各入口支持

| 入口 | 复核/checkpoint/gate | 自动轮换 |
| --- | --- | --- |
| C6（顶层 `work_cycle.enabled=true`） | 是 | **是**：complete / context / request 阈值合并，经 Supervisor；同 Task 非终态继续 |
| C6（未启用 work_cycle） | 是（effect gate 仍生效） | 仅既有 `max_requests_per_session` 路径 |
| `run-aegis` / `run-experiment` / `run-pi` | 是 | **否**：仍为模型 `aegis_switch_session` + 人工 `/aegis switch` |

## 14. Blocker / non_blocking / deferred

- current_blocker：无（本阶段承诺的内部自测范围）。
- non_blocking：
  - 产品路径只显式覆盖 `ready`/`disabled`；`no_match`/`unavailable` 由 `selectKnowledge` 与 reducer 覆盖，未逐一在 C6
    中触发。
  - `work_cycle` 的 request-threshold 与 complete 同刻的“合并一次轮换”没有单独构造组合用例（代码路径合并，matrix 标 not_run）。
  - 每次 effect/provider 边界全量重放 Board/work-cycle：正确性优先，性能优化 deferred。
- deferred：普通入口自动 Host、缓存优化、新 UI、全局技能评分、真实模型四臂对照（无授权）。
- 复评条件：C6 真实模型实验授权；或 production 默认策略需要 owner 确认 3/8/4/85。

## 15. Git 状态

- 分支 `feat/work-cycle-session-handoff`，HEAD `d84b692`；**未暂存/未提交/未 push**。
- 嵌套 Pi HEAD `2ba451d99`，未修改。
- `Pi_Agent_base/UI/` 保持未跟踪；本轮未读取/修改/暂存/删除。
- 未调用真实模型、网络或目标环境。


---

# 第二阶段补测（测试委派：tested / changes_required）

状态：**测试任务完成，产品仍有 red；本委派未修改产品实现。** 旧自测与独立审查记录保留。

## 16. 基线与所有权

- 分支 `feat/work-cycle-session-handoff`，HEAD `d84b692`；未暂存/提交/push。
- 嵌套 Pi `2ba451d99`，dirty=0；`Pi_Agent_base/UI/` 未读取/修改/暂存/删除。
- 本轮只改测试与文档；无真实模型/网络/目标。

## 17. 草稿收敛

未跟踪草稿 `aegis-work-cycle-missing-evidence-sdk.mjs`（3 cases/2 pass/1 fail）已收敛为两个正式脚本：
`aegis-work-cycle-knowledge-recovery-sdk.mjs`（06A/06B）与 `aegis-work-cycle-context-carry-sdk.mjs`（07）。
保留正确断言，补充真实 effect 拒绝、账本 charge/finish、replacement 首请求 RAM/hold、授权 workspace read 实际执行；
修正草稿的对象身份 `indexOf` 与“旧 transcript 重播”判断。草稿文件已删除。

新增 REG-R1（`aegis-work-cycle-replace-consumed-sdk.mjs`）、REG-R2（`aegis-work-cycle-zero-budget-recovery.mjs`）、
TEST-09（`aegis-work-cycle-reason-merge.mjs`）。

## 18. 实测结果（本轮）

| case | 结果 | 关键实际 |
| --- | --- | --- |
| TEST-06A unavailable 恢复 | **pass** | 2 reviews 同 trigger；`unavailable(selected=0)`→`ready(selected=3)`；失败 hold 下 effect 被拒；新 Intent 后 effect 执行；review 2 charged/2 finished；checkpoint 1/1；round 0→1，total 保留 |
| TEST-06B no_match | **FAIL / changes_required** | 可读空目录实际 review=`ready` + selected=[]，工具返回 `retrieval_status:"ready"`；预期 `no_match`（契约） |
| TEST-07 context carry | **FAIL / changes_required**（仅 workspace read） | usage 56977/64000=89.03%；Host 自动 1 次真实轮换；replacement 对象/id/file 不同；RAM hold/trigger/双计数/consumption 连续；effect 被拒；knowledge/review 可用；`aegis_read` 被 `effect_capable_tool_blocked_until_review_and_scoped_intent` 拒绝；最终 Task completed |
| REG-R1 replace consumed | **FAIL / changes_required** | beforeRound=1 → afterRound=0；total=4；consumption.intent 由 B 变为替换 C |
| REG-R2 negative | **FAIL / changes_required** | Run2 额度仍 0：completion=1、Task completed、effects 3→4、由 initial bind 写入 completion |
| REG-R2 positive | **FAIL / changes_required（同一缺陷）** | 纠正额度后仍无 Supervisor applied rotation；completion 绑定 Run2 initial Session；无 Session charge/replacement |
| TEST-09 reason merge | **pass** | threshold=6；1 rotation；staged reason 同时含 `work_unit_complete,auto_request_threshold`；一次 completion |

命令/exit/log：`Pi_Agent_base/runtime/dev/p2-test-audit-final4/`、`final3/`；5 脚本 4 failed（均为保留 red），1 pass。
回归：7 个既有 SDK/C6/C2 脚本 0 failed；pure/RAM/phase2 0；Biome 0；module-layout 0；`git diff --check` 0。
required 68 / 完整 14 / tsc 本轮 not_run（未改产品，引用第二阶段 DS 证据）。

## 19. 距离通过（交原实现者）

1. 修复 R1：消费关系固定在历史 committed prefix，不随最终 effective Intent 移动。
2. 修复 R2：staged handoff 不能由新进程 initial bind 自动完成；额度/安全未通过时保持拒绝且不执行下一单元 effect；纠正额度后经真实 Supervisor/newSession，一次 completion/charge。
3. 修复 no_match：可读空目录的 review 边界显式 `no_match`、空 selected、工具返回一致；不得由测试改 expected。
4. 处理 P2-07 workspace read：将授权只读工具纳入 review hold 的 advisory 路径，或由 owner 明确改契约；不能用知识查询替代。
5. 修复后重跑 5 个补测脚本与受影响回归；产品门按原任务执行。

## 20. 本轮文件与 Git

新增测试 5 个（上述），删除未跟踪草稿 1 个；更新本报告与测试矩阵。产品实现、Pi 核心、依赖、配置、凭据均未改；未暂存/提交/push；`Pi_Agent_base/UI/` 未触碰。

---

# 第二阶段收尾修复与限定复验（实现 DS，2026-10-22 第三执行轮）

状态：**`internally_verified / awaiting_external_review`。** R1/R2/K1/G1 已在同一最终工作树修复；聚焦 5/5、受影响回归 17/17、完整 14/14、required 68/68 均独立重跑为 0 failed。未做真实模型解题实验，不声称 solve-rate、学习收益或普通入口自动化成立。

## 21. 本轮修复（red→green）

| 问题 | 修复位置/不变量 | 真实 red（本执行轮） | 修复后 green（同一最终树） |
| --- | --- | --- | --- |
| R1 review 消费迁移 | `memory/work-cycle.mjs`：当前 unit 仍用 Board effective Intent；历史消费用“在各自 committed 前缀被 Board 接受的 Intent”扫描，`replace_event_id` 只改变当前 unit，不重写已提交消费 | `p2-remediation-red-205004`：`REPLACE_EVIDENCE beforeRound=1 afterRound=0 total=4`，consumption 从 B 移到 C | final5b：beforeRound=1/afterRound=1/total=4；review `b398ce01…`、selection `b7bca67e…`、consuming Intent `78fd4181…` 保持；多次 replace、replay、新 stall/review product 与 pure 均通过 |
| R2 handoff completion 越权 | `session/handoff-grant.mjs` + Observer/supervisor/Host：只有 live Host attempt（request+episode+source Session+attempt id）可让 replacement 写 completion；initial bind/staged JSON 无权限。`c6-entry` 在 dispatch 前经 Supervisor recovery；0→0 拒绝时不跑下一单元 | red：Run2 仍 0 额度却 completion=1、Task completed、effects 3→4；positive 无 Supervisor applied rotation/completion 绑 initial | final5b negative：staged `host-rotate-105-1792674088722`，refusal `limit=0…remaining=0`，completions=0，effects 3→3；positive：request `host-rotate-105-1792674089655`、completion `7f478e0e…`、attempt `d811eb8e…`、from `01a163b3-cae0…` → to `01a163b3-cb06…`、Session consumed 0→1、1 completion、1 新 effect、账本平衡；缺 completion 故障路径拒绝且保留 staged，随后恢复成功 |
| K1 empty corpus | 仅 `aegis_work_review` 边界：可读检索成功但 selected=[] 时映射为 `no_match`；不改一般 `selectKnowledge` API，不把 unavailable 降级 | red：实际 review `ready`+[]、工具 `retrieval_status:"ready"` | final5b：review `36ab77c6…`/selection `2733985b…`/trigger `wrev_80b8599b59952bde` 均为 `no_match(selected=0)`；工具结果一致；无 Fact/Outcome；06A unavailable→ready 恢复仍通过 |
| G1 hold 下只读 read | `WORK_READ_ONLY_TOOLS` 加入真实注册工具 `aegis_read`（Observer gate 与 C6 `isWorkCycleAdvisoryTool` 共用同一分类）；Campaign/Task/path grant 与 charge/finish 不变 | red：`effect_capable_tool_blocked_until_review_and_scoped_intent` | final5b：action `tool:1792674082965:if4gxprhgtb` 真实返回 `{"locked":true}`；request/completion `24d0c984…`/`76c1ac66…`，charge/finish `6c37d3bd…`/`06358752…`；`../outside.json` 仍被 path grant 拒绝；read 后 hold 仍 required、round 4→4、无新 consumption；effect 仍拒 1 次 |
| TEST-09 多理由合并 | 保留既有实现；本轮只复核 | 历史 not_run | final5b：threshold=6、committedRequests=8、boundaries 两个 `review_turn`、rotations=1、一次 completion/Session 消费，staged reason 同时含两理由 |

## 22. 本轮执行证据（与旧记录分开）

| 命令 | exit | 结果/日志 |
| --- | --- | --- |
| 四脚本 initial red（`c6-suite-runner`） | 1 | 4 scripts / 4 failed；`runtime/dev/p2-remediation-red-205004` |
| 五脚本 final focused（`knowledge-recovery context-carry replace-consumed zero-budget reason-merge`） | **0** | **5 scripts / 0 failed**；`runtime/dev/p2-remediation-final5b-210118` |
| 17 个受影响 SDK/C6/C2/Observer/RAM 回归 | 0 | 17 scripts / 0 failed；`p2-remediation-regression-205659` |
| 完整 14 回归（旧清单） | 0 | 14 scripts / 0 failed；`p2-remediation-full14-*` |
| `run-required.sh`（E1 68） | 0 | 68 scripts / 0 failed；`p2-remediation-required-205813` |
| Biome（31 个本轮/阶段改动 Aegis 文件） | 0 | 0 error；1 个既有 `agentConfigDir` unused warning |
| tsc extensions / campaign / aegis（`Pi_Agent_base/`） | 1 / 1 / 1 | 行计数 66 / 193 / 190；改动文件无新增诊断；`handoff-host.mjs` 既有两条 JSDoc 返回类型诊断保留。历史 116 的 extensions 计数方式未复现，不能写成逐条一致 |
| `aegis-module-layout.mjs` | 0 | 326 source/test files / 989 refs，无缺失 |

原始命令（聚焦组，仓库根）：

```sh
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs \
  Pi_Agent_base/runtime/dev/p2-remediation-final5b-210118 \
  aegis-work-cycle-knowledge-recovery-sdk \
  aegis-work-cycle-context-carry-sdk \
  aegis-work-cycle-replace-consumed-sdk \
  aegis-work-cycle-zero-budget-recovery \
  aegis-work-cycle-reason-merge
```

## 23. 关键身份与账本

- TEST-06A unavailable/ready：同 trigger `wrev_1b62aeaa0ec339e7`；selection `340076a6…(unavailable,0)` → `ec44343f…(ready,3)`；review `3c4d817d…` → `372cbd88…`；2 charged/2 finished，checkpoint 1/1。
- TEST-06B no_match：trigger `wrev_80b8599b59952bde`；selection `2733985b…`；review `36ab77c6…`；status/selected/tool result 三处一致。
- TEST-07：source `01a163b3-ae24-765a-ad0f-34d7b78fdd66`，replacement `01a163b3-afb2-765a-ad0f-34d952be0f11`；usage `56977/64000=89.0266%`；identity `context:<source>:56977:64000`；object/id/file 均不同；RAM hold/trigger/计数/consumption 连续；read 的 action/request/completion/charge IDs 见 §21。
- R1：review `b398ce01…`、selection `b7bca67e…`、consuming Intent `78fd4181…`、trigger `wrev_a5a3fb7daed01e64`；round 1、total 4 在 replace 前后不变。
- R2 negative：staged `host-rotate-105-1792674088722`；refusal 明确 `session budget is exhausted (limit=0, base_consumed=0, committed_rotations=0, remaining=0)`；completion 0，effect 3→3。
- R2 positive：request `host-rotate-105-1792674089655`、completion `7f478e0e-ece4-43b9-be51-99b8654fbe15`、attempt `d811eb8e-6821-4626-90b4-5c6ca7cb73d4`、from `01a163b3-cae0-778d-a6d2-9c6e2a68d24c` → to `01a163b3-cb06-778d-a6d2-9c71ae9e31ba`；Session consumed 0→1、limit 4；1 applied rotation、1 completion、1 新 effect；charge/finish 平衡。
- TEST-09：threshold=6、committedRequests=8（前缀边界时 6，最终总量 8 不矛盾）、boundaries 两个 `review_turn`、rotations=1。

## 24. 文件、工作树与限制

本轮产品文件：`Pi_Agent_base/memory/work-cycle.mjs`、`extensions/aegis-observer.ts`、`session/handoff-grant.mjs`（新增）、`session/handoff-host.mjs`、`session/session-supervisor.mjs`、`campaign/c6-entry.mjs`。测试/文档：`aegis-work-cycle-phase2.mjs`、`-replace-consumed-sdk.mjs`、`-zero-budget-recovery.mjs`、`-context-carry-sdk.mjs`、`aegis-c2-supervisor-boundaries.mjs`、本报告与测试矩阵。上一阶段未提交实现/测试全部保留。

- 分支 `feat/work-cycle-session-handoff`；HEAD `d84b69206157c20710e0c4c5f3d08c6e79c64eb4`。
- 嵌套 Pi `2ba451d997098515c36744c56e1f604c842895b0`，dirty=0。
- 未暂存、未提交、未 push；未 reset/clean/stash；`Pi_Agent_base/UI/` 未读取/修改/暂存/删除。
- 未触发真实模型/网络/目标/凭据；仅真实 Pi SDK + faux + 临时本地 filesystem/EventLog。
- 剩余：tsc 既有基线红（非本轮新增）、真实解题率/普通入口自动 Host/UI/性能缓存 deferred。外部验收尚未发生，本状态为 `internally_verified / awaiting_external_review`。

---

# 第三阶段：普通入口常驻 Console Host（实现报告）

状态：`internally_verified / awaiting_external_review`。外部独立验收未发生；无真实模型/网络/目标调用，不声称解题率或知识收益。详见 [第三阶段任务书 §11](WORK_CYCLE_PHASE3_HOST_CONSOLE_IMPLEMENTATION_TASK.md#11-实现交付内部验证轮) 与 [矩阵 §G](WORK_CYCLE_TEST_MATRIX.md#第三阶段experiment-console-hosthc-01hc-16)。

## P3.1 变更文件

| 文件 | 类型 | 作用 |
| --- | --- | --- |
| `run-experiment.sh` | 改 | 默认 exec 常驻 Console Host；`--console/--cli`、`--max-auto-rotations`、`--max-continuations`；导出冻结策略与 label；`--help` 记录控制/退出方式；管理子命令仍直通 CLI |
| `Pi_Agent_base/session/experiment-console.mjs` | 新 | Host 生命周期：租约、chain 校验、EventLog 单写绑定、recover、dispatch、settled 决策、有界轮换、pause/resume/stop、派生状态 |
| `Pi_Agent_base/session/experiment-console-entry.mjs` | 新 | 真实 Pi SDK runtime 组装（显式资源 allowlist、复用配置 model/auth、faux seam）、行式 readline 控制台、非交互模式 |
| `Pi_Agent_base/session/handoff-stage.mjs` | 新 | 从 `c6-entry` 抽出的 Host 交接 staging（Campaign 与 Console 共用同一 `evaluateHandoff` 校验） |
| `Pi_Agent_base/memory/projection-checkpoint.mjs` | 新 | 绑定 hash 前缀/policy/reducer 版本的派生投影缓存；不变量校验与 full-replay 回退 |
| `Pi_Agent_base/memory/work-cycle.mjs` | 改 | `unscoped` / `work_unit_state` / `bootstrap_review` / `accepted_intent_count` / `complete_candidate`；`evaluateWorkStartGate`；bootstrap review 可用性与一次性消费 |
| `Pi_Agent_base/memory/ram.mjs` | 改 | 工作帧携带 `work_unit_state/unscoped/trigger/双计数/consumptions`；仅在启动门启用时输出 `unscoped` 帧 |
| `Pi_Agent_base/extensions/aegis-observer.ts` | 改 | admission 层启动门 + `kind=intent` 必须带非空 scope；review 的 `bootstrap` 标记；`projectWorkCycleSafe` 暴露 `start_gate_enabled` |
| `Pi_Agent_base/campaign/c6-entry.mjs` | 改 | 最终 permit 增加 `work_unit_unscoped`；`stageHostHandoff`/`resolveOpenEpisodeId` 改为复用 `session/handoff-stage.mjs` |
| `Pi_Agent_base/execution/broker-worker.mjs` | 改 | `work_unit_unscoped` 计入 Broker 的 work-cycle 阻断分类 |
| `Pi_Agent_base/shared/events.mjs` | 改 | `readEventsSafe`/`readEventsStrict`（跨模块复用）+ `EventLog.refresh()`（Host 读取已提交前缀） |
| `Pi_Agent_base/session/AGENTS.md`、`memory/AGENTS.md` | 改 | 新增验证入口 |

未改：`Pi_Agent_base/UI/`、Pi 核心、依赖、Outcome/Episode/领域独立门、EventLog schema/预算账本结构。

## P3.2 真实调用链（普通入口）

`run-experiment.sh` → `experiment-console-entry.mjs`（`createConsoleSdkRuntime`: `createAgentSessionRuntime` + `createAgentSessionServices` + `createAgentSessionFromServices`，资源 allowlist 仅 Aegis Observer）→ `createExperimentConsole`（`EventLog` + `bindHostEventLog` + `createSessionSupervisor`）→ 每个 settle：`projectWithCheckpoint` → `evaluateConsoleRotation`（`recommendWorkHandoff` + review-hold）→ `stageHostHandoff` → `supervisor.rotate` → `applyStagedHandoff` → `runtime.newSession` → 新 Session `before_agent_start` 写 `handoff.completed`（attempt 绑定）→ Host 校验唯一 completion → 继续同 Task/Episode。

## P3.3 关键不变量

1. 没有 durable scoped Intent → 没有任何 effect（admission + 最终 permit 双层）。
2. stall 的 trigger 只由 committed action 身份/结果派生；review/Intent/轮换不清累计计数。
3. review 只能被一个后续合法 scoped Intent 消费一次；历史消费不因替换移动。
4. bootstrap review 不伪造 work unit；只有“此前没有任何 accepted Intent”时才被承认。
5. 轮换只是上下文刷新：hold/trigger/双计数/consumption/预算/Episode 全部保留；新 Session 首个请求看到同一 hold。
6. 轮换受 trusted Host 冻结上限约束；无进展时停止并 `blocked`，不重启、不写 Outcome。
7. 一个 label 只有一个 EventLog writer；Observer 借用 Host writer，崩溃/重启先 recovery 再派发。
8. 缓存/checkpoint 只加速派生；任何权限判定仍从 committed EventLog + Supervisor 重新读取。

## P3.4 验证

见 [矩阵 §G.3](WORK_CYCLE_TEST_MATRIX.md#g3-命令与真实退出码最终工作树)：5 新脚本 / 5 补测 / 19 受影响回归 / required 68 全部 0 failed；Biome 0 error（1 条既有 warning）；tsc 66/193/190 与第二阶段实测基线一致；module-layout 0。

## P3.5 剩余限制

- 交互界面是行式控制台，不是 Pi TUI，也未声称 TUI 可用。
- 普通入口没有自己的 durable 预算账本：`sessionBudget` 默认 null，仅以 `max_continuations` 与既有安全门约束；真实的 request/tool 计费仍由 C6 ledger 路径与既有测试覆盖。
- 被拒绝的 rotation attempt 仅存在于进程内；重启后可能对同一边界重试一次（受 committed completion 与上限约束）。
- 真实模型/网络/目标与真实 CTF 对照未运行；无解题率/知识收益结论。

---

# 第三阶段修复：启动所有权顺序（ownership before Session）

状态：`externally_reviewed / scoped_checks_passed`（ownership 修复及限定回归已独立复核）。缺陷由独立复现确认：**取得 ownership 之前已经产生运行事件**。本状态不代表真实目标解题收益或跨进程预算验收。

## R.1 修复前后真实顺序

| | 顺序 |
| --- | --- |
| 修复前（缺陷） | entry：`createConsoleSdkRuntime()` → `createAgentSessionRuntime` → `bindExtensions`（Observer `session_start` 写 `session.started`）→ `createExperimentConsole()` → `host.start()` → `acquireCampaignOwnership()`。第二个同 label 进程被 lease 拒绝之前，已经向原运行的 EventLog 追加了一条新 Session 的 `session.started` |
| 修复后 | entry 只解析参数并把 SDK 组装放进 `sessionFactory`；`host.start()`：`acquireCampaignOwnership` → `EventLog.open`+`verifyChain` → `bindHostEventLog` → **再**调用 factory（创建 runtime + 绑定初始 Session/Observer）→ pending/unknown + 冻结 policy + staged handoff → Supervisor 恢复 → 允许派发 |

所有初始化资源按实际状态记录：`ownershipHeld`、`bound`、`log`、`sessionFromFactory`、`started`。清理顺序固定为 dispose 自己的 Session（此时仍持有 lease + writer，Observer 的 shutdown 事件仍走 Host writer）→ unbind → close log → 恢复 env → release lease；幂等，拒绝实例不触碰他人资源。启动被拒时 entry 以非零退出：ownership 冲突 `4`，其他 startup 拒绝 `3`，并打印真实原因。

## R.2 修改文件与兼容影响

| 文件 | 变更 |
| --- | --- |
| `Pi_Agent_base/session/experiment-console.mjs` | 新增 `sessionFactory`（生产入口）与 `session`（预绑定 seam，文档化其无法阻止已发生事件）；`start()` 重排为 ownership → log → bind → factory → recovery；`cleanupOwn()`/`failStart()`；`resume()` 在已清理的 blocked 实例上重新 `start()`；`status()` 容忍无 Session；`bindHostEnv` 额外冻结 `AEGIS_EVENT_LOG`/`AEGIS_HANDOFF_FILE`/`AEGIS_TASK_ID`/`AEGIS_EXPERIMENT_LABEL`，保证 Observer 只能写 Host 的同一 writer |
| `Pi_Agent_base/session/experiment-console-entry.mjs` | 删除构造期创建 runtime；改用 `sessionFactory`；startup 失败直接报告原因并退出（不再进入死控制台）；成功时打印显式屏障 `Aegis console ready: label=… ownership=held session=… episode=…`；`createConsoleSdkRuntime` 在初始 bind 失败时 dispose 自己刚创建的 runtime |
| `run-experiment.sh` | 仅注释：说明 ownership 先于 SDK/Session 创建；启动调用点不变（仍只 exec entry） |
| `Pi_Agent_base/tests/aegis-work-cycle-console-sdk.mjs`、`aegis-work-cycle-bootstrap-intent.mjs` | 改为通过 `sessionFactory` 创建 runtime（让语义测试也走生产启动顺序） |
| `Pi_Agent_base/tests/aegis-work-cycle-console-ownership.mjs` | 新增 TEST-OWN-01/02/03 |
| `shared/events.mjs`、`campaign/ownership.mjs` | 未改动（复用现有 binding/lease 接口） |

既有语义未变：Session≠Episode、review hold、bootstrap Intent 与一次消费、累计/轮次双计数、handoff attempt grant、未知副作用责任、预算/阈值/权限/Outcome 门均未修改。预绑定 `session` 的旧调用方式保留（现有语义测试已改为 factory，seam 只作兼容）。

## R.3 red → green 证据

| 项 | red（修复前） | green（修复后） |
| --- | --- | --- |
| TEST-OWN-01（两进程） | A 前缀 1 行/1 `session.started` → B 启动后 2 行/2 `session.started`（新 session id）；B 未退出（timeout）。日志 `runtime/dev/p3-own-red-234828/own01-red.log` | B exit=4；bytes/size/rows/last digest/session.started/session 文件清单全部不变；B 无 ready 行；A 仍可写入；A 停止后合法恢复 exit 0 且同一 Episode |
| TEST-OWN-02（同进程 factory） | 接口缺失：`createExperimentConsole requires a session adapter…`（exit 1）。日志 `runtime/dev/p3-own-red-234828/red.log` | factory 调用次数 0、Session 创建 0、EventLog 字节不变；被拒实例 shutdown 不影响 owner；正例 owner 正常创建 1 个真实 Session 并写 1 条 `session.started` |
| TEST-OWN-03（初始化失败清理） | 接口缺失 | SDK 创建失败：无事件、原因可见、lease 释放、可重启；post-bind 失败：保留真实 `session.started`/shutdown 历史、无 completion/effect/Outcome、链有效、lease 释放；重复 shutdown 幂等 |
| OWN-04（恢复兼容） | — | `aegis-work-cycle-console-restart` 复跑 0 failed（`--resume`、pending 拒绝、零预算拒绝、纠正后 Supervisor 恢复） |

## R.4 A/B 身份与前后对比（TEST-OWN-01，最终树）

```text
OWN-01_EVIDENCE
  before:  rows=11  last=sha256:9f9a4577…880d66  sessions=[2026-10-22T16-17-49-711Z_01a16467-….jsonl]
  afterB:  rows=11  last=sha256:9f9a4577…880d66  sessions=[2026-10-22T16-17-49-711Z_01a16467-….jsonl]
  bExit=4   recoveryExit=0
```

- ownership 身份：每次 console 实例 `ownerId = <pid>:<uuid>`（同进程两个实例也不共享）；租约目录 `<runtime>/console/<label>/owner.lock`。
- 比较项：EventLog 原始字节、文件大小、已提交行数、末尾 `event_digest`、`session.started` 数、`session.shutdown` 数、`handoff.completed` 数、`sessions/` 持久 Session 文件清单。
- 屏障：A 的显式 ready 行（在 `start()` 成功之后打印）+ 事件静止判定（file size 稳定 1.5s 且已有 `agent.settled`），不用固定 sleep 推断。

## R.5 测试与静态检查（最终树）

| 命令 | exit | 结果 |
| --- | --- | --- |
| `c6-suite-runner …/p3-own-final-1023-002056`（ownership + Phase 3 五脚本） | 0 | 6 scripts, 0 failed |
| `c6-suite-runner …/p3-own-remediation-1023-001509`（Phase 2 五补测） | 0 | 5 scripts, 0 failed |
| `c6-suite-runner …/p3-own-regression-1023-001525`（21 受影响回归） | 0 | 21 scripts, 0 failed |
| `run-required.sh …/p3-own-required-1023-002414 6` | 0 | 68 scripts, 0 failed |
| Biome（42 文件） | 0 | 0 error；1 条既有 warning |
| tsc extensions/campaign/aegis | 1/1/1 | 66/193/190（基线不变，新文件无诊断） |
| `aegis-module-layout.mjs` | 0 | 336 files / 1029 refs |
| `git diff --check` | 0 | 无空白错误 |

未运行：真实模型/网络/目标、真实 CTF 对照、TUI、普通入口独立 durable 预算账本。

## R.6 剩余限制（如实保留）

- 被拒绝的 rotation attempt、`autoRotations` 和 `continuations` 计数保存在进程内；`max_auto_rotations`/`max_continuations` 限制当前 Host 进程，重启重新读取配置并重新计数。已提交的 `handoff.completed` 仍用于识别完成的边界，但不能据此宣称存在跨重启累计预算。本轮没有新增跨进程预算协议。
- `session`（预绑定 adapter）seam 保留但仅用于已存在会话的测试；它无法阻止 `start()` 之前发生的事件——生产入口（`run-experiment.sh`）只使用 `sessionFactory`。
- B 进程的 Session 文件在 SDK 首次 prompt 前不会落盘，因此 OWN-01 的 Session 文件清单断言配合真实 prompt 前缀一起使用；`session.started` 计数是更强的判据。

## R.7 独立复核（最终交付树）

独立审查确认生产入口使用 lazy `sessionFactory`，ownership 拒绝发生在 SDK/Observer 创建之前；失败实例只清理自身资源。复验使用真实 Pi SDK + faux provider 和临时本地目录，未调用真实模型、网络或目标。

| 检查 | 真实退出码 | 结果与证据 |
| --- | --- | --- |
| ownership + Phase 3 五脚本 | 0 | 6/6；`runtime/dev/audit-p3-own-review-final/console/` |
| Phase 2 五补测 | 0 | 5/5；`runtime/dev/audit-p3-own-p2/` |
| 受影响回归 | 0（各实际脚本） | 20 项在 `audit-p3-own-review-final/regression/`；`aegis-campaign-c1-ownership` 单独在 `audit-p3-own-review-ownership-regression/` 通过。首次 suite 因审查命令误写不存在的 `aegis-campaign-c1-integration-ownership` 而 exit 1，未将该次 suite 算作通过 |
| required | 0 | 68/68；`runtime/dev/audit-p3-own-review-final/required/` |
| Biome（42 文件） | 0 | 0 error / 1 既有 warning；`audit-p3-own-review-final/biome.log` |
| tsc extensions/campaign/aegis | 1/1/1 | 66/193/190 diagnostics，保留既有失败基线 |
| module-layout / diff whitespace | 0/0 | 336 files / 1029 refs；无空白错误 |

独立 OWN-01 观察：A 的 11 行前缀在 B 启动前后字节与链尾一致，B exit 4，恢复进程 exit 0；A 在 B 被拒后仍可追加事件，恢复保持同一 Episode。第一次前台复跑因工具等待超时未获得结果，随后通过后台 driver 保存真实退出码，最终六脚本 exit 0。

内嵌 Pi HEAD 为 `2ba451d997098515c36744c56e1f604c842895b0`，工作树 clean；与 Aegis 主仓库 HEAD 是不同仓库的提交，不应写成同一 HEAD。

---

# 第四阶段：Aegis WebUI（实现报告）

状态：`internally_verified / awaiting_external_review`。外部独立验收未发生；无真实模型/网络/目标调用，不宣称解题收益。契约见 [WEBUI_CONSOLE.md](WEBUI_CONSOLE.md)，用例见 [矩阵 §W](WORK_CYCLE_TEST_MATRIX.md#第四阶段aegis-webuiweb-01web-08)。

## W.1 已完成能力与实际启动命令

```sh
./run-experiment-web.sh                # http://127.0.0.1:7800（仅 loopback）
./run-experiment-web.sh --port 7801    # 换端口
# 行的 Console 与旧入口保持：
./run-experiment.sh <label> [--resume] [--cli]
```

浏览器可：列出/新建/打开实验；看真实状态、对话、工具时间线；发送消息、暂停派发、恢复、停止 Host；查看进度/图板/知识/ Session-RAM/行动结果/文件；刷新与断线重连按 cursor 续传；Session 轮换后仍在同一 Task/Episode 显示并可用分隔条追溯。

## W.2 真实调用链

```text
浏览器 (Preact/htm, Aegis-pocket 视觉语言)
  → GET/POST /api/* + SSE                      console-web/server.mjs（loopback、Host/Origin 校验）
  → 每个活跃实验一个 Host 子进程                run-experiment.sh … -- --control stdio
  → Experiment Host（唯一 writer）              session/experiment-console.mjs
       ownership → EventLog open/verify → bindHostEventLog → SDK runtime/Session
       → pending/unknown+policy+staged handoff → recovery → dispatch
  → Observer / Broker / SessionSupervisor（未改动语义）
  → EventLog（唯一事实）→ 同一投影 → 面板/transcript/SSE
```

- 控制语义集中在 `console-web/control.mjs`（dispatch/pause/resume/stop/receipt）；HTTP 只校验并转发。
- Host 新增两个窄接口：`committedEvents()`（刷新+读已提交前缀）与 `appendControlReceipt()`（写 inert `runtime.note kind=web.control.receipt`，Board/RAM 忽略该 kind）。
- 前端与后端共享**同一份** transcript 映射（`view.mjs#transcriptEntry`），因此“重连后的形状 == 新加载的形状”。

## W.3 修改文件

| 文件 | 仓库 | 作用 |
| --- | --- | --- |
| `run-experiment-web.sh` | 主 | 本地 Web 启动（source resolver，仅 loopback） |
| `Pi_Agent_base/console-web/server.mjs` | 主 | HTTP/SSE 适配、实验注册、Host 子进程管理、静态资源、安全边界 |
| `Pi_Agent_base/console-web/control.mjs` | 主 | 控制请求语义、幂等 receipts、错误码 |
| `Pi_Agent_base/console-web/view.mjs` | 主 | 有界只读视图 + transcript 映射（五类面板的唯一实现） |
| `Pi_Agent_base/console-web/workspace-files.mjs` | 主 | 工作区 realpath 限制、有界列目录/读文件 |
| `Pi_Agent_base/console-web/AGENTS.md` | 主 | 模块职责/边界/验证入口 |
| `Pi_Agent_base/session/experiment-console.mjs` | 主 | `committedEvents()`、`appendControlReceipt()`、status 增加 model |
| `Pi_Agent_base/session/experiment-console-entry.mjs` | 主 | `--control stdio`、`--faux-script`（离线 dev）、live token 通知、控制模式不打印人类 banner |
| `run-experiment.sh` | 主 | `--resume` 从 run.json 恢复 provider/model；run.json 记录 provider/model 与 work_cycle 策略 |
| `Pi_Agent_base/tests/aegis-webui.mjs` | 主 | WEB-01..WEB-06 生产链路测试（66 checks） |
| `Pi_Agent_base/tests/aegis-module-layout.mjs` | 主 | 生产目录加入 `console-web`（依赖检查保留） |
| `Pi_Agent_base/README.md`、`docs/README.md`、`docs/WEBUI_CONSOLE.md` | 主 | 模块/入口/契约 |
| `Pi_Agent_base/UI/Aegis-pocket/web/aegis/*` | UI | 应用壳：`index.html`、`app.js`、`api.js`、`stream.js`、`timeline.js`、`markdown.js`、`aegis.css` |
| `Pi_Agent_base/UI/Aegis-pocket/AGENTS.md`、`docs/map.md` | UI | 说明 `web/aegis/` 与 Pocket 服务端的边界 |

未改：Pi 核心（HEAD 未动）、Outcome/Episode/Experience/权限/预算门、EventLog schema、只读 observation 服务、Pocket 的 `src/server/**` 与既有 web 模块。

## W.4 契约更新与兼容

- 新增 `docs/WEBUI_CONSOLE.md`（Web 协议/状态/错误码/幂等/安全/限制），从 `docs/README.md` 与模块 `AGENTS.md` 链接；其余既有契约（`STRUCTURED_RAM_AND_WORK_CONTROL.md`、Phase 3 任务书）未改变语义。
- `run.json` 仅**新增** `provider`/`model`/`work_cycle` 字段；`--resume` 在未显式给 flags 时按 run.json 恢复，避免回落到另一个 provider/auth。
- 控制 receipt 是新增的 inert `runtime.note` kind；旧日志无该 kind 时行为不变。
- `--control`/`--faux-script` 是入口新增开关；普通交互与 `--cli` 不受影响。

## W.5 真实调用链证据（HTTP → Host → SDK/Observer）

`aegis-webui` 用真实 `run-experiment.sh`、真实 Host 子进程、真实 Pi SDK + faux provider：
- 新建只建布局（0 事件）；attach 后 1 个 Host、1 个真实 Session；
- 第二个 writer（CLI）exit=4，EventLog 字节/行数/Session 数完全不变；
- 消息 → committed `episode.started`/`request.projected`/assistant 文本/`action.completed`（含 committed excerpt）/scoped Intent；
- 同 id 重试 `duplicate`（0 新行）；同 id 异文本 409；并发两条均 `handled`；
- pause→409 `dispatch_paused`；SSE 断开后 Host 仍 ready 且继续受理；
- Host stop→重新 attach 后同 request_id 由 committed receipt 判定 duplicate，不重跑；
- 面板与同一 prefix 的本地投影逐项相等；provider-bound RAM 仅审计元数据；损坏日志 `integrity.ok=false` 且前缀仍显示；
- 文件 `..`/绝对路径/symlink 逃逸拒绝；跨站 POST、错误 Host 头拒绝；GET 不能写；`/api/pocket/*` 与 observation 写路由均不存在。

## W.6 浏览器验收（真实 Firefox，BiDi）

| 项 | 结果 |
| --- | --- |
| 桌面 1440×900 | 列表/新建/打开/发消息/五类面板/文件查看/暂停/刷新重连 全部操作；无未捕获错误；无横向溢出 |
| 移动 390×844 | 底部导航、列表抽屉、详情抽屉、输入区固定可见；无横向溢出；触控目标约 40px+ |
| 控制台错误 | `window.__aegisErrors` 为空（多轮操作后） |
| 截图 | `Pi_Agent_base/runtime/dev/p3-webui-1023-091425/desktop-1440x900.png`、`mobile-390x844.png`（ignored，不入库） |

## W.6b 界面语言（中英切换）

- 默认中文；右上角 `EN`/`中文` 与 `设置 → Language` 双向切换，即时生效，选择保存在本浏览器（`aegis.lang`）。
- 文案集中在 `web/aegis/i18n.js`（zh/en 同键）；协议值不翻译，只本地化标签并保留原值；后端错误按 `code` 映射中文，未知 code 回退原文。
- 测试：`aegis-webui` 的 WEB-08 断言两套词典键集合一致、UI 用到的 288 个键都存在、默认中文、切换生效；浏览器实测切换/刷新保持/窄屏无溢出。
- 证据：`Pi_Agent_base/runtime/dev/p4-web-i18n-*/`（`desktop-zh-1280.png`、`desktop-en-1280.png`、`mobile-narrow-{zh,en}.png`）。

## W.6c 新建任务选择、附件上传与视觉细节

- 新建任务：模型下拉（来自 Pi 配置的 models.json/settings.json，按 provider 分组，含上下文大小）与工具勾选（只读/副作用分组，Aegis 控制工具常开）；选择写入 `run.json` 并在 `--resume` 沿用；命令行等价开关 `--tools`。
- 附件：输入框 `+` 上传到该实验 workspace 根目录；16 MiB、纯文件名、不覆盖（`wx`）、点文件与路径拒绝；文件面板即时刷新；附件不进 EventLog、不代表授权。
- 视觉：时间戳改为卡片边角的小号镂空胶囊；修掉实验列表在大量运行时被 flex 压缩导致的「label 消失 / 时间压在边框」；面板按蓝/青/品红/绿/黄/蓝灰做低饱和分区着色。
- 证据：`aegis-webui` 93 checks（含 WEB-10a..e）；浏览器 1280 CSS px 实测（新建对话框、上传、中文/英文、24+ 实验列表）；截图在 `runtime/dev/p4-web-ui4-*/`。

## W.6d 图板折叠/证据、模型切换、文案与只读说明

- 图板：节点长文本默认折叠（3 行）可展开；「证据 N」就地展开引用 id + 能对应到的 committed 事件摘要（不在已加载范围时明确说明）；「打开详情」滚动到节点详情（此前详情在长列表末尾，看起来像按钮没反应）。
- 模型：顶栏模型胶囊可点击，列表来自该运行 `ModelRuntime` 里有凭据的模型（`GET …/models`），选择经 `POST …/model` 切到当前 Session；这是会话配置，不写 EventLog、不改授权/预算；未知模型由 Host 拒绝。
- 文案：新建任务里的「Pi 配置」改为「Aegis 配置（~/.Aegis/agent）」，默认项同步。
- 设置：安全边界标注为**只读说明**并解释由 Host 契约固定（不是可编辑项）。
- 修复深链切换：`#/e/<label>` 的 hash 变化（浏览器前进/后退、直接改地址）现在会切换运行，而不只在首屏生效。
- 测试：`aegis-webui` 99 checks（新增 WEB-11a/b）；浏览器 1280 CSS px 实测图板折叠/证据/详情、模型弹出与切换、文案；截图在 `runtime/dev/p4-web-ui5-*/`。

## W.7 回归与静态检查

见矩阵 W.3：`aegis-webui` 66 checks；12 脚本（Web + Phase 3 六 + Phase 2 五补测）0 failed；22 项受影响回归 0 failed；required 68 0 failed；module-layout 342/1047；Aegis 类型 66/193/190（新文件无诊断）；Biome 0 error；UI `check` 0、`lint` 0、`test` 379/384（5 项基线失败，见矩阵 W.1）。

## W.8 已知限制 / 未运行

- 未运行真实模型/网络/目标/真实 CTF 实验；不使用用户凭据；浏览器验收使用离线 faux（含 `--faux-script`）。
- 未做多用户/公网/LAN/推送；未实现 Pocket 的多人、PiP、定时任务、watches、扩展商店、fork/retry/worktree/内置浏览器入口（不存在，非隐藏）。
- 后端改动需要重启 Web 服务（Node 模块缓存）；无构建步骤、无 service worker。
- UI 基线 5 项失败保持原样（`launcher-ui` focus 超时 ×4、`subagents` 满负荷超时 ×1），未修改这些测试或放宽断言。
- Session 轮换上限/attempt 的进程内作用域沿用第三阶段结论，不主张跨进程保证；普通入口仍无独立 durable 预算账本。
