# Aegis Campaign — Test Matrix (C0 Closure + C1)

## 当前测试状态（2026-10-19 实测）

本机实跑全部 150 个脚本（仓库根；2026-10-19 新增 `aegis-ctf-pilot-outcome`，5/5 通过）：

- required 68 个（`docs/E1_CONTRACT_CLOSURE_REQUIRED_CHECKS.json`）：**68 scripts, 0 failed**，命令见 `Pi_Agent_base/tests/helpers/run-required.sh`。
- 其余 82 个：**81 pass / 1 red**。唯一红是 `aegis-campaign-c1-boundary-review` 的 F16（accepted prefix checkpoint 仍全量重放）；该失败已由用户确认后置，不阻塞当前范围，且不在 required 清单。
- `tsc tsconfig.aegis.json` 186 条、`tsconfig.aegis-campaign.json` 189 条既有诊断（与记录基线一致，无新增）；`aegis-module-layout` 通过。
- 证据：`Pi_Agent_base/runtime/dev/audit-20261019/{required,final}/results.json`（ignored 私有目录，含逐脚本退出码与日志）。

本轮对账与修复（2026-10-19）：

| 项 | 结论 | 处理 |
| --- | --- | --- |
| `aegis-campaign-c1-integration-contracts`（ORDER-DEDUP/ORDER-TAIL） | E1 要求 `campaign.task.started` 携带 `episode_id`，旧夹具未带而整行被拒，负例变成空转 | 夹具补齐 `episode_id`（同时让 OUT 系列负例真正执行到拒绝路径） |
| `aegis-campaign-c1-final-audit2`（F8-PREFIX-FULL） | 测试手写的 checkpoint 形状早于 F12，缺 `episode_id` 等字段，尾部 Outcome 被判为未绑定 | 按当前 `scheduler persistCheckpoint` 形状补齐 checkpoint |
| `aegis-campaign-c1-external-boundaries`（F12 outcome dedup） | 真缺陷：checkpoint 只 seed 了去重 id 集合，没有 seed `outcomeRecords`，尾部重复 Outcome 会再入一次 | `campaign/projection.mjs` 在 `appliedOutcomes` 命中时按 first-wins 去重；21/21 通过 |
| `aegis-ram-reaudit`（RR-06） | 测试前提错误：1500 字符预算连一条 Fact 都放不下（实测单条需约 1591），不是“收缩丢失了本可放下的事实” | 前提改为 1700 并加“该条 Fact 确实存在”的断言；无需改产品代码 |
| `aegis-ram-reaudit-sdk`（RS-07） | 真缺陷：RAM 把已汇总的 input/details 再次截到 100/80 字符，结构化参数值只剩几个字符 | `memory/ram.mjs` 提高单行 input/details 显示预算（320/260，展开 480/420）；7/7 通过 |
| `aegis-tui-command`（runner） | 测试经 Observer 传递依赖 Pi 包，runner 只看文件内是否出现包名，误判为不需要 resolver | 测试声明 `// aegis-resolver: required`，runner 识别该声明 |

`aegis-campaign-c1-integration-contracts` 与 `final-audit2` 曾在 `abd7ced`（10-12）全绿；E1 实现（`4b87f09`…`592d9fb`）收紧 start/scope/checkpoint 规则后变红，`d9c9f52` 只记了一句“4 unchanged audit failures”。本轮把“规则收紧导致的旧夹具”和“真缺陷”分开处理，不再把两类混成同一个“旧红”。

以上数字只覆盖本机 2026-10-19 的离线运行；真实 provider/目标实验见总计划 §7，不在本矩阵内。下文 2026-10-18 基线内容保留为历史记录。

## 当前整体完善代码验证矩阵

历史基线 ce0bde0（2026-10-18）；下表为阶段级完成矩阵，各阶段仍未完成，不能按个别脚本通过改成 pass。子任务原始命令/退出码放 `runtime/dev/completion-implementation/<role>/`。主 Agent最终显式12脚本为4 pass/8 fail（exit 1），实际清单与命令见 `final-checks/results.json`；Biome exit 1，Campaign tsc 189→197。阶段状态 blocked / changes_required；详情见当前审查报告。下文历史 pass 不作为本轮通过。

| requirement | case / 独立预期 | level / evidence | 初始脚本或负责子任务 | status |
| --- | --- | --- | --- | --- |
| CORE-01 | SA-12 配置不能降级冻结协议；合法恢复正对照 | product/recovery；provider/tool counter/event | aegis-e1-single-authority-review；CORE | not_run |
| CORE-02/03 | SA-01–03 联合结清、非法 charge 拒绝、消费不清零 | Host/replay；真实 ledger/event | 同上；C6 lifecycle/ledger 回归 | not_run |
| CORE-04 | SA-04 重复工具一次入体；完整绑定可复用或 unknown hold | tool/product/recovery；counter/result | 同上；CORE 新工具组合 | not_run |
| CORE-05 | SA-07/08 intent await 后超时/失效阻断下一效果 | product；barrier/真实 BrokerWorker | 同上；CORE | not_run |
| CORE-06 | SA-06/10/11 冲突与失效不激活；正常 criteria 完成 | projection/product；queue/Board/learning | 同上与 authority/invariants/learning | not_run |
| CORE-07/08 | exact retry 无二次分配；status 冻结来源；shell 非零贯通 | CLI/replay；exit/event | CORE | not_run |
| MEM-01 | A/B/C/D 跨 turn/new Session checkpoint 无交叉污染 | pure/SDK；actual provider payload | context-policy/context-policy-sdk/round-checkpoint；MEMORY | not_run |
| KNOW-01 | 症状/技法/不相关负例/多语言去重，明确正例不退化 | pure/SDK；独立知识 fixture 与 provider payload | knowledge/knowledge-sdk；MEMORY | not_run |
| MEM-02 | 大产物中后部、binary、foreign/corrupt/symlink/offset 拒绝、重建 | file/product；真实 bytes/digest/owner | ARTIFACT 与后续 INTEGRATION | not_run |
| MEM-03 | 4k 完整预算、信任/身份/省略、提案替换后新窗口 | pure/SDK；RAM/payload | RAM/proposal/reaudit 回归；MEMORY | not_run |
| OBS-01 | E1 大图详情/分页/版本/刷新，XSS/坏链，零写入 | HTTP/UI；response/event/provider counter | OBSERVATION 新脚本与既有 observation | not_run |
| WEB-01 | WT-01–12 本地请求字节/会话/产物、SDK 反馈、幂等/未知恢复 | loopback/SDK/recovery；实收与效果计数 | 后续 WEB 子任务 | not_run |
| EXP 支撑 | 长短 Session 真替换、累计责任；经验策略走现有 Router | SDK/faux；session identity/ledger/Oracle | 后续 RUNNER 子任务 | not_run |
| 交付门 | 布局、变更文件Biome、两份tsc诊断差异、原required与受影响集成 | static/integration；逐脚本exit与diff | 主 Agent 独立运行 | not_run |

Status legend: `not_run` | `pass` | `fail` | `blocked`.
`old` = expected failure on pre-fix code (regression red evidence).
`evidence` = result | artifact | counter | process | provider_request | event_chain.

Scripts:
- `S0a` = `Pi_Agent_base/tests/aegis-campaign-contracts-c0.mjs`
- `S0b` = `Pi_Agent_base/tests/aegis-campaign-fixture-c0.mjs`
- `S0c` = `Pi_Agent_base/tests/aegis-campaign-closure-c0.mjs` (new)
- `S1a` = `Pi_Agent_base/tests/aegis-campaign-c1-event-projection.mjs` (new)
- `S1b` = `Pi_Agent_base/tests/aegis-campaign-c1-ownership.mjs` (new)
- `S1c` = `Pi_Agent_base/tests/aegis-campaign-c1-scheduler.mjs` (new)
- `S1d` = `Pi_Agent_base/tests/aegis-campaign-c1-recovery.mjs` (new, real subprocess)

`input_origin` ∈ {trusted_host, committed_event, model_proposal, synthetic_fixture, real_process}.

## A. C0 Closure

| case_id | req | subtask | level | input_origin | setup / action / expected | evidence | old | script | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CL-ILL-LLM | CLOSE-01 | C0-OUT | unit | synthetic_fixture | llm-sourced `supersedes`; effective must exclude the correction row and keep prior; `ignored_supersedes` records `llm` | result | FAIL | S0c | pass |
| CL-ILL-FOREIGN | CLOSE-01 | C0-OUT | unit | synthetic_fixture | foreign-episode correction `success`; must not enter effective set; stage stays based on prior | result | FAIL | S0c | pass |
| CL-ILL-MALFORMED | CLOSE-01 | C0-OUT | unit | synthetic_fixture | correction missing `provenance.independent`; excluded | result | FAIL | S0c | pass |
| CL-ILL-MISSING | CLOSE-01 | C0-OUT | unit | synthetic_fixture | `supersedes` target absent; excluded, prior survives | result | FAIL | S0c | pass |
| CL-ILL-CYCLE | CLOSE-01/02 | C0-OUT | unit | synthetic_fixture | 2-cycle; both excluded-consistent; no silent retirement | result | pass(part) | S0c | pass |
| CL-ILL-STAGE-AGG | CLOSE-01 | C0-OUT | unit | synthetic_fixture | foreign-episode `success` correction must NOT make stage success on its own | result | FAIL | S0c | pass |
| CL-SCOPE-MISSING | CLOSE-02 | C0-OUT | unit | synthetic_fixture | both `scope` undefined → `valid:false` (`scope_mismatch`) | result | FAIL | S0c | pass |
| CL-SCOPE-KEYORDER | CLOSE-02 | C0-OUT | unit | synthetic_fixture | equal scope, different key order → `valid:true` | result | FAIL | S0c | pass |
| CL-SCOPE-EPISODE-MISSING | CLOSE-02 | C0-OUT | unit | synthetic_fixture | both `episode_id` null → `valid:false` | result | pass | S0c | pass |
| CL-CRED-ENUM | CLOSE-03 | C0-REP | unit | synthetic_fixture | `credentials:"api_key=SECRET"` → report shows `[redacted]`, never the value | result | FAIL | S0c | pass |
| CL-CRED-NONE | CLOSE-03 | C0-REP | unit | synthetic_fixture | `credentials:"none"` visible verbatim | result | pass | S0c | pass |
| CL-CRED-MANIFEST | CLOSE-03 | C0-REP | unit | synthetic_fixture | `credentials:"manifest_policy"` visible verbatim | result | pass | S0c | pass |
| CL-CRED-BUNDLE | CLOSE-03 | C0-REP | unit | synthetic_fixture | bundle inherits same whitelist; malicious value `[redacted]` | result | FAIL | S0c | pass |
| CL-ORACLE-NOBIND | CLOSE-04 | C0-OUT | unit | synthetic_fixture | taskOracle with no task/criterion binding → not success | result | FAIL | S0c | pass |
| CL-ORACLE-FOREIGN | CLOSE-04 | C0-OUT | unit | synthetic_fixture | taskOracle `task_id` != current → not success | result | FAIL | S0c | pass |
| CL-ORACLE-SELFREPORT | CLOSE-04 | C0-OUT | unit | synthetic_fixture | `source:"llm"` taskOracle → not success | result | FAIL | S0c | pass |
| CL-ORACLE-EPISODE | CLOSE-04 | C0-OUT | unit | synthetic_fixture | taskOracle episode mismatch → not success | result | FAIL | S0c | pass |
| CL-ORACLE-OK | CLOSE-04 | C0-OUT | unit | synthetic_fixture | fully-bound trusted taskOracle + all stages → success (positive control) | result | pass | S0c | pass |
| CL-IND-ILLEGAL | CLOSE-05 | C0-OUT | unit | synthetic_fixture | illegal correction → `corrections:0`, `independent_count:1` | counter | FAIL | S0c | pass |
| CL-IND-LEGAL | CLOSE-05 | C0-OUT | unit | synthetic_fixture | legal correction → `corrections:1`, `independent_count:1` | counter | pass | S0c | pass |
| CL-ID-EMPTY | CLOSE-06 | C0-ID | unit | synthetic_fixture | `task-`, `stage-`, `ep-`, `sess-`, `campaign-` refused | result | FAIL | S0c | pass |
| CL-ID-PATH | CLOSE-06 | C0-ID | unit | synthetic_fixture | `task-a/b`, `task-..`, `task-./x`, `task-\u0000` refused | result | FAIL | S0c | pass |
| CL-STAGE-GLOBAL | CLOSE-06 | C0-ID | unit | synthetic_fixture | duplicate Stage ID across two Tasks → manifest refused | result | FAIL | S0c | pass |
| CL-VER-SHARED | CLOSE-07 | C0-MAN | unit | synthetic_fixture | `campaign-1.7`: manifest accepts ⇒ dynamic-policy must not reject for version | result | FAIL | S0c | pass |
| CL-VER-MAJOR | CLOSE-07 | C0-MAN | unit | synthetic_fixture | `campaign-2.0` refused at both entries | result | pass | S0c | pass |
| CL-PERSIST-FIELDS | CLOSE-07 | C0-MAN | unit | synthetic_fixture | first + existed + concurrent success all carry `digest/canonical_digest/path/existed` | artifact | FAIL | S0c | pass |
| CL-STAGE-ALLCRIT | CLOSE-08 | C0-STG | unit | synthetic_fixture | stage requires c1+c2; only c1 success → not stage success | result | pass | S0c | pass |
| CL-TASK-ALLSTAGES | CLOSE-08 | C0-STG | unit | synthetic_fixture | task requires 2 stages, only 1 passed-in → not task success | result | FAIL | S0c | pass |
| CL-UNKNOWN-FACT | CLOSE-09 | C0-OUT | unit | synthetic_fixture | legal `unknown` correction retires prior Fact, adds none, latest unknown retained | result | pass | S0c | pass |
| CL-USE-STRICT | CLOSE-10 | C0-OUT | unit | synthetic_fixture | `contributionLink` with a bare truthy string for a stage → not useful; only structured refs useful | result | pass(partial) | S0c | pass |
| CL-BUDGET-LEDGER | CLOSE-11 | C0-DYN | unit | synthetic_fixture | static allocation + dynamic reservation do not double-count; repeated `applyAdmission` idempotence documented | counter | pass | S0c | pass |
| CL-PARENT-STAGE | CLOSE-11 | C0-DYN | unit | model_proposal | parent_stage of another Task → rejected/blocked (not admitted) | result | FAIL | S0c | pass |
| CL-DEPTH-CHAIN | CLOSE-11 | C0-DYN | unit | model_proposal | self-reported depth inconsistent with parent chain → refused | result | FAIL | S0c | pass |
| CL-MALFORMED-NOTHROW | CLOSE-12 | C0-MAN | unit | synthetic_fixture | `validateManifest(null/[]/42)` returns `{ok:false}`, never throws; non-JSON manifest refused | result | pass | S0c | pass |

## B. C1

| case_id | req | subtask | level | input_origin | setup / action / expected | evidence | script | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EVT-01 | C1-A | event contract | unit | committed_event | `runtime.note`/1.1 + known `campaign.*` kinds validate; unknown kind refused | result | S1a | pass |
| EVT-02 | C1-A | command dedup | unit | committed_event | duplicate command_id applied once; `expected_revision` mismatch refused | event_chain | S1a | pass |
| PRJ-01 | C1-B | projection | unit | committed_event | dependency promotes to ready only after trusted dependency success | result | S1a | pass |
| PRJ-02 | C1-B | projection | unit | committed_event | replay idempotent; checkpoint+tail == full replay | result | S1a | pass |
| BUD-01 | C1-B | budget ledger | unit | committed_event | reserved→consumed transfer; cancel releases; no double-charge | counter | S1a | pass |
| SINGLE-ACTIVE | C1-B | single active task | unit | committed_event | at most one `running` task projected | result | S1a | pass |
| WRT-01 | C1-C | ownership | integration | real_process | two processes: one writer, second refuses | process | S1b | pass |
| WRT-02 | C1-C | ownership | integration | real_process | stale lease of a dead owner reclaimed; live owner not preempted | process | S1b | pass |
| CKP-01 | C1-C | checkpoint | unit | committed_event | corrupt/foreign/partial checkpoint ignored, rebuilt from events | artifact | S1b | pass |
| CKP-02 | C1-C | checkpoint | unit | committed_event | checkpoint binds manifest digest + last event digest + revision | artifact | S1b | pass |
| RUN-01 | C1-D | scheduler | unit | synthetic_fixture | pause/resume/cancel/budget-stop halt new dispatch | result | S1c | pass |
| DUR-01 | C1-D | scheduler | unit | synthetic_fixture | durable-before-dispatch: log failure ⇒ worker not called | result | S1c | pass |
| RUN-UNKNOWN | C1-D | scheduler | unit | synthetic_fixture | transport failure ⇒ unknown, never task failure | result | S1c | pass |
| REC-01 | C1-E | recovery | recovery | real_process | kill before intent ⇒ no side effect after restart | process | S1d | pass |
| REC-02 | C1-E | recovery | recovery | real_process | kill after intent before result ⇒ reconcile, no blind rerun | process | S1d | pass |
| REC-03 | C1-E | recovery | recovery | real_process | kill after result before checkpoint ⇒ replay, no duplicate effect | process | S1d | pass |
| END-01 | C1-E | end-to-end | integration | real_process | 2 tasks + 1 dynamic + delayed oracle + restart across boundaries | event_chain | S1d | pass |

## C. Explicitly NOT proven this round

- Real Pi Host-level Session rotation (C2), real Broker/Oracle adapters (C3),
  Web UI / Pi `/aegis` commands (C4a).
- Real CTF / penetration / remote target / network / credentials.
- Statistical learning efficacy from the deterministic fixture.
- Scheduler with real EventLog fsync concurrency across machines (single-host
  ownership only; file-lock based, fail-closed).

## D. Mutation plan (≥5 high-value guards)

| mutation | case | expected |
| --- | --- | --- |
| remove illegal-correction exclusion in `effectiveOutcomes` | CL-ILL-LLM/FOREIGN | FAIL |
| skip scope existence check (`scopeKey` null-match) | CL-SCOPE-MISSING | FAIL |
| let foreign/none-bound taskOracle through `aggregateTask` | CL-ORACLE-NOBIND/FOREIGN | FAIL |
| restore arbitrary credentials policy | CL-CRED-ENUM | FAIL |
| drop `bundle_digest` coverage of `report_digest` | S0a bundle-digest case | FAIL |
| promote dependent task to ready without dependency result | PRJ-01 | FAIL |
| skip durable-before-dispatch in scheduler | DUR-01 | FAIL |

Mutations run in an isolated copy (`runtime/dev/mutation/`); results in the
review report.
