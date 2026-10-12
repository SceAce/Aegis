// Offline smoke test for the Aegis contest data pipeline:
//   contest/result.mjs  (manual independent result capture)
//   contest/daily.mjs   (read-only deterministic daily report)
//
// No model, no network, no real provider. All paths are isolated temp dirs.
//
// Run:
//   node Pi_Agent_base/tests/contest-pipeline-smoke.mjs

import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const base = resolve(new URL("..", import.meta.url).pathname);
const resultTool = join(base, "contest", "result.mjs");
const dailyTool = join(base, "contest", "daily.mjs");

let failures = 0;
function check(name, condition, detail) {
	if (condition) {
		console.log(`ok - ${name}`);
	} else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

const temp = await mkdtemp(join(tmpdir(), "aegis-contest-pipeline-"));
const sessions = join(temp, "sessions");
const reports = join(temp, "reports");
await mkdir(sessions, { recursive: true });
const decisions = join(temp, "decisions.jsonl");
const results = join(temp, "results.jsonl");

function runResult(args, env = process.env) {
	return spawnSync(process.execPath, [resultTool, ...args], {
		encoding: "utf8",
		env: { ...env, AEGIS_CONTEST_RESULTS: results },
	});
}
function runDaily(args, env = process.env) {
	return spawnSync(process.execPath, [dailyTool, ...args], {
		encoding: "utf8",
		env: {
			...env,
			AEGIS_CONTEST_LOG: decisions,
			AEGIS_CONTEST_RESULTS: results,
			AEGIS_CONTEST_SESSION_DIR: sessions,
			AEGIS_CONTEST_REPORT_DIR: reports,
		},
	});
}

// --- Seed a decisions log and linked Pi session files (as the extension would). ---
const sessA = join(sessions, "sess-abc.jsonl");
const sessB = join(sessions, "sess-def.jsonl");
await writeFile(
	sessA,
	[
		JSON.stringify({ type: "session", version: 3, id: "sess-abc", timestamp: "2026-10-10T00:00:00Z", cwd: "/tmp" }),
		JSON.stringify({ type: "message", id: "a1", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] } }),
		JSON.stringify({ type: "message", id: "a2", parentId: "a1", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [], isError: true } }),
		JSON.stringify({ type: "message", id: "a3", parentId: "a2", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "read", arguments: {} }] } }),
		JSON.stringify({ type: "message", id: "a4", parentId: "a3", message: { role: "toolResult", toolCallId: "c2", toolName: "read", content: [], isError: false } }),
	].join("\n") + "\n",
);
// sess-def intentionally disagrees with its metadata (JSONL has 1 call / 0
// results, metadata has none) to exercise the cross-check flag. The metadata
// log stays authoritative.
await writeFile(
	sessB,
	JSON.stringify({ type: "message", id: "b1", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "d1", name: "bash", arguments: {} }] } }) + "\n",
);
await writeFile(
	decisions,
	[
		JSON.stringify({ recorded_at: "2026-10-10T10:00:00.000Z", session_id: "sess-abc", session_file: sessA, task_id: "task-007", event: "session_start", mode: "hint" }),
		JSON.stringify({ recorded_at: "2026-10-10T10:00:05.000Z", session_id: "sess-abc", task_id: "task-007", event: "injection_decision", mode: "hint", prompt_section_applied: true, manual_selected: false, injected: "verified-card@3:verified" }),
		JSON.stringify({ recorded_at: "2026-10-10T10:00:09.000Z", session_id: "sess-abc", event: "tool_call", tool_name: "bash", tool_call_id: "c1", input_digest: "sha256:deadbeef" }),
		JSON.stringify({ recorded_at: "2026-10-10T00:00:00Z", session_id: "sess-abc", event: "tool_call", tool_name: "read", tool_call_id: "c2", input_digest: "sha256:cafe" }),
		JSON.stringify({ recorded_at: "2026-10-10T00:00:00Z", session_id: "sess-abc", event: "tool_result", tool_name: "bash", tool_call_id: "c1", is_error: true }),
		JSON.stringify({ recorded_at: "2026-10-10T00:00:00Z", session_id: "sess-abc", event: "tool_result", tool_name: "read", tool_call_id: "c2", is_error: false }),
		JSON.stringify({ recorded_at: "2026-10-10T10:00:12.000Z", session_id: "sess-def", session_file: sessB, task_id: "task-008", event: "session_start", mode: "off" }),
		JSON.stringify({ recorded_at: "2026-10-10T10:00:15.000Z", session_id: "sess-def", task_id: "task-008", event: "injection_decision", mode: "off", prompt_section_applied: false, manual_selected: false, injected: "" }),
	].join("\n") + "\n",
);

// --- result.mjs behaviour ---
const successRun = runResult([
	"add",
	"--task-id", "task-007",
	"--session-id", "sess-abc",
	"--result", "success",
	"--source", "platform",
	"--group", "hint",
	"--card", "verified-card@3",
	"--evidence", "score 100/100",
	"--at", "2026-10-10T11:00:00.000Z",
]);
check("result add success exits 0", successRun.status === 0, successRun.stderr);
const recorded = JSON.parse(successRun.stdout.trim());
check("result row links task and session", recorded.task_id === "task-007" && recorded.session_id === "sess-abc");
check("result row keeps independent=true", recorded.independent === true);
check("result row source recorded", recorded.result_source === "platform");

// Missing --result defaults to unknown (never success).
const defaultRun = runResult(["add", "--task-id", "task-008", "--session-id", "sess-def", "--at", "2026-10-10T11:05:00.000Z"]);
const defaultRow = JSON.parse(defaultRun.stdout.trim());
check("missing --result defaults to unknown", defaultRow.result === "unknown", defaultRow.result);

// Refuses flag/secret-looking evidence.
const flagRun = runResult(["add", "--task-id", "task-009", "--evidence", "flag{do_not_store}"]);
check("result refuses flag-looking evidence", flagRun.status === 2 && /refus/i.test(flagRun.stderr), flagRun.stderr);
const tokenRun = runResult(["add", "--task-id", "task-009", "--notes", "api_key=abcdef123456"]);
check("result refuses token-looking notes", tokenRun.status === 2 && /refus/i.test(tokenRun.stderr), tokenRun.stderr);
const badState = runResult(["add", "--task-id", "task-009", "--result", "maybe"]);
check("result rejects an unknown state", badState.status === 2, badState.stderr);

// success/failure require independent provenance AND an evidence reference.
const noEvidence = runResult(["add", "--task-id", "task-009", "--result", "success", "--source", "platform"]);
check("result refuses success without evidence", noEvidence.status === 2 && /evidence/i.test(noEvidence.stderr), noEvidence.stderr);
const noSource = runResult(["add", "--task-id", "task-009", "--result", "failure", "--source", "model-claim", "--evidence", "the agent said it failed"]);
check("result refuses success/failure from a non-independent source", noSource.status === 2 && /independent/i.test(noSource.stderr), noSource.stderr);
const humanOk = runResult(["add", "--task-id", "task-009b", "--result", "failure", "--source", "human", "--evidence", "reviewed oracle log, no flag returned", "--session-id", "sess-ghi", "--at", "2026-10-10T03:00:00Z"]);
check("result accepts explicit human verification with evidence", humanOk.status === 0, humanOk.stderr);
const humanRow = JSON.parse(humanOk.stdout.trim());
check("human-verified failure is marked independent", humanRow.independent === true);
// unknown without evidence/source is not independent.
const unknownRow = JSON.parse(defaultRun.stdout.trim());
check("unknown result is not marked independent", unknownRow.independent === false, JSON.stringify(unknownRow));

const onDisk = (await readFile(results, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
check("results log stored exactly the three valid rows", onDisk.length === 3, String(onDisk.length));
check("results log contains no flag/secret", !/flag\{|api_key=/.test(JSON.stringify(onDisk)));

// --- daily.mjs behaviour ---
const mtimesBefore = await Promise.all([stat(decisions), stat(results), stat(sessA), stat(sessB)]);
const dailyRun = runDaily(["--date", "2026-10-10", "--deterministic"]);
check("daily report exits 0", dailyRun.status === 0, dailyRun.stderr);
const md = dailyRun.stdout;
check("report has both tasks", md.includes("task-007") && md.includes("task-008"));
check("report shows the injected group and card", /task-007 \| sess-abc \| hint \| verified-card@3/.test(md));
check("report tool counts come from extension metadata", /\| task-007 \| sess-abc \|.*\| 2 \| 2 \|/.test(md), md);
check("report does not flag a count mismatch when JSONL agrees", !/task-007 \| count_mismatch/.test(md));
check("report flags a metadata/JSONL count mismatch", /task-008 \| count_mismatch/.test(md), md);
check("report flags the unknown result as an anomaly", /task-008 \| no_independent_result/.test(md));
check("report lists the human-verified failure as independent", /task-009b \|.*\| failure \| human \| yes \|/.test(md), md);
check("report states read-only", /Read-only report/.test(md));
check("report states independent-result limitation", /independent results log/.test(md));
check("report does not claim statistical validity", /exploratory only/.test(md));

const jsonText = await readFile(join(reports, "2026-10-10.report.json"), "utf8");
const report = JSON.parse(jsonText);
check("json report marks read_only", report.read_only === true);
check("json report has no generated_at in deterministic mode", !("generated_at" in report));
check("json report summary counts success=1 unknown=1 failure=1", report.summary.by_result.success === 1 && report.summary.by_result.unknown === 1 && report.summary.by_result.failure === 1);

// Determinism: byte-identical on a second run.
const dailyRun2 = runDaily(["--date", "2026-10-10", "--deterministic"]);
check("markdown is byte-identical across runs", dailyRun.stdout === dailyRun2.stdout);
const jsonText2 = await readFile(join(reports, "2026-10-10.report.json"), "utf8");
check("json is byte-identical across runs", jsonText === jsonText2);

// Read-only: input mtimes unchanged.
const mtimesAfter = await Promise.all([stat(decisions), stat(results), stat(sessA), stat(sessB)]);
check(
	"daily report did not modify inputs (read-only)",
	mtimesBefore.every((b, i) => b.mtimeMs === mtimesAfter[i].mtimeMs),
);

// An unknown result still carries an explicit source, not a silent success.
check("report labels the unknown result's source explicitly", /task-008 \| sess-def \| off \|.*\| unknown \| human/.test(md));

// --- Scenario 2: group/card from metadata + multi-session attribution --------
// Regression (P0 #3): a hand-filled result must NOT be able to rewrite the
// real experimental group, a wrong card must be flagged, and one success for a
// two-session task must never be copied into a second independent success.
const s2 = join(temp, "scenario2");
const s2sessions = join(s2, "sessions");
const s2reports = join(s2, "reports");
await mkdir(s2sessions, { recursive: true });
const s2decisions = join(s2, "decisions.jsonl");
const s2results = join(s2, "results.jsonl");
const s2sessH1 = join(s2sessions, "sess-h1.jsonl");
const s2sessH2 = join(s2sessions, "sess-h2.jsonl");
await writeFile(
	s2sessH1,
	[
		JSON.stringify({ type: "message", id: "h1a", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] } }),
		JSON.stringify({ type: "message", id: "h1b", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [], isError: true } }),
	].join("\n") + "\n",
);
await writeFile(s2sessH2, JSON.stringify({ type: "session", version: 3, id: "sess-h2", timestamp: "2026-10-11T10:05:00Z" }) + "\n");
await writeFile(
	s2decisions,
	[
		JSON.stringify({ recorded_at: "2026-10-11T10:00:00.000Z", session_id: "sess-h1", session_file: s2sessH1, task_id: "task-020", event: "session_start", mode: "hint", cards_digest: "sha256:abc" }),
		JSON.stringify({ recorded_at: "2026-10-11T10:00:01.000Z", session_id: "sess-h1", task_id: "task-020", event: "injection_decision", mode: "hint", prompt_section_applied: true, manual_selected: false, injected: "verified-card@3:verified" }),
		JSON.stringify({ recorded_at: "2026-10-11T10:00:01.500Z", session_id: "sess-h1", task_id: "task-020", event: "tool_call", tool_name: "bash", tool_call_id: "c1", input_digest: "sha256:x" }),
		JSON.stringify({ recorded_at: "2026-10-11T10:00:02.000Z", session_id: "sess-h1", task_id: "task-020", event: "tool_result", tool_name: "bash", tool_call_id: "c1", is_error: true }),
		JSON.stringify({ recorded_at: "2026-10-11T10:05:00.000Z", session_id: "sess-h2", session_file: s2sessH2, task_id: "task-020", event: "session_start", mode: "off" }),
	].join("\n") + "\n",
);
// One success row attributed to sess-h1, but it LIES about group and card.
await writeFile(
	s2results,
	JSON.stringify({
		recorded_at: "2026-10-11T11:00:00.000Z",
		at: "2026-10-11T11:00:00.000Z",
		task_id: "task-020",
		session_id: "sess-h1",
		group: "off",
		card: "other-card@1",
		result: "success",
		result_source: "platform",
		evidence: "score 1/1",
		independent: true,
	}) + "\n",
);
const s2Run = spawnSync(process.execPath, [dailyTool, "--date", "2026-10-11", "--deterministic"], {
	encoding: "utf8",
	env: {
		...process.env,
		AEGIS_CONTEST_LOG: s2decisions,
		AEGIS_CONTEST_RESULTS: s2results,
		AEGIS_CONTEST_SESSION_DIR: s2sessions,
		AEGIS_CONTEST_REPORT_DIR: s2reports,
	},
});
check("scenario-2 daily report exits 0", s2Run.status === 0, s2Run.stderr);
const s2md = s2Run.stdout;
check("result group does NOT rewrite the metadata group", /task-020 \| sess-h1 \| hint \|/.test(s2md), s2md);
check("metadata group is used for the off session too", /task-020 \| sess-h2 \| off \|/.test(s2md), s2md);
check("mismatched result group is flagged", /task-020 \| group_mismatch/.test(s2md), s2md);
check("mismatched result card is flagged", /task-020 \| card_mismatch/.test(s2md), s2md);
check("multi-session task is visible", /task-020 \| multi_session_task/.test(s2md), s2md);
check("one result is not copied into a second session success", /task-020 \| sess-h2 \| off \|.*\| unknown \|/.test(s2md), s2md);
check("first tool action is surfaced from metadata", /task-020 \| sess-h1 \|.*\| bash \| yes \| 1500 \|/.test(s2md), s2md);
const s2report = JSON.parse(await readFile(join(s2reports, "2026-10-11.report.json"), "utf8"));
check("per-task summary counts unique tasks, not sessions", s2report.summary.tasks === 1 && s2report.summary.sessions === 2, JSON.stringify(s2report.summary));
check("ambiguous multi-session success is not counted as a success", s2report.summary.by_result.success === 0 && s2report.summary.by_result.unknown === 1, JSON.stringify(s2report.summary.by_result));
check("tool calls are split by metadata group", s2report.summary.tool_calls_by_group.hint === 1 && s2report.summary.tool_calls_by_group.off === 0, JSON.stringify(s2report.summary.tool_calls_by_group));

console.log("");
if (failures > 0) {
	console.error(`contest-pipeline-smoke FAILED (${failures} check${failures === 1 ? "" : "s"})`);
	process.exitCode = 1;
} else {
	console.log("contest-pipeline-smoke ok");
}
