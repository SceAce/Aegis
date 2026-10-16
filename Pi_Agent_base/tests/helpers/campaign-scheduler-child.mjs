#!/usr/bin/env node
// Recovery child harness for C1-E.
//
// SYNTHETIC FILE SINK — NOT a real EventLog. This harness writes the event JSONL
// with `writeFileSync` concatenation and does NOT fsync. It exercises the
// SCHEDULER CONTROL FLOW (durable-before-dispatch, unknown/reconcile, no blind
// rerun) across a real SIGKILL, but it does NOT prove EventLog fsync durability.
// The real-EventLog durability boundary is proven separately in
// `aegis-campaign-c1-eventlog-durability.mjs`.
//
// Usage: node campaign-scheduler-child.mjs <workDir> <boundary>
//   boundary ∈ none | before_intent | after_intent | after_result | reconcile
//
// Env:
//   AEGIS_KILL_SELF_AFTER_MS  when set, SIGKILL self after N ms (crash injection)
//
// A file-backed event sink makes the "crash" observable across processes:
//   <workDir>/events.jsonl   append-only committed events
//   <workDir>/effects.json   {"effects": N} side-effect counter (the "target")
//   <workDir>/summary.json   final projection summary
//
// The worker records a NON-IDEMPOTENT side effect (incrementing the counter)
// exactly once per dispatch. Reconcile mode must NOT increment it again.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildFixtureCampaign, createCampaignScheduler, FIXTURE_SCOPE } from "../../campaign/index.mjs";

const [workDir, boundary = "none"] = process.argv.slice(2);
mkdirSync(workDir, { recursive: true });
const eventsPath = join(workDir, "events.jsonl");
const effectsPath = join(workDir, "effects.json");
const summaryPath = join(workDir, "summary.json");

function readEvents() {
	if (!existsSync(eventsPath)) return [];
	return readFileSync(eventsPath, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}
function readEffects() {
	if (!existsSync(effectsPath)) return 0;
	return JSON.parse(readFileSync(effectsPath, "utf8")).effects ?? 0;
}
function bumpEffects() {
	const next = readEffects() + 1;
	writeFileSync(effectsPath, JSON.stringify({ effects: next }));
	return next;
}
function appendRaw(event) {
	const events = readEvents();
	const row = {
		...event,
		sequence: events.length,
		event_id: `e${events.length}`,
		event_digest: `sha256:e${events.length}`,
	};
	// Append-only, one line per event (fsync-less is fine: the OS keeps it across
	// a SIGKILL; this harness proves recovery, not power-loss durability).
	const existing = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "";
	writeFileSync(eventsPath, `${existing}${JSON.stringify(row)}\n`);
	return row;
}

if (process.env.AEGIS_KILL_SELF_AFTER_MS) {
	const ms = Number(process.env.AEGIS_KILL_SELF_AFTER_MS);
	setTimeout(() => process.kill(process.pid, "SIGKILL"), ms);
}

const fixture = buildFixtureCampaign();
const manifest = fixture.manifest;

// `AEGIS_OWNED=single` runs only the first static task (unambiguous recovery
// counting). The default (`full`) runs both static tasks plus one dynamic task.
const ownedMode = process.env.AEGIS_OWNED ?? "full";

// One extra bounded dynamic task for END-01.
const dynamicTask = {
	task_id: "task-dyn-child-1",
	order: 3,
	depends_on: [],
	target_ref: "fixture/door.json",
	task_type: "observe",
	goal: { goal_id: "observe_again", description: "observe again", success_criteria: ["door.locked == true"] },
	stages: [{ stage_id: "stage-dyn-child-1", criteria: ["door.locked == true"], required: true }],
	scope: { ...FIXTURE_SCOPE },
	oracle_ref: "fixture.oracle.v1",
	task_budget: { wall_time_ms: 1000, model_requests: 1, tool_calls: 1 },
};
const ownedTasks = ownedMode === "single" ? [manifest.tasks[0]] : [...manifest.tasks, dynamicTask];

const existingEvents = readEvents();
const alreadyStarted = new Set(
	existingEvents.filter((e) => e.payload.kind === "campaign.task.started").map((e) => e.payload.task_id),
);
// Reconcile mode: a task whose intent is durable but whose result is missing is
// reconciled, NOT re-executed.
const reconcileMode = boundary === "reconcile";

const worker = {
	async run({ task }) {
		// If a durable intent exists but no committed result, this may already have
		// executed. In reconcile mode we must not run the non-idempotent effect.
		const hasResult = readEvents().some(
			(e) => e.payload.kind === "campaign.oracle.result" && e.payload.task_id === task.task_id,
		);
		if (reconcileMode && hasResult) return { ok: true, outcome_ref: `reconciled:${task.task_id}` };
		if (reconcileMode) {
			// Ask the Oracle/environment whether the effect actually happened instead
			// of blindly re-running. Here we treat the durable intent without a result
			// as an unresolved/unknown outcome.
			return { ok: false, failure_mode: "needs_reconciliation" };
		}
		const effects = bumpEffects();
		return { ok: true, outcome_ref: `artifact:${task.task_id}`, effects };
	},
};

const oracle = {
	id: "fixture.oracle.v1",
	async judge({ task }) {
		if (boundary === "after_intent" && task.task_id === fixture.manifest.tasks[0].task_id) {
			process.kill(process.pid, "SIGKILL");
		}
		// The delayed case stays unknown.
		if (task.task_id === fixture.manifest.tasks[1].task_id) {
			return {
				status: "unknown",
				outcome_id: `o-${task.task_id}`,
				task_oracle: true,
				delayed: true,
				outcome: {
					outcome_id: `o-${task.task_id}`,
					level: "episode",
					status: "unknown",
					episode_id: `ep-${task.task_id}`,
					task_id: task.task_id,
					task_oracle: true,
					criterion: { criterion_id: task.goal?.goal_id ?? null, expected: task.goal?.goal_id ?? null },
					observed: null,
					oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
					provenance: { source: "oracle", independent: true, task_id: task.task_id },
					evidence_refs: [],
				},
			};
		}
		const stageOutcomes = (task.stages ?? [])
			.filter((st) => st.required !== false)
			.map((st) => ({
				step_id: st.stage_id,
				status: "success",
				outcome_id: `so-${task.task_id}-${st.stage_id}`,
				outcome: {
					outcome_id: `so-${task.task_id}-${st.stage_id}`,
					level: "step",
					step_id: st.stage_id,
					status: "success",
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
		return {
			status: "success",
			outcome_id: `o-${task.task_id}`,
			task_oracle: true,
			stage_outcomes: stageOutcomes,
			outcome: {
				outcome_id: `o-${task.task_id}`,
				level: "episode",
				status: "success",
				episode_id: `ep-${task.task_id}`,
				task_id: task.task_id,
				task_oracle: true,
				criterion: { criterion_id: task.goal?.goal_id ?? null, expected: task.goal?.goal_id ?? null },
				observed: { synthetic: true },
				scope: { ...FIXTURE_SCOPE },
				oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
				provenance: { source: "oracle", independent: true, task_id: task.task_id },
				evidence_refs: [{ ref_type: "artifact", ref_id: `artifact:${task.task_id}` }],
			},
		};
	},
};

const sink = {
	async append(event) {
		// Crash/failure BEFORE the durable intent: the append itself fails, so the
		// scheduler must not dispatch the worker at all.
		if (boundary === "before_intent" && event.payload.kind === "campaign.task.started") {
			return { ok: false, error: "injected pre-intent append failure" };
		}
		const row = appendRaw(event);
		if (boundary === "after_result" && event.payload.kind === "campaign.oracle.result") {
			process.kill(process.pid, "SIGKILL");
		}
		return { ok: true, event: row, durable: true };
	},
	// The scheduler re-reads the committed log on each projection step so it sees
	// its own newly-committed events.
	replay() {
		return readEvents();
	},
};

const artifacts = {};
for (const task of ownedTasks)
	artifacts[`artifact:${task.task_id}`] = {
		ref_id: `artifact:${task.task_id}`,
		digest: `sha256:synthetic-${task.task_id}`,
	};
const scheduler = createCampaignScheduler({
	manifest,
	ownedTasks,
	baseDir: join(workDir, "runtime"),
	sink,
	worker,
	oracle,
	artifacts,
	clock: () => 1000,
	acquireOwnership: false,
});

const result = await scheduler.run();

// Summarize honestly for the parent assertions.
const events = readEvents();
const summary = {
	effects: readEffects(),
	dispatched: events.filter((e) => e.payload.kind === "campaign.task.started").length,
	static_success: events.filter(
		(e) => e.payload.kind === "campaign.task.completed" && e.payload.task_id !== dynamicTask.task_id,
	).length,
	dynamic_admitted: events.filter((e) => e.payload.kind === "campaign.proposal.admitted").length,
	delayed_unknown: events.some((e) => e.payload.kind === "campaign.task.unknown"),
	campaign_state: result.status?.campaign_state ?? scheduler.state,
};
writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
// Exit non-zero when the scheduler failed closed, so the parent can observe it.
process.exit(result.ok ? 0 : 2);
void alreadyStarted;
