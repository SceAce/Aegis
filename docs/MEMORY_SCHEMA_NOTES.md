# MEMORY_SCHEMA Notes: Runtime 1.1 Event/Source Extension

This file documents the **Aegis runtime extension** on top of
[`MEMORY_SCHEMA.md`](./MEMORY_SCHEMA.md). It exists because two runtime modules
(`shared/events.mjs`, `contest/outcome-bridge.mjs`) and the board
projection add fields, source kinds, and event types that are **not** part of
the base schema.

> **Compatibility is explicit, not implied.** This extension is **NOT labeled
> "schema 1.0 compatible" and must not be described as such.** It is a
> superset that a base §1.0 reader may or may not know. Unknown additive keys
> are safe to *ignore*, but the new **event types and source kinds are only
> understood by a runtime that implements this note**. A consumer that only
> implements MEMORY_SCHEMA §1.0 must reject an event type it does not know
> rather than guess at it (see "Reader rules" below).

## 1. Event schema versions

`Event -> Episode -> Outcome -> Experience` is the runtime's coordination
source. Each event carries a `schema_version` selected by its event type:

- **Legacy observer events keep schema `1.0`**: `session.started`,
  `session.shutdown`, `episode.started`, `episode.closed`, `agent.started`,
  `agent.ended`, `agent.settled`, `turn.started`, `turn.ended`,
  `message.completed`, `action.requested`, `action.completed`.
- **New runtime events use schema `1.1`**: `prompt.received`, `episode.paused`,
  `proposal.submitted`, `proposal.rejected`, `observation.captured`,
  `outcome.recorded`, `experience.decision`, `handoff.requested`,
  `handoff.rejected`, `handoff.completed`, `runtime.note`, `node.added`,
  `environment.changed`, `request.projected`.

`append` refuses an unknown event type unless the caller passes an explicit
`schema_version`, so a new type can never silently masquerade as 1.0.

### Reader rules

- A row with a schema **major** this build does not know (e.g. `2.0`) is
  **refused**, never guessed at (MEMORY_SCHEMA §2.1).
- A same-major minor/patch of a known major (e.g. `1.2`) is accepted.
- `KNOWN_SCHEMA_VERSIONS` is `{ "1.0", "1.1" }`.

## 2. Source kinds (compatibility extension)

MEMORY_SCHEMA §3.2 enumerates `agent`, `environment`, `observer`, `oracle`,
`replay`, `human`. The runtime adds **two explicit, documented** kinds:

| Kind | Meaning | Trust |
| --- | --- | --- |
| `runtime` | The trusted projection writer (episode/session/board bookkeeping). | Trusted for structure, **not** a task verdict. |
| `llm` | An untrusted model proposal (claim/hint/candidate). | Never verified. |

A kind outside this table is **refused at the append boundary**; the extension
is never a silent 1.0 value.

## 3. Outcome object: additive Runtime 1.1 fields

The `outcome.recorded` **event** is schema `1.1`, but the **Outcome object it
carries keeps `schema_version: "1.0"`** so a §5.2 consumer never sees a version
string it does not know. The additive fields live *alongside* the required §5.2
fields and are never a substitute for `status`/`observed`/`oracle`.

Additive fields (also summarized in MEMORY_SCHEMA §5.4):

| Field | Type | Description |
| --- | --- | --- |
| `requested_status` | enum | What the source row asked for before the runtime gate. Differs from `status` when downgraded to `unknown`. |
| `preconditions_verified` | boolean | Whether preconditions were independently verified. Defaults to `false` (unknown); never assumed. |
| `provenance` | object | `{source, independent, task_id, session_id, group, card, evidence_summary, recorded_note, row_digest, conflict?, supersedes?, superseding_note?}`. |
| `supersedes` | id | Present on a corrected import: the earlier `outcome_id` it replaces. |

### Effective view (`currentByType`) and `supersedes`

The board keeps **history** (`byType`, every node ever projected) and adds an
**effective** projection (`currentByType`) that answer a different question:
"what may the current request rely on?". Only the effective view enters the
RAM and a handoff; history stays for audit.

- `Outcome.supersedes` retires the named earlier Outcome from the **effective**
  view only. It is honoured only when the superseding event is trusted
  (not `llm`), in the same `episode_id`, and matches the prior Outcome's
  criterion / scope / subject with no supersede cycle. An invalid supersede is
  reported in `board.effective.invalid_supersedes` with a reason
  (`cycle`, `missing`, `llm`, `foreign`, `malformed`, `criterion_unconfirmed`,
  `criterion_mismatch`, `subject_mismatch`, `scope_mismatch`).
- A prior Fact retired by `supersedes` keeps `effective_status: "superseded"`
  and `superseded_by`. A superseding `unknown` retires the prior Fact and adds
  no Fact of its own (no lucky guess).
- `environment.changed` (trusted kinds only) marks same-scope Facts/Refuted
  nodes stale: they leave `currentByType` with `effective_status: "stale"` but
  are **never deleted**. The event itself projects as an `Artifact`. An `llm`
  `environment.changed` changes nothing.
- `request.projected` is a per-request audit row written by the observer's
  `context_with_system` handler. It records `ram_digest`/`state_version`/
  `board_digest`/`effective_digest` and `provider_bound` for the projected RAM.
  A normal row has `provider_bound: true`; a fail-closed projection refusal
  (for example `refusal_reason: "ram_overflow"`) has `provider_bound: false`.
  It creates **no** board node and does **not** bump `RuntimeState.version`, so it
  can never feed back into the next projection.
- RAM v2 adds `ram_version`, `ram_budget_chars`, `ram_overflow` and `ram_sections`
  (`id/total/shown/omitted`) to that diagnostic payload. `ram_estimated_chars`
  counts the complete RAM string including headings/counters/footer (UTF-16
  code units, not provider tokens). The transport remains one ephemeral user
  tail per provider request; it is not stored in the Session transcript.

## 4. Validation gates (what may become a verified board node)

1. **No inferred success.** A `success`/`failure` is accepted only when the row
   declares an independent source (`platform`/`oracle`/`human`) **and** a
   non-empty evidence reference. Otherwise it degrades to `unknown` with
   `failure_mode: insufficient_evidence`.
2. **Transport is not a verdict.** `timed_out=true` or `tool_ok=false` is
   recorded as `unknown`, never a task verdict.
3. **Failure ≠ refutation.** A general contest `failure` is a *task* failure.
   The `failure` status is preserved, but a `Refuted` board node requires
   **`preconditions_verified === true` AND `failure_mode === "postcondition_failed"`**.
   `postcondition_failed` alone, or a timeout, degrades to a `Hint`.
4. **Bare model text is never evidence.** Neither a tool exit code nor model
   prose creates a verified node.

### Fact/Refuted text contract

A `Fact`/`Refuted` node states the **proposition** that was verified
(`criterion.expected` plus the observed value), not a bare `outcome:<status>`
word. The provenance block carries the canonical source/independent fields.
Structured expected/observed values, including false/0/empty containers, have
bounded display rendering; identity dedup is by node/event/Outcome rather than
rendered prose. `observation.captured` nodes also carry a bounded
`observation_summary` of their recorded value. These display fields do not
change the existing verification gate.

### RAM v4: working-set registers

RAM v4 keeps the same ephemeral JSON transport and authority boundary, but the
model-facing object is a small working set instead of a repeated section dump.
`text` and `data` are the same JSON object. Top-level `task` always carries
`total_goal` plus the latest effective non-action Intent as `subgoal`; the model
sets that subgoal and its `scope` through the existing `aegis_propose
kind=intent` path. `claims` contains only recent claims matching the current
subgoal scope, while the mainline task remains visible in `task.total_goal`.
`facts` contains a bounded working set of current effective Fact/Refuted rows
with criterion/observed/evidence identity. Each class is ranked by total goal,
current prompt and subgoal relevance, then recency; the two classes are
interleaved up to six judgments. Unselected rows remain on the Board and are
reported by `meta.omitted.facts` and the per-class section counts. Character
budget compression shortens rows before dropping optional/large rows.
`references`
carries up to four selected knowledge cards (including cross-direction cards)
and external seeds with `verified=false` and `action_policy=none`. `rules` is
separate: active Experience/tool discipline only, `trust=rule` and
`not_authorization=true`; claims and references cannot be promoted into rules.
Aliases in `refs` are stable within an Observer process and Episode and are accepted in
`source_refs` both as bare strings and as `ref_id` values inside the canonical
ref object. Alias resolution is an association, not proof; the target event
must still have an effective Board node. `request.projected`/proposal
rejections record alias epoch/count for diagnosis.

`recent`/`referenced` retain the latest observation and a legally referenced
older action. `checkpoints` retains only the latest round checkpoint; older
round summaries remain in the EventLog and are not re-injected into RAM. `sections` is now a compatibility summary (`total/shown/omitted`)
rather than a second copy of the items; full history remains in Board/EventLog.
The default budget is 8,000 UTF-16 characters; `request.projected` records both
`ram_sections` and `ram_registers` summaries. See
[structured RAM and work control](STRUCTURED_RAM_AND_WORK_CONTROL.md).

### RAM v3: structured projection and explicit proposal associations

RAM v3 replaces the rendered Markdown body with a parseable JSON object. It
preserves separate facts/refutations, observed tool pairs and unverified
proposals, complete local ref identities, task/pending responsibility, state
revision and whole-output budget statistics. The request transport remains the
same ephemeral user tail. The v2 selection notes below describe the prior
baseline; the current interface is documented in
[structured RAM and work control](STRUCTURED_RAM_AND_WORK_CONTROL.md).

Text observations can add `response_fragments` with head/middle/tail samples,
redacted-text offsets, digest and explicit missing ranges. These are mechanical
views of text, with no HTTP/SQL/build/test/business interpretation. No wording
in a generic bash result creates a Fact, Outcome or workflow transition.

Explicit model proposals may bind event/node/action source refs from the
committed effective Episode prefix. `replace_event_id` only revises an accepted
effective same-Episode model proposal; it cannot revise Outcome or Fact.
Ordinary assistant text never becomes a proposal through inference.

Work control is carried by typed `runtime.note` payloads (`work-control-1`),
including candidate waiting and trusted resume/reject transitions. It projects
workflow state only, not an additional Outcome state. RAM displays its bounded
view; authorization and dispatch checks remain in the Runtime/Host/execute gates.

### Knowledge selections (additive Runtime 1.1 note)

`runtime.note` may carry `kind: knowledge.selected`, `version: knowledge-selection-1`. Only runtime/human sources project this note into an Artifact and replace the same Episode's `knowledge_selections`. The payload records mode, redacted query, bounded selected content, source URI/digest/line range, and retrieval limits/unavailability. Empty selections clear the current selection. Unknown note kinds retain their existing ignore behavior; this adds no event type or Outcome authority.

RAM v4 carries selected knowledge in `references` with `verified=false`, `action_policy=none` and selection-event refs. (v3 used `sections.knowledge`.) Board artifacts retain knowledge source refs; model candidate nodes retain `when/do/expect`, and accepted source refs produce graph associations. Current observations and unfinished responsibilities take priority over optional knowledge. Details and actual call timing are in [knowledge runtime](KNOWLEDGE_RUNTIME.md).

### Bounded tool observations and RAM selection (v2 baseline)

Observer `action.requested.input.summary` and
`action.completed.result_summary` contain `{value,truncated,redacted}`. They
retain normal structured tool parameters/details after recursive redaction and
limits (default 900 serialized characters, depth 4, 16 entries per container,
320 per string). Existing input keys/digest/path and text excerpt fields remain;
`content_truncated` marks capture loss. Raw tool responses still reach the
original Session continuation through the SDK; RAM contains a bounded summary.
Old records with no values cannot be reconstructed from digests. Windowed reads require overlap or a known length; reconstruction must be checked before use.

Board action nodes preserve input/response/result summary/transport and action
and event identity. Tool request/result pairs enter RAM as observed data, never
as independent task verdicts. Secret-pattern redaction is a bounded logging
policy, not proof that arbitrary secret-looking data can always be recognized.

RAM selection uses the current Episode's effective nodes only. It protects the
task/authorization/budget/pending/unknown core, then covers current facts,
refutations and tool observations before filling optional evidence. Within an
evidence class the newest item is retained first, then older support is ranked
by current-request words with recent order as a deterministic tiebreaker.
Identity and refs survive compact rendering; omissions/truncation are explicit.
Optional item caps and complete-output admission keep history bounded; only a
mandatory core that cannot fit can produce an explicitly marked overflow.
The existing provider request gate still enforces the whole request window.
See [implementation and verification](RAM_WORKING_MEMORY_REPAIR.md).

## 5. Idempotency, supersedes, and task binding (import boundary)

- **Idempotent import.** Importing the same `outcome_id` or `row_digest` again
  does **not** append a second `outcome.recorded` event, so a repeated import
  cannot inflate independence counts.
- **Supersedes, not duplication.** A later corrected result for the same
  task/session is recorded once with `supersedes: <previous outcome_id>` and a
  `superseding_note`. It is a correction, not a new independent attempt.
- **Strict task/session binding.** `/aegis outcome <task_id> [session_id]`
  imports only when `task_id` is the **current episode's own task** and, when
  given, `session_id` is one that actually recorded events for that episode.
  A mismatched task or a foreign session id is **refused** and writes nothing.
  A manual argument grants no cross-task write access.

## 6. What this note does NOT claim

- It does **not** declare the runtime events, source kinds, or Outcomes
  "1.0-compatible". They are a documented extension.
- The real `AgentSessionRuntime` path IS covered:
  `tests/aegis-observer-runtime-handoff.mjs` builds a real runtime, replaces
  the session via `runtime.newSession`, and asserts one `handoff.completed` per
  switch plus cancel/failure no-fake-success. The older
  `tests/aegis-observer-outcome-command.mjs` still exercises only the injected
  command seam; it is no longer the only handoff evidence.
- It does **not** treat tool exit codes, timeouts, or model self-report as task
  success.
