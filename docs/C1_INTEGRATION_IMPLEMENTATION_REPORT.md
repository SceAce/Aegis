# Aegis C1 Integration Closure — Implementation Report

Machine-readable companion: `docs/C1_INTEGRATION_IMPLEMENTATION_REPORT.json`.
Plan: `docs/C1_INTEGRATION_WORK_PLAN.md`. Matrix: `docs/C1_INTEGRATION_TEST_MATRIX.md`.
Review: `docs/C1_INTEGRATION_REVIEW_REPORT.md`.

Status: **C1 closure internally_verified / awaiting_external_review**. C2 is NOT
implemented.

## 1. Orchestration

No sub-agent tool exists in this harness; the master DS ran the task graph
serially with explicit test-author / implementer / reviewer role switches. No
child-DS report was fabricated. Same-model self-review is not external acceptance.

## 2. Baseline and environment

- `git rev-parse HEAD` → `00000000000000000000000000000000` (branch-ref
  placeholder); true tip `972acd9` from the reflog.
- **SHA256 is stubbed to all-zeros in this harness** (`crypto.createHash`,
  `randomUUID`, `subtle.digest`, `shasum`, `md5`, `sha256sum`). Digests are
  tested by cross-path equality and helper usage, never hard-coded values.

## 3. C1EXT closure summary

| ext | fix | files |
| --- | --- | --- |
| 01 | trusted Outcome resolver (reuses C0 binding); completion requires a matched current Outcome | `outcome-resolver.mjs`, `projection.mjs` |
| 02 | unified durable `commit()`; every append checked; degraded + stop + non-ok | `scheduler.mjs` |
| 03 | checkpoint binds offset+tail+snapshot+payload digest; prefix+tail recovery; real `digest()` | `projection.mjs`, `scheduler.mjs`, `ownership.mjs` |
| 04 | `stream.mjs` append order; projection never sorts by episode sequence | `stream.mjs`, `projection.mjs` |
| 05 | submitted index + digest binding; full dynamic Task definition; projection-driven dispatch | `projection.mjs`, `scheduler.mjs` |
| 06 | reserve-before-effect strict gate; strict budget parsing; cost on failure/unknown | `projection.mjs`, `scheduler.mjs` |
| 07 | control from the projection; explicit resume; reconcile applies outcomes; delayed unknown revisits | `projection.mjs`, `scheduler.mjs`, `event-contract.mjs`, `queue.mjs` |

## 4. Files

### Added
`memory/campaign/stream.mjs`, `memory/campaign/outcome-resolver.mjs`,
`tests/aegis-campaign-c1-integration-{contracts,scheduler,recovery,e2e}.mjs`,
`tests/helpers/campaign-{product,recovery}-child.mjs`.

### Modified
`memory/campaign/{projection,scheduler,ownership,event-contract,queue,index}.mjs`
and the existing campaign tests/helpers (updated only where they encoded the
pre-fix contract).

### Explicitly not modified
Embedded Pi core, credentials, model settings, lockfiles, deleted Python tree,
root `AGENTS.md`, `memory/runtime/events.mjs` (reused read-only).

## 5. Commands and exit codes

```text
aegis-campaign-closure-c0.mjs              exit 0  39 ok
aegis-campaign-contracts-c0.mjs            exit 0  58 ok
aegis-campaign-fixture-c0.mjs              exit 0  22 ok
aegis-campaign-c1-event-projection.mjs     exit 0  22 ok
aegis-campaign-c1-scheduler.mjs            exit 0  12 ok
aegis-campaign-c1-ownership.mjs            exit 0  16 ok
aegis-campaign-c1-recovery.mjs             exit 0   5 ok
aegis-campaign-c1-closure.mjs              exit 0  29 ok
aegis-campaign-c1-eventlog-durability.mjs  exit 0   3 ok
aegis-campaign-c1-integration-contracts.mjs exit 0 21 ok
aegis-campaign-c1-integration-scheduler.mjs exit 0 16 ok
aegis-campaign-c1-integration-recovery.mjs  exit 0  5 ok
aegis-campaign-c1-integration-e2e.mjs       exit 0  5 ok
biome …                                     exit 0  0 warnings
tsc -p tsconfig.aegis-campaign.json         exit 1  0 campaign errors / 10 pre-existing import errors
```

Regression: 8 offline suites + 4 real-Pi/faux suites, all exit 0.

## 6. Mutation

All eight cross-module guards are killed by a behavioural assertion: outcome
binding, post-effect append failure, episode-sequence re-sort, checkpoint
`priorState.control`, inline admission without `submitted`, initial-array-only
dispatch, borrowing Campaign budget, and the checkpoint prefix digest.

## 7. Scheduler + real EventLog product evidence

- **E2E-NORMAL**: real EventLog; submitted→admitted→dispatched dynamic task; B
  delayed then verified; 3 effects; `consumed == dispatched`; no duplicate
  effects/admission on a re-run.
- **E2E-FAULT**: SIGKILL after the durable intent; recovery reconciles via
  `oracle.reconcile` reading the real effect sentinel, commits a full Outcome,
  and does not re-run the worker.
- **E2E-CONTROL**: durable cancel survives restart (worker 0); prefix cache+tail
  equals the full replay; rebuild after deleting the checkpoint matches.
- **REC-EXISTS/NOTDONE/DELAY/SIGTERM/SIGKILL**: real subprocesses + real EventLog.

## 8. Synthetic vs real

- Synthetic Worker/Oracle with real temp-file effects and the **real** EventLog.
- The recovery harness is explicitly labelled synthetic for the Worker/Oracle;
  durability is proven through the real `EventLog` (append+fsync+hash chain).

## 9. Not implemented / not proven

- **Not implemented**: C2 real Pi Host-level Session rotation, C3 real
  Broker/Oracle adapters, C4/C4a Web UI and Pi `/aegis` commands.
- **Not proven**: external side-effect exactly-once, real CTF/network/credentials,
  distributed ownership, real SHA256 values in this harness, whole-repo tsc clean.

```text
Aegis did not automatically invoke gpt-6.1-sol.
No real target network or credential access was used.
Synthetic/faux evidence is labeled.
Session count is not independent Episode count.
Unknown is not failure.
External side-effect exactly-once is NOT claimed.
Status: C1 closure internally_verified / awaiting_external_review. C2 not started.
```
