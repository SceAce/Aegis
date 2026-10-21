#!/usr/bin/env node
// Register ONE tool into the Aegis script roster.
//
// The roster is what `aegis_execute` can actually run: a fixed executable, a fixed
// argv template, digest-pinned implementation, bounded workspace, data-only
// parameters and a post-condition Oracle. Nothing here is inferred from a tool's
// `--help`; the human supplies the argv shape and the Oracle, because guessing
// either would create an action nobody reviewed.
//
// What this script does for you is the error-prone part: computing digests,
// validating the registration against the real gate, and keeping the roster a
// plain JSON file you can read and diff.
//
// Usage:
//   node aegis-register-tool.mjs --recipe recipe.json [--roster roster.json]
//   node aegis-register-tool.mjs --recipe recipe.json --dry-run
//   node aegis-register-tool.mjs --list [--roster roster.json]
//
// Recipe (the only thing a human writes):
//   {
//     "id": "crypto-common-modulus",
//     "version": 1,
//     "description": "同一模数、不同指数时恢复明文",
//     "executable": "/usr/bin/python3",           // or omit to use the recipe's default
//     "script": "scripts/common-modulus.py",       // relative to the recipe
//     "argv": ["{script}", "{n}", "{e1}", "{c1}", "{e2}", "{c2}", "{out}"],
//     "parameters": {
//       "n": {"type": "string", "required": true},
//       "e1": {"type": "string", "required": true},
//       "c1": {"type": "string", "required": true},
//       "e2": {"type": "string", "required": true},
//       "c2": {"type": "string", "required": true},
//       "out": {"type": "string", "required": true, "direction": "out"}
//     },
//     "verify": {
//       "kind": "json_post_state", "resource": "out",
//       "checks": [{"path": "plaintext", "op": "exists"}]
//     }
//   }
//
// `{script}` is expanded to the absolute script path; every other `{name}` is a
// declared parameter. The registered argv never contains a shell, and the script
// body is digest-pinned so a later edit is refused until it is re-reviewed.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { validateScriptRegistration } from "./Pi_Agent_base/execution/script-registry.mjs";

const DEFAULT_ROSTER = process.env.AEGIS_SCRIPT_CONFIG || "roster.json";
const SHELLS = new Set([
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"fish",
	"csh",
	"tcsh",
	"cmd",
	"cmd.exe",
	"powershell",
	"pwsh",
]);
const EVAL_TOKENS = new Set(["-e", "--eval", "-c", "-Command", "-EncodedCommand", "--command"]);
const INTERPRETERS = new Set([
	"node",
	"node.exe",
	"python",
	"python3",
	"python3.11",
	"python3.12",
	"ruby",
	"perl",
	"deno",
	"bun",
]);

const sha256 = (path) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const basename = (path) => path.split("/").pop();

function fail(message) {
	console.error(`aegis-register-tool: ${message}`);
	process.exit(2);
}

function usage() {
	console.log(`Usage:
  node aegis-register-tool.mjs --recipe recipe.json [--roster roster.json] [--dry-run]
  node aegis-register-tool.mjs --list [--roster roster.json]

The recipe is the human-reviewed part: argv shape, parameters, and the
post-condition Oracle. This script computes digests and validates the result
against the same gate the runtime uses.`);
}

function parseArgs(argv) {
	const options = { roster: DEFAULT_ROSTER, dryRun: false, list: false, recipe: null };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const value = () => {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) fail(`${arg} needs a value`);
			i += 1;
			return next;
		};
		if (arg === "--recipe") options.recipe = value();
		else if (arg === "--roster") options.roster = value();
		else if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--list") options.list = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else fail(`unknown option: ${arg}`);
	}
	return options;
}

function readRoster(path) {
	if (!existsSync(path)) return { scripts: [] };
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		fail(`roster is not valid JSON (${path}): ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || !Array.isArray(parsed.scripts)) fail(`roster must be {"scripts": [...]} (${path})`);
	return parsed;
}

/** Turn a recipe into a registration, computing digests. */
export function buildRegistration(recipe, { baseDir = process.cwd() } = {}) {
	if (!recipe || typeof recipe !== "object") fail("recipe must be an object");
	const id = typeof recipe.id === "string" ? recipe.id.trim() : "";
	if (!id) fail("recipe.id is required");
	const version = recipe.version;
	if (!Number.isInteger(version) || version < 1) fail("recipe.version must be a positive integer");

	const scriptPath = recipe.script
		? isAbsolute(recipe.script)
			? recipe.script
			: resolve(baseDir, recipe.script)
		: null;
	if (recipe.script && !existsSync(scriptPath)) fail(`recipe.script not found: ${scriptPath}`);

	const executable = typeof recipe.executable === "string" && recipe.executable ? recipe.executable : process.execPath;
	if (!isAbsolute(executable)) fail("recipe.executable must be an absolute path");
	if (!existsSync(executable)) fail(`recipe.executable not found: ${executable}`);
	if (SHELLS.has(basename(executable).toLowerCase()))
		fail(`shell interpreters are not allowed: ${basename(executable)}`);

	const argvTemplate = recipe.argv;
	if (!Array.isArray(argvTemplate) || argvTemplate.length === 0) fail("recipe.argv must be a non-empty array");
	for (const token of argvTemplate) {
		if (typeof token !== "string") fail("recipe.argv entries must be strings");
		if (EVAL_TOKENS.has(token)) fail(`recipe.argv contains a forbidden eval/shell token: ${token}`);
		if (token.includes(";") || token.includes("|") || token.includes("&") || token.includes("`"))
			fail(`recipe.argv must not contain shell metacharacters: ${token}`);
	}
	const expandedArgv = argvTemplate.map((token) => token.replaceAll("{script}", scriptPath ?? "{script}"));
	if (INTERPRETERS.has(basename(executable).toLowerCase()) && !scriptPath)
		fail("an interpreter registration needs recipe.script so the script body can be digest-pinned");
	if (scriptPath && !expandedArgv.includes(scriptPath))
		fail("recipe.argv must reference {script} as an executable token");

	const workspaceHint = typeof recipe.workspace === "string" && recipe.workspace ? recipe.workspace : baseDir;
	if (!isAbsolute(workspaceHint)) fail("recipe.workspace must be an absolute path");

	const registration = {
		schema_version: "1.0",
		id,
		version,
		description: recipe.description,
		executable,
		executable_digest: sha256(executable),
		...(scriptPath ? { script_path: scriptPath, script_digest: sha256(scriptPath) } : {}),
		argv_template: expandedArgv,
		allowed_root: workspaceHint,
		cwd: workspaceHint,
		parameters: recipe.parameters ?? {},
		verify_spec: recipe.verify,
	};
	const review = validateScriptRegistration(registration);
	if (!review.ok) fail(`registration refused: ${review.reasons.join("; ")}`);
	return registration;
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) return usage();

	const roster = readRoster(options.roster);

	if (options.list) {
		if (roster.scripts.length === 0) {
			console.log(`no registered tools in ${options.roster}`);
			return;
		}
		console.log(`${roster.scripts.length} tool(s) in ${options.roster}`);
		for (const entry of roster.scripts) {
			const params = Object.keys(entry.parameters ?? {});
			console.log(`  ${entry.id}@${entry.version}  ${entry.description ?? "(no description)"}`);
			console.log(`    parameters: ${params.length > 0 ? params.join(", ") : "(none)"}`);
		}
		return;
	}

	if (!options.recipe) {
		usage();
		fail("--recipe is required (or use --list)");
	}
	const recipePath = resolve(options.recipe);
	if (!existsSync(recipePath)) fail(`recipe not found: ${recipePath}`);
	let recipe;
	try {
		recipe = JSON.parse(readFileSync(recipePath, "utf8"));
	} catch (error) {
		fail(`recipe is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const registration = buildRegistration(recipe, { baseDir: dirname(recipePath) });

	// Replace an exact id@version, append otherwise. A different version is a NEW
	// entry: a re-reviewed script never silently replaces the pinned one.
	const index = roster.scripts.findIndex(
		(entry) => entry.id === registration.id && entry.version === registration.version,
	);
	const replaced = index >= 0;
	if (replaced) roster.scripts[index] = registration;
	else roster.scripts.push(registration);
	roster.scripts.sort((a, b) => (a.id === b.id ? a.version - b.version : a.id < b.id ? -1 : 1));

	if (options.dryRun) {
		console.log(JSON.stringify(registration, null, 2));
		console.log(
			`\ndry run: would ${replaced ? "replace" : "add"} ${registration.id}@${registration.version} in ${options.roster}`,
		);
		return;
	}
	writeFileSync(options.roster, `${JSON.stringify(roster, null, 2)}\n`, { mode: 0o600 });
	console.log(`${replaced ? "replaced" : "added"} ${registration.id}@${registration.version} in ${options.roster}`);
	console.log(`  executable  ${registration.executable}`);
	if (registration.script_path)
		console.log(`  script      ${registration.script_path} (${registration.script_digest.slice(0, 19)}…)`);
	console.log(`  argv        ${registration.argv_template.join(" ")}`);
	console.log(`  oracle      ${registration.verify_spec.kind} on ${registration.verify_spec.resource}`);
	console.log("\nNext: start a run with this roster (run-experiment.sh --script-config, or AEGIS_SCRIPT_CONFIG).");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	main();
}
