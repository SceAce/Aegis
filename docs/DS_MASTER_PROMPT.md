# Aegis 阶段入口：E1 可观察白板与LLM任务规划

已验证的真实code产品基线（2026-10-14）：`feat/c6-agent-product` / `ac3220c`。
C1-C5保持既有验收范围；C6三个事实分离已核验，同一SDK收尾盲区已补修。
18个C6脚本、26个回归通过；类型196条历史诊断保持，修改文件无诊断。
有限真实任务pilot工程门槛已通过；用户已执行首个真实数据任务和代表性代码任务。

当前规划：[E1_REAL_TASK_PILOT_PLAN.md](E1_REAL_TASK_PILOT_PLAN.md)。
执行补充：用户已选max中转站dsv4.1flash，并要求直接复用Pi已有模型与鉴权；
`pi-config`按明确目录复用Pi ModelRuntime和只读凭据，操作者入口已准备，
由用户亲自执行，见[E1_MAX_OPERATOR_STEPS.md](E1_MAX_OPERATOR_STEPS.md)。
用户已完成首次真实smoke：3次请求，Oracle success，完成后的独立status无pending/unresolved。
该次暴露aegis_read门禁接线遗漏，已小修并补模型收到实际内容的断言；8个相关脚本通过。
修复后用户执行code：3次请求，模型读到原始源码，Broker写入一份修复，冻结Oracle
success，Task completed，独立status无pending/unresolved。独立核验初态/测试身份、
40条事件链和真实产物，并通过现有Host验收器复跑。两项合计6次真实请求，详见操作步骤第7节。
工程证据：[C6_EXTERNAL_REVIEW.md](C6_EXTERNAL_REVIEW.md) 第8节。
运行入口：[C6_AGENT_PRODUCT_RUNBOOK.md](C6_AGENT_PRODUCT_RUNBOOK.md)。
后续实验：[AEGIS_PRODUCT_ROADMAP.md](AEGIS_PRODUCT_ROADMAP.md) 的E1/E2/E3。

当前编码委派已冻结：[E1_OBSERVABLE_PLANNING_TASK.md](E1_OBSERVABLE_PLANNING_TASK.md)、
[测试矩阵](E1_OBSERVABLE_PLANNING_TEST_MATRIX.md)及
[DS总提示词](E1_OBSERVABLE_PLANNING_DS_PROMPT.md)。检查起点`4e1823c`。
本轮已实现并提交：白板六类节点内容/证据、父子树与执行依赖 DAG、结构化 `aegis_submit_plan`
规划工具、Host 整图校验与一次 durable 批量准入、`campaign.plan.ready` 独立计划完成门、
Scheduler 按需要真实 depends_on 执行与重启重建。18 个 C6 脚本、26 个回归、8 个附加受影响、
4 个 E1 focused 全部 exit 0；类型 196→196、修改文件 0；Biome exit 0；有限 mutation 5/5 被捕获。
结果见[实现报告](E1_OBSERVABLE_PLANNING_IMPLEMENTATION_REPORT.md)。真实付费请求仍由用户
之后执行，本轮未运行真实 provider/CTF。
本轮允许这条链必要的加法契约与规划模式，不重开已有 C6 生命周期，不扩展通用 shell/
CTF 攻击平台。完成后交回限定复验，再选题和工具适配；不把 faux 称真实解题通过。

随后选择用户项目任务或具体CTF及其副本、Oracle和总预算，再准备新的运行包。
local-openai、remote-openai及pi-config均有SDK接线；max首次数据/代表性单文件代码任务已通过。
此结果支持继续有界单文件pilot，尚未覆盖多文件、通用shell或模型测试反馈修复循环，
也不构成用户项目bug成果或E1全部样本/E2经验收益验收。
小任务直接处理；较大接线工程可编写有界任务交dsv4.1flash，不自动扩大为新平台。
具体真实运行需要既定用户授权与费用范围，工程委派不代替运行授权。

先取得无经验真实任务基线，再做经验和短上下文对照。保留失败/unknown，复用既有
Host/Broker/Oracle/ledger/测量，不重派已闭合的C6修复、不追旧warning。
本地提交遵守Git规范，不改Pi核心/用户真实配置/lockfile，不push/rewrite。
