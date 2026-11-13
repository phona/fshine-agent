# P3 切片报告：人工接管 v1（`npm run tasks -- <id> --redo`）

> 范围（一句话）：任务失败/未执行后，用户从任务列表**一键重新推进**——`npm run tasks -- <id> --redo` 以该任务**存储的委派原文逐字**、经与 `npm run ask` **同源的生产装配**重新交办为一个**新任务**，打印「原任务 <oldId> → 新任务 <newId>（状态：…）」；原任务记录零改动。
> 分支/提交：`arch/p3-redo`（基线 `arch/integration` @ `ffafcd8dd06f693f85860177d2900fb4c91a58db`）；实现提交 `fbb113b1a605aca05f3aae8ea0364da6f2c7760b`（未 push、未合并）。
> 运行面：真实模型 `LLM_MODEL=step-3.7-flash` + 仓内 dummy 执行层（不触网、不碰真实平台）。
> 证据根：`.runtime/product-p3/`（gitignored；各条证据指针相对仓根）。

## 一、目标

- 用户任务：任务终态（已完成/失败/未执行）后，从底账一键重新推进，无需复制交办原文。
- 硬约束：redo 输入只能是**存储原文逐字**（不得拼接原任务的回复/执行台账/摘要）；不改 SQLite schema 与写语义；仅终态任务可 redo、running 拒绝；redo 前后原任务记录零改动；redo 必须走**生产同源装配**（与 ask 相同的 session/执行层/注册表装配函数），不得另起运行时或旁路；R1 冻结集与 exploration 零改动；无新依赖。

## 二、结果

**命令面**：`npm run tasks -- <taskId> --redo`（新增）。参数规则：`--redo` 需与 taskId 同用；`--redo` 与 `--out` 不能同用；重复 `--redo` 拒绝；`--config=<path>` / `AGENT_CONFIG_PATH` 与 ask 同源。

**同源装配（本切片的关键结构改动）**：新抽 `scripts/ask-runtime.ts`（`assembleAskRuntime`，唯一装配实现）——配置物化/加载、生效环境、五处前置门、隔离门、dummy 执行层客户端与只读允许集、SQLite 任务底账、技能/角色文本装载、`createSession`（`createPiTurnDriver` ×2）。`scripts/ask.ts` 改为调用同一函数（只留参数/运行时目录/输出），redo 经同一函数装配（`scripts/tasks.ts:387-388` 动态导入同一函数；`scripts/tasks.ts:413-486` `runRedo`）。ask 行为与输出逐字不变：五处门话术用 `purpose` 参数化（ask 传 `'ask'`，逐字等于抽取前原文，拒绝路径 exit 2 不变；其余错误沿用顶层归类），隔离门 purpose 串逐字保持。

**逐字输入与零历史注入**：redo 的唯一消息源是 `task.request`（存储值），经真实 `createSession().send()` 进入 Main 转录（恰一条 user 消息）；不读 `resultText`/`failureReason`/`executions`，无任何拼接。注意：新任务登记里保存的是 **Main（模型）照常写出的委派文本**（与 ask 路径一致）——「逐字」保证在 redo→会话输入边界，不承诺模型复述与原文相同（那需要绕过 Main，即旁路，被禁止）。

**终态判定**：`completed/failed/unexecuted` 可；`running` 拒绝（exit 2）；未知状态 fail-closed 拒绝；空原文（数据异常）拒绝。直接消费存储值，不读时重算（与 P1/§17.2 同口径）。

**输出与错误码**：成功 stdout = 新任务回复 + 空行 + `原任务 <oldId> → 新任务 <newId>（状态：<已完成|失败|未执行|进行中>）` + `任务底账：…（新任务已写入）`；多新任务一行一个。退出码：0 成功 / 2 用法与前置（参数、未知 id、缺库、running、装配门与隔离门拒绝）/ 1 环境与 IO、装配其它错误、turn 失败、未产生新任务。

**Pi 原生会话持久化（审计义务的结论）**：**否证**——当前生产装配不落盘 Pi 会话、无原生恢复入口（`execution-runtime.ts:131`「当前只存内存」、`:192` 闭包内 `mainMessages`；`pi-driver.ts:570-580` 每次 run 新建 Agent；`server.ts:94` 进程内会话 Map；全仓无 `pi-coding-agent`/`harness/session` 导入；`~/.pi/agent/sessions` 不存在）。真实「续跑」无合规实现，本切片**不设计**、只登记缺口（见 §五）；redo 因此是**重新交办**（新会话、原文逐字），不是旧上下文续跑。

## 三、验证证据

### S1 失败任务一键重新推进（真实模型）

- `LLM_MODEL=step-3.7-flash npm run ask -- "帮我查一下 faulty-one 集合的数据。"` → 失败任务 `task_1b644401-7c25-43dc-aa81-69a5e7a57776`（`dummy.query failed / COLLECTION_FAULT`）。证据：`ask-failed.log`。
- `LLM_MODEL=step-3.7-flash npm run tasks -- task_1b644401-… --redo` → exit 0：
  `原任务 task_1b644401-7c25-43dc-aa81-69a5e7a57776 → 新任务 task_422145dc-3432-4c64-bdcd-a0a949629feb（状态：失败）`。
  证据：`redo-failed.log`；新任务详情 `new-task-details.log`。逐字重推同一故障请求复现同因失败——「逐字」语义的预期。
- `npm run tasks` 列表可见 4 条（原 2 + 新 2）。证据：`tasks-list-after.log`。

### S2 已完成任务重推（真实模型）

- `LLM_MODEL=step-3.7-flash npm run tasks -- task_62725057-… --redo` → exit 0：
  `原任务 task_62725057-e494-4963-a8a3-a58eed5feb19 → 新任务 task_ae960ff5-9425-4a4c-a8ac-bc7261a9f8e8（状态：已完成）`。证据：`redo-completed.log`。

### S3 原任务零改动

- redo 前后原任务详情逐字节 `diff` 为空（failed 与 completed 各一）。证据：`detail-failed-before.log` / `detail-failed-after.log`、`detail-completed-before.log` / `detail-completed-after.log`、`old-task-unchanged.log`（两条 `IDENTICAL`）。

### S4 ask 拒绝路径对照（抽取未改变行为与输出）

- 旧树（抽取前 `ask.ts`）vs 新树同场景实跑并 diff：缺 LLM_API_KEY / 多 profile / 未知参数三例，stdout+stderr 逐字节一致（diff 仅头部路径行不同），退出码一致（2）。证据：`ask-parity.log`。
- 五处门话术的字节金样由 `scripts/ask-runtime.test.ts` 常驻钉住（含 purpose='重新推进' 的 redo 话术）。

### S5 TDD 与反向绊线

- 先红：`scripts/ask-runtime.test.ts` + `scripts/tasks-redo.test.ts` 初跑 2 文件全红（模块不存在）。证据：`tdd-red.log`。
- 后绿：新行为 14 例全过（终态矩阵、逐字、哨兵禁注入、零改动、输出、错误码、装配注入面、CLI 确定性拒绝路径）。
- 绊线（故意破坏必须红，演示后已还原）：
  1) `send` 前置拼接固定文本 → 逐字用例红：`tripwire-verbatim.log`；
  2) `send` 拼接 `task.resultText` → 哨兵禁注入用例红：`tripwire-sentinel.log`；
  3) 放行 running → running 拒绝用例红（`任务状态无法识别（running）…` vs 期望文案）：`tripwire-running.log`。

## 四、验收标准逐条（勾选 + 证据指针）

- [x] 列表可见：终态任务在 `npm run tasks` 中可见（中文状态词 + id）—— S1 / `tasks-list.log`。
- [x] 一键重新推进：`npm run tasks -- <id> --redo` exit 0，stdout 含逐字配对行 —— S1 / S2。
- [x] 新任务入账可查：列表与详情可见新任务（同 principal/session scope，终态判定与详情同 P1）—— `tasks-list-after.log` / `new-task-details.log`。
- [x] 原文逐字：单测钉住 redo→`session.send` 的文本与存储值逐字节相等（含空白），Main 转录恰一条 user 消息 —— `scripts/tasks-redo.test.ts`。
- [x] 无历史注入（红线）：原任务回复/失败原因/执行错误哨兵零出现在驱动器可见输入；反向绊线红 —— S5。
- [x] 原任务零改动：redo 前后详情逐字节一致 —— S3。
- [x] running 拒绝：真实子进程 e2e exit 2 + `任务正在进行中，不能重新推进：…`，库内零新增 —— `scripts/tasks-redo.test.ts`。
- [x] 未知 id / 缺库：exit 2 沿用 P1 话术，不建库、不触发装配（无 key 环境实测报装配门前置） —— 同上。
- [x] 参数错误：`--redo` 无 id / 与 `--out` 同用 / 重复 —— 同上。
- [x] 装配同源：redo 与 ask 同一 `assembleAskRuntime`；单测（fixture 真装配 + 五门字节金样）+ 旧新拒绝路径逐字节对照 —— S4。
- [x] 既有行为不弱化：全量 unit 32 文件 / 281 例全过（含 P1/P2 金样与只读哈希断言）；`npx tsc --noEmit` exit 0 —— `checks-typecheck.log` / `checks-unit.log`。
- [x] 冻结面零改动：`git diff --name-only` 不含 `packages/**`、`apps/**`、`scripts/eval/**`、`config/**`（schema 与写语义未动） —— 见 §六。
- [x] 真实模型口径：全部真实模型命令带 `LLM_MODEL=step-3.7-flash`，执行层=仓内 dummy。
- [x] 反向绊线 ≥1（实做 3 条） —— S5。

## 五、边界与登记（不实施）

1. **Pi 原生会话持久化/恢复（真「续跑」）**：否证（见 §二末）。真续跑需未来切片让 ask 每回合把 Pi 原生转录交给 Pi 会话设施（`pi-coding-agent` 的 SessionManager 或 `pi-agent-core/harness/session`——依赖树里已有、但生产未接线），并区分「redo（新会话+原文逐字）」与「续跑（原生会话恢复）」两种语义；接线会改 ask 行为与运行时目录清理策略（ask 每次清 `.runtime/ask`），超出本切片允许改动。
2. **僵尸 running**：崩溃遗留的 running 行永久拒绝 redo（无停滞判定，不读时重算——与 P1 同纪律）。
3. **重复交办副作用**：同一终态任务连续 redo 会产生多个新任务（无幂等键；schema 冻结、无关联列）；每次明确打印新 id，无自动重试。两个并发 redo 同理。
4. **关联仅打印**：新旧任务关联只由 CLI 输出表达；重启后列表看不到「谁由谁重推」。
5. **部署面 redo**：隔离门要求 root 在仓内夹具目录之下（与 ask 同门），部署配置 redo 会被拒绝——P3「先 Dummy」的既有边界。
6. **Main 最终回复仍不落库**（沿用 P2 登记）；redo 会把新任务回复打印出来，但不持久化。

## 六、确定性与冻结面

- `npx tsc --noEmit`：exit 0（`checks-typecheck.log`）。
- `npx vitest run --project unit`：32 文件 / 281 例全过，exit 0（`checks-unit.log`；P1/P2 既有断言未弱化，金样与只读哈希用例照旧）。
- 变更面：`scripts/ask-runtime.ts`（新增，155 行）、`scripts/ask.ts`（重构，输出/退出码逐字不变）、`scripts/tasks.ts`（--redo）、`scripts/ask-runtime.test.ts`、`scripts/tasks-redo.test.ts`、`README.md`；本报告与 decision-log §二十。`packages/**`、`apps/**`、`scripts/eval/**`（R1 冻结集与 exploration）、`config/**`、`package.json`（无新依赖/脚本）零改动。
