# Aegis C1 Closure — Master Work Plan

Status: in progress. Target completion state:
`C1 closure internally_verified / awaiting_external_review`.
Owner: main DS (this session). No sub-agent tool exists in this harness, so the
task graph runs **serially** with explicit test-author / implementer / reviewer
role switches. No child-DS report is invented.

## 0. Baseline (recorded before any edit)

File: `Pi_Agent_base/runtime/dev/c1clos_baseline.txt`.

| Item | Value |
| --- | --- |
| git HEAD | `00000000000000000000000000000000` — **no valid commit identity** (working-tree baseline) |
| Node | v26.10.0 |
| Biome | 2.3.5 |
| campaign suite | 7/7 exit 0 (closure 39, contracts 58, fixture 22, c1-event-projection 22, c1-ownership 12, c1-scheduler 7, c1-recovery 5) |
| Biome campaign | exit 0, **4 warnings** (unused vars) |

Per `C1_CLOSURE_BASELINE.md` the pre-fix C1 state is fixed as:
`C1-A conditional, C1-B conditional, C1-C/D/E not accepted, C2 blocked`.

### 0.1 Reproduced C1 closure defects (old-code, probed before fixing)

Probed with `runtime/dev/probe_c1.mjs`.

| id | probe | old behavior (defect) | required |
| --- | --- | --- | --- |
| SRC-1 | `agent` + `campaign.oracle.result:success` | `ok:true` | refused |
| SRC-2 | `observer` + `campaign.task.completed` | `ok:true` | refused |
| SRC-3 | `environment` + `campaign.task.started` | `ok:true` | refused |
| ADM-1 | `proposal.admitted` with no proposal/decision ref | task created + budget reserved | refused (no effect) |
| QUE-1 | `cancelled` then `started` | state `running` | terminal restart refused |
| QUE-2 | `paused` then `resumed` with unsatisfied dep | state `ready` | dep/budget re-checked; not ready |
| CHK-1 | scheduler | never calls `readCheckpoint`/`writeCheckpoint` | reads/writes/binds checkpoint |
| OWN-1 | two dead-owner reclaimers | write+confirm is racy | atomic CAS (lock dir / rename) |
| REC-1 | recovery harness | `writeFileSync` concat, no fsync | label synthetic vs real EventLog |

## 1. File ownership (frozen)

| Subtask | Files | Owner |
| --- | --- | --- |
| C1C-SOURCE | `memory/campaign/event-contract.mjs` | main DS |
| C1C-ADMISSION | `memory/campaign/projection.mjs` (admitted case) | main DS |
| C1C-QUEUE | `memory/campaign/projection.mjs` (transitions) | main DS |
| C1C-BUDGET | `memory/campaign/projection.mjs` (ledger), `memory/campaign/scheduler.mjs` | main DS |
| C1C-CHECKPOINT | `memory/campaign/ownership.mjs` (checkpoint binding), `memory/campaign/scheduler.mjs` | main DS |
| C1C-OWNERSHIP | `memory/campaign/ownership.mjs` (lock) | main DS |
| C1C-RECOVERY | `tests/helpers/campaign-scheduler-child.mjs`, recovery test | main DS |
| C1C-INTEGRATE | `index.mjs`, test matrix, reports, config | main DS |
| shared | `docs/CAMPAIGN_*`, `tsconfig.aegis-campaign.json` | main DS |

`projection.mjs` is touched by ADMISSION/QUEUE/BUDGET but owned by one writer
(main DS) so there is no concurrent overwrite. Explicitly **not** modified:
embedded Pi core, credentials, model settings, lockfiles, deleted Python tree,
`memory/runtime/events.mjs` (reused read-only unless a blocker is reported).

## 2. Frozen C1 contracts

### 2.1 Per-kind source permissions (C1_CLOSURE_BASELINE §3.1)

| kind | allowed sources |
| --- | --- |
| `campaign.proposal.submitted` | llm, agent, human |
| `campaign.proposal.blocked`/`rejected` | runtime, human |
| `campaign.proposal.admitted` | runtime, human (with verified proposal+decision) |
| `campaign.task.started`/`paused`/`resumed`/`cancelled` | runtime, human |
| `campaign.task.completed` | runtime (with valid Task Oracle success) |
| `campaign.task.failed` | runtime |
| `campaign.task.unknown` | runtime, oracle, human |
| `campaign.oracle.result` | oracle, human, registered platform-result source |
| `campaign.budget.*` | runtime |
| `campaign.reconciliation.*` | runtime, oracle, human |
| `campaign.handoff.*` | runtime, human |
| `campaign.campaign.stopped` | runtime, human |

`agent`/`observer`/`environment` never gain a state-writing permission merely
by not being `llm`.

### 2.2 Admission event (C1_CLOSURE_BASELINE §3.2)

`campaign.proposal.admitted` must carry, from the SAME campaign:
`proposal_id`, a resolvable `proposal` object, and an `admission` decision
(`status:"admitted"`, `checks`, `reserved_budget`) produced by
`admitTaskProposal`. Absent/invalid decision ⇒ event rejected, no task/budget.

### 2.3 Queue transitions (C1_CLOSURE_BASELINE §3.3)

Use the frozen `queue.mjs` table. Extra: terminal states have no outgoing edge;
`resumed` re-checks dependency satisfaction and budget head-room; at most one
`running` task.

### 2.4 Budget ledger (C1_CLOSURE_BASELINE §3.4)

`remaining = limit − reserved_outstanding − consumed`. Scheduler reads the
projection ledger before every dispatch. `consumed ≤ reservation` unless audit
reason. Clamp release to held. Rebuild from events after restart.

### 2.5 Checkpoint (C1_CLOSURE_BASELINE §3.5)

Binds campaign id, manifest canonical digest, schema/projection version, last
event sequence, last event digest, revision, projection/ledger digest, payload
digest. Scheduler reads/validates and writes after each committed state change.
Mismatch → rebuild, never use.

### 2.6 Ownership (C1_CLOSURE_BASELINE §3.6)

Single-host. Atomic reclaim via an exclusive lock DIRECTORY (mkdir) or atomic
rename; exactly one winner. Live/indeterminate owner never preempted. Release
verifies owner id; never deletes a newer owner's lock.

### 2.7 Recovery wording (C1_CLOSURE_BASELINE §3.7)

No external exactly-once claim without a Broker/executor. Recovery tests must
label the synthetic file sink vs the real `EventLog`.

## 3. Task graph

```text
C1C-BASE       baseline + matrix + frozen contracts        [done]
C1C-TEST       closure regression script (old-code red)     [ ]
C1C-SOURCE     per-kind source permissions                  [ ]
C1C-ADMISSION  admitted-event validation                    [ ]
C1C-QUEUE      transition table + resume/terminal           [ ]
C1C-BUDGET     live ledger in scheduler + limits            [ ]
C1C-CHECKPOINT scheduler read/write/bind + tail validation  [ ]
C1C-OWNERSHIP  atomic reclaim/release                       [ ]
C1C-RECOVERY   real EventLog sink + synthetic distinction   [ ]
C1C-INTEGRATE  warnings, regression, mutation, review       [ ]
```

## 4. Stop conditions

Stop and record if: user-confirmed data model / permission boundary / evidence
gate must change; Pi core must change; a real external dependency or real model
is required. Otherwise proceed autonomously. C2 is **not** implemented.

## 5. Deliverables

`docs/C1_CLOSURE_WORK_PLAN.md` (this file), `docs/C1_CLOSURE_TEST_MATRIX.md`,
`docs/C1_CLOSURE_REVIEW_REPORT.md`,
`docs/C1_CLOSURE_IMPLEMENTATION_REPORT.{md,json}`.
