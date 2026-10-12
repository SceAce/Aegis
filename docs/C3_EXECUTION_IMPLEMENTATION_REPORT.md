# C3 Execution — Implementation Report

Status: **internally_verified / awaiting_external_review**.
Phase: C3 (Campaign Broker/Oracle/Host execution loop). Scope frozen in
`C3_EXECUTION_TASK.md`, `C3_EXECUTION_WORK_PLAN.md`, `C3_EXECUTION_TEST_MATRIX.md`.
C1/C2 are not reopened. F16 stays deferred. C4/C4a/real targets are out of scope.

Branch: `feat/c3-execution` (created from `feat/c2-session-rotation` @ `2d9041c`).

## 0. Baseline and Git note

- Start: branch `feat/c2-session-rotation`, worktree clean, last commit `2d9041c`.
- Environment honesty: this sandbox's `git` masks `rev-parse`/`cat-file` object
  ids to all-zero and fixes commit timestamps; only `git log --oneline/%h` prints
  the real abbreviated id. Commits below are cited by the id `git log` shows;
  full 40-char ids are not observable here. The earlier "forged timestamp"
  inference remains withdrawn (`GIT_STANDARD.md` §3).
- Commits on `feat/c3-execution`:
  - `c59f355` feat: campaign Host core, action gate and budget ownership (C3-A)
  - `5e36958` feat: brokered Worker, independent Host Oracle and fixture Host loop (C3-B)
  - `7808397` feat: workspace script adapter, delayed/reconcile and C2 session wiring (C3-C)
  - `c28332a` fix: reconstruct artifact evidence from the committed stream on restart (C3-D)
  - (this commit) docs: C3 execution implementation report

## 1. Delivered product entry

New Aegis-owned Campaign modules under `Pi_Agent_base/memory/campaign/`:

| file | role |
| --- | --- |
| `host.mjs` | `createCampaignHost` — single-writer Host over the C1 scheduler, single-charge budget ledger, session-rotation call-through |
| `campaign-mode.mjs` | `createCampaignActionGate` — Campaign-mode direct-tool denial |
| `broker-worker.mjs` | `createBrokerWorker` — durable `action.requested` → existing Broker → durable `action.completed` |
| `host-oracle.mjs` | `createHostOracle` — independent Stage/Task Oracle reading real post-state; success/failure/unknown/invalid + delayed |
| `fixture-adapter.mjs` | isolated fixture ActionContract (offline state file) |
| `script-workspace-adapter.mjs` | supervised macOS workspace registration reusing `script-registry` |
| `c3-entry.mjs` | product entry `assembleCampaignHost`/`runCampaignHost` + CLI |
| `projection.mjs` | (shared, one minimal change) ignore non-campaign rows in the mixed log |

The Host exposes `run/status/pause/resume/cancel/stop/rotateSession/budgetLedger/
guardToolCall`. All state transitions are written by the C1 scheduler; the Host
adds no second EventLog writer.

### Product start / recovery commands

```bash
# Start (or continue) the fixture Campaign Host:
node Pi_Agent_base/memory/campaign/c3-entry.mjs <workDir> start
# Pause / cancel (durable control events; no effects):
node Pi_Agent_base/memory/campaign/c3-entry.mjs <workDir> pause
node Pi_Agent_base/memory/campaign/c3-entry.mjs <workDir> cancel
# Re-running `start` over the same <workDir> is the recovery path: it re-reads
# the committed stream, reconstructs evidence digests, and does NOT re-dispatch
# completed tasks or duplicate effects.
```

Runtime artifacts (`events.jsonl`, `runtime/`, workspace, summary) live under the
caller-provided `<workDir>`; keep them in ignored `Pi_Agent_base/runtime/dev/`.

## 2. Required results (actual commands, exit codes)

All logs captured under ignored `/tmp/c3results/*.log` during this run.

| case | command | exit | evidence |
| --- | --- | --- | --- |
| C3-POS / POS-2 / DYN / DENY-1 / ORACLE-2 / ORACLE-3 / PRODUCT | `node Pi_Agent_base/tests/aegis-c3-host-fixture.mjs` | 0 | all assertions passed |
| C3-POS-WS / DENY-2 / DENY-3 / ORACLE-1 | `node Pi_Agent_base/tests/aegis-c3-workspace-adapter.mjs` | 0 | all assertions passed |
| C3-DUR-1 / DUR-2 / REC | `node Pi_Agent_base/tests/aegis-c3-durability-recovery.mjs` | 0 | all assertions passed |
| C3-DENY-4 | `node Pi_Agent_base/tests/aegis-c3-campaign-mode-gate.mjs` | 0 | all assertions passed |
| C3-SESSION | `node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-c3-session-entry.mjs` | 0 | all assertions passed |

### Regression (C3-REG)

| suite | exit |
| --- | --- |
| aegis-campaign-c1-integration-scheduler.mjs | 0 |
| aegis-campaign-c1-eventlog-durability.mjs | 0 |
| aegis-campaign-c1-event-projection.mjs | 0 |
| aegis-campaign-c1-integration-e2e.mjs | 0 |
| aegis-campaign-c1-integration-recovery.mjs | 0 |
| aegis-campaign-c1-integration-contracts.mjs | 0 |
| aegis-campaign-c1-final-audit.mjs | 0 |
| aegis-observe-actions.mjs | 0 |
| aegis-runtime-core-smoke.mjs | 0 |
| aegis-observer-verify-first-pi.mjs (resolver) | 0 |
| aegis-observer-outcome-command.mjs (resolver) | 0 |
| aegis-c2-supervisor-boundaries.mjs (resolver) | 0 |
| aegis-c2-budget-sdk.mjs (resolver) | 0 |
| aegis-c2-session-rotation.mjs (resolver) | 0 |
| aegis-campaign-c1-boundary-review.mjs | 1 (11 pass / 1 fail — F16 deferred) |

Static:
- Biome on all 17 C3 files + shared `projection.mjs`/`index.mjs`: **exit 0**.
- `tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json`: **exit 1, 65 errors**,
  **0 in any C3 file**. Pre-C3 baseline (same config shape, original module set)
  was **10**. The 55 added diagnostics are all in legacy modules now imported to
  reuse the Broker: `runtime/action-contract.mjs` (29), `runtime/authorization.mjs`
  (25), `runtime/script-registry.mjs` (1), plus the pre-existing
  `fixture/contracts.mjs` (2) and `runtime/events.mjs` (8). This is the documented
  "old dependency error baseline"; it is reported as-is and NOT zeroed by
  disabling checks, `any`, `@ts-ignore` or excluding C3 code.

## 3. What the required cases prove

- **C3-POS/POS-2**: two static tasks, `task-002` depends on `task-001`; real
  `door.json` written; both tasks complete only when every required stage resolves;
  `task-002` starts strictly after `task-001` completes.
- **C3-DYN**: an `llm` proposal is recorded, a Runtime admission is the
  transition; the definition resolves from the projection (not a preset
  `ownedTasks` entry) and is dispatched through the same registered adapter.
- **C3-DENY-1/2/3**: unregistered `action_ref`, out-of-root resource path,
  changed script digest and undeclared parameter are all refused at the Broker/
  script boundary with no adapter/file/subprocess effect; a legal positive still runs.
- **C3-DENY-4**: in Campaign mode `bash`/`write`/`edit`/`read` are denied with a
  visible reason and no disk effect; brokered tools pass; ordinary Pi behaviour is
  unchanged when no Campaign is active.
- **C3-DUR-1**: an `action.requested` append failure ⇒ worker never runs, 0 effects.
- **C3-DUR-2**: an `action.completed` append failure after the effect ⇒ effect ≤1,
  task `unknown`, result not recorded; no new effects.
- **C3-REC**: a real child is SIGKILLed after the durable intent + effect; restart
  reconciles the stranded task from the real artifact (`reconciliation.resolved`
  + bound outcomes), effect count not duplicated, worker not re-run.
- **C3-ORACLE-1**: script exits 0 but the registered post-condition reads the real
  file and refuses ⇒ not success.
- **C3-ORACLE-2**: an unresolvable/foreign evidence ref blocks a Task success.
- **C3-ORACLE-3**: a delayed `unknown` blocks the dependent task; a later external
  result advances it through a fresh judgment WITHOUT re-running the worker.
- **C3-SESSION**: the product Host really calls the accepted C2 supervisor
  (`createSessionSupervisor`) at a settle boundary; a genuinely new `AgentSession`
  object is created; the same Pi episode survives; the Host ledger charges exactly
  one `session_count` generation; an exhausted session budget refuses the second
  rotation with no replacement and no extra charge.
- **Restart durability (C3-D fix)**: a second CLI process sees the committed
  completions and dispatches nothing new.

## 4. Budget ownership (explicit)

The Host is the SINGLE charge owner. `buildBudgetLedger` publicly reports:
- `base`: the committed Campaign ledger (reserved/consumed) from the projection;
- `sessions_committed`: committed C2 rotations for the episode;
- `consumed.session_count` = base + one per committed rotation (never double);
- `synthetic_cost`: the per-dispatch placeholder, explicitly `{...,synthetic:true}`;
- `unobservable: ["tokens","currency"]` — real token/amount usage is `unknown`,
  never fabricated;
- `charge_owner: "campaign_host"` and `scope: "campaign_episode"`.

C2 boundary: the C2 supervisor's ledger contract (base consumption that does NOT
include this episode's later rotation increments) is honoured by counting
committed rotations ON TOP of the base; the Host never passes `budget_after` back
as a new base.

## 5. What is NOT proven / deferred

| item | status | owner phase | reassessment |
| --- | --- | --- | --- |
| F16 checkpoint cache incrementality | deferred (unchanged) | F16 | when recovery actually depends on cache read counts |
| C4 report / acceptance bundle | not implemented | C4 | next phase |
| C4a UI / view commands | not implemented | C4a | later |
| container/remote platform adapter | not registered; explicit refusal kept | later | when an adapter is registered |
| multi-Worker / parallel Task | not implemented (U7 single active) | later | later |
| real target / network / model capability | never called | later | requires user authorization |
| workspace OS isolation | NOT claimed; `workspace_is_sandbox=false` | — | — |
| global type-check cleanliness | not achieved (65 legacy diagnostics) | — | not a C3 goal; recorded honestly |

## 6. Honest limitations

- The fixture and workspace effects are LOCAL synthetic data; no real target,
  network or model was contacted.
- The SDK case uses the real Pi SDK + faux provider via the source resolver; it
  proves the rotation wiring, not arbitrary continuation side effects or
  cross-process exactly-once for external side effects.
- The workspace adapter bounds paths/resource params and re-checks a registered
  post-condition; it is NOT an OS sandbox and makes no process/network isolation
  claim.
- The single accepted F16 boundary-review failure (11/12) is unchanged and does
  not gate C3.

## 7. External review request (C3 only)

Please review ONLY the C3 execution loop, authorization/evidence/budget wiring and
recovery semantics within the frozen scope above. Do not reopen C1/C2 for F16 and
do not extend into C4/C4a or real-target experiments. C3 status:
**internally_verified / awaiting_external_review**.
