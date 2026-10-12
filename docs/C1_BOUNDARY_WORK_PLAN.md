# Aegis C1 External Boundary (F10–F13) — Master Work Plan

Status: `internally_verified / awaiting_external_review` (all subtasks done). C2 NOT implemented.
C2 is NOT implemented.

## 0. Baseline (recorded before any edit)

- branch: `audit/c1-external-boundaries`
- `git rev-parse HEAD`: `00000000000000000000000000000000` (ref-file placeholder;
  the true tip from `git reflog`/`git log` is `369e1f4`
  `test: reproduce C1 scope and checkpoint failures and block C2`)
- working tree: clean at start
- red baseline: `node --test Pi_Agent_base/tests/aegis-campaign-c1-external-boundaries.mjs`
  → **exit 1, 21 cases, 3 pass / 19 fail** (log:
  `Pi_Agent_base/runtime/dev/c1boundary/red-baseline.log`). Failures are
  behavioural assertions, not import/syntax errors. The 3 passes are the two
  positive controls (CONTROL both gates, F11-PRODUCT matching scope) plus one
  matching-scope control.

Note: this harness stubs SHA256 to all-zeros; digest tests assert cross-path
change/equality, never a real hash value.

## 1. Frozen contracts

### F10 — trusted current scope
- The current scope comes from the committed Task definition / trusted Host
  environment, never guessed from the Outcome under judgment.
- Missing current scope, missing Outcome scope, or both missing ⇒ NOT a trusted
  success (fail-closed). `null` is unknown authority, not a wildcard.
- foreign scope rejected; matching scope accepted; canonical key order irrelevant.
- Static + dynamic tasks, the direct resolver, the projection and checkpoint
  restore all use the SAME resolution (`currentTaskScope`).

### F11 — complete Stage binding
After the trusted-host-source boundary, a Stage Outcome must additionally bind:
current Task, non-null matching Episode, declared stage/criterion, trusted
current scope, independent provenance, non-empty resolvable evidence, and a
present `observed` for success. `unknown`/missing/invalid/foreign/conflict keep
their meaning; no evidence is not failure. Both completion gates (normal
`campaign.task.completed` and `campaign.reconciliation.resolved`) use the single
gate; a failed gate never re-runs the worker.

### F12 — recovery and idempotency
- The checkpoint writer and the projection hydration preserve `episode_id` and
  the binding state that participates in judgment.
- `command`/`outcome` dedup survives the prefix+tail boundary; a repeated budget
  `consumed` is not double-charged; a repeated Stage Outcome is not double-counted.
- Restore uses an independent deserialized state; it never mutates the caller's
  checkpoint object.
- Missing/unsupported cache fields safely fall back to the authoritative EventLog.
- full replay and cache+tail agree on foreign bindings, unknown, ledger, dynamic
  tasks, result index and control semantics.

### F13 — complete persisted projection and real wiring
- One complete state snapshot: definitions, Episode/current binding, Stage/Task
  Outcomes, proposals, ledger, control, recovery/dedup fields.
- The state digest covers all semantic fields (including full stage Outcomes and
  definitions); stream position / non-semantic fields are explicitly excluded.
- The REAL `persistCheckpoint` persists that snapshot (not only a test helper).
- Validate the checkpoint's PREFIX state digest first, then apply the tail; never
  compare a tail-applied state digest against a prefix digest.
- The scheduler actually USES the recovered state (proved by behaviour, not by a
  boolean `used_checkpoint`).

## 2. File ownership

| Subtask | Files | Owner |
| --- | --- | --- |
| B-BASE | plan/matrix, private snapshot | main DS |
| B-SCOPE | `outcome-resolver.mjs` (scope fail-closed), `projection.mjs` (call sites) | main DS |
| B-STAGE | `outcome-resolver.mjs`, `projection.mjs` (stage ingest + gate) | main DS |
| B-RESTORE | `projection.mjs` (priorState hydration, dedup) | main DS |
| B-CACHE | `scheduler.mjs` (digest/checkpoint/prefix order), `projection.mjs` | main DS |
| B-E2E | tests/helpers | main DS |
| B-REVIEW | docs, regression, mutation, commits | main DS |

`projection.mjs` and `scheduler.mjs` are shared; one writer (main DS) serially
sections them.

Explicitly **not** modified: embedded Pi core, credentials, model settings,
lockfiles, deleted Python tree, root `AGENTS.md`, `memory/runtime/events.mjs`.

## 3. Task graph

```text
B-BASE      baseline + matrix + frozen contracts        [done]
B-SCOPE     F10 fail-closed current scope               [done]
B-STAGE     F11 full stage binding + single gate        [done]
B-RESTORE   F12 episode + dedup hydration               [done]
B-CACHE     F13 full digest + real writer + prefix order[done]
B-E2E       real EventLog/subprocess + mutation         [done]
B-REVIEW    full review + regression + reports + commits[done]
```

## 4. Failure semantics (frozen)

- No trusted success when the current scope is missing (either side).
- A Stage Outcome that is foreign/missing-scope/missing-episode/empty-evidence/
  non-independent cannot satisfy the completion gate.
- Restore preserves Episode and dedup; the real writer persists them.
- The state digest changes when any stage-Outcome semantic field changes.
- Cache is a derived cache: deleted/corrupt/foreign/stale ⇒ rebuild from the
  EventLog with no change to authorization, completion or side-effect count.

## 5. Stop conditions

Stop and record a blocker only if a user-confirmed data model / permission
boundary / evidence gate must change, Pi core must change, or a real external
dependency is required. Otherwise proceed autonomously. C2 not started.

## 6. Deliverables

`docs/C1_BOUNDARY_WORK_PLAN.md` (this file),
`docs/C1_BOUNDARY_TEST_MATRIX.md`,
`docs/C1_BOUNDARY_REVIEW_REPORT.md`,
`docs/C1_BOUNDARY_IMPLEMENTATION_REPORT.{md,json}`.
