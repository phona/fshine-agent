/**
 * P3 执行器侧机械预算强制（R5 Phase 3 准备；harness 面，零产品代码改动）。
 *
 * 定位：P3-A/B/C 评测跑真实模型时的**硬停接线**——达 maxModelCalls / maxTokens / 墙钟
 * 任一上限即终止并留证，**不依赖 Agent 自觉停止**。实现为 TurnDriver 包装器，套在
 * runner 装配的驱动外层（与 recordingDriver 同一插桩层），产品包零改动。
 *
 * 机械语义（每条有 enforce.test.ts 钉住）：
 *   · 计量单位：maxModelCalls = 内层 TurnDriver.run 的调用次数（回合驱动调用；
 *     回合内多次模型请求由 pi 原生回合时限 + 墙钟 abort 兜底）；
 *   · token 口径 = 转录 assistant 消息的 usage（totalTokens，缺省回落 input+output+
 *     cacheRead）；未观测到 usage 不虚增、不伪造（同 resource-policy 的 unavailable 纪律）；
 *   · 三类硬停（判定顺序固定 ms → calls → tokens，与 TaskBudget.exhausted 同序）：
 *       ① 回合前检查：已耗尽 → 直接抛 P3BudgetHardStopError，不进内层驱动（零调用）；
 *       ② 回合内检查：每次工具 exec 前复核，耗尽 → abort 在途请求并抛硬停；
 *       ③ 墙钟：deadline 收紧为 min(原 deadline, 硬停墙)，AbortController 到点 abort
 *          （中断在途模型请求），注入时钟/定时器保证测试确定性；
 *   · 留证：每个动作写结构化事件进 ledger.events（jsonl-ready），
 *     含 p3_budget_call / p3_budget_hard_stop / p3_budget_wall_abort；
 *   · 未配置的上限不强制（undefined = 不设限），透传语义：未触发硬停时 text/messages
 *     原样透传，不改驱动行为。
 */
import type { TurnDriver, TurnDriverInput, DriverMessage } from '../../../packages/agent/src/driver-contract';

export interface P3BudgetLimits {
  /** 内层驱动调用数上限（缺省不设限）。 */
  readonly maxModelCalls?: number;
  /** 累计 token 上限（仅按观测到的 usage 计；缺省不设限）。 */
  readonly maxTokens?: number;
  /** 硬停墙钟（ms，自 ledger 创建起算；缺省不设限）。 */
  readonly wallMs?: number;
}

export type P3BudgetStopReason = 'ms' | 'calls' | 'tokens';

export interface P3BudgetStop {
  readonly reason: P3BudgetStopReason;
  readonly limit: number;
  readonly used: number;
  readonly agent: 'main' | 'worker';
  readonly at: number;
}

export type P3BudgetEvent =
  | { readonly event: 'p3_budget_call'; readonly agent: 'main' | 'worker'; readonly calls: number; readonly tokens: number; readonly elapsedMs: number }
  | ({ readonly event: 'p3_budget_hard_stop' } & P3BudgetStop)
  | { readonly event: 'p3_budget_wall_abort'; readonly agent: 'main' | 'worker'; readonly at: number };

export class P3BudgetHardStopError extends Error {
  readonly stop: P3BudgetStop;

  constructor(stop: P3BudgetStop) {
    super(`P3 预算硬停（${stop.reason}: ${stop.used}/${stop.limit}，agent=${stop.agent}）`);
    this.name = 'P3BudgetHardStopError';
    this.stop = stop;
  }
}

export interface P3BudgetLedger {
  readonly limits: P3BudgetLimits;
  readonly used: { calls: number; tokens: number; tokensObserved: boolean; ms: number };
  readonly events: P3BudgetEvent[];
  /** 首次硬停事实（null = 未停）。 */
  stopped: P3BudgetStop | null;
}

export interface P3EnforceOptions {
  /** 注入时钟（测试确定性）；缺省 Date.now。 */
  readonly now?: () => number;
  /** 注入定时器（测试确定性）；缺省全局 setTimeout。 */
  readonly setTimer?: (callback: () => void, ms: number) => () => void;
}

export function createBudgetLedger(limits: P3BudgetLimits): P3BudgetLedger {
  return {
    limits,
    used: { calls: 0, tokens: 0, tokensObserved: false, ms: 0 },
    events: [],
    stopped: null,
  };
}

function usageOfMessage(message: unknown): number | undefined {
  if (message === null || typeof message !== 'object') return undefined;
  const usage = (message as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== 'object') return undefined;
  const record = usage as { input?: unknown; output?: unknown; cacheRead?: unknown; totalTokens?: unknown };
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  const total = num(record.totalTokens);
  if (total !== undefined) return total;
  const parts = [num(record.input), num(record.output), num(record.cacheRead)].filter(
    (value): value is number => value !== undefined,
  );
  return parts.length > 0 ? parts.reduce((sum, value) => sum + value, 0) : undefined;
}

/** 转录增量 token：只统计本包装器没见过的 assistant 消息（WeakSet 去重，不重复计费）。 */
function newTokensOf(messages: readonly DriverMessage[], seen: WeakSet<object>): { tokens: number; observed: boolean } {
  let tokens = 0;
  let observed = false;
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    if (seen.has(message)) continue;
    seen.add(message);
    if ((message as { role?: unknown }).role !== 'assistant') continue;
    const usage = usageOfMessage(message);
    if (usage !== undefined) {
      tokens += usage;
      observed = true;
    }
  }
  return { tokens, observed };
}

function exhaustionOf(ledger: P3BudgetLedger, liveWallMs: number): P3BudgetStopReason | null {
  const { limits, used } = ledger;
  // 判定顺序固定（ms → calls → tokens）：同一次检查只报一个机械原因。
  // 墙钟用检查时刻的实时值（used.ms 只在回合结束后回填，回合前检查不能吃旧值）。
  if (limits.wallMs !== undefined && liveWallMs >= limits.wallMs) {
    ledger.used.ms = liveWallMs;
    return 'ms';
  }
  if (limits.maxModelCalls !== undefined && used.calls >= limits.maxModelCalls) return 'calls';
  if (limits.maxTokens !== undefined && used.tokensObserved && used.tokens >= limits.maxTokens) return 'tokens';
  return null;
}

function stop(ledger: P3BudgetLedger, reason: P3BudgetStopReason, agent: 'main' | 'worker', nowMs: number): P3BudgetStop {
  const limitFor = (): number =>
    reason === 'ms' ? (ledger.limits.wallMs ?? 0)
      : reason === 'calls' ? (ledger.limits.maxModelCalls ?? 0)
        : (ledger.limits.maxTokens ?? 0);
  const usedFor = (): number =>
    reason === 'ms' ? ledger.used.ms
      : reason === 'calls' ? ledger.used.calls
        : ledger.used.tokens;
  const fact: P3BudgetStop = { reason, limit: limitFor(), used: usedFor(), agent, at: nowMs };
  if (ledger.stopped === null) ledger.stopped = fact;
  ledger.events.push({ event: 'p3_budget_hard_stop', ...fact });
  return fact;
}

/**
 * 执行器侧硬停驱动包装器：套在真实（或假）TurnDriver 外层。
 * 多个驱动（main/worker）共享同一 ledger（任务级共享预算同一对象，不放大）。
 */
export function createEnforcingDriver(
  inner: TurnDriver,
  agent: 'main' | 'worker',
  ledger: P3BudgetLedger,
  options: P3EnforceOptions = {},
): TurnDriver {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  });
  const startedWall = now();
  const seen = new WeakSet<object>();
  let aborted = false;

  function preCheck(): void {
    if (ledger.stopped !== null) throw new P3BudgetHardStopError(ledger.stopped);
    const reason = exhaustionOf(ledger, now());
    if (reason !== null) throw new P3BudgetHardStopError(stop(ledger, reason, agent, now()));
  }

  const wrapped: TurnDriver = {
    async run(input: TurnDriverInput) {
      preCheck(); // ① 回合前：已耗尽 → 零调用硬停。

      const turnStart = now();
      const controller = new AbortController();
      const fireWallAbort = (): void => {
        if (aborted || ledger.stopped !== null) return;
        aborted = true;
        ledger.events.push({ event: 'p3_budget_wall_abort', agent, at: now() });
        controller.abort(`p3_budget_wall（${agent}）`);
      };
      let cancelTimer: (() => void) | undefined;
      if (ledger.limits.wallMs !== undefined) {
        const hardDeadline = startedWall + ledger.limits.wallMs;
        const remaining = Math.max(0, hardDeadline - turnStart);
        cancelTimer = setTimer(fireWallAbort, remaining);
        controller.signal.addEventListener('abort', () => { cancelTimer?.(); });
      }
      if (input.signal !== undefined) {
        if (input.signal.aborted) controller.abort(input.signal.reason);
        else input.signal.addEventListener('abort', () => controller.abort(input.signal?.reason), { once: true });
      }
      const deadline = ledger.limits.wallMs !== undefined
        ? Math.min(input.deadline, startedWall + ledger.limits.wallMs)
        : input.deadline;

      const wrappedInput: TurnDriverInput = {
        ...input,
        deadline,
        signal: controller.signal,
        exec: async (tool, args, signal) => {
          preCheck(); // ② 回合内：工具循环每步前复核；耗尽 → abort 在途请求并硬停。
          return input.exec(tool, args, signal ?? controller.signal);
        },
      };

      try {
        const result = await inner.run(wrappedInput);
        const { tokens, observed } = newTokensOf(result.messages, seen);
        ledger.used.calls += 1;
        if (observed) {
          ledger.used.tokens += tokens;
          ledger.used.tokensObserved = true;
        }
        ledger.used.ms = now() - startedWall;
        ledger.events.push({
          event: 'p3_budget_call',
          agent,
          calls: ledger.used.calls,
          tokens: ledger.used.tokens,
          elapsedMs: ledger.used.ms,
        });
        return result;
      } finally {
        cancelTimer?.();
      }
    },
    ...(inner.compact ? { compact: inner.compact.bind(inner) } : {}),
    ...(inner.synthesizeAssistant ? { synthesizeAssistant: inner.synthesizeAssistant.bind(inner) } : {}),
  };
  return wrapped;
}
