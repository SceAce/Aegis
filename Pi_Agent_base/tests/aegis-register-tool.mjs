// Registering a tool and letting the model discover it.
//
// Two halves of the same gap:
//   * a human needs ONE command that computes digests and validates the
//     registration against the real gate (aegis-register-tool.mjs);
//   * the model needs to SEE what is registered before calling aegis_execute,
//     otherwise it has to guess an action id and its parameter names.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { createScriptRegistry } from "../execution/script-registry.mjs";

const REGISTER = new URL("../../aegis-register-tool.mjs", import.meta.url).pathname;

function run(args, { cwd } = {}) {
	return spawnSync(process.execPath, [REGISTER, ...args], {
		encoding: "utf8",
		timeout: 60_000,
		...(cwd ? { cwd } : {}),
	});
}

/** A working solver script + recipe, in a temp dir. */
function fixture() {
	const base = mkdtempSync(join(tmpdir(), "aegis-reg-"));
	const workspace = join(base, "workspace");
	mkdirSync(workspace, { recursive: true });
	const script = join(base, "solve.mjs");
	writeFileSync(
		script,
		[
			"#!/usr/bin/env node",
			'import { writeFileSync } from "node:fs";',
			"const [out, a, b] = process.argv.slice(2);",
			"writeFileSync(out, JSON.stringify({ sum: Number(a) + Number(b), verified: true }));",
		].join("\n"),
		"utf8",
	);
	const recipe = join(base, "recipe.json");
	writeFileSync(
		recipe,
		JSON.stringify(
			{
				id: "demo-add",
				version: 1,
				description: "add two integers and record the result",
				executable: process.execPath,
				script,
				argv: ["{script}", "{out}", "{a}", "{b}"],
				workspace,
				parameters: {
					out: { type: "string", required: true, direction: "out" },
					a: { type: "string", required: true },
					b: { type: "string", required: true },
				},
				verify: {
					kind: "json_post_state",
					resource: "out",
					checks: [{ path: "verified", op: "eq", value: true }],
				},
			},
			null,
			2,
		),
		"utf8",
	);
	return {
		base,
		workspace,
		script,
		recipe,
		roster: join(base, "roster.json"),
		cleanup: () => rmSync(base, { recursive: true, force: true }),
	};
}

test("registering a recipe computes digests and writes a valid roster", () => {
	const f = fixture();
	try {
		const result = run(["--recipe", f.recipe, "--roster", f.roster]);
		assert.equal(result.status, 0, result.stderr);

		const roster = JSON.parse(readFileSync(f.roster, "utf8"));
		assert.equal(roster.scripts.length, 1);
		const entry = roster.scripts[0];
		assert.equal(entry.id, "demo-add");
		assert.equal(entry.description, "add two integers and record the result");
		assert.match(entry.executable_digest, /^sha256:[0-9a-f]{64}$/);
		assert.match(entry.script_digest, /^sha256:[0-9a-f]{64}$/);
		assert.equal(entry.script_path, f.script);
		assert.deepEqual(entry.argv_template, [f.script, "{out}", "{a}", "{b}"]);

		// The real gate must accept it, and the Oracle must be callable.
		const registry = createScriptRegistry(roster);
		assert.equal(registry.configured, true);
		assert.equal(typeof registry.get("demo-add", 1).verify, "function");
		assert.equal(registry.describe()[0].description, entry.description);
	} finally {
		f.cleanup();
	}
});

test("the registry description is what the model sees, so it must be present", () => {
	const f = fixture();
	try {
		assert.equal(run(["--recipe", f.recipe, "--roster", f.roster]).status, 0);
		const listed = run(["--list", "--roster", f.roster]);
		assert.equal(listed.status, 0, listed.stderr);
		assert.match(listed.stdout, /demo-add@1/);
		assert.match(listed.stdout, /add two integers/);
		assert.match(listed.stdout, /out, a, b/);
	} finally {
		f.cleanup();
	}
});

test("the compiled Oracle re-reads the real output and rejects a wrong one", () => {
	const f = fixture();
	try {
		assert.equal(run(["--recipe", f.recipe, "--roster", f.roster]).status, 0);
		const registry = createScriptRegistry(JSON.parse(readFileSync(f.roster, "utf8")));
		const registration = registry.get("demo-add", 1);
		const outPath = join(f.workspace, "out.json");

		writeFileSync(outPath, JSON.stringify({ sum: 5, verified: true }), "utf8");
		assert.equal(registration.verify({ observed: { resource_bindings: { out: outPath } } }).ok, true);

		writeFileSync(outPath, JSON.stringify({ sum: 5, verified: false }), "utf8");
		const stale = registration.verify({ observed: { resource_bindings: { out: outPath } } });
		assert.equal(stale.ok, false);
		assert.match(stale.reason, /does not satisfy the checks/);

		rmSync(outPath);
		assert.match(
			registration.verify({ observed: { resource_bindings: { out: outPath } } }).reason,
			/could not re-read/,
		);
	} finally {
		f.cleanup();
	}
});

test("a shell executable or an eval token is refused", () => {
	const f = fixture();
	try {
		const recipe = JSON.parse(readFileSync(f.recipe, "utf8"));
		writeFileSync(f.recipe, JSON.stringify({ ...recipe, executable: "/bin/sh" }), "utf8");
		const shell = run(["--recipe", f.recipe, "--roster", f.roster]);
		assert.equal(shell.status, 2);
		assert.match(shell.stderr, /shell interpreters are not allowed/);

		writeFileSync(f.recipe, JSON.stringify({ ...recipe, argv: ["{script}", "-e", "{out}"] }), "utf8");
		const evalToken = run(["--recipe", f.recipe, "--roster", f.roster]);
		assert.equal(evalToken.status, 2);
		assert.match(evalToken.stderr, /forbidden eval\/shell token/);
	} finally {
		f.cleanup();
	}
});

test("shell metacharacters in the argv are refused", () => {
	const f = fixture();
	try {
		const recipe = JSON.parse(readFileSync(f.recipe, "utf8"));
		writeFileSync(f.recipe, JSON.stringify({ ...recipe, argv: ["{script}", "{out}", "a|b"] }), "utf8");
		const result = run(["--recipe", f.recipe, "--roster", f.roster]);
		assert.equal(result.status, 2);
		assert.match(result.stderr, /shell metacharacters/);
	} finally {
		f.cleanup();
	}
});

test("an interpreter registration needs a pinned script", () => {
	const f = fixture();
	try {
		const recipe = JSON.parse(readFileSync(f.recipe, "utf8"));
		const { script, ...withoutScript } = recipe;
		assert.equal(script, f.script);
		writeFileSync(f.recipe, JSON.stringify(withoutScript), "utf8");
		const result = run(["--recipe", f.recipe, "--roster", f.roster]);
		assert.equal(result.status, 2);
		assert.match(result.stderr, /needs recipe.script/);
	} finally {
		f.cleanup();
	}
});

test("re-registering the same id@version replaces it; a new version is added", () => {
	const f = fixture();
	try {
		assert.equal(run(["--recipe", f.recipe, "--roster", f.roster]).status, 0);
		const recipe = JSON.parse(readFileSync(f.recipe, "utf8"));
		writeFileSync(f.recipe, JSON.stringify({ ...recipe, description: "updated" }), "utf8");
		assert.equal(run(["--recipe", f.recipe, "--roster", f.roster]).status, 0);
		let roster = JSON.parse(readFileSync(f.roster, "utf8"));
		assert.equal(roster.scripts.length, 1, "same id@version is replaced, not duplicated");
		assert.equal(roster.scripts[0].description, "updated");

		writeFileSync(f.recipe, JSON.stringify({ ...recipe, version: 2 }), "utf8");
		assert.equal(run(["--recipe", f.recipe, "--roster", f.roster]).status, 0);
		roster = JSON.parse(readFileSync(f.roster, "utf8"));
		assert.equal(roster.scripts.length, 2, "a new version is a separate entry");
		assert.deepEqual(
			roster.scripts.map((s) => s.version),
			[1, 2],
		);
	} finally {
		f.cleanup();
	}
});

test("a changed script body is detected because the digest is pinned", () => {
	const f = fixture();
	try {
		assert.equal(run(["--recipe", f.recipe, "--roster", f.roster]).status, 0);
		const before = JSON.parse(readFileSync(f.roster, "utf8")).scripts[0].script_digest;
		writeFileSync(f.script, "// changed\n", "utf8");
		assert.equal(run(["--recipe", f.recipe, "--roster", f.roster]).status, 0);
		const after = JSON.parse(readFileSync(f.roster, "utf8")).scripts[0].script_digest;
		assert.notEqual(after, before, "re-registering pins the new body");
	} finally {
		f.cleanup();
	}
});

test("--dry-run validates but writes nothing", () => {
	const f = fixture();
	try {
		const result = run(["--recipe", f.recipe, "--roster", f.roster, "--dry-run"]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(f.roster), false);
		assert.match(result.stdout, /dry run: would add/);
	} finally {
		f.cleanup();
	}
});

test("--list on a missing roster reports zero tools instead of failing", () => {
	const f = fixture();
	try {
		const result = run(["--list", "--roster", join(f.base, "absent.json")]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /no registered tools/);
	} finally {
		f.cleanup();
	}
});

test("--probe reports facts and writes a draft without guessing argv or Oracle", () => {
	const f = fixture();
	try {
		const draft = join(f.base, "draft.json");
		const result = run(["--probe", f.script, "--out", draft]);
		assert.equal(result.status, 0, result.stderr);
		const report = JSON.parse(result.stdout.slice(0, result.stdout.indexOf("\n\nThis is a DRAFT")));
		assert.equal(report.kind.startsWith("script ("), true, report.kind);
		assert.match(report.executable_digest, /^sha256:[0-9a-f]{64}$/);
		assert.match(report.script_digest, /^sha256:[0-9a-f]{64}$/);
		assert.deepEqual(report.refusals, []);

		// The draft is a starting point, not a registration: the Oracle and argv are
		// placeholders a human replaces.
		const written = JSON.parse(readFileSync(draft, "utf8"));
		assert.equal(written.description, "");
		assert.deepEqual(written.argv, ["{script}", "{out}"]);
		assert.equal(written.verify.kind, "json_post_state");

		// And it must NOT already pass validation with those placeholders.
		const before = run(["--validate", draft]);
		assert.notEqual(before.status, 0, "a placeholder draft must not validate as-is");
	} finally {
		f.cleanup();
	}
});

test("--probe resolves /usr/bin/env shebangs to the real interpreter", () => {
	const f = fixture();
	try {
		const py = join(f.base, "tool.py");
		writeFileSync(py, "#!/usr/bin/env python3\nprint('hi')\n", "utf8");
		const result = run(["--probe", py]);
		assert.equal(result.status, 0, result.stderr);
		const report = JSON.parse(result.stdout.slice(0, result.stdout.indexOf("\n\nThis is a DRAFT")));
		assert.notEqual(report.executable, "/usr/bin/env", "env must not be the pinned executable");
		assert.match(basename(report.executable), /^python/);
	} finally {
		f.cleanup();
	}
});

test("--probe flags a shell as unregisterable", () => {
	const result = run(["--probe", "/bin/sh"]);
	const report = JSON.parse(result.stdout.slice(0, result.stdout.indexOf("\n\nThis is a DRAFT")));
	assert.equal(result.status, 1, "a refusal must be non-zero");
	assert.ok(
		report.refusals.some((r) => /shell interpreter/.test(r)),
		JSON.stringify(report.refusals),
	);
});

test("--validate accepts a complete recipe and refuses an incomplete one", () => {
	const f = fixture();
	try {
		const ok = run(["--validate", f.recipe]);
		assert.equal(ok.status, 0, ok.stderr);
		assert.match(ok.stdout, /valid: demo-add@1/);

		const recipe = JSON.parse(readFileSync(f.recipe, "utf8"));
		writeFileSync(f.recipe, JSON.stringify({ ...recipe, verify: undefined }), "utf8");
		const bad = run(["--validate", f.recipe]);
		assert.equal(bad.status, 2);
		assert.match(bad.stderr, /verify\(\) or verify_spec/);
		assert.equal(existsSync(f.roster), false, "--validate writes nothing");
	} finally {
		f.cleanup();
	}
});

test("callable metadata is carried, bounded and surfaced", () => {
	const f = fixture();
	try {
		const recipe = JSON.parse(readFileSync(f.recipe, "utf8"));
		writeFileSync(
			f.recipe,
			JSON.stringify({
				...recipe,
				category: "general",
				notes: "不要用于浮点加法",
				examples: [{ arguments: { a: "1", b: "2", out: "sum.json" }, note: "整数相加" }],
				timeout_ms: 5000,
				risk_class: "low",
			}),
			"utf8",
		);
		assert.equal(run(["--recipe", f.recipe, "--roster", f.roster]).status, 0);
		const registry = createScriptRegistry(JSON.parse(readFileSync(f.roster, "utf8")));
		const described = registry.describe()[0];
		assert.equal(described.category, "general");
		assert.equal(described.notes, "不要用于浮点加法");
		assert.deepEqual(described.examples, [{ arguments: { a: "1", b: "2", out: "sum.json" }, note: "整数相加" }]);
		assert.equal(described.risk_class, "low");
	} finally {
		f.cleanup();
	}
});

test("malformed metadata is refused at registration", () => {
	const f = fixture();
	try {
		const recipe = JSON.parse(readFileSync(f.recipe, "utf8"));
		for (const patch of [
			{ notes: "x".repeat(501) },
			{ examples: [{ arguments: "nope" }] },
			{ timeout_ms: 0 },
			{ risk_class: "extreme" },
			{ category: "x".repeat(41) },
		]) {
			writeFileSync(f.recipe, JSON.stringify({ ...recipe, ...patch }), "utf8");
			const result = run(["--recipe", f.recipe, "--roster", f.roster]);
			assert.equal(result.status, 2, `expected refusal for ${JSON.stringify(patch).slice(0, 40)}`);
		}
	} finally {
		f.cleanup();
	}
});
