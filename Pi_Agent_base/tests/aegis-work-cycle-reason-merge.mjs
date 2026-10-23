#!/usr/bin/env node
// TEST-09 — request threshold and current-unit completion in the SAME safe
// boundary must produce ONE Host/Supervisor rotation with BOTH reasons visible.
//
// Real C6 + real Pi SDK + faux. The threshold is set to the number of committed
// provider requests reached by the review/propose/checkpoint dispatch, so the
// completion boundary and the request threshold coincide.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { buildC3FixtureManifest } from "../campaign/c3-entry.mjs";
import { runC6FromConfig } from "../campaign/c6-entry.mjs";
import { compileDocumentSeed } from "../memory/document-seed.mjs";
import { verifyChain } from "../shared/events.mjs";

const TASK = "task-hard";
const THRESHOLD = Number(process.env.AEGIS_TEST_THRESHOLD ?? 6);
let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok - ${name}`);
	else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}
const textOf = (message) =>
	typeof message?.content === "string"
		? message.content
		: (message?.content ?? []).map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join("\n");
const readRows = (path) =>
	existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];

const base = mkdtempSync(join(tmpdir(), "aegis-work-reason-merge-"));
const workspace = join(base, "workspace");
const work = join(base, "run");
const knowledge = join(base, "knowledge");
const eventPath = join(work, "events.jsonl");
mkdirSync(workspace);
mkdirSync(work);
mkdirSync(knowledge);
writeFileSync(join(workspace, "door.json"), JSON.stringify({ locked: true }));
writeFileSync(
	join(knowledge, "door.json"),
	JSON.stringify(
		compileDocumentSeed({
			markdown:
				"# Fixture door recovery\n\n## When\n\nRepeated fixture door updates leave locked true.\n\n## Do\n\nRead the door and set locked false.\n\n## Limits\n\nReference only.\n",
			source: { source_kind: "local_document", source_uri: "file:///test/door.md" },
		}),
	),
);
const envKeys = ["AEGIS_KNOWLEDGE_DIR", "AEGIS_KNOWLEDGE_ENABLED", "AEGIS_WEB_SEARCH"];
const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.AEGIS_KNOWLEDGE_DIR = knowledge;
process.env.AEGIS_KNOWLEDGE_ENABLED = "on";
process.env.AEGIS_WEB_SEARCH = "off";
const manifest = buildC3FixtureManifest({ workspaceRoot: workspace, campaignId: "campaign-reason-merge" });
manifest.tasks = [
	{
		...manifest.tasks[0],
		task_id: TASK,
		order: 1,
		depends_on: [],
		goal: { goal_id: "unlock", description: "Unlock the fixture door.", success_criteria: ["door.locked == false"] },
		stages: [{ stage_id: "stage-hard", criteria: ["door.locked == false"], required: true }],
		task_budget: { wall_time_ms: 180000, model_requests: 60, tool_calls: 120 },
	},
];
manifest.budget.task_count = 1;
manifest.budget.session_count = 4;
manifest.dynamic_task_policy.max_task_count = 1;
manifest.session_policy.max_requests_per_session = THRESHOLD;
writeFileSync(join(base, "manifest.json"), JSON.stringify(manifest));
const configPath = join(base, "config.json");
writeFileSync(
	configPath,
	JSON.stringify({
		schema_version: "campaign-config-1.1",
		manifest_path: join(base, "manifest.json"),
		workspace_root: workspace,
		work_dir: work,
		mode: "auto",
		provider: { kind: "faux", model: "reason-merge" },
		context: { strategy: "bounded_ram", max_total_input_chars: 1000000, output_reserve_chars: 1000 },
		learning: { policy: "off", promote_experience: false },
		task_family: "fixture-state",
		session: { session_count: 4, max_requests_per_session: THRESHOLD },
		work_cycle: {
			enabled: true,
			repeat_limit: 3,
			action_window: 8,
			min_distinct_routes: 4,
			context_pressure_percent: 85,
			max_auto_rotations: 3,
			max_continuations: 12,
		},
		observation: { enabled: false, port: 0 },
		oracle: { kind: "fixture" },
	}),
);
const sessions = [];
let dispatch = 0;
let lastKey = null;
const rows = () => readRows(eventPath);
const decision = (value) =>
	fauxToolCall("aegis_task_decision", {
		actions: [{ action_ref: "fixture.state.set", arguments: { target: "door.json", key: "locked", value } }],
	});
let outcome;
try {
	outcome = await runC6FromConfig({
		configPath,
		print() {},
		sdk: {
			...sdkBase,
			AuthStorage,
			async createAgentSessionFromServices(options) {
				const created = await sdkBase.createAgentSessionFromServices(options);
				sessions.push(created.session);
				return created;
			},
		},
		fauxProviderFactory(options) {
			const faux = registerFauxProvider(options);
			const responder = (context) => {
				const messages = context.messages ?? [];
				const lastAssistant = messages.map((message) => message.role).lastIndexOf("assistant");
				const lastTaskPrompt = messages.findLastIndex(
					(message) => message.role === "user" && textOf(message).trimStart().startsWith(`TASK ${TASK}`),
				);
				const followUp = messages
					.slice(Math.max(lastAssistant, lastTaskPrompt) + 1)
					.some((message) => message.role === "toolResult");
				const taskPrompts = messages.filter(
					(message) => message.role === "user" && textOf(message).trimStart().startsWith(`TASK ${TASK}`),
				).length;
				if (taskPrompts === 0) return fauxAssistantMessage("continue from the committed boundary");
				if (followUp) return fauxAssistantMessage("observed");
				const key = `${sessions.at(-1)?.sessionId}:${taskPrompts}`;
				if (key !== lastKey) {
					lastKey = key;
					dispatch += 1;
				}
				if (dispatch === 1)
					return fauxAssistantMessage([
						fauxToolCall("aegis_propose", { kind: "intent", text: "initial repeated probe", scope: "unit:initial" }),
						...[1, 2, 3, 4].map(() => decision(true)),
					]);
				if (dispatch === 2)
					return fauxAssistantMessage([
						fauxToolCall("aegis_work_review", {
							blocker: "repeated failure",
							knowledge_query: "fixture door recovery",
							next_step: "switch state",
							tried_routes: ["fixture.state.set locked=true x4"],
						}),
					]);
				if (dispatch === 3) {
					const review = rows()
						.filter((row) => row.payload?.kind === "work.review")
						.at(-1);
					return fauxAssistantMessage([
						fauxToolCall("aegis_propose", {
							kind: "intent",
							text: "reviewed next unit",
							scope: "unit:after-review",
							source_refs: [{ ref_type: "event", ref_id: review.event_id }],
						}),
						fauxToolCall("aegis_work_checkpoint", { unit_status: "complete", summary: "unit ready for handoff" }),
					]);
				}
				return fauxAssistantMessage([decision(false)]);
			};
			faux.setResponses(Array.from({ length: 40 }, () => responder));
			return faux;
		},
	});
	const events = rows();
	check("C6 run reports ok", outcome.ok === true, JSON.stringify(outcome.reasons));
	check("Task completed", outcome.task_states[TASK] === "completed", JSON.stringify(outcome.task_states));
	check("real fixture file changed", JSON.parse(readFileSync(join(workspace, "door.json"), "utf8")).locked === false);
	const completions = events.filter((row) => row.event_type === "handoff.completed");
	check("exactly one completion", completions.length === 1, `count=${completions.length}`);
	const applied = (outcome.rotation_attempts ?? []).filter((attempt) => attempt.applied === true);
	check("exactly one applied Supervisor rotation", applied.length === 1, JSON.stringify(outcome.rotation_attempts));
	check("only one replacement Session beyond the initial one", sessions.length === 2, `sessions=${sessions.length}`);
	const boundaries = events.filter((row) => row.payload?.kind === "campaign.work_cycle.boundary");
	// The Host stages the rotation request with the merged reason list. The
	// applied staged request is the real product output for this boundary.
	const appliedPath = join(work, "runtime", "handoff.json.applied.json");
	check("the rotation request was retired after a verified completion", existsSync(appliedPath), appliedPath);
	const staged = existsSync(appliedPath) ? JSON.parse(readFileSync(appliedPath, "utf8")) : null;
	const bothReasonsVisible =
		(String(staged?.reason ?? "").includes("work_unit_complete") &&
			String(staged?.reason ?? "").includes("auto_request_threshold")) ||
		boundaries.some(
			(row) =>
				String(row.payload?.reason ?? "").includes("work_unit_complete") &&
				String(row.payload?.reason ?? "").includes("auto_request_threshold"),
		);
	check(
		"the rotation request shows BOTH reasons",
		bothReasonsVisible,
		JSON.stringify({ stagedReason: staged?.reason, boundaries: boundaries.map((row) => row.payload?.reason) }),
	);
	check(
		"the merged request is tied to one completion boundary identity",
		String(staged?.work_cycle?.boundary_identity ?? "").startsWith("unit-complete:"),
		JSON.stringify(staged?.work_cycle),
	);
	const rotation = applied[0];
	check(
		"exactly one Session generation was charged",
		rotation &&
			(rotation.budget_after?.consumed?.session_count ?? 0) ===
				(rotation.budget_before?.consumed?.session_count ?? 0) + 1,
		JSON.stringify(
			rotation?.budget_before
				? { before: rotation.budget_before.consumed, after: rotation.budget_after.consumed }
				: null,
		),
	);
	check("event chain verifies", verifyChain(events).ok === true);
	check("no second completion for the same Task", completions.length === 1);
	const requests = events.filter((row) => row.payload?.kind === "c6.request" && row.payload?.phase === "committed");
	console.log(
		"reason-merge evidence",
		JSON.stringify({
			threshold: THRESHOLD,
			committedRequests: requests.length,
			boundaries: boundaries.map((row) => row.payload?.reason),
			rotations: outcome.rotation_attempts.length,
		}),
	);
} finally {
	for (const session of sessions) await session.dispose?.();
	for (const key of envKeys) {
		if (previous[key] === undefined) delete process.env[key];
		else process.env[key] = previous[key];
	}
	rmSync(base, { recursive: true, force: true });
}
console.log(
	failures === 0
		? "\nReason merge: request threshold + unit completion produced one rotation with both reasons"
		: `\nReason merge: ${failures} check(s) failed (RED retained)`,
);
process.exit(failures === 0 ? 0 : 1);
