# Overnight D — pending items

D did **not** modify any existing file. This file records (a) precise
reproducers + recommendations for issues found in existing B2 libraries while
building D, and (b) open human/product decisions. Nothing here was fixed
in-place; the supervising agent should dispatch fixes to the owning batch.

---

## P1. `script-registry.mjs` — an `argv_template` that repeats the executable validates, then fails at runtime

**Severity:** medium (easy to misconfigure; only fails when the action first runs).

**Summary.** `createScriptRegistry`/`validateScriptRegistration` require the
interpreter `script_path` to appear in `argv_template`, but they do **not** forbid
the template from also starting with the `executable` (e.g. `node`). Because the
broker spawns with `spawnSync(registration.executable, argvBuild.argv, ...)`,
including the executable in the template produces `node node <script> ...`, and
Node tries to run a file literally named `node`.

**Reproducer** (fails today; D hit this while writing the live-script test):

```js
import { createScriptRegistry, scriptContracts, executableDigest } from "Pi_Agent_base/memory/runtime/script-registry.mjs";
import { ActionRegistry, createActionBroker } from "Pi_Agent_base/memory/runtime/action-contract.mjs";

const scriptPath = "/abs/tmp/stage.mjs";        // writes argv[2] from argv[1]
const root = "/abs/tmp/workspace";
const registration = {
  schema_version: "1.0", id: "stage", version: 1,
  executable: process.execPath,
  executable_digest: executableDigest(process.execPath),
  script_path: scriptPath,
  script_digest: executableDigest(scriptPath),
  // BUG PATH: the executable is repeated here; validation still passes.
  argv_template: [process.execPath, scriptPath, "{input}", "{out}"],
  allowed_root: root, cwd: root,
  parameters: { input: { type: "string", required: true, direction: "in" }, out: { type: "string", required: true, direction: "out" } },
  verify: () => ({ ok: true, reason: "ok" }),
};
const reg = createScriptRegistry({ scripts: [registration] });   // throws nothing
const registry = new ActionRegistry(scriptContracts(reg));
const broker = createActionBroker({ registry });
const r = await broker.invoke({ action_ref: "script.stage", arguments: { input: "in.json", out: "out.json" }, context: { workspaceRoot: root, target_path: `${root}/in.json` }, authorization: { mode: "auto", workspaceRoot: root, allowedTools: ["aegis_script"] } });
// observed: verification re-read fails ENOENT; the script body never ran.
```

Changing the template to `[scriptPath, "{input}", "{out}"]` (executable excluded,
as `spawnSync` supplies it) fixes it.

**Recommendation.** In `validateScriptRegistration`, reject an `argv_template`
whose first token resolves to `registration.executable` (or reject any token that
equals the executable path/basename). Alternatively, document on the
`argv_template` field that the executable is implicit and add a self-test. Owner:
B2 / script-registry.

---

## P2. `script-registry.mjs` + resolver — the emitted stdout evidence ref is not run-unique

**Severity:** low–medium (only affects callers that reuse the contract's
auto-generated `step_outcome.evidence_refs` for two executions of the same action).

**Summary.** `createScriptContract(...).build()` emits an artifact evidence ref
with a **fixed** id `${registration.id}.stdout` and a **per-run** digest. Two
successful executions of the same registered action therefore produce two records
with the same id and different digests. A resolver that indexes artifacts
last-wins cannot resolve the earlier run's pinned evidence ref (and the compiler's
`evidence_refs` rule refuses the proof).

D's `evidence-resolver.mjs` mitigates this by indexing artifacts by **id + digest**
(and resolving a digest-pinned ref to the matching record), so the two runs both
resolve. But the interop requirement is implicit in the emitted ref shape.

**Reproducer** (against a last-wins artifact index, e.g. a naive resolver):

```js
// 1. Register + run a script twice via the broker; both step_outcomes carry
//    evidence_refs: [{ ref_type: "artifact", ref_id: "stage.stdout", digest: <runN stdout_digest> }].
// 2. Commit both as observation.captured / outcome.recorded.
// 3. Resolve run 0's ref against a last-wins artifact map -> ENOENT-equivalent
//    "no artifact record" / digest mismatch, because run 1 overwrote the id.
```

**Recommendation.** Either make the emitted artifact ref id run-unique
(e.g. append the episode/run id: `${registration.id}.stdout:${run_id}`) in
`createScriptContract`, or explicitly document that the artifact index must be
digest-aware. Owner: B2 / script-registry; D already satisfies the digest-aware
form on its side.

---

## P3. Open human/product decisions

These are not defects; they need a product owner's call before the next batch.

1. **Wiring the trusted resolver into the live Observer/Host.** D exposes
   `createEvidenceResolver` / `createWorkflowEngine` as library APIs and its tests
   prove them. The batch-B compiler/router/contribution gates still accept a
   caller-supplied `resolveSupport`; only the D engine binds the trusted one.
   Wiring the Observer/Host to always pass the D resolver touches files owned by
   C2 and was intentionally left out. Owner: C2 + supervision.
2. **Actor identity is structural, not authenticated.** The resolver trusts a
   committed event's `source.kind`; `actor_id` is not signed or authenticated. A
   process able to write the EventLog can forge a trusted source. Decide whether
   event sources need signing/authentication. Owner: architecture / security.
3. **Approval granularity.** In `normal` mode a single approval flag covers the
   process (overlaps `OVERNIGHT_C_PENDING.md`). Decide the per-action/per-target
   approval model. Owner: product.
4. **Replay-adapter provisioning.** `replayOutcome` requires an explicitly
   configured `isolated: true` adapter, but *who* may register one and *how*
   isolation is attested is unspecified. D treats the adapter as trusted code.
   Decide the registration + attestation story. Owner: product / supervision.
5. **Generalisation policy.** D never generalises scope automatically: a compiled
   Experience carries the current environment scope, and `routeLearning` only runs
   against a verified effective state. Decide when/if a rule may apply to a new
   target or scope without re-verification. Owner: architecture.
6. **Which read-only actions to expose next** (overlaps `OVERNIGHT_C_PENDING.md`).
   Owner: product.

---

## Explicitly NOT done (so it is not mistaken for complete)

- No modification of Observer / action-runtime / script-registry / contest / daily
  or any existing B2 library.
- No signature/authentication of event sources (P3.2).
- No live Observer/Host integration (P3.1) — library + tests only.
- No real network/model/remote target, and no contest-effective rate number.
