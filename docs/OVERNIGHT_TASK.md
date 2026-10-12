# 已确认架构：今晚继续实现的任务与验收

用户授权继续补全，代码由 Pi `relay/deepseek-v4.1-flash` 编写，审计者只读、测、写文档。用户已睡觉：需要人类决定的事项记到 THINK.md 末尾（背景、选项、建议、暂时如何处理），不要擅自改已定架构。基础：THINK.md 当前架构、§9回答及 docs/ARCHITECTURE_DECISIONS.md 开头用户决定、可执行契约和阶段有用性标准。旧任务书中删Observer/hint-only方案已撤回。

## 永久边界

保留 Observer、六节点(text)/四对象、图板、RAM、LLM提案/切换、Oracle、Compiler、Router、Skill/Policy/Guard、复盘。LLM新候选不直接回灌hint；先获取验证结果写图板，结果再返回。人类Hint最高任务引导优先级但不是自动Oracle判定。未知不等于失败；运输字段不等于任务结果。经验Recognition/Procedure/Verification = when/do/expect/scope +证据/版本。没有符合门槛的通用规则不可捏造active；初次探索在授权内可以执行。Skill命中减少重新设计。

不改Pi核心，不改既有auth/models/settings、锁文件，不恢复已删除Python demo，不提交git。用现有TS/Node和必要Python(uv)，没性能证据不用C。测试临时目录、faux provider，无真实目标网络。委派日志保持私有，不输出密钥。不要加crypto stub替代、通用RAG/任意eval或大量防御代码。

## 批次 A：有效状态 / 每轮RAM / 真Runtime交接（先完成）

1. board保留历史节点，同时有current/effective投影。处理同Episode规范Outcome.supersedes；只认可合法可信同criterion/scope/subject的替代，不允许llm/foreign/cycle/missing引用淘汰Fact。被替代记录还可审计，但不能进当前RAM/当前规则支持。可信环境变化对相关绑定标stale/conflict而非抹历史。节点的结构化observed/criterion/ref要保留，不能只剩text。superseding unknown使之前Fact退出当前有效视图。
2. RAM每个模型请求前用已提交Event重建（不是仅before_agent_start），体现同prompt工具执行后的候选/验证反馈；去重复、保留toolCall/result配对和原始目标/权限/pending/unknown。控制自身元数据不无限递归膨胀。现存未验证候选是历史提案/待验证状态，不作为建议hint或fact回灌。请求记录RAM摘要/state revision，验证真正provider-bound请求。
3. 真实AgentSessionRuntime的/newSession路径，不再stub。看Pi现有 SDK createAgentSessionServices/createAgentSessionFromServices/createAgentSessionRuntime、setRebindSession和例子13。从LLM aegis_switch_session提案，经当前实际idle/批次结束后执行；manual /aegis switch仍可用，自动调度如果需Host在settled后的外部处理可写薄Host/helper，不能重构Pi UI。切换后新Session对象/文件/上下文必须不同、原历史不继承；同Episode/图板/授权/预算/原目标保持；只写一次handoff.completed；取消/创建失败/并发请求不能假成功或死锁。事件writer/订阅在teardown与rebind后正确关闭/续写。不用旧extension context在invalidate后emit。
4. 测试A：更正Fact退出当前RAM、unknown/跨题/恶意替代/恢复负测；同一次prompt多turn真faux请求看到最新RAM、稳定ROM、contest提示不遮盖；真实AgentSessionRuntime替换无stub并确认fresh context/objects/episode。失败取消不写completed，pending拒绝、后续正常流程仍可运行。

## 批次 B：动作契约 / 验证 / 经验与Skill（A通过再做）

建立一个可复用、小型 registry/engine，不把fixture经验硬编码为比赛能力。尽量提取共用接口而非新平行框架。

- ActionContract绑定 id/version/implementation digest/目标参数与来源、Recognition检查、Procedure argv或具体已注册函数、Verification检查、scope/authorization、停止/重试策略。LLM text只是提案，未知动作/checker无法执行；暴露明确未完成映射，不能靠改JSON宣称完整。
- 首个安全信息动作：工作区文件ELF头/架构/位数检查（直接解析实际文件或现有readelf，本地严格目标）；规范观察、完整step Outcome引用文件摘要与动作，给图板Fact/RAM。缺失/截断/非ELF/越界为unknown或拒绝，不预测位数。目标版本变化旧观察退出当前视图。
- 既有脚本参数绑定：只对人类配置登记的脚本/executable与版本执行，参数data-only、最终argv schema、cwd/目标/权限，NO shell eval/Experience任意可执行文本；timeout不盲重试，检查实后态的注册Oracle。无真实脚本配置时测试自建临时样例，运行态保持未配置，不自行登记比赛远端。
- 普通模式待批准/非UI拒绝；auto仅在用户给定target/workspace及允许tools/network范围内授权。无远端配置不访问网络；不宣称cwd是真沙箱。不把auto授权当验证通过。
- 用户“数据有用”契约：获得(data/evidence ref)→实际使用该data的Action→已验证阶段Outcome。新引用type应规范document。LLM可报告使用意图，只有真实执行动作引用及验证结果支持才记录阶段有用；仅阅读/上下文/自述不是证明，unknown保持。不必最终flag。实现记录与日报，标关联而非因果定理。
- Candidate proposal→绑定known predicate/action/checker/参数/scope→独立验证→机械Compiler。抽象或缺失映射由LLM提案并返回缺口，不自动理解散文为代码。现行≥2独立Episode、verified pre/post、replayable proofs、当前env、无冲突门要复用；重复Session/同一Outcome/更正不增独立次数。自然语言候选在不足证据时candidate。
- Router四模式保留：direct已active+已验证current when+全参数→0LLM规划，habit active+缺少参数→LLM仅绑定再Guard/Oracle，hint只对已有可靠经验的当前部分匹配，不把新候选回灌；deliberate未知/异常恢复分析。可信冲突/环境变化暂停绑定，反例保留，不一次失败永久封路。
- 审核表：schema、refs解析、action version、目标指纹与权限不允许unknown通配，支持Outcome.supersedes。脚本实现改动需新版本/重验。

## 批次 C：接回实际入口 / 每日复盘 / 验收

- 比赛一条命令仍以外部cwd工作区启动，Observer必须保留，所有新增control tools正确暴露。记录task/episode/session/action/data/outcome/experience与版本/模式，私有存储、日志错误不静默。所有projection可从log重建。
- 用户提供目标与授权，auto/normal开关；人类hint与LLM提案明确区分。没有经过审阅卡可off运行，不假装命中。
- 日报把有效Outcome/未知/更正、handoff、数据使用/阶段贡献、经验选择/失败反馈、采集健康列出，按具体event/episode指向问题。不能只靠LLM自报贡献，不自动提高置信度/晋升。
- 全部新增meaningful负测+原15离线回归；真实Pi测试不用付费API。缺失bundle的login-relay smoke是当前已知环境缺口，不改Pi build来掩盖；源码入口可测试。没有证据的模型效益数据不填零，不声称统计进步。
- 更新短模块文档/运行命令/兼容说明，源码/tests与实际入口一致。遗留无法决定问题写THINK末尾（不要替用户做决定）；其余完成后用已实现/未实现/实测表交付，不自行删除职责/重定义架构。

## DS执行要求

每个批次先给具体文件范围与接口计划，再编码，别反复扫描全monorepo。按当前Pi docs例子与源码签名，遇难点可提理由/可选方案，但架构变更要进入THINK待决，而非直接落实。优先按A→B→C建立一条贯通路径，不产生第三套离线demo替代产品。每阶段跑测试，失败继续修；不得把异常测试断言改弱来宣称通过。
