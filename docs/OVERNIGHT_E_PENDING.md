# Overnight E — pending items and honest status

This file records what Batch E **implemented**, what is **not wired**, and what is
**not yet verified**, so nothing here is mistaken for a proven end state. The
supervising agent owns the final THINK; E did not invent new learning terminology
and did not delete any existing module.

Scope recap (from `OVERNIGHT_E_TASK.md`): the real product entry point must be able
to call the already-tested Compiler / Router / Skill library while honoring the
existing evidence gate. Nothing goes `active` without a resolved proof/mapping;
candidates are left explicit; no isolation record is fabricated for a demo.

---

## 1. Implemented (with the test that proves it)

| Item | Artefact | Proof |
| --- | --- | --- |
| Aegis-owned lint config, no spread into Pi/legacy | `Pi_Agent_base/aegis-biome.json` | `biome check --config-path=aegis-biome.json extensions/` → 0 errors, 0 warnings |
| Thin library→Observer learning adapter | `memory/runtime/learning-bridge.mjs` | `tests/aegis-learning-bridge-e.mjs` |
| Derived, rebuildable experience store | `memory/runtime/learning-store.mjs` | same |
| Controlled `/aegis` subcommands (Pi-free logic) | `memory/runtime/learning-commands.mjs` | same |
| Observer command surface (`learn`/`compile`/`route`/`bind`/`run`/`replay`) | `extensions/aegis-observer.ts` | `tests/aegis-learning-commands-pi.mjs` (real Pi SDK) |
| Multi-episode learning + real-adapter Replay + third-task direct→broker→Oracle | `tests/aegis-learning-commands-pi.mjs` | 19 checks, `ok` |
| Example-cwd contest launcher (one absolute path) | `contest/` + `daily.mjs` | run from `/tmp`: `--help` exit 0, missing task id errors, deterministic report + `rows.csv` written |

The product-level Pi test drives **actual** `/aegis ...` prompts through a real Pi
session with the observer extension loaded. It seeds a committed log through the
trusted Runtime/Oracle (real registered-broker executions + real adapter-driven
replays), then proves: a complete proposal is bound but stays a **candidate**;
`compile` with no proof ids records nothing; one proof stays candidate; two
independent proofs reach **active**; `route` with no verified state never goes
direct; `route` with a verified committed state reaches **habit**; `bind` re-checks
to **direct**; `run` executes the **actual registered broker** with 0 model calls and
the Oracle confirms the post-state; `replay` with no adapter fabricates nothing and
with a configured isolated adapter commits a genuine durable replay.

## 2. Not wired (deliberate, not faked)

1. **Automatic handoff on `agent_settled`.** The `agent_settled` hook and the real
   `ctx.newSession` seam both exist, and `memory/runtime/handoff-host.mjs`
   (`applyStagedHandoff`) is a thin, tested Host helper. But auto-wiring it needs an
   SDK **Host** loop that the extension does not own, and it risks the already
   tested `/aegis switch` flow. Decision: **do not wire automatically**; the manual
   `/aegis switch` path and the `applyStagedHandoff` library remain. A human/SDK-host
   opt-in is required before this is automatic.
2. **Model-initiated learning.** By design the model never operates the workflow:
   `learn`/`compile`/`route`/`bind`/`run`/`replay` are human/trusted-Host commands,
   and the proof writer is the trusted Runtime/Oracle, not the model.

## 3. Type-check scope (read this before claiming "type check passed")

`Pi_Agent_base/tsconfig.aegis.json` checks **only** the three new Batch-E modules
(`learning-bridge.mjs`, `learning-commands.mjs`, `learning-store.mjs`) with
`checkJs` on: **0 errors** in the owned modules.

- The three legacy extensions (`aegis-observer.ts`, `aegis-contest.ts`, …) are
  **not** in this tsconfig: they import the whole Pi SDK + the untyped `.mjs`
  runtime, so adding them drags Pi's program in. They are validated by their real
  Pi-integration tests, not by tsc. Pi's own `tsconfig` is immutable and was not
  changed.
- A whole-program `tsc` over the untracked runtime **exits 1** because of ~195
  **pre-existing** errors in legacy/unannotated files (`memory/fixture/contracts.mjs`,
  `memory/runtime/{action-contract,authorization,board,contribution,events,evidence-resolver,experience-compiler,learning-router,workflow-engine}.mjs`).
  That is the honest baseline; E did not annotate D-owned or unrelated files to
  hide it.
- **Format check truly passed** (biome: 0/0 on `extensions/` and the owned tests).
  **Type check passed only for the owned scope above**, not for the whole repo.

## 4. Open human / product decisions (carried from D and C, still open)

These are not defects; they need a product/architecture owner's call.

1. **Replay-adapter provisioning + isolation attestation.** `replayOutcome`
   requires an explicitly configured `isolated: true` adapter loaded from a module
   path set by the human (`AEGIS_REPLAY_ADAPTER`). *Who* may register an adapter and
   *how* isolation is attested is still unspecified — E treats the adapter as
   trusted human code, as D did.
2. **Actor identity is structural, not authenticated.** The resolver trusts a
   committed event's `source.kind`; a process able to write the EventLog can forge a
   trusted source. Decide whether event sources need signing.
3. **Approval granularity** in `normal` mode (one approval flag covers the process).
4. **Generalisation policy.** A compiled Experience carries the current environment
   scope; when (if ever) a rule may apply to a new scope/target without
   re-verification is undecided.
5. **Auto-handoff entry point** (see §2.1): needs a product decision on whether the
   SDK Host should run a settle→handoff loop, and with what consent.

## 5. Explicitly NOT done (so it is not mistaken for complete)

- No modification of `memory/runtime/evidence-resolver.mjs` or
  `memory/runtime/workflow-engine.mjs` or their D tests.
- No modification of Pi core / configs / auth / model tests / settings.
- No commit, no network, no real remote target, no contest-effective rate number.
- No signature/authentication of event sources.
- No automatic handoff.
- Type coverage is the owned scope only (see §3).

---

## 6. G addendum (post-F follow-up)

Batch G (`OVERNIGHT_G_REPORT.md`) added the missing regressions and two real
fixes:

- The real `aegis_execute` / `/aegis run` intent now pins the registered
  `version` + `implementation_digest` (without this the compiler's
  `action_resolution` failed even with a correct `do.action_ref`).
- `authoritativeActiveExperiences` now **requires** every authoritative field
  (id/revision/source proof ids/content digest) and re-hashes the stored body; a
  missing field is a rejection, not a skipped check.
- `learning-store.save` refuses to downgrade an active projection to candidate, so
  a duplicate/not_copied re-compile cannot erase the committed active rule.

New/strengthened regressions: derived-store tamper/stale gate, `adapterPath`
really executing through a bare bridge + idempotency, `/aegis run` audit boundary
(requested→completed→oracle Outcome→resolver), invalid `--templates`, `not_copied`
on the product path, real `aegis_execute` Outcome → compile, and normal-mode
`AEGIS_ACTION_APPROVED=1`.

### Still open after G

- **Real execute/run Outcome evidence refs.** The action identity resolves, but
  the Outcome still names `artifact:<id>.stdout` and observation-event data refs
  that the observe/execute path never commits as resolver-indexable
  `artifact.recorded` / `data.obtained` records. The compiler therefore still
  fails `evidence_refs` on a real Outcome, so it stays a **candidate** (the gate
  was not relaxed). Closing this needs the observe/execute path to commit those
  records.
- A run-specific fail-closed integration negative (broken log + would-be active
  experience) is not added; the guard is code-reviewed and the generic audit
  fail-closed path is covered by `aegis-observer-failclosed-pi.mjs`.
