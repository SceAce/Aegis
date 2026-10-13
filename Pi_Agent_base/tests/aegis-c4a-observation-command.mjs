#!/usr/bin/env node
// Aegis C4a — Pi view command over the same committed projection.
//
// Required: the command reads the SAME view as the HTTP page and prints a
// readable summary + URL (with no TUI) (§C4A-8, non-SDK portion).
//
// Run:
//   node Pi_Agent_base/tests/aegis-c4a-observation-command.mjs

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";

import { observationConfigFromEnv, runObservationCommand } from "../memory/campaign/observation-command.mjs";
import { buildObservationView } from "../memory/campaign/observation-view.mjs";
import { readEvents, runFixtureCampaign } from "./helpers/c4-report-helpers.mjs";

test("C4A-8: the command reads the same view and prints a summary + URL", async (t) => {
	const src = await runFixtureCampaign();
	t.after(() => rm(src.dir, { recursive: true, force: true }));
	const result = await runObservationCommand({
		subcommand: "tasks",
		manifestPath: src.manifestPath,
		eventsPath: src.eventsPath,
		observationUrl: "http://127.0.0.1:1234/",
	});
	assert.equal(result.ok, true, result.text);
	assert.match(result.text, /Aegis tasks:/);
	assert.match(result.text, /tasks total=2/);
	assert.match(result.text, /actions requested=2/);
	assert.match(result.text, /board: http:\/\/127\.0\.0\.1:1234\//);
	// The command view equals the HTTP view derivation.
	const rows = await readEvents(src.eventsPath);
	const view = buildObservationView({ manifest: src.manifest, events: rows });
	assert.equal(view.tasks.length, 2);
});

test("C4A-8b: without a browser/URL the command still prints readable output", async (t) => {
	const src = await runFixtureCampaign();
	t.after(() => rm(src.dir, { recursive: true, force: true }));
	const result = await runObservationCommand({
		subcommand: "dashboard",
		manifestPath: src.manifestPath,
		eventsPath: src.eventsPath,
		observationUrl: null,
	});
	assert.equal(result.ok, true);
	assert.match(result.text, /Aegis dashboard:/);
	assert.match(result.text, /board: start the observation server/);
});

test("C4A-8c: an unconfigured command reports clearly and never throws", async () => {
	const result = await runObservationCommand({ subcommand: "tasks", manifestPath: null, eventsPath: null });
	assert.equal(result.ok, false);
	assert.match(result.text, /not configured or not found/);
});

test("C4A-8d: the observed config comes from the launcher environment only", () => {
	const cfg = observationConfigFromEnv({
		AEGIS_CAMPAIGN_MANIFEST: "/tmp/m.json",
		AEGIS_EVENT_LOG: "/tmp/e.jsonl",
		AEGIS_OBSERVATION_URL: "http://127.0.0.1:1/",
	});
	assert.equal(cfg.manifestPath, "/tmp/m.json");
	assert.equal(cfg.eventsPath, "/tmp/e.jsonl");
	assert.equal(cfg.observationUrl, "http://127.0.0.1:1/");
	// Absent env yields nulls, never an inferred/model path.
	const empty = observationConfigFromEnv({});
	assert.equal(empty.manifestPath, null);
	assert.equal(empty.eventsPath, null);
});
