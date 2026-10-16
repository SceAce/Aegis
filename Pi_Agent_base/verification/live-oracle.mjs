#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_VERSION = "1.0";
const ORACLE_VERSION = "0.1.0";

const HELP = `Project a live Pi episode through an independent deterministic JSON oracle.

Usage:
  ./live-oracle.mjs --experiment DIR [--output DIR]

Required experiment files:
  DIR/manifest.json
  DIR/events.jsonl

The manifest declares the fixture, preconditions, postconditions, and allowed
mutation tools. The oracle reads the fixture directly and never trusts the
agent's final message as a task result.
`;

function fail(message) {
	throw new Error(message);
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

function resolvePath(path) {
	return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function readJson(path) {
	if (!existsSync(path)) fail(`File does not exist: ${path}`);
	try {
		return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
	} catch (error) {
		fail(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function readJsonl(path) {
	if (!existsSync(path)) fail(`Event log does not exist: ${path}`);
	const rows = [];
	for (const [index, line] of readFileSync(path, "utf8").split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line));
		} catch (error) {
			fail(`Cannot parse ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return rows;
}

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") options.help = true;
		else if (argument === "--experiment" || argument === "--output") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) fail(`${argument} requires a value`);
			options[argument.slice(2)] = value;
			index += 1;
		} else fail(`Unknown option: ${argument}`);
	}
	if (!options.help && !options.experiment) fail("--experiment is required");
	return options;
}

function assertObject(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

function assertArray(value, label) {
	if (!Array.isArray(value)) fail(`${label} must be an array`);
}

function validateManifest(manifest, experimentDir) {
	assertObject(manifest, "manifest");
	if (manifest.schema_version !== SCHEMA_VERSION) fail(`manifest schema_version must be ${SCHEMA_VERSION}`);
	if (typeof manifest.experiment_id !== "string" || !manifest.experiment_id) fail("manifest experiment_id is required");
	if (manifest.source_kind !== "live") fail("manifest source_kind must be live");
	assertObject(manifest.goal, "manifest goal");
	if (typeof manifest.goal.goal_id !== "string" || !manifest.goal.goal_id) fail("manifest goal.goal_id is required");
	if (typeof manifest.goal.description !== "string" || !manifest.goal.description) fail("manifest goal.description is required");
	assertArray(manifest.goal.success_criteria, "manifest goal.success_criteria");
	assertObject(manifest.authorization, "manifest authorization");
	assertArray(manifest.authorization.allowed_tools, "manifest authorization.allowed_tools");
	assertObject(manifest.environment, "manifest environment");
	assertObject(manifest.state, "manifest state");
	if (manifest.state.format !== "json") fail("manifest state.format must be json");
	if (typeof manifest.state.path !== "string" || !manifest.state.path) fail("manifest state.path is required");
	const statePath = isAbsolute(manifest.state.path) ? manifest.state.path : resolve(experimentDir, manifest.state.path);
	const relativeState = relative(experimentDir, statePath);
	if (relativeState.startsWith("..") || isAbsolute(relativeState)) {
		fail("manifest state.path must remain inside the experiment directory");
	}
	assertObject(manifest.state.initial_snapshot, "manifest state.initial_snapshot");
	assertArray(manifest.state.preconditions, "manifest state.preconditions");
	assertArray(manifest.state.postconditions, "manifest state.postconditions");
	for (const predicate of [...manifest.state.preconditions, ...manifest.state.postconditions]) validatePredicate(predicate);
	assertObject(manifest.action, "manifest action");
	assertArray(manifest.action.tool_names, "manifest action.tool_names");
	if (typeof manifest.action.target_path !== "string" || !manifest.action.target_path) fail("manifest action.target_path is required");
	const targetPath = isAbsolute(manifest.action.target_path)
		? manifest.action.target_path
		: resolve(experimentDir, manifest.action.target_path);
	return { ...manifest, state: { ...manifest.state, path: statePath }, action: { ...manifest.action, target_path: targetPath } };
}

function validatePredicate(predicate) {
	assertObject(predicate, "predicate");
	if (typeof predicate.path !== "string" || !predicate.path) fail("predicate.path is required");
	if (!["eq", "neq", "exists"].includes(predicate.op)) fail(`unsupported predicate op: ${predicate.op}`);
	if (predicate.op !== "exists" && !Object.hasOwn(predicate, "value")) fail(`predicate.value is required for ${predicate.path}`);
}

function validateEvent(event, index, previous) {
	assertObject(event, `event ${index}`);
	if (event.schema_version !== SCHEMA_VERSION) fail(`event ${index} has unsupported schema_version`);
	if (typeof event.event_id !== "string" || !event.event_id) fail(`event ${index} has no event_id`);
	if (typeof event.event_type !== "string" || !event.event_type) fail(`event ${index} has no event_type`);
	if (!Object.hasOwn(event, "episode_id")) fail(`event ${index} has no episode_id`);
	if (!Object.hasOwn(event, "event_digest")) fail(`event ${index} has no event_digest`);
	if (previous && event.prev_event_digest !== previous.event_digest) {
		fail(`event ${index} has a broken prev_event_digest link`);
	}
	const withoutDigest = { ...event };
	delete withoutDigest.event_digest;
	if (digest(withoutDigest) !== event.event_digest) fail(`event ${index} has an invalid event_digest`);
}

function validateEventLog(events) {
	if (events.length === 0) fail("event log is empty");
	const ids = new Set();
	for (let index = 0; index < events.length; index += 1) {
		if (ids.has(events[index].event_id)) fail(`duplicate event_id: ${events[index].event_id}`);
		ids.add(events[index].event_id);
		validateEvent(events[index], index, events[index - 1]);
	}
}

function getPath(value, path) {
	const parts = path.startsWith("/")
		? path.slice(1).split("/").filter(Boolean).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
		: path.split(".").filter(Boolean);
	let current = value;
	for (const part of parts) {
		if (current === null || current === undefined || !Object.hasOwn(Object(current), part)) return undefined;
		current = current[part];
	}
	return current;
}

function matchesPredicate(value, predicate) {
	if (predicate.op === "exists") return value !== undefined;
	if (predicate.op === "eq") return stable(value) === stable(predicate.value);
	return stable(value) !== stable(predicate.value);
}

function evaluatePredicates(state, predicates) {
	return predicates.every((predicate) => matchesPredicate(getPath(state, predicate.path), predicate));
}

function valuesForPredicates(state, predicates) {
	return Object.fromEntries(predicates.map((predicate) => [predicate.path, getPath(state, predicate.path)]));
}

function stateFromFile(path) {
	try {
		return readJson(path);
	} catch {
		return null;
	}
}

function findLiveEpisode(events) {
	const starts = events.filter((event) => event.event_type === "episode.started" && event.payload?.source_kind === "live");
	if (starts.length !== 1) fail(`expected exactly one live episode.started event, found ${starts.length}`);
	const started = starts[0];
	const episodeEvents = events.filter((event) => event.episode_id === started.episode_id);
	if (!episodeEvents.some((event) => event.event_type === "episode.closed")) fail("live episode has no episode.closed event");
	return { started, episodeEvents };
}

function pairActions(episodeEvents) {
	const requested = episodeEvents.filter((event) => event.event_type === "action.requested");
	const completedById = new Map(
		episodeEvents
			.filter((event) => event.event_type === "action.completed")
			.map((event) => [event.payload?.action_id, event]),
	);
	return requested.map((request) => ({ request, completed: completedById.get(request.payload?.action_id) || null }));
}

function actionTargetsPath(pair, targetPath) {
	const input = pair.request.payload?.input || {};
	if (input.path === targetPath) return true;
	return typeof input.command_excerpt === "string" && input.command_excerpt.includes(targetPath);
}

function selectMutation(pairs, manifest) {
	return pairs.find(
		(pair) => manifest.action.tool_names.includes(pair.request.payload?.tool_name) && actionTargetsPath(pair, manifest.action.target_path),
	);
}

function selectReads(pairs, targetPath) {
	return pairs.filter((pair) => pair.request.payload?.tool_name === "read" && actionTargetsPath(pair, targetPath));
}

function transportFor(pair) {
	const transport = pair?.completed?.payload?.transport || {};
	return {
		tool_ok: transport.tool_ok === true,
		exit_code: transport.exit_code ?? null,
		timed_out: transport.timed_out ?? null,
		duration_ms: transport.duration_ms ?? null,
	};
}

function evidenceRefs(mutation, reads, manifest) {
	const refs = [];
	if (mutation?.completed?.event_id) refs.push({ ref_type: "event", ref_id: mutation.completed.event_id });
	for (const read of reads) {
		if (read.completed?.event_id) refs.push({ ref_type: "event", ref_id: read.completed.event_id });
	}
	refs.push({ ref_type: "artifact", ref_id: "manifest.json#state.initial_snapshot" });
	return refs;
}

function makeOutcome({ level, episodeId, stepId, criterion, status, observed, transport, evidence, failureMode, independenceGroup }) {
	const outcome = {
		schema_version: SCHEMA_VERSION,
		outcome_id: randomUUID(),
		level,
		episode_id: episodeId,
		...(stepId ? { step_id: stepId } : {}),
		status,
		criterion,
		observed: status === "unknown" || status === "invalid" ? null : observed,
		oracle: {
			oracle_id: "live-file-state-oracle",
			method: "deterministic_json_state_read",
			version: ORACLE_VERSION,
			independence_group: independenceGroup,
		},
		evidence_refs: evidence,
		transport,
		reproducibility: {
			replayable: false,
			replay_hash: digest({ criterion, observed, transport }),
			replay_count: 0,
			checked_at: isoNow(),
		},
		assessed_at: isoNow(),
	};
	if (failureMode) outcome.failure_mode = failureMode;
	return outcome;
}

function createAppender(events) {
	let previousDigest = events.at(-1)?.event_digest;
	const projected = [...events];
	return {
		emit(eventType, episodeId, sequence, payload, source, extra = {}) {
			const event = {
				schema_version: SCHEMA_VERSION,
				event_id: randomUUID(),
				event_type: eventType,
				episode_id: episodeId,
				sequence,
				occurred_at: extra.occurred_at || isoNow(),
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
			projected.push(event);
			return event;
		},
		all() {
			return projected;
		},
	};
}

function compileExperience({ experimentDir, manifest, episode, outcomes, preconditionEvent }) {
	const successful = outcomes.filter((outcome) => outcome.level === "episode" && outcome.status === "success");
	const failures = outcomes.filter((outcome) => outcome.level === "episode" && outcome.status === "failure");
	const unknown = outcomes.filter((outcome) => outcome.level === "episode" && outcome.status === "unknown");
	const independentGroups = new Set(successful.map((outcome) => outcome.oracle.independence_group));
	const gateReasons = [];
	if (independentGroups.size < 2) gateReasons.push("requires at least two independent successful episodes");
	if (successful.some((outcome) => !outcome.reproducibility.replayable)) gateReasons.push("requires replayable evidence for activation");
	const postconditions = manifest.state.postconditions;
	const firstSuccess = successful[0];
	const action = manifest.action;
	const actionPath = relative(experimentDir, action.target_path);
	const experience = {
		schema_version: SCHEMA_VERSION,
		experience_id: `experience-${manifest.experiment_id}-${randomUUID()}`,
		status: "candidate",
		when: manifest.state.preconditions.map((predicate) => ({ ...predicate, verified_by: preconditionEvent ? [preconditionEvent.event_id] : [] })),
		do: {
			tool: action.tool_names[0] || "unknown",
			operation: action.operation || action.tool_names[0] || "unknown",
			arguments_template: { path: actionPath.startsWith("..") || isAbsolute(actionPath) ? action.target_path : actionPath },
			risk_class: action.risk_class || "low",
		},
		expect: postconditions,
		scope: {
			...manifest.environment,
			permissions: manifest.environment.permissions || [],
			task_types: manifest.task_types || ["reproduce"],
			mode: "live",
		},
		support: {
			success_outcome_ids: successful.map((outcome) => outcome.outcome_id),
			failure_outcome_ids: failures.map((outcome) => outcome.outcome_id),
			unknown_outcome_ids: unknown.map((outcome) => outcome.outcome_id),
			independent_episode_count: independentGroups.size,
			success_count: successful.length,
			failure_count: failures.length,
			unknown_count: unknown.length,
		},
		provenance: {
			compiled_by: "aegis-live-compiler",
			compiler_version: ORACLE_VERSION,
			source_outcome_ids: outcomes.map((outcome) => outcome.outcome_id),
			source_episode_ids: [episode.episode_id],
			source_kind: [manifest.source_kind],
			compiled_at: isoNow(),
		},
		validation: {
			last_validated_at: isoNow(),
			replay_hash: firstSuccess?.reproducibility.replay_hash || digest({ experiment_id: manifest.experiment_id }),
			conflicts: [],
		},
		revision: 1,
		created_at: isoNow(),
		updated_at: isoNow(),
	};
	return { experience, gateReasons };
}

function project({ experimentDir, manifest, rawEvents }) {
	validateEventLog(rawEvents);
	const { started, episodeEvents } = findLiveEpisode(rawEvents);
	const pairs = pairActions(episodeEvents);
	const reads = selectReads(pairs, manifest.state.path);
	const mutation = selectMutation(pairs, manifest);
	const initialPreconditions = evaluatePredicates(manifest.state.initial_snapshot, manifest.state.preconditions);
	const state = stateFromFile(manifest.state.path);
	const postconditions = state ? evaluatePredicates(state, manifest.state.postconditions) : false;
	const observed = state ? valuesForPredicates(state, manifest.state.postconditions) : null;
	const transport = transportFor(mutation);
	let status = "unknown";
	let failureMode = "insufficient_evidence";
	if (!initialPreconditions) {
		failureMode = "precondition_unmet";
	} else if (!state) {
		failureMode = "insufficient_evidence";
	} else if (!mutation || !mutation.completed) {
		failureMode = "insufficient_evidence";
	} else if (!transport.tool_ok) {
		failureMode = "tool_error";
	} else if (postconditions) {
		status = "success";
		failureMode = undefined;
	} else {
		status = "failure";
		failureMode = "postcondition_failed";
	}

	const stepId = `step-${randomUUID()}`;
	const criterion = {
		criterion_id: manifest.goal.goal_id,
		description: manifest.goal.description,
		expected: Object.fromEntries(manifest.state.postconditions.map((predicate) => [predicate.path, predicate.value])),
	};
	const independenceGroup = manifest.independence_group || manifest.experiment_id;
	const evidence = evidenceRefs(mutation, reads, manifest);
	const stepOutcome = makeOutcome({
		level: "step",
		episodeId: started.episode_id,
		stepId,
		criterion: { ...criterion, criterion_id: `${criterion.criterion_id}:step` },
		status,
		observed,
		transport,
		evidence,
		failureMode,
		independenceGroup,
	});
	const appender = createAppender(rawEvents);
	const nextSequence = Math.max(...episodeEvents.map((event) => Number(event.sequence)).filter(Number.isInteger)) + 1;
	const preconditionEvent = appender.emit(
		"observation.captured",
		started.episode_id,
		nextSequence,
		{
			observation_kind: "state",
			path: "manifest.json#state.initial_snapshot",
			value: manifest.state.initial_snapshot,
			source: "experiment_setup",
		},
		{ actor_id: "live-file-state-oracle", kind: "oracle", adapter: "live-file-oracle", version: ORACLE_VERSION },
		{ evidence_refs: [{ ref_type: "event", ref_id: started.event_id }, { ref_type: "artifact", ref_id: "manifest.json#state.initial_snapshot" }] },
	);
	const stepOutcomeEvent = appender.emit(
		"outcome.recorded",
		started.episode_id,
		nextSequence + 1,
		{ outcome_id: stepOutcome.outcome_id, level: "step", status: stepOutcome.status, ...(stepOutcome.failure_mode ? { failure_mode: stepOutcome.failure_mode } : {}) },
		{ actor_id: "live-file-state-oracle", kind: "oracle", adapter: "live-file-oracle", version: ORACLE_VERSION },
		{ causation_id: mutation?.completed?.event_id || started.event_id, evidence_refs: stepOutcome.evidence_refs },
	);
	const episodeOutcome = makeOutcome({
		level: "episode",
		episodeId: started.episode_id,
		criterion,
		status,
		observed,
		transport,
		evidence: [{ ref_type: "event", ref_id: stepOutcomeEvent.event_id }, ...evidence],
		failureMode,
		independenceGroup,
	});
	const episodeOutcomeEvent = appender.emit(
		"outcome.recorded",
		started.episode_id,
		nextSequence + 2,
		{ outcome_id: episodeOutcome.outcome_id, level: "episode", status: episodeOutcome.status, ...(episodeOutcome.failure_mode ? { failure_mode: episodeOutcome.failure_mode } : {}) },
		{ actor_id: "live-file-state-oracle", kind: "oracle", adapter: "live-file-oracle", version: ORACLE_VERSION },
		{ causation_id: stepOutcomeEvent.event_id, evidence_refs: episodeOutcome.evidence_refs },
	);
	const projectedEvents = appender.all();
	const statusForEpisode = status === "unknown" ? "aborted" : "completed";
	const episode = {
		schema_version: SCHEMA_VERSION,
		episode_id: started.episode_id,
		status: statusForEpisode,
		source_kind: manifest.source_kind,
		goal: manifest.goal,
		authorization: manifest.authorization,
		environment: manifest.environment,
		started_at: started.occurred_at,
		ended_at: episodeEvents.at(-1)?.occurred_at || isoNow(),
		event_ids: projectedEvents.filter((event) => event.episode_id === started.episode_id).map((event) => event.event_id),
		steps: [{
			step_id: stepId,
			index: 0,
			action_event_id: mutation?.request?.event_id || reads[0]?.request?.event_id || started.event_id,
			observation_event_ids: [preconditionEvent.event_id],
			step_outcome_id: stepOutcome.outcome_id,
		}],
		episode_outcome_id: episodeOutcome.outcome_id,
		provenance: {
			source_refs: [`experiment:${manifest.experiment_id}`, "events.jsonl"],
			adapter: "live-file-oracle",
			adapter_version: ORACLE_VERSION,
		},
		episode_digest: digest({ episodeId: started.episode_id, eventIds: projectedEvents.map((event) => event.event_id), outcome: episodeOutcome.outcome_id }),
	};
	const compiled = compileExperience({ experimentDir, manifest, episode, outcomes: [stepOutcome, episodeOutcome], preconditionEvent });
	const report = {
		schema_version: SCHEMA_VERSION,
		oracle_version: ORACLE_VERSION,
		experiment_id: manifest.experiment_id,
		experiment_dir: experimentDir,
		source_event_log: join(experimentDir, "events.jsonl"),
		output_dir: null,
		counts: {
			raw_events: rawEvents.length,
			events: projectedEvents.length,
			episodes: 1,
			outcomes: 2,
			experiences: 1,
		},
		oracle: { id: "live-file-state-oracle", method: "deterministic_json_state_read" },
		episode_status: episode.status,
		outcome_status: episodeOutcome.status,
		experience_status: compiled.experience.status,
		gate: { status: compiled.experience.status, reasons: compiled.gateReasons, replay_only: false },
		validation: {
			initial_preconditions_verified: initialPreconditions,
			postconditions_verified: postconditions,
			mutation_action_id: mutation?.request?.payload?.action_id || null,
			mutation_tool_ok: transport.tool_ok,
		},
		warnings: ["Live state evidence is current-environment evidence; action replay remains disabled until a rerunnable adapter is declared."],
	};
	return { projectedEvents, episode, outcomes: [stepOutcome, episodeOutcome], experience: compiled.experience, report, preconditionEvent };
}

function writeOutputs(output, rawEvents, projection) {
	mkdirSync(output, { recursive: true });
	writeFileSync(join(output, "source-events.jsonl"), `${rawEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
	writeFileSync(join(output, "events.jsonl"), `${projection.projectedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
	writeFileSync(join(output, "episodes.json"), `${JSON.stringify([projection.episode], null, 2)}\n`, "utf8");
	writeFileSync(join(output, "outcomes.json"), `${JSON.stringify(projection.outcomes, null, 2)}\n`, "utf8");
	writeFileSync(join(output, "experiences.json"), `${JSON.stringify([projection.experience], null, 2)}\n`, "utf8");
	const report = { ...projection.report, output_dir: output };
	writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(HELP);
		return;
	}
	const experimentDir = resolvePath(options.experiment);
	const manifestPath = join(experimentDir, "manifest.json");
	const eventPath = join(experimentDir, "events.jsonl");
	const manifest = validateManifest(readJson(manifestPath), experimentDir);
	const rawEvents = readJsonl(eventPath);
	const projection = project({ experimentDir, manifest, rawEvents });
	const output = resolvePath(options.output || join(experimentDir, "oracle-v1"));
	writeOutputs(output, rawEvents, projection);
	console.log(JSON.stringify({
		output,
		counts: projection.report.counts,
		outcome_status: projection.report.outcome_status,
		experience_status: projection.report.experience_status,
		gate_reasons: projection.report.gate.reasons,
	}, null, 2));
}

try {
	main();
} catch (error) {
	console.error(`live-oracle: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
