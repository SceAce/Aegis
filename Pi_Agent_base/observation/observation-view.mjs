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

import { buildE1Explorer, buildE1StateRevision, buildE1View, E1_EXPLORER_LIMITS } from "./e1-observation.mjs";
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
		Number.isInteger(page_size) && page_size > 0
			? Math.min(page_size, limits.max_page_size, limits.max_tasks)
			: Math.min(limits.max_tasks, limits.max_page_size);
	const offset = Number.isInteger(page) && page > 0 ? page * pageLimit : 0;

	const lifecycleById = new Map(allTasks.map((task) => [task.task_id, task]));
	const displayTasks = (report.tasks ?? []).map((task) => ({
		...task,
		...lifecycleById.get(task.task_id),
		status: task.status,
	}));
	const tasksPage = clampPage({ items: displayTasks, limit: pageLimit, offset });
	const lifecyclePage = clampPage({ items: allTasks, limit: pageLimit, offset });
	const stagesPage = clampPage({ items: report.stages ?? [], limit: limits.max_stages, offset: 0 });
	const outcomesPage = clampPage({ items: report.outcomes ?? [], limit: limits.max_outcomes, offset: 0 });
	const proposalsPage = clampPage({
		items: collectProposalRows(integrityOk ? events : [], report),
		limit: limits.max_proposals,
		offset: 0,
	});
	const faultsPage = clampPage({ items: report.faults ?? [], limit: limits.max_faults, offset: 0 });
	const missingPage = clampPage({
		items: report.missing_evidence ?? [],
		limit: limits.max_missing_evidence,
		offset: 0,
	});
	const conflictsPage = clampPage({ items: report.conflicts ?? [], limit: limits.max_conflicts, offset: 0 });

	// Actions: committed counts PLUS a bounded, per-action list derived from the
	// committed stream (id/ref/status only; never raw stdout/transcript).
	const actions = collectActionRows(integrityOk ? events : [], limits.max_actions);

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
	// E1: attach the observable board, task graph, plans and request panels from
	// the SAME committed inputs. Best-effort: an E1 failure never breaks the base
	// view (the base panels remain authoritative for their scope).
	let e1 = null;
	try {
		e1 = buildE1View({ manifest, events: integrityOk ? events : [], integrityOk });
		view.board = e1.board;
		view.task_graph = e1.task_graph;
		view.plans = e1.plans;
		view.requests = e1.requests;
		view.reconciliation = e1.task_graph.reconciliation;
	} catch (error) {
		view.e1_error = String(error instanceof Error ? error.message : error);
	}
	// OBS-01: the explicit state revision + the paged/filtered E1 explorers. A
	// client (or the page's own refresh/paging script) compares `state_revision`
	// across pages and refreshes; a truncated E1 panel carries a real `total` and
	// a next cursor so the remaining nodes/edges stay reachable.
	try {
		const e1Inputs = e1
			? { board: e1.board, graph: e1.task_graph, projection: e1.projection }
			: { board: view.board ?? null, graph: view.task_graph ?? null, projection: null };
		const stateRevision = buildE1StateRevision({
			manifest,
			board: e1Inputs.board,
			graph: e1Inputs.graph,
			projection: e1Inputs.projection,
		});
		view.state_revision = stateRevision.state_revision;
		view.state = stateRevision.state;
		const explorer = buildE1Explorer({
			manifest,
			events: integrityOk ? events : [],
			board: e1Inputs.board,
			query: { page: 0, page_size: Math.min(limits.max_page_size, 50) },
			integrityOk,
		});
		if (explorer.ok) view.e1_explorer = boundedExplorerSummary(explorer);
		else view.e1_explorer = { ok: false, errors: "errors" in explorer ? explorer.errors : [] };
	} catch (error) {
		view.e1_explorer_error = String(error instanceof Error ? error.message : error);
	}
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
		if (!["runtime", "oracle", "human"].includes(sourceKind)) continue;
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

function collectProposalRows(events, report) {
	const rows = new Map((report.dynamic_proposals ?? []).map((entry) => [entry.id, { ...entry, status: "submitted" }]));
	for (const event of events) {
		const payload = event.payload ?? {};
		if (payload.campaign_id !== report.campaign_id || !rows.has(payload.proposal_id)) continue;
		const row = rows.get(payload.proposal_id);
		if (payload.kind === "campaign.proposal.submitted") {
			Object.assign(row, {
				parent_task_id: payload.proposal?.parent_task_id ?? null,
				proposed_task_id: payload.proposal?.proposed_task_id ?? null,
				reason: payload.proposal?.reason ?? null,
			});
		} else if (["runtime", "human"].includes(event.source?.kind)) {
			const statuses = {
				"campaign.proposal.blocked": "blocked",
				"campaign.proposal.rejected": "rejected",
				"campaign.proposal.admitted": "admitted",
			};
			if (statuses[payload.kind])
				Object.assign(row, { status: statuses[payload.kind], reason: payload.reason ?? row.reason });
		}
	}
	return [...rows.values()];
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

/** A bounded summary of the first E1 explorer page embedded in `/api/view`. */
function boundedExplorerSummary(explorer) {
	return {
		ok: true,
		scope: explorer.scope ?? null,
		total: explorer.total ?? null,
		returned: explorer.returned ?? null,
		offset: explorer.offset ?? null,
		page_size: explorer.page_size ?? null,
		truncated: explorer.truncated === true,
		next_cursor: explorer.next_cursor ?? null,
		filter_digest: explorer.filter_digest ?? null,
		node_total: explorer.node_total ?? null,
		edges: explorer.edges
			? {
					total: explorer.edges.total,
					returned: explorer.edges.returned,
					truncated: explorer.edges.truncated,
					next_offset: explorer.edges.next_offset,
				}
			: null,
		state_revision: explorer.version?.state_revision ?? null,
		dangling_edges: (explorer.dangling_edges ?? []).length,
		diagnostics: (explorer.diagnostics ?? []).length,
		limits: E1_EXPLORER_LIMITS,
	};
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

/** Render the E1 board, task graph, plan and request panels (escaped). */
function renderE1Panels(view) {
	const graph = view.task_graph ?? {};
	const root = graph.root ?? null;
	const nodes = graph.nodes ?? [];
	const byId = new Map(nodes.map((n) => [n.task_id, n]));
	const children = graph.children ?? {};
	const depEdges = (graph.edges ?? []).filter((e) => e.relation === "depends_on");
	const treeRows = [];
	const walk = (id, depth) => {
		const node = byId.get(id);
		if (!node) return;
		treeRows.push(
			`<li>${escapeHtml("  ".repeat(depth) + node.task_id)} — state=${escapeHtml(node.state)} deps=[${escapeHtml(
				(node.depends_on ?? []).join(", "),
			)}] oracle=[${escapeHtml((node.oracle_refs ?? []).map((o) => o.ref).join(", "))}] ${node.blocked_reason ? `blocked=${escapeHtml(node.blocked_reason)}` : ""}</li>`,
		);
		for (const child of children[id] ?? []) walk(child, depth + 1);
	};
	const rootIds = nodes.filter((n) => !n.parent_task_id || !byId.has(n.parent_task_id)).map((n) => n.task_id);
	for (const id of rootIds) walk(id, 0);

	const boardRows = Object.entries(view.board?.by_type ?? {})
		.map(([type, count]) => `<li>${escapeHtml(type)}: current=${escapeHtml(count)}</li>`)
		.join("");
	const nodeRows = (view.board?.nodes ?? [])
		.map(
			(node) =>
				`<li data-node-id="${escapeHtml(node.node_id)}" data-task="${escapeHtml(node.task_id ?? "")}" data-episode="${escapeHtml(
					node.episode_id ?? "",
				)}"><code>${escapeHtml(node.type)}</code> [${escapeHtml(node.effective_status)}] task=${escapeHtml(
					node.task_id ?? "-",
				)} episode=${escapeHtml(node.episode_id ?? "-")}: ${escapeHtml(node.text)}${node.downgrade_reason ? ` (downgraded: ${escapeHtml(node.downgrade_reason)})` : ""}${node.superseded_by ? ` (superseded by ${escapeHtml(node.superseded_by)})` : ""}<br><small>evidence=${escapeHtml(
					(node.evidence_refs ?? []).map((r) => `${r.ref_type}:${r.ref_id}`).join(", ") || "none",
				)}</small></li>`,
		)
		.join("");
	const depRows = depEdges
		.map((e) => `<li>${escapeHtml(e.from)} → ${escapeHtml(e.to)} (execution prerequisite)</li>`)
		.join("");
	const planRows = [
		...(view.plans?.admitted ?? []).map(
			(p) =>
				`<li>plan ${escapeHtml(p.plan_id)}: admitted ${escapeHtml(p.task_count)} tasks [${escapeHtml((p.task_ids ?? []).join(", "))}]</li>`,
		),
		...(view.plans?.candidates ?? []).map(
			(p) =>
				`<li>candidate ${escapeHtml(p.plan_id)}: ${escapeHtml(p.status)} ${escapeHtml(p.tasks?.length ?? 0)} tasks</li>`,
		),
	].join("");
	const req = view.requests ?? {};
	const reqBlock = `<p>consumed=${escapeHtml(req.consumed?.model_requests ?? 0)} campaign_pending=${escapeHtml(
		(req.campaign_pending ?? []).length,
	)} task_pending=${escapeHtml((req.task_pending ?? []).length)} unresolved=${escapeHtml(req.unresolved ?? 0)}</p>`;

	return `
<h2>Campaign root goal</h2>
<p>${escapeHtml(root?.goal ?? UNKNOWN)} <em>(${escapeHtml(root?.note ?? "root goal container")})</em></p>
<h2>Task tree (split provenance)</h2>
<ul>${treeRows.join("") || "<li>(no tasks)</li>"}</ul>
<h2>Execution dependencies (DAG)</h2>
<ul>${depRows || "<li>(none)</li>"}</ul>
<h2>Plans</h2>
<ul>${planRows || "<li>(no plans)</li>"}</ul>
<h2>Requests</h2>
${reqBlock}
<h2>Whiteboard</h2>
<ul>${boardRows}</ul>
<ul>${nodeRows || "<li>(empty board)</li>"}</ul>
<h2>E1 API</h2>
<ul><li><a href="/api/board">/api/board</a></li><li><a href="/api/task-graph">/api/task-graph</a></li><li><a href="/api/plans">/api/plans</a></li><li><a href="/api/requests">/api/requests</a></li></ul>
<h2>E1 exploration API (bounded, paged, same committed state)</h2>
<ul><li><a href="/api/e1/state">/api/e1/state</a> — state revision and page summary</li><li><a href="/api/e1/board?page_size=25">/api/e1/board</a> — board nodes (type/status/task/episode/q filters, cursor paging)</li><li><a href="/api/e1/graph?page_size=25">/api/e1/graph</a> — task nodes + edges (paged; edge list bounded separately)</li></ul>`;
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
	const proposalRows = (view.proposals ?? [])
		.map(
			(proposal) =>
				`<li>${escapeHtml(proposal.id)}: ${escapeHtml(proposal.status)} parent=${escapeHtml(proposal.parent_task_id ?? "unknown")} ${escapeHtml(proposal.reason ?? "")}</li>`,
		)
		.join("\n");
	const actionRows = (view.actions?.items ?? [])
		.map(
			(action) =>
				`<li>${escapeHtml(action.action_id)} ${escapeHtml(action.action_ref ?? "")} ${escapeHtml(action.status)} ${escapeHtml(action.rejection_reason ?? "")}</li>`,
		)
		.join("\n");
	const outcomeRows = (view.outcomes ?? [])
		.map(
			(outcome) =>
				`<li>${escapeHtml(outcome.outcome_id)} ${escapeHtml(outcome.status)} task=${escapeHtml(outcome.task_id ?? "unknown")} stage=${escapeHtml(outcome.stage_id ?? "unknown")}</li>`,
		)
		.join("\n");
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
	h2>Tasks</h2>
<table><thead><tr><th>task</th><th>evidence</th><th>lifecycle</th><th>stop_reason</th></tr></thead><tbody>
${rows}
</tbody></table>
${renderE1Panels(view)}
${renderE1ExplorerPanel(view)}
<h2>Budget and Sessions</h2>
<pre>${escapeHtml(JSON.stringify({ budget: view.budget, sessions: view.committed_counts?.sessions }, null, 2))}</pre>
<h2>Dynamic proposals</h2><ul>${proposalRows}</ul>
<h2>Actions</h2><ul>${actionRows}</ul>
<h2>Outcomes</h2><ul>${outcomeRows}</ul>
<p>Last committed offset: ${escapeHtml(view.integrity?.last_committed_offset ?? UNKNOWN)}; refreshed: ${escapeHtml(view.generated_at ?? UNKNOWN)}.</p>
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

/**
 * OBS-01: the E1 exploration panel + its client script.
 *
 * The script ONLY issues GET requests to the read-only E1 exploration API. It can
 * refresh on demand, refresh on an interval, STOP refreshing, page forward/back
 * with the cursor, filter, and open a node/edge detail. It never POSTs, never
 * writes, and never calls a model. Every dynamic value is inserted with
 * `textContent`/`createElement` (never `innerHTML`). The script is served as a
 * SEPARATE static asset (`/e1-explorer.js`, `E1_EXPLORER_CLIENT_JS`) so the page
 * itself contains no inline script — the same invariant the XSS tests assert.
 */
function renderE1ExplorerPanel(view) {
	const summary = view.e1_explorer ?? null;
	const revision = typeof view.state_revision === "string" ? view.state_revision : null;
	// The client reads this bootstrap JSON; it carries no secret and is escaped so
	// it cannot close its own <script> element.
	const bootstrap = {
		state_revision: revision,
		truncated: summary?.truncated === true,
		node_total: summary?.node_total ?? null,
		edge_total: summary?.edges?.total ?? null,
		page_size: summary?.page_size ?? null,
	};
	return `
<h2>E1 exploration (bounded, paged, read-only)</h2>
<p>State revision: <code id="e1-revision">${escapeHtml(revision ?? "unavailable")}</code>
 — committed offset <code>${escapeHtml(view.state?.last_committed_offset ?? UNKNOWN)}</code>,
 board digest <code>${escapeHtml(view.state?.board_digest ?? UNKNOWN)}</code>.</p>
<p id="e1-truncation">${summary?.truncated ? `Nodes are truncated at ${escapeHtml(summary.page_size)} of ${escapeHtml(summary.node_total)}; use “Next” or a filter to continue.` : "All E1 nodes fit on this page."}</p>
<div><label for="e1-kind">view</label>
<select id="e1-kind"><option value="graph">task graph</option><option value="board">whiteboard</option></select>
<label for="e1-filter">filter</label><input id="e1-filter" type="text" size="18" placeholder="task id, type, text">
<label for="e1-status">state</label><input id="e1-status" type="text" size="10" placeholder="e.g. ready">
<label for="e1-page-size">page size</label><input id="e1-page-size" type="number" min="1" max="200" value="${escapeHtml(summary?.page_size ?? 50)}">
<button id="e1-apply" type="button">Apply</button>
<button id="e1-prev" type="button" disabled>Previous</button>
<button id="e1-next" type="button" disabled>Next</button>
<button id="e1-refresh" type="button">Refresh now</button>
<label><input id="e1-auto" type="checkbox"> auto-refresh</label>
<button id="e1-stop" type="button">Stop refresh</button></div>
<p id="e1-status-line" aria-live="polite">idle</p>
<pre id="e1-detail" hidden></pre>
<ul id="e1-rows"></ul>
<p id="e1-bootstrap" hidden data-bootstrap="${escapeHtml(escapeForScriptJson(bootstrap))}"></p>`;
}

export { reconstructArtifactIndex };
