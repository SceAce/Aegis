# 本地知识库与图板入口

知识文件、编译 seed 与索引统一保存在仓库根的 `knowledge/`。整个目录由 Git 忽略，迁移时单独复制；代码和本文纳管，知识内容不推送远程。运行日志、当前任务图板与 RAM 快照仍由 `Pi_Agent_base/runtime/` 管理，它们属于任务状态。

## 本地目录

- `knowledge/ctf-wiki/`：默认使用的 GitHub Markdown 编译产物，按 `web/`、`pwn/`、`crypto/`、`reverse/` 等分类，语言作为子目录。SQL 注入位于 `ctf-wiki/web/`。
- `knowledge/documents/`：`run-ram-test.sh --compile FILE.md` 编译的本地文档 seed。
- `knowledge/ctf-wiki-crawl/`：本次保留的旧站点抓取归档；检索明确排除，避免导航页与重复内容参与召回。

本次本地迁移将原 `ctf-wiki-github/` 改为 `ctf-wiki/`，原站点抓取移到 `ctf-wiki-crawl/`。移除了纳管的根 SQL 示例及 `--sql-wiki` / `--prepare-sql-wiki` 专用入口。主编译器默认输出原本就是 `knowledge/ctf-wiki/`，现在文档与实际数据一致。编译命令与来源边界见 [CTF Wiki pipeline](CTF_WIKI_SEED_PIPELINE.md)。

其他知识源可以在 `knowledge/` 下增加独立子目录。运行时识别 `document-seed-1` 的本地文档和外部参考 JSON；不把任意 JSON 当知识，不自动读取 Markdown 原文。`AEGIS_KNOWLEDGE_DIR` 可由操作者配置为迁移后的绝对根目录；模型只能提供查询和已返回的知识身份，不能提供文件路径或更改根目录。

## 调用时机

| 时机 | 实际行为与负责人 |
| --- | --- |
| 每次 `before_agent_start`，已创建/恢复当前 Episode 后 | Observer 对当前用户消息做一次机械候选召回，不调用额外模型；长消息先脱敏，再保留头尾共最多 800 字符查询 |
| 当前 LLM 判断需要具体技法、条件或不同子目标的知识 | 调用 `aegis_knowledge`，根据当前消息、工具观察和图板自主形成查询；也可提交上次返回的 `knowledge_ids` |
| 检索完成 | Observer 单写 `runtime.note kind=knowledge.selected`，记录模式、查询、实际片段、URI/digest/行号、缺失与限额状态；本次选择替换当前 Episode 的上次选择；已有选择时空结果清除旧选择，无旧选择且无命中时不写空 Artifact |
| 每次 `context_with_system`，包括同一 prompt 内的工具后续请求 | 从已提交 Board/RuntimeState 重建 RAM，选中的知识按预算进入 `sections.knowledge`；保留固定 system 前缀，RAM 不累积到 Session 历史 |
| 新假设、子目标、路线变化 | LLM 使用已有 `aegis_propose` 写 Claim/Intent/Candidate 及来源关联；候选的 `when/do/expect` 现在保留到 Board 和 RAM |
| 子目标/验证结束、路径切换或上下文临近预算 | LLM 可请求 `aegis_switch_session`；实际交接仍由现有 Host/`/aegis switch` 在安全边界执行，Session 不等于新 Episode |

自动召回是关键词候选排序，并不是另一个 LLM 在后台理解和决定。语义选择由当前任务 LLM 使用 `aegis_knowledge` 完成，因此没有另建模型服务、付费旁路或独立模型预算。注册工具的固定 guidelines 说明模型何时检索、何时把局部判断写上图板。模型是否实际调用仍由当前模型决定，faux 测试不证明真实模型的选择质量。

C6 默认 SDK 工具白名单包含 `aegis_knowledge`，其工具调用继续经过当前 Campaign/work gate。操作者自定义工具白名单或任务 `allowed_tools` 时需显式允许该工具。普通 Pi 的隔离启动仍沿用 `run-pi.sh`；本次不改变其 bundle 检查或配置位置。

## 数据与信任

图板继续使用六类节点。`knowledge.selected` 对应 Artifact，保存知识来源引用；提案来源形成图上的 `references` 边。知识选择事件由 Runtime 写入，模型提出查询不获得 Fact/Outcome/授权/active Experience 写权。伪造的 llm 来源 `knowledge.selected` 不进入知识状态或图板 Artifact。

检索只返回本地编译参考，固定 `verified=false`、`action_policy=none`。文本不能授予动作权限或替代当前环境证据；它与 active Experience 的 Compiler/Router/Skill 链路不同。本次没有让知识 seed 自动执行技法，也没有自动晋升 Experience。

检索每次重新读取有界目录，避免迁移/编辑后命中旧内存索引；目录文件 symlink 不参与扫描。上限为 4,096 个 JSON、每文件 1 MiB、总读取 64 MiB、目录深度 16。自动召回最多 3 段/3,000 内容字符，模型工具最多 4 段/6,000 内容字符；所有内容仍受 4,000 字符 RAM 总预算。事实、未决动作与近期工具观察优先，装不下的知识通过 `shown/omitted` 公开；工具返回可查看本次完整有界选择。来源正文先脱敏，段落内容和元信息有界。

知识选择会把本次引用片段记录到本地私有任务日志，这是重建 RAM 的依据；复制 `knowledge/` 迁移知识库不需要复制旧任务日志。要迁移进行中的任务，再单独迁移其日志和运行状态。

## 验证入口

从仓库根运行：

```sh
node Pi_Agent_base/tests/aegis-knowledge.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-knowledge-sdk.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-knowledge-campaign.mjs
```

前者覆盖编译 seed 过滤、中文/英文查询、来源、边界、文件更新、空选择及非可信来源拒绝。SDK 脚本使用真实 Pi SDK 与 faux provider，覆盖首请求召回、模型工具重选、下一请求 RAM、候选结构/图边与新 Session 恢复；Campaign 脚本经过真实 C6 产品入口，核对工具白名单、持久 charge/finish 和后续 Broker 执行。均不使用真实模型、网络目标或私有会话。内部测试不能证明真实任务成功率或召回最优性。
