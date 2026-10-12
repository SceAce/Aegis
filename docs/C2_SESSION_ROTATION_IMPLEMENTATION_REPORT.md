# C2 Session Rotation — Implementation Report

Status: **internally_verified / awaiting_external_review**.
Branch: `feat/c2-session-rotation`. Baseline before C2: parent repo HEAD
`3fe5f90` (clean, from `audit/c1-external-boundaries`); embedded Pi HEAD
`42a3497d0` (clean). C2 does not reopen C1 and does not enter C3.

Plan / matrix: `docs/C2_SESSION_ROTATION_WORK_PLAN.md`,
`docs/C2_SESSION_ROTATION_TEST_MATRIX.md` (frozen before implementation).

## 1. What was implemented

### 1.1 New Host/scheduler entry — `Pi_Agent_base/memory/runtime/session-supervisor.mjs`

A thin Host-level supervisor that owns *when* a rotation is legal and records
continuity across it. It reuses the existing framework rather than creating a
parallel one:

- safety + bounded RAM: `handoff.mjs` (`evaluateHandoff`) + `ram.mjs`;
- the real SDK call: the existing `handoff-host.mjs` `applyStagedHandoff`
  (which calls the real `runtime.newSession`);
- committed truth: re-derived from the `EventLog` every call, never from the
  staged file or model text.

API: `createSessionSupervisor({ eventLogPath, handoffPath, runtime, taskId,
budget, continuation })` returns `{ canRotate(), rotate({requestId, reason}),
recoverInterrupted() }`.

Owned behaviors beyond the existing helper:

1. `canRotate()` — read-only precheck; budget is checked independently so an
   exhausted ledger is reported before the safety verdict.
2. Cumulative-budget continuity: a successful rotation charges exactly one
   session generation, **derived from committed `handoff.completed` events**
   (not from the mutable caller ledger), combined with the input ledger via
   `max(...)`. Remaining can never grow and cumulative counters never reset.
3. Idempotent replay: if the request id already has a committed completion, the
   runtime is not replaced again and no second completion/charge is written.
4. `recoverInterrupted()`: a staged request with no completion is re-applied
   exactly once through the same real path; it never re-runs an unconfirmed
   Task side effect (it only rebinds the session).

### 1.2 One-line contract widening — `Pi_Agent_base/memory/runtime/handoff.mjs`

The `evaluateHandoff` JSDoc return type now declares the `pending_actions`
array it already returns, so the supervisor can read the blocking actions with a
real type instead of a cast. No behavior change.

### 1.3 No parallel framework

The existing `handoff-host.mjs` (real `newSession`, cancel/failure handling) and
the Observer's `session_start` completion owner are reused unchanged. The
`campaign.handoff.requested/completed` contract events were already registered
as accepted projection no-ops; C2 does not invent new event semantics.

## 2. Product-entry proof (C2-P1)

The real-SDK test drives `createSessionSupervisor` (the Host entry), not a
factory helper. It observes the replacement via **object identity**
(`runtime.session !== before`), distinct `sessionFile`/`sessionId`, and the
**provider request boundary** (`captured` messages), plus the committed
`handoff.completed` written by the NEW session's runtime source. It does not
rely on a returned id or text alone.

## 3. Exact commands and observed results

All run from the repo root. Logs are in ignored private paths (not committed).

### C2 required suite (real SDK + faux provider)

```bash
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/aegis-c2-session-rotation.mjs
```

- exit 0, **49 ok / 0 not ok**, stable across 3 consecutive runs.
- Covers C2-N1..N4, C2-S1..S4, C2-F1..F2, C2-I1..I2, C2-P1 (matrix §required).

### Focused regression (real SDK Host helper)

```bash
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/aegis-observer-runtime-handoff.mjs
```

- exit 0, 33 ok / 0 not ok (C2-R1). Unchanged.

### Other affected real-Pi paths

- `aegis-observer-outcome-command.mjs` — exit 0, 38 ok.
- `aegis-observer-failclosed-pi.mjs` — exit 0, 5 ok.
- `aegis-observer-data-use-pi.mjs` — exit 0, 32 ok.

### Campaign C1 suites (offline)

- `aegis-campaign-c1-event-projection.mjs` — exit 0, 22 ok (C2-R2).
- `aegis-campaign-c1-integration-scheduler.mjs` — exit 0, 16 ok (C2-R3).
- `aegis-campaign-c1-eventlog-durability.mjs` — exit 0, 3 ok (C2-R3).
- All `Pi_Agent_base/tests/aegis-campaign-*.mjs`: **17 pass / 1 non-zero**. The
  single non-zero is `aegis-campaign-c1-boundary-review.mjs`, whose only failure
  is **F16** (deferred per `C1_F14_EXTERNAL_ACCEPTANCE.md`); F14/F15 pass. This
  matches the recorded C1 baseline exactly and is not a C2 regression.

### Static checks

```bash
./Pi_Agent_base/pi/node_modules/.bin/biome check --config-path=Pi_Agent_base/aegis-biome.json \
  Pi_Agent_base/memory/runtime/session-supervisor.mjs \
  Pi_Agent_base/memory/runtime/handoff.mjs \
  Pi_Agent_base/tests/aegis-c2-session-rotation.mjs
```

- exit **0**, no warnings, no errors.

```bash
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json
```

- exit **1**, **10 errors** — exactly the pre-existing baseline (2
  `memory/fixture/contracts.mjs` + 8 `memory/runtime/events.mjs`). Unchanged by
  C2; this command is NOT claimed to pass.

Targeted type check of the new file (temporary config, not committed):

- `session-supervisor.mjs` has **0** errors. The remaining 16 diagnostics in that
  run are all pre-existing errors in dependency files
  (`board.mjs`/`events.mjs`/`handoff-host.mjs`/`ram.mjs`), none in the new file.

## 4. Limited mutation (testing standard §8)

Mutated in place, ran the C2 suite, restored byte-identical. `MUT2`/`MUT7` are
the high-value budget/continuity guards.

| mutation | case | expected | actual |
|---|---|---|---|
| MUT1 idempotency reuse block disabled | C2-I1 | FAIL | **FAIL** (caught) |
| MUT2 `rotate()` budget guard disabled | C2-S3 (rotate) | FAIL | **FAIL** (caught) |
| MUT4 idempotency `completedIds.has` disabled | C2-I1 | FAIL | **FAIL** (caught) |
| MUT6 cancel detection relaxed to false | C2-F1 | FAIL | **FAIL** (caught) |
| MUT7 session generation reset to 0 | C2-N3 | FAIL | **FAIL** (caught) |
| MUT3 `rotate()` safety verdict disabled | C2-S1 | FAIL | pass *(not caught)* |
| MUT5 `recoverInterrupted` already-done guard disabled | C2-I2 | FAIL | pass *(not caught)* |

MUT3/MUT5 are **not blind spots**: the delegated `applyStagedHandoff` (MUT3) and
`rotate()` (MUT5) independently enforce the same guard, so behavior stays
correct (defense-in-depth). No test needed to be weakened; one blind spot found
during mutation (the `rotate()` budget guard) was closed by adding an explicit
C2-S3 rotate case, after which MUT2 is caught.

## 5. Self-review findings fixed

- A genuine bug found during self-review: the initial budget report used a
  **pre-rotation** event read, so a rotation could report a stale (too small)
  session generation. Fixed by re-reading committed events after a successful
  apply. The added C2-N3 "matches committed completions + initial" assertion
  caught it (it failed before the fix).
- Removed a misleading dead "unresolved action" block in the test that the event
  projection cannot actually produce.
- Removed unused JSDoc/destructured parameters flagged by Biome.

## 6. Required vs deferred

**required (verified here):** real Host-level rotation with a genuinely new
object/context; episode/authorization/stage/fact/unknown/pending continuity;
budget continuity (no reset, generation not double-charged); safe-boundary and
budget refusal; cancel/creation-failure with no false completion; idempotent
replay and interrupted recovery; C1/affected-path regressions.

**deferred (recorded, NOT a C2 gate):**

- C2-D1 F16 checkpoint cache incrementality / prefix read counts — F16
  ownership; full EventLog replay correctness is preserved.
- C2-D2 C3 Broker/Oracle adapters and C4/C4a UI.
- C2-D3 multi-session parallel Task rotation (Campaign v1 is single active
  Task/Episode, U7).

## 7. Honest limitations

- The supervisor's budget charge is a **projection/report** derived from
  committed events; durable Campaign budget accounting remains owned by the
  scheduler's `sink`. The supervisor is the Host/scheduler *entry* intended to be
  called at a settle boundary — the C1 durable dispatch loop does not itself own
  a Pi runtime, so it is not modified to call this directly (that would invent a
  framework the task forbids).
- The embedded Pi always calls `session.abort()` inside `newSession`; the Host,
  not Pi, enforces the idle/settle boundary. The supervisor's `canRotate()`
  encodes that boundary; the caller must invoke rotation only after settle.
- Campaign `tsc` still reports its pre-existing 10 import diagnostics; not
  fixed and not claimed green.
- `docs/OVERNIGHT_C2_*.md` is an unrelated earlier "Batch C2" data-use-loop
  report and is NOT this C2.

## 8. Git

Task branch `feat/c2-session-rotation`, explicit-path staging, local commits, no
push, no history rewrite.

- `3993e00` — feat: real Host-level Pi Session rotation supervisor (C2)
  (6 files, +1310/-1). Baseline before C2: `3fe5f90`.
- Working tree clean after the commit; the 49-assertion C2 suite re-run from the
  committed tree is exit 0.

C2 self-review is not external acceptance. C3-C4a are outside this assignment.

## 9. E1/E2 external-review follow-up (changes_required → fixed)

External review `docs/C2_EXTERNAL_REVIEW.md` found two current-core counterexamples
in `702c63c`. The reviewer committed red tests `dde83a7`
(`aegis-c2-supervisor-boundaries.mjs`, `aegis-c2-budget-sdk.mjs`). Both are now
fixed with minimal wiring; no C1/F16/C3/C4 scope was added.

### E1 — committed rotation must enter the next admission gate

Root cause: the budget gate read only the caller's base ledger; committed
rotations were not part of the gate, and `max(base, localGeneration)` dropped the
new charge when pre-existing cumulative usage exceeded the local generation.

Fix (`session-supervisor.mjs`):

- new `committedRotations(events, episodeId)` counts committed
  `handoff.completed` rows bound to the episode;
- the gate is `budgetAllowsSession(budget, committedRotations)` = remaining
  `= limit - reserved - (base_consumed + committed_rotations)`; it is evaluated
  **before** `newSession`;
- the reported `budget_after.consumed.session_count = base_consumed +
  committed_rotations_after`, so it is neither reset nor double-charged.

Verified: `limit=2, base_used=1` refuses the second distinct request through a
fresh supervisor with the unchanged base ledger and never calls `newSession`;
`base_used=7, limit=8` reports `8`; a replay of the same request reuses and does
not create again. Real SDK `aegis-c2-budget-sdk.mjs` reproduces the second
refusal at the actual `runtime.session`/creation-counter level.

### E2 — completion only after a verified Host create/bind

Root cause: `applyStagedHandoff` treated a non-cancelled SDK return as verified;
and the Observer wrote `handoff.completed` inside `session_start`, which the SDK
emits inside `bindExtensions` — **before** the Host rebind/continuation cycle
finishes. A rebind that threw after `bind()` still left one completion.

Fix:

- Observer no longer writes completion in `session_start`; it now records it in
  `before_agent_start` (`recordStagedHandoffCompletion`) — the replacement
  Session's first prompt, strictly after a successful rebind — keeping the
  Observer as the single EventLog writer (a second Host writer would fork the
  chain);
- `applyStagedHandoff` no longer trusts the SDK return: after a non-cancelled
  `newSession` it reads the committed completion (`readCommittedCompletion`,
  uniqueness-checked), verifies the bound `runtime.session.sessionId` and the
  request/episode, and retires the staged file only after a verified, durable
  completion;
- `session-supervisor.rotate` independently re-verifies a unique committed
  completion bound to the episode and the bound session before returning
  `applied:true`;
- the `/aegis switch` command writes completion only after `newSession` returns
  non-cancelled (post-bind).

Verified: offline `recordCompletion:false` returns `applied:false`; the real SDK
`bind-failure` mode injects a throw after `bind()` and the committed
`handoff.completed` count stays `0` (was `1`).

### E1/E2 commands and results

```bash
node --test Pi_Agent_base/tests/aegis-c2-supervisor-boundaries.mjs            # exit 0 (4/4)
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/aegis-c2-budget-sdk.mjs                               # exit 0
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/aegis-c2-budget-sdk.mjs bind-failure                  # exit 0
```

- boundary suite: 4 tests, **4 pass / 0 fail**, exit 0 (was 1 pass / 3 fail).
- SDK cumulative budget: pass. SDK bind-failure: pass (completion=0).
- Original `aegis-c2-session-rotation.mjs`: **49 ok / 0 fail**, exit 0 (owner
  change did not weaken it).
- `aegis-observer-runtime-handoff.mjs` (manual `/aegis switch`, helper, cancel,
  creation-failure, idempotency): **33 ok**, exit 0.
- `aegis-observer-outcome-command` 38 ok; `aegis-observer-failclosed-pi` 5 ok;
  `aegis-observer-data-use-pi` 32 ok; `observer-smoke` ok.
- Campaign event-projection 22 ok, integration-scheduler 16 ok,
  eventlog-durability 3 ok.
- Biome on the four touched files: exit 0, no warnings.
- Campaign tsc: exit 1, the same 10 pre-existing diagnostics; new
  `session-supervisor.mjs` has 0 errors.

### E1/E2 limited mutation

| mutation | case | expected | actual |
|---|---|---|---|
| MUT-A gate ignores committed rotations | E1 boundary x2 + SDK | FAIL | **FAIL** (3 boundary fails) |
| MUT-E helper + supervisor both skip completion verification | E2 boundary | FAIL | **FAIL** |
| MUT-F re-add premature `session_start` completion | SDK bind-failure | FAIL | **FAIL** |
| MUT-B/C/B2 remove one verification guard only | E2 | (no change) | pass — defense-in-depth |

MUT-B/C/B2 are not blind spots: the helper, supervisor and Observer each verify
independently, so removing one guard leaves behavior correct; MUT-E proves the
chain is necessary.

### Honest limitation

The supervisor remains a **Host-callable entry**; the existing Campaign dispatch
loop is not modified to call it automatically. The trusted owners introduced in
this fix are explicit: the **Observer is the single EventLog writer** for
completion (at the post-bind `before_agent_start`), and the **supervisor is the
Host admission/verification owner** for budget and completion. No scheduling
framework was added.
