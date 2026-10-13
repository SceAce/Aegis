// Deterministic Campaign report + acceptance bundle (C0 contract).
//
// These are DERIVED artifacts, rebuildable from committed event input + the
// immutable Manifest (docs/CAMPAIGN_ARCHITECTURE.md §3.7). They are bounded and
// deterministic: the same inputs must always produce the same digests.
//
// The acceptance bundle is a bounded input for an external reviewer
// (gpt-6.1-sol). Aegis does NOT invoke the reviewer automatically (user decision
// D5). The bundle contains digests and references, never credentials, flags,
// secrets or unrestricted raw tool output.
//
// The reviewer prompt requires exactly one structured verdict:
//   accepted | rejected | inconclusive | needs_more_evidence
// The reviewer input is read-only: it must not mutate EventLog, Board,
// RuntimeState or Experience.

import { digest } from "../fixture/contracts.mjs";

export const REPORT_SCHEMA_VERSION = "1.0";
export const BUNDLE_SCHEMA_VERSION = "1.0";
export const REPORT_GENERATOR_VERSION = "aegis-campaign-report/1.0.0";
export const REVIEWER_VERDICTS = Object.freeze(["accepted", "rejected", "inconclusive", "needs_more_evidence"]);

/**
 * The ONLY credential POLICY values the report/bundle may show verbatim.
 * `credentials` in a Manifest is a policy selector, not a secret value. Any
 * other value is either a malicious/confused input or a secret and MUST NOT be
 * restored into a derived artifact (CLOSE-03 / P0-3).
 */
export const VISIBLE_CREDENTIAL_POLICIES = Object.freeze(["none", "manifest_policy"]);

/**
 * Resolve the credential policy for display. Returns the value verbatim only
 * when it is one of the two reviewed policy strings; otherwise `[redacted]`.
 * This is a whitelist — never a round-trip that could restore an arbitrary
 * value after redaction.
 */
export function visibleCredentialPolicy(value) {
	return VISIBLE_CREDENTIAL_POLICIES.includes(value) ? value : "[redacted]";
}

// Key patterns that indicate a SECRET. `authorization` is deliberately NOT in
// this list: the structured authorization summary (execution_profile,
// workspace_root, allowed_targets, network policy, workspace_is_sandbox, ...)
// MUST remain visible for the whiteboard and final acceptance. Only a literal
// authorization HEADER/TOKEN/BEARER value is a secret.
const SECRET_KEY_PATTERN =
	/(?:secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|authorization[_-]?(?:header|token)|bearer[_-]?token|cookie|flag)/i;
// Value patterns: uppercase and lowercase flag markers, bearer tokens, private-key
// blocks and explicit secret ASSIGNMENTS (`api_key=...`, `password: ...`, ...).
// Case-insensitive so `flag{...}` / `ctf{...}` are caught.
const SECRET_VALUE_PATTERN =
	/(?:flag\{|ctf\{|\bbearer\s+[A-Za-z0-9._-]{8,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|(?:api[_-]?key|password|passwd|secret|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9._+/=-]{6,})/i;

/**
 * Redact any secret-looking key or value before it enters a report. This is a
 * defense-in-depth filter: the writer must ALSO not pass secrets in the first
 * place. Redaction never throws; it replaces with `"[redacted]"`.
 */
export function redactSecrets(value, keyHint = "") {
	if (SECRET_KEY_PATTERN.test(keyHint)) return "[redacted]";
	if (typeof value === "string") {
		if (SECRET_VALUE_PATTERN.test(value)) return "[redacted]";
		return value;
	}
	if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, keyHint));
	if (value && typeof value === "object") {
		const out = {};
		for (const [key, entry] of Object.entries(value)) out[key] = redactSecrets(entry, key);
		return out;
	}
	return value;
}

/**
 * Build the machine-readable Campaign report from committed projections. Every
 * input is a projection value, so the report is derivable without re-running the
 * Campaign.
 *
 * @param {{[key: string]: any}} args
 */
export function buildCampaignReport({
	manifest,
	manifestDigest,
	campaignAggregate,
	stageAggregates = [],
	taskAggregates = [],
	outcomes = [],
	sessionCount = 0,
	actionCount = 0,
	retries = 0,
	recoveries = 0,
	faults = [],
	integrity = { event_chain_ok: null, checkpoint_ok: null, last_committed_digest: null },
	experienceDecisions = [],
	unsupportedClaims = [],
	missingEvidence = [],
	conflicts = [],
} = {}) {
	const body = {
		schema_version: REPORT_SCHEMA_VERSION,
		generator: REPORT_GENERATOR_VERSION,
		campaign_id: manifest?.campaign_id ?? null,
		manifest: {
			schema_version: manifest?.schema_version ?? null,
			revision: manifest?.revision ?? null,
			digest: manifestDigest ?? null,
		},
		objective: manifest?.objective ?? null,
		authorization: sanitizeAuthorization(manifest?.authorization),
		worker: manifest?.worker ?? null,
		adapters: manifest?.adapters ?? null,
		campaign: campaignAggregate ?? null,
		tasks: taskAggregates.map((task) => ({
			task_id: task.task_id,
			status: task.status,
			reasons: task.reasons ?? [],
			stage_statuses: task.stage_statuses ?? {},
		})),
		stages: stageAggregates.map((stage) => ({
			stage_id: stage.stage_id,
			task_id: stage.task_id,
			status: stage.status,
			outcome_ids: stage.outcome_ids ?? [],
		})),
		outcomes: outcomes.map((outcome) => ({
			outcome_id: outcome.outcome_id,
			status: outcome.status,
			level: outcome.level ?? null,
			task_id: outcome.task_id ?? null,
			episode_id: outcome.episode_id ?? null,
			stage_id: outcome.step_id ?? outcome.stage_id ?? null,
			scope: outcome.scope ?? null,
			provenance_source: outcome.provenance?.source ?? outcome.oracle?.source ?? null,
			criterion_id: outcome.criterion?.criterion_id ?? null,
			oracle_id: outcome.oracle?.oracle_id ?? null,
			// Structured, redacted evidence refs so an acceptance reviewer can
			// TRACE each Outcome. Never the raw tool output, never a secret.
			evidence_refs: (outcome.evidence_refs ?? []).map((ref) => ({
				ref_type: ref?.ref_type ?? null,
				ref_id: ref?.ref_id ?? null,
				digest: ref?.digest ?? null,
			})),
			supersedes: outcome.supersedes ?? null,
		})),
		counts: { sessions: sessionCount, actions: actionCount, retries, recoveries },
		faults: faults.map((fault) => ({ kind: fault.kind, task_id: fault.task_id ?? null, detail: fault.detail ?? null })),
		integrity,
		experience_decisions: experienceDecisions.map((decision) => ({
			experience_id: decision.experience_id ?? null,
			status: decision.status ?? null,
			used: decision.used === true,
		})),
		unsupported_claims: [...unsupportedClaims],
		missing_evidence: [...missingEvidence],
		conflicts: [...conflicts],
	};
	const redacted = redactSecrets(body);
	// The structured authorization policy value `credentials` is a POLICY
	// (`none` / `manifest_policy`) and is shown verbatim ONLY for those two
	// reviewed values. Any other value (a leaked secret, a typo, a malicious
	// input) is replaced with `[redacted]` — never restored (P0-3).
	if (redacted.authorization && typeof redacted.authorization === "object") {
		redacted.authorization.credentials = visibleCredentialPolicy(body.authorization?.credentials ?? null);
	}
	redacted.report_digest = digest(withoutReportDigest(redacted));
	return redacted;
}

function sanitizeAuthorization(authorization) {
	if (!authorization || typeof authorization !== "object") return null;
	return {
		execution_profile: authorization.execution_profile ?? null,
		workspace_root: authorization.workspace_root ?? null,
		allowed_targets: [...(authorization.allowed_targets ?? [])],
		allowed_capabilities: [...(authorization.allowed_capabilities ?? [])],
		network: authorization.network ?? null,
		credentials: authorization.credentials ?? null,
		human_approval: authorization.human_approval ?? null,
		workspace_is_sandbox: authorization.workspace_is_sandbox === true,
	};
}

export function withoutReportDigest(value) {
	const clone = { ...value };
	delete clone.report_digest;
	return clone;
}

export function withoutBundleDigest(value) {
	const clone = { ...value };
	delete clone.bundle_digest;
	return clone;
}

/**
 * Build the bounded acceptance bundle for the external reviewer.
 *
 * @param {{[key: string]: any}} args
 */
export function buildAcceptanceBundle({ report, runtimeDigests = {} } = {}) {
	const bundle = {
		schema_version: BUNDLE_SCHEMA_VERSION,
		generator: REPORT_GENERATOR_VERSION,
		campaign_id: report?.campaign_id ?? null,
		manifest: { revision: report?.manifest?.revision ?? null, digest: report?.manifest?.digest ?? null },
		runtime: {
			pi_build_id: runtimeDigests.pi_build_id ?? null,
			rom_digest: runtimeDigests.rom_digest ?? null,
			tool_schema_digest: runtimeDigests.tool_schema_digest ?? null,
			model: runtimeDigests.model ?? null,
			oracle: runtimeDigests.oracle ?? null,
		},
		authorization: report?.authorization ?? null,
		tasks: report?.tasks ?? [],
		stages: report?.stages ?? [],
		outcomes: report?.outcomes ?? [],
		committed_counts: report?.committed_counts ?? null,
		task_lifecycle: report?.task_lifecycle ?? [],
		campaign_control: report?.campaign_control ?? null,
		dynamic_proposals: report?.dynamic_proposals ?? [],
		faults: report?.faults ?? [],
		budget: report?.campaign?.budget ?? null,
		integrity: report?.integrity ?? null,
		experience_decisions: report?.experience_decisions ?? [],
		unsupported_claims: report?.unsupported_claims ?? [],
		missing_evidence: report?.missing_evidence ?? [],
		conflicts: report?.conflicts ?? [],
		report_digest: report?.report_digest ?? null,
		// Explicitly bounded: the bundle is a hand-off artifact, not a live API.
		external_reviewer: {
			invoked_by_aegis: false,
			verdicts: [...REVIEWER_VERDICTS],
			may_mutate_state: false,
			// NOTE: the key must not contain the word "secret", or the value-level
			// redactor (which matches on the KEY name) would redact this structural
			// boolean. It is descriptive metadata, not a secret value.
			inputs_are_digests_only: true,
		},
	};
	const redacted = redactSecrets(bundle);
	// Preserve the authorization POLICY value `credentials` (none/manifest_policy)
	// for the same reason as the report, using the SAME whitelist. A non-policy
	// value is `[redacted]` and never restored.
	if (redacted.authorization && typeof redacted.authorization === "object") {
		redacted.authorization.credentials = visibleCredentialPolicy(bundle.authorization?.credentials ?? null);
	}
	// bundle_digest covers the report_digest (it is a field of the bundle). Only
	// bundle_digest itself is excluded, so a changed report_digest changes the
	// bundle_digest.
	redacted.bundle_digest = digest(withoutBundleDigest(redacted));
	return redacted;
}

/** Human-readable Markdown rendering of the report. Deterministic. */
export function renderCampaignReportMarkdown(report) {
	const lines = [];
	lines.push(`# Campaign report — ${report.campaign_id ?? "unknown"}`);
	lines.push("");
	lines.push(`- schema: \`${report.schema_version}\` generator: \`${report.generator}\``);
	lines.push(
		`- manifest revision: ${report.manifest?.revision ?? "n/a"} digest: \`${report.manifest?.digest ?? "n/a"}\``,
	);
	lines.push(
		`- execution profile: ${report.authorization?.execution_profile ?? "n/a"} (workspace_is_sandbox=${report.authorization?.workspace_is_sandbox === true})`,
	);
	lines.push("");
	if (report.campaign?.counts) {
		const c = report.campaign.counts;
		lines.push("## Task counts");
		lines.push("");
		lines.push(
			`total=${c.total} success=${c.success} failure=${c.failure} unknown=${c.unknown} invalid=${c.invalid} pending=${c.pending}`,
		);
		lines.push("");
	}
	lines.push("## Tasks");
	lines.push("");
	lines.push("| task | status | stages |");
	lines.push("| --- | --- | --- |");
	for (const task of report.tasks ?? []) {
		const stages = Object.entries(task.stage_statuses ?? {})
			.map(([id, status]) => `${id}:${status}`)
			.join(", ");
		lines.push(`| ${task.task_id} | ${task.status} | ${stages} |`);
	}
	lines.push("");
	lines.push("## Integrity");
	lines.push("");
	lines.push(`- event chain ok: ${report.integrity?.event_chain_ok ?? "unknown"}`);
	lines.push(`- checkpoint ok: ${report.integrity?.checkpoint_ok ?? "unknown"}`);
	lines.push(`- last committed digest: \`${report.integrity?.last_committed_digest ?? "n/a"}\``);
	lines.push("");
	if ((report.unsupported_claims ?? []).length > 0) {
		lines.push("## Unsupported claims");
		lines.push("");
		for (const claim of report.unsupported_claims) lines.push(`- ${claim}`);
		lines.push("");
	}
	if ((report.missing_evidence ?? []).length > 0) {
		lines.push("## Missing evidence");
		lines.push("");
		for (const item of report.missing_evidence) lines.push(`- ${item}`);
		lines.push("");
	}
	lines.push(`_report_digest: \`${report.report_digest}\`_`);
	lines.push("");
	return lines.join("\n");
}

/**
 * The fixed reviewer prompt. It requires exactly one verdict and states that the
 * reviewer must not mutate any Aegis state.
 */
export function renderReviewerPrompt(bundle) {
	return [
		"You are the independent acceptance reviewer for one Aegis Campaign.",
		"Review ONLY the bounded acceptance bundle below. Do not assume access to any",
		"other Aegis state, event log, credential, or live system.",
		"",
		"You MUST NOT mutate the EventLog, Board, RuntimeState, or Experience storage.",
		"You MUST return exactly one verdict, one of:",
		`  ${REVIEWER_VERDICTS.join(" | ")}`,
		"",
		"Rules:",
		"- Model self-report and tool exit codes are NOT task results.",
		"- `unknown` is not `failure`.",
		"- Counts are raw observations, not a statistical quality claim.",
		"- Link every finding to a bundle id (task_id / stage_id / outcome_id / fault).",
		"",
		`Bundle digest: ${bundle.bundle_digest}`,
		`Report digest: ${bundle.report_digest}`,
		"",
		'Return JSON: {"verdict": <one of the four>, "findings": [{"ref": "...", "note": "..."}], "missing_evidence": [...]}',
		"",
	].join("\n");
}

/** Validate that a reviewer response is structurally acceptable. */
export function validateReviewerVerdict(response) {
	const reasons = [];
	if (!response || typeof response !== "object") return { ok: false, reasons: ["reviewer response must be an object"] };
	if (!REVIEWER_VERDICTS.includes(response.verdict))
		reasons.push(`verdict must be one of ${REVIEWER_VERDICTS.join(", ")}`);
	if (response.findings !== undefined && !Array.isArray(response.findings))
		reasons.push("findings must be an array when present");
	return { ok: reasons.length === 0, reasons };
}
