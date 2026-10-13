# C4a：本地只读观察界面与 Pi 查看命令

状态：下一轮待委派；C4 本轮审查/修复已完成，见 `C4_EXTERNAL_REVIEW.md`。
本任务只实现观察面，不实现 C5 总入口/能力实验，不重开 C1-C4、F16 或类型清库。

## 冻结目标

提供 localhost 只读页面和少量 Pi 查看命令，显示同一 committed 投影：
Campaign 控制态、静态/动态队列、提案准入/拒绝、Task/Stage/Episode/Session、预算、动作、
Oracle/Outcome、unknown/故障/缺证据、handoff 与报告引用。用户能看懂正在发生什么以及为什么暂停。

复用 C4 的只读源投影、字段白名单与脱敏，不以 summary/checkpoint/旧 report 自行授予成功。
UI 只是观察客户端，不拥有调度、授权或最终真相；UI/浏览器失败不能影响 Campaign 执行。

## 最小实现

- 单机 HTTP 入口绑定 loopback，端口由 Host 配置；默认不暴露公网、不需要外部 CDN/模型/服务。
- 静态页面或轻量内置前端即可，不新增未授权依赖或通用管理平台。
- API 只允许读取白名单投影/诊断，有界结果；禁止以 query/path 读任意文件或泄漏 raw stdout/
  transcript/凭据。动态 text 在 HTML/JS 中正确转义，模型文本不变成脚本。
- Pi 命令如 /aegis board、tasks、dashboard（可选择不冲突名称）读相同投影，打印摘要/URL；
  无 UI/浏览器时输出地址即可，不强制自动打开浏览器。
- 本阶段不新增 HTTP 写接口；pause/cancel 继续已有 typed Host/Audit 路径，不被 UI 旁路。
- 进程资源启动/关闭明确，重复关闭安全；读取进行中的 EventLog 要显示当前可验证 committed
  快照或“刷新中/不可用”，不能把半行/坏链误报为 completed。
- 显示 last committed offset/digest、更新时间/是否过时、known limits；必要分页只为有界显示，
  不反过来要求重构报告或 F16 cache。

## required 验收

| 项目 | 必须观测 |
| --- | --- |
| 真产品入口 | 起 HTTP 服务，实际请求页面/只读 JSON，C3 fixture 的 queue/action/结果可见，不只测渲染 helper |
| 同源一致 | 页面 API/Pi 命令与 C4 源投影的状态/计数一致，新增 committed 事件后刷新反映，不用旧 summary 冒充 |
| unknown/控制/动态 | delayed、cancel/paused、提案 blocked/rejected/parent 和故障原因明确显示，不假成功 |
| 授权与隐私 | POST/写路径拒绝，无源/状态修改；路径 traversal 拒绝；秘密/raw 内容不外泄；HTML 注入样本不执行 |
| 体积/完整性 | 大量条目有界且分页/省略明确；半写/坏链显示 unavailable/integrity failure，保留最近可信状态时标 stale |
| 生命周期/非依赖 | bind localhost，关闭释放端口；UI 不可用不阻止 Host 完成；无自动网络/验收模型调用 |
| Pi 命令 | 真实 SDK/faux 命令注册/调用读取同源，无 TUI 时有可读输出/URL；核对实际 SDK API |
| 回归 | 受影响 C4 export/隐私/validator、C3/Observer 路径保持正确；F16 单列 deferred |

先冻结简洁接口、API 字段/界限和测试矩阵，再实现。测试验证实际 HTTP/SDK 效果，适量正负例，
不要求浏览器自动化全组合、性能 benchmark、复杂样式或固定 mutation 数量。
新增阻塞仅当前状态误报、机密泄漏、XSS/任意文件读取或状态/授权被 UI 修改；美化和后续能力后置。

## 交付与 Git

新任务分支 `feat/c4a-observation`，记录 baseline/工作树；明确路径暂存、本地里程碑 commit，
不 push/改写历史、不混入无关内容。不修改 Pi 核心、凭据/模型/lockfile，不触发真实模型/外部网络。
本地 loopback HTTP 与临时授权测试文件属于本任务观察面范围。
维护简洁 C4A plan/test matrix/implementation report，附可复制启动/关闭/命令、required/deferred、
实际 exit/log、源不变证据、commits/status/限制。内部通过后一次限定 C4a 验收，不自行实施 C5。
