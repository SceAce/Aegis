#!/usr/bin/env python3
"""Build hand-written technique cards from the local CTF wiki.

Source of truth: the CARDS list below (human-authored). Outputs:
  knowledge/techniques/cards/<id>.md     readable source (compiled to seeds/)
  knowledge/techniques/cards.json        contest hint cards (verified hints)
  knowledge/techniques/seeds/<id>.json   document-seed-1 for Observer RAG

Trust: `status=verified` means a human reviewed the hint, NOT that a task
outcome was verified. Seeds stay verified=false / action_policy=none.
"""
import json
import pathlib
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
OUT = pathlib.Path(__file__).resolve().parent
WIKI = "https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875"


def w(path, section=""):
    base = f"{WIKI}/{path}"
    return f"{base}#{section}" if section else base


CARDS = [
    # ------------------------------------------------------------------ crypto
    {
        "id": "crypto-rsa-common-modulus",
        "title": "RSA 共模攻击（同一 n，多组 e）",
        "category": "crypto",
        "when": ["rsa", "same_modulus"],
        "sources": [w("docs/zh/docs/crypto/asymmetric/rsa/rsa_module_attack.md", "共模攻击")],
        "when_text": "两组或多组密文使用同一个 n，但 e 不同（e1,e2 通常互素）；明文相同或相关。",
        "steps": [
            "确认 n 相同且 gcd(e1,e2)=1；若 gcd>1，先约分或换一对。",
            "用扩展欧几里得求 a,b 使 a*e1+b*e2=1。",
            "m = c1^a * c2^b mod n；负指数用模逆（pow(c,-1,n)）。",
            "把 m 转 bytes，检查可打印/结构（JSON、flag 格式、padding）。",
        ],
        "expect": "m 重新用 e1/e2 加密分别得到 c1/c2；明文结构合理。",
        "pitfalls": "gcd(e1,e2)!=1 时不能直接套；负指数必须先求逆；明文可能带 PKCS#1 填充。",
    },
    {
        "id": "crypto-rsa-low-exponent",
        "title": "RSA 低加密指数（m^e < n）",
        "category": "crypto",
        "when": ["rsa", "small_e"],
        "sources": [w("docs/zh/docs/crypto/asymmetric/rsa/rsa_e_attack.md", "低加密指数攻击")],
        "when_text": "e 很小（常见 3），且明文短、没有填充，c = m^e 未发生模回绕。",
        "steps": [
            "先算 c 的整数 e 次根；能开尽就直接得 m。",
            "开不尽则试 m = iroot(c + k*n, e)，k 从小范围枚举。",
            "多接收方/多密文时先 CRT 合并再开根（Håstad）。",
            "把 m 转 bytes 并检查结构；若带固定 padding，改用 Coppersmith。",
        ],
        "expect": "m^e == c（或 CRT 合并后的值）；明文可解析。",
        "pitfalls": "有 padding 时不能直接开根；k 的枚举要有上限，否则是盲目爆破。",
    },
    {
        "id": "crypto-rsa-hastad-broadcast",
        "title": "RSA 广播攻击（同明文，多模数，小 e）",
        "category": "crypto",
        "when": ["rsa", "same_message", "small_e"],
        "sources": [w("docs/zh/docs/crypto/asymmetric/rsa/rsa_e_attack.md", "低加密指数广播攻击")],
        "when_text": "同一明文用不同 n_i、同一小 e 加密给多个接收方。",
        "steps": [
            "确认各组 e 相同、n_i 两两互素。",
            "对 c_i 做 CRT 得到 C = m^e mod prod(n_i)。",
            "若 prod(n_i) > m^e，直接整数开 e 次根得到 m。",
            "若已知线性 padding，用 Coppersmith 求小根而不是硬开根。",
        ],
        "expect": "开根结果的 e 次方等于 CRT 合并值；明文结构合理。",
        "pitfalls": "n_i 不互素时先 gcd 分解；e 大于接收方数量时普通 CRT 不够。",
    },
    {
        "id": "crypto-lcg-recover",
        "title": "LCG 参数恢复与预测",
        "category": "crypto",
        "when": ["lcg"],
        "sources": [w("docs/zh/docs/crypto/streamcipher/lcg/intro.md")],
        "when_text": "输出满足 x_{i+1} = (a*x_i + c) mod m；参数或高位/低位可能部分未知。",
        "steps": [
            "先由连续差分的 gcd 恢复 m（或题目已给 m）。",
            "用三组连续值解线性方程求 a,c；模不互素时多取几组。",
            "输出被截断时，把已知位当作约束，枚举未知低位/高位。",
            "恢复后预测下一输出，并检查与已知序列一致。",
        ],
        "expect": "重放已知序列完全一致，预测值与下一组观测一致。",
        "pitfalls": "模数未知且差分 gcd 不唯一时不要武断；截断位数决定枚举成本。",
    },
    {
        "id": "crypto-aes-mode-misuse",
        "title": "AES 模式误用（ECB / CBC）",
        "category": "crypto",
        "when": ["aes", "ecb"],
        "sources": [w("docs/zh/docs/crypto/blockcipher/aes.md"), w("docs/zh/docs/crypto/blockcipher/mode/cbc.md")],
        "when_text": "ECB 出现重复块；CBC 有可控 IV/明文且无认证；或存在 padding oracle。",
        "steps": [
            "ECB：找相同密文块，重排/拼接块，观察明文结构或权限字段。",
            "CBC 位翻转：改 C_{i-1} 的字节，精确翻转 P_i 的对应字节（保留后续块损坏）。",
            "CBC IV 可控时翻转首块；有 padding oracle 时按字节恢复明文。",
            "每次改动后只提交一次，记录服务端响应差异。",
        ],
        "expect": "目标字段按预期改变（如 role=admin），且 MAC/认证未被触发。",
        "pitfalls": "有 AEAD/MAC 时位翻转会失败；padding oracle 探测要控制请求量。",
    },
    {
        "id": "crypto-xor-known-plaintext",
        "title": "重复密钥 XOR 与已知明文",
        "category": "crypto",
        "when": ["xor", "repeating_key"],
        "sources": [w("docs/zh/docs/crypto/attack-summary/bit-attack.md")],
        "when_text": "密文由明文与短密钥循环异或；明文是自然语言、JSON、文件头或已知格式。",
        "steps": [
            "用已知明文/文件头 crib 推密钥片段；滑动 crib 找最长匹配。",
            "用汉明距离或重合指数估计密钥长度，再按列做单字节频率分析。",
            "恢复候选密钥后解密，检查可打印率、词频和格式。",
            "把结果与文件魔数/JSON 结构交叉验证。",
        ],
        "expect": "解密文本可读且 crib 位置一致；再加密回原密文。",
        "pitfalls": "密钥长度估计会误判；短文本频率分析不可靠，优先用 crib。",
    },
    # --------------------------------------------------------------------- web
    {
        "id": "web-sqli-union-blind",
        "title": "SQL 注入：联合查询与盲注",
        "category": "web",
        "when": ["http", "sqli"],
        "sources": [w("docs/zh/docs/web/sqli.md")],
        "when_text": "输入进入 SQL 且回显/报错/布尔/时间差异可控；参数可能是数字或字符串。",
        "steps": [
            "先用单引号、注释、算术表达式确认注入点和数据库类型。",
            "联合查询：ORDER BY 或 UNION SELECT 探列数与回显位。",
            "无回显时用布尔/时间盲注逐字符取 information_schema/表/列/值。",
            "用十六进制或 CHAR() 绕过引号过滤；记录每个字符的判定条件。",
        ],
        "expect": "按同一 payload 稳定得到库名/表名/目标值，且与页面差异一致。",
        "pitfalls": "WAF 会改写关键字；盲注速率要有上限，别把时间盲注写成爆破。",
    },
    {
        "id": "web-ssrf-internal",
        "title": "SSRF：让服务端访问内部资源",
        "category": "web",
        "when": ["http", "ssrf"],
        "sources": [w("docs/zh/docs/web/ssrf.md")],
        "when_text": "URL/图片/回调参数由服务端发起请求；可指定 host、端口、scheme。",
        "steps": [
            "先确认请求由服务端发出（DNS/HTTP 回调或时间差异）。",
            "测 localhost/内网段/云元数据地址；试 file://、gopher://、dict://。",
            "绕过 allowlist：十进制/八进制 IP、短域名、DNS rebinding、重定向。",
            "用返回内容或带外通道确认读到的内部响应。",
        ],
        "expect": "拿到只在内网可达的响应/元数据，或用带外请求证明服务端访问。",
        "pitfalls": "云元数据可能要求特定 header；gopher 能构造多协议请求但要按目标协议编码。",
    },
    {
        "id": "web-xss-execution",
        "title": "XSS：上下文相关的执行",
        "category": "web",
        "when": ["http", "xss"],
        "sources": [w("docs/zh/docs/web/xss.md")],
        "when_text": "用户输入回显到 HTML/属性/JS/URL；可能有 CSP、HttpOnly、存储型入口。",
        "steps": [
            "先判断上下文：HTML 文本、属性值、script 字符串、URL。",
            "按上下文闭合标签/引号，避免被转义；先弹窗/写 DOM 验证执行。",
            "检查 CSP 与 cookie 标志；存储型要确认持久化和触发页面。",
            "用浏览器或 headless 实际执行验证，而不是只看源码。",
        ],
        "expect": "在真实渲染环境中执行到目标 JS（弹窗/请求回调），且不是仅字符串反射。",
        "pitfalls": "CSP 会阻止 inline；HttpOnly 下改打 CSRF/账户操作而不是偷 cookie。",
    },
    {
        "id": "web-csrf-state-change",
        "title": "CSRF：利用已认证会话",
        "category": "web",
        "when": ["http", "csrf"],
        "sources": [w("docs/zh/docs/web/csrf.md")],
        "when_text": "状态变更请求只靠 cookie 认证，缺少 CSRF token 或 SameSite 防护。",
        "steps": [
            "找状态变更端点（改密、加管理员、转账），确认参数可预测。",
            "检查 token/Referer/Origin/SameSite 校验；尝试去掉 token 或复用。",
            "构造跨站表单/请求，在已登录会话中触发。",
            "从服务端状态变化确认效果（而不是只看响应码）。",
        ],
        "expect": "服务端状态真的改变；重复触发不会产生未预期副作用。",
        "pitfalls": "SameSite=Lax 会拦跨站 POST；JSON 端点可能需要 text/plain 或 form 编码。",
    },
    {
        "id": "web-php-type-juggle",
        "title": "PHP 常见陷阱：类型混淆与反序列化",
        "category": "web",
        "when": ["php", "type_juggle"],
        "sources": [w("docs/zh/docs/web/php/php.md")],
        "when_text": "源码可见或可推断；出现 == 比较、preg_replace /e、unserialize、文件包含/包装器。",
        "steps": [
            "找松散比较（0e、数组、null）和 hash 比较，构造满足条件的输入。",
            "unserialize：找 POP 链（__destruct/__wakeup/__toString），控制属性触发危险调用。",
            "文件包含：用 php://filter 读源码，或日志/临时文件包含。",
            "包装器：data://、php://input、phar:// 视配置而定。",
        ],
        "expect": "用最小输入触发目标分支（读源码/写文件/绕过比较），并有可重复的响应。",
        "pitfalls": "PHP 8 收紧了部分比较和 /e；phar 需要能上传文件并触发文件操作。",
    },
    # --------------------------------------------------------------------- pwn
    {
        "id": "pwn-stack-ret2libc",
        "title": "栈溢出与 ret2libc / ROP",
        "category": "pwn",
        "when": ["elf", "stack_overflow"],
        "sources": [w("docs/zh/docs/pwn/linux/user-mode/stackoverflow/x86/stackoverflow-basic.md"), w("docs/zh/docs/pwn/linux/user-mode/stackoverflow/x86/basic-rop.md")],
        "when_text": "存在栈溢出、无 canary 或可绕过；NX 开启，需要 ROP/ret2libc。",
        "steps": [
            "checksec：确认 canary/NX/PIE/RELRO；用 cyclic 找返回地址偏移。",
            "有 puts/read 等泄漏函数时先泄 libc 地址，算 libc base。",
            "用 ROP 调 system('/bin/sh')；注意 64 位栈对齐（ret gadget）。",
            "无 libc 时考虑 ret2dlresolve 或 syscall ROP。",
        ],
        "expect": "拿到 shell 或读出目标文件；地址与 libc 版本一致。",
        "pitfalls": "PIE 下先泄基址；不同 libc 的偏移不同，别猜。",
    },
    {
        "id": "pwn-format-string",
        "title": "格式化字符串：泄漏与任意写",
        "category": "pwn",
        "when": ["elf", "format_string"],
        "sources": [w("docs/zh/docs/pwn/linux/user-mode/fmtstr/fmtstr-exploit.md")],
        "when_text": "用户输入直接作为 printf 格式串；可控制参数位置。",
        "steps": [
            "用 %p 序列确定输入在栈上的偏移。",
            "泄漏 canary/PIE/libc/栈地址；按需多次触发。",
            "用 %n/%hn 写 GOT/返回地址/钩子；pwntools fmtstr_payload 生成。",
            "写完后触发目标函数或返回，验证控制流/值改变。",
        ],
        "expect": "目标地址的值按预期改变（GOT 指向 system、返回地址跳 shellcode/one_gadget）。",
        "pitfalls": "写入字节数很大时用 %hn 分段；FORTIFY 可能拦 %n。",
    },
    {
        "id": "pwn-heap-tcache-uaf",
        "title": "堆：UAF / tcache 投毒",
        "category": "pwn",
        "when": ["elf", "heap", "uaf"],
        "sources": [w("docs/zh/docs/pwn/linux/user-mode/heap/ptmalloc2/heap-overview.md"), w("docs/zh/docs/pwn/linux/user-mode/heap/ptmalloc2/tcache-attack.md")],
        "when_text": "存在 use-after-free/double-free；能控制 chunk 内容；glibc 版本已知或可泄。",
        "steps": [
            "先确认 glibc 版本与 chunk 大小/数量；tcache 与 fastbin 行为不同。",
            "UAF 后改 fd 指向目标（__free_hook、__malloc_hook、栈）；2.32+ 处理 safe-linking。",
            "用 malloc 两次拿到目标地址，写入 one_gadget/system。",
            "若目标是任意读，先把 chunk 链到 GOT/栈再分配。",
        ],
        "expect": "分配器返回受控地址，写入后触发目标（hook 被调用/返回地址被改）。",
        "pitfalls": "safe-linking 需要先泄 heap 地址；不同 glibc 的 hook 可能已移除（2.34+）。",
    },
    {
        "id": "pwn-canary-bypass",
        "title": "Canary 泄漏与绕过",
        "category": "pwn",
        "when": ["elf", "canary"],
        "sources": [w("docs/zh/docs/pwn/linux/user-mode/mitigation/canary.md")],
        "when_text": "栈溢出但 canary 开启；存在读原语（printf/puts/写回显）或 fork 子进程。",
        "steps": [
            "找泄漏点读 canary（格式化串、越界读、puts 未截断）。",
            "fork 服务可逐字节爆破 canary（保留低字节 0x00）。",
            "溢出时把 canary 原样放回，再覆盖返回地址。",
            "验证 canary 未触发 __stack_chk_fail。",
        ],
        "expect": "程序走到目标返回/函数，未触发 stack smashing detected。",
        "pitfalls": "每次连接 canary 会变；爆破要用同一进程/fork 模型。",
    },
    {
        "id": "pwn-pie-aslr-leak",
        "title": "PIE / ASLR 地址泄漏与部分覆盖",
        "category": "pwn",
        "when": ["elf", "pie"],
        "sources": [w("docs/zh/docs/pwn/linux/user-mode/stackoverflow/x86/stack-intro.md")],
        "when_text": "PIE 开启；有栈/格式化/堆泄漏，或可做部分返回地址覆盖。",
        "steps": [
            "先用任意读泄一个代码/栈/libc 指针，算基址。",
            "只有部分覆盖时，利用同一页内的低 12 位固定特性改写低 1-2 字节。",
            "GOT 可写（Partial RELRO）时改 GOT；否则打返回地址/栈。",
            "每次泄漏后重新计算，不要复用旧基址。",
        ],
        "expect": "目标地址落在正确页内，控制流/调用到达预期函数。",
        "pitfalls": "ASLR 每次运行变化；部分覆盖要保证目标与当前地址同页。",
    },
    # ----------------------------------------------------------------- reverse
    {
        "id": "rev-static-triage",
        "title": "二进制静态分诊（先看全局）",
        "category": "reverse",
        "when": ["binary", "unfamiliar"],
        "sources": [w("docs/zh/docs/reverse/introduction.md")],
        "when_text": "拿到未知二进制/固件片段；先判断格式、架构、语言、保护、入口和输入面。",
        "steps": [
            "file/checksec，确认 ELF/Mach-O/PE、架构、位数、保护。",
            "strings 找提示、flag 格式、错误信息、库/语言特征；readelf/otool 看段与导入。",
            "定位 main/输入读取/比较逻辑；先画数据流，不急着逐指令读。",
            "判断是否加壳/混淆/自修改，再决定动态或符号执行。",
        ],
        "expect": "能说明输入从哪进、在哪比较、成功路径大致在哪。",
        "pitfalls": "strings 可能被混淆；静态结论要用动态断点验证。",
    },
    {
        "id": "rev-anti-debug",
        "title": "反调试识别与绕过",
        "category": "reverse",
        "when": ["binary", "anti_debug"],
        "sources": [w("docs/zh/docs/reverse/platform/linux/detect-dbg.md"), w("docs/zh/docs/reverse/platform/windows/anti-debug/isdebuggerpresent.md")],
        "when_text": "调试时程序退出/走假分支；出现 ptrace、IsDebuggerPresent、时间差、异常处理检查。",
        "steps": [
            "定位反调试调用（ptrace(PTRACE_TRACEME)、IsDebuggerPresent、NtQueryInformationProcess）。",
            "静态 patch 返回值/跳转，或用 LD_PRELOAD/Frida hook。",
            "时间差检测用断点后改时钟/跳过比较；异常检测注意调试器异常配置。",
            "绕过后再验证真实逻辑是否可达。",
        ],
        "expect": "断点能停在目标逻辑，程序不再因调试器退出。",
        "pitfalls": "多处反调试要一起处理；patch 后要重算校验和。",
    },
    {
        "id": "rev-control-flow-flatten",
        "title": "控制流平坦化还原",
        "category": "reverse",
        "when": ["binary", "control_flow_flatten"],
        "sources": [w("docs/zh/docs/reverse/obfuscate/control-flow-flatten.md")],
        "when_text": "函数体是一个 dispatcher + 状态变量 + switch/if 链；基本块被重排。",
        "steps": [
            "找 dispatcher（大 switch/间接跳转）和状态变量赋值。",
            "按状态值抽取基本块，恢复块间转移关系。",
            "用符号执行/动态 trace（angr、Triton、Frida Stalker）辅助恢复。",
            "恢复后用输入验证路径与原程序一致。",
        ],
        "expect": "还原后的控制流能解释输入检查，且与原二进制行为一致。",
        "pitfalls": "状态变量可能被编码；不要手工重写全部逻辑，先恢复关键比较段。",
    },
    {
        "id": "rev-go-rust-runtime",
        "title": "Go / Rust 二进制逆向",
        "category": "reverse",
        "when": ["binary", "go_binary"],
        "sources": [w("docs/zh/docs/reverse/language/go/introduction.md"), w("docs/zh/docs/reverse/language/rust/introduction.md")],
        "when_text": "二进制含 Go/Rust 运行时特征（gopclntab、panic 字符串、mangled symbols）。",
        "steps": [
            "Go：用 go tool nm/objdump 或 GoReSym 恢复符号；strings 找 main.* 与错误信息。",
            "Rust：找 panic/格式化字符串和 mangled 符号；关注 main 与自定义 crate 名。",
            "从字符串/符号定位输入解析、比较和加密函数。",
            "动态断点验证关键分支。",
        ],
        "expect": "定位到输入处理和判定函数，并解释成功条件。",
        "pitfalls": "strip 后符号可能只剩 pclntab；Rust 泛型会生成大量重复代码。",
    },
    {
        "id": "rev-constant-permutation-table",
        "title": "常量表 / 置换表反推",
        "category": "reverse",
        "when": ["binary", "constant_table"],
        "sources": [w("docs/zh/docs/reverse/introduction.md")],
        "when_text": "二进制里有连续的 0..n-1 小组（置换）、S-box 或常量数组，可能编码了字节/索引。",
        "steps": [
            "在 __const/.rodata/__TEXT 中找连续且每 n 个一组、元素恰为 0..n-1 的序列。",
            "对每组计算字典序/Lehmer 排名得到索引；索引可能取模或加常数映射到字节。",
            "用可打印字符/常见 flag 格式过滤候选。",
            "把候选重新编码回置换表，确认与原表一致。",
        ],
        "expect": "候选字节重编码后与原常量表逐项一致，且文本可读。",
        "pitfalls": "表可能有头部/对齐填充；先确认分组起点再排名。",
    },
    # -------------------------------------------------------------------- misc
    {
        "id": "misc-encoding-chain",
        "title": "编码链识别与逐层解码",
        "category": "misc",
        "when": ["text", "encoding"],
        "sources": [w("docs/zh/docs/misc/encode/computer.md"), w("docs/zh/docs/misc/encode/communication.md")],
        "when_text": "文本由 base64/hex/url/morse/进制/压缩等一层或多层编码叠加。",
        "steps": [
            "先看字符集和长度特征判断编码类型；用 file/魔数确认是否压缩/图片。",
            "逐层解码并保留每层输入输出，避免一次性猜错。",
            "出现乱码时试另一种编码/字符集；URL 编码注意二次编码。",
            "最终检查 flag 格式或文件类型。",
        ],
        "expect": "逐层可逆，最终得到可读文本/合法文件。",
        "pitfalls": "base64 可能缺 padding；十六进制大小写混用。",
    },
    {
        "id": "misc-zip-archive",
        "title": "压缩包：伪加密、已知明文与嵌套",
        "category": "misc",
        "when": ["archive", "zip"],
        "sources": [w("docs/zh/docs/misc/archive/zip.md")],
        "when_text": "zip/rar 需要密码，或提示里有明文片段/CRC/目录异常。",
        "steps": [
            "先看 zipinfo/7z l 的加密标志与压缩方法；伪加密可改标志位。",
            "已知明文（图片头、固定文件）用 bkcrack 做明文攻击。",
            "检查注释、额外字段、嵌套压缩包和 CRC 不匹配。",
            "解出后验证文件类型与内容。",
        ],
        "expect": "解压得到可读文件/下一层线索，CRC 与内容一致。",
        "pitfalls": "AES zip 不能用传统明文攻击；伪加密改错会损坏结构。",
    },
    {
        "id": "misc-image-stego",
        "title": "图片隐写：元数据、LSB 与附加数据",
        "category": "misc",
        "when": ["image", "stego"],
        "sources": [w("docs/zh/docs/misc/picture/introduction.md"), w("docs/zh/docs/misc/picture/png.md")],
        "when_text": "图片文件异常大/有可疑元数据/像素最低位可能藏数据。",
        "steps": [
            "先看 exif/comment/尾部附加数据；binwalk/foremost 拆嵌套文件。",
            "PNG 检查 IDAT 块、调色板、CRC 与像素 LSB；用 zsteg/自定义脚本提取。",
            "JPG 看 DCT/量化表/尾部；GIF 看帧与调色板。",
            "提取结果检查魔数与文本结构。",
        ],
        "expect": "提取出的数据是合法文件或可读文本，并能解释嵌入方式。",
        "pitfalls": "LSB 位序/通道顺序会变；先确认 PNG 颜色类型。",
    },
    {
        "id": "misc-traffic-pcap",
        "title": "流量分析：协议、流与 USB",
        "category": "misc",
        "when": ["pcap"],
        "sources": [w("docs/zh/docs/misc/traffic/introduction.md"), w("docs/zh/docs/misc/traffic/protocols/usb.md")],
        "when_text": "pcap/pcapng 里有 HTTP/DNS/USB/自定义协议流量。",
        "steps": [
            "先看协议分层与统计；follow stream 提取明文/文件。",
            "HTTP 导出对象；DNS 看异常长域名/编码；USB HID 按描述符解按键。",
            "自定义协议先对齐字段（长度/类型/payload），再重组。",
            "提取结果检查文件头/flag 格式。",
        ],
        "expect": "重组出可读内容或合法文件，且与流量时间线一致。",
        "pitfalls": "分片/重传要按流重组；USB 键盘要确认 HID 报告格式。",
    },
    {
        "id": "misc-pyc-disk-memory",
        "title": "pyc、磁盘镜像与内存取证",
        "category": "misc",
        "when": ["pyc"],
        "sources": [w("docs/zh/docs/misc/other/pyc.md"), w("docs/zh/docs/misc/disk-memory/introduction.md")],
        "when_text": "给出 pyc/磁盘镜像/内存 dump，需要恢复源码或进程数据。",
        "steps": [
            "pyc：确认 magic 与 Python 版本，用对应 decompyle/uncompyle 或手工反汇编。",
            "磁盘：mmls/tsk_recover 找分区与删除文件；看文件系统日志。",
            "内存：volatility 先 imageinfo，再按插件找进程/网络/凭据/文件。",
            "恢复结果检查完整性与可读性。",
        ],
        "expect": "恢复出源码/文件/进程数据，且版本与镜像一致。",
        "pitfalls": "pyc magic 不匹配时要换工具；内存镜像要先用正确 profile。",
    },
]

MORE_CARDS = [
    # ------------------------------------------------------------------ crypto
    {
        "id": "crypto-rsa-coppersmith",
        "title": "RSA Coppersmith：已知高位/小根",
        "category": "crypto",
        "when": ["rsa", "partial_plaintext"],
        "sources": [w("docs/zh/docs/crypto/asymmetric/rsa/rsa_coppersmith_attack.md")],
        "when_text": "已知明文高位、相关消息、p 的高位，或可写成模 N/模 p 的小根多项式。",
        "steps": [
            "把已知信息写成首一多项式 f(x)=0 (mod N 或 mod p)，未知量为小根。",
            "按界选择格：小根 |x| < N^(1/e)（或 p 的对应界），构造 Coppersmith 格。",
            "LLL/格约化后取短向量恢复根；Sage 的 small_roots 可直接做。",
            "把根代回原式验证，并检查明文结构。",
        ],
        "expect": "根满足多项式且解密结果结构合理；对 p 高位场景能分解 N。",
        "pitfalls": "界不满足时不会成立；多项式必须首一；纯 Python 做大格很慢。",
    },
    {
        "id": "crypto-rsa-wiener-small-d",
        "title": "RSA 小私钥 d 与连分数",
        "category": "crypto",
        "when": ["rsa", "small_d"],
        "sources": [w("docs/zh/docs/crypto/asymmetric/rsa/d_attacks/rsa_d_attack.md"), w("docs/zh/docs/crypto/asymmetric/rsa/d_attacks/rsa_extending_wiener.md")],
        "when_text": "d 明显偏小（约 < N^(1/4)），或 e/N 的连分数收敛中出现可疑的 k/d。",
        "steps": [
            "对 e/N 做连分数展开，枚举收敛 k/d。",
            "对每个候选用 phi=(e*d-1)/k 求整数 phi，检查是否为偶数。",
            "由 phi 和 N 解 p+q、p*q 分解 N；解出 p,q 后解密。",
            "d 稍大时用 extended Wiener（多组 e_i 或已知部分位）。",
        ],
        "expect": "p*q=N，phi 与 d 自洽，解密明文可读。",
        "pitfalls": "k=0 或 phi 非整数要跳过；d 超过界时连分数不够。",
    },
    {
        "id": "crypto-aes-padding-oracle",
        "title": "CBC padding oracle",
        "category": "crypto",
        "when": ["aes", "cbc", "padding_oracle"],
        "sources": [w("docs/zh/docs/crypto/blockcipher/mode/cbc.md")],
        "when_text": "CBC + PKCS#7，且服务端对 padding 是否合法给出可区分信号（错误/状态/时间）。",
        "steps": [
            "构造两块：前一块可控 IV/C，后一块是目标密文。",
            "从末字节开始翻转前块字节，枚举 0..255，找到使 padding 合法的值。",
            "逐字节恢复中间值，再与前一块异或得到明文；记录每次查询。",
            "控制请求量，避免把 oracle 探测写成高并发爆破。",
        ],
        "expect": "恢复出的明文重新加密/校验一致；padding 始终合法。",
        "pitfalls": "有 MAC/AEAD 时不可用；错误信号可能是统一状态码或时间差。",
    },
    {
        "id": "crypto-dlog-smooth-order",
        "title": "离散对数：小/光滑阶",
        "category": "crypto",
        "when": ["dlog", "smooth_order"],
        "sources": [w("docs/zh/docs/crypto/asymmetric/discrete-log/discrete-log.md")],
        "when_text": "g^x=h 的群阶光滑或很小；可分解为小素数幂。",
        "steps": [
            "分解群阶；对每个小因子用 BSGS/Pohlig-Hellman 求 x mod p_i^k。",
            "CRT 合并各余数得到 x；验证 g^x=h。",
            "阶未知时先从 g 的幂/因子推断。",
        ],
        "expect": "g^x 等于 h；x 在合理范围内。",
        "pitfalls": "大素数因子无法分解时方法不成立；注意群是模 p 还是椭圆曲线。",
    },
    # --------------------------------------------------------------------- web
    {
        "id": "web-recon-surface",
        "title": "Web 侦察：先画输入面",
        "category": "web",
        "when": ["http", "web_target"],
        "sources": [w("docs/zh/docs/web/introduction.md")],
        "when_text": "拿到一个 web 目标，先枚举路由、参数、认证、技术栈和可见源码。",
        "steps": [
            "抓首页/robots/sitemap/JS，列出路由、参数、表单和 cookie。",
            "识别语言/框架/中间件/数据库线索；看错误页和响应头。",
            "标记需要登录/上传/回调/管理的入口，先观察再动手。",
            "把每个候选入口写成可验证假设，避免无目标地扫 payload。",
        ],
        "expect": "得到有界的入口清单和每个入口的观测证据。",
        "pitfalls": "不要对目标做大规模目录/参数爆破；先读页面和 JS。",
    },
    {
        "id": "web-php-file-inclusion",
        "title": "PHP 文件包含与包装器",
        "category": "web",
        "when": ["php", "file_include"],
        "sources": [w("docs/zh/docs/web/php/php.md")],
        "when_text": "include/require 参数可控；可尝试读源码、日志或临时文件。",
        "steps": [
            "用 php://filter/convert.base64-encode 读目标源码，确认包含点。",
            "尝试日志/会话/上传临时文件包含；路径用相对/绝对/截断变体。",
            "data://、php://input、phar:// 视 allow_url_include 与配置。",
            "读出内容后检查是否是源码/配置/下一层线索。",
        ],
        "expect": "包含成功并返回可读源码/配置，而不是仅报错。",
        "pitfalls": "allow_url_include 常关闭；phar 需要能上传并触发文件操作。",
    },
    # --------------------------------------------------------------------- pwn
    {
        "id": "pwn-ret2dlresolve",
        "title": "无 libc 泄漏：ret2dlresolve",
        "category": "pwn",
        "when": ["elf", "stack_overflow", "no_libc_leak"],
        "sources": [w("docs/zh/docs/pwn/linux/user-mode/stackoverflow/x86/advanced-rop/ret2dlresolve.md")],
        "when_text": "栈溢出但没有 libc 地址泄漏；有可写内存和调用 PLT0 的能力。",
        "steps": [
            "准备可写内存，构造 fake Elf_Rela/Elf_Sym/字符串，让动态链接器解析 system。",
            "调用 PLT0 并传入 fake reloc 的 index；32 位通常比 64 位简单。",
            "pwntools 的 Ret2dlresolvePayload 可生成布局；核对对齐。",
            "拿到 shell 或读出目标文件。",
        ],
        "expect": "解析到 system 并执行指定命令；无崩溃。",
        "pitfalls": "需要足够大的溢出/读写原语；不同架构/链接器布局不同。",
    },
    {
        "id": "pwn-srop",
        "title": "SROP：sigreturn 帧",
        "category": "pwn",
        "when": ["elf", "stack_overflow", "syscall_gadget"],
        "sources": [w("docs/zh/docs/pwn/linux/user-mode/stackoverflow/x86/advanced-rop/srop.md")],
        "when_text": "有 syscall 指令和设置 rax=15 的能力；栈可控。",
        "steps": [
            "设置 rax=15，执行 syscall 触发 rt_sigreturn。",
            "在栈上布置 SigreturnFrame：execve('/bin/sh') 或 read/write。",
            "pwntools SigreturnFrame 生成字节；注意架构和栈对齐。",
            "验证 shell/读写结果。",
        ],
        "expect": "sigreturn 后寄存器按帧设置，执行目标 syscall。",
        "pitfalls": "需要 syscall gadget；某些环境禁用；帧布局随架构变化。",
    },
    {
        "id": "pwn-heap-house-of-force",
        "title": "House of Force（top chunk）",
        "category": "pwn",
        "when": ["elf", "heap", "top_chunk_overflow"],
        "sources": [w("docs/zh/docs/pwn/linux/user-mode/heap/ptmalloc2/house-of-force.md")],
        "when_text": "能溢出修改 top chunk 的 size（通常改成 -1），然后请求任意大小分配。",
        "steps": [
            "确认 glibc 版本仍允许（2.29+ 已缓解，需核实）。",
            "把 top size 改为 -1；计算目标地址与 top 的差值。",
            "申请该差值大小，使下一次 malloc 返回目标地址。",
            "在目标地址写入（GOT/hook/返回地址）并触发。",
        ],
        "expect": "malloc 返回受控地址，写入后控制流/值改变。",
        "pitfalls": "glibc 版本限制；差值必须通过 size 检查；对齐。",
    },
    {
        "id": "pwn-kernel-uaf",
        "title": "内核堆 UAF（SLUB）",
        "category": "pwn",
        "when": ["kernel", "uaf", "heap"],
        "sources": [w("docs/zh/docs/pwn/linux/kernel-mode/exploitation/heap/slub/uaf.md")],
        "when_text": "内核模块/驱动存在 UAF；能分配同 cache 的对象并控制内容。",
        "steps": [
            "确认对象 cache 大小与分配/释放路径；用 msg_msg/tty_struct 等喷雾。",
            "UAF 后重占对象，构造读/写原语；泄漏 KASLR 基址。",
            "用 ROP 或 modprobe_path 等方式提权；注意 SMEP/SMAP/KPTI。",
            "验证 uid=0 或读出 flag。",
        ],
        "expect": "获得内核读写/执行，最终拿到 root/flag。",
        "pitfalls": "内核版本与缓解不同；错误对象会导致 panic。",
    },
    {
        "id": "pwn-kernel-rop",
        "title": "内核 ROP 与 KPTI 绕过",
        "category": "pwn",
        "when": ["kernel", "rop", "kpti"],
        "sources": [w("docs/zh/docs/pwn/linux/kernel-mode/exploitation/rop/rop.md"), w("docs/zh/docs/pwn/linux/kernel-mode/exploitation/rop/kpti-bypass.md")],
        "when_text": "有内核栈溢出/控制流原语；需要 commit_creds 并返回用户态。",
        "steps": [
            "泄漏 KASLR 基址，找 commit_creds/prepare_kernel_cred 与 gadgets。",
            "用 KPTI trampoline（swapgs_restore_regs_and_return_to_usermode）布置返回。",
            "保存用户态 cs/ss/rflags/rsp/rip，构造 iretq 帧。",
            "返回用户态执行 shell 并验证 root。",
        ],
        "expect": "内核执行 commit_creds(0)，用户态拿到 root shell。",
        "pitfalls": "SMEP/SMAP/KPTI 组合；栈对齐与偏移随内核版本变化。",
    },
    # ----------------------------------------------------------------- reverse
    {
        "id": "rev-python-bytecode",
        "title": "Python 字节码/pyc 还原",
        "category": "reverse",
        "when": ["pyc", "python"],
        "sources": [w("docs/zh/docs/reverse/language/python/introduction.md"), w("docs/zh/docs/misc/other/pyc.md")],
        "when_text": "给出 .pyc/字节码，需要恢复逻辑或常量。",
        "steps": [
            "确认 magic 与 Python 版本；用对应 decompyle/uncompyle 或 dis。",
            "读 co_consts/co_names，恢复判定常量与字符串。",
            "版本不匹配时手工反汇编，按栈效果还原表达式。",
            "重写关键函数并用输入验证。",
        ],
        "expect": "恢复出的逻辑能解释输入检查，且与原字节码一致。",
        "pitfalls": "不同 Python 版本字节码差异大；反编译失败时用 dis。",
    },
    {
        "id": "rev-maze-constraint",
        "title": "迷宫/约束类逆向",
        "category": "reverse",
        "when": ["binary", "maze", "constraint"],
        "sources": [w("docs/zh/docs/reverse/maze/maze.md")],
        "when_text": "程序走格子/状态机，输入决定移动；成功路径由地图或约束决定。",
        "steps": [
            "从数据段/初始化代码提取地图、转移和墙。",
            "BFS/DFS 搜索可行路径；把输入字符映射到方向。",
            "复杂校验用 angr/z3 做符号执行，约束到目标状态。",
            "用真实输入跑程序验证到达终点。",
        ],
        "expect": "输入使程序到达成功状态/输出 flag。",
        "pitfalls": "地图可能动态生成；符号执行要注意路径爆炸。",
    },
    {
        "id": "rev-smc",
        "title": "自修改代码（SMC）",
        "category": "reverse",
        "when": ["binary", "self_modifying"],
        "sources": [w("docs/zh/docs/reverse/obfuscate/smc.md")],
        "when_text": "代码在运行前被解密/改写；静态字节与执行时不一致。",
        "steps": [
            "找解密 stub 和目标内存区间；在写完后下断点。",
            "dump 解密后的代码/数据，重新反汇编。",
            "若反调试，先绕过；必要时 patch 掉校验。",
            "用 dump 的逻辑恢复输入检查。",
        ],
        "expect": "dump 后的代码可读并解释检查；与原程序行为一致。",
        "pitfalls": "解密可能分段/多次；dump 时机不对会拿到半成品。",
    },
    {
        "id": "rev-false-disasm",
        "title": "花指令/错误反汇编",
        "category": "reverse",
        "when": ["binary", "obfuscated", "junk_code"],
        "sources": [w("docs/zh/docs/reverse/platform/linux/false-disasm.md")],
        "when_text": "反汇编出现明显跳转错位/重叠指令；真实入口被花指令遮挡。",
        "steps": [
            "从 call/jmp 目标而不是顺序字节开始反汇编。",
            "识别 junk bytes/重叠指令，强制在真实边界重建。",
            "用动态 trace 确认实际执行路径。",
            "恢复关键比较逻辑。",
        ],
        "expect": "重建后的反汇编连续且能解释执行路径。",
        "pitfalls": "手工重建容易漏分支；以动态 trace 为准。",
    },
    {
        "id": "rev-windows-unpack",
        "title": "Windows 加壳：OEP 与 IAT",
        "category": "reverse",
        "when": ["pe", "packed"],
        "sources": [w("docs/zh/docs/reverse/platform/windows/unpack/direct-oep.md"), w("docs/zh/docs/reverse/platform/windows/unpack/fix-iat.md"), w("docs/zh/docs/reverse/platform/windows/unpack/esp.md")],
        "when_text": "PE 加壳，入口在壳代码；需要 dump 原程序并修复导入表。",
        "steps": [
            "用 ESP 定律/内存断点/异常找 OEP。",
            "在 OEP dump 进程内存，重建节区。",
            "修复 IAT（Scylla 等），检查导入函数。",
            "用原程序逻辑验证 dump 可运行。",
        ],
        "expect": "dump 的程序在 OEP 可运行，导入表正确。",
        "pitfalls": "多阶段壳；IAT 加密/重定向；注意 TLS 回调。",
    },
    # -------------------------------------------------------------------- misc
    {
        "id": "misc-audio",
        "title": "音频隐写/编码",
        "category": "misc",
        "when": ["audio", "stego"],
        "sources": [w("docs/zh/docs/misc/audio/introduction.md")],
        "when_text": "wav/mp3 等音频文件异常，可能藏摩斯/DTMF/频谱/LSB。",
        "steps": [
            "看头/时长/采样率；用频谱图找图案或文字。",
            "检查 DTMF/摩斯/慢扫描电视；试 LSB/回声隐藏。",
            "提取结果检查可读文本/flag 格式。",
            "必要时按采样点手写解码。",
        ],
        "expect": "得到可读文本/图像，且能解释编码方式。",
        "pitfalls": "有损压缩会破坏 LSB；先确认容器/编码。",
    },
    {
        "id": "misc-recon-prefix",
        "title": "未知文件：前缀与嵌套",
        "category": "misc",
        "when": ["misc", "unknown_file"],
        "sources": [w("docs/zh/docs/misc/recon.md"), w("docs/zh/docs/misc/prefix.md")],
        "when_text": "附件类型不明（unknown file type），或文件头/magic bytes 被改、嵌套多层 archive/压缩。",
        "steps": [
            "file/xxd 看 magic bytes 与结构；binwalk/foremost 做 carve，找嵌套 archive。",
            "比对真实文件头，修复/拼接；检查尾部附加数据。",
            "逐层解包/解码，保留每层输入输出。",
            "验证最终文件可打开/文本可读。",
        ],
        "expect": "恢复出合法文件/可读文本，并解释前缀修复点。",
        "pitfalls": "不要一次改多个字节；保留原始副本。",
    },
    # --------------------------------------------------- observed web gaps
    {
        "id": "web-sqli-double-write",
        "title": "SQLi 关键词过滤：重叠双写绕过",
        "category": "web",
        "when": ["http", "sqli", "keyword_filter"],
        "sources": [w("docs/zh/docs/web/sqli.md")],
        "when_text": "输入进入 SQL，但 WAF/过滤器把 or、and、union、select、from、where、information_schema 等关键词**单次全局删除或替换一次**。",
        "steps": [
            "逐个确认哪些关键词被删/替换，以及是否只处理一次（单次全局替换，不递归）。",
            "把关键词写成重叠形式，让删除后仍留下原词：union→uniunionon，select→seselectlect，from→frfromom，information_schema→infoorrmation_schema。",
            "注意 where→wwherehere（两个 where 重叠），不能写 wherewhere（两个都会被删）。",
            "先用布尔/错误差异确认 payload 生效，再用 UNION 探列数与回显位。",
        ],
        "expect": "过滤后的字符串仍包含原关键词；同一 payload 的布尔/错误响应稳定。",
        "pitfalls": "不同过滤器的替换次数/顺序不同；先小步验证，不要一次批量试几十个变体。",
    },
    {
        "id": "web-sqli-into-outfile",
        "title": "SQLi 文件写入：INTO OUTFILE / load_file",
        "category": "web",
        "when": ["http", "sqli", "file_privilege"],
        "sources": [w("docs/zh/docs/web/sqli.md")],
        "when_text": "SQL 注入可用，且数据库用户有 FILE 权限、secure_file_priv 允许目标目录。",
        "steps": [
            "先用 load_file('/etc/passwd') 或报错确认文件读权限；确认可写 Web 目录。",
            "用 UNION SELECT ... INTO OUTFILE '/path/x.php' 写入一个只执行固定查询的查询器（不要写破坏性内容）。",
            "如果引号被过滤，用 0x... 十六进制或 CHAR() 构造路径/内容。",
            "访问写入的文件读回结果，确认查询器可执行；记录文件路径与权限。",
        ],
        "expect": "目标路径出现新文件，访问后能返回 SQL 查询结果。",
        "pitfalls": "secure_file_priv 限制目录；FILE 权限可能没有；写入前确认目标目录可写且不会覆盖现有文件。",
    },
    {
        "id": "misc-zip-symlink",
        "title": "ZIP 符号链接/zip slip 读取目标文件",
        "category": "web",
        "when": ["http", "zip", "upload"],
        "sources": [w("docs/zh/docs/misc/archive/zip.md")],
        "when_text": "上传的 zip 被服务端解压并读取包内文件；应用跟随符号链接或允许 ../ 路径。",
        "steps": [
            "确认上传后服务端会解压并 cat/读取 zip 内条目（非 zip 上传的报错可暴露这一点）。",
            "构造 symlink 条目：external_attr=0o120777，内容为目标绝对路径（如 /proc/self/environ、/flag）。",
            "或用 zip slip 的 ../ 条目写到可读/可执行目录；不要覆盖关键系统文件。",
            "上传后请求读取条目，检查响应里的目标文件内容；失败时换目标路径或确认解压器是否保留 symlink。",
        ],
        "expect": "响应包含目标文件内容（如进程环境变量或 flag），而不是仅回显上传内容。",
        "pitfalls": "解压器可能禁用 symlink/路径穿越；目标路径需存在且可读；不要把 zip slip 写成破坏性写入。",
    },
]

CARDS = CARDS + MORE_CARDS


# Schema v2 (docs/TECHNIQUE_CARD_SCHEMA.md). The two dimensions that v1 collapsed
# into `status: verified` are emitted separately:
#   curation  - how carefully the text was reviewed (draft|reviewed|disputed)
#   evidence  - what backs the claim (none|document|outcome|reproduction)
# Auto-injection is derived from both, so `verified` no longer has to mean two
# things at once. All cards here are human-authored from the wiki, which is a
# DOCUMENT source, never outcome evidence.
DEFAULT_CURATION = "reviewed"
DEFAULT_EVIDENCE = "document"
DEFAULT_ENVIRONMENT = "any"


def curation(card: dict) -> str:
    return card.get("curation", DEFAULT_CURATION)


def evidence_block(card: dict) -> dict:
    kind = card.get("evidence", DEFAULT_EVIDENCE)
    block = {"kind": kind, "refs": list(card.get("evidence_refs", card["sources"]))}
    if kind == "reproduction":
        if not card.get("implementation_digest"):
            raise SystemExit(f"card {card['id']}: evidence=reproduction needs implementation_digest")
        block["implementation_digest"] = card["implementation_digest"]
    return block


# Schema v2 (docs/TECHNIQUE_CARD_SCHEMA.md). The two dimensions that v1 collapsed
# into `status: verified` are emitted separately:
#   curation  - how carefully the text was reviewed (draft|reviewed|disputed)
#   evidence  - what backs the claim (none|document|outcome|reproduction)
# Auto-injection is derived from both, so `verified` no longer has to mean two
# things at once. Every card here is human-authored from the wiki, which is a
# DOCUMENT source, never outcome evidence.
DEFAULT_CURATION = "reviewed"
DEFAULT_EVIDENCE = "document"
DEFAULT_ENVIRONMENT = "any"


def curation(card: dict) -> str:
    return card.get("curation", DEFAULT_CURATION)


def evidence_block(card: dict) -> dict:
    kind = card.get("evidence", DEFAULT_EVIDENCE)
    block = {"kind": kind, "refs": list(card.get("evidence_refs", card["sources"]))}
    if kind == "reproduction":
        if not card.get("implementation_digest"):
            raise SystemExit(f"card {card['id']}: evidence=reproduction needs implementation_digest")
        block["implementation_digest"] = card["implementation_digest"]
    return block


def md(card: dict) -> str:
    lines = [f"# {card['title']}", ""]
    lines += [
        f"- id: {card['id']}",
        f"- category: {card['category']}",
        f"- curation: {curation(card)}",
        f"- environment: {card.get('environment', DEFAULT_ENVIRONMENT)}",
        f"- triggers: {', '.join(card['when'])}",
        f"- evidence: {card.get('evidence', DEFAULT_EVIDENCE)}",
    ]
    # First source is the canonical provenance; the rest are additional evidence refs.
    lines.append(f"- source: {card['sources'][0]}")
    lines += [f"- evidence-ref: {s}" for s in card["sources"][1:]]
    if card.get("implementation_digest"):
        lines.append(f"- implementation-digest: {card['implementation_digest']}")
    lines.append("- reviewed-by: human")
    lines += ["", "## When", card["when_text"], "", "## Do"]
    lines += [f"{i + 1}. {step}" for i, step in enumerate(card["steps"])]
    lines += ["", "## Expect", card["expect"]]
    if card.get("pitfalls"):
        lines += ["", "## Limits", card["pitfalls"]]
    lines.append("")
    return "\n".join(lines)


def contest(card: dict) -> dict:
    """Card JSON v2. `status` is kept only as a derived display label."""
    return {
        "schema_version": "2.0",
        "id": card["id"],
        "revision": "1",
        "title": card["title"],
        "curation": curation(card),
        "evidence": evidence_block(card),
        "scope": {
            "task_category": card["category"],
            "environment": card.get("environment", DEFAULT_ENVIRONMENT),
        },
        "triggers": card["when"],
        "preconditions": [card["when_text"]],
        "hint": card["steps"][:4] + [f"Verify: {card['expect']}"],
        "postconditions": [card["expect"]],
        "limits": [card["pitfalls"]] if card.get("pitfalls") else [],
        "source": {
            "kind": "ctf-wiki",
            "uri": card["sources"][0],
        },
    }


def main() -> None:
    cards_dir = OUT / "cards"
    seeds_dir = OUT / "seeds"
    cards_dir.mkdir(parents=True, exist_ok=True)
    seeds_dir.mkdir(parents=True, exist_ok=True)
    seen = set()
    out = []
    for card in CARDS:
        assert card["id"] not in seen, f"duplicate id {card['id']}"
        seen.add(card["id"])
        assert card["category"] in {"web", "pwn", "reverse", "crypto", "misc"}
        assert card["when"] and all(w.strip() == w for w in card["when"])
        assert not any(t in json.dumps(card) for t in ("DUCTF{", "flag{", "CTF{")), card["id"]
        path = cards_dir / f"{card['id']}.md"
        path.write_text(md(card))
        out.append(contest(card))
    (OUT / "cards.json").write_text(json.dumps({"cards": out}, ensure_ascii=False, indent=2) + "\n")
    # Candidate Experience proposals (not proof, not active). A human can submit
    # one with aegis_propose kind=candidate in the task session, then compile it
    # with >=2 independent verified outcomes.
    candidates = [
        {
            "id": card["id"],
            "proposal": {
                "kind": "candidate",
                "text": card["title"],
                "when": [card["when_text"], *card["when"]][:16],
                "do": "\n".join(card["steps"]),
                "expect": card["expect"],
                "scope": card["category"],
            },
            "source_refs": card["sources"],
        }
        for card in CARDS
    ]
    (OUT / "candidates.json").write_text(
        json.dumps({"candidates": candidates}, ensure_ascii=False, indent=2) + "\n"
    )
    # Human-readable inventory grouped by category.
    lines = ["# 技法卡清单", "", f"共 {len(CARDS)} 张。", ""]
    for category in ("crypto", "web", "pwn", "reverse", "misc"):
        lines.append(f"## {category}")
        lines.append("")
        for card in CARDS:
            if card["category"] != category:
                continue
            lines.append(f"- `{card['id']}` — {card['title']}")
        lines.append("")
    (OUT / "INVENTORY.md").write_text("\n".join(lines).rstrip() + "\n")
    for card in CARDS:
        src = cards_dir / f"{card['id']}.md"
        dst = seeds_dir / f"{card['id']}.json"
        run = subprocess.run(
            [
                "node",
                str(REPO / "compile-document-seed.mjs"),
                "--input",
                str(src),
                "--output",
                str(dst),
            ],
            capture_output=True,
            text=True,
        )
        if run.returncode != 0:
            sys.stderr.write(run.stdout + run.stderr)
            raise SystemExit(f"compile failed: {card['id']}")
    by_cat = {}
    for card in CARDS:
        by_cat[card["category"]] = by_cat.get(card["category"], 0) + 1
    print(f"cards={len(CARDS)} by_category={by_cat} cards_json={OUT / 'cards.json'} seeds={len(CARDS)}")


if __name__ == "__main__":
    main()
