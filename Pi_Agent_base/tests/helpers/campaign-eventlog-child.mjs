#!/usr/bin/env node
// Real-EventLog child harness for C1 closure durability tests.
//
// Usage: node campaign-eventlog-child.mjs <workDir> [complete]
//
// Uses the REAL `shared/events.mjs` EventLog (append + fsync + hash
// chain), not a synthetic file sink. It:
//   1. opens the log;
//   2. appends a durable `campaign.task.started` (fsynced);
//   3. records ONE side effect (counter file);
//   4. if `AEGIS_KILL_SELF_AFTER_MS` is set, SIGKILLs itself after that delay so
//      the parent observes that the durable intent survived the crash.
// With `complete`, it also appends the oracle result + completion so a parent can
// replay the chain.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFixtureCampaign, FIXTURE_SCOPE } from "../../campaign/index.mjs";
import { EventLog } from "../../shared/events.mjs";

const [workDir, mode = "intent"] = process.argv.slice(2);
mkdirSync(workDir, { recursive: true });
const eventsPath = join(workDir, "events.jsonl");
const effectsPath = join(workDir, "effects.json");

function bumpEffects() {
	const next = existsSync(effectsPath) ? (JSON.parse(readFileSync(effectsPath, "utf8")).effects ?? 0) + 1 : 1;
	writeFileSync(effectsPath, JSON.stringify({ effects: next }));
	return next;
}

if (process.env.AEGIS_KILL_SELF_AFTER_MS) {
	const ms = Number(process.env.AEGIS_KILL_SELF_AFTER_MS);
	setTimeout(() => process.kill(process.pid, "SIGKILL"), ms);
}

const fixture = buildFixtureCampaign();
const manifest = fixture.manifest;
const taskId = manifest.tasks[0].task_id;

const log = new EventLog(eventsPath);
const opened = await log.open();
if (!opened.ok) {
	process.stderr.write(`event log open failed: ${opened.error}\n`);
	process.exit(3);
}

// 1. Durable intent (fsynced by the real EventLog).
const started = await log.append({
	event_type: "runtime.note",
	source: { kind: "runtime", actor_id: "child" },
	payload: {
		kind: "campaign.task.started",
		campaign_id: manifest.campaign_id,
		task_id: taskId,
		episode_id: `ep-${taskId}`,
		command_id: `start-${taskId}`,
		expected_revision: manifest.revision,
	},
});
if (!started.ok) {
	process.stderr.write(`durable intent failed: ${started.error}\n`);
	process.exit(4);
}

// 2. Side effect AFTER the durable intent.
bumpEffects();

if (mode === "complete") {
	// A stage-level result for EVERY required stage (F3).
	for (const stage of manifest.tasks[0].stages ?? []) {
		await log.append({
			event_type: "runtime.note",
			source: { kind: "oracle", actor_id: "child-oracle" },
			payload: {
				kind: "campaign.oracle.result",
				campaign_id: manifest.campaign_id,
				task_id: taskId,
				outcome_id: `so-child-${stage.stage_id}`,
				status: "success",
				step_id: stage.stage_id,
				episode_id: `ep-${taskId}`,
				outcome: {
					outcome_id: `so-child-${stage.stage_id}`,
					level: "step",
					step_id: stage.stage_id,
					status: "success",
					episode_id: `ep-${taskId}`,
					task_id: taskId,
					criterion: { criterion_id: stage.criteria[0], expected: stage.criteria[0] },
					observed: { synthetic: true },
					scope: { ...FIXTURE_SCOPE },
					oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
					provenance: { source: "oracle", independent: true, task_id: taskId, stage_id: stage.stage_id },
					evidence_refs: [{ ref_type: "artifact", ref_id: `artifact:${taskId}` }],
				},
			},
		});
	}
	await log.append({
		event_type: "runtime.note",
		source: { kind: "oracle", actor_id: "child-oracle" },
		payload: {
			kind: "campaign.oracle.result",
			campaign_id: manifest.campaign_id,
			task_id: taskId,
			outcome_id: "o-child",
			status: "success",
			task_oracle: true,
			episode_id: `ep-${taskId}`,
			outcome: {
				outcome_id: "o-child",
				level: "episode",
				status: "success",
				episode_id: `ep-${taskId}`,
				task_id: taskId,
				task_oracle: true,
				criterion: { criterion_id: manifest.tasks[0].goal.goal_id, expected: manifest.tasks[0].goal.goal_id },
				observed: { synthetic: true },
				scope: { ...FIXTURE_SCOPE },
				oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
				provenance: { source: "oracle", independent: true, task_id: taskId },
				evidence_refs: [{ ref_type: "artifact", ref_id: `artifact:${taskId}` }],
			},
		},
	});
	await log.append({
		event_type: "runtime.note",
		source: { kind: "runtime", actor_id: "child" },
		payload: {
			kind: "campaign.task.completed",
			campaign_id: manifest.campaign_id,
			task_id: taskId,
			outcome_id: "o-child",
		},
	});
}

await log.close();

if (mode === "complete") process.exit(0);
// Intent mode: stay alive so the parent's SIGKILL lands AFTER the effect,
// proving the durable intent survived a crash (not a clean exit).
setTimeout(() => process.exit(0), 5000);
