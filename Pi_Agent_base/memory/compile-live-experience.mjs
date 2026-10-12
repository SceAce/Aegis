#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const SCHEMA_VERSION = "1.0";
const COMPILER_VERSION = "0.1.0";

const HELP = `Compile independent live Oracle projections into one Experience candidate.

Usage:
  ./compile-live-experience.mjs \
    --projection DIR \
    --projection DIR \
    --output DIR
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

function parseArgs(argv) {
	const options = { projections: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") options.help = true;
		else if (argument === "--projection" || argument === "--output") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
			if (argument === "--projection") options.projections.push(value);
			else options.output = value;
			index += 1;
		} else fail(`Unknown option: ${argument}`);
	}
	if (!options.help && options.projections.length === 0) fail("at least one --projection is required");
	if (!options.help && !options.output) fail("--output is required");
	return options;
}

function readJson(path) {
	if (!existsSync(path)) fail(`File does not exist: ${path}`);
	try {
		return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
	} catch (error) {
		fail(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function assertArray(value, label) {
	if (!Array.isArray(value)) fail(`${label} must be an array`);
}


function normalizeRule(experience, projectionRoot) {
	const experimentRoot = resolve(projectionRoot, "..");
	const action = experience.do && typeof experience.do === "object" ? { ...experience.do } : experience.do;
	if (action?.arguments_template && typeof action.arguments_template === "object") {
		action.arguments_template = { ...action.arguments_template };
		const path = action.arguments_template.path;
		if (typeof path === "string" && isAbsolute(path)) {
			const relativePath = relative(experimentRoot, path);
			if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) action.arguments_template.path = relativePath;
		}
	}
	return {
		when: (experience.when || []).map(({ verified_by: _verifiedBy, ...predicate }) => predicate),
		do: action,
		expect: experience.expect,
		scope: experience.scope,
	};
}

function validateProjection(directory) {
	const root = isAbsolute(directory) ? directory : resolve(process.cwd(), directory);
	const report = readJson(join(root, "report.json"));
	const episodes = readJson(join(root, "episodes.json"));
	const outcomes = readJson(join(root, "outcomes.json"));
	const experiences = readJson(join(root, "experiences.json"));
	if (report.schema_version !== SCHEMA_VERSION) fail(`projection ${root} has an unsupported report schema`);
	assertArray(episodes, `${root}/episodes.json`);
	assertArray(outcomes, `${root}/outcomes.json`);
	assertArray(experiences, `${root}/experiences.json`);
	if (report.outcome_status !== "success") fail(`projection ${root} is not a successful live projection`);
	if (episodes.length !== 1 || episodes[0].source_kind !== "live") fail(`projection ${root} must contain one live Episode`);
	if (!experiences[0]) fail(`projection ${root} has no Experience`);
	const episodeOutcomes = outcomes.filter((outcome) => outcome.level === "episode");
	if (episodeOutcomes.length !== 1) fail(`projection ${root} must contain one episode Outcome`);
	if (episodeOutcomes[0].status !== "success") fail(`projection ${root} episode Outcome is not success`);
	for (const [label, rows] of [["episode", episodes], ["outcome", outcomes]]) {
		const ids = rows.map((row) => row[`${label}_id`]);
		if (new Set(ids).size !== ids.length) fail(`projection ${root} has duplicate ${label}_id values`);
	}
	return { root, report, episodes, outcomes, experience: experiences[0] };
}

function mergeVerifiedPredicates(experiences) {
	const byKey = new Map();
	for (const experience of experiences) {
		for (const predicate of experience.when || []) {
			const key = stable({ path: predicate.path, op: predicate.op, value: predicate.value });
			const current = byKey.get(key) || { path: predicate.path, op: predicate.op, value: predicate.value, verified_by: [] };
			current.verified_by.push(...(predicate.verified_by || []));
			byKey.set(key, current);
		}
	}
	return [...byKey.values()].map((predicate) => ({ ...predicate, verified_by: [...new Set(predicate.verified_by)] }));
}

function compile(projections) {
	const allEpisodes = projections.flatMap((projection) => projection.episodes);
	const allOutcomes = projections.flatMap((projection) => projection.outcomes);
	const episodeOutcomes = allOutcomes.filter((outcome) => outcome.level === "episode");
	const successful = episodeOutcomes.filter((outcome) => outcome.status === "success");
	const failures = episodeOutcomes.filter((outcome) => outcome.status === "failure");
	const unknown = episodeOutcomes.filter((outcome) => outcome.status === "unknown");
	const groups = new Set(successful.map((outcome) => outcome.oracle.independence_group));
	const rules = projections.map((projection) => normalizeRule(projection.experience, projection.root));
	const conflicts = [];
	for (let index = 1; index < rules.length; index += 1) {
		if (stable(rules[index]) !== stable(rules[0])) conflicts.push(`projection ${index + 1} has a scope or action rule conflict`);
	}
	const gateReasons = [];
	if (groups.size < 2) gateReasons.push("requires at least two independent successful episodes");
	if (successful.some((outcome) => !outcome.reproducibility.replayable)) gateReasons.push("requires replayable evidence for activation");
	if (conflicts.length > 0) gateReasons.push("scope or action conflict prevents activation");
	const first = projections[0].experience;
	const firstRule = rules[0];
	const experience = {
		schema_version: SCHEMA_VERSION,
		experience_id: `experience-live-${randomUUID()}`,
		status: "candidate",
		when: mergeVerifiedPredicates(projections.map((projection) => projection.experience)),
		do: firstRule.do,
		expect: first.expect,
		scope: first.scope,
		support: {
			success_outcome_ids: successful.map((outcome) => outcome.outcome_id),
			failure_outcome_ids: failures.map((outcome) => outcome.outcome_id),
			unknown_outcome_ids: unknown.map((outcome) => outcome.outcome_id),
			independent_episode_count: groups.size,
			success_count: successful.length,
			failure_count: failures.length,
			unknown_count: unknown.length,
		},
		provenance: {
			compiled_by: "aegis-live-compiler",
			compiler_version: COMPILER_VERSION,
			source_outcome_ids: allOutcomes.map((outcome) => outcome.outcome_id),
			source_episode_ids: allEpisodes.map((episode) => episode.episode_id),
			source_kind: [...new Set(allEpisodes.map((episode) => episode.source_kind))],
			compiled_at: isoNow(),
		},
		validation: {
			last_validated_at: isoNow(),
			replay_hash: digest({ outcomes: successful.map((outcome) => outcome.outcome_id), expect: first.expect }),
			conflicts,
		},
		revision: 1,
		created_at: isoNow(),
		updated_at: isoNow(),
	};
	return { allEpisodes, allOutcomes, experience, gateReasons, conflicts };
}

function writeOutput(output, projections, compiled) {
	mkdirSync(output, { recursive: true });
	const sources = projections.map((projection) => ({
		directory: projection.root,
		experiment_id: projection.report.experiment_id,
		report_digest: digest(projection.report),
		episode_ids: projection.episodes.map((episode) => episode.episode_id),
		outcome_ids: projection.outcomes.map((outcome) => outcome.outcome_id),
	}));
	const report = {
		schema_version: SCHEMA_VERSION,
		compiler_version: COMPILER_VERSION,
		output_dir: output,
		counts: {
			projections: projections.length,
			episodes: compiled.allEpisodes.length,
			outcomes: compiled.allOutcomes.length,
			experiences: 1,
		},
		experience_status: compiled.experience.status,
		gate: { status: compiled.experience.status, reasons: compiled.gateReasons, replay_only: false },
		independence: {
			groups: [...new Set(compiled.allOutcomes.filter((outcome) => outcome.level === "episode" && outcome.status === "success").map((outcome) => outcome.oracle.independence_group))],
		},
		sources,
		warnings: ["This compiler combines projections; it does not re-run an action or upgrade live evidence to replayable evidence."],
	};
	writeFileSync(join(output, "sources.json"), `${JSON.stringify(sources, null, 2)}\n`, "utf8");
	writeFileSync(join(output, "episodes.json"), `${JSON.stringify(compiled.allEpisodes, null, 2)}\n`, "utf8");
	writeFileSync(join(output, "outcomes.json"), `${JSON.stringify(compiled.allOutcomes, null, 2)}\n`, "utf8");
	writeFileSync(join(output, "experiences.json"), `${JSON.stringify([compiled.experience], null, 2)}\n`, "utf8");
	writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
	return report;
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(HELP);
		return;
	}
	const projections = options.projections.map(validateProjection);
	const compiled = compile(projections);
	const output = isAbsolute(options.output) ? options.output : resolve(process.cwd(), options.output);
	const report = writeOutput(output, projections, compiled);
	console.log(JSON.stringify({ output, counts: report.counts, experience_status: report.experience_status, gate_reasons: report.gate.reasons }, null, 2));
}

try {
	main();
} catch (error) {
	console.error(`compile-live-experience: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
