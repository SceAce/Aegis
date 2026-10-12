# 给主 DS：C3 Campaign 执行闭环

历史 C3 实施提示词：DS 交付及本轮用户授权的审查/修复已经完成，见 `C3_EXTERNAL_REVIEW.md`，修复提交 `6bca9f2`。当前下一任务为 `C4_REPORT_DS_PROMPT.md`，不要重复执行下文以重开 C3。

先完整读：
- Pi_Agent_base/AGENTS.md
- docs/AGENT_DEVELOPMENT_STANDARD.md，重点 §3.1
- docs/AGENT_TESTING_STANDARD.md、docs/GIT_STANDARD.md
- docs/CAMPAIGN_CONTRACT_BASELINE.md
- docs/CAMPAIGN_NEXT_PHASES.md、docs/C3_EXECUTION_TASK.md
- docs/C2_EXTERNAL_ACCEPTANCE.md（Host 入口与预算基线限制）
- docs/CAMPAIGN_ARCHITECTURE.md 的 Broker/Oracle/Phase C3 章节
再完整读实际 scheduler/ActionContract/Broker/authorization/script-registry/Observer/resolver/
Session supervisor 及相关 tests/helpers；SDK 接线完整核对实际文档/API，不凭记忆写参数。

在干净起点建 feat/c3-execution，记录父仓库与内嵌 Pi HEAD/status。
先冻结简洁接口/owners/测试矩阵，再按 C3-A→B→C→D 实施，一次总任务内自主推进，
不为 helper/小任务停下请示或交外部审计。有子 Agent 工具则限制文件委派，无则串行如实报告。

只交付任务书的执行闭环：
1. 一个可运行的 Campaign Host 入口，把 Manifest、C1 scheduler、Worker、现有 Broker、
   真实本地效果、独立 Stage/Task Oracle 和结果投影串起来。
2. 先本地 fixture，再复用注册脚本做受监督 macOS workspace adapter；固定 executable/argv/
   digest、data-only 参数、cwd/env/timeout/授权/网络策略，不执行 Experience 文本或模型代码。
3. Campaign 模式动作统一经 Broker，direct Pi tool 不得绕行；副作用前 durable intent，
   日志失败不执行，effect 后失败停止新效果，恢复先核对真实状态、不盲重发。
4. 一套本地确定性 Oracle 支持 success/failure/unknown/delayed，实际读后置状态与证据，
   结果绑定 Task/Episode/Stage/scope，不能把 exit code 或 worker 声称当真值。
5. Host 真调用已验收 C2 的安全轮换入口，明确基础预算覆盖位置与唯一 charge 所有者，
   不漏掉/双计 Session 增量；保留同一 Episode/授权/状态。

按任务书 C3-POS/DYN/DENY/DUR/ORACLE/REC/SESSION/REG 验证产品调用链。
至少一个真实 SDK+faux 入口；EventLog/本地效果/必要恢复子进程是真的，外部模型/网络不调用。
先 red、再实现、再聚焦与受影响回归；不 weakening/assert skip 伪绿，少量 mutation 按风险。
真实 SDK 用 source-resolver。类型检查旧诊断和实际 exit 如实报告，不为全库清零重构。

范围冻结：F16 cache 性能、C4 report、C4a UI、容器/远程平台、多 Worker、真实能力实验后置。
workspace 不是 sandbox，不把工具隐藏或 network=false 声明称为 OS 隔离。
新阻塞只限已复现当前核心损害，记录为什么不能后置，不无限扩审计。
不修改 embedded Pi/凭据/模型/lockfile、不新增未授权依赖、不跑真实模型/网络/目标。

分任务显式路径暂存、review、本地 commits，不 push、不重写历史。
维护简洁 C3 plan/matrix/implementation report，附产品运行/恢复命令、required/deferred、
真实效果/绑定证据、exit/log、分支/commits/status 与限制；复用报告，不新建长审计链。
完成后 internally_verified / awaiting_external_review，交一次限定 C3 验收，不进入 C4。
