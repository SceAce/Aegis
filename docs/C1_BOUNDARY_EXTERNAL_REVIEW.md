# C1 F10–F13 交付外部复核

当前执行决定（用户确认，覆盖下文历史阻塞定位）：**C1 只收尾 F14；F15 非阻塞、F16 后置；F14 修复及限定验证通过后进入 C2**。F16 原 P1 阻塞定位撤销，prefix 读取次数是缓存优化诊断而非当前正确性门槛。原始复现、测试结果仍保留，不表示后置问题已修复。通用规则见开发规范 §3.1。
审计基线：`7656e99`，分支 `audit/c1-external-boundaries`，开始时工作树干净。
本轮只增加外部测试和更新委派/审计文档，不改产品实现，不改 DS 历史交付报告。

## 1. 已确认的进展

Git 提交存在且按任务分组：532ea85、6fa367c、9bb8da4、3d4b09d、7656e99。
原 F10-F13 外部 21 用例独立运行全部通过。当前 17 个 Campaign 脚本均 exit 0；
8 offline + 4 真实 Pi SDK/faux 回归 exit 0；Campaign Biome exit 0。
类型检查 exit 1，仍为 fixture/contracts 2 个、runtime/events 8 个旧导入诊断。

scope 缺失 fail-closed、非空证据、匹配 Episode、writer 保存 Episode、去重字段及
Stage 内容进入状态摘要都有实际修复。旧测试改动主要增加可信 scope/Episode fixture，
不是通过删除外部失败断言得到绿灯。

但是 F11 的 Stage 绑定和 F12/F13 的恢复约束还有遗漏，不能外部验收通过。

## 2. F14 / P0：Stage 独立来源与内部 Stage 绑定仍可绕过

位置：`memory/campaign/outcome-resolver.mjs` 的 `resolveStageOutcome`；
`projection.mjs` 的 Stage result 准入与 canonicalStageOutcome 调用。

独立性代码为 `if (result.provenance && result.provenance.independent !== true)`，
因此整个 provenance 缺失/为 null 时不检查，inner source 又可从 oracle.source 回退。
保持完整合法 task Oracle，Stage provenance=undefined 或 null 时，两条完成门都 completed。
这违反 F11 已冻结的“独立 provenance 必须存在”，不是新需求。

resolver 还没有比较 result.step_id/stage_id 与声明 Stage。外层 event.step_id=stage-a、
内部 Outcome.step_id=stage-foreign 时，resolver 仅检查 criterion，canonicalization 随后
用外层 stepId 覆盖内部绑定，导致 foreign Outcome 被重标为本 Stage 并完成任务。

真实 Scheduler + EventLog 的 reconcile 也分别复现上述两个假完成：worker calls=0。
相同入口完整绑定正例通过。Oracle 与 artifact index 是 synthetic，EventLog 的
append/fsync/replay 与 Scheduler 是真实本地执行，无模型、网络或真实目标。

新增用例：6 个两条门投影反例，2 个产品反例，另有投影/产品两个合法控制。
期望：缺失独立性证明拒绝/unknown；内外归属冲突不能经规范化洗成合法结果。

## 3. F15 / P1：hydration 仍修改调用方 checkpoint

位置：`projection.mjs` priorState 初始化中 reservation/budget_consumed/definition/
stage_ids 的引用赋值，及 proposals/outcomes index 恢复。

只有 task_outcomes/stage_outcomes 被深克隆。item.reservation 仍直接引用 row.reservation。
实测：prefix reservation 每维 10，恢复应用消耗 1 的 tail 后，调用方 priorState 里的
reservation 被改成每维 9。再次使用同一缓存对象会以已经消耗的 reservation 为起点，
账本与任务预留可能不一致。该问题违反本轮任务“不 mutate 调用方 checkpoint”的要求。

新增测试先确认 tail consumed.model_requests=1，再断言输入 checkpoint deepEqual 原副本，
失败只在 reservation 字段变化；不是未执行 tail 的假阳性。
期望：隔离所有可变恢复状态；重复用同一 priorState 得到同一结果且不改输入。

## 4. F16 / P1：接受 checkpoint 后仍由 full replay 驱动

位置：`scheduler.mjs` run 中 baseProjection 后的 reconcile/loop/persist/status 路径。

startup 会验证缓存摘要并 reduce tail，但只用恢复结果读初始 controlState。随后
`reconcileStrandedRunning(project())`、循环 `projection=project()`、checkpoint 与
snapshot 又全部从头 project。used_checkpoint=true 不能证明恢复 state 驱动调度。
这是 F13 任务已明确要求但交付未完成的接线。

真实产品测试：EventLog 写合法 completed Task 和 cancelled control，真实 checkpoint
write/read 后追加 resumed tail，再启动 Scheduler。used_checkpoint=true、control=running、
Task=completed 都成立。用透明 Proxy 统计旧 prefix payload 访问次数，值不被改变。
测试允许一次 prefix replay 做权威验证；实际为 144 次 payload 访问，单次基准为 24，
说明后续流程反复全量归约。该观测与代码调用链一致。

期望：缓存验证与 fallback 可以读取权威 prefix；缓存有效后 reconcile/dispatch/control/
persist/status 使用同一恢复投影和新 committed tail。不能仅设置布尔值后丢掉恢复结果。
不要求日志验证本身跳过链检查，也不要求性能 benchmark。

## 5. 新增测试矩阵与结果

脚本：`Pi_Agent_base/tests/aegis-campaign-c1-boundary-review.mjs`。
命令：`node --test Pi_Agent_base/tests/aegis-campaign-c1-boundary-review.mjs`。
实际：**12 个 node:test 用例，2 pass / 10 fail，exit 1**；无 skip/todo。

| 需求 | 用例数 | expected | 实际 |
| --- | --- | --- | --- |
| CONTROL | 1 | 两门完整绑定都完成 | pass |
| F14 缺 provenance（undefined/null × 两门） | 4 | 不完成 | fail：completed |
| F14 外来内部 Stage ID（两门） | 2 | 不完成 | fail：completed |
| F15 cache 输入不变 | 1 | tail 生效且原输入不变 | fail：reservation 被改 |
| F14-PRODUCT 完整绑定 | 1 | 完成、worker=0 | pass |
| F14-PRODUCT 缺 provenance / foreign Stage ID | 2 | 不完成、worker=0 | fail：completed |
| F16 真缓存后续接线 | 1 | 有效 cache+tail 驱动，不反复 full reduce | fail：重复归约 prefix |

日志和逐命令真实退出码：
`Pi_Agent_base/runtime/dev/c1-boundary-recheck/results.json` 与相邻 log（ignored）。
本次未复跑 DS mutations，不将其报告当作独立证实；新反例为原实现上的行为 red 基线。

## 6. 报告一致性

- DS `runtime/dev/c1boundary/red-baseline.log` 的真实汇总为 21 tests / 2 pass / 19 fail。
  报告“3 pass / 19 fail”不能相加到 21，属于计数错误，下一版必须纠正。
- 当前 SHA256 对 abc 的标准向量比较为 true，a/b 摘要不同；HEAD 长度 40，git cat-file
  将其解析为 commit；git fsck --full exit 0。不能据当前证据称对象库是 placeholder
  或 crypto 被 stub，更不能据聊天显示推断系统被篡改。
- equality/change 断言适用于变形测试，但它们本身不能证明 SHA256 标准算法正确，也不能
  支持“显示层清零”归因。原始异常若仍可复现需另附具体环境/命令/字节证据，未证明记 unknown。

## 7. 下一步

执行更新后的 `C1_BOUNDARY_FOLLOWUP_TASK.md`：只做 F14 最小修复与相关回归；F15 非阻塞可顺手处理，F16 后置，不要求本文件混合套件全绿。可复制提示词为 `C1_BOUNDARY_FOLLOWUP_DS_PROMPT.md`。保留原反例与真实结果，用 required/deferred 清单区分，不删除断言或伪称已修。复用现有交付报告，限定外部 F14 验证通过后进入已获用户同意的 C2，不再因 F15/F16 重开 C1。
