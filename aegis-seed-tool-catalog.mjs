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
import { copyFileSync, existsSync, readFileSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// Second wave: tools installed for the five CTF directions.
//
// Same rules as above: purpose + invocation shape + flags, and a pitfall only
// when it is a real judgement (condition + symptom + correct invocation).
// Everything here starts as `candidate`.
// ---------------------------------------------------------------------------
const SECOND_WAVE = {
	"pwn.ropper": {
		purpose: "搜索 ROP/JOP gadget（ROPgadget 的替代实现，支持 --chain 自动拼链）",
		category: "pwn",
		usage: 'ropper --file <binary> [--search "pop rdi"] [--chain execve] [--nocolor]',
		key_flags: ["--file", "--search", "--chain", "--badbytes", "--opcode"],
		examples: ['ropper --file ./chall --search "pop rdi; ret"', "ropper --file ./chall --chain execve"],
		pitfalls: [
			{
				condition: "输出带颜色控制符，被脚本解析",
				symptom: "grep/awk 匹配不到 gadget",
				correct_invocation: "加 `--nocolor` 再解析",
			},
		],
	},
	"pwn.one_gadget": {
		purpose: "在 libc 中查找一次调用即可 execve('/bin/sh') 的 gadget 偏移",
		category: "pwn",
		usage: "one_gadget <libc.so.6> [--level 1] [--raw]",
		key_flags: ["--level", "--raw", "--near", "--base"],
		examples: ["one_gadget ./libc.so.6", "one_gadget ./libc.so.6 --level 1 --raw"],
		pitfalls: [
			{
				condition: "gadget 列出来了就直接用",
				symptom: "远程打不通：每个 gadget 都有 constraints（如 rsp+0x40 == NULL）",
				correct_invocation: "先看每条 gadget 下方的 constraints，结合当前寄存器/栈状态挑；或先用 --level 1 放宽再验证",
			},
		],
	},
	"pwn.seccomp-tools": {
		purpose: "查看/反汇编程序装载的 seccomp 沙箱规则，确认哪些 syscall 可用",
		category: "pwn",
		usage: "seccomp-tools dump <binary> [--limit N]",
		key_flags: ["dump", "disasm", "emu", "--limit"],
		examples: ["seccomp-tools dump ./chall", "seccomp-tools disasm ./filter.bpf"],
		pitfalls: [
			{
				condition: "在 macOS 上 dump 一个 Linux ELF",
				symptom: "无法运行目标（Mach-O 宿主执行 Linux ELF 失败）",
				correct_invocation: "在 linux/amd64 容器里跑 seccomp-tools，或把目标放到 Docker 中",
			},
			{
				condition: "目标程序需要交互才触发 install",
				symptom: "dump 直接退出，看不到规则",
				correct_invocation: "配合 `--` 传入输入，或先在本地跑通再 dump",
			},
		],
	},
	"pwn.patchelf": {
		purpose: "修改 ELF 的 interpreter/rpath/needed，让题目用指定 libc/ld 运行",
		category: "pwn",
		usage: "patchelf --set-interpreter <ld> --set-rpath <dir> <binary>",
		key_flags: ["--set-interpreter", "--set-rpath", "--replace-needed", "--print-interpreter"],
		examples: [
			"patchelf --set-interpreter ./ld-linux-x86-64.so.2 --set-rpath . ./chall",
			"patchelf --print-interpreter ./chall",
		],
		pitfalls: [
			{
				condition: "set-interpreter 指向的 ld 与 libc 版本不匹配",
				symptom: "程序启动即崩（段错误或在 main 前退出）",
				correct_invocation: "ld 与 libc 必须来自同一发行版/版本；用题目给的 libc 配套 ld",
			},
		],
	},
	"pwn.socat": {
		purpose: "双向数据转发；本地起监听或把 stdin 接到进程",
		category: "pwn",
		usage: "socat - TCP-LISTEN:<port>,fork,reuseaddr  或  socat - EXEC:./chall",
		key_flags: ["TCP-LISTEN", "fork", "reuseaddr", "EXEC", "FILE"],
		examples: ["socat - TCP-LISTEN:9999,reuseaddr,fork EXEC:./chall,pty,raw,echo=0"],
		pitfalls: [
			{
				condition: "只用 EXEC:./chall 交互",
				symptom: "read 卡住或回显异常（没有 pty）",
				correct_invocation: "加 `,pty,raw,echo=0` 提供伪终端",
			},
		],
	},
	"pwn.nc": {
		purpose: "netcat：连远端服务、传文件、起监听",
		category: "pwn",
		usage: "nc <host> <port>   /   nc -lvnp <port>",
		key_flags: ["-l", "-v", "-n", "-p", "-w"],
		examples: ["nc 1.2.3.4 9999", "nc -lvnp 4444"],
		pitfalls: [
			{
				condition: "macOS 自带 nc 与 Linux 版参数不完全一致",
				symptom: "`-e` 不存在，或 `-p` 语义不同",
				correct_invocation: "用 ncat（已装）或 socat 替代依赖 `-e` 的用法",
			},
		],
	},
	"reverse.radare2": {
		purpose: "逆向框架：反汇编、函数/字符串分析、脚本化分析（r2pipe）",
		category: "reverse",
		usage: "r2 -A <binary>  然后 aaa; afl; pdf @ main",
		key_flags: ["-A", "-q", "-c", "aaa", "afl", "pdf", "iz"],
		examples: ["r2 -A -q -c 'aaa; afl; pdf @ main' ./chall", "r2 -q -c 'iz' ./chall"],
		pitfalls: [
			{
				condition: "没跑分析就 afl",
				symptom: "函数列表为空或只有极少数",
				correct_invocation: "先 `aaa`（或启动加 `-A`）",
			},
		],
	},
	"reverse.rizin": {
		purpose: "radare2 的活跃分支；命令基本兼容，解析器更稳",
		category: "reverse",
		usage: "rizin -A <binary>  然后 aaa; afl; pdf @ main",
		key_flags: ["-A", "-q", "-c", "aaa", "afl", "pdf"],
		examples: ["rizin -A -q -c 'aaa; afl' ./chall"],
		pitfalls: [],
	},
	"reverse.ida": {
		purpose: "IDA Pro：反汇编/反编译（Hex-Rays）；GUI 交互或 headless 脚本化",
		category: "reverse",
		usage: "GUI: `ida <binary>`；headless: `idat -A -S<script.py> -L<log> <binary>`",
		key_flags: ["-A", "-S", "-L", "-B", "-c"],
		examples: ["ida ./chall", "idat -A -Sanalyze.py -Lida.log ./chall", "idat -B ./chall"],
		pitfalls: [
			{
				condition: "headless 启动时没有加 -A",
				symptom: "进程停住不动，日志里在等对话框",
				correct_invocation: "headless 一律 `idat -A -S...`；-A 关闭全部弹出对话框",
			},
			{
				condition: "在已激活的 Python venv 里启动 idat",
				symptom: "打印 `sys.prefix ... expected <venv>, got <brew python>` 警告",
				correct_invocation: "先 `deactivate`，或用 `idapyswitch` 指定 IDA 自带的解释器",
			},
		],
	},
	"reverse.dex2jar": {
		purpose: "把 APK/DEX 转成 jar，配合 jadx/jd-gui 看 Java 源码",
		category: "reverse",
		usage: "d2j-dex2jar <input.apk|classes.dex> -o <out.jar>",
		key_flags: ["-o", "--force", "-f"],
		examples: ["d2j-dex2jar app.apk -o app.jar"],
		pitfalls: [
			{
				condition: "直接命令 `dex2jar`",
				symptom: "command not found（homebrew 提供的是 d2j-* 系列）",
				correct_invocation: "用 `d2j-dex2jar`（以及 d2j-apk-sign 等）",
			},
		],
	},
	"reverse.upx": {
		purpose: "UPX 加壳/脱壳；CTF 里多为 `upx -d` 解压题目二进制",
		category: "reverse",
		usage: "upx -d <packed> -o <out>   /   upx <binary>",
		key_flags: ["-d", "-o", "-l", "-t"],
		examples: ["upx -d ./chall -o ./chall.unpacked", "upx -l ./chall"],
		pitfalls: [
			{
				condition: "题目改过 UPX 头（magic 被改）",
				symptom: "`upx -d` 报 `NotPackedException`",
				correct_invocation: "先修回 `UPX!` magic（或在 upx 目录用 `upx -d` 的 -f），再解压",
			},
		],
	},
	"reverse.frida": {
		purpose: "动态插桩：hook 函数、改返回值、绕过检测",
		category: "reverse",
		usage: "frida -U -f <app> -l hook.js   /   frida-trace -U -f <app> -i '*'",
		key_flags: ["-U", "-f", "-l", "--no-pause", "-i"],
		examples: ["frida -U -f com.example.app -l hook.js --no-pause", "frida-trace -U -f com.example.app -i open"],
		pitfalls: [
			{
				condition: "在非越狱 iOS / 未 root Android 上 attach",
				symptom: "连接失败或进程拒绝注入",
				correct_invocation: "用 frida-gadget 重打包，或在模拟器/已 root 设备上操作",
			},
		],
	},
	"web.ffuf": {
		purpose: "高速目录/参数/vhost 爆破，支持过滤与递归",
		category: "web",
		usage: "ffuf -u <url>/FUZZ -w <wordlist> [-mc 200,302] [-fs N] [-t N]",
		key_flags: ["-u", "-w", "-mc", "-fc", "-fs", "-t", "-recursion"],
		examples: [
			"ffuf -u http://host/FUZZ -w /path/dict.txt -mc 200,301,302",
			"ffuf -u http://host/FUZZ -w dict.txt -fs 0",
		],
		pitfalls: [
			{
				condition: "开了自动校准但站点对任意路径都返回 200",
				symptom: "满屏都是命中，无法区分",
				correct_invocation: "用 `-fs`（响应体大小）或 `-fc`（状态码）过滤，先手动请求一次看基线",
			},
		],
	},
	"web.gobuster": {
		purpose: "目录/DNS/vhost 爆破（Go 实现，规则简单）",
		category: "web",
		usage: "gobuster dir -u <url> -w <wordlist> [-x php,html] [-t 30]",
		key_flags: ["dir", "dns", "vhost", "-u", "-w", "-x", "-t", "-k"],
		examples: ["gobuster dir -u http://host/ -w dict.txt -x php,txt", "gobuster vhost -u http://host -w dict.txt"],
		pitfalls: [
			{
				condition: "目标是 https 自签名证书",
				symptom: "报 x509 错误后退出",
				correct_invocation: "加 `-k` 跳过证书校验",
			},
		],
	},
	"web.feroxbuster": {
		purpose: "递归目录爆破，默认带递归与多种扩展名",
		category: "web",
		usage: "feroxbuster -u <url> -w <wordlist> [-x php,html] [-d N]",
		key_flags: ["-u", "-w", "-x", "-d", "--smart", "-C"],
		examples: ["feroxbuster -u http://host -w dict.txt -x php", "feroxbuster -u http://host -w dict.txt -d 3"],
		pitfalls: [
			{
				condition: "站点有大量通配 404 页面",
				symptom: "递归爆炸，跑出成千上万条",
				correct_invocation: "加 `-C <code>` 过滤状态码，或限制 `-d 2`",
			},
		],
	},
	"web.sqlmap": {
		purpose: "SQL 注入检测与利用（含盲注、堆叠、os-shell）",
		category: "web",
		usage: "sqlmap -u '<url>?id=1' --batch [--dbs] [--dump] [--level N] [--risk N]",
		key_flags: ["-u", "-r", "--batch", "--dbs", "--dump", "--level", "--risk", "--tamper"],
		examples: ["sqlmap -u 'http://host/item?id=1' --batch --dbs", "sqlmap -r req.txt --batch --dump -D db -T flag"],
		pitfalls: [
			{
				condition: "默认 --level/--risk 扫描某参数",
				symptom: "明明手工能注，工具报 not injectable",
				correct_invocation: "提高 `--level 3 --risk 2`，或用 `-r` 带原始请求（含 Cookie/Header）",
			},
			{
				condition: "对非授权目标跑 sqlmap",
				symptom: "越权（不是技术失败）",
				correct_invocation: "只对当前任务授权目标使用",
			},
		],
	},
	"web.nuclei": {
		purpose: "基于模板的漏洞扫描（CVE、默认口令、暴露面板）",
		category: "web",
		usage: "nuclei -u <url> [-t <templates>] [-severity critical,high] [-tags cve]",
		key_flags: ["-u", "-l", "-t", "-tags", "-severity", "-rl"],
		examples: ["nuclei -u http://host -severity critical,high", "nuclei -u http://host -tags exposure,default-login"],
		pitfalls: [
			{
				condition: "首次运行未更新模板",
				symptom: "提示模板目录为空或版本过旧",
				correct_invocation: "先 `nuclei -update-templates`",
			},
		],
	},
	"web.nikto": {
		purpose: "Web 服务器配置与已知文件扫描（偏传统）",
		category: "web",
		usage: "nikto -h <url> [-ssl] [-Tuning 123]",
		key_flags: ["-h", "-ssl", "-Tuning", "-o"],
		examples: ["nikto -h http://host", "nikto -h host -ssl -Tuning 123"],
		pitfalls: [
			{
				condition: "对 https 目标不加 -ssl",
				symptom: "连接失败或判定无结果",
				correct_invocation: "`nikto -h host -ssl`（或用 `-h https://...`）",
			},
		],
	},
	"web.mitmproxy": {
		purpose: "中间人代理：拦截/改写 HTTP(S)，配合脚本自动化",
		category: "web",
		usage: "mitmdump -p <port> [-s script.py] [-w out.flow]",
		key_flags: ["-p", "-s", "-w", "-r", "--set"],
		examples: ["mitmdump -p 8080 -w traffic.flow", "mitmdump -p 8080 -s rewrite.py"],
		pitfalls: [
			{
				condition: "抓 HTTPS 但客户端不信任代理证书",
				symptom: "TLS 握手失败，流量为空",
				correct_invocation: "安装 mitmproxy CA（mitm.it），或在脚本里用 `--set ignore_hosts` 排除证书固定目标",
			},
		],
	},
	"crypto.hashcat": {
		purpose: "GPU/CPU 哈希爆破；支持大量算法与规则",
		category: "crypto",
		usage: "hashcat -m <mode> -a <attack> <hashfile> <wordlist|mask>",
		key_flags: ["-m", "-a", "-r", "--show", "-O", "-w"],
		examples: ["hashcat -m 0 -a 0 hashes.txt rockyou.txt", "hashcat -m 1400 -a 3 hashes.txt ?a?a?a?a"],
		pitfalls: [
			{
				condition: "Apple Silicon 上直接用默认后端",
				symptom: "提示没有可用 OpenCL 设备",
				correct_invocation: "`hashcat -I` 确认设备；必要时装 OpenCL 运行时，或退回 `-D 1`（CPU）",
			},
		],
	},
	"crypto.john": {
		purpose: "John the Ripper：口令破解，擅长从多种格式提取哈希",
		category: "crypto",
		usage: "john [--format=<fmt>] <hashfile>   /   john --show <hashfile>",
		key_flags: ["--format", "--wordlist", "--show", "--list"],
		examples: ["john --wordlist=rockyou.txt hashes.txt", "john --show hashes.txt"],
		pitfalls: [
			{
				condition: "不确定格式就直接跑",
				symptom: "报 `No password hashes loaded`",
				correct_invocation: "先 `john --list=formats | grep -i` 找匹配的 --format",
			},
		],
	},
	"crypto.z3": {
		purpose: "SMT 求解器：把约束写成公式直接求解（逆向/裁剪/约束题）",
		category: "crypto",
		usage: "z3 <file.smt2>   或 Python `from z3 import *`",
		key_flags: ["-smt2", "-model", "-T:<sec>"],
		examples: [
			"z3 -smt2 constraints.smt2",
			"python3 -c 'from z3 import Int, Solver; x=Int(\"x\"); s=Solver(); s.add(x*x==49); print(s.check())'",
		],
		pitfalls: [
			{
				condition: "在 3.14 环境里 import z3",
				symptom: "ModuleNotFoundError（wheel 滞后于新 Python）",
				correct_invocation: "用 3.12 的 venv（~/Tools/PyVenv/CTF312）里的 z3-solver",
			},
		],
	},
	"misc.exiftool": {
		purpose: "读写图片/文档元数据；CTF 里常用来找隐藏 comment/EXIF",
		category: "misc",
		usage: "exiftool <file>   /   exiftool -a -u -g1 <file>",
		key_flags: ["-a", "-u", "-g1", "-b", "-j"],
		examples: ["exiftool -a -u -g1 image.jpg", "exiftool -b -ThumbnailImage image.jpg > thumb.jpg"],
		pitfalls: [
			{
				condition: "只看默认字段",
				symptom: "漏掉隐藏/重复标签",
				correct_invocation: "加 `-a -u -g1` 显示全部（含 unknown/重复）标签",
			},
		],
	},
	"misc.zsteg": {
		purpose: "PNG/BMP 的 LSB 隐写检测与提取",
		category: "misc",
		usage: "zsteg [-a] <image.png>   /   zsteg -E <payload> <image>",
		key_flags: ["-a", "-E", "-l", "--bits"],
		examples: ["zsteg -a image.png", "zsteg -E 'b1,rgb,lsb,xy' image.png > out.bin"],
		pitfalls: [
			{
				condition: "对 JPEG 使用 zsteg",
				symptom: "报不支持或无输出",
				correct_invocation: "zsteg 只处理 PNG/BMP；JPEG 用 steghide/jsteg",
			},
		],
	},
	"misc.pngcheck": {
		purpose: "校验 PNG 结构完整性与 chunk 列表",
		category: "misc",
		usage: "pngcheck -v <image.png>   /   pngcheck -t <image.png>",
		key_flags: ["-v", "-t", "-c", "-p"],
		examples: ["pngcheck -v image.png", "pngcheck -t image.png"],
		pitfalls: [],
	},
	"misc.yara": {
		purpose: "按规则匹配文件内容（样本/隐藏字符串定位）",
		category: "misc",
		usage: "yara <rule.yar> <target>   /   yara -s <rule.yar> <target>",
		key_flags: ["-s", "-r", "-i", "-w"],
		examples: ["yara -s rules.yar sample.bin", "yara -r rules.yar ./files/"],
		pitfalls: [
			{
				condition: "规则里写了宽字符串但目标是大端/UTF-16",
				symptom: "规则不命中",
				correct_invocation: "用 `wide` 修饰符或改 `ascii wide` 组合",
			},
		],
	},
	"misc.tesseract": {
		purpose: "OCR：从图片里识别文字（验证码/截图题）",
		category: "misc",
		usage: "tesseract <image> stdout [-l eng+chi_sim] [--psm N]",
		key_flags: ["-l", "--psm", "--oem"],
		examples: ["tesseract captcha.png stdout", "tesseract shot.png stdout -l eng --psm 6"],
		pitfalls: [
			{
				condition: "直接对低对比度/旋转文字跑 OCR",
				symptom: "识别为乱码",
				correct_invocation: "先放大/二值化/去噪（Pillow/OpenCV），并调 `--psm`",
			},
		],
	},
	"misc.foremost": {
		purpose: "按文件头签名雕刻/恢复被删除或嵌入的文件",
		category: "misc",
		usage: "foremost -i <input> -o <outdir> [-t png,jpg,zip]",
		key_flags: ["-i", "-o", "-t", "-T"],
		examples: ["foremost -i disk.img -o out -t png,jpg,zip", "foremost -T -i file.bin -o out"],
		pitfalls: [
			{
				condition: "输出目录已存在且非空",
				symptom: "拒绝执行",
				correct_invocation: "先把输出目录改名或清空；foremost 要求新建目录",
			},
		],
	},
	"misc.steghide": {
		purpose: "JPEG/BMP/WAV 隐写（含口令）",
		category: "misc",
		usage: "steghide extract -sf <file> [-p <passphrase>]",
		key_flags: ["extract", "embed", "-sf", "-p", "-xf"],
		examples: ["steghide extract -sf image.jpg -p ''", "steghide info image.jpg"],
		pitfalls: [
			{
				condition: "用空口令直接 extract",
				symptom: "提示 `could not extract any data with that passphrase`",
				correct_invocation: "先 `steghide info` 看是否真有嵌入；口令常在题面/文件名/其它隐写层",
			},
		],
	},
	"misc.qpdf": {
		purpose: "PDF 结构检查与解密（去限制、解压流）",
		category: "misc",
		usage: "qpdf --check <in.pdf>   /   qpdf --decrypt <in.pdf> <out.pdf>",
		key_flags: ["--check", "--decrypt", "--qdf", "--stream-data"],
		examples: ["qpdf --check flag.pdf", "qpdf --decrypt --stream-data=uncompress in.pdf out.pdf"],
		pitfalls: [],
	},
	"runtime.docker": {
		purpose: "容器运行时：复现与靶机一致的 Linux/libc 环境",
		category: "runtime",
		usage: 'docker run --rm -it -v "$PWD:/w" -w /w <image> <cmd>',
		key_flags: ["run --rm", "-v", "-w", "--platform linux/amd64"],
		examples: ['docker run --rm -it -v "$PWD:/w" -w /w ubuntu:22.04 bash'],
		pitfalls: [
			{
				condition: "Apple Silicon 上跑 x86-64 ELF",
				symptom: "`exec format error`",
				correct_invocation: "加 `--platform linux/amd64`",
			},
		],
	},
	"runtime.colima": {
		purpose: "给 macOS 提供 docker daemon 的轻量 Linux 虚拟机",
		category: "runtime",
		usage: "colima start [--arch x86_64] [--cpu N] [--memory N]",
		key_flags: ["start", "stop", "status", "--arch"],
		examples: ["colima start --arch x86_64", "colima status"],
		pitfalls: [
			{
				condition: "需要 x86-64 容器但 VM 是 arm64",
				symptom: "镜像架构不符，容器起不来",
				correct_invocation: "`colima stop && colima start --arch x86_64`（会重建 VM）",
			},
		],
	},
	"py.crypto": {
		purpose: "PyCryptodome：AES/RSA/哈希等原语（`from Crypto...`）",
		category: "crypto",
		usage: "python3 -c 'from Crypto.Util.number import *'",
		key_flags: [],
		examples: ["from Crypto.Util.number import getPrime, long_to_bytes, inverse"],
		pitfalls: [],
	},
	"py.gmpy2": {
		purpose: "大整数与模运算加速（crypto 脚本的主力）",
		category: "crypto",
		usage: "python3 -c 'import gmpy2; gmpy2.invert(a, n)'",
		key_flags: [],
		examples: ["import gmpy2; gmpy2.iroot(c, e); gmpy2.invert(e, phi)"],
		pitfalls: [],
	},
	"py.sympy": {
		purpose: "符号数学：解方程、离散对数、多项式",
		category: "crypto",
		usage: "python3 -c 'from sympy import *'",
		key_flags: [],
		examples: ["from sympy import symbols, solve, discrete_log"],
		pitfalls: [],
	},
	"py.angr": {
		purpose: "符号执行：自动求解满足校验的输入（逆向题常用）",
		category: "reverse",
		usage: "python3 -c 'import angr; p=angr.Project(\"./chall\")'",
		key_flags: [],
		examples: [
			'p = angr.Project("./chall", auto_load_libs=False); s = p.factory.entry_state(); sm = p.factory.simgr(s); sm.explore(find=0x401234)',
		],
		pitfalls: [
			{
				condition: "在 3.14 环境安装/运行 angr",
				symptom: "安装失败或运行异常（依赖 wheel 滞后）",
				correct_invocation: "用 3.12 venv（~/Tools/PyVenv/CTF312）；angr 10 已内置 claripy，无需单独安装",
			},
		],
	},
	"py.lief": {
		purpose: "ELF/PE/Mach-O 解析与改写（比 pwntools ELF 更底层）",
		category: "reverse",
		usage: "python3 -c 'import lief; b=lief.parse(\"./chall\")'",
		key_flags: [],
		examples: ['import lief; elf = lief.parse("./chall"); print(elf.header.entrypoint)'],
		pitfalls: [],
	},
	"py.pwntools": {
		purpose: "Python 侧的 pwntools：远程交互、ELF/ROP、打包/解包",
		category: "pwn",
		usage: "from pwn import *",
		key_flags: [],
		examples: ['from pwn import *; io=remote("host",9999); io.sendlineafter(b"> ", payload); io.interactive()'],
		pitfalls: [],
	},
	"reverse.jadx": {
		purpose: "DEX/APK 反编译成 Java 源码；也可反编译 smali",
		category: "reverse",
		usage: "jadx [-d <outdir>] <app.apk>   /   jadx -e <app.apk>（导出成 gradle 工程）",
		key_flags: ["-d", "-e", "--no-res", "--show-bad-code", "-j"],
		examples: ["jadx -d out app.apk", "jadx --show-bad-code app.apk"],
		pitfalls: [
			{
				condition: "反编译结果里有大量 `// error` 或缺失方法",
				symptom: "关键逻辑看不到（混淆/复杂控制流）",
				correct_invocation: "加 `--show-bad-code`，或改用 smali（apktool）配合动态调试",
			},
		],
	},
	"reverse.apktool": {
		purpose: "APK 解包/重打包，得到 smali 与资源（改包、去掉检测）",
		category: "reverse",
		usage: "apktool d <app.apk> -o <dir>   /   apktool b <dir> -o out.apk",
		key_flags: ["d", "b", "-o", "-f", "-r"],
		examples: ["apktool d app.apk -o app_src", "apktool b app_src -o patched.apk"],
		pitfalls: [
			{
				condition: "重打包后无法安装",
				symptom: "`INSTALL_PARSE_FAILED_NO_CERTIFICATES`",
				correct_invocation: "重打包后必须重新签名（apksigner/d2j-apk-sign）再安装",
			},
		],
	},
	"py.z3-solver": {
		purpose: "z3 的 Python 绑定：约束建模与求解（逆向/密码题主力）",
		category: "crypto",
		usage: "python3 -c 'from z3 import *'",
		key_flags: [],
		examples: [
			"from z3 import BitVec, Solver; x=BitVec('x',32); s=Solver(); s.add(x*3==0x1234); s.check(); print(s.model())",
		],
		pitfalls: [
			{
				condition: "在 Python 3.14 环境 import z3",
				symptom: "ModuleNotFoundError（wheel 尚未覆盖新解释器）",
				correct_invocation: "用 3.12 venv（~/Tools/PyVenv/CTF312）",
			},
		],
	},
	"py.pillow": {
		purpose: "图像处理：像素级分析、隐写、二维码/验证码预处理",
		category: "misc",
		usage: "python3 -c 'from PIL import Image'",
		key_flags: [],
		examples: ["from PIL import Image; im=Image.open('x.png'); print(im.size, im.mode)"],
		pitfalls: [],
	},
	"py.pyjwt": {
		purpose: "JWT 编解码与签名校验（web 题里伪造/爆破 token）",
		category: "web",
		usage: "python3 -c 'import jwt; print(jwt.decode(token, options={\"verify_signature\": False}))'",
		key_flags: [],
		examples: ['import jwt; print(jwt.decode(token, options={"verify_signature": False}))'],
		pitfalls: [
			{
				condition: "用 pyjwt 校验 alg=none 的 token",
				symptom: "抛 InvalidAlgorithmError（新版本默认拒绝）",
				correct_invocation: '手工 base64 解码判断，或显式传 algorithms=["none"]',
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

const knowledgeFor = (id) => TOOL_KNOWLEDGE[id] ?? EXTRA_KNOWLEDGE[id] ?? SECOND_WAVE[id] ?? null;

function help() {
	console.log(`Usage: node aegis-seed-tool-catalog.mjs [options]

Reads a tool inventory (what exists) and writes a tool catalog (what it is for,
how to invoke it, what goes wrong).

  --inventory PATH   default ${DEFAULT_INVENTORY}
  --catalog PATH     default ${DEFAULT_CATALOG}
  --dry-run          print the catalog, write nothing
  --force            replace an INVALID existing catalog (it is kept as
                     catalog.invalid-<timestamp>.json). Needed to recover from a
                     file the loader now rejects.
  --only IDS         comma-separated inventory ids
  -h, --help         this help

Pitfalls are seeded as candidates: they become confirmed only when a human
confirms a solve. Nothing here grants execution.`);
}

function parseArgs(argv) {
	const options = { inventory: DEFAULT_INVENTORY, catalog: DEFAULT_CATALOG, dryRun: false, only: null, force: false };
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
		else if (arg === "--force") options.force = true;
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
	if (!existing.ok && !options.force) {
		console.error(`existing catalog is invalid, refusing to overwrite:\n  ${existing.errors.join("\n  ")}`);
		console.error("re-run with --force to replace it (the old file is kept as catalog.invalid-<ts>.json)");
		process.exit(1);
	}
	if (!existing.ok && options.force && existsSync(options.catalog)) {
		// Never destroy the file the operator had, even when it is malformed.
		const backup = options.catalog.replace(/\.json$/, `.invalid-${Date.now()}.json`);
		copyFileSync(options.catalog, backup);
		console.error(`existing catalog was invalid; kept a copy at ${backup}`);
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
		// A python module and a CLI can share a name (pwntools ships both). Prefix the
		// module form so the catalog keeps two distinct, addressable tools.
		const id =
			entry.kind === "python"
				? `py-${String(entry.id ?? "").replace(/^py\./, "")}`
				: String(entry.id ?? "").replace(/^[a-z]+\./, "");
		if (options.only && !options.only.includes(entry.id) && !options.only.includes(id)) continue;
		const knowledge = knowledgeFor(entry.id);
		if (!knowledge) {
			skipped.push({ id: entry.id, reason: "no knowledge entry" });
			continue;
		}
		// A python module is reachable through its interpreter, so the interpreter is
		// the executable and the module name is recorded for the model.
		const executable = entry.kind === "python" ? entry.interpreter : executableFor(entry);
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
			...(entry.kind === "python"
				? {
						notes: `python module ${entry.module} in ${entry.interpreter}${entry.version ? ` (version: ${entry.version})` : ""}`,
					}
				: entry.version
					? { notes: `inventory version: ${entry.version}` }
					: {}),
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
