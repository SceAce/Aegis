# Aegis Campaign — Master Work Plan (C0 Closure → C1)

Status: `internally_verified` for C0; C1 tracked below.
Owner: main DS (this session). External acceptance: pending (user brings materials back).

## 0. Orchestration honesty

This harness exposes **no sub-agent tool** (verified: only read/bash/edit/write and
browser tools are available; no delegate/agent-spawn capability). Per
`docs/DS_ORCHESTRATION_WORKFLOW.md` §1, the master DS therefore executes the same
task graph **serially**, explicitly switching test-author / implementer / reviewer
roles, and reports that no delegation happened. No child-DS completion report is
invented.

## 1. Baseline (recorded before any edit)

File: `Pi_Agent_base/runtime/dev/baseline.txt`.

| Command | Exit | Notes |
| --- | --- | --- |
| `node Pi_Agent_base/tests/aegis-campaign-contracts-c0.mjs` | 0 | all assertions passed |
| `node Pi_Agent_base/tests/aegis-campaign-fixture-c0.mjs` | 0 | all assertions passed |
| `./Pi_Agent_base/pi/node_modules/.bin/biome check --config-path=Pi_Agent_base/aegis-biome.json Pi_Agent_base/memory/campaign Pi_Agent_base/tests/aegis-campaign-contracts-c0.mjs Pi_Agent_base/tests/aegis-campaign-fixture-c0.mjs` | 0 | lint+format clean |
| `node --version` | — | v26.10.0 |
| Biome | — | 2.3.5 |
| `git rev-parse HEAD` | — | `00000000000000000000000000000000` (placeholder; campaign files are untracked) |

No environment-blocked suites at baseline. The historical "all green" is not
treated as C0 closure evidence (contract baseline §1).

### 1.1 Reproduced C0 defects (old-code red, probed before fixes)

Reproduced with `runtime/dev/probe_c0.mjs` (kept out of docs). "old" = pre-fix code.

| id | probe input | old behavior (defect) | required behavior |
| --- | --- | --- | --- |
| P0-1 | llm-sourced `supersedes` with `status:unknown` | correction stays in effective view (`o2:unknown` visible) | illegal correction excluded from effective judgments; prior survives |
| P0-1 | foreign-episode `supersedes` `success` | foreign `success` row stays effective → pollutes stage | excluded from effective view |
| P0-1 | malformed provenance / missing target | correction row stays effective | excluded |
| P0-2 | both outcomes `scope` undefined | `classifySupersede` → `valid:true` | fail-closed (`scope_mismatch`) |
| P0-2 | equal scope, different key order | `scope_mismatch` | canonical compare → `valid:true` |
| P0-3 | `authorization.credentials = "api_key=SECRET"` | report restored `"api_key=SECRET"` verbatim | `[redacted]` / refused |
| P1-1 | taskOracle without task/criterion binding | task `success` | `unknown`/`invalid` |
| P1-1 | taskOracle with foreign `task_id` | task `success` | not success |
| P1-1 | required stage omitted from `stages[]` | task `success` | not success (unknown/invalid) |
| P1-2 | illegal correction between two episodes | `corrections:1`, `independent_count:2` | `corrections:0`, `independent_count:1` |
| P1-3 | `task-`, `task-a/b`, `task-..`, empty suffix | accepted | refused |
| P1-4 | `schema_version:"campaign-1.7"` | manifest accepts, dynamic-policy rejects | one shared version decision |
| P1-5 | `persistImmutableManifest` "existed" branch | missing `canonical_digest` | all success branches return `digest/canonical_digest/path/existed` |

## 2. File ownership (frozen for this round)

| Area | Files | Owner |
| --- | --- | --- |
| Campaign aggregate/closes | `Pi_Agent_base/memory/campaign/aggregate.mjs` | main DS (integration) |
| Manifest/version/persistence | `Pi_Agent_base/memory/campaign/manifest.mjs` | main DS |
| IDs | `Pi_Agent_base/memory/campaign/identifiers.mjs` | main DS |
| Dynamic admission | `Pi_Agent_base/memory/campaign/dynamic-policy.mjs` | main DS |
| Report/credentials | `Pi_Agent_base/memory/campaign/report.mjs` | main DS |
| Public exports | `Pi_Agent_base/memory/campaign/index.mjs` | main DS |
| C0 regression tests | `Pi_Agent_base/tests/aegis-campaign-contracts-c0.mjs`, `aegis-campaign-fixture-c0.mjs` | main DS |
| **New** C0 closure tests | `Pi_Agent_base/tests/aegis-campaign-closure-c0.mjs` | main DS |
| **New** C1 tests | `Pi_Agent_base/tests/aegis-campaign-c1-*.mjs` | main DS |
| **New** C1 modules | `Pi_Agent_base/memory/campaign/{event-contract,projection,ownership,scheduler}.mjs` | main DS |
| Plan/matrix/review docs | `docs/CAMPAIGN_{WORK_PLAN,TEST_MATRIX,REVIEW_REPORT}.md` | main DS |
| Fixture | `Pi_Agent_base/memory/campaign/fixture.mjs` | main DS (interface only; no semantic widening) |

Explicitly **not** owned / not modified: embedded `Pi_Agent_base/pi/**`,
credentials, model settings, lockfiles, root `AGENTS.md`, deleted Python tree,
`Pi_Agent_base/memory/runtime/events.mjs` (reused, not edited unless reported).

## 3. Frozen shared interfaces

- `validateManifest(input) -> {ok, reasons, manifest}` — never throws on
  malformed input; unknown major refused; same-major minors accepted.
- `schemaMajor(version)`, `isKnownCampaignMajor(version)` — the single shared
  version decision used by Manifest **and** dynamic-policy.
- `persistImmutableManifest(manifest, dir) -> {ok, digest, canonical_digest, path, existed}` on every success branch.
- `classifySupersede(outcome, {outcomes, trustedKinds, byId}) -> {valid, reason}`.
- `effectiveOutcomes(outcomes) -> outcome[]` with non-enumerable
  `ignored_supersedes` audit.
- `independenceOf(outcomes) -> {independent_count, raw_count, corrections, superseded_ids}`.
- `aggregateStage({stage, outcomes})`, `aggregateTask({task, stages, taskOracle, safetyViolation})`.
- `admitTaskProposal({proposal, manifest, queueState, depth}) -> {status, checks, reasons, reserved_budget}`.
- `buildCampaignReport({...})`, `buildAcceptanceBundle({report, runtimeDigests})`.
- C1 event vocabulary: `event_type: "runtime.note"`, `schema_version: "1.1"`,
  `payload.kind: "campaign.*"` (registered in existing `EVENT_TYPE_SCHEMA`).
- C1 `projectQueueFromEvents(...)`, ownership/checkpoint, scheduler control loop —
  frozen in `docs/CAMPAIGN_TEST_MATRIX.md` before implementation.

## 4. Task graph and dependencies

```text
C0-BASE  baseline + matrix + frozen interfaces                 [done]
C0-TEST  closure regression script (old-code red, 28 failures)  [done]
C0-ID    identifiers: suffix/path/.. + Stage global uniqueness  [done]
C0-MAN   shared version policy + persistence return fields      [done]
C0-OUT   supersede effective view + scope canonical + oracle binding + independence [done]
C0-STG   full required-stage/criterion aggregation              [done]
C0-DYN   parent-stage ownership + depth from parent chain       [done]
C0-REP   credentials whitelist + evidence refs + bounded bundle [done]
C0-INT   integration + mutation (10 caught) + regression + review [done]

C1-A  event contract (runtime.note / campaign.* kinds)          [done]
C1-B  projection + budget ledger                               [done]
C1-C  single writer / ownership / checkpoint                   [done]
C1-D  scheduler control loop (fake worker/oracle/clock)        [done]
C1-E  kill/restart/reconciliation recovery integration         [done]
C1-REVIEW cross-module review                                  [done]
```

C0 tasks touch mostly disjoint functions; OUT/REP share `report.mjs`/
`aggregate.mjs` internally, integrated by the main DS as one owner.

## 5. Fail-closed / semantics freezes

- Illegal supersede never enters `effectiveOutcomes` as a contributing row.
- `scope`/`criterion` compared canonically (sorted keys); both-missing scope is
  **not** a match.
- Task success requires: taskOracle.status === success AND matching task/episode/
  criterion/expected/scope binding AND all required stages success AND all
  required criteria present.
- `credentials` policy visible values are only `none` | `manifest_policy`;
  everything else is `[redacted]`.
- Dynamic `blocked` = human decision (new privilege/budget); `rejected` =
  malformed/duplicate/cycle. Hard structural limits are `rejected` when the
  contract says so.
- `pending` is never a persisted Outcome status.
- C0 helpers are pure; atomic reservation is C1.

## 6. Test matrix

See `docs/CAMPAIGN_TEST_MATRIX.md` (requirement → case → script → status). All
C0 and C1 cases are `pass`.

## 7. Stop conditions

STOP and record if: data model/promotion gate/authorization must change; Pi core
would need editing; a real model/target call becomes necessary; single-writer or
durable semantics cannot be achieved and a claim would have to be lowered.
Otherwise C0/C1 proceed autonomously. C2–C4a are **not** implemented this round.
