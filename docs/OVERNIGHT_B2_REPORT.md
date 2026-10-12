# Overnight Batch B2 — Focused Evidence-Discipline Repair

Scope of this repair (write scope, exactly):
- `Pi_Agent_base/memory/runtime/experience-compiler.mjs`
- `Pi_Agent_base/memory/runtime/contribution.mjs`
- `Pi_Agent_base/memory/runtime/learning-router.mjs`
- new tests + this report

All other Batch B modules were left unchanged. No schema was added, no competing
logger introduced, no Observer/events/board/RAM/THINK/Pi/auth file touched, no
network/models/commits used.

## Why this repair existed

The first Batch B pass could be *fooled into claiming verified evidence it did
not have*. The audit (`docs/OVERNIGHT_AUDIT.md`, "Batch B Compiler / Contribution"
and "Batch B具体动作/Router" entries) named the exact fakes. B2 removes every one
of them by requiring a **trusted resolver of real records** instead of
producer-supplied booleans, digests, counts and `verified_by` strings.

The fixes are not "make the value stricter"; they are "stop treating a *claim*
as a *record*." A caller can still lie, but the module now needs a resolver that
the caller does not control to confirm the lie, and by construction that resolver
returns the real event.

## experience-compiler.mjs

Rewritten to `COMPILER_VERSION = "2.0.0"`, emits
`EXPERIENCE_SCHEMA_VERSION = "1.0"`.

New contract: `compileExperience({ proofs, environment, existingExperiences,
resolveSupport, supersededOutcomeIds, supersedes, experienceId, revision,
createdAt, updatedAt })`. `resolveSupport({ kind, ref, ref_key })` must return
`{ ok, record, content_digest }` for `kind ∈ {outcome, episode, action, artifact,
replay}`. Without it the result can only be `candidate`.

Audit item → fix:

| Audit finding | Fix in B2 |
|---|---|
| `proofKey` returns a `stable()` **string**, then `Object.entries(string)` is iterated as if fields — the identity check passes vacuously | `proofIdentity` now returns a structured **object**; missing identity fields fail as `independent_identity` |
| artifact digest (a string) treated as resolvable evidence | an artifact is evidence only when the resolver returns the **real record** with a matching `content_digest`; mismatch/unresolved ⇒ `evidence_refs` |
| `replayable=true` + non-empty hash + `replay_count` treated as replay proof | a **resolver-confirmed** isolated-replay record is required; missing ⇒ `replay_proof`; `replayable:false` or `replay_count:0` ⇒ `replay_proof` |
| every `when` unioned into a world that never held | `when` is the **intersection** verified in EVERY episode; a non-common predicate is dropped and flagged `when_not_common`; an empty intersection stays `candidate` (`when_present`) |
| reduced Experience shape | emits the full MEMORY_SCHEMA §6.2 shape: `expect`, `provenance` (`compiled_by`, `compiler_version`, `source_outcome_ids`, `source_episode_ids`, `compiled_at`), `revision`, `support` counts, `created_at`/`updated_at` |
| distinct `replay_hash` demanded as "independence" | independence now comes from distinct resolved **episode reset refs** (`episode_id` + `independence_group` + `isolation_ref`); **same content hash is legal** and is preserved in `support.replay_hashes` |
| superseded outcome still counted as support | `supersededOutcomeIds` (current-effective view) ⇒ `superseded_not_counted`; a `supersedes` whose superseding outcome is not among the proofs ⇒ `supersedes` refusal |
| only `distinctSet` counting, no cross-resolution | each proof's Outcome/Episode/action-version are resolved and cross-checked (`proof_resolvable`, `same_action`, `action_version`, `implementation_digest`) |
| `expect`/`provenance` absent | `expect` taken from the **resolved** Outcomes and must agree across proofs (`expect_present`, `expect_shape`, `expect_not_wildcard`, `expect_consistent`) |

Unchanged and preserved: strict action version + `implementation_digest`
pinning, `not_copied` vs an already-active do-clause, `scope_current` vs the
current environment, `min_proofs`, `proof_success`, `independence`.

## contribution.mjs

`recordStageContribution({ episode_id, dataRef, actionRef, useRefs, stage,
outcome, resolveSupport, supersededOutcomeIds, self_reported })`.

Audit item → fix:

| Audit finding | Fix in B2 |
|---|---|
| any `data`-typed ref in `evidence` counted, not the named `dataRef` | resolves the **exact** `dataRef` and requires it in the SAME episode |
| `data_obtained:true` boolean was proof | a boolean is never proof; the real data record must resolve and its content digest match |
| any `status:"success"` outcome accepted | the resolved Outcome must be a **trusted** (oracle/human/platform) success in the same episode naming BOTH exact refs; a producer's `status` string is not trusted |
| action not required to be a real completed bound action | resolves the actual action, requires `status:"completed"`, and requires the `dataRef` in its final `bound_arguments`/`useRefs` (`action_completed`, `action_uses_data`) |
| supersedes ignored | `supersededOutcomeIds` ⇒ stage stays `unknown` |
| stages collapsed into one `verified_use` | `obtain`/`use`/`advance` are recorded **separately**; `dataUsefulness` reports each independently and always as **association** (`association_only:true, causal:false`), never a causal theorem and never a fabricated third success |

Statuses: `verified_use`, `refused`, `self_reported`, `unknown`. `self_reported`
can never be `stage_useful`.

## learning-router.mjs

`routeLearning({ experiences, task, environment, currentState, registry,
resolveSupport })`. Added `supportResolutionChecks()`.

Audit item → fix:

| Audit finding | Fix in B2 |
|---|---|
| `direct` trusted `success_outcome_ids.length` + a non-empty `verified_by` string array | `direct` now requires a resolver that **resolves** each claimed success outcome/episode/replay; unresolved ⇒ `paused` (`support_resolution.ok === false`) |
| independence from counts | keyed on distinct resolved `episode_ids` / `independence_groups` / `isolation_refs` |
| missing `action_version`/`implementation_digest` passed | strict action pins; either missing ⇒ `binding_ok === false` ⇒ not `direct` |
| unknown `when` treated as match | unknown `when` ⇒ not `direct` (`when.known === false`) |
| changed digest silently routed | registered digest mismatch ⇒ `paused` (recoverable) |

The router falls back to `environment.resolveSupport` when not passed directly,
so an integration that resolves once can share the resolver.

## Tests

`Pi_Agent_base/tests/memory-runtime-batch-b-smoke.mjs` (existing suite):
- The Router section was migrated to a real `demoSupportResolver` and to
  `isolation_refs`/shared replay hashes (the old `run_ids`/`reset_nonces` +
  distinct-hash requirement encoded the very fakes B2 removed).
- The compiler and contribution sections were rewritten to build REAL
  Outcome/Episode/action/replay records in a store and resolve them. Reason for
  each adjusted assertion (all were previously passing on fake proof):
  - `run_id`/`reset_nonce` → `episode`/`isolation` (independence is reset refs);
  - `resolveEvidence` digest-only → `resolveSupport` real records;
  - `status:"success"` + `data_obtained:true` → resolved records;
  - failure-rule names updated to the rewritten compiler's actual rules
    (`replay_proof`, `when_not_common`, `expect_present`, `superseded_not_counted`,
    `independent_identity`, `proof_resolvable`, `evidence_refs`).
- Result: **107 assertions, all green.** No assertion was weakened; the suite is
  strictly stronger than before.

`Pi_Agent_base/tests/memory-runtime-learning-evidence-smoke.mjs` (new):
- Meaningful **negative** tests, one per removed fake, that would have passed
  under the old code and fail now. Examples:
  - identity check is not vacuous over a string `proofKey`;
  - a digest-only artifact with no resolvable record is not evidence;
  - producer `replayable:true`/hash/count is not replay proof;
  - **identical replay hashes activate** (independence is reset refs, not hashes);
  - a when-union that never held ⇒ `candidate` + `when_not_common`;
  - an unresolved evidence ref ⇒ `evidence_refs`; digest mismatch ⇒ `evidence_refs`;
  - a superseded outcome is not counted;
  - contribution refuses `data_obtained:true` with no resolver, a non-completed
    action, an action that does not bind the data, a cross-episode outcome, and a
    superseded outcome;
  - Router does **not** go direct without a resolver, with a non-success resolved
    outcome, with a collapsed isolation ref, with an unknown when, or with an
    unpinned action/digest; digest drift ⇒ `paused`.
- Result: **32 tests, all green** (`ok memory runtime learning evidence: 77d782a1`).

Regression check (offline): `aegis-runtime-core-smoke.mjs` and
`aegis-runtime-effective-board.mjs` still pass. `aegis-observer-runtime-handoff.mjs`
fails only on a missing external package `@earendil-works/pi-coding-agent` — a
pre-existing environment gap, not caused by this repair and not masked.

## Out-of-scope module discrepancies (recorded, not fixed)

These are **not** in the B2 write scope; recording so they are not lost:

1. `docs/OVERNIGHT_B_PENDING.md` item 5 ("compiler requires … distinct
   `replay_hash` values") is now **stale**: B2 deliberately stopped requiring
   distinct hashes, because two legal replays of the same method may share a
   content hash and forcing a difference would fabricate support. Independence
   is proven by real Episode reset refs. That doc file was out of scope for this
   repair.
2. `docs/OVERNIGHT_B_PENDING.md` item 6 (`replay_count` ownership) remains a
   product question and is unaffected by B2.

## Residual product questions (human decision, NOT decided here)

These are product/UI choices, separate from the evidence-discipline fixes:

1. **Resolver wiring ownership.** Who constructs the trusted `resolveSupport`
   resolver in production, and may it read the event log directly or must it go
   through the board's effective projection? B2 defines the interface, not the
   wiring.
2. **`paused` vs `hint` on digest drift.** Confirms the earlier open question:
   B2 keeps `paused` (recoverable). Confirm this is the desired product
   behaviour versus a soft `hint`.
3. **Function-contract closure pinning.** Unchanged from Batch B: a function
   contract with closure state must pass an explicit `implementation_digest`
   (and a dependency manifest); the runtime cannot introspect captures.
4. **Script Oracle mapping.** Still no automatic natural-language→verifier
   mapping; each script registration must supply a human-written Oracle.
5. **`replay_count` ownership.** Who is permitted to increment it (only a caller
   that actually re-ran an idempotent action).

## Compliance

- Write scope respected: only the three runtime files, the two test files and
  this report were modified. Verified by content: only `contribution.mjs`,
  `experience-compiler.mjs`, `learning-router.mjs` contain the `resolveSupport`
  fingerprint; no other B module does.
- No schema change, no new logger, no competing framework.
- No real network, model calls, or git commits.
- Existing correct B tests preserved; weak assertions adjusted only with a
  concrete reason; nothing weakened to fake a pass.
