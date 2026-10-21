#!/usr/bin/env node
// Scan this machine for CTF tools and write the inventory the catalog builds from.
//
// The inventory answers ONE question: does this executable exist, and what version
// does it report. It does not say what the tool is for (that is knowledge) and it
// does not grant anything (that is authorization). `aegis-seed-tool-catalog.mjs`
// turns this into the model-facing catalog.
//
// Why a scan script instead of a checked-in list: tool presence is machine state.
// After installing something, re-run this and reseed; the catalog follows.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_OUT = join(homedir(), ".Aegis", "tools", "ctf", "tool-inventory.json");

/**
 * The catalogue of things worth knowing about, grouped by CTF direction.
 * `binary` is the executable name as installed; `py` is an importable module,
 * checked in the Python interpreters listed under --python.
 */
export const SCAN_LIST = [
	// Deliberately absent:
	//   pwn.pwntools  - the `pwn` CLI duplicates the Python module; only the module
	//                   is catalogued (see py.pwntools) so the model has one entry.
	//   reverse.ida   - IDA is reached through its MCP server (rea, provider=ida),
	//                   not a CLI; MCP tools are exposed by Pi, not by this catalog.
	// pwn
	{ id: "pwn.ropgadget", binary: "ROPgadget", args: ["--version"], direction: "pwn" },
	{ id: "pwn.ropper", binary: "ropper", args: ["--version"], direction: "pwn" },
	{ id: "pwn.one_gadget", binary: "one_gadget", args: ["--version"], direction: "pwn" },
	{ id: "pwn.seccomp-tools", binary: "seccomp-tools", args: ["--version"], direction: "pwn" },
	{ id: "pwn.checksec", binary: "checksec", args: ["--version"], direction: "pwn" },
	{ id: "pwn.patchelf", binary: "patchelf", args: ["--version"], direction: "pwn" },
	{ id: "pwn.pwninit", binary: "pwninit", args: ["--version"], direction: "pwn" },
	{ id: "pwn.socat", binary: "socat", args: ["-V"], direction: "pwn" },
	{ id: "pwn.nc", binary: "nc", args: ["-h"], direction: "pwn" },
	// debug
	{ id: "debug.gdb", binary: "gdb", args: ["--version"], direction: "debug" },
	{ id: "debug.lldb", binary: "lldb", args: ["--version"], direction: "debug" },
	// reverse
	{ id: "reverse.binwalk", binary: "binwalk", args: ["--help"], direction: "reverse" },
	{ id: "reverse.radare2", binary: "radare2", args: ["-v"], direction: "reverse" },
	{ id: "reverse.rizin", binary: "rizin", args: ["-v"], direction: "reverse" },
	{ id: "reverse.jadx", binary: "jadx", args: ["--version"], direction: "reverse" },
	{ id: "reverse.apktool", binary: "apktool", args: ["--version"], direction: "reverse" },
	{ id: "reverse.dex2jar", binary: "d2j-dex2jar", args: ["--version"], direction: "reverse" },
	{ id: "reverse.upx", binary: "upx", args: ["--version"], direction: "reverse" },
	{ id: "reverse.frida", binary: "frida", args: ["--version"], direction: "reverse" },
	{
		id: "reverse.ida",
		binary: "idat",
		args: ["-h"],
		direction: "reverse",
		paths: [
			join(homedir(), "Tools", "binaryAbout", "idapro_9.3", "IDA Professional 9.3.app", "Contents", "MacOS", "idat"),
		],
	},
	// web
	{ id: "web.ffuf", binary: "ffuf", args: ["-V"], direction: "web" },
	{ id: "web.gobuster", binary: "gobuster", args: ["version"], direction: "web" },
	{ id: "web.feroxbuster", binary: "feroxbuster", args: ["--version"], direction: "web" },
	{ id: "web.dirsearch", binary: "dirsearch", args: ["--version"], direction: "web" },
	{ id: "web.sqlmap", binary: "sqlmap", args: ["--version"], direction: "web" },
	{ id: "web.nuclei", binary: "nuclei", args: ["-version"], direction: "web" },
	{ id: "web.nikto", binary: "nikto", args: ["-Version"], direction: "web" },
	{ id: "web.arjun", binary: "arjun", args: ["--version"], direction: "web" },
	{ id: "web.mitmproxy", binary: "mitmdump", args: ["--version"], direction: "web" },
	{ id: "web.jwt_tool", binary: "jwt_tool", args: [], direction: "web" },
	{ id: "network.nmap", binary: "nmap", args: ["--version"], direction: "web" },

	// CVE / vulnerability-reference tooling. Presence is machine state; it is
	// not authorization. Install hints are in README.md.
	{ id: "cve.searchsploit", binary: "searchsploit", args: ["--version"], direction: "cve" },
	{ id: "cve.whatweb", binary: "whatweb", args: ["--version"], direction: "cve" },
	{ id: "cve.msfconsole", binary: "msfconsole", args: ["--version"], direction: "cve" },
	{ id: "cve.wpscan", binary: "wpscan", args: ["--version"], direction: "cve" },
	{ id: "cve.testssl", binary: "testssl.sh", args: ["--version"], direction: "cve" },
	{ id: "cve.trivy", binary: "trivy", args: ["--version"], direction: "cve" },
	{ id: "cve.grype", binary: "grype", args: ["--version"], direction: "cve" },
	{ id: "cve.osv_scanner", binary: "osv-scanner", args: ["--version"], direction: "cve" },
	{ id: "cve.cve_bin_tool", binary: "cve-bin-tool", args: ["--version"], direction: "cve" },
	{ id: "cve.retire", binary: "retire", args: ["--version"], direction: "cve" },
	// crypto
	{ id: "crypto.hashcat", binary: "hashcat", args: ["--version"], direction: "crypto" },
	{ id: "crypto.john", binary: "john", args: ["--list=build-info"], direction: "crypto" },
	{ id: "crypto.z3", binary: "z3", args: ["--version"], direction: "crypto" },
	{ id: "crypto.rsactftool", binary: "RsaCtfTool", args: ["--help"], direction: "crypto" },
	{ id: "crypto.sage", binary: "sage", args: ["--version"], direction: "crypto" },
	// misc
	{ id: "misc.exiftool", binary: "exiftool", args: ["-ver"], direction: "misc" },
	{ id: "misc.zsteg", binary: "zsteg", args: ["--version"], direction: "misc" },
	{ id: "misc.steghide", binary: "steghide", args: ["--version"], direction: "misc" },
	{ id: "misc.foremost", binary: "foremost", args: ["-V"], direction: "misc" },
	{ id: "misc.pngcheck", binary: "pngcheck", args: ["-h"], direction: "misc" },
	{ id: "misc.yara", binary: "yara", args: ["--version"], direction: "misc" },
	{ id: "misc.tesseract", binary: "tesseract", args: ["--version"], direction: "misc" },
	{ id: "misc.qpdf", binary: "qpdf", args: ["--version"], direction: "misc" },
	// runtime
	{ id: "runtime.docker", binary: "docker", args: ["--version"], direction: "runtime" },
	{ id: "runtime.colima", binary: "colima", args: ["version"], direction: "runtime" },
	// python modules worth reporting even without a CLI
	{ id: "py.crypto", py: "Crypto", direction: "crypto" },
	{ id: "py.gmpy2", py: "gmpy2", direction: "crypto" },
	{ id: "py.sympy", py: "sympy", direction: "crypto" },
	{ id: "py.z3-solver", py: "z3", direction: "crypto" },
	{ id: "py.angr", py: "angr", direction: "reverse" },
	{ id: "py.lief", py: "lief", direction: "reverse" },
	{ id: "py.pwntools", py: "pwn", direction: "pwn" },
	{ id: "py.oletools", py: "oletools", direction: "misc" },
	{ id: "py.pillow", py: "PIL", direction: "misc" },
	{ id: "py.stegano", py: "stegano", direction: "misc" },
	{ id: "py.pyjwt", py: "jwt", direction: "web" },
];

const HELP = `Usage: node aegis-scan-tools.mjs [options]

Writes a tool inventory (what exists + version) for the catalog to build from.

  --out PATH       default ${DEFAULT_OUT}
  --python PATH    Python interpreter to check modules in (repeatable).
                   Default: the running python plus ~/Tools/PyVenv/CTF{,312}
  --dry-run        print, write nothing
  -h, --help       this help

Presence is machine state, not authorization: a found binary is still not a
permitted action.
`;

function parseArgs(argv) {
	const options = { out: DEFAULT_OUT, pythons: [], dryRun: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const value = () => {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
			i += 1;
			return next;
		};
		if (arg === "--out") options.out = value();
		else if (arg === "--python") options.pythons.push(value());
		else if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else throw new Error(`unknown option: ${arg}`);
	}
	if (options.pythons.length === 0) {
		options.pythons = [
			process.execPath,
			join(homedir(), "Tools", "PyVenv", "CTF", "bin", "python3"),
			join(homedir(), "Tools", "PyVenv", "CTF312", "bin", "python3"),
			"/opt/homebrew/bin/python3",
		];
	}
	return options;
}

/** First line of a command's output, bounded. */
function versionOf(binary, args) {
	const result = spawnSync(binary, args, { encoding: "utf8", timeout: 8000, maxBuffer: 256 * 1024 });
	const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0] ?? "";
	return text.slice(0, 120) || "present";
}

/**
 * Resolve a binary by searching PATH plus the places macOS package managers use.
 * Relying on the caller's PATH alone misses homebrew and gem bin dirs, which is
 * exactly what made the first scan report installed tools as missing.
 */
/** Homebrew ruby installs gems outside PATH; ask gem where. */
function gemEnvironmentDirs() {
	const result = spawnSync("gem", ["environment"], { encoding: "utf8", timeout: 10_000 });
	const lines = (result.stdout ?? "").split("\n");
	const valueFor = (label) => {
		const line = lines.find((entry) => entry.includes(label));
		return line?.split(":").slice(1).join(":").trim() || null;
	};
	const executable = valueFor("EXECUTABLE DIRECTORY");
	const user = valueFor("USER INSTALLATION DIRECTORY");
	const dirs = [];
	if (executable && existsSync(executable)) dirs.push(executable);
	// `gem install --user-install` writes executables below <user>/bin; this is
	// common for tools like wpscan and must be scanned too.
	if (user && existsSync(join(user, "bin"))) dirs.push(join(user, "bin"));
	if (dirs.length === 0) dirs.push(join("/opt/homebrew/lib/ruby/gems", "bin"));
	return dirs;
}

function searchDirs() {
	return [
		...(process.env.PATH ?? "").split(":").filter(Boolean),
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
		join(homedir(), ".local", "bin"),
		join(homedir(), "Tools", "PyVenv", "CTF", "bin"),
		join(homedir(), "Tools", "PyVenv", "CTF312", "bin"),
		"/opt/metasploit-framework/bin",
		join(homedir(), "metasploit-framework", "bin"),
		...gemEnvironmentDirs(),
		join(homedir(), ".gem", "bin"),
		"/usr/bin",
		"/bin",
	];
}

function which(binary, extra = []) {
	for (const candidate of extra) if (candidate && existsSync(candidate)) return candidate;
	for (const dir of searchDirs()) {
		const candidate = join(dir, binary);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function moduleVersion(python, module) {
	const code = `import importlib.util as u, sys
spec = u.find_spec(${JSON.stringify(module)})
if spec is None: sys.exit(3)
try:
    import importlib.metadata as m
    print(m.version(${JSON.stringify(module)}))
except Exception:
    print("present")`;
	const result = spawnSync(python, ["-c", code], { encoding: "utf8", timeout: 20_000 });
	return result.status === 0 ? (result.stdout ?? "").trim().slice(0, 120) || "present" : null;
}

function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(String(error instanceof Error ? error.message : error));
		console.error(HELP);
		process.exit(2);
	}
	if (options.help) {
		console.log(HELP);
		return;
	}

	const tools = [];
	const notFound = [];
	const byDirection = {};
	for (const entry of SCAN_LIST) {
		const direction = entry.direction ?? "misc";
		if (entry.py) {
			let found = null;
			let from = null;
			for (const python of options.pythons) {
				if (!existsSync(python)) continue;
				const version = moduleVersion(python, entry.py);
				if (version) {
					found = version;
					from = python;
					break;
				}
			}
			if (found) {
				tools.push({ id: entry.id, kind: "python", module: entry.py, interpreter: from, version: found, direction });
				byDirection[direction] = (byDirection[direction] ?? 0) + 1;
			} else notFound.push({ id: entry.id, kind: "python", module: entry.py, direction });
			continue;
		}
		const path = which(entry.binary, entry.paths ?? []);
		if (path) {
			tools.push({ id: entry.id, path, version: versionOf(path, entry.args ?? []), direction });
			byDirection[direction] = (byDirection[direction] ?? 0) + 1;
		} else notFound.push({ id: entry.id, binary: entry.binary, direction });
	}

	const inventory = {
		schema_version: "aegis.local-tool-inventory.v1",
		updated_at: new Date().toISOString().slice(0, 10),
		host: { platform: process.platform, architecture: process.arch, scanned_with: process.execPath },
		policy: {
			discovery_is_not_authorization: true,
			execution_enabled: false,
			network_tools_require_task_scoped_target_authorization: true,
			workspace_is_not_a_sandbox: true,
		},
		by_direction: byDirection,
		tools,
		not_found: notFound,
	};

	if (options.dryRun) {
		console.log(JSON.stringify(inventory, null, 2));
		return;
	}
	writeFileSync(options.out, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
	console.log(`wrote ${tools.length} found / ${notFound.length} missing to ${options.out}`);
	console.log(`  by direction: ${JSON.stringify(byDirection)}`);
	for (const entry of notFound) console.log(`  missing ${entry.id}`);
}

if (
	process.argv[1] &&
	(await import("node:path")).resolve(process.argv[1]) === (await import("node:url")).fileURLToPath(import.meta.url)
) {
	main();
}
