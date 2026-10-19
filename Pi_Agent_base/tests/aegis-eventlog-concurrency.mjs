#!/usr/bin/env node
// EventLog cross-writer regression.
//
// A stale EventLog instance used to choose prev_event_digest from the snapshot
// it opened, so a second Pi session could fork the chain. This suite proves:
//   * two instances opened before any writes serialize and adopt each other's tail;
//   * separate OS processes sharing one log produce one valid hash chain and one
//     monotonic per-episode sequence;
//   * the temporary lock file is released.
//
// Run: node Pi_Agent_base/tests/aegis-eventlog-concurrency.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventLog } from "../shared/events.mjs";

const failures = [];
async function test(name, fn) {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (error) {
		failures.push({ name, error });
		console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const root = mkdtempSync(join(tmpdir(), "aegis-eventlog-concurrency-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const child = fileURLToPath(new URL("./helpers/eventlog-concurrent-child.mjs", import.meta.url));

function runChild(logPath, prefix, count) {
	return new Promise((resolve, reject) => {
		const proc = spawn(process.execPath, [child, logPath, prefix, String(count)], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		proc.on("error", reject);
		proc.on("exit", (code, signal) => resolve({ code, signal, stderr }));
	});
}

await test("two stale instances adopt each other's tail instead of forking the chain", async () => {
	const logPath = join(root, "stale-instances", "events.jsonl");
	const first = new EventLog(logPath);
	const second = new EventLog(logPath);
	assert.equal((await first.open()).ok, true);
	assert.equal((await second.open()).ok, true);
	// Both have lastDigest === undefined at this point. Serialized appends must
	// still produce one chain.
	for (let index = 0; index < 4; index += 1) {
		const writer = index % 2 === 0 ? first : second;
		const result = await writer.append({
			event_type: "runtime.note",
			episode_id: "episode-stale",
			payload: { kind: "stale-writer", index },
		});
		assert.equal(result.ok, true, result.error);
	}
	const verifier = new EventLog(logPath);
	const opened = await verifier.open();
	assert.equal(opened.ok, true, opened.error);
	assert.equal(verifier.replay().length, 4);
	assert.deepEqual(
		verifier.replay().map((event) => event.sequence),
		[0, 1, 2, 3],
	);
	assert.equal(existsSync(`${logPath}.lock`), false, "lock must be released");
	await first.close();
	await second.close();
});

await test("an orphaned lock from a vanished writer is recovered", async () => {
	const logPath = join(root, "orphan-lock", "events.jsonl");
	mkdirSync(join(root, "orphan-lock"), { recursive: true });
	writeFileSync(
		`${logPath}.lock`,
		JSON.stringify({ token: "orphan", pid: 999999, host: "remote-test-host", at: Date.now() - 60_000 }),
	);
	const log = new EventLog(logPath);
	assert.equal((await log.open()).ok, true);
	const appended = await log.append({ event_type: "runtime.note", payload: { kind: "after-orphan-lock" } });
	assert.equal(appended.ok, true, appended.error);
	assert.equal(existsSync(`${logPath}.lock`), false, "orphan lock must be replaced and released");
	await log.close();
});

await test("separate processes sharing one log produce a valid chain and sequence", async () => {
	const logPath = join(root, "processes", "events.jsonl");
	const writers = 3;
	const perWriter = 12;
	const results = await Promise.all(
		Array.from({ length: writers }, (_, index) => runChild(logPath, `writer-${index}`, perWriter)),
	);
	for (const [index, result] of results.entries()) {
		assert.equal(result.signal, null, `writer ${index} signal ${result.signal}`);
		assert.equal(result.code, 0, `writer ${index} exit ${result.code}: ${result.stderr}`);
	}
	const verifier = new EventLog(logPath);
	const opened = await verifier.open();
	assert.equal(opened.ok, true, opened.error);
	const rows = verifier.replay();
	assert.equal(rows.length, writers * perWriter);
	assert.deepEqual(
		rows.map((event) => event.sequence),
		Array.from({ length: writers * perWriter }, (_, index) => index),
	);
	const observed = new Set(rows.map((event) => `${event.payload.prefix}:${event.payload.index}`));
	assert.equal(observed.size, writers * perWriter, "every writer's rows must survive");
	assert.equal(existsSync(`${logPath}.lock`), false, "lock must be released");
});

console.log("");
if (failures.length > 0) {
	console.log(`eventlog concurrency: ${failures.length} failure(s)`);
	for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error?.message ?? failure.error}`);
	process.exit(1);
}
console.log("eventlog concurrency: all assertions passed");
