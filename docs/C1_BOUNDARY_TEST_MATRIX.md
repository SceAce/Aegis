# Aegis C1 External Boundary (F10–F13) — Test Matrix

Primary red/green suite: `EXT` =
`node --test Pi_Agent_base/tests/aegis-campaign-c1-external-boundaries.mjs`
(21 cases; external/committed, assertions preserved).

Logs: `Pi_Agent_base/runtime/dev/c1boundary/`.

Legend: `red` = fails on the pre-fix code (committed baseline `369e1f4`);
`green` = passes after the fix. `evidence` ∈ result | artifact | counter |
process | event_chain | ledger.

## F10 — trusted current scope

| case | entry | expected | evidence | red | seed |
| --- | --- | --- | --- | --- | --- |
| F10-A | `resolveTaskOutcome` (task `scope:null`, outcome scope `env:prod`, `scope:null`) | `ok:false` | result | FAIL | EXT |
| F10-B | projection (task scope null, both outcomes scope null) | not `completed` | result | FAIL | EXT |

## F11 — complete Stage binding (both gates)

| case | entry | expected | evidence | red | seed |
| --- | --- | --- | --- | --- | --- |
| F11-FOREIGN-SCOPE ×2 | projection normal + reconcile | not `completed` | result | FAIL | EXT |
| F11-MISSING-SCOPE ×2 | projection normal + reconcile | not `completed` | result | FAIL | EXT |
| F11-MISSING-EPISODE ×2 | projection normal + reconcile | not `completed` | result | FAIL | EXT |
| F11-EMPTY-EVIDENCE ×2 | projection normal + reconcile | not `completed` | result | FAIL | EXT |
| F11-NON-INDEPENDENT ×2 | projection normal + reconcile | not `completed` | result | FAIL | EXT |
| F11-PRODUCT-MATCH | real EventLog + scheduler reconcile, matching scope | `completed` | event_chain | pass (control) | EXT |
| F11-PRODUCT-FOREIGN | real EventLog + scheduler reconcile, foreign stage scope | not `completed`; worker 0 reruns | process/result | FAIL | EXT |

## F12 — recovery and idempotency

| case | entry | expected | evidence | red | seed |
| --- | --- | --- | --- | --- | --- |
| F12-EPISODE | cache+tail hydration | `episode_id` preserved | result | FAIL | EXT |
| F12-FOREIGN-EPISODE | cache+tail vs full replay | both reject the foreign-episode task Outcome | result | FAIL | EXT |
| F12-OUTCOME-DEDUP | cache+tail vs full replay | `stage_outcomes.length === 1` | counter | FAIL | EXT |
| F12-COMMAND-DEDUP | cache+tail vs full replay | `consumed.model_requests === 1` | ledger | FAIL | EXT |

## F13 — complete persisted projection and real wiring

| case | entry | expected | evidence | red | seed |
| --- | --- | --- | --- | --- | --- |
| F13-EPISODE-WRITER | real `persistCheckpoint` (injected writer) | `queue[0].episode_id` present | artifact | FAIL | EXT |
| F13-DIGEST | real writer, same ids, changed stage `observed` | `stage_outcomes` differ AND `projection_digest` differs | artifact | FAIL | EXT |

## Existing regression (green target)

C0: closure-c0, contracts-c0, fixture-c0. C1: c1-event-projection,
c1-scheduler, c1-ownership, c1-recovery, c1-closure, c1-eventlog-durability,
c1-integration-contracts, c1-integration-scheduler, c1-integration-recovery,
c1-integration-e2e, c1-final-audit, c1-final-audit2. Plus the adversarial
supplement `aegis-campaign-c1-final-audit3-adversarial.mjs`.

## Additional product-path evidence (B-E2E)

| case | entry | expected |
| --- | --- | --- |
| E2E-BOUNDARY | real child process: intent → effect → SIGKILL → restart | effect at most once; unknown preserved; recovered state drives behaviour |
| E2E-REBUILD | delete the checkpoint; rebuild from Manifest + committed EventLog | identical semantic state |
| E2E-PREFIX-TAIL | prefix checkpoint + changing tail | the tail state is actually used; final snapshot == full replay |

## Mutation plan (isolated copies)

| mutation | case | expected |
| --- | --- | --- |
| `null` scope skips validation | F10-A | FAIL |
| stage scope + evidence gate removed | F11-FOREIGN/MISSING/EMPTY | FAIL |
| restore drops `episode_id` | F12-EPISODE | FAIL |
| restore resets dedup sets | F12-OUTCOME/COMMAND-DEDUP | FAIL |
| state digest keeps only ids | F13-DIGEST | FAIL |

## Not proven

External side-effect exactly-once; C2/C3/C4a; real CTF/network/credentials;
distributed ownership; real SHA256 values (stubbed).
