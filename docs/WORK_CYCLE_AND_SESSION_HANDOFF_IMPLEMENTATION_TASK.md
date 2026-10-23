# Work-cycle、跨 Session 图板连续性与知识复核实现任务

状态：**第一阶段任务依据，已有内部交付，但独立审查为 changes_required。**
当前继续实施 [第二阶段任务书](WORK_CYCLE_PHASE2_IMPLEMENTATION_TASK.md)；其已认可的工作单元绑定、review 一次消费、携带阻断交接与 C6 自动轮换细化优先于本文原先的 advisory/待确认限制。本文保留第一阶段依据，不表示功能已经验收。

目标：让难题可以由同一 Task/Episode 下的多个短 Pi Session 协作完成。图板/EventLog 保存可核对的连续状态；RAM 是每次请求重建的工作视图；停滞时系统促使复盘并检索；工作单元结束或上下文压力达到策略门时，现有 Host/Supervisor 在安全边界轮换 Session。

本文件是本任务契约，不新增一套开发/测试规范。全程继承并遵守 [固定开发规则](DEVELOPMENT_RULES.md)、[开发规范](AGENT_DEVELOPMENT_STANDARD.md)、[测试规范](AGENT_TESTING_STANDARD.md)、[Git 规范](GIT_STANDARD.md)，以及目标目录 `AGENTS.md`。行为/信任语义以 [Campaign 契约基线](CAMPAIGN_CONTRACT_BASELINE.md)、[MEMORY_SCHEMA](MEMORY_SCHEMA.md)、[运行时补充](MEMORY_SCHEMA_NOTES.md)、[RAM/Work-control 接口](STRUCTURED_RAM_AND_WORK_CONTROL.md)、[知识库接口](KNOWLEDGE_RUNTIME.md) 和 [C2 Session 任务/验收](C2_SESSION_ROTATION_TASK.md) 为准。冲突不得自行创造兼容解释；按下文冲突处理门执行。

## 1. 实施前必须盘点的现有实现

禁止新建并行的 EventLog、Board、RAM、Experience store、Session manager 或工作流框架。先核对当前产品入口与接线：

- `shared/events.mjs`：权威追加日志、来源、持久化与恢复。
- `memory/board.mjs`、`memory/state.mjs`、`memory/ram.mjs`：现有投影、Intent/Claim/Artifact、knowledge selection 与 RAM v4。
- `memory/proposal.mjs`、`memory/evidence-resolver.mjs`：提案 gate、来源引用和可信证据。
- `memory/knowledge.mjs`、`memory/document-seed.mjs`：本地卡/seed 检索、分段和来源摘要。
- `memory/experience-compiler.mjs`、`memory/learning-router.mjs`、`memory/learning-bridge.mjs`：现有 Experience 证据门与路由。
- `session/handoff.mjs`、`session/handoff-host.mjs`、`session/session-supervisor.mjs`：现有安全轮换和真实 Session 生命周期。
- `extensions/aegis-observer.ts`：Observer 工具、每次 provider 请求 RAM、轮次 checkpoint、现有知识接线。
- `campaign/c6-entry.mjs`、`campaign/host.mjs`、`campaign/scheduler.mjs`：Campaign 请求/预算/Host 的现有边界；不得在旁边另造调度器。

当前基线 `d84b692` 已包含前一轮**知识工作集局部修复**，不是本任务完成状态。本文写作时分支为 `fix/knowledge-working-set`，HEAD=`d84b692`，嵌套 Pi HEAD=`2ba451d99`。工作树已有暂停中的未提交原型：`Pi_Agent_base/memory/work-cycle.mjs`、`tests/aegis-work-cycle.mjs` 及 Observer/RAM/state 局部改动。原型只实现 repeat/no-progress 推导的部分形状，未完成 SDK 产品接线与全套验证，不能视为已通过实现。实现 Agent 必须先检查确切 diff 和测试，逐项决定复用/修正/与 owner 协调弃用；不得盲目叠加、覆盖或清理。另有独立未跟踪 `Pi_Agent_base/UI/`，严禁添加、覆盖、删除或 reset。

## 2. 设计边界与状态模型

### 2.1 身份与职责

- **Task**：用户授权的总体目标、预算、目标范围和验收条件。
- **Episode**：一个 Task 的一次连续尝试。它可以跨越多个 Session 和多个 work unit；Session 轮换、work unit 切换都不创建独立 Episode，也不产生独立成功证据或预算。
- **Session**：一个有限上下文/工作时段。新的 Session 读取同一 Episode 的 committed 状态，不续播完整 transcript，不改变授权/预算。
- **Work unit**：一个由模型提出、用户/Host 监督、边界较小的调查/实验子目标。它是未验证计划，不是 Campaign Stage、Outcome 或 success。可复用现有 Intent 的 `scope` 作为稳定 unit id；若代码需要新增字段，必须在实现计划中解释为何不能复用，不得让模型字段授予授权。
- **Checkpoint**：对工作单元进展/边界的可审计记录。模型可提出内容，但 Runtime 只保证记录结构和来源；`summary`、`unit_status`、`blocker` 均保持 unverified，不能自动成为 Fact/Outcome。
- **Work review**：停滞后的强制复盘门。它要求比较尝试路线、重新检查证据、执行一次知识检索并提出新的 scoped Intent；完成复核不是任务成功。

图板/EventLog 是唯一权威输入；RuntimeState/Board/Work-cycle 是可从 committed events 确定性重建的投影；RAM/handoff JSON/UI 只是派生 view。实现不得把模型摘要直接写成可信节点，也不得把 checkpoint 文件作为事实来源。

### 2.2 信任与事件契约

首选复用现有 `runtime.note`（schema 1.1）及现有 `proposal.submitted`，不新增 event type，也不修改基础 schema major。推荐 payload 示例：

```json
{
  "event_type": "runtime.note",
  "episode_id": "ep-...",
  "source": { "kind": "runtime", "actor_id": "aegis-observer" },
  "payload": {
    "kind": "work.checkpoint",
    "version": "work-cycle-1",
    "work_unit_id": "unit:inspect-parser-boundary",
    "model_claim": {
      "status": "blocked",
      "blocker": "same response for three distinct parser probes",
      "next_step": "test a technique requiring the observed PHP version"
    },
    "evidence_event_ids": ["evt-action-1", "evt-action-2"],
    "trust": "unverified_model_summary"
  }
}
```

结构字段由 Runtime 校验、durable 写入；`model_claim` 仍是模型声明。写入来源 `runtime` **不提升其中结论的可信度**。所有 evidence IDs 必须先验证存在、同 Episode、在当前 event prefix 内；拒绝 foreign/future/duplicate/malformed refs。对 checkpoint 的摘要与原始 action/observation 分开存储。

成功只来自已有独立 Oracle/人类 `Outcome` 契约。普通 action 完成、相同输出、错误码、模型声称“完成 unit”都不能产生 Outcome/Fact/Experience。

### 2.3 Work-cycle 投影与停滞信号

纯函数从**当前 Episode 已提交事件**计算，不扫描 shell 命令内容，不判定业务语义：

1. **重复路线**：相同 `tool_name + arguments_digest` 多次执行，且返回 `content_digest` 相同；记录关联 request/completion event IDs。
2. **多路线无进展**：从最近一个可信 progress marker 后，多个不同 effect-capable route 已完成，但没有新可信 progress。只计算已配对、已提交的请求与完成。
3. **可信 progress marker**：绑定当前 Episode 的 Oracle/human `Outcome success`，或按现有契约确认的独立 verified observation。Transport success、模型文本、candidate/Intent 本身不算进展。
4. **读工具**（现有 `READ_ONLY_TOOLS`）不计 effect-route；通用 bash 不透明，按可能有副作用路线保守计数，不解析命令猜业务含义。
5. **阈值必须先由实现 Agent 在 T0 提出并用测试矩阵冻结，再编码**，不能从本任务文档直接抄成生产常量。本地原型曾试用“同参数+同输出 3 次”与“8 个 effectful actions / 4 个不同签名”的草案值；它们未经 owner 确认与真实任务校准，不能视为已决定的产品参数。候选值必须来自 trusted host policy，不可接受模型提交的限额；冻结后测试 limit−1/limit/limit+1。

6. review trigger 是提示/门控状态，结果为 `review_required | awaiting_scoped_intent | clear`，不能输出 `failed/refuted`。事件缺失/损坏/审计不可用时 fail-closed，不继续放行副作用。
7. Work unit 边界采用显式的 scoped Intent/checkpoint；新 Intent 本身不算进展。停滞触发后，只有关联 review 的新 scoped Intent 才能开启下一 work unit，不能通过随便提交 Intent 清零停滞计数。

“多个方向都没效果”必须解释为“有不同的已提交尝试但缺少可信 progress marker”，不是按输出文本推断错误；系统提示模型查看证据并重规划。

## 3. RAM、知识、经验与图板的目标行为

### 3.1 每请求 RAM

RAM 继续每次 `context_with_system` 从 committed state 重建。新增有界 `work_cycle` frame，只在需要复核时出现，例如：

```json
{
  "work_cycle": {
    "status": "review_required",
    "work_unit_id": "unit:inspect-parser-boundary",
    "reasons": ["same_action_same_result_repeated"],
    "evidence_refs": ["r12", "r14"],
    "next_step": "Compare attempted routes, query the blocking technique, then propose a new scoped Intent.",
    "trust": "runtime_advisory_not_outcome"
  }
}
```

优先级：Task/授权/预算/pending/unknown → 当前 blocker 和 work_cycle gate → 当前 scoped Intent、相关已验证 Fact/Refuted → 显式选中的经验/知识引用 → 最近 action observation/普通 checkpoints。核心不可被知识挤掉。预算不足时先省略非当前资料并公开 omission；针对显式选中的 chunk 可有界缩短，但必须标 `truncated` 和可续读 `knowledge_id`。不能声称拥有整卡/整 PoC，除非模型实际收到全部相关分段。

不改 RAM 的信任类别：Fact 由可信 authority 产生；Intent/Claim 和 checkpoint 是 unverified；knowledge/seed/experience hint 是 reference/rule 而非 authorization。旧历史详情通过现有引用/Artifact read 按需读取，不扩展无限 transcript。

### 3.2 检索与 review

- 初始 automatic retrieval 是候选排序，不代表模型实际看到或采用。短 follow-up 沿用当前 work frame，不将“继续”独立作为主题查询。
- 显式 `aegis_knowledge` 接收 `query`、可选已有 `knowledge_id`，返回排名/适用条件/分块 IDs；同一 seed 的短文本卡可聚合 When/Do/Expect/Limits，长 code sections 单独分页/chunk 取回。
- Stall review 由已有记录的重复/停滞触发。新增受限 `aegis_work_review`（或证明可复用现工具等效）需要：`blocker`、已尝试 route 的 source refs、`knowledge_query`、`next_step`；Runtime 从本地知识库执行一次有界检索，durable 记录检索事件及 review 关联，返回 selection 的真实 IDs/limits。
- 若无本地命中，明确 `unavailable/no_match`；模型可用现有 `aegis_web_search` 搜一般 technique/CVE/tool（若启用且预算允许），绝不搜目标 write-up。Search 结果仍 unverified。
- 同 Episode 的显式 `model_query/work_review` 选择有界保留；自动召回不能覆盖/降级；新 work unit 可显式替换/release 旧 working-set refs。重启从 EventLog 复建，不从 mutable checkpoint 授权。
- 知识是否 “used” 要有 action/claim/Outcome 的显式引用关系；不能从时间邻近、模型口头声称或 selection alone 推断。未验证失败可阻止盲目重复，但不自动成为全局 Refuted 经验。

### 3.3 Experience

- 本任务不放松 `experience-compiler` / `learning-router` 的 evidence gate，不准从单 Episode、多 Session、checkpoint、卡片或 seed 自动激活 Experience。
- active Experience 仍必须通过现有独立结果/独立 Episode/scope/replay 证据；Session rotation/work-unit split 不产生独立样本。
- 可以把被用于/被拒绝的 Experience ID、版本、route 和原因记入现有 selection decision，作为可核对使用数据；不另建 experience store 或计分权威。

## 4. 任务顺序与 Agent 交付

实现 Agent 按此顺序完成；每步先加旧实现会失败的正/负用例，再改代码。接口/共享字段由主 Agent统一审查。一个步骤通过后才进入依赖步骤。

### T0：基线、所有权与契约冻结

1. 记录当前 HEAD、分支、dirty status、嵌套 Pi HEAD/dirty、required/聚焦测试真实命令与退出码。
2. 检查当前工作树中的 `memory/work-cycle.mjs` / `tests/aegis-work-cycle.mjs` 是否存在并审查差异。当前未提交原型不自动成为契约：复用或重构都要写明理由；不得丢弃。
3. 阅读本任务引用的规范、现有 Session/Campaign 契约与 API 源码；不改 embedded Pi、不装依赖、不触真实网络/模型。
4. 提交简洁任务矩阵：需求 → 事件/字段 → reducer/consumer → 正负例 → 产品入口。**暂停接口定义并咨询 owner** 的情况见 §8。

### T1：Event-sourced Work-cycle reducer

- 新 helper 放 `memory/`，纯函数接收 committed rows + trusted thresholds，返回同 Episode 当前 unit、review trigger、关联证据 refs、是否 awaiting-scoped-Intent；输入验证、防 foreign/future refs。
- 重复 action signature 采用已有 `arguments_digest`，重复结果采用真实 `content_digest`；不能把相同 exit code 当相同业务结果。
- 仅可信 Oracle/human success /契约允许的 verified observation 重置“无进展”窗口。缺证据、unknown、失败的候选、模型 Intent 不清除停滞计数。
- scoped Intent 只改变工作目标/边界；不得充作验证成功。review trigger 的清除需有 review record 和之后引用它的新 Intent。
- 结果只为投影/调度建议，不写 Outcome，不赋权。

### T2：图板与 RAM work frame

- 复用 Board/EventLog/RuntimeState。每个 work checkpoint/review 引用同 Episode 的有效 node/action/event。
- RAM 增 work_cycle 状态 + 当前工作单元/卡点/已尝试路线摘要；保持字段白名单、trust 标签、稳定 refs、实际 JSON budget 和 omitted 信息。
- 事实、pending、未知副作用责任优先于任何可选总结/知识；work frame 满载不复制 transcript。
- 检查 `round.checkpoint` 现有模型摘要的信任标签；不将其当作结构化 work status。

### T3：复核与 retrieval gate

- 在 `extensions/` 只做 Pi tool/hook 接线；判定逻辑留在纯模块。
- review trigger 激活后，block effect-capable tools；仍允许必要只读观察、知识检索、review/checkpoint，以及有明确 refs 的新 Intent。阻断要返回原因并终止同批后续 effect，且记录拒绝。
- review 必须比较当前 blocker/证据/尝试路径，形成 query 与下一实验，并经本地 `selectKnowledge` 检索一次；记录实际选择 ID、source/digest、query、命中/空结果、limits。检索失败不得伪报“已检查知识”。
- review event 是 runtime 结构记录但内容标 `unverified_model_summary`；新的 Intent 同 Episode、scope 新于旧 work unit、source refs 必须引用 review/selected knowledge。只通过 proposal ref gate 后解除 side-effect hold。
- 不通过 `tool_result.isError`、普通 bash 文本、exit=0 或“我已复盘”模型语言清门。

### T4：工作单元完成与 Session handoff

- 复用现有 `aegis_propose kind=intent`/review 工作流表达从当前 unit 到下一 unit；如需独立 `aegis_work_checkpoint` 字段，先证明确有现有 proposal/Intent 无法表达的核心信息，并由主 Agent冻结接口，不能顺手另建工作流。
- unit 完成/阻塞 checkpoint 只能表达规划状态，不等于 Stage/Task success。附有效进度/未决 action refs。
- 达到完成边界或可信 context/request 预算阈值时，准备有界 handoff；调用现有 settle → `SessionSupervisor` → real SDK new Session → bind → completion 路径。Observer handler 不可直接在 `agent_end` 创建 Session；Pi 文档说明 `agent_end` 之后仍可能 continuation/compaction，须使用现有安全边界/Host command。
- `ctx.getContextUsage()` 只在实际 context API 可用时使用；未知用量标 unknown，不以 RAM chars 代替 token estimate。未确认 threshold 采用 trusted policy，default 阈值由 owner/config 审核，不能硬编码臆造。
- 新 Session 复建同 Episode 的工作集，不重放旧用户 prompt/整 transcript，不重置累计预算，不把 Session 数算成成功数。
- 明确当前入口差别：C6 已有 Host/Supervisor；普通 `run-aegis/run-experiment` 目前主路径以 model request tool + `/aegis switch` Host command 为边界。不得宣称普通入口拥有 Campaign scheduler 式自动轮换；若新增自动触发，须确认真实可调用 Host 边界与 UI/非 UI fallback，并在 task matrix 单独验收。

### T5：Experience 使用、对照与文档

- 复核 experience router 当前能否在相同工作集使用 `active` Experience；记录 chosen ID/revision/route及后续被采用的 action refs。
- 不改变独立证据/replay gate。新增一个 negative-transfer test：wrong/stale/unmatched Experience 不得抑制 review/retrieval 或授权执行。
- 把任务状态、行动引用、交接和 retrieval choice 纳入有界报告/Inspector，严格复用现有只读投影；不另建 UI truth。
- 交付离线/faux 指标和真实模型实验计划；不声称 retrieval accuracy 或 solve-rate 已提升，除非做了受控的 user-authorized comparison。

## 5. 状态/事件核心示例

### 5.1 停滞检测（纯 reducer，不是授权）

```js
const cycle = projectWorkCycle(committedEpisodeEvents, episodeId, trustedPolicy);
// { status: "review_required", reasons: ["same_action_same_result_repeated"],
//   evidence_event_ids: [requestId1, completionId1, ...], trigger_id: "..." }
```

核心条件示例：

```js
sameSignature = tool_name + arguments_digest;
repeatTrigger = count(sameSignature, sameResultDigest, sinceTrustedProgress) >= policy.repeat_limit;
broadStall = effectfulCompleted >= policy.action_window
  && distinctSignatures >= policy.min_distinct_routes
  && noTrustedProgressSinceWindowStart;
```

这里 `sameResultDigest` 是 EventLog 里 capture 的真实 content digest；如果结果缺失/unknown，就仍记 unknown，不臆造 digest=success。helper 应返回 evidence IDs 与原因，不输出 `failure/refuted`。

### 5.2 Work review 事件

```json
{
  "event_type": "runtime.note",
  "episode_id": "<current Episode>",
  "source": { "kind": "runtime", "actor_id": "aegis-work-review" },
  "payload": {
    "kind": "work.review",
    "version": "work-cycle-1",
    "trigger_id": "<deterministic id over same-Episode evidence refs>",
    "evidence_event_ids": ["<action.requested>", "<action.completed>"],
    "blocker": { "text": "<model proposal>", "trust": "unverified_model_summary" },
    "attempted_routes": ["<route text + evidence refs>"],
    "retrieval": { "query": "<bounded query>", "selection_event_id": "<knowledge.selected>" },
    "next_step": { "text": "<next experiment>", "trust": "unverified_model_summary" }
  }
}
```

Event schema stays 1.1 (`runtime.note` is already registered). Runtime source authenticates writer/shape, **not** model-claimed blocker/next step. Source refs must validate against committed same-Episode prefix. If a new kind fails existing consumers closed/validates incorrectly, extend their explicit payload handling; do not create new `event_type` casually.

### 5.3 Work intent and gate

Use existing proposal interface unless T0/T1 proves it insufficient:

```json
{
  "kind": "intent",
  "scope": "unit:<new-scoped-unit-id>",
  "text": "<next bounded work unit and observable question>",
  "source_refs": [
    { "ref_type": "event", "ref_id": "<work.review event id>" },
    { "ref_type": "event", "ref_id": "<selected knowledge event id>" }
  ]
}
```

Gate pseudo-code:

```js
if (cycle.review_required && isEffectCapable(toolName)) {
  blockAndTerminateBatch("work_review_required", cycle.evidence_event_ids);
}
if (cycle.awaiting_scoped_intent && !isNewIntentCitingCurrentReview(args)) {
  block("reviewed work is still held until a new scoped Intent is committed");
}
```

`isEffectCapable` must reuse the project’s tool classification/registered contracts, not parse bash commands. Pure read/search and review tools remain available while stalled. An invalid/rejected Intent does not clear the gate. A review can be replayed idempotently; duplicate review must not duplicate knowledge selections or create unbounded notes.

### 5.4 Handoff source and derived package

Committed `handoff.requested/completed` stays authoritative for lifecycle. A staged handoff payload may carry a versioned digest/cursor, current unit id, relevant review/knowledge/evidence refs, but no free-standing grant or status. The replacement loads current Manifest/config as currently frozen, replays committed EventLog, reconstructs RAM, verifies scope, and only then accepts the continuation. Failure/cancel/unsettled effect retains staged recovery responsibility and never creates a second attempt.

## 6. Acceptance matrix (required)

| Req | Test / expected behavior | Level / entry |
|---|---|---|
| WC-01 | Same trusted EventLog prefix deterministically produces same work-cycle view/digest; foreign Episode actions ignored | pure reducer |
| WC-02 | 2 identical route attempts do not trigger; configured boundary (e.g. 3) same args+same output digest triggers review | pure boundary |
| WC-03 | Same tool/args but changed output is not “same action+same result”; unknown output never becomes failure | pure negative |
| WC-04 | Multiple distinct effect routes ≥ threshold without trusted progress triggers review; read-only calls alone do not; trusted scoped Oracle success resets window | pure reducer |
| WC-05 | LLM Intent/checkpoint/assistant prose/transport 0 alone do not reset trusted-progress count | source boundary |
| WC-06 | RAM shows review status/reasons/evidence refs and next steps as unverified; still retains Task/auth/budget/pending/unknown; total JSON ≤ budget or core overflow fails request | RAM projection + request boundary |
| WC-07 | Gate blocks write/effect in same/next tool batch after trigger; read-only observation/retrieval/review remain available | real SDK+faux |
| WC-08 | `aegis_work_review` verifies same Episode evidence, performs and records bounded retrieval; empty/unavailable/disabled/search-disabled is explicit; no “knowledge reviewed” claim without actual record | product tool |
| WC-09 | Review event without new Intent keeps effects held; new Intent must be accepted, same Episode, new scope, cite exact review event/selection; foreign/future/bad ref rejected | proposal + gate |
| WC-10 | Duplicate/replayed review is idempotent; retrieval does not duplicate IDs or grow beyond caps; failed durable append leaves gate held | EventLog/recovery |
| WC-11 | Work-unit checkpoint `complete/blocked` remains unverified planning metadata; cannot create stage/task completion, Fact, Outcome, active Experience or independent Episode | board/compiler negative |
| WC-12 | Work-unit completion/context threshold recommends or stages handoff using existing Host boundary only; real SDK new object/context/session id; same Episode/goal/auth/budget/pending refs; no full transcript replay | SDK integration |
| WC-13 | In-flight or unknown side-effect blocks rotation; creation/bind/cancel/fsync failure has no false completion; resume/replay no duplicate action or charge | recovery integration |
| WC-14 | Long/old/superseded/foreign work notes cannot displace pending/core; invalid references visible/rejected; report/UI read same revision, no write route | projection/report |
| EXP-01 | Four arms fixed: existing long Session; short Session+existing board; short+work-unit frame; short+frame+stall review/retrieval. Same task/model/tools/authorized budget and reset; report independent success and failure, route repetition, recall/usage and cost separately | offline first, real-model only with explicit current authorization |

Use positive, negative, boundary, retry/replay and product-path tests. Expected results must be independent of helper implementation. At least one real SDK + faux test must cross actual Observer/Session replacement. Do not treat a helper unit test as product integration.

## 7. Task completion order / deliverables

1. **T0 Contract/baseline artifact**: current status/HEAD, changed-file ownership, entry map, thresholds/config, state-transition table, event examples and exact test matrix; stop to discuss unresolved persistent format/authorization choices.
2. **T1 Pure reducer + tests**: work-cycle/no-progress detection and ids; no side effects.
3. **T2 Work checkpoint/review + Board/RAM**: typed validation, event projection, references/omissions/budget behavior.
4. **T3 Review retrieval + gate**: actual model-callable tool registered/allowed/accounted on each supported entry, same-task refs, knowledge status and fail-closed effect block.
5. **T4 Work-unit/session continuity**: real Host/Supervisor path, settling, budget and recovery, same Episode, no transcript replay. Explicitly document any entry that still requires manual `/aegis switch`; never claim auto rotation there.
6. **T5 Existing Experience path + evaluation**: verify Experience hints coexist without overriding work-review gate; add negative transfer and matched integration tests; run the fixed offline ablation harness only. Real provider/target experiments require separate authorization.
7. **T6 Final review/commit**: read all diffs and staged paths, run targeted tests then `run-required.sh` once, affected SDK+faux integrations, Biome, type diagnostics against documented baseline, module layout if imports/directories changed. Commit explicit files only; do not include `Pi_Agent_base/UI/` or ignored private evidence.

Required delivery: (a) task matrix with exact command/status/exit/log per case, (b) schema/state transitions and migration note, (c) modified entry/call-chain map, (d) baseline-vs-new differential results, (e) limitations and per-entry auto/manual handoff truth, (f) branch/commit/status. Do not assert “cross-session learning improved” without controlled measured success-rate evidence.

## 8. Must stop and consult owner

Continue with existing additive `runtime.note`/current Intent/Campaign interfaces where possible. Ask before: changing `Episode`/`Outcome` semantics; treating a work unit as a trusted Campaign Stage; changing active Experience evidence thresholds; clearing or changing authorization/budgets on rotation; adding automatic real-model/network calls; adding persistent global skill scoring; expanding permissions/targets; introducing a second canonical store/schema; adding dependencies or modifying Pi core.

Thresholds in §2.3 are implementation defaults for isolated, falsifiable stall detection. Keep them centralized/configurable only through trusted host configuration. If they would cause an automatic production effect/session switch or change persisted contract, leave the feature advisory and report the decision for owner confirmation; do not silently widen scope.

## 9. Research pointers (background, not project contract)

Use the official papers/projects as references, not copied authority:

- MemGPT, *Towards LLMs as Operating Systems*, [arXiv:2310.08560](https://arxiv.org/abs/2310.08560): hierarchical in-context/external memory and paging.
- Generative Agents, [arXiv:2304.03442](https://arxiv.org/abs/2304.03442): memory stream and retrieval/reflection; importance/relevance heuristic is not itself a truth mechanism.
- FLARE, [arXiv:2305.06983](https://arxiv.org/abs/2305.06983): active retrieval during generation from current partial answer/uncertainty; our model APIs may not expose token confidence, so use observable Aegis signals instead.
- Reflexion, [arXiv:2303.11366](https://arxiv.org/abs/2303.11366), and ExpeL, [arXiv:2308.10144](https://arxiv.org/abs/2308.10144): feedback/reflection and contrastive experiences; Aegis retains independent evidence/replay gates rather than importing their evaluator assumptions.
- MemoryAgentBench, [arXiv:2507.05257](https://arxiv.org/abs/2507.05257): incremental multi-turn evaluation across accurate retrieval, test-time learning, long-range understanding and conflict resolution.
- LongMemEval, [arXiv:2410.10813](https://arxiv.org/abs/2410.10813): indexing/retrieval/reading decomposition, multi-session reasoning, temporal updates and abstention.

External research motivates test dimensions only. It does not override Aegis contracts, authorize new model calls, establish the proposed thresholds, or prove this project will improve without an experiment.
