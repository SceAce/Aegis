# D: Evidence resolver + 已验证 workflow 贯通（只允许新库/测试，避免C2冲突）

用户授权补全原架构/Recognition Procedure Verification；监督者只audit/tests。背景 docs/OVERNIGHT_TASK, ARCHITECTURE_DECISIONS前60行, THINK §9.1-9.4及现行MemorySchema。A已实际SessionRuntime/current board/request RAM通过，B2通用Compiler/Router/Contribution库已通过审计负测，C2当前正编辑Observer/action-runtime/script-registry/contest/daily等，不允许改这些文件。D允许写新 `memory/runtime/evidence-resolver.mjs`、`workflow-engine.mjs`、新独立tests和docs/OVERNIGHT_D_REPORT.md/OVERNIGHT_D_PENDING.md，不改任何既有文件/THINK/Pi/config/auth。

目的：通用Compiler/Router不仅调用者自造Map，应提供实际可信EventLog/artifact映射，可被Observer/Host调用；至少真实受控两Episode→规范Experience→habit参数绑定/direct无需模型规划→实际ActionContractBroker/独立Oracle→反馈，与现有代码为同一状态来源，不另造demo schema。

- Evidence resolver从校验过的已提交Event（verifyChain）、当前effective board解析outcome/episode/action/data/artifact/replay exact ref/digest/actor/source，同Episode/criterion/args/action implementation/当时before-after state匹配。无法解析、模型源、fake digest、supersedes、foreign/cycle/unknown不提供trusted record。入参任意对象不算证据；这是可信库API，caller控制不代表LLM控制，模型不得传resolver/callback。
- 正常RuntimeState初稿Episode仅为open/projected对象，要映射明确的canonical relation，与Compiler需要的独立Episode/isolation_ref/human-replay参数，缺失真实重置证明保持candidate而不是编UUID满足count。
- 重放只在明确人类/可信代码配置的隔离适配器中执行，永远不重跑原目标/远端/非幂等脚本。基于之前实际pre-state复建fresh local temp状态；记录实现digest/args/pre/post/criterion/transport/artifact hashes及真实独立重放记录；可复用fixture Oracle，但不能hardcode称比赛可用。
- workflow engine协调: bindProposal显式谓词/actionRef/checker→missing gaps或bound（do text不eval）；compileExperience使用真实resolver全部门；routeLearning只对verified effective currentState；direct broker final args+授权+pre/post，全参数≥0模型调用；habit returned缺参数映射后再check，异常未知退出。新候选不直接hint。已登记Skill/动作已批准路径引用，版本变化必须暂停重新验证，不自行改变生活cycle规则。
- 独立验证有用性Evidence: 保存data/action/stageOutcome真实引用，不因为脚本exit0决定success。feedback支持rule revision/Action/Outcome关联，可信scope变化/反例保留候选或暂停绑定，unknown不negative成功失败计数。
- 全部测试使用独立temp目录/真实文件和脚本，现有ActionRegistry/contract/broker，EventLog single writer。不写新的全局Event源、不fake proof Maps-only、无真实network/model、无本机外部文件删除/commits。可测试临时safe deterministic stage文件的Workflow（非 exploit）。来自同一尝试的Session数量不增加independence。
- 首个工作流可使用可信test temp registeredNode script+JSON后態Oracle，在受控隔离再执行两次live学习及proof，规范规则target template/params保持命题一致，任意scope泛化不自动做。参数不同的独立task若契约允许需验证，模板不能通过成功union/省略必要condition达成active。
- 此次必要负测：假actor/source/proof/ref/changed script/version/currentScope/foreignOutcome/supersedes、shared isolation、未批准、没有Replayadaptercandidate、nonidempotent禁止原target自动retry、habit绑定有差异拒绝、direct执行失败Oracleunknown不假learned。

如果使用现有B2库发现bug，不越权修改，写docs/OVERNIGHT_D_PENDING.md precise reproducer和建议给监督者派发修复；若批次太长保持可信candidate/gap接口且明确未完成，不以削减架构作完成声明。最终报告API、新文件及实测/未测，不提供自己编出的比赛有效率数字。
