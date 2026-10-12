# Overnight Batch B — Pending Human Decisions

Status: Batch B library modules and offline tests are complete and green
(`Pi_Agent_base/tests/memory-runtime-batch-b-smoke.mjs`, 94 tests, all green).
This file lists **only** the open questions that need a human/product decision.
Everything not listed here is implemented and covered by a test.

The audit-first review notes live in `docs/OVERNIGHT_AUDIT.md`; each Batch B
item is closed or explicitly kept as a gap below.

## Open questions (need a human decision)

1. **Function-contract dependency pinning.**
   `implementationDigest()` for a `kind:"function"` contract hashes the function
   *source text*. Two closures with identical source but different captured
   values produce the same digest. The runtime cannot introspect closure
   captures. **Decision needed:** require an explicit `implementation_digest`
   plus a `dependency_manifest` (list of `{name, digest}`) for any function
   contract that closes over mutable state, or forbid closures entirely in
   registered function contracts. Until then function contracts with closure
   state must pass an explicit digest (the mechanism exists:

   `defineContract({ ..., implementation_digest })`).

2. **Router route for a changed implementation digest.**
   When a verified `active` Experience pins an `implementation_digest` that no
   longer matches the registered contract, the Router now returns
   `route:"paused"` (recoverable) instead of `hint`. **Decision needed:**
   confirm `paused` (binding suspended until re-verification) is the desired
   product behaviour, versus a soft `hint`. The test asserts `paused`.

3. **Authorization trust boundary.**
   `createActionBroker().invoke()` accepts EITHER `authorization` (a config from
   `createAuthorization`) OR a `permit`. When `authorization` is supplied the
   broker **re-derives** the permit from the real context and ignores any passed
   permit — a hand-built `{ok:true}` cannot authorize execution. A raw `permit`
   is still field-checked (`matchPermit`) but is not cryptographically bound
   (single-process trust model). **Decision needed:** confirm the runtime/observer
   integration must ALWAYS pass `authorization` and never a bare `permit`; if a
   bare permit must be denied outright, that is a one-line policy change.

4. **Script verifier mapping (kept gap).**
   There is still **no** automatic mapping from a natural-language postcondition
   to a script verifier. Every script registration must supply a human-written
   `verify()` Oracle. `bindProposal` reports any unmapped checker as an explicit
   `gap` and never invents code. **Decision needed:** the human registration
   format/UI for script Oracles (this is intentionally out of Batch B scope).

5. **Replay-hash provenance.**
   The compiler requires ≥2 proofs with distinct, non-empty `replay_hash` values
   and an explicit `reproducibility.replayable === true`. It never treats
   `replay_count = 1` (a single registered run) as replay evidence.
   **Decision needed:** whether `replay_hash` must be produced by an independent
   re-execution of the action (content-derived) or may be produced by a
   recomputed Oracle check. Batch B accepts either as long as the two hashes are
   distinct.

6. **`replay_count` ownership.**
   Modules emit `reproducibility.replay_count = 0` for step outcomes; they never
   claim a replay that was not performed. **Decision needed:** who is allowed to
   increment `replay_count` (presumably a caller that actually re-runs an
   idempotent action). Non-idempotent scripts must never be auto-incremented.

## Closed audit items (Batch B)

- Transport facts preserved: `transport.tool_ok` is the procedure's fact and is
  never overwritten from goal status; `exit_code`/`signal`/`timed_out` kept.
- Full data-only parameter validation (required/optional/type/enum/range/pattern/
  NUL/unknown-field/non-scalar) BEFORE execution.
- Permit re-check covers id/version/implementation_digest/arguments_digest/
  scope_digest/expiry; broker can re-derive the permit from `authorization`.
- Empty Recognition/Verification can never auto-pass (fail-closed).
- Prose is never parsed into code: `bindProposal` yields explicit `gaps`.
- ELF is parsed from real bytes; truncated/non-ELF/out-of-bounds → `unknown` or
  `rejected`, never a guess; verification independently re-reads + re-parses.
- Scripts: interpreter and script body pinned separately (both in the contract
  digest); real symlink-resolved cwd; timeout (`ETIMEDOUT`) distinguished from
  other signals; non-zero exit is transport, the Oracle decides.
- Router: missing `action_version`/`implementation_digest` never passes; absent
  `when` fields are UNKNOWN (never a `neq` match); unified template+taskArgs
  binding with schema check (extra/type/required/conflict ⇒ not direct);
  independence proven by distinct identity dimensions, not counts.
- Compiler: strict version/digest pinning; resolved evidence refs; ≥2 distinct
  replay hashes; `supersedes` replaces without double counting.
- No fake `replayable`: `replay_count` stays 0.
