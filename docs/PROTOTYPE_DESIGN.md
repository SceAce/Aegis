# Prototype Design: Fixture Direct Loop (vertical slice)

Status: implementation plan for [`PROTOTYPE_TASK.md`](PROTOTYPE_TASK.md).
This is a deliberately small, single-process, offline slice. It does **not**
implement a general Aegis runtime, a workspace sandbox, multi-session
scheduling, habit/hint, or Pi internal changes.

## Goal of the slice

Demonstrate the minimum learning claim end to end:

1. two genuinely independent `live` fixture episodes (fresh reset + fresh event
   log each, trusted initial-state observation), then
2. a Compiler that promotes a **fixture-only** `active` Experience from that
   verified live evidence and a replayable registered action, then
3. a Router + Host that on a **third** fresh task hits the active Experience and
   executes the existing action primitive directly (no re-planning), with the
   Oracle verifying again.

A no-experience control task goes through the **same** authorization / execution
/ verification boundary and is reported for comparison.

## Trust and boundary model

- The **trusted runner** (Aegis Host) reads the real fixture file before the
  action, hashes it, and records it as an `observation.captured` event plus a
  `run.json` trusted run record. The Oracle uses this, **not**
  `manifest.initial_snapshot`, as the verified precondition.
- The **manifest** is task input only. The Oracle checks that the manifest's
  declared preconditions are consistent with the trusted observed state; a
  mismatch yields `invalid`.
- The **action primitive** is registered reviewed code (`fixture.unlock`), not
  shell/JS taken from Experience text. The Experience `do` only references the
  registered operation and a relative path template.
- All real file access is resolved strictly inside the per-task temporary
  fixture root, rejecting absolute paths, `..`, and symlink escapes.
- Oracle and runner keep producer/verifier separation: the Oracle independently
  reads final state and never trusts the agent's report text.

## Files

| File | Role |
| --- | --- |
| `Pi_Agent_base/memory/fixture/contracts.mjs` | Shared contract helpers: schema version, stable JSON, digest, predicate evaluation, event-chain validation, evidence-ref resolution, safe path resolution. |
| `Pi_Agent_base/memory/fixture/action-registry.mjs` | Registered deterministic action primitives. First primitive: `fixture.unlock`. Reviewed implementation, parameter schema, pre/postconditions. |
| `Pi_Agent_base/memory/fixture/host.mjs` | Trusted runner + Host. Creates a clean experiment dir, writes fixture, observes/hashes initial state, optionally asks the Router, records intent, executes the primitive through the broker, records `action.completed`, closes the episode. |
| `Pi_Agent_base/memory/fixture/oracle.mjs` | Independent Oracle. Validates event chain + trusted run record, verifies preconditions against observed state, distinguishes task success / transport success / failure / unknown / invalid, appends Outcome events, writes Event/Episode/Outcome projections. |
| `Pi_Agent_base/memory/fixture/compiler.mjs` | Compiles independent live projections into one fixture-only Experience. Enforces independence (distinct trusted run records), consistency, and replayability of the registered action; emits `active` only when gates pass. |
| `Pi_Agent_base/memory/fixture/router.mjs` | Read-only applicability check: active status, scope match, verified current preconditions, action whitelist, conflict detection. Never executes. |
| `Pi_Agent_base/memory/fixture/orchestrator.mjs` | Aegis-owned control flow: checks the Router before any model call. On a direct hit it runs Host+Oracle with no Pi session; on a `refuse` (conflicting matching active Experiences) it fails closed with no planner call and no execution; otherwise it calls an injected constrained Pi planner, then runs the same Host+Oracle. |
| `Pi_Agent_base/memory/fixture/demo.mjs` | The 2+1 offline demo: two independent live tasks → compile → third direct task + no-experience control. Writes an auditable `demo-report.json`. |
| `Pi_Agent_base/memory/fixture/README.md` | How to run the demo and tests, and the honest boundary. |
| `Pi_Agent_base/extensions/aegis-fixture-tool.ts` | Aegis-owned Pi extension: exactly one constrained tool (`aegis_fixture_unlock`), fail-closed scope guard, Host + Oracle routing, and a Pi-side audit trail. `AEGIS_FIXTURE_PLAN_ONLY=1` records the proposal without executing so the orchestrator can run Host+Oracle once. |
| `Pi_Agent_base/tests/fixture-direct-smoke.mjs` | Offline deterministic tests for positive promotion/hit, mismatch refusal, non-independent evidence, tampered pre-state/source events, action failure, unknown post-state, path escape, and append-only re-judgment refusal. |
| `Pi_Agent_base/tests/fixture-pi-integration.mjs` | Offline integration test: real Pi session (faux provider) calls the constrained tool, Host + Oracle execute and verify, direct route, and fail-closed denial. |
| `Pi_Agent_base/tests/fixture-pi-orchestrator.mjs` | Offline integration test for the route-before-model semantics on the same task: active Experience → 0 model requests/no Pi session; conflicting active Experiences → fail-closed `refuse` with 0 model requests, 0 tool executions and unchanged fixture; no Experience → constrained Pi session, ≥1 model request, Host+Oracle success. |
| `Pi_Agent_base/memory/fixture/real-model-ab.mjs` | Optional `--run-real`-gated real-provider A/B runner (not an offline test, never run automatically). Runs the same task with/without the compiled active Experience against real `relay`/`deepseek-v4.1-flash`, enforces `SessionManager.inMemory`, one constrained plan-only tool, no shell/edit/write/MCP/codemode, no project resources, at most two provider requests, and an Oracle (never model prose) success criterion. |
| `docs/PROTOTYPE_DESIGN.md` | This file. |

Existing `live-oracle.mjs`, `replay-oracle.mjs`, `compile-live-experience.mjs`
and their smoke tests are **not modified**; their contracts (Event / Episode /
Outcome / Experience field names and shapes) are reused. The replay-only
`--allow-replay-only-active` switch remains a replay-oracle test switch and is
not part of this live promotion path.

## Event vocabulary

Only existing `event_type` values are used. Router decisions are recorded as
`note` events (`payload.kind = "router.decision"`); the action uses
`action.requested` / `action.completed`; outcomes use `outcome.recorded`; the
episode lifecycle uses `episode.started` / `episode.closed`. No schema field or
enum is added.

## Trusted pre-state snapshot

After the Host reads and hashes the real fixture file, it persists an immutable
copy as `trusted-initial-state.json` next to the event log. The Oracle
independently re-hashes that snapshot and cross-checks it against the
`observation.captured` event and `run.json`. It does not re-read the (now
mutated) live fixture for the precondition, and it never uses
`manifest.initial_snapshot` as verified evidence.

## Environment note: crypto

The slice uses Node's built-in `node:crypto`: `createHash("sha256")` for the
event hash chain and content digests, and `randomUUID()` for ids. There is no
custom hash and no `Math.random()` id generator. Long hex strings may be redacted
from captured stdout, but the real digests are written to disk. The pre-existing
`live-oracle.mjs` / `compile-live-experience.mjs` are unchanged and still pass
their smoke tests.

## Honest boundary

The `demo.mjs` 2+1 slice runs as pure deterministic Node and does not itself drive
Pi's tool loop. A separate Aegis-owned bridge
(`Pi_Agent_base/extensions/aegis-fixture-tool.ts`) exposes exactly one constrained
tool to Pi and routes it through the same Host + Oracle. The offline
`Pi_Agent_base/tests/fixture-pi-integration.mjs` drives a real Pi session with a
faux provider and verifies the wiring, the direct route, and fail-closed denial.

That test does **not** prove learning or behavioral efficacy. A scripted faux
model only replays a tool call, so the evidence chain and direct safety are
verified, while the "an Experience improves planner behavior" claim still needs a
real or controlled-simulation planner on an experience-free branch plus a
correctness comparison. An optional real-provider A/B runner
(`memory/fixture/real-model-ab.mjs`) exists for that comparison and requires the
explicit `--run-real` flag. The reviewer subsequently ran it twice against the
configured relay, including after the isolated replay gate was added: both
smoke runs returned direct Oracle success with 0 provider requests and no-memory
Oracle success with 2 requests and 1 constrained tool call. This does not
establish statistical learning or transfer. The report must state: *fixture
direct demo passes; Pi tool-call integration verified; real-model learning/
behavior efficacy not proven.*

The fixture boundary (rejecting absolute paths, `..`, and symlink escapes) is
the real limit of this prototype. It does **not** claim general isolation for
bash, MCP, or third-party extensions, and cwd is not treated as a sandbox.

The Oracle writes outcome events append-only (confirmed append into the
hash-chained `events.jsonl`) and refuses a repeated judgment before writing, so
outcomes cannot be duplicated and re-judging cannot corrupt the chain.
