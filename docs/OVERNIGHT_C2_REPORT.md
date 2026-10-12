# Overnight Batch C2 — Integration Report (DS coder scope)

Scope: close the C code-correctness findings in `docs/OVERNIGHT_C_AUDIT.md`
(10 items) AND finish the data-use-stage loop (observe → bind → execute →
verified stage → contribution) end-to-end in a fresh **same-prompt** real-Pi
flow, without weakening any existing assertion and without touching B2-owned
core evidence gates.

This report deliberately separates **library green** (a module/test passes in
isolation) from **actually wired** (a real product path exercises it). See the
last section before trusting any green.

## What changed (files)

- `memory/runtime/action-runtime.mjs`
  - `createEventRefResolver({events, workspaceRoot, supersededOutcomeIds})`:
    rebuilds the ref index from the **committed event log** (survives restart).
    Indexes observations by `event_id`, actions by `action_id` (paired
    requested/completed; requested-only stays `status:"pending"`), outcomes by
    `payload.outcome_id` with a `superseded` flag. Outcome evidence **unions**
    payload refs + row-level `evidence_refs` (the Observer attaches the data ref
    at the row level; the contract attaches artifact/action refs in the payload —
    reading only the payload silently dropped the data ref).
  - `dataCurrent(record)` re-checks the workspace target digest at resolve time
    and now surfaces `current_expected`/`current_observed`.
  - `runtime.run({..., data_bindings, resolver})`: resolves bindings to
    `final_arguments` **before any effect**; refuses on undeclared param,
    non-object binding, missing ref/field, unresolved/cross-episode/unverified
    ref, stale target, missing field, or explicit-argument contradiction; coerces
    the bound value to the declared parameter type. Returns `use_refs`,
    `resolved_bindings`, `final_arguments`, and `stale_targets` on a refusal.
- `memory/runtime/board.mjs`
  - observation→Fact now requires a non-null observed value + evidence +
    revision (else downgraded to a Hint).
  - `resolveEnvironmentChanges` can now stale an **observation-derived** Fact
    (no `outcome_id`) by indexing rows by their own `event_id`; scope still
    matches exactly and a scope-less change still stales nothing (no broad
    clearing).
- `memory/runtime/script-registry.mjs`: `direction` validated when present;
  `validateResourceParams` exported and run **before spawn**; `observed` carries
  `resource_bindings`; `evidence_refs` carries `context.use_refs`;
  `schema_version:"1.0"`; `scope:script.<id>@<version>`.
- `memory/runtime/workspace-info-actions.mjs`: observation `scope:path`;
  `stepOutcome.schema_version:"1.0"`; `observed:null` for non-success/failure.
- `memory/runtime/action-contract.mjs`: additive `transport.attempts` +
  `transport.retry_allowed` (honest accounting when `observed` must be `null`).
- `memory/runtime/state.mjs`: `aegis_observe` added to `CONTROL_TOOLS` (read-only).
- `extensions/aegis-observer.ts`
  - canonical action id = Pi `toolCallId` for `aegis_observe`/`aegis_execute`
    (fixes pending-forever); `tool_result` hook **skips own tools** (fixes
    double-completion).
  - audit-before-effect, fail-closed on `auditUnavailable`/unhealthy log; a
    post-effect append failure sets `degraded` and the result TEXT warns the
    effect was generated but **NOT recorded/verified**.
  - `aegis_observe` returns verified-only `data_ref` + `fields` **in the
    model-visible TEXT** (Pi only sends `content`, not `details`).
  - `aegis_execute` gains `data_bindings`; logs authorization
    `{mode, source, scope, granted, per_call_human_record:false}`; runs the
    pre-effect resource check; resolves bindings with the trusted resolver;
    records `use_refs`/`final_arguments` on `action.completed`; emits
    `data.use.bound` notes + `obtain`/`use`/`advance` contributions via the
    (read-only) B2 `recordStageContribution`/`contributionPayload`. On a
    target-change refusal it emits a TRUSTED, SPECIFIC-scope
    `environment.changed` so the effective view retires exactly the affected
    Fact.
  - stage Outcome refs use `payload.outcome_id` (the judgement id) — NOT the row
    `event_id` — because the contribution API resolves outcomes by
    `outcome_id`.
- `contest/daily.mjs`: fixed the `unresolved_actions` object-vs-array count bug;
  added `contributions`, `contribution_refs` (actual data/action/outcome refs,
  association-only), `current_outcomes` (excludes superseded),
  `superseded_outcomes`, `healthy`, `stage_useful_contributions`, plus the table
  column and the "actual data-stage contribution refs" section.

No change was made to B2 core evidence gates (`experience-compiler.mjs`,
`contribution.mjs`, `learning-router.mjs`). `contribution.mjs` is **imported and
called**, never modified.

## Tests

### Preserved (must stay green, NOT weakened)
- `tests/aegis-observe-actions.mjs` (offline) — PASS. The timeout assertion was
  **relocated** to `step_outcome.observed === null` + `transport.attempts === 1`
  + `transport.retry_allowed === false` (schema-legal: a timeout's Outcome
  `observed` is `null`; the attempt/retry facts belong on transport).
- `tests/aegis-observer-verify-first-pi.mjs` (real Pi) — PASS.

### New / extended
- `tests/aegis-observer-data-use-pi.mjs` (real Pi, faux provider) — PASS. Same
  prompt: `aegis_observe` → read `data_ref` from tool TEXT → `aegis_execute`
  binding the observed `bits` → pinned temp script → registered Oracle reads the
  JSON post-state → `obtain`/`use`/`advance` contributions. Negatives:
  contradiction, foreign/missing ref, missing field, **changed target (stale) →
  refused + trusted scoped `environment.changed`**, unverified ref, and a
  pending/completion regression (no unresolved action left).
- `tests/aegis-observe-actions.mjs` gained offline negatives: resource path
  outside the workspace refused before the effect; `..` path refused; data
  binding resolves the exact verified field (not a hardcoded bit); stale ref
  refused; cross-episode ref refused; unverified ref refused; declaration
  direction validated.
- `tests/aegis-runtime-effective-board.mjs` gained: an observation-derived Fact
  (no `outcome_id`) is staled by an exact-scope change; a DIFFERENT scope is not
  broadly cleared; a scope-less change stales nothing.
- `tests/aegis-runtime-core-smoke.mjs` fixture now carries a real value +
  evidence + fingerprint.

### Full run (all EXIT=0)
```
node tests/aegis-observe-actions.mjs
node tests/aegis-runtime-core-smoke.mjs
node tests/aegis-runtime-effective-board.mjs
node --import ./pi/packages/coding-agent/src/experimental/source-resolver.ts \
  tests/aegis-observer-verify-first-pi.mjs
  tests/aegis-observer-data-use-pi.mjs
  tests/aegis-observer-outcome-command.mjs
  tests/aegis-observer-runtime-handoff.mjs
  tests/aegis-observer-failclosed-pi.mjs
  tests/aegis-observer-contest-pi.mjs
  tests/aegis-contest-pi-integration.mjs
  tests/contest-pipeline-smoke.mjs
  tests/contest-smoke.mjs
  tests/memory-runtime-batch-b-smoke.mjs
  tests/memory-runtime-learning-evidence-smoke.mjs
  tests/compile-live-experience-smoke.mjs
  tests/live-oracle-smoke.mjs
  tests/replay-oracle-smoke.mjs
  tests/observer-smoke.mjs
  tests/aegis-workflow-evidence-d.mjs
```

## Audit findings → status

1. action_id across requested/completed/data/outcome — **fixed** (toolCallId);
   pending clears (tested). No hook duplicate.
2. tool_result double-completion — **fixed** (own tools skipped).
3. skip-guard / no silent recovery / honest degrade — **fixed** (audit before
   effect; `degraded` + explicit TEXT warning; refusal on admission failure).
4. step Outcome `schema_version=1.0`, `unknown.observed=null`, legal
   `failure_mode`, `episode_id`, observation evidence+version — **fixed**;
   board Fact gate hardened.
5. hardcoded bits proof — **fixed**: `data_bindings` + resolver; final bound args
   logged; contradiction refused.
6. replay/stale data from committed events — **fixed**: `createEventRefResolver`
   rebuilds from `log.replay()`; a changed target is refused; target change
   becomes a trusted scoped `environment.changed` (not a weak helper).
   Workspace is documented as a boundary, not an OS sandbox.
7. argv path params / authorization — **partly fixed / partly pending**: declared
   path params carry `direction` and are validated inside the workspace before
   spawn; the model cannot set target/cwd/executable/script/oracle; authorization
   source/scope is logged with `per_call_human_record:false`. UNDECLARED path
   params remain plain data → see `docs/OVERNIGHT_C2_PENDING.md` #2.
8. B2 contribution only after real completed + exact refs — **fixed**: `obtain`
   after verified observation, `use`/`advance` after verified script success,
   each naming the exact data + action + trusted step Outcome refs; test drives
   `bits` dynamically from the tool result `data_ref`.
9. pipeline regression — **tested**: empty pending, same-prompt data visibility,
   handoff not blocked.
10. Compiler/Router are tested libraries — **unchanged, not claimed wired**; see
    "library green vs actually wired".

## Library green vs actually wired

- **Actually wired into the real product path (real Pi + Observer extension):**
  `aegis_observe` verified data_ref in tool TEXT; `aegis_execute` binding that
  ref and running a human-registered pinned script with a registered Oracle
  reading the real post-state; `action.completed` with `use_refs`/`final_arguments`;
  `obtain`/`use`/`advance` contributions; scoped `environment.changed` on a
  target change; the daily report reading these from the task-scoped EventLog.
- **Library green only (NOT proven wired into a production Skill/contest path):**
  the B2 experience **Compiler** and **Learning Router**. They pass their own
  suites, and C2 now feeds them real resolver-compatible refs, but no production
  path compiles a script from an active Experience or routes on one. Do not read
  "compiler/router tests pass" as "the product compiles and routes".
- **Proven only for one contract:** the observation/data-use loop is exercised
  for `workspace.identify_elf` + a single registered test script. More observation
  contracts are pending (see `OVERNIGHT_C2_PENDING.md` #4).

## Known honest limits

- The workspace is a **target boundary, not an OS sandbox**; a registered script
  runs with the user's full privileges.
- `AEGIS_ACTION_APPROVED` is a **per-process** grant, not a per-user approval
  record (the log now says so explicitly).
- Contributions are **association-only, `causal:false`**; `stage_useful` is
  descriptive, not a causal proof.
- Undeclared path parameters are not workspace-bounded (fail-closed only when
  `direction` is declared).
