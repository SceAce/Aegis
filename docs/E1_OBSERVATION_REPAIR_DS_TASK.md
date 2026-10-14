# E1 短任务 C：统一观察、白板证据与计划身份

前置：任务 B 已交付并核验；由操作者在新会话明确“执行 C”。本文件不授权在 B 未完成时
并行修改共享入口。参考起点 `90a743e`，实际从包含 B 的当前 HEAD 继续，不 reset。
目标：同一 Manifest/EventLog 的观察页、权威队列、白板和恢复结果一致，并准确显示
业务证据；完成 C 后才交回整体 E1 工程验收，尚不执行付费模型或 CTF。

## 1. 有限阅读与已有证据

阅读 `Pi_Agent_base/AGENTS.md` 最新补充、开发/测试/Git 规则；外部审查报告 §4、§8.2
及 B 实际交付附录；原冻结任务书 §4.2–4.3 和 A 的 §4.4–4.5 执行门。
修改前完整读直接改动文件，主要起点：

- `memory/campaign/e1-observation.mjs`、`e1-task-graph.mjs`：视图和任务图；
- `memory/runtime/board.mjs`、`evidence-resolver.mjs`：白板、有效性和证据；
- `memory/campaign/outcome-resolver.mjs`、`projection.mjs`、`c3-entry.mjs`：权威 Outcome
  解析、队列和 artifactIndexFromEvents；
- `c6-entry.mjs` 的 live RAM/measure Board 及 plan recorder、`e1-plan-contract.mjs`、
  `scheduler.mjs` 的 plan digest/提交边界；
- `observation-server.mjs`、`observation-view.mjs`、report/export 的直接使用点，按需读；
- 现有外部验收、真实 planning helper、E1 observation 和 effective-board 测试。

已复现：正常链权威队列全部 completed，但观察图仍 running/queued；业务 Oracle success
未形成可追溯 Fact；工具与 Host 两套 plan digest 使同一正常计划产生 rejected。
ER-11 的 plan id 已由 A 修好，继续保留。B 预期之后仅 ER-09/10/12 红。

## 2. 冻结的最终契约

1. **同源状态**：从 Manifest + 原始耐久事件及可信 artifact index 推导观察任务状态。
   复用现有权威 resolver/reducer；不固定 artifacts={}，不靠页面、checkpoint、裸
   completed 或模型文本重新发明成功。依赖树/DAG/候选和已准入任务保持区分。
2. **共用 Outcome 边界**：把合法 Campaign Oracle 事件接入既有 Board 语义；可增加
   小型纯适配层，保留原 event_id/digest/source、Campaign/Task/Episode/Stage/criterion、
   evidence_refs、scope 和有效性。live RAM、观察和实际 report/measure 消费一致结果。
   不写第二份 Outcome/event，不伪造 oracle 来源、hash 或 Episode 关联。
3. **事实门**：模型自报、runtime 包装的裸 success、foreign 归属、缺/错证据、unknown
   和 invalid 都不能升为 Fact。有效 success 形成带原事件/evidence 引用的 Fact；failure
   按现有可信判定规则形成 Refuted，工具错误/超时不因此变成 Refuted。supersedes、
   scope、环境失效和历史节点仍遵守既有规则，不仅检查 source.kind 标签。
4. **计划身份**：候选录入、Host 准入、投影和视图共用一个定义清楚的 canonical plan
   digest（说明覆盖/排除字段），实际 recorder/scheduler 都调用它。原模型候选与 Host
   normalized Task 定义保留各自含义，不能把 normalized 偷换成模型原案。重复同内容
   幂等，same plan id/different content 仍拒绝；正常产品流零 rejected。
5. **可观察与只读**：board/graph/plans/requests API、页面与 status/replay 对同一输入
   终态一致；进行中的真实前缀仍显示 running/queued/hold、预算未决及原因。小规模
   fixture 的所有节点内容、判据及引用可读。observe/status/export/measure provider=0、
   Broker effect=0，不通过观察发起新 Oracle/provider 或修改原事件。
6. **恢复与保护**：completed 恢复不重复 provider/effect；只有 admitted、unknown/error/
   aborted、SDK/ready 写失败等 A 前缀继续 hold。根目标不能因 planning completed
   显示业务成功；parent 不自动成为执行依赖。保留 B 的模板/预算约束和 C6 三事实。

本任务聚焦当前小图的正确状态/证据和身份；页面美化、布局系统、全量浏览器像素验收、
大图分页/交互重做不作为本轮执行门。原展示欠项如尚未实现须记录限制；截断/未知
如实显示，不声称完成全文访问。自动补写缺 ready、增量重规划仍不在本轮。

## 3. 实施与有限新增验证

先记录 B 后实际基线和 ER-09/10/12 red、tsc 基线。编码前在现有审查报告写短 C 附录：
共享投影输入、Outcome 信任门、计划 digest 定义/调用点及 4–6 项测试矩阵。
先统一身份与纯适配边界，再接 live/观察调用点，最后验证产品链；不只在 HTML 填状态。

保留外部 17 项和 A/B 原断言。必要组合测试：

- 真实 SDK/faux 正常链逐 Task 比对权威队列、buildE1View、实际 HTTP/API、export/measure
  的状态；三次业务 Oracle 成功均能追溯到原事件与可解析证据，root/plan 不伪成功。
- 在一小组同链反例中移除/错配证据、替换为模型来源或 foreign Task/Episode，验证无
  Fact/无假 completed，且显示原因。保留真实 Outcome/原事件身份，不用重造成功事件
  作为主要正例；修改事件的测试明确属于 reducer 测试，不声称 hash-chain 完整。
- 已有有效 supersede/unknown/环境变化的白板回归继续正确：历史保留、失效 Fact 退出
  effective 视图；runtime 工具 success 不升级为 Oracle Fact。
- 正常计划所有相关 digest 一致且零 rejected；重复同内容不双 admission/记账，实际
  改内容仍拒绝；不能删候选、过滤 rejected 或仅改 UI 的 plan_id。
- 同一真实日志用新进程重建/观察，文件与业务效果不变，provider/effect=0；至少一个
  admitted/unknown hold 前缀的页面/API 状态对照，避免只覆盖 completed。

对本轮共享证据门做一个 mutation：绕过证据/归属校验后，反例必须因假 Fact/假状态
行为断言失败；恢复代码再最终复跑。API 本地监听若被沙箱限制，按工具审批正常申请，
如仍无法运行如实报告 blocked，不能把未运行当 pass。

## 4. 最终检查与交付

使用 `docs/E1_REPAIR_REQUIRED_CHECKS.json` 的四组显式清单，按 B 任务书 §4 的现有
runner 命令运行，日志目录改为 `runtime/dev/e1-repair-c/`。新增 C 脚本另行显式执行并
保留 exact argv/exit；检查每组 results.json，不能把空清单/未运行算通过。

最终一次 E1 7、C6 18、回归 26、受影响 8 全部执行；现有外部验收必须 **17/17**，
A gate 7/7、独立写失败恢复 2/2 继续通过。只因新改动/失败复跑相关项。修改范围
Biome exit 0；Campaign tsc 与本会话改前诊断逐条比较，原 196 条不要求清零，修改/新增
产品文件无新增诊断；不能排除新代码或关闭检查。保留旧 meaningful assertions。

按 Git 规范明确路径暂存、读 staged diff、本地提交，不 push。只在现有审查报告加 C
结果及整体交接摘要，必要时同步契约/runbook，避免新的长报告。最终回复 ≤800 汉字：
行为、真实链关键数值、精确检查索引、mutation、HEAD/工作树、限制及未实测项。

状态仅为 **internally_verified / awaiting_external_review**，交回独立整体验收。
不自行宣称真实模型/CTF能力通过；后续先由用户做小型真实规划，再为选定 CTF题绑定
附件、最小工具、预算、停止条件和独立 Oracle。

不改 Pi 核心、凭据/模型配置、lockfile，不加依赖，不跑付费 provider/靶场；不重开 A/C6
已接受修复，不新增 shell/攻击工具、多 Worker、模板平台、退款或自动恢复平台。
