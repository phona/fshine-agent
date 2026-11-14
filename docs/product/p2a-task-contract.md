# P2a Task Registry 契约核心 · 冻结记录（2026-11-14）

> 本文件 = P2a「最小 Task Registry 契约核心」的冻结记录；依据 r4-joint-interfaces.md §10（v1.2）
> 「P2a 冻结记录（docs/product/p2a-task-contract.md）须逐条登记这些处置」逐条登记。
> 契约来源：`r4-joint-interfaces.md` §1（v1，主仓 9ae895d）+ §9（v1.1，主仓 6e4be01）+ §10（v1.2，主仓 5d48ab4）。
> 实现位置：`packages/agent/src/task-registry.ts`（状态机 + 内存实现）、`packages/agent/src/task-registry-sqlite.ts`（SQLite 实现）、
> `packages/core/src/task-store.ts`（v3 迁移 + 唯一状态写入语句）；本记录不修改任何契约文本。

## 1. 契约核心（冻结判据）

- **状态集**：`queued | running | waiting_user | cancelling | cancelled | completed | failed | timed_out`；保留 `unexecuted`（已汇报零执行）。
- **合法转换**（其余一律拒绝并留痕：`TaskTransitionError`，状态不变、零事实）：
  - `queued→running`（并含 `claimNextQueued` 原子认领 + 租约）；
  - `queued→cancelling→cancelled`；
  - `queued→timed_out`（**v1.2 登记**，见 §2.1）；
  - `running→{completed | failed | waiting_user | cancelling | timed_out}` + `unexecuted`（保留的内联零执行终态）；
  - `waiting_user→{running（答复接续） | cancelling | timed_out}`（timed_out 为 **v1.2 明示**，见 §2.2）；
  - `cancelling→cancelled`（确认后才落）；`cancelling→running`（中止未获确认不得宣称取消，回滚并留痕）。
- **唯一写路径**：所有状态变化经 TaskRegistry 方法族（原子持久化 + `onTaskFact` 事实钩子）；SQLite 侧单条
  `applyTaskState` 语句（`WHERE task_id AND status=@expectedStatus` 乐观并发）；模块禁止直接 `UPDATE tasks.status`
  （源码级守卫：`packages/agent/task-registry-write-path.test.ts`）。
- **方法族**（签名实现自定）：`begin` / `get` / `list(scope)` / `transition` / `waitForUser` / `answerResumes` /
  `requestCancel` / `confirmCancelled` / `timeout(kind)` / `markResultUnknown` / `claimNextQueued` / `expireLeases` /
  `onTaskFact` + 既有 `noteExecution` / `complete` / `fail` / `archiveReply`（inline 冻结语义保持，`judgeReportedTask` 零改动）。
- **取消语义**：`requestCancel` 只落 `cancelling`（请求 ≠ 取消）；`confirmCancelled` 才落 `cancelled` + `reason=cancelled_by_user`；
  未确认经 `transition(→running)` 回滚后可正常完成。
- **waiting_user 形状**：`pending_question`（JSON：`missing[]`、`candidates?[]`、`raw?`）+ `waiting_since` 原样持久化；
  `answerResumes` 清等待形状、**同一 Task** 继续（`task_no` 不变、executions 追加、不得新建任务）；后台路径按执行层
  确认结果 `transition` 落终态（不走 inline `judgeReportedTask`——其「首个非 completed 判负」语义被表征测试冻结）。
- **归属**：principal + session 绑定；越权与不存在同一 `TaskOwnershipError`（8 个读写方法逐一对账）。

## 2. v1.1 / v1.2 处置逐条登记

### 2.1 `queued→timed_out`（v1.2 §10）
- 登记：`timeout(taskId, 'queued')` 合法，落 `timed_out` + `reason=timeout`；契约测试矩阵按冻结验收 P2-T04
  「排队等待超时」锁死（`EXPECTED_LEGAL.queued` 含 `timed_out`；`timeout` 种类与当值状态不匹配一律拒绝）。
- 说明：v1.2 前 §1 列举边遗漏该边；P2a 首版按 P2-T04 先行实现并在实施报告登记，v1.2 已对齐确认。当前实现与 v1.2 一致。

### 2.2 `waiting_user→timed_out`（v1.2 §10）
- 登记：`timeout(taskId, 'waiting_user')` 关闭活跃等待（状态落 `timed_out`），**保留历史与原因**——
  `pending_question` / `waiting_since` 不清空，`reason=timeout`；超时后 `answerResumes` 确定性拒绝（不可再续）。

### 2.3 `result_unknown` 承载（v1.1 §9 + v1.2 §10 再确认）
- 登记：状态=`failed` + `reason=result_unknown`（终态；与 `failed_confirmed` 以 reason 区分；不自动重放）。
- 路径：`markResultUnknown`（running→failed+result_unknown）与 `expireLeases`（过期租约→同一路径）一致；
  `claimNextQueued` 不复取该终态、二次过期零变化。
- P4 侧以 `failed` 意图 + `payload.reason=result_unknown` 如实携带（P4 轨实现，不在 P2a 范围）。

### 2.4 `TaskFact.stateVersion`（v1.1 §9）
- 登记：`TaskFact = { taskId, taskNo, name, from?, to, reason?, at, stateVersion? }`，`stateVersion?: string | number`。
- P2a 实现：**每条事实携带 `stateVersion`，缺省 = `at`**（无注册表计数器；集成若需更精确版本可显式提供，
  `TaskFactSeed.stateVersion` 已留口）。P4 侧唯一键 `state_version = fact.stateVersion ?? fact.at` 因此值稳定。
- `begin` 创建事实无 `from`（不是状态转换）；拒绝的转换零事实；钩子异常被隔离（不回滚已持久化事实）。

## 3. v3 迁移（底账）

- 新增列：`reason` / `pending_question` / `waiting_since` / `lease_owner` / `lease_until`；`PRAGMA user_version=3`。
- 纪律（沿用 P1）：可写打开且缺列时迁移；**迁移前自动备份** `<db>.backup-v3`（目标版本命名、内容=迁移前字节、不覆盖）；
  **只读打开永不迁移**（主库哈希不变、新列读出缺省）；仅缺 `task_no` 时按 `(created_at, task_id)` 回填编号；迁移幂等。
- 租约不变量：仅 `running` 持有租约；离开 `running` 即清空；`expireLeases(now)` 仅取 `lease_until` 非空且 ≤ now 的行。

## 4. 冻结判据与证据

- 契约测试（决策判据，全绿）：`packages/agent/task-registry-contract.test.ts`（9×9 合法/非法矩阵、取消语义、
  waiting_user 持久化与接续、超时三链+保留历史、result_unknown 不重放、归属同错、事实钩子与 stateVersion、
  claim/lease；内存与 SQLite 双实现同判据 + SQLite 跨重启）；
  `packages/core/task-store-migration-v3.test.ts`（v2→v3、v1→v3、只读不迁移、新库 v3、applyTaskState 乐观并发）。
- 单写路径守卫：`packages/agent/task-registry-write-path.test.ts`（task-store 之外零 `UPDATE tasks`；
  task-store 内写 status 语句恰 1 条；registry 实现层无裸 SQL）。
- 门：`npx tsc --noEmit` + `npm test`（全量 unit，只增不减）；实现/证据见分支 `arch/r4-p2`
  （test 先红 a699534 → 实现 d8facf0；本记录与 stateVersion 补齐见后续提交）。

## 5. 边界（不做，留 P2b / 集成）

- 不做：execution-runtime 接线、`tasks`/`ops` 展示词表金样与原因行、E05/E06 回归（P2b）；`server.ts` / `ask-runtime.ts` 未动。
- 既有测试的最小对齐（非弱化断言）：P1 迁移测试备份名随目标版本改 `.backup-v3`；readonly 用例保留 running 走合法边
  （终态写现在于存储前被状态机确定性拒绝）；命名守卫要求下重命名测试内标识符。
- `scripts/tasks.ts` 仅补 5 个新状态的最小中文词（类型闭合），展示金样与原因行留 P2b。
