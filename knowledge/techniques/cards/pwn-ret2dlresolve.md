# 无 libc 泄漏：ret2dlresolve

- id: pwn-ret2dlresolve
- category: pwn
- curation: reviewed
- environment: any
- triggers: elf, stack_overflow, no_libc_leak
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/pwn/linux/user-mode/stackoverflow/x86/advanced-rop/ret2dlresolve.md
- reviewed-by: human

## When
栈溢出但没有 libc 地址泄漏；有可写内存和调用 PLT0 的能力。

## Do
1. 准备可写内存，构造 fake Elf_Rela/Elf_Sym/字符串，让动态链接器解析 system。
2. 调用 PLT0 并传入 fake reloc 的 index；32 位通常比 64 位简单。
3. pwntools 的 Ret2dlresolvePayload 可生成布局；核对对齐。
4. 拿到 shell 或读出目标文件。

## Expect
解析到 system 并执行指定命令；无崩溃。

## Limits
需要足够大的溢出/读写原语；不同架构/链接器布局不同。
