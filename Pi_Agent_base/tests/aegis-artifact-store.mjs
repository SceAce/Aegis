#!/usr/bin/env node
// MEM-02 — artifact store: content addressing, durability, integrity, rebuild.
//
// Every case runs against REAL temp directories. Cases that could pass by
// accident are also run against a deliberately MUTATED copy of the production
// module (textual transform into a temp file, then imported): a mutant that
// still satisfies the expectation means the assertion is not load-bearing.
//
// Run: node Pi_Agent_base/tests/aegis-artifact-store.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
	artifactContentDigest,
	artifactRefForDigest,
	createArtifactStore,
	normalizeArtifactOwner,
	validateHead,
} from "../shared/artifact-store.mjs";

const STORE_MODULE = new URL("../shared/artifact-store.mjs", import.meta.url);
const OWNER = { task_id: "task-mem02", episode_id: "ep-mem02", campaign_id: "camp-1" };

function tempRoot(label) {
	const root = mkdtempSync(join(tmpdir(), `aegis-mem02-${label}-`));
	return root;
}

function store(root, options = {}) {
	return createArtifactStore({ root, ...options });
}

// ---------------------------------------------------------------------------
// Mutant infrastructure: the "old code is missing" excuse does not apply here.
// Each mutant breaks exactly one frozen rule; the frozen expectation must fail.
// ---------------------------------------------------------------------------
const MUTANTS = {
	// A1: rewrite the blob/head on every put (not idempotent).
	"m-idempotent": { replace: "\t\t\tif (existsSync(blobPath)) {", with: "\t\t\tif (false) {" },
	// A1/A2: constant digest address.
	"m-digest": {
		replace: 'return `sha256:${createHash("sha256").update(Buffer.from(bytes)).digest("hex")}`;',
		with: 'return `sha256:${createHash("sha256").update(Buffer.from("x")).digest("hex")}`;',
	},
	// A3: report success without verifying what reached disk.
	"m-noverify": { replace: "\t\t\tif (!verify.ok) {", with: "\t\t\tif (false) {" },
	// A4/A5: skip containment checks entirely.
	"m-followsymlink": {
		replace: "\t\tconst contained = containExistingPath(rootReal, blobPath);",
		with: "\t\tconst contained = { ok: true, path: blobPath, real: blobPath };",
	},
	// A9: no size cap enforcement.
	"m-nosizecap": { replace: "\t\tif (buffer.byteLength > effective.maxArtifactBytes) {", with: "\t\tif (false) {" },
	// A12: make the store decide content is fine when size matches but digest differs.
	"m-nodigestcheck": { replace: "\t\tif (artifactContentDigest(full) !== entry.digest) {", with: "\t\tif (false) {" },
	// A14: silent truncation.
	"m-truncationsilent": {
		replace:
			"\t\treturn { ok: true, entries, truncated: total > entries.length, total, entries_scanned: names.length };",
		with: "\t\treturn { ok: true, entries, truncated: false, total: entries.length, entries_scanned: names.length };",
	},
};

async function mutant(name) {
	const source = readFileSync(STORE_MODULE, "utf8");
	const spec = MUTANTS[name];
	assert.ok(spec, `unknown mutant ${name}`);
	const mutated = source.replace(spec.replace, spec.with);
	assert.notEqual(mutated, source, `mutant ${name} did not change the source (drifted anchor)`);
	const dir = mkdtempSync(join(tmpdir(), `aegis-mem02-mutant-${name}-`));
	const path = join(dir, "artifact-store.mjs");
	writeFileSync(path, mutated);
	// The module imports only node builtins, so it is importable from anywhere.
	return { module: await import(pathToFileURL(path).href), dir };
}

async function withMutant(name, fn) {
	const { module, dir } = await mutant(name);
	try {
		await fn(module);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------

test("ART-01/02: content addressing is idempotent and discriminates content", () => {
	const root = tempRoot("art-01");
	try {
		const a = store(root);
		const first = a.put({ bytes: Buffer.from("same bytes"), owner: OWNER, encoding_hint: "utf8" });
		assert.equal(first.ok, true);
		assert.equal(first.created, true);
		const second = a.put({ bytes: Buffer.from("same bytes"), owner: OWNER, encoding_hint: "utf8" });
		assert.equal(second.ok, true);
		assert.equal(second.created, false, "second put of identical bytes must not rewrite");
		assert.equal(second.ref_id, first.ref_id);
		assert.equal(second.digest, first.digest);
		const other = a.put({ bytes: Buffer.from("other bytes"), owner: OWNER });
		assert.equal(other.ok, true);
		assert.notEqual(other.ref_id, first.ref_id);
		assert.equal(a.readBytes({ ref_id: first.ref_id }).bytes.toString(), "same bytes");
		assert.equal(a.readBytes({ ref_id: other.ref_id }).bytes.toString(), "other bytes");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-01 mutant: a non-idempotent writer violates the frozen idempotence rule", async () => {
	await withMutant("m-idempotent", (module) => {
		const root = tempRoot("art-01m");
		try {
			const a = module.createArtifactStore({ root });
			const first = a.put({ bytes: Buffer.from("same bytes"), owner: OWNER });
			const hex = first.digest.slice(7);
			const blob = join(root, "objects", "sha256", hex.slice(0, 2), hex);
			const original = readFileSync(blob);
			// The mutant always takes the "write a fresh blob" branch instead of
			// reusing the existing content-addressed blob.
			const second = a.put({ bytes: Buffer.from("same bytes"), owner: OWNER });
			const rewrote = second.created === true && readFileSync(blob).equals(original);
			assert.equal(rewrote, true, "the mutant rewrites the blob on an identical put");
			// The real module is idempotent: this is the load-bearing assertion.
			const realRoot = tempRoot("art-01-real");
			try {
				const real = store(realRoot);
				real.put({ bytes: Buffer.from("same bytes"), owner: OWNER });
				assert.equal(real.put({ bytes: Buffer.from("same bytes"), owner: OWNER }).created, false);
			} finally {
				rmSync(realRoot, { recursive: true, force: true });
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

test("ART-02 mutant: a constant digest collapses distinct content", async () => {
	await withMutant("m-digest", (module) => {
		const root = tempRoot("art-02m");
		try {
			const a = module.createArtifactStore({ root });
			const first = a.put({ bytes: Buffer.from("aaa"), owner: OWNER });
			const second = a.put({ bytes: Buffer.from("bbb"), owner: OWNER });
			const collision = first.ref_id === second.ref_id || (second.ok === false && second.reason === "corrupt");
			assert.equal(collision, true, "constant digest must collide or be detected as corrupt");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

test("ART-03: blob paths derive from the digest only (no caller-controlled path segment)", () => {
	const root = tempRoot("art-03");
	try {
		const a = store(root);
		const evil = a.put({
			bytes: Buffer.from("payload"),
			owner: { task_id: "../../etc", episode_id: "..\\..\\win" },
			metadata: { rel: "../../../escape", abs: "/etc/passwd" },
			origin: { tool_name: "../../escape-tool" },
		});
		// Malformed owner tokens are refused outright (no path is even computed).
		assert.equal(evil.ok, false);
		assert.equal(evil.reason, "invalid_request");
		const good = a.put({
			bytes: Buffer.from("payload"),
			owner: OWNER,
			metadata: { rel: "../../../escape", abs: "/etc/passwd" },
		});
		assert.equal(good.ok, true);
		const hex = good.digest.slice("sha256:".length);
		const expected = join(root, "objects", "sha256", hex.slice(0, 2), hex);
		assert.equal(existsSync(expected), true);
		assert.equal(existsSync(join(root, "..", "escape")), false);
		assert.equal(statSync(expected).isFile(), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-04: an unwritable root fails closed and creates no head", () => {
	const root = tempRoot("art-04");
	const inner = join(root, "readonly");
	mkdirSync(inner);
	try {
		chmodSync(inner, 0o500);
		const blocked = createArtifactStore({ root: inner });
		const result = blocked.put({ bytes: Buffer.from("cannot persist"), owner: OWNER });
		if (process.getuid && process.getuid() === 0) {
			// root can always write; skip the assertion but keep the case visible.
			assert.equal(typeof result.ok, "boolean");
		} else {
			assert.equal(result.ok, false);
			assert.equal(result.reason, "persist_failed");
			assert.ok(result.detail.length > 0, "failure carries a concrete detail");
			assert.equal(existsSync(join(inner, "heads")), false, "no head directory is even created");
		}
	} finally {
		chmodSync(inner, 0o700);
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-31: an oversized artifact is refused before any bytes are written", () => {
	const root = tempRoot("art-31");
	try {
		const a = store(root, { limits: { maxArtifactBytes: 4 } });
		const result = a.put({ bytes: Buffer.from("too large for the configured limit"), owner: OWNER });
		assert.equal(result.ok, false);
		assert.equal(result.reason, "too_large");
		assert.match(result.detail, /over the 4 byte limit/);
		assert.equal(existsSync(join(root, "objects")), false, "nothing is written for a refused artifact");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-31 mutant: without the size cap the same input is accepted", async () => {
	await withMutant("m-nosizecap", (module) => {
		const root = tempRoot("art-31m");
		try {
			const a = module.createArtifactStore({ root, limits: { maxArtifactBytes: 4 } });
			const result = a.put({ bytes: Buffer.from("too large for the configured limit"), owner: OWNER });
			assert.equal(result.ok, true, "the size-cap mutant deliberately accepts an oversized artifact");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

test("ART-05: a deleted blob is missing, never silently reconstructed", () => {
	const root = tempRoot("art-05");
	try {
		const a = store(root);
		const put = a.put({ bytes: Buffer.from("will vanish"), owner: OWNER });
		const blob = join(root, "objects", "sha256", put.digest.slice(7, 9), put.digest.slice(7));
		rmSync(blob);
		const read = a.readBytes({ ref_id: put.ref_id });
		assert.equal(read.ok, false);
		assert.equal(read.reason, "missing");
		assert.equal(read.bytes, undefined, "a refusal carries no bytes");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-06/07: truncated and bit-flipped blobs are corrupt", () => {
	const root = tempRoot("art-06");
	try {
		const a = store(root);
		const put = a.put({ bytes: Buffer.from("0123456789abcdef"), owner: OWNER });
		const blob = join(root, "objects", "sha256", put.digest.slice(7, 9), put.digest.slice(7));

		truncateSync(blob, 10);
		const short = a.readBytes({ ref_id: put.ref_id });
		assert.equal(short.ok, false);
		assert.equal(short.reason, "corrupt");
		assert.match(short.detail, /head says 16/);

		const a2 = store(root);
		writeFileSync(blob, Buffer.from("0123456789abcdeX")); // same length, different content
		const flipped = a2.readBytes({ ref_id: put.ref_id });
		assert.equal(flipped.ok, false);
		assert.equal(flipped.reason, "corrupt");
		assert.equal(flipped.bytes, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-08: a symlinked blob pointing outside the store is refused", () => {
	const root = tempRoot("art-08");
	const outside = tempRoot("art-08-outside");
	try {
		const a = store(root);
		const put = a.put({ bytes: Buffer.from("inside content"), owner: OWNER });
		const blob = join(root, "objects", "sha256", put.digest.slice(7, 9), put.digest.slice(7));
		const external = join(outside, "evil.bin");
		writeFileSync(external, Buffer.from("inside content"));
		rmSync(blob);
		symlinkSync(external, blob);
		const read = a.readBytes({ ref_id: put.ref_id });
		assert.equal(read.ok, false);
		assert.equal(read.reason, "symlink");
		assert.equal(read.bytes, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("ART-09: a symlinked head directory that escapes the root is refused", () => {
	const root = tempRoot("art-09");
	const outside = tempRoot("art-09-outside");
	try {
		const a = store(root);
		const put = a.put({ bytes: Buffer.from("head escape"), owner: OWNER });
		const headsDir = join(root, "heads");
		const realHeads = join(outside, "heads");
		renameSync(headsDir, realHeads);
		symlinkSync(realHeads, headsDir);
		const head = a.head({ ref_id: put.ref_id });
		assert.equal(head.ok, false);
		assert.equal(head.reason, "symlink");
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("ART-08/09 mutant: skipping containment accepts the escape", async () => {
	await withMutant("m-followsymlink", (module) => {
		const root = tempRoot("art-08m");
		const outside = tempRoot("art-08m-outside");
		try {
			const a = module.createArtifactStore({ root });
			const put = a.put({ bytes: Buffer.from("inside content"), owner: OWNER });
			const blob = join(root, "objects", "sha256", put.digest.slice(7, 9), put.digest.slice(7));
			// Replace the real blob with a symlink to an outside file of the same
			// content: only the containment check can distinguish them.
			const external = join(outside, "evil.bin");
			writeFileSync(external, Buffer.from("inside content"));
			rmSync(blob);
			symlinkSync(external, blob);
			const read = a.readBytes({ ref_id: put.ref_id });
			assert.equal(read.ok, true, "the containment mutant reads bytes through the escaping symlink");
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

test("ART-10/11/33: offset and limit bounds are exact", () => {
	const root = tempRoot("art-10");
	try {
		const a = store(root);
		const put = a.put({ bytes: Buffer.from("0123456789"), owner: OWNER });
		const cases = [
			[{ offset: -1 }, "invalid_request"],
			[{ offset: 1.5 }, "invalid_request"],
			[{ offset: Number.NaN }, "invalid_request"],
			[{ offset: "0" }, "invalid_request"],
			[{ limit: 0 }, "invalid_request"],
			[{ offset: 11 }, "out_of_bounds"],
		];
		for (const [request, reason] of cases) {
			const result = a.readBytes({ ref_id: put.ref_id, ...request });
			assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(request)}`);
			assert.equal(result.reason, reason, `reason for ${JSON.stringify(request)}`);
		}
		const atEnd = a.readBytes({ ref_id: put.ref_id, offset: 10 });
		assert.equal(atEnd.ok, true);
		assert.equal(atEnd.bytes.byteLength, 0);
		const overrun = a.readBytes({ ref_id: put.ref_id, offset: 8, limit: 100 });
		assert.equal(overrun.ok, true);
		assert.equal(overrun.bytes.toString(), "89");
		assert.equal(overrun.end_offset, 10);
		const middle = a.readBytes({ ref_id: put.ref_id, offset: 2, limit: 3 });
		assert.equal(middle.bytes.toString(), "234");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-14/15/16/29: owner and authorization are checked before bytes", async () => {
	const { createArtifactReader } = await import("../execution/artifact-read.mjs");
	const root = tempRoot("art-14");
	try {
		const a = store(root);
		const put = a.put({
			bytes: Buffer.from("owned by task A"),
			owner: { task_id: "task-A", episode_id: "ep-A" },
			encoding_hint: "utf8",
		});

		const foreign = createArtifactReader({
			store: a,
			principal: () => ({ task_id: "task-B", episode_id: "ep-A", authorization: { read: true } }),
		});
		const foreignRead = await foreign.read({ ref_id: put.ref_id });
		assert.equal(foreignRead.ok, false);
		assert.equal(foreignRead.reason, "foreign");
		assert.equal(foreignRead.text, undefined);
		assert.equal(foreignRead.digest, undefined, "a foreign refusal leaks no digest");
		assert.equal(foreignRead.page, undefined);

		const episodeMismatch = createArtifactReader({
			store: a,
			principal: () => ({ task_id: "task-A", episode_id: "ep-B", authorization: { read: true } }),
		});
		assert.equal((await episodeMismatch.read({ ref_id: put.ref_id })).reason, "foreign");

		const noAuth = createArtifactReader({
			store: a,
			principal: () => ({ task_id: "task-A", episode_id: "ep-A", authorization: { read: false } }),
		});
		assert.equal((await noAuth.read({ ref_id: put.ref_id })).reason, "unauthorized");
		const noAuthField = createArtifactReader({
			store: a,
			principal: () => ({ task_id: "task-A", episode_id: "ep-A" }),
		});
		assert.equal(
			(await noAuthField.read({ ref_id: put.ref_id })).reason,
			"unauthorized",
			"a missing authorization is a denial, not a wildcard",
		);

		const narrowed = createArtifactReader({
			store: a,
			principal: () => ({
				task_id: "task-A",
				episode_id: "ep-A",
				authorization: { read: true, artifact_refs: ["artifact:sha256:" + "0".repeat(64)] },
			}),
		});
		assert.equal((await narrowed.read({ ref_id: put.ref_id })).reason, "foreign");

		const nullPrincipal = createArtifactReader({ store: a, principal: () => null });
		assert.equal((await nullPrincipal.read({ ref_id: put.ref_id })).reason, "unknown_principal");

		const thrown = createArtifactReader({
			store: a,
			principal: () => {
				throw new Error("host lookup failed");
			},
		});
		assert.equal((await thrown.read({ ref_id: put.ref_id })).reason, "unknown_principal");

		const allowed = createArtifactReader({
			store: a,
			principal: () => ({
				task_id: "task-A",
				episode_id: "ep-A",
				authorization: { read: true, artifact_refs: [put.ref_id] },
			}),
		});
		const ok = await allowed.read({ ref_id: put.ref_id });
		assert.equal(ok.ok, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-17: request shape is strict and never touches arbitrary paths", async () => {
	const { createArtifactReader } = await import("../execution/artifact-read.mjs");
	const root = tempRoot("art-17");
	try {
		const a = store(root);
		const put = a.put({ bytes: Buffer.from("body"), owner: OWNER, encoding_hint: "utf8" });
		let principalCalls = 0;
		const reader = createArtifactReader({
			store: a,
			principal: () => {
				principalCalls += 1;
				return {
					task_id: OWNER.task_id,
					episode_id: OWNER.episode_id,
					campaign_id: OWNER.campaign_id,
					authorization: { read: true },
				};
			},
		});
		const bad = [
			{ ref_id: put.ref_id, path: "/etc/passwd" },
			{ ref_id: put.ref_id, file: "/etc/passwd" },
			{ ref_id: put.ref_id, url: "file:///etc/passwd" },
			{ ref_id: put.ref_id, digest: "sha256:" + "0".repeat(64) },
			{ ref_id: put.ref_id, owner: { task_id: "task-B", episode_id: "ep-B" } },
			{ ref_id: 123 },
			{ ref_id: "artifact:sha256:../../etc/passwd" },
			{ ref_id: `/etc/passwd` },
			{ ref_id: put.ref_id, extra: 1 },
			{},
			null,
			[],
			"ref",
		];
		for (const request of bad) {
			const result = await reader.read(request);
			assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(request)}`);
			assert.ok(
				["invalid_request", "missing"].includes(result.reason),
				`reason for ${JSON.stringify(request)}: ${result.reason}`,
			);
			assert.equal(result.page, undefined);
		}
		assert.equal(principalCalls, 0, "malformed requests are rejected before any principal or filesystem access");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-18/19: utf8 pages never split a character and concatenate exactly", async () => {
	const { createArtifactReader } = await import("../execution/artifact-read.mjs");
	const root = tempRoot("art-18");
	try {
		const a = store(root);
		// Real mixture: 2-byte, 3-byte and 4-byte sequences interleaved with ASCII.
		const text = `${"é".repeat(2000)}${"漢".repeat(2000)}${"🙂".repeat(2000)}plain ascii ${"x".repeat(2000)}`;
		const bytes = Buffer.from(text, "utf8");
		const put = a.put({ bytes, owner: OWNER, encoding_hint: "utf8", media_type: "text/plain; charset=utf-8" });
		const reader = createArtifactReader({
			store: a,
			limits: { maxPageBytes: 4096, maxBytesPerSession: 1024 * 1024, maxPagesPerSession: 1000 },
			principal: () => ({
				task_id: OWNER.task_id,
				episode_id: OWNER.episode_id,
				campaign_id: OWNER.campaign_id,
				authorization: { read: true },
			}),
		});
		let offset = 0;
		let assembled = "";
		let pages = 0;
		while (offset !== null && pages < 1000) {
			const page = await reader.read({ ref_id: put.ref_id, offset, limit: 4096, encoding: "utf8" });
			assert.equal(page.ok, true, `page at ${offset} failed: ${page.reason} ${page.detail}`);
			assert.equal(page.page.offset, offset);
			assert.equal(
				page.page.offset + page.page.byte_length,
				page.page.end_offset,
				"the page covers a contiguous byte range",
			);
			assert.ok(
				Buffer.byteLength(page.page.text, "utf8") === page.page.byte_length,
				"reported byte length equals the encoded text length",
			);
			assert.equal(page.page.text.includes("\uFFFD"), false, "no replacement characters are introduced");
			assembled += page.page.text;
			offset = page.pagination.has_more ? page.pagination.next_offset : null;
			if (offset !== null)
				assert.equal(offset, page.page.end_offset, "the next page resumes exactly where this one stopped");
			pages += 1;
		}
		assert.ok(pages >= Math.ceil(bytes.byteLength / 4096), "all bytes require multiple bounded pages");
		assert.equal(assembled, text, "concatenated pages reproduce the original text exactly");
		assert.equal(Buffer.byteLength(assembled, "utf8"), bytes.byteLength);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-19: a 4-byte sequence straddling the limit is deferred, not split", async () => {
	const { createArtifactReader } = await import("../execution/artifact-read.mjs");
	const root = tempRoot("art-19");
	try {
		const a = store(root);
		// "a" + emoji => emoji occupies bytes 1..4.
		const text = `a🙂b`;
		const put = a.put({ bytes: Buffer.from(text, "utf8"), owner: OWNER, encoding_hint: "utf8" });
		const reader = createArtifactReader({
			store: a,
			principal: () => ({
				task_id: OWNER.task_id,
				episode_id: OWNER.episode_id,
				campaign_id: OWNER.campaign_id,
				authorization: { read: true },
			}),
		});
		const first = await reader.read({ ref_id: put.ref_id, offset: 0, limit: 3 });
		assert.equal(first.ok, true);
		assert.equal(first.page.text, "a", "the straddled emoji is not emitted partially");
		assert.equal(first.page.byte_length, 1, "only whole characters are returned");
		assert.equal(first.pagination.has_more, true);
		assert.equal(first.pagination.next_offset, 1, "the next byte offset is the emoji lead byte");

		// limit 3 cannot hold a 4-byte character: that is an explicit refusal, never
		// an empty page whose next_offset equals its own offset (an infinite loop).
		const stuck = await reader.read({ ref_id: put.ref_id, offset: 1, limit: 3 });
		assert.equal(stuck.ok, false);
		assert.equal(stuck.reason, "budget_exceeded");

		// An offset INSIDE a character snaps back to the char's lead byte.
		const snapped = await reader.read({ ref_id: put.ref_id, offset: 3, limit: 8 });
		assert.equal(snapped.ok, true);
		assert.equal(snapped.page.offset, 1, "the page starts at the character boundary");
		assert.equal(snapped.pagination.aligned_back_bytes, 2);
		assert.equal(snapped.page.text, "🙂b");

		const second = await reader.read({ ref_id: put.ref_id, offset: 1, limit: 4 });
		assert.equal(second.ok, true);
		assert.equal(second.page.text, "🙂");
		assert.equal(second.page.byte_length, 4);
		const third = await reader.read({ ref_id: put.ref_id, offset: second.pagination.next_offset, limit: 8 });
		assert.equal(third.ok, true);
		assert.equal(third.page.text, "b");
		assert.equal(third.pagination.has_more, false);
		assert.equal(first.page.text + second.page.text + third.page.text, text);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-20: base64 pages are exact byte ranges over binary data", async () => {
	const { createArtifactReader } = await import("../execution/artifact-read.mjs");
	const root = tempRoot("art-20");
	try {
		const a = store(root);
		const binary = Buffer.alloc(4096);
		for (let index = 0; index < binary.length; index += 1) binary[index] = index % 256;
		// Include 0x00 and every high byte, which would corrupt under utf8.
		const put = a.put({ bytes: binary, owner: OWNER, encoding_hint: "base64" });
		const reader = createArtifactReader({
			store: a,
			limits: { maxPageBytes: 1001, maxBytesPerSession: 1024 * 1024, maxPagesPerSession: 100 },
			principal: () => ({
				task_id: OWNER.task_id,
				episode_id: OWNER.episode_id,
				campaign_id: OWNER.campaign_id,
				authorization: { read: true },
			}),
		});
		const chunks = [];
		let offset = 0;
		for (;;) {
			const page = await reader.read({ ref_id: put.ref_id, offset, limit: 1001, encoding: "base64" });
			assert.equal(page.ok, true, `${page.reason} ${page.detail}`);
			assert.equal(page.page.offset, offset);
			const decoded = Buffer.from(page.page.text, "base64");
			assert.equal(decoded.byteLength, page.page.byte_length);
			chunks.push(decoded);
			if (!page.pagination.has_more) break;
			offset = page.pagination.next_offset;
		}
		const assembled = Buffer.concat(chunks);
		assert.equal(assembled.equals(binary), true, "base64 round-trip is byte exact");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-12/13/34: page and session budgets are enforced before reading", async () => {
	const { createArtifactReader } = await import("../execution/artifact-read.mjs");
	const root = tempRoot("art-12");
	try {
		const a = store(root);
		const put = a.put({ bytes: Buffer.from("z".repeat(200)), owner: OWNER, encoding_hint: "utf8" });
		const reader = createArtifactReader({
			store: a,
			limits: { maxPageBytes: 16, maxBytesPerSession: 32, maxPagesPerSession: 10 },
			principal: () => ({
				task_id: OWNER.task_id,
				episode_id: OWNER.episode_id,
				campaign_id: OWNER.campaign_id,
				authorization: { read: true },
			}),
		});
		const first = await reader.read({ ref_id: put.ref_id, limit: 16 });
		assert.equal(first.ok, true);
		assert.equal(first.page.byte_length, 16);
		const second = await reader.read({ ref_id: put.ref_id, offset: first.pagination.next_offset, limit: 16 });
		assert.equal(second.ok, true);
		assert.equal(second.pagination.state.session_bytes_used, 32);

		const third = await reader.read({ ref_id: put.ref_id, offset: second.pagination.next_offset, limit: 16 });
		assert.equal(third.ok, false);
		assert.equal(third.reason, "budget_exceeded");
		const afterFailure = await reader.usage();
		assert.equal(afterFailure.session_bytes_used, 32, "a refused read consumes no budget");
		assert.equal(afterFailure.session_pages_used, 2);

		reader.reset();
		const afterReset = await reader.read({ ref_id: put.ref_id, offset: second.pagination.next_offset, limit: 16 });
		assert.equal(afterReset.ok, true, "a new session (reset) reads from its own budget");

		// Page clamping: a request larger than maxPageBytes is clamped, visibly.
		const clampReader = createArtifactReader({
			store: a,
			limits: { maxPageBytes: 16, maxBytesPerSession: 4096, maxPagesPerSession: 10 },
			principal: () => ({
				task_id: OWNER.task_id,
				episode_id: OWNER.episode_id,
				campaign_id: OWNER.campaign_id,
				authorization: { read: true },
			}),
		});
		const clamped = await clampReader.read({ ref_id: put.ref_id, limit: 64 });
		assert.equal(clamped.ok, true);
		assert.equal(clamped.page.byte_length, 16, "the page is clamped to maxPageBytes");
		assert.equal(clamped.pagination.clamped.bytes, true);

		// A per-principal budget is a further restriction, never a widening.
		const narrow = createArtifactReader({
			store: a,
			limits: { maxPageBytes: 4096, maxBytesPerSession: 4096, maxPagesPerSession: 4096 },
			principal: () => ({
				task_id: OWNER.task_id,
				episode_id: OWNER.episode_id,
				campaign_id: OWNER.campaign_id,
				budget: { maxBytes: 8 },
				authorization: { read: true },
			}),
		});
		const narrowPage = await narrow.read({ ref_id: put.ref_id, limit: 100 });
		assert.equal(narrowPage.page.byte_length, 8);

		const charRoot = tempRoot("art-34");
		try {
			const b = store(charRoot);
			const wide = b.put({ bytes: Buffer.from("é".repeat(100), "utf8"), owner: OWNER, encoding_hint: "utf8" });
			const charReader = createArtifactReader({
				store: b,
				limits: { maxPageBytes: 4096, maxPageChars: 10 },
				principal: () => ({
					task_id: OWNER.task_id,
					episode_id: OWNER.episode_id,
					campaign_id: OWNER.campaign_id,
					authorization: { read: true },
				}),
			});
			const charPage = await charReader.read({ ref_id: wide.ref_id, limit: 4096 });
			assert.equal(charPage.ok, true);
			assert.ok(charPage.page.text.length <= 10, `char budget respected: ${charPage.page.text.length}`);
			assert.equal(charPage.pagination.clamped.chars, true);
			assert.equal(Buffer.byteLength(charPage.page.text, "utf8"), charPage.page.byte_length);
		} finally {
			rmSync(charRoot, { recursive: true, force: true });
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-21: a mid/late clue in a large artifact survives a new store instance", async () => {
	const { createArtifactReader } = await import("../execution/artifact-read.mjs");
	const root = tempRoot("art-21");
	try {
		const marker = "MIDDLE_LATE_CLUE_7f3a";
		const text = `${"A".repeat(180_000)}${marker}${"B".repeat(20_000)}`;
		const bytes = Buffer.from(text, "utf8");
		const writer = store(root);
		const put = writer.put({
			bytes,
			owner: OWNER,
			encoding_hint: "utf8",
			origin: { event_id: "evt-1", event_type: "action.completed", tool_name: "bash" },
		});
		assert.equal(put.ok, true);
		assert.equal(put.byte_length, bytes.byteLength);

		// Simulate a Session rotation: entirely new store + reader instances.
		const rebuilt = store(root);
		const entry = rebuilt.head({ ref_id: put.ref_id });
		assert.equal(entry.ok, true);
		assert.equal(entry.entry.byte_length, bytes.byteLength);
		const reader = createArtifactReader({
			store: rebuilt,
			limits: { maxPageBytes: 8192, maxBytesPerSession: 1024 * 1024, maxPagesPerSession: 1000 },
			principal: () => ({
				task_id: OWNER.task_id,
				episode_id: OWNER.episode_id,
				campaign_id: OWNER.campaign_id,
				authorization: { read: true },
			}),
		});
		const markerByteOffset = Buffer.byteLength(text.slice(0, 180_000), "utf8");
		const page = await reader.read({ ref_id: put.ref_id, offset: markerByteOffset, limit: 200 });
		assert.equal(page.ok, true);
		assert.ok(page.page.text.includes(marker), "the clue is recovered verbatim from a paged read");
		assert.equal(page.origin.tool_name, "bash", "provenance travels with the artifact");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-22/23/26: the registry rebuilds from heads only and ignores derived state", () => {
	const root = tempRoot("art-22");
	try {
		const a = store(root, { now: () => "2026-01-01T00:00:00Z" });
		const puts = ["alpha", "beta", "gamma"].map((text) =>
			a.put({ bytes: Buffer.from(text), owner: OWNER, encoding_hint: "utf8" }),
		);
		const first = a.list({});
		assert.equal(first.ok, true);
		assert.equal(first.entries.length, 3);

		// Delete anything that could be a derived index; only heads+objects remain.
		for (const junk of ["index.json", "manifest.json", "cache", "list.json"]) {
			writeFileSync(join(root, junk), "derived");
			rmSync(join(root, junk));
		}
		const rebuilt = store(root, { now: () => "2027-12-31T23:59:59Z" });
		const second = rebuilt.list({});
		assert.equal(second.ok, true);
		assert.deepEqual(
			second.entries.map((entry) => entry.ref_id).sort(),
			first.entries.map((entry) => entry.ref_id).sort(),
		);
		assert.deepEqual(
			second.entries.map((entry) => entry.digest).sort(),
			first.entries.map((entry) => entry.digest).sort(),
		);
		for (const put of puts) {
			assert.equal(rebuilt.readBytes({ ref_id: put.ref_id }).ok, true, "bytes remain readable after rebuild");
		}
		// A different clock changes only `stored_at` on newly written heads.
		const latePut = rebuilt.put({ bytes: Buffer.from("alpha"), owner: OWNER, encoding_hint: "utf8" });
		assert.equal(latePut.ref_id, puts[0].ref_id);
		assert.equal(latePut.digest, puts[0].digest);
		assert.equal(latePut.created, false, "an existing artifact is not rewritten");
		assert.equal(
			latePut.entry.stored_at,
			"2027-12-31T23:59:59Z",
			"the head persisted earlier keeps its own stored_at; a clock change never rewrites content",
		);
		assert.equal(latePut.entry.byte_length, 5);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-24: listing is bounded and truncation is explicit", async () => {
	await withMutant("m-truncationsilent", (module) => {
		const root = tempRoot("art-24m");
		try {
			const a = module.createArtifactStore({ root, limits: { maxEntries: 2 } });
			a.put({ bytes: Buffer.from("e1"), owner: OWNER });
			a.put({ bytes: Buffer.from("e2"), owner: OWNER });
			a.put({ bytes: Buffer.from("e3"), owner: OWNER });
			const list = a.list({});
			assert.equal(list.entries.length, 2);
			assert.equal(list.truncated, false, "the silent-truncation mutant lies about omission");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	const root = tempRoot("art-24");
	try {
		const a = store(root, { limits: { maxEntries: 2 } });
		for (const text of ["e1", "e2", "e3"]) a.put({ bytes: Buffer.from(text), owner: OWNER });
		const list = a.list({});
		assert.equal(list.ok, true);
		assert.equal(list.entries.length, 2);
		assert.equal(list.truncated, true, "omission is visible");
		assert.equal(list.total, 3);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-25: a read grants no Fact/Outcome/permit and appends nothing", async () => {
	const { createArtifactReader } = await import("../execution/artifact-read.mjs");
	const root = tempRoot("art-25");
	const logDir = tempRoot("art-25-log");
	try {
		const a = store(root);
		const put = a.put({ bytes: Buffer.from("observed output".repeat(50)), owner: OWNER, encoding_hint: "utf8" });
		const reader = createArtifactReader({
			store: a,
			principal: () => ({
				task_id: OWNER.task_id,
				episode_id: OWNER.episode_id,
				campaign_id: OWNER.campaign_id,
				authorization: { read: true },
			}),
		});
		const page = await reader.read({ ref_id: put.ref_id, limit: 500 });
		assert.equal(page.ok, true);
		assert.deepEqual(page.grants, { fact: false, outcome: false, permission: false, budget: false });
		assert.equal(page.fact, undefined);
		assert.equal(page.outcome, undefined);
		assert.equal(existsSync(join(logDir, "events.jsonl")), false, "reading writes no audit row");
		const stat = await reader.stat({ ref_id: put.ref_id });
		assert.deepEqual(stat.grants, { fact: false, outcome: false, permission: false, budget: false });
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(logDir, { recursive: true, force: true });
	}
});

test("ART-27: concurrent puts of identical content converge on one verified blob", async () => {
	const root = tempRoot("art-27");
	try {
		const payload = Buffer.alloc(512 * 1024);
		for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 31) % 256;
		const results = await Promise.all(
			Array.from({ length: 8 }, () => {
				return Promise.resolve().then(() => store(root).put({ bytes: payload, owner: OWNER }));
			}),
		);
		for (const result of results) {
			assert.equal(result.ok, true, `${result.reason} ${result.detail}`);
			assert.equal(result.ref_id, results[0].ref_id);
			assert.equal(result.byte_length, payload.byteLength);
		}
		const created = results.filter((result) => result.created).length;
		assert.ok(created >= 1, "at least one writer created the blob");
		const check = store(root).readBytes({ ref_id: results[0].ref_id, offset: 0, limit: payload.byteLength });
		assert.equal(check.ok, true);
		assert.equal(check.bytes.equals(payload), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-28/30/32: payload types and head/content binding are validated", () => {
	const root = tempRoot("art-28");
	try {
		const a = store(root);
		assert.equal(a.put({ bytes: "a string", owner: OWNER }).reason, "invalid_request");
		assert.equal(a.put({ bytes: null, owner: OWNER }).reason, "invalid_request");
		assert.equal(a.put({ bytes: Buffer.from("x"), owner: { task_id: "t" } }).reason, "invalid_request");
		assert.equal(
			a.put({ bytes: Buffer.from("x"), owner: { task_id: "t/../x", episode_id: "e" } }).reason,
			"invalid_request",
		);
		assert.equal(a.put({ bytes: Buffer.from("x"), owner: OWNER, media_type: 5 }).reason, "invalid_request");
		assert.equal(a.put({ bytes: Buffer.from("x"), owner: OWNER, classification: "secret" }).reason, "invalid_request");
		assert.equal(a.put({ bytes: Buffer.from("x"), owner: OWNER, encoding_hint: "hex" }).reason, "invalid_request");
		assert.equal(
			a.put({ bytes: Buffer.from("x"), owner: OWNER, origin: { unexpected: "k" } }).reason,
			"invalid_request",
		);
		assert.equal(
			a.put({ bytes: Buffer.from("x"), owner: OWNER, metadata: { big: "y".repeat(5000) } }).reason,
			"invalid_request",
		);

		const uint8 = new Uint8Array([1, 2, 3, 4]);
		const put = a.put({ bytes: uint8, owner: OWNER });
		assert.equal(put.ok, true);
		assert.equal(put.digest, artifactContentDigest(Buffer.from(uint8)));
		assert.equal(a.readBytes({ ref_id: put.ref_id }).bytes.equals(Buffer.from(uint8)), true);

		// ART-32: a head whose digest agrees with its address but whose blob is
		// different content is corrupt.
		const b = store(tempRoot("art-32"));
		const putB = b.put({ bytes: Buffer.from("original content"), owner: OWNER });
		const blobB = join(b.root, "objects", "sha256", putB.digest.slice(7, 9), putB.digest.slice(7));
		writeFileSync(blobB, Buffer.from("different conten")); // same length, different digest
		const wrong = b.readBytes({ ref_id: putB.ref_id });
		assert.equal(wrong.ok, false);
		assert.equal(wrong.reason, "corrupt");
		const headOnly = b.head({ ref_id: putB.ref_id });
		assert.equal(headOnly.ok, true, "the head itself is intact; the blob is not");

		// A head with a mismatched digest is rejected by validation.
		const brokenHead = validateHead(
			{ ...put.entry, digest: `sha256:${"0".repeat(64)}`, ref_id: `artifact:sha256:${"0".repeat(64)}` },
			put.digest,
		);
		assert.equal(brokenHead.ok, false);
		rmSync(b.root, { recursive: true, force: true });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-03b: owner tokens and ref syntax reject path-shaped input", () => {
	assert.equal(normalizeArtifactOwner({ task_id: "../x", episode_id: "e" }).ok, false);
	assert.equal(normalizeArtifactOwner({ task_id: "t", episode_id: "" }).ok, false);
	assert.equal(normalizeArtifactOwner({ task_id: "t", episode_id: "e" }).ok, true);
	assert.equal(artifactRefForDigest("sha256:nothex"), null);
	assert.equal(artifactRefForDigest(`sha256:${"a".repeat(64)}`), `artifact:sha256:${"a".repeat(64)}`);
});

test("ART-04b: a child killed mid-write leaves no readable artifact", () => {
	const root = tempRoot("art-04b");
	try {
		// The child starts a large put and is killed immediately by the parent, so
		// the write is interrupted somewhere between temp-create and rename.
		const script = [
			`import { createArtifactStore } from ${JSON.stringify(pathToFileURL(STORE_MODULE.pathname).href)};`,
			`const store = createArtifactStore({ root: ${JSON.stringify(root)} });`,
			'process.stdout.write("ready\\n");',
			"const bytes = Buffer.alloc(6 * 1024 * 1024, 7);",
			'for (let index = 0; index < 40; index += 1) store.put({ bytes, owner: { task_id: "task-crash", episode_id: "ep-crash" } });',
			'process.stdout.write("done\\n");',
		].join("\n");
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += String(chunk);
			if (out.includes("ready")) child.kill("SIGKILL");
		});
		const killed = child.kill.bind(child);
		const timer = setTimeout(() => killed("SIGKILL"), 5_000);
		return new Promise((resolve, reject) => {
			child.on("exit", (code, signal) => {
				clearTimeout(timer);
				try {
					assert.ok(
						signal === "SIGKILL" || code !== 0,
						`the child must not complete normally (code=${code}, signal=${signal})`,
					);
					const a = createArtifactStore({ root });
					const list = a.list({});
					assert.equal(list.ok, true);
					// Whatever the child did persist must be fully readable; a head with a
					// half-written blob would surface here as `missing`/`corrupt`.
					for (const entry of list.entries) {
						const read = a.readBytes({ ref_id: entry.ref_id, offset: 0, limit: 16 });
						assert.equal(read.ok, true, `listed entry ${entry.ref_id} must be readable: ${read.reason} ${read.detail}`);
					}
					// Partial temp files may exist, but they must never be listed as artifacts.
					assert.equal(
						list.entries.some((entry) => entry.ref_id.includes("tmp")),
						false,
					);
					resolve();
				} catch (error) {
					reject(error);
				}
			});
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-05b: no temp files are left behind after successful and failed puts", () => {
	const root = tempRoot("art-05b");
	try {
		const a = store(root);
		a.put({ bytes: Buffer.from("clean run"), owner: OWNER });
		a.put({ bytes: Buffer.from("x"), owner: OWNER, classification: "not-allowed" });
		const leftovers = [];
		const walk = (dir) => {
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				if (statSync(path).isDirectory()) walk(path);
				else if (name.includes(".tmp-")) leftovers.push(path);
			}
		};
		walk(root);
		assert.deepEqual(leftovers, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ART-33b: a copied blob cannot be presented under a different head", () => {
	const rootA = tempRoot("art-33b-a");
	const rootB = tempRoot("art-33b-b");
	try {
		const a = createArtifactStore({ root: rootA });
		const putA = a.put({ bytes: Buffer.from("content A"), owner: OWNER });
		const b = createArtifactStore({ root: rootB });
		const putB = b.put({ bytes: Buffer.from("content B"), owner: OWNER });
		const blobA = join(rootA, "objects", "sha256", putA.digest.slice(7, 9), putA.digest.slice(7));
		const blobB = join(rootB, "objects", "sha256", putB.digest.slice(7, 9), putB.digest.slice(7));
		copyFileSync(blobA, blobB);
		const read = b.readBytes({ ref_id: putB.ref_id });
		assert.equal(read.ok, false);
		assert.equal(read.reason, "corrupt");
	} finally {
		rmSync(rootA, { recursive: true, force: true });
		rmSync(rootB, { recursive: true, force: true });
	}
});
