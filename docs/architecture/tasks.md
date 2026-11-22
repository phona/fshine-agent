# 任务生命周期与幂等

> 状态：现行。2026-11-22 随 S1 更新（task 去 `status`：§1 改述守护事实与存活推导；口径见 `docs/design/task-redefinition.md`）；取消 / `dispatchKey` 两层身份 / 等待续跑仍现行，缺口见 §7。
> 最后核对：2026-11-22（指针以现行代码为准，冲突就地标 ⚠️）。
> 上游指针：`packages/agent/src/task-registry.ts`（守护事实 + 操作账）、`packages/agent/src/task-runner.ts`（后台调度/取消/续跑）、`packages/agent/src/execution-runtime.ts`（认领与执行）；口径见 `docs/decisions/index.md`。

任务是一行底账（归属 + 交付原文 + 汇报存档 + 守护事实 + 执行调用清单）。**S1 起 task 没有 `status`**（口径见 `docs/design/task-redefinition.md`）：做没做成读执行行与汇报；**身份分成「哪一次交办」与「哪一笔业务操作」两层**；**证明不了是同一笔就停副作用**。
## 1. 守护事实与存活推导（无状态字段）
底账不再有 `status` / `reason` / `failure_reason`（S1 删除）。取代它的是**机械守护事实**：存活（`running` / `died` / `waiting_user`，纯函数 `taskLivenessOf`）+ 四个一次性结束时刻（`diedAt` / `cancelledAt` / `timedOutAt` / `resourceLimitedAt`）+ 执行调用清单 `executions`。**唯一保留的投影是 liveness 三值**——不再有 `taskStateWordOf` 之类把账本事实投影成任务级状态词的中间层（S1 已删）；等待形状是 `pendingQuestion`（只由执行层事实填写，见 §5）。

派发方式不是配置项（2026-11-18 起 `runtime.dispatchMode` 已删除）：server 恒 async（异步派发先落未启动行、由队列认领），进程内入口恒 sync。单写路径由守卫钉住：task-store 之外零 `UPDATE tasks`、registry 实现层无裸 SQL（`packages/agent/task-registry-write-path.test.ts:44`、`:57`）。

## 2. 两层身份：交办意图 / 业务操作
`taskId` 是**交办意图**的身份；`dispatchKey` 是**业务操作**的身份，两者不互换：重试不新造交办，交办重复不合并操作（决定见 `docs/decisions/index.md`「U3 稳定逻辑操作身份 `dispatchKey`」）。

| 层 | 身份 | 作用域 | 铸造点 |
| --- | --- | --- | --- |
| Main 交办（`task_run`） | `tasks.task_id`（`task_<uuid>`，`packages/agent/src/execution-runtime.ts:1982`） | `turn:<sessionId>:<turnNo>`（`:2218`） | `run_task` 受理时，仅此一次 |
| 交办内操作（Worker `execute_operation`） | `operations` 一行 | `task:<taskId>`（`:1821` 前台、`:2664` 后台） | 首次认领该操作时（`opSeq`） |

- 键是持久化字段的纯函数 `dk_<scopeKey>:<opSeq>`（`packages/agent/src/task-registry.ts:624`）；`opSeq` 只在**首次创建**时分配（作用域内 MAX+1，永不复用，`:632`）。
- **认领接口结构上没有 `args`**：`OperationClaimInput`（`packages/agent/src/task-registry.ts:441`）不含参数，所以「按参数文本去重」没有代码路径；决策是纯函数 `decideOperationClaim`（`:496`）；守卫 `packages/agent/dispatch-key-tripwire.test.ts:32`。没有重放窗口 → 一律铸造新行（`:504`），**两笔参数完全相同的合法操作 = 两行两 key，各执行一次**（禁止合并；`packages/agent/dispatch-key-identity.test.ts:142`）。
- `dispatchKey` 是契约字段（`packages/contracts/src/execution-contract.ts:83`）；`requestId` 每次调用换号，只作追踪（`packages/agent/src/execution-runtime.ts:1828`）。同窗口内重复 `task_run` 回放已有受理回执、**不建第二个任务**（`:2265-2269`；`packages/agent/dispatch-key-identity.test.ts:223`）。

**归属只在任务行**：`tasks` 行自带 `principal_id` / `session_id`，读取与转换都要求 scope 一致（`packages/core/src/task-store.ts:364-365`；受理 `packages/agent/src/task-registry.ts:534-540`；越权同错 `:651-653`）。Worker 无状态、跑完即弃：Worker 驱动不注入 `mainSession`（内存会话，`scripts/ask-runtime.ts:513-514`），任务文件与幂等 Map 随本次执行创建/丢弃（`packages/agent/src/execution-runtime.ts:2079-2081`、`:2600-2601`）。
## 3. 不确定就停副作用

调用顺序是**先落库认领、再调执行层**（`claimAndRunOperation`，`packages/agent/src/execution-runtime.ts:1045`），`claimed` 行在进程死亡窗口里先于任何外部副作用存在。认领五态的决定后果（`packages/agent/src/task-registry.ts:458-464`）：`minted` → 唯一真正调用执行层的一支（`:1088`）；`replayed` → 直接返回已有 outcome，零调用（`:1070`）；`in_progress` → 同身份不并发（`:1076`）；`unresolved`（`ambiguous_replay`/`prior_unknown`）→ **不发起执行**，返回 `result_unknown`（`:1082`）；`conflict` → 同身份不同 operation，抛 `DispatchConflictError`（`:1068`）。
调用抛错/无回执落 `unknown`（`operationStatusOf` 把 `failed` + `code: result_unknown` 映成账行 `unknown`：`packages/agent/src/task-registry.ts:401`）；写操作在飞被取消同样落 `unknown`（不能把「可能已发生」改写成「已取消」）。单次调用被**传输超时截断**（传输入口唯一的界：`dummy-cli-client.ts` 的 `EXECUTION_CALL_TIMEOUT_MS` = 60s）走同一条语义：适配器以 `failed` + `code: result_unknown`（无回执）返回 → `settleOperation` 按码落 `unknown`（`packages/agent/src/task-registry.ts:837`），并在一次真实发起的收尾处记一条 `execution_result_unknown` 事件（只进日志；用例 `packages/agent/execution-call-timeout.test.ts`）。已落定行不被覆盖，`unknown` 不被晚到的结果洗白（`packages/agent/src/task-registry.ts:842-846`）。上抛到任务层：前台抛 `ToolUserError` 确定性终结回合；后台 `{kind:'result_unknown'}` 由 `runner.settle` 落机械结果未知（任务记 `diedAt`；`packages/agent/src/task-runner.ts:138`），禁止自动重放（测试 `packages/agent/dispatch-key-identity.test.ts:195`）。

**worker 不得自建或满足确认门**：后台单回合执行器没有「下一回合」概念、也不持有用户原话，需要确认的写操作确定性落 `failed`，不谎报 completed（`packages/agent/src/execution-runtime.ts:2571-2575`）。
## 4. 取消三态：排队 / 在飞 / 已完成

**请求 ≠ 取消**：`requestCancel` 只记「已请求取消」，`confirmCancelled` 才写一次性结束事实 `cancelledAt`（`cancelled_by_user`）（取消流程见 `packages/agent/src/task-runner.ts:68`）。分派在 `packages/agent/src/task-runner.ts:866`：`queued`/`waiting_user` 请求后**机械确认**并出队（`:873-882`）；`running` 只 `requestCancel` + 本进程在飞才 `abort()`，**不宣称已取消**（`:884-889`）；任终态返回 `terminal`，不改写既有终态（`:868-870`）。

对话面 `task_cancel` 只原样转述 `CancelOutcome`（`packages/agent/src/execution-runtime.ts:1480-1500`）；无 runner 时该工具不暴露、也不受理（`:2249`，fail-closed）。
## 5. waiting_user 与 needs_input 续跑

等待形状是机械事实：`pendingQuestion.missing[]`（必填，非空串）/`candidates?`/`raw?` + `waitingSince`（`packages/agent/src/task-registry.ts:83`，校验 `:310`），**只由执行层事实填写，不编造、不改写候选**。入边仅后台：执行器看到 `needs_input` → `pendingQuestionFrom` 原样转述 `missing`（`packages/agent/src/execution-runtime.ts:2758`、`:2754-2762`），为空则判 `failed`（`:2760`）；`runner.settle` 落 `waitForUser`（`packages/agent/src/task-runner.ts:854`）。
> ⚠️ inline 路径不产生 `waiting_user`：等待形状 `pendingQuestion` 只由后台单回合执行器在 `needs_input` 时写入（见上行锚点），inline（同步）回合不落等待事实。
续跑 = **同一个 Task**：`answerResumes` 把 `waiting_user` 拉回 `running`、清等待形状，`taskNo`/`executions` 不重建（`packages/agent/src/task-registry.ts:348-353`）；`runner.resume` 要求当前是 `waiting_user`，否则 `not_waiting`（`packages/agent/src/task-runner.ts:895-897`）。等待超时可关闭活跃等待、落一次性 `timedOutAt` 机械时刻，但**保留**等待形状作历史（`packages/agent/src/task-registry.ts:366-372`）。
## 6. 编号与展示词表：单一来源

| 事实 | 唯一来源 | 消费方 |
| --- | --- | --- |
| `taskNo`（数字编号，唯一不复用） | 底账单条 SQL 计数器（`packages/core/src/task-store.ts:652`，迁移回填 `:617-621`） | 任务行；展示层只读 |
| `#<no> <name>` 标签 / 引用解析 | `taskNoLabel`/`taskLabel`（`scripts/tasks.ts:248`、`:256`）；`findTaskRef`（`:266`） | 证据行、`ops`/`tasks` 列表；CLI 详情 |
| 业务名称 / 机械事实词 | `deriveTaskName`（`packages/agent/src/task-registry.ts:107`）；`TASK_FACT_WORDS`（`scripts/tasks.ts:142`）+ `taskFactKeyOf`（`:157`），未知值 fail-open 显示原值 | 展示层与模型可见投影 |

对话面 `resolveTaskId` 只在**本会话 scope** 内解析，跨会话 = 找不到（`packages/agent/src/execution-runtime.ts:1429`）。对账测试钉住同源：`scripts/ops.test.ts:305`、`scripts/tasks.test.ts:211`。

**群 = 独立主体**（owner 2026-11-18）：1:1 `principalId=channel:userid`；群聊 `principalId=channel:group:<conversationId>`——同群所有人共用一个主体，记忆/文件/任务归「这个群」，个人数据不进群（群主体按配置授权）；`sessionId=channel:conversationId`（`apps/server/server.ts:779-785`），两侧一致，于是同群所有人落在**同一** `(principalId, sessionId)` = 同一份 Pi 会话（群文件讨论天然成立），不同群互不串。发言人不是主体：只以 `speakerId`（`wecomUserId`）进日志事件作审计，任务行不加列。任务结果按 `sessionId` 还原路由回原会话（`apps/server/task-completion-delivery.ts:44-48`），群任务因此回群。**久无动静提醒**（2026-11-19 owner 补 #9/#10）不看 `chatType`、也不看进程内集合：判据只看底账任务事实（任务属于谁、活在哪个会话），1:1 与群聊都发；群主体的话术不带业务名（隐私口径，宿主拼事实时去名），与主体派生互补。
## 7. 不承诺什么 / 相邻出口

- **不是 Exactly Once**：只承诺「同一 `dispatchKey` 至多一次自动执行 + 结果未知可核对」（`packages/contracts/src/execution-contract.ts:80`）；业务效果是否只写一次归执行层幂等键/状态查询。
- **跨重启入站幂等 / 任务不自动重跑**：渠道重投幂等的唯一判据是底账 `inbound_messages` 表，主键 `(principal_id, session_id, message_id)`（`packages/core/src/task-store.ts:528`，认领/落定/查询 `:1386`/`:1390`/`:1404`）；同一条先于一切副作用查重，命中即回放原回执、零新任务零执行，处理失败删行让渠道重投（不伪造回执）（`apps/server/server.ts:1233-1241`）。进程内存 Map（`inboundInFlight`，`apps/server/server.ts:1242`，上限 `MESSAGE_REPLY_LIMIT=1024` `:97`）只解决**同进程并发重投**两条同 `messageId` 几乎同时到达时第二条等第一条落定，不承担跨重启判据（落定即删）。底账留 processing（上一进程挂了）的重投：不执行、回「这条消息上次没办完（我这边中途中断过），我不会重复执行它，结果未知——麻烦你重发一次。」（`INBOUND_STILL_PROCESSING_NOTE` `apps/server/server.ts:228-229`）、落 `message_still_processing` 事件（`:1359`/`:1415`）。4/4 单测含关 server、同 dbPath 重建、再投同一 `messageId` 回放同一句（`apps/server/server-inbound-idempotency.test.ts:136`）。任务侧重跑另算：`queued` 重领（`claimNextQueued`），过期租约记 `died`（结果未知）且零重放（`expireLeases`；`packages/agent/task-runner.test.ts:639`）。
- **`--redo` 是重新交办，不是续跑**：输入=存储的 `task.request` 逐字、新任务、原任务零改动（`scripts/tasks.ts:522`）；在跑（`taskLivenessOf`='running'）/等待（`pendingQuestion`）/未启动的任务拒绝（`scripts/tasks.ts:540`、`:543`、`:546`）。
- **模型把一笔意图拆成两次调用 → 两笔都执行**（两条独立身份，见 §2）；这是登记在案的失败形态，不写成「不会重复」，兜底在执行层。
- **职责边界**：Main 只拆包（不亲自做长活、不甩包），Worker 只做交办给它的那件事，交付物只从 Worker 出（`AGENTS.md:31-33`）；Main 的 `run_js` 不产交付物。

> 裁定（owner 2026-11-17）：**跨会话续办不做**。任务 scope 恒为 `(principalId, sessionId)`；不要据此扩成跨会话授权面（结论见 `docs/decisions/debt.md`）。
