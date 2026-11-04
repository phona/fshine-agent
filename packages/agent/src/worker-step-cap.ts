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

/** Parse an env / option value for the cap; invalid values fall back, never crash. */
export function parseStepCap(value: unknown, fallback: number = DEFAULT_WORKER_STEP_CAP): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? value : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}
