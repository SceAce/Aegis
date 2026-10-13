// Aegis C6-F — registered, read-only external test runner.
//
// The code-repair Oracle decides success by running an EXTERNAL test file that
// lives in the workspace but is NOT the model's write target. This module runs
// it as a real child process with the registered interpreter, captures the real
// exit code and output, and reports the pass/fail counts. It NEVER lets the
// model supply the command, the argv or the test.
//
// Honest boundary: the workspace is not an OS sandbox; the test file is trusted
// HOST input and the model's target is a different file.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { digest } from "../fixture/contracts.mjs";

export const REGISTERED_TEST_VERSION = "1.0.0";

/**
 * Run a registered test file inside the workspace. Returns the REAL observed
 * result. A missing test file is a harness error (unknown), never a pass.
 *
 * @param {{workspaceRoot: string, testFile?: string, nodePath?: string, timeoutMs?: number}} args
 * @returns {{ok: boolean, passed: number|null, failed: number|null, detail: string, exit_code: number|null, test_digest: string|null}}
 */
export function runRegisteredTest(
	{ workspaceRoot, testFile = "check.mjs", nodePath = process.execPath, timeoutMs = 10000 } = /** @type {any} */ ({}),
) {
	const absolute = resolve(workspaceRoot, testFile);
	if (!existsSync(absolute)) {
		return {
			ok: false,
			passed: null,
			failed: null,
			detail: `registered test not found: ${testFile}`,
			exit_code: null,
			test_digest: null,
		};
	}
	const testDigest = digest(readFileSync(absolute, "utf8"));
	const result = spawnSync(nodePath, [absolute], {
		cwd: workspaceRoot,
		timeout: timeoutMs,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const exitCode = typeof result.status === "number" ? result.status : null;
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	// The test prints a machine-readable summary line; the exit code is the
	// authority for pass/fail (a printed claim is not).
	const summary = /PASSED=(\d+)\s+FAILED=(\d+)/.exec(output);
	const passed = summary ? Number(summary[1]) : null;
	const failed = summary ? Number(summary[2]) : null;
	const ok = exitCode === 0 && (failed === null || failed === 0);
	return {
		ok,
		passed,
		failed,
		exit_code: exitCode,
		test_digest: testDigest,
		detail: ok ? "registered test passed" : `registered test failed (exit=${String(exitCode)}): ${output.slice(-400)}`,
	};
}
