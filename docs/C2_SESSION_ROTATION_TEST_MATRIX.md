# C2 Session Rotation — Test Matrix

Status: frozen with `C2_SESSION_ROTATION_WORK_PLAN.md`. `required` = C2 gate;
`deferred` = recorded, not a C2 gate (ownership phase noted).

Test file: `Pi_Agent_base/tests/aegis-c2-session-rotation.mjs` (real SDK + faux
provider through the Host/scheduler product entry). Run command:

```bash
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/aegis-c2-session-rotation.mjs
```

Focused regression reused: `aegis-observer-runtime-handoff.mjs` (real SDK Host
helper), plus offline campaign scheduler/event-log suites.

## required

| case_id | requirement_id | level | input_origin | action | expected | assertion_evidence | script |
|---|---|---|---|---|---|---|---|
| C2-N1 | normal real rotation | product | trusted_host + faux | Host/scheduler decides rotate at settle; `newSession` runs | new `AgentSession` object, new session file/id, new extension instance bound; `handoff.completed` exactly once | object identity, `sessionFile`/`sessionId`, provider request boundary, committed event count | aegis-c2-session-rotation.mjs |
| C2-N2 | continuity: episode | product | committed_event | rotate once | `episode_id` unchanged; ONE episode; both sessions linked; no new independent evidence group | `projectState().episodes` keys + `sessions[]` | aegis-c2-session-rotation.mjs |
| C2-N3 | continuity: budget | unit+product | trusted_host | rotate with a budget ledger | consumed accumulators unchanged; remaining never increases; session generation increments by exactly 1; no reset | returned `budget_before/after` + committed ledger | aegis-c2-session-rotation.mjs |
| C2-N4 | continuity: facts/unknown/pending-recovery | product | committed_event | leave a Fact breadcrumb + an unknown + a pending-recovery note, then rotate | new session RAM carries goal + fact breadcrumb + unknown + pending recovery; transcript NOT copied | continuation request text + new session messages | aegis-c2-session-rotation.mjs |
| C2-S1 | safety: in-flight side effect | unit | trusted_host | stage side effect still pending, attempt rotate | refused; runtime NOT replaced; no completion; no budget change | `canRotate().allowed===false`, runtime identity, event count | aegis-c2-session-rotation.mjs |
| C2-S2 | safety: unresolved side effect | unit | committed_event | unknown/unresolved action, attempt rotate | refused with reason naming the action; no replacement | verdict reason + runtime identity | aegis-c2-session-rotation.mjs |
| C2-S3 | budget refusal | unit | trusted_host | remaining < one session quota | refused; no `newSession`; no completion | `canRotate()` reason, provider request count unchanged | aegis-c2-session-rotation.mjs |
| C2-S4 | allowed boundary positive | unit | trusted_host | settled, no in-flight, budget ok | allowed | `canRotate().allowed===true` | aegis-c2-session-rotation.mjs |
| C2-F1 | cancel | product | trusted_host | `session_before_switch` cancels | `applied:false, cancelled:true`; staged retained; no completion; runtime unchanged | returned flag, staged file exists, event count, runtime identity | aegis-c2-session-rotation.mjs |
| C2-F2 | creation failure | unit | trusted_host | runtime `newSession` throws | `applied:false, reason`; staged retained; no completion; no budget change | returned reason, event count | aegis-c2-session-rotation.mjs |
| C2-I1 | idempotent replay | product | committed_event | replay same `request_id` after a successful rotation | `applied:true, reused:true`; runtime NOT replaced again; completion still exactly 1; budget charged once | runtime identity across calls, completion count | aegis-c2-session-rotation.mjs |
| C2-I2 | interrupted recovery | product | committed_event | staged handoff, no completion (process gap); `recoverInterrupted()` | one re-apply through the same path; exactly one completion; no unconfirmed Task side effect re-run | completion count, action count for a side-effecting tool | aegis-c2-session-rotation.mjs |
| C2-P1 | product entry proof | product | trusted_host | drive the scheduler/Host supervisor, not the factory helper | observed via object/context/provider closure, not ID or returned text alone | captured provider messages + runtime object identity | aegis-c2-session-rotation.mjs |

## required regression

| case_id | requirement_id | level | script | expectation |
|---|---|---|---|---|
| C2-R1 | C1 real Host helper regression | product | aegis-observer-runtime-handoff.mjs | still 12/12-equivalent assertions pass |
| C2-R2 | campaign handoff events accepted | integration | aegis-campaign-c1-event-projection.mjs | handoff.requested/completed remain accepted no-op projection events |
| C2-R3 | scheduler/eventlog unaffected | integration | aegis-campaign-c1-integration-scheduler.mjs, aegis-campaign-c1-eventlog-durability.mjs | unchanged pass |
| C2-R4 | Biome on modified paths | static | biome check | exit 0 |
| C2-R5 | tsc campaign config | static | tsc -p tsconfig.aegis-campaign.json | reported honestly; pre-existing import diagnostics unchanged (not a C2 regression) |

## deferred (NOT a C2 gate)

| case_id | item | ownership phase | reason |
|---|---|---|---|
| C2-D1 | F16 checkpoint cache incrementality / prefix read counts | F16 | performance; full EventLog replay correctness preserved |
| C2-D2 | Browser/Oracle adapters, WebUI rotation display | C3/C4 | later-phase adapters/UI |
| C2-D3 | Multi-session parallel Task rotation | later | Campaign v1 is single active Task/Episode (U7) |
