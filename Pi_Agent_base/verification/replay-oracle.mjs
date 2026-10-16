#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FIXTURE = resolve(BASE_DIR, "..", "docs", "examples", "memory-teacher-trace.json");
const SCHEMA_VERSION = "1.0";
const REPLAY_VERSION = "0.1.0";

const HELP = `Replay a deterministic teacher trace and run its oracle.

Usage:
  ./replay-oracle.mjs [options]

Options:
  --fixture FILE             Teacher trace JSON (default: docs/examples/memory-teacher-trace.json)
  --output DIR               Output directory (default: runtime/experiments/<fixture>-<timestamp>)
  --repeat N                 Independent replay runs (default: 1)
  --allow-replay-only-active Allow active status for replay-only evidence
  --help                     Show this help

The runner never calls an LLM or network endpoint. It executes only the
allowlisted fixture operation and writes events.jsonl, episodes.json,
outcomes.json, experiences.json, and report.json below the output directory.
`;

function fail(message) {
	throw new Error(message);
}

function parsePositiveInteger(value, label) {
	if (!/^\d+$/.test(value)) fail(`${label} must be a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) fail(`${label} must be a positive integer`);
	return parsed;
}

function parseArgs(argv) {
	const options = { repeat: 1 };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") options.help = true;
		else if (argument === "--allow-replay-only-active") options.allowReplayOnlyActive = true;
		else if (argument === "--fixture" || argument === "--output" || argument === "--repeat") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) fail(`${argument} requires a value`);
			if (argument === "--fixture") options.fixture = value;
			if (argument === "--output") options.output = value;
			if (argument === "--repeat") options.repeat = parsePositiveInteger(value, "--repeat");
			index += 1;
		} else {
			fail(`Unknown option: ${argument}`);
		}
	}
	if (options.repeat > 100) fail("--repeat cannot exceed 100");
	return options;
}

function readJson(path) {
	if (!existsSync(path)) fail(`Fixture does not exist: ${path}`);
	try {
		return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
	} catch (error) {
		fail(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

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

function isoNow() {
	return new Date().toISOString();
}

function relativeOrAbsolute(path) {
	return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function validateFixture(fixture) {
	if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) fail("Fixture must be a JSON object");
	if (fixture.schema_version !== SCHEMA_VERSION) fail(`Fixture schema_version must be ${SCHEMA_VERSION}`);
	if (typeof fixture.fixture_id !== "string" || fixture.fixture_id.length === 0) fail("Fixture fixture_id is required");
	for (const field of ["events", "episodes", "outcomes", "experiences"]) {
		if (!Array.isArray(fixture[field])) fail(`Fixture ${field} must be an array`);
	}
}

function indexBy(items, key) {
	return new Map(items.map((item) => [item[key], item]));
}

function makeSource(actorId, kind, adapter = "aegis-replay") {
	return { actor_id: actorId, kind, adapter, version: REPLAY_VERSION };
}

function createEventWriter() {
	let previousDigest;
	const events = [];
	return {
		emit(eventType, episodeId, sequence, payload, source, extra = {}) {
			const event = {
				schema_version: SCHEMA_VERSION,
				event_id: randomUUID(),
				event_type: eventType,
				episode_id: episodeId,
				sequence,
				occurred_at: isoNow(),
				recorded_at: isoNow(),
				source,
				payload,
				correlation_id: episodeId,
				evidence_refs: extra.evidence_refs || [],
				...(extra.causation_id ? { causation_id: extra.causation_id } : {}),
				...(previousDigest ? { prev_event_digest: previousDigest } : {}),
			};
			event.event_digest = digest(event);
			previousDigest = event.event_digest;
			events.push(event);
			return event;
		},
		all() {
			return events;
		},
	};
}

function fixtureEpisode(fixture) {
	const episode = fixture.episodes.find((candidate) => candidate.source_kind === "teacher_replay");
	if (!episode) fail("Fixture must contain a teacher_replay episode");
	return episode;
}

function fixtureAction(fixture, episode) {
	const eventById = indexBy(fixture.events, "event_id");
	const actionEvent = episode.steps?.[0]?.action_event_id
		? eventById.get(episode.steps[0].action_event_id)
		: fixture.events.find((event) => event.episode_id === episode.episode_id && event.event_type === "action.requested");
	if (!actionEvent || actionEvent.event_type !== "action.requested") fail("Teacher episode has no action.requested event");
	return actionEvent;
}

function executeFixtureAction(action, state) {
	const payload = action.payload || {};
	if (payload.tool_name !== "fixture" || payload.operation !== "unlock" || payload.arguments?.target !== "door") {
		return { tool_ok: false, exit_code: 2, timed_out: false, failure_mode: "action_rejected" };
	}
	if (state.door.locked !== true) {
		return { tool_ok: false, exit_code: 3, timed_out: false, failure_mode: "precondition_unmet" };
	}
	state.door.locked = false;
	return { tool_ok: true, exit_code: 0, timed_out: false, duration_ms: 1 };
}

function oracleOutcome({ level, episodeId, stepId, criterion, observed, transport, evidenceRefs, independenceGroup }) {
	const success = observed?.["door.locked"] === false;
	const outcome = {
		schema_version: SCHEMA_VERSION,
		outcome_id: randomUUID(),
		level,
		episode_id: episodeId,
		...(stepId ? { step_id: stepId } : {}),
		status: success ? "success" : "unknown",
		criterion,
		observed: success ? observed : null,
		oracle: {
			oracle_id: "fixture-state-oracle",
			method: "deterministic_state_read",
			version: REPLAY_VERSION,
			independence_group: independenceGroup,
		},
		evidence_refs: evidenceRefs,
		transport,
		reproducibility: {
			replayable: success,
			replay_hash: success ? digest({ state: observed, criterion }) : null,
			replay_count: success ? 1 : 0,
			checked_at: isoNow(),
		},
		assessed_at: isoNow(),
	};
	if (!success) outcome.failure_mode = transport.tool_ok ? "postcondition_failed" : "insufficient_evidence";
	return outcome;
}

function replayOne({ fixture, sourceEpisode, sourceAction, runIndex, writer }) {
	const episodeId = `replay-${runIndex}-${randomUUID()}`;
	const stepId = `step-${runIndex}-${randomUUID()}`;
	const independenceGroup = `fixture-process-${runIndex}`;
	const sourceKind = "teacher_replay";
	const source = makeSource("replay-driver", "replay");
	const environment = { environment_fingerprint: "fixture-v1", domain: "fixture", permissions: ["fixture-only"] };
	const criterion = {
		criterion_id: sourceEpisode.goal.goal_id,
		description: sourceEpisode.goal.description,
		expected: { "door.locked": false },
	};
	const eventIds = [];
	const state = { door: { locked: true } };
	let sequence = 0;
	const started = writer.emit(
		"episode.started",
		episodeId,
		sequence++,
		{ source_kind: sourceKind, goal: sourceEpisode.goal, environment },
		source,
		{ evidence_refs: [{ ref_type: "event", ref_id: sourceEpisode.episode_id }] },
	);
	eventIds.push(started.event_id);
	const observation = writer.emit(
		"observation.captured",
		episodeId,
		sequence++,
		{ observation_kind: "state", path: "door.locked", value: state.door.locked, source: "fixture_environment" },
		makeSource("fixture-env", "environment", "fixture"),
	);
	eventIds.push(observation.event_id);
	const requested = writer.emit(
		"action.requested",
		episodeId,
		sequence++,
		{ action_id: `action-${runIndex}-${randomUUID()}`, tool_name: "fixture", operation: "unlock", arguments: { target: "door" } },
		source,
		{ evidence_refs: [{ ref_type: "event", ref_id: observation.event_id }] },
	);
	eventIds.push(requested.event_id);
	const transport = executeFixtureAction(sourceAction, state);
	const completed = writer.emit(
		"action.completed",
		episodeId,
		sequence++,
		{ action_id: requested.payload.action_id, tool_name: "fixture", ...transport },
		makeSource("fixture-env", "environment", "fixture"),
		{ causation_id: requested.event_id },
	);
	eventIds.push(completed.event_id);
	const observed = transport.tool_ok ? { "door.locked": state.door.locked } : null;
	const stepOutcome = oracleOutcome({
		level: "step",
		episodeId,
		stepId,
		criterion: { ...criterion, criterion_id: `${criterion.criterion_id}:step` },
		observed,
		transport,
		evidenceRefs: [{ ref_type: "event", ref_id: completed.event_id }],
		independenceGroup,
	});
	const stepOutcomeEvent = writer.emit(
		"outcome.recorded",
		episodeId,
		sequence++,
		{ outcome_id: stepOutcome.outcome_id, level: "step", status: stepOutcome.status },
		makeSource("fixture-state-oracle", "oracle", "fixture"),
		{ causation_id: completed.event_id, evidence_refs: [...stepOutcome.evidence_refs] },
	);
	eventIds.push(stepOutcomeEvent.event_id);
	const episodeOutcome = oracleOutcome({
		level: "episode",
		episodeId,
		criterion,
		observed,
		transport,
		evidenceRefs: [{ ref_type: "event", ref_id: stepOutcomeEvent.event_id }],
		independenceGroup,
	});
	const episodeOutcomeEvent = writer.emit(
		"outcome.recorded",
		episodeId,
		sequence++,
		{ outcome_id: episodeOutcome.outcome_id, level: "episode", status: episodeOutcome.status },
		makeSource("fixture-state-oracle", "oracle", "fixture"),
		{ causation_id: stepOutcomeEvent.event_id, evidence_refs: episodeOutcome.evidence_refs },
	);
	eventIds.push(episodeOutcomeEvent.event_id);
	const closed = writer.emit(
		"episode.closed",
		episodeId,
		sequence++,
		{ status: episodeOutcome.status === "success" ? "completed" : "aborted", episode_outcome_id: episodeOutcome.outcome_id },
		source,
		{ evidence_refs: [{ ref_type: "event", ref_id: episodeOutcomeEvent.event_id }] },
	);
	eventIds.push(closed.event_id);
	return {
		episode: {
			schema_version: SCHEMA_VERSION,
			episode_id: episodeId,
			status: episodeOutcome.status === "success" ? "completed" : "aborted",
			source_kind: sourceKind,
			goal: sourceEpisode.goal,
			authorization: { allowed_tools: ["fixture"], target: "door", side_effects: "fixture-only" },
			environment,
			started_at: started.occurred_at,
			ended_at: closed.occurred_at,
			event_ids: eventIds,
			steps: [{ step_id: stepId, index: 0, action_event_id: requested.event_id, observation_event_ids: [observation.event_id], step_outcome_id: stepOutcome.outcome_id }],
			episode_outcome_id: episodeOutcome.outcome_id,
			provenance: { source_refs: [`wp:${fixture.fixture_id}`, `episode:${sourceEpisode.episode_id}`], adapter: "fixture", adapter_version: REPLAY_VERSION },
			episode_digest: digest({ episodeId, eventIds, outcome: episodeOutcome.outcome_id }),
		},
		outcomes: [stepOutcome, episodeOutcome],
	};
}

function makeUnknownProjection({ fixture }) {
	const sourceUnknown = fixture.episodes.find((episode) => episode.source_kind === "counterfactual");
	const sourceOutcome = fixture.outcomes.find((outcome) => outcome.status === "unknown");
	if (!sourceUnknown || !sourceOutcome) return { episode: null, outcome: null };
	const episodeId = `unknown-${randomUUID()}`;
	const outcome = {
		...sourceOutcome,
		outcome_id: `unknown-${randomUUID()}`,
		episode_id: episodeId,
		oracle: { ...sourceOutcome.oracle, version: REPLAY_VERSION, independence_group: "fixture-missing-state" },
		assessed_at: isoNow(),
		provenance: { source_fixture: fixture.fixture_id, source_outcome_id: sourceOutcome.outcome_id },
	};
	const episode = {
		...sourceUnknown,
		episode_id: episodeId,
		ended_at: isoNow(),
		event_ids: [],
		episode_outcome_id: outcome.outcome_id,
		provenance: { ...sourceUnknown.provenance, source_fixture: fixture.fixture_id, source_episode_id: sourceUnknown.episode_id },
		episode_digest: digest({ episodeId, outcome: outcome.outcome_id }),
	};
	return { episode, outcome };
}

function compileExperience({ fixture, episodes, outcomes, allowReplayOnlyActive }) {
	const successful = outcomes.filter((outcome) => outcome.level === "episode" && outcome.status === "success");
	const unknown = outcomes.filter((outcome) => outcome.level === "episode" && outcome.status === "unknown");
	const independentGroups = new Set(successful.map((outcome) => outcome.oracle.independence_group));
	const gateReasons = [];
	if (independentGroups.size < 2) gateReasons.push("requires at least two independent successful episodes");
	if (!allowReplayOnlyActive) gateReasons.push("replay-only evidence is candidate-only by default");
	const firstSuccess = successful[0];
	const experience = {
		schema_version: SCHEMA_VERSION,
		experience_id: `experience-${fixture.fixture_id}-${randomUUID()}`,
		status: independentGroups.size >= 2 && allowReplayOnlyActive ? "active" : "candidate",
		when: [{ path: "door.locked", op: "eq", value: true, verified_by: firstSuccess ? [firstSuccess.outcome_id] : [] }],
		do: { tool: "fixture", operation: "unlock", arguments_template: { target: "door" }, risk_class: "low" },
		expect: [{ path: "door.locked", op: "eq", value: false }],
		scope: { environment_fingerprint: "fixture-v1", domain: "fixture", permissions: ["fixture-only"], task_types: ["reproduce"], mode: "replay-only" },
		support: {
			success_outcome_ids: successful.map((outcome) => outcome.outcome_id),
			failure_outcome_ids: [],
			unknown_outcome_ids: unknown.map((outcome) => outcome.outcome_id),
			independent_episode_count: independentGroups.size,
			success_count: successful.length,
			failure_count: 0,
			unknown_count: unknown.length,
		},
		provenance: {
			compiled_by: "aegis-replay-compiler",
			compiler_version: REPLAY_VERSION,
			source_outcome_ids: outcomes.map((outcome) => outcome.outcome_id),
			source_episode_ids: episodes.map((episode) => episode.episode_id),
			source_kind: ["teacher_replay", "counterfactual"],
			compiled_at: isoNow(),
		},
		validation: { last_validated_at: isoNow(), replay_hash: digest({ fixture: fixture.fixture_id, successful: successful.map((outcome) => outcome.outcome_id) }), conflicts: [] },
		revision: 1,
		created_at: isoNow(),
		updated_at: isoNow(),
	};
	return { experience, gateReasons };
}

function writeOutputs(output, writer, episodes, outcomes, experiences, report) {
	mkdirSync(output, { recursive: true });
	writeFileSync(join(output, "events.jsonl"), `${writer.all().map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
	writeFileSync(join(output, "episodes.json"), `${JSON.stringify(episodes, null, 2)}\n`, "utf8");
	writeFileSync(join(output, "outcomes.json"), `${JSON.stringify(outcomes, null, 2)}\n`, "utf8");
	writeFileSync(join(output, "experiences.json"), `${JSON.stringify(experiences, null, 2)}\n`, "utf8");
	writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(HELP);
		return;
	}
	const fixturePath = relativeOrAbsolute(options.fixture || DEFAULT_FIXTURE);
	const fixture = readJson(fixturePath);
	validateFixture(fixture);
	const sourceEpisode = fixtureEpisode(fixture);
	const sourceAction = fixtureAction(fixture, sourceEpisode);
	const output = relativeOrAbsolute(options.output || join(BASE_DIR, "runtime", "experiments", `${fixture.fixture_id}-${Date.now()}`));
	const writer = createEventWriter();
	const episodes = [];
	const outcomes = [];
	for (let runIndex = 1; runIndex <= options.repeat; runIndex += 1) {
		const replay = replayOne({ fixture, sourceEpisode, sourceAction, runIndex, writer });
		episodes.push(replay.episode);
		outcomes.push(...replay.outcomes);
	}
	const unknown = makeUnknownProjection({ fixture });
	if (unknown.episode && unknown.outcome) {
		const event = writer.emit(
			"outcome.recorded",
			unknown.episode.episode_id,
			0,
			{ outcome_id: unknown.outcome.outcome_id, level: "episode", status: "unknown", failure_mode: unknown.outcome.failure_mode },
			makeSource("fixture-state-oracle", "oracle", "fixture"),
			{ evidence_refs: unknown.outcome.evidence_refs },
		);
		unknown.episode.event_ids = [event.event_id];
		episodes.push(unknown.episode);
		outcomes.push(unknown.outcome);
	}
	const compiled = compileExperience({ fixture, episodes, outcomes, allowReplayOnlyActive: options.allowReplayOnlyActive });
	const report = {
		schema_version: SCHEMA_VERSION,
		replay_version: REPLAY_VERSION,
		fixture_id: fixture.fixture_id,
		fixture_path: fixturePath,
		output_dir: output,
		replay_count: options.repeat,
		counts: { events: writer.all().length, episodes: episodes.length, outcomes: outcomes.length, experiences: 1 },
		oracle: { id: "fixture-state-oracle", method: "deterministic_state_read" },
		experience_status: compiled.experience.status,
		gate: { status: compiled.experience.status, reasons: compiled.gateReasons, replay_only: true },
		warnings: ["Repeated runs use the same deterministic fixture; they do not establish live-environment transfer."],
	};
	writeOutputs(output, writer, episodes, outcomes, [compiled.experience], report);
	console.log(JSON.stringify({ output, counts: report.counts, experience_status: compiled.experience.status, gate_reasons: compiled.gateReasons }, null, 2));
}

try {
	main();
} catch (error) {
	console.error(`replay-oracle: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
