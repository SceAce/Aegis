# 原架构贯通实现：审计问题清单

状态：编码进行中，不代表已通过验收。实现由 DS 编码，审计者只检查和测试。

## 初审：基础层

- `memory/runtime/events.mjs` 注释把 `appendFile` 完成称为 durable/flush，但无 fsync；进程异常/掉电保证不同。要按要求先落盘动作意图再允许副作用，不能误述持久性。
- Event 来源 `kind=runtime` 不在 schema 1.0 的枚举里；board 当前新增 `proposal.submitted/handoff.*/experience.decision/node.added` 作为顶层 event_type，而任务书要求用既有 note/boundary.changed 等表达或明确最小兼容扩展。不要静默挂 schema_version=1.0。
- `board.permittedNodeType` 的 success/failure + source kind 自动生成 Fact/Refuted，只看结果标志，不检查完整 Outcome 的前后条件、证据引用和来源权限。失败不是默认的普遍证伪；unknown/transport 错误不能产生 Refuted。
- 图边处理 `evidence_refs` 当字符串，但 schema 规定 `{ref_type,ref_id,digest?}`；Origin 查询和 episode/action/prompt 关系可能指向不存在的节点，必须明确外部 ref 或正确解析，不能用假图掩盖无关联。
- LLM 输入 source_refs/cause/state/authorization 的信任由 adapter 固定，不允许模型传递可获得 oracle/human 权限的字段；模型 text 只能声明，不能改目标授权或直接verified。

- `contest-bridge.resultToOutcome` 读取 row.source，但实际 result 工具写 result_source；更严重的是 appendContestOutcome 不论 independent/evidence 都写 human/oracle 来源，success因此可能生成Fact。必须仅接受规范来源+独立证据，引用规范 Outcome；unknown不是证伪。
- `ram.buildRam` 未按 episode/scope 过滤节点，且整段 slice 可能截掉pending actions/授权信息；不同题事实不能进入新题的RAM。交接必须保留关键字段，超预算时显式报告/缩小窗口而非静默丢掉。
- `handoff.evaluateHandoff` 只检查episode存在，不检查是否active/open。已经关闭的任务不能继续handoff；未知/未完成副作用必须阻止自动切换。

- Observer `aegis_switch_session` 是一次tool_call，先被加入pending，execute内部再查pending，可能永远拒绝自己的handoff请求；应只忽略该控制请求自身而不是其他实际工具。
- Observer `aegis_propose` append失败仍返回accepted=true/已记录；必须以落盘结果为准。序列化失败不能当候选产生。
- `before_agent_start` 把currentGoal覆盖成每次新prompt，handoff续接消息可能替代原始总目标；总目标要来自Origin/RuntimeState，不随短prompt改变。
- `/aegis switch` 执行前未重查当前pending/action和episode状态；旧handoff文件不能获得执行权限。任务匹配、log/episode/schema与新的当前state要复核，完成newSession后再记录handoff.completed。

编码完成后需以具体负测与实际组合请求核验这些问题；不能仅因 smoke 打印ok即关闭。
