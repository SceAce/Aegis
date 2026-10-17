// Pure binding validation. The Host must authenticate result provenance before
// calling this interface; a payload's trusted flag is not authentication.
const fields = [
	"platform",
	"challenge_id",
	"instance_id",
	"instance_revision",
	"campaign_id",
	"task_id",
	"episode_id",
	"criterion_id",
	"subject_ref",
];
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const nonempty = (s) => typeof s === "string" && s.length > 0 && s.length <= 2048;
function checkBinding(b) {
	return fields
		.filter((key) =>
			key === "instance_revision" ? !Number.isSafeInteger(b?.[key]) || b[key] < 0 : !nonempty(b?.[key]),
		)
		.map((key) => `invalid ${key}`);
}
export function validateFlagCandidate(candidate) {
	const reasons = [];
	if (!object(candidate)) return { ok: false, reasons: ["candidate required"] };
	if (!nonempty(candidate.candidate_id) || !nonempty(candidate.candidate))
		reasons.push("candidate identity/value required");
	if (candidate.claimed_success !== undefined && typeof candidate.claimed_success !== "boolean")
		reasons.push("claimed_success must be boolean");
	if (
		!Array.isArray(candidate.evidence_refs) ||
		!candidate.evidence_refs.length ||
		candidate.evidence_refs.some((ref) => !nonempty(ref?.ref_id) || !/^sha256:[a-f0-9]{64}$/.test(ref?.digest))
	)
		reasons.push("evidence refs required");
	reasons.push(...checkBinding(candidate.binding));
	return { ok: reasons.length === 0, reasons };
}
export function validatePlatformResult(result) {
	const reasons = [];
	if (!object(result)) return { ok: false, reasons: ["result required"] };
	for (const key of fields.slice(0, 4))
		if (key === "instance_revision" ? !Number.isSafeInteger(result[key]) || result[key] < 0 : !nonempty(result[key]))
			reasons.push(`invalid ${key}`);
	if (!["accepted", "rejected"].includes(result.status)) reasons.push("invalid status");
	if (
		!["platform", "human"].includes(result.source?.kind) ||
		result.source?.trusted !== true ||
		!nonempty(result.source?.reference)
	)
		reasons.push("independent source required");
	return { ok: !reasons.length, reasons };
}
export function bindPlatformResult({ candidate, result, binding }) {
	const reasons = [
		...validateFlagCandidate(candidate).reasons,
		...validatePlatformResult(result).reasons,
		...checkBinding(binding),
	];
	for (const key of fields) {
		if (candidate?.binding?.[key] !== binding?.[key]) reasons.push(`candidate ${key} mismatch`);
		if (result && Object.hasOwn(result, key) && result[key] !== binding?.[key]) reasons.push(`result ${key} mismatch`);
	}
	return { ok: !reasons.length, reasons };
}
export function resolveWebCriterion({ candidate, result, binding }) {
	if (!result) return { status: "unknown", reasons: [], outcome_payload: null };
	const bound = bindPlatformResult({ candidate, result, binding });
	if (!bound.ok || result.status === "rejected")
		return { status: "rejected", reasons: bound.reasons, outcome_payload: null };
	return {
		status: "accepted",
		reasons: [],
		outcome_payload: {
			...binding,
			status: "success",
			evidence_refs: structuredClone(candidate.evidence_refs),
			source: structuredClone(result.source),
		},
	};
}
