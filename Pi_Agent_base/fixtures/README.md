# Fixture direct vertical slice

Status: runnable offline prototype for [`docs/PROTOTYPE_TASK.md`](../../../docs/PROTOTYPE_TASK.md).
See [`docs/PROTOTYPE_DESIGN.md`](../../../docs/PROTOTYPE_DESIGN.md) for the design
and the honest boundary.

## What it demonstrates

The minimum learning claim end to end, in one process, with no model calls and no
network:

1. two genuinely independent `live` fixture episodes (fresh reset, fresh event
   log, trusted initial-state observation each),
2. a Compiler that promotes a **fixture-only** `active` Experience only from
   verified independent live evidence plus the registered `fixture.unlock`
   primitive,
3. a third fresh task where the Router hits the active Experience and the Host
   executes the existing action primitive directly (no re-planning), then the
   Oracle verifies again,
4. a no-experience control task through the same authorization / execution /
   verification boundary, reported for comparison.

## Run the demo

```bash
node Pi_Agent_base/fixtures/demo.mjs
# optional fixed work dir:
node Pi_Agent_base/fixtures/demo.mjs --work /tmp/aegis-demo
```

It prints a summary and writes `demo-report.json` under the work directory
(`--work DIR` or a fresh temp dir), which records, for every step, whether the
replayable Experience was actually hit and which action ran.

## Run the tests

```bash
node Pi_Agent_base/tests/fixture-direct-smoke.mjs
```

Offline and deterministic. Covers: positive promotion + direct hit;
non-independent evidence stays `candidate`; scope and precondition mismatch;
conflicting active experiences; tampered run record / missing trusted snapshot /
tampered source event; transport timeout and missing post-state (never
`success`); unmet precondition; path traversal and symlink escape; a failed
episode blocking activation; and evidence-ref resolvability.

## Pi integration (offline, faux provider)

The Node demo above is intentionally Pi-free. A separate thin bridge exposes the
fixture slice to Pi:

| File | Role |
| --- | --- |
| `Pi_Agent_base/extensions/aegis-fixture-tool.ts` | Aegis-owned Pi extension. Registers exactly one tool, `aegis_fixture_unlock`, whose only accepted argument is `path` and whose only accepted value is `door.json`. A `tool_call` guard fails closed on every other tool, extra parameter, traversal attempt, or other path. The tool body routes through the existing Host (`runFixtureTask` → registered `fixture.unlock` primitive) and then the independent Oracle (`judgeRun`), and appends a Pi-side audit JSONL row linking the Pi tool-call id to the experiment dir, route, and Oracle status. When `AEGIS_FIXTURE_PLAN_ONLY=1` it instead records the proposed call and returns the data-only arguments without executing, so the orchestrator can run Host+Oracle exactly once. |
| `Pi_Agent_base/fixtures/orchestrator.mjs` | Aegis-owned control-flow owner that fixes the THINK.md `direct` semantics. It checks the Router **before any model call**, runs Host+Oracle with 0 model requests / no Pi session when an active Experience matches, **fails closed on a `refuse` decision (conflicting matching active Experiences) with no planner call, no Pi session and no registered action execution**, and only calls an injected constrained Pi planner (which may start a real constrained Pi SDK session) when no Experience matches. |
| `Pi_Agent_base/tests/fixture-pi-integration.mjs` | Offline integration test for the extension/tool wiring (real Pi session, faux provider). Asserts tool registration, active-tool allowlist (no `bash`/`edit`/`write`/`read`/MCP/codemode), a real Host+Oracle execution, the direct route from a compiled active Experience, fail-closed denial for out-of-scope parameters, and deterministic Node-only paths. |
| `Pi_Agent_base/tests/fixture-pi-orchestrator.mjs` | Offline integration test that pins the orchestrator semantics on the SAME task: active Experience → 0 model requests, 0 Pi session startups, direct Host+Oracle success; conflicting active Experiences → `refuse`, 0 model requests, 0 tool executions, fixture unchanged, never reported as `deliberate`; no Experience → ≥1 Pi model request, exactly one constrained Pi session using the same `aegis_fixture_unlock` tool, Host+Oracle success. |

The extension reads its workspace from the environment, so the test runs in an
isolated temp dir with no writes to the repo:

- `AEGIS_FIXTURE_WORK_DIR` — base dir for per-call experiment dirs.
- `AEGIS_FIXTURE_EXPERIENCE_DIR` — optional dir containing a compiled
  `experiences.json`; when present the Router may hit the active Experience and
  the Host runs the primitive directly.
- `AEGIS_FIXTURE_AUDIT_LOG` — Pi-side audit JSONL (defaults under the work dir).
- `AEGIS_FIXTURE_PLAN_ONLY` — when `1`, the tool records the proposed call and
  returns its data-only arguments instead of executing, so the orchestrator can
  run Host+Oracle exactly once. Unset (the default) preserves executing behavior.

The same extension can be loaded by the bundled CLI with
`--extension Pi_Agent_base/extensions/aegis-fixture-tool.ts`. This checkout does
not contain the built `dist/bundle/cli.js`, so the reproducible path here is the
source-loaded offline test above.

Run the integration tests (offline; load the Pi SDK from source, build no
network):

```bash
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/fixture-pi-integration.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/fixture-pi-orchestrator.mjs
```

Each prints one `ok - ...` line per check and exits non-zero on any failure.

### Route before model (THINK.md `direct`)

`fixture-pi-orchestrator.mjs` is the regression test for the semantic fix. On
one task it asserts that an active Experience is checked before any model call:
the direct branch executes Host+Oracle with **0 model requests and 0 Pi session
startups**, a conflicting pair of matching active Experiences **fails closed as
`refuse` with 0 model requests, 0 tool executions, an unchanged locked fixture,
no experiment artifacts, and is never reported as `deliberate`**, while the
no-Experience branch starts exactly one constrained Pi session, makes **≥1 model
request**, uses the same `aegis_fixture_unlock` tool, and is then executed and
verified by the same Host+Oracle. The test also checks that both branches ran the
same task (goal, authorization, environment, preconditions/postconditions,
action, task types).

### Scope of the Pi claim

The integration tests prove the **wiring**: the orchestrator routes before the
model, an active Experience makes the call take the direct route with no Pi
session, the no-Experience branch really drives Pi's tool loop with the single
constrained Aegis tool, execution is routed through the registered Host
primitive and verified by the independent Oracle, and out-of-scope parameters
fail closed with an audit trail.

They do **not** prove learning or behavioral efficacy. That requires a real or
controlled-simulation DeepSeek A/B with an experience-free planner and a
comparison of actual model/tool calls and correctness rates; the faux model only
replays a scripted tool call. The claim here is "orchestration and Pi tool-call
integration verified; fixture learning/behavior efficacy not proven".

## Optional real-model A/B runner (never run by the offline suites)

`Pi_Agent_base/fixtures/real-model-ab.mjs` is a small optional runner for
the one claim the offline faux-provider tests cannot make: that the constrained
Pi planner, driven by the configured real `relay`/`deepseek-v4.1-flash` model,
actually calls the single Aegis tool and is verified by the Oracle. It requires
the explicit `--run-real` flag (otherwise it refuses and exits 2), supports
`--output-dir` and a conservative `--timeout-ms`, and reads the credential from
the isolated `${AEGIS_HOME:-~/.Aegis}/agent` directory without ever printing it. Set `AEGIS_PI_AGENT_DIR` to an alternate isolated agent directory when needed.

```bash
node --import Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/fixtures/real-model-ab.mjs \
  --run-real --output-dir /tmp/aegis-real-ab [--timeout-ms 120000]
```

It runs `runOrchestratedTask` on the same task twice: with the compiled active
Experience (must be `direct` with 0 model requests and no Pi session) and with
no Experience (must be `deliberate` with at most two provider requests, exactly
one `aegis_fixture_unlock` plan-only tool execution, and Oracle-verified
success). It loads the Pi SDK from source, uses `SessionManager.inMemory`, an
agent-dir-isolated credential, and an empty session cwd with no project
resources; only the single constrained tool is active (no shell/edit/write/MCP/
codemode). Cost/token/call metrics are printed and written to
`real-model-ab-report.json` when the provider reports them. Success is decided
only by the Oracle over trusted filesystem state and the hash-chained event log;
the model's final prose is never used as an oracle. It exits non-zero if any
invariant fails.

**Validation status:** the runner is never run by the offline suites. It was
subsequently run by the reviewer against the configured relay twice, including
after the isolated replay-evidence change. Both runs reported direct Oracle
success with 0 provider requests and no-experience Oracle success with 2
provider requests and 1 constrained tool call. This is a smoke check, **not**
a statistical demonstration of improved planning or transfer. Reports are in
reviewer-created temporary directories and are not required for offline tests.

## Modules

| File | Role |
| --- | --- |
| `contracts.mjs` | Schema helpers, `node:crypto` SHA-256 chain, predicate evaluation, safe path resolution. |
| `action-registry.mjs` | Registered reviewed primitive `fixture.unlock` (data-only args; no executable text from Experience). |
| `host.mjs` | Trusted runner: resets fixture, observes/hashes pre-state, records intent, executes via the broker. |
| `oracle.mjs` | Independent verifier: re-hashes the trusted pre-state, reads post-state, separates task/transport status. |
| `compiler.mjs` | Promotes a fixture-only `active` Experience from independent verified live evidence + replayable action id. |
| `router.mjs` | Read-only applicability check (active / scope / verified preconditions / whitelist / conflict). Never executes. |
| `orchestrator.mjs` | Aegis-owned control flow: route-before-model, direct Host+Oracle fast path, fail-closed `refuse` on conflicts, and constrained-Pi-planner fallback when no Experience matches. |
| `real-model-ab.mjs` | Optional, explicitly gated (`--run-real`) real-provider A/B runner. Not an offline test and never run automatically. |
| `demo.mjs` | The 2+1 offline demo and `demo-report.json`. |

## Honest boundary

- This is a deterministic **Node Host**. The 2+1 `demo.mjs` does not drive Pi's
  tool loop; it remains the pure-Node mechanism demo. The separate offline tests
  verify the Pi tool-call wiring (see above) and the route-before-model
  orchestration but, with a scripted faux model, they do **not** prove learning
  or behavioral efficacy.
- The Oracle appends outcome events to the hash-chained `events.jsonl` with the
  confirmed-append writer and never rewrites the whole log. A repeated judgment
  of the same episode fails clearly before any write, so outcomes cannot be
  duplicated and the chain cannot be corrupted by re-judging (regression-tested
  in `fixture-direct-smoke.mjs`). Derived projections (`outcomes.json`,
  `episodes.json`, `oracle-report.json`) are still written as whole files.
- The fixture path boundary (rejecting absolute paths, `..`, symlink escapes) is
  the real limit of this prototype. It is not a general sandbox for bash, MCP, or
  third-party extensions, and cwd is not treated as a sandbox.
- Evidence is live current-environment evidence. To mark a success replayable,
  the Oracle independently runs the **registered primitive id** against a fresh
  isolated fixture seeded from the observed pre-state, records `replay-proof.json`
  and a chained `replay.verified` event; the Compiler checks both before `active`.
  It does not re-run free text. The legacy `--allow-replay-only-active` switch is
  not used for this promotion path.
- Digests use Node's built-in `node:crypto` (`createHash("sha256")`) and ids use
  `randomUUID()`; there is no custom hash or `Math.random()` generator. Long hex
  strings may be redacted from captured stdout, but the real digests are written
  to disk.
