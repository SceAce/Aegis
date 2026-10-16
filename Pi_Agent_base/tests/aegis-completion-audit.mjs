#!/usr/bin/env node
// Independent completion audit of product baseline 381829a. Negative cases
// inject one contract fault into a REAL SDK/faux product trace and recompute
// its hash chain. No fabricated positive Oracle events or paid calls.
// Expected failures are regression evidence, never an engineering pass.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { artifactIndexFromEvents } from "../campaign/c3-entry.mjs";
import { planDigest } from "../campaign/e1-plan-contract.mjs";
import { projectQueueFromEvents } from "../campaign/projection.mjs";
import { buildE1View } from "../observation/e1-observation.mjs";
import { eventDigest, verifyChain } from "../shared/events.mjs";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resolver = join(base, "pi/packages/coding-agent/src/experimental/source-resolver.ts");
const child = join(base, "tests/helpers/c6-e1-planning-child.mjs");
const evidenceRoot = join(base, "runtime/dev/completion-audit-20261015/independent");
mkdirSync(evidenceRoot, { recursive: true });
const workDir = mkdtempSync(join(evidenceRoot, "cases-"));
console.log(`completion audit evidence: ${workDir}`);
let normal;

function scenario(name, directory) {
	const dir = join(workDir, directory);
	const result = spawnSync(process.execPath, ["--import", resolver, child, dir, name], {
		encoding: "utf8",
		timeout: 60000,
		maxBuffer: 8 * 1024 * 1024,
	});
	writeFileSync(join(workDir, `${directory}-${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`);
	assert.equal(result.status, 0, `offline product child failed: ${result.stderr?.slice(-1000)}`);
	return {
		dir,
		manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
		events: readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse),
		summary: JSON.parse(readFileSync(join(dir, `summary-${name}.json`), "utf8")),
	};
}

function rechain(events) {
	let previous;
	for (const event of events) {
		if (previous === undefined) delete event.prev_event_digest;
		else event.prev_event_digest = previous;
		event.event_digest = eventDigest(event);
		previous = event.event_digest;
	}
	assert.equal(verifyChain(events).ok, true, "faulted input must still be a valid hash chain");
	assert.equal(
		verifyChain(JSON.parse(JSON.stringify(events))).ok,
		true,
		"the persisted JSON representation must preserve the chain",
	);
	return events;
}

function project(events, manifest = normal.manifest) {
	return projectQueueFromEvents({
		campaign_id: manifest.campaign_id,
		tasks: manifest.tasks,
		manifest,
		revision: manifest.revision ?? 0,
		events,
		artifacts: Object.fromEntries(artifactIndexFromEvents(events)),
	});
}

function record(label, events, manifest = normal.manifest) {
	rechain(events);
	const projection = project(events, manifest);
	const view = buildE1View({ manifest, events });
	const facts = view.board.nodes.filter((node) => node.type === "Fact" && node.task_id === "dyn-a");
	const diagnostic = {
		chain_ok: verifyChain(events).ok,
		tasks: projection.tasks.map((task) => ({ id: task.task_id, state: task.state })),
		plans: projection.plans.map((plan) => ({
			id: plan.id,
			status: plan.status,
			planning_task_id: plan.planning_task_id,
		})),
		rejected: projection.rejected,
		facts: facts.map((node) => ({ event_id: node.origin_event_id, type: node.type, criterion: node.criterion })),
	};
	writeFileSync(join(workDir, `${label}.json`), `${JSON.stringify(diagnostic, null, 2)}\n`);
	writeFileSync(join(workDir, `${label}.jsonl`), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
	return { projection, view, facts };
}

function mutateOutcomes(mutate) {
	const events = structuredClone(normal.events);
	let changed = 0;
	for (const event of events) {
		if (event.payload?.kind === "campaign.oracle.result" && event.payload.task_id === "dyn-a") {
			mutate(event);
			changed += 1;
		}
	}
	assert.ok(changed >= 2, "control: mutate both actual stage and Task Oracle results");
	return events;
}

function assertNoAdmission(projection) {
	assert.ok(projection.rejected.length > 0, "incomplete/conflicting identity must be visibly rejected");
	assert.equal(projection.tasks.filter((task) => task.is_dynamic).length, 0, "no dynamic task prefix");
	assert.equal(projection.dynamic_definitions.length, 0, "no dynamic definition mutation");
	assert.equal(
		projection.plans.some((plan) => plan.status === "admitted"),
		false,
		"no admitted plan",
	);
}

before(() => {
	normal = scenario("normal_plan", "normal");
});

test("CA-01 CONTROL: actual SDK/faux product completes with verified evidence", () => {
	assert.equal(normal.summary.provider_calls, 8);
	assert.equal(normal.summary.broker_effects, 3);
	assert.deepEqual(normal.summary.dataset, { name: "Ada", status: "active" });
	const { projection, facts } = record("control", structuredClone(normal.events));
	assert.deepEqual(projection.rejected, []);
	assert.equal(projection.tasks.find((task) => task.task_id === "dyn-a").state, "completed");
	assert.ok(facts.length >= 1);
});

for (const [id, label, mutate] of [
	[
		"CA-02",
		"foreign-scope",
		(event) => {
			event.payload.outcome.scope = { ...event.payload.outcome.scope, environment_fingerprint: "audit-foreign" };
		},
	],
	[
		"CA-03",
		"undeclared-criterion",
		(event) => {
			event.payload.outcome.criterion.criterion_id = "audit-undeclared";
		},
	],
	[
		"CA-04",
		"unresolvable-evidence",
		(event) => {
			const refs = [{ ref_type: "artifact", ref_id: "audit-missing-artifact" }];
			event.evidence_refs = refs;
			event.payload.outcome.evidence_refs = refs;
		},
	],
]) {
	test(`${id}: ${label} rejected by the authority must not become Board Facts`, () => {
		const { projection, facts } = record(label, mutateOutcomes(mutate));
		assert.notEqual(projection.tasks.find((task) => task.task_id === "dyn-a").state, "completed");
		assert.ok(projection.rejected.length > 0, "control: authority rejects the invalid results");
		assert.equal(facts.length, 0, "a rejected result cannot be trusted guidance in Board/live RAM");
	});
}

test("CA-05: a rejected admission cannot establish dynamic Board identities", () => {
	const events = structuredClone(normal.events);
	events.find((event) => event.payload?.kind === "campaign.plan.admitted").payload.plan_digest = "sha256:conflict";
	const { projection, facts } = record("rejected-admission", events);
	assert.equal(
		projection.tasks.some((task) => task.task_id === "dyn-a"),
		false,
	);
	assert.ok(projection.rejected.length > 0);
	assert.equal(facts.length, 0, "raw rejected admission/start events cannot establish verified Board bindings");
});

for (const [id, kind] of [
	["CA-06", "campaign.plan.submitted"],
	["CA-07", "campaign.plan.admitted"],
]) {
	test(`${id}: missing planning_task_id on ${kind} rejects the batch`, () => {
		const events = structuredClone(normal.events);
		for (const event of events) if (event.payload?.kind === kind) delete event.payload.planning_task_id;
		const { projection } = record(`missing-identity-${id}`, events);
		assertNoAdmission(projection);
	});
}

test("CA-08: normalized definitions must remain bound to the submitted candidate", () => {
	const events = structuredClone(normal.events);
	const admission = events.find((event) => event.payload?.kind === "campaign.plan.admitted");
	admission.payload.plan_tasks[0].target_ref = "outside-the-manifest.json";
	const { projection } = record("changed-normalized-definition", events);
	assertNoAdmission(projection);
});

test("CA-09: candidate plan_id must equal its submitted/admitted envelope identity", () => {
	const events = structuredClone(normal.events);
	let changedDigest;
	for (const event of events) {
		if (event.payload?.kind === "campaign.plan.submitted") {
			event.payload.plan.plan_id = "audit-foreign-inner-plan";
			changedDigest = planDigest(event.payload.plan);
			event.payload.plan_digest = changedDigest;
		}
	}
	events.find((event) => event.payload?.kind === "campaign.plan.admitted").payload.plan_digest = changedDigest;
	const { projection } = record("inner-plan-identity-mismatch", events);
	assertNoAdmission(projection);
});

test("CA-10 CONTROL: repeated identical submitted/admitted records stay idempotent", () => {
	const prefixEnd = normal.events.findIndex((event) => event.payload?.kind === "campaign.plan.admitted");
	const prefix = structuredClone(normal.events.slice(0, prefixEnd + 1));
	const baseline = project(prefix);
	const repeated = structuredClone(prefix);
	for (const kind of ["campaign.plan.submitted", "campaign.plan.admitted"]) {
		const duplicate = structuredClone(prefix.find((event) => event.payload?.kind === kind));
		duplicate.event_id = `audit-duplicate-${kind}`;
		duplicate.sequence = repeated.filter((event) => event.episode_id === duplicate.episode_id).length;
		repeated.push(duplicate);
	}
	const actual = project(repeated);
	assert.deepEqual(actual.rejected, []);
	assert.equal(actual.tasks.length, baseline.tasks.length);
	assert.deepEqual(actual.budget, baseline.budget);
});

function restartReadyPrefix(directory, removeIdentity) {
	const initial = scenario("normal_plan", directory);
	const end = initial.events.findIndex((event) => event.payload?.kind === "campaign.plan.ready");
	assert.ok(end >= 0);
	const prefix = structuredClone(initial.events.slice(0, end + 1));
	if (removeIdentity) {
		for (const event of prefix) {
			if (["campaign.plan.submitted", "campaign.plan.admitted"].includes(event.payload?.kind))
				delete event.payload.planning_task_id;
		}
	}
	record(`${directory}-prefix`, prefix, initial.manifest);
	writeFileSync(join(initial.dir, "events.jsonl"), `${prefix.map((event) => JSON.stringify(event)).join("\n")}\n`);
	writeFileSync(join(initial.dir, "workspace/dataset.json"), JSON.stringify({ name: "??", status: "pending" }));
	writeFileSync(join(initial.dir, "effects.json"), JSON.stringify({ effects: 0 }));
	return scenario("restart", directory);
}

test("CA-11 CONTROL: a valid ready prefix permits the expected real subprocess execution", () => {
	const result = restartReadyPrefix("valid-restart", false);
	assert.equal(verifyChain(result.events).ok, true);
	assert.equal(result.summary.provider_calls, 6);
	assert.equal(result.summary.broker_effects, 3);
	assert.deepEqual(result.summary.dataset, { name: "Ada", status: "active" });
});

test("CA-12: a prefix missing both planning identities must not dispatch after restart", () => {
	const result = restartReadyPrefix("missing-identity-restart", true);
	assert.equal(verifyChain(result.events).ok, true);
	assert.equal(result.summary.provider_calls, 0, "an unbound plan must not authorize another provider call");
	assert.equal(result.summary.broker_effects, 0, "an unbound plan must not authorize a Broker effect");
});
