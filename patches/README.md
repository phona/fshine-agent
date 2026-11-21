# Pi 1.5.2 依赖补丁登记（patch-package）

> 规则：**不 Fork、不复制整包、不改 Pi 之外的运行时代码**；每个补丁只改 npm 发布包里**实际被执行**的文件，
> 记录完整 diff、包名与版本、缺陷来源（源码行号）、删除条件（上游修好即删）。补丁可撤销：删 `patches/` +
> `rm -rf node_modules && npm ci` 即回到上游原状。

## 机制

- 工具链事实：npm **11.19.0**，**没有原生 `npm patch`**（`npm patch` exit 1）⇒ 用 `patch-package@8.0.1`。
- 接线：`devDependencies.patch-package` + `scripts.postinstall = "patch-package"`；补丁目录 `patches/`。
- 已验证：把 `simple-options.js` 还原为上游原件（md5 `ceb6c7bb…`）后 `npm run postinstall` →
  `patch-package 8.0.1 · Applying patches… @earendil-works/pi-ai@1.5.2 ✔` → 文件回到补丁态（md5 `4e26cfb0…`）。
- 补丁守卫测试：`packages/agent/pi-152-u1-output-floor.test.ts`（无补丁时 4 例红、1 例绿；有补丁 5 例绿）；
  `packages/agent/pi-152-u2-empty-summary.test.ts`（无 U2 补丁时 5 例中 4 例红、1 例正向对照绿；有补丁 5 例绿）。
- 常驻绊线：`packages/agent/pi-152-patch-applied-tripwire.test.ts`（断言 U1 `derivedFloor` 与 U2 写库拒绝
  确实存在且生效；实测 `--reverse` 后 `4 failed | 1 passed (5)`，重新打上后 `5 passed (5)`；
  2026-11-16 独立复核复跑一致）。
- 当前补丁栈（两个包、三个文件）：`@earendil-works+pi-ai+1.5.2.patch`（U1）、
  `@earendil-works+pi-coding-agent+1.5.2.patch`（U2）。`npm run postinstall` 输出两行 ✔ 即全部就位。

## 证据更正：`report4.json` 曾被重跑覆盖（2026-11-16）

U2 提交（`b930b34`）当时引用的 `.runtime/pi152-stageB/injection/report4.json` 是**补丁前**读数
（T-empty → `compaction_end(completed)`、`summary:""` 入库、下一回合 `hasFact=false`）。该文件随后在
**2026-11-16 10:29:48** 被同一脚本的**补丁后**重跑覆盖，原「修复前」内容已不在该路径上。独立复核据此判
`passed=false`：引用目标与所声称的补丁状态不一致。

更正方式：**不修改旧证据内容、不改判据**；用 `patch-package --reverse` / `patch-package` 两次受控运行
重新生成前后对照，并把原始 JSON 的**机械投影**提交为仓库内不可变文件。下表两份均为
**2026-11-16 重新复现**（re-generated），**不是**被覆盖的 `.runtime/.../report4.json` 历史原始件：

| 读数 | 不可变证据文件 | 补丁状态 | 生成命令 |
|---|---|---|---|
| **补丁前** | `docs/product/evidence/pi152-u2-injection-prepatch.json` | reverse（node_modules 回到上游 1.5.2 原状） | `TMPDIR=<临时目录> node --import tsx scripts/eval/pi152-stageB/injection.ts` |
| **补丁后** | `docs/product/evidence/pi152-u2-injection-postpatch.json` | applied（U1+U2 两个补丁就位） | 同上 |

**完整性锚点（独立复审缺口补登）**：两份证据文件的入库 pin 是 `c61e784`（`git log -1 -- docs/product/evidence/`）。
`git pin` 是权威（`git cat-file -p <commit>:<path>` 可逐字节取回）；md5 是**同一 pin 的便利校验值**，
与 `git cat-file -p` 输出一致（2026-11-16 复核）：

| 证据文件 | md5（与 pin c61e784 一致） | 字节 |
|---|---|---|
| `docs/product/evidence/pi152-u2-injection-prepatch.json` | `346f5ed93bf4506aa2f9abcc59839ec2` | 6179 |
| `docs/product/evidence/pi152-u2-injection-postpatch.json` | `cecdc56d7843777126b840c92ba83d9f` | 6840 |

校验方式：`md5sum docs/product/evidence/*.json`；若与上表不符，以 `git pin`（c61e784）为准并在台账登记漂移。

- 两份 JSON 由上述脚本的原始 JSON 输出**机械投影**（未手写数字），只保留判定字段：每用例 `finalText`、
  `hasFact`（最后一次主请求）、`compactionEnded`、`compaction_end` 的
  `errorMessage`/`summary`/`summaryChars`、落库 `compactionEntries`。
- 生成时间：2026-11-16T11:10:40+08:00。撤销/重打均以 grep 验证：reverse 后 `simple-options.js` 无
  `MIN_DERIVED_MAX_TOKENS`、`session-manager.js` 无 `Refusing to append a compaction entry`；applied 后
  两者分别出现在 `simple-options.js:15/:41` 与 `session-manager.js:897`。
- `.runtime/**` 是 gitignored 的原始运行产物，**不得作为引用目标**。本文件凡涉及可复核判据，只引用
  `docs/product/evidence/` 下这两份文件；其余章节提到的 stageB/stageU1 原始产物同样 gitignored、未入库，
  其数字只作当次记录，不冒充可复核证据。

## P1 · `@earendil-works/pi-ai@1.5.2` — U1 输出预算被夹到 1 token

**包/版本**：`@earendil-works/pi-ai@1.5.2`（`node_modules/@earendil-works/pi-ai`，无嵌套第二份副本；顶层
`@earendil-works` 侧仅一份 `pi-ai`/`pi-agent-core`，均 1.5.2）。

**文件**：`dist/api/simple-options.js`（实际执行；`openai-completions.js:505` 的 `streamSimple` 展开
`buildBaseOptions(...)`，再由 `:578-585` 写 `max_completion_tokens`）。

**来源（原缺陷出处）**：

- `dist/api/simple-options.js:13-23` `clampMaxTokensToContext`：`room = contextWindow − input − max(4096, 15%·input)`；
  `room < 32768` 时改为 `min(32768, contextWindow − input − 4096)`；返回 `min(maxTokens, max(1, room))`。
  输入接近窗口（本例 estimate 12288 = 16384−4096）时 `room = 0`，返回 **1**。
- `dist/api/simple-options.js:36`：`maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens)`
  —— 未区分「调用方显式要求」与「取 `model.maxTokens` 缺省」。
- `dist/api/openai-completions.js:578-585`：有 `maxTokens` 就写 `max_completion_tokens` ⇒ 真实请求
  `max_completion_tokens: 1`（证据：stageB 原始运行产物，当次记录 A 12 次 / B 5 次；该产物 gitignored、
  未入库，见「证据更正」节）。
- 后果：thinking 模型的唯一 token 落在 thinking 块，正文为空、`stopReason=length`、`usage.reasoning=0`
  （stageB 轨迹记录 J3，同上未入库）。

**根因复核与原文纠正（2026-11-16，插桩实测）**：

- **原文错在哪一句**：旧版本节末写「上层看不出错误」。它与同节「验证读数」的 A 前
  `压缩 start/完成/失败 = 12 / 1 / 11`、以及「剩余上下文不足的去向」里
  `isRecoverableLength → compaction_start(reason=overflow)` 自相矛盾：若上层看不出错误，
  就不会有 12 次压缩启动。该句作废，正确因果链见下。
- **调用点实参（逐处核对实际执行文件）**：全仓 `isRecoverableLength` 仅一个调用点
  `pi-coding-agent/dist/core/agent-session.js:2533`
  `isRecoverableLength(assistantMessage, messageModel.maxTokens)`；`messageModel` 来自
  `:2499 this._modelForMessage(assistantMessage)`（`:313-318`：非虚拟模型即当前模型），
  所以实参是**模型声明的 `maxTokens`（本例 2048，未夹紧）**，既不是本次请求实发的
  `max_completion_tokens`（clamp 后的 1/1024），也不是显式 `options.maxTokens`。
  这与 `pi-ai/dist/utils/overflow.js:174-176` 的调用约定一致（"original limit before any
  context-based clamping"）；实现见 `:177-178`。
- **实测分支走向**（一次性临时插桩：用同一组参数调用真实
  `buildBaseOptions`/`isRecoverableLength`，再对真实 `AgentSession._checkCompaction`
  注入 length 消息并读事件；不改包内源码逻辑）：

  | 补丁状态 | 本次请求实际 cap | 注入消息 | `isRecoverableLength(msg, 2048)` | 实际分支 |
  |---|---|---|---|---|
  | reverse（上游原状） | 1 | `stopReason=length`, `usage.output=1` | **true** | `compaction_start(reason=overflow)`；摘要请求 cap=1 → `compaction_end` 带 `Context overflow recovery failed: Summarization failed: generation hit the token cap…`、`willRetry=false` |
  | applied（U1+U2） | 1024 | `stopReason=length`, `usage.output=1024` | **true** | `compaction_start(reason=overflow)`；摘要请求 cap=1024 → 摘要成功、`compaction_end(willRetry=true)` |

  反事实对照（同一实测脚本）：把实参换成「本次请求实际 cap」（1 或 1024）时
  `isRecoverableLength` 均为 **false**——即「补丁前按请求 cap 传参」会漏掉恢复；
  现有调用点传的是 `model.maxTokens`，所以 1-token 回合仍被判为可恢复。
  另：`isContextOverflow` 的 length 分支要求 `usage.output === 0`（`overflow.js:163`），
  1-token 回合不满足，因此本例不是被 overflow 判据捕获，而是被 `isRecoverableLength` 捕获。
- **纠正后的因果链**：`room<1024` → 请求 cap=1（摘要请求同样 cap=1）→ thinking 吃掉唯一
  token、正文空、`stopReason=length`、`output=1` → `isRecoverableLength(msg, model.maxTokens=2048)`
  = true → 进入有界 compact-and-retry；但**恢复所用的摘要请求走同一 clamp、cap 同为 1** →
  摘要 `length` → 恢复失败（有界失败，带 `errorMessage`）→ 用户最终看到空正文。
  即：上层**看得出**异常并尝试恢复，失败点在恢复路径自身也被夹到 1 token；不是「上层看不见」。
  补丁把主请求与摘要请求的 room 推导值都抬到 1024，恢复才得以完成。

**修复思路（最小）**：只给「由 room 推导出来的上限」加下限，且**只在调用方未显式给 `maxTokens` 时**生效；
显式 `options.maxTokens` 传 `derivedFloor = 1`，仍只受 room 约束（不会被下限抬高）。下限取 **1024**，
依据：同文件 `simple-options.js:62` 已有 `MIN_ANSWER_TOKENS = 1024`（Pi 自己对「与 thinking 预算共享天花板时
留给答复的最小 token 数」的定义），不引入新魔数；且该下限只在 `room < 1024` 时改变结果，浅上下文请求一字不变。

**完整 diff**（`patches/@earendil-works+pi-ai+1.5.2.patch`）：

```diff
diff --git a/node_modules/@earendil-works/pi-ai/dist/api/simple-options.js b/node_modules/@earendil-works/pi-ai/dist/api/simple-options.js
index a119bf9..1c4fd32 100644
--- a/node_modules/@earendil-works/pi-ai/dist/api/simple-options.js
+++ b/node_modules/@earendil-works/pi-ai/dist/api/simple-options.js
@@ -9,8 +9,12 @@ const CONTEXT_SAFETY_RATIO = 0.15;
 // output is capped at this size so an OpenRouter overcount still fits for a while before compaction.
 const MIN_OUTPUT_WITH_RATIO_MARGIN = 32768;
 const MIN_MAX_TOKENS = 1;
+// fshine patch U1: floor for a context-derived clamp when the caller requested no size (same value as
+// MIN_ANSWER_TOKENS below). Without it a nearly full window collapses the request cap to 1 token and a
+// thinking model spends it on a thinking block, answering with empty text.
+const MIN_DERIVED_MAX_TOKENS = 1024;
 /** Fit maxTokens into the context window, leaving room for the input being counted higher than estimated. */
-export function clampMaxTokensToContext(model, context, maxTokens) {
+export function clampMaxTokensToContext(model, context, maxTokens, derivedFloor = MIN_MAX_TOKENS) {
     if (model.contextWindow <= 0)
         return Math.max(MIN_MAX_TOKENS, maxTokens);
     const input = estimateContextTokens(context).tokens;
@@ -19,7 +23,7 @@ export function clampMaxTokensToContext(model, context, maxTokens) {
     if (room < MIN_OUTPUT_WITH_RATIO_MARGIN) {
         room = Math.min(MIN_OUTPUT_WITH_RATIO_MARGIN, model.contextWindow - input - CONTEXT_SAFETY_TOKENS);
     }
-    return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, room));
+    return Math.min(maxTokens, Math.max(derivedFloor, room));
 }
 export function resolveSamplingParams(model, thinkingLevel, requestParams) {
     const effectiveThinkingLevel = clampThinkingLevel(model, thinkingLevel);
@@ -30,10 +34,11 @@ export function resolveSamplingParams(model, thinkingLevel, requestParams) {
 }
 export function buildBaseOptions(model, context, options, apiKey) {
     const samplingParams = resolveSamplingParams(model, options?.reasoning ?? "off", options?.samplingParams);
+    const requestedMaxTokens = options?.maxTokens;
     return {
         temperature: options?.temperature,
         samplingParams,
-        maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens),
+        maxTokens: clampMaxTokensToContext(model, context, requestedMaxTokens ?? model.maxTokens, requestedMaxTokens === undefined ? MIN_DERIVED_MAX_TOKENS : MIN_MAX_TOKENS),
         signal: options?.signal,
         telemetry: options?.telemetry,
         apiKey: apiKey || options?.apiKey,
```

**不改的**：`.d.ts`（新增参数是尾部可选、默认值保持旧语义，声明不必变）；`openai-completions.js` 及其它 provider；
`MIN_MAX_TOKENS`、margin 公式、`MIN_OUTPUT_WITH_RATIO_MARGIN` 分支；Pi 的 overflow 检测/恢复（U1 不改恢复逻辑）。
另两处直接调 `clampMaxTokensToContext` 的调用（`anthropic-messages.js:956`、`bedrock-converse-stream.js:446`）
走 3 参调用 ⇒ `derivedFloor` 取默认 1，行为不变（未在本补丁范围内，避免越过已验证路径）。

**显式 `maxTokens` 边界补测（2026-11-16 实测；模型 `contextWindow=16384` / `model.maxTokens=2048`）**：
显式请求传 `derivedFloor=MIN_MAX_TOKENS(1)`，即 `min(请求值, max(1, room))`；
`room = contextWindow − input − margin`（16k 窗口下 margin 恒为固定 4096，故 `room = 12288 − input`）。

| 显式请求 | room ≥ 请求值 | room ∈ (1024, 请求值) | room ∈ (1,1024) | room ≤ 0 |
|---|---|---|---|---|
| `maxTokens=2048` | `room=8288` → **2048** | `room=1788` → **1788**（受 room 约束） | `room=288` → **288**（1024 下限不生效） | **1** |
| `maxTokens=8192` | `room=8288` → **8192**（不被 `model.maxTokens` 截回） | `room=2288` → **2288** | `room=288` → **288** | **1** |

- 结论：显式 `maxTokens` **不被 1024 下限抬高**，仍只受 room 约束；room 为正且小于请求值时返回 room。
- 边界注意：显式值大于 `model.maxTokens` 时，本层不按 `model.maxTokens` 截断（8192 在 room 允许时原样返回）；
  服务端是否接受由 provider 决定。
- 对照（未显式 `maxTokens`）：`room=288 → 1024`、`room<0 → 1024`、`room≥2048 → model.maxTokens(2048)`；
  下限只改变原本会落到 <1024 的位置。

**删除条件**：上游在 `simple-options.js` 里区分「显式请求」与「缺省」并给 room 推导值设可用下限
（等价于：`options.maxTokens === undefined` 时 `clamp ≥ 某个非退化下限`）后删除本补丁与守卫测试。

## 验证读数（真实模型 `step-3.7-flash`，当次预注册，未入库）

装配与 stageB G3 一致（窗口 16,384 / `model.maxTokens` 2,048 / reserve 4,096 / keepRecent 4,915 /
thinkingLevel=off / 仅 `bridge_exec`）；N=1/场景、一次采样、未重采样，A/B 各跑一次。
对照：补丁前 stageB / 补丁后 stageU1 的原始运行产物（均 gitignored、未入库，仅作当次记录）。

| 场景 | 调用 | tokens | 空回复 | 压缩（start/完成/失败） | 主请求 cap |
|---|---|---|---|---|---|
| A 前 | 31 | 470,059 | 12 | 12 / 1 / 11 | 5×2048, 1×1395, 12×**1** |
| A 后 | 34 | 447,872 | **1**（turn 3，非本缺陷形状） | 15 / 3 / 12 | 7×2048, 1×1563, **11×1024** |
| B 前 | 23 | 246,416 | 4 | 6 / 3 / 3 | 11×2048, 1×1267, 5×**1** |
| B 后 | 20 | 232,658 | **0** | 6 / 2 / 4 | 8×2048, 1×1606, 5×**1024** |

- **12 次原有 1-token 回合（A turn 5–16）逐次读数**：补丁后 cap = 1024×11 + 2048×1（turn 7）；
  `stopReason` 11×stop + 1×length（turn 11，1024 打满后由 Pi 溢出恢复重试 2048 成功）；
  `usage.output` 27–1013；**12/12 有正文**（最短 turn 6「背景 A4 已记录。」10 字）。
  逐次表：当次 compare-A/compare-B 原始产物（未入库）。
- **无谓放大证伪**：补丁后每个 cap=1024 的主请求，其上一次主响应 provider `totalTokens` 为
  14,618–27,436（A）、17,522–27,436（B），即 `room = 16384 − est − 4096` 全为负 ⇒ 下限只在原本会被
  压到 1 的位置生效；room≥1024 的请求一字未变（单测 `pi-152-u1-output-floor.test.ts` 钉住 3000 不变）。
- **剩余上下文不足的去向**（Pi 原生，未新增宿主门）：`stopReason=length` 且 `usage.output < model.maxTokens`
  → `pi-ai/dist/utils/overflow.js:177 isRecoverableLength` → `agent-session.js:2534` 走
  `compaction_start(reason=overflow)` + 一次 compact-and-retry（`agent-session.js:2541` 上限一次）；
  摘要失败时 `compaction_end` 带显式 `errorMessage`（`Context overflow recovery failed: …`）⇒ 有界失败。
  实跑证据：A turn 11（length@1024 → 压缩完成 → 重试 2048 出正文）、A turn 9/12–16 与 B turn 10–12
  （压缩失败事件 + errorMessage，同回合正文仍非空）。
- **残留（不属 U1，未在本补丁处理）**：A turn 3 空回复 = `stopReason=stop` + 仅 thinking 块（`output=22`），
  该请求 cap=2048、无任何压缩事件——是「stop 但无正文」形状，产品驱动有
  `shouldNudgeFinalReply`（`packages/agent/src/pi-driver.ts:48-52`）兜底，而本次重放脚本直接
  `session.prompt` 不经驱动，故未触发催问。
- **摘要请求仍触顶**：摘要请求走同一 clamp，cap 仍由 `model.maxTokens=2048` 决定，A 15 次摘要 12 次
  `length`。属摘要输出预算/空摘要入库（U2 范围），本补丁不涉及。


## P2 · `@earendil-works/pi-coding-agent@1.5.2` — U2 空摘要被当成有效压缩检查点

**包/版本**：`@earendil-works/pi-coding-agent@1.5.2`（`node_modules/@earendil-works/pi-coding-agent`，
顶层仅一份；`dist/bundle/**` 是 cli/rpc-entry 专用打包副本，宿主只 import 包根
（`package.json` exports `.` → `dist/index.js`），`dist/index.js` 不引用 bundle ⇒ **不改 bundle**）。

**文件（实际被执行）**：

- `dist/core/compaction/compaction.js`（`getSummarizationFailure` 与两个摘要调用点、`compact()`）；
- `dist/core/session-manager.js`（`SessionManager.appendCompaction`，压缩检查点唯一写库口）。

**来源（原缺陷出处）**：

- `dist/core/compaction/compaction.js:454-462`（补丁前行号）`getSummarizationFailure` **只**看
  `stopReason === "error"` 与 `"length"`，**不看正文**；`stop` + 空正文返回 `undefined`（=成功）。
- 普通摘要：`generateSummaryWithUsage` → `:533` 调 `getSummarizationFailure`，通过后
  `contentText(response.content)` 作为摘要文本返回（`:538-539`）。
- Turn Prefix Summary：`generateTurnPrefixSummary` → `:737` 同一判定，通过后
  `contentText(response.content)` 作为分段摘要（`:744-745`），再在 `compact()` `:703` 拼进
  `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.text}`。
  空分段摘要拼上固定标题后 **trim 非空** —— 只看「整串非空」的判空会漏掉这一边界。
- 最终 Compaction Entry 提交：三条路径同一写库口 `SessionManager.appendCompaction`
  （`dist/core/session-manager.js:892`，补丁前行号）：手工压缩 `agent-session.js:2393`、
  自动压缩 `agent-session.js:2682`、boundary drafts `agent-session.js:649`；
  三个调用点**都没有**任何正文判定。
- **补丁前**注入证据（不可变）：`docs/product/evidence/pi152-u2-injection-prepatch.json`。
  `T-empty` → `compaction_end(reason=threshold, errorMessage=null, summaryChars=0, summary="")` +
  `compactionEntries:[{"summary":"","summaryChars":0}]`，最后一次主请求 `hasFact=false`（事实消失）；
  `T-ws` → `summary:"  \n\t "`、`summaryChars=5`，同样入库、事实消失。
- **补丁后**注入证据（不可变）：`docs/product/evidence/pi152-u2-injection-postpatch.json`。
  同一 `T-empty`/`T-ws` → 三次 `compaction_end` 均带
  `errorMessage="Auto-compaction failed: Summarization failed: model returned an empty summary; kept existing history"`、
  `compactionEntries:[]`、最后一次主请求 `hasFact=true`（历史保留）。

**修复思路（最小：一处公共判定 + 一个写库边界，不复制三份逻辑）**：

- 在 `compaction.js` 加 `assertSummarizationText(response, label)`：取 `contentText(response.content)`，
  **按 `trim()` 后长度判空**，空则 `throw`。边界①②共用同一个函数（两个调用点各一行替换）。
- 在 `session-manager.js` 的 `appendCompaction` 开头按同一口径（`typeof summary !== "string" ||
  summary.trim().length === 0`）拒绝——**写库前**的最后一道，覆盖上游漏判、extension/hook 提供的摘要、
  boundary drafts 三条路径。
- 不改 `getSummarizationFailure` 本身：它还被 `branch-summarization.js:242`（空摘要回落
  `"No summary generated"` 占位）与 `bug-report.js:281`（已有自己的空判）使用，改它会越出 U2 边界。

**完整 diff**（`patches/@earendil-works+pi-coding-agent+1.5.2.patch`，md5 `fa19b77c…`）：

```diff
diff --git a/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js b/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js
index 9b1a409..97612c3 100644
--- a/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js
+++ b/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js
@@ -460,6 +460,19 @@ export function getSummarizationFailure(response, label) {
     }
     return undefined;
 }
+/**
+ * fshine patch U2: a `stop` response with an empty or whitespace-only body is not a checkpoint.
+ * Upstream only rejects `error`/`length`, so a blank summary used to be persisted as a compaction
+ * entry and silently dropped the history it was meant to replace. Blankness is decided after
+ * `trim()` so `"  \n\t "` is rejected too.
+ */
+function assertSummarizationText(response, label) {
+    const text = contentText(response.content);
+    if (text.trim().length === 0) {
+        throw new Error(`${label} failed: model returned an empty summary; kept existing history`);
+    }
+    return text;
+}
 function createSummarizationOptions(model, apiKey, headers, env, signal, thinkingLevel, sessionId) {
     const options = { signal, apiKey, headers, env, sessionId };
     if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
@@ -537,7 +550,7 @@ _reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, th
     if (response.content.some((block) => block.type === "toolCall")) {
         throw new Error("Summarization attempted to call a tool");
     }
-    const textContent = contentText(response.content);
+    const textContent = assertSummarizationText(response, "Summarization");
     return { text: textContent, usage: response.usage };
 }
 function isProjectedTurnStart(entry) {
@@ -742,7 +755,7 @@ async function generateTurnPrefixSummary(messages, model, apiKey, headers, env,
         throw new Error("Turn prefix summarization attempted to call a tool");
     }
     return {
-        text: contentText(response.content),
+        text: assertSummarizationText(response, "Turn prefix summarization"),
         usage: response.usage,
     };
 }
diff --git a/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js b/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js
index 7ee0501..daca92b 100644
--- a/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js
+++ b/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js
@@ -890,6 +890,12 @@ export class SessionManager {
     }
     /** Append a compaction summary as child of current leaf, then advance leaf. Returns entry id. */
     appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook, usage) {
+        // fshine patch U2: the commit boundary for compaction checkpoints. Even if a future
+        // summarization path forgets to validate its text, a blank summary must never replace
+        // existing history with nothing - reject before writing so the old history stays loadable.
+        if (typeof summary !== "string" || summary.trim().length === 0) {
+            throw new Error("Refusing to append a compaction entry with an empty summary");
+        }
         const timestamp = new Date().toISOString();
         const systemMessage = getCurrentSystemMessage(this.buildSessionProjection().messages);
         const id = generateId(this.byId);
```

**不改的**：`getSummarizationFailure` 本体（其他摘要使用者语义不变）、`branch-summarization.js`、
`bug-report.js`、`compact()` 的合并/文件操作拼接、`agent-session.js` 的三条提交路径与
`compaction_end` 事件形状、`dist/bundle/**`；不引入 StepCode 的 Trigger Policy V2/调度/预算门
（只借它「空摘要不得提交」的判空/提交边界这一点）。

**删除条件**：上游在摘要返回处（普通摘要与 Turn Prefix Summary）**自己**按 trim 判空并抛错，
或在 `appendCompaction` 写库前拒绝空摘要（任一形式，二者之一即可让 U2 的对应守卫失效）后，
删除本补丁与 `packages/agent/pi-152-u2-empty-summary.test.ts`。

**验证读数（确定性，零真实模型；`TMPDIR=<临时目录>`）**：

- 守卫测试 `packages/agent/pi-152-u2-empty-summary.test.ts`（真实 `createAgentSession` +
  `SessionManager` 落真实会话文件；脚本化 provider 只替换模型响应）：
  - **无补丁（实测）**：`4 failed | 1 passed (5)`（正向对照无补丁时本就绿：有效摘要能正常入库）；
    其中 `T-empty` 形状 = `compaction_end` 无 errorMessage、
    会话文件 `entries` 出现 `compaction`、`summary=""`；`T-ws` = `summary="  \n\t "`、`summaryChars=5`；
    最后一条主请求 `hasFact=false`（事实消失）。与
    `docs/product/evidence/pi152-u2-injection-prepatch.json` 的 T-empty/T-ws 一致。
  - **有补丁（实测）**：`5 passed (5)`。
- **反向绊线（实测）**：把三处判空（两个摘要调用点 + `appendCompaction`）同时改回上游写法 →
  `4 failed | 1 passed (5)`：边界①（空/全空白）、边界②（Turn Prefix）、边界③（写库）各红，
  正向对照（有效摘要 → 恰一条 `Turn Context (split turn)` 检查点）仍绿 ⇒ 断言不是「什么都拒绝」。
- **失败语义（实测，边界①用例内断言）**：失败路径 `compaction_end` 带 `errorMessage`
  （`Auto-compaction failed: Summarization failed: model returned an empty summary; kept existing history`）、
  会话文件里 `compaction` 条目数 = 0、同会话后续主请求仍带事实；
  `SessionManager.open(sessionFile)` 重开后投影消息非空且包含事实、无 compaction 条目；
  再从该文件重开一个会话（关压缩，避免 prompt 前压缩掩盖文件历史）发一轮，
  请求里仍带事实 ⇒ 原历史可恢复、下次打开能继续。
- **边界②实测形状**：分段轮次流程 `summaryRequests=2 / turnPrefixRequests=1`；
  修复前空分段摘要拼成 `"\n\n---\n\n**Turn Context (split turn):**\n\n"`（trim 非空、会被入库）；
  修复后同一流程整次压缩失败、0 条 compaction。
- **回归门**：`npm run typecheck` 通过；`npm run test -- --project unit` = `89 passed / 923 passed (923)`。
- **补丁可撤销（实测）**：`npx patch-package --reverse` → `compaction.js` md5 `20d3c20c…`、
  `session-manager.js` md5 `4edb7c48…`；`npm run postinstall`（两行 ✔）→ `af49aac9…` / `a6c8bdfa…`。
