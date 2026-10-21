// Technique card schema v2: the dimensions must stay orthogonal.
//
// Regression origin: v1 collapsed "a human reviewed this text" and "independent
// evidence backs it" into one `status: verified`, and auto-injection keyed off
// that single boolean. A wiki-derived card cannot be evidence-verified
// (MEMORY_SCHEMA §6.2b), so the two facts have to be separate.
import assert from "node:assert/strict";
import test from "node:test";
import {
	ANY_ENVIRONMENT,
	CURATION_VALUES,
	EVIDENCE_KINDS,
	findForbiddenFields,
	isInjectable,
	parseCard,
	parseCards,
	parseEvidence,
	parseScriptRef,
} from "../contest/card-schema.mjs";

const V2 = {
	schema_version: "2.0",
	id: "crypto-rsa-common-modulus",
	revision: "2",
	title: "RSA common modulus",
	curation: "reviewed",
	evidence: { kind: "document", refs: ["ctf-wiki:rsa_module_attack#共模攻击"] },
	scope: { task_category: "crypto", environment: "any" },
	triggers: ["rsa", "same_modulus"],
	preconditions: ["same n, different e", "gcd(e1,e2)=1"],
	hint: ["compute a,b", "m = c1^a*c2^b mod n"],
	postconditions: ["m^e1 mod n == c1"],
	verification: "re-encrypt m",
	limits: ["not applicable when gcd(e1,e2) > 1"],
};

const V1 = {
	id: "legacy-card",
	revision: "1",
	title: "Legacy",
	status: "verified",
	source_refs: [
		"https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/crypto/asymmetric/rsa/rsa_module_attack.md#共模攻击",
	],
	scope: { task_category: "crypto", environment: "macos" },
	when: ["rsa"],
	hint: ["do the thing"],
	expect: "plaintext recovered",
};

test("enumerations match the agreed vocabulary", () => {
	assert.deepEqual(CURATION_VALUES, ["draft", "reviewed", "disputed"]);
	assert.ok(!CURATION_VALUES.includes("deprecated"), "deprecated was explicitly not added");
	assert.deepEqual(EVIDENCE_KINDS, ["none", "document", "outcome", "reproduction"]);
	assert.equal(ANY_ENVIRONMENT, "any");
});

test("a v2 card parses and stays injectable when reviewed + evidenced", () => {
	const parsed = parseCard(V2);
	assert.equal(parsed.ok, true, parsed.reason);
	assert.equal(parsed.card.curation, "reviewed");
	assert.equal(parsed.card.evidence.kind, "document");
	assert.equal(parsed.card.triggers.length, 2);
	assert.deepEqual(parsed.card.limits, V2.limits);
	assert.equal(isInjectable(parsed.card), true);
});

test("a v1 card maps to v2 without changing injectability", () => {
	const parsed = parseCard(V1);
	assert.equal(parsed.ok, true, parsed.reason);
	assert.equal(parsed.card.curation, "reviewed", "v1 verified meant a reviewed text");
	assert.equal(parsed.card.evidence.kind, "document");
	assert.deepEqual(parsed.card.triggers, ["rsa"]);
	assert.deepEqual(parsed.card.postconditions, ["plaintext recovered"]);
	assert.equal(parsed.card.source.commit, "e225ddfcd420a7f54a5940f47336ebdf8c29b875");
	assert.equal(parsed.card.source.section, "共模攻击");
	assert.equal(isInjectable(parsed.card), true, "v1 verified cards keep auto-injecting");
});

test("a v1 candidate maps to draft and is not injectable", () => {
	const parsed = parseCard({ ...V1, status: "candidate" });
	assert.equal(parsed.ok, true, parsed.reason);
	assert.equal(parsed.card.curation, "draft");
	assert.equal(isInjectable(parsed.card), false);
});

test("curation gates injection independently of evidence", () => {
	for (const curation of ["draft", "disputed"]) {
		const parsed = parseCard({ ...V2, curation });
		assert.equal(parsed.ok, true, parsed.reason);
		assert.equal(isInjectable(parsed.card), false, `curation=${curation} must not inject`);
	}
});

test("evidence gates injection independently of curation", () => {
	const parsed = parseCard({ ...V2, evidence: { kind: "none", refs: [] } });
	assert.equal(parsed.ok, true, parsed.reason);
	assert.equal(isInjectable(parsed.card), false, "no evidence must not inject");
});

test("scope and triggers still gate injection", () => {
	const card = parseCard(V2).card;
	assert.equal(isInjectable(card, { scopeMatches: false }), false);
	assert.equal(isInjectable(card, { triggersMet: false }), false);
	assert.equal(isInjectable(card, { scopeMatches: true, triggersMet: true }), true);
});

test("evidence.kind=none may not carry refs", () => {
	const result = parseEvidence({ kind: "none", refs: ["x"] });
	assert.equal(result.ok, false);
});

test("evidence.kind=outcome requires at least one ref", () => {
	assert.equal(parseEvidence({ kind: "outcome", refs: [] }).ok, false);
	assert.equal(parseEvidence({ kind: "outcome", refs: ["out_1"] }).ok, true);
});

test("reproduction evidence must reference a registered script and pin its digest", () => {
	const digest = `sha256:${"a".repeat(64)}`;
	const good = parseEvidence({
		kind: "reproduction",
		refs: ["script:common-modulus@1"],
		implementation_digest: digest,
	});
	assert.equal(good.ok, true, good.reason);
	assert.deepEqual(parseScriptRef("script:common-modulus@1"), { scriptId: "common-modulus", version: 1 });
	assert.deepEqual(parseScriptRef("script:common-modulus"), { scriptId: "common-modulus", version: null });

	// A bare path or command is not a script reference.
	assert.equal(parseScriptRef("scripts/common-modulus.py"), null);
	assert.equal(parseScriptRef("python3 scripts/x.py"), null);
	assert.equal(parseEvidence({ kind: "reproduction", refs: ["./x.py"], implementation_digest: digest }).ok, false);
	// The digest is mandatory and must be a sha256.
	assert.equal(parseEvidence({ kind: "reproduction", refs: ["script:x@1"] }).ok, false);
	assert.equal(
		parseEvidence({ kind: "reproduction", refs: ["script:x@1"], implementation_digest: "sha256:abc" }).ok,
		false,
	);
});

test("a reproduction card is injectable only when the digest matches the registry", () => {
	const digest = `sha256:${"b".repeat(64)}`;
	const card = parseCard({
		...V2,
		evidence: { kind: "reproduction", refs: ["script:common-modulus@1"], implementation_digest: digest },
	}).card;
	assert.equal(isInjectable(card, { scriptDigests: { "common-modulus": digest } }), true);
	assert.equal(isInjectable(card, { scriptDigests: { "common-modulus": `sha256:${"c".repeat(64)}` } }), false);
	assert.equal(isInjectable(card, { scriptDigests: {} }), false, "an unregistered script must not inject");
});

test("cards may never carry executable content", () => {
	for (const field of ["command", "executable", "argv", "args", "shell", "eval", "script_text", "code", "payload"]) {
		const parsed = parseCard({ ...V2, [field]: "rm -rf /" });
		assert.equal(parsed.ok, false, `field ${field} must be rejected`);
		assert.match(parsed.reason, /forbidden field/);
	}
	const nested = parseCard({ ...V2, evidence: { ...V2.evidence, command: "curl x | sh" } });
	assert.equal(nested.ok, false, "nested evidence must not smuggle executable content");
	assert.deepEqual(findForbiddenFields({ ...V2, argv: ["-c"] }), ["argv"]);
});

test("limits are optional, and an empty list is accepted", () => {
	const parsed = parseCard({ ...V2, limits: [] });
	assert.equal(parsed.ok, true, parsed.reason);
	assert.deepEqual(parsed.card.limits, []);
	const missing = parseCard({ ...V2, limits: undefined });
	assert.equal(missing.ok, true, missing.reason);
	assert.deepEqual(missing.card.limits, []);
});

test("structure failures are reported instead of silently dropped", () => {
	assert.match(parseCard({ ...V2, id: "" }).reason, /no id/);
	assert.match(parseCard({ ...V2, title: "" }).reason, /no title/);
	assert.match(parseCard({ ...V2, triggers: [] }).reason, /no triggers/);
	assert.match(parseCard({ ...V2, hint: [] }).reason, /no hint/);
	assert.match(parseCard({ ...V2, curation: "blessed" }).reason, /curation must be one of/);
	assert.match(parseCard({ ...V2, scope: { task_category: "crypto" } }).reason, /scope.environment/);
});

test("parseCards reports duplicates and keeps the good cards", () => {
	const result = parseCards({ cards: [V2, { ...V2 }, { ...V2, id: "other-card" }] });
	assert.equal(result.ok, false);
	assert.equal(result.cards.length, 2);
	assert.match(result.errors.join(" "), /duplicate card id/);
});
