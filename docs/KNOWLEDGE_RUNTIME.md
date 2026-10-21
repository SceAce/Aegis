# 本地知识库与图板入口

知识文件、编译 seed 与索引统一保存在 **`$AEGIS_HOME/knowledge/`**（默认 `~/.Aegis/knowledge/`）。该目录不在仓库内、由 Git 忽略，迁移时单独复制；代码和本文纳管，知识内容不推送远程。

**仓库根不再有 `knowledge/` 目录**（2026-10-21 移除）。技法卡、wiki seed、本地文档 seed 与所有索引都只存在于 `$AEGIS_HOME/knowledge/`。这样任何旧 checkout、相对路径或脚本都不会误把仓库内容当成运行时知识源。代码里的默认根也改为 Aegis home；不存在“先尝试仓库、失败再回落”的逻辑。若目录缺失，检索返回 `unavailable`，不会静默读取仓库。

全新 checkout 不包含知识内容；`install.sh` 只创建空的 `$AEGIS_HOME/knowledge/`，wiki seed、技法卡和本地文档需要操作者从备份/编译管线放入该目录。`run-aegis.sh` / `run-pi.sh` / `run-experiment.sh` 在 `AEGIS_KNOWLEDGE_DIR` 未设置时一律导出 `$AEGIS_HOME/knowledge`；`AEGIS_KNOWLEDGE_DIR` 显式设置时始终优先。`run-experiment.sh` 的默认根缺失时会创建一个空目录并给出提示；显式 `--knowledge` 路径缺失仍然拒绝启动。运行日志、当前任务图板与 RAM 快照仍由 `Pi_Agent_base/runtime/` 管理，它们属于任务状态。

## 本地目录

- `~/.Aegis/knowledge/ctf-wiki/`：默认使用的 GitHub Markdown 编译产物（772 个 seed），按 `web/`、`pwn/`、`crypto/`、`reverse/` 等分类，语言作为子目录。SQL 注入位于 `ctf-wiki/web/`。
- `~/.Aegis/knowledge/techniques/`：55 张人工技法卡（原 47 张 + 8 张 CVE/技法卡）及其 `seeds/`、`cards.json`、`build_cards.py`。2026-10-21 从仓库迁入；这是本地唯一副本，不再纳入 Git。
- `~/.Aegis/knowledge/documents/`：`run-ram-test.sh --compile FILE.md` 编译的本地文档 seed。
- 旧的站点抓取归档 `ctf-wiki-crawl` 已在本地删除；检索仍保留对该目录名的排除，以防将来误复制回来。

本次本地迁移将原 `ctf-wiki-github/` 改为 `ctf-wiki/`；2026-10-21 又把仓库里的 `knowledge/techniques/` 复制到 `$AEGIS_HOME/knowledge/techniques/` 并删除了整个仓库 `knowledge/`。主编译器默认输出是 `$AEGIS_HOME/knowledge/ctf-wiki/`。编译命令与来源边界见 [CTF Wiki pipeline](CTF_WIKI_SEED_PIPELINE.md)。

其他知识源可以在 `$AEGIS_HOME/knowledge/` 下增加独立子目录。运行时识别 `document-seed-1` 的本地文档和外部参考 JSON；不把任意 JSON 当知识，不自动读取 Markdown 原文。`AEGIS_KNOWLEDGE_DIR` 可由操作者配置为迁移后的绝对根目录；模型只能提供查询和已返回的知识身份，不能提供文件路径或更改根目录。

## 调用时机

| 时机 | 实际行为与负责人 |
| --- | --- |
| 每次 `before_agent_start`，已创建/恢复当前 Episode 后 | Observer 对当前用户消息做一次机械候选召回，只注入**一张相关性最高**的卡，不调用额外模型；长消息先脱敏，再保留头尾共最多 800 字符查询 |
| 当前 LLM 判断需要具体技法、条件或不同子目标的知识 | 调用 `aegis_knowledge`，根据当前消息、工具观察和图板自主形成查询；也可提交上次返回的 `knowledge_ids` |
| 检索完成 | Observer 单写 `runtime.note kind=knowledge.selected`，记录模式、查询、实际片段、URI/digest/行号、缺失与限额状态；本次选择替换当前 Episode 的上次选择；已有选择时空结果清除旧选择，无旧选择且无命中时不写空 Artifact |
| 每次 `context_with_system`，包括同一 prompt 内的工具后续请求 | 从已提交 Board/RuntimeState 重建 RAM，选中的知识按预算进入 RAM `references` 寄存器；保留固定 system 前缀，RAM 不累积到 Session 历史 |
| 新假设、子目标、路线变化 | LLM 使用已有 `aegis_propose` 写 Claim/Intent/Candidate 及来源关联；候选的 `when/do/expect` 现在保留到 Board 和 RAM |
| 子目标/验证结束、路径切换或上下文临近预算 | LLM 可请求 `aegis_switch_session`；实际交接仍由现有 Host/`/aegis switch` 在安全边界执行，Session 不等于新 Episode |

自动召回是关键词候选排序，并不是另一个 LLM 在后台理解和决定。语义选择由当前任务 LLM 使用 `aegis_knowledge` 完成，因此没有另建模型服务、付费旁路或独立模型预算。注册工具的固定 guidelines 说明模型何时检索、何时把局部判断写上图板。模型是否实际调用仍由当前模型决定，faux 测试不证明真实模型的选择质量。

C6 默认 SDK 工具白名单包含 `aegis_knowledge`，其工具调用继续经过当前 Campaign/work gate。操作者自定义工具白名单或任务 `allowed_tools` 时需显式允许该工具。普通 Pi 的隔离启动仍沿用 `run-pi.sh`；本次不改变其 bundle 检查或配置位置。

## 技术参考搜索（知识缺口回退）

本地语料不可能覆盖所有技法。`aegis_web_search` 提供一个**受控的技法级检索回退**，调用 DeepSeek Search API（`POST https://api.deepseek.com/v1/tools/search`），不是任务 Oracle，也不是本题 WP 查询器。

- 配置：`AEGIS_WEB_SEARCH=on|off`（`run-aegis.sh` / `run-pi.sh` / `run-experiment.sh` 默认 on；独立进程默认 off）；`AEGIS_SEARCH_COUNT`（1–10，默认 5）；`AEGIS_SEARCH_MAX_CALLS`（每 Episode，默认 8）；`AEGIS_SEARCH_TIMEOUT_MS`；`AEGIS_SEARCH_DENY`（逗号分隔的本题/挑战名/域名，人工补充）。
- Key：优先 `AEGIS_SEARCH_API_KEY` / `DEEPSEEK_API_KEY`；否则从默认 agent 配置读取 `api.deepseek.com` provider 的 key（`$AEGIS_HOME/agent/{models,auth}.json`，默认 `deedeepseek`）。不读取 `~/.pi`，不打印 key。
- 策略：`purpose` 只能是 `technique` / `cve` / `tool`；当前 target 的 host、注册域、port、task id，以及本次 Episode 已提交命令/提案里出现的 WP host/slug 自动加入 denylist；查询命中即拒绝，结果命中即丢弃。**任何 `writeup` / `wp` / `题解` / `复现` 查询一律拒绝**；标题/URL 像 write-up 的结果即使通过关键词也会被丢弃。`--search-block` / `AEGIS_SEARCH_DENY` 是本地阻断清单，不是查询内容，永远不会被发给搜索引擎。默认只取 `summary/snippet`；`include_content=true` 可为 technique/CVE/tool 请求每条最多 2000 字符的有界正文。不按任意 URL 抓取页面，不执行页面内容。
- 审计：每次调用（包括拒绝、未配置、HTTP 错误）写 `runtime.note kind="web.search"`，含 status、query、purpose、返回/过滤数量、结果 URL/摘要、预算和 `key_source`（不含 key）。成功结果在 Board 上是 `Artifact`，不是 `Fact`；`verified=false`、`action_policy=none`。模型必须在真实目标上复验。
- 计费/失败：Search 按成功请求计费；401/402/403/404/408/429/5xx 明确返回，不自动重试。预算按 Episode 统计 `attempted=true` 的记录。

## 数据与信任

图板继续使用六类节点。`knowledge.selected` 对应 Artifact，保存知识来源引用；提案来源形成图上的 `references` 边。知识选择事件由 Runtime 写入，模型提出查询不获得 Fact/Outcome/授权/active Experience 写权。伪造的 llm 来源 `knowledge.selected` 不进入知识状态或图板 Artifact。

检索只返回本地编译参考，固定 `verified=false`、`action_policy=none`。文本不能授予动作权限或替代当前环境证据；它与 active Experience 的 Compiler/Router/Skill 链路不同。本次没有让知识 seed 自动执行技法，也没有自动晋升 Experience。

检索每次重新读取有界目录，避免迁移/编辑后命中旧内存索引；目录文件 symlink 不参与扫描。上限为 4,096 个 JSON、每文件 1 MiB、总读取 64 MiB、目录深度 16。自动召回最多选择 3 张相关卡（总计最多 6,000 内容字符）；模型工具默认返回 3 张卡，需要时最多 4 段/6,000 内容字符；RAM `references` 最多保留当前 4 张，所有内容仍受 8,000 字符 RAM 总预算。事实、未决动作与近期工具观察优先，装不下的知识通过 `shown/omitted` 公开；工具返回可查看本次完整有界选择。来源正文先脱敏，段落内容和元信息有界。

知识选择会把本次引用片段记录到本地私有任务日志，这是重建 RAM 的依据；复制 `$AEGIS_HOME/knowledge/` 迁移知识库不需要复制旧任务日志。要迁移进行中的任务，再单独迁移其日志和运行状态。

## 验证入口

从仓库根运行：

```sh
node Pi_Agent_base/tests/aegis-knowledge.mjs
node Pi_Agent_base/tests/aegis-web-search.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-knowledge-sdk.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-knowledge-campaign.mjs
```

前者覆盖编译 seed 过滤、中文/英文查询、来源、边界、文件更新、空选择及非可信来源拒绝。SDK 脚本使用真实 Pi SDK 与 faux provider，覆盖首请求召回、模型工具重选、下一请求 RAM、候选结构/图边与新 Session 恢复；Campaign 脚本经过真实 C6 产品入口，核对工具白名单、持久 charge/finish 和后续 Broker 执行。均不使用真实模型、网络目标或私有会话。内部测试不能证明真实任务成功率或召回最优性。
