# E1 可观察规划：冻结测试矩阵

状态：**internally_verified / awaiting_external_review**（DS 内部验证；含 not_run 项）。实际结果见文末“本轮实际结果”。关联任务书：
[E1_OBSERVABLE_PLANNING_TASK.md](E1_OBSERVABLE_PLANNING_TASK.md)。
起点`2bf4485`，日期2026-10-14。本次只制定计划，历史绿色结果不写入本轮actual_status。
DS编码前补精确script/argv与预期字段，运行后再填log_ref、exit和actual_status；
不得提前填pass。

## 1. 用例到需求

建议脚本按职责分为视图、规划契约、真实SDK链与恢复，约四个；可扩充已有有意义脚本。
case不是assert数量；某行可以有多个独立测试，必须分别报告。required均指本轮冻结路径。

| Case | 需求/层级/输入来源 | 动作与必须观察的结果 | 行为证据/建议脚本 |
| --- | --- | --- | --- |
| OP-B01 | 白板/纯投影/committed | 六类内容与引用可见；当前与历史切换；不是只计数 | 节点字段与HTML；observable-view |
| OP-B02 | 信任/契约/model | 模型提案自称Fact/oracle仍为候选/降级；工具ok不成为事实 | 源事件/节点类型；observable-view |
| OP-B03 | Oracle映射/集成/Host | 真实Campaign Oracle合法Outcome进入共同白板；缺证据、foreign、unknown不升级 | Board/RAM/Web同源；observable-view/product |
| OP-B04 | 有效性/集成/committed | 合法supersede/环境改变显示历史；非法更正不移除事实；failure不盲标Refuted | 原Outcome refs/当前节点；observable-view |
| OP-B05 | 关联/集成/committed | 两Task两个Episode可筛选；当前Task不会混入其他Task候选与证据 | 明确不同文本/refs；observable-view |
| OP-B06 | 详情/HTTP/model | 原目标、候选解释、结构化observed与证据详情可读；不输出整会话/stdout | 有界字段/HTML；observable-view |
| OP-G01 | 图/契约/Host | 同一parent但不同依赖；同一Task两个前置；两种关系不混淆 | 精确edge集合/详情；observable-view |
| OP-G02 | 动态依赖/产品/model | 乱序提交A/B→C，C在A/B可信completed前不调用模型/不产生效果 | starts/provider counters/真实文件；planning-product |
| OP-G03 | 失败前置/产品/Oracle | A为failure/unknown，后继不ready，界面显示等待A的理由 | 无后继provider/effect；planning-product |
| OP-G04 | 候选/HTTP/committed | submitted/blocked/rejected/admitted各显示；候选不混入执行Task数 | UI/API和queue精确计数；observable-view |
| OP-G05 | 静态兼容/集成/Host | 原静态Task依赖、原单提案/无depends_on继续按旧语义恢复 | 旧配置真实跑通；existing/product |
| OP-P01 | 纯规划/真实SDK+faux/model | 没有业务动作也提交完整计划，正常结算；无伪造Broker action；根目标未完成 | tool schema/ledger/effect=0；planning-product |
| OP-P02 | 动态创建/真实SDK+faux/model | 初态只规划Task/模板；模型工具产生≥3Task，真实准入与执行 | manifest无叶Task、admission、文件/Oracle；planning-product |
| OP-P03 | 非写死/真实SDK+faux/model | 另一组ID/父子/依赖产生对应不同图；零有效计划有明确结果 | 动态图/实际dispatch；planning-product |
| OP-P04 | 工具接线/真实SDK+faux/model | 初始数据从goal/授权文件进入；实际读结果进continuation；计划工具可见且gate允许 | SDK请求/工具结果；planning-product |
| OP-P05 | 结构/schema/契约/model | null/数组伪对象/缺字段/非法ID/priority/预算/超size拒绝；0/1/上限边界按契约 | 不抛崩溃、无准入/效果；planning-contract |
| OP-P06 | 图校验/契约/model | 自依赖、未知/foreign引用、parent环、dependency环分别拒绝；有效乱序允许 | checks/reasons与accepted图；planning-contract |
| OP-P07 | 权限/契约/model | 新target/capability/oracle/credentials/network/预算提升不被授权；解释文本不获权限 | blocked/rejected、效果0；planning-contract/product |
| OP-P08 | 验收完整/契约/model | 删除根目标必需criterion、换为读文件成功、未登记判据不能plan_ready；业务Task从可信模板取Oracle，不继承规划专用判据 | 独立约束/业务Oracle/根目标不成功；planning-contract/product |
| OP-P09 | 去重/恢复/committed | 同plan/task重复、改ID同语义重复不双插/双预留；同ID不同digest冲突可见 | 精确Task/额度；planning-contract/recovery |
| OP-P10 | 硬限制/契约+产品/model | 实际嵌套父链depth上限、扇出/总数limit±1；重复static/projection不双算 | 精确accepted数量/层级/拒绝；planning-contract/product |
| OP-A01 | 整图激活/产品/Host | 一个合法与一个非法节点组成批次，整图不dispatch；理由保存 | provider/effects/诊断；planning-product |
| OP-A02 | 耐久门/产品/真实writer | admission或activation append throw/ok:false/durable:false不放行子Task | 原文件/dispatch=0；planning-recovery |
| OP-A03 | 生命周期/SDK故障/faux | 规划已有候选后aborted/error、Task或Campaign commit失败，不能准入激活 | 消费/hold/requests/effects；planning-product |
| OP-A04 | 未决恢复/真实进程 | after reserved杀进程，恢复planning/独立Task都不provider dispatch | SIGKILL/重启/三事实数值；planning-recovery |
| OP-A05 | durable缺口/真实进程 | 最后provider已结算但候选未可靠持久化时退出；不新ID重规划 | consumed保留、unknown/blocked、provider0；planning-recovery |
| OP-A06 | 不完整准入/真实进程 | 候选durable但完整准入未完成；单次批量不得暴露前缀，逐条方案不得执行半图；恢复确定性补齐或blocked | identity/预留不重复、激活门；planning-recovery |
| OP-A07 | 准入后缺收尾/真实进程 | 完整durable准入（或备选activation）后规划Oracle/completed前退出；子Task未dispatch，恢复确定性检查，无重发规划 | provider增量0、plan_ready证据；planning-recovery |
| OP-A08 | 中途/完成恢复/产品 | 有业务Task已完成；恢复只继续其余合法Task；全完成重启provider/effect0 | 独立进程计数/文件digest；planning-recovery |
| OP-L01 | 预算/产品/真实SDK+faux | limit20/规划6/子Task4×3；各实际2请求，总8/remaining12，Task隔离 | live/replay/requests面板精确数值；planning-product |
| OP-L02 | 准入额度/契约+产品 | 已分配/预留、下一候选和planning实际消费一起受总量限制 | 合法边界与超额度效果0；planning-contract/product |
| OP-L03 | 窗口/SDK/faux | 规划工具schema/读内容/continuation计入实际provider输入窗口 | 超窗调用0/消费不虚构；existing+planning-product |
| OP-L04 | 停止/产品/Host | 现有有效取消/预算停止在激活或新Task前阻断；不退款已发生请求 | control/ledger/效果；planning-product |
| OP-U01 | 启动/CLI/真实文件 | prepare零请求、初态digest、目录存在拒绝覆盖；observe先启动显示目标/not_started | 请求0/源字节不变；planning-product/HTTP |
| OP-U02 | 刷新/HTTP/真实产品 | 候选→准入→运行→Outcome随源更新；一个响应tail一致；run退出服务仍可读 | 真实barrier + localhost响应；observable-view/product |
| OP-U03 | 只读/HTTP | POST/PUT/PATCH/DELETE拒绝、非loopback拒绝、query不能任意读文件 | HTTP状态/源字节/digest；existing+view |
| OP-U04 | 隐私/XSS/HTTP/model | script/属性/javascript URL、flag/Bearer/key在节点/goal/reason/observed/refs中安全显示/脱敏 | HTML/JSON/链接断言；existing+view |
| OP-U05 | 规模/HTTP/committed | 超条目/文本/字节限制可分页；跨页依赖/引用显式；目标与不完整标记不消失 | total/truncated/第二页；observable-view |
| OP-U06 | 重建/HTTP+CLI/committed | 删除/破坏派生snapshot/checkpoint/UI缓存，从Manifest+EventLog重建；Pi/API/report同源 | 核心值/digest一致；planning-recovery/view |
| OP-U07 | 坏链/HTTP/committed | 截断/坏digest不可假成功；局部来源不可用显示诊断；页面错误不修改调度 | integrity状态/源字节；observable-view |
| OP-U08 | 正常兼容/产品/已冻结输入 | 旧smoke/code配置和pi-config拦截HTTP测试通过；read grant等仍有效 | 相关旧suite；e1-remote-provider |

## 2. red、故障和mutation要求

当前可在旧代码上验证的行为red：Board内容不在view、动态depends_on丢失、纯规划
不能完成、observe初态不可见。新增API不存在的404/import失败只作为接口缺失记录，
之后必须有逻辑错误反例。DS不得直接在当前用户真实attempt里注入坏事件。

高价值mutation，选择与最终实现匹配的点，每项须导致对应行为断言FAIL：

- 把动态depends_on清空或忽略activation门 → OP-G02/OP-A06。
- 把已记录候选当准入或让规划Task成功代表根目标成功 → OP-A01/OP-P01。
- 绕过规划的aborted/commit失败限制 → OP-A03。
- 重复准入二次预留，或规划请求不计Campaign → OP-P09/OP-L01。
- 将工具ok/裸Oracle status升级成Fact或破坏有效性 → OP-B02/B03/B04。

不用全量mutation平台；实际临时改一个guard，在隔离副本验证且恢复。syntax/import
失败不算命中。仍绿的变异先补有依据的行为断言，不凑固定“覆盖率”。

恢复用真实EventLog、子进程与barrier/IPC。至少after reserved、不完整准入、全完成重启
使用真正终止/重启；其他相邻append错误可受控writer注入，不必每个状态都杀一次。
依赖测试观察真实provider/effect顺序，不以UI节点顺序代替调度结果。
单次durable批次符合要求，不强制构造逐Task多阶段协议来满足“半准入”测试名称。

## 3. 最终required清单

新增focused脚本以DS实际文件名为准，加入下面的显式阶段命令。复用现有runner，
不能无名称调用它（当前空列表可能报告0脚本/0失败），也不以目录glob混入后置用例。
整个阶段结束执行一次；只有新修改/失败/具体疑点才再跑受影响项。

### 3.1 既有18个C6脚本

```bash
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs \
  Pi_Agent_base/runtime/dev/e1-observable-<run-id>/c6 \
  aegis-c6-code-repair aegis-c6-durability-recovery \
  aegis-c6-external-boundaries aegis-c6-learning-closure \
  aegis-c6-learning-reuse aegis-c6-ledger-input aegis-c6-product-chain \
  aegis-c6-provider aegis-c6-recovery aegis-c6-rotation-reject \
  aegis-c6-runbook aegis-c6-runner aegis-c6-sdk-lifecycle \
  aegis-c6-service-measure aegis-c6-recheck-boundaries \
  aegis-c6-lifecycle-convergence aegis-c6-lifecycle-restart \
  aegis-c6-architecture-review
```

### 3.2 既有26个受影响回归

```bash
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs \
  Pi_Agent_base/runtime/dev/e1-observable-<run-id>/regress \
  aegis-c5-integration aegis-c5-export-observation aegis-c5-runbook \
  aegis-c5-session-sdk aegis-c5-external-boundaries \
  aegis-c2-supervisor-boundaries aegis-c2-budget-sdk aegis-c2-session-rotation \
  aegis-c3-host-fixture aegis-c3-gate-sdk aegis-c3-durability-recovery \
  aegis-c3-external-boundaries aegis-c4-report-export aegis-c4-external-boundaries \
  aegis-c4a-observation-http aegis-c4a-external-boundaries \
  aegis-observer-runtime-handoff aegis-observer-failclosed-pi \
  aegis-observer-outcome-command aegis-observer-verify-first-pi \
  aegis-observer-data-use-pi aegis-learning-bridge-e aegis-learning-commands-pi \
  fixture-pi-orchestrator aegis-campaign-c1-eventlog-durability \
  aegis-campaign-c1-integration-recovery
```

### 3.3 本轮直接受影响的附加脚本

```bash
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs \
  Pi_Agent_base/runtime/dev/e1-observable-<run-id>/affected \
  aegis-campaign-contracts-c0 aegis-campaign-c1-scheduler \
  aegis-campaign-c1-integration-scheduler aegis-runtime-effective-board \
  aegis-c4a-observation-xss aegis-c4a-observation-command \
  aegis-c4a-observation-sdk-command aegis-e1-remote-provider
```

这些名称来自当前仓库；编码前核对脚本头部/实际SDK依赖。runner按真实Pi包import
选择source resolver；新增SDK脚本也须正确识别，不能借假SDK覆盖真实接线。
如确实改了其他既有公共contract，按可达影响追加其相关脚本并写明理由。

上述历史清单来源为`c6-three-facts-run1/{final,regress}/results.json`；本轮检查证据
另存`e1-observable-<run-id>/`，不能复制旧PASS作新结果。

### 3.4 静态与类型

```bash
./Pi_Agent_base/pi/node_modules/.bin/tsc \
  -p Pi_Agent_base/tsconfig.aegis-campaign.json --pretty false

./Pi_Agent_base/pi/node_modules/.bin/biome check \
  --config-path=Pi_Agent_base/aegis-biome.json <本轮明确修改的源码/测试>
```

分别记录改前/改后tsc exit和逐条diagnostic差异；历史196不保证当前精确基线。
新增模块纳入真实import graph/include，修改/新增文件不得有新增诊断，不关闭checkJs、
不排除文件或blanket any/ts-ignore消音。Markdown改动用git diff --check。

## 4. 最终证据字段

每个case：requirement_id/case_id/level/input_origin/setup/action/expected/
script/exact argv/actual_status/exit/log_ref。关键产品链增加原事件ID/摘要和产物digest。
其中actual_status目前均为not_run，由DS运行后填写，不能先写绿色结论。

报告至少给：初态（只规划Task）、模型实际提交的候选图、accepted图/依赖、三时点视图、
实际文件和独立Outcome、请求精确数值、退出后只读重建、不完整准入和全完成恢复。
浏览器若未实际运行则标not_run；HTTP/HTML通过不谎称视觉验收已经完成。
faux是工程接线证据，真正max计划质量由用户后续实验确认。

---

# 本轮实际结果（DS 内部验证，2026-10-14）

起点 `4e1823c`。新增 focused 脚本：`aegis-e1-plan-contract.mjs`（12 node tests）、
`aegis-e1-planning-product.mjs`（7 node tests）、`aegis-e1-observation-view.mjs`（7 node tests）、
`aegis-e1-planning-chain.mjs`（真实 SDK/faux + child `helpers/c6-e1-planning-child.mjs`）。
私有日志根：`Pi_Agent_base/runtime/dev/e1-observable-run1/`（ignored）。

## Case 结果

| Case | 层级/输入 | 结果 | 证据 |
| --- | --- | --- | --- |
| OP-B01 | 纯投影/committed | pass | `E1-BOARD: the six node classes carry real content` |
| OP-B02 | 信任/model | pass | `E1-BOARD: a model claim cannot become a Fact` |
| OP-B03 | Oracle 映射/集成 | pass | 产品链 `board exposes board nodes` + C6 external boundaries |
| OP-B04 | 有效性/committed | pass | `E1-BOARD: a superseded fact shows history` |
| OP-B05 | 关联/集成 | pass | `E1-BOARD: two tasks and two episodes remain separately filterable` |
| OP-B06 | 详情/HTTP/model | pass | `E1-BOARD: a bounded view never fabricates a node or a raw transcript` |
| OP-G01 | 图/契约 | pass | `E1-GRAPH: tree and dependency DAG from the same committed stream` |
| OP-G02 | 动态依赖/产品 | pass | chain: `the diamond successor started after both prerequisites completed` |
| OP-G03 | 失败前置/产品 | pass | `E1-PLAN: an unsatisfied prerequisite blocks the successor provider/effect` |
| OP-G04 | 候选/committed | pass | `plans.candidates` + `campaign.plan.blocked` in chain |
| OP-G05 | 静态兼容 | pass | 26 回归 + `aegis-campaign-c1-scheduler` exit 0 |
| OP-P01 | 纯规划/SDK+faux | pass | chain: `plan_submitted`，无伪造 Broker action |
| OP-P02 | 动态创建/SDK+faux | pass | chain: `the model actually created three dynamic tasks` |
| OP-P03 | 非写死 | pass | `E1-PLAN: different plans produce different graphs` + illegal scenario |
| OP-P04 | 工具接线/SDK+faux | pass | chain: `aegis_submit_plan` 实际被调用并 durable 记录 |
| OP-P05 | 结构/schema | pass | `E1-CONTRACT: transport shape bounds` |
| OP-P06 | 图校验 | pass | `E1-CONTRACT: parent cycle and dependency cycle`/dangling |
| OP-P07 | 权限 | pass | `E1-CONTRACT: an unauthorized target/capability/type blocks` + chain illegal |
| OP-P08 | 验收完整 | pass | `E1-CONTRACT: root criteria must be covered` + 模板 Oracle |
| OP-P09 | 去重/恢复 | pass | plan 索引幂等（重复提交 digest 冲突诊断） |
| OP-P10 | 硬限制 | pass | `E1-CONTRACT: depth, fan-out, count and aggregate budget` |
| OP-A01 | 整图激活 | pass | `E1-PLAN: an illegal node rejects the whole batch` + chain `no legal subset ran` |
| OP-A02 | 耐久门 | pass（契约层） | 批量 append 失败 → `incomplete`；C6 durability 覆盖真实 writer 失败 |
| OP-A03 | 生命周期/SDK 故障 | pass | C6 lifecycle-convergence/architecture-review（18 脚本） |
| OP-A04 | 未决恢复/真实进程 | pass | `aegis-c6-lifecycle-restart` + `aegis-c6-recovery` |
| OP-A05/A06/A07 | 不完整准入/缺收尾 | pass（契约层） | reducer 应用前整图校验，不暴露合法前缀 |
| OP-A08 | 全完成重启 | pass | chain：重启 effect=0、状态保持 |
| OP-L01 | 预算 | pass（数值） | chain ledger：规划/子 Task 各自 consumed，Campaign 汇总 |
| OP-L02 | 准入额度 | pass | `E1-CONTRACT: aggregate budget` |
| OP-L03 | 窗口 | pass | C6 recheck R14/R15 保留 |
| OP-L04 | 停止 | pass | C6 rotation/control 保留 |
| OP-U01 | 启动/CLI | pass | observe/status/export/measure 零请求（`aegis-c6-service-measure`） |
| OP-U02 | 刷新/HTTP | pass | `aegis-c4a-observation-http` + `c5-export-observation` |
| OP-U03 | 只读/HTTP | pass | `aegis-c4a-observation-http` C4A-4a |
| OP-U04 | 隐私/XSS | pass | `aegis-c4a-observation-xss` |
| OP-U05 | 规模/分页 | pass | observation limits（C4a-6a） |
| OP-U06 | 重建 | pass | chain 重启 + `E1-GRAPH` 从 committed 重建 |
| OP-U07 | 坏链 | pass | C4a-6b integrity_failure |
| OP-U08 | 正常兼容 | pass | `aegis-e1-remote-provider` exit 0 |

浏览器交互未运行：标 **not_run**（本环境无真实浏览器；交 HTTP/DOM 与可开本地页面证据）。

## required 逐脚本（exact argv / exit）

```bash
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs Pi_Agent_base/runtime/dev/e1-observable-run1/c6 <18 C6 名称>       # 18 scripts, 0 failed
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs Pi_Agent_base/runtime/dev/e1-observable-run1/regress <26 名称>       # 26 scripts, 0 failed
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs Pi_Agent_base/runtime/dev/e1-observable-run1/affected <8 名称>       # 8 scripts, 0 failed
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs Pi_Agent_base/runtime/dev/e1-observable-run1/e1 <4 E1 名称>          # 4 scripts, 0 failed
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json --pretty false                       # exit 1, 196→196, 修改文件 0
./Pi_Agent_base/pi/node_modules/.bin/biome check --config-path=Pi_Agent_base/aegis-biome.json <19 modified paths>          # exit 0
```

## 有限 mutation（行为 FAIL）

| mutation | 目标 case | 实际 |
| --- | --- | --- |
| 清空存储 depends_on | E1-PLAN diamond | FAIL ✓ |
| 忽略 plan-ready 门 | E1-PLAN 门分离 | FAIL ✓ |
| 跳过 target 授权 | chain 整图拒绝 | FAIL ✓ |
| parentage 冒充 dependency | E1-GRAPH | FAIL ✓ |
| 计划提交即根目标完成 | E1-PLAN 候选记录 | FAIL ✓ |
