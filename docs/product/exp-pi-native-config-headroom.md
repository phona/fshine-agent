# Pi 原生压缩 · 小窗口安全配置（余量不变式与摘要输出预算）

> 分支 `exp/pi-native-session-compaction`（worktree `~/projects/fshine-agent-exp-pi-session`）。
> 锁定 Pi 版本：`@earendil-works/pi-agent-core@0.85.1`。
> **本文件只登记“传给 Pi 的配置”如何按窗口推导**；触发/执行/摘要/尾段/溢出恢复仍全部归 Pi，
> fshine 侧**不新增任何压缩检测/兜底/门控逻辑**。

## 1. 上轮真实缺陷（配置无余量，不是压缩算法问题）

证据：`.runtime/r5p4fix/`（模型 `step-3.7-flash`，窗口 16,384 / `maxTokens` 2,048 /
`reserveTokens` 4,096 / `keepRecentTokens` 4,915；产品装配链 + 单长生命周期 Pi Session）。

| 缺陷 | 机械证据 | 配置成因 |
|---|---|---|
| B 第 9 回合压缩后空回复 | 压缩后请求 **16,664**（`B/model-calls.jsonl` 第 22 次）> 窗口 16,384；压缩保留 13–15 条尾消息 + 1,544 字摘要 | `keepRecentTokens=4,915` 是 Pi 用「字符/4」估算出来的；中文实测约 1 字≈1 token，尾段真实 token ≈ 估算 2.7×，压缩后没有输出余量 |
| A 23 次压缩中 4 次摘要为空 | 摘要调用 `output` 触顶 2,048（`A/compactions.json` turn 6/9/12/15，`summaryChars=0`） | 摘要预算 = `min(floor(0.8×R), maxTokens)` = `min(3,276, 2,048)` = 2,048；reasoning 吃满即无正文 |

复算现状（f=4 最坏估算放大、单回合输入上界 6,144、host 提示上界 4,096、余量 2,048）：

- 摘要预算 `2,048 < 4,096` → 违反「摘要输出预算足够非空」；
- 压缩后模拟请求 `4096 + 2048 + 4×4915 + 6144 = 31,948 > 16,384 − 2,048 − 2,048 = 12,288` → 违反余量不变式。

## 2. Pi 的派生公式（反推来源，逐行可查）

路径：`node_modules/@earendil-works/pi-agent-core/dist/harness/compaction/compaction.js`

| 事实 | 位置 | 内容 |
|---|---|---|
| 缺省压缩设置 | `:75-79` | `DEFAULT_COMPACTION_SETTINGS = {enabled:true, reserveTokens:16384, keepRecentTokens:20000}` |
| 触发判据 | `:144-147` | `shouldCompact(ctx, W, s) = ctx > W − s.reserveTokens` |
| 上下文 token | `:81-83`、`:117-141` | 取最近 assistant 的真实 `usage.totalTokens`，只对尾段用估算 |
| **摘要输出预算** | `:380` | `maxTokens = min(floor(0.8 × reserveTokens), model.maxTokens > 0 ? model.maxTokens : ∞)` |
| 摘要请求参数 | `:399-401` | `thinkingLevel ≠ off` 时 `{maxTokens, reasoning: thinkingLevel}` |
| 尾段切点 | `:196-233` | `findCutPoint(..., keepRecentTokens)`，按 `ceil(chars/4)` 累加 |
| 估算器 | `:165-210` | `estimateTokens = ceil(chars/4)` |

两个直接推论：

1. **`reserveTokens` 同时决定触发阈值与摘要预算**——只调窗口而不调 reserve，摘要预算仍可能不够；
2. 触发与尾段用的是**估算** token，中文下实际 token 可为估算的数倍，配置必须为这个放大留余量。

实测标定（`B/model-calls.jsonl` 第 15 次调用）：消息 23,976 字符 → Pi 估算 5,994 token，
provider 报 prompt 16,133（`totalTokens 16,221 − output 88`）→ 放大 ≈ **2.69×**。
本文件取 **4×** 作最坏情况（不拟合、不乐观）。

## 3. 余量不变式与安全配置

**不变式 I1（压缩后请求有界）**

```
hostPromptTokens + summaryBudget + f × keepRecentTokens + singleTurnInput
  ≤ contextWindow − maxTokens − margin
```

- `hostPromptTokens = 4,096`：系统提示 + 工具 schema + 消息框架的保守上界（实测首请求 prompt ≈ 1,692，取 ≈2.4×）；
- `summaryBudget`：Pi 公式（§2，`:380`）；
- `f = 4`：最坏估算放大；
- `singleTurnInput = 6,144`：评测夹具最大背景段约 5.6k 字符（中文 ≈5.6k 真实 token）；
- `margin = 2,048`；
- 尾段与本回合用户消息分开相加（保守重复计数，不追求紧致）。

**不变式 I2（摘要输出预算非空）**

```
summaryBudget = min(floor(0.8 × reserveTokens), maxTokens) ≥ 4,096
```

上轮 2,048 预算下 4/23 次摘要为空；取 4,096 为下限。

**结构性约束**

- `reserveTokens ≥ maxTokens`：触发时刻（ctx > W − R）再叠加一次最大输出仍不越窗；
- 压缩后模拟请求 `< W − reserveTokens`：压缩后不会立刻再次触发（无零收益连环压缩）。

**本轮安全配置（预注册写死值，实现于 `scripts/eval/pi-native/safe-config.ts`）**

| 字段 | 值 | 说明 |
|---|---|---|
| `contextWindow` | **32,768** | 经 `LLM_CONTEXT_WINDOW` / 模型能力 `contextWindow` 传入 |
| `maxTokens` | **8,192** | 单次输出上限；同时是摘要预算封顶 |
| `reserveTokens` | **8,192** | 触发阈值 = 24,576；摘要预算 = 6,553 |
| `keepRecentTokens` | **1,024** | 压缩后尾段只保留当前回合附近，估算≈1k / 真实≈4k |

读数：

- I2：`min(floor(0.8×8192), 8192) = 6,553 ≥ 4,096` ✓
- I1：`4096 + 6553 + 4×1024 + 6144 = 20,889 ≤ 32,768 − 8,192 − 2,048 = 22,528`（余量 1,639）✓
- 触发阈值 24,576 > 20,889 → 不连环压缩 ✓；`reserve 8,192 ≥ maxTokens 8,192` ✓

同族候选 `W=32,768 / M=4,096 / R=16,384 / K=3,072` 也能过 I1（上界 30,720 ≤ 30,720，零余量），
但摘要预算 4,096 恰好卡在下限、且余量为 0，不作为本轮值。

## 4. 接入点（只改“传入配置”）

| 层 | 改动 | 边界 |
|---|---|---|
| 驱动 | `PiTurnDriverOptions.compactionSettings?: CompactionSettings`；`options.compactionSettings ?? piCompactionSettings(model.contextWindow)` | 纯透传；不传时行为逐字节不变（`packages/agent/src/pi-driver.ts:178-184`、`:311-313`） |
| 装配 | `scripts/ask-runtime.ts` 新增 `compactionSettingsFrom(env)`：读 `LLM_COMPACTION_RESERVE_TOKENS` / `LLM_COMPACTION_KEEP_RECENT_TOKENS`，两处 `createPiTurnDriver` 都展开 | 两个都不设 → `{}`（`npm run ask` 零变化）；只设一个 / 非正整数 → 装配期 fail-fast |
| 评测 | `scripts/eval/pi-native/r5p4fix-real.ts`：A/B/C 的窗口与 `maxTokens` 取 `SAFE_PI_COMPACTION_CONFIG`，驱动显式传 `compactionSettings`；开跑前先跑 `assessCompactionConfig`，不通过即退出（不烧调用） | D 为“工具结果致超窗”补充探针，不计入 N=3，豁免安全配置 |

**没有**新增压缩触发/裁剪/阈值判定/降级/溢出恢复；`enabled` 恒为 `true`，压缩生命周期仍归 Pi。

## 5. 确定性绊线

文件：`scripts/eval/pi-native/safe-config.test.ts`（17 例，零真实模型）。

- **正向**：`assessCompactionConfig(SAFE)` 绿，且读数钉死（摘要 6,553、模拟请求 20,889、上限 22,528、阈值 24,576）。
- **反向（改回不安全值必须红）**：
  - 上轮现状 `(16384, 2048, 4096, 4915)` 必须红（摘要预算 2,048；模拟请求 31,948 > 12,288）；
  - 从 SAFE 逐字段回退到上轮值（窗口 / `maxTokens` / `reserveTokens` / `keepRecentTokens`）**每个单独回退**都必须红；
  - 元绊线：若 `assess` 被放宽成恒真，本组立刻红。
- **公式漂移守卫**：直接读安装的 `compaction.js`，断言 `shouldCompact` 触发式、`:380` 摘要预算式、`findCutPoint`/`ceil(chars/4)` 估算式仍在；Pi 升级改公式 → 红，强制重新推导（禁止沿用旧常量）。
- **接线守卫**：`safeConfigEnv → compactionSettingsFrom → driver option → AgentHarnessOptions.compaction` 全链断言；评测脚本静态使用安全常量，A/B/C 窗口改回 16,384 即红。

执行：`npx vitest run scripts/eval/pi-native/safe-config.test.ts`。

## 6. 局限（如实登记）

1. **本轮未跑真实模型**：本切片只做配置修正 + 确定性绊线 + 文档。真实模型重跑（step-3.7-flash、
   A/B/C 各 1 会话、各 ≥2 次压缩、压缩后空回复=0 / 摘要为空=0 / 无编造）按预注册另行执行；
   因此“安全”目前是**配置数值上的可行解**，不是真实模型读数。
2. **压缩次数未验证**：W=32,768 / 阈值 24,576 下 A/B/C 是否仍能各触发 ≥2 次压缩是**预期**
   （按实测每回合增量 ≈2.5–3.4k 估算），未跑。若不足，按预注册如实记 INCONCLUSIVE，不调窗重采样。
3. **f=4 是最坏情况，不是拟合值**：实测放大 ≈2.69×；4× 取值使配置偏保守（压缩更早、尾段更小）。
4. **`keepRecentTokens=1,024` 很小**：压缩后尾段只保留当前回合附近，早期事实完全依赖 Pi 摘要；
   这正是摘要预算下限（≥4,096）要守的原因。
5. **`usage.input` 不含 cacheRead**：取证包装记录的 `input` 是 provider 的未缓存部分（`totalTokens`
   才等于 prompt+completion）；本文件的标定统一用 `totalTokens − output`，不用 `input` 单独算。
6. **未改产品默认行为**：不设两个新 env 时，`npm run ask` / `ask-runtime` 仍走
   `piCompactionSettings(window)` 派生；本轮安全值只在评测/显式配置时生效。
7. **`docs/decision-log.md` 未改**：按纪律由集成 Agent 单点登记。
