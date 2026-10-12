# Overnight G — audit-item completion report (post-F)

Scope: finish and *prove* the audit items in `IMPLEMENTATION_AUDIT_2.md` /
`OVERNIGHT_E_PENDING.md` that Batch F claimed but did not fully cover, on top of
the existing (kept) workspace changes. Only Aegis-owned files were touched
(`Pi_Agent_base/{extensions,memory,tests}` + docs). No Pi core, auth, model config,
lock file, deleted-root state, network, real model, or Git commit.

Honest split: **implemented + tested** below; **still open** in §4. F's own fixes
were re-run and kept; G adds the missing regressions and two real fixes the
regressions exposed.

---

## 1. Real fixes

1. **Action identity pinned on the real side-effect intent.**
   `extensions/aegis-observer.ts` — the `aegis_execute` and `/aegis run`
   `action.requested` payloads now carry the registered `version` +
   `implementation_digest` (and the matching `action.completed` does too). Before
   this, `memory/runtime/evidence-resolver.mjs` indexed the action with a null
   version, so the compiler's `action_resolution` rule failed even when
   `do.action_ref` was the correct registered id. This is what made the new
   "real `aegis_execute` Outcome → compile" regression fail.

2. **Derived Experience store hardened against a second truth source.**
   `memory/runtime/learning-store.mjs`:
   - `authoritativeActiveExperiences` now **requires** an exact match on
     `experience_id`, numeric `revision`, non-empty `source_outcome_ids`, and a
     non-empty `content_digest`, and additionally recomputes
     `contentDigest(record.experience)` so copying the note digest onto a swapped
     body is refused. A missing field is now a rejection, not a skipped check.
   - `save` refuses to **downgrade** an already-active projection to candidate.
     A duplicate/not_copied re-compile therefore cannot erase the active rule that
     the committed `experience.compiled` note still authorizes.

No other runtime behavior was changed; no gate was relaxed and no unknown was
promoted to success/failure.

## 2. New/strengthened tests (all pass)

| Audit item | Test | What it proves |
| --- | --- | --- |
| 1 action_ref + compile | `tests/aegis-observer-data-use-pi.mjs` | a REAL `aegis_execute` step Outcome separates `action_ref` (`script.use-stage`) from `action_id` (toolCallId); the intent pins version+digest; feeding the REAL Outcome into `compileFromOutcomeIds` yields a proof with the registered action and **no** `action_registered`/`action_resolution` failure (stays candidate only for independence, never a fake active rule) |
| 2 `/aegis run` boundary | `tests/aegis-learning-commands-pi.mjs` | one durable `action.requested` (final args + authorization source + pinned version/digest) **before** a matching `action.completed`; a standard step `outcome.recorded` under the registered `action_ref` from the trusted `oracle` source; that Outcome is resolver-visible |
| 2 normal/auto unified | `tests/aegis-observer-verify-first-pi.mjs` | normal mode **with** `AEGIS_ACTION_APPROVED=1` runs the registered action and records `authorization.source = env:AEGIS_ACTION_APPROVED` (same semantics as `auto`/run) |
| 3 store not a truth source | `tests/aegis-learning-bridge-e.mjs` | aligned record admitted; tampered `content_digest`, stale `revision`, swapped `source_outcome_ids`, **missing** `content_digest`/`source_outcome_ids`, swapped body, and a no-note stale record are all rejected; a tampered store cannot route direct; the restored projection routes again |
| 4 not_copied on the product path | `tests/aegis-learning-commands-pi.mjs` | recompiling the same proofs fires the `not_copied` rule → candidate, `stored=false`, and the previously-active record is preserved; invalid `--templates {not-json` is refused with **no** note (never a silent `{}`) |
| 5 adapterPath really used | `tests/aegis-learning-bridge-e.mjs` | a bridge built with **no** pre-configured adapter refuses without `adapterPath`, and with `adapterPath` it actually runs the loaded adapter (one real `replay.performed` row for a fresh outcome); a second command over a rebuilt bridge is idempotent (adapter not re-run, no second row) |
| 5 foreign episode / isolation / duplicate | `tests/aegis-workflow-engine-d.mjs` (pre-existing) | foreign `episodeId` refused; non-empty `isolation_ref` required; duplicate replay idempotent |

## 3. Acceptance re-run (all green)

- `biome check --config-path=aegis-biome.json extensions/` → 0 errors, 0 warnings.
- `tsc -p tsconfig.aegis.json` → **0 errors in the three owned modules**
  (`learning-bridge/commands/store.mjs`); the command still exits 1 from 188
  pre-existing errors in the imported legacy runtime (unchanged baseline, see
  `OVERNIGHT_E_PENDING.md` §3).
- All library + real-Pi tests pass, including the 8 real-Pi suites and the 9
  offline suites listed in `AEGIS_RUN_AND_ACCEPTANCE.md`.

## 4. Still open (NOT claimed as done)

1. **Real execute/run Outcome evidence-refs gate.** The action identity now
   resolves, but the script Outcome's evidence refs include
   `artifact:<id>.stdout` and (for `aegis_execute`) the observation-event data
   refs, and the Observer never commits a matching `artifact.recorded` /
   `data.obtained` record. The compiler therefore still fails `evidence_refs` on a
   real Outcome, so it stays a **candidate** (correctly — no gate was relaxed).
   Closing this needs the observe/execute path to commit resolver-indexable
   artifact/data records, which is a larger integration change and was left out
   of this bounded batch. The new regression asserts the *action* resolution only.
2. **`/aegis run` fail-closed negative.** The run command fails closed before the
   broker when the audit log is unavailable, and the positive audit boundary is
   proven; the generic audit fail-closed behavior is covered by
   `aegis-observer-failclosed-pi.mjs`. A run-specific integration negative (broken
   log + would-be active experience) is not added; the guard is code-reviewed, not
   separately executed.
3. Human/product decisions from `OVERNIGHT_E_PENDING.md` §4 remain open
   (replay-adapter provisioning, event-source signing, approval granularity,
   generalisation policy, auto-handoff entry point).
