# Aegis C1 Final Audit Fix (F7–F9) — Implementation Report

Machine-readable companion: `docs/C1_FINAL_AUDIT_IMPLEMENTATION_REPORT.json`.
Plan: `docs/C1_FINAL_AUDIT_WORK_PLAN.md`. Matrix: `docs/C1_FINAL_AUDIT_TEST_MATRIX.md`.
Review: `docs/C1_FINAL_AUDIT_REVIEW_REPORT.md`.

Status: **C1 internally_verified / awaiting_external_review**. C2 is NOT
implemented.

## 1. Orchestration

No sub-agent tool exists in this harness; the master DS ran the task graph
serially with explicit test-author / implementer / reviewer role switches. No
child-DS report was fabricated. Same-model self-review is not external acceptance.

## 2. Baseline and environment

- `git rev-parse HEAD` → `00000000000000000000000000000000` (branch-ref
  placeholder); true tip `972acd9` from the reflog.
- **SHA256 is stubbed to all-zeros in this harness.** Digest tests assert
  cross-path equality and helper usage, never hard-coded values.

## 3. F7–F9 closure

| id | fix |
| --- | --- |
| F7 | the completion gate is extracted into `completeTaskIfVerified`, used by BOTH `campaign.task.completed` and `campaign.reconciliation.resolved`; reconciliation is soft (failed gate → stays in its evidence state, records the reason); the scheduler commits the reconciled **stage** Outcomes so reconciliation cannot bypass the required-stage gate; the worker is never re-run |
| F8 | `canonicalStageOutcome()` stores the full stage Outcome in `item.stage_outcomes` and the `outcomes` index; `projectionSnapshot` emits the full stage-Outcome projection; the checkpoint persists `stage_outcomes` + `outcomes`; the `priorState` restore hydrates both |
| F9 | `currentTaskScope(task)` = `task.definition?.scope ?? task.scope ?? null` is passed to the resolver (never `manifest.scope`); a missing scope is fail-closed; canonical key order does not change matching |

## 4. Files

### Added
`tests/aegis-campaign-c1-final-audit2.mjs`.

### Modified
`memory/campaign/{projection,scheduler}.mjs`; `tests/aegis-campaign-c1-final-audit.mjs`
(F1 reconciliation tests now supply stage evidence — real assertions preserved);
`tests/aegis-campaign-c1-integration-e2e.mjs` and
`tests/helpers/campaign-product-child.mjs` (F7 recover fields + F9 scope scenario).

### Explicitly not modified
Embedded Pi core, credentials, model settings, lockfiles, deleted Python tree,
root `AGENTS.md`, `memory/runtime/events.mjs` (reused read-only).

## 5. Commands and exit codes

```text
aegis-campaign-closure-c0.mjs              exit 0  39 ok
aegis-campaign-contracts-c0.mjs            exit 0  58 ok
aegis-campaign-fixture-c0.mjs              exit 0  22 ok
aegis-campaign-c1-event-projection.mjs     exit 0  22 ok
aegis-campaign-c1-scheduler.mjs            exit 0  12 ok
aegis-campaign-c1-ownership.mjs            exit 0  16 ok
aegis-campaign-c1-recovery.mjs             exit 0   5 ok
aegis-campaign-c1-closure.mjs              exit 0  29 ok
aegis-campaign-c1-eventlog-durability.mjs  exit 0   3 ok
aegis-campaign-c1-integration-contracts.mjs exit 0 21 ok
aegis-campaign-c1-integration-scheduler.mjs exit 0 16 ok
aegis-campaign-c1-integration-recovery.mjs  exit 0  5 ok
aegis-campaign-c1-integration-e2e.mjs       exit 0  6 ok
aegis-campaign-c1-final-audit.mjs           exit 0 19 ok
aegis-campaign-c1-final-audit2.mjs          exit 0 17 ok
biome …                                     exit 0  0 warnings
tsc -p tsconfig.aegis-campaign.json         exit 1  0 campaign errors / 10 pre-existing import errors
```

Regression: 8 offline suites + 4 real-Pi/faux suites, all exit 0.

## 6. Mutation

All three F7–F9 guards are killed by a behavioural assertion: reconciliation
skipping the stage gate (4 failures), the snapshot keeping only ids (3
failures), and the resolver using `manifest.scope` (1 failure).

## 7. Product-path evidence

- **E2E-FAULT / recover**: SIGKILL after the durable intent; the recovery run
  reconciles via `oracle.reconcile` reading the real sentinel, commits the
  reconciled stage Outcomes + task Outcome, and the stranded task reaches
  `state === "completed"` with a matched `outcome_id` and both stage outcomes
  recorded; the worker is not re-run.
- **E2E-F9-SCOPE / scope_reject**: a task declares scope `{env:prod}`; the Oracle
  returns a foreign `{env:dev}` Outcome; the projection records a scope rejection
  reason and the task is not completed.
- **E2E-NORMAL / CONTROL**: unchanged (real EventLog, event-driven dynamic task,
  budget conservation, prefix+tail snapshot equality).

## 8. Synthetic vs real, and what is NOT proven

- Synthetic Worker/Oracle with real temp-file effects and the **real** EventLog.
- Recovery harnesses are labelled synthetic for the Worker/Oracle; durability is
  proven through the real `EventLog`.
- **Not proven**: external side-effect exactly-once (no Broker/executor), C2 real
  Pi Session rotation, C3 real Broker/Oracle adapters, C4/C4a UI, real
  CTF/network/credentials, distributed ownership, real SHA256 values in this
  harness, whole-repo tsc clean.

```text
Aegis did not automatically invoke gpt-6.1-sol.
No real target network or credential access was used.
Synthetic/faux evidence is labeled.
Session count is not independent Episode count.
Unknown is not failure.
External side-effect exactly-once is NOT claimed.
Status: C1 internally_verified / awaiting_external_review. C2 not started.
```
