// MEM-01 cross-turn provider view via the real SDK + faux provider.
// The Observer emits one round checkpoint per turn; board-off must keep every
// board-derived feedback section (including derived checkpoints) out of every
// actual provider payload, while task/authorization/budget/pending survive.
// Offline only: faux provider, temp dirs, no credentials, no real target.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { projectBoard } from "../memory/board.mjs";
import { buildRamProjection } from "../memory/ram.mjs";
import { projectState } from "../memory/state.mjs";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "aegis-context-policy-turns-"));
const envNames = [
	"AEGIS_EVENT_LOG",
	"AEGIS_TASK_ID",
	"AEGIS_RAM_DIR",
	"AEGIS_PROJECTION_DIR",
	"AEGIS_EXPERIENCE_DIR",
	"AEGIS_HANDOFF_FILE",
	"AEGIS_ROM_FILE",
	"AEGIS_KNOWLEDGE_DIR",
	"AEGIS_RAM_SEED_FILE",
	"AEGIS_TASK_CONTRACT_FILE",
	"AEGIS_MANIFEST_FILE",
	"AEGIS_SCRIPT_CONFIG",
	"AEGIS_REPLAY_ADAPTER",
	"AEGIS_BOARD_FEEDBACK",
	"AEGIS_KNOWLEDGE_ENABLED",
];
const previous = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
const faux = registerFauxProvider({ provider: "faux", models: [{ id: "policy-turns", name: "Policy turns" }] });
const messageText = (m) =>
	typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join("\n");
function ram(messages) {
	const rows = messages.filter((m) => m.role === "user" && messageText(m).startsWith("<aegis_ram>\n"));
	assert.equal(rows.length, 1, "exactly one actual RAM block per provider request");
	return JSON.parse(
		messageText(rows[0])
			.replace(/^<aegis_ram>\n/, "")
			.replace(/\n<\/aegis_ram>$/, ""),
	);
}
const FEEDBACK = ["facts", "refuted", "tools", "proposals", "artifacts", "decisions", "checkpoints"];
let session;
try {
	const credentials = AuthStorage.inMemory(),
		model = faux.getModel();
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
	for (const board of [true, false]) {
		const dir = join(root, `turns-${board}`);
		for (const name of ["workspace", "agent", "sessions", "knowledge"]) mkdirSync(join(dir, name), { recursive: true });
		for (const key of envNames) process.env[key] = "";
		Object.assign(process.env, {
			AEGIS_EVENT_LOG: join(dir, "events.jsonl"),
			AEGIS_TASK_ID: `policy-turns-${board}`,
			AEGIS_RAM_DIR: join(dir, "ram"),
			AEGIS_PROJECTION_DIR: join(dir, "projections"),
			AEGIS_EXPERIENCE_DIR: join(dir, "experiences"),
			AEGIS_HANDOFF_FILE: join(dir, "handoff.json"),
			AEGIS_ROM_FILE: join(base, "agent", "ROM.md"),
			AEGIS_KNOWLEDGE_DIR: join(dir, "knowledge"),
			AEGIS_BOARD_FEEDBACK: board ? "on" : "off",
			AEGIS_KNOWLEDGE_ENABLED: "off",
		});
		const services = await createAgentSessionServices({
			cwd: join(dir, "workspace"),
			agentDir: join(dir, "agent"),
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noContextFiles: true,
				noThemes: true,
				noPromptTemplates: true,
				additionalExtensionPaths: [join(base, "extensions", "aegis-observer.ts")],
			},
		});
		({ session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(join(dir, "workspace"), join(dir, "sessions")),
			model,
			tools: ["aegis_propose"],
		}));
		assert.deepEqual(services.diagnostics?.extensions?.errors ?? [], []);
		await session.bindExtensions({ mode: "print" });
		const seen = [];
		const auditProbe = {
			name: "audit_probe",
			label: "Offline probe",
			description: "Return deterministic local data for an audit.",
			parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
			async execute(_id, params) {
				return {
					content: [{ type: "text", text: `PROBE_RESULT_${params.value}` }],
					details: { observed: `PROBE_DETAIL_${params.value}` },
				};
			},
		};
		// Three separate prompts = three real turns; each turn records the actual
		// provider payload and emits one Observer round checkpoint.
		for (let turn = 0; turn < 3; turn++) {
			faux.setResponses([
				(context) => {
					seen.push(ram(context.messages));
					return fauxAssistantMessage([
						fauxToolCall("aegis_propose", { kind: "claim", text: `TURN_CLAIM_MARKER_${turn}` }),
					]);
				},
				(context) => {
					seen.push(ram(context.messages));
					return fauxAssistantMessage(`turn ${turn} observed`);
				},
			]);
			await session.prompt(`Inspect the offline probe fixture, turn ${turn}.`);
		}
		await session.dispose();
		session = null;
		assert.ok(seen.length >= 4, "provider received multiple turns");
		for (const [index, view] of seen.entries()) {
			if (board) continue;
			for (const section of FEEDBACK)
				assert.equal(
					view.sections[section]?.shown ?? 0,
					0,
					`board-off request ${index} injected ${section}: MEM-01 leak`,
				);
			assert.ok(!JSON.stringify(view).includes("TURN_CLAIM_MARKER"), "board-off must not echo proposals");
			assert.ok(!JSON.stringify(view).includes("round_checkpoint"), "board-off must not echo checkpoints");
			assert.equal(view.task.authorization, "unknown", "RAM keeps explicit authorization state visible");
			assert.equal(typeof view.task.budget, "string", "budget state is always present on the task block");
		}
		const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
		assert.ok(
			events.some((e) => e.payload?.kind === "round.checkpoint"),
			"round checkpoints stay persisted for audit even when feedback is off",
		);
		const policyRows = events.filter((e) => e.event_type === "request.projected").map((e) => e.payload.context_policy);
		assert.ok(policyRows.length > 0 && policyRows.every((policy) => policy.board === board));
		if (board) {
			const later = seen.at(-1);
			assert.ok((later.sections.checkpoints?.shown ?? 0) > 0 || seen.some((v) => v.sections.checkpoints?.shown));
		}
	}

	console.log(
		"Context policy cross-turn SDK: board-off keeps every board-derived section (incl. round checkpoints) out of all actual provider payloads while audit keeps them",
	);
} finally {
	await session?.dispose();
	faux.unregister();
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
}
