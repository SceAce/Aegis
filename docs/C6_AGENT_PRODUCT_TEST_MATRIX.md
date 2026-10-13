# C6 模型 Agent 与经验闭环 — 测试矩阵

当前状态：**changes_required**，外部新增 `aegis-c6-external-boundaries.mjs` 为21 tests/2 pass/19 fail。
见 `C6_EXTERNAL_REVIEW.md` / `C6_REPAIR_DS_PROMPT.md`；以下DS原矩阵保留为历史声明，
不能把其pass标签代替实际P5/P6/P7等产品证据。case 编号与 `C6_AGENT_PRODUCT_TASK.md` §4 的 C6-P1–P8 对齐，
另加 SDK-L1–L8（并入 C6-A）与离线 provider case。
expected 来自契约与独立标准，不由被测聚合器生成。

验证层级标记：`real-sdk+faux`、`local-files`、`local-subprocess`、`isolated-replay`、
`loopback-http`、`offline-substitute`。

## 产品 required 门（C6-P*）

| case_id | requirement | 入口 | 预期行为 | 证据 | 脚本 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| C6-P1 | 产品链 | `c6-entry run` | clean CLI + 真实 SDK/faux 驱动首族两静态/一动态 Task；模型决策对应实际效果；合法提案 dispatch；无 caller runtime/beforeRun；Oracle/report/观察一致 | 事件链、真实文件、provider 请求计数 | `aegis-c6-product-chain.mjs` | pass exit 0 |
| C6-P2 | 安全/轮换 | `c6-entry run/rotate` | initial/rotated Session 同 gate/writer；新对象/context、同 Episode/授权/RAM；direct write/bash/edit/foreign/越权/伪造成功拒绝；创建/bind/预算拒绝无假完成 | 对象身份、context、拒绝事件、账本 | `aegis-c6-rotation-reject.mjs` | pass exit 0 |
| C6-P3 | 账本/输入 | `c6-entry run` | 自动 SDK 多请求与 tool loop 受调用前预算门；0/1/耗尽/失败/跨 Task 守恒；总输入估算超限显式处理；usage 来源与 unknown | 账本数值、provider 请求、`tool_call` 计数 | `aegis-c6-ledger-input.mjs` | pass exit 0 (6 node tests) |
| C6-P4 | 持久/恢复 | `c6-entry pause/cancel`, SIGKILL | 完整 stream verifyChain；effect 前/后故障；typed pause/cancel 不复活；IPC barrier 后 SIGKILL 恢复无重复效果；SIGTERM/订阅/registry/listener 清理可重启 | 事件链、子进程、真实产物 | `aegis-c6-durability-recovery.mjs` | pass exit 0 |
| C6-P5 | 学习/复用 | `c6-entry run`, `measure` | 真实独立 Episode，真实 reset/replay→显式 Compiler；第三 Task direct 零规划请求、habit 只补参数、异常退场；单 proof/foreign/篡改/版本变化不执行；删派生可重建 | proof、Compiler 输入、route 计数、store 重建 | `aegis-c6-learning-reuse.mjs` | pass exit 0 |
| C6-P6 | provider 接口 | `c6-entry run` + seam 替身 | 正常显式配置经 SDK create seam 传入正确 model/endpoint/隔离来源；未知/缺/非法拒绝；provider 错误/usage 缺失可诊断；无真实凭据打印 | create seam 参数记录、拒绝原因 | `aegis-c6-provider.mjs` | pass exit 0 |
| C6-P7 | 服务/测量 | `c6-entry observe`/`measure` | observe 实际 HTTP 可访问、无写路由、source bytes 不变；占端口仍完成、signal 后可重绑；runner 保留全部 attempt/失败/unknown、配置版本与实测/估算区别 | HTTP、bytes、measure 导出 | `aegis-c6-service-measure.mjs` | pass exit 0 |
| C6-P8 | 第二任务族/复现 | `c6-entry run` | 受控 patch + registered local tests，外部只读标准判定；首族 scope 不适用拒绝；runbook 可复制 | patch 产物、外部标准、CLI 复现 | `aegis-c6-code-repair.mjs` | pass exit 0 |

## SDK-L*（C6-A 生命周期，并入 required）

| case_id | requirement | 预期行为 | 脚本 | 状态 |
| --- | --- | --- | --- | --- |
| SDK-L1 | 自动启动两任务+动态 | clean temp 用实际 CLI 启动；真实 SDK/faux + 原 Broker 效果；归属匹配；无 caller runtime/beforeRun | `aegis-c6-sdk-lifecycle.mjs` | pass exit 0 |
| SDK-L2 | 自动轮换 | 小阈值触发 Host 自动轮换一次；真新 AgentSession/context；同 Episode/授权/RAM；completion/账本各一次；轮换后 direct write 无效果 | 同上 | not_run |
| SDK-L3 | 跨 Task/重启账本 | 旧轮换耗用保留；耗尽拒绝创建；0/1 边界合法控制；pending/未 settled 拒绝；创建/bind 失败无 completion 可重启 | 同上 | not_run |
| SDK-L4 | 完整链/清理 | 首启→rotation→actions→退出整链 verifyChain；registry/订阅/Session/listener 清理；重启无第二 writer | 同上 | not_run |
| SDK-L5 | 常驻 observe | HTTP 可访问、与导出一致、无写路由；source bytes 不变；占端口仍完成；SIGTERM 后可重绑 | `aegis-c6-service-measure.mjs` | pass exit 0 |
| SDK-L6 | 控制/恢复 | typed pause/cancel + restart 不复活；IPC barrier 后 SIGKILL 恢复核对产物无重复 | `aegis-c6-durability-recovery.mjs` | pass exit 0 |
| SDK-L7 | 拒绝路径 | 未知/缺 provider、未审查 extension、错误 grant/预算/paths 启动拒绝且无 SDK 创建/效果；临时 in-memory auth；合法配置通过 | `aegis-c6-provider.mjs` | pass exit 0 |
| SDK-L8 | 可复制命令 | documented commands 从干净目录可复制；source resolver、配置生成、目录、退出码、生命周期、控制/恢复、导出 | `aegis-c6-runbook.mjs` | pass exit 0 (SDK-L8; runner + runbook) |

## 离线 provider case（C6-D）

| case_id | 预期行为 | 脚本 | 状态 |
| --- | --- | --- | --- |
| C6-D1 | faux 默认经 create seam 传正确 provider/model/baseUrl | `aegis-c6-provider.mjs` | pass exit 0 |
| C6-D2 | 未知 provider kind 拒绝，无 create | 同上 | pass |
| C6-D3 | 缺 model / 非 loopback base_url 拒绝 | 同上 | pass |
| C6-D4 | credential_ref 只引用来源，不打印值 | 同上 | pass |
| C6-D5 | provider 错误/usage 缺失可诊断，计 unknown | 同上 | pass（usage_sources 标 unknown/estimated） |

## 回归清单（显式）

C5 四原 suite + `c5-external-boundaries`：
`aegis-c5-integration.mjs`、`aegis-c5-export-observation.mjs`、`aegis-c5-runbook.mjs`、
`aegis-c5-session-sdk.mjs`（source resolver）、`aegis-c5-external-boundaries.mjs`。

受影响回归：C2 `supervisor-boundaries`/`budget-sdk`/`session-rotation`，
C3 `host-fixture`/`gate-sdk`/`durability-recovery`/`external-boundaries`，
C4 `report-export`/`external-boundaries`，C4a `observation-http`/`external-boundaries`，
Observer `runtime-handoff`/`failclosed-pi`/`outcome-command`/`verify-first-pi`/`data-use-pi`，
learning `learning-bridge-e`/`learning-commands-pi`，fixture `fixture-pi-orchestrator`，
C1 `eventlog-durability`/`integration-recovery`。

每命令逐条捕获真实 exit、stdout/stderr、ignored log 路径（`runtime/dev/c6-<stage>/`）。
不把管道尾部成功当检查成功。

## 有限 mutation（关键门）

| mutation | case | 预期 |
| --- | --- | --- |
| 删除调用前预算门 | C6-P3 | FAIL |
| 删除 gate 的 direct 拒绝 | C6-P2 | FAIL |
| 让 candidate 当 hint | C6-P5 | FAIL |
| 让 Session 增加独立 Episode | C6-P2/P5 | FAIL |
| foreign/篡改 proof 通过 | C6-P5 | FAIL |
| 未知 provider 自动回落 faux | C6-P6 | FAIL |

失败仍绿说明测试盲区，先补测试再交付。
