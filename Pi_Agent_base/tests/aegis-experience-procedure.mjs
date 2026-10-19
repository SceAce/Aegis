// Knowledge-type Experience: a reviewed procedure (`do.kind="procedure"`) can
// be active after the same two-proof gate as an action, but the Router may only
// hint it — a procedure has no registered implementation and must never go
// direct. Offline: no model, network, broker or credentials.
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileExperience } from "../memory/experience-compiler.mjs";
import { experienceHint, procedureFromCandidateEvent } from "../memory/learning-commands.mjs";
import { routeLearning } from "../memory/learning-router.mjs";

const SCOPE = {
	environment_fingerprint: "local",
	domain: "ctf-web",
	permissions: ["workspace"],
	task_types: ["ctf"],
};
const WHEN = [{ path: "env.kind", op: "eq", value: "ctf", verified_by: ["artifact-1"] }];
const EXPECT = [{ path: "flag.found", op: "eq", value: true }];
const candidateEvent = {
	event_id: "cand-1",
	event_type: "proposal.submitted",
	payload: {
		kind: "candidate",
		when: ["the target is a web CTF service", "input reaches SQL"],
		do: "Nested-keyword SQLi: identify the filter, split a blocked keyword into a replaced pair, extract rows with a boolean oracle.",
		expect: "a boolean oracle distinguishes true/false and row data is recoverable",
	},
};
const procedure = procedureFromCandidateEvent(candidateEvent).procedure;

function episode(n) {
	return {
		episode_id: `ep-${n}`,
		run_id: `run-${n}`,
		independence_group: `group-${n}`,
		isolation_ref: `iso-${n}`,
		scope: SCOPE,
		source_kind: "live",
	};
}
function outcome(n) {
	return {
		outcome_id: `o-${n}`,
		episode_id: `ep-${n}`,
		run_id: `run-${n}`,
		status: "success",
		observed: { flag: `flag-${n}` },
		oracle: { oracle_id: "platform", independence_group: `group-${n}`, isolation_ref: `iso-${n}` },
		criterion: { criterion_id: "flag", expected: true },
		preconditions_verified: true,
		evidence_refs: [{ ref_type: "artifact", ref_id: `artifact-${n}` }],
		when: WHEN,
		expect: EXPECT,
		scope: SCOPE,
		source_kind: "live",
	};
}
const episodes = { "ep-1": episode(1), "ep-2": episode(2) };
const outcomes = { "o-1": outcome(1), "o-2": outcome(2) };
function resolver({ kind, ref }) {
	if (kind === "outcome") return { ok: true, record: outcomes[ref.ref_id] };
	if (kind === "episode") return { ok: true, record: episodes[ref.ref_id] };
	if (kind === "artifact") return { ok: true, record: { ref_id: ref.ref_id } };
	if (kind === "replay")
		return {
			ok: true,
			record: {
				replayable: true,
				replay_count: 1,
				replay_hash: `hash-${ref.ref_id}`,
				episode_id: String(ref.ref_id).split(":")[1],
			},
		};
	return { ok: false, reason: `unexpected kind ${kind}` };
}
const proofs = [
	{ outcome_id: "o-1", do: procedure },
	{ outcome_id: "o-2", do: procedure },
];
function compile(overrides = {}) {
	return compileExperience({
		proofs,
		environment: { ...SCOPE, registry: null },
		resolveSupport: resolver,
		...overrides,
	});
}

test("a reviewed procedure with two independent proofs becomes active", () => {
	const r = compile();
	assert.equal(r.status, "active", JSON.stringify(r.failures));
	assert.equal(r.experience.do.kind, "procedure");
	assert.equal(r.experience.do.source_event_id, "cand-1");
	assert.equal(r.experience.do.text, candidateEvent.payload.do);
	assert.equal(r.experience.when.length, 1);
	assert.equal(r.experience.expect.length, 1);
});

test("one proof or a tampered digest stays candidate", () => {
	const one = compile({ proofs: proofs.slice(0, 1) });
	assert.equal(one.status, "candidate");
	assert.ok(one.failures.some((failure) => failure.rule === "min_proofs"));
	const tampered = compile({
		proofs: proofs.map((proof) => ({ ...proof, do: { ...procedure, digest: "sha256:tampered" } })),
	});
	assert.equal(tampered.status, "candidate");
	assert.ok(tampered.failures.some((failure) => failure.rule === "procedure_digest"));
});

test("the router hints a procedure and never goes direct", () => {
	const compiled = compile();
	const route = routeLearning({
		experiences: [compiled.experience],
		task: {},
		environment: SCOPE,
		currentState: { env: { kind: "ctf" } },
		registry: null,
		resolveSupport: resolver,
	});
	assert.equal(route.route, "hint", JSON.stringify(route.reason));
	assert.notEqual(route.route, "direct");
	assert.match(route.hint, /Nested-keyword SQLi/);
});

test("a hint decision becomes a bounded procedure hint", () => {
	const compiled = compile();
	const route = routeLearning({
		experiences: [compiled.experience],
		task: {},
		environment: SCOPE,
		currentState: { env: { kind: "ctf" } },
		registry: null,
		resolveSupport: resolver,
	});
	const hint = experienceHint(route);
	assert.ok(hint);
	assert.equal(hint.experience_id, compiled.experience.experience_id);
	assert.match(hint.text, /Nested-keyword SQLi/);
	assert.equal(experienceHint({ route: "deliberate" }), null);
});

test("only a candidate proposal can supply a procedure", () => {
	const claim = { ...candidateEvent, payload: { ...candidateEvent.payload, kind: "claim" } };
	const r = procedureFromCandidateEvent(claim);
	assert.equal(r.ok, false);
	assert.match(r.reason, /candidate/);
	const noExpect = procedureFromCandidateEvent({
		...candidateEvent,
		payload: { ...candidateEvent.payload, expect: "" },
	});
	assert.equal(noExpect.ok, false);
});
