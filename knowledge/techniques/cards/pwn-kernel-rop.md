# 内核 ROP 与 KPTI 绕过

- id: pwn-kernel-rop
- category: pwn
- curation: reviewed
- environment: any
- triggers: kernel, rop, kpti
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/pwn/linux/kernel-mode/exploitation/rop/rop.md
- evidence-ref: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/pwn/linux/kernel-mode/exploitation/rop/kpti-bypass.md
- reviewed-by: human

## When
有内核栈溢出/控制流原语；需要 commit_creds 并返回用户态。

## Do
1. 泄漏 KASLR 基址，找 commit_creds/prepare_kernel_cred 与 gadgets。
2. 用 KPTI trampoline（swapgs_restore_regs_and_return_to_usermode）布置返回。
3. 保存用户态 cs/ss/rflags/rsp/rip，构造 iretq 帧。
4. 返回用户态执行 shell 并验证 root。

## Expect
内核执行 commit_creds(0)，用户态拿到 root shell。

## Limits
SMEP/SMAP/KPTI 组合；栈对齐与偏移随内核版本变化。
