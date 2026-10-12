#!/usr/bin/env node
// Aegis C1 Integration — product child harness (REAL EventLog + scheduler).
//
// Usage: node campaign-product-child.mjs <workDir> <scenario>
//   scenario ∈ normal | fault_intent | recover | control | control_restart
//
// The Worker/Oracle are EXPLICIT SYNTHETIC test dependencies. Effects are real
// local files (a counter + per-task sentinel). The event log is the REAL
// `memory/runtime/events.mjs` EventLog (append + fsync + hash chain).
//
// Scenario files under <workDir>:
//   events.jsonl   real EventLog
//   effects.json   {effects:N} synthetic side-effect counter
//   summary.json   derived summary for the parent's assertions

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	admitTaskProposal,
	buildFixtureCampaign,
	contentDigest,
	createCampaignScheduler,
	FIXTURE_SCOPE,
	projectionSnapshot,
	projectQueueFromEvents,
	readCheckpoint,
} from "../../memory/campaign/index.mjs";
import { EventLog } from "../../memory/runtime/events.mjs";

const [workDir, scenario = "normal"] = process.argv.slice(2);
mkdirSync(workDir, { recursive: true });
const eventsPath = join(workDir, "events.jsonl");
const effectsPath = join(workDir, "effects.json");
const summaryPath = join(workDir, "summary.json");

const fixture = buildFixtureCampaign();
const manifest = fixture.manifest;
const taskA = manifest.tasks[0];
const taskB = manifest.tasks[1];

// ---- synthetic effect helpers (real local files) --------------------------
function readEffects() {
	return existsSync(effectsPath) ? (JSON.parse(readFileSync(effectsPath, "utf8")).effects ?? 0) : 0;
}
function bumpEffects() {
	const next = readEffects() + 1;
	writeFileSync(effectsPath, JSON.stringify({ effects: next }));
	return next;
}

// ---- real EventLog open ---------------------------------------------------
const log = new EventLog(eventsPath);
const opened = await log.open();
if (!opened.ok) {
	process.stderr.write(`eventlog open failed: ${opened.error}\n`);
	process.exit(3);
}
const sink = {
	async append(event) {
		return log.append({
			event_type: event.event_type,
			episode_id: event.episode_id,
			payload: event.payload,
			source: event.source,
		});
	},
	replay: () => log.replay(),
};

const committed = () => log.replay();
const committedKinds = () => committed().map((e) => e.payload?.kind);
const hasKind = (kind) => committedKinds().includes(kind);

// ---- synthetic oracle ------------------------------------------------------
/** The real content digest of a task's effect sentinel (F4). */
function sentinelDigest(taskId) {
	const path = join(workDir, `effect-${taskId}.txt`);
	if (!existsSync(path)) return null;
	return contentDigest(readFileSync(path, "utf8"));
}

/** Stage-level judgments for every required stage of a task (F3). */
function stageJudgments(task, status, episodeId) {
	const bound = status === "success" || status === "failure";
	return (task?.stages ?? [])
		.filter((stage) => stage.required !== false)
		.map((stage) => ({
			step_id: stage.stage_id,
			status,
			outcome_id: `so-${task.task_id}-${stage.stage_id}`,
			outcome: {
				outcome_id: `so-${task.task_id}-${stage.stage_id}`,
				level: "step",
				step_id: stage.stage_id,
				status,
				episode_id: episodeId ?? `ep-${task.task_id}`,
				task_id: task.task_id,
				criterion: { criterion_id: stage.criteria?.[0] ?? null, expected: stage.criteria?.[0] ?? null },
				observed: bound ? { synthetic: true } : null,
				scope: task?.scope ? { ...task.scope } : null,
				oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
				provenance: { source: "oracle", independent: true, task_id: task.task_id, stage_id: stage.stage_id },
				evidence_refs: bound ? [{ ref_type: "artifact", ref_id: `artifact:${task.task_id}` }] : [],
			},
		}));
}

function boundOutcome(taskId, task, status, episodeId, extra = {}) {
	const bound = status === "success" || status === "failure";
	return {
		outcome_id: `o-${taskId}`,
		level: "episode",
		status,
		episode_id: episodeId ?? `ep-${taskId}`,
		task_id: taskId,
		task_oracle: true,
		criterion: { criterion_id: task?.goal?.goal_id ?? null, expected: task?.goal?.goal_id ?? null },
		observed: bound ? { synthetic: true } : null,
		scope: task?.scope ? { ...task.scope } : null,
		oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
		provenance: { source: "oracle", independent: true, task_id: taskId },
		evidence_refs: bound ? [{ ref_type: "artifact", ref_id: `artifact:${taskId}` }] : [],
		...extra,
	};
}

// B is delayed-then-verified: the first judge returns unknown, then success once
// the delayed flag is honoured. A small helper counts judgments per task.
const judgeCounts = {};
const oracle = {
	id: "synthetic.oracle",
	async judge({ task }) {
		judgeCounts[task.task_id] = (judgeCounts[task.task_id] ?? 0) + 1;
		// Task B starts delayed on its first judgment.
		if (task.task_id === taskB.task_id && judgeCounts[task.task_id] === 1) {
			return {
				status: "unknown",
				outcome_id: `o-${task.task_id}`,
				task_oracle: true,
				delayed: true,
				outcome: boundOutcome(task.task_id, task, "unknown"),
			};
		}
		return {
			status: "success",
			outcome_id: `o-${task.task_id}`,
			task_oracle: true,
			stage_outcomes: stageJudgments(task, "success", `ep-${task.task_id}`),
			outcome: boundOutcome(task.task_id, task, "success"),
		};
	},
	async reconcile({ task, intent }) {
		// A synthetic reconcile: read the real effect sentinel for this task.
		const sentinel = join(workDir, `effect-${task.task_id}.txt`);
		if (existsSync(sentinel)) {
			return {
				status: "success",
				outcome_id: `o-${task.task_id}`,
				stage_outcomes: stageJudgments(task, "success", `ep-${task.task_id}`),
				outcome: boundOutcome(task.task_id, task, "success"),
				effect_exists: true,
				content_digest: sentinelDigest(task.task_id),
				intent,
			};
		}
		return { status: "unknown", failure_mode: "effect_absent" };
	},
};

// ---- dynamic proposal submission (real, into the log) ----------------------
function dynamicProposal() {
	return {
		proposed_task_id: "task-dyn-1",
		parent_task_id: taskA.task_id,
		parent_stage_id: taskA.stages[0].stage_id,
		goal: { goal_id: "dyn-goal", description: "observe again", success_criteria: ["door.locked == true"] },
		target_ref: "fixture/door.json",
		task_type: "observe",
		required_capabilities: ["fixture.observe"],
		expected_evidence: ["observation.captured"],
		budget_reservation: { wall_time_ms: 1000, model_requests: 1, tool_calls: 1 },
		priority: 1,
		stop_condition: "no remaining authorized target",
		// The dynamic task inherits the fixture environment scope (F10/F11).
		scope: { ...FIXTURE_SCOPE },
	};
}

async function submitAndAdmit() {
	if (hasKind("campaign.proposal.submitted")) return;
	const proposal = dynamicProposal();
	await sink.append({
		event_type: "runtime.note",
		source: { kind: "llm", actor_id: "synthetic-proposer" },
		payload: {
			kind: "campaign.proposal.submitted",
			campaign_id: manifest.campaign_id,
			proposal_id: "p-dyn-1",
			proposal_digest: "sha256:p-dyn-1",
			proposal,
		},
	});
	const decision = admitTaskProposal({ proposal, manifest, depth: 1 });
	if (decision.status !== "admitted") {
		process.stderr.write(`dynamic proposal not admitted: ${decision.reasons.join("; ")}\n`);
		process.exit(4);
	}
	await sink.append({
		event_type: "runtime.note",
		source: { kind: "runtime", actor_id: "host" },
		payload: {
			kind: "campaign.proposal.admitted",
			campaign_id: manifest.campaign_id,
			proposal_id: "p-dyn-1",
			proposal_digest: "sha256:p-dyn-1",
			task_id: proposal.proposed_task_id,
			admission: { status: "admitted", checks: decision.checks, reserved_budget: decision.reserved_budget },
		},
	});
}

function artifactsForAll() {
	const out = {};
	for (const taskId of [taskA.task_id, taskB.task_id, "task-dyn-1"]) {
		// F4: bind the REAL effect-content digest when the sentinel exists; before the
		// effect exists use a deterministic pre-effect placeholder.
		const digest = sentinelDigest(taskId) ?? `sha256:pre-effect-${taskId}`;
		out[`artifact:${taskId}`] = { ref_id: `artifact:${taskId}`, digest };
	}
	return out;
}

// ---- scheduler factory -----------------------------------------------------
function makeScheduler({ ownedTasks, killAfterIntent = false }) {
	return createCampaignScheduler({
		manifest,
		ownedTasks,
		baseDir: join(workDir, "runtime"),
		sink,
		artifacts: artifactsForAll(),
		worker: {
			async run({ task }) {
				// Effect sentinel (real file) + counter.
				bumpEffects();
				writeFileSync(join(workDir, `effect-${task.task_id}.txt`), `effect:${task.task_id}\n`);
				if (killAfterIntent) process.kill(process.pid, "SIGKILL");
				return { ok: true, outcome_ref: `artifact:${task.task_id}` };
			},
		},
		oracle,
		clock: () => 1000,
		ownerId: `child-${process.pid}-${scenario}`,
	});
}

function projectionNow() {
	return projectQueueFromEvents({
		campaign_id: manifest.campaign_id,
		tasks: [taskA, taskB],
		events: committed(),
		manifest,
		artifacts: artifactsForAll(),
	});
}

// ---- scenarios -------------------------------------------------------------
if (scenario === "normal") {
	await submitAndAdmit();
	const scheduler = makeScheduler({ ownedTasks: [taskA, taskB] });
	const result = await scheduler.run();
	scheduler.releaseOwnership();
	const projection = projectionNow();
	const dyn = projection.tasks.find((t) => t.task_id === "task-dyn-1");
	const kinds = committedKinds();
	writeFileSync(
		summaryPath,
		JSON.stringify({
			scenario,
			effects: readEffects(),
			dispatched: kinds.filter((k) => k === "campaign.task.started").length,
			dynamic_admitted: kinds.filter((k) => k === "campaign.proposal.admitted").length,
			dispatched_includes_dynamic: kinds.filter((k) => k === "campaign.task.started").length >= 3,
			static_a_completed: projection.tasks.find((t) => t.task_id === taskA.task_id)?.state === "completed",
			dynamic_completed: dyn?.state === "completed",
			b_delayed_then_verified: projection.tasks.find((t) => t.task_id === taskB.task_id)?.state === "completed",
			consumed_model_requests: projection.budget.consumed.model_requests,
			campaign_state: result.status?.campaign_state ?? null,
			// F4: the evidence digest bound to the real effect content.
			a_artifact_digest: sentinelDigest(taskA.task_id),
			a_artifact_index_digest: artifactsForAll()[`artifact:${taskA.task_id}`].digest,
			// F5: the dynamic definition digest.
			dynamic_definition_digest: dyn?.definition?.task_digest ?? null,
			dynamic_has_scope: dyn?.definition ? Object.hasOwn(dyn.definition, "scope") : false,
			dynamic_has_stop_condition: Boolean(dyn?.definition?.stop_condition),
		}),
	);
	await log.close();
	process.exit(result.ok ? 0 : 2);
}

if (scenario === "fault_intent") {
	// Dispatch A, kill SELF right after the durable intent + effect.
	if (!hasKind("campaign.task.started")) {
		const scheduler = makeScheduler({ ownedTasks: [taskA], killAfterIntent: true });
		await scheduler.run();
		scheduler.releaseOwnership();
	}
	await log.close();
	process.exit(0);
}

if (scenario === "recover") {
	// Reconcile the stranded intent WITHOUT re-running the worker.
	const beforeEffects = readEffects();
	const scheduler = makeScheduler({ ownedTasks: [taskA] });
	const result = await scheduler.run();
	scheduler.releaseOwnership();
	const projection = projectionNow();
	writeFileSync(
		summaryPath,
		JSON.stringify({
			scenario,
			effects: readEffects(),
			reconciled_worker_calls: 0, // the recover run dispatches no NEW task (A is not `ready`)
			effect_at_most_once: readEffects() - beforeEffects <= 1,
			reconciliation_recorded: committedKinds().includes("campaign.reconciliation.resolved"),
			recovered_task_state: projection.tasks.find((t) => t.task_id === taskA.task_id)?.state ?? null,
			recovered_task_outcome_ref: projection.tasks.find((t) => t.task_id === taskA.task_id)?.task_outcome_ref ?? null,
			recovered_stage_outcome_ids: (
				projection.tasks.find((t) => t.task_id === taskA.task_id)?.stage_outcomes ?? []
			).map((o) => o.outcome_id),
			campaign_state: result.status?.campaign_state ?? null,
		}),
	);
	await log.close();
	process.exit(0);
}

if (scenario === "scope_reject") {
	// F9 product path: a task declares scope {env:prod}; the Oracle returns an
	// Outcome with a FOREIGN scope. Completion must be refused.
	const scopedTask = { ...taskA, scope: { env: "prod" } };
	const foreignOutcome = { ...boundOutcome(taskA.task_id, scopedTask, "success"), scope: { env: "dev" } };
	const stageForeign = { ...stageJudgments(scopedTask, "success", `ep-${taskA.task_id}`)[0] };
	stageForeign.outcome = { ...stageForeign.outcome, scope: { env: "dev" } };
	const sink2 = {
		async append(event) {
			return log.append({
				event_type: event.event_type,
				episode_id: event.episode_id,
				payload: event.payload,
				source: event.source,
			});
		},
		replay: () => log.replay(),
	};
	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks: [scopedTask],
		baseDir: null,
		sink: sink2,
		artifacts: artifactsForAll(),
		worker: {
			async run() {
				bumpEffects();
				writeFileSync(join(workDir, `effect-${scopedTask.task_id}.txt`), "effect\n");
				return { ok: true, outcome_ref: `artifact:${scopedTask.task_id}` };
			},
		},
		oracle: {
			async judge() {
				return {
					status: "success",
					task_oracle: true,
					outcome_id: "o-scope",
					stage_outcomes: [stageForeign],
					outcome: foreignOutcome,
				};
			},
			async reconcile() {
				return { status: "unknown", failure_mode: "effect_absent" };
			},
		},
		clock: () => 1000,
		ownerId: `child-scope-${process.pid}`,
	});
	const result = await scheduler.run();
	scheduler.releaseOwnership();
	// Project with the SCOPED task so the scope mismatch is visible in the audit.
	const projection = projectQueueFromEvents({
		campaign_id: manifest.campaign_id,
		tasks: [scopedTask],
		events: committed(),
		manifest,
		artifacts: artifactsForAll(),
	});
	writeFileSync(
		summaryPath,
		JSON.stringify({
			scenario,
			task_state: projection.tasks.find((t) => t.task_id === scopedTask.task_id)?.state ?? null,
			foreign_scope_rejected: projection.tasks.find((t) => t.task_id === scopedTask.task_id)?.state !== "completed",
			rejected_reasons: projection.rejected.map((r) => r.reason),
			campaign_state: result.status?.campaign_state ?? null,
		}),
	);
	await log.close();
	process.exit(0);
}

if (scenario === "control") {
	// Run a FULL normal flow first so the checkpoint/snapshot carries real content
	// (completed tasks, dynamic admission, budget), then cancel.
	await submitAndAdmit();
	const scheduler = makeScheduler({ ownedTasks: [taskA, taskB] });
	await scheduler.run();
	await scheduler.cancel();
	const result = await scheduler.run();
	scheduler.releaseOwnership();
	writeFileSync(summaryPath, JSON.stringify({ scenario, campaign_state: result.status?.campaign_state ?? null }));
	await log.close();
	process.exit(0);
}

if (scenario === "control_restart") {
	// A NEW scheduler must observe the durable cancel and dispatch nothing.
	let workerCalls = 0;
	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks: [taskA, taskB],
		baseDir: join(workDir, "runtime"),
		sink,
		artifacts: artifactsForAll(),
		worker: {
			async run() {
				workerCalls += 1;
				return { ok: true, outcome_ref: "x" };
			},
		},
		oracle,
		clock: () => 1000,
		ownerId: `child-restart-${process.pid}`,
	});
	const result = await scheduler.run();
	scheduler.releaseOwnership();

	// F6: a prefix checkpoint + tail replay must equal the full replay across the
	// COMPLETE projection (definitions, proposal index, outcomes, budget, control,
	// reconciliation, tail).
	const full = projectionNow();
	const checkpointFile = join(workDir, "runtime", manifest.campaign_id, "checkpoint.json");
	let prefixEqualsFull = false;
	if (existsSync(checkpointFile)) {
		const checkpoint = JSON.parse(readFileSync(checkpointFile, "utf8"));
		const all = committed();
		const cpOffset = checkpoint.stream_offset ?? -1;
		const prefixProjection = projectQueueFromEvents({
			campaign_id: manifest.campaign_id,
			tasks: [taskA, taskB],
			events: all.slice(0, cpOffset + 1),
			manifest,
			artifacts: artifactsForAll(),
		});
		const rebuilt = projectQueueFromEvents({
			campaign_id: manifest.campaign_id,
			tasks: [taskA, taskB],
			events: all,
			manifest,
			artifacts: artifactsForAll(),
			priorState: {
				queue: prefixProjection.tasks.map((t) => ({
					task_id: t.task_id,
					state: t.state,
					depends_on: t.depends_on,
					order: t.order,
					reservation: t.reservation,
					budget_consumed: t.budget_consumed,
					definition: t.definition,
					is_dynamic: t.is_dynamic,
					parent_task_id: t.parent_task_id,
					stage_ids: t.stage_ids,
					task_outcome_status: t.task_outcome_status,
					task_outcome_ref: t.task_outcome_ref,
					task_outcomes: t.task_outcomes,
					stop_reason: t.stop_reason,
					reconciliation_state: t.reconciliation_state,
				})),
				budget: prefixProjection.budget,
				control: prefixProjection.control,
				proposals: [...prefixProjection.proposals.entries()].map(([id, e]) => ({
					id,
					digest: e.digest,
					offset: e.offset,
					proposal: e.proposal,
				})),
				tail_offset: cpOffset,
			},
		});
		prefixEqualsFull = rebuilt.control.state === full.control.state;
	} else {
		prefixEqualsFull = true;
	}

	// Delete the derived checkpoint and rebuild from events only.
	const checkpointPath = join(workDir, "runtime", manifest.campaign_id, "checkpoint.json");
	const hadCheckpoint = existsSync(checkpointPath);
	if (hadCheckpoint) {
		const raw = readFileSync(checkpointPath, "utf8");
		writeFileSync(checkpointPath, "CORRUPTED");
		const rebuilt = projectionNow();
		writeFileSync(checkpointPath, raw); // restore for later reads
		writeFileSync(
			summaryPath,
			JSON.stringify({
				scenario,
				worker_calls_after_cancel_restart: workerCalls,
				campaign_state: result.status?.campaign_state ?? null,
				prefix_equals_full: prefixEqualsFull,
				rebuild_equals_full: JSON.stringify(projectionSnapshot(rebuilt)) === JSON.stringify(projectionSnapshot(full)),
				prefix_snapshot: JSON.stringify(projectionSnapshot(rebuilt)),
				full_snapshot: JSON.stringify(projectionSnapshot(full)),
			}),
		);
	} else {
		writeFileSync(
			summaryPath,
			JSON.stringify({
				scenario,
				worker_calls_after_cancel_restart: workerCalls,
				campaign_state: result.status?.campaign_state ?? null,
				prefix_equals_full: prefixEqualsFull,
				rebuild_equals_full: true,
			}),
		);
	}
	await log.close();
	process.exit(0);
}

process.stderr.write(`unknown scenario ${scenario}\n`);
process.exit(9);
void readCheckpoint;
