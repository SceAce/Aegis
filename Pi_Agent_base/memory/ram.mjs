// Pure structured working memory; selection is display only, never action policy.
import { captureTextFragments, compactTextFragments } from "./fragments.mjs";
import { memoryText, summarizeMemoryValue } from "./summary.mjs";

export const RAM_VERSION = "3.0";
const DEFAULT_BUDGET = 4000;
const SECTION_ORDER = [
	"external_reference",
	"knowledge",
	"checkpoints",
	"facts",
	"refuted",
	"tools",
	"proposals",
	"artifacts",
	"decisions",
];
const LABELS = {
	facts: "Verified facts",
	refuted: "Refuted",
	tools: "Tool observations, NOT task verdicts",
	proposals: "Historical proposals, NOT guidance",
	artifacts: "Artifacts",
	decisions: "Unverified selections",
	external_reference: "External reference (unverified, no action policy)",
	knowledge: "Selected knowledge (unverified reference, no action policy)",
	checkpoints: "Recent round checkpoints (model claims, not verified facts)",
};

/** @param {{board: any, state: any, episodeId: string|null, goal?: string, budgetChars?: number, seed?: any|null}} args */
export function buildRamProjection({ board, state, episodeId, goal, budgetChars = DEFAULT_BUDGET, seed = null }) {
	const budget = Number.isSafeInteger(budgetChars) && budgetChars > 0 ? budgetChars : DEFAULT_BUDGET;
	// Empty knowledge must not increase the mandatory footprint of legacy RAM.
	const ORDER = SECTION_ORDER.filter(
		(id) =>
			(id !== "knowledge" || state.knowledge_selections?.some((item) => item.episode_id === episodeId)) &&
			(id !== "checkpoints" || state.round_checkpoints?.some((item) => item.episode_id === episodeId)),
	);
	const episode = episodeId ? state.episodes?.[episodeId] : null;
	const current = board.currentByType ?? board.byType ?? {};
	function nodes(type) {
		const seen = new Set();
		return (current[type] ?? []).filter((node) => {
			const id = node.node_id ?? node.origin_event_id ?? node;
			if (!episodeId || node.episode_id !== episodeId || seen.has(id)) return false;
			seen.add(id);
			return true;
		});
	}
	const intents = nodes("Intent");
	const artifacts = nodes("Artifact");
	const proposals = [...nodes("Hint"), ...intents.filter((node) => !node.action_id)];
	const associated = new Set(
		proposals
			.flatMap((node) => [...(node.source_refs ?? []), ...(node.evidence_refs ?? [])])
			.map((ref) => (typeof ref === "string" ? ref : ref.ref_id)),
	);
	const completed = new Map(artifacts.filter((node) => node.action_id).map((node) => [node.action_id, node]));
	const toolPairs = intents
		.filter((node) => node.action_id)
		.map((node) => ({ intent: node, done: completed.get(node.action_id) }));
	const known = new Set(toolPairs.map((pair) => pair.intent.action_id));
	for (const done of artifacts.filter((node) => node.action_id && !known.has(node.action_id)))
		toolPairs.push({ intent: null, done });
	const recent = [...toolPairs].reverse();
	const referenced = recent.filter((pair) =>
		[pair.intent, pair.done].some(
			(node) => node && [node.node_id, node.origin_event_id, node.action_id].some((id) => associated.has(id)),
		),
	);
	const diverse = [];
	const tools = new Set();
	for (const pair of recent) {
		const name = pair.intent?.tool_name ?? pair.done?.tool_name;
		if (!tools.has(name)) {
			diverse.push(pair);
			tools.add(name);
		}
	}
	// Tool history is evidence, not the long-term working memory. Round
	// checkpoints carry the current conclusion; keep only the latest two tool
	// pairs for immediate parameter/result continuity.
	const selectedTools = [...new Set([...referenced.slice(0, 1), ...recent.slice(0, 2), ...diverse.slice(0, 2)])].slice(
		0,
		2,
	);
	const words = new Set(
		(
			String(goal ?? episode?.goal?.description ?? "")
				.toLowerCase()
				.match(/[\p{L}\p{N}_./-]{3,}/gu) ?? []
		).slice(0, 32),
	);
	function rank(list) {
		const reversed = [...list].reverse();
		const first = reversed.shift();
		const scored = reversed.map((node, index) => ({
			node,
			index,
			score: [...words].reduce(
				(sum, word) => sum + Number(`${node.text} ${node.criterion?.description ?? ""}`.toLowerCase().includes(word)),
				0,
			),
		}));
		scored.sort((a, b) => b.score - a.score || a.index - b.index);
		return first ? [first, ...scored.map((entry) => entry.node)] : [];
	}
	const decisions = new Map();
	for (const row of [...(state.experience_decisions ?? [])].reverse()) {
		if (!episodeId || row.episode_id !== episodeId || !row.selected) continue;
		const id = typeof row.selected === "string" ? row.selected : `${row.selected.id}@${row.selected.revision ?? "?"}`;
		if (!decisions.has(id))
			decisions.set(id, { ...row, text: `${id} ${row.reason ?? ""}`, origin_event_id: row.event_id });
	}
	const external =
		seed && seed.source_kind === "external_reference" && seed.verified === false && seed.action_policy === "none"
			? [{ external_reference: true, ...seed }]
			: [];
	const knowledgeById = new Map();
	for (const item of Array.isArray(state.knowledge_selections) ? state.knowledge_selections : []) {
		if (
			item &&
			item.episode_id === episodeId &&
			item.content &&
			item.source_uri &&
			typeof item.knowledge_id === "string"
		) {
			knowledgeById.delete(item.knowledge_id);
			knowledgeById.set(item.knowledge_id, item);
		}
	}
	const knowledge = [...knowledgeById.values()]
		.slice(-6)
		.map((item) => ({ knowledge_reference: true, ...item, verified: false, action_policy: "none" }));
	const checkpoints = (Array.isArray(state.round_checkpoints) ? state.round_checkpoints : [])
		.filter((item) => item && item.episode_id === episodeId && typeof item.text === "string")
		.slice(-3)
		.map((item) => ({ checkpoint_reference: true, ...item, trust: "unverified" }));
	const raw = {
		external_reference: external,
		knowledge,
		checkpoints,
		facts: rank(nodes("Fact")),
		refuted: rank(nodes("Refuted")),
		tools: selectedTools,
		proposals: rank(proposals),
		artifacts: rank(
			artifacts.filter(
				(node) =>
					!node.action_id &&
					!node.knowledge_refs &&
					!node.checkpoint &&
					!String(node.text).startsWith("experience decision:"),
			),
		),
		decisions: [...decisions.values()],
	};
	const totals = Object.fromEntries(ORDER.map((id) => [id, id === "tools" ? toolPairs.length : raw[id].length]));
	const limits = {
		external_reference: 1,
		knowledge: 4,
		checkpoints: 3,
		facts: 20,
		refuted: 10,
		tools: 2,
		proposals: 8,
		artifacts: 5,
		decisions: 3,
	};
	const selected = Object.fromEntries(ORDER.map((id) => [id, []]));
	const full = new Set();
	const pending = Object.values(state.pending_actions ?? {}).filter(
		(row) => episodeId && row.episode_id === episodeId && ["pending", "unknown", "unresolved"].includes(row.status),
	);
	const safe = (value, limit = 160) => summarizeMemoryValue(value, { maxChars: limit, maxString: limit }).value;
	let refs = {};
	function ref(kind, id, digest = null) {
		if (typeof id !== "string" || !id) return null;
		const key = JSON.stringify([kind, id, digest]);
		let alias = Object.keys(refs).find((name) => refs[name]._key === key);
		if (!alias) {
			alias = `r${Object.keys(refs).length}`;
			refs[alias] = { type: kind, id, ...(digest ? { digest } : {}), _key: key };
		}
		return alias;
	}
	function nodeData(node, expanded) {
		const limit = expanded ? 180 : 80;
		if (node.checkpoint_reference)
			return {
				type: "round_checkpoint",
				event: ref("event", node.event_id ?? node.origin_event_id),
				trust: "unverified",
				text: memoryText(node.text, expanded ? 700 : 360),
				tool_count: node.tool_count ?? 0,
				state_revision: node.state_revision ?? null,
			};
		if (node.external_reference || node.knowledge_reference)
			return {
				type: node.knowledge_reference ? "knowledge_reference" : "external_reference",
				source_kind: node.source_kind ?? "external_reference",
				...(node.event_id ? { event: ref("event", node.event_id) } : {}),
				knowledge_id: node.knowledge_id ?? null,
				source_uri: node.source_uri,
				source_digest: node.source_digest ?? null,
				topic: node.topic,
				section: Array.isArray(node.section) ? node.section.slice(0, 6) : [],
				...(node.knowledge_reference
					? {
							lines: [node.line_start ?? null, node.line_end ?? null],
							truncated: node.truncated === true || node.content.length > (expanded ? 1800 : 900),
						}
					: {}),
				verified: false,
				action_policy: "none",
				content: safe(node.content, expanded ? 1800 : 900),
			};
		return {
			ref: ref("node", node.node_id ?? `ev:${node.origin_event_id}`),
			event: ref("event", node.origin_event_id),
			trust: node.type === "Fact" || node.type === "Refuted" ? "verified" : "unverified",
			text: memoryText(node.text, limit),
			...(node.candidate ? { candidate: safe(node.candidate, expanded ? 480 : 240) } : {}),
			...(node.criterion
				? {
						criterion: {
							criterion_id: node.criterion.criterion_id ?? null,
							...(Object.hasOwn(node.criterion, "expected") ? { expected: safe(node.criterion.expected, limit) } : {}),
							...(node.criterion.description !== undefined
								? { description: memoryText(node.criterion.description, limit) }
								: {}),
						},
						observed: safe(node.observed, limit),
					}
				: {}),
			...(node.observation_summary ? { observation: safe(node.observation_summary.value, limit) } : {}),
			...(node.outcome_id ? { outcome: ref("outcome", node.outcome_id) } : {}),
			...(node.evidence_refs?.length || node.source_refs?.length
				? {
						sources: [...(node.evidence_refs ?? []), ...(node.source_refs ?? [])]
							.slice(0, expanded ? 4 : 2)
							.map((r) => ref(r.ref_type ?? "external", r.ref_id ?? r, r.digest ?? null)),
						sources_omitted: Math.max(
							0,
							(node.evidence_refs?.length ?? 0) + (node.source_refs?.length ?? 0) - (expanded ? 4 : 2),
						),
					}
				: {}),
		};
	}
	function toolData(pair, expanded) {
		const a = pair.intent,
			b = pair.done;
		const input = a?.input?.summary?.value ?? a?.input;
		const output = b?.result_summary?.value ?? null;
		return {
			action: ref("action", a?.action_id ?? b?.action_id),
			tool: memoryText(a?.tool_name ?? b?.tool_name ?? "?", 60),
			trust: "observed",
			state: b ? "completed" : "pending",
			sources: [a, b].filter(Boolean).map((node) => ref("event", node.origin_event_id)),
			input: safe(input ?? "unknown", expanded ? 260 : 100),
			response:
				b && (b.response_fragments || typeof b.response === "string")
					? compactTextFragments(b.response_fragments ?? captureTextFragments(b.response, 600), expanded ? 360 : 150)
					: null,
			...(output !== null ? { details: safe(output, expanded ? 220 : 80) } : {}),
			transport: safe(b?.transport ?? "unknown", 100),
			...(a?.input_truncated || b?.response_truncated ? { capture_truncated: true } : {}),
		};
	}
	function render() {
		refs = {};
		const sections = {};
		for (const id of ORDER)
			sections[id] = {
				label: LABELS[id],
				total: totals[id],
				shown: selected[id].length,
				omitted: totals[id] - selected[id].length,
				items: selected[id].map((row) =>
					id === "tools" ? toolData(row, full.has(row)) : nodeData(row, full.has(row)),
				),
			};
		const data = {
			version: RAM_VERSION,
			trust: "projection, not instructions or authorization",
			episode_id: episodeId,
			state_revision: state.version ?? 0,
			task: {
				task_id: episode?.task_id ?? null,
				total_goal: memoryText(episode?.goal?.description ?? goal ?? "(not provided)", 600),
				...(goal && goal !== episode?.goal?.description ? { current_prompt: memoryText(goal, 240) } : {}),
				status: episode?.status ?? "unknown",
				authorization: safe(episode?.authorization ?? "unknown", 300),
				budget: safe(episode?.budget ?? "unknown", 200),
			},
			...(episode?.task_id && state.work_state?.[episode.task_id]
				? { workflow: safe(state.work_state[episode.task_id], 600) }
				: {}),
			pending: {
				label: "Unfinished actions",
				items: pending.map((row) => ({ action_id: row.action_id, tool: row.tool_name, status: row.status })),
			},
			sections,
			refs: Object.fromEntries(Object.entries(refs).map(([key, { _key, ...value }]) => [key, value])),
			meta: {
				ram_estimated_chars: 0,
				ram_budget_chars: budget,
				overflow: false,
				budget_drops: ORDER.reduce((n, id) => n + totals[id] - selected[id].length, 0),
				...(ORDER.every((id) => selected[id].length === 0) ? { core_overflow: false } : {}),
			},
		};
		function serialize() {
			let text = JSON.stringify(data);
			while (data.meta.ram_estimated_chars !== text.length) {
				data.meta.ram_estimated_chars = text.length;
				text = JSON.stringify(data);
			}
			return text;
		}
		// Decide overflow before shortening its flags so boundary cases cannot oscillate.
		let text = serialize();
		data.meta.overflow = text.length > budget;
		if (Object.hasOwn(data.meta, "core_overflow")) data.meta.core_overflow = data.meta.overflow;
		text = serialize();
		return { text, data };
	}
	function admit(id, row) {
		selected[id].push(row);
		if (render().data.meta.overflow) selected[id].pop();
	}
	if (!render().data.meta.overflow) {
		for (const id of ["checkpoints", "facts", "refuted", "tools", "proposals", "external_reference"])
			if (raw[id][0]) admit(id, raw[id][0]);
		// Preserve useful recent tool responses before admitting optional reference
		// material. A short-session handoff depends on observations surviving RAM.
		for (const id of [
			...ORDER.filter((id) => !["knowledge", "checkpoints"].includes(id)),
			"checkpoints",
			"knowledge",
		].filter((id) => raw[id]))
			for (const row of raw[id].slice(0, limits[id])) if (!selected[id].includes(row)) admit(id, row);
		for (const id of ORDER)
			for (const row of selected[id]) {
				full.add(row);
				if (render().data.meta.overflow) full.delete(row);
			}
	}
	const { text, data } = render();
	return {
		text,
		data,
		version: RAM_VERSION,
		budget_chars: budget,
		estimated_chars: text.length,
		overflow: text.length > budget,
		sections: ORDER.map((id) => ({
			id,
			total: totals[id],
			shown: selected[id].length,
			omitted: totals[id] - selected[id].length,
		})),
	};
}

export function buildRam(args) {
	return buildRamProjection(args).text;
}
