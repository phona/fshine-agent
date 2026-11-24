# 任务生命周期与幂等

> 状态：现行。2026-11-23 不维护任务状态机（只存事实；结束事实只留时刻、**没有种类**；活/结束现推；口径见 `docs/design/task-redefinition.md` §7）；取消 / `dispatchKey` 两层身份 / 等待续跑仍现行，缺口见 §7。
> 最后核对：2026-11-23（指针以现行代码为准，冲突就地标 ⚠️）。
> 上游指针：`packages/agent/src/task-registry.ts`（守护事实 + 操作账）、`packages/agent/src/task-runner.ts`（后台调度/取消/续跑）、`packages/agent/src/execution-runtime.ts`（认领与执行）；口径见 `docs/decisions/index.md`。

任务是一行底账（归属 + 交付原文 + 汇报存档 + 机械事实 + 执行调用清单）。**task 没有 `status`，也没有任何任务级生命周期枚举**（口径见 `docs/design/task-redefinition.md`）：做没做成读执行行与汇报；**身份分成「哪一次交办」与「哪一笔业务操作」两层**；**证明不了是同一笔就停副作用**。
## 1. 只存事实；活/结束现推

底账没有 `status` / `reason` / `failure_reason`，也**没有可变状态列**（`died_at` / `cancelled_at` / `timed_out_at` / `resource_limited_at` / `round_failed_at` / `cancel_requested_at` 已删，owner 2026-11-23）。只存事实：

- 启动时刻 `running_since`、汇报存档 `result_text` / `reply_text`、等待形状 `pendingQuestion + waiting_since`、租约、提醒时刻、执行调用清单 `executions`（每笔 status = 执行层契约事实）；
- **一条「这一轮在 T 停下」的机械事实**（`task_ends`：`task_id + at`，同任务至多一条、不可变、重启后仍在）。**没有 kind**——怎么结束不存；取消/超时/租约过期/无汇报收尾只留下同一个「停下时刻」。

活/结束由**布尔事实**现推（`packages/core/src/task-progress.ts`，不落列、不返回状态词）：排队 = 未启动 + 无汇报 + 无提问；仍在推进 = 已启动 + 无结束事实 + 无汇报/提问；可能还在跑（跨进程读者）= 仍在推进 + 租约未过期或 accepted 在途；本进程在跑 = 仍在推进 + runner 的 inFlight/waiters/controllers 里有活 worker；等用户 = `pendingQuestion`；结束 = 结束事实在场、或汇报存档在场、或已启动且不再可能还活着（无汇报 = 结果未知）。消费方（CLI/ops/投递/唤醒）要标签就**就地读原始事实算**，不共享任何「怎么结束」类型。

派发方式不是配置项（2026-11-18 起 `runtime.dispatchMode` 已删除）：server 恒 async（异步派发先落未启动行、由队列认领），进程内入口恒 sync。单写路径由守卫钉住：task-store 之外零 `UPDATE tasks`、registry 实现层无裸 SQL（`packages/agent/task-registry-write-path.test.ts:44`、`:57`）；`tasks` 表无终态列由 `packages/core/task-store-zero-state.test.ts` 钉住；**全仓不得再出现「读事实 → 返回多值任务级生命周期枚举」的共享类型/函数/字段**，由 `packages/agent/task-lifecycle-enum-guard.test.ts` 按形状判（反向绊线：把终止种类函数/枚举、任务状态字段、状态描述句或源码注释放回必红）。

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
调用抛错/无回执落 `unknown`（`operationStatusOf` 把 `failed` + `code: result_unknown` 映成账行 `unknown`：`packages/agent/src/task-registry.ts:401`）；写操作在飞被取消同样落 `unknown`（不能把「可能已发生」改写成「已取消」）。单次调用被**传输超时截断**（传输入口唯一的界：`dummy-cli-client.ts` 的 `EXECUTION_CALL_TIMEOUT_MS` = 60s）走同一条语义：适配器以 `failed` + `code: result_unknown`（无回执）返回 → `settleOperation` 按码落 `unknown`（`packages/agent/src/task-registry.ts:837`），并在一次真实发起的收尾处记一条 `execution_result_unknown` 事件（只进日志；用例 `packages/agent/execution-call-timeout.test.ts`）。已落定行不被覆盖，`unknown` 不被晚到的结果洗白（`packages/agent/src/task-registry.ts:842-846`）。上抛到任务层：前台抛 `ToolUserError` 确定性终结回合；后台 `{kind:'result_unknown'}` 由 `runner.settle` 追加**结束事实**（只留停下时刻；结果未知由消费方按事实现推，禁止自动重放；`packages/agent/src/task-runner.ts:1691`），测试 `packages/agent/dispatch-key-identity.test.ts:195`。

**worker 不得自建或满足确认门**：后台单回合执行器没有「下一回合」概念、也不持有用户原话——本回合已有未消费提案时再发起非只读 operation，在**发起前**被工具错误挡下（`SAME_TURN_CONFIRMATION_PENDING_MESSAGE`，`packages/agent/src/execution-runtime.ts:2464-2472`），不发起执行、不落执行事实；确认路径本身落**等待事实**（`needs_confirmation` + `waitForUser`，`execution-runtime.ts:4399-4410` 一带），不是失败。
## 4. 取消：请求 ≠ 取消（没有取消状态机）

取消请求**不持久化**（`cancel_requested_at` 已删）——请求只留在本进程内存；机械确认时才写一条结束事实（只有时刻，没有「取消」种类）。分派在 `packages/agent/src/task-runner.ts:1765`：`queued`/`waiting_user`（无在飞回合）**机械确认**并出队（`:1771-1778`）；`running` 只记内存请求 + 本进程在飞才 `abort()`，**不宣称已取消**（`:1779-1788`）；已结束返回 `terminal`，不改写既有事实（`:1767-1769`）。进程死在请求与确认之间时，租约过期写下结束事实（结果未知、不重放）；重启后没有「你要我停、没停完」的单独出口（请求不是结束事实）。

对话面 `task_cancel` 只原样转述 `CancelOutcome`（`packages/agent/src/execution-runtime.ts`）；回执只按事实说：同步确认 → 「已停止」；已停任务按**有没有汇报**说「已有汇报」或「已经停了（没有汇报，结果未知）」——不区分取消/超时/结果未知/资源拒绝（这些种类不存）。无 runner 时该工具不暴露、也不受理（fail-closed）。
## 5. waiting_user 与 needs_input 续跑

等待形状是机械事实：`pendingQuestion.missing[]`（必填，非空串）/`candidates?`/`raw?` + `waitingSince`（`packages/agent/src/task-registry.ts:65`、`:220`），**只由执行层事实填写，不编造、不改写候选**。入边仅后台：执行器看到 `needs_input` → `pendingQuestionFrom` 原样转述 `missing`（`packages/agent/src/execution-runtime.ts:2758`、`:2754-2762`），为空（没说清缺什么）则回合按 `ended` 收尾并带机械原因（不编造问题形状、也不当完成；`:4387-4397`）；`runner.settle` 落 `waitForUser`（`packages/agent/src/task-runner.ts:1702`、`:1713`）。
> ⚠️ inline 路径不产生 `waiting_user`：等待形状 `pendingQuestion` 只由后台单回合执行器在 `needs_input` 时写入（见上行锚点），inline（同步）回合不落等待事实。
续跑 = **同一个 Task**：`answerResumes` 清除等待形状（同一 Task 新回合），`taskNo`/`executions` 不重建（`packages/agent/src/task-registry.ts`）；`runner.resume` 要求当前有等待形状，否则 `not_waiting`（`packages/agent/src/task-runner.ts:1799-1802`）。等待超时可关闭活跃等待、写下结束事实，**等待形状原样保留**（提案的句柄/摘要/写入参数只存在于 `pending_question` 上，执行行不带它——删了底账就失去「用户被要求批准的那次写」的记录，2026-11-24 grok blocking）；可执行性由谓词决定：`taskWaitingOf` 要求 `endedAt` 缺省才算等待，所以结束后的行不再显示「等待用户」、redo 放行、resume/confirm 被结束事实拒绝——**不靠删数据消除死角**。
## 6. 编号与展示词表：单一来源

| 事实 | 唯一来源 | 消费方 |
| --- | --- | --- |
| `taskNo`（数字编号，唯一不复用） | 底账单条 SQL 计数器（`packages/core/src/task-store.ts:652`，迁移回填 `:617-621`） | 任务行；展示层只读 |
| `#<no> <name>` 标签 / 引用解析 | `taskNoLabel`/`taskLabel`（`scripts/tasks.ts:248`、`:256`）；`findTaskRef`（`:266`） | 证据行、`ops`/`tasks` 列表；CLI 详情 |
| 业务名称 / 机械事实标签 | `deriveTaskName`（`packages/agent/src/task-registry.ts`）；`taskFactLabelsOf`（`scripts/tasks.ts`）——就地读启动/结束/汇报/提问/租约事实算标签，未知值 fail-open 显示原值 | 展示层与模型可见投影 |

对话面 `resolveTaskId` 只在**本会话 scope** 内解析，跨会话 = 找不到（`packages/agent/src/execution-runtime.ts:1429`）。对账测试钉住同源：`scripts/ops.test.ts:305`、`scripts/tasks.test.ts:211`。

**群 = 独立主体**（owner 2026-11-18）：1:1 `principalId=channel:userid`；群聊 `principalId=channel:group:<conversationId>`——同群所有人共用一个主体，记忆/文件/任务归「这个群」，个人数据不进群（群主体按配置授权）；`sessionId=channel:conversationId`（`apps/server/server.ts:779-785`），两侧一致，于是同群所有人落在**同一** `(principalId, sessionId)` = 同一份 Pi 会话（群文件讨论天然成立），不同群互不串。发言人不是主体：只以 `speakerId`（`wecomUserId`）进日志事件作审计，任务行不加列。任务结果按 `sessionId` 还原路由回原会话（`apps/server/task-completion-delivery.ts:44-48`），群任务因此回群。**久无动静提醒**（2026-11-19 owner 补 #9/#10）不看 `chatType`、也不看进程内集合：判据只看底账任务事实（任务属于谁、活在哪个会话），1:1 与群聊都发；群主体的话术不带业务名（隐私口径，宿主拼事实时去名），与主体派生互补。
## 7. 不承诺什么 / 相邻出口

- **不是 Exactly Once**：只承诺「同一 `dispatchKey` 至多一次自动执行 + 结果未知可核对」（`packages/contracts/src/execution-contract.ts:80`）；业务效果是否只写一次归执行层幂等键/状态查询。
- **跨重启入站幂等 / 任务不自动重跑**：渠道重投幂等的唯一判据是底账 `inbound_messages` 表，主键 `(principal_id, session_id, message_id)`（`packages/core/src/task-store.ts:528`，认领/落定/查询 `:1386`/`:1390`/`:1404`）；同一条先于一切副作用查重，命中即回放原回执、零新任务零执行，处理失败删行让渠道重投（不伪造回执）（`apps/server/server.ts:1233-1241`）。进程内存 Map（`inboundInFlight`，`apps/server/server.ts:1242`，上限 `MESSAGE_REPLY_LIMIT=1024` `:97`）只解决**同进程并发重投**两条同 `messageId` 几乎同时到达时第二条等第一条落定，不承担跨重启判据（落定即删）。底账留 processing（上一进程挂了）的重投：不执行、回「这条消息上次没办完（我这边中途中断过），我不会重复执行它，结果未知——麻烦你重发一次。」（`INBOUND_STILL_PROCESSING_NOTE` `apps/server/server.ts:228-229`）、落 `message_still_processing` 事件（`:1359`/`:1415`）。4/4 单测含关 server、同 dbPath 重建、再投同一 `messageId` 回放同一句（`apps/server/server-inbound-idempotency.test.ts:136`）。任务侧重跑另算：`queued` 重领（`claimNextQueued`），过期租约写下结束事实（结果未知）且零重放（`expireLeases`；`packages/agent/task-runner.test.ts:639`）。
- **`--redo` 是重新交办，不是续跑**：输入=存储的 `task.request` 逐字、新任务、原任务零改动（`scripts/tasks.ts:522`）；仍在推进（`stillProgressingOf`）/等待（`pendingQuestion`）/未启动的任务拒绝（`scripts/tasks.ts:540`、`:543`、`:546`）。
- **模型把一笔意图拆成两次调用 → 两笔都执行**（两条独立身份，见 §2）；这是登记在案的失败形态，不写成「不会重复」，兜底在执行层。
- **职责边界**：Main 只拆包（不亲自做长活、不甩包），Worker 只做交办给它的那件事，交付物只从 Worker 出（`AGENTS.md:31-33`）；Main 的 `run_js` 不产交付物。

> 裁定（owner 2026-11-17）：**跨会话续办不做**。任务 scope 恒为 `(principalId, sessionId)`；不要据此扩成跨会话授权面（结论见 `docs/decisions/debt.md`）。

## 8. 三角色定稿（2026-11-23）

> 状态：定稿。口径：宿主是保险丝 / 网关，不是监工；理解与判断归 Main。

| 角色 | 是什么 | 干什么 | 绝不干什么 |
| --- | --- | --- | --- |
| **宿主** | 保险丝 / 断路器 / 网关 | ① 幂等（`dispatchKey` + `claimed→resulted`）② 事实谓词（仍在推进 / 可能还在跑 / 等待 / 结束事实——**只返回布尔事实，不产状态词**）③ 转述（`replyText` 原样） | 不判断 worker 干得怎么样（不产 outcome / 进度 / 状态词）；不补写事务 |
| **Main** | 理解者 / 编排者 | 拆包、看清、意图判断、编排；**读 worker 汇报 + 执行事实，判成败/进度、回用户**；可直接干活（`run_js` 只写 `scratch/`） | 不包圆、不甩包；交付物只从 Worker 出 |
| **Worker** | 执行者 | 只做交办的那件事，产出交付物；经 Execution Contract 结构化调执行层 | — |
| **执行层** | 被接入（非三角色之一） | 持有写事务的 saga / 幂等 / 补偿 | — |

**数据流**：worker 汇报（散文）+ 执行事实（执行行）→ 宿主只记事实 + 原样转述 → Main 读两者（活/结束按布尔事实现推），判并转述给用户。

**两种「补偿」不是一回事**（别混）：

- **写事务补偿（saga）**：回滚一笔已发生的业务写 → **执行层**的活；宿主不拆批、不补偿、不猜，结果未知一律停下交用户核对（§3、`AGENTS.md`「写事务归执行层」）。取消一个「写已在飞」的任务就是这一类：宿主只 abort + 如实说「已请求停，最后一笔写是否落库未知，请核对」。
- **响应失败补偿（网关 500/502）**：Main 挂了 / 沉默、没人给用户回话时 → **宿主的活**：读原始执行事实（末次决定性执行的 `error.code`）兜一句、用户友好化（`denied` / `executor_failed` / `unknown_result`）。这是宿主**唯一**带判断的动作，**只在 Main 说不出话时**触发，且只读原始事实、不聚合成回合级结局词、不补反向操作。

**「状态」的边界（owner 2026-11-23）**：task **没有状态机，也没有任务级状态枚举**。唯一的「状态」是**每笔执行的事实**（`completed` / `failed` / `refused`，执行层契约）；「活/结束」由开始时刻 + 汇报 + 提问 + 有没有活 worker（跨进程：租约/在途）**现推**；消费方读原始事实就地算标签。系统不用任何机制去猜进度。**允许的「状态」概念只有一层：进程状态**（活着 / 已退出 / 阻塞等输入，同 `ps` 的 R/S）——那是宿主对 worker 进程的可观测事实，由运行时现推（内存活 worker + `started_at` + `pendingQuestion` + 汇报有无），**不落库、不建共享枚举**；**业务内部状态**（完成 / 失败 / 做到哪一步 / 部分完成）不进宿主，只在执行层账本（每笔执行 status）与 Worker 汇报里，Main 读两者判断并转述。每次执行层调用 = 一条执行行（`dispatchKey` + 参数 + 结局）：重试只认领同一行、取消只影响在飞那一笔、saga 归执行层——**副作用按调用隔离**。链路是 `user → Main → Worker（宿主驱动）→ 执行层`，写事务的 saga 补偿归执行层；**saga 兜不住的（写未知），用正向信息如实补偿给用户**（「没停完 / 未知，请核对」），**不黑盒、不乱补偿**。
