# R4 联合接口约定 v1（P2 / P5 / P6 / P4，2026-11-14）

> 授权：owner 2026-11-14「P4/P5/P6 并行加速」。本文件＝三轨启动前的**最小联合接口约定**；**v1 冻结**，任何变更由集成负责人提案并版本化登记，禁止各轨自行修改另一轨契约。
> 原则：接口依赖（上游契约稳定即可启动下游独立开发）≠ 代码依赖（共享文件唯一负责人）≠ 验收依赖（完整端到端须真实依赖合入，不得用假实现冒充）。复用现有类型/模块，不引入额外协议层；共享同一 SQLite 底账与 `packages/agent`。

## 0. 唯一责任方（域边界）

| 域 | 唯一责任方 | 负责 | 不得实现 |
|---|---|---|---|
| 任务状态事实 | **P2 · TaskRegistry** | 状态/合法转换/归属/pendingQuestion/取消语义/超时/未知结果/唯一写路径 | 调度、资源、通知 |
| 资源许可与强制 | **P5 · ResourcePolicy** | 单一配置入口/前后台配额/并发准入/队列容量/超时与中止边界/任务级共享预算/Worker 深度与数量/等待时释放 | 第二套任务队列 |
| 后台排队与执行 | **P6 · TaskRunner** | Main 快速受理/持久化派发/排队启动收尾/Task 与 Worker 隔离/申请释放 P5 许可/重启恢复与未知结果/满载前台可用 | 第二套预算、状态机或通知系统 |
| 通知事实与 outbox | **P4 · Notifications** | 状态对应通知意图/同库最小 outbox/去重有限重试投递状态/基于事实/渠道无关接口/Main 可读查询 | 通用事件总线、独立消息系统、第二套对话历史 |

## 1. Task Registry 契约（P2；冻结项）

- **状态集**：`queued | running | waiting_user | cancelling | cancelled | completed | failed | timed_out`；保留 `unexecuted`（已汇报零执行）。`cancelling` 为过渡态——**取消请求 ≠ 已取消**，仅确认中止（abort 观察或执行层确认）后才落 `cancelled`。
- **合法转换**（其余一律拒绝并留痕）：`queued→running`；`queued→cancelling→cancelled`；`queued→timed_out`（排队等待超时，P2-T04）；`running→{completed | failed | waiting_user | cancelling | timed_out}`；`waiting_user→{running（答复接续）| cancelling | timed_out}`；`waiting_user` 超时 → 关闭活跃等待（保留历史与原因）；`cancelling→cancelled`；`cancelling→running`（中止未获确认时不得宣称取消，回 running 并留痕）。
- **waiting_user 形状**：任务行持久化 `pending_question`（JSON：`missing[]`、`candidates?[]`、`raw?`）与 `waiting_since`；答复 → **同一 Task** 继续（`task_no` 不变、executions 追加、不得新建任务）；**inline 路径维持现冻结语义**（`judgeReportedTask` 不改；`waiting_user` 仅后台任务使用）。
- **失败/终止原因（机械分类）**：`cancelled_by_user | timeout | failed_confirmed | result_unknown | resource_limited`。**`result_unknown` ≠ failed ≠ success**：重启后无法确认结果的运行中任务落 `result_unknown`，**禁止自动重放**（尤其可能有副作用者）。
- **唯一写路径**：所有状态变化经 TaskRegistry 单一方法族（原子持久化 + 事实钩子）；任何模块**禁止**直接 `UPDATE tasks.status`（源码级守卫）。
- **最小方法族**（语义冻结；签名实现自定）：`begin`；`get / list(scope)`；`transition(taskId, to, {reason?})`；`waitForUser(taskId, pendingQuestion)`；`answerResumes(taskId)`；`requestCancel(taskId)`；`confirmCancelled(taskId)`；`timeout(taskId, kind)`；`markResultUnknown(taskId)`；`claimNextQueued({owner, leaseMs})`（queued→running 原子认领，含 lease 字段）；`expireLeases(now)`；`onTaskFact(hook)`。
- **事实钩子（供 P4/P6，非事件总线）**：单回调注入 `onTaskFact(fact)`；`TaskFact = { taskId, taskNo, name, from, to, reason?, at, stateVersion? }`（`stateVersion` 缺省以 `at` 作为稳定版本；集成若提供注册表计数器可显式传入）；无订阅体系、无持久化事件流。
- **归属**：principal+session 绑定；越权与不存在同错（`TaskOwnershipError`）。
- **契约测试（冻结判据）**：合法/非法转换矩阵；取消语义（请求≠取消、确认才 cancelled、中止失败回 running）；waiting_user 持久化与接续；超时关闭保留历史；unknown 不自动重放；越权同错；单写路径守卫（status 直写零命中）。

## 2. ResourcePolicy 接口（P5；冻结项）

- **单一配置入口**：`runtime` 段（P5 定义，P0 注记承接）。最小字段：`mainConcurrency`、`backgroundConcurrency`、`queueCapacity`、`mainTurnMs/workerTurnMs`、`maxDelegationDepth`、`taskBudget{ms, calls, tokens?}`、`waitUserTimeoutMs`。
- **接口**（纯对象/纯函数，无 IO）：
  - `acquire(kind: 'foreground' | 'background', opts?): Permit | Rejection`；`Rejection.reason ∈ {queue_full, quota_exceeded, budget_exhausted, depth_exceeded}`；
  - `release(permit)`；`cancelQueued(taskId)`；`snapshot(): ResourceSnapshot`；`budgetFor(taskId): TaskBudget`（`consume(usage)`、`exhausted`）。
- **子 Worker 共享父任务预算**（父 permit 派生，不复制/不放大）。
- **前台与后台配额独立**；后台满载不得永久阻塞前台（拒绝或短队列，有界）。
- **强制点由集成负责人接线**（不在本波开发）：execution-runtime 委派前 acquire、runner 背景调度、server 串行化。**Runtime 确定性执行，不依赖 Prompt**。
- **初期硬限制**：并发数、队列容量、时长、调用次数；token 仅当 Pi `assistant.usage` 可验证时接入（否则记 `tokens: unavailable`，**不得伪造硬上限**）。
- **测试**：许可/释放/拒绝矩阵、配额独立、队列满拒绝、预算共享与耗尽、深度拒绝、waiting_user 时释放。

## 3. TaskRunner 接口（P6；冻结项）

- **消费**：TaskRegistry（§1 方法族 + `onTaskFact`）+ ResourcePolicy（§2）+ 注入 `TaskExecutor`（每任务一次执行回合；测试用假 executor）。
- **队列 = 底账 `queued` 行 + lease/claim**（不引第二套队列）：`submit`（受理即 queued，Main 不等待）→ dispatcher `claimNextQueued` → running → 终态；**重启恢复**：queued 重新认领；running 无有效 lease → `result_unknown`（**不自动重放**）；completed 不重跑。
- **并发**：仅按 P5 许可执行；后台满载时前台交互不受阻（前台独立配额）。
- **隔离**：后台转录不进 `mainMessages`；Task 不绑永久 Agent；简单任务可单 Worker，不强制多级 Agent；不得绕过 Runtime 限额。
- **取消**：`requestCancel` → registry `cancelling` + 队列出队/abort；确认后 `cancelled`；不得把请求报成已取消。
- **测试**：受理快速返回、排队/启动/收尾、并发上限、满载前台可用、重启恢复（queued 重试、unknown 不重放、completed 不重跑）、取消确认语义、资源释放。

## 4. Notifications 接口（P4；冻结项）

- **通知意图（enum）**：`accepted | started | waiting_user | resumed | completed | failed | cancelled | timed_out | resource_limited`（阶段进展/里程碑由 state fact 生成；低层事件仅入证据）。
- **outbox（同库最小表）**：`notifications(id, task_id, kind, state_version, payload_json, created_at, delivered_at, attempts, last_error)`；唯一 `(task_id, kind, state_version)`；同进程**有界**重试（退避 + attempts 上限）；未送达在 tasks/ops 可见。
- **渠道无关**：`NotificationSink.send(notification): Promise<DeliveryReceipt>`；server 集成时注入 WeCom sink；测试用假发送器。
- **事实性**：payload 仅来自底账事实（不得编造百分比/重试/原因）；业务语言；Request ID 仅追溯，非凭据。
- **通知失败/延迟不得改变任务实际结果**；Main 可读：P4 提供只读查询（`listNotifications(taskId)` / 未送达集合），供 tasks/ops 与后续只读工具使用（**不自动注入对话历史**）。
- **测试**：写点与去重、重试与 attempts、失败可见、终态不静默丢、字段来源、假渠道投递。
- **blocked**：后台真实通知的黑盒验收 **blocked-by-P6**（接入后完成）。

## 5. 错误 / 取消 / 超时 / 归属传递

- 共享 reason 枚举（§1）；P5 拒绝 reason 映射任务 `resource_limited`（Main 话术由展示层定，不在此约定）。
- 取消链：`request → cancelling →（确认）cancelled /（未确认）running`；超时链：`queued / running / waiting_user → timed_out`；unknown：重启后不可确认 → `result_unknown`（状态=failed + reason=result_unknown）。
- 归属错误：`TaskOwnershipError`（不存在/越权同错），任何轨不得自造错误形态。

## 6. 共享文件唯一负责人

- **本波并行期间**：**P2 轨独占** `packages/core/src/task-store.ts`、`packages/agent/src/task-registry.ts`、`task-registry-sqlite.ts`、`packages/agent/src/execution-runtime.ts`、`scripts/tasks.ts`、`scripts/ops.ts`；P4/P5/P6 **只新增独立模块与测试**（`notifications.ts` / `resource-policy.ts` + config 类型 / `task-runner.ts`），**不改**上述热点与 `server.ts` / `ask-runtime.ts`。
- **集成负责人（唯一）**：波次收口后由**专门集成 Run** 承接全部共享文件接线（`server.ts`/`ask-runtime.ts` 及残余热点编辑），顺序 **P2 → P5 → P6 → P4 → P7b**；其他轨不得先写后补、不得相互覆盖后靠补丁修复。
- 允许：各轨独立 worktree/分支/测试/复核；接口测试用假 driver / 假 policy / 假 sender。禁止：并发写同一热点文件。

## 7. 验收依赖与 blocked

- 各轨独立测试通过 ≠ R4 端到端通过；依赖未就绪项标 `blocked`（注明依赖与解除条件），**不计入 passed**。
- 明确 blocked：P4-E01（后台通知黑盒）← P6；P7b 全部依赖场景 ← P4/P5/P6；P6 的 P2 契约接线验收 ← P2 合入；P5 的 execution-runtime 接线 ← 集成。
- **冻结**：53 项验收契约与既有判据不改；真实 Pi 黑盒 Eval 在联合集成后的 Runtime + Dummy 上执行；不筛绿、不重采样至绿。

## 8. 集成顺序（依赖建议，非开发启动序）

**P2（契约先合）→ P5 → P6 → P4（联合通知接线）→ P7b（完整验收）**。各轨合入前须在集成分支最新基线完成兼容性回归。

## 9. v1.1 修订（2026-11-14，仲裁登记）

- **`stateVersion` 留白补齐**（依据 P4 计划阶段注记，非冲突）：§1 `TaskFact` 增加可选 `stateVersion?: string | number`；§4 outbox 唯一键 `(task_id, kind, state_version)` 中 `state_version` = `fact.stateVersion ?? fact.at`（同一事实重复触发稳定去重；集成可用注册表计数器显式提供更精确版本）。
- **`result_unknown` 的通知承载**：§4 九类意图枚举保持冻结；`result_unknown` 以 `failed` 意图承载，并在 `payload.reason=result_unknown` 如实携带（不得映射为 success/failed_confirmed 的可混淆形态）。
- 以上为**澄清性修订**，不改变任何责任方边界、验收判据与冻结语义；后续变更仍须由集成负责人提案并登记。

## 10. v1.2 修订（2026-11-14，仲裁登记）

- **`queued→timed_out` 边补齐**（对齐冻结验收 P2-T04「排队等待超时」；§1 原列举遗漏）：`timeout(taskId,'queued')` 合法，落 `timed_out` + `reason=timeout`；契约测试矩阵按 P2-T04 锁死。
- **`waiting_user→timed_out` 明示**：等待超时关闭活跃等待并落 `timed_out`（保留历史与原因）。
- **`result_unknown` 承载再确认**：状态=`failed` + `reason=result_unknown`（终态；与 `failed_confirmed` 以 reason 区分；不自动重放；P4 侧以 `failed` 意图 + `payload.reason=result_unknown` 承载）。
- 以上为对冻结验收契约的**对齐性修订**（非产品语义变更）；P2a 冻结记录（`docs/product/p2a-task-contract.md`）须逐条登记这些处置；后续变更仍由集成负责人提案并版本化。
