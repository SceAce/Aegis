# 使用方法：手动注入记忆，重测 pwn_1

目标：**不依赖项目的记忆/提取系统**，只手动喂"工具用法 + 一整块堆知识"，
看模型能不能自己解出 pwn_1。这是"经验有没有促进"必须有的**基线**。

---

## 0. 先修一个阻塞项（必须做，否则题跑不起来）

审计发现 `test/pwn_1/` 里二进制的文件名是 sha256，不是 `pwn`：

```
test/pwn_1/0b5afea12c42b8213acd5adee63c0b8d2faf6126f9c9c5378718e5dff31ebd73
```

上一轮 WP 里 agent 就被迫写 `binary = "./0b5afea12c...ebd73"`，
pwninit 也因此没法按常规命名工作。**先改名并入库**：

```bash
cd /Users/scemac/My_github/Aegis
git mv test/pwn_1/0b5afea12c42b8213acd5adee63c0b8d2faf6126f9c9c5378718e5dff31ebd73 \
       test/pwn_1/pwn
git add -A test/pwn_1
git commit -m "test/pwn_1: use the real binary name so start/pwninit work"
```

`test/<id>/` 必须已 commit，否则 `aegis start` 的 `git restore` 会把新名字冲掉。

---

## 1. 启动

```bash
cd /Users/scemac/My_github/Aegis
uv run aegis start pwn_1
```

（如果 `uv` 报 cache 权限错：`UV_CACHE_DIR=/tmp/uvcache uv run aegis start pwn_1`）

`start` 会：git restore → 推送到执行通道 → 跑 pwninit（加执行位、checksec、生成 `exp.py`）
→ 写 `.aegis/current.json`。

---

## 2. 确认"注入面"是干净的

这一步是**实验有效性**的关键。看项目当前会往 system prompt 里塞什么：

```bash
uv run aegis ram | sed -n '/^# 经验/,$p'
```

期望看到：**没有任何 `## 策略格子`**。当前实测输出是：

```
# 经验（冷启动：尚无观测，只注入开局要量的量）

## 开局先量
- when ...: ...
- when ...: ...
- when ...: ...

## 背景参考（CTF Wiki，未在本系统验证）
- ...
- ...

（或"无适用经验"一行）
```

也就是说：**项目此刻注入的经验 ≈ 0 条策略格子**。
这正是我们要的基线——项目没帮忙，也没捣乱。

> 注意：`aegis start` 会把 checksec 结论记成观测，
> 于是标题可能变成"按当前世界稀疏激活"、习惯段变成"适用习惯"。
> **这不影响实验**：实测在 checksec / glibc2.27 / 完整 2.27 世界下，
> `cells` 仍然是 **0**（这正是审计出的提取失效）。

**如果你要绝对隔离**（连那 3 条开局习惯和 2 条 wiki 参考都不要），
把扩展的记忆注入关掉（可逆，改完重启 pi）：

```ts
// .pi/extensions/aegis.ts 约第 86 行
// 原：
ram = aegis(["ram"]).trim();
// 改为：
ram = process.env.AEGIS_NO_MEMORY ? "" : aegis(["ram"]).trim();
```

然后启动时带上 `AEGIS_NO_MEMORY=1`。工具（`aegis_pwn` / `aegis_shell`）**不受影响**，
只是不再注入经验列。

---

## 3. 发任务提示词

```bash
cd /Users/scemac/My_github/Aegis
AEGIS_CHALLENGE=pwn_1 pi --approve --provider deepseek --model deepseek-flash
```

然后**把 `manual/pwn_1/TASK.md` 的正文整段贴进去**作为第一条消息。

（或更省事：直接发一句
**"读 `manual/pwn_1/TASK.md` 并照做"** —— 提示词里已经让它先读 `HEAP_KB.md`。）

想更严格地隔离记忆时：

```bash
AEGIS_CHALLENGE=pwn_1 AEGIS_NO_MEMORY=1 pi --approve --provider deepseek --model deepseek-flash
```

---

## 4. 记录（实验数据）

跑完后从这个文件取数：

```
runs/<时间戳>_pwn_1.md
```

要记的三项（HANDOFF §0 定的指标）：

| 指标 | 从哪看 |
|---|---|
| 是否打通 | `status` + `verified`（`local` 也算打通；只有 `none` 是没通） |
| 耗时 | `elapsed_s` |
| 卡点性质 | `stuck` 是"选错时代"（版本/hooks/退出路径判断错）还是"本题细节" |

**对照组**（历史 4 次 pwn_1，来自 README）：

| 运行 | 耗时 | 状态 | verified |
|---|---|---|---|
| T001918 | 865.8s | solved | — |
| T084949 | 683.1s | solved | — |
| T114204 | 1059.3s | solved | local |
| T215359 | 970.9s | solved | local |
| T204217 | 845.5s | solved | local |

注意：T084949 那次模型**记得自己上次的解法**，不算独立样本。
这次是手动注入知识块、**没有任何本题记忆**，所以是真正可比的新样本。

---

## 5. 这次实验要回答什么

| 问题 | 判据 |
|---|---|
| 光给机制知识块 + 工具，能不能解出？ | `verified` ∈ {flag, local} |
| 比"带着经验"更快还是更慢？ | `elapsed_s` 对比上表 |
| 卡点是"选错时代"还是"本题细节"？ | `stuck` 文本 |
| 它自己量出了真实 libc 吗？ | episodes 里的 `observe` 记录 |

如果**知识块基线就能解出、且不比"带经验"慢**，
那就说明当前经验库没有增量价值（和 README 的"没有证据表明经验提升效率"一致），
问题在提取——就是审计出的那一串。

---

## 6. 跑完别忘了

```bash
uv run aegis finish        # 或在 pi 里调 aegis_finish
```

`finish` 会用 git 把 `test/pwn_1/` 恢复成入库快照，避免下一题读到本题痕迹。
**注意**：`test/pwn_2/` 里现在仍躺着 pwn_2 的二进制，
审计已指出这是跨题污染源——换题之前先确认它已被归档或清理。

---

## 文件

| 文件 | 作用 |
|---|---|
| `manual/pwn_1/HEAP_KB.md` | **注入的记忆块**：堆机制知识 + 工具用法 |
| `manual/pwn_1/TASK.md` | **发给 Agent 的提示词**（纯 prompt，不含元信息） |
| `manual/pwn_1/RUNLOG.md` | **本次实验的完整记录**，跑完填结果，供事后分析 |
| `manual/pwn_1/HOWTO.md` | 本文件：怎么跑（人看） |
| `manual/WP_FORMAT.md` | WP 规范 v2（机器可解析，供 compile 确定性解析） |
