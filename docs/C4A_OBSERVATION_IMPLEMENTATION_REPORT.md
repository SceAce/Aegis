# C4a Observation — Implementation Report

Current status: **accepted_with_recorded_limits after this session's authorized C4a review/fixes**. See `C4A_EXTERNAL_REVIEW.md` for eight additional red/green cases, same-source/integrity/bounds corrections and limitations. Historical DS delivery follows; the current review also implemented fixes and does not fabricate a separate independent team.
Phase: C4a (localhost read-only observation surface + Pi view commands). Scope
frozen in `C4A_OBSERVATION_TASK.md` / `C4A_OBSERVATION_DS_PROMPT.md`, plan/matrix
in `C4A_OBSERVATION_WORK_PLAN.md` / `C4A_OBSERVATION_TEST_MATRIX.md`.
C1–C4 are not reopened; F16 and the legacy type baseline stay deferred. No UI
remote sharing, no C5, no real model/network/target.

Branch: `feat/c4a-observation` (created from `feat/c4-report` @ `4f3dda4`).

## 0. Baseline and Git note

- Start: branch `feat/c4-report`, worktree clean, last commit `4f3dda4`.
- Commits on `feat/c4a-observation`:
  - `e1fd300` feat: localhost read-only Campaign observation surface and Pi view commands (C4a)
  - `66b6eb6` test: C4a required HTTP/XSS/command/SDK suites
  - (this commit) docs: C4a implementation report
- Earlier DS note attributed printed hash output to masking. The current review
  does not establish that cause; real equality/change checks remain valid, but
  unavailable output is recorded without treating an environment inference as fact.

## 1. Delivered entry

| file | role |
| --- | --- |
| `memory/campaign/observation-view.mjs` | `buildObservationView`, `summarizeObservationView`, `escapeHtml`, `escapeForScriptJson`, `renderObservationHtml`, `OBSERVATION_LIMITS` |
| `memory/campaign/observation-server.mjs` | `createObservationServer` (loopback, read-only HTTP) |
| `memory/campaign/observation-command.mjs` | `runObservationCommand`, `observationConfigFromEnv` |
| `extensions/aegis-observer.ts` | `/aegis tasks | dashboard | url` subcommands |

Reused unchanged: C4 `buildReportInputs`/`generateCampaignArtifacts` and
`redactSecrets`, plus the C1 projection they wrap. The page, JSON API and Pi
command all derive from ONE `buildObservationView`, so they cannot diverge.

### Start / stop

```bash
# Programmatic (used by tests and a future C5 entry):
#   const srv = createObservationServer({ manifestPath, eventsPath, port: 0 });
#   await srv.listen();   // srv.url -> http://127.0.0.1:<port>/
#   await srv.close();    // idempotent, releases the port
# Pi view command (launcher sets AEGIS_CAMPAIGN_MANIFEST / AEGIS_EVENT_LOG):
#   /aegis tasks      -> bounded summary + board URL
#   /aegis dashboard  -> same view
#   /aegis url        -> the observation URL / configuration
```

Read-only routes: `GET /`, `/healthz`, `/api/view`, `/api/tasks`, `/api/queue`,
`/api/actions`, `/api/outcomes`, `/api/faults`. Any non-GET/HEAD method → `405`.

## 2. Required results (actual commands, exit codes)

| case | command | exit | evidence |
| --- | --- | --- | --- |
| C4A-1/2/3/4a/6a/6b/7 | `node Pi_Agent_base/tests/aegis-c4a-observation-http.mjs` | 0 | 10 tests / 10 pass |
| C4A-4b/4c/5a | `node Pi_Agent_base/tests/aegis-c4a-observation-xss.mjs` | 0 | 4 tests / 4 pass |
| C4A-8 (non-SDK) | `node Pi_Agent_base/tests/aegis-c4a-observation-command.mjs` | 0 | 4 tests / 4 pass |
| C4A-8 (SDK) | `node --import .../source-resolver.ts Pi_Agent_base/tests/aegis-c4a-observation-sdk-command.mjs` | 0 | all checks passed |

Logs under ignored `/tmp/c4a-*.log` during this run.

### Regression (C4A-REG)

| suite | exit |
| --- | --- |
| aegis-c4-report-export.mjs | 0 |
| aegis-c4-report-privacy.mjs | 0 |
| aegis-c4-report-validator.mjs | 0 |
| aegis-c4-external-boundaries.mjs | 0 |
| aegis-c3-host-fixture.mjs | 0 |
| aegis-c3-workspace-adapter.mjs | 0 |
| aegis-c3-external-boundaries.mjs | 0 |
| aegis-observer-outcome-command.mjs (resolver) | 0 |
| aegis-observer-verify-first-pi.mjs (resolver) | 0 |

Static:
- Biome on all C4a files + the Observer extension: **exit 0**.
- `tsc -p tsconfig.aegis-campaign.json`: **exit 1, 65 errors, 0 in C4a files** —
  identical to the C4 baseline. Reported as-is.

## 3. What the cases prove

- **Real product entry**: a loopback server serves the real queue/action/result
  from a real C3 fixture run (not a render helper).
- **Same source**: the HTTP view equals the C4 report derivation; a newly
  committed event (via the real EventLog writer) is reflected on refresh.
- **unknown/control/dynamic**: a delayed Oracle leaves a task `unknown` (never
  success); a durable cancel shows `control.state=cancelled`; submitted/blocked
  proposals and fault reasons are visible.
- **No write route**: POST/PUT/DELETE/PATCH on every route → `405` with a
  read-only reason, and the source is byte-identical afterwards.
- **No arbitrary read / privacy / XSS**: query/path traversal is ignored/404;
  real secret samples never appear in HTML/JSON; `<script>`/attribute samples are
  escaped in every rendered field.
- **Bounds**: an oversized task list returns a bounded page with `truncated:true`
  and the full `total`.
- **Integrity failure**: a corrupt chain yields `integrity_failure`/`stale`;
  `healthz` is not `ok`; no completed work is claimed.
- **Lifecycle**: loopback bind, idempotent double-close, port released and
  rebindable; a server pointed at a missing source stays up and serves an
  `unavailable` view (a UI failure never blocks the Host).
- **Pi command**: `/aegis tasks` and `/aegis url` through the REAL Pi SDK + faux
  Observer extension read the same view and print a readable summary/URL.

## 4. Read-only / non-bypass guarantees

- There is NO HTTP write route; pause/cancel remain on the typed Host/Audit path
  and cannot be reached through the UI.
- The server serves only the whitelisted view; a query/path parameter never
  selects a file. Only the explicitly configured manifest/events/artifacts paths
  are read.
- The view reuses `redactSecrets` and a field whitelist; no raw stdout/stderr/tool
  transcript, credentials, flags, Bearer tokens or private keys are exposed.
- The Pi view command reads paths from the launcher environment only, never from
  model text.

## 5. Honest limitations

- Loopback is NOT a security boundary against a local hostile process; this is a
  local single-user observation surface, not a remote admin plane.
- The view is rebuilt from the committed stream on each request (bounded).
  Invalid/half-written sources now return explicit unavailable/integrity failure
  without live successful rows; no last-good cache is served. F16 remains deferred.
- No browser automation, styling polish or remote sharing (out of scope).
- Printed digest text is masked by the sandbox; digest VALUES are real and the
  tests compare them in-process.

## 6. Deferred (not a C4a gate)

| item | owner | note |
| --- | --- | --- |
| C5 single entry / capability experiments | C5 | later phase |
| F16 checkpoint cache incrementality | F16 | performance; deferred |
| legacy 65 tsc import diagnostics | when those libs change | recorded baseline |
| remote sharing / multi-user / CDN | later | not requested |
| full browser automation / styling | later | not a gate |

## 7. External review request (C4a only)

Review ONLY the read-only observation surface, its same-source guarantee, the
no-write/no-arbitrary-read/no-XSS boundary, bounds/integrity and the Pi command
wiring within the frozen scope above. Do not reopen C1–C4, and do not extend into
C5 or real-target experiments. C4a status:
**internally_verified / awaiting_external_review**.
