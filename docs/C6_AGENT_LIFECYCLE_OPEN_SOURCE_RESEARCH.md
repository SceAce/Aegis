# Agent 请求生命周期：Pi、Codex、DeepSeek Harness 源码调研

调研日期：2026-10-14。用途：为 Aegis C6 的有限收敛提供已有实现依据，指导真实任务 pilot 前的修复与验证。

## 1. 结论与范围

模型流失败、取消、工具副作用与重启恢复是通用 Agent 问题。三个项目提供了可复用的处理方式，但会话恢复、已知 token 统计与 Aegis 的 Task/Campaign 双层预算责任不是同一种保证。

Aegis 应沿用 Pi 已有的终止语义，参考 DeepSeek Harness 的执行前持久化检查点和未知结果恢复方式。Codex 的统一取消、使用量恢复也有参考价值；它允许部分会话保存失败告警后继续，这个策略不能直接用于 Aegis 的权威预算事件。

当前两个阻塞问题主要在 Aegis 的接线与状态重建：SDK 已明确区分 aborted/error；原任务书也已经要求恢复时预算责任守恒。无需先重写整个 Agent 框架。需要把每侧预算责任、请求联合结清、规划结束结果三个事实分别保存和推导。

本轮读取官方仓库源码、文档和测试断言，未运行第三方测试或真实 provider，未修改 Aegis 产品实现。这里的第三方测试描述表示仓库中存在这些断言，不表示本轮独立运行通过。

## 2. 固定版本

| 项目 | 官方仓库 | 本轮源码版本 |
| --- | --- | --- |
| Pi | [earendil-works/pi](https://github.com/earendil-works/pi) | `3daa20280f6a7c7cbe0935680c9a38fdc3863005` |
| Codex | [openai/codex](https://github.com/openai/codex) | `cf0ed4c600161fcaa18eeac02b5fc715e1076955` |
| DeepSeek Harness | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | `d743267388641bc76f17c45ce8b4c231aed1d32c`，`0.2.1-alpha.2` |

以下链接固定到对应 commit，避免后续默认分支变更导致证据漂移。结论适用于所读版本和路径，不代表所有版本、所有插件组合均有相同保证。

## 3. 需要分别讨论的生命周期

一次模型请求是一次实际 provider 调用，从准入、dispatch、流式结果到结束或异常。一次规划过程可以包含多个模型请求和工具调用；某次请求已经记账，不代表整个规划正常完成。工具调用又有独立的开始、可能发生副作用、结果记录与恢复边界。

本地进程不能仅凭断流确定远端是否处理请求或收取费用，也不能凭缺失工具结果判断副作用没有发生。这些框架通过明确的错误/中止结果、已有日志和保守恢复处理不确定性；所读路径未提供任意远端操作“恰好执行一次”的通用保证。

| 问题 | Pi | Codex | DeepSeek Harness |
| --- | --- | --- | --- |
| error/aborted 的结束语义 | 显式识别两者，结束循环并跳过该响应的工具 | 取消为 TurnAborted；缺 response.completed 的 EOF 为 stream error | 正常消息与失败 attempt 分开，turn 保留 aborted/error/interrupted |
| 工具 dispatch | 该响应正常返回后检查 tool calls；失败响应不执行 | OutputItemDone 可调度工具，无需等整个响应 completed | 记录 tool/call；默认组合在顶层工具执行前 flush，之后再检查取消 |
| 持久化 | 会话 JSONL；所读追加路径没有显式 fsync | rollout 队列、flush、重试；部分上层 flush 失败告警后继续 | append 与 durability barrier 明确分开；默认检查点在调用前等待 flush |
| 重启 | 恢复会话历史，不等同应用事务恢复 | 恢复历史及已记录 usage；保留中断状态 | 物理尾部修复与语义修复分层，缺工具结果标为未开始或结果未知 |
| 用量/预算 | 消息携带 usage；失败合成消息可为 zero usage | 持久化 TokenCount/TokenUsageRecord；另有共享 rollout token budget | usage 从 message/attempt 投影；同 attempt 替换样本，retry 分别累加 |
| Aegis 双层预算恢复 | 不提供现成替代 | 所读本地控制器不是 Task/Campaign reservation 联合恢复账本 | token 投影不是 Task/Campaign reservation 联合恢复账本 |

## 4. Pi：终止语义可以直接沿用

### 4.1 message_end、agent_end 和 prompt 返回不能单独表示成功

[agent-loop.ts:245](https://github.com/earendil-works/pi/blob/3daa20280f6a7c7cbe0935680c9a38fdc3863005/packages/agent/src/agent-loop.ts#L245) 在 assistant 的 stopReason 为 error 或 aborted 时执行 finishTurn、发出 turn_end/agent_end，然后直接 return。即使 finishTurn 请求继续，也不能解除这条硬退出规则。

[agent.ts:507](https://github.com/earendil-works/pi/blob/3daa20280f6a7c7cbe0935680c9a38fdc3863005/packages/agent/src/agent.ts#L507) 为运行建立 AbortController，并通过 try/catch/finally 收尾。异常可被转换成 assistant 消息，继续产生 message_end/turn_end/agent_end。因此不能把“prompt 没有抛错”或“收到了 message_end”当成正常成功。

[agent.ts:561](https://github.com/earendil-works/pi/blob/3daa20280f6a7c7cbe0935680c9a38fdc3863005/packages/agent/src/agent.ts#L561) 明确说明 agent_end 只表示循环不再发事件；等待监听器完成并清理运行状态后才算 idle。

异常合成消息使用 EMPTY_USAGE。这是 SDK 没有可报告 usage 的表现，不能证明远端未处理或未收费。取消也不能撤销之前已经执行的工具。

### 4.2 会话记录与重试的保证边界

[agent-session.ts:1148](https://github.com/earendil-works/pi/blob/3daa20280f6a7c7cbe0935680c9a38fdc3863005/packages/coding-agent/src/core/agent-session.ts#L1148) 将 message_end 消息追加到会话。[session-manager.ts:1172](https://github.com/earendil-works/pi/blob/3daa20280f6a7c7cbe0935680c9a38fdc3863005/packages/coding-agent/src/core/session-manager.ts#L1172) 使用同步 JSONL 写入；所读路径没有显式 fsync，不能作为严格预算事务日志保证。

[agent-session.ts:3792](https://github.com/earendil-works/pi/blob/3daa20280f6a7c7cbe0935680c9a38fdc3863005/packages/coding-agent/src/core/agent-session.ts#L3792) 对可重试错误使用配置的 maxRetries 和可取消退避，保留失败尝试的原始历史、从后续模型上下文中省略该失败尝试。重试是另一次调用，不能在 Aegis 预算中消失。

### 4.3 与当前 Aegis 的关系

Aegis 内嵌 Pi 基线为 `42a3497d03ad17e308a2299fa824727894f2c0ec`。本轮对比发现其 agent-loop.ts 与调研版本相同；当前 aborted 问题不能归因于 Pi 版本过旧。

Aegis 当前在 c6-model-worker.mjs 中把 `stopReason === "error" ? "error" : "ok"` 当作 provider 状态；aborted 因而落入 ok。Pi 已结束循环，但 Aegis 仍可执行前一请求留下的 decision buffer。这是应用接线丢失终止信息。

## 5. Codex：统一取消，保留已观测使用量，部分日志故障允许继续

### 5.1 取消与缺失终止事件

[session/turn.rs:2679](https://github.com/openai/codex/blob/cf0ed4c600161fcaa18eeac02b5fc715e1076955/codex-rs/core/src/session/turn.rs#L2679) 在读取流时处理取消；ordinary stream events 在取消后不继续触发工具。对于已经收到的 ResponseIncomplete，先保留其可得 usage。流关闭但没有 response.completed，返回 stream error。

[tasks/mod.rs:832](https://github.com/openai/codex/blob/cf0ed4c600161fcaa18eeac02b5fc715e1076955/codex-rs/core/src/tasks/mod.rs#L832) 区分 Completed、Failed、Interrupted。TurnComplete 本身也可携带 error；结束事件的名字不能代替结果检查。

Codex [session/turn.rs:2843](https://github.com/openai/codex/blob/cf0ed4c600161fcaa18eeac02b5fc715e1076955/codex-rs/core/src/session/turn.rs#L2843) 在 OutputItemDone 时可调度 tool future。它没有把所有工具都延后到完整模型响应联合结清之后。Aegis 的 Worker→Broker 门槛是应用自己的执行许可，不能从 Codex 的流式工具调度直接推出。

### 5.2 usage 恢复与预算控制

[session/mod.rs:5022](https://github.com/openai/codex/blob/cf0ed4c600161fcaa18eeac02b5fc715e1076955/codex-rs/core/src/session/mod.rs#L5022) 为已观测 response usage 记录 response/thread/turn 身份及累计值。恢复时 [session/mod.rs:1707](https://github.com/openai/codex/blob/cf0ed4c600161fcaa18eeac02b5fc715e1076955/codex-rs/core/src/session/mod.rs#L1707) 从 rollout 恢复 token 信息和最后一条 TokenUsageRecord。

[rollout_budget.rs:18](https://github.com/openai/codex/blob/cf0ed4c600161fcaa18eeac02b5fc715e1076955/codex-rs/core/src/rollout_budget.rs#L18) 还有根 thread 会话树共享的预算控制器，按后端 budget units 或加权 token 使用量累计。[agent/control/budget.rs:12](https://github.com/openai/codex/blob/cf0ed4c600161fcaa18eeac02b5fc715e1076955/codex-rs/core/src/agent/control/budget.rs#L12) 在耗尽时返回 SessionBudgetExceeded。

因此不能说 Codex 只有上下文窗口控制、没有使用预算。但所读本地实现以 Mutex 中的使用量累计为核心，并不提供 Aegis 所要求的两侧 reservation、失败结算关联与重启责任守恒的现成契约。

### 5.3 持久化策略不能照搬

rollout recorder 保留待写项、尝试重新打开和写入；[recorder.rs:1908](https://github.com/openai/codex/blob/cf0ed4c600161fcaa18eeac02b5fc715e1076955/codex-rs/rollout/src/recorder.rs#L1908) 的所读写入路径使用 file.flush，不能把这个调用名等同于 fsync 或 billing durability。

[tasks/mod.rs:396](https://github.com/openai/codex/blob/cf0ed4c600161fcaa18eeac02b5fc715e1076955/codex-rs/core/src/tasks/mod.rs#L396) 在部分会话 flush 失败时发送 Warning，随后仍继续完成 task 的收尾。该策略适用于它的会话保存目标；Aegis 权威请求事件缺失会影响预算和后续 dispatch，必须遵守已有的停止规则。

## 6. DeepSeek Harness：执行检查点与未知结果恢复最值得借鉴

### 6.1 append 与确认持久化分开

[session-persistence/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/session/session-persistence/README.md) 明确区分：append 表示批次已接受、顺序成立、当前实例可读；完成 flush 才提供 crash durability barrier。后台写入失败保留事件并暂停自动路径，下次显式 flush 重试并报告错误。

[session-checkpoint-policy/src/index.ts:29](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/session/session-checkpoint-policy/src/index.ts#L29) 在构造下游模型流之前等待 session flush；[同文件:69](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/session/session-checkpoint-policy/src/index.ts#L69) 在顶层工具 body 执行前等待 flush，之后再次检查取消。flush 失败则下游不 dispatch。

这是一个插件政策，默认 base composition 在 [cordis.patch.yml:414](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/bundle/base/cordis.patch.yml#L414) 装载它；不能推广成任何自定义 composition 都自动具备。无 live session 的模型调用、嵌套工具调用有明确旁路边界。

JSONL backend 的 [index.ts:1330](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/session/session-persistence-jsonl/src/index.ts#L1330) 实际执行 writeFile 和 handle.sync，追加/同步失败时尝试截断回之前大小，避免重试产生重复序号。这比仅凭 flush 的名字判断保证更具体。

### 6.2 正常消息、失败尝试与取消分别结算

[agent.ts:451](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/agent.ts#L451) 在失败/取消时记录 assistant/attempt，或保留可见的 interrupted message 和可得 usage；失败记录本身也失败时，AggregateError 保留原始错误及结算错误。

[agent.ts:505](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/agent.ts#L505) 对 error/aborted finish 进入显式 request-error 路径，只有扩展明确返回 retry 才重试。正常消息与失败 attempt 都可承载 usage，但失败记录不会因此变成正常工具执行许可。

[usage-projection.ts:117](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/llm/token-meter/src/usage-projection.ts#L117) 将用量作为 session event 的投影：同 attempt 的后续样本替换旧样本，retry-started 关闭旧 attempt 的替换槽，让新尝试累计。没有 usage 时不增加已知总量，不能据此推出真实费用为零。

[agent-lifecycle.md](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/agent-lifecycle.md) 也明确承认：进程在 settlement 前硬退出，不会留下该 attempt 的完整 durable stream。它没有消除远端未知状态。

### 6.3 重启时修复的是协议与未知事实

[agent-loop/src/index.ts:881](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/index.ts#L881) 先取得写 ownership、读取物理有效日志，再计算 interruptedTurnClosers 并追加到同一日志。ownership 的公开保证是 backend 实例内的单 writer，不能扩张为跨进程分布式锁。

[session/src/repair.ts:14](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/session/src/repair.ts#L14) 分为：

- TOOL_NOT_STARTED：日志没有记录工具开始。
- TOOL_OUTCOME_UNKNOWN：已记录开始，缺失可靠结果。

后一种生成明确的错误结果，提示只读/幂等操作可按语义重试；可能有副作用的操作先验证外部状态，不能盲重试。随后补 step/end 和 turn/end interrupted，使后续模型上下文协议完整。补出的错误结果不是补造成功或自动撤销副作用。

这与 Aegis 的保守 reservation 恢复方向一致，但 DeepSeek Harness 的语义修复本身不负责恢复 Aegis 的双层预算。

## 7. Aegis 的有限落地方案

### 7.1 三个事实独立

| 事实 | 回答的问题 | 当前修复应确保 |
| --- | --- | --- |
| 每侧预算责任 | Task/Campaign 各自已经消费多少、仍需 hold 多少？ | reconciliation 中确认已记账的一侧按身份恢复 consumed；未知侧保留 hold；每侧 consumed+pending 责任不凭空减少 |
| 请求联合结清 | 是否有合法、关联完整的 durable settlement？ | 无合法联合结清时保持 unresolved；不能用 pending=0 推出 unresolved=0 |
| 规划结束结果 | 模型是否正常完成，还是 error/aborted/unknown？ | 沿用 SDK 终止分类；中止或异常不放行 decision buffer，已发生使用量继续保留 |

预算事实允许出现“已消费，但请求未联合结清”，也允许“已结算，但规划中止”。它们都不能被压成一个 ok。

例如两侧内存 commit 成功、durable committed 失败、fallback reconciliation 成功：重启应恢复两侧已知责任，继续标为未决并阻断受影响运行；不能重建成 consumed=0、pending=0、unresolved=0。

第一请求提交 decision、第二请求 aborted：已发生的两次请求仍记账，但 Worker 不返回可执行 decision，Broker 不产生 effect。Pi 的硬退出规则已经成立，Aegis 需要将这个结果传到自己的执行边界。

### 7.2 使用现有权威日志与执行边界

保留 Aegis 的 EventLog、provider gate、Worker→Broker 门槛。参考 DeepSeek Harness 的检查点，确保当前流程在外部调用前已有可恢复的 durable 意图，执行许可基于已等待的结算结果和正常规划结果。

live 与 replay 使用同一事实定义和身份关联；账本、report、measurement 都是投影。已知 consumed 与未知 hold 可有不同内存形态，但重启不能减掉应承担的责任。发生重复 reconciliation 或后续合法 committed 时，按同一请求身份收敛，避免双计。

取消后停止尚未 dispatch 的动作；已经发生的 provider 调用和工具副作用不能依靠取消自动退款或回滚。重试必须服从 Aegis 现有预算和 unknown 阻断契约，不能直接复制交互式工具的重试默认值。

这些是已有边界的实现修复，不要求引入第二条日志、自动退款、人工结算平台、分布式事务或多 Worker 基础设施。

## 8. 从第三方测试中借鉴的验收方式

| 第三方源码中的断言 | 对 Aegis 有用的观测 |
| --- | --- |
| Pi [agent-loop.test.ts:1162](https://github.com/earendil-works/pi/blob/3daa20280f6a7c7cbe0935680c9a38fdc3863005/packages/agent/test/agent-loop.test.ts#L1162)：error/aborted 即使 finishTurn 要求继续仍硬退出 | 不只检查返回类别，检查后续 provider 次数和 Broker effect |
| Codex [command_lifecycle_tests.rs:264](https://github.com/openai/codex/blob/cf0ed4c600161fcaa18eeac02b5fc715e1076955/codex-rs/core/tests/suite/command_lifecycle_tests.rs#L264)：准备命令时取消，不创建目标文件 | 在实际 dispatch 边界检查副作用，不用 mocked success 代替 |
| Codex [session_tests.rs:15](https://github.com/openai/codex/blob/cf0ed4c600161fcaa18eeac02b5fc715e1076955/codex-rs/core/src/state/session_tests.rs#L15)：恢复累计 usage 后继续累计 | 重启前后责任连续，新增调用只增加一次 |
| DeepSeek [session-checkpoint-policy.spec.ts:94](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/session/session-checkpoint-policy/tests/session-checkpoint-policy.spec.ts#L94)：checkpoint reject 时 adapter 不调用 | 持久化失败不仅生成报告，还实际阻断 provider/Broker |
| DeepSeek [cancel.spec.ts:494](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/tests/cancel.spec.ts#L494)：assistant/message observer 取消后工具执行为零，并能继续合法 replay | 已缓冲的动作不能绕过终止状态；协议收尾也要可恢复 |
| DeepSeek [crash-recovery.e2e.ts:91](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/session/session-checkpoint-policy/tests/crash-recovery.e2e.ts#L91)：真实子进程 SIGKILL，检查调用前日志和副作用后的未知结果 | 使用真实 EventLog 和硬重启，不只测手工构造的 reducer 输入 |

Aegis 已有上述关键方向的独立用例，见 [C6_EXTERNAL_REVIEW.md §7](C6_EXTERNAL_REVIEW.md#7-93d4617-架构组合复验两组核心不变量未闭合) 和 `aegis-c6-architecture-review.mjs`。优先修成 green，并用有限 mutation 证明“清空责任”和“aborted 放行”会被捕获；不需要因为这次调研继续追加无限测试清单。

## 9. 真实任务 pilot 的出口

本轮调研没有修复或重新验证产品，不能据此把 changes_required 改为通过。当前仍以独立审查的两组实际反例为阻塞：预算责任/未决状态丢失，以及 aborted 后执行已缓冲决策。

当两组反例消失、正常控制仍有真实 effect 与独立 Oracle 验收、受影响的 required 检查通过后，可以进入有限真实任务 pilot。旧类型诊断、保守 pre-check、精确 token 估算、UI 和后置基础设施保持既有非阻塞结论。

pilot 以既有小范围任务家族、明确预算和停止条件测量真实模型效果及 provider 行为；不把源码调研或工程检查宣称成已经验证真实计费和无人值守生产能力。
