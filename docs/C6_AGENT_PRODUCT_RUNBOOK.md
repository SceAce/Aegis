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
