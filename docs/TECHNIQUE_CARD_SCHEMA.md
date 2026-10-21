# 技法卡片字段研判（Card Schema v2）

状态：**设计提案，待确认**。本文只做字段语义分析与迁移方案，不代表已实现。
基线：`1ec6cd7`（2026-10-21）。契约依据 [MEMORY_SCHEMA](MEMORY_SCHEMA.md) §6。

## 1. 现状事实

47 张卡位于 `knowledge/techniques/cards/*.md`，编译产物 `cards.json`（47 张，全部
`status: "verified"`），消费者是 `extensions/aegis-contest.ts` 的 `ContestCard`：

```ts
interface ContestCard {
  id: string;
  revision: string;
  title: string;
  status: "verified" | "candidate";
  source_refs: string[];
  scope: { task_category: string; environment: string };
  when: string[];
  hint: string[];
  expect?: string;
}
```

实测数据：

| 字段 | 实测 |
| --- | --- |
| `status` | verified 47 / candidate 0 |
| `when` | 65 个不同标签，纯 `Set.has` 精确匹配 |
| `expect` | 自由文本，仅用于展示 `to verify: ...` |
| `scope.environment` | **全部** `"macos"` |
| `scope.task_category` | crypto 10 / web 10 / pwn 10 / reverse 10 / misc 7 |
| `source_refs` | 纯 URL，wiki commit 埋在 URL 里，无 digest |

## 2. 五个字段问题

### 2.1 `status` 把两个正交维度压成一个枚举

`verified` 现在同时承担两件事：

- **整理质量**：有人读过、写通了（47 张卡实际就是这个状态）
- **证据门**：≥2 次独立 resolved Outcome（`MEMORY_SCHEMA` §6.3）

而卡片唯一来源是 CTF wiki，按 §6.2b 它是 unverified external reference。所以这 47 张卡
在证据维度上**只能是 candidate**，在整理维度上却是 reviewed。一个 `verified` 表达不了，
结果就是自动注入（`aegis-contest.ts:218`）建立在一个含义不明的布尔上。

### 2.2 `when` 与 Experience 的 `when` 同名异义

| 位置 | 形状 | 语义 |
| --- | --- | --- |
| 卡片 `when` | `["rsa", "same_modulus"]` | **触发标签**，精确匹配观测集合 |
| Experience `when` | `[{path, op, value, verified_by[]}]` | **可判定谓词**，需证据 |

同名导致两个后果：读卡片的人以为它是条件判断（其实只是标签）；写卡片的人把真正的
适用条件（"gcd(e1,e2)=1"）写进了 `hint` 散文，机器无法检查。

### 2.3 `expect` 不可判定

`expect` 是自由字符串，代码只做展示（`:282`）。所以卡片无法回答"这一步是否成功"，
只能靠模型自己判断——这与"结果必须独立判定"的原则相冲突，尽管卡片本身只是 hint。

### 2.4 `scope.environment` 全为 `"macos"`

47 张卡全部如此。`matchCardsDetailed` 要求 `card.scope.environment === context.environment`，
因此**在任何非 macOS 环境下，全部 47 张卡都不会匹配**。这不是刻意限制，更像批量生成时的
默认填充，但它静默地把卡片变成了平台绑定。

### 2.5 没有 provenance 与 limits

- `source_refs` 只有 URL；wiki commit 只能靠肉眼从 URL 里抠，无法校验内容是否仍一致。
- 没有"已知失败模式"。例如共模攻击在 `gcd(e1,e2) > 1` 时不成立，这条信息埋在 hint 第 1 条里，
  而不是独立字段。
- 没有 `reviewed_by` / `reviewed_at` / 对应 wiki 版本，整理过程不可追溯。

## 3. 提议：把维度拆开，而不是砍功能

核心原则：**`verified` 这个单布尔被替换为三个正交字段**，自动注入改为**派生判定**，
而不是取消。

### 3.1 字段表

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` / `revision` / `title` | 不变 | |
| `curation` | `draft \| reviewed \| disputed` | 文本整理质量（人工/工具复核程度） |
| `evidence` | `{ kind: "none" \| "document" \| "outcome", refs: string[] }` | 证据种类与引用；`outcome` 才可指向已提交 Outcome |
| `source` | `{ kind, uri, digest?, commit?, section? }` | 替代裸 `source_refs`，保留可校验来源 |
| `scope` | `{ task_category, environment: string \| "any" }` | 允许 `any`，解除平台绑定 |
| `triggers` | `string[]` | 原 `when` 改名；**观测标签**，精确匹配 |
| `preconditions` | `string[]` | **适用条件**，人类可读；不参与匹配，但必须与 `limits` 一致 |
| `hint` | `string[]` | 不变 |
| `postconditions` | `string[]` | 原 `expect` 的结构化形式，可多条 |
| `verification` | `string?` | 如何检查 `postconditions`（人工或脚本描述） |
| `limits` | `string[]` | 已知不适用情形 / 失败模式 |
| `review` | `{ by, at, against_commit }?` | 整理者、时间、对应的 wiki 版本 |

### 3.2 示例（共模攻击）

```json
{
  "id": "crypto-rsa-common-modulus",
  "revision": "2",
  "title": "RSA 共模攻击（同一 n，多组 e）",
  "curation": "reviewed",
  "evidence": { "kind": "document", "refs": ["ctf-wiki:rsa_module_attack#共模攻击"] },
  "source": {
    "kind": "ctf-wiki",
    "uri": "https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/crypto/asymmetric/rsa/rsa_module_attack.md",
    "commit": "e225ddfcd420a7f54a5940f47336ebdf8c29b875",
    "section": "共模攻击"
  },
  "scope": { "task_category": "crypto", "environment": "any" },
  "triggers": ["rsa", "same_modulus"],
  "preconditions": ["同一明文用同一个 n、不同 e 加密", "gcd(e1,e2)=1"],
  "hint": ["...", "..."],
  "postconditions": ["m^e1 mod n == c1", "m^e2 mod n == c2", "m 的字节结构可解释"],
  "verification": "重新用 e1/e2 加密 m，与 c1/c2 比对",
  "limits": ["gcd(e1,e2) > 1 时不适用（需先约分或换一对指数）"],
  "review": { "by": "human", "at": "2026-10-21", "against_commit": "e225ddfc" }
}
```

### 3.3 注入资格改为派生

不新增"开关"，而是从字段推导：

```
injectable = curation == "reviewed"
          && evidence.kind != "none"
          && scope 匹配
          && triggers 全部命中
```

这样保留现在的行为（47 张 reviewed+document 卡照旧自动注入），但注入的理由变成可审计的：

- `draft` 卡不注入（等同于现在的 candidate，需人工选）
- `disputed` 卡不注入
- 无来源（`evidence.kind == "none"`）不注入
- `scope.environment: "any"` 让卡片不再被平台绑死

关键点：**这不是减功能**。当前 candidate 不注入的行为保留，只是把"为什么能注入"从
一个含义不明的 `verified` 换成三个可核对的条件。

### 3.4 与 Experience 的关系

卡片与 Experience 仍不合并，但字段对齐：

| 卡片 | Experience | 关系 |
| --- | --- | --- |
| `preconditions` | `when` | 语义对齐；卡片不要求 `verified_by` |
| `postconditions` | `expect` | 语义对齐 |
| `hint` | `do.kind="procedure".steps` | 同性质 |
| `evidence.kind="outcome"` | `support` | 积累够 ≥2 独立 Outcome 后，可走 §6.3 晋升 |

也就是说：卡片是 procedure 的**候选来源**，`evidence.kind` 从 `document` 变成 `outcome`
即表示它已经拿到真实结果支撑；此时它既可以继续作卡片，也可以被编译成 Experience。
两条路共用同一份文本，不重复维护。

## 4. 兼容与迁移

1. **读取侧向后兼容**：`parseCard` 接受 v1 与 v2。v1 映射规则：
   - `status: "verified"` → `curation: "reviewed"`, `evidence: {kind:"document"}`
   - `status: "candidate"` → `curation: "draft"`
   - `when` → `triggers`
   - `expect` → `postconditions: [expect]`
   - `source_refs` → `source` 取第一条，`kind: "ctf-wiki"`
   这样现有 47 张卡无需立刻改，行为不变。
2. **校验侧**：新增 `cards.json` schema 校验（v2），拒绝未知字段与非法枚举，避免静默扩权。
3. **生成器**：补 `md → cards.json` 的脚本（当前缺失），md 头部字段随之扩展；v1 头部仍可解析。
4. **环境字段**：迁移时 `"macos"` → `"any"`，并在文档说明如果确实有平台限制该如何写。

## 5. 明确不做

- 不把卡片改成 Experience，也不让卡片携带 `verified_by` 或 Outcome 引用冒充证据。
- 不因为拆字段就放宽注入门槛（当前候选卡仍需人工选择，这一点保留）。
- 不自动把 `evidence.kind` 升级为 `outcome`；必须有已提交 Outcome 才能写。
- 不改 `MAX_INJECTED`、不改 hint-only 性质。

## 6. 待确认的决策点

1. **`curation` 枚举**：`draft | reviewed | disputed` 是否够用？是否要 `deprecated`？
2. **`environment: "any"`** 是否可接受（会让卡片在 Linux/容器里也匹配），还是坚持逐平台列举？
3. **`evidence.kind` 三值**（none/document/outcome）是否够用，还是需要 `reproduction`（可重放脚本）？
4. **`limits` 是否强制非空**（要求每张卡至少写一条已知限制）？这会强制回填 47 张卡。
5. 迁移方式：一次性机械迁移（47 张全改 v2）还是读取侧兼容、逐步重写？

## 7. 实施顺序（确认后）

1. `aegis-contest.ts`：v1/v2 双读 + 派生 `injectable`，保持现有行为；补边界测试。
2. 新增 `validateCards` 与 `md → cards.json` 生成器（恢复可复现）。
3. 机械迁移 47 张卡（补 `preconditions` / `limits` / `verification`，`environment` 改 `any`）。
4. 文档：`KNOWLEDGE_RUNTIME.md` 或新页登记 v2 契约；更新 `AEGIS_ENTRY_CAPABILITIES.md` 的卡片行。
5. 回归：`contest-smoke`、`aegis-contest-pi-integration`、`aegis-observer-contest-pi`、`aegis-ram-knowledge-reserve`。
