#!/usr/bin/env node
// P2-11 — interrupt the NEW work-cycle chain at a real failure point (a zero
// Session generation budget), then recover from the SAME committed source.
//
// Run 1: stall -> review -> new scoped Intent + complete checkpoint -> the Host
//        attempts an automatic rotation, the Supervisor refuses (budget 0), the
//        staged handoff remains and the Task stays NON-terminal.
// Run 2: the operator corrects the Session budget; the Host resumes the pending
//        boundary, re-plans, rotates exactly once and completes the Task.
//
// No duplicate Completion/Session charge, no duplicated tool charge key, no
// blind replay of the already-executed plan, and the old review is not consumed
// a second time.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { buildC3FixtureManifest } from "../campaign/c3-entry.mjs";
import { runC6FromConfig } from "../campaign/c6-entry.mjs";
import { projectWorkCycle } from "../memory/work-cycle.mjs";
import { verifyChain } from "../shared/events.mjs";

const base = mkdtempSync(join(tmpdir(), "aegis-work-cycle-recovery-"));
const workspace = join(base, "workspace");
const work = join(base, "run");
for (const dir of [workspace, work]) mkdirSync(dir, { recursive: true });
writeFileSync(join(workspace, "door.json"), JSON.stringify({ locked: true }));

const manifest = buildC3FixtureManifest({ workspaceRoot: workspace, campaignId: "campaign-work-cycle-recovery" });
manifest.tasks = [
	{
		...manifest.tasks[0],
		task_id: "task-hard",
		order: 1,
		depends_on: [],
		goal: {
			goal_id: "unlock_door",
			description: "Unlock the fixture door.",
			success_criteria: ["door.locked == false"],
		},
		stages: [{ stage_id: "stage-hard", criteria: ["door.locked == false"], required: true }],
		task_budget: { wall_time_ms: 180000, model_requests: 60, tool_calls: 120 },
	},
];
manifest.budget.task_count = 1;
manifest.budget.session_count = 8;
manifest.dynamic_task_policy.max_task_count = 1;
manifest.session_policy.max_requests_per_session = 20;
writeFileSync(join(base, "manifest.json"), JSON.stringify(manifest));

function writeConfig(name, sessionCount) {
	const configPath = join(base, `${name}.json`);
	writeFileSync(
		configPath,
		JSON.stringify({
			schema_version: "campaign-config-1.1",
			manifest_path: join(base, "manifest.json"),
			workspace_root: workspace,
			work_dir: work,
			mode: "auto",
			provider: { kind: "faux", model: "work-cycle-recovery" },
			context: { strategy: "bounded_ram", max_total_input_chars: 200000, output_reserve_chars: 1000 },
			learning: { policy: "off", promote_experience: false },
			task_family: "fixture-state",
			session: { session_count: sessionCount, max_requests_per_session: 20 },
			work_cycle: {
				enabled: true,
				repeat_limit: 3,
				action_window: 8,
				min_distinct_routes: 4,
				context_pressure_percent: 85,
				max_auto_rotations: 4,
				max_continuations: 10,
			},
			observation: { enabled: false, port: 0 },
			oracle: { kind: "fixture" },
		}),
	);
	return configPath;
}

const eventLogPath = join(work, "events.jsonl");
const readEvents = () =>
	existsSync(eventLogPath)
		? readFileSync(eventLogPath, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
const latestReview = () => [...readEvents()].reverse().find((row) => row.payload?.kind === "work.review") ?? null;
const messageText = (message) => {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content))
		return message.content.map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join(" ");
	return "";
};
const taskPrompt = (messages) =>
	messages.some((message) => message?.role === "user" && messageText(message).trimStart().startsWith("TASK task-hard"));
const followUp = (messages) => {
	const lastAssistant = messages.map((m) => m?.role).lastIndexOf("assistant");
	return messages
		.slice(lastAssistant + 1)
		.some((message) => message?.role === "toolResult" || message?.role === "tool");
};

function provider(factory) {
	return (options) => {
		const faux = registerFauxProvider(options);
		faux.setResponses(Array.from({ length: 40 }, () => factory(faux)));
		return faux;
	};
}

try {
	// ---- Run 1: complete the unit, but the Session budget refuses rotation ----
	{
		let phase = 0;
		let lastPromptCount = 0;
		const run = await runC6FromConfig({
			configPath: writeConfig("run-1", 0),
			sdk: { ...sdkBase, AuthStorage },
			print() {},
			fauxProviderFactory: provider(() => (context) => {
				const messages = context.messages ?? [];
				if (followUp(messages)) return fauxAssistantMessage("recorded");
				if (!taskPrompt(messages)) return fauxAssistantMessage("continuing");
				const count = messages.filter(
					(message) => message?.role === "user" && messageText(message).trimStart().startsWith("TASK task-hard"),
				).length;
				if (count !== lastPromptCount) {
					lastPromptCount = count;
					phase += 1;
				}
				if (phase === 1)
					return fauxAssistantMessage([
						fauxToolCall("aegis_propose", { kind: "intent", text: "initial unit", scope: "unit:initial" }),
						...[1, 2, 3, 4].map(() =>
							fauxToolCall("aegis_task_decision", {
								actions: [
									{
										action_ref: "fixture.state.set",
										arguments: { target: "door.json", key: "locked", value: true },
									},
								],
							}),
						),
					]);
				if (phase === 2)
					return fauxAssistantMessage([
						fauxToolCall("aegis_work_review", {
							blocker: "repeated failure",
							knowledge_query: "fixture door repeated failure",
							next_step: "switch state",
							tried_routes: ["fixture.state.set locked=true x4"],
						}),
					]);
				const review = latestReview();
				return fauxAssistantMessage([
					fauxToolCall("aegis_propose", {
						kind: "intent",
						text: "reviewed next unit",
						scope: "unit:after-review",
						source_refs: [{ ref_type: "event", ref_id: review.event_id }],
					}),
					fauxToolCall("aegis_work_checkpoint", {
						unit_status: "complete",
						summary: "unit reviewed and ready to hand over",
					}),
				]);
			}),
		});
		assert.equal(run.ok, true, JSON.stringify(run.reasons));
		const events = readEvents();
		assert.equal(verifyChain(events).ok, true);
		assert.equal(run.task_states["task-hard"], "running", JSON.stringify(run.task_states));
		assert.equal(events.filter((row) => row.event_type === "handoff.completed").length, 0);
		assert.equal(events.filter((row) => row.payload?.kind === "work.review").length, 1);
		assert.equal(events.filter((row) => row.payload?.kind === "work.checkpoint").length, 1);
		assert.equal(existsSync(join(work, "runtime", "handoff.json")), true, "the failed rotation keeps a staged request");
		const boundary = events.filter((row) => row.payload?.kind === "campaign.work_cycle.boundary");
		assert.equal(boundary.length >= 1, true, "a durable continuation boundary exists before the failed rotation");
		console.log("Run 1: interrupted at the Session budget with a durable continuation boundary (expected)");
	}

	// ---- Run 2: correct the budget and recover from the same committed source --
	{
		let phase = 0;
		let lastPromptCount = 0;
		const run = await runC6FromConfig({
			configPath: writeConfig("run-2", 4),
			sdk: { ...sdkBase, AuthStorage },
			print() {},
			fauxProviderFactory: provider(() => (context) => {
				const messages = context.messages ?? [];
				if (followUp(messages)) return fauxAssistantMessage("recorded");
				if (!taskPrompt(messages)) return fauxAssistantMessage("continuing");
				const count = messages.filter(
					(message) => message?.role === "user" && messageText(message).trimStart().startsWith("TASK task-hard"),
				).length;
				if (count !== lastPromptCount) {
					lastPromptCount = count;
					phase += 1;
				}
				// Recovery first observes only; the Host re-evaluates the durable
				// complete boundary and performs the pending rotation. It does NOT replay
				// the interrupted plan.
				if (phase === 1) return fauxAssistantMessage("recover the durable unit boundary");
				return fauxAssistantMessage([
					fauxToolCall("aegis_task_decision", {
						actions: [
							{
								action_ref: "fixture.state.set",
								arguments: { target: "door.json", key: "locked", value: false },
							},
						],
					}),
				]);
			}),
		});
		assert.equal(run.ok, true, JSON.stringify(run.reasons));
		assert.equal(run.task_states["task-hard"], "completed", JSON.stringify(run.task_states));
		const events = readEvents();
		assert.equal(verifyChain(events).ok, true);
		// Exactly ONE completion and one replacement Session for the recovered Task.
		const completions = events.filter((row) => row.event_type === "handoff.completed");
		assert.equal(completions.length, 1, `one rotation expected, got ${completions.length}`);
		assert.equal(new Set(completions.map((row) => row.payload?.to_session)).size, 1);
		// No duplicated tool charge key (the same real unit is never charged twice).
		const charges = events.filter((row) => row.payload?.kind === "c6.tool");
		const keys = charges.map((row) => {
			const p = row.payload;
			return [p.campaign_id, p.task_id, p.episode_id, p.request_id, p.tool_call_id, p.unit_id].join("|");
		});
		const charged = new Map();
		let duplicateCharge = null;
		for (const row of charges) {
			const p = row.payload;
			const key = [p.campaign_id, p.task_id, p.episode_id, p.request_id, p.tool_call_id, p.unit_id].join("|");
			if (p.phase === "charged") {
				if (charged.has(key)) duplicateCharge = key;
				charged.set(key, true);
			} else if (p.phase === "finished") {
				charged.delete(key);
			}
		}
		assert.equal(duplicateCharge, null, `duplicate charged key ${duplicateCharge}`);
		assert.equal(charged.size, 0, `unsettled tool charges: ${[...charged.keys()].join(",")}`);
		assert.equal(new Set(keys).size, keys.length / 2, "each tool unit has exactly one charged and one finished row");
		// The already-executed plan is not replayed: the first three effects keep
		// their committed action ids and only two additional model effects occur.
		const executed = events.filter(
			(row) =>
				row.event_type === "action.completed" &&
				row.payload?.task_id === "task-hard" &&
				row.payload?.status === "success",
		);
		assert.equal(executed.length, 4, `expected 3 original + 1 recovered effect, got ${executed.length}`);
		assert.equal(new Set(executed.map((row) => row.payload?.action_id)).size, 4, "action ids are unique per dispatch");
		// The old review is consumed once; recovery did not consume it again.
		const cycle = projectWorkCycle(events, "ep-task-hard", {
			policy: { repeat_limit: 3, action_window: 8, min_distinct_routes: 4, context_pressure_percent: 85 },
		});
		assert.equal(cycle.consumptions.length, 1, JSON.stringify(cycle.consumptions));
		assert.equal(cycle.review_required, false);
		// No fabricated Task failure/unknown.
		assert.equal(
			events.filter((row) => row.payload?.kind === "campaign.task.unknown" && row.payload?.task_id === "task-hard")
				.length,
			0,
		);
		console.log(
			"Run 2: recovered from the committed boundary with one rotation, no duplicate charge and no plan replay",
		);
	}
	console.log("\nWork-cycle recovery: interrupted rotation recovered once from committed state passed");
} finally {
	rmSync(base, { recursive: true, force: true });
}
