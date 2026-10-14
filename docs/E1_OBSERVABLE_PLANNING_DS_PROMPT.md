# 给 dsv4.1flash 的总提示词：可观察白板与LLM任务规划

下面正文可直接发给新的DS会话。配套规格与矩阵已在仓库，必须实际读取。

---

你负责完成Aegis下一轮工程实现：完整展示白板节点内容与任务依赖树，并让LLM在真实
产品路径里拆分任务，Host准入后按依赖执行。当前任务要求实施编码、测试、集成、
自审与本地提交；不要只返回计划或给现有界面拼几张静态示意图。

工作目录`/Users/scemac/My_github/Aegis`，分支`feat/c6-agent-product`。任务规格以
本次消息和下列文件为准。规格制定时HEAD为`2bf4485`，这三份任务文件随后另作提交；
启动时记录实际HEAD/工作树，不回退到旧HEAD。保留用户已有改动。

先完整读取：

1. `docs/E1_OBSERVABLE_PLANNING_TASK.md`：设计、合同、实施顺序、范围、交回要求。
2. `docs/E1_OBSERVABLE_PLANNING_TEST_MATRIX.md`：正负/真实SDK/依赖/恢复与required清单。
3. `Pi_Agent_base/AGENTS.md`、开发/测试/Git规范；当前阶段入口`docs/DS_MASTER_PROMPT.md`。
4. `docs/CAMPAIGN_ARCHITECTURE.md`的白板和动态Task规定、`CAMPAIGN_CONTRACT_BASELINE.md`、
   C6外部验收当前结论、三事实/生命周期契约与SDK真实接口。
5. 直接相关源码全文及调用点：Board、Observer、observation模块、dynamic-policy、
   projection/event-contract、scheduler/host、c6 Worker/entry/SDK runtime/config。

这次不是重开已闭合C6审查，也不是整理warning。根因已明确：UI没有使用已有Board
节点与任务关系，动态Task重建丢depends_on，现有动作附带单提案不能支持独立完整规划。
请把这条完整数据路径一次打通：

```text
可信根目标/授权附件
 → 同一C6 provider gate驱动的LLM规划
 → 结构化完整候选计划（不是普通文字树）
 → Host整图校验、原有policy准入与durable激活
 → Scheduler按真实depends_on串行调度动态Task
 → Broker实际效果 + 独立Oracle
 → 同一事件流的白板、任务图、请求状态和退出后重建
```

必须做到：

- 页面有六类节点实际内容/详情/证据/有效与历史状态、父子树和多前置依赖图、候选与
  Host准入/拒绝、任务目标/状态/Outcome、真实请求consumed/pending/unresolved。
- Campaign目标容器、规划Task成功、业务目标完成分开。计划提交成功不能表示题目完成。
- 初始Manifest不预置完整业务树。模型收到可用接口与判据，由模型提出Task与关系；
  不把手写任务列表或几段assistant文字称为LLM动态拆分。
- 纯规划可以没有业务动作，不能伪造fixture动作绕过no_model_decision；普通业务路径
  仍要求合法动作。计划必须覆盖Host冻结的根目标必需验收；业务Task从可信业务模板
  取Oracle，不因为parent是规划Task就继承plan_ready判据。
- 全图校验权限、引用、父子/依赖环、可信判据与累计预算；不完整准入/activation失败不执行
  子图；恢复不新ID重试、不丢预留、不重复效果。
  优先完整批次一次durable记录，复用EventLog/reducer；不必另造逐条事务平台。
- 规划也经过既有两侧预算责任/联合结清/规划终止门；aborted、commit failure、未决
  不能让计划或动作进入下一阶段。不要另开裸provider调用或重写请求账本。
- 同源view给Web/API/Pi摘要；刷新可暂停，来源尾摘要可见，run退出后观察服务仍可读。
  prepare和observe零请求；用户以后用两个终端和同一配置启动真实测试，输入在启动前冻结。
- 保持loopback只读、脱敏、XSS防护、分页和坏链诊断；原事件/权限/Oracle仍是权威。

先记录基线，完善精确JSON/schema/来源/缺失语义与测试矩阵，再写行为red并实施。
任务书授权本轮必要的小型加法契约/词汇/规划模式扩展，不为helper命名或普通接口选择
反复询问。若发现真架构冲突，给出具体字段和最小方案，继续不受阻部分。没有子Agent
能力就串行完成；不得编造并行审查。

工程demo使用真实Pi SDK+faux和本地文件/Oracle，证明模型工具真的产生动态Task、
乱序计划的多前置依赖真的约束provider与效果、候选/准入/执行三时点页面对应真实源。
至少一个正常链、一个坏计划、一个不完整准入恢复、一个全完成重启零新增效果。不同计划
产生不同图，不能写死样本。faux证明工程接线，不能称真实LLM能力通过。

保持已有断言，补矩阵要求的聚焦测试、关键行为mutation。最终一次运行新增focused、
18 C6、26回归和矩阵附加required、修改范围Biome、改前改后Campaign tsc。实际捕获
argv/exit/diagnostic差异，不用历史196或旧日志填绿；检查通过后不无界扩大扫描。

本轮禁止真实provider/CTF/目标网络实验、修改Pi核心/真实config/auth/lockfile、新依赖、
通用shell/HTTP攻击平台、自动退款重试、多Worker、经验晋升、全仓warning清理。
本地回环HTTP与faux测试属于已授权工程检查。max仍沿Pi只读模型配置，付费run由用户
后续执行。不要改用户已完成pilot目录，日志放ignored runtime/dev。

按Git规范明确路径暂存、审查diff、本地提交每个可审查单元，提交正文披露DS协助；
不push、不改历史、不混入无关改动。完成后更新短报告、矩阵、runbook/阶段入口，交回：
最终合同与调用点、真实动态链/数值/恢复证据、red/green/mutation与required结果、零请求
prepare和双终端复制命令、文件清单/HEAD/工作树/未实测限制。状态仅能是
`internally_verified / awaiting_external_review`；当前阻塞未解决则`changes_required`。
正常内部步骤自主推进，完成本轮范围后一次交回，不自动启动真实CTF。
