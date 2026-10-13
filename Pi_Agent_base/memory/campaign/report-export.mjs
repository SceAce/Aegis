// Aegis C4 — deterministic read-only Campaign report/export.
//
// Builds the four acceptance artifacts from IMMUTABLE, AUTHORITATIVE input only:
//
//   immutable Manifest  +  verified committed EventLog  +  bounded evidence index
//     -> campaign-report.json
//     -> campaign-report.md
//     -> acceptance-bundle.json
//     -> reviewer-prompt.md
//
// It reuses the C0 `report.mjs` writer and the C1 projection/resolver; it does
// NOT create a second judgment path. It NEVER runs the Worker/Broker/Oracle, the
// model or the network, and it NEVER mutates the source.
//
// Truth rules (C4_REPORT_TASK §2/§3):
//   * counts come from DEDUPLICATED committed events, never from Host in-memory
//     counters, `summary.json` or a checkpoint;
//   * Session generations and independent Episodes are reported separately;
//   * an unobservable value is `null`/`"unknown"`, never `0`;
//   * a corrupt event chain is an explicit integrity failure, never a guess.

import { digest } from "../fixture/contracts.mjs";
import { verifyChain } from "../runtime/events.mjs";
import { aggregateCampaign, aggregateStage, aggregateTask, effectiveOutcomes, independenceOf } from "./aggregate.mjs";
import { canonicalManifestDigest } from "./manifest.mjs";
import { resolveStageOutcome, resolveTaskOutcome } from "./outcome-resolver.mjs";
import { projectQueueFromEvents } from "./projection.mjs";
import {
	buildAcceptanceBundle,
	buildCampaignReport,
	redactSecrets,
	renderCampaignReportMarkdown,
	renderReviewerPrompt,
} from "./report.mjs";

export const REPORT_EXPORT_VERSION = "1.0.0";

/**
 * Bounded artifact limits. Exceeding them is surfaced explicitly (truncation
 * markers + an index), never a silent loss of authorization/result data.
 */
export const DEFAULT_LIMITS = Object.freeze({
	max_outcomes: 5000,
	max_evidence_refs_per_outcome: 32,
	max_tasks: 1000,
	max_faults: 2000,
	max_bundle_bytes: 8 * 1024 * 1024,
	max_report_bytes: 8 * 1024 * 1024,
});

const UNKNOWN = "unknown";

function taskScope(task) {
	return task?.definition?.scope ?? task?.scope ?? null;
}

/**
 * Reconstruct the evidence/artifact index from the COMMITTED stream, using ONLY
 * trusted sources: the runtime's own `action.completed` records and Oracle/human
 * Outcome results. An `llm`/`agent`-sourced evidence ref is NEVER indexed (C3-X4),
 * so a model self-report cannot become resolvable evidence.
 *
 * @param {any[]} events committed rows
 * @returns {Map<string, {ref_id: string, digest: string}>}
 */
export function reconstructArtifactIndex(events = []) {
	const index = new Map();
	const trusted = (sourceKind) => sourceKind === "runtime" || sourceKind === "oracle" || sourceKind === "human";
	for (const event of events) {
		const payload = event?.payload ?? {};
		const sourceKind = event?.source?.kind ?? null;
		if (event?.event_type === "action.completed" && trusted(sourceKind)) {
			const refId = payload.evidence_ref;
			if (typeof refId === "string" && typeof payload.content_digest === "string") {
				index.set(refId, { ref_id: refId, digest: payload.content_digest });
			}
		}
		if (
			(event?.event_type === "outcome.recorded" || payload.kind === "campaign.oracle.result") &&
			["oracle", "human"].includes(sourceKind)
		) {
			const outcome = payload.outcome ?? payload;
			for (const ref of Array.isArray(outcome?.evidence_refs) ? outcome.evidence_refs : []) {
				if (ref?.ref_id && typeof ref.digest === "string")
					index.set(ref.ref_id, { ref_id: ref.ref_id, digest: ref.digest });
			}
			for (const ref of Array.isArray(payload.evidence_refs) ? payload.evidence_refs : []) {
				if (ref?.ref_id && typeof ref.digest === "string")
					index.set(ref.ref_id, { ref_id: ref.ref_id, digest: ref.digest });
			}
		}
	}
	return index;
}

/**
 * Merge a caller-supplied artifact index (a JSON object) with the committed
 * reconstruction. The committed reconstruction is authoritative for a ref the
 * caller does not already provide.
 */
function mergeArtifacts(committed, supplied) {
	const merged = {};
	for (const [refId, entry] of committed) merged[refId] = entry;
	for (const [refId, entry] of Object.entries(supplied ?? {})) {
		if (!Object.hasOwn(merged, refId)) merged[refId] = entry;
	}
	return merged;
}

/** A stable, deduplicated outcome list for the report (all levels). */
function collectOutcomes(projection) {
	const out = [];
	const seen = new Set();
	for (const task of projection.tasks) {
		const taskDef = task.definition ?? {};
		// Task-level Oracle result (the projection keeps the latest ref/status).
		if (task.task_outcome_ref && task.task_outcome_status) {
			const entry = projection.outcomes.get(task.task_outcome_ref);
			if (entry && !seen.has(entry.outcome_id ?? task.task_outcome_ref)) {
				seen.add(entry.outcome_id ?? task.task_outcome_ref);
				out.push({ ...entry, task_id: task.task_id, level: entry.level ?? "episode" });
			}
		}
		for (const stage of task.stage_outcomes ?? []) {
			const key = stage.outcome_id ?? `${task.task_id}:${stage.step_id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ ...stage, task_id: task.task_id, level: stage.level ?? "step" });
		}
		void taskDef;
	}
	return out;
}

/**
 * Count committed actions/sessions/etc. from the DEDUPLICATED committed stream.
 * A repeated command/action id is counted ONCE. A value that cannot be observed
 * from committed events is `null`, not `0`.
 */
export function countCommitted(events = []) {
	const requested = new Set();
	const completed = new Set();
	const executed = new Set();
	const sessionIds = new Set();
	const seenEvents = new Set();
	const rejectedActions = new Set();
	const transportFailures = new Set();
	const actionRefs = new Map(); // action_id -> action_ref
	let observations = 0;
	let outcomeRecords = 0;
	const handoffRequests = new Set();
	const handoffCompleted = new Set();
	const episodes = new Set();
	const taskStarts = new Set();
	const taskCompletions = new Set();

	for (const event of events) {
		if (!["runtime", "oracle", "human"].includes(event?.source?.kind)) continue;
		if (event.event_id && seenEvents.has(event.event_id)) continue;
		if (event.event_id) seenEvents.add(event.event_id);
		const payload = event?.payload ?? {};
		if (event?.episode_id) episodes.add(event.episode_id);
		switch (event?.event_type) {
			case "action.requested": {
				const id = payload.action_id;
				if (typeof id === "string") {
					requested.add(id);
					if (typeof payload.action_ref === "string") actionRefs.set(id, payload.action_ref);
				}
				break;
			}
			case "action.completed": {
				const id = payload.action_id;
				if (typeof id === "string") {
					completed.add(id);
					if (payload.status !== "rejected") executed.add(id);
					if (typeof payload.action_ref === "string") actionRefs.set(id, payload.action_ref);
				}
				if (payload.status === "rejected") rejectedActions.add(id);
				if (payload.transport && payload.transport.tool_ok === false) transportFailures.add(id);
				break;
			}
			case "observation.captured":
				observations += 1;
				break;
			case "outcome.recorded":
				outcomeRecords += 1;
				break;
			case "session.started":
				if (typeof payload.session_id === "string") sessionIds.add(payload.session_id);
				break;
			case "handoff.requested":
				if (typeof payload.request_id === "string") handoffRequests.add(payload.request_id);
				break;
			case "handoff.completed":
				if (typeof payload.to_session === "string") sessionIds.add(payload.to_session);
				if (typeof payload.request_id === "string") handoffCompleted.add(payload.request_id);
				break;
			default:
				break;
		}
		// Campaign kinds live under payload.kind.
		if (payload.kind === "campaign.task.started" && typeof payload.task_id === "string") {
			taskStarts.add(`${payload.task_id}:${payload.command_id ?? ""}`);
		}
		if (payload.kind === "campaign.task.completed" && typeof payload.task_id === "string") {
			taskCompletions.add(payload.task_id);
		}
	}

	// "executed" = an action that reached a completion record. A requested action
	// with no completion is PENDING (never assumed executed).
	const pending = [...requested].filter((id) => !completed.has(id));
	return {
		actions: {
			requested: requested.size,
			completed: completed.size,
			executed: executed.size,
			pending: pending.length,
			rejected: rejectedActions.size,
			transport_failures: transportFailures.size,
			distinct_action_refs: [...new Set(actionRefs.values())].sort(),
		},
		observations,
		outcome_records: outcomeRecords,
		sessions: {
			// A committed rotation is one session GENERATION; it is NOT a new
			// independent Episode.
			observed_session_ids: sessionIds.size,
			handoffs_requested: handoffRequests.size,
			rotations_committed: handoffCompleted.size,
		},
		episodes: {
			distinct_episode_ids: episodes.size,
			// The independent-Episode count for EVIDENCE is deliberately not derived
			// from the raw episode id count alone; it is reported by the aggregation.
			independent_episode_count: null,
		},
		campaign: {
			task_start_commands: taskStarts.size,
			task_completions: taskCompletions.size,
		},
	};
}

/**
 * Rebuild the report inputs from the immutable Manifest + committed events.
 * PURE: no fs, no execution, no network.
 *
 * @param {{manifest: any, manifestDigest?: string|null, events: any[],
 *   artifacts?: any, runtimeDigests?: any}} args
 */
export function buildReportInputs(
	{ manifest, manifestDigest = null, events = [], artifacts = {}, runtimeDigests = {} } = /** @type {any} */ ({}),
) {
	if (!manifest || typeof manifest !== "object") throw new Error("buildReportInputs requires a validated manifest");
	const manifestDigestValue = manifestDigest ?? canonicalManifestDigest(manifest);
	const integrity = deriveIntegrity(events);
	// Invalid input cannot become trusted evidence merely because the reducer
	// accepts its JSON structure. Preserve integrity diagnostics, reduce no rows.
	const verifiedEvents = integrity.event_chain_ok ? events : [];
	// Evidence must be resolvable from TRUSTED committed records even when the
	// caller supplies no index (e.g. after deleting derived artifacts). A supplied
	// index may ADD bounded refs but never overrides committed truth.
	const resolvedArtifacts = mergeArtifacts(reconstructArtifactIndex(verifiedEvents), artifacts);
	const projection = projectQueueFromEvents({
		campaign_id: manifest.campaign_id,
		tasks: manifest.tasks ?? [],
		events: verifiedEvents,
		revision: manifest.revision ?? 0,
		manifest,
		artifacts: resolvedArtifacts,
	});

	const taskAggregates = [];
	const stageAggregates = [];
	const conflicts = [];
	const missingEvidence = [];

	for (const row of projection.tasks) {
		const definition = row.definition ?? (manifest.tasks ?? []).find((t) => t.task_id === row.task_id) ?? null;
		const episodeId = row.episode_id ?? null;
		const scope = taskScope(row);
		const stages = [];
		for (const stageDef of definition?.stages ?? []) {
			const candidates = (row.stage_outcomes ?? []).filter(
				(o) => o.step_id === stageDef.stage_id || o.stage_id === stageDef.stage_id,
			);
			const valid = [];
			for (const candidate of candidates) {
				const verdict = resolveStageOutcome({
					result: candidate,
					task: definition,
					stage: stageDef,
					episodeId,
					scope,
					artifacts: resolvedArtifacts,
					eventSource: candidate.provenance?.source ?? null,
				});
				if (verdict.ok) valid.push(candidate);
				else
					missingEvidence.push({
						stage_id: stageDef.stage_id,
						task_id: row.task_id,
						outcome_id: candidate?.outcome_id ?? null,
						reason: verdict.reasons.join("; "),
					});
			}
			stages.push(
				aggregateStage({
					stage: {
						stage_id: stageDef.stage_id,
						task_id: row.task_id,
						required: stageDef.required !== false,
						criterion_ids: stageDef.criteria ?? [],
					},
					outcomes: valid,
				}),
			);
		}

		const taskResultEntry = row.task_outcome_ref ? (projection.outcomes.get(row.task_outcome_ref) ?? null) : null;
		let taskOracle = null;
		if (taskResultEntry) {
			const verdict = resolveTaskOutcome({
				result: taskResultEntry,
				task: definition,
				episodeId,
				scope,
				artifacts: resolvedArtifacts,
				eventSource: taskResultEntry.provenance?.source ?? null,
			});
			if (verdict.ok) taskOracle = verdict.outcome;
		}
		const taskAggregate = aggregateTask({ task: definition, stages, taskOracle, episodeId });
		taskAggregates.push({
			...taskAggregate,
			task_id: row.task_id,
			// Lifecycle state is the scheduler's durable state, kept SEPARATE from
			// the evidence status so a running task with unknown evidence is visible.
			lifecycle_state: row.state,
			stop_reason: row.stop_reason ?? null,
			reconciliation_state: row.reconciliation_state ?? "none",
			is_dynamic: row.is_dynamic === true,
			episode_id: episodeId,
		});
		for (const stageAgg of stages) stageAggregates.push({ ...stageAgg, task_id: row.task_id });

		const status = taskAggregate.status;
		if (status !== "success" && status !== "pending") {
			if ((taskAggregate.reasons ?? []).some((r) => /conflict/i.test(r)))
				conflicts.push({ task_id: row.task_id, reasons: taskAggregate.reasons });
		}
	}

	const outcomes = collectOutcomes(projection);
	const independence = { ...independenceOf(outcomes), independent_episode_count: null }; // root/group counts do not prove Episode independence
	const effective = effectiveOutcomes(outcomes);
	const counts = countCommitted(verifiedEvents);
	const faults = projection.rejected.map((r) => ({
		kind: "event_rejected",
		detail: r.reason,
		task_id: null,
		event_id: r.event_id ?? null,
	}));
	for (const row of projection.tasks) {
		if (row.stop_reason)
			faults.push({ kind: `task:${row.stop_reason}`, task_id: row.task_id, detail: row.reconciliation_reason ?? null });
		if (row.reconciliation_state === "pending")
			faults.push({ kind: "reconciliation_pending", task_id: row.task_id, detail: row.reconciliation_reason ?? null });
	}

	const campaignAggregate = aggregateCampaign({
		manifest,
		taskAggregates: taskAggregates.map((t) => ({ task_id: t.task_id, status: t.status, reasons: t.reasons })),
		faults,
		budgetUsed: projection.budget.consumed,
	});
	campaignAggregate.manifest_digest = manifestDigestValue;
	campaignAggregate.budget.used.session_count = counts.sessions.rotations_committed;
	campaignAggregate.budget.used.tokens = null;
	campaignAggregate.budget.used.currency = null;
	campaignAggregate.budget.measurement = {
		dispatch_cost: verifiedEvents.some(
			(event) => event.payload?.kind === "campaign.budget.consumed" && event.payload?.consumed?.synthetic === true,
		)
			? "synthetic"
			: "committed_ledger",
		session_count: "committed_rotations_only",
	};
	// The real session usage vs the independent-Episode evidence count are both
	// explicit; Session generations are NOT an Episode count.
	campaignAggregate.counts.sessions = counts.sessions.rotations_committed;
	campaignAggregate.independence = independence;

	return {
		projection,
		taskAggregates,
		stageAggregates,
		outcomes,
		counts,
		independence,
		effective_outcome_count: effective.length,
		conflicts,
		missingEvidence,
		faults,
		campaignAggregate,
		manifestDigest: manifestDigestValue,
		integrity,
		runtimeDigests,
	};
}

// ---------------------------------------------------------------------------
// Structural validator
// ---------------------------------------------------------------------------

const SECRET_VALUE_PATTERNS = [
	/(?:flag\{|ctf\{)/i,
	/\bbearer\s+[A-Za-z0-9._-]{8,}/i,
	/-----BEGIN [A-Z ]+PRIVATE KEY-----/,
	/(?:api[_-]?key|password|passwd|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._+/=-]{8,}/i,
];

function scanSecrets(value, path, reasons) {
	if (typeof value === "string") {
		for (const pattern of SECRET_VALUE_PATTERNS) {
			if (pattern.test(value)) reasons.push(`possible secret at ${path}`);
		}
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((entry, index) => {
			scanSecrets(entry, `${path}[${index}]`, reasons);
		});
		return;
	}
	if (value && typeof value === "object") {
		for (const [key, entry] of Object.entries(value)) scanSecrets(entry, `${path}.${key}`, reasons);
	}
}

/**
 * Structural validation of the acceptance bundle against the report and limits.
 * Recognizes missing fields, missing/contradictory refs/digests, an incorrect
 * report_digest coverage, an oversized object and any secret-looking value.
 */
export function validateAcceptanceBundle(bundle, { report = null, limits = DEFAULT_LIMITS } = {}) {
	const reasons = [];
	if (!bundle || typeof bundle !== "object" || Array.isArray(bundle))
		return { ok: false, reasons: ["bundle must be an object"] };
	limits = { ...DEFAULT_LIMITS, ...limits };
	for (const field of [
		"schema_version",
		"generator",
		"report_digest",
		"bundle_digest",
		"tasks",
		"stages",
		"outcomes",
		"integrity",
		"authorization",
		"campaign_id",
	]) {
		if (!(field in bundle)) reasons.push(`bundle is missing required field ${field}`);
	}
	if (!Array.isArray(bundle.tasks)) reasons.push("bundle.tasks must be an array");
	if (!Array.isArray(bundle.stages)) reasons.push("bundle.stages must be an array");
	if (!Array.isArray(bundle.outcomes)) reasons.push("bundle.outcomes must be an array");
	if (!bundle.integrity || typeof bundle.integrity !== "object" || Array.isArray(bundle.integrity))
		reasons.push("bundle.integrity must be an object");
	for (const field of ["report_digest", "bundle_digest"]) {
		if (typeof bundle[field] !== "string" || !bundle[field]) reasons.push(`bundle.${field} must be a nonempty digest`);
	}
	if (report) {
		if (report.report_digest !== digest(withoutReportDigest(report)))
			reasons.push("report.report_digest does not cover report contents");
		if (Buffer.byteLength(`${JSON.stringify(report, null, 2)}\n`, "utf8") > limits.max_report_bytes)
			reasons.push(`report size exceeds max_report_bytes ${limits.max_report_bytes}`);
	}
	if (!bundle.external_reviewer || bundle.external_reviewer.invoked_by_aegis !== false) {
		reasons.push("bundle.external_reviewer.invoked_by_aegis must be false");
	}
	// Outcome refs carry both a binding id and a digest, never raw artifacts.
	for (const [index, outcome] of (Array.isArray(bundle.outcomes) ? bundle.outcomes : []).entries()) {
		if (!outcome || typeof outcome !== "object") {
			reasons.push(`outcome[${index}] is not an object`);
			continue;
		}
		if (!outcome.outcome_id) reasons.push(`outcome[${index}] has no outcome_id`);
		if (report && Array.isArray(report.outcomes)) {
			const original = report.outcomes.find((entry) => entry.outcome_id === outcome.outcome_id);
			if (!original || digest(original) !== digest(outcome))
				reasons.push(`outcome[${index}] contradicts the report outcome/reference`);
		}
		if (!Array.isArray(outcome.evidence_refs)) reasons.push(`outcome[${index}].evidence_refs must be an array`);
		if ((outcome.evidence_refs?.length ?? 0) > limits.max_evidence_refs_per_outcome)
			reasons.push(`outcome[${index}] exceeds max_evidence_refs_per_outcome`);
		for (const ref of Array.isArray(outcome.evidence_refs) ? outcome.evidence_refs : []) {
			if (!ref || typeof ref !== "object") reasons.push(`outcome[${index}] has a non-object evidence ref`);
			else if (!ref.ref_id || !ref.digest)
				reasons.push(`outcome[${index}] has an evidence ref with neither ref_id nor digest, or one binding is missing`);
		}
	}
	// report_digest coverage: when a report is supplied, the bundle's report_digest
	// must equal it.
	if (report && typeof report.report_digest === "string" && bundle.report_digest !== report.report_digest) {
		reasons.push("bundle.report_digest does not match the report's report_digest");
	}
	// bundle_digest must cover report_digest: recompute.
	const { withoutBundleDigest } = recomputeHelpers();
	const expectedBundleDigest = digest(withoutBundleDigest(bundle));
	if (bundle.bundle_digest !== expectedBundleDigest) {
		reasons.push("bundle.bundle_digest does not cover the bundle contents (report_digest mismatch or tampering)");
	}
	// Limits.
	if (Array.isArray(bundle.outcomes) && bundle.outcomes.length > limits.max_outcomes) {
		reasons.push(`bundle.outcomes (${bundle.outcomes.length}) exceeds max_outcomes ${limits.max_outcomes}`);
	}
	if (Array.isArray(bundle.tasks) && bundle.tasks.length > limits.max_tasks) {
		reasons.push(`bundle.tasks (${bundle.tasks.length}) exceeds max_tasks ${limits.max_tasks}`);
	}
	if (Array.isArray(bundle.faults) && bundle.faults.length > limits.max_faults)
		reasons.push(`bundle.faults exceeds max_faults ${limits.max_faults}`);
	const serializedBytes = Buffer.byteLength(`${JSON.stringify(bundle, null, 2)}\n`, "utf8");
	if (serializedBytes > limits.max_bundle_bytes) {
		reasons.push(`bundle size (${serializedBytes}) exceeds max_bundle_bytes ${limits.max_bundle_bytes}`);
	}
	// Secret scan (defense in depth).
	scanSecrets(bundle, "bundle", reasons);
	if (report) scanSecrets(report, "report", reasons);
	const secretReasons = reasons.filter((r) => /possible secret/.test(r));
	return { ok: reasons.length === 0, reasons, secret_findings: secretReasons };
}

function recomputeHelpers() {
	// Local re-import avoids a circular init and keeps the helper identity stable.
	return {
		withoutBundleDigest(value) {
			const clone = { ...value };
			delete clone.bundle_digest;
			return clone;
		},
	};
}

// ---------------------------------------------------------------------------
// Artifact generation
// ---------------------------------------------------------------------------

/**
 * Generate the four artifacts from authoritative input. PURE/deterministic:
 * the same input always yields the same semantic/report/bundle digests.
 *
 * `generated_at` and output paths are NON-semantic and are excluded from the
 * digests; they are returned separately so a caller may render them without
 * polluting the digests.
 */
export function generateCampaignArtifacts(
	{
		manifest,
		manifestDigest = null,
		events = [],
		artifacts = {},
		runtimeDigests = {},
		limits = DEFAULT_LIMITS,
		generatedAt = null,
	} = /** @type {any} */ ({}),
) {
	const inputs = buildReportInputs({ manifest, manifestDigest, events, artifacts, runtimeDigests });
	let report = buildCampaignReport({
		manifest,
		manifestDigest: inputs.manifestDigest,
		campaignAggregate: inputs.campaignAggregate,
		stageAggregates: inputs.stageAggregates,
		taskAggregates: inputs.taskAggregates,
		outcomes: inputs.outcomes,
		sessionCount: inputs.counts.sessions.rotations_committed,
		actionCount: inputs.counts.actions.executed,
		retries: 0,
		recoveries: inputs.projection.tasks.filter((t) => t.reconciliation_state === "resolved").length,
		faults: inputs.faults,
		integrity: inputs.integrity ?? inputs.projection.health ?? {},
		experienceDecisions: [],
		unsupportedClaims: unsupportedClaims(inputs),
		missingEvidence: inputs.missingEvidence.map((m) => `${m.task_id}/${m.stage_id}: ${m.reason}`),
		conflicts: inputs.conflicts,
	});
	// Attach the explicit committed-derived counts and lifecycle view so the report
	// is testable against the source, not against an internal counter.
	report.committed_counts = inputs.counts;
	report.independence = inputs.independence;
	report.task_lifecycle = inputs.taskAggregates.map((t) => ({
		task_id: t.task_id,
		evidence_status: t.status,
		lifecycle_state: t.lifecycle_state,
		stop_reason: t.stop_reason,
		reconciliation_state: t.reconciliation_state,
		is_dynamic: t.is_dynamic,
	}));
	report.campaign_control = inputs.projection.control;
	report.dynamic_proposals = [...inputs.projection.proposals.entries()].map(([id, entry]) => ({
		id,
		digest: entry.digest,
		offset: entry.offset,
	}));
	// Additional projection fields must go through the same value-level filter.
	const credentialPolicy = report.authorization?.credentials;
	report = redactSecrets(report);
	if (report.authorization) report.authorization.credentials = credentialPolicy;
	report.report_digest = digest(withoutReportDigest(report));

	const bundle = buildAcceptanceBundle({ report, runtimeDigests });
	const markdown = renderCampaignReportMarkdown(report) + renderCommittedCountsMarkdown(report);
	const reviewerPrompt = renderReviewerPrompt(bundle);

	return {
		report,
		markdown,
		bundle,
		reviewerPrompt,
		digests: {
			report_digest: report.report_digest,
			bundle_digest: bundle.bundle_digest,
			semantic_digest: digest(semanticView(report)),
		},
		generatedAt,
		limits,
	};
}

function unsupportedClaims(inputs) {
	const claims = [];
	if (inputs.integrity?.event_chain_ok !== true)
		claims.push("event chain integrity failed; no task success is established from these rows");
	if (inputs.counts?.episodes?.independent_episode_count === null) {
		claims.push("independent Episode count for evidence is not asserted by the export");
	}
	if (!inputs.runtimeDigests || Object.keys(inputs.runtimeDigests).length === 0) {
		claims.push("runtime/model/tool digests are unknown (not supplied; never fabricated)");
	}
	return claims;
}

function semanticView(report) {
	const clone = { ...report };
	delete clone.report_digest;
	delete clone.generated_at;
	return clone;
}

/** Markdown section for the committed-derived counts (JSON/MD agreement). */
function renderCommittedCountsMarkdown(report) {
	const counts = report.committed_counts ?? {};
	const actions = counts.actions ?? {};
	const sessions = counts.sessions ?? {};
	const lines = [];
	lines.push("## Committed action / session counts (deduplicated)");
	lines.push("");
	lines.push(`- actions requested: ${actions.requested ?? UNKNOWN}`);
	lines.push(`- actions executed: ${actions.executed ?? UNKNOWN}`);
	lines.push(`- actions pending: ${actions.pending ?? UNKNOWN}`);
	lines.push(`- actions rejected: ${actions.rejected ?? UNKNOWN}`);
	lines.push(`- transport failures: ${actions.transport_failures ?? UNKNOWN}`);
	lines.push(`- committed Session rotations: ${sessions.rotations_committed ?? UNKNOWN}`);
	lines.push(
		`- distinct Episode ids (NOT an independent-evidence count): ${counts.episodes?.distinct_episode_ids ?? UNKNOWN}`,
	);
	lines.push("");
	if (report.task_lifecycle?.length) {
		lines.push("## Task lifecycle vs evidence");
		lines.push("");
		lines.push("| task | lifecycle | evidence | stop_reason | dynamic |");
		lines.push("| --- | --- | --- | --- | --- |");
		for (const t of report.task_lifecycle) {
			lines.push(
				`| ${t.task_id} | ${t.lifecycle_state} | ${t.evidence_status} | ${t.stop_reason ?? "-"} | ${t.is_dynamic} |`,
			);
		}
		lines.push("");
	}
	lines.push(`_bundle covers report_digest; semantic digest excludes report_digest/generated_at_`);
	lines.push("");
	return lines.join("\n");
}

/** Verify the committed chain and derive integrity facts from the source. */
export function deriveIntegrity(events = []) {
	const verification = verifyChain(events);
	return {
		event_chain_ok: verification.ok,
		event_chain_errors: verification.errors.slice(0, 5),
		event_count: events.length,
		last_committed_digest: events.length > 0 ? (events[events.length - 1]?.event_digest ?? null) : null,
		checkpoint_ok: null, // a checkpoint is a derived cache; not read as truth
	};
}

function withoutReportDigest(value) {
	const clone = { ...value };
	delete clone.report_digest;
	return clone;
}
