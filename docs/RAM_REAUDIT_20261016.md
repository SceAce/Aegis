# RAM 工作记忆重新审计

审计基线：`28cff12405dac70ed83616cb799b1423b3046ae4`。
范围：事件采集 → Board → RAM → provider 请求和会话交接。只新增审计测试和报告，保留产品代码供后续修复审查。
内嵌 Pi：`42a3497d03ad17e308a2299fa824727894f2c0ec`，工作树干净。

## 冻结契约与测试矩阵

| ID | 输入/信任来源 | 应有行为 | 验证路径 |
| --- | --- | --- | --- |
| RR-01 | 已提交 action 请求/响应 | 已记录的参数、响应摘要能进入当前 RAM；transport 不等于任务成功 | 真实 EventLog → Board → RAM；既有真实 SDK CR-02 |
| RR-02 | 两条独立 Oracle Outcome，相同 expected、不同 criterion/observed 对象 | RAM 保留各自命题身份和观测值，不能按通用文字合并 | EventLog → Board → RAM |
| RR-03 | 当前 Episode 21 条有效且简短的已验证 observation | RAM 不能永久排除最新证据 | EventLog → effective Board → RAM |
| RR-04 | 超出展示条数、未超过字符预算 | 明确披露有证据未展示，不能依赖字符超限才提示 | 同 RR-03 |
| RR-05 | 多条历史 experience.decision，无 pending action | 低优先级历史决策不能使默认 RAM 无界增长 | EventLog → State → RAM |
| RR-06 | 有限预算中存在可放入的 Fact | 按优先级逐步缩减，保留放得下的事实 | EventLog → Board → RAM |
| RR-07 | 当前和 foreign Episode 的 Fact/Refuted/Intent | 交接投影限定当前 Episode | EventLog → Board/State → evaluateHandoff |
| RR-08 | tool_ok=false 的已完成工具 | RAM 保留 transport 失败信息且不产生 Fact | EventLog → Board → RAM |
| RR-09 | 当前/foreign Episode 的证据 | 当前 RAM 隔离仍然成立（正向保护检查） | EventLog → Board → RAM |
| RR-10 | 普通 completed action | 完成不产生可信 Outcome（正向保护检查） | EventLog → Board/State |
| RR-11 | 有效 expected=false 的独立 Oracle Outcome | RAM 保留 false 预期及实际值 | EventLog → Board → RAM |
| RS-01 | 真实 SDK 自定义本地工具调用 | 保留安全参数值，不只保留 keys/digest | 实际 tool_call → EventLog |
| RS-02 | 真实 SDK 自定义本地工具返回 | 保留有界、脱敏的结构化观测值，不只保留 details keys | 实际 tool_result → EventLog |
| RS-03 | 真实 read 工具结果 | 原 Session continuation 收到真实返回（保护检查） | 实际 provider 上下文 |
| RS-04 | 真实 AgentSessionRuntime 替换 | 已记录的 read 路径和响应通过 RAM 进入新 Session | read → 请求交接 → applyStagedHandoff → 新 Session provider 上下文 |
| RS-05 | 实际替换后的事件链 | 同 Episode、唯一交接完成、不制造 Outcome（保护检查） | EventLog + 实际 Session 对象替换 |

所有新增事件写入真实临时 EventLog 并验证 hash chain。RR 用例的 Oracle 行是离线合成可信输入，不能据此声称真实任务验证成功。RS 用例使用真实 Pi SDK、实际本地 read 和 faux provider，5 次离线请求。无真实 provider/目标调用，无凭据读取。

必需命令：新增 `tests/aegis-ram-reaudit.mjs`、`tests/aegis-ram-reaudit-sdk.mjs`，既有 `aegis-ctf-ram-review.mjs`、`aegis-ram-cache-payload.mjs`，以及 Runtime core/effective-board、Observer smoke、真实 SDK handoff/rotation 回归。原有失败断言保留。日志根：`Pi_Agent_base/runtime/dev/ram-reaudit-20261016/`（ignored）。

## 执行结果与发现

结论：RAM 的缓存传输修复仍有效，但工作记忆的内容保真与有界投影不满足当前承诺。新增两个脚本共 16 个检查：4 pass / 12 fail；12 个失败检查分属以下问题组，不是 12 个独立根因。既有 CR-02 仍失败。本次为审计交付，不宣称缺陷已修复，也不撤销此前 C6 账本和准入的限定验收。

### F1 — 高：输入/返回在采集和投影两层丢失，实际换会话后失忆

位置：`extensions/aegis-observer.ts:203`、`:763`；`memory/runtime/board.mjs:602`、`:614`、`:737`；`memory/runtime/ram.mjs:74`。

- `summarizeToolInput` 保存 keys/digest，只额外保存 command、path 或 operation 之一；URL、parameter、value 等普通工具实参没有有界值摘要。
- `tool_result` 只保存文本 excerpt 和 `result_detail_keys`。details 的值没有进入 action.completed。RS-01/02 用实际本地工具证明采集缺口；无敏感值样本，不能把凭据脱敏作为丢掉这些字段的解释。
- 对已经记录的 read 路径与响应，Board 的 Intent/Artifact 文本通常都是工具名，节点未保留 input/content_excerpt/transport。RAM 的关系行只显示 `tool(action_id) → completed|pending`。`tool_ok=false` 和 ENOENT 也丢失，完成状态不能表达工具返回错误。
- RS-03 证明原会话普通 toolResult 有真实 read 内容；RS-04 真实替换 Session 后，新的 provider 上下文没有旧 toolResult，RAM 也没有 `probe.txt` 和响应标记，而事件日志仍保留它们。这是可达的记忆丢失，不是模型有没有认真读提示的问题。

证据：RR-01、RR-08、RS-01/02/04、既有 CR-02 失败。影响：新会话难以知道已经尝试的参数与结果，可能重复读取/探索；本审计未测量真实模型重复探索率。

处理：当前 RAM 修复阻塞。先定义有界、脱敏、带 action/event/data 引用的输入/响应投影，明确缺失和截断；transport 与可信任务 Outcome 继续分开。只扩大 RAM 字符预算不能恢复已经丢失的数据。

### F2 — 高：不同可信判断在文本层合并，结构化观测值丢失

位置：`memory/runtime/board.mjs:584`、`:588`；`memory/runtime/ram.mjs:42`、`:60`。

`nodeText` 在 observed 为对象时直接省略它；expected 为对象时字符串插值成为 `[object Object]`。expected 为 false/0 时又受 `if (proposition)` 的 truthy 判断影响。RAM 渲染只读 text，不读 criterion/observed/evidence_refs，然后按渲染行去重。

RR-02 提供两条 criterion 不同、observed 对象不同、evidence_refs 不同的独立合法判断。Board 保留两个 Fact 和原始 observed 值，RAM 却把它们合为同一句通用文字，既无 criterion id 也无 observed 值。RR-11 证明 false 预期及对象观测也会消失。部分事件只有规范的 evidence_refs，RAM 的 nodeLine 却仅使用 source_refs，因而引用没有补回身份信息。

处理：当前内容保真修复阻塞。按规范身份去重，保留命题描述、expected/observed 的有界结构、criterion/outcome/event/evidence 引用；false、0 和空容器按真实值处理。Board 的权威状态未被这个反例改坏，缺陷发生于模型收到的表示。

### F3 — 中：取最早事实，条数截断静默，最新进展可能永不进入 RAM

位置：`memory/runtime/ram.mjs:120`、`:137`、`:147`。

Fact/Hint/Refuted 从追加历史中按正序取 `slice(0, limit)`。默认只展示前 20 条 Fact；在 21 条短事实且 RAM 小于 4,000 字符时，第 21 条被排除。后续请求即使重建，也继续选择相同的旧 20 条，除非旧项退出 effective view。

`renderOptional` 计算了 droppedAny，但调用方没有消费；初始条数上限造成的遗漏不会触发 budget_drops。输出写 `Verified facts (21)`，实际只有 20 行，没有遗漏说明。

证据：RR-03/04 失败。处理：当前 RAM 修复项，采用与当前任务/最近进展相关的显式选择顺序，披露 total/shown/omitted。具体排序属于修复设计，不把“所有历史都注入”作为验收要求。

### F4 — 高：历史路由决策挤爆 RAM；收缩循环过早抛弃所有证据

位置：`memory/runtime/ram.mjs:83`、`:129`、`:150`、`:170`。

1. 全部已选 experience.decision 被放进不可裁剪 mandatory 区。RR-05 在没有 pending action 的情况下，40 条历史选择即可使默认预算 4,000 的 RAM 达到 **9,570 字符**。这是普通历史记录增长，不是为保留真实未完成动作而特许超预算。每条 clip 不限制总条数；也没有去重/退休旧决策。
2. 收缩以 tool-call 限额是否降到负数作为总循环结束条件。tool_calls 从 3 降到 0 后仍不满足预算，就直接抛掉全部可选证据，此时 Fact 限额只从 10 试到 7。RR-06 的 1,500 字符预算能放下一条 Fact，但混合 10 条 Fact/10 条 Hint 时最终一条 Fact 也没留下。
3. 元信息/footer 在预算检查后才追加，`ram_estimated_chars` 记录正文长度而非最终字符串长度。真实 request.projected 使用 ram.length，所以请求审计长度本身未被该问题否定；修复应统一预算覆盖口径。该项为源码发现，未单列通过的边界测试。

处理：当前有界投影修复阻塞。仅任务/权限/真实 pending 等核心信息保底，历史决策应有界且退役；按章节实际优先级逐步裁剪，计入元信息。Campaign 仍有真实请求窗口 gate，本审计没有证明可绕过该 gate；超大 RAM 可以导致请求被阻断和有效上下文浪费。

### F5 — 中：handoff 对象混入其他 Episode 的事实/反驳/意图

位置：`memory/runtime/handoff.mjs:65`；持久化调用 `extensions/aegis-observer.ts:1683`。

evaluateHandoff 的 ram 字段来自已按 Episode 过滤的 buildRam，但 facts/refuted/intents 直接遍历整个 effective Board。RR-07 在同一日志有多个 Episode 时，交接允许且 handoff 中包含 foreign Fact/Refuted/Intent；该对象会写入 handoff.json。

处理：交接投影修复项。所有交接字段都应按同一个 Episode 过滤。当前默认 Host continuation 只发继续提示，Observer 从事件日志重建 RAM；因此本用例证明的是交接文件/对象污染，**没有证明默认新会话将 foreign 内容注入模型或获得越权能力**。整体状态与 F1 的实际 Session 失忆证据分开。

### 其他已核对事项与限制

- 缓存传输没有在本轮退化：真实 SDK + OpenAI 序列化、HTTP 全拦截的 10 请求检查通过。系统消息和工具定义稳定，每次只有一个临时 user 尾部 RAM，旧 transcript 前缀增长，RAM 不写入会话文件。公共前缀长度为 3,959 → 5,919 字符。没有真实缓存命中率/延迟数据，不能把本地前缀长度等同于 provider token 命中。
- 普通 buildRam 的 Episode 过滤仍通过；普通工具完成不会自动制造可信 Outcome。既有 effective-board、Observer 和 rotation 回归仍通过。
- `/aegis ram` 直接 `.slice(0, 1200)`，用户查看到的内容可能不含后面的事实和预算尾注。属于显示限制，不能据其输出代表整个 provider RAM；后续可给出明确截断提示或完整查看入口。
- Observer 每次 emit 都全量 projectBoard/projectState，persistProjections 又全量重建并落盘；request.projected 也经过该路径，EventLog.rows 长期保存全历史。这是长运行 CPU/IO/进程 RAM 的性能复核候选，但本轮未做 heap/RSS 基准，**没有证据把它称为进程内存泄漏或这次模型延迟的唯一原因**。本轮 RAM 指模型工作记忆。
- 未运行整个项目所有阶段测试；没有新增产品接口、Pi core 修改、依赖或真实网络实验。本轮没有产品类型变更，未重跑历史 tsc 基线。所有审计结论只覆盖这里的工作记忆链路。

## 实际检查与复现

命令均从仓库根执行。SDK 前缀为：

```bash
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts
```

| 检查命令 | exit | 结果 | 日志文件 |
| --- | --- | --- | --- |
| `node Pi_Agent_base/tests/aegis-ram-reaudit.mjs` | 1 | 2 pass / 9 fail；RR-09/10 通过 | reaudit.log |
| SDK 前缀 + `Pi_Agent_base/tests/aegis-ram-reaudit-sdk.mjs` | 1 | 2 pass / 3 fail；RS-03/05 通过，5 faux 请求 | reaudit-sdk.log |
| SDK 前缀 + `Pi_Agent_base/tests/aegis-ctf-ram-review.mjs` | 1 | 5 pass / 1 fail；CR-02 仍失败 | ctf-review.log |
| SDK 前缀 + `Pi_Agent_base/tests/aegis-ram-cache-payload.mjs` | 0 | 10 次实际序列化请求，全部 HTTP 拦截 | cache-payload.log |
| `node Pi_Agent_base/tests/aegis-runtime-core-smoke.mjs` | 0 | 既有回归通过 | core.log |
| `node Pi_Agent_base/tests/aegis-runtime-effective-board.mjs` | 0 | 既有回归通过 | effective.log |
| `node Pi_Agent_base/tests/observer-smoke.mjs` | 0 | 既有回归通过 | observer.log |
| SDK 前缀 + `Pi_Agent_base/tests/aegis-observer-runtime-handoff.mjs` | 0 | 真实 SDK 交接回归通过 | handoff.log |
| SDK 前缀 + `Pi_Agent_base/tests/aegis-c2-session-rotation.mjs` | 0 | 真实 SDK 轮换回归通过 | rotation.log |
| Biome check 两个新增测试 | 0 | 格式和 lint 通过，未降低规则 | biome.log |
| `git diff --check`（暂存前后检查） | 0 | 无空白错误 | Git 检查 |

Biome 完整命令：

```bash
./Pi_Agent_base/pi/node_modules/.bin/biome check --config-path=Pi_Agent_base/aegis-biome.json Pi_Agent_base/tests/aegis-ram-reaudit.mjs Pi_Agent_base/tests/aegis-ram-reaudit-sdk.mjs
```

初次 Biome check exit 1（仅格式），formatter 后最终 exit 0。最终 RR 为 11 个检查、RS 为 5 个检查；所有失败均在已运行的行为断言处，原有测试未改动。没有把 fixture 前置条件失败算成新缺陷。

## 后续修复顺序

1. 冻结有界输入/响应摘要和身份/引用字段，修复 F1/F2，要求原会话 continuation 与真实替换后 RAM 两条路径都验证。
2. 修复 F3/F4 的选择、遗漏披露和预算算法；禁止用放大预算/只放工具名来让测试通过。
3. 对 F5 统一 Episode 作用域，显示限制可同时小修。
4. 保留并复跑本轮失败断言，再跑本报告列出的受影响回归；缓存系统前缀仍须稳定。真实模型收益与物理进程内存基准独立测量。

Git：审计分支 `audit/ram-working-memory-20261016`，交付只含两个新增测试和本报告；没有修改产品实现。报告为当前会话内部审计，非独立外部验收。

## 更新（2026-10-19）

本节纠正本报告中的一处事实，并记录两条剩余红项的当前状态；上文保留当时基线与原始分析。

- **RR-06 前提不成立。** 上文按 1,500 字符预算描述“能放下一条 Fact”，但按当前 RAM 骨架与行大小，一条 150 字符 Fact 的投影约需 1,591 字符，1,500 预算连一条也放不下。该用例原先只断言“长度 ≤ 预算”，未断言 Fact 存在，因此把“没有东西可留”误当成“收缩丢弃了本可保留的事实”。2026-10-19 把前提改为 1,700，并新增“单条 Fact 实际存在”的断言；`aegis-ram-reaudit` 11/0。产品代码未因此改动。
- **RS-07 已修复。** 真实 SDK 下一次请求的 RAM 曾把已汇总的 `input`/`details` 再截到 100/80 字符，结构化参数值只剩几个字符。`memory/ram.mjs` 提高单行显示预算（320/260，展开 480/420）后，`aegis-ram-reaudit-sdk` 7/7，包含敏感字段脱敏与超长字段截断断言。
- 当前状态：`aegis-ram-reaudit` 11 pass / 0 fail；`aegis-ram-reaudit-sdk` 7 pass / 0 fail（2026-10-19，真实临时 EventLog / 真实 SDK + faux）。证据：`Pi_Agent_base/runtime/dev/audit-20261019/ram/results.json`。
- 本报告的 12 条初始失败已全部关闭；这不等于真实模型的长窗口效果得到验证，效果仍属 EXP 系列。
