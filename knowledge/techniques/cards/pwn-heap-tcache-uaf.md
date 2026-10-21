# 堆：UAF / tcache 投毒

- id: pwn-heap-tcache-uaf
- category: pwn
- status: verified
- environment: macos
- when: elf, heap, uaf
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/pwn/linux/user-mode/heap/ptmalloc2/heap-overview.md
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/pwn/linux/user-mode/heap/ptmalloc2/tcache-attack.md

## When
存在 use-after-free/double-free；能控制 chunk 内容；glibc 版本已知或可泄。

## Do
1. 先确认 glibc 版本与 chunk 大小/数量；tcache 与 fastbin 行为不同。
2. UAF 后改 fd 指向目标（__free_hook、__malloc_hook、栈）；2.32+ 处理 safe-linking。
3. 用 malloc 两次拿到目标地址，写入 one_gadget/system。
4. 若目标是任意读，先把 chunk 链到 GOT/栈再分配。

## Expect
分配器返回受控地址，写入后触发目标（hook 被调用/返回地址被改）。

## Pitfalls
safe-linking 需要先泄 heap 地址；不同 glibc 的 hook 可能已移除（2.34+）。
