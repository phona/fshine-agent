# R6 MU-6 重启恢复（多 principal）· 接线与判据

> 本文件记录 MU-6「重启恢复（多 principal）」在 `arch/r6-mu6`（基线 `arch/integration` @ `ebdaf71`，含 B1 接线）
> 上的落地：装配、判据、证据、五要素与结论。**零真实模型 / 零真实平台 / 零真实写**；确定性。

## 1. 背景与解锁

MU-1～MU-10 多用户确定性用例（`scripts/eval/long-session/multiuser/`）中，MU-6 原本因依赖 **B1 会话持久化未合入**
而标 `BLOCKED`（`mu-cases.ts` 旧版：`existsSync(packages/agent/src/session-persistence.ts)` 为假 → BLOCKED）。
B1 接线已随 `ebdaf71 merge(b1-wiring)` 合入基线：`SessionPersistence` 已接入 `createServer` 的真实会话生命周期
（打开载入 / 回合后增量持久化 / 写失败 fail-open），故 MU-6 的 `BLOCKED` 解除，转为真实确定性用例。

## 2. 装配（复用，不建第二套）

MU-6 只 import 既有装配，不新增会话 / 压缩机制：

| 复用点 | 位置 | 作用 |
| --- | --- | --- |
| `createServer`（生产同源） | `apps/server/server.ts:100` | MU 经 `createMuServer` 走同一装配链 |
| `(principalId, sessionId)` 双键会话缓存 | `apps/server/server.ts:163-208` | 逐 `(principal, session)` 独立句柄，物理隔离 |
| B1 `TranscriptStore` 接线 | `apps/server/server.ts:119-120,170,191` | `openOrCreate` 打开即载入、回合后增量持久化 |
| 会话存储根缺省 | `apps/server/server.ts:119` | `<dbPath 目录>/sessions` → 同 `dbPath` 重建即恢复 |
| `close()` 释放 | `apps/server/server.ts:302-309` | `close` 后同 `dbPath` 重建须先释放（否则读到陈旧内存态） |
| Task Registry 只读快照 | `mu-support.ts:401-419` `readTasks` | 判定读 `TaskView` 快照，**非** `registry.get` 直调 |
| 计划表 / 采集面 / 假执行器 | `mu-support.ts` `MuPlans` / `makeCtx` / `TagKeyedExecutor` | 假渠道事实 + 假主驱动 + 确定性后台执行器 |

**不使用** `registry.get` 代替交互路径：场景驱动全部走 `server.handler`（真实交互路径），判定读 `readTasks`
（Task Registry 机械 Oracle 的只读投影）。**不建**第二套会话 / 压缩机制。

## 3. 场景形状（`scripts/eval/long-session/multiuser/mu6-restart.ts`）

- ≥3 principal：`mu-alice` / `mu-bob` / `mu-carol`（`MU_PRINCIPALS`），各**一个独立会话** `conv-<user>`
  （`sessionId = wecom:conv-<user>`）。
- **background 模式**（唯此模式有 `runner.pump` 重启路径，③「任务不重放」才有机械意义）。
- 每 principal 首回合 `delegate`（`run_task` → 后台任务，请求原文含本人标记，如 `TAG-ALICE 重启前交办`）；
  次回合 `turn`（普通追问，如 `TAG-ALICE 重启后追问`）。
- 假后台执行器 `TagKeyedExecutor` 按 `TaskExecutionInput.request` 派生**确定性**结果
  `resultText = RESULT:<该请求所属 principal 的标记>`（并发会话顺序不定，故不依赖调用顺序）。
- 步骤：`server1` 并发投递 3 个首回合 → 等 3 任务 `completed` → `await server1.server.close()` →
  **同 `dbPath` / 同 `dir`** 重建 `server2`（新 `TagKeyedExecutor` = 重放检测器）→ 各发次回合。

## 4. 判据（四断言，任一命中即 FAIL）

| # | 断言 | 机械判据 | 硬零码 |
| --- | --- | --- | --- |
| ① | **各自转录恢复** | 次回合上下文含**本人**首回合用户原文与 assistant 回复（`messagesText` 检） | `cross_principal_leak` |
| ② | **不跨 principal 串读** | 次回合上下文不含他人标记；每 principal 恰一任务且请求标记匹配、不含他人标记 | `cross_principal_leak` / `task_crossover` |
| ③ | **任务不重放** | 重启后（pump + 追问回合）新 executor 调用计数 = 0 | `task_crossover` |
| ④ | **结果找回** | 重启后经 Task Registry 取回首回合任务真实结果（`replyText === RESULT:<tag>`、`status === completed`） | `task_crossover` |

> ②③④ 复用 `MuHardZero` 既有词汇（`cross_principal_leak` / `task_crossover`），**不扩张**硬零码集合。
> ③ 重放 = 任务连续性违规，映射到 `task_crossover`；`evidence.replayCallsAfterTurn` 给出专属机械证据。

**「不改既有 MU 判据」口径**：MU-1～5、7～10 的用例实现与断言**逐字未改**；MU-8 仍 `BLOCKED`。
MU-6 本身即本任务要落地的对象（旧版是 `BLOCKED` 占位，非既有判据），故 `mu-cases.ts` 的 `mu6`
与 `mu.test.ts` 的 MU-6 断言由占位改为真实判据；`mu.test.ts` 汇总用例中 `BLOCKED` 期望由 `['MU-6','MU-8']` 收窄为 `['MU-8']`。

## 5. 证据（命令 + 结果）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `npm run typecheck` | 0 错误（无输出） |
| 定向 | `npx vitest run scripts/eval/long-session/multiuser/mu.test.ts` | 12 passed（含 MU-6 PASS） |
| 全量 | `npm test` | 98 files passed；988 passed + 3 todo；0 failed |
| 例数 | `grep -c "it(" mu.test.ts`（working vs `HEAD`） | 12 = 12（未新增/删除用例；新增模块非 `.test.ts`） |
| 反向绊线 | 临时把 `server.ts` 的 `transcriptStore` 置为 `undefined` 后跑 MU-6 | 变红（`FAIL`：`expected 'FAIL' to be 'PASS'`）；已 `git checkout` 复原 |

MU-6 实测证据落 `.runtime/r6/multiuser/MU-6/evidence.json`（`restored` 全 true；`transcriptViolations=[]`；
`taskViolations=[]`；`replayCallsAfterPump=0`、`replayCallsAfterTurn=0`；`resultRetrieval` 三个 `ok=true`）。

## 6. 五要素记录（一次实测）

| principalId | sessionId | taskId | request | deliveredTo |
| --- | --- | --- | --- | --- |
| `wecom:mu-alice` | `wecom:conv-mu-alice` | `task_2573f8d8-…-12a78a18c0e9` | `TAG-ALICE 重启前交办` | `wecom:conv-mu-alice` |
| `wecom:mu-bob` | `wecom:conv-mu-bob` | `task_0caa1c5c-…-61f72e28fcca` | `TAG-BOB 重启前交办` | `wecom:conv-mu-bob` |
| `wecom:mu-carol` | `wecom:conv-mu-carol` | `task_f7f60c0a-…-e399fa5c3d87` | `TAG-CAROL 重启前交办` | `wecom:conv-mu-carol` |
| `wecom:mu-alice` | `wecom:conv-mu-alice` | —（次回合无任务） | `TAG-ALICE 重启后追问` | `wecom:conv-mu-alice` |
| `wecom:mu-bob` | `wecom:conv-mu-bob` | — | `TAG-BOB 重启后追问` | `wecom:conv-mu-bob` |
| `wecom:mu-carol` | `wecom:conv-mu-carol` | — | `TAG-CAROL 重启后追问` | `wecom:conv-mu-carol` |

（taskId 为 UUID 实例；逐字见 `.runtime/r6/multiuser/MU-6/evidence.json`。）

## 7. 结论

MU-6 在本基线（含 B1 接线）上 **PASS**：三 principal 同 `dbPath` 关停重建后，
①各自转录恢复、②不跨 principal 串读、③任务不重放、④结果找回 四类断言全部成立，硬零命中为空。
未改产品码、未引第二套会话 / 压缩机制、未接真实平台 / 写、未改 `docs/decision-log.md`。
