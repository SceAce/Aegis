# PI Implementation Task: Campaign Runtime

Status: **user-confirmed implementation task**.

User-confirmed Campaign decisions:

- first execution profile: supervised authorized macOS workspace; document
  honestly that this is not an OS sandbox;
- dynamic task expansion: enabled as a core feature, but only within strict
  Manifest limits; a model cannot widen authorization, target, adapter,
  network, credentials, or budget;
- Session rotation: Host/Scheduler may perform it automatically at safe
  idle/settled boundaries;
- result authority: deterministic Oracle/platform evidence, then evidenced
  human review, otherwise `unknown`;
- no automatic `gpt-6.1-sol` call; generate the report and acceptance bundle
  for the user to bring back to the current conversation;
- whiteboard and task-distribution visibility are required observation surfaces;
  provide a local Web UI and Pi built-in read-only commands for them;
- one active Task/Episode at a time in the first implementation.

This document defines the product requirements. The current master-DS entry
is `docs/DS_MASTER_PROMPT.md`; read it together with
`docs/AGENT_DEVELOPMENT_STANDARD.md`, `docs/AGENT_TESTING_STANDARD.md`,
`docs/DS_ORCHESTRATION_WORKFLOW.md`, and `docs/CAMPAIGN_CONTRACT_BASELINE.md`.
The master DS owns decomposition, shared tests, file ownership, implementation
review and integration. Receive one assignment, execute small dependent tasks.

Read `docs/CAMPAIGN_ARCHITECTURE.md` completely before changing code. This is
not a request to run a real CTF, penetration test, remote target or real-model
experiment. The current assignment closes C0 and implements C1, then returns
for external review; C2-C4a remain subsequent product phases.

## Prompt To PI

You are the implementation worker for Aegis. Use `dsv4.1flash` to write the
code and tests inside the current repository. Keep the existing architecture:

```text
Campaign
  -> Task queue
  -> Task / Stage / Episode
  -> Host-owned Pi Session windows
  -> Observer events and RuntimeState
  -> Router / Skill / Action Broker
  -> Execution Adapter
  -> Oracle Adapter
  -> Outcome / Board / Compiler
  -> deterministic report + gpt-6.1-sol acceptance bundle
```

The user wants one user-started long-running Campaign that Aegis can execute,
pause, recover, summarize, and hand to a final acceptance model. Implement the
Campaign layer only after understanding the current contracts in:

- `docs/CAMPAIGN_ARCHITECTURE.md`
- `docs/MEMORY_SCHEMA.md`
- `docs/MEMORY_SCHEMA_NOTES.md`
- `docs/ARCHITECTURE_DECISIONS.md`
- `docs/AEGIS_RUN_AND_ACCEPTANCE.md`
- `docs/PI_OBSERVER.md`
- `docs/OVERNIGHT_TASK.md`
- `THINK.md`
- `架构.md`

Do not weaken existing evidence gates, call model prose a result, or turn the
fixture demo into a general Campaign claim.

## Required Scope

Implement the following in order. Keep each phase independently testable.

### C0. Campaign contracts and validation

Add Aegis-owned Campaign modules under `Pi_Agent_base/` using existing Node/TS
patterns. The exact filenames may be chosen by the implementer, but the module
boundaries must remain visible and small.

Required capabilities:

- parse and validate `schema_version: "campaign-1.0"` manifests;
- canonical digest the immutable manifest;
- reject missing authorization, target, budget, task criteria, adapter refs,
  duplicate ids, task cycles, invalid dependencies, and unknown major versions;
- represent finite tasks, dependencies, stages, task budgets, session policy,
  execution adapter, Oracle adapter, and evidence policy;
- represent bounded dynamic task policy: allowed task types, parent linkage,
  target/capability restrictions, maximum depth/fan-out/count, derived budget
  reservation, and required stop condition;
- distinguish Campaign, Task, Stage, Episode, and Session identifiers;
- do not allow a model-provided value to create authorization, scope, Oracle,
  execution adapter, or budget permissions;
- persist the original manifest or an immutable content-addressed copy.

Add a deterministic fixture Campaign with at least:

- two tasks;
- a dependency from the second task to the first;
- at least two stages in one task;
- one successful stage and one `unknown`/delayed Oracle case;
- no network, credentials, remote targets, or real model calls.

### C1. Durable single-worker scheduler

Implement a single-process, single-active-task scheduler first. Do not add
parallel execution, shared mutable Episodes, or a distributed queue. The queue
itself must support bounded dynamic task expansion.

Required properties:

- durable queue transitions from the Campaign state machine;
- one event writer per Campaign stream;
- task-level and Campaign-level budget accounting;
- lease or single-writer protection against two schedulers mutating one
  Campaign;
- atomic checkpoint containing source event digest and projection version;
- rebuild queue state from the event log when the checkpoint is missing/stale;
- pause, resume, cancel, budget exhaustion, and graceful shutdown;
- signal/failure handling without silently marking a task successful;
- idempotent transition/recovery operations;
- clear distinction between scheduler failure, task failure, and Oracle result.

The scheduler must not rerun an action merely because the process died. If an
action may have executed but its result is missing, record pending/unknown
reconciliation and ask the Oracle adapter before retrying.

Dynamic task proposals are first-class observable queue inputs. A proposal must
include parent task/stage, goal, target, required capability, expected evidence,
budget reservation, priority, and stop condition. Aegis validates it against
the immutable Campaign authorization and admits it only when:

- target, tools, network policy, credentials policy, and Oracle are already
  authorized and registered;
- task type is in the allowed task policy;
- depth, fan-out, total task count, and total derived budget limits remain;
- it is not a duplicate or cycle;
- its scope and criteria are explicit and structurally valid.

A proposal that needs a new capability, target, adapter, permission, network
access, credential, or budget is blocked and surfaced to the whiteboard for
human attention. It must not be silently widened or executed.

### C2. Real Host-level Session rotation

Use the real Pi SDK runtime/session creation path. Do not use a fake
`newSession` callback as the only proof.

The Host/scheduler, not the Observer extension, owns Session lifecycle. At a
safe idle/settled boundary it must:

1. stop accepting new side effects;
2. wait for the current action/tool result boundary;
3. commit events and RuntimeState;
4. create a genuinely new Pi Session/Runtime object and context;
5. inject bounded RAM derived from committed state;
6. bind the new session to the same Campaign, Task, Episode, goal,
   authorization, stage, budget, effective facts, unknowns, and recovery state;
7. record one idempotent `handoff.completed` only after successful binding.

A failed or cancelled creation must leave the handoff staged and must not write
false completion. Session rotation must not create a new independent Episode
or reset the Campaign/task budget. The old transcript must not be silently
copied as the new context.

If the current Pi SDK seam cannot support this without changing Pi core, stop
and record the exact blocker and the smallest Host adapter needed. Do not fake
runtime replacement and do not modify the embedded Pi core without explicit
approval.

### C3. Unified Broker and adapters

Reuse the existing `ActionContract`, registry, authorization, and Broker
modules. Do not create a second execution path.

All Campaign actions must follow:

```text
normalize -> registered capability -> authorization -> state/precondition
-> durable action.requested -> adapter execution -> action.completed
-> Oracle verification -> Outcome
```

Add only deterministic test adapters first:

- an isolated local fixture adapter;
- an Oracle adapter that can return success, failure, unknown, and delayed
  verification;
- reconciliation for an interrupted action.

The Broker must bind action id/version/implementation digest, data-only
arguments, target/cwd, timeout, network policy, retry policy, and pre/post
checks. Experience text must never be evaluated as shell/JS. No arbitrary
model-generated executable, Oracle, or authorization.

The first Campaign execution profile is the user's supervised, authorized
macOS workspace. Do not claim that it is a sandbox. Record workspace, target,
capability, network, credential, and supervision scope in the Manifest. The
Broker remains the single Aegis action entry point even in this profile. A real
Linux container adapter can be added later and must be externally enforced.

### C4. Stage/task/Campaign aggregation and acceptance bundle

Add deterministic projections and writers for:

- stage status;
- task status;
- Campaign status;
- data obtained/used/useful contribution links;
- Oracle results, unknowns, corrections, supersedes, and conflicts;
- action/session counts and budget consumption;
- scheduler health, event integrity, retries, recoveries, and faults;
- Experience decisions and whether any active rule was actually used.

Rules:

- persisted Outcome remains `success|failure|unknown|invalid`;
- scheduler `pending` is only a projection state;
- transport failure is not task failure;
- a task is successful only when required stage criteria and the task Oracle
  criterion are successful;
- unresolved required evidence produces unknown;
- safety/authorization violations block or invalidate the task;
- corrections supersede prior Outcomes and do not increase independent count;
- Campaign aggregate counts do not become statistical claims automatically.

Write:

```text
campaign-report.json
campaign-report.md
acceptance-bundle.json
```

The acceptance bundle is a bounded, deterministic input for `gpt-6.1-sol`.
It must contain manifest/runtime/model/Oracle digests, task/stage tables,
Outcome and evidence references, faults, budgets, integrity status,
unsupported claims, and missing evidence. It must not contain credentials,
flags, secrets, or unrestricted raw tool output.

Also write a fixed reviewer prompt/template requiring one of:

```text
accepted | rejected | inconclusive | needs_more_evidence
```

The reviewer input is not allowed to mutate EventLog, Board, RuntimeState, or
Experience storage. Do not invoke `gpt-6.1-sol` automatically. The output is
for the user to bring back to the current conversation after implementation
and tests.

### C4a. Whiteboard and local Web UI

Add a read-only local Web UI backed by the same committed projections used by
reports. It must show Campaign status, task queue, dynamic task proposals and
admission checks, current stage/Episode/Session, budget, action timeline,
Oracle results, unknowns, conflicts, handoffs, faults, and Experience
selection/provenance.

The UI must bind to localhost by default, redact secrets, use a private
Campaign runtime directory, and expose no direct mutation endpoint. It must not
become a scheduler dependency. If the browser cannot be opened, print the URL
and continue.

Add Pi built-in commands, with exact names chosen and documented by the
implementer, for example:

```text
/aegis board       # open/print the read-only whiteboard
/aegis tasks       # open/print task distribution and dynamic queue
/aegis dashboard   # open/print the combined Campaign view
```

These commands must read the same committed projection as the Web UI. They are
observation commands, not a second state source and not an authorization
bypass. Any pause/cancel control must use existing typed Aegis control and
Audit paths.

## Required Fault Matrix

Add tests for every row:

| Fault | Expected behavior |
|---|---|
| append/fsync failure before action | fail closed; Broker not called |
| log failure after possible action | pause side effects; reconcile; no blind retry |
| Pi exits while idle | recover from committed checkpoint with fresh Session |
| Pi exits during tool call | pending/unknown reconciliation; no assumed success |
| Session creation failure | staged handoff remains; no completed event |
| Oracle unavailable | unknown/pending verification; dependent actions stop |
| environment fingerprint changes | affected route pauses and re-observes |
| task/Campaign budget exhausted | no new action; terminal report records budget stop |
| user cancellation | safe cleanup/reconciliation; no invented failure |
| process killed/restarted | event replay rebuilds queue deterministically |
| contradictory verified Outcomes | preserve history; mark conflict; stop affected route |
| duplicate scheduler | one writer/lease prevents concurrent mutation |
| stale checkpoint | ignored/rebuilt from event source |

## Required Test Layers

Do not replace product tests with only direct library tests.

1. **Contract tests**: Manifest, queue state, dependency/cycle, bounded
   dynamic task proposal/admission/rejection, stage/task aggregation, report
   schema.
2. **Deterministic scheduler tests**: every queue transition, dynamic expansion
   limits, restart at every transition, checkpoint corruption, duplicate
   commands, cancellation, budgets, and fault matrix.
3. **Real Pi SDK/faux-provider tests**: real Session/runtime objects, at least
   one genuine handoff, fresh context, same Episode, no false completion on
   failure/cancel.
4. **Broker/Oracle integration tests**: action intent persisted before effect,
   postcondition independently judged, unknown preserved, reconciliation avoids
   duplicate non-idempotent execution.
5. **Rebuild tests**: delete derived queue/report/projection files and rebuild
   from committed event input; compare canonical digests.
6. **Regression tests**: run all existing Aegis tests listed in
   `docs/AEGIS_RUN_AND_ACCEPTANCE.md` and do not weaken assertions.

A faux provider is acceptable for offline tests. A test that only asserts a
returned string is insufficient where a side effect, Session replacement,
queue recovery, or evidence boundary is claimed.

## Explicit Non-Goals

Do not implement or claim:

- real CTF, penetration, remote target, or network testing;
- arbitrary shell/eval from Experience text;
- distributed or parallel multi-worker Campaigns;
- unrestricted task creation from model prose;
- automatic Experience promotion from Campaign completion;
- host-level sandboxing merely from cwd/workspace;
- statistical learning efficacy from the deterministic fixture;
- direct modification of embedded Pi core, auth, model settings, or lockfile;
- automatic invocation of `gpt-6.1-sol`;
- a second independent Event/Outcome/Experience schema.

## Required Implementation Workflow

Follow `docs/DS_ORCHESTRATION_WORKFLOW.md` and `docs/AGENT_TESTING_STANDARD.md`.
Before editing, record the baseline, frozen interfaces, subtask dependency graph,
file owners and requirement-to-test matrix. Generate and review executable
positive/negative/boundary/ownership/recovery tests before product changes.

For every subtask, implement within its file scope, run focused checks, have
the master DS review the final diff and callers, then integrate and run the
necessary regression checks. Preserve honest synthetic/faux/real-process
boundaries. A same-model child review is useful but not independent acceptance.

Close C0 before C1 product code. The current master assignment may progress
through C1-A to C1-E without asking the user for every implementation step.
After C1, stop for external review. C2-C4a are later phases. Keep raw development
logs private and put plans, test mappings and review conclusions in docs.

Existing architecture-changing requirements must be resolved explicitly;
routine fixes, names and interface implementations already authorized by the
contract do not require repeated approval.

Do not silently broaden scope because a fixture is convenient. If a requirement
cannot be proven, leave it as an explicit failing test or documented blocker.

## Required Final Report

Return a machine-readable and human-readable report containing:

- files changed;
- phases completed;
- commands run and exact pass/fail status;
- tests that use real Pi SDK objects;
- tests that are faux/deterministic only;
- fault matrix coverage;
- event/report rebuild results;
- known blockers and architecture decisions needed;
- explicit statements of what the work does **not** prove.

The final report must not say “long-running real Campaign support complete”
unless C0-C4 and the real Host-level Session test are all green. A fixture-only
pass must be labeled fixture-only.
