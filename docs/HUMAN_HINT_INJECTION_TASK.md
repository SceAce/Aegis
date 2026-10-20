# 运行中人类 Hint 注入：任务与设计

状态：**已实现**（分支 `feat/human-hint-injection`），决策点 1–4 已经用户确认。
基线：`d916e06`（2026-10-20），分支 `feat/structured-ram-and-exploration-control`。

实现与验证记录见 §8。

## 1. 目标

用户要求：Aegis 已运行时，人类能向其注入一条提示（hint），该提示**存入图板**，并由 RAM 在**下一次 provider 请求**时带入。

失败示例（当前现状）：`run-aegis.sh` 的 `/aegis` 命令集中没有任何 hint 入口，用户只能重启会话或预置 `AEGIS_RAM_SEED_FILE`。

成功标准：

1. 运行中可写入一条 hint，立即持久化为 committed Event。
2. 下一次模型请求的 RAM 中出现该 hint，且标注为**人类来源、未验证、不授权**。
3. 该 hint 出现在图板投影（可查、可审计）中。
4. 它**不能**成为 Fact / Refuted / active Experience，**不能**授予工具权限或预算。

## 2. 现状与可复用机制（不改动部分）

| 机制 | 位置 | 现状 |
| --- | --- | --- |
| `runtime.note` reducer | `memory/state.mjs:143` | 只接受 `source.kind ∈ {runtime, human}`；已处理 `knowledge.selected`、`round.checkpoint`。**`human.hint` 会走空分支，被静默忽略** |
| Board 节点许可 | `memory/board.mjs:357` | `runtime.note` 仅在 kind ∈ {`knowledge.selected`,`round.checkpoint`} 时产生 Artifact，其余返回 `null`（不产生节点） |
| 可信来源 | `memory/board.mjs:37` | `TRUSTED_KINDS = {oracle, human}`；注意：**trusted ≠ 可创建 Fact**，仍需 `verified` + evidence + revision |
| RAM references | `memory/ram.mjs:271-299` | `registerReference` 产出 `trust:"reference"`, `verified:false`, `action_policy:"none"` |
| RAM 装配 | `memory/ram.mjs:135-159` | `seed` → `raw.external_reference`；`knowledge_selections` → `raw.knowledge`；均按 `episode_id` 过滤 |
| RAM 配额顺序 | `memory/ram.mjs:606-626` | knowledge 先预留，其后 `checkpoints/tools/proposals/external_reference` |
| 命令注册 | `extensions/aegis-observer.ts:2531` | `pi.registerCommand("aegis")`，`emit()` 已支持 `source_kind`/`episode_id` 覆盖 |
| 预置 seed | `extensions/aegis-observer.ts:271` | `AEGIS_RAM_SEED_FILE`，每请求重读；但需启动前设环境变量，且**不入图板** |

结论：**不需要新增事件类型，也不需要新增 Board 节点类型。** 沿用 `runtime.note` + `human` 来源 + Artifact 节点 + `references` 寄存器即可，符合「六类节点」与「不新增 schema」约束。

## 3. 设计

### 3.1 事件契约

新增 `runtime.note` 的 `kind: "human.hint"`：

```json
{
  "event_type": "runtime.note",
  "episode_id": "<当前 Episode>",
  "source": { "actor_id": "pi", "kind": "human", "adapter": "aegis-observer", "version": "..." },
  "payload": {
    "kind": "human.hint",
    "hint_id": "hl_<16 hex>",
    "text": "<≤1200 字符>",
    "episode_id": "<与事件层一致；用于 reducer 自校验>",
    "supersedes": "hl_<前一 hint>" | null,
    "authority": "none",
    "verified": false
  }
}
```

约束：

- `source.kind` 必须是 `human`。模型（`agent`）不得写入；`aegis_propose` 也不得伪造此 kind。
- `text` 截断到 1200 字符，与 `round_checkpoint` 的 1600 同级。
- 空文本或纯空白 = 拒绝写入（不是空 hint）。
- 同一 Episode 内后写入的 hint 覆盖先前 hint（单值语义），旧事件保留在日志中，不删除。

### 3.2 状态 reducer（`memory/state.mjs`）

在 `runtime.note` 分支内新增：

```js
if (event.payload?.kind === "human.hint" && event.episode_id) {
  state.human_hints = state.human_hints.filter((i) => i.episode_id !== event.episode_id);
  if (typeof event.payload.text === "string" && event.payload.text.trim()) {
    state.human_hints.push({ event_id, hint_id, episode_id, text: slice(0,1200), supersedes });
  }
  bump(state);
}
```

初始化 `state.human_hints = []`。

### 3.3 Board 投影（`memory/board.mjs`）

`permittedNodeType` 的 `runtime.note` 分支加入 `human.hint`，产出 `{ type: "Hint" }`。

**为什么是 Hint 而不是 Artifact**：该 note 携带用户给出的自然语言主张，与 `proposal.submitted(kind:"hint")` 同性质。Artifact 语义已用于 `knowledge.selected`/`round.checkpoint`（检索产物、轮次结论），混用会让"图板上的 Hint"与既有含义冲突。

**Hint 不产生权限**：`permittedNodeType` 只决定节点类型；Fact/Refuted 另有 `verified` + evidence + revision 门。`human.hint` 路径不经过这些门，故不可能成为 Fact。

### 3.4 RAM 注入（`memory/ram.mjs`）

新增独立来源，与 `external_reference`（文档 seed）、`knowledge`（检索）并列：

```js
const humanHints = (state.human_hints ?? [])
  .filter((i) => i.episode_id === episodeId && i.text)
  .slice(-1)                          // 单值：只带最新一条
  .map((i) => ({ human_hint: true, ...i }));
```

在 `references` 中渲染为：

```json
{
  "kind": "human_hint",
  "trust": "human_unverified",
  "verified": false,
  "action_policy": "none",
  "event": {"type":"event","id":"ev_..."},
  "hint_id": "hl_...",
  "content": "<≤450 字符>"
}
```

配额：`limits.human_hint = 1`，与 `external_reference` 同级；在 `admit` 顺序中紧随 `external_reference`（用户直接指令优先于自动召回，但不得挤占 mandatory core 与 knowledge 的既有预留）。

**关键不变量**：`action_policy: "none"` + `verified: false` 使其无法被任何授权路径读取。RAM 的 `legend` 继续声明 `references=unverified`。

### 3.5 Observer 命令（`extensions/aegis-observer.ts`）

`/aegis` 新增子命令：

- `/aegis hint <文本>` — 写入当前 Episode 的 human.hint。
- `/aegis hint clear` — 以空文本 + `supersedes` 写入，表示撤回（事件仍保留）。
- `/aegis hint` — 显示当前 Episode 的 hint 与 `hint_id`。

拒绝条件（fail-closed，返回明确原因，不静默成功）：

| 条件 | 结果 |
| --- | --- |
| 无活动 Episode（`episodeId` 为空） | 拒绝：`hint_requires_active_episode` |
| `auditUnavailable` 或 `log.healthy === false` | 拒绝：`hint_requires_healthy_audit` |
| 文本为空/纯空白 | 拒绝：`hint_text_empty` |
| 超过 1200 字符 | 截断并在通知中报告 `truncated: true` |

写入后必须 `refreshProjections()`，并通知 `hint_id` 与生效时机（"下一次请求生效"）。

### 3.6 明确不做

- 不新增 Board 节点类型、不新增 Event 类型、不改 EventLog schema 版本。
- 不把 hint 写入 Fact、不进入 `experience` 编译、不参与 Router 选择。
- 不允许模型通过工具写入 `source.kind: "human"`（检查既有 `aegis_propose` 是否已强制 runtime 来源；见 §6 待核对项）。
- 不改 Campaign 路径（`c6-entry`）的权限语义；Campaign 侧 hint 能力留作后续独立任务。
- 不替代 `AEGIS_RAM_SEED_FILE`。两者并存：seed=启动前文档预置，hint=运行中人类指令。

### 3.7 跨 Episode 隔离

`human_hint` 按 `episode_id` 过滤；新任务/新 Episode 不继承。这与 `knowledge_selections`、`round_checkpoints` 的现有语义一致，满足「另一个新用户任务不会继承它」。

## 4. 待用户确认的决策点

1. **单值 vs 多值**：本设计为单值（新 hint 覆盖旧 hint）。多值需要独立配额且可能挤占 RAM；我倾向单值。
2. **Board 节点类型**：本设计为 `Hint`。若希望在图板上与模型 Hint 区分（便于审计人类指令），可增加 `payload.origin="human"` 而不新增类型。
3. **`clear` 语义**：写空文本事件（保留审计）还是仅从 effective 视图隐藏。我倾向前者。
4. **Campaign 路径是否同期支持**：本期仅 Observer/TUI；Campaign 侧需单独评估 request/ledger 影响。

## 5. 验证计划

| # | 用例 | 类型 | 预期 |
| --- | --- | --- | --- |
| H1 | reducer：写入 human.hint → state 有 1 条，旧条被替换 | pure | `human_hints.length === 1`，`event_id` 为新事件 |
| H2 | reducer：空文本不产生条目 | pure（负例） | 长度 0 |
| H3 | reducer：非 human 来源（agent）写入被忽略 | pure（负例） | 长度 0 |
| H4 | Board：human.hint 产生 `Hint` 节点，不产生 Fact | pure | `type === "Hint"` |
| H5 | RAM：hint 出现在 `references`，`action_policy="none"`、`verified=false` | pure | 字段断言 |
| H6 | RAM：不同 `episode_id` 的 hint 不注入 | pure（隔离） | 不出现 |
| H7 | RAM：hint 不进入 facts/rules，不改变任何 permit | pure（负例） | `inspectWorkPermit` 结果不变 |
| H8 | SDK：`/aegis hint` 写入后下一次 faux provider payload 含该 hint | SDK | payload 断言 |
| H9 | SDK：无活动 Episode 时命令被拒绝且零事件写入 | SDK（fail-closed） | 事件数不变 |
| H10 | 审计不可用时命令被拒绝 | SDK（fail-closed） | 同上 |
| H11 | RAM 预算紧张时 hint 的省略被显式记录 | pure | `omitted` 计数 + 可见性 |

运行方式：`node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs <out> <name>...`，SDK 用例需 `// aegis-resolver: required`。

## 6. 实现前核对结果（已核实，基线 `d916e06`）

| # | 问题 | 核实结论 | 对设计的影响 |
| --- | --- | --- | --- |
| 1 | 模型能否伪造 human 来源 | `aegis_propose` 全部 `emit` 固定 `source_kind: "llm"`（`aegis-observer.ts` 中该工具内 6 处），`emit` 的 `source_kind` 只由扩展代码传参，工具入参无法覆盖 | **风险已消除**。无需额外校验，但 reducer 仍按 `source.kind ∈ {runtime,human}` 过滤作为第二道防线 |
| 2 | hint 能否即时生效 | `pi.on("context_with_system")` 每次请求开头调用 `refreshProjections()`（`aegis-observer.ts:936`），后者 `projectState(log.replay())` 全量重算 | **成立**。写入后下一次请求自动生效，无需额外缓存失效逻辑 |
| 3 | `RAM_VERSION` 是否需递增 | 当前 `4.0`；新增 `references` 行的 `kind` 值不改变 schema 版本语义 | **不递增**。但会改变既有 payload 快照，`aegis-ram-cache-payload` 若断言精确文本需同步调整 |
| 4 | 命令清单文档 | `docs/AEGIS_ENTRY_CAPABILITIES.md` §3.1 列出 `/aegis` 子命令 | 需追加 `hint` |
| 5 | payload 契约登记 | `docs/MEMORY_SCHEMA_NOTES.md` 已登记 `request.projected` 等 additive 扩展 | 需追加 `human.hint` |
| 6 | `human` 来源既有用例 | 仅 `campaign` C1 审计与两处 `source_kind: "human"`（observer 2754/3001，属人工确认 Outcome） | 与 hint 用途不同，**不冲突**；hint 不产生 Outcome |

## 7. 影响面

- `Pi_Agent_base/memory/state.mjs`、`board.mjs`、`ram.mjs`（小改，复用既有模式）
- `Pi_Agent_base/extensions/aegis-observer.ts`（新增命令分支）
- 新增 1 个测试脚本（H1–H7 pure）+ 1 个 SDK 脚本（H8–H10）
- 文档：`MEMORY_SCHEMA_NOTES.md`、`AEGIS_ENTRY_CAPABILITIES.md`、RAM 说明

不改：`shared/events.mjs`（无新事件类型）、`campaign/`、`execution/`、`verification/`。

## 8. 实现与验证记录

### 8.1 实际变更

| 文件 | 变更 |
| --- | --- |
| `memory/state.mjs` | `initialState().human_hints`；`runtime.note` reducer 新增 `human.hint` 分支（单值、空文本清除、1200 截断、`truncated` 标记） |
| `memory/board.mjs` | `permittedNodeType`：`human.hint` + `human` 来源 → `Hint`；空文本/非 human 返回 `null`。新增 Episode 级有效视图退役（新 hint 覆盖旧 hint，旧节点 `effective=false` / `superseded`） |
| `memory/ram.mjs` | `REGISTER_HUMAN_HINTS=1`、`SECTION_ORDER` 首位 `human_hint`、Episode 过滤装配、`registerReference` 的 `human_hint` 分支、admission 紧随 knowledge、压缩时最后丢弃 |
| `extensions/aegis-observer.ts` | `/aegis hint <text>\|clear\|show` 分支；命令描述追加 `hint` |
| `tests/aegis-human-hint.mjs` | 13 个 pure 用例（H1–H9 + H2b/H2c/H3b） |
| `tests/aegis-observer-hint-pi.mjs` | SDK 端到端用例（真实 Pi SDK + faux provider，捕获真实 provider payload） |
| `docs/MEMORY_SCHEMA_NOTES.md` | `human.hint` payload 契约 |
| `docs/AEGIS_ENTRY_CAPABILITIES.md` | 命令清单与能力说明 |

### 8.2 实现中发现的契约缺口（已修）

首版实现只做了 reducer + RAM，SDK 端到端测试暴露：`clear` 之后 hint 文本仍出现在下一次 provider payload 中。
根因不是 RAM 引用（那部分已正确清除），而是 **Board Hint 节点是历史累积的**：清除事件不产生节点，旧 Hint 节点仍在 `currentByType`，被投影进 RAM `claims`。
因此补了 Board 的 Episode 级退役规则（§8.1 第 2 行）。这也说明 H13 这类端到端用例是必要的——纯 reducer 断言无法发现该问题。

### 8.3 验证结果（本机实测）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 新增 pure 用例 | `node Pi_Agent_base/tests/aegis-human-hint.mjs` | **13 pass / 0 fail** |
| 新增 SDK 用例 | `node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-observer-hint-pi.mjs` | **ok** |
| required 清单 | `tests/helpers/run-required.sh` | **68 scripts, 0 failed** |
| 其余脚本 | `c6-suite-runner` 逐脚本 | **93 个，仅 F16 失败**（改动前既有、已授权后置） |
| 类型 | `tsc -p tsconfig.aegis.json` / `-campaign.json` | **190 / 193**，与改动前一致，无新增 |
| 格式 | `biome check --config-path=Pi_Agent_base/aegis-biome.json` | 改动文件已修复，**0 error** |

受影响回归（全部 exit 0）：`aegis-runtime-core-smoke`、`aegis-runtime-effective-board`、`aegis-ram-reaudit`、`aegis-ram-registers`、`aegis-ram-projection`、`aegis-ram-knowledge-reserve`、`aegis-ram-seed`、`aegis-memory-context-defects`、`aegis-round-checkpoint`、`aegis-ram-cache-payload`（需 resolver）。

### 8.4 已知限制

1. **仅 Observer / TUI 入口**。Campaign 路径（`campaign/c6-entry.mjs`）未接入 hint；其 request/ledger 语义需单独评估。
2. **单值语义**。只能保留一条有效 hint；多值会挤占 RAM 且需独立配额。
3. **`RAM_VERSION` 保持 `4.0`**。新增 `references` 行的 `kind` 不改变 schema 版本，但会改变 payload 快照文本。
4. **Board 退役规则只覆盖 `human.hint`**。它不改变既有 outcome `supersedes` 与 `proposal.replace_event_id` 语义。
