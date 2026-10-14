#!/usr/bin/env node
// Aegis E1 task C — unified observation state, board evidence and plan identity.
//
// Uses the REAL SDK/faux product chain (subprocess) and the SAME committed
// inputs the Host uses. Proves:
//   * buildE1View and the real HTTP /api/task-graph agree with the authoritative
//     artifact-aware queue replay, task by task;
//   * a real Campaign Oracle success becomes a traceable board Fact that keeps
//     its original event_id / task / episode / criterion / evidence;
//   * missing/wrong evidence, a model/llm source, a foreign task/episode, an
//     unknown status and a runtime-wrapped success never upgrade to a Fact and
//     never produce a fake completed task;
//   * the tool recorder, Host admission, projection and view share ONE canonical
//     plan digest; repeats are idempotent and changed content is still refused;
//   * an admitted-only prefix stays visibly held; the read-only HTTP view adds no
//     provider call or Broker effect and does not mutate the committed stream.
//
// Run: node Pi_Agent_base/tests/aegis-e1-observation-repair.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { artifactIndexFromEvents } from "../memory/campaign/c3-entry.mjs";
import { buildE1View } from "../memory/campaign/e1-observation.mjs";
import { planDigest } from "../memory/campaign/e1-plan-contract.mjs";
import { createObservationServer } from "../memory/campaign/observation-server.mjs";
import { projectQueueFromEvents } from "../memory/campaign/projection.mjs";
import { projectBoard } from "../memory/runtime/board.mjs";
import { verifyChain } from "../memory/runtime/events.mjs";

const BASE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESOLVER = join(BASE, "pi", "packages", "coding-agent", "src", "experimental", "source-resolver.ts");
const CHILD = join(BASE, "tests", "helpers", "c6-e1-planning-child.mjs");
const root = mkdtempSync(join(tmpdir(), "aegis-e1-observation-c-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

let normal;

before(() => {
	const dir = join(root, "normal");
	mkdirSync(dir, { recursive: true });
	const run = spawnSync(process.execPath, ["--import", RESOLVER, CHILD, dir, "normal_plan"], {
		encoding: "utf8",
		timeout: 60000,
		maxBuffer: 32 * 1024 * 1024,
	});
	assert.equal(run.status, 0, `fixture failed: ${run.stderr?.slice(-1200)}`);
	normal = {
		dir,
		manifestPath: join(dir, "manifest.json"),
		eventsPath: join(dir, "events.jsonl"),
		effectsPath: join(dir, "effects.json"),
		manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
		events: readFileSync(join(dir, "events.jsonl"), "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line)),
	};
	assert.equal(verifyChain(normal.events).ok, true);
});

function artifactsOf(events) {
	return Object.fromEntries(artifactIndexFromEvents(events));
}
function project(events, artifacts = artifactsOf(events)) {
	return projectQueueFromEvents({
		campaign_id: normal.manifest.campaign_id,
		tasks: normal.manifest.tasks ?? [],
		events,
		revision: normal.manifest.revision ?? 0,
		manifest: normal.manifest,
		artifacts,
	});
}
function viewOf(events) {
	return buildE1View({ manifest: normal.manifest, events });
}
function stateMap(list) {
	return Object.fromEntries(list.map((entry) => [entry.task_id, entry.state]));
}

/** Replace exactly the task-level Oracle result for `taskId`. */
function withMutatedOutcome(events, taskId, mutate) {
	let mutatedId = null;
	const out = events.map((event) => {
		if (
			event.payload?.kind !== "campaign.oracle.result" ||
			event.payload.task_id !== taskId ||
			event.payload.task_oracle !== true
		)
			return event;
		const clone = structuredClone(event);
		mutate(clone);
		mutatedId = clone.event_id;
		return clone;
	});
	assert.ok(mutatedId, `no task-level Oracle result for ${taskId}`);
	return { events: out, mutatedId };
}

test("C-STATE-01: buildE1View states match the authoritative artifact-aware replay per task", () => {
	const authority = project(normal.events);
	const view = viewOf(normal.events);
	const actual = stateMap(view.task_graph.nodes);
	const expected = stateMap(authority.tasks);
	assert.deepEqual(actual, expected, "the view must not drift from the authority queue");
	assert.equal(actual["task-plan"], "completed");
	for (const id of ["dyn-a", "dyn-b", "dyn-c"]) assert.equal(actual[id], "completed");
	assert.deepEqual(authority.rejected, []);
	assert.equal(view.task_graph.root.executable, false, "the root goal is never an execution Task");
	assert.equal(view.task_graph.root.state, undefined, "the root goal carries no business state");
});

test("C-FACT-01: real business Oracle success becomes a traceable Fact with its original identity", () => {
	const view = viewOf(normal.events);
	const oracleResults = normal.events.filter(
		(event) =>
			event.payload?.kind === "campaign.oracle.result" &&
			String(event.payload.task_id ?? "").startsWith("dyn-") &&
			event.payload.status === "success",
	);
	assert.ok(oracleResults.length >= 3, "control: real business Oracle success exists");
	const facts = view.board.nodes.filter((node) => node.type === "Fact");
	for (const taskId of ["dyn-a", "dyn-b", "dyn-c"]) {
		const fact = facts.find(
			(node) =>
				node.task_id === taskId &&
				node.evidence_refs.length > 0 &&
				oracleResults.some((event) => event.event_id === node.origin_event_id),
		);
		assert.ok(fact, `no traceable Fact for ${taskId}`);
		assert.equal(fact.effective_status, "current");
		assert.ok(fact.evidence_refs.every((ref) => ref.ref_id));
		assert.ok(fact.episode_id, "the Fact keeps its episode binding");
	}
	// A runtime completion / bare tool success never becomes an Oracle Fact.
	const oracleEventIds = new Set(
		normal.events.filter((event) => event.payload?.kind === "campaign.oracle.result").map((event) => event.event_id),
	);
	assert.ok(
		facts.every((node) => oracleEventIds.has(node.origin_event_id)),
		"only canonical Oracle results may create a Fact",
	);
	const runtimeOnly = projectBoard([
		{
			event_type: "runtime.note",
			source: { kind: "runtime" },
			event_id: "rt-1",
			payload: { kind: "tool.result", task_id: "dyn-a", status: "success", observed: "x" },
			evidence_refs: [{ ref_type: "artifact", ref_id: "artifact:dyn-a" }],
		},
	]);
	assert.equal(runtimeOnly.byType.Fact.length, 0, "a runtime-wrapped bare success is never a Fact");
});

test("C-EVIDENCE-01: missing/wrong evidence, llm source, foreign task/episode and unknown never become a Fact", () => {
	const cases = [
		[
			"missing evidence",
			(event) => {
				event.payload.outcome.evidence_refs = [];
				event.evidence_refs = [];
			},
		],
		[
			"llm source",
			(event) => {
				event.source.kind = "llm";
			},
		],
		[
			"foreign task",
			(event) => {
				event.payload.outcome.task_id = "dyn-foreign";
				event.payload.outcome.provenance.task_id = "dyn-foreign";
			},
		],
		[
			"foreign episode",
			(event) => {
				event.payload.outcome.episode_id = "ep-foreign";
			},
		],
		[
			"unknown status",
			(event) => {
				event.payload.status = "unknown";
				event.payload.outcome.status = "unknown";
			},
		],
	];
	for (const [label, mutate] of cases) {
		const { events, mutatedId } = withMutatedOutcome(normal.events, "dyn-a", mutate);
		const authority = project(events);
		assert.notEqual(
			authority.tasks.find((task) => task.task_id === "dyn-a")?.state,
			"completed",
			`${label}: no fake completed`,
		);
		const view = viewOf(events);
		assert.notEqual(
			view.task_graph.nodes.find((task) => task.task_id === "dyn-a")?.state,
			"completed",
			`${label}: view agrees`,
		);
		const board = projectBoard(events, { manifest: normal.manifest });
		assert.equal(
			board.byType.Fact.some((node) => node.origin_event_id === mutatedId),
			false,
			`${label}: must not become a Fact`,
		);
		const hint = board.byType.Hint.find((node) => node.origin_event_id === mutatedId);
		assert.ok(hint, `${label}: the downgrade is visible as a Hint`);
		assert.ok(hint.downgrade_reason, `${label}: the downgrade reason is present`);
	}
	// Control: the UNMUTATED chain still projects the same event as a Fact, so the
	// downgrade above is caused by the mutation and not by a blanket fail-closed.
	const control = projectBoard(normal.events, { manifest: normal.manifest });
	const dynATask = normal.events.find(
		(event) =>
			event.payload?.kind === "campaign.oracle.result" &&
			event.payload.task_id === "dyn-a" &&
			event.payload.task_oracle === true,
	);
	assert.ok(control.byType.Fact.some((node) => node.origin_event_id === dynATask.event_id));
});

test("C-IDENTITY-01: one canonical plan digest; repeats idempotent; changed content refused", () => {
	const submitted = normal.events.filter((event) => event.payload?.kind === "campaign.plan.submitted");
	const admitted = normal.events.find((event) => event.payload?.kind === "campaign.plan.admitted");
	assert.ok(submitted.length >= 2, "the tool recorder and the Host both record the candidate");
	assert.equal(new Set(submitted.map((event) => event.payload.plan_digest)).size, 1, "all submitted digests agree");
	assert.equal(submitted[0].payload.plan_digest, admitted.payload.plan_digest, "submitted and admitted agree");
	assert.equal(
		admitted.payload.plan_digest,
		planDigest(submitted[0].payload.plan),
		"the canonical planDigest is shared",
	);
	assert.deepEqual(project(normal.events).rejected, []);

	const baseline = project(normal.events);
	const repeat = project([...normal.events, structuredClone(submitted[0]), structuredClone(admitted)]);
	assert.deepEqual(repeat.rejected, [], "a repeated identical submission/admission is idempotent");
	assert.equal(repeat.plans.filter((plan) => plan.id === "plan-e1").length, 1, "no double admission");
	assert.deepEqual(repeat.budget.reserved, baseline.budget.reserved, "no double reservation");

	const changed = structuredClone(submitted[0]);
	changed.payload.plan.tasks[0].goal.description = "tampered content";
	changed.payload.plan_digest = planDigest(changed.payload.plan);
	const tampered = project([...normal.events, changed]);
	assert.ok(
		tampered.rejected.some((entry) => /different digest/.test(entry.reason)),
		JSON.stringify(tampered.rejected),
	);
});

test("C-HOLD-01: an admitted-only prefix stays held and is visible in the view", () => {
	const end = normal.events.findIndex((event) => event.payload?.kind === "campaign.plan.admitted");
	assert.ok(end >= 0);
	const prefix = normal.events.slice(0, end + 1);
	const view = viewOf(prefix);
	assert.deepEqual(
		view.plans.admitted.map((plan) => plan.plan_id),
		["plan-e1"],
	);
	const children = view.task_graph.nodes.filter((node) => node.task_id.startsWith("dyn-"));
	assert.equal(children.length, 3);
	for (const child of children) assert.notEqual(child.state, "completed", `${child.task_id} is held`);
});

test("C-READONLY-01: the real HTTP /api/task-graph matches the replay and adds no provider/effect", async (t) => {
	const effectsBefore = JSON.parse(readFileSync(normal.effectsPath, "utf8")).effects;
	const rowsBefore = normal.events.length;
	const server = createObservationServer({
		manifestPath: normal.manifestPath,
		eventsPath: normal.eventsPath,
		host: "127.0.0.1",
		port: 0,
	});
	await server.listen();
	t.after(() => server.close());
	const response = await fetch(new URL("/api/task-graph", server.url).href);
	assert.equal(response.status, 200);
	const body = await response.json();
	const actual = stateMap(body.task_graph.nodes);
	const expected = stateMap(project(normal.events).tasks);
	assert.deepEqual(actual, expected, "HTTP state equals the authoritative replay");
	assert.equal(body.task_graph.nodes.find((node) => node.task_id === "dyn-c").depends_on.length, 2);
	// Read-only path: no new committed row and no new Broker effect.
	const rowsAfter = readFileSync(normal.eventsPath, "utf8").trim().split("\n").filter(Boolean).length;
	const effectsAfter = JSON.parse(readFileSync(normal.effectsPath, "utf8")).effects;
	assert.equal(rowsAfter, rowsBefore, "the read-only view appends nothing");
	assert.equal(effectsAfter, effectsBefore, "the read-only view produces no Broker effect");
});
