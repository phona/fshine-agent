# R5 会话持久化设计：让对话转录在重启后不丢，且不引第二套任务事实源

- 基线：worktree `~/projects/fshine-agent-r5-sesspersist`，分支 `arch/r5-sesspersist` @ `b0606db`（基线 = `arch/integration` 启动时 HEAD）。
- 方式：**docs-only、产品代码 0 修改、零真实模型调用**。结论读自本 worktree 实际源码，并只读参照主仓 `node_modules/@earendil-works/pi-agent-core@0.85.1`（Pi 原生会话子系统）与已归档的 `docs/decision-log.md` §（第 895 行「Pi 原生会话审计」）。
- 本文**只设计，不实施**：不新增 Runtime 记忆/历史检索/语义投影，不引新治理或状态机，不另建任务事实源，不为过测放宽判据，不动冻结面，不重写 Worker 提示。**本文不写 `docs/decision-log.md`**（集成 Agent 单点写）。
- 硬约束（owner）：① **独立于压缩方案迁移**——本设计与「复用 Pi Session / 迁移到 harness」互不绑定、不假手压缩；② **不增加第二套任务事实源**——会话持久化只承载对话转录与最小确定性事实；③ **Pi First / Runtime Minimal**——转录用 Pi 原生结构，不自建语义层，宿主只保留不可转交的确定性责任。

---

## ① 现状核实（转录在何处、何时丢；任务台账在何处持久化）

### 1.1 回合转录只在内存，重启即丢

- 转录实体 = `createSession` 闭包变量 `mainMessages`：初值 `[]`（`packages/agent/src/execution-runtime.ts:422`）；每回合结束后被**整体替换**为本回合完整转录（`:647`，`mainMessages = [...mainResult.messages]`）；会话只对外暴露**只读快照** `transcript()`（`:665`，`() => [...mainMessages]`）。
- `Session` 接口自注即「当前只存内存」（`packages/agent/src/execution-runtime.ts:282-283`：「本回合后 Main 转录快照（Pi 原生转录即状态；当前只存内存）」）。
- 驱动侧：`TurnDriverResult.messages` 注释写明「更新后的完整转录（含本回合全部消息），**由调用方持久化**」（`packages/agent/src/driver-contract.ts:38-40`）——但当前调用方（`execution-runtime.ts:647`）只把它赋给内存变量，**全仓无任何落盘写入**（grep 结果：非评测面不存在对 `DriverMessage[]` 的磁盘写）。
- Pi 驱动每个回合**新建 `Agent`**（`packages/agent/src/pi-driver.ts:688`，`const agent = new Agent({`），Agent 自身状态不跨回合、也不跨进程留存。
- server 侧**会话对象本身**也只在进程内存 `Map` 缓存：`const sessions = new Map<string, Promise<Session>>()`（`apps/server/server.ts:145`），`sessionFor(principalId, sessionId)`（`:146-179`）首次构造、此后复用，`close()` 时 `sessions.clear()`（`:274`）。

**何时丢**：进程重启（崩溃或正常 `close()` 后重建）→ `sessions` 为空 → 同一 `(principal, session)` 再次来消息走 `sessionFor` **重新构造全新 Session** → `mainMessages` 回到初值 `[]`（`execution-runtime.ts:422`）→ 此前所有 `user/assistant/toolResult` 消息全部丢失。

### 1.2 任务事实（台账）已持久化在 SQLite，重启后仍在

- server 启动即建 SQLite 任务底账：`createSqliteTaskRegistry(deps.dbPath)`（`apps/server/server.ts:96`，缺省 `.runtime/state.db`，见 `:54`）。
- 表结构三张（`packages/core/src/task-store.ts:156-188`）：`tasks`、`task_sequences`、`executions`；schema 版本 `TASK_STORE_SCHEMA_VERSION = 3`（`:61`）。
- 台账字段含 `status / reason / pending_question / waiting_since / lease_owner / lease_until / task_no / name / reply_text`（`task-store.ts:69-90`）。
- 除了这三张表，全仓另有一张 **通知投递 outbox** 表 `notifications`（`packages/agent/src/notifications.ts:210`），与任务底账**同库**（`dbPath`），但它自注为「**不建第二套对话历史**」（`notifications.ts:20-21`）的**投递事实**表，不是任务真相本身。
- `TaskRegistry` 的持久面与内存面由装配注入区分：`RuntimeOptions.taskRegistry` 注释「B 类持久化：装配方可注入 SQLite 实现使归属跨重启成立；缺省 = 进程内内存实现」（`execution-runtime.ts:221-224`）。

### 1.3 重启恢复语义已存在且完备（仅覆盖任务，不覆盖对话）

- server 启动在 background 模式下第一次 `runner.pump()`（`apps/server/server.ts:132-133`）。
- `pump()` 先 `registry.expireLeases(now)` 把**过期 running 租约**的 `result_unknown`（**不自动重放**），再 `claimNextQueued` 重新认领最老 `queued`（`packages/agent/src/task-runner.ts:342-343`、`:361`）；策略见模块头 `:21-25`。
- 已在册的重启边界缺口：停在 `cancelling` 的孤儿任务 `expireLeases` 只回收 `running`（`task-runner.ts:37`）——本次**不处理**，只登记。

### 1.4 缺口（一句话）

重启后：**任务底账保留**（`tasks` 查询仍能读到历史任务与状态），**会话转录消失**（`mainMessages=[]`）——重启用同一 `(principal, session)` 再发消息，用户失去此前对话上下文，形成「**对话断、任务在**」的半续状态。

### 1.5 已归档的既有审计（先例，不改动）

`docs/decision-log.md:895` 已登记「**Pi 原生会话审计（写入报告）：否证**——生产装配不落盘会话、无原生恢复入口」，并明确**复用条件**：「先接 Pi 原生会话持久化并区分『redo=新会话+原文逐字』与『续跑=原生会话恢复』」。（该行引用的行号为当时基线：`execution-runtime.ts:131/192`、`pi-driver.ts:570-580`、`server.ts:94`；在当前 HEAD 已漂移为本文 §1.1 所列行号，语义一致。）本文即对该缺口的**独立设计**。

### 1.6 需在实施前确认的边界（本设计已识别，实施时须核对）

- **状态基数**：`task-runner.ts:55-64` 的 `TaskStatus` 联合为 **9 个取值**（`queued / running / waiting_user / cancelling / cancelled / completed / failed / timed_out / unexecuted`），`task-store.ts:69` 注释同列 9 个。owner 语境「8 态台账」应是同一集合的**归类说法**（`unexecuted` 为分诊态）；**`result_unknown` 不是状态，是 `TaskReason`**（`task-runner.ts:67` 的 5 个机械原因之一）。本设计以源码为准：**状态 9 个、原因 5 个**，会话持久化**都不触碰**。
- **R5-B 事实注入缓冲也是内存态**：`attachNotificationOutbox` 的 `pendingFacts` 是进程内数组（`scripts/ask-runtime.ts:355-` 起、`:406` 的 `taskFactProvider` 消费），重启后缓冲丢失；但**底账与 outbox 表都在**（§1.2）。本设计**不持久化该缓冲**（见 §2.4）。
- **能力快照**：每会话取一次（`execution-runtime.ts:327-328`），是**单次快照**，不是跨重启需保留的会话确定性事实——重启后由新装配重新取（装配层可信来源），**不属于本文持久面**。

---

## ② 设计

### 2.1 原则

- **存什么 = 对话转录本身**，即 Pi 原生 `AgentMessage[]`（`driver-contract.ts:22-24` 的 `DriverMessage = AgentMessage`）。**不自建消息结构、不做语义投影、不建记忆/检索/规则引擎**（`execution-runtime.ts:27`「上下文与压缩归 Pi 原生……不另建记忆、检索或投影」）。
- **最小确定性事实 = 绑定键**：`(principalId, sessionId)` 与写入时刻。这两个是宿主已持有的可信渠道事实（`server.ts:217-218` 由渠道构造），**不是任务事实**，不构成第二套任务真相。
- **不存任务状态**：任务状态仍以既有 SQLite 底账（§1.2）为**唯一权威**；会话持久化**读都不读** `tasks/executions`，只按**同一 scope 键**与底账并列（不相交写入）。

### 2.2 存哪里

**主选：按会话分文件的追加式 JSONL 快照**（Pi 原生结构、与底账物理隔离）。

- 位置：`.runtime/sessions/`（沿用既有的运行态目录；`.gitignore:17` 已忽略 `.runtime/`，**不得 git add**）。
- 文件名：`<sha256(principalId + "\0" + sessionId)>.jsonl`——**对身份做哈希**，绝不把渠道文本（`sessionId = ${channel}:${conversationId}`，`server.ts:218`）直接拼进路径，避免路径注入。
- 每行一条**全量快照**：`{ v: 1, principalId, sessionId, at: <ISO>, messages: <AgentMessage[]> }`。
  - `messages` 即该回合结束时的 `mainResult.messages`（`execution-runtime.ts:647` 的同值），**逐字节 Pi 原生结构**，不转换、不裁剪、不造 custom message type（与 `execution-runtime.ts:249` 的既有纪律一致）。
  - 追加写（append）：**读端取最后一条可解析行**。这样进程在中途崩溃留下的**半行会被跳过**（crash-safe），且无需重写整文件。
  - 快照为「当前（已压缩）转录」而非累计增量：因为入参 `messages` 本就是 Pi 压缩后的完整转录，单行大小上限 ≈ 当前转录规模，**不随回合数无界膨胀**。
- 版本字段 `v` 供未来出现不兼容时**拒绝加载**（见 §4）。

**备选（不推荐，仅登记）**：在**同一个 `dbPath`** 内新增 `session_transcripts` 表。优点是复用单一 SQLite 引擎与 WAL；**缺点**是与任务底账同库，最容易被误读成「第二套事实源」，需要更强的守卫。若采用，必须满足 §3.1 全部不变量，且**永不与 `tasks/executions` 联表外键**。

**明确不选**：Pi 原生 `harness/session` 子系统（`StorageBackedSession` / `JsonlSessionRepo` / `jsonl` v4 提交日志，见 `node_modules/@earendil-works/pi-agent-core@0.85.1/dist/harness/session/`）。它**存在但当前全仓无导入**（`decision-log.md:895`）；采用它 = 「复用 Pi Session / 迁移到 harness」，**正是 owner 要求本设计**不绑定的**另一条迁移线**。本设计保持转录格式为**朴素 `AgentMessage[]` JSON**，使**将来**若迁移到该子系统只需一层适配，而**现在**不需任何耦合。

### 2.3 与既有 SQLite 底账的关系

| 关注点 | 权威来源（唯一） | 会话持久化是否触碰 |
| --- | --- | --- |
| 任务状态/原因/租约/待办/结果存档 | `tasks`/`task_sequences`/`executions`（`task-store.ts:156-188`） | **否**（不读不写） |
| 通知投递事实 | `notifications`（`notifications.ts:210`） | **否** |
| 对话转录 | **本设计的会话快照存储** | 是（唯一写入方） |

两者仅以 `(principalId, sessionId)` 这一个 **scope 键**并列（与 `registry` 的 scope 同构，`execution-runtime.ts:351`），**内容不相交**：对话恢复不改任务状态，任务状态变化不改对话。

### 2.4 重启恢复语义

- **装配注入（Pi First 最小面）**：给 `RuntimeOptions` 增加可选 `transcriptStore` 端口（与 `taskRegistry` 同款依赖注入，`execution-runtime.ts:221-224`），并在 `createSession` 构造时**按 `(principalId, sessionId)` 载入**，用它**初始化 `mainMessages`**（替代 `:422` 的 `[]`）。
  - 载入失败/无存档 → 回落为空转录（即现行行为，见 §4）。
- **写入点**：`send()` 内 `mainMessages = [...mainResult.messages]`（`:647`）之后、且**不回滚回合语义**的位置，异步/同步写一条快照。写失败**不使回合失败**（§4）。
- **任务恢复不变**：任务侧仍走既有 `runner.pump()`（`server.ts:132-133`）与 `task-runner.ts:21-25` 的 `expireLeases → result_unknown（不重放）/ claimNextQueued`。**会话持久化不触发任何任务重放、不自动接续在飞回合。**
- **与 `unexecuted` / `result_unknown` 等既有状态的关系**：
  - 这些是**任务台账**取值（状态 9 个、原因 5 个，§1.6），**归底账**，会话持久化**不复制、不推断、不合成**。
  - 重启后若某任务曾被判 `result_unknown`，它**只出现在 `tasks` 查询里**；对话转录里可能仍留着用户原话与「已受理」回复——这是**历史对话**（如实留存），不是任务真相。用户可用 `task_status` 取机械事实（工具面既有，`execution-runtime.ts:75-85`）。
  - **禁止**用转录恢复去「还原」任务状态，也**禁止**把底账状态写回转录当事实。
- **与 R5-B 事实注入（`execution-runtime.ts:608-612`）**：注入的 `[任务事实] …` 是普通 user-role 消息，**会作为转录的一部分被持久化**（本来就是真实消息）；而 `pendingFacts` 内存缓冲**不持久化**（它是投递缓冲，不是转录）。重启后缓冲为空、不重注入，用户经 `task_status` 查询——这就是现行 R5-B 的语义，本设计不改。

### 2.5 数据流（一次重启的前后）

```
回合 N： user(text) → mainDriver.run(messages=mainMessages) → mainMessages=messages'
        → 追加快照 {v,principal,session,at,messages'} 到 .runtime/sessions/<hash>.jsonl
重启    → sessions Map 空；taskRegistry 从 state.db 重建；runner.pump() 恢复任务
回合 N+1：sessionFor 新建 Session → createSession 读 <hash>.jsonl 最后一条可解析快照
        → mainMessages 初值 = 存档转录（不再 []）→ send() 正常继续
```

---

## ③ 边界与不变量

### 3.1 不引第二套任务事实源（硬）

- 会话存储**只承载转录**：写路径只落 §2.2 的快照形状，字段只有 `v / principalId / sessionId / at / messages`，**无任何任务状态/原因/租约/编号字段**。
- 会话存储模块**不 import** `task-registry*` / `task-store` / `notifications`，**不发出任何指向 `tasks/executions/notifications` 的 SQL**；由**新增写路径守卫测试**按住（仿 `packages/agent/task-registry-write-path.test.ts` 的源码级守卫思路）。
- 任务真相始终**只有一处**：SQLite 底账（§1.2）。若将来任何改动使会话库能「回答任务问题」，即违反本不变量，须回归。
- **实体/授权不变**：恢复的转录**只能作上下文**，**不得**成为授权、实体来源或执行范围决定（对齐 `AGENTS.md`「记忆内容不能成为平台调用的授权或实体来源」）。scope 仍由宿主从可信渠道事实构造（`execution-runtime.ts:350-351`），模型/转录无法影响。

### 3.2 不与压缩方案迁移耦合（硬）

- 本设计**不依赖**：`pi-driver.ts` 的 `compact` / 压缩路径、Pi `harness/session` 子系统、任何 `StorageBackedSession` / `JsonlSessionRepo` 类型。
- 格式选**朴素 `AgentMessage[]` JSON**（Pi 原生结构），因此**换压缩实现不影响本存储**，**本存储也不迫使压缩换实现**——两条线互相独立。
- 验证测试**不得 import** `harness/session` 或依赖压缩行为；仅用假驱动（§5）。

### 3.3 并发与会话隔离（硬）

- **同进程同会话串行**：server 已按 `(principal, session)` 排 promise 链（`server.ts:185-198` `enqueueSessionTurn`），同一会话的回合不并发 → 同一文件不被同进程并发写。
- **跨会话隔离**：文件名对 `(principal, session)` 哈希；载入严格按**精确键**过滤，不做任何前缀/模糊匹配 → 群聊里不同用户/不同窗口互不可见（与 `server.ts:144` 「不同用户不共享同一个会话对象」一致）。
- **跨进程/多写者**：本设计假定**单 server 进程**（与现装配一致）。若未来多进程，追加写 + 「读最后可解析行」给出**有界的最后写者胜**，且**永不损坏**（半行被跳过）；**不引入锁或第二套协调**。

### 3.4 Pi First / Runtime Minimal

- 转录即 Pi 原生 `AgentMessage[]` 逐字节存档；**不自建消息类型、不投影、不摘要、不索引**（无 `custom` message type，对齐 `execution-runtime.ts:249`）。
- 宿主新增的只是**不可转交的确定性责任**：把 Pi 已经产出的转录落到本机并可按身份读回。**不新增** Planner / Router / 记忆 / 事件总线 / 新状态机。
- 不改工具面、不改 Worker 提示、不改执行契约、不动冻结面。

---

## ④ 失败与回退（都有界）

- **写失败**（磁盘满/权限/IO）：**记日志、不回滚回合**——`send()` 仍返回回复（`execution-runtime.ts:652-656` 的既有返回不变）；**保留上一条快照**（追加写只可能漏掉本次那一行）。**每回合至多写一次**（有界，不重试风暴）。
- **载入失败 / 文件损坏 / 半行**：跳过不可解析行取**最后一条可解析快照**；整文件不可用时**回落空转录**（= 现行行为），**使会话仍能启动**，且**不删除**损坏文件（保留证据）。
- **版本不识别**（`v` 超前）：**拒绝加载**并回落空转录，而不是误解析——有界降级。
- **回合中途崩溃**：只丢**在飞的那一回合**（未落快照）；已完成的历次快照完好。
- **不自动重放**：恢复**只重建对话上下文**；对在飞/未终态任务**不自动接续**（与 `task-runner.ts:21-25` 的 `result_unknown 禁止自动重放`口径一致）。
- **无界风险防护**：单行大小 ≈ 当前转录规模，受 Pi 原生压缩约束；**最小切片刻意不做**文件内压缩/滚动（如需可后续以原子重写另切片，且不得引入语义层）。
- **`.runtime` 纪律**：所有落盘在 `.runtime/` 下，**不得 git add**（`.gitignore:17`）。

---

## ⑤ 回归 / 验证清单（确定性夹具优先；重启恢复失败注入）

> 说明：以下为**拟增**用例，本轮**未运行任何测试**（ask 为只读侦察 + 设计）。实施时须**实跑并给出命令与输出**。

1. **同进程往返（假驱动，零模型）**：`createSession` 注入临时目录 `transcriptStore` + 假驱动（复用 `packages/agent/runtime.test.ts` 的注入手法，`runtime.test.ts:26/163`），跑一回合 → 断言 `.runtime`/临时目录内出现一条 `messages` 为 `AgentMessage[]` 的快照；再以**同 `(principal, session)`** 构造**第二个** Session → 断言 `transcript()`（`execution-runtime.ts:665`）**初值即非空**且等于上一回合存档。
2. **重启恢复（假渠道，零模型）**：复用 `apps/server/server.test.ts:193-207` 的 `createDrivers` / `createExecutionFace` 注入手法与临时 `dbPath` → 建 server、发一条渠道消息、`close()`（`server.ts:274` `sessions.clear()`）→ **用同一 `dbPath` 重建 server**、发第二条消息 → 断言第二次 `mainDriver.run` 收到的 `messages`（`driver-contract.ts:25`）**含第一条回合的历史**。
3. **会话隔离**：同 principal 不同 sessionId（及不同 principal 同 sessionId）→ 断言互不读到对方转录。
4. **不引第二事实源守卫（源码级）**：断言会话存储模块**无**对 `tasks/executions` 的 SQL/依赖、**不 import** task-registry 族（仿 `task-registry-write-path.test.ts`）；断言其快照字段白名单。
5. **失败注入**（对齐 `packages/agent/task-runner.test.ts` 与 `scripts/p7b-fault-injection.test.ts` 既有风格）：
   - 存储 `write` 抛错 → 回合仍正常返回回复、上一快照完好；
   - 存储 `read` 抛错 / 文件含半行 / 含不识别 `v` → 会话以空转录启动、不崩溃、损坏文件未被删。
6. **解耦守卫**：测试**不得** import `harness/session`、**不得**依赖压缩行为；可加静态检查（仿 `packages/agent/import-boundary.test.ts`）。
7. **有界性**：连续 N 回合后单会话文件内容 = N 行快照、每行大小不随 N 增长（受压缩约束）。
8. **既有回归基线**：`npm test`（`vitest run`）与 `npm run typecheck`（`tsc --noEmit`）须保持既有全绿；特别是任务恢复相关用例（`task-runner.test.ts`）**行为零变化**——本设计**不触碰**任务恢复。

失败/回退的判据（机械、可复跑）：上述 5 的每条**注入必红前、断言必绿后**；反向绊线：故意去掉「读最后可解析行」的跳过逻辑 → 半行用例必须转红。

---

## ⑥ 实施代价估计与建议（**不实施**）

### 6.1 代价（粗估，1 名工程师）

- **新增**：`packages/agent/src/session-store.ts`（读/写 + 原子性/半行跳过 + 哈希键）约 120–200 LOC；`RuntimeOptions.transcriptStore` 注入点 + `createSession` 载入/写入（`execution-runtime.ts`，约 20–30 行）。
- **装配接线**：`scripts/ask-runtime.ts` 的 `assembleSessionCore`（`ask-runtime.ts:430-545`）与 `apps/server/server.ts` 的 `sessionFor`（`:146-179`）各加一处构造/注入；缺省不注入 = 现行行为（零变化）。
- **测试**：§5 的 8 类夹具，约 150–300 LOC。
- **改动面**：**零**冻结面改动、**零** Worker 提示改动、**零**任务底账改动、**零**执行契约改动。合计约 **0.5–1 人日**（不含评审与实跑读数）。

### 6.2 建议

1. **采用 §2.2 主选**（`.runtime/sessions/<hash>.jsonl` 追加式 Pi 原生 `AgentMessage[]` 快照），**不**采用同库 SQLite 表（备选），**不**现在采用 Pi `harness/session` 子系统。
2. **注入端口 + 缺省零变化**：`transcriptStore` 可选注入（同 `taskRegistry` 范式），无注入时行为逐字节等于现状——便于先合入、后接线、可回退。
3. **写入点**：回合末尾（`:647` 之后）；**fail-open**（§4）。
4. **先做守卫（§5.4/5.6）再做功能**：不引第二事实源与不绑压缩的**绊线测试先行**，确保回潮即红。
5. **明确不做的**（保持最小、防范围蔓延）：不做语义记忆/历史检索/投影；不做文件内压缩或滚动；不做跨进程锁；不区分「redo vs 续跑」的语义层（那属既有 `decision-log.md:892` 登记的单独缺口，不并入本切片）。
6. **与压缩迁移的接口**：本设计仅承诺「转录是朴素 Pi 消息 JSON」；若未来选择迁移到 Pi 原生会话，由**独立切片**以适配层承接，**不**在本设计内预造接口。

---

## 附：一句话结论

**对话转录当前只在内存（`execution-runtime.ts:422/647/665`、`server.ts:145/274`），重启即丢；任务台账已在同库 SQLite（`task-store.ts:156-188`）且重启恢复完备（`server.ts:132-133`、`task-runner.ts:21-25/342/361`）。本设计新增一层「按 `(principal,session)` 存档 Pi 原生转录」的独立持久面，与任务底账物理隔离、按同一 scope 键并列，重启时只重建对话上下文、不触碰任何任务状态、不自动重放；格式为朴素 `AgentMessage[]` JSON，与压缩/ harness 迁移解耦。只设计，未实施。**
