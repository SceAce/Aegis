# Aegis C1 Closure — Implementation Report

Machine-readable companion: `docs/C1_CLOSURE_IMPLEMENTATION_REPORT.json`.
Plan: `docs/C1_CLOSURE_WORK_PLAN.md`. Matrix: `docs/C1_CLOSURE_TEST_MATRIX.md`.
Review: `docs/C1_CLOSURE_REVIEW_REPORT.md`.

Status: **C1 closure internally_verified / awaiting_external_review**.
C2 is NOT implemented.

## 1. Orchestration

No sub-agent tool exists in this harness, so the master DS ran the task graph
serially with explicit test-author / implementer / reviewer role switches. No
child-DS report was fabricated. Same-model self-review is not external acceptance.

## 2. Baseline

- git HEAD `00000000000000000000000000000000` → **working tree baseline; no valid
  commit identity**.
- Pre-fix: 7/7 campaign suites exit 0, Biome exit 0 with **4 warnings**.

## 3. Files

### Modified
- `memory/campaign/event-contract.mjs` — per-kind source permissions
- `memory/campaign/projection.mjs` — admission validation, transitions, ledger
- `memory/campaign/scheduler.mjs` — live ledger budget, checkpoint read/write
- `memory/campaign/ownership.mjs` — directory lock, atomic reclaim, checkpoint binding
- `memory/campaign/index.mjs` — exports

### Added tests
- `tests/aegis-campaign-c1-closure.mjs` (source/admission/queue/budget)
- `tests/aegis-campaign-c1-eventlog-durability.mjs` (real EventLog fsync)
- `tests/helpers/campaign-reclaim-child.mjs`
- `tests/helpers/campaign-eventlog-child.mjs`

### Modified tests
- `c1-event-projection.mjs`, `c1-scheduler.mjs`, `c1-ownership.mjs`,
  `c1-recovery.mjs`, `tests/helpers/campaign-scheduler-child.mjs`

### Explicitly not modified
Embedded Pi core, credentials, model settings, lockfiles, deleted Python tree,
root `AGENTS.md`, `memory/runtime/events.mjs` (reused read-only).

## 4. Commands and exit codes

```text
aegis-campaign-closure-c0.mjs            exit 0  39 ok
aegis-campaign-contracts-c0.mjs          exit 0  58 ok
aegis-campaign-fixture-c0.mjs            exit 0  22 ok
aegis-campaign-c1-event-projection.mjs   exit 0  22 ok
aegis-campaign-c1-scheduler.mjs          exit 0  12 ok
aegis-campaign-c1-ownership.mjs          exit 0  14 ok  (15/15 stable)
aegis-campaign-c1-recovery.mjs           exit 0   5 ok
aegis-campaign-c1-closure.mjs            exit 0  29 ok  (18 FAIL on old code)
aegis-campaign-c1-eventlog-durability.mjs exit 0  3 ok
biome …                                  exit 0  0 warnings
tsc -p tsconfig.aegis-campaign.json      exit 1  0 campaign errors / 10 pre-existing import errors
```

Regression: 8 offline suites + 4 real-Pi/faux suites, all exit 0.

## 5. Old-code red → new-code green

`aegis-campaign-c1-closure.mjs` failed **18** assertions before the fixes:
source permissions (SRC-1/2/3/10/11), admission (ADM-1..4), queue (QUE-1..4),
budget (BUD-11/12).

## 6. Focused fixes

- **Source**: `agent`/`observer`/`environment` can no longer drive
  oracle.result/task.completed/task.started; `runtime` cannot self-Oracle;
  `llm`/`agent` proposals are recorded but never admitted.
- **Admission**: `proposal.admitted` requires a resolvable proposal AND an
  `admitted` dynamic-policy decision, re-validated live; otherwise no task/budget.
- **Queue**: frozen transition table enforced; terminal restart refused; resume
  only from `paused`; incremental ready promotion.
- **Budget**: `remaining = limit − reserved − consumed`; consumed clamped;
  release clamped; static + dynamic share one ledger; scheduler reads the live
  ledger each dispatch (task reservation + campaign remaining).
- **Checkpoint**: scheduler reads/validates at startup and writes after each
  committed change, bound to the event tail + projection/payload digest.
- **Ownership**: directory lock + single `wx` claim + atomic rename; live owner
  never preempted; release verifies owner id.
- **Recovery**: synthetic sink explicitly labelled; a real-EventLog suite proves
  fsync durability across a real SIGKILL.

## 7. Mutation

10/10 targeted mutations produced a test failure. One explicit guard (the
terminal-restart guard in `task.started`) is redundant with the transition table;
the table mutation is caught. See the review report §5.

## 8. Fault-matrix coverage

| fault | test |
| --- | --- |
| append/fsync failure before action | `REC-13` (real EventLog), `DUR-01` (scheduler) |
| log failure after possible action | `REC-11` (synthetic) |
| process exits while idle | `REC-14` (real EventLog SIGKILL) |
| exit during tool call | `REC-11` unknown + reconciliation |
| Oracle unavailable / delayed | `RUN-UNKNOWN` |
| budget exhausted | `BUD-10/16`, `RUN-01` |
| user cancellation | `RUN-01` |
| killed/restarted | `REC-10/11/12/14` |
| contradictory outcomes | C0 stage/task aggregation |
| duplicate scheduler | `OWN-10` (4-process race) |
| stale checkpoint | `CKP-12` |

## 9. Synthetic sink vs real EventLog

- **Synthetic** (`campaign-scheduler-child.mjs`): `writeFileSync` JSONL, no
  fsync. Proves control flow only.
- **Real** (`campaign-eventlog-child.mjs`): `memory/runtime/events.mjs` EventLog
  (append + fsync + hash chain), killed with SIGKILL; reopened and verified.

## 10. Not implemented / not proven

- **Not implemented**: C2 real Pi Host-level Session rotation, C3 real
  Broker/Oracle adapters, C4/C4a Web UI and Pi `/aegis` commands.
- **Not proven**: external side-effect exactly-once (no Broker/executor),
  real CTF/penetration/remote network/credentials, distributed ownership, and a
  whole-repo tsc-clean state (10 pre-existing import errors).

```text
Aegis did not automatically invoke gpt-6.1-sol.
No real target network or credential access was used.
Synthetic/faux evidence is labeled.
Session count is not independent Episode count.
Unknown is not failure.
External side-effect exactly-once is NOT claimed.
The final external acceptance remains pending for the user/current review session.
Status: C1 closure internally_verified / awaiting_external_review.
```
