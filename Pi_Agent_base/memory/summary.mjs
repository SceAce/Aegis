// Bounded display data for memory capture/projection. Never a verdict or grant.
const SECRET_KEY =
	/^(?:.*[_-])?(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credentials?|private[_-]?key|access[_-]?token|refresh[_-]?token)$/i;
const OMITTED = "[truncated]";

/** Redact common credentials in free text before any clipping. */
export function redactMemoryText(value) {
	return String(value ?? "")
		.replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED_KEY]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(
			/((?:api[_-]?key|token|password|secret|authorization|cookie)["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
			"$1[REDACTED]",
		)
		.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
		.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_KEY]")
		.replace(/([?&](?:token|api[_-]?key|password|secret)=)[^&#\s]+/gi, "$1[REDACTED]")
		.replaceAll("\0", "");
}

/** Single-line, redacted display string with an explicit truncation marker. */
export function memoryText(value, maxChars = 220) {
	const text = redactMemoryText(value).replace(/\s+/g, " ").trim();
	return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - OMITTED.length))}${OMITTED}`;
}

/**
 * Keep safe structured values (including false/0/empty containers), while
 * bounding depth, entries, string size and TOTAL serialized size. Raw objects
 * are never attached to an event by this helper. Cycles/getters are not read.
 * @param {unknown} input
 * @param {{maxChars?: number, maxDepth?: number, maxEntries?: number, maxString?: number}} options
 * @returns {{value: any, truncated: boolean, redacted: boolean}}
 */
export function summarizeMemoryValue(input, { maxChars = 900, maxDepth = 4, maxEntries = 16, maxString = 320 } = {}) {
	let truncated = false;
	let redacted = false;
	maxChars = Number.isSafeInteger(maxChars) && maxChars >= 32 ? maxChars : 900;
	let remaining = maxChars;
	const seen = new WeakSet();
	function visit(value, depth) {
		if (typeof value === "string") {
			const safe = redactMemoryText(value);
			if (safe !== value) redacted = true;
			const limit = Math.max(0, Math.min(maxString, remaining));
			const text = safe.length <= limit ? safe : `${safe.slice(0, Math.max(0, limit - OMITTED.length))}${OMITTED}`;
			if (text !== safe) truncated = true;
			remaining -= text.length;
			return text;
		}
		if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
			return value;
		if (typeof value !== "object") return `[unavailable ${typeof value}]`;
		if (depth >= maxDepth || remaining <= 0 || seen.has(value)) {
			truncated = true;
			return OMITTED;
		}
		seen.add(value);
		const entries = Object.entries(Object.getOwnPropertyDescriptors(value))
			.filter(([key]) => !Array.isArray(value) || key !== "length")
			.sort(([a], [b]) =>
				Array.isArray(value)
					? Number(a) - Number(b)
					: a === "criterion_id"
						? -1
						: b === "criterion_id"
							? 1
							: a < b
								? -1
								: a > b
									? 1
									: 0,
			);
		const result = Array.isArray(value) ? [] : {};
		for (const [index, [key, descriptor]] of entries.entries()) {
			if (index >= maxEntries || remaining <= 0) {
				truncated = true;
				if (Array.isArray(result)) result.push(OMITTED);
				else result._truncated = true;
				break;
			}
			remaining -= key.length + 4;
			let entry;
			if (SECRET_KEY.test(key.replace(/([a-z])([A-Z])/g, "$1_$2"))) {
				entry = "[REDACTED]";
				redacted = true;
			} else if (!("value" in descriptor)) {
				entry = "[unavailable accessor]";
			} else entry = visit(descriptor.value, depth + 1);
			if (Array.isArray(result)) result.push(entry);
			else Object.defineProperty(result, key, { value: entry, enumerable: true, configurable: true, writable: true });
		}
		seen.delete(value);
		return result;
	}
	let value = visit(input, 0);
	// Account for JSON escaping and keys without converting containers to prose.
	// Prefer clipping large leaves; preserve criterion identity and scalar values.
	while (JSON.stringify(value).length > maxChars) {
		truncated = true;
		const leaves = [];
		function collect(current, parent = null, key = null) {
			if (typeof current === "string" && current.length > OMITTED.length && key !== "criterion_id")
				leaves.push({ parent, key, value: current });
			else if (current && typeof current === "object")
				for (const [childKey, child] of Object.entries(current)) collect(child, current, childKey);
		}
		collect(value);
		leaves.sort((a, b) => JSON.stringify(b.value).length - JSON.stringify(a.value).length);
		if (leaves.length) {
			const leaf = leaves[0];
			const clipped = `${leaf.value.slice(0, Math.max(0, Math.floor(leaf.value.length / 2) - OMITTED.length))}${OMITTED}`;
			if (leaf.parent) leaf.parent[leaf.key] = clipped;
			else value = clipped;
			continue;
		}
		if (value && typeof value === "object") {
			const keys = Object.keys(value).filter((key) => key !== "criterion_id" && key !== "_truncated");
			// Keys themselves may be arbitrarily large. Explicitly omit entries as
			// the last resort, retaining the root container and identity when it fits.
			keys.sort((a, b) => JSON.stringify([b, value[b]]).length - JSON.stringify([a, value[a]]).length);
			if (keys.length) {
				if (Array.isArray(value)) value.pop();
				else {
					delete value[keys[0]];
					value._truncated = true;
				}
				continue;
			}
		}
		// A single identity can exceed the requested display budget; disclose its
		// omission instead of emitting a shortened identity that looks resolvable.
		value = Array.isArray(value)
			? [OMITTED]
			: typeof value === "object" && value !== null
				? { _truncated: true }
				: OMITTED;
	}

	return { value, truncated, redacted };
}

/** Render a structured summary for RAM. */
export function memoryValue(value, maxChars = 220) {
	const summary = summarizeMemoryValue(value, { maxChars, maxString: maxChars });
	return typeof summary.value === "string" ? summary.value : JSON.stringify(summary.value);
}
