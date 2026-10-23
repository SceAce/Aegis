#!/usr/bin/env node
// TEST-06A / TEST-06B — real C6 entry + real Pi SDK + faux + real local knowledge.
//
// TEST-06A: a missing knowledge root makes the ACTUAL `aegis_work_review` record
// `unavailable` and keep the hold; a real effect attempt is blocked; after the
// resource is explicitly restored at a known failure boundary, the SAME trigger
// is retried, retrieves real content (`ready`), and a legal new Intent lets the
// effect execute.
//
// TEST-06B: a READABLE EMPTY corpus must make the actual review boundary report
// `no_match` with an empty selection. The current product reports `ready` + [];
// that is kept RED here rather than changing the expected value.
//
// No product code is patched. No real model/network/target.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { buildC3FixtureManifest } from "../campaign/c3-entry.mjs";
import { runC6FromConfig } from "../campaign/c6-entry.mjs";
import { compileDocumentSeed } from "../memory/document-seed.mjs";
import { projectWorkCycle } from "../memory/work-cycle.mjs";
import { verifyChain } from "../shared/events.mjs";

const POLICY = { repeat_limit: 3, action_window: 8, min_distinct_routes: 4, context_pressure_percent: 85 };
const TASK = "task-hard";
const EPISODE = "ep-task-hard";
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
const indexOfId = (rows, id) => rows.findIndex((row) => row.event_id === id);
const readRows = (path) =>
	existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];

function assertLedger(rows, label, expected = {}) {
	const open = new Set();
	const charged = new Set();
	const byTool = new Map();
	for (const row of rows.filter((entry) => entry.payload?.kind === "c6.tool")) {
		const p = row.payload;
		const key = [p.campaign_id, p.task_id, p.episode_id, p.request_id, p.tool_call_id, p.unit_id].join("|");
		const bucket = byTool.get(p.tool_name) ?? { charged: 0, finished: 0 };
		if (p.phase === "charged") {
			check(`${label}: no duplicate charge ${key}`, !charged.has(key));
			charged.add(key);
			open.add(key);
			bucket.charged += 1;
		} else if (p.phase === "finished") {
			check(`${label}: finish matches a charged unit ${key}`, open.delete(key));
			bucket.finished += 1;
		}
		byTool.set(p.tool_name, bucket);
	}
	check(`${label}: every admitted tool unit settles`, open.size === 0, [...open].join(","));
	for (const [tool, counts] of Object.entries(expected)) {
		const actual = byTool.get(tool) ?? { charged: 0, finished: 0 };
		check(
			`${label}: ${tool} calls are charged/finished (${counts}/${counts})`,
			actual.charged === counts && actual.finished === counts,
			JSON.stringify(actual),
		);
	}
	return byTool;
}

async function runMode(mode) {
	const base = mkdtempSync(join(tmpdir(), `aegis-work-knowledge-${mode}-`));
	const workspace = join(base, "workspace");
	const work = join(base, "run");
	const knowledge = join(base, "knowledge");
	const eventPath = join(work, "events.jsonl");
	mkdirSync(workspace);
	mkdirSync(work);
	writeFileSync(join(workspace, "door.json"), JSON.stringify({ locked: true }));
	const envKeys = ["AEGIS_KNOWLEDGE_DIR", "AEGIS_KNOWLEDGE_ENABLED", "AEGIS_WEB_SEARCH"];
	const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
	process.env.AEGIS_KNOWLEDGE_DIR = knowledge;
	process.env.AEGIS_KNOWLEDGE_ENABLED = "on";
	process.env.AEGIS_WEB_SEARCH = "off";
	if (mode === "no_match") mkdirSync(knowledge, { recursive: true });
	const installSeed = () => {
		mkdirSync(knowledge, { recursive: true });
		writeFileSync(
			join(knowledge, "door.json"),
			JSON.stringify(
				compileDocumentSeed({
					markdown:
						"# Fixture door recovery\n\n## When\n\nRepeated fixture door updates leave locked true.\n\n## Do\n\nRead the door and set locked false.\n\n## Limits\n\nReference only; independent verification required.\n",
					source: { source_kind: "local_document", source_uri: "file:///test/door.md" },
				}),
			),
		);
	};
	const manifest = buildC3FixtureManifest({ workspaceRoot: workspace, campaignId: `campaign-knowledge-${mode}` });
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
	manifest.session_policy.max_requests_per_session = 100;
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
			provider: { kind: "faux", model: `knowledge-${mode}` },
			context: { strategy: "bounded_ram", max_total_input_chars: 1000000, output_reserve_chars: 1000 },
			learning: { policy: "off", promote_experience: false },
			task_family: "fixture-state",
			session: { session_count: 4, max_requests_per_session: 100 },
			work_cycle: { enabled: true, ...POLICY, max_auto_rotations: 3, max_continuations: 12 },
			observation: { enabled: false, port: 0 },
			oracle: { kind: "fixture" },
		}),
	);

	const rows = () => readRows(eventPath);
	const reviews = () => rows().filter((row) => row.payload?.kind === "work.review");
	const selections = () =>
		rows().filter((row) => row.payload?.kind === "knowledge.selected" && row.payload?.mode === "work_review");
	const reviewCall = () =>
		fauxToolCall("aegis_work_review", {
			blocker: "three fixture effects left locked true",
			knowledge_query: "fixture door recovery locked",
			next_step: "read the door and try locked false",
			tried_routes: ["fixture.state.set locked=true"],
		});
	const decision = (value) =>
		fauxToolCall("aegis_task_decision", {
			actions: [{ action_ref: "fixture.state.set", arguments: { target: "door.json", key: "locked", value } }],
		});
	const propose = () => {
		const review = reviews().at(-1);
		assert.ok(review, "a real review must precede the next Intent");
		return fauxAssistantMessage([
			fauxToolCall("aegis_propose", {
				kind: "intent",
				text: "apply the recovered next probe",
				scope: "unit:after-recovery",
				source_refs: [{ ref_type: "event", ref_id: review.event_id }],
			}),
		]);
	};
	let dispatch = 0;
	let lastDispatchKey = null;
	let installed = false;
	let blockedAttemptSeen = false;
	const requests = [];
	const toolResults = [];
	const sessions = [];
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
					assert.ok(requests.length < 40, "bounded responder must not spin");
					const messages = context.messages ?? [];
					requests.push({ messages: structuredClone(messages), prefix: rows() });
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
					if (taskPrompts === 0) return fauxAssistantMessage("continue from the committed hold");
					if (followUp) {
						const recent = messages.filter((message) => message.role === "toolResult").at(-1);
						if (recent) toolResults.push(textOf(recent));
						return fauxAssistantMessage("tool result observed");
					}
					const key = `${messages.at(-1)?.role}:${taskPrompts}:${reviews().length}`;
					if (key !== lastDispatchKey) {
						lastDispatchKey = key;
						dispatch += 1;
					}
					if (dispatch === 1)
						return fauxAssistantMessage([
							fauxToolCall("aegis_propose", { kind: "intent", text: "initial repeated probe", scope: "unit:initial" }),
							...Array.from({ length: 4 }, () => decision(true)),
						]);
					if (mode === "unavailable") {
						if (dispatch === 2) return fauxAssistantMessage([reviewCall()]);
						if (dispatch === 3)
							return fauxAssistantMessage([
								fauxToolCall("aegis_work_checkpoint", {
									unit_status: "continue",
									summary: "hold observed; try an effect before restoring knowledge",
								}),
								decision(false),
							]);
						if (dispatch === 4) {
							assert.equal(reviews().at(-1)?.payload?.retrieval?.status, "unavailable");
							installSeed();
							installed = true;
							return fauxAssistantMessage([reviewCall()]);
						}
						if (dispatch === 5) return propose();
						return fauxAssistantMessage([decision(false)]);
					}
					if (dispatch === 2) return fauxAssistantMessage([reviewCall()]);
					if (dispatch === 3) return propose();
					return fauxAssistantMessage([decision(false)]);
				};
				faux.setResponses(Array.from({ length: 40 }, () => responder));
				return faux;
			},
		});
		const events = rows();
		check(`${mode}: C6 run reports ok`, outcome.ok === true, JSON.stringify(outcome.reasons));
		check(`${mode}: event chain verifies`, verifyChain(events).ok === true);
		check(
			`${mode}: Task completed through the independent fixture judge`,
			outcome.task_states[TASK] === "completed",
			JSON.stringify(outcome.task_states),
		);
		const door = JSON.parse(readFileSync(join(workspace, "door.json"), "utf8"));
		check(`${mode}: real fixture file reflects the final effect`, door.locked === false, JSON.stringify(door));
		const reviewRows = reviews();
		const reviewSelections = selections();
		console.log(
			`KNOWLEDGE_EVIDENCE ${mode} ${JSON.stringify({
				reviews: reviewRows.map((row) => ({
					event_id: row.event_id,
					trigger_id: row.payload?.trigger_id,
					status: row.payload?.retrieval?.status,
					selection: row.payload?.retrieval?.selection_event_id,
				})),
				selections: reviewSelections.map((row) => ({
					event_id: row.event_id,
					status: row.payload?.status,
					selected: row.payload?.selected?.length ?? 0,
				})),
			})}`,
		);
		for (const review of reviewRows) {
			const selected = reviewSelections.find((row) => row.event_id === review.payload.retrieval.selection_event_id);
			check(`${mode}: review ${review.event_id} refers to a committed selection`, Boolean(selected));
			if (!selected) continue;
			check(
				`${mode}: selection precedes its review`,
				indexOfId(events, selected.event_id) < indexOfId(events, review.event_id),
			);
			check(
				`${mode}: selection has the same Episode`,
				selected.episode_id === review.episode_id && review.episode_id === EPISODE,
			);
			check(
				`${mode}: selection binds the review trigger`,
				selected.payload.work_review_trigger_id === review.payload.trigger_id,
			);
			check(
				`${mode}: selection status matches review retrieval`,
				selected.payload.status === review.payload.retrieval.status,
			);
		}
		if (mode === "unavailable") {
			check(
				"06A: missing corpus is recorded as unavailable",
				reviewRows[0]?.payload?.retrieval?.status === "unavailable",
				JSON.stringify(reviewRows[0]?.payload?.retrieval),
			);
			check(
				"06A: the failed retrieval selected no knowledge",
				(reviewSelections[0]?.payload?.selected ?? []).length === 0,
			);
			check(
				"06A: recovery actually installed a readable corpus",
				installed === true && existsSync(join(knowledge, "door.json")),
			);
			check("06A: the retry is a second real review call", reviewRows.length === 2, `count=${reviewRows.length}`);
			check(
				"06A: the retry reports ready",
				reviewRows[1]?.payload?.retrieval?.status === "ready",
				JSON.stringify(reviewRows[1]?.payload?.retrieval),
			);
			check("06A: the retry reads real content", (reviewSelections[1]?.payload?.selected ?? []).length > 0);
			check(
				"06A: both reviews bind the same trigger",
				reviewRows[0]?.payload?.trigger_id === reviewRows[1]?.payload?.trigger_id,
			);
			// The actual effect attempt between the failed review and the retry is blocked.
			const failureIndex = indexOfId(events, reviewRows[0].event_id);
			const retryIndex = indexOfId(events, reviewRows[1].event_id);
			const between = events.slice(failureIndex + 1, retryIndex);
			check(
				"06A: no successful effect occurs while the failed hold is still active",
				between.some(
					(row) => row.event_type === "action.requested" && row.payload?.action_ref === "fixture.state.set",
				) === false,
				JSON.stringify(
					between.filter((row) => row.event_type === "action.requested").map((row) => row.payload?.action_ref),
				),
			);
			const blocked = between.filter(
				(row) =>
					row.event_type === "message.completed" &&
					row.payload?.role === "toolResult" &&
					/Aegis work review required/.test(String(row.payload?.text_excerpt ?? "")),
			);
			check("06A: the model received the work-review block for the effect attempt", blocked.length > 0);
			blockedAttemptSeen = blocked.length > 0;
			const failureCycle = projectWorkCycle(events.slice(0, failureIndex + 1), EPISODE, { policy: POLICY, manifest });
			const retryCycle = projectWorkCycle(events.slice(0, retryIndex + 1), EPISODE, { policy: POLICY, manifest });
			check(
				"06A: the failed review keeps the hold",
				failureCycle.status === "review_required",
				JSON.stringify(failureCycle.status),
			);
			check(
				"06A: the failed review is visible as unusable",
				failureCycle.failed_review_event_ids.includes(reviewRows[0].event_id),
			);
			check(
				"06A: the recovered review moves to awaiting a scoped Intent",
				retryCycle.status === "awaiting_scoped_intent",
				JSON.stringify(retryCycle.status),
			);
			check("06A: the failed review is not consumed", failureCycle.consumptions.length === 0);
			const proposeIndex = events.findIndex(
				(row) => row.event_type === "proposal.submitted" && row.payload?.scope === "unit:after-recovery",
			);
			const afterPropose = projectWorkCycle(events.slice(0, proposeIndex + 1), EPISODE, { policy: POLICY, manifest });
			const afterFinal = projectWorkCycle(events, EPISODE, { policy: POLICY, manifest });
			check(
				"06A: exactly one review is consumed",
				afterPropose.consumptions.length === 1,
				JSON.stringify(afterPropose.consumptions),
			);
			check(
				"06A: consumption binds the recovered review",
				afterPropose.consumptions[0]?.review_event_id === reviewRows[1].event_id,
			);
			check(
				"06A: cumulative attempts are preserved across the failed retry",
				afterPropose.action_count >= 4,
				JSON.stringify({ total: afterPropose.action_count, round: afterPropose.review_round_action_count }),
			);
			check(
				"06A: the consumed round resets only the round counter",
				afterPropose.review_round_action_count === 0,
				JSON.stringify(afterPropose.review_round_action_count),
			);
			check(
				"06A: the final effect belongs to the new round",
				afterFinal.review_round_action_count === 1,
				JSON.stringify(afterFinal.review_round_action_count),
			);
			check(
				"06A: cumulative attempts keep history",
				afterFinal.action_count === afterPropose.action_count + 1,
				JSON.stringify({ before: afterPropose.action_count, after: afterFinal.action_count }),
			);
			check("06A: the earlier effect really was blocked", blockedAttemptSeen === true);
			assertLedger(events, "06A", { aegis_work_review: 2, aegis_work_checkpoint: 1 });
		} else {
			check("06B: one review is recorded", reviewRows.length === 1, `count=${reviewRows.length}`);
			check(
				"06B: readable empty corpus is explicitly no_match",
				reviewRows[0]?.payload?.retrieval?.status === "no_match",
				JSON.stringify(reviewRows[0]?.payload?.retrieval),
			);
			check(
				"06B: empty selection is explicit",
				(reviewSelections[0]?.payload?.selected ?? []).length === 0,
				JSON.stringify(reviewSelections[0]?.payload?.selected),
			);
			check(
				"06B: review does not claim a knowledge hit",
				(reviewRows[0]?.payload?.retrieval?.selected_knowledge_ids ?? []).length === 0,
			);
			const reviewResult = toolResults.find((text) => text.includes('"retrieval_status"') || text.includes('"status"'));
			check(
				"06B: the actual review tool result reports no_match",
				Boolean(reviewResult && /"retrieval_status":"no_match"|"status":"no_match"/.test(reviewResult)),
				reviewResult?.slice(0, 300),
			);
			const proposeIndex = events.findIndex(
				(row) => row.event_type === "proposal.submitted" && row.payload?.scope === "unit:after-recovery",
			);
			const afterPropose = projectWorkCycle(events.slice(0, proposeIndex + 1), EPISODE, { policy: POLICY, manifest });
			check(
				"06B: a legal Intent after no_match continues the work unit",
				afterPropose.consumptions.length === 1,
				JSON.stringify(afterPropose.consumptions),
			);
			check(
				"06B: no Fact/Outcome is manufactured by the empty retrieval",
				events.some((row) => row.event_type === "outcome.recorded" && row.source?.kind === "runtime") === false,
			);
		}
	} finally {
		for (const session of sessions) await session.dispose?.();
		for (const key of envKeys) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
		rmSync(base, { recursive: true, force: true });
	}
}

for (const mode of ["unavailable", "no_match"]) {
	console.log(`\n=== ${mode} ===`);
	await runMode(mode);
}
console.log(
	failures === 0
		? "\nKnowledge recovery: unavailable retry/no_match contract passed"
		: `\nKnowledge recovery: ${failures} expected check(s) failed (RED retained)`,
);
process.exit(failures === 0 ? 0 : 1);
