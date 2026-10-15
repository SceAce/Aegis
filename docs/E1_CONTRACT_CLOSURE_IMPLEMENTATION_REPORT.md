# E1 契约闭合实施报告

版本：`E1-CC-1.0` 实施记录；日期：2026-10-15；任务书：`docs/E1_CONTRACT_CLOSURE_TASK.md`；
测试矩阵：`docs/E1_CONTRACT_CLOSURE_TEST_MATRIX.md`；required：`docs/E1_CONTRACT_CLOSURE_REQUIRED_CHECKS.json`。

**状态：`internally_verified`（DS 内部工程自审）→ 但本报告如实列出未闭合子例，整体判为 `changes_required`。**
见第 8 节。不允许自封 `externally_accepted`；同模型测试与自审不构成外部验收。

---

## 1. 起点、分支、提交与版本落点

| 项目 | 实际值 |
| --- | --- |
| 任务分支 | `fix/e1-contract-closure`（自 `audit/completion-20261015` 起点 `852cc5e` 创建） |
| 起点 HEAD | `852cc5ec679b7fe17d5b3eff8942f433e7e456b0`（上一轮纯文档提交） |
| 交付 HEAD | `0d315e01a887313d7e727606c21b25e6e8bac4ad` |
| 产品审计起点 | `3e42555245b6a9eeb2f267d4e3828e85ad4099df`（未 reset，未清理用户改动） |
| 内嵌 Pi | `42a3497d03ad17e308a2299fa824727894f2c0ec`（clean，未修改） |
| 本地 Node | `v26.10.0` |
| 用户既有改动 | `docs/E1_CONTRACT_CLOSURE_DS_PROMPT.md`（未 stage、未修改） |

本轮提交（自起点，均为可审查单元）：

```
4b87f09 fix: e1 trusted planning contract, one effective plan, and shared authority
bd281e9 test: add E1 contract-closure scripts (contract/admission/judgments/recovery)
a85ee46 feat: e1 Host plan-command result semantics and shared candidate dedup
5eb891b feat: e1 durable dual-sided tool charge (c6.tool / e1-tool-charge-1.0)
1ffdb5d fix: e1 immutable manifest persistence confirms fsync before durable
e711485 feat: e1 explicit allocation_total separate from outstanding reservation
a0e2d99 test: migrate E1 observation-repair C-IDENTITY-01 to shared-dedup contract
87909f3 chore: e1 closure lint/format cleanup (unused imports, formatter)
0d315e0 feat: e1 learning/observer consumers share authority; fail-closed without context
```

修改文件（21 个，均为 Aegis-owned）：

`memory/campaign/`: `artifact-index.mjs`(新)、`e1-planning-contract.mjs`(新)、`e1-plan-contract.mjs`、
`e1-planning.mjs`、`manifest.mjs`、`projection.mjs`、`scheduler.mjs`、`host.mjs`、`c6-entry.mjs`、
`c6-model-worker.mjs`、`c6-learning.mjs`、`c3-entry.mjs`；
`memory/runtime/`: `board.mjs`、`learning-bridge.mjs`；
`tests/`: `aegis-e1-closure-{contract,admission,judgments,recovery}.mjs`(新)、`aegis-e1-observation-repair.mjs`、`helpers/e1-closure-helpers.mjs`(新)、`helpers/c6-e1-planning-child.mjs`。

Pi core、真实 config/auth、依赖/lockfile、原独立审计 assertions 均未修改。

### 1.1 接口落点与公共适配映射

| 契约接口（任务书） | 实际实现 | 文件 |
| --- | --- | --- |
| Manifest 内嵌 `PlanningContract` | `buildPlanningContract` / `validatePlanningContract` | `e1-planning-contract.mjs` |
| `loadPlanningAuthority` | `loadPlanningAuthority`（含 `legacy_context_unavailable`） | `e1-planning-contract.mjs` |
| `normalizeExecutableTask` | 同名（static 缺维归0、dynamic 三维必填、双别名逐维相等） | `e1-planning-contract.mjs` |
| 可信模板规范化 | `normalizeTrustedTemplates`（去重排序、歧义拒绝） | `e1-planning-contract.mjs` |
| `compileCandidatePlan` | 既有 `validatePlanGraph`（增 `expectedRootGoalRef`、经 `normalizeExecutableTask` 归一） | `e1-plan-contract.mjs` |
| `recordPlanCandidate`/`admitPlan` | `scheduler.recordPlanCandidate` / `scheduler.admitPlan` → `PlanCommandResult` | `scheduler.mjs`/`host.mjs` |
| `chargeTool`（c6.tool） | `scheduler.chargeTool`/`finishTool` + projection `c6.tool` reducer | `scheduler.mjs`/`projection.mjs` |
| `planning_contract` 创建 | `buildPlanningManifest`（不再 Math.max 扩权）/`requirePlanningManifest` | `e1-planning.mjs` |
| durable 持久化 | `persistImmutableManifest` 增 fsync | `manifest.mjs` |
| 共同 authority | `projectQueueFromEvents().authority`（accepted_outcomes/definitions/rejections） | `projection.mjs` |
| 中立 artifact index | `artifactIndexFromEvents` 提取 | `artifact-index.mjs`（`c3-entry` re-export） |
| 消费者同源 | `projectBoard` E1 分支读共享 authority；无 context 降级 | `board.mjs` |
| 学习 consumer 上下文 | `buildCampaignLearningBridge({manifest})` / `buildProductionResolver({manifest})` | `c6-learning.mjs`/`learning-bridge.mjs` |

---

## 2. required 68 脚本实跑结果

运行入口（任务书 §11，读取新 JSON 的 `.groups`）：

```bash
node --input-type=module <<'NODE'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const manifest = JSON.parse(readFileSync('docs/E1_CONTRACT_CLOSURE_REQUIRED_CHECKS.json','utf8'));
const out = 'Pi_Agent_base/runtime/dev/e1-contract-closure/final-run';
mkdirSync(out, { recursive: true });
const summary=[]; let failed=0;
for (const [g,names] of Object.entries(manifest.groups)){
  const r=spawnSync(process.execPath,['Pi_Agent_base/tests/helpers/c6-suite-runner.mjs',`${out}/${g}`,...names],{stdio:'inherit'});
  summary.push({group:g,count:names.length,exit:r.status}); if(r.status!==0)failed++;
}
writeFileSync(`${out}/summary.json`,JSON.stringify({groups:summary,total_scripts:68,unique:new Set(Object.values(manifest.groups).flat()).size,groups_failed:failed},null,2));
process.exitCode=failed>0?1:0;
NODE
```

实际结果：**unique = 68，groups_failed = 0，runner exit = 0**。按组：

| 组 | 脚本数 | exit | 日志目录 |
| --- | --- | --- | --- |
| e1 | 7 | 0 | `final-run/e1/` |
| c6 | 18 | 0 | `final-run/c6/` |
| regress | 26 | 0 | `final-run/regress/` |
| affected | 8 | 0 | `final-run/affected/` |
| repair_focused | 3 | 0 | `final-run/repair_focused/` |
| independent_audits | 2 | 0 | `final-run/independent_audits/` |
| closure | 4 | 0 | `final-run/closure/` |

证据：`Pi_Agent_base/runtime/dev/e1-contract-closure/final-run/{summary.json,<group>/{results.json,<name>.log}}`
（ignored 私有目录；日志保存每个脚本真实 argv/exit）。

### 2.1 原缺陷 red → green

| 旧审计 | 起点实际 | 本轮实际 | 证据 |
| --- | --- | --- | --- |
| `aegis-completion-audit` | 3 pass / 9 fail | **12 pass / 0 fail** | `final-run/independent_audits/aegis-completion-audit.log` |
| `aegis-e1-history-audit` | 1 pass / 3 fail | **4 pass / 0 fail** | `final-run/independent_audits/aegis-e1-history-audit.log` |

- CA-02..05：被拒 scope/criterion/evidence/admission 不再成为 Board Fact（Board 读共享 authority）。
- CA-06..09：缺 planning 身份、normalized 与候选失配、内外 plan_id 不一致整批拒绝。
- CA-12：缺 planning 身份 ready 前缀新进程恢复 0 provider / 0 effect（真实新子进程）。
- HA-02：三维 Task 各额度1仍准入，每 Task 实际请求≤1、效果0。
- HA-03：一次有效计划；allocation 首批 68、重复仍 68、第二批不 128。
- HA-04：foreign root 保留候选、拒绝准入；planning 请求2、动态定义0、效果0。

正常对照未削弱：HA-01/CA-01 仍 provider=8、Broker effects=3、`dataset={name:"Ada",status:"active"}`。
HA-04 的 HA-01 同批正常链保持 8/3。

---

## 3. 四个 closure 脚本（矩阵子例覆盖）

| 脚本 | 用例数 | 覆盖矩阵 |
| --- | --- | --- |
| `aegis-e1-closure-contract` | 18 | T-C01(a–e)、C02、C04、C06、C07、C08、C09、C10、C11、C12、C13、C14、C16 |
| `aegis-e1-closure-admission` | 11 | T-A01、A06、A08/HA-04、A10/HA-03、A11/HA-02、A11b、A14、A15/A02、A17、A18 |
| `aegis-e1-closure-judgments` | 11 | T-J01、J01/J02/J03、J04/CA-05、J05、J07、J08、J15、J16 |
| `aegis-e1-closure-recovery` | 10 | T-R01、R02/CA-12、R05、R06、R07、R10、R13、R14、R15 |

expected 均为脚本内手写常量/关系（正例可用真实 product builder 造输入，但关键字段/预算/效果独立断言），
不调用被测 normalize/compiler/resolver 生成答案。正例为真实 SDK/faux + 真实 EventLog/Broker/文件/Oracle；
负例对真实流单点变更并重算 hash chain。

真实子进程证据：`aegis-e1-closure-recovery` 用 `spawnSync` 启动全新 child 进程恢复 ready 前缀，
T-R01 实测 6 新请求 / 3 新效果；T-R02 实测 0 / 0。**非仅同进程模拟**。SIGKILL 故障屏障（T-R08/T-R11）未做，见 §8。

---

## 4. 工具收费、账目分离、时间锚的实际证据

### 4.1 工具收费协议（`c6.tool` / `e1-tool-charge-1.0`）

`runtime.note` 内嵌 `payload.kind="c6.tool"`；`phase: charged|finished`；字段
`campaign_id/task_id/request_id/tool_call_id/unit_id/tool_name/arguments_digest/manifest_revision/manifest_digest/context_digest/units`。
去重键 `Campaign/Task/Episode/request_id/tool_call_id/unit_id`。实测（T-A14）：

- 双侧门：Task/Campaign tool_calls 任一不足即 refuse，且**不写 durable charge**（`events` 中 0 条 `c6.tool`）。
- 双侧通过：append/fsync 一条 `charged`，重放确认后返回 `{ok,charged,record_durable,event_id}`。
- 相同身份重复：`duplicate=true, charged=false, event_id` 引用原事件，**各侧仅 1**。
- 不同 request：新单位，再次 charge。
- `finished` 不退费；无 `charged` 的 `finished` 被 reducer 拒绝。

decision 单位模型（`c6-model-worker.mjs`）：N action → N 个 `action:<原索引>` 单位；无 action → 1 个 `call`；
共享 `propose_task` 载荷纳入每个单位 `arguments_digest`；至少 1 单位 charge 才入 buffer；
全部拒绝时 actions 与 proposal **都不入 buffer**；原索引不重编号。正常链实测 3 条 `c6.tool` charged（dyn-a/b/c 各一）。

### 4.2 账目分离

| 账目 | 来源 | 证据 |
| --- | --- | --- |
| `allocation_total[d]` | `reserved+consumed+released`，静态+历次动态分配；消费/释放/取消不删历史 | T-A10 实测 68→68（非128） |
| scheduler synthetic | Host `synthetic_cost`，标 `synthetic:true` | 既有 `buildBudgetLedger` |
| 实际 request/tool | C6 request reducer + `c6.tool` durable charge | T-A11 每 Task 实际≤1 |
| pending/unresolved | `summarizeRequestLedger` 逐侧 | 既有 C6 组 18/18 pass |

### 4.3 时间锚

**未实现**（见 §8）。当前 lead 仍用 `createToolLedger` 的进程内 `elapsedWall()`；
`c6.request.payload.wall_time_ms` 仍按时间戳语义保留，未作 duration 累加。deadline/回拨（T-A16）本轮未闭合。

---

## 5. 消费者调用点表（rg 实测）与拒绝不再提升

`projectBoard` 调用点（`rg "projectBoard(" memory/ extensions/`）：

| 入口 | 传 manifest？ | 本轮处理 | 测试 |
| --- | --- | --- | --- |
| `c6-entry.mjs:945` RAM provider | 是 | 共享 authority（E1） | `aegis-e1-closure-judgments` T-J01 |
| `e1-observation.mjs:79` buildE1View | 是 | 共享 authority | T-J15、`aegis-e1-observation-repair` |
| `c6-learning.mjs:47` learning bridge | 新增参数 | 传 manifest → 共享 authority | T-J13 关联（`aegis-learning-bridge-e` pass） |
| `learning-bridge.mjs:82` buildProductionResolver | 新增参数 | 传 manifest（可选） | `aegis-learning-bridge-e` pass |
| `c6-entry.mjs:1393` handoff | 否 | 无 context → Campaign 判定降级诊断 | `aegis-observer-runtime-handoff` pass |
| `session-supervisor.mjs:102` | 否 | 同上（无 context 降级） | `aegis-c2-supervisor-boundaries` pass |
| `handoff-host.mjs:51` | 否 | 同上 | `aegis-observer-*` pass |
| `evidence-resolver.mjs:111` | 否 | 同上 | `aegis-learning-bridge-e` pass |
| `extensions/aegis-observer.ts:327/341` | 否 | 无 context → Campaign 判定降级；只读 | `aegis-observer-*` 5 脚本 pass |

`projectQueueFromEvents` 调用点同批（projection/board/scheduler/e1-*/c6-*/report-export/c5-entry）。

**拒绝不再提升的实际输出**：`projectBoard(events,{manifest})` 对未进入 `authority.accepted_outcomes`
的 `campaign.oracle.result` 强制 `type:"Hint"` + `downgrade_reason`，并写入 `board.rejections`；
`currentByType.Fact` 不含它，`buildRam` 读 `currentByType` 故不入 RAM。实测于 T-J01/J02/J03。

**无 context 降级**：无 `manifest.campaign_id` 时 Campaign 判定强制 Hint（不 fallback 成 Fact）；
普通非 Campaign outcome 语义不变（T-J16）。

### 5.1 fixture 升级与旧独立断言保持

| 位置 | 原值/原断言 | 新值 | 原因 |
| --- | --- | --- | --- |
| `c6-e1-planning-child.mjs` base | `max_fan_out=2`（旧 builder 暗扩到6） | 显式测试授权 `max_fan_out=4`、`task_count/max_task_count=4` | 撤掉旧 builder 隐式扩容（任务书 §4.2） |
| 同上 `illegal_plan` | 同 base | 显式总数=5、fan-out=4，保留 forbidden.txt 越权为原负例 | 不让硬结构上限替代原 target 负例 |
| `aegis-e1-observation-repair.mjs` C-IDENTITY-01 | `submitted.length >= 2`（旧双写） | `submitted.length === 1`（共享去重，更强） | §6.1 工具/Host 共享 writer |

旧独立审计 `aegis-completion-audit.mjs` / `aegis-e1-history-audit.mjs` 的 assertions/expected **未改**，
由 12/12、4/4 pass 证明。

---

## 6. 静态检查与 mutation

### 6.1 类型诊断逐项比较

| 配置 | 起点 | 终点 | 新增/恶化 |
| --- | --- | --- | --- |
| `tsconfig.aegis-campaign.json`（Campaign 模块） | exit 1，194 行 | exit 1，194 行 | **0 新增、0 恶化**（`diff` 为空） |
| `tsconfig.aegis.json`（Batch-E） | exit 1，186 行 | exit 1，186 行 | **0 新增、0 恶化**（`diff` 为空） |

命令：

```bash
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json --pretty false
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis.json --pretty false
```

历史 194/186 的 exit 1 如实保留，**不记为 pass**。本轮曾一度把 Campaign 诊断推到 196/198，
逐项修复（`expectedRootGoalRef` JSDoc、`chargeUnit.tool_call_id` JSDoc、`normalizeTaskBudget` 未用参数、
`manifest` JSDoc）后回到 194，逐条 diff 为 0。

### 6.2 Biome 与 diff

```bash
./Pi_Agent_base/pi/node_modules/.bin/biome check --config-path=Pi_Agent_base/aegis-biome.json <逐个修改路径>
git diff --check
```

修改的 21 个文件 Biome 无 error（新增 helper 已纳入检查；无 `any`/`ignore` 掩盖）。
`git diff --check` exit 0。未关闭检查、未以 `// biome-ignore` 隐藏新增问题。

### 6.3 有限 mutation（行为断言捕获，非 import 异常）

在隔离副本逐项变异产品实现，确认对应断言因**行为**失败，随后 `git checkout` 还原（主工作树无残留）：

| 变异 | 应失败断言 | 实测 |
| --- | --- | --- |
| `applyPlanSubmitted` 跳过 planning 身份 | CA-06 | ✖ CA-06 FAIL |
| `normalizeTaskBudget` 回退 Campaign 总额 | HA-02 | ✖ HA-02 FAIL |
| 去掉 `plan_already_admitted` 守卫 | HA-03 | ✖ HA-03 FAIL |
| Board 关闭共享 authority 降级 | CA-02 | ✖ CA-02 FAIL |
| 去掉 `chargeTool` 去重 | T-A14 | ✖ T-A14 FAIL |

`git status` 变异后仅剩用户既有 `docs/E1_CONTRACT_CLOSURE_DS_PROMPT.md`；测试重跑全绿。

### 6.4 真实子进程边界

`aegis-c6-lifecycle-restart.mjs`（C6 组）为既有真实 SIGKILL+重启证据，本轮 pass。
`aegis-e1-closure-recovery` 用真实 `spawnSync` 子进程做前缀恢复（非 SIGKILL）；工具收费前/后 SIGKILL
屏障（T-R08）本轮未做。

---

## 7. 主 DS 全文自审

已逐个阅读 21 个修改/新增文件全文 diff 与新文件全文。四条链专项自审：

1. **rejection → Board → RAM**：拒绝 Outcome 在 projection 记入 `rejected` 且不进 `accepted_outcomes`；
   Board 强制 Hint；RAM 读 `currentByType` 不含 Hint 为 Fact。实测 T-J01/02/03。
2. **duplicate → allocation**：`applyPlanAdmitted` 同 id+digest 幂等、不同 id `plan_already_admitted`；
   `allocation_total` 不因重复/释放变化。实测 HA-03、T-A10（68→68）。
3. **ready → restart**：真实新进程按 committed 源重建；缺 planning 身份 0/0；合法 6/3。实测 T-R01/R02。
4. **correction → dependency**：合法 unknown 保留、不新增 Fact；同 id 冲突不覆盖；required Stage 聚合。
   实测 T-J05/J07/J08、CA-10。

自审发现并修复的问题：共享 writer 引入后旧 observation-repair 断言失效（迁移）；无 context 降级过宽
一度误伤 FC-O-01（改为仅 `!manifest.campaign_id` 时降级）；`allocation_total` 需保持释放不变量（实现为
`reserved+consumed+released`）。

---

## 8. 状态、未闭合项与阻塞（诚实交付）

整体状态：**`changes_required`**。理由（任务书 §4/§12）：存在未实现契约与未覆盖矩阵子例，
不能标 `internally_verified / awaiting_external_review`。

### 8.1 current_blocker / deferred（本轮未闭合）

| 项目 | 矩阵子例 | 现状 | 影响 | 责任阶段/重评 |
| --- | --- | --- | --- | --- |
| wall_time_ms 可信时间锚 | T-A16 | 仅进程内 `elapsedWall()`；无 `task.started` recorded_at 锚、无 `clock_regressed`、无 restart 不重置 | 跨进程重启后 Task/Campaign 时间门可被重置 | E1 后续切片；需持久时间锚 + 注入时钟 |
| 工具收费绑定实际 request/SDK 顺序 | T-A15 完整 | `requestBindingRef` 在 `reserved` 时记录；未强制 SDK `executionMode:"sequential"`，未 `await pendingCommit` | 并发 decision 可能争用计划名额 | 需真实 SDK tool-loop 接线 |
| `aegis_read` / `aegis_submit_plan` 收费 | T-A13 | 仅 `aegis_task_decision` 走 `c6.tool` | planning/read 工具未按单位收费 | 需工具级 charge 适配 |
| 工具收费 SIGKILL 屏障 | T-R08/R09 | 未做真实 barrier | 崩溃点计费未实测 | 需独立 barrier/IPC |
| `full_replay_required` 显式码 | T-R05/R06 | E1 经 recompile 不用 checkpoint 的 plan 权威，但未返回该精确 code | 调用者无法据 code 分支 | 需 projection/scheduler 出口 |
| 完整消费者 rg 核验 | T-J12/J13/J14 | 已列调用点并测关键 5 组，但未逐一构造 E1 Campaign 输入验证每个 consumer | 隐藏接线缺口风险 | E1 后续 |
| allocation 再分配 | §7.1 | 明确不做（本轮 E1 不循环再分配） | 无 | 后续能力阶段 |

### 8.2 已确认限制（非阻塞）

- 本机可信 Host 前提不变；不防恶意本机进程伪造完整可信源。
- SIGTERM 仍为 Task-boundary drain，不宣传即时取消。
- Observer/supervisor 无 manifest 路径按降级语义运行（安全但不显示 Fact）。
- 全仓类型债（194/186）不因本轮清零；未新增/恶化。
- 不声称学习收益或跨任务泛化；本轮只证工程一致性（T-J13）。

### 8.3 未运行/无产品正例的边界

- 未运行真实模型/付费目标、未安装依赖、未跑整个 Pi monorepo e2e。
- 本地 HTTP 观察：`aegis-e1-observation-repair` C-READONLY-01 与 `aegis-c4a-observation-http` 本轮 pass。

---

## 9. 与任务书的差异逐项说明

| 任务书要求 | 实现差异 | 原因 |
| --- | --- | --- |
| §4.1 `persistImmutableManifest` fsync | 已补 file+dir fsync | 按契约实现 |
| §4.2 base 不 Math.max | 已移除；`requirePlanningManifest` 拒绝不足 base | 按契约实现 |
| §5.1 `normalizeExecutableTask` | 已实现；`planning_contract` 用 `templates` 数组非 alias Map | 按契约 |
| §7.2 `chargeTool` | 已实现 scheduler+reducer+decision 单位模型；**未接 SDK sequential 与 read/submit 收费** | 见 §8.1 |
| §7.3 wall_time_ms | **未实现持久锚** | 见 §8.1 |
| §9 E1 完整重放 | recompile 不使用 checkpoint 的 plan 权威；**未返回 `full_replay_required` 精确码** | 见 §8.1 |
| §8.2 全消费者 | 关键 5 组已核验；**未逐 consumer 构造 E1 输入** | 见 §8.1 |

未静默改规则、未改旧 expected、未以全绿掩盖冲突。

---

## 10. 结论与后续

- required 68 唯一脚本**全部 exit 0**（本轮实测），原独立审计 12/12、4/4（起点 3/9、1/3）。
- 类型基线无新增/恶化，Biome/diff 干净，有限 mutation 被行为断言捕获，恢复含真实新进程。
- 但 §8.1 多项契约（时间锚、SDK 工具顺序、read/submit 收费、SIGKILL 屏障、`full_replay_required` 码、
  全消费者逐项核验）未闭合，故整体 **`changes_required`**，列明责任阶段与重评条件。

后续顺序（按任务书 §13）：闭合 §8.1 的 E1 切片 → 有限外部集成复验 → 用户执行有界真实 E1 pilot →
据真实失败/收益安排 E2/E3。本报告不声称全仓安全认证或零 bug。

---

## 附：证据索引

- required 68：`Pi_Agent_base/runtime/dev/e1-contract-closure/final-run/summary.json` 与各组 `results.json`/`<name>.log`。
- 独立审计：`final-run/independent_audits/aegis-completion-audit.log`、`aegis-e1-history-audit.log`。
- closure：`final-run/closure/aegis-e1-closure-{contract,admission,judgments,recovery}.log`。
- 类型基线：`runtime/dev/e1-contract-closure/tsc-campaign-{before,after}.txt`、`tsc-batch-e-{before,after}.txt`。
- 起点状态：`runtime/dev/e1-contract-closure/start-state.txt`。
- 本轮 closure 产物（含真实子进程 run 目录）：`runtime/dev/e1-contract-closure/{contract,admission,judgments,recovery}/run-*`。

所有 runtime 原始证据位于 ignored 私有目录，不含凭据、目标数据或无限原始 transcript。
