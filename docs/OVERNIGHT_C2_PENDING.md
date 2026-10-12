# Overnight Batch C2 — Pending Human Decisions

Status: Batch C2 (the data-use-stage loop + C correctness repair from
`docs/OVERNIGHT_C_AUDIT.md`) is green. This file lists **only** the decisions
that need a human/product call. Everything not listed here is implemented and
covered by a test. See `docs/OVERNIGHT_C2_REPORT.md` for the delivered scope and
the explicit **library-green vs actually-wired** split.

Items 1–6 of `docs/OVERNIGHT_C_PENDING.md` (Batch C) are still open and NOT
superseded by this file. The decisions below are the new ones C2 surfaced.

## Open questions (need a human decision)

1. **`AEGIS_ACTION_APPROVED` is a per-process grant, not a per-user approval.**
   C2 made the authorization record explicit
   (`authorization: {mode, source, scope, granted, per_call_human_record:false}`)
   so the log no longer implies a stored human approval. But the underlying
   `normal`-mode gate is still a single environment flag set for the whole
   process. **Decision needed:** whether approval must be a per-action /
   per-episode interactive record (with `per_call_human_record:true`) before any
   automated script execution is allowed, and how the Observer should surface an
   approval command. This overlaps C item 3 but is stronger now that the log is
   honest about the gap.

2. **Path parameters are only validated when the human registration declares a
   direction.** Undeclared string parameters are treated as plain data, not
   paths, and are never workspace-bounded. A registration that forgets
   `direction:"out"` on a path parameter therefore loses the pre-effect
   workspace containment check. **Decision needed:** whether a declared path
   parameter SHOULD be mandatory for any argv slot that is interpolated into a
   filesystem path, or whether the runtime should refuse to spawn when an argv
   token resolves to an absolute/`..` path that no declared parameter owns.
   (Today it fails closed only when the parameter IS declared.)

3. **Stale-data scope granularity.** When a bound ref's target changed, C2 emits
   a trusted, SPECIFIC-scope `environment.changed` naming the observation's own
   `scope` (e.g. the file path) so only same-episode nodes on that exact scope go
   stale. **Decision needed:** whether the scope key should be
   `(episode, path)` only, or also include an expected revision so that
   re-observing the same path after a change re-admits a Fact without a human
   reset. Currently a re-verification after the change is the new current Fact;
   confirm that is the intended semantics.

4. **Only `workspace.identify_elf` is an observable action.** The data-use loop
   is proven end-to-end for that one contract. **Decision needed:** the next
   reviewed observation contracts to expose (and whether the exposure allowlist
   should move from the adapter into operator config). This restates C item 4 but
   is now the blocking input for exercising the loop on more than ELF files.

5. **Contribution refs are association-only and shown as such in the daily
   report.** The report lists the ACTUAL `data_ref`/`action_ref`/`outcome_ref`
   for each stage and marks `stage_useful`, but `causal:false` is always
   recorded. **Decision needed:** whether any downstream consumer is allowed to
   treat `stage_useful:true` as a positive signal for ranking, or whether it must
   stay purely descriptive until a replay-based causal proof exists.

6. **Sandbox expectations (unchanged from C item 6, restated because C2 now
   executes more).** The workspace is a target boundary, not an OS sandbox. A
   registered script still runs with the user's full privileges. **Decision
   needed:** whether an OS-level sandbox is required before automated execution
   expands beyond ELF observation + the single registered test script.
