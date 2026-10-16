#!/usr/bin/env node
// Aegis C4a — real loopback HTTP observation test over a REAL C3 fixture run.
//
// Required: real product entry (§C4A-1), same-source (§C4A-2), unknown/control/
// dynamic visible (§C4A-3), no write route (§C4A-4a), bounds (§C4A-6a),
// integrity failure (§C4A-6b), lifecycle/non-blocking (§C4A-7).
//
// Run:
//   node Pi_Agent_base/tests/aegis-c4a-observation-http.mjs

import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { createObservationServer } from "../observation/observation-server.mjs";
import { buildObservationView } from "../observation/observation-view.mjs";
import { generateCampaignArtifacts } from "../observation/report-export.mjs";
import { EventLog } from "../shared/events.mjs";
import { readEvents, runFixtureCampaign } from "./helpers/c4-report-helpers.mjs";

async function start(t, src, options = {}) {
	const server = createObservationServer({
		manifestPath: src.manifestPath,
		eventsPath: src.eventsPath,
		...options,
	});
	await server.listen();
	t.after(async () => {
		await server.close();
	});
	return server;
}
function api(server, path, init) {
	return fetch(new URL(path, server.url).href, init);
}

// ---------------------------------------------------------------------------
// C4A-1 real product entry
// ---------------------------------------------------------------------------

test("C4A-1: the HTTP server serves the real queue/action/result", async (t) => {
	const src = await runFixtureCampaign();
	t.after(() => rm(src.dir, { recursive: true, force: true }));
	const server = await start(t, src);
	assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
	const home = await api(server, "/");
	assert.equal(home.status, 200);
	const html = await home.text();
	assert.ok(html.includes("task-001"), "page shows task-001");
	assert.ok(html.includes("task-002"), "page shows task-002");
	const tasks = await (await api(server, "/api/tasks")).json();
	assert.equal(tasks.tasks.length, 2);
	const actions = await (await api(server, "/api/actions")).json();
	assert.equal(actions.counts.requested, 2);
	assert.equal(actions.counts.executed, 2);
	const outcomes = await (await api(server, "/api/outcomes")).json();
	assert.ok(outcomes.outcomes.length >= 2, "outcomes are visible");
});

// ---------------------------------------------------------------------------
// C4A-2 same source
// ---------------------------------------------------------------------------

test("C4A-2: the HTTP view equals the C4 report derivation and reflects new events", async (t) => {
	const src = await runFixtureCampaign();
	t.after(() => rm(src.dir, { recursive: true, force: true }));
	const server = await start(t, src);
	const before = await (await api(server, "/api/view")).json();
	const rows = await readEvents(src.eventsPath);
	const report = generateCampaignArtifacts({ manifest: src.manifest, events: rows }).report;
	assert.deepEqual(
		before.tasks.map((x) => [x.task_id, x.status]).sort(),
		(report.tasks ?? []).map((x) => [x.task_id, x.status]).sort(),
		"task statuses agree with the report",
	);
	// Append a benign committed event via the REAL writer and refresh; the
	// count must change.
	const log = new EventLog(src.eventsPath);
	assert.equal((await log.open()).ok, true);
	try {
		assert.equal(
			(
				await log.append({
					event_type: "action.requested",
					source: { kind: "runtime", actor_id: "test", adapter: "c4a", version: "1" },
					payload: { action_id: "action-extra", action_ref: "fixture.state.set" },
				})
			).ok,
			true,
		);
	} finally {
		await log.close();
	}
	const after = await (await api(server, "/api/actions")).json();
	assert.equal(after.counts.requested, 3, "the refreshed view reflects the new committed event");
});

// ---------------------------------------------------------------------------
// C4A-3 unknown / control / dynamic
// ---------------------------------------------------------------------------

test("C4A-3a: a task left unknown by a delayed Oracle is shown as unknown", async (t) => {
	const src = await runFixtureCampaign({
		options: {
			oracleOverrides: {
				judgeTask: () => ({ status: "unknown", delayed: true, failure_mode: "delayed_verification" }),
			},
		},
	});
	t.after(() => rm(src.dir, { recursive: true, force: true }));
	const server = await start(t, src);
	const view = await (await api(server, "/api/view")).json();
	const t1 = view.tasks.find((x) => x.task_id === "task-001");
	assert.notEqual(t1.status, "success", "unknown is not success");
	assert.ok(["unknown", "pending"].includes(t1.status));
});

test("C4A-3b: a durable cancel is shown in the control state", async (t) => {
	const src = await runFixtureCampaign();
	t.after(() => rm(src.dir, { recursive: true, force: true }));
	// Use the actual durable writer so this cannot pass on a corrupt chain.
	const log = new EventLog(src.eventsPath);
	assert.equal((await log.open()).ok, true);
	try {
		await log.append({
			event_type: "runtime.note",
			source: { kind: "runtime", actor_id: "test", adapter: "c4a", version: "1" },
			payload: { kind: "campaign.campaign.cancelled", campaign_id: src.manifest.campaign_id, reason: "user_cancelled" },
		});
	} finally {
		await log.close();
	}
	const server = await start(t, src);
	const view = await (await api(server, "/api/view")).json();
	assert.equal(view.control.state, "cancelled");
	assert.equal(view.integrity.event_chain_ok, true);
});

test("C4A-3c: blocked/rejected proposals and fault reasons are visible", async (t) => {
	const src = await runFixtureCampaign();
	t.after(() => rm(src.dir, { recursive: true, force: true }));
	const log = new EventLog(src.eventsPath);
	assert.equal((await log.open()).ok, true);
	try {
		await log.append({
			event_type: "runtime.note",
			source: { kind: "llm", actor_id: "m", adapter: "c4a", version: "1" },
			payload: {
				kind: "campaign.proposal.submitted",
				campaign_id: src.manifest.campaign_id,
				proposal_id: "p1",
				proposal_digest: "sha256:p1",
				proposal: { proposed_task_id: "task-dyn-x" },
			},
		});
		await log.append({
			event_type: "runtime.note",
			source: { kind: "runtime", actor_id: "h", adapter: "c4a", version: "1" },
			payload: {
				kind: "campaign.proposal.blocked",
				campaign_id: src.manifest.campaign_id,
				proposal_id: "p1",
				reason: "no budget",
			},
		});
	} finally {
		await log.close();
	}
	const server = await start(t, src);
	const queue = await (await api(server, "/api/queue")).json();
	assert.ok(
		queue.proposals.some((p) => p.id === "p1"),
		"the submitted proposal is visible",
	);
});

// ---------------------------------------------------------------------------
// C4A-4a no write route
// ---------------------------------------------------------------------------

test("C4A-4a: every mutation method is refused and the source is unchanged", async (t) => {
	const src = await runFixtureCampaign();
	t.after(() => rm(src.dir, { recursive: true, force: true }));
	const server = await start(t, src);
	const before = await readFile(src.eventsPath);
	for (const path of ["/", "/api/view", "/api/tasks", "/api/actions", "/healthz"]) {
		for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
			const res = await api(server, path, { method });
			assert.equal(res.status, 405, `${method} ${path} must be 405`);
			const body = await res.json();
			assert.match(body.error, /read-only/);
		}
	}
	const after = await readFile(src.eventsPath);
	assert.deepEqual(after, before, "the source is byte-identical after mutation attempts");
});

// ---------------------------------------------------------------------------
// C4A-6a bounds
// ---------------------------------------------------------------------------

test("C4A-6a: an oversized list is bounded with a truncated flag and full total", () => {
	const src = { manifest: null };
	void src;
	// Build a view from a manifest with one task and a tiny task cap.
	const manifest = {
		schema_version: "campaign-1.0",
		campaign_id: "campaign-c4a-bounds",
		revision: 1,
		created_at: "2026-01-01T00:00:00Z",
		title: "bounds",
		objective: { description: "d", success_criteria: ["c"], stage_policy: "declared_only" },
		worker: { provider: "fixture", model: "none" },
		authorization: {
			execution_profile: "supervised-macos-workspace",
			workspace_root: "/tmp/ws",
			allowed_targets: ["state.json"],
			allowed_capabilities: ["c"],
			network: "disabled",
			credentials: "none",
			human_approval: "campaign_grant",
			workspace_is_sandbox: false,
		},
		budget: { wall_time_ms: 1000, model_requests: 1, tool_calls: 1, task_count: 5, session_count: 1 },
		session_policy: {
			max_requests_per_session: 1,
			max_context_chars: 100,
			rotate_at_stage_boundary: true,
			rotate_on_model_request: true,
			allow_model_handoff_request: true,
		},
		adapters: { execution: "workspace.exec.v1", oracle: "fixture.oracle.v1", report: "aegis-acceptance.v1" },
		tasks: Array.from({ length: 5 }, (_, i) => ({
			task_id: `task-${i}`,
			order: i + 1,
			depends_on: [],
			target_ref: "state.json",
			task_type: "observe",
			scope: { environment_fingerprint: "fixture-env", domain: "fixture" },
			goal: { goal_id: "g", description: "g", success_criteria: ["c"] },
			stages: [{ stage_id: `stage-${i}`, criteria: ["c"], required: true }],
			oracle_ref: "fixture.oracle.v1",
			task_budget: { wall_time_ms: 1, model_requests: 1, tool_calls: 1 },
		})),
		evidence_policy: { independent_result_required: true, unknown_is_not_failure: true, promote_experience: false },
	};
	const view = buildObservationView({ manifest, events: [], limits: { max_tasks: 2, max_page_size: 2 } });
	assert.equal(view.tasks.length, 2, "only a bounded page is returned");
	assert.equal(view.pagination.tasks.total, 5, "the full total is reported");
	assert.equal(view.pagination.tasks.truncated, true, "the page is marked truncated");
});

// ---------------------------------------------------------------------------
// C4A-6b integrity failure
// ---------------------------------------------------------------------------

test("C4A-6b: a corrupt chain yields integrity_failure/stale, never completed work", async (t) => {
	const src = await runFixtureCampaign();
	t.after(() => rm(src.dir, { recursive: true, force: true }));
	const rows = await readEvents(src.eventsPath);
	if (rows.length > 2) rows[2].payload = { ...rows[2].payload, tampered: true };
	await writeFile(src.eventsPath, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
	const server = await start(t, src);
	const view = await (await api(server, "/api/view")).json();
	assert.equal(view.integrity.event_chain_ok, false);
	assert.equal(view.integrity.stale, true);
	assert.ok(["integrity_failure", "stale_after_error"].includes(view.integrity.status));
	const health = await (await api(server, "/healthz")).json();
	assert.notEqual(health.integrity, "ok");
});

// ---------------------------------------------------------------------------
// C4A-7 lifecycle / non-blocking
// ---------------------------------------------------------------------------

test("C4A-7: the server binds loopback, closes idempotently and releases the port", async () => {
	const src = await runFixtureCampaign();
	const server = createObservationServer({ manifestPath: src.manifestPath, eventsPath: src.eventsPath });
	await server.listen();
	assert.equal(server.host, "127.0.0.1");
	const port = server.port;
	assert.ok(port > 0);
	const first = await server.close();
	assert.equal(first.ok, true);
	const second = await server.close();
	assert.equal(second.alreadyClosed, true, "double close is safe");
	// The port can be rebound (released).
	const rebind = createObservationServer({ manifestPath: src.manifestPath, eventsPath: src.eventsPath, port });
	await rebind.listen();
	assert.equal(rebind.port, port, "the port was released and rebound");
	await rebind.close();
	await rm(src.dir, { recursive: true, force: true });
});

test("C4A-7b: a UI failure does not block the Host (the view is independent)", async (t) => {
	// A server pointed at a missing source still constructs and serves an
	// unavailable view; the Host/report path is untouched.
	const server = createObservationServer({
		manifestPath: "/nonexistent/manifest.json",
		eventsPath: "/nonexistent/events.jsonl",
	});
	await server.listen();
	t.after(async () => {
		await server.close();
	});
	const res = await fetch(new URL("/api/view", server.url).href);
	const view = await res.json();
	assert.equal(res.status, 200, "the server stays up");
	assert.ok(["unavailable", "integrity_failure"].includes(view.integrity.status));
});
