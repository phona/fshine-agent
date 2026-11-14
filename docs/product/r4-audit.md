# R4 第一阶段现状审计（2026-11-14）

> 依据：R4 统一任务书第一阶段（现状审计 + Pi 原生能力验证 + 最小架构与切片计划）。
> 分支/基线：`arch/r4-audit`，基线 = `arch/integration` 启动时 HEAD `af745af4de6649d844eae613edd3d53820de321a`（工作树 `~/projects/fshine-agent-r4-audit`，本阶段创建）。
> 方法：只读审计 + 零模型最小实验；不修改产品代码、eval 锁/cases、历史证据、其他工作树。
> 口径标注：**已实现 / 已测试 / 仅设计 / 受外部能力限制** 四态不混用；未知项列决策问题（见 `r4-slices.md` §五）。
> 本阶段实跑的确定性门：`npm run test -- --project unit` → `Tests 305 passed (305)`，EXIT=0（日志：本工作树 `.runtime/r4audit/unit-tests.log`）。
> 本阶段 Pi 实验（零模型，全部实跑通过）：`sh .runtime/r4audit/pi-capability/run-all.sh` → EXIT=0，输出 `run-all.out` 及 `*.log`（见 §四）。

## 一、现状审计（7 项）

### 1) Main 会话生命周期 / 上下文压缩 / 持久化

**回合链（已实现）**：`execution-runtime.ts:258-282` `send()` → `mainDriver.run`（Main 只有 `run_task` 一个工具，`:294-300`）→ `exec` 回调内 `delegate()`（`:227-256`）→ 一次性 Worker（每次委派新建 `messages`，只含委派文本+能力快照+技能，`:237`）→ `execute_operation`（`:196-218`）→ `client.execute` → `registry.noteExecution`（`:216`）。

**消息存放（已实现）**：仅内存闭包数组 `mainMessages`（`execution-runtime.ts:192`，注释 `:130`「当前只存内存」）；每回合 push 用户消息（`:262`），回合末整体替换为 driver 返回转录（`:278`）；`transcript()` 返回副本（`:287`）。Worker 转录不保留在会话内（每次委派新建单条 user 消息，`:237`）。

**是否落盘（缺失）**：产品面无会话/转录落盘。`ask-runtime.ts:18-19` 明示「不落盘会话（Pi 原生转录由调用方内存持有）」；`ask` 每进程清空 `.runtime/ask`（`ask.ts:78-79`），只写 dummy 执行层审计（`.runtime/ask/state/audit.jsonl`，`ask-runtime.ts:107-110`）与 SQLite 任务底账（`.runtime/state.db`，`ask-runtime.ts:36`、`:125-127`）。server 会话按 `(principal, session)` 双键缓存于进程内 Map（`server.ts:93-119`），无淘汰/TTL（仅 `close()` 清空，`:156`）；重启丢转录，任务归属 scope 仍由 SQLite 成立。`sessionTtlMs` 被解析（`packages/core/src/config.ts:349-352`）但零生产消费者。

**session 标识与复用（已实现）**：server 为 `${channel}:${wecomUserId}` / `${channel}:${conversationId}`（`server.ts:123-125`）；`ask` 缺省 `ask-<YYYY-MM-DD>`（`ask.ts:88`，同日多进程共享 id 字符串但不共享转录)；redo 复用原任务 sessionId（`tasks.ts:443-446`）；评测 runner 为 `eval-r1-<case>-trial-<n>-<runId>`（`runner.ts:375`）。`createSession` 无恢复入口（`mainMessages` 恒从空开始，`execution-runtime.ts:192`）。

**压缩归属（反应式宿主收敛 + Pi 原语）**：实际只在两条反应式路径触发——`pi-driver.ts:593-603` 在单次模型请求前估算 token，超 `window-1024` 才 force compact；`:638-651` 在模型报上下文超限时压缩后重发（写回 `agent.state.messages`，`:643`）。`TurnDriver.compact`（`pi-driver.ts:768-770`）与「回合前压缩」无生产调用点（非测试引用仅 runner 包装器透传，`runner.ts:296`）。Pi 原生会话持久化在依赖树存在但零接线：`pi-coding-agent/dist/core/session-manager.d.ts:4`（`CURRENT_SESSION_VERSION=3`）、`:174`（JSONL append-only trees）、`:317`（缺省 `~/.pi/agent/sessions/<encoded-cwd>/`）；`pi-agent-core/dist/harness/session/jsonl/repo.d.ts:5`、`storage.d.ts:7`、`session.d.ts:36`（`StorageBackedSession`）。全仓 `grep pi-coding-agent|harness/session` 零 import；`~/.pi/agent/sessions` 不存在（实测）。同一否证登记见 `docs/product/p3-human-redo.md:25`。

**关键细节（已测试）**：pi-agent-core 简单 Agent 循环中 `transformContext` 产物只用于当次请求（`agent-loop.js:179-184`），流式消息仍 push 进原 `context.messages`（`:203`/`:233`/`:248`），不写回转录 → 应急压缩视图不持久，长回合可能每请求重压。

### 2) `session.send()` 与 Worker 执行的同步耦合

**调用点（已实现）**：4 处，全部 await——`ask.ts:105`、`server.ts:137`、`tasks.ts:460`（redo）、`runner.ts:419`。`send` 内 await `mainDriver.run`（`execution-runtime.ts:263`），Worker 在 exec 回调内内联 await（`:271`）。

**超时现状（已实现）**：Main 缺省 300s、Worker 180s、worker 截止 = `min(now+180s, mainDeadline-30s)`（`execution-runtime.ts:138-141`、`:232`、`:261`）；driver `setTimeout` abort（`pi-driver.ts:606-612`）；流式空闲 90s / 单次调用总 300s（`pi-driver.ts:26-27`）；dummy 网关单次调用 60s（`dummy-cli-client.ts:86`）。超时返回空文本（`pi-driver.ts:672-686`），`send` 不抛。worker 抛错/空汇报 → `registry.fail` 后上抛（`execution-runtime.ts:246-255`）；server 侧由 adapter 兜底「处理失败,请稍后再试」（`adapter.ts:589-596`）。

**后台任务（缺失）**：不存在——`host.workerDispatchMode` 等键被解析并派生 env（`packages/core/src/config.ts:152-174`、`:404-410`）但零生产消费者；无可阻塞后续消息的队列/后台任务。

**并发缺口（现状风险）**：adapter 对每个入站帧 fire-and-forget 派发（`adapter.ts:231-240`），无会话级串行/锁（`adapter.ts`、`server.ts` 均无 mutex/serialize/queue）；同会话两条消息会并发进入同一 Session（缓存复用同一对象，`server.ts:93-119`），而 `send` 共享可变 `mainMessages`/`currentTurnDeadline`（`execution-runtime.ts:192`、`:261`、`:278`）→ 后完成者覆盖转录、deadline 互相顶掉。

### 3) Task Registry / Executor / 任务归属与状态事实

**状态与判定（已实现）**：`TaskStatus` 四态 `running/completed/failed/unexecuted`（`task-registry.ts:19`）；`judgeReportedTask` 只看已记录执行事实（`:45-64`），内存与 SQLite 共用（`task-registry-sqlite.ts:100-104`）；`needs_input` 并入 `failed`（首个非 completed 即 failed，`:55-63`）。

**归属（已实现）**：`begin` 绑 principal+session（`task-registry.ts:121-135`）；`get` 双键校验，越权与不存在同一 `TaskOwnershipError`（`:82-87`、`:160-166`）；`list(scope)` 过滤（`:167-171`）；SQLite 同语义（`task-registry-sqlite.ts:60-69`、`:120-125`）。server 身份取渠道事实（`server.ts:123-129`），模型不可提供。

**executions 账本（已实现）**：内存 `ExecutionRecord {requestId, operation, status, error?}`（`task-registry.ts:22-27`）；SQLite 表 `executions(request_id PK, task_id FK, operation, status, error_json)`（`packages/core/src/task-store.ts:82-90`）；写点 `noteExecution`（`execution-runtime.ts:210-216`）；`requestId` 宿主生成 `req_<uuid>`（`:208`）。

**数字 ID（缺失）**：无。`taskId = task_<uuid>`（`execution-runtime.ts:230`，`randomUUID`）；SQLite `task_id TEXT PRIMARY KEY`、无 AUTOINCREMENT/无计数表（`task-store.ts:71`），全仓无计数器实现；名称未持久化（仅 `request`/`resultText`）。

**session_id 关联（已实现）**：存字符串列（`task-store.ts:74`）；运行期关联仅 `(principalId, sessionId)` 过滤，无关联列/树形字段。

**status 消费面（已实现）**：tasks CLI/交付件/ops（`tasks.ts:139-149`；`ops.ts:104-118`）；server 回复不消费（`server.ts:138-149` 只记 executions）；judge 不读 `task.status`（`docs/decision-log.md` §17.2；`task-status-boundary.test.ts` 表征）。

**Executor（已实现，仓内 dummy）**：spawn `bin/dummy operation list --json` / `call --file --state-dir`（`dummy-cli-client.ts:124`、`:169`）；env 白名单 `PATH/HOME/TMPDIR`（`worker-env.ts:25-35`）；四态机械映射（`dummy-cli-client.ts:268-326`）。夹具内部另有 plans/proposals 机制（`bin/dummy.cjs:573-661`）但契约面不暴露、适配器不调用。

### 4) `ask` 装配路径与 Dummy 测试能力

**唯一共享装配（已实现）**：`assembleAskRuntime`（`ask-runtime.ts:83-155`）：5 道前置门（LLM key `:89-91` / 单一 profile `:93-96` / gateway `:98-100` / enabled principal `:101-105` / 只读集合非空 `:121-123`）+ 隔离门 `:112-116`；消费方 = `ask.ts` 与 `tasks.ts --redo`（动态 import 同一函数，`tasks.ts:386-394`、`:413-486`）。

**Dummy 适配器（已实现）**：能力快照 = `operation list --json` 一次缓存（`dummy-cli-client.ts:123-144`）；`execute` = `call --file` + `--state-dir`（`:159-175`）；只读集合派生于 `access=read`（`:67-69`）。

**评测 runner 的复用（部分）**：runner 不调用 `assembleAskRuntime`，而是复制同构装配链（`runner.ts:4-7`、`:358-408`：materializeEvalConfig→loadConfig→effectiveDeploymentEnv→safety gate→createDummyCliClient→readOnlyOperationNames→createSqliteTaskRegistry(per-case db)→loadWorkerSkills→loadAgentProfile→createSession(真实 createPiTurnDriver ×2)；唯一插桩 = TurnDriver 记录包装器）。装配代码现存 3 份：`ask-runtime.ts` / `server.ts` / `runner.ts`（`docs/product/real-read-readiness.md` §1.1 同样登记为三处接线点）。

**runner 隔离（已实现）**：每 case×trial 独立 state/db/config（`runner.ts:346-364`）；sessionId 带 runId（`:375`）；冻结锁 fail-closed（`:606-613`）；`--suite` 仅允许 `exploration/` 之下且仅数据面（`suite-contract.ts:1-16`、`:49-60`）；11 类证据落盘（`runner.ts:479-539`）。

**单轮 ask 契约（已实现）**：恰一条位置参数消息 + `--principal/--session/--config`（`ask.ts:37-59`）；输出 = 回复 + 机械证据（`:116-126`）；回复空/无委派/零执行 → exit 1（`:128-131`）；用法或装配门 → exit 2（`:71-75`、`:92-98`）；每进程只 send 一次，无多轮。

### 5) 企微适配器与核心 Runtime 的耦合点

**渠道专属（`packages/channel-wecom`，已实现）**：WSClient/事件名/重连（`adapter.ts:229-241`、`:832-841`）；归一化与 @ 剥离（`:430-448`、`:525`）；流式帧 + 字节上限/截断（`:547-557`、`:600-617`；`text.ts`）；附件下载落盘/aeskey/收据并窗（`:460-497`、`:705-762`）；媒体上传（`:630-660`）；终帧降级 `replyStream→sendMessage`（`:764-811`，历史 errcode 846608）。

**通用耦合点（`apps/server/server.ts`，已实现）**：principal/session 前缀 `${channel}:…` 拼接（`:122-126`，缺省 `channel='wecom'`）；`attachmentOnly` 分支（`:131-134`）；只消费 `message.text`（忽略 `messageReference`/`attachments`；契约字段 `packages/contracts/src/channel.ts:20-36`、`:93-111`）。

**反向耦合（缺口）**：`ReplyHandler(message, progress?, notice?)`（`channel.ts:193-197`）；server handler 只收 message、不产帧，`execution-runtime` 收集的 `turn.progress`（`:123-124`、`:267`）无消费方 → 现状进度帧从不进企微。adapter 有进度预算/首帧豁免（`:539-557`）但宿主没供帧。装配：`main.ts:37-39` `createServer` + `new WecomBotChannel({env, platformRoot: profile.root})`；adapter 具备 `sendToConversation`（`:275+`）但无生产调用方（无后台投递）。

### 6) 运营后台 / Eval / 现有测试的可复用部分

**ops（已实现，v1 静态快照）**：只读静态 HTML（`ops.ts:1-22` 边界；`renderOpsPage`:206-314；`escapeHtml`:85-92；`writeOpsPage`:338-373；缺省 `.runtime/ops/index.html`:41）；展示复用 `tasks.ts` 导出（`:28-36`）；四态 + other 统计（`:104-118`）；静态无刷新（`:199`）。

**stats（已实现，三态）**：Wilson 95% CI + 三态分类（`stats.ts:30`、`:44-70`）；失败直方图（`:72-81`）；只读 run-dir（`:102-120`）。

**305 单测（本阶段实跑）**：`npm run test -- --project unit` → `Tests 305 passed (305)`，33 文件，EXIT=0（日志 `.runtime/r4audit/unit-tests.log`）。与 R4 相关分布：`runtime` 15（允许集合拒/归属/fail-closed 构造）、`task-registry-sqlite` 6 + `task-registry-readonly` 4 + `task-status-boundary` 8、`server` 2（假渠道）、`ask-runtime` 4 + `tasks` 26 + `tasks-redo` 10、`ops` 24、`dummy-client` 8 + `worker-env` 2、`adapter` 47 + `degrade` 4 + `notice` 3 + `text` 12、`compaction-*` 5 + `pi-driver*` 约 39、`stats` 15、`import-boundary` 1、`config` 23、`transition-naming` 2。

**CI / 工作流（已实现）**：`ci.sh` = typecheck + unit；`eval-real.yml:59` / `eval-nightly.yml:47` 挂 `eval:user`（配置就绪 ≠ 已启用，`docs/decision-log.md` §17.4）。

### 7) 与在飞工作的兼容性

- **E01 修复（已合入）**：`af745af` merge `f022b42`，改 `judge.ts`/`selftest.ts` + 三把 `criteria.lock`；登记 `docs/decision-log.md` §二十五（`:940-946`）。R4 任何切片不得再动 eval 锁/cases/judge。
- **真实只读接入准备档（已合入）**：`a0c0ea1` merge `064e20f`，仅 `docs/product/real-read-readiness.md` + decision-log §二十四；硬声明「准备材料 ≠ 已授权接入」`:3`；其三处接线点（`:18`）与本次审计一致。
- **M01 重切**：本 run 开始时在飞（`arch/m01-recut` @ `b14a7b3`，基线 `af745af`，仅改 `scope-reference/cases/M01.ts` + `criteria.lock`）；**本 run 进行期间已合入 `arch/integration`**（`git log --oneline af745af..arch/integration` → `cf4abd6`、`db004ba`、`b14a7b3`；`git log arch/integration..arch/m01-recut` 为空 = 已全并入）。工作树 `~/projects/fshine-agent-r3-m01` 本阶段零触碰。
- **R3 结论与既有计划**：`docs/product/r3-open-decisions.md`（14 项/授权门）；`docs/product/r4-slice-plan.md:8-16`（三项在飞）、`:19-61`（S1–S5）、`:63-72`（顺序/边界）；redo 语义边界与 Pi 会话否证见 README 与 `docs/product/p3-human-redo.md:25`。
- **基线记录**：R4 工作树启动基线 `af745af4de6649d844eae613edd3d53820de321a`；期间 integration 前进到 `cf4abd6`（M01 判据重切合入，含 decision-log §二十六，仅 eval/docs 面）。R4 不 rebase、不改动上述文件；合入顺序归 owner。

## 二、能力/缺口矩阵（R4 §2–§8）

映射口径：任务书原文不在仓库内；§2–§8 按本 run 的统一任务书枚举（前台 Main / Task 生命周期 / 数字任务 ID / 通知 outbox / 资源强制 / ask-first / ops 扩展）逐块对齐；四态 = 已实现 / 部分 / 缺失。

| § | 要求块 | 现状 | 证据要点 |
|---|---|---|---|
| §2 | 前台 Main（快回合：理解/受理/查询/交付；超时/并发/上下文预算） | **部分** | 已实现：单回合委派-交付链（`execution-runtime.ts:258-282`）、Main 单一 `run_task` 工具（`:294-300`）、300s 回合预算（`:138`）、只读协议义务（`:66-71`）。缺失：无受理/进度/结果三段式到渠道（`turn.progress` 无消费者）；无并发控制（同会话并发 `send` 竞态，见 §一.2）；上下文预算仅反应式、无回合前压缩调用点（`pi-driver.ts:768` 无调用方）；重试仅模型瞬时错误（`pi-driver.ts:652-655`）。 |
| §3 | Task 生命周期（受理/排队/执行/等待用户/完成/失败/取消/超时；Task 不绑 Agent；转录隔离） | **部分** | 已实现：`running/completed/failed/unexecuted` 终态 + 归属 + 重启连续性；Task 不绑永久 Agent（Worker 一次性，`execution-runtime.ts:227-256`）；Main/Worker 转录隔离（`:237`）。缺失：受理/排队/等待用户/取消/超时状态；`needs_input` 在任务层并入 `failed`（`:55-63`）；取消接口已随 M4 从契约删除（`execution-contract.ts:19-26`）。 |
| §4 | 数字任务 ID（并发安全、不复用、名称业务语言持久化） | **缺失** | `task_<uuid>`（`execution-runtime.ts:230`）、`req_<uuid>`（`:208`）；SQLite TEXT PK 无计数器（`task-store.ts:71`）；名称未持久化（仅 `request/resultText`，`:74-77`）。 |
| §5 | 通知 outbox（持久化/重试/去重；进入 Main 可读历史；不做通用事件总线） | **缺失** | schema 仅两表 `tasks`/`executions`（`task-store.ts:69-90`）；无通知/outbox/重试/去重；progress 收集不投递（`execution-runtime.ts:123-124`）；adapter 具备 `sendToConversation`（`adapter.ts:275+`）但零调用方；server 回复仅随入站帧（`server.ts:137-150`）。 |
| §6 | 资源强制（单一配置最小字段：并发/超时/队列容量/深度/预算/等待超时；子 Worker 共享父预算） | **部分（接近缺失）** | 已实现：Main/Worker 截止与余量、worker 共享父截止（`execution-runtime.ts:138-141`、`:232`）；dummy 调用 60s；driver abort。缺失/未接线：`host.*` 键解析并派生 env 但零生产消费者（`packages/core/src/config.ts:152-174`、`:404-410`）；`workerTimeoutMs` 不传入 runtime，`turnBudgetMsFor` 零消费者（`packages/contracts/src/config.ts:74-76`）；无并发上限/队列容量/委派深度/预算/等待超时。 |
| §7 | ask-first（交互式/脚本化回放/多用户多会话/故障注入/结构化轨迹与断言，同一 Runtime） | **部分** | 已实现：单轮 `ask`；eval runner 脚本化回放 + 故障注入 + 11 类证据 + judge；组件级同源装配（`runner.ts:358-408`）。缺失：交互式多轮（每进程单条消息）；多用户多会话（仅 server 面有）；ask 自身不产结构化轨迹；装配代码 3 份（`ask-runtime/server/runner`）。 |
| §8 | ops 扩展（数字 ID→执行树/资源/通知投递） | **部分（v1）** | 已实现：只读静态快照（统计/最近任务/失败清单/转义/幂等，`ops.ts:206-373`）；展示复用 tasks 渲染（`:28-36`）。缺失：无执行树/资源/通知投递视图；页面静态无运行态（`:199`）；无按 principal 视图（本地运维全量，`:191`）；executions 无时间戳（schema 冻结）。 |

附带登记（不影响矩阵）：`contracts` barrel 仍有未消费面（`turnBudgetMsFor`、`store/runtime` 类型等，`docs/decision-log.md` §13.6）；`profile.toolName` 已解析但运行时固定 `run_task`（`execution-runtime.ts:31`、`:294-300`）；`express` 依赖零 import；`skills.ts` 的 `READ_SKILL_TOOL` 无工具接线（Main 工具面只有 `run_task`）。

## 三、复用清单

**可直接复用**：① TaskRegistry 内存 + SQLite 引擎与归属/重启语义（`task-registry.ts:94-103`、`task-registry-sqlite.ts:34-130`、`task-store.ts:121-233`）；② `judgeReportedTask` 终态判定（`task-registry.ts:45-64`）；③ worker-env 白名单与测试锁（`worker-env.ts:25-35`）；④ dummy-cli-client（快照/结构化调用/四态映射/超时，`dummy-cli-client.ts:85-326`）+ 仓内 dummy 夹具（故障场景/审计/拒绝行）；⑤ safety-gate 评测隔离门（`safety-gate.ts:88-159`）；⑥ eval runner 隔离与证据体系 + `--suite` 接缝 + judge/selftest（`runner.ts:346-539`、`suite-contract.ts:1-16`）；⑦ ops.ts 渲染/转义/写出（`ops.ts:85-92`、`:206-373`）+ tasks.ts 只读渲染函数组（`tasks.ts:208-304`）；⑧ stats.ts 纯函数（`stats.ts:44-81`）；⑨ ask-runtime 装配（含五门，`ask-runtime.ts:83-155`）；⑩ server 会话缓存与假渠道装置（`server.ts:93-119`；`server.test.ts`）；⑪ pi-driver compaction 原语与模型错误分流（`pi-driver.ts:279-296`、`:484-552`、`:620-659`）；⑫ 305 单测中的拒绝路径/归属/只读哈希/假渠道用例。

**需扩展或改造**：① 会话生命周期（持久化/恢复/并发串行/队列）——现完全缺失；② 装配入口收敛（现 3 份）；③ 数字 ID 需新增最小序列机制（须过 `AGENTS.md` 五问准入，禁止通用框架）；④ 通知 outbox 需新表 + 投递 + 去重（不得做成通用事件总线）；⑤ ops 执行树/资源视图需扩数据面与 `renderOpsPage`；⑥ runner 需支持多会话/多轮交互式回放（现每 case 单会话）；⑦ `host.*` 资源旋钮与 `workerTimeoutMs`/`turnBudgetMsFor`：接线或删除择一，避免「写着不生效」的假配置；⑧ server 会话 Map 需 TTL/上限或明确裁决保留。

**不建议复用/回归**：旧 hub、计划门、proposal/readback/committed-unverified 模块（`import-boundary.test.ts` FORBIDDEN 墓碑）；contracts barrel 未消费面（`docs/decision-log.md` §13.6）；`express`（零 import，可清理）；已删的 cancel/artifacts/confirmation_required 契约面（M4，`execution-contract.ts:19-26` 注明后续切片按新设计恢复）；规则式指代消解器（owner 硬边界）。

## 四、Pi 原生能力验证矩阵与实验记录

依赖树版本：`@earendil-works/pi-agent-core` 0.85.1、`pi-coding-agent` 0.85.1、`pi-ai` 0.85.1（各 `node_modules` 下 `package.json` 实读）。四态标注：【已测试】本阶段零模型实验实跑通过；【已实现】仅源码依据；【仅设计】接口存在但生产零接线；【受外部能力限制】无法证实/未做。

| 能力 | 结论 | 证据 |
|---|---|---|
| 会话转录保存 | 【已测试】两套原生持久化均可用：pi-coding-agent SessionManager（JSONL 追加树）；pi-agent-core harness JsonlSessionRepo | 源码：`session-manager.d.ts:174`、`:4`、`:317`、`:319/326/332`；`harness/session/jsonl/repo.d.ts:5`、`storage.d.ts:7`、`types.d.ts:36`。实验 E1a/E1b（下）。生产接线=【仅设计】：全仓零 import；`~/.pi/agent/sessions` 不存在（实测） |
| 恢复粒度 | 【已测试】会话级（文件 + 条目树 + leaf），非执行点级；持久化点 = `message_end`；中断的 assistant 消息不落盘 | `session-manager.d.ts:295/313`（branch/createBranchedSession）；`agent-session.js:387-403`（message_end → appendMessage）；`agent.d.ts:96-104`（只有 abort/waitForIdle/queues，无 checkpoint/resume）；E1a/E1b 新进程复原 |
| 取消 | 【已测试】`Agent.abort()` 可观察：终态消息 `stopReason='aborted'` + `agent_end` + `errorMessage` + `isStreaming` 归零；空闲 abort 为 no-op。coding-agent 另有 `abort()/abortCompaction()/abortBranchSummary()/abortRetry()/abortBash()`【已实现】 | `agent.js:199/202-204/349-362/403-407`；`agent-session.d.ts:444/519/523/560/593`；pi-ai 供应商把 `signal.aborted` 映射 `stopReason='aborted'`（`pi-ai/dist/api/openai-responses.js:154`）；E2 |
| 事件流 | 【已测试】`AgentEvent` 全生命周期 + `subscribe()`；实测可见文本增量、工具调用起止、回合与 agent 结束 | `types.d.ts:377+`；`agent.d.ts:70`；E3（13 事件，含 `tool_execution_start:echo`）。coding-agent 更丰富事件（`compaction_*`、`session_compact`、`entry_appended`、`auto_retry_*`）【已实现】`agent-session.js:350-351/1477/1548-1580/1753` |
| 压缩触发条件 | 原语/阈值【已测试】：`shouldCompact = tokens > window − reserveTokens`，默认 `{enabled, reserveTokens:16384, keepRecentTokens:20000}`；pi-agent-core Agent 循环**不自动压缩**；完整摘要压缩未跑 | `compaction.d.ts:40/59/74/77`；`compaction.js:144-147`；E5。自动触发在 coding-agent【已实现】：`agent-session.js:271-284`（下一条 assistant 前阈值）、`:1634-1730`（溢出重试/溢出不重试/阈值三案）、调用点 `:805`/`:895` |
| 并发使用限制 | Agent 守卫【已测试】：同 Agent 同时只允许一个运行（并发 `continue()` 抛「Agent is already processing…」）；同 run 内插话走 `steer/followUp` 队列。会话存储【已实现】：进程内二次 `open` 被拒「Session is already open」；`MutationLine` 串行化单会话读改写。跨进程同文件写【受外部能力限制】：源码未见文件锁，未做实验 | `agent.js:227-228/235-236/327-328`；`agent.d.ts:83-94`；E4；`jsonl/repo.js:86-87/238-239`；`mutation-line.d.ts:2`；`session-manager.js`、`jsonl/storage.js` 对 `lock/flock/exclusive` 零命中（grep） |
| 上下文隔离 | 【已测试】不同 Agent 实例状态互不共享；`messages` 赋值做顶层拷贝；宿主 custom 消息默认不进 LLM 上下文（需 `convertToLlm` 显式投影）；`transformContext` 压缩视图不写回转录 | `agent.js:3-5/117`；`agent-loop.js:179-184`；`types.d.ts:290-315`；E4/E6；`pi-driver.ts:91-99`（本仓投影实现） |

**实验记录**（脚本与日志：本工作树 `.runtime/r4audit/pi-capability/`，gitignored；零模型，未使用 `LLM_API_KEY`，未消耗 `step-3.7-flash`，成本 0）：

- 统一入口：`cd <worktree>/.runtime/r4audit/pi-capability && sh run-all.sh` → **EXIT=0**，9 个 event JSON 全部成功（全量输出 `run-all.out`，215 行）。
- **E1a**（pi-coding-agent SessionManager，两个独立 node 进程）：write → `{event:"e1a-write", fileExists:true, lines:4, leafId:"b419cf4d"}`；read（`SessionManager.open`）→ `sameSessionId=true`、`entryTypes=["message","message","custom"]`、消息/自定义标记逐字复原。证据：`e1a-write.log` / `e1a-read.log`。
- **E1b**（pi-agent-core `JsonlSessionRepo` + `NodeExecutionEnv`）：write → 会话 JSONL 落盘并 `repo.list` 可见；read（新进程 `repo.list→repo.open→branch('main').findEntries`）→ `sameId=true`、`entryTypes=["custom","message","message"]`、消息复原、`stats.messageCount=2`。证据：`e1b-write.log` / `e1b-read.log`。如实登记：首版 read 脚本从嵌套会话文件路径反推 `sessionsRoot` 失败（`list` 为空），改为 handoff 显式携带 `sessionsRoot` 后通过——属实验脚手架缺陷，非库缺陷。
- **E2**（abort，假 stream）：`idleAbortError=null`、运行中 `signal=present`、`streamingDuringRun=true`；abort 后 `events=[agent_start,turn_start,message_start,message_update,message_update,message_end:aborted,turn_end,agent_end]`、`lastStopReason="aborted"`、`errorMessage="aborted by r4 experiment"`、`streamingAfter=false`。证据：`e2-abort.log`。
- **E3**（事件，假 stream：先 toolCall 后文本）：事件序列 13 条（含 `tool_execution_start:echo`/`tool_execution_end`、两回合）；终态 messages=[user, assistant(toolUse,1 toolCall), toolResult("echo:r4-tool-marker"), assistant(stop,"r4-final-marker")]。证据：`e3-events.log`。
- **E4**（并发/隔离）：`concurrentError="Agent is already processing. Wait for completion before continuing."`；两 Agent 回复各自正确、`crossContamination=false`、`copyIsolation=true`。证据：`e4-isolation.log`。
- **E5**（压缩阈值）：默认设置如上；128k 窗口阈值=111616：`atThreshold=false / justAbove=true / justBelow=false / disabled=false`；40k 缩放例同边界；`estimateContextTokens` 样例 `{tokens:15, usageTokens:15, trailingTokens:0, lastUsageIndex:1}`。证据：`e5-compaction.log`。
- **E6**（自定义消息投影）：`defaultConvertToLlmRoles=["user"]`（custom 被默认丢弃）；显式 `convertToLlm` 投影后 roles=[user(user), user(custom 投影)]。证据：`e6-custom-message.log`。

## 五、外部限制与未验证项（不在本阶段结论内）

1. 跨进程并发写同一会话文件：两套存储源码均未见文件锁（grep 零命中），未做并发进程实验——**不声称安全**。
2. 完整压缩（`generateSummary`→`compact`，需模型）未跑；「摘要产物质量/失败降解/压缩后上下文重建」未验证。已证的只是阈值判据与触发点存在性。
3. 恢复不是执行点级：中断 run 的进行中 assistant 消息不落盘，只能从最后完成条目重建上下文后重新发起回合；**不得假定任意执行点恢复**。
4. SessionManager 落盘时机细节：存在 assistant 条目之前文件可能未 flush（`session-manager.js:738-762` 的 `hasAssistant` 缓冲）——「user 消息一写入即落盘」不成立。
5. coding-agent `AgentSession` 完整运行时（tool runner/扩展/自动重试/自动压缩实测）未跑；其 abort 家族/自动压缩触发/事件类型均为源码证据。
6. harness Session API 需传入 Context（实验传 `{}`）与 FileSystem（实验用 `NodeExecutionEnv`）才能独立使用；只覆盖「创建→追加→重开读回」路径。
7. 真实企微未连（README「未验证」）、真实平台未触、worker 对 `.env`/config 的文件层可达缺口未闭环（`docs/decision-log.md` §七）、多实例/并发无承诺（§十二）。
