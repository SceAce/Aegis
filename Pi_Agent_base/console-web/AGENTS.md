# Web Console 模块规则

适用于 `console-web/`。它是普通 Experiment Host 的**本地 Web 适配层**，不是任务运行时。

- 权威仍是 EventLog 与现有投影（`memory/*`）；本目录不写任务事件、不判定成功、不改预算/权限/hold。
- HTTP handler 只能调用 Host 的明确控制接口；不得直接触碰 SDK、shell、工具或业务事件。
  控制语义集中在 `control.mjs`（dispatch/pause/resume/stop/receipt），路由只做校验与转发。
- 每个活跃实验一个 Host 子进程：Observer 配置来自进程环境，同一进程跑两个实验会串味。
  不新建 Session manager、ownership 或 EventLog；复用 `session/experiment-console.mjs`。
- 服务只做只读读取（`run.json`、EventLog、workspace）；不写 `run.json`、不写 checkpoint，
  避免第二个 writer。创建实验复用 `run-experiment.sh --dry-run`（唯一初始化路径）。
- 安全边界按 `docs/WEBUI_CONSOLE.md`：仅 loopback、Host/Origin 校验、路径 realpath 限制、
  有界输出、无 CORS/GET 写。所有请求体、路径和文件名在上限与白名单内校验。
- `view.mjs` 的字段白名单与上限就是浏览器能看到的一切；`transcriptEntry` 同时供 SSE 使用，
  保证“重连后的形状 == 新加载的形状”。

验证入口（仓库根）：`aegis-webui`（HTTP → Host → SDK/Observer → EventLog 生产链路）。
浏览器验收命令与截图目录见 `docs/WEBUI_CONSOLE.md` 与第三阶段报告。
