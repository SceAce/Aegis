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
    extract.py          机械抽取与配对、记忆、蒸馏
    native.py           读 pi 原生扩展写的事件流（Aegis 自己的 schema）
  blackboard/         公共黑板：阶段/任务/需求的唯一真相源
    store.py            读 + 原子写；schema 不匹配即报错
  policy/             经验 → 行为规范
    activate.py         稀疏激活（只有经验允许影响行为）
    intervene.py        三态介入（SILENT / REMIND / FORBID）
    guard.py            命令层拒绝
    integrity.py        关保护检测（压 f+）
  channel/            执行通道
    dockerutil.py  session.py
  knowledge/          外部知识（wiki，永不进策略列）
  storage/            持久化（历史记忆库 / WP / compile，待重构）
  cli/                入口（`aegis.cli:main` 与 `python -m aegis.cli`）
```

依赖方向：`cli → policy/observer/blackboard → core`。`core` 不依赖任何上层。

### 三件已议定的设计

1. **成果标准取代独立裁判** —— 标准 =（用户需求，下一阶段目标）两段**可逐字核对**的
   短标记，由**外部**给出（用户 / 下游），生产者不许写自己的标准。
   核对是机械字面匹配（`core/criterion.py:find_criterion`）。
2. **记忆** —— Observer 从 worker 事件日志**机械抽取**，不由 LLM 写入；
   具体、可遗忘、**不驱动行动**（有测试断言它进不了行为路径）。
3. **经验** —— 由记忆机械计数提纯，是唯一允许影响行为的东西。
   父 agent 判断子任务成功与否，依据是「黑板上的用户需求或阶段任务是否被满足」，
   而不是"工具退出码是不是 0"。

### 未完成（下一轮）

- `storage/compile.py` 仍用 LLM 从散文抽结构 —— 与「记忆不由 LLM 写入」冲突，要重写。
- 经验驱动行为的具体形态（软提示 vs 硬拒绝）尚未落地。
- 记忆的遗忘机制尚未实现。
- 父/子 agent 的真实多 worker 调度尚未验证（协议已在黑板上就位）。
