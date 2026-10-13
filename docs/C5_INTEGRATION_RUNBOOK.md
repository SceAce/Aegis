# Aegis C5 — Campaign Runbook (offline / faux)

A single entry runs a whole Campaign from one trusted config file. Nothing here
contacts a real model, network or target: the SDK path uses a faux provider and
effects are real local temporary files only.

## 1. Layout

```text
<run>/
  manifest.json          # the immutable Campaign Manifest (campaign-1.0)
  campaign.config.json   # the trusted run config (this runbook)
  workspace/             # the authorized workspace (workspace_is_sandbox=false)
  run/
    events.jsonl         # the ONE committed EventLog
    runtime/             # per-Campaign lock + checkpoint (derived)
    report/              # C4 export artifacts (when --export)
```

## 2. The trusted config

`campaign.config.json` (paths may be absolute or relative to this file):

```json
{
  "schema_version": "campaign-config-1.0",
  "manifest_path": "manifest.json",
  "workspace_root": "workspace",
  "work_dir": "run",
  "mode": "auto",
  "script_config_path": null,
  "session": { "session_count": 2, "max_requests_per_session": 10 },
  "observation": { "enabled": false, "host": "127.0.0.1", "port": 0 },
  "oracle": { "kind": "fixture" }
}
```

Notes:
- `workspace_root` MUST equal the Manifest `authorization.workspace_root`; the
  config can never widen the grant.
- Unknown keys are refused. `host` must be loopback.
- `script_config_path` optionally points at a human script registration
  (`.json` or `.mjs`) reusing the script-registry; absent means unconfigured.

## 3. Commands

```bash
# Run the whole loop, then export the read-only report artifacts:
node Pi_Agent_base/memory/campaign/c5-entry.mjs --config campaign.config.json run --export

# Run with the optional loopback observation board (prints the URL):
node Pi_Agent_base/memory/campaign/c5-entry.mjs --config campaign.config.json run --observe

# Read-only status (projects the committed stream, dispatches nothing):
node Pi_Agent_base/memory/campaign/c5-entry.mjs --config campaign.config.json status

# Durable control (each writes a committed control event):
node Pi_Agent_base/memory/campaign/c5-entry.mjs --config campaign.config.json pause
node Pi_Agent_base/memory/campaign/c5-entry.mjs --config campaign.config.json resume
node Pi_Agent_base/memory/campaign/c5-entry.mjs --config campaign.config.json cancel

# Export only (at a stop boundary), into an explicit directory:
node Pi_Agent_base/memory/campaign/c5-entry.mjs --config campaign.config.json export --out ./report
```

Exit code is 0 on success, 1 on a run/export/validation failure, 2 on a bad CLI
argument. Re-running `run` over the same `work_dir` is the recovery path: it
re-reads the committed stream, reconstructs evidence digests, and does not
re-dispatch completed tasks or duplicate effects.

## 4. Observation (optional)

The observation server is read-only: it serves `GET /`, `/healthz`, `/api/view`,
`/api/tasks`, `/api/queue`, `/api/actions`, `/api/outcomes`, `/api/faults`. There
is no write route; pause/cancel stay on the typed entry above. A UI failure never
blocks execution. The board prints its URL; no browser is auto-opened.

## 5. SDK / faux rotation

The SDK path is exercised by the test suite (real Pi SDK + faux provider through
the unified entry); a rotation at a settle boundary creates a genuinely new
AgentSession, keeps the same Task/Episode/authorization, charges the ledger once,
and the new Session loads the same Campaign gate. Real model/target/network runs
are a separate, user-authorized capability experiment — NOT part of this runbook.

## 6. Limits

- The workspace is NOT an OS sandbox; loopback is not a security boundary against
  a local hostile process.
- Token/currency usage is `unknown` (not measured); synthetic dispatch cost is
  labelled.
- F16 cache, remote/multi-user, container/multi-worker and UI styling are out of
  scope for C5.
