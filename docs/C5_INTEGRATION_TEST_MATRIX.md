# C5 Integration — Test Matrix

Status: C5 accepted_with_recorded_limits after bounded review and repairs; see
`C5_EXTERNAL_REVIEW.md`. The original matrix is preserved below with the review
addendum. `required` = C5 gate; `deferred` = recorded, not a C5 gate.

Scripts:

- `Pi_Agent_base/tests/aegis-c5-integration.mjs` — unified entry product scenarios
  over a real config + real EventLog + real local effects (normal+dynamic,
  delayed, pause/resume/cancel, restart recovery, auth/audit).
- `Pi_Agent_base/tests/aegis-c5-session-sdk.mjs` — real Pi SDK + faux rotation
  through the unified entry (Session/Episode/budget continuity).
- `Pi_Agent_base/tests/aegis-c5-export-observation.mjs` — export + observation
  same-source, read-only, UI-failure independence.
- `Pi_Agent_base/tests/aegis-c5-runbook.mjs` — the documented commands run and
  reproduce from a clean temp dir.

Run commands:

```bash
node Pi_Agent_base/tests/aegis-c5-integration.mjs
node Pi_Agent_base/tests/aegis-c5-export-observation.mjs
node Pi_Agent_base/tests/aegis-c5-runbook.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/aegis-c5-session-sdk.mjs
```

## required

| case_id | requirement | scenario | expected | assertion_evidence | script |
|---|---|---|---|---|---|
| C5-N1 | normal+dynamic | run the entry: two static tasks + one bounded dynamic task | real Broker effects, bound Oracle Outcomes, dependency released, report task states success | effect files + committed events + export tasks | aegis-c5-integration.mjs |
| C5-S1 | SDK rotation | real SDK/faux: the Host rotates once at a settle boundary | genuinely new AgentSession, same Episode/Task/authorization, one ledger charge, rotated Session loads the gate | object identity + committed ledger + gate | aegis-c5-session-sdk.mjs |
| C5-D1 | delayed/unknown | a task's Oracle returns delayed/unknown first | dependents not released early; a late judgment advances without a worker re-effect; report/UI agree | judge count + state + report | aegis-c5-integration.mjs |
| C5-C1 | pause/resume/cancel | pause then run; resume then run; cancel then restart | no new dispatch while paused/cancelled; durable control; restart does not revive a paused/cancelled campaign | control events + task states | aegis-c5-integration.mjs |
| C5-R1 | crash/restart | real child SIGKILL after the durable intent+effect; restart via the entry | no blind re-effect, bound to the task, unknown preserved until reconciled | child barrier + effect count | aegis-c5-integration.mjs |
| C5-A1 | auth/audit | direct tool / unregistered action / digest change / intent-append failure | refused with reason; no effect; a before-intent failure prevents the effect | rejection reasons + effect absence | aegis-c5-integration.mjs |
| C5-E1 | export/observation | run with `--export --observe` | artifacts same-source and read-only; no secret leak; UI close/failure not an execution dependency | artifact digests + server lifecycle + source digests | aegis-c5-export-observation.mjs |
| C5-O1 | operational reproduction | follow the runbook from a clean temp dir | the documented commands run with the documented exit codes; rerun reproduces | CLI exit codes + summary | aegis-c5-runbook.mjs |

## required regression

| case_id | script | expectation |
|---|---|---|
| C5-REG-1 | aegis-c3-host-fixture.mjs, aegis-c3-durability-recovery.mjs, aegis-c3-external-boundaries.mjs | unchanged pass |
| C5-REG-2 | aegis-c4-report-export.mjs, aegis-c4-external-boundaries.mjs | unchanged pass |
| C5-REG-3 | aegis-c4a-observation-http.mjs, aegis-c4a-external-boundaries.mjs | unchanged pass |
| C5-REG-4 | aegis-c2-budget-sdk.mjs, aegis-c2-supervisor-boundaries.mjs (resolver) | unchanged pass |
| C5-REG-5 | Biome on C5 files | exit 0 |
| C5-REG-6 | tsc -p tsconfig.aegis-campaign.json | exit 1, 74 legacy diagnostics, 0 in C5 files, reported honestly |

## deferred (NOT a C5 gate)

| case_id | item | ownership phase | reason |
|---|---|---|---|
| C5-D2 | F16 checkpoint cache incrementality | F16 | performance; deferred |
| C5-D3 | legacy 74 tsc import diagnostics | lib changes | recorded baseline |
| C5-D4 | container / remote platform / multi-worker | later | not requested |
| C5-D5 | UI styling / remote sharing | later | not a gate |
| C5-D6 | real model / network / target capability experiment | user-started later | requires explicit authorization |
| C5-D7 | automatic SDK creation / actual Task binding / policy / persistent observation | SDK launcher | caller runtime/beforeRun and per-call server are current limits |

## Review addendum: required repairs

All rows are product/integration checks using trusted config + real local EventLog;
SDK rows use real SDK/faux. Final results in ignored
`Pi_Agent_base/runtime/dev/c5-external/resume-results.json` (argv/exit/log).

| case | requirement / input -> expected | script / evidence | result |
| --- | --- | --- | --- |
| CONTROL | ordinary configured run -> both tasks completed | external-boundaries; task states | pass, exit 0 |
| C5-X1 | fresh export/observe -> no action.requested, export fails without source | external-boundaries; committed events | 2 cases pass |
| C5-X2 | occupied loopback port -> Host still completes; preparation throw -> registry released, next run succeeds | external-boundaries; actual listener/state/registry | 2 cases pass |
| C5-X3 | malformed/unknown nested config -> rejection; default Session budget bounded, explicit widening refused | external-boundaries; load result/limit | 2 cases pass |
| C5-X4 | corrupt completed stream -> non-ok status without completed | external-boundaries; source tamper/state | pass |
| C5-X5 | old Episode rotation exhausts Campaign limit -> new runtime not created | external-boundaries; actual committed rotation/runtime call count | pass |
| C5-X6 | missing CLI values/invalid port -> bad args; port 0 legal | external-boundaries; parsed arguments | pass |
| C5-S1-chain | SDK rotation + Host actions, then standalone SDK activity -> both complete chains verify | session-sdk; verifyChain/event bytes | 2 added check blocks pass |

External-boundaries command: `node --test Pi_Agent_base/tests/aegis-c5-external-boundaries.mjs`,
10/10 Node tests. Session SDK command above now has 14 custom check blocks, exit 0.
Old code red: original boundary group 1 pass/6 fail; isolated old SDK 2 chain failures;
resume-config-red failed observation.host numeric acceptance before its final fix.
SDK current test still uses caller runtime/trusted beforeRun and an explicitly staged Pi Episode;
actual automatic scheduler Task binding is SDK launcher scope, not proven by the test's name.
