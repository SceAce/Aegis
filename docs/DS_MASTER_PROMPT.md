# Aegis 阶段入口：E1 真实任务 pilot 规划

最新基线（2026-10-14）：`feat/c6-agent-product` / `32b0e96`。
C1-C5保持既有验收范围；C6三个事实分离已核验，同一SDK收尾盲区已补修。
18个C6脚本、26个回归通过；类型196条历史诊断保持，修改文件无诊断。
通过的是有限真实任务pilot工程门槛，尚未启动真实provider。

当前规划：[E1_REAL_TASK_PILOT_PLAN.md](E1_REAL_TASK_PILOT_PLAN.md)。
工程证据：[C6_EXTERNAL_REVIEW.md](C6_EXTERNAL_REVIEW.md) 第8节。
运行入口：[C6_AGENT_PRODUCT_RUNBOOK.md](C6_AGENT_PRODUCT_RUNBOOK.md)。
后续实验：[AEGIS_PRODUCT_ROADMAP.md](AEGIS_PRODUCT_ROADMAP.md) 的E1/E2/E3。

下一步选定任务场景、provider/model/endpoint、任务副本、Oracle和总预算，准备可审查运行包。
local-openai可尝试本地服务；远程provider尚未接线，按用户选择做最小实现。
小任务直接处理；较大接线工程可编写有界任务交dsv4.1flash，不自动扩大为新平台。
具体真实运行需要既定用户授权与费用范围，规划不代替运行授权。

先取得无经验真实任务基线，再做经验和短上下文对照。保留失败/unknown，复用既有
Host/Broker/Oracle/ledger/测量，不重派已闭合的C6修复、不追旧warning。
本地提交遵守Git规范，不改Pi核心/用户真实配置/lockfile，不push/rewrite。
