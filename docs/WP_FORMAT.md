# WP 规范 v2（机器可解析）

> **状态（2026-09-26）：历史文档，部分已作废，待重写。**
>
> 本规范的两个前提已被之后的决定推翻：
>
> 1. 它假定 `compile` 仍会**用 LLM 从 WP 散文里抽结构**（所以要把结构写死来减少漂移）。
>    现在的设计是**记忆不由 LLM 写入** —— 记忆由 Observer 从事件流机械抽取。
>    因此 `aegis/storage/compile.py` 里的 LLM 抽取路径要重写，本规范随之失效。
> 2. 它的 `verified` 四档是**模型自评**。现在成功与否由**公共黑板**上的
>    用户需求/阶段任务判定（见 `aegis/core/criterion.py`），不接受生产者自述。
>
> 下面内容保留作参考（尤其是「数字只准进 notes」这条纪律仍然成立），
> 但不要当作现行契约。

## 为什么改

旧 WP 是自由文本，`.aegis/lessons.json` 里 45 次编译有 2 次直接报错
（`compile LLM did not return JSON` / `Extra data: line 1 column 113`），
其余靠 LLM 从散文里**再抽一次结构**。README 自己写过：

> 让 LLM 生成结构、再用正则在运行时把结构丢掉，是当前最大的浪费。

同一个数字还要被写两遍（一次给人看，一次给机器读），两遍必然漂移。
本规范把**结构写死**：人读的部分和机器读的部分在同一个文件里，
机器读的部分是 YAML，`compile` 直接 `yaml.safe_load`，不再调用 LLM。

## 硬规则

1. 文件头必须是 YAML front matter（`---` 包裹），字段名固定，缺字段用 `null` / `[]`。
2. `## chain` 正文**一行**，至多一个 `->`，机制层。禁地址、偏移、chunk size、flag 内容。
3. `## cells` 里每条 cell 的 `requires` / `forbids` / `optional` 只能用
   `.aegis` atlas 认识的标签（见 `aegis/core/fingerprint.py:KNOWN_TAGS`）。
4. 数字（地址、偏移、chunk size）**只准进 `## notes`**，永不进 front matter 或 cells。
5. `verified` 四档，语义固定：
   - `flag`  真拿到 flag / 远程可检验 → 这条经验可以当"做法"
   - `local` 确实打通了、只是没上远程 → 弱一等证据，**仍然是 ON**
   - `none`  没打通，或靠关保护打通 → **必须 OFF**，成为下次的禁止项
   - `wiki`  来自知识库、本系统未验证 → 只做参考，永不进策略列

## 模板

```markdown
---
schema: 2
challenge: pwn_1
run_id: 20260923T204217
status: solved            # solved | failed | partial
verified: local           # flag | local | none | wiki
elapsed_s: 845.5
flag: ""                  # 真 flag 原文；没有就留空
world:                    # ← 本题实测到的世界。这是指纹，不许推测
  glibc: "2.27"           # "2.27" | null
  hooks: alive            # alive | dead | null
  exit: group             # flush | group | null
  arena: thread           # main | thread | null
  alloc: [tcache, fastbin, calloc]
  protections: [pie, full_relro, canary, nx]
primitives: [heap_overflow, libc_leak, arbitrary_write]
---

## chain
Fill 无长度校验堆溢出 -> 放大 chunk 制造重叠 -> 泄 libc -> 覆盖函数指针 -> getshell

## stuck
最长卡点：假 chunk 的 size 字节是重定位指针字节，只有约一半 ASLR 基址安全。
次要：calloc 零化整段请求，会抹掉重叠 chunk 头，free 前必须重写。

## notes
地址/偏移/chunk size 等本题数字写这里，例行不进经验库。
libc+0x3eb321 处 qword 0x80（main-arena、非 mmapped）可作稳定假 chunk。
按题解入口：Fill(index, size) 的 size 未与 alloc 的 size 比对。

## cells
```yaml
- technique: tcache poison -> arbitrary write without hooks
  requires: {glibc: ">=2.34", hooks: dead}
  forbids: [safe_linking]
  forbids_version: {}
  optional: [tcache]
  state: on
  summary: tcache bins 的 next 未校验时可直接指向任意地址；安全链接开启后需先泄堆地址。
- technique: __free_hook overwrite
  requires: {}
  forbids: []
  forbids_version: {glibc: ">=2.34"}
  state: off
  summary: 2.34 起 hook 符号已删除，这条在此世界不成立。
```

## problems
```yaml
- problem: glibc-all-in-one 的 libs 目录为空，取不到目标 libc
  solution: 下载 libc6_<版本>_amd64.deb 后用 dpkg-deb 解出 libc.so.6 与 ld
  deny: ""
```

## habits
```yaml
- when: 开始做一道堆题
  observe: 先确认 Allocate 用的是 malloc 还是 calloc
```
```

## 与 `compile.py` 的对应

| WP 字段 | atlas / lessons 字段 |
|---|---|
| `world.*` | 直接喂 `fingerprint.parse()`，**不再从散文抽** |
| `cells[].requires/forbids/forbids_version/optional/state` | `store.upsert_cell` 原样收 |
| `cells[].technique` | 过 `_portable_technique()` 校验（≤80 字、至多一个 `->`、无地址） |
| `problems[].deny` | 进 `bundle["denies"]`，由 guard 变成工具层 REFUSED |
| `habits[].when/observe` | `_lesson_units()` 原样收 |
| `verified` | `TIER_WEIGHT` 的证据档 |

## 判定 `state` 的机械规则

```
state = on   当且仅当  status == solved  且  verified in {flag, local}
state = off  其它一切情况（含 verified == none，以及 wiki）
```

`verified == none` 却写 `on` 是**假阳性**，是本系统最贵的错误
（`架构.md` §0.1：压 f+ > 提覆盖 > 降成本）。旧库里有这种格子，
所以现在要靠规范堵住，而不是靠事后审计。
