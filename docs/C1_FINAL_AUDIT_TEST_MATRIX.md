# Aegis C1 Final Audit Fix (F7–F9) — Test Matrix

Status: all cases `pass` after the fixes unless marked. `old` = expected failure
on pre-fix code (probed, `C1_FINAL_AUDIT_WORK_PLAN.md §0.1`).

Primary script: `T6` = `tests/aegis-campaign-c1-final-audit2.mjs` (new).
Product harness: `H2` = `tests/helpers/campaign-final2-child.mjs` (new).
Existing: the 14 campaign suites.

## F7 — reconciliation reuses the Stage gate (T6)

| case | setup | expected | evidence | old | status |
| --- | --- | --- | --- | --- | --- |
| F7-NO-STAGE | dormant `running`; task-Oracle success; reconcile resolved; NO stage evidence | not completed; stays `waiting_oracle`/`unknown` | result | FAIL | pass |
| F7-MISSING-CRIT | stage Outcome present but one required criterion missing | not completed | result | FAIL | pass |
| F7-FOREIGN-STAGE | stage Outcome bound to a foreign task/episode | not completed | result | FAIL | pass |
| F7-SUPERSEDED | stage success superseded by a legal unknown | not completed | result | FAIL | pass |
| F7-FULL | full stage evidence + task-Oracle success | completed; worker 0; outcome_id matches; dependent ready | result+counter | pass | pass |
| F7-WORKER | recovery run | no new `campaign.task.started` for the reconciled task | event_chain | FAIL | pass |

## F8 — complete Stage Outcome projection (T6, H2)

| case | setup | expected | evidence | old | status |
| --- | --- | --- | --- | --- | --- |
| F8-STATUS | same stage `outcome_id`, changed `status` | snapshot/digest differs | result | FAIL | pass |
| F8-CRITERION | same id, changed criterion/expected | snapshot/digest differs | result | FAIL | pass |
| F8-EVIDENCE | same id, changed evidence_refs/digest | snapshot/digest differs | result | FAIL | pass |
| F8-SCOPE | same id, changed scope | snapshot/digest differs | result | FAIL | pass |
| F8-SUPERSEDE | same id, `supersedes`/effective state changes | snapshot/digest differs | result | FAIL | pass |
| F8-PREFIX-FULL | prefix+tail reduce | deep-equal to full replay across the complete stage projection | result | FAIL | pass |
| F8-REBUILD | delete the checkpoint; rebuild from the EventLog | same complete projection | result | FAIL | pass |
| F8-OUTCOME-INDEX | stage Outcomes present | `projection.outcomes` carries the full stage Outcome | result | FAIL | pass |

## F9 — Task scope into the resolver (T6)

| case | setup | expected | evidence | old | status |
| --- | --- | --- | --- | --- | --- |
| F9-MATCH | Outcome scope == task definition scope | accepted | result | pass | pass |
| F9-FOREIGN | Outcome scope != task definition scope | rejected | result | FAIL | pass |
| F9-MISSING | Outcome has no scope but task declares one | fail-closed (not success) | result | FAIL | pass |
| F9-KEYORDER | equal scope, different object key order | accepted (canonical) | result | FAIL | pass |
| F9-DYNAMIC-RESTART | dynamic task scope from the committed definition after restart | still validated | result | FAIL | pass |

## H. Product scenario (H2, T6)

| case | scenario | expected |
| --- | --- | --- |
| E2E-F7F9 | Scheduler + real EventLog + dynamic task + reconciliation + full stage evidence + task scope | F7–F9 hold end-to-end |

## I. Not proven

- External side-effect exactly-once (no Broker/executor).
- C2/C3/C4/C4a; real CTF/network/credentials; distributed ownership.
- Real SHA256 values in this harness (stubbed).

## J. Mutation plan

| mutation | case | expected |
| --- | --- | --- |
| reconciliation skips the stage gate | F7-NO-STAGE | FAIL |
| snapshot keeps only stage_outcome_ids | F8-STATUS | FAIL |
| resolver uses `manifest.scope` instead of the task scope | F9-FOREIGN | FAIL |
