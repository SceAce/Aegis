// Seeding a tool catalog from a local inventory.
//
// The inventory knows "this CLI exists at this path"; the catalog adds what a model
// needs (purpose, invocation shape, pitfalls). The split matters: knowledge is
// tracked, paths are machine-specific, and a reseed must never downgrade a note a
// human already confirmed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadToolCatalog } from "../memory/tool-catalog.mjs";

const SEED = new URL("../../aegis-seed-tool-catalog.mjs", import.meta.url).pathname;

function run(args, env = {}) {
	return spawnSync(process.execPath, [SEED, ...args], {
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, ...env },
	});
}

/** A fake inventory + a fake executable named like a known tool. */
function fixture({ version = "1.0" } = {}) {
	const base = mkdtempSync(join(tmpdir(), "aegis-seed-"));
	const bin = join(base, "bin");
	mkdirSync(bin, { recursive: true });
	const ropgadget = join(bin, "ROPgadget");
	writeFileSync(ropgadget, "#!/bin/sh\necho fake\n", "utf8");
	chmodSync(ropgadget, 0o755);

	const inventory = join(base, "inventory.json");
	writeFileSync(
		inventory,
		JSON.stringify(
			{
				schema_version: "aegis.local-tool-inventory.v1",
				tools: [
					{ id: "pwn.ropgadget", path: ropgadget, version },
					{ id: "pwn.unknown-thing", path: ropgadget, version },
				],
			},
			null,
			2,
		),
		"utf8",
	);
	return {
		base,
		inventory,
		catalog: join(base, "catalog.json"),
		ropgadget,
		cleanup: () => rmSync(base, { recursive: true, force: true }),
	};
}

test("a known tool gets purpose, usage, flags and candidate pitfalls", () => {
	const f = fixture();
	try {
		const result = run(["--inventory", f.inventory, "--catalog", f.catalog]);
		assert.equal(result.status, 0, result.stderr);
		const loaded = loadToolCatalog(f.catalog);
		assert.equal(loaded.ok, true, loaded.errors.join("; "));
		const tool = loaded.catalog.tools.find((entry) => entry.id === "ropgadget");
		assert.ok(tool, "ropgadget is seeded");
		assert.match(tool.purpose, /gadget/i);
		assert.match(tool.interface.usage, /--binary/);
		assert.ok(tool.interface.key_flags.includes("--only"));
		assert.ok(tool.pitfalls.length > 0);
		assert.equal(tool.executable, f.ropgadget);
		// Seeded knowledge is a candidate: only a confirmed solve may promote it.
		assert.ok(tool.pitfalls.every((note) => note.status === "candidate"));
		assert.match(tool.notes, /inventory version: 1\.0/);
	} finally {
		f.cleanup();
	}
});

test("an inventory row without knowledge is skipped, not invented", () => {
	const f = fixture();
	try {
		const result = run(["--inventory", f.inventory, "--catalog", f.catalog]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /skipped pwn\.unknown-thing: no knowledge entry/);
		const loaded = loadToolCatalog(f.catalog);
		assert.equal(
			loaded.catalog.tools.some((entry) => entry.id === "unknown-thing"),
			false,
		);
	} finally {
		f.cleanup();
	}
});

test("a reseed keeps pitfalls a human already confirmed", () => {
	const f = fixture();
	try {
		assert.equal(run(["--inventory", f.inventory, "--catalog", f.catalog]).status, 0);
		const catalog = JSON.parse(readFileSync(f.catalog, "utf8"));
		const tool = catalog.tools.find((entry) => entry.id === "ropgadget");
		tool.pitfalls.push({
			condition: "confirmed by a real solve",
			symptom: "symptom",
			correct_invocation: "invocation",
			status: "confirmed",
			recorded_at: "2026-10-21T00:00:00Z",
		});
		writeFileSync(f.catalog, JSON.stringify(catalog, null, 2), "utf8");

		assert.equal(run(["--inventory", f.inventory, "--catalog", f.catalog]).status, 0);
		const reseeded = JSON.parse(readFileSync(f.catalog, "utf8")).tools.find((entry) => entry.id === "ropgadget");
		assert.equal(reseeded.pitfalls.filter((note) => note.status === "confirmed").length, 1);
		assert.ok(
			reseeded.pitfalls.some((note) => note.condition === "confirmed by a real solve"),
			"a reseed must not drop confirmed knowledge",
		);
		// Seeded candidates are not duplicated alongside the confirmed one.
		const keys = reseeded.pitfalls.map((note) => `${note.condition}|${note.symptom}`);
		assert.equal(new Set(keys).size, keys.length);
	} finally {
		f.cleanup();
	}
});

test("--dry-run writes nothing; --only filters; a bad inventory path fails", () => {
	const f = fixture();
	try {
		const dry = run(["--inventory", f.inventory, "--catalog", f.catalog, "--dry-run"]);
		assert.equal(dry.status, 0, dry.stderr);
		assert.equal(existsSync(f.catalog), false);

		const only = run(["--inventory", f.inventory, "--catalog", f.catalog, "--only", "pwn.ropgadget"]);
		assert.equal(only.status, 0, only.stderr);
		assert.equal(loadToolCatalog(f.catalog).catalog.tools.length, 1);

		const missing = run(["--inventory", join(f.base, "nope.json"), "--catalog", f.catalog]);
		assert.equal(missing.status, 1);
		assert.match(missing.stderr, /inventory not found/);
	} finally {
		f.cleanup();
	}
});

test("an invalid existing catalog is not overwritten", () => {
	const f = fixture();
	try {
		writeFileSync(f.catalog, JSON.stringify({ tools: [{ id: "broken" }] }), "utf8");
		const before = readFileSync(f.catalog, "utf8");
		const result = run(["--inventory", f.inventory, "--catalog", f.catalog]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /refusing to overwrite/);
		assert.equal(readFileSync(f.catalog, "utf8"), before, "the operator's file is untouched");
	} finally {
		f.cleanup();
	}
});

test("the tracked knowledge covers the tools the inventory reports", () => {
	const source = readFileSync(new URL("../../aegis-seed-tool-catalog.mjs", import.meta.url), "utf8");
	for (const id of ["pwn.pwntools", "pwn.ropgadget", "pwn.checksec", "reverse.binwalk", "network.nmap", "debug.gdb"]) {
		assert.ok(source.includes(`"${id}"`), `knowledge must cover ${id}`);
	}
	// Each entry must state a purpose and an invocation shape, not just a name.
	assert.ok((source.match(/purpose:/g) ?? []).length >= 9);
	assert.ok((source.match(/usage:/g) ?? []).length >= 9);
});

test("a python module row becomes its own tool, distinct from a same-named CLI", () => {
	const base = mkdtempSync(join(tmpdir(), "aegis-pymod-"));
	try {
		const py = join(base, "python3");
		writeFileSync(py, "#!/bin/sh\nexit 0\n", "utf8");
		chmodSync(py, 0o755);
		const inventory = join(base, "inv.json");
		writeFileSync(
			inventory,
			JSON.stringify({
				tools: [
					{ id: "pwn.pwntools", path: py, version: "1.0" },
					{ id: "py.pwntools", kind: "python", module: "pwn", interpreter: py, version: "4.15.0" },
				],
			}),
			"utf8",
		);
		const catalog = join(base, "catalog.json");
		const result = run(["--inventory", inventory, "--catalog", catalog]);
		assert.equal(result.status, 0, result.stderr);
		const loaded = loadToolCatalog(catalog);
		assert.equal(loaded.ok, true, loaded.errors.join("; "));
		const ids = loaded.catalog.tools.map((tool) => tool.id).sort();
		assert.deepEqual(ids, ["pwntools", "py-pwntools"], "the module form is addressable on its own");
		const moduleTool = loaded.catalog.tools.find((tool) => tool.id === "py-pwntools");
		assert.match(moduleTool.notes, /python module pwn/);
		assert.equal(moduleTool.executable, py);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("--force replaces an invalid catalog but keeps a copy", () => {
	const f = fixture();
	try {
		writeFileSync(f.catalog, JSON.stringify({ tools: [{ id: "broken" }] }), "utf8");
		const refused = run(["--inventory", f.inventory, "--catalog", f.catalog]);
		assert.equal(refused.status, 1, "without --force it refuses");

		const forced = run(["--inventory", f.inventory, "--catalog", f.catalog, "--force"]);
		assert.equal(forced.status, 0, forced.stderr);
		assert.match(forced.stderr, /kept a copy at/);
		assert.equal(loadToolCatalog(f.catalog).ok, true);
	} finally {
		f.cleanup();
	}
});
