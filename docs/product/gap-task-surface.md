# 缺口 1 设计：任务查询/取消/接续/结果找回接通对话面

> 状态：**批准细化，未实施**（owner 裁决 2026-11-14）。本文档只做设计与最小 diff 文本，产品代码零改动。
> 基线行号在 arch/r4-gaps（HEAD=eac6b6b，=arch/integration 起点）核验；与五路审计基线的偏差已就地修正（notifications 头注释「不自动注入对话历史」实际在 `packages/agent/src/notifications.ts:18`）。

## 0. 一句话

Main 的工具面只有 `run_task`（`packages/agent/src/execution-runtime.ts:426-430`），用户在对话里问「我那个任务怎么样了 / 取消它 / 接着办 / 结果再给我一次」时，模型没有任何工具可查可动——查询/取消/接续能力全部只存在于 Runtime（`runner.cancel/resume`、registry 查询、notificationReader）与 CLI（`scripts/tasks.ts`），没接到对话面。本设计把这些既有能力以**服务端身份授权**的只读/受控工具接进 Main 工具面。

## 1. 最小复现（可执行路径 + 所经代码行）

复现 A（查询面缺失）：在仓内 dummy 执行层下跑

```
npm run ask -- "帮我查一下我刚才那个任务办得怎么样了"
```

- 路径：`scripts/ask.ts` → `scripts/ask-runtime.ts`（装配）→ `execution-runtime.ts` `send()`。
- `send()` 里 Main 回合的工具面硬编码为 `tools: [runTaskTool()]`（`execution-runtime.ts:426`），exec 分派对任何其他工具名直接抛 `Main 工具面之外的调用`（`execution-runtime.ts:430`）。
- 结果：模型要么把「查询」也包装成 `run_task` 交办一个新任务（制造无谓任务 + 等待），要么凭空编一句答复。两者都是用户可见的失败（前者=无谓成本，后者=虚假成功，违反 WORKER_SYSTEM_PROMPT 同款纪律）。

复现 B（取消/接续缺失）：先交办一个后台任务（`dispatchMode=background` 时受理即回执，`execution-runtime.ts:362` `已受理 #<taskNo> ... 将在后台执行`），再发「取消它」/「它刚才问你缺不缺参数，补：用上周口径」。同样只到 `run_task`，`runner.cancel`（`packages/agent/src/task-runner.ts:275`）与 `runner.resume`（`task-runner.ts:277`）在生产路径零调用（grep 全仓：仅 `scripts/tasks-redo` 的 redo 走 ask 同源重交办，不经 cancel/resume；测试与脚本引用不算生产）。

复现 C（结果找回缺失）：任务 completed 后，用户在**同一会话**里说「把刚才那个结果再发我一遍」。会话转录里 Main 只留有其受理/最终回复文本；`registry.get` 的逐字存档（`archiveReply`，`execution-runtime.ts:440-446`）与通知底账（`createNotificationReader`，`notifications.ts:483`）都存在，但 Main 没有工具读它们，模型只能复读自己转录里可能已过期的句子。

## 2. 代码证据（文件:行号，本 worktree 核验）

| # | 证据 | 位置 |
|---|------|------|
| 1 | Main 工具面仅 run_task | `packages/agent/src/execution-runtime.ts:426-430` |
| 2 | run_task 工具 schema/description 定义点 | `execution-runtime.ts:48-61`（`RUN_TASK_TOOL_SCHEMA`） |
| 3 | registry 归属校验 `require(taskId, scope)`：principalId+sessionId 双匹配 | `packages/agent/src/task-registry-sqlite.ts:96-100` |
| 4 | get/list 带 scope | `task-registry-sqlite.ts:218-222` |
| 5 | cancel/resume 均收 scope | `packages/agent/src/task-runner.ts:275,277`；resume 实现 `:494-511`（`answerResumes` + `startRound`） |
| 6 | 取消语义=requestCancel→cancelling，确认才 cancelled，未确认回滚 running | `task-runner.ts:32-34,407-418` |
| 7 | 只读通知查询 | `packages/agent/src/notifications.ts:483`（`createNotificationReader`），listNotifications/undelivered |
| 8 | 通知不自动注入对话历史（冻结契约 T05 只读形态） | `notifications.ts:18` |
| 9 | 会话身份从渠道事实构造，非模型输入 | `apps/server/server.ts:203-204`（`principalId=${channel}:${wecomUserId}`），sessionFor `server.ts:134-145` |
| 10 | 会话面已有 `tasks()`/`getTask()`（scope 固定为本会话） | `execution-runtime.ts:460-461` |
| 11 | 生产入口未传 notificationSink | `apps/server/main.ts:37`（`createServer({env,config,dbPath})`）；server.ts:64 注明「测试注入/部署注入」，:124 `sink: deps.notificationSink` 缺省 undefined |
| 12 | CLI tasks 已实现列表/详情（含通知投递状态只读展示） | `scripts/tasks.ts:651-677` |
| 13 | waiting_user 的接续入口 = registry `answerResumes`（经 runner.resume 的 answer） | `task-registry-sqlite.ts:235`、`task-runner.ts:494-511` |

## 3. 新增对话工具清单（schema / 谁可调 / scope 注入）

统一原则：**工具参数只收任务引用（`#编号` 或 taskId），绝不收 principalId/sessionId**。scope 由宿主在 `send()` 闭包里用 `options.principalId/sessionId`（构造期来自装配层渠道事实，`execution-runtime.ts:110-111,209-210`）构造，与现行 delegate 内 `registry.begin` 的绑定同源（`execution-runtime.ts:366`）。

### 3.1 `task_status`（只读）

```ts
const TASK_STATUS_SCHEMA = {
  type: 'object',
  properties: {
    ref: { type: 'string', description: '任务引用：受理回执里的 #编号（如 "3"），留空列本会话全部任务。' },
  },
  additionalProperties: false,
};
```

- 谁可调：Main（`send()` 回合内）。实现：`ref` 为空 → `registry.list(scope)`（照抄 `execution-runtime.ts:460`）；非空 → 先 `registry.list(scope)` 本会话内按 taskNo 解析成 taskId（**解析本身就在 scope 内做，跨会话编号直接「找不到」**），再 `registry.get(taskId, scope)`。返回字段复用 TaskRecordView 的白名单字段（state/taskNo/name/reason/pendingQuestion/requestIds/时间戳），不返回内部路径。
- scope 注入：`send()` 闭包常量 `const scope = { principalId: options.principalId, sessionId: options.sessionId }`（`execution-runtime.ts:447` 已有同样写法）。

### 3.2 `task_result`（只读，找回结果）

```ts
const TASK_RESULT_SCHEMA = { type: 'object', properties: { ref: { type: 'string', description: '任务引用：#编号。' }, required: ['ref'] }, additionalProperties: false };
```

- 实现：scope 内解析 ref → `registry.get(taskId, scope)`，返回其最终回复存档（`archiveReply` 落的逐字回复）与 executions 摘要（operation/status/requestId）。completed 之外的状态如实返回状态本身，不构造结果。

### 3.3 `task_cancel`（受控写）

```ts
const TASK_CANCEL_SCHEMA = { type: 'object', properties: { ref: { type: 'string', description: '要取消的任务 #编号。' }, reason: { type: 'string', description: '用户给出的取消原因，一句话。' } }, required: ['ref'], additionalProperties: false };
```

- 实现：scope 内解析 → `runner.cancel(taskId, scope)`（`task-runner.ts:275`）。**原样转述** CancelOutcome：`{outcome:'requested'}` 说「已发出取消请求，执行端确认后生效」；确认/未确认语义照 registry 状态，不宣称已取消（复用 cancelling≠cancelled 状态机，`task-runner.ts:407-418` 的回滚边保持不动）。
- 前置：需要 `send()` 能拿到 runner——RuntimeOptions 已有 runner 装配链（`scripts/ask-runtime.ts` 构造 runner 后注入 background 执行面；send 闭包内补一个 `options.taskRunner` 引用即可，不新建生命周期）。

### 3.4 `task_resume`（受控写，接续 waiting_user）

```ts
const TASK_RESUME_SCHEMA = { type: 'object', properties: { ref: { type: 'string', description: '等待中的任务 #编号。' }, answer: { type: 'string', description: '对任务待办问题的答复，用用户原话的意思写清。' } }, required: ['ref','answer'], additionalProperties: false };
```

- 实现：scope 内解析 → `runner.resume(taskId, { answer, scope })`（`task-runner.ts:277,494-511`）。非 waiting_user 状态的 resume 由 registry 状态机拒绝，工具层只转述拒绝原因（`task-registry-sqlite.ts:235` answerResumes 的转移校验）。

四个工具都只对 **Main** 开放（Worker 工具面不动：仍只有 `execute_operation`，`execution-runtime.ts:63-77`）。

### 3.5 与 CLI tasks/ops 的能力对照（不重复造）

| 能力 | CLI（现状） | 对话工具（本设计） | 重叠处理 |
|------|-------------|--------------------|----------|
| 列表/详情/通知状态 | `scripts/tasks.ts`（:651-677 registry.list + notificationReader） | `task_status` | 同一 registry 同一 scope 语义，CLI 是运维面（全库只读），对话面是会话 scope；不复制渲染逻辑 |
| 导出交付件 | tasks.ts outPath | 不做 | 交付件导出留在 CLI/后续渠道切片 |
| redo（重新交办） | tasks-redo（ask 同源） | 不做（模型可用 run_task 重新交办） | — |
| 取消/接续 | CLI 无（runner.cancel/resume 无任何入口） | `task_cancel`/`task_resume` | 首个入口即对话面；无重复 |
| 通知补投 | `scripts/ops.ts`（运维） | 不做 | 投递失败是渠道/运维责任，不进对话 |

### 3.6 通知不进对话历史的取舍分析

现状（冻结契约 T05）：通知只落 outbox，`不自动注入对话历史`（`notifications.ts:18`）。缺口 1 要回答：任务事实（completed/failed/waiting_user）要不要交给 Main？

**做法一（推荐，本设计采用）：拉模型——用户问或模型主动查时经 `task_status` 读 registry 底账。**
- 边界：对话历史仍是唯一对话事实源；底账是任务事实源；两者由工具调用显式桥接。Main 不会因后台任务完成被「插入」回合，不破坏回合串行性（server.ts `enqueueSessionTurn` 的会话内串行）。
- 失败面：用户不问就永远不主动告知——这是**已知取舍**，交由渠道切片（sink 投递，main.ts:37 接线点已留）解决「推」，本切片只解决「查」。

**做法二：推模型——回合结束后把本会话新通知作为下一回合的机械前缀注入。**
- 边界：需要在 `send()` 前读 `createNotificationReader` 并拼进 mainMessages，等于建了第二份对话事实的隐式副本；且后台任务完成的时点与会话下一回合的时点无对应，注入哪条、何时注入都要新治理规则——违反「通知事实与投递分离」的冻结设计（notifications.ts 头注释）与 AGENTS.md「不建执行台账注入」。
- 结论：不做。若后续 eval 证明用户「不被主动告知」是高频失败，再以渠道 sink（做法一的补面）实验，不在本缺口内。

## 4. 最小 diff（文本形式，逐行说明；不落代码）

改动集中在 `packages/agent/src/execution-runtime.ts` + 装配点 `scripts/ask-runtime.ts`，全部复用既有机制：

```diff
--- a/packages/agent/src/execution-runtime.ts
@@ 常量区（RUN_TASK_TOOL_SCHEMA 之后）
+export const TASK_STATUS_TOOL = 'task_status';
+export const TASK_RESULT_TOOL = 'task_result';
+export const TASK_CANCEL_TOOL = 'task_cancel';
+export const TASK_RESUME_TOOL = 'task_resume';
+const TASK_STATUS_SCHEMA = { ... }   // §3.1 四个 schema 常量
```
说明：与 RUN_TASK_TOOL 同处定义（:48-61 先例），零新机制，只是声明。

```diff
@@ RuntimeOptions（execution-runtime.ts:108 起）
   mainDriver: TurnDriver;
+  /** 任务治理入口（cancel/resume）：由装配方注入既有 runner；不传则治理工具不上面。 */
+  taskRunner?: TaskRunner;
```
说明：可选注入，缺省不启用——ask 单发路径（无后台 runner）行为零变化。

```diff
@@ send()（execution-runtime.ts:419 起）
-        tools: [runTaskTool()],
+        tools: [runTaskTool(), ...(options.taskRunner === undefined ? [] : [
+          taskStatusTool(), taskResultTool(), taskCancelTool(), taskResumeTool(),
+        ])],
```
说明：工具面扩展点就是这一处数组（:426）；`task_status/task_result` 是只读，不依赖 runner，但为一步到位与治理工具同批上（也可拆成第一批只读、第二批治理，见回归清单分期）。

```diff
@@ send() exec 分派（execution-runtime.ts:429-433）
         exec: async (tool, args) => {
-          if (tool !== RUN_TASK_TOOL) throw new Error(`Main 工具面之外的调用：${tool}`);
+          if (tool === RUN_TASK_TOOL) { /* 现行 delegate 路径不动 */ }
+          else if (tool === TASK_STATUS_TOOL) return taskStatus(args, scope);
+          else if (tool === TASK_RESULT_TOOL) return taskResult(args, scope);
+          else if (tool === TASK_CANCEL_TOOL) return taskCancel(args, scope, options.taskRunner!);
+          else if (tool === TASK_RESUME_TOOL) return taskResume(args, scope, options.taskRunner!);
+          else throw new Error(`Main 工具面之外的调用：${tool}`);
```
说明：保留 fail-closed 兜底分支（未列名工具仍抛错）。`scope` 即 :447 已有的常量，上移到 exec 之前。

```diff
@@ 模块底部（runTaskTool() 旁，:465）
+function resolveRef(ref: string, scope: TaskScope): string {
+  const list = registry.list(scope);                       // 只在本会话 scope 内解析 #编号
+  const hit = list.find((t) => `#${t.taskNo}` === ref.trim() || t.taskId === ref.trim());
+  if (hit === undefined) throw new TaskOwnershipError(...); // 复用 require 的拒绝语义
+  return hit.taskId;
+}
```
说明：**编号解析在 scope 过滤后的列表上做**——越权编号自然表现为「找不到」，不泄露其他 principal 的任务存在性（列表本身已 scope 化，:460 先例）。

```diff
--- a/scripts/ask-runtime.ts
@@ runtime 装配（:288 / :385 两处 createPiTurnDriver 附近，runtime options 组装处）
       mainDriver,
+      ...(runner === undefined ? {} : { taskRunner: runner }),
```
说明：runner 本来就在该作用域构造（ask-runtime.ts:294 起 `createTaskRunner`），只是把引用传进 session options；不新建 runner、不改生命周期。

## 5. 边界安全分析

- **越权**：四个工具的每次库访问都过 `require(taskId, scope)`（task-registry-sqlite.ts:96-100，principalId+sessionId 双匹配）；`resolveRef` 在 scope 化列表内解析，跨 principal/session 的 #编号 = 找不到。模型无法在参数里传任何身份字段（schema `additionalProperties:false` 且无该字段）。
- **重放**：task_cancel 重复调用 → 第二次 `cancel` 命中状态机非 running/queued 分支被拒（requestCancel 的转移校验），幂等拒绝而非重复副作用；task_resume 的 answer 会真的再触发一轮执行——这是**语义上的重放面**，但与 CLI/未来渠道触发 resume 等价，且每次都落 registry 转移与 executions 底账，可审计。不加额外防重放层（那会是重建治理）。
- **资源**：task_status/task_result 是只读 SQLite 查询，量级同 `tasks()`（:460）；无新循环。task_resume 触发的后台回合受既有 workerTurnMs/ResourcePolicy 约束（TaskExecutorOptions.workerTurnMs，execution-runtime.ts:487），不新增限额。
- **失败面**：runner 缺省不注入（ask 单发）→ 治理工具不上面，模型看不到；registry 拒绝（状态不符）→ 工具返回拒绝原文，模型如实转述（与 run_task 的 notice 模式一致，:322/:362 先例）；runner.cancel 返回 requested 而非 cancelled → 转述措辞按 §3.3，不宣称已取消。
- **提示词面**：MAIN_PROTOCOL_NOTE 增加一行「查询/取消/接续用对应工具，不要把查询包装成 run_task」——属于工具协议中性措辞（该文件本就是协议义务清单，:83-90），不是模型行为补丁。

## 6. 回归测试清单（含反向绊线）

一期（只读两工具）：
1. `task_status` 空 ref 返回本会话任务列表（scope 化）——正例。
2. `task_status #n` 返回状态与 pendingQuestion。**绊线**：构造另一 principal/session 的任务，同编号查询必须「找不到」（不抛内部错误、不泄露存在性）。
3. `task_result` completed 任务返回逐字存档；running 任务返回状态而非编造结果——正例 + 反例。
4. 工具参数带 `principalId` 字段 → schema `additionalProperties:false` 拒绝——**身份注入绊线**。
5. 未传 taskRunner 时工具面不含治理工具、Main 调用治理工具名 → `Main 工具面之外的调用`——**面收窄绊线**（保 ask 单发零变化）。

二期（治理两工具）：
6. `task_cancel` 对 running 任务 → outcome=requested、状态 cancelling；执行端确认后 cancelled；未确认回 running（复用 task-runner 既有状态机断言形态，task-runner 测试先例）。
7. `task_resume` 对 waiting_user 任务带 answer → resumed + 新回合；对 completed 任务 → registry 拒绝并原样转述。**绊线**：scope 不符的 resume 必须被 require 拒绝。
8. 反向绊线（总）：删掉 exec 分派的 scope 参数（故意破坏）→ 上述 2/7 必须红。
9. 金样：不启用新工具的现有 ask/server 测试全量不动（`npm test` 既有文件零改，新用例全部新增文件或新增 describe）。

---
样本局限声明：本设计未经黑盒 eval 验证「模型会正确选用这四个工具」；实施后需按 AGENTS.md 跑用户级 eval（含误用查询当交办的反向样本）再定去留。
