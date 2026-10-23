# Aegis Web Console（本地 Web 操作界面）

状态：`internally_verified / awaiting_external_review`。主路径与五类面板已接通真实 Host；
外部独立验收未发生。实现证据见 [第三阶段任务书](WORK_CYCLE_PHASE3_HOST_CONSOLE_IMPLEMENTATION_TASK.md)、
[测试矩阵](WORK_CYCLE_TEST_MATRIX.md) 与 [实现报告](WORK_CYCLE_IMPLEMENTATION_REPORT.md)。

## 安装与前置

Web 服务端是 Aegis 自有代码；浏览器应用在嵌套仓库 `Pi_Agent_base/UI/Aegis-pocket`
（Pi Pocket fork），复用它的 `web/style.css`、字体、图标与 vendored 模块
（`preact`/`htm`/`marked`/`dompurify`）。因此启动前需要：

```sh
./install.sh                          # 只检查（会打印 WebUI 段的状态）
./install.sh --clone-ui --install-web-deps   # 拉取 UI 仓库 + 按 lockfile npm ci
./install.sh --all                    # 全新克隆一键（含上面两项；--no-web 跳过）
```

- `--install-web-deps` 只执行 `npm ci`：**从 UI 仓库的 lockfile 安装，不新增/升级依赖，不改写 lockfile**；
  安装后若 `package.json`/`package-lock.json` 有变化会警告。
- 缺少 vendored 模块时 `./run-experiment-web.sh` **直接拒绝启动**并给出安装命令，
  而不是返回一个加载不出脚本的页面。命令行入口（`run-experiment.sh`、`--cli`）不需要这些依赖。
- UI 仓库缺失时 `install.sh` 只警告（CLI 仍可用），并提示 `--clone-ui`。

## 启动

```sh
./run-experiment-web.sh                 # 打印 URL，并在交互终端里自动打开默认浏览器
./run-experiment-web.sh --port 7801     # 换端口
./run-experiment-web.sh --no-open       # 不打开浏览器（headless/远程/脚本）
```

启动成功后打印：

```text
Aegis Web Console aegis-web-console-1
  url       http://127.0.0.1:7800
  home      /Users/you/.Aegis
  browser   opened with open
```

- 自动打开规则：`--open` 强制打开；`--no-open` 或 `AEGIS_WEBUI_NO_OPEN=1` 永不打开；
  不加参数时仅在**交互终端**（stdout 是 TTY）自动打开，后台/重定向运行只打印 URL。
  打不开浏览器只打印提示，不影响服务；cmd 覆盖仅用于测试：`AEGIS_WEBUI_OPEN_CMD`。
- **Ctrl-C 停的是整个 Web 服务及其 Host 子进程**（活动任务被关闭；结果未知的副作用保留责任，
  重新 `attach` 后按 recovery 处理）。关闭**浏览器标签页**不会停任务。

- 只绑定 loopback（`127.0.0.1`/`localhost`/`::1`），无公网 tunnel、无多用户权限体系。
- `AEGIS_HOME` 决定实验根（默认 `~/.Aegis`）。新建任务可选的工作区必须位于
  `AEGIS_HOME` 或 `AEGIS_WEBUI_WORKSPACE_ROOTS`（`:` 分隔）之内；否则创建被拒绝。
- 行的 Console 入口（`./run-experiment.sh`）与 `--cli` 兼容入口保持不变。

## 责任边界（一份权威）

```text
浏览器  →  console-web HTTP/SSE  →  每个活跃实验一个 Host 子进程
           （只读投影/控制转发）      run-experiment.sh … -- --control stdio
                                      → Experiment Host（ownership → EventLog → writer →
                                        SDK runtime/Session → recovery → dispatch）
                                      → Observer / Broker / SessionSupervisor
```

- **EventLog 是唯一事实来源。** Board/State/work-cycle/RAM/actions 全部复用现有投影；
  Web 层不写任务事件、不判定成功、不清除 hold、不改预算。
- **每个实验一个 Host 子进程。** Observer 的配置来自进程环境（EventLog 路径、策略、
  Task），同一进程里跑两个实验会串味；因此 Web 服务只做监督者，自己不创建 SDK runtime。
- **不建第二套账本。** 不使用 Pocket 的 Pi Durable/SQLite 会话机制；Web 只读取
  `event_log` 与 `run.json`，投影用 `memory/*` 现有模块。
- **唯一写入者。** Host 复用 ownership → EventLog 校验 → `bindHostEventLog` →
  SDK/Session 的顺序；第二个 writer（CLI 或另一个 Web）在创建任何 Session 之前被拒绝。
- **浏览器断开不结束任务。** 关闭标签页只断开 SSE；任务继续，重新打开按 cursor 续传。
  “Stop Host” 是显式 Host 关闭。
- 只读的 `observation/observation-server.mjs` 保持原样；本服务不挂载它的写路由。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 服务版本、`AEGIS_HOME`、实验数 |
| GET | `/api/experiments` | 实验列表（label/task/workspace/事件数/host 状态） |
| GET | `/api/models` | 从 `AEGIS_PI_AGENT_DIR` 的 `models.json`/`settings.json` 读取可选模型与默认值（只读，不读 `auth.json`） |
| GET | `/api/tools` | 可选的编码工具白名单（Aegis 控制工具始终启用） |
| POST | `/api/experiments` | 新建（`label` 必填；`workspace`/`provider`/`model`/`tools` 可选）→ `201` |
| GET | `/api/experiments/:label` | 元数据 + Host 状态 +（无 Host 时）只读视图 |
| GET | `/api/experiments/:label/view` | 五类面板 + 对话 + 文件列表；`live` 表示是否由 Host 作答 |
| POST | `/api/experiments/:label/attach` | 启动（或复用）该实验唯一的 Host 子进程 |
| POST | `/api/experiments/:label/detach` | 关闭 Host（等于 stop） |
| POST | `/api/experiments/:label/messages` | `{text, request_id}` → `202`（受理，不是成功） |
| POST | `/api/experiments/:label/pause` | 停止派发（不中止正在运行的工具） |
| POST | `/api/experiments/:label/resume` | 走现有 recovery 检查后恢复派发 |
| POST | `/api/experiments/:label/stop` | 关闭 Host；未知副作用保留责任 |
| POST | `/api/experiments/:label/attachments` | `{name, data_base64}` → 写入该实验 workspace 根目录；16 MiB 上限、不覆盖 |
| GET | `/api/experiments/:label/files?path=` | 工作区目录（有界、越界拒绝） |
| GET | `/api/experiments/:label/file?path=` | 工作区文件（≤512 KiB、二进制标记） |
| GET | `/api/experiments/:label/stream?cursor=N` | SSE：`events`/`status`/`delta`/`host`/`ping` |
| POST | `/api/requests/:request_id` | `{label}` → 从 committed receipt 解析该请求状态 |

### 身份与状态

- `experiment` = label（目录/租约身份）；`task` = `AEGIS_TASK_ID`；`episode` 由 EventLog 决定；
  `session` 是 Host 的短工作窗口。轮换 **不** 产生新实验/任务；同一 Episode 的对话连续显示，
  轮换以可展开分隔条呈现（真实 `from_session`/`to_session`/identity）。
- `console_status`：`running | settling | handoff_pending | paused | blocked | stopped`（Host 派生）。
- `host.state`：`ready | starting | conflict | unavailable | stopped`。
- `work_unit_state`：`unscoped | active | awaiting_review | awaiting_intent | complete_candidate`。
- 缺失的预算/token/成本一律 `null`/`unknown`；不填 0、不编造百分比。上下文百分比来自真实
  `agent.settled.context_usage`。

### 受理 ≠ 执行 ≠ 成功

`202` 只表示 Host 受理了请求；`receipt_status` 记录 `accepted|handled|blocked|failed`。
任务是否成功仍只由 committed Outcome（或人类/规则裁决）表达，Web 不产生 Fact/Outcome。

### 幂等、并发与未知结果

- 每个消息带客户端 `request_id`。Host 在运行前把 `accepted` receipt 写入 EventLog
  （`runtime.note kind=web.control.receipt`，对 Board/RAM 无影响）。
- 同 id + 同文本：`202 {duplicate:true}`，**不重发**；同 id + 不同文本：`409 request_id_conflict`。
- 请求已受理但 Host 崩溃/断线：状态为 unknown（receipt 停在 `accepted`），界面明确显示
  “不会自动重发”，由人决定后续。
- Host 内部串行化控制请求；两个标签页并发提交不会交错同一 Session。
- cursor 为已应用 committed 行数；服务端返回 `reset:true` 表示 cursor 失效（日志替换/截断），
  客户端必须重新拉取视图而不是推测。

### 错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `invalid_label` / `invalid_workspace` / `invalid_provider` / `invalid_model` | 400 | 参数非法 |
| `workspace_not_allowed` / `bad_origin` / `bad_host` | 403 | 越权工作区 / 跨站 / Host 头不符 |
| `exists` / `ownership_conflict` / `dispatch_paused` / `request_id_conflict` | 409 | 已存在 / 被其他 writer 持有 / 已暂停 / id 冲突 |
| `body_too_large` | 413 | 请求体超限（256 KiB） |
| `path_escape` / `absolute_path` / `not_found` | 400/404 | 文件越界或不存在 |
| `host_unavailable` | 503 | Host 未就绪（已停止/启动失败） |
| `timeout` | 504 | Host 未在期限内应答（结果未知，不回滚） |

### 安全

- 仅 loopback；校验 `Host` 头；写操作校验同源 `Origin`；无 CORS、无 GET 写、无 URL 凭据。
- 工作区路径 `realpath` 后必须仍在工作区内；`..`、绝对路径、symlink 逃逸均拒绝；文件读取有界。
- 输出按字段白名单构造并截断；不返回 `auth.json`、Cookie、密钥或完整私有日志。
- 模型/权限/预算来源仍是原配置：Host 复用 `AEGIS_PI_AGENT_DIR` 的 Pi 模型与授权，
  浏览器只能选服务端校验过的 provider/model 字符串，不能决定执行模块。

## 新建任务：模型与工具

- **模型**：下拉框来自 `/api/models`（你的 `~/.Aegis/agent/models.json`，按 provider 分组，显示 `名称 · 上下文`），默认项是 Pi 配置里的默认模型。读取不到配置时自动回退为手填 provider / 模型 id，并说明原因。
- **工具**：`read/ls/grep/find/glob`（只读）与 `bash/write/edit`（副作用，带「副作用」标记）可勾选，默认 `read,bash,edit,write`。
  - **Aegis 控制工具（`aegis_propose`/`aegis_knowledge`/`aegis_work_review`/…）始终启用**：工作单元门、复核、审计依赖它们，不能由浏览器关掉。
  - 选择结果写入 `run.json` 的 `tools`，`--resume` 时沿用；命令行也可用 `./run-experiment.sh <label> --tools read,grep …`（服务端与入口只接受白名单，未知工具直接 400）。
  - 缩小工具集只是减少模型能调用的编码工具，不改变任何授权、预算或工作流门。

## 附件上传（写入工作区）

- 对话框左侧的 **`+`** 按钮选择本地文件，上传后写入**该实验的 workspace 根目录**（`run.json` 的 `workspace`），文件面板会立即刷新；模型用普通工具就能读到它。
- 边界：单个文件 ≤ 16 MiB（base64 请求体另有 24 MiB 上限）；只接受**纯文件名**（含 `/`、`\` 或 `..` 一律 400）；不覆盖同名文件（409）；拒绝点文件开头 `.`；工作区不存在时 409。写入使用 `wx`（不改内容、不跟随已有 symlink）。
- 附件不进入 EventLog、不代表任何授权：它只是把文件放进 workspace，之后仍由工作流门/授权决定模型能否读写。
- 错误码：`invalid_attachment`（400）、`attachment_too_large`（413）、`attachment_exists` / `workspace_missing`（409）。

## 界面语言

- 默认**中文**；右上角 `EN` / `中文` 一键切换，`设置 → Language` 也可切换。切换即时生效并记住在本浏览器。
- 语言是**显示偏好**（与主题同类）：只写本机 `localStorage`（`aegis.lang`），不发给 Host、不写 EventLog、不影响任何任务状态或授权。
- 所有界面字符串走同一份词典（`web/aegis/i18n.js`，中英同键，有测试断言）；协议值（事件类型、`Intent`/`Fact`、工具名、状态与错误码原文）不翻译，只把**标签**本地化，原始值保留在 `title`/详情里。
- 后端返回的错误按 `code` 映射为中文提示；未知 code 回退服务端原文，不吞掉信息。

## 视觉与可读性

- 时间戳是卡片右上角的**小号镂空胶囊**（9.5px，描边+页面底色），贴在卡片边框上，不再压住标题或会话行；列表项不再被 flex 压缩（实验很多时也不会把 label 挤没或让时间压到边框上）。
- 每个区域用低饱和度的调色板着色区分：进度=蓝、图板=青、知识与经验=品红、Session/RAM=绿、行动=黄、文件=蓝灰；只用于区块标题的左侧细线与卡片底色的微弱混合（约 7–12%），正文仍使用统一前景色，避免刺眼。

## 面板（全部来自 committed 投影）

1. **进度**：总目标、当前 scoped Intent/工作单元、work-cycle 与 review hold、最近 review/
   checkpoint、**累计**与**本轮**两个计数（名称不同）、阻塞原因与下一步、Host 派发状态。
2. **图板**：有效 Board 投影（Origin/Fact/Refuted/Intent/Hint/Artifact）、有效性、来源与证据、
   替换关系、节点详情。
3. **知识与经验**：selection 的 `ready|no_match|unavailable|disabled`、选中卡片与来源、
   “检索命中/被选择/进入上下文/有证据的实际使用”四级区分；Experience 只显示权威状态（当前为空）。
4. **Session 与 RAM**：当前 Session、轮换历史与原因、真实 context usage；**上次 provider-bound
   RAM 只显示审计元数据（digest/sections/overflow，文本未持久化）**，与“现在重建的 RAM”分开标注；
   轮换计数标注为进程内派生，不是跨重启预算。
5. **行动与结果**：pending/unknown/rejected/completed、参数与输出摘要、provider 请求审计、
   独立 Outcome；没有“标记成功/清除 unknown/解除 hold”按钮。

## 离线开发与演示

`AEGIS_CONSOLE_PROVIDER=faux`（入口 `--provider faux --model <id>`）可用离线 faux provider；
入口另有 `AEGIS_CONSOLE_FAUX_SCRIPT=<json>`，按顺序播放脚本化的助手回复/工具调用，
**仅用于离线开发与界面演示**，真实 provider 下不会读取该文件。二者都不产生真实模型/网络调用。

## 限制

- 交互是单用户本地工具；无公网暴露、无多用户、无 Push。
- 界面目前只有中文与英文两套文案；新增文案必须同时补两种语言（`aegis-webui` 会检查键集合一致）。
- 未适配 Pocket 的多人侧聊/邀请、PiP、Agent Teams、定时任务、GitHub watches、扩展商店、
  fork/retry/worktree/浏览器等入口；这些入口在本服务下不存在，不只是隐藏。
- 前端复用 Pocket 的 `web/style.css` 设计令牌与响应式结构，但**不**运行 Pocket 的 Pi Durable
  服务端；`web/aegis/` 是 Aegis 自己的应用壳。
- 会话轮换上限/attempt 的进程内作用域见第三阶段报告，不主张跨进程保证。
