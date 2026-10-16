# RAM 与探索问题：按既定约束修复

本计划依据用户要求核对原规划，修正 `RAM_REAL_SESSION_ANALYSIS.md` 中可能扩大“探索状态闭环”含义的建议。它是可实施的修复边界与验收清单，不表示产品已经完成；新增接口必须先在对应模块冻结字段和测试矩阵。起点为当前 RAM v2 与真实会话分析记录。

## 1. 已定限制与建议的区别

| 来源 | 原要求 | 对修复的限制 |
| --- | --- | --- |
| [THINK 记忆收集](../THINK.md)（第 58、78 行）、§5 | Observer 机械收集，不由 LLM 编写记忆；RAM 采用结构化字段 | 不添加总结模型、不让模型覆盖 RAM 文件；不再只构造一篇 Markdown |
| [THINK §9.4](../THINK.md)（第 499–525 行） | LLM 只提 Claim/Action；Observer 写观测，Oracle 写 verified facts，Runtime 管版本/预算/生命周期 | 不能从普通助手文本或推理反解可信状态，不能把提案变成执行许可 |
| [MEMORY_SCHEMA §3/§10](MEMORY_SCHEMA.md#3-event) | Event 记录发生事项，不解释目标意义；Event/Episode/Outcome 不能直接用于 action selection | 记忆选择和显示不能成为新的路线选择器或动作执行规则；active Experience 仍通过 Router |
| [白板契约 OP-B](E1_OBSERVABLE_PLANNING_TASK.md#42-白板契约op-b) | 简短假设/计划来自显式 aegis_propose，不读取隐式思维，不从普通 assistant 文本抽可信结论 | 使用既有提案与 reducer，原文仍只是未验证 Claim/Intent |
| [CTF 反馈 P2](CTF_PILOT_FEEDBACK_REVIEW.md#p2尝试与响应的最小信息集) | bash 只展示实际命令/返回；不猜测解析 HTTP 语义；详细结果与摘要分开 | 不根据 curl 字符串猜 method/parameter/success；结构字段来自真实结构工具 |
| [CTF 反馈 P3](CTF_PILOT_FEEDBACK_REVIEW.md#p3探索策略与结果权威分离) | 候选提交后由 Runtime 校验绑定并等待外部验收；最小验证，不要求穷尽替代路径 | 该门属于控制层；一般 Claim、成功文本/正则和 exit 0 不触发等待或完成 |
| [THINK §9.1](../THINK.md)（第 426 行） | 限制低性价比爆破；active Experience 命中后复用，异常退出捷径 | 应由执行/预算/策略层落实；RAM 不猜测任意脚本是否爆破，也不记成普遍方法失败 |
| [架构决策 §3、§9.11](ARCHITECTURE_DECISIONS.md) | 短窗口、最小状态邻域、总请求预算；无进展时有限补观测 | 已定的边界保留；“最多两次”等明确标为建议的数字不能自动成为全任务硬限制 |

“记忆不驱动行动”的工程含义：模型可读取观测数据作为局部判断输入，但记忆文本、检索分数或观测节点不直接分发/阻止动作，不产生 grant、trusted success 或路线选择命令。自动选路仍由既有 Router/合法执行策略及其证据/权限门负责。

## 2. 修复拆分

### A：机械采集与结构化 RAM（先实施）

职责：memory/、extensions/；输出仍是每请求从 committed prefix 重建的派生投影，不另建数据库。

- 将 RAM 构造明确分为结构数据、候选选择、预算渲染；对外注入紧凑结构化 JSON，保留版本、Episode、state revision、目标/权限来源和各节 omission/overflow。
- action 输入/输出成对，区分 observed data、unverified claim、verified fact。继续标明 transport，不用文本匹配判断目标成功。
- 用确定性的文本片段选择替代“只保留前 N 字符”：在脱敏后的原始文本上记录有界 head/tail 和有偏移的行片段；同目标/同操作有可信结构标识时可做差异片段，通用 bash 不猜目标语义。
- 不删 HTML 后声称字节等价。若提供可读文本视图，必须标 transformation 和原数据引用，原始响应语义不被替代。机密先脱敏，且保留截断前后长度口径。
- 历史工具观察不只留最近六条：在固定配额内结合最近动作、显式 Claim/Intent 的有效来源引用和去重记录。引用只决定展示关联，不证明模型说法成立；无显式关联时使用保守的最近性/多样性采样，不声称识别出“正确路径”。
- 压缩重复长标识用本次快照局部引用表，完整 ID/digest 在同一结构可解析；不能只截短 ID 后当真实身份。
- 已存在并经校验的 Ref 只读访问可复用；需要新增分页读取时先定义同 Episode/Task/授权/字节上限校验，不在观测 UI 开任意路径读取，不把 digest 当作可读全文。
- 保留当前临时 user 尾部传输和固定 system/tools；不在此轮顺带改成增量缓存协议。JSON 是否更省 token 用实际序列化数据测量，不先验承诺。

### B：显式提案的展示接线（不自动生成推理）

职责：memory/proposal、Board、扩展接线。

- 复用 aegis_propose 的 Claim/Intent：模型显式提交简短判断与拟议下一步，Observer 校验并追加事件，Board 投影成 Hint/Intent。
- 参数、scope、source_refs 校验；来源引用在当前 committed prefix 内解析，标明无法解析、foreign、stale、superseded，不能让模型自报 current/verified。
- RAM 在本次活动目标邻域展示相关观测和提案；不把助手正文的“完全探明”自动变成节点。
- 需要对旧 Claim 作修正/撤回时，先定义最小追加契约，不能复用可信 Outcome 的 supersedes 门来赋予模型事实更正权。
- 不要求每一次普通 read/bash 后额外调用 LLM 或强制提交提案；不新增模型反思循环，也不把模型未调用提案工具算成已建立探索状态。

### C：收敛、禁止无效重复与候选等待（单独接入执行控制）

职责：orchestration/、execution/、交互入口及 Campaign 的控制层；不由 RAM 实现。

- 区分“有进展但未完成”和“已提交可验收候选”。前者仍可能需要新的判别实验；后者经可信绑定后进入等待，只允许决定该候选的必要验证。
- 候选不是 Experience candidate，也不是普通 Claim。复用既定候选提交设计，绑定目标实例、criterion、artifact 与证据；外部验收不具备自动接口时交用户确认，不伪造 Outcome。
- 交互 Observer 入口与 Campaign Scheduler 分别接线/验证；不能因 Campaign gate 存在，就宣称自由 bash 交互会话已受同样控制。
- 同状态同参数重复、无新增证据的重复和解析/传输错误分开计数；依据冻结任务预算/策略处理。缺乏结构化语义时保持 unknown，不机械把错误当 negative。
- 低性价比爆破限制在授权工具/注册动作、请求数/时间预算和受审策略中实施。不靠扫描任意 shell 文本声称禁止所有爆破；通用 shell 的限制是可见运行边界，结构化 Web 工具仍按既有独立规划实施。
- 用户/平台拒绝候选、反例或显式要求继续时按已有控制契约恢复；保持原消费、责任和证据，不自动重发未知副作用。
- 有效 Experience 的 direct/habit/hint 仍只使用既有 Compiler/Router 门，不从一次运行观察临时编造 active 经验。

## 3. 明确不采用

- 新增 LLM 总结器、读取隐式推理、从助手散文反解规则。
- 将“某响应看起来成功”自动提升 Fact、Outcome、active Experience 或等待验收状态。
- 在 RAM 层自动阻止路线、决定下一动作或把一次错误永久记成方法不可用。
- 在 ROM 中硬编码本题技巧、输出关键词或固定“两次”上限。
- 为了字段更丰富而并行新建探索数据库、预算账本、Broker 或弱版 authority。
- 为新内存功能掩盖当前已知 E1 权威/工具执行边界失败。

## 4. 验收与推进

| 阶段 | 有意义的离线反例/正对照 | 证明范围 |
| --- | --- | --- |
| A | 长 HTML 和多行结果的中后部信号、脱敏膨胀、输出缺失、二进制、巨大单项；4k 完整预算与 overflow；ID/ref 解析 | 采集/选择保真，不证明自动识别正确解法 |
| A | 真实 SDK/faux 的每请求 JSON、字节摘要、system/tools 稳定、原 toolResult 保留、Session 不存临时 RAM、真实替换后恢复 | 实际接线，不以 helper 生成期望替代 |
| B | 只普通助手文本时无提案节点；显式 Claim 显示未验证；foreign/未来/缺失 ref 不成为当前证据；不得改 goal/authorization/Fact | 权限与来源保持，不宣称强制模型使用工具 |
| C | 普通 Claim 不暂停；可信绑定候选暂停新探索、只做必要验证；否定/用户继续后合法恢复；预算不重置；交互/Campaign 各自产品入口验证 | 控制层真实收敛门，不把候选误判 success |
| 对照 | 原 RAM v2 失败反例保留；新增真实会话现象的脱敏/合成样本，私有原始记录不纳入 Git | 不写死具体题目、不重跑真实目标 |

先完成 A 的契约与 red→green；B/C 在各自接口范围实现，必须分别证明行为接线，不能宣称仅修 A 就解决了重复探索。真实效率对照由用户显式运行，比较无进展调用数、重复探针、线索发现至利用间隔、累计成本与独立结果；不设未经测量的收益承诺。
