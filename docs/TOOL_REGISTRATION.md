# 工具接入：注册、发现、调用

状态：**已实现并验证**（2026-10-21）。基线 `aegis-base-20261021`。
相关契约：[脚本注册表](../Pi_Agent_base/execution/script-registry.mjs)、[技法卡 schema](TECHNIQUE_CARD_SCHEMA.md)。

## 1. 为什么需要单独一层

Aegis 的模型能看到的工具分三类，信任级别完全不同：

| 类别 | 例子 | 谁保证它安全 | 能否成为证据 |
| --- | --- | --- | --- |
| Pi 原生工具 | `read`、`bash`、`edit`、`write` | 无（工作区不是 sandbox） | 否：只产出观察 |
| **已登记脚本动作** | `aegis_execute` + roster | 固定可执行文件 + 固定 argv + pinned digest + 已登记 Oracle | 是：可产生带证据的观察 |
| MCP 服务 | `firefox-devtools` | 服务自身 + Pi 的 exposure | 否：MCP exposure 不是 work permit |

`PATH` 里能看到一个 CLI **不等于**它已成为 Aegis 动作。这是本层的存在理由。

## 2. 让 AI 真正用起来需要什么

一次成功调用需要三件事同时成立，缺一都会被拒绝：

| 条件 | 怎么满足 | 失败时会看到 |
| --- | --- | --- |
| 工具已登记 | `aegis-register-tool.mjs --recipe … --roster …` | `aegis_tools` 报 `scripts_configured: false` |
| 运行读到了 roster | `run-experiment.sh` 自动发现，或 `--script-config` | 启动摘要显示 `scripts (none registered…)` |
| **有授权** | `--action-mode auto`（或每次 `AEGIS_ACTION_APPROVED=1`） | `Aegis: normal mode — … is pending human approval and was NOT executed.` |

第三项最容易踩：默认是 `normal`，**每个动作都需要显式授权**，所以模型调用会被拒绝。`auto` 是本次运行
的用户授权默认路径，会随每个 intent 记录；它**不是**验证结果，也不影响 Oracle。

## 2.1 三步走

```bash
# 1. 写 recipe（唯一需要人写的部分）
$EDITOR knowledge/techniques/scripts/rsa-common-modulus.recipe.json

# 2. 注册（自动算 digest、过真实校验门）
node aegis-register-tool.mjs \
  --recipe knowledge/techniques/scripts/rsa-common-modulus.recipe.json \
  --roster ~/.Aegis/tools/roster.json

# 3. 启动实验（自动发现 roster；授权默认路径按你的意愿选择）
./run-experiment.sh ram-001 --action-mode auto
```

启动后模型会看到：

```
aegis_tools   → 列出已登记动作的 id、描述、参数名与方向、authorization 模式
aegis_execute → 用 aegis_tools 给出的 id 和参数名执行
```

`aegis_tools` 只返回**形状**：id / version / description / risk_class / network / parameters / authorization。**不返回路径、digest 或 argv**——那些留在磁盘上供审计，不进模型上下文。

## 2.1 三种接入方式

| 方式 | 命令 | 适用 |
| --- | --- | --- |
| 手工写 recipe | `--recipe` | 少量、需要精确控制 |
| **侦察起步** | `--probe /path/to/tool --out draft.json` | 只给路径：得到 realpath、类型、digest、`--version`，再补 argv/Oracle |
| **一次运行学习** | `--scaffold /path/to/tool --sample "<你平时怎么跑>" --out recipe.json` | 自动推断 argv/参数/Oracle，只剩 description/notes 要写 |
| **交给其他 Agent** | 按 [接入规范](TOOL_INTEGRATION_SPEC.md) 产出 recipe，`--validate` 迭代 | 批量接入；规范里写明硬规则与检查清单 |

`--scaffold` 会**真实执行一次**该工具（在临时目录里，输入文件先复制进去），然后观察磁盘上
出现了什么，据此推断：

| 推断项 | 依据 |
| --- | --- |
| `{in1}…` 输入参数 | 样本命令里**存在**的文件路径 → 复制进临时目录，`direction: in` |
| `{out}` 输出参数 | 样本命令里**不存在但像路径**的 token（含 `/` 或扩展名）→ `direction: out` |
| `verify.checks` | 输出文件能解析成 JSON 时，取首个顶层字段做 `exists` 检查 |
| `argv` | 上述替换后的固定模板；其余 flag/值原样保留 |

生成的 recipe 默认 `workspace: "{workspace}"`——**绑定到运行时的 workspace**，所以一份 roster
在所有实验里通用（注入发生在 `createScriptRegistry`，见下）。若工具不写文件而是打 stdout，
scaffold **不会**编造 Oracle，而是在 review 里指出需要包装脚本。

`--probe` **只报事实**：路径、文件类型、解释器、digest、`--version` 首行。它不猜 argv、
不猜参数、不猜 Oracle——那三项是"被审阅的部分"，猜错会产生看起来能用的错误动作。
符号链接会被解析（homebrew 的工具就是链接），digest 绑定真实文件。
`/usr/bin/env python3` 这类 shebang 会解析到**真实解释器**，而不是 `env`。

## 3. recipe 格式

```json
{
  "id": "crypto-common-modulus",
  "version": 1,
  "description": "同一 n、不同 e 时恢复明文（要求 gcd(e1,e2)=1）",
  "executable": "/Users/scemac/Tools/PyVenv/CTF/bin/python3",
  "script": "/Users/scemac/My_github/Aegis/knowledge/techniques/scripts/rsa-common-modulus.py",
  "argv": ["{script}", "{out}", "{n}", "{e1}", "{c1}", "{e2}", "{c2}"],
  "workspace": "/tmp/at-test",
  "parameters": {
    "out": { "type": "string", "required": true, "direction": "out" },
    "n":   { "type": "string", "required": true },
    "e1":  { "type": "string", "required": true },
    "c1":  { "type": "string", "required": true },
    "e2":  { "type": "string", "required": true },
    "c2":  { "type": "string", "required": true }
  },
  "verify": {
    "kind": "json_post_state",
    "resource": "out",
    "checks": [
      { "path": "verified", "op": "eq", "value": true },
      { "path": "plaintext", "op": "exists" }
    ]
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `executable` | 绝对路径；shell 解释器（sh/bash/zsh/…）一律拒绝 |
| `script` | 解释器类必须提供，脚本体被 digest 锁定；`{script}` 在 argv 中展开 |
| `argv` | 固定模板；`{name}` 替换为声明过的参数；不得含 `;` `\|` `&` `` ` `` 或 eval token |
| `parameters` | 只有声明过的参数可传，模型只能提供数据；`direction: in/out` 的路径必须落在 workspace 内 |
| `workspace` | 绝对路径，或 `"{workspace}"`：后者绑定到**本次运行的 workspace**，一份 roster 全实验通用；注入后仍按普通登记项校验 |
| `verify` | 唯一支持的 kind 是 `json_post_state`：从 `resource_bindings` 取路径、**重读磁盘并解析**，不看 stdout / 退出码 |
| `category`/`notes`/`examples` | 模型选工具与调用所需：分类、**何时不该用**、一组可照抄的参数。由 `aegis_tools` 返回 |
| `timeout_ms`/`risk_class`/`network` | 超时（1–600000，默认 10000）、风险级别、网络标记（标记不等于授权） |

`--list` 查看已有条目，`--dry-run` 只校验不写盘。

## 4. 为什么 Oracle 只支持"重读文件"

`aegis_execute` 的执行结果里带有 `stdout_excerpt` / `stdout_digest`，但**Oracle 不使用它们**：

- stdout 是脚本自己的输出，等于让被检查方提供证据；
- 退出码同理（`spawn error`、timeout、signal 都单独归类，不当判定）。

因此工具必须把结论写成文件。这也是为什么推荐直接注册**技法脚本**（`knowledge/techniques/scripts/*.py`）而不是裸 CLI：脚本能在写完 JSON 后自检（如重新加密比对），Oracle 再独立复读一遍。

## 5. 与经验激活的关系

`reproduction` 证据指向 `script:<id>@<version>` 并 pin digest。注册一个技法脚本后：

1. 卡片可以用 `evidence.kind: "reproduction"` 引用它；
2. 真实任务里 `aegis_execute` 跑出 Outcome；
3. ≥2 个独立 Outcome 后，卡片文本才能被编译成 active Experience。

所以这一层是经验激活的**上游**：没有登记动作，`reproduction` 卡永远 fail-closed。

## 6. 验证

| 检查 | 结果 |
| --- | --- |
| `aegis-register-tool.mjs` 测试 | **10 pass**（digest、拒绝 shell/eval/元字符、解释器需 script、版本替换、`--dry-run`、`--list`） |
| `aegis-script-roster.mjs` | **12 pass**（含 `scriptContracts` 回归） |
| `aegis-card-reproduction.mjs` | 9 pass |
| 真实 SDK 探测 | `aegis_tools` 返回 id + 描述 + 参数；**无路径泄漏** |
| 真实执行 + Oracle | `rsa-common-modulus.py` 解出 `aegis-ok`，Oracle 复读 JSON 通过 |

## 7. 已知限制

1. **Oracle 只有 `json_post_state`**。工具若只能输出到 stdout，需要一层薄包装脚本落盘。
2. **`executable` 必须是绝对路径**，且 digest 绑定本机二进制。换机器/升级工具后需重新注册（会报 digest 不符）。
3. **`workspace` 在 recipe 里是静态的**；实际运行时的 `allowed_root` 应与当次实验 workspace 一致，跨实验复用同一 recipe 时要确认这一点。
4. **MCP 未纳入本层**：MCP 工具不受 Aegis 授权门约束，`exposure: direct` 表示模型可直接调用。是否加门控仍是待定设计。
5. `aegis_tools` 不列出 MCP 工具；模型对 MCP 的发现依赖 Pi 自身的 `/mcp` 与工具暴露策略。
