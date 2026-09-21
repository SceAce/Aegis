# Aegis RAM — 基础工具（当前热路径）

容器名 `pwn`，工作目录在容器内是 `/work/aegis/<题名>/`（与宿主机 `test/<题名>/` 同步）。
容器登录 shell 是 fish，**调用一律 bash**：

```bash
docker exec pwn bash -lc '<命令>'
docker exec -i pwn bash -s < script.sh
```

关颜色拿结构输出：`NO_COLOR=1`。每条运行类命令加 timeout。

## 允许（先用这些）

| 目的 | 命令 |
|---|---|
| 文件类型 | `file ./chall` |
| 串 | `strings -n 5 ./chall` |
| 保护 | `checksec file ./chall --no-banner --color never -o json` |
| 头/段 | `readelf -hW ./chall`；`objdump -d ./chall` 只看入口附近，禁止一上来全表 |
| 跑 | `pwnx run ./chall`（自带超时）或 `timeout 10 ./chall` |
| 信息 | `pwnx info ./chall` |
| gadget | `pwnx gadgets ./chall --grep "..." --first` — 不要对整个 libc 扫 ROPgadget |
| 调试 | `NO_COLOR=1 gdb -q -batch -ex "..." -ex quit ./chall` |
| 脚本 | 写 `exp.py`，`timeout` 必填 |

优先用 `aegis_pwn`，它会先把当前题同步进容器再执行。

## 禁止（demo）

- IDA / Ghidra / Binary Ninja
- `kb` 知识库（那是论文+WP 倾倒）
- 无超时的交互（`p.interactive()`、裸 gdb）
- 在宿主机上直接执行 x86 二进制
