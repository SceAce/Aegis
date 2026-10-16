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

From the repository root, create an isolated demo Manifest and config first:

```bash
export AEGIS_DEMO_DIR="$(mktemp -d /tmp/aegis-c5-demo.XXXXXX)"
node --input-type=module <<'NODE'
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildC3FixtureManifest } from './Pi_Agent_base/campaign/c3-entry.mjs';
import { validateManifest } from './Pi_Agent_base/campaign/manifest.mjs';
const dir = process.env.AEGIS_DEMO_DIR;
const workspaceRoot = join(dir, 'workspace');
mkdirSync(workspaceRoot, { recursive: true });
const checked = validateManifest(buildC3FixtureManifest({ workspaceRoot }));
if (!checked.ok) throw new Error(checked.reasons.join('; '));
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(checked.manifest, null, 2) + '\n');
writeFileSync(join(dir, 'campaign.config.json'), JSON.stringify({
  schema_version: 'campaign-config-1.0', manifest_path: 'manifest.json',
  workspace_root: 'workspace', work_dir: 'run', mode: 'auto',
  session: { session_count: 2, max_requests_per_session: 10 },
  observation: { enabled: false, host: '127.0.0.1', port: 0 },
  oracle: { kind: 'fixture' }
}, null, 2) + '\n');
console.log(join(dir, 'campaign.config.json'));
NODE
node Pi_Agent_base/campaign/c5-entry.mjs --config "$AEGIS_DEMO_DIR/campaign.config.json" run --export
```

Keep the printed temporary directory to inspect/recover the run. The shorter
commands below assume you replace `campaign.config.json` with that explicit path.

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
- Unknown nested/top-level keys and wrong Session/observation/oracle types are
  refused. `host` must be loopback; port must be an integer from 0 to 65535.
- Session limit defaults to the Manifest limit; an explicit limit cannot expand
  it. A custom `budget_ledger` has only `limit`, `consumed`, `reserved`, with
  non-negative safe integers. Its base consumption excludes later rotations in
  this stream; the Host adds committed rotations once. Do not feed `budget_after`
  back as a fresh base.
- `script_config_path` optionally points at a human script registration
  (`.json` or `.mjs`) reusing the script-registry; absent means unconfigured.

## 3. Commands

```bash
# Run the whole loop, then export the read-only report artifacts:
node Pi_Agent_base/campaign/c5-entry.mjs --config campaign.config.json run --export

# Run with the optional loopback observation board (prints the URL):
node Pi_Agent_base/campaign/c5-entry.mjs --config campaign.config.json run --observe

# Read-only status (projects the committed stream, dispatches nothing):
node Pi_Agent_base/campaign/c5-entry.mjs --config campaign.config.json status

# Durable control (each writes a committed control event):
node Pi_Agent_base/campaign/c5-entry.mjs --config campaign.config.json pause
node Pi_Agent_base/campaign/c5-entry.mjs --config campaign.config.json resume
node Pi_Agent_base/campaign/c5-entry.mjs --config campaign.config.json cancel

# Export only (at a stop boundary), into an explicit directory:
node Pi_Agent_base/campaign/c5-entry.mjs --config campaign.config.json export --out ./report

# Read-only observation snapshot during this invocation (no task dispatch):
node Pi_Agent_base/campaign/c5-entry.mjs --config campaign.config.json observe --port 0
```

Exit code is 0 on success, 1 on a run/export/validation failure, 2 on a bad CLI
argument. Re-running `run` over the same `work_dir` is the recovery path: it
re-reads the committed stream, reconstructs evidence digests, and does not
re-dispatch completed tasks or duplicate effects. `status`, `export`, and
`observe` never run tasks; export before a committed log exists returns 1.
`resume` explicitly continues execution; `run` does not implicitly resume a
paused/cancelled Campaign.

## 4. Observation (optional)

The observation server is read-only: it serves `GET /`, `/healthz`, `/api/view`,
`/api/tasks`, `/api/queue`, `/api/actions`, `/api/outcomes`, `/api/faults`. There
is no write route; pause/cancel stay on the typed entry above. A UI failure never
blocks execution. The board prints its URL; no browser is auto-opened.

The C5 entry closes the listener before returning. Its URL is usable only while
that invocation is running; a completed command does not leave a background
board. Long-lived observation and SDK management are the next launcher task
(`SDK_LAUNCHER_TASK.md`), currently planned.

## 5. SDK / faux rotation

The programmatic entry accepts a caller-provided runtime and the SAME gate loaded
into every Session resource loader. The current CLI runs the deterministic local
Broker Worker and does not create SDK Sessions or enforce the request-threshold
rotation policy. The SDK test explicitly prepares a Pi Episode/handoff and calls
Host rotation through trusted `beforeRun`; it proves that injected lifecycle,
not automatic binding of every scheduler Task to an SDK Episode.

Reproduce that real SDK + faux test from the repository root:

```bash
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-c5-session-sdk.mjs
```

It observes a new AgentSession, same Pi Episode/authorization, one rotation
charge, the same gate, and a verified EventLog across Host and later standalone
SDK activity. Automatic SDK setup/current Task binding/policy are the next
launcher task. Real model/target/network runs require a separate explicit scope.

## 6. Limits

- The workspace is NOT an OS sandbox; loopback is not a security boundary against
  a local hostile process.
- Token/currency usage is `unknown` (not measured); synthetic dispatch cost is
  labelled.
- F16 cache, remote/multi-user, container/multi-worker and UI styling are out of
  scope for C5.
