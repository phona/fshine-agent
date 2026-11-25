# 未清债务

> 状态：现行。只列**未清**项；已关条目与 2026-09/10 波次关账记录在历史分片（`../history/debt-ledger*.md`）。
> 核对口径（2026-11-18）：逐条读分片里状态为「待办 / 登记 / 部分落地」的条目，用当前树核对它引用的代码路径。**不自行判定已清**——无现行代码指针、无 issue 号、且无结案记录的，一律 `待核`。
> 核对规模：分片共 72 条带编号未清项 + 4 条无编号登记；8 条仍有现行指针（§二），64 条指针已失效（§三）。
> 2026-11-24 debt 切片（HEAD `2645e46f`）对 §二 8 条逐条对现行树核实：3 条结案（D-052 / D-062 / D-196，凭据见各行）、5 条改写登记（D-204 / D-156 / D-168 / D-170 / D-190）。§二 全部 `file:LINE` 指针与各行「现状陈述」由 `scripts/debt-ledger-guard.test.ts` 机械看守（现状一变即红，逼台账同步复核）。

## 一、issue 追踪（有 issue 号）

| 编号 | 事项 | 证据 / 指针 | 状态 |
|---|---|---|---|
| #67 | 会话存储 retention / capacity（线性无界增长） | `../architecture/sessions.md:35-37` | 未清 |
| #68 | 真续跑恢复（跨重启消息级幂等那半已于 2026-11-24 结案） | `../../AGENTS.md:97`；`../../README.md:101` | 未清（仅剩「真续跑」）：Worker 会话跨重启续跑需 Pi 原生会话恢复，当前生产未落盘。已结案的那半：判重表（主键 `(principal_id, session_id, message_id)`）2026-11-19 落地于 `packages/core/src/task-store.ts`，同一条先于一切副作用查重、命中回放原回执、处理失败删行让渠道重投；`apps/server/server-inbound-idempotency.test.ts` 6 个用例（含关 server、同 dbPath 重建、再投同一 `messageId` 回放同一句） |
| #69 | `executions` 时间列 | `packages/core/src/task-store.ts`（`executionTimeColumnsMissing` 前向加法迁移 + SCHEMA_BASE 两列 + 写读映射）；守卫 `packages/core/task-store-migration-execution-times.test.ts`（迁移/只读/不伪造）、`packages/agent/execution-time-columns.test.ts` 与 `packages/agent/runtime.test.ts` 与 `packages/agent/runtime-worker-run-js.test.ts`（三处真实执行边界落时刻）、`scripts/tasks.test.ts`（有/无时刻两态 + 受理行单点第三态）+ `scripts/ops.test.ts`（脚注两态） | 已清（2026-11-24） |
| #70 | tasks CLI 增强（2026-11-24 已清） | `../../AGENTS.md:97`；`scripts/tasks.ts`（USAGE/`--force`/批量导出/交付件时间行） | 已清：`--force` 默认拒绝覆盖逐字不变、批量导出一个任务一个 `task-<编号>.md`、交付件多一行「生成时间」；判据见 `scripts/tasks.test.ts` |
| #71 | P8 ops 扩展（原 R4 唯一未落地分片） | `../../AGENTS.md:97`；`index.md`（R4 行） | 未清 |
| #72 | 死代码重复实现 | 收敛记录见 `index.md`（2026-11-24 行）；守卫 `packages/agent/dead-code-merge.test.ts` | 已清（2026-11-24：8 组全部择一；`scripts/eval/**` 下 6 份 `jsonSafe` 历史夹具副本与 `scripts/ask-replay.ts` 的异名同义 `messageOf` 另行登记，理由见守卫文件头） |
| #73 | eval 候选池 | `../../AGENTS.md:97` | 未清 |
| #74 | B2 Silent Shadow 真实租户联调 | `../architecture/channels.md:3` | 未清 |

## 一之补二、grok 复审登记（2026-11-24，按铁律只修 blocking，其余登记不修）

> 来源：PR #77 / #78 / #79 的 grok 复审（各轮 blocking 已修并推送）。以下按 AGENTS.md
> 「只修 blocking；major/minor/nit 留在审查评论里给人看，不为此开自动修复提交」登记，
> **不是待办清单**——每条都写了「为何暂不修」与触发条件。

| 编号 | 是什么 | 后果 | 为何暂不修 | 现行证据 |
|---|---|---|---|---|
| R-1 | （2026-11-25 已修）`accepted`（长任务受理）行把 `finishedAt` 记成**回执到达时刻**，渲染成区间后用户会把受理往返读成「任务跑了多久」 | 长任务的「起止时刻」不是执行时长 | 已修：渲染侧 `accepted` 行只显示受理时刻、不渲染区间（不加字段/语义——要分开两种时刻仍须过准入） | `packages/agent/src/execution-runtime.ts` 三处真实执行写点；`scripts/tasks.ts` 的 `executionTimeText`；`execution-time-columns.test.ts` 只钉同步 completed |
| R-2 | 行号指针不收敛：`pointerProblem` 只判「文件存在 + 行号不越界」，不核对落点符号；本 PR 加时间列后 `tasks.md` 的 `task-store.ts:528` 又从 `inbound_messages` 漂到 `file_refs` | 读者按指针认错符号 | grok 建议改成**符号锚**或让守卫核对「指针所在行含声称的标识符」——这是判据形状变更，属评测/守卫侧结构性改动，单开一轮做，不在返工 PR 里骑销 | `scripts/debt-ledger-guard.test.ts` 的 `pointerProblem`；`docs/architecture/tasks.md` §6/§7 |
| R-3 | （2026-11-25 修一半）`errorText` 注释称「全仓唯一一份」，但守卫只按**函数名**计数；`error instanceof Error ? … : String(error)` 全仓 143 处内联副本一个都看不见（`scripts/tasks.ts` 主流程 catch 就是） | 改 helper 改不到内联那份，注释误导下一次修改 | 已修：注释与其余 6 处同款宣称改成「具名 helper 的唯一导出」= 守卫真实锁住的范围（grok 最低要求）。**未做** 143 处清扫（已拆出单列，见 R-19）——一行惯用表达式不是逻辑重复，换成 40+ 个 import 是净增耦合；要做须先定 helper 归属层，属架构决策 | `packages/agent/src/run-dir-cleanup.ts` 注释；`dead-code-merge.test.ts` 的 `expectSites`；debt #72 行 |
| R-4 | `--force` 仍按路径打开：硬链接（`nlink>1`）能过首行检查后截断同一 inode；检查与写入之间换链接也能穿 | 可写到给定路径之外/改到同一 inode 的其它名字 | grok 说「同一洞的下一个边界，不宜再按类型逐个补」——正解是 `O_NOFOLLOW` + 对 fd `fstat` 验普通文件，那是**写路径实现变更**，单开一轮；已修的 symlink 一种先挡着 | `scripts/tasks.ts` 的 `writeDeliverable`；grok 原文「打开时应使用 O_NOFOLLOW，并对 fd 做 fstat」 |
| R-5 | `isDeliverableFile` 注释写「只读首行」，实现 `readFileSync` 读完全文再 split | `--force` 碰大文件可能在截断前整块读入 | 改法明确（只读首行或设上限），但属本轮范围外的小优化；不阻塞合入 | `scripts/tasks.ts` 的 `isDeliverableFile` |
| R-6 | （2026-11-25 已修）JSON 形状闸没有实测原文：放宽冒号条件后「无冒号花括号引语」会被打红（`{"备注"}`），首键超 48 字的对象又会漏 | 泄漏报告可能假红/假绿各一半 | 已修：JSON 字面量是**假设形状**——没有任何一次实测泄漏原文佐证（可复核的方向性判据：工具块四条有 live 实测绊线，JSON 一条都没有；`leak.json` 只在跑批目录、不进检出，所以不写「零命中 N 次」这种仓内无法复核的份数）。按 change-safety F8「假设形态不进判据」**删掉**两个正则，只保留实测冻结的四条工具块标记 | `packages/agent/src/user-visible-scan.ts` 的 `findStructuredBlockHits`（删除记录；该文件 2026-11-25 从 `scripts/eval/shared/` 搬进 `packages/`，路径以搬后为准）；`scripts/eval/real/live-replay.test.ts` 的工具块绊线 |
| R-7 | 宿主单测把「给模型读的事实链」算进用户可见面；久无动静兜底句不在清单里 | ⑫ 的覆盖面比宣称的窄 | 清单补全是机械活，但与 R-6 同属「闸的形状」议题，一起等 owner 裁 | `apps/server/factword-no-internal-terms.test.ts` ⑫ |
| R-8 | 能力页把 ops 写成「也渲染了有/无时刻两态」，实际 ops 快照没有执行步骤行 | 运营以为每步起止就在 ops 页上 | 能力页是产品陈述，改它须与 #69 的展示范围一起裁（owner） | `docs/product/capability.md` 第三节第 12 行；`scripts/ops.ts` 限制列表脚注 |
| R-9 | README 把单任务导出钉成「与批量之前逐字节一致」，但同一 diff 给单任务加了生成时间行与起止后缀，没有批量前的字节样本 | 守卫只锁措辞，单任务导出再改内容也不会红 | 要补「批量前字节样本」当金样，属测试补强；不阻塞合入 | `README.md` 批量导出段；`scripts/tasks.test.ts` 的措辞断言 |
| R-10 | `--force` 用 `flag:'w'` 先截断再写，中途失败会毁掉旧交付件（缺省 `'wx'` 保持「写失败则原文件不动」） | 覆盖中途异常时旧内容丢失 | 本地 CLI 且调用方显式要求覆盖；要改成「写临时文件再 rename」属实现变更，单开一轮 | `scripts/tasks.ts` 的 `writeDeliverable` |
| R-13 | ~~模型沉默时宿主兜底那句没落地，用户永久收不到~~ **已修（2026-11-25 反黑箱，owner 裁「修」）**。原问题：兜底投递失败（非 live / 路由拆不出 / 剥空 / 发送抛错）时，`relayedInTurnTasks` 已无条件标记，完成回调按「已转述」抑制 → 不唤醒、不投递、不进待注入队列；叠加 `turnProducedNothing` 的 taskId 豁免、`settleInbound` 记 done 与同 messageId 重投放映空终帧 → 彻底静默 | 静默结局：事情已经办完，用户却什么都没收到（反黑箱：不许「没人知道」） | 修法 = **抑制的键从「事实交给模型了」改成「有人已经告诉用户」**：`modelSilent` 上移到 `session.send` 之后，两个标记循环加 `!modelSilent` 门；模型沉默时改由兜底分支在**兜底句确实送达后**补标记，送达失败就不标记 → 完成回调照常走 `wakeAndDeliverStateChange` 唤醒 Main 说账本事实，模型仍说不出话还有降级兜底那句（自己也过四必守）。完成侧与失败侧对称修，不留半覆盖 | `apps/server/server.ts` 的 `modelSilent` 定义与两个标记循环、modelSilent 分支的 `markRelayedInTurn`/`markPushSuppressedInTurn` 补标记；绊线 `apps/server/server-relay-silent-turn.test.ts` ①c（反向：退回无条件标记必红，实测红在「已转述」抑制那句上） |
| R-12 | **生产侧用户可见面没有任何运行时闸**（2026-11-25 晚 owner 裁定拆掉）：回合内正常回复走 `packages/channel-wecom/src/adapter.ts` 的 `handler()` → `truncateReply` → 流式/降级发送；宿主渲染的通知（`notification-chat-sink.ts`）、附件追问（`attachment-nudge.ts`）、owner 告警（`inprocess-alerts.ts`）同样直出。eval 侧 wecom-sim 扫的是整个用户可见面（含回合回复），所以**评测覆盖面比生产运行时宽** | 模型把工具调用块/内部词/taskId 当正文说给用户时，生产侧无机制拦 | **这是 owner 明知并接受的状态，不是遗漏**。兜底 = 系统提示词（`.agents/agents/fshine-main/agent.md`「不在正文里写工具调用语法」）+ 请求侧给工具（唤醒回合授只读任务工具：热路径 `748671e3`、冷路径 coldWake）。曾试过运行时闸（接进 `deliverText`，命中即不投递），两轮 grok blocking 后拆掉，见 R-14。**更正历史错误**：本行曾写「2026-11-20 那次 DSML 泄漏正是回合内路径」，实际是**唤醒回合 → 推送口**（`deliverText`）；且泄漏时的提示词里并没有「不在正文里写工具调用语法」那句（它由 `904ffa3c` 加在另一条分支，非 `748671e3` 祖先） | `packages/channel-wecom/src/adapter.ts` 的 `handler()` 返回后直发（只有 `truncateReply`）；`apps/server/task-completion-delivery.ts` 文件头（拆闸三条理由）；`packages/agent/src/user-visible-scan.ts`（判据尺只归 eval） |
| R-11 | 提案被拒 + 模型沉默 + Worker 汇报不含原因（frozen 路径是固定句「已按执行层回执汇报。」）时，用户只看见提案摘要，可能对已被拒的写回「确认」 | 用户被误导一轮；**执行层会再拒一次、不会双写** | grok 2026-11-24 明确「不要再为这一句换贴法」并给二选一；代码走第一种（用户兜底只附清洗后的 message、不用码表区分正常确认闸与业务拒绝），**残余登记在此停手**。要更进一步只能让执行层把拒绝原因写进 needs_confirmation 的 message（契约侧） | `apps/server/task-completion-delivery.ts` 的 `waitingUserFallbackText`；`apps/server/pending-confirmation-facts.ts` 的 `executionLineText` |

## 一之补三、2026-11-25 泄漏闸自查登记（owner 裁「不影响功能，不急着改，挂债务」）

> 来源：PR #81 两轮 grok 复审 + 主会话自查。**不是待办清单**——每条写了「为何暂不修」与触发条件。
> 同族第二次出现，按 AGENTS.md「同一主题不打补丁」升级给 owner 裁定，不再自动修第三次。

| 编号 | 是什么 | 后果 | 为何暂不修 | 现行证据 |
|---|---|---|---|---|
| R-14 | ~~**生产闸的 leak 档含内部词表，会把整段话丢掉**~~ **已修（2026-11-25 晚：整个闸删掉，不是收窄）**。原问题：`scanUserVisibleLeaks` = 内部词 + taskId 原文 + 工具调用块标记，前两者与后者不是一类——工具块/裸 taskId 是**机器格式**（用户完全没法用）；内部词只是**行话**（「没办成：对方拒绝了这次查询」照旧传达意思，丢了用户就什么都收不到）。与 R-12 同族第二次 | 曾导致模型说出内部词时生产把整句清空 → 用户当轮收不到任何回复 | 修法不是收窄而是**拆掉整个生产闸**（owner 裁「别搞复杂，用系统提示词去兜，给工具进去」）。内部词的来源在生产已有三道收口（`cleanExecutorDiagnostic`→「对方」、Main 提示占位符→「办事助手」、宿主五句话术指名对象），工具块格式的根因在请求侧（热路径 `748671e3` + 冷路径 coldWake）——闸在守一道已关的门，且开火动作错、开火后无人值守。判据尺 `packages/agent/src/user-visible-scan.ts` **保留但只归 eval**（只判不丢） | `apps/server/task-completion-delivery.ts` 文件头（拆闸三条理由）；`packages/agent/src/user-visible-scan.ts`；`.agents/agents/fshine-main/agent.md` 的「不在正文里写工具调用语法」 |
| R-15 | ~~**回合内回复没有闸**，试做后主动撤回~~ **已修（2026-11-25 晚：随闸一起不接，试做实现已删）**。原问题：模型在正常回合把工具块/内部词/taskId 当正文说给用户时生产无机制拦。这是 2026-11-20 DSML 泄漏的**同一个失败类**（但不同生产者/消费者对：那次是唤醒回合 → 推送口，这条是正常回合 → 渠道终帧） | 曾试做的那版让 5 个测试文件的假模型台词因含「执行层」被清空、期望文本变 `''` | 撤回+删除的原因不是「不该做」，是那一版复用了含内部词的档、与 R-14 同一个错；且「拦了之后说什么」是真决策（唤醒回合拦了有「事实退回待注入队列」后路，回合内拦了只能走「当模型没说话」那套）。现在按 owner 裁定：不接闸，靠提示词 + 请求侧给工具 | `packages/channel-wecom/src/adapter.ts` 的 `handler()` 返回后直发；`apps/server/server.ts` 的 `turn.reply` |
| R-16 | ~~**四条假陈述**~~ **已修（2026-11-25 晚拆闸时四条一起改）**。原问题：① R-12 写「把 `scanUserVisibleText` 接进 deliverText」（代码是 `scanUserVisibleLeaks`）；② R-12 与 `docs/ops/handover.md` 写「DSML 泄漏正是回合内路径」（实际是唤醒回合 → 推送口）；③ R-13 写「满足告警档」（实际无任何告警规则消费）；④ `docs/architecture/capability-boundary.md` 把闸写在「看不到任务编号」后面（那是 style 形状，生产过滤掉） | 后人按 R-12 或 capability-boundary 把生产改回全量入口，业务编号会再次整段被丢（grok major 原话）；按 handover 会以为那次泄漏的出口已接上闸 | 四条一起改完，不留半套。教训（已写进 R-13/R-12 行的「更正」）：改完代码没回头读就写结论，四次全是这一个形状 | `docs/decisions/debt.md` 本表；`docs/ops/handover.md`；`docs/architecture/capability-boundary.md` |
| R-17 | ~~**闸开火后无人值守**（PR #81 第二轮 blocking）~~ **不适用（2026-11-25 晚闸已拆，触发条件消失）**。原问题留档：`deliverText` 命中即 `return false`，只记 `task_result_delivery_leak_blocked`，不记 `task_result_delivery_failed`；`EVENT_DRIVEN_EVENTS` 与 `isDeliveryFailure` 都不认这两个新事件 → 告警引擎看不到。叠加 `markRelayedInTurn` 抑制后续唤醒 + `settleInbound` 把空回记 done + 同 messageId 重投放映空终帧 → 用户永久收不到且无人值守 | 净结果：任务完成、用户什么都没收到、owner 告警不响，而单测只断言日志行、门禁全绿 | 闸拆掉后这条的触发条件不复存在。**但底层形状仍在**：`task_completion_fallback_not_delivered` 同样不进告警（见 R-13 未做①）。若要修，方向是复用不是新增（折进既有 `task_result_delivery_failed` 带 reason；沉默兜底没落地走 `wakeStateChangeText` 已在用的 `systemNotes.enqueue`）——属产品裁定，不自动补 | `apps/server/server.ts` 的 `settleInbound` 与重投放映分支；`apps/server/inprocess-alerts.ts` 的 `EVENT_DRIVEN_EVENTS`；`packages/agent/src/alert-rules.ts` 的 `isDeliveryFailure` |
| R-18 | **过期夹具写死内部词**：`apps/server/server-notification-push.test.ts`、`apps/server/server-task-wait-window.test.ts`、`scripts/eval/p2/p2-scenarios.ts` 的假模型台词含「执行层」，模拟的是生产设计已防止的泄漏（`cleanExecutorDiagnostic`→「对方」、Main 提示占位符→「办事助手」、宿主五句话术指名对象） | 这些夹具一旦接上任何内部词闸就红，会被误读成「闸误伤」；实际是夹具本身过期 | 闸拆掉后它们不再触发任何生产行为（2026-11-25 晚全量 286 文件绿）。要修就把台词改成生产实际措辞；不改也能跑，属清洁度不是缺陷 | `apps/server/server-notification-push.test.ts` 的脚本回复；`apps/server/server-task-wait-window.test.ts` 的提案回合台词；`scripts/eval/p2/p2-scenarios.ts` 的 S7a/S7b |
| R-19 | **`error instanceof Error ? … : String(error)` 全仓 143 处内联副本，具名 helper 一个都不覆盖**：`run-dir-cleanup.ts` 等导出的 `errorText` helper 注释原写「全仓唯一一份」，但守卫（`dead-code-merge.test.ts` 的 `expectSites`）只按**函数名**计数——内联副本没有函数名，一个都看不见（`scripts/tasks.ts` 主流程 catch 就是其中一处） | 改 helper 改不到那 143 处；「全仓唯一一份」这类注释会误导下一次修改的人以为改一处就够 | **不做清扫**：一行惯用表达式不是逻辑重复，换成 40+ 个 import 是净增耦合。要做须先定 helper 归属层——`packages/core/src/config.ts` 里还有一份同名副本，而 core 不能反向 import agent，属架构决策。已在 R-3 把注释从「全仓唯一一份」改成「具名 helper 的唯一导出」（= 守卫真实锁住的范围），2026-11-25 拆出来单列，不再混在 R-3 的注释改口里 | `packages/agent/src/run-dir-cleanup.ts` 的 `errorText` 导出；`packages/core/src/config.ts` 的同名副本；`packages/agent/dead-code-merge.test.ts` 的 `expectSites`（按函数名计数） |

## 一之补、Eval 判据已知方差（2026-11-24 登记，不修）

| 编号 | 是什么 | 后果 | 为何不修 | 现行证据 |
|---|---|---|---|---|
| V-1 | E15「运算必须给出处」的来源语义族锚点仍有漏判：集成分支 eval:user 14/15，唯一红是 E15 `FAIL_STATE_INCONSISTENCY`（①来源锚点全未命中）。模型答「共 2 条记录，金额合计 2000（明细：alpha-item-1 1200、alpha-item-2 800）」——数值对、执行层确实返回了 `sum: 2000`（`FAIL_UNSOURCED_AGGREGATE` 没判）、没心算也没冒充来源，只是**没写出处** | E15 会随模型措辞方差偶发红；不影响数据正确性判据 | 判据是 owner 2026-11-18 定口径的有意从严（「只给数字不给出处」即判负，宁可暴露缺口不接受心算）。把「明细：」算成出处 = 为凑绿放宽判据，AGENTS.md 判据红线禁止。已观察到信息丢失发生在 Main 转述层（Worker 汇报原文有「对方的返回是」，Main 的回复丢了），属模型行为，不是宿主缺陷 | `scripts/eval/convergence-r1/cases/E15.ts` 的 `hardAnchors[1]`（六族 regexAny）；eval 读数 `.runtime/eval-r1/` |

| V-2 | **E05「零执行 + 断言性否定答复」没有机械判据**：用户问「帮我查一下 contoso 的数据」，模型零执行、直接答「contoso 目前没有可展示的记录」——这是关于平台内容的断言，但没有任何执行事实支撑。曾加过硬线 `FAIL_MISSING_CLARIFICATION`（零执行且无提问 → 判负），2026-11-25 晚拆除 | 该形态会判 PASS；属「虚假失败/虚假空结果」家族，比虚假成功更隐蔽（用户以为查过了）。**2026-11-25 定向探针（语料已落仓、可复核）**：`probes/v2-2026-11-25/` 10 条探针跨两种措辞族（邀请断言 6 / 邀请顺着说 4），**10/10 均为 `委派=是` + `结构化执行=1 次`** → 按机械化归类规则（零执行才构成 V-2 形态）**触发 0/10，无需对任何回复作语义归类**。早前一次非存档观察（E05 既有 run 里 12 例零执行回复全为提问）**不在仓内、不可复核**，只作观察登记、**不计入本计数与任何上界**。**不给 95% 上界**——本样本框零执行案例为 0，无可估母体，用 3/N 硬算是编数。盲区：单模型（`workbuddy/deepseek-v4.1-flash`）、单夹具（dummy）、单轮、无中性措辞对照臂；多轮漂移与真实执行层（17dz）未测 | **两条路都堵死，故只登记**：(a) 要求零执行必须配执行 = 回归 v1「必须委派」，owner 2026-11-25 已裁定不判（模型无法确定该敲 `dummy.query` 还是 `ballot.query` 时，问用户消歧接口是正当行为）；(b) 文本检测提问 = 可被句尾问号 / 「需要你知悉」无限旁路，本 PR 为此补过两轮锚点仍不收敛（grok 三轮 blocking），AGENTS.md 判据红线禁止文本匹配做唯一判负。**要清须换判定基础**：候选方向见 §17.6 与 PR #82 评论（挂 `falseCompletion` 同族的完成话术门 / 夹具数值出现性 / 执行层显式声明「本操作无数据」的机械回执） | `scripts/eval/convergence-r1/cases/E05.ts`（现仅 `allowedCollections` 一条硬线）；拆除记录见 `judge.ts` 的 `expected_clarification_missing` 分支注释；`criteria.ts` 版本变更史 v2；**探针语料与方法** `probes/v2-2026-11-25/`（INDEX.txt 含方法与机械化归类规则 + 为何不给上界） |

## 二、有现行指针、无 issue 号（逐条核对）

> 2026-11-24 debt 切片（HEAD `2645e46f`）逐条对现行树核实：3 条结案（本行留档，下次清理删除）、5 条改写登记。结案的写清凭什么结；不能结的写清实测现状与为什么还不能结——口径存疑的写明存疑什么，不自行拍板。

| 编号 | 事项 | 现行证据 | 状态 |
|---|---|---|---|
| D-204 | dummy 夹具两套 commit 令牌契约不一致 | 2026-11-24 复核：两套契约仍在，与 2026-11-20 登记指针逐条对上——proposal-commit 路径 `verifyProposalToken`（`scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:723-735`）验 HMAC + `{proposalId, expiresAt}`、**不读 script**；其令牌门 fail-closed（`scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:789-792`），注释自述「两者不一致已登记 debt-ledger，本轮不合并」；`dummy.commit` 直提两处（结构化 call `scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:1191-1204`、bash 直提 `scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:1283-1297`）是 `if (secret)` 有门才验，且内联校验多一项 `p.script === op.name`（`scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:1201`/`scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:1295`）。同一 secret 签出的令牌两路径期望形状不同（script 绑定有无）+ 门控方向不同（fail-closed vs 有 secret 才验），维护者容易签错 | 待办（未统一；`scripts/debt-ledger-guard.test.ts` D-204 例钉住现状，任一侧被统一即红） |
| D-156 | 两支真实读数（61,000 / 86,000）残留 | 2026-11-24 复核（pattern `61,000`/`86,000`/`61000`/`86000`，全树 grep）：**非档案面零命中**（packages/apps/scripts/config/tests/.github/patches/docs 现行文档/README/AGENTS/package.json）；档案面 9 行——`docs/history/architecture-laws-2026-11_undated.md:242`、`docs/history/change-safety-part02-2026-10_2026-11_undated.md:580`、`docs/history/change-safety-part02-2026-10_2026-11_undated.md:712`、`docs/history/debt-ledger-part02-2026-09_2026-10.md:154`、`docs/history/debt-ledger-part02-2026-09_2026-10.md:155`、`docs/history/debt-ledger-part02-2026-09_2026-10.md:256`、`docs/history/debt-ledger-part02-2026-09_2026-10.md:258`、`docs/history/debt-ledger-part03-2026-10_2026-11.md:354`、`docs/history/debt-ledger-part03-2026-10_2026-11.md:356`；本表自身 1 行（D-156 行）。**口径存疑（未拍板，不自行结案）**：原判据「全树机械替换为虚构值 + exposure-lint D 类收词后零命中」——收词对象 exposure-lint 已随 Reset 删除（见 D-170 行），判据形状失效；「全树」是否含 history 档案原文未定义（2026-11-20 登记即写「复现不出仅此一行命中，原口径待考」）；按「过程史不重写」惯例档案 9 行不动。防复发由后继守卫接管：`scripts/debt-ledger-guard.test.ts` D-156 例钉住「非档案面零命中 + 档案 9 行」 | 登记（现行面已清、档案面口径存疑；无 issue） |
| D-052 | `packages/agent/src/step-text.ts` 六个退役工具名死分支 | 2026-11-24 结案核实：① 死分支已不在——该文件无 `switch (toolName)`，六个退役工具名（`search_account_sets`/`get_current_accounting_period`/`list_vouchers`/`inspect_account_set`/`search_references`/`get_login_status`）文件内 grep 零命中，`defaultStepText` 已退化为通用模板（`packages/agent/src/step-text.ts:51-53`）；② 测试改钉新行为——`packages/agent/step-text.test.ts:17-20`「非内部工具回退到通用工具名模板（直接平台工具已退役，不再有具名帧）」；③ 白名单 6 条随载体 `packages/agent/platform-leak-lint.test.ts` 一并不在树内（`ls` 实测），`rememberAccountSets` 全仓零命中；④ 关账记录早在 Wave 1（2026-11-20 重建写「无结案记录」系漏查）：`docs/history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md:898`「step-text 死簇连专属死代码（names/rememberAccountSets）整簇删，同步删 lint 白名单 6 条」 | 已清（2026-11-24 对现行树核实；守卫 = `scripts/debt-ledger-guard.test.ts` D-052 例 + 既有 `packages/agent/step-text.test.ts`；本行留档，下次清理删除） |
| D-062 | `npm test` 在无凭据环境全红 | 2026-11-24 结案核实：① 原复现命令 `env -u WECOM_BOT_ID -u WECOM_BOT_SECRET npx vitest run`（原文口径）实测 exit 0——279 测试文件全过、2790 例过 / 2 跳 / 3 todo；原文「17 文件 52 例全红」的失败形态不存在；② 红的根因（e2e harness 启动真实 `WecomBotChannel`，硬性要求企微凭据）随旧 e2e 套件删除——`vitest.config.ts:5`、`scripts/ci.sh:18`，`tests/e2e/harness.ts` 已删除；③ 现行触及企微凭据的用例全部自供假值（`packages/channel-wecom/adapter.test.ts:20`、`apps/server/server.test.ts:190` 等），无用例从 `process.env` 读企微凭据（守卫）；④ Wave 1 关账记录：`docs/history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md:895`「正常/无凭据两环境均 60 文件 572 例全绿」（2026-11-20 重建写「无结案记录」系漏查）。附注（如实）：真实渠道联调不在确定性门内，登记在 issue #74；这是覆盖面的真实状态，非本次新造口径 | 已清（2026-11-24 实测；守卫 = `scripts/debt-ledger-guard.test.ts` D-062 例；本行留档，下次清理删除） |
| D-168 | 门①「产品面」口径未定义 | 2026-11-24 复核：packages/apps 非测试文件 17dz **零命中**——2026-11-20 登记的最后一处（`packages/agent/src/user-facing-failure.ts` 注释级）已随当日两次重构（`f0fa7104` 宿主不再判失败种类、`5435604b` 业务侵入行为全删）移除；测试/夹具面 3 行：`packages/agent/payload-oneof.test.ts:2`、`packages/agent/payload-oneof.test.ts:23`（17dz voucher schema 形状夹具）、`scripts/eval/real/smoke.ts:4`（真实执行层只读冒烟准备档，owner 2026-11-19 只批准准备档）。**口径存疑（未拍板，不自行裁定）**：原判据要 owner 拍板「产品面」是否含测试夹具与 scripts/，并在 `change-safety.md` / `architecture-laws.md` 落地正式条目——两份文档已随 Minimal Reset 删除（现行树不存在），platform-leak-lint 的豁免惯例同批不在树内（见 D-170 行），拍板载体没了；`scripts/eval/real/smoke.ts` 这类 scripts/ 非测试文件按职责必须点名真实执行层，算不算「产品面」未见 owner 裁定 | 登记（口径存疑：scripts/ 非测试探针的归属未拍板；无 issue） |
| D-170 | exposure-lint 剩余核对与扩展 | 2026-11-24 复核：核对对象已不在树内——`packages/agent/exposure-lint.test.ts` 不存在（`ls` 实测），同批不在树内的还有 `packages/agent/platform-leak-lint.test.ts`、身份面守卫 `packages/agent/execution-identity-surface.test.ts` 与 HG1 `packages/agent/history-hygiene.test.ts`：前三者删于 Reset 可达性删除 `0b972273`（HG1 更早不在树内，R1 审计把它列为已删对象），删除记录与「恢复最小闭集守卫或改 D-209 闭环判据属 owner 待裁定」在 `docs/history/decision-log-part01-2026-11_undated.md:716`；M4 复核轮清掉注释里对 exposure-lint 的陈旧指向（`docs/history/decision-log-part01-2026-11_undated.md:708`、R1 `docs/history/decision-log-part01-2026-11_undated.md:774`）。原残留两项因此失效：①「三道守卫逐一道具核对在 CI 内运行」的对象（exposure-lint / 身份面守卫 / HG1）四散俱删；门④所属迁移波次随 Minimal Rewrite 收口；②「波次 4 按需扩展类别」同批作废 | 登记（主体随 Reset 删除并有决策记录；残留 = D-209 的 owner 待裁定，见 §三） |
| D-190 | 门①测试夹具豁免口径分歧 | 2026-11-24 复核（口径同 D-168）：产品面（packages/apps 非测试文件）17dz **零命中**（最后一处随 `f0fa7104`/`5435604b` 删除）；测试/夹具面 3 行即 D-168 清单（`packages/agent/payload-oneof.test.ts:2`、`packages/agent/payload-oneof.test.ts:23`、`scripts/eval/real/smoke.ts:4`）。原判据「owner 拍板后在 `change-safety.md` 或 `architecture-laws.md` 落地正式条目，且 `platform-leak-lint.test.ts` 的豁免范围与该条目一致」——两份文档与该测试文件均已不在树内（见 D-170 行），裁定载体不存在；未见到 owner 拍板记录 | 登记（口径存疑：拍板载体已删、裁定未见；无 issue） |
| D-196 | 退役 `FSHINE_PLATFORM_ROOT` | 2026-11-24 结案核实：① `grep -rn FSHINE_PLATFORM_ROOT` 全树（除 git 历史）实测 9 命中，全在档案面——本表 D-196 行自身 1 行 + `docs/history/` 8 行（`docs/history/change-safety-part02-2026-10_2026-11_undated.md:339`、`docs/history/change-safety-part02-2026-10_2026-11_undated.md:495`、`docs/history/change-safety-part02-2026-10_2026-11_undated.md:708`、`docs/history/change-safety-part03-2026-11.md:206`、`docs/history/debt-ledger-part03-2026-10_2026-11.md:339`、`docs/history/debt-ledger-part03-2026-10_2026-11.md:762`、`docs/history/debt-ledger-part03-2026-10_2026-11.md:765`、`docs/history/debt-ledger-part03-2026-10_2026-11.md:767`）；代码面（packages/apps/scripts/config/tests/.github/patches/README/AGENTS/package.json 及任何非 docs 文件）零命中，符合原判据④「空或仅剩档案登记」；② 判据①③：全量 `vitest run` 与 `tsc --noEmit` 2026-11-24 全绿；③ 判据②⑤的对象 `tests/e2e/harness.ts` 已删除（随 Minimal Reset；`vitest.config.ts:5`、`scripts/ci.sh:18`），统一配置解析继任者在 `scripts/resolve-config-path.ts:25`（`explicitConfigFrom`：`--config` > `AGENT_CONFIG_PATH` > 各入口缺省；隐式回退链已随 M4 退役） | 已清（2026-11-24 对现行树核实；②⑤ 因对象删除而 moot，继任配置机制有指针；守卫 = `scripts/debt-ledger-guard.test.ts` D-196 例；本行留档，下次清理删除） |

## 三、指针失效、无结案记录 → 待核（64 条）

以下条目引用的文件在当前树均已不存在；**没有结案记录，不等于已清**。

- 旧宿主 Runtime / 写路径 / 业务词表（15 条）：D-001、D-003、D-004、D-005、D-010、D-016、D-017、D-030、D-031、D-032、D-050、D-051、D-066、D-067、D-083 附条 — `../history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md:102` 起、`../history/debt-ledger-part02-2026-09_2026-10.md:217`。
- 兄弟仓 `17dz-platform`（8 条，不在本 worktree）：D-015、D-053、D-056、D-057、D-061、D-064、D-173、D-193 — `../history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md:335` 起、`../history/debt-ledger-part03-2026-10_2026-11.md:729`。
- 旧评测 / 守卫 / 发布 / 迁移面（41 条）：D-147、D-148、D-152、D-153、D-154、D-157、D-159–D-167、D-169、D-171、D-172、D-174、D-175、D-178、D-181–D-188、D-192、D-194、D-195、D-197、D-198、D-199、D-201、D-202、D-203、D-205、D-206、D-209 — `../history/debt-ledger-part03-2026-10_2026-11.md:243` 起、`../history/debt-ledger-part04-2026-11.md:333`。
- 无编号登记（4 条）：已知短板、其余 6 真 1 半的证据链、architecture-laws「当前违例」对账、F3 未留档项 — `../history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md:50`、`:75`；`../history/debt-ledger-part03-2026-10_2026-11.md:223`、`:314`。

## 四、现行文档已登记的缺口（非台账拆分来源）

| 事项 | 证据 / 指针 | 状态 |
|---|---|---|
| `eval:cap01` 的 r6 面已改指 `lifecycle.ts`（2026-11-18 同步） | `scripts/eval/cap01/run-all.ts:40`；`../eval/README.md:12` | 已清 |
| `eval:cap01` R2 S1 场景已退役（原「Main 直做写 out/ 并由宿主投递」；交付物只从 Worker 出，Main 的 run_js 只能写 scratch/） | `scripts/eval/cap01/r2-functional.ts` 文件头；`packages/agent/src/run-js-executor.ts`（RunJsWritableDirs）；等价覆盖 = 同文件 S3（Worker 产物回 Main + 逐格 + 登记 + 行数据不出 Main） | 已退役（2026-11-19） |
| 判据锁只校验 criteria/cases 聚合值、不校验 `files` 表 | `../eval/README.md:24`；`scripts/eval/convergence-r1/runner.ts:220-230` | 未清 |
| 服务单实例 | 已清（2026-11-19 起有机械守卫）：启动取独占锁、存活实例在则 exit(1)、陈旧锁可覆盖；取锁先于连接渠道 | `apps/server/main.ts:53`（`guardSingleInstance`）；`apps/server/instance-guard.ts`；守卫 `apps/server/instance-guard.test.ts`（5 条）；`../ops/README.md:13` | 已清（2026-11-20 核对：原文「无进程锁/仅靠操作纪律」已不成立；本行留档，下次清理删除） |
| `DB_PATH` 文档缺省与实际代码不一致（文档 `data/agent.db`，代码 `.runtime/state.db`） | `../ops/README.md:34`；`../environment-variables.md:33`；`apps/server/main.ts:44-46` | 未清（文档待改） |

## 五、明确「接受不修 / 登记不修」（非待办，勿重开）

D-005 附条（`scripts/` 144 处接受不修）、D-006（验收替身数据）、D-040（auth 正则过渡债，限期）、D-054（`.env.real` 仓库侧已关）、D-149（提案 schema 死循环登记不修）、D-158（gitee refs 残留登记不修）— 原文见 `../history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md`、`../history/debt-ledger-part03-2026-10_2026-11.md`。

## 六、文件去重边界（2026-11-18 实测登记，本次不修）

| 编号 | 事项 | 现行证据 | 为什么现在不做 |
|---|---|---|---|
| F-1 | 纯附件重发（尚未激活的 pending 行）不去重：同内容连发两次 → 两行两个 fileId | **已清**（fee86cee，2026-11-18：pending→pending 复用同一 fileId）。现行证据：`packages/agent/src/file-store.ts:557`（`findReusableInboundRow` 不再跳过 pending）、`:973-977`（复用分支：pending 刷 name/created_at 且保持 pending）；守卫 `packages/agent/file-store-dedupe-ttl.test.ts`、`packages/agent/file-store-inbound.test.ts`（①/② pending 语义） | 已清（2026-11-20 核对） |
| F-2 | 入站复用没有「来源」判据，理论上会吞同字节的 Main 产物行（`putFile` 造的、如 recalc 的 `*.values.csv`）：行名会被改成入站文件名 | `packages/agent/src/file-store.ts:557-563`（`findReusableInboundRow` 只排除 `taskId !== undefined` 的行）；`putFile` 的 Main 行 `:714-738`；复用改名/TTL 刷新 `:598-629`（`reuseInboundRow`） | 修法需给 `file_refs` 加 origin 列并覆盖所有写路径（putFile / registerFromFd / 任务副本 / 回程），是 schema 迁移；当前同字节碰撞概率低但真实存在，登记到下次 schema 变更一起做 |
| F-3 | 同一消息内两个同内容不同名附件塌成同一 fileId、只留最后一个名字，而 `apps/server/attachment-facts.ts:87` 按 fileId 只留第一条事实 → 注入模型的名字与清单名不一致 | `packages/agent/src/file-store.ts:557-576`（入站复用 `findReusableInboundRow`，不区分消息内批次）；`apps/server/attachment-facts.ts:87` | 需要批次身份（`file_refs` 无 `message_id`）或改事实队列按 (fileId,name) 去重；后者仍会让清单只有一个名字、与模型看到的两条事实不一致。正确修法是同消息批次内复用检测 + 名字冲突裁定，需产品裁定，本次只登记 |

## 七、权限模型（2026-11-18 owner 裁定：解耦 + 只做粗粒度）

**裁定**：`accountSetScope` 这类**业务实体字段不与执行层耦合**（执行层不一定是财税平台）；fshine 与执行层之间只耦合**通用 permissions**（粗粒度：read / write）。粗粒度由 fshine 在发起前拦截；**细粒度（实体级）研判归执行层，暂不做**。

| 编号 | 事项 | 现行证据 | 为什么现在不做 |
|---|---|---|---|
| P-1 | ~~`principals.capabilities` / `principals.accountSetScope` 解析后**无任何消费点**（配置写了不生效）~~ **已解决（2026-11-19 RBAC 切片）** | 两字段已从 `PrincipalConfig` 删除；加载层忽略旧键（`packages/core/src/config.ts:339-340`）。角色表 `roles` + `principals.<id>.role` 取代：`packages/core/src/config.ts:296`（`parseRoles`）、`scripts/ask-runtime.ts:452`（求交口径）、`:533`（`resolveExecutionFace` 收口）、`apps/server/server.ts:1135`（`allowedPermissions: permissionsOfRole(...)`；旧行号 `:686` 系 RBAC 切片后随文件增长漂移） | —（角色白名单已接线并拦截） |
| P-2 | **细粒度（实体级）授权未实现**：谁能看哪些账套/哪些记录，未做任何透传或校验 | 无 acting-principal 透传；执行层调用只带 operation+args | 归执行层研判；真实 17dz 是否有"按主体授权"概念未验。仍挂债，等真实层冒烟与业务确认后再做 |
| P-3 | ~~写面是**全局开关**（`runtime.allowWriteOperations`），非按人~~ **已解决（2026-11-19 RBAC 切片）** | 全局开关降级为**部署总闸**：角色含 `write` 且总闸打开才并入写集合（`scripts/ask-runtime.ts:533` 收口；`apps/server/server.ts:1133-1134` 按主体角色取权限）；viewer 即使总闸打开也写不了；总闸关闭时 operator 也写不了（`scripts/rbac-roles.test.ts` ⑥） | —（按人部分由角色白名单承接，总闸语义保留） |

## 八、长任务异步协议（L-1 已落地 2026-11-19；L-2～L-4 仍挂债）

**背景**：执行层可能出现 30 分钟级的长任务（浏览器自动化）。固定总时长上限会把正常业务按卡死处理；挂长 RPC 又会长期占用后台槽。

**结论**：owner 2026-11-18 先定「设计保留、暂不实施」，当日深夜改判「契约扩展还是要做，实现上只用考虑命令行」→ L-1 已按 CLI/适配层抽象落地。**真实 17dz 未验**（只跑通 dummy CLI）。

| 编号 | 事项 | 设计要点 | 状态 / 为什么现在不做 |
|---|---|---|---|
| L-1 | 契约第六态 `accepted(operationId, pollAfterMs)` + `wait(operationId, timeoutMs)` + `abort(operationId)` | 只对声明 `long_running: true` 的 operation 生效，普通操作逐字节不变；Worker `accepted` 后回合结束、让出槽位；宿主用**长轮询**（出站、穿 NAT）实现"完成即唤醒"；`operationId` 落底账，重启续等；用户可停 | **已落地（契约 v4）**：runner 等待推进（瞬时故障指数退避封顶 60s）、续跑注记三态、续跑回程文件与大日志（`deliverable:false`）、`completed.items` 逐条结果；装配接线见 `scripts/ask-runtime.ts` 的 `longTaskPortOf`。只剩真实执行层验证 |
| L-2 | 续租/心跳替代总时长上限 | `workerTurnMs` 从"总时长"降级为"静默阈值"（无任何事件 N 秒才判卡死） | 未做：长任务已让出槽位，但**执行中**回合的静默阈值仍缺证据 |
| L-3 | 实体级并发写（长写期间的第二个写请求） | 由执行层用锁/排队返回确定性 `locked/busy`；宿主只转述并给用户"等/停"选择；宿主不排队等实体锁、不盲杀中间态 | 属执行层能力，未验；宿主侧无对应实体知识 |
| L-4 | `dispatchKey` 双边职责 | 宿主负责"不重复发起"（已实现），执行层负责"不重复执行"（未实现）；配套 per-operation `idempotent` 声明（缺省 false）与一致性探针（同 key 连发两次记录数不变） | 执行层未实现；dummy 里零引用 |

## 九、交互状态反馈（2026-11-19，owner 记为债）

**背景**：owner 希望给用户消息一个「已接收」的**轻反馈**（类似贴个表情 / reaction），让用户知道 Agent 收到了、正在办。

**事实**：企业微信 AI 机器人 SDK **没有 reaction / emoji 接口**——可用的只有 `replyStream` / `replyTemplateCard` / `updateTemplateCard` 等；因此**无法对用户消息「贴表情」**表示已接收。

| 编号 | 事项 | 设计要点 | 状态 / 为什么现在不做 |
|---|---|---|---|
| X-1 | 「已接收」轻反馈（贴表情 / reaction） | SDK 无 reaction 接口；可选替代 = **模板卡片原地更新**（⏳ → ✅，同一条卡片从「办理中」更新为「完成」），但需 live 验证该卡片类型对我们的机器人是否开放 | **当前不做**：短活缺省 **8 秒**就出结果，「收到」与「结果」几乎同时到；长活有 **10 分钟兜底**（超时如实告知）+ **运维告警**，已覆盖「接收感」。真实诉求未验证前不新增机制（新增机制准入：给不出「更省心/更省时间」的证据就不做） |

## 十、独立复核登记（2026-11-20，明确不修）

> 来自 9 点攻击独立复核：三处模型可见残留（agent.md / renderWorkerSystemPrompt 工作目录块 / 空汇报 reason）已由源头改写 + 守卫扩面修复；下列两项按复核建议**只登记、不修**，等真模型测量或专门切片再定。

| 编号 | 事项 | 现行证据 | 为什么现在不做 |
|---|---|---|---|
| R-1 | `wakeCancelled` 不在会话链上的 run/wake 竞态：任务取消时若该会话此刻没有在跑的回合（`turnActive=false`），`wakeCancelled` 直接起一次唤醒；若紧接着用户回合/另一状态变化又起 wake，两个 wake 可能并发。复核实测 **1 次可复现** driver 报错、用户回合空 | `apps/server/notification-chat-sink.ts:216-235`（`wakeCancelled` 出口）；`apps/server/server.ts:1303`（`wakeAndDeliverStateChange` 本体，出口逐步接它）；`turnActive` 判据见 `server.ts:1075` | 属竞态收口，不是本次去内部词切片；复现率与用户级影响待专门测。修法要给唤醒加会话级串行/去重（新机制，需过准入），本轮不引入 |
| R-2 | `WAKE_TURN_MS = 60s` 与 Main `mainThinkingLevel=high` 的张力：high 档长思考的唤醒回合可能 60s 内出不来 → 超时 abort → 模型那句丢失、走兜底渲染文案（用户看到的是模板话而非模型话） | `packages/agent/src/execution-runtime.ts:1071`（`WAKE_TURN_MS = 60_000`）、`:3324-3358`（wake/coldWake 截止）；`packages/contracts/src/config.ts:121`、`packages/core/src/config.ts:96`（`mainThinkingLevel` 配置）；兜底见 `notification-chat-sink.ts:216-235` | 是否真发生取决于真模型在 high 档的唤醒耗时，**当前无真模型测量**。不擅自放宽截止或降档——等 `eval:user` 真模型读数再定，避免为假设问题改超时语义 |

## 十一、S1 收尾复核登记（2026-11-23，明确不修）

> 来自「删 status 概念」收尾复核。以下条目都已在现行代码核对（M2/M3/m1/m2 来自独立复核；M4/M5/m3 来自 2026-11-23 grok 复审——与迁移事务 blocking 同轮，该 blocking 已修）；只登记、不修——修法要么是新增机制（需过新增机制准入），要么是用户可见词面变更（需 owner 裁定），要么会把确定性判据换成语义判断（违反判据红线）。

| 编号 | 是什么 | 后果 | 为何暂不修 | 现行证据 |
|---|---|---|---|---|
| M2 | （2026-11-24 已解决）有机械失败事实的回合即使带 worker 汇报，`settle` 也不 `archiveReply`，只写结束事实 | 结论机已删：汇报**原样存档**（宿主不判它是不是「对失败的说明」）。用户可见面由两条守着——① 模型醒着：Main 读账本执行事实自己判；② 模型沉默：兜底按末次失败事实不说「办好了」。若以后要区分「汇报=结果」与「汇报=失败说明」，需要独立的语义/列，属新增机制 | — | `packages/agent/src/task-runner.ts`（settle 原样存档）；`packages/agent/src/execution-runtime.ts`（`lastFailureFactOf` 三条机械规则） |
| M7 | （2026-11-24 新登记，owner 裁「登记不修」）执行行 status 是 `failed`/`refused` 但 `error.code` 与 `error.message` 皆空时，`lastFailureFactOf` 剥成 `{}`，回合终局不带 `errorCode`/`failureReason`；宿主兜底三者皆无 + 汇报非空 → 走 completion 话术 | 契约层**已堵住**：`ExecutionFailure { code: string; message: string }` 双双必填，`failed`/`refused` 必须带 `error`（`packages/contracts/src/execution-contract.ts:184-189,225-226`）——类型正确的执行层产不出空码。只剩「适配器返回类型合法但值为空串」一种运行期可能；仓内 dummy 防御性补 `EXECUTION_UNKNOWN_ERROR`，17dz 真层返回真码（CW000043/GATE_REFUSE 类）。**今天无可复现路径**，按「给不出最小复现失败就不新增/不改」登记 | 修法一行（判据从「code/message 非空」换成「status 属于 failed/refused 就算有失败事实」），但 necessity 无法证明；触发条件 = 17dz 实测吐出空码，那天再修 | `packages/agent/src/execution-runtime.ts`（`lastFailureFactOf` 三条机械规则）；`packages/agent/src/dummy-cli-client.ts:396-399`（防御性补值） |
| M6 | （2026-11-24 新登记）宿主「回合成败结论机」已整台删除，连带两处用户可见退化：① 同对象/异对象/无标签的成败配对判定没了；② 兜底失去「已完成 X，未成功 Y」那句 | 一成一败 + 模型沉默时，用户听到的是通用一句「没办成。我先核对一下现在到哪了？」（不再逐项听「哪件成哪件没成」；句子刻意不给「再试一次」——结论机删了，宿主不知道那笔是不是写、落没落，诱导重试可能双写）；同对象先失败后成功同样走这句（owner 2026-11-24 明确接受：宁可啰嗦不可骗人，也不可为洗绿留身份判定） | 恢复逐项话术需要**执行层**声明 partial/items（契约 `ExecutionItemResult` 已有形状），宿主不重建对象账本；对象身份同理应由执行层声明（2026-11-24 O-9 已删 `OBJECT_ARG_KEYS` 字段名刮擦，锁键改为 (operation, 参数稳定摘要 `argsDigestOf`)——宿主不再懂业务对象名） | `packages/agent/adversarial-worker.test.ts` ⑯–㉓（新口径：末条失败业务写的原始码，无 partial 字段） |
| M3 | E11 的 `noWriteExecuted` 锚点只要求「写面执行行没有一条 completed」；有任务时零写命中，无任务时零执行 + 非空回复也命中 | 锚点接近恒过：不区分「零执行是权限拒绝/执行失败」还是「模型随便回了一句没办事」，E11 通过不能证明用户被告知了办不了 | 要区分拒绝/失败必须判断回复语义，而 AGENTS 判据红线禁止用关键词/正则表达语义判断；确定性事实层没有「模型是否说清办不了」的信号，只能交给用户级黑盒 eval。不为凑绿补词表/改判据 | `scripts/eval/convergence-r1/judge.ts:792-827`；已登记口径 `../ops/handover.md:31`、`scripts/eval/convergence-r1/cases/E11.ts:15-41` |
| m1 | （2026-11-23 已解决）`noteRoundFailed` 无条件 emit；`result_unknown` 先 `markDied` 再 `noteRoundFailed` 双发 | 零状态：同任务至多一条结束事实（`task_ends`，只有 `task_id + at`，无 kind）；`died`/`round_failed` 这两个结束种类已随「删光状态机」轮删除，双发问题不存在 | — | `packages/core/src/task-store.ts`（`task_ends` 一次性）/ `packages/agent/src/task-runner.ts`（result_unknown 收尾只写一条结束事实） |
| m2 | （2026-11-23 已解决）CLI 的 `taskFactLabelsOf` 不读 `roundFailedAt`；已停但无汇报的任务落到兜底标签「无汇报」 | CLI 标签读原始事实（`endedAt` + 汇报 + 提问 + 租约）：已停无汇报显示「无汇报收尾」，未启动显示「排队中」，无结束事实且不再可能活着显示「结果未知」 | — | `scripts/tasks.ts`（`taskFactLabelsOf` 读 `endedAt`/汇报/提问原始事实） |
| M4 | （2026-11-23 已解决）`statusView` 透出四个终态时刻但不带 `roundFailedAt` | `statusView` 只透出原始事实（`started` / `reported` / `waiting` / `liveWorker` / `endedAt`，无种类）；`termination` 与结束种类已删除 | — | `packages/agent/src/execution-runtime.ts`（`statusView`） |
| M5 | （2026-11-23 部分解决）`docs/architecture/tasks.md` 行号与已删符号对不上代码 | §1/§4/§5/§7 已按零状态重写（终态列 / `cancel_requested_at` / `round_failed_at` 口径替换为原始事实：结束事实只留时刻）；其余行号仍可能随代码漂移 | 文档全面逐行核对属独立文档任务；本轮只改零状态相关段 | `docs/architecture/tasks.md` §1/§4/§5/§7 |
| m3 | （2026-11-23 已解决）`statusView` 的 `claimed` 注释写「已认领未落定」，实际是 `executions.length`（含已落定） | 注释按实际口径改写：`claimed` = 执行行总数（含已落定）、`resulted` = 已落定（status≠accepted）、`claimed-resulted` = 在途 accepted 数 | — | `packages/agent/src/execution-runtime.ts`（`statusView`） |

## 十二、长连接可靠性：离线/断连窗口的用户消息不可恢复（owner 2026-11-20 要求登记）

**事项**：企微 AI 机器人长连接（WebSocket）模式下，服务停服或断连期间用户发出的消息**平台不补投、产品无补拉**，窗口内消息永久丢失。

**实测读数（逐字）**：

- 停服 `12:02:15Z` → 重连 `12:03:43Z`（Authenticated），期间用户发 **2 条**；
- 重连后 `inbound_messages` 仍 **31 条（零新增）**、日志 `aibot_msg_callback` 帧 **0**、会话文件**零写入**；
- 结论：平台不补投、产品无补拉——断连窗口的消息没有任何恢复路径。
- 原始日志（机器本地 scratch，非仓内）：停服前 `~/.tmp/fshine-live.log`、重连后 `~/.tmp/fshine-live-2.log`（含 `WebSocket connection manually closed` → `Authenticated` → `server_started` 时间线）。

**官方口径**：`developer.work.weixin.qq.com/document/60904` 把「可靠性高（无状态）」判给 **Webhook**；长连接标注「需要心跳保活、断线重连」。官方社区另有「连接正常时也偶发丢」案例。

**缓解（已落地 2026-11-21）**：`systemd Restart=always`（停机窗口压到秒级）、WS 心跳 15s、`message_still_processing` 接进程内告警（规则 `message_stuck`）。窗口内消息仍会丢——这是长连接模式的固有代价。

**销账条件**：切 **Webhook**（平台最多 3 次重试）+ 既有 `messageId` 幂等底账接重投。两项都落地并实测窗口内零丢失后才可关账。

**状态**：未清（本次只登记，不修）。
