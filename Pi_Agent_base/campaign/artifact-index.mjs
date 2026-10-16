// Aegis — neutral artifact/evidence index (E1 §8.1 item 2).
//
// A tiny, I/O-free helper that turns committed rows into a `ref_id -> digest`
// index. It is deliberately DEPENDENCY-FREE (only the event shape is read) so
// BOTH the Campaign projection chain (`c3-entry`) and the runtime Board can use
// the SAME index without forming a `Board -> Campaign projection -> c3-entry ->
// Board` import cycle. `c3-entry.mjs` re-exports it for backward compatibility.
//
// Only TRUSTED sources (runtime/oracle/human) contribute. Every entry is tagged
// with its origin event/offset. This map is a CONVENIENCE view (latest digest per
// ref) for diagnostics and the Broker's own retry checks; it is NOT evidence
// authority. The Campaign projection ignores tagged entries and rebuilds a
// prefix-bound artifact log itself (`authority.mjs`), so a later artifact can
// never make an earlier Outcome resolvable.

/**
 * @param {Array<any>} events committed rows (physical order)
 * @returns {Map<string, {ref_id: string, digest: string}>}
 */
export function artifactIndexFromEvents(events = []) {
	const index = new Map();
	for (const [offset, event] of events.entries()) {
		const tag = { origin: "event", origin_offset: offset, origin_event_id: event?.event_id ?? null };
		if (!["runtime", "oracle", "human"].includes(event?.source?.kind)) continue;
		const payload = event?.payload ?? {};
		if (event?.event_type === "action.completed") {
			const refId = payload.evidence_ref;
			if (typeof refId === "string" && typeof payload.content_digest === "string") {
				index.set(refId, { ref_id: refId, digest: payload.content_digest, ...tag });
			}
		}
		// Oracle-committed evidence refs (e.g. from a reconcile that read the real
		// artifact) are indexed too.
		if (!["oracle", "human"].includes(event?.source?.kind)) continue;
		const outcome = payload.outcome;
		for (const ref of Array.isArray(outcome?.evidence_refs) ? outcome.evidence_refs : []) {
			if (ref?.ref_id && typeof ref.digest === "string")
				index.set(ref.ref_id, { ref_id: ref.ref_id, digest: ref.digest, ...tag });
		}
		// Stage-level results carry their own evidence refs in the outer payload.
		for (const ref of Array.isArray(payload.evidence_refs) ? payload.evidence_refs : []) {
			if (ref?.ref_id && typeof ref.digest === "string")
				index.set(ref.ref_id, { ref_id: ref.ref_id, digest: ref.digest, ...tag });
		}
	}
	return index;
}
