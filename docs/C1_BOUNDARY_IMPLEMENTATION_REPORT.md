# Aegis C1 External Boundary (F10–F13) — Implementation Report

Machine-readable companion: `docs/C1_BOUNDARY_IMPLEMENTATION_REPORT.json`.
Plan: `docs/C1_BOUNDARY_WORK_PLAN.md`. Matrix: `docs/C1_BOUNDARY_TEST_MATRIX.md`.
Review: `docs/C1_BOUNDARY_REVIEW_REPORT.md`.

Status: **internally_verified / awaiting_external_review**. C2 is NOT
implemented.

## 0. F14 follow-up (this round)

Focus per `C1_BOUNDARY_FOLLOWUP_TASK.md`: only F14 blocks; F15 optional small fix;
F16 deferred.

| item | status | evidence |
| --- | --- | --- |
| F14 (missing/null provenance, foreign inner Stage id) | **fixed** | focused `^(CONTROL\|F14)` group: red 2/8 → green **10/10**; both completion paths; real EventLog product control |
| F15 (hydration mutates caller reservation) | fixed opportunistically | hydration now copies reservation/budget/definition; F15 case passes |
| F16 (accepted cache still full-replays) | **deferred** | correctness preserved by full replay; re-evaluate at C2 recovery integration; not a C1 gate |

Focused command:

```bash
node --test --test-name-pattern='^(CONTROL|F14)' Pi_Agent_base/tests/aegis-campaign-c1-boundary-review.mjs
# red  : exit 1, 10 tests, 2 pass / 8 fail  (runtime/dev/c1f14/red-focused.log)
# green: exit 0, 10 tests, 10 pass / 0 fail (runtime/dev/c1f14/green-focused.log)
```

Required regression: all 17 campaign scripts exit 0 (external-boundaries 21/21,
final-audit3-adversarial 1/1, 15 plain scripts). Mixed boundary-review (diagnostic)
is 11 pass / 1 fail (only the deferred F16). Biome exit 0; campaign tsc 0 errors,
10 pre-existing import errors (exit 1). 8 offline + 4 Pi/faux regressions exit 0.

## 1. Orchestration

No sub-agent tool exists in this harness; the master DS ran the task graph
serially with explicit test-author / implementer / reviewer role switches. No
child-DS report was fabricated. Same-model self-review is not external acceptance.

## 2. Baseline and Git

- branch `audit/c1-external-boundaries`; `git rev-parse HEAD` is the ref-file
  placeholder; the true tip via reflog/log is `369e1f4` (the red commit).
- Red baseline (committed, preserved): `node --test
  …c1-external-boundaries.mjs` → exit 1, 21 tests, **3 pass / 19 fail**.
- Green: exit 0, 21 tests, **21 pass / 0 fail**.
- Environment note: SHA256 is stubbed and hex-like output is displayed as zeros,
  but the real digest values differ; tests assert change/equality, never literals.

## 3. F10–F13 closure

| id | fix |
| --- | --- |
| F10 | `resolveTaskOutcome` fails closed (unknown) when the current scope is missing; the projection passes `currentTaskScope(task.definition)`; `manifest.scope` is not used |
| F11 | new `resolveStageOutcome` binds each stage Outcome to task/episode/criterion/scope/independent-provenance/non-empty-evidence/observed; the projection runs it on ingest; the single completion gate aggregates only valid stage Outcomes through `resolveTaskFromOutcomes` |
| F12 | hydration preserves `episode_id`/`session_id`/`attempt_id`, deep-clones outcomes, and seeds command/outcome dedup from priorState + queue rows; applied command keys are recorded per row |
| F13 | the state digest covers the full semantic projection; the real `persistCheckpoint` persists episode + dedup fields; startup validates the checkpoint PREFIX state digest, then applies the tail |

Supporting: `normalizeTask` preserves an optional `task.scope`; the fixture
declares `FIXTURE_SCOPE`, and the older campaign tests/helpers were updated to
declare a trusted scope (their real assertions preserved).

## 3b. Commits (branch `audit/c1-external-boundaries`)

```text
532ea85 fix: fail-closed task scope and complete Stage binding (F10, F11)
6fa367c test: declare trusted task scope in the C1 fixtures (F10)
9bb8da4 fix: complete persisted projection and real checkpoint wiring (F12, F13)
3d4b09d docs: C1 external boundary (F10-F13) plan, matrix and reports
```

The red baseline is the pre-existing commit `369e1f4`; its 19 external failures
are preserved as the regression origin (not skipped or weakened).

## 4. Commands and exit codes

```text
node --test Pi_Agent_base/tests/aegis-campaign-c1-external-boundaries.mjs  exit 0   21 tests / 21 pass
node Pi_Agent_base/tests/aegis-campaign-<16 suites>.mjs                    exit 0   309 ok blocks
biome check …                                                              exit 0   0 warnings
tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json                          exit 1   0 campaign errors / 10 pre-existing import errors
```

Regression: 8 offline suites + 4 real-Pi/faux suites (source-resolver), all exit 0.

## 5. Mutation

Four guards are killed by behavioural assertions (stage evidence gate, restore
episode, row-based dedup seeding, state digest content). Two scope guards are
redundant with the outcome-scope guard and are not mutation-killed; this is
reported honestly in the review report §6.

## 6. Product-path evidence

- F11-PRODUCT matching / foreign: real `EventLog` + scheduler reconcile; matching
  scope completes, foreign scope does not; worker reruns 0 in both.
- F13 real writer: the actual checkpoint record carries `queue[0].episode_id`;
  a changed stage `observed` changes the digest.
- F12: a JSON-serializable priorState clone drives cache+tail; foreign-episode
  results are rejected like full replay; repeated outcomes/commands are not
  double-counted/charged.
- CKP-POS/PREFIX: the real write→read→resume path sets `used_checkpoint` only
  after validating the prefix and applying the tail.

## 7. Not implemented / not proven

C2 Session rotation, C3 Broker/Oracle adapters, C4/C4a UI; real targets/network/
credentials; distributed ownership; external side-effect exactly-once; real
SHA256 values visible in this harness; a whole-repo tsc-clean state.

```text
Aegis did not automatically invoke gpt-6.1-sol.
No real target network or credential access was used.
Synthetic/faux evidence is labeled.
Session count is not independent Episode count.
Unknown is not failure.
External side-effect exactly-once is NOT claimed.
Status: C1 internally_verified / awaiting_external_review. C2 not started.
```
