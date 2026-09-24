# Aegis RAM — 执行环境清单

> 这里是**有什么**。
> **怎么用、按什么顺序用、哪里容易翻车** → 见 `manual/<题>/EXPERIENCE.md`。

## 执行通道

**你不需要、也不允许自己连远端或进容器。** 命令原样交给 `aegis_pwn`：

```
aegis_pwn("checksec --file=./pwn")
```

harness 自动完成：选通道 → 同步题目文件 → 加载登录环境（venv / PATH / pwntools）
→ 套 timeout → 捕获输出。引号、管道、多行、`heredoc` 都能用，不用自己转义。

- **工作目录就是题目目录**，`./pwn` 这种相对路径直接写
- **禁止** `ssh` / `scp` / `docker exec` 到通道端点（工具层会 REFUSED）——
  绕过去就没有文件同步、没有环境、没有超时。
  **ssh 型的 CTF 题目本身不受影响**，`ssh user@challenge.host` 照常可用
- 看当前通道与工具：`aegis env --probe`（启动时已经给过一次）
- 强制换通道：`aegis_pwn(..., channel="container")`

| 通道 | 说明 |
|---|---|
| `remote` **默认** | 原生 x86_64，工具最全 |
| `container` | 本地 docker，QEMU 模拟，慢 5–10 倍且缺工具；远端不可达时才用 |

## 远端已装好的工具

登录环境已自动加载，直接用：

| 用途 | 命令 |
|---|---|
| 保护 | `checksec --file=./pwn` |
| 类型 / 串 | `file ./pwn`；`strings -n 5 ./pwn` |
| 头 / 段 | `readelf -hW ./pwn`；`objdump -d --start-address=... --stop-address=... ./pwn` |
| 符号 | `readelf -sW ./pwn`；libc 符号用 `readelf -sW /lib/x86_64-linux-gnu/libc.so.6 \| grep ' system$'` |
| gadget | `ROPgadget --binary ./pwn \| grep "pop rdi"`；`ropper --file ./pwn --search "pop rdi"` |
| one-gadget | `one_gadget /lib/x86_64-linux-gnu/libc.so.6` |
| seccomp | `seccomp-tools dump ./pwn` |
| libc / 依赖 | `pwninit`（取 libc、补依赖、生成模板）；`patchelf`（手工 patch） |
| 调试器 | `gdb` 默认已加载 pwndbg（另有 gef / peda / plain） |
| 反汇编 | `radare2` / `r2` |
| 其它 | `pwntools`（已装）、`ctf`（venv）、`proxy_start` / `proxy_stop`（要访问 GitHub 时） |

**libc 上禁止 `objdump` / `gdb` / `ROPgadget`** —— 用 `readelf -sW` 拿符号就够。

**不要用 `command -v` / `which` 探测工具** —— 有什么已经告诉你了。
