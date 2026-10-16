// Domain-neutral, mechanical text views. Offsets refer to REDACTED UTF-16 text,
// never to raw bytes. Selection conveys no success, importance or command meaning.
import { digest } from "../shared/events.mjs";
import { redactMemoryText } from "./summary.mjs";

/** @param {unknown} input @param {number} maxChars */
export function captureTextFragments(input, maxChars = 900) {
	const raw = typeof input === "string" ? input : "";
	const text = redactMemoryText(raw);
	const width = Math.max(8, Math.floor(maxChars / 3));
	const starts = text.length <= maxChars ? [0] : [0, Math.floor((text.length - width) / 2), text.length - width];
	const fragments = starts.map((offset, index) => ({
		offset,
		text: text.slice(offset, offset + (starts.length === 1 ? maxChars : width)),
		part: starts.length === 1 ? "whole" : ["head", "middle", "tail"][index],
	}));
	return {
		format: "redacted-text-fragments-v1",
		offset_unit: "redacted_utf16",
		raw_chars: raw.length,
		chars: text.length,
		digest: digest(text),
		redacted: raw !== text,
		truncated: fragments.reduce((sum, part) => sum + part.text.length, 0) < text.length,
		fragments,
	};
}

/** Re-sample only captured fragments; never claim to reconstruct missing gaps. */
export function compactTextFragments(captured, maxChars = 180) {
	if (!captured?.fragments) return null;
	const parts = captured.fragments;
	const width = Math.max(4, Math.floor(maxChars / Math.max(1, parts.length)));
	return {
		offset_unit: "redacted_utf16",
		chars: captured.chars,
		digest: captured.digest,
		truncated: captured.truncated || parts.some((part) => part.text.length > width),
		fragments: parts.map((part) => {
			const excess = Math.max(0, part.text.length - width);
			const delta = part.part === "tail" ? excess : part.part === "middle" ? Math.floor(excess / 2) : 0;
			return { offset: part.offset + delta, text: part.text.slice(delta, delta + width), part: part.part };
		}),
	};
}
