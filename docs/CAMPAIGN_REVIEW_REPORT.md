# Aegis Campaign — Master DS Review Report

## 当前整体完善代码工作（ce0bde0 起点）

状态：**主 Agent 已完成本轮代码接手与内部验证，尚待独立外部验收；真实 Web 目标和真实效果实验未运行。** 用户取消了 max/DeepSeek 依赖，本轮由主 Agent直接修复、集成和复验。

本轮完成的范围：

- CORE-01–08：冻结运行与只读恢复、请求账本共同结清、工具重复执行保护、逐步 Broker permit、当前有效 Outcome 聚合、exact admission retry 与 runner 状态。
- MEM-01/03：board-off 清除 round checkpoint、知识条件检索与负例、CTF 报告完整 attempt 统计。
- MEM-02：内容寻址 artifact store、owner/ref/digest、字节分页读取、UTF-8 边界、预算、symlink/corruption/persistence fail-closed。
- OBS-01：E1 board/graph 分页、节点/边详情、cursor filter、state revision、只读刷新客户端。
- WEB-01 W1：本地 HTTP/session/cookie adapter、同步工具 schema、独立平台结果绑定；尚未接入 Campaign/Host 的正式共享工具注册和真实平台。

验证结果：

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| E1/C6 required | 68 scripts，全部 exit 0 | `runtime/dev/completion-implementation/required-full.log` |
| Single-authority | 13/13 pass | `takeover-final-new/aegis-e1-single-authority-review.log` |
| 新增聚焦测试 | 产物 29/29；Web adapter/outcome/recovery/wiring pass；E1 explorer、board-off、knowledge、report pass | `takeover-final-new/`、`check-artifact-final/` |
| Biome | exit 0；保留既有 warning/info | `final-static/biome-fix.log` |
| Batch tsc | exit 1，186 条既有诊断 | `final-static/tsconfig.aegis.json-final.log` |
| Campaign tsc | exit 1，189 条既有诊断，无新增诊断 | `final-static/tsconfig.aegis-campaign.json-final.log` |
| 真实 provider/远程目标 | 未运行 | 本轮不启动真实效果实验 |

限制：

- Web adapter 尚未在 Campaign `c6-sdk-runtime`/Host 白名单中注册，未建立正式 Web family、共享 ledger/Oracle/平台导入入口；当前是 W1 独立工程层。
- artifact read 已接入 Observer 工具并使用现有 work account，但完整 artifact 原文保存的是脱敏工具文本，不是未脱敏远端原始响应；敏感原文不会被自动恢复。
- CTF 正式矩阵、短 Session 效果、active Experience 效果、迁移实验仍未运行。
- 未修改 Pi 核心、凭据、依赖或 lockfile；未调用真实目标网络。

Status: **internally_verified** for C0 Closure and C1; **awaiting_external_review**.
External acceptance is performed by the user bringing this bundle back to the
current conversation. Aegis did NOT invoke `gpt-6.1-sol`.

## 1. Scope delivered this round

| Phase | Status | Notes |
| --- | --- | --- |
| C0 closure (CLOSE-01..12, P0-1..P1-5) | done, internally_verified | product code fixed, regression red→green, mutations caught |
| C1-A event contract | done | reuses `runtime.note`/schema 1.1 + `campaign.*` kinds |
| C1-B projection + budget ledger | done | pure, deterministic, single active task |
| C1-C single writer + checkpoint | done | real multi-process contention tested |
| C1-D scheduler control loop | done | fake worker/oracle/clock, durable-before-dispatch |
| C1-E kill/restart recovery | done | real local subprocess SIGKILL at three boundaries |
| C2 real Pi Session rotation | NOT implemented | planned only |
| C3 real Broker/Oracle adapters | NOT implemented | planned only |
| C4 aggregation/report贯通 | partially: report/bundle exist (C0); event/report rebuild in tests | not wired to a real Campaign run |
| C4a Web UI / Pi `/aegis` commands | NOT implemented | planned only |

## 2. Orchestration honesty

No sub-agent tool exists in this harness (only read/bash/edit/write + browser).
Per `docs/DS_ORCHESTRATION_WORKFLOW.md` §1 the master DS executed the task graph
**serially**, switching test-author / implementer / reviewer roles explicitly.
No child-DS report was fabricated. "Same-model self-review" here is NOT external
acceptance.

## 3. Reproduced defects (old code) → fixes

Probed with `runtime/dev/probe_c0.mjs` and the new closure suite before fixing.

| id | defect | old behavior | fix |
| --- | --- | --- | --- |
| P0-1 | illegal supersede (llm/foreign/malformed/missing) stayed in effective view | `o2` visible, could pollute stage | illegal corrections excluded; audit retained |
| P0-2 | both-missing scope compared equal; key order changed verdict | `valid:true`; `scope_mismatch` on reorder | missing-scope fail-closed; canonical compare |
| P0-3 | report restored arbitrary `credentials` value | `api_key=SECRET` leaked | whitelist `none`/`manifest_policy`, else `[redacted]` |
| P1-1 | TaskOracle without task/criterion/episode binding → success | `success` | binding validated; foreign/llm/missing refused |
| P1-2 | illegal correction counted as correction + independent group | `corrections:1`, `count:2` | `corrections:0`, `count:1`, `invalid_corrections` tracked |
| P1-3 | empty suffix / `..` / path separators accepted | accepted | safe-suffix predicate; Stage id global uniqueness |
| P1-4 | Manifest accepted `campaign-1.7`, dynamic-policy rejected | inconsistent | shared `isSupportedCampaignVersion` |
| P1-5 | `canonical_digest` missing on existed/concurrent branches | `undefined` | single `success()` shape on all branches |
| CLOSE-08 | task omitted a required stage → success | `success` | required stages derived from task definition |
| CLOSE-09 | legal unknown correction deleted | unknown dropped | unknown retained, old Fact retired |
| CLOSE-10 | `contributionLink` accepted bare truthy strings | `useful:true` | structured-ref requirement |
| CLOSE-11 | parent_stage cross-task; claimed depth trusted | admitted | parent-stage ownership + chain-derived depth → rejected |

## 4. Commands, exit codes, evidence

Full log directory: `Pi_Agent_base/runtime/dev/verify/`.

| command | exit | notes |
| --- | --- | --- |
| `node Pi_Agent_base/tests/aegis-campaign-closure-c0.mjs` | 0 | 39 ok (was 28 FAIL on old code) |
| `node Pi_Agent_base/tests/aegis-campaign-contracts-c0.mjs` | 0 | 58 ok |
| `node Pi_Agent_base/tests/aegis-campaign-fixture-c0.mjs` | 0 | 22 ok |
| `node Pi_Agent_base/tests/aegis-campaign-c1-event-projection.mjs` | 0 | 22 ok |
| `node Pi_Agent_base/tests/aegis-campaign-c1-ownership.mjs` | 0 | 12 ok (incl. real subprocesses) |
| `node Pi_Agent_base/tests/aegis-campaign-c1-scheduler.mjs` | 0 | 7 ok |
| `node Pi_Agent_base/tests/aegis-campaign-c1-recovery.mjs` | 0 | 5 ok (real SIGKILL boundaries) |
| `biome check --config-path=Pi_Agent_base/aegis-biome.json <campaign + tests>` | 0 | clean |
| `tsc -p tsconfig.aegis-campaign.json` | 1 | **0 errors in campaign files**; 10 pre-existing errors in imported `memory/fixture/contracts.mjs` and `memory/runtime/events.mjs` (not campaign-owned) |

### 4.1 Regression (offline, Aegis-owned)

All exit 0: `aegis-workflow-evidence-d`, `aegis-workflow-engine-d`,
`aegis-runtime-core-smoke`, `aegis-runtime-effective-board`,
`memory-runtime-batch-b-smoke`, `memory-runtime-learning-evidence-smoke`,
`observer-smoke`, `aegis-learning-bridge-e`.

### 4.2 Regression (real Pi resolver + faux provider)

All exit 0: `aegis-observer-data-use-pi`, `aegis-observer-verify-first-pi`,
`aegis-observer-outcome-command`, `aegis-observer-failclosed-pi`.

## 5. Mutation results (isolated, restored after each)

| mutation | target case | expected | actual |
| --- | --- | --- | --- |
| remove illegal-correction exclusion | CL-ILL-LLM/FOREIGN | FAIL | FAIL (5) |
| scope null-match | CL-SCOPE-MISSING | FAIL | FAIL (1) |
| unbound taskOracle allowed | CL-ORACLE-* | FAIL | FAIL (6) |
| restore arbitrary credentials | CL-CRED-ENUM | FAIL | FAIL (1) |
| bundle_digest stops covering report_digest | S0a bundle case | FAIL | FAIL (1) |
| ID suffix unvalidated | CL-ID-* | FAIL | FAIL (3) |
| parent-stage ownership skipped | CL-PARENT-STAGE | FAIL | FAIL (1) |
| dependent promoted without result | PRJ-01 | FAIL | FAIL (2) |
| scheduler skips durable-before-dispatch | DUR-01 | FAIL | FAIL (1) |
| transport failure → failed | RUN-UNKNOWN | FAIL | FAIL (1) |

All mutations changed behaviour and were caught; nothing stayed green.

## 6. Rebuild evidence

- C0: `aegis-campaign-fixture-c0.mjs` deletes the derived report and rebuilds it
  from the persisted immutable Manifest + fixture Outcomes; `report_digest` and
  `bundle_digest` are identical.
- C1: `aegis-campaign-c1-recovery.mjs` deletes nothing but restarts from the
  committed `events.jsonl`; the projection is identical and side effects are
  exactly once. Checkpoint validation (foreign/ahead/corrupt/other-campaign) is
  exercised in `aegis-campaign-c1-ownership.mjs`.

## 7. Cross-module review findings (main DS)

Files read end-to-end: all 13 `memory/campaign/*.mjs`, all 7 new/updated tests,
both helpers, `tsconfig.aegis-campaign.json`.

| severity | finding | status |
| --- | --- | --- |
| P1 | projection did not seed static task allocations into the shared ledger (contract §3.4) | fixed + test |
| P2 | dead branch in `campaign.task.cancelled` | fixed |
| P2 | `campaign.budget.released` recorded requested, not clamped, amount | fixed |
| P2 | reclaim of a dead-owner lock was not compare-and-swap | hardened (write + confirm) + test |
| P2 | `writeFileAtomic` uses `join(path,"..")` instead of `dirname` | cosmetic, left (works) |

No open P0/P1.

## 8. Process note (tooling error, self-reported)

During JSDoc annotation for the campaign tsconfig, an automated script I wrote
deleted function-signature lines in 10 campaign files (the script assumed every
JSDoc `*/` was followed by a declaration). I detected it via tsc, **restored all
six files that had backups, and manually reconstructed the four without
backups** (`manifest.mjs`, `fixture.mjs`, `ownership.mjs`, and re-verified
`projection.mjs`/`scheduler.mjs`). I then re-ran every suite, all mutations, and
the regression set; all are green. No test was weakened to reach this state. This
is recorded because a hidden file corruption would invalidate the review.

## 9. What this work does NOT prove

- Real Pi Host-level Session rotation (C2), real Broker/Oracle adapters (C3),
  Web UI / Pi `/aegis` commands (C4a).
- Real CTF / penetration / remote target / network / credential access.
- Distributed (multi-host) ownership; ownership is single-host and fail-closed.
- Statistical learning efficacy from the deterministic fixture.
- That the tsconfig is error-free end-to-end (10 pre-existing import errors).
- That C0/C1 constitute a "complete long-running Campaign".

`Session count is not independent Episode count. Unknown is not failure.
Synthetic/faux evidence is labeled. Aegis did not automatically invoke
gpt-6.1-sol. No real target network or credential access was used. Final external
acceptance remains pending.`
## 当前整体完善代码工作（ce0bde0 起点）

状态：**主 Agent 已完成本轮代码接手与内部验证，尚待独立外部验收；真实 Web 目标和真实效果实验未运行。** 用户取消了 max/DeepSeek 依赖，本轮由主 Agent直接修复、集成和复验。

本轮完成的范围：

- CORE-01–08：冻结运行与只读恢复、请求账本共同结清、工具重复执行保护、逐步 Broker permit、当前有效 Outcome 聚合、exact admission retry 与 runner 状态。
- MEM-01/03：board-off 清除 round checkpoint、知识条件检索与负例、CTF 报告完整 attempt 统计。
- MEM-02：内容寻址 artifact store、owner/ref/digest、字节分页读取、UTF-8 边界、预算、symlink/corruption/persistence fail-closed。
- OBS-01：E1 board/graph 分页、节点/边详情、cursor filter、state revision、只读刷新客户端。
- WEB-01 W1：本地 HTTP/session/cookie adapter、同步工具 schema、独立平台结果绑定；尚未接入 Campaign/Host 的正式共享工具注册和真实平台。

验证结果：

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| E1/C6 required | 68 scripts，全部 exit 0 | `runtime/dev/completion-implementation/required-full.log` |
| Single-authority | 13/13 pass | `takeover-final-new/aegis-e1-single-authority-review.log` |
| 新增聚焦测试 | 产物 29/29；Web adapter/outcome/recovery/wiring pass；E1 explorer、board-off、knowledge、report pass | `takeover-final-new/`、`check-artifact-final/` |
| Biome | exit 0；保留既有 warning/info | `final-static/biome-fix.log` |
| Batch tsc | exit 1，186 条既有诊断 | `final-static/tsconfig.aegis.json-final.log` |
| Campaign tsc | exit 1，189 条既有诊断，无新增诊断 | `final-static/tsconfig.aegis-campaign.json-final.log` |
| 真实 provider/远程目标 | 未运行 | 本轮不启动真实效果实验 |

限制：

- Web adapter 尚未在 Campaign `c6-sdk-runtime`/Host 白名单中注册，未建立正式 Web family、共享 ledger/Oracle/平台导入入口；当前是 W1 独立工程层。
- artifact read 已接入 Observer 工具并使用现有 work account，但完整 artifact 原文保存的是脱敏工具文本，不是未脱敏远端原始响应；敏感原文不会被自动恢复。
- CTF 正式矩阵、短 Session 效果、active Experience 效果、迁移实验仍未运行。
- 未修改 Pi 核心、凭据、依赖或 lockfile；未调用真实目标网络。