# Aegis C1 Integration Closure — Master Work Plan

Status: `internally_verified / awaiting_external_review` (all subtasks done). C2 NOT implemented.
C2 is NOT implemented.

Owner: main DS (this session). No sub-agent tool exists in this harness (only
read/bash/edit/write/browser). Per `DS_ORCHESTRATION_WORKFLOW.md §1`, the task
graph is executed **serially** with explicit test-author / implementer / reviewer
role switches. No child-DS report is fabricated.

## 0. Baseline (recorded before any edit)

File: `Pi_Agent_base/runtime/dev/c1int/baseline.txt`.

| Item | Value |
| --- | --- |
| `git rev-parse HEAD` | `00000000000000000000000000000000` |
| `git reflog -1` | `972acd9 HEAD@{0}: commit: docs: record the pwn_3 re-run …` |
| `.git/refs/heads/main` | literally `00000000000000000000000000000000` |
| Node | v26.10.0 |
| Biome | 2.3.5 |
| Campaign suites (pre-fix) | 9/9 exit 0 (204 `ok` blocks) |
| Biome campaign | exit 0, 0 warnings |

### 0.1 Environment anomaly (must be recorded honestly)

`crypto.createHash`, `crypto.randomUUID`, `crypto.webcrypto.subtle.digest`,
`shasum`, `md5` and `sha256sum` ALL return the deterministic placeholder
`00000000000000000000000000000000` in this harness. There is no `NODE_OPTIONS`
preload. Consequence: **real SHA256 values are unavailable here**. The `HEAD`
value is a real branch-ref placeholder, not proof that the repo has no commits;
the true tip is `972acd9` from the reflog. All digest-based tests therefore
assert *structural equality between two real code paths* (which holds under the
stub) and *that the real helper is used*, never a hard-coded real digest. This is
reported as `environment: sha256 unavailable` with the raw command output.

### 0.2 Reproduced C1EXT defects (old code, probed)

Probe script: `runtime/dev/c1int/probe_ext.mjs` (private).

| ext | old behavior | required |
| --- | --- | --- |
| C1EXT-01 | `oracle.result` accepts a bare `status:"success"`; `task.completed` accepts any historical success; foreign episode/criterion/no-evidence still completes | full Outcome binding via a resolver |
| C1EXT-02 | only `started.append` is checked; consumed/result/completed/unknown/reconcile/stop failures still return `ok:true, reasons:[]` | unified durable commit; failure ⇒ degraded + stop new dispatch |
| C1EXT-03 | scheduler reads a checkpoint but ignores tail/projection digest; `used_checkpoint` is true without using cache state; `projection_digest` is a local rolling hash named `sha256:local-*` | real prefix+tail recovery; SHA256 via existing helper; `used_checkpoint` only when state is used |
| C1EXT-04 | `ordered.sort` compares `event.sequence` first ⇒ per-Episode reset/null reorders the log | reduce strictly in verified append order |
| C1EXT-05 | `proposal.submitted` is a no-op; `admitted` accepts inline objects with no prior submitted; scheduler stays on the initial `ownedTasks` and silently breaks | submitted index + digest binding; admitted carries the full Task definition; scheduler resolves tasks from the projection |
| C1EXT-06 | gate borrows Campaign remaining but consumption requires the task reservation ⇒ worker runs, consumption is rejected, run returns ok with consumed 0 | reserve-before-effect; strict per-task gate; record known cost on failure/unknown |
| C1EXT-07 | `campaignState` starts `running`; `campaign.campaign.stopped` is a no-op; stranded recovery only writes `reconciliation.requested` and never applies a judgment | control state from the projection; explicit resume; reconcile applies outcomes |

## 1. Frozen shared interfaces

1. **Verified committed stream** — `stream.mjs`:
   `{ ok, events, offsets, tail_offset, tail_digest, tail_event_id, health }`
   where `offsets[i]` is the physical append index and `events` is in append
   order (never re-sorted by `sequence`).
2. **Proposal index + full Task definition** — projection state:
   `proposals: Map<proposal_id, {digest, event_offset, proposal}>`, and a
   dynamic task row carries `definition` (goal, stages/criteria, scope, target,
   capabilities, oracle_ref, stop_condition, parent chain, reservation,
   `semantic_key`).
3. **Outcome resolver** — `outcome-resolver.mjs`:
   `resolveOutcome({outcome, task, episodeId, scope, artifacts}) -> {ok, status, reasons}`
   reusing C0 `validateTaskOracleBinding`/`aggregateStage`/`aggregateTask`.
4. **Ledger + dispatch permit** — projection `budget` (reserved/consumed/
   released) plus `canDispatch({task, ledger, need})` requiring the task's own
   persisted reservation (no Campaign borrowing).
5. **Campaign control state** — projection `control: {state, reason, offset}` from
   committed events (`running|paused|cancelled|budget_stopped|stopped`).
6. **Checkpoint snapshot + replay tail** — `ownership.mjs` checkpoint carrying
   `stream_offset`, `tail_digest`, `snapshot_digest`, `payload_digest`,
   `schema_version`, `projection_version`, `manifest_digest`, `state_revision`.

## 2. File ownership (frozen)

| Subtask | Files | Owner |
| --- | --- | --- |
| INT-BASE | plan/matrix, private snapshot | main DS |
| INT-TEST | new tests + helpers | main DS |
| INT-ORDER | `memory/campaign/stream.mjs` (new), `projection.mjs` | main DS |
| INT-OUTCOME | `memory/campaign/outcome-resolver.mjs` (new), `projection.mjs` | main DS |
| INT-DYNAMIC | `projection.mjs`, `dynamic-policy.mjs`, `scheduler.mjs` | main DS |
| INT-BUDGET | `projection.mjs`, `scheduler.mjs` | main DS |
| INT-COMMIT | `scheduler.mjs`, `ownership.mjs` | main DS |
| INT-RECOVERY | `projection.mjs`, `scheduler.mjs` | main DS |
| INT-CHECKPOINT | `ownership.mjs`, `scheduler.mjs` | main DS |
| INT-E2E | tests/helpers, product scenario tests | main DS |
| INT-REVIEW | docs, runner | main DS |

`projection.mjs` and `scheduler.mjs` are shared files; one writer (main DS)
serially sections them. No concurrent overwrite.

Explicitly **not** modified: embedded Pi core, credentials, model settings,
lockfiles, deleted Python tree, root `AGENTS.md`, `memory/runtime/events.mjs`
(reused read-only), `aggregate.mjs`/`report.mjs`/`manifest.mjs` unless a reported
compatibility reason exists.

## 3. Task graph

```text
INT-BASE       baseline + interfaces + matrix            [done]
INT-TEST       seven-group red tests + product harness   [done]
INT-ORDER      stream.mjs (append order, offset, tail)   [done]
INT-OUTCOME    outcome resolver wired into projection    [done]
INT-DYNAMIC    submitted index + full task + dispatch    [done]
INT-BUDGET     reserve-before-effect, strict gate        [done]
INT-COMMIT     unified durable commit + cleanup/singleflight [done]
INT-RECOVERY   control state + reconcile + result completion [done]
INT-CHECKPOINT prefix+tail recovery + SHA256             [done]
INT-E2E        scheduler + real EventLog scenario        [done]
INT-REVIEW     full review + mutation + regression + report [done]
```

Dependencies: ORDER before OUTCOME/DYNAMIC/BUDGET/COMMIT; OUTCOME+COMMIT+BUDGET
before RECOVERY; state stable before CHECKPOINT; all before E2E/REVIEW.

## 4. Failure semantics (frozen)

- All append results are checked. `{ok:false}` / `{ok:true,durable:false}` /
  throw / fsync failure ⇒ the operation is NOT durable. Before an effect ⇒ no
  worker. After an effect ⇒ degraded, stop new dispatch, return non-ok.
- A task is `completed` only from a matched, current, verified Task Outcome with
  all required stages/criteria successful. Historical success is never a permit.
- `dispatch` requires the task's own reservation on every dimension (no borrowing).
- Terminal control states survive restart; `run()` never implicitly resumes.
- Reconcile is consulted for stranded intents; it either commits a full Outcome
  (worker not re-run) or records "not done" (no blind non-idempotent retry).

## 5. Stop conditions

Stop a subtask and record a blocker if: a user-confirmed data model / permission
boundary / evidence gate must change; Pi core must change; a real external
dependency or real model is needed. Otherwise proceed autonomously.

## 6. Deliverables

`docs/C1_INTEGRATION_WORK_PLAN.md` (this file),
`docs/C1_INTEGRATION_TEST_MATRIX.md`,
`docs/C1_INTEGRATION_REVIEW_REPORT.md`,
`docs/C1_INTEGRATION_IMPLEMENTATION_REPORT.{md,json}`.
