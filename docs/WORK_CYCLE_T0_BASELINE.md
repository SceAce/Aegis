# Work-cycle / 跨 Session 图板连续性 T0：基线、契约冻结与任务矩阵

状态：**第一阶段 T0 历史基线，不是已验收声明。**
后续工作单元绑定、复核消费和自动轮换采用 [第二阶段任务书](WORK_CYCLE_PHASE2_IMPLEMENTATION_TASK.md)
及现有 [接口契约](STRUCTURED_RAM_AND_WORK_CONTROL.md) 的新增细化；下文“owner 待确认/仅 advisory”保留其当时范围。
依据任务书：[WORK_CYCLE_AND_SESSION_HANDOFF_IMPLEMENTATION_TASK.md](WORK_CYCLE_AND_SESSION_HANDOFF_IMPLEMENTATION_TASK.md)。
本文件只冻结本轮接口、信任边界、阈值来源和测试矩阵；实现状态与命令结果见
[WORK_CYCLE_IMPLEMENTATION_REPORT.md](WORK_CYCLE_IMPLEMENTATION_REPORT.md)。

## 1. 开工基线（2026-10-21 本地）

| 项目 | 值 |
| --- | --- |
| 主仓库分支（开工） | `fix/knowledge-working-set`，HEAD `d84b692` |
| 主仓库分支（本轮） | `feat/work-cycle-session-handoff`，起点 `d84b692` |
| 嵌套 Pi | `Pi_Agent_base/pi` 独立仓库，HEAD `2ba451d99`，`git status --porcelain` 为空 |
| 工作树 | 已有未提交原型：`extensions/aegis-observer.ts`、`memory/ram.mjs`、`memory/state.mjs`、`memory/work-cycle.mjs`、`tests/aegis-work-cycle.mjs`；`docs/README.md` 一行文档改动；未跟踪任务书 `docs/WORK_CYCLE_AND_SESSION_HANDOFF_IMPLEMENTATION_TASK.md` |
| 用户独立改动 | `Pi_Agent_base/UI/` 未跟踪；本轮**未读取、未修改、未暂存** |
| 已知基线 | 本任务前聚焦套件：`aegis-runtime-core-smoke`、`aegis-runtime-effective-board`、`aegis-ram-projection`、`aegis-ram-reaudit`、`aegis-knowledge`、`aegis-observer-failclosed-pi`、`aegis-observer-runtime-handoff`、`aegis-c2-session-rotation`、`aegis-knowledge-sdk` 全部退出码 0（日志见 ignored `Pi_Agent_base/runtime/dev/work-cycle-baseline/`） |

### 1.1 未提交原型的逐项判定

| 文件 | 原型内容 | 判定 | 理由 |
| --- | --- | --- | --- |
| `memory/work-cycle.mjs` | 重复/多路线 stall reducer、Intent 重置窗口、review 由 `knowledge.selected` 充当 | **重构后复用** | 事件配对、证据 ID、digest 复用思路正确；但 Intent 清零计数、review 记录形状、可信 progress 判定（未复用 Board 的 Fact gate）、无策略校验、无 foreign/future ref 校验均不符合任务书，需修正 |
| `tests/aegis-work-cycle.mjs` | 7 段断言 | **重写并扩展** | 原型用例固化了“Intent 重置计数”和“knowledge.selected 即 review”两个错误契约；保留其 repeat/broad/信任 reset 的正例意图，按 WC-01..05 + 边界值重建 |
| `extensions/aegis-observer.ts` | 工具门控 + `aegis_work_review` + RAM 接线 | **修正后复用** | 工具门控位置（`tool_call` 串行 admission、`terminate`）可复用；但 review 事件 ID 记错（用 selection 事件充当 review）、检索无 `work.review` 结构、门控允许任意 `aegis_propose` 在 `review_required` 下通过、未复用统一工具分类，需改 |
| `memory/ram.mjs` | `task.work_cycle` frame、`work_review` 知识优先级 | **复用并扩展** | 位置合理（属于不可丢弃核心），需补 work unit、review/next_step、handoff advisory、context usage unknown 语义与 omission 统计 |
| `memory/state.mjs` | `work_review` knowledge selection 模式、CONTROL_TOOLS 增加 review | **复用并扩展** | 需增加 `work_review`/`work_checkpoint` 结构化投影（仅未验证规划元数据） |

原型中 `docs/README.md` 的文档链接改动与本任务一致，保留。

## 2. 职责与不新建权威

- 权威输入：`shared/events.mjs` EventLog（append-only、fsync、hash chain）。
- 投影：`memory/board.mjs`、`memory/state.mjs`、`memory/work-cycle.mjs`、`memory/ram.mjs`，全部从 committed events 确定性重建。
- 提案 gate：`memory/proposal.mjs` + Observer 的 `inspectProposalRefs`。
- 知识检索：`memory/knowledge.mjs#selectKnowledge`（本地 `$AEGIS_HOME/knowledge/`），记录为 `runtime.note kind=knowledge.selected`。
- 轮换：`session/handoff.mjs` → `session/handoff-host.mjs` → `session/session-supervisor.mjs`；Observer 不创建 Session。
- Experience：`memory/experience-compiler.mjs` / `learning-router.mjs` / `learning-bridge.mjs` 不变；work unit、checkpoint、review、Session 数都不产生独立证据。
- **不新增**：第二套 EventLog/Board/RAM/Session manager/Experience store/调度器；不新增 event_type；不改 schema major。

## 3. 冻结的事件/状态接口（T0）

全部使用已注册的 `runtime.note`（schema 1.1）与 `proposal.submitted`；不新增 event type。

### 3.1 `work.checkpoint`（Runtime 结构，模型声明不升级信任）

写入者：`aegis_work_checkpoint` 工具（source `runtime`，`causation_id` = 当前 prompt 事件）。
模型只能提交 `model_claim`；Runtime 校验结构、同 Episode refs 与长度。

```json
{
  "kind": "work.checkpoint",
  "version": "work-cycle-1",
  "work_unit_id": "unit:inspect-parser-boundary",
  "unit_status": "continue | blocked | complete",
  "model_claim": {
    "summary": "<=600 chars",
    "blocker": "<=400 chars | null",
    "next_step": "<=400 chars | null"
  },
  "evidence_event_ids": ["<same-Episode, already committed>"],
  "context_usage": { "known": true, "used_tokens": 1234, "limit_tokens": 200000, "percent": 12 },
  "handoff": { "recommended": false, "reasons": [], "context_usage": "unknown | known" },
  "trust": "unverified_model_summary"
}
```

规则：
- `unit_status` 是**未验证规划状态**，不产生 Stage/Task 完成、Fact、Outcome、active Experience 或独立 Episode。
- `evidence_event_ids` 必须存在、同 Episode、在当前 committed prefix 内、无重复；外域/未来/格式非法/重复 → 拒绝写入（返回 `reason`，不静默降级）。
- `context_usage.known=false` 时不得用 RAM 字符数冒充 token。

### 3.2 `work.review`（复核记录 + 真实检索关联）

写入者：`aegis_work_review` 工具。先写 `knowledge.selected`（`mode="work_review"`，durable），再写 `work.review` 引用该 selection event。

```json
{
  "kind": "work.review",
  "version": "work-cycle-1",
  "trigger_id": "wrev_<digest>",
  "work_unit_id": "unit:...",
  "evidence_event_ids": ["<action.requested/completed ids>"],
  "blocker": { "text": "<=400 chars", "trust": "unverified_model_summary" },
  "attempted_routes": ["<=180 chars", "..."],
  "retrieval": {
    "query": "<=800 chars",
    "selection_event_id": "<committed knowledge.selected event id>",
    "status": "ready | no_match | unavailable | disabled",
    "selected_knowledge_ids": ["..."],
    "limits": { "max_results": 4, "max_chars": 7000 },
    "omitted": 0
  },
  "next_step": { "text": "<=400 chars", "trust": "unverified_model_summary" },
  "trust": "unverified_model_summary"
}
```

规则：
- `selection_event_id` 必须存在、同 Episode、早于 review、来源 `runtime`、kind `knowledge.selected`；否则 review 记录不可用于清门（fail-closed）。
- 同一 `trigger_id` 的重复 review 幂等：返回既有 review 事件，不再写新 selection、不增长 IDs。
- 空命中/不可用/知识检索被策略关闭（`AEGIS_KNOWLEDGE_ENABLED=off`）必须显式为 `no_match`/`unavailable`/`disabled`；不得声称“已检查知识”。
- 检索失败/无法 durable 写入时 side-effect hold 保持。

### 3.3 门控状态（纯投影输出）

`projectWorkCycle(events, episodeId, policy)` 返回：

```text
status: "inactive" | "clear" | "review_required" | "awaiting_scoped_intent"
review_required: boolean            // review_required 或 awaiting_scoped_intent
reasons: ["same_action_same_result_repeated" | "multiple_routes_without_verified_progress"]
trigger_id: string|null             // 仅由 committed refs + policy 决定的确定性 id
work_unit_id / work_unit_event_id
review: { event_id, selection_event_id, blocker, next_step, retrieval_status } | null
evidence_event_ids: string[]
action_count / unique_routes / repeat_count
trusted_progress_event_id: string|null
policy: { repeat_limit, action_window, min_distinct_routes, context_pressure_percent, source }
```

- 停滞后 `review_required` 在 review 被接受前为 `review_required`；review 记录存在但无**引用该 review 的新 scoped Intent** 时为 `awaiting_scoped_intent`。两者都阻断 effect-capable 工具。
- 清除条件（全部满足）：存在与当前 trigger 绑定的 review 且其检索记录有效；之后有同 Episode 的 `proposal.submitted kind=intent`，`scope` 非空且不同于触发时的 unit，`source_refs` 引用该 review 事件（或该 review 的 selection 事件）。普通 Intent/Claim/checkpoint/模型文本/exit code 不能清门。
- 可信 progress = 与 `memory/board.mjs#permittedNodeType` 一致的 Fact 生成（oracle/human + 完整 outcome 证据；或通过 value/evidence/revision gate 的 verified observation）。只重置“无进展”窗口，不代表任务成功。
- 读工具（与 `WORK_READ_ONLY_TOOLS` 一致）不计 effect route；通用 bash 保守按可能有副作用计数，不解析命令内容。

### 3.4 Intent 复核引用 gate（复用现有 proposal 接口）

`aegis_propose kind=intent` 在 `review_required` 期间：
- 必须 `source_refs` 引用当前 review 事件 ID 或其 selection 事件 ID；
- `scope` 必须非空且不等于触发 unit；
- 通过现有 `inspectProposalRefs`/`inspectProposalReplacement` 校验；
- 任一不满足 → 走既有 `proposal.rejected`，门控保持。

不新增 proposal 字段、不改变 `validateProposal` 的禁止字段表。

## 4. 阈值与 host policy（T0 冻结值，待 owner 复核）

候选值来自任务书 §2.3 的原型草案；**本轮只作为集中式默认 host policy**，不写成散落常量，模型不可提供。

| 策略键 | 默认 | 边界 | 依据/说明 |
| --- | --- | --- | --- |
| `repeat_limit` | 3 | 2–10 的整数 | 同 `tool_name + arguments_digest` 且 `content_digest` 相同达到 3 次 → 复核请求。2 次可能是正常的重试/校验 |
| `action_window` | 8 | 3–50 的整数 | 只统计已配对、已提交的 effect-capable completed |
| `min_distinct_routes` | 4 | 2–`action_window` | 窗口内 ≥8 个 effect 完成且 ≥4 个不同签名、无 trusted progress → 复核请求 |
| `context_pressure_percent` | 85 | 50–95 | 仅在 `ctx.getContextUsage()` 返回真实 tokens 时用于 handoff **建议**；未知时显式 unknown，不由 RAM 字符估算 |

来源：`resolveWorkCyclePolicy(env)` 只接受 Host 环境变量
`AEGIS_WORK_CYCLE_REPEAT_LIMIT`、`AEGIS_WORK_CYCLE_ACTION_WINDOW`、`AEGIS_WORK_CYCLE_MIN_DISTINCT_ROUTES`、
`AEGIS_WORK_CYCLE_CONTEXT_PERCENT`。非法值回落到默认并记录 `invalid`，不接受模型/事件提供限额。

**冻结边界行为（测试 limit−1 / limit / limit+1）**：`repeat_limit−1` 不触发、`repeat_limit` 触发；
`action_window−1` 个 effect 完成不触发 broad stall、`action_window` 且满足 `min_distinct_routes` 才触发；
`min_distinct_routes−1` 不触发 broad stall。

**owner 待确认（本轮不扩大）**：
1. 默认阈值是否作为正式生产策略；
2. 是否允许“work unit 完成/context 阈值”自动触发 Session 轮换。本轮只生成 **advisory recommendation** 和结构化 checkpoint；真实轮换仍由现有 Host/Supervisor 或 `/aegis switch` 在安全边界执行，普通 `run-aegis`/`run-experiment` 入口**没有**自动轮换。

## 5. RAM work frame（T0 冻结形状）

`buildRamProjection({ workCycle, contextUsage })` 在 `task.work_cycle` 中增加（核心，不因预算丢弃）：

```json
{
  "status": "review_required",
  "work_unit_id": "unit:...",
  "reasons": ["same_action_same_result_repeated"],
  "evidence": ["r12", "r14"],
  "review": { "event": "r20", "blocker": "...", "next_step": "...", "retrieval": "ready", "trust": "unverified_model_summary" },
  "next_step": "Compare attempted routes, query the blocking technique, then propose a new scoped Intent.",
  "handoff": { "recommended": false, "reasons": [], "context_usage": { "known": false } },
  "trust": "runtime_advisory_not_outcome"
}
```

优先级（高 → 低）：Task/授权/预算/pending/unknown → work_cycle gate → 当前 scoped Intent、已验证 Fact/Refuted → 显式选择的知识/经验引用 → 最近 observation/普通 checkpoint。知识/经验只能存在于 reference/rule 寄存器，不得挤掉核心，不改变 trust 类别。

## 6. 任务矩阵（需求 → 事件/字段 → reducer/consumer → 正负例 → 产品入口）

| 需求 | 事件/字段 | reducer/consumer | 正/负例 | 产品入口 |
| --- | --- | --- | --- | --- |
| WC-01 确定性/隔离 | `action.requested/completed`、episode_id | `projectWorkCycle` | 同前缀同 digest；foreign Episode 忽略 | Observer `tool_call`/`context_with_system` |
| WC-02 重复路线边界 | `arguments_digest`,`content_digest` | 同上 | 2 次不触发；`repeat_limit` 同参同输出触发 | `tool_call` gate |
| WC-03 结果变化 | `content_digest` / missing | 同上 | 同参不同输出不触发；unknown 结果不成 failure | reducer |
| WC-04 多路线/重置 | effect 完成 + Fact | 同上 | ≥window 且 ≥routes 触发；read-only 不算；oracle success 重置 | reducer + RAM |
| WC-05 非进展来源 | Intent/prose/transport | 同上 | Intent/checkpoint/`tool_ok` 不清计数 | reducer |
| WC-06 RAM | `work_cycle`, budget | `buildRamProjection` | 状态/原因/refs 可见；核心保留；≤ budget 或 core overflow | `context_with_system` |
| WC-07 副作用门控 | tool 分类 | Observer `tool_call` | effect 阻断 + terminate；read/retrieval/review 放行 | real SDK+faux |
| WC-08 review 检索 | `knowledge.selected` + `work.review` | `aegis_work_review` | 真实 selection event；empty/unavailable/disabled 显式；无记录不宣称 | 产品工具 |
| WC-09 解锁条件 | Intent source_refs/scope | Observer propose gate | review-only 保持；非法/future/foreign ref 拒绝 | `aegis_propose` |
| WC-10 幂等/恢复 | trigger_id | review 幂等；append 失败 | 重复 review 不重复 selection；durable 失败保持 hold | EventLog/recovery |
| WC-11 checkpoint 非成功 | `work.checkpoint` | state/board/compiler | complete/blocked 不产生 Fact/Outcome/Experience/Episode | board/state |
| WC-12 handoff 连续性 | checkpoint + Host | `evaluateHandoff`/`createSessionSupervisor` | 真实新 Session/context/id；同 Episode/预算；无 transcript 重放 | real SDK+faux |
| WC-13 在途效果 | pending/unknown | `evaluateHandoff` | 阻断轮换；失败无假完成；重放不双计 | supervisor |
| WC-14 旧笔记/核心 | RAM 预算 | `buildRamProjection` | 旧/外域笔记不挤掉 pending/core；非法 ref 拒绝 | RAM/报告 |
| EXP-01 四臂对照 | 离线 | 报告/评估 | 固定四臂；成功/失败分开 | 离线 harness（本轮只提供计划，不调用真实模型） |
| EXP-NT 负迁移 | experience decision/rule | RAM + gate | stale/unmatched Experience 不抑制 review/retrieval、不授权执行 | reducer+RAM |

## 7. 入口真实能力（T0 记录，T6 复核）

| 入口 | 停滞复核/门控 | Session 轮换 |
| --- | --- | --- |
| 普通 Pi / `run-aegis.sh` / `run-pi.sh` | 本任务接入 Observer 工具与 gate | 模型 `aegis_switch_session` + 人工 `/aegis switch`（Host command） |
| `run-experiment.sh` | 同上（同 Observer 路径） | 同上；无 Campaign scheduler 自动轮换 |
| C6 Campaign | 同上，Campaign gate 允许 control 工具 | 已有 Host/scheduler：`max_requests_per_session` 阈值在 settle 边界经 `SessionSupervisor` 轮换 |

本轮不声称普通入口具备自动轮换；work-unit/context 阈值只产生 advisory。

---

# 第二阶段冻结（P0/P1/P2/P3/P4）

状态：**已实现并内部自测；等待独立复核/外部验收。** 第一阶段记录保留不删。

## 8. 工作单元身份

- 当前单元：同 Episode、Board 当前 effective 的 `proposal.submitted kind=intent`，取 committed 顺序最后一个；身份为
  `{ work_unit_event_id, work_unit_id: scope }`。scope 只是标签；被 `replace_event_id` 替换的 Intent 不是当前单元。
- `work.checkpoint` 新增 additive 字段 `work_unit_event_id`。Runtime 写入时绑定当前 effective Intent；模型只能提供
  用于校验的 ref（必须等于当前），不能指定旧/任意单元。
- 旧 checkpoint 无 `work_unit_event_id`：仅当同 Episode 的更早前缀能唯一解析出一个匹配 scope 的 effective Intent 时
  派生绑定；否则保留历史且 unbound，不触发完成轮换。
- 当前 checkpoint 必须在当前 Intent 之后并绑定其确切事件；旧单元 `complete` 不作用于新单元，即使 scope 相同。

## 9. 复核消费与两个计数

| 计数 | 起点 | 前移条件 | 禁止 |
| --- | --- | --- | --- |
| `action_count`（累计） | 最近可信 progress（Board effective Fact，Campaign 传入 Manifest） | 仅新的可信 progress | review/Intent/checkpoint/轮换/Session 数不得清零 |
| `review_round_action_count`（当前轮次） | 最近可信 progress 或当前 trigger 的一次合法消费 | 可信 progress 或该 trigger 的 review 被第一个合格 Intent 消费一次 | 旧 review、重复引用、换 scope/会话不能重新开窗 |

- trigger 身份由**最早形成阈值的证据前缀**计算（`window_start` + 形成前缀的 request/completion IDs + policy + reasons），
  后续 action 不改变已形成的 trigger；新证据在消费后形成新 trigger。
- review 可消费条件：`trigger_id` 等于当前派生 trigger；同 Episode；证据/selection 在 review 之前；retrieval 状态为
  `ready|no_match|disabled`；绑定当前单元事件；之后第一个通过 proposal/ref gate 的新 scope Intent 引用该 review 或
  其 selection。`unavailable` 不可用但同一 trigger 可重试。
- 一个 Intent 同时引用旧 review 与当前 review 时只消费当前一个；旧 review 只保留历史关联。
- 消费关系、计数和 trigger 全部从 committed 事件重放派生；不新增权威表。

## 10. 检索、预算与内容幂等

- `ready`/`no_match` 必须实际执行一次有界检索；`disabled` 由可信策略产生并显式记录未检索；`unavailable`/写入未确认
  保留 hold，允许同 trigger 的下一次真实 review 重试。
- 内容幂等（相同 trigger 复用 review 内容、不重复写 selection）与调用预算分离：每次真实工具调用仍经现有
  `workToolAccount.admit/finish`；同一真实 `tool_call_id` 协议重放不双扣；不同真实调用即使内容复用也按既有工具单元
  记账。checkpoint/review 的所有返回路径（成功/复用/拒绝/失败）都结清已 charge 的单元。
- 额度耗尽、绑定非法、durable 失败：不写受保护记录，保留责任，不伪造成功。

## 11. Host 自动轮换（C6）

- 可信配置新增 additive `work_cycle` 段（`campaign-config-1.1`）：`enabled`、`repeat_limit`、`action_window`、
  `min_distinct_routes`、`context_pressure_percent`、`max_auto_rotations`、`max_continuations`；默认 `enabled=false`。
  阈值边界沿用 §4；3/8/4/85 仍是未校准候选，只在显式启用时使用。
- 首次执行把 policy 写入 committed `runtime.note kind=campaign.work_cycle.policy`（含 digest、enabled、limits）；恢复使用
  该绑定策略。配置不同 → `work_cycle_policy_conflict`（不新增事件）；env 不覆盖已绑定策略。
- Host 只在真实 settle/committed 边界（`host.run()` 返回后）评估：
  - 仅 `review_required` 不轮换；模型在当前 Session 复核；
  - `complete` checkpoint 绑定当前单元 → 一次完成交接（identity `unit-complete:<intent event>`）；
  - 真实 `agent.settled.context_usage` 达到阈值 → 可携带未完成 hold 交接（identity `context:<source session>:<used>:<limit>`）；
  - 请求数阈值 (`max_requests_per_session`) 与上述理由合并为一次轮换；显式启用时旧阈值路径停用，避免双换。
  - 同一 boundary identity 已出现在 `handoff.completed.payload.work_cycle_identity` → 不再换；旧 Session 高水位不连锁。
- 轮换前先写 `campaign.work_cycle.boundary`（task/episode/reason/identity）；创建/预算失败时该 boundary 保留，恢复沿同一
  committed source 继续。轮换本身不消费 review、不改计数/Episode/授权/预算。
- 非终态继续：scheduler 识别 pending `hold`/`boundary`，在 accounting settled、执行许可通过时以
  `campaign.work_cycle.continued` 续接同一 Task；review-only 回合（无 broker decision）记为 boundary，不调用 Oracle。
- 只有 `waiting_external`/暂停/取消/终态不恢复探索；Task 终态不因 complete 再开 Session。

## 12. 执行边界（Broker / Experience）

- C6 `executionPermit` 在**每个** effect 边界读取最新 committed work-cycle：
  - `provider_request` 不阻断（模型必须能在当前 Session 复核）；
  - `broker_effect` 总是检查；`tool_unit` 只对非 advisory 工具检查（知识/复核/checkpoint/plan decision 等 control 工具放行）；
  - projection 失败 fail-closed。
- Broker Worker 把该拒绝分类为 `work_review_required`：记录 rejection 的 action.completed，不调用 Broker effect；Composite
  返回 `work_cycle_hold`，丢弃未执行的 buffered remainder，不调用 Oracle、不标 Task failure。
- Experience direct route 最终仍走同一 Broker permit，因此不能绕过 gate。

## 13. 引用闭环

`projectKnowledgeUsage` 从 committed 事件派生最多 3 条：
`selection → Intent 声明引用 → action.requested 的显式 source_refs → 可信 Fact 证据`。
只有 action 显式引用 selection+Intent 且独立 Outcome 引用该 action completion 时才是 `used`；仅有声明是 `adopted`；
仅有选择是 `selected`；不按时间/因果邻近推断。RAM `task.work_cycle.usage` 有界展示。
