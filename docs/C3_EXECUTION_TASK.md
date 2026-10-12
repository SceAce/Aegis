# C3 任务书：Campaign 的 Broker / Oracle 执行闭环

状态：**planned / 待委派实施，本次仅规划**。
前置 C1/C2 已按冻结范围验收，见 `C1_F14_EXTERNAL_ACCEPTANCE.md`、`C2_EXTERNAL_ACCEPTANCE.md`。
实施时基于最新已提交状态，不重开历史阶段。路线见 `CAMPAIGN_NEXT_PHASES.md`。

## 1. 冻结目标

交付一个可复现的 Aegis-owned Campaign Host 入口，把现有模块接起来：

```text
trusted Manifest/registries → C1 scheduler/Worker
→ registered ActionContract → authorization/state checks
→ durable action.requested → existing Broker → local effect
→ durable action.completed / evidence → independent Oracle
→ bound Stage/Task Outcomes → C1 completion/dependency
```

接入已有 C2 supervisor 的安全轮换调用与账本归属。明确产品入口的启动命令、Manifest/目录
参数、pause/cancel/退出与恢复方式，用户不应手工拼 factory helper 才能运行。
真实 SDK 使用 faux provider；真实效果限定临时本地 workspace。单活动 Task/Episode。

## 2. 复用与责任

- C1 scheduler/projection/ownership/EventLog 继续拥有队列、任务控制、durable truth；
- ActionContract/ActionRegistry/createActionBroker/authorization/script-registry 继续执行已注册能力；
- action-runtime 与 Observer 的单 writer 边界可复用，不另开 EventLog writer 导致链分叉；
- Oracle 通过人类/可信代码注册，不由模型 payload 自报 source 获权，结果进既有 resolver；
- C2 supervisor 通过 Host 生命周期调用，不要求 Pi 核心修改；Host 明确 C1/C2 预算唯一计量源。

主 DS先全文读实际修改模块/调用者，列契约/owners/日志调用顺序；既有组件只补必要接线。
Campaign 的 metadata registry 不等于 executable adapter 已就绪；只有实现存在且被 Host 注册才执行。

## 3. 最小实现范围

### A. 产品 Host 和执行适配器

- 先隔离 fixture adapter：在显式临时授权目标上读取/修改确定性状态；不是新一套 fixture 框架。
- 再复用 script-registry 实现受监督 macOS workspace adapter：固定 executable/argv template、
  版本/digest、data-only 参数、cwd/target、env allowlist、timeout、network/credential 策略。
- 模型只能提出已注册 action_ref 和数据，不能传 executable、shell/eval、Oracle 回调或授权对象。
- Campaign/Task grant 在 Broker 执行边界求交并重查；readonly 也不能任意读凭据或越界。
- 在本 Campaign 产品模式，模型的 direct bash/write/edit 或其他未注册动作不能绕过 Broker。
  用真实 SDK/faux tool call 断言效果未发生；工具列表隐藏不是唯一的准入证明。
  限定 Campaign 模式生效，不顺手改写普通 Pi 全局行为。
- workspace 不是 sandbox；禁网络的声明不等于 OS 隔离。不提供任意第三方进程隔离承诺。

### B. Oracle 与持久效果边界

- 只需一套确定性本地 Stage/Task Oracle，以及同一接口的 delayed/unknown 支持；真实平台联网后置。
- Oracle 实际读 artifact/后置状态，不以 worker.ok/exit=0 判成功；Task/Episode/Stage/criterion/scope/
  provenance/evidence refs 可被现有 resolver 解析。工具失败与任务失败分开。
- effect 前 intent 必须 durable；任一 append/fsync 失败不调用 adapter。
  effect 后记录失败停止新 effect，留 pending/unknown，恢复先观测/reconcile，不重发非幂等动作。
- delayed result 初次 unknown 阻止依赖；迟到结果合法关联后可推进，不重跑原 Worker 产生结果。
- 不改顶层 Event/Outcome schema，不创建第二种事实模型；必要 campaign payload/接线由主 DS统一管理。

### C. C2 与账本接线

- Host 在安全 idle/settled 边界调用现有 supervisor；新 Session 保持真实 Task/Episode/授权/Stage。
- 轮换使用现有 policy/明确的测试触发条件，不自创默认 Session 次数限制。
- 明确预算基线对应的 committed 位置和范围，选择唯一 charge 所有者；基础消耗与完成事件增量
  不重复相加、不遗漏跨 Task/Episode 的实际 Session 使用。公开预算账本与本次 charge 的来源。
- 已知 synthetic dispatch cost 在 fixture 可保留 synthetic 标签；实际请求/tool/session 计数使用
  已观测事件，无法观测的 token/金额为 unknown，不靠任意常数称实际计量。
- 原 helper 契约在集成处适配，不以接线为由重审 C2 或重构 F16 cache。

## 4. 冻结 required 测试

| ID | 场景 / 产品入口 | 必需观测 |
| --- | --- | --- |
| C3-POS | 两个静态任务经 Host → Broker → 本地 effect → Oracle | 实际文件效果、Action/Evidence/Outcome 可追溯，全部 required Stage 通过才 Task completed/依赖释放 |
| C3-DYN | 模型/faux 提案经真实 submitted/admitted 创建动态任务 | 从 projection 解析定义、授权/预算持续受限，实际经同一 Broker 分发，不预置 ownedTasks 冒充动态 |
| C3-DENY | 未注册/越权/foreign target 或 digest/参数变更；direct Pi tool 绕行 | 拒绝原因可见，adapter/文件/子进程效果为零；合法正例仍运行 |
| C3-DUR | intent 之前 append/fsync 失败；effect 后结果记录失败 | 前者无 effect，后者停止新 effect、保留 unknown/pending；真实 EventLog 与效果计数 |
| C3-ORACLE | transport success 但目标不满足；foreign/missing evidence；delayed 后合法结果 | 不假成功、依赖不提前执行，迟到判定推进时 worker 不重跑 |
| C3-REC | intent 后中断、重启读取真实 artifact reconcile | 不盲重复非幂等效果，绑定当前任务，unknown 保留；必要边界用真实子进程/barrier |
| C3-SESSION | 真实 SDK/faux 运行期间一次安全轮换及累计账本核对 | 产品 Host 真调用 C2、新 context、同 Episode/授权，预算只计一次、耗尽后拒绝 |
| C3-REG | C1 required/C2 和受影响 Broker/Observer 回归 | 保留已验收行为；F16 单列 deferred，不要求全目录 wildcard 全绿 |

用例可合并到少量产品场景，不要求逐项独立文件或所有故障全组合。
至少一个真实 SDK/faux 产品路径，真实 EventLog/临时效果；证明层级明确，不拿纯 helper 测试
代替产品接线。先 red 再实现，必要的少量 guard mutation，无固定数量配额。

## 5. 内部里程碑与停止条件

C3-A 契约/Host → C3-B fixture/Broker/Oracle → C3-C workspace/delayed/reconcile/C2 → C3-D 集成。
主 DS在一次委派中按依赖完成，shared projection/Observer/入口改动由主 DS管理，子任务不交叉改文件。
没有子 Agent 工具就串行如实报告。每个可审查单元提交 Git，不逐小任务请求外部验收。

只对上述核心执行/授权/证据/账本损害阻塞；F16 性能、UI、报告美化、平台扩展都后置。
新增需求必须证明不能安全后置，不以“全面完善”扩大本阶段。
不修改 embedded Pi、凭据/模型设置、lockfile，不引入新依赖/真实模型/真实网络/外部目标。
规划不是这些操作的额外授权。

## 6. 交付

新增/复用简洁 `C3_EXECUTION_WORK_PLAN.md`、`C3_EXECUTION_TEST_MATRIX.md`、
`C3_EXECUTION_IMPLEMENTATION_REPORT.md`，不为每次小修建立全套长报告。
报告附产品启动/恢复命令、接口/实际文件、required/deferred、red/green、命令/exit/log、
本地分支/commits/status、效果/证据与限制，日志放 ignored runtime/dev/。
按 GIT_STANDARD 新建 `feat/c3-execution` 等任务分支、明确路径暂存和审查、本地 commit，
不 push/改写历史、不混入无关改动。完成标 internally_verified / awaiting_external_review，
交一次限定 C3 验收；不自动进入 C4/真实能力实验或调用验收模型。
