#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileDocumentSeed, compileDocumentSeedFile } from "./Pi_Agent_base/memory/document-seed.mjs";

function help() {
	console.log(
		`Usage: node compile-document-seed.mjs --input FILE.md --output FILE.json [--source-uri URI] [--external-approved]`,
	);
}
const args = process.argv.slice(2);
if (args.includes("--help")) {
	help();
	process.exit(0);
}
function value(name) {
	const i = args.indexOf(name);
	return i < 0 ? null : (args[i + 1] ?? null);
}
const input = value("--input"),
	output = value("--output");
if (!input || !output) {
	help();
	process.exit(2);
}
const inputPath = resolve(input),
	outputPath = resolve(output);
const sourceUri = value("--source-uri") ?? `file://${inputPath}`;
const external = args.includes("--external-approved");
const seed = await compileDocumentSeedFile({ path: inputPath });
if (external) {
	if (!sourceUri.startsWith("https://")) throw new Error("external source requires approved https metadata");
	const metadata = { source_uri: sourceUri, source_kind: "external_reference", approved: true };
	const markdown = await readFile(inputPath, "utf8");
	Object.assign(seed, compileDocumentSeed({ markdown, source: metadata }));
}
await writeFile(outputPath, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
console.log(
	JSON.stringify({
		ok: true,
		input: inputPath,
		output: outputPath,
		sections: seed.sections.length,
		chars: seed.content_chars,
		verified: false,
		action_policy: "none",
	}),
);
