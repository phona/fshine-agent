> 历史归档：内部链接不保证可用；如需追改，以 git 历史为准。

# docs/decision-log.md · 第 5 块

## 八十五、B1 接线 · 会话持久化接入真实会话生命周期（2026-11-15，分支 `arch/b1-wiring`，基线 = `arch/integration` 启动时 HEAD `27c690c`）状态：**待合入**

> 本轮 = 把已合入的独立存储层 `packages/agent/src/session-persistence.ts`（见 §八十）接入**真实会话生命周期**：会话打开时从存储载入转录、回合结束后把**本回合新增**转录增量持久化；读/写失败 **fail-open**（不回滚回合，日志上报）；**principal / session 隔离**；**同 `dbPath` 重启原子恢复**。**零真实模型、零网络**（确定性假执行面 + 真实临时文件系统）。**不重实现** Pi 会话管理与压缩（Pi Session 仍是唯一转录所有者，**无第二套 session / compaction**）；不改 Worker 提示 / 任务账本语义 / 执行契约 / 压缩机制；`.runtime` 未 `git add`；`docs/decision-log.md` 除本条外未动。

### 1. 接线点（最小改动：4 生产文件 + 2 新测试 + 1 文档）

| 位置 | 改动 |
| --- | --- |
| `packages/agent/src/execution-runtime.ts:212` | 新增**端口**（仅类型，无实现耦合）：`export interface TranscriptStore { readTranscript(): Promise<readonly DriverMessage[]>; append(message: DriverMessage): Promise<void>; }`。runtime **不** import `JsonlSessionRepo`/`session-persistence`，保持依赖注入风格。 |
| `execution-runtime.ts` `RuntimeOptions`（`:278`/`:280`） | 加 `transcriptStore?: TranscriptStore` 与 `onTranscriptError?: (error: unknown) => void`（缺省 `undefined` = 逐字节现行为：转录仅内存）。 |
| `execution-runtime.ts` `createSession` 打开段（`:445-453`） | 注入存储时 `mainMessages = [...await transcriptStore.readTranscript()]`，并 `persistedCount = mainMessages.length`；读失败 fail-open。 |
| `execution-runtime.ts` `createSession` 回合替换点后（`:689`） | 按 `persistedCount` **增量追加本回合新增**消息，逐条推进；写失败 fail-open。 |
| `scripts/ask-runtime.ts`（`:195`/`:528`） | `SessionAssemblyInput` 加 `transcriptStore?` / `onTranscriptError?` 并透传；`assembleAskRuntime` / `assembleAskRuntimeCli` **不传** → ask/redo 单轮入口不落盘会话，现行为不变。 |
| `apps/server/server.ts`（`:32`,`:64`,`:119-120`,`:191`,`:308`） | import `SessionPersistence`（装配层是**唯一**构造具体存储处）；`ServerDeps` 加 `sessionStoreDir?`（缺省 `<dbPath 所在目录>/sessions`）；`sessionFor` 为每个 `(principal, session)` `openOrCreate` 独立句柄并作为 `transcriptStore` 注入；`Server.close()` 改 `Promise<void>` 并 `await sessionPersistence.close()`。 |
| `apps/server/main.ts`（`:55`） | 关停 `await server.close()`（确保存储句柄释放）。 |

端口与 `PersistedSession`（`session-persistence.ts:57`）**结构化相容**，装配层直接注入后者。

### 2. 写失败 fail-open（硬）

- **写失败不回滚回合**：`append` 失败时，已成功的追加保留、剩余不再尝试、**回合回复照常返回**，错误经 `onTranscriptError` 上报（server 侧落 `transcript_store_error` 日志，`server.ts:195`）。
- **读失败不阻塞打开**：`readTranscript` 失败退化为空转录，会话照常打开并可继续持久化本回合，错误同样上报。

### 3. 四类确定性验证证据（零真实模型、零网络、假执行面；真实临时文件系统）

文件：`apps/server/server-b1-persistence.test.ts`（server 级，3 用例）、`packages/agent/session-persistence-wiring.test.ts`（端口/失败注入，4 用例）。

| 类 | 用例 | 断言要点 |
| --- | --- | --- |
| ① 进程重启恢复 | server「重启恢复：同 dbPath 重建 server…」 | 发消息 → `await close` → 同 `dbPath` 重建 → 再发；第二回合 driver 输入转录**含首回合用户消息与 assistant 回复**。 |
| ② 任务恢复不重放 | server「任务恢复不重放 + 结果找回…」 | background 模式：任务经既有 runner 完成 → 重启后 `runner.pump` 与后续回合**均不再调用 executor**（新 executor `calls === 0`），恢复只重建对话上下文。 |
| ③ 结果找回 | 同上用例 | 重启后经 `createSqliteTaskRegistry(dbPath, { readOnly: true }).get(taskId, scope)` 取回首回合**真实结果**（`replyText` 逐字等于 archiveReply 存档）。 |
| ④ 用户隔离 | server「用户隔离：异 principal / 异 session…」 | 三回合分别落 `(user-a,conv-a)/(user-a,conv-b)/(user-b,conv-a)`；重启后 `(user-a,conv-a)` 新回合上下文**只含本会话内容**，`not.toContain` 他会话 / 他 principal 内容。 |
| 端口语义 + fail-open | 端口层 4 用例 | ① 载入历史 + 只增量追加；② `append` 失败不回滚回合、错误上报；③ `readTranscript` 失败不阻塞打开、错误上报；④ 缺省 `undefined` = 现行为。 |

**反向绊线（本轮实测）**：临时停用「打开载入」→ ①/③重启与隔离用例**红**（4 failed）；临时停用「回合后持久化」→ 5 failed。两处破坏都必须红，证明用例真实守护接线（验证后已还原）。详见 `docs/product/b1-wiring.md` §③。

**隔离机制**：存储层把 `principalId` 映射成独立子树 `<rootDir>/principals/<sha256(principalId)>`；server 侧 `sessionId = <channel>:<conversationId>`、`principalId = <channel>:<userId>`，异 principal / 异 session **物理分离**。

**重启恢复机制**：`sessionStoreDir` 缺省 = `<dbPath 所在目录>/sessions`（同一部署状态根）→ 同 `dbPath` 重建即恢复；`cwd` 取仓根（跨重启稳定——Pi 的 `(cwd, id)` 是会话身份的一半）。

### 4. 生产准入（本 run 未实现，**不阻塞 Dummy E2E**）

以下两项是**上线生产前的准入项**，本 run **明确不实现**，如实登记（不假称已解）：

1. **保留策略（retention）**：Pi 追加日志**只增不减**（compaction 只作为一条 `CompactionEntry` 再追加，压缩缩小的是**模型上下文**、不是日志文件）；存储**无界（线性）增长**，需消费方自备保留/轮转。本 run 不实现。
2. **容量上限（capacity cap）**：单 `(principal, session)` 或单部署的存储上限 / 背压未实现，超限行为未定义。

**不阻塞理由**：Dummy E2E / 验收以确定性假执行面 + 真实临时目录运行，规模受控；两项不改变本接线的正确性语义（载入/追加/fail-open/隔离/重启），可在接入真实部署前单独补齐。

### 5. 未重实现 Pi 会话与压缩 / 边界

- **不重实现** Pi 会话管理与压缩（Pi Session 唯一转录所有者，`readTranscript()` 每次**现读**存储、宿主不留第二份可变副本）；无第二套 session / compaction；不改 Worker 提示 / 任务账本语义 / 执行契约；`.runtime` 未 `git add`。
- **不重放**：接线只在对话上下文层载入/追加转录；任务侧仍走既有 runner（`task_cancel`/`task_resume`/`background` 的 pump），本层**无**任何执行/重放入口，也不感知 compaction。

### 6. 测试读数（**本会话实跑**；cwd = B1 worktree，`TMPDIR=~/.tmp`，零网零 key）

- 定向：`npx vitest run packages/agent/session-persistence-wiring.test.ts apps/server/server-b1-persistence.test.ts` → **2 文件 / 7 passed**。
- 类型：`npm run typecheck`（`tsc --noEmit`）→ **0 错误**。
- 全量：`npm test` → **97 文件 / 968 passed + 3 todo**；改动仅**新增** 2 个测试文件 / 7 个用例，**未删/未弱化任何既有用例**（例数只增不减）。

### 7. 未执行 / 局限（如实登记）

- **零真实模型、零网络**（假 Pi 驱动 / 假执行面）；真实模型会话长程记忆质量、真实重启（跨进程）待真实部署接入后另阶段。
- **保留策略与容量上限未实现**（见 §4，生产准入项，不阻塞 Dummy E2E）。
- 真实部署的 `sessionStoreDir` 落点（是否并入既有 `sessionTtlMs` 等生命周期策略）待裁定。

**指针**：`docs/product/b1-wiring.md`（接线点 / 语义 / 四类证据 / 生产准入）；关联 §八十（B1 独立存储层实施）。

---

## 八十六、MU-8 复跑（B2 合入后）· 企微群聊与私聊隔离（确定性两段用例：会话/任务层 + silent 投递层）（2026-11-15，分支 `arch/r6-mu8`，基线 = `arch/integration` 启动时 HEAD `56554fb`（含 B2 Silent Shadow 闸 + opt-in））状态：**待合入**

> 承接 §八十二（MU-8 在该 run 因 **B2 未合入** 标 `BLOCKED`）。本轮基线已含 **B2 Silent Shadow 出站闸门 + opt-in**（§八十三/§八十四，`merge(b2)` = `56554fb`），故把 MU-8 从 `BLOCKED` **接线为确定性两段用例**：**第一段**会话/任务层（同 principal 的私聊/群聊各自成账、互不继承任务/授权/历史、群取私聊 `#1` 确定性拒绝且无内容泄漏）；**第二段**投递层（`WecomBotChannel` + 记录型假 SDK，显式 `deliveryMode:'silent'`，真实用户可见投递 = 0 且抑制证据可观测）。**零真实模型、零真实企微、零真实写**（假件夹具）；**只复用既有装配，不新建第二套会话/静默机制，不改既有 MU-1..10 判据**。

### 1. B2 依赖已满足（从 BLOCKED 转 PASS 的依据）

- §八十二 的 BLOCKED 理由是 `packages/channel-wecom/src/silent-shadow-gate.ts` **基线不存在**；本轮基线 `56554fb` 该模块**已存在**（`git -C <mu8> rev-parse` 显示 HEAD 祖先含 `merge(b2)`），opt-in 改造（§八十四）也已在其上（`resolveDeliveryMode`/`isDeliveryModeDeclared`、`adapter.ts:205-221` 构造期解析 + `gate.wrap`、`shadowEvidence()` `adapter.ts:313-320`）。
- 因此 MU-8 的「静默投递 = 0 + 证据可观测」判据**可在无真实企微前提下确定性验证**，无需再标 BLOCKED。

### 2. 复用点（不新增机制）

| 复用面 | 位置 | 用法 |
| --- | --- | --- |
| 生产同源装配 `createServer`（与 `npm start` 同源） | `apps/server/server.ts:89` | 两段都经 `scripts/eval/long-session/multiuser/mu-support.ts` 的 `createMuServer` → `createServer` **真实交互路径**（不是直接 `registry.get`） |
| 身份双键 `(principalId,sessionId)` | `apps/server/server.ts:217-218`（`principalId=channel:wecomUserId`、`sessionId=channel:conversationId`）；会话缓存键 `server.ts:146-147`（`principal\u0000session`） | 同 principal、不同 `conversationId` → 不同 Session |
| 渠道群/私分派 | `packages/channel-wecom/src/adapter.ts`（`chatType`/`chatid` → `conversationId`） | 群 `conversationId=chatid`、私 `conversationId=userid` |
| 任务引用会话内解析 | `packages/agent/src/execution-runtime.ts`（`resolveTaskId` 只在会话 scope 内解析）；拒绝文案与 `TaskOwnershipError` 同源 | 群会话取私聊 `#1` → `任务不存在或不属于当前会话。`（与 MU-5 同源） |
| B2 出站闸门 opt-in | `packages/channel-wecom/src/silent-shadow-gate.ts`（`resolveDeliveryMode`/`wrap`/`suppressedUserVisible` 证据）；`adapter.ts` 构造期包裹 + `shadowEvidence()` | 显式 `silent` → 全部用户可见投递被抑制 |
| 记录型假 SDK 范式 | `packages/channel-wecom/adapter.silent-shadow.test.ts` 的 `DeliveryRecorder` | 本用例在 `mu-support.ts` 的 `MuSdkRecorder`（`:504`）中同形复刻 |

用例体：`scripts/eval/long-session/multiuser/mu-cases.ts` 的 `mu8SessionLayer`（`:453`）/ `mu8DeliveryLayer`（`:562`）/ `mu8`（`:620`）；夹具：`mu-support.ts` 新增 `MuSdkRecorder`/`startSilentWecomChannel`（`:576`）/`wecomTextFrame`/`settle`；测试包装：`scripts/eval/long-session/multiuser/mu.test.ts:102-115`。

### 3. 判据（命中即 FAIL）

同一 principal `wecom:mu-alice`，两条不同 `conversationId`：私聊 `mu-alice`（`sessionId=wecom:mu-alice`）与群聊 `group-g1`（`sessionId=wecom:group-g1`），会话级标记 `PRIV-TAG`/`GROUP-TAG`（区别于既有 `MU_TAGS`）。

**第一段·会话/任务层**（`mode:'background'`，`task_status` 在 Main 工具面可用，与 MU-5 同源）：① 两会话 Session 不同、任务分属各自 `sessionId`、`taskId` 不同（同 principal）；② 群回合主转录**不含**私聊标记、私聊回合**不含**群标记（不继承会话外历史）；③ 群回合 `task_status ref=#1` 对**私聊** `#1` **确定性拒绝**（`任务不存在或不属于当前会话。`）且无内容泄漏，群回合 `ref=#2` 命中群会话自己的任务，私聊回合 `#1` 命中私聊自己的任务；④ `scopeViolations`/`crossoverHits`（`../oracle` 机械任务判据 H3/H4/H5/E-G）为空。

**第二段·投递层**（`WecomBotChannel` + `MuSdkRecorder`，显式 `deliveryMode:'silent'` 包住 `server.handler`）：发一条群 frame（`chatid=group-g1, chattype=group, from.userid=mu-alice`）与一条私 frame（`chattype=single`）。⑤ `recorder.userVisibleCalls === 0`；`shadowEvidence` 可观测（`mode='silent'`、抑制条数 ≥4）；⑥ 群/私两会话分属各自 `sessionId`、`taskId` 不同（投递不串）。

**硬零映射**：继承私聊历史 / 跨会话内容泄漏 → `cross_principal_leak`；越权取私聊任务或内容 → `unauthorized_execution`；任务或投递串线 → `task_crossover`。

### 4. 证据（本会话实跑；`TMPDIR=~/.tmp`，零网零 key）

命令：`npx vitest run scripts/eval/long-session/multiuser/mu.test.ts`（cwd = 本 worktree）；证据落 `.runtime/r6/multiuser/MU-8/evidence.json`（**gitignored，不 `git add`**）。本次读数：

- **第一段**：`sessionsDistinct=true`、`inheritedPrivateHistory=false`、`leakedIntoPrivate=false`、`groupFirstRejected=true`、`groupFirstLeaked=false`、`privOwnResolved=true`、`groupOwnResolved=true`、`scopeViolations=[]`、`crossoverCodes=[]`。任务：私聊 `taskNo=1` `sessionId=wecom:mu-alice`；群聊 `taskNo=2` `sessionId=wecom:group-g1`（均 `completed` 且带 `requestIds`）。群首查 `error:"任务不存在或不属于当前会话。"`；群二查/私聊查 `error:null`。
- **第二段**：`deliveryMode=silent`、`userVisibleSuppressed=4`（`suppressedKinds=["reply_stream","reply_stream","reply_stream","reply_stream"]`，即两条消息各 ack+终帧）、`realUserVisibleCalls=0`、`scopedDistinct=true`（群/私各成建任务、`sessionId`/`taskId` 不同）。
- **判定**：MU-8 `status=PASS`，`hardZeroHits=[]`。

### 5. 五要素记录（`principalId / sessionId / taskId / request / deliveredTo`）

本用例 `records[]` 逐条给出（`deliveredTo` = 回复到达的 `(principal, session)`）。本次 7 条摘录：

- `{principalId:"wecom:mu-alice", sessionId:"wecom:mu-alice", taskId:"task_e146ef39-…", request:"PRIV-TAG 私聊交办查账", deliveredTo:"wecom:mu-alice"}`
- `{principalId:"wecom:mu-alice", sessionId:"wecom:group-g1", taskId:"task_64e966fa-…", request:"GROUP-TAG 群聊交办查账", deliveredTo:"wecom:group-g1"}`
- 3 条查询回合 `taskId=null`（私聊 `PRIV-TAG 查自己任务 #1`→`wecom:mu-alice`；群聊 `GROUP-TAG 查任务 #1`、`GROUP-TAG 查群任务 #2`→`wecom:group-g1`）。
- 投递层 2 条：私/群任务各一条，`deliveredTo` 分别为 `wecom:mu-alice` / `wecom:group-g1`。

汇总用例（`mu.test.ts:142-159`）断言「每条五要素齐备」通过。

### 6. 反向绊线（反例即红）

- 群会话若继承私聊任务 → 群 `#1` 会解析到私聊 `taskId` → `unauthorized_execution`；
- 群会话若继承私聊转录 → 群回合主转录出现 `PRIV-TAG` → `cross_principal_leak`；
- 静默闸若被摘除或翻 `live` → 假 SDK 记到 ack/终帧调用，`userVisibleCalls≠0` → `cross_principal_leak`；
- 两段任一会话/投递若串台 → `sessionsDistinct`/`scopedDistinct` 为假 → `task_crossover`。

### 7. 与字面要求的偏差（如实登记）

字面要求为「群回合 `task_status ref=#1` 只解析到群会话自己的 `#1`，私聊 `#1` 对其确定性拒绝」。实测**任务编号全局单调分配**（`TaskRegistry.taskNo` 唯一不复用），同一底账内不存在两个 `#1`：隔离库中私聊先建得 `#1`、群聊建得 `#2`。故实现为：群回合 `ref=#1` → 确定性拒绝（私聊 `#1` 对群不可见，正对「私聊 `#1` 对群拒绝」）；群回合 `ref=#2` → 命中群会话自己的任务（群「解析到自己的编号」）。若编号分配方式改变，`groupOwnResolved` 会转假 → 用例红（不会静默放过）。该偏差是**编号语义的现实**，非判据放宽。

### 8. 校验命令与结果（本会话实跑）

- `npm run typecheck`（`tsc --noEmit`）→ **exit 0**。
- 定向：`npx vitest run scripts/eval/long-session/multiuser/mu.test.ts` → **Test Files 1 passed（1）；Tests 12 passed（12）**（MU-8 由 1 条 BLOCKED 断言换为 1 条 PASS 断言，**例数不变**）。
- 全量：`npm test` → **Test Files 96 passed（96）；Tests 981 passed | 3 todo（984）**，exit 0；**例数不减、0 删除/弱化**。
- 判据未改核验：`git diff 56554fb..aa09f38 -- scripts/eval/long-session/multiuser/mu-cases.ts` 仅改动注释/import 与 `mu8` 区段；`mu.test.ts` 仅改 MU-8 `describe` 块与汇总 `blocked` 期望（`['MU-6','MU-8']`→`['MU-6']`，为 BLOCKED→PASS 的应有转换）。**MU-1..10 判据未改。**

### 9. 未执行 / 局限（如实登记）

- **零真实模型、零真实企微、零真实写**（假 Pi 驱动/假执行面/假后台/假通知 sink/假 SDK）；读数为**确定性假件夹具**结果，**不构成生产/平台行为结论**；**未执行任何真实企微联调**。
- **MU-6 仍待 B1 接线**：本分支基线 `56554fb` **不含** B1 会话持久化接线，`mu.test.ts` 的 MU-6 仍断言 `BLOCKED`（依赖 B1）；MU-6 的确定性验证待 B1 接线后另阶段复跑（本 run **不预造第二套会话机制**）。
- 本 run **不改 Worker 提示/账本/执行契约语义，不引新宿主治理，不引第二套压缩/会话机制，不改既有 MU-1..10 判据**。

**结论：MU-8 PASS，`hardZeroHits=[]`。** 群聊不隐式继承私聊的任务/授权/历史；群/私投递不串；silent 闸下实际用户可见投递 = 0。

**指针**：`scripts/eval/long-session/multiuser/mu-cases.ts`（`mu8SessionLayer`/`mu8DeliveryLayer`/`mu8`）、`scripts/eval/long-session/multiuser/mu-support.ts`（`MuSdkRecorder`/`startSilentWecomChannel`）、`scripts/eval/long-session/multiuser/mu.test.ts:102-115`、`docs/product/r6-mu8-followup.md`；关联 §八十二（MU-1..10 场景组，MU-8 原 BLOCKED）、§八十三/§八十四（B2 闸门 + opt-in）。

**状态：待合入。**

---

## 八十七、MU-6 复跑 · 重启恢复（多 principal，B1 接线后）（2026-11-15，分支 `arch/r6-mu6`，基线 = `arch/integration` 启动时 HEAD `ebdaf71`）状态：**待合入**

> 本轮 = R6 多用户确定性用例组（§八十二 MU-1～MU-10）中 **MU-6「重启恢复（多 principal）」** 的复跑落地：B1 接线（§八十五）已合入基线 `ebdaf71`，MU-6 的旧 `BLOCKED` 占位依赖解除，转为**真实确定性判据**。场景：≥3 principal 各**独立会话**同 `dbPath` 交办 → **关闭 server** → **同 `dbPath` 重建** → 各再发消息。**零真实模型 / 零真实平台 / 零真实写**（假渠道 + 假主驱动 + 确定性后台执行器 + 真实临时文件系统）。**复用既有装配**（`createServer` + `(principalId, sessionId)` 双键 + B1 `TranscriptStore` 接线）；**不以 `registry.get` 直调代替交互路径**（场景走 `server.handler`，判定读 Task Registry 只读快照）；**不建第二套会话 / 压缩机制**。

### 1. 依赖与解锁

- MU-6 旧版因依赖 **B1 会话持久化未合入**而标 `BLOCKED`（`mu-cases.ts` 旧版探测 `packages/agent/src/session-persistence.ts` 缺失即 BLOCKED）。
- B1 接线已随 `ebdaf71 merge(b1-wiring)` 合入基线：`SessionPersistence` 接入 `createServer` 真实会话生命周期（打开载入 / 回合后增量持久化 / 写失败 fail-open）。依赖满足，MU-6 转为真实用例。

### 2. 装配（复用，不建第二套）

| 复用点 | 位置 | 作用 |
| --- | --- | --- |
| `createServer`（生产同源） | `apps/server/server.ts:100` | MU 经 `createMuServer` 走同一装配链 |
| `(principalId, sessionId)` 双键会话缓存 | `apps/server/server.ts:163-208` | 逐 `(principal, session)` 独立句柄，物理隔离 |
| B1 `TranscriptStore` 接线 | `apps/server/server.ts:119-120,170,191` | `openOrCreate` 打开即载入、回合后增量持久化 |
| 会话存储根缺省 | `apps/server/server.ts:119` | `<dbPath 目录>/sessions` → 同 `dbPath` 重建即恢复 |
| `close()` 释放 | `apps/server/server.ts:302-309` | 关停后同 `dbPath` 重建须先释放（否则读到陈旧内存态） |
| Task Registry 只读快照 | `mu-support.ts:401-419` `readTasks` | 判定读 `TaskView` 快照，**非** `registry.get` 直调 |

### 3. 场景形状（`scripts/eval/long-session/multiuser/mu6-restart.ts`）

- ≥3 principal：`mu-alice` / `mu-bob` / `mu-carol`，各一独立会话 `conv-<user>`（`sessionId = wecom:conv-<user>`）。
- **background 模式**（唯此模式有 `runner.pump` 重启路径，③「任务不重放」才有机械意义）。
- 每 principal 首回合 `delegate`（后台任务，请求原文含本人标记，如 `TAG-ALICE 重启前交办`）；次回合 `turn`（普通追问，如 `TAG-ALICE 重启后追问`）。
- 假后台执行器 `TagKeyedExecutor` 按 `request` 派生**确定性**结果 `resultText = RESULT:<该请求标记>`（不依赖调用顺序）。
- 步骤：`server1` 并发投递 3 首回合 → 等 3 任务 `completed` → `await server1.server.close()` → **同 `dbPath` / 同 `dir`** 重建 `server2`（新执行器 = 重放检测器）→ 各发次回合。

### 4. 四断言判据（任一命中即 FAIL）

| # | 断言 | 机械判据 | 硬零码 |
| --- | --- | --- | --- |
| ① | **各自转录恢复** | 次回合上下文含**本人**首回合用户原文与 assistant 回复（`messagesText` 检） | `cross_principal_leak` |
| ② | **不跨 principal 串读** | 次回合上下文不含他人标记；每 principal 恰一任务且请求标记匹配、不含他人标记 | `cross_principal_leak` / `task_crossover` |
| ③ | **任务不重放** | 重启后（pump + 追问回合）新 executor 调用计数 = 0 | `task_crossover` |
| ④ | **结果找回** | 重启后经 Task Registry 取回首回合任务真实结果（`replyText === RESULT:<tag>`、`status === completed`） | `task_crossover` |

> ②③④ 复用 `MuHardZero` 既有词汇（`cross_principal_leak` / `task_crossover`），**不扩张**硬零码集合。③ 重放 = 任务连续性违规，映射到 `task_crossover`；`evidence.replayCallsAfterTurn` 给出专属机械证据。

**「不改既有 MU 判据」口径**：MU-1～5、7～10 的用例实现与断言**逐字未改**；MU-8 仍 `BLOCKED`。MU-6 本身即本任务落地对象（旧版是 `BLOCKED` 占位，**非既有判据**），故 `mu-cases.ts` 的 `mu6` 与 `mu.test.ts` 的 MU-6 断言由占位改为真实判据；`mu.test.ts` 汇总用例的 `BLOCKED` 期望由 `['MU-6','MU-8']` 收窄为 `['MU-8']`。

### 5. 证据（**本会话实跑**；cwd = MU-6 worktree `arch/r6-mu6`，`TMPDIR=~/.tmp`，零网零 key）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 定向 | `npx vitest run scripts/eval/long-session/multiuser/mu.test.ts` | **12 passed**（含 MU-6 PASS） |

MU-6 实测证据落 `.runtime/r6/multiuser/MU-6/evidence.json`（**未** `git add`）：`hardZeroHits=[]`；`restored`（`mu-alice`/`mu-bob`/`mu-carol`）全 `true`；`transcriptViolations=[]`；`taskViolations=[]`；`replayCallsAfterPump=0`、`replayCallsAfterTurn=0`、`noReplay=true`；`resultRetrieval` 三 principal 全 `ok=true`（`status=completed`、`replyText=RESULT:TAG-ALICE` / `RESULT:TAG-BOB` / `RESULT:TAG-CAROL`）；`taskCountBeforeRestart=3`、`taskCountAfterRestart=3`（**未重放**）。

**反向绊线**：临时把 `server.ts` 的 `transcriptStore` 置 `undefined` → MU-6 转红（`expected 'FAIL' to be 'PASS'`）；已 `git checkout` 复原。

### 6. 五要素记录（一次实测；taskId 为 UUID 实例，逐字见 `evidence.json`）

| principalId | sessionId | taskId | request | deliveredTo |
| --- | --- | --- | --- | --- |
| `wecom:mu-alice` | `wecom:conv-mu-alice` | `task_577a29ef-…7363656` | `TAG-ALICE 重启前交办` | `wecom:conv-mu-alice` |
| `wecom:mu-bob` | `wecom:conv-mu-bob` | `task_1e547e2a-…fe92bb` | `TAG-BOB 重启前交办` | `wecom:conv-mu-bob` |
| `wecom:mu-carol` | `wecom:conv-mu-carol` | `task_1bda94d7-…b457e5f6` | `TAG-CAROL 重启前交办` | `wecom:conv-mu-carol` |
| `wecom:mu-alice` | `wecom:conv-mu-alice` | —（次回合无任务） | `TAG-ALICE 重启后追问` | `wecom:conv-mu-alice` |
| `wecom:mu-bob` | `wecom:conv-mu-bob` | — | `TAG-BOB 重启后追问` | `wecom:conv-mu-bob` |
| `wecom:mu-carol` | `wecom:conv-mu-carol` | — | `TAG-CAROL 重启后追问` | `wecom:conv-mu-carol` |

### 7. 结论

MU-6 在本基线（含 B1 接线）上 **PASS**：三 principal 同 `dbPath` 关停重建后，①各自转录恢复、②不跨 principal 串读、③任务不重放、④结果找回四类断言全部成立，硬零命中为空。未改产品码、未引第二套会话 / 压缩机制、未接真实平台 / 写、`.runtime` 未 `git add`。

**指针**：`docs/product/r6-mu6-followup.md`（装配 / 判据 / 证据 / 五要素 / 结论）；`scripts/eval/long-session/multiuser/mu6-restart.ts`、`mu-cases.ts`、`mu.test.ts`；关联 §八十二（MU 场景组）、§八十五（B1 接线）。

**状态：待合入。**

---

## 八十八、P2 业务 E2E 预注册准备（七类场景 / 判据 / 硬停 / 失败分类 / 证据 schema / 合流依赖）（2026-11-15，分支 `arch/p2-prereg`，基线 = `arch/integration` 启动时 HEAD `f37d11d`）状态：**待合入·准备档（未执行）**

> 本轮 = **只文档、零真实模型、不跑测试**：产出 P2「业务端到端验收」预注册 `docs/product/p2-business-e2e-prereg.md`（v2，含 owner 侧复核逐条修订），把待执行的七类业务场景、样本量 N 与预算、判据、单实验硬停、失败分类、证据 schema、R6 Harness 复用映射与**合流依赖**冻结在跑之前，防跑后口径漂移 / 挑样本。**未跑任何 P2 样本、未调真实模型、未改产品码 / Worker 提示 / 账本 / 契约、未碰真实平台 / 写；`.runtime` 未 `git add`；`docs/decision-log.md` 除本条外未动。** P2 执行前的合流与适配器前置见 §8、§9。

### 0. 编号说明（既有重号，不改动）

> 本文件当前存在两处 `## 八十六、`（MU-8 复跑、MU-6 复跑；历史两分支合并产物）。本条按「当前最大号 86 + 1」取 **八十七**；重号留集成 Agent 单点裁定，本条不改动既有条目。

### 1. 七类场景（逐场景业务话术 + Oracle）

| 类 | 业务话术（要点） | Oracle（机械） |
| --- | --- | --- |
| S1 自然语言交办 | 一句话交办一件事（单会话多轮） | 任务真实到达终态 + 回复如实 + 事实与 registry 一致（tolerance=0） |
| S2 异步执行中继续对话 | background 受理后在飞时插入对话，再回收结果 | 首回合快照非终态 + 完成闸晚于 T2 + 最终真完成（否则 `insufficient_coverage`） |
| S3 查进度与结果 | 「刚才那个办到哪了 / 结果给我」 | 同 sessionId 内真实结果取回 + 事实一致 |
| S4 修改·取消·再交办 | 「改成 X / 算了取消 / 再按 Y 来一单」 | `cancelCalled` 真发生 + `cancelled` 态 + 回复如实（H5） |
| S5 进程重启后恢复 | 交办 → 关停 → 重启 → 「刚才那单怎样了」 | 同 `dbPath` 关停重建 + 转录由存储加载（真重启，否则 `insufficient_coverage`） |
| S6 多用户并发与隔离 | ≥3 principal 并发各自交办 / 各自会话 | 会合栅 3 到达真交错 + 无跨 principal / 跨 Session 泄漏 |
| S7 失败·超时·成本上限 | S7a 执行失败 / S7b 超时 / S7c 成本触顶 | 子例路径真实触发（`failed/COLLECTION_FAULT` / `timed_out` / 有界硬停） |

> 冻结时已补齐三处可执行性缺口：S2 必 `dispatchMode='background'`（`mu-support.ts:341`）；S7b 需 eval 侧 deadline-honoring Worker 驱动 + 不返回执行 gate（否决则记 `insufficient_coverage`）；覆盖判定接缝 `classifyP2Sample` + `p2Coverage`（§5.1，薄包装、不改 `evidence.ts`）。

### 2. 预注册 N 与预算 · 统计口径

- **样本量**：S1/S2/S3/S4/S5 各 N=3（各 3 会话）；**S6 N=3（每样本 = 3-principal 并发批次，共 9 会话）**；S7 N=3（S7a/S7b/S7c 各 1 样本，共 3 会话）。**合计 21 样本 / 27 会话**，另加 **1 装配冒烟会话**（不计入结论）。
- **统计口径（诚实）**：N=3 时 3/3 的 Wilson 95% 下界 = **0.4385**（区间极宽），**只读、不作稳定性概率结论**；逐场景报 k/N + Wilson 95% CI（`stats.ts:69`）。口径纠偏：0.342 是 2/2 下界，禁止引作 P2 读数。
- **总预算上界（算术上限，非全局额度闸）**：单会话硬停 `150 calls / 3,000,000 tokens / 2h`（`accounting.ts:66` `R6_HARD_LIMITS`，冻结）→ 27 会话 × 150 = **4,050 calls**；27 × 3M = **81,000,000 tokens**；27 × 2h。全局额度放行由协调员单点。

### 3. 判据

- **机械判据（确定性，硬；任一硬零命中 → 该批 FAIL）**：业务完成率、事实与任务一致（`judgeFactAnswer`，tolerance=0）、控制意图如实回执、无虚假完成（H4）、无虚假取消（H5）、无重复执行（H3）、无编号混淆（E-G）、无跨 principal 泄漏、无跨 Session 泄漏、无越权执行（MU-5）、通知不误投（MU-7）、无串行假并发（`Rendezvous`）、压缩有界（H6）。
- **行为判据（模型面，计数不硬否决）**：无谓澄清 / 用户介入 / 误答空答 / 指代理解失败，只统计、与机械项分开报告。
- **成本与时长上限（硬）**：calls `>=150` / tokens `>=3M` / 墙钟 `>=2h` 即先验拒绝下一请求（`CallAccountingGuard.precheck`，判定序 `ms→calls→tokens`），触达记有界失败、该样本不计通过。

### 4. 单实验硬停与停止条件

- **硬停**取冻结值 `maxModelCalls=150 / maxTokens=3,000,000 / wallMs=2h`（改此块 = 改冻结口径，禁；只允许测试注入更小上限）；先验=发起下一请求**之前**检查，达限抛 `R6HardStopError`、不发起该请求。
- **停止条件**：①任一硬零命中 → 该批 FAIL 并停跑新样本；②单会话硬停 → 该会话记有界失败；③装配/环境门（模型不可得 / 端点不可达 / 装配与声明不符）→ **blocking、退出码 2、不烧样本**；④环境中断 → 登记待重跑；⑤达 27 会话预算上界即停。

### 5. 失败分类（三态冻结；**产品故障样本不作废**）

对齐 `evidence.ts:24` `SampleDisposition` / `:111` `classifySample`（优先级 产品故障 > 环境中断 > 覆盖不足 > 有效）：`product_fault`（保留并判负，进分母，防幸存者偏差）；`environment_interrupted`（登记待重跑，不判产品负）；`insufficient_coverage`（保留留档、不用于结论）；`valid`（计入 k/N）。**P2 接缝**：`classifyP2Sample` 在 `classifySample` 之上补七类场景覆盖维度，产品故障不被吞。

### 6. 证据 schema（逐会话）

复用 `evidence.ts:64` `SessionEvidence` 并叠 MU 五要素记录（`MuDeliveryRecord`），**不新建第二套证据层**。P2 必填：交办原文（`turns[].text`）、回复（`replies[]`）、任务事实（`taskTurns/tasksFinal`）、执行轨迹（`toolCalls[]` + MU `execRecords`）、压缩事件（`compactionAttempts[]`）、token（`budgetUsed/callAccounting/modelCalls[]`）、耗时（`startedAt/endedAt` + `replies[].durationMs`）、`deliveredTo`（`MuDeliveryRecord.deliveredTo`）、处置（`SampleDisposition` + 硬零命中 `hardZeroHits`）、`p2Coverage`（P2 胶水新增，与 R6 `coverageSufficient` 并列）。落盘 `.runtime/**` 一律 gitignored、**不得 `git add`**。

### 7. 复用 R6 Harness 的映射

复用优先于抽象：**不新建**判定 / 证据 / 记账 / 并发 / 重启框架，全部复用 `scripts/eval/long-session/**` 与 `multiuser/**`——`runHarnessSession`（`harness.ts:82`）、`judgeFactAnswer/judgeTaskContinuity`（`oracle.ts`）、`judgeCompactionLifecycle`（`compaction.ts:126`）、`CallAccountingGuard`（`accounting.ts:194`）、`SessionEvidence/classifySample/collectEvidence`（`evidence.ts`）、`createMuServer/Rendezvous/MuDeliveryRecord/judgeMuTasks`（`mu-support.ts`）、`mu6Restart`（`mu6-restart.ts:104`）、`wilson95`（`stats.ts:69`）。**关键前置接缝**（eval 侧、非产品码）：真实模型 Main 适配器（`modelCallLedger()` 必须逐次暴露主/摘要/重试/溢出恢复）+ Dummy Worker + `classifyP2Sample`/S2 完成闸/S7b 驱动。

### 8. 合流依赖（**`DECISION_REQUIRED`，待 owner 批准**）

**分叉事实（本会话实测）**：`exp/pi-native-session-compaction` = `be61a74`（Pi 原生替换·阶段三，未跑真实模型）、`arch/integration` = `f37d11d`；分叉点 `git merge-base` = **`84a22fa`**；`rev-list --count` = **18 / 31**（exp 独有 18、integration 独有 31）。两侧**共同改动文件**（即文本冲突面）= **仅 `apps/server/server.test.ts` 与 `docs/decision-log.md`**。`git merge-tree --write-tree`（本会话实跑）= 合并树 **`6fd0d9a…`**，`Auto-merging apps/server/server.test.ts`、`CONFLICT (content): Merge conflict in docs/decision-log.md`——**唯一内容冲突在 `docs/decision-log.md`**，`server.test.ts` 可自动合并但须语义复核。

**结论**：P2 被测对象（真实模型 Main + B1 恢复接线 + Pi 原生会话/压缩 + MU 隔离）**横跨两分支**，必须先合流再跑，否则测到「半装配」、结论不可归属。**合流并合入 `arch/integration` 需 owner 批准**（owner 曾明确「不授权直接合入 `arch/integration`」）。

**建议合流方案**：自 `f37d11d` 拉独立合流分支 `arch/p2-merge-candidate`（**不合入、不 push**）→ merge `exp`；`docs/decision-log.md` 冲突**归集成 Agent 单点裁定**、`apps/server/server.test.ts` 按合流后行为语义复核 → 验证 `tsc` + `npm test` 全量 + 关键确定性用例（MU 全套含 MU-6/MU-8、B1 接线、B2 silent-shadow、Pi 压缩生命周期）→ 附证据**提请 owner 批准**，由集成 Agent 单点合入 → **合入后再跑 P2**。

**integration 前置已就绪（本会话实测 5/5 YES）**：`ebdaf71 / 56554fb / 0d44fbe / b7c62bd / f37d11d` 均为 `arch/integration` HEAD 祖先（`git merge-base --is-ancestor`）。

**`DECISION_REQUIRED`（提交 owner）**：①是否批准按上述独立合流分支验证后合入 `arch/integration`；②`decision-log.md` 冲突裁决归属（建议集成 Agent 单点）；③P2 的 `step-3.7-flash` + Dummy Worker 装配口径确认。**以上未批，P2 不启动。**

### 9. 未执行 / 局限（如实登记）

- **未跑 P2**：零样本、零真实模型、零真实平台/写；本轮所有读数为**只读预演**（merge-tree / ancestor / rev-list）。
- **真实模型 Main 适配器尚未接线**：`r6-longsession-harness-design.md:171`「真实生产同源装配适配器接线」仍列「仍待 Wave1」，现有只有零模型 `FakeHarnessSession`（`fake-session.ts`）——P2 执行前须在 `scripts/eval/**` 补 Main=真实 Pi + Dummy Worker 的 eval 侧适配器（非产品码）。
- **合流未执行**：仅只读预演；分叉未合并、`arch/integration` 未动；合入待 owner 批。
- **测试未跑**：本 run 纪律为「不跑测试」，故未执行 tsc / vitest；相关闸门留至合流分支与 P2 执行前。

**指针**：`docs/product/p2-business-e2e-prereg.md`（预注册全文）；关联 §八十五（B1 接线）、§八十六（MU-8 / MU-6 复跑）、`docs/product/r6-longsession-harness-design.md`（适配器 wave）。

**状态：待合入·准备档（未执行）。**
## 八十九、Pi 原生压缩替换实验 · 阶段一「能力核实与接入路径」· 归档登记（2026-11-15，分支 `exp/pi-native-session-compaction`，基线 = `arch/integration` 启动时 HEAD `84a22fa`）状态：**实验分支·待裁决**

> 角色：本 worktree 为阶段一核实节点，**只核实、不实施替换**。配套文档：`docs/product/exp-pi-native-session-phase1.md`。版本口径：只读锁版本 **`@earendil-works/pi-agent-core@0.85.1`（不升级）**（`node_modules/@earendil-works/pi-agent-core/package.json:3`）。公开判则：被根入口 `.`（`dist/index.d.ts`）re-export **或**位于 `package.json exports` 子路径内 = 公开；`dist/**` 深路径 import 未导出者 = 内部。下列行号均为 0.85.1 分发物 `dist/**`。

### 1. 工作区核验（本会话实跑）

- `pwd` / `git rev-parse --show-toplevel` = `.../fshine-agent-exp-pi-session`（**≠ 主仓** `~/projects/fshine-agent`）；`git rev-parse --abbrev-ref HEAD` = `exp/pi-native-session-compaction`；HEAD `bf94b92`；`git merge-base HEAD arch/integration` = **`84a22fa`**（基线一致）。**通过。**

### 2. 五项链能力（有·无）

| # | 能力 | 有/无 | 一手证据 |
|---|---|---|---|
| 1 | Session 转录管理（持有完整对话、跨回合追加、持久化/恢复） | **有** | 转录 = Branch 上 `Entry` 有序链（`session/types.d.ts:51` union，`:344` id/parentId/seq）；`StorageBackedSession.getBranchTip/appendToBranch`（`session/session.d.ts:69-77`）；`MemorySessionRepo`/`JsonlSessionRepo`（`session/index.d.ts:5-7`） |
| 2 | 自动压缩触发（threshold / manual / overflow） | **有** | 阈值配置 `CompactionSettings{enabled,reserveTokens,keepRecentTokens}`（`compaction.d.ts:31-38`）；默认 `{true,16384,20000}`（`compaction.js:75-79`）；公式 `contextTokens > contextWindow - reserveTokens`（`compaction.js:144-148`）；checkpoint 调 `prepareCompactionThreshold`（`runtime/drive/checkpoint.js:60` → `structural.js:837-869`，判定 `:863`）；`compaction_start.reason: "manual"\|"threshold"\|"overflow"`（`agent-harness.d.ts:374-376`） |
| 3 | 原生摘要及尾段保留（摘要 + `retainedTail` 持久化 + 重建上下文） | **有** | `prepareCompaction` 产 `messagesToSummarize` + `retainedTail`（`compaction.js:413-479`）；`CompactionEntry.retainedTail`（`compaction.d.ts:22-23`）；切点 `findCutPoint`（`compaction.js:253`） |
| 4 | Overflow Recovery（每代一次门控，有界） | **有** | 检测 `isContextOverflow \|\| isRecoverableLength`（`runtime/drive/response.js:111-115`）；恢复经 `prepareOverflowCompaction`（`structural.js:872-887`，`overflowRecoveryUsed` 门控 `:873`）；再次 overflow → 直接 `providerError` 终态失败（`response.js:139-143`），**无死循环** |
| 5 | 有界失败处理（摘要失败/压缩失败/无法切分） | **有** | 切点不落 `toolResult`（`compaction.js:221-222`），无切点回落 `firstKeptEntryIndex=startIndex`（`:255-256`）；摘要失败 `CompactionError` 传播；事件 `compaction_end.status: "completed"\|"failed"\|"declined"\|"aborted"`（`agent-harness.d.ts:379-395`） |

**结论：五项齐备。**

### 3. 公开 vs 内部 API 边界

- **公开**：`exports` 8 入口 —— `.`、`./node`、`./harness/context`、`./harness/env/nodejs`、`./harness/runtime/reducer`、`./harness/session`、`./harness/session/testing`、`./package.json`（亲验 `package.json exports`）。关键符号：`AgentHarness`/`AgentHarnessOptions`（`agent-harness.d.ts:617-715`；root `.` 经 `index.d.ts:6`）、`Session`/`SessionRepo`/`Entry`/`MemorySessionRepo`/`JsonlSessionRepo`（`session/index.d.ts:5-9`）、压缩原子件（`index.d.ts:8` 一行 re-export `compact`/`prepareCompaction`/`shouldCompact`/`DEFAULT_COMPACTION_SETTINGS`…）、`Context`（`./harness/context`）、`reduceLaneSnapshot`。
- **内部**（不 import）：驱动管线 `prepareCompactionThreshold`/`prepareOverflowCompaction`/`publishResponse`/`runCheckpoint` 等（`runtime/drive/*.js`）；`compactWithRequest`/`summarize…` 未 re-export 者；`harness/session/context.ts`（`buildSessionContext`，`session/index.d.ts` 未 re-export）；`StorageBackedSession` 自述 **"Package-internal typed boundary"**（`session/session.d.ts:35`）。
- **边界结论**：原子件 + 类型 + `AgentHarness` 接口 + Session 仓储 = 公开；驱动管线 = 内部，由公开 `AgentHarness` 在内部驱动，消费者**无需 import**。

### 4. 接入路径（fshine 所需公开入口，最小形态）

现状 `packages/agent/src/pi-driver.ts` 用 root `.` 的 `Agent` + 自填 `transformContext` + 自研编排（`compactTranscriptWithPi` 等），**未使用** `AgentHarness`/`Session`。替换最小形态仅需**三处公开入口**：① `AgentHarness`（root `.`）+ `SessionRepo`（`./harness/session`）+ `Context`（`./harness/context`）；每回合 `harness.lane('main', ctx)` → `lane.prompt(text, undefined, ctx)`（`agent-harness.d.ts:648-649,680`）复用**同一 session/lane**；压缩/阈值/溢出/失败恢复**全交 `AgentHarness` 内部**（`AgentHarnessOptions.compaction` `:629` / `setCompactionSettings` `:696`；`lane.compact` `:652-654`）。**不 import 内部符号、不复制 Pi 源码。**

### 5. GO / NO-GO 判定

**GO（条件式：能力准入层面通过）。** 准入条件「五项能力齐备」**满足**（§2，逐项有一手 `文件:行号` 证据）；「公开可达」**满足**（`AgentHarness` + `SessionRepo` + `Context` 构成完整公开生命周期入口，内部管线无需消费者 import）。**条件**（阶段二关闭）：① 装配可行性未实测（worktree 无 `node_modules`，零真实模型下未跑通）；② 成本/影响面不在本阶段结论内 —— 与既有 §七十七 `RECOMMENDED_OPTION=A（成本导向）` **不矛盾**（本判定为能力导向），取向差异须 owner 在阶段二数据齐备后统一裁定。

### 6. 原型计划（阶段二：证伪/证实，仍可零真实模型，用假 `Models`/`setDefaultStreamFn`）

S1 跨回合转录连续 · S2 threshold 自动压缩 · S3 overflow 恢复（二次 overflow 有界失败）· S4 工具配对（切点不落 `toolResult`）· S5 摘要失败有界重试 · S6 无可压缩 `NothingToCompact`。判据 = 仅用 §4 公开入口装配出等价行为；**任一须 import §3 内部符号或复制源码 → 转 NO-GO**（本阶段未发现此类阻塞）。

### 7. 未实施替换

- **阶段一零产品代码改动**（只新增 `docs/`）：`packages/`、`apps/`、Worker 提示、任务账本、执行契约、权限均未改；**未升级 Pi**、lockfile 未动；不复制 Pi 源码、不引新抽象、不依赖未导出内部实现；`.runtime` 未 `git add`。本阶段所有运行路径结论均为**静态源码/类型阅读所得**（未运行 harness 装配）。
- **回退**：本登记为 docs-only，`git revert` 对应提交即可；不 push / 不合并 / 不碰 main/tag。

**指针**：`docs/product/exp-pi-native-session-phase1.md`（阶段一全文）；`node_modules/@earendil-works/pi-agent-core/dist/**`（0.85.1）；既有关联 §六十九、§七十、§七十七。

**状态：实验分支·待裁决。**

---

## 九十、Pi 原生替换实验 · 阶段二「最小可运行原型」· 归档登记（2026-11-15，分支 `exp/pi-native-session-compaction`，基线 = `arch/integration` 启动时 HEAD `84a22fa`）状态：**实验分支·待裁决**

> 角色：本 worktree 为阶段二原型节点，**只做最小可运行原型，不实施完整替换**。承接 §八十九 阶段一 GO（条件式）。配套：`scripts/eval/pi-native/{driver.mjs,README.md,OUTPUT.txt}`。版本口径：只读锁版本 **`@earendil-works/pi-agent-core@0.85.1`（不升级）**。**零真实模型**：全程假 stream fn 驱动，无任何真实 Provider/网络调用。

### 1. 工作区核验（本会话实跑）

- `pwd` / `git rev-parse --show-toplevel` = `.../fshine-agent-exp-pi-session`（**≠ 主仓** `~/projects/fshine-agent`）；`git rev-parse --abbrev-ref HEAD` = `exp/pi-native-session-compaction`；原型提交 `8aae96b`（parent `206cb19`）；`git merge-base HEAD arch/integration` = `84a22fa`（与 §八十九 基线一致）。**通过。**

### 2. 接入路径实测（关闭阶段一「装配可行性未实测」条件）

- 装配只用**公开入口四处**（`scripts/eval/pi-native/driver.mjs:20-24`）：`AgentHarness`+`setDefaultStreamFn`（root `.`）、`MemorySessionRepo`/`JsonlSessionRepo`（`./harness/session`）、`BACKGROUND_CONTEXT`（`./harness/context`）、`NodeExecutionEnv`（`./harness/env/nodejs`）；假 provider 流用 `createAssistantMessageEventStream`（`@earendil-works/pi-ai/utils/event-stream`）构造与 Pi 同构流。
- 装载：`MemorySessionRepo.create({},ctx)` 得 session → `AgentHarness.create({session,models,model,compaction,retry},ctx)`（`driver.mjs:127-135`）；`models` 只用 `getModel`/`streamSimple`/`completeSimple` 三方法的假对象（`driver.mjs:91-104`）。**未 import 任何 `dist/**` 内部符号、未复制 Pi 源码。**
- 复跑（本会话实跑 3 次）：`node scripts/eval/pi-native/driver.mjs` → 退出码 `0`，三次均 `==== ALL CHECKS PASSED ====`（37 条 `[PASS]`）。`OUTPUT.txt` 与本会话新跑输出（ULID 归一后）逐行一致。

### 3. S1–S6（+附加 S7）结果

| # | 场景 | 结果 | 关键原始输出（节选自 `OUTPUT.txt`） |
|---|---|---|---|
| S1 | 跨回合转录连续性：同一 session 两次 `lane.prompt` | PASS | `r1.ok=true r2.ok=true`；entry 链 `seq=4→14→23→33` 且 `parentId` 连续；tip 前移；第二回合 provider 实收上下文含第一回合 `hello round1` + `first-answer` |
| S2 | threshold 自动压缩（`reserveTokens` 调小强制触发） | PASS | `compaction_start={"reason":"threshold"}`；`compaction_end={"status":"completed","reason":"threshold"}`；写入 `type=compaction` entry（`tokensBefore=5000`、`summary="PI-GENERATED-SUMMARY"`、`retainedTail` 角色 `[user,assistant]`） |
| S3 | Overflow Recovery（首答 context-overflow → 原生恢复 → 续跑） | PASS | `compaction_start reason=overflow` → `compaction_end status=completed` → 自动续跑 → `run_end status=completed`；assistant 流调用=2 |
| S4 | 有界失败（反复 overflow 超上界 / 无法切分） | PASS | (a) 反复 overflow：**只**恢复一次 → `run_end status=failed`、assistant 调用恒=2、`retry_scheduled=0`；(b) 空会话 `lane.compact` → `{"_tag":"NothingToCompact"}`、**零** provider 调用 |
| S5 | 工具调用/结果完整配对 | PASS | `retainedTail` 同时含 toolCall `tc-echo-1` 与其 toolResult；全会话 toolCall/result 一一配对 |
| S6 | 摘要失败有界 | PASS | 摘要 provider 报错 → `retry_scheduled` 至 `maxAttempts=3` → `compaction_end status=failed`、`summary completeSimple calls=3`（有界，不无界重试） |
| S7（附加） | 持久化入口 | PASS | `JsonlSessionRepo` 落盘后重开同一 session，`reopened entry count=2` 转录保留 |

### 4. 「压缩由 Pi 触发」硬证据

- 所有 `compaction_start`/`compaction_end`/`retry_scheduled`/`run_end` 事件均由 `harness.events.on(...)` 从 `AgentHarness` 侧收集（`driver.mjs:119-125`），`type=compaction` entry 由 `lane.findEntries` 读出（`driver.mjs:137-140`）——**均由 `AgentHarness`/lane 路径产生**。
- 原型**未引入任何 fshine 自研压缩触发**：`driver.mjs` 无任何压缩调用，唯一压缩相关输入是公开的 `AgentHarnessOptions.compaction`（`CompactionSettings`）与 `AgentHarnessOptions.retry`（`RetryPolicy`）；S2 断言含 `no fshine code triggered compaction (only public settings set)`（`driver.mjs:243`）；`driver.mjs:13-15` 亦自述此边界。
- 假 provider 侧记录 `completeSimple` 调用数作为摘要次数（S2=1、S6=3），证明摘要调用由 Pi 管线发起、非原型发起。

### 5. 假 stream 零真实模型

- 假 stream：`setDefaultStreamFn` 装公开缺省假流（`driver.mjs:478`），并以 `createAssistantMessageEventStream` 构造 provider 侧与 Pi 同构的事件流（`driver.mjs:57-68`）；`makeModels` 的 `getProviders/getAvailable/refresh/checkAuth/login/...` 均为桩（`login` 抛错），**无真实 provider 可达**。全程无网络调用。

### 6. 未动 packages

- 原型提交 `8aae96b` 仅新增 `scripts/eval/pi-native/**`（3 文件：`driver.mjs` / `README.md` / `OUTPUT.txt`）；`git show --name-only 8aae96b` 无 `packages/`、无 `package-lock.json`。**未升级 Pi**、lockfile 未动、`.runtime` 未 `git add`（本会话 `git status` 干净）。

### 7. 下一步（完整替换，下一阶段；本阶段未实施）

- 阶段二只证「装配可行 + 压缩确由 Pi 触发」；**完整替换未实施**。下一阶段：在 `packages/` 内以 §2 三处公开入口替换 `packages/agent/src/pi-driver.ts` 的 `Agent` + 自研 `transformContext`/`compactTranscriptWithPi` 编排（§八十九 §4），按 TDD + 黑盒 Eval 验收。成本/影响面取向仍须 owner 统一裁定（§七十七 `RECOMMENDED_OPTION=A` 成本导向 vs §八十九 能力导向）。

**指针**：`scripts/eval/pi-native/README.md`（场景/判据/复跑）；`scripts/eval/pi-native/OUTPUT.txt`（原始输出）；`docs/product/exp-pi-native-session-phase1.md`（阶段一）；`node_modules/@earendil-works/pi-agent-core/dist/**`（0.85.1）；关联 §六十九、§七十、§七十七、§八十九。

**状态：实验分支·待裁决。**

---

## 九十一、Pi 原生替换 · D1 反向绊线独立复核（2026-11-15，分支 `exp/pi-native-session-compaction`）状态：**实验分支·待裁决**

> 角色：D1 反向绊线**独立复核**（本 run 唯一台账写者）。承接 §八十九（阶段一 GO 条件式）、§九十（阶段二最小原型）。夹具：`scripts/eval/pi-native/tripwire-d1.mjs`（首轮，`a997e26`）、`tripwire-d1-recheck.mjs`（独立复核，`c8d5761`）、`tripwire-d1-tao.mjs`（第三方独立复现，`20ea3a2`）。版本口径：只读锁 `@earendil-works/pi-agent-core@0.85.1`。**零真实模型**：仅假 `Models`/假 `streamFn`，`baseUrl=http://localhost`，`streamDeferred`/`fetchDeferred` 均 `throw 'n/a'`。

### 1. 工作区核验（本会话实跑）

- `pwd` / `git rev-parse --show-toplevel` = `.../fshine-agent-exp-pi-session`（**≠ 主仓** `.../fshine-agent`）；`git rev-parse --abbrev-ref HEAD` = `exp/pi-native-session-compaction`；复核前 `git status --porcelain` 空。**通过。**

### 2. 复现命令与原始输出（本会话实跑，三夹具）

```
node scripts/eval/pi-native/tripwire-d1.mjs          # exit 1（其门「超窗请求发出数 == 0」FAIL —— 即 D1 不可删）
node scripts/eval/pi-native/tripwire-d1-recheck.mjs  # exit 0
node scripts/eval/pi-native/tripwire-d1-tao.mjs      # exit 0
```

关键原始行（逐字）：

- `tripwire-d1.mjs`：`assistant stream calls = 1  (over-window = 1)`；`first promptTokens = 20073  budget = 7168`；`run_end = [{"status":"failed","error":"assistant_error"}]`；`retry_scheduled count = 0`；`[FAIL] (a) knowably over-window requests sent == 0  -> overWindowCalls=1`。退出码 `1`。
- `tripwire-d1-recheck.mjs`：`assistant stream calls = 1  (over-window = 1)`；`compaction_start = ["threshold"]`；`compaction_end = [{"status":"completed","reason":"threshold"}]`；`run_end = [{"status":"failed","error":"assistant_error"}]`；`retry_scheduled count = 0`；`before_request event = [{"keys":["attempt","lane","model","runId","step","streamOptions"],"hasMessages":false,"hasContextWindow":false,"step":"compaction"},{"keys":[...],"step":"assistant"}]`；`transform_context event = [{"messageCount":2}]`；`public veto hook available = no`。退出码 `0`。
- `tripwire-d1-tao.mjs`：compaction **关** → `streamCalls=2  overWindowSent=2`、`compaction_start=["overflow"]`、`run_end=[{"status":"failed","code":"assistant_error"}]`、`retry_scheduled=0`；compaction **开** → `streamCalls=1  overWindowSent=1  compEnd=["completed"]`；抛错 `before_request` → 仍发出（`calls=1 overWindow=1`）；`estimateContextTokens([giant]).tokens = 20000`、`shouldCompact(20000, 8192, {...}) = true`。退出码 `0`。

三夹具结论一致：**一个已知必然超窗的请求被实际发出**（compaction 开 = 1 次；关 = 2 次，含 1 次 overflow-recovery 重发），**未在发起前拒绝**。

### 3. 发出次数与有界性

- **发出次数**：必然超窗请求至少发出 1 次（compaction 开）／2 次（compaction 关），从不为 0。
- **有界失败**：三夹具一致 `run_end status=failed`（`code/error=assistant_error`）、`retry_scheduled=0`；无无限重试。`tripwire-d1-tao.mjs` 另证：即便 `before_request` 处理器**抛错**，请求仍被发出（处理器不能否决发送）。→ **有界失败：是。**

### 4. Pi 0.85.1 是否提供「发送前尺寸预判/拒绝」能力（只读源码/类型，本会话）

- **Hook 面**：公开 hook 注册表 `HookMap` = `node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts:485-604`，共 11 个 hook：`before_run`(:486) `before_drive`(:495) `before_run_end`(:501) `transform_context`(:510) `before_request`(:520) `before_payload`(:531) `after_response`(:540) `before_tool`(:550) `after_tool`(:564) `before_compaction`(:582) `before_navigation`(:593)。
- `before_request`（:520-530）event 仅 `{model, step, attempt, streamOptions}`、result 仅 `{streamOptions?}`——**无 block/decline 变体**；`before_payload`（:531-539）result 仅 `{payload}`——**无 veto**。
- **对照**：hook 层确有否决机制，但**唯独不给发送尺寸门**——`before_tool` result 含 `block?:{reason,terminate?}`（:558-561）；`before_compaction` result 含 `decline?:boolean`（:589）；`before_navigation` result 含 `decline?:boolean`（:600）。
- 全包 `*.d.ts` 搜 `maxInputTokens|wouldOverflow|estimateBeforeSend|preSend|beforeSend|wouldExceed|wouldBlock|preDispatch|preflight|sendGuard|canSend` 等 → **零命中**（仅 `structural.d.ts:20`、`types.d.ts:226`、`lane.d.ts:53` 三处无关注释）。
- 所有 `block?/decline?` 出现点均为工具/压缩/导航：`agent-harness.d.ts:558`、`:589`、`:600`；`types.d.ts:41`（`BeforeToolCallResult`）；`execution/tools.d.ts:24`（`BeforeToolDecision`）。**无一为发送尺寸门。**
- 估算**辅助函数确实存在但未接发送路径**：`dist/harness/compaction/compaction.d.ts:57` `estimateContextTokens`、`:59` `shouldCompact`、`:61` `estimateTokens`、`:42` `calculateContextTokens`；经 root `dist/index.d.ts:8` 再导出。夹具 2/4 证明：`shouldCompact(...) = true` 的同时请求仍被发出——**纯判定函数，非发送前门**。
- `AgentHarnessOptions`（`agent-harness.d.ts:617-637`）字段：`session, models, model, thinkingLevel, activeToolNames, tools, toolContext, systemPrompt, resources, streamOptions, retry, compaction, steeringMode, followUpMode, toolExecution, toProviderMessages, entryProjectors`——**无任何尺寸门字段**（`toProviderMessages` 是 `AgentMessage[]→Message[]` 变换，不能拒绝发送）。

**四问结论（确定）**：①发起模型请求前拒绝=**否**；②发出次数=**1（compaction 开）/ 2（关），恒 ≥1**；③有界失败=**是**（`run_end failed`、`retry_scheduled=0`）；④Pi 公开面无「发送前尺寸预判/拒绝」钩子=**确认无**。

### 5. T5 结论（「当前回合超过预算 → 不发送必然超窗请求」）

**三态判定 = 「Pi 不提供」**。Pi 0.85.1 有公开尺寸**估算**函数（`estimateContextTokens`/`shouldCompact`），但**未接入发送路径**；hook 层有 `block/decline` 否决机制，却**不覆盖请求发送**；`AgentHarnessOptions` 无尺寸门。故**当前回合超过预算时，Pi 自身不会拒绝发起该必然超窗请求**。→ **D1 不可删**（反向绊线成立：删除 D1 宿主侧防线后，新路径把必然超窗请求直接发出）。

### 6. 对替换的影响

- 在 T5 这一维度上，**Pi 原生替换 blocked**：单纯改用 Pi 原生路径**不能**替代「发送前拒绝必然超窗请求」这一能力，D1 相关防线需保留（或由宿主侧最小实现承担，待裁）。
- 本复核与 §九十、`a997e26` 提交信息「据裁定保留 D1，替换 blocked」一致；成本/影响面取向仍须 owner 统一裁定（§七十七 `RECOMMENDED_OPTION=A` 成本导向 vs §八十九 能力导向）。
- 本复核未改任何产品码（`packages/**`、`apps/**` 未动），仅只读探查 Pi 类型面 + 实跑既有夹具。

**指针**：`scripts/eval/pi-native/tripwire-d1.mjs`、`tripwire-d1-recheck.mjs`、`tripwire-d1-tao.mjs`（夹具）；`scripts/eval/pi-native/OUTPUT-tripwire-d1-recheck.txt`、`OUTPUT-tripwire-d1-tao.txt`（归档原始输出）；`node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts:485-604`、`dist/harness/compaction/compaction.d.ts:42-61`、`dist/index.d.ts:8`（0.85.1 公开面）；关联 §六十九、§七十、§七十七、§八十九、§九十。

**状态：实验分支·待裁决。**

---

## 九十二、Pi 原生替换 · 最小方案 B 验证（2026-11-15，分支 `exp/pi-native-session-compaction`）状态：**实验分支·待裁决**

> 角色：**最小 B 独立验证**（本 run 唯一台账写者）。承接 §八十九（阶段一 GO 条件式）、§九十（阶段二最小原型）、§九十一（D1 反向绊线独立复核）。配套夹具：`scripts/eval/pi-native/pi-harness-driver.mjs`（最小 B 驱动，原 `minimal-b.mjs`，`acda036` 新增、`1645105` 改名避开过渡命名收敛守卫）、`scripts/eval/pi-native/verify-pi-harness.mjs`（验证夹具，原 `verify-minimal-b.mjs`，`2bd5dba` 新增、`1645105` 改名）、`scripts/eval/pi-native/OUTPUT-pi-harness.txt`（归档原始输出）。**未采信** guard 越界产物 `3c823c3` / `tripwire-b.mjs`（未经独立复核），本 run 未引用其结论/夹具。版本口径：只读锁 **`@earendil-works/pi-agent-core@0.85.1`（不升级）**。**零真实模型**：仅假 `Models`/假 `streamFn`，`baseUrl=http://localhost`，`streamDeferred`/`fetchDeferred` 均 `throw 'n/a'`。

### 1. 工作区核验（本会话实跑）

- `pwd` / `git rev-parse --show-toplevel` = `.../fshine-agent-exp-pi-session`（**≠ 主仓** `.../fshine-agent`）；`git rev-parse --abbrev-ref HEAD` = `exp/pi-native-session-compaction`；`git status --porcelain` 空。`git merge-base HEAD arch/integration` = `84a22fa`（与 §九十 基线一致）。**通过。**
- 本分支自 merge-base 改动文件**仅为** `docs/**` 与 `scripts/eval/pi-native/**`（`git diff --name-only 84a22fa..HEAD`）——**未动** `packages/**`、`apps/**`、`package-lock.json`；未升级 Pi；`.runtime` 未 `git add`。

### 2. B 定义（严格）

**Pi 原生 Session/Harness 负责全部压缩与 Overflow Recovery**（转录、压缩触发/执行、摘要、尾段保留、溢出恢复归 Pi）；fshine **只保留一处必要的「请求前预算检查」**——**不调用旧 `compactTranscriptWithPi`、不自行摘要/裁剪/降级/重试**。

### 3. 最小 B 实施

- `pi-harness-driver.mjs` 用**公开入口**装配 Pi 原生 Harness：`AgentHarness`+`setDefaultStreamFn`+`estimateContextTokens`（root `.`）、`MemorySessionRepo`（`./harness/session`）、`BACKGROUND_CONTEXT`（`./harness/context`）、`createAssistantMessageEventStream`（`@earendil-works/pi-ai/utils/event-stream`）（`pi-harness-driver.mjs:19-22`）。全部压缩触发/执行、尾段保留、溢出恢复经公开 `AgentHarnessOptions.compaction`/`.retry`/`.tools` 交 Pi（`pi-harness-driver.mjs:186-189`）。
- **唯一** fshine 决策：`preRequestBudgetCheck(nextRequestMessages)`（`pi-harness-driver.mjs:208-211`），置于**调用 Pi 之前**——`run()` 先在 `lane.prompt` 之前计算并判定，超预算即抛 `PreRequestBudgetRefusal` 有界失败、**未触达 harness/provider**（`pi-harness-driver.mjs:220-233`）。
- 文件内**无任何 host 侧压缩**：无摘要 prompt、无切分、无裁剪、无降解、无再压缩重试循环（`pi-harness-driver.mjs:8-11` 自述边界）。
- **范围声明（重要）**：本 run **未改 `packages/**`**——真正的产品驱动切换（把 `createPiTurnDriver` 从低层 `Agent` + 自研 `transformContext`/`compactTranscriptWithPi` 编排切到 Pi 原生 `AgentHarness`）**未实施**；本 run 只在 `scripts/eval/pi-native/**` 内做实验驱动与验证。

### 4. 公开前置扩展点结论与覆盖范围（只读源码/类型，本会话）

- 公开 hook 注册表 `HookMap`：`node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts:485-604`，共 11 个 hook。逐一判定入参/返回契约：
  - `transform_context`（`:510-519`）event `{messages, systemPrompt}`、result `{messages?, systemPrompt?}`——**只能变换，无中止/拒绝变体**；
  - `before_request`（`:520-530`）event `{model, step, attempt, streamOptions}`、result `{streamOptions?}`——**无 messages、无 contextWindow、无 abort/block/decline**；
  - `before_payload`（`:531-539`）event `{model, payload}`、result `{payload}`——**只能替换 payload，无 veto**；
  - `before_tool`（`:550-563`）result `{args?, block?}`——**block 的是工具调用，不是模型请求**；
  - `before_compaction`（`:582-592`）result `{decline?, compaction?}`——**decline 的是压缩，不是发送**；
  - `before_run`（`:486-494`）event `{prompt, resources}`、result `{messages?}`——**只能追加/变换 prompt，run 起始一次，无 abort**。
- **派发实现证实「抛错不可否决」**：`dist/harness/hooks.js` 对 `transform_context`（`:133-153`）、`before_request`（`:154-170`）、`before_payload`（`:171-184`）均 `try { handler } catch { reportError }`，捕获后**沿用原值继续**；`before_tool` 抛错则 `block={reason}`（`:121-126`，只挡工具）。→ 在公开 hook 里 throw **不能**阻止请求被发出。
- **触发时机**：`dist/harness/runtime/drive/generation.js:58` `before_request` 每 generation step 触发；`:119-125` `transform_context` 在流内**每次请求**触发（含续发）；`:127-130` `before_payload` 每 payload 触发。三者均**只能变换/替换**，无一可返回「拒绝/中止发送」。
- **覆盖范围结论**：单处请求前检查覆盖**每个 run 的首条请求**（在 fshine 调 Pi 之前，harness 未触达即拒）；**不能覆盖 run 内的续发请求**（工具结果超窗后的第二次 `streamSimple`）——公开面无任何 seam 能对续发请求做发送前尺寸预判并中止；`transform_context`/`before_payload` 若用于裁剪即成为 host 侧压缩（与 B 定义冲突，且属「复制 Pi 实现」，本 run 不采用）。

### 5. D1 绊线重跑（本会话实跑）

```
TMPDIR=~/.tmp node scripts/eval/pi-native/verify-pi-harness.mjs                 # failures=0 exit 0
FSHINE_B_REVERSE=1 TMPDIR=~/.tmp node scripts/eval/pi-native/verify-pi-harness.mjs  # failures=9 exit 1
```

- **正常态**（`failures=0`、`exit 0`，与 `OUTPUT-pi-harness.txt` 逐行一致，仅 ULID 归一）：各窗首条不可救超窗请求（单条巨型消息，无可切分）被 `PreRequestBudgetRefusal` **有界拒绝**——`override` 前 `provider stream calls = 0 (over-window = 0)`、`run_end = []`；W=8192 `refused: pre-request budget exceeded: 8192 > 3066`、W=40000 `40000 > 34874`、W=128000 `128000 > 122874`。
- **反向绊线**（`FSHINE_B_REVERSE=1`，故意旁路单处检查）：`failures=9`、`exit 1`；W=8192/40000/128000 均 `sent=1 over=1 refused=false`、`run_end=["completed"]`——**旁路后必然超窗请求被发出**。→ 证明单处检查**承重**（反路径红）。

### 6. 补测矩阵（窗口 8192 / 40k / 128k；本会话实跑）

| 场景 | 覆盖窗口 | 关键原始读数 | 结果 |
|---|---|---|---|
| 不可救超窗首请求（**不可压缩**：单条无可切分巨型消息）| 8192/40k/128k | `sent=0 over=0 refused=true` | PASS（有界拒绝） |
| 首请求旁路对照 | 8192/40k/128k | `over=1` | PASS（单处检查承重） |
| **工具结果导致超窗**续发 | 8192、40k（40k 另挂抛错 hook） | `stream calls=2 over-window=1`、`run_end completed` | **Q2 = NO**（续发超窗被送出；抛错 hook 无法否决） |
| **可压缩**上下文 | 8192/40k/128k | 各 3 次 `compaction_end completed reason=threshold`、`over=0`、`turns=4` | PASS（压缩由 Pi 完成，无 host 代码） |
| **摘要失败** | 8192 | `completeSimple calls=3`（≤ maxAttempts=3，有界）、`compaction_end failed`、`over sent=0` | PASS（有界，不无界重试） |
| **有界恢复**（overflow→一次原生恢复→成功） | 8192/40k/128k | `compaction_start=["overflow"]`、`run_end completed`、`stream calls≤2` | PASS |
| **任务不重复执行** | 8192、40k | 工具 `executions=1` | PASS（压缩/恢复后不重复执行） |

### 7. 整体删除清单（产品代码；B 若成立将被整体删，非两套并存）

若 B 成立，删除面**自包含于** `packages/agent/src/pi-driver.ts`（+ 专属测试/夹具/装配点），逐项：

- 压缩编排函数：`compactionSettingsFor`（`pi-driver.ts:342`）、`splitForCompaction`（`:402`，含 `takeSummaryChunk` `:431`、`clampMessageForSummary` `:445`）、`summarizeWithinWindow`（`:534`）、`trimToBudget`（`:583`）、`degradeByDropping`（`:600`）、`compactTranscriptWithPi`（`:634`，含 `SummaryTokenUsage` `:516`、`addSummaryUsage` `:521`、`emptySummaryUsage`、`roleOf`/`lastUserIndex`/`summaryMessageTokens`/`summaryChunkTokens`/`summaryInputAllowance` `:364-400`）。
- 三条触发臂：**请求前 force 压缩臂 D1**（`:842-876`，事件 `pi_driver_pre_request_compacted` / `pi_driver_context_invariant_rejected`）；**回合内 emergency 触发**（`transformContext` `:888-909`，事件 `context_emergency_compact`）；**溢出恢复臂**（`:944-965`，事件 `pi_driver_context_overflow_recovered`）。
- 常量/开关：`SUMMARY_PROMPT_OVERHEAD_TOKENS`（`:260`）、`MAX_SUMMARY_CHUNKS`（`:262`）、`COMPACTION_INSTRUCTIONS`（`:263`）、`CONTEXT_REQUEST_FRAMING_TOKENS`（`:290`）、`MIN_OUTPUT_BUDGET_TOKENS`（`:292`）、`CONTEXT_WINDOW_FLOOR_TOKENS`（`:294`）、`invariantReserveTokens`（`:306`）、`invariantLimitTokens`（`:311`）、`fixedRequestOverheadTokens`（`:316`）、`COMPACTION_CAPTURE_SUMMARY_ENV`（`:496`）、`compactionCaptureEnabled`（`:499`）、`newCompactionCorrelationId`（`:511`）。
- 专属测试/夹具：`packages/agent/compaction-window.test.ts`、`packages/agent/compaction-metrics.test.ts`、`packages/agent/compaction-product.test.ts`、`packages/agent/pi-driver-context-invariant.test.ts`、`scripts/eval/piopt/piopt-phase3.test.ts`、`scripts/eval/p3/compaction-proof.ts`（及 `scripts/eval/p3/p3c-session.ts` 内 INV/floor 断言）。
- 调用/配置路径：生产装配 `scripts/ask-runtime.ts:305`、`:475`（main/worker）两处 `createPiTurnDriver`；环境开关 `FSHINE_CAPTURE_COMPACTION_SUMMARY`；`LLM_CONTEXT_WINDOW` 窗口接线（`scripts/ask-context-window.test.ts` 守卫）。

**能否整体删**：删除面在 `pi-driver.ts` 内自洽（函数间仅内部互调），生产调用点仅 `ask-runtime.ts` 一处两行——**具备整体删而非并存的条件**。

**但 B 不成立，故不可整体删——「为什么删不掉」**：**请求前 force 压缩臂 D1（`pi-driver.ts:842-876`）必须保留**。§九十一 四问与本 run Q1 反向绊线一致：Pi 0.85.1 公开面无「发送前尺寸预判/拒绝」seam（`agent-harness.d.ts:520/531` 无 abort、`hooks.js:154-184` 抛错被吞），删除 D1 后必然超窗请求会被直接发出。其余臂（threshold 压缩、emergency、overflow recovery、摘要）Pi 原生可承担（§九十 S2/S3/S4/S5 已证），但 **D1 无 Pi 公开 seam 替代，读回 Pi 转录亦无法在续发前拦截**，故该臂与 `invariantReserveTokens`/`invariantLimitTokens`/`fixedRequestOverheadTokens`/`CONTEXT_REQUEST_FRAMING_TOKENS`/`MIN_OUTPUT_BUDGET_TOKENS`/`CONTEXT_WINDOW_FLOOR_TOKENS` 一并有存在理由，不能随整体删清单一并删除。

### 8. bHolds 判定

**`bHolds = false`（B 不成立）。** 首条请求维度**成立**（Pi 原生 Harness 承担全部压缩/溢出恢复；fshine 仅一处 `preRequestBudgetCheck` 且置于调 Pi 之前 → D1 超窗首消息被有界拒绝、0 provider 调用、0 超窗发送）。但**工具结果续发维度不成立**：首请求过检后工具返回超窗结果，Harness 发出的续发请求仍带超窗载荷被送出（`over-window=1`，挂抛错 hook 亦不可否决），且公开面无任何可中止请求的 seam。单处检查只覆盖每个 run 的首条请求，无法约束 run 内续发。故「Pi 负责全部压缩与溢出恢复」的定义不满足，D1 的 host 请求前防线仍承重，**替换 blocked**。

### 9. 未解决项

- **产品驱动真正切换未实施**：`createPiTurnDriver` 仍走低层 `Agent` + 自研 `transformContext`/`compactTranscriptWithPi`；本 run 未改 `packages/**`。切换可行性（能否以公开 `AgentHarness` 等价替换 `Agent`）尚待独立实验。
- **run 内续发请求的发送前防线**：若要求「首个请求之后、工具结果续发之前」也拒绝必然超窗请求，公开面**无 seam**；`transform_context` 虽每次请求触发但**只能替换、不能中止**，用它裁剪即落入 host 压缩（与原 B 定义冲突、且属复制 Pi 实现）。该缺口如何补（保留 D1 host 检查 / 另有设计）待 owner 裁定。
- **成本/影响面取向**：仍须 owner 统一裁定（§七十七 `RECOMMENDED_OPTION=A` 成本导向 vs §八十九 能力导向）。

### 10. 验收/回归（本会话实跑）

- `TMPDIR=~/.tmp npm run typecheck` → **exit 0**（`tsc --noEmit`，无输出）。
- `TMPDIR=~/.tmp npm test`（全量 vitest）→ `Test Files 3 failed | 83 passed (86)`、`Tests 3 failed | 868 passed | 3 todo (874)`。3 个失败文件为 `scripts/ask-replay.test.ts`、`scripts/ask-trace.test.ts`、`scripts/tasks.test.ts`，**与本 run 改动路径无关**（本 run 未改任何产品码/测试码），且**隔离复跑全绿**：`npx vitest run scripts/ask-replay.test.ts scripts/ask-trace.test.ts scripts/tasks.test.ts` → `Test Files 3 passed (3)`、`Tests 71 passed (71)`，`exit 0`——系全量并行下的 vitest-worker 超时 flaky（伴随 2 条 `Timeout calling "onTaskUpdate"`），非本 run 引入。**例数不减**：本 run 自 merge-base 未改任何测试文件。

**指针**：`scripts/eval/pi-native/pi-harness-driver.mjs`、`verify-pi-harness.mjs`、`OUTPUT-pi-harness.txt`（夹具/输出）；`node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts:485-604`、`dist/harness/hooks.js:108-184`、`dist/harness/runtime/drive/generation.js:54-147`（0.85.1 公开面）；`packages/agent/src/pi-driver.ts:260-965`（待删编排/D1 臂）；关联 §六十九、§七十、§七十七、§八十九、§九十、§九十一。

**状态：实验分支·待裁决。**

---

## 九十三、Pi 原生替换 · A 度量与 A/C 对照（2026-11-15，分支 `exp/pi-native-session-compaction`）状态：**实验分支·待裁决**

> 角色：**A 度量独立登记**（本 run 唯一台账写者）。承接 §八十九（阶段一 GO 条件式）、§九十（阶段二最小原型）、§九十一（D1 反向绊线独立复核）、§九十二（最小方案 B 验证，`bHolds=false`）。按 owner 步骤 7，本 run **只度量 A**（**接受 Pi 较弱有界失败**）并给 **A/C 对照**——**不做修复决定、不放宽 D1 判据**，裁定权归 owner。完整产出：`docs/product/exp-pi-native-A-metrics.md`（四组场景 + 四项 A 指标 + A/C 对照 + 建议 + 局限；本节为其登记摘要，冲突时以该文档为准）。

### 1. A 是什么（本 run 度量对象）

**A = 接受 Pi 较弱有界失败**：在**新 Pi 路径**上**移除 fshine 的单处请求前预算检查（D1）**，把压缩/溢出恢复全部交给 Pi 原生 Harness，接受「必然超窗的请求会被真实外发、随后有界失败」。故本度量夹具与 §九十二 的 `verify-pi-harness.mjs` **刻意不同**：后者度量**保留 D1 的最小 B**（首请求被 host 拒绝、0 外发）；本夹具度量**裸 Pi-Harness（无任何 fshine 检查）**——直接 `lane.prompt`，不设 `preRequestBudgetCheck`。夹具内**无任何 host 侧压缩/裁剪/拒绝**（`a-metrics.mjs:1-33` 自述边界；仅装配公开 `AgentHarness` + `CompactionSettings` + `RetryPolicy`，`a-metrics.mjs:150-158`）。假 provider **在派发前按窗口执法**（`est = ceil(JSON.stringify(messages).length/4)`，`a-metrics.mjs:88`），超窗时返回**真实 overflow 错误**（`stopReason:'error'` + `prompt is too long: … maximum context length`，`a-metrics.mjs:100-110`），该错误串命中 Pi `isContextOverflow`（`node_modules/@earendil-works/pi-ai/dist/utils/overflow.js:130-156`）→ 可触发 Pi 原生溢出恢复。**零真实模型**：仅假 `Models` / 假 `streamFn`，`baseUrl=http://localhost`，`streamDeferred`/`fetchDeferred` 均 `throw 'n/a'`。

### 2. 四组场景（窗口 8192 / 40000 / 128000）

| 组 | 场景 | 构造 | 是否发出 | 发出次数（总 / 超窗） | 是否最终有界失败 | `retry_scheduled` |
|---|---|---|---|---|---|---|
| **G1** | **首请求超窗**（裸 Pi-Harness，无 fshine 检查） | 单条巨型 user 消息（`'z'.repeat(W*6)`，≈1.5·W token，无可切分） | **是** | 1 / **1** | **是**（`run_end failed`，`assistant_error`） | **0** |
| **G2** | **工具结果导致的续发超窗** | 首请求 `'go'` 过检；assistant 调 `bigtool` 返回 ≈2·W token 结果；续发请求带该结果 | **是** | 2 / **1** | **是**（`run_end failed`，`assistant_error`） | **0** |
| **G3** | **可恢复溢出**（压缩后可行） | 首答即 overflow 错误；上下文可压缩，压缩后请求落入窗口 | **是** | 2 / **0** | 否——**成功完成**（`run_end completed`） | **0** |
| **G4** | **不可恢复溢出** | provider 对**每个**请求恒返 overflow 错误（硬上限/持续故障） | **是** | 2 / **0** | **是**（`run_end failed`，`assistant_error`） | **0** |

> 四组**全部收束**（`run_end` 均出现），**无一组无限重试**。逐组原始读数（`OUTPUT-a-metrics.txt`）：

| 组 @ 窗口 | sends | over | completeCalls | wastedOverTokens | totalPromptTokens | run_end | compaction_start→end |
|---|---|---|---|---|---|---|---|
| G1 @ 8192 | 1 | 1 | 1 | 12359 | 12359 | failed | threshold→completed |
| G1 @ 40000 | 1 | 1 | 1 | 60071 | 60071 | failed | threshold→completed |
| G1 @ 128000 | 1 | 1 | 1 | 192071 | 192071 | failed | threshold→completed |
| G2 @ 8192 | 2 | 1 | 1 | 16581 | 16602 | failed | threshold→completed |
| G2 @ 40000 | 2 | 1 | 1 | 80197 | 80218 | failed | threshold→completed |
| G2 @ 128000 | 2 | 1 | 1 | 256197 | 256218 | failed | threshold→completed |
| G3 @ 8192 | 2 | 0 | 1 | 0 | 99 | completed | overflow→completed |
| G3 @ 40000 | 2 | 0 | 1 | 0 | 99 | completed | overflow→completed |
| G3 @ 128000 | 2 | 0 | 1 | 0 | 99 | completed | overflow→completed |
| G4 @ 8192 | 2 | 0 | 1 | 0 | 8284 | failed | overflow→completed |
| G4 @ 40000 | 2 | 0 | 1 | 0 | 40092 | failed | overflow→completed |
| G4 @ 128000 | 2 | 0 | 1 | 0 | 128092 | failed | overflow→completed |

（`wastedOverTokens` = 被发出的**超窗**请求的 prompt token 之和，纯浪费；`completeCalls` = Pi 摘要模型调用次数。G1/G2 的 `run_end` 均为 `failed/assistant_error` 且 `retry_scheduled=0`。G1/G2 观察到的动作序列为 `threshold→completed→failed`：单条巨型消息在 checkpoint 被判超阈值而压缩，但**当前待发 prompt 无法被该压缩消解**，请求仍超窗外发 → provider 报 overflow → 无可用恢复边界 → 有界失败。本 run 只报告公开面可观察的动作序列与最终 `failed`，**不对 Pi 内部 `prepareOverflowCompaction` 分支下断言**，见 §6 局限。）

### 3. 四项 A 指标

**指标① 实际恢复成功率**：**G3（可恢复溢出）3/3 = 100%**——8192/40000/128000 三窗口均 `compaction_start reason=overflow` → `compaction_end completed` → `run_end completed`；恢复后请求 `over=0`。G1/G2/G4 按场景定义**不属于「可恢复」**（G1/G2 当前 prompt 不可被压缩消解；G4 为持续故障），不计入分母。

**指标② 失败上界**：

| 场景 | 最大总发出次数 | 最大超窗发出次数 | 是否收束 | `retry_scheduled` |
|---|---|---|---|---|
| G1（首请求超窗，裸） | **1** | **1** | 是（`run_end failed`） | **0** |
| G2（工具结果续发超窗） | **2**（1 过检 + 1 超窗） | **1** | 是（`run_end failed`） | **0** |
| G4（持续不可恢复溢出） | **2** | **0** | 是（`run_end failed`） | **0** |

**上界结论**：每次超窗事故**至多 1 次必然超窗请求被外发**；单次 run **总发出次数 ≤ 2**；**全部收束**；**`retry_scheduled` 恒为 0**，Pi 摘要调用 `completeCalls ≤ 1`（G3/G4），**无无界重试**——Pi 的失败**有界**。

**指标③ 额外调用成本**（因外发必然超窗请求而多花）：

| 场景 | 额外 stream 调用 | 额外 prompt token（`wastedOverTokens`） | 额外摘要调用 |
|---|---|---|---|
| G1 @8192 / 40k / 128k | **+1** | 12359 / 60071 / 192071（≈**1.5·W**） | +1 |
| G2 @8192 / 40k / 128k | **+1** | 16581 / 80197 / 256197（≈**2·W**） | +1 |
| G3 / G4 | 0 超窗外发 | 0 | 恢复/失败各 +1 |

结论：接受 A 后，**每次超窗事故的额外成本 = 1 次必然超窗请求（≈1.5·W–2·W prompt token）+ 1 次 Pi 摘要调用**，与窗口线性；可恢复场景（G3）无额外超窗成本。

**指标④ 业务副作用**：

| 维度 | 观察 |
|---|---|
| **回合是否完成** | G1/G2/G4 = **否**（`run_end failed`）；G3 = **是**（`completed`）。超窗回合**不完成**且以失败结束。 |
| **回复是否降级 / 空答** | **否**——失败路径返回**显式错误**（`run_end failed/assistant_error`），**未观察到静默降级或空答复**（未把失败伪装成成功交付）。 |
| **是否重复执行任务** | **否**——G2 中 `toolExecutions=1`（全窗口），工具在超窗事故前后**未重复执行**。 |
| **是否越权** | **本夹具未触及授权路径**——只装配一个仓内假工具，无 host 权限/实体门/执行层授权面被激活。故「越权」在 A 路径上**本 run 未观测到、也未构造测量**（不适用/未测，**非**「已证明无」）。 |

### 4. A / C 对照表（供 owner 裁定；本节不替 owner 裁）

- **A = 接受 Pi 较弱有界失败**：移除 fshine 单处请求前检查（D1），接受「必然超窗请求会被真实外发、随后有界失败」。
- **C = 判 Pi 原生在安全责任上不满足、停实验分支保住现状**：保留 D1 host 请求前检查，从不外发必然超窗请求。

| 维度 | A（接受较弱有界失败） | C（停实验分支、保现状） |
|---|---|---|
| **安全姿态** | **放宽**「从不外发必然超窗请求」：每次事故允许 **1 次**必然超窗请求被发出 | **不放松**：发送前 host 侧有界拒绝，**0** 外发必然超窗请求 |
| **恢复行为** | Pi 原生阈值压缩 + 溢出恢复；**可压缩场景可恢复完成（G3 3/3）** | 现状 fshine 压缩编排 + Pi；恢复路径不变 |
| **失败上界** | **有界**：总发出 ≤2、超窗外发 ≤1、`retry_scheduled=0`、必收束 | 更严：发送前拒绝（0 外发） |
| **额外成本** | 每次事故 **+1 超窗请求（≈1.5·W–2·W prompt token）+1 摘要调用** | **0** 超窗浪费；一次拒绝（无 provider 调用） |
| **删除可行性** | D1 host 请求前检查臂**可删**，删除面自包含于 `packages/agent/src/pi-driver.ts`（§九十二 §7 清单） | D1 **不可删**；替换 blocked（§九十一/§九十二） |
| **业务副作用** | 超窗回合**失败**（非静默降级/空答）；**任务不重复执行**；可恢复回合正常完成 | 无超窗外发；拒绝即失败 |

### 5. 我的建议（**建议**，由 owner 裁定）

> 明确标注为建议；本 run **不做修复决定、不放宽 D1 判据**，裁定权归 owner。

**度量支持的事实**：在裸 Pi 路径上，Pi 的失败**确实有界**——每次超窗事故至多 1 次超窗外发、单 run 总发出 ≤2、`retry_scheduled=0`、必收束；**无静默降级、无空答、无任务重复执行**；接受 A 的**代价确定且可量化**（每次事故 1 次 ≈1.5·W–2·W token 的浪费请求 + 1 次摘要调用）。

**我的建议（择一，供裁）**：
- 若 owner 的风险容忍度接受「每次超窗事故浪费 1 次必然超窗请求、但失败有界且不重复执行任务」——则 **A 在本夹具口径下是可行选项**；A 把「必然超窗请求永不外发」这条安全要求，换成「至多 1 次外发 + 有界失败」。
- 若「必然超窗请求一发都不可外发」被列为**不可放宽的安全责任**（§九十一/§九十二 的 D1 立场）——则 **C 保现状**仍是唯一满足该责任者，A 的安全姿态与之**直接冲突**。

**决定性、只能由 owner 回答的问题**：**「允许 1 次必然超窗请求被外发」是否可接受为安全责任？** 这是风险取向裁定，超出本度量夹具可达的范围——本节不做此裁定。

（关联事实，须与 A 绑定处理：§九十二 已证**工具结果续发维度**在公开面无发送前防线；A 之下该缺口同样存在，G2 已在裸路径上复现「续发超窗被外发」且**无公开 seam 可中止**。此点不改变四组读数，仅作 owner 裁定 A 时的关联事实。）

### 6. 局限（必须随读数一起引用）

- **窗口**：仅报 **8192 / 40000 / 128000**。其他窗口未测。
- **零真实模型**：全过程假 `Models` + 假 `streamFn`；**真实模型、真实 provider 未跑**，Pi 对真实 provider 错误串的 `isContextOverflow` 分类、真实 tokenizer 计数、真实成本均**未验证**。
- **不外推**：以上数字是**确定性夹具读数**，**不得外推**为真实模型行为、真实成本或真实 provider 的错误分类率。
- **未做修复决定、未放宽 D1 判据**：本节不改变 `docs/decision-log.md` 的任何判据；§九十二 `bHolds=false`（工具结果续发维度不成立）与 §九十一（D1 不可删）的结论**未被本 run 触碰**。
- **内部机制不越界**：本 run 只报告公开面可观察的动作序列与事件（`run_end` / `compaction_*` / `retry_scheduled` / provider 调用日志），**不复制 Pi 源码、不依赖未导出实现、不对 Pi 内部分支下断言**。
- **夹具差异**：本夹具（裸 Harness、provider 执法窗口）与 §九十二 `verify-pi-harness.mjs`（保留 D1、旁路对照用「照单全收」假 provider）**刻意不同**；两者读数不可互相替代。

### 7. 复跑与验收（本会话实跑）

```
cd ~/projects/fshine-agent-exp-pi-session
TMPDIR=~/.tmp node scripts/eval/pi-native/a-metrics.mjs   # exit 0，33 [PASS] / 0 [FAIL]，failures=0
```

- **确定性**：两次连跑（`EXIT1=0`、`EXIT2=0`）输出 `diff` **逐字相同**；与已提交 `scripts/eval/pi-native/OUTPUT-a-metrics.txt` `diff` **零差异**。
- 度量期间**未改产品码**（`packages/**`、`apps/**` 未动），`.runtime` 未 `git add`，未升级 Pi（只读锁 `@earendil-works/pi-agent-core@0.85.1`）。

**指针**：`scripts/eval/pi-native/a-metrics.mjs`（度量夹具）、`scripts/eval/pi-native/OUTPUT-a-metrics.txt`（归档原始输出）、`docs/product/exp-pi-native-A-metrics.md`（完整产出）；`node_modules/@earendil-works/pi-ai/dist/utils/overflow.js:130-156`（0.85.1 公开面）；`packages/agent/src/pi-driver.ts:842-876`（D1 臂，A 之下可删、C 之下不可删）；关联 §九十一、§九十二。

**状态：实验分支·待裁决。** 待 owner 裁 A（接受较弱有界失败）或 C（保现状）。

---

## 九十四、Pi 原生替换 · 阶段三最终替换（A 裁决后完整替换）（2026-11-15，分支 `exp/pi-native-session-compaction`）状态：**实验分支·待裁决**

> 角色：**集成 / 台账登记**（本 run 唯一台账写者）。承接 §八十九（阶段一 GO 条件式）、§九十（阶段二最小原型）、§九十一（D1 反向绊线独立复核）、§九十二（最小 B 验证 `bHolds=false`）、§九十三（A 度量与 A/C 对照）。**owner 裁决 A（2026-11-15，已生效）**：接受 Pi「请求 → Overflow Recovery → 有界恢复/失败」，**撤销**「新架构必须不发送任何必然超窗请求」；**旧 D1 绊线 FAIL 记录保留、不得事后修改**。据此，阶段三把**产品驱动真正切换到 Pi 原生**并**整体删除 fshine 自研压缩编排（含 D1 臂）**。本登记对应 HEAD `78c22d0`（实现）+ `7741752`（A 口径冻结）；A 验收口径文档为 `docs/product/exp-pi-native-A-acceptance.md`。版本口径：只读锁 **`@earendil-works/pi-agent-core@0.85.1`（不升级）**。

### 1. 工作区核验（本会话实跑）

- `git -C ~/projects/fshine-agent-exp-pi-session rev-parse --show-toplevel` = `.../fshine-agent-exp-pi-session`（**≠ 主仓** `.../fshine-agent`）；`rev-parse --abbrev-ref HEAD` = `exp/pi-native-session-compaction`；登记前 `git status --short` 空。**通过。**

### 2. A 口径冻结（真实模型前）

`docs/product/exp-pi-native-A-acceptance.md` **已冻结（真实模型前）**：§1 A 验收口径（**A-1** 每事件至多 1 次 over-window 发射 / **A-2** 有界收敛（总发出 ≤ 2、必收束）/ **A-3** `retry_scheduled = 0`，三者须同时成立）；§2 **适用范围限制**（`≤1 次/事件` **仅为当前假模型场景观测值，不是所有真实业务回合的普适上界**，须按真实 Pi 生命周期复核后冻结）；§3 七项可靠性判据；§4 D1 FAIL 记录保留；§6 局限；§7 实施期裁定补充（`piCompactionSettings` 属 **Pi API 契约**，非第二套机制）。**零真实模型**：全部读数为假 `Models`/假 `streamFn` 夹具，`baseURL=http://127.0.0.1:9`。

### 3. Pi 唯一转录（本会话读码）

- `packages/agent/src/pi-driver.ts:287-298` `createPiTurnDriver` 改用公开 `AgentHarness.create` + `MemorySessionRepo`（`:285-286`）；转录、压缩触发、压缩执行、摘要、尾段保留、溢出恢复**全部交 Pi**（`compaction`/`retry`/`tools`）。业务层只读投影 `projectTranscript`（`:426-429`）。
- **唯一** fshine→Pi 交互为窗口派生的 `CompactionSettings`（`piCompactionSettings`，`pi-driver.ts:93`，纯配置、无决策/安全 math）。
- 事件监听仅保留可归因日志：`retry_scheduled`→`pi_driver_retry_scheduled`（`:305-314`）、`run_end`→`pi_driver_model_error`（`:315-319`）。**不再有** host 侧请求前压缩臂、emergency 触发、溢出恢复臂。

### 4. 删除清单与净行数（含 D1）（本会话实跑核验）

- 提交读数（`git show --stat HEAD`）：**30 files changed, 911 insertions(+), 2381 deletions(-)**，净 **−1470** 行。
- `packages/agent/src/pi-driver.ts`：**1256 → 621 行**（`git show HEAD~1:packages/agent/src/pi-driver.ts | wc -l` = 1256；`wc -l` = 621；净 **−635**）。
- **整体删除**（生产函数/常量/臂，与 §九十二 §7 清单逐项一致；已确认符号在 `pi-driver.ts` 零出现）：`compactTranscriptWithPi` / `compactionSettingsFor` / `splitForCompaction`（含 `takeSummaryChunk` / `clampMessageForSummary`）/ `summarizeWithinWindow` / `trimToBudget` / `degradeByDropping` / `isContextOverflowError`；**请求前 force 压缩臂 D1**、回合内 emergency 触发、溢出恢复臂；常量 `SUMMARY_PROMPT_OVERHEAD_TOKENS` / `MAX_SUMMARY_CHUNKS` / `COMPACTION_INSTRUCTIONS` / `CONTEXT_REQUEST_FRAMING_TOKENS` / `MIN_OUTPUT_BUDGET_TOKENS` / `CONTEXT_WINDOW_FLOOR_TOKENS` / `invariantReserveTokens` / `invariantLimitTokens` / `fixedRequestOverheadTokens` / `COMPACTION_CAPTURE_SUMMARY_ENV` 等。
- 契约：`TurnDriver.compact?()` 方法自 `packages/agent/src/driver-contract.ts:42-45` 删除。
- 专属测试/夹具**整体删除**（文件已不存在，本会话 `test -e` 确认）：`compaction-window.test.ts`（−193）/ `compaction-metrics.test.ts`（−225）/ `compaction-product.test.ts`（−91）/ `pi-driver-context-invariant.test.ts`（−231）/ `scripts/eval/piopt/piopt-phase3.test.ts`（−431）/ `scripts/eval/p3/compaction-proof.ts`（−70）；`experiments.test.ts` 移除 host 压缩用例（−47）。
- **无两套并存**：`pi-native-tripwire.test.ts` 的 forbidden-symbol 静态守卫（§6）禁止任何已删符号/事件回潮。

### 5. 业务边界保持（本会话核验）

- `git diff --name-only HEAD~1 HEAD` 改动面**不含** `packages/contracts/src/execution-contract.ts`、Worker 系统提示词、任务账本（task-registry 源码）、权限体系——**未触碰**（`grep -c 'execution-contract\|worker'` = 0）。
- `packages/agent/src/pi-driver.ts` 保留：`toAgentTool`（工具适配，`:555`）、`createProviderToolNameMap`（`:503`）、服务端确定性回复 `synthesizeAssistant`（`:417-418`）、取消/截止 abort 合成（`:262-274`）、空回复/失败归因（`:338-376`）、单次 `final_text_nudge`（`:380-399`）——**工具调用/结果配对、取消/通知/失败语义不变**。
- 其余改动文件为**测试/装配/评测脚本**（`apps/server/server.test.ts`、多个 `*.test.ts`、`scripts/eval/**`），非业务模块。

### 6. T1–T12 与反向绊线（本会话实跑，窗口 8192 / 40000 / 128000）

- `packages/agent/pi-native-compaction.test.ts`（**32 tests 通过**）：**T1** 短对话不无故压缩；**T2** 达阈 Pi 自动压缩（摘要进转录）；**T3** 长历史连续压缩无零收益循环；**T4** 大型工具结果不破坏 tool_call/result 配对 + 工具恰好执行一次；**T5** 当前回合超预算——**按 A 口径**有界收束、总发出 ≤ 3、允许一次必然超窗外发（断言 `observed.some(over)`）；**T6** 摘要失败原生有界；**T7** Overflow Recovery 恢复并完成；**T8** 压缩后找回重要信息（对象/游标/最近消息）；**T9** 多 Session 并行无跨会话污染；**T10** 多 principal 无串线；**T11** 压缩后仍能经 Task Registry 找回真实任务结果；**T12** 连续五回合生命周期稳定不丢上下文。每项**均含真实断言**（非占位）。
- `packages/agent/pi-native-tripwire.test.ts`（**20 tests 通过**）：**A** 禁回潮静态守卫（16 个已删符号在 `pi-driver.ts` 零出现）；**B** 配置适配承重（`compaction.enabled=false` → Pi 不压缩；`piCompactionSettings(8192)` → 压缩 `completed`）；**C** A 口径 `retry_scheduled=0`（必然超窗场景不得记录 `pi_driver_retry_scheduled`）。**故意破坏（把符号/臂加回）即红。**

### 7. tsc · unit 读数（本会话实跑）

```
cd ~/projects/fshine-agent-exp-pi-session
TMPDIR=~/.tmp npm run typecheck   # exit 0（tsc --noEmit，无输出）
TMPDIR=~/.tmp npm test            # exit 0：Test Files 83 passed (83)；Tests 874 passed (874)
```

- typecheck **exit 0**；全量 vitest **83 文件 / 874 用例全绿、0 失败**（较 §九十二 874 总例数**不减**；组成变化＝退役仅验证已删机制的用例、新增 T1–T12 与反向绊线）。

### 8. 七项可靠性判据（A 口径；当前证据状态）

| # | 判据 | 证据（本会话） | 状态 |
|---|---|---|---|
| ① | 溢出恢复/失败**有界** | T5/T7 + a-metrics G1–G4 收束、总发出 ≤ 2 | 已证（假模型夹具） |
| ② | **无无限重试、无零收益摘要循环** | T3/T6 有界；tripwire C `retry_scheduled=0` | 已证（假模型夹具） |
| ③ | **无未经授权的工具执行** | 授权路径未在本夹具激活 | **本夹具未测** |
| ④ | **不因模型重试重复执行业务操作** | T4 `executions=['lookup']` | 已证（假模型夹具） |
| ⑤ | **无虚假完成/取消回执** | 失败→显式错误（`pi_driver_model_error`/空回复归因）；取消回执未构造 | 部分覆盖 |
| ⑥ | **无跨 principal、跨 Session 信息泄漏** | T9/T10 隔离断言通过 | 已证（假模型夹具） |
| ⑦ | **压缩不破坏工具调用与结果对应** | T4 显式 toolCall↔toolResult 配对断言 | 已证（假模型夹具） |

### 9. D1 FAIL 记录保留（不改）

- §九十一（`docs/decision-log.md:2452-2505`）D1 反向绊线 FAIL 记录**保留、未改**；原始 FAIL 行、三夹具（`tripwire-d1*.mjs`）与结论「D1 不可删 / Pi 公开面无发送前 seam」作为**历史判据并存**。
- `docs/product/exp-pi-native-A-acceptance.md` §4 登记该 FAIL 为「**已接受的风险姿态**」，**不删除、不改写、不通过**；§九十二 `bHolds=false`（工具结果续发维度不成立）同样保留、未被 A 口径触及。

### 10. 未跑真实模型（明示）

- 全部读数来自假 `Models` + 假 `streamFn`；**真实模型、真实 provider 未跑**。§2 适用范围（`≤1 次/事件` 普适性）**未冻结**，待真实 Pi 生命周期复核。
- **不外推**为真实模型行为、真实成本或真实 provider 的错误分类率。

### 11. 残余观察点（如实登记；非机制、不影响 A 验收；未在本 run 处理）

- 本 run **只删产品机制**；部分**评测观察脚本/夹具**仍以字符串形式列出已删事件名（`context_emergency_compact` / `context_compacted` / `context_compact_failed` / `pi_driver_context_overflow_recovered` / `pi_driver_pre_request_compacted`）作为**观测标签**（`scripts/eval/p3/p3*-session.ts`、`scripts/eval/business-e2e/experiments/{judge,executor,cases}.ts`；`experiments.test.ts` 以 `console.warn` 合成该事件测判分逻辑）。
- 这些引用**不再由 `pi-driver.ts` 发出**（该事件已随机制删除），**不构成第二套压缩机制**、不影响 A 验收；作为**后续清理项**登记（本 run 未处理）。

**指针**：`packages/agent/src/pi-driver.ts:246-420,426-429`（Pi 原生装配 + 只读投影）、`packages/agent/pi-native-compaction.test.ts`、`packages/agent/pi-native-tripwire.test.ts`、`packages/agent/src/driver-contract.ts:42-45`、`docs/product/exp-pi-native-A-acceptance.md`；关联 §八十九–§九十三。

**状态：实验分支·待裁决。**（A 口径已冻结于真实模型前；待真实 Pi 生命周期复核适用范围。）

---
