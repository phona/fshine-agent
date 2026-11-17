# 跨重启幂等：设计档与可行性探针

- 性质：**设计档**。只审计现状、给出设计与探针，**不实施**；未改任何产品代码、契约类型、底账 schema 或默认行为。
- 基线：`arch/integration` @ `23ae585`（本文所有 `文件:行号` 均按该提交的只读事实逐条复核）。
- 除本文件外，唯一新增物：只读探针脚本 `scripts/probes/idempotency-cross-restart-probe.ts`（临时目录内跑，仓库工作区零写入）。
- 结论先行：**宿主今天没有跨重启的“入站请求身份 → 原回合/原操作”持久绑定**。持久化的操作结果存在，但新进程里的渠道重投没有原身份去读它；`run_js` 甚至没有持久结果记录。因此重启后同一 `messageId` 会作为新回合再执行一次。探针已复现（§2.3）。

---

## 0. 一句话结论

宿主能保证的是：

> **同一进程内且有界窗口（1024 条）未淘汰时**，同一 `messageId` 至多产生一次回执；**同一进程内**，Pi 原生重试的同一 `run_js` 调用至多执行一次；**同一进程内**，同一 `dispatchKey` 的重放窗口至多自动执行一次。

宿主**不能**保证：

> 进程重启后，渠道重投同一 `messageId` 不会被当成新回合再执行；也不能保证外部业务效果 exactly-once。

缺的不是“随机数不够”或“key 不稳定”，而是**一条把渠道请求身份（`messageId`）持久化到原回合/原操作的身份链**。没有这条链，持久化的 `operations.outcome_json` 在重启后不可寻址。

---

## 1. 现状到底保证了什么

### 1.1 同回合重试：进程内 memo（覆盖到「一个 `send()` 内」）

Main 的 `run_js` 幂等是**回合内 Map**：

- key = `turnNo + sha256(code) + 排序后的 inputs`，命中即回放工具结果，不再调用执行器：`packages/agent/src/execution-runtime.ts:938-942`、`:968`。
- Map 在 `send()` 开始时创建、随 `send()` 结束丢弃：`packages/agent/src/execution-runtime.ts:1479`；回合号是进程内计数器：`:775`、`:1485-1486`。
- 设计理由写得很直白：**Pi 原生重试不产生新 `send()`**，所以同一回合内的重试同键命中；跨重启不保证：`:917-921`。
- Worker 侧同形状，但是**委派级** Map（随一次 `delegate` 创建、随委派丢弃）：`packages/agent/src/execution-runtime.ts:1025-1027`、`:1041-1042`、`:1066`、`:1369`。

Pi 原生重试事件（`compaction_end.willRetry` / `auto_retry_start` / `assistant message_end('error')`）由驱动转述给宿主：`packages/agent/src/pi-driver.ts:466-503`。这段只负责“开重放窗口”，不负责跨 `send()` 复用结果。

已有确定性测试证明“同回合两次调用只执行一次”：
`packages/agent/runtime-run-js.test.ts:332-344`、`packages/agent/runtime-worker-run-js.test.ts:407-426`。

**覆盖**：Pi 原生重试/压缩恢复在同一 `send()` 内重发同一工具调用；Main 与 Worker 各自作用域内。
**不覆盖**：新 `send()`（哪怕同一进程）、进程重启、模型改 code/inputs、跨进程。

### 1.2 同进程渠道重投：server 的内存 Map（覆盖到「一个 server 进程内」）

渠道消息的 `messageId` 在契约里存在：`packages/contracts/src/channel.ts:88`。企微适配器从回调 `msgid` 取值并要求非空：`packages/channel-wecom/src/adapter.ts:493-494`，并写进 `IncomingChannelMessage.messageId`：`:574`。

server 的幂等实现是**闭包内内存 Map**：

- 有界 FIFO 上限 1024：`apps/server/server.ts:70`、`:337-341`。
- 查重键 = `principalId \0 sessionId \0 messageId`；`messageId` 为空则不做去重：`apps/server/server.ts:474-477`。
- 命中即回放同一 Promise 的回执，零新回合、零新任务、零新执行：`apps/server/server.ts:477-480`。
- 处理失败时删除缓存，允许渠道重投重试：`apps/server/server.ts:522`、`:626`。
- 成功后写入缓存：`apps/server/server.ts:526`、`:630`。
- `close()` 只清会话/底账/持久化句柄，`messageReplies` 随 server 实例一起消失：`apps/server/server.ts:639-647`。

注意两个边界：
1. FIFO 超过 1024 条会淘汰最旧条目；被淘汰的 `messageId` 即使在同一进程内再次到达也会被当成新消息（`apps/server/server.ts:343-347`）。
2. `messageId` 为空时完全不去重（`:474-476`）；企微适配器不会发空 `msgid`，但直接调用 `handler` 的路径没有这层保证。

**覆盖**：单进程内同一 `messageId` 的回执重放（包括处理中并发重投——两个调用共享同一 Promise）。
**不覆盖**：跨重启、多实例、进程崩溃后重投、超过 1024 条后的旧消息。

历史台账里的 `D-119`（`docs/debt-ledger.md:1341`）记录的是 Minimal Reset 之前的 `findByWecomMessageId` / `task_runs` 基础设施；当前树上不存在这些符号（本次执行 `grep -rn "findByWecomMessageId\|task_runs" --include="*.ts" packages apps scripts` 零命中），不能把那条“已关”当作现行保障引用。现行保障就是 `server.ts` 的内存 Map。

### 1.3 U3 `dispatchKey`：持久化的“操作身份”，不是“请求身份”

U3 的 `operations` 账本确实持久化“key → 结果映射”：

- 表：`dispatch_key` 主键 + `UNIQUE(scope_key, op_seq)` + `outcome_json`：`packages/core/src/task-store.ts:343-357`。
- 明确**没有**任何以 `(operation, args)` 为键的唯一约束：`packages/core/src/task-store.ts:125-127`。
- 认领结构不接收 `args`，因此“按参数文本去重”没有代码路径：`packages/agent/src/task-registry.ts:433-449`。
- 认领 →（仅首次铸造）执行 → 落定；**先落库再调用**：`packages/agent/src/execution-runtime.ts:687`、`:719`、`:723`、`:737`。调用中断/无回执落 `unknown`（缺省 `executeThrows='unknown'`；`task_run` 的已知失败走 `propagate` 落 `failed`）：`:730`。
- 重放/进行中/无法证明/冲突分别走 `replayed` / `in_progress` / `unresolved` / `conflict`：`packages/agent/src/execution-runtime.ts:698-716`。
- 认领决策的纯函数：`packages/agent/src/task-registry.ts:491-519`。关键一条：**没有重放窗口时一律铸造新行**（`:506`）；只有显式 `dispatchKey` 或 `replayWindow` 才去读旧行（`packages/agent/src/task-registry-sqlite.ts:331-335`）。
- 旧行跨关库重开仍可读回，且按窗口重放会命中同一行：`packages/agent/dispatch-key-registry.test.ts:291-315`。

作用域是两种：

- Worker 的 `execute_operation`：`task:<taskId>`：`packages/agent/src/execution-runtime.ts:1197`。
- Main 的 `task_run`：`turn:<sessionId>:<turnNo>`：`packages/agent/src/execution-runtime.ts:1486`、`:1527-1528`。

关键限制：`turnNo` 是**进程内**计数器（`:775`、`:1485`）。重启后它从 0 重新开始；但新回合不会传 `replayWindow`，所以 `decideOperationClaim` 走“无窗口 → 铸造”（`packages/agent/src/task-registry.ts:506`），**不会**误读上一个进程的旧行；反过来说，它也**不会**找回旧行。探针 B 直接演示了这一点（§2.3）。

设计文档已经明确 U3 不是 Exactly Once，只承诺“同一身份至多一次自动执行 + 结果未知可核对”：`docs/product/pi-152-dispatch-key-design.md:16`、`:224-226`；重启/新进程不自动重绑：同文 `:243`、`:298`（L4/L5）；`task-registry.ts:42-45` 同口径。

**覆盖**：同一进程内，Pi 恢复窗口内同一逻辑操作的重放；先落库再调用；进行中不并发执行；结果未知不自动重放；跨关库可按显式 `dispatchKey` / 原窗口读回。
**不覆盖**：跨重启的渠道重投（没有窗口、没有原 `dispatchKey`）、新回合重发同一句话、模型把一笔意图拆成两笔调用、`run_js`。

### 1.4 后台任务重启恢复（相邻能力，不等于消息幂等）

`background` 模式下，任务底账有租约与恢复策略：

- 启动 `pump()`：`apps/server/server.ts:238`。
- 每轮先 `expireLeases`；过期 `running` → `result_unknown`，不自动重放；`queued` 重新认领：`packages/agent/src/task-runner.ts:21-23`、`:347-348`、`:366`。
- 过期 `running` 落 `failed + reason=result_unknown` 后是终态，不再被认领：`packages/agent/src/task-registry.ts:25-26`；跨重启测试：`packages/agent/task-registry-contract.test.ts:512-527`。

这保证的是“**同一个 taskId** 在重启后不会被自动重跑”。它**不**保证“同一条渠道消息重投不会创建第二个 taskId”：任务表没有 `messageId`/来源消息列（`packages/core/src/task-store.ts:310-328`；该表刻意不迁 `originMessage`，`:69`），重投走 server 的新回合，会新建任务。`background` 与 `inline` 都一样，只是 `background` 的旧任务会以 `result_unknown` 留下可查事实。

### 1.5 覆盖表

| 机制 | 身份键 | 生命周期 | 覆盖到哪一步 | 不覆盖 |
| --- | --- | --- | --- | --- |
| 同回合 `run_js` memo | `turnNo + sha256(code) + inputs` | 一个 `send()`；Worker 为一个委派 | Pi 原生重试同回合命中，执行器只跑一次（测试已锁） | 新 `send()`、重启、换 code/inputs、跨进程 |
| server `messageId` 去重 | `principal + session + messageId` | 进程内存，FIFO 1024 | 同进程重投回放回执；处理中并发重投共享 Promise | 跨重启、多实例、崩溃后、超过 1024 条 |
| U3 `operations` 认领 | `dk_<scope>:<opSeq>`；`scope=task:<id>` 或 `turn:<session>:<turnNo>` | SQLite，跨重启存在 | 同进程恢复窗口重放；先落库再调用；`claimed/unknown` 不自动重放 | 重启后重投（无窗口 → 新 key）、新回合同文、`run_js`、模型拆单 |
| 后台任务重启恢复 | `task_id` + 租约 | SQLite | `queued` 重领；过期 `running` → `result_unknown`；`completed` 不重跑 | 不绑定 `messageId`；重投会新建任务；inline 无租约恢复 |

---

## 2. 「跨重启幂等」缺的具体是哪一环

### 2.1 不是“没有 key→结果映射”，而是“重投时找不到原 run”

分开看两项：

1. **契约操作的 key→结果映射：已有。**
   `operations` 表持久化 `dispatch_key`、`scope_key`、`status`、`outcome_json`（`packages/core/src/task-store.ts:343-357`）。关库重开后按 `dispatchKey` 或原 `replayWindow` 可读回（`packages/agent/dispatch-key-registry.test.ts:291-315`）。

2. **重投时找不到原 run：这是缺的那一环。**
   - `messageId` 只存在于 server 的内存 Map（`apps/server/server.ts:341`），没有落库。
   - `tasks` 表没有 `message_id` / 来源消息列（`packages/core/src/task-store.ts:310-328`）。
   - `operations` 的 `scope_key` 是 `task:<taskId>` 或 `turn:<sessionId>:<turnNo>`（`packages/agent/src/execution-runtime.ts:1197`、`:1486`），没有 `messageId`。
   - `turnNo` 是进程内计数器（`packages/agent/src/execution-runtime.ts:775`），不持久化；即使持久化，也没有“这条消息对应这个 turnNo”的映射。
   - 会话持久化只存 Pi 原生 message，不存 `messageId`/turn 元数据（`packages/agent/src/session-persistence.ts:16-23`、`:54-62`）。

   所以跨重启后，新进程既不知道“这条 `messageId` 上次跑到了哪个 turn”，也没有 `dispatchKey`/`replayWindow` 去 `claimOperation`。探针 B 的输出正是：**outcome 持久存在，但新回合不传身份 → 铸造新 key**。

3. **`run_js` 连 key→结果映射都没有。**
   - Main 的 `runJsInTurn` 全程没有 `registry.noteExecution` / `claimOperation`，只有进程内 memo（`packages/agent/src/execution-runtime.ts:926-975`）。
   - Worker 的 `run_js` 在**执行之后**才写一条执行事实，`requestId=runjs_<runId>`、`dispatchKey=runjs:<runId>`（`packages/agent/src/execution-runtime.ts:1072-1090`）；它从不在此前读回，`runId` 也是执行器返回后才有的（`output.audit.runId`）。这不是可认领的持久身份，只是一条事后审计。

### 2.2 最小复现失败的时序

以 `inline` 模式为例（`background` 也一样，只是多一条任务行）：

1. 渠道送来 `messageId=M`，server 内存 Map 无记录；回合开始。
2. 回合内 Main 调 `run_js`，脚本产生外部副作用（写平台、发消息、落文件等）。
3. 进程在回复送达/回合收尾前死亡。此时：
   - Main `run_js` 没有任何先落库的行（§2.1-3）；
   - `operations` 里可能没有任何代表这笔 `run_js` 的行；
   - `messageId=M` 没有被持久记录。
4. 渠道按同一 `M` 重投；新进程的 `messageReplies` 是空的（`apps/server/server.ts:341`），`turnNo` 从 0 起，正常新回合不传 `replayWindow`（§1.3），于是**重新执行 `run_js`**。
5. 用户拿到的是第二次执行的结果；第一次副作用无人认领，也没有“待核对”提示。

如果回合已经正常完成、只是进程在回复后重启，探针 A 也证明同一 `M` 会再执行一次——这甚至不需要崩溃窗口。

### 2.3 探针（只读，可复跑）

脚本：`scripts/probes/idempotency-cross-restart-probe.ts`

运行：

```sh
export TMPDIR="${TMPDIR:-$HOME/.tmp}"
node --import tsx scripts/probes/idempotency-cross-restart-probe.ts
```

它做两件事，全部在临时目录、用脚本化驱动与计数执行器，不触网、不碰真实模型/平台：

- **场景 A（server 真实装配）**：用 `createServer` + 真实 `handler`；注入脚本化 `TurnDriver`（每回合调一次 `run_js`）和计数 `RunJsExecutor`（外部副作用替身）。
  - 同进程同一 `messageId` 连投两次：第二次命中内存 Map，效果计数不变；
  - `close()` 后同 `dbPath` 重建 server，再投同一 `messageId`：效果计数 +1，`message_done` 事件 +1。
- **场景 B（真实 SQLite Task Registry）**：先铸造并落定一笔 `task_run` 操作；关库重开后：
  - 带原 `replayWindow` 认领 → `replayed`，读回同一 `dispatchKey`；
  - 不带窗口（= 重启后新回合的常态）认领 → `minted`，新 `dispatchKey`。

本次运行输出（原样）：

```json
{
  "probe": "idempotency-cross-restart",
  "scenarioA_messageRedelivery": {
    "sameMessageId": "probe-msg-same-identity",
    "sameTurnInProcess": {
      "firstReply": "已处理。",
      "duplicateReply": "已处理。",
      "effectsAfterFirst": 1,
      "effectsAfterDuplicate": 1,
      "newEffectsFromDuplicate": 0,
      "duplicateReplayedEvents": 1
    },
    "afterRestart": {
      "reply": "已处理。",
      "messageDoneEventsBeforeRestart": 1,
      "messageDoneEventsAfterRestart": 2,
      "effectsBeforeRestart": 1,
      "effectsAfterRestartRedelivery": 2,
      "newEffectsFromRestartRedelivery": 1,
      "runIds": [
        "run_probe_1",
        "run_probe_2"
      ]
    },
    "conclusion": "重启后同一 messageId 重投：进程内去重缓存已丢，整回合再次执行（反例成立）"
  },
  "scenarioB_persistedOutcomeReachability": {
    "originalDispatchKey": "dk_turn:wecom:probe-chat:1:1",
    "outcomePersistedAcrossReopen": true,
    "replayWithWindow": "replayed",
    "replayedDispatchKey": "dk_turn:wecom:probe-chat:1:1",
    "newTurnWithoutWindow": "minted",
    "newTurnDispatchKey": "dk_turn:wecom:probe-chat:1:2",
    "conclusion": "outcome 持久存在且可按原身份读回；新回合没有原身份 → 铸造新 key（重投够不着旧结果）"
  }
}
```

说明：探针 A 是“重启后重投已完成回合”的最小反例；它没有模拟真实崩溃时序（进程内 `close()` 后重建），但崩溃只会让情况更差（回合连完成回执都没留下）。真实崩溃窗口未做故障注入，登记为**待核**，不冒充已验证。

---

## 3. 要做成需要动什么

### 3.1 必须动的最小面

最小可行方案（档 A，见 §5.1）只需要在**现有**持久化引擎上加一张“入站回执”表，并把 server 的“先查内存 Map”扩展为“内存 Map 快路径 + 持久回执兜底”：

| 面 | 改动 | 为什么必须 |
| --- | --- | --- |
| `packages/core/src/task-store.ts` | schema v4 → v5；新增入站回执表（字段建议见下）；沿用既有版本化迁移/备份口径（`packages/core/src/task-store.ts:78`、`:22-30`） | 需要一个跨重启存在的“请求身份” |
| `packages/agent/src/task-registry.ts` / `task-registry-sqlite.ts` | 在**现有** `TaskRegistry` 接口上加入回执的原子 `claim` / `settle` / `get`；SQLite 实现用 `BEGIN IMMEDIATE` | 复用现有底账引擎与单写路径，不建第二套 Registry |
| `apps/server/server.ts` | 回合开始前持久 `claim(messageId, principal, session)`；回合成功后 `settle(completed, reply)`；重启后无内存 Promise 时读回执决定回放/待核对 | 唯一的入站消息入口 |
| `packages/agent/src/execution-runtime.ts`（可选，档 A2） | 失败时暴露机械事实 `sideEffectsAttempted`，用于区分“可安全重试的失败”与“必须待核对的失败” | 否则失败路径只能在“一律待核对”与“照旧允许重试”之间二选一（见 §4.4） |

建议的表形状（**仅设计，未建表**）：

```sql
CREATE TABLE message_receipts (
  principal_id  TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  status        TEXT NOT NULL,      -- claimed | completed | unknown
  reply_text    TEXT,               -- completed 时回放；unknown 时为空
  claimed_at    TEXT NOT NULL,
  settled_at    TEXT,
  PRIMARY KEY (principal_id, session_id, message_id)
);
```

要点：

- **主键是身份三元组** `(principal_id, session_id, message_id)`，与现行内存 Map 的键同义；**不是**消息正文/附件内容的哈希（内容哈希会滑向禁止的参数文本去重）。
- **先 claim 再起回合**：claim 必须在任何副作用之前提交。这样进程死亡窗口里一定有一行 `claimed`，重启后能识别“这笔可能已经动过”，而不是当新回合重跑。
- **complete 回放**：`completed` 回放同一 `reply_text`，零新执行。回放是“同一条回执再发一次”，不是“再做一次”。
- **claimed 孤儿 = 待核对**：重启后内存里没有在飞 Promise，但表里有 `claimed`，说明上一进程死在回合中；返回既有“结果待核对”固定话术（`packages/agent/src/execution-runtime.ts:656-659`），不自动重跑。
- **unknown = 待核对**：与 U3 的 `unknown` 同语义，禁止自动重放（`packages/agent/src/task-registry.ts:25-26`）。
- **保留/有界**：必须给回执表定 TTL 或行数上限（当前内存 FIFO 是 1024，`apps/server/server.ts:70`）。持久表无界增长是不可接受的；清理可挂在既有 `cleanup:runs` 或启动清扫上，具体归实现切片。
- **隐私**：`reply_text` 可能含业务数据；保留期、可见性、清理策略需要 owner 裁定，本文不预造。
- **并发认领**：claim 必须靠主键/事务原子裁决；输者读回已存在行并按 `claimed/completed/unknown` 处置，不得直接起回合。`BEGIN IMMEDIATE` 是既有底账写事务口径（`packages/agent/src/task-registry-sqlite.ts:322-325` 注释）。

### 3.2 不需要动 / 不应动

- **Execution Contract：不必须改。** `dispatchKey` 已经是稳定的逻辑操作身份（`packages/contracts/src/execution-contract.ts:62-73`），档 A 完全不碰它。档 B 若要做执行层状态查询/对账，才需要新增契约能力——那是另一个 owner 决策，不在本设计默认范围。
- **能力清单元数据（CapabilityManifest）：不要改。** 宿主不需要按 operation 声明“是否幂等”来决定消息去重；消息去重发生在回合边界，与业务 operation 无关。按 operation 名/参数推断幂等会侵执行层语义（AGENTS.md:52-54）。
- **`IncomingChannelMessage`：不需要改。** `messageId` 已经是渠道事实（`packages/contracts/src/channel.ts:88`）；`receivedAt` 也已存在。不要新增“客户端幂等键”让模型/用户提供。
- **任务状态机：不需要新增状态。** 回执表的状态是回执自己的三态（claimed/completed/unknown），不是 `tasks` 状态机的新状态；如果要复用到 `tasks`，应复用既有 `result_unknown` 语义，而不是新造一套。
- **不要把 `messageId` 混进 `dispatchKey`。** 两者身份不同：`dispatchKey` 是“某次交办内的一笔业务操作”，`messageId` 是“渠道请求”；历史台账也明确“dispatchKey 不动（多形态身份，混入 msgid 会误伤合法续派）”（`docs/debt-ledger.md:1341`）。回执层应是独立的一层，通过外键/关联列指向 turn/task/op，而不是改写 `dispatchKey` 的语义。

### 3.3 禁止项（硬约束）

1. **不做参数文本去重。** `OperationClaimInput`（registry）/ `OperationClaimRequest`（store）结构上都没有 args（`packages/agent/src/task-registry.ts:433-449`、`packages/core/src/task-store.ts:156-164`）；`operations` 表没有、也不得有 `(operation, args)` 唯一约束（`packages/core/src/task-store.ts:125-127`、`:343-357`）。按 `sha256(code)+inputs` 做跨回合/跨重启合并，会把“两笔合法同参数操作”误合成一笔——这比重复执行更坏。
2. **不做第二套 Registry / 第二套任务状态系统。** U3 明确“在现有底账上增加一张 operations 账”，并禁止新建第二套 Registry（`packages/agent/src/task-registry.ts:31-41`；`docs/product/pi-152-dispatch-key-design.md:174`）。回执表应进同一个 store、同一套迁移与写路径。
3. **不做宿主计划门 / 计划裁决。** 宿主只做可信身份、回执与如实转述；操作授权、业务校验、幂等键的最终执行归执行层（AGENTS.md:28-30、`:69`；`docs/product/pi-152-dispatch-key-design.md:174`、`:312`）。
4. **不在 `unknown` 上自动重试。** `unknown` / `claimed` 的语义就是“不能证明发生了什么”，只能待核对（`packages/agent/src/execution-runtime.ts:710-716`；`packages/agent/src/notification-render.ts:44-46`）。
5. **不把“重复同一句话”自动当成同一次授权。** 现有口径是“跨回合的用户重发 = 新授权/新交办”（`docs/product/pi-152-dispatch-key-design.md:243`）；跨重启幂等只能限定在**同一渠道 `messageId` 的重投**，不能扩展到“文本相同就去重”。
6. **不宣称 Exactly Once。** 宿主最多承诺“同一身份至多一次自动执行 + 结果未知可核对”；外部幂等键/状态查询/回读归执行层（`packages/agent/src/task-registry.ts:42-45`；`docs/product/pi-152-dispatch-key-design.md:16`、`:224-226`、`:312`）。
7. **不复活已退役的旧机制。** `findByWecomMessageId` / `task_runs` 等在当前树不存在（本次 grep 零命中），不要为了“持久幂等”把 Minimal Reset 删掉的旧基础设施重新引回来；用同库最小表解决。

### 3.4 多实例、渠道与信任边界

- 当前 `messageId` 去重是**单进程**假设；多实例共享同一个 SQLite 文件时，回执表的 `PRIMARY KEY` + `BEGIN IMMEDIATE` 可保证并发认领不重复，但会话级串行、租约、`SessionPersistence` 仍是单进程假设。**多实例不在本设计承诺范围**，继续登记为 blocked（`docs/decision-log.md:1094`）。
- 档 A 里“同进程在飞”仍走内存 Promise 快路径；跨进程在飞只会看到持久行 `claimed` → 待核对。这是安全的（不重复执行），但不保证及时拿到原回执，属于多实例限制的一部分。
- `messageId` 是渠道适配器产出的事实，不是模型输入。回执键只能使用装配层拿到的 `principalId`/`sessionId`/`messageId`，不能从工具参数或模型文本读取身份。
- 渠道是否真的会用同一 `msgid` 重投、重投多久，仓内没有验证（`adapter.ts` 没有 msgid 级重投说明）；本设计只回答“如果重投发生，宿主应如何”。这一项标为**待核**。

---

## 4. 风险：Exactly Once 不可承诺时，正确行为是什么

### 4.1 三段事实，不是两段

用户可见事实只能有三种：

1. **已执行且有结果**（`completed`，可回放同一结果）；
2. **确认失败**（`failed`，且能证明没有副作用）；
3. **结果待核对**（`unknown`/`claimed` 孤儿，不能宣称成功，也不能宣称失败）。

`result_unknown` 不是 `failed` 的委婉说法，更不是成功（`packages/agent/src/task-registry.ts:25-26`；`packages/agent/src/notification-render.ts:44-46`）。

### 4.2 崩溃点对应的正确行为

| 崩溃/中断点 | 持久事实 | 重投时的正确行为 |
| --- | --- | --- |
| claim 之前 | 无回执行记录 | 可以安全开新回合（上一进程未进入副作用面） |
| claim 之后、任何工具调用之前 | `claimed` | **待核对**，不自动重跑。代价是可能“白等一次”，但这是 at-most-once 的必然成本 |
| 工具调用中/后、回合未收尾 | `claimed`（+ 可能已完成的 `operations` 行） | **待核对**，不自动重跑；不得因为“部分操作 completed”就重跑整回合（会把已完成的那笔再做一遍） |
| 回合收尾、回执已 settle | `completed` + reply | **回放 reply**，零新执行；重复发送文本可接受，重复副作用不可接受 |
| 执行层明确回 `result_unknown` | `unknown` | **待核对**，不自动重试；等待人工核对/执行层按 `dispatchKey` 查状态 |
| 已确认失败且能证明无副作用 | 回执落 `failed`（或按既有语义删除） | 允许渠道按既有语义重试（保持今天的“处理失败不缓存”行为） |

### 4.3 “待核对”话术

复用既有固定话术，不新造内部术语：

- 工具/回合层的固定话术：`packages/agent/src/execution-runtime.ts:656-659`（“结果待核对：无法确认这次操作是否已经发生，已停止自动重试……”）。
- 通知层对 `result_unknown` 的人话：“不确定做没做完，需要再确认”（`packages/agent/src/notification-render.ts:44-46`）。

回执层在重投时若命中 `claimed`/`unknown`，应返回同一句“待核对”，而不是“已完成”或“请重试”。**“请重试”在可能有副作用时是错误引导**。

### 4.4 代价与需要 owner 裁定的取舍

- **保守策略（推荐给档 A 的最小版）**：handler 异常一律不删除持久回执，按 `unknown` 处理 → 用户看到待核对。风险是“模型侧失败、零副作用”也会被当成待核对，用户体验变差。
- **精确策略（档 A2）**：runtime 暴露机械事实 `sideEffectsAttempted`；只有“有副作用尝试但未落定”才 `unknown`，纯模型失败仍按今日语义允许重试。需要改 `execution-runtime` 的失败出口，属于产品代码变更，必须 owner 批准。
- 本文不替 owner 选；只指出：**如果不做 A2，就必须接受误报待核对**，不能既保留“失败即删缓存重试”又声称不会重复副作用。

### 4.5 档 A 不覆盖的残余风险

- **文件交付**：回合可能已经投递了文件但回执未 settle；档 A 只回放文本，不保证文件不重发/不漏发。档 B 需要把交付事实纳入回执。
- **多操作部分完成**：一个回合内多笔写操作，第一笔 completed、第二笔 unknown；档 A 只能整回合待核对，不能告诉用户“第一笔已完成、第二笔待核对”。档 B 的操作级账本可以。
- **外部效果不可验证**：即使宿主回放/待核对完全正确，执行层是否真的只写一次仍取决于它的幂等键/状态查询/回读。宿主不能替执行层承诺。
- **幂等窗口有界**：回执表按 TTL/行数清理后，超过保留期的旧 `messageId` 重投会重新执行。这是有界幂等的必然边界；保留期必须与渠道实际重投窗口对齐（渠道窗口本身待核），并在清理/未命中时留结构化事件，不能静默当成首次。

---

## 5. 分档方案

### 5.1 档 A：最小可做（重启后能识别“同一笔重投”并如实告知）

**目标**：跨重启后，同一 `messageId` 不再被当成全新回合无条件重跑；能回放已完成回执，或对可能已执行的孤儿回执如实返回“待核对”。

**范围**：

1. `message_receipts` 表（同上）+ schema v5 迁移/备份。
2. `TaskRegistry` 加 `claimMessageReceipt` / `settleMessageReceipt` / `getMessageReceipt`（名字可调，语义固定）。
3. server handler：
   - 先查内存 Map（在飞 Promise 快路径，保持今天并发重投共享 Promise 的行为）；
   - 未命中再查持久回执：
     - `completed` → 回放 `reply_text`，记 `message_duplicate_replayed`；
     - `claimed`/`unknown` → 返回待核对话术，不建会话/不起回合；
     - 无行 → 原子 `claim` 后进入现有回合路径；
   - 回合成功 → `settle(completed, reply)`；失败 → 按 owner 选定的策略 `settle(unknown)` 或删除/标记失败（§4.4）。
4. 清理/保留策略（TTL 或行数上限）。

**影响面**：`packages/core/src/task-store.ts`（schema/迁移）、`packages/agent/src/task-registry.ts`、`packages/agent/src/task-registry-sqlite.ts`、`apps/server/server.ts`，加测试。数据库多一张小表；每条消息多一次 SQLite 读 + 一次写。**不碰** Execution Contract、CapabilityManifest、Pi 驱动、Worker 执行协议。

**粗估（非承诺）**：产品代码约 200–350 行（含迁移/接口/接线），测试约 150–250 行；1 个新表、1 次 schema 迁移、3–5 个测试文件/用例组。实际以实施切片为准。

**需要谁批准**：**owner**。理由不是技术，而是这条能力在现行登记里明确未授权：
- `docs/decision-log.md:1094` 把“messageId 跨重启/多实例持久幂等”列为 blocked（不计 passed）；
- `docs/decision-log.md:1118` 明确“3b 持久幂等键（schema）……未授权待批”；
- `docs/product/r4-p7b-acceptance.md:95`、`r4-stability-report.md:74`、`r4-stability-prereg.md:159` 都写“持久幂等键（新 schema/机制，owner 决定）”；
- `docs/product/cap01-main-direct-execution.md:130` 当时的范围是“跨重启不保证，重启后重投是新回合，重新执行是正确行为”。改成跨重启幂等，是对该冻结口径的显式变更，必须 owner 裁定。

**档 A 的已知限制**：误报待核对（§4.4）、文件交付不精确（§4.5）、多操作部分完成只能整回合待核对、多实例不承诺。

### 5.2 档 B：完整方案（持久幂等结果复用 + 操作级对账）

**目标**：跨重启重投能定位到原回合及其所有副作用操作；已完成的复用结果，未定论的精确列出“哪几笔待核对”；文件交付也纳入事实。

**建议范围**：

1. **档 A 的全部**。
2. **回合/操作关联**：给 `operations` 增加 `turn_id`（或等价的 `message_key` 关联列），把 `task:<taskId>` / `turn:<session>:<turnNo>` 的作用域挂到持久 `turn` 记录；重启后按 `messageId → turn → operations` 读回全部操作状态。
3. **`run_js` 持久化**：
   - Main 与 Worker 的 `run_js` 在 spawn 之前写一条 `claimed` 运行记录（宿主铸造稳定 `runKey`，**不是** code/inputs 哈希）；
   - 成功/失败后落定结果；
   - 重启后 `claimed` → `unknown`，返回待核对，不重跑；
   - 同一回合内的 Pi 重试仍走现有 memo（`execution-runtime.ts:938-942`），不改变其语义。
4. **交付事实**：回执/回合记录保存文件投递结果（sent/suppressed/failed），重投时不得把“未送达”说成“已送达”。
5. **执行层对账（可选，跨仓库）**：为 `result_unknown` 提供按 `dispatchKey` 的状态查询/回读。若要做，需要在 Execution Contract 增补查询语义——这是**新的契约能力**，必须 owner + 执行层 owner 批准，且不能把它包装成宿主计划门。

**影响面**：除档 A 外，触及 `packages/agent/src/execution-runtime.ts`（run_js 预落库、turn 关联）、`run-js-executor` 的运行身份、`packages/contracts`（仅档 B5 可选查询）、以及更多故障注入测试。数据库行数增长与清理更复杂。

**粗估（非承诺）**：在档 A 基础上再 300–600 行产品代码 + 相应测试；若含执行层查询，跨仓库协调，不能按单仓估算。

**需要谁批准**：owner（宿主侧 schema/行为）；若含执行层状态查询，另需执行层 owner 批准契约扩展。档 B 不应在没有档 A 的用户级验证前直接开工（AGENTS.md 的“新增机制准入”要求最小可复现失败、前置方案尝试、Eval 结果）。

### 5.3 不建议现在做

- **Exactly Once / 分布式事务**：宿主无法控制外部 SaaS 是否只写一次；不要承诺。
- **按文本/参数哈希跨重启去重**：把“两笔合法同参数操作”合并，属于禁止项（§3.3）。
- **多实例共享幂等**：当前会话/租约/持久化都是单进程假设；先不扩。
- **为幂等引入 Planner/Router/意图分类器/第二套 Registry/计划门**：同样禁止。

### 5.4 对比表

| 维度 | 档 A（最小） | 档 B（完整） |
| --- | --- | --- |
| 重启后识别同一 `messageId` | 是 | 是 |
| 已完成回执回放 | 是（reply_text） | 是（reply + 交付事实） |
| 孤儿回合 | 待核对，不重跑 | 待核对，可列出已完成/待核对操作 |
| `run_js` 事后可查 | 否（仅回合级） | 是（运行级记录） |
| 文件交付精确性 | 否 | 是 |
| 改动 Execution Contract | 否 | 仅可选查询（需批准） |
| 改 Task Registry | 是（同库新表） | 是（新表 + 关联列） |
| 改 CapabilityManifest | 否 | 否 |
| 多实例 | 不承诺 | 仍不承诺（除非另做租约） |
| 工作量（粗估） | 小 | 中—大 |
| 批准 | owner（schema/行为变更） | owner（+ 执行层 owner 如做查询） |

---

## 6. 未来实施的验收口径（TDD 清单，本文不实施）

| # | 用例 | 判据 |
| --- | --- | --- |
| A1 | 同进程同 `messageId` 两次 | 执行器 1 次；回执逐字一致；零新 `message_done` |
| A2 | 重启后同 `messageId`，原回执 `completed` | 执行器 0 次；回放原 reply；零新副作用 |
| A3 | 重启后同 `messageId`，原回执 `claimed` 孤儿 | 执行器 0 次；返回待核对固定话术；不宣称成功/失败 |
| A4 | 重启后同 `messageId`，原回执 `unknown` | 同上（不自动重试） |
| A5 | 不同 `messageId`、完全相同文本 | 两次都执行（不得按文本去重） |
| A6 | 同回合内两笔同参数 `execute_operation`（无窗口） | 两行两 key、各执行一次（不得按参数合并） |
| A7 | 回执保留上限/过期 | 超过保留期的旧回执不再回放；行为有明确日志，不静默 |
| B1 | 重启后 `messageId → turn → operations` | 能列出每笔操作状态；completed 回放、claimed/unknown 待核对 |
| B2 | `run_js` 在 spawn 前崩溃 | 重启后运行记录 `claimed` → 待核对；不重跑 |
| B3 | 文件已投递但回执未落定 | 重投不重复投递、也不谎报未送达（按交付事实） |

**反向绊线**（实施时必须做，故意破坏应红）：

- 删除持久回执查询 → A2/A3 红；
- 用文本/参数哈希代替 `messageId` → A5/A6 红；
- 把 `claimed` 当 `completed` 回放 → A3 红；
- 把 `unknown` 当失败并自动重试 → A4 红；
- 重启后重新铸造回执身份 → A2/A3 红。

---

## 7. 本文件边界

- 未改产品代码、契约、schema、测试、默认行为。
- 未实现档 A/档 B 的任何部分；本文所有“建议/将/需要”均是设计，不是实施记录。
- 未验证真实企微是否会在同一 `msgid` 上重投、重投窗口多长（**待核**）。
- 未做真实崩溃故障注入；探针只证明“重启后进程内缓存丢失 → 同一请求再执行一次”。
- 未作 owner 裁定；档 A/档 B 是否开工、失败路径选“保守待核对”还是“精确 sideEffectsAttempted”，都需 owner 决定。
