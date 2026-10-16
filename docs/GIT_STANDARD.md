# Aegis Git 使用规范

适用于 Aegis-owned 代码、测试、配置与文档。用户当前授权优先；Git 行为以本规范为准，
历史任务书中的“不提交 Git”限制已由用户要求使用 Git 管理替代。

## 1. 开始与结束

- 开始记录 `git status --short`、`git branch --show-current`、`git rev-parse HEAD`。
- 区分本任务改动、用户已有改动与其他 Agent 改动；不得混入或清理无关文件。
- 已授权任务在 `audit/*`、`fix/*`、`feat/*` 等明确分支工作；已有任务分支可继续使用。
- 完成一个可审查任务单元即提交。不得让多轮实现、测试、报告一直停留在未跟踪状态。
- 提交后报告分支、短 commit id、检查结果和剩余工作树状态。测试失败的审计提交允许保留，
  但提交信息和报告必须明确它是待修复的回归证据，不能称实现通过。

## 2. 暂存与提交

- 使用明确路径 `git add -- <paths>`，先读 diff，再读 `git diff --cached --stat` 和
  `git diff --cached`。新文件也必须全文审查，不能把 `git diff` 为空当没有变更。
- 一个提交围绕一个问题，使用 `fix:`、`feat:`、`test:`、`docs:`、`chore:` 等前缀。
  审计测试和对应缺陷报告可一同提交，使失败基线可追溯。
- 不编造作者、时间或提交来源。使用已配置的身份和 Git 默认时间；不设置伪造日期环境变量。
  Agent 提交在正文注明 Agent 协助及任务范围，不假装用户亲自实现。
- 身份缺失时向用户确认或使用用户已指定身份，不从未知机器数据猜测身份。
- 不擅自关闭签名或改变全局 Git 设置。必要配置改动限定仓库级并如实记录。
- 格式、类型和测试退出码必须直接捕获。不能用管道最后一个命令的成功冒充检查成功。

## 3. 历史与远端

- 保留现有历史和归档分支，不因大量工作树删除/未跟踪文件认定对象库损坏。
  先执行 `git fsck --full`，检查 refs、index 与工作树差异；证据不足记 unknown。
- 禁止删除 `.git`、擅自重建仓库、改写共享历史或删除其他分支。
- 不执行 `reset --hard`、`clean -fd`、全局 checkout/restore、stash、强制 push、
  reflog expire 或对象清理来“修复”用户工作区。
- 错误提交用后续修正提交处理；需要撤销产品变更时先判断工作树和授权，不能自动丢弃内容。
- 本地提交属于用户要求的版本管理。push、远端修改、真实网络操作需要相应用户授权。
- Markdown 中的分支规则是操作约束，不等同于服务器分支保护或已安装的 hook。

## 4. 纳管范围

Aegis 主仓库必须跟踪：

- `Pi_Agent_base/` 下的 `memory/`、`campaign/`、`execution/`、`session/`、`orchestration/`、`verification/`、`observation/`、`shared/`、`fixtures/`、`extensions/`、`tests/`、`contest/`、`agent/`、`README.md`、`AGENTS.md`；
- Aegis 自有启动入口、Biome/TypeScript 配置及忽略规则；
- `docs/` 的契约、任务、测试矩阵、审计与交付报告。

保持本地且不入主仓库：

- `Pi_Agent_base/config/`：凭据、模型配置、会话和本地状态；
- `Pi_Agent_base/runtime/`：运行日志、实验产物和私有验证证据；
- `Pi_Agent_base/pi/`：独立嵌套仓库，主仓库不递归 vendoring 或意外加入 gitlink；
- `tmp/`、依赖目录、缓存、环境密钥文件。

主仓库管理 Aegis 自有内容不代表内嵌 Pi 源码已由主仓库备份。SDK 相关任务记录内嵌 Pi
的实际 HEAD 和 dirty 状态以便复现；修改其核心仍须单独授权。不得移动或删除嵌套仓库。

## 5. 凭据与证据

- 不打印凭据来检查是否应纳管；用路径、`git check-ignore -v` 和暂存清单核对。
- 检查暂存 diff 中意外加入的 auth/env/私钥文件及疑似真实密钥值。
  `api_key`、`token` 等字段名或测试占位值本身不等于泄漏；关键词扫描不能证明无泄漏。
- 日志保存在 ignored 私有目录，公开报告只包含有界引用、退出码和必要摘要。
- 报告把已运行、失败、blocked、未运行和引用历史声明分开；不把历史 mutation 报告当成本轮复跑。

## 6. 本次基线

- `abd7ced`：保留旧历史并将当前 Pi 版 Aegis 实现纳入主仓库；旧 demo 留在归档历史。
- `ab4a988`：第一批外部补充测试；其通过范围不等于 C1 外部验收通过。
- 对象库完整性检查通过。此前“全零 hash”“输出过滤”“DS 伪造时间戳”等推断
  没有可支持结论的证据，撤回，不作为开发依据。
