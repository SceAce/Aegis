// Pure structured working memory; selection is display only, never action policy.
import { captureTextFragments, compactTextFragments } from "./fragments.mjs";
import { memoryText, summarizeMemoryValue } from "./summary.mjs";

export const RAM_VERSION = "4.0";
const DEFAULT_BUDGET = 8000;
const REGISTER_CLAIMS = 3;
const REGISTER_FACTS = 6;
const REGISTER_KNOWLEDGE = 4;
const REGISTER_CHECKPOINTS = 1;
const REGISTER_ARTIFACTS = 1;
const REGISTER_DECISIONS = 1;
// A human hint is a single, Episode-bound instruction, so one row is the whole
// register. It is admitted ahead of auto-recall material but never displaces
// the mandatory core (task/permission/pending).
const REGISTER_HUMAN_HINTS = 1;
const SECTION_ORDER = [
	"human_hint",
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

/**
 * @param {{board: any, state: any, episodeId: string|null, goal?: string, budgetChars?: number, seed?: any|null, discipline?: {workspace?: string, tool_calls?: number, rules?: string[]}|null, rules?: Array<{kind?: string, text?: string, experience_id?: string|null, revision?: number|null, route?: string|null, source?: string|null}>|null, aliasRegistry?: Record<string, string>|null}} args
 */
export function buildRamProjection({
	board,
	state,
	episodeId,
	goal,
	budgetChars = DEFAULT_BUDGET,
	seed = null,
	discipline = null,
	rules = [],
	aliasRegistry = null,
}) {
	const budget = Number.isSafeInteger(budgetChars) && budgetChars > 0 ? budgetChars : DEFAULT_BUDGET;
	// Empty knowledge must not increase the mandatory footprint of legacy RAM.
	const ORDER = SECTION_ORDER.filter(
		(id) =>
			(id !== "knowledge" || state.knowledge_selections?.some((item) => item.episode_id === episodeId)) &&
			(id !== "human_hint" || state.human_hints?.some((item) => item.episode_id === episodeId)) &&
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
	// The current subgoal is the latest effective non-action Intent, in committed
	// order. Relevance ranking below must not move an older Intent ahead of it.
	const latestIntent = [...proposals].reverse().find((node) => node.type === "Intent") ?? null;
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
		[String(episode?.goal?.description ?? ""), String(goal ?? ""), String(latestIntent?.text ?? "")]
			.join(" ")
			.toLowerCase()
			.match(/[\p{L}\p{N}_./-]{3,}/gu)
			?.slice(0, 48) ?? [],
	);
	function rank(list) {
		return list
			.map((node, index) => ({
				node,
				index,
				score: [...words].reduce(
					(sum, word) => sum + Number(`${node.text} ${node.criterion?.description ?? ""}`.toLowerCase().includes(word)),
					0,
				),
			}))
			.sort((a, b) => b.score - a.score || b.index - a.index)
			.map((entry) => entry.node);
	}
	function rankJudgments() {
		const facts = rank(nodes("Fact"));
		const refuted = rank(nodes("Refuted"));
		const result = [];
		for (let index = 0; index < Math.max(facts.length, refuted.length); index += 1) {
			if (facts[index]) result.push(facts[index]);
			if (refuted[index]) result.push(refuted[index]);
		}
		return result;
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
	// The newest human hint for THIS Episode only. It is a human-voiced claim, so
	// it enters as an unverified reference with no action policy: it can never
	// satisfy a permit, a Fact or an active Experience.
	const humanHint = (Array.isArray(state.human_hints) ? state.human_hints : [])
		.filter((item) => item && item.episode_id === episodeId && typeof item.text === "string" && item.text)
		.slice(-REGISTER_HUMAN_HINTS)
		.map((item) => ({ human_hint: true, ...item, verified: false, action_policy: "none" }));
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
		.sort((a, b) => Number(b.selection_mode === "model_query") - Number(a.selection_mode === "model_query"))
		.slice(0, 6)
		.map((item) => ({ knowledge_reference: true, ...item, verified: false, action_policy: "none" }));
	const checkpoints = (Array.isArray(state.round_checkpoints) ? state.round_checkpoints : [])
		.filter((item) => item && item.episode_id === episodeId && typeof item.text === "string")
		.slice(-3)
		.map((item) => ({ checkpoint_reference: true, ...item, trust: "unverified" }));
	const raw = {
		human_hint: humanHint,
		external_reference: external,
		knowledge,
		checkpoints,
		judgments: rankJudgments(),
		facts: [],
		refuted: [],
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
	raw.facts = raw.judgments.filter((node) => node.type !== "Refuted");
	raw.refuted = raw.judgments.filter((node) => node.type === "Refuted");
	const totals = Object.fromEntries(ORDER.map((id) => [id, id === "tools" ? toolPairs.length : raw[id].length]));
	const limits = {
		external_reference: 1,
		human_hint: REGISTER_HUMAN_HINTS,
		knowledge: 4,
		checkpoints: REGISTER_CHECKPOINTS,
		facts: REGISTER_FACTS,
		refuted: REGISTER_FACTS,
		tools: 2,
		proposals: 8,
		artifacts: 5,
		decisions: 3,
	};
	const selected = Object.fromEntries(ORDER.map((id) => [id, []]));
	const pending = Object.values(state.pending_actions ?? {}).filter(
		(row) => episodeId && row.episode_id === episodeId && ["pending", "unknown", "unresolved"].includes(row.status),
	);
	const safe = (value, limit = 160) => summarizeMemoryValue(value, { maxChars: limit, maxString: limit }).value;
	let refs = {};
	function ref(kind, id, digest = null, extra = null) {
		if (typeof id !== "string" || !id) return null;
		const key = JSON.stringify([kind, id, digest]);
		// With an Episode-level registry, aliases are assigned once per canonical
		// identity and stay stable across requests. Without a registry (pure calls,
		// tests), aliases are local to this projection as before.
		let alias = aliasRegistry?.[key] ?? null;
		if (!alias && !aliasRegistry) {
			alias = Object.keys(refs).find((name) => refs[name]._key === key) ?? null;
		}
		if (!alias) {
			alias = `r${Object.keys(aliasRegistry ?? refs).length}`;
			if (aliasRegistry) aliasRegistry[key] = alias;
		}
		if (!refs[alias]) refs[alias] = { type: kind, id, ...(digest ? { digest } : {}), _key: key };
		if (extra && typeof extra === "object") Object.assign(refs[alias], extra);
		return alias;
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
			input: safe(input ?? "unknown", expanded ? 480 : 320),
			response:
				b && (b.response_fragments || typeof b.response === "string")
					? compactTextFragments(b.response_fragments ?? captureTextFragments(b.response, 600), expanded ? 360 : 150)
					: null,
			...(output !== null ? { details: safe(output, expanded ? 420 : 260) } : {}),
			transport: safe(b?.transport ?? "unknown", 100),
			...(a?.input_truncated || b?.response_truncated ? { capture_truncated: true } : {}),
		};
	}
	function registerFact(node, fallbackKind = "Fact") {
		const criterion = node.criterion
			? {
					criterion_id: node.criterion.criterion_id ?? null,
					...(Object.hasOwn(node.criterion, "expected") ? { expected: safe(node.criterion.expected, 120) } : {}),
					...(node.criterion.description !== undefined
						? { description: memoryText(node.criterion.description, 120) }
						: {}),
				}
			: null;
		const sources = [...(node.evidence_refs ?? []), ...(node.source_refs ?? [])]
			.slice(0, 4)
			.map((r) => ref(r.ref_type ?? "external", r.ref_id ?? r, r.digest ?? null));
		return {
			ref: ref("node", node.node_id ?? `ev:${node.origin_event_id}`),
			event: ref("event", node.origin_event_id),
			kind: node.type ?? fallbackKind,
			trust: "verified",
			text: memoryText(node.text, 220),
			...(criterion ? { criterion } : {}),
			...(node.observed !== null && node.observed !== undefined ? { observed: safe(node.observed, 120) } : {}),
			...(node.observation_summary ? { observation: safe(node.observation_summary.value, 120) } : {}),
			...(sources.length ? { sources } : {}),
		};
	}
	function registerClaim(node) {
		return {
			ref: ref("node", node.node_id ?? `ev:${node.origin_event_id}`),
			event: ref("event", node.origin_event_id),
			kind: node.type === "Intent" ? "intent" : "claim",
			trust: "unverified",
			text: memoryText(node.text, 260),
			scope: node.scope ?? null,
		};
	}
	function registerReference(node) {
		// A human hint is its own reference kind: it must stay distinguishable from
		// retrieved documents (external_reference) and knowledge rows so a reader can
		// tell a person's instruction apart from machine-retrieved material.
		if (node.human_hint)
			return {
				event: node.event_id ? ref("event", node.event_id) : null,
				kind: "human_hint",
				trust: "human_unverified",
				verified: false,
				action_policy: "none",
				hint_id: node.hint_id ?? null,
				content: safe(node.text, 450),
			};
		if (node.knowledge_reference)
			return {
				// The `ref` alias names the RETRIEVED document, not a committed event,
				// so it can never be a proposal source on its own. The alias entry
				// carries `eventId` (the `runtime.note` that recorded this selection)
				// so the proposal gate can resolve a citation of this handle to a real
				// auditable event instead of failing as "missing/foreign".
				ref: ref("knowledge", node.knowledge_id, null, node.event_id ? { eventId: node.event_id } : null),
				...(node.event_id ? { event: ref("event", node.event_id) } : {}),
				kind: "knowledge",
				trust: "reference",
				verified: false,
				action_policy: "none",
				knowledge_id: node.knowledge_id ?? null,
				bundle_source_ids: Array.isArray(node.bundle_source_ids) ? node.bundle_source_ids.slice(0, 16) : [],
				selection_mode: node.selection_mode ?? "automatic",
				source_uri: node.source_uri ?? null,
				source_digest: node.source_digest ?? null,
				topic: node.topic ?? null,
				section: Array.isArray(node.section) ? node.section.slice(0, 6) : [],
				lines: [node.line_start ?? null, node.line_end ?? null],
				content: safe(node.content, 7000),
			};
		return {
			event: node.event_id ? ref("event", node.event_id) : null,
			kind: "external_reference",
			trust: "reference",
			verified: false,
			action_policy: "none",
			source_kind: node.source_kind ?? "external_reference",
			source_uri: node.source_uri ?? null,
			source_digest: node.source_digest ?? null,
			content: safe(node.content, 7000),
		};
	}
	function registerRule(row) {
		const text = typeof row === "string" ? row : row?.text;
		if (typeof text !== "string" || !text.trim()) return null;
		return {
			kind: typeof row === "object" && row.kind ? row.kind : "active_experience",
			trust: "rule",
			not_authorization: true,
			text: memoryText(text, 300),
			...(typeof row === "object" && row.experience_id ? { experience_id: row.experience_id } : {}),
			...(typeof row === "object" && row.revision !== undefined ? { revision: row.revision } : {}),
			...(typeof row === "object" && row.route ? { route: row.route } : {}),
		};
	}
	function buildRegisters(task, subgoalNode) {
		const claims = [];
		let claimCandidates = [];
		if (subgoalNode) {
			const candidates = raw.proposals.filter((node) => node !== subgoalNode);
			claimCandidates = subgoalNode.scope ? candidates.filter((node) => node.scope === subgoalNode.scope) : candidates;
		} else {
			claimCandidates = raw.proposals;
		}
		for (const node of claimCandidates.slice(0, REGISTER_CLAIMS)) claims.push(registerClaim(node));
		const factNodes = raw.judgments.filter((node) =>
			selected[node.type === "Refuted" ? "refuted" : "facts"].includes(node),
		);
		const facts = factNodes.map((node) => registerFact(node, node.type ?? "Fact"));
		const referenceRows = [];
		for (const node of raw.human_hint) referenceRows.push(registerReference(node));
		for (const node of raw.external_reference) referenceRows.push(registerReference(node));
		const knowledgeRows = [...raw.knowledge].sort(
			(a, b) => Number(b.selection_mode === "model_query") - Number(a.selection_mode === "model_query"),
		);
		for (const node of knowledgeRows.slice(0, REGISTER_KNOWLEDGE)) referenceRows.push(registerReference(node));
		const ruleRows = [];
		for (const row of Array.isArray(rules) ? rules : []) {
			const rule = registerRule(row);
			if (rule) ruleRows.push(rule);
		}
		for (const row of Array.isArray(discipline?.rules) ? discipline.rules : []) {
			const rule = registerRule({ kind: "tool_discipline", text: row });
			if (rule) ruleRows.push(rule);
		}
		const latestTool = recent[0] ? toolData(recent[0], false) : null;
		const referencedTools = referenced
			.filter((pair) => pair !== recent[0])
			.slice(0, 1)
			.map((pair) => toolData(pair, false));
		const artifacts = raw.artifacts.slice(0, REGISTER_ARTIFACTS).map((node) => ({
			ref: ref("node", node.node_id ?? `ev:${node.origin_event_id}`),
			event: ref("event", node.origin_event_id),
			kind: "artifact",
			trust: "unverified",
			action_policy: "none",
			text: memoryText(node.text, 260),
		}));
		const checkpoints = [...raw.checkpoints]
			.sort((a, b) => (a.turn_index ?? -1) - (b.turn_index ?? -1))
			.slice(-REGISTER_CHECKPOINTS)
			.map((row) => ({
				event: ref("event", row.event_id ?? row.origin_event_id),
				trust: "unverified",
				kind: "round_checkpoint",
				text: memoryText(row.text, 300),
				tool_count: row.tool_count ?? 0,
				state_revision: row.state_revision ?? null,
			}));
		const decisions = raw.decisions.slice(0, REGISTER_DECISIONS).map((row) => ({
			text: memoryText(row.text, 200),
			trust: "unverified",
			event: ref("event", row.origin_event_id ?? row.event_id),
		}));
		return {
			task,
			rules: ruleRows.slice(0, 6),
			facts,
			claims,
			references: referenceRows,
			recent: latestTool,
			referenced: referencedTools,
			artifacts,
			checkpoints,
			decisions,
			pending: {
				label: "Unfinished actions",
				items: pending.map((row) => ({ action_id: row.action_id, tool: row.tool_name, status: row.status })),
			},
			omitted: {
				facts: Math.max(0, raw.judgments.length - facts.length),
				claims: Math.max(0, claimCandidates.length - claims.length),
				references: Math.max(0, raw.knowledge.length - REGISTER_KNOWLEDGE),
				rules: Math.max(0, ruleRows.length - 6),
				recent: 0,
				referenced: 0,
				artifacts: Math.max(0, raw.artifacts.length - artifacts.length),
				checkpoints: Math.max(0, raw.checkpoints.length - REGISTER_CHECKPOINTS),
				decisions: Math.max(0, raw.decisions.length - REGISTER_DECISIONS),
			},
		};
	}
	function render() {
		refs = {};
		const disciplineData =
			discipline && typeof discipline === "object"
				? {
						...(typeof discipline.workspace === "string" && discipline.workspace
							? { workspace: memoryText(discipline.workspace, 300) }
							: {}),
						...(Number.isSafeInteger(discipline.tool_calls) && discipline.tool_calls >= 0
							? { tool_calls: discipline.tool_calls }
							: {}),
						...(Array.isArray(discipline.rules)
							? {
									rules: discipline.rules
										.slice(0, 6)
										.map((rule) => memoryText(rule, 200))
										.filter(Boolean),
								}
							: {}),
					}
				: null;
		const subgoalNode = latestIntent;
		const subgoal = subgoalNode
			? {
					text: memoryText(subgoalNode.text, 300),
					scope: subgoalNode.scope ?? null,
					ref: ref("node", subgoalNode.node_id ?? `ev:${subgoalNode.origin_event_id}`),
					event: ref("event", subgoalNode.origin_event_id),
					status: subgoalNode.status ?? "candidate",
					trust: "unverified",
				}
			: null;
		const task = {
			task_id: episode?.task_id ?? null,
			total_goal: memoryText(episode?.goal?.description ?? goal ?? "(not provided)", 600),
			...(goal && goal !== episode?.goal?.description ? { current_prompt: memoryText(goal, 240) } : {}),
			...(subgoal ? { subgoal } : {}),
			status: episode?.status ?? "unknown",
			authorization: safe(episode?.authorization ?? "unknown", 300),
			budget: safe(episode?.budget ?? "unknown", 200),
		};
		const registers = buildRegisters(task, subgoalNode);
		const refsTable = Object.fromEntries(Object.entries(refs).map(([key, { _key, ...value }]) => [key, value]));
		function collectViewRefs() {
			const usedRefs = new Set();
			const useRef = (value) => {
				if (typeof value === "string" && refsTable[value]) usedRefs.add(value);
			};
			useRef(task.subgoal?.ref);
			useRef(task.subgoal?.event);
			for (const row of registers.facts) {
				useRef(row.ref);
				useRef(row.event);
				for (const source of row.sources ?? []) useRef(source);
			}
			for (const row of registers.claims) {
				useRef(row.ref);
				useRef(row.event);
			}
			for (const row of registers.references) {
				useRef(row.ref);
				useRef(row.event);
			}
			for (const row of registers.referenced) {
				useRef(row.action);
				for (const source of row.sources ?? []) useRef(source);
			}
			for (const row of registers.artifacts) {
				useRef(row.ref);
				useRef(row.event);
			}
			for (const row of registers.checkpoints) useRef(row.event);
			for (const row of registers.decisions) useRef(row.event);
			for (const source of registers.recent?.sources ?? []) useRef(source);
			useRef(registers.recent?.action);
			return Object.fromEntries([...usedRefs].map((key) => [key, refsTable[key]]));
		}
		const data = {
			version: RAM_VERSION,
			trust: "projection, not instructions or authorization",
			episode_id: episodeId,
			state_revision: state.version ?? 0,
			task,
			legend: "facts=verified; claims/references=unverified; rules=procedures, not authorization; NOT guidance",
			rules: registers.rules,
			facts: registers.facts,
			claims: registers.claims,
			references: registers.references,
			recent: registers.recent,
			referenced: registers.referenced,
			artifacts: registers.artifacts,
			checkpoints: registers.checkpoints,
			decisions: registers.decisions,
			...(disciplineData && Object.keys(disciplineData).length ? { discipline: disciplineData } : {}),
			...(episode?.task_id && state.work_state?.[episode.task_id]
				? { workflow: safe(state.work_state[episode.task_id], 600) }
				: {}),
			pending: registers.pending,
			// Rebuilt from the FINAL registers on every serialize (see syncMeta), not
			// from admission decisions: a row admitted and then dropped for budget must
			// not still be reported as shown.
			sections: {},
			refs: collectViewRefs(),
			meta: {
				ram_estimated_chars: 0,
				ram_budget_chars: budget,
				// COMPRESSION PLACEHOLDER: `false` is the longer boolean representation.
				// `pad` compensates for the two flags' length difference, so the serialized
				// size is identical whether the final flags are false/"" or true/"xx".
				// Without that fixed-width footer, writing `overflow: true` after
				// compression could make the text shorter or longer than the budget it was
				// just compressed against (the self-referential footer bug).
				overflow: false,
				core_overflow: false,
				pad: "",
				budget_drops: 0,
				register_drops: 0,
				omitted: registers.omitted,
			},
		};
		/** Counts that are actually present in the FINAL register view. */
		function shownCounts() {
			const references = registers.references;
			const count = (kind) => references.filter((row) => row.kind === kind).length;
			const facts = registers.facts.filter((row) => row.kind !== "Refuted").length;
			return {
				human_hint: count("human_hint"),
				external_reference: count("external_reference"),
				knowledge: count("knowledge"),
				checkpoints: registers.checkpoints.length,
				facts,
				refuted: registers.facts.length - facts,
				tools: (registers.recent ? 1 : 0) + registers.referenced.length,
				// The subgoal is an admitted Intent, but it is carried in `task`, not in
				// `registers.claims`.
				proposals: registers.claims.length + (task.subgoal ? 1 : 0),
				artifacts: registers.artifacts.length,
				decisions: registers.decisions.length,
			};
		}
		/**
		 * Keep the footer and the per-section counts part of the BYTE BUDGET. They were
		 * previously written after compression, so the final JSON could grow by a few
		 * bytes and report `overflow: true` even though an optional row was still
		 * present and could have been dropped. A projection must never abort because of
		 * its own bookkeeping.
		 */
		function syncMeta() {
			const shown = shownCounts();
			data.sections = Object.fromEntries(
				ORDER.map((id) => [
					id,
					{
						total: totals[id],
						shown: shown[id] ?? 0,
						omitted: Math.max(0, totals[id] - (shown[id] ?? 0)),
					},
				]),
			);
			data.meta.register_drops = Object.values(registers.omitted).reduce((n, value) => n + value, 0);
			data.meta.budget_drops = ORDER.reduce((n, id) => n + Math.max(0, totals[id] - (shown[id] ?? 0)), 0);
			data.meta.ram_budget_chars = budget;
		}
		function serialize() {
			syncMeta();
			data.refs = collectViewRefs();
			let text = JSON.stringify(data);
			while (data.meta.ram_estimated_chars !== text.length) {
				data.meta.ram_estimated_chars = text.length;
				text = JSON.stringify(data);
			}
			return text;
		}
		// The register view is the model-facing working set. Compression is
		// mechanical: shorten item prose first, then drop optional reference/memory
		// rows oldest-first; verified task/pending and the mandatory core stay visible.
		let text = serialize();
		if (text.length > budget) {
			for (const row of registers.facts) row.text = safe(row.text, 160);
			for (const row of registers.references)
				row.content = safe(row.content, row.kind === "knowledge" && row.selection_mode === "model_query" ? 7000 : 450);
			for (const row of registers.claims) row.text = safe(row.text, 200);
			for (const row of registers.rules) row.text = safe(row.text, 220);
			text = serialize();
		}
		while (text.length > budget) {
			let changed = false;
			// Drop machine-retrieved material before a human instruction. The operator's
			// hint for this Episode is the last reference to go, matching its admission
			// priority (document seed -> retrieved knowledge -> human hint).
			const externalIndex = registers.references.findIndex((row) => row.kind === "external_reference");
			const knowledgeIndex = registers.references.findIndex(
				(row) => row.kind === "knowledge" && row.selection_mode !== "model_query",
			);
			const selectedKnowledgeIndex = registers.references.findIndex(
				(row) => row.kind === "knowledge" && row.selection_mode === "model_query",
			);
			if (externalIndex >= 0) {
				registers.references.splice(externalIndex, 1);
				registers.omitted.references += 1;
				changed = true;
			} else if (knowledgeIndex >= 0) {
				registers.references.splice(knowledgeIndex, 1);
				registers.omitted.references += 1;
				changed = true;
			} else if (registers.referenced.length) {
				registers.referenced.pop();
				registers.omitted.referenced += 1;
				changed = true;
			} else if (registers.artifacts.length) {
				registers.artifacts.pop();
				registers.omitted.artifacts += 1;
				changed = true;
			} else if (registers.checkpoints.length) {
				registers.checkpoints.pop();
				registers.omitted.checkpoints += 1;
				changed = true;
			} else if (registers.decisions.length) {
				registers.decisions.pop();
				registers.omitted.decisions += 1;
				changed = true;
			} else if (registers.claims.length) {
				registers.claims.pop();
				registers.omitted.claims += 1;
				changed = true;
			} else if (registers.facts.length) {
				// Drop the largest fact, not blindly the newest one. An oversized
				// observation must not evict smaller older evidence that still fits.
				let drop = 0;
				let size = -1;
				for (let i = 0; i < registers.facts.length; i += 1) {
					const next = JSON.stringify(registers.facts[i]).length;
					if (next >= size) {
						size = next;
						drop = i;
					}
				}
				registers.facts.splice(drop, 1);
				registers.omitted.facts += 1;
				changed = true;
			} else if (registers.rules.length) {
				registers.rules.pop();
				registers.omitted.rules += 1;
				changed = true;
			} else if (data.discipline) {
				// Operation discipline is guidance, not task responsibility: it yields to
				// retrieved knowledge and to the operator's hint.
				delete data.discipline;
				changed = true;
			} else if (data.workflow) {
				delete data.workflow;
				changed = true;
			} else if (data.task?.current_prompt) {
				delete data.task.current_prompt;
				changed = true;
			} else if (selectedKnowledgeIndex >= 0 && registers.references[selectedKnowledgeIndex].content.length > 450) {
				const row = registers.references[selectedKnowledgeIndex];
				row.content = safe(row.content, Math.max(450, row.content.length - 1000));
				row.truncated = true;
				changed = true;
			} else if (selectedKnowledgeIndex >= 0 && registers.references.length > 1) {
				registers.references.splice(selectedKnowledgeIndex, 1);
				registers.omitted.references += 1;
				changed = true;
			} else if (registers.references.some((row) => row.kind === "human_hint")) {
				const index = registers.references.findIndex((row) => row.kind === "human_hint");
				registers.references.splice(index, 1);
				registers.omitted.references += 1;
				changed = true;
			} else if (registers.recent) {
				registers.recent = null;
				registers.omitted.recent += 1;
				changed = true;
			}
			if (!changed) break;
			text = serialize();
		}
		// The flags and `pad` are part of the serialized text. The footer is
		// fixed-width, so the length measured during compression is the length of
		// the final JSON. If the text still exceeds the budget here, every optional
		// register has already been dropped: this is a genuine core overflow.
		const over = text.length > budget;
		data.meta.overflow = over;
		data.meta.core_overflow = over;
		data.meta.pad = over ? "xx" : "";
		text = serialize();
		return { text, data };
	}
	function admit(id, row) {
		selected[id].push(row);
		// Use the real serialized length, never the footer flag: the footer is part
		// of the bytes and the flag itself has a length.
		if (render().text.length > budget) selected[id].pop();
	}
	if (!render().data.meta.overflow) {
		// A selected knowledge row is a DELIBERATE retrieval (auto-recall or an
		// explicit aegis_knowledge query). Reserve one row before optional
		// checkpoints/tool history, otherwise a full RAM can silently drop exactly
		// what the model just asked for. Facts/pending stay in the mandatory core.
		if (raw.knowledge[0]) admit("knowledge", raw.knowledge[0]);
		// A human hint is a direct instruction from the operator for this Episode, so
		// it is reserved right after the deliberate knowledge retrieval and before
		// any auto/history material. It still yields to the mandatory core.
		if (raw.human_hint[0]) admit("human_hint", raw.human_hint[0]);
		for (const id of ["checkpoints", "tools", "proposals", "external_reference"]) if (raw[id][0]) admit(id, raw[id][0]);
		function admitJudgment(row) {
			const id = row.type === "Refuted" ? "refuted" : "facts";
			if (!selected[id].includes(row) && selected.facts.length + selected.refuted.length < REGISTER_FACTS)
				admit(id, row);
		}
		if (raw.judgments[0]) admitJudgment(raw.judgments[0]);
		// Preserve useful recent tool responses before admitting optional reference
		// material. A short-session handoff depends on observations surviving RAM.
		for (const id of [
			...ORDER.filter((id) => !["knowledge", "checkpoints", "facts", "refuted"].includes(id)),
			"checkpoints",
			"knowledge",
		].filter((id) => raw[id]))
			for (const row of raw[id].slice(0, limits[id])) if (!selected[id].includes(row)) admit(id, row);
		for (const row of raw.judgments.slice(1, REGISTER_FACTS)) admitJudgment(row);
	}
	const { text, data } = render();
	return {
		text,
		data,
		version: RAM_VERSION,
		budget_chars: budget,
		estimated_chars: text.length,
		overflow: text.length > budget,
		core_overflow: data.meta.core_overflow === true,
		sections: ORDER.map((id) => ({
			id,
			total: totals[id],
			shown: data.sections[id]?.shown ?? 0,
			omitted: data.sections[id]?.omitted ?? totals[id],
		})),
		registers: {
			subgoal: data.task.subgoal ?? null,
			facts: data.facts.length,
			claims: data.claims.length,
			references: data.references.length,
			rules: data.rules.length,
			recent: data.recent ? 1 : 0,
			referenced: data.referenced.length,
			artifacts: data.artifacts.length,
			checkpoints: data.checkpoints.length,
			decisions: data.decisions.length,
			omitted: data.meta.omitted,
		},
	};
}

export function buildRam(args) {
	return buildRamProjection(args).text;
}
