// Bridge from independent contest results to runtime Outcome events.
//
// A contest result (platform score or explicit human review) is an INDEPENDENT
// outcome source. It is the only path here that may create a verified Fact /
// Refuted node, and only when the row carries a recognized independent source
// AND a non-empty evidence reference. A bare status string, an unrecognized
// source, or a missing evidence ref can NEVER make a verified node; it degrades
// to an `unknown` outcome (an unverified Hint). The model's own prose is never
// consulted.
//
// `resultToOutcome` normalizes a result row into a FULL MEMORY_SCHEMA §5.2
// Outcome: outcome_id, level, episode_id, criterion, observed (non-null for
// success/failure), oracle, evidence_refs, transport, failure_mode,
// reproducibility and assessed_at. Transport facts (tool_ok/exit_code/timeout/
// duration) are recorded but NEVER substitute for `status`. A missing field is
// `unknown`, never guessed into success or independence.

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { digest } from "../shared/events.mjs";

const ALLOWED = new Set(["success", "failure", "unknown", "invalid"]);

// Recognized independent provenance. `platform` is an oracle ruling; `human` is
// an explicit human verification. Anything else (model, agent, exit code,
// agent_settled, unknown) is not independent.
export const INDEPENDENT_SOURCES = new Set(["platform", "oracle", "human"]);

const SECRET_PATTERNS = [
	/(flag\{[^}]*\})/gi,
	/(sk-[A-Za-z0-9_-]{12,})/g,
	/(api[_-]?key\s*[:=]\s*\S+)/gi,
	/(bearer\s+[A-Za-z0-9._~+/=-]+)/gi,
];

export function redactEvidence(text) {
	let value = String(text ?? "");
	for (const pattern of SECRET_PATTERNS) value = value.replace(pattern, "[REDACTED]");
	return value.slice(0, 400);
}

/** Read the canonical source field. `result_source` is authoritative; `source` is a legacy alias. */
export function resultSourceOf(row) {
	const raw = typeof row?.result_source === "string" ? row.result_source : typeof row?.source === "string" ? row.source : "";
	return raw.trim().toLowerCase();
}

/** Stable outcome id: explicit row value, else a digest of the identifying facts. */
function outcomeIdOf(row, status) {
	if (typeof row.outcome_id === "string" && row.outcome_id.trim()) return row.outcome_id.trim();
	const seed = `${row.task_id ?? "unknown"}:${row.session_id ?? "none"}:${status}:${row.at ?? row.recorded_at ?? ""}`;
	return `out_contest_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

/**
 * Normalize transport facts. Missing values are `unknown`/null, never invented.
 * `tool_ok` is a transport fact; it does NOT decide success.
 */
function normalizeTransport(row) {
	const t = row?.transport && typeof row.transport === "object" ? row.transport : {};
	return {
		tool_ok: typeof t.tool_ok === "boolean" ? t.tool_ok : typeof row?.tool_ok === "boolean" ? row.tool_ok : null,
		exit_code: Number.isInteger(t.exit_code) ? t.exit_code : Number.isInteger(row?.exit_code) ? row.exit_code : null,
		timed_out: typeof t.timed_out === "boolean" ? t.timed_out : false,
		duration_ms: Number.isFinite(t.duration_ms) ? t.duration_ms : Number.isFinite(row?.duration_ms) ? row.duration_ms : null,
	};
}

/**
 * Normalize reproducibility. A contest result is an external judgement; unless
 * the row explicitly declares a replayable check it is NOT replayable, and we
 * never claim a replay that was not performed.
 */
function normalizeReproducibility(row) {
	const r = row?.reproducibility && typeof row.reproducibility === "object" ? row.reproducibility : {};
	return {
		replayable: r.replayable === true,
		replay_hash: typeof r.replay_hash === "string" && r.replay_hash ? r.replay_hash : null,
		replay_count: Number.isInteger(r.replay_count) && r.replay_count >= 0 ? r.replay_count : 0,
		checked_at: typeof r.checked_at === "string" && r.checked_at ? r.checked_at : null,
	};
}

/**
 * Normalize a contest result row into a full `outcome.recorded` payload.
 *
 * The emitted payload is a complete audited Outcome: it always carries a
 * criterion, an oracle/verifier declaration, an observed value, transport
 * facts, evidence refs and reproducibility. A row that cannot support a
 * verified judgement is downgraded to `unknown` with
 * `failure_mode: insufficient_evidence`; it is never silently promoted to
 * success/failure, and a transport error/timeout is never a refutation.
 */
export function resultToOutcome(row, { episodeId = null } = {}) {
	if (!row || typeof row !== "object") throw new Error("result row must be an object");
	const rawStatus = typeof row.result === "string" ? row.result.toLowerCase() : "unknown";
	const requested = ALLOWED.has(rawStatus) ? rawStatus : "unknown";
	const source = resultSourceOf(row);
	const independent = INDEPENDENT_SOURCES.has(source) && row.independent === true;
	const evidence = redactEvidence(row.evidence || "");
	const hasEvidence = evidence.length > 0;
	const transport = normalizeTransport(row);

	// A success/failure is only accepted as verified when provenance is
	// independent AND an evidence reference exists. A transport timeout is
	// `unknown` regardless of any requested status.
	//
	// A general contest `failure` is a TASK failure, which is different from a
	// METHOD refutation. We KEEP `status: "failure"` so the verified task failure
	// is not lost; the board's write gate independently requires
	// `preconditions_verified === true` AND `failure_mode: postcondition_failed`
	// before it may emit a Refuted node (see board.classifyOutcome). A failure
	// whose precondition was not verified still records status=failure with its
	// failure_mode, but can never refute a method.
	let status = requested;
	let failure_mode = null;
	const transportUnknown = transport.timed_out === true || (transport.tool_ok === false && requested !== "failure");
	if ((requested === "success" || requested === "failure") && (!independent || !hasEvidence)) {
		status = "unknown";
		failure_mode = "insufficient_evidence";
	} else if (transportUnknown && status !== "unknown") {
		// A transport failure/timeout is never a task verdict.
		status = "unknown";
		failure_mode = transport.timed_out === true ? "timeout" : "tool_error";
	}
	if (status === "failure") {
		// Default the failure mode to postcondition_failed ONLY when the row
		// explicitly declares the postcondition failed; otherwise record the row's
		// own mode (or insufficient_evidence). Never invent a postcondition failure.
		const declaredMode = typeof row.failure_mode === "string" && row.failure_mode ? row.failure_mode : null;
		failure_mode = declaredMode || "insufficient_evidence";
	}
	// The precondition gate is independent of `status`: it is taken from the row
	// (verified preconditions) and defaults to false (unknown), never assumed.
	const preconditions_verified = row.preconditions_verified === true;

	const criterion = row.criterion && typeof row.criterion === "object"
		? {
				criterion_id: String(row.criterion.criterion_id ?? `contest:${row.task_id ?? "unknown"}`),
				description: String(row.criterion.description ?? "contest/task goal independently judged"),
				expected: row.criterion.expected ?? "the recorded contest result",
			}
		: {
				criterion_id: `contest:${row.task_id ?? "unknown"}`,
				description: "contest/task goal independently judged",
				expected: "the recorded contest result",
			};

	// `observed` is non-null only when a judgement was actually made. For
	// success/failure we require an observed value: fall back to the evidence
	// summary, which is the externally recorded observation. A bare status with
	// no observation degrades to unknown.
	let observed = row.observed ?? null;
	if ((status === "success" || status === "failure") && observed === null) {
		observed = evidence || null;
	}
	if ((status === "success" || status === "failure") && observed === null) {
		status = "unknown";
		failure_mode = "insufficient_evidence";
	}

	const evidenceRefs = outcomeEvidenceRefs(row);

	return {
		// MEMORY_SCHEMA §5.2 Outcome object. The object's own schema stays 1.0;
		// the containing event carries the runtime schema (1.1).
		schema_version: "1.0",
		outcome_id: outcomeIdOf(row, status),
		level: "episode",
		episode_id: episodeId ?? row.episode_id ?? null,
		status,
		requested_status: requested,
		criterion,
		observed,
		oracle: {
			oracle_id: source || "unknown",
			method: source === "platform" ? "platform_score" : source === "oracle" ? "oracle_judgement" : source === "human" ? "human_review" : "unverified",
			version: "1.0",
			independence_group: row.group ?? null,
		},
		evidence_refs: evidenceRefs,
		transport,
		failure_mode: status === "failure" || status === "unknown" ? failure_mode || "insufficient_evidence" : null,
		// Preconditions must be independently verified before a failure may refute
		// a method. This is separate from `status` (the task verdict).
		preconditions_verified,
		reproducibility: normalizeReproducibility(row),
		assessed_at: typeof row.assessed_at === "string" && row.assessed_at ? row.assessed_at : row.at ?? row.recorded_at ?? new Date().toISOString(),
		// Additive provenance (documented in docs/MEMORY_SCHEMA_NOTES.md): the
		// contest row identity and the independent-source/digest used. Not part of
		// the §5.2 table; harmless to readers that ignore unknown keys.
		provenance: {
			source,
			independent,
			task_id: row.task_id ?? null,
			session_id: row.session_id ?? null,
			group: row.group ?? null,
			card: row.card ?? null,
			evidence_summary: evidence,
			recorded_note: "independent result; not derived from the model, exit code, or agent_settled",
			row_digest: digest({ task_id: row.task_id ?? null, session_id: row.session_id ?? null, result: rawStatus, evidence }),
		},
	};
}

/** Build the canonical, digest-stable Ref[] for an outcome's evidence. */
export function outcomeEvidenceRefs(row) {
	const refs = [];
	const source = resultSourceOf(row);
	const evidence = typeof row?.evidence === "string" ? row.evidence.trim() : "";
	if (evidence) {
		refs.push({
			ref_type: source === "platform" ? "platform_result" : source === "human" ? "human_review" : "external",
			ref_id: `${row.task_id ?? "unknown"}:${createHash("sha256").update(evidence).digest("hex").slice(0, 12)}`,
		});
	}
	// An explicit evidence_refs array (schema Ref objects) is preserved.
	if (Array.isArray(row?.evidence_refs)) {
		for (const ref of row.evidence_refs) {
			if (ref && typeof ref === "object" && typeof ref.ref_type === "string" && typeof ref.ref_id === "string" && ref.ref_type.trim() && ref.ref_id.trim()) {
				refs.push({ ...ref });
			}
		}
	}
	return refs;
}

/**
 * Read and parse a contest results JSONL file. A missing file is an empty list
 * (never an error that could be mistaken for a success). Unparseable lines are
 * returned as `parse_errors` and are NOT turned into rows.
 */
export async function readContestResults(path) {
	let text = "";
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error && error.code === "ENOENT") return { rows: [], path, missing: true, parse_errors: [] };
		throw error;
	}
	const rows = [];
	const parse_errors = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i].trim();
		if (!line) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			parse_errors.push(`line ${i + 1} is not valid JSON`);
		}
	}
	return { rows, path, missing: false, parse_errors };
}

/**
 * Select result rows by EXACT task id and/or session id. Never fuzzy-matches,
 * never falls back to a different task's row. When both are given, both must
 * match. Returns rows in file order.
 */
export function selectResultRows(rows, { taskId = null, sessionId = null } = {}) {
	if (!taskId && !sessionId) return [];
	return rows.filter((row) => {
		if (taskId && row?.task_id !== taskId) return false;
		if (sessionId && row?.session_id !== sessionId) return false;
		return true;
	});
}

/**
 * Resolve the canonical Outcome for a task/session from contest result rows.
 * Multiple rows are kept; the latest valid one is selected, and disagreement is
 * reported as `conflict` and downgraded to `unknown` (never guessed). Missing
 * rows resolve to an `unknown` Outcome with no evidence and no independence.
 *
 * @returns {{outcome: object, rows: object[], conflict: boolean, missing: boolean, parse_errors: string[]}}
 */
export function resolveContestOutcome(rows, { taskId, sessionId = null, episodeId = null } = {}) {
	const selected = selectResultRows(rows, { taskId, sessionId });
	if (selected.length === 0) {
		return {
			outcome: {
				schema_version: "1.0",
				outcome_id: `out_contest_${createHash("sha256").update(`${taskId}:${sessionId ?? "none"}:missing`).digest("hex").slice(0, 16)}`,
				level: "episode",
				episode_id: episodeId,
				status: "unknown",
				requested_status: "unknown",
				criterion: { criterion_id: `contest:${taskId}`, description: "contest/task goal independently judged", expected: "an independent platform/human result" },
				observed: null,
				oracle: { oracle_id: "none", method: "unverified", version: "1.0", independence_group: null },
				evidence_refs: [],
				transport: { tool_ok: null, exit_code: null, timed_out: false, duration_ms: null },
				failure_mode: "insufficient_evidence",
				preconditions_verified: false,
				reproducibility: { replayable: false, replay_hash: null, replay_count: 0, checked_at: null },
				assessed_at: new Date().toISOString(),
				provenance: { source: "", independent: false, task_id: taskId, session_id: sessionId, group: null, card: null, evidence_summary: "", recorded_note: "no independent result recorded; never inferred" },
			},
			rows: selected,
			conflict: false,
			missing: true,
			parse_errors: [],
		};
	}
	const states = new Set(selected.map((row) => String(row.result || "unknown").toLowerCase()));
	const conflict = states.size > 1;
	// Deterministic latest selection by assessed/at/recorded time, then file order.
	const withTime = selected.map((row, index) => ({ row, index, at: Date.parse(row.assessed_at ?? row.at ?? row.recorded_at ?? "") }));
	withTime.sort((a, b) => {
		const at = Number.isNaN(a.at) ? -Infinity : a.at;
		const bt = Number.isNaN(b.at) ? -Infinity : b.at;
		if (at !== bt) return at - bt;
		return a.index - b.index;
	});
	const latest = withTime[withTime.length - 1].row;
	const outcome = resultToOutcome(latest, { episodeId });
	if (conflict) {
		// Conflicting independent judgements are not resolvable by us: stay unknown.
		outcome.status = "unknown";
		outcome.requested_status = String(latest.result || "unknown").toLowerCase();
		outcome.observed = null;
		outcome.failure_mode = "insufficient_evidence";
		outcome.provenance = { ...outcome.provenance, conflict: true, conflict_states: [...states].sort() };
	}
	return { outcome, rows: selected, conflict, missing: false, parse_errors: [] };
}

/** Map a contest green/red card decision to a routing decision payload. */
export function cardToDecision(row, { mode = "hint" } = {}) {
	const selected = row?.card ?? null;
	return {
		mode,
		considered: row?.card ? [row.card] : [],
		matched: row?.card ? [row.card] : [],
		rejected: [],
		selected,
		reason: selected ? "human-selected hint card (candidate input, not an active Experience)" : "no card selected",
		card_digest: row?.card ? digest(String(row.card)) : null,
	};
}

/**
 * Locate already-recorded contest outcomes for the same task/session from an
 * already-open log's replay. This is the memory of the import boundary: it makes
 * a repeated import idempotent and lets a corrected result declare `supersedes`
 * instead of masquerading as an independent second attempt.
 */
export function recordedContestOutcomes(events) {
	const rows = [];
	for (const event of events) {
		if (event?.event_type !== "outcome.recorded") continue;
		const payload = event.payload || {};
		if (payload.level !== "episode" && payload.level !== undefined) continue;
		rows.push({ event, outcome: payload, id: payload.outcome_id ?? null, taskId: payload.provenance?.task_id ?? null, sessionId: payload.provenance?.session_id ?? null, rowDigest: payload.provenance?.row_digest ?? null, status: payload.status ?? null });
	}
	return rows;
}

/**
 * Append an Outcome event to an already-open EventLog.
 *
 * Idempotent: importing the SAME outcome_id/row_digest again does not append a
 * second outcome.recorded event (so it never inflates independence counts).
 * A corrected result for the same task/session is recorded ONCE and declares
 * `supersedes: <previous outcome_id>`; it does not become a new independent
 * attempt. Only an audited outcome (independent source + evidence + criterion +
 * observed) is given the trusted `oracle`/`human` source kind; everything else
 * uses the untrusted `runtime` kind so the board gate downgrades it.
 *
 * @returns {Promise<{ok: boolean, event?: object, outcome?: object, error?: string, duplicate?: boolean, superseded?: string|null}>}
 */
export async function appendContestOutcome(log, rowOrOutcome, { episodeId = null, alreadyNormalized = false } = {}) {
	// Accept EITHER a raw contest result row or an already-normalized canonical
	// Outcome (from resolveContestOutcome). Re-normalizing a canonical Outcome
	// would erase its provenance, so callers pass `alreadyNormalized: true`.
	const outcome = alreadyNormalized && rowOrOutcome && rowOrOutcome.provenance ? rowOrOutcome : resultToOutcome(rowOrOutcome, { episodeId });

	// Idempotency + supersedes against what is already durably recorded.
	const recorded = recordedContestOutcomes(log.replay());
	const sameId = outcome.outcome_id ? recorded.find((r) => r.id === outcome.outcome_id) : null;
	if (sameId) {
		return { ok: true, duplicate: true, event: sameId.event, outcome: sameId.outcome, superseded: null };
	}
	const sameRow = outcome.provenance?.row_digest ? recorded.find((r) => r.rowDigest === outcome.provenance.row_digest) : null;
	if (sameRow) {
		return { ok: true, duplicate: true, event: sameRow.event, outcome: sameRow.outcome, superseded: null };
	}
	const priorForTask = recorded.filter(
		(r) => r.taskId === outcome.provenance?.task_id && (outcome.provenance?.session_id ? r.sessionId === outcome.provenance.session_id : true),
	);
	let superseded = null;
	if (priorForTask.length > 0) {
		// A later result for the same task/session is a CORRECTION, not a second
		// independent attempt. Record the supersedes link so counts do not inflate.
		superseded = priorForTask[priorForTask.length - 1].id;
		outcome.supersedes = superseded;
		outcome.provenance = { ...outcome.provenance, supersedes: superseded, superseding_note: "corrected result for the same task/session; not a new independent attempt" };
	}

	const verified = outcome.status === "success" || outcome.status === "failure";
	const provenanceSource = outcome.provenance?.source ?? outcome.source;
	const trustedKind = verified ? (provenanceSource === "platform" || provenanceSource === "oracle" ? "oracle" : "human") : "runtime";
	const result = await log.append({
		event_type: "outcome.recorded",
		episode_id: episodeId ?? outcome.episode_id ?? rowOrOutcome?.episode_id ?? null,
		payload: outcome,
		source: { actor_id: "contest-result", kind: trustedKind, adapter: "aegis-contest-bridge", version: "0.2.0" },
		evidence_refs: outcome.evidence_refs,
	});
	return { ...result, outcome, superseded };
}
