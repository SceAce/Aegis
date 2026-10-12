# Aegis C1 Final Audit Fix (F7–F9) — Master Work Plan

Status: `C1 internally_verified / awaiting_external_review` (all subtasks done). C2 NOT implemented.
C2 is NOT implemented.

Owner: main DS (this session). No sub-agent tool exists in this harness (only
read/bash/edit/write/browser). Per `DS_ORCHESTRATION_WORKFLOW.md §1` the task
graph is executed **serially** with explicit test-author / implementer / reviewer
role switches. No child-DS report is fabricated.

## 0. Baseline (recorded before any edit)

File: `Pi_Agent_base/runtime/dev/c1f789/baseline.txt`.

| Item | Value |
| --- | --- |
| `git rev-parse HEAD` | `00000000000000000000000000000000` (branch-ref placeholder) |
| `git reflog -1` | `972acd9 HEAD@{0}: commit: docs: record the pwn_3 re-run …` |
| Node | v26.10.0 |
| Campaign suites (pre-fix) | 14/14 exit 0 |

Environment note (unchanged): SHA256 is stubbed to all-zeros in this harness;
digest tests assert cross-path equality and helper usage.

### 0.1 Reproduced F7–F9 defects (old code, probed)

Probe: `runtime/dev/c1f789/probe.mjs`.

| id | old behavior | required |
| --- | --- | --- |
| F7 | `campaign.reconciliation.resolved` + task-Oracle success → `completed` with NO stage evidence | reuse the full `campaign.task.completed` gate (required stages/criteria) |
| F8 | `projectionSnapshot` stores only `stage_outcome_ids`; a changed stage status (same id) yields an identical snapshot | store the complete canonical stage-Outcome projection |
| F9 | resolver called with `scope: manifest?.scope ?? null`; a foreign task scope is accepted | use `task.definition.scope` / `task.scope`; fail-closed on missing |

## 1. Frozen interfaces

- `resolveTaskOutcome({ result, task, episodeId, scope, artifacts, eventSource })`
  — unchanged signature; `scope` must be the trusted current task scope.
- `resolveTaskFromOutcomes({ ... same ... })`.
- projection queue item `stage_outcomes`: each entry is the full canonical
  Outcome (id/status/task/episode/step/criterion/scope/oracle/provenance/
  evidence_refs/supersedes).
- `projectionSnapshot(projection)` → complete projection: tasks carry
  `stage_outcomes` (full), `definition`, outcome refs; plus `proposals`,
  `outcomes` (task+stage), `budget`, `control`, tail.
- new `currentTaskScope(task)` helper: `task.definition?.scope ?? task.scope ?? null`.

## 2. File ownership

| Subtask | Files | Owner |
| --- | --- | --- |
| FINAL-BASE | plan/matrix, private snapshot | main DS |
| FINAL-TEST | new F7–F9 tests | main DS |
| FINAL-RECON | `projection.mjs` (reconciliation.resolved) | main DS |
| FINAL-SNAPSHOT | `projection.mjs` (snapshot/outcomes index), `scheduler.mjs` (checkpoint) | main DS |
| FINAL-SCOPE | `projection.mjs` (resolver calls) | main DS |
| FINAL-E2E | product harness/test | main DS |
| FINAL-REVIEW | regression, mutation, reports | main DS |

`projection.mjs` and `scheduler.mjs` are shared; one writer (main DS) serially
sections them.

Explicitly **not** modified: embedded Pi core, credentials, model settings,
lockfiles, deleted Python tree, root `AGENTS.md`, `memory/runtime/events.mjs`.

## 3. Task graph

```text
FINAL-BASE      baseline + interfaces + matrix          [done]
FINAL-TEST      red tests for F7..F9                     [done]
FINAL-RECON     reconciliation reuses the Stage gate     [done]
FINAL-SNAPSHOT  complete stage-Outcome projection        [done]
FINAL-SCOPE     task definition scope into the resolver  [done]
FINAL-E2E       product scenario + prefix/full + rebuild [done]
FINAL-REVIEW    full review + mutation + regression       [done]
```

## 4. Failure semantics (frozen)

- A reconciliation `success` completes a task ONLY through the same gate as
  `campaign.task.completed`: current task-Oracle success + all required stages +
  all criteria + bindings + evidence + no superseded/stale/conflicting stage.
  Otherwise the task stays `waiting_oracle`/`unknown`, never re-runs the worker.
- `projectionSnapshot`, checkpoint, projection digest and prefix+tail/full
  replay compare the COMPLETE stage-Outcome projection, not only ids.
- The resolver scope is the trusted current task scope; a missing scope is
  fail-closed; canonical key order does not change matching.

## 5. Stop conditions

Stop a subtask and record a blocker only if a user-confirmed data model /
permission boundary / evidence gate must change, Pi core must change, or a real
external dependency is required. Otherwise proceed autonomously. C2 not started.

## 6. Deliverables

`docs/C1_FINAL_AUDIT_WORK_PLAN.md` (this file),
`docs/C1_FINAL_AUDIT_TEST_MATRIX.md`,
`docs/C1_FINAL_AUDIT_REVIEW_REPORT.md`,
`docs/C1_FINAL_AUDIT_IMPLEMENTATION_REPORT.{md,json}`.
