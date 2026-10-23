// Aegis Web Console — selectable coding tools.
//
// The Aegis Observer tools are NOT optional: the work-unit gate, review and the
// receipt/audit trail depend on them, so they are always active. What an operator
// may choose per experiment is the ordinary coding toolset the model can call
// (bash/write are the effect-capable ones).
//
// This list is the only allowlist: the server validates a request against it, the
// launcher records the choice, and the Console entry passes exactly these to the
// SDK. An unknown name is refused rather than silently dropped.

export const AEGIS_TOOLS = Object.freeze([
	"aegis_propose",
	"aegis_knowledge",
	"aegis_work_review",
	"aegis_work_checkpoint",
	"aegis_submit_candidate",
	"aegis_switch_session",
	"aegis_tools",
	"aegis_toolbox",
	"aegis_tool_note",
	"aegis_read",
	"aegis_observe",
	"aegis_execute",
	"aegis_artifact_read",
	"aegis_web_search",
	"aegis_remote_request",
	"aegis_run",
]);

/** Coding tools an operator may enable or disable (id + i18n key for its label). */
export const CODING_TOOLS = Object.freeze([
	{ id: "read", label_key: "tool.read", effect: false },
	{ id: "ls", label_key: "tool.ls", effect: false },
	{ id: "grep", label_key: "tool.grep", effect: false },
	{ id: "find", label_key: "tool.find", effect: false },
	{ id: "glob", label_key: "tool.glob", effect: false },
	{ id: "bash", label_key: "tool.bash", effect: true },
	{ id: "write", label_key: "tool.write", effect: true },
	{ id: "edit", label_key: "tool.edit", effect: true },
]);

export const DEFAULT_CODING_TOOLS = Object.freeze(["read", "bash", "edit", "write"]);

const CODING_IDS = new Set(CODING_TOOLS.map((tool) => tool.id));

/**
 * Resolve a requested coding-tool selection into the final SDK tool list.
 *
 * @param {string[]|null|undefined} requested
 * @returns {{ok: boolean, coding: string[], tools: string[], error?: string}}
 */
export function resolveToolSelection(requested) {
	const list = Array.isArray(requested)
		? requested.map((value) => String(value).trim()).filter(Boolean)
		: requested === null || requested === undefined
			? [...DEFAULT_CODING_TOOLS]
			: String(requested)
					.split(",")
					.map((value) => value.trim())
					.filter(Boolean);
	const unknown = list.filter((id) => !CODING_IDS.has(id));
	if (unknown.length > 0) return { ok: false, coding: [], tools: [], error: `unknown tool(s): ${unknown.join(", ")}` };
	const coding = [...new Set(list)];
	return { ok: true, coding, tools: [...coding, ...AEGIS_TOOLS] };
}
