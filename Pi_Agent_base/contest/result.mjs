#!/usr/bin/env node
// Aegis contest — manual external result capture (smallest reliable slice).
//
// Contest outcomes come from an INDEPENDENT source: a scoring platform or an
// explicit human confirmation. This tool never infers success from the model,
// from agent_settled, from an exit code, or from a tool result. Missing input
// stays `unknown`.
//
// It writes ONE JSONL row per task to the isolated results log and refuses to
// record anything that looks like a flag/secret. It never reads auth.json or
// any credential file, and it never touches the Pi fork.
//
// Usage:
//   node Pi_Agent_base/contest/result.mjs add \
//     --task-id <id> --session-id <id> --result success|failure|unknown \
//     --source <platform|human> [--evidence <short-non-secret-summary>] \
//     [--group off|hint] [--card <id@rev>] [--notes <short text>] \
//     [--at <ISO-8601>]
//   node Pi_Agent_base/contest/result.mjs list
//   node Pi_Agent_base/contest/result.mjs --help
//
// Env:
//   AEGIS_CONTEST_RESULTS   results JSONL path
//                           (default: ~/.Aegis/runtime/contest/results.jsonl)

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = resolve(HERE, "..");
const AEGIS_HOME = process.env.AEGIS_HOME || join(process.env.HOME || BASE_DIR, ".Aegis");
const RESULTS_PATH = process.env.AEGIS_CONTEST_RESULTS || join(AEGIS_HOME, "runtime", "contest", "results.jsonl");

// The results log may reference task evidence; keep NEW files owner-only.
process.umask(0o077);

// Conservative secret/flag patterns. If a value matches, refuse to write it
// rather than storing something sensitive. This is intentionally narrow.
const SECRET_PATTERNS = [
	/flag\{[^}]*\}/i,
	/\b[a-z0-9_]*flag\b\s*[:=]\s*\S+/i,
	/\b(?:token|secret|password|passwd|api[_-]?key|bearer)\b\s*[:=]\s*\S+/i,
	/\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9]{12,}\b/,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

// Provenance that actually counts as an INDEPENDENT judgement: a scoring
// platform's ruling or an explicit human verification. Anything else is not
// independent and can never carry success/failure.
const INDEPENDENT_SOURCES = new Set(["platform", "human"]);

function looksSecret(value) {
	return SECRET_PATTERNS.some((re) => re.test(value));
}

function parseArgs(argv) {
	const [command, ...rest] = argv;
	const flags = {};
	for (let i = 0; i < rest.length; i += 1) {
		const token = rest[i];
		if (!token.startsWith("--")) {
			return { command, error: `unexpected argument: ${token}` };
		}
		const key = token.slice(2);
		const value = rest[i + 1];
		if (value === undefined || value.startsWith("--")) {
			// boolean flag
			flags[key] = true;
		} else {
			flags[key] = value;
			i += 1;
		}
	}
	return { command, flags };
}

function usage() {
	return `Aegis contest manual result capture (independent outcomes only)

Usage:
  result.mjs add --task-id <id> --result success|failure|unknown [options]
  result.mjs list
  result.mjs --help

add options:
  --task-id <id>     required, anonymous contest task id (e.g. task-007)
  --result <state>   success | failure | unknown   (default: unknown)
                     success/failure REQUIRE --source platform|human and a
                     short non-secret --evidence reference
  --source <src>     platform | human | <other>    (default: human)
  --session-id <id>  Pi session id this result belongs to (recommended)
  --group <g>        experimental group: off | hint
  --card <id@rev>    injected card id@revision, if any
  --evidence <text>  SHORT non-sensitive evidence reference/summary
                     (required for success/failure)
  --notes <text>     SHORT free-text note (no flags/secrets)
  --at <iso8601>     override timestamp (default: now)

Environment:
  AEGIS_CONTEST_RESULTS  results JSONL path (default: ${join(AEGIS_HOME, "runtime", "contest", "results.jsonl")})

Safety:
  refuses values that look like flags/credentials; never reads auth.json;
  never records raw tool output; missing --result defaults to unknown;
  success/failure without platform/human provenance + evidence is refused.
`;
}

async function add(flags) {
	const taskId = typeof flags["task-id"] === "string" ? flags["task-id"].trim() : "";
	if (!taskId) return { ok: false, error: "--task-id is required" };

	const resultRaw = typeof flags.result === "string" ? flags.result.trim().toLowerCase() : "unknown";
	const allowed = new Set(["success", "failure", "unknown"]);
	const result = allowed.has(resultRaw) ? resultRaw : null;
	if (result === null) return { ok: false, error: `--result must be one of success|failure|unknown (got ${resultRaw})` };

	// Default source is "human" for compatibility, but an independent-provenance
	// claim is only made when the source is exactly platform|human AND evidence
	// is present AND the source string is recognized. Nothing else ever gets
	// `independent: true`.
	const source = typeof flags.source === "string" && flags.source.trim() ? flags.source.trim().toLowerCase() : "human";
	const sessionId = typeof flags["session-id"] === "string" ? flags["session-id"].trim() : "";
	const group = typeof flags.group === "string" ? flags.group.trim() : "";
	if (group && group !== "off" && group !== "hint") return { ok: false, error: "--group must be off or hint" };
	const card = typeof flags.card === "string" ? flags.card.trim() : "";
	const evidence = typeof flags.evidence === "string" ? flags.evidence.trim().slice(0, 500) : "";
	const notes = typeof flags.notes === "string" ? flags.notes.trim().slice(0, 500) : "";
	const at = typeof flags.at === "string" && flags.at.trim() ? flags.at.trim() : new Date().toISOString();
	if (Number.isNaN(Date.parse(at))) return { ok: false, error: "--at is not a valid ISO-8601 timestamp" };

	// Refuse to persist anything that looks sensitive.
	for (const [field, value] of Object.entries({ evidence, notes, card, source })) {
		if (value && looksSecret(value)) {
			return { ok: false, error: `refusing to store ${field}: value looks like a flag/credential` };
		}
	}

	// success/failure demand an independent source AND a short evidence ref.
	// A model's self-report, an exit code, or a bare string is not enough.
	if (result === "success" || result === "failure") {
		if (!INDEPENDENT_SOURCES.has(source)) {
			return {
				ok: false,
				error: `--result ${result} requires an independent --source platform|human (got "${source}"); use unknown if there is no platform/human judgement`,
			};
		}
		if (!evidence) {
			return {
				ok: false,
				error: `--result ${result} requires a short non-secret --evidence reference (score, ruling id, or human-verification note)`,
			};
		}
	}

	// `independent` is a statement about provenance, not about the result. It is
	// true only for a recognized independent source carrying its evidence ref.
	const independent = INDEPENDENT_SOURCES.has(source) && evidence.length > 0;

	const row = {
		schema_version: "1.0",
		recorded_at: new Date().toISOString(),
		at,
		task_id: taskId,
		session_id: sessionId || null,
		group: group || null,
		card: card || null,
		result,
		result_source: source,
		evidence: evidence || null,
		notes: notes || null,
		// true only when a platform/human judgement with an evidence reference
		// backs this row; never inferred from agent behavior.
		independent,
	};

	await mkdir(dirname(RESULTS_PATH), { recursive: true });
	await appendFile(RESULTS_PATH, `${JSON.stringify(row)}\n`, "utf8");
	return { ok: true, row };
}

async function list() {
	let text = "";
	try {
		text = await readFile(RESULTS_PATH, "utf8");
	} catch {
		return { ok: true, rows: [], path: RESULTS_PATH, missing: true };
	}
	const rows = text
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return { parse_error: true, line };
			}
		});
	return { ok: true, rows, path: RESULTS_PATH };
}

async function main() {
	const argv = process.argv.slice(2);
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		process.stdout.write(usage());
		return 0;
	}
	const { command, flags, error } = parseArgs(argv);
	if (error) {
		process.stderr.write(`error: ${error}\n\n${usage()}`);
		return 2;
	}
	if (command === "add") {
		const outcome = await add(flags ?? {});
		if (!outcome.ok) {
			process.stderr.write(`error: ${outcome.error}\n`);
			return 2;
		}
		process.stdout.write(`${JSON.stringify(outcome.row)}\n`);
		return 0;
	}
	if (command === "list") {
		const outcome = await list();
		if (outcome.missing) {
			process.stdout.write(`(no results recorded yet at ${outcome.path})\n`);
			return 0;
		}
		for (const row of outcome.rows) process.stdout.write(`${JSON.stringify(row)}\n`);
		return 0;
	}
	process.stderr.write(`error: unknown command "${command}"\n\n${usage()}`);
	return 2;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		process.stderr.write(`error: ${String(error)}\n`);
		process.exitCode = 1;
	});
