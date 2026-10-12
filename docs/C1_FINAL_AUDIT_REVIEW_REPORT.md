# Aegis C1 Final Audit Fix (F7–F9) — Master DS Review Report

Status: **C1 internally_verified / awaiting_external_review**. C2 is NOT
implemented. External acceptance remains pending.

## 1. Baseline (pre-fix, recorded)

File: `Pi_Agent_base/runtime/dev/c1f789/baseline.txt`.

| Item | Value |
| --- | --- |
| `git rev-parse HEAD` | `00000000000000000000000000000000` (branch-ref placeholder) |
| `git reflog -1` | `972acd9 HEAD@{0}: commit: docs: record the pwn_3 re-run …` |
| Node | v26.10.0 |
| Campaign suites (pre-fix) | 14/14 exit 0 |

Environment note (unchanged): SHA256 is stubbed to all-zeros in this harness;
digest tests assert cross-path equality and helper usage.

### 1.1 Reproduced F7–F9 defects (old code, probed)

Probe: `runtime/dev/c1f789/probe.mjs`.

| id | old behavior | required |
| --- | --- | --- |
| F7 | `campaign.reconciliation.resolved` + task-Oracle success → `completed` with NO stage evidence | reuse the full completion gate (required stages/criteria) |
| F8 | `projectionSnapshot` stored only `stage_outcome_ids`; a changed stage status (same id) yielded an identical snapshot | store the complete canonical stage-Outcome projection |
| F9 | resolver called with `scope: manifest?.scope ?? null`; a foreign task scope was accepted | use `task.definition.scope` / `task.scope`; fail-closed |

## 2. Orchestration honesty

No sub-agent tool exists in this harness (read/bash/edit/write/browser only). Per
`DS_ORCHESTRATION_WORKFLOW.md §1` the master DS executed the task graph
**serially**, switching test-author / implementer / reviewer roles. No child-DS
report was fabricated. Same-model self-review is not external acceptance.

## 3. F7–F9 fixes

| id | fix | files |
| --- | --- | --- |
| F7 | the completion gate is extracted into `completeTaskIfVerified`, used by BOTH `campaign.task.completed` and `campaign.reconciliation.resolved`; reconciliation is "soft" (a failed gate leaves the item in its evidence state and records `reconciliation_reason`, never re-runs the worker); the scheduler's `reconcileStrandedRunning` commits the reconciled stage Outcomes too | `projection.mjs`, `scheduler.mjs` |
| F8 | new `canonicalStageOutcome()`; stage Outcomes are stored complete in `item.stage_outcomes` AND the `outcomes` index; `projectionSnapshot` emits the full stage-Outcome projection and the outcome index; the checkpoint persists `stage_outcomes` + `outcomes`; the `priorState` restore hydrates both | `projection.mjs`, `scheduler.mjs` |
| F9 | new `currentTaskScope(task)` = `task.definition?.scope ?? task.scope ?? null`; the resolver is called with the task scope, never `manifest.scope`; missing scope is fail-closed | `projection.mjs` |

## 4. Commands and exit codes (final)

Logs: `Pi_Agent_base/runtime/dev/c1f789/verify/`.

| command | exit | ok |
| --- | --- | --- |
| `aegis-campaign-closure-c0.mjs` | 0 | 39 |
| `aegis-campaign-contracts-c0.mjs` | 0 | 58 |
| `aegis-campaign-fixture-c0.mjs` | 0 | 22 |
| `aegis-campaign-c1-event-projection.mjs` | 0 | 22 |
| `aegis-campaign-c1-scheduler.mjs` | 0 | 12 |
| `aegis-campaign-c1-ownership.mjs` | 0 | 16 |
| `aegis-campaign-c1-recovery.mjs` | 0 | 5 |
| `aegis-campaign-c1-closure.mjs` | 0 | 29 |
| `aegis-campaign-c1-eventlog-durability.mjs` | 0 | 3 |
| `aegis-campaign-c1-integration-contracts.mjs` | 0 | 21 |
| `aegis-campaign-c1-integration-scheduler.mjs` | 0 | 16 |
| `aegis-campaign-c1-integration-recovery.mjs` | 0 | 5 |
| `aegis-campaign-c1-integration-e2e.mjs` | 0 | 6 |
| `aegis-campaign-c1-final-audit.mjs` | 0 | 19 |
| `aegis-campaign-c1-final-audit2.mjs` | 0 | 17 |
| `biome check …` | 0 | **0 warnings** |
| `tsc -p tsconfig.aegis-campaign.json` | 1 | **0 campaign errors**; 10 pre-existing import errors |

Regression (all exit 0): 8 offline suites and 4 real-Pi/faux suites.

## 5. Red → green

`aegis-campaign-c1-final-audit2.mjs` failed **10** assertions on the pre-fix code
(F7-NO-STAGE, F7-MISSING-CRIT, F7-FOREIGN-STAGE, F7-SUPERSEDED, F8-STATUS,
F8-CRITERION, F8-SCOPE, F8-OUTCOME-INDEX, F8-PREFIX-FULL, F9-FOREIGN-PROJECTION).

## 6. Mutation results

| mutation | case | expected | actual |
| --- | --- | --- | --- |
| reconciliation skips the stage gate | F7-NO-STAGE… | FAIL | FAIL (4) |
| snapshot keeps only `stage_outcome_ids` | F8-STATUS/CRITERION/SCOPE | FAIL | FAIL (3) |
| resolver uses `manifest.scope` instead of the task scope | F9-FOREIGN-PROJECTION | FAIL | FAIL (1) |

## 7. Product-path evidence (Scheduler + real EventLog)

- **E2E-FAULT / recover**: a SIGKILL after the durable intent; the recovery run
  reconciles via `oracle.reconcile` reading the real sentinel, commits the
  reconciled **stage** Outcomes + task Outcome, and the stranded task reaches
  `state === "completed"` with a matched `outcome_id` and both stage outcomes
  recorded; the worker is not re-run.
- **E2E-F9-SCOPE / scope_reject**: a task declaring `scope {env:prod}`; the
  Oracle returns a foreign `{env:dev}` Outcome; the projection records the scope
  rejection reason and the task is not completed.
- **E2E-NORMAL / CONTROL**: unchanged from the previous round (real EventLog,
  event-driven dynamic task, budget conservation, prefix+tail snapshot equality).

## 8. Synthetic vs real

- Synthetic Worker/Oracle with real temp-file effects and the **real** EventLog.
- The recovery harnesses are labelled synthetic for the Worker/Oracle; durability
  is proven through the real `EventLog`.
- Real SHA256 values are unavailable in this harness (stubbed); digest tests
  assert cross-path equality, not a fixed real hash.

## 9. Cross-module review findings

Files read end-to-end: all 17 `memory/campaign/*.mjs`, all 15 campaign tests,
the 6 helpers, `tsconfig.aegis-campaign.json`.

| severity | finding | status |
| --- | --- | --- |
| P0 | reconciliation bypassed the required-stage gate | fixed (F7) |
| P1 | snapshot/checkpoint/digest collapsed stage Outcomes to ids | fixed (F8) |
| P1 | resolver used `manifest.scope`, skipping task scope | fixed (F9) |
| P2 | the F1 reconciliation test encoded the pre-F7 behavior | updated to supply stage evidence (real assertions preserved) |

No open P0/P1.

## 10. What this does NOT prove

- External side-effect exactly-once (no Broker/executor idempotency).
- C2 real Pi Host-level Session rotation, C3 real Broker/Oracle adapters,
  C4/C4a Web UI and Pi `/aegis` commands.
- Real CTF / penetration / remote target / network / credentials.
- Distributed (multi-host) ownership.
- Real SHA256 values in this harness (stubbed).
- A whole-repo tsc-clean state (10 pre-existing import errors).

`Aegis did not automatically invoke gpt-6.1-sol. No real target network or
credential access was used. Synthetic/faux evidence is labeled. Session count is
not independent Episode count. Unknown is not failure. External side-effect
exactly-once is NOT claimed. Status: C1 internally_verified /
awaiting_external_review.`
