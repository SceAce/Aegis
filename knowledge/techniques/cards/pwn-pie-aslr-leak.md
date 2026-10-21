# PIE / ASLR 地址泄漏与部分覆盖

- id: pwn-pie-aslr-leak
- category: pwn
- status: verified
- environment: macos
- when: elf, pie
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/pwn/linux/user-mode/stackoverflow/x86/stack-intro.md

## When
PIE 开启；有栈/格式化/堆泄漏，或可做部分返回地址覆盖。

## Do
1. 先用任意读泄一个代码/栈/libc 指针，算基址。
2. 只有部分覆盖时，利用同一页内的低 12 位固定特性改写低 1-2 字节。
3. GOT 可写（Partial RELRO）时改 GOT；否则打返回地址/栈。
4. 每次泄漏后重新计算，不要复用旧基址。

## Expect
目标地址落在正确页内，控制流/调用到达预期函数。

## Pitfalls
ASLR 每次运行变化；部分覆盖要保证目标与当前地址同页。
