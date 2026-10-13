// Aegis C6-F — registered, read-only external test runner.
//
// The code-repair Oracle decides success by running an EXTERNAL test file that
// lives in the workspace but is NOT the model's write target. This module runs
// it as a real child process through a HOST-OWNED harness.
//
// Why a harness: a bare `node check.mjs` trusts `process.exit(0)`. A target
// module that ends the process before the test's assertions run would look like
// a pass. The harness therefore:
//   1. verifies the registered test's identity (digest) BEFORE running;
//   2. imports the test module and only writes the result AFTER the import
//      resolves (i.e. the whole test body ran) — an early `process.exit` in the
//      imported target resolves nothing and yields NO result (unknown);
//   3. records the assertion count the trusted harness actually observed, so a
//      "PASSED" string the target could print is never the pass condition.
//
// Honest boundary: the workspace is not an OS sandbox; the test file is trusted
// HOST input and the model's target is a different file.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { digest } from "../fixture/contracts.mjs";

export const REGISTERED_TEST_VERSION = "2.0.0";

/**
 * The Host-owned harness source. It is written to a directory OUTSIDE the
 * model's writable target so the model can neither read nor rewrite it. It
 * imports the registered test and writes a completion record only after the
 * import resolves.
 *
 * @param {string} testAbsolute
 * @param {string} resultPath
 * @returns {string}
 */
function harnessSource(testAbsolute, resultPath) {
	return [
		'import { writeFileSync } from "node:fs";',
		`const RESULT = ${JSON.stringify(resultPath)};`,
		`const TEST = ${JSON.stringify(testAbsolute)};`,
		"let assertions = 0;",
		"let written = false;",
		"const write = (record) => {",
		"  if (written) return;",
		"  written = true;",
		"  try { writeFileSync(RESULT, JSON.stringify(record)); } catch {}",
		"};",
		"const assertMod = await import('node:assert');",
		"const strict = assertMod.strict;",
		"const wrap = (fn) => (...args) => { assertions += 1; return fn(...args); };",
		"for (const target of [assertMod.default, strict]) {",
		"  for (const key of Object.keys(target)) {",
		"    if (typeof target[key] === 'function') target[key] = wrap(target[key]);",
		"  }",
		"}",
		"const realExit = process.exit.bind(process);",
		"process.exit = (code) => {",
		"  const exitCode = Number.isInteger(code) ? code : 0;",
		"  const stack = String(new Error().stack || '');",
		"  const frame = stack.split('\\n')[2] || '';",
		// Attribute the exit to the IMMEDIATE caller. A legitimate test calls
		// process.exit from its OWN module; an imported target that ends the run
		// early calls it from a different file -> unknown.
		"  const legitimate = frame.includes(TEST) || frame.includes(RESULT.replace(/result\\.json$/, ''));",
		"  if (legitimate) {",
		"    write({ complete: true, passed: assertions, failed: exitCode === 0 ? 0 : 1, assertions, error: null });",
		"  } else {",
		"    write({ complete: false, passed: null, failed: null, assertions, error: 'process.exit was raised outside the registered test (an imported module ended the run early)' });",
		"  }",
		"  realExit(exitCode);",
		"};",
		"try {",
		"  await import(TEST);",
		"  write({ complete: true, passed: assertions, failed: 0, assertions, error: null });",
		"} catch (error) {",
		"  write({ complete: true, passed: Math.max(0, assertions - 1), failed: 1, assertions, error: String(error && error.message ? error.message : error) });",
		"}",
		"",
	].join("\n");
}

/**
 * Run a registered test file inside the workspace through the Host harness.
 * Returns the REAL observed result. A missing test file, an early process exit,
 * or a missing completion record is a harness error (unknown), never a pass.
 *
 * @param {{
 *   workspaceRoot: string,
 *   testFile?: string,
 *   nodePath?: string,
 *   timeoutMs?: number,
 *   expectedTestDigest?: string|null,
 *   harnessDir?: string|null,
 * }} args
 * @returns {{
 *   ok: boolean, passed: number|null, failed: number|null, complete: boolean,
 *   assertions: number|null, detail: string, exit_code: number|null,
 *   test_digest: string|null, test_identity_ok: boolean, forged_output: boolean,
 * }}
 */
export function runRegisteredTest(
	{
		workspaceRoot,
		testFile = "check.mjs",
		nodePath = process.execPath,
		timeoutMs = 10000,
		expectedTestDigest = null,
		harnessDir = null,
	} = /** @type {any} */ ({}),
) {
	const unknown = (detail, extra = {}) => ({
		ok: false,
		passed: null,
		failed: null,
		complete: false,
		assertions: null,
		detail,
		exit_code: null,
		test_digest: null,
		test_identity_ok: false,
		forged_output: false,
		...extra,
	});
	const absolute = resolve(workspaceRoot, testFile);
	if (!existsSync(absolute)) return unknown(`registered test not found: ${testFile}`);
	const testDigest = digest(readFileSync(absolute, "utf8"));
	if (typeof expectedTestDigest === "string" && expectedTestDigest && testDigest !== expectedTestDigest) {
		return unknown("registered test identity changed before execution", {
			test_digest: testDigest,
			test_identity_ok: false,
		});
	}

	// The harness + result live OUTSIDE the target workspace so the model's write
	// target cannot read or replace them.
	const runtimeDir = harnessDir ?? join(dirname(absolute), "..", `.aegis-harness-${process.pid}-${Date.now()}`);
	mkdirSync(runtimeDir, { recursive: true });
	const harnessPath = join(runtimeDir, "registered-test-harness.mjs");
	const resultPath = join(runtimeDir, "result.json");
	writeFileSync(harnessPath, harnessSource(absolute, resultPath), "utf8");
	try {
		rmSync(resultPath, { force: true });
		const result = spawnSync(nodePath, [harnessPath], {
			cwd: workspaceRoot,
			timeout: timeoutMs,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const exitCode = typeof result.status === "number" ? result.status : null;
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		const signaled = Boolean(result.signal);
		// The completion record is the ONLY pass condition. Its absence (early
		// process exit, timeout, crash before the import resolves) is UNKNOWN.
		let record = null;
		try {
			record = JSON.parse(readFileSync(resultPath, "utf8"));
		} catch {
			record = null;
		}
		if (!record || record.complete !== true) {
			return unknown(
				`registered test produced no complete result (exit=${String(exitCode)}${signaled ? `, signal=${result.signal}` : ""}); the acceptance assertions were not confirmed`,
				{ exit_code: exitCode, test_digest: testDigest, test_identity_ok: true, forged_output: /PASSED=/.test(output) },
			);
		}
		// A printed PASSED line is not the authority; the harness's own assertion
		// count is. If the output claims a pass but the harness recorded no
		// completion, forged_output is already set; here the record IS complete.
		const failed = Number.isInteger(record.failed) ? record.failed : 1;
		const passed = Number.isInteger(record.passed) ? record.passed : null;
		const ok = failed === 0 && exitCode === 0 && passed !== null;
		return {
			ok,
			passed,
			failed,
			complete: true,
			assertions: Number.isInteger(record.assertions) ? record.assertions : null,
			test_digest: testDigest,
			test_identity_ok: true,
			forged_output: false,
			exit_code: exitCode,
			detail: ok
				? `registered test completed ${passed} assertion(s) and passed`
				: `registered test failed after ${String(record.assertions ?? "?")} assertion(s) (exit=${String(exitCode)}): ${record.error ?? output.slice(-300)}`,
		};
	} finally {
		rmSync(runtimeDir, { recursive: true, force: true });
	}
}
