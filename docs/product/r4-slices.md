# R4 最小架构与分片计划（2026-11-14）

> 依据：R4 统一任务书第一阶段；现状与 Pi 能力证据见 `docs/product/r4-audit.md`（本目录）。
> 基线：`arch/r4-audit` @ `af745af4de6649d844eae613edd3d53820de321a`（启动时 `arch/integration` HEAD；期间 integration 前进到 `cf4abd6`，M01 判据重切合入——R4 不改这些文件）。
> 边界：不重建通用 Workflow Engine / Planner / 消息总线 / 第二套 Agent 框架；不开发规则式指代消解器；不假定任意执行点恢复；不触碰 eval 锁/cases、产品代码以外的历史证据、其他工作树。**本文件不实施功能**；实施须 owner 批切片后另起 run。

## 一、最小架构（每块标注复用/新增）

总原则：复用 Pi 原生（会话/压缩/中止/事件，第一阶段已实测 0.85.1）+ 现有最小 Runtime；三块新增的确定性责任（任务生命周期、资源强制、通知 outbox）全部落在同一 SQLite 底账与 `packages/agent` 内，不引入事件总线/Planner/第二 Agent 框架；所有数值/队列/超时由 Runtime 机械执行，模型只见工具与事实。

### 1) 前台 Main（快回合：理解/受理/查询/交付；超时/并发/上下文预算）

【复用】`execution-runtime.ts:168/258-282`（createSession/send）、`pi-driver.ts`（Agent+流式+模型错误分流）、`MAIN_PROTOCOL_NOTE`（`:66-71`）、`server.ts:93-119` 会话缓存。
【复用·Pi 原生已验证】回合预算 = driver deadline+abort（`pi-driver.ts:606-612`）；回合前压缩 = `TurnDriver.compact`（`pi-driver.ts:768-770`，当前零调用点 → 接到 `send` 前）；溢出恢复保留（`:638-651`）。
【新增·最小】① `send` 串行化：每 Session 一条 promise 链，消除审计发现的并发写 `mainMessages`/`currentTurnDeadline` 竞态（`execution-runtime.ts:192/261/278`）；② 回合上下文预算法：token 估算 + compact 阈值（不建记忆/投影，压缩产物仍 Pi 原生摘要 + 保留尾段）；③ 确定性拒绝话术（预算耗尽/队列满）走既有错误面。
【保持】回复 + 机械证据交付语义；progress 帧可选接线（`adapter.ts:539-558` 已有首帧豁免与 4 帧预算，server 现不产帧）。

### 2) Task 生命周期（受理/排队/执行/等待用户/完成/失败/取消/超时；Task 不绑定永久 Agent；Main 与后台转录隔离）

【复用】TaskRegistry 写点/归属（`task-registry.ts:19/45-64/94-103`）、SQLite 引擎（`task-store.ts:69-90`）、`judgeReportedTask`、worker 一次性委派（`execution-runtime.ts:227-256`，天然满足「Task 不绑 Agent」）、`TurnDriverInput.signal`（`driver-contract.ts:33`）。
【新增·最小】状态集扩展 `queued/running/waiting_user/completed/failed/cancelled/timed_out`（保留 `unexecuted`）；转移仅由 Runtime 在同一组写点机械落库；等待用户 = 把 `needs_input` 的结构化 `missing/candidates`（`execution-contract.ts:92-96`）存为该 Task 的 `pendingQuestion`，用户答复开新回合继续同一 Task；取消 = 宿主 abort（signal）+ 队列出队；超时 = 排队等待超时 + 执行超时（复用 driver deadline）；后台转录只进任务底账/证据、绝不进 `mainMessages`（Main 与后台隔离）。
> 与现语义的冲突（`judgeReportedTask` 现把 `needs_input` 判 `failed`，E05/E06 行为依赖）列为决策问题 2；冻结判据不动。

### 3) 数字任务 ID（并发安全、不复用、名称业务语言持久化）

【复用】better-sqlite3 单写者同步事务、`tasks` 表。
【新增·最小】`tasks` 表加 `task_no`（唯一、禁止复用；迁移按 `created_at` 顺序回填，分配用单条原子 SQL：AUTOINCREMENT 或 `UPDATE counters … RETURNING`）+ `name`（业务语言；来源见问题 4）；对外展示 `#<no> <name>`，内部 `taskId`（UUID）继续做跨表外键与审计关联；ask/tasks/ops/通知统一显示数字 ID。

### 4) 通知 outbox（持久化/重试/去重；进入 Main 可读历史；不做通用事件总线）

【复用】同一 SQLite 库、`adapter.sendToConversation` 主动推送（`adapter.ts:275-330`）、server logger 事件面。
【新增·最小】同库 `notifications` 表（`task_id, kind[完成/失败/等待用户/取消/超时], payload, created_at, delivered_at, attempts`）；唯一键 `(task_id, kind, state_version)` 去重；同进程有界重试（退避 + attempts 上限），成功写 `delivered_at`；未送达在 tasks/ops 可见；「进入 Main 可读历史」二选一（注入未送达事实 / 只读工具读取）——见问题 5；不建发布订阅、不建事件溯源。

### 5) 资源强制（单一配置最小字段：Main/后台并发、超时、队列容量、单任务 Worker 并发与委派深度、预算、等待超时；Runtime 确定性执行，子 Worker 共享父预算）

【复用】`mainTurnMs/workerTurnMs`（`execution-runtime.ts:115-116/138-141`）、dummy 网关 60s、会话缓存。
【新增·最小】唯一配置段（建议新 `runtime` 段，`host.*` 处置见问题 6）：`mainConcurrency`、`backgroundConcurrency`、`queueCapacity`、`mainTurnMs/workerTurnMs`、`maxDelegationDepth`、`taskBudget(tokens/ms)`、`waitUserTimeoutMs`；唯一执行点 = 新 `resource-policy` 模块（信号量/队列/共享预算对象）；`execution-runtime` 在委派前检查，worker 截止 = 父预算剩余，depth 超限/容量满/预算尽都走确定性错误码（不依赖模型守规）。

### 6) ask-first（交互式/脚本化回放/多用户多会话/故障注入/结构化轨迹与断言，与生产同一 Runtime）

【复用】`assembleAskRuntime`（`ask-runtime.ts:83-155`）抽为共享装配；runner 的证据 schema/记录包装器/`--suite` 接缝（`runner.ts:358-539`、`suite-contract.ts:1-16`）；假渠道装置（`server.test.ts`）；dummy 夹具故障场景；safety-gate。
【新增·最小】`ask --interactive`（单进程一个 Session 循环 send，复用现有多轮语义，逐回合输出保持回复 + 机械证据）；`ask --script <file>`（逐行回放、可指定 principal/session 多会话）；`--trace <dir>`（复用 runner 的 11 类证据文件 schema）；「同一 Runtime」由共享装配 + import 守卫测试钉住；故障注入直接复用夹具与 suite（不新增注入框架）。

### 7) ops 扩展（数字 ID→执行树/资源/通知投递）

【复用】`ops.renderOpsPage/writeOpsPage/escapeHtml`（`ops.ts:85-92/206-373`）、tasks 渲染函数（`tasks.ts:208-304`）、只读打开。
【新增·最小】页面新增：数字 ID/名称列、任务执行树（task → executions[→ parent/children 若引入子任务]）、资源快照（runtime 限额 + 每任务实际用量：时长/调用数/token——token 口径见问题 10）、通知投递清单（`delivered_at/attempts`）；仍是静态只读快照，不做在线后台。

## 二、需修改文件清单（file:line）与「为何不能更小」

原则：能在既有文件里最小改就不新增模块；新增三个小模块（`resource-policy` / `task-runner` / `notifications`）是任务书点名的三块确定性责任，无法塞回 Pi（模型不可信）或执行层（宿主归属/交付责任）。

**底账与配置**
- `packages/core/src/task-store.ts:69-90` 建表/迁移（`task_no`、`name`、`reply_text`、`parent_task_id`、新状态列、`notifications` 表、计数器/唯一约束）；`:112-119` readOnly 兼容；`:121-233` 打开与查询（新增 claim/lease、通知读回）。**不能更小**：数字 ID/名称/回复存档/outbox 都必须持久化且跨重启成立，没有不碰 schema 的实现路径。
- `packages/core/src/config.ts:152-174`、`:387-414` 资源策略单一配置（新 `runtime` 段；`host.*` 未消费键处置）。**不能更小**：限额必须有唯一解析点，否则双配置源违反「不写两套」。
- `packages/contracts/src/config.ts:52-76` 配置类型与 `turnBudgetMsFor`（收敛到单一口径，或随 `host.*` 处置删除）。
- `packages/core/src/index.ts` 导出迁移/新查询类型。

**运行时（packages/agent）**
- `task-registry.ts:19` 状态枚举；`:45-64` `judgeReportedTask` 语义扩展（等待用户处理）；`:67-79` `TaskRecord` 新字段；`:94-103` 接口（claim/notify）。
- `task-registry-sqlite.ts:34-130` 同语义映射；`:97-119` complete/fail → 新状态。
- `execution-runtime.ts:91-117` RuntimeOptions（policy/runner seam）；`:192/258-282` send（串行化 + 回合前 compact + 回复存档 + 数字 ID 返回）；`:227-256` delegate（等待用户/取消/预算/深度）；`:119-125` TurnResult 新字段。**不能更小**：回复存档、串行化、预算检查都发生在回合/委派点，只有一个地方。
- `pi-driver.ts:768-770` compact 接线（宿主侧回合前压缩，复用既有实现）；`:606-612` deadline/abort 复用为预算/取消。
- 新增 `packages/agent/src/resource-policy.ts`（限额解析 + 信号量/队列/共享预算；唯一强制点）。
- 新增 `packages/agent/src/task-runner.ts`（queued→running 调度；每次委派新建 Worker 回合；重启恢复；不发事件总线）。
- 新增 `packages/agent/src/notifications.ts`（outbox 写入/去重/有界重试；无订阅面）。
- `worker-env.ts` 不变（凭据隔离复用）。

**宿主/渠道**
- `apps/server/server.ts:93-119` 会话缓存（并发/上限策略）；`:121-151` handler（通知推送、等待用户答复路由、可选 progress 接线）；`:153-159` close。
- `packages/channel-wecom/src/adapter.ts:275-330` 复用 `sendToConversation` 做主动推送（如无需求则零改动）；`:547-558` 进度预算保持。
- `apps/server/main.ts:37-39` 装配新模块（policy/runner/notifier）。

**入口/CLI**
- `scripts/ask-runtime.ts:83-155` 装配 seam（注入 drivers/client/runtimeDir/dbPath/policy）——五门话术字节金样保持；共享装配是「ask-first 同一 Runtime」可验证的前提，也是消除三份装配（ask-runtime/server/runner）的最小改动。
- `scripts/ask.ts:37-59` 参数（`--interactive/--script/--trace`）；`:83-90` 装配调用；`:101-131` 输出（数字 ID/名称/等待用户/通知）。
- `scripts/tasks.ts:139-149` 状态词；`:186-200` 列表（数字 ID/名称）；`:208-304` 详情/交付件（S1 回复 + 无存档标注）；`:413-486` redo/等待用户/取消路径。
- `scripts/eval/convergence-r1/runner.ts:358-408` 改用共享装配（可选、最低优先；runner.ts 不在 `criteria.lock` 清单内）。
- `scripts/ops.ts:104-118` 统计；`:206-314` 页面（ID/名称/执行树/资源/通知）。
- 新增测试文件按 TDD（红→绿→反向绊线），随各片列出；`apps/server/server.test.ts` 模式复用。

**明令不碰**：`scripts/eval/convergence-r1` 的 criteria/judge/cases/locks 与 `exploration` cases/locks（含 M01 重切后的新锁）、历史证据（`.runtime` 存档）、其他工作树（尤其 `r3-m01`）。

## 三、分片计划 P0–P8

顺序 P0→P8（串行，避免多片同时改同一文件；每片独立 TDD + 独立复核 + 可回退；验收区分确定性测试与真实模型黑盒）。基线提醒：启动时 integration = `af745af`；期间 M01 已合入（`cf4abd6`）。P0 前如 owner 要求 rebase 到 `cf4abd6`，只涉及 docs/decision-log 与 scope-reference（R4 不触）。

### P0 · 装配同源（重构，零行为变化）
- 范围：`assembleAskRuntime` 增加注入 seam；server/runner 复用它（或抽出共享 core assembly）；资源策略读入口收敛到单点。
- 依赖：无。
- 验收：确定性——ask 输出/五门拒绝话术字节金样（`ask-runtime.test.ts` 现有）、runner 默认路径与 `criteria.lock` 逐字不变、305 单测全过、tsc 0；真实模型：非必需（可选 E06/E12 回归）。
- 回退：整片 revert（无 schema/行为变化）。
- 预估文件：`scripts/ask-runtime.ts`、`apps/server/server.ts`、`scripts/eval/convergence-r1/runner.ts`（可选）、tests。

### P1 · 底账演化：数字 ID + 业务名称 + S1 Main 最终回复存档（一次版本化迁移）
- 范围：`tasks` 表加 `task_no/name/reply_text`（`created_at` 回填；旧行 reply 为 NULL → 「无最终回复存档」）；宿主原子分配数字 ID；`send` 后把该回合最终回复逐字写入本回合各任务行（同值）；ask/tasks/--out/ops 显示 `#<no> <name>`；`--out` 交付件含 Main 回复全文。
- 依赖：P0（可弱依赖）。
- 验收：确定性——迁移幂等/旧库可读/并发插入编号唯一不复用；显示与导出金样；只读哈希不变。真实模型——ask 一轮显示数字 ID；详情/交付件含逐字回复。
- 回退：迁移为加列/加表（向前兼容），revert 代码后旧列保留无害；历史行不伪造。
- 预估文件：`task-store.ts`、`task-registry(-sqlite).ts`、`execution-runtime.ts`、`ask.ts`、`tasks.ts`、`ops.ts`。

### P2 · 任务生命周期状态机（queued/waiting_user/cancelled/timed_out）
- 范围：状态与转移；等待用户（`needs_input → waiting_user` + `pendingQuestion`；答复续同一 Task）；取消（排队出队 + signal abort）；超时（等待超时/执行超时）；tasks/ops 中文词与原因行。
- 依赖：P1（编号显示）可选；P0。
- 验收：确定性——状态转移矩阵（含失败注入：取消/超时/needs_input 零执行）、越权不变、词表金样。真实模型——E05/E06 行为回归（冻结判据/用例零改动，仅跑）。
- 回退：revert 代码；未知状态在展示层 fail-open（ops 现有口径）。
- 预估文件：`task-registry.ts`、`task-registry-sqlite.ts`、`task-store.ts`、`execution-runtime.ts`、`tasks.ts`、`ops.ts`、`server.ts`。

### P3 · S2 任务访问隔离（读路径按可信身份）
- 范围：tasks 列表/详情按 principal 过滤（身份来源见问题 9）；`--all` 显式运维视图并明示边界；detail 按 id 访问同样校验归属。
- 依赖：P1（编号）。
- 验收：确定性——双 principal 夹具互不可见、`--all` 行为、单 principal 既有行为不变。真实模型——E06/E12 回归。
- 回退：flag 默认关闭可恢复旧全量视图。
- 预估文件：`tasks.ts`、`task-store.ts`（scope 查询已有）、`ops.ts`（运维视图标注）。

### P4 · 通知 outbox（持久化/重试/去重；渠道推送；Main 可读）
- 范围：`notifications` 表与写点（完成/失败/等待用户/取消/超时）；同进程投递器（有界重试/退避/dedup）；server 经 `sendToConversation` 推送；tasks/ops 展示；「进入 Main 可读历史」按问题 5 裁定实现。
- 依赖：P2（状态产生通知）。
- 验收：确定性——去重唯一键、重试/attempts 上限、失败可见、假渠道推送用例。真实模型——后台任务完成后渠道收到通知（小 N）。
- 回退：投递开关默认关（仅落库展示），revert 代码。
- 预估文件：新增 `notifications.ts`、`task-store.ts`、`server.ts`、`tasks.ts`、`ops.ts`。

### P5 · 资源强制（单一配置）
- 范围：`runtime` 配置段；信号量/队列容量/委派深度/共享预算/等待超时/回合超时接线；`send` 串行化（把审计竞态在新配置下钉死）；`host.*` 处置定案。
- 依赖：P2（队列/等待语义）、P1。
- 验收：确定性——限额执行测试（容量满拒绝、depth 拒绝、预算耗尽、两个同会话消息串行且转录不互相覆盖）、配置优先级。真实模型——顺序行为与现 ask 一致。
- 回退：配置缺省 = 当前行为（单并发/无限额/无队列），可先接线后开启。
- 预估文件：`contracts/config.ts`、`core/config.ts`、新增 `resource-policy.ts`、`execution-runtime.ts`、`server.ts`、`ask-runtime.ts`。

### P6 · 后台任务执行（Task 不绑 Agent、转录隔离、进程内调度与恢复）
- 范围：task-runner：受理→queued→running（每次委派新建 Worker 回合）→终态；进程重启恢复 queued（claim/lease，幂等 by taskId）；子任务 `parent_task_id`（如引入深度 >1，见问题 11）。
- 依赖：P1+P2+P5。
- 验收：确定性——假 driver 调度测试（queued→running→completed/failed/超时/取消）、重启恢复、并发上限、`mainMessages` 零污染。真实模型——一个后台任务端到端（交办→完成→通知）。
- 回退：dispatch 模式配置回落 inline（现状），revert runner。
- 预估文件：新增 `task-runner.ts`、`execution-runtime.ts`、`task-store.ts`、`server.ts`、`ask-runtime.ts`。

### P7 · ask-first 扩展（交互式/回放/多会话/轨迹）
- 范围：`ask --interactive/--script/--trace`；共享装配 + 记录包装器；import 守卫（ask/eval/server 同一 Runtime）。
- 依赖：P0、P5。
- 验收：确定性——脚本回放金样（假模型逐字）、trace schema 校验、守卫测试、互斥参数拒绝。真实模型——交互式 3 回合会话留证。
- 回退：CLI-only，revert。
- 预估文件：`ask.ts`（可拆 `ask-interactive.ts`）、`ask-runtime.ts`、复用 runner 证据 schema。

### P8 · ops 扩展（数字 ID→执行树/资源/通知投递）
- 范围：页面 ID/名称、任务→executions 树（含 parent/children）、资源快照与用量、通知投递清单；保持静态/只读/转义/幂等。
- 依赖：P1–P6（数据齐）。
- 验收：确定性——渲染金样、恶意文本全字段转义、只读哈希、幂等覆盖。真实模型——用真实 dev 库生成快照核对。
- 回退：revert 渲染器。
- 预估文件：`ops.ts`、`tasks.ts`（共享渲染函数）。

**横切要求（每片）**：TDD 先红后绿 + 反向绊线；验收标准含确定性门（typecheck+unit）与真实模型黑盒（用户级）；实施与独立复核分离；不 push/不合并（归 owner）；不触碰 eval 锁/cases 与历史证据。

## 四、S1–S5 重映射

以统一任务书要求的 7 块为准，原 `r4-slice-plan.md` 的 S1–S5 重映射如下：

- **S1（Main 最终回复持久化/找回交付内容）→ 并入 P1**：同一 schema 版本化迁移（`reply_text` 列；历史任务标「无最终回复存档」，不用执行层汇报冒充；详情与 `--out` 逐字一致；迁移幂等/旧库可读/只读路径不变；三场景端到端 + E06/E12 回归）。验收标准原样取自 `r4-slice-plan.md:19-28`。
- **S2（任务归属与访问隔离）→ 并入 P3**：列表/详情按可信 principal 过滤 + `--all` 显式运维视图；归属来源 = 渠道事实（假渠道测试）；单 principal 既有行为与 E06/E12 不变。差异登记：CLI 无渠道事实（身份来源需裁定，问题 9）；「用户看自己的任务」在渠道内的呈现属新增交互，暂不扩范围。
- **S3（redo 语义正名）→ 并入 P0 的文档提交（或独立 docs 提交）**：README/decision-log 口径统一为「重新交办 ≠ 人工接管/续跑」；P3 报告首部加一行名称说明（不改历史证据）；CLI 帮助一致。零产品代码、零分片成本。
- **S4（统计四态）→ 转 eval 维护，不占产品分片**：`scripts/eval/exploration/stats.ts:30/44-70` 三态 → 四态（IMPROVED/REGRESSED/INSUFFICIENT_EVIDENCE/NO_SUBSTANTIAL_CHANGE_VERIFIED），「经验证无实质变化」需预注册等效界；历史报告不改写；单测覆盖边界。注意：`stats.ts` 不在 `criteria.lock` 清单内，但任何 eval 面改动仍须遵守冻结纪律、不碰锁/cases。
- **S5（严格盲测）→ 转流程/eval 维护，不占产品分片**：holdout 由复核员在实施者不可读路径生成/运行/报告；下次使用前确认（`r4-slice-plan.md:56-61`）；无产品代码。
- 交叉说明：统一任务书的「Task 生命周期/资源强制/通知 outbox/数字 ID/后台执行/ask-first/ops」为新增主面；原 S1/S2 作为其上的读路径与持久化要求并入 P1/P3，不另立平行计划。`r4-slice-plan.md` 顶部已加指针（「已被 R4 统一任务书重映射，见 r4-slices.md」）。

## 五、需 owner 决策的问题（逐条选项与建议）

1. **Pi 恢复粒度**：已实测 Pi 原生会话持久化可用，但恢复 = 会话级（文件 + 条目树 + leaf），无执行点级恢复。选项：a) 接受会话级重建（重启后从最后完成条目重建上下文、重新发起回合）；b) 实现检查点/任意点恢复（需自建状态机，与「不假定任意执行点恢复」冲突且无 Pi 原生支持）；c) 不做上下文恢复，只做任务状态与通知。**建议 a**（c 为下限兜底），并登记「执行点级恢复 = 不做」。
2. **waiting_user 语义**：现 `judgeReportedTask` 把 `needs_input` 判 `failed`（`task-registry.ts:55-63`），E05/E06 行为与冻结评测面依赖。选项：a) 引入 `waiting_user`，`needs_input → waiting_user`（改顶层语义，需回归评估）；b) 维持 `failed`，等待用户只作为 Main 交互行为、不进任务状态；c) 仅后台任务用 `waiting_user`，inline 保持现状。**建议 c → a 渐进**（先不动 inline 既有行为）。
3. **取消的边界**：`ExecutionClient` 契约已删 cancel（`execution-contract.ts:19-26`，M4）。选项：a) 宿主只取消排队/Worker 回合（abort signal），执行层调用仍到其自超时（写切片前不可逆操作不受保护）；b) 契约新增 `cancel(requestId)`（新协议面，需执行层配合）；c) 本轮不提供取消，只提供超时。**建议：读路径本轮 a；写/确认切片立项时按 b 一起设计**。
4. **数字 ID 与业务名称来源**：选项：a) 模型在 `run_task` 里提供 `name`（工具 schema 变更 = 模型可见协议面变更，需批）；b) 宿主机械生成（首 N 字，零模型）；c) 模型提供、缺省回落机械。并发安全统一用 SQLite 原子分配/AUTOINCREMENT。**建议 c**，但 a 的协议面变更单独裁定。
5. **通知如何「进入 Main 可读历史」**：`AGENTS.md` 禁「执行台账注入/语义层」，任务书要求可读。选项：a) 回合前注入未送达通知（确定性事实，逐条去重）；b) 新增只读工具（如 `list_task_events`）由模型按需读取；c) 只在 tasks/ops 展示，Main 不自动读（用户问时用现有能力回答）。**建议 b（或 c 起步）**；a 需 owner 明确豁免注入边界。
6. **`host.*` 旧配置键处置**：现解析但零消费（`packages/core/src/config.ts:152-174`、`:404-410`）。选项：a) 重命名为 `runtime` 段并接线；b) 删除未消费键、新建最小 `runtime` 段（避免两套配置源）；c) 保留原名接线。**建议 b**（符合删除纪律）；一次定，不留「写着不生效」。
7. **多进程/多实例**：当前无承诺（`docs/decision-log.md` §十二）。若后台/通知需多实例，需要 lease/claim 或单写服务，超出最小面。选项：a) 明确单实例 + 登记；b) 投资多实例（不在本轮授权）。**建议 a**。
8. **后台完成通知与渠道 10 分钟流式窗口**（adapter 846608 降级路径）：推送走 `sendToConversation`（已具备）+ 频率/去重/打扰上限。选项：a) 每任务一条终态通知；b) 合并窗口批量；c) 仅失败/等待用户推送。**建议 a**，配问题 5 的 Main 历史读取。
9. **S2 的 CLI 身份来源**：CLI 无渠道事实。选项：a) 配置 enabled principal（现 ask 缺省行为）作为 CLI 身份；b) 显式 `--principal`（无校验则可能被滥用）；c) 渠道内任务视图（新交互，需另行设计）。**建议 a + `--all` 运维视图**，并注明本地运维边界。
10. **预算口径与 token 采集**：worker token 现未采集。选项：a) 预算 = 时长 + 调用数（立即可得）；b) 加 token 采集（Pi `assistant.usage` 可用，runner 已有聚合；需接线）；c) 预算归执行层。**建议 a 先行、b 作为增强**；c 与「执行层已拥有治理」一致但与宿主强制冲突，不宜。
11. **委派深度与子任务**：当前 Worker 无委派工具，depth>1 需新机制（准入五问）。选项：a) 本轮 depth=1，只留护栏拒绝（不做子 Worker）；b) 实现 depth 2 子委派。**建议 a**；b 另立项目。
12. **多任务回合的回复存储形状**：一个回合可能委派多个任务，回复是一条文本。选项：a) 每个任务行存同一回复（简单、无新表）；b) 新建 `turns` 表关联回复与任务集。**建议 a**（最小 schema），若后续需要逐任务区分再演进。
13. **迁移与历史库**：`.runtime/state.db` 为本机库，迁移向前兼容；是否需要对 owner 自己的历史库做一次性备份/校验由 owner 定（**建议迁移前自动备份副本并登记口径**）。

未决前不提速实施；以上问题随本文件交 owner 裁定。

## 六、外部限制与未验证项

1. 跨进程并发写同一会话文件：两套 Pi 存储源码均未见文件锁，未做并发进程实验——不声称安全；若计划多进程/多实例访问同一会话根，须先补实验或设计单写者约束。
2. 完整压缩（`generateSummary` → `compact`，需模型）未跑；摘要质量/失败降解/压缩后上下文重建未验证。
3. 恢复非执行点级（Pi 原生边界，见问题 1）。
4. `SessionManager` 落盘时机细节：存在 assistant 条目之前文件可能未 flush（`session-manager.js:738-762`）。
5. coding-agent `AgentSession` 完整运行时未实跑（其能力为源码证据）。
6. 真实企微未连、真实平台未触、worker 对 `.env`/config 文件可达缺口未闭环（`docs/decision-log.md` §七）；多实例/并发无承诺（§十二）。
7. 本计划全部为**设计**，不含实现；实施须 owner 逐片批准后另起 run，并按 `AGENTS.md` 新增机制准入与 TDD 纪律执行。
