# Aegis AI Agent 测试规范

状态：开发和主 DS自审的测试依据。测试先与契约一起生成，再实现产品；本文件本身不是测试执行结果。

## 1. 测试原则

使用常见的分层测试做法：单元/契约 -> 组件集成 -> 产品入口 -> 针对性恢复/故障验证。结合等价类、边界值、决策表、状态转移、基于不变量的测试、少量变形测试与针对性mutation检验。

不要求安装新测试框架。沿用Node现有assert/test模式及仓库测试脚本；需要Pi的集成使用真实SDK+faux provider。性能、真实模型行为、CTF能力属于后续独立实验，不用C0/C1模拟数据冒充。

必须测试用户看到的正确结果及真实效果，不只测试实现内部自洽。一个测试至少包含：输入来源、预期规则、动作/函数、观测证据、精确断言、清理。

## 2. 测试先行步骤

1. 主 DS和测试子 DS先依据 `CAMPAIGN_CONTRACT_BASELINE.md`形成共同矩阵，不从当前函数输出倒推正确答案。
2. 生成可运行脚本和数据，保留已经正确的原断言。Bug回归在旧代码上运行，记录预期失败。
3. 外部新接口尚不存在时，import失败只说明尚未实现；接口加入后仍必须证明测试会捕获错误逻辑，不能把import失败当完整red阶段证据。
4. 主 DS复核expected values、fixtures可信边界和错误原因；实现任务只拿冻结接口和测试要求。
5. 实现后跑green；主 DS再增加一小组未由实现者决定的组合反例和跨模块检查。
6. 测试错误可以修正，但修改expected前写明依据；实现与测试同步改弱不算修复。

不要为低影响的文档/显示措辞写镜像测试。本规范重点用于授权、证据、状态、恢复和副作用边界。

## 3. 矩阵字段

每个case记录：

```text
case_id
requirement_id
phase/subtask
level: contract | unit | integration | product | recovery
input_origin: trusted_host | committed_event | model_proposal | synthetic_fixture
setup / action / expected
assertion_evidence: result | artifact | counter | process | provider_request | event_chain
old_code_expected_failure
script + exact_command
actual_status: not_run | pass | fail | blocked
log_ref + exit_code
```

矩阵存为JSON或Markdown均可；禁止只有“覆盖了某模块”的完成描述。

## 4. 每个接口的测试维度

| 维度 | 必测样本与断言 |
|---|---|
| 正常 | 一个最小可信合法输入产生正确结果；避免只有负测导致实现全部拒绝仍绿。 |
| 类型/缺失 | null、数组冒充对象、空字符串、错误数组元素、缺每个required字段、非法status。返回拒绝/unknown，不TypeError崩溃、不默认success。 |
| 边界 | 0、1、limit-1、limit、limit+1，负数、非整数、非safe integer；允许边界与拒绝边界准确。 |
| 归属/权限 | foreign Campaign/Task/Episode/Stage、匹配ID但不匹配subject/scope、同名criterion、未授权target/capability。 |
| 可信来源 | LLM自报oracle、runtime包装LLM文本、缺source、未知actor，不能进入可信判断。Host记录结构不等于Oracle结果。 |
| 完整性 | 缺required criterion/stage、断链、找不到证据、假digest、过期引用；不能因剩下少量success就整体success。 |
| 幂等 | 同命令/proposal/event重复送达、同任务新随机ID、重复恢复；不能双预留、双执行、双计数。 |
| 更正/冲突 | 合法supersede、missing/foreign/cycle/forward/LLM修正、最新unknown、互相矛盾的可信判定。 |
| 变形 | 对象键顺序变化不改语义；独立事件合法重排不改结果；因果相关事件不得随意重排；增加无关历史不影响当前结果。 |
| 运行效果 | 写前意图持久、故障时文件/进程未产生、Session对象与context真的替换，不仅看返回text。 |
| 重建 | 只保留不可变Manifest与committed源，删除checkpoint/projection/report后重建；内容digest一致，unknown与预算不重置。 |
| 报告 | 授权策略可见、refs可追溯、机密不泄露、缺测量不填0、digest覆盖字段完整、实际条目/字节上限。 |

组合反例重点覆盖高风险交叉边界，不做无意义全组合。例如trusted source+foreign task，same episode+missing scope，legal unknown+其他success criteria，恢复+重复proposal+满额预算。

## 5. C0共同case种子

主 DS使用这些种子生成测试脚本。当前audit中明确复现过的问题与进一步检查点应在矩阵中区别标识，不把全部种子写成已发现bug。

### IDs/Manifest

- ID-01：五类合法ID区分；空后缀、错误类型、路径片段拒绝。
- MAN-01：合法fixture Manifest通过；缺required字段、错误类型逐项拒绝且无异常。
- MAN-02：profile/adapter兼容，未登记实现不可启用，sandbox=false显式。
- MAN-03：static target/capability受Campaign grant限制。
- MAN-04：Task ID唯一；Stage ID跨Task唯一；self/foreign/cycle依赖拒绝。
- MAN-05：criteria元素是有效值，required是boolean；错误类型不能悄悄变成optional。
- MAN-06：Campaign budget与task allocation每维一致；缺失/负值/超safe范围拒绝。
- MAN-07：所有入口接受一致的已支持版本；错误名称/major/格式拒绝。
- MAN-08：canonical持久化顺序不敏感、并发相同内容幂等、不同内容不覆盖；首次/已存在返回字段一致；非法JSON值拒绝。
- MAN-09：未知Stage oracle拒绝；inherit解析一致；注册表由可信context提供而非payload自注册。

### Queue/Dynamic

- QUE-01：依赖未完成只能queued，初始遍历顺序不造成satisfied。
- DYN-01：范围内有预算合法提案admitted；每个权限越界字段blocked并无插入/预留。
- DYN-02：全任务ID联合计数无重复；终态任务保留并计入总数。
- DYN-03：parent stage必须属于parent task；depth由真实链计算；伪depth不能过限。
- DYN-04：重复proposal命令、重复语义不同ID、环和硬限额拒绝；真实不同参数/阶段进展后任务可接纳。
- DYN-05：先admitted后应用reservation；下一proposal使用剩余额度；重复helper不能二次扣账；请求新总预算不授权。
- DYN-06：静态分配额度与动态reserved/consumed不漏扣、不双扣，所有case预期余额写成具体数字。

### Outcome/Aggregation

- OUT-01：可信完整success、可信明确failure、unknown、invalid；bogus/pending不能成功。
- OUT-02：foreign TaskOracle/Stage、缺Episode/criterion/evidence、模型自报oracle，不能给当前task成功。
- OUT-03：Stage需c1+c2，两条成功才success；只c1成功时unknown/pending；Task required stages遗漏一项不能成功。
- OUT-04：不带supersedes的同命题success/failure冲突被显示并阻断，不自动视为方法Refuted。
- SUP-01：合法correction替代旧判断；object-key重排仍匹配；修正链多步不增加独立Episode。
- SUP-02：foreign/LLM/missing scope/双null scope/双null episode/criterion mismatch/subject mismatch/cycle/forward目标皆拒绝，目标存活。
- SUP-03：被拒绝correction即使status是success/failure/unknown/invalid也不参与aggregate、不增加独立group。
- SUP-04：最新legal unknown留effective judgments，旧success不在effective facts，其他required criterion成功不使Stage整体success。
- IND-01：所有stage在同Episode/group不是多个独立Episode；缺独立证明不能以Outcome ID数计数；invalid校正另列计数。
- USE-01：有data、Action实际引用该data、可信Stage结果三项能解析才useful；foreign/missing/unknown/裸字符串标记不算useful。

### Report/Fixture

- REP-01：授权摘要字段可见，策略credentials none/manifest_policy可见，任意机密值不恢复。
- REP-02：大小写flag/ctf、Bearer、private key、token/password/api_key赋值样本在free text、数组和对象中都脱敏；合法摘要不误删。
- REP-03：Outcome ref包含ID/type/digest，Task/Episode/criterion关联可追溯；引用不含原始输出。
- REP-04：变更report_digest改变bundle_digest；除自身digest字段外输入变更按契约影响摘要。
- REP-05：同权威输入重建相同digest；生成时间/路径若非语义信息需明确处理，不靠固定旧report得到一致。
- REP-06：bundle超限显式分页/索引/缺证据提示，必需权限/判断不静默消失。
- FIX-01：fixture_only=true、replayable=false、未知保留、单synthetic组不得计多独立证据。

## 6. C1共同case种子

当前跨模块收尾的具体用例与脚本要求见 `C1_INTEGRATION_TEST_SPEC.md`。下列是通用种子，实际矩阵须指向产品入口，不能靠同名函数单测自动勾选。

C1只做durable调度层，进程测试可以用fake worker和临时状态，不调用真实模型/目标。需要真实子进程的恢复case不能全部用throw代替。

- EVT-01：runtime.note/schema1.1+已声明campaign.kind验证；unknown kind、foreign Campaign、LLM authority不能触发转移。
- EVT-02：命令ID去重、expected_revision检查、admission+reservation单事件语义，重放只应用一次。
- PRJ-01：合法状态转移；依赖可信结果才ready；最多一个running；历史unknown等待新判定不重新发副作用。
- PRJ-02：同输入replay与checkpoint+后续事件产生相同projection；重复事件、未知major、断链拒绝。
- BUD-01：限额边界、static/dynamic allocation、consumed/reserved转移、cancel释放、Session继承、重启不归零。
- WRT-01：两个真实进程同Campaign争用，只有一个写者；不同Campaign互不影响。
- WRT-02：活写者paused/阻塞时间超过heartbeat，不能仅expiry抢占；owner死后可回收；旧owner恢复写入必须被拒绝或明确不支持且阻止第二写者。单机可选fail-closed ownership，别宣称分布式lease。
- CKP-01：缺/陈旧/损坏/foreign Manifest或digest/revision checkpoint不覆盖event truth；临时半写文件不变成有效checkpoint。
- CKP-02：快照先后时机、write/rename/fsync失败，仅影响缓存或按已声明策略停止；不得改旧日志/重复副作用。
- RUN-01：pause/resume/cancel、SIGTERM、预算耗尽停止新dispatch；正在动作进入drain/reconcile而非假completed。
- REC-01：持久意图之前退出 ->无worker效果；意图之后结果之前退出 ->unknown/reconciliation而非重发；结果记录后checkpoint前退出 ->replay后不重复。
- REC-02：non-idempotent未确认结果不自动重试，readonly/idempotent retry有上限，fail-closed不编译为方法失败。
- END-01：一个完整两任务+动态派生+delayed oracle+重启Campaign串起上述行为，保留事件、最终文件和计数。

## 7. 测试脚本和命令

### 脚本产物

主 DS在tests目录生成真实可运行的脚本，建议沿用当前两个C0脚本并增加有明确职责的组合审查脚本；不要每个assert造一个文件。C1可以按projection/persistence/scheduler三个层次建脚本和一个child-process harness。

测试helper共享fixtures仅提供原始输入和证据索引，不能调用被测聚合函数生成expected。测试脚本不能伪造authority让一切通过；正例需要完整受信任输入，负例只改变待测字段。

### C0当前命令（仓库根目录）

```bash
node Pi_Agent_base/tests/aegis-campaign-contracts-c0.mjs
node Pi_Agent_base/tests/aegis-campaign-fixture-c0.mjs
./Pi_Agent_base/pi/node_modules/.bin/biome check --config-path=Pi_Agent_base/aegis-biome.json Pi_Agent_base/memory/campaign Pi_Agent_base/tests/aegis-campaign-contracts-c0.mjs Pi_Agent_base/tests/aegis-campaign-fixture-c0.mjs
```

新增脚本也加入phase runner的显式allowlist。类型检查采用主 DS添加并如实说明覆盖范围的Campaign配置，不能使用旧Batch E配置冒充覆盖Campaign。

### 真实Pi/faux测试的启动方式

```bash
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/<实际测试文件>.mjs
```

每个已有脚本可能有不同依赖，以完整头部和真实启动路径为准。先使用正确resolver再判定是否是构建环境失败。区分未运行、blocked、非零失败，不把环境错误计入pass。

### 回归和总runner

依据 `docs/AEGIS_RUN_AND_ACCEPTANCE.md`和实际受影响模块选择当前回归。每个阶段结束跑一次显式列表，逐命令保存exit code、stdout/stderr私有路径与原因。总runner任一required suite失败时退出非零；blocked也阻止该集成能力验收，但不自动否定已验证纯函数。

禁止运行整个Pi monorepo真实e2e集合、继承凭据触发付费测试、安装新依赖或调用真实模型来替代离线验证。

## 8. 有限mutation检验

只针对本轮critical guards做少量临时变异，不安装重型平台、不污染主工作树。主 DS选取5–8个高价值点，在隔离副本中删除一个guard/改变一个状态，运行对应测试。测试必须因行为断言而失败，不能仅syntax/import错误。

例子：删除scope存在性检查；把依赖queued变ready；让foreign taskOracle通过；忽略required criterion；重复applyAdmission；跳过durable-before-worker；bundle不覆盖report digest。

记录mutation -> case -> 预期FAIL -> 实际FAIL。失败仍绿说明测试盲区，先补测试再交付。mutation不要求所有代码100%覆盖。

## 9. 产品接线证明

- 一个case名称含Scheduler/checkpoint/recovery，不说明它真的走了该路径；矩阵记录真实入口和被使用状态。
- checkpoint+tail测试必须实际从缓存snapshot初始化并应用tail，再与full replay完整state比较；重复调用full replay不算缓存恢复。
- Dynamic Task不能预置在初始ownedTasks里再称动态分发；删submitted仍应拒绝，正常链必须实际创建并执行。
- Real EventLog独立append测试只证明日志库；Scheduler durability需createCampaignScheduler+真实EventLog的effect前后故障测试。
- append failure测试覆盖effect之后的所有权威提交；ok/durable false与throw均需断言新dispatch停止。
- 未决reconcile需实际读取临时产物并判断；只有requested事件不算恢复完成。
- 子进程fault使用真实边界barrier/IPC，不靠固定sleep掩盖代码路径；有界timeout用于防挂。

## 10. 交付与测试诚实性

- 测试块数、assert数、property case数分别报告，不称“58个测试块/断言”混淆。
- 不能以函数返回ok或报告写accepted为唯一断言；验证其对应数据和效果。
- 删除派生文件后由Manifest+committed source重建，不能重新读旧report或用同一聚合器生成预期。
- fixture only、真实SDK+faux、真实本地进程、真实网络各标验证层级。
- 记录pending/blocked和未测能力。所有P0/P1发现闭环前不发布phase accepted。
