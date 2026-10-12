# Aegis Campaign — Implementation Report

Machine-readable companion: `docs/CAMPAIGN_IMPLEMENTATION_REPORT.json`.
Plan: `docs/CAMPAIGN_WORK_PLAN.md`. Matrix: `docs/CAMPAIGN_TEST_MATRIX.md`.
Review: `docs/CAMPAIGN_REVIEW_REPORT.md`.

Status: **internally_verified** (C0 closure + C1) / **awaiting_external_review**.

## 1. Summary

C0 was closed by reproducing the audited defects as regression tests, fixing the
implementation, and proving the tests catch the defects by mutation. C1 (event
contract, projection/budget ledger, single-writer ownership + checkpoint,
scheduler control loop, kill/restart recovery) was then implemented test-first
with fake worker/oracle/clock and real local subprocesses. C2–C4a are **not**
implemented this round.

## 2. Orchestration

This harness has no sub-agent tool, so the master DS ran the task graph
serially, switching roles explicitly. No child-DS report was fabricated. Same-
model self-review is not external acceptance.

## 3. Files

### Added (C1)
- `Pi_Agent_base/memory/campaign/event-contract.mjs`
- `Pi_Agent_base/memory/campaign/projection.mjs`
- `Pi_Agent_base/memory/campaign/ownership.mjs`
- `Pi_Agent_base/memory/campaign/scheduler.mjs`
- `Pi_Agent_base/tests/aegis-campaign-closure-c0.mjs`
- `Pi_Agent_base/tests/aegis-campaign-c1-event-projection.mjs`
- `Pi_Agent_base/tests/aegis-campaign-c1-ownership.mjs`
- `Pi_Agent_base/tests/aegis-campaign-c1-scheduler.mjs`
- `Pi_Agent_base/tests/aegis-campaign-c1-recovery.mjs`
- `Pi_Agent_base/tests/helpers/campaign-lock-child.mjs`
- `Pi_Agent_base/tests/helpers/campaign-scheduler-child.mjs`
- `Pi_Agent_base/tsconfig.aegis-campaign.json`

### Modified (C0 closure)
- `aggregate.mjs`, `manifest.mjs`, `identifiers.mjs`, `dynamic-policy.mjs`,
  `report.mjs`, `index.mjs`, `fixture.mjs`

### Explicitly not modified
Embedded Pi core, credentials, model settings, lockfiles, root `AGENTS.md`,
deleted Python tree, `memory/runtime/events.mjs` (reused read-only).

## 4. Commands and exit codes

See `CAMPAIGN_IMPLEMENTATION_REPORT.json` §commands. Headline:

```text
aegis-campaign-closure-c0.mjs            exit 0  39 ok   (28 FAIL on old code)
aegis-campaign-contracts-c0.mjs          exit 0  58 ok
aegis-campaign-fixture-c0.mjs            exit 0  22 ok
aegis-campaign-c1-event-projection.mjs   exit 0  22 ok
aegis-campaign-c1-ownership.mjs          exit 0  12 ok
aegis-campaign-c1-scheduler.mjs          exit 0   7 ok
aegis-campaign-c1-recovery.mjs           exit 0   5 ok
biome …                                  exit 0
tsc -p tsconfig.aegis-campaign.json      exit 1   0 campaign errors / 10 pre-existing import errors
```

Offline regression (8 suites) and real-Pi/faux-provider regression (4 suites)
all exit 0.

## 5. Old-code red → new-code green

`aegis-campaign-closure-c0.mjs` failed 28 assertions on the pre-fix code,
reproducing P0-1 (illegal corrections in the effective view), P0-2 (missing
scope matched, key-order sensitivity), P0-3 (`api_key=SECRET` leaked),
P1-1 (unbound TaskOracle → success), P1-2 (illegal correction inflated
independence), P1-3 (empty/path IDs accepted), P1-4 (version mismatch),
P1-5 (missing `canonical_digest`), CLOSE-08/09/10/11.

## 6. Mutation

Ten high-value guards were mutated in isolation; all ten produced a test FAILURE
that was not merely a syntax/import error. See review report §5.

## 7. Rebuild

- C0 derived report rebuilt from the immutable Manifest + fixture outcomes →
  identical `report_digest`/`bundle_digest`.
- C1 queue rebuilt from the committed `events.jsonl` after process death →
  identical projection; side effects exactly once.
- Checkpoint rejected when foreign/ahead/corrupt/other-campaign.

## 8. Fault-matrix coverage

| fault | test |
| --- | --- |
| append failure before action | `DUR-01` (scheduler) + `REC-01` (subprocess) |
| log failure after possible action | `REC-02` reconcile, no rerun |
| process exits while idle | `REC-03` replay, exactly once |
| exit during tool call | `REC-02` unknown + reconciliation |
| Oracle unavailable / delayed | `RUN-UNKNOWN` delayed oracle blocks dependents |
| budget exhausted | `RUN-01` budget_stopped |
| user cancellation | `RUN-01` cancelled, no false failure |
| killed/restarted | `REC-01/02/03`, `END-01` |
| contradictory verified outcomes | C0 stage/task aggregation (conflict surfaced) |
| duplicate scheduler | `WRT-01` multi-process |
| stale checkpoint | `CKP-01` |

## 9. Blockers and architecture decisions

- None open. C1 ownership is deliberately single-host and fail-closed (not a
  distributed lease). Real C2/C3 adapters are deferred and are the next
  authorization point.

## 10. What this does not prove

Real Pi Host-level Session rotation, real Broker/Oracle adapters, Web UI/Pi
commands, real targets/network/credentials, distributed ownership, statistical
learning efficacy, or a "complete long-running Campaign". The tsconfig is
campaign-clean but the imported pre-existing runtime still has 10 untyped errors.

```text
Aegis did not automatically invoke gpt-6.1-sol.
No real target network or credential access was used.
Synthetic/faux evidence is labeled.
Session count is not independent Episode count.
Unknown is not failure.
The final external acceptance remains pending for the user/current review session.
```
