# House of Force（top chunk）

- id: pwn-heap-house-of-force
- category: pwn
- status: verified
- environment: macos
- when: elf, heap, top_chunk_overflow
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/pwn/linux/user-mode/heap/ptmalloc2/house-of-force.md

## When
能溢出修改 top chunk 的 size（通常改成 -1），然后请求任意大小分配。

## Do
1. 确认 glibc 版本仍允许（2.29+ 已缓解，需核实）。
2. 把 top size 改为 -1；计算目标地址与 top 的差值。
3. 申请该差值大小，使下一次 malloc 返回目标地址。
4. 在目标地址写入（GOT/hook/返回地址）并触发。

## Expect
malloc 返回受控地址，写入后控制流/值改变。

## Pitfalls
glibc 版本限制；差值必须通过 size 检查；对齐。
