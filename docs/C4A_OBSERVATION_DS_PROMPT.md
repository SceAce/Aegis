# 给主 DS：实施 C4a 本地只读观察面

历史任务已交付并经本轮审查/授权修复，见 `C4A_EXTERNAL_REVIEW.md`。当前下一提示词为
`C5_INTEGRATION_DS_PROMPT.md`；不重复执行下文重开 C4a。

C4 本轮审查/授权修复已完成，记录 `docs/C4_EXTERNAL_REVIEW.md`。下一轮只做 C4a，
不重开 C1-C4，不把 F16 缓存、65 个旧类型诊断或 UI 美化作为阻塞。

先完整读 Pi_Agent_base/AGENTS.md、开发规范 §3.1、测试/Git 规范、
`docs/C4A_OBSERVATION_TASK.md`、C4 report-export/entry/shared report 和关联源码/测试。
Pi 命令完整核对实际内嵌 SDK 文档/API；不要凭记忆编造参数。

在干净起点建 feat/c4a-observation，冻结简洁 API 字段白名单/条目与字节界限/生命周期及
required 测试矩阵，然后自主完成内部小任务；没有子 Agent 工具就串行如实报告。

交付 loopback HTTP 的只读白板/队列/动作/结果视图，和 Pi 查看命令/摘要/URL。
复用 C4 同一 committed 源投影，显示动态任务、预算、Session、unknown/控制/故障/缺证据，
不要相信 summary/checkpoint/旧报告作为真相。浏览器不可用时打印 URL，不影响 Host 执行。

API 禁写；无任意文件读取或 raw transcript/stdout/秘密泄漏。请求参数路径校验、
HTML/JS 文本转义、有界列表、stale/integrity failure 状态明确。启动/关闭资源可控。
不加远程共享/CDN/通用控制面、不新建调度/授权入口、不做 C5 总集成。

按任务书 required 做实际 HTTP/同源/动态unknown/隐私与XSS/生命周期/SDK 命令测试，
先 red、再实现、再受影响回归；少量 mutation 按风险，禁止删弱断言伪绿。
源只读证明来自前后字节和实际请求效果，不仅看返回 text。
类型检查报告真实 exit 与旧基线，不关闭检查或清库。

遵守 Git：明确路径暂存、review、分里程碑本地 commit，不 push/rewrite，不改 Pi/凭据/
模型/lockfile、不用真实模型或外部目标网络。仅 loopback 服务和临时授权测试数据。
简洁计划/矩阵/实现报告附启动/关闭命令、actual checks/exit/log、required/deferred、
commits/status 和限制；复用报告，不生成重复长审计链。
完成 internally_verified / awaiting_external_review，交一次限定 C4a 验收，不自动进入 C5。
