#!/usr/bin/env node

import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const BASE_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = join(BASE_DIR, "config", "agent");
const MODELS_PATH = join(AGENT_DIR, "models.json");
const AUTH_PATH = join(AGENT_DIR, "auth.json");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");
const SUPPORTED_APIS = new Set([
	"anthropic-messages",
	"azure-openai-responses",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
	"mistral-conversations",
	"openai-codex-responses",
	"openai-completions",
	"openai-responses",
	"pi-messages",
]);

const HELP = `Configure an isolated Pi-compatible relay provider.

Usage:
  PI_RELAY_API_KEY='...' ./login-relay.mjs [options]
  ./login-relay.mjs --show [--provider ID]
  ./login-relay.mjs --logout --provider ID

Configuration options:
  --provider ID            Provider ID (env: PI_RELAY_PROVIDER, default: relay)
  --provider-name NAME     Display name (env: PI_RELAY_PROVIDER_NAME)
  --base-url URL           Relay API base URL (env: PI_RELAY_BASE_URL)
  --model ID               Actual model ID (env: PI_RELAY_MODEL)
  --model-name NAME        Model display name (env: PI_RELAY_MODEL_NAME)
  --api TYPE               Pi API adapter (env: PI_RELAY_API,
                           default: openai-completions)
  --api-key KEY            API key (prefer PI_RELAY_API_KEY to avoid shell history)
  --reasoning BOOL         true or false (env: PI_RELAY_REASONING, default: false)
  --input TYPES            text or text,image (env: PI_RELAY_INPUT, default: text)
  --context-window N       Context size (env: PI_RELAY_CONTEXT_WINDOW,
                           default: 128000)
  --max-tokens N           Maximum output tokens (env: PI_RELAY_MAX_TOKENS,
                           default: 16384)
  --no-prompt              Fail instead of prompting when the API key is missing

Other options:
  --show                   Print relay configuration without credentials
  --logout                 Remove the selected provider and its credential
  --help                   Show this help

All files are anchored below:
  ${AGENT_DIR}
`;

function fail(message) {
	throw new Error(message);
}

function ensureIsolatedAgentDir() {
	mkdirSync(AGENT_DIR, { recursive: true, mode: 0o700 });
	const expected = join(realpathSync(BASE_DIR), "config", "agent");
	const actual = realpathSync(AGENT_DIR);
	if (actual !== expected) {
		fail(`Refusing configuration outside Pi_Agent_base: ${actual}`);
	}
	for (const path of [MODELS_PATH, AUTH_PATH, SETTINGS_PATH]) {
		if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
			fail(`Refusing symbolic-link configuration file: ${path}`);
		}
	}
	chmodSync(AGENT_DIR, 0o700);
}

function parseArgs(argv) {
	const options = {};
	const valueOptions = new Map([
		["--provider", "provider"],
		["--provider-name", "providerName"],
		["--base-url", "baseUrl"],
		["--model", "model"],
		["--model-name", "modelName"],
		["--api", "api"],
		["--api-key", "apiKey"],
		["--reasoning", "reasoning"],
		["--input", "input"],
		["--context-window", "contextWindow"],
		["--max-tokens", "maxTokens"],
	]);

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") options.help = true;
		else if (argument === "--show") options.show = true;
		else if (argument === "--logout") options.logout = true;
		else if (argument === "--no-prompt") options.noPrompt = true;
		else if (valueOptions.has(argument)) {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) fail(`${argument} requires a value`);
			options[valueOptions.get(argument)] = value;
			index += 1;
		} else {
			fail(`Unknown option: ${argument}`);
		}
	}

	if (options.show && options.logout) fail("--show and --logout cannot be used together");
	return options;
}

function readJsonObject(path, fallback) {
	if (!existsSync(path)) return structuredClone(fallback);
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
	} catch (error) {
		fail(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		fail(`${path} must contain a JSON object`);
	}
	return parsed;
}

function atomicWriteJson(path, value, mode = 0o600) {
	ensureIsolatedAgentDir();
	const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let descriptor;
	try {
		descriptor = openSync(tempPath, "wx", mode);
		writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		chmodSync(tempPath, mode);
		renameSync(tempPath, path);
		chmodSync(path, mode);
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		rmSync(tempPath, { force: true });
		throw error;
	}
}

function optionalString(cliValue, environmentName) {
	const value = cliValue ?? process.env[environmentName];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseBoolean(value, label, defaultValue) {
	if (value === undefined) return defaultValue;
	const normalized = String(value).trim().toLowerCase();
	if (["true", "1", "yes", "on"].includes(normalized)) return true;
	if (["false", "0", "no", "off"].includes(normalized)) return false;
	fail(`${label} must be true or false`);
}

function parsePositiveInteger(value, label, defaultValue) {
	if (value === undefined || value === "") return defaultValue;
	if (!/^\d+$/.test(String(value))) fail(`${label} must be a positive integer`);
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number <= 0) fail(`${label} must be a positive integer`);
	return number;
}

function validateProviderId(provider) {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider)) {
		fail("Provider ID must contain only letters, numbers, dots, underscores, or hyphens");
	}
}

function normalizeBaseUrl(rawUrl) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		fail("Base URL must be a valid absolute URL");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		fail("Base URL must use http or https");
	}
	if (url.username || url.password) fail("Base URL must not contain credentials");
	return rawUrl.replace(/\/+$/, "");
}

function parseInput(value) {
	const input = (value ?? "text")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (input.length === 0 || input.some((entry) => entry !== "text" && entry !== "image")) {
		fail("Input types must be text or text,image");
	}
	return [...new Set(input)];
}

async function promptForApiKey() {
	if (!process.stdin.isTTY || !process.stderr.isTTY) {
		fail("API key is missing; set PI_RELAY_API_KEY or pass --api-key");
	}

	process.stderr.write("Relay API key: ");
	let echoDisabled = false;
	try {
		execFileSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "inherit"] });
		echoDisabled = true;
		const reader = createInterface({ input: process.stdin, output: process.stderr });
		try {
			return (await reader.question("")).trim();
		} finally {
			reader.close();
		}
	} finally {
		if (echoDisabled) execFileSync("stty", ["echo"], { stdio: ["inherit", "ignore", "inherit"] });
		process.stderr.write("\n");
	}
}

function loadConfiguration() {
	ensureIsolatedAgentDir();
	const models = readJsonObject(MODELS_PATH, { providers: {} });
	if (models.providers === undefined) models.providers = {};
	if (typeof models.providers !== "object" || models.providers === null || Array.isArray(models.providers)) {
		fail(`${MODELS_PATH} must contain a providers object`);
	}
	return {
		models,
		auth: readJsonObject(AUTH_PATH, {}),
		settings: readJsonObject(SETTINGS_PATH, {}),
	};
}

function printProvider(providerId, provider, auth, isDefault) {
	const models = Array.isArray(provider.models) ? provider.models : [];
	console.log(`provider: ${providerId}${isDefault ? " (default)" : ""}`);
	console.log(`  name: ${provider.name ?? providerId}`);
	console.log(`  base URL: ${provider.baseUrl ?? "<not set>"}`);
	console.log(`  API: ${provider.api ?? "<model-specific>"}`);
	console.log(`  models: ${models.length ? models.map((model) => model.id).join(", ") : "<none>"}`);
	console.log(`  credential: ${auth[providerId] ? "configured" : "missing"}`);
}

function showConfiguration(providerFilter) {
	const { models, auth, settings } = loadConfiguration();
	const entries = Object.entries(models.providers).filter(([providerId]) => !providerFilter || providerId === providerFilter);
	if (entries.length === 0) {
		console.log(providerFilter ? `No configured provider named ${providerFilter}.` : "No relay providers are configured.");
		return;
	}
	for (const [providerId, provider] of entries) {
		printProvider(providerId, provider, auth, settings.defaultProvider === providerId);
	}
	console.log(`config directory: ${AGENT_DIR}`);
}

function logout(provider) {
	validateProviderId(provider);
	const { models, auth, settings } = loadConfiguration();
	const existed = Boolean(models.providers[provider] || auth[provider]);
	delete models.providers[provider];
	delete auth[provider];
	if (settings.defaultProvider === provider) {
		delete settings.defaultProvider;
		delete settings.defaultModel;
	}
	atomicWriteJson(MODELS_PATH, models);
	atomicWriteJson(AUTH_PATH, auth);
	atomicWriteJson(SETTINGS_PATH, settings);
	console.log(existed ? `Removed Pi relay provider: ${provider}` : `Provider was already absent: ${provider}`);
	console.log(`config directory: ${AGENT_DIR}`);
}

async function configure(options) {
	const provider = optionalString(options.provider, "PI_RELAY_PROVIDER") ?? "relay";
	const providerName = optionalString(options.providerName, "PI_RELAY_PROVIDER_NAME") ?? provider;
	const baseUrlRaw = optionalString(options.baseUrl, "PI_RELAY_BASE_URL");
	const modelId = optionalString(options.model, "PI_RELAY_MODEL");
	const modelName = optionalString(options.modelName, "PI_RELAY_MODEL_NAME") ?? modelId;
	const api = optionalString(options.api, "PI_RELAY_API") ?? "openai-completions";
	const reasoning = parseBoolean(
		optionalString(options.reasoning, "PI_RELAY_REASONING"),
		"Reasoning",
		false,
	);
	const input = parseInput(optionalString(options.input, "PI_RELAY_INPUT"));
	const contextWindow = parsePositiveInteger(
		optionalString(options.contextWindow, "PI_RELAY_CONTEXT_WINDOW"),
		"Context window",
		128000,
	);
	const maxTokens = parsePositiveInteger(
		optionalString(options.maxTokens, "PI_RELAY_MAX_TOKENS"),
		"Max tokens",
		16384,
	);

	validateProviderId(provider);
	if (!baseUrlRaw) fail("Base URL is required; use --base-url or PI_RELAY_BASE_URL");
	if (!modelId) fail("Model ID is required; use --model or PI_RELAY_MODEL");
	if (!SUPPORTED_APIS.has(api)) {
		fail(`Unsupported Pi API adapter: ${api}. Supported values: ${[...SUPPORTED_APIS].join(", ")}`);
	}
	if (maxTokens > contextWindow) fail("Max tokens cannot exceed the context window");
	const baseUrl = normalizeBaseUrl(baseUrlRaw);

	let apiKey = optionalString(options.apiKey, "PI_RELAY_API_KEY");
	if (!apiKey && !options.noPrompt) apiKey = await promptForApiKey();
	if (!apiKey) fail("API key is missing; set PI_RELAY_API_KEY or pass --api-key");

	const { models, auth, settings } = loadConfiguration();
	const previous = models.providers[provider];
	const preserved = typeof previous === "object" && previous !== null && !Array.isArray(previous) ? previous : {};
	const nextProvider = {
		...preserved,
		name: providerName,
		baseUrl,
		api,
		models: [
			{
				id: modelId,
				name: modelName,
				reasoning,
				input,
				contextWindow,
				maxTokens,
			},
		],
	};
	delete nextProvider.apiKey;
	delete nextProvider.oauth;

	models.providers[provider] = nextProvider;
	auth[provider] = { type: "api_key", key: apiKey };
	settings.defaultProvider = provider;
	settings.defaultModel = modelId;

	atomicWriteJson(MODELS_PATH, models);
	atomicWriteJson(AUTH_PATH, auth);
	atomicWriteJson(SETTINGS_PATH, settings);

	console.log("Pi relay configured.");
	console.log(`provider: ${provider}`);
	console.log(`base URL: ${baseUrl}`);
	console.log(`model: ${modelId}`);
	console.log(`API: ${api}`);
	console.log(`credential: stored in ${AUTH_PATH}`);
	console.log(`default model: ${provider}/${modelId}`);
	console.log(`start Pi: ${join(BASE_DIR, "run-pi.sh")}`);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(HELP);
		return;
	}
	const provider = optionalString(options.provider, "PI_RELAY_PROVIDER");
	if (options.show) {
		showConfiguration(provider);
		return;
	}
	if (options.logout) {
		if (!provider) fail("--logout requires --provider ID or PI_RELAY_PROVIDER");
		logout(provider);
		return;
	}
	await configure(options);
}

main().catch((error) => {
	console.error(`login-relay: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
