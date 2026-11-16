# Pi 1.5.2 · 阶段 B：压缩 / 摘要 / 溢出恢复（真实重放 + 确定性注入）

- 性质：预注册实验（判据写于首次真实模型调用之前），N=1 会话/场景、一次采样、不重跑、不筛绿。
- 模型：`step-3.7-flash`；装配：迁移后的 `createAgentSession`（`@earendil-works/pi-coding-agent@1.5.2`）+ 产品驱动 `createPiTurnDriver`。
- 配置（跑前写死）：上下文窗口 16,384、`maxTokens` 2,048、压缩 `{enabled:true, reserveTokens:4096, keepRecentTokens:4915}`、`thinkingLevel=off`、工具面 = 单一 `bridge_exec`（allowlist，禁内置 read/bash/edit/write）。
- 样本：A（长对话连续压缩，计划 16 回合）、B（多任务交替交办，计划 12 回合）、probe（1 回合传输层探针）。
- 预算：`maxModelCalls ≤ 60`、`maxTokens ≤ 1,200,000`、墙钟 ≤ 40 min；本轮未触发硬停（`stoppedAtLimit=false`）。
- 原始证据：`.runtime/pi152-stageB/{prereg.md,trace.md,injection/report4.json,A/,B/,probe/}`（`.runtime/` 已被 `.gitignore` 忽略，不入库；本文只复述原始读数）。

## 1. 真实重放总读数

| 场景 | 回合 | 模型调用 | 摘要调用 | totalTokens | 墙钟 | 压缩（完成/失败） | 空回合 | 越窗 | 工具执行 | 重复执行 | 达限 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 16 | 31 | 13 | 470,059（in 63,807 / out 26,476） | 187,262 ms | 12（1 / 11） | 12 | 0 | 1 | 0 | 否 |
| B | 12 | 23 | 6 | 246,416（in 74,404 / out 13,420） | 101,360 ms | 6（3 / 3） | 4 | 3 | 4 | 0 | 否 |
| probe | 1 | 1 | 0 | 6,929（in 3,996 / out 181） | 2,213 ms | 0 | 0 | 0 | 0 | 0 | — |

- 空回合（`reply.trim()===''`）：A = 回合 5–16（12 个），B = 回合 9–12（4 个）；逐回合 `error` 均为 `null`，无失败面上抛。
- 越窗：`overWindowCount` A=0、B=3（压缩后首个主请求 promptTokens 17,891 / 17,757 / 17,697 > 16,384）。
- 工具执行：A 仅 1 次 `query(collection=alpha, window=recent)`；B 4 次（`query`、`task_status`、`task_result`、`task_cancel`），其中后三者返回 `unsupported_operation`。`duplicateToolExecs` 两场景均为空。

### 1.1 压缩逐次读数

A：

| 回合 | reason | 结果 | summaryChars | tokensBefore | estimatedTokensAfter | 压缩后首个主请求 promptTokens |
| --- | --- | --- | --- | --- | --- | --- |
| 6 | overflow | 完成（`willRetry=true`） | 1,706 | 8,409 | 7,049 | 15,069 |
| 9–13 | overflow | 失败（`length`） | — | — | — | — |
| 14–16 | threshold + overflow | 均失败（`length`） | — | — | — | — |

B：

| 回合 | reason | 结果 | summaryChars | tokensBefore | estimatedTokensAfter | 压缩后首个主请求 promptTokens |
| --- | --- | --- | --- | --- | --- | --- |
| 6 | threshold | 完成 | 755 | 13,416 | 6,927 | 17,891 |
| 7 | overflow | 失败（`length`） | — | — | — | — |
| 8 | overflow | 完成 | 2,688 | 17,968 | 8,245 | 17,757 |
| 10 | overflow | 完成（`willRetry=true`） | 3,313 | 10,282 | 8,192 | 17,697 |
| 11–12 | overflow | 失败（`length`） | — | — | — | — |

## 2. P1 六问（判据跑前冻结）

| # | 问题 | 读数 | 判定 |
| --- | --- | --- | --- |
| P1-1 | 触发时机：`reason` 与 `tokensBefore` 是否符合口径（threshold 需 `tokens > 16,384−4,096 = 12,288`） | 可核对样本仅 B 回合 6（threshold，13,416 > 12,288，符合）。A 仅 1 次完成的压缩是 overflow（8,409，由 provider error 触发）；A 的 3 次 threshold 压缩全部失败，无 `tokensBefore` 读数 ⇒ 无法核对 | 部分可核对：1/1 符合；失败样本无读数 |
| P1-2 | 估算 vs 实际：压缩后首个主请求 `promptTokens` 对比 Pi 估算 | A：8,409 vs 15,069。B：13,416 vs 17,891；17,968 vs 17,757；10,282 vs 17,697。B 的 3 次越窗；A 0 次越窗 | **FAIL**（存在越窗） |
| P1-3 | 压缩后上下文：`summaryChars` / `estimatedTokensAfter` / 首个主请求 | A：1,706 / 7,049 / 15,069（实际为估算的 2.1 倍）。B：见上表（估算 6,927→实际 17,891 等） | 读数已记；压缩后上下文估算系统性偏低 |
| P1-4 | 溢出恢复有界性：`willRetry`、`auto_retry_*`、`summarization_retry_*`、同回合二次恢复 | overflow 事件共 14 次（A 9 / B 5），成功 4 次（A 1 / B 3）、有界失败 10 次；`willRetry=true` 仅 A 回合 6、B 回合 10；`autoRetries=0`、`summarizationRetries=0`；无同回合二次 overflow 恢复 | **PASS**（有界，无无限重试）；注意恢复成功率 4/14 |
| P1-5 | 失败时用户看到什么：空回复且无显式失败 = FAIL | A 12/16 空回合、B 4/12；逐回合 `error=null`，无失败通知 | **FAIL**（静默空回复） |
| P1-6 | 重复执行可能：同回合同 `(operation,args)` 执行 >1 次 | 真实重放：两场景 0；确定性注入 D-duplicate：同一 `create_record` 执行 **2 次**（同 turn 同 args） | 真实样本未触发；确定性注入复现 ⇒ 机制存在，按预注册合并口径记 **FAIL** |

## 3. P2 八问

| # | 问题 | 读数 | 判定 |
| --- | --- | --- | --- |
| P2-1 | `maxTokens` 来源 | 实验装配显式传入 `maxTokens: 2,048`（重放脚本的 `MAX_TOKENS`，写入 `createPiModelRuntime(..., {contextWindow:16384, maxTokens:2048})`）；产品缺省是 32,000（`packages/agent/src/pi-driver.ts:66`、`:237`） | 明确：2,048 是实验/历史配置，不是迁移带入的产品缺省 |
| P2-2 | 摘要实际输出预算 | 传输层记录：摘要请求全部带 `max_completion_tokens=2048`（A 13/13、B 6/6）；调用记录里 `reqMaxTokens=null`（Pi 未传 `maxTokens`，由 provider 补 `model.maxTokens`）。A 11 次摘要 `output=2048` 且 `stopReason=length`；B 3 次（回合 7/11/12）同样触顶 | 摘要实际预算 = `model.maxTokens`（2,048），触顶即被拒 |
| P2-3 | reasoning 占用 | 54 次真实调用 `usage.reasoning` 全为 0。A 的 12 次 1-token 主响应，其唯一 token 是 thinking 块（会话 JSONL 尾部 `{"type":"thinking",...}`），但 provider 记 `reasoning=0` | `reasoning` 字段为 0，但思考内容仍与正文共享输出预算（见 U2） |
| P2-4 | `length` 拒绝 | 被拒，文案 `Summarization failed: generation hit the token cap and the summary is incomplete`（阈值路径外层为 `Auto-compaction failed: …`，溢出路径为 `Context overflow recovery failed: …`）；失败事件无 `result`，不写 compaction entry | **PASS**（拒绝生效） |
| P2-5 | `stop` + 空正文 | 真实重放未出现（A/B `emptySummaryCount=0`）；确定性注入 T-empty/T-ws 证明会被接受并入档 | 真实样本 NOT_OBSERVED；确定性 **FAIL**（上游，见 U1） |
| P2-6 | 无效摘要入库 | 真实 4 次完成的压缩（A 1 / B 3）中空摘要 0 次（0/4）；确定性注入 T-empty、T-ws、O-empty 均写入空/空白 summary | 真实 PASS；确定性 **FAIL**（上游） |
| P2-7 | 失败后原历史保留 | 确定性 T-length：21 条 message 全在、0 条 `context_edit`；O-length：21 条 message + 2 条 `context_edit`。真实 A 的 10 个主请求 `hasFact` 全为 true（失败压缩未删条目） | 条目保留；但用户侧仍可能空回复（P1-5） |
| P2-8 | 事实找回 | A 回合 7（追问项目代号与语言）回复为空（`replyLen=0`，`assistantCount=0`）；回合 14 再次追问同样为空 | **FAIL**（未找回） |

## 4. 确定性注入（零真实模型；仓内假 stream）

窗口 32,768 / reserve 4,096 / keepRecent 2,048；装配为主请求脚本 + 摘要脚本。读数来自 `injection/report4.json`。

| 注入 | 构造 | 结果 |
| --- | --- | --- |
| T-length | 阈值压缩 + 摘要 `stopReason=length` + 部分正文 | `compaction_end(failed)`：`Auto-compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete`；**无** compaction entry；21 条原消息全在；同一会话连续 3 次尝试均失败；用户看到正常回复（`本轮答复。`），失败不可见 |
| T-empty | 阈值压缩 + 摘要 `stop` + `text:''` | `compaction_end(completed)`，`summary=""` **入库**（`summaryChars=0`）；下一主请求 `hasFact` 由 true→false（call 9） |
| T-ws | 阈值压缩 + 摘要 `stop` + `text:'  \n\t '` | 同上，`summaryChars=5` 原样入库；下一主请求事实消失 |
| O-length | 溢出恢复 + 摘要 `length` | `Context overflow recovery failed: …`；无 entry；`entriesAfterFailure={messages:21, contextEdits:2}`；产品驱动最终返回**上一回合旧答复**（`finalText='历史答复 7。'`） |
| O-empty | 溢出恢复 + 摘要 `stop` + 空正文 | 空摘要入库（`summaryChars=0`、`willRetry=true`）；重试仍溢出 → `Context overflow recovery failed after one compact-and-retry attempt. …`；`finalText=''`，仅两条 `pi_driver_empty_reply` 警告（assistant `stopReason=error` + user 文本块） |
| D-duplicate（产品驱动层） | 回合 1 发 `bridge_exec(create_record, id=rec-X)` → 工具结果后返回 overflow → 恢复压缩（正常摘要）→ 重试再次给出同一 toolCall | 同一 `create_record` **执行 2 次**（`execs` 长度 2，同 turn 同 args）；最终 `finalText='已完成。'` |

## 5. 上游缺陷（deterministic minimal repro + 源码行号；未修改已安装 Pi 包）

以下行号基于 `@earendil-works/pi-coding-agent@1.5.2` / `@earendil-works/pi-ai@1.5.2` 的 `dist` 只读文件。

### U1 · 空 / 全空白摘要被接受并持久化

- 最小复现：T-empty（`summary=''`）与 T-ws（`summary='  \n\t '`）→ `compaction_end(completed)` 且 compaction entry 入库，下一次主请求事实消失。
- 源码：`core/compaction/compaction.js:454-462` `getSummarizationFailure` 只拒 `stopReason==='error'` 与 `'length'`，不检查正文是否为空；`:463-469` `createSummarizationOptions` 只组装 `signal/apiKey/headers/env/sessionId`（及可选 `reasoning`），不设 `maxTokens`。
- 预期行为：摘要正文为空或全空白时应按失败处理，不写 checkpoint。
- 影响：事实丢失（`factInMain` true→false），且用户侧无失败面。

### U2 · 输出预算被 `model.maxTokens` 与上下文 clamp 双重压缩

- 最小复现：probe 回合 1 次请求即带 `max_completion_tokens=2048`；真实重放 A 11 次、B 3 次摘要 `output=2048` 且 `stopReason=length`；A 另有 12 次主响应只产出 1 token（thinking 块）后结束。
- 源码：`api/simple-options.js:11` `MIN_MAX_TOKENS = 1`；`:13-24` `clampMaxTokensToContext`（`room = contextWindow − input − max(4096, 15%·input)`，窗口小时再取 `min(32768, contextWindow − input − 4096)`，最后 `min(maxTokens, max(1, room))`）；`:36` `maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens)` —— 摘要请求未传 `maxTokens`，因此缺省取 `model.maxTokens` 再被 clamp；`api/openai-completions.js:578-585` 有 `options.maxTokens` 就写 `max_tokens`/`max_completion_tokens`。
- 预期行为：摘要应有独立于 `model.maxTokens` 的输出预算，且不应被压到 1 token；至少在触顶时应返回可辨识失败而不是空正文。
- 影响：摘要频繁 `length` 失败；主请求被压到 1 token 时产生空回合（P1-5）。

### U3 · 溢出恢复重试会重新执行同一非幂等工具

- 最小复现：D-duplicate，同一 `create_record(id=rec-X)` 在同一回合被执行 2 次。
- 源码：`core/agent-session.js:2563-2567`（`_overflowRecoveryAttempted = true`；`_omitRecoveryAttempt(assistantMessage)`；`_runAutoCompaction("overflow", willRetry)`；成功则 `_failedResponse = assistantMessage`）→ 运行循环 `:1516-1525` 在 `_handlePostAgentRun()` 返回真后 `await this.agent.continue()`。`:902-928` 的 `_omitRecoveryAttempt` 只对失败尝试（及其 toolResult）追加 `context_edit` 把它从投影中隐藏（`appendContextEdit(targetId, null)`），**不能回滚已经发生的副作用**，也不阻止模型在重试中再次发出同一 toolCall。
- 预期行为：溢出恢复重试不得重复执行非幂等操作；宿主/执行层必须携带幂等键（本轮未在 Pi 之外加治理）。
- 影响：非幂等写入可能重复（真实重放本次未触发，但机制存在）。

## 6. 判读（不美化）

- 阶段 B 的核心失败是**静默空回复**（A 12/16、B 4/12）与**压缩后越窗**（B 3 次），二者与 U2（输出预算被压到 2048 / 1 token）直接相关；真实样本的摘要失败全部是 `length`。
- 空摘要入库、溢出重试重复执行两条上游缺陷只在确定性注入中复现，真实 N=1 样本未触发；不得据此写成「真实运行无此问题」。
- 真实样本的 `duplicateToolExecs` 为空，但 D-duplicate 已证明恢复重试存在重复执行面。
- 事实找回（P2-8）在 A 回合 7 未完成（空回复）；转录里事实仍在（`hasFact` 全 true），不能据此判 PASS。
