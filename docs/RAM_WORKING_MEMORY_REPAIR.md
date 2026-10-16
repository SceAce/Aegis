# RAM 内容与裁剪修复

起点：004ff46。范围：Observer 采集 → Board 投影 → RAM 构造 → 每请求注入与 Session 交接。保持 EventLog 权威、来源/Outcome 判断、预算授权和现有临时 user 尾部注入协议；不改 Pi、不新增依赖、不调用真实 provider。

## 结构与选择契约

1. 任务核心：原始目标、当前请求、Episode/Task、状态、授权/预算摘要、真实 pending/unknown/unresolved actions。核心过大不静默删除责任，显式报告 overflow；RAM 不是执行授权。
2. 当前有效事实与反驳：按规范节点身份去重，保留 criterion、expected/observed（含 false/0/对象）、Outcome/event/evidence 引用。
3. 最近工具观察：同 Episode 的 request/result 按 action_id 配对，携带参数、返回值、transport 和 event 引用；只表示观察，不等于任务成功。
4. 历史提案与经验选择：明确未验证、有条数上限、可退休，不放不可裁剪核心。
5. 元信息：每节 total/shown/omitted、字段截断标记、最终完整字符串字符数、预算和核心 overflow。字符预算不是精确 token 数。

采集与投影共用有界、递归脱敏的结构摘要；凭据字段与常见自由文本机密脱敏后再截断，拒绝无限深度/条目。不会以摘要恢复采集前已丢失的数据，旧日志字段缺失明确标 unknown。

选择算法为可解释的确定性策略：只选当前 Episode 的 effective 节点；以事实/反驳和最近工具观察提供类别覆盖，再按可信类别优先、同类最近优先填充；完整项放不下尝试紧凑项，单条过大不阻断后续短项。预算计算包含标题、遗漏统计与 footer。当前请求相关词仅作同可信类别的辅助排序，不改变事实可信度。禁止依赖某个无关章节计数结束整体裁剪。

保持每请求只有一份临时 RAM、固定 system/tools 不变、实际 toolResult 正常传给 continuation，快照不写 Session transcript。handoff 各字段按同一 Episode 过滤。真实模型任务成功率/延迟收益不由离线保真测试代替。

## 验证矩阵

| 要求 | 检查 |
| --- | --- |
| 原采集/事实/最近性/预算/交接缺陷 | 原 aegis-ram-reaudit 11 项与 SDK 5 项、ctf-ram-review 6 项，保留断言 |
| 缓存与每请求注入 | aegis-ram-cache-payload，真实 SDK+序列化请求拦截 |
| 硬预算/核心超限/精确 footer/确定性/身份去重/缩略与隐私 | 新增 aegis-ram-projection 检查 |
| 状态/有效性/未知不能变事实 | runtime-core-smoke、runtime-effective-board、observer-smoke |
| 实际换 Session/轮换 | observer-runtime-handoff、c2-session-rotation/supervisor-boundaries |
| SDK 采集敏感字段不入日志、保留正常字段与截断标记 | SDK 结构探针扩充 |

初始复跑：RAM reaudit exit 1（2/9）；SDK exit 1（2/3）；CTF RAM exit 1（5/1）；cache/core/effective/observer exit 0。证据：Pi_Agent_base/runtime/dev/ram-repair/before/。本轮不修复 E1 authority 的独立已知失败。

## 实现与实际结果

新增 `memory/summary.mjs` 统一递归脱敏/有界结构采集与显示；`Board` 保留动作 input/response/details/transport、结构化 observation 和 subject；原可信门保持。`memory/ram.mjs` 提供 `buildRamProjection`（文本+结构化统计），`buildRam` 继续返回字符串供原调用者使用。按身份去重、最新项优先，同类其余项按最多 32 个当前任务关键词相关度及最近顺序选择；不会用相关性提升可信度。

默认 4,000 字符预算保留。各节候选上限：Fact 20、Refuted 10、工具 6、提案 8、一般 Artifact 5、去重后的历史经验选择 3。候选先以紧凑形式装入，事实/反驳/工具各提供一次覆盖机会，再填充其他项，剩余空间用于展开细节；每次装入用完整渲染长度检查，不合适的单条不会阻塞后续较小项。标题和 footer 全计入预算，footer 的字符数等于最终字符串 `.length`（UTF-16 code units）。核心超预算保留责任并显式 overflow，不声称它是 provider token 计数或能绕过请求 gate。

Observer 每请求使用同一 projection 文本注入，`request.projected` 添加版本、预算、overflow、节统计。保持 `ephemeral-user-tail-v1`，每次只有一个 RAM，不改 system/tools，也不持久到 Session transcript。`/aegis ram` 不再静默裁掉 1,200 字符以后的内容。handoff facts/refuted/intents 全按当前 Episode 过滤。

| 检查 | 实际结果 | 私有证据 |
| --- | --- | --- |
| 原 RAM reaudit | exit 0；11/11（起点 2 pass / 9 fail） | `focused/aegis-ram-reaudit.log`、`final/` |
| 真实 SDK 采集/换会话 | exit 0；原 5/5，新增 RS-06/07 均通过，共 7/7、5 次 faux 请求 | `final-sdk/aegis-ram-reaudit-sdk.log`；原 5 条断言保留 |
| CTF RAM review | exit 0；6/6（起点 5/1） | `focused/aegis-ctf-ram-review.log`、`final/` |
| 新 aegis-ram-projection | exit 0；11/11 | 预算 1,200–6,000、微小预算/unknown责任、身份/false/0/结构、确定性/最近性、历史退休、敏感字段/深度/循环/转义长度、foreign/no-Episode、超大项跳过 |
| 缓存/序列化 | exit 0；10 次全 HTTP 拦截请求 | `final/aegis-ram-cache-payload/`；新增完整 footer 长度、预算与审计统计断言 |
| 聚焦核心/Observer/实际 Session 与轮换 | 11 脚本全部 exit 0 | `focused/results.json` |
| required 68 + 9 个相关补充 | 77 脚本中 76 exit 0，唯一非零为既有 single-authority | `final-results.json`、`final-names.json`、`final/`；required 68 全部 exit 0 |
| E1 single-authority | exit 1，1 pass / 12 fail，与起点报告一致 | 不是 RAM 已修结论的一部分，原断言保留 |
| 隔离 mutation：移除预算准入 / Episode 过滤 | 两者 exit 1，均为行为 AssertionError | `mutations/results.json`；产品代码未变异 |
| Campaign tsc | exit 1，194 → 189 diagnostics，无新增 | `types-campaign-{before,after}.log`，路径/行号归一化后对照 |
| Batch E tsc | exit 1，186 → 186 diagnostics，无新增 | `types-batch-{before,after}.log` |
| Biome 8 个变更代码/测试文件 | exit 0，保留原 cache payload 测试 useTemplate 信息提示 | 不降低规则或清理无关逻辑 |
| module-layout / Git diff 检查 | exit 0 | 224 文件、749 相对引用，无目录/依赖违例 |

证据根：`Pi_Agent_base/runtime/dev/ram-repair/`（ignored）。命令使用 `node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs <out> <explicit names>`，runner 自动选择现有 SDK source resolver；纯 projection 检查为 `node Pi_Agent_base/tests/aegis-ram-projection.mjs`。类型命令分别为现有两份 tsconfig，原型工具/脚本没有真实凭据或 provider/目标调用。

## 已知限制

- 选择算法是工程可验证的确定性基线；没有真实模型成功率、token 命中率或延迟对照，不能声称全局最优。
- 有界采集仍可能截断长文件/复杂 JSON；摘要和 refs 表明损失，但本轮未新增通用按引用取全文工具。旧日志未保存的内容不可恢复。
- 保留原有请求窗口 gate，不改变 Campaign 配置/账本；核心过大时显式 overflow，实际请求仍可能被 gate 阻断。
- 全历史 EventLog/Board 重投影的 CPU/IO、堆内存与增量索引仍是独立性能事项，本轮只优化候选上限及相关性分数复用，未宣称修复全系统长期性能。
- Secret-pattern 脱敏覆盖已测字段/文本样例，不是识别任意敏感数据的通用证明。
- 类型检查依旧非零；内部验证不等同于独立外部验收。E1 权威/工具执行的既有 12 个边界失败未修复。
