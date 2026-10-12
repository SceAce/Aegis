# Aegis 原架构贯通：DS 实现任务

用户已授权现在开始编码，代码仅由 Pi 的 `relay/deepseek-v4.1-flash` 编写；审计者不写实现。不得修改 Pi 核心。任务不能收缩为 hint-only，也不得移除 Observer 来避免组合冲突。

## 已确认架构（用户决定优先）

1. 图板保留 `Origin / Fact / Refuted / Intent / Hint / Artifact` 六类节点，作为 `Event → Episode → Outcome → Experience` 四对象的协调投影，节点包含 `text` 文本字段与必要结构化元数据/来源；不是另一套真假权威。
2. 候选判断由 **LLM** 提出，LLM 只能提交 Claim/Intent/Candidate。只有 Oracle/明确人工核验可以写验证事实与 Outcome，Compiler 判定 active 晋升。
3. 短会话由 **LLM 分析是否切换**；Runtime 安全边界执行，交接图板、RAM、未完成动作和预算，Session != Episode。
4. 用户当前任务是比赛中正常使用、获取高质量事件与影响数据、每日复盘。尽量贯通原架构职责，不擅自删除模块或放松证据纪律。
5. 工作区由其他目录的一条命令启动，默认调用时 cwd；私有状态留在 Aegis 指定目录。Python 使用 uv；Pi 适配用 TS；不需 C。所有旧 Python demo 删除是用户已有改动，不能恢复。

读取 `THINK.md`、`docs/MEMORY_SCHEMA.md`、`docs/ARCHITECTURE_DECISIONS.md` 开头用户四项决定，以及当前 observer、contest extension、fixture modules/tests。决策文档其余部分有未确认建议，不自行提升为已批准契约。CONTEST_MVP 中移除 Observer、用卡片替代循环的限制已撤回。

## 交付：一个保持模块职责的完整纵向链

不另写互不相关的第三套 demo。尽可能复用既有代码，Aegis 核心为小模块库、Pi adapter 为薄扩展，不引入多服务。

### A. Observer + 单写 Event + Runtime

- 保留 observer 的真实事件采集功能，并恢复到 contest/run.sh 的组合。
- 修复 full systemPrompt 覆盖与 contest sections 冲突：Observer 用当前 Pi 的 structured sections 注入稳定 ROM/必要 RAM，而不是绕过其职责或移除它；组合测试同时加载实际启动器的扩展顺序。
- 一个受控任务尝试具有 task_id/episode_id/authorization/goal/budget（未给定可 unknown，不捏造）。同一尝试包含多个 prompt/短 Session，不每次 before_agent_start 新开 Episode；新题才另起。旧 Observer smoke 兼容可以调整测试但不得隐藏职责丢失。
- 每运行/任务有独立追加日志；恢复会话续上已验证链，重复 ID/sequence 被拒绝；日志失败可见，副作用工具不能在审计不可用时继续。读工具可按文档授权范围继续。不要对任意 bash 声称系统沙箱。
- 事件持久化前后原子性说清楚；不推测 tool exit/task success。工具记录包含 action id/request-result pairing，必要的 parentToolCallId/duration/agent_settled.aborted；敏感文本脱敏，原始轨迹只在限制权限下保存。

### B. 图板 / RuntimeState / RAM

- 有真实持久 projection（可 JSON，不强求图数据库），包含六节点与关系、node_id/text/source_refs/status/scope/revision，以及任务目标、authorization、verified facts、claims、pending actions/steps、experience decisions、生命周期。
- 写权限由可信 reducer/module 控制，LLM 没有直接写状态文件的 tool。state 可以从 Event + Oracle/Runtime note payload 重建；用既有 note/boundary.changed/observation.captured 表达，不偷偷改 schema 意义。如果需小扩展，明确记录兼容说明。
- 对模型声明可形成候选 Intent/Hint，不能提升 Fact/Refuted。Runtime 自己维护版本与锁，不把自然语言自称 verified 当验证。
- RAM 从相关图板状态构建，包含总目标、当前子目标、事实/假设分开、未完成动作、失败/unknown 与相关引用。在每请求边界更新，不反复累加，明确上下文预算（可字数上界并标估计，不自称 tokenizer 精确）。

### C. LLM 提案与短会话交接

- 用 `registerTool` 暴露受控提案接口（候选判断/Intent、子目标/假设、切换请求与理由）；额外 typebox/schema 校验，拒绝身份/授权/Oracle 状态字段伪造。
- LLM 请求切换要记录可审计提案。等待实际工具执行/日志/图板落盘后才能执行；不要在事件 handler 内调用 command-only APIs 导致死锁。
- 可以用安全 command 边界/受控 Host 处理切换（SDK 或 Pi command context）。若 CLI 无法立即自动切换，必须提供可执行的 `/aegis ...` 接受已有 LLM 切换请求的新 Session 路径并诚实说明差别，不假装 proposal 就完成 switch。
- 交接保持同 Episode/授权/预算，真正清空旧上下文，新会话重新绑定数据源，verified facts/claims/next Intent/pending actions 保留。回归证明切换后不重复已完成动作、不增加独立证据次数。

### D. Oracle / Outcome / Compiler / Router 反馈

- 统一任务/步骤的验证入口：确定性现有 fixture adapter + 用户明确的外部结果录入作为可接来源。人工结果用于规范 Outcome，unknown 未完成独立性不得 success。保留 source/provenance 与每条 criterion 的证据，非只写竞赛统计字符串。
- 候选经验由 LLM 提案，可从已记录经历引用条件/动作/结果，不得直接 active。Compiler 对当前注册可回放动作沿用现有 fixture 证据门；一般比赛路径不足证据保持 candidate，不硬编码 active 或假造 replayability。
- Router 给每个候选记录 considered/matched/rejected/selected 等原因和前提引用；四模式 `deliberate/hint/habit/direct` 保留，执行只在模式要求满足时。至少一条可执行注册 Skill 证明 habit 参数绑定 / direct 无模型规划；不能通过大通用 shell执行器凑数。
- Skill/tool包装走授权与Guard；异常退出经验捷径并记录新的 Outcome/unknown，必要时暂停/复核，不用一次失败永久否定方法。
- contest hint 卡保留为人类 Hint/候选输入，不混同 active Experience；迁移/导入明确来源和未验证状态。

### E. 数据 & 每日复盘

- 现有 contest activity、session、result、daily 接回 task/episode/state/routing 的引用；不重复两份独立真相源。每日报告至少可查使用了什么经验、何时影响下一请求/步骤、结果怎样、切换是否丢状态、采集是否失败。
- 不以 LLM 自述采用/solved 判定贡献和success。报告未知缺口、引用具体运行事件，让人按案例修理论；版本化卡/规则，不静默重写历史。

## 实现顺序、验收与范围管理

先给出简短现有模块->实现变更清单，然后实现 A/B/C 的闭环并真实 Pi faux-provider 组合测试；D/E 用明确接口接回既有fixture与竞赛结果。不允许宣称完整通用框架或安全隔离已实现。

必须测试：
- Observer + contest/runtime 同时加载，ROM/RAM/Hint 进入真实 Pi请求而不遮盖彼此；off不注入经验但保留基础记录/图板。
- LLM提案产生候选节点与text、来源事件；恶意自称fact/active/authorization被拒绝。
- Event重放重建同图板；same task跨prompt/session保留Episode；切换/重启不丢进度；未完成动作时拒绝切换。
- 审计失败副作用不发生，普通失败/timeout为unknown；source/result规范化不伪造Fact。
- 经验命中、不适用、scope冲突、参数绑定、低风险注册direct动作和异常反馈至少有可审计离线样例。
- 原有 fixture / contest tests不回归；如因契约调整需改测试，写明确理由。

禁止修改 `Pi_Agent_base/pi/`、auth/models/settings 配置、已有用户删除文件；禁止真实 CTF/比赛网络操作；所有自动测试临时目录、faux provider。无需真实中转调用作为验收，用户已授权 DS编码调用本身。无 git提交。不要耗费长模型调用反复读完整无关 monorepo。

如果一次时间不足：先留下可运行的已贯通接口，并如实列出未完成项；审计者继续派发下一阶段。不能将未实现职责标为永久取消，不能靠改文档下调验收。
