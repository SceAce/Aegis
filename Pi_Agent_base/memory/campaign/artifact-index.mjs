// Aegis — neutral artifact/evidence index (E1 §8.1 item 2).
//
// A tiny, I/O-free helper that turns committed rows into a `ref_id -> digest`
// index. It is deliberately DEPENDENCY-FREE (only the event shape is read) so
// BOTH the Campaign projection chain (`c3-entry`) and the runtime Board can use
// the SAME index without forming a `Board -> Campaign projection -> c3-entry ->
// Board` import cycle. `c3-entry.mjs` re-exports it for backward compatibility.
//
// Only TRUSTED sources (runtime/oracle/human) contribute. Artifacts produced by
// events are added in physical prefix order; a later event with the same ref and
// a different digest overwrites the value in the PREFIX index (the resolver that
// consumes it is responsible for only accepting refs resolvable at the judged
// prefix — the index itself is a plain map).

/**
 * @param {Array<any>} events committed rows (physical order)
 * @returns {Map<string, {ref_id: string, digest: string}>}
 */
export function artifactIndexFromEvents(events = []) {
	const index = new Map();
	for (const event of events) {
		if (!["runtime", "oracle", "human"].includes(event?.source?.kind)) continue;
		const payload = event?.payload ?? {};
		if (event?.event_type === "action.completed") {
			const refId = payload.evidence_ref;
			if (typeof refId === "string" && typeof payload.content_digest === "string") {
				index.set(refId, { ref_id: refId, digest: payload.content_digest });
			}
		}
		// Oracle-committed evidence refs (e.g. from a reconcile that read the real
		// artifact) are indexed too.
		if (!["oracle", "human"].includes(event?.source?.kind)) continue;
		const outcome = payload.outcome;
		for (const ref of Array.isArray(outcome?.evidence_refs) ? outcome.evidence_refs : []) {
			if (ref?.ref_id && typeof ref.digest === "string")
				index.set(ref.ref_id, { ref_id: ref.ref_id, digest: ref.digest });
		}
		// Stage-level results carry their own evidence refs in the outer payload.
		for (const ref of Array.isArray(payload.evidence_refs) ? payload.evidence_refs : []) {
			if (ref?.ref_id && typeof ref.digest === "string")
				index.set(ref.ref_id, { ref_id: ref.ref_id, digest: ref.digest });
		}
	}
	return index;
}
