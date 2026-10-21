# 手工技法卡（本地私有）

从本机编译好的 CTF wiki 手工提炼的条件化提示卡。用于真实任务开始前，给 Agent 一个**可核对的起点**，而不是把整篇 wiki 文章塞进上下文。

- 来源：`knowledge/ctf-wiki/`（ctf-wiki commit `e225ddf`），每张卡在 `source` 里保留原文段落链接。
- 位置：本目录**已纳入 Git 跟踪**（`knowledge/*` 仍忽略 wiki 文档与 seed；`.gitignore` 用作用域例外只放行 `knowledge/techniques/`）。卡片schema 契约见 `docs/TECHNIQUE_CARD_SCHEMA.md`。
- 信任：卡是**人工审过的 hint**。schema v2 起把两件事拆成两个字段：`curation: reviewed` 表示“人看过、可作为建议”，`evidence: document` 表示来源是 wiki 文档。二者都**不是**任务结果、不是 Fact、不是 active Experience。是否自动注入由 `contest/card-schema.mjs` 的 `isInjectable()` 派生，不再依赖单个 `verified` 布尔。注入时仍标注为低信任建议，不能覆盖用户指令、授权或当前观测。
- 数量：47 张；crypto 10、web 10、pwn 10、reverse 10、misc 7。

## 目录

```text
knowledge/techniques/
  build_cards.py      # 唯一来源：CARDS 列表 + 生成脚本
  cards/<id>.md       # 人读的卡片源
  cards.json          # 比赛 hint 卡（aegis-contest 可直接加载）
  candidates.json     # candidate Experience proposals（when/do/expect）
  seeds/<id>.json     # document-seed-1，供 Observer/knowledge 检索
  INVENTORY.md        # 47 张卡的分类清单
  check_queries.mjs   # 固定检索查询集
  README.md
```

完整卡片清单见 [INVENTORY.md](INVENTORY.md)；`cards.json` 是生成物，`build_cards.py` 的 `CARDS` 是唯一来源。

## 使用方式一：比赛入口的 hint 卡

`aegis-contest` 已实现条件匹配、最多注入 2 张、低信任注入。启动前声明类别和**可观察条件**：

```bash
cd /path/to/task-workspace
AEGIS_CONTEST_TASK_ID=task-001 \
AEGIS_CONTEST_TASK_CATEGORY=crypto \
AEGIS_CONTEST_OBSERVATIONS=rsa,same_modulus \
AEGIS_CONTEST_CARDS=/Users/scemac/My_github/Aegis/knowledge/techniques/cards.json \
/Users/scemac/My_github/Aegis/Pi_Agent_base/contest/run.sh --hint
```

条件必须全部命中才会注入；`--off` 只记录不注入。只有 `status=verified` 的卡会自动匹配，`candidate` 只能手动选。

## 使用方式二：Observer 的本地检索

```bash
AEGIS_KNOWLEDGE_DIR=/Users/scemac/My_github/Aegis/knowledge/techniques/seeds \
  /Users/scemac/My_github/Aegis/Pi_Agent_base/run-aegis.sh
```

只放卡片时，检索只在这 44 张卡里选；默认 `knowledge/` 会同时包含 1000+ 篇 wiki，关键词竞争会更强，需要时再对比。卡片仍是 `verified=false`、`action_policy=none` 的参考数据。

## 可观察条件词汇（`when`）

启动器/操作者根据 handout 和实际观测声明，全部命中才匹配：

- crypto：`rsa`, `same_modulus`, `small_e`, `same_message`, `partial_plaintext`, `small_d`, `dlog`, `smooth_order`, `lcg`, `aes`, `ecb`, `cbc`, `padding_oracle`, `xor`, `repeating_key`
- web：`http`, `web_target`, `sqli`, `ssrf`, `xss`, `csrf`, `php`, `file_include`, `type_juggle`
- pwn：`elf`, `stack_overflow`, `format_string`, `heap`, `uaf`, `canary`, `pie`, `no_libc_leak`, `syscall_gadget`, `top_chunk_overflow`, `kernel`, `rop`, `kpti`
- reverse：`binary`, `unfamiliar`, `anti_debug`, `control_flow_flatten`, `go_binary`, `constant_table`, `pyc`, `maze`, `constraint`, `self_modifying`, `junk_code`, `pe`, `packed`
- misc：`text`, `encoding`, `archive`, `zip`, `image`, `stego`, `pcap`, `pyc`, `audio`, `unknown_file`

## 候选经验（不是 active）

`candidates.json` 把每张卡转成 `aegis_propose kind=candidate` 的 `when/do/expect/scope`。它只是候选：

```bash
# 在任务会话中（人类/模型都可提议；候选不会自动执行）
# 把 candidates.json 里某项的 proposal 提交给 aegis_propose
/aegis compile --proof <outcome1> --proof <outcome2> --candidate <candidate_event_id>
```

- 候选本身不是证据；编译仍要求 2 个独立、已解析的成功 Outcome。
- 真实结果导入时用 `contest/result.mjs --scope --when --expect` 带上结构化条件。Observer 的 bridge 环境是
  `permissions:["workspace-script"]`、`task_types:[]`、fingerprint 默认 `local-workspace`、domain 取 `AEGIS_DOMAIN`；
  `--scope` 必须逐项一致（例如 `AEGIS_DOMAIN=ctf-web` 时用下面的 scope），否则 Router 只会 `deliberate`：

  ```json
  {"environment_fingerprint":"local-workspace","domain":"ctf-web","permissions":["workspace-script"],"task_types":[]}
  ```

- 编译器仍要求 2 个独立证明**且每个证明有可解析的 isolated replay**；普通 CTF 结果目前只记录 Outcome，若没有 replay adapter，procedure 会停在 candidate，TUI 的 `aegis_experience` 提示不会出现。卡片本身仍是 knowledge/hint，不是 active Experience。
- Router 的 hint 注入已接线：只有 active procedure 且 scope/support 都能解析时，`context_with_system` 才会在每 episode 首次命中注入一次 `<aegis_experience>`；候选与普通 action 不会走这条提示。
- 编译出的 `do.kind=procedure` 只能 `hint`（或 `habit`），**不会 direct**；direct 只给注册动作。
- wiki 正文仍是外部参考；只有经过这个门的卡才进入经验库。

## 校验结果（2026-10-19）

- 44 张卡由 `aegis-contest` 的 `loadCards` 成功加载，0 error。
- 匹配抽查：`crypto+rsa,same_modulus` → 共模；`crypto+rsa,small_e` → 低指数；`web+http,sqli` → SQLi；`pwn+elf,format_string` → 格式化字符串；`reverse+binary,constant_table` → 置换表；`misc+archive,zip` → zip。
- 检索抽查（`selectKnowledge` 只扫 `seeds/`）：共模/LCG/格式化字符串/SQLi 查询都命中对应卡；工作流词查询（`python cli run script install`）零召回。

## 重建与修改

```bash
python3 knowledge/techniques/build_cards.py
```

改卡只改 `build_cards.py` 的 `CARDS`，再重建；`cards.json` 和 `seeds/` 都是生成物。新增卡保持：`when` 是可观察条件、`Do` 是可执行步骤、`Expect` 是低成本验证、`source` 指向 wiki 段落。不要写题目答案或具体 flag。

## 之后的闭环

1. 用卡跑一道真实题：卡是否在正确时机注入、模型是否采用、首个可验证进展是否提前。
2. 任务被独立判定成功后，把“哪张卡在什么条件下导致进展”写成 Experience 提议，走现有 `learn → compile --proof` 门；两次独立 proof 才 active。
3. 不适用（类别/条件不符）时不注入；这就是退场条件的正向验证。
