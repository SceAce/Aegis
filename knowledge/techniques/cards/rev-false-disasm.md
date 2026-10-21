# 花指令/错误反汇编

- id: rev-false-disasm
- category: reverse
- curation: reviewed
- environment: any
- triggers: binary, obfuscated, junk_code
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/reverse/platform/linux/false-disasm.md
- reviewed-by: human

## When
反汇编出现明显跳转错位/重叠指令；真实入口被花指令遮挡。

## Do
1. 从 call/jmp 目标而不是顺序字节开始反汇编。
2. 识别 junk bytes/重叠指令，强制在真实边界重建。
3. 用动态 trace 确认实际执行路径。
4. 恢复关键比较逻辑。

## Expect
重建后的反汇编连续且能解释执行路径。

## Limits
手工重建容易漏分支；以动态 trace 为准。
