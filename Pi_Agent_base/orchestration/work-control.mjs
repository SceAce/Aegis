// Domain-neutral workflow control over the ONE append-only event source.
// Never interpret shell commands/output, never manufacture task Outcomes.

import { summarizeRequestLedger } from "../campaign/c6-request-lifecycle.mjs";
import { digest } from "../shared/events.mjs";

const VERSION = "work-control-1";
const TRUSTED = new Set(["runtime", "human"]);
const LIMITS = ["max_tool_calls", "max_identical_calls", "wall_time_ms"];
const hostToolAccounts = new Map();
const commandQueues = new Map();
// EventLog keeps a row after an fsync failure. Such a resume must never clear a hold.
const nonDurableTransitions = new Set();
/** Bind the existing Campaign tool ledger; no second accounting protocol. */
export function bindWorkToolAccount(logPath, account) {
	hostToolAccounts.set(logPath, account);
	return () => {
		if (hostToolAccounts.get(logPath) === account) hostToolAccounts.delete(logPath);
	};
}
export function workToolAccount(logPath) {
	return hostToolAccounts.get(logPath) ?? null;
}

/** Normalize a trusted task policy, not model input. */
export function validateWorkContract(input) {
	if (!input || typeof input !== "object" || Array.isArray(input))
		return { ok: false, reason: "work contract must be an object" };
	const allowed = new Set(["target_ref", "criteria", "allowed_tools", "verification_calls", ...LIMITS]);
	if (Object.keys(input).some((key) => !allowed.has(key))) return { ok: false, reason: "unknown work contract field" };
	if (typeof input.target_ref !== "string" || !input.target_ref || input.target_ref.length > 400)
		return { ok: false, reason: "target_ref is required" };
	if (
		!Array.isArray(input.criteria) ||
		!input.criteria.length ||
		input.criteria.length > 32 ||
		input.criteria.some((c) => typeof c !== "string" || !c || c.length > 400)
	)
		return { ok: false, reason: "criteria required" };
	for (const key of LIMITS)
		if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < 1))
			return { ok: false, reason: `invalid ${key}` };
	if (
		input.allowed_tools !== undefined &&
		(!Array.isArray(input.allowed_tools) ||
			input.allowed_tools.length > 64 ||
			input.allowed_tools.some((v) => typeof v !== "string" || !v))
	)
		return { ok: false, reason: "invalid allowed_tools" };
	const verification = input.verification_calls ?? [];
	if (
		!Array.isArray(verification) ||
		verification.length > 8 ||
		verification.some(
			(call) =>
				!call ||
				Object.keys(call).some((k) => !["tool_name", "arguments_digest"].includes(k)) ||
				!["read", "aegis_read"].includes(call.tool_name) ||
				!/^sha256:[a-f0-9]{64}$/.test(call.arguments_digest),
		)
	)
		return { ok: false, reason: "verification_calls must pin a supported read-only tool and exact arguments digest" };
	return {
		ok: true,
		contract: {
			target_ref: input.target_ref,
			criteria: [...new Set(input.criteria)],
			...(input.allowed_tools ? { allowed_tools: [...new Set(input.allowed_tools)] } : {}),
			verification_calls: verification.map((call) => ({ ...call })),
			...Object.fromEntries(LIMITS.filter((key) => input[key] !== undefined).map((key) => [key, input[key]])),
		},
	};
}

function note(event) {
	return event?.event_type === "runtime.note" && event.payload?.version === VERSION ? event.payload : null;
}

/** Reduce only accepted work transitions; model notes never acquire control. */
export function projectWorkControl(events, taskId) {
	const episodes = new Map();
	const actions = new Map();
	const candidates = new Map();
	const rejected = [];
	let held = null;
	let policy = null;
	let policyError = null;
	let contractSeen = false;
	let epoch = "initial";
	let started = null;
	let resume = null;
	const completedContinuations = new Set();
	const attempts = [];
	for (const event of events) {
		const p = event?.payload ?? {};
		if (event.event_type === "episode.started" && TRUSTED.has(event.source?.kind) && p.task_id === taskId) {
			episodes.set(event.episode_id, { task_id: taskId });
			const checked = p.work_contract == null ? { ok: true, contract: null } : validateWorkContract(p.work_contract);
			if (!checked.ok) policyError = "invalid_work_contract";
			else if (contractSeen && digest(policy) !== digest(checked.contract)) policyError = "work_contract_conflict";
			else if (!contractSeen) {
				policy = checked.contract;
				started = Date.parse(event.recorded_at);
			}
			contractSeen = true;
		}
		if (event.event_type === "environment.changed" && TRUSTED.has(event.source?.kind) && episodes.has(event.episode_id))
			epoch = event.event_id;
		if (event.event_type === "action.requested" && event.source?.kind === "runtime" && episodes.has(event.episode_id)) {
			const key = `${event.episode_id}:${p.action_id}`;
			if (!actions.has(key)) {
				actions.set(key, { request: event, completion: null });
				attempts.push({ tool: p.tool_name, args: p.arguments_digest ?? null, epoch });
			}
		}
		if (event.event_type === "action.completed" && event.source?.kind === "runtime" && episodes.has(event.episode_id)) {
			const action = actions.get(`${event.episode_id}:${p.action_id}`);
			if (action && !action.completion) action.completion = event;
		}
		const w = note(event);
		if (!w || w.task_id !== taskId) continue;
		if (!TRUSTED.has(event.source?.kind) || !episodes.has(event.episode_id)) {
			rejected.push(event.event_id);
			continue;
		}
		if (w.kind === "work.candidate") {
			const bound = episodes.get(event.episode_id);
			const checked = validateCandidate(w, {
				policy,
				events: events.slice(0, events.indexOf(event)),
				episodeId: event.episode_id,
				taskId: bound.task_id,
			});
			if (!checked.ok || held || w.candidate_id !== checked.candidate.candidate_id) {
				rejected.push(event.event_id);
				continue;
			}
			const candidate = { event_id: event.event_id, episode_id: event.episode_id, ...checked.candidate };
			if (candidates.has(w.candidate_id)) {
				rejected.push(event.event_id);
				continue;
			}
			candidates.set(w.candidate_id, candidate);
			held = candidate;
		} else if (w.kind === "work.resumed" || w.kind === "work.rejected") {
			const prefix = events.slice(0, events.indexOf(event));
			const unsettledActions = [...actions.values()].some(
				({ request, completion }) =>
					request.episode_id === held?.episode_id &&
					(!completion ||
						completion.payload?.status === "unknown" ||
						completion.payload?.transport?.status === "unknown"),
			);
			if (
				unsettledActions ||
				!inspectWorkResume(prefix, taskId).ok ||
				nonDurableTransitions.has(event.event_id) ||
				!held ||
				held.candidate_id !== w.candidate_id ||
				event.episode_id !== held.episode_id ||
				typeof w.reason !== "string" ||
				!w.reason.trim()
			) {
				rejected.push(event.event_id);
				continue;
			}
			resume = { event_id: event.event_id, episode_id: held.episode_id, consumed: false };
			held = null;
		} else if (w.kind === "work.continuation.started" && resume && w.resume_event_id === resume.event_id) {
			resume.consumed = true;
		} else if (w.kind === "work.continuation.completed") {
			completedContinuations.add(w.resume_event_id);
		}
	}
	return {
		resume,
		completedContinuations: [...completedContinuations],
		state: held ? "waiting_external" : "exploring",
		candidate: held,
		policy,
		policyError,
		started,
		epoch,
		attempts,
		rejected,
		candidates: [...candidates.values()],
	};
}

/** Model supplies identity/refs only. Caller supplies trusted task/episode. */
export function validateCandidate(input, { policy, events, episodeId, taskId }) {
	if (!policy) return { ok: false, reason: "work contract unconfigured" };
	if (
		!events.some(
			(row) =>
				row.event_type === "episode.started" &&
				row.episode_id === episodeId &&
				row.payload?.task_id === taskId &&
				TRUSTED.has(row.source?.kind),
		)
	)
		return { ok: false, reason: "candidate Episode/task binding missing" };
	const allowed = new Set([
		"target_ref",
		"criterion_id",
		"evidence_event_ids",
		"candidate_id",
		"kind",
		"version",
		"task_id",
	]);
	if (!input || typeof input !== "object" || Object.keys(input).some((key) => !allowed.has(key)))
		return { ok: false, reason: "unknown candidate field" };
	if (input.target_ref !== policy.target_ref || !policy.criteria.includes(input.criterion_id))
		return { ok: false, reason: "candidate target/criterion outside trusted contract" };
	const ids = input.evidence_event_ids;
	if (!Array.isArray(ids) || !ids.length || ids.length > 8 || new Set(ids).size !== ids.length)
		return { ok: false, reason: "candidate needs 1..8 distinct evidence events" };
	for (const id of ids) {
		const done = events.find((row) => row.event_id === id);
		const index = events.indexOf(done);
		const start = events
			.slice(0, index)
			.find(
				(row) =>
					row.event_type === "action.requested" &&
					row.payload?.action_id === done?.payload?.action_id &&
					row.episode_id === episodeId &&
					row.source?.kind === "runtime",
			);
		if (
			!done ||
			done.event_type !== "action.completed" ||
			done.episode_id !== episodeId ||
			done.source?.kind !== "runtime" ||
			!start ||
			(done.payload?.task_id && done.payload.task_id !== taskId) ||
			(start.payload?.task_id && start.payload.task_id !== taskId) ||
			(done.payload?.tool_name && start.payload?.tool_name && done.payload.tool_name !== start.payload.tool_name)
		)
			return { ok: false, reason: "candidate evidence must be committed paired same-Episode action results" };
	}
	const candidate = { target_ref: policy.target_ref, criterion_id: input.criterion_id, evidence_event_ids: [...ids] };
	return {
		ok: true,
		candidate: { ...candidate, candidate_id: digest({ task_id: taskId, episode_id: episodeId, ...candidate }) },
	};
}

/** Enforce only explicit policy/exact identities; do not infer progress or semantics. */
export function inspectWorkPermit({ events, taskId, toolName = null, argumentsDigest = null, now = Date.now() }) {
	const work = projectWorkControl(events, taskId);
	if (work.policyError) return { ok: false, code: work.policyError, work };
	if (work.state === "waiting_external") {
		const allowed =
			toolName &&
			work.policy.verification_calls.some(
				(call) => call.tool_name === toolName && call.arguments_digest === argumentsDigest,
			);
		if (!allowed) return { ok: false, code: "waiting_external", work };
	}
	if (work.policy) {
		if (toolName && work.policy.allowed_tools && !work.policy.allowed_tools.includes(toolName))
			return { ok: false, code: "tool_outside_work_contract", work };
		if (
			work.policy.wall_time_ms &&
			(!Number.isFinite(now) || now < work.started || now - work.started >= work.policy.wall_time_ms)
		)
			return { ok: false, code: "work_time_exhausted", work };
		if (toolName && work.policy.max_tool_calls && work.attempts.length >= work.policy.max_tool_calls)
			return { ok: false, code: "work_tool_budget_exhausted", work };
		const identical = work.attempts.filter(
			(attempt) => attempt.tool === toolName && attempt.args === argumentsDigest && attempt.epoch === work.epoch,
		).length;
		if (toolName && argumentsDigest && work.policy.max_identical_calls && identical >= work.policy.max_identical_calls)
			return { ok: false, code: "identical_call_limit", work };
	}
	return { ok: true, code: null, work };
}

/** Inspect existing request/tool responsibilities without creating another ledger. */
export function inspectWorkResume(events, taskId) {
	const settlement = summarizeRequestLedger(events);
	if (settlement.unresolved > 0 || settlement.diagnostics?.length > 0)
		return { ok: false, reason: "unresolved request accounting" };
	const open = new Set();
	for (const row of events) {
		const p = row.payload;
		if (
			row.event_type !== "runtime.note" ||
			row.source?.kind !== "runtime" ||
			p?.kind !== "c6.tool" ||
			p.task_id !== taskId
		)
			continue;
		const key = [p.campaign_id, p.task_id, p.episode_id, p.request_id, p.tool_call_id, p.unit_id].join("|");
		if (p.phase === "charged") open.add(key);
		else if (p.phase === "finished") open.delete(key);
	}
	return open.size ? { ok: false, reason: "unfinished charged tool units" } : { ok: true };
}

/** One serialized Host/Observer command; reuse sink, no parallel state store. */
export function createWorkController({ events, append, taskId, episodeId, canResume = null }) {
	function serial(fn) {
		const queue = commandQueues.get(taskId) ?? Promise.resolve();
		const next = queue.then(fn, fn);
		const settled = next.catch(() => {});
		commandQueues.set(taskId, settled);
		void settled.then(() => {
			if (commandQueues.get(taskId) === settled) commandQueues.delete(taskId);
		});
		return next;
	}
	return {
		submit(input) {
			return serial(async () => {
				const rows = events();
				const work = projectWorkControl(rows, taskId);
				if (work.policyError) return { ok: false, reason: work.policyError };
				const checked = validateCandidate(input, { policy: work.policy, events: rows, episodeId, taskId });
				if (!checked.ok) return checked;
				if (work.candidate) {
					if (nonDurableTransitions.has(work.candidate.event_id))
						return { ok: false, reason: "candidate durability unresolved" };
					return work.candidate.candidate_id === checked.candidate.candidate_id
						? { ok: true, duplicate: true, candidate: work.candidate }
						: { ok: false, reason: "another candidate is awaiting external review" };
				}
				if (work.candidates.some((candidate) => candidate.candidate_id === checked.candidate.candidate_id))
					return { ok: false, reason: "candidate already reviewed; supply new evidence" };
				const payload = { kind: "work.candidate", version: VERSION, task_id: taskId, ...checked.candidate };
				const result = await append({
					event_type: "runtime.note",
					episode_id: episodeId,
					source: { kind: "runtime", actor_id: "work-controller" },
					payload,
				});
				if (!result?.ok || result.durable === false) {
					if (result?.event?.event_id) nonDurableTransitions.add(result.event.event_id);
					return { ok: false, reason: result?.error ?? "candidate not durable" };
				}
				const accepted = projectWorkControl(events(), taskId).candidate;
				return accepted?.candidate_id === payload.candidate_id
					? { ok: true, candidate: accepted }
					: { ok: false, reason: "candidate not accepted by replay" };
			});
		},
		resume(reason, actor = "human", rejected = false) {
			return serial(async () => {
				if (!TRUSTED.has(actor) || typeof reason !== "string" || !reason.trim() || reason.length > 400)
					return { ok: false, reason: "trusted human/Host reason required" };
				const work = projectWorkControl(events(), taskId);
				if (work.policyError) return { ok: false, reason: work.policyError };
				if (!work.candidate) return { ok: false, reason: "no waiting candidate" };
				if (nonDurableTransitions.has(work.candidate.event_id))
					return { ok: false, reason: "candidate durability unresolved" };
				if (canResume) {
					const permit = await canResume();
					if (permit?.ok !== true) return { ok: false, reason: "unsettled Host responsibilities prevent resume" };
				}
				const rows = events();
				const settlement = inspectWorkResume(rows, taskId);
				if (!settlement.ok) return settlement;
				const completed = new Set(
					rows
						.filter(
							(row) =>
								row.episode_id === work.candidate.episode_id &&
								row.event_type === "action.completed" &&
								row.source?.kind === "runtime" &&
								row.payload?.status !== "unknown" &&
								row.payload?.transport?.status !== "unknown",
						)
						.map((row) => row.payload?.action_id),
				);
				if (
					rows.some(
						(row) =>
							row.episode_id === work.candidate.episode_id &&
							row.event_type === "action.requested" &&
							(!completed.has(row.payload?.action_id) ||
								rows.some(
									(done) =>
										done.episode_id === row.episode_id &&
										done.event_type === "action.completed" &&
										done.payload?.action_id === row.payload?.action_id &&
										(done.payload?.status === "unknown" || done.payload?.transport?.status === "unknown"),
								)),
					)
				)
					return { ok: false, reason: "unfinished actions must be reconciled before resume" };
				const result = await append({
					event_type: "runtime.note",
					episode_id: work.candidate.episode_id,
					source: { kind: actor, actor_id: "work-controller" },
					payload: {
						kind: rejected ? "work.rejected" : "work.resumed",
						version: VERSION,
						task_id: taskId,
						candidate_id: work.candidate.candidate_id,
						reason,
					},
				});
				if ((!result?.ok || result.durable === false) && result?.event?.event_id)
					nonDurableTransitions.add(result.event.event_id);
				return result?.ok && result.durable !== false && projectWorkControl(events(), taskId).state === "exploring"
					? { ok: true }
					: { ok: false, reason: result?.error ?? "resume not durable" };
			});
		},
	};
}
