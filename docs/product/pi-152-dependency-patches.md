# Pi 1.5.2 依赖补丁登记（patch-package）

> 规则：**不 Fork、不复制整包、不改 Pi 之外的运行时代码**；每个补丁只改 npm 发布包里**实际被执行**的文件，
> 记录完整 diff、包名与版本、缺陷来源（源码行号）、删除条件（上游修好即删）。补丁可撤销：删 `patches/` +
> `rm -rf node_modules && npm ci` 即回到上游原状。

## 机制

- 工具链事实：npm **11.19.0**，**没有原生 `npm patch`**（`npm patch` exit 1）⇒ 用 `patch-package@8.0.1`。
- 接线：`devDependencies.patch-package` + `scripts.postinstall = "patch-package"`；补丁目录 `patches/`。
- 已验证：把 `simple-options.js` 还原为上游原件（md5 `ceb6c7bb…`）后 `npm run postinstall` →
  `patch-package 8.0.1 · Applying patches… @earendil-works/pi-ai@1.5.2 ✔` → 文件回到补丁态（md5 `4e26cfb0…`）。
- 补丁守卫测试：`packages/agent/pi-152-u1-output-floor.test.ts`（无补丁时 4 例红、1 例绿；有补丁 5 例绿）。

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
  `max_completion_tokens: 1`（证据：`.runtime/pi152-stageB/A/http.jsonl` 12 次；B 5 次）。
- 后果：thinking 模型的唯一 token 落在 thinking 块，正文为空、`stopReason=length`、`usage.reasoning=0`，
  上层看不出错误（`.runtime/pi152-stageB/trace.md` J3）。

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

**删除条件**：上游在 `simple-options.js` 里区分「显式请求」与「缺省」并给 room 推导值设可用下限
（等价于：`options.maxTokens === undefined` 时 `clamp ≥ 某个非退化下限`）后删除本补丁与守卫测试。

## 验证读数（真实模型 `step-3.7-flash`，预注册 `.runtime/pi152-stageU1/prereg.md`）

装配与 stageB G3 一致（窗口 16,384 / `model.maxTokens` 2,048 / reserve 4,096 / keepRecent 4,915 /
thinkingLevel=off / 仅 `bridge_exec`）；N=1/场景、一次采样、未重采样，A/B 各跑一次。
对照：补丁前 `.runtime/pi152-stageB/{A,B}`；补丁后 `.runtime/pi152-stageU1/{A,B}`。

| 场景 | 调用 | tokens | 空回复 | 压缩（start/完成/失败） | 主请求 cap |
|---|---|---|---|---|---|
| A 前 | 31 | 470,059 | 12 | 12 / 1 / 11 | 5×2048, 1×1395, 12×**1** |
| A 后 | 34 | 447,872 | **1**（turn 3，非本缺陷形状） | 15 / 3 / 12 | 7×2048, 1×1563, **11×1024** |
| B 前 | 23 | 246,416 | 4 | 6 / 3 / 3 | 11×2048, 1×1267, 5×**1** |
| B 后 | 20 | 232,658 | **0** | 6 / 2 / 4 | 8×2048, 1×1606, 5×**1024** |

- **12 次原有 1-token 回合（A turn 5–16）逐次读数**：补丁后 cap = 1024×11 + 2048×1（turn 7）；
  `stopReason` 11×stop + 1×length（turn 11，1024 打满后由 Pi 溢出恢复重试 2048 成功）；
  `usage.output` 27–1013；**12/12 有正文**（最短 turn 6「背景 A4 已记录。」10 字）。
  逐次表：`.runtime/pi152-stageU1/compare-A.json`、`compare-B.json`。
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

