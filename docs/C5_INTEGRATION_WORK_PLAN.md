# C5 Integration — Work Plan and Frozen Contract

Status: **frozen before implementation; C5-A..D completed, internally verified, awaiting one C5 external review**. Scope follows `C5_INTEGRATION_TASK.md`
and `C5_INTEGRATION_DS_PROMPT.md`. This plan does not reopen C1–C4a, F16 or the
type baseline, and does not run real models/targets/network or capability
experiments.

Branch: `feat/c5-integration` (created from `feat/c4a-observation` @ `bd378ca`).
Baseline: worktree clean.

## 1. Problem and deliverable

Today a user must assemble several factories by hand (C3 `assembleCampaignHost`,
C2 supervisor, C4 `runReportExport`, C4a `createObservationServer`). C5 provides a
SINGLE reproducible entry plus one trusted config file:

```text
explicit Manifest / trusted registrations / Oracle / SDK config
  -> one Host + EventLog owner
  -> static/dynamic Task -> Broker -> local effect -> Oracle/delayed
  -> safe Session rotation/ledger -> pause/cancel/restart
  -> read-only report export + optional loopback observation
```

It reuses C1 scheduler, C2 supervisor, C3 assembly, C4 export, C4a server/command.
It creates NO second scheduler/plugin framework.

## 2. Frozen interfaces (C5-A)

### `Pi_Agent_base/memory/campaign/campaign-config.mjs`

- `loadCampaignConfig({ configPath })` → `{ ok, reasons, config }`.
- The config is a JSON file (trusted Host input, NEVER model-provided):
  ```json
  {
    "schema_version": "campaign-config-1.0",
    "manifest_path": "abs or repo-relative",
    "workspace_root": "abs path (must equal the Manifest authorization)",
    "work_dir": "abs private dir for events/runtime/summary",
    "mode": "auto | normal",
    "script_config_path": "optional human script registration (.json/.mjs)",
    "session": { "session_count": 2, "max_requests_per_session": 10, "budget_ledger": {...} },
    "observation": { "enabled": true, "port": 0 },
    "oracle": { "kind": "fixture" | "registered" }
  }
  ```
- Validation: unknown/absent fields refuse explicitly; `manifest_path`/`workspace_root`
  must exist; `workspace_root` must equal the Manifest's authorized root; every
  path is resolved and must not be a symlink escape; unknown top-level keys reject.

### `Pi_Agent_base/memory/campaign/c5-entry.mjs`

Single CLI entry with subcommands:

```text
node c5-entry.mjs --config <campaign.config.json> run [--observe] [--export]
node c5-entry.mjs --config <campaign.config.json> status
node c5-entry.mjs --config <campaign.config.json> pause | resume | cancel
node c5-entry.mjs --config <campaign.config.json> export --out <dir>
node c5-entry.mjs --config <campaign.config.json> observe [--port N]
```

`run` is the product path: it assembles ONE Host (single EventLog writer),
optionally starts the C4a server (optional) and, at a stop/complete boundary,
runs the C4 export (optional). It prints a bounded summary + the observation URL.
No browser is auto-opened.

### Session wiring

The entry builds a `sessionController` over the C2 `createSessionSupervisor`
(`committedRotations`/`rotate`/`canRotate`) and injects it into the Host, so
rotation keeps the same Task/Episode/authorization and charges the ledger once.

### Gate wiring

The entry creates ONE `createCampaignActionGate` and exposes its
`extensionFactory` so the SDK runtime (and every rotated Session) loads the same
gate. The Host and the runtime share the same gate object.

## 3. Owners / budget / event contract

- ONE EventLog owner: the entry opens the EventLog once (via C3 `createProductSink`)
  and passes it to the Host. The Observer/scheduler/rotation/export all read/write
  through that same single writer chain; the export reads read-only.
- Task/Episode/Session binding: the Host carries the Campaign Task/Episode; the C2
  supervisor carries the Pi Episode/Session. A rotation is ONE Session generation,
  never a new Episode.
- Budget: the Host owns the ledger. `base` = committed Campaign ledger; each
  committed rotation adds exactly ONE `session_count`. Synthetic dispatch cost is
  labelled; tokens/amounts are `unknown`.

## 4. Frozen invariants

- **C5-ONE-ENTRY**: a single command runs the whole loop; no hand-assembled
  factories.
- **C5-SINGLE-WRITER**: one EventLog owner; no second write chain.
- **C5-SAME-SOURCE**: report and observation derive from the same committed
  stream; UI failure never blocks execution.
- **C5-NO-BYPASS**: direct tools are denied in Campaign mode via the shared gate;
  the rotated Session loads the same gate.
- **C5-NO-DOUBLE-CHARGE**: committed rotations charged once; no cross-task leak.
- **C5-CONFIG-TRUSTED**: config paths come from the launcher file only.

## 5. Out of scope (deferred)

| item | owner phase | reason |
| --- | --- | --- |
| F16 cache incrementality | F16 | performance; deferred |
| legacy 65 tsc import diagnostics | lib changes | recorded baseline |
| container / remote platform / multi-worker | later | not requested |
| UI styling / C4a polish | later | not a gate |
| real model / network / target capability experiment | user-started later | requires explicit authorization |

## 6. Milestones

1. **C5-A** config loader/validator + entry skeleton. Commit.
2. **C5-B** unified `run` (Host + optional observe + optional export + session
   controller + gate). Commit.
3. **C5-C** control subcommands + runbook. Commit.
4. **C5-D** required product scenarios + regressions + report. Commit.

## 7. Proof levels

- Real committed EventLog, real local effects, real child-process restart.
- Real Pi SDK + faux provider for the rotation and gate.
- No real model/network/target.
