# 从 CTF Wiki 编译初始经验：规则与边界

状态：**当前有效规则**。本文规定 wiki 文本可以编译成什么、不可以编译成什么，以及必须保留的来源。
基线：`6c2e1b2`（2026-10-20）。契约以 [MEMORY_SCHEMA](MEMORY_SCHEMA.md) §6 为准。

## 1. 先明确一个硬约束

**CTF Wiki 不能直接编译成 active Experience。**

依据 [MEMORY_SCHEMA](MEMORY_SCHEMA.md) §6.2b 与 §6.3：

> Activation uses the same gate as an action: **>=2 independently resolved successful outcomes**
> with verified preconditions, distinct episode/group/reset identities, resolved evidence and
> replays, matching scope, and `when`/`expect` predicates taken from the resolved outcomes
> (not from the candidate prose).
>
> The procedure text comes from an explicitly named committed candidate Experience event...
> A changed text or an unnamed candidate stays `candidate`.
>
> Knowledge-type rules therefore grow from the same evidence gate as tool rules,
> **while the broad wiki stays an unverified external reference.**

代码层同样强制（`memory/experience-compiler.mjs`）：

| 断言 | 位置 | 含义 |
| --- | --- | --- |
| `min_proofs` | `:254` | 至少 2 条可解析证明 |
| `independence`（episode） | `:321` | 至少 2 个不同 `episode_id` |
| `independence`（group） | `:322` | 至少 2 个不同独立性分组 |
| `independence`（isolation） | `:323` | 至少 2 个不同隔离/重置引用 |

`compileExperience({proofs: []})` 的结果是 `status: "candidate"` 且 `validation.failures` 非空。

**因此 wiki 的合法产物只有两种**：文档 seed（已实现）与候选 Experience 提案。前者是未验证外部参考，后者是待验证假设。二者都不是 active Experience。

## 2. 三段式管线

```text
CTF Wiki markdown
   │  ① 机械编译（已有：build-ctf-wiki-seeds.mjs）
   ▼
document-seed-1 JSON          source_kind=external_reference, verified=false, action_policy=none
   │  ② 候选抽取（build-ctf-wiki-experience-candidates.mjs 或 LLM 按本文规则）
   ▼
candidate 提案草稿             kind=candidate, when/do/expect, 带 source_uri + digest
   │  ③ 人工/LLM 复核后提交 aegis_propose
   ▼
proposal.submitted 事件        committed、可审计、不可伪造来源
   │  ④ 真实任务产生 ≥2 个独立 resolved Outcome
   ▼
compileExperience → active    仅 hint/habit 可路由；direct 永久保留给已登记动作
```

第 ③ 步之后，提案才进入事件日志；第 ④ 步之前，任何环节都不能把状态改成 `active`。

## 3. 候选提案的字段契约

提案由 `memory/proposal.mjs::validateProposal` 校验，`kind` 只能是 `claim` / `intent` / `candidate`。

```json
{
  "kind": "candidate",
  "text": "该技法的一句话主张（必填，≤4000 字符）",
  "when": ["可判定前提1", "可判定前提2"],
  "do": "具体做什么（非空字符串）",
  "expect": "预期可观察结果（非空字符串）",
  "scope": "适用域，例如 crypto/rsa（≤400 字符）",
  "source_refs": []
}
```

| 字段 | 约束 |
| --- | --- |
| `text` | 必填，去掉空白后非空，≤4000 字符 |
| `when` | 可选，**字符串数组**，最多 16 条，每条 ≤200 字符 |
| `do` | 可选，**非空字符串**（注意：提案层是字符串，Experience 层才是对象） |
| `expect` | 可选，**非空字符串**，≤4000 字符 |
| `scope` | 可选，≤400 字符 |
| `source_refs` | 可选，最多 12 条；只接受 `{ref_type: event|node|action, ref_id}`，不能塞 URL |

**禁止字段**（`FORBIDDEN_FIELDS`，出现即整条拒绝）：

```
fact, refuted, active, verified, authorization,
oracle_status, outcome, success, trusted,
node_type, node_id, status
```

来源信息（wiki URL、section 范围、digest）**不放进提案**——它们属于草稿的 provenance，由脚本单独记录。提案里的 `source_refs` 只能引用已提交的事件/节点/动作身份。

## 4. 什么可以编译，什么必须拒绝

### 4.1 可以产出候选

- 有明确**前提条件**的技法（"当满足 X 时…"）
- 有**可执行步骤**的技法（有序步骤或命令序列）
- 有**可观察结果**的技法（"得到明文/打印 flag/返回非零"）

三者齐备时，产出一条 `candidate`。

### 4.2 必须拒绝，不得勉强生成

| 情况 | 原因 |
| --- | --- |
| 只有术语定义、无操作 | 无法形成 `do` |
| 只有结论、无前提 | `when` 无法判定，后续无法验证 |
| 步骤依赖未声明的环境（特定版本/私有工具） | scope 不成立，会污染复用 |
| 内容是题目 WP 的特定 flag/密钥 | 属私有结果，不能进知识库 |
| 需要联网攻击真实目标 | 超出当前授权范围 |
| 文本本身自相矛盾或标注"未验证/存疑" | 不能当作技法候选 |

宁可少产，不可把散文硬拆成步骤。**低相关时允许召回为零**（见 KNOW-01）。

## 5. LLM 编译规则

如果由 LLM 而非脚本生成候选，必须遵守：

1. **只输出候选**，不输出 Experience 对象、不带 `status`/`verified`/`active`。
2. **每条候选必须有原文依据**：给出 `source_uri` 与所在 section 的行号范围。没有原文依据的一律丢弃。
3. **`when` 必须是可判定的谓词**，不能是"当遇到密码学问题时"这类空话。合格例：`模数相同且指数不同`、`已知 p 与 q 但 e 与 φ(n) 不互素`。
4. **`do` 必须是别人能照着做的动作序列**，不是"使用常见攻击"。
5. **`expect` 必须可观察**：文件内容、退出码、打印输出、数值关系。
6. **不得合并多个技法**到一条候选；一条候选只对应一个可验证主张。
7. **不得从候选文本反推 `when`/`expect` 去凑验证**——§6.2b 明确要求激活时的谓词取自 resolved outcomes，而不是候选散文。
8. **不得声称已激活**。是否 `active` 由编译器按 §6.3 门槛决定，LLM 与脚本都无权写入。

## 6. 一键入口（推荐）

`build-ctf-wiki-memory.mjs` 把 clone → 文档 seed → 候选 → 分析串成一条命令，产物全部落在 `$AEGIS_HOME`（默认 `~/.Aegis`）：

```bash
node build-ctf-wiki-memory.mjs              # 首次：clone + 编译 + 抽取 + 分析
node build-ctf-wiki-memory.mjs --report     # 只看分析（已有 seed 时）
node build-ctf-wiki-memory.mjs --refresh    # 重新 clone（旧 seed 改名保留）
```

布局：

```text
~/.Aegis/knowledge/seeds/          document-seed-1 JSON + manifest.json
~/.Aegis/knowledge/candidates/     candidates.jsonl + summary.json
~/.Aegis/knowledge/analysis.json   本次运行报告
```

行为：

- 已存在 seeds 时**默认复用**，不重复 clone；`--refresh` 把旧目录改名为 `seeds.previous-<时间戳>`，**从不删除**。
- `--report` 只写 `analysis.json`；`--dry-run` 不写任何文件。
- 权限 `0600`/`0700`，只写 `$AEGIS_HOME` 下，不碰仓库 `knowledge/`。
- 分析报告包含：commit sha、按分类/语言的 seed 分布、截断数、候选数、按分类的候选分布、拒绝原因直方图、机械 triage 信号（`step_count` / `code_block_count`，**不是质量评分**），以及每次都重申的激活边界。

实测（2026-10-20，真实 clone）：771 个 seed、177 个截断、1 条候选、覆盖率 0.13%。

## 6.1 单独使用抽取脚本

`build-ctf-wiki-experience-candidates.mjs` 从 document seed 机械抽取候选草稿。

```bash
# 预览（不写文件）
node build-ctf-wiki-experience-candidates.mjs --dry-run --limit 20

# 生成草稿
node build-ctf-wiki-experience-candidates.mjs --output ~/.Aegis/knowledge/ctf-wiki-candidates

# 只看统计与丢弃原因
node build-ctf-wiki-experience-candidates.mjs --dry-run --report
```

产物（`knowledge/` 已被 gitignore，不入库）：

```
<candidates.jsonl>   每行一条候选草稿，含 provenance
<summary.json>       计数、丢弃原因分布、输入 digest
```

脚本的保证：

- **每条草稿都过一遍真实的 `validateProposal`**；不被接受的不写入，并按原因计数。脚本无法产出运行时会拒绝的提案。
- 确定性：同样输入产生同样输出（按 path + section 排序，无时间戳参与去重）。
- 不联网、不读取 `config/`、不触碰 `runtime/`。
- 只写 `--output` 指定目录，且拒绝写入 `Pi_Agent_base/`（源码区）与 `docs/`（契约区）。

脚本只做**机械**抽取，质量有限：它按标题/列表/条件词匹配，不判断技法是否真实有效。**它是复核队列的生成器，不是知识质量的保证**。正式入库前必须人工或 LLM 按 §5 复核。

### 6.1 实测产出率（2026-10-20，本机）

```bash
node build-ctf-wiki-experience-candidates.mjs --dry-run --report
```

```json
{
  "files_scanned": 772,
  "seeds_read": 771,
  "candidates": 1,
  "rejects": {
    "no_actionable_steps": 3626,
    "no_title": 942,
    "no_verifiable_precondition": 13,
    "no_observable_expectation": 3,
    "source_marks_itself_uncertain": 2
  }
}
```

**772 个 seed 只产出 1 条合格候选**。这不是脚本失效，而是「散文 → 可执行过程」的真实代价：

- 3626 个块没有以动词开头的有序步骤（绝大多数是定义、原理叙述和代码解释）
- 942 个块没有可用标题（文首区块、代码块前后段落）
- 被保留的那条是 `pwn/ret2dir`，具备单句前提、3 步有序动作、可观察结果

结论：**机械抽取只能用来冷启动少量高置信候选，不会产出语料库级别的经验**。若目标是覆盖面，必须走 §5 的 LLM 编译路径，并保留同样严的门槛。宁可召回为零，也不要制造复核噪音。

## 7. 与已有能力的衔接

| 层 | 入口 | 状态 |
| --- | --- | --- |
| 一键冷启动 | `build-ctf-wiki-memory.mjs`（clone + seed + 候选 + 分析） | 本文新增 |
| 文档 seed | `build-ctf-wiki-seeds.mjs` → `$AEGIS_HOME/knowledge/ctf-wiki/` | 已实现；本机 772 个 seed（仓库副本已废弃） |
| RAM 注入 | `AEGIS_RAM_SEED_FILE` / `aegis_knowledge` 检索 | 已实现，`verified:false`、`action_policy:none` |
| 候选草稿 | `build-ctf-wiki-experience-candidates.mjs` | 本文新增 |
| 提案提交 | `/aegis` 或 `aegis_propose`（Pi 工具） | 已实现，只接受提案 |
| 编译与路由 | `experience-compiler.mjs` / `learning-router.mjs` | 已实现，硬门槛不可绕过 |
| 人工命令 | `/aegis learn`、`compile`、`route`、`bind`、`run`、`replay` | 已实现 |

## 8. 验证

```bash
# 机械抽取的确定性
node build-ctf-wiki-experience-candidates.mjs --dry-run --limit 50 --report

# 提案层契约（草稿必须能通过真实校验）
node Pi_Agent_base/tests/aegis-proposal-refs.mjs
node Pi_Agent_base/tests/aegis-memory-context-defects.mjs

# 经验编译门（候选不得变 active）
node Pi_Agent_base/tests/aegis-experience-procedure.mjs
node Pi_Agent_base/tests/aegis-learning-bridge-e.mjs
```

新增脚本自带 `--self-check`，用内联样例验证「只有步骤无前提 → 拒绝」「齐全 → 接受」「含禁止字段 → 拒绝」三条：

```bash
node build-ctf-wiki-experience-candidates.mjs --self-check
```

回归用例见 `Pi_Agent_base/tests/aegis-ctf-wiki-candidates.mjs`（7 例）与 `Pi_Agent_base/tests/aegis-ctf-wiki-memory.mjs`（9 例，不联网）：

```bash
node Pi_Agent_base/tests/aegis-ctf-wiki-candidates.mjs
node Pi_Agent_base/tests/aegis-ctf-wiki-memory.mjs
```

覆盖：self-check、技法块产出/定义性列表拒绝、每条草稿过真实提案门、草稿不含禁止字段、同输入确定性、自标存疑不产出、拒绝写入源码/契约目录；以及编排脚本的布局、复用不重 clone、`--report` 不写候选、`--dry-run` 不写文件、缺 seed 时 fail-closed、分析不声称产出权限或 active。

## 9. 已知限制

1. **机械抽取不判断正确性**。wiki 原文可能有错、过时或依赖特定环境。
2. **候选择优仍靠人工**。脚本产出的是复核队列，不是精选集。
3. **激活仍需真实任务**。本管线只缩短"从零开始"的冷启动，不能让 wiki 变成已证明的方法。
4. **`direct` 永不开放**。procedure 类经验只能走 `hint`/`habit`，因为没有已登记实现与 digest。
