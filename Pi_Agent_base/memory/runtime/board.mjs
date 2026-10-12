// Aegis board: a deterministic, read-only projection of the event log into a
// six-node graph. It is a COORDINATION view, not a second truth authority.
//
// Node types (user decision 1):
//   Origin | Fact | Refuted | Intent | Hint | Artifact
//
// Write permission (user decision 2): only a trusted source kind
// (`oracle` / `human`) may create a `Fact` or `Refuted` node. LLM proposals can
// only ever become `Hint` (claim/candidate) or `Intent`. A model that claims
// `fact`/`active`/`authorization` is downgraded or rejected; it can never write
// verified state.
//
// Two views are projected from the SAME immutable event history:
//   * `byType` / `nodes`   — every historical node, auditable forever.
//   * `currentByType`      — the EFFECTIVE view: nodes that are still in force.
//
// A later canonical Outcome may retire an earlier one within the same Episode
// via `payload.supersedes`. Only a legitimate, trustworthy supersede with a
// matching criterion/scope/subject may remove a Fact from the effective view;
// an `llm`, `foreign`, `cycle`, or `missing` reference is recorded as an invalid
// supersede and changes nothing. A trusted `environment.changed` marks related
// Fact/Refuted bindings stale rather than deleting history. A superseding
// `unknown` still makes the prior Fact exit the current effective view while
// adding no new Fact.
//
// Nodes keep their STRUCTURED fields (`observed`, `criterion`, `ref`s), not just
// their rendered text, so the effective view is derived from data, not prose.

import { digest } from "./events.mjs";

export const NODE_TYPES = ["Origin", "Fact", "Refuted", "Intent", "Hint", "Artifact"];

/** Source kinds allowed to write verified Fact/Refuted nodes. */
export const TRUSTED_KINDS = new Set(["oracle", "human"]);

/**
 * Normalize an evidence reference. MEMORY_SCHEMA §2.1 requires an object
 * `{ref_type, ref_id, digest?}`; a bare string is accepted only as an explicit
 * `external` reference and is NEVER treated as a local node id. This prevents
 * a bogus graph edge pointing at a non-existent node.
 *
 * @returns {{ref_type: string, ref_id: string, digest?: string} | null}
 */
export function normalizeRef(ref) {
	if (typeof ref === "string") {
		const refId = ref.trim();
		if (!refId) return null;
		return { ref_type: "external", ref_id: refId };
	}
	if (ref && typeof ref === "object" && !Array.isArray(ref)) {
		const refType = typeof ref.ref_type === "string" ? ref.ref_type.trim() : "";
		const refId = typeof ref.ref_id === "string" ? ref.ref_id.trim() : "";
		if (!refType || !refId) return null;
		return {
			ref_type: refType,
			ref_id: refId,
			...(typeof ref.digest === "string" && ref.digest ? { digest: ref.digest } : {}),
		};
	}
	return null;
}

/**
 * Decide whether an `outcome.recorded` payload is a complete, auditable
 * Outcome that may create a verified Fact/Refuted node.
 *
 * MEMORY_SCHEMA §5.2/§5.3: success/failure require a criterion, at least one
 * evidence ref, and an oracle (or an explicitly independent human). A bare
 * status string is NOT an outcome. `unknown`/`invalid` never create Fact or
 * Refuted. A transport error or timeout is `unknown`, not a refutation.
 *
 * @returns {{kind: "Fact"|"Refuted"|"Hint", reason: string}}
 */
export function classifyOutcome(payload, trusted, evidenceRefs) {
	const status = payload?.status;
	if (status !== "success" && status !== "failure") {
		return { kind: "Hint", reason: `status=${String(status)} is not a verified success/failure` };
	}
	if (!trusted) {
		return { kind: "Hint", reason: "outcome source kind is not oracle/human" };
	}
	// Provenance is read from the canonical MEMORY_SCHEMA outcome fields; the
	// additive `provenance` block is only a compatibility view, so an outcome that
	// only carries the legacy top-level `source`/`independent` still works.
	const source = typeof payload?.provenance?.source === "string" ? payload.provenance.source : typeof payload?.source === "string" ? payload.source : "";
	const independent = payload?.provenance?.independent === true || payload?.independent === true || source === "platform" || source === "oracle";
	if (!independent) {
		return { kind: "Hint", reason: "outcome is not from an independent oracle/platform source" };
	}
	if (!payload?.criterion || typeof payload.criterion !== "object") {
		return { kind: "Hint", reason: "outcome is missing its criterion" };
	}
	// A success/failure must carry a non-null observed value: a bare status is not
	// a judgement. (unknown may legally have observed=null.)
	if (status === "success" || status === "failure") {
		if (payload.observed === null || payload.observed === undefined || payload.observed === "") {
			return { kind: "Hint", reason: "outcome status has no observed value" };
		}
	}
	// A transport timeout/tool error is never a task verdict.
	if (payload?.transport && (payload.transport.timed_out === true || payload.transport.tool_ok === false) && status !== "unknown") {
		return { kind: "Hint", reason: "transport failure/timeout is not a verified task verdict" };
	}
	const refs = (Array.isArray(evidenceRefs) ? evidenceRefs.filter(Boolean) : []);
	const embeddedRefs = Array.isArray(payload?.evidence_refs) ? payload.evidence_refs.filter(Boolean) : [];
	if (refs.length === 0 && embeddedRefs.length === 0) {
		return { kind: "Hint", reason: "outcome has no evidence_refs" };
	}
	if (status === "failure") {
		// A failure is only a refutation when the preconditions were independently
		// verified AND the failure mode is a postcondition failure — never for
		// tool_error/timeout/precondition_unmet/insufficient_evidence. The task
		// `failure` status itself is preserved in the Outcome event (a Refuted node
		// is a stronger, separate claim about the METHOD, not the task).
		const mode = payload?.failure_mode;
		if (payload?.preconditions_verified !== true) {
			return { kind: "Hint", reason: "failure does not refute the method: preconditions were not verified (preconditions_verified != true)" };
		}
		if (mode !== "postcondition_failed") {
			return { kind: "Hint", reason: `failure_mode=${String(mode)} does not refute an action (only postcondition_failed does)` };
		}
		return { kind: "Refuted", reason: "verified postcondition failure after verified preconditions" };
	}
	return { kind: "Fact", reason: "verified success with criterion + observed + evidence + independent oracle" };
}

/**
 * Decide which node type an event is permitted to create.
 * Returns `{ type, downgradedFrom? }` or `null` when the event creates no node.
 */
export function permittedNodeType(event) {
	const trusted = TRUSTED_KINDS.has(event.source?.kind);
	switch (event.event_type) {
		case "episode.started":
			return { type: "Origin" };
		case "observation.captured": {
			// A "verified" observation must actually carry an observed value, its own
			// evidence, and a target revision (digest/fingerprint). A shallow
			// `{verified:true}` with no value/evidence is downgraded to a Hint and can
			// never enter the current Fact view.
			const value = event.payload?.value;
			const hasValue = value !== null && value !== undefined && !(typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
			const hasEvidence = (Array.isArray(event.evidence_refs) && event.evidence_refs.some(Boolean)) || (Array.isArray(event.payload?.evidence_refs) && event.payload.evidence_refs.some(Boolean));
			const hasRevision = Boolean(event.payload?.target_fingerprint ?? event.payload?.environment_fingerprint ?? value?.target_fingerprint ?? value?.file_digest ?? value?.stdout_digest);
			if (event.payload?.verified === true && trusted) {
				if (!hasValue) return { type: "Hint", downgradedFrom: "Fact", reason: "observation has no observed value" };
				if (!hasEvidence) return { type: "Hint", downgradedFrom: "Fact", reason: "observation has no evidence_refs" };
				if (!hasRevision) return { type: "Hint", downgradedFrom: "Fact", reason: "observation has no target revision (digest/fingerprint)" };
				return { type: "Fact" };
			}
			if (event.payload?.verified === true) return { type: "Hint", downgradedFrom: "Fact" };
			if (event.payload?.refuted === true && trusted) return { type: "Refuted" };
			if (event.payload?.refuted === true) return { type: "Hint", downgradedFrom: "Refuted" };
			return { type: "Hint" };
		}
		case "outcome.recorded": {
			const verdict = classifyOutcome(event.payload, trusted, event.evidence_refs);
			if (verdict.kind === "Fact") return { type: "Fact" };
			if (verdict.kind === "Refuted") return { type: "Refuted" };
			return { type: "Hint", downgradedFrom: event.payload?.status === "success" || event.payload?.status === "failure" ? "Outcome" : undefined, reason: verdict.reason };
		}
		case "proposal.submitted": {
			const kind = event.payload?.kind;
			if (kind === "intent") return { type: "Intent" };
			if (kind === "claim" || kind === "candidate" || kind === "hint") return { type: "Hint" };
			return null;
		}
		case "action.requested":
			return { type: "Intent" };
		case "action.completed":
			return { type: "Artifact" };
		case "observation.captured.untrusted":
			return { type: "Hint" };
		case "handoff.completed":
			return { type: "Artifact" };
		case "handoff.rejected":
		case "handoff.requested":
			return { type: "Hint" };
		case "experience.decision":
			return { type: "Artifact" };
		// A trusted environment change is an auditable Artifact event AND marks the
		// related Fact/Refuted bindings stale (never deletes them).
		case "environment.changed":
			return { type: "Artifact" };
		case "node.added": {
			const requested = event.payload?.node_type;
			if (!NODE_TYPES.includes(requested)) return null;
			if (requested === "Fact" || requested === "Refuted") {
				if (!trusted || event.payload?.verified !== true) return { type: "Hint", downgradedFrom: requested };
			}
			return { type: requested };
		}
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Effective-view resolution (same-Episode supersedes + trusted env changes)
// ---------------------------------------------------------------------------

/** Normalize a scope/environment key to a stable string, or null when absent. */
function normalizeScopeKey(scope) {
	if (scope === null || scope === undefined) return null;
	if (typeof scope === "string") {
		const trimmed = scope.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	return digest(scope);
}

/** The (criterion_id, expected, task_id) subject that a supersede must match. */
function outcomeSubject(payload) {
	const criterion = payload?.criterion;
	const criterionId = typeof criterion?.criterion_id === "string" && criterion.criterion_id.trim() ? criterion.criterion_id.trim() : null;
	const expected = criterion && typeof criterion === "object" && "expected" in criterion ? criterion.expected : undefined;
	const taskId = payload?.provenance?.task_id ?? payload?.task_id ?? null;
	return { criterionId, expected, taskId };
}

/**
 * Find every outcome node that participates in a `supersedes` cycle. A cycle
 * means two (or more) outcomes claim to replace each other; neither may retire
 * the other, because a backward correction is not a correction.
 */
function findCycleNodes(edges) {
	const color = new Map(); // 0=unseen, 1=on stack, 2=done
	const stack = [];
	const cycleNodes = new Set();
	const visit = (node) => {
		color.set(node, 1);
		stack.push(node);
		const target = edges.get(node);
		if (target !== undefined) {
			const state = color.get(target) ?? 0;
			if (state === 1) {
				const from = stack.indexOf(target);
				for (let i = from; i < stack.length; i += 1) cycleNodes.add(stack[i]);
			} else if (state === 0) {
				visit(target);
			}
		}
		stack.pop();
		color.set(node, 2);
	};
	for (const node of edges.keys()) {
		if ((color.get(node) ?? 0) === 0) visit(node);
	}
	return cycleNodes;
}

/**
 * Validate one `supersedes` edge. Only a legitimate, trustworthy correction of
 * the SAME criterion / scope / subject may retire a prior Outcome. `llm`,
 * `foreign` (different Episode), `cycle`, and `missing` references are refused.
 *
 * @returns {{valid: boolean, reason: string}}
 */
export function validateSupersede({ priorEvent, priorNode, event, cycle = false }) {
	if (cycle) return { valid: false, reason: "cycle" };
	if (!priorEvent) return { valid: false, reason: "missing" };
	if (event?.source?.kind === "llm") return { valid: false, reason: "llm" };
	// Only an oracle/human judgement may retire a Fact; a bare `runtime` note or
	// any other source kind cannot.
	if (!TRUSTED_KINDS.has(event?.source?.kind)) return { valid: false, reason: "untrusted" };
	if (priorEvent.episode_id !== event.episode_id) return { valid: false, reason: "foreign" };
	// The superseding judgement must itself be an auditable outcome, not a bare
	// status; otherwise it cannot legitimately replace anything.
	if (!event.payload?.outcome_id) return { valid: false, reason: "malformed" };
	// ...and it must carry its own evidence. An incomplete `unknown` (no evidence)
	// is not a retraction, it is silence.
	const refs = (Array.isArray(event.evidence_refs) ? event.evidence_refs : []).map(normalizeRef).filter(Boolean);
	if (refs.length === 0) return { valid: false, reason: "no_evidence" };
	const prior = outcomeSubject(priorEvent.payload);
	const next = outcomeSubject(event.payload);
	if (!prior.criterionId || !next.criterionId) return { valid: false, reason: "criterion_unconfirmed" };
	if (prior.criterionId !== next.criterionId) return { valid: false, reason: "criterion_mismatch" };
	if (prior.expected !== undefined && next.expected !== undefined && digest(prior.expected) !== digest(next.expected)) {
		return { valid: false, reason: "subject_mismatch" };
	}
	if (prior.taskId && next.taskId && prior.taskId !== next.taskId) return { valid: false, reason: "subject_mismatch" };
	// Prefer the structured scope captured on the payload; fall back to the
	// board node's environment fingerprint when present.
	const priorScope = normalizeScopeKey(priorEvent.payload?.scope ?? priorNode?.environment_fingerprint);
	const nextScope = normalizeScopeKey(event.payload?.scope ?? event.payload?.environment_fingerprint);
	if (priorScope !== nextScope) return { valid: false, reason: "scope_mismatch" };
	return { valid: true, reason: "ok" };
}

/**
 * Resolve the effective supersedes graph from the event history.
 *
 * @returns {{superseded: Map<string, {by: string, event_id: string}>, invalid: object[]}}
 */
export function resolveEffective(events, nodes = []) {
	const outcomeEvents = [];
	for (const event of events) {
		if (event?.event_type === "outcome.recorded" && event.payload?.outcome_id) outcomeEvents.push(event);
	}
	const nodeByOutcomeId = new Map();
	for (const node of nodes) if (node.outcome_id) nodeByOutcomeId.set(node.outcome_id, node);
	const edges = new Map();
	for (const event of outcomeEvents) {
		if (event.payload.supersedes) edges.set(event.payload.outcome_id, event.payload.supersedes);
	}
	const cycleNodes = findCycleNodes(edges);
	const superseded = new Map();
	const invalid = [];
	// Index outcomes AS WE SCAN, so a supersede may only reference an outcome that
	// was already recorded earlier (a correction cannot point at the future). The
	// FIRST occurrence of an outcome_id wins; a later duplicate never overwrites
	// the index and so cannot redirect a supersede.
	const byOutcomeId = new Map();
	for (const event of outcomeEvents) {
		const target = event.payload.supersedes;
		if (target) {
			const priorEvent = byOutcomeId.get(target) ?? null;
			const verdict = validateSupersede({
				priorEvent,
				priorNode: nodeByOutcomeId.get(target) ?? null,
				event,
				cycle: cycleNodes.has(event.payload.outcome_id),
			});
			if (!verdict.valid) {
				invalid.push({ by: event.payload.outcome_id, target, reason: verdict.reason, event_id: event.event_id });
			} else if (!superseded.has(target)) {
				superseded.set(target, { by: event.payload.outcome_id, event_id: event.event_id });
			}
		}
		if (!byOutcomeId.has(event.payload.outcome_id)) byOutcomeId.set(event.payload.outcome_id, event);
	}
	return { superseded, invalid, byOutcomeId };
}

/**
 * Mark the Fact/Refuted bindings retired by a trusted `environment.changed`.
 * History is preserved: the nodes stay in `byType` with `effective_status:
 * "stale"`; they only leave the current effective view.
 *
 * @returns {{staleNodeIds: Set<string>, changes: object[]}}
 */
export function resolveEnvironmentChanges(events, nodes) {
	const outcomeIndex = new Map();
	events.forEach((event, index) => {
		if (event?.event_type === "outcome.recorded" && event.payload?.outcome_id && !outcomeIndex.has(event.payload.outcome_id)) {
			outcomeIndex.set(event.payload.outcome_id, index);
		}
	});
	// A Fact node derived directly from an `observation.captured` row has no
	// `outcome_id`, so the outcome index cannot locate it. Index every row by its
	// own event_id as well so ordering still works for observation-derived facts.
	const eventIndexById = new Map();
	events.forEach((event, index) => {
		if (event?.event_id && !eventIndexById.has(event.event_id)) eventIndexById.set(event.event_id, index);
	});
	const staleNodeIds = new Set();
	const changes = [];
	events.forEach((event, index) => {
		if (event?.event_type !== "environment.changed") return;
		if (!TRUSTED_KINDS.has(event.source?.kind)) return;
		const scopeKey = normalizeScopeKey(event.payload?.scope ?? event.payload?.environment_fingerprint);
		const matched = [];
		// A scope-less change may NOT stop the whole graph: with no scope we cannot
		// know what it invalidates, so we fail closed and stale nothing.
		if (scopeKey) {
			for (const node of nodes) {
				if (node.type !== "Fact" && node.type !== "Refuted") continue;
				if (event.episode_id && node.episode_id !== event.episode_id) continue;
				if (normalizeScopeKey(node.scope ?? node.environment_fingerprint) !== scopeKey) continue;
				// Only bindings recorded BEFORE this change are affected. A fact
				// re-verified after the change is the new current fact, not stale.
				const nodeIndex = node.outcome_id ? outcomeIndex.get(node.outcome_id) : node.origin_event_id ? eventIndexById.get(node.origin_event_id) : undefined;
				if (nodeIndex === undefined || nodeIndex > index) continue;
				staleNodeIds.add(node.node_id);
				matched.push(node.node_id);
			}
		}
		changes.push({ event_id: event.event_id, scope: scopeKey, stale_nodes: matched, reason: event.payload?.reason ?? null });
	});
	return { staleNodeIds, changes };
}

function nodeText(event, type) {
	const payload = event.payload || {};
	switch (type) {
		case "Origin":
			return payload.goal?.description || payload.goal || "(episode origin)";
		case "Fact":
		case "Refuted": {
			// State the PROPOSITION that was verified, not a bare outcome word. The
			// criterion expected value is what was checked; the observed value is what
			// the oracle actually saw. Only fall back to the raw status when a payload
			// genuinely has no criterion (in which case the gate downgrades it anyway).
			const criterion = payload.criterion;
			const proposition = criterion?.expected ?? criterion?.description;
			if (proposition) {
				const observed = payload.observed;
				const observedText = observed === null || observed === undefined || typeof observed === "object" ? "" : String(observed);
				const tail = observedText ? ` [observed: ${observedText}]` : "";
				const oracle = payload.oracle?.oracle_id ? ` (${type.toLowerCase()} by ${payload.oracle.oracle_id})` : "";
				return `${proposition}${tail}${oracle}`;
			}
			return payload.text || payload.claim || payload.statement || (payload.status ? `outcome:${payload.status}${payload.source ? ` (${payload.source})` : ""}` : JSON.stringify(payload));
		}
		case "Intent":
			return payload.text || payload.intent || payload.tool_name || "(intent)";
		case "Hint":
			return payload.text || payload.claim || payload.reason || payload.note || JSON.stringify(payload);
		case "Artifact":
			if (payload.kind === "experience_injection_decision") {
				const selected = payload.selected?.id ? `${payload.selected.id}@${payload.selected.revision ?? "?"}` : "(none)";
				return `experience decision: mode=${payload.mode} selected=${selected} considered=${payload.considered?.length ?? 0} matched=${payload.matched?.length ?? 0} rejected=${payload.rejected?.length ?? 0} (hint only, unverified)`;
			}
			if (event.event_type === "environment.changed") {
				return `environment changed: scope=${payload.scope ?? payload.environment_fingerprint ?? "(all)"}${payload.reason ? ` — ${payload.reason}` : ""} (related facts marked stale, not deleted)`;
			}
			return payload.text || payload.tool_name || payload.summary || "(artifact)";
		default:
			return payload.text || "";
	}
}

/**
 * Project an event list into:
 *   `{nodes, edges, byType, currentByType, effective, digest, effective_digest,
 *     rejections}`.
 *
 * `byType` is the full, immutable history; `currentByType` is the effective view
 * after supersedes and trusted environment changes. Deterministic: same events
 * -> same board.
 */
export function projectBoard(events) {
	const nodes = [];
	const edges = [];
	const byType = Object.fromEntries(NODE_TYPES.map((type) => [type, []]));
	const rejections = [];
	const byEventId = new Map();

	for (const event of events) {
		if (!event || typeof event !== "object") continue;
		const permitted = permittedNodeType(event);
		if (event.event_type === "proposal.rejected" || (event.event_type === "proposal.submitted" && !permitted)) {
			rejections.push({
				event_id: event.event_id,
				event_type: event.event_type,
				reason: event.payload?.rejection_reason || "proposal did not map to an allowed node type",
			});
			continue;
		}
		if (!permitted) continue;
		const normalizedRefs = (Array.isArray(event.evidence_refs) ? event.evidence_refs : []).map(normalizeRef).filter(Boolean);
		const payload = event.payload || {};
		const node = {
			node_id: `ev:${event.event_id}`,
			type: permitted.type,
			text: String(nodeText(event, permitted.type)).slice(0, 4000),
			status: permitted.type === "Fact" || permitted.type === "Refuted" ? "verified" : "candidate",
			scope: payload.scope || null,
			revision: payload.revision ?? null,
			source_refs: payload.source_refs || event.source_trust_refs || [],
			evidence_refs: normalizedRefs,
			// Structured, machine-readable fields preserved alongside the rendered
			// text so the effective view is derived from data, not prose.
			criterion: payload.criterion ?? null,
			observed: payload.observed ?? null,
			outcome_id: payload.outcome_id ?? null,
			supersedes: payload.supersedes ?? null,
			action_id: payload.action_id ?? null,
			tool_name: payload.tool_name ?? null,
			environment_fingerprint: payload.environment_fingerprint ?? null,
			origin_event_id: event.event_id,
			episode_id: event.episode_id || null,
			created_at: event.recorded_at,
			...(permitted.downgradedFrom ? { downgraded_from: permitted.downgradedFrom } : {}),
			...(permitted.reason ? { downgrade_reason: permitted.reason } : {}),
		};
		nodes.push(node);
		byType[node.type].push(node);
		byEventId.set(event.event_id, node);
		if (event.episode_id) {
			edges.push({ from: `episode:${event.episode_id}`, to: node.node_id, relation: "about" });
		}
		// Evidence edges: only draw an edge when the ref resolves to a real local
		// node. An external ref is recorded on the node but never faked into a
		// graph edge pointing at nothing.
		const unresolvedRefs = [];
		for (const ref of node.evidence_refs) {
			if (ref.ref_type === "event" && byEventId.has(ref.ref_id)) {
				edges.push({ from: node.node_id, to: byEventId.get(ref.ref_id).node_id, relation: "references" });
			} else {
				unresolvedRefs.push(`${ref.ref_type}:${ref.ref_id}`);
			}
		}
		if (unresolvedRefs.length > 0) node.unresolved_evidence_refs = unresolvedRefs;
		if (event.event_type === "action.completed" && payload.action_id) {
			edges.push({ from: node.node_id, to: `action:${payload.action_id}`, relation: "completes" });
		}
		if (event.event_type === "proposal.submitted" && event.causation_id) {
			edges.push({ from: node.node_id, to: `prompt:${event.causation_id}`, relation: "proposed_from" });
		}
	}

	// Effective view: same-Episode supersedes + trusted environment changes.
	const { superseded, invalid } = resolveEffective(events, nodes);
	const { staleNodeIds, changes } = resolveEnvironmentChanges(events, nodes);
	// Index outcome -> superseding node so a supersede draws an auditable edge.
	const nodeByOutcomeId = new Map();
	for (const node of nodes) if (node.outcome_id) nodeByOutcomeId.set(node.outcome_id, node);
	for (const node of nodes) {
		if (node.outcome_id && superseded.has(node.outcome_id)) {
			node.effective = false;
			node.effective_status = "superseded";
			node.superseded_by = superseded.get(node.outcome_id).by;
			if (nodeByOutcomeId.has(node.superseded_by)) {
				edges.push({ from: nodeByOutcomeId.get(node.superseded_by).node_id, to: node.node_id, relation: "supersedes" });
			}
		} else if (staleNodeIds.has(node.node_id)) {
			node.effective = false;
			node.effective_status = "stale";
		} else {
			node.effective = true;
			node.effective_status = "current";
		}
	}
	const currentByType = Object.fromEntries(NODE_TYPES.map((type) => [type, byType[type].filter((node) => node.effective)]));

	const digestOver = (list) => digest(list.map((n) => ({ id: n.node_id, type: n.type, text: n.text })));
	return {
		nodes,
		edges,
		byType,
		currentByType,
		rejections,
		effective: {
			superseded_outcome_ids: [...superseded.keys()],
			superseded: nodes
				.filter((node) => node.effective_status === "superseded")
				.map((node) => ({ node_id: node.node_id, outcome_id: node.outcome_id, superseded_by: node.superseded_by })),
			invalid_supersedes: invalid,
			stale_node_ids: [...staleNodeIds],
			environment_changes: changes,
		},
		digest: digestOver(nodes),
		effective_digest: digestOver(nodes.filter((node) => node.effective)),
	};
}

export function summarizeBoard(board) {
	const current = board.currentByType ?? board.byType;
	return {
		digest: board.digest,
		effective_digest: board.effective_digest ?? board.digest,
		counts: Object.fromEntries(NODE_TYPES.map((type) => [type, board.byType[type].length])),
		effective_counts: Object.fromEntries(NODE_TYPES.map((type) => [type, current[type].length])),
		superseded: board.effective?.superseded_outcome_ids?.length ?? 0,
		invalid_supersedes: board.effective?.invalid_supersedes?.length ?? 0,
		stale: board.effective?.stale_node_ids?.length ?? 0,
		rejections: board.rejections.length,
	};
}
