# 自修改代码（SMC）

- id: rev-smc
- category: reverse
- status: verified
- environment: macos
- when: binary, self_modifying
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/reverse/obfuscate/smc.md

## When
代码在运行前被解密/改写；静态字节与执行时不一致。

## Do
1. 找解密 stub 和目标内存区间；在写完后下断点。
2. dump 解密后的代码/数据，重新反汇编。
3. 若反调试，先绕过；必要时 patch 掉校验。
4. 用 dump 的逻辑恢复输入检查。

## Expect
dump 后的代码可读并解释检查；与原程序行为一致。

## Pitfalls
解密可能分段/多次；dump 时机不对会拿到半成品。
