# C3 Execution — Work Plan and Frozen Contract

Status: **frozen before implementation; C3-A..D completed, internally verified, awaiting one C3 external review**. Scope follows `C3_EXECUTION_TASK.md`
and `CAMPAIGN_NEXT_PHASES.md` §C3. This plan does not reopen C1/C2 and does not
implement C4/C4a or any real target/network/model capability.

Branch: `feat/c3-execution`
Baseline (recorded before any change):

- Aegis parent repo branch `feat/c2-session-rotation`, working tree clean,
  last commit `2d9041c` (real object id masked by the local git wrapper; see
  §Baseline note below).
- Embedded Pi nested repo present under `Pi_Agent_base/pi/` with its own git
  history; its HEAD is NOT modified by C3.

Baseline note (environment honesty): this sandbox's `git` reports
`rev-parse`/`cat-file` object ids as all-zero and fixes commit timestamps; only
`git log --oneline/%h` prints the real abbreviated id. Reports therefore cite
the abbreviated ids shown by `git log` and state that full 40-char ids are not
observable here. This is an environment display mask, not a claim about the
object store. Per `GIT_STANDARD.md` §3 the earlier "forged timestamp"
inference remains withdrawn.

## 1. Problem and user-visible behaviour

C1 provides a durable scheduler with injected `worker`/`oracle`; C2 provides a
real Host session-rotation entry. There is still NO product entry that binds
`Manifest → C1 scheduler → Worker → existing Broker → real local effect →
independent Stage/Task Oracle → bound Outcome`, and no explicit budget
ownership across the C2 rotation boundary. C3 delivers exactly that loop, plus a
Campaign-mode action gate so the model cannot reach the filesystem through an
unbrokered direct tool.

## 2. Frozen interfaces (C3-A)

New Aegis-owned modules (author-JS `.mjs`, JSDoc-typed):

### `Pi_Agent_base/memory/campaign/host.mjs` (owner: C3-A)

`createCampaignHost({ manifest, baseDir, workspaceRoot, eventLogPath, registry,
scriptRegistry, oracle, clock, budgetAccount, sessionController })` returns a
Host with:

- `start()/resume()/pause(reason)/cancel(reason)/stop()` — durable control via
  the C1 scheduler's committed control events;
- `run()` — one scheduler pass; returns `{ok, reasons, status, actions, sessions}`;
- `status()` — projection snapshot + action/session counters;
- `actionGate` — the Campaign-mode guard (below);
- `budgetLedger()` — the SINGLE charge owner view (base + committed rotations).

### `Pi_Agent_base/memory/campaign/broker-worker.mjs` (owner: C3-B)

`createBrokerWorker({ broker, authorization, registry, intentLog,
artifactIndex, workspaceRoot })` returns a C1-shaped worker whose `run({task})`:

1. resolves the task's declared stages to registered `action_ref`s (from the
   task definition / a Host-provided plan), never from model text;
2. for each step: re-derives authorization at the Broker boundary, appends a
   DURABLE `action.requested` intent (fsync checked) BEFORE the effect;
3. calls `broker.invoke(...)` (existing action-contract path);
4. appends `action.completed` with the real observed result;
5. returns `{ok, outcome_ref, effects}` — the transport fact, NOT a verdict.

### `Pi_Agent_base/memory/campaign/host-oracle.mjs` (owner: C3-B)

`createHostOracle({ workspaceRoot, readState })` returns an Oracle with
`judge({task, outcome_ref})` and `reconcile({task, intent, effect_probe})` that
reads the REAL post-state (artifact/file) and returns bound Stage/Task Outcomes
with `provenance: {source:"oracle", independent:true, task_id, stage_id}`,
matching `scope`, resolvable `evidence_refs`, and `observed`. It supports
`success | failure | unknown | invalid` and a `delayed` flag. It NEVER trusts
`worker.ok` or an exit code.

### `Pi_Agent_base/memory/campaign/campaign-mode.mjs` (owner: C3-A)

`createCampaignActionGate({ allowDirectTools = [] })` provides
`guardToolCall({tool_name, action_ref})` → explicit allow/deny. In Campaign mode
only `aegis_workspace`/`aegis_script` (the brokered tools) and explicitly
allow-listed read-only tools pass; `bash`/`write`/`edit`/`read` and any other
direct Pi tool are DENIED with a recorded reason. The gate is only active when a
Campaign Host is running in the process; ordinary Pi behaviour is unchanged.

### `Pi_Agent_base/memory/campaign/script-workspace-adapter.mjs` (owner: C3-C)

`createWorkspaceScriptRegistration({ scriptPath, workspaceRoot, ... })` builds a
`script-registry` registration (fixed absolute executable, pinned
`executable_digest`/`script_digest`, data-only parameter schema with
`direction`, `cwd` inside `allowed_root`, timeout, `network:false`) plus a
registered post-condition `verify()` that reads the real target. Reuses
`script-registry.mjs` unchanged; no new execution framework.

### `Pi_Agent_base/memory/campaign/c3-entry.mjs` (owner: C3-D)

Product CLI/entry: `runCampaignHost({ manifestPath, workDir, workspaceRoot,
scenario })`. Provides the actual start/pause/cancel/exit and recovery commands
a user runs, wiring the modules above plus the C2 supervisor adapter.

## 3. Owners and non-overlap

| Area | Owner | Files |
|---|---|---|
| Host core, gate, budget ownership | C3-A | `host.mjs`, `campaign-mode.mjs`, `index.mjs` export, `tsconfig.aegis-campaign.json` |
| Broker worker + Oracle + fixture adapter | C3-B | `broker-worker.mjs`, `host-oracle.mjs`, `fixture-adapter.mjs` |
| Workspace script adapter + delayed/reconcile + C2 wiring | C3-C | `script-workspace-adapter.mjs`, `host.mjs` session hook (main DS integrates) |
| Product entry + integration tests | C3-D | `c3-entry.mjs`, `tests/aegis-c3-*.mjs`, `tests/helpers/aegis-c3-*` |

Shared files (`index.mjs`, tsconfig, phase runner, docs) are edited by the main
DS only. Sub-tasks touch disjoint files.

## 4. Invariants

- **C3-INTENT**: a durable `action.requested` (scheduler `campaign.task.started`
  + Host intent) must be appended AND fsync-confirmed before any effect. Any
  append/fsync failure ⇒ no adapter call.
- **C3-AFTER**: an append failure AFTER an effect stops new effects, keeps
  `pending/unknown`, and never blind-retries a non-idempotent action.
- **C3-ORACLE**: results are bound to Task/Episode/Stage/scope/criterion and
  backed by resolvable evidence read from the real post-state; exit code/worker
  claim are never truth.
- **C3-GRANT**: Campaign/Task grant is re-checked at the Broker boundary; target
  must be inside the authorized workspace; readonly is not a credential/escape
  licence.
- **C3-NOBYPASS**: in Campaign mode, a direct Pi tool cannot produce an effect
  outside the Broker.
- **C3-BUDGET**: the Host owns ONE ledger. Static task reservations are the base;
  each committed C2 rotation adds exactly ONE `session_count`; the scheduler's
  per-dispatch cost stays explicitly `synthetic`. No double count, no omission
  across a Task/Episode boundary. Impossible-to-observe token/amount = `unknown`.
- **C3-CONTINUITY**: a C2 rotation keeps the same Task/Episode/authorization and
  never creates a new independent evidence group.

## 5. Out of scope (deferred)

| item | owner phase | reason |
|---|---|---|
| F16 checkpoint cache incrementality | F16 | performance; full replay correctness preserved |
| C4 report / acceptance bundle | C4 | later phase |
| C4a UI / Pi view commands | C4a | later phase |
| container/remote platform adapter | later | not registered; explicit refusal kept |
| multi-Worker / parallel Task | later | U7: single active Task/Episode |
| real capability experiment / network / model | later | requires user authorization |

## 6. Milestones

1. **C3-A** contract: Host skeleton, Campaign-mode gate, budget ownership,
   index/tsconfig wiring. Commit.
2. **C3-B** fixture adapter + Broker worker + Host Oracle: two static tasks reach
   real local effects and bound Stage/Task Outcomes. Commit.
3. **C3-C** workspace script adapter, delayed/unknown + reconcile, C2 session
   wiring. Commit.
4. **C3-D** product entry + full required matrix + regressions. Commit; one
   phase review (`C3_EXECUTION_IMPLEMENTATION_REPORT.md`).

## 7. Proof levels

- fixture adapter: synthetic local file effects (labelled `synthetic`).
- workspace adapter: real registered script subprocess in a temp workspace.
- SDK: real Pi SDK + faux provider through the Host (source resolver), no real
  model/network.
- EventLog: the REAL `memory/runtime/events.mjs` EventLog (append + fsync +
  hash chain) for intent/completion evidence.
