# Canary 泄漏与绕过

- id: pwn-canary-bypass
- category: pwn
- status: verified
- environment: macos
- when: elf, canary
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/pwn/linux/user-mode/mitigation/canary.md

## When
栈溢出但 canary 开启；存在读原语（printf/puts/写回显）或 fork 子进程。

## Do
1. 找泄漏点读 canary（格式化串、越界读、puts 未截断）。
2. fork 服务可逐字节爆破 canary（保留低字节 0x00）。
3. 溢出时把 canary 原样放回，再覆盖返回地址。
4. 验证 canary 未触发 __stack_chk_fail。

## Expect
程序走到目标返回/函数，未触发 stack smashing detected。

## Pitfalls
每次连接 canary 会变；爆破要用同一进程/fork 模型。
