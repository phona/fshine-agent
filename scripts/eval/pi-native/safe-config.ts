/**
 * Pi 原生压缩 · 小窗口安全配置（**纯配置推导，无任何压缩治理逻辑**）。
 *
 * 背景（真实模型证据，`.runtime/r5p4fix/`，模型 `step-3.7-flash`，窗口 16384 / maxTokens 2048 /
 * reserveTokens 4096 / keepRecentTokens 4915）：
 *   · B 第 9 回合压缩后空回复——压缩后请求 16,664 token > 窗口 16,384（无输出余量）；
 *   · A 23 次压缩中 4 次摘要为空——摘要调用 output 触顶 2048（reasoning 吃满）→ 约束丢失。
 * 两条都不是“压缩算法坏了”，而是**喂给 Pi 的配置没有余量**。本模块只做一件事：
 * 按 Pi 的公开派生公式算出「窗口 − 输出预算 − 余量」装得下的绝对配置，并给出可断言的
 * 预算不等式。触发/执行/摘要/尾段仍全部归 Pi。
 *
 * Pi 公式（`@earendil-works/pi-agent-core@0.85.1`，锁定版本）：
 *   1) 缺省设置 `DEFAULT_COMPACTION_SETTINGS = {enabled:true, reserveTokens:16384,
 *      keepRecentTokens:20000}` —— `dist/harness/compaction/compaction.js:75-79`。
 *   2) 触发 `contextTokens > contextWindow − reserveTokens` —— `compaction.js:144-147`
 *      （`contextTokens` 取最近 assistant 的真实 usage total，`compaction.js:81-83`、`:117-141`）。
 *   3) 摘要输出预算 `maxTokens = min(floor(0.8 × reserveTokens), model.maxTokens > 0 ?
 *      model.maxTokens : Infinity)` —— `compaction.js:380`；请求带 `{maxTokens, reasoning}` ——
 *      `compaction.js:399-401`。**故 reserveTokens 同时决定摘要预算与触发阈值。**
 *   4) 尾段保留 `findCutPoint(..., keepRecentTokens)` 按 Pi 的字符估算器
 *      `ceil(chars / 4)` 累加 —— `compaction.js:196-233`、`:165-210`。
 *
 * 关键事实（为什么必须留“估算放大”）：Pi 的触发与尾段用 `字符数/4` 估算 token，而中文
 * 在 step-3.7-flash 上实测约 1 字 ≈ 1 token，故**实际 token 可以是估算的 ~4 倍**。
 * 实测标定（`.runtime/r5p4fix/B/model-calls.jsonl` 第 15 次调用，压缩后首个请求）：
 * 消息字符 23,976 → Pi 估算 5,994 token，provider 报 prompt 16,133 token（total 16,221 −
 * output 88）→ 放大 ≈ 2.69×。本模块取 **4× 最坏情况**（与任务书同口径），不是拟合值。
 *
 * 预算不等式（“压缩后模拟请求 ≤ 窗口 − maxTokens − 安全余量”）：
 *   hostPromptTokens + summaryBudget + amplification × keepRecentTokens + singleTurnInput
 *     ≤ contextWindow − maxTokens − margin
 * 其中 hostPromptTokens 是系统提示 + 工具 schema + 消息框架的保守上界（实测首个请求
 * prompt ≈ 1,692 token（`B/model-calls.jsonl` 第 0 次调用：total 1,948 − output 256），
 * 取 4,096 ≈ 2.4× 实测）；summaryBudget = Pi 公式（待见上 3）。
 *
 * 另加两条结构性约束：
 *   · reserveTokens ≥ maxTokens：触发时刻（context > W − R）再叠加一次最大输出仍不越窗；
 *   · 模拟压缩后请求 < 触发阈值 W − R：压缩后不会立刻再次触发（无“零收益连环压缩”）。
 */
import type { CompactionSettings } from '@earendil-works/pi-coding-agent';

/** 一组喂给 Pi 的绝对配置；四个字段都是“传入配置”，不是 fshine 的治理参数。 */
export interface PiCompactionConfig {
  /** 模型上下文窗口（token）。经 `LLM_CONTEXT_WINDOW` / `createPiModelRuntime({contextWindow})` 传入。 */
  readonly contextWindow: number;
  /** 单次输出上限 `model.maxTokens`（同时是摘要预算的封顶）。经驱动的模型能力传入。 */
  readonly maxTokens: number;
  /** Pi `CompactionSettings.reserveTokens`（绝对），由装配/评测显式传入。 */
  readonly reserveTokens: number;
  /** Pi `CompactionSettings.keepRecentTokens`（绝对），由装配/评测显式传入。 */
  readonly keepRecentTokens: number;
}

/**
 * 本轮安全配置（预注册写死值）。
 *
 * 推导（f=4 最坏估算放大，margin=2048）：
 *   摘要预算 = min(floor(0.8 × 8192), 8192) = 6,553 ≥ 4,096（摘要非空下限）
 *   模拟压缩后请求 = 4096 + 6553 + 4×1024 + 6144 = 20,889
 *   上限 = 32,768 − 8,192 − 2,048 = 22,528 → 余量 1,639 ✓
 *   触发阈值 = 32,768 − 8,192 = 24,576 > 20,889（压缩后不会立刻再触发）✓
 *   结构性：reserve 8,192 ≥ maxTokens 8,192 ✓
 */
export const SAFE_PI_COMPACTION_CONFIG: PiCompactionConfig = {
  contextWindow: 32_768,
  maxTokens: 8_192,
  reserveTokens: 8_192,
  keepRecentTokens: 1_024,
};

/** 上轮（阶段四补）的不安全现状，仅用于反向绊线（改回它必须红）。 */
export const UNSAFE_STATUS_QUO_CONFIG: PiCompactionConfig = {
  contextWindow: 16_384,
  maxTokens: 2_048,
  reserveTokens: 4_096,
  keepRecentTokens: 4_915,
};

/** 最坏估算放大（中文 1 字 ≈ 1 token vs Pi 按 4 字/token 估）。 */
export const TOKEN_ESTIMATE_WORST_CASE = 4;
/** 系统提示 + 工具 schema + 消息框架的保守上界（实测 ≈1,692，取约 2.4×）。 */
export const HOST_PROMPT_TOKENS = 4_096;
/** 单回合用户输入上界（评测夹具最大背景段 ≈5.6k 字符 → 约 5.6k 真实 token）。 */
export const SINGLE_TURN_INPUT_TOKENS = 6_144;
/** 输出留白（窗口内除 maxTokens 之外还要留的余量）。 */
export const HEADROOM_MARGIN_TOKENS = 2_048;
/** 摘要预算下限：上轮 4/23 次摘要在 2,048 预算下被 reasoning 吃空。 */
export const SUMMARY_FLOOR_TOKENS = 4_096;

/**
 * 摘要输出预算（**历史推导**，pi 0.85.1 `compaction.js:380` 的转写）。
 * 1.5.2 已移除该预算：`createSummarizationOptions` 只带 reasoning/signal 等，不再传 maxTokens
 * （见 `safe-config.test.ts` 的公式守卫）。本函数保留为当时注册的余量推导记录，
 * 新装配不应据此断言摘要预算仍存在。
 */
export function summaryBudgetTokens(config: PiCompactionConfig): number {
  return Math.min(Math.floor(0.8 * config.reserveTokens), config.maxTokens);
}

/** Pi 的压缩触发阈值（`compaction.js:144-147`：context > W − reserve）。 */
export function compactionTriggerTokens(config: PiCompactionConfig): number {
  return config.contextWindow - config.reserveTokens;
}

/**
 * 压缩后首个请求的模拟上界（见文件头不等式）。
 * 刻意把「尾段」与「本回合用户消息」分开相加：`findCutPoint` 保留的尾段可能已包含
 * 本回合用户消息，分开相加是**保守重复计数**，不追求紧致。
 */
export function simulatedPostCompactPromptTokens(
  config: PiCompactionConfig,
  options: { readonly estimateInflation?: number } = {},
): number {
  const inflation = options.estimateInflation ?? TOKEN_ESTIMATE_WORST_CASE;
  return HOST_PROMPT_TOKENS
    + summaryBudgetTokens(config)
    + inflation * config.keepRecentTokens
    + SINGLE_TURN_INPUT_TOKENS;
}

/** 压缩后请求允许的上界：窗口 − maxTokens − 安全余量。 */
export function postCompactPromptCeilingTokens(config: PiCompactionConfig): number {
  return config.contextWindow - config.maxTokens - HEADROOM_MARGIN_TOKENS;
}

export interface CompactionConfigAssessment {
  readonly safe: boolean;
  readonly problems: readonly string[];
  readonly summaryBudget: number;
  readonly simulatedPrompt: number;
  readonly promptCeiling: number;
  readonly triggerThreshold: number;
}

/** 确定性判定：配置是否满足余量不等式与摘要预算下限。纯函数。 */
export function assessCompactionConfig(
  config: PiCompactionConfig,
  options: { readonly estimateInflation?: number } = {},
): CompactionConfigAssessment {
  const problems: string[] = [];
  const summaryBudget = summaryBudgetTokens(config);
  const simulatedPrompt = simulatedPostCompactPromptTokens(config, options);
  const promptCeiling = postCompactPromptCeilingTokens(config);
  const triggerThreshold = compactionTriggerTokens(config);

  if (!Number.isSafeInteger(config.contextWindow) || config.contextWindow <= 0) problems.push('contextWindow 必须是正整数');
  if (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0) problems.push('maxTokens 必须是正整数');
  if (!Number.isSafeInteger(config.reserveTokens) || config.reserveTokens <= 0) problems.push('reserveTokens 必须是正整数');
  if (!Number.isSafeInteger(config.keepRecentTokens) || config.keepRecentTokens <= 0) problems.push('keepRecentTokens 必须是正整数');
  if (summaryBudget < SUMMARY_FLOOR_TOKENS) {
    problems.push(`摘要预算 ${summaryBudget} < 下限 ${SUMMARY_FLOOR_TOKENS}（reasoning 可能吃空摘要）`);
  }
  if (simulatedPrompt > promptCeiling) {
    problems.push(`压缩后模拟请求 ${simulatedPrompt} > 上限 ${promptCeiling}（窗口 ${config.contextWindow} − maxTokens ${config.maxTokens} − 余量 ${HEADROOM_MARGIN_TOKENS}）`);
  }
  if (config.reserveTokens < config.maxTokens) {
    problems.push(`reserveTokens ${config.reserveTokens} < maxTokens ${config.maxTokens}（触发时刻再叠加输出可能越窗）`);
  }
  if (simulatedPrompt >= triggerThreshold) {
    problems.push(`压缩后模拟请求 ${simulatedPrompt} ≥ 触发阈值 ${triggerThreshold}（会立刻再次压缩）`);
  }
  return { safe: problems.length === 0, problems, summaryBudget, simulatedPrompt, promptCeiling, triggerThreshold };
}

/** 驱动需要的 `CompactionSettings`（`enabled` 恒 true：压缩生命周期归 Pi）。 */
export function compactionSettingsOf(config: PiCompactionConfig): CompactionSettings {
  return { enabled: true, reserveTokens: config.reserveTokens, keepRecentTokens: config.keepRecentTokens };
}

/** 装配/评测要求的环境变量（`scripts/ask-runtime.ts` 的 `compactionSettingsFrom` 读取）。 */
export function safeConfigEnv(config: PiCompactionConfig = SAFE_PI_COMPACTION_CONFIG): Record<string, string> {
  return {
    LLM_CONTEXT_WINDOW: String(config.contextWindow),
    LLM_COMPACTION_RESERVE_TOKENS: String(config.reserveTokens),
    LLM_COMPACTION_KEEP_RECENT_TOKENS: String(config.keepRecentTokens),
  };
}
