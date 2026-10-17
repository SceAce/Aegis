// SDK-shaped synchronous feedback, with Host-owned identity and authority.
import { requestDigest } from "./adapters/web-http-adapter.mjs";
export const WEB_HTTP_TOOL_NAME = "aegis_http_request";
export function describeWebHttpTool() {
	return {
		name: WEB_HTTP_TOOL_NAME,
		effects_network: true,
		description:
			"Send one authorized HTTP request and inspect its bounded response. Transport reception does not decide the task outcome.",
		parameters: {
			type: "object",
			required: ["target_id", "method", "path_query", "headers"],
			properties: {
				target_id: { type: "string" },
				method: { type: "string" },
				path_query: { type: "string" },
				headers: { type: "array", items: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 } },
				body: {
					anyOf: [
						{ type: "null" },
						{
							type: "object",
							properties: { encoding: { enum: ["utf8", "base64"] }, data: { type: "string" } },
							required: ["encoding", "data"],
							additionalProperties: false,
						},
					],
				},
				session_id: { type: ["string", "null"] },
			},
			additionalProperties: false,
		},
	};
}
export function assessToolEffect({ name }) {
	return [WEB_HTTP_TOOL_NAME, "aegis_response_read"].includes(name)
		? { ok: true, effects_network: name === WEB_HTTP_TOOL_NAME }
		: { ok: false };
}
export function createSynchronousWebTool({ adapter, identityFor, callbacksFor = () => ({}) }) {
	return {
		...describeWebHttpTool(),
		async handler({ args, context, signal }) {
			const identity = identityFor(context);
			if (
				!identity ||
				["campaign_id", "task_id", "episode_id", "request_id", "tool_call_id", "unit_id"].some(
					(key) => typeof identity[key] !== "string" || !identity[key],
				)
			)
				return { is_error: true, content: [{ type: "text", text: "Aegis refused incomplete execution context" }] };
			const result = await adapter.execute({
				request: args,
				identity: { ...identity, arguments_digest: requestDigest(args) },
				callbacks: callbacksFor(context),
				signal,
			});
			const details = { ...result, body_base64: undefined, body_preview: result.body_preview?.slice(0, 1200) };
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							transport_status: result.transport_status,
							status_code: result.status_code,
							error_code: result.error_code,
							body_ref: result.body_ref,
							body_preview: result.body_preview?.slice(0, 1200),
						}),
					},
				],
				details,
				is_error: result.transport_status === "rejected",
			};
		},
	};
}
