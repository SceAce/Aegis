// JSON roster: the script registry may be a flat JSON list whose Oracle is data.
//
// A `.mjs` config can hold a `verify()` function, which makes it hard to scan and
// impossible to diff in a review. A roster records the same facts as data:
//
//   { "scripts": [ { ..., "verify_spec": { "kind": "json_post_state",
//       "resource": "out", "checks": [{ "path": "stage", "op": "eq", "value": "done" }] } } ] }
//
// The compiled Oracle still re-reads the real post-state from disk: it never
// trusts stdout, an exit code, or a caller's claim.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	compileVerifySpec,
	createScriptRegistry,
	executableDigest,
	validateScriptRegistration,
	validateVerifySpec,
} from "../execution/script-registry.mjs";

const SPEC = { kind: "json_post_state", resource: "out", checks: [{ path: "stage", op: "eq", value: "done" }] };

function roster(overrides = {}) {
	const base = mkdtempSync(join(tmpdir(), "aegis-roster-"));
	const workspace = join(base, "workspace");
	mkdirSync(workspace, { recursive: true });
	const scriptPath = join(base, "solve.mjs");
	writeFileSync(
		scriptPath,
		'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], JSON.stringify({ stage: "done" }));\n',
	);
	const registration = {
		schema_version: "1.0",
		id: "common-modulus",
		version: 1,
		executable: process.execPath,
		executable_digest: executableDigest(process.execPath),
		script_path: scriptPath,
		script_digest: executableDigest(scriptPath),
		argv_template: [scriptPath, "{out}"],
		allowed_root: workspace,
		cwd: workspace,
		parameters: { out: { type: "string", required: true, direction: "out" } },
		verify_spec: SPEC,
		...overrides,
	};
	return { base, registration, workspace, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("a JSON roster registration validates without a verify() function", () => {
	const env = roster();
	try {
		const review = validateScriptRegistration(env.registration);
		assert.equal(review.ok, true, review.reasons.join("; "));
	} finally {
		env.cleanup();
	}
});

test("the registry compiles the declarative Oracle into a callable verify", () => {
	const env = roster();
	try {
		const registry = createScriptRegistry({ scripts: [env.registration] });
		const registration = registry.get("common-modulus", 1);
		assert.equal(typeof registration.verify, "function");
		assert.equal(registration.verify_spec.kind, "json_post_state", "the roster data is preserved");
	} finally {
		env.cleanup();
	}
});

test("the compiled Oracle re-reads the bound post-state and passes only when it matches", () => {
	const env = roster();
	try {
		const verify = compileVerifySpec(SPEC);
		const outPath = join(env.workspace, "out.json");

		writeFileSync(outPath, JSON.stringify({ stage: "done" }));
		const ok = verify({ observed: { resource_bindings: { out: outPath } } });
		assert.equal(ok.ok, true, ok.reason);

		writeFileSync(outPath, JSON.stringify({ stage: "pending" }));
		const stale = verify({ observed: { resource_bindings: { out: outPath } } });
		assert.equal(stale.ok, false);
		assert.match(stale.reason, /does not satisfy the checks/);
		assert.deepEqual(stale.observed, { stage: "pending" });
	} finally {
		env.cleanup();
	}
});

test("the compiled Oracle refuses to guess when the output is missing or unreadable", () => {
	const verify = compileVerifySpec(SPEC);
	assert.match(verify({}).reason, /no bound "out" output to re-read/);
	assert.match(verify({ observed: { resource_bindings: {} } }).reason, /no bound "out"/);
	const missing = verify({ observed: { resource_bindings: { out: "/nonexistent/out.json" } } });
	assert.equal(missing.ok, false);
	assert.match(missing.reason, /could not re-read/);
});

test("the Oracle ignores stdout and exit-code style claims", () => {
	const env = roster();
	try {
		const verify = compileVerifySpec(SPEC);
		const outPath = join(env.workspace, "out.json");
		writeFileSync(outPath, JSON.stringify({ stage: "pending" }));
		// A caller asserting success changes nothing: only the re-read state counts.
		const result = verify({
			observed: { resource_bindings: { out: outPath }, stdout: "done", exit_code: 0, ok: true, status: "success" },
		});
		assert.equal(result.ok, false, "stdout/exit code must not satisfy the Oracle");
	} finally {
		env.cleanup();
	}
});

test("invalid verify_spec values are refused with reasons", () => {
	assert.equal(validateVerifySpec({ kind: "guess", resource: "out", checks: [] }).ok, false);
	assert.match(
		validateVerifySpec({ kind: "json_post_state", resource: "", checks: [] }).reasons.join(" "),
		/resource is required/,
	);
	assert.match(
		validateVerifySpec({ kind: "json_post_state", resource: "out", checks: [] }).reasons.join(" "),
		/non-empty/,
	);
	assert.match(
		validateVerifySpec({ kind: "json_post_state", resource: "out", checks: [{ path: "x", op: "bogus" }] }).reasons.join(
			" ",
		),
		/op is unsupported/,
	);
});

test("declaring both verify() and verify_spec is refused", () => {
	const env = roster({ verify: () => ({ ok: true }) });
	try {
		const review = validateScriptRegistration(env.registration);
		assert.equal(review.ok, false);
		assert.match(review.reasons.join(" "), /either verify\(\) or verify_spec/);
	} finally {
		env.cleanup();
	}
});

test("a registration with neither Oracle is still refused", () => {
	const env = roster({ verify_spec: undefined });
	try {
		const review = validateScriptRegistration(env.registration);
		assert.equal(review.ok, false);
		assert.match(review.reasons.join(" "), /verify\(\) or verify_spec/);
	} finally {
		env.cleanup();
	}
});

test("a roster file is plain JSON that round-trips", () => {
	const env = roster();
	try {
		const text = JSON.stringify({ scripts: [env.registration] }, null, 2);
		const parsed = JSON.parse(text);
		assert.equal(parsed.scripts[0].verify_spec.kind, "json_post_state");
		const registry = createScriptRegistry({ scripts: parsed.scripts });
		assert.equal(registry.get("common-modulus", 1) !== null, true);
	} finally {
		env.cleanup();
	}
});
