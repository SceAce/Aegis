// Offline real SDK + intercepted OpenAI transport; never calls max or reads real auth.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage, ReadOnlyAuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { runC6FromConfig } from "../campaign/c6-entry.mjs";
import { inspectMaxPilot, prepareMaxPilot } from "../campaign/e1-max-pilot.mjs";
import { resolveProviderConfig } from "../campaign/provider-config.mjs";
import { buildDataRepairManifest } from "../execution/adapters/structured-data-adapter.mjs";

const selection = {
	kind: "remote-openai",
	model: "deepseek-v4.1-flash",
	base_url: "https://relay.example/v1",
	credential_ref: "env:AEGIS_E1_TEST_KEY",
};
assert.equal(resolveProviderConfig(selection).ok, true, "explicit remote compatible provider must resolve");
for (const base_url of [
	"http://relay.example/v1",
	"https://user:pass@relay.example/v1",
	"https://relay.example/v1?key=x",
])
	assert.equal(resolveProviderConfig({ ...selection, base_url }).ok, false);
assert.equal(resolveProviderConfig({ ...selection, credential_ref: null }).ok, false);
assert.equal(resolveProviderConfig({ ...selection, credential_ref: 42 }).ok, false);
assert.equal(resolveProviderConfig({ ...selection, credential_ref: "file:/tmp/key" }).ok, false);
assert.equal(resolveProviderConfig({ ...selection, kind: "local-openai" }).ok, false);
const piSelection = {
	kind: "pi-config",
	provider_id: "relay",
	model: selection.model,
	agent_dir: join(tmpdir(), "pi-e1-config"),
	max_output_tokens: 4096,
};
assert.equal(resolveProviderConfig(piSelection).ok, true, "explicit Pi configuration must resolve");
for (const override of [
	{ provider_id: "" },
	{ agent_dir: "relative/path" },
	{ agent_dir: 42 },
	{ max_output_tokens: 0 },
	{ max_output_tokens: 1.5 },
	{ credential_ref: "env:OTHER_KEY" },
	{ base_url: "https://another.example/v1" },
])
	assert.equal(resolveProviderConfig({ ...piSelection, ...override }).ok, false);

const root = mkdtempSync(join(tmpdir(), "aegis-e1-remote-"));
const originalFetch = globalThis.fetch;
const oldKey = process.env.AEGIS_E1_TEST_KEY;
const oldMaxKey = process.env.AEGIS_MAX_API_KEY;
const sdk = { ...sdkBase, AuthStorage, ReadOnlyAuthStorage };
try {
	const piDir = join(root, "pi-agent");
	mkdirSync(piDir);
	const piModels = {
		providers: {
			relay: {
				api: "openai-completions",
				baseUrl: selection.base_url,
				compat: { maxTokensField: "max_completion_tokens", supportsStore: true },
				models: [{ id: selection.model, contextWindow: 128000, maxTokens: 16384, headers: { "x-pi-fixture": "yes" } }],
			},
		},
	};
	writeFileSync(join(piDir, "models.json"), JSON.stringify(piModels));
	writeFileSync(
		join(piDir, "settings.json"),
		JSON.stringify({ defaultProvider: "relay", defaultModel: selection.model }),
	);
	writeFileSync(join(piDir, "auth.json"), JSON.stringify({ relay: { type: "api_key", key: "offline-test-key" } }));
	writeFileSync(join(piDir, "models-store.json"), "{}");
	const piBefore = ["models.json", "settings.json", "auth.json", "models-store.json"].map((name) =>
		readFileSync(join(piDir, name), "utf8"),
	);
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	writeFileSync(join(workspace, "dataset.json"), '{"name":"??"}\n');
	const manifest = buildDataRepairManifest({ workspaceRoot: workspace });
	manifest.tasks = [manifest.tasks[0]];
	manifest.budget = { wall_time_ms: 180000, model_requests: 4, tool_calls: 8, task_count: 1, session_count: 2 };
	manifest.tasks[0].task_budget = { wall_time_ms: 180000, model_requests: 4, tool_calls: 8 };
	manifest.dynamic_task_policy.enabled = false;
	const manifestPath = join(root, "manifest.json");
	writeFileSync(manifestPath, JSON.stringify(manifest));
	const configPath = join(root, "config.json");
	const config = {
		schema_version: "campaign-config-1.1",
		manifest_path: manifestPath,
		workspace_root: workspace,
		work_dir: join(root, "run"),
		mode: "auto",
		provider: selection,
		task_family: "structured-data-repair",
		context: { strategy: "bounded_ram", max_total_input_chars: 50000, output_reserve_chars: 4000 },
		learning: { policy: "off", promote_experience: false },
		session: { session_count: 2, max_requests_per_session: 10 },
		observation: { enabled: false, port: 0 },
		oracle: { kind: "fixture" },
	};
	writeFileSync(configPath, JSON.stringify(config));
	const requests = [];
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.ok(
			["https://relay.example/v1/chat/completions", "https://ai.max66.xyz/v1/chat/completions"].includes(request.url),
		);
		assert.equal(request.headers.get("authorization"), "Bearer offline-test-key");
		const body = await request.json();
		assert.equal(body.model, selection.model);
		if (request.headers.get("x-pi-fixture") === "yes") {
			assert.equal(body.max_completion_tokens, 4096, "reuse Pi compatibility and apply pilot output cap");
			assert.equal(body.max_tokens, undefined);
			assert.equal(body.store, false);
		} else {
			assert.equal(body.max_tokens, 4096);
			assert.equal(body.store, undefined);
		}
		requests.push(body);
		const stage = (requests.length - 1) % 3;
		const codeTask = JSON.stringify(body.messages).includes("normalizeName");
		const target = codeTask ? "solution.mjs" : "dataset.json";
		if (stage === 1) {
			const readResult = body.messages.filter((message) => message.role === "tool").at(-1);
			assert.ok(readResult, "continuation must include the actual read result");
			assert.ok(
				readResult.content.includes(`contents of ${target}:\n`),
				"the active Campaign gate must admit the registered read tool",
			);
			assert.ok(
				readResult.content.includes(codeTask ? "return value.trim();" : '"name":"??"'),
				"the provider must receive actual initial file contents before proposing a patch",
			);
		}
		const call =
			stage === 0
				? { name: "aegis_read", arguments: { path: target } }
				: stage === 1
					? {
							name: "aegis_task_decision",
							arguments: {
								actions: [
									{
										action_ref: codeTask ? "code.file.write" : "data.record.set",
										arguments: codeTask
											? {
													target,
													content:
														'if (process.env.AEGIS_MAX_API_KEY || process.env.AEGIS_E1_TEST_KEY) throw new Error("credential inherited by oracle");\nexport function normalizeName(value) { return typeof value === "string" ? value.trim().replace(/\\s+/g, " ") : null; }\n',
												}
											: { target, field: "name", value: "Ada" },
									},
								],
							},
						}
					: null;
		const delta = call
			? {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: `call_${requests.length}`,
							type: "function",
							function: { name: call.name, arguments: JSON.stringify(call.arguments) },
						},
					],
				}
			: { role: "assistant", content: "Decision submitted." };
		const chunks = [
			{ choices: [{ index: 0, delta, finish_reason: null }] },
			{
				choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
				usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
			},
		];
		return new Response(
			`${chunks.map((chunk) => `data: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", model: selection.model, ...chunk })}\n\n`).join("")}data: [DONE]\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		);
	};
	delete process.env.AEGIS_E1_TEST_KEY;
	const refused = await runC6FromConfig({ configPath, sdk, print: () => {} });
	assert.equal(refused.ok, false);
	assert.equal(refused.stage, "provider");
	assert.equal(requests.length, 0);
	process.env.AEGIS_E1_TEST_KEY = "offline-test-key";
	const result = await runC6FromConfig({ configPath, sdk, print: () => {} });
	assert.equal(result.ok, true, JSON.stringify(result.reasons));
	assert.equal(result.task_states["task-001"], "completed");
	assert.equal(result.chain_ok, true);
	assert.equal(requests.length, 3);
	assert.equal(JSON.parse(readFileSync(join(workspace, "dataset.json"), "utf8")).name, "Ada");
	const restarted = await runC6FromConfig({ configPath, sdk, print: () => {} });
	assert.equal(restarted.task_states["task-001"], "completed");
	assert.equal(requests.length, 3, "completed replay must not call provider again");
	const prepared = prepareMaxPilot(join(root, "prepared"), { agentDir: piDir });
	assert.equal(prepared.provider.kind, "pi-config");
	assert.equal(prepared.provider.provider_id, "relay");
	assert.equal(prepared.provider.model, selection.model);
	assert.equal(prepared.provider.agent_dir, piDir);
	assert.ok(!JSON.stringify(prepared).includes("offline-test-key"));
	assert.equal(requests.length, 3, "preparation never requests a provider");
	assert.throws(() => prepareMaxPilot(prepared.root), /already exists/);
	assert.equal(inspectMaxPilot(prepared.root).task_states["task-001"], "ready");
	const noAuthDir = join(root, "pi-no-auth");
	mkdirSync(noAuthDir);
	for (const name of ["models.json", "settings.json"])
		writeFileSync(join(noAuthDir, name), readFileSync(join(piDir, name)));
	const noAuthInputs = prepareMaxPilot(join(root, "no-auth-inputs"), { agentDir: noAuthDir });
	assert.equal(
		inspectMaxPilot(noAuthInputs.root).task_states["task-001"],
		"ready",
		"prepare/status need no credentials",
	);
	delete process.env.AEGIS_MAX_API_KEY;
	delete process.env.AEGIS_E1_TEST_KEY;
	const smokeConfigPath = prepared.configs.smoke;
	const smokeConfig = JSON.parse(readFileSync(smokeConfigPath, "utf8"));
	// An explicit missing model or missing auth must stop before request/Host startup.
	writeFileSync(
		smokeConfigPath,
		JSON.stringify({ ...smokeConfig, provider: { ...smokeConfig.provider, model: "missing" } }),
	);
	const missingModel = await runC6FromConfig({ configPath: smokeConfigPath, sdk, print: () => {} });
	assert.equal(missingModel.ok, false);
	assert.equal(missingModel.stage, "provider");
	writeFileSync(smokeConfigPath, JSON.stringify(smokeConfig));
	writeFileSync(join(piDir, "auth.json"), "{}");
	const missingAuth = await runC6FromConfig({ configPath: smokeConfigPath, sdk, print: () => {} });
	assert.equal(missingAuth.ok, false);
	assert.equal(missingAuth.stage, "provider");
	writeFileSync(join(piDir, "auth.json"), "malformed-offline-secret-sentinel");
	const malformedAuth = await runC6FromConfig({ configPath: smokeConfigPath, sdk, print: () => {} });
	assert.equal(malformedAuth.ok, false);
	assert.ok(
		!JSON.stringify(malformedAuth).includes("malformed-offline-secret-sentinel"),
		"credential parse errors are bounded",
	);
	assert.equal(existsSync(join(smokeConfig.work_dir, "events.jsonl")), false, "bad model/auth never starts Host");
	assert.equal(requests.length, 3);
	writeFileSync(join(piDir, "auth.json"), piBefore[2]);
	for (const task of ["smoke", "code"]) {
		const run = await runC6FromConfig({ configPath: prepared.configs[task], sdk, print: () => {} });
		assert.equal(run.ok, true, JSON.stringify(run.reasons));
		const summary = inspectMaxPilot(prepared.root, task);
		assert.equal(summary.task_states["task-001"], "completed", JSON.stringify(summary));
		assert.equal(summary.model_requests, 3);
		assert.equal(summary.oracle_status, "success");
		assert.equal(summary.unresolved_requests, 0);
		assert.equal(summary.chain_ok, true);
	}
	assert.equal(requests.length, 9);
	const piRestart = await runC6FromConfig({ configPath: smokeConfigPath, sdk, print: () => {} });
	assert.equal(piRestart.task_states["task-001"], "completed");
	assert.equal(requests.length, 9, "completed Pi-config attempt never dispatches again");
	// Exercise the exact operator CLI through the real SDK, with all HTTP replaced.
	const cliRoot = join(root, "cli");
	const cli = "Pi_Agent_base/campaign/e1-max-pilot.mjs";
	const prepareChild = spawnSync(process.execPath, [cli, "prepare", "--dir", cliRoot, "--pi-agent-dir", piDir], {
		encoding: "utf8",
		timeout: 60000,
	});
	assert.equal(prepareChild.status, 0, `${prepareChild.stdout}\n${prepareChild.stderr}`);
	const cliInputs = JSON.parse(prepareChild.stdout);
	const preload = join(root, "offline-http.mjs");
	writeFileSync(
		preload,
		`import assert from "node:assert/strict";\nconst selection = ${JSON.stringify(selection)};\nconst requests = [];\nglobalThis.fetch = ${globalThis.fetch.toString()};\n`,
	);
	const resolver = "./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts";
	for (const task of ["smoke", "code"]) {
		const child = spawnSync(
			process.execPath,
			["--import", resolver, "--import", preload, cli, "run", "--run-real", "--dir", cliInputs.root, "--task", task],
			{ encoding: "utf8", timeout: 60000 },
		);
		assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
		const summary = JSON.parse(readFileSync(join(cliInputs.root, task, "run-summary.json"), "utf8"));
		assert.equal(summary.task_states["task-001"], "completed");
		assert.equal(summary.model_requests, 3);
		assert.equal(summary.oracle_status, "success");
		const statusChild = spawnSync(process.execPath, [cli, "status", "--dir", cliInputs.root, "--task", task], {
			encoding: "utf8",
			timeout: 60000,
		});
		assert.equal(statusChild.status, 0, `${statusChild.stdout}\n${statusChild.stderr}`);
		const replayed = JSON.parse(statusChild.stdout);
		for (const key of Object.keys(replayed))
			assert.deepEqual(replayed[key], summary[key], `independent status after process exit agrees on ${key}`);
	}
	assert.deepEqual(
		["models.json", "settings.json", "auth.json", "models-store.json"].map((name) =>
			readFileSync(join(piDir, name), "utf8"),
		),
		piBefore,
		"Pi source configuration/credentials/cache remain unchanged",
	);
	console.log(
		"e1 remote/Pi config: selected model/auth/compat, missing auth/model, real SDK effect/replay, CLI and read-only source passed",
	);
} finally {
	globalThis.fetch = originalFetch;
	if (oldKey === undefined) delete process.env.AEGIS_E1_TEST_KEY;
	else process.env.AEGIS_E1_TEST_KEY = oldKey;
	if (oldMaxKey === undefined) delete process.env.AEGIS_MAX_API_KEY;
	else process.env.AEGIS_MAX_API_KEY = oldMaxKey;
	rmSync(root, { recursive: true, force: true });
}
