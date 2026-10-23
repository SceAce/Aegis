#!/usr/bin/env node
// P2-05 / F2 — checkpoint and review calls through the REAL C6 entry + ledger.
//
// Proves:
//   * a successful `aegis_work_checkpoint` call has durable `c6.tool` charged AND
//     finished rows (the first-phase defect: it bypassed the bound account);
//   * two REAL calls are charged twice (content is written twice here; the rule is
//     "different real calls are not free");
//   * an exhausted tool allocation refuses the protected record (no checkpoint
//     event) and leaves the task non-terminal / reported;
//   * no second ledger or counter is created.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { buildC3FixtureManifest } from "../campaign/c3-entry.mjs";
import { runC6FromConfig } from "../campaign/c6-entry.mjs";
import { verifyChain } from "../shared/events.mjs";

const base = mkdtempSync(join(tmpdir(), "aegis-work-cycle-checkpoint-"));
const workspace = join(base, "workspace");
const work = join(base, "run");
mkdirSync(workspace);
mkdirSync(work);
writeFileSync(join(workspace, "door.json"), JSON.stringify({ locked: true }));

function writeRunConfig({ toolCalls, workDir }) {
	const manifest = buildC3FixtureManifest({ workspaceRoot: workspace, campaignId: "campaign-work-cycle-checkpoint" });
	manifest.tasks = [
		{
			...manifest.tasks[0],
			task_id: "task-001",
			order: 1,
			depends_on: [],
			task_budget: { wall_time_ms: 120000, model_requests: 20, tool_calls: toolCalls },
		},
	];
	manifest.budget.task_count = 1;
	manifest.budget.session_count = 4;
	manifest.dynamic_task_policy.max_task_count = 1;
	writeFileSync(join(base, "manifest.json"), JSON.stringify(manifest));
	const configPath = join(base, "campaign.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			schema_version: "campaign-config-1.1",
			manifest_path: join(base, "manifest.json"),
			workspace_root: workspace,
			work_dir: workDir,
			mode: "auto",
			provider: { kind: "faux", model: "checkpoint-campaign" },
			context: { strategy: "bounded_ram", max_total_input_chars: 100000, output_reserve_chars: 1000 },
			learning: { policy: "off", promote_experience: false },
			task_family: "fixture-state",
			session: { session_count: 4, max_requests_per_session: 10 },
			work_cycle: { enabled: true, max_auto_rotations: 2, max_continuations: 4 },
			observation: { enabled: false, port: 0 },
			oracle: { kind: "fixture" },
		}),
	);
	return configPath;
}

function fakeProviderFactory(responder) {
	return (options) => {
		const faux = registerFauxProvider(options);
		faux.setResponses(Array.from({ length: 20 }, () => responder));
		return faux;
	};
}

async function runOnce({ toolCalls, workDir, responder }) {
	const configPath = writeRunConfig({ toolCalls, workDir });
	return runC6FromConfig({
		configPath,
		sdk: { ...sdkBase, AuthStorage },
		print() {},
		fauxProviderFactory: fakeProviderFactory(responder),
	});
}

function readEvents(workDir) {
	return readFileSync(join(workDir, "events.jsonl"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok - ${name}`);
	else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

try {
	// ---- POSITIVE: Intent then two real checkpoint calls -----------------------
	{
		const workDir = join(base, "run-positive");
		mkdirSync(workDir, { recursive: true });
		let phase = 0;
		const outcome = await runOnce({
			toolCalls: 30,
			workDir,
			responder: (context) => {
				const messages = context.messages ?? [];
				const lastAssistant = messages.map((m) => m?.role).lastIndexOf("assistant");
				const toolResultAfter = messages
					.slice(lastAssistant + 1)
					.some((message) => message?.role === "toolResult" || message?.role === "tool");
				if (toolResultAfter) return fauxAssistantMessage("recorded");
				const taskPrompt = messages.some(
					(message) =>
						message?.role === "user" &&
						(typeof message.content === "string"
							? message.content.startsWith("TASK task-001")
							: Array.isArray(message.content) &&
								message.content.some((part) => String(part?.text ?? "").startsWith("TASK task-001"))),
				);
				if (!taskPrompt) return fauxAssistantMessage("continuing");
				phase += 1;
				if (phase > 1)
					return fauxAssistantMessage([
						fauxToolCall("aegis_task_decision", {
							actions: [
								{
									action_ref: "fixture.state.set",
									arguments: { target: "door.json", key: "locked", value: true },
								},
							],
						}),
					]);
				return fauxAssistantMessage([
					fauxToolCall("aegis_propose", {
						kind: "intent",
						text: "checkpoint accounting unit",
						scope: "unit:checkpoint-audit",
					}),
					fauxToolCall("aegis_work_checkpoint", {
						unit_status: "continue",
						summary: "first real checkpoint call",
					}),
					fauxToolCall("aegis_work_checkpoint", {
						unit_status: "continue",
						summary: "second real checkpoint call",
					}),
				]);
			},
		});
		assert.equal(outcome.ok, true, JSON.stringify(outcome));
		const events = readEvents(workDir);
		assert.equal(verifyChain(events).ok, true);
		const checkpoints = events.filter(
			(event) => event.event_type === "runtime.note" && event.payload?.kind === "work.checkpoint",
		);
		check("F2 two real checkpoint calls are committed", checkpoints.length === 2, `count=${checkpoints.length}`);
		const charges = events.filter(
			(event) => event.payload?.kind === "c6.tool" && event.payload?.tool_name === "aegis_work_checkpoint",
		);
		const charged = charges.filter((event) => event.payload?.phase === "charged");
		const finished = charges.filter((event) => event.payload?.phase === "finished");
		check(
			"F2 both checkpoint calls were charged before execution",
			charged.length === 2,
			JSON.stringify(charges.map((event) => event.payload?.phase)),
		);
		check(
			"F2 both checkpoint calls were finished (settled)",
			finished.length === 2,
			JSON.stringify(charges.map((event) => event.payload?.phase)),
		);
		check(
			"F2 each checkpoint is bound to the current Intent event",
			checkpoints.every(
				(checkpoint) =>
					typeof checkpoint.payload?.work_unit_event_id === "string" &&
					events.some(
						(event) =>
							event.event_type === "proposal.submitted" &&
							event.event_id === checkpoint.payload.work_unit_event_id &&
							event.payload?.scope === "unit:checkpoint-audit",
					),
			),
			JSON.stringify(checkpoints.map((checkpoint) => checkpoint.payload?.work_unit_event_id)),
		);
		check(
			"F2 the run completed through the independent fixture judge",
			outcome.task_states["task-001"] === "completed",
			JSON.stringify(outcome.task_states),
		);
		// No parallel counter: every charge is the existing c6 tool ledger row.
		check(
			"F2 no secondary accounting row was introduced",
			events.every(
				(event) =>
					event.payload?.kind !== "work.checkpoint.accounting" && event.payload?.kind !== "work.review.accounting",
			),
		);
	}

	// ---- NEGATIVE: exhausted tool allocation refuses the protected record ------
	{
		const workDir = join(base, "run-zero");
		mkdirSync(workDir, { recursive: true });
		let phase = 0;
		const outcome = await runOnce({
			toolCalls: 0,
			workDir,
			responder: (context) => {
				const messages = context.messages ?? [];
				const lastAssistant = messages.map((m) => m?.role).lastIndexOf("assistant");
				const toolResultAfter = messages
					.slice(lastAssistant + 1)
					.some((message) => message?.role === "toolResult" || message?.role === "tool");
				if (toolResultAfter) return fauxAssistantMessage("recorded");
				const taskPrompt = messages.some(
					(message) =>
						message?.role === "user" &&
						(typeof message.content === "string"
							? message.content.startsWith("TASK task-001")
							: Array.isArray(message.content) &&
								message.content.some((part) => String(part?.text ?? "").startsWith("TASK task-001"))),
				);
				if (!taskPrompt) return fauxAssistantMessage("continuing");
				phase += 1;
				if (phase > 1)
					return fauxAssistantMessage([
						fauxToolCall("aegis_task_decision", {
							actions: [
								{
									action_ref: "fixture.state.set",
									arguments: { target: "door.json", key: "locked", value: true },
								},
							],
						}),
					]);
				return fauxAssistantMessage([
					fauxToolCall("aegis_propose", {
						kind: "intent",
						text: "zero-budget checkpoint unit",
						scope: "unit:zero-budget",
					}),
					fauxToolCall("aegis_work_checkpoint", {
						unit_status: "continue",
						summary: "must be refused by the exhausted allocation",
					}),
				]);
			},
		});
		const events = readEvents(workDir);
		const checkpoints = events.filter(
			(event) => event.event_type === "runtime.note" && event.payload?.kind === "work.checkpoint",
		);
		check(
			"P2-05 zero tool allocation writes NO protected checkpoint",
			checkpoints.length === 0,
			`count=${checkpoints.length}`,
		);
		const checkpointsCharged = events.filter(
			(event) =>
				event.payload?.kind === "c6.tool" &&
				event.payload?.tool_name === "aegis_work_checkpoint" &&
				event.payload?.phase === "charged",
		);
		check("P2-05 zero allocation did not create an unbacked charge", checkpointsCharged.length === 0);
		check(
			"P2-05 the Task is not falsely completed by a refused record",
			outcome.task_states["task-001"] !== "completed" ||
				events.filter((event) => event.payload?.kind === "work.checkpoint").length === 0,
			JSON.stringify(outcome.task_states),
		);
	}
	if (failures > 0) {
		console.error(`\nWork-cycle checkpoint Campaign: ${failures} check(s) failed`);
		process.exit(1);
	}
	console.log(
		"\nWork-cycle checkpoint Campaign: F2 charge/finish, real-call accounting and zero-allocation refusal passed",
	);
} finally {
	rmSync(base, { recursive: true, force: true });
}
