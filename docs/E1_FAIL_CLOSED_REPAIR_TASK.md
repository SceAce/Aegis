# E1 Fail-Closed Repair：Outcome 事实绑定与 Plan Replay 身份链

状态：`changes_required`。这是进入真实 CTF pilot 前的最后一轮小范围正确性修复任务。

基线：当前分支 `feat/c6-agent-product`，启动时必须记录实际 `HEAD` 和工作树；已知正常链验收结果为 E1 `17/17`、观察修复 `6/6`、C6 `18/18`、回归 `26/26`、Biome 通过，Campaign TypeScript 仍有既有诊断但修改文件不得新增诊断。

本任务只处理两个可复现的 fail-open 缺陷：

1. 缺失或无法证明归属的 Campaign Oracle 结果仍可能投影为白板 `Fact`。
2. 无来源或身份不一致的 `campaign.plan.admitted` 在 replay 时仍可能建立动态任务。

在这两个问题闭合并完成独立复验前，不进入真实 CTF、靶场或付费 provider。

## 1. 目标与非目标

### 1.1 目标

从同一份 Manifest + 原始 EventLog 重建时，系统必须：

- 只有完整、可验证、属于当前 Campaign/Task/Episode/Stage 的可信 Outcome 才能生成 `Fact` 或 `Refuted`。
- 缺失、foreign、错绑、未知、证据不足的 Outcome 保留为 `Hint`，并附明确原因。
- 只有存在合法先前 `campaign.plan.submitted` 的完整计划，才能被 `campaign.plan.admitted` 接受。
- `plan_id`、`planning_task_id`、canonical digest 和候选 plan 内容必须形成不可绕过的身份链。
- 重复完全相同的事件幂等；冲突事件 `rejected`，不创建任务、不增加预算、不释放 hold。
- 正常产品链保持现有行为，`rejected=[]`、任务状态和白板 Fact 不回归。

### 1.2 非目标

本轮不得扩展为：

- 真实模型、真实 CTF、真实靶场、目标网络或付费 provider 测试；
- 通用 shell/HTTP 攻击平台、多 Worker、自动退款、自动重试、增量重规划；
- HTML 重做、浏览器像素验收、分页系统或全仓 TypeScript 清零；
- 修改 `Pi_Agent_base/pi/`、凭据、模型配置、lockfile 或新增依赖；
- 删除、过滤或弱化既有 meaningful assertions。

## 2. 已复现问题

### 2.1 Outcome 事实绑定 fail-open

实现位置：[board.mjs](../Pi_Agent_base/memory/runtime/board.mjs) 的 `campaignOutcomeAsRecorded()`。

当前逻辑只在字段“同时存在且不一致”时记录错误；字段缺失时使用 `??` 回退，导致以下输入仍可能成为 `Fact`：

- 外层 `payload.task_id` 缺失；
- 内层 `outcome.task_id`/`outcome.provenance.task_id` 缺失；
- `episode_id` 缺失，或没有对应的 `campaign.task.started`；
- 外层 `step_id` 和内层 `step_id/stage_id` 缺失；
- 内层可信 source 缺失；
- `campaign_id` 缺失或属于其他 Campaign；
- task 不存在，或 stage 不属于该 task。

最小复现要求：对一个正常 Oracle 事件逐个删除上述字段，`projectBoard()` 必须不再将原事件放入 `Fact`，而是生成 `Hint` 并包含稳定、可读的 `downgrade_reason`。

### 2.2 Plan replay 身份链 fail-open

实现位置：[projection.mjs](../Pi_Agent_base/memory/campaign/projection.mjs) 的 `applyPlanSubmitted()`、`applyPlanAdmitted()`。

当前 replay 未强制验证：

- admitted 是否对应此前同 Campaign 的 submitted；
- submitted/admitted 的 `plan_id` 是否一致；
- `planning_task_id` 是否一致；
- admitted 声明的 digest 是否等于 submitted digest；
- submitted 的 `plan` 重新计算的 `planDigest(plan)` 是否等于声明 digest。

最小复现要求：

- 只保留 admitted 事件时，不能创建动态 Task；
- submitted digest 与 admitted digest 不同，不能创建动态 Task；
- 声明 digest 与 `planDigest(submitted.plan)` 不同，不能创建动态 Task；
- planning task 或 campaign 身份不一致时，不能准入；
- 冲突事件必须出现在 `projection.rejected`，而不是静默忽略。

## 3. 冻结数据契约

### 3.1 Campaign Outcome 绑定契约

`campaign.oracle.result` 适配为 Board Outcome 前，必须同时满足：

| 字段 | 必须存在 | 校验 |
| --- | --- | --- |
| `payload.campaign_id` | 是 | 等于当前 Campaign；缺失/foreign = Hint |
| 外层 `payload.task_id` | 是 | 与内层 task id 相等，且存在于当前任务索引 |
| 内层 task id | 是 | `outcome.task_id` 与 `outcome.provenance.task_id` 若同时提供必须一致 |
| `payload.episode_id` 或事件 `episode_id` | 是 | 等于该 task 最近/当前合法 `campaign.task.started` episode |
| `outcome.episode_id` | 是 | 与外层 episode 及 task 当前 episode 一致 |
| 外层 `step_id` | 是 | 必须属于该 task 的定义 stage |
| 内层 `step_id` 或 `stage_id` | 是 | 与外层 step 一致且属于该 task |
| `event.source.kind` | 是 | 必须是事件契约允许的可信来源 |
| 内层 provenance source | 是 | 与事件 source 一致；不得由模型字段提升可信度 |
| criterion | 是 | 由可信 Outcome resolver 校验，不接受裸 status |
| evidence_refs | 是 | 至少一条合法证据；继续使用现有 artifact/evidence resolver |

缺失与不一致的语义统一为 `Hint`，不能用 `outer ?? inner` 伪造完整绑定。适配层可以保留原 `event_id`、source、evidence 和字段，但不得写第二份事件。

`campaign.task.started`、Manifest task definitions 和 stage definitions 是绑定索引的权威来源。不得仅凭字符串格式、UUID 或模型自述判断归属。

### 3.2 Plan Replay 契约

Plan 状态必须满足以下关系：

```text
submitted(plan_id, planning_task_id, plan, declared_digest)
  -> admitted(same plan_id, same planning_task_id,
              declared_digest == submitted.declared_digest,
              declared_digest == planDigest(submitted.plan),
              complete normalized plan_tasks)
  -> ready(same plan_id, planning task independently completed)
```

其中：

- `campaign.plan.submitted` 是候选记录，不产生执行权；
- `campaign.plan.admitted` 是整批 durable 准入，不允许合法前缀；
- `campaign.plan.ready` 是独立激活门，不得由 admitted 推断；
- `planDigest(plan)` 必须复用 `e1-plan-contract.mjs` 的 canonical 实现；
- admitted 不能用 normalized definitions 反向替代 candidate plan digest；两者是不同层级的事实；
- admitted 无 submitted、submitted 缺 plan、digest 缺失或不一致，统一 `rejected/hold`；
- 完全相同的重复事件幂等，不重复创建 Task、reservation 或 budget；
- 冲突事件不能覆盖第一次合法记录。

## 4. 推荐实现顺序

### 阶段 A：先补 red 测试

在现有 E1 observation/replay 测试中补：

1. Outcome 缺外层 task、内层 task、campaign、episode、stage、source；
2. 未启动 task、foreign campaign/task/episode/stage；
3. submitted/admitted digest 冲突；
4. admitted 无 submitted；
5. submitted plan 内容与声明 digest 不一致；
6. planning task 身份错配；
7. 合法重复事件幂等。

先在当前实现上运行并确认红灯，记录每个失败的行为原因。不得先改产品再补“会通过”的测试。

### 阶段 B：修复 Outcome 适配

建议新增纯函数或扩展现有 `campaignOutcomeAsRecorded()`：

1. 构建当前 Campaign/task/episode/stage/source 索引；
2. 对所有必需绑定执行存在性和一致性检查；
3. 只在所有结构绑定通过后设置 `campaign_binding_ok=true`；
4. 失败返回 Hint 所需的稳定 reason code/text；
5. 保持 `classifyOutcome()` 的 evidence、status、trusted、failure_mode 规则不变；
6. 不改变既有 supersede、environment stale、unknown 语义。

### 阶段 C：修复 Plan replay

建议在 `applyPlanAdmitted()` 开始阶段完成所有校验，再执行任何 `byId`、`budget`、`dynamicDefinitions` 或 `plans` mutation：

1. 查找同 Campaign 的先前 `plans.get(planId)` candidate；
2. 要求状态为 submitted，且 candidate.plan 为合法对象；
3. 比较 planning task、candidate digest、admitted digest；
4. 重新计算 `planDigest(candidate.plan)`；
5. 对 admitted batch 的 normalized definitions 执行现有整图校验；
6. 冲突返回 `{ok:false, reason}`，由 projection 记录 rejected；
7. 全部通过后才批量写入 dynamic tasks、budget 和 admitted plan 状态；
8. 保持合法重复 admission 幂等。

必要时在 `applyPlanSubmitted()` 就拒绝声明 digest 与 candidate plan 不一致，避免非法候选进入索引；但不得破坏正常工具 recorder/Host 的重复提交。

### 阶段 D：mutation 与集成

至少做两类行为 mutation：

- 绕过任意一个 Outcome 必填绑定检查，缺失/foreign case 必须重新变为 Fact，测试应失败；
- 绕过 submitted/digest 校验，孤立或冲突 admitted case 必须创建动态任务，测试应失败。

恢复 mutation 后运行完整 required 清单。

## 5. 测试矩阵

| ID | 场景 | 预期 |
| --- | --- | --- |
| FC-O-01 | 正常 Oracle，完整绑定 | 一个可追溯 Fact |
| FC-O-02 | 缺外层 task | Hint，不是 Fact |
| FC-O-03 | 缺内层 task/provenance | Hint，不是 Fact |
| FC-O-04 | 缺 campaign 或 foreign campaign | Hint，不是 Fact |
| FC-O-05 | 缺 episode/未 started/foreign episode | Hint，不是 Fact |
| FC-O-06 | 缺 stage/foreign stage/外内不一致 | Hint，不是 Fact |
| FC-O-07 | 缺 source/内外 source 不一致 | Hint，不是 Fact |
| FC-O-08 | 缺证据、unknown、transport error、llm source | Hint，不是 Fact |
| FC-P-01 | 正常 submitted -> admitted | admitted，动态 Task 正常存在 |
| FC-P-02 | admitted 无 submitted | rejected，无动态 Task/预算 mutation |
| FC-P-03 | submitted/admitted digest 冲突 | rejected，无动态 Task |
| FC-P-04 | declared digest != `planDigest(plan)` | rejected，无动态 Task |
| FC-P-05 | plan_id/planning_task/campaign 错配 | rejected，无动态 Task |
| FC-P-06 | 重复相同 submitted/admitted | 幂等，无重复 reservation |
| FC-P-07 | admitted 前缀 replay | hold，无 provider/Broker effect |
| FC-I-01 | 真实 SDK + faux 正常链 | E1 正常链零 rejected，Facts/graph/replay 一致 |
| FC-I-02 | 真实链重启/坏前缀 | provider/effect 不新增，动态任务不越过 ready |

## 6. 必须执行的检查

新增测试先单独运行，再执行完整 required 清单。结果必须保存到 ignored 的 `Pi_Agent_base/runtime/dev/e1-fail-closed-repair/`。

```sh
node Pi_Agent_base/tests/aegis-e1-observation-repair.mjs
node Pi_Agent_base/tests/aegis-e1-external-review.mjs
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs \
  Pi_Agent_base/runtime/dev/e1-fail-closed-repair/e1 \
  aegis-e1-plan-contract aegis-e1-planning-product \
  aegis-e1-observation-view aegis-e1-planning-chain \
  aegis-e1-planning-gate aegis-e1-planning-gate-audit \
  aegis-e1-external-review
```

同时复跑：

- C6 required 18；
- 回归 required 26；
- 受影响 required 8；
- 修改范围 Biome；
- Campaign `tsc`，与修复前诊断逐条比较。

测试报告必须记录每条命令的真实 argv、exit code、脚本数、用例数、失败/blocked 数和日志路径。不能把未运行、空清单、环境错误或被跳过的用例算作通过。

## 7. Definition of Done

- 所有 FC-O/FC-P 核心负例在旧实现上确实红，在修复后绿；
- 正常 E1/C6/回归链保持通过，正常链 `rejected=[]`；
- replay 从原始 EventLog 重建，不依赖旧 report、HTML 或 checkpoint 伪造预期；
- 两个 mutation 都因行为断言失败，而不是 syntax/import 失败；
- 无任何动态任务、预算、Fact 在非法事件失败前被部分写入；
- 修改文件无新增 TypeScript 诊断，Biome 通过；
- 不修改 Pi 核心、凭据、配置、lockfile，不加依赖；
- 本地提交、工作树 clean、未 push；
- 报告明确列出未测真实模型、真实 CTF、真实靶场和浏览器限制；
- 只有在本任务全部完成后，状态才可为 `internally_verified / awaiting_external_review`。任何一项核心负例仍红，必须交回 `changes_required`。

## 8. 进入 CTF 的后续门

本任务通过后仍只表示工程 replay/观察边界闭合。真实 CTF pilot 还必须由用户单独确认：目标授权、题目目录、允许工具、预算、停止条件、独立 Oracle、模型配置和人工回滚方案。首次 pilot 只选一个小题，不同时验证通用渗透能力。
