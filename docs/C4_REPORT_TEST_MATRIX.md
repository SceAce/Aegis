# C4 Report — Test Matrix

Status: frozen with `C4_REPORT_WORK_PLAN.md`. `required` = C4 gate;
`deferred` = recorded, not a C4 gate (ownership phase noted).

Scripts:

- `Pi_Agent_base/tests/aegis-c4-report-export.mjs` — product export from a real
  C3 fixture run over the real EventLog (required 1, 2, 4, 6, 7, 8).
- `Pi_Agent_base/tests/aegis-c4-report-rebuild.mjs` — deterministic rebuild after
  deleting derived artifacts (required 3).
- `Pi_Agent_base/tests/aegis-c4-report-privacy.mjs` — privacy, bounds and field
  whitelist (required 5).
- `Pi_Agent_base/tests/aegis-c4-report-validator.mjs` — structural validator
  negatives (required 7).

Run commands:

```bash
node Pi_Agent_base/tests/aegis-c4-report-export.mjs
node Pi_Agent_base/tests/aegis-c4-report-rebuild.mjs
node Pi_Agent_base/tests/aegis-c4-report-privacy.mjs
node Pi_Agent_base/tests/aegis-c4-report-validator.mjs
```

## required

| case_id | requirement | level | input_origin | action | expected | assertion_evidence | script |
|---|---|---|---|---|---|---|---|
| C4-1 | normal product export | product | trusted Manifest + committed events | run the C3 fixture, export the four artifacts via the CLI | Task/Stage/Outcome traceable with evidence refs/digests; JSON and Markdown agree on task/stage/counts; CLI documented | four files exist, digests, cross-check JSON vs MD | aegis-c4-report-export.mjs |
| C4-2a | unknown/delayed not success | product | committed_event | a task left unknown by a delayed Oracle | report task status `unknown`, not success; visible | report.tasks status | aegis-c4-report-export.mjs |
| C4-2b | cancel/rejected not success | product | committed_event | a cancelled campaign / a rejected action | report shows cancelled control + rejected action, never success | report.tasks/control/faults | aegis-c4-report-export.mjs |
| C4-2c | integrity failure visible | product | committed_event | corrupt the event chain | export reports integrity failure / inconclusive; never guessed success | integrity.event_chain_ok=false + validator | aegis-c4-report-export.mjs |
| C4-3 | rebuild determinism | product | trusted Manifest + committed events | export, delete derived artifacts (checkpoint/summary/report/bundle), re-export | identical semantic/report/bundle digests; generated_at/paths excluded | digest equality across rebuild | aegis-c4-report-rebuild.mjs |
| C4-4 | digest coverage | unit | trusted_host | mutate a semantic field, then mutate only the report_digest | report_digest changes with semantics; bundle_digest changes with report_digest | digest inequality/equality | aegis-c4-report-export.mjs |
| C4-5a | secret redaction | unit | synthetic_fixture | seed credentials/flag/Bearer/private key/raw tool text | public artifacts contain no real secret value | pattern scan + whitelist keys | aegis-c4-report-privacy.mjs |
| C4-5b | bounds/pagination | unit | synthetic_fixture | exceed entry/byte limits | explicit truncation/index, required auth+result kept, no silent loss | limits/truncation fields | aegis-c4-report-privacy.mjs |
| C4-6 | real deduplicated counts | product | committed_event | replay the same command id; compare to ledger | counts match deduplicated committed events; not Host counters; session ≠ episode | counts vs recomputed set + projection budget | aegis-c4-report-export.mjs |
| C4-7a | read-only source | product | trusted Manifest + committed events | hash the source before/after export | byte-identical source; no Worker/Broker/network call | source digests pre/post + call spy | aegis-c4-report-export.mjs |
| C4-7b | validator + prompt | unit | trusted_host | feed a foreign/contradictory bundle to the validator; check the prompt | validator rejects missing ref/digest and report_digest mismatch; prompt requires the four verdicts | validator reasons + prompt text | aegis-c4-report-validator.mjs |
| C4-8 | regression + static | integration | — | C0/C1/C3 report-related suites + Biome + tsc | unchanged pass; tsc 65 baseline reported honestly (0 in C4 files) | exit codes | (report) |

## required regression

| case_id | script | expectation |
|---|---|---|
| C4-REG-1 | aegis-campaign-contracts-c0.mjs, aegis-campaign-fixture-c0.mjs | unchanged pass (report C0 contract) |
| C4-REG-2 | aegis-campaign-c1-integration-scheduler.mjs, aegis-campaign-c1-event-projection.mjs | unchanged pass |
| C4-REG-3 | aegis-c3-host-fixture.mjs, aegis-c3-durability-recovery.mjs | unchanged pass |
| C4-REG-4 | Biome on C4 files | exit 0 |
| C4-REG-5 | tsc -p tsconfig.aegis-campaign.json | 65 legacy diagnostics, 0 in C4 files, reported honestly |

## deferred (NOT a C4 gate)

| case_id | item | ownership phase | reason |
|---|---|---|---|
| C4-D1 | C4a WebUI / Pi view | C4a | later phase |
| C4-D2 | F16 checkpoint cache incrementality | F16 | performance; deferred |
| C4-D3 | legacy 65 tsc import diagnostics | lib changes | recorded baseline |
| C4-D4 | statistical/causal claims | — | never made |
| C4-D5 | real model/network/target | later | requires authorization |
