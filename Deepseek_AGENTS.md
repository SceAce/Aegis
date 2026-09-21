# AGENTS.md —— CTF 赛题工作区

本目录是赛题工作区。每个题目一个子目录，工具在 `~/Tools/pwn` 下。

---

## 0. 三条硬性约定

### 1. 用 bash，不要用 fish

容器登录 shell 是 fish（给人用的），但 fish **不兼容 POSIX 控制流**：

| 写法 | fish 结果 |
| --- | --- |
| `X=1` | ❌ `Unsupported use of '='` |
| `for i in 1 2 3; do ...; done` | ❌ `Missing end to balance` |
| `if [ -f x ]; then ...; fi` | ❌ 报错 |
| `cat <<EOF ... EOF` | ❌ 不支持 heredoc |
| `$((1+2))` | ❌ 报错 |

**调用容器一律走 bash**：

```bash
docker exec pwn bash -lc '<命令>'
docker exec -i pwn bash -s < script.sh      # 需要喂 stdin 时（-i 不能省）
```

### 2. 每条涉及运行题目的命令都要有超时

pwn 题极易挂住（等输入、死循环、`interactive()`）。用 `pwnx run` 时超时是内置的。
自己写 pwntools 脚本时**一定要给 `timeout`，绝不用 `p.interactive()`**。

### 3. 关颜色，拿结构化输出

`NO_COLOR=1` 是**唯一**能关掉 pwndbg ANSI 颜色的开关（`TERM=dumb` 和
`set style enabled off` 都无效）。`pwnx gdb` 已内置。

```bash
docker exec pwn bash -lc 'NO_COLOR=1 gdb -q -batch -ex "..." -ex quit ./chall'
docker exec pwn bash -lc 'checksec file ./chall --no-banner --color never -o json'
```

---

## 1. 三套工具（注意路径，都在 ~/Tools/pwn 下）

| 用途 | 命令 | 在哪跑 |
| --- | --- | --- |
| 赛题流程：整理目录 / 记 flag / 生成 writeup | `docker exec pwn ctf ...` | 容器 |
| 查知识：payload / 相似 WP / 原理 / 脚本 | `~/Tools/pwn/bin/kb ...` | 宿主机 |
| 打题：侦察 / 偏移 / gadget / 调试 / libc | `docker exec pwn pwnx ...` | 容器 |

```bash
docker exec pwn ctf sync                 # 整理本目录的散落题目文档与附件
docker exec pwn ctf brief <题目>          # 分类 / 远程 / 附件 + 本地还是远程的建议
docker exec pwn ctf flag <题目> 'flag{...}'   # 记录 flag（writeup 自动补全）
docker exec pwn ctf list                 # 所有题目与状态

~/Tools/pwn/bin/kb brief ssti            # 一站式：payload + 相似WP + 原理行号 + 脚本
```

### 题目目录结构（由 `ctf` 自动创建）

```
<题目>/
├── 附件/            题目给的所有文件 + 原始题目描述.md
├── exp.py           exploit 脚本（自己写）
└── writeup.md       可直接提交的题解（ctf 生成、自动补全）
```

---

## 2. ⚠️ 多会话注意事项

这个工作区会**同时开多个会话跑不同的题**，以下几条必须遵守：

1. **`ctf sync` 只认题目文档里列出的附件。**
   没被任何题目文档引用的散落文件会**留在原地**并给出提示——这是刻意的，
   避免把别的会话刚丢进来的附件扫走。要显式归类用
   `docker exec pwn ctf attach <题目> <文件...>`。

2. **绝不要跑 `docker-compose down`、`docker-compose stop`、`./stop.sh`。**
   容器是所有会话共用的，停掉会打断别人。容器本来就该一直开着。

3. **工作文件放在 `/work/<题目>/` 下，不要用容器内的 `/tmp`。**
   `/tmp` 是所有会话共享的，会互相覆盖。

4. **需要本地端口的题（web / 起服务），每个会话自己挑不同端口**，
   并记在 writeup 里。别用 1337、8080 这种默认值硬编码。

5. `~/Tmp/flags.txt` 的追加写是原子的，多会话并发记录 flag 安全。

---

## 3. 解题流程

完整契约见 `ctf-solve` 技能（技能已装在本目录 `.dsh/skills/` 下，会自动加载）。
要点：

- **PWN / RE / MISC / CRYPTO：本地优先。** 附件就在 `<题目>/附件/`，先在容器里
  静态+动态分析，不必等远程地址；远程只在最后验证 exp 时用。
- **WEB：需要 URL。** 本地能做的（源码审计、字典、payload 准备）先做；
  URL 后到时用 `docker exec pwn ctf url <题目> <地址>` 补上。
- **拿到 flag 后，回复顺序是硬性的**：
  1. **第一行就是 flag**，单独一行，方便直接复制提交
  2. 一两句说明漏洞点与关键手法
  3. 完整可复现的脚本
  4. 说明 writeup 已生成/补全

---

## 4. 环境速查

```bash
# 容器（x86_64 Arch）
docker exec pwn bash -lc 'pwnx doctor'          # 环境自检
docker exec pwn bash -lc 'cd /work/<题目>/附件 && pwnx info ./chall'
docker exec pwn bash -lc 'pwnx gadgets ./chall --grep "pop rdi ; ret" --first'
docker exec pwn bash -lc 'pwnx libc get 2.31-0ubuntu9.18_amd64'
docker exec pwn bash -lc 'pwnx patch ./chall --libc 2.31-0ubuntu9.18_amd64'

# 知识库（宿主机）
~/Tools/pwn/bin/kb brief <关键词>
~/Tools/pwn/bin/kb wp --tag pwn --top 10
~/Tools/pwn/bin/kb payload 命令执行
~/Tools/pwn/bin/kb topic PHP反序列化漏洞总结     # 拿行号大纲
~/Tools/pwn/bin/kb read 命令执行.md 73-91       # 按行精读
```

⚠️ **不要直接读知识库里的文章**：`~/Tools/pwn/kb` 有 23MB / 1209 个 markdown，
最长一篇 6970 行。一律 `kb brief` → `kb topic`（拿行号）→ `kb read`（定点读）。

---

## 5. 其他已知的坑

- **pwninit 的 `--libc` 模式不可用**（上游两个 bug：软链接判定与 ld 查找路径）。
  永远用 `pwnx patch`，它内部走 `-W`。
- **checksec 3.x 用子命令**：`checksec file <bin>`。镜像里有兼容包装，
  但写脚本时优先用新语法。
- 容器跑在 QEMU x86_64 全系统模拟上，CPU 密集操作慢 5–10 倍：
  `ROPgadget` 扫 libc ≈ 70 秒，`pwnx gadgets` ≈ 0.7 秒。
- 跑崩的二进制会留 `core`，用 `docker exec pwn ctf clean` 清理。

---

*本文件由 `ctf setup` 从 `~/Tools/pwn` 同步而来。要改就改源文件再跑一次同步。*
