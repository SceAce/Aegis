// Aegis Web Console — the bounded, read-only view the browser renders.
//
// ONE implementation for every caller:
//   * the Experiment Host answers `view` over its control channel (live run);
//   * the Web server renders a STOPPED experiment from the same committed log.
//
// Authority boundary:
//   * every field is derived from committed EventLog rows + the existing
//     `memory/board.mjs`, `memory/state.mjs`, `memory/work-cycle.mjs` and
//     `memory/ram.mjs` projections. Nothing here writes, grants or clears.
//   * `host` fields come from the Host's own derived status (never from the
//     browser, never from a model message).
//   * the last PROVIDER-BOUND RAM is only available as the audit metadata the
//     Observer committed (`request.projected`). Its text is not persisted, so the
//     view reports `text_available:false` instead of inventing one. The
//     rebuildable RAM (from the same projection code) is a separate field.
//   * missing budget/cost/token data stays `null`/`unknown`. No invented 0 or
//     percentage.
//
// Output is field-whitelisted and bounded; overflow is reported, never silently
// dropped.

import { buildRamProjection } from "../memory/ram.mjs";

export const WEB_VIEW_VERSION = "aegis-web-view-1";

export const VIEW_LIMITS = Object.freeze({
	nodes: 200,
	evidence: 20,
	actions: 60,
	handoffs: 20,
	sessions: 20,
	knowledge: 24,
	events: 400,
	text: 1200,
	toolText: 2000,
	modelRequests: 40,
});

function clip(value, limit = VIEW_LIMITS.text) {
	if (typeof value !== "string") return null;
	return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function refIds(list) {
	if (!Array.isArray(list)) return [];
	const out = [];
	for (const item of list) {
		const id = typeof item === "string" ? item : (item?.ref_id ?? item?.event_id ?? null);
		if (typeof id === "string" && id) out.push(id);
		if (out.length >= VIEW_LIMITS.evidence) break;
	}
	return out;
}

function boundedList(list, limit) {
	const rows = Array.isArray(list) ? list : [];
	return { rows: rows.slice(0, limit), total: rows.length, truncated: rows.length > limit };
}

/**
 * One committed row as the conversation timeline shows it.
 *
 * Field-whitelisted: prompts are NOT stored in full (only digest/chars), tool
 * output is the committed excerpt, and model text is marked unverified. The same
 * function maps the SSE stream, so a reconnected browser shows the same shape as
 * a freshly loaded view.
 */
export function transcriptEntry(row) {
	if (!row || typeof row !== "object") return null;
	const payload = row.payload ?? {};
	const base = {
		event_id: row.event_id ?? null,
		event_type: row.event_type ?? null,
		recorded_at: row.recorded_at ?? null,
		episode_id: row.episode_id ?? null,
		session_id: payload.session_id ?? null,
	};
	switch (row.event_type) {
		case "episode.started":
			return {
				...base,
				kind: "episode",
				goal: clip(payload.goal?.description, 2000),
				authorization: payload.authorization ?? null,
			};
		case "prompt.received":
			return {
				...base,
				kind: "prompt",
				prompt_digest: payload.prompt_digest ?? null,
				prompt_chars: payload.prompt_chars ?? null,
				// The prompt text is deliberately not persisted; say so instead of showing a guess.
				text_available: false,
			};
		case "message.completed": {
			// The system prompt is not conversation. A tool result is already shown on
			// its `action.completed` row (with the committed excerpt), so repeating it
			// as a chat bubble only adds noise.
			if (payload.role === "system") return null;
			if (payload.role === "toolResult") return null;
			return {
				...base,
				kind: "message",
				role: payload.role ?? null,
				content_types: Array.isArray(payload.content_types) ? payload.content_types.slice(0, 6) : [],
				text: clip(payload.text_excerpt, VIEW_LIMITS.text),
				text_chars: payload.text_chars ?? null,
				text_digest: payload.text_digest ?? null,
			};
		}
		case "action.requested":
			return {
				...base,
				kind: "action-requested",
				action_id: payload.action_id ?? null,
				tool_name: payload.tool_name ?? null,
				input: payload.input ?? null,
				arguments_digest: payload.arguments_digest ?? null,
			};
		case "action.completed":
			return {
				...base,
				kind: "action-completed",
				action_id: payload.action_id ?? null,
				tool_name: payload.tool_name ?? null,
				status: payload.status ?? "unknown",
				// The observer keeps the transport result separately from a business
				// status. `tool_ok` is shown next to "unknown" so the UI does not imply a
				// verdict it does not have.
				tool_ok: payload.transport?.tool_ok === true,
				transport: payload.transport ?? null,
				observed: payload.observed ?? null,
				content_excerpt: clip(payload.content_excerpt ?? null, VIEW_LIMITS.toolText),
				content_digest: payload.content_digest ?? null,
				rejection_reason: clip(payload.rejection_reason ?? null, 400),
				detail: clip(payload.detail ?? null, 800),
			};
		case "agent.settled":
			return {
				...base,
				kind: "settled",
				context_usage: payload.context_usage ?? null,
				work_cycle_status: payload.work_cycle_status ?? null,
				handoff_ready: payload.handoff_ready === true,
			};
		case "handoff.completed":
			return {
				...base,
				kind: "rotation",
				from_session: payload.from_session ?? null,
				to_session: payload.to_session ?? null,
				request_id: payload.request_id ?? null,
				identity: payload.work_cycle_identity ?? null,
			};
		case "outcome.recorded":
			return {
				...base,
				kind: "outcome",
				status: payload.status ?? "unknown",
				criterion: payload.criterion ?? null,
				value: payload.value ?? null,
				source_kind: row.source?.kind ?? null,
			};
		case "runtime.note": {
			if (payload.kind === "round.checkpoint")
				return {
					...base,
					kind: "checkpoint",
					turn_index: payload.turn_index ?? null,
					text: clip(payload.text, 1400),
					trust: "unverified_model_summary",
				};
			if (payload.kind === "work.review")
				return {
					...base,
					kind: "review",
					trigger_id: payload.trigger_id ?? null,
					blocker: clip(payload.blocker?.text, 600),
					next_step: clip(payload.next_step?.text, 600),
					retrieval_status: payload.retrieval?.status ?? null,
					bootstrap: payload.bootstrap === true,
					trust: "unverified_model_summary",
				};
			if (payload.kind === "knowledge.selected")
				return {
					...base,
					kind: "knowledge",
					mode: payload.mode ?? null,
					status: payload.status ?? null,
					query: clip(payload.query, 300),
					selected: Array.isArray(payload.selected)
						? payload.selected.slice(0, 8).map((item) => ({
								knowledge_id: item?.knowledge_id ?? null,
								source_uri: item?.source_uri ?? null,
							}))
						: [],
				};
			// Control receipts and other inert notes are not conversation.
			return null;
		}
		case "request.projected":
			return {
				...base,
				kind: "request",
				provider_bound: payload.provider_bound === true,
				refusal_reason: payload.refusal_reason ?? null,
				ram_digest: payload.ram_digest ?? null,
				ram_estimated_chars: payload.ram_estimated_chars ?? null,
			};
		case "session.started":
		case "session.shutdown":
			return { ...base, kind: "session", session_id: payload.session_id ?? null };
		default:
			return null;
	}
}

/** Node types the Board uses, plus the two "result" concepts the UI shows apart. */
const BOARD_TYPES = ["Origin", "Fact", "Refuted", "Intent", "Hint", "Artifact"];

function boardNode(node) {
	return {
		node_id: node.node_id,
		type: node.type,
		text: clip(node.text),
		status: node.status,
		scope: node.scope ?? null,
		effective: node.effective !== false,
		superseded_by: node.superseded_by ?? null,
		origin_event_id: node.origin_event_id ?? null,
		subject: node.subject ?? null,
		criterion: node.criterion ?? null,
		observed: node.observed === undefined ? null : node.observed,
		observation_summary: node.observation_summary ?? null,
		checkpoint: node.checkpoint ?? null,
		knowledge_refs: Array.isArray(node.knowledge_refs) ? node.knowledge_refs.slice(0, 8) : [],
		source_refs: refIds(node.source_refs),
		evidence_refs: refIds(node.evidence_refs),
		action_id: node.action_id ?? null,
		tool_name: node.tool_name ?? null,
		outcome_id: node.outcome_id ?? null,
		episode_id: node.episode_id ?? null,
	};
}

/**
 * Build the bounded view.
 *
 * @param {{
 *   label: string,
 *   taskId: string,
 *   events: any[],
 *   board: any,
 *   state: any,
 *   workCycle: any,
 *   status?: any|null,
 *   workspaceFiles?: Array<{path:string,size:number|null,kind:string,modified_at?:string|null}>|null,
 *   limits?: typeof VIEW_LIMITS,
 *   now?: string,
 * }} args
 */
export function buildWebView({
	label,
	taskId,
	events,
	board,
	state,
	workCycle,
	status = null,
	workspaceFiles = null,
	limits = VIEW_LIMITS,
	now = new Date().toISOString(),
}) {
	const rows = Array.isArray(events) ? events : [];
	const episodeId = workCycle?.episode_id ?? status?.episode_id ?? null;
	const episode = episodeId ? state?.episodes?.[episodeId] : null;
	const episodeRows = rows.filter((row) => episodeId && row.episode_id === episodeId);

	// ---- progress -----------------------------------------------------------
	const currentIntentEvent = workCycle?.work_unit_event_id
		? episodeRows.find((row) => row.event_id === workCycle.work_unit_event_id)
		: null;
	const review = workCycle?.review ?? null;
	const checkpoint = workCycle?.checkpoint ?? null;
	const pending = episodeId
		? Object.values(state?.pending_actions ?? {}).filter((action) => action.episode_id === episodeId)
		: [];
	const unknown = pending.filter((action) => action.status === "unknown" || action.status === "unresolved");
	const openActions = pending.filter((action) => action.status !== "completed" && action.status !== "rejected");

	// ---- sessions / handoffs ------------------------------------------------
	const handoffs = (Array.isArray(state?.handoffs) ? state.handoffs : []).filter(
		(row) => !episodeId || row.episode_id === episodeId,
	);
	const sessionEvents = episodeRows.filter(
		(row) => row.event_type === "session.started" || row.event_type === "session.shutdown",
	);
	const sessionIds = new Set();
	for (const value of Array.isArray(episode?.sessions) ? episode.sessions : []) sessionIds.add(value);
	for (const row of sessionEvents) {
		if (typeof row.payload?.session_id === "string") sessionIds.add(row.payload.session_id);
	}
	const handoffView = boundedList(
		handoffs.map((row) => ({
			request_id: row.request_id ?? null,
			from_session: row.from_session ?? null,
			to_session: row.to_session ?? null,
			attempt_id: row.attempt_id ?? null,
			identity: row.work_cycle_identity ?? null,
			event_id: row.event_id ?? null,
			recorded_at: row.recorded_at ?? null,
		})),
		limits.handoffs,
	);
	const settled = episodeRows.filter((row) => row.event_type === "agent.settled");
	const lastSettled = settled[settled.length - 1] ?? null;
	const contextUsage = lastSettled?.payload?.context_usage ?? null;

	// ---- last provider-bound RAM (audit only) ------------------------------
	const projected = episodeRows.filter((row) => row.event_type === "request.projected");
	const lastProjected = [...projected].reverse().find((row) => row.payload?.provider_bound === true) ?? null;
	const providerBoundRam = lastProjected
		? {
				available: true,
				text_available: false,
				reason: "the committed audit row keeps the RAM digest/sections, not the text",
				event_id: lastProjected.event_id,
				recorded_at: lastProjected.recorded_at ?? null,
				digest: lastProjected.payload?.ram_digest ?? null,
				version: lastProjected.payload?.ram_version ?? null,
				estimated_chars: lastProjected.payload?.ram_estimated_chars ?? null,
				budget_chars: lastProjected.payload?.ram_budget_chars ?? null,
				overflow: lastProjected.payload?.ram_overflow === true,
				core_overflow: lastProjected.payload?.ram_core_overflow === true,
				sections: lastProjected.payload?.ram_sections ?? null,
				registers: lastProjected.payload?.ram_registers ?? null,
				state_version: lastProjected.payload?.state_version ?? null,
			}
		: { available: false, text_available: false, reason: "no provider-bound request recorded for this episode" };

	// ---- rebuildable RAM ---------------------------------------------------
	let rebuiltRam = { available: false, reason: "no episode" };
	if (episodeId && board && state) {
		try {
			const projection = buildRamProjection({
				board,
				state,
				episodeId,
				goal: episode?.goal?.description ?? "",
				workCycle: workCycle ?? null,
			});
			rebuiltRam = {
				available: true,
				text: projection.text,
				digest: null,
				budget_chars: projection.budget_chars ?? null,
				overflow: projection.overflow === true,
				core_overflow: projection.core_overflow === true,
				sections: projection.sections ?? null,
				registers: projection.registers ?? null,
				note: "rebuilt now from the committed prefix; not necessarily the text a provider saw",
			};
		} catch (error) {
			rebuiltRam = { available: false, reason: `RAM rebuild failed: ${String(error)}` };
		}
	}

	// ---- knowledge ----------------------------------------------------------
	const selections = episodeRows.filter(
		(row) => row.event_type === "runtime.note" && row.payload?.kind === "knowledge.selected",
	);
	const knowledge = boundedList(
		selections.map((row) => ({
			event_id: row.event_id,
			recorded_at: row.recorded_at ?? null,
			mode: row.payload?.mode ?? null,
			status: row.payload?.status ?? "unknown",
			reason: row.payload?.reason ?? null,
			query: clip(row.payload?.query, 300),
			trigger_id: row.payload?.work_review_trigger_id ?? null,
			selected: (Array.isArray(row.payload?.selected) ? row.payload.selected : []).slice(0, 8).map((item) => ({
				knowledge_id: item?.knowledge_id ?? null,
				source_uri: item?.source_uri ?? null,
				line_start: item?.line_start ?? null,
				line_end: item?.line_end ?? null,
			})),
			omitted: row.payload?.omitted ?? null,
			available_sections: row.payload?.available_sections ?? null,
		})),
		limits.knowledge,
	);
	const usage = Array.isArray(workCycle?.usage) ? workCycle.usage.slice(0, 8) : [];

	// ---- actions / results -------------------------------------------------
	const actionEvents = episodeRows.filter(
		(row) => row.event_type === "action.requested" || row.event_type === "action.completed",
	);
	const byAction = new Map();
	for (const row of actionEvents) {
		const id = row.payload?.action_id;
		if (typeof id !== "string") continue;
		const entry = byAction.get(id) ?? { action_id: id, requested: null, completed: null };
		if (row.event_type === "action.requested") entry.requested = row;
		else entry.completed = row;
		byAction.set(id, entry);
	}
	const actions = [...byAction.values()]
		.map((entry) => {
			const requested = entry.requested;
			const completed = entry.completed;
			const status = completed ? (completed.payload?.status ?? "unknown") : requested ? "pending" : "unknown";
			const rejected = status === "rejected";
			const unknownStatus = !completed || status === "unknown" || status === "unresolved";
			return {
				action_id: entry.action_id,
				tool_name: requested?.payload?.tool_name ?? completed?.payload?.tool_name ?? null,
				status,
				pending: Boolean(requested && !completed),
				unknown: unknownStatus,
				rejected,
				requested_event_id: requested?.event_id ?? null,
				completed_event_id: completed?.event_id ?? null,
				requested_at: requested?.recorded_at ?? null,
				completed_at: completed?.recorded_at ?? null,
				arguments_digest: requested?.payload?.arguments_digest ?? null,
				input: requested?.payload?.input ?? null,
				final_arguments: completed?.payload?.final_arguments ?? null,
				transport: completed?.payload?.transport ?? null,
				observed: completed?.payload?.observed ?? null,
				content_digest: completed?.payload?.content_digest ?? null,
				rejection_reason: clip(completed?.payload?.rejection_reason ?? null, 400),
				detail: clip(completed?.payload?.detail ?? null, 800),
			};
		})
		.sort((a, b) => String(b.requested_at ?? "").localeCompare(String(a.requested_at ?? "")));
	const actionView = boundedList(actions, limits.actions);

	const outcomes = episodeRows
		.filter((row) => row.event_type === "outcome.recorded")
		.map((row) => ({
			event_id: row.event_id,
			recorded_at: row.recorded_at ?? null,
			status: row.payload?.status ?? "unknown",
			source_kind: row.source?.kind ?? null,
			criterion: row.payload?.criterion ?? null,
			value: row.payload?.value ?? null,
			evidence_refs: refIds(row.payload?.evidence_refs ?? row.evidence_refs),
		}));

	// ---- board --------------------------------------------------------------
	const nodes = (Array.isArray(board?.nodes) ? board.nodes : []).filter(
		(node) => !episodeId || node.episode_id === episodeId,
	);
	const effectiveIds = new Set(
		BOARD_TYPES.flatMap((type) =>
			(Array.isArray(board?.currentByType?.[type]) ? board.currentByType[type] : [])
				.filter((node) => !episodeId || node.episode_id === episodeId)
				.map((node) => node.node_id),
		),
	);
	const nodeView = boundedList(
		nodes.map((node) => ({ ...boardNode(node), effective: effectiveIds.has(node.node_id) })),
		limits.nodes,
	);
	const counts = Object.fromEntries(
		BOARD_TYPES.map((type) => [
			type,
			{
				total: nodes.filter((node) => node.type === type).length,
				effective: nodes.filter((node) => node.type === type && effectiveIds.has(node.node_id)).length,
			},
		]),
	);

	// ---- model requests -----------------------------------------------------
	const projectedRows = boundedList(
		projected.map((row) => ({
			event_id: row.event_id,
			recorded_at: row.recorded_at ?? null,
			provider_bound: row.payload?.provider_bound === true,
			refusal_reason: row.payload?.refusal_reason ?? null,
			ram_digest: row.payload?.ram_digest ?? null,
			ram_estimated_chars: row.payload?.ram_estimated_chars ?? null,
			overflow: row.payload?.ram_overflow === true,
			core_overflow: row.payload?.ram_core_overflow === true,
			work_cycle_status: row.payload?.work_cycle_status ?? null,
		})),
		limits.modelRequests,
	);

	return {
		version: WEB_VIEW_VERSION,
		generated_at: now,
		identity: {
			experiment: label,
			task_id: taskId,
			episode_id: episodeId,
			episode_status: episode?.status ?? null,
			goal: clip(episode?.goal?.description ?? null, 2000),
			authorization: episode?.authorization ?? null,
			budget: episode?.budget ?? null,
			started_at: episode?.started_at ?? null,
			closed_at: episode?.closed_at ?? null,
			sessions: [...sessionIds].slice(0, limits.sessions),
		},
		host: status
			? {
					console_status: status.console_status,
					stop_reason: status.stop_reason ?? null,
					block_reason: clip(status.block_reason, 800),
					session_id: status.session_id ?? null,
					session_file: status.session_file ?? null,
					session_creations: status.session_creations ?? null,
					rotations_completed: status.rotations_completed ?? 0,
					auto_rotations: status.auto_rotations ?? 0,
					continuations: status.continuations ?? null,
					rotation_attempts: Array.isArray(status.rotation_attempts) ? status.rotation_attempts.slice(0, 20) : [],
					policy: status.policy ?? null,
					session_budget: status.session_budget ?? null,
					model: status.model ?? null,
					last_committed_cursor: status.last_committed_cursor ?? null,
					last_action: status.last_action ?? null,
				}
			: null,
		progress: {
			total_goal: clip(episode?.goal?.description ?? null, 2000),
			work_unit_state: workCycle?.work_unit_state ?? "unknown",
			work_unit_id: workCycle?.work_unit_id ?? null,
			work_unit_event_id: workCycle?.work_unit_event_id ?? null,
			intent: currentIntentEvent
				? {
						event_id: currentIntentEvent.event_id,
						scope: currentIntentEvent.payload?.scope ?? null,
						text: clip(currentIntentEvent.payload?.text, 800),
						recorded_at: currentIntentEvent.recorded_at ?? null,
					}
				: null,
			review_required: workCycle?.review_required === true,
			reasons: Array.isArray(workCycle?.reasons) ? workCycle.reasons.slice(0, 4) : [],
			trigger_id: workCycle?.trigger_id ?? null,
			bootstrap_review: workCycle?.bootstrap_review === true,
			counters: {
				// Two DIFFERENT counters: cumulative since trusted progress, and the
				// current review round. Named so they cannot be read as one budget.
				cumulative_action_count: workCycle?.action_count ?? 0,
				review_round_action_count: workCycle?.review_round_action_count ?? 0,
				unique_routes: workCycle?.unique_routes ?? 0,
				repeat_count: workCycle?.repeat_count ?? 0,
			},
			trusted_progress_event_id: workCycle?.trusted_progress_event_id ?? null,
			review: review
				? {
						event_id: review.event_id,
						trigger_id: review.trigger_id ?? null,
						selection_event_id: review.selection_event_id ?? null,
						retrieval_status: review.retrieval_status ?? "unknown",
						selected_knowledge_ids: Array.isArray(review.selected_knowledge_ids)
							? review.selected_knowledge_ids.slice(0, 8)
							: [],
						blocker: clip(review.blocker, 600),
						next_step: clip(review.next_step, 600),
						work_unit_id: review.work_unit_id ?? null,
						work_unit_event_id: review.work_unit_event_id ?? null,
						bootstrap: review.bootstrap === true,
						trust: review.trust ?? "unverified_model_summary",
					}
				: null,
			checkpoint: checkpoint
				? {
						event_id: checkpoint.event_id,
						unit_status: checkpoint.unit_status ?? "continue",
						summary: clip(checkpoint.summary, 600),
						blocker: clip(checkpoint.blocker, 400),
						next_step: clip(checkpoint.next_step, 400),
						work_unit_event_id: checkpoint.work_unit_event_id ?? null,
						trust: checkpoint.trust ?? "unverified_model_summary",
					}
				: null,
			consumptions: (Array.isArray(workCycle?.consumptions) ? workCycle.consumptions : []).slice(-4).map((entry) => ({
				review_event_id: entry.review_event_id ?? null,
				selection_event_id: entry.selection_event_id ?? null,
				intent_event_id: entry.intent_event_id ?? null,
				trigger_id: entry.trigger_id ?? null,
			})),
			complete_candidate: workCycle?.complete_candidate === true,
			next_step:
				clip(review?.next_step, 600) ??
				(workCycle?.unscoped === true
					? "Record a non-empty scoped Intent (aegis_propose kind=intent) before any side effect."
					: null),
			pending_actions: openActions.length,
			unknown_actions: unknown.length,
		},
		board: {
			counts,
			nodes: nodeView.rows,
			total_nodes: nodeView.total,
			truncated: nodeView.truncated,
			rejections: (Array.isArray(board?.rejections) ? board.rejections : []).slice(0, 20).map((item) => ({
				event_id: item?.event_id ?? null,
				reason: clip(item?.reason, 300),
			})),
			digest: board?.digest ?? null,
			effective_digest: board?.effective_digest ?? null,
		},
		knowledge: {
			selections: knowledge.rows,
			total_selections: knowledge.total,
			truncated: knowledge.truncated,
			usage,
			experience: [],
			note: "selections are retrieval records; 'used' requires an independent Fact referencing the action result",
		},
		session: {
			current: status?.session_id ?? null,
			session_file: status?.session_file ?? null,
			registered: [...sessionIds].slice(0, limits.sessions),
			rotations: handoffView.rows,
			rotations_total: handoffView.total,
			rotations_truncated: handoffView.truncated,
			context: contextUsage
				? {
						known: contextUsage.known === true,
						used_tokens: contextUsage.used_tokens ?? null,
						limit_tokens: contextUsage.limit_tokens ?? null,
						percent: contextUsage.percent ?? null,
						session_id: lastSettled?.payload?.session_id ?? null,
						recorded_at: lastSettled?.recorded_at ?? null,
					}
				: { known: false },
			session_events: sessionEvents.slice(-limits.sessions).map((row) => ({
				event_id: row.event_id,
				event_type: row.event_type,
				session_id: row.payload?.session_id ?? null,
				recorded_at: row.recorded_at ?? null,
			})),
			ram: {
				provider_bound: providerBoundRam,
				rebuilt: rebuiltRam,
			},
		},
		actions: {
			pending: openActions.slice(0, limits.actions).map((action) => ({
				action_id: action.action_id ?? null,
				tool_name: action.tool_name ?? null,
				status: action.status ?? "unknown",
				episode_id: action.episode_id ?? null,
			})),
			unknown: unknown.slice(0, limits.actions).map((action) => ({
				action_id: action.action_id ?? null,
				tool_name: action.tool_name ?? null,
				status: action.status ?? "unknown",
			})),
			recent: actionView.rows,
			total: actionView.total,
			truncated: actionView.truncated,
			outcomes,
			model_requests: projectedRows.rows,
			model_requests_total: projectedRows.total,
			model_requests_truncated: projectedRows.truncated,
		},
		files: Array.isArray(workspaceFiles) ? workspaceFiles : null,
		transcript: (() => {
			const mapped = rows
				.map((row) => ({ row, entry: transcriptEntry(row) }))
				.filter(
					(item) =>
						item.entry &&
						(!episodeId || item.row.episode_id === episodeId || item.row.event_type === "web.control.receipt"),
				)
				.map((item) => item.entry);
			// The Episode's goal IS the first prompt. When the committed user message
			// carries the same text, show it once (in the message) instead of twice.
			const firstUser = mapped.find((entry) => entry.kind === "message" && entry.role === "user");
			if (firstUser) {
				for (const entry of mapped) {
					if (entry.kind !== "episode" || !entry.goal) continue;
					if (entry.goal.trim() === (firstUser.text ?? "").trim()) {
						entry.goal = null;
						entry.goal_shown_in_message = true;
					}
				}
			}
			const bounded = mapped.slice(-limits.events);
			return {
				rows: bounded,
				total: mapped.length,
				truncated: mapped.length > bounded.length,
				cursor: rows.length,
			};
		})(),
	};
}
