# P2a Task Registry 契约核心 · 冻结记录（2026-11-14）

> 本文件 = P2a「最小 Task Registry 契约核心」的冻结记录；依据 r4-joint-interfaces.md §10（v1.2）
> 「P2a 冻结记录（docs/product/p2a-task-contract.md）须逐条登记这些处置」逐条登记。
> **契约来源与冻结 SHA**：`r4-joint-interfaces.md` §1（v1，主仓 `9ae895d`）+ §9（v1.1，主仓 `6e4be01`）
> + §10（v1.2，主仓 `5d48ab4`）；**冻结实现 SHA**：`d8facf0`（契约核心：状态机/迁移/单写路径守卫）+
> `7c440f3`（TaskFact.stateVersion）；本记录初版 `498da35`。**冻结后任何契约条款变更须由集成负责人提案并
> 版本化登记（joint-interfaces §10 纪律）；各轨不得自行修改契约文本。**
> 实现位置：`packages/agent/src/task-registry.ts`（状态机 + 内存实现）、`packages/agent/src/task-registry-sqlite.ts`
> （SQLite 实现）、`packages/core/src/task-store.ts`（v3 迁移 + 唯一状态写入语句）。

## 1. 契约条款清单（逐条对照 §1 与 v1.1 / v1.2）

| # | 条款（来源） | 冻结内容 | 实现/判据 |
|---|---|---|---|
| 1 | 状态集（§1） | `queued/running/waiting_user/cancelling/cancelled/completed/failed/timed_out`；保留 `unexecuted` | `TASK_STATUSES`（task-registry.ts:42）；测试「冻结状态集」 |
| 2 | 合法转换（§1；v1.2 补齐两条） | `queued→running`；`queued→cancelling→cancelled`；`queued→timed_out`（v1.2）；`running→{completed/failed/waiting_user/cancelling/timed_out}`；`waiting_user→{running/cancelling/timed_out}`（timed_out 为 v1.2 明示）；`cancelling→cancelled`；`cancelling→running`（中止未获确认回滚）；其余一律拒绝 | `LEGAL_TRANSITIONS`（task-registry.ts:230）；测试「合法/非法转换矩阵」（9×9，双实现） |
| 3 | cancelling 过渡态（§1） | 取消请求 ≠ 已取消：`requestCancel` 落 `cancelling`；`confirmCancelled` 才落 `cancelled` | `reduceTaskState` 的 requestCancel/confirmCancelled 分支；测试「取消语义」 |
| 4 | waiting_user 形状（§1） | 行持久化 `pending_question`（`missing[]`/`candidates?[]`/`raw?`）+ `waiting_since`；答复续**同一 Task**（`task_no` 不变、executions 追加、不新建任务）；inline 路径维持现冻结语义（`judgeReportedTask` 不改，waiting_user 仅后台） | `waitForUser`/`answerResumes`；测试「waiting_user 持久化与接续」+ SQLite 跨重启 |
| 5 | 失败/终止原因（§1；v1.2 再确认） | 枚举 `cancelled_by_user/timeout/failed_confirmed/result_unknown/resource_limited`；`result_unknown` 落 `failed` + `reason=result_unknown`（终态、不自动重放） | `TASK_REASONS`（task-registry.ts:57）、机械原因由目标决定（防编造）；测试「result_unknown 不自动重放」 |
| 6 | 唯一写路径（§1） | 所有状态变化经 TaskRegistry 方法族（原子持久化 + 事实钩子）；任何模块禁止直接 `UPDATE tasks.status` | SQLite 侧单条 `applyTaskState`（task-store.ts:356）；守卫 `task-registry-write-path.test.ts`（status 直写零命中） |
| 7 | 最小方法族（§1） | `begin / get / list(scope) / transition / waitForUser / answerResumes / requestCancel / confirmCancelled / timeout / markResultUnknown / claimNextQueued / expireLeases / onTaskFact` | 见 §2 签名；测试按方法逐一覆盖 |
| 8 | 事实钩子（§1；v1.1 补 stateVersion） | 单回调 `onTaskFact(fact)`；`TaskFact={taskId,taskNo,name,from,to,reason?,at,stateVersion?}`；`stateVersion` 缺省=at；无订阅体系/持久化事件流 | `TaskFact`/`onTaskFact`；测试「onTaskFact」「stateVersion」 |
| 9 | 归属（§1） | principal+session 绑定；越权与不存在同错 `TaskOwnershipError` | `require`（双实现）；测试「归属：越权与不存在同一错误」（8 方法逐一对账） |
| 10 | 契约测试判据（§1） | 合法/非法矩阵；取消语义；waiting_user 持久化与接续；超时关闭保留历史；unknown 不自动重放；越权同错；单写路径守卫 | 见 §4 清单与读数 |
| 11 | 超时链（§1/§5；v1.2） | `timeout(kind)`：queued（排队等待）/execution（执行）/waiting_user（关闭活跃等待）；均落 `timed_out`+`reason=timeout`；等待超时**保留** pending_question/waiting_since 历史 | `timeout` 分支（种类与当值状态不匹配即拒绝）；测试「超时」 |
| 12 | 取消链（§1/§5） | `request → cancelling →（确认）cancelled /（未确认）running` | 同 #3；测试含回滚后正常完成 |
| 13 | unknown 链（§1/§5） | 重启后不可确认 → `result_unknown`；`markResultUnknown` 与 `expireLeases`（过期租约）同一路径 | 测试「认领→租约过期→终态」「跨重启不自动重放」 |

## 2. 方法族签名与语义（签名实现自定；以下为冻结语义的签名口径）

```ts
begin(input: { taskId; principalId; sessionId; request; status?: 'queued' | 'running' }): TaskRecord   // 缺省 running（inline）；queued=后台受理
get(taskId, scope: TaskScope): TaskRecord               // 越权/不存在同 TaskOwnershipError
list(scope?: TaskScope): readonly TaskRecord[]
transition(taskId, to: TaskStatus, options?: { reason?: TaskReason; scope?: TaskScope }): TaskRecord
waitForUser(taskId, pendingQuestion: PendingQuestion, options?: { scope? }): TaskRecord   // running→waiting_user + 形状
answerResumes(taskId, options?): TaskRecord             // waiting_user→running；清等待形状；同 task_no 续跑
requestCancel(taskId, options?): TaskRecord             // queued/running/waiting_user→cancelling（请求 ≠ 取消）
confirmCancelled(taskId, options?): TaskRecord          // cancelling→cancelled + cancelled_by_user
timeout(taskId, kind: 'queued' | 'execution' | 'waiting_user', options?): TaskRecord
markResultUnknown(taskId, options?): TaskRecord         // running→failed + result_unknown
claimNextQueued(input: { owner: string; leaseMs: number }): TaskRecord | undefined  // 原子 queued→running + 租约
expireLeases(now?: string): readonly TaskRecord[]       // 过期租约→result_unknown；返回受影响任务
onTaskFact(hook: (fact: TaskFact) => void | undefined): void                        // 单回调替换
// 既有：noteExecution / complete / fail / archiveReply（inline 冻结语义保持；complete 仍走 judgeReportedTask）
```

要点：变更方法给出 `scope` 时先校验归属（越权与不存在同错）；非法转换抛 `TaskTransitionError`（携 `from`/`to`，状态不变、零事实）；机械原因与目标状态不符即拒绝（防编造）；`TaskFact.stateVersion` 缺省 = `at`（无计数器，集成可显式提供）；钩子异常被隔离，不回滚已持久化事实。

## 3. v3 迁移口径与读数

- 口径：新增列 `reason`/`pending_question`/`waiting_since`/`lease_owner`/`lease_until` 与 `PRAGMA user_version=3`
  （task-store.ts:61/:194）；可写打开且缺列时迁移；**迁移前自动备份 `<db>.backup-v3`**（目标版本命名、内容=迁移前字节、不覆盖）；
  **只读打开永不迁移**；仅缺 `task_no` 时按 `(created_at, task_id)` 回填；迁移幂等；新库直接 v3。
- 读数（本条独立脚本 `npx tsx .runtime/p2a/migration-readings.ts`，输出 `.runtime/p2a/migration-readings.txt`）：
  - 迁移：补齐列=`reason,pending_question,waiting_since,lease_owner,lease_until`；`user_version=3`；备份名=`state.db.backup-v3`；
    备份 sha = 迁移前字节 sha（true）；历史行零改动（true）；新任务编号接续（task_no=2）；
    二次打开：行 `[task_a#1, task_new#2]`、历史行零改动（true）、备份文件数=1（不新增）。
  - 只读：主库哈希不变（true）；未创建备份（true）；未加 v3 列（列集合仍为 v2 的 12 列）；新列读出缺省
    （reason/pendingQuestion/leaseOwner 均 undefined）；旧字段可读（task_no=1、reply_text 可读）。
  - 测试读数：`packages/core/task-store-migration-v3.test.ts` 7/7 绿（v2→v3、v1→v3 一次补齐、只读不迁移×2、新库、applyTaskState 乐观并发）。

## 4. 契约测试清单与读数

| 测试文件 | 用例组 | 读数 |
|---|---|---|
| `packages/agent/task-registry-contract.test.ts` | 状态集；begin 缺省/queued；9×9 合法/非法矩阵（双实现）；取消语义；waiting_user 持久化与接续；waiting_user 非法入边；超时三链+保留历史；result_unknown 不自动重放；claim/lease；归属同错；onTaskFact；stateVersion（双实现）+ SQLite 跨重启（waiting/unknown/cancelling/cancelled/timed_out） | 27/27 绿 |
| `packages/agent/task-registry-write-path.test.ts` | ① task-store 之外零 `UPDATE tasks`（hits=0）；② task-store 内写 status 语句恰 1 条（实测 UPDATE tasks 共 4 条、statusWriters=1）；③ registry 实现层无裸 SQL | 3/3 绿 |
| `packages/core/task-store-migration-v3.test.ts` | v2→v3 幂等/备份/user_version/历史零改动；v1→v3 一次补齐+回填；只读不迁移（哈希不变）；新库 v3；applyTaskState 单语句+乐观并发 | 7/7 绿 |

- 全量门读数：`npx tsc --noEmit` 0 错误；`npm test` = **48 files / 462 tests passed**；
  基线（`9ae895d`，临时 worktree 实测）= 45 files / 425 tests → **+3 files / +37 tests，0 删除**
  （`git diff 9ae895d..HEAD -- '*.test.ts'` 无删除的 `it(`/`describe(`）；只增不减成立。
- 反向绊线（四类，破坏不提交、逐条还原）：放宽转换表→矩阵红；requestCancel 直落 cancelled→取消语义红；
  result_unknown 当成功→unknown 红；裸 SQL 直写→守卫红；还原后全量复绿、工作树干净
  （证据 `.runtime/p2a/tripwire2-*.txt`）。

## 5. 未明示项处置清单（逐条登记）

1. **`result_unknown` 的目标状态**（§1 只写「落 result_unknown」，状态集无该态）：处置 = `failed` + `reason=result_unknown`；
   与 `failed_confirmed` 以 reason 区分、终态、不自动重放；v1.1/v1.2 已再确认（P4 以 `failed` 意图 + `payload.reason=result_unknown` 承载）。
2. **`queued→timed_out`**（§1 原列举遗漏）：v1.2 已补齐；处置 = `timeout(id,'queued')` 合法，落 `timed_out`+`reason=timeout`。
3. **`waiting_user→timed_out`**（§1 边集未列、同条超时句与 §5 超时链已指）：v1.2 已明示；处置 = 关闭活跃等待、落 `timed_out`、**保留历史形状**。
4. **`TaskFact.from` 的创建事实**（§1 未明示）：处置 = `begin` 发 `to=初始状态` 的创建事实、无 `from`（不是状态转换）；转换事实 `from`/`to` 恒在。
5. **`TaskFact.stateVersion`**（v1.1）：处置 = 类型 `string | number` 可选；发射缺省 = `at`；不建计数器（集成可显式提供）。
6. **租约不变量**（§1 只说 claimNextQueued 含 lease 字段）：处置 = 仅 `running` 持有租约；离开 `running` 即清空；
   `expireLeases` 仅取 `lease_until` 非空且 ≤ now 的行（无租约的 inline running 不误判）。
7. **非法转换的拒绝形态**（§1 只说「拒绝并留痕」）：处置 = `TaskTransitionError`（携 `from`/`to`/detail），状态不变、零事实；拒绝事实可由调用方审计。
8. **通用 `transition` 与 waiting_user 形状**：§1 列 `running→waiting_user` 为合法边；处置 = 通用 `transition` 允许该边（仅翻状态），
   写等待形状的**规范入口**是 `waitForUser`（后台路径使用）；形状缺失不伪造。
9. **inline 保留终态 `unexecuted`**（§1「保留」，边集未列）：处置 = 矩阵保留 `running→unexecuted`，仅由 `complete`（零执行判定）走；`judgeReportedTask` 零改动。
10. **备份命名**（§1 未明示）：处置 = `<db>.backup-v<迁移目标版本>`（当前 `.backup-v3`），沿用 P1「迁移前自动备份、不覆盖、不自动删除」纪律；
    既有 P1 测试的备份名字面量随之对齐（.backup-v2 → .backup-v3，断言实质不变）。
11. **旧库只读读出**：处置 = 未迁移旧库只读打开时新列读出为缺省（不崩溃、不伪造）；只读永不迁移（哈希不变）。

## 6. 边界（不做，留 P2b / 集成）

- 不做：execution-runtime 接线、`tasks`/`ops` 展示词表金样与原因行、E05/E06 回归（P2b）；`server.ts` / `ask-runtime.ts` / `judgeReportedTask` 未动。
- `scripts/tasks.ts` 仅补 5 个新状态的最小中文词（类型闭合），展示金样与原因行留 P2b。
- 契约文本（`r4-joint-interfaces.md`）由集成负责人维护；本记录只登记 P2a 的处置与读数，不改契约条款。
