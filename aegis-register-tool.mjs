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
//   node aegis-register-tool.mjs --probe /path/to/tool [--out draft.json]
//   node aegis-register-tool.mjs --scaffold /path/to/tool --sample "<args>" [--out recipe.json]
//   node aegis-register-tool.mjs --validate recipe.json
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
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	isInterpreter as registryIsInterpreter,
	validateScriptRegistration,
} from "./Pi_Agent_base/execution/script-registry.mjs";

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
const _INTERPRETERS = new Set([
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
//   node aegis-register-tool.mjs --probe /path/to/tool [--out draft.json]
//   node aegis-register-tool.mjs --scaffold /path/to/tool --sample "<args>" [--out recipe.json]
//   node aegis-register-tool.mjs --validate recipe.json

The recipe is the human-reviewed part: argv shape, parameters, and the
post-condition Oracle. This script computes digests and validates the result
against the same gate the runtime uses.`);
}

function parseArgs(argv) {
	const options = {
		roster: DEFAULT_ROSTER,
		dryRun: false,
		list: false,
		recipe: null,
		probe: null,
		scaffold: null,
		sample: null,
		validate: null,
		out: null,
	};
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
		else if (arg === "--probe") options.probe = value();
		else if (arg === "--scaffold") options.scaffold = value();
		else if (arg === "--sample") options.sample = value();
		else if (arg === "--validate") options.validate = value();
		else if (arg === "--out") options.out = value();
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
	if (registryIsInterpreter(executable) && !scriptPath)
		fail("an interpreter registration needs recipe.script so the script body can be digest-pinned");
	if (scriptPath && !expandedArgv.includes(scriptPath))
		fail("recipe.argv must reference {script} as an executable token");

	// `"{workspace}"` binds the tool to whatever workspace the run uses, so one
	// reviewed roster works in every experiment. A concrete path stays supported for
	// tools that must run in a fixed location.
	const workspaceHint = typeof recipe.workspace === "string" && recipe.workspace ? recipe.workspace : "{workspace}";
	const runBound = workspaceHint === "{workspace}";
	if (!runBound && !isAbsolute(workspaceHint)) fail('recipe.workspace must be an absolute path or "{workspace}"');

	// Optional metadata that makes the action callable by a model rather than only
	// runnable by a human: what it is for, when NOT to use it, and a worked call.
	// These are surfaced by aegis_tools; they never affect execution.
	if (recipe.notes !== undefined && (typeof recipe.notes !== "string" || recipe.notes.length > 500))
		fail("recipe.notes must be a string of <= 500 characters");
	if (recipe.examples !== undefined) {
		if (!Array.isArray(recipe.examples) || recipe.examples.length > 5)
			fail("recipe.examples must be an array of <= 5 entries");
		for (const [index, example] of recipe.examples.entries()) {
			if (!example || typeof example !== "object" || Array.isArray(example))
				fail(`recipe.examples[${index}] must be an object`);
			if (!example.arguments || typeof example.arguments !== "object" || Array.isArray(example.arguments))
				fail(`recipe.examples[${index}].arguments must be an object`);
			if (example.note !== undefined && typeof example.note !== "string")
				fail(`recipe.examples[${index}].note must be a string`);
		}
	}
	if (
		recipe.timeout_ms !== undefined &&
		(!Number.isInteger(recipe.timeout_ms) || recipe.timeout_ms < 1 || recipe.timeout_ms > 600000)
	)
		fail("recipe.timeout_ms must be an integer between 1 and 600000");
	if (recipe.risk_class !== undefined && !["observe", "low", "medium", "high"].includes(recipe.risk_class))
		fail("recipe.risk_class must be observe|low|medium|high");
	if (recipe.network !== undefined && typeof recipe.network !== "boolean") fail("recipe.network must be a boolean");
	if (recipe.category !== undefined && (typeof recipe.category !== "string" || recipe.category.length > 40))
		fail("recipe.category must be a string of <= 40 characters");

	const registration = {
		schema_version: "1.0",
		id,
		version,
		description: recipe.description,
		...(recipe.category ? { category: recipe.category } : {}),
		...(recipe.notes ? { notes: recipe.notes } : {}),
		...(recipe.examples ? { examples: recipe.examples } : {}),
		...(recipe.risk_class ? { risk_class: recipe.risk_class } : {}),
		...(recipe.network !== undefined ? { network: recipe.network === true } : {}),
		...(recipe.timeout_ms ? { timeout_ms: recipe.timeout_ms } : {}),
		executable,
		executable_digest: sha256(executable),
		...(scriptPath ? { script_path: scriptPath, script_digest: sha256(scriptPath) } : {}),
		argv_template: expandedArgv,
		...(runBound ? { workspace_binding: "run" } : { allowed_root: workspaceHint, cwd: workspaceHint }),
		parameters: recipe.parameters ?? {},
		verify_spec: recipe.verify,
	};
	const review = validateScriptRegistration(registration);
	if (!review.ok) fail(`registration refused: ${review.reasons.join("; ")}`);
	return registration;
}

/**
 * Inspect a path and write a DRAFT recipe.
 *
 * Probing deliberately stops at observable facts: real path, file kind, digests,
 * and the first line of `--version` when the tool accepts it. It never guesses the
 * argv shape, the parameters or the Oracle, because those are the reviewed parts
 * and a wrong guess would look like a working registration.
 */
function probe(target, { out = null } = {}) {
	const resolved = resolve(target);
	if (!existsSync(resolved)) fail(`path not found: ${resolved}`);
	const stat = lstatSync(resolved);
	// Homebrew and most package managers install symlinks into bin/, so resolving is
	// the normal case. The digest pins the REAL file, and the report says so.
	const symlinked = stat.isSymbolicLink();
	const real = realpathSync(resolved);
	const realStat = lstatSync(real);
	if (realStat.isDirectory()) fail(`probe expects a file; for a directory pass its entry script: ${resolved}`);
	const digest = sha256(real);

	const head = readFileSync(real).subarray(0, 200).toString("utf8");
	const shebang = head.startsWith("#!") ? head.split("\n")[0].slice(2).trim() : null;
	const shebangParts = shebang ? shebang.split(/\s+/) : [];
	// `#!/usr/bin/env python3` must pin PYTHON, not env: registering /usr/bin/env
	// would leave the real interpreter unpinned.
	const rawInterpreter =
		shebangParts[0] && basename(shebangParts[0]) === "env" ? (shebangParts[1] ?? null) : (shebangParts[0] ?? null);
	let interpreter = null;
	if (rawInterpreter) {
		if (isAbsolute(rawInterpreter) && existsSync(rawInterpreter)) interpreter = realpathSync(rawInterpreter);
		else {
			for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
				const candidate = join(dir, rawInterpreter);
				if (existsSync(candidate)) {
					interpreter = realpathSync(candidate);
					break;
				}
			}
		}
	}
	const kind = interpreter ? `script (${interpreter})` : "binary";
	const unknownInterpreter = Boolean(rawInterpreter) && !interpreter;

	// `--version` is the one invocation that is conventionally side-effect free. It
	// only makes sense for something directly runnable; a non-executable script is
	// not, and probing it would report EACCES as if the tool were broken.
	let version = null;
	let versionError = null;
	const files = interpreter ? [interpreter, real] : [real];
	if (files.every((file) => (lstatSync(file).mode & 0o111) !== 0)) {
		const probeRun = spawnSync(real, ["--version"], {
			encoding: "utf8",
			timeout: 5000,
			shell: false,
			maxBuffer: 64 * 1024,
		});
		if (probeRun.error) versionError = probeRun.error.message;
		else {
			const text = `${probeRun.stdout ?? ""}${probeRun.stderr ?? ""}`.trim().split("\n")[0] ?? "";
			version = text.slice(0, 200) || null;
		}
	}
	const isShell = SHELLS.has(basename(real).toLowerCase());

	const draft = {
		id: basename(real)
			.replace(/[^A-Za-z0-9._-]/g, "-")
			.toLowerCase(),
		version: 1,
		description: "",
		category: "",
		notes: "",
		executable: interpreter ?? real,
		...(interpreter ? { script: real } : {}),
		argv: interpreter ? ["{script}", "{out}"] : ["{out}"],
		workspace: process.cwd(),
		parameters: { out: { type: "string", required: true, direction: "out" } },
		verify: { kind: "json_post_state", resource: "out", checks: [{ path: "result", op: "exists" }] },
	};

	const report = {
		path: real,
		...(symlinked ? { symlinked_from: resolved } : {}),
		kind,
		executable: interpreter ?? real,
		executable_digest: interpreter ? sha256(interpreter) : digest,
		...(interpreter ? { script: real, script_digest: digest } : {}),
		version,
		version_error: versionError,
		refusals: [
			...(isShell ? ["this is a shell interpreter; the registry refuses those"] : []),
			...(unknownInterpreter
				? [`shebang interpreter could not be resolved: ${shebangParts.slice(0, 2).join(" ")}`]
				: []),
			...(interpreter && !registryIsInterpreter(interpreter) && !isShell
				? [
						`interpreter ${basename(interpreter)} is not one the registry pins; use a known interpreter or register the script's wrapper`,
					]
				: []),
			...(!interpreter && !(realStat.mode & 0o111) ? ["file is not executable"] : []),
		],
		draft,
	};

	if (out) {
		writeFileSync(out, `${JSON.stringify(draft, null, 2)}\n`);
		report.draft_written = resolve(out);
	}
	return report;
}

/** Validate one recipe without writing anything, for agent iteration. */
/**
 * Learn a recipe shape from ONE real run.
 *
 * Opt-in (`--sample "args"`), because it executes the tool: it runs in a throwaway
 * directory with copies of the input paths it recognised, so the operator's
 * workspace is not touched. It then observes what appeared on disk and maps that
 * back to `argv` + `parameters` + a suggested Oracle.
 *
 * It still cannot invent MEANING: the field it suggests as the success check is a
 * structural guess, so the report says which fields need review.
 */
function scaffold(target, { sample, out = null, timeoutMs = 20000 } = {}) {
	const facts = probe(target);
	const executable = facts.executable;
	const script = facts.script ?? null;
	const prefix = script ? [script] : [];

	const tokens = String(sample).trim().split(/\s+/).filter(Boolean);
	const base = mkdtempSync(join(tmpdir(), "aegis-scaffold-"));
	const workspace = join(base, "workspace");
	mkdirSync(workspace, { recursive: true });

	try {
		// Classify the sample tokens: things that already exist are INPUTS, a path-like
		// token that does not exist yet is the OUTPUT (the tool is being told where to
		// write). Everything else is a flag/value literal and stays as-is.
		const params = {};
		const argv = [...prefix];
		let inIndex = 0;
		let outToken = null;
		for (const token of tokens) {
			const resolved = isAbsolute(token) ? token : resolve(process.cwd(), token);
			if (existsSync(resolved) && lstatSync(resolved).isFile()) {
				inIndex += 1;
				const name = `in${inIndex}`;
				cpSync(resolved, join(workspace, basename(resolved)));
				params[name] = { type: "string", required: true, direction: "in" };
				argv.push(`{${name}}`);
				continue;
			}
			// Output candidate: path-like, not an existing file, and not a flag.
			const pathLike = !token.startsWith("-") && (token.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(token));
			if (!outToken && pathLike && !existsSync(resolved)) {
				outToken = token;
				params.out = { type: "string", required: true, direction: "out" };
				argv.push("{out}");
				continue;
			}
			argv.push(token);
		}

		// Execute with the operator's literal tokens (the placeholders are only for the
		// generated recipe). Input paths were copied, so rewrite them to basenames and
		// keep the output token as the out path inside the temp workspace.
		const runTokens = tokens.map((token) => {
			const resolved = isAbsolute(token) ? token : resolve(process.cwd(), token);
			if (existsSync(resolved) && lstatSync(resolved).isFile()) return basename(resolved);
			if (token === outToken) return "out";
			return token;
		});
		const before = new Set(walkFiles(workspace));
		const run = spawnSync(executable, script ? [script, ...runTokens] : runTokens, {
			cwd: workspace,
			timeout: timeoutMs,
			shell: false,
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
		});
		const after = walkFiles(workspace);
		const created = after.filter((file) => !before.has(file));

		// Pick the likely result: prefer JSON, then non-empty.
		let primary = null;
		let parsed = null;
		for (const file of created) {
			const full = join(workspace, file);
			try {
				const text = readFileSync(full, "utf8");
				if (!text.trim()) continue;
				const asJson = JSON.parse(text);
				if (asJson && typeof asJson === "object") {
					primary = file;
					parsed = asJson;
					break;
				}
			} catch {
				/* not JSON */
			}
			if (!primary) primary = file;
		}

		const review = [];
		if (!primary)
			review.push("no output file appeared: this tool writes to stdout, so it needs a wrapper that writes JSON");
		if (primary && !parsed) review.push(`${primary} is not JSON, so json_post_state cannot check it yet`);
		review.push("description and notes are placeholders");

		const recipe = {
			id: facts.draft.id,
			version: 1,
			description: `Run ${basename(executable)} (TODO: say what it does)`,
			category: "",
			notes: "",
			executable,
			...(script ? { script } : {}),
			argv,
			workspace: "{workspace}",
			parameters: {
				...params,
				...(primary ? { out: { type: "string", required: true, direction: "out" } } : {}),
			},
			verify: primary
				? {
						kind: "json_post_state",
						resource: "out",
						checks: parsed
							? [{ path: Object.keys(parsed)[0] ?? "result", op: "exists" }]
							: [{ path: "result", op: "exists" }],
					}
				: { kind: "json_post_state", resource: "out", checks: [{ path: "result", op: "exists" }] },
		};
		if (!outToken) {
			// No output argument was given, so the tool writes a fixed name. The Oracle can
			// still read it, but the model cannot choose the path: say so.
			review.push(
				`the run wrote ${primary ?? "no file"} without an output argument; add one to argv if the tool supports choosing the path`,
			);
			if (primary) {
				params.out = { type: "string", required: true, direction: "out" };
				// Point the parameter at the fixed name the tool actually produced.
				recipe.parameters = { ...params };
				recipe.argv = [...argv];
				review.push(`verify.resource=out expects the tool to write {out}; the observed name was ${primary}`);
			}
		}

		if (out) writeFileSync(out, `${JSON.stringify(recipe, null, 2)}\n`);
		return {
			executable,
			...(script ? { script } : {}),
			ran_argv: executable === (script ?? executable) ? tokens : [script, ...tokens],
			exit_code: run.status,
			timed_out: Boolean(run.error?.code === "ETIMEDOUT"),
			stdout_excerpt: String(run.stdout ?? "").slice(0, 300),
			stderr_excerpt: String(run.stderr ?? "").slice(0, 300),
			created_files: created,
			primary_output: primary,
			primary_keys:
				parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).slice(0, 10) : null,
			recipe,
			review,
			...(out ? { recipe_written: resolve(out) } : {}),
		};
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
}

/** Every regular file under `dir`, relative to it. */
function walkFiles(dir, acc = [], root = dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walkFiles(full, acc, root);
		else if (entry.isFile()) acc.push(full.slice(root.length + 1));
	}
	return acc;
}

function validateRecipe(recipePath) {
	if (!existsSync(recipePath)) fail(`recipe not found: ${recipePath}`);
	let recipe;
	try {
		recipe = JSON.parse(readFileSync(recipePath, "utf8"));
	} catch (error) {
		fail(`recipe is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const registration = buildRegistration(recipe, { baseDir: dirname(recipePath) });
	return registration;
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) return usage();

	if (options.scaffold) {
		// An empty --sample is valid: some tools take no arguments.
		if (options.sample === null || options.sample === undefined)
			fail('--scaffold needs --sample "<args you would run>" so it can observe a real run');
		const report = scaffold(options.scaffold, { sample: options.sample, out: options.out });
		console.log(JSON.stringify(report, null, 2));
		console.log("\nReview these before registering:");
		for (const item of report.review) console.log(`  - ${item}`);
		console.log("\nThen: --validate <recipe.json>, then --recipe <recipe.json> --roster ~/.Aegis/tools/roster.json");
		return;
	}

	if (options.probe) {
		const report = probe(options.probe, { out: options.out });
		console.log(JSON.stringify(report, null, 2));
		console.log(
			"\nThis is a DRAFT. Fill in description/category/notes/argv/parameters/verify, then run --validate and --recipe.",
		);
		if (report.refusals.length > 0) process.exitCode = 1;
		return;
	}

	if (options.validate) {
		const registration = validateRecipe(options.validate);
		console.log(`valid: ${registration.id}@${registration.version}`);
		console.log(`  argv    ${registration.argv_template.join(" ")}`);
		console.log(`  oracle  ${registration.verify_spec.kind} on ${registration.verify_spec.resource}`);
		return;
	}

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
