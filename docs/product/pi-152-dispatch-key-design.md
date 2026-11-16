# Pi 1.5.2 迁移 U3 · 稳定逻辑操作身份（dispatchKey）设计

- 对象：worktree `~/projects/fshine-agent-pi-upgrade`，分支 `arch/pi-upgrade`，HEAD `b997f15`。
- 性质：**设计文档，只设计不改产品代码**；本文件不附带实现、不改契约类型、不动底账 schema。文中所有 `文件:行号` 均指当前 HEAD 的只读事实，可逐条复核。
- 起因：阶段 B 登记的 U3「溢出恢复重试会重新执行同一非幂等工具」（`docs/product/pi-152-stage-b.md:97-106`；确定性注入 D-duplicate 见同文 `:77`，判据行 `:51`）。
- owner 已批准范围：Execution Contract 可增加稳定逻辑操作身份 `dispatchKey`。未批准：重构编排层、第二套 Task Registry、宿主计划治理、Token/预算管理、把 Pi 压缩治理搬回宿主。本设计逐条守住这条边界（§12）。

---

## 0. 结论摘要

1. **两个身份分开**：`delegationId`（交办意图，「这是同一次交办吗」）与 `dispatchKey`（业务操作，「这是同一笔业务操作吗」）。前者就是现有 `tasks.task_id`（不新增列、不改名）；后者是新表 `operations` 的主键。
2. **铸造点唯一**：`dispatchKey = "dk_" + scope_key + ":" + opSeq`。`opSeq` 由宿主在**首次创建这笔逻辑操作**时原子分配并落库，之后只读。允许此时出现 UUID（`scope_key` 里的 `taskId` 就是 UUID），**禁止**在每次 toolCall / 重试 / 重新规划时重新生成身份。
3. **重绑定不靠参数**：认领 API **结构上不接收 args**（§4.4），因此「按参数文本/哈希去重绑定」没有代码路径可走。重绑定只读三样持久化事实 + 一个 Pi 原生事件事实：`operations(scope_key, op_seq, operation, status, outcome_json, attempt)`、`tasks.task_id/principal_id/session_id`、以及运行时自己的「本轮重试/溢出恢复」事件。
4. **证明边界写死**：能证明 → 绑定并返回已记录结果（零副作用）；不能证明 → **停止副作用，落 `running→failed + reason=result_unknown`（复用既有 `markResultUnknown`），工具结果返回「待核对」固定事实**，不自动重试、不猜绑定。
5. **不是 Exactly Once**：宿主只承诺「同一身份至多自动执行一次 + 结果未知可核对」；外部是否真的只写一次取决于执行层幂等键/状态查询，契约无法强制（§7）。

---

## 1. 问题事实（U3 的机制，不是推测）

| 事实 | 证据 |
| --- | --- |
| 同一回合内同一 `create_record` 被执行 2 次（同 turn、同 args），最终文本仍是「已完成。」 | `docs/product/pi-152-stage-b.md:77` |
| 触发链：工具结果后下一请求溢出 → 自动压缩 → `_overflowRecoveryAttempted` → `agent.continue()` 重试；`_omitRecoveryAttempt` 只把失败尝试及其 toolResult 用 `context_edit` 从投影隐藏，**不回滚已发生的副作用** | 同上 `:97-106`（上游源码行号在文内） |
| 真实样本 `duplicateToolExecs` 为空，但确定性注入已复现该机制 | 同上 `:51`、`:108` |
| 宿主今天对每次调用都新生成 `requestId`，且执行记录是**调用返回之后**才写 | `packages/agent/src/execution-runtime.ts:471-479`（inline）、`:793-800`（background） |
| 宿主今天对每次 `run_task` 都新生成 `taskId` | `packages/agent/src/execution-runtime.ts:521` |
| 契约今天只承诺 `requestId` 的稳定与唯一，无操作级身份 | `packages/contracts/src/execution-contract.ts:10-12`、`:59-63` |
| 任务级「重复受理」拒绝只护**同 taskId**（新 taskId 恒不触发） | `packages/agent/src/task-runner.ts:551-567` |

**结论**：现状不是「key 不够随机」，而是**宿主没有任何持久化的逻辑操作身份**，重试路径上每次都等价于一笔新操作；崩溃窗口里更是连「发生过一次调用」都没有落库（记录写在调用之后）。

---

## 2. 现有身份盘点

| 字段 | 生成点 | 生命周期 | 能否当身份 |
| --- | --- | --- | --- |
| `tasks.task_id` | `execution-runtime.ts:521`（`task_<uuid>`） | 落库后跨重启存在（`task-registry.ts:516-535`；SQLite 实现在 `task-registry-sqlite.ts:159-184`，表定义 `packages/core/src/task-store.ts:156-174`） | **能**：这就是交办意图身份（§3 I1） |
| `tasks.principal_id/session_id` | 装配层可信事实（`execution-runtime.ts:351`） | 落库 | 身份**作用域**，不是身份本身；越权读同一错误（`task-registry.ts:189-194`、`task-registry-sqlite.ts:96-105`） |
| `tasks.task_no` | 底账单条 SQL 原子分配（`task-store.ts:332-352`、`:316-318`） | 落库、不复用 | 用户可见编号；内部身份用它会把「显示」与「去重」绑在一起，**不用** |
| `executions.request_id` | 每次调用 `execution-runtime.ts:471`、`:793` | 调用返回后落库，主键（`task-store.ts:180-187`） | **不能**：它就是「每次调用」，重试必换 |
| `executions.operation/status` | 同上 | 落库 | 描述性事实，非身份（无唯一约束，可重复） |
| `toolCallId` | Pi 每次工具调用生成（`node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:483-497`）；产品驱动当前**丢弃不用**（`pi-driver.ts:309` 的 `_toolCallId`） | 单次调用 | **不能**：重试即新值；只作追踪 |
| `slot.retryScheduled` / `slot.recovered` | `pi-driver.ts:459-484` | 进程内 | 运行时重试事实（**本设计的事件来源**，不是身份） |

---

## 3. 两个独立身份

### I1 · 交办意图身份 `delegationId`

- 语义：「这是同一次交办吗」。一次 `run_task` 在宿主侧被受理并持久化后，就有一条 `tasks` 行；`delegationId := tasks.task_id`。
- 铸造：**首次创建交办时**由可信宿主生成 UUID（`execution-runtime.ts:521`），并立刻落库——inline 在 `:559` `registry.begin`，background 在 `:540` `taskRunner.submit`（`task-runner.ts:551-567`）。这不是新机制，现状已经如此。
- 禁止：重试/重新规划时另造一条 `tasks` 行来「表示同一次交办」。新增行 = 新交办，这是既有语义（重复同一句话是新授权，不是缓存命中），本设计不改。
- 为什么它就是「够用」的身份：`tasks` 行带 `principal_id/session_id`，越权读同一错误（`task-registry.ts:440-449`），所以「同一次交办」天然带可信作用域，不需要第二套归属。

### I2 · 业务操作身份 `dispatchKey`

- 语义：「这是在**某一次交办内**的一笔业务操作吗」——例如 Worker 的一次 `execute_operation`，或 Main 的一次 `run_task`（`run_task` 在宿主侧也是一笔操作，见 §5.5）。
- 载体：新表 `operations` 的一行。**行就是身份**，`dispatchKey` 只是它的键字符串：

```sql
CREATE TABLE operations (
  dispatch_key   TEXT PRIMARY KEY,
  scope_key      TEXT NOT NULL,             -- 身份作用域：'task:<taskId>'（交办内操作）或 'turn:<sessionId>:<turnNo>'（Main 的 run_task）
  task_id        TEXT REFERENCES tasks(task_id),  -- 可空：turn 作用域的 run_task 在 settle 时写入它创建的任务
  op_seq         INTEGER NOT NULL,          -- 作用域内单调递增，首次创建时分配，永不复用
  operation      TEXT NOT NULL,             -- 宿主侧操作名（run_task / execute_operation 的实际 operation）
  status         TEXT NOT NULL,             -- claimed | completed | needs_input | failed | refused | unknown | reconciling
  reason         TEXT,                      -- 可空：待核对/冲突的机械原因（unresolved_reason）
  outcome_json   TEXT,                      -- 执行层原始 outcome / run_task 受理回执（completed 时即「已有结果」）
  attempt        INTEGER NOT NULL,          -- 认领时所在运行时回合号（重放窗口判定，见 §5.2）
  claimed_at     TEXT NOT NULL,
  settled_at     TEXT,
  delivered_at   TEXT,                      -- 结果已交回 Pi 转录的时刻（NULL = 模型没看到）
  replay_of      TEXT,                      -- 可空：本行是哪个 dispatch_key 的重放（审计用）
  UNIQUE (scope_key, op_seq)
);
CREATE INDEX idx_operations_scope ON operations (scope_key, op_seq);
```

`dispatchKey = "dk_" + scope_key + ":" + String(op_seq)`。

作用域为什么是两层而不是只有 `task_id`：交办**内部**的操作（Worker 的 `execute_operation`）挂在已存在的 `task_id` 上；而 Main 的 `run_task` 本身就是「创建交办」那一笔操作，此时任务还没创建，作用域只能是回合（`turn:<sessionId>:<turnNo>`，会话消息本来串行，见 `apps/server/server.ts:6`），`task_id` 在 settle 时回填。两条路径共用同一套铸造/绑定规则（§5.5）。

- **为什么是派生而不是另掷一个 UUID**：派生的键是持久化字段的纯函数，所以「重建出来的字符串」与「当初铸造的字符串」按构造相等——这正好消除「恢复后是不是又掷了一个新身份」的歧义。身份仍然只在插入那一行时被**铸造一次**（`op_seq` 只分配一次）；rollback 才回收编号，与 `task_no` 同口径（`task-store.ts:31-37`）。
- **禁止的唯一约束**：`operations` 上**没有**、也**不得有**任何以 `(operation, args)` 或 args 哈希为键的唯一约束/索引。唯一性只表达「身份唯一」，不表达「内容相同」（§8 反向要求）。

---

## 4. 铸造与落库（先落库、再调用）

### 4.1 调用前必须有一行 `claimed`

现状违反了「先落库、再调用」：`client.execute(...)`（`execution-runtime.ts:472`、`:794`）先发生，`noteExecution` 后发生（`:479`、`:795-800`）。窗口内进程死亡 = 执行层可能已写入而宿主零记录。U3 的最小修复必须把顺序改成：

```
claim（INSERT operations, status='claimed'）→ client.execute({requestId, dispatchKey, ...}) → settle（UPDATE operations, outcome/delivered）
```

`requestId` 仍在 `claim` **之后**生成（`req_<uuid>`），只作本次调用的追踪号；`dispatchKey` 在 `claim` 时确定，不随后续调用变化。

### 4.2 原子认领（并发与重入）

- `op_seq = COALESCE(MAX(op_seq),0)+1 WHERE scope_key=?` 与 `INSERT` 在**同一 `BEGIN IMMEDIATE` 写事务**里完成。仓内已有同款先例：`claimQueued`（`task-store.ts:393-417`，注释在 `:41-45`）。
- 唯一约束兜底：`dispatch_key` 主键 + `UNIQUE(scope_key, op_seq)`。并发两个认领不可能拿到同一行（SQLite 写事务串行 + 主键冲突）。
- **进行中的重复请求不得并发执行**：同一个 `dispatchKey` 已有 `claimed` 行时，第二次认领返回 `in_progress` 事实（携带 key 与 `claimed_at`），**不发起第二次 `client.execute`**。这是「确定性拒绝」而不是排队（与 `task-runner.ts:551-567` 的重复受理拒绝同风格）。

### 4.3 `settle` 与「同 Key 同操作返回已有结果」

- `settle(dispatchKey, outcome)`：`status` 取 outcome 四态（`execution-contract.ts:65-96`）+ `outcome_json` 原样存 `data`/`error`/`missing`，`delivered_at` 在工具结果交回 Pi 时写。
- 后续同 key 且 `operation` 相同：**直接回放 `outcome_json`**，不调 `client.execute`。
- 后续同 key 但 `operation` 不同：`dispatch_conflict` 确定性拒绝（零副作用，行不改）。

### 4.4 结构性保证：认领函数看不见参数

```
operations.claim({ scopeKey, operation, attempt, now, replayWindow? })
  → { kind: 'minted',      dispatchKey, opSeq }
  | { kind: 'replayed',    dispatchKey, opSeq, outcome }        // 已有结果，零调用
  | { kind: 'in_progress', dispatchKey, opSeq, claimedAt }      // 不并发执行
  | { kind: 'unresolved',  reason: 'ambiguous_replay' | 'prior_unknown', dispatchKey? }  // → 待核对
  | { kind: 'conflict',    reason: 'operation_mismatch', dispatchKey }
```

签名里**没有 args 参数**。这不是约定，是接口形状：任何「按参数文本/哈希绑定」的写法都要先改签名，会被 §9 的源码级守卫当场判红。`operation` 是执行层声明的能力名（`execution-contract.ts:44-50`），不是参数文本。

---

## 5. 重绑定规则（证明义务 1 的正文）

### 5.1 重绑定只可能发生在一种情形

宿主能让「新 toolCall」与「已有操作」对上号，唯一的充分证据是：**运行时自己宣布「我丢掉了上一次尝试，正在重试」**。Pi 1.5.2 把它作为公开事件给出：

| 事件 | 形状 | 位置 |
| --- | --- | --- |
| `compaction_end` | `{reason:'manual'|'threshold'|'overflow', result, aborted, willRetry, errorMessage?}` | `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts:74-80` |
| `auto_retry_start` | `{attempt, maxAttempts, delayMs, errorMessage}` | 同上 `:81-86` |
| `message_end`（assistant，`stopReason='error'|'aborted'`） | 失败尝试的边界 | `pi-driver.ts:471-484`（驱动已在订阅，只写日志） |
| `tool_execution_start/end` | 带 `toolCallId/args`，**本设计不用它做身份** | `pi-agent-core/dist/types.d.ts:483-497` |

产品驱动**已经**订阅了这些事件（`pi-driver.ts:459-485`），当前只用来记 `retryScheduled/runFailure/recovered`。本设计只增加一条转发：`TurnDriverInput` 上新增可选回调 `onRuntimeRecovery?(fact)`，在既有 `subscribe` 里触发，透传到 `createSession`/`createTaskExecutor` 的 `exec` 闭包。这不是新子系统，是已有事件的出口。

### 5.2 重放窗口（`attempt` 号）

- `attempt` 是**每次交办**（run_task 作用域：每个 turn）的单调整数，初值 1；只在两类**互斥**事件上 +1（两类都已在订阅里）：
  - 正常 assistant 响应结束（`message_end` 且 `stopReason ∉ {error, aborted}`）——新响应边界的起点；
  - 恢复/重试事件（`compaction_end.willRetry` / `auto_retry_start` / `message_end` 且 `stopReason ∈ {error, aborted}`）——加一，并把**加一前的值**记为本交办的重放窗口 `W`。
- 顺序：assistant 响应 N 正常结束 → 计数 `A`；该响应的工具调用认领 op 时记 `attempt = A`；下一请求溢出触发恢复事件 → 计数 `A+1`、窗口 `W = A`（进程内变量；需要审计时写回该 op 行的 `replay_of`，但窗口判定只依赖本次进程内的事件序）。
- 因此「窗口」= 被丢弃的那条 assistant 响应的工具调用所认领的 op；重试中的新调用认领的是 `A+1`，不会把自己也算成候选。
- 语义与 Pi 的行为对齐：`_omitRecoveryAttempt` 只隐藏**最后一条** assistant 消息及其 toolResults（`pi-152-stage-b.md:99-104`），所以窗口粒度 = 一条 assistant 响应，判据是 `operations.attempt = W`，不比较内容。

### 5.3 规则表

| # | 输入事实 | 规则 | 读取的持久化字段 / 运行时事实 |
| --- | --- | --- | --- |
| **R0 铸造** | 没有打开的窗口 | 新 op：分配新 `op_seq`，`INSERT` 一行 `claimed`，再调用。两笔合法相似操作、两笔 args 完全相同的操作都走这里 → **两个不同 key、各执行一次** | `operations(scope_key, op_seq)` 最大值；`tasks.task_id`（交办内作用域）或 `turn:<sessionId>:<turnNo>`（run_task 作用域） |
| **R1 证明是重放** | 窗口打开，且窗口内**恰有 1 条** op 的 `operation` 与新调用相同 | 绑定该行：`completed/needs_input/failed/refused` → 原样回放 `outcome_json`，**不发起第二次调用**；`claimed/unknown` → R4 | `operations(dispatch_key, operation, status, outcome_json, attempt)`；`operations.delivered_at` |
| **R2 窗口内同名单笔但未定论** | 同上但 `status ∈ {claimed, unknown}` | R4（待核对），绝不重放未知结果 | `operations.status` |
| **R3 窗口内同名 ≥2 笔** | 无法证明是哪一笔（重试可能调换了顺序） | R4（待核对）；整笔交办按结果未知收尾 | `operations(attempt, operation)` 计数 |
| **R4 待核对** | 任何无法证明的情形 | 停止副作用；op 行留 `unknown`（附 reason）；交办 `running→failed + reason='result_unknown'`（复用 `markResultUnknown`，`task-registry.ts:358-363`、`:601-605`；合法边 `:234`；原因枚举 `:56-63`）；工具结果返回固定「待核对」事实 | `tasks.status/reason/failureReason`（`task-store.ts:356-370` 单语句写状态） |
| **R5 跨进程/会话恢复** | 新进程、或 Pi 会话 resume（`sessionDir/resumeSessionFile`，`pi-driver.ts:181-185`；当前产品装配未接线） | **不自动重绑**：旧交办租约过期即 `result_unknown`（`task-runner.ts:342-344`、`task-registry.ts:621-629`），用户重发 = 新交办（既有「重复同一句话是新授权」口径）。若将来接上 resume，判据改为：该交办存在 `delivered_at IS NULL` 的 op 且 `operation` 同名 → 绑定并 R4；≥2 条 → R4；0 条 → R0 | `operations(delivered_at, operation)`；`tasks.status/reason` |

### 5.4 三条硬禁令（对应 owner 纠偏）

1. **禁止重试时另铸身份**：`op_seq` 的唯一分配点是 R0；R1/R2/R5 的路径只调 `bind`，不调 `mint`（§9 守卫）。
2. **禁止按参数绑定**：`claim` 签名不含 args（§4.4）；源码级守卫禁止在 `dispatchKey` 构造路径出现 `args`/`JSON.stringify`/哈希函数。
3. **禁止为了消除歧义新增治理**：歧义**只**由 R4 处理（拒绝 + 待核对），不引入 Planner / Router / 意图分类器 / 计划门 / 第二套 Registry。R4 用的状态与原因都是既有冻结枚举，没有新状态（`task-registry.ts:42-63`）。

### 5.5 Main 层 `run_task` 的同款应用

`run_task` 不是「只读一次」，它本身就是一笔有副作用（新建任务行、可能后台上跑、占资源预算、发通知）的业务操作，所以同样的身份规则必须覆盖它：

- 作用域 = `turn:<sessionId>:<turnNo>`（一个 `send()` 一个 turn；会话串行，`apps/server/server.ts:6`）。
- `claim` 仍在执行前：`run_task` 的 op 行先落库 `claimed`，再走 `delegate()`（`execution-runtime.ts:518-608`）。受理时仍生成 `taskId`（`:521`）并交给 `registry.begin`/`submit`（`:559`/`:540`），但它只是**这次交办的对外引用**；本笔操作的权威身份是 claim 到的 `dispatchKey`，settle 时把 `taskId` 回填到同一 op 行。
- 重放：Main 回合内溢出恢复后模型重新发 `run_task`（措辞可能不同）→ R1 按窗口内**恰一条** `run_task` 绑定 → 返回已有受理回执（`taskId/taskNo/name/status`，源自 `tasks` 行），**不新建第二个任务**。窗口内 ≥2 条 `run_task` → R3→R4，不猜哪条是重放。
- 这覆盖了 background 模式最贵的一种重复：同一句话被重投成两个后台任务、跑两遍同样工作（对照 `packages/agent/src/task-runner.ts:551-567`：现有唯一约束只护「同 taskId」，而重试恒带新 taskId，形同未护）。
- 与「重复同一句话是新授权」不冲突：那条口径管的是**跨回合**的用户重发（新 turn、新意图、R5），本条管的是**同一回合内**运行时丢弃重试（同一 `attempt` 窗口）。

---

## 6. 七项证明义务逐条回答

**（1）恢复/重试后新 toolCall（新 `toolCallId`、可能措辞不同），宿主凭什么认成同一个逻辑操作？**
不凭 toolCall、不凭措辞。凭三件事同时成立：① 宿主知道自己在哪次交办里（`exec` 闭包按 `taskId` 绑定：inline `execution-runtime.ts:483-488`、background `:781-803`；交办行 = `tasks.task_id`，落库点 `:559`/`:540`）；② 运行时宣布「上一次尝试被丢弃并要重试」（`compaction_end.willRetry` / `auto_retry_start` / assistant `message_end('error')`，`pi-driver.ts:459-484`）；③ 执行记录里该交办在丢弃窗口内**恰有一条**同名 op（`operations(attempt, operation)`）。三条齐 → 绑定到那一条已持久化行，返回其 `outcome_json`。措辞不同不影响，因为没有任何一处读措辞。

**（2）两条合法相似业务操作必须拿不同 key、不被合并。**
R0：每次认领都分配新的 `op_seq`，key 由 `(scope_key, op_seq)` 派生。相同 args 不参与任何比较；`operations` 上没有内容唯一约束。两条 → 两行 → 两个 key → 各执行一次。

**（3）同一笔操作被模型拆成两次调用会怎样？**
两条独立 op、两个 key、各执行一次 → **可能重复一次业务写入**。这是**明确接受的失败形态**，不是静默：宿主无法在「模型拆单」与「两笔合法同参数操作」之间用任何非内容规则区分，而内容规则被禁止、猜绑定被禁止。兜底在执行层：幂等键/状态查询/回读（§7）。文档层面必须这样登记，不能写成「不会重复」。

**（4）重试后调换顺序。**
绑定按 `operation` 名在窗口内匹配，**不按位置**，所以两个不同名 op 调换顺序后仍各自正确绑定（R1 逐笔判定，彼此独立）。两个**同名** op 调换顺序 → 无法证明谁是谁 → R3→R4（待核对），不赌顺序。非重试场景下顺序本就无关（各自 R0）。

**（5）key 的来源规则。**
首次创建逻辑操作时由可信宿主铸造并持久化：`scope_key` = `task:<delegationId>`（交办内操作）或 `turn:<sessionId>:<turnNo>`（run_task），其中 `delegationId` 是首次创建交办时的 UUID（`execution-runtime.ts:521`）；`opSeq` 是首次创建该 op 时的原子计数器值。`dispatchKey` 是 `(scope_key, opSeq)` 的纯函数，此后只读不写。重试/重试规划/每次 toolCall 都**不**产生新的 `op_seq`。证明义务因此落在「新调用怎么找回那条已持久化行」（R1/R2/R5），而不是「key 随机不随机」；R1 的判据是 `operations` 行的名字 + 窗口号，R2/R3 找不到唯一行就停止。

**（6）无法判定时。**
R4：停止副作用（不调 `client.execute`）→ op 行 `unknown` → 交办 `failed + reason=result_unknown`（既有 `markResultUnknown`）→ 工具结果返回固定待核对事实（含 `dispatchKey`、不含业务结论）→ 不自动重试、不宣称成功、不宣称失败。用户侧通知走既有 `failed` 事实通道（`scripts/ask-runtime.ts:380`、`:410`），文案不含内部术语（`packages/agent/src/notification-render.ts:21-29` 黑名单；`dk_`/UUID 形态已被 UUID 正则覆盖，另需把 `dispatchKey` 加入黑名单）。**不新增任何规划治理**。

**（7）参数完全相同的两条合法操作。**
与（2）同一条规则：两个 op、两个 key、各执行一次、合并禁止。这条与（6）同等重要：**宁可重复（执行层兜底）也不得合并**——合并会静默丢掉一笔用户交办，那是更坏的失败。

---

## 7. 外部写入结果未知 与 Exactly Once 边界

### 7.1 `dispatchKey` 在「结果未知」时的语义

1. `dispatchKey` 随请求在**副作用之前**送到执行层：`ExecutionRequest` 增字段 `dispatchKey: string`（`execution-contract.ts:59-63`），与 `requestId` 并列但语义不同（`requestId` 只追踪本次调用，可重试换号；`dispatchKey` 是操作身份，不换）。
2. 执行层义务（写进契约注释，不是宿主推理）：能用就用它做外部幂等键（或据它派生 SaaS 幂等键）；对「发出后无回执」不得盲目重试，应按该键做状态查询；查不出 → 回 `failed` 且 `error.code='result_unknown'`、`retryable:false`（`execution-contract.ts:77-83` 形状）。
3. 宿主侧：收到 `result_unknown` 或调用超时/中断 → op 行 `unknown` → 交办 `failed + reason=result_unknown` → 停止自动重试、返回待核对。**不重放已 `claimed` 的 key**（R2）。
4. 用户可见事实只有三种：「已执行并拿到结果」/「确认失败」/「结果待核对」。第三种不是前两种的委婉说法（既有判据 `task-registry.ts:25-26`）。

### 7.2 为什么不宣称 Exactly Once

exactly-once 需要三样：业务操作 ID、外部网关幂等键、回读对账。本设计只提供第一样，并且只保证「同一身份不会**自动**执行两次」。剩下两样在执行层与外部 SaaS 手里，契约不能强制；而且 §6(3) 已承认「一笔业务意图可能被模型拆成两个身份」。因此正确表述是：

> **同一 `dispatchKey` 至多一次自动执行 + 结果未知可核对；不承诺业务效果 exactly-once。**

任何把本设计写成「解决了 exactly-once」的说法都越界。

---

## 8. 失败形态登记（可接受 / 不可接受）

| 形态 | 处置 | 可接受？ |
| --- | --- | --- |
| 重试窗口内单笔同名 op，结果已记录 | R1 回放，零新副作用 | 可接受（这就是 U3 修复的正面路径） |
| 重试窗口内 ≥2 笔同名 op，或顺序可能调换 | R4 待核对 | 可接受（不合并、不猜） |
| 重试窗口内单笔同名但结果未知 | R4 待核对 | 可接受 |
| 模型把一笔意图拆成两笔调用 | 两笔都执行（R0），重复副作用由执行层兜底 | **可接受但必须登记**，不得写成「不会重复」 |
| 两笔合法同参数操作 | 两笔都执行、两个 key | 必须如此（合并不允许） |
| 运行时没发重试事件（事件丢失/未接线）却真的重试了 | 窗口未开 → 第二笔按 R0 执行 → 重复 | **不可接受**：接线缺失即 fail-closed（§11 L1） |
| 窗口内同名 op 存在，但模型重试时改了 operation 名 | 找不到同名 → R0 新 op | 可接受但登记：语义上是同一笔时仍可能重复 |
| 宿主重启后用户重发同一件事 | 旧交办 `result_unknown`，新交办照常受理（R5） | 可接受（既有授权口径） |
| 外部写入成功但回执丢失 | 执行层按 key 查状态；查不出 → 待核对 | 可接受 |

---

## 9. 验收口径（后续实现的 TDD 清单）

先红后绿、全样本保留、反向绊线必备。文件名建议 `packages/agent/dispatch-key-identity.test.ts`（确定性，零真实模型）。

| # | 用例 | 红判据（实现前必须失败） |
| --- | --- | --- |
| T1 | 同交办、窗口内单笔同名 op，第二笔调用 | `client.execute` 调用 1 次；`operations` 1 行；回放结果与首次逐字相同 |
| T2 | 无窗口，两笔同 args 调用 | 两行两 key；`client.execute` 2 次；两个 key 不相等 |
| T3 | 窗口内两笔同名 op | 第二笔不调 `client.execute`；交办 `failed/result_unknown`；返回待核对事实 |
| T4 | 窗口内单笔同名但 `claimed` | 同上，且**不**重放未知结果 |
| T5 | 窗口内两笔不同名 op 顺序调换 | 两笔各自绑定正确；零额外调用 |
| T6 | 绑定到已有 key 但 `operation` 不同 | `dispatch_conflict`；零调用；行不变 |
| T7 | `claim` 之后、`settle` 之前抛错（崩溃注入） | 行留 `claimed`；后续同名调用 → 待核对，绝不二次执行 |
| T8 | 外部未知：执行层回 `failed{code:'result_unknown',retryable:false}` | 无自动重试；交办 `failed/result_unknown` |
| T9 | 并发两笔认领同交办 | `op_seq` 严格递增不重号；`client.execute` 各 1 次（`BEGIN IMMEDIATE`） |
| T10 | 契约面 | 每次 `client.execute` 的 `dispatchKey` 非空且等于 `operations` 行里的值 |

**守卫/绊线（源码级，先红）**

- G1：`dispatchKey` 构造路径不出现 `args` / `JSON.stringify` / 哈希（`claim` 签名无 args 参数，扫描 `operations.claim` 调用点）。
- G2：`op_seq` 分配点唯一（`mint` 只有一处）；`bind` 路径里不出现 `randomUUID` / `INSERT INTO operations`。
- G3：`operations` 表无内容唯一约束（扫描 schema：`UNIQUE` 只允许出现在 `(scope_key, op_seq)` 与 `dispatch_key`）。
- G4：扩展现有单写路径守卫（`packages/agent/task-registry-write-path.test.ts:1-24` 的判据口径）：`operations` 的状态写入只能经 registry 方法族落到 `task-store`，别处零直写。
- G5：`notification-render` 黑名单加 `dispatchKey`/`dk_`（`packages/agent/src/notification-render.ts:21-29`），通知文案不得泄露。
- 反向绊线：删掉 R1 绑定 → T1 红；把 R0 改成按 args 合并 → T2 红；重试时重新铸造 → T1 红（两行两调用）。

---

## 10. 变更面与迁移（实现时）

| 面 | 改动 | 依据 |
| --- | --- | --- |
| 契约 | `ExecutionRequest` 增 `dispatchKey: string`；`EXECUTION_CONTRACT_VERSION` 1→2（`execution-contract.ts:30`）；注释写明「requestId 追踪 / dispatchKey 身份」 | owner 已批准范围 |
| 底账 schema | v3→v4（`task-store.ts:61`）：新增 `operations` 表（`scope_key` 见 §3）+ `executions.dispatch_key` 可空列；迁移按既有版本化口径（`:271-303`，备份 `<db>.backup-v4`），旧行 NULL、只读打开读出缺省 | 与 P1/P2a 加列同款 |
| Registry API | `claimOperation` / `settleOperation` / `markOperationDelivered`；`ExecutionRecord` 增可选 `dispatchKey`（`task-registry.ts:111-116`） | 最小增量 |
| 执行运行时 | inline `executeOperation`（`:459-481`）与 background `exec`（`:781-803`）改为 claim→execute→settle；`requestId` 仍在 claim 后生成 | 先落库再调用 |
| 驱动 | `TurnDriverInput` 增 `onRuntimeRecovery?`；在既有 `session.subscribe`（`pi-driver.ts:459-485`）转发 `compaction_end.willRetry` / `auto_retry_start` / assistant `message_end('error')` | 已有事件，不新建订阅体系 |
| 判定 | **不改** `judgeReportedTask`（`:137-156`）：回放不写 `executions` 行（只写 `operations.delivered_at`），保持「一行 = 一次真实执行」，E05/E06 冻结语义零变化 | 最小影响面 |
| 状态机 | **不改**：待核对复用 `markResultUnknown`（`:601-605`）与既有原因枚举 | 不新增状态 |

---

## 11. 证不出来的（BLOCKED / 限制）

| # | 证不出来的东西 | 当前处置 | 触发条件 |
| --- | --- | --- | --- |
| L1 | 「运行时发生了重试但宿主没看到事件」时，无法证明第二笔是重放 | 设计上要求驱动转发必须存在；接线本身要有守卫（T 类静态检查：三处 `createPiTurnDriver` 装配都带上 `onRuntimeRecovery`，口径同 `scripts/ask-context-window.test.ts:58-64`）。**接线缺失 = 该保证不成立，实现不得声称已修复 U3** | 实现阶段发现某条恢复路径不产生上述事件 |
| L2 | 窗口内同名 op ≥2 时，无法证明映射 | R4 待核对（不猜） | 模型一次响应里发两笔同名操作又触发恢复 |
| L3 | 模型重试时改写 operation 名/拆单 | 按新操作执行；重复由执行层兜底 | 语义同一笔但名字变了 |
| L4 | 跨进程恢复后的调用重绑 | 不自动重绑；旧交办 `result_unknown`，用户重发为新交办（Pi 会话 resume 产品面未接线：`pi-driver.ts:181-185`，最小性审计 `docs/product/pi-152-minimality-audit.md` §1.2 已登记） | 将来接线 resume 后需补 R5 的用例 |
| L5 | 外部 SaaS 是否只写一次 | 不承诺；只在契约里写明执行层义务与 `result_unknown` 回法 | 执行层未实现幂等/查询 |
| L6 | 「一笔业务意图」边界 | 不建模（无意图分类器）；以宿主操作边界为准 | 模型拆单/改写 |

**BLOCKED 声明**：在 L1 的驱动接线未完成、且 §9 的 T1/T2/T3/T5/T7 未跑通之前，本设计**不能**被引用为「U3 已修复」。可以引用的是「身份模型与重绑定规则已定义、可验收」。

---

## 12. 与既有纪律的对账

| 纪律 | 本设计怎么守 |
| --- | --- |
| 不新增 Planner/Router/意图分类器/计划门/事件总线/第二套 Task Registry | 只加一张操作账表 + 一个既有事件的可选回调；歧义处理是拒绝，不是裁决 |
| 不为抽象完整性扩张协议 | `ExecutionRequest` 只加一个必填字符串；没有 effects/计划治理/授权字段 |
| 复用优先于抽象 | `delegationId` 复用 `task_id`；`op_seq` 复用 `task_no` 的原子分配口径；待核对复用 `result_unknown` |
| 不重复执行层执法 | 幂等键、状态查询、回读都在执行层；宿主只做身份与「不自动重放」 |
| 测试纪律 | 先红 TDD + 反向绊线 + 全样本保留；禁止删测试凑绿 |
| 用户可见语言 | `dispatchKey` 内部术语，通知文案黑名单扩展；用户只看到「已执行 / 失败 / 结果待核对」 |

---

## 13. 未做的事（本文件边界）

- 未改任何产品代码、契约类型、schema、测试；未跑测试与真实模型（本任务只设计）。
- 未登记 `docs/decision-log.md`（需要 owner 在实现切片时一并登记；本文件可直接作为登记依据）。
- 未评估 Pi 上游是否应自己修 U3（`pi-152-stage-b.md:97-106` 已给上游行号）；本设计是「上游不改也能不被重复执行」的宿主侧最小面。
