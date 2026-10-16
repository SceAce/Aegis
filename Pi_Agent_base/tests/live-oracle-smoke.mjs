#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const ORACLE = join(ROOT, "Pi_Agent_base", "verification", "live-oracle.mjs");

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

function makeEvents(episodeId, fixturePath) {
	let previousDigest;
	let sequence = 0;
	const events = [];
	const emit = (eventType, eventEpisodeId, payload, extra = {}) => {
		const event = {
			schema_version: "1.0",
			event_id: `${eventType}-${events.length + 1}`,
			event_type: eventType,
			episode_id: eventEpisodeId,
			sequence: eventEpisodeId ? sequence++ : null,
			occurred_at: "2026-09-28T00:00:00.000Z",
			recorded_at: "2026-09-28T00:00:00.000Z",
			source: { actor_id: "test", kind: "observer", adapter: "test", version: "1" },
			payload,
			correlation_id: eventEpisodeId || "session-test",
			evidence_refs: [],
			...(extra.causation_id ? { causation_id: extra.causation_id } : {}),
			...(previousDigest ? { prev_event_digest: previousDigest } : {}),
		};
		event.event_digest = digest(event);
		previousDigest = event.event_digest;
		events.push(event);
		return event;
	};
	emit("session.started", null, { reason: "startup", cwd: ROOT });
	const started = emit("episode.started", episodeId, { source_kind: "live", goal: { goal_id: "unlock_fixture", description: "Unlock the fixture door", success_criteria: ["locked == false"] } });
	const readBefore = emit("action.requested", episodeId, { action_id: "read-before", tool_name: "read", input: { keys: ["path"], path: fixturePath } });
	emit("action.completed", episodeId, { action_id: "read-before", tool_name: "read", transport: { tool_ok: true, content_chars: 44 } }, { causation_id: readBefore.event_id });
	const edit = emit("action.requested", episodeId, { action_id: "edit-door", tool_name: "edit", input: { keys: ["edits", "path"], path: fixturePath } });
	emit("action.completed", episodeId, { action_id: "edit-door", tool_name: "edit", transport: { tool_ok: true, content_chars: 10 } }, { causation_id: edit.event_id });
	const readAfter = emit("action.requested", episodeId, { action_id: "read-after", tool_name: "read", input: { keys: ["path"], path: fixturePath } });
	emit("action.completed", episodeId, { action_id: "read-after", tool_name: "read", transport: { tool_ok: true, content_chars: 45 } }, { causation_id: readAfter.event_id });
	emit("episode.closed", episodeId, { status_hint: "aborted", reason: "session_quit", outcome_pending: true });
	return { events, started };
}

function createExperiment(finalState) {
	const root = mkdtempSync(join(tmpdir(), "aegis-live-oracle-")).replaceAll("\\", "/");
	const experiment = join(root, "experiment");
	const fixtureDir = join(experiment, "fixture");
	const fixturePath = join(fixtureDir, "door.json");
	mkdirSync(fixtureDir, { recursive: true });
	writeFileSync(fixturePath, `${JSON.stringify(finalState)}\n`, "utf8");
	const { events } = makeEvents("episode-live-test", fixturePath);
	writeFileSync(join(experiment, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
	const manifest = {
		schema_version: "1.0",
		experiment_id: "live-oracle-smoke",
		source_kind: "live",
		goal: { goal_id: "unlock_fixture", description: "Unlock the fixture door", success_criteria: ["locked == false"] },
		authorization: { allowed_tools: ["read", "edit"], target: fixturePath, side_effects: "fixture-only" },
		environment: { environment_fingerprint: "live-fixture-v1", domain: "fixture", permissions: ["fixture-only"] },
		state: {
			format: "json",
			path: "fixture/door.json",
			initial_snapshot: { target: "door", locked: true, version: 1 },
			preconditions: [{ path: "locked", op: "eq", value: true }],
			postconditions: [
				{ path: "target", op: "eq", value: "door" },
				{ path: "locked", op: "eq", value: false },
				{ path: "version", op: "eq", value: 1 },
			],
		},
		action: { tool_names: ["edit"], target_path: "fixture/door.json", operation: "edit", risk_class: "low" },
		independence_group: "live-fixture-test",
	};
	writeFileSync(join(experiment, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return { root, experiment, fixturePath };
}

function run(experiment) {
	const output = join(experiment, "oracle-v1");
	execFileSync(process.execPath, [ORACLE, "--experiment", experiment, "--output", output], { cwd: ROOT, stdio: "pipe" });
	return {
		report: JSON.parse(readFileSync(join(output, "report.json"), "utf8")),
		episodes: JSON.parse(readFileSync(join(output, "episodes.json"), "utf8")),
		outcomes: JSON.parse(readFileSync(join(output, "outcomes.json"), "utf8")),
		experiences: JSON.parse(readFileSync(join(output, "experiences.json"), "utf8")),
		events: readFileSync(join(output, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse),
	};
}

const success = createExperiment({ target: "door", locked: false, version: 1 });
try {
	const result = run(success.experiment);
	if (result.report.outcome_status !== "success") throw new Error(`success fixture status: ${result.report.outcome_status}`);
	if (result.episodes[0].status !== "completed") throw new Error("success fixture episode was not completed");
	if (result.outcomes.some((outcome) => outcome.status !== "success")) throw new Error("success fixture produced a non-success outcome");
	if (result.experiences[0].status !== "candidate") throw new Error("live evidence must remain candidate");
	if (result.events.filter((event) => event.event_type === "outcome.recorded").length !== 2) throw new Error("missing outcome events");
	for (let index = 1; index < result.events.length; index += 1) {
		if (result.events[index].prev_event_digest !== result.events[index - 1].event_digest) throw new Error("projected event chain is broken");
	}
} finally {
	rmSync(success.root, { recursive: true, force: true });
}

const unknown = createExperiment({ target: "door", locked: true, version: 1 });
try {
	const result = run(unknown.experiment);
	if (result.report.outcome_status !== "failure") throw new Error(`postcondition fixture status: ${result.report.outcome_status}`);
	if (!result.outcomes.every((outcome) => outcome.status === "failure")) throw new Error("postcondition failure was not preserved");
} finally {
	rmSync(unknown.root, { recursive: true, force: true });
}

const missing = createExperiment({ target: "door", locked: false, version: 1 });
try {
	rmSync(missing.fixturePath);
	const result = run(missing.experiment);
	if (result.report.outcome_status !== "unknown") throw new Error(`missing state status: ${result.report.outcome_status}`);
	if (!result.outcomes.every((outcome) => outcome.status === "unknown")) throw new Error("missing state was not preserved as unknown");
} finally {
	rmSync(missing.root, { recursive: true, force: true });
}

console.log("live oracle smoke ok");
