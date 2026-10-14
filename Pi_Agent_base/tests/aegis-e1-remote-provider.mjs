// Offline real SDK + intercepted OpenAI transport; never calls max or reads real auth.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { runC6FromConfig } from "../memory/campaign/c6-entry.mjs";
import { inspectMaxPilot, prepareMaxPilot } from "../memory/campaign/e1-max-pilot.mjs";
import { resolveProviderConfig } from "../memory/campaign/provider-config.mjs";
import { buildDataRepairManifest } from "../memory/campaign/structured-data-adapter.mjs";

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

const root = mkdtempSync(join(tmpdir(), "aegis-e1-remote-"));
const originalFetch = globalThis.fetch;
const oldKey = process.env.AEGIS_E1_TEST_KEY;
const oldMaxKey = process.env.AEGIS_MAX_API_KEY;
const sdk = { ...sdkBase, AuthStorage };
try {
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
		assert.equal(body.max_tokens, 4096);
		assert.equal(body.store, undefined);
		requests.push(body);
		const stage = (requests.length - 1) % 3;
		const codeTask = JSON.stringify(body.messages).includes("normalizeName");
		const target = codeTask ? "solution.mjs" : "dataset.json";
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
	const prepared = prepareMaxPilot(join(root, "prepared"));
	assert.equal(requests.length, 3, "preparation never requests a provider");
	assert.throws(() => prepareMaxPilot(prepared.root), /already exists/);
	assert.equal(inspectMaxPilot(prepared.root).task_states["task-001"], "ready");
	process.env.AEGIS_MAX_API_KEY = "offline-test-key";
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
	// Exercise the exact operator CLI through the real SDK, with all HTTP replaced.
	const cliInputs = prepareMaxPilot(join(root, "cli"));
	const preload = join(root, "offline-http.mjs");
	writeFileSync(
		preload,
		`import assert from "node:assert/strict";\nconst selection = ${JSON.stringify(selection)};\nconst requests = [];\nglobalThis.fetch = ${globalThis.fetch.toString()};\n`,
	);
	const cli = "Pi_Agent_base/memory/campaign/e1-max-pilot.mjs";
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
	}
	console.log("e1 remote provider: validation, missing auth, real SDK transport/tools/effect/replay passed");
} finally {
	globalThis.fetch = originalFetch;
	if (oldKey === undefined) delete process.env.AEGIS_E1_TEST_KEY;
	else process.env.AEGIS_E1_TEST_KEY = oldKey;
	if (oldMaxKey === undefined) delete process.env.AEGIS_MAX_API_KEY;
	else process.env.AEGIS_MAX_API_KEY = oldMaxKey;
	rmSync(root, { recursive: true, force: true });
}
