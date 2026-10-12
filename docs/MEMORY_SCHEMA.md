# Aegis Memory Schema

Version: `1.0`

This document is the first implementation contract for the memory loop:

```text
Event -> Episode -> Outcome -> Experience
```

The objects have different meanings and different write permissions. A tool
exit code is transport evidence; it is not by itself a task result. A single
successful attempt is an observation about one episode; it is not yet a
portable experience.

### Compatibility with earlier design notes

Some earlier notes used a six-layer vocabulary (`Claim / Verdict / Rule /
Policy`). The implementation contract in this document keeps the requested
four persisted objects and maps the older names as follows:

| Earlier name | Current representation | Meaning |
| --- | --- | --- |
| `Claim` | `Event.payload` with `observation_kind: claim` | Agent or worker statement, not yet verified |
| `Verdict` | `Outcome` | Oracle judgment over a criterion |
| `Rule` | `Experience` | Compiled conditional rule with provenance |
| `Policy` | Runtime projection of active Experience | Current-task action gate; not a long-term memory object |

This mapping is intentionally one-way: a claim does not become an outcome by
being repeated, and a policy projection does not rewrite its source experience.

## 1. Design Rules

1. **Events are the audit source.** Events are append-only and immutable. Every
   projection must be rebuildable from them.
2. **Episodes are bounded attempts.** An episode has one goal, one environment
   scope, an authorization boundary, and a lifecycle.
3. **Outcomes are oracle judgments.** `success`, `failure`, `unknown`, and
   `invalid` are deliberately separate. `unknown` is not a failure.
4. **Experiences are compiled rules.** An experience is a conditional rule
   supported by independently judged outcomes. It is not a prose summary of a
   transcript.
5. **Claims are not facts.** Agent or WP statements remain evidence claims
   until an oracle verifies the relevant condition or postcondition.
6. **Provenance is mandatory.** A derived object must identify its source
   events/outcomes and the oracle or compiler that produced it.
7. **Scope is mandatory for reusable knowledge.** An experience that does not
   state its environment and authorization scope cannot become active.

The canonical storage arrangement is an append-only event log plus derived
projections. JSONL is sufficient for the first replay implementation; SQLite
or another index can be added later without changing these objects.

## 2. Common Types

The following notation is used below:

| Notation | Meaning |
| --- | --- |
| `string` | UTF-8 string, non-empty unless marked optional |
| `id` | UUID or ULID; stable and unique within the Aegis installation |
| `timestamp` | RFC 3339 UTC timestamp, for example `2026-09-28T08:00:00Z` |
| `digest` | Lowercase SHA-256 hex digest of canonical JSON or an artifact |
| `JsonValue` | JSON scalar, array, or object; never executable code |
| `Ref[]` | Non-empty array of object references when required |

Every object has a `schema_version` field. Readers must reject an unknown major
version instead of guessing field meanings.

### 2.1 Reference and scope types

```json
{
  "ref_type": "event",
  "ref_id": "evt_01J...",
  "digest": "sha256:..."
}
```

`digest` is optional for an ordinary local reference and required when the
reference crosses a replay/export boundary.

```json
{
  "environment_fingerprint": "env_sha256:...",
  "domain": "linux.heap",
  "runtime": {"os": "linux", "arch": "x86_64", "libc": "glibc-2.35"},
  "target": "heap_allocator",
  "permissions": ["process-local", "read-only-observation"],
  "task_types": ["reproduce", "verify"],
  "valid_from": "2026-09-28T08:00:00Z",
  "valid_until": null
}
```

Scope fields are exact-match constraints unless a field explicitly declares a
range or pattern. An absent value means unknown, not "any value".

## 3. Event

### 3.1 Meaning

An **Event** records one normalized occurrence emitted by the runtime,
environment adapter, observer, replay driver, or oracle. It does not interpret
what the occurrence means for a goal. An event can contain a worker claim, but
the claim remains unverified until an `Outcome` references an oracle judgment.

### 3.2 Fields

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `schema_version` | yes | string | Event schema version, currently `1.0` |
| `event_id` | yes | id | Immutable event identity |
| `event_type` | yes | enum | `session.started`, `session.shutdown`, `episode.started`, `observation.captured`, `action.requested`, `action.completed`, `agent.started`, `agent.ended`, `agent.settled`, `turn.started`, `turn.ended`, `message.completed`, `boundary.changed`, `outcome.recorded`, `episode.closed`, `note` |
| `episode_id` | yes for episode events; `null` for session events | id or null | Episode containing the event |
| `sequence` | yes for episode events; `null` for session events | integer or null | Monotonic sequence within the episode, starting at 0 |
| `occurred_at` | yes | timestamp | Time at which the event happened |
| `recorded_at` | yes | timestamp | Time at which Aegis persisted it |
| `source` | yes | object | `{actor_id, kind, adapter, version}`; `kind` is `agent`, `environment`, `observer`, `oracle`, `replay`, or `human` |
| `payload` | yes | JsonValue | Type-specific data; payload is data, never a command to execute |
| `correlation_id` | yes | id | Groups events from one attempt |
| `causation_id` | optional | id | Event that directly caused this event |
| `evidence_refs` | yes | Ref[] | Artifacts or prior events supporting this event; may be empty for `episode.started` |
| `prev_event_digest` | optional | digest | Hash-chain link within an append-only stream |
| `event_digest` | yes | digest | Digest of the canonical event without `event_digest` itself |

`action.completed.payload` should include transport facts such as
`tool_name`, `exit_code`, `timed_out`, `duration_ms`, and output artifact
references. These fields describe execution, not goal achievement.

`observation.captured.payload` should distinguish:

```json
{
  "observation_kind": "claim",
  "subject": "allocator",
  "predicate": "safe_linking",
  "value": false,
  "source": "worker_report"
}
```

The observer may normalize this claim, but must not silently promote it to a
verified fact.

### 3.3 Event invariants

- `event_id` is never reused and an existing event is never overwritten.
- `sequence` is unique within an episode; duplicate delivery is handled by
  idempotent `event_id` insertion.
- `action.completed` must reference its `action.requested` event through
  `causation_id` or an explicit `action_id` in the payload.
- An event with a missing or invalid digest is rejected at the event-log
  boundary.
- Raw event payloads must not contain credentials or unrestricted secrets;
  sensitive output is stored as a redacted artifact reference.

## 4. Episode

### 4.1 Meaning

An **Episode** is one bounded attempt to satisfy one goal. It is the unit used
to compare attempts and to count independent evidence. A tool invocation is a
step inside an episode, not an episode by itself.

WP material can be used as a `teacher_replay` episode. The replay driver may
follow the WP action sequence without rediscovering it, but every action still
executes against the selected environment and every expected postcondition is
checked independently. WP text is provenance, not automatic truth.

### 4.2 Fields

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `schema_version` | yes | string | Episode schema version, currently `1.0` |
| `episode_id` | yes | id | Stable episode identity |
| `status` | yes | enum | `active`, `completed`, `aborted`, `invalid` |
| `source_kind` | yes | enum | `live`, `teacher_replay`, `human_demo`, `simulation`, or `counterfactual` |
| `goal` | yes | object | `{goal_id, description, success_criteria[]}` |
| `authorization` | yes | object | Allowed tools, targets, time/token budget, and side-effect boundary |
| `environment` | yes | object | Environment fingerprint and scope at episode start |
| `started_at` | yes | timestamp | Episode start |
| `ended_at` | required when terminal | timestamp | Episode end |
| `event_ids` | yes | id[] | Ordered event IDs; event log remains canonical |
| `steps` | yes | object[] | Ordered step references with action and step outcome IDs |
| `episode_outcome_id` | required when terminal | id | Episode-level outcome, including `unknown` when unresolved |
| `parent_episode_id` | optional | id | Parent episode for a bounded subtask |
| `provenance` | yes | object | Source documents, replay fixture, adapter, and version |
| `episode_digest` | yes | digest | Digest of canonical episode projection |

Each `steps[]` entry has:

```json
{
  "step_id": "step_01J...",
  "index": 0,
  "action_event_id": "evt_action...",
  "observation_event_ids": ["evt_obs..."],
  "step_outcome_id": "out_step..."
}
```

An episode may end with `unknown` when the environment did not provide enough
evidence. It must not manufacture a failure merely because a timeout or tool
error occurred.

### 4.3 Episode lifecycle

```text
active -> completed
active -> aborted
active -> invalid
```

The transition to `completed` requires a terminal `episode_outcome_id`.
`aborted` means the run stopped before the goal could be judged; its outcome is
normally `unknown`. `invalid` means the episode cannot be used as evidence,
for example because authorization or schema integrity was violated.

## 5. Outcome

### 5.1 Meaning

An **Outcome** is a judgment about a criterion at either step or episode level.
The judgment is produced by an oracle or an explicitly identified human
reviewer. It records expected and observed postconditions and the evidence used
to compare them.

### 5.2 Fields

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `schema_version` | yes | string | Outcome schema version, currently `1.0` |
| `outcome_id` | yes | id | Stable outcome identity |
| `level` | yes | enum | `step` or `episode` |
| `episode_id` | yes | id | Owning episode |
| `step_id` | required for step | id | Owning step |
| `status` | yes | enum | `success`, `failure`, `unknown`, or `invalid` |
| `criterion` | yes | object | `{criterion_id, description, expected}` |
| `observed` | yes | JsonValue | Oracle-observed state or value; can be `null` only for `unknown` |
| `oracle` | yes | object | `{oracle_id, method, version, independence_group}` |
| `evidence_refs` | yes | Ref[] | Logs, state snapshots, tests, or replay artifacts |
| `transport` | yes | object | `{tool_ok, exit_code, timed_out, duration_ms}`; never substitutes for `status` |
| `failure_mode` | required for failure/unknown | enum | `precondition_unmet`, `action_rejected`, `tool_error`, `timeout`, `postcondition_failed`, `environment_changed`, `budget_exhausted`, or `insufficient_evidence` |
| `reproducibility` | yes | object | `{replayable, replay_hash, replay_count, checked_at}` |
| `assessed_at` | yes | timestamp | Judgment time |
| `supersedes` | optional | id | Earlier outcome replaced by a corrected judgment |

`success` means the criterion's expected postcondition was verified. `failure`
means the preconditions were satisfied and the oracle reliably negated the
postcondition. `unknown` means the evidence is insufficient. `invalid` means
the judgment itself cannot be used, such as an unauthorized or malformed run.

The following distinctions are mandatory:

| Observation | Correct outcome treatment |
| --- | --- |
| Tool returned non-zero | Usually `unknown` or a transport `tool_ok=false`; inspect failure mode |
| Preconditions were not met | `unknown` with `precondition_unmet`; do not refute the action |
| Timeout with no state observation | `unknown` with `timeout` |
| Postcondition was observed to be absent after valid execution | `failure` with `postcondition_failed` |
| Goal state was independently observed | `success` |

### 5.3 Outcome invariants

- A `success` or `failure` outcome must have at least one evidence reference and
  an oracle method that can be rerun or audited.
- A negative outcome cannot be compiled into a negative rule unless its
  precondition is verified and its failure mode is consistent with the rule.
- An `unknown` outcome contributes to uncertainty counts but never to either
  success or failure counts.
- A step outcome may be revised by a later oracle run; the original remains in
  the event log and the new outcome uses `supersedes`.

### 5.4 Runtime 1.1 additive fields (Observer/contest bridge)

The full compatibility contract for the runtime extension (event schema 1.1,
the `runtime`/`llm` source kinds, and these additive fields) lives in
[`MEMORY_SCHEMA_NOTES.md`](./MEMORY_SCHEMA_NOTES.md). It is an **explicit
extension, not a claim that the base schema 1.0 is "fully compatible"**.

The runtime emits Outcomes that are a strict superset of §5.2. The Outcome
object itself keeps `schema_version: "1.0"` so a §5.2 consumer never sees a
version it does not know. The additive fields live alongside the required ones;
they are never a substitute for `status`/`observed`/`oracle`.

| Field | Type | Description |
| --- | --- | --- |
| `requested_status` | enum | What the source row asked for before the runtime gate (e.g. `success`). Differs from `status` when the row was downgraded to `unknown`. |
| `preconditions_verified` | boolean | Whether the preconditions for the attempt were independently verified. Defaults to `false` (unknown) and is never assumed from a bare status. A `failure` may only become a `Refuted` board node when this is `true` AND `failure_mode` is `postcondition_failed`. |
| `provenance` | object | `{source, independent, task_id, session_id, group, card, evidence_summary, recorded_note, row_digest, conflict?, supersedes?, superseding_note?}`. `independent` is true only when the source is not the model, an exit code, or `agent_settled`. |
| `supersedes` | id | Present on a corrected import: the earlier `outcome_id` this judgement replaces. A correction is NOT a new independent attempt and never inflates independence counts. |

The runtime NEVER infers `success`, never invents evidence, and never marks a
result independent without the source row saying so. A transport failure
(`timed_out=true`, `tool_ok=false`, `tool_error`) is recorded as `unknown` and
is never a verdict. A general contest `failure` is a task failure only; it
becomes `Refuted` only when the postcondition was genuinely observed to fail
(`failure_mode: postcondition_failed`) AND the preconditions were verified
(`preconditions_verified: true`).

Importing a contest result is idempotent: the same `outcome_id`/`row_digest` is
never appended twice, so a repeated import cannot inflate independence. A later
corrected result for the same task/session is recorded once with `supersedes`
provenance instead of masquerading as a second attempt. The `/aegis outcome
<task_id> [session_id]` command binds strictly to the CURRENT episode: a task id
that is not the episode's own task, or a session id that did not record events
for that episode, is refused and writes nothing.

A contest **card** injected as a hint is a routing decision
(`experience.decision`), not an active Experience. It is recorded with
considered/matched/rejected/selected reasons and its card provenance
(`cards_path`, `cards_digest`, `cards_loaded`); it remains a Hint.

## 6. Experience

### 6.1 Meaning

An **Experience** is a compiled, conditional rule that can guide a later
episode. It has the minimal form:

```text
when condition C is verified
do action A
expect postcondition P
within scope S
```

An experience is a projection over outcomes, never a replacement for them.
Keeping outcome provenance makes a rule reversible when the environment changes
or a later counterexample appears.

### 6.2 Fields

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `schema_version` | yes | string | Experience schema version, currently `1.0` |
| `experience_id` | yes | id | Stable rule identity |
| `status` | yes | enum | `candidate`, `active`, `suspended`, or `retired` |
| `when` | yes | object[] | Normalized predicates; each has `{path, op, value, verified_by[]}` where refs must identify an authoritative observation or outcome |
| `do` | yes | object | Action template `{tool, operation, arguments_template, risk_class}` |
| `expect` | yes | object[] | Required postconditions; each has `{path, op, value}` |
| `scope` | yes | object | Environment, target, permission, and task-type constraints |
| `support` | yes | object | Outcome references and counts for independent evidence |
| `provenance` | yes | object | Compiler, source outcomes, source episodes, and source kind |
| `validation` | yes | object | Last validation, replay hash, and conflict information |
| `revision` | yes | integer | Starts at 1 and increments for rule changes |
| `created_at` | yes | timestamp | Creation time |
| `updated_at` | yes | timestamp | Last status or rule update |

The `support` object has:

```json
{
  "success_outcome_ids": ["out_ep_..."],
  "failure_outcome_ids": [],
  "unknown_outcome_ids": [],
  "independent_episode_count": 2,
  "success_count": 2,
  "failure_count": 0,
  "unknown_count": 0
}
```

`provenance` must include `compiled_by`, `compiler_version`,
`source_outcome_ids`, `source_episode_ids`, and `compiled_at`. The source kind
must retain whether evidence came from `teacher_replay`, `live`, `human_demo`,
or `simulation`.

### 6.3 Experience lifecycle and evidence gates

```text
candidate -> active
candidate -> retired
active -> suspended
suspended -> active
suspended -> retired
```

The worker or LLM may propose a `candidate`, but cannot directly write
`active`. The compiler/oracle gate applies these initial thresholds:

- **Positive active rule:** at least two independent episodes, verified
  preconditions, verified postconditions, replayable evidence, and no unresolved
  scope conflict. At least one validation should use the current environment,
  unless the experiment explicitly declares a replay-only scope.
- **Negative rule:** at least two independent failures with verified
  preconditions, the same failure mode, no success in the same scope, and a
  counterexample check. A single failed attempt never retires a method.
- **Suspension:** a scope fingerprint changes, a conflicting verified outcome
  appears, or replay fails. Suspension blocks automatic use while retaining the
  rule and its provenance.
- **Retirement:** the rule is explicitly contradicted by verified evidence or
  its scope is permanently invalidated. Retirement is reversible only by a new
  revision with new evidence.

These thresholds are configuration, but relaxing them must be visible in the
experiment record. Counts alone are not confidence; independence and oracle
quality are required.

## 7. Minimal JSON Example

The file [`docs/examples/memory-teacher-trace.json`](examples/memory-teacher-trace.json)
contains one complete teacher-replay fixture. Its important shape is:

```json
{
  "events": [
    {
      "schema_version": "1.0",
      "event_id": "evt_demo_action_1",
      "event_type": "action.requested",
      "episode_id": "ep_demo_1",
      "sequence": 1,
      "occurred_at": "2026-09-28T08:00:01Z",
      "recorded_at": "2026-09-28T08:00:01Z",
      "source": {"actor_id": "replay-driver", "kind": "replay", "adapter": "fixture", "version": "1"},
      "payload": {"action_id": "act_1", "tool_name": "fixture", "operation": "unlock"},
      "correlation_id": "ep_demo_1",
      "evidence_refs": [],
      "event_digest": "sha256:fixture"
    }
  ],
  "episodes": [],
  "outcomes": [],
  "experiences": []
}
```

The fixture intentionally contains one `unknown` outcome in addition to a
successful teacher replay. A replay consumer must preserve that uncertainty and
must not count it as a failure.

## 8. Replay and Learning Verification

The first experiment does not ask the agent to rediscover a WP path. It asks
whether verified experience changes later behavior.

Run the same task family under four conditions:

| Condition | Injected memory | Purpose |
| --- | --- | --- |
| A | None | No-memory baseline |
| B | Raw episodes only | Diagnostic value of transcript recall |
| C | Compiled active experiences | Formal learning condition |
| D | Stale or deliberately wrong experiences | Negative-transfer and suspension check |

Use at least these task groups:

1. Same mechanism with different parameters.
2. Same mechanism with a different surface form.
3. Environment or version change.
4. Similar-looking task where the rule does not apply.

Record these metrics per condition:

- goal success rate and attempts to success;
- tool calls, elapsed time, and token cost;
- experience activation rate and success after activation;
- false activation rate and negative transfer rate;
- time from environment change to rule suspension;
- proportion of outcomes with replayable evidence;
- performance delta when active experiences are disabled.

The minimum learning claim is met only when C improves the held-out task groups
over A, does not produce unacceptable D-style negative transfer, and the gain
disappears when the experience projection is disabled. Merely increasing the
number of stored records is not evidence of learning.

## 9. Live Oracle manifest

A live experiment keeps its task-specific oracle declaration beside the raw
event log as `manifest.json`. The manifest is experiment input, not memory. It
must declare:

```json
{
  "schema_version": "1.0",
  "experiment_id": "live-baseline-...",
  "source_kind": "live",
  "goal": {"goal_id": "unlock_fixture", "description": "...", "success_criteria": ["..."]},
  "authorization": {"allowed_tools": ["read", "edit"], "target": "...", "side_effects": "fixture-only"},
  "environment": {"environment_fingerprint": "live-fixture-v1", "domain": "fixture", "permissions": ["fixture-only"]},
  "state": {
    "format": "json",
    "path": "fixture/door.json",
    "initial_snapshot": {"locked": true},
    "preconditions": [{"path": "locked", "op": "eq", "value": true}],
    "postconditions": [{"path": "locked", "op": "eq", "value": false}]
  },
  "action": {"tool_names": ["edit"], "target_path": "fixture/door.json", "operation": "edit", "risk_class": "low"}
}
```

`live-oracle.mjs` resolves relative paths against the experiment directory,
rejects state files outside that directory, validates the raw event hash chain,
and independently reads the declared JSON state. Transport success is taken
from `action.completed`; task success is taken only from the postcondition
check. Missing state or missing action evidence produces `unknown`.

## 10. Storage and Write Boundaries

| Object | Canonical writer | Mutable? | Directly usable for action selection? |
| --- | --- | --- | --- |
| Event | Observer/runtime | no | no |
| Episode projection | Runtime/replay driver | lifecycle projection only | no |
| Outcome | Oracle or authorized human reviewer | superseded, never overwritten | no |
| Experience | Compiler after evidence gates | revisioned status | yes, when `active` and scope matches |

Raw events must remain available for replay. Forgetting or retention policies
may remove a retrieval projection, but they must not silently rewrite the event
or outcome provenance required to audit an experience.
