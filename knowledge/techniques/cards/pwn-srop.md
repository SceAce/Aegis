# SROP：sigreturn 帧

- id: pwn-srop
- category: pwn
- curation: reviewed
- environment: any
- triggers: elf, stack_overflow, syscall_gadget
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/pwn/linux/user-mode/stackoverflow/x86/advanced-rop/srop.md
- reviewed-by: human

## When
有 syscall 指令和设置 rax=15 的能力；栈可控。

## Do
1. 设置 rax=15，执行 syscall 触发 rt_sigreturn。
2. 在栈上布置 SigreturnFrame：execve('/bin/sh') 或 read/write。
3. pwntools SigreturnFrame 生成字节；注意架构和栈对齐。
4. 验证 shell/读写结果。

## Expect
sigreturn 后寄存器按帧设置，执行目标 syscall。

## Limits
需要 syscall gadget；某些环境禁用；帧布局随架构变化。
