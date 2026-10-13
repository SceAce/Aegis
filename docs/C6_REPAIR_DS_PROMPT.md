# 给主 DS：C6 限定工程修复与补齐

C6 外部工程审查结论 changes_required，基线 7b7e92d，分支 feat/c6-agent-product。
用户要求复核并补其他测试；新增产品边界套件 21 tests / 2 pass / 19 fail。
先完整读 docs/C6_EXTERNAL_REVIEW.md、Pi_Agent_base/AGENTS.md、开发/测试/Git规范、
原 docs/C6_AGENT_PRODUCT_TASK.md 与当前C6代码/测试。冻结范围未增加；实际实验仍以后单独处理。

保留现实现、正常控制与原11suite，复用现有C6 plan/matrix/report/runbook，
不要重建Scheduler/Broker/Compiler/Router，不重新审计C1-C5，不因性能/未来功能扩门。
一次接受本修复总任务，按依赖自主完成小任务/审查/提交，最后交一次限定复验；不逐helper请示。
无子Agent就串行如实执行，共享接口/Observer/Host/ledger/runner主DS管理。

新增回归已经入库：
Pi_Agent_base/tests/aegis-c6-external-boundaries.mjs
Pi_Agent_base/tests/helpers/c6-audit-child.mjs
启动：node --test Pi_Agent_base/tests/aegis-c6-external-boundaries.mjs
helper通过真实source resolver启动SDK+faux child，真实临时effects/HTTP，无真实provider调用。
日志在 ignored runtime/dev/c6-external/baseline.json、final-boundaries.log、static-results.json。
这些是正常red断言，不能skip/改成expected failure/降低预期制造绿色。

按以下顺序集中闭环审查X1-X12：

1. X5 资源/真实绑定：Host config明确决定SDK的log/RAM/handoff/Task/Episode/goal/grant/budget，
   不依赖测试作者设置AEGIS_*环境；首次SDK事件前同一writer可借用。避免全局env临时改值引发重入串扰。
   每个当前Task/attempt的RAM/refs匹配，轮换保留该Episode；切Task显式绑定，不能整个Campaign用无关标签。
   bridge从当前verified stream刷新，获取verified currentState/ref，不选第一个Episode。
2. X1-X4 ledger/输入：每一次provider request含SDK自动tool loop/continuation都调用前准入、持久预留/记账；
   每个真实tool/批量decision里的Broker action都受明确Task及Campaign额度，拒绝后不继续越额dispatch。
   pending reservations扣remaining，commit唯一/幂等，wall-time过期拒绝；定义initial/rotation/失败/中断成本。
   账本从committed源重建，restart/measure不归零，记录实际attempt/request/usage来源。
   total context每请求执行max，包含实际tools schema/ROM/RAM/history/输出预留，不乘请求总预算作为窗口。
   不可得token仍估算/unknown，requests/tools/Session硬门不能软化；SDK hook核对实际文档/签名。
3. X11 真实Worker：提供grant内可调用的观察/读取路径，将target/验收condition/可用action参数schema
   真正送到provider。单次硬编码faux decision不是observe/execute/verify loop；补依观测改变动作、
   后置异常有界继续/停止测试。所有效果走同一Broker，工具名allowlist不替执行授权。
4. X10 假成功优先处理：process.exit(0)在目标module中能提前结束外部test而Task completed。
   可信Host必须确认预定验收实际完成、结果匹配声明criterion；exit0缺完整结果/timeout/提前退出为unknown。
   不只匹配目标可自己打印的PASSED行就认可信，不靠禁止字面process.exit绕过反例。
   固定test身份/标准只读且检查前后变化，未知criterion保守unknown；不要求新通用OS sandbox。
5. X8 学习工程目标：给真实pre_state/最终arguments/action身份/run/reset/Oracle expectation与refs，
   结构化when/expect由可信验证产生。配置并执行真实隔离Replay，跨运行proof可信导入且作用域明确；
   显式policy/proof IDs调用原Compiler，不降低门、不把promote_experience:false改自动晋升。
   compile成功通过同一writer记录权威canonical experience/编译参数及digest/refs，才能删除派生重建。
   真实相容独立案例编译active，再第三Task direct零规划/actual effect，habit仅补缺参数再重验、变化退场。
   不再手写exp-demo active或允许任意route当通过。稳定产active是C6-P5代码验收，不能留E2实验。
6. X7 provider接口：实现SDK已有支持的显式本地/真实provider创建配置与隔离凭据来源接口。
   开发用离线SDK seam替身测试正确model/endpoint/options/拒绝路径；不能把所有非faux硬拒绝叫完成。
   不读取真实用户凭据、不发送实际provider请求；无隐式默认配置回落，未实测provider列明。
7. X6 runner：实际attempt work_dir/初始化state/seed/冻结版本传到产品入口并作用到目标，
   每attempt源/产物/measure与报告字段一致；重复id/path/越范围有拒绝，不复用前次终态造完成。
   复用既有可信Manifest/config路径语义和单次runner，不造通用benchmark平台。
8. X9/X12 服务与错误：observe CLI自己的listener常驻到显式signal/close，HTTP直接访问该URL；
   signal drain await durable结果，清理并移除handlers/订阅/writer；bind失败可继续run。
   坏源status structured非成功，不用null sdkRuntime.dispose TypeError覆盖根因；所有清理路径有边界。
9. 恢复/静态与报告：补C6真实child IPC barrier→SIGKILL/重启的请求预留/可能effect路径，
   不以旧C3 helper代替本产品接线证据。whole chain跨first SDK/rotate/actions/shutdown verify。
   当前SHA256 abc正确、a/b不同、UUID不同；恢复digest/body-tamper负测，撤回无证据全零环境归因。
   tsc当前214，C6修改Campaign有18条（含4个SDK import resolution），修新增签名/JSDoc/API解析，
   不用any/@ts-ignore/排除本次代码/关闭checkJs吞错误；旧库按真实import graph单列基线。
   Biome当前9 warnings，能聚焦修则修，不把warning写成info；矩阵not_run/实际pass如实同步。

保留原有效正负断言，新增测试expected符合契约才可修正，并在报告写清理由。
新外部suite覆盖已复现缺陷，不代替P5完整active/direct/habit或C6恢复产品测试，须补必要证据。
先focused tests，再原11 C6 + 受影响显式回归；new changes/unresolved风险才扩大重复运行。
有限mutation只挑critical guard，用行为FAIL证明，不伪称以前DS mutation是本次复跑。

不改Pi核心/真实auth/models/settings/lockfile，不新增未授权依赖，不触发真实模型/API/外部目标，
不push/rewrite、不恢复旧demo、不清无关改动，不自动调用验收模型。
遵循Git逐路径stage、读staged diff、每reviewable里程碑commit，Agent协助注明。
具体实现选择/已授权接线修复自主做；需要改变授权/证据语义/Pi核心才停受影响部分说明真实blocker。

交回更新后的C6 plan/matrix/implementation report/runbook和审查修复对应表，
列exact command/exit/private logs、旧red→green、objects/context/provider requests/Broker effects/
verified chain/ledger/currentTask/replay/active-route/derived-rebuild/server关闭证据、commits/status。
状态只能internally_verified / awaiting_external_review或真实changes_required；
不自行外部通过、不以fixture绿色声明全部能力、不启动实际环境实验。
