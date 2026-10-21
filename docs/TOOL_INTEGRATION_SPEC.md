# 脚本动作接入规范（供 Agent 执行）

> 适用于**需要固定 argv + 独立 Oracle** 的技法脚本。通用 CLI 的能力登记见
> [工具能力清单](TOOL_CATALOG.md)——那里不锁 argv，模型自己拼参数。

状态：**当前有效**。本文件是给**其他 Agent** 的操作规范：按此产出 recipe，即可让 Aegis 的模型
发现并调用一个工具。实现与契约见 [工具接入](TOOL_REGISTRATION.md)。

## 0. 你（Agent）要交付什么

一个**通过校验的 recipe 文件**。不是代码、不是文档、不是口头结论。

```bash
node aegis-register-tool.mjs --validate <recipe.json>
# 退出码 0 且打印 "valid: <id>@<version>" 才算完成
```

不要用 `--dry-run` 冒充验证通过，也不要在未通过时声称"已接入"。

## 1. 三条硬规则（违反即不可接入）

| 规则 | 原因 |
| --- | --- |
| **不能登记 shell**（`sh`/`bash`/`zsh`/…） | 等价于开放任意命令 |
| **不能出现 eval token**（`-e`/`--eval`/`-c`/`--command`）或 shell 元字符（`;` `\|` `&` `` ` ``） | 同上 |
| **Oracle 必须重读磁盘状态** | stdout / 退出码由被检查方提供，不能作为证据 |

推论：**工具必须能把结论写成文件**。只能打印到 stdout 的工具，需要一层薄包装脚本落盘。

## 2. 流程

```bash
# 1) 侦察：路径 → 事实（realpath、类型、digest、--version）
node aegis-register-tool.mjs --probe /path/to/tool --out draft.json

# 2a) 或者：给一条你平时怎么跑的样本命令，让它推断 argv/参数/Oracle
node aegis-register-tool.mjs --scaffold /path/to/tool --sample "<args>" --out draft.json

# 2b) 或手工补全 draft：argv / parameters / verify
$EDITOR draft.json

# 3) 校验，循环到通过
node aegis-register-tool.mjs --validate draft.json

# 4) 写入 roster
node aegis-register-tool.mjs --recipe draft.json --roster ~/.Aegis/tools/roster.json

# 5) 确认模型可见
node aegis-register-tool.mjs --list --roster ~/.Aegis/tools/roster.json
```

`--probe` 只报告可观测事实，**不会**替你猜 argv 或 Oracle。猜错的 registration 看起来能用，
实际会在运行时报 precondition 不符 —— 这比接入失败更糟。

## 3. recipe 字段

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `id` | 是 | `[A-Za-z0-9][A-Za-z0-9._-]*`，全局唯一（同名同 version 为替换） |
| `version` | 是 | 正整数；**改了脚本体或 argv 就要升版本**，不要原地改 |
| `description` | 是 | 一句话用途，≤200 字符；模型靠它选工具 |
| `category` | 否 | ≤40 字符，如 `crypto`/`web`/`reverse`/`general` |
| `notes` | 否 | ≤500 字符，**写"什么时候不该用"**；模型会读 |
| `examples` | 否 | ≤5 条，每条 `{arguments:{…}, note?}`；模型照此调用 |
| `executable` | 是 | 绝对路径；解释器类会被 digest 绑定 |
| `script` | 解释器类必填 | 绝对路径；脚本体被 digest 绑定，改动后必须升版本 |
| `argv` | 是 | 固定数组；`{script}` 展开为脚本路径，`{name}` 展开为参数 |
| `workspace` | 是 | 绝对路径，或 `"{workspace}"`（推荐）：绑定到运行时的实验 workspace，一份 roster 通用 |
| `parameters` | 是 | 见下 |
| `verify` | 是 | 目前唯一 kind：`json_post_state` |
| `timeout_ms` | 否 | 1–600000，默认 10000 |
| `risk_class` | 否 | `observe`/`low`/`medium`/`high`，默认 `medium` |
| `network` | 否 | 布尔；`true` 会标在网络工具上，仍需 Manifest 授权 |

### parameters

```json
"parameters": {
  "out":    { "type": "string", "required": true, "direction": "out" },
  "target": { "type": "string", "required": true, "direction": "in" },
  "count":  { "type": "number", "required": false }
}
```

- `direction: "in"` 的路径必须**已存在**且在 `workspace` 内；
- `direction: "out"` 的路径可以在 workspace 内新建；
- 其他字段只能传数据，不能传路径以外的东西；
- **argv 里引用到的每个 `{name}` 都必须在 parameters 里声明**，反之声明了却没用也会被拒绝。

### verify

```json
"verify": {
  "kind": "json_post_state",
  "resource": "out",
  "checks": [
    { "path": "verified", "op": "eq", "value": true },
    { "path": "plaintext", "op": "exists" }
  ]
}
```

`op` 只有 `eq` / `neq` / `exists`。`path` 支持点号或 JSON pointer。

**设计 Oracle 的原则**：把"成功"写成一个能独立复读的**事实**，而不是"程序说它成功了"。
例如：明文恢复后重新加密比对通过才写 `verified: true`；否则以非零码退出且不写文件。

## 4. 包装脚本的写法

工具只会打印 stdout 时，写一个**固定、可 digest、无参数解析歧义**的包装：

```python
# argv: <out.json> <input> <...>
# 只做三件事：调用、判断、写 JSON。不做 shell 展开，不 eval。
```

要求：
1. 正常路径写 `out`，并至少包含一个可判定的成功标志（如 `verified: true`）；
2. 前置条件不满足时**以非零码退出且不写 out**（不要写 `{"error": ...}` 当成功）；
3. 不读取 `out` 以外的工作区内容，不访问网络（除非 recipe 标 `network: true`）；
4. 脚本体变更后必须升 `version`。

## 5. 完成检查清单

- [ ] `--validate` 通过（退出码 0）
- [ ] `--recipe` 写入后 `--list` 能看到 id 与参数
- [ ] `examples` 里的参数名与 `parameters` 完全一致
- [ ] 用一个**真实但无害**的输入跑通，且 Oracle 返回 ok
- [ ] 用一个**故意失败**的输入跑，确认它产生非 ok 且不写出成功形状的文件
- [ ] 若改动过脚本或 argv，`version` 已递增

## 6. 不要做的事

- 不要为了"能跑"而改注册表、放宽 `validateScriptRegistration` 或绕过 Oracle。
- 不要把 `network: true` 当作已经获得网络授权；它只是标记。
- 不要登记需要交互输入（stdin）的工具；当前契约不提供 stdin。
- 不要登记会修改 `workspace` 之外路径的工具。
- 不要在 recipe 里写死本机临时路径作为 `workspace`（除非该实验确实固定）。
