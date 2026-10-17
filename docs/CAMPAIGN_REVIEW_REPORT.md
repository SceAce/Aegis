# Aegis Campaign — Master DS Review Report

## 当前整体完善代码工作（ce0bde0 起点）

状态 **blocked / changes_required，代码工作未完成**。指定中转在多次独立会话中返回 `continuation routing failed: sticky_control_unavailable`，包括一次最小 checkpoint 修复委派和最后一次有界收尾。未切换模型。工作目标与范围见 [总计划](AEGIS_COMPLETION_MASTER_PLAN.md)，分工见 [当前工作计划](CAMPAIGN_WORK_PLAN.md)，验证入口见 [当前矩阵](CAMPAIGN_TEST_MATRIX.md)。下文 C0/C1 结论为历史，不描述本轮。

本轮实际委派 `maxapi/deepseek-v4.1-flash` 子 Agent：CORE、MEMORY、ARTIFACT、OBSERVATION、WEB；CORE 后拆为 context/authority/effects，另有最小 checkpoint 和有界 finish 委派。日志 assistant 字段核对为指定 provider/model；同模型子会话不等于外部审查。原始日志 `Pi_Agent_base/runtime/dev/completion-implementation/` 保持 ignored。

当前未完成源码保留在工作树，**尚未通过代码审查，不作为可用功能发布**：产物存储/分页读取模块，E1 explorer/server/view/client，以及部分新增测试。CORE、知识排序、生产 checkpoint 过滤、Web 实现、共享入口接线和实验 runner 未完成。新测试也未经完整独立预期审查；import 缺失不当作产品行为 red→green。

主 Agent 实际执行：

| 检查 | 结果 | 私有证据 |
| --- | --- | --- |
| 最终显式 12 脚本 | exit 1；4 pass / 8 fail | `final-checks/results.json` |
| 原 observation HTTP/XSS/E1 view | 3 脚本 exit 0，仅既有断言通过，不证明新功能完整 | 同上 |
| module-layout | exit 0；初次在子 Agent编辑中遇 const 赋值构建错误，最终复跑已过 | 同上及 `observation-review/` |
| artifact-store、新 memory/knowledge/report、四个 Web 脚本 | 8 脚本 exit 1；含未实现模块的 import 错误，不能称有效行为反例全覆盖 | 同上 |
| 变更代码 Biome | exit 1，尚未修复 | `final-static/biome.log` |
| Batch tsc | exit 1；186→186 条诊断 | `baseline/`、`final-static/` |
| Campaign tsc | exit 1；189→197 条诊断，新增诊断未收尾 | 同上 |

未执行真实效果实验、未修改 Pi 核心/凭据/依赖/检查规则、未放宽原断言。未完成产品代码及测试未暂存/提交，保留工作树以便指定中转恢复后续接；本次仅提交状态文档。整体完成条件未满足，不能以观察旧回归通过代替全部目标完成。

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
