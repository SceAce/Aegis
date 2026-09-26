# docs/ —— 人类专用（agent 读不到）

这个目录和 `manual/` 的分工是**权限边界**，不是整理癖。

| 目录 | 谁能读 | 装什么 |
|---|---|---|
| `manual/<题>/` | **agent** | 注入给它的文档，目前只有 `TASK.md` |
| `docs/`（本目录） | **只有人** | 设计文档、实验方案、run log、操作脚本 |
| `tests/` | **只有人** | 回归测试 |
| `rom/`、`ram/` | agent（由 `aegis ram` 注入） | ROM 与执行环境清单 |
| `runs/`、`.aegis/` | 都不给 | 历史 WP / 记忆库与黑板本体 |
| `vendor/pi/` | 都不给 | 我们的 pi 修改版（见 `vendor/README.md`） |

## 为什么必须分开

`aegis/policy/guard.py` 的 `design_docs` 规则 + 扩展的 `isForbidden` 都会拒绝 agent 读
`docs/`、`tests/` 和几个根目录设计文档。理由不是洁癖，是**实验有效性**：

- 读实验方案 → 知道自己在哪一组、期望解法是什么
- 读 run log → 看到历史结果

> **实测教训**：某轮 pwn_3，模型在第 20、21 次工具调用读了当时放在 `manual/` 里的
> 实验文档，里面写着二进制原始 hint 的原文 ——
> 于是花在 `.rodata` 里的 patch 白做了，transcript 里 `tcache dup` 出现 **89 次**。
> **泄漏口不是 `runs/`，是当时没人管的 `manual/`。**

规则：**agent 注入的文件放 `manual/<题>/`，其余一律进 `docs/`。**

## 文件

| 文件 | 内容 |
|---|---|
| `README.md` | 本文件：权限边界 + 目录结构 |
| `WP_FORMAT.md` | WP 规范（历史，compile 相关部分待重构） |

## 当前状态（2026-09-26）

记忆库与历史 WP 已全部清空，并已完成**分层重构**与 **Observer 原生集成**。

### 目录结构（职责清晰、层次分明、易于扩展）

```
aegis/
  paths.py            布局与配置（单一真相源）
  util.py  llm.py  gitutil.py
  core/               领域模型：纯数据 + 纯函数，无 IO、无 LLM
    events.py           归一化事件（adapter 们共同产出的形状）
    fingerprint.py      世界指纹
    predicate.py        三态求值（requires / forbids / optional）
    criterion.py        成果标准（用户需求 + 阶段任务），取代独立裁判
  observer/           事件 → 记忆 → 经验（全部机械，不调 LLM）
    extract.py          机械抽取与配对、条件归并、记忆、蒸馏
    native.py           读 pi 原生扩展写的事件流（Aegis 自己的 schema）
    pipeline.py         事件流 → 记忆库 → 经验（去重、证据分级）
  memory/             记忆：落盘 + 有证据的遗忘
    store.py            records / aggregates / forgotten 三个 JSONL
    forget.py           压实旧会话、按容量设界、条件被否证即丢弃（留痕）
  blackboard/         公共黑板：阶段/任务/需求的唯一真相源
    store.py            读 + 原子写；schema 不匹配即报错
  policy/             经验 → 行为规范
    playbook.py         经验 → 指引 / 禁令（**唯一**允许影响 worker 的通道）
    activate.py         旧的稀疏激活（历史，仅服务旧 atlas 列）
    intervene.py        三态介入（SILENT / REMIND / FORBID）
    guard.py            命令层拒绝
    integrity.py        关保护检测（压 f+）
  channel/            执行通道
    dockerutil.py  session.py
  knowledge/          外部知识（wiki，永不进策略列）
  storage/            持久化（事件/WP 落盘；compile 已改为机械编译）
  cli/                入口（`aegis.cli:main` 与 `python -m aegis.cli`）
```

依赖方向：`cli → policy → observer/memory → core`。`core` 不依赖任何上层。

**数据流**（三个边界都要能一句话说清）：

```
worker 事件 ──Observer──> 记忆(具体、可遗忘) ──计数──> 经验(可迁移) ──playbook──> worker
                  │                                        ▲
                  └── 记忆本身永远到不了这里 ───────────────┘
```

### 三件已议定的设计（均已落地）

1. **成果标准取代独立裁判** —— 标准 =（用户需求，下一阶段目标）两段**可逐字核对**的
   短标记，由**外部**给出（用户 / 下游），生产者不许写自己的标准。
   核对是机械字面匹配（`core/criterion.py:find_criterion`）。
   父 agent 判断子任务成功与否，依据是「黑板上的需求/任务是否被满足」，
   而不是"工具退出码是不是 0"（实测：931/958 次 `ok`，但只有 2/19 轮真拿到 root）。
2. **记忆** —— Observer 从事件流**机械抽取**，不由 LLM 写入；具体、可遗忘、
   **不驱动行动**。边界用 AST 断言：`policy/playbook.py` 只引用 `Experience`。
3. **经验** —— 由记忆**计数**提纯，是唯一允许影响行为的东西。
   指引要有成功记录；**禁令**要同时满足零成功、≥2 次失败、且条件非空并被当前世界满足。

### 已完成（本轮）

- `storage/compile.py` 已改为机械编译（不再调 LLM）。
- 遗忘机制已实现（`memory/forget.py`）：压实旧会话、容量设界、按证据丢弃，全程留痕。
- 经验驱动行为已落地（`policy/playbook.py`），并接进 `ram` 的提示词。
- 观测条件归并：后量的世界覆盖矛盾的前一个（实测 551 条条件记录，0 条自相矛盾）。
- **经验 → 工具层硬拒绝**（`policy/veto.py`）：满足「零成功 + ≥3 次失败 + 条件非空且成立 +
  能取出可安全匹配的命令词」才升级为拒绝；匹配只在**命令位置**，参数里提到不算。
- `intervene` 已改读经验（原来读已空的 atlas，所以永远 SILENT ——
  看起来「没什么可说」，其实是源头没了）。
- **启动器 `scripts/aegis-pi.sh`**：跑 `vendor/pi`（带原生 Observer），
  并断言 Observer 存在，防止静默回退到上游。

### 已完成（本轮续）

- **启动入口统一**：`paths.PI_SCRIPT` 指向 `scripts/aegis-pi.sh`（我们的 fork），
  不再是上游 `pi-test.sh`。`aegis start` 打印的下一步、`aegis run`、`aegis doctor`
  全部跟着改 —— 原来它们指向上游 pi，而那个 pi 没有 Observer，
  跟过去跑等于记忆链收 0 个事件，结果看起来像「经验没用」。
- **经验 → 工具层硬拒绝已接通**：学来的禁令在构建列时算一次、写进 `activation.json`，
  命令路径只读小文件（原来每条命令重算，是主要的卡顿来源）。
- `aegis explain` 改为解释**经验**（世界标签、适用指引/禁令、未适用原因、硬拒绝），
  不再给已空的 atlas 打分。
- `aegis observe` 改用经验决策（原来读 atlas bundle，永远 SILENT）。
- 删掉死代码：`intervene.decide`（72 行，无人调用）、`_activated_techniques`、
  `explain --tau`（经验路径没有这个旋钮，留着等于假装有）。

### 已完成（真实 run 之后）

第一次真实 pwn_1 跑完（620 事件 / 210 记忆 / 114 经验 / solved），从数据里抓出并修掉四个洞：

- **成果标准不健全（f+ > 0）**。实测第一次命中在 `seq=3` —— 那是**读黑板 JSON**，
  因为 marker 就写在黑板上。三处收紧：只认执行类工具、必须是"打印出来"而不是"被提到"、
  两个标记必须在同一条输出里。
- **证明必须能区分"利用出来的 shell"和"自己起的 shell"**。本地题目两者同 uid，
  磁盘上放不了秘密；唯一能区分的是**进程血缘**。`manual/*/TASK.md` 现在要求输出
  `PARENT_PROC=$(cat /proc/$(awk '{print $4}' /proc/$$/stat)/comm)`，
  真利用得到的是题目二进制名，自己起的是 `python3`/`bash`。
- **审脚本**（`policy/audit.py`）：`direct_flag_read` 确凿 → 判决降级为 `none`、记忆不记成功；
  `self_printed_marker` 存疑 → 只记 issue，不擅自否定（误报比漏报贵）。
- **证据归档**（`storage/compile.archive_scripts`）：`finish` 会 `git clean -fd` 删掉
  `test/<ch>` 里的脚本（防下一轮偷看），但那样也毁掉了唯一证据。现在先复制到
  `.aegis/artifacts/<时间戳>_<题>/`（同样对 agent 不可读），审计可复查。
- 非手法工具（`aegis_board` / `aegis_kb` / `aegis_finish` …）不再计进经验（114 → 105 行）。
- 重复 issue 折成计数（29 行 → 6 条），WP 的 problems 段不再被同一条 sync 刷屏。

### 已完成（中文思考规则 + 可审计）

- **硬性规则：一律用中文思考和交流**（写进 `rom/ROM.md` 与 `AGENTS.md`，含 thinking）。
- **思考过程可被审计**：Observer 现在把 assistant 的 `thinking`/text 记成 `thought` 事件
  （`vendor/pi` 的 `message_end`），`aegis observer thoughts` 全文读回。
  `thought` **按构造进不了记忆** —— 记忆只配对 `action` 与 `outcome`，
  解释不是观测。实测一次真实运行：`{boundary:2, thought:4, action:2, outcome:2, note:3}`。
- **`aegis observer` 改读原生事件流**（原来读 pi 的 session 日志 —— 那是另一条更差的源，
  所以 `thoughts` 明明有数据却报 0 段）。

### 已完成（pwn_3 真实 run 之后）

第二次真实运行：`pwn_3`（堆题，glibc 2.43），2585.4s，`status=failed`、`verified=local`。
利用链**走通了**（`delete` 不置空 + `edit` 改 tcache key 绕 2.43 double-free 检测 →
tcache dup → `strdup` 别名 → 任意地址写 0x1f 字节 → 栈/PIE 泄漏 → ROP → `system("/bin/sh")`，
成功打印 `PWNED_MARKER` 与 `uid=1000(hack)`），但标准要的第三段没有拿到：
`PARENT_PROC=sh`（走 `system`）或 `PARENT_PROC=python3`（in-place one_gadget `execve`），
从不是 `pwn`。真正卡住它的是**单区域 0x1f 字节写入上限** ——
4-qword 对齐 ROP 所需的 RET gadget 与 `"exec /bin/sh"` 字符串塞不进 31 字节。
**标准拒绝给它盖章，这是对的**。

这一轮从数据里抓出并修掉两个洞：

- **世界标签错一位 → 205 行经验全部失效**。它把版本标成 `glibc2.44`，而自己的观测正文写着
  `Ubuntu GLIBC 2.43-2ubuntu2.4`。经验行按版本精确匹配，所以 `aegis explain` 报
  **「共 205 行；这个世界适用 0 行」**（`status.counts.cells=0`），而 run 报告里
  `experience.rows=205 / with_success=201` —— 经验学到了，只是被挂在一个不存在的世界上。
  这会被读成"经验不迁移"，实际原因是打错一位数字。修法见
  `observer/extract.contradictory_glibc`：只否证**自相矛盾**的观测，绝不从散文里反推世界
  （正文没有版本号、或声明了多个版本时一律弃权）；两个读路径都丢
  （`observed_tags` 走事件流，`add_observation` 走 `fingerprint` —— 后者是
  `experience_playbook` 的 fallback），并在 `aegis observe` 当场告诉 agent 重观测一次。
- **`aegis observer thoughts | head -80` 会打 `BrokenPipeError` traceback**。管道早关是
  正常用法，而这个项目的工具输出**就是**审计材料 —— 审计末尾一段 traceback 和真崩了
  没法区分。现在只吞 `BrokenPipeError`（其余异常照旧抛出），退出码 0。
  `tests/test_cli.py` 故意造 >64K 事件：小于管道缓冲时失败发生在解释器退出 flush，
  已经在 `main()` 之外，那样测试对着未修的代码也会过（已验证未修时 exit 120 + traceback）。

### 待定（需要人来定，不自作决定）

- **经验为什么"0 行适用"有两个原因，不是一个**。修完 glibc 错标之后，
  `aegis explain` 仍只从 0/205 变成 1/204。第二个原因更根本：

  1. **记忆条件跨 run 串味（已修）**。`build_memory` 的世界累加器不按 session 重置，
     于是上一轮的世界变成下一轮的条件 —— 实测 pwn_3 的 120 条记录里 **114 条**挂在
     pwn_1 的 `glibc2.27/fastbin/hooks_alive` 加上一次中断尝试留下的 `pwn` 标签上。
     `world_tags` 早就按 session 限定了，所以那个世界永远不可能被满足。
     现已按 session 重置（`test_one_run_world_never_becomes_the_next_run_condition`）。
  2. **条件是"派生值"，改了规则也不会回填到已存的记录**。`sync` 按 `(session, seq)` 去重，
     永不覆盖，所以修好提取规则后旧库存仍按旧规则作答 —— 看起来和"没修"一模一样。
     新增 `aegis relearn`（`pipeline.relearn`）：只重算 `condition`，
     **不动 `ok`**（每轮的证据等级没有按记录存，重算会把 `none`/`wiki` 的降级悄悄升回成功）。
     已对现有库存执行：344 条中 134 条条件被纠正。

- **`applies()` 会否掉"无条件经验"，而这恰好是真实 run 的大多数**。
  `playbook.applies` 里 `if not experience.condition: return not world`
  —— 一旦世界非空，无条件经验就不适用。而条件只在观测之后才变具体，
  agent 总是先动手后观测：pwn_3 的 114/120 条记录条件是**空**的（它把观测都放在 seq 423+），
  于是它们全部被这条规则否掉。就是说"经验驱动行为"在当前写法下**很难触发**，
  不是数据问题而是判据问题。可考虑：空条件按"弱经验"降权展示，而不是直接否掉。
- **世界标签丢了版本号后，两个世界来源不一致**。`observed_tags` 丢掉自相矛盾的
  `glibc2.44` 后，`world_tags` 里就**没有版本**了（实测 pwn_3 = 5 个标签，无 glibc）；
  而 `current_fingerprint` 走 `core.fingerprint.parse`，它会从正文里**读**出版本 2.43。
  `experience_playbook` 在 `world_tags` 非空时优先用它，于是按版本存的经验全部落空。
  即：指纹路径允许"从散文取版本"，观测路径禁止 —— 两条路径对同一件事给了不同答案。
  要么让丢弃时用正文里的版本回填，要么把指纹路径也收紧，**不能两套并存**。
- **`PARENT_PROC=pwn` 有假阴性**。真利用也可能拿不到这个值：in-place one_gadget 的
  `execve("/bin/sh")` 让 shell **变成**题目进程本身，父进程是起它的脚本（`python3`）；
  经 `system` 的 shell 父进程是 `sh`。两者都是真利用，却和"自己起一个 shell"撞在同一条
  判据上。可选的收紧/放宽：① 认 `system("exec /bin/sh")` 语义（父进程仍是 `pwn`，
  但要求 agent 把这串塞进写窗口）；② 接受"题目进程 execve 成了 shell"这条血缘
  （判据从"父进程名"改成"祖先里有题目二进制 **且** 该进程已不存在"）；
  ③ 另加一条可机检证据（例如 exploit 必须让题目进程自己打印 marker）。
  在定下来之前**不改** `manual/*/TASK.md` 的标准。

### 未完成（下一轮）

- 父/子 agent 的**真实多 worker 调度**尚未跑过（协议已在黑板上就位：
  `need/declare/claim/report/verdict`，Observer 是黑板唯一写入者）。
- `policy/activate.py` 仍服务旧的 atlas 列（现已空）。它现在只剩测试覆盖价值
  （`test_roleflip.py` 用它验证三态谓词语义）。要么把谓词语义接到经验上，
  要么把测试迁走后退役。
- 黑板的 `verdict` 目前由父 agent 声明；**尚未**把「条件被否证」自动回灌到
  `memory/forget.refute()`（接口有了，没有接线）。

