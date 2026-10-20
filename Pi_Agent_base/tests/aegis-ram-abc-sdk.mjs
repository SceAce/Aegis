// Actual SDK/faux control test, using only a local document. No network/credentials.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { projectWorkControl } from "../orchestration/work-control.mjs";
import { digest, verifyChain } from "../shared/events.mjs";

const root = mkdtempSync(join(tmpdir(), "aegis-abc-sdk-"));
const cwd = join(root, "workspace");
mkdirSync(cwd);
const document =
	"header\n" +
	"boilerplate\n".repeat(120) +
	"MIDDLE_DOCUMENT_SIGNAL\n" +
	"boilerplate\n".repeat(120) +
	"TAIL_DOCUMENT_SIGNAL";
writeFileSync(join(cwd, "document.txt"), document);
writeFileSync(join(root, "outside.txt"), "outside workspace");
const policy = join(root, "policy.json");
writeFileSync(
	policy,
	JSON.stringify({
		target_ref: "document.txt",
		criteria: ["report reviewed"],
		max_tool_calls: 20,
		max_identical_calls: 3,
		verification_calls: [
			{ tool_name: "read", arguments_digest: digest({ path: "document.txt" }) },
			{ tool_name: "read", arguments_digest: digest({ path: "../outside.txt" }) },
		],
	}),
);
const env = {
	AEGIS_EVENT_LOG: join(root, "events.jsonl"),
	AEGIS_RAM_DIR: join(root, "ram"),
	AEGIS_PROJECTION_DIR: join(root, "projections"),
	AEGIS_EXPERIENCE_DIR: join(root, "experiences"),
	AEGIS_TASK_ID: "task-sdk-abc",
	AEGIS_TASK_CONTRACT_FILE: policy,
	AEGIS_MANIFEST_FILE: "",
	AEGIS_ROM_FILE: resolve("Pi_Agent_base/agent/ROM.md"),
	// This fixture is about RAM/ABC only: do not auto-recall the user's private
	// knowledge/ tree (the test must not depend on local knowledge content).
	AEGIS_KNOWLEDGE_ENABLED: "off",
	AEGIS_KNOWLEDGE_DIR: join(root, "knowledge"),
};
const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
Object.assign(process.env, env);
const faux = registerFauxProvider({ provider: "faux", models: [{ id: "abc", name: "ABC local" }] });
let session;
const requests = [];
let observedAlias = null;
const rows = () => readFileSync(env.AEGIS_EVENT_LOG, "utf8").trim().split("\n").map(JSON.parse);
function ram(messages) {
	const content = (m) =>
		typeof m.content === "string" ? m.content : (m.content ?? []).map((part) => part.text ?? "").join("\n");
	const text = content(messages.findLast((m) => m.role === "user" && content(m).startsWith("<aegis_ram>")));
	return JSON.parse(text.replace(/^<aegis_ram>\n/, "").replace(/\n<\/aegis_ram>$/, ""));
}
try {
	const credentials = AuthStorage.inMemory();
	const model = faux.getModel();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "offline" }));
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: join(root, "models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		apiKey: "offline",
		models: [model],
	});
	const services = await createAgentSessionServices({
		cwd,
		agentDir: join(root, "agent"),
		modelRuntime,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noContextFiles: true,
			noThemes: true,
			noPromptTemplates: true,
			additionalExtensionPaths: [resolve("Pi_Agent_base/extensions/aegis-observer.ts")],
		},
	});
	const created = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.create(cwd, join(root, "sessions")),
		model,
		tools: ["read", "write", "aegis_propose", "aegis_submit_candidate"],
	});
	session = created.session;
	assert.deepEqual(services.diagnostics?.extensions?.errors ?? [], []);
	await session.bindExtensions({ mode: "print" });
	faux.setResponses([
		(context) => {
			requests.push(context.messages);
			return fauxAssistantMessage([fauxToolCall("read", { path: "document.txt" })]);
		},
		(context) => {
			requests.push(context.messages);
			const data = ram(context.messages);
			assert.ok(JSON.stringify(data.recent).includes("TAIL_DOCUMENT_SIGNAL"));
			const evidence = rows().findLast((r) => r.event_type === "action.completed" && r.payload.tool_name === "read");
			const alias = Object.entries(data.refs ?? {}).find(
				([, ref]) => ref.type === "event" && ref.id === evidence.event_id,
			)?.[0];
			assert.ok(alias, "the current RAM exposes an alias for the observed event");
			observedAlias = alias;
			return fauxAssistantMessage([
				fauxToolCall("aegis_propose", {
					kind: "claim",
					text: "Document may support the report",
					source_refs: [alias],
				}),
			]);
		},
		(context) => {
			requests.push(context.messages);
			const data = ram(context.messages);
			assert.equal(data.claims[0].trust, "unverified");
			const original = rows().find((r) => r.event_type === "proposal.submitted");
			const evidence = rows().find((r) => r.event_type === "action.completed" && r.payload.tool_name === "read");
			assert.equal(
				original.payload.source_refs[0].ref_id,
				evidence.event_id,
				"alias is resolved to canonical event identity",
			);
			const alias = Object.entries(data.refs ?? {}).find(
				([, ref]) => ref.type === "event" && ref.id === evidence.event_id,
			)?.[0];
			assert.ok(alias, "the same observed event keeps its alias in the next request");
			assert.equal(alias, observedAlias);
			return fauxAssistantMessage([
				fauxToolCall("aegis_propose", {
					kind: "claim",
					text: "Revised document interpretation",
					replace_event_id: original.event_id,
					source_refs: [{ ref_type: "event", ref_id: alias }],
				}),
			]);
		},
		(context) => {
			requests.push(context.messages);
			const proposals = rows().filter((r) => r.event_type === "proposal.submitted");
			assert.equal(proposals.length, 2, "actual SDK accepts the replacement against effective Board");
			assert.equal(proposals[1].payload.replace_event_id, proposals[0].event_id);
			const evidence = rows().find((r) => r.event_type === "action.completed" && r.payload.tool_name === "read");
			assert.equal(proposals[0].payload.source_refs[0].ref_id, evidence.event_id);
			assert.ok(
				rows().some(
					(row) =>
						row.event_type === "request.projected" &&
						typeof row.payload.ram_alias_epoch === "string" &&
						Number.isInteger(row.payload.ram_alias_count),
				),
				"request audit exposes alias epoch/count",
			);
			return fauxAssistantMessage([
				fauxToolCall("aegis_submit_candidate", {
					target_ref: "document.txt",
					criterion_id: "report reviewed",
					evidence_event_ids: [evidence.event_id],
				}),
				fauxToolCall("write", { path: "must-not-exist.txt", content: "blocked sibling effect" }),
			]);
		},
	]);
	await session.prompt("Inspect document.txt, record a sourced claim, then submit for external review.");
	assert.equal(
		rows().filter((r) => r.event_type === "action.requested" && r.payload.tool_name === "write").length,
		0,
		"candidate blocks later same-batch write before durable action admission",
	);
	assert.equal(existsSync(join(cwd, "must-not-exist.txt")), false);
	assert.equal(requests.length, 4, "accepted candidate stops automatic provider follow-up");
	assert.equal(projectWorkControl(rows(), env.AEGIS_TASK_ID).state, "waiting_external");
	assert.equal(verifyChain(rows()).ok, true);
	assert.equal(rows().filter((r) => r.event_type === "outcome.recorded").length, 0);
	assert.ok(!JSON.stringify(session.messages).includes("aegis_ram_context"));
	await session.prompt("Continue exploring without review");
	assert.equal(requests.length, 4, "waiting input cannot reach provider");
	const beforeVerify = rows().filter((r) => r.event_type === "action.requested").length;
	await session.prompt('/aegis work-verify {"tool_name":"read","args":{"path":"document.txt"}}');
	assert.equal(rows().filter((r) => r.event_type === "action.requested").length, beforeVerify + 1);
	assert.ok(rows().findLast((r) => r.event_type === "action.completed").payload.result);
	assert.equal(projectWorkControl(rows(), env.AEGIS_TASK_ID).state, "waiting_external");
	assert.equal(projectWorkControl(rows(), env.AEGIS_TASK_ID).attempts.length, beforeVerify + 1);
	await session.prompt('/aegis work-verify {"tool_name":"read","args":{"path":"document.txt","limit":1}}');
	await session.prompt('/aegis work-verify {"tool_name":"read","args":{"path":"../outside.txt"}}');
	await session.prompt('/aegis work-verify {"tool_name":"write","args":{"path":"must-not-exist.txt","content":"no"}}');
	assert.equal(
		rows().filter((r) => r.event_type === "action.requested").length,
		beforeVerify + 1,
		"unpinned args, outside grant, and writes never receive execution admission",
	);
	assert.equal(existsSync(join(cwd, "must-not-exist.txt")), false);
	assert.equal(requests.length, 4, "trusted verification uses no provider request");
	const frozenPolicy = readFileSync(policy, "utf8");
	writeFileSync(policy, JSON.stringify({ target_ref: "other", criteria: ["different"] }));
	await session.prompt("/aegis work-resume continue after review");
	assert.equal(
		projectWorkControl(rows(), env.AEGIS_TASK_ID).state,
		"waiting_external",
		"changed policy cannot authorize resume",
	);
	writeFileSync(policy, frozenPolicy);
	await session.prompt("/aegis work-resume continue after review");
	assert.equal(
		projectWorkControl(rows(), env.AEGIS_TASK_ID).state,
		"exploring",
		"trusted command resumes with frozen policy",
	);
	rmSync(policy);
	await session.prompt("Explore after policy disappeared");
	assert.equal(requests.length, 4, "missing configured policy cannot silently disable a frozen policy");
	console.log(
		"ABC SDK: real read fragments, explicit sourced claim, durable candidate wait, zero provider follow-up, no fabricated Outcome",
	);
} finally {
	await session?.dispose();
	faux.unregister();
	for (const [k, v] of Object.entries(before)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(root, { recursive: true, force: true });
}
