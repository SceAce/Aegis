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

E1 code operator result (2026-10-14), product baseline `ac3220c`: user-run code
completed with 3 requests, Oracle success and zero pending/unresolved; independent
status agrees. Actual initial source reached the tool-result message, one Broker
file write produced the repair, and the 40-event chain verifies. Independent
verification confirms unchanged Manifest/config/frozen-test identities and the
existing registered-test harness passes with the expected digest and an empty
environment (exit 0, no new provider calls). Both pilots used 6 real requests.
Next select a user-project task within the scoped single-file read/write workflow,
with its own frozen Oracle and budget. Multi-file tooling, generic shell, a model
test-feedback repair loop and learning efficacy are not established by this sample.
Keep private attempts unchanged; do not rerun paid samples on the user's behalf.

Current authorized implementation (2026-10-14):
`../docs/E1_OBSERVABLE_PLANNING_TASK.md`, its test matrix and DS prompt define
the next bounded engineering phase. Expose actual Board nodes and evidence plus
task hierarchy/dependencies in the existing observation view, then wire a
distinct LLM plan through the same C6 request gate, Host admission and Scheduler.
The assignment authorizes the small additive planning/config/event contracts
needed by this path. Preserve the three lifecycle facts, old configs and private
operator attempts. Use real SDK + faux and local Oracle evidence; paid planning
and CTF tool/target adaptation remain later user-operated steps. This assignment
does not authorize Pi-core edits, real credentials/config edits, new dependencies,
generic shell/attack tooling or real provider/target calls.

E1 external acceptance (2026-10-14), product baseline `c9ed6b4`: see
`../docs/E1_OBSERVABLE_PLANNING_EXTERNAL_REVIEW.md`. Status is
**changes_required** for automatic planning/execution. Original 18 C6, 26
regressions, 8 affected and 4 E1 scripts pass; the new real-product acceptance
suite `tests/aegis-e1-external-review.mjs` is 4 pass / 13 fail. Repair the
planning termination/independent Oracle activation gate, frozen planner
input/template binding, and observation's trusted evidence/state projection.
Unknown planning can currently dispatch children both live and after restart.
Keep the accepted C6 request accounting scope; no paid provider or CTF run was
performed by this audit. These red tests are regression evidence, not a claim
that implementation passed.

E1 task-A independent verification (2026-10-14), product baseline `bc93cca`:
see `../docs/E1_OBSERVABLE_PLANNING_EXTERNAL_REVIEW.md` section 8.2. The bounded
planning execution gate is accepted: actual planning termination, settlement,
whole admission, independent Oracle Outcomes and durable completion precede
ready. Unknown/error/aborted candidates cannot dispatch live or after restart.
External review is now 10 pass / 7 fail. Additional real-SDK tool-result writer
and Host EventLog ready-writer faults pass 2/2, including fresh-process restart
with zero provider calls/effects and preserved consumption. Include
`tests/aegis-e1-planning-gate-audit.mjs` in subsequent E1 focused checks.
Completed-without-ready remains held on restart; automatic gate repair is not
claimed. Overall E1 remains **changes_required**: do B (frozen actual planner
input and Host criterion templates, ER-06/07/13; malformed ER-14 alongside),
then C (truthful observation/Fact evidence and consistent plan digest,
ER-09/10/12), in separate bounded sessions. Keep the accepted A/C6 gates;
no paid planning or CTF run until the integrated acceptance passes.

Bounded DS handoff (2026-10-14): task B is
`../docs/E1_PLANNER_CONTRACT_REPAIR_DS_TASK.md`; after B is independently checked,
task C is `../docs/E1_OBSERVATION_REPAIR_DS_TASK.md`. Execute only the task named
by the operator in the current session, then hand back. Use the explicit
`../docs/E1_REPAIR_REQUIRED_CHECKS.json` groups; additional task-specific tests
are recorded separately. B expects ER-06/07/13/14 green while ER-09/10/12 may
remain red; C requires the integrated external 17/17. These documents preserve
the accepted A/C6 scope and limit context to the current contract/call sites.

Independent completion audit (2026-10-15), product baseline `381829a`: see
`../docs/PROJECT_COMPLETION_AUDIT_20261015.md` and E1 external review section 12.
The required 59 scripts and FC/B/C repair 3 scripts pass; the new independent
`tests/aegis-completion-audit.mjs` is 3 pass / 9 fail. Overall E1 is
**changes_required**: Board still promotes outcomes rejected for scope,
criterion or evidence and indexes rejected admissions; Plan replay still
accepts missing planning identity and candidate/normalized identity mismatch.
A real ready-prefix subprocess restart with both planning ids absent produces
6 faux provider requests and 3 Broker effects. Preserve accepted C6/A gates.
Campaign tsc has 194 diagnostics (0 in Campaign modules); Batch-E has 186.
This audit changes tests/docs only and makes no paid provider/target calls.

E1 contract-closure round (2026-10-15), branch `fix/e1-contract-closure`, start
`852cc5e`, delivered HEAD `0d315e0`: see
`../docs/E1_CONTRACT_CLOSURE_IMPLEMENTATION_REPORT.md`. Implements the trusted
`planning_contract` embedded in the immutable Manifest, the ONE
`normalizeExecutableTask` shape, one effective plan with cumulative
`allocation_total`, the §6.1 Host plan-command result and shared candidate
dedup, the durable dual-sided `c6.tool` charge, and a shared campaign
`authority` consumed by Board/RAM/E1-view/learning (fail-closed without
context). The four new required scripts `aegis-e1-closure-{contract,admission,
judgments,recovery}` are 18/11/11/10 cases. All 68 required unique scripts exit 0;
the independent completion audit is now 12/12 (was 3/9) and the history audit
4/4 (was 1/3), with no assertion changed. Type baselines unchanged (Campaign
194, Batch-E 186, both exit 1 as before). Overall status is **changes_required**:
the wall-time durable anchor (T-A16), SDK sequential tool ordering, read/submit
tool charging, tool-charge SIGKILL barrier, the explicit `full_replay_required`
code and a per-consumer E1 verification remain open (report §8). Development
checks call no real provider or target.
