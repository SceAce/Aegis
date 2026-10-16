# Web CTF 实测反馈与版本归档

日期：2026-10-16。范围：核对用户报告的缓存、RAM 信息和重复探索问题，保存现有未提交工作，
形成下一轮修复的接口与验收范围。本轮不更改产品实现、不查 WP、不访问靶机、不启动付费模型。

## 1. 输入与结论边界

用户反馈记录于 `THINK.md` 的“实际CTF测试”段。产品输入为 `fae0a49` 加原有 Opus 工作树；
27 个实现/测试文件与前轮 `single-authority-review/final-identity.json` 的 SHA-256 完全一致，
已原样提交为 `592d9fb`。该提交是版本归档，仍为 `changes_required`，不是新一轮实现验收。
用户既有任务提示词与实测笔记另外归档，内容不覆盖、不改写。

固定原则继续采用 SYS-20261015-01、既有 Claim/Action/Outcome 权限和 Campaign 契约。
动态数据的传输位置、投影信息完整度、探索策略可以修正；不能把模型声明或工具成功提升为可信成功。

本地只读检查的输入：

- `runtime/interactive.dIMrSp/events.jsonl`：855 条，链验证通过。
- `runtime/interactive.4zQKet/events.jsonl`：220 条，链验证通过。
- 两次运行对应的 `config/sessions/` 会话 JSONL；不读取或输出模型凭据。
- `extensions/aegis-observer.ts`、`memory/runtime/{board,ram,state,contest-bridge}.mjs`。

以上路径相对于 `Pi_Agent_base/`；原始记录留在 ignored 私有目录，报告不包含 flag、请求载荷或完整会话。

重要适用范围：两次运行的普通动作均为 `bash`，没有 Campaign 计划/TaskOracle 事件。
这是交互式 Observer 入口的实测，尚不能拿来证明 E1 Campaign 的网络 adapter、预算恢复或任务调度已通过。

## 2. 三项反馈的核验

### F1：动态 RAM 改写系统前缀，缓存复用受损

代码路径：`before_agent_start` 写入 `systemPromptOptions.sections.aegis_ram`；
`context_with_system` 每次 provider 请求重新构建 RAM，替换 leading system message 的 `aegis_ram`。
ROM 字节稳定并不能使整个 system 区域稳定。只把 RAM 放到另一个 system message 也不够，
provider 可能合并 system messages；最终需要检查序列化后的真实 provider payload。

实测审计行：第一次运行 119 个 `request.projected` / 118 个 RAM digest；第二次 30 / 30。
这说明 RAM 几乎每次都变化，但单独的 digest 变化不等于测得缓存损失的因果大小。

会话用量字段的统计如下，数值来自 provider 返回的 usage：

| 主会话标识 | assistant usage 条数 | 非缓存 input | cacheRead | cacheWrite | 缓存输入占比 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `01a140a5-e41f-728a-92c9-0324c9dbe7b4` | 67 | 1,645,970 | 77,184 | 0 | 4.48% |
| `01a140b5-5cc0-741e-a42a-d4b487c889ee` | 27 | 307,324 | 30,208 | 0 | 8.95% |

口径为 `sum(cacheRead) / sum(input + cacheRead + cacheWrite)`；这里的 input 不包含单列的缓存 token。
它不是请求命中率，也不是 RAM 单因素对照实验。零值 cost 不作为免费或真实美元支出的证据。

### F2：日志有部分细节，Board/RAM 在投影时丢失

`summarizeToolInput` 为 bash 保存 `command_excerpt`，为 read 保存 path，其他工具主要只保存 key 名和 digest；
`tool_result` 保存 `content_excerpt`、content digest、transport，但只保存 details 的 key 名。
因此有两层缺口：部分输入/结构化返回在采集时已缺失；已经记录的摘要又没有传入模型的 RAM。

Board 的 Intent/Artifact 文本优先退化为 `tool_name`，构建 node 时没有保留 input/result 摘要。
RAM 的最近工具关系只输出 `tool(action_id) → completed|pending`，Artifact 再次只显示工具名。
例如第一轮两个非空动作 Episode 的 51 次和 67 次输入都有 command 摘要，响应分别有 51 和 66 条摘要，
但重新构建的 RAM 不包含任何一条完整输入摘要或返回摘要。不能依靠增加 RAM 字符预算补回被丢弃的字段。

边界：工具返回错误不一定说明方法被证伪；哪个字段成功/失败必须来自具体观测或独立判断。
任意 bash 的输出不能靠字符串猜测自动成为结构化已验证 Fact。

### F3：缺少收敛与等待验收的执行策略

ROM 要求外部判定，RAM 反复提示 `unknown until an oracle or human decides`，
但交互入口没有把“继续探索”“已有可提交候选”“等待外部验收”分开处理。
`aegis_propose(kind=claim)` 是一般声明，不是候选提交或停止命令；未知结果也不是继续穷举的义务。

现有两份运行日志都没有 `outcome.recorded`。第二轮最后一个 Episode 在
`2026-10-16 01:56:58.256 +08:00` 开始，在 `02:00:13.353` 记录 claim，间隔 **195.097 秒**。
这是到该 claim 的事件时间差，不是平台确认成功耗时；首次正确路径的时间点没有独立结构化标记。
不能从这份日志复算“额外约 50%”，该数字保留为用户实测估计。

Oracle 职责是核验当前候选及必要后置条件，不是要求尝试所有替代解法。
具体哪些额外动作由 Oracle 提示导致、哪些由模型自身决定，需要后续动作标记和对照运行区分。

## 3. 下一轮修复契约（尚未实现）

| 编号 | 接口/责任边界 | 必须实现的行为 | 不能改变的规则 |
| --- | --- | --- | --- |
| P1 | Observer 请求投影 → Pi context → provider payload | 同一短会话内固定 system/ROM/工具定义；动态状态进入有界运行上下文；历史已发送前缀不反复改写 | 每次仍从 committed source 构建与审计；权限不能来自模型或低信任内容 |
| P2 | action event → Board → RAM/交接 | 保留已脱敏的实际输入、实际返回、transport、数据/事件引用；按 action_id 绑定 | 不能用 transport 冒充 Outcome；foreign Episode、失效事实不成为当前真值 |
| P3 | Worker 探索策略 → 候选提交 → 外部验收 | 路径有有效进展时沿该路径收敛；有可提交候选时暂停替代探索并等待验收；拒绝/反例后恢复 | Outcome 缺失仍 unknown；必需验收条件不删除，候选不能自行升 success |
| P4 | 时间与用量测量 | 区分探索开始、首个有效进展、候选、平台确认、恢复/暂停、结束 | 未记录的时间点为 null；不能用模型事后回忆补精确时间 |

### P1：缓存与新鲜度同时成立

建议采用“短会话初始 RAM 快照 + 已提交变化的有界增量”，普通 tool-result 保留正常反馈；
不在每个请求的系统前缀里整体替换 RAM，也不每轮重复塞完整快照。会话轮换/压缩时重建新快照，
明确记录这些会主动改变缓存边界。具体传输接口先核对现有 Pi 的 context API 和 provider 转换。

需要保存快照/增量的 state revision、Episode、源引用和摘要，保证新信息可见、旧版本不复活。
在真实模型调用之前以真实 SDK + faux 捕获请求，再检查实际 provider 转换，不能仅检查某个 section 对象。
新增运行上下文必须计入原有请求窗口和预算检查；不另造账本，不拼接伪造 tool-result。

### P2：尝试与响应的最小信息集

投影每个 attempt 时至少保留：Episode/action/request 身份、目标与操作、明确输入字段与有界值摘要、
transport/error、响应摘要/产物引用及 digest；有明确字段观测时再保留字段的 expected/observed。
模型解释保持 Claim；原始远端文本保持 Observation/Artifact，不作为 system 指令。

通用 bash 只能可靠展示已记录的命令/返回摘要及引用；HTTP/结构化工具才能提供已校验的
method/path/parameter/status 等字段，不对任意脚本进行猜测性解析。
凭据按字段脱敏；确实用于解题的参数值不能全变成不可读 digest；完整私有产物与公开摘要分开。
超长返回可分页读取；截断应明确并提供引用。当前 launcher 尚未提供这些结构化 HTTP 工具。

RAM 优先保留正在收敛的路径、当前最佳证据与最近异常，按 action_id 去重。
预算缩减要报告省略数并保留读回引用；换 Session 后仍能回答“试了什么、传了什么、返回什么”。

### P3：探索策略与结果权威分离

为既有 Claim 工具定义明确的候选提交形式，绑定当前题目/实例/目标、候选产物和证据引用。
一般 claim 不自动触发暂停，也不靠 flag 正则、自然语言“成功”或任意工具 exit 触发。
可信 Runtime 校验绑定后记录“等待外部验收”的执行阶段，停止该任务的新探索请求；
该阶段属于控制/工作流状态，不能给 Outcome 新增同义 pending，也不产生 Fact。

外部来源不具备自动验收能力时，提交给用户并等待。需要补验证时，只运行能决定该候选的最小检查。
平台拒绝、反例或用户要求继续时显式恢复，保留消费与原证据；不自动换 ID 重试未知副作用。

替代路径不是默认全部必需。CTF“找到一个可接受答案”的目标与强制 AND 验收条件要在任务定义中区分；
不能为省时跳过已冻结的必要条件，也不能将所有探索子任务错误提升为根目标的强制验收项。
运行入口不同，约束接线也不同：交互 Observer 的任务边界和 Campaign 的 Scheduler 必须分别验证。

## 4. 验收矩阵与顺序

本轮诊断脚本 `tests/aegis-ctf-ram-review.mjs` 的预期是暴露现有缺口，红例不能当成修复完成。

| ID | 要求 | 层级与独立证据 | 本轮状态 |
| --- | --- | --- | --- |
| CR-01 | 同一任务新增观察不改变系统消息字节 | 真实 SDK + faux 的两次请求 | fail，system 改变 |
| CR-02 | RAM 保留输入位置与真实响应摘要 | read 实际文件，事件/Board/RAM 对照 | fail，日志有而 RAM 缺失 |
| CR-03 | 真实响应仍进入 continuation | provider 请求中的 tool-result | pass |
| CR-04 | 普通工具成功不生成 Fact | 实际 EventLog 重建 Board | pass |
| CR-05 | 请求投影审计保持真实且不污染状态 | RAM digest 与请求字节、链验证 | pass |
| CR-06 | foreign Episode 信息不泄入 RAM | 使用 foreign Episode id 读取已有投影 | pass |
| NEXT-01 | 序列化 payload 保持可缓存历史前缀；增量不重复膨胀 | provider 转换/真实 SDK，禁用更新、轮换、压缩和 stale patch 组合 | 后续 P1 |
| NEXT-02 | 字段值/错误/产物引用完整；二进制、大返回、缺返回、脱敏、预算截断 | adapter → Board → RAM → 新 Session | 后续 P2 |
| NEXT-03 | 可提交候选后替代路径零新效果；恢复后仅允许明确下一步 | 真实工具调用计数、latest gate、持久化失败及新进程恢复 | 后续 P3 |
| NEXT-04 | 人工/平台验收缺失、合法、拒绝、foreign、冲突、过期 | 不改原 Outcome 断言；未知不升成功，拒绝不误证伪方法 | 后续 P3 |
| NEXT-05 | 计时含未确认/暂停语义；缓存分母准确，缺 usage 不填零 | 固定时间戳与 provider usage 独立统计；有界 A/B | 后续 P4 |

实施顺序：先 P1 与 P2 的受影响切片，后 P3 的候选/门控/验收接线，再由用户运行 P4 对照。
开发沿用 ESM/JSDoc/Biome、显式回归清单、真实 SDK + faux；不改内嵌 Pi、凭据或依赖。
P3 涉及控制与恢复契约，须在编码前补全事件字段、拒绝码与产品入口矩阵，不能只加一条提示词宣称闭环。

前轮 E1 独立审查问题继续保留；本报告不批量修复，也不以交互式解题反馈重写其原断言。

## 5. 本轮检查与交付

| 命令 | 退出码/结果 |
| --- | --- |
| `node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-ctf-ram-review.mjs` | 1；4 pass / 2 fail，CR-01/02 为现有实现的行为缺口 |
| `node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-observer-contest-pi.mjs` | 0；既有 Observer/contest 组合检查通过 |
| `./Pi_Agent_base/pi/node_modules/.bin/biome check --config-path=Pi_Agent_base/aegis-biome.json Pi_Agent_base/tests/aegis-ctf-ram-review.mjs` | 0；初次格式检查失败，格式化后通过 |
| `git diff --check` | 0 |

私有证据目录为 `Pi_Agent_base/runtime/dev/ctf-feedback-review/`：
`input-metrics.json` 保存四个实测输入的 SHA-256 和无敏感正文的统计，
`ram-review-result.json`、`observer-regression-result.json` 保存精确命令、原始 exit code/signal，
对应 `.log` 保存本轮测试输出。没有使用可能吞退出码的总 runner。

本轮只新增测试/报告并归档既有内容；没有重跑全部 68 项、类型检查或真实模型 A/B，
不将前轮的通过记录冒充本轮结果。内嵌 Pi 为 `42a3497`、clean。
上次报错指向共享 `runtime/events.jsonl`；本轮确认的是上述两个隔离日志的链，未改写共享旧日志。

Git 归档不等于缺陷修复。下一轮按 P1–P4 实现并将上述行为红例修绿，
仍需用户实际运行后测量缓存收益、首次有效路径耗时和额外探索比例。
