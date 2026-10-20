# 知识库入口与图板接线实现记录

状态：内部验证通过，尚无真实模型效果实验或独立验收结论。

## 范围与基线

本次开始读取到的主仓库 HEAD 为 `a91012cdf24badcb7f5c128b504959904bf7e9c5`，分支为 `feat/structured-ram-and-exploration-control`，起点无用户未提交改动。内嵌 Pi HEAD `42a3497d03ad17e308a2299fa824727894f2c0ec`，本次未修改其源码或私有配置。

用户要求知识库集中到 `knowledge/` 便于复制迁移，并明确知识内容保持 Git 忽略。本次把本地 GitHub 编译的 771 个 seed 从 `knowledge/ctf-wiki-github/` 移到 `knowledge/ctf-wiki/`；旧站点抓取的 352 个 seed 保留在 `knowledge/ctf-wiki-crawl/`，检索排除。根目录 SQL 示例被移除，SQL 注入由 `ctf-wiki/web/` 提供。整个 `knowledge/` 忽略，未将知识内容纳入提交或远程。

实际调用契约与时机见 [KNOWLEDGE_RUNTIME.md](KNOWLEDGE_RUNTIME.md)。实现复用既有 Observer/Board/RuntimeState/RAM，增加消息级机械召回与当前 LLM 的 `aegis_knowledge` 选择工具。知识选择持久化后投影到下一请求；Board 保存 Artifact 来源，模型候选 `when/do/expect` 保留到 RAM，合法 source refs 形成图边。C6 工具白名单、动作门与原持久计费/结清接口均已接线。

本次没有新增后台模型或修改模型配置，没有把 seed 升级成 active Experience，没有改变 Oracle/授权边界，没有另建图数据库。交互入口实际换 Session 继续由已有 `/aegis switch` 或显式 Host helper 完成；C6 继续由现有 Host 自动轮换，不宣称所有 Pi 入口都新增了自动换会话。

## 验证

所有命令从仓库根执行。离线测试使用临时目录、真实 Pi SDK 与 faux provider，不读取用户凭据、不调用真实模型或目标。

```sh
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs Pi_Agent_base/runtime/dev/knowledge-integration/verified aegis-knowledge aegis-knowledge-sdk aegis-knowledge-campaign aegis-runtime-core-smoke aegis-runtime-effective-board aegis-ram-seed aegis-ram-projection aegis-ram-abc aegis-ram-abc-sdk aegis-ram-reaudit-sdk aegis-ram-cache-payload aegis-observer-contest-pi aegis-observer-runtime-handoff aegis-ctf-wiki-seeds aegis-document-seed aegis-ram-launcher aegis-work-control-campaign aegis-c6-provider aegis-c6-sdk-lifecycle aegis-c3-campaign-mode-gate aegis-module-layout
```

结果：21 个脚本退出码全部 0，runner 退出码 0。日志保存在 ignored `Pi_Agent_base/runtime/dev/knowledge-integration/verified/`。

新增测试验证首请求自动召回、当前 LLM 查询重选、下一请求 RAM、同 Episode 新 Session 恢复、候选结构/图边、空选择替换、非可信来源拒绝、文件更新不使用旧索引，以及真实 C6 产品入口的 `c6.tool phase=charged/finished` 配对与后续 Broker 效果。旧 seed 测试改为本地编译 fixture，移除对私有 runtime 产物的依赖。

过程中发现并修复两个回归：新增空节导致 1,200 字符 RAM 核心超预算；知识引用抢占已有观察导致真实短会话交接丢失读文件细节。最终策略为空知识不增加节，近期工具观察先于可选知识，选择 Artifact 不在 RAM 重复展示。未放宽原断言。

代码使用 `aegis-biome.json` 检查本次 12 个 JavaScript/TypeScript 路径，退出码 0。`bash -n run-ram-test.sh`、`git diff --check`、模块布局检查通过。文档链接按本次修改路径核对。

两份既有类型配置均退出 1：`tsconfig.aegis.json` 为 186 条诊断，`tsconfig.aegis-campaign.json` 为 189 条。用临时目录物化开始时 HEAD 的纳管源码，并链接同一内嵌 Pi 工具链，分别复跑得相同诊断数；按文件/错误内容归一化比较新增 0、移除 0。未缩减类型检查范围，也未宣称全仓类型检查通过。证据保存在同一 ignored 目录的 `baseline-*.log` 与 `tsc-*-final.log`。

另做只读本地 CTF Wiki 检索观察：771 个 seed 识别为 21,177 个段落/代码块，未拒绝文件；SQL 注入、堆溢出、SSRF 查询召回对应分类。这是检索行为观察，不是最优召回率或模型收益评测。

## 当前限制

自动入口先用当前用户消息做关键词候选排序，语义细化由任务 LLM 自主调用工具；不保证某个真实模型必定调用或选中最优段落。工具之后的新条件由模型再次查询，RAM 在每个 provider 请求刷新，不对每次工具结果额外启动后台 LLM。知识引用仍受 8,000 字符 RAM 总预算，遗漏公开。检索每次读取本地有界目录，尚无向量检索、语义重排质量实验或大规模性能结论。

知识复制迁移与任务恢复是两个范围：复制 `knowledge/` 可迁移本地知识；进行中任务的 EventLog/Board/RAM 需另行保留其 runtime 状态。
