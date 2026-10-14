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
- `../docs/C6_AGENT_PRODUCT_TASK.md` (frozen overall development scope)
- `../docs/C6_EXTERNAL_REVIEW.md`
- `../docs/C6_REPAIR_DS_PROMPT.md` (historical first repair)
- `../docs/C6_RECHECK_REPAIR_DS_PROMPT.md` (historical five-group recheck repair)
- `../docs/C6_REQUEST_LIFECYCLE_CONVERGENCE_DS_PROMPT.md` (historical first lifecycle convergence assignment)
- `../docs/C6_THREE_FACTS_DSV41FLASH_TASK.md` (current bounded repair; supersedes historical defect status)
- `../docs/C6_AGENT_LIFECYCLE_OPEN_SOURCE_RESEARCH.md` (upstream lifecycle evidence and applicable limits)
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
this development assignment. The separately authorized E1 operator path may
read the selected Pi config/auth read-only for the user's paid pilot; it must
never print or modify those source files.

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
C6 external recheck remains **changes_required** at product baseline `22d075c`.
The five repair groups are recognized within the review scope: all 15 C6 scripts,
22 external boundary cases and the original 13 focused recheck cases passed.
The provider-bound request gate was then re-planned and repaired
(`../docs/C6_PROVIDER_GATE_PLAN.md`): R12 final durable commit before any
Broker dispatch, R13 Campaign+Task joint pre-call admission, R14 the actual
provider transcript/tool-schema window. The focused suite is now 23 cases /
23 pass; the five repaired groups are not reopened. A request-lifecycle
convergence round then unified live/durable/replay settlement in
`../memory/campaign/c6-request-lifecycle.mjs`: a partial in-memory commit is
never a durable success, a provider error keeps a recoverable hold and a
durable reconciliation, per-Task pending is isolated, and a partial/mismatched
`committed` record never settles a joint request. New focused checks:
`aegis-c6-lifecycle-convergence.mjs` (19) and `aegis-c6-lifecycle-restart.mjs`
(real subprocess SIGKILL + restart). Campaign type diagnostics
remain 0 (196 legacy diagnostics remain). Real-model pilots and learning
efficacy experiments remain separate after engineering acceptance. Development
checks do not call real providers or targets; the separately authorized E1
operator path is the only exception and reads selected Pi credentials without
printing or modifying them. Preserve deferred F16 and honest per-config type
baselines.

Current repair supplement (2026-10-14): product baseline `93d4617`, independent
audit tests in `290313f`, and `../docs/C6_EXTERNAL_REVIEW.md` section 7 defined
two blockers: reconciliation rebuild dropped confirmed consumption and could
erase unresolved joint settlement, and SDK `aborted` could still release a
buffered decision to the Broker. Per `../docs/C6_THREE_FACTS_DSV41FLASH_TASK.md`
this round keeps per-side budget responsibility, joint request settlement and
planning termination separate: `summarizeRequestLedger` is side-aware,
`unresolved` is independent of pending, and `classifyStopReason` preserves
Pi's error/aborted hard exits. `aegis-c6-architecture-review.mjs` is now 12/12
(was 6 pass / 6 fail); the 18 C6 scripts and 26 regressions pass and the type
baseline is unchanged. Status is **internally_verified / awaiting_external_review**
(DS internal engineering verification, not external acceptance). The prior
four repairs remain recognized. Engineering acceptance permits consideration
of a limited real-task pilot; unrelated warnings and deferred infrastructure
do not reopen this repair scope.

Latest bounded external review (2026-10-14): see `../docs/C6_EXTERNAL_REVIEW.md`
section 8. The two DS repair groups are accepted. A real SDK tool-result
persistence failure exposed a planning error after request settlement; that
small wiring gap was fixed here. All assistant termination events now update
planning state independently of outstanding requests. Final architecture tests
pass 13/13, convergence 26/26, all 18 C6 scripts and 26 regressions pass, and
the 196-diagnostic type baseline is unchanged. The limited engineering gate is
passed; the next stage is a bounded real-task pilot with explicitly selected
provider, scope, budget and Oracle. This review did not run a real provider.
SIGTERM is Task-boundary drain; do not claim immediate active-Task cancellation.

E1 operator supplement (2026-10-14): the user selected max/deepseek-v4.1-flash
and will execute real calls themselves. The user then authorized reading and
reusing existing Pi model/auth config. Pilot defaults to explicit `pi-config`
with Pi ModelRuntime and read-only auth; never print credentials or modify the
source config. Explicit `remote-openai` SDK wiring and
`memory/campaign/e1-max-pilot.mjs` preparation/status/run commands are available;
see `../docs/E1_MAX_OPERATOR_STEPS.md`. Offline intercepted HTTP is verification,
not a real max result. Do not start a paid experiment on the user's behalf.

E1 first operator result (2026-10-14): user-run smoke completed with 3 requests,
Oracle success and zero pending/unresolved; independent status after exit
agrees. Status sampled from another terminal during inference is a live
snapshot. Real events exposed a C6 wiring gap: aegis_read was visible but
blocked by the active Campaign gate. C6 now explicitly admits this read-only
transport; the tool still checks the current Task grant and real workspace
path. Provider tests assert the actual read result reaches the continuation,
and compare the run summary with an independent status subprocess after exit.
See E1_MAX_OPERATOR_STEPS.md for the code pilot; the smoke did not prove reading.
