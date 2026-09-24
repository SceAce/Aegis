# Aegis demo 交接：经验利用（给实现 Agent）

## 0. 这个 demo 只回答一个问题

**经验有没有促进模型把题解出来、把任务做完。**

不测框架是否优雅，不测多模型，不测把 WP 检索进上下文。  
对比轴只有：有跨题/跨次编译经验 vs 无。指标是：是否打通（远程/flag 优先）、耗时、卡点有没有从「选错时代」变成「本题细节」。

别人的 WP **可以**作为训练：按题解在本题环境复现 → 过裁判（flag）→ 再编译进经验。WP 原文不准进 RAM。

---

## 1. 现状（你接手时已经坏在哪）

代码在 `aegis/activate.py`、`aegis/store.py` 的 `ram_blob`、`aegis/compile.py`、`.pi/extensions/aegis.ts`。

`AEGIS_CHALLENGE=pwn_1|pwn_2 uv run aegis recall` 现在能分出 2.44 vs 2.27 指纹，**但利用仍然粗糙**：

1. **本题旧格子几乎全亮。** pwn_1 点亮 `0x91` / `0x80` / House of Apple 整条链；pwn_2 点亮 `fastbinsY[5]` / `malloc(0x60)`。这是「把上次题解再喂回去」，不是按当前世界激活可迁移条件。重跑同一题会虚高「经验有用」。
2. **习惯串题。** pwn_2 仍出现 calloc/tcache-key（来自 pwn_1）；pwn_1 仍出现「无 free/show 去打 top/arena」（来自 pwn_2）。因为 `tcache` 等泛线索重叠就算命中。
3. **灭的格子没有变成行为约束。** FSOP 在 `exit_group` 上应是硬过滤，现在只是不显示 ON。模型仍可自己去试。
4. **SKIP 仍是短文，不是工具层拒绝。** 只有 libc `objdump` 在 `aegis/guard.py` 里真拒绝。
5. **指纹来源错误。** `kind=pwn` 曾经当线索（已修）。现在改成本题 `lessons.json` 全文抽线索，导致「同一题的全部条件」被当成当前世界，等于开卷抄自己。
6. **假阳性 solved 已污染库。** pwn_2 第一次本地 FSOP 当 solved 写过 ON；远程失败才部分证伪。制作侧仍可能把未过 flag 的链写进 RAM。
7. **双终端** 必须 `AEGIS_CHALLENGE=<id>`，状态在 `.aegis/run-<id>.json`。不要抢 `current.json`。

---

## 2. 利用必须变成的算法（有论文，不要再发明课文倾倒）

不要把 lessons 全文塞进 system prompt。要 **稀疏激活**：

| 来源 | 用法 |
|---|---|
| ACT-R 激活方程（Anderson） | \(A = B + S - \lambda M\)；\(A < \tau\) 不提取 |
| 海马索引（Teyler & DiScenna 1986；Teyler & Rudy 2007） | 索引不是内容；部分线索做 pattern completion |
| HippoRAG / HippoRAG 2（NeurIPS 2024 / ICML 2025） | 线索当种子扩散；冲突则不取 |
| Lost in the Middle（Liu et al., TACL 2024） | 点亮列放窗口两端；中间不许堆经验 |
| MoE top-k（Shazeer et al., ICLR 2017） | 灭的专家权重必须是 0，不是「请忽略」 |

### 2.1 指纹（线索）允许从哪来

只允许：

- 本题 Hint（`aegis start --hint` / `aegis hint`）
- 本题本轮观测（agent 调用 `aegis_note` / 将来的 `aegis_observe`：libc 版本、arena、有无 free/show、退出路径）
- 显式 `current.fingerprint`

**禁止：**

- 用 `kind=pwn` 当线索
- 用本题历史 lessons **全文**当指纹（会把题解当世界）
- 用另一题的数字地址（`0x602038`、`0x91`）当可迁移格子

同一题重跑时，若没有任何观测，RAM **只注入开局习惯**（先量 libc / arena / 退出路径），不要把上次的利用链点亮。要测「经验促进」，应测 **pwn_1 的经验是否帮助 pwn_2**，或测「只注入机制层格子、不注入本题数字」。

### 2.2 计分与否决

对每条 cell / problem / habit：

- 从 `condition`/`when` 抽出机制标签：`glibc2.23|2.27|2.44`、`hooks_alive|hooks_dead`、`thread_arena`、`exit_group`、`tcache`、`fastbin`、`fsop`
- **版本标签是必填线索：** 条目带 `glibc=2.44` 而指纹没有 2.44 → \(A=-\infty\)（不是降权）
- 指纹 2.27 与条目 2.44 / `hooks_dead` / House of Apple → 硬冲突
- 指纹 `exit_group` 与条目 `fsop` → 硬冲突
- 泛词（`tcache`、`heap`、`pwn`）**单独不能**点亮一条格子
- 无任何机制重叠 → 不注入
- 开局习惯白名单（「先量真实 libc」）在指纹为空时可以注入，最多 3 条

只取 \(A \ge \tau\) 的 top-k（建议 k≤6 格子、k≤4 问题）。  
**OFF 格子**若条件与指纹匹配，必须进入「禁止尝试」列表，而不是从 prompt 里消失。

### 2.3 装配进模型的方式

```
[ROM 头]
[TOOLS 短表]
……中间不要放经验……
[人类 Hint]
[当前点亮列：OFF/SKIP 硬约束 + 少量 ON 格子 + 开局要量的量]
```

SKIP 必须接到工具：匹配的 `aegis_pwn` 命令直接 REFUSED（已有 libc objdump 范例）。「不要 interactive」「不要 curl WP」也应是工具拒绝，不是作文。

### 2.4 制作（编译）的最低纪律（利用再精，制作脏则无效）

`aegis_finish` 自动编译，人不准手填格子。

- 没有 flag / 远程可检验结局，**不准**把链写成 ON；本地通远程不通必须写 OFF 并写明条件（如 `exit_group`）
- 格子 technique ≤80 字、至多一个 `->`，condition 必须是机制层
- 数字地址、本题 chunk size 进 episodes，不准进 atlas
- WP 复现：WP 只当 Hint → 跑出 flag → 对照「WP 骨架 vs 自己改的布局」再编译
- 本轮 issues 与上一轮 issues 分开，不要按题名无限追加进 WP

---

## 3. 你需要改的代码位置

| 文件 | 做什么 |
|---|---|
| `aegis/activate.py` | 重写计分：版本必填、泛线索无效、OFF 输出、禁止 lessons 全文当指纹 |
| `aegis/store.py` `ram_blob` | 指纹只来自 hint + 本轮 observe；输出 OFF 段 |
| `aegis/guard.py` + `.pi/extensions/aegis.ts` | 激活后的 SKIP 真正拒绝命令 |
| `aegis/compile.py` | 假阳性 solved、机制层、本轮 issues、WP 复现对照 |
| `aegis/cli.py` | 保持 `AEGIS_CHALLENGE`；`start --hint`；`observe` 写入 fingerprint |

不要把经验库做成向量 RAG。不要把 `架构.md` 当知识灌进 Pi。

---

## 4. 验收（只看这个）

并行（必须带 env）：

```bash
uv run aegis start pwn_1
AEGIS_CHALLENGE=pwn_1 pi --approve --provider deepseek --model deepseek-flash

uv run aegis start pwn_2 --hint '环境是 ubuntu 18.04'
AEGIS_CHALLENGE=pwn_2 pi --approve --provider deepseek --model deepseek-flash
```

`recall` 必须满足：

- pwn_2 **不得**出现 House of Apple / `glibc=2.44` / `_IO_wfile_jumps`
- pwn_1 **不得**出现 `0x602038` / `fastbinsY[5]` / thread arena 耗尽 64MB
- 两边都不得靠「本题上次数字题解」全亮；无观测时只亮「先量 libc」
- 模型对 libc `objdump`、无超时 interactive，应被工具拒绝而不是再读一段 SKIP 作文

解题实验：同一套经验下，**不丢本题 WP** 打 pwn_2（或新题），看有没有比无经验更快/更能出 flag。有本题 WP 的复现轮单独记账，不和「经验是否促进」混在一张表里。

---

## 5. 仓库约定

- 记忆：`.aegis/`（gitignore）
- WP：`runs/`（gitignore，按时间排序）
- `test/<id>/` 必须已 commit，否则 `start/finish` 的 git restore 会盖掉新题
- 双终端 finish 不要撞同一秒写 `lessons.json`（最好加文件锁）
- 不 push；提交信息说人话
