# Overnight F — audit follow-up fixes (P1/P2) report

Scope: close the P1/P2 defects the previous continuation session's audit found in
the learning-command / workflow path. The prior session ended in a context
explosion before the fixes were dispatched, and its DS relay dispatch later failed
with provider/connection errors. This batch applies the fixes directly and re-runs
the full acceptance checklist.

All fixes touch only Aegis-owned runtime/extension/tests. No Pi core, auth, model
config, settings, or previously-deleted files were changed. No git commit, no
network, no real contest target.

---

## P1 fixes

1. **`action_ref` vs `action_id` in the registered-script Outcome.**
   `memory/runtime/script-registry.mjs` `build()` now sets `action_ref` to the
   REGISTERED action id (`script.<id>`), and keeps the Pi toolCallId as a separate
   `action_id`. A real `aegis_execute` step Outcome can now be compiled directly
   (the compiler resolves `do.action_ref` against the Registry instead of the
   toolCallId). Regression: `tests/aegis-observer-data-use-pi.mjs`.

2. **`/aegis run` now reuses the side-effect audit boundary.**
   `extensions/aegis-observer.ts` `run` command: fails closed when the audit log
   is unavailable, resolves the direct action + final arguments without executing,
   records a durable `action.requested` BEFORE the broker runs, then records the
   real `observation.captured`/`outcome.recorded` + `action.completed` AFTER. The
   run is visible in the resolver (action + Outcome + final arguments).

3. **Derived Experience store validated against the authoritative EventLog.**
   `memory/runtime/learning-store.mjs` adds a `content_digest` to each stored
   record and exports `authoritativeActiveExperiences(records, events)`, which only
   admits an active record whose `experience_id`/`revision`/`source_outcome_ids`/
   `content_digest` match a committed `experience.compiled` note. The Observer's
   compile note now records `revision` + `content_digest`. `route`/`bind`/`run`
   filter through this gate, so a tampered/missing/stale store record can only
   route to candidate/deliberate — never direct.

4. **`/aegis compile` passes existing active Experiences.**
   The compile command now loads `store.loadActive()` and passes
   `existingExperiences` so the compiler's `not_copied` gate applies on the real
   command path (duplicate active do-clause is not silently re-compiled).

5. **`learningCommands.replay` injects the loaded adapter.**
   `workflow-engine.mjs` `replayOutcome` accepts an `adapter` override;
   `learning-commands.mjs` `replay` passes `adapter: loaded.adapter`, so a bridge
   constructed without a pre-configured adapter can still replay through the
   command's `adapterPath`.

## P2 fixes

1. **Replay guards (workflow-engine.mjs).** A caller-provided `episodeId` that
   differs from the outcome's episode is refused; the adapter must report a
   non-empty `isolation_ref`; a second replay of the same committed
   (episode, outcome) is idempotent (`duplicated:true`, adapter not re-run).
   Negatives added to `tests/aegis-workflow-engine-d.mjs`.

2. **Invalid `--templates` JSON is refused**, never silently downgraded to `{}`.

3. **`/aegis run` normal-mode approval unified** with the `aegis_execute` path
   (`AEGIS_ACTION_APPROVED=1` is honored), and the actual authorization source is
   recorded on the `experience.run` note.

4. **Owned-module type check restored to 0 errors.** `tsconfig.aegis.json` now
   reports **0 errors in the three Batch-E modules**
   (`learning-bridge.mjs`, `learning-commands.mjs`, `learning-store.mjs`). The
   whole-program tsc still exits 1 from the ~189 pre-existing errors in the
   imported legacy/untyped runtime graph (documented in `OVERNIGHT_E_PENDING.md` §3).

## Test updates (to match the tightened contracts)

- `tests/aegis-learning-bridge-e.mjs` — replay adapter now returns
  `isolation_ref`; the store-validation gate is exercised by recording the
  authoritative `experience.compiled` note + `bridge.refresh`.
- `tests/aegis-learning-commands-pi.mjs` — adapter returns `isolation_ref`; a third
  outcome (`out-2`, no pre-committed replay) proves the `/aegis replay` command
  commits a NEW record.
- `tests/aegis-workflow-engine-d.mjs` — `seedRun` gains `withReplay`; a third seed
  (`seed2`, no replay) drives the genuine/duplicate/foreign-episode/no-isolation
  negatives.
- `tests/aegis-observer-data-use-pi.mjs` — asserts `action_ref` is the registered
  id and `action_id` (toolCallId) is separate.

## Acceptance checklist (all green)

- `biome check --config-path=aegis-biome.json extensions/` → 0 errors, 0 warnings.
- `tsc -p tsconfig.aegis.json` → 0 errors in the owned Batch-E modules.
- All library + product tests pass (23/23), including the real-Pi
  `aegis-learning-commands-pi`, `aegis-observer-data-use-pi`,
  `aegis-observer-verify-first-pi`, `aegis-observer-outcome-command`,
  `aegis-observer-failclosed-pi`.

## Still open (unchanged, human/product decisions)

The open decisions in `OVERNIGHT_E_PENDING.md` §4 and `THINK.md` §10 remain open
(replay-adapter provisioning/attestation, event-source signing, approval
granularity, generalisation policy, auto-handoff entry point). These are product
calls, not defects.
