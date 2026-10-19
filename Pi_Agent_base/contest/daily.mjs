#!/usr/bin/env node
// Aegis contest — daily read-only deterministic review report.
//
// This tool READS ONLY. It never writes to the decision log, the results log,
// or any Pi session, and it never promotes experiences or edits cards. It joins
// the Aegis metadata log and the independent results log into one deterministic
// CSV/Markdown + JSON report. Tool activity counts come from the extension's
// own `tool_call`/`tool_result` metadata rows (authoritative); Pi session JSONL
// is read only as an optional cross-check that flags `count_mismatch`.
//
// Group is derived ONLY from recorded `session_start`/`injection_decision`
// metadata, never from a hand-filled result row. A result's `group`/`card` are
// kept for cross-checking and mismatches are reported (`group_mismatch`,
// `card_mismatch`). A single result is never copied onto two sessions of a
// multi-session task as two independent successes; ambiguous cases stay
// `unknown` and are flagged. Per-task counts are reported separately from the
// number of sessions, and per-task first tool action is surfaced.
//
// Determinism: given the same inputs and the same --date, the outputs are byte
// identical. Rows are sorted; no wall-clock time is injected except through the
// report's own `generated_at`, which can be disabled with --deterministic.
//
// Usage:
//   node Pi_Agent_base/contest/daily.mjs [--date YYYY-MM-DD] [--outdir <dir>]
//                                        [--deterministic] [--format md|json|both]
//   node Pi_Agent_base/contest/daily.mjs --help
//
// Env:
//   AEGIS_CONTEST_LOG        decisions JSONL (default: ~/.Aegis/runtime/contest/decisions.jsonl)
//   AEGIS_CONTEST_RESULTS    results JSONL   (default: ~/.Aegis/runtime/contest/results.jsonl)
//   AEGIS_CONTEST_SESSION_DIR Pi session dir (default: ~/.Aegis/sessions)
//   AEGIS_CONTEST_REPORT_DIR report output   (default: ~/.Aegis/runtime/contest/reports)

import { mkdir, readFile, stat, writeFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { projectBoard } from "../memory/board.mjs";
import { projectState } from "../memory/state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = resolve(HERE, "..");
const AEGIS_HOME = process.env.AEGIS_HOME || join(process.env.HOME || BASE_DIR, ".Aegis");

// Reports may quote task evidence; keep NEW report files owner-only.
process.umask(0o077);

function envPath(name, fallback) {
	const value = process.env[name];
	return value && value.trim() ? value : fallback;
}

const DECISIONS_PATH = envPath("AEGIS_CONTEST_LOG", join(AEGIS_HOME, "runtime", "contest", "decisions.jsonl"));
const RESULTS_PATH = envPath("AEGIS_CONTEST_RESULTS", join(AEGIS_HOME, "runtime", "contest", "results.jsonl"));
const SESSION_DIR = envPath("AEGIS_CONTEST_SESSION_DIR", join(AEGIS_HOME, "sessions"));
const REPORT_DIR = envPath("AEGIS_CONTEST_REPORT_DIR", join(AEGIS_HOME, "runtime", "contest", "reports"));
// Task-scoped runtime audit dir written by the launcher: one events.jsonl per
// task. The daily report reads it ONLY to surface stage activity and the current
// effective Outcome view; it never re-derives a competing "truth" and never
// promotes anything.
const TASK_RUNTIME_DIR = envPath("AEGIS_CONTEST_TASK_DIR", join(AEGIS_HOME, "runtime", "contest", "tasks"));

function usage() {
	return `Aegis contest daily read-only review report

Usage:
  daily.mjs [--date YYYY-MM-DD] [--outdir <dir>] [--deterministic] [--format md|json|both]

Options:
  --date <YYYY-MM-DD>  report day (matches the "at"/"recorded_at" date prefix).
                       Default: the latest date seen in the inputs.
  --outdir <dir>       output directory (default: ${REPORT_DIR})
  --deterministic      omit generated_at so output is byte-stable
  --format <f>         md | json | both (default: both)

Reads (never writes):
  decisions: ${DECISIONS_PATH}
  results:   ${RESULTS_PATH}
  sessions:  ${SESSION_DIR}

Group is taken from recorded session/injection metadata, never from a
hand-filled result row. Result rows with an explicit group/card are only used
to cross-check and flag mismatches. This report is read-only: it does not
modify cards, logs, sessions, or the experience library, and it never promotes
a card to verified.
`;
}

function parseArgs(argv) {
	const flags = {};
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (!token.startsWith("--")) return { error: `unexpected argument: ${token}` };
		const key = token.slice(2);
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) {
			flags[key] = true;
		} else {
			flags[key] = value;
			i += 1;
		}
	}
	return { flags };
}

function dayOf(value) {
	if (typeof value !== "string") return null;
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
	return match ? match[1] : null;
}

async function readJsonl(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return { rows: [], missing: true };
	}
	const rows = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			rows.push(JSON.parse(trimmed));
		} catch {
			rows.push({ __parse_error: true, __raw_length: trimmed.length });
		}
	}
	return { rows, missing: false };
}

// Optional, best-effort CROSS-CHECK of Pi session JSONL. It is NOT the source
// of truth: the extension's own `tool_call`/`tool_result` metadata rows are the
// authoritative activity counts. Pi's session format is versioned and can
// change, so we only report what we can read and never guess. Any disagreement
// is surfaced as `count_mismatch` rather than silently replacing the metadata.
async function sessionCrossCheck(sessionFile) {
	if (!sessionFile || typeof sessionFile !== "string") return null;
	let text;
	try {
		text = await readFile(sessionFile, "utf8");
	} catch {
		return { session_file: sessionFile, present: false };
	}
	let toolCalls = 0;
	let toolResults = 0;
	let readable = true;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			readable = false;
			continue;
		}
		if (entry?.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role === "toolResult") toolResults += 1;
		if (role === "assistant") {
			const content = Array.isArray(entry.message.content) ? entry.message.content : [];
			for (const block of content) {
				if (block?.type === "toolCall") toolCalls += 1;
			}
		}
	}
	return { session_file: sessionFile, present: true, readable, tool_calls: toolCalls, tool_results: toolResults };
}

function csvEscape(value) {
	const s = value === null || value === undefined ? "" : String(value);
	if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
	return s;
}

const RESULT_STATES = new Set(["success", "failure", "unknown"]);
const INDEPENDENT_SOURCES = new Set(["platform", "human"]);

function timeKey(row) {
	const at = typeof row.at === "string" ? row.at : "";
	if (!Number.isNaN(Date.parse(at))) return at;
	const recorded = typeof row.recorded_at === "string" ? row.recorded_at : "";
	return recorded;
}

/** Parse a card reference such as "id@rev" / "id@rev:status" into id + revision. */
function cardRef(value) {
	const s = value === null || value === undefined ? "" : String(value).trim();
	if (!s) return { id: "", rev: null, ref: "" };
	const m = /^([^@\s:]+)(?:@([^:\s]+))?/.exec(s);
	if (!m) return { id: s, rev: null, ref: s };
	return { id: m[1], rev: m[2] ?? null, ref: m[2] ? `${m[1]}@${m[2]}` : m[1] };
}

/** Parse the extension's `injected` summary "id@rev:status, id2@rev2:status". */
function injectedCardRefs(value) {
	if (typeof value !== "string" || !value.trim()) return [];
	const refs = [];
	for (const segment of value.split(",")) {
		const s = segment.trim();
		if (!s) continue;
		const ref = cardRef(s);
		if (ref.id) refs.push(ref);
	}
	return refs;
}

/**
 * Resolve the independent result for a set of rows without losing facts.
 *  - multiple rows are all kept; the latest VALID result is shown,
 *  - disagreement sets `conflict` (never silently overwritten),
 *  - success/failure without an independent source or evidence is flagged and
 *    the row is NOT treated as independent,
 *  - missing rows resolve to `unknown`.
 */
function resolveRows(rowsInput) {
	const rows = [...rowsInput];
	if (rows.length === 0) {
		return { result: "unknown", source: "(none recorded)", evidence: null, independent: false, card: null, group: null, conflict: false, missingEvidence: false };
	}
	const valid = rows.filter((row) => RESULT_STATES.has(row.result));
	const states = new Set(valid.map((row) => row.result));
	const conflict = states.size > 1;
	// Latest by provided timestamp; ties broken deterministically by the raw
	// result text so the output never depends on file order alone.
	const sorted = [...valid].sort((a, b) => {
		const ta = timeKey(a);
		const tb = timeKey(b);
		if (ta !== tb) return ta < tb ? -1 : 1;
		return String(a.result).localeCompare(String(b.result));
	});
	const latest = sorted.length > 0 ? sorted[sorted.length - 1] : rows[rows.length - 1];
	const source = typeof latest.result_source === "string" && latest.result_source ? latest.result_source.toLowerCase() : "(none recorded)";
	const evidence = typeof latest.evidence === "string" && latest.evidence ? latest.evidence : null;
	const result = RESULT_STATES.has(latest.result) ? latest.result : "unknown";
	const independent =
		INDEPENDENT_SOURCES.has(source) && evidence !== null && latest.independent !== false;
	const missingEvidence = (result === "success" || result === "failure") && (!independent || !evidence);
	return {
		result,
		source,
		evidence,
		independent,
		card: latest.card ?? null,
		group: latest.group ?? null,
		conflict,
		missingEvidence,
	};
}

/** Group label from recorded metadata modes only. */
function groupOf(session) {
	const modes = [...session.modes].sort();
	if (modes.length === 0) return "unknown";
	if (modes.length === 1) return modes[0];
	return modes.join("+");
}

/** First tool call for a session with matched-result error flag and offset. */
function firstToolInfo(session) {
	const calls = session.toolEvents.filter((event) => event.kind === "call");
	if (calls.length === 0) return { name: "", error: null, offset_ms: null };
	calls.sort((a, b) => {
		const ta = Date.parse(a.at ?? "");
		const tb = Date.parse(b.at ?? "");
		if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta - tb;
		return 0;
	});
	const first = calls[0];
	const result = session.toolEvents.find((event) => event.kind === "result" && event.id === first.id);
	const base = session.startedAt ?? session.firstInjectionAt ?? null;
	let offset = null;
	if (base && first.at) {
		const diff = Date.parse(first.at) - Date.parse(base);
		if (!Number.isNaN(diff)) offset = diff;
	}
	return { name: first.name ?? "", error: result ? result.is_error === true : null, offset_ms: offset };
}

async function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(usage());
		return 0;
	}
	const { flags, error } = parseArgs(argv);
	if (error) {
		process.stderr.write(`error: ${error}\n\n${usage()}`);
		return 2;
	}
	const format = typeof flags.format === "string" ? flags.format : "both";
	if (!["md", "json", "both"].includes(format)) {
		process.stderr.write("error: --format must be md, json, or both\n");
		return 2;
	}
	const outdir = typeof flags.outdir === "string" ? flags.outdir : REPORT_DIR;
	const deterministic = flags.deterministic === true;

	const decisions = await readJsonl(DECISIONS_PATH);
	const results = await readJsonl(RESULTS_PATH);

	// Determine target day if not supplied: latest day across both inputs.
	let targetDate = typeof flags.date === "string" ? flags.date : null;
	if (targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
		process.stderr.write("error: --date must be YYYY-MM-DD\n");
		return 2;
	}
	if (!targetDate) {
		const days = [];
		for (const row of decisions.rows) days.push(dayOf(row.at ?? row.recorded_at));
		for (const row of results.rows) days.push(dayOf(row.at ?? row.recorded_at));
		const valid = days.filter(Boolean).sort();
		targetDate = valid.length > 0 ? valid[valid.length - 1] : new Date().toISOString().slice(0, 10);
	}

	const dayDecisions = decisions.rows.filter((row) => dayOf(row.at ?? row.recorded_at) === targetDate);
	const dayResults = results.rows.filter((row) => dayOf(row.at ?? row.recorded_at) === targetDate);

	// --- Join by task_id, then session_id. Deduplicate. ---
	const tasks = new Map(); // task_id -> { task_id, sessions:Map, decisions:[], results:[], ambiguousResults:[], anomalies:[] }

	function taskEntry(taskId) {
		const key = taskId || "(no-task-id)";
		if (!tasks.has(key)) {
			tasks.set(key, { task_id: key, sessions: new Map(), decisions: [], results: [], ambiguousResults: [], anomalies: [] });
		}
		return tasks.get(key);
	}

	function newSession(sid, sessionFile) {
		return {
			session_id: sid,
			session_file: sessionFile ?? null,
			modes: new Set(),
			injections: 0,
			nonmatches: 0,
			manual_selected: false,
			injectedCardRefs: new Set(),
			injectedCardIds: new Set(),
			startedAt: null,
			firstInjectionAt: null,
			cardsDigest: null,
			// Authoritative activity counts from the extension metadata log.
			toolCalls: 0,
			toolResults: 0,
			toolEvents: [],
			// Result rows attributed to THIS session (never copied across sessions).
			results: [],
			resolved: null,
			// Optional Pi session JSONL cross-check (never overrides metadata).
			crossToolCalls: null,
			crossToolResults: null,
			countMismatch: false,
			crossUnreadable: false,
		};
	}

	const sessionTask = new Map();
	for (const row of dayDecisions) {
		if (row.__parse_error) continue;
		if (row.task_id && row.session_id && !sessionTask.has(row.session_id)) {
			sessionTask.set(row.session_id, row.task_id);
		}
	}
	for (const row of dayResults) {
		if (row.__parse_error) continue;
		if (row.task_id && row.session_id && !sessionTask.has(row.session_id)) {
			sessionTask.set(row.session_id, row.task_id);
		}
	}
	const sessionFileById = new Map();
	for (const row of dayDecisions) {
		if (row.__parse_error) continue;
		if (row.session_id && row.session_file) sessionFileById.set(row.session_id, row.session_file);
	}

	// --- Decisions: sessions, modes, injections, and AUTHORITATIVE tool counts. ---
	for (const row of dayDecisions) {
		if (row.__parse_error) {
			taskEntry("(unparseable)").anomalies.push("unparseable decision log line");
			continue;
		}
		const taskId = row.task_id || (row.session_id ? sessionTask.get(row.session_id) : null);
		if (!taskId) continue;
		const entry = taskEntry(taskId);
		const sid = row.session_id || "(no-session-id)";
		if (!entry.sessions.has(sid)) {
			entry.sessions.set(sid, newSession(sid, sessionFileById.get(sid) ?? row.session_file ?? null));
		}
		const session = entry.sessions.get(sid);
		if (row.session_file) session.session_file = row.session_file;
		entry.decisions.push(row);
		if (row.event === "session_start") {
			if (row.mode) session.modes.add(row.mode);
			if (!session.startedAt && typeof row.recorded_at === "string") session.startedAt = row.recorded_at;
			if (row.cards_digest) session.cardsDigest = row.cards_digest;
		}
		if (row.event === "injection_decision") {
			if (row.prompt_section_applied === true) session.injections += 1;
			else session.nonmatches += 1;
			if (row.manual_selected) session.manual_selected = true;
			if (!session.firstInjectionAt && typeof row.recorded_at === "string") session.firstInjectionAt = row.recorded_at;
			for (const ref of injectedCardRefs(row.injected)) {
				session.injectedCardRefs.add(ref.ref);
				session.injectedCardIds.add(ref.id);
			}
			if (Number.isNaN(Date.parse(row.recorded_at ?? ""))) entry.anomalies.push("decision missing valid recorded_at");
		}
		if (row.event === "tool_call") {
			session.toolCalls += 1;
			session.toolEvents.push({ kind: "call", name: row.tool_name ?? null, id: row.tool_call_id ?? null, at: row.recorded_at ?? null });
		}
		if (row.event === "tool_result") {
			session.toolResults += 1;
			session.toolEvents.push({ kind: "result", id: row.tool_call_id ?? null, is_error: row.is_error === true, at: row.recorded_at ?? null });
		}
	}

	// --- Results: keep ALL rows (never silently overwrite earlier facts). ---
	for (const row of dayResults) {
		if (row.__parse_error) {
			taskEntry("(unparseable)").anomalies.push("unparseable results log line");
			continue;
		}
		const taskId = row.task_id || (row.session_id ? sessionTask.get(row.session_id) : null);
		if (!taskId) continue;
		const entry = taskEntry(taskId);
		entry.results.push(row);
		if (row.session_id && !entry.sessions.has(row.session_id)) {
			entry.sessions.set(row.session_id, newSession(row.session_id, sessionFileById.get(row.session_id) ?? null));
		}
	}

	// --- Attribute each result row to exactly one session; never fan it out. ---
	for (const entry of tasks.values()) {
		const sessions = [...entry.sessions.values()];
		for (const row of entry.results) {
			if (row.session_id && entry.sessions.has(row.session_id)) {
				entry.sessions.get(row.session_id).results.push(row);
			} else if (!row.session_id && sessions.length === 1) {
				sessions[0].results.push(row);
			} else {
				entry.ambiguousResults.push(row);
			}
		}
		for (const session of sessions) session.resolved = resolveRows(session.results);
	}

	// --- Compute report rows, using extension metadata for tool activity. ---
	const rows = [];
	for (const entry of [...tasks.values()].sort((a, b) => a.task_id.localeCompare(b.task_id))) {
		for (const session of [...entry.sessions.values()].sort((a, b) => a.session_id.localeCompare(b.session_id))) {
			const cross = await sessionCrossCheck(session.session_file);
			if (cross && cross.present) {
				session.crossToolCalls = cross.tool_calls;
				session.crossToolResults = cross.tool_results;
				session.crossUnreadable = cross.readable === false;
				session.countMismatch =
					cross.readable !== false && (cross.tool_calls !== session.toolCalls || cross.tool_results !== session.toolResults);
			}
			// Group comes from recorded metadata ONLY; result.group is a cross-check.
			const group = groupOf(session);
			const resolved = session.resolved;
			const first = firstToolInfo(session);
			rows.push({
				task_id: entry.task_id,
				session_id: session.session_id,
				group,
				group_source: "metadata",
				card: resolved.card ?? "",
				injected: session.injections > 0 ? "yes" : "no",
				injection_count: session.injections,
				nonmatch_count: session.nonmatches,
				manual_selected: session.manual_selected ? "yes" : "no",
				tool_calls: session.toolCalls,
				tool_results: session.toolResults,
				first_tool: first.name,
				first_tool_error: first.error === null ? "" : first.error ? "yes" : "no",
				first_tool_offset_ms: first.offset_ms === null ? "" : String(first.offset_ms),
				result: resolved.result,
				result_source: resolved.source,
				independent: resolved.independent ? "yes" : "no",
				evidence: resolved.evidence ?? "",
			});
		}
	}

	// --- Anomalies / unknowns (checkable). ---
	const anomalyRows = [];
	for (const entry of [...tasks.values()].sort((a, b) => a.task_id.localeCompare(b.task_id))) {
		for (const message of entry.anomalies) anomalyRows.push({ task_id: entry.task_id, kind: "log_integrity", detail: message });
		const sessions = [...entry.sessions.values()];
		const taskResolved = resolveRows(entry.results);
		const taskResult = taskLevelResult(entry);

		if (taskResult === "unknown") {
			anomalyRows.push({ task_id: entry.task_id, kind: "no_independent_result", detail: "result missing or explicitly unknown; not inferable from agent behavior" });
		}
		if (taskResolved.conflict) {
			anomalyRows.push({ task_id: entry.task_id, kind: "conflicting_results", detail: `multiple disagreeing result rows: ${entry.results.map((r) => `${r.at ?? r.recorded_at ?? "?"}=${r.result}`).join(", ")}` });
		}
		if (taskResolved.missingEvidence) {
			anomalyRows.push({ task_id: entry.task_id, kind: "missing_evidence", detail: `${taskResolved.result} recorded without an evidence reference; treat as unverified` });
		}
		if (entry.results.length > 1 && !taskResolved.conflict) {
			anomalyRows.push({ task_id: entry.task_id, kind: "multiple_results", detail: `${entry.results.length} result rows agree; keeping the latest by timestamp` });
		}
		if (sessions.length > 1) {
			anomalyRows.push({ task_id: entry.task_id, kind: "multi_session_task", detail: `${sessions.length} sessions recorded for one task_id; results are attributed per session, never copied` });
		}
		if (entry.ambiguousResults.length > 0) {
			anomalyRows.push({ task_id: entry.task_id, kind: "ambiguous_result_session", detail: `${entry.ambiguousResults.length} result row(s) had no session_id for a multi-session task; NOT attributed; treat as unknown` });
		}

		for (const session of sessions) {
			const resolved = session.resolved;
			const modes = [...session.modes].sort();
			if (modes.length > 1) {
				anomalyRows.push({ task_id: entry.task_id, kind: "mixed_group", detail: `session ${session.session_id} recorded modes ${modes.join("+")}; keep one group per session` });
			}
			if (resolved.group && modes.length > 0 && !modes.includes(resolved.group)) {
				anomalyRows.push({ task_id: entry.task_id, kind: "group_mismatch", detail: `session ${session.session_id} metadata group=${modes.join("+")} but result row claims group=${resolved.group}; metadata wins` });
			}
			if (resolved.card) {
				const claimed = cardRef(resolved.card);
				if (session.injectedCardIds.size === 0) {
					anomalyRows.push({ task_id: entry.task_id, kind: "card_mismatch", detail: `result row claims card ${resolved.card} but session ${session.session_id} recorded no injection` });
				} else if (!session.injectedCardIds.has(claimed.id)) {
					anomalyRows.push({ task_id: entry.task_id, kind: "card_mismatch", detail: `result row claims card ${resolved.card} but session ${session.session_id} injected ${[...session.injectedCardRefs].sort().join(", ")}` });
				} else if (claimed.rev && !session.injectedCardRefs.has(claimed.ref)) {
					anomalyRows.push({ task_id: entry.task_id, kind: "card_revision_mismatch", detail: `result row claims card ${claimed.ref} but session injected ${[...session.injectedCardRefs].sort().join(", ")}` });
				}
			}
			if (session.countMismatch) {
				anomalyRows.push({ task_id: entry.task_id, kind: "count_mismatch", detail: `extension metadata (calls=${session.toolCalls}, results=${session.toolResults}) disagrees with Pi session JSONL cross-check (calls=${session.crossToolCalls}, results=${session.crossToolResults}); metadata is authoritative` });
			}
			if (session.crossUnreadable) {
				anomalyRows.push({ task_id: entry.task_id, kind: "session_cross_check_unreadable", detail: `linked session file had unparseable lines: ${session.session_file}` });
			}
			if (!session.session_file) continue;
			const st = await stat(session.session_file).catch(() => null);
			if (!st) anomalyRows.push({ task_id: entry.task_id, kind: "missing_session_file", detail: `linked session file not found: ${session.session_file}` });
		}

		const anyInject = sessions.some((s) => s.injections > 0);
		const anyNonmatch = sessions.some((s) => s.nonmatches > 0);
		if (anyInject && anyNonmatch) {
			anomalyRows.push({ task_id: entry.task_id, kind: "mixed_match", detail: "session had both injected and non-injected requests; check for misfire or mid-task group switch" });
		}
	}
	anomalyRows.sort((a, b) => (a.task_id + a.kind).localeCompare(b.task_id + b.kind));

	// --- Task-level summary: count UNIQUE tasks, not session rows. ---
	const summary = {
		date: targetDate,
		tasks: 0,
		sessions: rows.length,
		by_result: { success: 0, failure: 0, unknown: 0 },
		by_group: {},
		tool_calls_by_group: {},
		with_injection: rows.filter((r) => r.injected === "yes").length,
		anomalies: anomalyRows.length,
	};
	const countedTasks = new Set();
	for (const entry of [...tasks.values()].sort((a, b) => a.task_id.localeCompare(b.task_id))) {
		if (entry.sessions.size === 0 && entry.results.length === 0) continue;
		if (countedTasks.has(entry.task_id)) continue;
		countedTasks.add(entry.task_id);
		summary.by_result[taskLevelResult(entry)] = (summary.by_result[taskLevelResult(entry)] ?? 0) + 1;
		const groups = new Set([...entry.sessions.values()].map((s) => groupOf(s)));
		const group = groups.size === 1 ? [...groups][0] : "mixed";
		summary.by_group[group] = (summary.by_group[group] ?? 0) + 1;
	}
	summary.tasks = countedTasks.size;
	for (const row of rows) {
		summary.tool_calls_by_group[row.group] = (summary.tool_calls_by_group[row.group] ?? 0) + row.tool_calls;
	}
	function taskLevelResult(entry) {
		const sessions = [...entry.sessions.values()];
		if (sessions.length <= 1) return resolveRows(entry.results).result;
		if (entry.ambiguousResults.length > 0) return "unknown";
		const per = sessions.map((s) => s.resolved?.result ?? "unknown");
		const known = per.filter((r) => r !== "unknown");
		if (known.length === per.length && new Set(known).size === 1) return known[0];
		return "unknown";
	}

	/**
	 * Read the task-scoped runtime EventLogs to surface OBSERVED stage activity.
	 * This is a read-only projection: it reports what the Observer actually
	 * recorded (data obtained, data USED by a completed action, verified
	 * outcomes) and the current effective Fact/Refuted view. It never infers
	 * success, never promotes a claim, and never writes.
	 */
	async function readRuntimeActivity() {
		let dirents = [];
		try {
			dirents = await readdir(TASK_RUNTIME_DIR, { withFileTypes: true });
		} catch {
			return { available: false, root: TASK_RUNTIME_DIR, tasks: [], limitations: ["Task runtime audit dir not present; stage activity cannot be shown."] };
		}
		const out = [];
		for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!dirent.isDirectory()) continue;
			const logPath = join(TASK_RUNTIME_DIR, dirent.name, "events.jsonl");
			const parsedLog = await readJsonl(logPath);
			if (parsedLog.missing) continue;
			const events = parsedLog.rows.filter((e) => !e.__parse_error);
			if (events.length === 0) continue;
			let board;
			try {
				board = projectBoard(events);
			} catch (error) {
				out.push({ task_id: dirent.name, events: events.length, unreadable: `board projection failed: ${String(error)}` });
				continue;
			}
			const state = projectState(events);
			const observations = events.filter((e) => e.event_type === "observation.captured");
			const stepOutcomes = events.filter((e) => e.event_type === "outcome.recorded" && e.payload?.level === "step");
			const episodeOutcomes = events.filter((e) => e.event_type === "outcome.recorded" && e.payload?.level !== "step");
			const notes = events.filter((e) => e.event_type === "runtime.note");
			const dataUse = notes.filter((e) => e.payload?.kind === "data.use.bound");
			const rejected = notes.filter((e) => e.payload?.kind === "action.rejected");
			const environment = notes.filter((e) => e.payload?.kind === "environment.observed");
			const contributions = notes.filter((e) => e.payload?.kind === "contribution.recorded");
			const handoffs = events.filter((e) => e.event_type === "handoff.completed" || e.event_type === "handoff.requested");
			const effective = (board.currentByType?.Fact ?? []).map((n) => ({ type: "Fact", id: n.id, text: n.text }));
			for (const n of (board.currentByType?.Refuted ?? [])) effective.push({ type: "Refuted", id: n.id, text: n.text });
			// Only the CURRENT (non-superseded) outcomes count as support; a superseded
			// outcome must never be reported as the standing result.
			const supersededIds = new Set(board.effective?.superseded_outcome_ids ?? []);
			const currentOutcomes = events
				.filter((e) => e.event_type === "outcome.recorded" && e.payload?.outcome_id && !supersededIds.has(e.payload.outcome_id))
				.map((e) => ({ outcome_id: e.payload.outcome_id, level: e.payload.level ?? "step", status: e.payload.status ?? "unknown", failure_mode: e.payload.failure_mode ?? null }));
			// The ACTUAL contribution refs, grouped by stage and status, never just a count.
			const contributionRefs = contributions.map((e) => ({ stage: e.payload.stage, status: e.payload.status, stage_useful: e.payload.stage_useful === true, data_ref: e.payload.data_ref ?? null, action_ref: e.payload.action_ref ?? null, outcome_ref: e.payload.outcome_ref ?? null, association_only: true, causal: false }));
			const stageUseful = contributions.filter((e) => e.payload?.stage_useful === true).length;
			const pendingCount = Object.values(state.pending_actions ?? {}).filter((a) => a && a.status === "pending").length;
			out.push({
				task_id: dirent.name,
				events: events.length,
				episodes: new Set(events.map((e) => e.episode_id).filter(Boolean)).size,
				observations: observations.length,
				observations_verified: observations.filter((o) => o.payload?.verified === true).length,
				observations_unverified: observations.filter((o) => o.payload?.verified !== true).length,
				step_outcomes: stepOutcomes.length,
				episode_outcomes: episodeOutcomes.length,
				current_outcomes: currentOutcomes,
				superseded_outcomes: supersededIds.size,
				data_use_bindings: dataUse.length,
				contributions: contributionRefs.length,
				contribution_refs: contributionRefs,
				stage_useful_contributions: stageUseful,
				rejected_actions: rejected.length,
				environment_admissions: environment.length,
				handoffs: handoffs.length,
				effective_outcomes: effective,
				effective_digest: board.effective_digest ?? null,
				current_episode: state.current_episode_id ?? state.episode_id ?? null,
				// `pending_actions` is an OBJECT keyed by action id, not an array; counting
				// `.length` on it silently reported `undefined`. Count real pending rows.
				unresolved_actions: pendingCount,
				healthy: parsedLog.rows.every((e) => !e.__parse_error),
			});
		}
		return {
			available: true,
			root: TASK_RUNTIME_DIR,
			tasks: out,
			limitations: [
				"Stage activity is read from the task-scoped Observer EventLog; counts are observed events, not proof of usefulness.",
				"A verified observation means the REGISTERED re-check read the real artifact; it is not an OS sandbox guarantee.",
				"data_use_bindings and contributions are association-only; they never assert that data CAUSED an advance.",
				"current_outcomes excludes superseded outcomes; a superseded Outcome is never reported as standing support.",
			],
		};
	}
	const runtimeActivity = await readRuntimeActivity();

	const report = {
		schema_version: "1.1",
		report: "aegis-contest-daily",
		date: targetDate,
		...(deterministic ? {} : { generated_at: new Date().toISOString() }),
		sources: {
			decisions: DECISIONS_PATH,
			decisions_present: !decisions.missing,
			results: RESULTS_PATH,
			results_present: !results.missing,
			session_dir: SESSION_DIR,
		},
		summary,
		runtime_activity: runtimeActivity,
		rows,
		anomalies: anomalyRows,
		limitations: [
			"Success/failure come only from the independent results log (platform or explicit human verification + evidence); missing = unknown, never inferred.",
			"Group is derived from recorded session_start/injection_decision metadata; a hand-filled result group/card is only cross-checked and flagged.",
			"Tool call/result counts come from the Aegis extension's own metadata log and are authoritative; Pi session JSONL is only a best-effort cross-check.",
			"First tool action is derived from recorded metadata timestamps; if a timestamp is missing the offset is left blank, never filled with zero.",
			"A count_mismatch means the JSONL cross-check disagreed; it does not change the metadata counts and should be investigated by a human.",
			"Multiple/conflicting result rows and multi-session tasks are all listed; a single result is never copied across sessions.",
			"This report cannot prove causation; with few tasks it is exploratory only.",
			"Absolute times are not comparable across tasks of different difficulty.",
		],
		read_only: true,
	};

	// --- Render Markdown deterministically ---
	const lines = [];
	lines.push(`# Aegis contest daily review — ${targetDate}`);
	lines.push("");
	lines.push(`- tasks: ${summary.tasks}`);
	lines.push(`- sessions: ${summary.sessions}`);
	lines.push(`- results: success=${summary.by_result.success ?? 0} failure=${summary.by_result.failure ?? 0} unknown=${summary.by_result.unknown ?? 0}`);
	lines.push(`- groups: ${Object.entries(summary.by_group).sort().map(([k, v]) => `${k}=${v}`).join(" ") || "(none)"}`);
	lines.push(`- tool calls by group: ${Object.entries(summary.tool_calls_by_group).sort().map(([k, v]) => `${k}=${v}`).join(" ") || "(none)"}`);
	lines.push(`- tasks with injection: ${summary.with_injection}`);
	lines.push(`- anomalies: ${summary.anomalies}`);
	lines.push("");
	lines.push("## Runtime stage activity (observed, read-only)");
	lines.push("");
	if (!runtimeActivity.available || runtimeActivity.tasks.length === 0) {
		lines.push(runtimeActivity.available ? "- (no task runtime logs found)" : "- (task runtime audit dir not present)");
	} else {
		lines.push("| task_id | events | healthy | episodes | obs | obs_verified | step_outcomes | episode_outcomes | current_outcomes | superseded | data_use | contributions | stage_useful | rejected | env_admissions | handoffs | effective_facts/refuted | unresolved_actions |");
		lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
		for (const t of runtimeActivity.tasks) {
			lines.push(`| ${t.task_id} | ${t.events} | ${t.healthy === false ? "DEGRADED" : "yes"} | ${t.episodes} | ${t.observations} | ${t.observations_verified} | ${t.step_outcomes} | ${t.episode_outcomes} | ${(t.current_outcomes ?? []).length} | ${t.superseded_outcomes ?? 0} | ${t.data_use_bindings} | ${t.contributions} | ${t.stage_useful_contributions} | ${t.rejected_actions} | ${t.environment_admissions} | ${t.handoffs} | ${(t.effective_outcomes ?? []).length} | ${t.unresolved_actions} |`);
		}
		const withContribs = runtimeActivity.tasks.filter((t) => (t.contribution_refs ?? []).length > 0);
		if (withContribs.length > 0) {
			lines.push("");
			lines.push("### Actual data-stage contribution refs (association-only)");
			lines.push("");
			lines.push("| task_id | stage | status | stage_useful | data_ref | action_ref | outcome_ref |");
			lines.push("| --- | --- | --- | --- | --- | --- | --- |");
			for (const t of withContribs) {
				for (const c of t.contribution_refs) {
					const refText = (r) => (r && r.ref_id ? `${r.ref_type || "ref"}:${r.ref_id}${r.digest ? `@${String(r.digest).slice(0, 12)}` : ""}` : "-");
					lines.push(`| ${t.task_id} | ${c.stage} | ${c.status} | ${c.stage_useful ? "yes" : "no"} | ${refText(c.data_ref)} | ${refText(c.action_ref)} | ${refText(c.outcome_ref)} |`);
				}
			}
		}
	}
	lines.push("");
	lines.push("## Rows");
	lines.push("");
	lines.push("| task_id | session_id | group | card | injected | inj# | nonmatch# | manual | tool_calls | tool_results | first_tool | first_tool_error | first_tool_offset_ms | result | source | independent | evidence |");
	lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const r of rows) {
		lines.push(`| ${r.task_id} | ${r.session_id} | ${r.group} | ${r.card || "-"} | ${r.injected} | ${r.injection_count} | ${r.nonmatch_count} | ${r.manual_selected} | ${r.tool_calls} | ${r.tool_results} | ${r.first_tool || "-"} | ${r.first_tool_error || "-"} | ${r.first_tool_offset_ms === "" ? "-" : r.first_tool_offset_ms} | ${r.result} | ${r.result_source} | ${r.independent} | ${r.evidence || "-"} |`);
	}
	if (rows.length === 0) lines.push("| (no tasks) | | | | | | | | | | | | | | | | |");
	lines.push("");
	lines.push("## Anomalies / unknowns (checkable)");
	lines.push("");
	lines.push("| task_id | kind | detail |");
	lines.push("| --- | --- | --- |");
	for (const a of anomalyRows) lines.push(`| ${a.task_id} | ${a.kind} | ${a.detail} |`);
	if (anomalyRows.length === 0) lines.push("| (none) | | |");
	lines.push("");
	lines.push("## Suggested next-day adjustments (candidates only; NOT auto-written)");
	lines.push("");
	for (const a of anomalyRows) {
		if (a.kind === "no_independent_result") lines.push(`- ${a.task_id}: obtain an independent platform/human result; do not infer success.`);
		if (a.kind === "missing_evidence") lines.push(`- ${a.task_id}: success/failure lacks an evidence reference; re-check the platform/human ruling before counting it.`);
		if (a.kind === "conflicting_results") lines.push(`- ${a.task_id}: result rows disagree; resolve with the independent source and append a correcting row; do not overwrite history.`);
		if (a.kind === "multiple_results") lines.push(`- ${a.task_id}: multiple agreeing result rows; keep both and confirm which is canonical.`);
		if (a.kind === "multi_session_task") lines.push(`- ${a.task_id}: multiple sessions for one task; keep per-session results separate and do not count one success twice.`);
		if (a.kind === "ambiguous_result_session") lines.push(`- ${a.task_id}: a result row has no session_id for a multi-session task; re-record it with the exact session or treat it as unknown.`);
		if (a.kind === "group_mismatch") lines.push(`- ${a.task_id}: a hand-filled result group disagrees with recorded metadata; trust the metadata and correct the result row.`);
		if (a.kind === "mixed_group") lines.push(`- ${a.task_id}: one session records more than one group; treat the run as group-switched and exclude it from A/B.`);
		if (a.kind === "card_mismatch" || a.kind === "card_revision_mismatch") lines.push(`- ${a.task_id}: the result card reference does not match the injected card; re-check the injection metadata.`);
		if (a.kind === "mixed_match") lines.push(`- ${a.task_id}: review whether the hint misfired or the group was switched mid-task; keep one group per task.`);
		if (a.kind === "missing_session_file") lines.push(`- ${a.task_id}: locate the archived session JSONL so the run stays auditable.`);
		if (a.kind === "count_mismatch") lines.push(`- ${a.task_id}: metadata vs session JSONL tool counts disagree; treat metadata as authoritative and inspect the session.`);
	}
	if (anomalyRows.length === 0) lines.push("- (nothing flagged)");
	lines.push("");
	lines.push("## Limitations");
	lines.push("");
	for (const l of report.limitations) lines.push(`- ${l}`);
	lines.push("");
	lines.push("_Read-only report. It does not modify cards, logs, or the experience library._");
	lines.push("");
	const markdown = lines.join("\n");

	await mkdir(outdir, { recursive: true });
	const jsonPath = join(outdir, `${targetDate}.report.json`);
	const mdPath = join(outdir, `${targetDate}.report.md`);
	const csvPath = join(outdir, `${targetDate}.rows.csv`);
	if (format === "json" || format === "both") await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	if (format === "md" || format === "both") await writeFile(mdPath, markdown, "utf8");

	// Always write the flat CSV (deterministic).
	const csvHeader = ["task_id", "session_id", "group", "group_source", "card", "injected", "injection_count", "nonmatch_count", "manual_selected", "tool_calls", "tool_results", "first_tool", "first_tool_error", "first_tool_offset_ms", "result", "result_source", "independent", "evidence"];
	const csv = [csvHeader.join(","), ...rows.map((r) => csvHeader.map((h) => csvEscape(r[h])).join(","))].join("\n") + "\n";
	await writeFile(csvPath, csv, "utf8");

	process.stdout.write(markdown);
	process.stderr.write(`\nwrote: ${jsonPath.replace(/[^/]+$/, "")} (json/md/csv) for ${targetDate}\n`);
	return 0;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		process.stderr.write(`error: ${String(error)}\n`);
		process.exitCode = 1;
	});
