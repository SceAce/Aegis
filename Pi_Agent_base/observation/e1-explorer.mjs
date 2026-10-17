// Aegis OBS-01 — bounded, continuable E1 detail exploration.
//
// The E1 view (e1-observation.mjs) shows the board, the task graph, the plans and
// the per-side request accounting. Before this module the view was a single
// bounded page: a large board/graph was truncated with no way to keep looking,
// there was no per-node/per-edge detail, no filter, no client refresh and no
// explicit state revision that a client could compare across pages.
//
// This module adds ONLY the read side of that gap:
//
//   * the WHOLE graph is enumerated once from the SAME committed projection the
//     authority queue uses (buildTaskGraph over projectQueueFromEvents with the
//     artifact index), then paginated/filtered here. A page carries an explicit
//     `total`/`truncated`/`next`/`offsets` block, an opaque `cursor` and a
//     `state_revision` so a later page can be proven to belong to the SAME
//     committed state;
//   * a single node/edge detail carries bounded, redacted fields and explicit
//     foreign/dangling diagnostics (a foreign reference is never resolved to
//     another task's data);
//   * a `since_state_revision` comparison lets a client detect that the committed
//     state moved while it was paging instead of silently stitching two states.
//
// It never mutates state, never writes a control event, never calls a model and
// never runs an adapter/Oracle. Every value returned here is derived from the
// committed EventLog + the immutable Manifest. Truncation is always VISIBLE; a
// page never hides that a larger graph exists.
//
// Pagination is cursor-only (no mutable server state): the cursor is the
// `offset:filter_digest` pair, validated on the next request.

import { artifactIndexFromEvents } from "../campaign/c3-entry.mjs";
import { buildTaskGraph } from "../campaign/e1-task-graph.mjs";
import { projectQueueFromEvents } from "../campaign/projection.mjs";
import { projectBoard } from "../memory/board.mjs";
import { digest } from "../shared/contracts.mjs";
import { redactSecrets } from "./report.mjs";

export const E1_EXPLORER_VERSION = "1.0.0";

/** Hard per-page bounds. A caller may ask for LESS, never for more. */
export const E1_EXPLORER_LIMITS = Object.freeze({
	max_page_size: 200,
	/** Largest node text returned in a detail/detail-backed list row. */
	max_text: 2000,
	/** Bounded list of evidence/source refs per row. */
	max_refs: 50,
	/** Soft cap on the number of edges returned by one page. */
	max_page_edges: 400,
});

/** Filter values that mean "no filter" (never a wildcard match). */
const NULLISH = new Set([null, undefined, "", "undefined", "null"]);

function isQueryString(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 200;
}

/**
 * Parse/validate an exploration query. Query-string values come from an HTTP
 * client and are therefore UNTRUSTED: an unknown key, an out-of-range page size
 * or a malformed cursor is an explicit error, never a silent default.
 *
 * @param {{page?: any, page_size?: any, type?: any, status?: any, task_id?: any,
 *   episode_id?: any, relation?: any, q?: any, cursor?: any, since_state_revision?: any,
 *   kind?: any}} raw
 * @returns {{ok: boolean, query: {edge_offset:number, page:number, page_size:number|null, cursor_offset:number|null, offset:number, type:string|null, status:string|null, task_id:string|null, episode_id:string|null, relation:string|null, q:string|null, kind:string|null, since_state_revision:string|null}|null, errors: string[]}}
 */
export function parseExplorerQuery(raw = {}) {
	const errors = [];
	const allowed = new Set([
		"page",
		"page_size",
		"type",
		"status",
		"task_id",
		"episode_id",
		"relation",
		"q",
		"cursor",
		"since_state_revision",
		"kind",
		"edge_offset",
	]);
	for (const key of Object.keys(raw)) if (!allowed.has(key)) errors.push(`unknown query parameter ${key}`);

	const intParam = (name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
		const value = raw[name];
		if (value === undefined || value === null || value === "") return null;
		const text = String(value);
		if (!/^\d{1,10}$/.test(text)) {
			errors.push(`${name} must be a non-negative integer`);
			return null;
		}
		const parsed = Number.parseInt(text, 10);
		if (parsed < min || parsed > max) {
			errors.push(`${name} must be within [${min}, ${max}]`);
			return null;
		}
		return parsed;
	};
	const strParam = (name) => {
		const value = raw[name];
		if (NULLISH.has(value)) return null;
		const text = String(value);
		if (!isQueryString(text)) {
			errors.push(`${name} must be a bounded non-empty string`);
			return null;
		}
		return text;
	};

	const page = intParam("page");
	const pageSize = intParam("page_size", { min: 1, max: E1_EXPLORER_LIMITS.max_page_size });
	const cursor = strParam("cursor");
	let cursorOffset = null;
	if (cursor) {
		const match = /^off:(\d{1,10}):f:([0-9a-f]{16})$/.exec(cursor);
		if (!match) errors.push("cursor is malformed");
		else cursorOffset = Number.parseInt(match[1], 10);
	}
	const since = strParam("since_state_revision");
	const query = {
		edge_offset: intParam("edge_offset") ?? 0,
		page: page ?? 0,
		page_size: pageSize,
		cursor_offset: cursorOffset,
		offset: cursorOffset ?? (page ?? 0) * (pageSize ?? E1_EXPLORER_LIMITS.max_page_size),
		type: strParam("type"),
		status: strParam("status"),
		task_id: strParam("task_id"),
		episode_id: strParam("episode_id"),
		relation: strParam("relation"),
		q: strParam("q"),
		kind: strParam("kind"),
		since_state_revision: since,
	};
	if (query.relation && !["depends_on", "parent_of"].includes(query.relation))
		errors.push("relation must be depends_on or parent_of");
	if (query.kind && !["board", "graph"].includes(query.kind)) errors.push("kind must be board or graph");
	if (errors.length > 0) return { ok: false, query: null, errors };
	return { ok: true, query, errors: [] };
}

/** The identity of the committed state a page was computed from. */
export function stateIdentity({ projection, graph, boardDigest }) {
	const state = {
		manifest_revision: projection?.revision ?? null,
		last_committed_offset: projection?.tail_offset ?? null,
		last_committed_digest: projection?.tail_digest ?? null,
		last_applied_offset: projection?.last_applied_offset ?? null,
		last_applied_event_id: projection?.last_applied_event_id ?? null,
		event_count: projection?.tail_offset != null ? projection.tail_offset + 1 : 0,
		board_digest: boardDigest ?? null,
		graph_counts: {
			tasks: graph?.counts?.tasks ?? null,
			edges: graph?.counts?.edges ?? null,
			dependency_edges: graph?.counts?.dependency_edges ?? null,
			parent_edges: graph?.counts?.parent_edges ?? null,
		},
	};
	return { ...state, revision: revisionOf(state) };
}

function revisionOf(state) {
	return digest({
		manifest_revision: state.manifest_revision ?? null,
		last_committed_digest: state.last_committed_digest ?? null,
		last_committed_offset: state.last_committed_offset ?? null,
		board_digest: state.board_digest ?? null,
	});
}

/** True when a graph filter is active (used to decide the node universe). */
function hasTaskFilter(query) {
	return Boolean(query?.task_id || query?.episode_id || query?.q || query?.status);
}

function literalMatches(haystack, needle) {
	if (!needle) return true;
	return String(haystack ?? "")
		.toLowerCase()
		.includes(String(needle).toLowerCase());
}

function boundedRefs(list, limits) {
	const refs = Array.isArray(list) ? list : [];
	return {
		items: refs.slice(0, limits.max_refs),
		total: refs.length,
		truncated: refs.length > limits.max_refs,
	};
}

/** A bounded task-graph node detail row. */
function taskDetail(node, graph, { limits, incidentEdges }) {
	const outgoing = incidentEdges.outgoing.get(node.task_id) ?? [];
	const incoming = incidentEdges.incoming.get(node.task_id) ?? [];
	const text = (value) => (typeof value === "string" ? value.slice(0, limits.max_text) : value);
	return redactSecrets({
		kind: "task",
		node_id: node.node_id,
		task_id: node.task_id,
		goal: text(node.goal),
		goal_id: node.goal_id,
		success_criteria: (node.success_criteria ?? []).map((criterion) => text(criterion)),
		target_ref: node.target_ref,
		task_type: node.task_type,
		template_ref: node.template_ref,
		parent_task_id: node.parent_task_id,
		parent_known:
			node.parent_task_id === null || node.parent_task_id === undefined
				? null
				: graph.nodes.some((candidate) => candidate.task_id === node.parent_task_id),
		depends_on: [...(node.depends_on ?? [])],
		unsatisfied_dependencies: [...(node.unsatisfied_dependencies ?? [])],
		dependencies_satisfied: node.dependencies_satisfied === true,
		is_dynamic: node.is_dynamic === true,
		state: node.state,
		lifecycle_state: node.lifecycle_state,
		plan_id: node.plan_id,
		planning_task_id: node.planning_task_id,
		admission_source: node.admission_source,
		episode_id: node.episode_id,
		session_id: node.session_id,
		evidence_status: node.evidence_status,
		outcome_ref: node.outcome_ref,
		stop_reason: node.stop_reason,
		blocked_reason: node.blocked_reason,
		budget_reservation: node.budget_reservation,
		budget_consumed: node.budget_consumed,
		oracle_refs: boundedRefs(node.oracle_refs, limits),
		incident_edges: {
			outgoing: outgoing.slice(0, limits.max_refs),
			incoming: incoming.slice(0, limits.max_refs),
			total_outgoing: outgoing.length,
			total_incoming: incoming.length,
		},
	});
}

function edgeRow(edge, knownIds) {
	return {
		edge_id: `${edge.from}->${edge.to}:${edge.relation}`,
		from: edge.from,
		to: edge.to,
		relation: edge.relation,
		from_known: knownIds.has(edge.from.replace(/^task:/, "")),
		to_known: knownIds.has(edge.to.replace(/^task:/, "")),
	};
}

function indexEdges(edges) {
	const outgoing = new Map();
	const incoming = new Map();
	const strip = (nodeId) => String(nodeId ?? "").replace(/^task:/, "");
	for (const edge of edges) {
		const from = strip(edge.from);
		const to = strip(edge.to);
		if (!outgoing.has(from)) outgoing.set(from, []);
		outgoing
			.get(from)
			.push({ edge_id: `${edge.from}->${edge.to}:${edge.relation}`, to, relation: edge.relation, direction: "out" });
		if (!incoming.has(to)) incoming.set(to, []);
		incoming
			.get(to)
			.push({ edge_id: `${edge.from}->${edge.to}:${edge.relation}`, from, relation: edge.relation, direction: "in" });
	}
	return { outgoing, incoming };
}

function pageSlice({ items, offset, limit }) {
	const total = items.length;
	const start = Math.min(Math.max(0, Number.isInteger(offset) ? offset : 0), total);
	const page = items.slice(start, start + limit);
	const end = start + page.length;
	return {
		items: page,
		total,
		returned: page.length,
		offset: start,
		limit,
		truncated: end < total,
		next_offset: end < total ? end : null,
		prev_offset: start > 0 ? Math.max(0, start - limit) : null,
	};
}

/**
 * Build one bounded exploration page.
 *
 * @param {{
 *   manifest: any,
 *   events?: any[],
 *   board?: {nodes?: any[], digest?: string|null, truncated?: boolean}|null,
 *   query?: any,
 *   limits?: any,
 *   integrityOk?: boolean,
 *   authorityProjection?: any,
 * }} args
 */
export function buildE1Explorer(
	{
		manifest,
		events = [],
		board = null,
		query = {},
		limits = E1_EXPLORER_LIMITS,
		integrityOk = true,
		authorityProjection = null,
	} = /** @type {any} */ ({}),
) {
	limits = { ...E1_EXPLORER_LIMITS, ...limits };
	const parsed = parseExplorerQuery(query ?? {});
	if (!parsed.ok) return { ok: false, errors: parsed.errors };
	const q = parsed.query;
	if (query.cursor) {
		const filter = Object.fromEntries(
			["task_id", "episode_id", "status", "type", "relation", "q", "kind"].map((key) => [key, q[key]]),
		);
		if (
			query.cursor.split(":").at(-1) !==
			digest(filter)
				.replace(/^sha256:/, "")
				.slice(0, 16)
		)
			return { ok: false, errors: ["cursor filter mismatch"] };
	}
	if (board?.truncated || !board) board = projectBoard(events, { manifest });

	// The SAME trusted artifact-aware replay the authority queue/scheduler use.
	const projection =
		authorityProjection ??
		projectQueueFromEvents({
			campaign_id: manifest?.campaign_id,
			tasks: manifest?.tasks ?? [],
			events,
			revision: manifest?.revision ?? 0,
			manifest,
			artifacts: Object.fromEntries(artifactIndexFromEvents(events)),
		});
	const graph = buildTaskGraph({
		manifest,
		projection,
		reconciliation: null,
		// The graph is built COMPLETE so `total` is the REAL total; only the page is
		// bounded below. Passing a smaller max_tasks here would make `total` a lie.
		limits: { max_tasks: Number.MAX_SAFE_INTEGER, max_children: Number.MAX_SAFE_INTEGER },
	});
	const knownIds = new Set(graph.nodes.map((node) => ("task_id" in node ? node.task_id : null)));
	const edgeRows = graph.edges.map((edge) => edgeRow(edge, knownIds));
	const incident = indexEdges(graph.edges);
	const state = stateIdentity({ projection, graph, boardDigest: board?.digest ?? null });
	const stateRevision = state.revision;

	const scope = q.kind ?? (q.relation || q.task_id ? "graph" : "board");

	if (scope === "graph" || q.kind === "graph") {
		return graphPage({
			graph,
			edgeRows,
			incident,
			knownIds,
			state,
			stateRevision,
			query: q,
			limits,
			integrityOk,
			manifest,
		});
	}
	return boardPage({ board, state, stateRevision, query: q, limits, integrityOk, manifest });
}

function versionBlock({ state, stateRevision, query }) {
	const since = query.since_state_revision ?? null;
	return {
		state_revision: stateRevision,
		since_state_revision: since,
		// A client that supplies the revision it started from is told explicitly
		// whether the committed state moved. Paging across a changed state is
		// visible, never silent.
		state_changed: since === null ? null : since !== stateRevision,
		state,
	};
}

function paginationBlock({ items, query, extra = {} }) {
	const filter = {
		task_id: query.task_id,
		episode_id: query.episode_id,
		status: query.status,
		type: query.type,
		relation: query.relation,
		q: query.q,
		kind: query.kind,
	};
	const page = pageSlice({ items, offset: query.offset, limit: query.page_size ?? E1_EXPLORER_LIMITS.max_page_size });
	return {
		ok: true,
		total: page.total,
		returned: page.returned,
		offset: page.offset,
		page_size: page.limit,
		truncated: page.truncated,
		next_cursor:
			page.next_offset === null
				? null
				: `off:${page.next_offset}:f:${digest(filter)
						.replace(/^sha256:/, "")
						.slice(0, 16)}`,
		prev_offset: page.prev_offset,
		filter,
		filter_digest: digest(filter),
		...extra,
	};
}

function boardPage({ board, state, stateRevision, query, limits, integrityOk, manifest }) {
	const nodes = Array.isArray(board?.nodes) ? board.nodes : [];
	const filtered = nodes.filter((node) => {
		if (query.type && node.type !== query.type) return false;
		if (query.status && (node.effective_status ?? node.status) !== query.status) return false;
		if (query.task_id && node.task_id !== query.task_id) return false;
		if (query.episode_id && node.episode_id !== query.episode_id) return false;
		if (
			query.q &&
			!literalMatches(`${node.node_id ?? ""} ${node.text ?? ""} ${node.type ?? ""} ${node.task_id ?? ""}`, query.q)
		)
			return false;
		return true;
	});
	const rows = filtered.map((node) =>
		redactSecrets({ ...node, text: typeof node.text === "string" ? node.text.slice(0, limits.max_text) : null }),
	);
	const paging = paginationBlock({ items: rows, query });
	return {
		...paging,
		schema_version: E1_EXPLORER_VERSION,
		scope: "board",
		integrity: { event_chain_ok: integrityOk },
		campaign_id: manifest?.campaign_id ?? null,
		version: versionBlock({ state, stateRevision, query }),
		nodes:
			paging.returned === rows.length && paging.offset === 0
				? rows
				: rows.slice(paging.offset, paging.offset + paging.page_size),
		types: summarizeValues(nodes.map((node) => node.type)),
	};
}

function graphPage({
	graph,
	edgeRows,
	incident,
	knownIds,
	state,
	stateRevision,
	query,
	limits,
	integrityOk,
	manifest,
}) {
	const nodeSummaries = graph.nodes.map((node) => ({
		node_id: node.node_id,
		task_id: node.task_id,
		goal: typeof node.goal === "string" ? node.goal.slice(0, limits.max_text) : node.goal,
		state: node.state,
		lifecycle_state: node.lifecycle_state,
		task_type: node.task_type,
		parent_task_id: node.parent_task_id,
		depends_on: [...(node.depends_on ?? [])],
		unsatisfied_dependencies: [...(node.unsatisfied_dependencies ?? [])],
		episode_id: node.episode_id,
		is_dynamic: node.is_dynamic === true,
		plan_id: node.plan_id,
		evidence_status: node.evidence_status,
		stop_reason: node.stop_reason,
	}));

	// `task_id` acts as a FOCUS filter for the graph: the named task plus its
	// immediate incident edges (and, with `q`/`status`, only matching nodes).
	const filteredNodes = nodeSummaries.filter((node) => {
		if (query.task_id && node.task_id !== query.task_id) return false;
		if (query.episode_id && node.episode_id !== query.episode_id) return false;
		if (query.status && node.state !== query.status) return false;
		if (query.q && !literalMatches(`${node.task_id} ${node.goal ?? ""} ${node.task_type ?? ""}`, query.q)) return false;
		return true;
	});
	const filteredEdges = edgeRows.filter((edge) => {
		if (query.relation && edge.relation !== query.relation) return false;
		if (query.task_id) {
			const focus = `task:${query.task_id}`;
			if (edge.from !== focus && edge.to !== focus) return false;
		}
		return true;
	});

	// A detail request: one node with its bounded incident edges.
	if (query.task_id && !hasTaskFilter({ ...query, task_id: null })) {
		const node = graph.nodes.find((candidate) => candidate.task_id === query.task_id);
		if (!node) {
			return {
				ok: false,
				status: "not_found",
				scope: "graph",
				error: "unknown_node",
				task_id: query.task_id,
				// A foreign ref is a 404 with an explicit reason, never another node's data.
				foreign_reference: true,
				version: versionBlock({ state, stateRevision, query }),
			};
		}
		const paging = paginationBlock({ items: graph.nodes, query: { ...query, task_id: null } });
		return {
			...paging,
			schema_version: E1_EXPLORER_VERSION,
			scope: "graph_detail",
			integrity: { event_chain_ok: integrityOk },
			campaign_id: manifest?.campaign_id ?? null,
			version: versionBlock({ state, stateRevision, query }),
			root: graph.root,
			detail: taskDetail(node, graph, { limits, incidentEdges: incident }),
			diagnostics: graph.diagnostics.slice(0, 50),
		};
	}

	// An explicit EDGE detail request: `<from>-><to>` in `q`.
	if (query.relation && query.q && /^[a-z0-9:_-]+->[a-z0-9:_-]+$/i.test(query.q)) {
		const edgeId = `${query.q}:${query.relation}`;
		const edge = edgeRows.find((candidate) => candidate.edge_id === edgeId);
		if (!edge) {
			return {
				ok: false,
				status: "not_found",
				scope: "edge_detail",
				error: "unknown_edge",
				edge: query.q,
				foreign_reference: true,
				version: versionBlock({ state, stateRevision, query }),
			};
		}
		const fromNode = graph.nodes.find((node) => `task:${node.task_id}` === edge.from);
		const toNode = graph.nodes.find((node) => `task:${node.task_id}` === edge.to);
		return {
			schema_version: E1_EXPLORER_VERSION,
			scope: "edge_detail",
			integrity: { event_chain_ok: integrityOk },
			campaign_id: manifest?.campaign_id ?? null,
			version: versionBlock({ state, stateRevision, query }),
			edge: {
				...edge,
				prerequisite_satisfied:
					edge.relation === "depends_on"
						? !(toNode?.unsatisfied_dependencies ?? []).includes(edge.from.replace(/^task:/, ""))
						: null,
			},
			from: fromNode ? taskDetail(fromNode, graph, { limits, incidentEdges: incident }) : null,
			to: toNode ? taskDetail(toNode, graph, { limits, incidentEdges: incident }) : null,
		};
	}

	const nodePaging = paginationBlock({ items: filteredNodes, query });
	const edgePaging = pageSlice({ items: filteredEdges, offset: query.edge_offset ?? 0, limit: limits.max_page_edges });
	const dangling = edgeRows.filter((edge) => !edge.from_known || !edge.to_known);
	return {
		...nodePaging,
		schema_version: E1_EXPLORER_VERSION,
		scope: "graph",
		integrity: { event_chain_ok: integrityOk },
		campaign_id: manifest?.campaign_id ?? null,
		version: versionBlock({ state, stateRevision, query }),
		root: graph.root,
		counts: graph.counts,
		nodes: filteredNodes.slice(nodePaging.offset, nodePaging.offset + nodePaging.page_size),
		node_total: filteredNodes.length,
		edges: {
			items: edgePaging.items,
			total: edgePaging.total,
			returned: edgePaging.returned,
			truncated: edgePaging.truncated,
			next_offset: edgePaging.next_offset,
		},
		dangling_edges: dangling.slice(0, 50),
		diagnostics: graph.diagnostics.slice(0, 50),
		known_task_ids: knownIds.size,
	};
}

function summarizeValues(values) {
	const counts = {};
	for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
	return counts;
}

/**
 * Compare two state identities: did the committed stream move between pages?
 * A changed digest, offset, board digest or manifest revision is a change.
 */
export function compareStateRevisions(before, after) {
	if (!before || !after) return { changed: null, reasons: ["missing state"] };
	const reasons = [];
	for (const key of ["last_committed_digest", "last_committed_offset", "board_digest", "manifest_revision"]) {
		if ((before[key] ?? null) !== (after[key] ?? null)) reasons.push(`${key} changed`);
	}
	return { changed: reasons.length > 0, reasons };
}
