# C1 Final Audit 独立复核补充

状态：**C1 changes required；C2 blocked**。

本记录针对 `C1_FINAL_AUDIT_*` 实现和报告。前一轮 F1-F6 测试均通过，但独立代码审查发现两处跨路径/完整性缺口。没有修改产品代码，也没有把 DS 的内部报告改成外部通过。

## 1. 已复核

独立运行：

- `aegis-campaign-c1-final-audit.mjs`：exit 0；
- `aegis-campaign-c1-integration-e2e.mjs`：exit 0；
- `aegis-campaign-c1-integration-recovery.mjs`：exit 0；
- Biome：Campaign和相关测试0 warning；
- Campaign tsc：Campaign代码0 errors，旧导入运行时仍有10 errors；
- 前述C0/C1及offline/Pi-faux回归在上一轮已运行通过。

这些结果证明新增测试路径可执行，不自动证明跨路径契约完备。

## 2. P0：reconciliation 成功绕过 required Stage 聚合

位置：`memory/campaign/projection.mjs` 的 `campaign.reconciliation.resolved` 处理。

普通路径：

```text
campaign.task.completed
  -> 检查 task Oracle success
  -> resolveTaskFromOutcomes
  -> 检查全部 required stages
  -> completed
```

但 reconciliation 路径当前逻辑近似为：

```text
campaign.reconciliation.resolved
  + item.task_outcome_status === success
  -> completed
```

它没有调用 `resolveTaskFromOutcomes`，也没有检查：

- 每个 required Stage 是否存在；
- 每个 Stage 的全部 criteria 是否通过；
- Stage Outcome 是否属于当前 Task/Episode；
- Stage evidence 是否真实可解析；
- Stage Outcome 是否已 superseded/stale/conflicting。

最小反例已复现：

```text
running Task
  -> task-level oracle.result = success
  -> reconciliation.resolved
  -> no stage_outcomes
```

结果仍为：

```text
state = completed
```

这违反 F3 的核心契约。只修普通 `task.completed` 路径是不够的，因为恢复路径可以绕过普通完成事件。

必须修复为：

```text
reconciliation success
  -> commit/resolve current task Outcome
  -> resolveTaskFromOutcomes
  -> all required stages + criteria + task Oracle success
  -> completed
```

如果 Stage evidence 尚未完整：

- 保留 reconciliation result；
- Task 不得 completed；
- 状态保持 waiting/unknown/pending，具体状态必须符合 Queue 契约；
- 不重新运行 Worker；
- 后续迟到 Stage judgment 可以推进，但仍不重跑动作。

必须增加回归：

```text
reconcile task-level success + missing stages -> not completed
reconcile task-level success + one missing criterion -> not completed
reconcile full stage evidence + task success -> completed
reconcile superseded stage success -> not completed
reconcile foreign stage -> not completed
```

## 3. P1：F6 snapshot 仍不是完整 projection

位置：`projection.mjs::projectionSnapshot()` 和 F6 测试。

当前 snapshot 对 Stage Outcome 主要保存：

```js
stage_outcome_ids: [...].map(outcome => outcome.outcome_id)
```

但没有保存 Stage Outcome 的完整语义：

- status；
- task_id；
- episode_id；
- step_id/stage_id；
- criterion；
- scope；
- provenance/source；
- evidence refs/digests；
- supersedes/effective state。

同时 projection 的 `outcomes` index 主要保存 task-level Outcome，Stage Outcome 的完整内容没有进入同等的可重建索引。这样可能出现：

```text
prefix+tail snapshot == full replay snapshot
```

但两者都只保存了相同的 Outcome ID，实际 Stage Outcome 内容或有效性已经不同，测试仍然通过。

必须补充：

```text
stage_outcomes: canonical complete outcome projection
```

并把它纳入：

- checkpoint snapshot；
- projection digest；
- prefix+tail/full replay 等价比较；
- stage aggregation 的输入；
- supersede/stale/conflict 当前视图。

F6 的“完整 projection”等价只有在这些信息被包含后才成立。

## 4. P1：Task scope 没有完整接入 Outcome resolver

`resolveTaskOutcome()` 支持 scope 参数，但 Projection 当前主要传入：

```js
scope: manifest?.scope ?? null
```

而当前 Manifest 的 Task scope/environment 通常位于 Task definition，而不是顶层 `manifest.scope`。动态 Task 也把 scope 保存到 definition，但调用 resolver 时没有始终使用：

```text
task.definition.scope
```

结果是某些带 Task scope 的 Outcome 可能没有经过 scope 匹配检查。

应统一使用：

```text
currentScope = task.definition.scope / task.scope / trusted Task environment
```

缺 scope时按现有契约 fail-closed；不能因为 top-level Manifest 没有 scope 就跳过检查。

补测试：

```text
matching task scope -> accepted
foreign task scope -> rejected
missing outcome scope -> unknown/invalid
object key order difference -> canonical equal
```

## 5. 验收状态

当前有效结论：

```text
C0: retained
C1 F1-F6 tests: green
C1 external audit: changes required
C2: blocked
```

这不是要求重写 C1。已完成的 source binding、dynamic definition、artifact digest、checkpoint 接线和恢复测试保留。下一轮只集中修复：

1. reconciliation 复用 required Stage 聚合门；
2. snapshot保存完整 Stage Outcome projection；
3. Task scope真正进入 resolver；
4. 运行对应产品入口回归、mutation和全套既有回归。

没有这些修复和独立复核，不得开始 C2。
