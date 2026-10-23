# Aegis

Aegis 是一个**事件溯源（event-sourced）的受控 Agent 运行时**。它把
`Event → Episode → Outcome → Experience` 串成可审计、可恢复、可独立判定的链路：

- 模型输出始终是**提案**，不是 Fact、授权、预算或 Outcome；
- 观察、声明、行动、结果分开记录；
- 只有独立 Oracle 或明确的人类确认才能产生 `Outcome`；
- active Experience 需要 ≥2 个独立成功结果 + isolated replay，wiki/卡片不能绕过。

状态：核心机制层已实现，能力层和真实效果层仍在推进。测试基线见
[Campaign 测试矩阵](docs/CAMPAIGN_TEST_MATRIX.md)，各入口真实能力见
[入口能力清单](docs/AEGIS_ENTRY_CAPABILITIES.md)。

---

## 架构

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
真实 workspace / 目标 ── transport / 产物 / 证据
        │
        ▼
独立 Oracle ── success / failure / unknown / invalid
        │
        ▼
Board / RAM / Report / Learning
```

| 目录 | 职责 |
|---|---|
| `Pi_Agent_base/memory/` | Board、RAM、RuntimeState、证据、Experience、知识、提案 |
| `Pi_Agent_base/campaign/` | Manifest、配置、规划、队列、Scheduler/Host、账本、产品入口 |
| `Pi_Agent_base/execution/` | ActionContract、授权、Broker、脚本注册、artifact、web search |
| `Pi_Agent_base/verification/` | Host Oracle、Outcome 解析/聚合、注册测试、replay/live |
| `Pi_Agent_base/observation/` | 只读 HTTP、报告、TUI、观测 |
| `Pi_Agent_base/session/` | 交接、Session 监督 |
| `Pi_Agent_base/orchestration/` | 工作流、work-control、remote HTTP |
| `Pi_Agent_base/shared/` | EventLog、digest、通用契约/路径 |
| `Pi_Agent_base/extensions/` | Observer、Contest、Fixture 接线 |
| `Pi_Agent_base/agent/ROM.md` | Layer 0–5 固定指令 |
| `Pi_Agent_base/tests/` | 纯 Node / SDK+faux / 故障恢复 / 审计 |

两条能力面，证据不能互相代替：

| 入口 | 能力 | 缺少 |
|---|---|---|
| `run-aegis.sh` / `run-pi.sh` / `contest/run.sh` | Pi 原生工具 + Observer | Campaign 请求/工具账本、独立 Oracle |
| `run-experiment.sh` / `run-experiment-web.sh` | 常驻 Experiment Host：ownership、EventLog、Observer 门控、Session 轮换、行式 Console 或本地 Web UI | Campaign 调度/账本、独立 Oracle |
| `campaign/c6-entry.mjs` | 冻结 Manifest、Scheduler、Broker、账本、Oracle | 通用 shell/grep/多文件编辑 |

内嵌 `Pi_Agent_base/pi/` 是独立仓库，已冻结；规则见
[工程入口](Pi_Agent_base/AGENTS.md) 与 [Pi 规则](Pi_Agent_base/pi/AGENTS.md)。

---

## 快速开始

要求：macOS/Linux、Node.js、Git；可选 Docker/Colima、DeepSeek Key。

```bash
# 只检查环境（不联网，不写 ~/.Aegis 之外）
./install.sh

# 全新克隆：clone pi + npm install + build bundle + 离线冒烟
#（同时 clone Web UI 并从其 lockfile 安装浏览器依赖；--no-web 可跳过）
./install.sh --all

# 只补 Web UI 的前端依赖（Aegis-pocket，npm ci，不改 lockfile）
./install.sh --clone-ui --install-web-deps

# 源码 / bundle / 隔离实验
./Pi_Agent_base/run-aegis.sh --model <provider/model>
./Pi_Agent_base/run-pi.sh --model <provider/model>
./run-experiment.sh my-001 --here
./run-experiment.sh my-001 --workspace ./challenge --attach ./files

# 本地 Web 控制台（仅 loopback）：列表/新建/对话/五类面板/暂停/恢复/停止
./run-experiment-web.sh                 # http://127.0.0.1:7800

# 比赛入口（固定 allowlist，不自动开 web search）
./Pi_Agent_base/contest/run.sh --hint
```

默认状态根 `~/.Aegis/`，可用 `AEGIS_HOME` 覆盖。凭据放
`~/.Aegis/agent/`，不要提交。`run-experiment.sh` 默认共享凭据、MCP 关闭；
`--mcp` 只开非浏览器 server，`--mcp-all` 全开。

`run-experiment-web.sh` 只绑定 loopback，复用同一个 `AEGIS_PI_AGENT_DIR`；
每个活跃实验是一个独立 Host 子进程（唯一 EventLog writer），浏览器断开不结束任务。
接口、状态、错误码与安全边界见 [Web Console 契约](docs/WEBUI_CONSOLE.md)。

验证：

```bash
bash Pi_Agent_base/tests/helpers/run-required.sh
node Pi_Agent_base/tests/aegis-web-search.mjs
node Pi_Agent_base/tests/aegis-ram-overflow-boundary.mjs
node Pi_Agent_base/tests/observer-smoke.mjs
node Pi_Agent_base/tests/aegis-module-layout.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/aegis-webui.mjs
```

---

## 知识库（全部在 `~/.Aegis`）

**仓库没有 `knowledge/`。** 所有知识只在：

```text
$AEGIS_HOME/knowledge/                  # 默认 ~/.Aegis/knowledge
├── ctf-wiki/                           # document-seed-1
├── techniques/                         # 55 张技法卡（本地唯一副本，不入 Git）
│   ├── build_cards.py  cards/  cards.json  candidates.json
│   └── seeds/  INVENTORY.md
└── documents/                          # 本地 CVE/文档 seed
```

`AEGIS_KNOWLEDGE_DIR` 可覆盖根目录；缺失时检索返回 `unavailable`，不会回落到仓库。

### 编译 Wiki

```bash
node build-ctf-wiki-memory.mjs
# 或只编译 GitHub 仓库（commit pin，输出目录必须不存在）
node build-ctf-wiki-seeds.mjs \
  --github-repo https://github.com/ctf-wiki/ctf-wiki.git \
  --github-ref <commit-sha> --github-output ~/.Aegis/knowledge/ctf-wiki
```

产物固定 `verified=false`、`action_policy=none`；wiki 不能直接变成 active Experience。

### 制作技法卡

```bash
AEGIS_REPO=/path/to/Aegis python3 ~/.Aegis/knowledge/techniques/build_cards.py
```

只改 `build_cards.py` 的 `CARDS` / `CVE_CARDS`；字段用现有 schema：
`id/title/category/when/sources/source_kind?/when_text/steps/expect/pitfalls`。
脚本生成 `cards/`、`cards.json`、`candidates.json`、`seeds/`、`INVENTORY.md`。

### 制作 CVE 文档 seed

```bash
# 固定分节：Affected / Fingerprint / Preconditions / Primitive / Adapt / Verify / Limits / References
node compile-document-seed.mjs \
  --input ~/.Aegis/knowledge/documents/CVE-2021-4034.md \
  --output ~/.Aegis/knowledge/documents/CVE-2021-4034.seed.json
```

不要写 flag、凭据、私有目标或未授权会话。

### 技法搜索

`aegis_web_search` 用 DeepSeek Search 补本地知识缺口：

- 默认在 `run-aegis.sh` / `run-pi.sh` / `run-experiment.sh` 开启；`--no-web-search` 关闭。
- Key：`AEGIS_SEARCH_API_KEY` / `DEEPSEEK_API_KEY`，否则从 `$AEGIS_HOME/agent/{models,auth}.json`
  中 `api.deepseek.com` provider 读取（当前 `deedeepseek`）；不打印 key。
- `purpose`：`technique` / `cve` / `tool`。
- 当前 target host/domain/port、task id、本 Episode 已见 WP host/slug 自动 denylist；
  `AEGIS_SEARCH_DENY` / `--search-block` 是**本地阻断清单，不是查询内容**：这些词永远不会被发给搜索引擎。
  **任何 writeup / wp / 题解 / 复现查询一律拒绝**；标题/URL 像 write-up 的结果也会被丢弃。
  例：`--search-block "SCTF 2021 RCEME,sigeryang.net"` 只是本地阻断，不会把这些词发送给搜索引擎。
- 默认返回 `summary/snippet`；`include_content=true` 可为 technique/CVE/tool
  返回每条最多 2000 字符正文；所有 purpose 都不返回 write-up 内容。
- 结果写 `runtime.note kind="web.search"`，在 Board 上是 `Artifact`，不是 `Fact`。

---

## CVE 工具

工具目录是**文档**，不是授权。`aegis_toolbox` 读取
`~/.Aegis/tools/catalog.json`；presence 不等于允许调用。

一键安装（可选，按需）：

```bash
HOMEBREW_NO_AUTO_UPDATE=1 brew install exploitdb testssl trivy grype osv-scanner
npm install -g retire
~/Tools/PyVenv/CTF/bin/pip install cve-bin-tool
```

可选：`brew install --cask metasploit`（很大）、WhatWeb/WPScan（无当前 core 公式，
按上游 Ruby 项目安装）。当前本机 catalog 已有 55 条，CVE 10 条全部识别；
`nmap`、`nuclei`、`nikto`、`sqlmap` 也已在。

安装后重建本地目录：

```bash
node aegis-scan-tools.mjs          # ~/.Aegis/tools/ctf/tool-inventory.json
node aegis-seed-tool-catalog.mjs   # ~/.Aegis/tools/catalog.json
```

| 工具 | 用途 |
|---|---|
| `searchsploit` | Exploit-DB 本地搜索；先 `searchsploit -u` |
| `whatweb` | Web 指纹/版本，辅助 CVE 映射 |
| `nuclei` | 模板扫描；`-tags cve -severity critical,high` |
| `nmap` | 端口/服务版本；`--script vulners` 需数据源 key |
| `testssl.sh` | TLS/SSL 漏洞与配置 |
| `trivy` / `grype` | 镜像/文件系统/依赖 CVE |
| `osv-scanner` | lockfile/SBOM 的 OSV 漏洞 |
| `cve-bin-tool` | 二进制/固件组件 CVE |
| `retire` | JS 依赖已知漏洞 |
| `msfconsole` | Metasploit 模块；先 `check`，再 `run` |

CVE 改题流程：指纹 → 版本/advisory → 前置条件 → 原语 → 适配过滤 → 最小验证。
版本号本身不是可利用性。通用硬题规则：连续三次失败，先把失败路径/排除的假设写到图板
（`aegis_propose` claim/checkpoint），再换思路，不要在同一假设上重复。

---

## 安全边界

- 工作区**不是** OS sandbox；路径检查不是隔离。
- 工具退出码、HTTP 200、transport 成功都不是结果。
- 脚本动作必须走已登记 registry（固定 argv/digest/Oracle）。
- 搜索/知识/卡片固定 `verified=false`、`action_policy=none`，不能写 Fact、授权或 active Experience。
- 凭据只读引用，不打印、不提交；私有产物放 `~/.Aegis/` 或 ignored `runtime/`。
- 真实网络/付费搜索/真实目标实验需要当前授权；历史文档不能代替授权。

---

## 给 LLM 的知识准备提示词

把下面整段交给编码 Agent，替换 `<AEGIS_REPO>` 和 `<CARD_LIST>`：

```text
你在 <AEGIS_REPO> 中工作。先读 AGENTS.md、docs/DEVELOPMENT_RULES.md、
Pi_Agent_base/AGENTS.md、docs/KNOWLEDGE_RUNTIME.md、docs/TECHNIQUE_CARD_SCHEMA.md。
只使用现有契约，不新建 schema，不创建仓库 knowledge/，不提交知识内容。

目标：把知识准备到 $AEGIS_HOME/knowledge（默认 ~/.Aegis/knowledge）。
不读 ~/.pi，不打印 key/token/flag/私有会话。

任务：
1. 检查 ~/.Aegis/knowledge/{ctf-wiki,techniques/seeds,documents} 是否存在；
   缺失就报告，不要回落到仓库。
2. 需要时显式编译 wiki（网络）：
   node build-ctf-wiki-memory.mjs
   或 node build-ctf-wiki-seeds.mjs --github-repo ... --github-ref <sha> \
      --github-output ~/.Aegis/knowledge/ctf-wiki
3. 从 CARD_LIST 增补技法卡：只改
   ~/.Aegis/knowledge/techniques/build_cards.py 的 CARDS/CVE_CARDS；
   每张卡必须有可观察 when、可执行 steps、可观察 expect、失效 limits；
   不写 flag/答案/私有目标/完整 exploit。
   运行：AEGIS_REPO=<AEGIS_REPO> python3 ~/.Aegis/knowledge/techniques/build_cards.py
4. 制作 CVE 文档：在 ~/.Aegis/knowledge/documents 写固定分节的 Markdown，
   用 node compile-document-seed.mjs --input ... --output ... 编译。
5. 如已安装 CVE 工具，重建目录：node aegis-scan-tools.mjs && node aegis-seed-tool-catalog.mjs；
   未安装就报告缺失，不要编造 catalog 条目。
6. 校验：
   node Pi_Agent_base/tests/aegis-knowledge.mjs
   node Pi_Agent_base/tests/aegis-web-search.mjs
   node Pi_Agent_base/tests/aegis-ctf-wiki-candidates.mjs
   node Pi_Agent_base/tests/aegis-ctf-wiki-memory.mjs
   改了启动器/知识根再跑 aegis-run-experiment。
7. 输出实际命令、退出码、新增/修改的本地文件、卡片/seed 数量、未运行项。
   不要声称真实任务成功率或 active Experience。

CARD_LIST：
<粘贴 CVE/技法清单；没有就只做校验和报告>
```

---

## 文档与限制

- [开发入口](AGENTS.md) · [固定规则](docs/DEVELOPMENT_RULES.md) · [工程入口](Pi_Agent_base/README.md)
- [知识库运行时](docs/KNOWLEDGE_RUNTIME.md) · [卡片 schema](docs/TECHNIQUE_CARD_SCHEMA.md)
- [CTF Wiki pipeline](docs/CTF_WIKI_SEED_PIPELINE.md) · [经验编译边界](docs/CTF_WIKI_EXPERIENCE_COMPILATION.md)
- [Campaign 架构](docs/CAMPAIGN_ARCHITECTURE.md) · [Memory schema](docs/MEMORY_SCHEMA.md)
- [入口能力](docs/AEGIS_ENTRY_CAPABILITIES.md) · [测试矩阵](docs/CAMPAIGN_TEST_MATRIX.md)
- [工具注册](docs/TOOL_REGISTRATION.md) · [工具目录](docs/TOOL_CATALOG.md)

限制：卡片/CVE 文档是 hint，不是已证明方法；真实工具面没有 Campaign 账本/Oracle；
没有本地可重置靶场时经验通常只能停在 candidate；真实模型效果和四组对照尚未建立；
搜索是付费网络能力；`--search-block`/`AEGIS_SEARCH_DENY` 是本地阻断清单，不会作为查询发送；开题时建议显式设置挑战名/WP 域名。
