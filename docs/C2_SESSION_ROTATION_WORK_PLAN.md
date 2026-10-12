# C2 Session Rotation — Work Plan and Frozen Contract

Status: **frozen before implementation**. Scope follows
`C2_SESSION_ROTATION_TASK.md` and `CAMPAIGN_ARCHITECTURE.md` §3.3 / Phase C2.
This plan does not reopen C1 and does not implement C3-C4a.

Branch: `feat/c2-session-rotation`
Baseline (recorded before any change):

- Aegis parent repo HEAD `3fe5f90`, tree clean, branch `feat/c2-session-rotation`
  (created from `audit/c1-external-boundaries` @ `3fe5f90`).
- Embedded Pi nested repo HEAD `42a3497d0`, clean.
- Both `git status --short` were empty at the start of C2.

## 1. Verified real SDK API (not from memory)

Read from the embedded Pi source at the recorded HEAD:

`pi/packages/coding-agent/src/core/agent-session-runtime.ts`

```text
class AgentSessionRuntime
  get session(): AgentSession
  setRebindSession(fn?)
  async newSession(options?: {
      parentSession?: string;
      setup?: (sessionManager) => Promise<void>;
      withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
    }): Promise<{ cancelled: boolean }>
```

Observed behavior (source-level, not assumed):

- `newSession` first emits a cancellable `session_before_switch`; a handler
  returning `{ cancel: true }` yields `{ cancelled: true }` with no replacement.
- It aborts the current session, emits `session_shutdown`, then calls
  `createRuntime(...)` to build a **genuinely new** `AgentSession` + services,
  `apply()`s it, then runs `rebindSession(newSession)` and finally
  `withSession(replacedContext)`.
- **Creation failures are thrown/propagated to the caller** — there is no
  `{ ok:false }`. The caller must catch and must not record success.
- Pi itself does not enforce an idle/settle gate; `newSession` calls
  `this.session.abort()`. The **Host owns choosing the safe boundary**.

The existing `memory/runtime/handoff-host.mjs::applyStagedHandoff({ eventLogPath,
handoffPath, runtime, taskId, continuation })` already calls this real path and
catches creation failure / cancellation. C2 reuses it; it does not create a
parallel framework.

## 2. Frozen contract (inputs / outputs / trust / failure / idempotency)

### 2.1 Host-level supervisor entry (new, small)

`memory/runtime/session-supervisor.mjs` — a thin Host/scheduler-facing supervisor
that owns *when* a rotation is legal and *how* continuity is checked. It is NOT a
second scheduler and does NOT touch the Pi UI.

```text
createSessionSupervisor({
  eventLogPath,        // committed EventLog path (authoritative)
  handoffPath,         // staged handoff projection path
  runtime,             // real AgentSessionRuntime (has newSession)
  taskId,              // Host-owned task binding
  budget,              // trusted Campaign/Session budget ledger (optional)
  continuation,        // (handoff) => string  (bounded RAM message)
  now,                 // trusted clock (defaults Date)
})

supervisor.rotate({ requestId?, reason? }) -> Promise<{
  applied: boolean,
  cancelled?: boolean,
  reason?: string,
  request_id?: string,
  episode_id?: string,
  reused?: boolean,          // idempotent replay: prior completion reused
  budget_before?: object,
  budget_after?: object,
  new_session_id?: string,
}>
supervisor.canRotate() -> { allowed, reason, blocking[] }  // read-only precheck
supervisor.recoverInterrupted() -> Promise<{ recovered, applied?, reason? }>
```

Trust rules:

- Budget/state are **re-derived from committed events** at rotation time; the
  staged file is never trusted verbatim.
- `rotate()` refuses unless: episode open/active; no in-flight side effect;
  no unknown/unresolved side effect; budget permits another session; the
  campaign handoff request (if any) matches the staged request id.
- The supervisor **never** emits `handoff.completed` itself; the new session's
  `session_start` (Observer) owns it, exactly as today. The supervisor verifies
  the completion landed exactly once and reports the observed new session id.

### 2.2 Campaign/Host handoff events (wire-up, not new semantics)

`campaign.handoff.requested` / `campaign.handoff.completed` are already in
`EVENT_TYPE_SCHEMA`/`event-contract.mjs` with allowed sources `runtime`/`human`
and are already no-ops in the projection. C2 wires the **Host/scheduler** to
emit them around a real rotation so a Campaign-scoped audit trail exists:

- `requested`: emitted (runtime) when a rotation is decided, before
  `newSession`, carrying `{ request_id, episode_id, task_id, reason,
  session_generation_before }`.
- `completed`: emitted by the **new session's** `session_start` path (the
  Observer already does this for the runtime episode stream). At the Campaign
  layer, the scheduler records completion only after `applyStagedHandoff`
  confirms `applied && verified`.

### 2.3 Continuity invariants (must hold after rotation)

- `campaign_id` / `task_id` / `episode_id` unchanged (no new episode).
- authorization, goal, current stage, effective facts, unknowns and
  pending-recovery info preserved from committed state.
- cumulative budget usage **not reset**: `budget_before == budget_after` for
  consumed accumulators except for the legitimate per-dispatch session-count
  increment; remaining never increases across a rotation.
- the new context receives only a **bounded RAM package** built from committed
  state (`buildRam`), never the old transcript; no `session_count` reset.

### 2.4 Failure / cancel / idempotency

- `session_before_switch` cancel ⇒ `{ applied:false, cancelled:true }`; staged
  request retained; no `handoff.completed`; no budget change.
- creation throws ⇒ `{ applied:false, reason }`; staged request retained; no
  completion; no double accounting.
- replayed request id whose completion already exists ⇒ `{ applied:true,
  reused:true }`; the runtime is **not** replaced again; no second completion
  and no second budget charge.
- interrupted handoff (staged + no completion) ⇒ `recoverInterrupted()` may
  re-apply once through the same path; it never re-runs an unconfirmed
  side-effecting Task action (it only rebinds the session).

## 3. Explicit non-goals (deferred / out of scope)

- F16 cache optimization / prefix read counts — deferred, not a C2 gate.
- C3 Broker/Oracle adapters, C4/C4a UI — out of scope.
- Real model/network/target calls; embedded Pi core, credentials, model
  settings, lockfiles — untouched.
- No default "two-session" limit and no "must have no pending Oracle" product
  rule beyond the frozen safety rules in §2.1.

## 4. Frozen test matrix

See `docs/C2_SESSION_ROTATION_TEST_MATRIX.md`. Required cases cover: normal real
SDK rotation through the Host/scheduler product entry, continuity (episode /
budget / facts / unknown / pending), safety & budget refusal, failure & cancel,
idempotent replay & interrupted recovery, and C1/affected regressions.

## 5. Task order

1. Freeze this plan + matrix (this commit).
2. Write the C2 test file (faux provider + real SDK via source resolver),
   observe red for the new supervisor/entry points.
3. Implement `session-supervisor.mjs` and the minimal Host/scheduler wire-up.
4. Focused green + regressions + Biome + tsc; record exit codes honestly.
5. Limited mutation on the critical guards; self-review the final diff; commit.

## 6. Known limitations carried into delivery

- Campaign tsc has pre-existing import diagnostics (2 fixture/contracts + 8
  runtime/events) that are NOT claimed fixed here.
- `OVERNIGHT_C2_*.md` is an unrelated earlier "Batch C2" data-use-loop report
  and is NOT this C2.
