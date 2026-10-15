#!/usr/bin/env node
// Independent E1-CC-1.0 review of the uncommitted single-authority implementation.
// Expected values come from the frozen contract, not from the implementation.
// Failing assertions deliberately preserve reachable boundary regressions.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { inspectExecutionPermit } from "../memory/campaign/authority.mjs";
import { createBrokerWorker } from "../memory/campaign/broker-worker.mjs";
import { createCompositeWorker, runC6FromConfig } from "../memory/campaign/c6-entry.mjs";
import { createDecisionCaptureTool } from "../memory/campaign/c6-model-worker.mjs";
import { summarizeRequestLedger } from "../memory/campaign/c6-request-lifecycle.mjs";
import { createCampaignScheduler } from "../memory/campaign/scheduler.mjs";
import { digest } from "../memory/fixture/contracts.mjs";
import { projectBoard } from "../memory/runtime/board.mjs";
import { eventDigest, verifyChain } from "../memory/runtime/events.mjs";
import { evidenceDir, project, runPlanningScenario } from "./helpers/e1-closure-helpers.mjs";

const out = evidenceDir("single-authority-boundaries");
console.log(`Independent single-authority evidence: ${out}`);
const normal = runPlanningScenario({ workDir: out, scenario: "normal_plan" });
assert.equal(normal.exit, 0, normal.stderr.slice(-600));
assert.equal(verifyChain(normal.events).ok, true);
const manifest = normal.manifest;
const plan = normal.events.find((e) => e.payload?.kind === "campaign.plan.submitted").payload.plan;

function rechain(events) {
	let previous;
	const sequences = new Map();
	for (const e of events) {
		e.sequence = e.episode_id ? (sequences.get(e.episode_id) ?? 0) : null;
		if (e.episode_id) sequences.set(e.episode_id, e.sequence + 1);
		if (previous === undefined) delete e.prev_event_digest;
		else e.prev_event_digest = previous;
		e.event_digest = eventDigest(e);
		previous = e.event_digest;
	}
	const verified = verifyChain(events);
	assert.equal(verified.ok, true, verified.errors.join("; "));
	return events;
}
function hostOver(input) {
	const events = structuredClone(input);
	const at = Math.max(...events.map((e) => Date.parse(e.recorded_at)).filter(Number.isFinite));
	const sink = {
		events,
		async append(event) {
			const row = {
				schema_version: "1.1",
				...event,
				event_id: `sa-${events.length}`,
				recorded_at: new Date(at).toISOString(),
			};
			events.push(row);
			rechain(events);
			return { ok: true, durable: true, event: row };
		},
	};
	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks: manifest.tasks,
		sink,
		acquireOwnership: false,
		clock: () => at,
		worker: { run: async () => ({ ok: false }) },
		oracle: { judge: async () => ({ status: "unknown" }) },
	});
	return { events, scheduler };
}
function requestPrefix(taskId = "dyn-a") {
	const index = normal.events.findIndex(
		(e) => e.payload?.kind === "c6.request" && e.payload.task_id === taskId && e.payload.phase === "committed",
	);
	assert.ok(index >= 0);
	return structuredClone(normal.events.slice(0, index + 1));
}
function readyPrefix() {
	const index = normal.events.findIndex(
		(e) => e.payload?.kind === "campaign.task.completed" && e.payload.task_id === "dyn-b",
	);
	return structuredClone(normal.events.slice(0, index + 1));
}
function stageOutcome(taskId = "dyn-a") {
	return structuredClone(
		normal.events.find(
			(e) => e.payload?.kind === "campaign.oracle.result" && e.payload.task_id === taskId && !e.payload.task_oracle,
		),
	);
}
function environmentChange(rows, taskId) {
	return {
		event_type: "environment.changed",
		schema_version: "1.1",
		event_id: `sa-env-${taskId}`,
		episode_id: `ep-${taskId}`,
		source: { kind: "oracle", actor_id: "independent-audit" },
		recorded_at: rows.at(-1).recorded_at,
		payload: { scope: project(rows, manifest).tasks.find((t) => t.task_id === taskId).definition.scope },
		evidence_refs: [],
	};
}

test("SA-00: real SDK/faux control is 8 requests / 3 effects with no unresolved request", () => {
	assert.equal(normal.summary.provider_calls, 8);
	assert.equal(normal.summary.broker_effects, 3);
	assert.equal(summarizeRequestLedger(normal.events).unresolved, 0);
	assert.equal(project(normal.events, manifest).rejected.length, 0);
});

test("SA-01: a partial joint commit cannot authorize an actual Host tool charge", async () => {
	const control = hostOver(requestPrefix());
	const args = {
		request_id: control.events.at(-1).payload.request_id,
		tool_call_id: "sa-partial-commit",
		unit_id: "call",
		tool_name: "aegis_read",
		arguments_digest: digest({ path: "dataset.json" }),
	};
	const valid = await control.scheduler.chargeTool(args);
	assert.equal(valid.ok, true, `control: legal settled request authorizes a charge: ${JSON.stringify(valid)}`);
	const rows = requestPrefix();
	rows.at(-1).payload.commit_status = { task: "committed", campaign: "failed" };
	const { events, scheduler } = hostOver(rechain(rows));
	assert.equal(summarizeRequestLedger(events).unresolved, 1, "control: original C6 settlement stays held");
	const result = await scheduler.chargeTool(args);
	writeFileSync(
		join(out, "partial-commit.json"),
		JSON.stringify({ result, authority: project(events, manifest).authority.requests }),
	);
	assert.equal(result.ok, false, "an unresolved request must not provide a tool execution permit");
});

test("SA-02: replay and the entry's ledger rebuild accept exactly the same tool charges", () => {
	const rows = requestPrefix();
	const charged = structuredClone(
		normal.events.find(
			(e) => e.payload?.kind === "c6.tool" && e.payload.task_id === "dyn-a" && e.payload.phase === "charged",
		),
	);
	charged.event_id = "sa-foreign-tool-context";
	charged.payload.context_digest = digest({ foreign: true });
	rows.push(charged);
	rechain(rows);
	const p = project(rows, manifest);
	assert.ok(
		p.rejected.some((r) => r.event_id === charged.event_id),
		"control: authority rejects the foreign charge",
	);
	assert.equal(
		summarizeRequestLedger(rows).consumed.tool_calls,
		p.tool_charges.length,
		"entry/status rebuild must consume authority's charges, not interpret raw c6.tool independently",
	);
});

test("SA-03: an untrusted c6.tool row cannot erase established legacy tool consumption", () => {
	const rows = requestPrefix("task-plan");
	for (const row of rows) {
		if (row.payload?.kind === "c6.request") {
			delete row.payload.tool_accounting;
			row.payload.tool_calls = 3;
		}
	}
	const before = summarizeRequestLedger(rows);
	assert.equal(before.consumed.tool_calls, 3);
	rows.push({
		event_type: "runtime.note",
		source: { kind: "llm", actor_id: "untrusted" },
		payload: { kind: "c6.tool" },
	});
	const after = summarizeRequestLedger(rows);
	assert.equal(after.consumed.tool_calls, 3, "protocol selection must not be inferred from an arbitrary row");
});

test("SA-04: a finished duplicate decision never re-enters the actual decision buffer", async () => {
	const { events, scheduler } = hostOver(requestPrefix());
	const requestId = events.at(-1).payload.request_id;
	const actions = [];
	const Type = new Proxy({}, { get: () => () => ({}) });
	const tool = createDecisionCaptureTool({
		sdk: { Type, defineTool: (definition) => definition },
		buffer: { push: (action) => actions.push(action) },
		chargeUnit: (unit) => scheduler.chargeTool({ ...unit, request_id: requestId }),
		finishUnit: (unit) => scheduler.finishTool({ ...unit, request_id: requestId }),
	});
	const params = {
		actions: [{ action_ref: "data.record.set", arguments: { target: "dataset.json", field: "name", value: "Ada" } }],
	};
	await tool.execute("sa-repeat-tool", params);
	assert.equal(actions.length, 1, "control: original charged call enters the buffer once");
	await tool.execute("sa-repeat-tool", params);
	const charges = project(events, manifest).tool_charges.filter((r) => r.tool_call_id === "sa-repeat-tool");
	assert.equal(charges.length, 1, "control: charging is idempotent");
	assert.equal(charges[0].finished, true);
	assert.equal(actions.length, 1, "§7.2: no additional execution or buffered action on a duplicate charge");
});

test("SA-05: completed planning still returns the original exact admission on retry", async () => {
	const { events, scheduler } = hostOver(normal.events);
	const before = events.length;
	const result = await scheduler.admitPlan({ plan, planningTaskId: "task-plan" });
	assert.equal(result.ok, true, JSON.stringify(result.reasons));
	assert.equal(result.status, "duplicate");
	assert.equal(
		result.transition_event_id,
		normal.events.find((e) => e.payload?.kind === "campaign.plan.admitted").event_id,
	);
	assert.equal(events.length, before, "retry must not create a new transition");
});

test("SA-06: unsuperseded contradictory judgments withdraw dependant readiness", () => {
	const rows = readyPrefix();
	assert.equal(project(rows, manifest).tasks.find((t) => t.task_id === "dyn-c").state, "ready");
	const failure = stageOutcome();
	failure.event_id = "sa-independent-failure";
	failure.payload.outcome_id = failure.payload.outcome.outcome_id = "sa-independent-failure-outcome";
	failure.payload.status = failure.payload.outcome.status = "failure";
	failure.payload.outcome.observed = { name: "wrong" };
	failure.payload.outcome.failure_mode = "criterion_not_met";
	rows.push(failure);
	const p = project(rechain(rows), manifest);
	const accepted = p.authority.outcome_records.find((r) => r.event_id === failure.event_id);
	assert.equal(accepted.accepted, true, "control: a legitimate conflicting judgment is accepted for diagnostics");
	writeFileSync(
		join(out, "conflict.json"),
		JSON.stringify({
			record: accepted,
			task: p.tasks.find((t) => t.task_id === "dyn-a"),
			dependant: p.tasks.find((t) => t.task_id === "dyn-c"),
			facts: projectBoard(rows, { manifest }).currentByType.Fact.map((n) => n.outcome_id),
		}),
	);
	assert.equal(
		p.tasks.find((t) => t.task_id === "dyn-c").state,
		"queued",
		"a current success/failure conflict must not satisfy a dependency",
	);
});

async function brokerBoundary(invalidateAt) {
	const rows = normal.events.slice(
		0,
		normal.events.findIndex((e) => e.payload?.kind === "campaign.task.started" && e.payload.task_id === "dyn-c") + 1,
	);
	const prefix = structuredClone(rows);
	let now = Date.parse(prefix.at(-1).recorded_at);
	const task = project(prefix, manifest).tasks.find((t) => t.task_id === "dyn-c").definition;
	let effects = 0;
	let checks = 0;
	let latest;
	const permit = () => {
		checks += 1;
		latest = inspectExecutionPermit({
			projection: project(prefix, manifest),
			taskId: "dyn-c",
			now,
			operation: "broker_effect",
		});
		return latest;
	};
	assert.equal(permit().ok, true, "control: the running dependant initially has a valid permit");
	checks = 0;
	const sink = {
		async append(event) {
			prefix.push({
				schema_version: "1.1",
				...event,
				event_id: `sa-broker-${prefix.length}`,
				recorded_at: new Date(now).toISOString(),
			});
			if (event.event_type === "action.requested" && invalidateAt === "intent") {
				now = project(prefix, manifest).authority.deadlines.byTask["dyn-c"].task;
			} else if (event.event_type === "action.completed" && invalidateAt === "between" && effects === 1) {
				prefix.push({
					event_type: "environment.changed",
					event_id: "sa-broker-invalidation",
					episode_id: "ep-dyn-a",
					schema_version: "1.1",
					source: { kind: "oracle", actor_id: "independent-audit" },
					payload: { scope: project(prefix, manifest).tasks.find((t) => t.task_id === "dyn-a").definition.scope },
					recorded_at: new Date(now).toISOString(),
					evidence_refs: [],
				});
			}
			rechain(prefix);
			return { ok: true, durable: true, event: prefix.at(-1) };
		},
	};
	const broker = {
		registry: { get: () => ({ version: 1, parameters: {}, scope: { permissions: ["data.record.write"] } }) },
		async invoke() {
			effects += 1;
			return { ok: true, status: "success", result: {} };
		},
	};
	const steps = [0, 1].map((i) => ({
		step_id: `sa-step-${i}`,
		stage_id: null,
		action_ref: "data.record.set",
		arguments: { target: "dataset.json", field: "name", value: "Ada" },
		criterion_id: "data.name == Ada",
	}));
	const worker = createBrokerWorker({
		broker,
		authorization: manifest.authorization,
		plan: { task_id: task.task_id, steps },
		sink,
		workspaceRoot: manifest.authorization.workspace_root,
		artifactIndex: new Map(),
	});
	const composite = createCompositeWorker({
		modelWorker: { run: async () => ({ ok: true }) },
		brokerWorker: worker,
		buffer: { setTask() {} },
		permitEffect: permit,
	});
	composite.bindCampaign(manifest);
	const result = await composite.run({ task });
	const finalPermit = permit();
	writeFileSync(join(out, `broker-${invalidateAt}.json`), JSON.stringify({ result, effects, checks, finalPermit }));
	return { result, effects, finalPermit };
}

test("SA-07: real BrokerWorker rechecks time after its awaited durable intent", async () => {
	const control = await brokerBoundary("none");
	assert.equal(control.result.ok, true, JSON.stringify(control.result));
	assert.equal(control.effects, 2, "control: both legitimate broker actions execute");
	const result = await brokerBoundary("intent");
	assert.equal(result.finalPermit.ok, false, "control: authority refuses the expired task");
	assert.equal(result.effects, 0, "§5.3: no effect may run using the permit from before intent fsync");
});

test("SA-08: real BrokerWorker rechecks dependency validity between two actions", async () => {
	const control = await brokerBoundary("none");
	assert.equal(control.effects, 2, "control: both legitimate broker actions execute");
	const result = await brokerBoundary("between");
	assert.ok(result.finalPermit.reasons.some((r) => r.code === "dependency_invalidated"));
	assert.equal(result.effects, 1, "§8.1: the second action must stop after the dependency is invalidated");
});

test("SA-09: status can display the frozen run after the editable source Manifest changes", async () => {
	const configPath = join(normal.dir, "config.json");
	const manifestPath = join(normal.dir, "manifest.json");
	const original = readFileSync(manifestPath, "utf8");
	const changed = JSON.parse(original);
	changed.budget.model_requests += 1;
	writeFileSync(manifestPath, JSON.stringify(changed));
	try {
		const before = readFileSync(join(normal.dir, "events.jsonl"), "utf8");
		const status = await runC6FromConfig({ configPath, scenario: "status", sdk: {}, print() {} });
		assert.equal(readFileSync(join(normal.dir, "events.jsonl"), "utf8"), before, "status remains read-only");
		assert.equal(status.ok, true, `§4.2 frozen read-only view unavailable: ${JSON.stringify(status.reasons)}`);
	} finally {
		writeFileSync(manifestPath, original);
	}
});

test("SA-10: completion must use effective judgments after environment invalidation", () => {
	const index = normal.events.findIndex(
		(e) => e.payload?.kind === "campaign.task.completed" && e.payload.task_id === "dyn-a",
	);
	const rows = structuredClone(normal.events.slice(0, index));
	assert.equal(project(rows, manifest).tasks.find((t) => t.task_id === "dyn-a").task_outcome_status, "success");
	rows.push(environmentChange(rows, "dyn-a"));
	const invalidated = project(rechain(rows), manifest);
	assert.equal(invalidated.authority.effective_judgments.filter((r) => r.task_id === "dyn-a").length, 0);
	const completion = structuredClone(normal.events[index]);
	rows.push(completion);
	const p = project(rechain(rows), manifest);
	writeFileSync(
		join(out, "stale-completion.json"),
		JSON.stringify({ rejected: p.rejected, task: p.tasks.find((t) => t.task_id === "dyn-a") }),
	);
	assert.ok(
		p.rejected.some((r) => r.event_id === completion.event_id),
		"a historical success array cannot authorize a new completion",
	);
});

test("SA-11: invalidated planning success cannot release the admitted children", () => {
	const index = normal.events.findIndex((e) => e.payload?.kind === "campaign.plan.ready");
	const rows = structuredClone(normal.events.slice(0, index));
	assert.ok(
		project(rows, manifest)
			.tasks.filter((t) => t.task_id.startsWith("dyn-"))
			.every((t) => t.awaiting_plan_ready),
	);
	rows.push(environmentChange(rows, "task-plan"));
	const invalidated = project(rechain(rows), manifest);
	assert.equal(invalidated.tasks.find((t) => t.task_id === "task-plan").effective_status, "invalidated");
	rows.push(structuredClone(normal.events[index]));
	const p = project(rechain(rows), manifest);
	writeFileSync(join(out, "stale-planning.json"), JSON.stringify({ rejected: p.rejected, tasks: p.tasks }));
	assert.ok(
		p.tasks.filter((t) => t.task_id.startsWith("dyn-")).every((t) => t.awaiting_plan_ready && t.state === "queued"),
		"§8.1: plan activation must read the same effective judgments as dependencies",
	);
});

test("SA-12: editing config cannot downgrade a frozen durable-tool run to legacy execution", async () => {
	const { fauxAssistantMessage, fauxToolCall, registerFauxProvider } = await import("@earendil-works/pi-ai/compat");
	const configPath = join(normal.dir, "config.json");
	const eventsPath = join(normal.dir, "events.jsonl");
	const originalConfig = readFileSync(configPath, "utf8");
	const originalEvents = readFileSync(eventsPath, "utf8");
	const disabled = JSON.parse(originalConfig);
	disabled.planning.enabled = false;
	const index = normal.events.findIndex((e) => e.payload?.kind === "campaign.plan.ready");
	const prefix = normal.events.slice(0, index + 1);
	assert.equal(project(prefix, manifest).tasks.find((t) => t.task_id === "dyn-a").state, "ready");
	writeFileSync(configPath, JSON.stringify(disabled));
	writeFileSync(eventsPath, `${prefix.map((e) => JSON.stringify(e)).join("\n")}\n`);
	let calls = 0;
	try {
		const result = await runC6FromConfig({
			configPath,
			scenario: "run",
			print() {},
			fauxProviderFactory(options) {
				const faux = registerFauxProvider(options);
				faux.setResponses(
					Array.from({ length: 16 }, (_, i) => () => {
						calls += 1;
						return i % 2 === 0
							? fauxAssistantMessage([fauxToolCall("aegis_read", { path: "dataset.json" })])
							: fauxAssistantMessage("read complete");
					}),
				);
				return faux;
			},
		});
		const after = readFileSync(eventsPath, "utf8").trim().split("\n").map(JSON.parse);
		const appended = after.slice(prefix.length);
		assert.equal(verifyChain(after).ok, true);
		writeFileSync(join(out, "disabled-planning.json"), JSON.stringify({ result, calls, appended }));
		assert.equal(calls, 0, "a frozen E1 run cannot switch its execution/accounting protocol through editable config");
		assert.match(result.reasons.join("; "), /planning_context_conflict/);
	} finally {
		writeFileSync(configPath, originalConfig);
		writeFileSync(eventsPath, originalEvents);
	}
});
