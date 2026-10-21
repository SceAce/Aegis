// Read-only retrieval check for the hand-authored technique cards.
// Run from the repository root: node knowledge/techniques/check_queries.mjs
import assert from "node:assert/strict";
import { selectKnowledge } from "../../Pi_Agent_base/memory/knowledge.mjs";

const CASES = [
	["same modulus n two public exponents common modulus attack", "crypto-rsa-common-modulus"],
	["RSA small private exponent continued fractions Wiener", "crypto-rsa-wiener-small-d"],
	["RSA known high bits small root Coppersmith lattice", "crypto-rsa-coppersmith"],
	["CBC padding oracle recover plaintext", "crypto-aes-padding-oracle"],
	["SROP sigreturn frame execve", "pwn-srop"],
	["ret2dlresolve no libc leak PLT0 fake reloc", "pwn-ret2dlresolve"],
	["kernel SLUB use-after-free msg_msg spray", "pwn-kernel-uaf"],
	["Windows packer OEP dump fix IAT", "rev-windows-unpack"],
	["self modifying code decrypt stub dump", "rev-smc"],
	["Python pyc bytecode decompile constants", "rev-python-bytecode"],
	["audio spectrogram DTMF morse", "misc-audio"],
	["unknown file magic nested archive carve", "misc-recon-prefix"],
	["SQL injection keyword filter single global delete double write overlap", "web-sqli-double-write"],
	["SQL injection into outfile load_file write webshell file privilege", "web-sqli-into-outfile"],
	["zip upload symlink proc self environ zip slip", "misc-zip-symlink"],
];
let failed = 0;
for (const [query, expected] of CASES) {
	const r = await selectKnowledge({ root: "knowledge/techniques/seeds", query, maxResults: 1, maxChars: 800 });
	const ids = r.selected.map((row) => row.knowledge_id.split("/").pop().replace(/\.json#\d+$/, ""));
	const ok = ids.includes(expected);
	if (!ok) failed += 1;
	console.log(`${ok ? "ok" : "FAIL"} ${expected} <= ${JSON.stringify(ids)}`);
}
const negative = await selectKnowledge({
	root: "knowledge/techniques/seeds",
	query: "python cli run script install package",
	maxResults: 1,
	maxChars: 800,
});
if (negative.selected.length !== 0) {
	failed += 1;
	console.log(`FAIL negative query recalled ${JSON.stringify(negative.selected.map((r) => r.knowledge_id))}`);
} else {
	console.log("ok negative query: no recall");
}
console.log(failed === 0 ? `queries: ${CASES.length} matched` : `queries: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
