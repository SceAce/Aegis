# Python 字节码/pyc 还原

- id: rev-python-bytecode
- category: reverse
- curation: reviewed
- environment: any
- triggers: pyc, python
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/reverse/language/python/introduction.md
- evidence-ref: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/misc/other/pyc.md
- reviewed-by: human

## When
给出 .pyc/字节码，需要恢复逻辑或常量。

## Do
1. 确认 magic 与 Python 版本；用对应 decompyle/uncompyle 或 dis。
2. 读 co_consts/co_names，恢复判定常量与字符串。
3. 版本不匹配时手工反汇编，按栈效果还原表达式。
4. 重写关键函数并用输入验证。

## Expect
恢复出的逻辑能解释输入检查，且与原字节码一致。

## Limits
不同 Python 版本字节码差异大；反编译失败时用 dis。
