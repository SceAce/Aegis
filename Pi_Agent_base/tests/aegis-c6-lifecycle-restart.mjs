#!/usr/bin/env node
// Aegis C6 request-lifecycle REAL process restart.
//
// A real child process drives the product entry with the real SDK/faux until the
// provider gate has persisted a durable `reserved` request, then is SIGKILLed
// before the request settles. A second real run through the SAME entry must:
//   * keep the durable budget responsibility (pending hold),
//   * refuse a blind re-dispatch (0 provider calls),
//   * not dispatch a Broker effect, and
//   * mark the stranded task unknown/reconciliation, with a verifying stream.
//
// A second scenario fails the provider so the worker persists a durable
// reconciliation record; the restart must treat it as unresolved too.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-c6-lifecycle-restart.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyChain } from "../memory/runtime/events.mjs";

const BASE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const RESOLVER = join(BASE_DIR, "pi", "packages", "coding-agent", "src", "experimental", "source-resolver.ts");
const CHILD = join(BASE_DIR, "tests", "helpers", "c6-lifecycle-child.mjs");
const base = mkdtempSync(join(tmpdir(), "aegis-c6-lifecycle-restart-"));
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
		maxBuffer: 8 * 1024 * 1024,
	});
}
function readEvents(workDir) {
	try {
		return readFileSync(join(workDir, "events.jsonl"), "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}
function summary(workDir, scenario) {
	const path = join(workDir, `summary-${scenario}.json`);
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
function requestRecords(events) {
	return events.filter((event) => event.payload?.kind === "c6.request").map((event) => event.payload);
}

try {
	// --- Scenario 1: killed after a durable reservation ---------------------
	const killDir = join(base, "kill-after-reserved");
	const killed = runChild(killDir, "kill_after_reserved");
	check(
		"the child is killed before the request settles",
		killed.status !== 0 || killed.signal !== null,
		`status=${killed.status} signal=${killed.signal}`,
	);
	const eventsAfterKill = readEvents(killDir);
	const reservedAfterKill = requestRecords(eventsAfterKill).filter((payload) => payload.phase === "reserved");
	check(
		"a durable reservation exists before the kill",
		reservedAfterKill.length >= 1,
		JSON.stringify(reservedAfterKill),
	);
	const killedRequestId = reservedAfterKill[0]?.request_id ?? null;
	check(
		"the reservation names a request and both sides",
		Boolean(killedRequestId) &&
			Boolean(reservedAfterKill[0]?.task_reservation_id) &&
			Boolean(reservedAfterKill[0]?.campaign_reservation_id),
	);
	check(
		"nothing was settled for the killed request",
		requestRecords(eventsAfterKill).every((payload) => payload.phase !== "committed"),
		JSON.stringify(requestRecords(eventsAfterKill).map((payload) => payload.phase)),
	);

	const killedRecover = runChild(killDir, "recover");
	check("the restart run exits cleanly", killedRecover.status === 0, killedRecover.stderr?.slice(-500));
	const killSummary = summary(killDir, "recover");
	check("the restart summary is present", killSummary !== null);
	check(
		"the restart sends NO provider request (no blind re-send)",
		killSummary?.providerCalls === 0,
		`providerCalls=${killSummary?.providerCalls}`,
	);
	check(
		"the unresolved request is retained and blocks dispatch",
		(killSummary?.reconciliation?.unresolved_requests ?? 0) >= 1 && killSummary?.reconciliation?.blocked === true,
		JSON.stringify(killSummary?.reconciliation),
	);
	check(
		"the Campaign ledger keeps the pending budget hold",
		(killSummary?.ledger?.pending_reservations?.length ?? 0) >= 1,
		JSON.stringify(killSummary?.ledger?.pending_reservations),
	);
	check(
		"no Broker effect is dispatched on restart",
		killSummary?.brokerEffects === 0,
		`brokerEffects=${killSummary?.brokerEffects}`,
	);
	check(
		"the stranded task is not reported completed",
		!["completed"].includes(killSummary?.task_states?.["task-001"]),
		JSON.stringify(killSummary?.task_states),
	);
	const eventsAfterRecover = readEvents(killDir);
	check(
		"the stranded task is surfaced through the reconciliation path",
		eventsAfterRecover.some((event) => String(event.payload?.kind ?? "").startsWith("campaign.reconciliation")) ||
			(killSummary?.task_unknown ?? 0) >= 1,
		JSON.stringify(eventsAfterRecover.map((event) => event.payload?.kind).filter(Boolean)),
	);
	check(
		"the killed request was never silently settled",
		requestRecords(eventsAfterRecover).every(
			(payload) => payload.phase !== "committed" || payload.request_id !== killedRequestId,
		),
		JSON.stringify(requestRecords(eventsAfterRecover).map((payload) => [payload.request_id, payload.phase])),
	);
	check(
		"the stream verifies after the restart",
		verifyChain(eventsAfterRecover).ok,
		JSON.stringify(verifyChain(eventsAfterRecover).errors),
	);

	// --- Scenario 2: a provider error is charged once and never re-dispatched -
	const errorDir = join(base, "provider-error");
	const errored = runChild(errorDir, "provider_error");
	check("the provider-error run exits cleanly", errored.status === 0, errored.stderr?.slice(-500));
	const errorEvents = readEvents(errorDir);
	const errorRecords = requestRecords(errorEvents);
	check(
		"the provider error wrote a durable settlement marked as an error",
		errorRecords.some((payload) => payload.phase === "committed" && payload.provider_status === "error"),
		JSON.stringify(errorRecords.map((payload) => [payload.phase, payload.provider_status])),
	);
	const errorSummary = summary(errorDir, "provider_error");
	check(
		"the provider error leaves no pending hold (the request was settled)",
		(errorSummary?.ledger?.pending_reservations?.length ?? -1) === 0,
		JSON.stringify(errorSummary?.ledger?.pending_reservations),
	);
	check(
		"the first error run really called the provider once",
		errorSummary?.providerCalls === 1,
		`providerCalls=${errorSummary?.providerCalls}`,
	);
	check(
		"the dispatched provider request is charged exactly once",
		errorSummary?.ledger?.consumed?.model_requests === 1,
		JSON.stringify(errorSummary?.ledger?.consumed),
	);
	check(
		"the provider error never enters the Broker",
		errorSummary?.brokerEffects === 0,
		`brokerEffects=${errorSummary?.brokerEffects}`,
	);
	check(
		"the provider-error task is unknown, not completed",
		errorSummary?.task_states?.["task-001"] === "unknown",
		JSON.stringify(errorSummary?.task_states),
	);

	const errorRecover = runChild(errorDir, "recover");
	check("the provider-error restart exits cleanly", errorRecover.status === 0, errorRecover.stderr?.slice(-500));
	const errorRecoverSummary = summary(errorDir, "recover");
	check(
		"the provider-error task is not auto-retried on restart",
		errorRecoverSummary?.providerCalls === 0,
		`providerCalls=${errorRecoverSummary?.providerCalls}`,
	);
	check("the unknown task dispatches no Broker effect on restart", errorRecoverSummary?.brokerEffects === 0);
} finally {
	rmSync(base, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.log(`c6 lifecycle restart: ${failures.length} failure(s)`);
	process.exit(1);
}
console.log("c6 lifecycle restart: all checks passed");
