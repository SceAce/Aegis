# Aegis 架构决策：已定契约与推荐方案

状态：**设计草案，待用户确认**。整理于 2026-10-09。

本文对应 [`THINK.md` §9](../THINK.md)，帮助确定实现边界，不替代用户原回答。
“已定”表示现行文档已经明确，不表示代码已经实现；“建议”尚未获确认。
数据字段仍以 [`MEMORY_SCHEMA.md`](MEMORY_SCHEMA.md) 为准。草案不授权代码自行扩展 schema。

## 用户新增的四项决定（2026-10-11）

1. **图板模型**：保留 `Origin / Fact / Refuted / Intent / Hint / Artifact` 六类节点，作为 `Event → Episode → Outcome → Experience` 四对象链路的协调投影；同时补充相关的 **text 字段**，用于保存节点或投影所需的自然语言文本。text 保存声明、解释或上下文内容；其事实状态、适用性和执行权限仍由结构化字段与来源判定。
2. **候选判断来源**：候选判断由 LLM 提出。LLM 只能提出 Claim / Intent / Candidate，不能直接写入验证 Fact、Refuted、Outcome 或 active Experience。
3. **短会话切换**：由 LLM 分析并提出是否切换的建议；Aegis Runtime 根据状态、预算、未完成动作和授权边界决定是否接受，切换不能丢失 RuntimeState，也不能把 Session 次数计为独立 Episode。
4. **任务节点输出**：任务节点输出以现行文档为准，当前按文件修改时间取最新版本。当前最新修改文件是 [`docs/CONTEST_MVP.md`](CONTEST_MVP.md)（2026-10-11 00:27 左右），但其中部分“比赛前临时方案”已被用户后续指示撤回；撤回内容已在该文档开头标注。涉及总体架构时，以用户本四项决定、`THINK.md`、`架构.md`、`MEMORY_SCHEMA.md` 及后续明确讨论为准，不能只因文件更新较晚就覆盖用户新决定。

这四项决定不改变 Event / Episode / Outcome / Experience 的写权限边界，也不把比赛提示卡直接升级为 Experience。

## 用户新增确认：Campaign 层与观察界面（当前有效）

用户已确认 Campaign 实现采用以下决策：

1. **第一执行环境使用 macOS workspace。** 当前任务均在用户明确授权和监督下执行。workspace 不是 OS sandbox；Manifest 必须记录 workspace、目标、能力、网络策略和监督模式，Broker 仍是唯一 Aegis 动作入口。
2. **动态任务扩展是核心能力。** Campaign 不限制为静态任务列表。Worker 可以提出受限的子任务、后续任务和阶段任务；Aegis 只能在 Manifest 规定的目标、任务类型、能力、Oracle、深度、扇出、任务数量和预算范围内自动接纳。需要新增目标、权限、适配器、网络、凭据或预算的提案必须阻塞并显示给人类，不能自动授权。
3. **Session 由 Host/Scheduler 在安全 idle/settled 边界自动轮换。** 模型只能提出建议，Observer 只记录，Session 生命周期由 Host 管理。轮换不创建新的独立 Episode，不重置任务预算。
4. **结果权威顺序固定为：确定性 Oracle/有证据的平台结果 > 有证据的人类独立确认 > unknown。** 模型自述、Pi 退出码、工具 transport 成功均不能单独成为任务成功。
5. **Aegis 不自动调用 gpt-6.1-sol。** Aegis 生成确定性的 Campaign report、acceptance bundle 和验收提示词；用户在编码和测试完成后把数据带回当前会话，由外部验收流程分析。
6. **白板和任务分发可视化是观察手段。** Aegis 提供本地只读 Web UI，并提供 Pi 内置命令查看白板、任务队列和任务分发。UI 不是真相源、不授予权限、不绕过审计；控制操作仍走类型化 Aegis 命令。
7. **第一版保持单活动 Task/Episode。** 允许动态扩展队列，但不允许并行共享 mutable Episode 或多 Worker 同时修改同一 Campaign 状态。

这些决定覆盖 `docs/CAMPAIGN_ARCHITECTURE.md` 和
`docs/CAMPAIGN_IMPLEMENTATION_TASK.md` 中相应的待决建议。它们不改变
Event / Episode / Outcome / Experience 的写权限边界，也不允许模型直接
修改授权、Oracle、RuntimeState 或 active Experience。

## 用户确认的可执行契约原则

沿用 `THINK.md` §9.1 的 Recognition / Procedure / Verification，不新增另一套架构概念：

- Recognition：什么情况下能用，检查当前条件与 scope。
- Procedure：具体怎么做，复用已有工具或步骤并绑定参数。
- Verification：怎样确认有效，依据实际结果检查后置条件。

LLM 提出待验证信息或候选关系；Aegis 获取与验证信息，结果进入图板再返回 LLM，不能把新候选直接作为 hint 回灌。规范规则沿用 when / do / expect / scope 和证据门；匹配后复用，条件未知先检查，结果异常退出捷径并返回 LLM 分析。人类 hint 保留最高任务引导优先级与独立来源。

执行目标由人类给 Aegis，默认工作目录，可明确指定比赛远端；auto / 普通模式控制默认路径、网络和工具授权。授权允许执行不等于证据验证通过，也不赋予候选直接 active 的权限。

### 用户确认：数据有用性的阶段标准

信息获取动作的整体目标是取得有用数据。统一区分三个阶段：

1. 获得：记录数据、来源、目标及可靠性判定；使用过的数据不因此自动成为真值。
2. 使用：关联后续实际使用它的判断或动作；仅进入上下文、被阅读或由 LLM 自述有帮助，不算已确认贡献。
3. 推进：数据支持明确的下一阶段目标，且阶段结果被验证，即可记录为“有用”；不必等待整道题成功。

例如确认程序为 ELF64，后续据此采用 64 位解析/打包，并验证脚本正确解析了泄漏地址，可记录为一次阶段贡献。不能判断采用或贡献时保留 unknown。关联数据引用、使用动作与阶段 Outcome，保留后续否定、更正与反例；阶段有用不等于已证明普遍因果关系，也不能绕过 Experience 晋升门。

## 1. 目标与已定契约

目标不是让 LLM 记住更多文字，而是：**验证过的经验能减少下一次的探索成本，且不适用时能退出捷径**。

| 已定部分 | 来源 | 工程含义 |
| --- | --- | --- |
| Pi 为底座；Aegis 控制证据与行动边界 | THINK §2–4 | 不控制模型内部思考，不另造完整模型调用框架 |
| 本地小模型可运行，短上下文与图板恢复为主设计 | 用户对 RAM / 新会话方案的补充确认 | 不依赖强模型消化长历史；支持频繁新对话，由 Aegis 持久保存任务进度 |
| Event → Episode → Outcome → Experience | MEMORY_SCHEMA §1、兼容表 | 不再并行维护 Claim/Verdict/Rule 的另一套持久模型 |
| 声明不等于事实；transport 不等于结果 | MEMORY_SCHEMA §3、5；ROM | Observer 不替 Oracle 判定，unknown 不计为失败 |
| 原始事件追加；派生物保留来源 | MEMORY_SCHEMA §1、10 | 黑板是协调投影，事件是审计源，Oracle 是判定权威 |
| 经验是 when / do / expect / scope | MEMORY_SCHEMA §6 | 长期经验不是 transcript 摘要，也不是任意脚本 |
| 晋升由 Compiler/Oracle 门控 | MEMORY_SCHEMA §6.3 | 至少两次独立验证、可回放、条件确认、无未决冲突；默认需当前环境验证 |
| LLM 不能直接修改 RuntimeState | THINK §9.4 回答 | LLM 提交 Claim 和 Action，可信 Runtime 归并状态 |
| 所有副作用动作必须经过 Aegis；故障 fail-closed | THINK §9.1、9.3 回答 | 经验可被停用，但授权、审计和执行边界不能一起被绕过 |
| 重试按动作性质决定；不确定时先查状态 | THINK §9.3 回答 | 幂等键本身不证明操作幂等，非幂等动作不能盲目重放 |
| direct / habit / hint / deliberate | THINK §9.1 回答 | 分级复用已有路径，异常后退出，而非反复重写实现 |
| 成长必须通过行为对照实验验证 | MEMORY_SCHEMA §8；9-28类人的概念 | 记录增加、候选经验增加均不能单独证明学习 |

现阶段不做权重训练、多模型投票、复杂向量库、任意经验组合或多 Worker 平台。
`框架.md` 中的文献与数字是设计依据，不是本系统已有的性能或概率保证；引用的适用前提仍需核实。

## 2. 必须修正的实现假设

这些是对已有目标的实现修正建议，不否定目标本身。

1. **workspace 不等于 sandbox。** `cwd` 和配置目录隔离不限制 OS 权限。
   工作区里的脚本也能读取凭据、发网络请求或启动外部进程。Git 不能回滚这些影响。
2. **Git 用于恢复文件，不用于授权。** 建议按一个有意义的变更组做 checkpoint，
   不要求每个 read/tool call 都 commit；既有未提交文件与不受 Git 跟踪的数据必须单独保护。
3. **短会话轮换与请求级 RAM 投影互补，不相互替代。** 用户目标是本地小模型也能运行，
   因此以图板保存进度、频繁开启短对话为主设计；`context` 只负责短会话内的信息选择和刷新。
   重开会话不会自动降低总成本，JSON 比 Markdown 更省 token 也不是先验结论，都应测量。
4. **经验优先是执行策略，不是模型参数优先级。** Aegis 可选工具、绑定动作、拒绝调用；
   不能保证 Prompt 中的一条文本压过模型参数。授权与当前验证事实始终优先于经验。
5. **日志故障不是方法失败。** 给 RAM 的提示应是“审计不可用，暂停副作用，待恢复”，
   不能把 fail-closed 编译成“这条方法尽量少用”。

## 3. 推荐系统形状

**一个 Aegis Runtime、一个事件写入者、一个动作入口。** 模块先作为同一 TypeScript 程序的库，
不是六个独立服务；只有不可信工具执行环境需要明确隔离。

```text
用户 / 上级调度器：目标、授权、预算
                     │
               Aegis Runtime
             ┌───────┼────────┐
             │       │        │
       RuntimeState Router  Context Projector
             │       │        │
             │       └──┐     └──> Pi SDK / LLM
             │          │               │
             │     Skill Executor <── Action / Claim
             │          │
             └──> Action Broker / Guard
                        │
                 Execution Adapter
                        │
                 隔离执行环境
                        │
                 Oracle → Outcome
                        │
             Event Log → Compiler → Experience
```

- **RuntimeState**：事件投影，维护目标、生命周期、当前事实与待执行动作。
- **Router**：召回规则并作结构化适用性检查；不执行 shell，不写验证事实。
- **Context Projector**：生成本轮最小 RAM；外部内容始终标为数据或 Claim。
- **Action Broker**：归一化参数、重新校验、检查授权与状态版本、写执行记录、调用执行适配器。
- **Skill Executor**：绑定参数、按序调用 Broker、检查前后条件；没有第二条执行通道。
- **Oracle / Compiler**：分别负责结果判定与经验版本/状态变化，接口分离，不要求独立模型或进程。

经验关闭时，普通探索仍通过 Broker；否则对照实验会同时改变安全和执行机制。
LLM 无经验也可在授权和预算内探索，不要求所有动作都先有 active Experience。

### Pi 集成：先 SDK 与扩展，不先深 fork

推荐由 Aegis Host 通过 `createAgentSession()` 管理 Pi；适配层负责 hooks、tools 和显示，
核心不 import Pi 内部对象。当前 `run-pi.sh` 保留为已有 Observer 原型入口。

| Pi 接口 | 推荐职责 |
| --- | --- |
| SDK `createAgentSession()`、显式 ResourceLoader | 受控初始化、工具/扩展 allowlist、配置与 session 位置 |
| Host 管理短会话；SDK 新建 Session 或 Runtime `newSession()` | 从已提交图板检查点构造新上下文；安全边界完成后轮换，重新绑定订阅与扩展 |
| `before_agent_start` + `systemPromptOptions.sections` | 稳定 ROM、任务开始信息；避免整段替换系统提示 |
| `context` | 请求级 RAM 数据投影，带 state_revision 和引用；不累积重复快照 |
| `registerTool()` | 注册受控动作或 Skill；它们的 execute 都进入 Broker |
| `tool_call` | 模型及嵌套调用的额外检查和审计；不能作为唯一执行保障 |
| `tool_result`、`tool_execution_end` | transport、结构化输出和时长；不是 Outcome |
| `turn_end`、`agent_before_settle` | 验证、停止或有预算的一次继续 |
| `agent_settled` | 通知 Pi 不再自动继续；不在此修改运行或自行宣布任务成功 |
| `user_bash` | 若提供 CLI 的 ! / !!，同样送入隔离执行适配器或明确禁用 |

注意：`setActiveTools()` 只控制模型声明，不是完整的权限边界；`codemode/deferred` 工具
即使不 active 仍可能被嵌套调用。禁止未审查扩展、自动加载任意工具或直接 `pi.exec()` 绕过 Broker。
新版 `tool_call` 可变更参数且变更后不自动重验；真正执行的包装层必须再次验证最终参数。

`direct` 在 Host 中先走 Router → Skill → Broker → Oracle，不启动模型规划；
成功后直接形成用户结果。如需展示到 Pi，再走受控显示接口，而不是制造一次 LLM 调用。
Host 执行同样产生完整 Aegis Event；不能假定 Pi 会替它发工具事件。

Pi 的 `Skill` 通常是按需读取的 `SKILL.md` 指令包，**不是 Aegis 的受控可执行 Skill**。
代码中建议使用 `ExecutableSkill` 区分；不通过一份 Markdown 获得执行权限。

### 短会话主线：图板持久，Pi 上下文可替换

用户明确补充：要让本地小模型也能使用，不能依靠强模型强行处理越来越长的上下文。
采用参考 Cairn 的“外部进度图板 + 短工作窗口”；这里描述的是 Aegis 的目标方案，
不声称已经核验 Cairn 上游的具体会话调度实现。

```text
图板 / RuntimeState 的已提交版本
  → 构造有界 RAM 包
  → 新 Pi 会话处理一个小目标
  → Action / Claim → Broker / Oracle → 追加事件
  → 更新图板检查点
  → 关闭旧工作窗口，从新检查点开启下一窗口
```

图板不是另一套记忆源：它是事件投影，组织目标、事实、假设、待办、依赖和证据引用。
模型负责局部判断；调度、状态保留、参数检查与动作验证尽量由 Runtime、已有工具和 Oracle 完成。
新会话不等于系统忘记历史，也不要求重启整个 Pi 进程、模型服务或重新加载模型权重。

**上下文预算。** 每次请求都应计算总输入，而非只限制 RAM 文件长度：
ROM + 工具定义 + 有界 RAM + 本窗口近期消息/工具结果 + 预留输出 ≤ 配置的工作预算。
工作预算由目标模型、量化、tokenizer 与推理后端实测确定，不把模型标称最大窗口当作有效工作窗口。
初始实验可比较 4k / 8k token 的总工作预算，但这些是实验参数，不是特定 Qwen 型号的能力结论。

**新窗口 RAM 至少包含：**

- 用户目标、验收条件、关键约束与授权摘要，不能只剩当前子任务；
- episode_id、state_revision、当前子目标和完成/未完成状态；
- 当前所需的验证事实及版本/证据引用；待验证 Claim 明确分开；
- 会影响下一步的失败原因、未知状态、禁止盲重试的动作；
- 相关文件、产物、工具与 active Experience 引用及 revision；
- 下一步建议或有限待办，明确它是计划而不是事实。

按当前目标取图的有限邻域，不传整张图或全文轨迹；关键状态机械投影，原始输出留 Artifact，
需要细节时通过有范围和预算的工具读取。可选模型摘要只能作为 Claim，不能成为恢复唯一依据。
预算装不下必需约束时，应缩小子任务或停下来报告，不静默丢掉约束。

**轮换条件。** 建议在子目标完成、验证结束、上下文将触预算或路径需要切换时新建会话。
不是每个工具调用都重开：一次“读文件 → 修改 → 验证”可以保留在同一短窗口。
先请求受控停止并等待工具结束、事件持久化、状态一致，再轮换；不在副作用动作中途硬切换。
不确定动作必须进入恢复状态，不能在新窗口被当作未执行而重新发出。

**Episode 与 Session 分离。** 一个有界尝试可包含多个短 Pi Session；轮换不关闭目标、
不重置总预算，也不增加独立证据次数。当前 Observer 在 `before_agent_start` 创建 Episode、
在 `session_shutdown` 关闭它；未来需要改由 Host 管理 Episode，并记录窗口与会话关联，
否则会把会话次数误计为独立尝试。关联事件/字段须先补充契约，不能擅自修改 schema 1.0。
新窗口使用真正的新上下文，不用继承整条历史的 fork/clone 伪装为清空。

`context` 钩子在一个短窗口内更新本轮 RAM，但不会仅因追加新 RAM 就清除旧历史。
不随意截断尚未配对的 tool call/result；如需局部裁剪，应保留完整的请求协议关系。
切换后的订阅、扩展实例与配置由 Host 重新绑定，RuntimeState 与授权不放在这些易丢失的实例里。

**验证方法。** 固定同一本地模型、任务族、工具与总预算，比较长会话、短会话+图板、
短会话但缺交接信息的消融组；报告成功率、上下文峰值、累计 token、模型延迟、
重复探索和交接丢失率。只有实测才能确认短会话的收益，不能直接承诺消除降智或省 token。

## 4. THINK §9 的推荐答案

### 9.1 控制权与执行边界

保留“统一入口、可授权越界、故障 fail-closed”。先在执行前约束，再由 OS/container 边界兜底，
Oracle 执行后验证。隔离环境限制可触达资源，不因经验命中而放宽。
观察工具也有读取范围、敏感信息与成本限制；“只读”注解是提示，不是证明。

### 9.2 Action、Capability 与竞态

建议区分两层授权：

- **AuthorizationGrant**：可复用授权租约，绑定 episode、工具、目标、权限、有效期、调用限额。
- **ExecutionPermit**：每个副作用动作的内部执行凭据，绑定 action_id、最终参数 digest、
  相关资源 revision、授权版本；短期有效、使用后失效。可先用内部不可伪造的对象引用，不先建签名系统。

这样保留可复用授权，同时避免一次批准被换参数后无限复用。暂将“沉淀时间”解释为待定义的有效期，
不自行猜测它的具体时长。

最小 Action：`action_id / episode_id / operation / arguments / expected_resource_revision / authorization_ref`；
经验命中时附 experience_id + revision；可重试动作附 idempotency_key。多 Worker 字段暂不要求。

执行顺序：`normalize → validate → observe relevant state → authorize → persist intent → execute → verify`。
状态版本变化时，**执行前**可以重新观测并检查一次；**执行后**的不确定不得自动再执行。
外部世界通常不能被本地锁原子保护，适配器应使用条件写入/事务；不支持时显式保留竞态与 unknown。
`toBrDetermined` 映射为现有 Outcome `unknown`，无需再增加同义状态。

### 9.3 多会话与恢复

同意队列与互斥的目标，但建议 **Runtime 单写，不是 LLM 持有写锁**。
Worker 提交请求入队，Reducer 顺序更新；只在相关资源的动作阶段持锁，不跨模型等待持锁。
先单 Worker；后续并行研究使用独立 Episode/worktree，再提交结果与引用。

崩溃恢复沿用 THINK 已写的规则。写入 intent 并确认持久化后才允许副作用；日志错误向上返回，
不吞掉错误继续执行。已经发出的不确定动作由 Oracle 查真实状态，不能声称“exactly once”。

### 9.4 RuntimeState、RAM 与长期对象

沿用已定写权限。RAM 是 RuntimeState 的有限投影，不是第二个可写数据库。当前 v4 把 RAM 组织为按本轮子目标选择的工作集寄存器：task/子目标、rules、facts、claims、references、recent/referenced、pending；总目标始终在场，claims 只取当前 scope，知识卡可多张但受 8,000 字符预算限制。`text` 与 `data` 同源，sections 只保留兼容统计，完整历史仍在 Board/EventLog。
共享板、终端 UI、JSON RAM 都读同一状态版本；长期进度不依赖某个 Pi 会话存活。
采用上一节的短窗口与交接包设计，模型无须通过完整历史恢复当前任务。

建议分开：事实投影、Experience、用户偏好、Authorization。偏好可以帮助排序，不能授予权限；
经验说明是非执行元数据；假设保存为 Claim。无需因此立刻增加四套存储服务。
每条当前事实绑定对象身份、来源、观测时点与资源版本；事实过期不等于历史记录变假。

### 9.5 Experience 生命周期、执行结构与冲突

现有 schema 已定义生命周期与门槛，**不用再从零回答**。
候选可由提案产生；只有通过证据门槛才能 active。重复跑同一投影、复制 ID、换 independence_group
名称不产生独立证据；计数必须通过事件、环境重置与 Outcome 去重检查。

内容修正产生新 revision，旧版继续支持历史回放；状态迁移也写事件，不覆盖来源。
开始只支持有限谓词（如 eq / neq / exists）和注册动作 ID；禁止从经验文本 eval shell/JS。
需要脚本时，引用审查过的注册实现、版本和 digest。LLM 可以提案新实现，但不能自我晋升。

冲突排序先排除未授权或与当前事实不符者，再比较 scope 与证据。
无法消解时退到 hint/deliberate，列出差异并补观测，不用多数票或“更自信”决定执行。

### 9.6 Scope、快照与有效期

区分 **适用性** 与 **失效**：不匹配新目标是本次拒绝使用，不是证伪旧目标上的规则。
原绑定环境发生变化则暂停该绑定的使用并重验；确认条件下出现反例才影响经验版本状态。
这是对 schema 的运行时绑定细化建议，不允许当前代码擅自更改生命周期语义。

规则声明它依赖的版本、目标类型、参数范围、权限和用户/项目边界；未知字段不能当通配符。
默认精确匹配，范围匹配只能由注册谓词声明。

完整 repository commit、Pi build_id 等记录到回放元数据；是否成为匹配条件由实际依赖决定。
不要把所有时间戳和整仓哈希塞进唯一 fingerprint，否则无关文件变化也会让所有经验失效。
快照采集在 Episode 开始及副作用动作前后；动作只检查相关资源，不每次重扫全世界。

### 9.7 延迟验证与多维结果

不新增 Outcome `pending`：未判定先保存 `unknown`，另有 Runtime 的待验证队列；
迟到判定追加新 Outcome 并 `supersedes`，不修改原记录。待验证结果不支持晋升。

任务、安全、质量可复用同一 Outcome 类型，以不同 criterion 区分；成本是测量值，不是成功真假。
晋升必须满足声明的任务与强制安全标准。任务成功但越权，不能作为正向激活证据。
这需要实现多 criterion 投影时另行补充 schema 契约，不直接改现有 fixture 的字段含义。

### 9.8 因果归因与实验

记录 considered / matched / rejected / selected / skill_started / completed，以及规则 revision 和原因。
“selected”仅证明被选中过，不证明贡献。新增 event_type 需显式版本化。

保留 MEMORY_SCHEMA 的 A/B/C/D（无经验/原始经历/active经验/错误经验）；
在 C 内再比较 hint/habit/direct，避免把两个四组实验混为一套。
对相同任务分布、预算和工具环境做对照，包含参数变形、环境变化与相似但不适用样本。
主要指标：成功率、首次成功时间、模型 token、工具调用、误激活、负迁移、恢复时间。
两次验证是工程门槛，不是统计可靠性保证；收益是部署评估，不能替代证据与安全门槛。

### 9.9 可信度、注入与 Provenance

外部文本是数据或 Claim，不从文字内容获得权限。Provenance 表示来源；
可信等级由导入/验证策略另判，不能因为来源字段“像官方”就升级成事实。

写入检查：schema、引用可解析、digest、去重、Oracle 证据、scope、授权与敏感内容扫描。
候选不满足证据门槛可保留，但不能 active；经验不能覆盖授权、Guard 和 ROM 所表达的硬规则。
普通 hash chain 只能发现部分篡改，不证明内容真实；对审计文件的写权限仍必须隔离。

### 9.10 可回放、审计与隐私

区分：**事件投影重建 / 动作状态回放 / 原样重现 LLM 输出**。
前两者可做工程保证；即使记下模型 ID 与 Prompt，也通常不能保证第三者。

记录 Pi commit/build、模型来源与版本（不可得时标 unknown）、ROM/RAM/工具定义摘要、
执行/Oracle 适配器版本、环境初始状态、动作参数、证据 artifact 与 digest。
缺关键动作环境时只能审计，不能冒充 replayable。

一个安装内由 Runtime 单写日志；先独立运行目录，不让多进程 append 同一全局 hash chain。
重放必须包含完整判定与编译输入，不能只写 Outcome ID 后依赖旁边 JSON 才能重建。
当前原型的浅事件不应被当成已满足这个要求。

沿用原始证据保留原则；遗忘先作用于检索投影。凭据不进入事件，Artifact 应最小化、脱敏、限权。
永久保留所有隐私数据不是默认结论；保留期限、删除与可审计性冲突需用户制定政策后另行设计。
迁移生成新投影，不改写旧事件；未知 major version 拒绝而不是猜字段。

### 9.11 停止、探索与防止不行动

普通低风险探索在授权内可执行，不等待成熟经验。direct 命中只做决定性条件与快速 Oracle。
出现异常退出捷径，unknown 不是自动暂停整个平台的理由。

建议首个实验默认：同一无进展状态最多两次补观测；同状态同参数的非幂等动作不自动重试；
自动继续最多两次。每个 Episode 明确时间/token/工具预算，这些数字可调整且记录到 manifest，
不是所有领域的永久上限。

日志不可用、越权、不可逆动作结果不明、预算耗尽或关键冲突不可消解时停止/请求人工。
状态变化可重新评估；无新增信息不重复反思，也不把无限重采样包装成“探索”。

### 9.12 最终命名

沿用四对象契约及已有兼容表：Claim 是 Event 中的候选声明；Verdict=Outcome；
Rule=Experience；Policy 是运行时投影。Action、WorldSnapshot 和授权是控制数据，
不是再引入一套与长期记忆竞争的六层模型。

## 5. 实施顺序与验收

| 阶段 | 必须完成 | 验收行为 |
| --- | --- | --- |
| 0 Pi 兼容基线 | 固定上游 commit、安装/构建、Observer 与 SDK 接口 smoke | 不调用模型可验证 hooks、嵌套动作、结束边界与目录隔离 |
| 1 最小执行契约 | 单写日志、RuntimeState、Broker、一个隔离适配器、可信初始状态、有界 RAM 交接包 | 工作区外修改被拒；日志不可写时副作用不发生；换会话不丢关键状态；重放得到同一投影 |
| 2 一条可执行经验 | 开锁 fixture 的共用 live/replay 动作与 Oracle、Compiler gate、一个 ExecutableSkill | 两次独立验证后按契约晋升；路径/参数可绑定，不只是成功计数 |
| 3 真正闭环 | Router、短会话调度、请求级 RAM、habit/direct、异常退出 | 本地模型在有界上下文内运行；轮换不重置总预算；第二次命中不重新生成脚本；不适用样本不误执行；关经验收益消失 |
| 4 再扩大 | 代码修复等第二任务族、必要的检索与并行 | 留出任务改善而非只复现训练 fixture |

`hint` 可以先跑通上下文，但不能代替 direct/habit 的完整验收。
不为第一阶段预写通用工作流 DSL、无限经验组合或跨平台调度器。

## 6. Pi 同步记录与待验证事项

本次仅更新 `Pi_Agent_base/pi/` 源码，未修改其代码、Aegis 实现、配置或实验数据。

- 上游：`https://github.com/earendil-works/pi.git` 的 `main`。
- 旧提交：`6f7551516b84278eb9da1c340c8e7bc66be1a6ba`。
- 新提交：`42a3497d03ad17e308a2299fa824727894f2c0ec`。
- 新版本：package `1.1.0`，描述 `v1.1.0-14-g42a3497d0`；282 个提交，干净工作树快进。
- `/Users/scemac/My_github/pi` 的其他工作树有大量未提交变更，本次没有更新或复制它。
- **依赖尚未安装，bundle 尚未构建，不能声明 Pi 集成验证已通过。**

重要适配点：嵌套调用的 `parentToolCallId`、`tool_execution_end.durationMs`、
`agent_settled.aborted`、`agent_before_settle`，以及 active 与 callable 工具的差别。
当前 Observer 未记录前述全部新增字段，原型 smoke 通过也不等于覆盖了新能力。

经用户同意安装/构建后，可在内嵌 Pi 执行 `npm ci --ignore-scripts` 与 `npm run build:offline`，
再运行 Aegis 的五个 smoke。安装跳过 lifecycle；离线 build 不代表依赖下载离线。
本次不启动真实模型、不读取凭据，不自动修改 lockfile。

Pi `packages/durable/README.md` 提供可恢复任务、事务状态和工具 hook，但明确标为 experimental、
API 可无通知改变。建议作为未来适配候选，不让 Aegis 的现行数据契约绑定它的内部状态结构。

## 7. 用户现在只需确认的三项

1. 是否接受 **SDK/扩展 + 独立核心** 为主线，暂不深 fork、不迁移到 pi-durable？
2. 首个受控执行环境是否选 **Linux 容器**（适合当前 fixture 与后续 CTF）？
   若必须直接操作 macOS 项目文件，需要另选可验证的执行边界，而非把 cwd 当沙箱。
3. 是否接受 §2 的实现修正，以及“可复用授权租约 + 每动作凭据”？

余下 §9 的问题已有推荐默认；确认后按实现阶段逐项转为正式契约，而不是要求用户一次完成全部答案。
