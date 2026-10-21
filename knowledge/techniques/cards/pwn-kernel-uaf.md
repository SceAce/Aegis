# 内核堆 UAF（SLUB）

- id: pwn-kernel-uaf
- category: pwn
- status: verified
- environment: macos
- when: kernel, uaf, heap
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/pwn/linux/kernel-mode/exploitation/heap/slub/uaf.md

## When
内核模块/驱动存在 UAF；能分配同 cache 的对象并控制内容。

## Do
1. 确认对象 cache 大小与分配/释放路径；用 msg_msg/tty_struct 等喷雾。
2. UAF 后重占对象，构造读/写原语；泄漏 KASLR 基址。
3. 用 ROP 或 modprobe_path 等方式提权；注意 SMEP/SMAP/KPTI。
4. 验证 uid=0 或读出 flag。

## Expect
获得内核读写/执行，最终拿到 root/flag。

## Pitfalls
内核版本与缓解不同；错误对象会导致 panic。
