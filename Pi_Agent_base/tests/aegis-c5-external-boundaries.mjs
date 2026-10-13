#!/usr/bin/env node
// C5 bounded product review, no real model/network/target.
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { createHostSessionController, parseArgs, runCampaignFromConfig } from "../memory/campaign/c5-entry.mjs";
import { loadCampaignConfig } from "../memory/campaign/campaign-config.mjs";
import { EventLog, hostEventLog } from "../memory/runtime/events.mjs";
import { makeConfig, readEvents, runEntry } from "./helpers/c5-helpers.mjs";

async function setup(t) {
	const c = await makeConfig();
	t.after(() => rm(c.dir, { recursive: true, force: true }));
	return c;
}
async function change(c, mutate) {
	const raw = JSON.parse(await readFile(c.configPath, "utf8"));
	mutate(raw);
	await writeFile(c.configPath, JSON.stringify(raw));
}

test("CONTROL: ordinary run still completes both tasks", async (t) => {
	const c = await setup(t);
	const r = await runEntry(c);
	assert.equal(r.ok, true);
	assert.deepEqual(Object.values(r.task_states), ["completed", "completed"]);
});
for (const command of ["export", "observe"]) {
	test(`C5-X1: ${command} cannot dispatch a fresh Campaign`, async (t) => {
		const c = await setup(t);
		const r = await runEntry(c, { scenario: command });
		if (command === "export") assert.equal(r.ok, false, "a fresh Campaign has no committed log to export");
		else assert.equal(r.ok, true);
		const events = await readEvents(c).catch((error) => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		assert.equal(events.filter((e) => e.event_type === "action.requested").length, 0);
	});
}

test("C5-X2: optional observation bind failure does not block execution or leak writer", async (t) => {
	const c = await setup(t);
	const occupied = createServer();
	await new Promise((r) => occupied.listen(0, "127.0.0.1", r));
	t.after(() => new Promise((r) => occupied.close(r)));
	await change(c, (raw) => {
		raw.observation = { enabled: true, host: "127.0.0.1", port: occupied.address().port };
	});
	const result = await runEntry(c);
	assert.equal(result.ok, true);
	assert.deepEqual(Object.values(result.task_states), ["completed", "completed"]);
});

test("C5-X3: nested config types and unknown Session keys fail closed", async (t) => {
	const c = await setup(t);
	for (const value of [
		null,
		[],
		"not-an-object",
		{ unknown_permission: true },
		{ session_count: -1 },
		{ session_count: 1.5 },
	]) {
		await change(c, (raw) => {
			raw.session = value;
		});
		assert.equal(loadCampaignConfig({ configPath: c.configPath }).ok, false, JSON.stringify(value));
	}
	await change(c, (raw) => {
		delete raw.session;
	});
	for (const [key, value] of [
		["observation", { host: 123 }],
		["oracle", { kind: 123 }],
		["session", { budget_ledger: { limit: { session_count: 1 }, extra_permission: true } }],
	]) {
		await change(c, (raw) => {
			raw[key] = value;
		});
		assert.equal(loadCampaignConfig({ configPath: c.configPath }).ok, false, `${key}: ${JSON.stringify(value)}`);
		await change(c, (raw) => {
			delete raw[key];
		});
	}
});

test("C5-X3: default Session ledger is bounded by configuration and Manifest", async (t) => {
	const c = await setup(t);
	const r = loadCampaignConfig({ configPath: c.configPath });
	assert.equal(r.ok, true);
	assert.ok(r.config.session.budget_ledger);
	assert.equal(r.config.session.budget_ledger.limit.session_count, 2);
	await change(c, (raw) => {
		raw.session.budget_ledger = { limit: { session_count: 10000 }, consumed: { session_count: 0 } };
	});
	assert.equal(loadCampaignConfig({ configPath: c.configPath }).ok, false);
});

test("C5-X5: Campaign Session budget includes rotations from older Episodes", async (t) => {
	const c = await setup(t);
	await runEntry(c);
	const loaded = loadCampaignConfig({ configPath: c.configPath });
	const config = loaded.config;
	config.session.budget_ledger = { limit: { session_count: 1 }, consumed: { session_count: 0 } };
	config.session.handoff_path = join(c.dir, "handoff.json");
	const log = new EventLog(join(c.dir, "run", "events.jsonl"));
	assert.equal((await log.open()).ok, true);
	for (const [type, episode, payload] of [
		["episode.started", "old-episode", { task_id: "old" }],
		["handoff.completed", "old-episode", { request_id: "old-request", to_session: "old-session" }],
		["episode.started", "new-episode", { task_id: "new", goal: { description: "new" } }],
	])
		assert.equal(
			(await log.append({ event_type: type, episode_id: episode, source: { kind: "runtime" }, payload })).ok,
			true,
		);
	await log.close();
	await writeFile(
		config.session.handoff_path,
		JSON.stringify({ episode_id: "new-episode", task_id: "new", request_id: "new-request", reason: "test" }),
	);
	let calls = 0;
	const ctl = createHostSessionController({
		config,
		runtime: {
			async newSession() {
				calls += 1;
				return { cancelled: false };
			},
		},
	});
	const r = await ctl.rotate();
	assert.equal(r.applied, false);
	assert.match(r.reason, /budget/);
	assert.equal(calls, 0);
});

test("C5-X2: preparation errors release borrowed writer ownership", async (t) => {
	const c = await setup(t);
	const r = await runEntry(c, {
		beforeRun() {
			throw new Error("setup failed");
		},
	});
	assert.equal(r.ok, false);
	assert.equal(hostEventLog(join(c.dir, "run", "events.jsonl")), null);
	assert.equal((await runEntry(c)).ok, true);
});

test("C5-X6: CLI rejects missing values and malformed observation ports", () => {
	for (const flag of ["--config", "--out", "--port"]) {
		assert.equal(parseArgs(["--config", "config.json", "run", flag]).ok, false);
	}
	for (const value of ["abc", "-1", "65536", "10junk", "1.5"]) {
		assert.equal(parseArgs(["--config", "config.json", "run", "--port", value]).ok, false);
	}
	assert.equal(parseArgs(["--config", "config.json", "run", "--port", "0"]).args.port, 0);
});

test("C5-X4: status refuses a corrupt stream rather than reporting completion", async (t) => {
	const c = await setup(t);
	await runEntry(c);
	const path = join(c.dir, "run", "events.jsonl");
	const rows = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
	rows[2].payload.tampered = true;
	await writeFile(path, `${rows.map((x) => JSON.stringify(x)).join("\n")}\n`);
	const r = await runCampaignFromConfig({ configPath: c.configPath, scenario: "status", print: () => {} });
	assert.equal(r.ok, false);
	assert.equal(Object.values(r.task_states ?? {}).includes("completed"), false);
});
