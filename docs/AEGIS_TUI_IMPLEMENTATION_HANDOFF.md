# Aegis TUI 实现交接：终端只读 Inspector

状态：**v1 实现中；内部定向测试通过，Pi 交互验收尚未完成**。本文同时是实现约束与当前交付记录，不是独立验收报告。下方 `DONE`、`RUNNING`、`n-42` 等视觉例子仍是 fixture，不能作为产品事实。

视觉基线：[终端版原型](aegis-tui-concept-ds.html)  
产品契约：[Aegis Pi TUI 接口设计](AEGIS_TUI_INTERFACE_DESIGN.md)  
固定规则：[开发规则](DEVELOPMENT_RULES.md) / [文档规则](AGENTS.md)  
现有命令入口：[aegis-observer.ts](../Pi_Agent_base/extensions/aegis-observer.ts)  
Pi TUI 参考：`Pi_Agent_base/pi/packages/coding-agent/docs/tui.md`、`extensions.md`、`keybindings.md`

---

## 当前实现状态（2026-10-18）

已实现于 Aegis-owned `Pi_Agent_base/observation/tui/`，使用 Pi extension 的 `ctx.ui.custom()`，未修改 renderer/editor 或消息页面：

- `/aegis` 在 TUI 模式和 `/aegis ui` 打开同一只读 Inspector；`run-aegis.sh` 默认在 `session_start` 自动打开（`AEGIS_TUI_AUTOSTART=0` 可关闭）；非 TUI 下 `ui` 分支不创建终端组件。
- Graph、Board、详情和 Evidence ladder 读取 Observer 当前 committed EventLog/Manifest 与 E1 projection；不健康 EventLog 或缺失 Manifest 不用于节点派生，Inspector 显示 `INTEGRITY UNAVAILABLE / UNKNOWN` 并保留原始日志。
- Tab/左右键切换视图，方向键选择，Enter 查看详情，PageUp/PageDown 翻页，Esc 关闭；刷新使用 Pi 可配置的 `app.aegis.inspect.refresh`（默认 F5）。
- `taskPage`/`boardPage` 复用 E1 explorer 的 revision/cursor 分页和同一 E1 view 投影；cursor 跨 revision 被拒绝。Evidence ladder 只接受 runtime/oracle/human 来源的 action 事件；action.requested 显示为 PARTIAL，不把它算成传输完成；Outcome 只从当前有效 Fact/Refuted 节点关联。
- 刷新、选择和翻页只重建只读 projection，不增加模型/API/adapter 调用路径，也没有写 EventLog 的 UI intent。
- 本轮定向测试：`aegis-tui-data-source.mjs` 5/5；`aegis-tui-render.mjs` 覆盖非 TUI 禁止 custom、overlay 关闭/刷新零写入、80/100/120/160 列 visibleWidth、源码启动 `--help` 与隔离目录。均为内部测试，不是 Pi 交互验收。
- `Pi_Agent_base/run-aegis.sh` 已提供源码启动入口；它加载 workspace source-resolver 与 Aegis Observer，并保持 Pi 配置/会话、Aegis EventLog/RAM 路径隔离。不会自动构建、安装依赖或访问网络。

当前限制：

- TUI 仍在 Pi overlay 内，不是独立聊天壳；Pi 原生 transcript/editor 保持主入口。
- Evidence 是受限的 committed 事件/Board 派生摘要，不提供独立 Oracle 运行、Outcome 写入或 artifact 原文读取。
- Graph/Board 筛选控件、完整 selection ID 恢复、Aside/三栏布局、鼠标交互、ASCII glyph fallback 和 <80×24 降级尚未实现。
- 已尝试按 Pi interactive-testing 规则运行 tmux，但当前环境没有 `tmux`（`command not found`）；真实 Pi 80×24/100×30/120×40/160×50 交互 QA 与 Esc 焦点恢复尚未验收。本轮自动测试覆盖 Observer `session_start` 自动开屏、损坏日志字节保持不变、component completion、Escape、刷新零写入，但不是终端渲染器/硬件焦点验收。
- SDK provider 请求数与真实 EventLog digest/count 无变化的产品级断言尚未运行；当前自测断言 UI 数据源没有写入接口，仍需真实 Observer EventLog 的产品级测试。
- TypeScript 新增文件已由 Pi source resolver 加载并经 esbuild 解析；Aegis 既有两个 `.mjs` 全量类型配置包含既有诊断，不能据此宣称 TUI 类型检查通过。

以上状态由当前实现与命令结果核对，不代表外部接受。后续实现必须沿用本交接的只读边界和验收矩阵，不得把这些限制写成已完成。

本轮 Pi keybinding 例外由用户明确授权：仅在随 Aegis 使用的嵌套 Pi 源码中增加 `app.aegis.inspect.refresh`（默认 F5）；没有改外部 Pi checkout，也未改 Pi renderer/editor/transcript。

## 0. 先读与实施边界

实现前必须按顺序核对：

1. 本文件。
2. [AEGIS_TUI_INTERFACE_DESIGN.md](AEGIS_TUI_INTERFACE_DESIGN.md)，尤其是 §1、§5、§6、§8。
3. 现有 `/aegis` 命令注册和只读投影：`Pi_Agent_base/extensions/aegis-observer.ts`、`Pi_Agent_base/observation/`。
4. Pi 的 `ctx.ui.custom()`、`Component`、`ScrollView`、`KeybindingsManager`、`theme.style()`、`visibleWidth()/truncateToWidth()/wrapTextWithAnsi()`。

### 0.1 本任务默认目标

本交接默认目标是 Pi extension。开工前先明确选择：

- **A. Pi overlay（默认，本文件验收对象）**：复用 Pi 的对话/编辑器，只实现 Aegis 只读 Inspector；v1。
- **B. 独立全屏终端应用（另一任务）**：宿主必须自己提供聊天/编辑器/IME/滚动；本文件只复用组件、布局、trust 和验收思想，不把 HTML 当作实现。

不要同时做 A 和 B。如果目标是独立终端应用，组件划分、列宽、trust 语义和验收矩阵仍然适用；把 `ctx.ui.custom()`、Pi theme、`KeybindingsManager` 替换为目标框架的等价物，但不要照搬 HTML/CSS/JS。

实现 **只读 Aegis Inspector overlay**：

- `/aegis ui`（或 `/aegis` 的 TUI 分支）打开一个临时自定义终端界面；
- 展示 Overview 摘要、Task Graph、Board、详情和 Evidence ladder；
- `Esc` 关闭，回到 Pi 原来的对话和编辑器；
- 浏览、筛选、翻页、刷新 projection 都不得调用模型、工具、adapter、Broker 或写 EventLog；
- 不新增 model-callable tool；
- 使用 Pi 当前 theme 和 keybindings，不自建第二套 renderer；
- 默认使用 `./Pi_Agent_base/run-aegis.sh` 源码入口；bundle 启动 `run-pi.sh` 不包含未构建的 Pi 源码 keybinding 变更；
- 本轮用户明确授权的 Pi 源码例外仅为 `packages/coding-agent/src/core/keybindings.ts` 注册 `app.aegis.inspect.refresh`；不得扩大到 renderer/editor/transcript/runtime。

### 0.2 重要：HTML 里的聊天壳不是交付范围

原型中的 **Pi 对话 transcript、composer、输入焦点、inline refs、process trace、右栏、主题切换器** 是视觉上下文，用来展示 Aegis 状态应该怎样和 Pi 对话共存。它们不是本任务要重新实现的组件。

必须复用 Pi 已有的 transcript/editor：

- 不在 extension 里重建聊天记录和输入框；
- 不替换 Pi header/footer/editor，除非另立任务并明确授权；
- 不在 Aegis overlay 内接管用户输入；
- 关闭 overlay 后，焦点回到 Pi 原来的编辑器；
- 不创建第二个 IME/cursor 实现。

如果产品决定把整个 Pi 主界面替换成原型中的“完整聊天壳”，那是**另一个产品/架构任务**，涉及 header/footer/editor 替换、transcript renderer、IME 和键位所有权，不能由本交接顺带完成。

### 0.3 不含的内容

- 不执行 `work-verify`、`work-submit`、`work-resume`、`work-reject`、授权、预算修改或提交。
- 不在 UI 中显示真实 chain-of-thought；只展示可审计的动作/观测摘要（见 §6.4）。
- 不把 HTML/CSS/JS 移植到 Pi；不引入前端框架或新依赖。
- 不把 fixture 数据写进产品路径。
- 不修改 `Pi_Agent_base/pi/` 内部仓库。

---

## 1. 视觉语言：终端能做什么

### 1.1 硬约束

| 约束 | 做法 |
|---|---|
| 字符单元格 | 所有内容按终端行/列渲染；宽度使用 `visibleWidth()`，不要用 `string.length` |
| 单一字号 | 原型所有文本统一 13.5px 只用于浏览器预览；真实 TUI 只有一个 cell 字号，层级靠 bold/dim/color/位置 |
| 无 CSS 圆角 | 用 `╭ ╮ ╰ ╯`（U+256D–U+2570）做 1 cell 圆角；字体不支持时降级为 `┌ ┐ └ ┘` 或 `+` |
| 无阴影/模糊/透明 | 用背景亮度分层；不用半透明 scrim；Inspector 使用完整 interactive area |
| 无渐变 | 如需强调，用单行纯色背景/字符条，不用 CSS gradient |
| 线宽 | 1 cell 字符线：`─ │ ├ ┤ ┬ ┴ ┼`；需要强调时用 heavy/double 变体，但保持一格 |
| 状态不只靠颜色 | 每个状态同时有文字标签：`[RUNNING]`、`[VERIFIED]`、`[PENDING]`、`UNKNOWN` |
| 宽字符 | CJK、emoji、combining marks 必须走 Pi 的宽度工具；禁止手写 `slice` |
| 字体依赖 | 不要求 Nerd Font。`◆ █ ░ ▌ ↗` 等常用 Unicode 必须有 ASCII fallback |

### 1.2 可选 ASCII 降级

提供本地设置（例如 `AEGIS_TUI_ASCII=1` 或 settings 项）：

| Unicode | ASCII fallback |
|---|---|
| `╭ ╮ ╰ ╯` | `+` |
| `─ │` | `- |` |
| `█ ░` | `# -` |
| `◆` | `*` |
| `▌` | `|` |
| `↗` | `->` |

降级模式只影响装饰，不改变状态文字或语义。

### 1.3 原型使用的视觉效果

这些效果是终端可行的，可作为实现参考：

- 软状态徽章：背景 `bg-overlay` + 状态色文字；
- 活跃状态反色：`RUNNING` 用 `pending` 背景 + `bg-app` 文字；
- 角色竖条：`▌ 你` / `▌ Aegis`；
- 标题带：header 使用 `bg-elevated`；
- 深度：master 用 `bg-panel`，detail 用 `bg-app`，aside 用 `bg-elevated`；
- 进度尺：`█░░░ 1/4`、`████░░░░ 12/40`；
- 选中行：`selection` 背景 + 左侧 accent 线；
- flex 状态：只有 active/focus 使用高对比 accent，其余用中性文字。

不要使用：

- 大块高亮背景铺满正文；
- 闪烁光标/闪烁状态（可访问性差）；
- 花哨 emoji 作为唯一图标；
- 多字号混排；
- 颜色模拟成功（transport/exit code ≠ Outcome）。

---

## 2. 信息架构与尺寸

### 2.1 Overlay 结构

```text
┌ AEGIS INSPECT · campaign · task · RUNNING · budget · pending · rev ─┐
│ INSPECT / Board / n-42      [1]Graph [2]Board [3]Evidence     Esc │
├───────────────────────────────────────────────────────────────────┤
│ master (40ch)          │ detail (flex)          │ aside (32ch)    │
│ ...                    │ ...                    │ only >=120 cols │
├───────────────────────────────────────────────────────────────────┤
│ FOCUS: INSPECTOR · PgUp/PgDn · Enter · Backspace   rev 42 · 120×40 │
└───────────────────────────────────────────────────────────────────┘
```

- Header 两行是推荐值：第一行运行态摘要，第二行面包屑 + tabs + 关闭。
- Footer 一行：焦点区、键位、revision、终端尺寸（尺寸可只在 debug/演示显示）。
- 没有聊天 transcript、没有 composer、没有主题切换器。
- 原型右侧的 context rail 不是 v1 overlay 的一部分：它的 at-a-glance 字段进入 header；完整 tasks/board/events 进入对应 tab。若要在聊天旁长期显示 rail，属于后续 widget 任务，不能和 overlay 混在一起。

### 2.2 宽度断点

| 可用列数 | Inspector | 右栏 | aside | 行为 |
|---|---|---|---|---|
| `<100` | 单栏 | 无 | 无 | master 或 detail 二选一；`showDetail=true` 时 detail 占满，`Backspace` 返回 master |
| `100–119` | 双栏 | 无 | 无 | master 40ch + detail；detail 始终可见 |
| `≥120` | 三栏 | 无 | 32ch | master 40ch + detail + trust/evidence aside |

说明：

- 列数来自组件 render width，不要用 `window.innerWidth` 或 `stdout.columns` 直接算像素。
- 80×24 必须可用：header 2 行、footer 1 行、body 其余；body 至少保留 8 行滚动区。
- 第一实现不需要完整聊天壳的 140ch reading column；该值只在可选的全屏壳/持久状态栏任务中使用。
- 所有表格/行必须 truncate，不能横向溢出；超长 ID、artifact ref、CJK 文本必须显式截断并保留 `…` 或 `truncated` 标记。

### 2.3 优先丢弃顺序

空间不足时按以下顺序隐藏/截断，不得隐藏状态语义：

1. campaign / episode / session / model；
2. revision / integrity 文本；
3. 非当前 tab 的次要说明；
4. aside 的 Recent；
5. master 行的 meta。

**始终保留**：task + task state、pending/unresolved、预算、当前 tab、当前 selection、Esc/返回路径。

### 2.4 Header 摘要字段

第一行（从左到右，按可用宽度截断）：

- `AEGIS INSPECT`；
- campaign ID；
- 当前 task + task state；
- pending / unresolved；
- budget consumed / reserved（缺失为 `unknown`）；
- revision + integrity 状态。

第二行：

- 面包屑：`INSPECT / <tab> / <selection-id>`；
- tabs：`[1]Graph [2]Board [3]Evidence`；
- `Esc 关闭`。

80×24 时优先保留 task/state、pending、unresolved、budget、tabs 和关闭路径；campaign、revision、integrity 可先省略。Header 不展示成功图标；`integrity OK` 只是 EventLog 完整性，不是任务 Outcome。

### 2.5 三屏内容

**Graph**

- `parent/child` 树：Task ID、目标摘要、state、dynamic/static、来源；
- `depends_on` 单独列出，附 satisfied/unsatisfied/unknown；
- detail：state、episode/session、parent、children、depends_on、criterion、budget、source；
- `showDetail` 仅窄屏使用；宽屏 master/detail 同时可见。

**Board**

- 分组：独立判定（Fact/Refuted）、模型提案（Hint/Intent）、观测/运行（Artifact/Budget）、待处理/边界（Pending/Rejected）；
- 每行：类型、trust/effective、Task/Episode、短文本、source/updated；
- detail：node/event identity、trust、effective、task、revision、source、criterion、readback、supersedes、ladder position、原因/备注；
- 大文本默认折叠，显示长度/digest/truncation，不把摘要当全文。

**Evidence**

- 四步 ladder：transport / observation / independent check / outcome；
- 每步状态：`DONE` / `PARTIAL` / `NOT RUN`，并说明只证明了什么；
- Trust boundary：transport ≠ task passed；模型声明不推进 ladder；Fact 不是 Outcome；
- Criterion coverage：fields、boundary、overall、outcome；
- Recent committed events（只读）；
- 不提供提交、授权、预算修改、Oracle 执行按钮。

---

## 3. 组件与文件建议

建议在 `Pi_Agent_base/observation/tui/` 新建 Aegis-owned 模块：

```text
Pi_Agent_base/observation/tui/
  index.ts                 # createAegisTuiSession / public exports
  session.ts               # ctx.ui.custom 适配、生命周期、focus
  data-source.ts           # AegisTuiDataSource 的 read-model adapter
  model.ts                 # 纯 view model（TaskRow/BoardRow/Detail/EvidenceStep）
  theme.ts                 # Pi theme token 映射和 fallback
  glyphs.ts                # Unicode/ASCII 边框、meter、标记
  components/
    screen.ts              # 总布局、宽度断点
    header.ts              # runtime summary + tabs + breadcrumb
    inspector.ts           # tab 路由、master/detail/aside 组合
    graph-view.ts
    board-view.ts
    evidence-view.ts
    detail-pane.ts
    status-badge.ts
    meter.ts
    footer.ts
```

修改 `Pi_Agent_base/extensions/aegis-observer.ts` 仅做：

- 在现有 `pi.registerCommand("aegis")` 中增加 `ui` 分支；
- 仅当 `ctx.mode === "tui"` 时调用 `ctx.ui.custom()`；
- 非 TUI 模式继续使用现有 `status/board/tasks` 文本行为；
- 不改变现有子命令语义，不新增后台 socket/timer/watcher。

### 3.1 Command wiring

现有 `/aegis` 命令在 `Pi_Agent_base/extensions/aegis-observer.ts` 的 switch 中扩展，保留所有旧子命令：

```ts
case "ui": {
  if (ctx.mode !== "tui") {
    notify("/aegis ui requires interactive TUI mode");
    return;
  }
  await ensureLog(ctx);
  refreshProjections();
  // 从当前 committed log/manifest 构建只读 snapshot/page/detail closures。
  // 不把 log、manifest、路径或凭据传进 component。
  const session = createAegisTuiSession({
    ctx,
    snapshot: () => buildSnapshotForTui(...),
    taskPage: (query) => readTaskPage(...),
    boardPage: (query) => readBoardPage(...),
    detail: (ref) => readDetail(...),
  });
  await session.open(); // 内部调用 ctx.ui.custom；Esc 时 done()
  return;
}
```

- `ctx.ui.custom()` 返回的 completion 必须被处理；Esc/关闭调用 `done()`，dispose 组件。
- 如果当前 Pi 版本不支持所需的自适应 overlay 尺寸，先按其实际 API 实现，并在测试中记录限制；不要自行重写 renderer 或替换 header/footer。
- 读取失败时仍可打开只读错误屏（integrity unavailable/stale），保留 Esc。
- 不在组件内直接调用 `log.replay()`；由 datasource/session 负责，组件只接收 DTO。

### 3.2 组件接口

```ts
type InspectorTab = "graph" | "board" | "evidence";

type NodeRef = {
  kind: "task" | "board-node" | "outcome";
  id: string;
  revision: string;
};

type FocusZone = "header" | "master" | "detail" | "aside" | "footer";

interface AegisTuiUiState {
  tab: InspectorTab;
  taskId: string | null;
  nodeId: string | null;
  showDetail: boolean;       // <100 cols 时有效
  selectedLine: number;      // 当前 pane 内的可见 selection
  scroll: { master: number; detail: number; aside: number };
  expanded: Set<string>;     // tool/trace/detail 的本地展开 key
  focus: FocusZone;
  revision: string;
}
```

- `AegisTuiUiState` 只存活于一次 `ctx.ui.custom()` 交互；关闭即丢弃。
- 不写 EventLog、文件、localStorage、全局 store。
- 不保存业务事实；selection 只保存 ID，不保存节点内容。
- 刷新后按 ID 恢复 selection；若 ID 不存在，清空 selection 并显示 “state changed”，不要沿用旧 cursor。

### 3.3 组件职责

| 组件 | 输入 | 输出/回调 | 禁止 |
|---|---|---|---|
| `Screen` | snapshot、state、theme、width | 行数组 | 访问文件/网络 |
| `Header` | campaign/task/state/pending/budget/rev | tab/close intents | 改写状态 |
| `GraphView` | queued task rows、edges | select task/detail | 把 parent 当 depends_on |
| `BoardView` | board rows、type/trust/effective | select node/detail | 把 Hint 当 Fact |
| `EvidenceView` | evidence steps、criterion、outcome | open task/board ref | 生成 Outcome 或调用 Oracle |
| `DetailPane` | detail DTO | 只读展示、ref navigation | 读取任意路径 |
| `Aside` | task ladder、boundary、refs、recent | navigation | 复制一份权威状态 |
| `Footer` | focus、keymap、revision、size | 仅提示 | 修改预算/授权 |

所有交互都通过只读 intent：

```ts
type TuiIntent =
  | { type: "open"; ref: NodeRef }
  | { type: "select-task"; taskId: string }
  | { type: "select-node"; nodeId: string }
  | { type: "set-tab"; tab: InspectorTab }
  | { type: "back" }
  | { type: "close" };
```

没有 `submit`、`authorize`、`resume`、`reject`、`set-budget` 等 intent。

---

## 4. 数据接口与 truth 边界

### 4.1 DataSource

沿用 [接口设计 §5](AEGIS_TUI_INTERFACE_DESIGN.md) 的：

```ts
interface AegisTuiDataSource {
  snapshot(): Promise<AegisTuiSnapshot>;
  taskPage(query: { filter?: string; status?: string; cursor?: string | null; revision: string }): Promise<AegisTuiPage<TaskRow>>;
  boardPage(query: { type?: string; scope: "current" | "history"; filter?: string; cursor?: string | null; revision: string }): Promise<AegisTuiPage<BoardRow>>;
  detail(ref: { kind: "task" | "board-node" | "outcome"; id: string; revision: string }): Promise<DetailResult>;
}
```

要求：

- 直接读取当前 committed EventLog、冻结 Manifest，复用 `buildObservationView` / `buildE1View` / `buildE1Explorer` / artifact reader。
- 组件只接收 immutable/plain DTO；不能接收日志对象、Manifest、凭据或任意文件路径。
- 每页绑定 `revision`；旧 cursor 不得跨 revision 拼接。
- 失败/不可用要显示 `unavailable/stale/unknown`，不能显示 0 或成功。
- `detail` 的 artifact ref 走现有 `createArtifactReader` 和 trusted principal。

### 4.2 原型 fixture → 生产数据

| 原型内容 | 生产来源 | 约束 |
|---|---|---|
| `TASKS` / `EDGES` | E1 task graph / task lifecycle | parent 与 depends_on 分开 |
| Board 分组 | Board 当前/历史 projection | Fact/Refuted 是独立判定 |
| Hint/Intent | 模型提案 | 永不进入 Fact 或 Outcome |
| Artifact | action/observation | transport/read 只到 observation |
| Pending/Rejected | pending / admission | Rejected 是策略拒绝，不是工具错误 |
| Evidence ladder | 从 action/observation/judgment/outcome 派生 | 不新增持久化状态，不自行宣布成功 |
| budget 12/40 | budget projection | 缺失为 `unknown`，不补 0 |
| Event stream | committed events | 只读；不做本地合并 |
| process trace | 可审计 action/observation 摘要 | 不显示 raw CoT；标为“过程，非证据” |

### 4.3 关键语义

实现必须保持以下区分，不能只靠颜色：

- **transport / exit code**：只说明调用/传输完成。
- **observation / artifact**：只说明读取或记录成功。
- **independent check / Fact / Refuted**：独立判定；Refuted 是有效负向判定，不是运行错误。
- **Rejected**：admission/边界策略拒绝，不是工具故障。
- **Pending**：责任未结清。
- **Outcome**：独立验收结果；没有时显示 `NONE/UNKNOWN`。
- **Hint / Intent**：模型声明，`UNVERIFIED`，不能推进 ladder。
- **Verification ladder**：`TRANSPORT → OBSERVATION → INDEPENDENT CHECK → OUTCOME`；每一步都要写“只证明了什么”和“尚未证明什么”。

### 4.4 Counts

`JUDGED / PENDING / UNRESOLVED / BUDGET` 必须来自 snapshot 聚合，不能写死：

- 原型的 `JUDGED 3`、`PENDING 2`、`UNRESOLVED 0`、`BUDGET 12/40` 只是 fixture；
- 若 projection 不可用，显示 `unknown`；
- 不能把 transport 成功计为 verified/outcome。

---

## 5. 主题与颜色

### 5.1 生产集成

首选：使用 Pi 当前 theme；Aegis Iron 作为默认 Aegis theme preset。四套原型色是视觉参考：

- A Tokyo Night
- B Catppuccin Mocha
- C One Dark
- D Aegis Iron（推荐默认）

**不要**在发布版 TUI 中放原型底部的 `[A][B][C][D]` 主题切换器。它属于 demo shell，会绕过 Pi theme 配置。若产品确实要四套主题，应作为 Pi theme preset/配置选择，不在只读 Inspector 内提供设置写入。

### 5.2 语义 token

| token | 用途 |
|---|---|
| `bg-app` | 页面/终端背景 |
| `bg-panel` | inline 表面、header、rail |
| `bg-elevated` | 选中框/徽章/深度层 |
| `bg-overlay` | 徽章背景（**不是透明度**） |
| `border` / `border-soft` | 面板/分隔线 |
| `border-focus` | 当前焦点/Inspector 边框 |
| `text` / `text-secondary` / `text-dim` | 三层正文 |
| `accent` | focus、active tab、选中行、meter |
| `selection-bg` | selection/active row |
| `user` / `user-bg` | 用户消息身份/背景块 |
| `assistant` | 助手身份 |
| `tool-bg` | tool 区块 |
| `verified` | verified / Fact / DONE |
| `pending` | pending / required / partial |
| `error` | tool error / error state |
| `proposal` | Hint / Intent / model proposal |
| `refuted` | Refuted（负向独立判定） |

### 5.3 原型色值

| token | Tokyo Night | Catppuccin Mocha | One Dark | Aegis Iron |
|---|---|---|---|---|
| `--bg-app` | #1a1b26 | #1e1e2e | #282c34 | #14171a |
| `--bg-panel` | #16161e | #181825 | #21252b | #191d21 |
| `--bg-elevated` | #1f2335 | #262637 | #2c313a | #20252a |
| `--bg-overlay` | #1b1e2c | #222233 | #24282f | #1b2024 |
| `--border` | #30364a | #3e3e57 | #3e4451 | #333a40 |
| `--border-soft` | #262b3b | #2c2c3f | #333842 | #262c31 |
| `--border-focus` | #7aa2f7 | #b4befe | #61afef | #e6b566 |
| `--text` | #c8d3f5 | #cdd6f4 | #b3bac6 | #d8dbd8 |
| `--text-secondary` | #a9b1d6 | #b6bfdc | #9aa4b2 | #b0b6b4 |
| `--text-dim` | #878fbb | #939cc0 | #929cab | #8b938f |
| `--accent` | #7aa2f7 | #89b4fa | #61afef | #e6b566 |
| `--selection-bg` | #2c3557 | #343a5c | #3a4150 | #3a3327 |
| `--user` | #73daca | #94e2d5 | #56b6c2 | #8ab4d8 |
| `--user-bg` | #1c2a35 | #262c40 | #2a323c | #212a31 |
| `--assistant` | #7aa2f7 | #89b4fa | #61afef | #e6b566 |
| `--tool-bg` | #1e2030 | #232336 | #23272e | #1d2126 |
| `--verified` | #9ece6a | #a6e3a1 | #98c379 | #93b98a |
| `--pending` | #e0af68 | #f9e2af | #e5c07b | #d98f5a |
| `--error` | #f7768e | #f38ba8 | #e68992 | #d9746a |
| `--proposal` | #bb9af7 | #cba6f7 | #c678dd | #b7a6e0 |
| `--refuted` | #e0a0a8 | #e7a0b4 | #d99aa1 | #c99a86 |

映射到 Pi 时优先使用 `theme.style({ fg, bg, bold })`；颜色 token 需转换为具体 `Color` 时使用 `theme.colors`，并让 Pi 根据终端能力降级到 256 色/真彩。不要永久缓存带 ANSI 的字符串；`invalidate()` 重建。

### 5.4 对比度下限

原型实测（正文/背景、次级/面板、弱化/面板、状态/徽章背景）：

- 正文 ≥ 7.17:1；
- 用户背景块正文 ≥ 6.64:1；
- 次级 ≥ 6.10:1；
- 弱化 ≥ 5.38:1；
- 状态徽章文字 ≥ 5.02:1。

实现测试至少要求小字号状态文字 ≥ 4.5:1；正文建议 ≥ 7:1。颜色变更或 Pi theme 映射后重新计算。

---

## 6. 交互与状态机

### 6.1 键位（候选）

实施前必须与 Pi `KeybindingsManager` 核对冲突，不能硬编码；以下是产品候选默认：

| 输入 | 行为 |
|---|---|
| `Esc` | 关闭 Inspector；焦点回到 Pi 原编辑器；不发送模型请求 |
| `Ctrl+I` | 打开 Inspector（Graph）；注意部分终端把 Ctrl+I 当作 Tab，实施前必须验证或改用可配置 keybinding |
| `1` / `2` / `3` | Inspector 内切换 Graph / Board / Evidence |
| `Enter` | 在 master 行打开 detail；在按钮上执行当前只读动作 |
| `Backspace` | 窄屏 detail 返回 master；宽屏无副作用或同样回到 master |
| `Up` / `Down` | 移动 selection；不跨过页边界时保持可见 |
| `PageUp` / `PageDown` | 有界滚动/分页；显示 page/total |
| `Tab` / `Shift+Tab` | 在 header、master、detail、aside、footer 间移动焦点 |
| 鼠标 | 仅 fullscreen 可选；不是唯一路径 |

- 输入框/编辑器内的数字和字母必须按原生输入处理；只响应显式 modifier 组合。
- 不允许 `q` 退出、单字母全局快捷键，除非先通过 Pi keybinding 注册。
- `Esc` 只关闭 overlay，不触发任何 Aegis 命令。
- 关闭后调用 `done()`/dispose；不保留背景 timer。

### 6.2 焦点

- overlay 打开时焦点进入 Inspector；关闭时回到 Pi 编辑器。
- 窄屏 detail 返回 master 后焦点回到原行。
- 刷新后按 ID 恢复 selection；找不到则清空并提示 `state changed`。
- 不使用 `CURSOR_MARKER`，除非 overlay 内有文本输入；如果没有输入，不要把硬件 cursor 放进只读列表。
- 如果后续加入 filter 输入，使用 Pi `Input`/`Editor`，传播 `focused`，并放置 `CURSOR_MARKER` 以支持 IME。

### 6.3 鼠标

- 只在 fullscreen 模式通过 `MouseRegion`/handle 提供点击；
- 所有点击都有键盘等价路径；
- 点击 scrim/外部关闭与 Esc 一致；
- regular mode 不劫持终端 scrollback；
- 鼠标 hover 不是设计依赖。

### 6.4 思考/过程展示

不要在聊天中显示 raw chain-of-thought。若实现过程摘要：

- 默认折叠为一行：`▸ 过程记录 · 3 steps · 非证据`；
- 展开只显示 `plan / act / check`（动作、观测、等待），不显示自由推理；
- 明确标记 `非证据`；
- 不能把过程摘要当成 Fact、criterion 或 Outcome；
- 若没有可审计事件，直接省略，不编造。

原型中的 trace 只是交互示例，不是 backend 数据契约。v1 的 Aegis overlay 不包含聊天输入，也不应重造 Pi 的 thinking/tool 渲染；如果要把它接入 Pi 对话，属于单独的 message renderer 任务。

---

## 7. 渲染与性能

### 7.1 行数组

- 组件 `render(width): string[]` 的每一行都必须 `visibleWidth(line) <= width`。
- 使用 `truncateToWidth()` 保留语义前缀；长 artifact/ref 中间截断或尾部 `…`，并保留 `truncated` 标记。
- 使用 `wrapTextWithAnsi()` 处理 CJK/emoji/ANSI/combining marks；不要用 `slice()`。
- 每行结尾重置样式；跨行样式重新应用（Pi 会在每行后重置）。
- 边框、背景、selection 必须覆盖整行到 `width`，避免半行背景块。
- 80 列时必须保证 header/footer 不折行；宁可截断字段，不可让正文溢出。
- 表格列宽按字符列计算；CJK 占 2 列。

### 7.2 缓存与刷新

- 缓存 key 至少包含 `width`、`revision`、`tab`、`selection`、`theme`。
- `invalidate()` 清空所有 width/theme 相关缓存。
- 状态变化后调用 `tui.requestRender()`。
- 不要每个 tick 重放 EventLog；刷新只由明确 intent 触发，或由现有 projection 更新信号触发。
- 不在 extension factory 创建常驻 socket/watcher/timer。

### 7.3 布局高度

- header 2 行推荐；footer 1 行；body 为剩余行。
- 80×24 最小验证：header 2、footer 1、body 21（含 frame）；body 滚动区至少 8 行。
- 列表分页/滚动必须有可见的 `total/returned/offset/truncated` 或滚动位置。
- 大列表按页读取；禁止一次 render 全量无界 Board/EventLog。

### 7.4 颜色与 ANSI

- 真彩/256 色由 Pi 处理；不要在 UI 内自行发 ANSI 转义。
- 背景块和反色必须保留文字标签；不能只用颜色。
- 主题变化后重新计算 concrete colors；不缓存旧 ANSI。
- 暗色主题为主；若 Pi 主题为 light，需按 `theme.appearance` 调整背景深度，不能假设永远是暗色。

---

## 8. 验收矩阵

### 8.1 终端/布局

| ID | 场景 | 预期 | 证据 |
|---|---|---|---|
| TUI-V01 | 80×24 | 无横向溢出；header/footer 各 1–2 行；body 可滚动；Esc 可见 | render assertions |
| TUI-V02 | 100×30 | 双栏：master 40ch + detail；无 aside | 宽度断言 |
| TUI-V03 | 120×40 | 三栏：master 40 + detail + aside 32 | 宽度断言 |
| TUI-V04 | 160×50 | master 40ch/aside 32ch 固定；detail 使用剩余宽度；不输出超宽行 | 宽度断言 |
| TUI-V05 | CJK/emoji/combining | 所有行 `visibleWidth <= width`；截断标记正确 | width fixtures |
| TUI-V06 | 超长 ID/ref | 不撑破布局；保留可读前缀和 truncated | fixture |
| TUI-V07 | resize | 断点重排；selection 按 ID 恢复；焦点不丢 | resize test |

### 8.2 信息与 trust

| ID | 场景 | 预期 |
|---|---|---|
| TUI-V08 | transport ok | 只显示 observation/transport，不显示 task passed |
| TUI-V09 | Fact vs Refuted | 独立判定；Refuted 不是 error |
| TUI-V10 | Hint/Intent | `UNVERIFIED`，不进入 Fact/Outcome |
| TUI-V11 | Rejected | 显示策略原因，不是工具故障 |
| TUI-V12 | Outcome missing | 显示 `NONE/UNKNOWN`，不显示绿色成功 |
| TUI-V13 | 颜色被移除 | 所有状态仍有文字标签 |
| TUI-V14 | projection unavailable/stale | 显示 unavailable/stale；不显示 0 或成功 |

### 8.3 交互与生命周期

| ID | 场景 | 预期 |
|---|---|---|
| TUI-V15 | 打开/关闭 | `ctx.ui.custom()` 一次交互；Esc 关闭并返回 Pi 编辑器；无 model turn |
| TUI-V16 | 1/2/3 | 仅 Inspector 获得输入时切换 tab；普通输入不触发 |
| TUI-V17 | detail/back | 窄屏返回 master；宽屏详情保持可见 |
| TUI-V18 | selection/refresh | 按 ID 恢复；revision 变化时拒绝旧 cursor |
| TUI-V19 | mouse（可选） | 点击有键盘等价；不产生副作用 |
| TUI-V20 | IME（若加入 filter/input） | CURSOR_MARKER 正确；候选窗不偏移 |

### 8.4 无副作用

| ID | 场景 | 预期 |
|---|---|---|
| TUI-V21 | 浏览/筛选/翻页 | EventLog 无写入；provider/Broker/adapter 调用数不变 |
| TUI-V22 | 刷新 | 只重放 committed source；不调用模型/工具 |
| TUI-V23 | 关闭/异常 | 不遗留 timer/socket；UI 失败不阻塞 Host |
| TUI-V24 | 非 TUI 模式 | 不创建组件；现有 `/aegis status/board/tasks` 文本不回归 |

补充执行接口设计里已有的 TUI-01…TUI-10；本文件不替代那些契约。

### 8.5 测试方式

- 组件/行数组：纯 Node 单元测试，固定 `width`、fixture snapshot，使用 `visibleWidth`/`truncateToWidth` 断言；不要只断言 `ok`。
- SDK 集成：真实 Pi SDK + faux provider；断言 provider 请求数不变、EventLog digest/count 不变。
- 目录变更后：`node Pi_Agent_base/tests/aegis-module-layout.mjs`。
- 静态检查：`Pi_Agent_base/aegis-biome.json`；类型检查使用 `Pi_Agent_base/tsconfig.aegis.json` / `Pi_Agent_base/tsconfig.aegis-campaign.json`。
- SDK 命令示例：`node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/<name>.mjs`。
- 未执行的测试不能写成通过；记录真实退出码、失败基线和限制。

---

## 9. 实施顺序与停止条件

### 9.1 顺序

1. **只读 data source**：snapshot/page/detail，复用现有 projection；写 fixture 测试。
2. **布局/字符基础**：frame、truncate/wrap、CJK、80/100/120 断点、theme mapping。
3. **Inspector shell**：header、tabs、master/detail、Esc/focus。
4. **Graph**：parent/child 与 depends_on 分开；selection/detail。
5. **Board**：trust 分组、provenance、criterion coverage。
6. **Evidence**：四步 ladder、boundary、coverage、refs。
7. **分页/刷新/revision**：旧 cursor 拒绝、selection 恢复。
8. **测试/QA**：80×24、100×30、120×40、160×50、主题、CJK、resize、无副作用。
9. **文档**：更新接口设计和 runbook（如需要）。

### 9.2 停止条件

出现以下情况必须停下并报告，不得临时扩大范围：

- 需要修改 Pi 核心、替换 editor/header/footer；
- 需要新依赖、网络或真实模型；
- 需要写入 EventLog/授权/预算；
- `ctx.ui.custom()` 生命周期/timer 方案不明确；
- 80×24 无法保证 Pi 编辑器返回/关闭路径；
- 需要 raw CoT 或不可验证的“成功”数据；
- 现有 keybinding 冲突无法用配置解决。

---

## 10. 风险与待决策

1. **Overlay vs 完整聊天壳**：本文默认只读 overlay；完整壳需要单独授权。
2. **Overview tab**：本文采用 header 摘要 + Graph/Board/Evidence 三个 tab；若保留接口设计的 Overview tab，需重新定义键位，避免第四个重复面板。
3. **四套主题**：作为 Pi theme presets，不做运行时主题切换器。
4. **持久状态栏/右栏**：若要在聊天旁长期显示，使用 `ctx.ui.setWidget`/footer 的独立任务；不重建聊天。
5. **字体 glyph**：`╭ ╮ ╰ ╯ ◆ █ ░` 可能缺失；提供 ASCII fallback，不依赖 Nerd Font。
6. **高度**：80×24 是硬性最小；低于 24 行需要明确降级，不要挤掉关闭路径。
7. **刷新**：手动刷新/现有 projection 信号；不增加后台轮询。
8. **过滤/搜索**：原型没有实现；如加入，使用 Pi `Input` 和 `CURSOR_MARKER`，并与 keybinding 核对。
9. **鼠标**：只在 fullscreen 可选；键盘必须完整。
10. **主题 light 模式**：不要假设暗色；按 `theme.appearance` 调整背景层级。

---

## 11. 原型 fixture 参考（仅测试）

这些值只用于对齐视觉/交互 fixture，禁止直接进入生产 DTO：

- Tasks：`planning DONE`、`verify-input RUNNING`、`parse READY`、`submit UNKNOWN`；4 tasks，`1/4` 完成。
- Edges：`planning → verify-input satisfied`；`verify-input → parse unsatisfied`；`parse → submit unknown`；`oracle → submit required`。
- Board：10 节点，分组为独立判定 3、模型提案 2、观测/运行 2、待处理/边界 3；`JUDGED 3`、`PENDING 2`、`UNRESOLVED 0`、`BUDGET 12/40`。
- Evidence ladder：transport DONE、observation DONE、independent check PARTIAL、outcome NOT RUN。
- 过程记录：3 steps，默认折叠，标签 `非证据`。
- 主题：A Tokyo Night / B Catppuccin Mocha / C One Dark / D Aegis Iron；默认推荐 D。

这些 fixture 不能覆盖真实 projection 的 `unknown`、stale、truncated、missing evidence；实现必须单独测试这些状态。

---

## 12. 交付定义（Definition of Done）

- `/aegis ui` 在 TUI 模式打开只读 Inspector，Esc 返回 Pi 编辑器；
- 80×24、100×30、120×40、160×50 无横向溢出，关闭路径始终可见；
- Graph/Board/Evidence/详情全部来自 committed projection，含 revision、truncated、unknown/stale；
- transport/observation/verification/outcome 语义严格分离；
- 四套主题可映射到 Pi theme（若产品要求），颜色非唯一状态表达；
- 所有交互有键盘路径；输入不劫持普通字符；
- 浏览/刷新/翻页无 EventLog 写入、无模型/工具/Broker/adapter 调用；
- 组件 render tests + SDK 集成测试 + 无副作用断言；
- 文档更新，明确未实现项和限制；
- 不修改 Pi renderer/editor/transcript/runtime；仅允许本轮授权的 `app.aegis.inspect.refresh` keybinding 注册；不新增 model-callable tool，不提交凭据或私有数据。

---

## 附录 A：原型 → 实现组件映射

| 原型 | 实现 |
|---|---|
| `.chat-panel` / transcript / composer | **不实现**；这是 Pi 现有对话/编辑器的视觉上下文 |
| `.rail` | 可选持久 widget（另立任务）；v1 用 Inspector header 摘要 |
| `.inspector-frame` | `ctx.ui.custom()` 的 Inspector 容器 |
| `.inspector-head` | `Header` 两行：summary + tabs/breadcrumb/close |
| `renderGraph` | `GraphView` + `DetailPane` |
| `renderBoard` | `BoardView` + `DetailPane` |
| `renderEvidence` | `EvidenceView` |
| `inspectorAside` | `Aside`（仅 ≥120 列） |
| `.chip` | `StatusBadge`（文字 + 背景/反色；非颜色唯一） |
| `.meter` | `Meter`（`█░`，带 ASCII fallback） |
| `.corner` | frame 的 `╭╮╰╯` 字符；不用 CSS |
| `.trace` | 可选 process summary（后续 Pi message/audit 视图）；v1 不重造聊天；默认折叠；标记非证据 |
| `inline-ref` | 若后续实现 Pi message renderer 再接；v1 不重造 transcript |

## 附录 B：建议的首次实现范围

先交付 **v1**：

- Inspector shell；
- Graph/Board/Evidence/Detail；
- header 摘要、footer、80/100/120 断点；
- 只读 data source；
- 键盘/focus/Esc；
- 80×24/100×30/120×40 测试；
- Pi theme 映射。

暂不交付：

- 完整聊天壳、composer、inline refs、持久 rail、主题切换器、鼠标 hover、Board 搜索/过滤、后台刷新、Nerd Font 图标。

这样可以在不破坏 Pi 主交互和 IME/键位的前提下，先交付当前视觉设计真正可落地的部分。
