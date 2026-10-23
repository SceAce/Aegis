# Work-cycle / 跨 Session 连续性测试矩阵

状态：**第一阶段实现自测记录；独立审查发现 F1/F2/F3，结论 changes_required。**
旧用例通过记录保持不变；后续新增 required 与 red→green 证据按 [第二阶段任务书](WORK_CYCLE_PHASE2_IMPLEMENTATION_TASK.md) §6–§7 追加，不将既有全绿替代新验收。
契约与阈值见 [T0 基线](WORK_CYCLE_T0_BASELINE.md)；实现与命令结果见
[实现报告](WORK_CYCLE_IMPLEMENTATION_REPORT.md)。

新增脚本（显式清单，不从 wildcard 自动继承）：

| 脚本 | 层级 | 覆盖 |
| --- | --- | --- |
| `Pi_Agent_base/tests/aegis-work-cycle.mjs` | pure reducer | WC-01–05, WC-08（review 记录形状/refs）, WC-09, WC-10（部分）, WC-11, WC-12 建议 |
| `Pi_Agent_base/tests/aegis-work-cycle-ram.mjs` | projection | WC-06, WC-11, WC-14, EXP-NT |
| `Pi_Agent_base/tests/aegis-work-cycle-sdk.mjs` | real SDK + faux, product path | WC-07, WC-08, WC-09, WC-10, WC-11, WC-12, WC-13 |

## 1. 用例表

| case | req | 输入来源 | 动作 / 断言 | 脚本 | 结果 |
| --- | --- | --- | --- | --- | --- |
| WC-01a | WC-01 | committed events | 同一 committed prefix 两次投影 deep-equal | aegis-work-cycle | pass |
| WC-01b | WC-01 | committed + foreign Episode | 外域 action 不计入 action_count；无 episode 投影为 inactive | aegis-work-cycle | pass |
| WC-02a | WC-02 | policy `repeat_limit=3` | 2 次同参同结果不触发 | aegis-work-cycle | pass |
| WC-02b | WC-02 | policy `repeat_limit=3` | 第 3 次触发，repeat_count=3 | aegis-work-cycle | pass |
| WC-02c | WC-02 | policy `repeat_limit=3` | 第 4 次仍触发（limit+1），不重复计数错误 | aegis-work-cycle | pass |
| WC-02d | WC-02 | policy `repeat_limit=2` | Host 配置的 2 次限额生效，证明不是硬编码 3 | aegis-work-cycle | pass |
| WC-03a | WC-03 | committed events | 同 tool/args、不同 content_digest 不触发 | aegis-work-cycle | pass |
| WC-03b | WC-03 | missing content_digest | unknown 结果不视为相同结果，也不产生 failure/refuted | aegis-work-cycle | pass |
| WC-04a | WC-04 | 7 个 effect 完成 | 低于 window 不触发 | aegis-work-cycle | pass |
| WC-04b | WC-04 | 8 个 effect 完成 / 8 个不同签名 | 触发 broad stall | aegis-work-cycle | pass |
| WC-04c | WC-04 | 8 个 effect 完成 / 3 个签名 | 低于 min_distinct_routes 不触发 | aegis-work-cycle | pass |
| WC-04d | WC-04 | 20 个 read | 只读工具完全不进入 effect route | aegis-work-cycle | pass |
| WC-04e | WC-04 | 8 routes + oracle success | 可信 progress 重置窗口 | aegis-work-cycle | pass |
| WC-04f | WC-04 | 8 routes + 无 criterion/observed/evidence 的 oracle 行 | 不是 trusted progress，仍触发 | aegis-work-cycle | pass |
| WC-04g | WC-04 | verified observation（value+evidence+revision，human） | 重置窗口 | aegis-work-cycle | pass |
| WC-04h | WC-04 | llm 自报 verified observation | 不重置窗口 | aegis-work-cycle | pass |
| WC-05a | WC-05 | Intent + assistant prose + checkpoint + `tool_ok:true` | 不清除 repeat_count / 不解除 hold | aegis-work-cycle | pass |
| WC-08a | WC-08 | committed review + selection | 投影 awaiting_scoped_intent，并暴露 selection/status/IDs | aegis-work-cycle | pass |
| WC-08b | WC-08 | review 引用 foreign evidence | review 不可用，保持 review_required | aegis-work-cycle | pass |
| WC-08c | WC-08 | review 缺 selection / selection 在 review 之后 / mode=automatic | review 不可用（fail-closed） | aegis-work-cycle | pass |
| WC-08d | WC-08（product） | 本地 seed + faux | `aegis_work_review` 实际检索到 `techniques/parser.json#*`，selection 事件 durable | aegis-work-cycle-sdk | pass |
| WC-08e | WC-08（product） | `AEGIS_KNOWLEDGE_ENABLED=off` | 第二次 review 记录 retrieval.status=`disabled`，selected 为空，不宣称已检查知识 | aegis-work-cycle-sdk | pass |
| WC-09a | WC-09 | review 后同 scope Intent | 仍 awaiting | aegis-work-cycle | pass |
| WC-09b | WC-09 | review 后未引用 review 的 Intent / claim | 仍 awaiting | aegis-work-cycle | pass |
| WC-09c | WC-09 | 新 scope + 引用 review（或 selection） | 解除 hold，work_unit 更新 | aegis-work-cycle | pass |
| WC-09d | WC-09（product） | 真实 `aegis_propose` | 未引用/同 scope 在 tool admission 被拒并给出具体 reason；无新 Intent | aegis-work-cycle-sdk | pass |
| WC-09e | WC-09（product） | 引用 review 的新 scope Intent | 被接受，后续 effect 真正执行并完成 | aegis-work-cycle-sdk | pass |
| WC-10a | WC-10 | 第二次相同 review | 投影仍 awaiting，只保留 review 记录 | aegis-work-cycle | pass |
| WC-10b | WC-10（product） | 重复 `aegis_work_review` | 只有 1 个 work.review、1 个 work_review selection；响应 `reused:true` | aegis-work-cycle-sdk | pass |
| WC-10c | WC-10 | selection 已提交但 review 行未提交（模拟 durable 失败） | 门保持 review_required | aegis-work-cycle | pass |
| WC-10d | WC-10 | 20 个 selected ids | review 记录限制为 8 个 ID | aegis-work-cycle | pass |
| WC-11a | WC-11 | complete checkpoint | checkpoint.unit_status=complete，但 review 门不解除 | aegis-work-cycle | pass |
| WC-11b | WC-11 | foreign-evidence checkpoint | checkpoint 被拒绝（null） | aegis-work-cycle | pass |
| WC-11c | WC-11（product） | `aegis_work_checkpoint complete` | 事件/Board Artifact/RuntimeState 可见；无 Fact/Outcome/新 Episode | aegis-work-cycle-sdk | pass |
| WC-12a | WC-12 | clear + complete checkpoint | `recommendWorkHandoff` 给出 advisory（work_unit_complete） | aegis-work-cycle | pass |
| WC-12b | WC-12 | review_required + context pressure | 不推荐 handoff（不得用轮换绕过复核） | aegis-work-cycle | pass |
| WC-12c | WC-12 | 真实 `ctx.getContextUsage` 形状 | known/percent 正确；未知 tokens → known:false | aegis-work-cycle | pass |
| WC-12d | WC-12（product） | 真实 Host `SessionSupervisor.rotate` | 新 SDK Session 对象/文件/id；同 Episode；预算不减不增；无 transcript 重放；handoff payload 带 unit/review refs 且无授权字段 | aegis-work-cycle-sdk | pass |
| WC-13a | WC-13 | 注入未完成 action.requested | `evaluateHandoff` 拒绝，supervisor precheck 拒绝 | aegis-work-cycle-sdk | pass |
| WC-13b | WC-13（product） | 上述状态 | 无新 Session 对象、无 handoff.completed | aegis-work-cycle-sdk | pass |
| WC-13c | WC-13 | 真实提交 action.completed 后 | 允许并在真实 SDK 中轮换一次 | aegis-work-cycle-sdk | pass |
| WC-06a | WC-06 | RAM + review | `task.work_cycle` 状态/原因/evidence alias/review/next_step 可见，trust 标签正确 | aegis-work-cycle-ram | pass |
| WC-06b | WC-06 | RAM 默认预算 | 完整 JSON ≤ 8000；`data` 与 `text` 一致（既有 RAM 测试回归） | aegis-work-cycle-ram / aegis-ram-projection | pass |
| WC-06c | WC-06 | pending + tiny budget | pending/task/授权保留；不可容纳时报 core_overflow，不静默截断 | aegis-work-cycle-ram | pass |
| WC-14a | WC-14 | 12 个旧 checkpoint + 大知识行 + 1400 预算 | 核心/pending 不被挤掉，omission 可统计 | aegis-work-cycle-ram | pass |
| WC-14b | WC-14 | 外域 review/checkpoint | 不进入当前 Episode RAM frame | aegis-work-cycle-ram | pass |
| EXP-NT | EXP/T5 | stale/unmatched experience.decision + active Experience rule | 规则仍为 `rule/not_authorization`；review 门仍阻断 effect；知识检索/review 仍可用；无 Fact | aegis-work-cycle-ram | pass |
| EXP-01 | EXP-01 | — | 仅提供四臂评估计划；本轮未调用真实模型/网络 | 报告 §5 | not_run（需单独授权） |

## 2. 命令与真实退出码（本轮最终工作树）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node Pi_Agent_base/tests/aegis-work-cycle.mjs` | 0 | pure reducer pass |
| `node Pi_Agent_base/tests/aegis-work-cycle-ram.mjs` | 0 | RAM/Board/State/negative-transfer pass |
| `node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-work-cycle-sdk.mjs` | 0 | 真实 SDK+faux 产品路径 pass |
| `node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs Pi_Agent_base/runtime/dev/work-cycle-final aegis-work-cycle-sdk aegis-observer-failclosed-pi aegis-observer-runtime-handoff aegis-c2-session-rotation aegis-knowledge-sdk aegis-ram-reaudit-sdk aegis-knowledge-campaign aegis-tui-render` | 0 | 8 scripts, 0 failed |
| `Pi_Agent_base/tests/helpers/run-required.sh Pi_Agent_base/runtime/dev/work-cycle-required-final 6` | 0 | 68 scripts, 0 failed |
| `biome check`（14 个改动文件，`Pi_Agent_base/aegis-biome.json`） | 0 | 0 error；1 个 HEAD 既有 warning（`agentConfigDir` 未使用） |
| `tsc -p tsconfig.aegis-extensions.json --noEmit` | 1 | 116 条诊断，与 HEAD 基线逐条一致（无新增） |
| `tsc -p tsconfig.aegis-campaign.json --noEmit` | 1 | 193 条诊断，与 HEAD 基线逐条一致（无新增） |
| `tsc -p tsconfig.aegis.json --noEmit` | 1 | 190 条诊断，与 HEAD 基线逐条一致（无新增） |

日志（ignored/private）：`Pi_Agent_base/runtime/dev/work-cycle-final/`、`work-cycle-required-final/`。

## 3. 基线差异

| 项目 | HEAD `d84b692` | 本轮 |
| --- | --- | --- |
| required 68 scripts | 0 failed（历史记录，本轮复跑 0 failed） | 0 failed |
| `aegis-ram-overflow-boundary` 第 3 用例 | fail（已在干净 HEAD worktree 复现） | fail（未改该用例；不在 required 清单） |
| tsc 三配置 | 116 / 193 / 190 诊断 | 116 / 193 / 190（无新增） |
| Biome 改动文件 | — | 0 error，1 既有 warning |

要求的变红证据：新用例在旧实现下会因以下原因失败——
`projectWorkCycle` 原型在 Intent 时重置计数、review 记录无 `retrieval.selection_event_id`、未复用 Board Fact gate、
`aegis_work_review` 用 selection 事件冒充 review、门控允许任意 `aegis_propose`；新增脚本断言这些契约。
本轮没有保留旧实现的可执行 red 日志（旧原型已被重构），因此该条只作为设计依据报告，不声称已留证。

---

# 第二阶段测试矩阵（P2-01..P2-16）

后续独立审查仍为 **changes_required**：合法替换消费 Intent 会移动轮次窗口（P2-R1），保持零 Session 预算重启仍产生交接完成（P2-R2）。以下原 pass 只保留其实际用例范围，不覆盖这两个组合。补测与限定复验要求见 [测试交接任务](WORK_CYCLE_PHASE2_TEST_HANDOFF.md)，交给 DS 的提示词见 [补测提示词](WORK_CYCLE_PHASE2_TEST_DS_PROMPT.md)。

新增脚本（本阶段 required 显式清单；不修改 E1 68 清单的历史记录）：

| 脚本 | 层级 | 覆盖 |
| --- | --- | --- |
| `Pi_Agent_base/tests/aegis-work-cycle-phase2.mjs` | pure reducer | P2-01/02/03/04/06/13/14/16 |
| `Pi_Agent_base/tests/aegis-work-cycle-checkpoint-campaign.mjs` | C6 product + ledger | P2-05 / F2 |
| `Pi_Agent_base/tests/aegis-work-cycle-host-rotation.mjs` | C6 + real SDK + faux | P2-07/09/10/12/13/15 |
| `Pi_Agent_base/tests/aegis-work-cycle-recovery.mjs` | recovery integration | P2-11 |
| `Pi_Agent_base/tests/aegis-work-cycle-policy.mjs` | config + replay | P2-14 |
| 第一阶段 3 脚本 | pure/RAM/SDK | 回归保留 |

## 2.1 用例

| case | req | 断言要点 | 脚本 | 结果 |
| --- | --- | --- | --- | --- |
| P2-01a | F1 | review R 消费一次后，再引用 R 不改变 `action_count`/轮次/consumption | phase2 | pass |
| P2-01b | F1 | 换 scope 后新 stall 形成新 trigger，累计保留 | phase2 | pass |
| P2-02a | P2-02 | 旧+当前 review 混合 refs 只消费当前一条 | phase2 | pass |
| P2-02b | P2-02 | 旧 review 单独、same-scope Intent、foreign evidence、错 trigger selection 均不能清门 | phase2 | pass |
| P2-03a | P2-03 | Session 轮换事件不改计数/consume；replay 一致 | phase2 | pass |
| P2-03b | P2-03 | Board 可信 Fact 同时重置累计/轮次 | phase2 | pass |
| P2-04a | F3 | Intent A→cpA complete→Intent B：B 无当前 checkpoint，不建议交接 | phase2 | pass |
| P2-04b | F3 | 同 scope 新 Intent 不继承旧 checkpoint；当前绑定正例有效 | phase2 | pass |
| P2-04c | F3 | 被 replace 的 Intent 的 checkpoint 不是当前 | phase2 | pass |
| P2-05a | F2 | 两次真实 checkpoint 调用均有 `c6.tool charged` + `finished` | checkpoint-campaign | pass |
| P2-05b | F2 | checkpoint 绑定当前 Intent event | checkpoint-campaign | pass |
| P2-05c | F2 | `tool_calls=0`：无 checkpoint 事件、无未 backing charge、不伪完成 | checkpoint-campaign | pass |
| P2-06a | P2-06 | `unavailable` 保持 hold，`failed_review_event_ids` 可见 | phase2 | pass |
| P2-06b | P2-06 | 同 trigger 的后续 `ready` review 可重试并进入 awaiting | phase2 | pass |
| P2-06c | P2-06 | 真实工具路径覆盖 `ready`/`disabled`；`no_match`/`unavailable` 由 reducer/selectKnowledge 覆盖 | sdk/phase2 | pass（产品路径局部） |
| P2-07a | P2-07 | 轮换后新 Session 首请求仍为同一 hold/trigger；effect 被拒、read/review 可用 | host-rotation（第一轮 hold 在轮换前复核；纯 reducer 覆盖 carry） | pass（机制） |
| P2-08a | P2-08 | 预算 0 拒绝轮换；boundary 保留；无 handoff.completed | recovery | pass |
| P2-09a | P2-09 | 显式启用后 complete 边界自动轮换；同一 identity 只一次 | host-rotation | pass |
| P2-09b | P2-09 | 请求阈值与 work-cycle 理由合并为一次轮换 | 代码路径 + policy 测试；本阶段未单独构造阈值+complete 同刻用例 | not_run（组合） |
| P2-10a | P2-10 | 同 Task/Episode：2 个不同 trigger、2 次真实 review、2 次真实自动 Session 替换 | host-rotation | pass |
| P2-10b | P2-10 | 3 个 Session 对象/file/id 可核对；同一 Episode；目标/权限/预算连续；无 transcript 重放 | host-rotation | pass |
| P2-11a | P2-11 | 预算 0 中断 → 恢复后一次 completion、无重复 charge key、无 plan replay、旧 review 不再消费 | recovery | pass |
| P2-12a | P2-12 | 一次 batch 4 个 action：第 3 个后形成 trigger，第 4 个被 Broker 最新 gate 拒绝（2 轮均如此） | host-rotation | pass |
| P2-12b | P2-12 | 阻断不产生 Oracle failure/Task unknown；未执行 remainder 被丢弃 | host-rotation | pass |
| P2-13a | P2-13 | selection→Intent→action 显式 refs 可解析；无独立 Outcome 时 `adopted` 而非 `used` | phase2 | pass |
| P2-13b | P2-13 | 有可信 Fact 引用 action completion 时为 `used`；无证据保持 selected | phase2 | pass |
| P2-13c | P2-13 | 真实 C6 RAM/handoff 中 review selection 进入 provider-bound RAM | sdk/host-rotation（RAM 有界） | pass |
| P2-14a | P2-14 | 未配置 `work_cycle` → disabled；非法阈值拒绝 | policy | pass |
| P2-14b | P2-14 | 首次运行冻结 policy；不同配置冲突且不写事件；env 不改已绑定策略 | policy | pass |
| P2-14c | P2-14 | unknown token usage 不伪造数值 | phase2 | pass |
| P2-15a | P2-15 | `waiting_external` 不继续；暂停/取消/终态不恢复探索（代码路径） | 代码路径 + c6 回归 | pass（路径检查） |
| P2-16a | P2-16 | RAM work frame 有界，pending/auth/budget 核心保留 | work-cycle-ram | pass |
| P2-16b | P2-16 | 篡改派生 handoff JSON 不能清 gate（新 Session 从 committed 重建） | sdk/c2 回归 + 设计 | pass（设计+回归） |

## 2.2 命令与退出码（本阶段最终工作树）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node Pi_Agent_base/tests/aegis-work-cycle.mjs` | 0 | pass |
| `node Pi_Agent_base/tests/aegis-work-cycle-ram.mjs` | 0 | pass |
| `node Pi_Agent_base/tests/aegis-work-cycle-phase2.mjs` | 0 | pass |
| `c6-suite-runner … aegis-work-cycle-sdk aegis-work-cycle-host-rotation aegis-work-cycle-checkpoint-campaign aegis-work-cycle-recovery aegis-work-cycle-policy` | 0 | 5 scripts, 0 failed |
| 上述 5 + c6-product-chain / lifecycle-convergence / sdk-lifecycle / knowledge-campaign / c2-session-rotation / observer-failclosed / observer-runtime-handoff / ram-reaudit-sdk / tui-render | 0 | 14 scripts, 0 failed |
| `run-required.sh`（E1 68 清单） | 0 | 68 scripts, 0 failed |
| Biome（本阶段改动文件） | 0 | 0 error；1 个 HEAD 既有 warning |
| `tsc` extensions / campaign / aegis | 1 / 1 / 1 | 116 / 193 / 190，与 HEAD 基线逐条一致（无新增） |
| `aegis-module-layout.mjs` | 0 | 320 files / 963 refs，无缺失 |

## 2.3 独立复核 red 与修复

独立审查（`runtime/dev/work-cycle-independent-audit/review.md`）记录 `changes_required`：
F1 old-review 重复清零、F2 checkpoint 绕过 ledger、F3 旧 complete 跟随新单元。修复前三个审查脚本均 exit 1。
本阶段把序列转成正式回归（phase2/checkpoint-campaign/host-rotation/recovery），修复后通过。
审查脚本本身保留历史断言，复跑状态：
- `stale-checkpoint.mjs` exit 0（F3 修复）；
- `checkpoint-campaign.mjs` exit 0；其 fixture 未先提出 Intent，因此 checkpoint 事件为 0，但 charge/finish 断言通过；正式 F2 回归包含 Intent + 2 次真实调用；
- `old-review-sdk.mjs` 仍 exit 1，因为其断言保留旧的单计数语义（期望 action_count=1）。修复后实际为累计 4、轮次 1、旧 review 不再消费，
  这是新契约要求的正确行为；正式 `aegis-work-cycle-phase2` 按新契约断言。不得把该旧断言改写为“未修复”。

---

# 第二阶段补测与限定复验（测试委派）

执行身份：测试代理；只改测试与文档，未改产品实现。基线与所有权：
- 分支 `feat/work-cycle-session-handoff`，HEAD `d84b692`；未暂存/提交/push。
- 嵌套 Pi `2ba451d99`，dirty=0。
- `Pi_Agent_base/UI/` 未读取/修改/暂存/删除。
- 无真实模型/网络/目标；仅真实 Pi SDK + C6 Host/Supervisor + faux + 临时文件系统。

## A. 草稿收敛

未跟踪草稿 `aegis-work-cycle-missing-evidence-sdk.mjs`（3 cases/2 pass/1 fail）已审查并拆分/收敛：
- `aegis-work-cycle-knowledge-recovery-sdk.mjs`：TEST-06A（unavailable 恢复）与 TEST-06B（no_match）。
- `aegis-work-cycle-context-carry-sdk.mjs`：TEST-07（context carry）。
- 保留原正确断言；新增“失败 hold 下真实 effect 被拒”、“恢复后双计数/消费/账本”、“replacement 首请求 RAM/hold/trigger”、“授权 workspace read 实际执行”。
- 修正草稿自身两处测试问题：跨 `rows()` 重新读取的对象不能用 `indexOf` 比较顺序（改用同一事件数组的 event id）；旧 transcript 不重播按“无旧 assistant 消息/无超大全文”判断，不因 RAM 有界摘要包含 marker 就判重播。
- 草稿文件已删除，避免形成第二套未维护 red。

## B. 用例与真实结果

| case | 需求 | 预期 | 实际 | command/exit/log | 关键证据 |
| --- | --- | --- | --- | --- | --- |
| TEST-06A | P2-06 | 缺目录→review `unavailable`+hold；effect 被拒；恢复 seed→同 trigger `ready`；新 Intent→effect 执行；双计数/一次消费/账本 | **pass**（06A 全部 check 绿） | `p2-test-audit-final4/aegis-work-cycle-knowledge-recovery-sdk.log`，脚本整体 exit 1 仅因 06B red | 2 reviews 同 trigger；selection status `unavailable(selected=0)`→`ready(selected=3)`；review 2 charged/2 finished；checkpoint 1/1；propose 后 round=0、最终 round=1、total+1 |
| TEST-06B | P2-06 | 可读空目录→review `no_match`、空 selected、不称命中 | **FAIL（red）** | 同上，exit 1 | `KNOWLEDGE_EVIDENCE no_match`: review status=`ready`, selected=[]; tool result `retrieval_status:"ready"`。后续 Intent 仍消费并完成，说明仅状态契约不符 |
| TEST-07 | P2-07 | hold 未 review；真实 usage 85–100%；Host 自动轮换；新 Session 同 trigger/计数/消费；effect 拒绝；workspace read/knowledge/review 可用；Intent 后完成 | **FAIL（red）**：除 workspace read 外全部 pass | `p2-test-audit-final4/aegis-work-cycle-context-carry-sdk.log`，exit 1 | usage `56977/64000=89.03%`；source/replacement session 不同；identity `context:<source>:56977:64000`；1 completion；RAM hold=review_required、trigger/计数/consumption 相同；`aegis_read` 被 `effect_capable_tool_blocked_until_review_and_scoped_intent` 拒绝；knowledge 选中、review 可用、effect 被拒、最终 Task completed |
| REG-R1 | P2-01/02/03 | R→B 消费→1 action→C 引用 R 且 replace B：累计 4、轮次 1、consumption 仍 B | **FAIL（red）** | `p2-test-audit-final4/aegis-work-cycle-replace-consumed-sdk.log`，exit 1 | `REPLACE_EVIDENCE`: beforeRound=1, afterRound=0, total=4, consumption.intent_event_id=C（expected=B）；prefix 断言通过 |
| REG-R2 negative | P2-08/11 | Run1 额度0拒绝；Run2 仍0：无 completion、Task 不完成、无新单元 effect | **FAIL（red）** | `p2-test-audit-final4/aegis-work-cycle-zero-budget-recovery.log`，exit 1 | `ZERO_BUDGET_NEGATIVE`: run1Applied=[false], run2Applied=[], completions=1, task=completed, effects 3→4；completion 由 initial bind 写入 |
| REG-R2 positive | P2-08/11 | 额度纠正后走真实 Supervisor/newSession，一次 completion/charge | **FAIL（red，同一缺陷）** | 同上 | `ZERO_BUDGET_POSITIVE`: applied=[], completions=1, task=completed, sessions=2（无 replacement）, completionTo=run2 initial session, session charge=null |
| TEST-09 | P2-09 | request threshold 与 complete 同边界：一次轮换，两理由可见 | **pass** | `p2-test-audit-final4/aegis-work-cycle-reason-merge.log`，exit 0 | threshold=6；committedRequests=8（边界时6）；1 rotation；staged `reason` 同时含 `work_unit_complete,auto_request_threshold`；identity `unit-complete:<intent>` |

## C. 回归与静态检查（本轮）

| 命令 | exit | 结果 |
| --- | --- | --- |
| `c6-suite-runner … knowledge-recovery context-carry replace-consumed zero-budget reason-merge` | 1 | 5 scripts，4 failed（均为保留 red）；日志 `runtime/dev/p2-test-audit-final4`、`final3` |
| `c6-suite-runner … work-cycle-sdk host-rotation checkpoint-campaign recovery policy c6-product-chain c2-session-rotation` | 0 | 7 scripts, 0 failed |
| `node Pi_Agent_base/tests/aegis-work-cycle.mjs` / `-ram` / `-phase2` | 0 / 0 / 0 | pass |
| Biome（5 个新测试文件） | 0 | 0 error（无 warning） |
| module-layout / `git diff --check` | 0 / 0 | 通过（新测试纳入 325/986 计数） |
| required 68 / 完整 14 / tsc 差异 | not_run | 本轮未改产品实现，不重复产品门；引用第二阶段 DS 证据，不声明本轮复跑 |

## D. 距离通过还差（有限清单）

1. **R1**：review 消费必须按历史 committed prefix 固定，不能依赖最终 effective Intent；被替换的消费 Intent 不能让轮次 1→0 或改绑定。
2. **R2**：staged handoff 不得在新进程 initial Session bind 时自动写 `handoff.completed`；必须经 Host/Supervisor 的预算/安全校验；额度仍 0 时必须继续拒绝且不执行下一单元 effect；纠正额度后必须观测真实 `newSession`/replacement 与一次 Session 消费。
3. **no_match**：可读空目录的 review 边界必须显式 `no_match` + 空 selected + 工具返回一致；当前 `ready` 是产品契约不符，不得改 expected。
4. **P2-07 workspace read**：review hold 下 `aegis_read` 被 Observer 的 effect gate 阻断；需实现者决定是将其列入 advisory/read 分类，或由 owner 明确改契约。该路径是任务书承诺的“授权 workspace read 实际可用”，不能用知识查询替代。
5. 修复后重跑上述 5 个补测脚本 + 受影响 SDK/C6/C2/ledger/RAM 回归；产品修复交付按原任务门跑 required/静态差异。

## E. 历史保留

第一/第二阶段 DS 自测与独立审查 `changes_required` 记录保持原样；本补测新增结果单独列出，不覆盖旧通过/失败。

---

# 第二阶段收尾修复与限定复验（实现 DS，2026-10-22 第三执行轮）

状态：**`internally_verified / awaiting_external_review`。** 本轮修复 R1/R2/K1/G1，重新独立运行聚焦/回归/产品门，不覆盖前两轮记录。真实模型解题率、普通入口自动 Host、缓存、UI 和性能评分仍未验证且 deferred。

## F.1 执行轮次分离

| 轮次 | 用途 | 结果 | 日志 |
| --- | --- | --- | --- |
| 第二阶段 DS 自测（历史） | 实现者自测 | 见旧章节 | 旧 `p2-final3` 等 |
| 补测委派初次 red（历史） | 测试代理独立复现 | 5 scripts / 4 failed / 1 pass | `p2-test-audit-final4`、`p2-audit-independent` |
| 本轮 initial red | 修复前再次复现 R1/R2/K1/G1 | 4 scripts / 4 failed | `p2-remediation-red-205004` |
| 本轮 final focused | 四项修复后同一五脚本 | **5 scripts / 0 failed，runner exit 0** | `p2-remediation-final5b-210118`（`final5-205642` 为前一聚焦轮，不混用） |

## F.2 逐项 red→green

| case | 本轮 red（真实原因） | 本轮 green 证据 | status |
| --- | --- | --- | --- |
| TEST-06A / P2-06 | 历史/red 轮 unavailable 恢复已通过；本轮修复未改该语义 | final5b `aegis-work-cycle-knowledge-recovery-sdk` exit 0。`KNOWLEDGE_EVIDENCE unavailable`: trigger `wrev_1b62aeaa0ec339e7`，review `3c4d817d-5d4c-4d26-8eda-f3b9db12735d` / selection `340076a6-5afc-416c-9bb1-0f45921ea7bf` = `unavailable(selected=0)`；同 trigger 恢复 review `372cbd88-6155-4cbb-b29b-ede313373aaa` / selection `ec44343f-9412-4d5c-8ecd-aefcc169a4f7` = `ready(selected=3)`；失败 hold 下 effect 被拒，新 Intent 后 effect 执行；review 2 charged/2 finished、checkpoint 1/1，round 0→1、total 保留 | pass |
| TEST-06B / P2-06 | 可读空目录实际 `selectKnowledge`/review 返回 `ready`+[]，违反 review 边界 | `KNOWLEDGE_EVIDENCE no_match`: trigger `wrev_80b8599b59952bde`，review `36ab77c6-0ab4-47a2-9cbe-112affb97fb3` / selection `2733985b-0ab4-4158-8e42-1d6e4b4c8b0f` = `no_match(selected=0)`；工具结果 `retrieval_status:"no_match"`；空选择未产生 Fact/Outcome，后续合法 Intent 可继续。一般 `selectKnowledge` API 未全局改写，`ready` 命中与 `unavailable`/`disabled` 语义保留 | pass |
| TEST-07 / P2-07 | 授权 C6 `aegis_read(path=door.json)` 在 hold 期间被 `effect_capable_tool_blocked_until_review_and_scoped_intent` 拒绝 | final5b `CONTEXT_EVIDENCE`: source `01a163b3-ae24-765a-ad0f-34d7b78fdd66` → replacement `01a163b3-afb2-765a-ad0f-34d952be0f11`；usage `56977/64000=89.0266%`；identity `context:<source>:56977:64000`；1 completion/1 applied rotation；对象/id/file 不同。`CONTEXT_READ_EVIDENCE`: action `tool:1792674082965:if4gxprhgtb`，request `24d0c984-8ad6-4368-91c3-b27cb1dd0b8d`，completion `76c1ac66-8fa1-46ed-bf62-6b3f79c6398c`，真实内容 `contents of door.json: {"locked":true}`，charge/finish `6c37d3bd-e91b-405a-87ef-f2eabc0e5add` / `06358752-293c-4ad0-a1d2-c8dda234c3b0`；`../outside.json` 被 path grant 拒绝；read 后 `review_required=true`、round 4→4、无新 consumption；effect 仍被拒 1 次；knowledge/review 可用，最终 Task completed | pass |
| REG-R1 / P2-01/02/03 | C 合法 `replace_event_id=B` 且再引用 R 后 round 1→0，consumption 从 B 移到 C，累计 4 不变 | final5b `REPLACE_EVIDENCE`: beforeRound=1、afterRound=1、total=4；review `b398ce01-9438-4dd7-9625-eccabba079f5` / selection `b7bca67e-2e84-486b-88ce-14ec3a821a92` / trigger `wrev_a5a3fb7daed01e64`，consumption 仍为原 consuming Intent `78fd4181-7ab5-48ce-a696-cdb851c98a4f`。产品路径另验证第二次 replace、同 prefix replay、新 stall 新 trigger、新 review 由新 Intent 消费；pure phase2 验证多次 replace/replay、新 stall 阈值、新 review 正例与 prefix 确定性 | pass |
| REG-R2 negative / P2-08/11 | Run2 额度仍 0 时 initial Session bind 写 staged request 的 `handoff.completed`，Task completed、effect 3→4 | `ZERO_BUDGET_NEGATIVE`: staged request `host-rotate-105-1792674088722`；Supervisor refusal `session budget is exhausted (limit=0, base_consumed=0, committed_rotations=0, remaining=0)`；run1/run2 applied 均 false；completions=0；effects 3→3；Task 不完成；fixture `locked:true` 未变；无下一单元 effect | pass |
| REG-R2 positive / P2-08/11 | 纠正额度后仍无 Supervisor applied rotation，completion 绑定 initial Session | `ZERO_BUDGET_RECOVERY_EVIDENCE`: request `host-rotate-105-1792674089655`，completion `7f478e0e-ece4-43b9-be51-99b8654fbe15`，attempt `d811eb8e-6821-4626-90b4-5c6ca7cb73d4`，from `01a163b3-cae0-778d-a6d2-9c6e2a68d24c` → to `01a163b3-cb06-778d-a6d2-9c71ae9e31ba`；initial/replacement Session file 不同（临时 fixture 路径见 `final5b` 日志）；`applied:true,new_object:true`；Session consumed 0→1（limit 4）；恰好 1 completion、1 新 effect、Task completed、账本 charge/finish 平衡。另注入缺少 completion 的 replacement：`applied:false`、无假 completion、staged 保留、attempt 清除，随后同一 recovery 成功 | pass |
| TEST-09 / P2-09 | 历史 not_run；既有脚本此前已 pass | final5b `reason-merge evidence`: threshold=6、committedRequests=8、boundaries `["review_turn","review_turn"]`、rotations=1；同一 completion 一次 Session 消费，staged reason 同时含 `work_unit_complete,auto_request_threshold`；无第二次 completion | pass |

## F.3 本轮命令、退出码与日志

从仓库根执行；各脚本真实退出码由 `c6-suite-runner` 记录在 `results.json`，未用管道尾部成功覆盖。

| 命令 | exit | 结果/日志 |
| --- | --- | --- |
| `node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs Pi_Agent_base/runtime/dev/p2-remediation-red-205004 aegis-work-cycle-replace-consumed-sdk aegis-work-cycle-zero-budget-recovery aegis-work-cycle-knowledge-recovery-sdk aegis-work-cycle-context-carry-sdk` | 1 | 4 scripts, 4 failed（保留 red） |
| `node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs Pi_Agent_base/runtime/dev/p2-remediation-final5b-210118 aegis-work-cycle-knowledge-recovery-sdk aegis-work-cycle-context-carry-sdk aegis-work-cycle-replace-consumed-sdk aegis-work-cycle-zero-budget-recovery aegis-work-cycle-reason-merge` | **0** | **5 scripts, 0 failed** |
| 17 个受影响回归（work-cycle pure/RAM/phase2/SDK/host/checkpoint/recovery/policy、c6 product/lifecycle、c2 三个、observer failclosed/runtime-handoff、knowledge-campaign、ram-reaudit-sdk） | 0 | 17 scripts, 0 failed；`p2-remediation-regression-205659` |
| `c6-suite-runner …` 完整 14（旧清单） | 0 | 14 scripts, 0 failed；`p2-remediation-full14-*` |
| `run-required.sh <ignored-dir> 6` | 0 | 68 scripts, 0 failed；`p2-remediation-required-205813` |
| Biome 对 31 个改动/新增 Aegis 代码与测试文件 | 0 | 0 error；1 个既有 `agentConfigDir` unused warning（非本轮新增） |
| `tsc -p tsconfig.aegis-extensions.json` / `-campaign` / `aegis`（在 `Pi_Agent_base/`） | 1 / 1 / 1 | 实测 `grep -c 'error TS'` = 66 / 193 / 190；本轮改动文件无新增诊断；`handoff-host.mjs` 仍有既有两条 JSDoc 返回类型诊断。历史报告 116 的 extensions 计数方式未复现，不能声称与旧数字逐条一致 |
| `node Pi_Agent_base/tests/aegis-module-layout.mjs` | 0 | 326 source/test files / 989 refs，无缺失 |

## F.4 修复文件与边界

本轮实现改动：`memory/work-cycle.mjs`（历史 accepted-Intent 消费前缀、`WORK_READ_ONLY_TOOLS` 纳入真实 `aegis_read`）、`extensions/aegis-observer.ts`（review 的 readable-empty→`no_match`；post-bind completion 需要 live Host attempt）、`session/handoff-grant.mjs`（新增短生命周期 Host attempt，request+episode+source Session 绑定）、`session/handoff-host.mjs`（attempt 开启/清除与 completion 身份校验）、`session/session-supervisor.mjs`（recover 返回完整 rotation 证据）、`campaign/c6-entry.mjs`（启动前 Host recovery；0→0 拒绝时不 dispatch 下一单元）。测试/文档：`aegis-work-cycle-phase2.mjs`、`-replace-consumed-sdk.mjs`、`-zero-budget-recovery.mjs`、`-context-carry-sdk.mjs`、`aegis-c2-supervisor-boundaries.mjs` 与本矩阵/报告。

未改：`Pi_Agent_base/UI/`、Pi 核心、依赖、生产默认策略、Outcome/Episode/授权/active Experience 独立证据门、EventLog/Board/RAM/Session manager/账本结构。无真实模型/网络/目标/凭据。

## F.5 剩余限制

- 真实模型求解率、普通 run-pi/run-experiment 自动 Host、新 UI、缓存/性能、全局 skill 评分仍 deferred；默认 3/8/4/85 仍是未校准候选。
- tsc 既有基线仍红（非本轮新增）；后续类型清理需单独任务，不能把 exit 1 写成全绿。
- 外部独立验收未发生；本状态仅 `internally_verified / awaiting_external_review`。

## F.6 最终工作树（本轮结束时）

- 分支 `feat/work-cycle-session-handoff`；HEAD `d84b69206157c20710e0c4c5f3d08c6e79c64eb4`。
- 嵌套 Pi HEAD `2ba451d997098515c36744c56e1f604c842895b0`，dirty=0。
- 未暂存、未提交、未 push；无 reset/clean/stash；`Pi_Agent_base/UI/` 未读取/修改/暂存/删除。
- 主仓库仍有上一阶段未提交实现与补测测试；本轮只在其上追加 R1/R2/K1/G1 修复、测试和文档，未覆盖旧文件。

---

# 第三阶段：Experiment Console Host（HC-01..HC-16）

状态：**`internally_verified / awaiting_external_review`。** 本轮证据来自实现 DS 在最终工作树上的自测；外部独立验收未发生。第一/第二阶段记录未被覆盖。

## G.1 新增脚本（显式清单，不从 wildcard 继承）

| 脚本 | 层级 | 覆盖 |
| --- | --- | --- |
| `Pi_Agent_base/tests/aegis-work-cycle-console-sdk.mjs` | 真实 SDK + faux，走 console 产品调用图 | HC-01/02/06/07/08/10/15（用户 prompt 非许可） |
| `Pi_Agent_base/tests/aegis-work-cycle-bootstrap-intent.mjs` | 纯投影 + 真实 SDK/faux | HC-02/04/09 |
| `Pi_Agent_base/tests/aegis-work-cycle-console-restart.mjs` | Host 生命周期 + 真实 EventLog/Supervisor/attempt grant | HC-12/13/15 |
| `Pi_Agent_base/tests/aegis-work-cycle-checkpoint-tail.mjs` | 投影缓存 | HC-14 |
| `Pi_Agent_base/tests/aegis-work-cycle-console-launcher.mjs` | `run-experiment.sh` 子进程 + 真实 SDK | HC-01/16 |

## G.2 用例

| case | req | 断言要点 | 脚本 | 结果 |
| --- | --- | --- | --- | --- |
| HC-01a | HC-01 | `run-experiment.sh <new-label>` 输出 Console banner，创建 EventLog | console-launcher | pass |
| HC-01b | HC-01 | 1 个 `episode.started`、1 个真实 SDK `session.started`（非 label），无 Pi CLI banner | console-launcher | pass |
| HC-01c | HC-01 | 已存在 label 无 `--resume` 被拒；`--resume` 同 EventLog、同 Episode、新 Session | console-launcher | pass |
| HC-01d | HC-01 | 同进程第二 console 被租约拒绝；释放后可重新 attach | console-restart | pass |
| HC-02a | HC-02 | 首个 provider 请求同 batch 的 read 成功、write 被 `scoped_intent_required_before_effect` 拒 | console-sdk | pass |
| HC-02b | HC-02 | 无 scope 的 `kind=intent` 在 admission 被拒 | console-sdk | pass |
| HC-02c | HC-02 | `action.requested(write)` 索引晚于 accepted scoped Intent | console-sdk | pass |
| HC-03a | HC-03 | Intent 后 effect 真实落盘（fixture 值变更） | console-sdk | pass |
| HC-03b | HC-03 | target grant/契约负例：既有 C3/observer 用例（required 内 0 failed） | 引用 | pass（引用） |
| HC-04a | HC-04 | legacy 行为（gate off）先 effect 后 stall 复现 | bootstrap-intent | pass |
| HC-04b | HC-04 | review 形状 `bootstrap:true` + `work_unit_event_id:null` | bootstrap-intent | pass |
| HC-04c | HC-04 | 首个 scoped Intent 引用 review → 单次消费 → effect 执行 | bootstrap-intent | pass |
| HC-04d | HC-04 | 空 scope/无关 ref/已有 unit 的伪造 bootstrap 均不解锁 | bootstrap-intent | pass |
| HC-05a | HC-05 | unavailable review 不消费、同 trigger 可重试为 ready、成功后消费一次 | knowledge-recovery-sdk（复跑） | pass |
| HC-05b | HC-05 | 重复 review 复用 `reused:true`，单条 selection | work-cycle-sdk（复跑） | pass |
| HC-06a | HC-06 | review-hold 触发 1 次 replacement；对象/id/file 不同；同 Episode | console-sdk | pass |
| HC-06b | HC-06 | completion 绑定真实 from/to/attempt/boundary；staged 只在完成后退休 | console-sdk / console-restart | pass |
| HC-07a | HC-07 | replacement 首请求 RAM 携带同 status/trigger/双计数 | console-sdk | pass |
| HC-07b | HC-07 | 首请求无旧 assistant transcript/旧 marker | console-sdk | pass |
| HC-08a | HC-08 | hold 下 read 成功、write 被拒、review 可用 | console-sdk | pass |
| HC-08b | HC-08 | 只有合法 Intent 后 hold 清除，consumptions 恰 1 | console-sdk | pass |
| HC-09a | HC-09 | 消费后新 stall 形成新 trigger，旧 review 不复用 | bootstrap-intent / phase2 | pass |
| HC-09b | HC-09 | R1：替换消费 Intent 不移窗、不二次消费 | replace-consumed-sdk / phase2（复跑） | pass |
| HC-10a | HC-10 | `max_auto_rotations=1`：1 次 replacement 后 `blocked`，无 spin/effect/伪 Outcome | console-sdk | pass |
| HC-10b | HC-10 | blocked 状态给出可操作原因 | console-sdk | pass |
| HC-11a | HC-11 | unit-complete 与 review-hold 合并为单一 identity（一次轮换） | 代码路径 + console-sdk/restart；`reason-merge` 复跑 | pass（组合） |
| HC-12a | HC-12 | 未配对 action → startup blocked、dispatch 拒绝、无 completion | console-restart | pass |
| HC-12b | HC-12 | 损坏 EventLog → blocked，不追加事件 | console-restart | pass |
| HC-12c | HC-12 | 租约冲突/丢失 → 拒绝第二写者 | console-restart | pass |
| HC-13a | HC-13 | 零 session 预算 → 拒绝恢复，initial bind 不写 completion | console-restart | pass |
| HC-13b | HC-13 | 更正预算 → Supervisor 真实恢复一次（1 completion/1 creation/attempt 清理/staged 退休） | console-restart | pass |
| HC-13c | HC-13 | 注入 create 失败 → 无假 completion、staged 保留、attempt 清除 | console-restart | pass |
| HC-13d | HC-13 | 重复 recovery 幂等（无二次 completion） | console-restart | pass |
| HC-14a | HC-14 | full replay == checkpoint（无 tail）== prefix+tail，digest 一致 | checkpoint-tail | pass |
| HC-14b | HC-14 | stale/foreign/tampered/version-unknown/missing/corrupt → full replay 且结论不变 | checkpoint-tail | pass |
| HC-14c | HC-14 | 删除缓存重建同一判断 | checkpoint-tail | pass |
| HC-15a | HC-15 | pause 拒绝 dispatch；resume 恢复 running | console-restart | pass |
| HC-15b | HC-15 | Closed/terminal Episode 不自动恢复、不轮换 | console-restart | pass |
| HC-15c | HC-15 | 用户 prompt 不解除 effect gate（hold 仍在） | console-sdk | pass |
| HC-16a | HC-16 | 全部用例 faux/temp；无真实 provider/网络/目标/凭据 | 全部 | pass |

## G.3 命令与真实退出码（最终工作树）

| 命令 | exit | 结果 |
| --- | --- | --- |
| `c6-suite-runner …/p3-console-1022-225550 aegis-work-cycle-console-sdk aegis-work-cycle-bootstrap-intent aegis-work-cycle-console-restart aegis-work-cycle-checkpoint-tail aegis-work-cycle-console-launcher` | 0 | 5 scripts, 0 failed |
| `c6-suite-runner …/p3-remediation-1022-224827 aegis-work-cycle-knowledge-recovery-sdk aegis-work-cycle-context-carry-sdk aegis-work-cycle-replace-consumed-sdk aegis-work-cycle-zero-budget-recovery aegis-work-cycle-reason-merge` | 0 | 5 scripts, 0 failed |
| `c6-suite-runner …/p3-regression-1022-224844 <19 个受影响脚本：work-cycle pure/RAM/phase2/SDK/host/checkpoint/recovery/policy, c6 product/lifecycle/sdk, c2 three, observer failclosed/runtime-handoff/verify-first, knowledge-campaign, ram-reaudit-sdk>` | 0 | 19 scripts, 0 failed |
| `run-required.sh …/p3-required-1022-225603 6` | 0 | 68 scripts, 0 failed |
| Biome（41 个改动 .mjs/.ts，`aegis-biome.json`） | 0 | 0 error；1 条 HEAD 既有 warning |
| `tsc -p tsconfig.aegis-extensions.json` / `-campaign` / `aegis` | 1 / 1 / 1 | 66 / 193 / 190 diagnostics，与第二阶段实测基线一致，新增文件无诊断 |
| `node Pi_Agent_base/tests/aegis-module-layout.mjs` | 0 | 335 files / 1026 refs |

## G.4 本轮发现并修复的回归

| 发现 | 原因 | 修复 |
| --- | --- | --- |
| `aegis-observer-verify-first-pi` 在 required 中红：RAM 未再携带 verified ELF observation | 新增的 `unscoped` 工作帧进入 RAM 核心，在极小预算下挤掉了 facts | 仅在 trusted Host 启用启动门（`AEGIS_WORK_START_GATE=on`）时才输出 `unscoped` 工作帧；独立交互入口保持历史 RAM 形状 |

## G.5 修复：启动所有权顺序（TEST-OWN-01..04）

独立复核发现并复现：entry 先创建并绑定 SDK Session（Observer `session_start` 写 `session.started`），再由 `host.start()` 申请 ownership。第二个同 label 的 Console 即使被 lease 拒绝，也已经写入原运行的 EventLog。

修复后责任顺序（`session/experiment-console-entry.mjs` + `session/experiment-console.mjs`）：

```text
解析/校验参数 → acquireCampaignOwnership → EventLog.open + verifyChain →
bindHostEventLog → （此时才）sessionFactory() 创建 SDK runtime 并绑定初始
Session/Observer → pending/unknown + 冻结 policy + staged handoff 检查 →
Supervisor 恢复 → 允许派发
```

`sessionFactory` 是唯一的生产入口；`session`（预绑定 adapter）仅作为已存在会话的测试 seam，明确记录它无法阻止 `start()` 之前已经发生的 Session 事件。启动失败按实际资源清理（dispose 自己的 Session → unbind → close log → 恢复 env → release lease），拒绝实例不触碰他人资源，entry 以非零码退出（ownership 冲突 4、其他启动拒绝 3）。

| case | req | 断言要点 | 脚本 | red（修复前） | green（修复后） |
| --- | --- | --- | --- | --- | --- |
| OWN-01a | TEST-OWN-01 | 两个真实 child process（`run-experiment.sh`），A 以显式 ready 行 + quiescent 前缀为屏障 | console-ownership | B 额外写入 1 条 `session.started`（新 session id）；B 不退出（timeout） | B exit=4；EventLog 字节/大小/行数/末尾 digest/`session.started` 数/Session 文件清单完全不变 |
| OWN-01b | TEST-OWN-01 | B 不产生 `session.started`/`session.shutdown`/`handoff.completed`，无 ready 行 | console-ownership | 违约（新增 session.started） | pass |
| OWN-01c | TEST-OWN-01 | B 被拒后 A 仍可写入（新 committed 事件，链有效、同 Episode） | console-ownership | 未验证 | pass |
| OWN-01d | TEST-OWN-01 | A 正常停止后合法恢复进程 exit 0，仍为同一 Episode | console-ownership | 未验证 | pass |
| OWN-02a | TEST-OWN-02 | owner 唯一：factory 调用 1 次、真实 SDK Session、1 条 `session.started`（正例） | console-ownership | 接口不存在：`createExperimentConsole requires a session adapter…` | pass |
| OWN-02b | TEST-OWN-02 | 第二个 console 被拒，factory 调用 0、Session 创建 0、EventLog 不变 | console-ownership | 接口不存在 | pass |
| OWN-02c | TEST-OWN-02 | 被拒实例 shutdown 不影响第一个实例的工作、lease、Session | console-ownership | 接口不存在 | pass |
| OWN-03a | TEST-OWN-03 | SDK 创建失败：start 失败、无事件、原因可见、lease 释放、可重新启动 | console-ownership | 接口不存在 | pass |
| OWN-03b | TEST-OWN-03 | Session/Observer 已合法绑定后失败：保留真实 `session.started`/shutdown 历史，无 completion/effect/Outcome，链有效 | console-ownership | 接口不存在 | pass |
| OWN-03c | TEST-OWN-03 | 重复 shutdown 幂等（`already_stopped`） | console-ownership | 接口不存在 | pass |
| OWN-04 | TEST-OWN-04 | `--resume`、pending 拒绝、零预算 handoff 拒绝与纠正后 Supervisor 恢复 | console-restart（复跑） | — | pass |
| OWN-04b | TEST-OWN-04 | Phase 2 R1/R2/K1/G1 五补测与 Phase 3 五脚本继续通过 | 见 G.6 | — | pass |

真实 red 证据（修复前树，`runtime/dev/p3-own-red-234828/`）：

| 命令 | exit | 观察 |
| --- | --- | --- |
| `node --import <resolver> tests/aegis-work-cycle-console-ownership.mjs` | 1 | `createExperimentConsole requires a session adapter…`（factory 契约不存在） |
| 两进程复现 `/tmp/own01-red.mjs`（同 G.5 场景，日志 `p3-own-red-234828/own01-red.log`） | — | A 前缀 1 行 / 1 个 `session.started`；B 启动后 rows 1→2、`session.started` 1→2，新增 session id `01a1644c-c488-…`；B 未退出（timeout） |

## G.6 本轮命令与退出码（最终树）

| 命令 | exit | 结果 | 日志 |
| --- | --- | --- | --- |
| `c6-suite-runner …/p3-own-final-1023-002056 aegis-work-cycle-console-ownership aegis-work-cycle-console-sdk aegis-work-cycle-bootstrap-intent aegis-work-cycle-console-restart aegis-work-cycle-checkpoint-tail aegis-work-cycle-console-launcher` | 0 | 6 scripts, 0 failed | `runtime/dev/p3-own-final-1023-002056/` |
| `c6-suite-runner …/p3-own-remediation-1023-001509 aegis-work-cycle-knowledge-recovery-sdk aegis-work-cycle-context-carry-sdk aegis-work-cycle-replace-consumed-sdk aegis-work-cycle-zero-budget-recovery aegis-work-cycle-reason-merge` | 0 | 5 scripts, 0 failed | `runtime/dev/p3-own-remediation-1023-001509/` |
| `c6-suite-runner …/p3-own-regression-1023-001525 <21 个受影响脚本>`（work-cycle pure/RAM/phase2/SDK/host/checkpoint/recovery/policy、C6 product/lifecycle/sdk、C2 三项、Observer failclosed/runtime-handoff/verify-first、knowledge-campaign、ram-reaudit-sdk、c1-eventlog-durability、c1-ownership） | 0 | 21 scripts, 0 failed | `runtime/dev/p3-own-regression-1023-001525/` |
| `run-required.sh …/p3-own-required-1023-002414 6` | 0 | 68 scripts, 0 failed | `runtime/dev/p3-own-required-1023-002414/` |
| Biome（42 个改动 .mjs/.ts） | 0 | 0 error；1 条 HEAD 既有 warning（`agentConfigDir`） | — |
| `tsc -p tsconfig.aegis-extensions.json` / `-campaign` / `aegis` | 1 / 1 / 1 | 66 / 193 / 190，与基线一致，新增文件无诊断 | — |
| `aegis-module-layout.mjs` | 0 | 336 files / 1029 refs | — |
| `git diff --check` | 0 | 无空白错误 | — |

## G.7 范围说明

- 本轮只修启动 ownership 顺序及其直接初始化/清理回归；不改阈值、权限、预算协议、Outcome/Experience 门或工具授权。
- attempt 集合、`autoRotations` 与 `continuations` 均为进程内状态；`max_auto_rotations`/`max_continuations` 限制当前 Host 进程，重启重新读取配置并重新计数。committed completion 用于识别完成的边界，不构成跨重启累计预算保证。

## G.8 独立复核结果

ownership 缺陷已独立关闭，范围为启动顺序、冲突无写入、资源清理和现有恢复兼容。真实双进程 OWN-01 确认 B exit 4、A 前缀保持 11 行且字节/链尾/Session 文件清单不变、A 可继续写入、合法恢复 exit 0 且同一 Episode。

| 独立检查 | exit | 结果 |
| --- | --- | --- |
| ownership + Phase 3 五脚本 | 0 | 6/6；`runtime/dev/audit-p3-own-review-final/console/` |
| Phase 2 五补测 | 0 | 5/5；`runtime/dev/audit-p3-own-p2/` |
| 受影响回归 | 0（各实际脚本） | 20 项通过于 `audit-p3-own-review-final/regression/`，C1 ownership 单独通过于 `audit-p3-own-review-ownership-regression/`；首次 suite 因审查命令误写不存在的脚本名而 exit 1，未记为 suite 通过 |
| required | 0 | 68/68；`runtime/dev/audit-p3-own-review-final/required/` |
| Biome | 0 | 42 files / 0 error / 1 既有 warning |
| tsc extensions/campaign/aegis | 1/1/1 | 66/193/190 diagnostics，既有基线仍红 |
| module-layout / diff whitespace | 0/0 | 336 files / 1029 refs，无空白错误 |

首次前台 Console suite 调用因工具等待超时未取到退出码；后续后台 driver 保存最终退出码 0，不以超时推断通过。真实模型/网络/目标、真实解题收益、TUI 与跨进程预算协议均未纳入本次验收。

---

# 第四阶段：Aegis WebUI（WEB-01..WEB-08）

状态：**`internally_verified / awaiting_external_review`。** 实现、接线与浏览器操作由本轮完成；外部独立验收未发生。前三阶段记录保持不变。

契约与启动方式见 [WEBUI_CONSOLE.md](WEBUI_CONSOLE.md)。前端复用 Aegis-pocket（`Pi_Agent_base/UI/Aegis-pocket/web/aegis/`），运行事实仍来自 EventLog/现有 Host。

## W.1 基线与接口

| 项目 | 值（本轮开始） |
| --- | --- |
| 主仓库 | `feat/work-cycle-session-handoff` @ `481c2eb`，工作树仅 `?? Pi_Agent_base/UI/` |
| 嵌套 Pi | `main` @ `2ba451d9…`，dirty=0（未修改） |
| Aegis-pocket | `main` @ `d2a3280`（原 Pi Pocket 0.19.0），clean；`node_modules` 缺失 |
| UI 依赖 | `npm ci`（lockfile 原样，243 包）；`package-lock.json` 未改 |
| UI 基线 `npm run check` / `npm run lint` | 0 / 0（安装依赖后实测） |
| UI 基线 `npm test` | **379/384 pass，5 fail**：`test/launcher-ui.test.ts` 4 项 focus 超时（单独运行同样 4/4 fail）、`test/subagents.test.ts` 1 项在满负荷时超时（单独运行 11/11 pass）。与本轮文件（仅 `web/aegis/`、`AGENTS.md`、`docs/map.md`）无关 |
| Aegis 类型诊断 | 66 / 193 / 190（与上一轮一致，新文件无诊断） |

接口契约表（完整字段/错误码/幂等见 WEBUI_CONSOLE.md）：

| 接口 | 输入 | 输出/语义 |
| --- | --- | --- |
| `POST /api/experiments` | label（必填、新）、workspace（可选，须在允许根内）、provider/model（可选，服务端校验） | 201；复用 `run-experiment.sh --dry-run` 建布局，**不启动 Host/Session** |
| `POST …/attach` | — | 启动该 label 的**唯一** Host 子进程；`ready|conflict|unavailable` |
| `POST …/messages` | `{text, request_id}` | 202 受理；`duplicate`/`request_id_conflict`/`dispatch_paused`/`host_unavailable` |
| `POST …/pause|resume|stop` | — | 走 Host；pause 只停派发，stop 是 Host 关闭 |
| `GET …/view` | — | 五类面板 + transcript + files；`live` 标记是否由 Host 作答 |
| `GET …/stream` | `cursor` | SSE `events|status|delta|host`；cursor 失效 `reset:true` |
| `GET …/files|file` | `path` | 工作区 realpath 限制、512 KiB 上限、二进制标记 |
| `POST /api/requests/:id` | `{label}` | committed receipt（重启后仍可判定） |

## W.2 用例与结果

| case | 断言要点 | 脚本 | 结果 |
| --- | --- | --- | --- |
| WEB-01a | 新建（走 launcher）不写事件；attach 后 1 个 Host、1 个真实 Session | aegis-webui | pass |
| WEB-01b | 第二个 writer（普通 `run-experiment.sh --resume … -- --control stdio`）exit=4，EventLog 字节/行数/Session 数不变 | aegis-webui | pass |
| WEB-01c | 越权工作区 403 且不留目录；已存在 label 409；非法 label 400 | aegis-webui | pass |
| WEB-02a | 消息 → Host → SDK/Observer：episode/prompt/request.projected/assistant 文本/tool 结果（含 committed excerpt） | aegis-webui | pass |
| WEB-02b | 同 id 同文本：`duplicate`、零新行；同 id 异文本：409 | aegis-webui | pass |
| WEB-02c | 两个不同 id 并发均受理（Host 串行化），两条 receipt 均 `handled` | aegis-webui | pass |
| WEB-02d | 无 `pocket.sqlite`；`/api/pocket/*` 404（无第二 Pocket runtime） | aegis-webui | pass |
| WEB-03a | pause 后 dispatch 409 `dispatch_paused`；resume 后可继续 | aegis-webui | pass |
| WEB-03b | SSE 断开后 Host 仍 ready，随后消息仍受理（关浏览器不结束任务） | aegis-webui | pass |
| WEB-03c | 轮换视图：同一 Episode、transcript 跨轮换连续、两个 Session 登记、rotation 分隔条 | aegis-webui（真实 EventLog 只读视图） | pass |
| WEB-04a | 五类面板与同一 committed prefix 的本地投影逐项相等（progress/board counts/actions） | aegis-webui | pass |
| WEB-04b | provider-bound RAM 只给审计元数据（`text_available:false`）；重建 RAM 单独标注 | aegis-webui | pass |
| WEB-04c | 损坏日志：`integrity.ok=false` + 原因，已提交前缀仍显示 | aegis-webui | pass |
| WEB-05a | cursor 只返回其后行；失效 cursor 返回 `reset:true`；客户端按 event_id 去重 | aegis-webui | pass |
| WEB-05b | Host 停止→重新 attach：同 request_id 从 committed receipt 判定 duplicate，不重跑 prompt | aegis-webui | pass |
| WEB-06a | `..`/绝对路径/symlink 逃逸均拒绝；symlink 在列表中标为 `outside` 不跟随 | aegis-webui | pass |
| WEB-06b | 跨站 POST 403；错误 Host 头 403；GET 不能写；observation 写路由未挂载 | aegis-webui | pass |
| WEB-06c | 服务只记录一个 Host；只读 observation 服务保持原样（`aegis-c4a-observation-http` 0 failed） | aegis-webui + 回归 | pass |
| WEB-07a | 桌面 1280 CSS px：列表/新建/打开/发消息/五类面板/文件查看/暂停/刷新重连 | 真实 Firefox（BiDi） | pass |
| WEB-07b | 390×844：底部导航、列表抽屉、详情抽屉、无横向溢出、触控约 ≥40px | 真实 Firefox（BiDi） | pass |
| WEB-07c | 无未捕获错误（`window.__aegisErrors` 为空）；无失效按钮；轮换时间线/重连可见 | 真实 Firefox（BiDi） | pass |
| WEB-08 | Phase 3 六脚本、Phase 2 五补测、22 项受影响回归、required 68、module-layout、Biome、类型、UI check/lint/test | 见 W.3 | pass（UI 基线 5 项失败见上） |
| WEB-09a | 界面默认中文；`EN`/`中文` 与设置里的 Language 双向切换即时生效 | aegis-webui（词典/取值）+ 浏览器操作 | pass |
| WEB-09b | 中英词典键集合一致，UI 用到的每个键都存在（288 个静态+动态键） | aegis-webui | pass |
| WEB-09c | 选择记住在本浏览器（`localStorage`），刷新后保持；不进入 Host/EventLog | 浏览器操作（刷新后 `lang` 保持） | pass |
| WEB-09d | 窄屏（≤620px 断点）中文/英文均无横向溢出、导航与抽屉可用 | 浏览器（500 CSS px 窗口） | pass |

## W.3 命令与真实退出码（最终树）

| 命令 | exit | 结果 | 日志 |
| --- | --- | --- | --- |
| `node --import <resolver> Pi_Agent_base/tests/aegis-webui.mjs` | 0 | 66 checks passed | `runtime/dev/p3-webui-1023-091425/aegis-webui.log` |
| `c6-suite-runner …/p4-web-final-1023-105018 aegis-webui <Phase3 六脚本 + Phase2 五补测>`（最终树，UI 格式化后复跑） | 0 | 12 scripts, 0 failed | `runtime/dev/p4-web-final-1023-105018/` |
| `c6-suite-runner …/p3-web-regression2-1023-092335 <22 项受影响回归>` | 0 | 22 scripts, 0 failed | `runtime/dev/p3-web-regression2-1023-092335/` |
| `run-required.sh …/p4-web-required-1023-105724 6`（最终树） | 0 | 68 scripts, 0 failed | `runtime/dev/p4-web-required-1023-105724/` |
| Biome（Aegis 改动 .mjs/.ts） | 0 | 0 error；1 条既有 warning（`agentConfigDir`） | — |
| `tsc -p tsconfig.aegis-extensions.json` / `-campaign` / `aegis` | 1 / 1 / 1 | 66 / 193 / 190，新文件无诊断 | — |
| `node Pi_Agent_base/tests/aegis-module-layout.mjs` | 0 | 342 files / 1047 refs（`console-web` 已纳入生产目录检查） | — |
| UI `npm run check` | 0 | tsc + types-file + docs reference | `/tmp` 私有日志 |
| UI `npm run lint` | 0 | 0 error（`web/aegis` 已按仓库风格格式化） | — |
| UI `npm test`（`TMPDIR` 为真实路径） | 1 | 379 pass / 5 fail（4 项 launcher-ui focus 超时 + 1 项 subagents 满负荷超时；单独运行 subagents 11/11、launcher-ui 仍 4/4 fail = 基线） | — |
| `git diff --check`（两个仓库） | 0 | 无空白错误 | — |

## W.4 范围说明与已知限制

- 本轮只做本地单用户 Web 入口；无公网 tunnel/LAN/多用户/推送。
- Pocket 的多人侧聊、PiP、Agent Teams、定时任务、GitHub watches、扩展商店、fork/retry/worktree/内置浏览器等入口在本服务中**不存在**（不是仅隐藏）；未适配的旧 Pocket 服务端不参与运行。
- 前端复用 Pocket 的 `web/style.css`、字体、图标与 vendored `preact/htm/marked/dompurify`；`web/aegis/` 不导入 `web/store.js` 或 Pi Durable。
- 后端编辑后需要重启 Web 服务（Node 模块缓存）；前端随请求重新校验 ETag，无构建步骤。
- 跨重启的 rotation attempt 作用域保持第三阶段记录（进程内派生），不主张跨进程保证。
