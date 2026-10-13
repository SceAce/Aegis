# C4a Observation — Work Plan and Frozen Contract

Status: **frozen before implementation**. Scope follows `C4A_OBSERVATION_TASK.md`
and `C4A_OBSERVATION_DS_PROMPT.md`. This plan does not reopen C1–C4 and does not
implement C5 or any real model/network/target.

Branch: `feat/c4a-observation` (created from `feat/c4-report` @ `4f3dda4`).
Baseline: worktree clean.

## 1. Problem and deliverable

There is a deterministic C4 report/export but no live observation surface. C4a
delivers a **localhost, read-only** whiteboard + a small set of Pi view commands
that read the SAME committed projection as C4:

- control state, static/dynamic queue, proposals (submitted/admitted/blocked/
  rejected), tasks/stages/episodes/sessions, budget, actions, Oracle/Outcomes,
  unknown/faults/missing evidence, handoff/report references;
- a loopback HTTP server with a read-only JSON API and a static HTML page;
- Pi commands (`/aegis tasks`, `/aegis dashboard`) that print a summary + URL.

The UI is a read-only client. It owns no scheduling/authorization/truth, and a UI
failure never blocks Campaign execution.

## 2. Frozen interfaces (C4a-A)

### `Pi_Agent_base/memory/campaign/observation-view.mjs`

- `OBSERVATION_LIMITS` — bounded list/page sizes and byte caps.
- `buildObservationView({ manifest, events, artifacts, runtimeDigests, limits })`
  → a frozen, redacted, whitelisted JSON view (see §3). Reuses C4
  `buildReportInputs`/`generateCampaignArtifacts`, so the view is the same
  derivation as the report. Never mutates input. Returns:
  ```text
  { schema_version, generated_at, campaign_id,
    integrity: { event_chain_ok, event_count, last_committed_digest, stale },
    control, counts, budget, tasks[], stages[], outcomes[],
    proposals[], actions[], faults[], missing_evidence[], conflicts[],
    report_refs: { report_digest, bundle_digest }, limits, truncated }
  ```
- `summarizeObservationView(view)` → a short text summary (for Pi commands).
- `escapeHtml(text)` / `renderObservationHtml(view)` → safe HTML (text escaped).

### `Pi_Agent_base/memory/campaign/observation-server.mjs`

- `createObservationServer({ manifestPath, eventsPath, artifactsPath?, runtimePath?,
  host = "127.0.0.1", port = 0, limits })` → `{ url, port, close(), refresh(), view() }`.
- Read-only routes: `GET /` (HTML), `GET /api/view`, `GET /api/tasks`,
  `GET /api/queue`, `GET /api/actions`, `GET /api/outcomes`, `GET /api/faults`,
  `GET /healthz`. Any non-GET method → `405`. Unknown path → `404`. Query params
  may only page/limit; anything else is ignored, never a filesystem path.
- Loopback bind only; `close()` is idempotent and releases the port.

### `Pi_Agent_base/memory/campaign/observation-command.mjs`

- `runObservationCommand({ subcommand, manifestPath, eventsPath, port })` →
  `{ ok, text, url }` for `tasks`/`dashboard`/`url`, reading the same view.

### Observer wiring

`extensions/aegis-observer.ts` adds `tasks` and `dashboard` subcommands to the
existing `/aegis` command, reading `AEGIS_CAMPAIGN_MANIFEST` + `AEGIS_EVENT_LOG`
(launcher-provided, never model-provided). No write path is added.

## 3. Whitelist / bounds / digest

- The view exposes ONLY whitelisted structured fields; no raw stdout/stderr/tool
  transcript, no credentials/flags/Bearer/private keys (reuses `redactSecrets`).
- Every list is bounded; a truncated list carries `truncated: true` and the full
  count, never a silent drop.
- `report_refs` are DIGESTS only; the UI never claims a Task success from
  `summary.json`/checkpoint.
- A non-verifying chain sets `integrity.event_chain_ok=false` and the view is
  `unavailable`/`integrity_failure`; a partially written tail is not reported as
  completed (the last verifiable committed snapshot is kept and marked `stale`).

## 4. Frozen invariants

- **C4A-READONLY**: no HTTP write route; the source is opened read-only and the
  HTTP API cannot mutate it. pause/cancel stay on the typed Host/Audit path.
- **C4A-SAMESOURCE**: HTML page, JSON API and Pi command all derive from the same
  `buildObservationView` over the same committed events.
- **C4A-ESCAPE**: all dynamic text is HTML/JS-escaped; a model string cannot
  become a script.
- **C4A-NO-ARBITRARY-READ**: no query/path parameter selects a file. Only the
  explicitly configured manifest/events/artifacts paths are read.
- **C4A-NONBLOCKING**: the Host completes whether or not the UI is running; the
  UI never participates in scheduling.
- **C4A-LIFECYCLE**: `close()` releases the port; repeated close is safe.

## 5. Out of scope (deferred)

| item | owner phase | reason |
| --- | --- | --- |
| C5 single entry / capability experiments | C5 | later phase |
| F16 cache incrementality | F16 | performance; deferred |
| legacy 65 tsc import diagnostics | lib changes | recorded baseline |
| remote sharing / multi-user / CDN | later | not requested |
| cosmetic styling / full browser automation | later | not a gate |

## 6. Milestones

1. **C4a-A** view module + escaping. Commit.
2. **C4a-B** HTTP server + read-only routes + lifecycle. Commit.
3. **C4a-C** Pi command + observer wiring. Commit.
4. **C4a-D** product tests (HTTP/same-source/privacy/XSS/lifecycle), regressions,
   report. Commit.

## 7. Proof levels

- Real HTTP server on loopback with real `fetch` requests.
- Real committed EventLog from a C3 fixture run.
- Real Pi SDK + faux extension/command registration test.
- No real browser automation, model or external network.
