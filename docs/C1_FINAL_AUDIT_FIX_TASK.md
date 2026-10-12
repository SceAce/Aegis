# C1 Final Audit Fix Task

状态：**C1 changes required；C2 blocked**。

最新独立复核见 `docs/C1_FINAL_EXTERNAL_AUDIT.md`。前一轮 F1-F6 测试全绿，但发现 reconciliation 路径绕过 Stage 门，以及 F6 snapshot缺少完整 Stage Outcome projection。主 DS一次接收本任务，先生成测试，再拆小任务、实现、集成和审查；修复后停止，不进入C2。

## 必须阅读

```text
docs/C1_FINAL_EXTERNAL_AUDIT.md
docs/C1_INTEGRATION_EXTERNAL_AUDIT.md
docs/C1_INTEGRATION_CLOSURE_TASK.md
docs/C1_INTEGRATION_TEST_SPEC.md
docs/AGENT_DEVELOPMENT_STANDARD.md
docs/AGENT_TESTING_STANDARD.md
docs/DS_ORCHESTRATION_WORKFLOW.md
docs/CAMPAIGN_CONTRACT_BASELINE.md
docs/C1_CLOSURE_BASELINE.md
docs/CAMPAIGN_ARCHITECTURE.md
docs/ARCHITECTURE_DECISIONS.md
Pi_Agent_base/AGENTS.md
Pi_Agent_base/pi/AGENTS.md
```

## 任务图

```text
FINAL-BASE       当前代码/调用链/测试基线
FINAL-TEST       先写F7-F9负测和真实Scheduler入口测试
FINAL-RECON      reconciliation复用Stage+Task完整聚合门
FINAL-SNAPSHOT   Stage Outcome完整投影进入snapshot/digest/checkpoint
FINAL-SCOPE      Task definition scope接入Outcome resolver
FINAL-E2E        真实EventLog产品场景、prefix+tail/full replay、恢复
FINAL-REVIEW     主DS全文代码审查、mutation、回归和报告
```

## F7：reconciliation不得绕过Stage聚合

当前 reconciliation success 只能说明 Task-level result已核对，不能自动完成 Task。必须执行与普通 `campaign.task.completed` 相同的 current Outcome + `resolveTaskFromOutcomes` 门：

- 所有 required Stage存在；
- 每个Stage全部required criteria成功；
- Stage Outcome属于当前Task/Episode/scope，evidence可解析；
- 没有superseded/stale/conflicting stage；
- Task Oracle success是当前有效结果。

合法全量证据才：

```text
running/waiting_oracle -> completed
```

否则保留 waiting/unknown/pending（使用既定Queue语义），不重跑Worker。补充：缺Stage、缺criterion、foreign Stage、superseded Stage和完整成功五个产品入口case；修复旧测试错误字段，断言真实`state === completed`、outcome_id、worker=0、dependents ready。

## F8：完整 Stage Outcome Projection

`projectionSnapshot()`、checkpoint queue、projection digest和prefix+tail/full replay必须包含 Stage Outcome的完整canonical projection，至少包括：

```text
outcome_id
status
task_id
episode_id
stage_id/step_id
criterion/expected
scope
oracle/provenance source
evidence_refs/digests
supersedes/effective state
```

不能只保存 stage_outcome_ids。Projection有效/历史视图必须按当前C0规则表达；unknown、superseded、stale、conflict不能被ID集合隐藏。

补充：改变Stage Outcome status/criterion/evidence但保持ID不变，snapshot/digest必须变化；prefix+tail和full replay完整相等；删除checkpoint从events重建同一完整projection。

## F9：Task scope接入resolver

Projection调用 `resolveTaskOutcome` / `resolveTaskFromOutcomes` 时，必须传入当前 Task definition 的可信 scope/environment，而不是仅使用通常为空的 `manifest.scope`。统一解析顺序并写测试：

```text
current scope = task.definition.scope / task.scope / trusted task environment
```

matching scope accepted；foreign scope拒绝；Outcome scope缺失fail-closed；canonical key order不影响匹配。动态Task scope从committed definition恢复，重启后继续校验。

## 测试和交付

旧代码先运行新增测试并记录red；实现后运行：

- final audit和所有C0/C1 integration tests；
- 真实EventLog Scheduler+dynamic Task+reconciliation+Stage evidence；
- prefix+tail/full replay完整snapshot；
- Biome 0 warnings；Campaign tsc并列出旧导入错误；
- 8 offline和4 Pi/faux regression。

主DS需输出：

```text
docs/C1_FINAL_AUDIT_WORK_PLAN.md
docs/C1_FINAL_AUDIT_TEST_MATRIX.md
docs/C1_FINAL_AUDIT_REVIEW_REPORT.md
docs/C1_FINAL_AUDIT_IMPLEMENTATION_REPORT.md
docs/C1_FINAL_AUDIT_IMPLEMENTATION_REPORT.json
```

报告必须区分测试块和断言数、synthetic/faux/real EventLog、未实现的C2/C3/C4a，并且不宣称外部exactly-once。所有P0/P1修复和产品入口证据完成后，写`internally_verified / awaiting_external_review`，否则写`changes_required`。完成即停止，等待当前会话外部验收。
