# Aegis Git 使用规范（强制）

本规范对所有在本仓库工作的人类与 Agent（DS/子 DS/任何自动化流程）强制生效。
它与 `AGENT_DEVELOPMENT_STANDARD.md` 平级；冲突时以本文件关于版本控制的部分为准。
违反本规范的提交视为无效提交，必须回退（`git reset`/`git revert`，不得改写已共享的历史）。

## 1. 身份与时间（真实）

1. 提交者身份与时间戳必须真实：
   - 禁止 `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` 环境变量，禁止 `--date` 伪造。
   - 禁止时间取整（如统一 00:00:00）。提交时间 = 实际提交时刻。
   - Agent 发起的提交使用当前 git config 的 user.name/email，不得冒充他人。
2. 每次提交前 `git config user.name` / `user.email` 必须已配置（仓库级即可）。

## 2. 提交粒度与信息

1. 一个提交做一件事：`fix` / `feat` / `test` / `docs` / `chore` / `refactor` 前缀 + 祈使句。
2. 提交信息正文说明"为什么"，特别是诚实性修复（沿用现有风格：
   "a positive verdict the criterion never matched is not evidence"）。
3. 禁止空信息提交、禁止 "wip"、禁止把多个不相关变更混入一个提交。
4. 提交前必须 `git status` 确认暂存内容；禁止 `git add -A` 盲提交（本次基线是经批准的一次性例外）。

## 3. 禁止改写历史

1. 已存在于 `main`（或任何已推送分支）的提交不得 rebase / amend / filter-branch / reset --hard。
   发现错误用新提交修正。
2. Agent 不得执行任何会改写 reflog 或对象库的命令（`gc --prune=now`、`reflog expire`、`filter-repo` 等）。
3. 分支保护：`main` 上只允许快进合并；实验性工作在 `exp/*` 分支进行。

## 4. 纳管边界（什么必须入库、什么绝不入库）

绝不入库（.gitignore 已配置，提交前仍须自查）：
- `Pi_Agent_base/runtime/`（实验产物，339M）
- `Pi_Agent_base/config/`（含 `auth.json` 真实 API key）
- `Pi_Agent_base/pi/`（嵌套 git 仓库 + node_modules，478M）
- `tmp/`、`.DS_Store`、任何 `*.env`、任何含 `sk-` / token 的文件

必须入库：
- `Pi_Agent_base/memory/`、`extensions/`、`tests/`、`contest/`、`agent/`、根级配置（tsconfig、biome、run-pi.sh、.gitignore）
- `docs/`（任务书、审计、报告——它们是证据链的一部分）
- 每轮任务的 REPORT / REVIEW / TEST_MATRIX 完成后随对应代码一并提交

提交前密钥自查命令（Agent 必须执行且结果干净）：
```bash
git diff --cached --name-only | xargs grep -l "sk-\|api_key\|BEGIN .*PRIVATE KEY" 2>/dev/null
# 输出必须为空
```

## 5. Agent 特别约束

1. Agent 可以 `git add` / `git commit`，但：
   - 每个 commit 必须对应一个可描述的任务单元；
   - commit 信息中如实声明是 Agent 提交（正文首行可加 `Agent-Commit: <model/session>`）。
2. Agent 不得 `git push` / `git pull` / 联网操作，除非用户在该会话中明确授权。
3. Agent 不得删除 `.git`、`.gitignore`、或以"清理"为由 reset 工作区。
4. 长任务（Overnight 类）结束或达到里程碑时必须提交，不得把多轮工作长时间留在未跟踪状态——
   本次审计发现的核心事故（约 1 万行实现完全脱离版本控制）就是违反这一条的结果。
5. 若发现 git 状态异常（reflog 断裂、对象丢失、大量未跟踪实现），停止操作并报告用户，不得自行"修复"历史。

## 6. 基线记录

- 2026-10-12：`abd7ced` 将当前 Pi 版实现全部基线化入库（此前仅 79 个旧 Python demo 文件被跟踪）。
- 历史提交时间戳存在整点伪造（DS 执行），对象库经 `git fsck` 验证完整，35 个历史提交保留不动。
