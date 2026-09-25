# Aegis demo — Pi 工作约定

完整 ROM 见 [`rom/ROM.md`](rom/ROM.md)。容器工具见 [`ram/TOOLS.md`](ram/TOOLS.md)。

当前只打 `.aegis/current.json` 里的那一题。做完调用 `aegis_finish`，
然后由 harness 用 git 把 `test/<题>/` 恢复成入库快照，避免下一题读到上一题的痕迹。

**你不写记忆。** 你做过的事由 Observer（pi 原生扩展）从事件流里机械记录到
`.aegis/observer/`，成功与否由**公共黑板**上的用户需求/阶段任务判定 ——
判成功不看工具退出码。开跑先 `aegis_board(action="read")`。

不要读 `架构.md` / `框架.md` / 其它题目。不要 IDA。
