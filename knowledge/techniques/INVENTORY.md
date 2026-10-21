# 技法卡清单

共 47 张。

## crypto

- `crypto-rsa-common-modulus` — RSA 共模攻击（同一 n，多组 e）
- `crypto-rsa-low-exponent` — RSA 低加密指数（m^e < n）
- `crypto-rsa-hastad-broadcast` — RSA 广播攻击（同明文，多模数，小 e）
- `crypto-lcg-recover` — LCG 参数恢复与预测
- `crypto-aes-mode-misuse` — AES 模式误用（ECB / CBC）
- `crypto-xor-known-plaintext` — 重复密钥 XOR 与已知明文
- `crypto-rsa-coppersmith` — RSA Coppersmith：已知高位/小根
- `crypto-rsa-wiener-small-d` — RSA 小私钥 d 与连分数
- `crypto-aes-padding-oracle` — CBC padding oracle
- `crypto-dlog-smooth-order` — 离散对数：小/光滑阶

## web

- `web-sqli-union-blind` — SQL 注入：联合查询与盲注
- `web-ssrf-internal` — SSRF：让服务端访问内部资源
- `web-xss-execution` — XSS：上下文相关的执行
- `web-csrf-state-change` — CSRF：利用已认证会话
- `web-php-type-juggle` — PHP 常见陷阱：类型混淆与反序列化
- `web-recon-surface` — Web 侦察：先画输入面
- `web-php-file-inclusion` — PHP 文件包含与包装器
- `web-sqli-double-write` — SQLi 关键词过滤：重叠双写绕过
- `web-sqli-into-outfile` — SQLi 文件写入：INTO OUTFILE / load_file
- `misc-zip-symlink` — ZIP 符号链接/zip slip 读取目标文件

## pwn

- `pwn-stack-ret2libc` — 栈溢出与 ret2libc / ROP
- `pwn-format-string` — 格式化字符串：泄漏与任意写
- `pwn-heap-tcache-uaf` — 堆：UAF / tcache 投毒
- `pwn-canary-bypass` — Canary 泄漏与绕过
- `pwn-pie-aslr-leak` — PIE / ASLR 地址泄漏与部分覆盖
- `pwn-ret2dlresolve` — 无 libc 泄漏：ret2dlresolve
- `pwn-srop` — SROP：sigreturn 帧
- `pwn-heap-house-of-force` — House of Force（top chunk）
- `pwn-kernel-uaf` — 内核堆 UAF（SLUB）
- `pwn-kernel-rop` — 内核 ROP 与 KPTI 绕过

## reverse

- `rev-static-triage` — 二进制静态分诊（先看全局）
- `rev-anti-debug` — 反调试识别与绕过
- `rev-control-flow-flatten` — 控制流平坦化还原
- `rev-go-rust-runtime` — Go / Rust 二进制逆向
- `rev-constant-permutation-table` — 常量表 / 置换表反推
- `rev-python-bytecode` — Python 字节码/pyc 还原
- `rev-maze-constraint` — 迷宫/约束类逆向
- `rev-smc` — 自修改代码（SMC）
- `rev-false-disasm` — 花指令/错误反汇编
- `rev-windows-unpack` — Windows 加壳：OEP 与 IAT

## misc

- `misc-encoding-chain` — 编码链识别与逐层解码
- `misc-zip-archive` — 压缩包：伪加密、已知明文与嵌套
- `misc-image-stego` — 图片隐写：元数据、LSB 与附加数据
- `misc-traffic-pcap` — 流量分析：协议、流与 USB
- `misc-pyc-disk-memory` — pyc、磁盘镜像与内存取证
- `misc-audio` — 音频隐写/编码
- `misc-recon-prefix` — 未知文件：前缀与嵌套
