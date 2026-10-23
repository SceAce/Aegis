# Aegis Campaign Architecture

Status: **design and implementation plan; C0 is in closure review, later runtime phases are not yet accepted**.

Current execution process: `DS_MASTER_PROMPT.md`,
`AGENT_DEVELOPMENT_STANDARD.md`, `AGENT_TESTING_STANDARD.md`, and
`DS_ORCHESTRATION_WORKFLOW.md`. Precise closure contracts and the current C0/C1
scope are in `CAMPAIGN_CONTRACT_BASELINE.md`. The master DS receives one
assignment and decomposes it into small tests/implementation/review tasks.

This document adds the missing Campaign layer above the existing
`Event -> Episode -> Outcome -> Experience` runtime. It does not replace the
current memory schema, Observer, Board, Router, Broker, Oracle, or Compiler.
The purpose of this layer is to make one user-started long experiment a durable,
observable, resumable unit instead of a collection of manually launched
single-task runs.

## 1. Existing Documentation Map

The eight requested capabilities are already described in fragments. They are
not yet described as one implementable Campaign contract.

| Requested capability | Existing documentation | Current meaning | Gap |
|---|---|---|---|
| Campaign Manifest and task queue | `docs/MEMORY_SCHEMA.md` §9 live `manifest.json`; `docs/PROTOTYPE_DESIGN.md`; `contest/run.sh` task variables | A manifest exists for one live experiment/task, and contest runs have a task id | No Campaign-level immutable manifest, task specification, queue state, dependency model, or durable queue recovery |
| Long-task scheduler | `docs/ARCHITECTURE_DECISIONS.md` §3 and §9.11; `THINK.md` §9.3/§9.11 | Runtime should own budgets, lifecycle, locks, retries, and stop conditions | No durable scheduler loop that owns multiple tasks and resumes after process failure |
| Real Host-level Session rotation | `docs/ARCHITECTURE_DECISIONS.md` §3 Pi integration and “短会话主线”; `docs/OVERNIGHT_TASK.md` Batch A; `docs/MEMORY_SCHEMA_NOTES.md` §6 | Session and Episode are separate; a Host should create a fresh Pi runtime while preserving RuntimeState | Existing documents describe the contract and tests, but not a Campaign supervisor that invokes rotation automatically at safe boundaries |
| General task/stage result aggregation | `docs/MEMORY_SCHEMA.md` §§4–5; `docs/ARCHITECTURE_DECISIONS.md` “数据有用性”; `docs/OVERNIGHT_TASK.md` Batch B/C | Outcomes judge step/episode criteria; data usefulness is 获得 -> 使用 -> 推进 | No common task/stage projection, aggregation rules, dependency status, or delayed-result handling at Campaign level |
| Unified real-environment Broker | `docs/ARCHITECTURE_DECISIONS.md` §3 and §4.2; `docs/OVERNIGHT_TASK.md` Batch B; `docs/AEGIS_RUN_AND_ACCEPTANCE.md` | All side effects should pass through Broker/Guard/Adapter; workspace is not a sandbox | Existing Broker is a runtime/library boundary for registered actions, not yet the single entry point for an entire long Campaign or arbitrary CTF tooling |
| Pluggable Oracle interface | `架构.md` §3.1 Oracle Bus; `docs/MEMORY_SCHEMA.md` §§5 and 9; `live-oracle.mjs`; replay adapter docs | Oracle independently judges criteria and may return success/failure/unknown | No general adapter registry and lifecycle contract for task, stage, delayed, platform, and recovery judgments |
| Automatic report input for final acceptance | `contest/daily.mjs`, `docs/AEGIS_RUN_AND_ACCEPTANCE.md`, `docs/CONTEST_MVP.md` | Contest has a deterministic read-only report; acceptance checklist exists | No versioned machine-readable acceptance bundle addressed to `gpt-6.1-sol`, with evidence links, unsupported claims, and integrity status |
| Long-task stop/recovery/fault handling | `THINK.md` §9.3; `docs/ARCHITECTURE_DECISIONS.md` §4.3, §9.3, §9.11; `docs/PI_OBSERVER.md` | Unknown actions require reconciliation; logs fail closed; handoff must be safe | No Campaign-level state machine, checkpoint protocol, lease/lock policy, signal handling, or fault matrix |

The current fixture orchestrator is intentionally narrower. It proves a
single `direct` versus planner path for one registered action; it is not the
Campaign scheduler described here.

## 2. Architectural Position

The Campaign layer sits above the existing Runtime and owns orchestration only:

```text
User: Campaign goal + authorization + budget
              |
       Campaign Host / Scheduler
       |         |          |
   Manifest   Queue      Checkpoint
              |
        Task Supervisor
              |
       Episode Supervisor
              |
     Session Host / Pi Runtime
              |
        Observer + RAM
              |
   Router -> Skill -> Action Broker
              |
        Execution Adapter
              |
        Real environment
              |
          Oracle Bus
              |
   Step/Stage/Task Outcomes
              |
      Board / RuntimeState
              |
     Compiler / Experience
              |
   Campaign report + acceptance bundle
```

There remains one authoritative event writer per Campaign event stream. Board,
RuntimeState, queue projections, reports, and acceptance bundles are derived
from the committed event stream plus immutable Campaign inputs. They are not a
second truth source.

The layer boundaries are:

- **Campaign**: the user-started experiment, its immutable inputs, task set,
  budgets, policy, and final report.
- **Task**: a unit supplied by the Campaign. It has an explicit target,
  authorization, environment, success criteria, and selected adapters.
- **Episode**: one bounded attempt for one goal. It may contain multiple short
  Pi Sessions, but Session rotation never creates independent evidence.
- **Session**: one fresh Pi context/window owned by the Host. It is disposable
  and must not own durable progress.
- **Stage**: a verified intermediate milestone inside a task. A stage is
  represented by criteria and Outcomes, not by a free-text model summary.
- **Action**: a request through the single Broker. The model supplies only
  data arguments and references to registered capabilities.
- **Outcome**: an Oracle or explicitly authorized independent human/platform
  judgment. `unknown` remains `unknown`.

## 3. Proposed Contracts

### 3.1 Campaign Manifest

The Campaign Manifest is immutable after start. A correction creates a new
Campaign revision or a new Campaign; it does not rewrite the source used by a
running Campaign.

```json
{
  "schema_version": "campaign-1.0",
  "campaign_id": "campaign-...",
  "revision": 1,
  "created_at": "...",
  "title": "anonymous experiment title",
  "objective": {
    "description": "...",
    "success_criteria": ["..."],
    "stage_policy": "declared_only"
  },
  "worker": {
    "provider": "...",
    "model": "deepseek-v4.1-flash",
    "pi_build_id": "...",
    "rom_digest": "sha256:...",
    "tool_schema_digest": "sha256:..."
  },
  "authorization": {
    "execution_profile": "supervised-macos-workspace",
    "workspace_is_sandbox": false,
    "credentials": "none",
    "workspace_root": "...",
    "allowed_targets": ["..."],
    "allowed_capabilities": ["..."],
    "network": "disabled",
    "human_approval": "required|campaign_grant"
  },
  "budget": {
    "wall_time_ms": 3600000,
    "model_requests": 1000,
    "tool_calls": 5000,
    "task_count": 10,
    "session_count": 100
  },
  "session_policy": {
    "max_requests_per_session": 20,
    "max_context_chars": 50000,
    "rotate_at_stage_boundary": true,
    "rotate_on_model_request": true,
    "allow_model_handoff_request": true
  },
  "adapters": {
    "execution": "workspace.exec.v1",
    "oracle": "fixture.oracle.v1",
    "report": "aegis-acceptance.v1"
  },
  "tasks": [
    {
      "task_id": "task-001",
      "order": 1,
      "depends_on": [],
      "target_ref": "...",
      "goal": {"description": "...", "success_criteria": ["..."]},
      "stages": [
        {"stage_id": "stage-observe", "criteria": ["..."]},
        {"stage_id": "stage-solve", "criteria": ["..."]}
      ],
      "environment": {"fingerprint": "...", "reset_ref": "..."},
      "oracle_ref": "...",
      "task_budget": {"wall_time_ms": 600000, "model_requests": 100}
    }
  ],
  "evidence_policy": {
    "independent_result_required": true,
    "unknown_is_not_failure": true,
    "promote_experience": false
  }
}
```

The first implementation may omit optional fields, but must not silently invent
wildcards. Missing target, authorization, budget, task criteria, execution
adapter, or Oracle references make the Campaign invalid.

### 3.2 Queue and Scheduler State

Queue state is projected from events. A small checkpoint may accelerate restart,
but it must include the source event digest and be rebuildable.

```text
queued
  -> ready
  -> running
  -> waiting_oracle
  -> paused
  -> completed
  -> failed
  -> unknown
  -> cancelled
```

`failed` is a scheduler/execution failure. It is not automatically a task
Outcome failure. The task Outcome comes from the Oracle.

The queue is finite at Campaign start but may receive **bounded dynamic task
proposals** during execution. Dynamic expansion is a core capability, not an
unrestricted model privilege. A proposal must identify its parent task or
stage, purpose, target, required capabilities, expected evidence, budget,
priority, and stop condition. Aegis admits it only when all of these hold:

- the target remains inside the Campaign authorization and workspace;
- it uses already-authorized execution and Oracle adapters;
- it does not expand network, credentials, destructive permissions, or budget;
- its task type is allowed by the Manifest policy;
- depth, fan-out, total task count, and derived budget limits remain available;
- the proposal is structurally valid and does not duplicate an active or
  completed task;
- the proposal and its admission/rejection reason are written to the Board.

An admitted task may be scheduled automatically within the remaining Campaign
budget. A proposal requiring a new capability, target, permission, adapter,
network policy, or budget is blocked and displayed as a human decision item; it
is never silently granted. Human monitoring is an observation and escalation
channel, not a second hidden state source.

Each queue item must retain:

- `campaign_id`, `task_id`, `attempt_id`, `episode_id`;
- dependency status and selected execution profile;
- current stage and next action;
- budget consumed and remaining;
- current session id and session generation;
- last committed event sequence/digest;
- pending action id and reconciliation state;
- retry count and stop reason;
- task/stage Outcome references.

Only one scheduler worker may mutate one Campaign projection at a time. A
process lease can be used for crash recovery, but an LLM never owns the lease.

### 3.3 Host-level Session Rotation

The Host, not the Observer extension, owns the real Pi session lifecycle.
Rotation is legal only after:

1. no side-effecting action is in flight;
2. the current session is idle or has reached a controlled settle boundary;
3. all event writes and relevant projections are committed;
4. pending actions are either completed, reconciled, or explicitly blocking;
5. the Campaign and task budgets permit another session;
6. the new Session receives a bounded RAM package derived from committed state.

The replacement must create a genuinely new Pi Session/Runtime object and fresh
context. It must preserve `campaign_id`, `task_id`, `episode_id`, goal,
authorization, budget, current stage, effective facts, unknowns, and pending
recovery information. It must not copy the entire old transcript as a hidden
second memory source.

Rotation records request, decision, old session, new session, state revision,
reason, and result. `handoff.completed` is written once and only after the new
runtime is successfully bound. Cancellation or creation failure leaves the
handoff staged and does not emit false completion.

Work-cycle continuation refines this boundary without changing Episode or Outcome
semantics. A pending work review may be carried into a replacement Session when
the existing safety, settlement and budget gates pass; the replacement must
rebuild and retain the same effect hold. The review is not an unresolved effect
and rotation never consumes it. The C6 Host's explicitly enabled work-unit/context
rotation is implemented in Phase 2 and is internally verified pending external
review; ordinary `run-experiment.sh` Host-owned automatic Session lifecycle is a
separate Phase 3 task, not supplied by this Campaign capability. See the
[current interface contract](STRUCTURED_RAM_AND_WORK_CONTROL.md), [Phase 2 task](WORK_CYCLE_PHASE2_IMPLEMENTATION_TASK.md), and
[Phase 3 Host Console task](WORK_CYCLE_PHASE3_HOST_CONSOLE_IMPLEMENTATION_TASK.md).

### 3.4 Stage and Task Results

A stage is not a model-written checkbox. It is a named criterion with one or
more Outcome references:

```json
{
  "stage_id": "stage-observe",
  "task_id": "task-001",
  "status": "success|failure|unknown|invalid|pending",
  "criterion_ids": ["..."],
  "outcome_ids": ["..."],
  "data_refs": ["..."],
  "next_stage": "stage-solve",
  "independence": {"required": false, "groups": []}
}
```

`pending` is a scheduler projection state only. The persisted Outcome remains
`unknown` until an Oracle judgment arrives. A correction appends a new Outcome
with `supersedes`; it does not create another independent attempt.

Task aggregation is deterministic:

- all required stages success + task criterion success -> task success;
- any required safety/authorization violation -> task invalid or blocked;
- unresolved required stage -> task unknown;
- task failure requires an Oracle-verified failed criterion, not a tool error;
- scheduler crash, timeout, missing log, or transport failure alone -> unknown;
- stage usefulness follows `data obtained -> data used by Action -> verified
  stage progress`, as already defined in `ARCHITECTURE_DECISIONS.md`.

Campaign aggregation must report both per-task facts and aggregate counts. It
must never convert “number of successful tasks” into a statistical claim about
Agent quality without a declared comparison design.

### 3.5 Unified Broker and Execution Adapter

All model-requested side effects enter one Action Broker:

```text
normalize arguments
  -> resolve registered capability
  -> check Campaign/Task authorization
  -> check state revision and relevant preconditions
  -> persist action.requested durably
  -> execute through adapter
  -> persist action.completed
  -> Oracle verifies postcondition
```

The Broker is not a shell parser and does not evaluate Experience text. A
registered capability binds:

- action id, version, implementation digest;
- data-only argument schema;
- allowed target and working directory;
- authorization class and network permission;
- timeout and retry policy;
- precondition recognizer;
- postcondition Oracle;
- idempotency/reconciliation behavior.

The user-confirmed first profile is the supervised, authorized macOS workspace.
It records argv/data arguments, explicit cwd, environment allowlist, timeout
and network policy through the existing Broker boundary. Workspace is not an
OS sandbox. A container-backed capability may be added in a later authorized
phase. `shell: true`, Experience shell text, host credentials and unregistered
binaries are not implicit permissions.

Read-only observation also has a target and cost boundary. “Read-only” is not
a license to read arbitrary credentials or leave the declared target.

### 3.6 Oracle Adapter Interface

An Oracle adapter is selected by a human-authored `oracle_ref` in the
Manifest. The model cannot select or implement one at runtime.

Conceptual interface:

```js
{
  id: "ctf.flag-oracle.v1",
  version: "1.0.0",
  scope: { domains: ["ctf"], environments: ["container"] },
  async observe(context) {},
  async judgeStep({ action, evidence, context }) {},
  async judgeStage({ stage, evidence, context }) {},
  async judgeTask({ task, stages, evidence, context }) {},
  async reconcile({ pendingAction, environment, context }) {},
  async close({ task, context }) {}
}
```

Every judgment returns structured data:

```json
{
  "status": "success|failure|unknown|invalid",
  "criterion": {"criterion_id": "...", "expected": "..."},
  "observed": {},
  "failure_mode": null,
  "evidence_refs": [],
  "oracle": {
    "oracle_id": "...",
    "version": "...",
    "independence_group": "...",
    "isolation_ref": "..."
  },
  "replayable": false
}
```

An adapter may return `unknown` and request later verification. It must not
read the model's final prose as proof. Platform results and human results enter
through an explicit independent-result adapter with provenance and evidence;
model self-report is not an independent source.

### 3.7 Acceptance Bundle for `gpt-6.1-sol`

A Campaign produces two outputs:

```text
campaign-report.json       # machine-readable, deterministic
campaign-report.md         # human-readable rendering
acceptance-bundle.json     # bounded input manifest for final reviewer
```

The acceptance bundle contains:

- Campaign Manifest digest and revision;
- implementation/runtime/model/Pi/ROM/tool/Oracle digests;
- task and stage status tables;
- all Outcome ids, statuses, Oracle ids, evidence refs, and supersedes links;
- action and session counts, budgets, retries, unknowns, and faults;
- queue/scheduler health and event-log integrity;
- experience decisions and whether any rule was used or promoted;
- A/B group metadata when applicable;
- explicit unsupported claims and missing evidence;
- paths/digests of bounded artifacts, never raw credentials or secrets;
- deterministic report generator version.

The final reviewer receives a review prompt that requires a structured verdict:
`accepted`, `rejected`, `inconclusive`, or `needs_more_evidence`, with findings
linked to bundle ids. The reviewer does not mutate the event log or Experience
store.

### 3.8 Stop, Recovery, and Fault Handling

The scheduler must distinguish these cases:

| Fault | Required behavior |
|---|---|
| Event append/fsync failure before action | fail closed; no Broker execution |
| Event failure after action may have run | pause side effects; reconcile through Oracle; no blind retry |
| Pi process exits while idle | restart from committed checkpoint and open a fresh Session |
| Pi exits during a tool call | mark action unknown/pending reconciliation; Oracle checks environment |
| Session creation fails | retain staged handoff; retry Host creation under budget; no `handoff.completed` |
| Oracle unavailable | persist unknown/pending verification; stop actions that require the result |
| Environment fingerprint changes | pause relevant bindings; re-observe and re-route |
| Budget exhausted | stop new actions; write terminal scheduler status and report |
| User cancellation | finish safe cleanup/reconciliation, then cancel; never claim task failure |
| Campaign process killed | atomic checkpoint + event replay on restart; recover lease after expiry |
| contradictory verified results | preserve history, mark conflict, stop affected route, request review |

Recovery is at-least-once at the scheduler level. It is not an exactly-once
claim for external side effects. A non-idempotent action with unknown result
must be reconciled before retry or escalated to a human.

### 3.9 Whiteboard and Web UI Observation Surface

The whiteboard is a read-only visualization of committed Aegis state. It is
not a new database, an authorization surface, or an execution API. Its data is
rebuilt from the Campaign event stream, Board projection, RuntimeState, queue
projection, and Oracle/Outcome projections.

The first UI should be a local Web UI because it reduces Pi/TUI integration
complexity while keeping the observation surface explicit. It must provide at
least:

- Campaign status, objective, authorization summary, budgets, and health;
- task queue grouped by `queued`, `running`, `waiting_oracle`, `paused`,
  `completed`, `unknown`, `failed`, and `cancelled`;
- dynamic task proposals, parent task, reason, admission status, scope checks,
  and rejection/block reason;
- current Task/Episode/Session, stage, state revision, and next bounded work;
- current effective Facts/Refuted/unknown/conflict items with evidence links;
- action timeline, pending reconciliation, handoffs, retries, and faults;
- Oracle results and data usefulness links;
- active/candidate/suspended Experience decisions and provenance;
- event-log/checkpoint integrity and last committed digest.

The UI must redact secrets and avoid unrestricted raw tool output. It must bind
only to localhost by default, use a private per-Campaign runtime directory,
and expose no endpoint that can mutate authorization, queue state, EventLog,
RuntimeState, or Experience. Any control action remains a typed Pi/Aegis
command with the existing authorization and audit path.

Pi should expose a built-in command surface for the same projection, for
example:

```text
/aegis board       # open or print the local read-only whiteboard URL
/aegis tasks       # open the task queue/distribution view
/aegis dashboard   # open the combined Campaign view
```

Command names may be finalized during implementation, but the command must
open/read the same committed projection as the Web UI; it must not create a
second view with different truth. When a browser cannot be opened, the command
prints the URL and keeps the Campaign running. The display path must never
block the scheduler or become a prerequisite for action execution.

## 4. Implementation Order

### Phase C0: Contracts and fixtures

- Add Campaign Manifest validation and canonical digesting.
- Add queue/task/stage projection types without changing the base four-object
  schema.
- Add a deterministic fixture Campaign with two tasks, dependencies, stages,
  and one delayed/unknown Oracle result.
- Add report and acceptance bundle schemas.

Acceptance: malformed manifests, missing scope, unknown adapters, task cycles,
invalid budgets, and task id collisions are refused before any Pi Session or
side effect starts.

### Phase C1: Durable single-Worker scheduler

- Add a single-process scheduler loop with one writer and a lease.
- Add queue transitions, budget accounting, checkpoint recovery, cancellation,
  and signal handling.
- Keep one Campaign event stream and task-scoped evidence directories.

Acceptance: kill/restart at every transition rebuilds the same queue state;
no task runs twice because of a stale checkpoint; unknown is preserved.

### Phase C2: Real Host-level Session supervisor

- Move Session ownership into the Host/scheduler integration.
- Use the real Pi SDK runtime/session creation path, not a test stub.
- Implement safe settle -> checkpoint -> new Session -> bind -> completion.
- Keep Observer as event collector and Runtime as state owner.

Acceptance: new Session object and context are different; Episode and budget are
continuous; failure/cancel leaves no false completion; handoff is idempotent.

### Phase C3: Brokered task execution and Oracle adapters

- Route every Campaign action through the existing ActionContract/Broker.
- Add one deterministic local adapter first, then the supervised macOS
  workspace adapter using the same Broker contract.
- Add one task Oracle and one delayed/platform-result adapter.
- Add reconciliation for interrupted actions.

Acceptance: direct Pi tools cannot bypass the Broker; log failure prevents
side effects; Oracle judgments are independent and resolver-visible; arbitrary
Experience text never becomes executable.

### Phase C4: Aggregation and acceptance output

- Project stage/task/Campaign results from committed events and Outcomes.
- Generate deterministic JSON, Markdown, and acceptance bundle.
- Add integrity, missing-evidence, unsupported-claim, and fault summaries.
- Add the final reviewer prompt and a local structural validator.

Acceptance: deleting derived projections and rebuilding from the event stream
produces the same report digest; the bundle contains no secrets; unsupported
claims are explicit.

### Phase C5: Campaign integration tests, then real capability tests

1. Offline fixture Campaign with fake Pi provider and deterministic Oracle.
2. Real Pi SDK/faux-provider Session rotation test.
3. Supervised macOS workspace Broker smoke test with no external target and
   explicit authorization Manifest.
4. Optional Linux-container adapter test only when that adapter is implemented
   and externally enforced.
5. Only after the required checks pass: a user-started CTF/penetration/learning
   Campaign.

A real Campaign must not be started merely because the fixture or individual
runtime tests pass.

## 5. Confirmed User Decisions

The following choices were confirmed by the user and apply to this
implementation. Routine implementation does not require asking again.

### D1. First real execution boundary — confirmed

The first supervised Campaign profile uses the **authorized macOS workspace**.
The user monitors the process and the task scope is explicitly authorized.
This does not make the workspace a sandbox: a macOS workspace can still reach
host files, credentials, processes, and network resources unless the Broker and
OS configuration restrict them. The Manifest must therefore record the exact
workspace, allowed targets, capabilities, network policy, and supervision
mode. The implementation must not advertise container-level isolation.

A later container adapter remains useful for high-risk or unattended testing,
but it is not a prerequisite for the first Campaign layer.

### D2. Campaign task model — confirmed bounded dynamic expansion

A Campaign starts with a manifest task list and may add dynamically derived
tasks. This is required for the intended long-running workflow. Dynamic tasks
are admitted automatically only inside the Manifest's restrictive envelope:
parent linkage, allowed task type, authorized target, existing adapters,
reserved budget, depth/fan-out/count limits, and explicit stop condition.

A model proposal cannot widen authorization, add a new target or adapter, turn
on network access, create credentials, or increase budget. Such a proposal is
shown on the whiteboard as blocked and requires human review outside the
ordinary queue. Every proposal, admission, dispatch, rejection, and completion
is visible on the whiteboard.

### D3. Automatic Session rotation — confirmed

The scheduler may rotate automatically only at safe idle/settled boundaries
and within budget. The model may request rotation, but it cannot force it, and
the Observer extension must not own the replacement lifecycle.

### D4. External result authority — confirmed

The precedence is:

```text
deterministic Oracle / platform adapter with evidence
  > explicitly reviewed human result with evidence
  > unknown
```

Model self-report and Pi exit status never qualify.

### D5. Acceptance model invocation — confirmed

Aegis must not automatically call `gpt-6.1-sol`. After coding and testing are
complete, the user will return to this conversation and provide the generated
Campaign data for analysis. Aegis still generates a deterministic report and
bounded acceptance bundle, but the bundle is an observation/hand-off artifact,
not an autonomous reviewer call.

### D6. Dynamic task creation during a Campaign — confirmed bounded core

Dynamic task generation is part of the core Campaign behavior. The Worker may
propose task decomposition or follow-up work, and Aegis may automatically
admit and dispatch proposals that pass the Manifest's restrictive policy.

The whiteboard must expose the full distribution process: proposal, parent,
reason, validation checks, admission/rejection, assigned Worker/Session,
budget reservation, current status, and Outcome. Human supervision observes
this stream and can cancel/pause the Campaign through the existing typed
control path. Observation does not turn model text into authorization.

### D7. Parallelism — confirmed

The first implementation has one active Task/Episode per Campaign. Parallel
research requires separate environments and separate event streams before a
merge protocol is designed.

## 6. Non-Goals for the First Implementation

- no arbitrary shell/eval path from Experience text;
- no claim that the authorized macOS workspace is a sandbox;
- no multi-worker shared mutable Episode or parallel execution in one Campaign;
- no automatic Experience promotion from Campaign completion alone;
- no statistical learning claim from one Campaign;
- no model-generated authorization or Oracle;
- no hidden copying of full transcripts into RAM;
- no automatic network access without a Manifest capability and explicit
  supervision/policy;
- no automatic `gpt-6.1-sol` invocation;
- no Web UI mutation API that bypasses typed Aegis commands and audit.
