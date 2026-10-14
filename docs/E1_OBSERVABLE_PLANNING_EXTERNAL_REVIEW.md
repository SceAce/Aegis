# E1 可观察规划：外部复验

日期：2026-10-14。产品基线：`feat/c6-agent-product` / `c9ed6b4`。
结论：**changes_required**。本轮保留已接受的 C6 三事实修复；E1 自动拆分、验收与观察的
产品接线尚未闭合，暂不进入自动规划执行的真实 CTF run。

本轮仅新增验收测试、扩展离线测试 helper 和记录审查结果，未修改产品实现。
没有调用真实 provider、凭据或真实目标。证据均来自真实 Pi SDK + faux、真实 Broker、
独立本地 Oracle、真实 EventLog，以及从实际耐久事件前缀启动的新进程。

## 1. 已成立的主线

- 单条 `campaign.plan.admitted` 保存三个完整动态定义；双前置依赖保留，正常链的
  `dyn-c` 确实在 `dyn-a`、`dyn-b` 完成后开始。
- 非法目标阻断整批，原测试覆盖的合法子集不会单独执行。
- 正常链 8 次 provider 请求、3 次 Broker 效果，文件最终为
  `{name:"Ada",status:"active"}`，请求 consumed=8、unresolved=0、事件链有效。
- 仅到 admitted 的事件前缀重启，新进程 provider=0、effect=0；准入本身的激活门成立。
- 旧 18 C6、26 回归、8 受影响脚本以及 DS 的 4 个 E1 脚本独立复跑通过。
  部分 HTTP 检查首次受沙箱 `listen EPERM` 限制，允许本地监听后复跑通过。

这些结果证明实现并非空壳；它们没有覆盖下面的完整规划验收和观察路径。

## 2. 阻塞组 A：规划终止、独立验收与激活没有真正绑定

涉及：

- `memory/campaign/c6-model-worker.mjs:1248`：unknown 终止保护只检查 `decisions.length`，
  没有覆盖新增的 `plans`；后面的 `plans.length > 0` 仍可返回成功规划结果。
- `memory/campaign/e1-planning.mjs:199`：准入成功后直接调用 `completePlanningTask`。
- `memory/campaign/scheduler.mjs:362`：该函数只是以 oracle 来源写入
  `campaign.plan.ready`，默认 `outcome:null`，没有运行独立 plan_ready 检查。
- `memory/campaign/e1-planning.mjs:113`：`evaluatePlanReady` 存在，但没有产品调用点；
  其实现本身也没有检查规划正常终止。
- `memory/campaign/projection.mjs:606`：收到 ready 即清除子任务的激活 hold，
  不验证通过的规划 Outcome 和 planning Task completed。

实测正常链的耐久顺序：

```text
plan.admitted
plan.ready(outcome=null)
planning Oracle outcome=unknown
task-plan unknown
dyn-a started → completed
dyn-b started → completed
dyn-c started → completed
```

这违反任务书 4.4 的“独立规划检查通过 → 规划 Task completed → 子任务激活”。
它不是父子依赖语义问题，不应通过把所有父子关系改为执行依赖来修复。

补充场景把规划最后一条 assistant 的 `stopReason` 移除，SDK 实际传入 unknown 终止。
候选已经耐久记录，但产品仍 admitted、ready、返回 `ok:true`，provider=8、effect=3。
从该链截取到 `task-plan unknown`、尚无任何子任务开始的真实耐久前缀，恢复初始 fixture
文件后启动新进程，仍 provider=6、effect=3、三个子任务 completed。两条事件链均验证有效。

注意边界区别：只到 admitted 的重启对照是 provider=0/effect=0；不能据此推断
规划验收失败后的重启也安全。此次是事件前缀恢复测试，没有声称测试了 SIGKILL 信号。

修复要求：

1. 将候选计划纳入已有规划终止保护。正常、error、aborted、unknown 的候选均可保留，
   只有正常终止且请求结清者可继续准入/激活。
2. Host 真正调用规划专用的独立检查，绑定 Campaign、planning Task、plan id、
   完整 admitted batch 与正常终止事实；使用可信 Outcome 完成规划 Task。
3. admitted、plan-ready 证据、planning completed 语义在 live/replay 中保持一致；
   没有合法完成证据的 ready 不能释放子任务。
4. entry/composite 不得把准入失败或规划验收失败包装为成功。

对应新增测试：ER-02、03、05、08、17。此组是实际执行许可问题，必须先修复。

## 3. 阻塞组 B：真实规划输入与 Host 判据模板未闭合

实际 provider 第一次输入在 faux 返回任何计划前被捕获，避免把后续工具结果中的正确
答案误认为初始输入。输入有 `TASK task-plan`、泛化目标、`ACCEPTANCE: plan_ready`，
仍指示使用 `aegis_task_decision`；没有冻结的 `data.name == Ada` 和
`data.status == active`，没有提供 Host 模板目录及深度/扇出/任务数量限制。

`c6-model-worker.mjs:586` 沿用业务动作 prompt；entry 的规划模板仅用于准入端。
测试模型的计划早已硬编码正确判据，所以既有 faux 正常链无法发现此问题。
真实模型没有可靠信息来满足 Host 对冻结业务判据的精确覆盖检查。

此外，`templatesFromConfig` 保存 `success_criteria`，但 `validatePlanGraph` 不校验所选
判据是否来自模板，`normalizePlanNode` 仍直接使用模型提供的 criterion 文本。
补测在保持所有根判据覆盖的合法计划中加入模板未提供的
`data.status == attacker_chosen`，结果仍 admitted。这里不声称 Oracle 已误判根目标成功；
可复现的问题是 Host 接受了没有经过冻结模板约束的业务验收定义。

修复要求：从同一份冻结的规划输入契约生成 provider 上下文和 Host 准入约束。
模型收到目标/判据、可读附件、模板/能力、当前预算和图限制，并明确提交计划而非业务动作。
Host 解析已授权模板及其可选判据/参数，不执行模型自定义 Oracle 或任意新增验收语义。
覆盖检查和输入检查须以真实 provider context 验证。

对应新增测试：ER-06、07、13。

## 4. 阻塞组 C：观察面板与真实耐久结果不一致

同一条正常链，可信 artifact-aware queue replay 为：

```text
task-plan unknown; dyn-a completed; dyn-b completed; dyn-c completed
```

而 `buildE1View` 输出：

```text
task-plan unknown; dyn-a running; dyn-b ready; dyn-c queued
```

原因：`e1-observation.mjs:89` 把 artifacts 固定为 `{}`，导致真实 stage/Task Outcome
无法通过已有证据校验。DS 的测试 helper 正确使用 `artifactIndexFromEvents`，但观察 API
没有复用，测试只断言图有节点和依赖，没有比对最终状态。

该链有真实、可信、带证据的业务 Oracle success，白板仍 Fact=0。
`projectBoard(events)` 没有接入正常 Campaign 的 `runtime.note/campaign.oracle.result`。
纯观察测试使用人为构造的 `outcome.recorded`，未覆盖此产品事件形式。
任务书第 2、4.2 节已明确要求共同的可信 Outcome 映射。

其他同组接线问题：

- admitted 计划行的 `plan_id=null`：投影 map 的 value 没保存 id，而 UI 读取 `plan.id`。
- 同一正常链有两个 submitted，工具 recorder 用 `digest(plan)`，Host 用另一种
  `planDigest(plan)`；replay 拒绝第二条：`already submitted with a different digest`。
  entry 仍返回成功。不要通过过滤 rejected 列表或删除第一次候选记录掩盖问题。

修复要求：观察、live RAM、report/replay 复用可信 artifact/Outcome 规范化边界；
Outcome 保留原事件身份、Task/Episode、证据及有效性，不从 completed 或裸 success 伪造 Fact。
计划 id、digest、来源在工具记录、Host 准入、投影与 UI 中统一。
完整正常产品链应零 rejected，并逐 Task 比对实际终态、证据和白板。

对应新增测试：ER-09、10、11、12。

## 5. 其他发现及本轮限制

- ER-14：`goal.success_criteria` 为对象时 `validatePlanShape` 抛 TypeError，未返回 rejected。
  SDK 工具 schema 通常会先拦截此形状；这是纯校验边界的健壮性问题，不能单独证明
  真实 provider 已绕过 schema，也不单独阻塞 CTF。可在同一契约修复中顺手收口。
- HTML 仍是静态列表，无页面轮询/暂停、Task/Episode 过滤交互或节点详情分页。
  500 节点/2000 字符后的内容只有截断标记，没有继续读取入口。
  这是当前交付对完整展示的欠项；小规模人工刷新可临时操作，不把 UI 美化作为执行安全门。
  本轮未运行真实浏览器交互或像素验收。
- 单计划、串行 Worker、未实现增量重规划和父业务任务自动聚合等已声明限制保留，
  不因此重开本轮工程范围。
- tsc 的 196 条既有诊断逐条不变；没有要求清零旧 warning/类型债。
- 不把 DS 的 mutation 日志计作本轮独立 mutation 复跑；本轮新增测试有实际 red 证据，
  尚无产品修复，也不宣称 red→green。

## 6. 新增测试与独立验证记录

新增 `Pi_Agent_base/tests/aegis-e1-external-review.mjs`，17 项，**4 pass / 13 fail**，exit 1。
helper 增加首个 provider input 捕获及 `unknown_plan` 离线场景；原场景断言保持。

| 测试 | 结果 | 覆盖 |
| --- | --- | --- |
| ER-01 | pass | 正常效果、事件链、逐请求记账对照 |
| ER-02/03 | fail | 独立规划验收与 completed 后激活 |
| ER-04 | pass | admitted 单独不释放子任务 |
| ER-05 | fail | unknown planning 后的可执行 replay 状态 |
| ER-06/07 | fail | provider 实际规划输入 |
| ER-08 | fail | unknown 终止不得激活候选 |
| ER-09/10/11/12 | fail | 真实状态、Fact、计划身份、零 rejected |
| ER-13 | fail | 可信模板判据约束 |
| ER-14 | fail | malformed shape 不抛异常 |
| ER-15 | pass | 多前置依赖和实际执行顺序 |
| ER-16 | pass | admitted 前缀新进程零调用/效果 |
| ER-17 | fail | unknown planning 前缀新进程零调用/效果 |

所有日志位于 ignored 的 `Pi_Agent_base/runtime/dev/e1-external-review-run1/`：

| 检查 | 独立结果 | 证据 |
| --- | --- | --- |
| 原 focused 9 脚本 | 0 failed，exit 0 | `focused/results.json` |
| 原 C6 18 脚本 | HTTP 限制复跑后 0 failed | `c6/results.json` + `http-retry/results.json` |
| 原回归 26 脚本 | HTTP 限制复跑后 0 failed | `regress/results.json` + `http-retry/results.json` |
| 受影响 8 脚本 | HTTP 限制复跑后 0 failed | `affected/results.json` + `http-retry/results.json` |
| 最终 E1 4 旧脚本 | 0 failed | `e1-final/results.json` 前四项 |
| 新外部验收 | 4/17 pass，exit 1 | `e1-final/aegis-e1-external-review.log` |
| Campaign tsc | exit 1；196→196，诊断集合逐条相同 | `tsc.log`，对照 DS `tsc-after.log` |
| 新增/修改测试 Biome | exit 0 | 两个测试文件最终 check |

原 18/26/8 的 exact argv 与各脚本退出码保存在 results.json。复跑组名来自 DS 已交付的
相同 results 清单，调用 `tests/helpers/c6-suite-runner.mjs`；没有把空清单当套件通过。
最后一轮 E1 的 exact 命令：

```sh
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs \
  Pi_Agent_base/runtime/dev/e1-external-review-run1/e1-final \
  aegis-e1-plan-contract aegis-e1-planning-product \
  aegis-e1-observation-view aegis-e1-planning-chain aegis-e1-external-review

Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json

Pi_Agent_base/pi/node_modules/.bin/biome check \
  --config-path=Pi_Agent_base/aegis-biome.json \
  Pi_Agent_base/tests/aegis-e1-external-review.mjs \
  Pi_Agent_base/tests/helpers/c6-e1-planning-child.mjs
```

最后场景证据目录：`cases/acceptance-bJ9LEe/`。含实际事件、provider 输入、各场景 summary
及重启源完整日志。报告只引用有界摘要，不公开原会话或私有 pilot 记录。

## 7. 后续范围与进入 CTF 的条件

这是实现/接线缺口：冻结任务书已写清规划 Oracle、终止门、模板输入及 Campaign→Board
映射。无需重写整个架构。建议把 A/B/C 作为一次有界产品接线修复交给 DS，保留新增测试
及原 meaningful assertions；优先修 A，再共用规划契约补 B，最后让观察端复用权威投影补 C。
禁止用新旁路 provider、假 Oracle success、吞掉 rejection、隐藏 unknown 或测试换成
合成 Outcome 的方式转绿。

完成后有限复验新测试、原 E1/C6/受影响回归、Biome 与类型基线，并对规划终止门、
Oracle 门、模板判据和真实证据映射做 mutation。先由用户运行一次小型真实 LLM 规划
试跑，确认模型获得真实输入、拆出的任务被独立验收、网页状态与最终 status 一致。

随后可以进入**一个有明确范围、预算、停止条件和独立成功 Oracle 的 CTF pilot**。
先选题，再绑定附件/本地或自有靶场、允许工具与目标、必要输出和验收方式。
现有实现主要提供受限文件读取与注册的数据/代码动作，未实现通用 shell、CTF HTTP
交互或专门解题工具；这些不能凭规划 UI 通过就自动宣称已有。
应只为选定题目添加最小工具适配，不以搭建通用渗透平台作为首次试跑的前置条件。

## 8. 短修复附录（任务 A：规划执行门）

范围：只接通"规划正常终止 + 请求结清 → 完整批量准入 → 独立 plan_ready 检查 → 规划
Task durable completed → 子任务激活"。B/C 不在本轮。

拟采用的状态顺序与证据来源：

1. 候选：`aegis_submit_plan` 工具写 `campaign.plan.submitted`（候选，无执行权）。
2. 准入：Host 整图校验后写 `campaign.plan.admitted`（完整定义 durable）。该状态本身
   仍不放行；子任务 `awaiting_plan_ready=true`。
3. 终止与结清：`c6.request` 的已 durable `committed` 记录是结清事实；规划请求的
   `provider_status`/`stop_reason` 是终止事实。未知终止不再进入准入（worker 的
   `planningStatus===unknown` 守卫同时覆盖 decisions 与 plans）。
4. 独立验收：规划 Task 走 Scheduler 既有 `oracle.judge` 链；规划 Task 的 judge 复用
   `evaluatePlanReady`，绑定 Campaign/planning Task/plan id+digest/完整 admitted 批次/
   终止/结清，产出可信 task+stage Outcome（证据 `artifact:task-plan` = 批次 digest）。
5. 完成与激活：既有 `campaign.task.completed`（经 required stage 门）之后，Scheduler 才
   写 `campaign.plan.ready`（带 plan_id、outcome_id）。reducer 校验 planning Task 已
   completed、task Outcome success、plan 已 admitted 且身份一致；否则拒绝并保持 hold。
6. replay/restart 复用同一 reducer；`campaign.plan.ready` 缺证据/错配/缺 completed 一律
   保持 hold。候选与已发生消费保留，不退款、不另起 request。

对应测试：ER-02/03/05/08/17 转绿，保留 ER-01/04/15/16 控制；新增 error/aborted 计划、
无合法 Outcome/错配身份的 ready、完成门写失败/关键前缀恢复的 focused 反例。

### 8.1 任务 A 实际结果（DS 本地，未 push）

实际行为变化（真实产品链，`normal_plan`）：

```text
task.started(task-plan) → plan.submitted(候选) → plan.admitted(整批)
→ oracle.result(task-plan, stage+task success) → task.completed(task-plan)
→ plan.ready(plan-e1, outcome=o-task-plan) → dyn-a/b/c 按 depends_on 执行
```

关键数值：

| 场景 | provider | Broker effect | planning Task | 子任务 | dataset |
| --- | --- | --- | --- | --- | --- |
| normal | 8 | 3 | completed | a/b/c completed | Ada/active |
| unknown_plan | 2 | 0 | unknown | 无 | ??/pending |
| error_plan | 2 | 0 | unknown | 无 | ??/pending |
| aborted_plan | 2 | 0 | unknown | 无 | ??/pending |
| admitted 前缀重启 | 0 | 0 | unknown（completion 缺失，保持 hold） | 无 | ??/pending |
| unknown 前缀重启 | 0 | 0 | unknown | 无 | ??/pending |

unknown/error/aborted 的候选 `plan.submitted` 均保留、无 `plan.admitted`、无业务效果；
请求消费/未决保持原语义（不退款、不另起 request）。仅到 admitted 的重启不再由批次推断
规划完成，`planning_completion_missing` 明确 hold。

命令与退出码（日志在 ignored `Pi_Agent_base/runtime/dev/e1-repair-a/`）：

| 套件 | 结果 | 证据 |
| --- | --- | --- |
| `aegis-e1-external-review` | 10 pass / 7 fail，exit 1 | `final-e1c/aegis-e1-external-review.log` |
| E1 focused 6（含新 `aegis-e1-planning-gate`） | 5 pass / 1 fail（仅 external-review） | `final-e1c/results.json` |
| 原 C6 18 | 0 failed，exit 0 | `final-c6/results.json` |
| 原回归 26 | 0 failed，exit 0 | `final-regress/results.json` |
| 受影响 8 | 0 failed，exit 0 | `final-affected/results.json` |
| Campaign tsc | exit 1；196→196，诊断集合逐条相同 | `tsc-after2.log` vs 审计 `tsc.log` |
| 修改范围 Biome | exit 0 | `biome.log` |
| mutation：终止门（plans 移出守卫） | ER-08 行为断言失败（`plan.admitted` 存在） | `mutation1-termination.log` |
| mutation：独立验收门（去掉 completed 校验） | GATE-06 行为断言失败 | `mutation2-acceptance.log` |

新增 focused 反例 `tests/aegis-e1-planning-gate.mjs`（7/7）：error/aborted 真实 SDK+faux、
admitted 与 completed-without-ready 前缀保持 hold、错配 Outcome 身份、null/foreign plan id、
提前 ready、完成门 durable 写失败。ER-11（plan id 身份）因投影输出携带 `id` 顺带转绿，
不作为 C 已完成声明。

未修 B/C（保持红，逐项报告，不 skip、不降断言）：

- B：ER-06（真实首输缺少冻结业务判据）、ER-07（缺 Host 模板/图限制）、ER-13（未提供判据
  可被模型附加仍 admitted）。
- C：ER-09（观察图状态与 artifact-aware replay 不一致）、ER-10（业务 Oracle success 未成
  board Fact）、ER-12（正常链因工具/Host 两套 digest 出现 rejected plan）、ER-14（malformed
  criteria 抛 TypeError，非 rejected）。
- 本会话仅交付规划执行门（任务 A），整体 E1/CTF 未通过。
