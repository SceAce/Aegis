# 格式化字符串：泄漏与任意写

- id: pwn-format-string
- category: pwn
- curation: reviewed
- environment: any
- triggers: elf, format_string
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/pwn/linux/user-mode/fmtstr/fmtstr-exploit.md
- reviewed-by: human

## When
用户输入直接作为 printf 格式串；可控制参数位置。

## Do
1. 用 %p 序列确定输入在栈上的偏移。
2. 泄漏 canary/PIE/libc/栈地址；按需多次触发。
3. 用 %n/%hn 写 GOT/返回地址/钩子；pwntools fmtstr_payload 生成。
4. 写完后触发目标函数或返回，验证控制流/值改变。

## Expect
目标地址的值按预期改变（GOT 指向 system、返回地址跳 shellcode/one_gadget）。

## Limits
写入字节数很大时用 %hn 分段；FORTIFY 可能拦 %n。
