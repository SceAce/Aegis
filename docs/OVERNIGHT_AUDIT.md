# 今晚补全审计记录（进行中）

实现全部交给DS，审计者不写实现代码。遵循THINK与用户决定，不为测试成功改变契约。

## Batch B早期审计（ActionContract）

- `createActionBroker.invoke` 末尾 `transport.tool_ok = status === "success"` 混淆transport与goal status；独立验证不通过时运输仍可能正常，必须保留原运输事实。
- broker验证目前只接受procedure提供的observed，再交check；具体action/checker必须独立读取真实后态或解析原始artifact，不可把producer自报ok当Oracle。
- 原有fixture validateActionArguments只检查string与必填。新契约有更多类型时需完整检查number/boolean/enum/range/optional与unknown字段；参数不合法必须执行前拒绝。
- invoke permit目前只查动作/版本/参数digest，不查target/cwd/scope/过期/授权版本。授权模块实际context复核必要；不能凭外部构造ok:true伪造授权。
- function source digest遗漏闭包依赖，argv实现digest遗漏run wrapper/检查器实现。需明确reviewed implementation依赖版本与文件digest，不能把函数源码相同视为闭包参数相同。
- recognition/verification空predicates会通过，无可验证条件时不能自动成功。未知数据与确定否定要分开，后者可记录failure，前者unknown。
- natural-language候选未绑定checkers/when/expect时要列gap，不能只指定action id就宣称experience bound。

## Batch B具体动作/Router追加

- ELF/script build 当前有 replayable=true，却未进行独立动作重放；尤其script非幂等不可自动重跑。可复读观测只证明观测一致性，规则active须真正可审计可重放证据，不把registered id/一次执行当replay_count=1。
- 新step Outcome须包含schema_version、episode_id及合法failure_mode，unknown的observed/null语义正确，证据artifact必须可解析且摘要与实际文件一致。
- Script cwd的insideRoot只做resolve不做真实路径验证，symlink可能逃；Python/Node interpreter+脚本参数要pin脚本本身，而不仅pin解释器。不得拒绝普通已登记script仅因使用解释器，但用户未登记的脚本不能执行。
- timeout不能把一切signal都当timeout；非零退出时真实后态仍可能已达到任务criterion，须保留transport并检查，不能出口码自动作判据。
- Router允许缺失action_version/implementation_digest通过，不符合已确认版本绑定；支持计数还只successIds.length且verified_by非空，不能承认证据独立性。
- currentState未知字段+neq/existence，known判断目前不正确，未知不能direct。
- direct参数完整性只查taskArgs忽略template，而实际构造args又只用template，可能漏参数/覆盖用户参数。须统一绑定&schema检查，extra/type/required异常不得direct。
- Router暂停应是对原绑定的可信变化，不匹配新目标仅不适用；paused是状态，不额外发明第五执行等级。

## Batch B Compiler / Contribution追加

- compiler proofKey返回stable字符串，却Object.entries字符串判必填，不可靠；每条proof identity/Outcome与Episode应交叉解析，不只distinctSet计数。
- compiler当前仅hash非空即replayable、artifact只带digest即resolvable；无真实内容/链/Oracle/prepost验证会active。必须调用可信evidence resolver核验真实记录和proof artifact，replayable=false/count0拒绝，registered action/version/checker绑定，superseded撤销支持，不从输入布尔自报过门。
- 不能把所有when取并集，形成从未同时成立的世界；候选规则前提必须在每个支撑Episode都验证，范围变化/缺条件保持candidate。
- distinct replay hash并不等于独立性，两个相同方法的合法重放可以同内容hash，不能为满足count伪造区别；proof身份与执行重置记录分开。
- experience输出需遵循MEMORY_SCHEMA完整字段（expect/provenance/revision/support计数/created+updated），不能新造缩减结构冒充规范规则。
- contribution dataInEvidence接受任何data类型而不是指定dataRef，且data_obtained/Outcome.status自报即可verified_use。必须同Episode有效数据、真实Action.completed、可信full stage Outcome精确引用与顺序核查，hash/version/supersedes同样生效。
- 获得/使用/推进不应每个阶段都被同一个verified_use覆盖；obtained是真实数据记录，used是实际绑定动作，stageUseful需独立验证推进，unknown仍保留，不为了凑3-stage为每个阶段自报成功。

## Batch A待核验

- supersedes必须同Episode/criterion/subject/scope且可信完整Outcome；历史仍可查，当前视图不能被无效引用/LLM/跨题/循环撤销。初稿validateSupersede只拒source.kind=llm，其余来源可用不完整unknown撤销Fact，需oracle/human来源且证据/对象/顺序验证；未来记录和重复Outcome ID不能覆盖索引。
- environment.changed不应追溯使之后重新验证的Fact也stale；只影响事件之前同目标/相关scope的绑定。新验证应恢复当前事实，无scope的变化不能误停整张图；无法界定范围保持显式冲突，不猜。
- 每turn RAM只能基于已提交事件，保留mandatory状态和tool协议，候选历史≠推荐hint。弱prompt不能掩盖ROM，人类hint须按已确认优先级处理。
- handoff实际AgentSessionRuntime必须真的替换对象与上下文，不能stub或只创建SessionManager。取消/重建失败不写completed，context invalidation后不能使用旧writer，session_start/callback不能双写completion。

各项是编码中初审，最终按实际改动与测试关闭或保留，不声称已修复。
