# 图板与 seed：公开 CTF 真实先导结果

状态：已下载原题并实际调用模型；先导因 provider 错误中断，四组效果比较不成立。未宣称准确率提升或节时收益。

## 任务与实际授权

用户要求在 `~/Tmp` 按题建目录，自行寻找适当公开 CTF 题并测试。实际数据根目录：`/Users/scemac/Tmp/aegis-board-seed-pilot-20261017/`。附件、答案、会话、运行日志和私有报告均留该目录，不纳入仓库。代码检查基线 `3c830ee`，内嵌 Pi 保持原状，模型与凭据配置仅通过 SDK 只读使用。

公开来源（commit 固定在本地 provenance.json）：

- [DUCTF 2023 apbq-rsa-i](https://github.com/DownUnderCTF/Challenges_2023_Public/tree/b48f83db2984bc7fa2ec7879a32d7efb1be8d333/crypto/apbq-rsa-i)：easy，用于基础校准。
- [DUCTF 2023 apbq-rsa-ii](https://github.com/DownUnderCTF/Challenges_2023_Public/tree/b48f83db2984bc7fa2ec7879a32d7efb1be8d333/crypto/apbq-rsa-ii)：medium，线性关系与格/数论推导。
- [DUCTF 2024 three-line-crypto](https://github.com/DownUnderCTF/Challenges_2024_Public/tree/f2797a33d8f5851508f37e854afceedf85eee8a3/crypto/three-line-crypto)：medium，反馈异或和英语约束。

每题包含 handout/evaluation/runs。模型只能通过受限 Python CLI 读取自己 attempt workspace 的附件和产物。没有给题解；事后为诊断预算下载的参考解法留在 evaluation。原题未变体处理，模型可能记忆公开题解，不能作未见题泛化结论。

## 实验接线

新增 `AEGIS_BOARD_FEEDBACK=on|off` 和 `AEGIS_KNOWLEDGE_ENABLED=on|off`，缺省均为 on。上下文干预通过 `memory/context-policy.mjs`，Observer 仍收集并持久化完整事件。

关闭 board feedback 只移除当前请求 RAM 的 Fact/Refuted/工具观察/提案/Artifact/经验选择反馈，任务、授权、预算与未决行动保留。关闭 knowledge 同时关闭自动召回、显式 seed 与 `aegis_knowledge` 数据读取。当前实验保持相同工具声明，提示词会告知功能可用性，所以不是纯提示词完全相同的实验；该差异保留可核对。

每次实际 provider 边界验证 RAM 无交叉污染，并记录 context policy、RAM、输入字符数及 digest。四种模式的真实 SDK/faux 验证通过。该开关是实验干预，不是关闭审计、权限或结果边界。

实际真实模型通过 `fixtures/ctf-board-pilot.mjs`，同一 Observer + Pi SDK。使用 maxapi/deepseek-v4.1-flash、high thinking、每请求输出上限 4096、单长 Session、不轮换；medium 每次最多 14 请求/30 工具/180 秒。CLI 为 Python 3 标准库，每次 20 秒，不安装依赖。独立 Python 子进程不继承模型凭据，audit guard 限文件和网络/子进程；不是 OS sandbox。系统 sandbox-exec 在本环境不可用，未以之冒充隔离。

## 实际结果

A=board off/seed off，B=board on/seed off，C=board off/seed on，D=board on/seed on。

| 题目 | 模式 | 结果 | 耗时 | 请求/工具 |
| --- | --- | --- | ---: | ---: |
| RSA i 校准 | A | 私有答案精确比对 success | 67.9 秒 | 6 / 7 |
| RSA ii | A | output_limit；未产生正确候选 | 28.1 秒 | 2 / 1 |
| 三行密码 | D | time_limit；未产生正确候选 | 180.1 秒 | 13 / 14 |
| RSA ii | B/C/D | provider_error，首次请求失败 | 各 3～5 秒 | 各 1 / 0 |
| 三行密码 | A/B/C | provider_error，首次请求失败 | 各 3～4 秒 | 各 1 / 0 |

共 9 个 attempt、27 次请求尝试、22 次工具调用。6 次中转拒绝均为上游 HTTP 403/code 11140/request illegal，账号相关文字被截断，具体账号原因未知。没有改用其他中转、自动重试或删掉失败。完成首轮拒绝记录后停止真实推理；未继续 24 次重复样本。

进程退出码 0 表示结果记录完成，不等于 task success；报表按 success/provider_error/output_limit/time_limit 分类。provider 失败的 SDK 零 usage 不作为实际零费用证明，报表记 unknown。总运行时间不能替代平台账单。

四组缺少配对样本，所以不能报告图板/seed 提升率、节时百分比或结论性成功率。调用失败不能算模型不会解题；输出上限与时间上限保留为该运行预算的结果。

## 直接观察到的机制问题

三行密码 D 组：

1. 有 1 条真实模型提案，从第三个请求持续出现在 RAM 中；所有 9 次事件链核对通过。节点存在与回灌成立，不代表推理有效。
2. 提案开头使用错误的 q[i%16]，同一条随后又写正确的 q[p_(i-1)%16]，保留了矛盾表达。模型后续正文/计算中使用正确关系，但没有显式替换该图板 Claim。该记录没有升级 Fact。
3. 首消息自动召回受 Python/CLI 工作流词影响，误选 Python 沙盒资料。模型随后自主查询 self-referential XOR cipher，返回 ARX/Simon-Speck，不适用于题目。模型主动调用检索已验证，正确 seed 选择未验证。
4. seed 只在首个请求 RAM 可见，后续被 4000 字符预算省略。知识工具返回内容仍正常进入当前会话 tool-result，不能把 RAM 未展示说成工具结果丢失。
5. 12 次 CLI 中有一次代码错误和三次调用超时；模型使用 DFS/beam/局部搜索，未得到验收候选。仅一条未经修订提案，尚无多分支图搜索效果证据。

事后读主办方解法发现三行密码参考方案曾需 10～20 分钟，且 RSA ii 参考实现依赖 Sage LLL。本次 stdlib/180 秒配置限制明显；选题虽是 medium，尚不适合据此做最终预算下的效果结论。后续应先校准工具与计算预算，不在已有运行中途加条件后合并统计。

## 交付与复跑

本地总报告：`~/Tmp/aegis-board-seed-pilot-20261017/RESULTS.zh-CN.md`，机器报告为 `report.json`，逐题有 `provenance.json`、`evaluation/consistency.json`、runs 下的结果/原始记录。知识文件 manifest 与全部 seed 摘要存 `knowledge-snapshot.json`。两题 RSA 的预期答案重新加密等于 c；三行原文逐字节符合给定密文，全部一致性检查通过。

只读重新生成报告：

```sh
node Pi_Agent_base/fixtures/ctf-board-report.mjs ~/Tmp/aegis-board-seed-pilot-20261017
```

`rerun-matrix.py` 默认 dry-run，不发模型请求。显式 execute 后遇第一个 provider/harness 错误停止，已有证据和目录不会覆盖。provider 尚未证明恢复，本轮未调用复跑。

## 工程验证

```sh
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs Pi_Agent_base/runtime/dev/ctf-board-pilot/verified aegis-context-policy aegis-context-policy-sdk aegis-ctf-pilot-cli aegis-knowledge aegis-knowledge-sdk aegis-knowledge-campaign aegis-ram-projection aegis-ram-cache-payload aegis-ram-reaudit-sdk aegis-ram-abc-sdk aegis-work-control-campaign aegis-module-layout
```

12 脚本退出码全部 0，覆盖独立开关、实际 provider payload、禁用 seed 读回、CLI 范围和超时、答案比对、既有知识和图板/RAM 回归。初次 suite 中 CLI 测试因静态 SDK import 缺 resolver 失败；改为只有显式真实运行时才动态加载 SDK 后，用纯 Node 测试通过，未删断言。代码使用 aegis-biome.json。两份类型配置均退出 1，诊断分别 186/189，与已有基线一致，无全仓类型通过声明。

测试与真实效果分别记录。下一步需要 provider 恢复，并先解决召回相关性/Claim 修订和合适的工具预算，才能完成有效对照。
