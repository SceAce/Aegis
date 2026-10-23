#!/usr/bin/env node
// TEST-07 — real C6 Host/Supervisor + real Pi SDK + faux.
//
// The same Task/Episode stalls with NO review yet. Legitimate faux response text
// raises the REAL SDK context usage into [threshold, window). The Host (not a
// manual rotate() call, not a fabricated usage event) automatically rotates and
// CARRIES the unsettled review hold. The replacement Session's first provider
// request is captured; the same trigger/counters/consumption/hold are present,
// the old transcript is not replayed, and the old high-water does not chain a
// second rotation. The new Session must refuse effects while held, yet allow an
// authorized workspace read, knowledge retrieval and the real review. Only after
// a legal scoped Intent may the original Task continue to the fixture Oracle.
//
// No product patch, no getContextUsage monkey-patch, no real model/network.

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
const PAD_MARKER = "P2_07_OLD_SESSION_PADDING";
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
const indexOfId = (rows, id) => rows.findIndex((row) => row.event_id === id);
function ramOf(messages) {
	const raw = messages.map(textOf).findLast((text) => text.startsWith("<aegis_ram>\n"));
	if (!raw) return null;
	return JSON.parse(raw.slice("<aegis_ram>\n".length).replace(/\n<\/aegis_ram>\s*$/, ""));
}

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-work-context-carry-"));
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
					"# Fixture door recovery\n\n## When\n\nRepeated fixture door updates leave locked true.\n\n## Do\n\nRead the door and set locked false.\n\n## Limits\n\nReference only; independent verification required.\n",
				source: { source_kind: "local_document", source_uri: "file:///test/door.md" },
			}),
		),
	);
	const envKeys = ["AEGIS_KNOWLEDGE_DIR", "AEGIS_KNOWLEDGE_ENABLED", "AEGIS_WEB_SEARCH"];
	const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
	process.env.AEGIS_KNOWLEDGE_DIR = knowledge;
	process.env.AEGIS_KNOWLEDGE_ENABLED = "on";
	process.env.AEGIS_WEB_SEARCH = "off";
	const manifest = buildC3FixtureManifest({ workspaceRoot: workspace, campaignId: "campaign-context-carry" });
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
			provider: { kind: "faux", model: "context-carry" },
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
	const decisions = (value) =>
		fauxToolCall("aegis_task_decision", {
			actions: [{ action_ref: "fixture.state.set", arguments: { target: "door.json", key: "locked", value } }],
		});
	const sessions = [];
	const requests = [];
	const toolResults = [];
	const toolTrace = [];
	let dispatch = 0;
	let lastDispatchKey = null;
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
				// Real SDK usage: bounded per-token accounting with a small window, so the
				// persisted faux text actually raises ctx.getContextUsage().
				const faux = registerFauxProvider({
					...options,
					models: options.models.map((model) => ({ ...model, contextWindow: 64000, maxTokens: 64000 })),
					tokenSize: { min: 4096, max: 4096 },
				});
				const responder = (context) => {
					assert.ok(requests.length < 50, "bounded responder must not spin");
					const messages = context.messages ?? [];
					const activeSession = sessions.at(-1);
					requests.push({ sessionId: activeSession.sessionId, messages: structuredClone(messages), prefix: rows() });
					const lastAssistant = messages.map((message) => message.role).lastIndexOf("assistant");
					const lastTaskPrompt = messages.findLastIndex(
						(message) => message.role === "user" && textOf(message).trimStart().startsWith(`TASK ${TASK}`),
					);
					const toolResultAfter = messages
						.slice(Math.max(lastAssistant, lastTaskPrompt) + 1)
						.some((message) => message.role === "toolResult");
					const taskPrompts = messages.filter(
						(message) => message.role === "user" && textOf(message).trimStart().startsWith(`TASK ${TASK}`),
					).length;
					if (toolResultAfter) {
						for (const message of messages.filter((entry) => entry.role === "toolResult")) {
							if (!toolResults.includes(textOf(message))) toolResults.push(textOf(message));
						}
						// Attribute each tool call to its ordered tool result. The SDK emits
						// the tool calls in one assistant message and the results in order, so
						// a direct product-level read/review/effect outcome is observable.
						const assistantIndex = messages.map((m) => m.role).lastIndexOf("assistant");
						const assistant = messages[assistantIndex];
						const calls = (Array.isArray(assistant?.content) ? assistant.content : []).filter(
							(part) => part?.type === "toolCall",
						);
						const results = messages.slice(assistantIndex + 1).filter((m) => m.role === "toolResult");
						for (let index = 0; index < calls.length && index < results.length; index += 1) {
							toolTrace.push({ name: calls[index].name, text: textOf(results[index]) });
						}
						if (dispatch === 1 && sessions.length === 1)
							return fauxAssistantMessage(`${PAD_MARKER}\n${"pressure-data ".repeat(14000)}`);
						return fauxAssistantMessage("tool result observed");
					}
					if (taskPrompts === 0) return fauxAssistantMessage("continue from the committed review hold");
					const key = `${activeSession.sessionId}:${taskPrompts}`;
					if (key !== lastDispatchKey) {
						lastDispatchKey = key;
						dispatch += 1;
					}
					if (dispatch === 1)
						return fauxAssistantMessage([
							fauxToolCall("aegis_propose", { kind: "intent", text: "initial repeated probe", scope: "unit:initial" }),
							...Array.from({ length: 4 }, () => decisions(true)),
						]);
					if (dispatch === 2)
						return fauxAssistantMessage([
							fauxToolCall("aegis_knowledge", { query: "fixture door recovery locked" }),
							fauxToolCall("aegis_work_review", {
								blocker: "three fixture effects left locked true",
								knowledge_query: "fixture door recovery locked",
								next_step: "read the door and try locked false",
								tried_routes: ["fixture.state.set locked=true"],
							}),
							fauxToolCall("aegis_work_checkpoint", {
								unit_status: "continue",
								summary: "carried hold observed in the replacement Session",
							}),
							fauxToolCall("aegis_read", { path: "door.json" }),
							fauxToolCall("aegis_read", { path: "../outside.json" }),
							decisions(false),
						]);
					if (dispatch === 3)
						return fauxAssistantMessage([
							fauxToolCall("aegis_work_checkpoint", {
								unit_status: "continue",
								summary: "effect gate probe in the replacement Session",
							}),
							decisions(false),
						]);
					const review = reviews().at(-1);
					assert.ok(review, "the carried hold must have a real review before the Intent");
					return fauxAssistantMessage([
						fauxToolCall("aegis_propose", {
							kind: "intent",
							text: "continue the original task after the carried review",
							scope: "unit:after-carry",
							source_refs: [{ ref_type: "event", ref_id: review.event_id }],
						}),
						decisions(false),
					]);
				};
				faux.setResponses(Array.from({ length: 50 }, () => responder));
				return faux;
			},
		});
		const events = rows();
		check("C6 run reports ok", outcome.ok === true, JSON.stringify(outcome.reasons));
		check("event chain verifies", verifyChain(events).ok === true);
		check(
			"Task completed through the independent fixture judge",
			outcome.task_states[TASK] === "completed",
			JSON.stringify(outcome.task_states),
		);
		check(
			"real fixture file reflects the final effect",
			JSON.parse(readFileSync(join(workspace, "door.json"), "utf8")).locked === false,
		);

		const completions = events.filter((row) => row.event_type === "handoff.completed");
		check("exactly one automatic rotation occurs", completions.length === 1, `count=${completions.length}`);
		check(
			"the Host applied exactly one rotation",
			outcome.rotation_attempts.filter((attempt) => attempt.applied === true).length === 1,
			JSON.stringify(outcome.rotation_attempts),
		);
		check("exactly one replacement Session object", sessions.length === 2, `count=${sessions.length}`);
		if (sessions.length === 2) {
			check("replacement is a different SDK object", sessions[0] !== sessions[1]);
			check("replacement has a different session id", sessions[0].sessionId !== sessions[1].sessionId);
			check("replacement has a different session file", sessions[0].sessionFile !== sessions[1].sessionFile);
		}
		check("one Episode only", events.filter((row) => row.event_type === "episode.started").length === 1);
		const completion = completions[0];
		const completedAt = completion ? indexOfId(events, completion.event_id) : -1;
		check(
			"the rotation is a context-pressure boundary tied to the SOURCE session",
			completion && String(completion.payload?.work_cycle_identity).startsWith(`context:${sessions[0]?.sessionId}:`),
			JSON.stringify(completion?.payload),
		);
		const settled =
			completedAt > 0 ? events.slice(0, completedAt).findLast((row) => row.event_type === "agent.settled") : null;
		check("usage came from the real SDK settled event", settled?.payload?.session_id === sessions[0]?.sessionId);
		check(
			"usage is known and at/above the threshold",
			settled?.payload?.context_usage?.known === true && settled.payload.context_usage.percent >= 85,
			JSON.stringify(settled?.payload?.context_usage),
		);
		check(
			"usage stays below the window limit",
			settled?.payload?.context_usage?.percent < 100,
			JSON.stringify(settled?.payload?.context_usage),
		);
		check(
			"no review exists before the rotation (unresolved hold carried)",
			completedAt > 0 && events.slice(0, completedAt).every((row) => row.payload?.kind !== "work.review"),
		);

		const before = projectWorkCycle(events.slice(0, completedAt), EPISODE, { policy: POLICY, manifest });
		check("source prefix is review_required", before.status === "review_required", JSON.stringify(before.status));
		console.log(
			`CONTEXT_EVIDENCE ${JSON.stringify({
				sourceSession: sessions[0]?.sessionId,
				replacementSession: sessions[1]?.sessionId,
				usage: settled?.payload?.context_usage,
				identity: completion?.payload?.work_cycle_identity,
				completions: completions.length,
				rotationsApplied: outcome.rotation_attempts.filter((attempt) => attempt.applied === true).length,
			})}`,
		);
		const firstReplacement = requests.find((request) => request.sessionId === sessions[1]?.sessionId);
		check("captured the first provider-bound request of the replacement", Boolean(firstReplacement));
		const after = firstReplacement
			? projectWorkCycle(firstReplacement.prefix, EPISODE, { policy: POLICY, manifest })
			: null;
		check(
			"replacement prefix keeps the same hold status",
			after?.status === "review_required",
			JSON.stringify(after?.status),
		);
		check("replacement prefix keeps the same trigger", after?.trigger_id === before.trigger_id);
		check(
			"replacement prefix keeps cumulative attempts",
			after?.action_count === before.action_count,
			JSON.stringify({ before: before.action_count, after: after?.action_count }),
		);
		check(
			"replacement prefix keeps the round counter",
			after?.review_round_action_count === before.review_round_action_count,
		);
		check(
			"replacement prefix keeps consumption state",
			JSON.stringify(after?.consumptions) === JSON.stringify(before.consumptions),
		);
		const ram = firstReplacement ? ramOf(firstReplacement.messages) : null;
		check("first replacement request carries RAM", Boolean(ram));
		check(
			"RAM keeps the review gate",
			ram?.task?.work_cycle?.status === "review_required",
			JSON.stringify(ram?.task?.work_cycle?.status),
		);
		check("RAM keeps authorization and budget", Boolean(ram?.task?.authorization) && Boolean(ram?.task?.budget));
		const evidence = (ram?.task?.work_cycle?.evidence ?? []).map((alias) => ram.refs[alias]?.id);
		check(
			"RAM evidence aliases resolve to the same trigger evidence",
			evidence.length > 0 && evidence.every((id) => before.evidence_event_ids.includes(id)),
			JSON.stringify(evidence),
		);
		const firstMessages = firstReplacement?.messages ?? [];
		check(
			"old assistant transcript is not replayed",
			firstMessages.some((message) => message.role === "assistant") === false,
		);
		check(
			"bounded RAM may quote an excerpt but not the full pressure transcript",
			firstMessages.every((message) => textOf(message).length < 50000),
		);

		// The replacement's real tool paths.
		const afterRotation = completedAt > 0 ? events.slice(completedAt) : [];
		const readAttempts = toolTrace.filter((entry) => entry.name === "aegis_read");
		check("the replacement actually attempts an authorized workspace read", readAttempts.length > 0);
		check(
			"authorized workspace read actually succeeds in the replacement Session",
			readAttempts.some(
				(entry) =>
					!/work review required|not permitted|denied|refused/i.test(entry.text) &&
					/"locked"\s*:\s*true/.test(entry.text),
			),
			readAttempts.map((entry) => entry.text.slice(0, 240)).join(" || "),
		);
		// The successful read is a REAL committed observation: its own
		// action.requested/completed pair, the returned value, and one balanced
		// durable tool charge. It does NOT clear the carried review.
		const readRequested = afterRotation.filter(
			(row) => row.event_type === "action.requested" && row.payload?.tool_name === "aegis_read",
		);
		const readCompleted = afterRotation.filter(
			(row) => row.event_type === "action.completed" && row.payload?.tool_name === "aegis_read",
		);
		const successfulRead = readCompleted.find((row) => /"locked"\s*:\s*true/.test(row.payload?.content_excerpt ?? ""));
		const successfulRequest = readRequested.find(
			(row) => row.payload?.action_id === successfulRead?.payload?.action_id,
		);
		check(
			"the authorized read has its own committed action pair",
			Boolean(successfulRequest && successfulRead),
			JSON.stringify({
				requested: readRequested.map((row) => row.payload?.action_id),
				completed: readCompleted.map((row) => row.payload?.action_id),
			}),
		);
		check(
			"the committed read result contains the actual fixture value",
			Boolean(successfulRead),
			JSON.stringify(readCompleted.map((row) => row.payload?.content_excerpt)),
		);
		const readCharges = events.filter(
			(row) => row.payload?.kind === "c6.tool" && row.payload?.tool_name === "aegis_read",
		);
		const readChargeKeys = readCharges
			.filter((row) => row.payload?.phase === "charged")
			.map((row) => row.payload?.tool_call_id);
		const readFinishKeys = readCharges
			.filter((row) => row.payload?.phase === "finished")
			.map((row) => row.payload?.tool_call_id);
		check(
			"the authorized read is charged/finished exactly once",
			Boolean(successfulRead) &&
				readChargeKeys.includes(successfulRead.payload.action_id) &&
				readFinishKeys.includes(successfulRead.payload.action_id) &&
				readChargeKeys.length === readFinishKeys.length,
			JSON.stringify({ charged: readChargeKeys, finished: readFinishKeys }),
		);
		check(
			"an escape read is still refused by the path grant",
			readAttempts.some(
				(entry) =>
					/refused|escape|outside|not permitted|denied/i.test(entry.text) && !/"locked"\s*:\s*true/.test(entry.text),
			),
			readAttempts.map((entry) => entry.text.slice(0, 240)).join(" || "),
		);
		const readPrefix = successfulRead ? events.slice(0, indexOfId(events, successfulRead.event_id) + 1) : [];
		const readCycle =
			readPrefix.length > 0 ? projectWorkCycle(readPrefix, EPISODE, { policy: POLICY, manifest }) : null;
		check(
			"the read observation does not clear or reset the carried hold",
			readCycle?.review_required === true &&
				readCycle.consumptions.length === 0 &&
				readCycle.review_round_action_count === before.review_round_action_count,
			JSON.stringify({
				status: readCycle?.status,
				consumptions: readCycle?.consumptions,
				round: readCycle?.review_round_action_count,
				before: before.review_round_action_count,
			}),
		);
		const replacementKnowledge = afterRotation.filter(
			(row) => row.payload?.kind === "knowledge.selected" && row.payload?.mode === "model_query",
		);
		check(
			"knowledge retrieval actually selects local content in the replacement",
			replacementKnowledge.some((row) => (row.payload?.selected ?? []).length > 0),
			JSON.stringify(replacementKnowledge.map((row) => row.payload?.status)),
		);
		const replacementReview = afterRotation.find((row) => row.payload?.kind === "work.review");
		check("the real review is callable in the replacement Session", Boolean(replacementReview));
		check(
			"the replacement review binds the carried trigger",
			replacementReview?.payload?.trigger_id === before.trigger_id,
		);
		check(
			"the replacement review has a real committed retrieval",
			replacementReview &&
				afterRotation.some((row) => row.event_id === replacementReview.payload.retrieval.selection_event_id),
		);
		const blocked = toolResults.filter((text) => /Aegis work review required/.test(text));
		check("a replacement effect attempt is actually refused", blocked.length > 0, `count=${blocked.length}`);
		console.log(
			`CONTEXT_READ_EVIDENCE ${JSON.stringify({
				action_id: successfulRead?.payload?.action_id ?? null,
				request_event_id: successfulRequest?.event_id ?? null,
				completion_event_id: successfulRead?.event_id ?? null,
				content_excerpt: successfulRead?.payload?.content_excerpt ?? null,
				charge_event_ids: readCharges
					.filter((row) => row.payload?.tool_call_id === successfulRead?.payload?.action_id)
					.map((row) => ({ phase: row.payload?.phase, event_id: row.event_id })),
				escape_refusal: readAttempts
					.filter((entry) => !/"locked"\s*:\s*true/.test(entry.text))
					.map((entry) => entry.text.slice(0, 160)),
				round_before: before.review_round_action_count,
				round_at_read: readCycle?.review_round_action_count ?? null,
				hold_status_at_read: readCycle?.status ?? null,
				effect_refusals: blocked.length,
			})}`,
		);
		const beforeIntent = events.slice(completedAt, indexOfId(events, replacementReview?.event_id ?? ""));
		check(
			"no fixture effect executes before the legal Intent",
			beforeIntent.every(
				(row) =>
					!(
						row.event_type === "action.completed" &&
						row.payload?.action_ref === "fixture.state.set" &&
						row.payload?.status === "success"
					),
			),
		);
		const proposeIndex = events.findIndex(
			(row) => row.event_type === "proposal.submitted" && row.payload?.scope === "unit:after-carry",
		);
		const consumed = projectWorkCycle(events.slice(0, proposeIndex + 1), EPISODE, { policy: POLICY, manifest });
		check(
			"the legal Intent consumes the carried review exactly once",
			consumed.consumptions.length === 1,
			JSON.stringify(consumed.consumptions),
		);
		check(
			"consumption binds the replacement review",
			consumed.consumptions[0]?.review_event_id === replacementReview?.event_id,
		);
		const final = projectWorkCycle(events, EPISODE, { policy: POLICY, manifest });
		check(
			"final round counter contains only the post-Intent effect",
			final.review_round_action_count === 1,
			JSON.stringify(final.review_round_action_count),
		);
		check(
			"cumulative attempts keep history",
			final.action_count === consumed.action_count + 1,
			JSON.stringify({ consumed: consumed.action_count, final: final.action_count }),
		);
		// No duplicate Session charge / no second rotation from the old high-water.
		const rotation = outcome.rotation_attempts.find((attempt) => attempt.applied === true);
		check(
			"session generation advanced by exactly one",
			rotation &&
				(rotation.budget_after?.consumed?.session_count ?? 0) ===
					(rotation.budget_before?.consumed?.session_count ?? 0) + 1,
			JSON.stringify(
				rotation?.budget_before
					? { before: rotation.budget_before.consumed, after: rotation.budget_after.consumed }
					: null,
			),
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
			? "\nContext carry: automatic rotation with unsettled hold and replacement-Session recovery passed"
			: `\nContext carry: ${failures} check(s) failed (RED retained)`,
	);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
