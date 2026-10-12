// Aegis C3-A — Campaign-mode action gate.
//
// In Campaign mode, EVERY model-requested side effect must go through the
// registered Action Broker (CAMPAIGN_ARCHITECTURE §3.5). Hiding tools from the
// model's tool list is NOT sufficient admission control: this gate is the
// second, explicit boundary that a direct Pi tool call is measured against.
//
// Honest boundaries:
//   * the gate only applies while a Campaign Host is ACTIVE in this process
//     (`active === true`). Ordinary Pi usage is never changed by this module.
//   * the gate decides ALLOW / DENY of a *transport*, it is NOT verification:
//     an allowed brokered call still has its effect judged by the Oracle.
//   * only the brokered action tools and an explicit human allow-list may pass.
//     `bash`/`write`/`edit`/`read` and every other direct tool are denied by
//     default inside Campaign mode.

/**
 * Tools that are the Broker's own entry points in Campaign mode. These are the
 * registered-contract surfaces (`aegis_workspace`, `aegis_script`); a call to
 * them still passes the Broker's argument/authorization/recognition gate.
 */
export const BROKERED_TOOLS = Object.freeze(["aegis_workspace", "aegis_script"]);

/**
 * Direct Pi tools that must never be a Campaign side-effect path. This list is
 * advisory/documentation: the default is DENY for anything not brokered or
 * explicitly allow-listed, so an unknown/new tool is refused rather than
 * silently permitted.
 */
export const DIRECT_TOOLS_DENIED = Object.freeze([
	"bash",
	"write",
	"edit",
	"read",
	"glob",
	"grep",
	"ls",
	"powershell",
	"computer",
]);

/**
 * @param {{allowDirectTools?: string[], brokeredTools?: string[]}} [args]
 * @returns {{active: boolean, activate: () => void, deactivate: () => void,
 *   guardToolCall: (input: {tool_name?: string, action_ref?: string| null}) =>
 *   {allowed: boolean, reason: string, mode: "campaign"|"standard", action_ref: string|null},
 *   isActive: () => boolean}}
 */
export function createCampaignActionGate(
	{
		allowDirectTools = [],
		brokeredTools = /** @type {string[]} */ ([...BROKERED_TOOLS]),
	} = /** @type {{allowDirectTools?: string[], brokeredTools?: string[]}} */ ({}),
) {
	const brokered = new Set(brokeredTools);
	const allowDirect = new Set(allowDirectTools);
	let active = false;

	/**
	 * Decide whether a candidate tool call may proceed.
	 *
	 * Return shape is explicit and NEVER a bare boolean: the caller must record
	 * the reason. When the gate is inactive the decision is `standard` and always
	 * allowed (ordinary Pi behaviour is unchanged).
	 *
	 * @param {{tool_name?: string|null, action_ref?: string|null}} [input]
	 * @returns {{allowed: boolean, reason: string, mode: "campaign"|"standard", action_ref: string|null}}
	 */
	function guardToolCall({ tool_name = null, action_ref = null } = {}) {
		if (!active) {
			return {
				allowed: true,
				reason: "campaign mode is not active; standard Pi behaviour applies",
				mode: "standard",
				action_ref,
			};
		}
		if (typeof tool_name !== "string" || tool_name.length === 0) {
			return { allowed: false, reason: "campaign mode: a tool call must name its tool", mode: "campaign", action_ref };
		}
		if (brokered.has(tool_name)) {
			return {
				allowed: true,
				reason: "campaign mode: brokered action tool (still subject to the Broker gate)",
				mode: "campaign",
				action_ref,
			};
		}
		if (allowDirect.has(tool_name)) {
			return {
				allowed: true,
				reason: "campaign mode: explicitly allow-listed read-only tool",
				mode: "campaign",
				action_ref,
			};
		}
		return {
			allowed: false,
			reason: `campaign mode: direct tool "${tool_name}" cannot bypass the Broker; use a registered action_ref`,
			mode: "campaign",
			action_ref,
		};
	}

	return {
		get active() {
			return active;
		},
		isActive: () => active,
		activate: () => {
			active = true;
		},
		deactivate: () => {
			active = false;
		},
		guardToolCall,
	};
}
