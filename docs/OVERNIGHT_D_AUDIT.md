# D evidence/workflow 初审（编码中）

1. evidence-resolver TRUSTED_SOURCE_KINDS包含agent/runtime用于结构，但outcome/replay/data不能因此成为可信判定；模型声明若由runtime记录仍不等于Oracle。Outcome必须source oracle/human且full criterion/observed/evidence/prepost，Replay必须replay adapter实际isolated执行，不能runtime.note写个true通过。
2. resolver effective superseded字段名可能与board.effective实际不一致（看真实输出）。stale检查当前用superseded.some，而非staleNodeIds映射，易漏；必须当前有效Outcome/index正确过滤，负测证明unknown supersedes/环境变化后不能active/direct。
3. Artifact当前把payload.content_digest照抄为真实digest，不hash actual value/private file，fake digest仍可通过；data同理。实际value->digest独立复算/ref ID必须解析私有路径约束，消息摘要不算内容存在。
4. action index按action_ref覆盖多Episode动作，completed patch的空字段覆盖requested pins；应execution identity独立，与episode/args/version/implementation/request-result配对从规范记录解析，非同名action就是同一次执行。
5. replayOutcome sink.append没有await且接口不是EventLog.append规范，writer失败仍ok；必须单写规范事件/返回持久结果，未落盘/未replay验证不成功。replay实际source/prepost/impl/args/criterion复核，trusted adapter.isolated flag也不证明原目标没重跑，要在可控测试adapter实现fresh sandbox。
6. workflow.assess把tool_error/timeout classification=failure，即使status unknown；违背Outcome失败定义。可单列transport_error但goal unknown，不能混统计negative。
7. executeDirect接受action_ref/args就执行，无routing decision/active Experience/revision/current when绑定。Broker可用于deliberate，但名为direct不能跳过已验证经验Gate；从confirmed decision检查并final revalidate。
8. workflow routeLearning输入任意currentState即trusted因为chain_ok，不充分；需要状态derived/verified data refs来自effective board+resources，不是caller selfreport。Missing/unknown不neq match。
9. habit补参数可，但动作template/arg绑定/Oracle契约要current pins+授权。参数化复用不得把一个参数成功范围自动推广；如果未知mapping缺字段返回gap，不eval。
10. feedback counterexample不能仅Outcome有oracle.identity +failure+counterexample=true；同rule version/scope/preconditions_verified/postcondition_failed+真实action关联才能negative，unknown不退役。

这些属已定证据和运行纪律，不需用户重新决定；请DS修，审计者不改实现。
