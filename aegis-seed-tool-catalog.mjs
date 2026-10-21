#!/usr/bin/env node
// Seed the tool catalog from a local tool inventory.
//
// The inventory says "this CLI exists at this path with this version". This script
// adds the part a model needs: what the tool is for, how it is invoked, the flags
// that matter, and the pitfalls that have actually bitten.
//
// Split of responsibilities:
//   * the KNOWLEDGE table below is tracked in git - it is generic and reviewable;
//   * the resulting catalog lives in $AEGIS_HOME/tools/catalog.json because the
//     executable paths are machine-specific;
//   * nothing here grants execution. A catalog entry is documentation; calls still
//     go through bash and stay opaque observations.
//
// Pitfalls are seeded as `candidate`. They become `confirmed` only when a human
// confirms a solve in an episode where they were proposed (see docs/TOOL_CATALOG.md).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadToolCatalog, saveToolCatalog } from "./Pi_Agent_base/memory/tool-catalog.mjs";

const DEFAULT_INVENTORY = join(homedir(), ".Aegis", "tools", "ctf", "tool-inventory.json");
const DEFAULT_CATALOG = join(homedir(), ".Aegis", "tools", "catalog.json");

/**
 * Knowledge per inventory id. `usage` is the invocation shape, not a fixed command:
 * the model composes the actual arguments.
 */
export const TOOL_KNOWLEDGE = {
	"pwn.pwntools": {
		purpose: "pwntools 命令行：汇编/反汇编、cyclic 偏移、ELF 补丁、模板生成",
		category: "pwn",
		usage: "pwn <subcommand> [args]   （常用子命令：asm disasm cyclic checksec template elfpatch phd）",
		key_flags: ["pwn asm -c amd64", "pwn disasm", "pwn cyclic -l", "pwn template", "pwn elfpatch"],
		examples: [
			'pwn asm -c amd64 "mov rax, 60; xor rdi, rdi; syscall"',
			"pwn cyclic 200",
			"pwn cyclic -l 0x6161616c",
			"pwn template ./chall > exploit.py",
			"pwn checksec ./chall",
		],
		pitfalls: [
			{
				condition: "目标是 macOS 的 Mach-O（例如 /bin/ls）",
				symptom: "checksec/elfpatch 等子命令报 `Magic number does not match`",
				correct_invocation: "只在 Linux ELF 上使用；Mach-O 用 otool/codesign 或 lldb 分析",
			},
			{
				condition: "用 pwn template 生成脚本后直接运行",
				symptom: "脚本里的 process/remote 依赖当前目录的相对路径，换目录即失败",
				correct_invocation: "在题目目录内运行，或先改 exe/elf 路径再执行",
			},
		],
	},
	"pwn.ropgadget": {
		purpose: "在 ELF 中搜索 ROP/JOP gadget，用于构造 ROP 链",
		category: "pwn",
		usage: 'ROPgadget --binary <file> [--only "pop|ret"] [--depth N] [--badbytes 0a] [--ropchain]',
		key_flags: ["--binary", "--only", "--filter", "--depth", "--badbytes", "--ropchain", "--range"],
		examples: [
			'ROPgadget --binary ./chall --only "pop|ret"',
			'ROPgadget --binary ./chall --only "pop|ret" --badbytes 0a0d',
			"ROPgadget --binary ./chall --depth 8",
		],
		pitfalls: [
			{
				condition: "把二进制路径当位置参数传给 ROPgadget",
				symptom: "提示缺少参数或没有任何输出",
				correct_invocation: "必须显式 `--binary ./chall`",
			},
			{
				condition: "输入是 32 位 ELF 但只想找 `int 0x80` 链",
				symptom: "默认输出里混入大量 x86-64 syscall gadget，人工筛选很慢",
				correct_invocation: '加 `--only "int|ret"`，并按需要加 `--multibr` 或不加',
			},
		],
	},
	"pwn.checksec": {
		purpose: "检查 ELF 的防护（NX / PIE / Canary / RELRO / Fortify）",
		category: "pwn",
		usage: "checksec <elf...>   （pwntools 入口点，等价于 pwn checksec）",
		key_flags: ["--file"],
		examples: ["checksec ./chall", "checksec --file ./chall"],
		pitfalls: [
			{
				condition: "目标是 Mach-O 或 PE，而不是 Linux ELF",
				symptom: "报 `Magic number does not match`",
				correct_invocation: "只在 ELF 上使用；其它格式改用 objdump/otool/lldb",
			},
		],
	},
	"reverse.binwalk": {
		purpose: "按文件头签名扫描固件/镜像，递归提取嵌入的文件系统与压缩包",
		category: "reverse",
		usage: "binwalk [-e] [-M] [-C] <file>",
		key_flags: ["-e", "--extract", "-M", "--matryoshka", "-C", "-A"],
		examples: ["binwalk firmware.bin", "binwalk -e firmware.bin", "binwalk -eM firmware.bin"],
		pitfalls: [
			{
				condition: "binwalk 3.x 下直接 `binwalk -e file` 但没装解压后端",
				symptom: "提取目录里只有空壳，或提示缺失 `sasquatch`/`unsquashfs`",
				correct_invocation: "先 `binwalk file` 看签名，再按签名缺什么装什么；必要时手工 `dd` 按 offset 切",
			},
		],
	},
	"network.nmap": {
		purpose: "端口与服务探测，确认靶场开放面和版本",
		category: "web",
		usage: "nmap -sV -p <ports> <target>   （对授权目标使用）",
		key_flags: ["-sV", "-p", "-sC", "-Pn", "-T4", "--script"],
		examples: ["nmap -Pn -p 1-10000 host", "nmap -sV -p 80,443 host"],
		pitfalls: [
			{
				condition: "对未授权的公网地址扫描",
				symptom: "越过当前任务授权范围（不是技术失败，是权限问题）",
				correct_invocation: "只扫当前题目 manifest/用户明确给出的 target 与端口",
			},
		],
	},
	"debug.gdb": {
		purpose: "调试器：断点、寄存器/内存查看、ROP 调试；常配合 pwndbg/GEF",
		category: "pwn",
		usage: "gdb [-q] <binary> [-ex 'cmd']",
		key_flags: ["-q", "-ex", "-batch", "--args"],
		examples: ["gdb -q ./chall", "gdb -q ./chall -ex 'b *main' -ex run -ex 'info registers'"],
		pitfalls: [
			{
				condition: "在 macOS 上用 homebrew gdb 调试本地二进制",
				symptom: "因代码签名/权限报 `Unable to find Mach task port`",
				correct_invocation: "用 lldb 调试 Mach-O；gdb 只用于 Linux ELF（或容器内）",
			},
		],
	},
	"debug.lldb": {
		purpose: "macOS 原生调试器；也可调试 x86 ELF（有限）",
		category: "reverse",
		usage: "lldb [-o 'cmd'] -- <binary> [args]",
		key_flags: ["-o", "-b", "-O"],
		examples: ["lldb -- ./chall", "lldb -o 'b main' -o run -- ./chall"],
		pitfalls: [
			{
				condition: "需要在 Linux 靶机上复现 glibc 行为",
				symptom: "lldb 下的 libc/ld 与靶机不同，偏移对不上",
				correct_invocation: "改用与靶机一致的容器 + gdb/pwndbg，或提供对应 libc 后 pwninit 修补",
			},
		],
	},
	"runtime.docker": {
		purpose: "容器运行时；用于搭与靶机一致的 Linux 环境（同 libc/同架构）",
		category: "pwn",
		usage: 'docker run --rm -it -v "$PWD:/w" -w /w <image> <cmd>',
		key_flags: ["run --rm", "-v", "-w", "--platform linux/amd64", "exec"],
		examples: [
			'docker run --rm -it -v "$PWD:/w" -w /w ubuntu:22.04 bash',
			'docker run --rm --platform linux/amd64 -v "$PWD:/w" -w /w ubuntu:20.04 ./chall',
		],
		pitfalls: [
			{
				condition: "Apple Silicon 上跑 x86-64 ELF",
				symptom: "`exec format error`",
				correct_invocation: "加 `--platform linux/amd64`，并确认 Docker Desktop/colima 已启用 Rosetta 或 qemu",
			},
			{
				condition: "容器内访问宿主机文件",
				symptom: "文件不存在或权限错误",
				correct_invocation: '用 `-v "$PWD:/w" -w /w` 显式挂载题目目录',
			},
		],
	},
	"runtime.colima": {
		purpose: "macOS 上的轻量 Linux 虚拟机运行时（给 docker 提供 daemon）",
		category: "general",
		usage: "colima start [--arch x86_64] [--cpu N] [--memory N]",
		key_flags: ["start", "stop", "status", "--arch", "--cpu", "--memory"],
		examples: ["colima start", "colima start --arch x86_64", "colima status"],
		pitfalls: [
			{
				condition: "需要 x86-64 容器而 colima 默认用宿主架构",
				symptom: "镜像是 x86_64 但容器起不来或极慢",
				correct_invocation: "`colima start --arch x86_64`（会重建 VM，先 `colima stop`）",
			},
		],
	},
};

/** Inventory ids whose CLI binary differs from the dotted id. */
const BINARY_HINTS = {
	"pwn.pwntools": ["pwn"],
	"pwn.ropgadget": ["ROPgadget", "ropgadget"],
	"pwn.checksec": ["checksec"],
	"reverse.binwalk": ["binwalk"],
	"network.nmap": ["nmap"],
	"debug.gdb": ["gdb"],
	"debug.lldb": ["lldb"],
	"runtime.docker": ["docker"],
	"runtime.colima": ["colima"],
	"pwn.pwninit": ["pwninit"],
};

const EXTRA_KNOWLEDGE = {
	"pwn.pwninit": {
		purpose: "为 pwn 题准备运行环境：修补二进制里的 libc/ld 路径并生成启动脚本",
		category: "pwn",
		usage: "pwninit [--bin <binary>] [--libc <libc.so.6>] [--ld <ld.so>] [--no-template]",
		key_flags: ["--bin", "--libc", "--ld", "--no-template"],
		examples: ["pwninit --bin ./chall --libc ./libc.so.6 --ld ./ld-linux-x86-64.so.2"],
		pitfalls: [
			{
				condition: "题目给了 libc 但没给 ld",
				symptom: "修补后程序起不来（找不到解释器或版本不符）",
				correct_invocation: "用与 libc 同版本的 ld（可从对应发行版容器里取），或改用 patchelf 手动指定",
			},
		],
	},
};

const knowledgeFor = (id) => TOOL_KNOWLEDGE[id] ?? EXTRA_KNOWLEDGE[id] ?? null;

function help() {
	console.log(`Usage: node aegis-seed-tool-catalog.mjs [options]

Reads a tool inventory (what exists) and writes a tool catalog (what it is for,
how to invoke it, what goes wrong).

  --inventory PATH   default ${DEFAULT_INVENTORY}
  --catalog PATH     default ${DEFAULT_CATALOG}
  --dry-run          print the catalog, write nothing
  --only IDS         comma-separated inventory ids
  -h, --help         this help

Pitfalls are seeded as candidates: they become confirmed only when a human
confirms a solve. Nothing here grants execution.`);
}

function parseArgs(argv) {
	const options = { inventory: DEFAULT_INVENTORY, catalog: DEFAULT_CATALOG, dryRun: false, only: null };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const value = () => {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
			i += 1;
			return next;
		};
		if (arg === "--inventory") options.inventory = value();
		else if (arg === "--catalog") options.catalog = value();
		else if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--only")
			options.only = value()
				.split(",")
				.map((entry) => entry.trim());
		else if (arg === "--help" || arg === "-h") options.help = true;
		else throw new Error(`unknown option: ${arg}`);
	}
	return options;
}

/** Pick the real executable for an inventory row. */
function executableFor(entry) {
	const candidates = BINARY_HINTS[entry.id] ?? [entry.id.split(".").pop()];
	if (typeof entry.path === "string" && existsSync(entry.path)) return entry.path;
	for (const name of candidates) {
		if (typeof entry.path !== "string") continue;
		const dir = dirname(entry.path);
		const guess = join(dir, name);
		if (existsSync(guess)) return guess;
	}
	return null;
}

function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(String(error instanceof Error ? error.message : error));
		help();
		process.exit(2);
	}
	if (options.help) return help();

	if (!existsSync(options.inventory)) {
		console.error(`inventory not found: ${options.inventory}`);
		process.exit(1);
	}
	const inventory = JSON.parse(readFileSync(options.inventory, "utf8"));
	const existing = loadToolCatalog(options.catalog);
	if (!existing.ok) {
		console.error(`existing catalog is invalid, refusing to overwrite:\n  ${existing.errors.join("\n  ")}`);
		process.exit(1);
	}

	// Keep any note a human already confirmed; a reseed must not downgrade knowledge.
	const confirmedByTool = new Map();
	for (const tool of existing.catalog.tools) {
		const confirmed = (tool.pitfalls ?? []).filter((note) => note.status === "confirmed");
		if (confirmed.length > 0) confirmedByTool.set(tool.id, confirmed);
	}

	const tools = [];
	const skipped = [];
	for (const entry of inventory.tools ?? []) {
		const id = String(entry.id ?? "").replace(/^[a-z]+\./, "");
		if (options.only && !options.only.includes(entry.id) && !options.only.includes(id)) continue;
		const knowledge = knowledgeFor(entry.id);
		if (!knowledge) {
			skipped.push({ id: entry.id, reason: "no knowledge entry" });
			continue;
		}
		const executable = executableFor(entry);
		if (!executable) {
			skipped.push({ id: entry.id, reason: "executable not found" });
			continue;
		}
		const known = confirmedByTool.get(id) ?? [];
		const pitfalls = [
			...known,
			...(knowledge.pitfalls ?? []).filter(
				(note) => !known.some((prior) => prior.condition === note.condition && prior.symptom === note.symptom),
			),
		].map((note) => ({ ...note, status: note.status ?? "candidate" }));
		tools.push({
			schema_version: "1.0",
			id,
			purpose: knowledge.purpose,
			category: knowledge.category,
			executable,
			interface: {
				usage: knowledge.usage,
				key_flags: knowledge.key_flags ?? [],
				examples: knowledge.examples ?? [],
			},
			pitfalls,
			...(entry.version ? { notes: `inventory version: ${entry.version}` } : {}),
			updated_at: new Date().toISOString(),
		});
	}

	// pwninit is not always installed; only offer it when the binary exists.
	const pwninit = EXTRA_KNOWLEDGE["pwn.pwninit"];
	if (pwninit && !tools.some((tool) => tool.id === "pwninit")) {
		for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
			const candidate = join(dir, "pwninit");
			if (!existsSync(candidate)) continue;
			tools.push({
				schema_version: "1.0",
				id: "pwninit",
				purpose: pwninit.purpose,
				category: pwninit.category,
				executable: candidate,
				interface: { usage: pwninit.usage, key_flags: pwninit.key_flags, examples: pwninit.examples },
				pitfalls: (pwninit.pitfalls ?? []).map((note) => ({ ...note, status: note.status ?? "candidate" })),
				updated_at: new Date().toISOString(),
			});
			break;
		}
	}

	tools.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const catalog = { schema_version: "1.0", tools, updated_at: new Date().toISOString() };

	if (options.dryRun) {
		console.log(JSON.stringify(catalog, null, 2));
		console.log(`\ndry run: ${tools.length} tool(s); skipped ${skipped.length}`);
		for (const entry of skipped) console.log(`  skipped ${entry.id}: ${entry.reason}`);
		return;
	}
	saveToolCatalog(options.catalog, catalog);
	console.log(`wrote ${tools.length} tool(s) to ${options.catalog}`);
	for (const tool of tools) console.log(`  ${tool.id}  ${tool.interface.usage}`);
	for (const entry of skipped) console.log(`  skipped ${entry.id}: ${entry.reason}`);
	console.log("\nNext: run an experiment; the model reads this through aegis_toolbox.");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	main();
}
