# Aegis C1 Integration Closure — Master DS Review Report

Status: **C1 closure internally_verified / awaiting_external_review**.
C2 is NOT implemented. External acceptance remains pending.

## 1. Baseline (pre-fix, recorded)

File: `Pi_Agent_base/runtime/dev/c1int/baseline.txt`.

| Item | Value |
| --- | --- |
| `git rev-parse HEAD` | `00000000000000000000000000000000` (branch-ref placeholder) |
| `git reflog -1` | `972acd9 HEAD@{0}: commit: docs: record the pwn_3 re-run …` |
| Node | v26.10.0 |
| Biome | 2.3.5 |
| Campaign suites (pre-fix) | 9/9 exit 0 (204 `ok` blocks) |
| Biome campaign | exit 0, 0 warnings |

### 1.1 Environment anomaly (honest)

`crypto.createHash`, `crypto.randomUUID`, `crypto.webcrypto.subtle.digest`,
`shasum`, `md5`, `sha256sum` ALL return `00000000000000000000000000000000` in
this harness (no `NODE_OPTIONS` preload). **Real SHA256 values are unavailable
here.** Digest tests therefore assert *structural equality across two real code
paths* and *that the existing `digest()` helper is used*, never a hard-coded real
digest. `HEAD` is a branch-ref placeholder, not proof that the repo has no
commits; the true tip is `972acd9` (reflog).

### 1.2 Reproduced C1EXT defects (old code)

Probes: `runtime/dev/c1int/probe_ext*.mjs`.

| ext | old behavior | required |
| --- | --- | --- |
| C1EXT-01 | bare `status:"success"` completed a task (foreign episode/criterion/no evidence) | full Outcome binding via a resolver |
| C1EXT-02 | only `started.append` checked; later appends failing returned `ok:true, reasons:[]` | unified durable commit; degraded + stop |
| C1EXT-03 | checkpoint read ignored the tail; `used_checkpoint` true without using cache; `sha256:local-*` | prefix+tail recovery; real SHA256 helper |
| C1EXT-04 | `ordered.sort` compared episode `sequence` first ⇒ reordered the log | reduce strictly in append order |
| C1EXT-05 | `submitted` no-op; inline `admitted` accepted; scheduler stayed on the initial array | submitted index + full definition + projection-driven dispatch |
| C1EXT-06 | gate borrowed Campaign remaining; consumption rejected; run returned ok | reserve-before-effect; strict per-task gate |
| C1EXT-07 | `campaignState` defaulted running; `stopped` no-op; recovery never applied a judgment | control from the projection; reconcile applies outcomes |

## 2. Orchestration honesty

No sub-agent tool exists in this harness (read/bash/edit/write/browser only).
Per `DS_ORCHESTRATION_WORKFLOW.md §1` the master DS executed the task graph
**serially**, switching test-author / implementer / reviewer roles. No child-DS
report was fabricated. Same-model self-review is not external acceptance.

## 3. Defect → fix mapping

| ext | fix | files |
| --- | --- | --- |
| 01 | new `outcome-resolver.mjs` (`resolveTaskOutcome`/`resolveTaskFromOutcomes`) reusing C0 `validateTaskOracleBinding`; projection resolves `campaign.oracle.result.outcome` and requires a matched current Task Outcome for `completed` | `outcome-resolver.mjs`, `projection.mjs` |
| 02 | one `commit()` durable boundary checks every append (`{ok:false}` / `durable:false` / throw); post-effect failures ⇒ degraded + stop + non-ok; `try/finally` cleanup; single-flight `run()` | `scheduler.mjs` |
| 03 | checkpoint binds stream offset + tail digest + projection/snapshot/payload digest; scheduler reduces only the tail on top of the cached snapshot via `priorState`; `used_checkpoint` only when the state is used; real `digest()` SHA256 helper | `projection.mjs`, `scheduler.mjs`, `ownership.mjs` |
| 04 | new `stream.mjs` preserves verified append order with offsets/tail; projection reduces strictly in array order (never by `sequence`) | `stream.mjs`, `projection.mjs` |
| 05 | `proposal.submitted` builds a proposal index (id+digest+object); `admitted` requires a prior submitted with a matching digest, re-validates via `admitTaskProposal`, and carries the FULL Task definition; scheduler resolves definitions from the projection | `projection.mjs`, `scheduler.mjs` |
| 06 | `canDispatch` requires the task's OWN reservation (no borrowing); `parseBudgetStrict` rejects negative/decimal/NaN/non-safe/wrong-type; known synthetic cost charged on success/failure/unknown | `projection.mjs`, `scheduler.mjs` |
| 07 | control state projected from committed events (`campaign.campaign.{paused,resumed,cancelled,stopped}`); scheduler reads control from the projection and never implicitly resumes; stranded intents reconciled through `oracle.reconcile` (effect probe) with a full Outcome or a "not done" record; delayed unknowns revisited with a fresh judgment (worker not re-run) | `projection.mjs`, `scheduler.mjs`, `event-contract.mjs`, `queue.mjs` |

## 4. Commands and exit codes (final)

Logs: `Pi_Agent_base/runtime/dev/c1int/verify/`.

| command | exit | ok |
| --- | --- | --- |
| `aegis-campaign-closure-c0.mjs` | 0 | 39 |
| `aegis-campaign-contracts-c0.mjs` | 0 | 58 |
| `aegis-campaign-fixture-c0.mjs` | 0 | 22 |
| `aegis-campaign-c1-event-projection.mjs` | 0 | 22 |
| `aegis-campaign-c1-scheduler.mjs` | 0 | 12 |
| `aegis-campaign-c1-ownership.mjs` | 0 | 16 |
| `aegis-campaign-c1-recovery.mjs` | 0 | 5 |
| `aegis-campaign-c1-closure.mjs` | 0 | 29 |
| `aegis-campaign-c1-eventlog-durability.mjs` | 0 | 3 |
| `aegis-campaign-c1-integration-contracts.mjs` | 0 | 21 |
| `aegis-campaign-c1-integration-scheduler.mjs` | 0 | 16 |
| `aegis-campaign-c1-integration-recovery.mjs` | 0 | 5 |
| `aegis-campaign-c1-integration-e2e.mjs` | 0 | 5 |
| `biome check …` | 0 | **0 warnings** |
| `tsc -p tsconfig.aegis-campaign.json` | 1 | **0 campaign errors**; 10 pre-existing import errors |

Regression (all exit 0): 8 offline suites and 4 real-Pi/faux suites
(`aegis-observer-data-use-pi`, `-verify-first-pi`, `-outcome-command`,
`-failclosed-pi`).

## 5. Red → green

- `aegis-campaign-c1-integration-contracts.mjs`: 20 cases; old-code red proven by
  mutation (below) and by the pre-fix probes.
- `aegis-campaign-c1-integration-scheduler.mjs`: 16 cases.
- `aegis-campaign-c1-integration-recovery.mjs`: 5 real-subprocess cases.
- `aegis-campaign-c1-integration-e2e.mjs`: 5 product scenarios.
- Existing suites updated only where they encoded the pre-fix contract
  (shallow oracle, inline admitted, `last_applied_digest`→`last_applied_event_id`,
  `last_event_sequence`→`stream_offset`, `stopped`→`cancelled`, sync→async control).

## 6. Mutation results

| mutation | case | expected | actual |
| --- | --- | --- | --- |
| accept `status:success` without binding | OUT-* | FAIL | FAIL |
| return ok on post-effect append failure | COMMIT-BUDGET | FAIL | FAIL |
| re-sort by episode sequence | ORDER-POS | FAIL | FAIL |
| ignore checkpoint `priorState.control` | ORDER-CONTROL | FAIL | FAIL |
| inline admitted without submitted | DYN-NOSUB | FAIL | FAIL |
| dispatch from the initial array only | E2E-NORMAL | FAIL | FAIL |
| borrow Campaign remaining without a reservation | BUD-ZERO/BUD-BOUND | FAIL | FAIL |
| scheduler ignores checkpoint prefix digest | CKP-FOREIGN | FAIL | FAIL |

All eight cross-module guards are killed by a behavioural assertion.

## 7. Scheduler + real EventLog evidence

- **E2E-NORMAL**: submitted→admitted→dispatched dynamic task; B delayed then
  verified; 3 dispatches, 3 real effects, `consumed_model_requests == dispatched`;
  re-run produces no duplicate effects or admission.
- **E2E-FAULT**: SIGKILL after the durable intent; the recover run reconciles via
  `oracle.reconcile` reading the real effect sentinel, commits a full Outcome,
  and does not re-run the worker.
- **E2E-CONTROL**: a durable cancel survives a restart (worker 0); a valid prefix
  checkpoint plus its tail equals the full replay; deleting the derived
  checkpoint and rebuilding yields the same semantics.
- **REC-EXISTS / REC-NOTDONE / REC-DELAY / REC-SIGTERM / REC-SIGKILL**: real
  subprocesses and the real EventLog, with SIGTERM draining distinct from SIGKILL.

## 8. Cross-module review findings

Files read end-to-end: all 15 `memory/campaign/*.mjs`, all 13 campaign tests,
all 6 helpers, `tsconfig.aegis-campaign.json`.

| severity | finding | status |
| --- | --- | --- |
| P1 | `unknown` was terminal, so a delayed unknown could never be legally verified | fixed (`unknown → waiting_oracle` + re-open on a new success; no worker restart) |
| P1 | a `campaign.task.unknown` re-affirming unknown dropped the newer `delayed_verification` reason | fixed |
| P2 | `dispatchOne({ task, row })` carried an unused `row` | fixed |
| P2 | duplicate `control` key in the checkpoint literal | fixed |

No open P0/P1.

## 9. What this does NOT prove

- External side-effect exactly-once (no Broker/executor idempotency).
- C2 real Pi Host-level Session rotation, C3 real Broker/Oracle adapters,
  C4/C4a Web UI and Pi `/aegis` commands.
- Real CTF / penetration / remote target / network / credentials.
- Distributed (multi-host) ownership; single-host only.
- Real SHA256 values in this harness (stubbed; see §1.1).
- A whole-repo tsc-clean state (10 pre-existing import errors).

`Aegis did not automatically invoke gpt-6.1-sol. No real target network or
credential access was used. Synthetic/faux evidence is labeled. Session count is
not independent Episode count. Unknown is not failure. External side-effect
exactly-once is NOT claimed. Status: C1 closure internally_verified /
awaiting_external_review.`
