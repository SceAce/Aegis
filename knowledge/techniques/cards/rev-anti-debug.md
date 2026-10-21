# 反调试识别与绕过

- id: rev-anti-debug
- category: reverse
- status: verified
- environment: macos
- when: binary, anti_debug
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/reverse/platform/linux/detect-dbg.md
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/reverse/platform/windows/anti-debug/isdebuggerpresent.md

## When
调试时程序退出/走假分支；出现 ptrace、IsDebuggerPresent、时间差、异常处理检查。

## Do
1. 定位反调试调用（ptrace(PTRACE_TRACEME)、IsDebuggerPresent、NtQueryInformationProcess）。
2. 静态 patch 返回值/跳转，或用 LD_PRELOAD/Frida hook。
3. 时间差检测用断点后改时钟/跳过比较；异常检测注意调试器异常配置。
4. 绕过后再验证真实逻辑是否可达。

## Expect
断点能停在目标逻辑，程序不再因调试器退出。

## Pitfalls
多处反调试要一起处理；patch 后要重算校验和。
