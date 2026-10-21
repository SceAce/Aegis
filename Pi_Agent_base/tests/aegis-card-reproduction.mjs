// Reproduction evidence must be checked against the REAL script registry.
//
// A `reproduction` card pins `script:<id>@<version>` plus the implementation
// digest. The executable, argv, parameter schema and Oracle live in the
// human-registered registry (execution/script-registry.mjs); a card never
// carries code. This test builds a genuinely valid registration on disk and
// drives the real parser, registry and matcher together.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isInjectable, parseCard, reproductionProblem, scriptDigestResolver } from "../contest/card-schema.mjs";
import { createScriptRegistry, executableDigest } from "../execution/script-registry.mjs";

const SCRIPT_BODY = 'console.log("technique ran");\n';

function makeRegistry() {
	const base = mkdtempSync(join(tmpdir(), "aegis-repro-"));
	const workspace = join(base, "workspace");
	mkdirSync(workspace, { recursive: true });
	const scriptPath = join(base, "solve.mjs");
	writeFileSync(scriptPath, SCRIPT_BODY);
	const registration = {
		schema_version: "1.0",
		id: "common-modulus",
		version: 1,
		executable: process.execPath,
		executable_digest: executableDigest(process.execPath),
		script_path: scriptPath,
		script_digest: executableDigest(scriptPath),
		argv_template: [scriptPath],
		allowed_root: workspace,
		cwd: workspace,
		parameters: {},
		verify: () => ({ ok: true }),
	};
	const registry = createScriptRegistry({ scripts: [registration] });
	return {
		base,
		registry,
		scriptDigest: registration.script_digest,
		cleanup: () => rmSync(base, { recursive: true, force: true }),
	};
}

function card(id, refs, digest) {
	return {
		schema_version: "2.0",
		id,
		revision: "1",
		title: "reproduction card",
		curation: "reviewed",
		evidence: { kind: "reproduction", refs, implementation_digest: digest },
		scope: { task_category: "crypto", environment: "any" },
		triggers: ["rsa"],
		hint: ["run the registered solver"],
	};
}

test("a reproduction card validates against the real registry digest", () => {
	const env = makeRegistry();
	try {
		const parsed = parseCard(card("repro-ok", ["script:common-modulus@1"], env.scriptDigest));
		assert.equal(parsed.ok, true, parsed.reason);

		const resolver = scriptDigestResolver(env.registry);
		assert.equal(resolver("common-modulus", 1), env.scriptDigest);
		assert.equal(resolver("common-modulus", 2), null, "an unregistered version has no digest");
		assert.equal(resolver("nope", 1), null);

		assert.equal(isInjectable(parsed.card, { scriptDigests: resolver }), true);
	} finally {
		env.cleanup();
	}
});

test("the digest pins the script body: a changed script stops matching", () => {
	const env = makeRegistry();
	try {
		const parsed = parseCard(card("repro-pin", ["script:common-modulus@1"], env.scriptDigest));
		assert.equal(parsed.ok, true, parsed.reason);

		// Re-register with a different body; the old card digest no longer matches.
		const base2 = mkdtempSync(join(tmpdir(), "aegis-repro2-"));
		try {
			const workspace = join(base2, "workspace");
			mkdirSync(workspace, { recursive: true });
			const scriptPath = join(base2, "solve.mjs");
			writeFileSync(scriptPath, `${SCRIPT_BODY}// changed\n`);
			const registry = createScriptRegistry({
				scripts: [
					{
						schema_version: "1.0",
						id: "common-modulus",
						version: 1,
						executable: process.execPath,
						executable_digest: executableDigest(process.execPath),
						script_path: scriptPath,
						script_digest: executableDigest(scriptPath),
						argv_template: [scriptPath],
						allowed_root: workspace,
						cwd: workspace,
						parameters: {},
						verify: () => ({ ok: true }),
					},
				],
			});
			assert.equal(isInjectable(parsed.card, { scriptDigests: scriptDigestResolver(registry) }), false);
		} finally {
			rmSync(base2, { recursive: true, force: true });
		}
	} finally {
		env.cleanup();
	}
});

test("a reproduction card without a registry is not injectable (fail closed)", () => {
	const parsed = parseCard(card("repro-noreg", ["script:common-modulus@1"], `sha256:${"a".repeat(64)}`));
	assert.equal(parsed.ok, true, parsed.reason);
	assert.equal(isInjectable(parsed.card), false);
	assert.equal(isInjectable(parsed.card, { scriptDigests: null }), false);
});

test("a version mismatch is rejected even when the digest matches", () => {
	const env = makeRegistry();
	try {
		const parsed = parseCard(card("repro-ver", ["script:common-modulus@2"], env.scriptDigest));
		assert.equal(parsed.ok, true, parsed.reason);
		assert.equal(
			isInjectable(parsed.card, { scriptDigests: scriptDigestResolver(env.registry) }),
			false,
			"v2 of the script is not registered",
		);
	} finally {
		env.cleanup();
	}
});

test("a reproduction ref without a version is refused at parse time", () => {
	const parsed = parseCard(card("repro-nover", ["script:common-modulus"], `sha256:${"a".repeat(64)}`));
	assert.equal(parsed.ok, false);
	assert.match(parsed.reason, /script:<id>@<version>/);
});

test("document cards stay injectable with or without a registry", () => {
	const documentCard = parseCard({
		...card("doc-ok", [], undefined),
		evidence: { kind: "document", refs: ["ctf-wiki:x"] },
	}).card;
	assert.equal(isInjectable(documentCard), true);
	assert.equal(isInjectable(documentCard, { scriptDigests: () => null }), true);
});

test("an invalid registration is refused by the registry, not silently accepted", () => {
	assert.throws(
		() => createScriptRegistry({ scripts: [{ schema_version: "1.0", id: "bad", version: 1 }] }),
		/refusing invalid script registration bad/,
	);
});

test("reproductionProblem names the exact reason a card is unusable", () => {
	const env = makeRegistry();
	try {
		const resolver = scriptDigestResolver(env.registry);
		const ok = parseCard(card("p-ok", ["script:common-modulus@1"], env.scriptDigest)).card;
		assert.equal(reproductionProblem(ok, resolver), null);

		const noRegistry = parseCard(card("p-noreg", ["script:common-modulus@1"], env.scriptDigest)).card;
		assert.match(reproductionProblem(noRegistry, null), /no script registry configured/);

		const unregistered = parseCard(card("p-unreg", ["script:other@1"], env.scriptDigest)).card;
		assert.match(reproductionProblem(unregistered, resolver), /script:other@1 is not registered/);

		const stale = parseCard(card("p-stale", ["script:common-modulus@1"], `sha256:${"0".repeat(64)}`)).card;
		assert.match(reproductionProblem(stale, resolver), /does not match the registered/);

		const noDigest = parseCard({
			...card("p-nodigest", ["script:common-modulus@1"], env.scriptDigest),
			evidence: { kind: "reproduction", refs: ["script:common-modulus@1"] },
		});
		// parse-level: the digest is mandatory, so this never becomes a card.
		assert.equal(noDigest.ok, false);
	} finally {
		env.cleanup();
	}
});

test("a non-reproduction card has no reproduction problem", () => {
	const documentCard = parseCard({
		...card("doc", [], undefined),
		evidence: { kind: "document", refs: ["ctf-wiki:x"] },
	}).card;
	assert.equal(reproductionProblem(documentCard, null), null);
});
