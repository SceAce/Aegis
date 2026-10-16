#!/usr/bin/env node
// C3 core boundaries, real product Host/EventLog/local effects, no model/network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	artifactIndexFromEvents,
	assembleCampaignHost,
	buildC3FixtureManifest,
	createProductSink,
} from "../campaign/c3-entry.mjs";
import { validateManifest } from "../campaign/manifest.mjs";
import { createWorkspaceScriptRegistration } from "../execution/adapters/script-workspace-adapter.mjs";

async function setup(t, adjust = () => {}, options = {}) {
	const dir = await mkdtemp(join(tmpdir(), "aegis-c3-external-"));
	let assembled;
	t.after(async () => {
		if (assembled?.sink.close) await assembled.sink.close();
		await rm(dir, { recursive: true, force: true });
	});
	const workspaceRoot = join(dir, "workspace");
	const raw = buildC3FixtureManifest({ workspaceRoot });
	adjust(raw);
	const validated = validateManifest(raw);
	assert.equal(validated.ok, true, validated.reasons?.join("; "));
	assembled = await assembleCampaignHost({
		manifest: validated.manifest,
		workspaceRoot,
		workDir: dir,
		eventLogPath: join(dir, "events.jsonl"),
		mode: "auto",
		...options,
	});
	return { ...assembled, dir, workspaceRoot };
}

test("CONTROL: legal product execution completes both tasks", async (t) => {
	const a = await setup(t);
	const r = await a.host.run();
	assert.equal(r.ok, true);
	assert.deepEqual(
		r.status.tasks.map((x) => x.state),
		["completed", "completed"],
	);
});

test("C3-X1: a target inside workspace but outside Manifest/Task grant never executes", async (t) => {
	const a = await setup(t, () => {}, {
		planFactory: (task) => ({
			task_id: task.task_id,
			steps: [
				{
					step_id: "foreign",
					stage_id: task.stages[0].stage_id,
					action_ref: "fixture.state.set",
					arguments: { target: "ungranted.json", key: "locked", value: true },
					evidence_ref: "artifact:foreign",
				},
			],
		}),
	});
	await a.host.run();
	await assert.rejects(readFile(join(a.workspaceRoot, "ungranted.json")), { code: "ENOENT" });
});

test("C3-X1: missing capability grant prevents a registered action effect", async (t) => {
	const a = await setup(t, (raw) => {
		raw.authorization.allowed_capabilities = ["fixture.observe"];
	});
	await a.host.run();
	await assert.rejects(readFile(join(a.workspaceRoot, "door.json")), { code: "ENOENT" });
});

for (const fault of ["not_ok", "not_durable", "throw"]) {
	test(`C3-X2: ${fault} action persistence stops independent tasks and restart`, async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "aegis-c3-fault-"));
		const sink = createProductSink({ eventLogPath: join(dir, "events.jsonl") });
		t.after(async () => {
			await sink.close();
			await rm(dir, { recursive: true, force: true });
		});
		let requested = 0;
		const a = await setup(
			t,
			(raw) => {
				raw.tasks[1].depends_on = [];
			},
			{
				sinkImpl: {
					open: () => sink.open(),
					replay: () => sink.replay(),
					append: async (e) => {
						if (e.event_type === "action.requested") requested += 1;
						if (e.event_type === "action.completed") {
							if (fault === "throw") throw new Error("external injected append throw");
							if (fault === "not_durable") return { ok: true, durable: false, event: e };
							return { ok: false, error: "external injected result failure" };
						}
						return sink.append(e);
					},
				},
			},
		);
		const r = await a.host.run();
		assert.equal(requested, 1, "independent next task cannot perform another unlogged effect");
		assert.equal(r.ok, false, "audit degradation is not a successful run");
		const restart = await a.host.run();
		assert.equal(restart.status.control.state, "stopped");
		assert.equal(requested, 1, "a fresh run must not resume after the durable audit stop");
	});
}

test("C3-X3: two tasks delayed until later evidence complete without rerunning Worker", async (t) => {
	const a = await setup(t, () => {}, { delayedFirstByTask: { "task-001": true, "task-002": true } });
	await a.host.run();
	const r = await a.host.run();
	assert.deepEqual(
		r.status.tasks.map((x) => x.state),
		["completed", "completed"],
	);
	assert.equal(a.sink.replay().filter((e) => e.event_type === "action.requested").length, 2);
});

test("C3-X4: untrusted refs do not become a restarted artifact index", () => {
	const events = [
		{
			event_type: "runtime.note",
			source: { kind: "llm" },
			payload: { outcome: { evidence_refs: [{ ref_id: "artifact:forged", digest: "digest:forged" }] } },
		},
	];
	assert.equal(artifactIndexFromEvents(events).has("artifact:forged"), false);
});

test("C3-X5: one observed criterion cannot satisfy unrelated required criteria", async (t) => {
	const a = await setup(t, (raw) => {
		raw.tasks[0].stages[0].criteria.push("another-unverified-criterion");
	});
	const r = await a.host.run();
	assert.notEqual(r.status.tasks[0].state, "completed");
});

test("C3-X6: fixture Oracle judges declared criteria rather than task type", async (t) => {
	const a = await setup(t, (raw) => {
		raw.tasks[0].stages[0].criteria = ["door.locked == false"];
		raw.tasks[0].goal.success_criteria = ["door.locked == false"];
	});
	const r = await a.host.run();
	assert.notEqual(
		r.status.tasks[0].state,
		"completed",
		"observe task writes true; declared false criterion is not met",
	);
});

test("C3-PRODUCT: workspace script configuration reaches the real Broker via assembly", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aegis-c3-script-product-"));
	const workspaceRoot = join(dir, "workspace");
	await import("node:fs/promises").then((fs) => fs.mkdir(workspaceRoot));
	const registration = createWorkspaceScriptRegistration({
		workspaceRoot,
		scriptPath: fileURLToPath(new URL("./helpers/c3-workspace-state.mjs", import.meta.url)),
	});
	const raw = buildC3FixtureManifest({ workspaceRoot, target: "state.json" });
	raw.authorization.allowed_capabilities = ["workspace-script"];
	raw.tasks = [raw.tasks[1]];
	raw.tasks[0].depends_on = [];
	raw.tasks[0].stages[0].criteria = ["state.locked == false"];
	const assembled = await assembleCampaignHost({
		manifest: raw,
		workspaceRoot,
		workDir: dir,
		eventLogPath: join(dir, "events.jsonl"),
		mode: "auto",
		scriptRegistrationConfig: { scripts: [registration] },
		planFactory: (task) => ({
			task_id: task.task_id,
			steps: [
				{
					step_id: "write",
					stage_id: task.stages[0].stage_id,
					action_ref: "script.aegis.workspace.state",
					arguments: { state_file: "state.json", key: "locked", value: false },
					evidence_ref: `artifact:${task.task_id}`,
				},
			],
		}),
	});
	t.after(async () => {
		await assembled.sink.close();
		await rm(dir, { recursive: true, force: true });
	});
	const r = await assembled.host.run();
	assert.equal(r.status.tasks[0].state, "completed", JSON.stringify(r.status.rejected));
	assert.deepEqual(JSON.parse(await readFile(join(workspaceRoot, "state.json"), "utf8")), { locked: false });
});

test("C3-PRODUCT: pause remains durable until explicit resume", async (t) => {
	const a = await setup(t);
	await a.host.pause("test_pause");
	const paused = await a.host.run();
	assert.equal(paused.status.control.state, "paused");
	assert.equal(a.sink.replay().filter((e) => e.event_type === "action.requested").length, 0);
	await a.host.resume("test_resume");
	const resumed = await a.host.run();
	assert.deepEqual(
		resumed.status.tasks.map((x) => x.state),
		["completed", "completed"],
	);
});

test("C3-CLI: a restarted paused Campaign only executes after explicit resume", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "aegis-c3-cli-review-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const entry = fileURLToPath(new URL("../campaign/c3-entry.mjs", import.meta.url));
	for (const operation of ["pause", "start", "resume"]) {
		const r = spawnSync(process.execPath, [entry, dir, operation], { encoding: "utf8", timeout: 10000 });
		assert.equal(r.status, 0, r.stderr);
		const summary = JSON.parse(r.stdout);
		if (operation !== "resume") {
			assert.equal(summary.campaign_state, "paused");
			assert.equal(summary.action_events.requested, 0);
		} else {
			assert.deepEqual(Object.values(summary.task_states), ["completed", "completed"]);
			assert.equal(summary.action_events.requested, 2);
		}
	}
});

test("C3-X1: a denied action cannot use pre-existing state to claim completion", async (t) => {
	const a = await setup(t, () => {}, {
		planFactory: (task) => ({
			task_id: task.task_id,
			steps: [
				{
					step_id: "denied",
					stage_id: task.stages[0].stage_id,
					action_ref: "unregistered.action",
					arguments: {},
					evidence_ref: `artifact:${task.task_id}`,
				},
			],
		}),
	});
	await writeFile(join(a.workspaceRoot, "door.json"), '{"locked":true}\n');
	const r = await a.host.run();
	assert.notEqual(r.status.tasks[0].state, "completed");
});
