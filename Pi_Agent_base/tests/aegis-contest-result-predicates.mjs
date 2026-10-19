// The independent result import may carry structured when/expect predicates so
// a solved task can later compile a procedure Experience. Shape is validated
// here; truth still comes from the two-proof compiler gate.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resultToOutcome } from "../contest/outcome-bridge.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "contest", "result.mjs");
const WHEN = [{ path: "env.kind", op: "eq", value: "ctf", verified_by: ["platform:score"] }];
const EXPECT = [{ path: "flag.found", op: "eq", value: true }];
const SCOPE = {
	environment_fingerprint: "local",
	domain: "ctf-web",
	permissions: ["workspace"],
	task_types: ["ctf"],
};

function run(env, args) {
	return spawnSync(process.execPath, [SCRIPT, "add", ...args], { encoding: "utf8", env });
}

test("a platform result carries structured when/expect into the Outcome", () => {
	const root = mkdtempSync(join(tmpdir(), "aegis-result-predicates-"));
	const env = { ...process.env, AEGIS_CONTEST_RESULTS: join(root, "results.jsonl") };
	try {
		const result = run(env, [
			"--task-id",
			"task-1",
			"--session-id",
			"session-1",
			"--result",
			"success",
			"--source",
			"platform",
			"--evidence",
			"platform score 100",
			"--scope",
			JSON.stringify(SCOPE),
			"--when",
			JSON.stringify(WHEN),
			"--expect",
			JSON.stringify(EXPECT),
		]);
		assert.equal(result.status, 0, result.stderr);
		const row = JSON.parse(readFileSync(env.AEGIS_CONTEST_RESULTS, "utf8").trim());
		assert.deepEqual(row.scope, SCOPE);
		assert.deepEqual(row.when, WHEN);
		assert.deepEqual(row.expect, EXPECT);
		const outcome = resultToOutcome(row);
		assert.deepEqual(outcome.scope, SCOPE);
		assert.deepEqual(outcome.when, WHEN);
		assert.deepEqual(outcome.expect, EXPECT);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("malformed or unverified predicates are refused without writing", () => {
	const root = mkdtempSync(join(tmpdir(), "aegis-result-predicates-"));
	const env = { ...process.env, AEGIS_CONTEST_RESULTS: join(root, "results.jsonl") };
	const base = [
		"--task-id",
		"task-1",
		"--result",
		"success",
		"--source",
		"platform",
		"--evidence",
		"platform score 100",
	];
	try {
		for (const args of [
			[...base, "--when", "not-json"],
			[...base, "--when", JSON.stringify([{ path: "env.kind", op: "eq", value: "ctf" }])],
			[...base, "--when", JSON.stringify([{ path: "env.kind", op: "eq", verified_by: ["x"] }])],
			[...base, "--expect", JSON.stringify([])],
			[...base, "--scope", JSON.stringify({ environment_fingerprint: "local" })],
			[...base, "--scope", JSON.stringify({ ...SCOPE, unknown: true })],
		]) {
			const result = run(env, args);
			assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
		}
		assert.throws(() => readFileSync(env.AEGIS_CONTEST_RESULTS, "utf8"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
