#!/usr/bin/env node
// Aegis E1 — real SDK + faux observable planning through the product entry.
//
// Drives a real subprocess (real Pi SDK + faux + real EventLog + real
// Broker/Oracle) that starts from a Manifest containing ONLY the root goal and
// the planning task. The model submits a complete candidate plan via the
// structured `aegis_submit_plan` tool; the Host validates + admits it as ONE
// durable batch; the Scheduler runs the dynamic tasks by depends_on.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-e1-planning-chain.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildE1View } from "../observation/e1-observation.mjs";
import { verifyChain } from "../shared/events.mjs";

const BASE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const RESOLVER = join(BASE_DIR, "pi", "packages", "coding-agent", "src", "experimental", "source-resolver.ts");
const CHILD = join(BASE_DIR, "tests", "helpers", "c6-e1-planning-child.mjs");
const base = mkdtempSync(join(tmpdir(), "aegis-e1-planning-chain-"));
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
		timeout: 60000,
		maxBuffer: 16 * 1024 * 1024,
	});
}
function summary(workDir, scenario) {
	const path = join(workDir, `summary-${scenario}.json`);
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
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

try {
	// --- Scenario 1: a legal plan is admitted and executed by dependency -------
	const normalDir = join(base, "normal");
	const normalRun = runChild(normalDir, "normal_plan");
	check("the normal planning run exits cleanly", normalRun.status === 0, normalRun.stderr?.slice(-800));
	const normal = summary(normalDir, "normal_plan");
	check("the summary is present", normal !== null);
	check(
		"the plan batch was admitted",
		normal?.plan_kinds?.includes("campaign.plan.admitted"),
		JSON.stringify(normal?.plan_kinds),
	);
	check("the plan-ready gate fired separately", normal?.plan_ready === true);
	check(
		"the model actually created three dynamic tasks",
		(normal?.admitted_task_ids ?? []).length >= 3,
		JSON.stringify(normal?.admitted_task_ids),
	);
	check(
		"one task depends on two prerequisites",
		(normal?.admitted_depends?.["dyn-c"] ?? []).length === 2,
		JSON.stringify(normal?.admitted_depends),
	);
	check(
		"business tasks completed",
		["completed"].includes(normal?.task_states?.["dyn-a"]) &&
			["completed"].includes(normal?.task_states?.["dyn-b"]) &&
			["completed"].includes(normal?.task_states?.["dyn-c"]),
		JSON.stringify(normal?.task_states),
	);
	check(
		"the real file was repaired",
		normal?.dataset?.name === "Ada" && normal?.dataset?.status === "active",
		JSON.stringify(normal?.dataset),
	);
	check("the Broker really produced effects", (normal?.broker_effects ?? 0) >= 3, `effects=${normal?.broker_effects}`);
	const normalEvents = readEvents(normalDir);
	check(
		"the committed stream verifies",
		verifyChain(normalEvents).ok,
		JSON.stringify(verifyChain(normalEvents).errors),
	);

	// The planning task ran exactly once and each dynamic task started once.
	const starts = normalEvents.filter((e) => e.payload?.kind === "campaign.task.started").map((e) => e.payload.task_id);
	check(
		"each task started exactly once",
		starts.filter((id) => id === "dyn-c").length === 1 && starts.filter((id) => id === "dyn-a").length === 1,
		JSON.stringify(starts),
	);
	// The dependency order held: dyn-c started AFTER dyn-a and dyn-b completed.
	const order = normalEvents
		.filter((e) => ["campaign.task.started", "campaign.task.completed"].includes(e.payload?.kind))
		.map((e) => `${e.payload.kind}:${e.payload.task_id}`);
	const cStart = order.indexOf("campaign.task.started:dyn-c");
	check(
		"the diamond successor started after both prerequisites completed",
		cStart > order.indexOf("campaign.task.completed:dyn-a") && cStart > order.indexOf("campaign.task.completed:dyn-b"),
		JSON.stringify(order),
	);

	// The observations page/API rebuild the SAME graph from the committed stream.
	const manifest = JSON.parse(readFileSync(join(normalDir, "manifest.json"), "utf8"));
	const view = buildE1View({ manifest, events: normalEvents });
	check(
		"the task graph rebuilds from the committed stream",
		view.task_graph.counts.tasks >= 4,
		JSON.stringify(view.task_graph.counts),
	);
	const tc = view.task_graph.nodes.find((n) => n.task_id === "dyn-c");
	check(
		"the multi-prerequisite edge survives the graph rebuild",
		(tc?.depends_on ?? []).length === 2,
		JSON.stringify(tc?.depends_on),
	);
	check("the board exposes board nodes with content", view.board.nodes.length > 0);

	// --- Scenario 2: one illegal node rejects the WHOLE batch ------------------
	const illegalDir = join(base, "illegal");
	const illegalRun = runChild(illegalDir, "illegal_plan");
	check("the illegal planning run exits cleanly", illegalRun.status === 0, illegalRun.stderr?.slice(-800));
	const illegal = summary(illegalDir, "illegal_plan");
	check(
		"the illegal batch was blocked",
		illegal?.plan_kinds?.includes("campaign.plan.blocked"),
		JSON.stringify(illegal?.plan_kinds),
	);
	check("no plan was admitted", !illegal?.plan_kinds?.includes("campaign.plan.admitted"));
	check("no dynamic task was created", (illegal?.admitted_task_ids ?? []).length === 0);
	const illegalStates = Object.entries(illegal?.task_states ?? {});
	check(
		"no legal subset ran",
		illegalStates.filter(([id]) => id !== "task-plan").every(([, state]) => state !== "completed"),
		JSON.stringify(illegal?.task_states),
	);
	check(
		"the legal sibling did not produce an effect",
		(illegal?.broker_effects ?? 0) === 0,
		`effects=${illegal?.broker_effects}`,
	);
	check(
		"the file is untouched after a rejected batch",
		illegal?.dataset?.name === "??",
		JSON.stringify(illegal?.dataset),
	);

	// --- Scenario 3: a restart after completion does not repeat the chain ------
	const restartDir = join(base, "restart");
	check("the first run exits cleanly", runChild(restartDir, "normal_plan").status === 0);
	const before = summary(restartDir, "normal_plan");
	const secondRun = runChild(restartDir, "restart");
	check("the restart run exits cleanly", secondRun.status === 0, secondRun.stderr?.slice(-800));
	const after = summary(restartDir, "restart");
	check(
		"the restart does not re-run completed tasks",
		(after?.broker_effects ?? 0) === 0,
		`restart effects=${after?.broker_effects}`,
	);
	check(
		"the restart preserves the repaired file",
		after?.dataset?.name === "Ada" && after?.dataset?.status === "active",
	);
	check(
		"the restart preserves the task states",
		after?.task_states?.["dyn-c"] === "completed",
		JSON.stringify(after?.task_states),
	);
	void before;
} finally {
	rmSync(base, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.log(`c6 e1 planning chain: ${failures.length} failure(s)`);
	process.exit(1);
}
console.log("c6 e1 planning chain: all checks passed");
