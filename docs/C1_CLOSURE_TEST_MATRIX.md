# Aegis C1 Closure — Test Matrix

Status legend: `not_run` | `pass` | `fail` | `blocked`. `old` = expected failure
on pre-fix code. ALL cases below are `pass` after the C1 closure fixes. `evidence` = result | artifact | counter | process | event_chain.

Scripts:
- `S1` = `Pi_Agent_base/tests/aegis-campaign-c1-event-projection.mjs` (extended)
- `S2` = `Pi_Agent_base/tests/aegis-campaign-c1-ownership.mjs` (extended)
- `S3` = `Pi_Agent_base/tests/aegis-campaign-c1-scheduler.mjs` (extended)
- `S4` = `Pi_Agent_base/tests/aegis-campaign-c1-recovery.mjs` (extended)
- `S5` = `Pi_Agent_base/tests/aegis-campaign-c1-closure.mjs` (new: source/admission/queue/budget/checkpoint focused)
- `S6` = `Pi_Agent_base/tests/aegis-campaign-c1-eventlog-durability.mjs` (new: real EventLog fsync)

## A. Event source permissions (C1C-SOURCE)

| case_id | req | input_origin | setup / action / expected | evidence | old | script | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SRC-01 | source | committed_event | `agent` + `campaign.oracle.result:success` → rejected | result | FAIL | S5 | pass |
| SRC-02 | source | committed_event | `observer` + `campaign.task.completed` → rejected | result | FAIL | S5 | pass |
| SRC-03 | source | committed_event | `environment` + `campaign.task.started` → rejected | result | FAIL | S5 | pass |
| SRC-04 | source | committed_event | `agent` + `campaign.task.completed` → rejected | result | FAIL | S5 | pass |
| SRC-05 | source | committed_event | `observer` + `campaign.oracle.result` → rejected | result | FAIL | S5 | pass |
| SRC-06 | source | committed_event | `llm` + `campaign.proposal.submitted` → accepted (recorded) | result | pass | S5 | pass |
| SRC-07 | source | committed_event | `llm` + `campaign.proposal.admitted` → rejected | result | pass | S5 | pass |
| SRC-08 | source | committed_event | `runtime` + `campaign.task.started` → accepted | result | pass | S5 | pass |
| SRC-09 | source | committed_event | `oracle` + `campaign.oracle.result` (bound) → accepted | result | pass | S5 | pass |
| SRC-10 | source | committed_event | `runtime` + `campaign.oracle.result` → rejected (runtime cannot self-Oracle) | result | FAIL | S5 | pass |
| SRC-11 | source | committed_event | `llm` + `campaign.task.completed` → rejected | result | pass | S5 | pass |

## B. Dynamic admission (C1C-ADMISSION)

| case_id | req | input_origin | setup / action / expected | evidence | old | script | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ADM-01 | admission | committed_event | admitted with no proposal/decision → no task, no budget | counter | FAIL | S5 | pass |
| ADM-02 | admission | committed_event | admitted with valid proposal+decision → task created, budget reserved | result | pass | S5 | pass |
| ADM-03 | admission | committed_event | admitted referencing a decision whose status is blocked/rejected → no effect | result | FAIL | S5 | pass |
| ADM-04 | admission | committed_event | same proposal_id replayed → applied once | counter | pass | S5 | pass |
| ADM-05 | admission | model_proposal | new target/capability/adapter → policy blocks; no admitted event | result | pass | S5 | pass |
| ADM-06 | admission | model_proposal | foreign parent stage → policy rejects | result | pass | S2/S5 | pass |

## C. Queue transitions (C1C-QUEUE)

| case_id | req | input_origin | setup / action / expected | evidence | old | script | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| QUE-01 | transition | committed_event | `cancelled` then `started` → restart refused, state stays cancelled | result | FAIL | S5 | pass |
| QUE-02 | transition | committed_event | `unknown` then `started` → refused | result | FAIL | S5 | pass |
| QUE-03 | transition | committed_event | `completed` then `started` → refused | result | FAIL | S5 | pass |
| QUE-04 | transition | committed_event | `paused` then `resumed` with unsatisfied dep → not ready | result | FAIL | S5 | pass |
| QUE-05 | transition | committed_event | `paused` then `resumed` with satisfied dep + budget → ready | result | pass | S5 | pass |
| QUE-06 | transition | committed_event | `queued` task started with unsatisfied dep → refused | result | pass | S5 | pass |
| QUE-07 | transition | committed_event | `task.completed` without trusted Oracle success → not completed | result | pass | S5 | pass |
| QUE-08 | transition | committed_event | two `task.started` → at most one running | result | pass | S5 | pass |
| QUE-09 | transition | committed_event | illegal `ready`→`completed` (no run) → refused | result | FAIL | S5 | pass |

## D. Budget ledger (C1C-BUDGET)

| case_id | req | input_origin | setup / action / expected | evidence | old | script | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BUD-10 | ledger | committed_event | scheduler reads projection ledger; stops when limit reached | counter | FAIL | S3 | pass |
| BUD-11 | ledger | committed_event | consumed > reservation → rejected/clamped with audit | result | FAIL | S5 | pass |
| BUD-12 | ledger | committed_event | static + dynamic share one ledger | counter | pass | S5 | pass |
| BUD-13 | ledger | committed_event | cancel/release clamp at zero, no double release | counter | pass | S5 | pass |
| BUD-14 | ledger | committed_event | restart rebuilds budget from events (not zero) | counter | FAIL | S4 | pass |
| BUD-15 | ledger | committed_event | duplicate command does not double-charge | counter | pass | S5 | pass |
| BUD-16 | ledger | committed_event | `budgetExhausted()` callback alone does not prove control (real ledger used) | result | FAIL | S3 | pass |

## E. Checkpoint (C1C-CHECKPOINT)

| case_id | req | input_origin | setup / action / expected | evidence | old | script | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CKP-10 | checkpoint | committed_event | scheduler writes checkpoint after committed state change | artifact | FAIL | S3 | pass |
| CKP-11 | checkpoint | committed_event | checkpoint binds manifest digest, revision, last sequence+digest, projection digest | artifact | FAIL | S3 | pass |
| CKP-12 | checkpoint | committed_event | tail digest mismatch → rebuild from events | artifact | FAIL | S3 | pass |
| CKP-13 | checkpoint | committed_event | checkpoint write failure → events remain authoritative, no false success | result | FAIL | S3 | pass |
| CKP-14 | checkpoint | committed_event | checkpoint ahead/foreign/corrupt → ignored/rebuild | artifact | pass | S2 | pass |
| CKP-15 | checkpoint | committed_event | rebuild from checkpoint+tail == full replay | result | FAIL | S3 | pass |

## F. Ownership (C1C-OWNERSHIP)

| case_id | req | input_origin | setup / action / expected | evidence | old | script | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OWN-10 | ownership | real_process | two dead-owner reclaimers → exactly one winner | process | FAIL | S2 | pass |
| OWN-11 | ownership | real_process | live owner not preempted | process | pass | S2 | pass |
| OWN-12 | ownership | real_process | release race cannot delete a newer owner's lock | process | FAIL | S2 | pass |
| OWN-13 | ownership | real_process | indeterminate PID → fail closed | result | pass | S2 | pass |
| OWN-14 | ownership | real_process | recovery re-acquires; old owner cannot continue writing | process | FAIL | S4 | pass |

## G. Recovery / durability (C1C-RECOVERY)

| case_id | req | input_origin | setup / action / expected | evidence | old | script | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REC-10 | recovery | real_process + synthetic sink | kill before intent → no worker call | process | pass | S4 | pass |
| REC-11 | recovery | real_process + synthetic sink | kill after intent before result → unknown/reconcile, no blind rerun | process | pass | S4 | pass |
| REC-12 | recovery | real_process + synthetic sink | kill after result before checkpoint → replay, no duplicate same completed action | process | pass | S4 | pass |
| REC-13 | durability | real EventLog | append/fsync failure before dispatch → worker not called | process | FAIL | S6 | pass |
| REC-14 | durability | real EventLog | real EventLog fsync durability: append survives a real SIGKILL child | process | FAIL | S6 | pass |

## H. C1 closure outcome

All A-G cases pass. Mutation results are recorded in
`docs/C1_CLOSURE_REVIEW_REPORT.md` §5.

## H2. Not proven this round

- External side-effect exactly-once (no Broker/executor idempotency).
- C2 real Pi Session rotation, C3 Broker/Oracle adapters, C4/C4a UI.
- Real CTF/penetration/remote network/credentials.
- Distributed multi-host ownership.

## I. Mutation plan

| mutation | case | expected |
| --- | --- | --- |
| accept `agent` for oracle.result | SRC-01 | FAIL |
| admitted without decision accepted | ADM-01 | FAIL |
| terminal restart allowed | QUE-01 | FAIL |
| resume skips dep check | QUE-04 | FAIL |
| scheduler ignores budget ledger | BUD-10 | FAIL |
| scheduler never writes checkpoint | CKP-10 | FAIL |
| checkpoint ignores tail digest | CKP-12 | FAIL |
| reclaim not atomic | OWN-10 | FAIL |
| release deletes newer lock | OWN-12 | FAIL |
