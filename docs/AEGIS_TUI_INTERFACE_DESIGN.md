# Aegis Pi TUI 接口设计

状态：**接口设计稿，待实施**。本文件只定义 Aegis 在 Pi 终端界面中的产品入口和模块契约；不实现 TUI、不修改 Pi 核心或当前扩展。本设计不替代已经存在的只读 HTTP WebUI；WebUI 作为需要查看浏览器面板时的辅助入口。

## 1. 目标与边界

Aegis 的日常交互入口仍是 Pi。用户在对话之外需要快速查看当前任务进展、已验证事实、模型提案、依赖和待处理责任；不应为了状态检查离开终端。

TUI 是已提交状态的交互式只读呈现与导航层：

- 只读数据来自当前 Observer EventLog 和现有 Board/RuntimeState/Campaign 投影，不持有第二份权威状态。
- 常规浏览和刷新不得调用模型、执行 adapter、写 EventLog 或改变授权、预算、Outcome、Experience。
- 受控操作仍由现有类型化命令负责，例如 `work-status`、`work-verify`、`work-resume`、`work-reject`、`switch`。TUI 操作若日后需要触发它们，必须显式确认并调用已验证的 Runtime 命令，不直接写日志或调用 Broker。
- `/aegis board`、`/aegis status` 等既有非交互文本行为保留，供 print/JSON/RPC 及脚本使用。只有 `ctx.mode === "tui"` 时启用自定义终端组件；其他模式返回既有文本或清晰说明。
- HTML/WebUI 保持独立辅助面板，可用于浏览器中的图表、较宽表格和历史分页；其数据仍来自同一只读 observation 源。

## 2. 使用场景和信息优先级

1. 在聊天中查看当前 Campaign/任务状态，不改变会话或运行。
2. 按依赖浏览任务图，区分父子关系与执行依赖。
3. 浏览 Board 当前视图和历史视图，识别 Fact、Refuted、Hint、Intent、Artifact、Origin 的信任类别和有效性。
4. 查看节点详情、Outcome/criterion、证据引用、截断/省略和来源身份。
5. 发现 pending、unknown、unresolved、被拒提案或审计故障，并导航到对应只读详情。
6. 结束浏览回到原对话；不隐式产生 Agent turn。

首屏突出当前控制状态、活动 Task/Episode、预算责任、审计完整性和待处理责任。统计数字需标明是 observed/committed/unknown，不能用绿色完成图标把 transport、工具 exit code 或模型声明表示成成功。

## 3. 产品表面

### 3.1 主入口

建议命令：

- `/aegis`：打开 Overview TUI；非 TUI 模式等同 `/aegis status`。
- `/aegis ui`：显式打开 TUI，与无参数入口同一实现。
- `/aegis status`、`/aegis board`、`/aegis ram`：保留既有简短文本输出，供非交互模式、复制和快速核对。

命令处理器负责确认 `ctx.mode`、加载当前已提交投影并发起 `ctx.ui.custom()`。自定义组件只在一次命令交互期间存活；关闭时完成 callback 并 dispose，不在 extension factory 创建常驻 socket、watcher、timer。

### 3.2 Overview screen

初始屏幕显示：

- Campaign ID、control state、Manifest revision/digest 摘要和 EventLog 完整性。
- 当前 Task/Episode/Session；planning/dispatch/等待外部复核状态。
- Task 与 Campaign 预算：consumed、reserved/pending、unresolved 分列；缺失值为 `unknown`。
- required criteria/依赖概览；未满足项和当前有效性原因。
- Board 各类型当前数与历史数；当前未决动作、故障和 admission 拒绝数。
- 当前 state revision 及投影时间/offset，标明数据是否 stale。

Overview 不展开展开全文图或大块 RAM；按键导航到分屏/详情。

### 3.3 Task Graph screen

任务图使用适合窄终端的缩进树/行列表，而非强制宽画布：

- 每行包含 Task ID、短目标、当前 state、dynamic/static、plan/admission 来源。
- 父子关系单独显示；depends_on 执行边另行显示，不能用树形缩进暗示依赖。
- 显示 dependency satisfied/unsatisfied/unknown、required criterion 汇总、stop/block 原因。
- 选择行进入 Task Detail；从详情浏览父任务、子任务、前置依赖和后继依赖。
- 大图分批读取；显示 total、returned、offset、truncated、下一页，以及 snapshot revision。

### 3.4 Board screen

Board 默认显示**当前有效节点**，可切到历史/全部节点。按类型过滤和文本检索：Origin、Fact、Refuted、Hint、Intent、Artifact。

每行至少显示：类型、trust/effective status、Task/Episode、简短文本、updated/source event。样式规则：

- Fact 与 Refuted 是独立判断，不与模型 Claim 混色/合并。
- Hint、Intent、round checkpoint、知识引用明确标记 `unverified`。
- superseded、downgraded、rejected、stale、unknown 保留文字状态和原因，不只靠颜色。
- 大文本显示截断标记、总长度及 readback ref；细节通过有权限的引用读取接口，不能把摘要当全文。

### 3.5 Detail screen / pane

Task Detail 显示目标、parent、dependencies、criteria、预算分配和消费、Outcome refs、当前有效性和停止原因。

Board Node Detail 显示 node/event identity、trust、effective/history、Task/Episode、来源和证据引用、criterion expected/observed、supersedes/downgrade/rejection reason、Artifact ref、长度/digest/truncation。大文本默认不展开；在获得授权和预算后分页读取。

Outcome Detail 显示合法来源、绑定对象、criterion、expected/observed、证据引用、当前 effective 与历史 supersedes。没有可解析证据或当前有效性 unknown 时明确标注。

## 4. 导航和键盘契约

按 Pi 的可配置 keybinding/UI API 实现，不硬编码与应用已有按键冲突的组合。候选默认键位如下，实施时先与 Pi 默认应用键位核对：

| 输入 | 行为 |
|---|---|
| `Esc` | 关闭 TUI overlay，返回原 Pi 对话，不发模型请求 |
| `1` / `2` / `3` | Overview / Task Graph / Board |
| `Enter` | 打开当前选中行详情 |
| `Up` / `Down` | 移动选中行；超出当前页时保持选择或提供明确继续加载 |
| `Left` / `Right` | 收起/展开图节点，或在主面板间移动 |
| `PageUp` / `PageDown` | 在有界列表中分页滚动 |
| `/` | 聚焦过滤输入；输入是纯 UI 状态，不持久化为任务事实 |
| `r` | 从 committed source 重建当前投影并刷新；不调用模型 |
| `Tab` | 在导航、过滤器、详情和操作栏的可聚焦控件间移动 |

如使用 `SelectList`/`ScrollView` 等现有组件，键盘输入应遵循 Pi 的 KeybindingsManager；鼠标只能作为可选快捷方式，所有操作必须有键盘路径。ESC/关闭无确认副作用。

## 5. 组件架构和模块接口

Pi 集成使用现有 `ctx.ui.custom()` 与 `@earendil-works/pi-tui`。不自建 ANSI renderer，不修改 Pi 核心。建议新增 Aegis-owned 模块 `Pi_Agent_base/observation/tui/`，按以下边界拆分：

```text
extension command `/aegis` / `ui`
  → createAegisTuiSession({ ctx, snapshotProvider, readPage })
  → screen model (local ephemeral selection/filter/page only)
  → Overview / TaskGraph / Board / Detail components
  → existing projectors / artifact reader
```

建议接口（精确类型在实施前冻结）：

```ts
interface AegisTuiSnapshot {
  revision: string;
  generatedAt: string | null;
  integrity: { ok: boolean | null; status: string; lastOffset: number | null };
  campaign: { id: string | null; control: string; manifestRevision: string | number | null };
  current: { taskId: string | null; episodeId: string | null; sessionId: string | null };
  budgets: { consumed: Record<string, number | null>; reserved: Record<string, number | null>; unresolved: number | null };
  counts: { tasks: Record<string, number>; board: Record<string, { current: number; history: number }> };
  pending: Array<{ id: string; kind: string; status: string; reason: string | null; taskId: string | null }>;
  health: { stale: boolean; truncated: boolean; warnings: string[] };
}

interface AegisTuiPage<T> {
  revision: string;
  items: T[];
  total: number;
  offset: number;
  limit: number;
  truncated: boolean;
  nextCursor: string | null;
  previousCursor: string | null;
}

interface AegisTuiDataSource {
  snapshot(): Promise<AegisTuiSnapshot>;
  taskPage(query: { filter?: string; status?: string; cursor?: string | null; revision: string }): Promise<AegisTuiPage<TaskRow>>;
  boardPage(query: { type?: string; scope: "current" | "history"; filter?: string; cursor?: string | null; revision: string }): Promise<AegisTuiPage<BoardRow>>;
  detail(ref: { kind: "task" | "board-node" | "outcome"; id: string; revision: string }): Promise<DetailResult>;
}
```

`AegisTuiDataSource` 应是应用内 read model adapter：直接读取 Observer 当前已提交 EventLog、冻结 Manifest，并复用 `buildObservationView`/`buildE1View`/`buildE1Explorer`/artifact reader。Pi extension command 提供当前 `ctx`、EventLog/Manifest 位置和既有 principal。不能让 TUI 直接访问文件路径或让 browser HTTP API 成为 TUI 的唯一数据通道。

数据源返回 immutable/plain data。TUI local state 仅包括 screen、selection、cursor、filter、展开状态；刷新后按 ID 恢复 selection，不保存业务事实。读页必须绑定 `revision`；如数据变化，拒绝拼接旧 cursor 和新状态，显示“状态已变化，刷新/重启浏览”并从首页重新加载。

业务类型不要在 UI 内二次解释：authority/effective 判定由现有 Campaign/Board projection 给出；UI 只格式化已判定字段。Details 的 artifact ref 通过现有 `createArtifactReader` 和 trusted principal 读取，不能直接 path read。

## 6. Pi Extension API 接线

在当前 `/aegis` command 内增加 `ui` 分支，保持既有子命令兼容：

1. `ctx.mode !== "tui"`：不调用 custom UI，返回现有状态文本或提示通过交互模式使用。
2. 从当前已打开 EventLog 重放并构建 snapshot；链损坏时仍可展示 integrity failure，但不把 projection 异常当 success。
3. 将 snapshot/read-page 函数传给 TUI controller，不把日志、Manifest、凭据对象或任意路径传入 component。
4. 通过 `ctx.ui.custom((tui, theme, keybindings, done) => component)` 呈现；主题读取 Pi 当前 theme。
5. overlay 关闭或 session shutdown 时调用 done/dispose；不创建后台 timer。手动 refresh 在 command context 可用期间重放 committed source。
6. 刷新期间禁用重复请求；数据加载失败时在 TUI 内显示 unavailable/stale，保留关闭能力。
7. no-ui 的 print/JSON/RPC 仍可用现有命令文本；不得因为新 TUI 模块 import 导致非交互模式异常。

不要求为静态只读 TUI 注册新的 model-callable tool，不改变工具白名单，不生成额外 assistant turn。

## 7. WebUI 与 TUI 的关系

- TUI：Pi 交互式主入口，面向当前任务的快速查看、导航和局部详情。
- HTTP WebUI：独立 loopback 只读面板，面向宽屏总览、长期监看和多列表浏览；不启动模型、不接控制写路由。
- 两者共享相同的只读投影契约与 state revision，但不互相 fetch，不依赖彼此运行。
- UI 状态（当前 tab/筛选/selection）各自本地维护，不写入 EventLog；可选 URL/UI 私有状态不得被误认为 task state。
- WebUI 不能作为任务 truth；TUI 也不因嵌入 Pi 而拥有额外授权。

## 8. 验收矩阵

| Case | 预期行为 | 证据 |
|---|---|---|
| TUI-01 | `/aegis ui` 在 TUI 模式打开 overlay；Esc 返回原会话；不调用模型 | real SDK + faux，provider 请求数不变 |
| TUI-02 | print/JSON/RPC 模式不创建终端组件，既有 `/aegis status/board/ram` 文本不回归 | non-TUI command tests |
| TUI-03 | Overview 展示完整性、unknown、pending/unresolved、consumed/reserved，不把 transport 当 success | 独立 snapshot fixture 与 text/render assertions |
| TUI-04 | 任务 parent 与 depends_on 分开展示，前置状态准确 | fixture → existing task graph projection → screen model |
| TUI-05 | Fact/Refuted 与 Hint/Intent/Artifact 信任标签区分；history/superseded/unknown 可见 | committed event fixture + screen-model tests |
| TUI-06 | 选择 Task/Node 展开 details，字段有界/脱敏/引用准确；unknown ref 明确拒绝 | real E1 projection + artifact-reader boundary |
| TUI-07 | 刷新生成新 revision；旧 cursor 不跨 revision 继续，selection 按 ID 恢复或清空 | deterministic revision mutation |
| TUI-08 | 80-col/窄终端、resize、宽字符、超长节点、多页和大量边不溢出/卡顿 | component render tests；Pi interactive QA |
| TUI-09 | 浏览/筛选/分页期间无 EventLog 写入、无 provider/Broker/adapter 调用 | event digest/count + counters |
| TUI-10 | 只读 WebUI 仍独立运行；TUI 不要求 HTTP server；HTML 行为变化只影响辅助面板 | HTTP existing regression + independent datasource test |

UI 组件 render test 使用 Pi TUI `visibleWidth()`/`truncateToWidth()`；实际交互按 Pi interactive-testing 流程检查 regular/fullscreen 模式和键位冲突。测试不得为了屏幕截图重写现有 Board/Authority expected。

## 9. 不在本接口设计范围内

- Pi 核心 renderer、全局 keybinding、内嵌 Pi theme 或 package API 的修改。
- 在 TUI 中直接 pause/resume/cancel/authorize、直接运行工具、人工确认 Outcome 或修改 Experience。
- 多 Campaign 控制台、多个 concurrent Episode、复杂图形画布或后台自动刷新。
- WebUI 替代 Pi 主 TUI。

若后续确要在 UI 内发起控制操作，应按独立 typed command/API 设计意图、确认、持久化、预算和恢复契约，不能在本只读浏览层顺手加入。
