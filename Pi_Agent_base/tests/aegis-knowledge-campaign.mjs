// Knowledge selection through the real C6 entry, SDK, durable tool ledger and Broker.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { buildC3FixtureManifest } from "../campaign/c3-entry.mjs";
import { runC6FromConfig } from "../campaign/c6-entry.mjs";
import { compileDocumentSeed } from "../memory/document-seed.mjs";
import { verifyChain } from "../shared/events.mjs";

const base = mkdtempSync(join(tmpdir(), "aegis-knowledge-campaign-"));
const workspace = join(base, "workspace"),
	work = join(base, "run"),
	knowledge = join(base, "knowledge");
for (const dir of [workspace, work, knowledge]) mkdirSync(dir);
const previous = process.env.AEGIS_KNOWLEDGE_DIR;
process.env.AEGIS_KNOWLEDGE_DIR = knowledge;
try {
	writeFileSync(join(workspace, "door.json"), JSON.stringify({ locked: true }));
	writeFileSync(
		join(knowledge, "fixture.json"),
		JSON.stringify(
			compileDocumentSeed({
				markdown:
					"# fixture state\n\nCAMPAIGN_KNOWLEDGE_727 is a reference only; observe the fixture state independently.\n",
				source: { source_kind: "external_reference", source_uri: "https://example.invalid/fixture", approved: true },
			}),
		),
	);
	const manifest = buildC3FixtureManifest({ workspaceRoot: workspace });
	writeFileSync(join(base, "manifest.json"), JSON.stringify(manifest));
	const configPath = join(base, "campaign.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			schema_version: "campaign-config-1.1",
			manifest_path: join(base, "manifest.json"),
			workspace_root: workspace,
			work_dir: work,
			mode: "auto",
			provider: { kind: "faux", model: "knowledge-campaign" },
			context: { strategy: "bounded_ram", max_total_input_chars: 200000, output_reserve_chars: 1000 },
			learning: { policy: "off", promote_experience: false },
			task_family: "fixture-state",
			session: { session_count: 3, max_requests_per_session: 20 },
			observation: { enabled: false, port: 0 },
			oracle: { kind: "fixture" },
		}),
	);
	const seen = new Map();
	let refined = false;
	const outcome = await runC6FromConfig({
		configPath,
		sdk: { ...sdkBase, AuthStorage },
		print() {},
		fauxProviderFactory(options) {
			const faux = registerFauxProvider(options);
			const response = (context) => {
				const taskId = [...JSON.stringify(context.messages).matchAll(/TASK (task-\d+)/g)].at(-1)?.[1] ?? "task-001";
				const count = (seen.get(taskId) ?? 0) + 1;
				seen.set(taskId, count);
				if (taskId === "task-001" && count === 1)
					return fauxAssistantMessage([fauxToolCall("aegis_knowledge", { query: "fixture state", max_results: 1 })]);
				if (taskId === "task-001" && count === 2) {
					assert.ok(JSON.stringify(context.messages).includes("CAMPAIGN_KNOWLEDGE_727"));
					refined = true;
				}
				if ((taskId === "task-001" && count === 2) || (taskId !== "task-001" && count === 1))
					return fauxAssistantMessage([
						fauxToolCall("aegis_task_decision", {
							actions: [
								{
									action_ref: "fixture.state.set",
									arguments: { target: "door.json", key: "locked", value: taskId === "task-001" },
								},
							],
						}),
					]);
				return fauxAssistantMessage("Decision recorded, awaiting independent verification.");
			};
			faux.setResponses(Array.from({ length: 14 }, () => response));
			return faux;
		},
	});
	assert.equal(outcome.ok, true, JSON.stringify(outcome.reasons));
	assert.equal(outcome.task_states["task-001"], "completed");
	assert.equal(outcome.task_states["task-002"], "completed");
	assert.equal(refined, true);
	const events = readFileSync(join(work, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
	assert.equal(verifyChain(events).ok, true);
	const charged = events.filter((e) => e.payload?.tool_name === "aegis_knowledge");
	assert.ok(
		charged.some((e) => e.payload?.kind === "c6.tool" && e.payload?.phase === "charged"),
		JSON.stringify(charged.map((e) => e.payload.kind)),
	);
	assert.ok(
		charged.some((e) => e.payload?.kind === "c6.tool" && e.payload?.phase === "finished"),
		JSON.stringify(charged.map((e) => e.payload.kind)),
	);
	assert.ok(events.some((e) => e.payload?.kind === "knowledge.selected" && e.payload?.mode === "model_query"));
	assert.equal(JSON.parse(readFileSync(join(workspace, "door.json"), "utf8")).locked, false);
	console.log(
		"Knowledge Campaign: real entry tool exposure, model query, next-request context, durable charge/finish and Broker completion passed",
	);
} finally {
	if (previous === undefined) delete process.env.AEGIS_KNOWLEDGE_DIR;
	else process.env.AEGIS_KNOWLEDGE_DIR = previous;
	rmSync(base, { recursive: true, force: true });
}
