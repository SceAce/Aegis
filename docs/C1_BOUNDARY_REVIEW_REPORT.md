# Aegis C1 External Boundary (F10–F13 + F14 follow-up) — Master DS Review Report

Status: **internally_verified / awaiting_external_review**. C2 is NOT
implemented. External acceptance remains pending.

## 0. F14 follow-up (this round, scope frozen by `C1_BOUNDARY_FOLLOWUP_TASK.md`)

- branch `audit/c1-external-boundaries`; start HEAD `cbe3f97`; working tree clean.
- Red (focused): `node --test --test-name-pattern='^(CONTROL|F14)'
  Pi_Agent_base/tests/aegis-campaign-c1-boundary-review.mjs` → **exit 1, 10 tests,
  2 pass / 8 fail** (`runtime/dev/c1f14/red-focused.log`).
- Green (focused): **exit 0, 10 tests, 10 pass / 0 fail**
  (`runtime/dev/c1f14/green-focused.log`).
- **F14 fix** (`outcome-resolver.mjs::resolveStageOutcome`):
  1. the stage Outcome must carry an object `provenance` with
     `independent === true`; a missing/null provenance is `unknown` and an inner
     `oracle.source` alone no longer confers independent-judgment rights (the
     inner source is read from `provenance.source`, not `oracle.source`);
  2. when the Outcome carries its own `step_id`/`stage_id`, it must equal the
     declared stage; a foreign inner Stage id is `invalid` and cannot be relabeled
     by the outer envelope during canonicalization.
  Both completion paths (normal `campaign.task.completed` and
  `campaign.reconciliation.resolved`) use the single gate; the valid control and
  worker-not-rerun behaviour are preserved.
- Required regression: all **17 campaign scripts** (including
  `external-boundaries` 21/21 and `final-audit3-adversarial`) exit 0.
- Mutation (proportionate): reverting both F14 guards to the pre-fix shape is
  killed by **7 failures** in the focused group; removing only the inner-stage
  binding check is killed by 7. Removing only the provenance-presence check is
  masked by the F2 inner-source check (redundant defence-in-depth, reported
  honestly).
- Mixed `aegis-campaign-c1-boundary-review.mjs` (diagnostic): **11 pass / 1 fail**;
  the only failure is F16 (deferred).

### F15 (non-blocking, fixed opportunistically)

The projection hydration now copies `reservation`/`budget_consumed` (and
`definition`/`stage_ids`) instead of sharing the caller's checkpoint objects, so
applying a tail no longer mutates the caller's cached reservation. The F15 case
passes.

### F16 (deferred — cache optimization)

The scheduler validates and reduces the checkpoint prefix, then still drives the
loop/status/checkpoint via `project()` (full replay). This is a correctness-
preserving cache-acceleration gap, not a false-success or authorization issue;
the current code is correct via full replay. It remains deferred: the primary
cache path is not rewired in this focused F14 round. Re-evaluate when C2 wires
recovery; the prefix read-count assertion is a cache-implementation diagnostic,
not a C1 correctness gate. Responsibility: the C2 recovery-integration phase.

## 1. Baseline and Git (F10–F13)

- branch: `audit/c1-external-boundaries`
- `git rev-parse HEAD` → `00000000000000000000000000000000` (ref-file placeholder;
  the true tip via `git reflog`/`git log` is `369e1f4`
  `test: reproduce C1 scope and checkpoint failures and block C2`)
- red baseline (committed `369e1f4`): `node --test
  Pi_Agent_base/tests/aegis-campaign-c1-external-boundaries.mjs` →
  **exit 1, 21 tests, 3 pass / 19 fail** (log:
  `runtime/dev/c1boundary/red-baseline.log`). The 19 failures are behavioural
  assertions, not import/syntax errors.
- green (this work): **exit 0, 21 tests, 21 pass / 0 fail**
  (`runtime/dev/c1boundary/green-final.log`).

Note on the environment: SHA256 is stubbed and the terminal display layer
replaces hex-looking output with zeros, but the real digest values differ. This
was confirmed during review (`sha256Hex("a") !== sha256Hex("b")` while both
display as zeros). Digest tests therefore assert change/equality, never a literal.

## 2. Orchestration honesty

No sub-agent tool exists in this harness (read/bash/edit/write/browser only). Per
`DS_ORCHESTRATION_WORKFLOW.md §1` the master DS executed the task graph
**serially**, switching test-author / implementer / reviewer roles. No child-DS
report was fabricated. Same-model self-review is not external acceptance.

## 3. F10–F13 fixes

| id | fix | files |
| --- | --- | --- |
| F10 | `resolveTaskOutcome` now returns `ok:false,status:"unknown"` when the CURRENT scope is missing (never skips validation); the projection is called with `currentTaskScope(task.definition)`. `manifest.scope` is not used. | `outcome-resolver.mjs`, `projection.mjs` |
| F11 | new `resolveStageOutcome()` binds each stage Outcome to the current task, a non-null matching episode, the declared criterion, independent provenance, the trusted current scope, non-empty resolvable evidence, and an `observed` value; the projection runs it on ingest; `resolveTaskFromOutcomes` only aggregates passing stage Outcomes; both completion gates share the single gate. | `outcome-resolver.mjs`, `projection.mjs` |
| F12 | checkpoint hydration preserves `episode_id`/`session_id`/`attempt_id`, deep-clones outcomes, and seeds `appliedCommands`/`appliedOutcomes` from priorState and the queue rows; each applied command key is recorded on the task row so the prefix+tail dedup survives. | `projection.mjs` |
| F13 | the state digest covers the complete semantic projection (episode, definition, stage/task outcomes, applied-command keys, reconciliation, proposals, outcomes index); the REAL `persistCheckpoint` persists `episode_id` + dedup fields; the startup recovery validates the checkpoint's PREFIX state digest first, then applies the tail. | `scheduler.mjs`, `projection.mjs` |

Supporting change: the Manifest `normalizeTask` preserves an optional `task.scope`
(not invented; absent ⇒ null, fail-closed), and the fixture declares
`FIXTURE_SCOPE` so the C0/C1 fixtures have a trusted current scope.

## 4. Commands and exit codes (final)

Logs: `runtime/dev/c1boundary/`.

| command | exit | result |
| --- | --- | --- |
| `node --test Pi_Agent_base/tests/aegis-campaign-c1-external-boundaries.mjs` | **0** | 21 tests, 21 pass / 0 fail |
| `node Pi_Agent_base/tests/aegis-campaign-{16 suites}.mjs` | 0 | 309 `ok` blocks |
| `biome check --config-path=Pi_Agent_base/aegis-biome.json <campaign + tests + helpers>` | 0 | **0 warnings** |
| `tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json` | **1** | **0 campaign errors**; 10 pre-existing import errors (`memory/fixture/contracts.mjs` 2, `memory/runtime/events.mjs` 8) |

Regression (all exit 0): 8 offline suites + 4 real-Pi/faux suites (source-resolver).

## 5. Red → green

The external suite moved from 3 pass / 19 fail to 21 pass / 0 fail. Fixes by case:
F10 ×2, F11 ×12, F12 ×4, F13 ×2, F11-PRODUCT-FOREIGN ×1. The two positive
controls (CONTROL both gates, F11-PRODUCT matching scope) stayed green throughout.

## 6. Mutation results (isolated copies, real suite)

| mutation | case | expected | actual |
| --- | --- | --- | --- |
| stage evidence gate removed (empty evidence allowed) | F11-EMPTY-EVIDENCE ×2 | FAIL | **FAIL (5)** |
| restore drops `episode_id` | F12-EPISODE / FOREIGN-EPISODE | FAIL | **FAIL (5)** |
| row-based outcome dedup seeding removed | F12-OUTCOME-DEDUP | FAIL | **FAIL (3)** |
| state digest drops stage outcomes + outcomes index | F13-DIGEST | FAIL | **FAIL (3)** |
| null-current-scope guard removed | F10-A / F10-B | FAIL | not caught — redundant with the outcome-scope guard (documented) |
| stage null-scope guard removed | F11-MISSING-SCOPE ×2 | FAIL | not caught — redundant with the outcome-scope guard (documented) |

Two guards are redundant defence-in-depth: removing the null-current-scope branch
still rejects a null OUTCOME scope in the following branch. This is reported
honestly rather than claimed as a killed mutation.

## 7. Product-path evidence

- **F11-PRODUCT (matching)**: real `EventLog` + `createCampaignScheduler`, durable
  intent + reconcile returning a matching-scope stage + task Outcome ⇒ `completed`,
  worker reruns 0.
- **F11-PRODUCT (foreign)**: same entry with a foreign-scope stage ⇒ NOT completed,
  worker reruns 0.
- **F13-EPISODE-WRITER / F13-DIGEST**: the ACTUAL `persistCheckpoint` record
  (captured via the injected writer) contains `queue[0].episode_id`; changing only
  the stage `observed` at fixed ids changes both the stage-Outcome projection and
  the `projection_digest`.
- **F12**: cache+tail reduces with an independent, JSON-serializable priorState
  clone; foreign-episode results are rejected identically to full replay; repeated
  outcomes/commands are not double-counted/charged.
- **CKP-POS/PREFIX**: the real checkpoint write→read→resume path genuinely uses the
  cached state (`used_checkpoint === true` only when the prefix validates and the
  tail is applied).

## 8. Synthetic vs real

- Synthetic Worker/Oracle and artifact index; the RECOVERY and F11-PRODUCT
  scenarios use the REAL `EventLog` (append/fsync/replay) and the REAL scheduler.
- No model, network, target or credential is used.

## 9. Cross-module review findings

Files read end-to-end: all `memory/campaign/*.mjs`, the external boundary suite,
the modified campaign tests and 5 helpers, `tsconfig.aegis-campaign.json`.

| severity | finding | status |
| --- | --- | --- |
| P0 | stage evidence could bypass binding/completeness and complete a task | fixed (F11) |
| P1 | missing current scope disabled validation | fixed (F10) |
| P1 | hydration lost episode + dedup → foreign-episode admission / double charge | fixed (F12) |
| P1 | real writer omitted episode; state digest omitted stage content; prefix/tail order wrong | fixed (F13) |

No open P0/P1.

## 10. What this does NOT prove

- External side-effect exactly-once (no Broker/executor).
- C2 real Pi Host-level Session rotation, C3 real Broker/Oracle adapters,
  C4/C4a Web UI and Pi `/aegis` commands.
- Real CTF / penetration / remote target / network / credentials.
- Distributed (multi-host) ownership.
- Real SHA256 values visible in this harness (stubbed display).
- A whole-repo tsc-clean state (10 pre-existing import errors).

`Aegis did not automatically invoke gpt-6.1-sol. No real target network or
credential access was used. Synthetic/faux evidence is labeled. Session count is
not independent Episode count. Unknown is not failure. External side-effect
exactly-once is NOT claimed. Status: C1 internally_verified /
awaiting_external_review.`
