// Validation for LLM proposals.
//
// The model may only PROPOSE. It may submit a candidate claim, a candidate
// hint, or an intent. It may NOT write verified facts, outcomes, authorization
// or active Experience state. This module is the single gate that encodes that
// rule before any proposal reaches the event log/board.

export const PROPOSAL_KINDS = ["claim", "intent", "candidate"];

/** Structured fields an LLM must never be able to set through a proposal. */
export const FORBIDDEN_FIELDS = [
	"fact",
	"refuted",
	"active",
	"verified",
	"authorization",
	"oracle_status",
	"outcome",
	"success",
	"trusted",
	"node_type",
	"node_id",
	"status",
];

const MAX_TEXT = 4000;
const MAX_SCOPE = 400;
const MAX_WHEN = 16;
const MAX_WHEN_ITEM = 200;
// A candidate Experience the model may PROPOSE. It is never compiled into an
// exploit, never auto-executed, and never stored as an active Experience: it is
// a structured, testable hypothesis awaiting independent verification.
const CANDIDATE_FIELDS = ["when", "do", "expect"];

export function validateProposal(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { accepted: false, reason: "proposal must be an object" };
	}
	const kind = typeof input.kind === "string" ? input.kind.trim().toLowerCase() : "";
	if (!PROPOSAL_KINDS.includes(kind)) {
		return {
			accepted: false,
			reason: `kind must be one of ${PROPOSAL_KINDS.join(", ")}; a model may not write facts, outcomes or active Experience state`,
		};
	}
	const text = typeof input.text === "string" ? input.text.trim() : "";
	if (!text) return { accepted: false, reason: "text is required" };
	if (text.length > MAX_TEXT) return { accepted: false, reason: `text exceeds ${MAX_TEXT} characters` };

	const escaped = [];
	for (const field of FORBIDDEN_FIELDS) {
		if (input[field] !== undefined && input[field] !== null && input[field] !== false && input[field] !== "") {
			escaped.push(field);
		}
	}
	if (escaped.length > 0) {
		return {
			accepted: false,
			reason: `proposal tried to set model-immutable field(s): ${escaped.join(", ")}`,
		};
	}

	const scope = typeof input.scope === "string" ? input.scope.trim() : null;
	if (scope && scope.length > MAX_SCOPE) return { accepted: false, reason: `scope exceeds ${MAX_SCOPE} characters` };
	// A candidate Experience must be a testable hypothesis: when (preconditions),
	// do (the proposed action), expect (the expected observable). All are
	// optional but validated when present, and never become proof.
	const candidateShape = { when: [], do: null, expect: null };
	if (kind === "candidate") {
		if (input.when !== undefined) {
			if (!Array.isArray(input.when)) return { accepted: false, reason: "when must be an array of condition strings" };
			for (const condition of input.when) {
				if (typeof condition !== "string" || !condition.trim()) return { accepted: false, reason: "each when condition must be a non-empty string" };
				if (condition.length > MAX_WHEN_ITEM) return { accepted: false, reason: `each when condition must be <= ${MAX_WHEN_ITEM} characters` };
			}
			candidateShape.when = input.when.slice(0, MAX_WHEN).map((condition) => condition.trim());
		}
		if (input.do !== undefined) {
			if (typeof input.do !== "string" || !input.do.trim()) return { accepted: false, reason: "do must be a non-empty string when provided" };
			if (input.do.length > MAX_TEXT) return { accepted: false, reason: `do exceeds ${MAX_TEXT} characters` };
			candidateShape.do = input.do.trim();
		}
		if (input.expect !== undefined) {
			if (typeof input.expect !== "string" || !input.expect.trim()) return { accepted: false, reason: "expect must be a non-empty string when provided" };
			if (input.expect.length > MAX_TEXT) return { accepted: false, reason: `expect exceeds ${MAX_TEXT} characters` };
			candidateShape.expect = input.expect.trim();
		}
	} else {
		// A non-candidate proposal may not smuggle structured Experience fields.
		for (const field of CANDIDATE_FIELDS) {
			if (input[field] !== undefined && input[field] !== null && input[field] !== "") {
				return { accepted: false, reason: `${field} is only valid for a candidate Experience proposal` };
			}
		}
	}
	// Source refs are non-sensitive labels. Accept plain strings or explicit
	// {ref_type, ref_id} objects, and normalize both to the schema Ref shape so
	// the board never has to guess what a bare string meant.
	const sourceRefs = [];
	if (Array.isArray(input.source_refs)) {
		for (const ref of input.source_refs) {
			if (typeof ref === "string" && ref.trim()) {
				sourceRefs.push({ ref_type: "external", ref_id: ref.trim() });
			} else if (ref && typeof ref === "object" && !Array.isArray(ref) && typeof ref.ref_type === "string" && typeof ref.ref_id === "string" && ref.ref_type.trim() && ref.ref_id.trim()) {
				sourceRefs.push({ ref_type: ref.ref_type.trim(), ref_id: ref.ref_id.trim(), ...(typeof ref.digest === "string" && ref.digest ? { digest: ref.digest } : {}) });
			}
		}
	}

	return {
		accepted: true,
		proposal: {
			kind,
			text,
			scope,
			source_refs: sourceRefs,
			...(kind === "candidate" ? candidateShape : {}),
			// intent maps to an Intent node; claim/candidate map to Hint nodes.
			node_kind: kind === "intent" ? "intent" : "hint",
		},
	};
}

/** Build the event payload for an accepted proposal. */
export function proposalPayload(proposal, extra = {}) {
	return {
		kind: proposal.kind,
		node_kind: proposal.node_kind,
		text: proposal.text,
		scope: proposal.scope,
		source_refs: proposal.source_refs,
		...(proposal.kind === "candidate" ? { when: proposal.when, do: proposal.do, expect: proposal.expect, candidate: true, verified: false, proof: null } : {}),
		...extra,
	};
}
