# Batch C: verify-first actions 接入 Observer（用户授权今晚完成）

先阅读OVERNIGHT_TASK及ARCHITECTURE_DECISIONS前60行、THINK当前架构/9.1-9.4回答、现行Outcome/Experience schema，以及当前Observer/contest launcher/daily、B库 APIs全文。A已完成实际Runtime/RAM/effective board；B的action-contract/workspace-info-actions/script-registry/authorization库已存在。另一个DS在修learning-router/experience-compiler/contribution，只允许读，不允许编辑这些3个库及其测试。C写范围：Observer、launcher/daily、小型新adapter、新独立tests和C说明。禁止Pi core/auth/models/settings/旧Python/THINK改动，禁止真实目标网络/模型验收、git提交。

目标：真信息获取→Oracle验证数据→白板Fact→下一请求LLM可见→实际后续Action绑定数据→独立stage Outcome→贡献/每日复盘。同一single writer/EventLog，不平行demo。

- 注册受控 `aegis_observe`（本地ELF头格式/位数/机器识别至少一条）、`aegis_execute`（人类登记的已有脚本/参数模板/版本摘要/注册后态检查器）。使用稳定B APIs，全部请求先记录Event意图且fsync才能effect，Outcome字段/refs合法。Observer内部调用现有库返回verified数据，不LLM自称verified。目标是用户给定工作区；没有审阅script/remote config保持unconfigured，禁止任意eval、shell文本、模型传oracle callback。测试可注入可信TEST注册实现，生产不能暴露这种接口给LLM。
- 参数/目标实际路径/symlink脚本正文和解释器版本/pinned manifest检查；human auto/normal模式，normal未授权不effect（read观察按明确授权策略），非UI拒绝，auto不是事实验证。认证契约不表示OS沙箱；保留普通Pi工具但记录honest限界。
- 真实data/value/target revision+artifact保存在私有task runtime供refs解析。只摘要不用原始flag/凭据输出；Outcome goal/transport不同。已获取data下一provider-bound RAM看到，未验证候选不是hint指导。
- 真实动作绑定验证过的data ref+final args（实际action.requested/completed），LLM报告使用只是候选。trusted注册stage Oracle检查真实JSON输出artifact，把data/action exact ref纳入stage Outcome；待B2最终贡献API核验再用，暂不调用underreview函数授予成功。实现隔离adapter/resolver供B2 APIs后续接线。
- 候选映射到known action/checker返回明确gap/bound；不足证据candidate，现行active gate不放松。暂不声称任意散文自动规范/通用DSL完成。
- actual Pi faux多turn测试：先解析ELF数据，再临时注册script用位数绑定参数，后态Oracle读取JSON确认阶段进展；仅0exit不成功。stale/foreign/missing data ref、参数/版本交换、symlink逃逸、无授权、timeout错误分支都必须拒绝或unknown。原有15+新A测试不回归。
- launcher保留Observer+contest、当前cwd一条命令、task隔离目录，明确auto/normal switch/human target范围，新增owned tools实际可调用；无remote配置不能access网络。
- daily依赖真实runtime refs读出stage活动/当前有效Outcome/交接与unknown，提示metadata维持兼容，不复制另一套Outcome真相。统计未知缺失不能填0/自报贡献。
- 会话自动Host helper既有功能独立保留，不重构Pi交互UI。需要人类产品决定只写docs/OVERNIGHT_C_PENDING.md，supervisor后附THINK。完成后文件/API/实测/剩余表，不自说整个框架完成。
