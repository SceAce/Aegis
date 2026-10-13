#!/usr/bin/env node
// Bounded C4a review, actual loopback requests and committed EventLog sources.
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { runObservationCommand } from "../memory/campaign/observation-command.mjs";
import { createObservationServer } from "../memory/campaign/observation-server.mjs";
import { buildObservationView, OBSERVATION_LIMITS } from "../memory/campaign/observation-view.mjs";
import { EventLog } from "../memory/runtime/events.mjs";
import { runFixtureCampaign } from "./helpers/c4-report-helpers.mjs";

async function setup(t, options = {}) {
	const src = await runFixtureCampaign();
	const server = createObservationServer({ manifestPath: src.manifestPath, eventsPath: src.eventsPath, ...options });
	await server.listen();
	t.after(async () => {
		await server.close();
		await rm(src.dir, { recursive: true, force: true });
	});
	return { ...src, server };
}
async function append(src, payload, kind = "runtime", type = "runtime.note") {
	const log = new EventLog(src.eventsPath);
	assert.equal((await log.open()).ok, true);
	try {
		assert.equal(
			(
				await log.append({
					event_type: type,
					source: { kind, actor_id: "c4a-review", adapter: "test", version: "1" },
					payload,
				})
			).ok,
			true,
		);
	} finally {
		await log.close();
	}
}

test("CONTROL: page shows the actual Task lifecycle alongside evidence", async (t) => {
	const s = await setup(t);
	const html = await (await fetch(s.server.url)).text();
	assert.ok(/<td>task-001<\/td><td>success<\/td><td>completed<\/td>/.test(html));
});

test("C4A-X1: malformed trailing line yields no live success in HTTP or Pi command", async (t) => {
	const s = await setup(t);
	const original = await readFile(s.eventsPath, "utf8");
	await writeFile(s.eventsPath, `${original}{"partial":`);
	const v = await (await fetch(new URL("/api/view", s.server.url))).json();
	assert.equal(v.integrity.event_chain_ok, false);
	assert.equal(
		v.tasks.some((x) => x.status === "success"),
		false,
		"partial/unverified snapshot cannot be live success",
	);
	const command = await runObservationCommand({
		subcommand: "tasks",
		manifestPath: s.manifestPath,
		eventsPath: s.eventsPath,
	});
	assert.equal(command.ok, false);
	assert.equal(
		command.view.tasks.some((x) => x.status === "success"),
		false,
	);
});

test("C4A-X2: LLM completed action claim does not replace trusted action status", async (t) => {
	const s = await setup(t);
	await append(s, { action_id: "forged", action_ref: "fixture.state.set" }, "llm", "action.completed");
	const body = await (await fetch(new URL("/api/actions", s.server.url))).json();
	assert.equal(
		body.actions.items.some((x) => x.action_id === "forged"),
		false,
	);
	assert.equal(body.counts.executed, 2);
});

test("C4A-X3: actual formatted JSON and HTML stay under the same view byte cap", async (t) => {
	const cap = 700;
	const s = await setup(t, { limits: { ...OBSERVATION_LIMITS, max_view_bytes: cap } });
	for (const path of ["/", "/api/view", "/api/tasks"]) {
		const text = await (await fetch(new URL(path, s.server.url))).text();
		assert.ok(Buffer.byteLength(text) <= cap, `${path} bytes ${Buffer.byteLength(text)} exceed ${cap}`);
	}
});

test("C4A-X4: request page_size cannot override Host max_tasks", async (t) => {
	const s = await setup(t, { limits: { max_tasks: 1 } });
	const v = await (await fetch(new URL("/api/view?page_size=200", s.server.url))).json();
	assert.equal(v.tasks.length, 1);
	assert.equal(v.pagination.tasks.truncated, true);
});

test("C4A-X5: proposal blocked reason and parent linkage survive the observation view", async (t) => {
	const s = await setup(t);
	const campaign_id = s.manifest.campaign_id;
	await append(
		s,
		{
			kind: "campaign.proposal.submitted",
			campaign_id,
			proposal_id: "p-review",
			proposal_digest: "digest:p",
			proposal: { proposed_task_id: "task-dyn", parent_task_id: "task-001", reason: "follow-up" },
		},
		"llm",
	);
	await append(s, {
		kind: "campaign.proposal.blocked",
		campaign_id,
		proposal_id: "p-review",
		reason: "budget unavailable",
	});
	const v = await (await fetch(new URL("/api/queue", s.server.url))).json();
	const p = v.proposals.find((x) => x.id === "p-review");
	assert.equal(p.status, "blocked");
	assert.equal(p.parent_task_id, "task-001");
	assert.equal(p.reason, "budget unavailable");
});

test("C4A-X6: budget remaining subtracts outstanding reservations", async (t) => {
	const s = await setup(t);
	const v = buildObservationView({ manifest: s.manifest, events: [] });
	assert.equal(v.budget.remaining.tool_calls, 120, "200 limit minus two reservations of 40");
});

test("C4A-X7: observation listener refuses wildcard/non-loopback binding", () => {
	assert.throws(
		() => createObservationServer({ manifestPath: "unused", eventsPath: "unused", host: "0.0.0.0" }),
		/loopback/i,
	);
});
