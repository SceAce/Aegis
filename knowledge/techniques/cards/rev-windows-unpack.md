# Windows 加壳：OEP 与 IAT

- id: rev-windows-unpack
- category: reverse
- curation: reviewed
- environment: any
- triggers: pe, packed
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/reverse/platform/windows/unpack/direct-oep.md
- evidence-ref: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/reverse/platform/windows/unpack/fix-iat.md
- evidence-ref: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/reverse/platform/windows/unpack/esp.md
- reviewed-by: human

## When
PE 加壳，入口在壳代码；需要 dump 原程序并修复导入表。

## Do
1. 用 ESP 定律/内存断点/异常找 OEP。
2. 在 OEP dump 进程内存，重建节区。
3. 修复 IAT（Scylla 等），检查导入函数。
4. 用原程序逻辑验证 dump 可运行。

## Expect
dump 的程序在 OEP 可运行，导入表正确。

## Limits
多阶段壳；IAT 加密/重定向；注意 TLS 回调。
