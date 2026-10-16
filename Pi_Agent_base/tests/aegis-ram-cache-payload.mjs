// Real Pi SDK + OpenAI serialization, with every HTTP request intercepted.
// No credentials, real provider, target, or fabricated cache-hit measurements.
// Optional archived Observer: AEGIS_RAM_TEST_OBSERVER=/absolute/path/to/observer.ts
// Run using the embedded Pi source resolver.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { projectState } from "../memory/state.mjs";
import { digest, verifyChain } from "../shared/events.mjs";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "aegis-ram-cache-payload-"));
const env = {
	AEGIS_EVENT_LOG: join(root, "events.jsonl"),
	AEGIS_RAM_DIR: join(root, "ram"),
	AEGIS_PROJECTION_DIR: join(root, "projections"),
	AEGIS_HANDOFF_FILE: join(root, "ram", "handoff.json"),
	AEGIS_EXPERIENCE_DIR: join(root, "experiences"),
	AEGIS_ROM_FILE: join(root, "ROM.md"),
	AEGIS_TASK_ID: "ram-cache-offline",
	AEGIS_MANIFEST_FILE: "",
	AEGIS_SCRIPT_CONFIG: "",
	AEGIS_REPLAY_ADAPTER: "",
};
const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
Object.assign(process.env, env);
const originalFetch = globalThis.fetch;
const requests = [];
let session;
const legacy = Boolean(process.env.AEGIS_RAM_TEST_OBSERVER);
const observer = process.env.AEGIS_RAM_TEST_OBSERVER ?? join(base, "extensions", "aegis-observer.ts");
const text = (message) =>
	typeof message.content === "string"
		? message.content
		: (message.content ?? []).map((part) => part.text ?? "").join("\n");
const system = (body) => body.messages.filter((message) => ["system", "developer"].includes(message.role));
function commonPrefix(a, b) {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return i;
}
try {
	const cwd = join(root, "workspace"),
		agentDir = join(root, "agent"),
		sessionDir = join(root, "sessions");
	for (const dir of [cwd, agentDir, sessionDir]) mkdirSync(dir);
	writeFileSync(env.AEGIS_ROM_FILE, readFileSync(join(base, "agent", "ROM.md"), "utf8"));
	writeFileSync(join(cwd, "probe.txt"), "OBSERVED_DATA_NOT_A_VERDICT_94821\n");
	const model = {
		id: "ram-cache-offline",
		name: "RAM cache offline serialization",
		api: "openai-completions",
		provider: "aegis-ram-offline",
		baseUrl: "https://ram-cache.invalid/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "offline-only" }));
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: join(root, "models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		apiKey: "offline-only",
		models: [model],
	});
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.url, "https://ram-cache.invalid/v1/chat/completions");
		const body = await request.json();
		requests.push(body);
		const n = requests.length;
		const call = n <= 8;
		const delta = call
			? {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: `offline_${n}`,
							type: "function",
							function: { name: "read", arguments: JSON.stringify({ path: "probe.txt" }) },
						},
					],
				}
			: { role: "assistant", content: "Observed only, awaiting independent verification." };
		const chunks = [
			{ choices: [{ index: 0, delta, finish_reason: null }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] },
		];
		return new Response(
			chunks
				.map(
					(chunk) =>
						`data: ${JSON.stringify({ id: `offline-${n}`, object: "chat.completion.chunk", model: model.id, ...chunk })}\n\n`,
				)
				.join("") + "data: [DONE]\n\n",
			{ headers: { "content-type": "text/event-stream" } },
		);
	};
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [observer],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const manager = SessionManager.create(cwd, sessionDir);
	({ session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		resourceLoader: loader,
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory({}),
		tools: ["read"],
	}));
	await session.bindExtensions({});
	await session.prompt("Read probe.txt eight times, then report observations only.");
	assert.equal(requests.length, 9);
	await session.prompt("Keep the original task goal and report no new verdict.");
	assert.equal(requests.length, 10, "RAM must not cause additional provider turns");
	const events = readFileSync(env.AEGIS_EVENT_LOG, "utf8").trim().split("\n").map(JSON.parse);
	const projected = events.filter((event) => event.event_type === "request.projected");
	assert.equal(verifyChain(events).ok, true);
	assert.equal(projected.length, requests.length);
	assert.equal(
		projectState(events).version,
		projectState(events.filter((event) => event.event_type !== "request.projected")).version,
	);
	assert.equal(events.filter((event) => event.event_type === "episode.started").length, 1);
	const serialized = requests.map((body) => JSON.stringify({ tools: body.tools, messages: body.messages }));
	const prefixes = serialized.slice(1).map((body, i) => commonPrefix(serialized[i], body));
	for (let i = 0; i < requests.length; i++) {
		assert.deepEqual(requests[i].tools, requests[0].tools, "tool schema remains stable");
		if (legacy) continue;
		assert.deepEqual(
			system(requests[i]),
			system(requests[0]),
			"all serialized system/developer messages stay byte-stable",
		);
		assert.ok(!JSON.stringify(system(requests[i])).includes("<aegis_ram>"));
		const ram = requests[i].messages.filter(
			(message) => message.role === "user" && text(message).startsWith("<aegis_ram>\n"),
		);
		assert.equal(ram.length, 1);
		assert.equal(requests[i].messages.at(-1), ram[0], "RAM is at the request tail, after complete tool results");
		const inner = text(ram[0])
			.replace(/^<aegis_ram>\n/, "")
			.replace(/\n<\/aegis_ram>$/, "");
		assert.equal(digest(inner), projected[i].payload.ram_digest);
		assert.equal(inner.length, projected[i].payload.ram_estimated_chars);
		assert.equal(projected[i].payload.ram_version, "2.0");
		assert.equal(projected[i].payload.ram_overflow, false);
		assert.equal(Number(inner.match(/ram_estimated_chars: (\d+)/)[1]), inner.length);
		assert.ok(inner.length <= projected[i].payload.ram_budget_chars);
		for (const section of projected[i].payload.ram_sections)
			assert.equal(section.shown + section.omitted, section.total);
		assert.ok(inner.length < 5000, "ordinary RAM remains bounded");
		assert.equal(projected[i].payload.ram_transport, "ephemeral-user-tail-v1");
		if (i > 0) {
			assert.ok(
				requests[i].messages.some(
					(message) => message.role === "tool" && text(message).includes("OBSERVED_DATA_NOT_A_VERDICT_94821"),
				),
			);
			const previousBody = requests[i - 1];
			assert.deepEqual(
				requests[i].messages.slice(0, previousBody.messages.length - 1),
				previousBody.messages.slice(0, -1),
				"previous non-RAM transcript remains a reusable prefix",
			);
		}
	}
	if (legacy)
		assert.notDeepEqual(system(requests[0]), system(requests[1]), "archive reproduces system-RAM invalidation");
	else {
		assert.notEqual(
			projected[0].payload.ram_digest,
			projected[1].payload.ram_digest,
			"RAM still refreshes after a real tool",
		);
		assert.ok(prefixes[7] > prefixes[0] + 1000, "cacheable history grows despite changing RAM");
		assert.ok(!JSON.stringify(session.messages).includes("aegis_ram_context"), "request RAM is not session state");
		const sessionText = readFileSync(manager.getSessionFile(), "utf8");
		assert.ok(
			!sessionText.includes("aegis_ram_context") && !sessionText.includes("<aegis_ram>"),
			"ephemeral RAM is not persisted",
		);
	}
	console.log(
		JSON.stringify(
			{
				mode: legacy ? "archive-system-ram" : "ephemeral-user-tail-v1",
				requests: requests.length,
				serialized_common_prefix_chars: prefixes,
				serialized_request_chars: serialized.map((s) => s.length),
				actual_cache_hit_rate: null,
				actual_provider_latency_ms: null,
				offline_only: true,
			},
			null,
			2,
		),
	);
} finally {
	session?.dispose();
	globalThis.fetch = originalFetch;
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
}
