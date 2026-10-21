# 栈溢出与 ret2libc / ROP

- id: pwn-stack-ret2libc
- category: pwn
- status: verified
- environment: macos
- when: elf, stack_overflow
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/pwn/linux/user-mode/stackoverflow/x86/stackoverflow-basic.md
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/pwn/linux/user-mode/stackoverflow/x86/basic-rop.md

## When
存在栈溢出、无 canary 或可绕过；NX 开启，需要 ROP/ret2libc。

## Do
1. checksec：确认 canary/NX/PIE/RELRO；用 cyclic 找返回地址偏移。
2. 有 puts/read 等泄漏函数时先泄 libc 地址，算 libc base。
3. 用 ROP 调 system('/bin/sh')；注意 64 位栈对齐（ret gadget）。
4. 无 libc 时考虑 ret2dlresolve 或 syscall ROP。

## Expect
拿到 shell 或读出目标文件；地址与 libc 版本一致。

## Pitfalls
PIE 下先泄基址；不同 libc 的偏移不同，别猜。
