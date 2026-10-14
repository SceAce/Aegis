// Aegis E1 — observable board, task graph, plan and request panels.
//
// PURE. From the SAME committed inputs (Manifest + EventLog) this derives the
// four E1 panels the observation page/API expose:
//
//   * board          — the six whiteboard node classes with content, evidence,
//                      Task/Episode binding, current/history status and reasons;
//   * task_graph     — the root goal container, the parent tree and the
//                      execution dependency DAG (see e1-task-graph.mjs);
//   * plans          — submitted/admitted/blocked/rejected candidate plans;
//   * requests       — the true per-side request accounting (consumed/pending/
//                      unresolved) from the request lifecycle summary.
//
// It reuses `projectBoard`, `projectQueueFromEvents` and
// `summarizeRequestLedger`; it never treats a snapshot, HTML or report as the
// authoritative source and never mutates anything.

import { projectBoard, summarizeBoard } from "../runtime/board.mjs";
import { artifactIndexFromEvents } from "./c3-entry.mjs";
import { summarizeRequestLedger } from "./c6-request-lifecycle.mjs";
import { buildTaskGraph } from "./e1-task-graph.mjs";
import { projectQueueFromEvents } from "./projection.mjs";
import { redactSecrets } from "./report.mjs";

export const E1_VIEW_VERSION = "1.0.0";

export const E1_LIMITS = Object.freeze({
	max_nodes: 500,
	max_node_text: 2000,
	max_edges: 1000,
	max_plans: 100,
	max_tasks: 400,
});

/** The board node fields exposed per node (bounded, redacted). */
function boardNode(node, limits) {
	const text = typeof node.text === "string" ? node.text.slice(0, limits.max_node_text) : String(node.text ?? "");
	return redactSecrets({
		node_id: node.node_id,
		type: node.type,
		text,
		text_truncated: typeof node.text === "string" && node.text.length > limits.max_node_text,
		status: node.status,
		effective_status: node.effective_status ?? (node.effective === false ? "retired" : "current"),
		effective: node.effective !== false,
		task_id: node.task_id ?? null,
		episode_id: node.episode_id ?? null,
		episode_ref: node.episode_id ? `episode:${node.episode_id}` : null,
		origin_event_id: node.origin_event_id ?? null,
		source_refs: node.source_refs ?? [],
		evidence_refs: node.evidence_refs ?? [],
		unresolved_evidence_refs: node.unresolved_evidence_refs ?? [],
		criterion: node.criterion ?? null,
		observed: node.observed ?? null,
		outcome_id: node.outcome_id ?? null,
		superseded_by: node.superseded_by ?? null,
		supersede_reason: node.supersede_reason ?? null,
		downgraded_from: node.downgraded_from ?? null,
		downgrade_reason: node.downgrade_reason ?? null,
		scope: node.scope ?? null,
		created_at: node.created_at ?? null,
	});
}

/**
 * Build the E1 panels from the authoritative inputs.
 *
 * @param {{
 *   manifest: any,
 *   events?: any[],
 *   limits?: any,
 *   integrityOk?: boolean,
 * }} args
 */
export function buildE1View(
	{ manifest, events = [], limits = E1_LIMITS, integrityOk = true } = /** @type {any} */ ({}),
) {
	limits = { ...E1_LIMITS, ...limits };
	const board = projectBoard(events, { manifest });
	const boardNodes = board.nodes.slice(0, limits.max_nodes).map((node) => boardNode(node, limits));
	const boardDigest = board.digest;
	const boardEffectiveDigest = board.effective_digest;

	const projection = projectQueueFromEvents({
		campaign_id: manifest.campaign_id,
		tasks: manifest.tasks ?? [],
		events,
		revision: manifest.revision ?? 0,
		manifest,
		// E1: the SAME trusted artifact-aware replay the authority queue and the
		// scheduler use. Without it a real Oracle evidence ref never resolves and the
		// view would drift from the committed truth.
		artifacts: Object.fromEntries(artifactIndexFromEvents(events)),
	});
	const graph = buildTaskGraph({ manifest, projection, reconciliation: null, limits: { max_tasks: limits.max_tasks } });

	const requestLedger = summarizeRequestLedger(events);
	const requests = {
		consumed: requestLedger.consumed,
		by_task: Object.fromEntries([...requestLedger.byTask.entries()]),
		campaign_pending: requestLedger.campaignPending,
		task_pending: requestLedger.taskPending,
		unresolved: requestLedger.unresolved,
		diagnostics: requestLedger.diagnostics.slice(0, 50),
	};

	const plans = projection.plans ?? [];
	const planRows = plans.slice(0, limits.max_plans).map((plan) => ({
		plan_id: plan.id ?? null,
		status: plan.status ?? "submitted",
		digest: plan.digest ?? null,
		task_ids: Array.isArray(plan.normalized) ? plan.normalized : [],
		task_count: Array.isArray(plan.normalized) ? plan.normalized.length : 0,
		planning_task_id: plan.planning_task_id ?? null,
	}));
	// Candidate (submitted-not-admitted) plan tasks, derived from the committed
	// plan events so the page can show submitted/blocked/rejected candidates.
	const candidates = [];
	for (const event of events) {
		const payload = event?.payload ?? {};
		if (payload.kind !== "campaign.plan.submitted" || !payload.plan) continue;
		candidates.push({
			plan_id: payload.plan_id ?? null,
			status: "submitted",
			tasks: (payload.plan.tasks ?? []).map((task) => ({
				proposed_task_id: task?.proposed_task_id ?? null,
				parent_task_id: task?.parent_task_id ?? null,
				depends_on: [...(task?.depends_on ?? [])],
				task_type: task?.task_type ?? null,
				target_ref: task?.target_ref ?? null,
			})),
		});
	}
	for (const event of events) {
		const payload = event?.payload ?? {};
		const statuses = {
			"campaign.plan.blocked": "blocked",
			"campaign.plan.rejected": "rejected",
			"campaign.plan.admitted": "admitted",
		};
		if (!statuses[payload.kind]) continue;
		const candidate = candidates.find((entry) => entry.plan_id === payload.plan_id);
		if (candidate) candidate.status = statuses[payload.kind];
	}

	return {
		schema_version: E1_VIEW_VERSION,
		integrity: { event_chain_ok: integrityOk, board_digest: boardDigest, board_effective_digest: boardEffectiveDigest },
		board: {
			nodes: boardNodes,
			by_type: Object.fromEntries(Object.entries(board.currentByType).map(([type, list]) => [type, list.length])),
			history_by_type: Object.fromEntries(Object.entries(board.byType).map(([type, list]) => [type, list.length])),
			summary: summarizeBoard(board),
			rejections: board.rejections.slice(0, 50),
			truncated: board.nodes.length > limits.max_nodes,
		},
		task_graph: graph,
		plans: { admitted: planRows, candidates },
		requests,
	};
}
