# C5 Integration — Implementation Report

Status: **internally_verified / awaiting_external_review**.
Phase: C5 (single reproducible entry + full offline Campaign assembly). Scope
frozen in `C5_INTEGRATION_TASK.md` / `C5_INTEGRATION_DS_PROMPT.md`, plan/matrix/
runbook in `C5_INTEGRATION_WORK_PLAN.md` / `C5_INTEGRATION_TEST_MATRIX.md` /
`C5_INTEGRATION_RUNBOOK.md`. C1–C4a are not reopened; F16 and the legacy type
baseline stay deferred. No real model/network/target; no capability experiment.

Branch: `feat/c5-integration` (created from `feat/c4a-observation` @ `bd378ca`).

## 0. Baseline and Git note

- Start: branch `feat/c4a-observation`, worktree clean, last commit `bd378ca`.
- Commits on `feat/c5-integration`:
  - `35152c3` feat: single Campaign integration entry and trusted config (C5-A/B)
  - `551523a` test: C5 unified-entry product scenarios, SDK rotation, export/
    observation and runbook (C5-C/D)
  - `c1101f7` test: add C5 config-validator negative cases (C5-A1b)
  - `ef7fb6e` fix: compare workspace/grant paths by real location (C5 integration)
  - `d7ac4e8` test: cover symlinked workspace prefix in the C5 config validator (C5-A1c)
  - (this commit) docs: C5 implementation report
- Environment note: hash-looking text printed to stdout is masked by the sandbox,
  but digest VALUES are real and compared in-process; tests never assert on
  printed hash text.

## 1. Delivered entry

| file | role |
| --- | --- |
| `memory/campaign/campaign-config.mjs` | `loadCampaignConfig` — strict trusted-config loader/validator |
| `memory/campaign/c5-entry.mjs` | `runCampaignFromConfig` + CLI (`run/status/pause/resume/cancel/export/observe`), `createHostSessionController`, `campaignGateExtensionFactory` |
| `memory/campaign/c3-entry.mjs` | (shared) `assembleCampaignHost` accepts an optional `actionGate` so the Host and runtime share ONE gate |

Reused unchanged: C1 scheduler/projection, C2 `createSessionSupervisor`, C3
broker-worker/host-oracle/assembly, C4 `runReportExport`, C4a
`createObservationServer`. No second scheduler/plugin framework.

### Single command

```bash
node Pi_Agent_base/memory/campaign/c5-entry.mjs --config campaign.config.json run [--observe] [--export]
node Pi_Agent_base/memory/campaign/c5-entry.mjs --config campaign.config.json status|pause|resume|cancel
node Pi_Agent_base/memory/campaign/c5-entry.mjs --config campaign.config.json export --out <dir>
```

Trusted config (`campaign-config-1.0`): `manifest_path`, `workspace_root`,
`work_dir`, `mode`, optional `script_config_path`, `session`, `observation`,
`oracle`. Unknown keys are refused; `workspace_root` must equal the Manifest
authorization; `observation.host` must be loopback; `oracle.kind` must be a
registered kind (`fixture`).

## 2. Required results (actual commands, exit codes)

| case | command | exit | evidence |
| --- | --- | --- | --- |
| C5-N1/D1/C1/R1/A1/A1b/A1c | `node Pi_Agent_base/tests/aegis-c5-integration.mjs` | 0 | 7 tests / 7 pass |
| C5-S1 | `node --import .../source-resolver.ts Pi_Agent_base/tests/aegis-c5-session-sdk.mjs` | 0 | 12 checks / pass |
| C5-E1 | `node Pi_Agent_base/tests/aegis-c5-export-observation.mjs` | 0 | 2 tests / 2 pass |
| C5-O1 | `node Pi_Agent_base/tests/aegis-c5-runbook.mjs` | 0 | 1 test / pass |

Logs under ignored `/tmp/c5-*.log` during this run.

### Regression (C5-REG)

| suite | exit |
| --- | --- |
| aegis-c3-host-fixture.mjs | 0 |
| aegis-c3-durability-recovery.mjs | 0 |
| aegis-c3-external-boundaries.mjs | 0 |
| aegis-c4-report-export.mjs | 0 |
| aegis-c4-external-boundaries.mjs | 0 |
| aegis-c4a-observation-http.mjs | 0 |
| aegis-c4a-external-boundaries.mjs | 0 |
| aegis-c2-budget-sdk.mjs (resolver) | 0 |
| aegis-c2-supervisor-boundaries.mjs (resolver) | 0 |
| aegis-c3-session-entry.mjs (resolver) | 0 |
| aegis-c3-gate-sdk.mjs (resolver) | 0 |

Static:
- Biome on all C5 files + the shared `c3-entry.mjs`/`index.mjs`: **exit 0**.
- `tsc -p tsconfig.aegis-campaign.json`: **exit 1, 74 errors, 0 in C5 files**.
  The pre-C4a/C5 baseline was 65; the +9 are legacy import diagnostics now pulled
  in by `c5-entry` (which imports `session-supervisor`/`state` → `board`,
  `handoff-host`, `ram`): `runtime/board.mjs` (2), `runtime/handoff-host.mjs` (2),
  `runtime/ram.mjs` (5). All 74 are in legacy modules; the C5-authored files have
  ZERO diagnostics. Reported as-is; not zeroed by weakening checks.

## 3. What the cases prove

- **Normal + dynamic (C5-N1)**: one entry command runs two static tasks and a
  bounded dynamic task (submitted/admitted through the single writer) through the
  registered Broker, reaches real local effects, and reports bound Task/Stage
  Outcomes; dependency release holds.
- **SDK rotation (C5-S1)**: the real Pi SDK + faux runtime goes through the
  unified entry's injected C2 controller; one safe rotation creates a genuinely
  new `AgentSession`, keeps the same Pi Episode and Campaign Task/authorization,
  commits `handoff.completed` exactly once, charges the ledger once, and the
  ROTATED session loads the SAME Campaign gate (a direct `write` is blocked).
- **delayed/unknown (C5-D1)**: the entry stays consistent across runs; a delayed
  judgment does not release dependents early and a late result advances without a
  worker re-effect (the C1 scheduler path is exercised through the entry).
- **pause/resume/cancel (C5-C1)**: pause dispatches nothing; resume continues;
  cancel survives a later run (no revival).
- **crash/restart (C5-R1)**: a real child is SIGKILLed after the durable
  intent+effect; restart through the entry reconciles the stranded task from the
  real artifact without a blind re-effect.
- **auth/audit (C5-A1/A1b/A1c)**: `normal` mode without approval produces no effect;
  the config validator refuses unknown keys, a widened workspace grant, a
  non-loopback host and an unknown oracle kind. A symlinked workspace prefix
  (macOS `/tmp` -> `/private/tmp`) is accepted by REAL-path comparison while a
  genuinely different root is refused; the same real-path comparison is used by
  the C3 assembly and the broker-worker grant check (integration fix `ef7fb6e`,
  found by the runbook demo on a `/tmp` workspace).
- **export/observation (C5-E1)**: the C4 artifacts and the C4a observation view
  agree with the committed stream and stay read-only; a UI failure is not an
  execution dependency.
- **operational reproduction (C5-O1)**: the runbook commands run with the
  documented exit codes (0 success, 1 validation failure, 2 bad argument) and a
  rerun does not duplicate effects.

## 4. Ownership / budget / single writer (explicit)

- ONE Host + ONE EventLog owner per run: `c5-entry` opens the EventLog once (via
  the C3 product sink); the Observer/scheduler/rotation all use it; the export and
  observation read it read-only.
- Budget: the Host owns the ledger. `base` = committed Campaign ledger; each
  committed rotation adds exactly ONE `session_count` (the C2 supervisor's own
  base-vs-committed semantics are honoured, never double-charged). Synthetic
  dispatch cost is labelled; tokens/currency are `unknown`.
- Task/Episode/Session: the Campaign Task/Episode is owned by the Host; the Pi
  Episode/Session by the C2 supervisor. A rotation is ONE Session generation, not
  a new independent Episode.

## 5. Honest limitations

- The workspace is NOT an OS sandbox; loopback is not a security boundary against
  a local hostile process.
- The single entry wires the SDK runtime through a caller-provided `runtime`; the
  C5 test creates it with the shared gate loaded per session. A fully automatic
  SDK deployment wrapper (auto-opening Pi + loading extensions) is a deployment
  step, not implemented here.
- No real model/network/target is contacted; real capability experiments are a
  separate user-started task and are NOT authorized by green tests.
- `summary.json`, checkpoints and in-memory counters never grant success or
  authorization; the entry's `status` projects the committed stream read-only.

## 6. Deferred (not a C5 gate)

| item | owner | note |
| --- | --- | --- |
| F16 checkpoint cache incrementality | F16 | performance; deferred |
| legacy 74 tsc import diagnostics | when those libs change | recorded baseline (65 + 9) |
| container / remote platform / multi-worker | later | not requested |
| UI styling / remote sharing | later | not a gate |
| real model/network/target capability experiment | user-started later | requires explicit authorization |

## 7. External review request (C5 only)

Review ONLY the single entry, trusted config, single-writer/ownership and budget
wiring, the SDK rotation + shared gate, and the export/observation same-source
guarantee within the frozen scope above. Do not reopen C1–C4a, and do not extend
into real-target/capability experiments. C5 status:
**internally_verified / awaiting_external_review**.
