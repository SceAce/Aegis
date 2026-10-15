# E1 契约闭合测试矩阵

版本 `E1-CC-1.0`；状态 **planned**。依据：`E1_CONTRACT_CLOSURE_TASK.md` CC01–CC10，
以及 `SYS-20261015-01` B01–B14。本轮只编写规划，以下 **66 组全部 actual=not_run、exit=null、
evidence=null**；表中旧代码列是历史证据或 S0 预期，不能当本轮实跑结果。
DS 按子例逐项实现，完成后在实施报告建立机器可读结果索引；不得用一个组名的通过隐藏子例缺失。

## 1. 运行约定、原始输入和独立 expected

| 缩写 | 输入/运行入口 | 证据要求 |
| --- | --- | --- |
| F | 已有 task-family Manifest、Host builder、固定注册模板/原始候选；离线纯函数/真实持久化 | 原始输入、手写预期字段/数值、前后输入不变、完整 reasons |
| P | `runC6FromConfig` 实际产品入口 + 真实嵌入 SDK/faux + EventLog/Broker/独立本地 Oracle | 实际 provider 计数、工具计费与调用计数、效果文件/内容、committed 流、独立 readonly 子进程 |
| M | P 的真实合法流，在指定 prefix 单点变更并重新计算链；重放/Board/readonly | 保存故障位置/原字段/变更字段、verifyChain、接受/拒绝/预算/Fact 集合 |
| X | 新真实子进程，IPC/barrier 精确停在持久边界；kill/restart 或前缀恢复 | PID/边界确认/退出信号、重启计数、文件、前后责任账和副作用；不靠固定 sleep |
| V | P/M 输入送入真实消费者：RAM、Observer 两处 rebuild、supervisor、learning、报告/HTTP | 捕获实际产出，负例不被 selected evidence/Fact/依赖使用；不是只验证传参 |

每组还需保存：`case_id/subcase_id -> CC/B -> 实际入口/argv -> expected -> actual -> exit -> log`。
输出统一落新的 ignored `Pi_Agent_base/runtime/dev/e1-contract-closure/run-*`，目录不得复用旧证据。
`PASS/FAIL/BLOCKED/NOT_RUN` 分开；一个 required 子例失败/blocked/not_run 即该组不能 PASS。
适合参数化的子例可共用进程/fixtures；正常产品证据、跨进程恢复和故障效果不得只用纯 helper 替代。

expected 必须在实现前由本任务契约写成独立常量/手工关系断言，不能调用待测 normalize/compiler/
resolver 生成答案。正例可使用产品 builder 创建输入，但至少独立检查关键字段、具体预算和效果。
M 是可信 Host 环境下“链完整但业务无效”的反例，不声称抵抗恶意本机伪造完整日志。
若新接口在旧代码不存在，import error 只记 harness 未就绪；S0 行为 red 优先走旧公开入口和已有审计。

脚本映射固定：C→`aegis-e1-closure-contract`，A→`aegis-e1-closure-admission`，
J→`aegis-e1-closure-judgments`，R→`aegis-e1-closure-recovery`；路径均为
`Pi_Agent_base/tests/<脚本名>.mjs`。新四脚本当前未创建，DS 负责实现。
旧代码列中“待 S0”是尚未证明该反例在旧实现失败；“保留”表示兼容正例/已有保护必须继续通过。

## 2. Contract：16 组

| ID / CC | 输入、入口及操作（所有分号子例必测） | 独立 expected / 关键证据 | 旧代码 |
| --- | --- | --- | --- |
| T-C01 / 01 | F/P 创建新 E1，写 immutable Manifest，再启动；首次/已存在/并发同内容分支；模拟 write/fsync/目录 fsync/非ENOENT读取失败 | canonical 副本含完整 contract，digest 重算相等；全部失败先于 provider，0 新请求/效果；每个成功分支均确认durable，不覆盖半写残留 | contract 缺失；其余待 S0 |
| T-C02 / 01 | F 改 config 的模板 scope/fingerprint/criteria/能力/root 或 policy；已有日志 resume；readonly | resume planning_context_conflict，0 新请求/效果；readonly 原副本诊断可见；展示字段变化不影响语义 | 待 S0 |
| T-C03 / 01 | F 完整 Manifest 同 Campaign/revision 改内容；副本缺失/重复绑定/损坏；空日志合法新 run | 有历史不能重初始化或选 mtime 最新；hold；空日志仅 Host 合法输入可创建 | 待 S0 |
| T-C04 / 01 | F 重排对象键、模板集合；缺 fingerprint/空 scope/空 criteria；重复 template_ref/歧义 task_type alias；major 未知 | 合法集合规范化摘要稳定；原始 criteria 文本不裁剪冒充另一条；歧义/缺项/未知 major 拒绝；未知扩展不授额外权限 | 待 S0 |
| T-C05 / 01,03 | F templates 未覆盖 root required；越界 capability/Oracle/adapter/target；base task_count/depth/budget 不足；同批三子在原fan-out2与显式测试Host fan-out4分别准入；原四子非法target场景显式总数5 | 创建失败且理由精确，绝不自动扩大 base；三子在2下rejected、4下admitted；原illegal_plan在fan-out4/总数5下因原target blocked，三维预算不变 | 待 S0 |
| T-C06 / 01,10 | F/M 旧 E1 无 contract/部分 contract/无 binding；非 E1 静态旧 Manifest | E1 仅只读 legacy_context_unavailable，0 新请求/效果，不迁移私有旧数据；非 E1 原合法执行保留 | 新显式兼容门；静态保留 |
| T-C07 / 02,06 | F normalize：static 预算缺全部/单维、0、null别名；合法 plan/proposal 三维齐全；规范结果再次normalize | static 缺维归0，不回退 Campaign；plan/proposal 两预算别名同值；重规范同值，输入不 mutate | HA-02 实证关联 |
| T-C08 / 02 | F 动态预算每个必需维逐个 missing/null/string/negative/fraction/NaN/Infinity/unsafe；task_budget 和 reservation 冲突/逐维残缺 | 全部 rejected，不能按 truthy/默认0/逐维拼凑；合法0可定义但消费门不放行 | 待 S0 |
| T-C09 / 02,03 | F 已规范化 Task 每个可执行字段单改，含parent_stage/expected_evidence/stop_condition/priority；同时改内容和自报 hash；对象键重排 | 原有效字段不丢；task_digest 覆盖全部字段含 order、identity、scope、两个预算；键重排不变；自报新 hash 不代替重编译 | CA-08 实证关联 |
| T-C10 / 03 | F candidate 摘要对象键重排；tasks 数组交换；内层 candidate.plan_id 改且重算摘要 | 原 planDigest 算法不变；键序无关/数组序敏感；内外 ID 不同整批拒绝 | CA-09 FAIL |
| T-C11 / 03 | F 整图自环/双环/长环、未知 parent/dependency、跨 Task Stage、重复 Task/Stage ID；同批数组后位依赖 | 无效整批拒绝；后位合法 DAG 可编译且按依赖执行，parent 不自动成为 dependency | 旧图保护保留/扩展待 S0 |
| T-C12 / 03,06 | F 每维累计恰好/多1、求和超 safe integer；任务总数/深度/扇出边界 n/n+1；同时硬结构错和预算不足 | 精确边界通过，预算不足 blocked，硬结构上限/非法/溢出 rejected，混合错rejected优先且原因齐全；无局部定义或预算变化 | HA-03 关联 |
| T-C13 / 01,03 | F 合法 criterion 子集覆盖全 root；一个子任务新增未注册 criterion/省掉 root criterion/外来 root；相同合法文本 | 子集且整图覆盖才通过；foreign-root 保留候选、不生成定义 | HA-04 FAIL |
| T-C14 / 03 | F normalize/compile/evaluate 对同输入重复，冻结输入，禁止磁盘/当前 config/时钟访问 | 输出同值、输入不变、失败 next_state 与旧权威字段相等；理由顺序稳定 | 待 S0 |
| T-C15 / 02,06 | P 普通 dynamic proposal 从现有入口新增合法 Task；越界/预算不足/重复 proposal | 保留原扩展能力，执行 Task 使用同一 task_budget，累计 allocation 不双扣；不以关闭该入口回避 | 既有 proposal 正例保留 |
| T-C16 / 03,08 | F/M outcome/artifact 证据：可信预置 registry 索引；先有事件 artifact；未来同 ref 不同 digest | 明确可信预置来源可用；事件 evidence 只到当时 prefix；未来内容不能覆写过去证据 | 待 S0 |

## 3. Admission 和预算：18 组

| ID / CC | 输入、入口及操作（所有分号子例必测） | 独立 expected / 关键证据 | 旧代码 |
| --- | --- | --- | --- |
| T-A01 / 03,07,10 | P 完整正常计划，删除派生物后 readonly 重建 | 实际 SDK/faux 8 requests、3 Broker effects，最终 dataset={name:Ada,status:active}；planning2、每子2；独立 Oracle、completed、ready 有序且零 pending/unresolved | CA-01/HA-01 CONTROL 保留 |
| T-A02 / 03 | M submitted/admitted 分别缺 planning_task_id；双方缺；空值、foreign Task、Episode/Session 互换 | 无有效 admission、动态定义与动态 allocation 为0；候选/理由可见；不补 task-plan | CA-06/07 FAIL |
| T-A03 / 01,03 | M submitted/admitted/ready 分别缺或错 binding_version/revision/manifest_digest/context_digest；source LLM/agent/observer 冒充转移 | 原候选可记录；每条无效转移拒绝且后续不授权，不把 source=runtime 单独当业务合法 | 待 S0，原来源门保留 |
| T-A04 / 03 | M candidate/envelope/admitted 的 plan_id 逐对错配；digest 缺/错；admission 在 submitted 前 | 整批不准入，0动态 allocation；没有合法 prior submitted 不能追认 | CA-09 FAIL |
| T-A05 / 03 | M normalized target、criterion、scope、Oracle、依赖、parent、budget、Task ID、order、未知执行字段逐项改；增删任务；同时重新 hash | 与可信重编译不等即拒绝整批；保留静态账，不得只验摘要形状 | CA-08 FAIL；扩展待 S0 |
| T-A06 / 04,05 | P tool 提交后 Host admission；直接 Host admission；重送完全相同 plan/事件 | submitted 恰写一次；admit_plan 返回 accepted admission，duplicate 引用原 event/prefix；定义/allocation/ready 不翻倍 | CA-10 CONTROL 保留 |
| T-A07 / 04 | P 分别 submitted/admitted/ready append 返回 ok:false、durable:false、throw；append 已写但调用未获确认 | 命令 ok=false/incomplete，标确切边界，不 dispatch；恢复只按确切已提交 prefix 判定；不把 durable rejected 当成功 | 既有故障门保留/扩展 |
| T-A08 / 04,05 | P 同 planning 连交 A合法/B合法；A非法/B合法（不同ID）；A合法/B非法；同ID改内容再恢复原内容 | 首个合法 admission 固定 active_plan；后拒不覆盖；无效候选不占名额，同ID新内容不能替代原绑定；已准入A在A'冲突后原A仍duplicate，不自冲突/不双扣；按物理提交序 | HA-03 FAIL |
| T-A09 / 04,05 | P 两个 Promise 同时 admit 不同批；并发 record/admit/pause；嵌套 Host 回调 | 最新 prefix 决策，最多1 admitted、单活动Task；不死锁，不跨 provider 等待持锁；pause 后不新 dispatch | 待 S0 |
| T-A10 / 05,06 | P/F Campaign请求100/planning8/三子各20；重复/第二批；Campaign20/planning8/子总12或13；释放/完成/取消后再提案 | allocation 首批68、重复68、第二批不128；12恰好、13blocked；release不抹历史 allocation；synthetic与actual另账 | HA-03 FAIL |
| T-A11 / 02,06,07 | P 三子 Task 请求额度各1，均合法准入；真实两请求 SDK loop | 三动态定义保留；任何子请求≤1，broker_effects=0；保留已消费和预算停止，不改成拒准入绕过 | HA-02 FAIL |
| T-A12 / 06,07 | P Task请求0/1/恰好2、Campaign不足/恰好；多 continuation/轮换；joint 第2侧拒绝/partial commit | 两侧 gate 在真实 dispatch 前；未发内存 hold可取消，已发责任不可释放；pending和unresolved独立、Session不重置 | 旧 C6 三事实保留 |
| T-A13 / 06 | P read/submit/decision/实际其他白名单工具逐项；tool额度0/1/2；decision多action及无action，均组合propose_task；缺ledger | 每个入体单位有 Task+Campaign门；decision按action逐1，无action1，read/submit各1；全部拒绝时proposal也不入buffer，部分获准只写一次共享proposal；不重复收wrapper | 新接线；待 S0 |
| T-A14 / 06 | P c6.tool charge 前/后持久失败；Task足Campaign不足/反之；已调用返回错误 | 双侧 charge 原子、durable 在工具前；失败0新调用；错误不退费；charge后crash可收费但不谎称实测执行 | 待 S0 |
| T-A15 / 06 | M/P 同去重键重复/换工具、参数摘要或绑定冲突；不同request同SDK调用ID；不同unit；finished无charge；foreign source；request重复带旧tool_calls；new E1混legacy；同message多工具/重复toolCall ID和延迟pendingCommit/commit失败/合成message；direct正例 | 同键原charge最多各侧1；冲突不改账；不同request为新单位；无结果重复不执行；durable-charge run不双计旧聚合，混协议hold；绑定原请求且await commit，按原工具序，无请求不入体，同message重ID整批零工具；direct不造工具调用 | 待 S0 |
| T-A16 / 06 | P 注入时钟：Task/Campaign deadline-1/等于/+1；排队/暂停/轮换/重启；回拨；缺/坏started时锚；deadline安全加法溢出 | now<双deadline才放行；排队不耗Task时间、已启动deadline不重置；回拨/缺锚/溢出hold；timestamp不加作duration | 待 S0 |
| T-A17 / 07 | P admitted后正常settlement但termination error/aborted/unknown；pending0但unresolved1；tool-result writer失败 | 无ready、无子请求/效果；各侧已消费不丢；合法候选不掩盖终止/持久错误 | 已接受 C6/A 保护保留 |
| T-A18 / 07,08 | P/M 多required criterion/Stage，缺一/unknown/非独立伪Oracle/仅completed；正常完整证据但ready未durable | 缺任一门不激活；正常完整所有门+durable ready才激活；不得用当前completed标签回填证据 | 原 A/Oracle 门保留 |

## 4. Judgments 与全部消费者：16 组

| ID / CC | 输入、入口及操作（所有分号子例必测） | 独立 expected / 关键证据 | 旧代码 |
| --- | --- | --- | --- |
| T-J01 / 08 | M/V 真实dyn-a Stage和Task判定 scope fingerprint foreign/缺失/双null；合法对照 | queue拒绝项不进Board Fact/RAM/selected evidence/依赖；合法精确scope保留 | CA-02 FAIL |
| T-J02 / 08 | M/V criterion未注册/foreign Stage/Task/Episode/subject、缺必需绑定；合法对照 | 同一个 rejection 贯穿消费者，不以非空文本或同名ID通过 | CA-03 FAIL；扩展待 S0 |
| T-J03 / 08 | M/V evidence空/不存在/错digest/错ref type/只有模型自述；正确独立证据 | 非法不得Fact或满足required；合法Oracle完整证据可Fact | CA-04 FAIL |
| T-J04 / 03,08 | M/V rejected admission后原raw started/outcome；rejected started；Outcome提前到定义/started/evidence之前 | raw历史不能建可信索引；未来合法定义/事件不追认过去；零对应Fact | CA-05 FAIL |
| T-J05 / 08 | M/V 合法unknown/invalid；success→合法unknown修正；再合法success修正 | unknown/invalid在accepted history/effective judgments可见；unknown退旧Fact、不新增Fact；修正后可恢复合法Fact | 既有 Board修正保留/集成待 S0 |
| T-J06 / 08 | M/V supersedes foreign/null/forward/self/cycle/LLM/subject或scope错；不同status修正各测 | 修正拒绝并有理由；原Fact不退役，原判断仍参与聚合；不是看到supersedes就删除 | 原修正保护保留 |
| T-J07 / 08 | M 同outcome_id同内容重复/不同内容；不同ID同命题success+failure无合法修正 | 同内容幂等；同ID冲突不覆写；命题冲突保守unknown/invalid、不任意last-write成功 | 待 S0 |
| T-J08 / 08 | P/M required Stage c1+c2、多个required Stage；缺一/unknown/invalid/合法修正退一 | 完整有效集且原Task聚合规则满足才dependency_satisfied；不能只数Outcome或单个Stage | 原 required 门保留 |
| T-J09 / 08 | M/V 普通 failure；具有具体证伪对象的合法 Refuted；observed不满足criterion的success | failure保留失败判断但不自动Refuted；Fact仍需observed真满足，Refuted遵原规范 | 原语义保留 |
| T-J10 / 08 | M trusted environment.changed影响一scope；foreign/无权限环境事件；已completed和未启动依赖 | 仅适用事实失效；历史不抹去；未启动依赖退queued且不能dispatch；不重放已完成副作用 | 待 S0 |
| T-J11 / 08 | P 对活动Task的前置有效Fact追加合法unknown/失效，然后尝试下一请求/Broker效果 | 历史消费保留，在下一边界hold；不能只改UI；已在途动作不宣称可撤回 | 待 S0 |
| T-J12 / 09 | V 真C6 prompt前RAM provider、E1View、taskgraph，同一M拒绝输入/合法输入 | 实际RAM无被拒Fact，图形定义不从raw补造；合法Fact仍可见；不用spy传参替代产出断言 | 弱Board路径已复现 |
| T-J13 / 09 | V c6-learning和runtime learning生产fallback，两入口逐一；候选编译/选择链 | rejected Outcome不成支持证据，不错误选用；合法既有replay/Compiler路径仍可用，未声称学习效果 | 接线待 S0 |
| T-J14 / 09 | V Observer初始化rebuild及每请求verify/rebuild；supervisor/handoff/换Session | 所有实际Board同源，unknown不丢，Session不增加独立Episode；不递归/循环import | 接线待 S0 |
| T-J15 / 09 | V 独立readonly/status/export/measure、report-entry、HTTP observation；坏源与正常源 | 无SDK/provider/effect/append；集合/预算/拒绝理由同语义，有界脱敏且unknown/截断可见 | 正常只读保留/一致性待 S0 |
| T-J16 / 08,09 | F/V projectBoard无Manifest处理Campaign judgment；普通非Campaign既有事件；无/foreign context | Campaign只Artifact/diagnostic，无verified Fact或学习授权；非Campaign原合法语义保持 | 待 S0 |

## 5. Recovery、故障序列和交付：16 组

| ID / CC | 输入、入口及操作（所有分号子例必测） | 独立 expected / 关键证据 | 旧代码 |
| --- | --- | --- | --- |
| T-R01 / 03,07,10 | X 从P的合法ready前缀在新进程resume，初始业务文件重置为原对照 | 6新faux请求、3新Broker效果、正确dataset；历史planning消费延续，正常恢复不能被全部禁用 | CA-11 CONTROL 保留 |
| T-R02 / 03,10 | X 同前缀submitted/admitted双方缺planning ID；单方缺；错normalized内容 | 0新provider、0新效果；诊断明确，历史已消费保留；不能把正常恢复也改成0 | CA-12 FAIL；扩展待 S0 |
| T-R03 / 03,07 | X buffer-only/submitted-only/admitted-only/settled但termination未知/completed无ready前缀分别恢复 | 分别保留已durable事实，零子请求/效果；没有哪项可推导missing ready；不自动写repair记录 | 原 A 保护保留 |
| T-R04 / 03,10 | X 同一合法流逐物理前缀完整重放；打乱跨Episode sequence数字但不改物理序；非法prefix逐项对比live | live/replay accepted定义、active_plan、allocation、effective集和拒绝一致；sequence不重排真实因果 | 待 S0 |
| T-R05 / 10 | X 删除/篡改checkpoint plans/ready/definition/allocation；stale/foreign/坏JSON；报告/store删后重建 | E1 used_checkpoint=false/e1_full_replay_required，结论只取完整源；无cache授权；真实非E1安全cache正例仍保留 | 新安全选择 |
| T-R06 / 10 | F/X 仅tail+priorState未给full source；manifest含contract但尚无plan；只存在model_plan标记 | 缺full source返回full_replay_required不dispatch；contract/事件/定义任一E1标记即不使用不完整cache | 待 S0 |
| T-R07 / 10 | X JSONL中间坏行/末尾半行/断链/重复冲突event ID/不明major/读失败；合法已验证前缀可观察 | 整流不用于继续执行，0新增效果；不滤坏行/自修链；已发生历史效果与消费不清零 | 原日志保护保留/入口扩展 |
| T-R08 / 06,07,10 | X provider reservation durable前SIGKILL；durable后返回前SIGKILL；结果已durable、checkpoint前SIGKILL | 首者0调用；后者不盲重发、pending/unresolved保守保留；结果已durable不重复效果；真实barrier证据 | 旧lifecycle restart保留 |
| T-R09 / 06,10 | X c6.tool charged前/后但tool体前；tool体返回但finished前；finished durable后分别有/无可验证原SDK持久结果恢复并重复execute；正常ready恢复对照 | 未charge不执行；durable charge恢复各侧1、不自动重放；无finished hold；finished不替代结果，同键重复无结果hold，有结果只复用；普通ready无需重执行旧工具，仍6/3；计费不丢/不双扣 | 新协议待实现 |
| T-R10 / 04,07,10 | X admitted/Oracle/completed/ready各边界write失败或kill；合法ready写完返回前kill | 缺任一durable门零子调用；完整ready可正常继续；恢复按源不按上次返回值；无重复分配/副作用 | 既有A故障门保留/扩展 |
| T-R11 / 04,10 | X 同Campaign第二真实进程争writer；活writer长暂停；旧owner死亡后恢复 | 仍单writer/单活动Task；不能因heartbeat超时抢占活owner；不扩大分布式承诺 | 原ownership保留 |
| T-R12 / 06,08,09 | X Task中间轮换Session/暂停/重启，联合责任一侧已消费、另一侧未决；同时存在合法unknown修正 | 数字/锚/effective集延续；不把pending0当结清，不增独立Episode；换Session不恢复失效依赖 | 原三事实保留/组合待 S0 |
| T-R13 / 03,05,08 | F/M 有界命令序列组合：提交/重送/冲突/准入/修正/ready/暂停；两ID、两Episode、两scope；固定种子 | 每步独立不变量：≤1有效计划/活动Task、不越额、拒绝不供Fact、门前零子dispatch；保存最短失败序列 | 待 S0 |
| T-R14 / 03,05,06,08,10 | 在隔离副本有限mutation：跳过planning身份；预算回退Campaign；后候选覆盖；弱Board；信E1cache；跳过tool durable charge | 对应A02/A11/A08/J01/R05/A14必须因行为断言FAIL，syntax/import FAIL不算；主工作树无mutation残留 | 新实现后执行 |
| T-R15 / 10 | 运行required清单68脚本、逐修改路径Biome、两个tsconfig与diff检查；新helper覆盖核查 | required脚本无skip/blocked、均exit0；types按诊断逐项比较无新增/恶化，不把历史非零报pass；命令/日志/exit齐全 | 历史62通过，审计2失败；本轮未跑 |
| T-R16 / 09,10 | S4全文diff与调用点审查；校验矩阵子例结果、fixture迁移、文档与Git、限制/后置项 | 接口/入口/CC/case/证据可追溯；旧独立断言未削弱；只可internally_verified/awaiting_external_review；未闭合则changes_required | 待 DS 交付 |

## 6. 旧独立审计到本轮映射

| 旧 case | 本轮覆盖 | 预期保持/修复 |
| --- | --- | --- |
| CA-01 / HA-01 | T-A01 | 8 requests、3 effects 正对照 |
| CA-02 / CA-03 / CA-04 | T-J01 / T-J02 / T-J03 | 被拒判定零Fact并贯穿消费者 |
| CA-05 | T-J04 | raw admission/start不能建立有效身份 |
| CA-06 / CA-07 | T-A02 | 单方缺planning身份整批拒绝 |
| CA-08 / CA-09 | T-A05 / T-A04、T-C10 | 候选与规范化执行定义精确绑定 |
| CA-10 | T-A06 | 完全重复幂等 |
| CA-11 / CA-12 | T-R01 / T-R02 | 正常6/3，坏身份0/0，新进程真实恢复 |
| HA-02 | T-A11 | 合法分配1仍准入，每Task实际≤1，效果0 |
| HA-03 | T-A08 / T-A10 | 一次有效计划、所有prefix不越allocation envelope |
| HA-04 | T-C13 | foreign root候选保留，planning请求2、动态定义0、效果0 |

旧 assertions/expected 不得改。合法测试输入若因新contract必需适配，只允许通过真实builder/Host
升级测试fixture构造和上下文接线，在报告逐处说明；不能添加“无contract则略过断言”或改负例为正例。
若实际旧fixture与本任务核心规则存在不可同时满足的冲突，保留red并报告具体输入/规则，不能静默篡改基线。

## 7. 结果记录最低结构

```json
{
  "case_id": "T-A11",
  "subcase_id": "task-request-limit-1",
  "requirement_ids": ["CC02", "CC06", "CC07"],
  "script": "aegis-e1-closure-admission",
  "entry": "runC6FromConfig -> actual SDK provider boundary",
  "expected": {"dynamic_tasks": 3, "per_task_request_max": 1, "broker_effects": 0},
  "actual": null,
  "status": "NOT_RUN",
  "exit": null,
  "evidence": null
}
```

expected/actual 采用足够表达本子例的结构，不能只有ok布尔值。
实际 SDK/faux、纯fixture、真实进程、HTTP观察与mutation分别标验证层级。
S4报告新旧实现red→green、每组所有子例的覆盖、68脚本结果与未测限制；不写保证零bug或全仓安全认证。
