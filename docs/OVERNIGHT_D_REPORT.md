# Overnight D — Evidence resolver + verified workflow (report)

Scope: `docs/OVERNIGHT_D_TASK.md`. D added **only new files**. No existing file,
`THINK.md`, Pi config, auth, Observer, action-runtime, script-registry, contest or
daily file was modified. The two runtime modules are new library files; the three
test files are new and independent. Everything below was executed locally, offline
(no network, no model), against real temp files and a real registered Node script.

## New files

| File | Kind | Lines |
| --- | --- | --- |
| `Pi_Agent_base/memory/runtime/evidence-resolver.mjs` | new library | 481 |
| `Pi_Agent_base/memory/runtime/workflow-engine.mjs` | new library | 394 |
| `Pi_Agent_base/tests/aegis-workflow-evidence-d.mjs` | new test (27 assertions) | — |
| `Pi_Agent_base/tests/aegis-workflow-engine-d.mjs` | new test (32 assertions) | — |
| `Pi_Agent_base/tests/aegis-workflow-live-script-d.mjs` | new test (14 assertions) | — |
| `docs/OVERNIGHT_D_REPORT.md` | this report | — |
| `docs/OVERNIGHT_D_PENDING.md` | pending items | — |

No existing file is edited. The resolver indexes the **already-committed** EventLog
(`verifyChain`-validated) plus the effective board projection — the same state
source the Observer/Host use — so proof can no longer be a caller-supplied Map.

## API surface

### `memory/runtime/evidence-resolver.mjs`

Exports: `createEvidenceResolver`, `evidenceEnvironment`, `idOf`, `kindOf`, `refKey`.

`createEvidenceResolver({ events, board = null, state = null, scope = null, requireChainOk = true })`
returns a **trusted** resolver object (no callback, no model text, no caller record
map is ever accepted):

- `resolveSupport({ kind, ref, ref_key }) -> { ok, record, content_digest, reason? }`
  for `kind ∈ { outcome, episode, action, artifact, data, replay, event }`.
- `ok`, `chain_ok`, `errors` — chain verification state (fail-closed).
- `getOutcome/getEpisode/getAction/getArtifact/getReplay/getData/getEvent(id)`.
- `episodeRelation(episodeId)`, `supersededOutcomeIds`, `eventsByEpisode(id)`,
  `board`, `state`, `scope`, `index { outcomes, episodes, actions, artifacts, replays, data, events }`.

`evidenceEnvironment(resolver, { environment_fingerprint, domain, permissions, task_types, registry })`
builds the compiler/router environment that carries `resolveSupport`.

Trust rules enforced (each covered by a negative test):

- chain must verify; a tampered/unknown-version log resolves **nothing**;
- only trusted source kinds are indexed; **`llm` is never evidence**;
- a `supersedes`/stale outcome in the effective view is **not** resolvable;
- a `ref.digest` must equal the real computed content digest (artifact indexed by
  **id + digest**, so a reused id still resolves by the pinned digest);
- a foreign episode/task record is refused when the resolver is bound to a task
  scope;
- a reset/isolation reference is canonical **only** when a trusted, non-model
  source recorded it (`episode.isolated_reset` / reset fields). A bare
  `episode.started` (open/projected object) resolves with `reset_proven: false`
  and `relation_status: "candidate"` — no UUID is invented to satisfy a count.

### `memory/runtime/workflow-engine.mjs`

Exports: `WORKFLOW_VERSION` (`"1.0.0"`), `assess`, `createWorkflowEngine`,
`createWorkflowResolver`.

`createWorkflowEngine({ registry, broker, authorization, resolver, replayAdapter, environment, clock })`
returns:

- `bindProposal(proposal, options?)` — delegates to the reviewed binder; returns
  `missing gaps` or `bound`. Prose `do` is never parsed/eval'd; the result always
  carries `model_text_parsed: false, eval_used: false`.
- `compileExperience({ proofs, ... })` — calls the real B2 compiler with the one
  resolver for **every** gate; can only reach `active` on two independent resolved
  replayable proofs.
- `routeLearning({ experiences, task, currentState?, episodeId? })` — passes a
  current state **only** when the chain is verified; non-active (candidate)
  experiences are dropped from the hint surface; `model_calls: 0`.
- `executeDirect({ action_ref, arguments, context, approved?, currentState? })` —
  the only execution path (the broker), with final arguments, re-derived
  authorization and recorded pre/post state digests; `model_calls: 0`.
- `bindHabit({ experiences, task, currentState?, bindings })` — merges only the
  reported missing parameters, validates them against the contract, then
  **re-checks** the route reaches `direct`.
- `replayOutcome({ outcomeId, adapter, sink, priorPreState? })` — only through an
  explicitly configured `isolated: true` adapter; refuses a changed implementation
  (`version_changed: true`), a mismatched pre-state digest, a non-isolated adapter,
  a non-success/`llm` outcome. Writes a genuine `episode.isolated_reset` +
  `replay.performed` record through the trusted sink (the single EventLog writer).
- `recordContribution(input)` — delegates to the reviewed contribution gate with
  the one resolver; association-only.
- `associateFeedback({...})` — links action + outcome, never causal; a bare
  `unknown` is never a negative; a trusted scope change / verified counterexample
  keeps the candidate or pauses the binding.
- `usefulness(records)` — read-only over recorded contributions.

`assess(result)` classifies by the **verdict** status alone. Exit code is transport,
never a verdict; a tool error / timeout is reported as an anomaly but never
relabels a broker `unknown` as a task failure.

The engine is **not** an executor or a writer: it calls the broker and hands
payloads to a trusted `sink` supplied at construction. It never mutates Experience
life-cycle rules and never writes a global Event source.

## Tested (live, offline)

Run individually; each uses its own `mkdtemp` dir and real files:

```
node Pi_Agent_base/tests/aegis-workflow-evidence-d.mjs      # 27 ok
node Pi_Agent_base/tests/aegis-workflow-engine-d.mjs        # 32 ok
node Pi_Agent_base/tests/aegis-workflow-live-script-d.mjs   # 14 ok
```

- **Resolver + compiler (`aegis-workflow-evidence-d.mjs`, 27):** parses outcomes /
  episodes / actions / artifacts / replays from a validated committed log; the
  compiler reaches `active` on two independent resolved proofs; then every
  negative: unresolvable ghost outcome, `llm` source, fake digest, foreign event
  ref, unknown outcome not counted, foreign-task outcome, shared isolation = one
  proof, changed registered version/digest, current-scope mismatch, missing replay
  record, `supersedes`, tampered chain, reused artifact id by digest.
- **Engine mechanics (`aegis-workflow-engine-d.mjs`, 32):** `bindProposal`
  bound/gaps (prose never parsed); real ELF file observation through the broker
  (success, `model_calls: 0`, real pre/post digests); non-ELF = `unknown` (never
  success); `assess` unit checks; normal mode without approval rejected / with a
  human approval runs; non-idempotent `retry: none` not auto-retried; habit
  routing + wrong-type/extra binding refused + correct binding re-checks to
  direct; candidate never hinted; changed version pauses; `replayOutcome` guard
  set + a genuine replay record; feedback unknown-not-negative and verified
  counterexample; contribution advance.
- **First full workflow on a real registered Node script
  (`aegis-workflow-live-script-d.mjs`, 14):** a deterministic stage-advance
  `.mjs` in a temp dir, registered the human way (fixed Node executable + pinned
  script digest + fixed argv template + resource-bounded `input`/`out` params +
  an independent JSON post-state Oracle). Run **twice live** in controlled
  isolation → committed as real Events → compiled into a canonical `active`
  Experience (two distinct isolation refs, real implementation digest, real
  environment scope) → routed to `habit` → missing params bound → re-checked to
  `direct` → executed a **third** time live with 0 model calls. Re-using the same
  episode does not increase independence. The two runs use different input files
  under the **same** rule (same action, same template shape), so no success-union
  or automatic scope generalization is smuggled in.

### Required negative-test coverage (task list → test)

| Required | Where |
| --- | --- |
| fake actor/source | `llm`-source outcome refused; tampered chain resolves nothing |
| fake proof | ghost `outcome_id` → candidate |
| fake ref | ghost artifact/event ref refused; digest mismatch refused |
| changed script | pinned digest ≠ registered → candidate (evidence) / pause (engine) |
| changed version | compiler `action_version`/`implementation_digest`; `bindHabit` pause; replay `version_changed` |
| currentScope | proof scope ≠ env → `scope_current` candidate |
| foreignOutcome | foreign-task outcome refused |
| supersedes | superseded outcome refused + board effective view |
| shared isolation | same group/isolation = one proof |
| unapproved | normal mode, no approval → rejected |
| no replay adapter candidate | replay with no adapter refused; no replay record → candidate |
| non-idempotent no auto-retry | `retry: none` → `attempts: 1`, `retry_allowed: false` |
| habit binding mismatch rejected | wrong type / unexpected param refused |
| direct failure / Oracle unknown not falsely learned | non-ELF `unknown`; feedback unknown not negative |

## Untested / not covered (honest limits)

- **Actor identity is structural, not cryptographic.** The resolver trusts a
  committed event's `source.kind`; there is no signature/authentication of the
  `actor_id`. A process with write access to the EventLog could forge a trusted
  `source`. Appending/forge-resistance is out of D's scope (EventLog is the single
  writer owned elsewhere).
- **Replay adapter is trusted code.** The engine verifies `isolated: true`, a
  matching pre-state digest, `replay_count ≥ 1` and a non-empty `replay_hash`, but
  it cannot prove that a hostile adapter is not secretly re-running the original
  target. Isolation is a configuration/trust boundary, not a sandbox.
- **Real network / real model / remote targets** are intentionally not used.
- **No contest-effective rate is claimed or measured.** The tests demonstrate the
  mechanism on a deterministic fixture stage file only.
- **Generalisation policy** (whether a rule may apply to new targets/scopes) is
  left as an explicit open decision — see `OVERNIGHT_D_PENDING.md`.
- The Observer/Host are **not** yet wired to call this engine/resolver (that would
  edit files owned by C2 / existing B2 libs); D exposes the library API only.

## Verified against existing B2 libs without modifying them

Consumed as-is: `events.mjs`, `board.mjs`, `state.mjs`, `experience-compiler.mjs`,
`learning-router.mjs`, `contribution.mjs`, `action-contract.mjs`,
`script-registry.mjs`, `workspace-info-actions.mjs` (and `authorization.mjs`
transitively via the broker). The existing negative suites still pass:
`memory-runtime-batch-b-smoke.mjs` (107), `aegis-runtime-effective-board.mjs` (47),
`aegis-observe-actions.mjs` (31).

`aegis-observer-verify-first-pi.mjs` cannot run in this environment because the
`@earendil-works/pi-coding-agent` package is not installed here — unrelated to D.
