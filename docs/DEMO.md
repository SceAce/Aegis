# Aegis Demo 说明文档

> 这份文档只讲**这个 demo 本身**：目标是什么、原理是什么、代码在哪、已经做到哪一步。
> `架构.md` / `框架.md` 是另一回事——那是面向通用安全 agent 的研究纲领，
> 与本 demo 的关系见 §9。

---

## 1. 一句话定位

**一个用来验证「把解题经验编译下来、下次自动用上」这条逻辑链能不能跑通的最小系统。**

题目是 CTF pwn（堆题），记忆的载体是一张**带条件的判据表**，
验证方式是**对照实验**：同一道题，一次带经验、一次不带，看有没有区别。

---

## 2. 要验证的命题（只有这一个）

> **经验能不能促进模型把题解出来？**

展开成可测的形式：

| 维度 | 指标 |
|---|---|
| 是否打通 | `verified` ∈ {flag, local} |
| 快不快 | 耗时（人工对齐，见 §8 注） |
| 卡点性质 | 「选错时代」（版本/hooks/退出路径判断错）还是「本题细节」（偏移/布局） |

### 明确**不**验证的东西

- ❌ 框架是否优雅
- ❌ 多模型协作 / 投票
- ❌ 把论文和 Writeup 检索进上下文
- ❌ 通用安全 agent（那是 `架构.md` 的目标）

**唯一的对比轴：有经验 vs 无经验。**

---

## 3. 闭环形状

整个 demo 就是这四步，其余全是支撑：

```
   ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
   │ ① 采集  │ →  │ ② 存储  │ →  │ ③ 注入  │ →  │ ④ 度量  │
   └─────────┘    └─────────┘    └─────────┘    └─────────┘
    解完一题        判据表          下次开局        对照实验
    编译成判据     atlas.json      system prompt    A vs B
```

对应到代码：

```
①  compile.py      解完题 → LLM 抽结构 → lessons.json → atlas.json
②  store.py        atlas.json 落盘；判据字段含成立条件
③  fingerprint.py  量当前世界 → 结构化指纹
    activate.py     指纹 × 判据表 → 稀疏激活打分 → top-k
    store.ram_blob  渲染成文字 → 塞进 system prompt
④  arm.sh          切换「有经验/无经验」两组
    writeup.py      产出 WP，人工读
```

---

## 4. 实现原理

### 4.1 世界指纹：经验必须带条件

**为什么**：安全知识不因"时间久了"变假，而因**目标变了**变假。
`__free_hook` 覆盖在 glibc 2.27 可用，在 2.34+ 完全失效——不是变旧了，是**世界变了**。

所以每条经验必须声明**它在哪个世界成立**。世界被抽象成五个字段：

```python
Fingerprint(
    glibc  = (2, 27) | None,     # 版本，决定 tcache/safe-linking/hooks 生死
    hooks  = "alive"|"dead"|None, # __free_hook 等是否还在（2.34 起删除）
    exit   = "flush"|"group"|None,# exit() 会刷 stdio（FSOP 可用）；裸 exit_group 不刷
    arena  = "main"|"thread"|None,# 单线程 brk 堆 vs pthread 的 mmap 64MB 区
    alloc  = {...},               # tcache / fastbin / unsorted_bin / calloc / safe_linking
    observed = bool,              # 是否真的量过（≠ "量了发现没有"）
)
```

`observed` 单独一个字段，因为**「没观测」和「观测到不成立」是两件事**。

### 4.2 判据三态：requires / forbids / optional

一条判据（cell）长这样：

```json
{
  "technique": "tcache poison -> arbitrary write",
  "requires":  {"glibc": ">=2.34", "hooks": "dead"},   // 全部成立才适用（硬门）
  "forbids":   ["safe_linking"],                        // 任一成立就否决（硬否决）
  "forbids_version": {"glibc": ">=2.34"},               // 版本式否决
  "optional":  ["tcache"],                              // 不满足只扣分（软）
  "state":     "on" | "off",
  "evidence":  "flag" | "local" | "wiki" | "none",
  "n":         2,                                        // 复现次数
  "source":    "pwn_1"
}
```

三态的区分是整个设计的核心：

| 字段 | 语义 | 不满足时 |
|---|---|---|
| `requires` | 必须成立 | **不适用**（不注入） |
| `forbids` | 一成立就否 | **成为禁令**（强制推送"不要试"） |
| `optional` | 锦上添花 | 只扣分，仍然可能注入 |

> 老实现把三者压成"没有标签重叠 → 不注入"，于是**机制层的经验永远无法跨题迁移**。

### 4.3 稀疏激活：ACT-R 三项式

**为什么**：不能把整个经验库塞进 prompt（长上下文会稀释，相关信息在中间时会显著下降）。
只放行条件匹配的那几条。

打分公式（`activate.py:score`）：

```
A = B + S − P·M          P = 0.55
```

| 项 | 含义 | 计算 |
|---|---|---|
| **B** | 基础练习强度 | `0.8 · ln(1+n) · 证据权重` |
| **S** | 扩散激活 | `Σ 1/(1+ln(1+fan))`，按线索（cue）重叠 |
| **M** | 部分失配惩罚 | `optional` 未满足的条数 × 0.55 |

证据权重（`TIER_WEIGHT`）：`flag=1.0`、`local=0.6`、`wiki=0`、`none=0`。

- **fan 惩罚**：一个线索挂在越多格子上，它的话语权越小——防止泛词（`tcache`、`heap`）刷分。
- **`wiki` 权重为 0**：一篇文章说"这能行"，不等于**本系统见过它行**。
- 过不了 `τ = 0.9` 的不注入。每类取 top-k：格子 6 / 问题 4 / 习惯 3 / 参考 2。

### 4.4 三态介入 + 工具层强制

**为什么**：记忆不是"检索"，是**介入策略**。而且**空动作必须是显式决策**，
不能是"相似度没匹配上"的意外产物。

```
SILENT  什么都不说（大多数时候的正确选择，会计数）
REMIND  有适用条目，该影响下一步
FORBID  世界匹配某条"这里会坏"的判据 → 相关命令在工具层被拒绝
```

五个触发点：`opening`（开局）/ `observe`（观测变了）/ `refuse`（被拒或超时）/
`repeat`（在重试）/ `stuck`（若干步没进展）。

**LLM 介入层只能减不能加**（`intervene.py:_llm_refine`）：
它只决定"现在该不该说、怎么说"，**不能新增条目**，而且 **FORBID 路径永远不走 LLM**。

> 幻觉出来的介入可以浪费 token，但它**永远无法关掉一条能用的技术**。

### 4.5 正记忆拉取，负记忆推送

> **正面经验模型会自己想到去查；负面经验它永远不会主动查。**

所以：

| 记忆 | 方式 |
|---|---|
| 正记忆（ON 格子） | **拉取**——按分数排序，模型自己需要时看 |
| 负记忆（OFF 格子） | **推送**——条件一匹配就强制注入「禁止尝试」 |

### 4.6 上下文布局

```
[ ROM：工作约定 + 工具速查 ]     ← 头部，永不变，前缀缓存命中
[ 经验列：按当前世界稀疏激活 ]    ← 中段
[ 当前 Intent + 最新观测 ]        ← 尾部，注意力最集中
```

依据：注意力在首尾最强，中间是死区（U 型曲线）。

---

## 5. 代码地图

`aegis/` 共 **7130 行**。

### 5.1 记忆四环

| 文件 | 行数 | 职责 |
|---|---|---|
| `fingerprint.py` | 312 | **世界指纹**：把观测/提示解析成结构化五字段 |
| `predicate.py` | 220 | **判据求值**：requires / forbids / optional 三态判定 |
| `activate.py` | 481 | **稀疏激活**：ACT-R 三项打分 + top-k + HSR 指标 |
| `store.py` | 662 | **存储与装配**：atlas / episodes / lessons 的读写；`ram_blob` 渲染 |
| `compile.py` | 396 | **记忆编译**：finish 时 LLM 从 WP 抽 schema-2 判据 |
| `intervene.py` | 232 | **三态介入**：SILENT / REMIND / FORBID + 触发点 |
| `migrate.py` | 352 | 旧格式（schema 1）判据迁移到 schema 2 |
| `wiki.py` | 336 | CTF Wiki 当**可查知识库**（≠ 经验，永不进策略列） |

### 5.2 执行与安全

| 文件 | 行数 | 职责 |
|---|---|---|
| `dockerutil.py` | 1339 | **执行通道**：本地是 macOS ARM 跑不了 x86，送到远端/容器跑；文件同步、清单、权限 |
| `session.py` | 391 | **持久交互会话**：给 gdb / pdb 用，程序可以停在提示符上 |
| `guard.py` | 538 | **工具层拒绝**：11 类命令命中即 REFUSED |
| `integrity.py` | 241 | **防假阳性打通**：检测是否靠关 ASLR/NX/canary 来通关 |
| `gitutil.py` | 31 | `test/<题>/` 的 git 恢复（防下一题读到上一题痕迹） |

### 5.3 入口与支撑

| 文件 | 行数 | 职责 |
|---|---|---|
| `cli.py` | 1199 | 全部子命令 |
| `paths.py` | 90 | 路径与远端配置 |
| `llm.py` | 94 | LLM 调用封装 |
| `writeup.py` | 68 | WP 产出 |
| `util.py` / `activate_legacy.py` | 51+91 | 小工具 / 旧激活器兜底 |

### 5.4 两层拒绝机制（`guard.py`）

11 类，其中 **10 类常开**（是物理约束，不是学来的），只有 `gdb_library_path` 是"学来的"（`ALWAYS_KEYS` / `LEARNED_KEYS`）：

| 类别 | 含义 |
|---|---|
| `libc_disasm` / `libc_debug` | 对 libc 做 objdump/gdb（太慢且无必要） |
| `interactive` | 交互式 shell、`p.interactive()` |
| `writeup_fetch` | 下载 Writeup |
| `gdb_library_path` | 用自定义 loader 跑 gdb |
| `kb` | 旧知识库命令 |
| `docker_down` | 停共享容器（不可逆） |
| `memory_peek` | 读 `.aegis/` / `runs/`（防止抄自己） |
| `other_challenge` | 碰其它题目目录（跨题污染） |
| **`weaken_protection`** | **关 ASLR/NX/canary/RELRO/seccomp** |
| `channel_bypass` | 自己 ssh/docker 绕过通道 |

---

## 6. 数据文件地图（`.aegis/`，git 忽略）

| 文件 | 内容 |
|---|---|
| `atlas.json` | **判据表（主库）**：163 条 cell = **35 条自有经验**（13 ON / 22 OFF）+ 128 条 wiki 参考 |
| `episodes.jsonl` | **情景流**：每一次观测/技巧/花费/判决/intervention |
| `lessons.json` | 每次 `finish` 的编译结果（problems / cells / habits） |
| `activation.json` | 本轮的激活列（当前注入了什么） |
| `status.json` | 内部账本：指纹、丢弃原因统计、`hsr_at_k` |
| `current.json` | 当前题目 + 本轮观测 + 指纹标签 |
| `issues.jsonl` | harness 层问题记录（超时/被拒/git 失败） |
| `search.json` | 检索规则 |
| `wiki_done.json` | 已编译的 wiki 页面 |
| `run-<题>.json` | 每题的运行状态（双终端并行用） |

---

## 7. 一次运行的完整时序

```bash
# ① 起表
uv run aegis start <题目>
```
- git 恢复 `test/<题>/` 到入库快照
- 推送到执行通道（远端或容器），`reset=True` 清掉上一轮残留
- 跑 `pwninit`：加执行位 + checksec + 生成 `exp.py` 模板
- 把 checksec 结论记成本轮**观测** → 写 `current.json`

```bash
# ② 启动 agent
AEGIS_CHALLENGE=<题目> pi --approve --provider deepseek --model deepseek-flash \
  "读 manual/<题目>/TASK.md 并照做。"
```
- 扩展的 `before_agent_start` 把 `aegis ram` 的输出追加进 system prompt
  （= ROM + 工具速查 + **经验列**）

```bash
# ③ agent 干活（在 pi 里）
```
| 动作 | 发生什么 |
|---|---|
| `aegis_pwn("...")` | 在远端执行；命令先过 `guard` |
| `aegis_shell(...)` | 持久交互会话，给 gdb/pdb 用 |
| `aegis_observe("...", tags=[...])` | 写观测 → **指纹重算 → 经验列立刻重算** |
| `aegis_note(...)` | 记卡点/花费 |
| 写了 `exp.py` | `finish` 时会扫它有没有关保护 |

```bash
# ④ 收尾
aegis_finish
```
- 写 WP 到 `runs/<时间戳>_<题目>.md`
- **编译**：LLM 从 WP 抽结构化判据 → `lessons.json` → 合并进 `atlas.json`
- git 恢复 `test/<题>/`

---

## 8. 目前已做

### ✅ 能跑通的

| 项 | 状态 |
|---|---|
| 四步闭环（采集/存储/注入/度量） | 全部有实现，端到端可跑 |
| 结构化世界指纹 | 五字段 + `observed` |
| 判据三态（requires/forbids/optional） | 完整 |
| 稀疏激活（ACT-R 三项） | 完整，含 fan 惩罚与证据分级 |
| 三态介入 + 五个触发点 | 完整，LLM 层只能减不能加 |
| 记忆编译 | `finish` 自动编译，**人不手填格子** |
| 工具层强制 | 11 类拒绝，9 类常开 |
| 防假阳性打通 | `integrity.py` 扫命令与脚本 |
| 双通道执行 | 远端优先（原生 x86），容器兜底（QEMU） |
| 持久调试会话 | `aegis_shell` + tmux pane 驱动 gdb |
| wiki 与经验分离 | `evidence=wiki` 永不进策略列 |
| 回归测试 | **79/79 通过** |
| A/B 对照组开关 | `AEGIS_NO_MEMORY=1` + `manual/pwn_3/arm.sh` |

> **度量（耗时）由人工对齐，不在本清单里当问题处理。**

### ⚠️ 有问题的（详见 §9）

| 环节 | 症状 |
|---|---|
| **注入** | 撑死注入 1 条，其余情况恒为 0 |
| **采集** | 不稳定：有时只产出 OFF 格子，成功链没进 ON |
| **问题/习惯** | `problems` 全部被丢弃（实测 99 条 below-tau） |

---

## 9. 已知问题与修复清单

### 9.1 注入几乎恒为 0 —— 三个根因

**根因 1：指纹解析不认散文**

`fingerprint.py` 的版本正则锚点之后只允许分隔符：

```python
_GLIBC = r"(?:glibc|libc|ld)[\s=_:/-]*(?:so\.\d[\s()]*)?(?:>=|<=|>|<|=)?\s*(\d+)\.(\d+)"
                        ^^^^^^^^^^^ 只允许分隔符
```

于是：

| 写法 | 结果 |
|---|---|
| `glibc 2.27` | ✅ `(2,27)` |
| **`runtime libc is 2.27`** | ❌ `None` |
| **`libc 是 2.27`** | ❌ `None` |
| **"退出路径 exit()"** | ❌ 收不进 `exit` 字段 |

实测 15 条带 glibc 标签的观测里，**4 条自由文本单独解析失败**——恰好是最自然的中英文写法。

**根因 2：指纹解析不认「否定」，会把正确的观测反转过来** ⚠️ 最严重

`fingerprint.parse()` 对 `arena` / `exit` / `alloc` 用的是**朴素子串匹配**：

```python
if has("thread_arena", "thread arena", "pthread"):  arena = "thread"
if has("exit_group", "syscall exit", "no stdio flush"): exit = "group"
for key in ("tcache","fastbin","unsorted_bin","calloc",...):
    if has(key): alloc.add(key)
```

它无法区分「有」和「没有」。于是**模型写对了观测，却被解析成了反面**。

**实测证据**（2026-09-24 的 pwn_3 运行，`runs/20260924T003321_pwn_3.md`）：

模型写下的观测是（原文）：

> Binary is single-threaded menu (**no pthread**) → allocations come from the **main arena** (brk heap), NOT a thread arena.
> Allocator entry is malloc/strdup (**no calloc**): tcache fast path active.
> Exit path: menu choice 4 calls libc exit(0) (stdio flush path), **not raw exit_group**.

解析结果却是：

```
arena = thread     ← 因为文本里有 "pthread"（在 "no pthread" 里）
alloc = calloc     ← 因为文本里有 "calloc"（在 "no calloc" 里）
exit  = group      ← 因为文本里有 "exit_group"（在 "not raw exit_group" 里）
```

**模型自己发现并记录了这个 bug**（episodes 原文）：

> **CORRECTION of parsed fingerprint fields for pwn_3:** no pthread is used, so arena=main (brk heap), NOT thread. Allocator entry is malloc and strdup, NOT calloc. Exit path is libc exit() which flushes stdio (not raw exit_group).

> **harness fingerprint mis-parses prose:** it tagged arena=thread/alloc=calloc/exit=group from my text despite stating main arena, malloc, libc exit flush.

**这是"注入错的世界"比"不注入"更有害的直接证明** —— 模型不得不先花时间否证 harness 喂给它的错误前提。
根因 1 是"漏"，根因 2 是"**错**"，而错更贵。

> 两个根因是同一个设计缺陷的两面：**在自由文本上做子串/正则匹配，而不是让观测走结构化字段**。

**根因 3：`requires` 把「未观测」当「被否证」**

`predicate.py:check_requires`：

```python
got = fp.get(key)
if got is None:
    return False, f"unobserved:{key}"     # 硬门，直接 -inf
```

但字段是 `None` 只意味着"还没量到"，不等于"量到是假的"。
按 §4.2 的三态语义，**这属于 `optional`（软扣分），不属于 `requires`（硬门）**。

**根因 3：`local` 档算术上够不到 τ**

```
B(local, n=2) = 0.8 · ln(2) · 0.6 = 0.527  <  τ = 0.9
```

而库里 **34/35 条是 `local`，0 条 `flag`**。单靠 B 项要过线需 n≥10。
所以 `local` 格子**只能靠线索重叠（S 项）被抬起来**。

> `problems` / `habits` 全灭是同一个原因：它们的 `requires` 恒为空、`evidence` 默认 `local` → B=0.333 → 必 below-tau。

### 9.2 采集不稳定

`compile.py` 走 LLM 抽结构，结果随运行波动：

| 运行 | 编译出的 cells |
|---|---|
| T204217 | 含 1 条 ON（成功链被记下来了） |
| RUN-001 | 2 条**全是 OFF**（成功链没进 ON） |

只学到"别做什么"、没学到"做了什么"，是**正记忆缺失**。

### 9.3 其它

| # | 问题 | 说明 |
|---|---|---|
| 1 | 跨题残留 | `test/pwn_2/` 与远端 `~/Tmp/aegis/pwn_1/`、`pwn_2/` 仍在（guard 拦得住，但更干净的做法是清掉） |
| 2 | 文档泄漏 | `manual/pwn_3/EXPERIMENT.md` / `RUNLOG.md` 里写了题目原始 hint 的**原文**，而 agent 能读 `manual/` |
| 3 | 本地超时硬顶 | 扩展 `spawnSync` 硬编码 90s，而工具对外声明 `max 300`——两者不对齐 |
| 4 | 二进制命名 | `test/pwn_1/` 曾用 sha256 当文件名（已修） |

### 9.4 修复优先级

| 顺序 | 修什么 | 量级 | 为什么先修它 |
|---|---|---|---|
| 1 | 指纹正则认散文连接词 | ~3 行 | 不修则观测进不来 |
| 2 | `check_requires` 未观测改软扣分 | ~10 行 | 不修则正解被自己的门挡掉 |
| 3 | `local` 档能过 τ | 1 行 | 不修则 28/29 条经验是死重 |
| 4 | 编译保证成功链进 ON | 提示词 | 不修则没有正记忆可迁移 |
| 5 | 清掉文档里的 hint 原文 | 编辑 | 不修则实验变量失效 |
| 6 | `spawnSync` 超时对齐 | ~3 行 | 减少无谓的 90s 浪费 |

**全部是已有代码里的小修，不需要新子系统。**

---

## 10. 怎么跑

```bash
cd /Users/scemac/My_github/Aegis

# 布置 A 组（有经验）
./manual/pwn_3/arm.sh A
# 原样执行它打印的命令

# 布置 B 组（无经验）
./manual/pwn_3/arm.sh B
```

**两组交错跑（A B A B A B）**，不要先跑完 3 次 A 再跑 3 次 B。

跑完把结果填进对应的 `manual/<题>/RUNLOG.md`。

### 测试

```bash
uv run python tests/run_all.py       # 79/79
```

### 常用诊断

```bash
uv run aegis ram                     # 看实际注入进 system prompt 的东西
uv run aegis ram --no-experience     # 只看 ROM + 工具（对照组用）
uv run aegis recall                  # 看激活了哪些格子、为什么
uv run aegis explain --top 12        # 每条判据为什么亮/不亮（含 hsr@k）
uv run aegis env --probe             # 当前通道 + 可用工具
uv run aegis deny "<命令>"           # 预检某条命令会不会被拒
```

---

## 11. 与 `架构.md` / `框架.md` 的关系

| | 本 demo | `架构.md` / `框架.md` |
|---|---|---|
| 是什么 | 验证一个命题的**最小系统** | 面向通用安全 agent 的**研究纲领** |
| 规模 | `aegis/` 7130 行 | 616 + 466 行规格 |
| 需要的部分 | 记忆四环（§3）+ 执行通道 + 工具层强制 | 五层结构 / 六节点图板 / 调度器 / Worker 池 / 验证阶梯 / 度量体系 |

**demo 不需要实现纲领里的全部内容。** 具体说，以下都**不是**本 demo 的前置条件：

- Oracle Bus 的分级（O1a–O5）/ FPR・FNR 探针 / 弃权机制
- Fact / Refuted / Intent / Hint 的类型化图板
- 调度器、Worker 池、视角分配器、路由表
- pre/post 契约与 PathFidelity
- FFR / CPVF / 成长审计 / 晋升门 / 退场门

这些概念在代码里实测 grep 均为 **0 个文件**——不是缺失，是**故意没做**。

### 但有一条是相关的：裁判必须「健全」，不需要「复杂」

demo 的裁判就是一句话：**拿到 shell / flag，且不是靠关保护拿到的**。
这已经由 `verified` 四档 + `integrity.py` 覆盖。

它需要满足的只有一条：**`verified=local` 必须真的意味着"利用成功了"**。
所以任何让"不解题也能拿到 flag"的口子（比如 `/flag` 全世界可读）
都必须堵——这是**行级规则**的事，不是建裁判系统。

### 纲领对本 demo 的真正价值

**提供词汇和判据**，也就是"为什么这么设计"：

- 为什么存判据不存案例（判别式 vs 生成式，O(log n) vs O(n)）
- 为什么负记忆必须推送而不是等模型来查
- 为什么经验要带成立条件
- 为什么 LLM 不能评判自己的输出

**它是设计依据的来源，不是验收标准的清单。**
