# Aegis 阶段入口：C6 审查修复完成，待限定工程复验

C1-C5 保持既有范围交付。C6 经限定工程审查标 `changes_required`（新增 21 边界用例
2 pass/19 fail）。已按 `C6_REPAIR_DS_PROMPT.md` 完成 X1–X12 修复，当前为
**internally_verified / awaiting_external_review**（C6 限定复验）。
外部边界套件从 2/19（正常 red）恢复到 **21/21 pass, exit 0**；新增真实 child SIGKILL
恢复与学习闭合（真实隔离 Replay → Compiler active → 第三 Task direct 零规划）产品证据；
C6-owned 类型诊断 **0**；Biome 修改范围 **0 warning**。
验收材料：[C6_AGENT_PRODUCT_IMPLEMENTATION_REPORT.md](C6_AGENT_PRODUCT_IMPLEMENTATION_REPORT.md)
与 [C6_AGENT_PRODUCT_RUNBOOK.md](C6_AGENT_PRODUCT_RUNBOOK.md)。

原审查依据：[C6_EXTERNAL_REVIEW.md](C6_EXTERNAL_REVIEW.md)。
修复提示词：[C6_REPAIR_DS_PROMPT.md](C6_REPAIR_DS_PROMPT.md)。
原冻结总范围：[C6_AGENT_PRODUCT_TASK.md](C6_AGENT_PRODUCT_TASK.md)。
产品与实验划分：[AEGIS_PRODUCT_ROADMAP.md](AEGIS_PRODUCT_ROADMAP.md)。

active/replay/direct/habit 经验工程链、provider 配置接口、runner attempt 隔离、常驻 observe
与错误清理已在本轮实现并有离线产品证据，未移交 E2。收益/真实模型 pilot/迁移与日常试用另立任务。
SHA256/UUID 控制在本次复核正常，撤回旧“无证据 crypto 全零”归因。
不改 Pi 核心/真实凭据与模型设置/lockfile、不 push/rewrite、不调用真实 provider/外部目标/验收模型。
