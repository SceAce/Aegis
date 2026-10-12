# Overnight Batch B — API / Implementation Report

Scope: **new** library files under `Pi_Agent_base/memory/runtime/` and **new**
offline tests. No existing file, Observer, event writer, contest, board, state,
RAM, handoff, config or auth was modified. No network, no provider, no shell
eval. No commit.

Test entry point:

```
node Pi_Agent_base/tests/memory-runtime-batch-b-smoke.mjs
# -> ok batch-b memory runtime: 89a0bfc3 all assertions passed   (94 tests)
```

Every test runs in a fresh `mkdtemp` dir, uses only local files and an
in-process registry, and asserts from returned records / on-disk state — never
from an agent self-report.

## Modules

### `action-contract.mjs`
Reusable, fail-closed ActionContract engine + the single execution broker.

- Constants: `CONTRACT_SCHEMA_VERSION`, `PROCEDURE_KINDS`, `RISK_CLASSES`,
  `RETRY_POLICIES`, `PREDICATE_OPS`, `ALLOWED_PARAMETER_TYPES(_LIST)`.
- `defineContract(spec)` → validated contract; `implementation_digest` is
  derived from the procedure or an explicit `spec.implementation_digest`.
- `validateContract`, `validatePredicateShape` — static review.
- `implementationDigest(procedure)` — function source, or argv
  `{executable, executable_digest, script_path, script_digest, argv_template}`.
- `contractDigest`, `contractScopeDigest` — canonical digests (no comments).
- `validateParameters(schema, args, label)` — full data-only schema validation
  (required/optional, string/integer/number/boolean, `min_length`, `values`,
  `minimum`/`maximum`, `pattern`, NUL, unknown-field, non-scalar).
- `ActionRegistry` — rejects duplicates/invalid contracts; `describe()` exposes
  metadata only, never executable code.
- `checkRecognition(contract, state)`, `checkVerification(contract, {observed,
  state, context})` — non-empty predicates or `check()` required (fail-closed).
- `bindProposal(proposal, {registry, knownPredicates, knownCheckers})` — maps an
  explicit registered action / known predicate / checker; anything else is an
  explicit `gap`; prose is never parsed into code.
- `matchPermit(permit, contract, args, {now})` — re-checks `mode`, `ok`,
  `action_ref`, `version`, `implementation_digest`, `arguments_digest`,
  `scope_digest`, `expires_at`.
- `createActionBroker({registry})` → `{invoke, bindProposal, describe}`.
  `invoke({action_ref, arguments, context, state, permit, authorization})` order:
  args schema → authorization (re-derived from `authorization` if supplied) →
  permit re-check → recognition → procedure → verification. Status is `success`
  only when Verification passes; otherwise `unknown` +
  `failure_mode:"insufficient_evidence"`. Transport facts
  (`tool_ok`/`exit_code`/`signal`/`timed_out`/`duration_ms`) are preserved.
- `actionIdentity`, `newOutcomeId`.

### `workspace-info-actions.mjs`
Read-only workspace ELF identification (`workspace.identify_elf` v1,
`risk_class:"observe"`).

- `parseElfHeader(buffer)` parses real bytes (never guesses); `<16` bytes or a
  short class header → `truncated`, bad magic/class/encoding → `not_elf`,
  `>64 MiB` → `too_large`.
- `syntheticElfHeader`, `normalizeElfHeader`, `targetFingerprint`,
  `ELF_MAGIC`, `ELF_MACHINES`, `ELF_FILE_TYPES`, `MAX_ELF_FILE_BYTES`.
- Verification independently re-reads the file, re-hashes it and re-parses the
  header.
- `isElfObservationCurrent` marks an observation stale when the target changed.
- Outcome is `schema_version:"1.1"` with `episode_id`, a real `failure_mode`,
  and honest `reproducibility` (`replay_kind:"observation_recheck"`,
  `replay_count: 0`).

### `script-registry.mjs`
Human-registered script actions (no self-registration, no eval, no shell).

- `validateScriptRegistration`, `createScriptRegistry` (empty config is valid),
  `createScriptContract`, `scriptContracts`.
- `isInterpreter`, `INTERPRETER_BASENAMES`, `FORBIDDEN_EXECUTABLES`,
  `FORBIDDEN_ARGV_TOKENS`, `fileDigestHex`, `executableDigest`.
- `insideRoot(root, candidate, {mustExist})` — realpath/symlink-resolved escape
  checks (also used by authorization).
- `buildArgv(registration, args)` — substitutes only registered data params;
  unregistered/unknown args are refused.
- Verification is the human `verify()` Oracle. Non-zero exit is a transport
  fact, not a verdict; timeout (`ETIMEDOUT`) is distinguished from other
  signals; no retry (`attempts:1`, `retry_allowed:false`). Interpreter
  registrations pin the interpreter binary **and** the script body.

### `authorization.mjs`
`MODES`, `createAuthorization`, `authorizeAction`, `describeAuthorization`.
Normal mode → `pending_approval` without explicit approval; auto mode grants
only inside the workspace/target and for declared tools, network needs
`allow_network`. A permit carries id/version/implementation_digest/
arguments_digest/scope_digest/expiry; `is_verification:false`,
`workspace_is_sandbox:false`.

### `learning-router.mjs`
`routeLearning({experiences, task, environment, currentState, registry})` →
`direct` / `habit` / `hint` / `deliberate` / `paused` / `refuse`. Candidate
experiences are never hints. Missing `action_version`/`implementation_digest`
never pass; absent `when` fields are UNKNOWN; direct binding unifies the
template + task args and validates the schema; independence requires distinct
identity dimensions; a changed environment/implementation or a verified
counterexample suspends the binding (`paused`, recoverable); differing
direct-ready rules `refuse`.

### `experience-compiler.mjs`
`compileExperience` / `compileFromFile` (`COMPILER_VERSION`). Activates only
when: ≥2 proofs, all `success`, ≥2 distinct `run_id`/`episode_id`/
`independence_group`/`reset_nonce`, ≥2 distinct replay hashes with
`reproducibility.replayable === true`, same action/args template, strict
version+implementation digest match, resolvable evidence refs, current-env
scope, verified non-wildcard `when`. Otherwise `candidate` with
`experience.failure_rules`. `supersedes` replaces without double counting.

### `contribution.mjs`
`DATA_STAGES`, `recordStageContribution`, `contributionPayload`,
`dataUsefulness`. Always `association_only:true`, `causal:false`; requires an
executed action ref, an obtained data ref and a verified outcome whose
`evidence_refs` include both. Emits a `runtime.note` payload
(`kind:"contribution.recorded"`) for the existing Observer `EventLog` — no new
event schema or writer.

## Integration notes

- All modules are **pure/callable**: they return `observation.captured` /
  `outcome.recorded` / `runtime.note` payload objects and never append events.
- `runtime.note` is the only generic event type used; no competing schema.
- Reused fixture contracts/helpers: `digest`, `stable`, `sha256Hex`,
  `resolveInside`, `readJson`, `newId`, `isoNow`, `evaluatePredicates`,
  `getPath`, `matchesPredicate`.
- Crypto is the standard `node:crypto` (via the fixture `sha256Hex`/`digest`);
  no custom hashing.

See `docs/OVERNIGHT_B_PENDING.md` for the human-decision items.
