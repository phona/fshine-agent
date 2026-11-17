# Pi 原生 Session / 压缩替换实验 · 阶段一「能力核实与接入路径」

> 角色：`exp/pi-native-session-compaction` worktree 阶段一核实员。
> 范围（硬）：**只核实、不实施**。零产品代码改动、零真实模型调用、不升级 Pi、不动 lockfile、不改 `docs/decision-log.md`。
> 版本口径：只读锁版本 **`@earendil-works/pi-agent-core@0.85.1`**（`node_modules/@earendil-works/pi-agent-core/package.json:3` `"version": "0.85.1"`）。行号均为该分发物 `dist/**`。
> 「公开」判定：被根入口 `.`（`dist/index.d.ts`）re-export，**或**位于 `package.json` `exports` 的**子路径**内的符号记公开；`dist/**` 深路径 import 未在 exports map 内者记内部。

## 0. 工作区核验（本会话实跑）

| 检查 | 命令 | 输出 |
|---|---|---|
| 基线 SHA | `git rev-parse arch/integration`（主仓） | `84a22fa6a1dfcb40d73a172b3248766e0ac41a3b` |
| 建 worktree | `git worktree add -b exp/pi-native-session-compaction ~/projects/fshine-agent-exp-pi-session <SHA>` | `Preparing worktree (new branch ...)` / `HEAD is now at 84a22fa` |
| pwd | `pwd` | `~/projects/fshine-agent-exp-pi-session` |
| toplevel | `git rev-parse --show-toplevel` | `~/projects/fshine-agent-exp-pi-session` |
| 分支 | `git rev-parse --abbrev-ref HEAD` | `exp/pi-native-session-compaction` |
| worktree list | `git worktree list` | `...exp-pi-session  84a22fa [exp/pi-native-session-compaction]` |

`show-toplevel` == worktree 路径、分支正确、非主仓。**通过。**

> 说明：本 worktree 未安装 `node_modules`；Pi 源码读取自主仓同一锁版本 `node_modules/@earendil-works/pi-agent-core`（版本号已亲验为 0.85.1，与 worktree `package-lock.json` 一致）。下文路径以 `node_modules/@earendil-works/pi-agent-core/dist/...` 记。

## 1. `package.json` `exports` 导出面（亲验）

`node_modules/@earendil-works/pi-agent-core/package.json` `exports` 暴露 8 个入口：

```
.   ./node   ./harness/context   ./harness/env/nodejs
./harness/runtime/reducer   ./harness/session   ./harness/session/testing   ./package.json
```

**已知线索逐条核对结果：**
- 线索「`exports` 公开 `./harness/session`、`./harness/context`、`./harness/runtime/reducer`、`./harness/env/nodejs`、`./harness/session/testing`」——**证实**（上列）。
- 线索「root `.` 导出压缩原子件」——**证实**（`dist/index.d.ts:8` 一行 re-export `compaction.ts` 的原子件）。
- 线索「`prepareCompaction`/`compact` 是否只是压缩原子件」——**证实为原子件**：其签名输入是 session `Entry[]`/`CompactionPreparation`（`compaction.d.ts:115`、`:118`），是纯函数式编排，**本身不含 Session 生命周期、不含触发时机、不含失败恢复**。它们是「零件」不是「流程」。
- 线索「`MemorySessionRepo` 是否只是转录存储」——**证实**：它 `implements SessionRepo`（`dist/harness/session/memory.d.ts:33-49`），只提供 `create/open/list/delete/fork/close`，**无任何压缩/阈值/溢出逻辑**。它是存储，不是压缩器。
- **关键更正（对既有 r5-piopt 审计的补充）**：`docs/product/pi-compaction-api-audit.md:69` 记「harness 压缩阈值/溢出管线 = 内部（不在 exports map）」。该判定对**直接 import 内部函数**成立，但**不等于「完整生命周期不可公开抵达」**——公开的 `AgentHarness`（root `.` 导出）在内部驱动了整条管线。见 §3。

## 2. 七个必答核实点（逐条结论 + `文件:行号` 证据）

### ① Pi 原生 Session 如何持有完整对话转录
**有。** 转录是 **Branch 上的 `Entry` 有序链**，由 `StorageBackedSession`（`dist/harness/session/session.d.ts:36-81`）持有。
- `Entry` 是联合类型 `MessageEntry | CompactionEntry | BranchSummaryEntry | CustomEntry`（`dist/harness/session/types.d.ts:51`）；每个 entry 有 `id/parentId/seq/timestamp`（`:344-351`）。
- 转录按 `Branch` 存，`getBranchTip(name)` 返回链尾（`session.d.ts:69`）；`appendToBranch`（`:70-77`）追加 message/custom entry。
- 会话可由 `SessionRepo` 创建/打开/持久化：`MemorySessionRepo`（内存，`memory.d.ts:33`）与 `JsonlSessionRepo`（落盘 JSONL，`session/index.d.ts:5`）。
- 上下文重建：`buildSessionContext` 从 entry 链重建 `AgentMessage[]`，最近一条 `compaction` entry 会**替换**其之前的历史为「摘要 + `retainedTail`」（`dist/harness/session/context.js:2-14`、`:19-33`）。
- 证据：`session.js`（`StorageBackedSession` 实现，360 行）、`session/types.d.ts:51,344`、`session/context.js:2,19`。

### ② Agent 如何与 Session 关联、是否支持跨回合复用同一 Session
**有。** `AgentHarnessOptions.session: Session`（`dist/harness/agent-harness.d.ts:617-618`）把 harness 绑到一个 Session；`AgentHarness.create(options, context)`（`:706-715`）恢复该 Session 的各 lane 状态并返回 `{ harness, open }`。
- lane 通过 `harness.lane(name, context)`（`:680-681`）获得；跨回合复用 = 复用**同一个 harness / 同一个 lane / 同一个 Session**，新回合 `lane.prompt(...)`（`:648-649`）只向当前 Branch tip **追加** user entry（`lane.js:329-353` 组装消息、`:441` `promptEntryIds`、`checkpoint.js:9-56` `startRun` 落 entry 并把 tip 前移）。
- 持久化/恢复：`createAgentHarness` 调 `restoreSession`（`runtime/harness.js:290`）从存储恢复，`restoreSession`/`restore.js` 还原 operation 状态。
- 单测/一致性夹具：`./harness/session/testing`（exports 内）提供 conformance/storage-decorator/gating-storage 等（`session/testing/index.d.ts`）。
- 证据：`agent-harness.d.ts:617,679-681,706-715`、`runtime/lane.js:329-353,441`、`runtime/drive/checkpoint.js:9-56`、`runtime/harness.js:279-310`。

### ③ 压缩触发阈值由谁决定、如何配置
**由 `CompactionSettings` + harness 决定；三种触发 reason：`manual | threshold | overflow`**（`agent-harness.d.ts:374-395` `compaction_start`/`compaction_end` 的 `reason` 枚举）。
- 配置项 `CompactionSettings { enabled; reserveTokens; keepRecentTokens }`（`compaction.d.ts:31-38`），默认 `DEFAULT_COMPACTION_SETTINGS = { enabled:true, reserveTokens:16384, keepRecentTokens:20000 }`（`compaction.js:75-79`）。
- 阈值公式：`shouldCompact(contextTokens, contextWindow, settings) => contextTokens > contextWindow - settings.reserveTokens`（`compaction.js:144-148`）。
- 配置途径（**公开**）：`AgentHarnessOptions.compaction`（`agent-harness.d.ts:629`）、`harness.getCompactionSettings/setCompactionSettings`（`:695-696`），变更会发 `config_update property:"compactionSettings"` 事件（`:362-364`，实现 `runtime/harness.js:210-214`）。
- 阈值触发时机：**checkpoint**（每回合边界）调 `prepareCompactionThreshold`（`runtime/drive/checkpoint.js:60`），内部 `prepareCompaction` + `shouldCompact` 决定（`runtime/drive/structural.js:837-869`，判定在 `:863`）。
- overflow 触发时机：**响应结算前** `publishResponse` 判定（`runtime/drive/response.js:111-115`，见 ⑤）。
- manual 触发：`lane.compact(options, context)`（`runtime/lane.js:921-946`，入口 `accept` kind `"compaction"` `lane.js:495-545`）。
- 证据：`compaction.js:75-79,144-148`、`agent-harness.d.ts:362-364,374-395,629,695-696`、`checkpoint.js:60`、`structural.js:837-869`、`response.js:111-115`、`lane.js:495-545,921-946`。

### ④ 压缩如何处理历史消息、工具调用及工具结果（配对是否保持）
**按「切点 + 摘要 + 保留尾段」处理；工具调用/结果配对保持。**
- `prepareCompaction(pathEntries, settings)`（`compaction.js:413-479`）：估算 `tokensBefore`（`:440`），`findCutPoint` 选切点（`:441`），切点前为 `messagesToSummarize`（`:443-448`），切点后为 `retainedTail`（`:457-462`）。
- **配对保持的关键**：`findValidCutPoints` **不把 `toolResult` 作为切点**（`compaction.js:221-222` case `"toolResult": break`），只允许 `user/assistant/bashExecution/custom/branchSummary/compactionSummary` 等作为切点（`:210-224`）。因此切点只会落在 assistant（携带 toolCall）或 user 边界；其后的 `toolResult` 必然与该 assistant 同侧，**不会把 toolCall 与其 toolResult 拆到摘要侧与保留侧**。
- 切点若落在一个**未完成回合**中间（`isSplitTurn`），会把该回合**前缀**单独摘要（`turnPrefixMessages`，`:449-456`；`TURN_PREFIX_SUMMARIZATION_PROMPT` `:480-493`），后缀仍保留；`compactWithRequest` 把前缀摘要与历史摘要拼为一段（`compaction.js:505-520`）。
- 保留尾段随 `compaction` entry **持久化**：`CompactionEntry.retainedTail`（`prepareCompaction` 产出 `compactWithRequest` `:531`；写入 entry 见 `structural.js:155-171`），重建上下文时为 `[summaryMessage, ...retainedTail.filter(isContextMessage)]`（`session/context.js:23-27`）。
- 文件操作从被摘要历史中提取并随摘要记入 `details.readFiles/modifiedFiles`（`compaction.js:16-41`、`computeFileLists`/`formatFileOperations` `:528-530`）。
- 证据：`compaction.js:205-235,252-294,413-479,505-531`、`structural.js:155-171`、`session/context.js:23-27`。

### ⑤ 模型返回 context overflow 时如何自动恢复
**有，且是「每代一次」有界恢复。**
- 检测：`publishResponse` 中 `overflow = isContextOverflow(response, contextWindow) || isRecoverableLength(response, intendedOutputLimit)`（`response.js:111-115`）；这两个判据来自公开包 `@earendil-works/pi-ai`（`response.js:1` import）。
- 恢复：若 overflow 且本代尚未用过恢复门（`!generationContext.overflowRecoveryUsed`），`prepareOverflowCompaction`（`structural.js:872-887`）准备一次压缩任务，`publishResponse` 转为 `summary.deciding` 状态、reason `"overflow"`、并把 continuation 置为 `{ kind:"need_assistant", overflowRecoveryUsed:true }`（`response.js:139-162`）。
- 门控在 `checkpoint.js:41` 与 `boundary.js:12-23` 落实；再次 overflow 时 `overflowRecoveryUsed` 为真 → 直接判失败（`response.js:141-143` `providerError`），**不会无限重试**。
- 证据：`response.js:1,111-162`、`structural.js:871-887`、`checkpoint.js:41`、`boundary.js:12-23`。

### ⑥ 摘要失败 / 压缩失败 / 当前回合无法切分时如何处理
**全部有明确、有界的处理路径。**
- **摘要失败**：`compactWithRequest` 返回 `Result.err(CompactionError)`（`compaction.js:403-408` 对 `aborted`/`error` `stopReason` 分类；`:510-516`/`:523-524` 传播）；`performStructuralAttempt` 转成 `{ kind:"error", retryable }`（`structural.js:644-665`）。`publishAttemptResult`：**可重试则按 `retryPolicy.maxAttempts` 有界重试**（发 `retry_scheduled` 事件，`structural.js:727-750`），否则**终止为 failed**（`:750`）。中断的外部未知结果由 `recoverStructuralGeneration` 转为新编号尝试或终态失败（`:807-834`）。
- **压缩失败终态**：run 内 `resume_checkpoint` 边界 → 发 `compaction_end status:"failed"` + `run_end status:"failed"`（`structural.js:287-329`）；manual `finish` 边界 → `compaction_end status:"failed"`（`:338-370`）。
- **当前回合无法切分 / 无可压缩**：`prepareCompaction` 在 entry 为空或末尾已是 compaction 时返回 `ok(undefined)`（`compaction.js:414-416`）；`findCutPoint` 无有效切点时返回 `firstKeptEntryIndex = startIndex`、`isSplitTurn=false`（`:255-256`）。manual 压缩入口据此返回 `NothingToCompact`（`lane.js:501-508`）。阈值路径同判据直接不发压缩（`structural.js:860-865`）。
- **取消/声明**：`before_compaction` hook 可 `decline`（`structural.js:501-502`；`agent-harness.d.ts:582-591`），发 `compaction_end status:"declined"`。
- 证据：`compaction.js:403-416,255-256,510-528`、`structural.js:287-370,501-502,644-665,727-750,807-834`、`lane.js:501-508`。

### ⑦ 压缩相关事件与 Token usage 是否可观测
**有，且事件类型为公开导出。**
- `HarnessEventPayload` 含：`compaction_start{reason}` / `compaction_end{status, reason, entryId, error}`（`agent-harness.d.ts:374-395`）、`usage{lane, row, totals}`（`:416-419`）、`retry_scheduled/retry_start/retry_end`（`:260-280`）、`config_update`（含 `compactionSettings`，`:362-364`）、`fault`/`handler_error`（`:237-250`）。
- 订阅（公开）：`harness.events.on(type, listener)`（`Events` `:478-482`）、`lane.watch(context)` 返回 `WatchHandle<LaneSnapshot>`（`:130-135`、`:674`）；`LaneSnapshot` 含 `transcript: Entry[]`、`operation.retry`、`stats`（`:174-201`）。
- Token usage：`UsageRow{id,seq,usage,entryId,adjustment,details}`（`session/types.d.ts:320-327`）、`SessionStats{messageCount, usage}`（`:382-385`）、`harness.lane.recordUsage`（`agent-harness.d.ts:662-665`）；`getLastAssistantUsage`/`calculateContextTokens` 公开（`compaction.d.ts:42-44`、`index.d.ts:8`）。
- 遥测 schema 亦登记 `manual|threshold|overflow`（`dist/harness/telemetry.js:316`）。
- 证据：`agent-harness.d.ts:130-135,174-201,260-280,362-364,374-395,416-419,478-482,662-665,674`、`session/types.d.ts:320-327,382-385`、`telemetry.js:316`。

## 3. 公开 vs 内部 API 边界表

### 3.1 公开（root `.` re-export 或 exports 子路径内）

| 符号 | 类型 | 入口 | 证据 |
|---|---|---|---|
| `AgentHarness`（`.create`） | harness 构造器 | root `.` | `dist/index.d.ts:6`（`export * from "./harness/agent-harness.ts"`）；`agent-harness.d.ts:706-715`；`index.js:5` |
| `createAgentHarness` | 工厂 | root `.`（经 `AgentHarness.create` 暴露） | `runtime/harness.js:279-310` |
| `HarnessEvent` / `HarnessEventPayload` / `Events` / `Hooks` / `HookMap` / `LaneSnapshot` / `SessionSnapshot` / `OperationRequest` | 事件与钩子类型 | root `.` | `agent-harness.d.ts:206-615` |
| `AgentHarnessOptions` / `AgentLane` | 选项与 lane 接口 | root `.` | `agent-harness.d.ts:617-675` |
| `CompactionSettings` / `CompactionPreparation` / `CompactResult` / `CompactionError` | 压缩类型 | root `.` | `dist/index.d.ts:8,20` |
| `DEFAULT_COMPACTION_SETTINGS` / `shouldCompact` / `prepareCompaction` / `compact` / `estimateContextTokens` / `estimateTokens` / `calculateContextTokens` / `getLastAssistantUsage` / `findCutPoint` / `findTurnStartIndex` / `generateSummary` / `generateSummaryWithUsage` / `serializeConversation` | 压缩原子件 | root `.` | `dist/index.d.ts:8` |
| `MemorySessionRepo` / `JsonlSessionRepo` / `StorageBackedSession` / `SessionInvariantError` 等 | 会话仓储与错误 | 子路径 `./harness/session` | `harness/session/index.d.ts:5-8` |
| `Session` / `SessionRepo` / `Entry` / `Branch` / `UsageRow` / `SessionStats` / `SessionMetadata` 等 | 会话类型 | 子路径 `./harness/session`（`export * from "./types.ts"`） | `session/index.d.ts:9`；`session/types.d.ts` |
| `Context` / `BACKGROUND_CONTEXT` / `createContextKey` / `withContextValue` … | 运行上下文 | 子路径 `./harness/context` | `harness/context.d.ts:4` |
| `reduceLaneSnapshot` | 快照 reducer | 子路径 `./harness/runtime/reducer` | `runtime/reducer.d.ts:4` |
| `NodeExecutionEnv` | Node 执行环境 | 子路径 `./harness/env/nodejs`（亦经 `./node`） | `harness/env/nodejs.d.ts:3`；`node.d.ts:1` |
| 会话一致性测试夹具 | 测试 | 子路径 `./harness/session/testing` | `session/testing/index.d.ts` |

### 3.2 内部（`dist/**` 深路径、不在 exports map 内，消费者 import 不到）

| 内部符号/模块 | 定义处 | 为什么不公开 |
|---|---|---|
| `prepareCompactionThreshold` | `runtime/drive/structural.js:837` | 仅被 `checkpoint.js:7` 内部 import；深路径不可达 |
| `prepareOverflowCompaction` | `runtime/drive/structural.js:872` | 仅被 `response.js` 内部 import |
| `publishResponse` / `runCheckpoint` / `startRun` / `driveOperation` | `runtime/drive/*.js` | 深路径不可达 |
| `generateSummaryWithRequest` / `compactWithRequest` / `createSummaryRequestOptions` / `completeSimpleWithRetries` / `SUMMARIZATION_SYSTEM_PROMPT` | `compaction.js:60,69,295,378,500` | 不在 `dist/index.d.ts:8` re-export 列表 |
| `buildContextEntries` / `sessionEntryToContextMessages` / `buildSessionContext` | `harness/session/context.js:2,19,34` | `./harness/session` 未 re-export `./context.ts` |
| `runtime/lane.js` 内部管线 | `runtime/lane.js` | 深路径不可达（只经 `AgentHarness`/`AgentLane` 接口） |

> **边界结论**：**原子件 + 类型 + AgentHarness 接口 + Session 仓储 = 公开**；**驱动管线的内部函数 = 内部**。替换实验**不去 import 内部函数**——而是让公开的 `AgentHarness` 在内部驱动它们。这满足任务「只依赖公开 API」的约束。

## 4. 完整生命周期能力清单（准入五项，逐项判定）

| # | 能力 | 有/无 | 公开可达 | 证据 |
|---|---|---|---|---|
| 1 | **Session 转录管理**（持有完整对话、跨回合追加、持久化/恢复） | **有** | 是（`AgentHarness` root `.`；`Memory/JsonlSessionRepo` `./harness/session`） | §2①/② |
| 2 | **自动压缩触发**（threshold 于 checkpoint；manual；配置可更） | **有** | 是（`AgentHarness` 内部驱动；`compaction` 选项/`setCompactionSettings`/`lane.compact` 公开） | §2③ |
| 3 | **原生摘要及尾段保留**（摘要生成 + `retainedTail` 持久化 + 重建上下文） | **有** | 是（同上，`AgentHarness` 驱动） | §2④ |
| 4 | **Overflow Recovery**（context overflow 自动恢复、每代一次门控） | **有** | 是（同上） | §2⑤ |
| 5 | **有界失败处理**（摘要失败有界重试/终态失败；无法切分→跳过/`NothingToCompact`；decline） | **有** | 是（同上） | §2⑥ |

**结论：五项能力齐备，且均可经公开 API（`AgentHarness` + `./harness/session`）抵达。**

## 5. 接入路径（fshine 需要接哪几个公开入口、最小形态）

**当前 fshine 现状**（`packages/agent/src/pi-driver.ts`）：用 root `.` 的 `Agent` + 自填 `transformContext`（`pi-driver.ts:6,878-902`）+ **自研编排** `compactTranscriptWithPi`（`:634-`）、`compactionSettingsFor`（`:342`）等；**未使用** `AgentHarness`/`Session`。

**替换所需公开入口（最小形态）：**
1. `import { AgentHarness } from '@earendil-works/pi-agent-core'`（root `.`）。
2. `import { MemorySessionRepo /* 或 JsonlSessionRepo */ } from '@earendil-works/pi-agent-core/harness/session'`；`const session = await repo.create(meta, ctx)`。
3. `import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context'`（或自建 chord Context）。
4. `const { harness } = await AgentHarness.create({ session, models, model, tools, compaction }, ctx)`。
5. `const lane = await harness.lane('main', ctx)`；每回合 `await lane.prompt(text, undefined, ctx)`——**同一 session/lane 跨回合复用**。
6. 观测：`harness.events.on('compaction_start'|'compaction_end'|'usage', ...)`、`harness.hooks.on('before_compaction', ...)`。
7. 阈值配置：`AgentHarnessOptions.compaction` 或 `harness.setCompactionSettings({...}, ctx)`。

**最小形态边界**：fshine 只需**三处公开入口**——`AgentHarness`（root `.`）、`SessionRepo`（`./harness/session`）、`Context`（`./harness/context`）；压缩/阈值/溢出/失败恢复**全部交给 `AgentHarness` 内部管线**，不再自研。**不 import 任何 §3.2 内部符号、不复制 Pi 源码。**

## 6. 最小可运行原型计划（阶段二：证伪/证实）

> 阶段一零真实模型。阶段二可用**假 `Models`/假 stream fn**（Pi 公开的 `setDefaultStreamFn`，`index.d.ts:26`）驱动，仍可做到零真实模型调用。

| # | 场景 | 判据（通过=证实） |
|---|---|---|
| S1 | 跨回合转录连续性：同 session 连续两次 `lane.prompt` | 第二回合上下文含第一回合消息；`session` entry 链连续；分支 tip 前移 |
| S2 | threshold 自动压缩：把 `reserveTokens` 设小以强制触发 | 发 `compaction_start reason:"threshold"` → 写入一条 `type:"compaction"` entry（含 `summary`+`retainedTail`）→ `compaction_end status:"completed"` |
| S3 | overflow 恢复：假 provider 首答构造 context overflow、次答正常 | 发 `compaction_start reason:"overflow"` → 压缩 → 自动续跑；**第二次** overflow → `run_end status:"failed"`（有界，无死循环） |
| S4 | 工具配对：造 assistant(toolCall)+toolResult 后触发压缩 | 切点不落在 toolResult；`retainedTail` 中 toolCall 与 toolResult 同侧 |
| S5 | 摘要失败有界：假 provider 摘要步持续报 `error` | 发至 `retryPolicy.maxAttempts` 次 `retry_scheduled` 后 `compaction_end status:"failed"`；**不无限重试** |
| S6 | 无可压缩：空会话/末尾已 compaction 调 `lane.compact` | 返回 `NothingToCompact`，无 provider 调用 |

**反证目标（证伪）**：若上述任一场景无法仅用 §3.1 公开入口装配出等价行为，或必须 import §3.2 内部符号，则「公开可达」不成立 → 记 NO-GO。

## 7. GO / NO-GO 判定

**判定：GO（能力准入层面通过；条件式）。**

- 准入条件「五项能力齐备」：**满足**（§4，逐项有一手 `文件:行号` 证据）。
- 准入条件「公开可达」：**满足**——`AgentHarness`（root `.`）+ `SessionRepo`（`./harness/session`）+ `Context`（`./harness/context`）构成完整公开生命周期入口；内部管线（§3.2）由 `AgentHarness` 内部驱动，**无需消费者 import**。硬门「不得靠复制 Pi 内部实现或自研编排伪装迁移成功」——本路径**不复制、不自研**，靠公开 `AgentHarness`。
- **条件**（阶段二须关闭的不确定性）：
  1. **装配可行性未实测**：`AgentHarness.create` + fshine 的 `Models`/工具面/多 principal 会话模型能否真实装配，**零真实模型下未跑通**——由 §6 原型证实/证伪。
  2. **成本与影响面不在本阶段结论范围**：本判定是**能力与公开可达性**结论，**不**回答「迁移是否值得」。既有 `docs/product/pi-compaction-decision.md:10` 的 `RECOMMENDED_OPTION=A（自研编排保留）` 是**成本导向**结论，与本阶段**能力导向** GO **不矛盾**，但两者对「是否迁 Session」取向相反——须由 owner 在阶段二数据齐备后统一裁定。

**若阶段二 S1–S6 中任一在仅用公开入口前提下无法成立 → 转 NO-GO**，届时须给出阻塞点与对应源码证据（本阶段未发现此类阻塞）。

## 8. 未验证项（不默认通过）

- 本阶段**未运行**任何 `AgentHarness`/Session 装配代码（worktree 无 `node_modules`，且阶段一硬约束为零真实模型、零产品代码）。所有运行路径结论为**静态源码/类型**阅读所得。
- `AgentHarness` 作为**跨包消费者 API 的稳定性**（0.85.1 是否将 harness 视为对外契约）**未由 Pi 文档/变更日志交叉验证**；仅按 `package.json exports` + `dist/index.d.ts` 的导出事实判定为公开。
- 前文 r5-piopt 四文档（`pi-compaction-api-audit.md` 等）亦为静态阅读，未运行 harness 管线（其 §4 亦自述未运行）。
- 多 principal / 企业会话模型与 Pi `SessionMetadata` 的映射未核（属阶段二影响面）。
