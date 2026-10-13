// Aegis C6-A — automatic Pi SDK runtime for one Campaign run.
//
// The USER runs one Aegis command with a trusted config; this module creates the
// real Pi SDK runtime for them. The caller no longer hand-assembles a
// ResourceLoader, binds a runtime, or supplies a `beforeRun` callback.
//
// It is the ONLY place the product entry creates SDK objects, so the frozen
// ownership rules hold in one place:
//
//   * `ModelRuntime` is created with an EXPLICIT, isolated credential store and
//     an explicit models store; it NEVER reads the user's default auth/models.
//   * `DefaultResourceLoader` is built from an explicit ALLOWLIST: only the
//     Aegis Observer extension and the Campaign gate inline factory are loaded.
//     Skills/prompts/themes/context files and any user extension are OFF.
//   * The SAME `gate` object is injected into EVERY session's resource loader
//     (initial AND rotated) so a direct tool can never bypass the Broker.
//   * `AgentSessionRuntime` owns session replacement; we rebind subscriptions and
//     extension bindings to `runtime.session` after each `newSession()`.
//
// Honest boundary: the workspace is NOT an OS sandbox, and this module never
// contacts a real provider unless the trusted config explicitly selects one. The
// development default is the offline `faux` provider.

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{
 *   kind: string,
 *   model: string,
 *   base_url?: string|null,
 *   credential_ref?: string|null,
 * }} ProviderConfig
 */

/**
 * @typedef {{
 *   kind: "faux",
 *   model: { id: string, name: string, details: object },
 *   providerId: string,
 *   baseUrl: string,
 * }} ResolvedProvider
 */

export const SDK_RUNTIME_VERSION = "1.0.0";

/**
 * The allowlisted resource policy. A caller (test or future host) may inject a
 * `createRuntime` seam; the default seam below is the real SDK.
 *
 * @typedef {{
 *   version: string,
 *   runtime: any,
 *   model: any,
 *   modelRuntime: any,
 *   rebind: (session: any) => Promise<void>,
 *   creations: () => number,
 *   dispose: () => Promise<void>,
 *   session: () => any,
 *   providerId: string,
 * }} SdkRuntimeHandle
 */

const AEGIS_OBSERVER_PATH = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"extensions",
	"aegis-observer.ts",
);

/**
 * Build the isolated ModelRuntime + model for the configured provider.
 *
 * @param {{provider: ProviderConfig, workDir: string, createSeam?: Function|null, sdk: any}} args
 * @returns {Promise<{ok: boolean, modelRuntime?: any, model?: any, credentials?: any, providerId?: string, diagnostics: string[]}>}
 */
export async function buildModelRuntime({ provider, workDir, sdk }) {
	const diagnostics = [];
	if (!provider || typeof provider !== "object") {
		return { ok: false, diagnostics: ["provider config is required"] };
	}
	if (provider.kind !== "faux") {
		// Local/real providers are configured here ONLY by passing the explicit
		// model details into the SDK model runtime. C6 does not implement any real
		// provider call; an unregistered kind is refused rather than silently
		// falling back to faux.
		return {
			ok: false,
			diagnostics: [`provider.kind "${String(provider.kind)}" is not a registered C6 provider`],
		};
	}
	const authDir = join(workDir, "sdk");
	mkdirSync(authDir, { recursive: true });
	// Isolated, in-memory credentials: the user's auth.json is never opened.
	const credentials = sdk.AuthStorage.inMemory();
	const modelRuntime = await sdk.ModelRuntime.create({
		credentials,
		modelsPath: join(authDir, "models.json"),
		allowModelNetwork: false,
	});
	return { ok: true, modelRuntime, credentials, diagnostics };
}

/**
 * Create the automatic SDK runtime for a Campaign run.
 *
 * @param {{
 *   provider: ProviderConfig,
 *   model: any,
 *   modelRuntime: any,
 *   gate: {extensionFactory: Function},
 *   cwd: string,
 *   agentDir: string,
 *   sessionDir: string,
 *   tools?: string[],
 *   sdk: any,
 *   extraExtensionPaths?: string[],
 *   decisionCapture?: any,
 *   extraTools?: any[],
 * }} args
 * @returns {Promise<SdkRuntimeHandle>}
 */
export async function createCampaignSdkRuntime({
	provider,
	model,
	modelRuntime,
	gate,
	cwd,
	agentDir,
	sessionDir,
	tools = ["aegis_propose", "aegis_switch_session"],
	sdk,
	extraExtensionPaths = [],
	decisionCapture = null,
	extraTools = [],
}) {
	if (!gate || typeof gate.extensionFactory !== "function") {
		throw new Error("createCampaignSdkRuntime requires a Campaign gate with extensionFactory");
	}
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	let creations = 0;
	let unsubscribe = null;

	const runtime = await sdk.createAgentSessionRuntime(
		async ({ cwd: sessionCwd, agentDir: sessionAgentDir, sessionManager, sessionStartEvent }) => {
			creations += 1;
			const services = await sdk.createAgentSessionServices({
				cwd: sessionCwd,
				agentDir: sessionAgentDir,
				modelRuntime,
				settingsManager: sdk.SettingsManager.inMemory({
					// No compaction/retry that would hide a stop; the Host owns bounds.
					compaction: { enabled: false },
					retry: { enabled: false },
				}),
				resourceLoaderOptions: {
					// EXPLICIT allowlist: no user extensions/skills/prompts/themes/
					// context files. Only the Aegis Observer and the shared gate load.
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					additionalExtensionPaths: [AEGIS_OBSERVER_PATH, ...extraExtensionPaths],
					// The SAME gate is loaded for the initial AND every rotated session.
					extensionFactories: [gate.extensionFactory],
				},
			});
			const customTools = [...(decisionCapture ? [decisionCapture.tool] : []), ...extraTools];
			const toolNames = [...tools, ...customTools.map((tool) => tool.name)];
			const created = await sdk.createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model,
				tools: toolNames,
				...(customTools.length ? { customTools } : {}),
			});
			return { ...created, services, diagnostics: services.diagnostics };
		},
		{ cwd, agentDir, sessionManager: sdk.SessionManager.create(cwd, sessionDir) },
	);

	async function rebind(session) {
		if (unsubscribe) {
			try {
				unsubscribe();
			} catch {
				// ignore: the old session may already be disposed
			}
			unsubscribe = null;
		}
		await session.bindExtensions({
			mode: "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => runtime.newSession(options),
				fork: async () => ({ cancelled: true }),
				navigateTree: async () => ({ cancelled: true }),
				switchSession: async () => ({ cancelled: true }),
				reload: () => session.reload(),
			},
		});
	}
	runtime.setRebindSession(rebind);
	await rebind(runtime.session);

	return {
		version: SDK_RUNTIME_VERSION,
		runtime,
		model,
		modelRuntime,
		providerId: provider.kind,
		rebind,
		creations: () => creations,
		session: () => runtime.session,
		dispose: async () => {
			if (unsubscribe) {
				try {
					unsubscribe();
				} catch {
					// ignore
				}
				unsubscribe = null;
			}
			await runtime.dispose();
		},
	};
}

export { AEGIS_OBSERVER_PATH };
