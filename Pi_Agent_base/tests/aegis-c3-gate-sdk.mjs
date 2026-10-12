#!/usr/bin/env node
// Actual Pi tool_call admission + Host activation; no real model/network.
// node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-c3-gate-sdk.mjs
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { buildC3FixtureManifest } from "../memory/campaign/c3-entry.mjs";
import { createCampaignActionGate } from "../memory/campaign/campaign-mode.mjs";
import { createCampaignHost } from "../memory/campaign/host.mjs";

const dir = await mkdtemp(join(tmpdir(), "aegis-c3-gate-sdk-"));
let session;
try {
	const cwd = join(dir, "workspace"),
		agentDir = join(dir, "agent");
	for (const p of [cwd, agentDir]) await mkdir(p, { recursive: true });
	const gate = createCampaignActionGate();
	assert.equal(typeof gate.extensionFactory, "function", "gate must provide real SDK hook wiring");
	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "c3-gate", name: "C3Gate" }] });
	const model = faux.getModel();
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: join(dir, "models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, {
		id: model.id,
		name: model.name,
		provider: model.provider,
		api: model.api,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		baseUrl: model.baseUrl,
	});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [gate.extensionFactory],
	});
	await loader.reload();
	assert.equal(loader.getExtensions().errors.length, 0);
	({ session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		resourceLoader: loader,
		sessionManager: SessionManager.create(cwd, join(dir, "sessions")),
		settingsManager: SettingsManager.inMemory({}),
		tools: ["write", "bash", "edit"],
	}));
	await session.bindExtensions({});
	async function attempt(file) {
		faux.setResponses([
			() => fauxAssistantMessage([fauxToolCall("write", { path: join(cwd, file), content: "effect" })]),
			() => fauxAssistantMessage("done"),
		]);
		await session.prompt("Use the provided write tool.");
	}
	const manifest = buildC3FixtureManifest({ workspaceRoot: cwd });
	manifest.tasks = [manifest.tasks[0]];
	const events = [];
	const sink = {
		replay: () => events.slice(),
		async append(e) {
			const row = { ...e, event_id: `e${events.length}`, event_digest: `d${events.length}`, sequence: events.length };
			events.push(row);
			return { ok: true, durable: true, event: row };
		},
	};
	const host = createCampaignHost({
		manifest,
		ownedTasks: manifest.tasks,
		workspaceRoot: cwd,
		sink,
		actionGate: gate,
		worker: {
			async run() {
				await attempt("denied.txt");
				for (const call of [
					fauxToolCall("bash", { command: `touch '${join(cwd, "denied-bash.txt")}'` }),
					fauxToolCall("edit", { path: join(cwd, "editable.txt"), oldText: "original", newText: "modified" }),
				]) {
					faux.setResponses([() => fauxAssistantMessage([call]), () => fauxAssistantMessage("done")]);
					await session.prompt("Try the supplied direct tool.");
				}
				return { ok: false };
			},
		},
		oracle: {
			async judge() {
				return { status: "unknown" };
			},
		},
	});
	await writeFile(join(cwd, "editable.txt"), "original");
	await host.run();
	assert.equal(existsSync(join(cwd, "denied-bash.txt")), false);
	assert.equal(await readFile(join(cwd, "editable.txt"), "utf8"), "original");
	assert.equal(existsSync(join(cwd, "denied.txt")), false, "actual Pi write must be blocked during Host.run");
	await attempt("standard.txt");
	assert.equal(existsSync(join(cwd, "standard.txt")), true, "ordinary Pi remains usable after Campaign settles");
	console.log("C3 real SDK gate: pass");
} finally {
	if (session) session.dispose();
	await rm(dir, { recursive: true, force: true });
}
