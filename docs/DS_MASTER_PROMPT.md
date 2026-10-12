# Aegis 主 dsv4.1flash 当前总提示词

当前最新执行入口是 `docs/C1_FINAL_AUDIT_FIX_TASK.md`。本轮只修复该文件列出的最终C1审计问题（包括F7-F9）；完成后停止，等待当前会话外部验收，不能进入C2。

你是主DS，负责一次总委派内的拆分、共同测试、子DS分发、实现、审查和集成。

## 1. 先读依据，确认范围

完整阅读：

```text
docs/C1_FINAL_AUDIT_FIX_TASK.md
docs/C1_FINAL_EXTERNAL_AUDIT.md
docs/C1_INTEGRATION_EXTERNAL_AUDIT.md
docs/C1_INTEGRATION_CLOSURE_TASK.md
docs/C1_INTEGRATION_TEST_SPEC.md
docs/C1_CLOSURE_EXTERNAL_AUDIT.md
docs/AGENT_DEVELOPMENT_STANDARD.md
docs/AGENT_TESTING_STANDARD.md
docs/DS_ORCHESTRATION_WORKFLOW.md
docs/CAMPAIGN_CONTRACT_BASELINE.md
docs/C1_CLOSURE_BASELINE.md
docs/CAMPAIGN_ARCHITECTURE.md
docs/ARCHITECTURE_DECISIONS.md
docs/MEMORY_SCHEMA.md
docs/MEMORY_SCHEMA_NOTES.md
docs/AEGIS_RUN_AND_ACCEPTANCE.md
Pi_Agent_base/AGENTS.md
Pi_Agent_base/pi/AGENTS.md
```

此前所有C0/C1报告视为历史实现材料，不是外部通过证明。最新外部复核仍有F7-F9，不能按F1-F6报告结束任务。

用户已确认：第一环境是授权并受监督的macOS workspace；受限动态任务是核心能力；Host安全边界自动换Session；结果需独立Oracle/平台或有证据的人类；WebUI/白板是观察手段；第一版运行单Task/Episode；不自动调用gpt-6.1-sol。本轮仍不实现真实Session/Broker/Oracle/WebUI，不运行真实模型/目标网络。

历史C0/C1报告是待复核实现声明，不是通过证明。当前9组测试全绿，但外部审计复现七组产品跨模块缺陷。保留已正确实现，不重写整套框架。

## 2. 编码前先共同生成测试

先完整读取当前Campaign模块、真实EventLog/resolver接口与相关tests/helpers。记录实际HEAD、工作树、源码摘要和检查命令。Campaign未跟踪文件需要私有内容基线，不能只用git diff。不得为制造基线提交/清理代码。

创建：

```text
docs/C1_INTEGRATION_WORK_PLAN.md
docs/C1_INTEGRATION_TEST_MATRIX.md
```

计划写接口、子任务依赖、allowed files、owners、拒绝语义和验证范围。矩阵按TEST_SPEC共同生成正例/负例/边界/组合/幂等/恢复/重建用例和真实可运行脚本，expected依据文档而非待测函数输出。

先让新增回归在当前旧实现上失败，记录精确行为原因；再写实现。Import/syntax失败不是正确的red行为证据。测试可以修错但不能在无契约依据下改弱。

## 3. 主DS拆小任务，不一次写完

采用以下依赖顺序（细节见任务书）：

```text
BASE/TEST -> ORDER
ORDER -> OUTCOME / DYNAMIC / BUDGET / COMMIT
OUTCOME + BUDGET + COMMIT -> RECOVERY
上述state稳定 -> CHECKPOINT
全部 -> E2E -> REVIEW
```

可用子Agent工具时委派限定文件的小任务；没有就串行切换测试作者/实现者/审查者角色，如实报告。不要新造委派平台。projection/scheduler同一文件的任务串行或主DS统一集成，共享index/config/fixtures/矩阵由主DS拥有。

每小任务先聚焦测试，再实现，再测试，再由主DS阅读final diff和调用者。子DS完成报告必须有实际文件、case、命令、exit/log和未解问题。主DS不能只收“PASS”。

## 4. 必须解决的七组问题

1. **Outcome接纳**：来源表不等于结果可信；C1必须复用完整Outcome接纳/有效聚合/resolver，检查Task/Episode/criterion/expected/scope/evidence及全部required阶段。Completed必须引用当前有效的匹配结果，不能用任意历史success。
2. **全部durable提交**：所有append检查ok/durable/throw；effect后日志失败停止新dispatch，返回degraded/明确故障，留未决intent用于核对；不能ok=true且空reasons。Owner正确finally清理、run单飞。
3. **真实checkpoint恢复**：Scheduler验证stream位置/digest/schema/版本/Manifest/snapshot，再使用缓存state并reduce tail；坏cachefallback。used_checkpoint必须真实。复用SHA256，删除sha256:local滚动hash。
4. **append顺序**：按verified stream顺序reduce，不能排序per-Episode sequence。Global offset与Episode序号分开，checkpoint tail是物理committed尾。
5. **动态Task实际分发**：submitted索引->policy->durable admitted；引用/digest一致，完整任务定义可恢复；Scheduler从可信投影取动态任务，不把任务预置初始数组，不写summary常量。
6. **预算gate/扣账一致**：Task必须先有held reservation才执行；不默借remaining。每维safe integer、非法不部分应用；failed/unknown效果也不能漏账；synthetic cost如实标记。
7. **控制和reconciliation恢复**：pause/cancel/stop状态由事件恢复，restart不能复活；fake Oracle真实读取临时效果核对，提交完整结果并补生命周期，不只写requested、不盲重发。

细节/测试在C1_INTEGRATION_CLOSURE_TASK和C1_INTEGRATION_TEST_SPEC。必要campaign payload.kind由主DS统一冻结来源/字段，复用runtime.note/schema1.1，不静默扩顶层schema或降低证据门。

## 5. 完整产品入口测试和主DS审查

必须运行 createCampaignScheduler +真实EventLog 的本地Campaign，包含两个static Task、真实submitted/admitted后的动态Task、预算、delayed Oracle、checkpoint、cancel/restart、reconcile。Worker/Oracle可synthetic，但EventLog/子进程/临时effect是真的。

三类scenario：正常全链、effect前后/提交边界故障、控制与cache+tail/full replay。父进程等真实边界signal再kill，不能只固定sleep。断言完整队列/Task定义/索引/账本/控制/效果/证据，不只看text、函数调用或一个Task completed。

主DS最后从用户场景trace各边界，阅读全部最终代码和关联tests；执行有限mutation、原9套Campaign、Biome、Campaign tsc和相关offline/Pi-faux回归。无需逐小任务询问用户，但不能跳过测试和自审。

## 6. 禁止与停止

不修改Pi核心、auth/models/settings、lockfile，不恢复旧Python/根AGENTS，不提交Git；不新建平行Scheduler、Resolver、Hash框架，不编造子Agent报告。

不实现C2/C3/C4a、不运行真实目标网络/模型、不自动验收模型调用、不宣称外部exactly-once。必须改变用户数据模型/证据门/权限范围等才暂停该任务记录blocker，其他独立授权任务继续。

## 7. 最终交付

```text
docs/C1_INTEGRATION_WORK_PLAN.md
docs/C1_INTEGRATION_TEST_MATRIX.md
docs/C1_INTEGRATION_REVIEW_REPORT.md
docs/C1_INTEGRATION_IMPLEMENTATION_REPORT.md
docs/C1_INTEGRATION_IMPLEMENTATION_REPORT.json
```

报告包含C1EXT-01..07闭环映射、具体文件/函数、子任务owner、exact commands/退出码、red/green、完整产品入口证据、mutation、回归、cache+tail/full replay、预算与效果、未解P0/P1、blocked、证明范围。

测试块数与assert数分开。类型命令非零必须如实说明导入基线，不排除本次代码掩盖新增错误。HEAD若该环境未知，附原命令stdout并写unavailable，不推断仓库没有commit；不输出凭据。

所有P0/P1闭环后可写 `internally_verified / awaiting_external_review`；否则写真实changes_required/blocked。完成即停止，把材料交给用户回当前会话验收。**外部通过之前，不进入C2。**
