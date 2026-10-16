// Aegis experience routing: normalize a contest injection decision.
//
// The contest extension matches hint cards and decides what to inject into the
// NEXT request. That decision is NOT an active Experience and NOT verified
// truth; it is a routing decision with provenance. This module turns the
// contest extension's bus message into a single, bounded `experience.decision`
// payload the Observer writes through its ONE EventLog. Keeping the shape here
// (not in the extension) makes it directly unit-testable and keeps the observer
// a thin adapter.
//
// Rules:
//   * Every candidate the matcher saw is listed under `considered`.
//   * Candidates whose scope/conditions matched are listed under `matched`.
//   * Candidates that were dropped are listed under `rejected` WITH a reason
//     (a card is never silently dropped).
//   * At most one `selected` card is recorded, with its provenance digest.
//   * The card stays a Hint / candidate input; it is never an active
//     Experience. `active_experience` is always false.
//   * No raw secrets or tool output are copied; only ids/refs/digests.

const MAX_CARDS = 32;

function normalizeRef(value) {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const id = typeof value.id === "string" ? value.id : typeof value.ref_id === "string" ? value.ref_id : "";
		const revision = typeof value.revision === "string" ? value.revision : typeof value.ref === "string" ? value.ref : null;
		const status = typeof value.status === "string" ? value.status : null;
		const title = typeof value.title === "string" ? value.title : null;
		if (!id) return null;
		return { id, revision, status, title };
	}
	if (typeof value === "string" && value.trim()) {
		const m = /^([^@\s:]+)(?:@([^:\s]+))?/.exec(value.trim());
		return m ? { id: m[1], revision: m[2] ?? null, status: null, title: null } : null;
	}
	return null;
}

function normalizeList(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const entry of value.slice(0, MAX_CARDS)) {
		const ref = normalizeRef(entry);
		if (ref) {
			out.push({ ...ref, ...(entry && typeof entry === "object" && typeof entry.reason === "string" ? { reason: entry.reason } : {}) });
		}
	}
	return out;
}

/**
 * Build the `experience.decision` payload from a contest decision message.
 *
 * @param {object} message the bus payload emitted by aegis-contest
 * @param {{episodeId?: string|null, promptEventId?: string|null}} [context]
 * @returns {object} an `experience.decision` payload
 */
export function normalizeExperienceDecision(message, context = {}) {
	const msg = message && typeof message === "object" ? message : {};
	const mode = msg.mode === "hint" || msg.mode === "off" ? msg.mode : "unknown";
	const considered = normalizeList(msg.considered);
	const matched = normalizeList(msg.matched);
	const rejected = normalizeList(msg.rejected).map((entry) => ({ ...entry, reason: entry.reason || "card did not match scope/conditions" }));
	const selected = normalizeRef(msg.selected);
	const cardProvenance = msg.card_provenance && typeof msg.card_provenance === "object"
		? {
				cards_path: typeof msg.card_provenance.cards_path === "string" ? msg.card_provenance.cards_path : null,
				cards_digest: typeof msg.card_provenance.cards_digest === "string" ? msg.card_provenance.cards_digest : null,
				cards_loaded: Number.isInteger(msg.card_provenance.cards_loaded) ? msg.card_provenance.cards_loaded : null,
			}
		: null;
	return {
		kind: "experience_injection_decision",
		mode,
		considered,
		matched,
		rejected,
		selected: selected ? { ...selected, digest: msg.selected?.digest ?? null } : null,
		reason: typeof msg.reason === "string" && msg.reason ? msg.reason : mode === "off" ? "mode=off (record only)" : considered.length === 0 ? "no candidate cards configured" : "matched",
		// A card is a Hint / candidate input, never an active Experience.
		active_experience: false,
		verdict: "unverified",
		card_provenance: cardProvenance,
		observations: Array.isArray(msg.observations) ? msg.observations.slice(0, 16).map(String) : [],
		task_category: typeof msg.task_category === "string" ? msg.task_category : null,
		environment: typeof msg.environment === "string" ? msg.environment : null,
		injected: typeof msg.injected === "string" ? msg.injected : "",
		episode_id: context.episodeId ?? null,
		causation_id: context.promptEventId ?? null,
	};
}
