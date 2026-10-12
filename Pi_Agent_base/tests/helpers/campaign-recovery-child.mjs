#!/usr/bin/env node
// Aegis C1 Integration — recovery child harness (REAL EventLog).
//
// Usage: node campaign-recovery-child.mjs <workDir> <scenario>
//   scenario ∈ intent_then_effect | intent_no_effect | recover | delayed | long
//
// REAL EventLog (append + fsync + hash chain). Synthetic Worker/Oracle. Real
// local effect files (per-task sentinel). SIGTERM is handled (graceful drain);
// SIGKILL is abrupt.
//
// Env:
//   AEGIS_KILL_AFTER_EFFECT=1  SIGKILL self right after the worker effect
//   AEGIS_KILL_AFTER_INTENT=1  SIGKILL self right after the durable intent

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildFixtureCampaign,
	createCampaignScheduler,
	FIXTURE_SCOPE,
	projectQueueFromEvents,
} from "../../memory/campaign/index.mjs";
import { EventLog } from "../../memory/runtime/events.mjs";

const [workDir, scenario = "recover"] = process.argv.slice(2);
mkdirSync(workDir, { recursive: true });
const eventsPath = join(workDir, "events.jsonl");
const summaryPath = join(workDir, "summary.json");

const fixture = buildFixtureCampaign();
const manifest = fixture.manifest;
const taskA = manifest.tasks[0];

const log = new EventLog(eventsPath);
const opened = await log.open();
if (!opened.ok) {
	process.stderr.write(`eventlog open failed: ${opened.error}\n`);
	process.exit(3);
}
const sink = {
	async append(event) {
		const result = await log.append({
			event_type: event.event_type,
			episode_id: event.episode_id,
			payload: event.payload,
			source: event.source,
		});
		if (
			result.ok &&
			scenario === "intent_no_effect" &&
			event.payload.kind === "campaign.task.started" &&
			process.env.AEGIS_KILL_AFTER_INTENT
		) {
			process.kill(process.pid, "SIGKILL");
		}
		return result;
	},
	replay: () => log.replay(),
};

function sentinelPath(taskId) {
	return join(workDir, `effect-${taskId}.txt`);
}
function effectExists(taskId) {
	return existsSync(sentinelPath(taskId));
}
function artifactsForAll() {
	const out = {};
	for (const id of [taskA.task_id, manifest.tasks[1]?.task_id, "task-dyn-1"]) {
		if (id) out[`artifact:${id}`] = { ref_id: `artifact:${id}`, digest: `sha256:syn-${id}` };
	}
	return out;
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
		scope: { ...FIXTURE_SCOPE },
		oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
		provenance: { source: "oracle", independent: true, task_id: taskId },
		evidence_refs: bound ? [{ ref_type: "artifact", ref_id: `artifact:${taskId}` }] : [],
		...extra,
	};
}

function stageJudgments(task, status) {
	return (task?.stages ?? [])
		.filter((st) => st.required !== false)
		.map((st) => ({
			step_id: st.stage_id,
			status,
			outcome_id: `so-${task.task_id}-${st.stage_id}`,
			outcome: {
				outcome_id: `so-${task.task_id}-${st.stage_id}`,
				level: "step",
				step_id: st.stage_id,
				status,
				episode_id: `ep-${task.task_id}`,
				task_id: task.task_id,
				criterion: { criterion_id: st.criteria?.[0] ?? null, expected: st.criteria?.[0] ?? null },
				observed: { synthetic: true },
				scope: { ...FIXTURE_SCOPE },
				oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
				provenance: { source: "oracle", independent: true, task_id: task.task_id, stage_id: st.stage_id },
				evidence_refs: [{ ref_type: "artifact", ref_id: `artifact:${task.task_id}` }],
			},
		}));
}

let workerCalls = 0;
const judgeCalls = {};
const oracle = {
	id: "synthetic.oracle",
	async judge({ task }) {
		judgeCalls[task.task_id] = (judgeCalls[task.task_id] ?? 0) + 1;
		if (scenario === "delayed" && judgeCalls[task.task_id] === 1) {
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
			stage_outcomes: stageJudgments(task, "success"),
			outcome: boundOutcome(task.task_id, task, "success"),
		};
	},
	async reconcile({ task }) {
		// Read the REAL effect sentinel.
		if (effectExists(task.task_id)) {
			return {
				status: "success",
				outcome_id: `o-${task.task_id}`,
				outcome: boundOutcome(task.task_id, task, "success"),
				effect_exists: true,
			};
		}
		return { status: "unknown", failure_mode: "effect_absent", effect_exists: false };
	},
};

function makeScheduler() {
	return createCampaignScheduler({
		manifest,
		ownedTasks: [taskA],
		baseDir: join(workDir, "runtime"),
		sink,
		artifacts: artifactsForAll(),
		worker: {
			async run({ task }) {
				workerCalls += 1;
				// Real effect file.
				writeFileSync(sentinelPath(task.task_id), `effect:${task.task_id}\n`);
				if (process.env.AEGIS_KILL_AFTER_EFFECT && task.task_id === taskA.task_id) {
					process.kill(process.pid, "SIGKILL");
				}
				return { ok: true, outcome_ref: `artifact:${task.task_id}` };
			},
		},
		oracle,
		clock: () => 1000,
		ownerId: `child-${process.pid}-${scenario}`,
	});
}

function projectNow() {
	return projectQueueFromEvents({
		campaign_id: manifest.campaign_id,
		tasks: [taskA],
		events: log.replay(),
		manifest,
		artifacts: artifactsForAll(),
	});
}

if (
	scenario === "intent_then_effect" ||
	scenario === "intent_no_effect" ||
	scenario === "delayed" ||
	scenario === "long"
) {
	const scheduler = makeScheduler();
	if (scenario === "long") {
		// Install a SIGTERM handler that drains and exits cleanly.
		process.on("SIGTERM", async () => {
			scheduler.releaseOwnership();
			await log.close();
			process.exit(0);
		});
		// Stay alive so an external kill can land.
		await new Promise((resolve) => setTimeout(resolve, 8000));
		await log.close();
		process.exit(0);
	}
	await scheduler.run();
	scheduler.releaseOwnership();
	if (scenario === "delayed") {
		const projection = projectNow();
		writeFileSync(
			summaryPath,
			JSON.stringify({
				scenario,
				worker_calls: workerCalls,
				delayed_unknown_visible: projection.tasks[0].state === "completed" || projection.tasks[0].state === "unknown",
				late_judgment_advanced: projection.tasks[0].state === "completed",
			}),
		);
	}
	await log.close();
	process.exit(0);
}

if (scenario === "recover") {
	// A new scheduler reconciles a stranded intent WITHOUT re-running the worker.
	const before = workerCalls;
	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks: [taskA],
		baseDir: join(workDir, "runtime"),
		sink,
		artifacts: artifactsForAll(),
		worker: {
			async run({ task }) {
				workerCalls += 1;
				writeFileSync(sentinelPath(task.task_id), `effect:${task.task_id}\n`);
				return { ok: true, outcome_ref: `artifact:${task.task_id}` };
			},
		},
		oracle,
		clock: () => 1000,
		ownerId: `child-recover-${process.pid}`,
	});
	await scheduler.run();
	scheduler.releaseOwnership();
	const projection = projectNow();
	const kinds = log.replay().map((e) => e.payload.kind);
	writeFileSync(
		summaryPath,
		JSON.stringify({
			scenario,
			worker_rerun: workerCalls - before,
			reconciled_outcome:
				kinds.includes("campaign.reconciliation.resolved") && projection.tasks[0].task_state !== "running",
			effect_exists: effectExists(taskA.task_id),
			task_state: projection.tasks[0].state,
		}),
	);
	await log.close();
	process.exit(0);
}

process.stderr.write(`unknown scenario ${scenario}\n`);
process.exit(9);
void readFileSync;
