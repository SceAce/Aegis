# RUN-002 实验方案：pwn_3（跨题经验迁移）

> 目的：**回答"经验对解题有没有提升"**。RUN-001 回答不了（见 §1）。
> 本文件是方案；跑完把结果填进 `manual/pwn_3/RUNLOG.md`。

---

## 1. 为什么 RUN-001 不算数

| 问题 | 说明 |
|---|---|
| 自证而非迁移 | 本轮唯一激活的 cell 是**上一次 pwn_1 自己的解法**（`__free_hook = system`，A=1.282）。`HANDOFF.md` 明确写过：同题重跑必然自证，要测迁移得跨题 |
| 题目可认名 | `strings` 直接给 `===== Baby Heap in 2017 =====`，模型回忆公开 writeup（thinking 原文："the most cited 'baby heap 2017' writeup"）。地板已经是"记忆"，不是"推理" |
| 计时坏 | `elapsed_s` 从 `aegis start` 起算，含 6.3 min 启动空档，虚高 38% |
| n=1 | 历史 683–1059s 的离散度远大于任何"提升" |
| 世界不同 | 历史多数是容器 2.44（QEMU），RUN-001 是远端原生 2.43→patch 2.27 |

**本方案针对每一条做了处置**（见 §4）。

---

## 2. pwn_3 的基本事实（已实测）

| 项 | 值 |
|---|---|
| 路径 | `test/pwn_3/pwn`（**已 commit `b9396e2`**） |
| sha256 | `14b7a16478ee8794949b2c74f1ee4aecd2f5f17629bec838f461bd2979833af4` |
| 大小 | 10216 B |
| 类型 | ELF 64-bit PIE, dynamically linked, stripped |
| 编译器 | GCC 7.5.0 (Ubuntu 18.04) → **目标世界 glibc 2.27** |
| 导入 | `malloc` / `free` / `strdup` / `read` / `scanf` / `puts` / `printf` |
| 菜单 | `0) Create user  1) Edit user name  2) Delete user  3) Send admin a message  4) exit` |
| 提示串 | `You must create a user first` / `Enter age of user:` / `Saving it for admin to see!` |

### ⚠️ 关键发现：pwn_3 在 `strings` 里自带 hint

```
* Classify: CTFshow --- PWN ---
* Type  : Heap_Exploitation
* Site  : https://ctf.show/
* Hint  : Tcache dup
```

**二进制直接告诉解题者手法是 "Tcache dup"**，还给出平台网址（等于指向公开 writeup）。
这会重新引入 pwn_1 那个"回忆公开解"的污染源，所以**已做二进制层面的清除**，见下。

### 已执行的二进制 patch（`717a873` + `70d6454`）

| 项 | 值 |
|---|---|
| 原始 sha256 | `14b7a16478ee8794949b2c74f1ee4aecd2f5f17629bec838f461bd2979833af4` |
| **patch 后 sha256** | **`9eb5909d3fc3e6e24dbf3d4866a54d91cbe75e532fa2daccbada7b6256fe7317`** |
| 大小 | 10216 B → **10216 B（不变）** |
| 改动 | 624 字节，**全部在 `.rodata`** |
| 清掉的内容 | `Tcache dup`（手法 hint）、`https://ctf.show/`（平台网址）、`CTFshow`（平台名）、7 行 ASCII logo（视觉上拼出平台名） |
| **未动** | `.interp`、`.dynamic`、ELF 头/程序头/节头、所有重定位 |

**验证（远端 `readelf` 实测）**：

```
NEEDED : libc.so.6                                    ← 不变
INTERP : /lib64/ld-linux-x86-64.so.2                  ← 不变
大小   : 10216                                        ← 不变
strings: 无 tcache / ctfshow / ctf.show               ← 已清除
运行   : banner + 菜单 + 建用户 全部正常              ← 未破坏
```

做法是**同长度原地覆盖为空格**，所以所有偏移、节边界、动态表项逐字节不变 ——
libc 依赖与运行行为可证明未受影响。原始版本在 git（`b9396e2`），`git checkout` 可还原。

> 保留了 `* Type : Heap_Exploitation`（通用，菜单本身就说明了）和 `入门` 两字，不构成泄漏。

---

## 3. 本次要测的假设

**H**：带着 pwn_1（+pwn_2）积累的机制层经验去解 pwn_3，比**没有经验**更快或更稳。

### 对照设计：经验用**独立文件**提供，不走项目的记忆系统

按你的要求，经验**不靠当前项目注入**（项目的稀疏激活实测是坏的，且会引入
"同题自证"）。改成和 HEAP_KB 一样的**独立文件**：`manual/pwn_3/EXPERIENCE.md`。

| 组 | `EXPERIENCE.md` | 提示词 | `HEAP_KB.md` | 项目经验列 | ROM/工具/guard |
|---|---|---|---|---|---|
| **A 有经验** | **存在** | 同一个 `TASK.md` | 同一个 | 关闭 | 全同 |
| **B 无经验** | **移走** | 同一个 `TASK.md` | 同一个 | 关闭 | 全同 |

关键点：

- **提示词逐字相同**。`TASK.md` 里写的是"**如果** `manual/pwn_3/EXPERIENCE.md` 存在，也先读它"，
  所以自变量**只是那个文件在不在**，不是提示词措辞。
- 两组都带 `AEGIS_NO_MEMORY=1`：项目的经验列退出，免得它和文件里的经验
  混在一起、分不清是谁起的作用。它**只**去掉 `# 经验` 那一段（12 行），
  ROM、工具速查、guard 规则全部保留 —— 这是新加的 `aegis ram --no-experience`。
- `HEAP_KB.md` 两组相同，所以它也不是变量。

**经验文件的内容**：从 `pwn_1`/`pwn_2` 的实战编译结果生成（10 条已验证可行、
20 条已确认不通、25 条机制层问题、40 条习惯），每条都带成立条件。
生成脚本机械筛选，**不是手挑的**；剔除的只有工具层摩擦（超时/被拒/网络失败）
和一条假阳性（ASLR-off 那条，见 `EXPERIENCE.md` §5）。

---

## 4. 逐条堵住 RUN-001 的缺陷

| RUN-001 的缺陷 | 本方案的处置 |
|---|---|
| 自证而非迁移 | 换**跨题**：pwn_1/pwn_2 的经验 → **pwn_3**（不同二进制、不同菜单、不同漏洞） |
| 可认名 → 回忆 writeup | pwn_3 无可识别题名；只有 `Tcache dup` 这一条手法类别 |
| 计时虚高 38% | **`start` 之后立刻启动 agent**，并记录两个时间：`elapsed_s`（框架值）与 `wall_s`（人工记的 agent 首末消息差）。分析用后者 |
| n=1 | 每组 n≥3，交替跑（A B A B A B）以抵消时段漂移 |
| 世界不同 | 全部固定 `AEGIS_CHANNEL=remote` + 同一 libc 流程 |
| 知识块效应混淆 | 两组用**同一个** `HEAP_KB.md` |
| 成功链没进 ON | **先修 `compile.py`**（见 §6），否则经验组本来就拿不到正记忆，实验必然测出"无提升" |

---

## 5. 隔离：防止污染

### 5.1 已在代码层确认的隔离（无需改动）

| 污染源 | 拦截点 | 实测 |
|---|---|---|
| `runs/`、`.aegis/` | `guard.py` 的 `memory_peek` + 扩展 `isForbidden` | ✅ REFUSED |
| **其它题目的工作目录**（含远端 `~/Tmp/aegis/pwn_1/`、容器 `/work/aegis/pwn_1/`） | `guard.py` 的 `other_challenge`，前缀由 `_challenge_path_prefixes()` 覆盖三个通道 | ✅ 实测 `cat ~/Tmp/aegis/pwn_1/exp.py` → REFUSED |
| `test/pwn_1`、`test/pwn_2` | 同上（`test/` 前缀 + 当前题名判定） | ✅ REFUSED |
| `架构.md`/`框架.md`/`README.md`/`Deepseek_AGENTS.md` | 扩展 `isForbidden` 的 blocked doc | ✅ |

**`test/pwn_1/pwn` 与 `test/pwn_2/pwn` 的源码仍在仓库里**（必须如此，
否则 `finish` 的 git 恢复会失败），但**工具层访问被拒**。这是设计，不是漏洞。

### 5.2 需要人工清掉的残留

| 残留 | 位置 | 处置 |
|---|---|---|
| `~/Tmp/aegis/pwn_1/`（含**已解出的 `exp*.py`**） | 远端 | 删掉（guard 已拦访问，但删掉更干净） |
| `~/Tmp/aegis/pwn_2/` | 远端 | 删掉 |
| `~/Tmp/aegis/__probe__/` | 远端 | 可留 |
| `test/pwn_2/` | 本地 | **保留提交态**（git 需要），靠 guard 隔离 |
| atlas 里的 pwn_1/pwn_2 格子 | `.aegis/atlas.json` | **A 组保留**（那正是自变量）；**B 组清空** |

清理远端残留（在 pwn_3 作为当前题时执行，`pwn_1`/`pwn_2` 属"其它题"，命令本身会被 guard 拒——
所以**用 harness 之外的 ssh 或直接在远端操作**，或者接受"已拦截"即可）：

```bash
# 方案一：接受拦截（推荐，零风险）
#   guard 已证明拦得住，残留留着不影响实验

# 方案二：确实要删，在远端手工执行（绕过 guard 是有意的，因为这是环境准备不是解题）
#   ssh hack@100.110.69.75 'rm -rf ~/Tmp/aegis/pwn_1 ~/Tmp/aegis/pwn_2'
```

### 5.3 时间隔离：两组必须交错跑

不要"先跑 3 次 A 再跑 3 次 B"。时段、机器负载、远端状态都会漂移。
用 **A B A B A B** 交错，必要时再反向 B A B A 复核。

---

## 6. 前置修复

改成**独立经验文件**之后，原来卡住实验的那几条不再阻塞 —— 但计时这条仍然要处理。

### 6.1 仍然必须修：`t0` 打点时机（`aegis/cli.py`）

`elapsed_s` 从 `cmd_start` 起算，含"起表 → 人启动 agent"的空档（RUN-001 里是 6.3 min / 38%）。
两个组都要虚高，但**虚高量不同**（人启动快慢不同），会直接制造假差异。

**本轮规避办法（不改代码）**：主指标用 `wall_s` = agent 首条消息 → finish，
从 pi 的 session transcript 取；`elapsed_s` 只作参考。见 §8。

### 6.2 不再阻塞（因为经验已改为独立文件）

| 原以为要修 | 为什么现在不阻塞 |
|---|---|
| 成功链没进 ON（`compile.py`） | A 组的经验来自 `EXPERIENCE.md`，它是从 atlas+lessons 生成的**静态文件**，直接包含 `__free_hook = system` 等 ON 条目 |
| 散文解析失败（`fingerprint.py`） | A 组不再依赖项目把观测解析成指纹；经验在文件里，条件由模型自己匹配 |

> 这两条**仍然是真实的 bug**，会影响项目自身"带经验解题"的能力，
> 也会让 RUN-002 之后的编译继续丢正记忆 —— 但**不阻塞本实验**，可以并行修。

### 6.3 与本实验无关但值得顺手记的

- `problems` 99 条全 `below-tau`（审计已记录，未修）。
- 编译只产出 OFF（RUN-001 缺陷 2）。

---

## 7. 执行步骤

用 `arm.sh` 布置每一组 —— 它会摆好 `EXPERIENCE.md`、重新起表、并打印启动命令：

```bash
cd /Users/scemac/My_github/Aegis

# A 组（有经验）
./manual/pwn_3/arm.sh A
# 然后原样执行它打印的那条 pi 命令

# B 组（无经验）
./manual/pwn_3/arm.sh B
# 同样执行它打印的那条 pi 命令
```

`arm.sh` 做的事：把 `EXPERIENCE.md` 在 `manual/pwn_3/` 与 `/tmp` 之间搬进/搬出，
跑一次 `uv run aegis start pwn_3`，打印自变量快照（文件在不在）和启动命令。

**起表后立刻启动 agent** —— `elapsed_s` 从 `start` 算起，停久了就被空档污染。

它打印的启动命令是（两组**完全相同**）：

```bash
AEGIS_NO_MEMORY=1 AEGIS_CHANNEL=remote AEGIS_CHALLENGE=pwn_3 \
  /Users/scemac/My_github/pi/pi-test.sh --approve \
  --provider deepseek --model deepseek-flash \
  "读 manual/pwn_3/TASK.md 并照做。"
```

> `AEGIS_NO_MEMORY=1` 关闭项目自己的经验列（只去掉 `# 经验` 段，ROM/工具/guard 照旧）。
> 自变量是 `EXPERIENCE.md` 在不在，不是环境变量。手动核对一遍：
> `uv run aegis ram --no-experience | grep '^# '` 应只看到 ROM 和 RAM 两个标题。

---

## 8. 每组要记的数（填 `manual/pwn_3/RUNLOG.md`）

| 字段 | 来源 |
|---|---|
| `wall_s` | agent 首条消息 → finish 的 wall clock（**主指标**） |
| `elapsed_s` | WP 里的框架值（**仅参考**，用于量化空档） |
| `verified` | flag / local / none |
| 激活列 | 跑前 `activation.json` 的 cells / forbid 条数 |
| 它可用的经验 | 跑前把激活的格子原文抄下来（这是自变量，必须留证） |
| 工具调用分布 | transcript 里 `aegis_pwn` / `aegis_shell` 次数 |
| 阶段耗时 | 侦察 / 定位 / 调试 / 利用 / 收尾 |
| 卡点性质 | "选错时代" vs "本题细节" |
| 编译产物 | 本轮 cells（**特别看有没有 ON**）/ problems / habits |
| 污染检查 | 有没有触碰被 REFUSED 的命令、有没有读其它题 |

---

## 9. 判读规则（先写死，避免事后找理由）

- **A 组 `wall_s` 中位数 < B 组**，且两组 `verified` 都是 flag/local
  → **经验促进成立**。
- **两组 `wall_s` 重叠**（差异小于组内离散度）→ **无证据**，与 README 结论一致。
- **A 组更慢** → 检查是否"知识块/经验的验证成本"所致（RUN-001 的假设），
  并对比"卡点性质"是否从"选错时代"转向"本题细节"。
- 只要 **A 组激活列是 0 条**，本轮**无效**（自变量没生效），不要解读结果。

---

## 10. 与 pwn_1 的差异（写明，避免误读）

| 项 | pwn_1 | pwn_3 |
|---|---|---|
| 可识别题名 | `Baby Heap in 2017`（→回忆公开 writeup） | 无（只有 `Tcache dup` 手法类别） |
| 自带 hint | 无 | **有**：`Tcache dup` |
| 分配器入口 | `calloc`（绕过 tcache） | 有 `malloc` + `strdup`（tcache 正常生效） |
| 菜单 | Allocate/Fill/Free/Dump | Create/Edit/Delete/Send |
| 目标世界 | 2.27（patch 后） | 2.27（GCC 7.5 / Ubuntu 18.04 编译） |

**pwn_3 更贴近"纯迁移测试"**：没有可回忆的公开解，且漏洞类型（tcache dup）
与 pwn_1（calloc 绕过的 unsorted/fastbin 链）**不同**，但同属堆机制 ——
正是"经验该不该迁移过去"的合理考题。
