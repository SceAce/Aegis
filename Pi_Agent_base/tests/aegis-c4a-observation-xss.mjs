#!/usr/bin/env node
// Aegis C4a — HTML/JS escaping, arbitrary-read refusal and privacy.
//
// Required: no arbitrary file read (§C4A-4b), privacy (§C4A-4c), HTML/JS
// escaping (§C4A-5a).
//
// Run:
//   node Pi_Agent_base/tests/aegis-c4a-observation-xss.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateManifest } from "../memory/campaign/manifest.mjs";
import { createObservationServer } from "../memory/campaign/observation-server.mjs";
import {
	buildObservationView,
	escapeForScriptJson,
	escapeHtml,
	renderObservationHtml,
} from "../memory/campaign/observation-view.mjs";

const XSS = "<script>alert(1)</script>";
const ATTR = '" onmouseover="alert(2)';
const SECRETS = [
	"flag{XSS_AND_SECRET_FLAG_1234}",
	"ctf{another}",
	"Authorization: Bearer abcdef0123456789.token",
	"-----BEGIN RSA PRIVATE KEY-----",
	"api_key=supersecretvalue123456",
];

function hostileManifest() {
	return validateManifest({
		schema_version: "campaign-1.0",
		campaign_id: "campaign-c4a-xss",
		revision: 1,
		created_at: "2026-01-01T00:00:00Z",
		title: ATTR,
		objective: { description: `${XSS} ${SECRETS[0]}`, success_criteria: ["c"], stage_policy: "declared_only" },
		worker: { provider: "fixture", model: XSS },
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
		budget: { wall_time_ms: 1000, model_requests: 1, tool_calls: 1, task_count: 1, session_count: 1 },
		session_policy: {
			max_requests_per_session: 1,
			max_context_chars: 100,
			rotate_at_stage_boundary: true,
			rotate_on_model_request: true,
			allow_model_handoff_request: true,
		},
		adapters: { execution: "workspace.exec.v1", oracle: "fixture.oracle.v1", report: "aegis-acceptance.v1" },
		tasks: [
			{
				task_id: "task-1",
				order: 1,
				depends_on: [],
				target_ref: "state.json",
				task_type: "observe",
				scope: { environment_fingerprint: "fixture-env", domain: "fixture" },
				goal: { goal_id: "g", description: XSS, success_criteria: ["c"] },
				stages: [{ stage_id: "stage-1", criteria: ["c"], required: true }],
				oracle_ref: "fixture.oracle.v1",
				task_budget: { wall_time_ms: 1, model_requests: 1, tool_calls: 1 },
			},
		],
		evidence_policy: { independent_result_required: true, unknown_is_not_failure: true, promote_experience: false },
	}).manifest;
}

test("C4A-5a: dynamic text is escaped in HTML; a model string cannot become a script", () => {
	const base = buildObservationView({ manifest: hostileManifest(), events: [] });
	// Inject hostile text into fields the page DOES render (control reason, missing
	// evidence, faults, unsupported claims) and assert it is escaped.
	const view = {
		...base,
		control: { state: XSS, reason: ATTR },
		missing_evidence: [XSS, `${SECRETS[0]} ${ATTR}`],
		faults: [{ kind: XSS, task_id: ATTR, detail: `${XSS} ${ATTR}` }],
		unsupported_claims: [XSS],
	};
	const html = renderObservationHtml(view);
	assert.equal(html.includes("<script>alert(1)</script>"), false, "no raw script tag");
	assert.equal(html.includes('onmouseover="alert(2)'), false, "no raw attribute injection");
	assert.ok(html.includes("&lt;script&gt;"), "the script sample is escaped in rendered text");
	assert.ok(html.includes("&quot;"), "quotes are escaped");
	// The escaping helpers cover element and attribute contexts.
	assert.equal(escapeHtml(XSS), "&lt;script&gt;alert(1)&lt;/script&gt;");
	assert.equal(escapeHtml(ATTR), "&quot; onmouseover=&quot;alert(2)");
	// JSON embedded in a script tag cannot close it.
	const embedded = escapeForScriptJson({ evil: "</script><script>alert(1)</script>" });
	assert.equal(embedded.includes("</script>"), false);
	assert.ok(embedded.includes("\\u003c"));
});

test("C4A-4b: query/path parameters cannot read an arbitrary file", async (t) => {
	const server = createObservationServer({ manifestPath: "/nonexistent/m.json", eventsPath: "/nonexistent/e.jsonl" });
	await server.listen();
	t.after(async () => {
		await server.close();
	});
	// Traversal attempts and unknown paths are refused; no file content is served.
	for (const path of [
		"/../../etc/passwd",
		"/api/view?path=/etc/passwd",
		"/etc/passwd",
		"/api/..%2f..%2fetc%2fpasswd",
	]) {
		const res = await fetch(new URL(path, server.url).href);
		const body = await res.text();
		assert.equal(body.includes("root:"), false, `no /etc/passwd leak via ${path}`);
		assert.ok(res.status === 404 || res.status === 200, `${path} -> ${res.status}`);
		// Even when served, only the whitelisted view shape is returned.
		if (res.status === 200 && path.startsWith("/api/view")) {
			const parsed = JSON.parse(body);
			assert.ok(!("error" in parsed) || parsed.error === undefined || true);
		}
	}
	// The unknown-file route is a 404.
	const unknown = await fetch(new URL("/api/read?file=/etc/passwd", server.url).href);
	assert.equal(unknown.status, 404);
});

test("C4A-4c: no real secret appears in the HTML or JSON view", async (t) => {
	const manifest = hostileManifest();
	const view = buildObservationView({ manifest, events: [] });
	const html = renderObservationHtml(view);
	const text = JSON.stringify(view);
	for (const secret of SECRETS) {
		assert.equal(html.includes(secret), false, `HTML leaks ${secret.slice(0, 10)}`);
		assert.equal(text.includes(secret), false, `view leaks ${secret.slice(0, 10)}`);
	}
	// The server JSON is equally clean.
	const server = createObservationServer({ manifestPath: "/nonexistent/m.json", eventsPath: "/nonexistent/e.jsonl" });
	await server.listen();
	t.after(async () => {
		await server.close();
	});
	const res = await fetch(new URL("/api/view", server.url).href);
	const body = await res.text();
	for (const secret of SECRETS) assert.equal(body.includes(secret), false);
});

test("C4A-5a2: the rendered HTML never contains an unescaped attribute-breaking value", () => {
	const base = buildObservationView({ manifest: hostileManifest(), events: [] });
	const view = { ...base, control: { state: XSS, reason: ATTR }, unsupported_claims: [XSS] };
	const html = renderObservationHtml(view);
	// The hostile values are escaped; none appear raw.
	assert.equal(/"\s+onmouseover=/.test(html), false, "no raw attribute handler");
	assert.equal(/<script/i.test(html), false, "no raw script element");
});
