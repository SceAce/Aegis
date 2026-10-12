# Aegis C1 Integration Closure — Test Matrix

Status: all listed cases `pass` after the fixes unless marked. `old` = expected
failure on pre-fix code (probed, see `C1_INTEGRATION_WORK_PLAN.md §0.2`).
`evidence` ∈ result | artifact | counter | process | event_chain | ledger.

Scripts:
- `T1` = `tests/aegis-campaign-c1-integration-contracts.mjs` (new)
- `T2` = `tests/aegis-campaign-c1-integration-scheduler.mjs` (new)
- `T3` = `tests/aegis-campaign-c1-integration-recovery.mjs` (new)
- `T4` = `tests/aegis-campaign-c1-integration-e2e.mjs` (new)
- `H1` = `tests/helpers/campaign-product-child.mjs` (new)
- existing: `aegis-campaign-{closure-c0,contracts-c0,fixture-c0,c1-event-projection,c1-scheduler,c1-ownership,c1-recovery,c1-closure,c1-eventlog-durability}.mjs`

## A. ORDER / C1EXT-04 (T1)

| case | input | expected | evidence | old | status |
| --- | --- | --- | --- | --- | --- |
| ORDER-POS | reserve(episode seq=5) then consume(episode seq=0), different episodes, append order reserve→consume | consumed applied; no rejection | ledger | FAIL | pass |
| ORDER-NULL | mixed `sequence:null` and integer, oracle→completion in append order | reduce in append order; completed | result | FAIL | pass |
| ORDER-TAIL | last committed record is a rejected command | tail = last committed; applied diagnostic separate | result | FAIL | pass |
| ORDER-BADCHAIN | tampered JSONL digest | scheduler fails closed; worker 0 | process | pass | pass |
| ORDER-IDEMP | same command twice, same/different payload | applied once; conflicting id surfaced | counter | pass | pass |

## B. OUTCOME / C1EXT-01 (T1, T2)

| case | input | expected | evidence | old | status |
| --- | --- | --- | --- | --- | --- |
| OUT-POS | fully bound trusted success (task/episode/criterion/scope/evidence) | completed; dependency ready; outcome_id traceable | result | pass | pass |
| OUT-FOREIGN | foreign campaign/task/episode/stage | not completed; reason | result | FAIL | pass |
| OUT-CRITERION | criterion_id same, expected differs / wrong criterion | rejected | result | FAIL | pass |
| OUT-NOREF | missing/unresolvable evidence, missing scope/observed | not success; unknown/invalid reason | result | FAIL | pass |
| OUT-SOURCE | agent/observer/runtime pseudo-oracle | refused at boundary | result | pass | pass |
| OUT-PARTIAL | only one required criterion/stage success | not success | result | FAIL | pass |
| OUT-CURRENT | prior success superseded by legal unknown/stale | not completed on historical success | result | FAIL | pass |
| OUT-CONFLICT | unresolved trusted success vs failure | conflict; dependents not promoted | result | FAIL | pass |
| OUT-REFMATCH | completion references a different/foreign outcome_id | completion refused | result | FAIL | pass |

## C. COMMIT / C1EXT-02 (T2)

| case | boundary | expected | evidence | old | status |
| --- | --- | --- | --- | --- | --- |
| COMMIT-BEFORE | started/reservation append `{ok:false}` | worker 0; not ok | counter | pass | pass |
| COMMIT-BUDGET | worker ran; consumed append `{ok:false}` | degraded, stop new dispatch, non-ok | counter | FAIL | pass |
| COMMIT-RESULT | oracle result append `{ok:false}` | not completed; reconcile pending | result | FAIL | pass |
| COMMIT-DONE | result durable, completion append `{ok:false}` | recovery completes lifecycle; effect not re-run | counter | FAIL | pass |
| COMMIT-UNKNOWN | failed worker; unknown/reconcile append `{ok:false}` | not `ok:true,[]`; no fabricated durable unknown | result | FAIL | pass |
| COMMIT-CONTROL | cancel/stop append `{ok:false}` | no false durable cancel; process stops dispatch; failure surfaced | result | FAIL | pass |
| COMMIT-CLEANUP | re-entrant run / injected throw | single-flight or refuse; owner cleaned; no 2nd writer | process | FAIL | pass |
| COMMIT-FSYNC | real EventLog fsync failure before dispatch | worker 0 | process | pass | pass |

## D. DYNAMIC / C1EXT-05 (T1, T2, T4)

| case | action | expected | evidence | old | status |
| --- | --- | --- | --- | --- | --- |
| DYN-POS | submitted → policy → durable admitted → scheduler | dynamic worker runs; not in initial array | counter | FAIL | pass |
| DYN-NOSUB | delete submitted, inline proposal/admission only | no task, no reserve | counter | FAIL | pass |
| DYN-SWAP | inline proposal digest differs from submitted | refused | result | FAIL | pass |
| DYN-FOREIGN | foreign parent stage/target/capability/adapter/伪depth | not admitted; checks visible | result | pass | pass |
| DYN-OVER | fan-out/count/budget at limit-1/limit/limit+1 | strict boundary; no double static count | counter | pass | pass |
| DYN-DUP | repeated admission / new random id same semantics | no double task/reserve/effect | counter | FAIL | pass |
| DYN-RESTART | admitted durable, exit before dispatch | new scheduler recovers definition and runs | process | FAIL | pass |
| DYN-DEFINED | admitted task missing goal/stages/oracle/stop | explicit error, not silent break ok | result | FAIL | pass |

## E. BUDGET / C1EXT-06 (T1, T2)

| case | setup | expected | evidence | old | status |
| --- | --- | --- | --- | --- | --- |
| BUD-POS | allocation=3, synthetic cost=1 | consumed=1, outstanding=2; others unaffected | ledger | pass | pass |
| BUD-ZERO | task allocation=0, campaign has room | blocked default, worker 0 | counter | FAIL | pass |
| BUD-BOUND | need==held / need>held | equal executes+charges; greater does not | ledger | FAIL | pass |
| BUD-TWO | two ready tasks, shared hard limit | no dispatch without budget; gate per dispatch | ledger | FAIL | pass |
| BUD-FAIL | worker effect then failure/unknown | known synthetic cost preserved; unknown cost not 0 | ledger | FAIL | pass |
| BUD-CRASH | exit before effect/charge | reservation recovers conservatively; no free rerun | process | pass | pass |
| BUD-BAD | negative/decimal/non-safe/NaN/wrong type delta | rejected; ledger unchanged | result | FAIL | pass |
| BUD-RELEASE | completion/cancel release, duplicate release | total not increased; pending effect retained | ledger | pass | pass |

## F. CONTROL/RECOVERY / C1EXT-07 (T2, T3)

| case | setup | expected | evidence | old | status |
| --- | --- | --- | --- | --- | --- |
| CTRL-CANCEL | durable cancel, destroy scheduler, recreate/run | worker 0; cancel preserved | process | FAIL | pass |
| CTRL-PAUSE | durable pause, restart | worker 0; explicit resume required | process | FAIL | pass |
| CTRL-STOP | budget/manual stop restart | not implicitly resumed; budget not widened | process | FAIL | pass |
| CTRL-INFLIGHT | cancel/pause while worker runs | stop later dispatch; in-flight intent drained/reconciled | process | FAIL | pass |
| REC-EXISTS | durable intent, no result, sentinel shows effect | fake oracle reads artifact, commits Outcome, worker not re-run | artifact | FAIL | pass |
| REC-NOTDONE | confirmed no effect | reconcile records "not done"; no blind non-idempotent retry | artifact | FAIL | pass |
| REC-DELAY | reconcile unknown/delayed, then late judgment | pending visible; later judgment advances; worker not re-run | result | FAIL | pass |
| REC-DONE | result durable, completion missing | lifecycle completed; dependents advance | result | FAIL | pass |
| REC-SIGNAL | SIGTERM drain vs SIGKILL | distinguish normal exit from abrupt | process | FAIL | pass |

## G. CHECKPOINT / C1EXT-03 (T2, T3)

| case | setup | expected | evidence | old | status |
| --- | --- | --- | --- | --- | --- |
| CKP-POS | checkpoint matches tail | real cache-state recovery; used_checkpoint=true | artifact | FAIL | pass |
| CKP-PREFIX | cache is valid prefix, then more events | prefix+tail == full replay (full snapshot) | artifact | FAIL | pass |
| CKP-FOREIGN | different manifest/campaign/tail/version | rebuild; not used | artifact | FAIL | pass |
| CKP-TAMPER | queue/ledger edited, payload digest recomputed | not truth; rebuild | artifact | FAIL | pass |
| CKP-BAD | missing/half/corrupt/ahead | fallback; budget/unknown unchanged | artifact | pass | pass |
| CKP-WRITEFAIL | cache write/rename/fsync failure | cache diagnostic; EventLog truth; no false cache success | artifact | FAIL | pass |
| CKP-HASH | digest recomputed | real SHA256 helper used, excludes self field | result | FAIL | pass |
| CKP-FULL | delete all derived cache/projection | full queue/defs/indexes/budget/control/pending equal | artifact | FAIL | pass |

## H. OWNERSHIP (existing + extended)

| case | setup | expected | evidence | status |
| --- | --- | --- | --- | --- |
| OWN-SAME-PID | two scheduler instances same PID default ownerId | not both writers | process | pass |
| OWN-REENTRANT | concurrent run() on one instance | single-flight or refuse | process | pass |
| OWN-RACE | 4 real processes at dead lock | exactly one winner | process | pass |

## I. E2E / product scenarios (T4, H1)

| case | scenario | expected | evidence |
| --- | --- | --- | --- |
| E2E-NORMAL | 2 static (B dep A) + 1 dynamic via submitted→admitted; B delayed then verified | real effects, full Outcome ownership, admission refs, budget, stop state | counter+event_chain |
| E2E-FAULT | real SIGKILL at intent/result/consumption/completion/checkpoint; restart reconciles |补 result/state, no blind rerun | process+artifact |
| E2E-CONTROL | durable pause/cancel then restart; prefix cache+tail == full replay; delete derived → same semantic digest | no revive; equivalence | process+artifact |

## J. Not proven

- External side-effect exactly-once (no Broker/executor).
- C2/C3/C4/C4a; real CTF/network/credentials.
- Distributed ownership.
- Real SHA256 values in this harness (stubbed — see WORK_PLAN §0.1).

## K. Mutation plan

| mutation | case | expected |
| --- | --- | --- |
| accept `status:success` without binding | OUT-FOREIGN/CRITERION | FAIL |
| ignore post-effect append failure | COMMIT-BUDGET/RESULT | FAIL |
| re-sort by episode sequence | ORDER-POS | FAIL |
| cancel not restored | CTRL-CANCEL | FAIL |
| inline admitted without submitted | DYN-NOSUB | FAIL |
| dispatch from initial ownedTasks only | DYN-POS | FAIL |
| borrow campaign remaining without reserve | BUD-ZERO | FAIL |
| scheduler ignores checkpoint tail | CKP-FOREIGN | FAIL |
