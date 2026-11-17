# B1 会话持久化：独立存储层实施记录（复用 Pi 公开 Session 持久化）

- 分支：`arch/sess-persist-impl`（worktree `~/projects/fshine-agent-sesspersist-impl`），基线 = `arch/integration` 启动时 HEAD `b90f12f`。
- 范围：**本 run 不接生产装配**。新增独立模块 `packages/agent/src/session-persistence.ts` 与其测试 `packages/agent/session-persistence.test.ts`；**不改** `apps/server`、`execution-runtime`、`ask-runtime` 等生产路径；不被任何生产入口 import；不升级 Pi。
- 依赖：复用 Pi 正式公开能力（`@earendil-works/pi-agent-core@0.85.1`）。

---

## ① 复用点（全部是 Pi 公开导出，未复制 Pi 源码、未依赖未导出实现）

| 能力 | 来源（公开导出） | 用法 |
| --- | --- | --- |
| 文件型会话仓库 | `JsonlSessionRepo`（`harness/session`，`index.d.ts:5`） | 每 principal 一个仓库实例，`create`/`open`/`list`/`delete` |
| Pi 原生 Session 语义层 | `StorageBackedSession`（`harness/session`，`session.d.ts:36`，经 repo 暴露） | 直接持有并驱动，不自造会话状态 |
| 单条 entry 追加日志 | `StorageBackedSession.appendToBranch`（`session.js:316-340`） | 每次只提交 **1 条 message entry + 1 条 branch-tip value 写** |
| 顺序读回 | `Session.branch(...).findEntries`（`session.js:127-137`） | 按 `oldestFirst` 读主 branch 的 message entry |
| 文件系统能力 | `NodeExecutionEnv`（`@earendil-works/pi-agent-core/node`） | 注入 `JsonlSessionRepo` 的 `FileSystem`（`harness/types.d.ts:170`） |
| 运行上下文 | `BACKGROUND_CONTEXT`（`harness/context`） | 传给所有 Pi 调用 |

本层（`session-persistence.ts`）只做**薄映射**，不含存储/编解码/编目逻辑：

1. `principalId` → 独立存储子树 `<rootDir>/principals/<sha256(principalId)>`（隔离，且对身份做哈希、不拼渠道文本进路径）。
2. `(principalId, sessionId)` → Pi 的 `(cwd, id)`，`cwd` 由构造参数固定（跨重启稳定）。
3. 暴露最小 API：`openOrCreate` / `list` / `delete` / `close`，会话句柄仅 `append(message)` / `readTranscript()` / `close()`。

**关键点**：本层内部**没有** `AgentMessage[]` 字段或缓存——写走 `Branch.appendMessage`，读走 `Branch.findEntries`，Pi Session 是唯一转录所有者（见 §③）。

---

## ② 增长特性（为什么不是 O(n²)、以及是否有界）

复用 Pi 的 `JsonlStorage`（`jsonl/storage.js`）后，落盘增长是**线性**：

- 正常追加路径 `applyCommit` 只把**本次新增**的写落成一行：`appendFile(path, serializeTransaction(prepared.writes))`（`storage.js:172-182`），`prepared.writes` 即本次 commit 的写，不写全量转录。
- 每次 `appendToBranch` 只产生 1 条 message entry + 1 条 tip 值写（`session.js:326-337`），故**文件总量 = O(已追加 entry 总数)**，随消息数线性。
- 唯一整文件重写点：建仓（temp+rename，`storage.js:70-80`、`:99-106`）、fork、**torn 尾修复**、v3→v4 升级（`storage.js:143-145` 等）。正常追加路径永不重写/截断。

**测试证据**（`packages/agent/session-persistence.test.ts`，describe「增长特性」）：追加 40 条后再追加 40 条，`size(2N)/size(N) ∈ (1.5, 2.5)`（≈2.0，线性；被否证的「每回合全量快照累计」应为 ≈4），且第二次追加后**旧字节前缀逐字节不变**（追加式，无整文件重写）。

**有界性说明（如实登记，未放宽）**：Pi 的追加日志**只增不减**——compaction 只作为一条 `CompactionEntry`（含 summary + retainedTail，`types.d.ts:27-35`）再追加，并不删除旧 message entry。即：**压缩缩小的是模型上下文，不是日志文件大小**。故本层落盘**无界（线性）**，与既有 SQLite 任务账本同样需要消费方自备保留/轮转策略。本 run **不实现**保留/轮转（属装配层策略，待与 Pi 迁移一并裁定）；此处只如实说明，不假称「已解决无界」。

---

## ③ 为何不是「第二份转录」

被否证的设计（`docs/product/r5-session-persistence-design.md`）在 Pi 之外维护一份可变 `AgentMessage[]`：

- 行形状 `{ v, principalId, sessionId, at, messages: AgentMessage[] }`（`r5-session-persistence-design.md:66`），**每回合把完整转录整体追加一行**（数据流 `:101-102`：`回合N → 追加快照 {…, messages'}`）；
- 载入失败/文件损坏时「跳过不可解析行取最后一条可解析快照；整文件不可用时**回落空转录**」（`:142`）——即**静默回落掩盖损坏**。

本层与之形同而实异：

- 本层**不拥有、不缓存、不落**任何自有 `AgentMessage[]`。写 = Pi `appendToBranch`（单条 entry 追加到 entry-log），读 = Pi `findEntries`（entry-log 回放）。本层只在 Pi 与调用方之间传 Pi 原生 `AgentMessage`。
- 因此不存在「每回合重写一份随会话增长的全量转录」→ 无 O(n²)；也不存在「第二份可独立修改的转录状态」→ 无第二事实源。
- 损坏**显式报错**：非法 JSON 行 → Pi 抛 `Invalid JSONL storage … line N`（`storage.js:132-140`）；header 损坏 → `invalid header`（`:120-123`）/`missing header`（`:117-119`）。本层**不回落空转录**——见 §④ 的「orphan 文件」处理：Pi `list()` 会静默跳过 header 不可解析的文件（`repo.js:193-205`），本层若发现「盘上有文件但 list 列不出」**不会**当成不存在去重建，而是显式 `open` 触发解析错误。

---

## ④ 五类独立存储测试证据（确定性、零真实模型、零网络）

文件：`packages/agent/session-persistence.test.ts`。运行命令与结果：

```
$ TMPDIR=~/.tmp npx vitest run packages/agent/session-persistence.test.ts
 ✓ packages/agent/session-persistence.test.ts (12 tests) 135ms
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

| 类 | 用例 | 断言要点 |
| --- | --- | --- |
| ① 原子恢复 | 「崩溃留下的半行被丢弃…」 | 去掉尾换行 + 截半最后一行 → 重开只恢复到最后一个完整提交（`m1,m2`），文件被修复为换行收尾，可继续追加不重放 |
| ① 原子恢复 | 「崩溃停在已建文件、未建 branch…」 | 只留 header 行 → 重开幂等补建 branch，空转录，可续写；无半态 |
| ① 原子恢复 | 「原子建仓…不残留 .tmp」 | create 后无 `.tmp` 残留、目录内恰 1 个 `.jsonl` |
| ①（唯一所有者） | 「readTranscript 每次现读并返回独立副本」 | 篡改返回值不影响存储；层内不留可变转录数组 |
| ② 隔离 | 「同名 sessionId 跨 principal 隔离」 | `alice`/`bob` 同 id → bob 读回空、filePath 不同、彼此写入互不可见；各自 `list` 只见自己子树 |
| ② 隔离 | 「同 principal 不同 sessionId 隔离」 | `s1`/`s2` 互不串读 |
| ③ 损坏报错 | 「完整行但非法 JSON」 | `rejects.toThrow(/Invalid JSONL storage .*line 2/)`——显式拒绝，非静默跳过 |
| ③ 损坏报错 | 「非法 header」 | `rejects.toThrow(/invalid header/)` |
| ③ 损坏报错 | 「空文件（丢 header）」 | `rejects.toThrow(/missing header/)` |
| ④ 不重放 | 「恢复含 toolCall/toolResult 的转录」 | 逐字 `toEqual(stored)`；恢复前后文件字节**完全不变**（纯读、零写入）；续写后长度 +1（从存储 tip 接续，非重放）；层无 `run/execute/resume/replay/start` 入口 |
| ⑤ 不复制任务事实 | 「落盘仅含 Pi session entry」 | 原始 JSONL 不含任务台账字段（`lease_owner/lease_until/pending_question/waiting_since/task_no/reply_text/result_unknown/task_sequences/executions`）；每条写 `kind ∈ {entry,value,list,usage}`，且 entry 一律 `type:"message"` |
| （增长） | 「追加 N 后再 N」 | 见 §② |

**红→绿证据**：③ 的两条 header 类用例首轮**红**（`Session already exists: c`）——暴露了「Pi `list()` 静默跳过损坏文件 → 本层误判为不存在 → 走 create」的静默回落风险。据此在 `openOrCreate` 加入 orphan 文件探测（`findSessionFile`，不依赖 Pi 私有目录命名），使损坏显式抛 Pi 的解析错误，三轮后全绿。此为**反向绊线**性质的证据：损坏一旦不再显式抛出，该用例即红。

测试覆盖的确定性边界（不依赖平台/模型）：全部用真实临时目录 + Pi `NodeExecutionEnv`，`now` 注入固定值；无网络、无 SQLite、无模型调用。

---

## ⑤ 生产接线待与 Pi 迁移对齐（本 run 未做）

本 run **明确不接生产装配**。落地生产前须对齐：

1. **接线点**：现生产 `mainMessages` 是 `execution-runtime.ts` 闭包内存变量（每回合整体替换，仅 `transcript()` 只读暴露）。接本层须把「写入点」与「回合语义」解耦（写失败不回滚回合，见被否证文档 `:90/:141` 讨论），但这触及生产 `send()` 路径——**待与 Pi 迁移计划一起裁定**，不在本 run。
2. **权限/身份来源**：`principalId` 必须取宿主已持有的可信渠道事实（现 `server.ts` 由渠道构造 `(principal, session)`），不得由模型文本提供。
3. **有界策略**：§② 的日志无界增长需装配层给保留/轮转（本层不实现，也不假装无界已解）。
4. **与压缩的关系**：本层不感知 compaction；compaction 只作为 Pi 的 `CompactionEntry` 进同一日志（§②），不引入第二个压缩声明层。
5. **`cwd` 稳定性**：`cwd` 是 Pi `(cwd,id)` 身份的一半，跨重启必须稳定，否则同 `(principal,sessionId)` 会解析到不同目录/身份（`repo.js:262-267` 校验 header id/cwd 一致）。

---

## 附：核验命令（本轮实际执行）

- `npm run typecheck` → 0 错误（执行于本 worktree，`node_modules` 符号链接自主仓同版本包）。
- `npx vitest run packages/agent/session-persistence.test.ts` → 11 passed。
- 全量 `npm test`（改动前）：`92 files / 922 passed + 3 todo`；（改动后）`93 files / 934 passed + 3 todo`——+1 文件 / +12 用例，**例数不减**。
