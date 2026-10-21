# Aegis

Aegis 是一个**事件溯源（event-sourced）的受控 Agent** 。运行时，用于在明确的授权、预算和证据边界内执行任务。它的核心不是“让模型随便调用工具”，而是把：

```text
Event → Episode → Outcome → Experience
```

串成一条可审计、可恢复、可独立判定的链路。模型输出始终是**提案**；观察、声明、行动和结果分开记录；只有独立 Oracle 或明确的人类确认才能产生 `Outcome` / `Fact` / active `Experience`。

当前状态：核心机制层已实现并有离线测试证据，能力层和真实效果层仍在推进。具体测试基线、已知 red 和后置项见 [Campaign 测试矩阵](docs/CAMPAIGN_TEST_MATRIX.md)；各入口真实能力见 [入口能力清单](docs/AEGIS_ENTRY_CAPABILITIES.md)。不要把“代码存在”当成“真实任务已验收”。

---

## 1. 架构总览

```text
用户目标 / 授权 / 预算
        │
        ▼
Campaign Manifest / Config ── 冻结任务、目标、预算、adapter
        │
        ▼
Host / Scheduler ── 任务图、队列、Session、请求/工具账本、恢复
        │
        ├── Router ── active Experience → direct / habit / hint / deliberate
        │
        ▼
Broker / 已登记 Action ── 固定 executable + argv + digest + Oracle
        │
        ▼
真实 workspace / 目标 ── 原始 transport / 产物 / 证据
        │
        ▼
独立 Oracle / Host Oracle ── success / failure / unknown / invalid
        │
        ▼
Board / RAM / Report / Learning ── Fact / Hint / Artifact / Experience
```

两条能力面（不要混用它们的证据）：

| 能力面 | 入口 | 特点 |
| --- | --- | --- |
| 真实工具面 | `run-aegis.sh`、`run-pi.sh`、`contest/run.sh` | Pi 原生工具 + Observer；有真实 shell/编辑能力，但没有 Campaign 请求/工具账本和独立 Oracle |
| 受控执行面 | `campaign/c6-entry.mjs` | 冻结 Manifest、Scheduler、Broker、双侧账本、独立 Oracle；动作仅限已登记 adapter |

### 模块职责

| 目录 | 职责 |
| --- | --- |
| `Pi_Agent_base/memory/` | Board、RAM、RuntimeState、证据解析、Experience 编译/路由、知识、提案、工具目录 |
| `Pi_Agent_base/campaign/` | Manifest、配置、规划、队列、Scheduler/Host、authority、账本、产品入口 |
| `Pi_Agent_base/execution/` | ActionContract、授权、Broker、脚本注册、artifact 读取、web search |
| `Pi_Agent_base/verification/` | Host Oracle、Outcome 解析/聚合、注册测试、replay/live Oracle |
| `Pi_Agent_base/observation/` | 只读 HTTP、报告、TUI、E1 观测 |
| `Pi_Agent_base/session/` | 交接判断、Host 交接、Session 监督 |
| `Pi_Agent_base/orchestration/` | 工作流引擎、work-control、remote HTTP/cookie/platform |
| `Pi_Agent_base/shared/` | EventLog、canonical digest、通用契约/路径/文件 |
| `Pi_Agent_base/extensions/` | Pi 接线：Observer、Contest、Fixture 工具 |
| `Pi_Agent_base/agent/ROM.md` | 分层固定指令（身份/证据/方法/记忆/工具/交付） |
| `Pi_Agent_base/tests/` | 纯 Node / SDK+faux / 故障恢复 / 审计用例 |

内嵌 `Pi_Agent_base/pi/` 是独立嵌套仓库，已冻结在 Aegis 基线；不要在主仓库里修改它。详见 [工程入口](Pi_Agent_base/AGENTS.md) 和 [Pi 规则](Pi_Agent_base/pi/AGENTS.md)。

---

## 2. 快速上手

### 2.1 环境要求

- macOS 或 Linux
- Node.js（版本以 `install.sh` 检查为准）
- Git
- 可选：Docker/Colima（本地靶场，后续）
- 可选：DeepSeek API Key（技法搜索；默认从 Aegis agent 配置读取）

### 2.2 安装

```bash
cd /path/to/Aegis

# 只做环境检查，不联网、不写 ~/.Aegis 之外
./install.sh

# 全新克隆的一键安装：clone pi + npm install + 构建 bundle + 离线冒烟
./install.sh --all
```

`--all` 会 clone `SceAce/pi` 的 `feat/aegis-shell-layout` 分支，安装依赖并构建 bundle；需要网络。默认无参数只检查，不修改 `~/.pi`。

### 2.3 启动

```bash
# 源码 TUI（推荐开发/调试）
./Pi_Agent_base/run-aegis.sh --model <provider/model>

# 已构建 bundle
./Pi_Agent_base/run-pi.sh --model <provider/model>

# 隔离实验：workspace/runtime/sessions/server 全部按 label 派生
./run-experiment.sh my-001 --here
./run-experiment.sh my-001 --workspace ./challenge --attach ./files

# 比赛入口（固定工具 allowlist，不自动开搜索）
./Pi_Agent_base/contest/run.sh --hint
```

默认状态根是 `~/.Aegis/`；可用 `AEGIS_HOME` 覆盖。凭据放在 `~/.Aegis/agent/`，不要提交。`run-experiment.sh` 默认共享凭据，MCP 默认关闭；`--mcp` 只开非浏览器 server，`--mcp-all` 才全开。

### 2.4 验证

```bash
# required 矩阵（仓库根）
bash Pi_Agent_base/tests/helpers/run-required.sh

# 聚焦检查
node Pi_Agent_base/tests/aegis-web-search.mjs
node Pi_Agent_base/tests/aegis-ram-overflow-boundary.mjs
node Pi_Agent_base/tests/observer-smoke.mjs
node Pi_Agent_base/tests/aegis-module-layout.mjs

# SDK 测试需要 source resolver
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/aegis-knowledge-sdk.mjs
```

---

## 3. 知识库（全部在 `~/.Aegis`）

**仓库没有 `knowledge/` 目录。** 所有 wiki、技法卡、CVE 文档和检索 seed 都在：

```text
$AEGIS_HOME/knowledge/                  # 默认 ~/.Aegis/knowledge
├── ctf-wiki/                           # GitHub Markdown 编译的 document-seed-1
├── techniques/                         # 人工技法卡（本地唯一副本，不入 Git）
│   ├── build_cards.py                  # 卡片唯一来源
│   ├── cards/<id>.md                   # 人读卡片
│   ├── cards.json                      # 比赛 hint 卡
│   ├── candidates.json                 # candidate Experience 提案草稿
│   ├── seeds/<id>.json                 # document-seed-1，供检索
│   └── INVENTORY.md
└── documents/                          # 本地 CVE/文档 seed
```

`AEGIS_KNOWLEDGE_DIR` 可覆盖根目录。默认根缺失时检索返回 `unavailable`，不会回落到仓库。

### 3.1 编译 CTF Wiki

```bash
# 一键：clone → document seed → candidate → analysis
node build-ctf-wiki-memory.mjs

# 只重新分析已有 seed
node build-ctf-wiki-memory.mjs --report

# 只编译 GitHub 仓库（commit pin，输出目录必须不存在）
node build-ctf-wiki-seeds.mjs \
  --github-repo https://github.com/ctf-wiki/ctf-wiki.git \
  --github-ref <commit-sha> \
  --github-output ~/.Aegis/knowledge/ctf-wiki
```

产物是 `document-seed-1`，固定 `verified=false`、`action_policy=none`。wiki 只能产出文档 seed 和 candidate 提案，不能直接变成 active Experience。

### 3.2 制作技法卡

技法卡是**人工审过的 hint**，不是 Fact，也不是 active Experience。卡格式见 [卡片 schema](docs/TECHNIQUE_CARD_SCHEMA.md)。

```bash
# build_cards.py 已随卡片移到 AEGIS home；用 AEGIS_REPO 指向代码 checkout
AEGIS_REPO=/path/to/Aegis python3 ~/.Aegis/knowledge/techniques/build_cards.py
```

新增卡片时只改 `build_cards.py` 的 `CARDS` / `CVE_CARDS` 列表，字段：

```python
{
  "id": "web-php-disable-functions-bypass",
  "title": "...",
  "category": "web",
  "when": ["php", "disable_functions", "open_basedir"],
  "sources": ["https://..."],
  "source_kind": "vendor-doc",   # 可选：ctf-wiki / cve-reference / vendor-doc
  "when_text": "可观察前提",
  "steps": ["可执行步骤 1", "..."],
  "expect": "可观察结果",
  "pitfalls": "失效条件 / 限制",
}
```

脚本会生成 `cards/<id>.md`、`cards.json`、`candidates.json`、`seeds/<id>.json` 和 `INVENTORY.md`。不要手改生成物。

### 3.3 制作 CVE 文档 seed

CVE 细节适合做成本地文档，而不是卡片。用现有 `compile-document-seed.mjs`：

```bash
# 1) 写 Markdown，建议固定分节
cat > ~/.Aegis/knowledge/documents/CVE-2021-4034.md <<'MD'
# CVE-2021-4034 PwnKit
## Affected
...
## Fingerprint
...
## Preconditions
...
## Primitive
...
## Adapt
...
## Verify
...
## Limits
...
## References
...
MD

# 2) 编译成 document-seed-1
node compile-document-seed.mjs \
  --input ~/.Aegis/knowledge/documents/CVE-2021-4034.md \
  --output ~/.Aegis/knowledge/documents/CVE-2021-4034.seed.json
```

不要写 flag、私有目标、凭据或完整未授权会话。CVE 文档仍是参考数据，不是 Outcome。

### 3.4 技术搜索

本地无覆盖时，模型可调用 `aegis_web_search` 查询 DeepSeek Search 的**技法/CVE/tool** 参考：

- 默认 `run-aegis.sh` / `run-pi.sh` / `run-experiment.sh` 开启；`--no-web-search` 关闭。
- Key 顺序：`AEGIS_SEARCH_API_KEY` / `DEEPSEEK_API_KEY`，否则从默认 agent 配置读取 `api.deepseek.com` provider（`$AEGIS_HOME/agent/{models,auth}.json`，通常是 `deedeepseek`）。
- 当前 target 的 host/domain/port、task id、本 Episode 已见 WP host/slug 自动加入 denylist；`AEGIS_SEARCH_DENY` 可补挑战名。
- `purpose` 只能是 `technique` / `cve` / `tool` / `similar-task`；`writeup` / `wp` / `题解` / `复现` 只允许 `similar-task`，且仍不得包含本题标识。
- 默认返回 `summary/snippet`；`include_content=true` 可为 technique/CVE/tool 返回每条最多 2000 字符正文，`similar-task` 不返回正文。
- 结果写 `runtime.note kind="web.search"`，在 Board 上是 `Artifact`，不是 `Fact`；模型必须在目标上复验。

示例查询（只用技法，不含题目/URL/WP）：

```text
PHP 7 disable_functions bypass create_function unserialize
PHP open_basedir bypass DirectoryIterator glob
Java deserialization gadget filter bypass ysoserial
CVE-2021-4034 pkexec local privilege escalation
Linux SUID readflag GTFOBins privilege escalation
```

---

## 4. 安全与信任边界

- 模型输出是提案；工具退出码、HTTP 200、transport 成功都不是结果。
- `Outcome` 只来自独立 Oracle 或明确的人类确认；`unknown` 不是 failure。
- 工作区**不是** OS sandbox；路径检查不是安全隔离。
- 脚本动作必须走已登记 registry：固定 executable/argv、pinned digest、独立 Oracle。
- 搜索/知识结果固定 `verified=false`、`action_policy=none`；不能写 Fact、授权或 active Experience。
- active Experience 需要 ≥2 个独立 resolved success + isolated replay；wiki 和写读本不能绕过。
- 凭据只读引用，不打印、不提交；私有产物放 ignored `runtime/` 或 `~/.Aegis/`。
- 真实网络/付费搜索/真实目标实验需要当前授权；不要用历史文档代替授权。

---

## 5. 给 LLM 的知识准备提示词

把下面整段交给一个编码 Agent（替换 `<AEGIS_REPO>` 和 `<CARD_LIST>`）。它只做本地知识准备，不接触真实目标、不写 flag、不提交知识内容。

```text
你在仓库 <AEGIS_REPO> 中工作。先读 AGENTS.md、docs/DEVELOPMENT_RULES.md、
Pi_Agent_base/AGENTS.md、docs/KNOWLEDGE_RUNTIME.md 和
docs/TECHNIQUE_CARD_SCHEMA.md，并遵守现有规范；不要新建另一套 schema/契约。

目标：把知识准备到 $AEGIS_HOME/knowledge（默认 ~/.Aegis/knowledge），
不要创建或使用 <AEGIS_REPO>/knowledge，也不要把知识内容加入 Git。

环境：
- AEGIS_HOME=~/.Aegis
- AEGIS_REPO=<AEGIS_REPO>
- 知识根=~/.Aegis/knowledge
- 不读取 ~/.pi，不打印任何 key/token/flag/私有会话。

任务：
1. 检查 ~/.Aegis/knowledge/ctf-wiki 和 techniques/seeds 是否存在；
   如果缺失，先报告，不要静默回落到仓库。
2. 如需要编译 wiki，显式运行（需要网络）：
   node build-ctf-wiki-memory.mjs
   或
   node build-ctf-wiki-seeds.mjs --github-repo https://github.com/ctf-wiki/ctf-wiki.git \
     --github-ref <sha> --github-output ~/.Aegis/knowledge/ctf-wiki
   产物必须是 document-seed-1，verified=false，action_policy=none。
3. 从下面的 CARD_LIST 增补技法卡：
   - 只改 ~/.Aegis/knowledge/techniques/build_cards.py 的 CARDS/CVE_CARDS；
   - 字段沿用现有 schema：id/title/category/when/sources/when_text/steps/expect/pitfalls，
     可选 source_kind；
   - 每张卡必须有可观察的 when、可执行 steps、可观察 expect、失效 limits；
   - 不要写 flag、题目答案、私有目标或完整 exploit 成品；
   - 运行：
     AEGIS_REPO=<AEGIS_REPO> python3 ~/.Aegis/knowledge/techniques/build_cards.py
   - 检查 cards.json、seeds/、INVENTORY.md 数量与 schema。
4. 按 docs/KNOWLEDGE_RUNTIME.md 制作 CVE 文档 seed：
   - 在 ~/.Aegis/knowledge/documents 写 Markdown，固定分节
     Affected / Fingerprint / Preconditions / Primitive / Adapt / Verify / Limits / References；
   - 用 node compile-document-seed.mjs --input ... --output ... 编译；
   - 不写 flag/凭据/未授权目标。
5. 校验：
   - node Pi_Agent_base/tests/aegis-knowledge.mjs
   - node Pi_Agent_base/tests/aegis-web-search.mjs
   - node Pi_Agent_base/tests/aegis-ctf-wiki-candidates.mjs
   - node Pi_Agent_base/tests/aegis-ctf-wiki-memory.mjs
   - 如改了启动器/知识根，再跑 aegis-run-experiment。
6. 输出报告：实际命令、退出码、新增/修改的本地文件、卡片/seed 数量、
   未运行项、剩余限制。不要声称真实任务成功率或 active Experience。

CARD_LIST：
<在这里粘贴要新增的 CVE/技法卡或 CVE 清单；没有就只做校验和报告>
```

---

## 6. 当前限制

- 知识卡是 hint，不是已证明的方法；CVE 文档只是参考。
- 真实任务面没有 Campaign 级请求/工具账本和独立 Oracle；受控执行面没有通用 shell/grep/多文件编辑。
- 没有本地可重置靶场时，真实工具面的经验通常只能停在 candidate（缺少 `isolation_ref`）。
- 真实模型效果、四组对照和学习收益尚未建立；见 [整体计划](docs/AEGIS_COMPLETION_MASTER_PLAN.md) 和 [测试矩阵](docs/CAMPAIGN_TEST_MATRIX.md)。
- 搜索是付费网络能力；默认只返回摘要/有界正文，不抓任意 URL，不执行页面内容。

---

## 7. 文档入口

- [根开发入口](AGENTS.md)
- [固定开发规则](docs/DEVELOPMENT_RULES.md)
- [工程入口](Pi_Agent_base/README.md)
- [知识库运行接口](docs/KNOWLEDGE_RUNTIME.md)
- [技法卡 schema](docs/TECHNIQUE_CARD_SCHEMA.md)
- [CTF Wiki pipeline](docs/CTF_WIKI_SEED_PIPELINE.md)
- [CTF Wiki 经验编译边界](docs/CTF_WIKI_EXPERIENCE_COMPILATION.md)
- [Campaign 架构](docs/CAMPAIGN_ARCHITECTURE.md)
- [Memory schema](docs/MEMORY_SCHEMA.md)
- [入口能力清单](docs/AEGIS_ENTRY_CAPABILITIES.md)
- [Campaign 测试矩阵](docs/CAMPAIGN_TEST_MATRIX.md)
- [工具注册规范](docs/TOOL_REGISTRATION.md)
- [工具能力目录](docs/TOOL_CATALOG.md)
