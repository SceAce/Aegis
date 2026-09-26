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

### 未完成（下一轮）

- 父/子 agent 的**真实多 worker 调度**尚未跑过（协议已在黑板上就位：
  `need/declare/claim/report/verdict`，Observer 是黑板唯一写入者）。
- `policy/activate.py` 仍服务旧的 atlas 列（现已空）。它现在只剩测试覆盖价值
  （`test_roleflip.py` 用它验证三态谓词语义）。要么把谓词语义接到经验上，
  要么把测试迁走后退役。
- 黑板的 `verdict` 目前由父 agent 声明；**尚未**把「条件被否证」自动回灌到
  `memory/forget.refute()`（接口有了，没有接线）。

