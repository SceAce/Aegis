# 贯通实现第二阶段审计

状态更新（2026-10-11）：本轮 DS 实现已结束，审计者独立复跑 15 项离线测试通过；以下原问题保留作审计历史。测试通过表示对应接口已覆盖，不表示全部架构或比赛效果已验证。

已核验：Observer+contest 实际请求组合保留 ROM/RAM/hint；LLM claim/候选提案进入六节点图板；同任务跨prompt/新session继续原Episode与目标；不可写日志时真实write工具没有创建文件；当前task/session绑定、重复Outcome导入幂等、更正supersedes、任务failure与方法Refuted分开；每题独立Event/RAM/handoff路径；runtime1.1新增契约已记录。

未完成/未验收：完整AgentSessionRuntime替换目前只有命令注入seam和独立session恢复测试，不能称真正自动切换已验收；一般比赛Experience的when/do/expect仍是LLM自然语言提案，未接通通用Compiler/Skill，保持候选；RAM更新主要在before_agent_start，不能称每个模型turn已自动重新投影；旧login-relay-smoke依赖缺失bundle仍未通过；事件与图板的指标、作用域、替代Outcome的当前有效事实视图需后续扩大负测。以上不能删架构职责或下调标准来宣称完成。

实现代码由 Pi 的 relay/deepseek-v4.1-flash 编写，审计者仅写任务/审计文档、读取代码和跑测试。没有提交Git或修改Pi核心、模型凭据配置。

以下是审计者发现的原待核实事项，不授权降低验收。

1. `/aegis outcome <task_id> [session_id]` 当前可在任务A的session读取任务B结果，却把outcome的episode_id设为当前A。必须拒绝不匹配task；指定session需确属当前Episode，不因手动参数得到跨题写权限。重复导入同一结果须幂等，后来更正用supersedes而非制造独立次数。
2. 新outcome命令测试的 `commandContextActions.newSession` 是人工实现的stub，只创建SessionManager+执行callback，未切换真实AgentSessionRuntime。不能在文档/报告宣称已测试真正的新会话替换。可以保留command seam负测，但真实SDK Runtime切换需要另外证明或诚实标待测。
3. 现阶段候选Experience的when/do/expect是自然语言提案而非现行Experience可执行规则；不满足compiler active门前不可自动执行。应把它当LLM提案载荷，保留schema转换接口和证据引用，不宣传通用compiler已经贯通。
4. 平台最终失败/题未解不同于方法证伪；result-to-Outcome必须分别记录任务结果与Refuted(method)的门（precondition verified + postcondition_failed），不得把任务失败直接转Refuted，也不应仅为阻止Refuted而丢掉已核验的任务failure。未确认则unknown。
5. `events.mjs`新增schema1.1和source.kind/runtime/llm必须有兼容文档。现行schema1.0事件不能悄悄带扩展source；若保留混版本链，旧reader不能被宣传全兼容。已有fixture1.0保持原样。
6. 实际比赛launcher与SDK组合的ROM注入目前还不同（同时append-system-prompt与Observer section可能重复），测试要与真正入口一致。副作用工具audit故障须真实Pi tool execution未发生的负测；只有提案返回accepted=false不充分。
