/**
 * SPIKE-ONLY：长窗实验旋钮（2026-11-11，spike/generic-agent 分支）。
 *
 * 实验目的：现有探针装配（state_recent + context-state 投影）里，`runtime.ts` 的
 * `driver.compact` 调用点被 `effectiveContextMode === 'transcript'` 挡住——而
 * `ensureHistoryBackfill` 只有在 conversationLog 在场、contextStates 缺席时才返回 false。
 * 正常装配两者都在场，所以 pi 原生压缩是**不可达**的，不是"阈值没跨过"。
 *
 * 三个旋钮把两条从未跑过的路径压出来（全部环境变量门控，缺省行为逐字节不变）：
 *   ① `FSHINE_SPIKE_CONTEXT_WINDOW`：pi 模型的 contextWindow，缺省 128_000（与接线前一致）。
 *      spike 时设小（约 40_000）让 transcript 反复越过
 *      `contextWindow - reserveTokens(16_384)` 阈值。
 *   ② `FSHINE_SPIKE_SESSION_TTL_MS`：覆盖 runtime 的 sessionTtlMs，缺省不覆盖
 *      （仍走装配传入的 config.sessionTtlMs / DEFAULT_SESSION_TTL_MS）。spike 时设几十秒，
 *      让回合之间的会话过期，逼出 `session_resume_seeding` + force 压缩种子。
 *   ③ `FSHINE_SPIKE_TRANSCRIPT_MODE`：把 contextStates 从 runtime 依赖里投影掉。这样
 *      `ensureHistoryBackfill` 返回 false，runtime 走 `effectiveContextMode = 'transcript'`：
 *      全文转录 + pi 原生压缩，context-state 投影（context-extractor / context-model /
 *      context-state）按其缺席守卫整体关闭。conversationLog / platformTasks /
 *      memoryRecords 仍在场，execution-facts 台账、reference-evidence 指代证据、
 *      search_history / get_messages 工具照常活着。
 *
 * 这不是"修好模式的变体"，而是**第三种装配**：transcript 全文 + pi 原生压缩。
 * 预期寿命：只活在这个 spike 分支上；对照报告合并后，三个旋钮、接线与测试一起删除。
 * 不是产品开关，不写进 config/agent.yaml，也不进部署文档。最长保留到 2026-12-31。
 */
export const SPIKE_CONTEXT_WINDOW_ENV = 'FSHINE_SPIKE_CONTEXT_WINDOW';
export const SPIKE_SESSION_TTL_MS_ENV = 'FSHINE_SPIKE_SESSION_TTL_MS';
export const SPIKE_TRANSCRIPT_MODE_ENV = 'FSHINE_SPIKE_TRANSCRIPT_MODE';

/** 接线前的硬编码值；缺省必须与它相等。 */
export const SPIKE_DEFAULT_CONTEXT_WINDOW = 128_000;

function positiveIntegerEnv(env: Record<string, string | undefined>, name: string): number | undefined {
  const raw = (env[name] ?? '').trim();
  if (raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`环境变量 ${name} 必须是正整数（当前: ${raw}）`);
  }
  return value;
}

/** 旋钮①：模型 contextWindow；未设置时返回接线前的 128_000。 */
export function spikeContextWindow(env: Record<string, string | undefined> = process.env): number {
  return positiveIntegerEnv(env, SPIKE_CONTEXT_WINDOW_ENV) ?? SPIKE_DEFAULT_CONTEXT_WINDOW;
}

/** 旋钮②：sessionTtlMs 覆盖；未设置时返回 undefined（调用方保持原有回落顺序）。 */
export function spikeSessionTtlMs(env: Record<string, string | undefined> = process.env): number | undefined {
  return positiveIntegerEnv(env, SPIKE_SESSION_TTL_MS_ENV);
}

/** 旋钮③：是否投影掉 contextStates 以走 transcript 全文路径；未设置 = 关闭。 */
export function isSpikeTranscriptModeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env[SPIKE_TRANSCRIPT_MODE_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}
