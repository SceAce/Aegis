#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const baseDir = dirname(testsDir);
const script = join(baseDir, "verification", "replay-oracle.mjs");
const fixture = join(baseDir, "..", "docs", "examples", "memory-teacher-trace.json");

function stable(value) {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function digest(value) {
	return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
}

function run(args) {
	const output = mkdtempSync(join(tmpdir(), "aegis-replay-smoke-"));
	try {
		const result = spawnSync(process.execPath, [script, "--fixture", fixture, "--output", output, ...args], {
			encoding: "utf8",
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
		const episodes = JSON.parse(readFileSync(join(output, "episodes.json"), "utf8"));
		const outcomes = JSON.parse(readFileSync(join(output, "outcomes.json"), "utf8"));
		const experiences = JSON.parse(readFileSync(join(output, "experiences.json"), "utf8"));
		const events = readFileSync(join(output, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
		return { report, episodes, outcomes, experiences, events };
	} finally {
		rmSync(output, { recursive: true, force: true });
	}
}

const one = run(["--repeat", "1"]);
assert.equal(one.report.experience_status, "candidate");
assert.equal(one.report.counts.episodes, 2);
assert.equal(one.report.counts.outcomes, 3);
assert.equal(one.outcomes.filter((outcome) => outcome.status === "success").length, 2);
assert.equal(one.outcomes.filter((outcome) => outcome.status === "unknown").length, 1);
assert.equal(one.experiences[0].status, "candidate");
assert.equal(one.experiences[0].support.independent_episode_count, 1);
assert.equal(one.events.filter((event) => event.event_type === "action.requested").length, 1);
	assert.equal(one.events.filter((event) => event.event_type === "action.completed").length, 1);
	assert.equal(one.events.filter((event) => event.event_type === "outcome.recorded").length, 3);
	for (const event of one.events) {
		const withoutDigest = { ...event };
		delete withoutDigest.event_digest;
		assert.equal(digest(withoutDigest), event.event_digest);
		assert.equal(
			(event.evidence_refs || []).find((ref) => ref.ref_id === event.event_id),
			undefined,
			"an event must not cite itself as evidence",
		);
	}
	const actionCompleted = one.events.find((event) => event.event_type === "action.completed");
	const actionRequested = one.events.find((event) => event.event_type === "action.requested");
	assert.equal(actionCompleted.causation_id, actionRequested.event_id);
	assert.equal(actionCompleted.payload.action_id, actionRequested.payload.action_id);

const two = run(["--repeat", "2"]);
assert.equal(two.report.experience_status, "candidate");
assert.equal(two.experiences[0].support.independent_episode_count, 2);
assert.match(two.report.gate.reasons.join(" "), /replay-only/);

const replayOnlyActive = run(["--repeat", "2", "--allow-replay-only-active"]);
assert.equal(replayOnlyActive.report.experience_status, "active");
assert.equal(replayOnlyActive.experiences[0].scope.mode, "replay-only");

console.log("replay oracle smoke ok");
