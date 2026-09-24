# 堆知识块（机制层参考，注入用）

> **这块不是本题答案。** 它是一整块堆机制知识，每条都带成立条件。
> 条件不匹配 = 这条对本题不成立，不要试。
> 本题用哪条、怎么串，必须由你在本题实测的观测决定。

记号：`[2.27+]` 表示从该 glibc 版本起成立。**版本必须实测，不许假设。**

---

## 1. 开局必量的五个量（先量后打）

| # | 量 | 怎么量 | 为什么决定打哪条路 |
|---|---|---|---|
| 1 | **真实 libc 版本** | 目标进程实际加载的那个，不是宿主机的 | 决定 tcache / hooks / safe-linking 全部生死 |
| 2 | **hooks 生死** | `2.34+` 已删除 `__free_hook` / `__malloc_hook` / `__realloc_hook` | hooks 死了就只能走 FSOP / 其它写目标 |
| 3 | **退出路径** | `exit()` 还是 `syscall(SYS_exit_group)` | `exit()` 会 flush stdio → FSOP 可用；裸 `exit_group` 不 flush → 打在退出上的 FSOP **无效** |
| 4 | **arena 形态** | 菜单跑在主线程还是 `pthread` | thread arena 的泄漏偏移、堆布局、top 位置全不同 |
| 5 | **分配器入口** | `Allocate` 用 `malloc` 还是 `calloc` | `calloc` 零化请求区间；某些版本还绕过 tcache |

> 第 5 条最容易翻车：用 malloc 的思路去布置 calloc 的题，
> 会发现在 tcache 里做的手脚根本没被消费。

---

## 2. chunk 与 bin 结构

### 2.1 chunk 头（64 位）

```
+0x00  prev_size   —— 前一个 chunk 空闲时才有效
+0x10  size        —— 大小(低 3 位是标志) | PREV_INUSE(1) | IS_MMAPPED(2) | NON_MAIN_ARENA(4)
+0x20  user data
```

- 大小 16 字节对齐；最小 chunk `0x20`（可用 `0x18`）。
- `request2size(req) = (req + 8 + 15) & ~15`，`req=0` 仍给最小 chunk。
- `prev_size` 只在**前一个 chunk 空闲**时被写；inuse 时那段空间可被前一个 chunk 的用户数据占用
  —— 这是很多重叠手法的立足点。

### 2.2 bin 一览

| bin | 结构 | 顺序 | 合并 | 备注 |
|---|---|---|---|---|
| tcache | 单链 `next`(+`key`) | LIFO | 否 | `[2.26+]` per-thread，64 个，每 bin 上限 7 |
| fastbin | 单链 `fd` | LIFO | 否 | `size <= global_max_fast`（默认 0x80） |
| unsorted | 双链 `fd`/`bk` | FIFO 插入 | 是 | 分配时的中转站；泄漏主战场 |
| small | 双链 | 按大小 | 是 | `< 0x400` |
| large | 双链 + `fd_nextsize`/`bk_nextsize` | 按大小 | 是 | `>= 0x400` |

`global_max_fast` 是个全局变量，改大它可以让更大的 chunk 进 fastbin。

---

## 3. tcache `[2.26+]`

```c
typedef struct tcache_entry { struct tcache_entry *next; struct tcache_perthread_struct *key; } tcache_entry;
```

- 大小范围 `0x20 .. 0x410`，共 64 个 bin。
- `counts[idx]` 每 bin 上限 **7**；第 8 个起才走正常的 `_int_free`。
- **取出时不校验 `next` 指向的 chunk 大小**（直到 `2.32+` 加了安全链接）——
  这是 tcache poisoning 的根。
- **双重释放检测** `[2.29+]`：`e->key == tcache` 时 abort（`free(): double free detected in tcache 2`）。
  - `2.29 ~ 2.33`：key 是 `tcache` 指针，**可猜**（heap 上固定偏移）。
  - `2.34+`：key 换成 `tcache_key`（随机数），猜不了 → 必须真造两个不同 chunk。
- `calloc` 与 tcache 的关系**版本相关**：`2.26 ~ 2.34` 的 `__libc_calloc` 走 `_int_malloc`，
  不经过 `__libc_malloc` 里的 tcache 快路径，所以 free 进 tcache 的 chunk **calloc 取不到**。
  **本题必须实测确认**，不要照搬。
- `calloc` 会**零化整个请求区间**。这会抹掉你已经铺好的数据（含重叠 chunk 的头），
  任何依赖"先布置、后分配"的手法都要把重写安排在分配之后。

---

## 4. fastbin `[远古]`

- LIFO，`fd` 单链；大小 `<= global_max_fast`（默认 `0x80`，即可用 `0x70` 上下）。
- **不合并**：相邻 free chunk 不会 coalesce，所以能长时间保持可控布局。
- 取出校验 `[2.27+]`：`fastbin_index(chunksize(victim)) == idx`，否则
  `malloc(): memory corruption (fast)`。
  → 伪 chunk 的 size 字段必须落在对应 fastbin 的区间内。
- 伪 chunk 的 size qword 若是**重定位后的指针字节**（例如 `__malloc_hook - 0x23` 那种），
  只有约一半 ASLR 基址会让它看起来合法 → 跨运行不稳定。
  更稳的做法是在 libc 里找一个**文件常量**的 qword 当 size（如 `0x7f` 那一类），
  它不随基址变化。**这是跨运行可复现性的关键。**

---

## 5. unsorted / small / large bin

- free 一个非 fastbin 大小的 chunk，先进 unsorted bin。
- unsorted 里只有一个 chunk 时，它的 `fd == bk == main_arena + 0x60`（偏移随版本微调）
  → **这是最经典的 libc 泄漏源**。
- 分配时遍历 unsorted：大小刚好就切走，否则归入 small/large。
- `malloc_consolidate` 会把 fastbin 合并进 unsorted（分配大 chunk 或处理 large 请求时触发）。
  → 想保持 fastbin 布局，就要避免触发它。
- **unsorted bin attack**：改 `bk` 往目标写一个 main_arena 地址。
  `[2.29+]` 加了 `victim->bk == unsorted_chunks(av)` 校验 → **此路在 2.29+ 断了**。
- **large bin attack**：`[2.30+]` 加了校验，且不同小版本条件不同 → 必须按实测版本判。

---

## 6. 现代缓解（逐条决定手法生死）

| 缓解 | 起始 | 影响 |
|---|---|---|
| tcache 双重释放 key | `2.29+` | 不能连着 free 同一个 chunk |
| **safe-linking** | `2.32+` | tcache `next` 与 fastbin `fd` 都存 `(pos>>12) ^ ptr` → **必须先知堆地址** |
| hooks 删除 | `2.34+` | `__free_hook` 等没了，`free` 劫持路线关闭 |
| `_IO_vtable_check` | `2.24+` | 假 vtable 必须指向合法 vtable 区 |
| top chunk size 校验 | `2.29+` | House of Force 失效 |
| unlink 校验 | `2.27+` | `FD->bk == P && BK->fd == P` |
| smallbin `bck->bk` 校验 | `2.29+` | House of Lore 受限 |

**safe-linking 的算法**（`2.32+`）：

```c
#define PROTECT_PTR(pos, ptr)  ((pos) >> 12) ^ (ptr)
#define REVEAL_PTR(ptr)        PROTECT_PTR(&ptr, ptr)
```

要往任意地址写，需要：`heap_leak ^ (target >> 12)`。
所以 safe-linking 世界里，**堆地址泄漏是一切的入口**。

---

## 7. 泄漏原语（拿到什么、怎么拿）

| 想要 | 常见来源 | 条件 |
|---|---|---|
| libc 基址 | unsorted bin 的 `fd`/`bk`（`main_arena+0x60`） | 先让一个 chunk 进 unsorted |
| libc 基址 | 大 chunk 的 `fd_nextsize` | large bin |
| 堆基址 | 已释放 chunk 里残留的 `next` | `2.32+` 需解 safe-linking |
| 堆基址 | 相邻 chunk 的 `prev_size` / 越界读 | 需要一个读原语 |
| 栈地址 | `environ` 符号（libc 里） | 先有任意读 |
| PIE 基址 | 主程序指针（栈上返回地址、`__libc_csu_init` 等） | 需要一个读 |

**读原语的常见来源**：题目的 Dump/Show 功能、越界读、`write` 一个比请求更大的长度、
把 chunk 指向已初始化结构再读。**没有读原语时，先找读原语，不要硬凑 blind 写。**

---

## 8. 写原语与 House 系列（按条件选，不是按名气选）

| 名字 | 需要 | 起始/失效 | 一句话 |
|---|---|---|---|
| tcache poisoning | 能改 freed tcache 的 `next` | `2.26+`；`2.32+` 需解安全链接 | 连分两次拿到任意地址 chunk |
| fastbin attack | 能改 freed fastbin 的 `fd` | `2.27+` 需 size 合法 | 同上，但受 size 校验约束 |
| overlap / 重叠 | 能改一个 chunk 的 size | 通用 | 让两块 chunk 覆盖同一区域 |
| House of Einherjar | off-by-one null 改写 `prev_size` | `2.29+` 加校验 | 伪造 prev_size 骗合并 |
| House of Force | 能改 top size 为 `-1` | **`2.29+` 失效** | 把 top 推到任意地址 |
| House of Orange | 能改 top size + 触发 sysmalloc | `2.26+` 需先填满 tcache | 把 unsorted 与 FSOP 结合 |
| House of Lore | smallbin 伪造 `bk` | **`2.29+` 受限** | smallbin 攻击 |
| House of Roman | 无需泄漏、部分覆盖 | 偏 `2.23` 时代 | 12 bit 爆破 |
| House of Botcake | tcache + unsorted 双 free | `2.31+` | 绕过 tcache key |
| House of Apple 2 | `_IO_list_all` + `_wide_data` + `_IO_wfile_jumps` | `2.35` 前后有补丁 | 不走 vtable 校验的 FSOP 路线 |
| FSOP（`_IO_str_jumps` 等） | 能改 `_IO_list_all` 或 FILE 结构 | 需 `exit()` 路径 | 退出时 flush 触发 |

**选法**：先看 §1 量到的 hooks 生死与退出路径。
hooks 活着 → 优先 `__free_hook = system`。
hooks 死了且 `exit()` → FSOP / House of Apple。
两者都不行 → 找 GOT / 函数指针 / `__stack_chk_fail` 之类可直接覆盖的目标。

---

## 9. 退出路径：为什么它决定 FSOP 死活

```
exit(status)
  -> __run_exit_handlers
     -> _IO_cleanup
        -> _IO_flush_all_lockp     ← 遍历 _IO_list_all，调 vtable->__overflow
           -> (FSOP 在这里触发)

syscall(SYS_exit_group)            ← 直接进内核，上面整条链都不走
```

所以：**题目用裸 `exit_group` 时，任何"打在退出上的 FSOP"都无效**，
无论假 FILE 造得多完美。要么改 `_IO_list_all` 后主动触发一次 flush
（例如调用 `printf`/`puts` 到 stdout 的时机），要么换目标。

菜单程序常见的"读命令时崩溃"也属于这一类：
在 `read`/`strtol` 路径上崩，和退出路径完全是两件事。

---

## 10. 工具与通道速查

执行在远程 x86 主机上，**不要自己 ssh / docker**，交给 `aegis_pwn`。

| 目的 | 命令 |
|---|---|
| 文件类型 | `file ./pwn` |
| 保护 | `checksec --file=./pwn` |
| 串/菜单 | `strings -n 5 ./pwn` |
| 头/段 | `readelf -hW ./pwn`；`readelf -sW ./pwn` |
| 局部反汇编 | `objdump -d --start-address=0x... --stop-address=0x... ./pwn` |
| gadget | `ROPgadget --binary ./pwn \| grep "pop rdi"` |
| libc 符号 | `readelf -sW /lib/x86_64-linux-gnu/libc.so.6 \| grep ' system$'` |
| 非交互调试 | `NO_COLOR=1 gdb -q -batch -ex "..." -ex quit ./pwn` |
| 动态调试 | **`aegis_shell`**（会话保留状态，程序可以停在提示符上） |

**两个执行工具的分工**：已知要问什么（跑一次、看固定输出）→ `aegis_pwn`；
还不知道要看什么（调布局、跟寄存器、单步）→ `aegis_shell`。

**换 libc**（宿主/容器的 libc 常常不是题目要的那个）：

```bash
pwninit ./pwn -W ./ld-linux-x86-64.so.2 ./libc.so.6   # 给了 ld + libc
pwninit ./pwn --libc ./libc.so.6                      # 只给 libc，自动配 ld
pwninit ./pwn -M ./libs                               # 给了整个依赖目录
pwninit --doctor ./pwn                                # patch 后跑不起来时诊断
pwninit --restore ./pwn                               # 回滚
```

`glibc-all-in-one/libs/` 可能是空的。取不到时走 deb：

```bash
# 取 libc6_<版本>_amd64.deb 后
dpkg-deb -x libc6_2.27-3ubuntu1_amd64.deb ./extracted
# 注意它可能拒绝解绝对符号链接，必要时手工取 lib/x86_64-linux-gnu/libc-2.27.so 与 ld-2.27.so
```

**被工具层硬拒绝的**：对 libc 做 `objdump`/`gdb`/`ROPgadget`、交互式 shell、
下载 WP、停共享容器、读 `.aegis/` / `runs/`、碰别的题目目录。
**被拒就是被拒，不要换写法重试**——按提示换替代方案。

**超时**几乎都不是命令错，而是范围太大：缩小范围，不要原样重试。
同一命令连续超时两次 → 换方法。

---

## 11. 常见坑（都是实证过的）

1. **拿宿主机 libc 当目标 libc。** 先确认目标进程实际加载的是哪一个。
2. **忽略退出路径就打 FSOP。** 裸 `exit_group` 下必失败。
3. **忘了 calloc 会零化。** 布置好的数据会被抹掉。
4. **用 `__malloc_hook - 0x23` 那种指针字节当 size。** 跨 ASLR 基址不稳定，
   换成 libc 里的文件常量 qword。
5. **在 tcache 里做手脚，但题目用的是 calloc。** 手脚没被消费。
6. **不填满 tcache 就指望 free 进 unsorted。** `2.26+` 前 7 个都进 tcache。
7. **safe-linking 世界里直接写绝对地址。** 需要 `heap_leak ^ (target >> 12)`。
8. **无读原语时硬凑 blind 写。** 先找读原语。
9. **对 libc 做全量反汇编。** 被拒绝，且不必要——符号表够用。
10. **关保护来打通。** 工具层会拒绝，且结果不算数。

---

## 12. 结束时必须交代的

- 观测到的世界：真实 libc 版本、hooks 生死、退出路径、arena 形态、分配器入口。
- 手法链一行（机制层，至多一个 `->`，无地址）。
- 卡在哪：是"选错了时代"（版本/hooks/退出路径判断错），还是"本题细节"。
- 每步的画和最后的验证输出（`id`、marker）。
