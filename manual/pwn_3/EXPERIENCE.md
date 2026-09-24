# 经验：工具用法与做题流程

> 这是**过程性经验**：工具怎么用、按什么顺序做事、哪一步最容易翻车。
> 它**不含**本题的漏洞位置、地址、偏移或利用链 —— 那些必须由你在本题实测得出。
> 流程是通用的；具体手法取决于你量到的世界。

---

## 1. 标准流程（九步）

按这个顺序走。跳步是实测里最大的时间浪费来源。

| # | 阶段 | 做什么 | 用什么 |
|---|---|---|---|
| 0 | **准备** | 执行位、checksec、`exp.py` 模板 | `aegis start` 已经做过 |
| 1 | **量环境** | 真实 libc 版本；需要时换 libc / 补依赖 | `aegis_pwn` + `pwninit` |
| 2 | **侦察** | `file` / `checksec` / `strings` / `readelf -sW` | `aegis_pwn` |
| 3 | **定位** | 局部反汇编：输入路径、长度校验、菜单语义 | `aegis_pwn` |
| 4 | **量世界** | 真实 libc / hooks 生死 / 退出路径 / arena / 分配器入口 | `aegis_observe` |
| 5 | **设计** | 按量到的世界条件选手法 | 自己判断 |
| 6 | **写脚本** | `exp.py` | 写文件 |
| 7 | **调试** | 脚本逻辑用 pdb；目标内存用 gdb | **`aegis_shell`** |
| 8 | **验证** | 多次运行、跨 ASLR 基址复现 | `aegis_pwn` |
| 9 | **收尾** | 记卡点与花费 → 结束 | `aegis_note` + `aegis_finish` |

### 三条流程纪律

1. **便宜观测先做。** `strings` / 入口 / 符号前缀 / `checksec` 都失败之后，才升级到反汇编。
   全函数爆破、全表 gadget、通读 runtime 默认不上。
2. **先量后打。** 第 4 步没做完不要进第 5 步。为没观测到的世界条件设计链，是最常见的返工原因。
3. **先定位再写脚本。** 没找到输入路径和长度校验之前，写出来的脚本是猜的。

---

## 2. 工具选择：按"知不知道要看什么"

| 情形 | 用什么 |
|---|---|
| **已知要问什么**（跑一次、看固定输出：`file` / `checksec` / `readelf` / `strings`） | `aegis_pwn` |
| **还不知道要看什么**（要停下来、看了再决定：调堆布局、跟寄存器、单步） | **`aegis_shell`** |

> **动态调试一律用 `aegis_shell`，不要用 `aegis_pwn` 反复重跑 gdb。**
>
> 理由不是风格，是算术：one-shot 下"看一眼" = 重跑一次整个 setup。
> 有的题的 setup 要几分钟（堆耗尽、多次分配），重跑一次就是几分钟。
> 而持久会话里程序可以**停在提示符上**，下次调用接着看，状态不丢。

---

## 3. 各工具的具体用法

### 3.1 `aegis_pwn` —— 在 x86 通道上跑一条命令

```
aegis_pwn("checksec --file=./pwn")
aegis_pwn("strings -n 5 ./pwn | head -40")
aegis_pwn("objdump -d -Mintel --start-address=0x980 --stop-address=0x1454 ./pwn")
```

- 工作目录**就是**题目目录，相对路径直接写 `./pwn`
- `timeout` 参数：默认 20 秒，上限 300
- 引号、管道、多行、heredoc 都能用，不用自己转义

### 3.2 `aegis_shell` —— 持久交互会话

```
aegis_shell(action="send", text="gdb -q ./pwn")
aegis_shell(action="send", text="break *0x1337")
aegis_shell(action="read")                 # 读新输出
aegis_shell(action="panes")                # 列出所有 pane
aegis_shell(action="capture", pane="%1")   # 快照某个 pane
aegis_shell(action="interrupt", pane="%1") # Ctrl-C
aegis_shell(action="reset")                # 回到干净 shell
aegis_shell(action="status")
```

- **状态跨调用保留**：程序/gdb 可以停在提示符上，下次接着看
- `send` 默认打到**当前 pane**。如果你已经进了 gdb 或某个程序，命令会被它吃掉 ——
  每次 `send` 之后会告诉你前台是什么进程，**先看清楚再发**
- 忘记状态了就 `status` 或 `reset`，不要盲目继续发

### 3.3 记忆类工具

| 工具 | 用途 | 要点 |
|---|---|---|
| `aegis_observe(text, tags=[...])` | 记下**硬事实**并打机制标签 | 量到真实 libc / arena / 退出路径 / 可用原语**立刻记**。只有观测会改变经验点亮；记完经验列**立刻重算** |
| `aegis_note(kind, text, technique, condition)` | 记卡点、花费、手法 | 成功、明确失败、定位路径、花费都要记 |
| `aegis_finish` | 收尾 | 交代：手法链一行 / 卡在哪 / 花了多久 |

**`aegis_observe` 的标签要打准**（`glibc2.27`、`thread_arena`、`exit_group`、`hooks_dead` 这类）。
标签是系统理解你所在世界的唯一入口，打错会让经验匹配到错误的世界。

### 3.4 `pwninit` —— 换 libc / 补依赖

宿主机和容器的 libc 常常**不是**题目要的那个。要换时统一走 `pwninit`，**不要手搓 patchelf**：

```bash
pwninit ./pwn -W ./ld-linux-x86-64.so.2 ./libc.so.6   # 给了 ld + libc
pwninit ./pwn --libc ./libc.so.6                      # 只给 libc，自动配 ld
pwninit ./pwn -M ./libs                               # 给了整个依赖目录
pwninit --doctor ./pwn                                # patch 后跑不起来时诊断
pwninit --restore ./pwn                               # 回滚到 patch 前
```

- `glibc-all-in-one/libs/` 可能是空的。取不到时走 deb：
  `dpkg-deb -x libc6_<版本>_amd64.deb ./extracted`
- pwninit 会留下 `./libs`、`.pwninit-backups/`，**不会被同步冲掉**，下一轮也还在
- 换完 libc 后 `ldd ./pwn` 确认真的加载上了

### 3.5 gdb（默认已加载 pwndbg）

- 一次性看内存（不需要交互时）：
  `NO_COLOR=1 gdb -q -batch -ex "..." -ex quit ./pwn`
- 交互式调试**走 `aegis_shell`**；`gdb` 不带 `-batch` 走 `aegis_pwn` 会被拒绝
- pwntools 已配好 `~/.pwn.conf`（`terminal=['tmux','splitw','-h']`），
  所以 `gdb.attach(p)` 会自动在**另一个 pane** 横切开 gdb
- **不要在 `exp.py` 里改 `context.terminal`**，也不要传 `terminal=` 参数

**堆题建议的 pwndbg 命令**：`heap` / `bins` / `tcache` / `vis_heap_chunks` / `bt` / `x/8gx $rsp`

---

## 4. 调试 exp 脚本的两种姿势（都要 `aegis_shell`）

### (a) 调脚本本身的逻辑

变量不对、`recvline` 拿到空、偏移算错：

```python
aegis_shell("python3 -m pdb exp.py")
aegis_shell("break 12")             # 在可疑那行断下
aegis_shell("continue")
aegis_shell("p size")               # 看变量
aegis_shell("pp locals().keys()")
```

### (b) 调目标进程

脚本驱动目标时，用 gdb 看目标的内存/寄存器：

```python
# exp.py 里直接：
gdb.attach(p, gdbscript="break *0x...")
```

然后在**另一个 pane** 里驱动：

```python
aegis_shell(action="panes")
aegis_shell(action="capture", pane="%1")
aegis_shell(action="send", pane="%1", text="x/8gx $rsp")
aegis_shell(action="interrupt", pane="%1")
```

这是唯一能"脚本和目标同时在场"的方式。

### (c) 先加打印再上调试器

脚本反复挂住时，先在关键步骤 `print(..., flush=True)` 定位到**哪一步**挂，
比直接上 gdb 快得多。实测里 `recvrepeat` 换 `recvuntil` 往往就是那一步的解法。

---

## 5. 超时与拒绝

### 超时几乎都不是命令错，而是范围太大

| 慢操作 | 正确做法 |
|---|---|
| `objdump -d ./pwn` 全量 | 加 `--start-address=` / `--stop-address=` |
| `ROPgadget` 全量 | 加 `\| grep` 过滤，或换 `ropper --search` |
| libc 反汇编 | 不做；`readelf -sW` 拿符号就够 |
| exp 反复跑 | 一次一个；输出重定向到文件再取段 |

**同一命令连续超时两次 → 换方法，不要加大 timeout 重试。**

### 会被工具层直接拒绝的（不要换写法重试）

- 对 libc 做 `objdump` / `gdb` / `ROPgadget`
- 交互式 shell、`p.interactive()`
- 下载 / 搜索 Writeup
- 停共享容器
- 读 `runs/` / `.aegis/` / `docs/` / `tests/` / 其它题目目录
- 关保护（ASLR / NX / canary / RELRO / seccomp）
- 自己拼 `ssh` / `docker` 绕过通道

### 每条会卡住的命令都要带 timeout

pwntools 脚本里**禁止 `p.interactive()`** —— 要交互就用 `aegis_shell`。

---

## 6. 流程性错误清单（实测踩过的）

| # | 错误 | 后果 | 正确做法 |
|---|---|---|---|
| 1 | 不先量世界就设计链 | 按想象的条件写脚本，全部返工 | 第 4 步做完再动手 |
| 2 | 用 `aegis_pwn` 反复跑 gdb | 每次重跑整个 setup | 用 `aegis_shell` |
| 3 | 命令不带 timeout | 挂住整个 run | 一律带 timeout |
| 4 | 超时了加大 timeout 重试 | 浪费更多时间 | 缩小范围或换方法 |
| 5 | 被拒了换写法重试 | 白白烧轮次 | 按提示换替代方案 |
| 6 | 观察到的事实不记 | 经验列不更新，系统不知道你的世界 | 立刻 `aegis_observe` |
| 7 | `objdump` 全量 / `ROPgadget` 全量 | 超时 | 加范围或加过滤 |
| 8 | 拿宿主机 libc 当目标 libc | 偏移全错 | `ldd ./pwn` 量真实版本 |
| 9 | 忽略退出路径就打 FSOP | 裸 `exit_group` 下必失败 | 先确认是 `exit()` 还是 `exit_group` |
| 10 | 忘了 calloc 会零化 | 铺好的数据被抹掉 | 先确认分配器入口是 malloc 还是 calloc |

---

## 7. 环境速查

| 项 | 值 |
|---|---|
| 宿主机 | macOS ARM —— **跑不了 x86 二进制**，一律走 `aegis_pwn` |
| 执行通道 | 由 harness 管；`aegis_pwn` 自动选（远端原生 x86 优先，容器兜底） |
| 工作目录 | 题目目录本身，`./pwn` 这种相对路径直接写 |
| 调试器 | `gdb` 默认已加载 pwndbg |
| pwntools | 已配置 tmux 横切 pane |

**不要用 `command -v` / `which` 探测工具** —— 通道里有什么已经告诉你了。
