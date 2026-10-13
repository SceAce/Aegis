// Aegis C4a — read-only observation view over the committed Campaign projection.
//
// The whiteboard/queue/action/result views (HTTP JSON, HTML page, Pi command)
// all derive from THIS module, which itself reuses the C4 report derivation:
//
//   committed EventLog + immutable Manifest
//     -> buildReportInputs / generateCampaignArtifacts (C4)
//     -> a bounded, redacted, whitelisted observation view
//
// It owns NO scheduling, authorization or truth. It never runs the
// Worker/Broker/Oracle, the model or the network, and never mutates the source.
// A failed UI is a read-only client failure and never blocks the Host.

import { redactSecrets } from "./report.mjs";
import { generateCampaignArtifacts, reconstructArtifactIndex } from "./report-export.mjs";

export const OBSERVATION_VIEW_VERSION = "1.0.0";

/**
 * Bounded display limits. A truncated list carries `truncated: true` and the full
 * `total`, so a bounded page never silently hides evidence.
 */
export const OBSERVATION_LIMITS = Object.freeze({
	max_tasks: 200,
	max_stages: 400,
	max_outcomes: 400,
	max_actions: 400,
	max_proposals: 200,
	max_faults: 200,
	max_missing_evidence: 200,
	max_conflicts: 100,
	max_page_size: 200,
	max_view_bytes: 2 * 1024 * 1024,
});

const UNKNOWN = "unknown";

function clampPage({ items, limit, offset = 0 }) {
	const total = items.length;
	const start = Number.isInteger(offset) && offset > 0 ? Math.min(offset, total) : 0;
	const page = items.slice(start, start + limit);
	return { items: page, total, returned: page.length, offset: start, truncated: start + page.length < total };
}

/**
 * Build the bounded observation view. PURE: same input -> same view.
 *
 * @param {{manifest: any, manifestDigest?: string|null, events?: any[],
 *   artifacts?: any, runtimeDigests?: any, limits?: any, generatedAt?: string|null,
 *   page?: number, page_size?: number}} args
 */
export function buildObservationView(
	{
		manifest,
		manifestDigest = null,
		events = [],
		artifacts = {},
		runtimeDigests = {},
		limits = OBSERVATION_LIMITS,
		generatedAt = null,
		page = 0,
		page_size = null,
	} = /** @type {any} */ ({}),
) {
	limits = { ...OBSERVATION_LIMITS, ...limits };
	if (!manifest || typeof manifest !== "object") throw new Error("buildObservationView requires a validated manifest");

	// Reuse the C4 derivation so the UI/report never diverge.
	const generated = generateCampaignArtifacts({
		manifest,
		manifestDigest,
		events,
		artifacts,
		runtimeDigests,
		generatedAt,
	});
	const report = generated.report;

	const integrityOk = report.integrity?.event_chain_ok === true;
	const allTasks = report.task_lifecycle ?? [];
	const pageLimit =
		Number.isInteger(page_size) && page_size > 0 ? Math.min(page_size, limits.max_page_size) : limits.max_tasks;
	const offset = Number.isInteger(page) && page > 0 ? page * pageLimit : 0;

	const tasksPage = clampPage({ items: report.tasks ?? [], limit: pageLimit, offset });
	const lifecyclePage = clampPage({ items: allTasks, limit: pageLimit, offset });
	const stagesPage = clampPage({ items: report.stages ?? [], limit: limits.max_stages, offset: 0 });
	const outcomesPage = clampPage({ items: report.outcomes ?? [], limit: limits.max_outcomes, offset: 0 });
	const proposalsPage = clampPage({ items: report.dynamic_proposals ?? [], limit: limits.max_proposals, offset: 0 });
	const faultsPage = clampPage({ items: report.faults ?? [], limit: limits.max_faults, offset: 0 });
	const missingPage = clampPage({
		items: report.missing_evidence ?? [],
		limit: limits.max_missing_evidence,
		offset: 0,
	});
	const conflictsPage = clampPage({ items: report.conflicts ?? [], limit: limits.max_conflicts, offset: 0 });

	// Actions: committed counts PLUS a bounded, per-action list derived from the
	// committed stream (id/ref/status only; never raw stdout/transcript).
	const actions = collectActionRows(events, limits.max_actions);

	const budget = redactSecrets({
		limit: report.campaign?.budget?.limit ?? null,
		used: report.campaign?.budget?.used ?? null,
		measurement: report.campaign?.budget?.measurement ?? null,
		remaining: remainingFromLedger(report.campaign?.budget),
	});

	const view = {
		schema_version: OBSERVATION_VIEW_VERSION,
		generated_at: generatedAt,
		campaign_id: report.campaign_id ?? null,
		integrity: {
			event_chain_ok: integrityOk,
			event_count: report.integrity?.event_count ?? null,
			last_committed_digest: report.integrity?.last_committed_digest ?? null,
			last_committed_offset: report.integrity?.event_count != null ? report.integrity.event_count - 1 : null,
			// A view over a non-verifying chain is unavailable; the UI must show it
			// rather than claim completed work.
			stale: !integrityOk,
			status: integrityOk ? "ok" : "integrity_failure",
			errors: (report.integrity?.event_chain_errors ?? []).slice(0, 5),
		},
		control: redactSecrets(report.campaign_control ?? { state: UNKNOWN, reason: null }),
		counts: redactSecrets(report.counts ?? {}),
		committed_counts: redactSecrets(report.committed_counts ?? {}),
		budget,
		task_counts: redactSecrets(report.campaign?.counts ?? {}),
		tasks: redactSecrets(tasksPage.items),
		task_lifecycle: redactSecrets(lifecyclePage.items),
		stages: redactSecrets(stagesPage.items),
		outcomes: redactSecrets(outcomesPage.items),
		proposals: redactSecrets(proposalsPage.items),
		actions,
		faults: redactSecrets(faultsPage.items),
		missing_evidence: redactSecrets(missingPage.items),
		conflicts: redactSecrets(conflictsPage.items),
		authorization: redactSecrets(report.authorization ?? null),
		unsupported_claims: redactSecrets(report.unsupported_claims ?? []),
		report_refs: {
			report_digest: report.report_digest ?? null,
			bundle_digest: report.bundle_digest ?? generated.bundle?.bundle_digest ?? null,
		},
		pagination: {
			page: Number.isInteger(page) && page > 0 ? page : 0,
			page_size: pageLimit,
			tasks: { total: tasksPage.total, returned: tasksPage.returned, truncated: tasksPage.truncated },
			stages: { total: stagesPage.total, returned: stagesPage.returned, truncated: stagesPage.truncated },
			outcomes: { total: outcomesPage.total, returned: outcomesPage.returned, truncated: outcomesPage.truncated },
			actions: { total: actions.total, returned: actions.returned, truncated: actions.truncated },
			proposals: { total: proposalsPage.total, returned: proposalsPage.returned, truncated: proposalsPage.truncated },
			faults: { total: faultsPage.total, returned: faultsPage.returned, truncated: faultsPage.truncated },
		},
		limits,
	};
	// Defense in depth: the whole view goes through the value-level redactor.
	return redactSecrets(view);
}

/** A bounded, redacted action listing from committed events. */
function collectActionRows(events, limit) {
	const requested = new Map();
	const completed = new Map();
	for (const event of events) {
		const payload = event?.payload ?? {};
		const sourceKind = event?.source?.kind ?? null;
		if (event?.event_type === "action.requested" && typeof payload.action_id === "string") {
			requested.set(payload.action_id, {
				action_id: payload.action_id,
				action_ref: payload.action_ref ?? null,
				task_id: payload.task_id ?? null,
				step_id: payload.step_id ?? null,
				requested_at: event.occurred_at ?? null,
			});
		}
		if (event?.event_type === "action.completed" && typeof payload.action_id === "string") {
			completed.set(payload.action_id, {
				status: payload.status ?? UNKNOWN,
				source_kind: sourceKind,
				transport_ok: payload.transport?.tool_ok ?? null,
				exit_code: payload.transport?.exit_code ?? null,
				rejection_reason: payload.rejection_reason ?? null,
			});
		}
	}
	const rows = [];
	for (const [actionId, base] of requested) {
		const done = completed.get(actionId);
		rows.push(
			redactSecrets({
				...base,
				status: done ? done.status : "pending",
				source_kind: done?.source_kind ?? null,
				transport_ok: done?.transport_ok ?? null,
				exit_code: done?.exit_code ?? null,
				rejection_reason: done?.rejection_reason ?? null,
			}),
		);
	}
	// A completion with no matching request is reported too (never hidden).
	for (const [actionId, done] of completed) {
		if (requested.has(actionId)) continue;
		rows.push(
			redactSecrets({
				action_id: actionId,
				action_ref: null,
				task_id: null,
				step_id: null,
				status: done.status,
				source_kind: done.source_kind,
			}),
		);
	}
	const total = rows.length;
	return { items: rows.slice(0, limit), total, returned: Math.min(rows.length, limit), truncated: rows.length > limit };
}

function remainingFromLedger(budget) {
	if (!budget?.limit) return null;
	const keys = ["wall_time_ms", "model_requests", "tool_calls", "session_count"];
	const used = budget.used ?? {};
	const reserved = budget.reserved ?? {};
	const remaining = {};
	for (const key of keys) {
		if (typeof budget.limit[key] !== "number") {
			remaining[key] = null;
			continue;
		}
		remaining[key] = Math.max(0, budget.limit[key] - (used[key] ?? 0) - (reserved[key] ?? 0));
	}
	return remaining;
}

/** A short human-readable summary for Pi commands. */
export function summarizeObservationView(view) {
	const control = view.control?.state ?? UNKNOWN;
	const counts = view.task_counts ?? {};
	const committed = view.committed_counts ?? {};
	const actions = committed.actions ?? {};
	const lines = [];
	lines.push(
		`Aegis campaign ${view.campaign_id ?? UNKNOWN}: ${control} | tasks total=${counts.total ?? UNKNOWN} success=${counts.success ?? UNKNOWN} unknown=${counts.unknown ?? UNKNOWN}`,
	);
	lines.push(
		`actions requested=${actions.requested ?? UNKNOWN} executed=${actions.executed ?? UNKNOWN} pending=${actions.pending ?? UNKNOWN} rejected=${actions.rejected ?? UNKNOWN}`,
	);
	lines.push(
		`integrity=${view.integrity?.status ?? UNKNOWN} last_offset=${view.integrity?.last_committed_offset ?? UNKNOWN}${view.integrity?.stale ? " (stale)" : ""}`,
	);
	if ((view.faults ?? []).length > 0) lines.push(`faults=${view.faults.length} (see /api/faults)`);
	if ((view.missing_evidence ?? []).length > 0) lines.push(`missing_evidence=${view.missing_evidence.length}`);
	return lines.join("\n");
}

/** Escape text for safe insertion into HTML (attribute and element contexts). */
export function escapeHtml(value) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** JSON embedded in a <script> must not be able to close the tag. */
export function escapeForScriptJson(value) {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

/** Render the bounded observation view as a static, escaped HTML page. */
export function renderObservationHtml(view) {
	const rows = (view.tasks ?? [])
		.map(
			(task) =>
				`<tr><td>${escapeHtml(task.task_id)}</td><td>${escapeHtml(task.status)}</td><td>${escapeHtml(
					task.lifecycle_state ?? "",
				)}</td><td>${escapeHtml(task.stop_reason ?? "")}</td></tr>`,
		)
		.join("\n");
	const faultRows = (view.faults ?? [])
		.map(
			(fault) =>
				`<li>${escapeHtml(fault.kind)} ${escapeHtml(fault.task_id ?? "")}: ${escapeHtml(fault.detail ?? "")}</li>`,
		)
		.join("\n");
	const missingRows = (view.missing_evidence ?? [])
		.map((item) => `<li>${escapeHtml(typeof item === "string" ? item : JSON.stringify(item))}</li>`)
		.join("\n");
	const claimRows = (view.unsupported_claims ?? []).map((claim) => `<li>${escapeHtml(claim)}</li>`).join("\n");
	const integrityNote = view.integrity?.stale
		? `<p class="warn">Integrity: ${escapeHtml(view.integrity.status)} — no completed work is established from these rows.</p>`
		: `<p>Integrity: ${escapeHtml(view.integrity?.status ?? UNKNOWN)}</p>`;

	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Aegis campaign ${escapeHtml(view.campaign_id ?? UNKNOWN)}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:60rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.25rem .5rem;text-align:left}.warn{color:#a00}code{background:#f4f4f4;padding:0 .25rem}</style>
</head><body>
<h1>Aegis campaign ${escapeHtml(view.campaign_id ?? UNKNOWN)}</h1>
${integrityNote}
<p>control: <code>${escapeHtml(view.control?.state ?? UNKNOWN)}</code> ${escapeHtml(view.control?.reason ?? "")}</p>
<p>actions: requested=${escapeHtml(view.committed_counts?.actions?.requested ?? UNKNOWN)} executed=${escapeHtml(
		view.committed_counts?.actions?.executed ?? UNKNOWN,
	)} pending=${escapeHtml(view.committed_counts?.actions?.pending ?? UNKNOWN)} rejected=${escapeHtml(
		view.committed_counts?.actions?.rejected ?? UNKNOWN,
	)}</p>
<h2>Tasks</h2>
<table><thead><tr><th>task</th><th>evidence</th><th>lifecycle</th><th>stop_reason</th></tr></thead><tbody>
${rows}
</tbody></table>
<h2>Faults</h2>
<ul>${faultRows}</ul>
<h2>Missing evidence</h2>
<ul>${missingRows}</ul>
<h2>Unsupported claims</h2>
<ul>${claimRows}</ul>
<h2>Read-only API</h2>
<ul><li><a href="/api/view">/api/view</a></li><li><a href="/api/tasks">/api/tasks</a></li><li><a href="/api/actions">/api/actions</a></li><li><a href="/api/faults">/api/faults</a></li></ul>
<p>This page is read-only. It never pauses, cancels or authorizes anything.</p>
</body></html>`;
}

export { reconstructArtifactIndex };
