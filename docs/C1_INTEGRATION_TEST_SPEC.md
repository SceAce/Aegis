# C1 跨模块收尾共同测试规范

状态：本轮测试生成依据。主DS和测试子DS先共同生成矩阵/脚本，再改产品实现。本文件列出case种子与expected，不伪装为已执行测试。

使用既有Node/assert模式、真实EventLog、临时产物、synthetic Worker/Oracle。复用AGENT_TESTING_STANDARD的多维矩阵，不安装新的测试平台，不接C2/C3真实服务。

## 1. 先生成的测试产物

建议新增或扩展少数有明确责任的脚本：

```text
tests/aegis-campaign-c1-integration-contracts.mjs
tests/aegis-campaign-c1-integration-scheduler.mjs
tests/aegis-campaign-c1-integration-recovery.mjs
tests/helpers/<有界的子进程harness>.mjs
```

名字可以主DS确定，但每个case必须映射到实际脚本/命令，不能文件还没创建就写pass。旧9组Campaign测试保留与基线对比；只有旧expected确实违背冻结契约才能说明后修正，不能让浅Oracle正例继续当完整可信输入。

测试helper仅生成原始Manifest、proposal、可信事件/Artifact索引与效果函数。禁止使用待测projector/aggregator计算expected。预期budget/任务状态写具体常量；重建等价测试可以比较两种真实路径结果，但还须独立断言关键用户行为。

## 2. case矩阵格式

每条必须含：case_id、对应C1EXT问题、入口、原始输入、单一改变字段、expected状态/产物/counter、层级、script/command、old-code red原因、new-code green、log/exit code、主DS审查结论。

不能只写“测试checkpoint”或“验证动态任务”；必须记录是否调用了createCampaignScheduler.run，是否采用真实EventLog，是否有真实本地进程，哪些judgment仍synthetic。

## 3. 最小输入/预期表

### ORDER / C1EXT-04

| case | 输入与动作 | expected |
|---|---|---|
| ORDER-POS | append reserve(seq=5)、consume(seq=0)，属于不同Episode，global顺序固定 | 先预留后扣账；无consume拒绝 |
| ORDER-NULL | 有sequence与null sequence混合，包括Oracle->completion | 按物理append顺序成功reduce |
| ORDER-TAIL | 最后committed记录是合法链中的被拒绝command | checkpoint tail指最后committed，applied诊断另列 |
| ORDER-BADCHAIN | 篡改一条JSONL内容/digest后Scheduler启动 | fail-closed，Worker 0次 |
| ORDER-IDEMP | 同command重送、同ID不同payload | 相同语义一次应用；冲突ID显示异常，不偷偷覆盖 |

### OUTCOME / C1EXT-01

正例必须从当前Episode的可信Outcome记录与临时Artifact索引构造，所有required criteria/stages已验证。TaskOracle来源、level、subject、scope和expected完整。

| case | 改变 | expected |
|---|---|---|
| OUT-POS | 全部匹配可信success | completed，依赖进入ready，outcome_id可追溯 |
| OUT-FOREIGN | Campaign/Task/Episode/Stage分别foreign | 不completed、不满足依赖，明确reason |
| OUT-CRITERION | criterion_id相同expected不同，或wrong criterion | 拒绝判断，不能复用旧success |
| OUT-NOREF | 缺/不可解析/错误digest evidence或缺scope/observed | 不success；保留unknown/invalid原因 |
| OUT-SOURCE | agent/observer/runtime伪oracle，自报verified | 不能制造Outcome判断 |
| OUT-PARTIAL | 仅一个required criterion或Stage有success | 整体不success |
| OUT-CURRENT | 旧success被legal unknown/failure替代或已stale | completed不能凭历史success通过 |
| OUT-CONFLICT | 同命题未解决的可信success/failure | conflict可见，相关依赖不推进 |
| OUT-REFMATCH | completed指向与当前成功不同/foreign outcome_id | completion拒绝 |

### COMMIT / C1EXT-02

在Scheduler真实入口分别对每个提交kind注入一次故障，不能只测started。故障分支包括`{ok:false}`、`{ok:true,durable:false}`、throw和真实EventLog fsync failure。

| case | 边界 | expected |
|---|---|---|
| COMMIT-BEFORE | started/reservation持久失败 | 无Worker效果，无伪成功 |
| COMMIT-BUDGET | Worker已执行，consumed写失败 | 返回明确degraded/fail，禁止后续Worker，保留intent用于恢复 |
| COMMIT-RESULT | Oracle返回完整结果但记录失败 | 不标完成/不推依赖，核对pending |
| COMMIT-DONE | result已durable，completion失败 | 恢复补completion，效果不重跑 |
| COMMIT-UNKNOWN | failed Worker后unknown/reconcile写失败 | 不返回空reasons的ok，不捏造已提交unknown |
| COMMIT-CONTROL | cancel/stop写失败 | 不声称持久取消；当前进程停止新dispatch，失败外显 |
| COMMIT-CLEANUP | 任一async/文件接口throw或run重入 | owner正确清理/单飞，不出现第二Writer或第二Worker |

效果是每Task独立sentinel/count文件，日志对应action/attempt。报告错误字符串不是唯一assert。

### DYNAMIC / C1EXT-05

| case | 动作 | expected |
|---|---|---|
| DYN-POS | submitted->Host policy->durable admitted->Scheduler | 不改初始数组，动态Worker实际运行 |
| DYN-NOSUB | 删除submitted，只inline合法proposal/admission | 不创建Task/不reserve |
| DYN-SWAP | admission中的inline proposal与submitted digest不同 | 拒绝，不借旧proposal_id |
| DYN-FOREIGN | foreign父Stage、target/capability/adapter、伪depth | 不admitted，checks原因可见 |
| DYN-OVER | fan-out/count/budget在limit-1/limit/limit+1 | 严格边界，不重复静态计数 |
| DYN-DUP | 重复admission/换随机ID重复同语义任务 | 不双任务/不双reserve/不双效果 |
| DYN-RESTART | admitted持久后、dispatch前退出 | 新Scheduler只靠Manifest+events恢复完整定义并运行 |
| DYN-DEFINED | admitted任务goal/stages/Oracle/stop条件缺失 | 明确错误，不静默break返回ok |

禁止summary.dynamic_admitted写常量；从实际admitted事件和投影得出数量，进一步检查实际Worker输入、产物与结果绑定。

### BUDGET / C1EXT-06

| case | 设置 | expected |
|---|---|---|
| BUD-POS | allocation=3，synthetic dispatch cost=1 | consumed=1、outstanding=2，其他Task不受影响 |
| BUD-ZERO | 当前Task allocation=0，Campaign有余量 | 默认blocked、Worker=0；若重新分配，必须先durable reserve再执行 |
| BUD-BOUND | need等于held / need>held | 前者执行且扣账，后者不执行 |
| BUD-TWO | 两个独立ready任务，共享硬limit | 不因排序先执行无预算Task；每次dispatch都守预算 |
| BUD-FAIL | Worker产生效果后返回失败或unknown | 已知synthetic成本保存；unknown成本不填0 |
| BUD-CRASH | 效果发生/扣账之前进程退出 | 余额/reservation恢复保守，不免费重跑、不双扣 |
| BUD-BAD | delta负数/小数/non-safe/NaN/错误类型 | 拒绝且账本不部分改变 |
| BUD-RELEASE | completion/cancel释放、重复release | 保持总额不增；pending effect额度按契约保留 |

本轮固定cost必须明确标synthetic。不能用1ms代替真实长任务耗时的测量。

### CONTROL/RECOVERY / C1EXT-07

| case | 设置 | expected |
|---|---|---|
| CTRL-CANCEL | cancel提交后销毁Scheduler，再创建/run | Worker=0，cancel保留 |
| CTRL-PAUSE | pause提交后restart | Worker=0，显式resume才继续 |
| CTRL-STOP | budget/manual stop restart | 不暗中恢复，不扩大额度 |
| CTRL-INFLIGHT | Worker运行时cancel/pause | 停止后续dispatch；当前intent有drain/reconcile记录 |
| REC-EXISTS | durable intent无result，真实sentinel表明effect存在 | fake Oracle读取后提交完整Outcome，Worker不重跑 |
| REC-NOTDONE | 明确证实effect未发生 | 记录核对结果，按动作retry policy处理；不直接非幂等重发 |
| REC-DELAY | reconcile返回unknown/delayed，然后迟到判定 | 未决可见，后续判断推进；Worker不为回填结果重跑 |
| REC-DONE | result持久、completion缺失 | 补生命周期，依赖可推进 |
| REC-SIGNAL | SIGTERM drain 与SIGKILL分别注入 | 正常退出与突然中断证据明确区分 |

仅有reconciliation.requested不算完成reconcile；assert fake adapter调用参数、实际artifact读取、Outcome和最终队列。

### CHECKPOINT / C1EXT-03

| case | 设置 | expected |
|---|---|---|
| CKP-POS | Scheduler快照正好匹配日志tail | 真正从缓存state恢复，used_checkpoint=true |
| CKP-PREFIX | 缓存为有效prefix，之后有submitted/admitted/budget/control事件 | prefix+tail与full replay完整state等价 |
| CKP-FOREIGN | 不同Manifest/Campaign/tail位置/digest/projection版本 | Scheduler拒cache并rebuild，不只调用readCheckpoint单测 |
| CKP-TAMPER | queue/ledger改了，payload digest重算但snapshot与prefix不一致 | 不能成为truth，重建 |
| CKP-BAD | 缺/半写/损坏/超前cache | fallback，结果预算与unknown不变 |
| CKP-WRITEFAIL | cache write/rename/fsync失败 | cache失败诊断，EventLog仍truth，无伪cache成功 |
| CKP-HASH | 摘要重新计算 | 真实SHA256，排除字段规则一致，非sha256:local |
| CKP-FULL | 删除所有派生cache/projection，只保留原输入+events | 完整队列、Task定义、索引、budget/control/pending一致 |

prefix replay测试比较完整可序列化snapshot（含dedup/提案/有效结果/控制），不是只assert队列一个Task completed。

### OWNERSHIP（保留并扩展现测试）

同进程两个Scheduler实例、同run并发调用、两个不同PID、live owner、dead reclaim、release/新owner竞态。barrier确保真实重叠，assert同时占有最多1而非进程串行启动。Claim owner中途被kill后需要fail-closed诊断或有界安全恢复，不删除未知活owner锁。

## 4. 完整产品入口Scenario

必须新增一组使用**createCampaignScheduler +真实EventLog**的端到端测试。允许synthetic Worker/Oracle，但不能直接手写所有Scheduler事件替代run，也不能预置动态任务进初始ownedTasks。

至少包括三条独立scenario，避免一个取消操作掩盖正常运行：

1. 正常链：两个static Tasks（B依赖A），A输出artifact后提出一个范围内动态Task，Host接纳，dynamic实际运行；Oracle为B先delayed后验证。Assert实际Task效果、完整Outcome归属、admission refs、预算、停止状态。
2. 故障链：intent/result/consumption/completion/checkpoint边界真实子进程kill或注入fsync故障；重启读取现临时产物核对，补结果/状态、不盲重发。
3. 控制/重建链：durable pause/cancel后重启不复活；合法prefix cache+tail等于full replay；删派生物重建相同语义摘要。

父进程通过IPC/文件barrier确认到达目标边界再kill，不依赖长固定sleep碰运气。计时器只是timeout退出保障。收集真实Child exit code/signal、event chain、每Task sentinel、adapter调用次数和账本具体数值。

## 5. 主DS审查与mutation

在全部实现集成后，主DS必须从用户场景trace每次调用：谁建source、谁检Outcome、谁提交admission、谁取Task定义、谁预留/扣账、谁缓存、谁恢复stop状态。

有限mutation选本轮跨模块guard：绕过Outcome绑定；忽略后effect append失败；恢复sequence排序；取消不恢复；inline无submitted仍admitted；动态任务只查初始数组；预算默借remaining不reserve；Scheduler不传/校验cache位置。

变异副本使用当前真实入口测试。删除一个冗余guard但state table仍有效可记录“冗余保护”，不伪称mutation被杀。报告不能以10/10数字代替实际覆盖。

## 6. 执行与交付

- 第一阶段先跑旧9组Campaign基线，再跑新增用例记录red。
- 每子任务focused green，依赖接口集成后run产品入口scenario。
- 最后一次跑全部required Campaign、Biome、Campaign tsc、8 offline和4 Pi/faux回归。
- 真实Pi回归使用source resolver；不运行真实付费API集合。
- run日志存ignored私有目录，矩阵docs只存case、退出码与非敏感摘要。
- baseline用真实HEAD+untracked源文件摘要；未知可明确标，不用全零值推导repo没commit。
- 交付两个状态：internal verification 与external acceptance pending，C2始终未启动。

没有实现/没有运行/被环境阻塞就记not_run/blocked。上述case数是输入清单，不等于实际断言数量。
