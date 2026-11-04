/**
 * Free-worker step cap (Phase 2).
 *
 * The free worker loop previously had only a wall-clock budget (600s) and a
 * plan weight cap (180). A loop that makes many cheap calls could therefore
 * run far longer in step count than any human would review. This module is
 * the single, pure decision for the step cap; it knows nothing about the
 * model, the platform, or any business domain.
 *
 * Semantics, fixed so tests can pin them:
 *   - cap defaults to 50 and is configurable (option / env, see parseStepCap).
 *   - gateCalls <= cap: normal, no wind-down.
 *   - gateCalls > cap: the (cap+1)th call has just been allowed, so the
 *     driver must send the same wind-down nudge it sends at 90% of the
 *     wall-clock budget (WORKER_WIND_DOWN_NUDGE in pi-coding-driver.ts):
 *     stop starting new work, deliver done + not-done in one paragraph.
 * Counting reuses the serve-gate audit's gateCalls (allowed bash calls),
 * it is not a second, diverging counter.
 */
export const DEFAULT_WORKER_STEP_CAP = 50;

export interface StepCapDecision {
  gateCalls: number;
  cap: number;
  /** True once the cap has been exceeded (the (cap+1)th allowed call). */
  windDown: boolean;
  /** Calls remaining before wind-down; 0 once wind-down has triggered. */
  remaining: number;
}

export function stepCapDecision(gateCalls: number, cap: number = DEFAULT_WORKER_STEP_CAP): StepCapDecision {
  const safeCap = Number.isSafeInteger(cap) && cap > 0 ? cap : DEFAULT_WORKER_STEP_CAP;
  const safeCalls = Number.isSafeInteger(gateCalls) && gateCalls >= 0 ? gateCalls : 0;
  return {
    gateCalls: safeCalls,
    cap: safeCap,
    windDown: safeCalls > safeCap,
    remaining: Math.max(0, safeCap - safeCalls),
  };
}

/**
 * 步数帽收尾 steer 的生产态跟踪器（第 2 包端到端证明的锚点）。
 * `stepCapDecision` 对 cap 之后每一次调用都返回 windDown=true，所以驱动
 * 不能直接按它送 steer——否则第 52、53……次都会重复收尾。
 * 跟踪器把“超过阈值”转成“只送一次”：驱动在每次被放行的 bash 后以
 * 自己的 gateCalls 计数调它，到达阈值+1 时恰好调一次 onWindDown，之后
 * 不再重复。计数仍归驱动持有（gateCalls 同时是执行面回执的口径），
 * 跟踪器不另立一个计数器，避免两个计数器走偏。
 * 脚本化序列（50 次 → 0 次、51 次 → 恰 1 次、52 次 → 仍 1 次）验的
 * 就是这段生产代码，不是它的复写。
 */
export function createStepCapWindDown(cap: number, onWindDown: () => void): (gateCalls: number) => boolean {
  let sent = false;
  return (gateCalls: number) => {
    if (sent) return false;
    if (stepCapDecision(gateCalls, cap).windDown) {
      sent = true;
      onWindDown();
      return true;
    }
    return false;
  };
}

/** Parse an env / option value for the cap; invalid values fall back, never crash. */
export function parseStepCap(value: unknown, fallback: number = DEFAULT_WORKER_STEP_CAP): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? value : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}
