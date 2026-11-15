# R6 MU-8 复跑 · 企微群聊与私聊隔离（已接线为确定性用例）

- 日期：2026-11-15
- 分支/基线：`arch/r6-mu8` @ `56554fb`（`merge(b2): Silent Shadow 出站机械闸 + opt-in 改造`），基线已含 B2 闸门与 opt-in。
- 零真实模型、零真实企微、零真实写：假渠道事实 + 假执行客户端 + 假 Pi 回合驱动 + 记录型假 SDK；全部仓内确定性夹具。
- 承接：`docs/product/r6-multiuser-acceptance.md`（MU-6 / MU-8 在上个基线 BLOCKED）；本文件仅**新增** MU-8 的确定性接线与结论，**不改动任一 MU-1..10 判据**。

## 1. 把 MU-8 从 BLOCKED 接线的动机

上个多用户 run 的基线（`b90f12f`）不含 B2 静默闸（`packages/channel-wecom/src/silent-shadow-gate.ts` 不存在），MU-8 判据「静默投递 = 0」不可满足，故标 `BLOCKED`（`scripts/eval/r6/multiuser/mu-cases.ts` 旧版 `mu8`；`docs/decision-log.md` §2659-2660）。本基线 B2 已合入，MU-8 改为**确定性两段用例**（会话/任务层 + 投递层），只复用既有装配，不新建第二套会话/静默机制。

## 2. 复用点（不新增机制）

| 复用面 | 位置 | 用法 |
| --- | --- | --- |
| 生产同源装配 `createServer`（与 `npm start` 同源） | `apps/server/server.ts:89` | 两段都经 `createMuServer` → `createServer` 真实交互路径（不是直接 `registry.get`） |
| 身份双键 `(principalId,sessionId)` | `apps/server/server.ts:217-218`（`principalId=channel:wecomUserId`、`sessionId=channel:conversationId`）；会话缓存键 `server.ts:144-147` | 同 principal、不同 conversationId → 不同 Session |
| 渠道群/私分派 | `packages/channel-wecom/src/adapter.ts:495`（`chatType`）、`:496`（`chatid`）、`:502`（`conversationId=chatid??userid`） | 群 `conversationId=chatid`、私 `conversationId=userid` |
| 任务引用会话内解析 | `packages/agent/src/execution-runtime.ts:357-362`（`resolveTaskId` 只在 `registry.list(scope)` 内解析）；拒绝文案 `task-registry.ts:188-194` | 群会话取私聊 `#1` → `任务不存在或不属于当前会话`（与 MU-5 同源） |
| B2 出站闸门 opt-in | `packages/channel-wecom/src/silent-shadow-gate.ts:29/:32/:49-57/:133-163/:120-122` | `deliveryMode` 解析、`wrap` 收在唯一出站出口、`suppressedUserVisible` 证据 |
| 适配器闸门接线 | `adapter.ts:148`（选项）、`:208`（解析）、`:221`（`gate.wrap`）；`shadowEvidence()` `:313-320` | 显式 `silent` → 全部用户可见投递被抑制 |
| 记录型假 SDK 范式 | `packages/channel-wecom/adapter.silent-shadow.test.ts:36-91` | 本用例在 `mu-support.ts` 的 `MuSdkRecorder` 中同形复刻（记录每次出站调用） |

夹具：`scripts/eval/r6/multiuser/mu-support.ts` 新增 `MuSdkRecorder` / `startSilentWecomChannel` / `wecomTextFrame` / `settle`；用例体：`scripts/eval/r6/multiuser/mu-cases.ts` 的 `mu8SessionLayer` / `mu8DeliveryLayer` / `mu8`。

## 3. 判据（命中即 FAIL）

同一 principal `wecom:mu-alice`，两条不同 conversationId：私聊 `mu-alice`（`sessionId=wecom:mu-alice`）与群聊 `group-g1`（`sessionId=wecom:group-g1`），会话级标记 `PRIV-TAG` / `GROUP-TAG`（区别于既有 `MU_TAGS`）。

**第一段·会话/任务层**（`mode:'background'`，任务工具 `task_status` 在 Main 工具面可用，与 MU-5 同源）：

1. 两会话 Session 不同、任务分属各自 `sessionId`、`taskId` 不同；
2. 群回合主转录**不含**私聊标记、私聊回合**不含**群标记（不继承会话外历史）；
3. 群回合 `task_status ref=#1` **只**解析到群会话自己的任务，私聊 `#1` 对其**确定性拒绝**（`任务不存在或不属于当前会话`）且无内容泄漏；私聊回合 `#1` 命中私聊自己的任务；
4. `scopeViolations` / `crossoverHits`（`../oracle` 机械任务判据）为空。

**第二段·投递层**（`WecomBotChannel` + 记录型假 SDK，显式 `deliveryMode:'silent'` 包住 `server.handler`）：发一条群 frame（`chatid=group-g1, chattype=group, from.userid=mu-alice`）与一条私 frame（`chattype=single`）。

5. `recorder.userVisibleCalls === 0`（真实平台零用户可见投递）；`shadowEvidence` 可观测（mode=`silent`，抑制条数 ≥4）；
6. 群/私两会话分属各自 `sessionId`、任务 `taskId` 不同（投递不串）。

**硬零映射**（`MuHardZero` 既有枚举）：继承私聊历史 / 跨会话内容泄漏 → `cross_principal_leak`；越权取私聊任务或内容 → `unauthorized_execution`；任务或投递串线 → `task_crossover`。

## 4. 证据（本次运行）

命令：`npx vitest run scripts/eval/r6/multiuser/mu.test.ts`；证据落 `.runtime/r6/multiuser/MU-8/evidence.json`（gitignored）。

第一段：`sessionsDistinct=true`、`inheritedPrivateHistory=false`、`leakedIntoPrivate=false`、`groupFirstRejected=true`、`groupFirstLeaked=false`、`privOwnResolved=true`、`groupOwnResolved=true`、`scopeViolations=[]`、`crossoverCodes=[]`。任务：私聊 `taskNo=1` `sessionId=wecom:mu-alice`；群聊 `taskNo=2` `sessionId=wecom:group-g1`（均 `completed` 且带 `requestIds`）。

第二段：`deliveryMode=silent`、`userVisibleSuppressed=4`（`reply_stream`×4，即两条消息各 ack+终帧）、`realUserVisibleCalls=0`、`scopedDistinct=true`。

**五要素记录**（`principalId / sessionId / taskId / request / deliveredTo`）：本用例 `records` 逐条给出——私聊任务与群聊任务各一条（`deliveredTo` 分别为 `wecom:mu-alice` / `wecom:group-g1`），三段查询回合各一条（`taskId=null`）。汇总用例断言「每条五要素齐备」通过。

## 5. 反向绊线（反例即红）

- 若群会话继承了私聊任务：group `#1` 会解析到私聊 `taskId` → `unauthorized_execution`；
- 若群会话继承了私聊转录：群回合主转录出现 `PRIV-TAG` → `cross_principal_leak`；
- 若静默闸被摘除或翻成 `live`：假 SDK 会记到 ack/终帧调用，`userVisibleCalls≠0` → `cross_principal_leak`；
- 若两段任一会话/投递串台：`sessionsDistinct`/`scopedDistinct` 为假 → `task_crossover`。

## 6. 与字面要求的偏差（如实登记）

字面要求为「群回合 `task_status ref=#1` 只解析到群会话自己的 `#1`，私聊 `#1` 对其确定性拒绝」。实测**任务编号是全局单调分配**（`TaskRegistry.taskNo`，`task-registry.ts:178`「唯一、不复用」），同一底账内不存在两个 `#1`：隔离库中私聊先建得 `#1`、群聊建得 `#2`。因此实现为：

- 群回合 `ref=#1` → 确定性拒绝（私聊 `#1` 对群不可见，正对「私聊 `#1` 对群拒绝」）；
- 群回合 `ref=#2` → 命中群会话自己的任务（群「解析到自己的编号」）。

若编号分配方式改变，`groupOwnResolved` 会转假 → 用例红（不会静默放过）。该偏差是**编号语义的现实**，非判据放宽。

## 7. 结论

MU-8 **PASS**，`hardZeroHits=[]`。群聊不隐式继承私聊的任务/授权/历史；群/私投递不串；silent 闸下实际用户可见投递 = 0。用例为确定性、假件、零真实平台/凭据/写；未改 Worker 提示/账本/执行契约，未引新宿主治理，未引第二套压缩/会话机制，未改既有 MU-1..10 判据。

## 8. 校验命令与结果

- `npm run typecheck` → 0 错误。
- `npx vitest run scripts/eval/r6/multiuser/mu.test.ts` → 12 passed（与改动前同为 12 条：MU-8 由 1 条 BLOCKED 断言换为 1 条 PASS 断言，例数不变）。
- `npm test`（全量）→ `Test Files 96 passed (96)`、`Tests 981 passed | 3 todo (984)`，全绿。
