# 任务生命周期与幂等

> 状态：现行。2026-11-18 核对 @ `2823880`；状态机 / 取消三态 / `dispatchKey` 两层身份 / 等待续跑均已实施，缺口见 §7。
> 口径：只写今天做决定或排障需要的行为与判据；实施过程与被删来源在 git 历史（`git log --diff-filter=D -- docs/`，清单见文末「来源」）。
> 指针：`packages/agent/src/task-registry.ts`（状态机 + 操作账）、`packages/agent/src/task-runner.ts`（后台调度/取消/续跑）、`packages/agent/src/execution-runtime.ts`（认领与执行）；冲突以代码为准，就地标 ⚠️。

一句话：任务是一行底账（归属 + 状态 + 机械原因 + 执行事实）。**状态只经一个归约核心改**；
**身份分成"哪一次交办"与"哪一笔业务操作"两层**；**证明不了是同一笔就停副作用**。

## 1. 状态集与合法转换

9 个状态，顺序即契约登记顺序：`TASK_STATUSES`（`packages/agent/src/task-registry.ts:54`）。
五个是终态（无边出）：`cancelled / completed / failed / timed_out / unexecuted`。

起始状态取决于受理方式：**inline（缺省）直接 `running`**；只有 `dispatchMode=background` 的受理才先落 `queued`（`docs/product/p2a-task-contract.md:33`、`packages/agent/src/task-runner.ts:501-505`）。

合法边只有一张表：`LEGAL_TRANSITIONS`（`packages/agent/src/task-registry.ts:246`）。读法：

- `queued → running | cancelling | timed_out`；
- `running → completed | failed | waiting_user | cancelling | timed_out | unexecuted`（`unexecuted` = 已汇报零执行，只由 inline `complete` 判定进入）；
- `waiting_user → running | cancelling | timed_out`（`running` 是答复接续）；
- `cancelling → cancelled | running`——**`cancelling→running` 是"中止未获确认不得宣称取消"的回滚边**（`packages/agent/src/task-registry.ts:243`）。

所有状态变化经唯一归约核心 `reduceTaskState`（`packages/agent/src/task-registry.ts:321`）：非法边抛 `TaskTransitionError`
（`packages/agent/src/task-registry.ts:211`），**状态不变、零事实**，不做隐式修正。

机械原因由目标状态决定（`mechanicalReason`，`packages/agent/src/task-registry.ts:283`）：`cancelled→cancelled_by_user`、
`timed_out→timeout`、`failed→failed_confirmed|result_unknown|resource_limited`；显式传入与目标不符即拒绝
（防编造）。原因枚举见 `TASK_REASONS`（`packages/agent/src/task-registry.ts:69`）。

单写路径由源码级守卫钉住：`packages/agent/task-registry-write-path.test.ts:44`（task-store 之外零 `UPDATE tasks`）、
`:57`（写 status 的 SQL 恰一条）、`:70`（registry 实现层无裸 SQL）。

## 2. 两层身份：交办意图 / 业务操作

`dispatchKey` 是**业务操作**的身份；`taskId` 是**交办意图**的身份（§九十七 U3 合入，索引 `docs/decisions/index.md`「U3 稳定逻辑操作身份 `dispatchKey`」行；原文 `docs/history/decision-log-part06-2026-11_undated.md:145`）。
两者不互换：重试不新造交办，交办重复不合并操作。

| 层 | 身份 | 作用域字符串 | 铸造点 |
|---|---|---|---|
| Main 交办意图（`task_run`） | `tasks.task_id`（`task_<uuid>`，`packages/agent/src/execution-runtime.ts:1708`） | `turn:<sessionId>:<turnNo>` | `run_task` 受理时，仅此一次 |
| 交办内业务操作（Worker `execute_operation`） | `operations` 一行 | `task:<taskId>` | 首次认领该操作时（`opSeq`） |

作用域构造点：turn 作用域 `packages/agent/src/execution-runtime.ts:1938`（`task_run` 认领在 `:1988`）；task 作用域
`packages/agent/src/execution-runtime.ts:1570`（前台 Worker）与 `:2294`（后台 Worker）。

- 键是持久化字段的纯函数：`dk_<scopeKey>:<opSeq>`（`packages/agent/src/task-registry.ts:604`，SQLite 侧同式）。
  `opSeq` 只在**首次创建**时分配（作用域内 MAX+1，永不复用，`packages/agent/src/task-registry.ts:607`）。
- **认领接口结构上没有 `args`**：`OperationClaimInput`（`packages/agent/src/task-registry.ts:434`）不含参数，因此"按参数文本
  去重"没有代码路径；决策是纯函数 `decideOperationClaim`（`packages/agent/src/task-registry.ts:489`）。守卫：`packages/agent/dispatch-key-tripwire.test.ts:32`。
- 没有重放窗口 → 一律铸造新行（`packages/agent/src/task-registry.ts:504`）。所以**两笔参数完全相同的合法操作 = 两行两 key，
  各执行一次**（禁止合并；测试 `packages/agent/dispatch-key-identity.test.ts:142`）。
- `dispatchKey` 是契约字段（`packages/contracts/src/execution-contract.ts:83`）；`requestId` 每次调用换号，
  只作追踪（`packages/agent/src/execution-runtime.ts:1576`）。
- 同窗口内重复 `task_run` 回放已有受理回执、**不建第二个任务**（`packages/agent/src/execution-runtime.ts:2004`；
  测试 `packages/agent/dispatch-key-identity.test.ts:223`）。

## 3. 不确定就停副作用

调用顺序是**先落库认领、再调执行层**（`claimAndRunOperation`，`packages/agent/src/execution-runtime.ts:916`；`:908-914` 为该顺序的理由）。
`claimed` 行在进程死亡窗口里先于任何外部副作用存在。

认领五态的决定后果（`packages/agent/src/task-registry.ts:449`）：

- `minted` → 唯一会真正调用执行层的一支（`packages/agent/src/execution-runtime.ts:959`）；
- `replayed` → 直接返回已有 outcome，**零调用、零新执行行**（`:941`）；
- `in_progress` → 同一身份正在执行，不并发（`:947`）；
- `unresolved`（`ambiguous_replay` / `prior_unknown`）→ **不发起执行**，返回 `result_unknown`（`:953`）；
- `conflict` → 同身份不同 operation，抛 `DispatchConflictError`（`:939`）。

调用抛错/无回执落 `unknown`（`markOperationUnknown(..., 'call_interrupted')`，`packages/agent/src/execution-runtime.ts:1020`）；
写操作在飞被取消同样落 `unknown`（`:1004`，理由：不能把"可能已发生"改写成"已取消"）。落定幂等：
已落定行不被覆盖，`unknown` 不被晚到的结果洗白（`packages/agent/src/task-registry.ts:897`）。

上抛到任务层：前台 `run.unresolved` → 抛 `ToolUserError` 确定性终结回合（`packages/agent/src/execution-runtime.ts:1612`）；
后台 → `{kind:'result_unknown'}`（`:2359`）→ `runner.settle` 走 `markResultUnknown`（`packages/agent/src/task-runner.ts:480`），
任务落 `failed + reason=result_unknown`。测试：`packages/agent/dispatch-key-identity.test.ts:195`。

## 4. 取消三态：排队 / 在飞 / 已完成

**请求 ≠ 取消**。`requestCancel` 只落 `cancelling`（`packages/agent/src/task-registry.ts:348`）；`confirmCancelled` 才落
`cancelled` 并写 `cancelled_by_user`（`:353`）。三种情形分派在 `packages/agent/src/task-runner.ts:495`：

| 情形 | 行为 | 指针 |
|---|---|---|
| 排队（`queued`） | 请求后**机械确认**（无在飞执行可等），出队 | `packages/agent/src/task-runner.ts:501-505` |
| 等待（`waiting_user`） | 同上，回合已结束 | `packages/agent/src/task-runner.ts:507-510` |
| 在飞（`running`/`cancelling`） | 只 `requestCancel` + 本进程在飞才 `abort()`；**不宣称已取消** | `packages/agent/src/task-runner.ts:512-517` |
| 已完成（任终态） | 返回 `terminal`，不改写既有终态 | `packages/agent/src/task-runner.ts:497` |

在飞取消未获确认时，收尾先把 `cancelling` 回滚到 `running` 再落实际终态（`packages/agent/src/task-runner.ts:444`、`:455-457`）。
测试：`packages/agent/task-runner.test.ts:705`（排队）、`:728`（在飞确认）、`:748`/`:765`（未获确认不宣称取消）、`:792`（终态无操作）；
真实中止（不只改账本）：`packages/agent/task-cancel-inflight.test.ts:218`/`:264`/`:339`，已完成再取消 `:376`。

对话面 `task_cancel` 只原样转述 `CancelOutcome`（`packages/agent/src/execution-runtime.ts:1158`），无 runner 时该工具不暴露、也不受理
（`:2019`，fail-closed）。

## 5. waiting_user 与 needs_input 续跑

等待形状是机械事实：`pendingQuestion.missing[]`（必填，非空串）/`candidates?`/`raw?` + `waitingSince`
（`packages/agent/src/task-registry.ts:83`，校验 `:303`）。**只由执行层事实填写，不编造、不改写候选**。

入边（仅后台路径）：执行器看到 `needs_input` → `pendingQuestionFrom` 原样转述 `missing`（`packages/agent/src/execution-runtime.ts:2226`、
`:2366-2375`）；`missing` 为空则判 `failed` 而非等待（`:2372`）。`runner.settle` 落 `waitForUser`（`packages/agent/src/task-runner.ts:483`）。

> ⚠️ 文档与代码不一致：inline 路径不产生 `waiting_user`——`judgeReportedTask` 把含 `needs_input` 的执行事实判为
> `failed`（`packages/agent/task-status-boundary.test.ts:60`），registry 头注也写明「waiting_user 仅后台任务使用」（`packages/agent/src/task-registry.ts:29`）。

续跑 = **同一个 Task**，不是新任务：`answerResumes` 把 `waiting_user` 拉回 `running`，清等待形状，`taskNo`/
`executions` 不重建（`packages/agent/src/task-registry.ts:341`）。`runner.resume` 要求当前是 `waiting_user`，否则返回 `not_waiting`
（`packages/agent/src/task-runner.ts:524`），成功才 `startRound`（`:541`）。对话面 `task_resume` 要求 `answer` 非空
（`packages/agent/src/execution-runtime.ts:1165`）。

等待超时可关闭活跃等待、`timed_out + reason=timeout`，但**保留** `pendingQuestion`/`waitingSince` 作为历史
（`packages/agent/src/task-registry.ts:359`）。测试：`scripts/needs-input-resume.test.ts:233`（停在 waiting_user、编号对得上）、`:279`
（补答续同一 taskId/taskNo 到 completed、不新建任务）、`:328`（不补答则不重复执行）；平台侧
`packages/agent/task-runner.test.ts:846`/`:874`/`:889`。

## 6. 任务编号与展示词表：单一来源

| 事实 | 唯一来源 | 消费方 |
|---|---|---|
| `taskNo`（数字编号，唯一不复用） | 底账单条 SQL 计数器：`packages/core/src/task-store.ts:571`（迁移回填 `:538`） | 任务行；展示层只读 |
| `#<no> <name>` 标签 | `taskNoLabel` / `taskLabel`（`scripts/tasks.ts:248`、`:256`） | `scripts/ask.ts:159` 证据行、`scripts/ops.ts:299`、`scripts/tasks.ts:294` 列表 |
| 引用解析（`#编号`/纯数字/taskId） | `findTaskRef`（`scripts/tasks.ts:266`）；对话面 `resolveTaskId` 只在**本会话 scope** 内解析（`packages/agent/src/execution-runtime.ts:1106`，跨会话=找不到） | CLI 详情/导出/redo；`task_status`/`task_result` |
| 业务名称 | `deriveTaskName`（`packages/agent/src/task-registry.ts:115`）：新行写入、历史 NULL 显示回落、`statusView` 同一函数（`packages/agent/src/execution-runtime.ts:1124`） | 展示层、模型可见投影 |
| 状态词 / 原因词 | `TASK_STATUS_WORDS`（`scripts/tasks.ts:152`，终态词键绑定 `judgeReportedTask` 返回类型 `:145`）、`TASK_REASON_WORDS`（`:163`） | `taskStatusWord`/`taskReasonWord`（`:180`，未知值 fail-open 显示原值）；`scripts/ops.ts:37` 直接 import，不复制词表 |

词表同源由对账测试钉住：`scripts/ops.test.ts:305`（ops 最近任务 9 态逐词与 tasks 列表一致）、
`scripts/tasks.test.ts:211`（9 态金样 + 未知态 fail-open）。

> ⚠️ 文档与代码不一致：P1/P6 报告写"受理回执含 `#<taskNo>`"，现行后台受理回执**不含编号**——
> `backgroundTaskReceiptNotice`（`packages/agent/src/execution-runtime.ts:742`）只有"已受理「名称」，在后台办理中"；
> 测试 `scripts/needs-input-resume.test.ts:243` 明确断言回执不含 `#`。编号经 `task_status`（或 CLI）取。

## 7. 不承诺什么 / 相邻出口

- **不是 Exactly Once**：只承诺"同一 `dispatchKey` 至多一次自动执行 + 结果未知可核对"
  （`packages/contracts/src/execution-contract.ts:80`）。业务效果是否只写一次归执行层幂等键/状态查询。
- **跨重启渠道重投不幂等**：`messageId` 去重是 server 的内存 Map（`apps/server/server.ts:460`，回放 `:621`，
  上限 1024 `:79`）；重启后同一 `messageId` 是新回合 → 可能新建任务（任务表无 `messageId` 列）。
- **重启恢复只护 `taskId` 不自动重跑**：`queued` 重领（`packages/agent/src/task-registry.ts:793`），过期租约 `running → failed +
  result_unknown` 且零重放（`:808`）；测试 `packages/agent/task-runner.test.ts:639`。
- **`--redo` 是重新交办，不是续跑**：输入=存储的 `task.request` 逐字、新任务、原任务零改动
  （`scripts/tasks.ts:541`、`:592`）；可重推集合只有 `completed/failed/unexecuted`，`cancelled/timed_out`
  fail-closed 拒绝（`:511`、`:562`）。
- **模型把一笔意图拆成两次调用 → 两笔都执行**（两条独立身份，见 §2）；这是登记在案的失败形态，
  不写成"不会重复"，兜底在执行层。

## 来源

本页由以下文档收拢（除标「现存」者外均已从 `docs/` 删除，git 历史可考；每篇只保留"今天做决定/排障还读"的条款）：

- `p2a-task-contract.md`（现存：`docs/product/p2a-task-contract.md`）——状态集/合法边/单写路径/机械原因/契约测试判据；
- `p2b-display.md`——9 态用户词与 5 种原因行金样、未知值 fail-open；
- `p1-ledger.md`——`taskNo` 原子分配不复用、`deriveTaskName` 机械回落、回复存档；
- `p1-task-viewing.md`——只读消费底账、不在读时重算终态；
- `p3-human-redo.md`（现存：`docs/product/human-redo.md`）——redo 输入=存储原文逐字、仅终态、原任务零改动；
- `p6-task-runner.md`——受理即 `queued`、租约认领、重启恢复、取消/接续分派；
- `p7a-ask-first.md`——交互/回放共用同一装配（未涉及任务生命周期的部分未取）；
- `idempotency-cross-restart.md`——三处幂等覆盖边界与"跨重启不幂等"的结论；
- `pi-152-dispatch-key-design.md`（U3 设计；合入决定 §九十七）——两层身份、铸造点唯一、证明边界、R0–R5 规则；
- `s4-stats-four-state.md`——**未取**（评测统计口径，不属任务生命周期）；
- `gap-task-surface.md`——工具只收任务引用、scope 由宿主注入、取消/接续只转述 outcome。

> 裁定（owner 2026-11-17）：**跨会话续办不做**。任务 scope 恒为 `(principalId, sessionId)`；不要据此扩成跨会话授权面（原文 `docs/history/decision-log-part06-2026-11_undated.md`，结论亦见 `docs/decisions/debt.md`）。
