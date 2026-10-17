// WEB-01 W1 — independent platform-result binding and SDK tool shape.
//
// No platform, no model, no external target: these are pure functions over
// data-only inputs. A model claim can never produce `accepted`, and a result
// bound to another instance/task/criterion is rejected even when trusted.

import assert from "node:assert/strict";
import test from "node:test";

const OUTCOME = new URL("../verification/web-outcome.mjs", import.meta.url);
const TOOLS = new URL("../execution/web-tools.mjs", import.meta.url);

async function loadOutcome() {
	return import(OUTCOME);
}

async function loadTools() {
	return import(TOOLS);
}

const BINDING = {
	platform: "ctfshow",
	challenge_id: "web-42",
	instance_id: "inst-7",
	instance_revision: 3,
	campaign_id: "campaign-1",
	task_id: "task-1",
	episode_id: "episode-1",
	criterion_id: "flag",
	subject_ref: "subject:web-42",
};

function candidate(overrides = {}) {
	return {
		candidate_id: "cand-1",
		candidate: "flag{example}",
		evidence_refs: [{ ref_id: "artifact:web-1", digest: "sha256:" + "b".repeat(64) }],
		source: { kind: "model", actor_id: "model-worker" },
		claimed_success: false,
		binding: { ...BINDING },
		...overrides,
	};
}

function platformResult(overrides = {}) {
	return {
		platform: "ctfshow",
		challenge_id: "web-42",
		instance_id: "inst-7",
		instance_revision: 3,
		status: "accepted",
		source: { kind: "platform", trusted: true, reference: "submission:9f3a" },
		...overrides,
	};
}

test("WT-11-A: a model claim is never an outcome", async () => {
	const { resolveWebCriterion } = await loadOutcome();
	const modelClaim = platformResult({ source: { kind: "model", trusted: true, reference: "model says ok" } });
	const resolved = resolveWebCriterion({ candidate: candidate(), result: modelClaim, binding: BINDING });
	assert.equal(resolved.status, "rejected");
	assert.equal(resolved.outcome_payload, null);
	assert.match(resolved.reasons.join(";"), /source/i);

	// A claimed_success on the candidate alone changes nothing either.
	const selfClaim = resolveWebCriterion({
		candidate: candidate({ claimed_success: true }),
		result: null,
		binding: BINDING,
	});
	assert.equal(selfClaim.status, "unknown");
	assert.equal(selfClaim.outcome_payload, null);

	// A runtime wrapper is also untrusted.
	const runtimeWrap = platformResult({ source: { kind: "runtime", trusted: true, reference: "runtime note" } });
	assert.equal(
		resolveWebCriterion({ candidate: candidate(), result: runtimeWrap, binding: BINDING }).status,
		"rejected",
	);
});

test("WT-11-B: foreign bindings are rejected per field", async () => {
	const { resolveWebCriterion } = await loadOutcome();
	const mutations = [
		["instance_id", { instance_id: "inst-8" }],
		["instance_revision", { instance_revision: 4 }],
		["task_id", { task_id: "task-2" }],
		["criterion_id", { criterion_id: "other" }],
		["challenge_id", { challenge_id: "web-43" }],
		["platform", { platform: "buuctf" }],
	];
	for (const [label, patch] of mutations) {
		const resolved = resolveWebCriterion({
			candidate: candidate(),
			result: platformResult(patch),
			binding: BINDING,
		});
		assert.equal(resolved.status, "rejected", label);
		assert.match(resolved.reasons.join(";"), new RegExp(label.split("_")[0], "i"), label);
	}
	// A candidate bound to a different episode is not the current candidate.
	const otherEpisode = candidate({ binding: { ...BINDING, episode_id: "episode-9" } });
	const resolved = resolveWebCriterion({ candidate: otherEpisode, result: platformResult(), binding: BINDING });
	assert.equal(resolved.status, "rejected");
	assert.match(resolved.reasons.join(";"), /episode_id/);
});

test("WT-11-C: a fully bound trusted acceptance produces a data-only payload", async () => {
	const { resolveWebCriterion } = await loadOutcome();
	const resolved = resolveWebCriterion({ candidate: candidate(), result: platformResult(), binding: BINDING });
	assert.equal(resolved.status, "accepted");
	assert.equal(resolved.reasons.length, 0);
	assert.ok(resolved.outcome_payload);
	assert.equal(resolved.outcome_payload.status, "success");
	assert.equal(resolved.outcome_payload.criterion_id, "flag");
	assert.equal(resolved.outcome_payload.task_id, "task-1");
	assert.equal(resolved.outcome_payload.episode_id, "episode-1");
	assert.equal(resolved.outcome_payload.subject_ref, "subject:web-42");
	assert.deepEqual(resolved.outcome_payload.evidence_refs, candidate().evidence_refs);
	assert.equal(resolved.outcome_payload.source.kind, "platform");
	// It is data-only: no functions survive serialization.
	assert.deepEqual(JSON.parse(JSON.stringify(resolved.outcome_payload)), resolved.outcome_payload);
});

test("WT-11-D: a platform rejection fails only this candidate", async () => {
	const { resolveWebCriterion } = await loadOutcome();
	const resolved = resolveWebCriterion({
		candidate: candidate(),
		result: platformResult({ status: "rejected" }),
		binding: BINDING,
	});
	assert.equal(resolved.status, "rejected");
	assert.equal(resolved.outcome_payload, null, "a wrong candidate must not end the campaign");
	// Still pending: the platform has not answered yet.
	const pending = resolveWebCriterion({ candidate: candidate(), result: null, binding: BINDING });
	assert.equal(pending.status, "unknown");
	assert.equal(pending.outcome_payload, null);
});

test("WT-11-E: candidates without resolvable evidence are invalid", async () => {
	const { validateFlagCandidate } = await loadOutcome();
	const base = candidate();
	assert.equal(validateFlagCandidate(base).ok, true, JSON.stringify(validateFlagCandidate(base).reasons));
	for (const bad of [
		candidate({ evidence_refs: [] }),
		candidate({ evidence_refs: "artifact:web-1" }),
		candidate({ evidence_refs: [{ ref_id: "artifact:web-1" }] }),
		candidate({ evidence_refs: [{ ref_id: "", digest: "sha256:" + "b".repeat(64) }] }),
		candidate({ candidate: "" }),
		candidate({ candidate: 42 }),
		candidate({ candidate_id: "" }),
		candidate({ claimed_success: "yes" }),
		{},
		null,
	]) {
		const result = validateFlagCandidate(bad);
		assert.equal(result.ok, false, JSON.stringify(bad));
	}
});

test("WT-11-F: bindings require every identity field including instance_revision", async () => {
	const { validatePlatformResult, bindPlatformResult } = await loadOutcome();
	const complete = platformResult();
	assert.equal(validatePlatformResult(complete).ok, true, JSON.stringify(validatePlatformResult(complete).reasons));
	const missingRevision = { ...complete };
	delete missingRevision.instance_revision;
	const bound = bindPlatformResult({ candidate: candidate(), result: missingRevision, binding: BINDING });
	assert.equal(bound.ok, false);
	assert.match(bound.reasons.join(";"), /instance_revision/);

	// Out-of-range / wrong-typed identities are refused, not coerced.
	for (const bad of [
		platformResult({ instance_revision: "3" }),
		platformResult({ instance_revision: -1 }),
		platformResult({ instance_id: "" }),
		platformResult({ status: "maybe" }),
		platformResult({ source: { kind: "platform", trusted: false, reference: "x" } }),
		platformResult({ source: { kind: "platform", trusted: true, reference: "" } }),
	]) {
		assert.equal(validatePlatformResult(bad).ok, false, JSON.stringify(bad));
	}
});

test("WT-11-G: object key order does not change the binding decision", async () => {
	const { resolveWebCriterion } = await loadOutcome();
	const reorderedBinding = {
		subject_ref: BINDING.subject_ref,
		criterion_id: BINDING.criterion_id,
		episode_id: BINDING.episode_id,
		task_id: BINDING.task_id,
		campaign_id: BINDING.campaign_id,
		instance_revision: BINDING.instance_revision,
		instance_id: BINDING.instance_id,
		challenge_id: BINDING.challenge_id,
		platform: BINDING.platform,
	};
	const resolved = resolveWebCriterion({
		candidate: candidate(),
		result: platformResult(),
		binding: reorderedBinding,
	});
	assert.equal(resolved.status, "accepted");
});

test("WT-06-A: the tool schema is data-only, bounded and free of secrets", async () => {
	const { describeWebHttpTool, WEB_HTTP_TOOL_NAME, assessToolEffect } = await loadTools();
	const schema = describeWebHttpTool();
	assert.equal(WEB_HTTP_TOOL_NAME, "aegis_http_request");
	assert.equal(schema.name, WEB_HTTP_TOOL_NAME);
	assert.equal(schema.effects_network, true);
	const text = JSON.stringify(schema).toLowerCase();
	for (const forbidden of ["api_key", "apikey", "password", "token", "secret", "cookie_value"]) {
		assert.equal(text.includes(forbidden), false, `schema leaks ${forbidden}`);
	}
	assert.ok(schema.description.length > 0);
	// The description must not promise that a 200 is success.
	assert.equal(/success when/i.test(schema.description), false);
	// Effect classification is explicit and data-only.
	assert.equal(assessToolEffect({ name: "aegis_http_request", args: {} }).effects_network, true);
	assert.equal(assessToolEffect({ name: "aegis_response_read", args: {} }).effects_network, false);
	assert.equal(assessToolEffect({ name: "unknown_tool", args: {} }).ok, false);
});

test("WT-06-B: the synchronous tool returns an SDK-shaped, bounded result", async () => {
	const { createSynchronousWebTool } = await loadTools();
	const calls = [];
	const fakeAdapter = {
		execute: async (input) => {
			calls.push(input);
			return {
				transport_status: "received",
				status_code: 200,
				headers: [["content-type", "text/html"]],
				body_preview: "<html>" + "x".repeat(5000),
				body_base64: null,
				body_ref: "artifact:web-1",
				body_digest: "sha256:" + "c".repeat(64),
				bytes_received: 5009,
				truncated: false,
				compressed: false,
				session_id: "s1",
				cookie_summary: { count: 0, digest: "sha256:" + "d".repeat(64) },
				attempts: 1,
				requested: { method: "GET", path_query: "/", header_names: [], body_bytes: 0 },
				identity: input.identity,
				error_code: null,
				error_detail: null,
				charge_id: "charge-1",
				intent_ref: "intent-1",
				reused: false,
				outcome_candidate: null,
			};
		},
	};
	const tool = createSynchronousWebTool({
		adapter: fakeAdapter,
		identityFor: (ctx) => ({
			campaign_id: ctx.campaign_id,
			task_id: ctx.task_id,
			episode_id: ctx.episode_id,
			request_id: ctx.request_id,
			tool_call_id: ctx.tool_call_id,
			unit_id: ctx.unit_id,
		}),
	});
	assert.equal(tool.name, "aegis_http_request");
	const result = await tool.handler({
		args: { target_id: "web-local", method: "GET", path_query: "/", headers: [], body: null, session_id: null },
		context: {
			campaign_id: "c",
			task_id: "t",
			episode_id: "e",
			request_id: "r",
			tool_call_id: "tc",
			unit_id: "u",
		},
	});
	assert.equal(Array.isArray(result.content), true);
	assert.equal(result.content[0].type, "text");
	assert.ok(result.content[0].text.length <= 2048, `tool text must stay bounded, got ${result.content[0].text.length}`);
	assert.equal(result.details.transport_status, "received");
	assert.equal(calls.length, 1);
	assert.match(calls[0].identity.arguments_digest, /^sha256:[0-9a-f]{64}$/);
	// The tool never invents an outcome.
	assert.equal(result.details.outcome_candidate, null);
	assert.equal(result.is_error ?? false, false);

	// Missing execution context is refused before any adapter call.
	const before = calls.length;
	const noContext = await tool.handler({
		args: { target_id: "web-local", method: "GET", path_query: "/", headers: [], body: null, session_id: null },
		context: {},
	});
	assert.equal(noContext.is_error, true);
	assert.equal(calls.length, before);
});

test("WT-06-C: the tool reports transport unknown without claiming failure", async () => {
	const { createSynchronousWebTool } = await loadTools();
	const tool = createSynchronousWebTool({
		adapter: {
			execute: async (input) => ({
				transport_status: "unknown",
				status_code: null,
				headers: [],
				body_preview: "",
				body_base64: null,
				body_ref: null,
				body_digest: null,
				bytes_received: 0,
				truncated: false,
				compressed: false,
				session_id: null,
				cookie_summary: { count: 0, digest: "" },
				attempts: 1,
				requested: null,
				identity: input.identity,
				error_code: "timeout",
				error_detail: "no response within 10ms",
				charge_id: "charge-1",
				intent_ref: "intent-1",
				reused: false,
				outcome_candidate: null,
			}),
		},
		identityFor: (ctx) => ctx,
	});
	const result = await tool.handler({
		args: { target_id: "web-local", method: "GET", path_query: "/", headers: [], body: null, session_id: null },
		context: {
			campaign_id: "c",
			task_id: "t",
			episode_id: "e",
			request_id: "r",
			tool_call_id: "tc",
			unit_id: "u",
		},
	});
	assert.equal(result.details.transport_status, "unknown");
	assert.match(result.content[0].text, /timeout/);
	assert.equal(/flag|success/i.test(result.content[0].text), false);
});
