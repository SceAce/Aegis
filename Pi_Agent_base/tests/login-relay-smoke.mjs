#!/usr/bin/env node

import assert from "node:assert/strict";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const baseDir = dirname(testDir);
const sourceScript = join(baseDir, "login-relay.mjs");
const piBundle = join(baseDir, "pi", "packages", "coding-agent", "dist", "bundle", "cli.js");
const fixtureDir = mkdtempSync(join(tmpdir(), "aegis-pi-relay-"));
const fixtureScript = join(fixtureDir, "login-relay.mjs");
const agentDir = join(fixtureDir, "config", "agent");
const secret = "relay-smoke-secret";

function readJson(name) {
	return JSON.parse(readFileSync(join(agentDir, name), "utf8"));
}

function run(args, key = secret) {
	const environment = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !name.startsWith("PI_RELAY_")),
	);
	const result = spawnSync(process.execPath, [fixtureScript, ...args], {
		encoding: "utf8",
		env: { ...environment, PI_RELAY_API_KEY: key },
	});
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.ok(!`${result.stdout}${result.stderr}`.includes(key), "command output leaked the API key");
	return result;
}

try {
	mkdirSync(agentDir, { recursive: true });
	copyFileSync(sourceScript, fixtureScript);
	writeFileSync(
		join(agentDir, "models.json"),
		`${JSON.stringify({ providers: { existing: { baseUrl: "http://localhost/v1", api: "openai-completions", models: [{ id: "old" }] } } }, null, 2)}\n`,
	);
	writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify({ existing: { type: "api_key", key: "keep-me" } }, null, 2)}\n`);
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);

	run([
		"--provider",
		"smoke",
		"--provider-name",
		"Smoke Relay",
		"--base-url",
		"https://relay.invalid/v1/",
		"--model",
		"model-a",
		"--model-name",
		"Model A",
		"--reasoning",
		"true",
		"--input",
		"text,image",
		"--context-window",
		"32768",
		"--max-tokens",
		"4096",
		"--no-prompt",
	]);

	let models = readJson("models.json");
	let auth = readJson("auth.json");
	let settings = readJson("settings.json");
	assert.equal(models.providers.existing.models[0].id, "old");
	assert.equal(models.providers.smoke.baseUrl, "https://relay.invalid/v1");
	assert.equal(models.providers.smoke.api, "openai-completions");
	assert.deepEqual(models.providers.smoke.models, [
		{
			id: "model-a",
			name: "Model A",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 32768,
			maxTokens: 4096,
		},
	]);
	assert.equal(auth.existing.key, "keep-me");
	assert.equal(auth.smoke.key, secret);
	assert.equal(settings.theme, "dark");
	assert.equal(settings.defaultProvider, "smoke");
	assert.equal(settings.defaultModel, "model-a");
	assert.equal(statSync(join(agentDir, "auth.json")).mode & 0o777, 0o600);
	assert.equal(statSync(agentDir).mode & 0o777, 0o700);

	const piModels = spawnSync(process.execPath, [piBundle, "--list-models", "smoke"], {
		cwd: fixtureDir,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	});
	assert.equal(piModels.status, 0, `${piModels.stdout}\n${piModels.stderr}`);
	assert.match(piModels.stdout, /smoke/);
	assert.match(piModels.stdout, /model-a/);

	const shown = run(["--show", "--provider", "smoke"]);
	assert.match(shown.stdout, /credential: configured/);
	assert.match(shown.stdout, /models: model-a/);

	run(
		[
			"--provider",
			"smoke",
			"--base-url",
			"https://relay.invalid/v2",
			"--model",
			"model-b",
			"--no-prompt",
		],
		"replacement-secret",
	);
	models = readJson("models.json");
	assert.deepEqual(models.providers.smoke.models.map((model) => model.id), ["model-b"]);

	run(["--logout", "--provider", "smoke"]);
	models = readJson("models.json");
	auth = readJson("auth.json");
	settings = readJson("settings.json");
	assert.ok(models.providers.existing);
	assert.equal(models.providers.smoke, undefined);
	assert.equal(auth.smoke, undefined);
	assert.equal(settings.defaultProvider, undefined);
	assert.equal(settings.defaultModel, undefined);
	assert.equal(settings.theme, "dark");

	const escapedDir = mkdtempSync(join(tmpdir(), "aegis-pi-relay-escape-"));
	rmSync(agentDir, { recursive: true, force: true });
	mkdirSync(dirname(agentDir), { recursive: true });
	symlinkSync(escapedDir, agentDir, "dir");
	const rejected = spawnSync(process.execPath, [fixtureScript, "--show"], {
		encoding: "utf8",
		env: process.env,
	});
	assert.notEqual(rejected.status, 0);
	assert.match(rejected.stderr, /Refusing configuration outside Pi_Agent_base/);
	rmSync(escapedDir, { recursive: true, force: true });

	console.log("login relay smoke ok");
} finally {
	rmSync(fixtureDir, { recursive: true, force: true });
}
