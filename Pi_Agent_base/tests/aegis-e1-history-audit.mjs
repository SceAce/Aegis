#!/usr/bin/env node
// Supplemental history audit. Real SDK/faux submissions through the product;
// no rewritten event history, synthetic Oracle success, or paid provider calls.
// Contract and expected behavior: docs/E1_HISTORY_AUDIT_20261015.md.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { artifactIndexFromEvents } from "../campaign/c3-entry.mjs";
import { projectQueueFromEvents } from "../campaign/projection.mjs";
import { verifyChain } from "../shared/events.mjs";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resolver = join(base, "pi/packages/coding-agent/src/experimental/source-resolver.ts");
const child = join(base, "tests/helpers/c6-e1-planning-child.mjs");
const evidenceRoot = join(base, "runtime/dev/history-audit-20261015/live");
mkdirSync(evidenceRoot, { recursive: true });
const workDir = mkdtempSync(join(evidenceRoot, "cases-"));
console.log(`history audit evidence: ${workDir}`);

function project(events, manifest) {
	return projectQueueFromEvents({
		campaign_id: manifest.campaign_id,
		tasks: manifest.tasks,
		manifest,
		revision: manifest.revision ?? 0,
		events,
		artifacts: Object.fromEntries(artifactIndexFromEvents(events)),
	});
}

function scenario(name) {
	const dir = join(workDir, name);
	const command = ["--import", resolver, child, dir, name];
	const run = spawnSync(process.execPath, command, {
		encoding: "utf8",
		timeout: 60000,
		maxBuffer: 8 * 1024 * 1024,
	});
	writeFileSync(join(workDir, `${name}.log`), `${run.stdout ?? ""}${run.stderr ?? ""}`);
	writeFileSync(
		join(workDir, `${name}-command.json`),
		JSON.stringify({ command: ["node", ...command], exit: run.status }),
	);
	assert.equal(run.status, 0, `SDK/faux child must finish: ${run.stderr?.slice(-1000)}`);
	const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
	const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
	const summary = JSON.parse(readFileSync(join(dir, `summary-${name}.json`), "utf8"));
	assert.equal(verifyChain(events).ok, true, "control: unmodified real EventLog chain must verify");
	const projection = project(events, manifest);
	const requests = {};
	for (const event of events) {
		const p = event.payload;
		if (p?.kind === "c6.request" && p.phase === "committed" && p.provider_started === true) {
			requests[p.task_id] = (requests[p.task_id] ?? 0) + 1;
		}
	}
	const admittedPrefixes = [];
	for (let offset = 0; offset < events.length; offset += 1) {
		if (events[offset].payload?.kind !== "campaign.plan.admitted") continue;
		const prefix = project(events.slice(0, offset + 1), manifest);
		admittedPrefixes.push({
			offset,
			plans: prefix.plans.filter((p) => p.status === "admitted").map((p) => p.id),
			reserved: prefix.budget.reserved,
			consumed: prefix.budget.consumed,
		});
	}
	const diagnostic = {
		scenario: name,
		chain_ok: true,
		provider_calls: summary.provider_calls,
		broker_effects: summary.broker_effects,
		dataset: summary.dataset,
		requests,
		campaign_budget: manifest.budget,
		admitted_prefixes: admittedPrefixes,
		plans: projection.plans.map((p) => ({ id: p.id, status: p.status, root_goal_ref: p.plan?.root_goal_ref })),
		tasks: projection.tasks.map((t) => ({
			id: t.task_id,
			state: t.state,
			allocation: t.definition?.budget_reservation ?? t.definition?.task_budget,
		})),
		rejected: projection.rejected,
	};
	writeFileSync(join(workDir, `${name}-diagnostic.json`), `${JSON.stringify(diagnostic, null, 2)}\n`);
	console.log(JSON.stringify(diagnostic));
	return { manifest, events, summary, projection, requests, admittedPrefixes };
}

test("HA-01 CONTROL: one complete plan runs through SDK, Broker and Oracle", () => {
	const { summary, projection, requests } = scenario("normal_plan");
	assert.deepEqual(projection.rejected, []);
	assert.equal(projection.plans.filter((p) => p.status === "admitted").length, 1);
	assert.equal(summary.provider_calls, 8);
	assert.equal(summary.broker_effects, 3);
	assert.deepEqual(requests, { "task-plan": 2, "dyn-a": 2, "dyn-b": 2, "dyn-c": 2 });
	assert.deepEqual(summary.dataset, { name: "Ada", status: "active" });
	assert.ok(projection.tasks.every((t) => t.state === "completed"));
});

test("HA-02: admitted task allocation bounds actual provider requests before effects", () => {
	const { summary, projection, requests } = scenario("task_budget_plan");
	const dynamic = projection.tasks.filter((t) => t.is_dynamic);
	assert.equal(dynamic.length, 3, "control: a legal one-request allocation can be admitted");
	const overBudget = dynamic
		.filter((t) => (requests[t.task_id] ?? 0) > t.definition.budget_reservation.model_requests)
		.map((t) => ({
			task: t.task_id,
			limit: t.definition.budget_reservation.model_requests,
			actual: requests[t.task_id],
		}));
	assert.deepEqual(
		{ over_budget: overBudget, broker_effects: summary.broker_effects },
		{ over_budget: [], broker_effects: 0 },
		"the second request must stop at the Task gate, preserving the buffered decision without dispatch",
	);
});

test("HA-03: two model submissions cannot admit multiple plans or overallocate Campaign", () => {
	const { manifest, projection, admittedPrefixes } = scenario("double_plan");
	const admitted = projection.plans.filter((p) => p.status === "admitted");
	const violations = [];
	if (admitted.length > 1) violations.push({ rule: "one_effective_plan", actual: admitted.length });
	for (const prefix of admittedPrefixes) {
		for (const key of ["wall_time_ms", "model_requests", "tool_calls"]) {
			const allocation = prefix.reserved[key] + prefix.consumed[key];
			if (allocation > manifest.budget[key]) {
				violations.push({
					rule: "allocation_limit",
					key,
					allocation,
					limit: manifest.budget[key],
					offset: prefix.offset,
				});
			}
		}
	}
	assert.deepEqual(violations, [], "one planning run must not reserve independent batches against the same snapshot");
});

test("HA-04: foreign root goal reference cannot activate an otherwise legal plan", () => {
	const { summary, projection } = scenario("foreign_root_plan");
	assert.ok(
		projection.plans.some((p) => p.plan?.root_goal_ref === "foreign-root"),
		"candidate remains inspectable",
	);
	assert.deepEqual(
		{
			refused:
				projection.plans.some((p) => ["blocked", "rejected"].includes(p.status)) || projection.rejected.length > 0,
			dynamic_tasks: projection.tasks.filter((t) => t.is_dynamic).length,
			provider_calls: summary.provider_calls,
			broker_effects: summary.broker_effects,
		},
		{ refused: true, dynamic_tasks: 0, provider_calls: 2, broker_effects: 0 },
	);
});
