#!/usr/bin/env node
// P2-07 / P2-09 / P2-10 / P2-12 / P2-13 / P2-15 — REAL C6 Host + Pi SDK + faux.
//
// One Task/Episode (task-hard / ep-task-hard) crosses THREE Sessions:
//   * dispatch 1 commits 3 identical failing effects -> trigger R1;
//   * dispatch 2 buffers an effect while the hold is active -> the Broker gate
//     blocks it (no action.requested, Task stays non-terminal);
//   * dispatch 3 performs the REAL review (local retrieval) + new scoped Intent +
//     complete checkpoint -> Host auto-rotates ONCE through the Supervisor;
//   * the replacement Session repeats the stall in unit 2, reviews it and rotates
//     again (different trigger, same Task/Episode);
//   * the third Session performs the real effect -> independent Oracle success.
//
// No real model/network/target is used.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const base = mkdtempSync(join(tmpdir(), "aegis-work-cycle-host-"));
const workspace = join(base, "workspace");
const work = join(base, "run");
const knowledge = join(base, "knowledge");
for (const dir of [workspace, work, knowledge]) mkdirSync(dir, { recursive: true });
const previousKnowledge = process.env.AEGIS_KNOWLEDGE_DIR;
process.env.AEGIS_KNOWLEDGE_DIR = knowledge;

try {
	writeFileSync(join(workspace, "door.json"), JSON.stringify({ locked: true }));
	writeFileSync(
		join(knowledge, "door.json"),
		JSON.stringify(
			compileDocumentSeed({
				markdown:
					"# Fixture door technique\n\n## When\n\nThe door state does not match the criterion after repeated attempts.\n\n## Do\n\nRe-read the state and apply the opposite boolean deliberately.\n\n## Expect\n\nThe independent judge observes the expected boolean.\n\n## Limits\n\nOnly the registered fixture action is authorized.\n",
				source: { source_kind: "local_document", source_uri: "file:///knowledge/door.md" },
			}),
		),
	);
	const manifest = buildC3FixtureManifest({ workspaceRoot: workspace, campaignId: "campaign-work-cycle-host" });
	manifest.objective.description = "One hard fixture task across multiple short Sessions.";
	manifest.objective.success_criteria = ["door.locked == false"];
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
	const configPath = join(base, "campaign.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			schema_version: "campaign-config-1.1",
			manifest_path: join(base, "manifest.json"),
			workspace_root: workspace,
			work_dir: work,
			mode: "auto",
			provider: { kind: "faux", model: "work-cycle-host" },
			context: { strategy: "bounded_ram", max_total_input_chars: 200000, output_reserve_chars: 1000 },
			learning: { policy: "off", promote_experience: false },
			task_family: "fixture-state",
			session: { session_count: 8, max_requests_per_session: 20 },
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

	const eventLogPath = join(work, "events.jsonl");
	const latestIntentEvent = () => {
		try {
			const rows = readFileSync(eventLogPath, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			return (
				[...rows].reverse().find((row) => row.event_type === "proposal.submitted" && row.payload?.kind === "intent")
					?.event_id ?? null
			);
		} catch {
			return null;
		}
	};
	const latestReview = () => {
		try {
			const rows = readFileSync(eventLogPath, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			const review = [...rows].reverse().find((row) => row.payload?.kind === "work.review");
			return review ?? null;
		} catch {
			return null;
		}
	};
	const messageText = (message) => {
		if (!message) return "";
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content))
			return message.content.map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join(" ");
		return "";
	};
	const taskPromptCount = (messages) =>
		messages.filter(
			(message) => message?.role === "user" && messageText(message).trimStart().startsWith("TASK task-hard"),
		).length;
	const action = (value, sourceRefs = []) =>
		fauxToolCall("aegis_task_decision", {
			actions: [
				{
					action_ref: "fixture.state.set",
					arguments: { target: "door.json", key: "locked", value },
					...(sourceRefs.length > 0 ? { source_refs: sourceRefs } : {}),
				},
			],
		});
	const batch = (value) => {
		const sourceRefs = [];
		const review = latestReview();
		if (review) sourceRefs.push(review.event_id, review.payload?.retrieval?.selection_event_id);
		const currentIntent = latestIntentEvent();
		if (currentIntent) sourceRefs.push(currentIntent);
		return fauxAssistantMessage(
			[1, 2, 3, 4].map(() =>
				fauxToolCall("aegis_task_decision", {
					actions: [
						{
							action_ref: "fixture.state.set",
							arguments: { target: "door.json", key: "locked", value },
							...(sourceRefs.length > 0 ? { source_refs: sourceRefs } : {}),
						},
					],
				}),
			),
		);
	};
	const startTurn = () => {
		const message = batch(true);
		return fauxAssistantMessage([
			fauxToolCall("aegis_propose", {
				kind: "intent",
				text: "initial door probe unit",
				scope: "unit:door-initial",
			}),
			...message.content,
		]);
	};
	const reviewTurn = () =>
		fauxAssistantMessage([
			fauxToolCall("aegis_work_review", {
				blocker: "the repeated door update keeps the independent criterion false",
				knowledge_query: "fixture door state repeated attempts criterion",
				next_step: "switch to the opposite boolean deliberately",
				tried_routes: ["fixture.state.set locked=true x4"],
			}),
		]);
	const proposeTurn = () => {
		const review = latestReview();
		assert.ok(review?.event_id, "the review must be committed before the follow-up Intent");
		const selectionId = review?.payload?.retrieval?.selection_event_id;
		const nextScope = `unit:door-${Math.random().toString(16).slice(2, 8)}`;
		return fauxAssistantMessage([
			fauxToolCall("aegis_propose", {
				kind: "intent",
				text: `probe the opposite door state (${nextScope})`,
				scope: nextScope,
				source_refs: [
					{ ref_type: "event", ref_id: review.event_id },
					...(selectionId ? [{ ref_type: "event", ref_id: selectionId }] : []),
				],
			}),
			fauxToolCall("aegis_work_checkpoint", {
				unit_status: "complete",
				summary: "reviewed the repeated failure and selected the opposite state probe",
				next_step: "run the next unit in a fresh Session",
			}),
		]);
	};

	let providerRequests = 0;
	let dispatch = 0;
	let lastTaskPromptCount = 0;
	const outcome = await runC6FromConfig({
		configPath,
		sdk: { ...sdkBase, AuthStorage },
		print() {},
		fauxProviderFactory(options) {
			const faux = registerFauxProvider(options);
			const responder = (context) => {
				providerRequests += 1;
				const messages = context.messages ?? [];
				// Tool follow-up inside the same dispatch: the RAM tail may be a user
				// message AFTER the toolResult, so detect "a tool result exists after the
				// last assistant tool call" instead of only looking at the last message.
				const lastAssistant = messages.map((m) => m?.role).lastIndexOf("assistant");
				const toolResultAfter = messages
					.slice(lastAssistant + 1)
					.some((message) => message?.role === "toolResult" || message?.role === "tool");
				if (toolResultAfter) return fauxAssistantMessage("decision recorded");
				const promptCountNow = taskPromptCount(messages);
				// The Host's post-rotation continuation prompt is NOT a C6 task
				// dispatch; answer it without tools so it cannot drive the scenario.
				if (promptCountNow === 0) return fauxAssistantMessage("continuing in the replacement Session");
				if (promptCountNow !== lastTaskPromptCount) {
					lastTaskPromptCount = promptCountNow;
					dispatch += 1;
				}
				const phase = dispatch;
				if (phase === 1) return startTurn(); // initial unit + 3 effects + 1 blocked
				if (phase === 2) return reviewTurn();
				if (phase === 3) return proposeTurn();
				if (phase === 4) return batch(true); // new unit, second stall
				if (phase === 5) return reviewTurn();
				if (phase === 6) return proposeTurn();
				return fauxAssistantMessage([action(false)]); // independent success
			};
			faux.setResponses(Array.from({ length: 40 }, () => responder));
			return faux;
		},
	});
	assert.equal(outcome.ok, true, JSON.stringify(outcome.reasons));
	assert.equal(outcome.task_states["task-hard"], "completed", JSON.stringify(outcome.task_states));
	const events = readFileSync(eventLogPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	assert.equal(verifyChain(events).ok, true);

	const reviews = events.filter((row) => row.payload?.kind === "work.review");
	const triggers = new Set(reviews.map((row) => row.payload?.trigger_id));
	assert.equal(reviews.length, 2, `two distinct reviews expected, got ${reviews.length}`);
	assert.equal(triggers.size, 2, "the two reviews must bind different triggers");
	const completions = events.filter((row) => row.event_type === "handoff.completed");
	assert.equal(completions.length, 2, `two real rotations expected, got ${completions.length}`);
	const sessions = new Set(
		events
			.filter((row) => row.event_type === "handoff.completed")
			.map((row) => row.payload?.to_session)
			.filter(Boolean),
	);
	assert.equal(sessions.size, 2, "each rotation must bind a distinct replacement Session id");
	const boundaries = completions.map((row) => row.payload?.work_cycle_identity).filter(Boolean);
	assert.equal(new Set(boundaries).size, 2, "each rotation carries a distinct boundary identity");
	// The same Episode, one Task, multiple work units.
	const episodeIds = new Set(events.filter((row) => row.event_type === "episode.started").map((row) => row.episode_id));
	assert.equal(episodeIds.size, 1, "one Episode only");
	const intents = events.filter((row) => row.event_type === "proposal.submitted" && row.payload?.kind === "intent");
	assert.ok(intents.length >= 3, `at least 3 work units expected, got ${intents.length}`);
	// The blocked attempts executed NO effect.
	const effects = events.filter(
		(row) => row.event_type === "action.requested" && row.payload?.action_ref === "fixture.state.set",
	);
	const completionsByAction = new Set(
		events
			.filter((row) => row.event_type === "action.completed" && row.payload?.status === "success")
			.map((row) => row.payload?.action_id),
	);
	const executed = effects.filter((row) => completionsByAction.has(row.payload?.action_id));
	assert.equal(executed.length, 7, `expected 3 + 3 + 1 executed effects, got ${executed.length}`);
	// The 4th action in each batch was admitted as intent but the Broker gate
	// refused the effect after the trigger formed mid-batch.
	const rejected = events.filter(
		(row) =>
			row.event_type === "action.completed" &&
			row.payload?.task_id === "task-hard" &&
			row.payload?.status === "rejected" &&
			/work_review_required/.test(String(row.payload?.rejection_reason ?? "")),
	);
	assert.equal(rejected.length, 2, `expected 2 mid-batch Broker blocks, got ${rejected.length}`);
	// The rejected steps produced no successful effect (checked above). The Host
	// records them as non-terminal holds, never as Task failures.
	// No fabricated failure/unknown for the held Task.
	const unknown = events.filter(
		(row) => row.payload?.kind === "campaign.task.unknown" && row.payload?.task_id === "task-hard",
	);
	assert.equal(unknown.length, 0, "a hold is not a Task failure/unknown");
	// Knowledge usage has a resolvable selection/adoption chain but is NOT claimed
	// as independently "used" without action->Outcome evidence.
	const finalCycle = projectWorkCycle(events, "ep-task-hard", {
		policy: { repeat_limit: 3, action_window: 8, min_distinct_routes: 4, context_pressure_percent: 85 },
	});
	assert.ok(Array.isArray(finalCycle.usage), "reference usage must be projected");
	assert.ok(finalCycle.usage.length > 0, "the review selection must appear in usage");
	assert.ok(
		finalCycle.usage.every((entry) => entry.status !== "used"),
		`no independent action->Outcome evidence exists, so usage must not be "used": ${JSON.stringify(finalCycle.usage)}`,
	);
	assert.ok(
		finalCycle.usage.some((entry) => entry.status === "adopted" || entry.status === "selected"),
		JSON.stringify(finalCycle.usage),
	);
	assert.ok(
		finalCycle.usage.some((entry) => typeof entry.action_event_id === "string"),
		`an explicit action reference must be projected: ${JSON.stringify(finalCycle.usage)}`,
	);
	// Session count: the initial Session plus exactly two replacements.
	assert.equal(
		outcome.rotation_attempts.filter((row) => row?.applied === true).length,
		2,
		JSON.stringify(outcome.rotation_attempts),
	);
	// A completed Task must not open a third useless Session.
	assert.equal(providerRequests < 40, true);
	console.log(
		`Work-cycle Host rotation: one Task/Episode, 2 triggers, 2 reviews, 2 automatic Session rotations, blocked effect batches and one independent success passed (providers=${providerRequests})`,
	);
} finally {
	if (previousKnowledge === undefined) delete process.env.AEGIS_KNOWLEDGE_DIR;
	else process.env.AEGIS_KNOWLEDGE_DIR = previousKnowledge;
	rmSync(base, { recursive: true, force: true });
}
