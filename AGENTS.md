# Aegis demo — Pi 工作约定

完整 ROM 见 [`rom/ROM.md`](rom/ROM.md)。容器工具见 [`ram/TOOLS.md`](ram/TOOLS.md)。

当前只打 `.aegis/current.json` 里的那一题。产物写到 `runs/`（按时间排序的短 WP），记忆写到 `.aegis/`（git 忽略）。做完调用 `aegis_finish`，然后由 harness 用 git 把 `test/<题>/` 恢复成入库快照，避免下一题读到上一题的痕迹。

不要读 `架构.md` / `框架.md` / 其它题目。不要 `kb`。不要 IDA。
