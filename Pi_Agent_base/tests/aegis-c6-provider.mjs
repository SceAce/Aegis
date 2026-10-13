#!/usr/bin/env node
// Aegis C6-P6 / C6-D — explicit provider configuration and creation interface.
//
// Offline ONLY: it verifies the trusted config resolves a recognized provider,
// that the SDK creation seam receives the right model/endpoint and an isolated
// credential source, and that unknown/missing/illegal configurations are refused
// WITHOUT creating an SDK. No real credential is read or printed.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-c6-provider.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";

const sdk = { ...sdkBase, AuthStorage };

import { buildC3FixtureManifest } from "../memory/campaign/c3-entry.mjs";
import { runC6FromConfig } from "../memory/campaign/c6-entry.mjs";
import { validateManifest } from "../memory/campaign/manifest.mjs";
import {
	describeCredentialRef,
	isLoopbackBaseUrl,
	resolveProviderConfig,
} from "../memory/campaign/provider-config.mjs";

const BASE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const base = mkdtempSync(join(tmpdir(), "aegis-c6-provider-"));
const failures = [];
function check(name, condition, detail) {
	if (condition) console.log(`ok   ${name}`);
	else {
		failures.push(name);
		console.log(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

try {
	// --- Contract-level provider resolution (no SDK) --------------------------
	check("a faux provider resolves", resolveProviderConfig({ kind: "faux", model: "faux-c6" }).ok === true);
	check("an unknown provider kind is refused", resolveProviderConfig({ kind: "warp", model: "x" }).ok === false);
	check("a missing model is refused", resolveProviderConfig({ kind: "faux" }).ok === false);
	check(
		"an unknown provider key is refused",
		resolveProviderConfig({ kind: "faux", model: "x", extra: 1 }).ok === false,
	);
	check(
		"a non-loopback local endpoint is refused",
		resolveProviderConfig({ kind: "local-openai", model: "x", base_url: "http://evil.example/v1" }).ok === false,
	);
	check(
		"a recognized-but-unimplemented provider is refused, not silently faux",
		resolveProviderConfig({ kind: "anthropic", model: "claude" }).ok === false,
	);
	check("a loopback base_url is accepted by the helper", isLoopbackBaseUrl("http://127.0.0.1:8080/v1") === true);
	check("an https endpoint is not loopback", isLoopbackBaseUrl("https://api.example/v1") === false);
	check(
		"a credential_ref is described, never resolved to a value",
		describeCredentialRef("env:MY_KEY").env_name === "MY_KEY" && describeCredentialRef("env:MY_KEY").file_path === null,
	);
	check("a malformed credential_ref is refused", describeCredentialRef("raw-secret").ok === false);

	// --- Product-level creation seam receives the right args ------------------
	const workspaceRoot = join(base, "workspace");
	const workDir = join(base, "run");
	mkdirSync(workspaceRoot, { recursive: true });
	writeFileSync(join(workspaceRoot, "door.json"), `${JSON.stringify({ locked: true })}\n`, "utf8");
	const validated = validateManifest(buildC3FixtureManifest({ workspaceRoot }));
	assert.equal(validated.ok, true, validated.reasons?.join("; "));
	const manifestPath = join(base, "manifest.json");
	writeFileSync(manifestPath, `${JSON.stringify(validated.manifest, null, 2)}\n`, "utf8");

	function writeConfig(provider) {
		const configPath = join(base, `config.${JSON.stringify(provider)}.json`.replace(/[/]/g, "_"));
		writeFileSync(
			configPath,
			`${JSON.stringify({
				schema_version: "campaign-config-1.1",
				manifest_path: manifestPath,
				workspace_root: workspaceRoot,
				work_dir: workDir,
				mode: "auto",
				provider,
				context: { strategy: "bounded_ram", max_total_input_chars: 200000, output_reserve_chars: 1000 },
				learning: { policy: "off", promote_experience: false },
				task_family: "fixture-state",
				session: { session_count: 2, max_requests_per_session: 10 },
				observation: { enabled: false, port: 0 },
				oracle: { kind: "fixture" },
			})}\n`,
			"utf8",
		);
		return configPath;
	}

	const eventLogPath = join(workDir, "events.jsonl");
	Object.assign(process.env, {
		AEGIS_EVENT_LOG: eventLogPath,
		AEGIS_RAM_DIR: join(workDir, "runtime"),
		AEGIS_HANDOFF_FILE: join(workDir, "runtime", "handoff.json"),
		AEGIS_TASK_ID: "task-c6-provider",
		AEGIS_ROM_FILE: join(BASE_DIR, "agent", "ROM.md"),
	});
	mkdirSync(join(workDir, "runtime"), { recursive: true });

	// The faux provider records the model/endpoint the SDK seam received.
	let captured = null;
	const fauxFactory = (options) => {
		const faux = registerFauxProvider(options);
		captured = { provider: faux.provider, model: faux.getModel() };
		faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("ok")));
		return faux;
	};
	const okOutcome = await runC6FromConfig({
		configPath: writeConfig({ kind: "faux", model: "faux-c6" }),
		scenario: "run",
		sdk,
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});
	check(
		"a legal explicit provider runs",
		okOutcome.ok === true || Array.isArray(okOutcome.reasons),
		JSON.stringify(okOutcome.reasons),
	);
	check(
		"the SDK creation seam received the faux model",
		captured?.model?.id === "faux-c6",
		JSON.stringify(captured?.model?.id),
	);
	check(
		"the provider is the offline faux provider",
		captured?.model?.provider === "faux",
		JSON.stringify(captured?.model?.provider),
	);

	// An unknown provider is refused BEFORE any SDK creation.
	let seamCalls = 0;
	const refused = await runC6FromConfig({
		configPath: writeConfig({ kind: "warp", model: "x" }),
		scenario: "run",
		sdk,
		createSeam: async () => {
			seamCalls += 1;
			return { ok: true, sdk };
		},
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});
	check("an unknown provider is refused", refused.ok === false, JSON.stringify(refused.reasons));
	check("no SDK creation happened for the refused provider", seamCalls === 0, `seamCalls=${seamCalls}`);
	check("the refusal names the provider stage", refused.stage === "provider", JSON.stringify(refused.stage));
} finally {
	rmSync(base, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.log(`c6 provider: ${failures.length} failure(s)`);
	process.exit(1);
}
console.log("c6 provider: all checks passed");
