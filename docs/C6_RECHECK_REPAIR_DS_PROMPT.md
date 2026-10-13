# 给主 DS：C6 修复复验剩余项

当前基线22d075c。原15个C6脚本、原22外部边界、学习closure和recheck既有13项均通过；
新增3个同provider gate路径反例仍失败，C6暂不进入真实环境测试。35b053a/旧X1-X12已闭环，不重复委派。
类型检查196条旧诊断、Campaign0条新增。
完整依据 docs/C6_EXTERNAL_REVIEW.md 第4节，旧 X1-X12 列表为历史，不重做已闭环项。

先完整读Agent入口、开发规范§3.1、测试/Git规范、原C6任务及本次审查，尤其 C6_EXTERNAL_REVIEW.md 第5节。
继续feat/c6-agent-product，复用现plan/matrix/report/runbook，按依赖自主完成以下五组，
不逐helper请示，最后一次限定复验，不引入缓存/并行/容器/真实模型新门槛。

1. 通用请求门（原X2/X4）
Task请求额度1，模型先连续aegis_read，仍发4次provider请求。
当前只有decision工具用terminate，message_end只是事后commit；pendingReservation第二请求起为null。
用SDK真实provider-bound请求边界统一准入：所有工具续请求/continuation均经过Task+Campaign预算、
每次输入窗口、wall-time与durable预留，不靠某个tool返回值阻止；工具调用/直接复用Broker动作也受限。
写预留失败不调用provider，可能发生后的记账失败停止dispatch/reconcile，不await/catch吞错误造成功。
持久源重建base/pending，清晰定义失败/中断费用；不可得token仍unknown，不调用真实provider。
复跑原ledger/外部suite，并补read/observe/control continuations、写故障、重启的实际计数/效果。

2. registered-test（原X10）
新harness包装node:assert时把strict函数改成不保留方法的wrapper，合法assert.equal测试报
assert.equal is not a function。合法正例必须先能通过，正常错误仍failure。
更严重：目标设置Error.prepareStackTrace伪造check.mjs帧，再process.exit(0)，answer=0却ok/complete=true。
stack文本由目标控制，不能证明验收完成；不能靠黑名单Error.prepareStackTrace/process.exit修。
选择最小可信Host完成协议/可验证标准，预定断言实际结束才success，提前exit/缺结果/timeout为unknown。
不让被测代码可变的堆栈/输出或公开结果文件替代真完成；保留外部test身份/标准检查。
这是当前脚本验收正确性，不要求新增通用OS sandbox。补合法assert模块、提前exit、伪造输出/帧控制。

3. 观察读取（原X5/X11）
aegis_read对allowedTargets仅lexical resolve/relative，grant名可指向workspace外symlink并读到外部内容。
复用现resolveInside/realpath语义，核对真实workspace与目标位置；当前Task grant而非整个Manifest集合。
拒绝路径/foreign target不输出外部内容，普通授权文件仍能读。不声称能抵抗恶意OS进程并发换目录。

4. runner初态（原X6）
独立work_dir已经落实，但attempt.initial_state无initializer时仅metadata，实际目标不变仍报告ok。
提供可信task-family initializer/reset或明确拒绝无法应用的初态；初始化/seed/config路径在实际attempt生效，
结果写实际而非期望，异常保留每attempt失败。不要默认为共享旧workspace已初始化。
保留实际独立目录测试，补真实初态读取、无initializer拒绝或合法初始化、失败清理及重复attempt。

5. 学习实证（原X8）
当前closure fixture的task-003在phase1已经completed，phase3零请求没有新action/outcome，无法证明direct。
将训练/编译/复用边界明确：前两次真实独立reset/同方法证据→真实Replay/原Compiler active→
第三个尚未执行的Task/attempt从前态产生NEW Broker intent/effect/Oracle结果，零provider规划。
不改不可变Manifest来复活旧终态，不手写active，不只读取已有completed作为成功。
已编译经验删除派生重建后新Task仍复用；缺参数habit只绑定重验，冲突/环境变更退出捷径。
当前pre_state仍取task.initial_state声明、verified_by指post artifact；须在副作用前实际观测/校验reset，
独立来源refs证明when，不能声明初态充当观测。不同Episode标识不能自己生成独立证据。
route必须读包含刚committed currentState数据的最新resolver；异常/日志失败不隐式普通planning继续。
补原P5真正动作/现态/变化场景，学习效果统计仍后置。

已有反例请保留：
node --test Pi_Agent_base/tests/aegis-c6-external-boundaries.mjs
  22 tests/21 pass/1 fail（新增read-budget，额度1实际4次）
node --test Pi_Agent_base/tests/aegis-c6-recheck-boundaries.mjs
  5 tests/1 pass/4 fail（合法test、帧伪造、symlink、initial state）
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-c6-learning-closure.mjs
  原检查保留，新增3个check失败（task-003提前completed，phase3无新intent/outcome）
证据runtime/dev/c6-recheck/为ignored。断言可按真实契约调整测试fixture，不能删真实行为要求或skip。

先focused修复与green，再全部C6与受影响显式回归。有限mutation按critical guard，不设数量配额。
SDK docs/API完整核对；不降低checkJs/类型/证据门，旧196按实际配置保留，新签名诊断修复。
共享Host/Observer/SDK/ledger/Oracle由主DS统一管理，子Agent有能力才并行不相交文件。
逐路径暂存、读staged diff、本地里程碑commit注明Agent协助，不push/rewrite。
不改Pi核心/用户auth/models/settings/lockfile，不安装未授权依赖、不读真实凭据或调用模型/外部目标。

交回本次剩余项对应表、exact argv/exit/log、pre-call/durable/实际次数、正常Oracle/无假完成、
授权读取、runner真实初态、NEW经验动作/结果/reset/rebuild/habit证据，以及commits/status。
状态internally_verified / awaiting_external_review或实际blocked。不要自行外部通过，
用户具体provider/本地模型pilot在工程复验通过后再单独处理。
