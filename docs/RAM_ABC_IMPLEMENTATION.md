# 结构化 RAM 与通用探索控制实现

当前用户授权：A→B、A→C 完成实现；通用 bash 在任何领域均不得做猜测性业务语义解析。起点 61c0edf。分支 feat/structured-ram-and-exploration-control。

## 冻结接口

A：RAM v3 text 为完整可 JSON.parse 的对象，data 与选择统计同源；4,000 字符预算含完整 JSON、引用表与元信息。保留 task/authorization/pending 核心和显式 overflow，原 buildRam 仍返回文本。Observation/Claim/Fact 不混淆。文本摘要先脱敏，再确定性保留 head/middle/tail 片段与脱敏文本偏移；不猜测 HTTP、SQL、构建、测试或业务成功。原 toolResult 不变；长文本不是完整 Artifact，原内容不可用时不伪造读回接口。

B：aegis_propose 仍是唯一模型假设/Intent 写入接口；source_refs 支持显式 event/node/action 引用。只接受当前 Episode 已提交且有效的引用，拒绝 future/foreign/missing/stale。显示引用不赋予事实权。显式 replace_event_id 只允许修正本 Episode 的模型 proposal，不得修正 Outcome/事实；原提案保持历史。普通助手正文不自动抽取。RAM 选最近观察和被合法提案引用的较早观察；依赖引用表解析完整身份。

C：使用同一日志的 runtime.note/work.* 控制记录，不新建数据库或 Outcome 状态。可信任务契约绑定 task/target/criteria 与可选工具/重复/总调用/时间上限；交互入口从显式 AEGIS_TASK_CONTRACT_FILE 读取并首次冻结到事件，Campaign 从已绑定任务定义取得目标/criteria。模型 aegis_submit_candidate 只提交 {target_ref,criterion_id,evidence_event_ids}，Runtime 解析当前 Episode 的完成动作证据、检查任务契约后记录 waiting_external，绝不自动产出 Outcome。普通 Claim、exit 0、文本内容均不能触发候选等待。仅受信任 human/Host 复核可 reject/resume，保持预算责任。等待时阻止新的探索工具、停止工具自动跟进；允许契约显式登记的最小只读验证，不提供 shell 语义绕过。策略计数只按真实工具/完整参数摘要/显式环境版本，不根据输出文本判定“没有进展”或“爆破”；不声称能识别任意脚本内部行为。

Campaign 的 request/effect/dispatch 和交互 tool gate 分别复用工作控制投影。候选等待不记录虚构 transport failure，不执行 Broker，不自动重跑原 Worker。未配置通用任务契约时不臆造目标/criterion/次数限制；候选工具明确拒绝 unconfigured。已有 E1 请求结清/预算/authority 失败仍独立跟踪，不放宽原门。

## 验证矩阵

- A：长 HTML/一般日志/脚本中后部、转义/脱敏膨胀、大小/offset/JSON/完整身份、false/0、foreign、固定 system/tools/每请求唯一临时 RAM、Session 替换。
- B：显式提案正例；助手正文不入板；future/foreign/stale/missing 引用拒绝；替换只对模型提案；较早被引用工具保留；Fact/goal/authorization 不变。
- C：候选当前身份/证据/criterion 绑定；普通 claim 与成功文本不暂停；重复同内容不二次状态变更；等待阻断工具/效果/调度；human resume/reject；重启与持久失败；未知保留；普通 bash 跨领域同等处理。
- 真实 SDK+faux 与真实 EventLog；不触发真实模型/网络。旧字符串格式断言迁移为 JSON 字段断言，保留其行为预期。

## 实际实现

- A：`memory/ram.mjs` 生成 v3 JSON，包含 state revision、分离的信任类别、完整身份局部 refs、全输出长度与遗漏/核心 overflow。`fragments.mjs` 机械保留脱敏文本 head/middle/tail 和真实偏移。结构摘要保留对象/数组与 false/0，不再因 JSON 转义而退化成 JSON-in-string。片段不保证覆盖任意位置的稀疏信息，不提供虚构的全文读回。
- B：提案引用与替换在当前已提交 prefix 的有效 Board/Campaign authority 上校验；拒绝 missing/foreign/future/stale 和被拒提案的替换。普通助手文本不自动入板。实际 SDK 用例验证原提案→显式替换→候选提交。
- C：新增 `orchestration/work-control.mjs`，Observer、Host/Scheduler、Composite、Broker 消费同一日志工作控制。候选只进入 waiting_external，不产生 Outcome；同批后续工具与已缓冲动作受阻。受信任恢复保留原身份与预算，不重复 synthetic dispatch 收费。未知副作用、请求/工具收费责任未清时拒绝恢复。
- 交互 `/aegis work-verify` 直接调用 SDK 已知 read 实现，校验精确登记参数和 workspace realpath、确认 intent/result 持久化，不发模型请求且保持等待。它不是扩展 tool pipeline 的假装调用；Campaign 没有 producing request 的账本绑定，因此该命令明确 unsupported。
- 新 Campaign 使用原有 Host durable tool charge，候选工具也必须 charge/finish。已有 legacy-only 请求流的执行恢复返回 migration_required 并保留历史消费，status 只读；不改写日志或自行迁移。CLI resume 明确恢复候选等待。Contest pinned tool allowlist 已加入候选工具。
- 跨场景 bash/powershell 不做猜测性语义解析的规则已写入 memory/execution/extensions 的模块 AGENTS.md。

当前接口和使用方式见 [STRUCTURED_RAM_AND_WORK_CONTROL.md](STRUCTURED_RAM_AND_WORK_CONTROL.md)。

## 开发委派与证据

起点 5 个聚焦脚本均 exit 0，证据 `runtime/dev/ram-abc/before/`；初始新 JSON 契约测试在 v2 上 exit 1，证据 `before/abc-red.log`。独立导出的起点源码 required 68/68 通过，类型基线 Campaign189、Batch186。

用户要求后续编码由 GPT-5.5/5.4 子 Agent 完成后，使用现有 Pi 独立子进程委派（未新建管理平台）：A/B、C 与 C 集成收尾三次委派均固定 `xjb/gpt-5.5`，日志 assistant model 字段已核对，未使用 6.0/6.1 子模型。父会话在此前已编写初版，之后负责审查、运行验证和文档；最终报告不把同模型子 Agent 自测称为外部验收。没有调用题目靶机、没有新的真实任务实验；这里的付费模型调用仅为用户明确授权的编码委派。

| 检查 | 实际结果 | 私有证据 |
| --- | --- | --- |
| 原 required 68 | 68/68 exit 0 | `final-results.json`、`final/`；`required-review2/` 另一次 68/68 |
| 最终 85 个显式脚本 | 84 exit 0 / 1 exit 1 | `final-names.json`、`final-results.json`；唯一非零为既有 E1 single-authority |
| E1 single-authority 原反例 | 1 pass / 12 fail，与起点一致 | `baseline-existing-audit/` 与 `final/aegis-e1-single-authority-review/` |
| A/B 新纯契约+边界 | 4/4 + 8/8 node:test | `final/aegis-ram-abc*/`；完整 refs、巨大转义值、当前 prefix、更正/失效/替换 |
| 原 RAM projection | 11/11 | JSON 字段断言替代 Markdown 位置断言，原保真/预算/隔离行为保留 |
| C 纯控制+边界 | 5/5 + 7/7 node:test | 同一日志、并发幂等、无效/移除策略、fsync 失败、unknown 责任、Broker 阻断、精确验证参数 |
| 真实 SDK/faux 交互 | exit 0 | 原始 read 中后部片段、显式提案替换、同批 write 不发生、等待时零跟进请求、用户命令恢复、只读验证与越界拒绝 |
| 真实 SDK/faux Campaign | exit 0 | read→buffered decision/candidate/read 同批、候选真实 finished charge、零 Broker 效果、重启零请求、Host 恢复一次；legacy7次工具/1次请求保留、零新增 provider/事件 |
| 最后 C 集成收尾 | 19/19 exit 0 | `followup-final/results.json`；含原审计故障与提案录入测试 |
| 两份 tsc | 均 exit 1，Campaign189→189 / Batch186→186，无新增诊断 | `types-{campaign,batch}-{before,final}.log`；不排除新实现或关闭规则 |
| 新/主要变更文件 Biome | 子 Agent 聚焦检查 exit 0 | `memory-final/`、子 Agent 交付记录、`followup-types/` |
| 全 27 个代码/测试文件 Biome | exit 1，2 errors / 1 warning / 2 infos | `biome-final.log`；旧 outcome-command 的 import/格式2错误1警告与独立起点完全一致；另外2条既有 useTemplate 信息提示；无新增规则/抑制 |
| 模块布局 / diff | exit 0 | 233 源码/测试文件、786 相对引用；不改 Pi/私有 config，不纳入 runtime 产物 |

证据根 `Pi_Agent_base/runtime/dev/ram-abc/`，全部 ignored。最终命令逐脚本保留真实 node/source resolver 参数和退出码；总 runner 真实非零，未把已知 red 转成 skip/expected failure。

## 限制与后续真实测试

- 只证明工程接线与边界，不证明真实模型必然调用提案/候选工具、重复探索率或 token/延迟收益。JSON 不预先宣称更省 token。
- 通用 shell 内部可能包含任意数量请求/动作；参数摘要计数只限制显式外层调用，不能替代结构化工具的请求/能力预算或 OS sandbox。不依赖正则猜测某领域的成功/爆破。
- 观察片段是采样，不是完整 Artifact；本轮不新建无范围全文读取服务。旧日志已丢失的数据不可恢复。
- 受信任任务契约必须显式配置，未配置的交互任务不捏造 criterion；已冻结策略冲突保持拒绝，不能通过移除文件放宽。
- 控制命令的串行化是进程内；跨进程单写者仍由原 Host/EventLog ownership 负责。非持久写入不报告成功，原 unhealthy audit 门继续阻断副作用。
- Campaign 工作流等待与队列历史状态分别展示，等待不是终态完成。现有 E1 authority 的独立已知12个失败未修复，也不用于证明本轮整体产品验收通过。
- 两份类型检查和全范围 Biome 仍有既有非零基线；内部集成验证不等于独立外部验收。
