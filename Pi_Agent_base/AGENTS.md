# Aegis development entry

Applies to Aegis-owned code under `Pi_Agent_base/`. The nested `pi/` keeps its own
instructions and is outside the current implementation scope.

Read these before Campaign development:

- `../docs/AGENT_DEVELOPMENT_STANDARD.md`
- `../docs/AGENT_TESTING_STANDARD.md`
- `../docs/GIT_STANDARD.md`
- `../docs/C1_FINAL_EXTERNAL_AUDIT_3.md`
- `../docs/C1_EXTERNAL_BOUNDARY_FIX_TASK.md`
- `../docs/DS_ORCHESTRATION_WORKFLOW.md`
- `../docs/CAMPAIGN_CONTRACT_BASELINE.md`
- `../docs/C1_INTEGRATION_CLOSURE_TASK.md`
- `../docs/C1_INTEGRATION_TEST_SPEC.md`
- `../docs/C1_CLOSURE_EXTERNAL_AUDIT.md`
- `../docs/CAMPAIGN_IMPLEMENTATION_TASK.md`
- `../docs/CAMPAIGN_ARCHITECTURE.md`
- `../docs/ARCHITECTURE_DECISIONS.md`
- `../docs/MEMORY_SCHEMA.md` and `../docs/MEMORY_SCHEMA_NOTES.md`

Current user instructions override historical drafts. A master DS may receive
one whole assignment, then divide it into bounded implementation/test/review
subtasks. Delegate only using capabilities actually available; otherwise work
serially and report that honestly.

Generate and review the shared contract/test matrix before implementation.
Preserve existing meaningful assertions. Use disjoint file ownership; the
master owns shared contracts, configuration, exports, integration and final
self-review. Same-model self-review is not external acceptance.

Keep Observation / Claim / Action / Outcome separate. LLM text and tool exit
codes do not produce trusted results or authorization. Session rotation does
not produce independent Episode evidence. Unknown remains visible.

Use the existing Node ESM/TypeScript and Biome conventions. Annotate public
interfaces and run meaningful focused checks. Check the actual SDK API when
integrating Pi; SDK tests require the source resolver and faux provider.

Do not modify embedded Pi core, credentials, model settings or lockfiles;
do not restore the deleted Python demo or root AGENTS.md; do not commit or
clean/reset unrelated changes. No real-model/target network experiments in
this development assignment.

Use local Git for all authorized Aegis-owned implementation, tests and docs.
Work on a task branch, stage explicit paths, inspect the staged diff, and commit
reviewable milestones. Historical instructions saying not to commit are
superseded by the user's Git management requirement. Do not push or rewrite
history. Embedded `pi/`, `config/` and `runtime/` remain outside the parent repo.

Runtime/test artifacts stay in ignored private directories. Reports contain
bounded evidence references, never credentials, flags or unrestricted raw
transcripts. Record exact commands, exit codes and limitations.

Current assignment entry: `../docs/DS_MASTER_PROMPT.md`. The latest external
review reproduced F10-F13 after F7-F9. Follow
`../docs/C1_EXTERNAL_BOUNDARY_FIX_TASK.md`; preserve the failing acceptance tests
and verify the actual scheduler/checkpoint paths. C1 is changes_required and C2
remains blocked until external review of the fixes. Do not implement C2-C4a.
