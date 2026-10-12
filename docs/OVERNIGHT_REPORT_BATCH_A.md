# 交付报告：Batch A（Effective Board / 逐请求 RAM / 真实 Runtime 交接）

状态：**Batch A 已实现并全部测试通过。Batch B / C 保持未实现（pending）。**
范围：只做 `docs/OVERNIGHT_TASK.md` 的 Batch A。未改 Pi 核心、未改既有
auth/models/settings、未改 lock 文件、未恢复已删 Python demo、未 commit git。

测试运行命令（Pi 相关因为 `dist/` 缺失，用源码解析器）：

```bash
# 纯 Node
node Pi_Agent_base/tests/<test>.mjs
# 需要 Pi 源码的
node --import Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/<test>.mjs
```

## 1. 已实现 / 未实现 / 实测 表

| 项 | 状态 | 位置 | 实测 |
| --- | --- | --- | --- |
| A1 有效/当前 board 投影 + 规范化 `Outcome.supersedes` | 已实现 | `memory/runtime/board.mjs` | `aegis-runtime-effective-board.mjs` 47 断言 EXIT 0；`aegis-runtime-core-smoke.mjs` 58 断言 EXIT 0 |
| A1 历史视图 `byType` 与有效视图 `currentByType` 并存，只有有效视图进入 RAM/handoff | 已实现 | `board.mjs` / `ram.mjs` / `handoff.mjs` | 同上；contest/outcome 集成测试 EXIT 0 |
| A1 `effective_digest` 与 `digest` 分离 | 已实现 | `board.mjs` `summarizeBoard` | effective-board 断言 `effective_digest !== digest` |
| A1 `environment.changed` 标记 stale（不删除、不追溯新验证、空 scope fail-closed） | 已实现 | `board.mjs` `resolveEnvironmentChanges` | effective-board 第 6 节 10 断言 |
| A2 每 provider 请求重建 RAM（`context_with_system`） | 已实现 | `extensions/aegis-observer.ts` | `aegis-observer-contest-pi.mjs` 38 断言 EXIT 0（同一 prompt 内后续请求见到刚提交候选；首请求见不到） |
| A2 每次请求记录 `request.projected`（digest + state version），不建 board 节点、不 bump RuntimeState | 已实现 | `events.mjs` + observer | contest-pi 断言 `ram_digest` 与实际 provider-bound 字节一致；无节点、state.version 不变 |
| A3 真实 `AgentSessionRuntime` 交接（非 stub） | 已实现 | `handoff-host.mjs` + observer `/aegis switch` | `aegis-observer-runtime-handoff.mjs` 33 断言 EXIT 0 |
| A3 完成只写一次（新旧实例幂等） | 已实现 | `handoffAlreadyCompleted` + `session_shutdown` 置 `log=null` | runtime-handoff：单次 `handoff.completed`、共 2 次完成、1 个 episode |
| A3 取消/失败不假成功（不 rename staged 文件） | 已实现 | observer `/aegis switch` 的 `cancel`/`catch` 分支 | runtime-handoff Phase 3/4 EXIT 0 |
| A3 settle 后暴露 `handoff_ready`（薄 Host 触发信号） | 已实现 | observer `agent_settled` | runtime-handoff 断言 `handoff_ready===true` 且 `handoff_request_id` 匹配 |
| A4 正/负测试 | 已实现 | 上述 3 个测试文件 | 见上 |
| Batch B（ActionContract/Router/Compiler/Contribution/Authorization…） | 非本批交付；本会话期间由并行 DS 工作落地并自测通过 | `memory/runtime/{action-contract,authorization,workspace-info-actions,script-registry,learning-router,experience-compiler,contribution}.mjs` | `memory-runtime-batch-b-smoke.mjs` **89 断言 EXIT 0**（我未实现、未逐条审计其正确性） |
| 把 `applyStagedHandoff` 接进 Pi print/interactive host | **未实现（有意）** | — | 见 THINK 10.3 / 报告第 4 节 |

## 2. 关键设计（已落地，非临时）

- **有效视图语义**：`supersedes` 只把被替换的 Outcome 移出**有效**视图，历史
  `byType` 保留并带 `effective_status`（`current`/`superseded`/`stale`）。
- **supersede 合法性**（`validateSupersede`）：要求来源为 `oracle`/`human`
  （`llm`→`llm`，其他→`untrusted`）、同 Episode（否则 `foreign`）、目标存在且
  **在日志中早于**该条（否则 `missing`；不支持指向未来）、有 `outcome_id`
  （`malformed`）、携带证据（`no_evidence`）、criterion/scope/subject 匹配
  （`criterion_*`/`scope_mismatch`/`subject_mismatch`）、无环（`cycle`）。
  重复 `outcome_id` 不覆盖索引（首个出现者为准）。
- **`environment.changed`**：仅可信来源且在同 scope 时，把**变更之前**记录的
  Fact/Refuted 标 stale；之后重新验证的节点保持 current；空 scope 不标记任何节点
  （fail-closed）。
- **逐请求 RAM**：`context_with_system` 在每个 LLM 请求前重建并按 request 记录；
  只基于已提交事件。
- **交接所有权**：新 session 的 `session_start` 记录完成；旧闭包的 `withSession`
  先查 `handoff.completed` 是否已提交再决定是否写；旧 writer 在 shutdown 后置 null。

## 3. 与 `docs/OVERNIGHT_AUDIT.md` “Batch A 待核验” 的对应

| 审计点 | 处理 |
| --- | --- |
| supersede 需同 Episode / criterion / subject / scope 且可信完整 Outcome | 已实现（见 §2），并额外要求**证据**与**目标早于本事件** |
| 只能 oracle/human 来源，不能残缺 unknown 撤销 Fact | 已实现：`untrusted` + `no_evidence` 拒绝；可信的**完整** unknown 仍可撤销（无新 Fact） |
| 未来记录 / 重复 Outcome ID 不覆盖索引 | 已实现：顺序前缀查找 + 首个出现者胜出 |
| environment.changed 不追溯新验证；空 scope 不误停全图 | 已实现：按事件序只影响变更前绑定；空 scope 不标记 |
| 每 turn RAM 只基于已提交事件；候选历史≠推荐 hint | 已实现：`currentByType` + `## Historical proposals (pending verification, NOT guidance)` |
| handoff 必须真替换对象；取消/失败不写 completed；旧 writer 不续写；不双写完成 | 已实现：A3 + runtime-handoff 测试覆盖 |

## 4. 真实缺口（不声称已修复）

1. **自动交接未接入 Pi host**：Observer 只发 `handoff_ready` 信号，真正执行由
   上层调用 `memory/runtime/handoff-host.mjs`。这是有意边界（见 THINK 10.3）。
2. **`run-pi.sh` 无法运行**：`pi/packages/coding-agent/dist/` 缺失（既有环境
   缺口）。`login-relay-smoke.mjs` 因此失败，与 Batch A 无关；未通过改 Pi 构建绕过。
3. **Batch B 非本批产出**：本会话进行中，`memory/runtime/*.mjs` 的 Batch B 模块
   出现并让其测试转为通过（89 断言）。这**不是 Batch A 的交付**，我未实现、也未逐
   条审计其正确性（该模块文件权限为 0600，时间戳 03:51–04:09，与并行 DS 进程一致）。
   ⚠️ 若这些文件会与本批共享文件（`board.mjs`/`events.mjs`/observer）并发写入，请在
   双方都停止后重跑全量测试。本报告所有 Batch A 结果均在此并发存在的情况下验证通过。
4. **`environment.changed` scope 粒度未定**（THINK 10.1）；当前只做精确匹配 + 空
   scope fail-closed。
5. **`request.projected` 全量写入**可能增大长会话事件量（THINK 10.4）。
6. **手动/自动交接并发**暂无显式锁，依赖幂等 + rename（THINK 10.5）。

## 5. 实测汇总

- 纯 Node：`aegis-runtime-core-smoke`(58) / `aegis-runtime-effective-board`(47) /
  `compile-live-experience-smoke` / `contest-launcher-smoke` /
  `contest-pipeline-smoke` / `contest-smoke` / `fixture-direct-smoke` /
  `live-oracle-smoke` / `replay-oracle-smoke` 全部 EXIT 0。
- Pi：`aegis-observer-failclosed-pi`(5) / `aegis-observer-contest-pi`(38) /
  `aegis-observer-outcome-command`(38) / `aegis-observer-runtime-handoff`(33) /
  `aegis-contest-pi-integration`(29) / `fixture-pi-integration`(36) /
  `fixture-pi-orchestrator`(27) 全部 EXIT 0；`observer-smoke` 13 events EXIT 0。
- 断言合计：**311**（上限为 0 个失败）。
- 未通过（与本批无关）：`login-relay-smoke`（缺 `pi/packages/coding-agent/dist/` bundle）。
- 非本批但当前通过：`memory-runtime-batch-b-smoke`（89 断言，EXIT 0）——见缺口 3。
