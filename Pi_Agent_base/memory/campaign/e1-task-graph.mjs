// Aegis E1 — task structure projection for the observation view.
//
// PURE. It turns the committed projection (tasks, queue items, admitted dynamic
// definitions, control state) into a bounded, first-class TASK STRUCTURE:
//
//   * the Campaign root-goal container (never an execution Task);
//   * the parent/child hierarchy (split provenance);
//   * the execution dependency DAG (predecessor -> successor);
//   * per-task status, budget, oracle refs, blockers and evidence links.
//
// `parent_task_id` and `depends_on` come from the SAME committed definitions the
// Scheduler dispatches from, so the tree and the DAG never drift from execution.
// They are rendered as TWO separate relations; a multi-prerequisite edge is never
// swallowed by the tree layout.

const UNKNOWN = "unknown";

/**
 * @param {{
 *   manifest: any,
 *   projection: any,
 *   reconciliation?: {unresolved_requests?: number, blocked?: boolean, diagnostics?: any[]}|null,
 *   limits?: {max_tasks?: number, max_children?: number},
 * }} args
 * @returns {{
 *   campaign_id: string|null, root: object, nodes: object[], edges: object[],
 *   children: object, prerequisites: object, counts: object, diagnostics: object[],
 *   reconciliation: {unresolved_requests: number, blocked: boolean, diagnostics: any[]},
 * }}
 */
export function buildTaskGraph({ manifest, projection, reconciliation = null, limits = {} } = /** @type {any} */ ({})) {
	const maxTasks = Number.isInteger(limits.max_tasks) ? limits.max_tasks : 400;
	const rows = Array.isArray(projection?.tasks) ? projection.tasks : [];
	const taskById = new Map(rows.map((row) => [row.task_id, row]));
	const staticById = new Map((manifest?.tasks ?? []).map((task) => [task.task_id, task]));

	/** Resolve the definition used both for dispatch and for rendering. */
	function definitionOf(row) {
		return row?.definition ?? staticById.get(row.task_id) ?? null;
	}
	function dependsOnOf(row) {
		const definition = definitionOf(row);
		// The definition is authoritative (dynamic definitions carry depends_on); the
		// queue row mirrors it. Use the definition, fall back to the row.
		const fromDefinition = Array.isArray(definition?.depends_on) ? definition.depends_on : null;
		if (fromDefinition) return [...fromDefinition];
		return Array.isArray(row?.depends_on) ? [...row.depends_on] : [];
	}
	function parentOf(row) {
		const definition = definitionOf(row);
		return row?.parent_task_id ?? definition?.parent_task_id ?? null;
	}

	const rootGoal = manifest?.objective?.description ?? manifest?.title ?? "(no root goal declared)";
	const root = {
		node_id: "goal:campaign-root",
		kind: "goal_container",
		campaign_id: manifest?.campaign_id ?? null,
		goal: rootGoal,
		success_criteria: [...(manifest?.objective?.success_criteria ?? [])],
		executable: false,
		// The root container is NOT an execution task and never pretends to be one.
		note: "Campaign root goal container (not an execution Task)",
	};

	const nodes = [];
	/** @type {Record<string, string[]>} */
	const children = {};
	/** @type {Record<string, string[]>} */
	const prerequisites = {};
	const diagnostics = [];

	for (const row of rows.slice(0, maxTasks)) {
		const definition = definitionOf(row);
		const depends = dependsOnOf(row);
		const parent = parentOf(row);
		const criteria = (definition?.goal?.success_criteria ?? []).map(String);
		nodes.push({
			node_id: `task:${row.task_id}`,
			kind: "task",
			task_id: row.task_id,
			goal: definition?.goal?.description ?? definition?.goal?.goal_id ?? null,
			goal_id: definition?.goal?.goal_id ?? null,
			success_criteria: criteria,
			target_ref: definition?.target_ref ?? row.target_ref ?? null,
			task_type: definition?.task_type ?? null,
			template_ref: definition?.template_ref ?? null,
			parent_task_id: parent,
			depends_on: depends,
			is_dynamic: row.is_dynamic === true,
			state: row.state ?? UNKNOWN,
			lifecycle_state: row.lifecycle_state ?? null,
			plan_id: definition?.plan_id ?? null,
			planning_task_id: definition?.planning_task_id ?? null,
			admission_source: row.is_dynamic ? "model_plan" : "manifest",
			episode_id: row.episode_id ?? `ep-${row.task_id}`,
			session_id: row.session_id ?? null,
			budget_reservation: row.reservation ?? definition?.budget_reservation ?? null,
			budget_consumed: row.budget_consumed ?? null,
			oracle_refs: collectOracleRefs(row, definition),
			evidence_status: collectEvidenceStatus(row),
			outcome_ref: row.task_outcome_ref ?? null,
			stop_reason: row.stop_reason ?? null,
			blocked_reason: row.state === "blocked" ? (row.stop_reason ?? "blocked") : null,
			dependencies_satisfied: depends.length === 0 ? true : unresolvedDeps(depends, taskById).length === 0,
			unsatisfied_dependencies: unresolvedDeps(depends, taskById),
		});
	}
	if (rows.length > maxTasks) diagnostics.push({ code: "tasks_truncated", total: rows.length, returned: maxTasks });

	// Two SEPARATE relations.
	for (const node of nodes) {
		children[node.task_id] = [];
		prerequisites[node.task_id] = node.depends_on;
	}
	for (const node of nodes) {
		const parent = node.parent_task_id;
		if (parent && parent !== node.task_id) {
			if (children[parent]) children[parent].push(node.task_id);
			else if (parent !== "goal:campaign-root") {
				// parent refers to the planning task or another known task id.
				children[parent] = children[parent] ?? [];
				children[parent].push(node.task_id);
			}
		}
	}

	// Dependency edges: prerequisite -> successor. Real edges only; a dangling
	// dependency yields a diagnostic, never a fake edge to a missing node.
	const edges = [];
	const knownIds = new Set(nodes.map((n) => n.task_id));
	for (const node of nodes) {
		for (const dep of node.depends_on) {
			if (knownIds.has(dep)) edges.push({ from: `task:${dep}`, to: `task:${node.task_id}`, relation: "depends_on" });
			else diagnostics.push({ code: "dangling_dependency", task_id: node.task_id, dependency: dep });
		}
		if (node.parent_task_id && knownIds.has(node.parent_task_id))
			edges.push({ from: `task:${node.parent_task_id}`, to: `task:${node.task_id}`, relation: "parent_of" });
	}

	const byState = {};
	for (const node of nodes) byState[node.state] = (byState[node.state] ?? 0) + 1;

	const counts = {
		tasks: nodes.length,
		by_state: byState,
		dynamic: nodes.filter((n) => n.is_dynamic).length,
		static: nodes.filter((n) => !n.is_dynamic).length,
		edges: edges.length,
		dependency_edges: edges.filter((e) => e.relation === "depends_on").length,
		parent_edges: edges.filter((e) => e.relation === "parent_of").length,
		multi_prerequisite: nodes.filter((n) => n.depends_on.length > 1).length,
	};

	return {
		campaign_id: manifest?.campaign_id ?? null,
		root,
		nodes,
		edges,
		children,
		prerequisites,
		counts,
		diagnostics,
		reconciliation: reconciliation
			? {
					unresolved_requests: reconciliation.unresolved_requests ?? 0,
					blocked: reconciliation.blocked === true,
					diagnostics: reconciliation.diagnostics ?? [],
				}
			: { unresolved_requests: 0, blocked: false, diagnostics: [] },
	};
}

/** Dependencies of `taskId` that are not yet satisfied by a trusted completion. */
function unresolvedDeps(depIds, taskById) {
	const unsatisfied = [];
	for (const dep of depIds) {
		const row = taskById.get(dep);
		if (!row) {
			unsatisfied.push(dep);
			continue;
		}
		const trustedComplete =
			row.state === "completed" && (row.task_outcome_status === "success" || row.task_outcome_ref);
		if (!trustedComplete) unsatisfied.push(dep);
	}
	return unsatisfied;
}

function collectOracleRefs(row, definition) {
	const refs = [];
	if (definition?.oracle_ref) refs.push({ kind: "task", ref: definition.oracle_ref });
	for (const stage of definition?.stages ?? []) {
		for (const stageOutcome of row.stage_outcomes ?? []) {
			if (stageOutcome.stage_id === stage.stage_id && stageOutcome.outcome_id)
				refs.push({ kind: "stage", ref: stageOutcome.outcome_id, stage_id: stage.stage_id });
		}
	}
	if (row.task_outcome_ref) refs.push({ kind: "task_outcome", ref: row.task_outcome_ref });
	return refs;
}

function collectEvidenceStatus(row) {
	if (row.task_outcome_status === "success") return "verified";
	if (row.task_outcome_status === "failure") return "refuted";
	if (row.state === "completed") return "completed_no_evidence";
	if (row.state === "unknown") return "unknown";
	if (row.state === "failed") return "failed";
	return "pending";
}

/** A bounded tree rendering (pre-order) for the HTML/API tree panel. */
export function renderTaskTree(graph, { max_children = 100 } = {}) {
	const byId = new Map(graph.nodes.map((n) => [n.task_id, n]));
	const roots = graph.nodes.filter((n) => !n.parent_task_id || !byId.has(n.parent_task_id)).map((n) => n.task_id);
	const order = [];
	const seen = new Set();
	const walk = (id, depth) => {
		if (seen.has(id) || depth > 32) return;
		seen.add(id);
		order.push({ task_id: id, depth });
		const kids = (graph.children[id] ?? []).slice(0, max_children);
		for (const child of kids) walk(child, depth + 1);
	};
	for (const id of roots) walk(id, 0);
	return { order, roots };
}
