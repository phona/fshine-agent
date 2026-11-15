# B1 会话持久化接线（真实会话生命周期；复用 Pi 独立存储层）

- 分支：`arch/b1-wiring`（worktree `~/projects/fshine-agent-b1-wiring`），基线 = `arch/integration` 启动时 HEAD `27c690c`。
- 范围：把已合入的独立存储层 `packages/agent/src/session-persistence.ts` 接入**真实会话生命周期**——
  会话打开时从存储载入转录、回合结束后把本回合新增转录增量持久化。**不重实现** Pi 会话管理与压缩
  （Pi Session 仍是唯一转录所有者；无第二套 session / compaction）。
- 改动面（最小）：`packages/agent/src/execution-runtime.ts`、`scripts/ask-runtime.ts`、
  `apps/server/server.ts`（+ `apps/server/main.ts` 一行 `await close`）；新增两个测试文件。**未改**压缩、
  Worker 提示、任务账本语义、执行契约；`.runtime` 未 `git add`；`docs/decision-log.md` 未动。

---

## ① 接线点

| 位置 | 改动 |
| --- | --- |
| `execution-runtime.ts:202` | 新增**端口**（仅类型，无实现耦合）：`export interface TranscriptStore { readTranscript(): Promise<readonly DriverMessage[]>; append(message: DriverMessage): Promise<void>; }`。runtime **不** import `JsonlSessionRepo`/`session-persistence`，保持依赖注入风格。 |
| `execution-runtime.ts` `RuntimeOptions` | 加 `transcriptStore?: TranscriptStore` 与 `onTranscriptError?: (error: unknown) => void`（缺省 `undefined` = 逐字节现行为：转录仅内存）。 |
| `execution-runtime.ts` `createSession` 打开段 | 注入存储时 `mainMessages = [...await transcriptStore.readTranscript()]`，并 `persistedCount = mainMessages.length`；读失败 fail-open。 |
| `execution-runtime.ts` `createSession` 回合替换点（原 `mainMessages = [...mainResult.messages]` 之后） | 按 `persistedCount` 增量追加本回合新增消息，逐条推进；写失败 fail-open。 |
| `ask-runtime.ts` `SessionAssemblyInput` + `assembleSessionCore` 的 `createSession` 调用 | 加 `transcriptStore?` / `onTranscriptError?` 两字段并透传。`assembleAskRuntime` / `assembleAskRuntimeCli` **不传**（`undefined`）→ ask/redo 单轮入口不落盘会话，现行为不变（其文件头「不落盘会话」边界继续成立）。 |
| `apps/server/server.ts` | import `SessionPersistence`（装配层是**唯一**构造具体存储处）；`ServerDeps` 加 `sessionStoreDir?: string`；`sessionFor` 为每个 `(principal, session)` `openOrCreate` 一个句柄并作为 `transcriptStore` 注入；`Server.close()` 改为 `Promise<void>` 并 `await sessionPersistence.close()`。 |
| `apps/server/main.ts` | 关停时 `await server.close()`（确保存储句柄释放）。 |

端口与 `PersistedSession`（`session-persistence.ts:57`）**结构化相容**——装配层直接注入后者
（`append → Promise<void>`、`readTranscript → Promise<AgentMessage[]>`，`DriverMessage = AgentMessage`，
`driver-contract.ts:18`）。

---

## ② 语义

- **打开 → 载入**：注入存储时，打开会话即现读该 `(principalId, sessionId)` 的完整转录作为首回合历史
  （每次现读 Pi entry-log，宿主不留第二份可变副本）。读失败 **fail-open**：不阻塞会话打开（退化为空转录），
  错误经 `onTranscriptError` 上报。
- **回合后 → 持久化**：`mainResult.messages`（含本回合全部消息的完整转录）是唯一替换点；按
  `persistedCount` **只追加本回合新增**消息（Pi 单条 entry 追加日志 = 线性，不重写全文），每成功一条推进
  `persistedCount`，不重复落历史。
- **写失败 fail-open**：`append` 失败时，已成功的追加保留、剩余不再尝试、**不回滚本回合**（回复照常返回），
  错误经 `onTranscriptError` 上报（server 侧落 `transcript_store_error` 日志）。
- **不重放**：接线只在对话上下文层载入/追加转录；任务侧仍走既有 runner（`task_cancel`/`task_resume`/
  `dispatchMode=background` 的 pump），本层**无**任何执行/重放入口，也不感知 compaction。
- **principal / session 隔离**：存储层把 `principalId` 映射成独立子树
  `<rootDir>/principals/<sha256(principalId)>`；server 的 `sessionId = <channel>:<conversationId>`，
  `principalId = <channel>:<userId>`，异 principal / 异 session 物理分离、互不串读。
- **重启原子恢复**：`sessionStoreDir` 缺省 = `<dbPath 所在目录>/sessions`（同一部署状态根）；同 `dbPath`
  重建 server 即恢复同一存储。`cwd` 取仓根（跨重启稳定——Pi 的 `(cwd, id)` 是会话身份的一半）。

---

## ③ 四类确定性验证（零真实模型、零网络、假执行面；真实临时文件系统）

文件：`apps/server/server-b1-persistence.test.ts`（server 级）、
`packages/agent/session-persistence-wiring.test.ts`（端口/失败注入）。运行：

```
$ TMPDIR=/home/tao/.tmp npx vitest run packages/agent/session-persistence-wiring.test.ts apps/server/server-b1-persistence.test.ts
 ✓ packages/agent/session-persistence-wiring.test.ts (4 tests)
 ✓ apps/server/server-b1-persistence.test.ts (3 tests)
 Test Files  2 passed (2)
      Tests  7 passed (7)
```

| 类 | 用例 | 断言要点 |
| --- | --- | --- |
| ① 进程重启恢复 | server 级「重启恢复：同 dbPath 重建 server…」 | 发消息→`await close`→同 `dbPath` 重建→再发；第二回合 driver 输入转录**含首回合用户消息与 assistant 回复**。 |
| ② 任务恢复不重放 | server 级「任务恢复不重放 + 结果找回…」 | background 模式：任务经既有 runner 完成 → 重启后 `runner.pump` 与后续回合均**不再调用 executor**（新 executor `calls === 0`），恢复只重建对话上下文。 |
| ③ 结果找回 | 同上用例 | 重启后经 `createSqliteTaskRegistry(dbPath, { readOnly: true }).get(taskId, scope)` 取回首回合**真实结果**（`replyText` 逐字等于 archiveReply 存档）。 |
| ④ 用户隔离 | server 级「用户隔离：异 principal / 异 session…」 | 三个回合分别落 `(user-a, conv-a)` / `(user-a, conv-b)` / `(user-b, conv-a)`；重启后 `(user-a, conv-a)` 新回合上下文**只含本会话内容**，不含他会话/他 principal 内容。 |
| 端口语义 + fail-open | 端口层 4 用例 | ① 载入历史 + 只增量追加；② `append` 失败不回滚回合、错误上报；③ `readTranscript` 失败不阻塞打开、错误上报；④ 缺省 `undefined` = 现行为。 |

**反向绊线（本轮实测）**：临时停用「打开载入」→ ①/③重启与隔离用例**红**（4 failed）；临时停用
「回合后持久化」→ 5 failed。两处破坏都必须红，证明用例真实守护接线（验证后已还原，`grep` 无残留）。

---

## ④ 生产准入（本 run 未实现，**不阻塞 Dummy E2E**）

以下两项是**上线生产前的准入项**，本 run 明确**不实现**，如实登记（不假称已解）：

1. **保留策略（retention）**：Pi 追加日志**只增不减**——compaction 只作为一条 `CompactionEntry` 再追加，
   压缩缩小的是**模型上下文**，不是日志文件大小。故存储**无界（线性）**增长，与既有 SQLite 任务账本同样
   需要消费方自备保留/轮转。**本 run 不实现**（属装配层策略，与既有 `sessionTtlMs` 等的落点待裁定）。
2. **容量上限（capacity cap）**：单 `(principal, session)` 或单部署的存储上限/背压未实现；超限行为未定义。

**不阻塞理由**：Dummy E2E / 验收以确定性假执行面 + 真实临时目录运行，规模受控；两项准入项不改变本接线的
正确性语义（载入/追加/fail-open/隔离/重启），可在接入真实部署前单独补齐。

---

## ⑤ 边界与不做

- **不重实现 Pi 会话管理与压缩**（Pi Session 唯一转录所有者）；**无第二套 session / compaction**；
  不改 Worker 提示 / 任务账本语义 / 执行契约；`.runtime` 未 `git add`；未改 `docs/decision-log.md`。
- 本接线的 `sessionStoreDir` 缺省取 `<dbPath 所在目录>/sessions`（**而非**固定 `REPO_ROOT/.runtime/...`）：
  使「同部署状态根」自洽、重启按 `dbPath` 恢复，同时让各测试临时 `dbPath` 自动隔离、无跨用例串扰
  （既有 server 回归/harness 全部不改即不落盘串读）。`ServerDeps.sessionStoreDir` 可显式覆盖。

---

## 附：核验命令（本轮实际执行）

- `npm run typecheck` → 0 错误。
- 定向：`npx vitest run packages/agent/session-persistence-wiring.test.ts packages/agent/session-persistence.test.ts apps/server/server-b1-persistence.test.ts` → 3 files / 19 passed。
- 全量 `npm test` → **97 files / 968 passed + 3 todo**（改动仅**新增** 2 个测试文件、7 个用例；未删/未弱化任何既有用例 → 例数不减）。
