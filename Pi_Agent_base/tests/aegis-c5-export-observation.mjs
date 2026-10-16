#!/usr/bin/env node
// Aegis C5 — export + observation same-source through the unified entry.
//
// Required C5-E1: `--export --observe` produce same-source read-only artifacts;
// the observation server reads the same committed stream; a UI failure is never
// an execution dependency.
//
// Run:
//   node Pi_Agent_base/tests/aegis-c5-export-observation.mjs

import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createObservationServer } from "../observation/observation-server.mjs";
import { generateCampaignArtifacts } from "../observation/report-export.mjs";
import { makeConfig, readEvents, runEntry } from "./helpers/c5-helpers.mjs";

test("C5-E1: export and observation agree with the committed stream and stay read-only", async (t) => {
	const ctx = await makeConfig({ observation: true });
	t.after(() => rm(ctx.dir, { recursive: true, force: true }));

	// Run with observation enabled and export enabled in one entry call.
	const result = await runEntry(ctx, { scenario: "run", observe: true, export: true });
	assert.equal(result.ok, true, JSON.stringify(result.reasons));
	assert.match(result.observation_url ?? "", /^http:\/\/127\.0\.0\.1:\d+\/$/);

	// The export artifacts exist and are same-source with the report derivation.
	const reportPath = join(ctx.dir, "run", "report", "campaign-report.json");
	const report = JSON.parse(await readFile(reportPath, "utf8"));
	const rows = await readEvents(ctx);
	const expected = generateCampaignArtifacts({ manifest: ctx.manifest, events: rows }).report;
	assert.deepEqual(
		report.tasks.map((x) => [x.task_id, x.status]).sort(),
		expected.tasks.map((x) => [x.task_id, x.status]).sort(),
		"the exported report tasks equal the committed derivation",
	);
	assert.equal(report.integrity.event_chain_ok, true);

	// The observation view over the same source agrees on task statuses.
	const server = createObservationServer({
		manifestPath: ctx.manifestPath,
		eventsPath: join(ctx.dir, "run", "events.jsonl"),
	});
	await server.listen();
	const view = await (await fetch(new URL("/api/view", server.url).href)).json();
	assert.deepEqual(
		view.tasks.map((x) => [x.task_id, x.status]).sort(),
		report.tasks.map((x) => [x.task_id, x.status]).sort(),
		"the observation view agrees with the export",
	);
	await server.close();
});

test("C5-E1b: a UI failure does not block the entry (observation is optional)", async (t) => {
	const ctx = await makeConfig();
	t.after(() => rm(ctx.dir, { recursive: true, force: true }));
	// Run WITHOUT observation: the loop still completes and, with --export, writes
	// artifacts. Also a server pointed at a bad source never throws.
	const result = await runEntry(ctx, { scenario: "run", export: true });
	assert.equal(result.ok, true);
	assert.equal(result.observation_url, null, "no observation when disabled");
	const badServer = createObservationServer({
		manifestPath: "/nonexistent/m.json",
		eventsPath: "/nonexistent/e.jsonl",
	});
	await badServer.listen();
	const res = await fetch(new URL("/api/view", badServer.url).href);
	assert.equal(res.status, 200);
	await badServer.close();
});
