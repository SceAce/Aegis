# Work-cycle 第三阶段：常驻 Host 控制台与短 Session 闭环

状态：**实现完成并通过限定内部复验（`internally_verified / awaiting_external_review`）；外部独立验收未发生。**
启动顺序已按独立复核修复：ownership 必须先于 SDK runtime/Session 创建（TEST-OWN-01..04，见
[矩阵 §G.5](WORK_CYCLE_TEST_MATRIX.md#g5-修复启动所有权顺序test-own-0104) 与
[报告 "第三阶段修复"](WORK_CYCLE_IMPLEMENTATION_REPORT.md#第三阶段修复启动所有权顺序ownership-before-session)）。
交付证据、命令、真实退出码与未覆盖项见本文 §11；测试矩阵与报告在
[WORK_CYCLE_TEST_MATRIX.md](WORK_CYCLE_TEST_MATRIX.md) / [WORK_CYCLE_IMPLEMENTATION_REPORT.md](WORK_CYCLE_IMPLEMENTATION_REPORT.md)
的第三阶段章节追加，历史轮次未被覆盖。

目标：人类启动一次 Aegis 控制台，提交一个 CTF Web Task；控制台创建/恢复唯一 Episode，并持有 Session 生命周期。Pi Session 是可替换的短工作窗口。Session settle 时，Host 检查 committed 状态和安全边界；当 work-cycle hold 触发后，可有界轮换一次让新 Session 接手复核/Intent；新 Session 继承原 hold，不能以轮换绕过门控。有效 review + 被接受的新 scoped Intent 才解除该 trigger 的 effect hold，随后控制台继续同一 Task，直到独立 Outcome、明确暂停/恢复责任、预算结束或需人工操作。

本阶段复用现有 Observer、EventLog、Episode、Board、RAM、Proposal/Evidence gates、SessionSupervisor 和 `run-experiment.sh` 隔离布局。新增的是普通 experiment 入口的 Host lifecycle/control loop，不建立第二套事实存储、Task/Episode 状态机、预算账本或 Session manager。

## 1. 先决基线与委派边界

遵守根 `AGENTS.md`、[固定规则](DEVELOPMENT_RULES.md)、[开发规范](AGENT_DEVELOPMENT_STANDARD.md)、[测试规范](AGENT_TESTING_STANDARD.md)、[Git 规范](GIT_STANDARD.md) 和所有目标目录 `AGENTS.md`。行为依据：[Campaign/Host 架构](CAMPAIGN_ARCHITECTURE.md)、[C2 Session 轮换](C2_SESSION_ROTATION_TASK.md)、[RAM/工作控制契约](STRUCTURED_RAM_AND_WORK_CONTROL.md)、[第二阶段收尾实现及复验](WORK_CYCLE_PHASE2_REMEDIATION_TASK.md)、[当前测试矩阵/报告](WORK_CYCLE_TEST_MATRIX.md)。先读取真实 Pi SDK extensions/session 文档与 SDK runtime 例子，按当前嵌套 Pi HEAD 核对签名；不得修改或升级 Pi。

本次开始工作树可能为 `feat/work-cycle-session-handoff` / HEAD=`d84b69206157c20710e0c4c5f3d08c6e79c64eb4` 的未提交工作；实际以开始时 `git status`、各文件 owner 和 diff 为准。保留全部既有实现与测试，不得 reset/clean/stash/覆盖。`Pi_Agent_base/UI/` 是独立用户内容，本任务禁止读取、修改、暂存、删除或重置。本委派仅允许本地代码、测试、文档与真实 Pi SDK + faux；不调用真实模型/网络/目标/凭据，不暂存/提交/push，除非用户另行授权。

Phase 2 R1/R2/K1/G1 补测当前为 5/5 pass，受影响回归 17/17、required 68/68 已有同一最终树证据；本阶段不得改写这些历史轮次。Phase 3 新增测试必须有新的唯一 `runtime/dev/` ignored log 目录。真实效果对照、生产阈值校准和真实 CTF 授权实验均不在本阶段。

### Phase 3 scope

| 包含 | 不包含 |
| --- | --- |
| 普通 `run-experiment.sh` 的常驻 Console Host 生命周期：启动一次，管理一个 Task/Episode 的多个短 Session | 真实 solve-rate/多题群跑；Campaign 多任务调度替代；新 UI/独立事实库/新 Session manager |
| 完成用户 prompt 后，host 接管 settle→安全handoff→真实SDK newSession→重绑定→继续原 Task | Observer `agent_end` 直接创建 Session；把 Session 当新 Episode；随轮换加预算/权限 |
| 有界 review-hold rotation、当前/下一 Session RAM 与工作门状态连续 | 用新 Session 解锁 effect；无状态进展无限旋转 |
| 控制台 process 的 pause/stop/restart recovery 和退出码/状态摘要 | 自动访问/重置远端目标；用户无批准的真实模型实验 |
| 本地 EventLog 与现有 Task contract/预算的单一权威写入/恢复 | 把 C6 Campaign Oracle/Task/Stage 语义强加给普通 experiment |

普通入口的真实 model API 是否能使用，由原来显式配置的 provider/Auth/authorization 决定；本阶段测试必须 faux。控制台支持外部真实运行不意味着本轮测试会触发真实服务。

## 2. 责任和权威边界

| 组件 | 唯一职责 | 明确不得 |
| --- | --- | --- |
| Shell launcher (`run-experiment.sh`) | 建立隔离目录/环境并 exec 常驻 Host Console；保存 label/路径/原授权配置 | 运行额外并行 Pi CLI、猜授权或建立第二个状态 store |
| Host Console (建议 `Pi_Agent_base/session/experiment-console.mjs`；T0 可按现有模块布局选择) | 持有一个 SDK runtime、session lifecycle、settle loop、safe rotation policy、same-Episode continuation、pause/stop/recovery | 判真/写 Fact/Outcome；将 stage/Intent 当授权；修改 evidence/预算 |
| Observer | 当前 Session 的 hook/tools、EventLog 投影/RAM、proposal/read/review/checkpoint、handoff post-bind completion | 拥有 Host lifecycle；独自创建 Session；initial bind 看 staged JSON 就完成 handoff |
| EventLog | 唯一持久事实；记录 Task/Episode/Intent/actions/reviews/handoff/policy/console boundaries | 从 Session transcript 重建授权或业务成功 |
| Board/RuntimeState/Work-cycle | 从已提交 EventLog 重放出的状态/门/计数 | 新持久权威；因为 model 文本/exit code 加 Fact |
| RAM | 每个 provider request 的有限消息投影 | 缓存或替代 transcript/EventLog、授予权限、自己推进单元 |
| SessionSupervisor/Handoff | 检查 pending/unknown/settle/预算；替换真实 SDK session；绑定 attempt/request/from/to；completion 后恢复 | 创建新 Episode/预算；以文本/文件存在当替换成功 |
| Broker / work permit | 副作用真正执行前读最新 EventLog+授权+预算；held 时阻断 | 只依赖先前 model plan admission / tools list |

**一份状态，两个派生层**：

- **Work state**：Intent/current unit、stall trigger、review/selection、消费、effect hold；来自已有 Episode EventLog/Board。
- **Host state**：console process/session id、rotation attempt、continuation 次数、停止/恢复原因；可用已有 handoff 与极少量 `runtime.note` Host event 派生。不得跟 Work state 分叉，也不得用 mutable `console.json` 授权。
- Console heartbeat/status/checkpoint 若有，只是可重建 convenience cache。删除它们后必须从 committed EventLog 重建出同一权限/hold/预算判断。

## 3. 工作流与状态转移

Console 并不是一个用户每次重新启动就丢弃的“一次性 agent run”。一条 command 进入 resident/attached host process，控制台拥有真实 SDK `AgentSessionRuntime`，等待用户输入并在每个 settle 后驱动 continuation。Interactive TUI 是否复用当前 SDK UI，T0 先核对已有实现；不得创建新 UI。若交互入口当前只有 Pi CLI 可用，Host 用既有 Pi SDK/运行时方式接管该 Session；不能让 CLI 与 Host 同时写同一个 EventLog。

### 3.1 正常启动

1. `run-experiment.sh <new-label> ...` 校验参数/新目录规则、显式目标与 authorization/task contract、预算和工具 allowlist；创建原有 experiment layout。`<new-label>` 必须新建，禁止默认 resume 旧未知 Episode。
2. Host 创建/打开现有 EventLog，验证 chain；重放现有 board/state。新运行用唯一 Task/Episode 绑定用户当前明确提供的目标、授权、budget/limits 与 strategy revision；不得将 prompt 自由文本当 scope/权限。
3. Host 创建初始真实 Pi SDK Session，绑定原 Observer/gates。模型可进行已授权的只读观察/知识检索。
4. 首个 effect-capable call 前必须有已接受、durable 的 scoped Intent 和现有 permit；如果同一 assistant message 并行发送 Intent+effect，tool admission 串行化后 effect 必须重读最新 prefix。未 Intent 时保持必要 bootstrap只读路径可用，不放行效果。
5. Host 将人类输入原文仅发送给该 Session/Task context（依当前 privacy contract，不复制到报告）；EventLog 记录摘要/digest 和运行绑定。

### 3.2 Stall/review 以及有界 Session 交接

- Effect stall trigger 或 projection/audit异常时，当前 EventLog 派生 hold，真实 action gate 阻止后续 effects；取消未执行 buffer/计划，不回滚已完成效果。
- Agent 完成当前可执行 review turn 后，必须到真实 `agent_settled`/Host controlled safe boundary。`agent_end` 不够；queued/auto recovery 仍可能继续时不能切换。
- **Session rotation policy**：
  - 明确的 work-cycle hold 可以成为一次 Host handoff 的理由，即使 review/Intent 尚未完成；这次轮换只是刷新模型上下文/接手未完成步骤，绝不解除 hold。
  - 同一 open trigger 最多触发本配置绑定的有限 handoff 机会（T0 根据现有 candidate `max_auto_rotations/max_continuations` 取合理上限并落入测试；不能允许每个 agent.settled 无状态循环）。每次 rotation identity = 同 Episode + trigger/work boundary + source Session + boundary sequence；完成后同 identity 不得再 rotate。
  - review/no_match/retrieval-disabled 等结果不能作为解锁。新 Session 的第一条 provider-bound request 必须能看到同一 hold/trigger/unit/证据/计数/授权/预算。
  - 新 Session 允许 read-only observation、knowledge、work review、bootstrap/current Intent 和 checkpoint；effect 只有收到和提交有效新 scoped Intent 后才可放行。
  - 新 Session 若只重复提交相同非法 Intent、无新 committed progress/review consumption、同 hold 再次 settle，达到有界机会后 Console 停止自动轮换并呈现 actionable blocked status；不自旋，不自动发 effect，不自动写 Outcome。人类可审视和另行指示；人类新输入仍不直接解除 permit。
- 若无 stall，普通连续工作可在当前 Session 继续，不为了“短 Session”每 prompt都旋转。到可信 context/request/complete boundary 时，由 Host 的同一策略决定是否轮换。
- 真正已接受的 review+Intent 若另因上下文压力旋转，新 Session复用现成 review/selection/consumption，不再重复检索/复核。复核 only 一次消费，旧引用不可续杯。

### 3.3 Session replacement transaction

唯一流程：

```text
Host observes settled
 -> reread committed prefix + verify chain + projection
 -> verify current run config/policy binding
 -> verify no pending/unknown actions, unresolved tool/request charges, audit failure
 -> check Session/request/tool budgets and bounded-rotation identity
 -> stage exact handoff request + short-lived attempt authorization
 -> SessionSupervisor.canRotate/rotate
 -> SDK tears down source Session and creates genuinely new AgentSessionRuntime session
 -> rebind same Observer, tool/permit gates and config to replacement
 -> replacement starts continuation prompt; post-bind observer writes one handoff.completed with request/attempt/from/to/episode/boundary identity
 -> Host verifies unique completion and budget charge; retire exact staged request/attempt
 -> replay log, rebuild Board/RAM/Work-cycle; dispatch next request in SAME Task/Episode
```

- Attempt authorization is tied to process-local live capability plus durable attempt id, exact staged request/episode/source session; must be unique/replay-resistant and cleared in `finally`. A stale staged JSON or previous attempt file cannot grant completion.
- **Never unlink/rename the staged JSON based on request id alone**. Before writing completion and before retiring the file, ensure it still represents the same request/attempt/boundary (e.g. event identity/digest/atomic owner protocol). Late concurrent Host callback must not retire a newer request. If existing architecture serializes calls, assert that invariant/test it.
- Exactly one `handoff.completed` per request/attempt after real bind. `to_session` is actual bound replacement ID; `from_session` must equal attempt source; attempt/boundary identity and Episode match. Zero/multiple/mismatching completion is blocked/corrupt, not reused as verified rotation.
- Initial console Session binding does not consume a pending rejected rotation. On restart it is a startup Session, not an authorized replacement. Host must recover/re-authorize pending handoff through Supervisor budget/safety checks before continuation dispatch. If zero budget, no completion/no next effect.
- A crash after SDK Session replacement but before completion may leave an active new runtime with pending attempt. Recovery must reconcile actual runtime identity and exact request; do not create another Session or re-send the previous effect blindly.

### 3.4 Console operation and process restart

Use one process/one active owner for a single experiment EventLog. Reuse existing Host ownership/lease if available; no concurrent console may mutate the same task. Console start is idempotent/read-only when already owned; second writer is rejected. Signals/pause are explicit controlled boundaries; shutdown waits for actual settle or records durable unknown responsibility.

On process restart:

- Verify EventLog chain/last committed event, frozen Task/authorization/strategy binding, budget and attempt state.
- If there is an uncompleted handoff/boundary, run existing Supervisor recovery first. No normal Task dispatch until recovery authorizes it or console returns a blocked/refused state.
- Restore current Episode and same Task. Do not create a fresh Episode simply because process/Session changed.
- If in-flight action/result is unknown, pause for existing reconcile workflow. Never re-dispatch an effect whose real result is unknown.
- If open stall hold, preserve trigger and let a bounded replacement Session handle the same review; session count does not count as review consumption or progress.
- If task is `waiting_external`, paused/cancelled/terminal, do not auto-resume. Return control/status; explicit existing command applies.

## 4. Intent bootstrap: remove the observed deadlock

`rceme-001` proved that on a new Task the normal first effects can occur without scoped Intent, then stall creates review with `work_unit_event_id=null`; later Intent is rejected with `complete_work_review_first`, so it can never consume the review. This must be directly solved; merely spawning a new Session will reproduce it.

Adopt these rules:

1. **Before first work unit**: Task/Episode has `work_unit_state=unscoped` as a derived Host status (do not add a new EventLog authority unless existing contract requires it). While unscoped, allow existing authorized read/observe/knowledge/catalog tools and `aegis_propose kind=intent` with a new nonempty scope. Block effect-capable operations in both Observer admission and final Broker permit until that Intent is committed and passes existing validation. This applies from the very first provider request, not only after a stall.
2. **Proposal schema validation before stall**: require non-empty bounded scope for every work-cycle `kind=intent`, valid same Task/Episode refs, current authorizing Host/Task boundary. Reject wrong/foreign/future refs. A plain claim/checkpoint is not an Intent.
3. **A stall whose earliest evidence predates the first Intent**: represent it as an explicit bootstrap/no-unit trigger variant derived from committed evidence; the review must be valid without fabricating `work_unit_event_id`. It still needs a durable `knowledge.selected(mode=work_review)` and `work.review` bound to that exact trigger/Episode/evidence.
4. **Consume bootstrap review**: after the review, the first accepted nonempty scoped Intent that cites this exact review or selection becomes the first work unit and consumes the bootstrap review once. New scope does not have to differ from a nonexistent prior scope, but cannot be empty. Duplicate/invalid/rejected Intent does not consume it. Only after proposal is committed does the side-effect hold clear.
5. **Subsequent stall**: review binds to the current effective Intent event+scope; only next accepted new-scope Intent may consume it once. Existing R1 historical replacement semantics remain.
6. **Review trigger strictly event-derived**: no model-supplied boolean, intent text or route labels can fabricate or clear trigger. Checklist/status in RAM explains gate; board remains source.

No new global setup state machine is required. The unscoped-start status can be a pure derived projection (`active_episode && no accepted current scoped Intent`), and `aegis_propose` is already the explicit interface.

## 5. C6 versus Experiment Console: consolidate control without conflating contracts

- **Task supervisor / launcher**: `run-experiment.sh` parses user-facing options and creates/resumes the isolated run directory. It must hand ownership once to a long-lived Aegis Console Host, not launch a model CLI that exits without a Host available to create replacement sessions.
- **Session runtime**: use real Pi SDK `AgentSessionRuntime` and existing `SessionSupervisor`/handoff path. The control loop remains alive while Pi Sessions are created/replaced; user can see current session/run status and interact through the existing supported Pi/console UX. Do not silently change scripts to a different provider/auth store.
- **Task/Memory authority**: ordinary CTF task uses existing EventLog `Task/Episode` and authorization/work contract. Do not fabricate C6 Campaign/Manifest/Stage semantics merely to reuse `campaign.scheduler`. Reuse only generic Supervisor, budget/request checks, Broker/Observer tools and reducer. If a shared Host abstraction already exists, extend it; do not fork C6's Campaign authority or duplicate equivalent process supervision.
- **One Session decision owner**: the Console Host decides continue/current session vs safe rotation vs pause/stop. Observer only emits request projection, settle signal and tools; it never calls `newSession` from `agent_end` or `agent_settled`.
- **No two writers**: initial and replacement sessions bind the same current observer runtime/log owner under the Host protocol. Ensure old session shutdown has drained before rebinding/new provider request. Prevent multiple experiment hosts/processes from writing the same EventLog concurrently via the existing ownership mechanism.
- **Human start is not session start**: launcher starts the Host console. The first Pi Session is a Host-managed child lifetime. A label is not permission; every real action checks Task contract, current target grant, path and remaining budget at the final boundary.

## 6. Performance and idempotency

The Host may reuse a verified EventLog checkpoint + committed tail for state projection to avoid replaying an arbitrarily large history after every settle. Cache is performance-only and must never carry authority.

- Reuse only if checkpoint is a verified prefix of current hash chain, bound to exact event offset/hash, Task/Episode, Manifest/authorization/policy digest, schema/version and projection version.
- Apply tail events using the same reducers as a full replay. Compare full replay and cached+tail state/digest across tests for R1 consumption, hold/trigger, budget, pending actions, history/effective Intent, and handoff completion.
- Missing/invalid/stale/foreign checkpoint, policy conflict, chain mismatch, unsupported projection version or omitted required consumer must fall back to complete replay or fail closed. Never silently use “latest.json” solely because it exists.
- Complete projection and RAM once for an immutable prefix per Host boundary, then share the result read-only with consumers; re-read/revalidate at the actual effect/handoff boundary after any durable append/await.
- No redundant full replay solely on a Session transition when there are no intervening events and the same verified prefix is current; session binding still verifies the persisted state revision/digest and live request identity.
- Performance test is bounded: same semantic projection from full replay and checkpoint+tail with a synthetic large prefix; measure event rows processed/runtime as diagnostic. Do not set a brittle microsecond gate or claim O(1) if tail is replayed.

## 7. Data and state transitions (derived from current canonical Events)

Do not introduce a competing persisted `console_state`. The console view may expose:

```text
console_status: starting | running | settling | handoff_pending | paused | blocked | stopped
work_unit: unscoped | active | awaiting_review | awaiting_intent | complete_candidate
session: actual current id/file/generation (host-owned, separately auditable)
episode_id / task_id
pending_actions / unknown_responsibilities
handoff_request/attempt/boundary identity
policy digest + budget snapshot
last_committed_cursor (offset + hash)
```

These are derived/status fields. Existing events remain authority. Permitted transitions:

| Current state/evidence | Host action | Next state |
| --- | --- | --- |
| fresh Episode; no effective scoped Intent | start Session, inject goal/authorization summary; allow read/knowledge/Intent only | running, `unscoped` |
| accepted scoped Intent committed | allow broker effects only after latest-permit validation | running, `active` |
| stall trigger, review not committed | hold effects; allow read/review | `awaiting_review` |
| usable review + no consuming Intent | retain hold; prompt/create bounded recovery Session only under Console rotation policy | `awaiting_intent` |
| first valid scoped Intent consumed review | commit before release; start bounded next work unit | `active` |
| complete checkpoint bound to current Intent | settle; if budget/safety and identity not consumed, one replacement then continue | `complete_candidate` then `running` same Episode/new unit |
| pending/unknown effect, unhealthy EventLog, charge unresolved | no rotate/no effect; reconcile/operator state | `blocked` |
| context threshold actual/known | settled+safe handoff; if usage unknown, do not infer | `handoff_pending` then replacement `running` |
| same hold settles again without committed review/Intent progress | no repeated rotation after allowance; stop loop and expose blocker | `blocked`/`paused` |
| waiting_external/paused/cancelled/terminal | obey existing controller; no automatic Task continuation | corresponding existing state |

A review hold can be carried by a safe replacement but not cleared by it. Every Session rotation preserves Task/Episode, authorization, budget, hold/trigger, both counters, review-consumption identities and unknowns.

## 8. Implementation task sequence (Host console phase)

| ID | Work | Likely modules | Required output |
| --- | --- | --- | --- |
| C0 | Baseline/entry lifecycle map; read `run-experiment.sh`, `run-aegis.sh`, current Observer CLI switches, C6 SDK Host and ownership/lock APIs; decide main Host entry and UX lifecycle | `run-experiment.sh`, `campaign/c6-entry.mjs`, `session/*` | no-code call graph, owner state, test matrix, stop risks |
| C1 | Extract/reuse safe Host lifecycle boundary and model Session adapter; preserve per-experiment runtime isolation and current auth/model selection | `session/`, entry bootstrap | real SDK faux creates initial Session and replacement; same observer/ledger binds |
| C2 | Single-owner resident console loop; startup/prompt dispatch/settle/status; non-terminal continuation of SAME Episode | existing launcher + Host entry | no parallel CLI/Host EventLog writers; one Task can run multiple Sessions |
| C3 | Intent bootstrap admission at observer AND Broker final permit; recovery for legacy unscoped stalled Episode | `memory/work-cycle.mjs`, `extensions/aegis-observer.ts`, `execution/broker-worker.mjs` | no Intent→no effect; bootstrap review→citing first Intent→effect allowed |
| C4 | Hold settlement and one bounded Session rotation per policy/identity; carry unconsumed review to new Session; stop on no progress/limit | `session/session-supervisor.mjs`, new/reused console coordinator | current SDK settled event→actual `newSession`→new first RAM/gate |
| C5 | Process lifecycle: explicit pause/stop/restart; blocked states; pending attempt recovery before dispatch; chain/lock/lease behavior | existing `shared/events`, `campaign/host` ownership APIs, `session/*` | actual child-process/fault-boundary restart integration, no replay/charge duplication |
| C6 | checkpoint/tail performance reuse under §6; deterministic fallback and digest parity | existing checkpoint subsystem/reducer | full vs prefix+tail equality incl all work-cycle/recovery fields |
| C7 | all existing five phase2 remediation scripts + new console product/recovery matrix, 17 relevant regression + E1 required once | `tests/` | fresh evidence, exact commands/results, final report |

Do not stop after C0 planning or propose another round of architecture questions for already decided behavior. If existing Host/session API cannot support a necessary step without changing Pi core/authorization/Outcome semantics, isolate that specific blocker and continue independent modules; report exact evidence before asking owner.

## 9. Frozen acceptance matrix

| ID | Expected | Evidence level |
| --- | --- | --- |
| HC-01 | `run-experiment` starts one resident Console Host process and one initial genuine SDK Session; no second Pi CLI writer for same EventLog | entry + SDK/faux |
| HC-02 | new Task allows only startup/read/knowledge/scoped Intent; parallel Intent+effect same assistant batch cannot race through before commit; no accepted Intent means no `action.requested` effect | Observer + actual C6 broker + SDK/faux |
| HC-03 | after valid first Intent, effect still needs frozen Task/target authorization and budget at final broker boundary | product positive + unauthorized negative |
| HC-04 | current rceme deadlock pattern: stall with bootstrap/no current unit→review binds bootstrap trigger/evidence→same-episode scoped Intent cites that review→single consumption→effect allowed; empty/foreign/rejected/old refs cannot unlock | reproduce reduced SDK fixture |
| HC-05 | two review calls, same trigger; first failed unavailable then recovered ready. Failed review cannot consume; successful review once; repeated valid review content does not repeat retrieval/consumption | C6/Observer product + replay |
| HC-06 | review-triggered safe settle causes at most bounded automatic replacement; completion binds live attempt/request/from/to; new Session object/file/id differs, same Task/Episode; a carried unresolved hold remains held | real Host/SDK/faux |
| HC-07 | first replacement provider request has same hold/trigger, review/selection refs, both counters, authorization/budget and pending status in RAM; no old assistant transcript; no knowledge retrieval duplicate if prior selection remains valid | provider-request capture |
| HC-08 | read/knowledge/review and bootstrap Intent remain usable under hold; `aegis_read` respects grants/charge; bash/write/effect/escape remain blocked; read does not consume review or clear hold | SDK/faux + tool results + EventLog |
| HC-09 | legal review Intent commits exactly once, then same Task may probe; second stall produces distinct new trigger; old review cannot be reused; only trusted Fact/Oracle success resets cumulative no-progress | pure + same-Task SDK |
| HC-10 | if replacement settles same hold without new valid committed progress, bounded rotation budget stops; no spin, effect or fake Outcome; returns actionable console status/reason | product bounded-loop test |
| HC-11 | request-threshold + hold/complete same safe boundary merges into one rotation; unit completion/context identity not reused; no old high-water chain | regression/focused combo |
| HC-12 | action requested with unknown result, unpaired request, unfinished tool charge, corrupt/unwritable EventLog, lost owner/lease => no replacement/no continuation effects; recovery preserves unknown responsibility | Host failure fixtures + process restart |
| HC-13 | interrupted handoff: start/refusal/corrected budget/restart barriers; completion only after authorized replacement; exact attempt and budget charge once; no already-executed action replay | child-process + real SDK/faux |
| HC-14 | full replay equals verified checkpoint+tail for all state/refs/gates; stale/tampered/foreign projection falls back/rejects and changes no authority | projection property + console restart |
| HC-15 | pause/cancel/waiting_external/terminal don't auto-resume exploration or rotate; user prompt doesn't itself grant permission | Host control tests |
| HC-16 | no real provider/network in faux suite; env/temp dirs isolated/restored; no UI/credential access | test hygiene and `git status` |

Test oracle derives from committed event truth, real target fixture values and stated contract, not from the function under test. Check event prefix ordering, actual SDK Session objects/provider requests, actual file value, budget ledger and chain verification; helper-only assertions do not satisfy HC-01/04/06/08/13.

## 10. Commands and final delivery

Baseline and focused tests from repo root. New tests are added to the explicit suite list, not wildcard-only:

```sh
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs Pi_Agent_base/runtime/dev/<unique-console-dir> <console-sdk-test> <bootstrap-intent-test> <hold-rotation-test> <restart-recovery-test> <checkpoint-tail-test>
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs Pi_Agent_base/runtime/dev/<unique-regression-dir> aegis-work-cycle-knowledge-recovery-sdk aegis-work-cycle-context-carry-sdk aegis-work-cycle-replace-consumed-sdk aegis-work-cycle-zero-budget-recovery aegis-work-cycle-reason-merge <affected-C6-C2-Observer-RAM-tests>
bash Pi_Agent_base/tests/helpers/run-required.sh Pi_Agent_base/runtime/dev/<unique-required-dir> 6
```

Run Biome on changed code/tests with `Pi_Agent_base/aegis-biome.json`; type configs use toolchain actually installed under nested Pi and compare line/file diagnostics carefully; module layout if import graph changes. Do not run real target/model. Avoid printing historical payload files containing flag/secret data; summarize artifacts by allowlisted metadata only.

Final delivery updates this task's status and existing matrix/report. Report exact branch/HEAD/status, files, launcher UX, startup/stop/resume semantics, frozen policy path/identity, full event/Session lifecycle, same-task bootstrap proof, carry proof, restart proof, checkpoint parity, all commands/exit/logs and remaining blockers. Preserve `internally_verified / awaiting_external_review`; only external reviewer can accept. No real solve-rate claim.

---

# 11. 实现交付（内部验证轮）

状态：`internally_verified / awaiting_external_review`。下列结论只覆盖实际运行过的脚本与断言；没有真实模型/网络/目标调用，不宣称解题率或知识收益。

## 11.1 实际入口与调用链

```text
./run-experiment.sh <label> [--workspace D] [--resume] [--console|--cli]
        │  （解析/校验 label、workspace、agent dir、EventLog、knowledge、policy）
        │  exports AEGIS_EVENT_LOG / AEGIS_HANDOFF_FILE / AEGIS_PI_AGENT_DIR /
        │          AEGIS_PI_SESSION_DIR / AEGIS_WORK_START_GATE=on /
        │          AEGIS_CONSOLE_MAX_AUTO_ROTATIONS / AEGIS_CONSOLE_MAX_CONTINUATIONS
        └─ exec node --import <source-resolver> Pi_Agent_base/session/experiment-console-entry.mjs
                 │  真实 SDK: createAgentSessionRuntime(createAgentSessionServices/FromServices)
                 │            资源 allowlist = 仅 Aegis Observer; 复用配置的 model/auth
                 └─ createExperimentConsole()   （session/experiment-console.mjs）
                        ├─ acquireCampaignOwnership(runtime/console, label)  单写租约
                        ├─ new EventLog(eventLogPath).open() + verifyChain + bindHostEventLog
                        ├─ createSessionSupervisor({eventLogPath, handoffPath, runtime, sessionBudget})
                        ├─ recover()：pending/unknown、staged handoff → Supervisor 恢复
                        └─ dispatch(text) → session.prompt → waitForIdle
                              └─ decideAfterSettle()
                                    ├─ projectWithCheckpoint（verified prefix）
                                    ├─ evaluateConsoleRotation（commit 派生边界）
                                    ├─ stageHostHandoff（session/handoff-stage.mjs）
                                    ├─ supervisor.rotate → applyStagedHandoff → runtime.newSession
                                    │     └─ 新 Session before_agent_start → handoff.completed
                                    └─ 有界循环（max_auto_rotations / max_continuations）
```

- 退出路径：`/stop`、`/quit`、Ctrl-D、`--non-interactive` 结束 → `shutdown()` 释放 SDK runtime、EventLog 句柄与租约；`/pause` 只停止派发、保留 Session。
- 只有 Host 打开 EventLog；Observer 通过 `bindHostEventLog` 借用同一 writer。第二个 console（同进程或跨进程）被租约/`bindHostEventLog` 拒绝。
- 普通入口的 Pi 工具集 = 默认 coding tools（read/bash/edit/write/ls/grep/find/glob）+ Observer 工具。**与 `run-aegis.sh` 的差异**：console 只加载 Aegis Observer，不加载用户扩展/skills/prompts/themes/context files，也不启动 MCP（`--mcp*` 在该入口无效）；模型/auth 仍来自 `AEGIS_PI_AGENT_DIR`。交互是行式 readline 控制台，**不是** Pi TUI。

## 11.2 冻结策略与身份

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 首个 Intent 启动门 | `AEGIS_WORK_START_GATE=on`（launcher 绑定）/ `WORK_START_GATE_ENV` | Observer admission + Campaign/ Broker 最终 permit |
| work-cycle 策略 | `AEGIS_WORK_CYCLE_{REPEAT_LIMIT,ACTION_WINDOW,MIN_DISTINCT_ROUTES,CONTEXT_PERCENT}` | 沿用第二阶段；Console 启动时冻结进 Observer env |
| 自动轮换上限 | `AEGIS_CONSOLE_MAX_AUTO_ROTATIONS`（0–8，默认 3） | 达上限 → `blocked`，不重启、不伪结清 |
| Continuation 上限 | `AEGIS_CONSOLE_MAX_CONTINUATIONS`（1–64，默认 12） | Session 世代上限 |
| Session 预算 | `createExperimentConsole({sessionBudget})`（默认 null=只做安全检查） | 由 Host 冻结；Supervisor 按 committed `handoff.completed` 计费 |

## 11.3 状态/恢复/锁

- **一份状态、两个派生层**：Work state 全部来自 committed EventLog（Board/state/work-cycle）；Host state（phase/attempts/continuations）是进程内派生量，重启后由 committed 事件重建。没有 `console.json` 授权文件。
- phase：`running | settling | handoff_pending | paused | blocked | stopped`。
- 轮换 identity：`review-hold:<trigger_id>:<source_session>`（复核 hold）、`unit-complete:<intent_event>`、`context:<source>:<used>:<limit>`。completed identity 来自 committed `handoff.completed.work_cycle_identity`；attempted identity 只在进程内，失败/拒绝的 attempt **不计**为已轮换，但同 identity 不重试。
- 锁：`campaign/ownership.mjs` 的单写租约（目录 `mkdir` 原子创建 + PID 存活判定 + 只回收死进程），ownerId 为 `<pid>:<uuid>`（同进程两个 console 也不共享）。EventLog 自身另有 `<log>.lock` 串行化每次 append。
- 恢复顺序：ownership → chain 校验 → pending/unknown 副作用 → staged handoff（无 completion 时走 `recoverInterrupted`，仍受预算/安全门）。恢复失败 → `blocked`，不派发下一单元 effect。
- 未知副作用/未配对 request/链损坏/租约丢失 → 不轮换、不继续、不重发；保持责任并给出 `block_reason`。

## 11.4 bootstrap Intent 规则（修 `rceme-001`）

| 规则 | 实现 |
| --- | --- |
| 启动门 | `unscoped`（Episode 无 accepted scoped Intent）时只允许只读观察/知识/工具目录/`aegis_propose kind=intent`（scope 非空）；effect-capable 调用被 admission 拒绝并在最终 Broker permit 再次拒绝 |
| Intent schema | `kind=intent` 必须有非空 `scope`（启动门启用时在 tool admission 与 `aegis_propose` 内双重拒绝） |
| bootstrap review | 触发证据早于首个 Intent 时，`aegis_work_review` 写 `bootstrap:true` 且 `work_unit_event_id:null`；投影只在“该 review 之前没有任何 accepted scoped Intent”时承认它 |
| 一次性消费 | 第一个引用该 review/selection 的非空 scope Intent 消费它一次；空/foreign/rejected/旧引用不能解锁 |
| 历史不可移动 | 既有 R1 语义不变：consumption 固定在当时的 committed prefix |

## 11.5 投影 checkpoint

- 文件：`$AEGIS_PROJECTION_DIR/console-projection.json`（可删除派生缓存）。
- 绑定：`version` + `reducer_version` + `task_id` + `episode_id` + `policy_digest` + `config_digest` + `event_offset` + `last_event_id/digest` + `prefix_digest`(逐行 event_digest) + `projection_digest`。
- 命中条件：以上全部匹配且没有 committed tail → 返回缓存投影（0 行 reducer）。有 tail → 用**同一组 reducer** 重放前缀+尾，并刷新缓存；报告 `cache_reason=committed_tail_present:<n>`。
- 失败即回退：`checkpoint_version_unknown` / `reducer_version_unknown` / `foreign_task` / `policy_digest_mismatch` / `config_digest_mismatch` / `offset_out_of_range` / `prefix_id_mismatch` / `prefix_digest_mismatch` / `prefix_rows_mismatch` / `projection_missing` / `projection_digest_mismatch` / 文件缺失或不可解析 → full replay，结论不变。
- 权限边界：缓存只影响 Host 的派生视图；Observer/Broker 的门直接从 EventLog 读取，且每次轮换都经 `evaluateHandoff`/Supervisor 重新读 committed 流，因此缓存不能授予、释放或结清任何东西。
- 诚实限制：tail 非空时仍重放 reducer（不声称 O(1)），只省掉“无新事件”的重复投影与文件重读。

## 11.6 冻结矩阵执行结果（最终工作树）

| ID | 结果 | 主要证据 |
| --- | --- | --- |
| HC-01 | pass | `aegis-work-cycle-console-launcher`：`run-experiment.sh` 子进程输出 `Aegis Experiment Console`，EventLog 1 个 `episode.started`、1 个 `session.started`（真实 SDK session id），无 Pi CLI banner；`--resume` 同 EventLog、同 Episode、新 Session |
| HC-02 | pass | `aegis-work-cycle-console-sdk`：首个 provider 请求同一 batch 内 read 成功、write 被 `scoped_intent_required_before_effect` 拒绝、无 scope 的 intent 被拒、带 scope 的 Intent 提交后才允许 write；`action.requested(write)` 索引 > Intent 索引 |
| HC-03 | pass（组合） | 正向：Intent 后 write 真实落盘；负向授权/路径/契约仍由既有 `aegis-c3-external-boundaries`、`aegis-workflow-live-script-d`、`aegis-observer-verify-first-pi` 覆盖（required 内 0 failed）。本阶段未新增独立 target-grant 负例脚本 |
| HC-04 | pass | `aegis-work-cycle-bootstrap-intent` 纯投影 + 真实 SDK：legacy（gate off）先 effect 后 stall → 1 条 `bootstrap:true` review（无伪造 unit）→ 首个 scoped Intent 引用它 → 消费 1 次 → effect 执行；空/无关/伪造 bootstrap 不解锁 |
| HC-05 | pass | 沿用并复跑 `aegis-work-cycle-knowledge-recovery-sdk`（unavailable→同 trigger 重试 ready；失败 review 不消费）与 `aegis-work-cycle-sdk`（重复 review `reused:true`、单条 selection） |
| HC-06 | pass | `aegis-work-cycle-console-sdk`：hold 触发的 1 次 replacement；不同 SDK 对象/id/file；同 Episode；completion 绑定 `from_session`/`to_session`/attempt；新 Session 首请求仍为 `review_required` |
| HC-07 | pass | 同上：replacement 首个 provider 请求的 RAM `task.work_cycle` 携带同一 status/trigger/双计数；消息中无旧 assistant transcript |
| HC-08 | pass | 同上：hold 下 read 成功、write 被拒、review 可用；review 后 hold 才由 Intent 消费（consumptions 恰 1） |
| HC-09 | pass | `aegis-work-cycle-bootstrap-intent`（第二次 stall 新 trigger、旧 review 不复用）+ `aegis-work-cycle-replace-consumed-sdk`/`-phase2`（R1 历史消费固定） |
| HC-10 | pass | `aegis-work-cycle-console-sdk` 第二场景：`max_auto_rotations=1` → 1 次 replacement 后 `blocked`，无 spin、无 effect、无伪 Outcome，`block_reason` 明确指出达到上限 |
| HC-11 | pass（组合） | `evaluateConsoleRotation` 把 `recommendWorkHandoff`（unit-complete/context）与 review-hold 合并为**一个** identity；`aegis-work-cycle-reason-merge` 复跑 0 failed（C6 同刻合并证据） |
| HC-12 | pass | `aegis-work-cycle-console-restart`：未配对 action → startup blocked、dispatch 拒绝、无 completion；损坏 EventLog → blocked 且不追加事件；租约丢失/二级 console → 拒绝 |
| HC-13 | pass | 同上：零 session 预算 → 拒绝且 initial bind 不写 completion；owner 修正预算 → Supervisor 真实恢复一次（1 completion、1 creation、attempt 清理、staged 退休）；注入 create 失败 → 无假 completion、staged 保留 |
| HC-14 | pass | `aegis-work-cycle-checkpoint-tail`：full replay == cached/prefix+tail（含 hold/trigger/双计数/consumption/pending/handoff/policy）；stale/foreign/tampered/version-unknown/missing/corrupt → full replay 且结论不变 |
| HC-15 | pass | `aegis-work-cycle-console-restart`：pause 拒绝 dispatch、Closed Episode 不自动恢复/轮换；`aegis-work-cycle-console-sdk` 证明用户 prompt 不解除 effect gate |
| HC-16 | pass | 全部脚本用 faux/temp dirs；无真实模型/网络/目标/凭据；`Pi_Agent_base/UI/` 未读取/修改/暂存（`git status` 仍只有 baseline 的 `?? Pi_Agent_base/UI/`） |

## 11.7 命令、退出码与日志（最终树）

| 命令 | exit | 结果 | 日志 |
| --- | --- | --- | --- |
| `node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs Pi_Agent_base/runtime/dev/p3-console-1022-225550 aegis-work-cycle-console-sdk aegis-work-cycle-bootstrap-intent aegis-work-cycle-console-restart aegis-work-cycle-checkpoint-tail aegis-work-cycle-console-launcher` | 0 | 5 scripts, 0 failed | `runtime/dev/p3-console-1022-225550/` |
| `… p3-remediation-1022-224827 aegis-work-cycle-knowledge-recovery-sdk aegis-work-cycle-context-carry-sdk aegis-work-cycle-replace-consumed-sdk aegis-work-cycle-zero-budget-recovery aegis-work-cycle-reason-merge` | 0 | 5 scripts, 0 failed | `runtime/dev/p3-remediation-1022-224827/` |
| `… p3-regression-1022-224844 aegis-work-cycle aegis-work-cycle-ram aegis-work-cycle-phase2 aegis-work-cycle-sdk aegis-work-cycle-host-rotation aegis-work-cycle-checkpoint-campaign aegis-work-cycle-recovery aegis-work-cycle-policy aegis-c6-product-chain aegis-c6-lifecycle-convergence aegis-c6-sdk-lifecycle aegis-c2-session-rotation aegis-c2-supervisor-boundaries aegis-c2-budget-sdk aegis-observer-failclosed-pi aegis-observer-runtime-handoff aegis-knowledge-campaign aegis-ram-reaudit-sdk aegis-observer-verify-first-pi` | 0 | 19 scripts, 0 failed | `runtime/dev/p3-regression-1022-224844/` |
| `bash Pi_Agent_base/tests/helpers/run-required.sh Pi_Agent_base/runtime/dev/p3-required-1022-225603 6` | 0 | 68 scripts, 0 failed | `runtime/dev/p3-required-1022-225603/` |
| `biome check --config-path=aegis-biome.json <41 changed .mjs/.ts>` | 0 | 0 error；仅 1 条 HEAD 既有 warning（`agentConfigDir` unused） | — |
| `tsc -p tsconfig.aegis-extensions.json` / `-campaign` / `aegis` | 1 / 1 / 1 | `grep -c 'error TS'` = 66 / 193 / 190，与第二阶段实测基线一致；新增文件无诊断 | — |
| `node Pi_Agent_base/tests/aegis-module-layout.mjs` | 0 | 335 source/test files / 1026 refs，无缺失 | — |

## 11.8 剩余 deferred / 未覆盖

- 真实模型/网络/目标与真实 CTF 对照实验：未运行，不声称解题率或知识收益。
- 交互 TUI：本入口是行式控制台；Pi TUI 未接管、不宣称可用。
- 普通入口的 Session 预算默认 `null`（只做安全检查 + continuation 上限）；实际请求/Session 计费仍由 C6 ledger 与既有测试覆盖，普通入口尚无自己的 durable budget 账本（不新增第二账本）。
- 失败/拒绝的 rotation attempt 只记在进程内；重启后 identity 由 committed 事件重建，因此一次被拒绝的 attempt 在同一边界上可能再次尝试（受 committed completion + 上限约束）。这是当前已知限制，未新增权威 attempt 账本。
- HC-03 的 target-grant 负例未专门新增脚本，引用既有 C3/observer 边界用例。
