# R6 多用户 E2E MU · 验收报告（MU-1～MU-10）

> 分支：`arch/r6-multiuser`（worktree `~/projects/fshine-agent-r6-multiuser`），基线 = `arch/integration` 启动时 HEAD `b90f12f`（`git rev-parse HEAD` = `b90f12f05368d45ddd125b32017205b569aecd97`）。
> 范围：**确定性**多用户场景组（**零真实模型、零真实企微、零真实写**）。复用现有 R6 Harness（`scripts/eval/r6/{oracle,compaction}.ts`），产 `scripts/eval/r6/multiuser/**` 与本报告。
> 本 run **不改产品码、不改 Worker 提示、不改 D7 判据、不引 Runtime 治理机制、不引第二套压缩/会话机制、不接真实企微/生产数据/真实写**。

---

## 一、方法：生产同源装配 × 真实交互路径（非 `registry.get` 直调）

- **装配**：每个场景经 `createServer`（`apps/server/server.ts:89`）启一名 server——与 `npm start` **同一装配链**（`resolveSingleProfile` → 底账 `createSqliteTaskRegistry` → 角色文本/技能装载 → 会话按 `(principal, session)` 双键缓存 `server.ts:144-179` → 渠道消息 `handler`）。测试只注入**假件**：假 Pi 回合驱动（`createDrivers`）、假执行面（`createExecutionFace`）、假后台执行器（`taskExecutor`）、假通知 sink（`notificationSink`）。
- **交互路径**：场景经 `server.handler` 入口投递 `IncomingChannelMessage`（`apps/server/server-r4-background.test.ts:50` 同源边界）——身份由渠道事实派生（`principalId = wecom:<userid>`、`sessionId = wecom:<conversationId>`，`server.ts:217-218`），任务经 Main `run_task` → Worker `execute_operation` → 执行契约创建；**不是**直接 `registry.get` 代替交互。
- **≥3 principal / 多 Session / 同进程并发**：principal `wecom:mu-alice` / `wecom:mu-bob` / `wecom:mu-carol`；多会话由不同 `conversationId` 派生；并发经**会合同步栅 `Rendezvous`**（`mu-support.ts`）见证——第 N 个到达者解除全部等待，**串行假并发**只会到 1 个并触发安全超时（`timedOut=true`）。
- **机械 Oracle**：任务/权限以 **Task Registry 为机械 Oracle**——判定读 registry 只读快照并投影为 R6 `TaskView`，交 `../oracle` 的 `judgeTaskContinuity`（H3 重复执行 / H4 虚假完成 / H5 取消虚假回执 / E-G 编号混淆）。压缩经 `../compaction` 的 `judgeCompactionLifecycle`（H6）。

### 硬零（任一命中即 FAIL）

| 码 | 含义 | 机械判据 |
| --- | --- | --- |
| `cross_principal_leak` | 跨 principal 泄漏 | 任务 `principalId` ≠ 其请求原文 owner；或某会话转录出现他人语料标记 |
| `unauthorized_execution` | 越权执行 | 跨用户任务工具调用未被拒（或返回他人内容）；本会话正当访问被拒 |
| `notification_misdelivery` | 通知错投 | 非 owner 会话拿到该任务事实注入；sink 通知不属于 owner 任务 |
| `task_crossover` | 任务串线 | `judgeTaskContinuity` 命中 H3/H4/H5/E-G |
| `fake_concurrency` | 串行假并发 | 会合栅超时 / 到达数不足 / 零真交错 |

### 五要素记录（逐用例）

每条用例落 `records[]`：`principalId / sessionId / taskId / request / deliveredTo`（`deliveredTo` = 实际投递对象：回复/事实/通知到达的 `(principal, session)`）。原始证据落 `.runtime/r6/multiuser/<case>/evidence.json`（gitignored），汇总 `.runtime/r6/multiuser/summary.json`。

---

## 二、逐条结果（PASS / FAIL / BLOCKED + 原始证据）

> 原始证据出处：`.runtime/r6/multiuser/<id>/evidence.json`（下引为实跑产出摘录）。运行命令：`npx vitest run scripts/eval/r6/multiuser/mu.test.ts`。

### MU-1 不同 principal 同时交办 — **PASS**

3 principal 各自会话并发交办；会合栅到达 3/3、`timedOut=false`；真交错 = `true`（`enter` 全在任一 `exit` 之前）。任务数 = 3。
原始证据（`trace`）：`seq0 enter mu-alice → seq1 enter mu-bob → seq2 enter mu-carol → seq3 exit mu-alice → …`；`scopeViolations: []`；`crossoverCodes: []`。
五要素样例：`{principalId:"wecom:mu-alice", sessionId:"wecom:conv-mu-alice", taskId:"task_f37ca459-…", request:"TAG-ALICE 交办：清点本用户账套", deliveredTo:"wecom:conv-mu-alice"}`。

### MU-2 相同 sessionId（跨 principal 同名会话）— **PASS**

alice、bob 用**同一 `conversationId=conv-shared`**（故 `sessionId=wecom:conv-shared` 相同）并发。结果：`aliceTasks=[task_128aab28…]`、`bobTasks=[task_b969d6b8…]` 各 1 且 `taskId` 不同 → **会话未合并**（`server.ts:145-147` 的 `(principal, session)` 双键缓存生效）；`scopeViolations: []`。

### MU-3 同用户多会话 — **PASS**

同 principal（alice）两会话（`conv-jia` / `conv-yi`）各 1 任务、`sessionId` 不同、`taskId` 不同、互不可见；`scopeViolations: []`。

### MU-4 交错并发 — **PASS**

3 principal × 2 轮，逐轮会合栅真交错；任务数 = 6；`transcriptViolations: []`（任一回合主转录不含他人语料标记）；`scopeViolations: []`。

### MU-5 跨用户越权 — **PASS**

**background 模式**（Main 暴露 `task_status/task_result/task_cancel`）。alice 交办得 `#1`（`taskNo=1`）；bob 在**自己的会话**经任务工具访问 `#1`：
原始证据（`bobCalls`）：
```
task_status {ref:"#1"} → error:"任务不存在或不属于当前会话。"
task_result {ref:"#1"} → error:"任务不存在或不属于当前会话。"
task_cancel {ref:"#1"} → error:"任务不存在或不属于当前会话。"
```
`aliceControl`：`task_status {ref:"#1"} → error:null`（本人正当访问成功）。bob 未拿到 alice 任何内容。

### MU-6 重启恢复 — **BLOCKED（依赖 B1）**

依赖 **B1 会话持久化** 未合入：`packages/agent/src/session-persistence.ts` **在基线不存在**（`modulePresentOnBaseline:false`）；上游分支 `arch/sess-persist-impl@91b388a` **未合入基线**（`git merge-base --is-ancestor arch/sess-persist-impl HEAD` → 非祖先）。会话（对话转录）无持久化 → 重启恢复语义不可确定性验证。**不伪报 PASS**。

### MU-7 异步通知错投 — **PASS**

**background 模式** + 假 sink + 假后台执行器。alice 受理后台任务并完成 → 事实缓冲；随后 bob 回合、alice 回合。
原始证据：`bobGotFact:false`（bob 未拿到 alice 的事实注入）、`aliceGotFact:true`（alice 拿到自己的）、`sinkAllAlice:true`（`sinkKinds:["accepted","started","completed"]` 三条通知全属 alice 任务）。事实注入范围由 `attachNotificationOutbox` 的 `taskFactProvider(principalId, sessionId)` 按 `scopeKey` 收口（`scripts/ask-runtime.ts:406-420`）。

### MU-8 企微群聊与私聊隔离 — **BLOCKED（依赖 B2）**

依赖 **B2 企微静默闸** 未合入：`packages/channel-wecom/src/silent-shadow-gate.ts` **基线不存在**；上游分支 `arch/wecom-silent-shadow` **未合入基线**。无出站机械静默闸 → 群聊/私聊隔离（静默投递 = 0 判据）不可在无真实企微前提下确定性验证。**不伪报 PASS**。

### MU-9 并发压缩 — **PASS**

3 会话各 3 轮并发（逐轮会合栅），逐会话会话内压缩。
原始证据：`compactionCount:9`、`perPrincipal:{mu-alice:3,mu-bob:3,mu-carol:3}`、`contaminated:[]`（无一次压缩见到他人标记）；`compactionVerdict.hardZeroHits:[]`（无 H6）、`coverageSufficient:true`、`effectiveCompactions:9`。证据缺口 `CMP4.summary_chunks_unexposed` 如实登记（假会话不暴露摘要分片）。

### MU-10 单用户故障隔离 — **PASS**

alice 的执行注入确定性失败（假执行面按 `--collection` 返回 `failed`）；bob/carol 正常。原始证据：`alice:{status:"failed",reason:"failed_confirmed"}`、`bob:{status:"completed"}`、`carol:{status:"completed"}`；`scopeViolations:[]`、`crossoverCodes:[]`。

### 汇总

| 用例 | 状态 | 硬零命中 |
| --- | --- | --- |
| MU-1 不同 principal 同时交办 | PASS | 无 |
| MU-2 相同 sessionId 跨 principal | PASS | 无 |
| MU-3 同用户多会话 | PASS | 无 |
| MU-4 交错并发 | PASS | 无 |
| MU-5 跨用户越权 | PASS | 无 |
| MU-6 重启恢复 | **BLOCKED**（B1） | — |
| MU-7 异步通知错投 | PASS | 无 |
| MU-8 群聊与私聊隔离 | **BLOCKED**（B2） | — |
| MU-9 并发压缩 | PASS | 无 |
| MU-10 单用户故障隔离 | PASS | 无 |

**8 PASS / 0 FAIL / 2 BLOCKED**；跨 principal 泄漏 / 越权执行 / 通知错投 / 任务串线 / 串行假并发 —— **全部硬零**。

---

## 三、依赖状态

| 用例 | 依赖 | 基线状态 | 证据 |
| --- | --- | --- | --- |
| MU-6 | B1 会话持久化 | **未满足** | 模块 `packages/agent/src/session-persistence.ts` 不存在；`arch/sess-persist-impl@91b388a` 非 `HEAD` 祖先 |
| MU-8 | B2 企微静默闸 | **未满足** | 模块 `packages/channel-wecom/src/silent-shadow-gate.ts` 不存在；`arch/wecom-silent-shadow` 非 `HEAD` 祖先 |

---

## 四、验证读数（本 run 实跑）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `npm run typecheck`（`tsc --noEmit`） | **0 错误** |
| 定向 | `npx vitest run scripts/eval/r6/multiuser/mu.test.ts` | **12 passed** |
| 单一配置源守卫 | `npx vitest run packages/agent/resource-policy-single-source.test.ts` | **2 passed**（未触旋钮双源） |
| 全量 | `npm test` | **93 文件 / 934 passed + 3 todo** |
| 全量基线 | 移出 `scripts/eval/r6/multiuser/` 后 `npm test` | 92 文件 / 922 passed + 3 todo |

→ 例数**只增不减**（+1 文件 / +12 用例；0 删除/弱化）。

---

## 五、未覆盖 / 待真实模型

- **真实模型多用户 E2E 另阶段**：本组全部为**确定性夹具**（假 Pi 驱动/假执行面/假后台/假 sink），**零真实模型**；模型级行为（并发对话质量、真实压缩、跨用户误导生成）待 Pi 迁移 + R6 基础准入后另阶段。
- **真实企微**：未接（`chatType:'group'` 仅在接口面登记；群聊/私聊隔离的净验证依赖 B2，本 run 不做）。
- **MU-6 / MU-8**：依赖 B1 / B2 未合入，确定性用例**未接线**（本 run 不改产品码、不预造第二套会话/静默机制）。
- 压缩分片（`CMP4.summary_chunks_unexposed`）与真实 token 计量未观测（假会话不暴露）——如实登记证据缺口。

---

## 六、边界声明（对齐 owner 与 AGENTS.md）

- **零真实写**：假执行面只返回 `completed`/`failed` 结果，不落任何业务副作用；通知 sink 为假件。
- **不改产品码**：仅新增 `scripts/eval/r6/multiuser/**` 与本报告；装配/执行契约/Worker 提示/D7 判据/状态机**零改动**（`git status` 仅新文件）。
- **复用既有 R6 Harness**：机械任务 Oracle 与压缩判据直接 `import ../oracle` / `../compaction`；假件形状对齐既有 `scripts/eval/r6/fake-session.ts` 与 `apps/server/server-r4-background.test.ts`。
- **`.runtime` 证据不 `git add`**：`scripts/eval/r6/multiuser` 的产物落 `.runtime/r6/multiuser/**`（gitignored）。
- **未改 `docs/decision-log.md`**（集成 Agent 单点写）。
