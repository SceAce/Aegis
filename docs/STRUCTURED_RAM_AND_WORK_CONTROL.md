# 结构化 RAM 与通用候选等待

本文说明 RAM v4 working-set（寄存器视图）及通用工作控制接口；实际验证和已知限制记录在 `RAM_ABC_IMPLEMENTATION.md`。适用于文档、代码、数据处理及其他任务，不限定 CTF。普通 shell 命令和输出不做猜测性业务语义解析。

## 责任与数据

- Observer 从已提交事件机械收集工具输入、返回、transport 和引用，不调用模型总结，不读隐式推理。
- RAM 是当前 Episode 的 JSON 派生投影，不能直接写权威状态、选择路线、授予权限或认定成功。每个 turn 结束时 Observer 会写入一个有界 `runtime.note kind=round.checkpoint` Artifact；它保存本轮模型摘要/工具观察并明确标记为未验证。Board/EventLog 保留历史，RAM 只带本轮任务/子目标、规则、当前事实与相关 claim、知识参考、未决责任和最近少量工具观察。
- 模型用 `aegis_propose` 显式提交 Claim/Intent；提案保持未验证。独立 Oracle 和现有 authority 决定 Fact/Outcome。
- Runtime 的候选等待属于工作流控制。`waiting_external` 不属于 Outcome 状态，也不表示任务成功。
- 有效 Experience 继续走既有 Compiler/Router 门。候选结果与候选 Experience 是不同对象。

## RAM v4 working set（寄存器视图）

`buildRamProjection` 返回 `text`、`data`、预算、`sections` 统计和 `registers` 摘要；`text` 可以直接 JSON.parse，`data` 与 `text` 同源，`buildRam` 保持返回文本。模型看到的是按本轮子目标选择的小寄存器；Board/EventLog 仍是唯一权威历史和详情来源。

| 字段 | 含义 |
| --- | --- |
| version / episode_id / state_revision | 投影格式、所属 Episode、已提交状态版本 |
| task | **总目标 `total_goal` 始终在场**；可选 `subgoal`（最新有效 Intent，含 text/scope/ref）、Task、状态、授权/预算摘要 |
| legend | 固定的信任类别说明，防止 facts/claims/references/rules 混淆 |
| rules | 规则寄存器：工具纪律/active Experience（宪法/ROM 始终在 system 前缀，不重复注入）；`trust=rule`、`not_authorization=true`，只能来自规则来源，不能由 Claim/Reference 升级 |
| facts | 当前目标相关的有效 Fact/Refuted 工作集，`trust=verified`；Fact 与 Refuted 各自按目标相关性/新近性排序后交错选择，共享最多 6 条；保留 criterion/observed/evidence 身份，未选项留在 Board 并计入 omitted |
| claims | 与当前子目标相关的最新 1–3 条模型 Claim/Intent，`trust=unverified`、`scope` 与子目标一致；不按时间衰减，子目标切换后旧 claim 退出 |
| references | 知识卡（最多 4 张，支持综合/跨方向考点）与外部 seed；`verified=false`、`action_policy=none`；不等于事实或规则 |
| recent / referenced | 最近一次工具观察（actual input/response/transport）与合法提案显式引用的较早观察；`trust=observed` |
| artifacts / checkpoints / decisions | 一般产物、**最近一条** round checkpoint、最近经验选择；均非 Fact/规则；旧 checkpoint 留在 EventLog，不进入当前寄存器 |
| pending | 未完成、unknown、unresolved 行动责任 |
| sections | 兼容视图：仅 `total/shown/omitted` 统计；完整旧节内容不再重复进入模型 JSON，详情仍在 EventLog/Board |
| refs | 本快照的引用表；Episode 级稳定别名对应完整来源身份（可引用，不是短 ID 冒充原 ID）；`request.projected` 记录 alias epoch/count |
| meta | 完整 JSON 字符数、字符预算、遗漏、register/budget drops 与核心 overflow |

`refs` 的别名由 Observer 在当前进程内按 Episode 维护稳定注册表：同一 canonical node/event/action 在后续请求中保持同一 `rN`，不会因选择顺序变化而改指向；`source_refs` 同时接受裸别名和 `{ref_type, ref_id:"rN"}`，但别名只建立未验证关联，不授予事实或执行权。`request.projected` 和 proposal 拒绝记录 `ram_alias_epoch/count`，用于判断工具执行时使用的别名快照。别名不是 Proof，也不能替代 canonical event ID。

子目标由模型驱动：当路径变化时，模型调用现有 `aegis_propose kind=intent` 并用 `scope` 指定短标签；RAM 取最新有效非 action Intent 作为 `task.subgoal`，只展示同一 scope 的 claims。总目标始终在 `task.total_goal`，不因切换子目标而丢失。模型应在该子目标的 claim 上使用相同 scope；没有匹配 scope 时不把他目标 claim 当作当前指导。

判断选择是一个小型工作集，不是 Board 的事实副本：Fact 与 Refuted 分别按总目标、当前请求和当前子目标的词项相关性排序，同分时优先较新节点，再交错选择，共享最多 6 条。超出条数上限或字符预算的判断仍保留在 Board；RAM 的 `meta.omitted.facts` 和 `sections.facts/refuted` 明确报告未展示数量。预算不足时先缩短文案，再按既有可丢弃顺序压缩。知识卡不限制为一张，RAM 最多带 4 张当前选择，模型可用 `aegis_knowledge` 继续细化。压缩不使用 LLM 总结，不猜测业务成功。

默认预算为 8,000 UTF-16 字符，计入完整 JSON/引用/元信息，不等同 provider token 数。所有内容仍是 RuntimeState 的有限投影：不能直接写权威状态、选择路线、授予权限或认定成功。无法容纳核心时明确 core overflow；实际请求仍受原有总输入 gate 约束。

文本片段先脱敏，再机械采样 head/middle/tail。偏移单位为脱敏文本的 UTF-16 code units；不声称是原始字节 offset。采样缺口与截断必须可见，不承诺任意稀疏信息都能落入片段。原工具结果仍正常进入当前 Session continuation。缺失输出为 null，不把 digest 宣称为可读全文引用。对任何窗口化/分段读取，模型必须使用重叠窗口或已知长度并核对重建值，不能凭记忆补/丢边界字符（ROM 规则 7）。

## Work-cycle 复核门与跨 Session 工作单元

`memory/work-cycle.mjs` 是纯投影：只从当前 Episode 已提交事件与 trusted host policy 推导
`status(clear|review_required|awaiting_scoped_intent)`、原因、`trigger_id`、`work_unit_id` 和证据 refs，
不写 Outcome、不授权、不判定失败。重复路线使用已有 `arguments_digest` + 真实 `content_digest`；结果缺失
保持 unknown，不当作成功或相同结果。只有 `memory/board.mjs#permittedNodeType` 认可的 Fact（oracle/human
独立成功或满足 value/evidence/revision gate 的 verified observation）才重置“无进展”窗口。通用 bash
保持不透明，按可能有副作用路线保守计数；只读工具不计数。

停滞只表示“需要复核”。RAM 的 `task.work_cycle` 属于核心，不因预算丢弃；它展示状态、原因、bounded
evidence 别名、最近 review 的 blocker/next_step/检索状态和 handoff advisory。review/checkpoint 文本
始终标 `unverified_model_summary`，handoff 建议标 `runtime_advisory_not_outcome`。

复核流程（Observer 接线）：

- `aegis_work_review`：校验同 Episode 已提交证据，执行一次有界本地 `selectKnowledge`，先 durable 写
  `runtime.note kind=knowledge.selected mode=work_review`，再写 `runtime.note kind=work.review`
  引用该 selection。空命中/不可读/被策略关闭分别记录 `no_match`/`unavailable`/`disabled`，不宣称已检查知识。
  同一 `trigger_id` 重放幂等，不重复写 selection。
- `aegis_work_checkpoint`：记录 `continue|blocked|complete`、summary/blocker/next_step 和同 Episode 证据；
  这是未验证规划元数据，不产生 Stage/Task 完成、Fact、Outcome、active Experience 或新 Episode。
- 门控：`review_required` 期间阻断 effect-capable 工具并终止同批后续 effect；只读观察、知识检索、review、
  checkpoint、handoff 控制仍可用。`aegis_propose kind=intent` 只有在引用当前 review（或其 selection）、
  scope 非空且不同于触发 unit 时才通过；被拒绝的提案不清门。
- 轮换：checkpoint/handoff advisory 只提供建议。真实 Session 替换仍由现有 Host/Supervisor 或
  `/aegis switch` 在安全边界执行；新 Session 从同一 committed EventLog 重建 RAM，不重放 transcript，
  不重置授权/预算，审核门同样从事件重建，不能用换 Session 绕过。

### 后续实现契约：工作单元、复核消费与 Host 自动轮换

以下为用户已认可并由第二阶段实现的目标；**内部自测通过，等待独立复核/外部验收**。实现与命令证据见
[第二阶段任务书](WORK_CYCLE_PHASE2_IMPLEMENTATION_TASK.md)、[T0](WORK_CYCLE_T0_BASELINE.md#第二阶段冻结p0p1p2p3p4)、
[矩阵](WORK_CYCLE_TEST_MATRIX.md) 与 [实现报告](WORK_CYCLE_IMPLEMENTATION_REPORT.md)。

- 工作单元身份绑定同 Episode 的有效 `proposal.submitted kind=intent` **事件 ID 与 scope**。
  scope 是模型标签，不能作为唯一身份；当前单元须与 Board 的有效 Intent 视图一致。
  `work.checkpoint` 增补 `work_unit_event_id` 并校验当前绑定；旧单元 complete 保留历史，不作为新单元完成。
  complete 是可交接的模型提案，Host 仍核对未决责任与预算，不生成 Outcome。
- 分开派生“最近可信进展以来的累计尝试”与“本次有效复核后的一轮尝试”。可信进展继续复用现有
  Board/Oracle 的来源、归属与有效性契约。普通 Intent、checkpoint、轮换均不清除累计历史。
  同一 review 只可被后续第一个合格 Intent 消费一次，且必须对应该事件前缀中正在等待的 trigger；
  引用旧 review 可以建立历史关联，不能再次重开计数窗口。消费关系从原有事件重放推导，不新增权威表。
- 检索 `ready/no_match` 为已实际执行的检索结果；`disabled` 仅表示可信策略关闭，不声称检索成功；
  可记录限制后提出新 Intent。`unavailable`/写入不确认保留复核阻断，允许同 trigger 重试检索；失败记录
  不能因幂等复用而永久禁止重试。任何状态都不产生 Fact/权限。
- 复核阻断与 Session 安全是分别判定的条件。健康审计、实际 settled、请求/工具结清、预算允许且无
  pending/unknown 副作用时，可携带未完成的复核交接；新 Session 必须重建同一 trigger/消费关系并继续阻断
  effect-capable 工具。复核本身不是必须轮换的理由；上下文压力或明确交接请求可触发这种交接。
- 下一阶段先在 **C6 Host** 接入工作单元/context 策略的自动轮换；复用 Supervisor 和既有预算，策略由
  trusted Host 显式配置并绑定运行，默认候选阈值不等于已校准的全局生产策略。普通 Pi 入口仍用现有手动
  `/aegis switch`，不得从 Observer `agent_end` 直接创建 Session。完整调用链与恢复门见第二阶段任务书。
- 同一单元完成依据只自动交接一次；context 压力绑定实际来源 Session 的使用量，不让旧 Session 的高水位
  在新 Session 连续触发。轮换后的后续模型请求仍在原任务额度内，不自动扩大真实模型/网络授权。
- Campaign 的模型 checkpoint、review（含复用调用）均遵守现有 tool admit/charge/finish 协议；持久内容
  幂等与调用预算是两件事。同一真实调用重放不双扣，不同真实调用不能因复用内容而免费。副作用还须在
  Broker 最终执行边界用最新 committed work-cycle 检查，不能只依赖 Observer 的工具列表或早前模型决定。

### Experiment Host Console 管理 Session 生命周期

普通 `run-experiment.sh` 的启动语义已演进为“人启动 Host 控制台，Host 管理短 Pi Sessions”：**已实现并通过限定内部复验（`internally_verified / awaiting_external_review`）**，外部独立验收未发生。真实模型/网络/目标、TUI、普通入口独立预算账本仍未验证。实现、状态转移、测试与恢复边界见
[Phase 3 Host Console 任务书 §11](WORK_CYCLE_PHASE3_HOST_CONSOLE_IMPLEMENTATION_TASK.md#11-实现交付内部验证轮)、
[矩阵 §G](WORK_CYCLE_TEST_MATRIX.md#第三阶段experiment-console-hosthc-01hc-16) 与
[实现报告](WORK_CYCLE_IMPLEMENTATION_REPORT.md#第三阶段普通入口常驻-console-host实现报告)。

设计约束：

- 常驻 Host 是普通 experiment 的生命周期所有者；真实 EventLog/Task/Episode、授权/预算、Board 和 work-cycle reducer 仍是权威。Pi Session 是短上下文工作窗口，不能作为新尝试或预算重置。
- 启动门由 trusted Host 绑定（`AEGIS_WORK_START_GATE=on`，`memory/work-cycle.mjs#workStartGateEnabled`）；独立交互入口默认关闭以保留历史行为。启用时，新 Task 的工作单元尚未建立（派生 `unscoped`）只允许 read-only observation/knowledge/tool lookup/`aegis_propose kind=intent`（scope 非空）；**任何 effect-capable 操作必须等一个非空 scope、通过现有 Proposal ref/effective gate 的 scoped Intent durable 提交后**，并在最终执行边界（Observer admission 与 Broker/Campaign permit）再次检查。并行工具调用不能越过这个顺序门。
- 遇到旧 Episode 已经 stall、却没有 unit 身份时，使用明确标记的 bootstrap review：绑定既有 trigger/evidence/真实知识 selection，不伪造 Intent 或 work-unit event ID。之后第一个有效 scoped Intent 必须引用该 review；accepted 后仅消费一次并开启首个单元。
- settled 只让 Host 检查状态，不等于失败、成功、轮换已发生或可继续 effect。有效 review 的 hold 可在健康审计、真实 settled、请求/工具结清、无 pending/unknown 副作用且预算允许时随真实 replacement Session 携带；replacement 仍有相同 hold。
- 新 Session 重用已提交的 review、knowledge selection、Intent/consumption、计数和 RAM；不重复做同一次 review/检索，不重发已有 action。只有新 committed stall evidence 才建立下一 review trigger。Hold 连续触发但没有 review/Intent progress 时，Host 按冻结上限停止并报告，不无限开 Session。
- Observer 负责当前 Session 的 tool/hook/projection；不在 `agent_end`/`agent_settled` 自建 Session。Host 调现有 SessionSupervisor，绑定 request/source/replacement identity，并在真实预算/settle/ownership检查后才 completion。
- 在完整 hash-chain EventLog 上可复用已验证的 prefix checkpoint（`memory/projection-checkpoint.mjs`）：绑定 event offset/末尾 id+digest/逐行 prefix digest/task/episode/policy+config digest/reducer+projection 版本。它只是派生缓存；与 full replay 必须对所有授权、hold、consumption、双计数、pending、budget、handoff 和 Task 状态得出一致结果。任一项不匹配、缺失、外域、篡改或版本未知就 full replay；有 committed tail 时用同一组 reducer 重放，不声称 O(1)。缓存不能清 hold、授予权限或改变预算。
- Process 重启后先检查 ownership、chain、frozen policy、pending/unknown、staged handoff/attempt 和预算；通过现有 recovery 协议后才可派发下一 request。staged JSON/新进程 Session 本身不是 Host attempt。
- 该设计只新增普通入口的 Host loop，不将 Campaign Stage/TaskOracle 语义硬套到 Experiment，也不另造 Session manager、EventLog 或预算账本。

## 生命周期与注入契约

RAM 没有独立的持久生命周期；它是一次 provider 请求的临时快照：

1. `context_with_system` 在每次实际 provider 请求前，从当前已提交的 EventLog/Board/RuntimeState 重建一次 RAM。它不是每个用户 prompt 或每个 turn 固定生成一次。
2. 同一 turn 内，工具结果、模型提案或其他已提交状态进入下一次 provider 请求前，生成新的 RAM；没有新的 provider 请求就不单独生成快照。
3. 快照绑定当前 `Task/Episode`、`state_revision`、Board digest 和 RAM digest。Session 轮换/恢复不复用旧 RAM，而是从同一 Episode 的权威状态重建；轮换不重置预算或责任。
4. RAM 以一条临时 user 尾部消息注入，位于完整 transcript 和 tool result 之后；固定 system/ROM/tools 不因 RAM 改变。Pi 恢复原 transcript 后，RAM 不进入 Session 历史，也不在请求之间累积。
5. 当前快照只读。它不能写 Board、产生 Fact/Outcome、授予授权或替代执行前的最新 permit。`request.projected` 只记录本次 provider-bound 输入的投影元数据，不成为下一次 RAM 的输入。
6. 只有**核心工作集**（task/pending/授权/预算和固定 bookkeeping）在丢弃全部可选寄存器后仍超出预算，投影才设置 `core_overflow=true` / `overflow=true`；Observer 记录 `provider_bound=false`、`refusal_reason=ram_overflow` 后中止该 provider 请求。不得把不完整 RAM 当作完整上下文继续推理。可选内容（知识、checkpoint、工具历史、claims、discipline 等）超预算时按优先级丢弃并在 `ram_sections`/`meta.omitted` 中公开，不中止请求。footer（`overflow`/`core_overflow`/sections/计数）计入同一字节预算；`meta.pad` 是固定宽度占位，避免写入 footer 时反向改变压缩结果。正常快照记录 `provider_bound=true`。Campaign provider gate 另外检查完整请求窗口：ROM + 工具定义 + RAM + 当前历史 + prompt + 输出预留。

注入是按 provider 边界更新，不按 timer、固定 turn 数或工具调用数更新。Board/EventLog 继续保留完整状态；RAM 只携带当前目标的有限邻域。UI 或 handoff 可以读取同一投影，但不建立第二套 RAM 状态。

`request.projected` 同时记录 `ram_sections` 统计和 `ram_registers`（子目标、各寄存器数量与 omission），供日志分析；UI 可后续读取同一投影，不需要第二套状态。

本地知识文件统一位于 `$AEGIS_HOME/knowledge/`（仓库无 `knowledge/`）；自动召回、LLM 自主选择工具、搜索回退、图板关联与调用时机见 [知识库运行接口](KNOWLEDGE_RUNTIME.md)。轮次 checkpoint 与 RAM 历史压缩的接线见 [图板/seed 先导结果](BOARD_SEED_CTF_PILOT_RESULT.md)。

## 显式提案

`aegis_propose` 的 source_refs 接受当前 Episode 的已提交 event/node/action 身份；引用只建立关联，不证明提案正确。foreign、future、缺失、摘要不符和失效引用被拒绝。

可选 `replace_event_id` 只能替换当前 Episode 中已被接受且仍有效的模型 Hint/Intent，不能替换 Fact/Outcome。原事件保留，当前视图退出旧提案。普通助手正文不会自动调用这个接口或形成提案节点。

## 可信任务契约

交互运行可通过 `AEGIS_TASK_CONTRACT_FILE` 指定本地 JSON。字段由人类/Host 配置，不能来自模型提案。首次进入 Episode 时绑定已提交事件；恢复不能借可变文件扩大策略。Campaign 使用当前被接受任务定义中的目标与 criteria，并保留其原有计费、授权和请求结清门。

通用配置示例：

```json
{
  "target_ref": "report.md",
  "criteria": ["report reviewed"],
  "allowed_tools": ["read", "write", "edit", "bash"],
  "max_tool_calls": 40,
  "max_identical_calls": 2,
  "wall_time_ms": 600000
}
```

次数是示例，必须按任务配置，不是全局固定“两次”。计数按真实工具调用和完整参数摘要进行；不能从任意 shell 脚本中可靠得知其内部请求数量或识别“爆破”。要求严格动作/请求级约束的场景应使用已有注册工具/适配器与授权门。未配置契约时不臆造目标或阈值，候选提交明确拒绝 unconfigured。

## 候选提交与等待

模型显式调用：

```json
{
  "target_ref": "report.md",
  "criterion_id": "report reviewed",
  "evidence_event_ids": ["实际已提交的当前 Episode 动作结果事件 ID"]
}
```

工具名为 `aegis_submit_candidate`。Runtime 解析真实成对动作结果，核对目标/criterion/当前身份，确认持久化后进入 waiting_external。它提交的是引用所指结果的待验收候选，不验证其业务正确性；不扫描输出文本或答案格式。重复同候选不会二次改变状态；被复核过的相同候选不能靠新 ID 自动重新提交。

等待期间阻止新的探索与 Broker 效果，重启不解除等待，也不自动重发旧动作。模型同批其他工具结果按真实已发生效果保留，不能回滚已发生副作用或假称完全未执行。任何允许的最小验证都必须来自可信契约中的明确只读工具及完整参数绑定，不能把自由 bash 当作可证明只读的工具。

交互命令：

- `/aegis autoRemote`：两步登录 bootstrap。第一次接收平台 URL 并打开专用 Firefox 登录页；人类手动登录后再次执行该命令，从专用 Firefox profile 读取 cookie 到当前进程内存，附着受控 HTTP client。不接收/保存账号密码或 cookie 原文；`aegis_remote_request` 仅开放平台 GET API，Cookie 由本地 broker 注入且不返回模型；`POST`/flag 提交仍由后续 adapter/checker 所有。
- `/aegis checkFlag`：人类显式确认当前打开任务的 flag 正确；不接收/保存 flag 值，使用现有 `resultToOutcome` human source 记录 Outcome，重复执行幂等；要求 open episode 和健康审计。
- `/aegis work-status`：查看有界的工作控制状态。
- `/aegis work-verify {"tool_name":"read","args":{"path":"report.md"}}`：交互模式中，不调用模型，只执行契约精确登记的只读验证；仍保持等待。
- `/aegis work-resume <原因>`：用户显式要求继续。
- `/aegis work-reject <原因>`：用户否定该候选后继续。

`work-verify` 只支持已登记的本地 read 参数与 workspace 内真实路径，并记录真实 intent/result；Campaign 命令没有 provider-request 绑定的工具计费上下文，因此该命令在 Campaign 中明确返回 unsupported，不另开绕过原 ledger 的执行通道。Campaign 的 Host CLI `resume` 可以显式恢复候选等待，继续原任务；原队列与本次工作流状态分别展示。

新建 Campaign 运行使用既有 durable tool-charge 协议，候选工具也必须完成原 request 结清、charge 与 finish。旧 legacy 账本的执行恢复明确返回 `migration_required`，保留历史消费和只读 status；本轮不自动迁移或改写旧事件。

恢复保留原预算消费、未决责任和事件来源。pending/unknown 副作用或未结清请求/工具先核对，不能用恢复命令重发。平台/人类认可的最终 Outcome 仍走现有独立结果录入，不由 resume 生成。`/aegis checkFlag` 是其中的人类确认入口：它只表达“人已确认正确”，不解析自然语言、不接收 flag 值，仍经过现有 human Outcome 门。
