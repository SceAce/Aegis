# Aegis C1 Closure — Master DS Review Report

Status: **C1 closure internally_verified / awaiting_external_review**.
External acceptance is performed by the user bringing this bundle back to the
current conversation. Aegis did NOT invoke `gpt-6.1-sol`.

## 1. Baseline (pre-fix, recorded)

File: `Pi_Agent_base/runtime/dev/c1clos_baseline.txt`.

| Item | Value |
| --- | --- |
| git HEAD | `00000000000000000000000000000000` — **no valid commit identity**; working-tree baseline |
| campaign suites | 7/7 exit 0 |
| Biome campaign | exit 0, **4 warnings** (unused vars) |

Pre-fix C1 state (per `C1_CLOSURE_BASELINE.md`):
`C1-A conditional, C1-B conditional, C1-C/D/E not accepted, C2 blocked`.

### 1.1 Reproduced defects (old code, probed)

Probe: `runtime/dev/probe_c1.mjs`.

| id | old behavior | required |
| --- | --- | --- |
| SRC-1.. | `agent`/`observer`/`environment` could drive oracle.result/task.completed/task.started | refused |
| ADM-1 | `proposal.admitted` with no proposal/decision created a task + budget | refused |
| QUE-1 | `cancelled` then `started` → `running` | terminal restart refused |
| QUE-2 | `paused` then `resumed` (unsatisfied dep) → `ready` | dep/budget re-checked |
| CHK-1 | scheduler never read/wrote checkpoint | binds + validates tail |
| OWN-1 | reclaim was not atomic | atomic CAS |
| REC-1 | recovery harness used a synthetic `writeFileSync` sink | labelled synthetic + real EventLog suite |

## 2. Orchestration honesty

No sub-agent tool exists in this harness (read/bash/edit/write + browser only).
Per `DS_ORCHESTRATION_WORKFLOW.md` §1 the master DS executed the task graph
**serially**, switching test-author / implementer / reviewer roles. No child-DS
report was fabricated. Same-model self-review is NOT external acceptance.

## 3. Fixes (old → new)

| Subtask | Change | File |
| --- | --- | --- |
| C1C-SOURCE | per-kind `CAMPAIGN_KIND_SOURCES`; `sourcesForKind()`; agent/observer/environment/llm restricted; runtime cannot self-Oracle | `event-contract.mjs` |
| C1C-ADMISSION | `campaign.proposal.admitted` requires a resolvable `proposal` + `admission.status:"admitted"` and re-validates against dynamic-policy | `projection.mjs` |
| C1C-QUEUE | frozen transition table enforced (terminal restart refused, illegal transitions audited); resume only from `paused` with dep re-check; incremental ready promotion | `projection.mjs` |
| C1C-BUDGET | `remaining = limit − reserved − consumed`; consumed clamped to reservation (audited); release clamped; static+dynamic one ledger; scheduler reads the live ledger per dispatch (task reservation + campaign remaining) | `projection.mjs`, `scheduler.mjs` |
| C1C-CHECKPOINT | scheduler reads/validates at startup and writes after each committed change; binds campaign id, manifest digest, revision, last event sequence+digest, projection digest, payload digest; tail mismatch → rebuild | `ownership.mjs`, `scheduler.mjs` |
| C1C-OWNERSHIP | lock is a DIRECTORY; reclaim via a single `wx` claim file + atomic rename; live/indeterminate owner never preempted; release verifies owner id | `ownership.mjs` |
| C1C-RECOVERY | synthetic sink explicitly labelled; new real-EventLog durability suite | `tests/helpers/*`, new test |

## 4. Commands and exit codes (final)

Logs: `Pi_Agent_base/runtime/dev/c1clos_verify/`.

| command | exit | ok |
| --- | --- | --- |
| `node Pi_Agent_base/tests/aegis-campaign-closure-c0.mjs` | 0 | 39 |
| `node Pi_Agent_base/tests/aegis-campaign-contracts-c0.mjs` | 0 | 58 |
| `node Pi_Agent_base/tests/aegis-campaign-fixture-c0.mjs` | 0 | 22 |
| `node Pi_Agent_base/tests/aegis-campaign-c1-event-projection.mjs` | 0 | 22 |
| `node Pi_Agent_base/tests/aegis-campaign-c1-scheduler.mjs` | 0 | 12 |
| `node Pi_Agent_base/tests/aegis-campaign-c1-ownership.mjs` | 0 | 14 |
| `node Pi_Agent_base/tests/aegis-campaign-c1-recovery.mjs` | 0 | 5 |
| `node Pi_Agent_base/tests/aegis-campaign-c1-closure.mjs` | 0 | 29 |
| `node Pi_Agent_base/tests/aegis-campaign-c1-eventlog-durability.mjs` | 0 | 3 |
| `biome check …` | 0 | **0 warnings** |
| `tsc -p tsconfig.aegis-campaign.json` | 1 | **0 campaign errors**; 10 pre-existing errors in imported `memory/runtime/events.mjs` + `memory/fixture/contracts.mjs` |

Regression (all exit 0): 8 offline suites (`aegis-workflow-evidence-d`,
`aegis-workflow-engine-d`, `aegis-runtime-core-smoke`,
`aegis-runtime-effective-board`, `memory-runtime-batch-b-smoke`,
`memory-runtime-learning-evidence-smoke`, `observer-smoke`,
`aegis-learning-bridge-e`) and 4 real-Pi/faux suites
(`aegis-observer-data-use-pi`, `aegis-observer-verify-first-pi`,
`aegis-observer-outcome-command`, `aegis-observer-failclosed-pi`).

New regression on old code: `aegis-campaign-c1-closure.mjs` **18 failures**
before the fixes (10 after the source fix, 6 after admission, 3 after queue/budget).

Process-based suites ran 15× with 0 flakes (ownership), 5× (recovery, durability).

## 5. Mutation results

| mutation | case | expected | actual |
| --- | --- | --- | --- |
| M1 accept any source for any kind | SRC-01..05 | FAIL | FAIL (8) |
| M2 admitted without decision accepted | ADM-01 | FAIL | FAIL (1) |
| M3b transition table always legal | contracts queue | FAIL | FAIL (1) |
| M4 resume state guard removed | QUE-04 | FAIL | FAIL (1) |
| M5 consumed-over-reservation accepted | BUD-11 | FAIL | FAIL (1) |
| M6 scheduler ignores ledger budget | BUD-10 | FAIL | FAIL (2) |
| M7 scheduler never writes checkpoint | CKP-10 | FAIL | FAIL (2) |
| M8 checkpoint ignores tail digest | CKP-12 | FAIL | FAIL (1) |
| M9 reclaim rename removed (not atomic) | WRT-02 | FAIL | FAIL (3/3) |
| M10 release ignores owner id | OWN-12 | FAIL | FAIL (1) |

M3 (removing the explicit `TERMINAL_STATES` guard in `task.started`) did **not**
fail any test because the frozen transition table independently blocks
`terminal → running`; the table mutation M3b is caught. This redundancy is
intentional defense-in-depth and is reported honestly.

## 6. Real evidence: checkpoint / ownership / budget / recovery

- **Checkpoint**: `CKP-10/11` assert a written checkpoint binds
  `manifest_digest`, `last_event_sequence`, `last_event_digest`,
  `projection_digest`, revision, and a `payload_digest`; `CKP-12` asserts a
  mismatched tail is rejected; `CKP-13` asserts a write failure leaves the
  events authoritative and `lastCheckpointOk() === false`; `CKP-15` asserts the
  replay projection is identical.
- **Ownership**: `OWN-10` races 4 REAL processes at a dead-owner lock — exactly
  one wins (claim file + atomic rename). `OWN-12` proves an intruder cannot
  release the lock. Stable across 15 runs.
- **Budget**: `BUD-10/16` prove the scheduler stops from the LIVE ledger (not an
  injected callback); `BUD-11/13/15` prove clamping and no double-charge.
- **Recovery**: `REC-10/11/12` (synthetic file sink, real SIGKILL) prove
  durable-before-dispatch ordering, unknown+reconciliation, and no duplicate
  completed action. `REC-13/14/15` (REAL `EventLog`, real SIGKILL / injected
  fsync failure) prove the fsync durability boundary.

### 6.1 Synthetic sink vs real EventLog

- Synthetic: `tests/helpers/campaign-scheduler-child.mjs` uses `writeFileSync`
  concatenation (no fsync); it exercises **control flow only** and is labelled
  as such in the test header.
- Real: `tests/helpers/campaign-eventlog-child.mjs` uses
  `memory/runtime/events.mjs` `EventLog` (append + fsync + hash chain) and is
  killed with SIGKILL; `aegis-campaign-c1-eventlog-durability.mjs` reopens and
  verifies the chain.

## 7. Exactly-once wording

C1 proves an **at-least-once recovery discipline** and "do not blindly re-run an
action whose result is unknown". Without a real Action Broker / executor
idempotency, **external side-effect exactly-once is NOT claimed**. The recovery
suite asserts "the effect happened exactly once" only for the synthetic
deterministic worker, and is labelled synthetic.

## 8. Warnings and baseline identity

- Biome: **0 warnings** (4 fixed).
- Baseline git HEAD is the all-zero placeholder; reported as
  `working tree baseline; no valid commit identity`, never as a real commit.

## 9. Cross-module review findings

Files read end-to-end: all 13 `memory/campaign/*.mjs`, all 9 campaign tests,
all 4 helpers, `tsconfig.aegis-campaign.json`.

| severity | finding | status |
| --- | --- | --- |
| P1 | event sort treated `sequence: null` (no-episode events) as 0, ordering `task.completed` before its oracle result | fixed (log order is primary key) |
| P1 | reclaim could rename a freshly-created lock (two winners) | fixed (single `wx` claim) |
| P2 | `budget.released` recorded requested not clamped amount | fixed |
| P2 | command dedup collapsed `proposal.submitted` + `proposal.admitted` (same proposal_id) | fixed (kind-prefixed dedup key) |

No open P0/P1.

## 10. What this does NOT prove

- External side-effect exactly-once (no Broker/executor).
- Real Pi Host-level Session rotation (C2), real Broker/Oracle adapters (C3),
  Web UI / Pi `/aegis` commands (C4/C4a).
- Real CTF / penetration / remote target / network / credentials.
- Distributed (multi-host) ownership; single-host only, fail-closed.
- The whole-repo tsc being error-free (campaign files are 0-error; 10
  pre-existing errors remain in imported untyped runtime files).

`Aegis did not automatically invoke gpt-6.1-sol. No real target network or
credential access was used. Synthetic/faux evidence is labelled. Session count
is not independent Episode count. Unknown is not failure. External side-effect
exactly-once is NOT claimed. Final external acceptance remains pending.`
