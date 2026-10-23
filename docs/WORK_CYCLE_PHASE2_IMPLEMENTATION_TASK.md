# Work-cycle 第二阶段：修复核心边界并接通 C6 跨 Session 解题闭环

状态：**用户已同意本阶段设计方向；待 DS 实现与验证。不是代码已完成或外部验收通过。**

目标：在同一 C6 Task/Episode 内，完成“当前工作单元 → 尝试与停滞 → 复核检索 → 下一单元 → Host 安全自动轮换 → 新 Session 继续”的完整产品路径。修复 F1/F2，随工作单元语义收敛 F3；不等待全仓库所有问题清零才推进。

## 1. 依据、当前基线和范围

执行者先按根 `AGENTS.md` 加载 [固定规则](DEVELOPMENT_RULES.md)，遵守 [开发规范](AGENT_DEVELOPMENT_STANDARD.md)、[测试规范](AGENT_TESTING_STANDARD.md)、[Git 规范](GIT_STANDARD.md) 及实际目标路径沿途的 `AGENTS.md`。本文件是任务书，不创建新的开发规范。

行为契约继续使用 [RAM/工作控制接口](STRUCTURED_RAM_AND_WORK_CONTROL.md) 的“后续实现契约”、[Campaign 契约基线](CAMPAIGN_CONTRACT_BASELINE.md)、[架构 §3.3](CAMPAIGN_ARCHITECTURE.md#33-host-level-session-rotation)、[C2 轮换契约](C2_SESSION_ROTATION_TASK.md)、[知识接口](KNOWLEDGE_RUNTIME.md) 及按需相关的 [MEMORY_SCHEMA](MEMORY_SCHEMA.md)。当前用户认可的本阶段细化优先于第一阶段未决/advisory 限制；不改变 Outcome、Episode、授权或独立证据门。

起始交付为分支 `feat/work-cycle-session-handoff` 上基于 `d84b692` 的**未提交工作树**，嵌套 Pi 报告 HEAD `2ba451d99`。开始时核对真实 HEAD/status/diff，保留其他工作，不能假定已干净或切回旧 HEAD。`Pi_Agent_base/UI/` 是用户独立未跟踪目录，本任务禁止读取、修改、暂存、删除或重置。内嵌 Pi 核心不改、不升级、不装依赖；使用 SDK 前按规则完整读实际相关文档/例子并核对签名。

第一阶段 [任务书](WORK_CYCLE_AND_SESSION_HANDOFF_IMPLEMENTATION_TASK.md)、[T0](WORK_CYCLE_T0_BASELINE.md)、[矩阵](WORK_CYCLE_TEST_MATRIX.md)、[内部报告](WORK_CYCLE_IMPLEMENTATION_REPORT.md) 是历史实现依据。内部自测通过不等于独立验收。本阶段更新既有矩阵/报告、保留先前证据，避免每个小修重复建报告体系。

| 范围 | 本阶段承诺 |
| --- | --- |
| C6 Host + SDK + faux | 必须接通同 Task/Episode 连续工作、两次有效复核、两次真实自动轮换、一次中断恢复 |
| 普通 run-aegis/run-experiment/run-pi | 保持共享 reducer/gate/checkpoint 修复；保留现有人工 `/aegis switch`；未实现自动 Host 时如实写明 |
| 停滞与预算 | F1/F2 是自动化前置；F3 随当前单元绑定一起修复 |
| 知识/Experience | 追踪选择、声明采用、实际 action 引用、独立结果；不放宽 Experience gate |
| 后置 | 普通入口自动 Host、事件缓存优化、新 UI、新全局技能评分、真实 solve-rate 对照 |

本轮仅授权 DS 编码、隔离的本地离线/faux 测试和文档更新。当前仍不暂存/提交/push；最终留可审查 diff，除非用户后续明确改变。不得调用真实模型、真实网络或目标环境。自动轮换的后续请求仍受原运行授权和预算，本轮用 faux 证明其执行。

## 2. 独立复核发现与责任顺序

完整本地证据：`Pi_Agent_base/runtime/dev/work-cycle-independent-audit/review.md`；该目录 ignored，不能作为唯一可迁移验收资料。以下序列足以重新构造测试，正式回归放现有 `tests/`。

| ID | 可复现序列与实际错误 | 责任 |
| --- | --- | --- |
| F1 | A 停滞 → review R → Intent B 引用 R → 实际 action 一次 → Intent C 再引用 R；action_count 从 1 变 0，review 仍只有一条。真实 SDK 已复现，可反复在阈值前清零 | 第一优先，复核消费 |
| F2 | 真实 C6/SDK 调用一次 `aegis_work_checkpoint`，成功写入 checkpoint，但无该调用的 `c6.tool charged/finished` | 第一优先，既有工具账本 |
| F3 | Intent A → A complete checkpoint → Intent B；当前 B 仍收到 `work_unit_complete` 建议 | 单元身份/当前视图接线时修复，自动化接通前完成 |

本地复现命令（审查时均 exit 1，断言揭示上述缺陷）：

```sh
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/runtime/dev/work-cycle-independent-audit/old-review-sdk.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/runtime/dev/work-cycle-independent-audit/checkpoint-campaign.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/runtime/dev/work-cycle-independent-audit/stale-checkpoint.mjs
```

复核独立复跑通过第一阶段 pure/RAM/SDK 三脚本、module-layout 与 diff check；未独立复跑 required 68、Biome、类型基线。报告中的 68/8 scripts 和类型差异仍属于 DS 提供证据，不改写为外部验收结果。

## 3. 已认可的架构与接口细化

### 3.1 工作单元由有效 Intent 事件定义

- 当前单元以同 Episode、已接纳、当前有效的 `proposal.submitted kind=intent` 确定。复用 Board 的 effective/replacement 规则，禁止 reducer 任取最新原始行而与 RAM 子目标矛盾。
- 单元身份为 `{ work_unit_event_id, work_unit_id: scope }`；scope 是标签，事件 ID 区分不同声明。空 scope 不获得工作单元完成语义。换 scope/新 Intent 不代表可信进展。
- checkpoint 写入时由 Runtime 绑定当前 Intent 事件；模型可提供引用以校验，不能指定 foreign/obsolete/arbitrary unit。重复 scope 也不能将旧 complete 套到新 Intent。
- checkpoint `continue|blocked|complete` 是模型规划声明，保留 `trust=unverified_model_summary`；complete 表示请求结束本单元/适合交接，Host 再核对实际安全状态。可结束一次无收益实验，不等于成功。
- 当前 checkpoint 必须在当前 Intent 之后，引用其确切身份，且通过既有有效性规则；历史 checkpoint 仍可审计，不作为当前完成。
- 新 Intent 若在一个尚未执行的自动交接建议后改变当前单元，Host 从最新 committed prefix 重新评估，取消过期完成理由；不得按旧缓存轮换。

additive payload 示例（现有 `runtime.note`，不是新事件类型）：

```json
{
  "kind": "work.checkpoint",
  "version": "work-cycle-1",
  "work_unit_event_id": "evt-intent-B",
  "work_unit_id": "unit:encoding-probe",
  "unit_status": "complete",
  "model_claim": {
    "summary": "完成一次编码边界比较，业务判断仍待独立验证",
    "next_step": "按观察选择下一种编码"
  },
  "evidence_event_ids": ["evt-action-request", "evt-action-complete"],
  "trust": "unverified_model_summary"
}
```

不改 event schema major，不新建 work-unit 权威表。旧无 `work_unit_event_id` 的 checkpoint：只在同 Episode 较早前缀能唯一解析出匹配的有效 Intent 时派生绑定；否则保留历史并明确 unbound，不触发完成轮换。迁移不改写历史事件。

### 3.2 复核消费与两种计数

从同一 EventLog 派生，允许纯 reducer 内部有临时状态，不引入另一个持久状态机：

| 含义 | 重置/前移条件 | 不得造成的效果 |
| --- | --- | --- |
| 最近可信进展以来的累计尝试 | 现有可信进展契约认可的事件 | review、Intent、Session 轮换不能让该历史消失 |
| 当前复核轮次的尝试 | 可信进展，或当前 trigger 对应的一次合法 review 消费 | 旧 review、多次引用、新 scope 本身不能重新获得一轮尝试 |

- 重放按因果前缀处理。产生 trigger 后保存其稳定证据身份；日志噪声不改 trigger。已发出的 action 结果仍须真实结清，不能丢弃以固定 trigger；若有新证据，只能按冻结的确定性规则形成/更新当前触发，旧 review 不自动覆盖新证据。
- review 必须绑定当时活跃的 trigger、Episode、触发单元事件和实际 retrieval selection；选择记录的 mode/trigger/顺序一致，引用需可解析。
- 只有之后第一个通过 proposal/ref gate 的新 scoped Intent，可消费这个 review/trigger。复用同一 review 返回内容可幂等，但不能重复产生窗口前移。
- `source_refs` 仍可引用旧 review 作为历史关联；当无 active hold 时可接纳合法的普通 Intent，但不改变累计/轮次计数。active hold 时必须引用当前可消费 review，不能用旧 review 代替。
- 一个 Intent 同时引用旧 review 和当前 review 时，仅消费匹配当前 trigger 的那条。拒绝提案、不完整记录、foreign/future refs、重放重复、跨 Session 均不能清门或增加额度。
- 可信 progress 用同一 Board/Oracle 有效归属判定，包含 Campaign judgement 需要的规范适配/Manifest 上下文；不能只用原始 `source:oracle` 或在 reducer 新写弱判定。
- 累计计数用于暴露“多轮探索仍无可信进展”；本阶段不增加未定义的“复核 N 次自动失败”或自动 Outcome 规则。轮次计数用于既定重复/多路线复核门，合法消费后不因旧累计值立即再次触发同一门。

核心算法意图（伪代码，必须复用现有验证 helper；不是可直接粘贴的 API）：

```js
for (const event of committedPrefix) {
  applyEffectiveIntentAndProgress(event);
  updatePairedActionsAndActiveTrigger(event);
  acceptReviewOnlyForCurrentTrigger(event);
  if (isAcceptedIntent(event) && citesCurrentUsableReview(event) && !alreadyConsumed(review)) {
    deriveConsumption(review.event_id, event.event_id);
    advanceReviewRound(event.event_id); // 不改 sinceTrustedProgress
  }
}
```

旧日志重放：仅能在当时前缀证明合法的首次消费有效；后续引用同 review 留关联，不前移窗口。若旧代码此前曾错误解锁，重建后可以恢复 hold，明确诊断，不修改历史、不自动重发动作。

### 3.3 检索失败与重试

- `ready`、`no_match` 都需实际执行一次有界检索；空命中公开，不伪称有知识支持。
- `disabled` 由可信策略产生，明确记录未检索，可连同限制说明提交下一 Intent；不得由模型传 disabled 来跳过。保持第一阶段该显式行为，不强开网络。
- `unavailable`、selection/review durable 未确认：保留 hold。下一次同 trigger review 允许重试真实检索，不能幂等返回失败记录而永久卡死。之前失败保留历史；使用最新完整可用 review，由确切消费关系决定后续行为。
- 复核成功写入后的重复调用复用内容，不重复 retrieval selection；但每个新真实模型工具调用仍按 §3.4 记账。

### 3.4 调用预算与内容幂等

- checkpoint/review 必须通过现有 Campaign 绑定的 `workToolAccount` admit/charge/finish。没有 account、调用绑定非法、预算不足或 durability 不确认，拒绝受保护操作；不造另一份计数器。
- 同一真实 `tool_call_id` 的协议重放不双扣；不同真实调用即使读取相同 review，仍按既有工具单元规则记账。内容只落盘一次与调用已消费额度分别报告。
- 成功、复用、拒绝与失败的结清方式遵守原 ledger 契约；明确 admission 前拒绝与已经 charge 后失败的区别，不遗漏 outstanding 单元。
- checkpoint append 失败不伪报成功；review selection 已落盘而 review 失败仍保留责任，重试不冒用未完成的调用。
- 普通入口没有 Campaign 账本时遵守其已有工作预算；不能为了统一而新增默认无限额度或新 ledger。

### 3.5 携带阻断状态的安全轮换

Session 安全与复核是否完成分别判定。review hold 本身不等于未决副作用，不应在 context 耗尽时造成无法交接的死锁。

| 实际状态 | 是否可换 Session | 新 Session 行为 |
| --- | --- | --- |
| 无 pending/unknown，审计健康、请求与工具结清、预算允许；当前单元 complete | 可信 Host 策略启用时可自动换 | 保留完成依据，继续下一工作单元，不再为同依据换第二次 |
| 满足相同安全条件，context 压力达 trusted 阈值，review 未完成 | 可自动安全交接 | 恢复同 trigger/证据/消费状态，只允许观察、检索、review 等已有门允许操作 |
| 仅 review_required，无 context 压力/完成/显式交接理由 | 不自动换 | 在当前 Session 复核，避免用轮换代替规划 |
| action pending/unknown、请求/工具记账未结清、审计不可用或额度耗尽 | 拒绝 | 保留恢复责任，不能创建“干净”执行窗口 |
| waiting_external、暂停、取消、终态 | 服从现有工作控制/Host lifecycle | 不因轮换自动恢复探索或自动发下一次模型请求 |

轮换不消费 review、不改变两个计数、不修改 Episode/授权/累计预算。新 Session 的 `handoff.completed` 和第一个 provider-bound RAM 可交叉核对；创建/绑定/完成持久化失败保持可解释恢复状态。

### 3.6 自动化策略、幂等与支持入口

- **先接通 C6**：通过现有配置校验/冻结输入增加可选 trusted work-cycle 自动轮换策略。具体字段路径由 DS 在 T0 核对现有 config 后冻结；本文件不编造已存在配置。新策略显式启用并写入当前运行绑定，默认旧配置不额外轮换。无需再次请示已批准的能力方向。
- 复用集中候选值 `3/8/4/85%` 作为隔离测试/显式启用策略的初始参数，公开未校准。它们不自动成为全局生产默认。跨恢复使用已绑定的有效策略；环境变量/配置文件变化不静默改变现有 trigger/窗口，沿既有配置更正/重新绑定流程处理。
- 请求数阈值继续兼容现有 `max_requests_per_session`。多个理由合并为一次 Host 轮换，不双记 Session；Task 已终态或无待继续工作时不为“complete”再开无用 Session。
- 完成理由的幂等身份绑定 Task/Episode + 当前 Intent + 完成 checkpoint/边界，从现有 handoff 请求/完成记录派生；同单元同完成边界只自动交接一次。重复 complete 换 event ID 不能无限换 Session。context 理由绑定真实来源 Session 与 usage snapshot，不复用旧 Session 高水位。
- context 使用真实 API tokens/window；unknown 不当作零或超限，不用 RAM 字符转换。允许在 request gate 发现下一请求将超限时返回给 Host 处理的受控状态，但不得先发超限请求，也不能在 hook 内直接替换 Session。
- 自动 continuation 不重放旧 transcript，沿现有 Host 请求/工具预算。预算不足或创建失败时不给无限自重试；明确 blocked/recovery 所需步骤。
- 所有 stage/newSession/rebind/completion 仍走现有 Supervisor。Observer 只记录/投影/提供信号；`agent_end` 单独出现不能证明真实安全结清。

### 3.7 C6 执行边界必须覆盖 Broker

当前 Observer gate 不足以覆盖 Host 已缓冲的计划、Experience direct route 或 Broker 批量动作。C6 是本阶段主入口，需沿真实调用点补接：

1. 复用 `createCompositeWorker`、model worker、`permitEffect`、Broker 当前执行许可，不另造调度器。
2. 计划中每个 effect 在最终执行边界读取最新 committed work-cycle。第 N 个 action 完成后触发 review，第 N+1 个不能因为早前已接受整批计划就继续执行。
3. 阻断属于待复核/待继续的工作控制状态，不调用失败 Oracle、不假结束 Task、不当作可盲目重试的 transport error。尚未执行计划不得跨 review/replan 默认继续；已发生效果保持真实事件，不回滚或重发。
4. 同 Task 内，Host 在实际请求/工具/Broker 都结清的边界处理 checkpoint/context/待复核，并能再次调用模型继续原 Task；不能只依赖 Task 结束后的 `onTaskSettled`，否则解决不了单个难题的多 Session。
5. 若现有 worker 一次只能返回终态，作最小的现有接口扩展，明确中间返回值和 consumer；沿用 EventLog、预算和 Task 身份，不新建第二套权威调度状态。
6. Host/Experience 自动执行亦服从 work-cycle gate；active Experience 不是免复核执行许可。

## 4. 任务顺序与文件职责

| 任务 | 交付/改动范围 | 依赖 |
| --- | --- | --- |
| P0 基线与可执行 red | 核对 dirty ownership；移植 F1/F2/F3 正式回归，记录旧行为 exit/log；在现有 T0/矩阵记录接口、迁移、配置与支持入口 | 无 |
| P1 单元/复核 reducer | `memory/`：effective Intent 绑定、一次消费、累计/轮次投影、当前 checkpoint、检索重试；含跨 Session/replay/ref 校验 | P0 |
| P2 工具与预算 | `extensions/` 接线 + 原 ledger：checkpoint/review 所有调用路径结清、ref/alias 解析与新字段校验；不在扩展复制 reducer | P1 |
| P3 Host 安全与幂等 | `session/` + 现有 C6 config/Host：carry hold、策略冻结、真实 context 归属、一次完成交接依据 | P1/P2 |
| P4 同 Task 完整路径 | `campaign/`、必要 `execution/` 调用点：Broker 最新 gate、非终态继续、原预算内 automatic continuation，真实 C6/SDK 两轮 | P3 |
| P5 有界引用闭环 | Board/RAM/报告：选中知识/Experience → Intent 声明采用 → action 显式关联 → 独立结果；未观测使用标 unknown | P4 |
| P6 验收交付 | 聚焦 + 受影响 SDK/C6/C2 + required + 静态差异，更新已有报告/矩阵，交回审查 | P5 |

P0 完成后，对已认可的 additive 字段与最小现有接口接线自主推进，不以“字段名还没指定”为由停止。并行协作须划分不重叠路径，共享接口由主 DS 集成。只有超出 §1 授权、需要修改 Pi 核心/依赖/Outcome 语义/权限/独立证据门时，暂停相关部分说明具体冲突；其余工作继续。

## 5. 核心接线示例与引用要求

下例是职责伪代码，实际 SDK/Host 签名必须核对当前源码：

```js
// Host 已有的“可继续原 Task”路径，在真正 settled/committed 后调用。
const snapshot = replayCommittedWithFrozenContext();
const cycle = projectWorkCycle(snapshot.events, task.episode_id, snapshot.policy);
const reason = evaluateCurrentBoundary(cycle, sessionUsage, completedHandoffs);
if (reason.rotate) {
  if (!existingSafetyAndBudgetPermit(snapshot)) return retainBlockedResponsibility();
  const rotated = await existingHostRotationPath(reason); // stage → Supervisor → rebind → completed
  if (!rotated.applied) return retainRecoveryResponsibility(rotated);
}
if (taskStillRunnable() && originalBudgetAllowsRequest()) {
  await continueSameTaskFromCommittedRam();
}
```

```js
// 原 Broker effect permit 的附加 hold，不能替代授权/资源版本/写前意图检查。
const cycle = deriveFromLatestCommittedPrefix();
if (cycle.review_required) return existingBlockedContinuation("work_review_required");
return originalAuthorizationAndBudgetPermit();
```

引用闭环：selection/Experience decision 只证明候选被选择；Intent 引用只证明声明采用。实际 action 必须通过已校验的现有来源引用/结构化关联才能记“使用”，对应 Outcome 再经原 Oracle/resolver 校验。没有明确 action→Intent/selection 关联时记录 unknown，不按时间邻近推断。优先复用已有 refs/usefulness 解析，不新增模型可授予 authority 的字段或评分系统。

交接最小 view 可携带当前 Intent event、checkpoint、trigger、review、consuming Intent、知识选择和 action refs，以及绑定策略版本/digest；包是派生物。篡改 JSON 不能清 gate，真实新 Session 仍从 committed 源重建。模型声明、参考、观察、独立判断分别保留信任类别；RAM 核心优先级沿现有契约，不塞完整 transcript。

## 6. 冻结 required 验收矩阵

每项在既有矩阵写精确 command/exit/log、输入来源、预期、实际产品入口；新测试先在当前交付上记录有意义 red，import 缺失不算行为 red。第一阶段正确断言保留。

| ID | 必须观察到的结果 | 层次 |
| --- | --- | --- |
| P2-01 / F1 | review R 消费一次后，未到阈值的普通 Intent 再引用 R，累计与轮次 action_count 不清零；循环换 scope 仍触发新 review | pure + real SDK/faux |
| P2-02 | 旧 review+当前 review 混合 refs 只消费当前一次；foreign/future/无 selection/错 trigger/重复 replay 无法清门；新 review 正例能继续 | reducer + proposal |
| P2-03 | 合法 review 开新轮但累计尝试保留；跨 Session、重启重放计数和 consumption 一致；真实可信 progress 按原 gate 重置，无伪造 Fact | reducer + reconstruction |
| P2-04 / F3 | A complete→B、同 scope 不同 Intent、旧/被替换 Intent checkpoint 不使 B 完成；工具拒绝任意旧 unit；当前绑定正例有效 | pure + RAM + SDK |
| P2-05 / F2 | 实际 C6 入口 checkpoint/review（含内容复用的新调用）均有原 ledger 对应 debit/finish；额度 0 不写受保护记录；同真实调用恢复不双扣，append/finish 失败保留责任 | C6 product + failure |
| P2-06 | ready/no_match/disabled/unavailable 分别走真实工具路径；unavailable 保持 hold，资源恢复后同 trigger 可检索并清门；内容重放不重复 selection | SDK/faux + local filesystem |
| P2-07 | context 压力+review hold+已结清允许换，真实新 Session 首请求仍同 trigger/hold/计数；effect 被拒而 read/review 可用 | real Host/SDK |
| P2-08 | pending/unknown effect、未结清 request/tool、预算不足、审计不可用均不新增 Session/假 completion；实际恢复后可继续且无重发效果 | Host + recovery |
| P2-09 | 显式启用策略后当前 complete/context 在同 Task 中自动触发；同完成依据一次，旧 context 高水位不链式触发；多理由只换一次 | C6 product |
| P2-10 | 从真实 C6 入口在同 Task/Episode 完成至少两次不同 trigger 复核、两次真实自动 Session 替换；source Session/对象/context/file/id 可核对；普通入口仍准确标手动 | full integration |
| P2-11 | 至少一次因明确故障点中断后，从同 committed 源恢复；completion/Session 消费/工具 charge 不双记，旧 review 不再消费，未执行计划不自动重发 | recovery integration |
| P2-12 | Broker 已缓冲多动作时，阈值后下一 effect 被最新 gate 阻断；Experience direct route 也不能绕过；保持 Task 可继续而非伪失败 Outcome | C6/Broker integration |
| P2-13 | 知识选择确实进入新 Session 的 provider-bound RAM；采用声明/实际 action 引用/独立结果分别有可解析 refs；无证据不称 used/useful | request + event/result |
| P2-14 | 新策略未启用时现有配置行为兼容；恢复沿已绑定策略，修改 env/可变缓存不静默清 trigger；unknown usage 无虚构 token 值 | config + replay |
| P2-15 | waiting_external/暂停/取消/终态不因自动交接恢复探索；Task 终态不为 complete 空转新 Session；预算不允许 continuation 时明确停止 | Host lifecycle |
| P2-16 | 新单元/复核 refs 在 RAM 有界，pending/auth/budget 核心保留；派生 handoff/checkpoint 被改动不能赋权/清门；Outcome/Experience 独立性不变 | RAM + negative |

P2-10 必须实际走产品 Host 自动判定与调用，不可测试手动 `supervisor.rotate()` 冒充自动化。优先沿已有 C6 SDK/faux 测试构造同 Task 多次尝试，不能以两个静态 Task 各结束一次代替单难题连续性。

P2-11 选一个影响新增链路的实际 barrier/故障点，复用既有 C2/ledger 故障设施即可；不要求全新故障全组合。四臂真实任务效果对照仍 deferred，性能/缓存不作为本阶段硬门。新发现仅在证明当前核心承诺无法成立时加入 blocker，其余保留责任阶段，继续主线。

## 7. 命令、报告与完成标准

从仓库根运行既有 pure、RAM 和 SDK 脚本；新用例命名由 DS 按实际职责选择并登记，不在此假装已有文件：

```sh
node Pi_Agent_base/tests/aegis-work-cycle.mjs
node Pi_Agent_base/tests/aegis-work-cycle-ram.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-work-cycle-sdk.mjs
```

随后运行受影响的 C6 产品/ledger/Broker、knowledge-campaign、C2 handoff/rotation、Observer failclosed、RAM SDK 回归。聚焦通过后按现有 required 清单运行一次 `tests/helpers/run-required.sh`；新 required 用例须列入本阶段 runner/矩阵，原 68 全绿不能替代新增验收。Biome 用现有配置，类型检查报告实际 exit 和按文件内容的新增/既有差异；依赖/目录变化检查 module-layout。日志置 ignored runtime/dev，避免覆盖前一轮证据。

更新第一阶段 T0/测试矩阵/实现报告时加本阶段章节，保留第一阶段执行时间、命令与独立审查结论，不倒改旧通过记录。将已接受设计、实际实现、内部验证和外部验收分别标记。报告至少包含：

1. F1/F2/F3 的 red→green 命令、产品证据与引用位置。
2. 当前单元/消费关系/两个计数、旧日志绑定与策略恢复语义。
3. C6 同 Task 两轮自动化与一次恢复的 action/request/Session 顺序、实际账本数字和 source refs；正负例均有。
4. 各入口支持表：C6 自动策略是否已接通；普通入口仍为手动；未知 token/未实现项如实写。
5. 当前可达 blocker、non_blocking/deferred 及复评条件；禁止用缓存/真实收益未测扩大冻结验收。
6. 精确分支、HEAD、未提交/未暂存状态、嵌套 Pi 状态，确认 UI 未触碰。标 `internally_verified / awaiting_external_review` 后交回，不自行声称外部通过。

本阶段完成表示 C6 的完整机制链路成立；不表示真实任务解题率已经提高、不代表所有入口自动化完成。
