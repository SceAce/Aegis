# C4a Observation — Test Matrix

Status: frozen with `C4A_OBSERVATION_WORK_PLAN.md`. `required` = C4a gate;
`deferred` = recorded, not a C4a gate.

Scripts:

- `Pi_Agent_base/tests/aegis-c4a-observation-http.mjs` — real loopback HTTP server
  over a real C3 fixture (required: product entry, same-source, unknown/control/
  dynamic, authorization/privacy, bounds/integrity, lifecycle).
- `Pi_Agent_base/tests/aegis-c4a-observation-xss.mjs` — HTML/JS escaping and
  arbitrary-read refusal (required: escaping).
- `Pi_Agent_base/tests/aegis-c4a-observation-command.mjs` — Pi view command reads
  the same view and prints summary/URL (required: Pi commands).

Run commands:

```bash
node Pi_Agent_base/tests/aegis-c4a-observation-http.mjs
node Pi_Agent_base/tests/aegis-c4a-observation-xss.mjs
node Pi_Agent_base/tests/aegis-c4a-observation-command.mjs
# Pi command wiring through the real SDK + faux (source resolver):
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/aegis-c4a-observation-sdk-command.mjs
```

## required

| case_id | requirement | level | input_origin | action | expected | assertion_evidence | script |
|---|---|---|---|---|---|---|---|
| C4A-1 | real product entry | product | trusted Manifest + committed events | start the HTTP server over a C3 fixture run | page + JSON API return the queue/action/result; not a render helper only | real `fetch` status + body | aegis-c4a-observation-http.mjs |
| C4A-2 | same source | product | committed_event | compare page/API/Pi view to the C4 report derivation | identical statuses/counts; a new committed event is reflected on refresh | view vs generateCampaignArtifacts | aegis-c4a-observation-http.mjs |
| C4A-3a | unknown/delayed visible | product | committed_event | delayed Oracle leaves a task unknown | view shows `unknown` and the lifecycle/stop reason; never success | view.tasks/task_lifecycle | aegis-c4a-observation-http.mjs |
| C4A-3b | control/cancel visible | product | committed_event | durable cancel | view.control.state=`cancelled` | view.control | aegis-c4a-observation-http.mjs |
| C4A-3c | dynamic proposals + fault reasons visible | product | committed_event | blocked/rejected proposal + a fault | proposals and faults appear with reasons | view.proposals/view.faults | aegis-c4a-observation-http.mjs |
| C4A-4a | no write route | product | — | POST/PUT/DELETE to every route | 405, no state change, source bytes unchanged | status + source digest pre/post | aegis-c4a-observation-http.mjs |
| C4A-4b | no arbitrary file read | unit | model_proposal | query/path traversal attempts | ignored/404; only configured paths read | response + no leak | aegis-c4a-observation-xss.mjs |
| C4A-4c | privacy | unit | synthetic_fixture | secret samples in inputs | no secret in HTML/JSON | pattern scan | aegis-c4a-observation-xss.mjs |
| C4A-5a | HTML/JS escaping | unit | model_proposal | `<script>`/attribute/quote samples | escaped in HTML and JSON script context; no execution | rendered text | aegis-c4a-observation-xss.mjs |
| C4A-6a | bounds/pagination | unit | synthetic_fixture | exceed list limits | `truncated:true` + full total; no silent drop | pagination fields | aegis-c4a-observation-http.mjs |
| C4A-6b | integrity failure | product | committed_event | corrupt event chain | view `integrity_failure`/`stale`, no completed work claimed | view.integrity | aegis-c4a-observation-http.mjs |
| C4A-7 | lifecycle/non-blocking | product | — | listen then close twice; run Host without UI | port released; double close safe; Host completes regardless | address/close + Host run | aegis-c4a-observation-http.mjs |
| C4A-8 | Pi command same source | product | trusted_host + real SDK | invoke the view subcommand via the real extension command | same view; readable text + URL; no TUI still prints | command output | aegis-c4a-observation-sdk-command.mjs |

## required regression

| case_id | script | expectation |
|---|---|---|
| C4A-REG-1 | aegis-c4-report-export.mjs, aegis-c4-report-privacy.mjs, aegis-c4-report-validator.mjs, aegis-c4-external-boundaries.mjs | unchanged pass |
| C4A-REG-2 | aegis-c3-host-fixture.mjs, aegis-c3-workspace-adapter.mjs | unchanged pass |
| C4A-REG-3 | Biome on C4a files | exit 0 |
| C4A-REG-4 | tsc -p tsconfig.aegis-campaign.json | 65 legacy diagnostics, 0 in C4a files, reported honestly |

## deferred (NOT a C4a gate)

| case_id | item | ownership phase | reason |
|---|---|---|---|
| C4A-D1 | C5 single entry / capability experiments | C5 | later phase |
| C4A-D2 | F16 checkpoint cache incrementality | F16 | performance; deferred |
| C4A-D3 | legacy 65 tsc import diagnostics | lib changes | recorded baseline |
| C4A-D4 | remote sharing / multi-user / CDN | later | not requested |
| C4A-D5 | full browser automation / styling | later | not a gate |
