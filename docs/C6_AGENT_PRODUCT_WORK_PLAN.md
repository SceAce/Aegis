# C6 模型 Agent 与经验闭环 — 工作计划

状态：`internally_verified / awaiting_external_review`（主 DS 自主完成 C6-A–F；交一次限定工程验收）。
分支 `feat/c6-agent-product`，起点 `d3dc28f`（父仓库）/ 内嵌 Pi `42a3497d0`。
依据：`C6_AGENT_PRODUCT_TASK.md`、`SDK_LAUNCHER_TASK.md`（并入 C6-A）、
`AGENT_DEVELOPMENT_STANDARD.md` §3.1、`AGENT_TESTING_STANDARD.md`、`GIT_STANDARD.md`、
`DS_ORCHESTRATION_WORKFLOW.md`。

## 1. BASE 基线（已记录）

记录于 ignored `Pi_Agent_base/runtime/dev/c6-base/baseline.json`。

| 项目 | 实测 |
| --- | --- |
| 父仓库 HEAD / 分支 | `d3dc28f` / `feat/c5-integration`（开始工作树干净） |
| 任务分支 | `feat/c6-agent-product` |
| 内嵌 Pi HEAD | `42a3497d0`（干净；父仓库 gitignore，不入 gitlink） |
| Node / npm | v26.10.0 / 11.19.1 |
| C5 四 suite + external-boundaries | 全部真实 exit 0（本次复跑） |
| C5 session-sdk（source resolver + faux） | exit 0，14 check 块 |
| Campaign tsc | exit 1，74 条既有诊断（与 C5_EXTERNAL_REVIEW 一致） |

## 2. 复用与禁止

复用：`scheduler.mjs`、`host.mjs`、`broker-worker.mjs`、`host-oracle.mjs`、
`campaign-mode.mjs`、`c3-entry.mjs`（assembly）、`c5-entry.mjs`、`campaign-config.mjs`、
`projection.mjs`、`observation-server.mjs`、`report-entry.mjs`、`report-export.mjs`、
`session-supervisor.mjs`、`handoff-host.mjs`、`events.mjs`、`ram.mjs`、`board.mjs`、`state.mjs`、
`learning-bridge.mjs`、`learning-router.mjs`、`workflow-engine.mjs`、`experience-compiler.mjs`、
`learning-store.mjs`、`script-registry.mjs`、`action-contract.mjs`。

禁止：第二套 Scheduler/Broker/Oracle/证据/学习框架；改内嵌 Pi 核心；改用户 auth/models/
settings/lockfile；真实 provider/外部目标调用；自动验收模型。

## 3. 冻结的公共契约（编码前）

### 3.1 CLI 与配置白名单

新增产品入口 `memory/campaign/c6-entry.mjs`，子命令：
`run | status | pause | resume | cancel | export | observe | rotate | measure`。

配置 `campaign-config-1.1`，在 1.0 基础上新增顶层键（其余仍拒绝）：
- `schema_version: "campaign-config-1.1"`（1.0 仍接受，映射到 faux 默认）
- `provider`: 对象 `{ kind: "faux" | "local-openai" | ... , model, base_url?, credential_ref? }`
  - `kind` 必须属于已注册 provider 白名单；未知/缺配置拒绝。
  - `faux` 为开发默认；`local-*` 只接受 loopback `base_url`。
  - `credential_ref` 只允许引用环境变量名/文件路径形式，永不打印值。
- `context`: `{ max_total_input_chars, output_reserve_chars, strategy: "bounded_ram"|"full_history" }`
- `learning`: `{ policy: "off"|"shadow"|"explicit", promote_experience: false, environment: {...} }`
- `task_family`: `"fixture-state" | "structured-data-repair" | "code-repair"`（显式，无自动推断）
- `measure`: `{ out_dir, attempts_manifest? }`

### 3.2 资源所有权

| 资源 | Owner |
| --- | --- |
| EventLog writer | Host（`bindHostEventLog` 借用给 Observer，退出时解绑） |
| Campaign gate | Host 创建，同一对象注入所有 Session 的 ResourceLoader |
| SDK runtime | C6-A launcher 创建/替换/dispose |
| 预算账本 | Host（唯一 charge owner，读写 committed 事件） |
| Session 生成 | Host（经 `session-supervisor`） |
| 经验 store | 派生，可重建（`learning-store`） |

### 3.3 Task/Episode/Session 映射

- 当前 Task 来自 committed projection 的 `ready` 队首；SDK session 绑定该 Task 的
  `task_id`/`attempt`/Episode（`ep-<task_id>`）。
- Session 更换保留同一 Episode；不增加独立 Episode。
- 下一 Task 需显式 bind，不沿用前一 Task 的 SDK 标签。

### 3.4 预算基线

- 维度：`wall_time_ms`、`model_requests`、`tool_calls`、`session_count`，以及新增
  `input_chars`（估算门）。
- 每次 provider 请求（含自动 tool loop）与工具调用前预留 `model_requests`/`tool_calls`。
- 不可观测的 token/金额写 `null`/`unknown`；faux 估算标注 `estimated`。
- 跨 Task/restart 从 committed 事件累加，不重置、不双扣。

### 3.5 证据引用与跨运行导入

- proof/Manifest/action/adapter digest 有明确 scope（campaign/task/episode）。
- 跨运行导入校验源 stream chain、Manifest digest、adapter digest、action version/digest。
- 只复制 Outcome ID 或 active JSON 不作数。

### 3.6 学习 policy

- 默认 `promote_experience: false`。
- 只有 Host 显式 `learning.policy` + 明确 `proof_ids` 才调用 Compiler。
- 模型不能晋升 active；`candidate` 不当 hint。

### 3.7 服务生命周期与退出

- 执行模式完成/失败/暂停/取消后有界 cleanup。
- observe 模式 loopback listener 常驻到显式关闭/SIGTERM。
- SIGTERM drain；SIGKILL 恢复先 reconcile；未决非幂等动作不盲重发。
- 退出码：0 成功；1 运行/控制/导出失败；2 用法/配置错误。

## 4. 任务图与依赖

| 任务 | 文件范围 | 依赖 | 里程碑提交 |
| --- | --- | --- | --- |
| C6-A SDK/Host 生命周期 | `c6-entry.mjs`、`c6-sdk-runtime.mjs`、`campaign-config.mjs`、`index.mjs` | BASE | `feat: C6-A` |
| C6-B 模型 Worker/计量 | `c6-model-worker.mjs`、`c6-tool-ledger.mjs`、`structured-data-adapter.mjs` | A | `feat: C6-B` |
| C6-C Campaign 学习 | `c6-learning.mjs`（接 bridge/router/compiler/store） | B | `feat: C6-C` |
| C6-D provider 接口 | `provider-config.mjs` | A/B | `feat: C6-D` |
| C6-E 测量/运行支撑 | `c6-measure.mjs`、`c6-runner.mjs` | B/C/D | `feat: C6-E` |
| C6-F 第二任务族/交付 | `code-repair-adapter.mjs`、runbook | A-E | `feat: C6-F` |

主 DS 拥有共享 Host/entry/Observer/EventLog/config/resolver/index/report/runner 与全部文档。
无子 Agent 能力，串行执行并如实记录。

## 5. 测试矩阵与 required 门

见 `C6_AGENT_PRODUCT_TEST_MATRIX.md`。required 门为 C6-P1–P8 对应脚本；
冻结范围内无未解阻塞。

## 6. 范围冻结（§3.1）

- `current_blocker`：当前可达假成功、授权越界、重复副作用、预算错误、权威数据损坏。
- `non_blocking`：真实模型能力、token 精确性（未校准）、UI 样式。
- `deferred`：F16 缓存优化、多 Worker、容器/远程、任意经验组合、权重训练、
  真实模型 pilot、效果对照、迁移与日常试用。

## 7. 未实测限制（列明）

- 只通过 faux provider 与 SDK create seam 替身验证 provider 参数传递；
  具体真实 provider（如某本地 OpenAI 兼容 endpoint）未实测。
- 不读取真实凭据、不请求真实模型。
