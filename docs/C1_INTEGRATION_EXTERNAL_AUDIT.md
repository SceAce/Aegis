# C1 Integration Closure 独立审计补充

状态：**C1 changes required；C2 blocked**。

本记录承接 `C1_CLOSURE_EXTERNAL_AUDIT.md`，针对最新
`C1_INTEGRATION_*` 实现和报告。没有修改产品代码或 DS 报告。

## 1. 独立运行结果

已独立运行：

- `aegis-campaign-c1-integration-contracts.mjs`：exit 0；
- `aegis-campaign-c1-integration-scheduler.mjs`：exit 0；
- `aegis-campaign-c1-integration-recovery.mjs`：exit 0；
- `aegis-campaign-c1-integration-e2e.mjs`：exit 0；
- Biome：exit 0，0 warnings；
- Campaign tsc：exit 1，Campaign文件无错误，10个错误来自旧导入运行时；
- 8组offline回归：exit 0；
- 4组Pi SDK/faux回归：exit 0。

测试绿灯不等于C1通过。以下发现来自最终代码阅读和独立最小反例。

## 2. P0：reconciliation 成功结果没有真正完成任务

位置：`memory/campaign/scheduler.mjs` 的
`reconcileStrandedRunning()`；`memory/campaign/projection.mjs` 的
`campaign.reconciliation.resolved`。

reconciliation 成功时，Scheduler先提交 `campaign.oracle.result`，然后提交
`campaign.reconciliation.resolved`。但 projection 对 resolved 的处理是：

```text
只有 item.state 不是 running 时，才把有 outcome_id 的任务转为 completed
```

而 stranded intent 的任务状态正是 `running`。因此流程结束后会出现：

```text
可信成功 Outcome 已提交
reconciliation.resolved 已提交
Task 仍为 running
```

当前 recovery 测试没有捕获它。测试使用了：

```js
projection.tasks[0].task_state !== "running"
```

但 queue item 字段是 `state`，不是 `task_state`。这个表达式在字段不存在时为 `true`，因此形成假阳性。

必须修复并补测试：

```text
intent durable -> effect exists -> reconcile
-> oracle.result success -> reconciliation.resolved
-> task.state === completed
-> worker_calls_after_recovery === 0
```

同时检查：

- result 的 outcome_id 与 completion 的 outcome_id 一致；
- 结果的 Task/Episode/criterion/scope/evidence 完整；
- 依赖任务随后才变为 ready；
- 修复 recovery 测试字段名，不能只检查 reconciliation 事件存在。

## 3. P0：事件 source 与 Outcome 内部 provenance 没有绑定

`event-contract.mjs` 已经按 `campaign.oracle.result` 限制外层 source 为
`oracle`/human等，但 `projection.mjs` 将 `payload.outcome` 交给
`resolveTaskOutcome()` 时，没有要求 Outcome 内部的：

```text
outcome.oracle.source
outcome.provenance.source
```

与事件外层 source 一致。

因此可能出现：

```text
Event source.kind = oracle
payload.outcome.provenance.source = runtime 或 agent
status = success
```

resolver 的 C0 binding 允许 `runtime`，导致外层看似可信的 event 包装了内部不可信声明。

修复要求：

- `resolveTaskOutcome()` 或其调用方接收并验证 committed event source；
- `campaign.oracle.result` 的可信 source 必须与 Outcome oracle/provenance source 对齐；
- 不接受 payload 自己声称 `oracle`/`human`；
- `runtime` 只能记录结构和调度，不得生成 Oracle 结果；
- 补充 `outer oracle + inner runtime/agent/llm` 的负测。

## 4. P1：C1 产品测试仍未证明 required stages 已完成

当前 integration 正例的 Task definition 含有 stages，但 scheduler 的
Oracle结果主要是 task-level Outcome；E2E summary检查的是：

```text
static_a_completed
b_delayed_then_verified
dynamic_completed
```

没有验证：

- 每个 required stage 都有独立 Outcome；
- 每个 stage 的全部 criteria 都满足；
- stage Outcome 与当前 Task/Episode/scope/evidence 绑定；
- Task completed 是由 Stage aggregation + Task Oracle 共同产生。

这仍然可能出现：Task-level success 存在，但 required stage 缺失，Task却完成。

必须让产品入口正例提交完整 stage/task evidence，或明确 C1 只负责调度且将 stage聚合留给后续，但不能同时声称“full Outcome ownership”。当前契约要求完整绑定，因此建议测试和投影接入 C0 `resolveTaskFromOutcomes()`。

## 5. P1：recovery 测试有“效果存在”伪核对风险

`campaign-recovery-child.mjs` 的 `oracle.reconcile()` 通过本地 sentinel 判断效果存在，这是可以接受的 synthetic Oracle，但必须确认它提交的 Outcome 证据引用实际 artifact，且 artifact digest 与真实文件内容绑定。

当前部分 synthetic helper 使用固定字符串形式的 artifact digest，并未对每个 sentinel 重新读取和计算内容digest。由于本 harness 的 SHA256 被置零，测试至少应验证使用当前 digest helper 和真实文件内容变化会改变索引/绑定；不能仅通过 `existsSync` 就称“完整可信 Outcome”。

## 6. P1：动态任务定义仍有授权/语义完整性风险

`buildDynamicTaskDefinition()` 为缺失的 stage 使用 proposal goal criteria生成默认 stage。这适合C1测试，但必须保证：

- proposal 的 `scope`、`oracle_ref`、`execution_adapter` 与 Manifest/parent policy一致；
- 动态生成的 Stage ID 在 Campaign 全局唯一；
- Task definition中 `required_capabilities`、budget、stop condition、expected evidence 都进入 digest；
- 同一 semantic task换随机 ID不能绕过限制；
- Scheduler重启只从 committed admitted definition恢复。

已有测试覆盖部分字段，但E2E应检查动态定义完整摘要和重启后同一摘要，不只检查任务被执行。

## 7. P1：checkpoint 等价测试仍偏向状态字段

当前E2E的 prefix+tail 对比主要检查 control state、budget单调性或少量状态字段。完整等价应比较：

- Task definitions；
- proposal index/digest；
- task state/outcome refs；
- budget reserved/consumed/released；
- control state/reason/offset；
- pending reconciliation；
- projection digest。

只比较“都是 cancelled”或“budget不减少”不能证明 prefix+tail 等于 full replay。

## 8. 当前验收结论

```text
C0: retained
C1 source/admission/order/budget fixes: substantially improved
C1 integration tests: green but one recovery assertion is false-positive
C1 external review: changes required
C2: blocked
```

下一轮必须优先修复：

1. reconciliation success 真正将 stranded running Task 完成；
2. 修复 recovery 测试错误字段并增加 outcome/effect/worker 断言；
3. 绑定 Event source 与 Outcome 内部 provenance；
4. 接入或明确证明 required Stage 全量聚合；
5. 加强 synthetic artifact digest 和动态 Task/checkpoint 完整等价断言。

在上述问题修复并重新独立审查前，不得进入 C2。
