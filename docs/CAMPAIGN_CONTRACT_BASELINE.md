# Campaign 契约基线与 C0 收尾

状态：本轮开发协作的共享契约基线。既有用户决定继续有效；本文件澄清接口与失败语义，防止不同子 DS各自解释。它不宣称当前 C0 已经通过审计。

## 1. 当前入口条件

先收尾 C0，再实现 C1。主 DS可一次接收总任务，自行拆分小任务并派给子 DS。当前验收会话只写依据文档和最终验收，不代替实现 DS 修改产品代码。

C0 已有模块：`memory/campaign/{identifiers,registries,manifest,queue,dynamic-policy,aggregate,report,fixture,index}.mjs`。不重建第三套 fixture，也不把代码行数当目标。

当前历史检查说明：两组 C0 测试和 Biome曾通过，但外部审查发现未覆盖的语义缺陷。旧报告中的“全部通过”仅指当时已执行测试，不代表以下收尾条目已解决。主 DS先在当前工作区复核，不假定历史文件仍保持原样。

## 2. 用户已确认决定

| 编号 | 已定内容 |
|---|---|
| U1 | 第一执行环境为用户授权、监督的 macOS workspace。workspace 不是 OS sandbox。 |
| U2 | 受限动态任务扩展是核心能力，不能替换成静态队列或逐任务人工开始。 |
| U3 | Host在安全 idle/settled 边界自动轮换 Session；Session不是独立 Episode，不重置预算。 |
| U4 | 判定依赖确定性 Oracle/平台证据、人类独立核对；模型自述和工具退出码不是真值。冲突保留，不能静默靠优先级抹掉。 |
| U5 | 编码/测试后生成数据包，由用户带回当前会话；Aegis 不自动调用最终验收模型。 |
| U6 | 本地 Web UI与 Pi命令用于观察白板和任务分发，读同一 committed projection。 |
| U7 | Campaign 第一版只运行一个活动 Task/Episode。开发子 DS可在独立文件范围内并行，这不扩大运行时并行度。 |

## 3. 共用接口契约

### 3.1 Manifest 和版本

- Campaign 文档是不可变输入。开始运行后的更新需要新的 revision及显式重新绑定，不原地修改运行中的授权。
- 内容寻址副本保存 canonical JSON，非原始输入空白和键顺序；相同 JSON值生成相同字节与 digest。
- 输入是 JSON值，拒绝 function、undefined、NaN、Infinity 和循环对象；canonicalizer 不生成非法 JSON。
- 继续已有“同 major minor兼容”的策略：Campaign输入允许 `campaign-1.x`，兼容现有已测试裸 `1.x` 写法。版本字符串必须符合明确格式；不同 schema名称不能伪装 Campaign版本。未知 major拒绝。所有入口共享同一版本判断，不在准入里硬比较 `campaign-1.0`。
- “接受同 major”不意味着认识所有新功能；未知有执行意义的字段/特性不能自动授予权限。无需为尚未发生的版本写迁移框架。
- 校验函数对 malformed输入返回错误结果，不因 null/错误数组元素/错误类型抛未捕获 TypeError。
- `load`、校验、内容寻址持久化采用一致输入与返回字段。首次写入、已存在、并发相同写入的成功返回均包含 `digest`、`canonical_digest`、`path`、`existed`。
- canonical digest是规范值内容摘要。若持久化另加换行，文件字节哈希与值摘要必须明确区分，不谎称它们逐字相同。

### 3.2 ID、Stage 和权限

- 五类 ID前缀区分对象，后缀非空且使用安全字符；不接受 `task-`、路径分隔符、`..`路径片段或任意文件路径。
- 不强制旧 Pi Session/Episode UUID都改成新前缀；C2适配器应记录真实 Pi session id和 Campaign内映射，不能凭前缀声称 Session轮换正确。
- Task ID在 Campaign内唯一；Stage ID在 Campaign内唯一。Criterion ID在显式 task/stage绑定内解析，不全局模糊匹配同名 criterion。
- 目标、capability、execution/oracle refs只能引用受信任注册表与当前授权范围。Manifest声明一个名字不等于实现已经存在。
- `supervised-macos-workspace`只匹配当前已登记 workspace adapter；未实现的 container profile拒绝启用。
- `workspace_is_sandbox`显式为 false。workspace/target/capability列表都是明确类型的值，不将 number/object/空白字符串当目标。
- Stage Oracle缺省继承Task Oracle；显式 ref必须验证登记和允许范围。返回 Manifest若保留缺省字段，则所有下游只通过一个继承解析函数读取，不各自猜。
- 静态 Task可缺省 required_capabilities为[]，表示未声明额外动作要求；它不使Worker拥有任意权限。任何实际动作仍检查Campaign/task grant。
- 权限不由模型增加。注册表/授权来自Host上下文；source.kind由可信边界设定，payload里的自报来源只作声明。

### 3.3 队列和动态任务

- 初始无依赖 Task为 ready；有依赖 Task为 queued，依赖为 pending。遍历顺序不是完成证据。
- 运行依赖满足要求是可信且匹配的Task成功；调度 `completed` 标签本身不足以满足依赖。
- `queueState.tasks`是所有已知静态/动态任务，历史终态保留，按唯一 task id计数；max_task_count是Campaign总任务上限。
- 动态任务必须绑定已知父Task；若提供父Stage，Stage必须属于该父Task。
- 深度由可信父任务链推导，不接受模型自己提交depth绕过上限。纯函数可以接收Host计算结果，但必须校验与父链一致。
- 风格统一：结构非法、重复、环、超过不可扩大深度/扇出/数量上限 -> rejected；结构合法但请求新权限/目标/能力/adapter或没有可用预算 -> blocked；范围内有预算 -> admitted。原测试若把硬限制当blocked，按此契约作一次显式修正并保留真实拒绝断言。
- admission返回只是纯判断；它不代表budget已预留或任务已落盘。C1把admission和reservation放进同一个durable事件，再更新projection。
- 重复同一proposal不得重复插入任务或预留预算。C0 helper应明确幂等/拒绝重复，而非默认push。
- 稳定语义重复不只检查随机Task ID。使用父任务+目标+任务类型+规范目标/criterion+参数的身份，避免换ID重跑同一探索；不同参数或真实新证据驱动的后续任务不能被误删。

### 3.4 预算

- 总预算不可增加，所有维度必须是有限safe integer，不能通过缺字段、负值或错误类型产生额外余额。
- 任务wall-time预算总和、requests/tool额度受Campaign envelope限制；Session轮换继承累计使用量。
- 区分 consumed与outstanding reserved；reservation被消费时转移到账本，不让同一调用既扣reserved又扣consumed两次。
- remaining = limit - consumed - outstanding reservations。静态任务已分配额度也必须进入同一账本，不能只扣动态任务。
- C0纯准入接收可信账本输入；C1才实现原子预留、使用、释放和恢复。
- Wall-time采用明确时间基准。C1定义run elapsed、pause时长和恢复时间；先不把当前机器时间写进纯projection使每次重放不同。
- Token费用不可得时标unknown；C1可先用requests/tool/session/time硬限额，不编造token或美元预算。

### 3.5 Outcome 接纳与聚合

- persisted Outcome四种：success/failure/unknown/invalid。pending只属于调度/投影。
- 可信正负判断需要真实来源、criterion、observed和可解析evidence；source:oracle字符串或status:success不能独自证明可信。
- aggregate可以要求受信任 resolver/context；不要重建完整Oracle，但入口必须拒绝未确认、foreign和缺关键绑定的正负判断。
- Stage按定义的全部required criteria聚合。只完成其中一条不能Stage success；缺criterion映射不得接受所有输入当通配符。
- Task按其定义的全部required stages和task criterion聚合，不仅检查调用者碰巧传入的数组。遗漏Stage、foreign Stage、foreign TaskOracle不能Task success。
- TaskOracle绑定Task、当前Episode、level、goal criterion和scope；真实episode由TaskSupervisor/投影提供。字段缺失保留unknown或报invalid，不能猜绑定。
- contradictory success/failure对同一命题是conflict，应阻断相关路径并显示，不把“失败优先”写成已证伪方法。
- 仅transport失败/超时是unknown，不生成Refuted，也不永久封路。
- Stage成功不代表经验独立Episode；独立stage数量不能取代independent_episode_count。

### 3.6 Supersedes 的三张视图

必须区分：

| 视图 | 包含内容 |
|---|---|
| history | 原记录、所有修正提案与拒绝原因，供审计 |
| effective judgments | 当前可信Outcome，包括有效unknown |
| effective facts | 当前可信success对应的事实；unknown不生成Fact |

合法修正替代旧Outcome后，最新unknown应保留在judgment视图；它使旧Fact退出fact视图。历史审计里“unknown不增加Fact”不能错误翻译成“聚合器删除unknown”。

合法替代必须：目标在较早committed记录中存在；两边非空Episode一致；Task/criterion.expected/subject一致；相关scope存在并一致；无自环/循环/foreign绑定；修正来源与schema/evidence符合可信边界。

- canonical比较对象，不受键顺序影响；缺scope两边null不代表相同环境。
- `runtime`可记录结构，但不能独自产生Oracle判断或借此提升可信结果。
- 非法修正留history/拒绝审计；不退掉目标，不进入effective judgment，不增加独立证据。
- 独立性按可信episode/reset/isolation/group来源计数；无可信独立证据时unknown/0，不以Outcome ID数冒充独立成功次数。
- 修正链沿根Episode/独立组关联；校正次数只记合法校正，额外报告invalid correction次数。

### 3.7 报告、敏感信息和 fixture

- Report保留结构化授权摘要，credentials策略只允许none/manifest_policy；其他值拒绝或redacted，禁止恢复任意原值。
- evidence refs包含类型、ID、digest，可追溯到artifacts。仅引用数量不足以验收；非空假引用也不足。
- Report digest只排除report_digest；Bundle digest只排除bundle_digest，覆盖report_digest。
- 带文本字段用值级脱敏；大小写flag/ctf、Bearer、私钥、明确token/password/api_key赋值样本须覆盖。未知随机字符串无法仅凭正则保证不泄露，因此以字段白名单/引用边界为主。
- Bundle有实际体积/条目预算。超限分页/索引并明确缺省信息，不静默丢掉必需授权或结果；不能只有注释称bounded而没有限额。
- 输出缺失数据=null/unknown，不能填0暗示测量成功。
- C0 fixture是synthetic契约输入，不存在真实Oracle、replay或独立训练数据；replayable=false、fixture_only=true，不能用于自动active晋升。
- synthetic evidence在fixture中有明确索引或声明不可解析；测试不得把假引用当产品proof。

## 4. 当前 C0 收尾清单

主 DS先阅读现代码，逐项复现。清单是已观测问题与相邻契约的集中收尾，不按发现一个bug补一个if的方式推进。

| 编号 | 必须处理/证明 |
|---|---|
| CLOSE-01 | 非法/LLM/foreign/malformed correction不进入effective判断，不影响可信Stage/Task。 |
| CLOSE-02 | 双方缺scope或episode不得合法supersede；对象键顺序不影响等价判断；cycle/forward引用拒绝。 |
| CLOSE-03 | credentials仅枚举策略可见，其他值不能在report/bundle被恢复。 |
| CLOSE-04 | TaskOracle绑定当前Task/Episode/criterion；缺/foreign/模型自报不能成功。 |
| CLOSE-05 | 非法correction不增加独立组，合法修正链不制造新Episode证据；未知不能伪装验证成功。 |
| CLOSE-06 | 空ID后缀拒绝，Stage ID跨Task唯一，现Pi ID映射不靠改UUID解决。 |
| CLOSE-07 | Manifest与dynamic/version入口共享策略；持久化所有成功分支返回字段一致。 |
| CLOSE-08 | Stage全部criteria与Task全部required stages检查；遗漏部分不能被success短路。 |
| CLOSE-09 | legal unknown保留Outcome语义且旧Fact失效；不是无条件删除unknown。 |
| CLOSE-10 | data usefulness需要真实data->Action->verified stage引用，不能仅三个truthy输入。 |
| CLOSE-11 | 静态/动态预算账本一致；重复admission/helper调用不双重预留；parent stage/depth属于可信父链。 |
| CLOSE-12 | 验证器处理null/错误类型/非法JSON值，报告证据映射与数据包限额明确。 |

其中C1运行时原子账本、事件持久化、进程所有权留C1；C0只固定接口和可测试的纯判断。不能为收尾提前实现完整Scheduler。

## 5. 本轮默认工作范围

允许主 DS按新流程完成C0 Closure，再自主推进C1内部小任务至可审查结果。C2–C4a不自动启动；主DS可提前形成接口计划但不实现真实Session/Broker/WebUI。

C0修复可改现Campaign模块和相关测试，新增共享测试数据/测试脚本/类型配置和交付文档。C1复用现EventLog，尽量不修改现runtime库；如确需改变共享库接口，先列出兼容影响与受影响回归，只在不改变已定架构时由主DS统一完成。

### C1事件词汇修正

早期回复建议`event_type=note`，但当前runtime EventLog登记的是`runtime.note`，并未登记裸note。C1应采用已有`runtime.note`（event schema 1.1）加`payload.kind=campaign.*`，不修改schema1.0冒充兼容。

Campaign数据结构版本与event schema版本是两件事。Host写结构事件，Oracle仍写outcome.recorded；模型只能提交proposal。kind、字段、来源、命令ID、前置版本在C1-A冻结，不把任意未知campaign.*当有效转移。
