# C6 Provider Gate 重规划与 DS 实施约束

状态：`changes_required / planning_required`

本文件是当前 C6 请求门问题的完整重规划，优先级高于此前只要求修 R12/R13/R14 的窄修复提示。请主 DS 在实现前完整阅读，并把本文件转化为自己的任务图、契约表和测试矩阵。当前会话只提供审查结论与 red 测试，不直接修改产品实现。

## 1. 当前基线与结论

仓库：`/Users/scemac/My_github/Aegis`
分支：`feat/c6-agent-product`
当前 HEAD：以实际工作树为准；不得假设交付报告中写的 `22d075c` 仍是 HEAD。
产品修复基线：`22d075c`
已有聚焦红测试：`85b1d1d`

已认可范围不重开：

- 五组复验修复：registered-test、runner 初态、学习真复用/真实前态、aegis_read grant、provider 初步调用前门；
- `aegis-c6-external-boundaries.mjs` 原有 22/22；
- `aegis-c6-learning-closure.mjs` 全部检查；
- 当前原有 C6 required suite 与已核对回归中的其余证据。

当前阻塞只在同一条 provider-bound 请求门，但不是三个孤立断言。它反映了实现没有把以下架构不变量统一落实：

1. Provider transport、账本 reservation、durable event、Broker effect 必须有明确的先后关系和失败状态。
2. 每个实际 provider request 必须同时受 Campaign envelope 与当前 Task allocation 约束。
3. 请求窗口必须检查实际送入 SDK/provider 的当前 transcript，而不是只检查缓存 prompt 的估算。
4. 最后一次请求没有下一次 continuation 时，仍必须在任何执行决策放行前完成 durable accounting。
5. provider 已发生但 accounting 不确定时，必须停止后续副作用并保留 reconciliation，不能返回成功。

当前不允许进入真实 provider、真实凭据、真实目标或真实费用环境。

## 2. 必须遵守的架构边界

### 2.1 既有 Aegis 结构必须保留

本轮是 provider gate 的设计收敛，不是重建 Campaign：

```text
trusted config/Manifest
  -> Campaign Host / Scheduler
  -> current Task / Episode / Session
  -> Pi SDK provider-bound streamFunction
  -> request gate
  -> Campaign + Task ledger reservation
  -> durable runtime.note
  -> provider transport
  -> provider result / message_end
  -> ledger commit + durable commit
  -> structured model decision
  -> existing Broker intent/effect/Oracle path
```

必须继续复用：

- 既有 `Host`、`Scheduler`、`Broker`、`Oracle`、`EventLog`、`runtime.note` schema 1.1；
- 真实 Pi SDK 的 provider-bound boundary 和 faux provider；
- 当前 `createModelWorker` / `createToolLedger` / `c6-entry` 的职责边界；
- committed event stream 作为权威源，projection、measurement、report 作为派生物。

禁止：

- 新建第二套 Scheduler、Broker、Oracle 或独立预算框架；
- 把 model prose、tool exit code 或 `ok: true` 当作 accounting 或 Oracle 真值；
- 通过降低测试、删除 assertion、`expected-failure`、只检查 reason 字符串来恢复绿色；
- 修改嵌入 Pi 核心、auth、models、lockfile 或安装依赖；
- 调用真实 provider、读取真实凭据、访问真实目标；
- 把真实计费/token 可观测性伪造为当前已实现。

### 2.2 信任分层

- Config/Manifest/Task allocation：trusted Host input。
- Provider `model`、`llmContext`、message/tool schema：provider boundary 当前实际输入，不能由缓存副本替代。
- `request_id` / `reservation_id`：由 Host/gate 生成，模型不可提供。
- durable reservation/commit：由唯一 EventLog writer 确认；Promise 创建、内存数组写入或 SDK callback 触发不等于 durable。
- Broker effect：只有 model Worker 返回 accounting 成功、且其 decision 来源与现有 Broker grant 通过后才能进入。
- accounting failure：不是 task success/failure；必须返回结构化 `accounting_failure`，保留 reconciliation。

## 3. 冻结的 provider request 状态机

每一个真实 provider request 必须有稳定的 `request_id`，并关联：

```text
campaign_id
 task_id
 episode_id
 session_id / session_generation
 request_id
 task_reservation_id
 campaign_reservation_id (same id when ledger is the same object, otherwise linked ids)
 input_chars_estimated
 request phase
 provider outcome status
 reconciliation status
```

推荐状态与合法转移：

```text
created
  -> admitted
  -> reserved_in_memory
  -> reserved_durable
  -> provider_started
  -> provider_finished
  -> committed_in_memory
  -> committed_durable
  -> settled
```

异常分支：

```text
created -> rejected
reserved_in_memory -> reservation_failed
reserved_durable -> provider_started -> provider_error
reserved_durable -> accounting_commit_failed
provider_started -> unknown/reconciliation_required
```

硬规则：

1. `rejected` 不产生 provider call。
2. 未获得所有需要的 in-memory reservation，不得写 durable reservation，不得调用 provider。
3. durable reservation 失败，不得调用 provider。
4. provider call 发生后，不能把费用/consumption 释放成“未发生”。
5. provider 结果提交失败，停止后续 provider dispatch 和 Broker effect，保留 pending/reconciliation。
6. 同一 reservation 重复 commit 必须幂等，不能双扣。
7. provider 已调用但没有可确认的 message end 时，不能假设没有消耗；进入 reconciliation/unknown，不能盲目重发。
8. 最后一个请求也必须走完整 `commit -> durable commit -> settle`，不能依赖下一次 `streamFunction` 触发 flush。
9. `prompt()` 返回、decision buffer 有内容、transport exit 0，都不能替代 `committed_durable`。

## 4. R12：最后一次 durable commit 的完整要求

当前缺陷位置：`c6-model-worker.mjs` 的 `message_end` 与 `run()` 尾部。

### 4.1 正确时序

provider-bound 调用前：

```text
compute actual request context
-> validate Campaign + Task budget
-> reserve Task
-> reserve Campaign
-> persist durable reservation with non-null ids
-> call provider
```

provider 返回后：

```text
capture actual usage/result
-> commit Task reservation in memory
-> commit Campaign reservation in memory
-> persist durable committed request
-> await durable result
-> mark request settled
-> only then allow Worker decision result to reach CompositeWorker/Broker
```

如果还有下一次请求，下一次 admission 仍然要等待前一个 request settled；但这不是最后一次 flush 的唯一机制。

### 4.2 必须断言

- `persistRequest({ phase: "committed" })` 返回 `{ok:false}` 时，`worker.run()` 必须是 `ok:false`；
- `failure_mode === "accounting_failure"`；
- 返回 reconciliation，包含 request/task/campaign identity、provider 已发生事实、commit 失败原因、pending/consumed 状态；
- `createCompositeWorker` 不得调用 Broker worker；
- 不得 dispatch 后续动态 Task 或 dependency advancement；
- `providerRequests` 仍反映已经发生的请求，不归零、不免费重试；
- persist callback throw 与 `{ok:false}` 行为一致；
- 失败后恢复可以从 committed source/reconciliation 继续核对，但不能自动制造一个未确认的成功或重复 effect。

## 5. R13：Campaign + Task 联合准入

### 5.1 联合预算不变量

每个真实 request 必须同时满足：

```text
Campaign remaining(model_requests, wall_time, relevant input envelope)
AND
Task remaining(model_requests, wall_time, relevant allocation)
```

任一维度拒绝，provider call 次数必须为 0。

同一个 ledger object：只进行一次 reservation 和一次 commit。

两个不同 ledger object：

```text
one request identity
  -> one Task reservation
  -> one Campaign reservation
  -> durable linked record
  -> provider call
  -> one Task commit
  -> one Campaign commit
```

不能先向 Task ledger admission，再把 Campaign ledger当事后 mirror；也不能仅通过无 reservation id 的 `commitRequest()` 计 Campaign。

### 5.2 durable 顺序

错误顺序：

```text
persist reserved(null reservation_id)
-> admit one ledger
-> provider
-> mirror second ledger in message_end
```

必须改为：

```text
validate both ledgers
-> create stable request identity
-> reserve Task and Campaign in memory
-> if either fails, compensate/mark reservation state and do not persist a fake reservation
-> persist durable reservation containing all real reservation ids
-> confirm durable result
-> call provider
```

如果两层 reservation 之间发生第二层失败，必须有明确的 rollback/compensation 语义。不能简单释放第一层而忽略 provider 可能已经发生的情况。provider 发生之后只能进入 commit/reconciliation，不得把费用静默释放。

### 5.3 账本和重启

必须定义并测试：

- `consumed`、`reserved`、`pending` 的来源和转移；
- reservation/commit 的唯一键；
- restart 时如何从 `runtime.note kind=c6.request` 重建两层账本；
- committed request 不重复计费；
- pending durable reservation 仍占额度；
- null/missing reservation id 不得被解释为合法 committed request；
- Campaign 与 Task 的累计数值必须能从权威记录独立算出。

## 6. R14：实际 provider transcript 窗口

### 6.1 检查对象

gate 位于 `agent.streamFunction(model, llmContext, options)`，所以每次调用都必须以该次 `llmContext` 为准重新计算。不得只使用 `run()` 初始阶段缓存的 `prompt`、RAM、catalog 或 `historyCharsProvider()`。

至少覆盖：

- `llmContext.messages` 中所有实际 system/user/assistant/tool/tool-result 内容；
- `llmContext.tools` 中实际传入的 schema、name、description、parameters；
- Pi SDK 当前 provider boundary 真实使用的字段；
- 当前 prompt/ROM/RAM 中确实未包含的约束；
- output reserve。

必须先读取内嵌 Pi 的真实类型和 provider API，确认 `llmContext` 的消息和 tool schema形状。不要凭记忆定义字段，也不要用测试 fixture 自创一个与 SDK 不同的 transcript 格式。

### 6.2 计算规则

需要一个集中、可审查的纯函数，例如：

```text
measureProviderInput({ model, llmContext, promptMetadata, outputReserve })
  -> { chars, coverage, source, details }
```

要求：

- 每个字段的覆盖范围明确；
- 已在 `llmContext` 的内容不得再次重复计算；
- 字符估算与 backend tokens 分离；
- backend token 不可观测时仍是 `null/unknown`；
- 不因为估算困难而删除必要 system/tools/history；
- 超窗口必须在 provider call 前返回 `context_window_exceeded`；
- 首次请求和 continuation 使用同一个函数/同一门；
- request record 保存估算值、coverage/source，不声称精确 tokenizer。

### 6.3 必测输入

- 小的合法 messages/tools，provider 正常调用；
- 大 user/system message，provider 调用 0；
- 大 tool schema，provider 调用 0；
- 大 tool result，provider 调用 0；
- 首次请求合法但 continuation 变大，第二次 provider 调用 0；
- history 增长但累计请求数仍合法，窗口和累计 request budget 不混淆；
- output reserve 刚好等于窗口、超过窗口的边界；
- schema/message key 顺序变化不改变语义测量结果。

## 7. 共享接口建议与禁止事项

主 DS 可以选择函数名，但必须保持以下语义。若修改公共接口，主 DS负责所有调用点和迁移测试。

### 7.1 Gate 返回值

至少能区分：

```js
{
  ok: true,
  request_id,
  reservations: {
    task: { ledger_id, reservation_id },
    campaign: { ledger_id, reservation_id }
  },
  input: { chars, source, coverage }
}
```

或：

```js
{
  ok: false,
  failure_mode: "budget_exhausted|context_window_exceeded|reservation_persist_failed|accounting_failure|reconciliation_required",
  reason,
  request_id,
  reconciliation
}
```

不得用一个模糊 `ok:false` 或正则匹配错误字符串承担状态机语义。

### 7.2 Ledger API

如果沿用 `createToolLedger`，必须为联合 request 提供可表达能力：

- reserve/admit with stable external request id；
- commit by exact reservation id；
- idempotent commit；
- pending snapshot；
- no reservation id means reject or explicit provider-already-happened reconciliation, never silent normal charge；
- base rebuild from committed/pending source。

不要为了兼容旧 helper 而让“无 reservation id commit 一次”继续作为正常 Campaign mirror 路径。

### 7.3 Event schema

继续使用 `event_type: "runtime.note"`、`payload.kind: "c6.request"`，除非先证明现有 schema 无法表达并由主 DS冻结迁移。

每个 request 事件至少必须能区分：

- reserved / committed / rejected / reconciliation_required；
- campaign/task/episode/session/request identity；
- task/campaign reservation ids；
- estimated input chars 与 coverage/source；
- provider started/finished 或等价事实；
- failure reason；
- idempotency/duplicate 状态。

不能写 `reservation_id: null` 后再从缺失字段猜这个请求属于哪一层。

## 8. 测试矩阵与验收门

当前新增 red 测试位于：

`Pi_Agent_base/tests/aegis-c6-recheck-boundaries.mjs`

当前旧代码实际结果：20 tests / 13 pass / 7 fail。失败包括：

- R12：最后 commit failure；
- R13：Campaign limit 绕过；
- R14：实际 continuation messages 未计入窗口；
- R12b：accounting failure 后仍进入 Broker；
- R13b：Campaign refusal 前写入 null-id durable reservation；
- R13c：合法联合 request 没有两层 reservation/commit；
- R14b：tool schema/tool-result 未计入窗口。

DS 必须保留这些测试，不得删除、skip、降低 assertion 或把现有 failure 改成 expected failure。

### 8.1 必须新增或明确的正例

- Campaign 和 Task 都有余额时，一次 provider request，两边各一 reservation、各一 commit；
- 同一 ledger object 不双扣；
- 小型真实 SDK/faux 请求通过并产生真实 `message_end`；
- 合法 transcript 窗口通过；
- provider error 的 reservation/commit/reconciliation 语义明确；
- restart 后 committed/pending 数值保持；
- 最后一条正常 commit 成功时 decision 可以进入现有 Broker path。

### 8.2 必须新增或明确的负例

- Campaign=0、Task>0：provider 0 次；
- Task=0、Campaign>0：provider 0 次；
- 任一 pending reservation 已占满：provider 0 次；
- durable reservation throw / `{ok:false}`：provider 0 次；
- durable final commit throw / `{ok:false}`：Broker effect 0 次；
- provider 已发生但 commit 不确定：后续 provider/Broker 0 次，返回 reconciliation；
- transcript messages/tool schema/tool result 超窗：provider 0 次；
- 首次合法、continuation 超窗：只允许首次真实请求，后续 0 次；
- 重复 commit/retry 不双扣、不重复 effect；
- null reservation id 不构成正常合法记账。

### 8.3 产品接线要求

不能只测试 `createModelWorker` 内部返回值。至少一个测试必须走：

```text
createCompositeWorker
  -> modelWorker.run
  -> accounting failure
  -> assert brokerWorker.run count === 0
```

至少一个测试必须验证真实 durable event payload，确认 Task/Campaign reservation ids 和 request id 可重建。

至少一个测试必须使用真实 Pi SDK + faux provider 的当前 provider-bound path；fake `streamFunction` 可用于纯边界测试，但不能代替全部产品接线证据。

## 9. Mutation 计划

只做本轮关键 guard 的有限 mutation，必须是行为失败：

| mutation | 必须失败的测试 |
|---|---|
| 删除 run 尾部 final `pendingCommit` flush | R12/R12b |
| 将 accounting failure 映射为 `ok:true` | R12/R12b |
| 只保留 Task admission，删除 Campaign admission | R13/R13b |
| Campaign 使用无 reservation id 的 mirror commit | R13b/R13c |
| 只持久化 null-id reservation | R13b |
| gate 改回缓存 prompt estimate | R14/R14b |
| 不读取 `llmContext.tools` | R14b |
| 只检查首请求、不检查 continuation | R14/R14b 或新增 continuation case |
| 去掉 pending reservation 在 remaining 中的扣除 | 现有 X1/R13 pending case |
| 重复 commit 不幂等 | 现有 ledger duplicate case |

如果 mutation 仍然绿色，先补测试，不要把 mutation 解释为“不适用”。

## 10. 文件范围与任务图

主 DS先写自己的任务图，但至少覆盖以下顺序：

### PG-0 基线与契约

范围：文档、矩阵、真实 Pi SDK 类型/调用点核对。

输出：

- provider gate 状态机；
- Task/Campaign 联合 reservation 契约；
- transcript measure 覆盖表；
- R12/R13/R14 及补充 red 证据；
- 不修改产品实现。

### PG-1 测试先行

范围：`aegis-c6-recheck-boundaries.mjs` 及必要独立 helper。

输出：

- 正例、负例、恢复、联合账本、Broker 不 dispatch、tool schema/result、continuation 窗口测试；
- 旧代码行为 FAIL；
- Biome/语法检查。

### PG-2 Ledger / request identity

范围优先：`c6-tool-ledger.mjs` 及其直接测试。

要求：稳定 request identity、联合 reservation、幂等 commit、pending/rebuild；不改无关预算框架。

### PG-3 Provider gate / transcript measure

范围优先：`c6-model-worker.mjs` 及直接调用点。

要求：实际 llmContext、联合准入、durable reservation、final flush、accounting failure stop。

### PG-4 Entry durable integration

范围优先：`c6-entry.mjs`、必要的 event payload/measurement/rebuild 接线。

要求：不产生 null-id 正常 reservation；Task/Campaign source 可重建；事件语义不被 measurement/report 覆盖。

### PG-5 Composite/Broker boundary

范围：现有 composite path、产品接线测试。

要求：Worker 非成功不得进入 Broker；不把 transport success 当 effect authorization。

### PG-6 独立审查与集成

主 DS必须：

- 阅读最终 diff 与所有关联调用点；
- 对照本文件逐条检查不变量；
- 跑 focused、原 C6 suites、受影响回归；
- 跑 Biome 与 Campaign type baseline；
- 做本轮 mutation；
- 更新 C6 external review/report/runbook/test matrix；
- 不自行宣布 external acceptance。

如果主 DS 没有独立子 DS能力，必须如实串行执行 TEST -> IMPLEMENT -> REVIEW，不声称有独立审查。

## 11. 允许与禁止修改

允许：

- Aegis-owned `Pi_Agent_base/memory/campaign/` 实现、测试与 C6 文档；
- 必要的 request/event/measurement 接线；
- 与真实 SDK API 一致的类型/JSDoc；
- 必要的 focused regression helpers。

禁止：

- `Pi_Agent_base/pi/` 核心、auth/models/lockfile；
- 真实凭据/网络/目标；
- 降低 context/window/budget 约束；
- 把 Campaign ledger 变成 Task ledger 的事后 mirror；
- 只在 `message_end` 做最终权威 commit；
- 用 `historyCharsProvider()` 默认 0 代替真实 transcript；
- 用 provider 请求数为 0 来掩盖已发生但未结算的请求；
- 以修复五组已认可内容为理由绕开本文件新增约束。

## 12. 交付格式

交回时必须提供：

1. R12/R13/R14 逐项实现对应表；
2. request 状态机和联合 reservation 的实际接口；
3. durable event 字段样例，说明 request/campaign/task identity；
4. final commit failure 时 Broker effect count；
5. Campaign/Task reservation、commit、pending、restart 重建的具体数值；
6. 实际 transcript/window coverage、合法/超窗 provider call count；
7. 旧 red -> 新 green；
8. mutation -> case -> 实际 FAIL；
9. 原 15 个 C6 suite、受影响回归、Biome、type check 的 exact argv/exit/log；
10. 修改文件、owner、commits、工作树状态；
11. 未实测限制：真实 provider、真实计费、OS sandbox、真实目标；
12. 状态只能是：
   - `internally_verified / awaiting_external_review`：所有冻结工程门通过；或
   - `changes_required`：仍有任一当前阻塞。

完成工程复验后，仍不能自行启动真实 pilot。真实环境中的模型、任务范围、预算、授权和回滚策略由用户单独确定。
