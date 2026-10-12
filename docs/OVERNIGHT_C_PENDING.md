# Overnight Batch C — Pending Human Decisions

Status: Batch C integration and its two new tests are green. This file lists
**only** the decisions that need a human/product call. Everything not listed
here is implemented and covered by a test. See `docs/OVERNIGHT_C_REPORT.md` for
the delivered scope and the honest remaining issues.

## Open questions (need a human decision)

1. **Wire the B2 contribution/compiler APIs to the shared resolver.**
   `action-runtime.mjs` already exposes `createRefResolver` and the Observer
   records `data.use.bound` association notes, but `recordStageContribution` /
   `compileExperience` are DS-owned and read-only for Batch C, so the `advance`
   stage is not yet produced automatically. **Decision needed:** confirm the
   intended seam (the resolver) and who wires it, so a verified stage Outcome can
   support an `advance` contribution without any success being self-declared.

2. **Script registration packaging.**
   A trusted `verify()` Oracle cannot live in JSON, so usable registrations must
   be a reviewable `.mjs`/`.js` module (or in-process object) referenced by
   `AEGIS_SCRIPT_CONFIG`. **Decision needed:** confirm the operator experience
   (e.g. a signed/committed registrations module per deployment) and whether a
   `.json`-only registration should be a hard error with a clearer message.

3. **Approval granularity in `normal` mode.**
   Today `normal` blocks ALL side-effecting registered scripts until
   `AEGIS_ACTION_APPROVED=1` is set in the environment (a per-process flag).
   **Decision needed:** whether approval should be per-action / per-episode /
   interactive, rather than a single env flag, and whether the Observer should
   expose an approval command.

4. **Which read-only actions to expose next.**
   `aegis_observe` is intentionally limited to `workspace.identify_elf`.
   **Decision needed:** the next reviewed observation contracts (and whether the
   exposure allowlist should move from the adapter into config).

5. **Contest `auto` default for a task.**
   The launcher default is `AEGIS_ACTION_MODE=normal`. **Decision needed:**
   whether contest tasks may opt into `auto` by category, and how the "auto ≠
   fact verification" boundary is communicated to contest participants.

6. **Sandbox expectations.**
   The workspace is a target boundary, not an OS sandbox. **Decision needed:**
   whether a real OS-level sandbox (container/seatbelt/landlock) is required
   before any automated `auto` script execution is allowed, since a registered
   script otherwise runs with the user's full privileges.
