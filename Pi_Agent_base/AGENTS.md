# Aegis development entry

Applies to Aegis-owned code under `Pi_Agent_base/`. The nested `pi/` keeps its own
instructions and is outside the current implementation scope.

Read these before Campaign development:

- `../docs/AGENT_DEVELOPMENT_STANDARD.md`
- `../docs/AGENT_TESTING_STANDARD.md`
- `../docs/GIT_STANDARD.md`
- `../docs/C1_F14_EXTERNAL_ACCEPTANCE.md`
- `../docs/C2_SESSION_ROTATION_TASK.md`
- `../docs/C2_EXTERNAL_ACCEPTANCE.md`
- `../docs/CAMPAIGN_NEXT_PHASES.md`
- `../docs/C3_EXTERNAL_REVIEW.md`
- `../docs/C4_EXTERNAL_REVIEW.md`
- `../docs/C4A_EXTERNAL_REVIEW.md`
- `../docs/C5_INTEGRATION_TASK.md` (historical C5 scope)
- `../docs/C5_EXTERNAL_REVIEW.md`
- `../docs/C6_AGENT_PRODUCT_TASK.md` (current overall development task)
- `../docs/AEGIS_PRODUCT_ROADMAP.md`
- `../docs/SDK_LAUNCHER_TASK.md` (C6-A lifecycle requirements; no longer a separate assignment)
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

Freeze each phase's core goals and required checks before implementation.
Follow `../docs/AGENT_DEVELOPMENT_STANDARD.md` section 3.1: distinguish current
blockers from non-blocking/deferred work. Findings need a reachable violation of
current correctness/authorization to reopen the gate; performance preferences
or later-phase features alone do not block. Keep deferred evidence, ownership
phase and reassessment conditions visible. Reuse reports for small repairs.
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

Current stage entry: `../docs/DS_MASTER_PROMPT.md`. C1-C4a remain accepted;
C5 review and user-authorized fixes are complete with recorded limitations.
Next delegated assignment is `../docs/C6_AGENT_PRODUCT_TASK.md`: one overall
code delivery covering SDK lifecycle, model Worker and actual budgets, Campaign
learning, provider configuration interfaces, measurement/run support and a second
local task adapter. Progress autonomously through C6-A to F and return for one
engineering review. SDK launcher requirements are part of C6-A.
Validate with real SDK/faux and local effects/replay/HTTP; provider interfaces use
offline substitutes. Real-model pilots, efficacy/transfer studies and daily-use
experiments are separate later tasks. C6 does not read real credentials or call
real providers/targets. Preserve deferred F16 and per-config type baselines.
