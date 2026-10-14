# Aegis 当前完成度独立审计（2026-10-15）

产品基线：`feat/c6-agent-product` / `381829a`，开始时工作树 clean。
嵌入 Pi：`42a3497d03ad17e308a2299fa824727894f2c0ec`，工作树 clean。
审计分支：`audit/completion-20261015`。本轮只新增审计测试和文档，不修改产品代码。

结论：**工程主体已实现，受限任务链能运行；E1 整体验收仍为 changes_required。**
当前不能声称可信事实投影和 Plan replay 的 fail-closed 契约全部闭合。
C1-C6 先前限定接受范围保持；两个问题属于现有 E1 事实/规划集成边界，
不是因类型债、页面美化或后续能力要求重新开启旧阶段。

## 1. 完成度与证据层级

| 能力 | 当前判断 | 依据及限制 |
| --- | --- | --- |
| Event → Episode → Outcome → Experience | 已实现并有离线集成证据 | 单 writer、hash chain、durable-before-effect、可信来源/独立判定；相关回归通过 |
| Campaign Host/Scheduler/Broker/Oracle | 已交付的受限工程能力保持 | 依赖、授权、预算、控制、重启核对检查通过；串行 Worker，workspace 不是 OS sandbox |
| SDK 模型 Worker、记账、Session 轮换 | 已实现，当前检查通过 | 实际 SDK + faux、SIGKILL/restart、三事实分离检查通过；SIGTERM 是 Task 边界 drain |
| 结构化数据与单文件代码修复 | 能运行，真实验证范围有限 | 本轮离线回归通过；用户此前 smoke/code 两项共 6 次真实请求为历史证据，本轮未重跑 |
| LLM 完整计划、整图准入与激活门 | 正常链成立，恢复边界未闭合 | 正常链 provider=8/effect=3；缺失身份及 normalized 定义错配仍被 replay 接受，见 B |
| Board、任务图、观察 API | 已实现展示，可信性尚有阻塞 | scope/criterion/证据及 rejected admission 的判断不同于权威队列，见 A |
| 页面交互与大图完整浏览 | 部分完成 | 静态 HTML；轮询/暂停、详情分页、截断后的继续读取仍欠缺，属前次记录的非阻塞限制 |
| 经验编译、路由、跨运行重建 | 机制已实现并有工程检查 | learning closure/reuse 通过；不能据 fixture 推断真实学习收益 |
| 经验收益、短上下文效果、未见任务迁移 | 尚待实验 | E2/E3 需要冻结样本与对照；当前无充分效果证据 |
| 自动 CTF、通用多文件工程任务 | 尚未建立能力结论 | 需要具体工具/任务适配、授权、预算及独立 Oracle；不能由 UI 或 faux 推断已完成 |

不以代码量、文档数或已通过脚本比例换算全项目完成百分比。
定位：**可运行的受限 Agent 工程系统，自动规划集成待修复验收，效果研究待开展。**

## 2. 本轮实际检查

规范清单：`docs/E1_REPAIR_REQUIRED_CHECKS.json`。使用已提交的
`Pi_Agent_base/tests/helpers/c6-suite-runner.mjs` 逐脚本记录真实 argv/exit。
私有证据根：`Pi_Agent_base/runtime/dev/completion-audit-20261015/`。

| 检查 | 本轮结果 | exit / 证据 |
| --- | --- | --- |
| E1 required | 7/7 脚本通过；原 external-review 17/17 | 0；`e1/results.json` |
| C6 required | 18/18 脚本通过 | 初跑 2 个监听相关失败；对应复跑均 exit 0 |
| 回归 required | 26/26 脚本通过 | 初跑 4 个监听相关失败；对应复跑均 exit 0 |
| 受影响 required | 8/8 脚本通过 | 初跑 1 个监听相关失败；对应复跑 exit 0 |
| 最新修复 focused | 3/3 脚本通过：FC 17/17、planner input 6/6、observation repair 6/6 | 0；`repair-focused/results.json` |
| 新增独立审计 | **12 cases，3 pass / 9 fail** | **1**；`independent-final/aegis-completion-audit.log` |
| Campaign tsc | 194 条诊断，Campaign 模块自身 0 条 | 1；`static/tsconfig.aegis-campaign.json.log` |
| Batch-E tsc | 186 条诊断 | 1；`static/tsconfig.aegis.json.log`；不冒充 Campaign 覆盖 |
| 最新修复 8 文件 Biome | 通过，未改产品文件 | 0；`static/biome.log` |

即：**既有及修复脚本 62/62 通过；新增审计脚本为失败回归证据。** 类型检查不是全绿。
没有把被跳过、未运行或沙箱失败计入通过，也没有复跑或冒认历史 mutation。

本地 HTTP 初跑受到 `listen EPERM` 限制；经允许在沙箱外复跑 7 项全部通过：

```bash
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs \
  Pi_Agent_base/runtime/dev/completion-audit-20261015/http-retry \
  aegis-c4a-observation-xss aegis-c5-export-observation aegis-c5-external-boundaries \
  aegis-c4a-observation-http aegis-c4a-external-boundaries \
  aegis-c6-external-boundaries aegis-c6-service-measure
```

静态检查 argv 在 `static/results.json`、`static/biome-result.json`。

## 3. 当前阻塞 A：Board 使用较弱的事实判定及未经接受的绑定索引

位置：

- `memory/runtime/board.mjs:143`：criterion 只检查非空，不检查是否属于 Task/Stage。
- `memory/runtime/board.mjs:247`：证据仅检查存在，不复用引用解析/作用域判定。
- `memory/runtime/board.mjs:645`：从原始 admitted/start 事件建立索引，
  不复用队列 reducer 的 accepted/rejected 结果。

以真实 SDK/faux 正常链为正例，对 `dyn-a` 的实际 stage/Task Oracle 结果注入故障：

| case | 故障 | 权威队列 | Board |
| --- | --- | --- | --- |
| CA-02 | scope 改为 foreign fingerprint | 拒绝结果，任务非 completed | 仍生成 2 条 Fact |
| CA-03 | criterion 改为未登记值 | 拒绝结果，任务非 completed | 仍生成 2 条 Fact |
| CA-04 | 引用不存在且无可解析 digest 的 artifact | 拒绝结果，任务非 completed | 仍生成 2 条 Fact |
| CA-05 | admitted digest 与 submitted 不同 | 拒绝 admission，不创建 dyn-a | 仍依据原始定义/start 生成 dyn-a 的 2 条 Fact |

输入重新计算 hash chain，序列化前后均通过 `verifyChain`。这验证的是**完整但违反
业务契约的 durable 输入**，不依赖坏 JSON 或断链。scope/criterion/引用及未经准入的
Outcome 均是现行 OP-B/FC 要求，非新增防御目标。

影响：同一日志的队列与观察白板给出不同可信结论；C6 live RAM 同样调用
`projectBoard(events, {manifest})`，消费这一弱投影。需要复用同一可信 Outcome
校验与已接受的任务绑定，拒绝结果保留为带理由的 Hint。

本轮没有声称模型能伪造 oracle 来源，也不审计本地日志签名机制。
严重度：**P1 / 当前 E1 阻塞**，因为现有事实投影边界未履行 fail-closed 契约。

## 4. 当前阻塞 B：Plan replay 未证明完整身份与准入定义对应

位置：

- `memory/campaign/projection.mjs:834`：submitted 不要求 planning identity，
  不检查 envelope.plan_id 与 candidate.plan_id 相同。
- `memory/campaign/projection.mjs:938`：仅“两边都存在且不同”时拒绝；缺失仍通过。
- `memory/campaign/projection.mjs:957`：normalized definitions 仅做有限结构检查，
  未确认内容/授权/task_digest 与 submitted candidate 的准入结果一致。
- `memory/campaign/projection.mjs:634`：ready 将缺失 planning identity 视为可跳过检查。

| case | 故障 | 实测 |
| --- | --- | --- |
| CA-06 | 所有 submitted 缺 planning_task_id | 零 rejected，计划 admitted，动态任务 completed |
| CA-07 | admitted 缺 planning_task_id | 回退 prior identity，零 rejected，动态任务 completed |
| CA-08 | normalized target 改为 Manifest 未授权路径，候选/digest 不改 | 零 rejected，错定义进入队列；旧 Oracle 结果仍使任务显示 completed |
| CA-09 | candidate.plan_id 与 envelope.plan_id 不同，canonical digest 一致更新 | 零 rejected，计划 admitted |
| CA-12 | submitted/admitted 均缺 planning_task_id，从实际 ready durable 前缀重启 | **provider=6、Broker effect=3、ok=true**，业务任务全部 completed |

CA-12 使用新真实子进程、真实 SDK/faux、Broker、Oracle、EventLog。
对照 CA-11 保留完整身份，同一 ready 前缀正常执行 provider=6/effect=3，证明 harness
正常。缺身份的输入应当 hold/reject、零请求/效果，目前仍执行。这是 prefix 恢复
测试，不声称测试了 SIGKILL；SIGKILL 覆盖来自既有生命周期回归。

CA-08 未证明发生越权文件写入；Broker 的最终 grant 检查仍保留。它证明 replay
接受了不属于候选的执行定义及错误完成状态。修复须在任何 queue/budget mutation
前完成候选身份、normalized 定义与可信准入对应校验。

严重度：**P1 / 当前 E1 阻塞**。既有 admitted-only、unknown/error/aborted 激活保护
的已通过范围保持；本组补齐 missing identity 和 candidate/normalized correspondence。

## 5. 复现与限制

新增脚本：`Pi_Agent_base/tests/aegis-completion-audit.mjs`。

```bash
node Pi_Agent_base/tests/aegis-completion-audit.mjs
```

当前 exit 1：CA-01/10/11 通过；CA-02..09/12 为 9 个行为断言失败。
每次创建新的 ignored evidence 目录，保留输入链、投影摘要和子进程日志。
最终目录：`runtime/dev/completion-audit-20261015/independent/cases-PPvxEq/`。
首次 harness 的首行含 undefined 字段，CA-11/12 控制失败；已修正序列化并新增
round-trip chain 断言。最终结论仅使用 `independent-final` 的 3/9 结果，
不把初跑控制失败归因于产品。

required groups 可用已有 runner 和显式 JSON 清单复现：

```bash
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const groups = JSON.parse(readFileSync('docs/E1_REPAIR_REQUIRED_CHECKS.json', 'utf8'));
let failed = false;
for (const [group, names] of Object.entries(groups)) {
  const run = spawnSync(process.execPath, [
    'Pi_Agent_base/tests/helpers/c6-suite-runner.mjs',
    `Pi_Agent_base/runtime/dev/completion-audit-repeat/${group}`, ...names,
  ], { stdio: 'inherit' });
  if (run.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
NODE
```

本轮没有真实 provider/目标调用，没有读取用户凭据或改写既有 operator attempts。
没有浏览器像素验收、学习对照、模型 benchmark 或全 Pi monorepo 检查。
需本地已有嵌入 Pi 与依赖，版本见本文开头；主仓库未纳管该部分源码。

## 6. 阶段判定与下一步

1. 保留已通过的 C1-C6 机制、正常 E1 链及 62 个脚本。
2. 在现有 E1 范围内修复 A/B，保留失败用例并完成相关回归后限定复验。
3. 同步 README/阶段入口，避免从历史状态误读进度。
4. 工程边界闭合后，由用户执行一个有界真实规划任务，再安排 E2 对照实验。
5. CTF/多文件按实际工具与 Oracle 适配推进；类型债、UI 交互及 F16 缓存
   按后续职责处理，不无限扩大本轮两项修复。

本报告和新增测试是**审计交付，产品未修复**。阶段状态为
**E1 changes_required；既有受限工程能力继续按已接受范围使用。**
