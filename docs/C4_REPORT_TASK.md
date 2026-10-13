# C4：确定性 Campaign 报告与有界验收包

状态：**accepted_with_recorded_limits，本轮审查/授权修复完成**。实际追加证据与限制见 `C4_EXTERNAL_REVIEW.md`；以下为本轮冻结范围历史，下一任务是 `C4A_OBSERVATION_TASK.md`，不要重复启动 C4。
前置 C3 本轮审查/修复结论见 `C3_EXTERNAL_REVIEW.md`；C1/C2 不重开，F16 后置。
遵守开发规范 §3.1，冻结本文件核心目标，不将 UI、缓存优化或类型清库增加为门槛。

## 1. 交付目标

把现有 `memory/campaign/report.mjs`、aggregate/resolver 与 committed EventLog 接到一个
可运行的离线导出入口，生成：

```text
campaign-report.json
campaign-report.md
acceptance-bundle.json
reviewer-prompt.md
```

报告如实回答：哪些 Task/Stage 完成、依据哪些 Outcome/artifact，哪些 unknown/故障/缺证据，
实际动作/Session/预算用了多少，哪些运行或环境限制尚未验证。
验收包是用户带回外部会话的只读材料，不自动调用任何模型、不修改学习存储。

## 2. 输入、信任与重建

- 输入是 immutable Manifest + 验证过的 committed EventLog，以及受信任有界 artifact 索引/摘要。
  不以 summary.json、checkpoint、Host 内存 counters、旧 report 为成功/授权 truth。
- 复用 C1 projection、C3 evidence reconstruction/Oracle binding、C0 aggregation/report；不新造
  第二套判断逻辑。静态/动态 Task definition 从可信事件恢复，unknown/冲突/supersedes 保留。
- 导出只读权威输入，不调用 Worker/Broker/实时 Oracle 产生新效果。日志损坏时显式 integrity
  failure/inconclusive，不能猜出成功；缺失 artifact 可见，不借模型自报引用补证据。
- 区分历史真实结果、当前证据可用性和 Task 生命周期，不能为了报告补绿色状态。

## 3. 报告必需内容

| 内容 | 规则 |
| --- | --- |
| Manifest、授权、环境与版本 | canonical digest/revision、允许目标/能力/网络/监督、workspace_is_sandbox=false；不复制私密配置 |
| Task/Stage/Outcome | 状态、关联 IDs、criterion/scope、Oracle/source、证据 ref/digest、supersedes/冲突/unknown/拒绝原因 |
| 动态任务与控制 | submitted/admitted/rejected/blocked、父链、队列与 pause/cancel/recovery 状态 |
| 动作/Session/预算 | 从 committed events 去重统计实际记录；区分请求/执行/拒绝/transport；Session 与独立 Episode 分开；synthetic 与实测分开，缺测量 null/unknown |
| 完整性与缺口 | event chain/tail、证据缺失、故障、unsupported claims、后置限制；cache 成功不等于全部证据可信 |
| provenance 摘要 | implementation/Pi/ROM/tool/Oracle 等可获取真实摘要；不可获取记 unknown，不编造模型版本或价格 |

已有 Host counters 未覆盖全部路径，不能直接读取零值当实际测量。预算采用当前账本基础
与轮换增量语义，报告不能重复累计或跨 Task 丢账。

## 4. 冻结 required 验收

1. **正常产品导出**：运行 C3 fixture，从保存的 Manifest/事件导出四个产物，Task/Stage/
   evidence 可追溯，JSON 与 Markdown 一致；CLI/调用方法有可复制文档。
2. **unknown/delayed/故障**：未完成、拒绝、cancel、审计故障不会变成功，缺证据明确显示。
3. **重建确定性**：删除 checkpoint/summary/report 后，从同一源重建相同 semantic/report/bundle
   digest。生成时间和输出路径若非语义字段显式排除；增加无关排版不能污染判断。
4. **摘要完整性**：report 语义/证据变化改变摘要；bundle 覆盖 report_digest，不能仅 IDs 自洽。
5. **隐私与界限**：字段白名单，测试含凭据、flag、Bearer、私钥和 raw tool text；公开产物
   不含真实机密值。固定条目/字节界限，超限显式索引/分页/缺省引用，不能静默丢关键证据。
6. **计数与预算**：重复事件/命令不双计，真实记录数与 ledger 一致，Session 不当作独立证据。
7. **只读与验证器**：导出前后源字节不变、无执行/网络；本地结构 validator 识别 bundle/ref/
   digest 缺失或矛盾；reviewer prompt 要求 accepted/rejected/inconclusive/needs_more_evidence。
8. **相关回归**：已有 report/C0/C1/C3 受影响路径保持通过；F16 与旧类型诊断单列。

可以合并为少量产品场景与脚本，不要求新的测试框架、全部组合或固定 mutation 数量。
先依据冻结规则写 red，不用同一个聚合器生成 expected；真实本地源、faux/synthetic 层级明确。

## 5. 范围与协作

C4 只做 report/export/bundle/validator/prompt，不做 C4a WebUI、远程平台/容器、多用户、
学习效果实验、统计因果声称或全库类型清理。无真实模型/网络/目标，不修改 Pi/凭据/锁文件。
发现仅当前报告假成功、隐私泄漏、错误计数/预算或 source 被修改才阻塞，其他记后置。

主 DS一次接收：契约/白名单与 digest 范围 → 源投影 → 写入/validator → 产品测试/审查。
内部小任务按依赖自主完成，不每一步交外部验收。没有子 Agent 工具就串行如实报告。
复用已有报告模块，配置/导出/runner 由主 DS统一管理，不交叉改文件。

## 6. Git 与精简交付

新建 `feat/c4-report`（或等价）任务分支，记录 baseline/status；明确路径暂存、审查、本地
里程碑 commits，不 push/改写历史、不混入无关修改。
维护简洁 `C4_REPORT_WORK_PLAN.md`、`C4_REPORT_TEST_MATRIX.md`、`C4_REPORT_IMPLEMENTATION_REPORT.md`，
附真实命令/exit/log、产物路径/digest、required/deferred、commits/status/限制，日志 ignored。
旧类型诊断和不适用的历史功能不伪称通过，也不新增为本轮硬门槛。
内部通过后标 internally_verified / awaiting_external_review，交一次限定 C4 验收；
不自动进入 C4a/C5，不自动调用验收模型。
