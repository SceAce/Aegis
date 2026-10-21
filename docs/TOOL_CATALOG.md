# 工具能力清单（Tool Catalog）

状态：**已实现**（2026-10-21）。与 [脚本动作注册表](TOOL_REGISTRATION.md) 是**两层不同的东西**。

## 1. 两层工具，别混

| | 脚本动作注册表 | **能力清单（本文）** |
| --- | --- | --- |
| 目的 | 让 Aegis 能**确定地**执行一个已审阅动作 | 告诉模型**有哪些工具、怎么调用** |
| 参数 | 固定 argv 模板，模型只给数据 | **模型自己拼参数**，通过 bash 执行 |
| 信任 | pinned digest + 已登记 Oracle | 文档，不授权、不产生证据 |
| 适用 | 反复使用的技法脚本（RSA 共模、解析器） | 通用 CLI（ROPgadget、pwninit、binwalk…） |

能力清单**不枚举命令**。ROPgadget 有几十种用法，注册表不该也不可能穷举；它只需要说清
「装在哪、怎么调用、参数长什么样、踩过什么坑」，参数由模型按当前题目自己组合。

## 2. 文件与工具

```text
$AEGIS_HOME/tools/catalog.json     能力清单（本机私有，不入库）
```

模型侧：

| 工具 | 作用 |
| --- | --- |
| `aegis_toolbox` | 列出所有工具（id / 用途 / usage 一行 / 坑数量）；带 `tool` 参数时返回该工具的完整接口、示例与坑 |
| `aegis_tool_note` | 提议一条坑（condition + symptom + correct_invocation），存为 **candidate** |

`aegis_toolbox` **不返回可执行路径**；路径留在磁盘，供审计与调试。清单是文档，不是授权：
模型仍然通过 bash 调用，产物仍是**不透明观察**（见 `Pi_Agent_base/AGENTS.md`）。

启动器会把清单里各工具所在目录加入 `PATH`（`run-experiment.sh`），否则模型拼好的命令会
`command not found`。**PATH 可见 ≠ 已授权**，这条不变。

## 3. catalog.json 结构

```json
{
  "schema_version": "1.0",
  "tools": [
    {
      "id": "ropgadget",
      "purpose": "从 ELF 二进制中列出 ROP gadget，用于链构造",
      "category": "pwn",
      "executable": "/Users/scemac/Tools/PyVenv/CTF/bin/ROPgadget",
      "interface": {
        "usage": "ROPgadget --binary <file> [--only \"pop|ret\"] [--depth N]",
        "key_flags": ["--binary", "--only", "--depth", "--ropchain", "--badbytes"],
        "examples": ["ROPgadget --binary ./pwn --only \"pop|ret\""]
      },
      "pitfalls": [
        {
          "condition": "目标是没有符号的裸 ELF",
          "symptom": "只给位置参数时 ROPgadget 不输出任何 gadget",
          "correct_invocation": "ROPgadget --binary ./pwn --only \"pop|ret\"",
          "status": "confirmed",
          "recorded_at": "2026-10-21T05:00:00.000Z",
          "refs": ["episode:…"]
        }
      ]
    }
  ]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | `[A-Za-z0-9][A-Za-z0-9._-]*` |
| `purpose` | 是 | 一句话用途，模型据此决定要不要用 |
| `executable` | 是 | 绝对路径（仅用于 PATH 与诊断，不进模型上下文） |
| `interface.usage` | 是 | 调用形状；可写占位符如 `<file>` |
| `interface.key_flags` / `examples` | 否 | 关键参数与一条可照抄的例子 |
| `pitfalls[]` | 否 | 见下 |
| `notes` | 否 | 自由说明（建议少用，优先结构化 pitfall） |

## 4. 坑为什么是结构化的

`架构.md` §6.4 明确：**不存"教训文本"，存"判决"**。所以一条坑必须是三元组：

```
condition（什么条件下成立） + symptom（会出什么错） + correct_invocation（怎么做才对）
```

散文式"注意 ROPgadget 容易出错"既不可核对，也无法在下次自动匹配。三元组可以被模型直接
套用，也可以被后续的判据提取复用。

### 生命周期

```text
模型 aegis_tool_note  →  pitfalls[] 追加一条 status=candidate（带 episode ref）
人类 /aegis checkFlag  →  本 Episode 的 candidate 提升为 confirmed，写入 recorded_at 与 refs
```

**只有人类确认解出之后**，本轮的坑才变成 `confirmed`。这是刻意的：模型的自述不是证据，
一条"坑"必须挂在一个被确认的胜负结果上。跨 Episode 的 candidate 不会被别的解顺带提升。

`/aegis checkFlag` 还会提示确认了几条：

```
Aegis: recorded human outcome=success … ; confirmed 1 tool pitfall(s)
```

## 5. 从工具清单批量生成

两步：**扫描**（机器状态）→ **生成**（知识）。

```bash
# 1) 扫描本机：哪些工具在、版本多少、按方向统计
node aegis-scan-tools.mjs            # → ~/.Aegis/tools/ctf/tool-inventory.json
node aegis-scan-tools.mjs --dry-run  # 先看

# 2) 生成能力清单：补上用途/用法/坑
node aegis-seed-tool-catalog.mjs            # → ~/.Aegis/tools/catalog.json
node aegis-seed-tool-catalog.mjs --dry-run
node aegis-seed-tool-catalog.mjs --only pwn.ropgadget
```

扫描器不只查 `PATH`，还会搜 `/opt/homebrew/bin`、`~/.local/bin`、两个 CTF venv 的 `bin`，
以及 **gem 的可执行目录**（homebrew ruby 默认不在 `PATH` 里，之前就因此误报"未安装"）。
Python 模块按解释器逐个探测，因此 `angr`/`z3` 这类只在 3.12 venv 里存在的包也能被发现；
模块与同名 CLI 会存成两个条目（`pwntools` 与 `py-pwntools`）。

`--force` 用于从**非法**的旧 catalog 恢复：先备份成 `catalog.invalid-<时间戳>.json` 再覆盖。

- 知识表（`TOOL_KNOWLEDGE`）在 `aegis-seed-tool-catalog.mjs` 里，**随仓库跟踪**，可 review；
- `executable` 从 inventory 解析（含 `pwn.ropgadget` → `ROPgadget` 这类命名差异）；
- inventory 里有但知识表没覆盖的条目**跳过并报告**，不会编造；
- 重新生成时**保留**已 confirmed 的坑，不会降级；
- 种子坑一律是 `candidate`：只有真实解出并由 `checkFlag` 确认后才会变 `confirmed`，
  所以种子里写的"坑"只是待验证的提示，不是已验证结论。

当前本机覆盖 **47 个条目**：reverse 11、pwn 12、web 8、misc 8、crypto 7、general 1
（含 `ida`：GUI `ida <bin>` / headless `idat -A -S<script.py>`；`pwninit`、`frida`、
`dirsearch`、`arjun`、`jwt_tool`、`sage`、`steghide` 等未安装的不会出现）。

## 6. 怎么加一个工具

手工编辑 `catalog.json` 即可（它是数据，不是代码）；或用 `install.sh --smoke` 之后的小脚本生初稿。
校验在加载时进行：非法条目会被报出来并**丢弃**，不会带着半条数据进入上下文。

最低要求三个字段就能用起来：

```json
{ "id": "binwalk", "purpose": "递归提取固件中的嵌入文件系统",
  "executable": "/opt/homebrew/Cellar/binwalk/3.1.0/bin/binwalk",
  "interface": { "usage": "binwalk -e <firmware>" } }
```

## 7. 边界（不变）

- 清单不是授权：不会让任何命令变成"已批准"。
- 通过 bash 的结果仍是**不透明观察**，不自动成为 Fact 或 Outcome。
- 需要**可复算、可独立判定**的技法，仍应走脚本动作注册表（`aegis_execute` + Oracle）。
- 清单文件是本机私有（`$AEGIS_HOME`），不入库；工具路径因机器而异。

## 8. 验证

| 检查 | 结果 |
| --- | --- |
| `aegis-tool-catalog.mjs` | **10 pass**（结构校验、summary 不含路径、坑的三元组、candidate→confirmed、坏文件被拒） |
| 真实 SDK 端到端 | 模型看到 2 个工具与 usage → 提议坑存为 candidate → `checkFlag` 后变 confirmed |
| `run-experiment.sh` | 打印 `toolbox` 路径；清单目录进入 `PATH` |
| `aegis-seed-tool-catalog.mjs` | **6 pass**（生成、跳过未覆盖项、保留 confirmed、dry-run/--only、不覆盖坏文件） |
