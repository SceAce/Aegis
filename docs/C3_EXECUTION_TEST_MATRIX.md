# C3 Execution — Test Matrix

Status: frozen with `C3_EXECUTION_WORK_PLAN.md`. `required` = C3 gate;
`deferred` = recorded, not a C3 gate (ownership phase noted).

Scripts:

- `Pi_Agent_base/tests/aegis-c3-host-fixture.mjs` — offline product Host with the
  fixture adapter (real EventLog + real local files).
- `Pi_Agent_base/tests/aegis-c3-workspace-adapter.mjs` — supervised macOS
  workspace script adapter (real subprocess).
- `Pi_Agent_base/tests/aegis-c3-durability-recovery.mjs` — intent/effect
  durability + real child-process restart/reconcile.
- `Pi_Agent_base/tests/aegis-c3-session-entry.mjs` — real SDK + faux through the
  Host; C2 rotation + budget ownership.
- `Pi_Agent_base/tests/aegis-c3-campaign-mode-gate.mjs` — direct-tool bypass
  refusal.

Run commands:

```bash
node Pi_Agent_base/tests/aegis-c3-host-fixture.mjs
node Pi_Agent_base/tests/aegis-c3-workspace-adapter.mjs
node Pi_Agent_base/tests/aegis-c3-durability-recovery.mjs
node Pi_Agent_base/tests/aegis-c3-campaign-mode-gate.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/aegis-c3-session-entry.mjs
```

## required

| case_id | requirement | level | input_origin | action | expected | assertion_evidence | script |
|---|---|---|---|---|---|---|---|
| C3-POS | Manifest→Host→Broker→local effect→Oracle→Outcome, two static tasks | product | trusted_host | run Host over the fixture manifest | real file effects; both required stages per task verified; Task completed only when all stages success; dependency released | effect files + committed events + projection state | aegis-c3-host-fixture.mjs |
| C3-POS-2 | dependency release ordering | product | committed_event | task-B depends on task-A | B not dispatched before A completed | event order + projection | aegis-c3-host-fixture.mjs |
| C3-DYN | model/faux proposal → submitted/admitted dynamic task dispatched via the same Broker | product | model_proposal + trusted_host | submit+admit a bounded dynamic task, run | definition resolved from projection; budget/grant re-checked; actual brokered effect; no preset `ownedTasks` shortcut | admission events + brokered action events + effect file | aegis-c3-host-fixture.mjs |
| C3-DENY-1 | unregistered action_ref refused | product | model_proposal | worker requests an unknown action | rejected reason visible; zero adapter/file/subprocess effect; a legal positive still runs | rejection reason + effect counter unchanged | aegis-c3-host-fixture.mjs |
| C3-DENY-2 | foreign target / workspace escape refused | product | committed_event | script arg points outside `allowed_root` | refused at broker/script boundary; no effect | resource-binding rejection + no file | aegis-c3-workspace-adapter.mjs |
| C3-DENY-3 | digest/param change refused | product | trusted_host | mutate registered script body or pass an undeclared param | refused; requires new version+re-verification; no effect | digest-mismatch reason | aegis-c3-workspace-adapter.mjs |
| C3-DENY-4 | direct Pi tool bypass refused (Campaign mode) | product | model_proposal | invoke `bash`/`write` directly | gate denies; no effect outside Broker; gate absent outside Campaign mode | gate decision + file absence | aegis-c3-campaign-mode-gate.mjs |
| C3-DUR-1 | append/fsync failure before intent | recovery | trusted_host | inject intent append failure | adapter/worker NOT called; zero effect | effect counter 0 + no action.requested committed | aegis-c3-durability-recovery.mjs |
| C3-DUR-2 | append failure after effect | recovery | trusted_host | inject result-append failure after the effect | effect happened ≤1; run not ok; new effects stopped; task stays pending/unknown | effect count + projection state | aegis-c3-durability-recovery.mjs |
| C3-ORACLE-1 | transport success but target not satisfied | product | committed_event | script exits 0 but post-state wrong | Oracle returns failure/unknown; Task not completed | outcome status + projection | aegis-c3-workspace-adapter.mjs |
| C3-ORACLE-2 | foreign/missing evidence | product | committed_event | Oracle result references a foreign/missing artifact | rejected; no Task success | resolver rejection | aegis-c3-host-fixture.mjs |
| C3-ORACLE-3 | delayed result then legal late result | product | committed_event | first judge delayed/unknown, later success | dependency blocked while unknown; late judgment advances without re-running the worker | judge count + task state + no second dispatch | aegis-c3-host-fixture.mjs |
| C3-REC | intent then process restart, reconcile from real artifact | recovery | trusted_host + real subprocess | SIGKILL after durable intent+effect; restart | no blind re-effect (≤1); bound to current task; unknown preserved until reconciled | child-process barrier + effect count | aegis-c3-durability-recovery.mjs |
| C3-SESSION | real SDK/faux run with one safe rotation + budget ledger | product | trusted_host + faux | Host rotates at settle; cumulative ledger checked | real C2 entry called; new Session; same Episode/authorization; one charge only; exhausted ⇒ refused | runtime identity + committed ledger + handoff events | aegis-c3-session-entry.mjs |
| C3-PRODUCT | product entry proves the real path | product | trusted_host | drive `c3-entry.mjs`, not the factory helper | observed via effects/events/provider closure | CLI exit 0 + summary | aegis-c3-host-fixture.mjs |

## required regression

| case_id | requirement | level | script | expectation |
|---|---|---|---|---|
| C3-REG-1 | C1 scheduler/eventlog/projection/e2e | integration | aegis-campaign-c1-integration-scheduler.mjs, aegis-campaign-c1-eventlog-durability.mjs, aegis-campaign-c1-event-projection.mjs | unchanged pass |
| C3-REG-2 | existing Broker/Observer/script-registry | integration | aegis-observe-actions.mjs, aegis-observer-verify-first-pi.mjs, script/observe suites | unchanged pass |
| C3-REG-3 | C2 supervisor boundaries + SDK budget | integration | aegis-c2-supervisor-boundaries.mjs, aegis-c2-budget-sdk.mjs | unchanged pass |
| C3-REG-4 | Biome on modified paths | static | biome check | exit 0 |
| C3-REG-5 | tsc campaign config | static | tsc -p tsconfig.aegis-campaign.json | reported honestly; pre-existing import diagnostics unchanged |

## deferred (NOT a C3 gate)

| case_id | item | ownership phase | reason |
|---|---|---|---|
| C3-D1 | F16 checkpoint cache incrementality | F16 | performance; full replay correctness preserved |
| C3-D2 | C4 report / acceptance bundle | C4 | later phase |
| C3-D3 | C4a UI / view commands | C4a | later phase |
| C3-D4 | container/remote adapter | later | not registered |
| C3-D5 | multi-Worker / parallel Task | later | U7 single active |
| C3-D6 | real target/network/model | later | requires user authorization |
