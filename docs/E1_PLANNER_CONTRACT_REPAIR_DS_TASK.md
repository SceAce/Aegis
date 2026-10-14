# E1 短任务 B：接通真实规划输入与 Host 模板约束

执行顺序：A 已限定接受，本会话只完成 B；C 另开会话。参考基线 `90a743e`（产品修复
`bc93cca` + 独立审计），实际从当前 HEAD 继续，不 checkout/reset 到历史提交。
整体 E1 仍 changes_required。目标是使真实模型获得能提交合法计划的信息，同时由 Host
限定业务验收定义；测试通过不代表真实模型已具备拆分或 CTF 解题能力。

## 1. 有限阅读与已有证据

阅读 `Pi_Agent_base/AGENTS.md` 的最新 E1 补充，以及开发/测试/Git 规范的当前规则；
`E1_OBSERVABLE_PLANNING_EXTERNAL_REVIEW.md` §3、§5、§8.2；原冻结任务书
`E1_OBSERVABLE_PLANNING_TASK.md` §4.4–4.5。历史 C1–C6 文档按需查契约，不重复全遍历。
修改前完整读直接修改文件，起点是：

- `memory/campaign/e1-planning.mjs`：模板冻结、规划 Manifest、整图准入调用；
- `e1-plan-contract.mjs`：shape、模板解析、判据覆盖和 normalized 定义；
- `c6-model-worker.mjs`：buildPrompt、createPlanSubmitTool、实际 provider 输入门；
- `c6-entry.mjs`、`campaign-config.mjs`：规划工具、模板、预算和 Worker 的接线；
- `tests/aegis-e1-external-review.mjs`、`tests/helpers/c6-e1-planning-child.mjs`。

已复现：首次 provider 输入缺冻结业务判据、模板目录及图限制；仍指示提交业务 action。
Host 保存了模板 success_criteria，却接受模型附加 `data.status == attacker_chosen`。
goal.success_criteria 为对象时 shape validator 抛 TypeError。
当前外部验收 10/17；本轮主修 ER-06/07/13，顺带收口 ER-14。

## 2. 冻结的最终契约

1. **同一权威输入**：从已验证的 Manifest、Host 模板/注册适配器、当前 Task/Campaign
   预算及授权范围构造有界规划上下文；provider prompt/tool schema 和 admission 消费同一
   规范化契约。不能用另一份测试常量或模型自述补齐权限/判据。
2. **模型实际可见**：根目标和全部 required_criteria、root_goal_ref、可读附件/target refs、
   既有任务摘要、template_ref/task_type/已登记 Oracle 和执行能力、模板可选判据、参数
   约束、当前预算、max_depth/max_fan_out/max_task_count。把传输字段、parent 与 depends_on
   的区别及 `aegis_submit_plan` 的候选语义说清楚。规划 Task 不沿用业务 action 指令；
   普通业务 Task 的既有行为保留。附件内容通过现有授权读取工具获得。
3. **模板判据**：沿用当前 success_criteria 字符串接口，可信业务模板提供明确、非空的
   可用判据集合。模型每个业务节点只能选对应模板中的非空子集；所有节点的合法判据
   联合覆盖根 required_criteria。禁止新增任意 criterion、模型 Oracle 或解释执行表达式。
   template_ref/task_type/Oracle/能力/作用域须一致，模型字段不能扩大 Host 授权。
   现有按 task_type 解析模板的兼容行为如保留，必须唯一、显式且可测。
4. **规范化顺序**：先校验输入和可信模板、解析模型选择、验证整图，再从可信模板生成
   Task/stage/Oracle 绑定。非法一节点阻断整批，无合法前缀、无部分 reservation/admission。
   不能先接受任意 criterion 再依靠运行时 Oracle unknown 兜底。
5. **缺失与兼容**：缺业务模板判据返回明确 config/admission 错误，不解释为通配。
   已有 planning 示例和测试的可信模板可补显式判据；写明 fixture 迁移依据并保留原
   效果、预算、依赖及失败断言。不修改用户私有配置；非规划配置继续正常运行。
6. **形状与窗口**：非数组/空/错误元素的 success_criteria 返回 rejected，不抛异常；
   检查本次消费的相邻数组/模板字段。新增上下文继续由既有 provider-bound 输入测量
   与双层账本计入，不能另造窗口规则、绕过 provider gate 或扩大预算来换取通过。

模型自由选择任务数量、组织关系和依赖；Host 模板只限定执行/验收接口。生产代码中
不得硬编码 Ada、active、dyn-a/b/c 或 fixture 的计划；不预置完整任务树/解法。
本轮不引入通用 criterion DSL、模板插件平台、增量重规划或新的事件生命周期。

## 3. 实施与有限新增验证

先记录当前分支/HEAD/工作树、tsc 基线和外部 red。编码前在现有审查报告增加一个短
B 附录，列上下文来源、模板字段/缺失语义、live/admission 调用点和 4–6 项测试矩阵。
常规实现选择自行解决，无需逐步确认；用小步提交控制上下文，不重复写长方案。

保留现有 17 项外部断言。新增覆盖以当前可达风险为限：

- 首次实际 provider context（在 faux 透露计划前捕获）包含完整契约和正确工具指令；
  改变可信模板/目标/图限制，输入和 Host 约束对应变化，不能只检查字段名出现。
- 正常允许判据能完成真实 SDK/faux → Host → Oracle → EventLog 链；至少一个 faux
  候选根据实际收到的目标/模板生成，避免正常样本独自硬编码答案而掩盖输入缺失。
- 保持根判据覆盖的情况下附加模板外判据，实际工具提交后整批 blocked，无 admitted、
  子任务 provider/Broker effect=0；另有未知模板或模板/type 错配反例。
- malformed criteria 返回有理由的 rejection；缺/空可信模板判据不默认授权。
- 保留 A 的正常、unknown/error/aborted、SDK 写失败、ready 写失败及重启 hold。

对模板判据守卫做一个针对性 mutation：临时绕过它，ER-13 或真实链负例必须因行为
断言失败；不是 syntax/import 失败。恢复代码后再做最终检查。

## 4. 最终检查和交付

显式 required 清单：`docs/E1_REPAIR_REQUIRED_CHECKS.json`（E1 7、C6 18、回归 26、受影响
8），使用现有 c6-suite-runner，输出到 ignored `runtime/dev/e1-repair-b/`。可用以下命令
启动四组；每个结果/退出码都要检查，不用总 exit 掩盖其中的 expected remaining red：

```sh
node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const groups = JSON.parse(readFileSync('docs/E1_REPAIR_REQUIRED_CHECKS.json', 'utf8'));
let failed = false;
for (const [group, names] of Object.entries(groups)) {
  if (!names.length) throw new Error('empty suite: ' + group);
  const run = spawnSync(process.execPath, ['Pi_Agent_base/tests/helpers/c6-suite-runner.mjs',
    'Pi_Agent_base/runtime/dev/e1-repair-b/final-' + group, ...names], {stdio:'inherit'});
  console.log(JSON.stringify({group, exit:run.status, signal:run.signal, error:run.error?.message}));
  failed ||= run.status !== 0;
}
process.exitCode = failed ? 1 : 0;
JS
```

本轮整组入口预期 exit 1（E1 中 C 项仍红），按 results.json 逐项验收，保留真实非零退出。
新增 B 脚本另行显式执行并保存 exact argv/exit；SDK 脚本按实际需要使用 source resolver。
最终只做一次完整 required 复跑，有新改动/失败再重复受影响检查。运行修改范围 Biome，
Campaign tsc 改前后逐条诊断比较（原 196 条不要求清零，新增/修改产品文件无新增诊断）；
不能关闭 checkJs、排除本轮代码、skip 用例或降低断言。

预期外部验收 **14/17**，仅 C 的 ER-09/10/12 仍红；若 C 项自然转绿，逐项报告，不宣称
C 已完整交付。所有已通过 A/C6/非规划回归必须保留。网页美化、旧类型债不扩入范围。

按 Git 规范明确路径暂存、读 staged diff、本地提交，不 push；只更新现有审查报告 B
附录及必要契约/用例说明。最终回复不超过 800 汉字：行为、关键数值、actual argv/exit
索引、mutation、HEAD/工作树、未修 C/未实测限制。状态为 B internally_verified，交回
独立核验；整体 E1/CTF 尚未通过。

不改 Pi 核心、凭据/模型配置、lockfile，不加依赖，不跑付费 provider/靶场；不重开已
接受的 C6/A 请求生命周期，不新增 shell/攻击工具、UI 重做、多 Worker、退款平台。
