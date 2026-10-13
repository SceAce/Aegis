# C6 模型 Agent 与经验闭环 — 操作手册（Runbook）

本手册是从干净临时目录复制即可运行的 C6 产品入口说明。开发默认 provider 为离线
`faux`；本手册不读取真实凭据、不请求真实模型或外部目标。

可执行形式见 `Pi_Agent_base/tests/aegis-c6-runbook.mjs`（SDK-L8）。

## 1. 前置：目录布局

在任意可写临时目录（示例 `/tmp/aegis-c6`）建立：

```text
/tmp/aegis-c6/
  workspace/dataset.json      # 任务工作区（非 OS sandbox）
  manifest.json               # 可信 Manifest
  campaign.config.json        # 可信运行配置
  run/                        # 运行产物（events.jsonl 等）
```

`workspace/dataset.json`：

```json
{"name": "??"}
```

## 2. 生成 Manifest（结构化数据修复任务族）

Manifest 是**不可变可信输入**。可用一次性脚本生成并校验：

```bash
cd /Users/scemac/My_github/Aegis
node --input-type=module -e '
import { writeFileSync } from "node:fs";
import { buildDataRepairManifest } from "./Pi_Agent_base/memory/campaign/structured-data-adapter.mjs";
import { validateManifest } from "./Pi_Agent_base/memory/campaign/manifest.mjs";
const ws = "/tmp/aegis-c6/workspace";
const v = validateManifest(buildDataRepairManifest({ workspaceRoot: ws }));
if (!v.ok) { console.error(v.reasons); process.exit(1); }
writeFileSync("/tmp/aegis-c6/manifest.json", JSON.stringify(v.manifest, null, 2));
console.log("manifest ok");
'
```

## 3. 运行配置（campaign-config-1.1）

`/tmp/aegis-c6/campaign.config.json`：

```json
{
  "schema_version": "campaign-config-1.1",
  "manifest_path": "/tmp/aegis-c6/manifest.json",
  "workspace_root": "/tmp/aegis-c6/workspace",
  "work_dir": "/tmp/aegis-c6/run",
  "mode": "auto",
  "provider": { "kind": "faux", "model": "faux-c6" },
  "context": { "strategy": "bounded_ram", "max_total_input_chars": 200000, "output_reserve_chars": 1000 },
  "learning": { "policy": "off", "promote_experience": false, "proof_ids": [] },
  "task_family": "structured-data-repair",
  "session": { "session_count": 4, "max_requests_per_session": 10 },
  "observation": { "enabled": false, "port": 0 },
  "oracle": { "kind": "fixture" },
  "measure": { "out_dir": "/tmp/aegis-c6/measure" }
}
```

- `provider.kind` 必须在已注册白名单内；未知/缺 `model`/非 loopback 本地 endpoint 启动即拒绝。
- `learning.promote_experience` 必须为 `false`。
- `task_family` 为 `fixture-state` / `structured-data-repair` / `code-repair`。
- `registered_test` 仅 `code-repair` 使用（外部只读测试文件名，默认 `check.mjs`）。

## 4. 命令（使用 source resolver）

所有命令从仓库根目录运行；SDK 使用真实 source resolver。

```bash
ENTRY=/Users/scemac/My_github/Aegis/Pi_Agent_base/memory/campaign/c6-entry.mjs
RES=/Users/scemac/My_github/Aegis/Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts
CFG=/tmp/aegis-c6/campaign.config.json
run() { node --import "$RES" "$ENTRY" --config "$CFG" "$@"; }
```

| 命令 | 语义 | 退出码 |
| --- | --- | --- |
| `run` | 执行到停止/完成；写 committed stream | 0 成功；1 运行/控制/导出失败；2 用法/配置错误 |
| `status` | 只读投影 committed stream，不 dispatch | 同上 |
| `pause` / `resume` / `cancel` | 写入 typed 持久控制事件，再执行 | 同上 |
| `rotate` | 显式一次安全 Session 轮换，再执行 | 同上 |
| `export` | 从 committed stream 导出只读报告到 `run/report` | 同上 |
| `observe` | 启动常驻只读观察服务（loopback），直到显式关闭/SIGTERM | 同上 |
| `measure` | 导出测量（逐 attempt、usage 来源、unknown 保留） | 同上 |

示例：

```bash
run run          # 执行
run status       # 只读状态
run export       # 导出报告
run observe --port 0   # 常驻观察（打印 URL）
run measure      # 测量导出
```

`--observe` / `--export` 可与 `run` 组合；`--out <dir>` 指定导出目录；`--port <n>` 指定观察端口
（0=临时端口）。

## 5. 生命周期与控制

- **Session 轮换**：当本 Session 的 provider 请求数达到 `session.max_requests_per_session` 时，
  Host 在任务 settle 边界经 C2 supervisor 触发一次安全轮换（真新 AgentSession 对象、同 Episode、
  预算各扣一次）。`rotate` 子命令可显式触发一次。
- **暂停/取消**：`pause`/`cancel` 写入持久事件；重启后用 `status`/`run` 不会复活取消，暂停需 `resume`。
- **常驻观察**：`observe` 打印 `http://127.0.0.1:<port>`；服务只读，无写路由；占用端口不阻止执行。
- **SIGTERM**：观察模式收到 SIGTERM 时执行 drain 并关闭 listener，可再次绑定端口。
- **恢复**：进程被 SIGKILL 后重启，Scheduler 先 reconcile 遗留动作（读真实产物），不盲目重发。

## 6. 报告与测量

- `export` 从 committed stream 生成报告（同源只读）；未知成本写 `null`/`unknown`。
- `measure` 生成 `measurement.json`：逐 attempt、配置版本、`ledger.usage_sources`
  （`model_requests`/`tool_calls` = measured，`input_chars` = estimated，`tokens`/`currency` = unknown）。
  `backend_tokens`/`backend_currency` 为 `null`，不填 0。

## 7. 经验闭环（可选）

`learning.policy`：

- `off`（默认）：不编译、不路由捷径。
- `shadow`：只读走管线，不产生 active。
- `explicit`：仅在给出明确 `proof_ids` 时调用既有 Compiler；`promote_experience` 保持 `false`。
  模型不能晋升 active；`candidate` 不作 hint。

派生经验 store 位于 `run/experiences/`，可由 committed `experience.compiled` 记录重建（删除无损）。

## 8. 第二个任务族：代码修复

- Manifest 由 `buildCodeRepairManifest` 生成；`task_family: "code-repair"`。
- 外部只读测试（`registered_test`，默认 `check.mjs`）由 Host 提供，模型不能修改它。
- 模型通过受控 `code.file.write`（数据：目标文件 + 内容）提出补丁；越权目标被 grant 拒绝。
- Oracle 实际运行注册测试并读真实结果；测试真实失败=failure，harness 错误=unknown。

## 9. 已知限制

- workspace 不是 OS sandbox；loopback 观察不隔离本地恶意进程。
- 开发默认 provider 为 faux；具体真实/本地 provider 未在本轮实测（见 implementation report）。
- 真实模型 pilot、上下文校准、经验效果对照、迁移与日常试用是后续独立实验。

## 10. 经验闭环运行（C6-C / X8）

学习闭合需要显式配置、明确 proof IDs 和可信隔离 Replay adapter：

```json
"learning": {
  "policy": "explicit",
  "promote_experience": false,
  "proof_ids": ["o-task-001", "o-task-002"],
  "replay_adapter": "/abs/path/to/Pi_Agent_base/memory/campaign/isolated-replay-adapter.mjs",
  "environment": {
    "environment_fingerprint": "data-repair-env",
    "domain": "structured-data",
    "permissions": ["data.record.write"],
    "task_types": ["verify", "reproduce"]
  }
}
```

- `replay_adapter` 只由可信 config 引用（非模型），作为模块导入，从不 `eval`。
- 编译前对每个 proof 执行真实隔离 Replay（重建 pre-state、重跑注册动作、重验 criterion）；
  每次 replay 后从 committed stream 重建 bridge。
- 达到 active 时经**同一 Host writer** 写权威 `runtime.note kind=experience.compiled`。
- 删除 `run/experiences/` 后可从 committed note 重建（派生无损）。
- Router 在模型规划之前运行：`direct`/`habit` 零规划请求；第三 Task 复用同一规则仍由独立 Oracle 判定效果。
- 正例需**同方法、相容条件**的独立场景（见 `buildDataRepairLearningManifest`）。

## 11. 外部边界与修复回归

修复轮的可复现命令（仓库根目录）：

```bash
# 外部工程边界套件（X1-X12，真实 SDK/faux + 本地子进程 + loopback）
node --test Pi_Agent_base/tests/aegis-c6-external-boundaries.mjs

# 学习闭合（真实 Replay → active → direct 零规划）
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/aegis-c6-learning-closure.mjs

# 真实 child SIGKILL 恢复（durable intent / 真实 effect 后杀死，重启 reconcile）
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/aegis-c6-recovery.mjs

# 类型（C6-owned 新增诊断应为 0）
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json
```

证据/日志：`Pi_Agent_base/runtime/dev/c6-repair/`（ignored）。

## 12. 复验剩余五组修复回归（模型本地）

```bash
# 聚焦复验：provider 调用前门/持久预留、registered-test 可信完成、
# aegis_read 当前 Task grant、runner 实际初态、habit 路由
node --test Pi_Agent_base/tests/aegis-c6-recheck-boundaries.mjs

# 外部工程边界（含 read-budget：额度 1 实际 1 次 provider 请求）
node --test Pi_Agent_base/tests/aegis-c6-external-boundaries.mjs

# 学习真复用：两独立 reset 训练 → 真实 Replay/Compiler active →
# 未执行的 task-003 产生 NEW intent/effect/Oracle success，零规划请求
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/aegis-c6-learning-closure.mjs

# 全 C6 脚本 + 受影响回归（自动选择 source resolver）
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs Pi_Agent_base/runtime/dev/c6-recheck-2/<name> \
  aegis-c6-code-repair aegis-c6-durability-recovery aegis-c6-external-boundaries \
  aegis-c6-learning-closure aegis-c6-learning-reuse aegis-c6-ledger-input \
  aegis-c6-product-chain aegis-c6-provider aegis-c6-recovery aegis-c6-rotation-reject \
  aegis-c6-runbook aegis-c6-runner aegis-c6-sdk-lifecycle aegis-c6-service-measure \
  aegis-c6-recheck-boundaries
```

evidence/logs：`Pi_Agent_base/runtime/dev/c6-recheck-2/`（ignored）。
注意：非 SDK 测试不要加载 source resolver（纯 node 测试加载它会引入无关的
FileHandle GC finalizer 错误）。`c6-suite-runner.mjs` 按测试是否 import
`@earendil-works/pi-` 自动选择启动方式。

## 13. 请求生命周期与重启防线（本轮收敛）

每个 provider 请求在调用前预留两层（Campaign + Task）额度，并写 durable
`runtime.note kind=c6.request, phase=reserved`；provider 返回后两层各自 commit，再写
`phase=committed`（含 `provider_status`/`commit_status`），才允许决策进入 Broker。

- `provider_status=error`（SDK 合成错误消息）：请求仍计费一次，任务转 unknown，决策不执行。
- provider 已启动但无 completion（进程崩溃 / 传输中断）：保留 pending hold 不退款，
  写 `phase=reconciliation_required`，运行停止。
- 重启时若存在未决 reserved/reconciliation 或 invalid/conflicting 校准记录，入口重建
  `reconciliationGuard`，拒绝新的 provider/Broker dispatch（含 direct 路由）并保留预算责任。
  只有明确确认的结算/释放才降低预算责任。

可复现命令：

```bash
# 聚焦行为（内存 commit/reconciliation/每 Task 隔离/部分 commit）
node --test Pi_Agent_base/tests/aegis-c6-lifecycle-convergence.mjs

# 真实子进程 SIGKILL + 重启（保留 durable reserved、重启阻断）
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/aegis-c6-lifecycle-restart.mjs
```

## 14. 有限真实任务 pilot 输入清单（下一阶段；本轮不启动、不写真实配置）

只有用户另行授权后才运行真实 provider/target。所需输入（复用现有接口，不新增实验框架）：

| 类别 | 必填项 | 说明 |
| --- | --- | --- |
| provider | `provider.kind` / `model` / `base_url?` / `credential_ref` | `credential_ref` 仅引用环境变量名/文件路径，不写值、不打印；local 只接受 loopback |
| 目录 | `workspace_root` / `work_dir` / `manifest_path` | workspace 非 OS sandbox；`work_dir` 写权威 events.jsonl |
| 授权 | Manifest `tasks[].target_ref`、`stages[].criteria`、`mode`、动作/工具 grant | 模型不能提供/改变身份或授权；未注册 action/criterion 由 Broker/Oracle 拒绝 |
| 预算 | `manifest.budget` + 每 task `task_budget`（model_requests/tool_calls/wall_time_ms）、`session.*`、`context.max_total_input_chars`/`output_reserve_chars` | hard gate；超限在 provider 调用前拒绝 |
| Oracle | `task_family`（fixture-state/structured-data-repair/code-repair）、`registered_test`（code-repair）、`oracle.kind` | 外部只读测试/独立 judge；unknown 不当作 success |
| 学习 | `learning.policy`（off/shadow/explicit）、`proof_ids`、`replay_adapter`、`environment` | 默认 off；`promote_experience` 必须 false；模型不能晋升 |
| 停止条件 | 预算/窗口耗尽、`reconciliation_required`、`pause`/`cancel`、SIGTERM drain、reconciliation 未决 | 未决请求不自动退款/重发 |

启动前确认：不读取真实凭据以外的方式（凭据由环境/文件引用注入）；使用干净 `work_dir`；
用 `status`/`measure` 核对 committed 重建；任何 `reconciliation_required` 必须先人工核对后
才能继续。模型选择与实际实验预算由用户下一阶段确定；本轮未启动真实 provider，也未开始
真实任务/效果实验。

### 14.1 尚未实测限制

- 未对接真实 provider 计费/错误模式；`provider_status`/usage 依赖后端可观测性。
- `measureProviderInput` 是字符估算而非精确 tokenizer；backend token/currency 保持 unknown。
- workspace 不是 OS sandbox；进程崩溃恢复已验证“保留/阻断”，未建自动结算平台。
