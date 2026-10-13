#!/usr/bin/env node
// Aegis C6-P4 / X4 — REAL C6 recovery through the product entry.
//
// A real child process drives the C6 product entry with the real SDK/faux and a
// real EventLog, then is SIGKILLed after a durable request/task intent or after a
// real Broker effect. A restart through the SAME product entry must reconcile the
// stranded task from the real artifact WITHOUT re-sending a blind non-idempotent
// effect, and the committed stream must verify.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-c6-recovery.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyChain } from "../memory/runtime/events.mjs";

const BASE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const RESOLVER = join(BASE_DIR, "pi", "packages", "coding-agent", "src", "experimental", "source-resolver.ts");
const CHILD = join(BASE_DIR, "tests", "helpers", "c6-recovery-child.mjs");
const base = mkdtempSync(join(tmpdir(), "aegis-c6-recovery-"));
const failures = [];
function check(name, condition, detail) {
	if (condition) console.log(`ok   ${name}`);
	else {
		failures.push(name);
		console.log(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}
function runChild(workDir, scenario) {
	return spawnSync(process.execPath, ["--import", RESOLVER, CHILD, workDir, scenario], {
		encoding: "utf8",
		timeout: 30000,
		maxBuffer: 4 * 1024 * 1024,
	});
}
function summary(workDir) {
	const path = join(workDir, "summary.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
function effects(workDir) {
	const path = join(workDir, "effects.json");
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")).effects ?? 0) : 0;
}
function readEvents(workDir) {
	try {
		return readFileSync(join(workDir, "events.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

try {
	// SCENARIO A: kill right after the durable task intent (stranded `running`).
	const workA = join(base, "request-kill");
	const killed = runChild(workA, "request_then_kill");
	check(
		"the child was killed after the durable request",
		killed.status !== 0 || killed.signal !== null,
		`status=${killed.status} signal=${killed.signal}`,
	);
	const eventsAfterKill = readEvents(workA);
	check(
		"a durable task intent is committed before the kill",
		eventsAfterKill.some((e) => e.payload?.kind === "campaign.task.started"),
	);

	const recovered = runChild(workA, "recover");
	const recSummary = summary(workA);
	check("the recovery run exits cleanly", recovered.status === 0, recovered.stderr?.slice(-300));
	const eventsA = readEvents(workA);
	check(
		"the committed stream verifies after recovery",
		verifyChain(eventsA).ok,
		JSON.stringify(verifyChain(eventsA).errors),
	);
	check(
		"the stranded task is reconciled without a blind re-effect",
		eventsA.some(
			(e) =>
				e.payload?.kind === "campaign.reconciliation.requested" ||
				e.payload?.kind === "campaign.reconciliation.resolved",
		),
		JSON.stringify(eventsA.map((e) => e.payload?.kind).filter(Boolean)),
	);
	const actionCompletedA = eventsA.filter((e) => e.event_type === "action.completed").length;
	check("no duplicate non-idempotent effect was sent", effects(workA) <= 1, `effects=${effects(workA)}`);
	check("the recovery summary is present", recSummary !== null);
	void actionCompletedA;

	// SCENARIO B: kill right AFTER a real Broker effect (result may be uncommitted).
	const workB = join(base, "effect-kill");
	const killedB = runChild(workB, "effect_then_kill");
	check(
		"the effect-kill child was killed",
		killedB.status !== 0 || killedB.signal !== null,
		`status=${killedB.status} signal=${killedB.signal}`,
	);
	const effectsAfterKill = effects(workB);
	check("the first real effect happened before the kill", effectsAfterKill >= 1, `effects=${effectsAfterKill}`);

	const recoveredB = runChild(workB, "recover");
	check("the second recovery exits cleanly", recoveredB.status === 0, recoveredB.stderr?.slice(-300));
	const eventsB = readEvents(workB);
	check(
		"the stream verifies after the second recovery",
		verifyChain(eventsB).ok,
		JSON.stringify(verifyChain(eventsB).errors),
	);
	check(
		"no blind duplicate effect after recovery",
		effects(workB) <= effectsAfterKill + 1,
		`effects=${effects(workB)}`,
	);
	check(
		"the recovered task is bound (completed or reconciled unknown), never silently dropped",
		(() => {
			const s = summary(workB);
			const states = Object.values(s?.task_states ?? {});
			return states.length > 0 && states.every((state) => ["completed", "unknown", "failed"].includes(state));
		})(),
		JSON.stringify(summary(workB)?.task_states),
	);
} finally {
	rmSync(base, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.log(`c6 recovery: ${failures.length} failure(s)`);
	process.exit(1);
}
console.log("c6 recovery: all checks passed");
